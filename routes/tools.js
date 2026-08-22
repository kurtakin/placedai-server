/**
 * server/routes/tools.js — Utility tools: Headshot, Job Fetch, Job Search
 */

'use strict';

const https  = require('https');
const http   = require('http');
const { URL: NodeURL } = require('url');
const OpenAI   = require('openai');
const XLSX     = require('xlsx');
const mammoth  = require('mammoth');
const { createMessage }              = require('../lib/ai');
const { sendApplicationNotification, isConfigured } = require('../lib/mailer');
const { requireAuth }                = require('../middleware/auth');

// ── PDF metin çıkarıcı (pdf-parse yerine — browser API gerektirmez) ───────────
function extractPDFText(buffer) {
  const raw = buffer.toString('latin1');
  const parts = [];

  // BT...ET bloklarındaki Tj / TJ operatörlerini bul
  const btBlocks = raw.match(/BT[\s\S]{0,3000}?ET/g) || [];
  for (const block of btBlocks) {
    const tjRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*Tj/g;
    let m;
    while ((m = tjRe.exec(block)) !== null) {
      parts.push(decodePDFString(m[1]));
    }
    const tjArrRe = /\[([^\]]*)\]\s*TJ/g;
    while ((m = tjArrRe.exec(block)) !== null) {
      const inner = m[1];
      const strRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
      let s;
      while ((s = strRe.exec(inner)) !== null) {
        parts.push(decodePDFString(s[1]));
      }
    }
  }

  // Yedek: stream içeriğinden yazdırılabilir karakterler
  if (parts.length === 0) {
    const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let sm;
    while ((sm = streamRe.exec(raw)) !== null) {
      const txt = sm[1].replace(/[^\x20-\x7E\n\r\t]/g, ' ').trim();
      if (txt.length > 20) parts.push(txt);
    }
  }

  return parts.join(' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/(\w)-\s+(\w)/g, '$1$2')
    .trim();
}

function decodePDFString(s) {
  return s
    .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\').replace(/\\\(/g, '(').replace(/\\\)/g, ')')
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

const CV_PARSE_SYSTEM = `You are a CV/resume parser. Extract structured information and return ONLY a raw JSON object.
CRITICAL: Start your response with { and end with }. No markdown, no code fences, no explanation.
Required JSON structure:
{"name":"full name","email":"email address","phone":"phone number","title":"current or most recent job title","location":"city and province/country","linkedin":"linkedin URL if present, else empty","skills":"comma-separated key skills and tools","summary":"2-3 sentence professional summary","cv_text":"full cleaned resume text"}
Rules: If a field is not found use "". Skills must be comprehensive. Output raw JSON only.`;

// ── HTML stripper ─────────────────────────────────────────────────────────────
// Güvenli JSON parse — markdown fence, önceki/sonraki metin, bozuk format gibi durumları karşılar
function safeParseJSON(raw) {
  if (!raw) return null;
  // 1. Doğrudan dene
  try { return JSON.parse(raw.trim()); } catch {}
  // 2. ```json ... ``` fence'i temizle
  const fenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(fenced); } catch {}
  // 3. İlk { ile son } arasını çıkar
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return null;
}

function stripHTML(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── HTTP fetcher (follows one redirect, 10s timeout) ─────────────────────────
function fetchURL(rawUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 4) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new NodeURL(rawUrl); }
    catch { return reject(new Error('Invalid URL')); }

    const client  = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      method:   'GET',
      headers:  {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept':     'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'en-CA,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
    };

    const req = client.request(options, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
        const loc = res.headers.location.startsWith('http') ? res.headers.location : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
        return fetchURL(loc, redirectCount + 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8', 0, 200000)));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

// ── RSS parser (regex-based, no external deps) ────────────────────────────────
function parseRSS(xml) {
  const items = [];
  const itemRx = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRx.exec(xml)) !== null) {
    const raw = m[1];
    const get = (tag) => {
      const cdataM = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, 'i').exec(raw);
      if (cdataM) return cdataM[1].trim();
      const tagM = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(raw);
      return tagM ? stripHTML(tagM[1]).trim() : '';
    };
    const title   = get('title');
    const link    = get('link') || (/<link\s*\/?>([\s\S]*?)<\/(link|item)>/i.exec(raw) || [])[1] || '';
    const company = get('source') || get('author') || '';
    const desc    = get('description').slice(0, 400);
    const date    = get('pubDate');
    const location = get('location') || '';
    if (title && link) {
      items.push({ title, link: link.trim(), company, description: desc, date, location });
    }
  }
  return items;
}

// ── Job extraction prompt ─────────────────────────────────────────────────────
const EXTRACT_JOB_SYSTEM = `You are a JSON-only job listing parser. Your entire response must be a single valid JSON object — no prose, no markdown, no code fences, no explanation before or after.

Respond with exactly this structure (replace values, keep all keys):
{"title":"job title or null","company":"company name or null","location":"city/country or null","job_type":"full-time or part-time or contract or remote or null","salary":"salary text or null","description":"full job description text","requirements":["req1","req2","req3"],"apply_url":"url or null"}

Rules:
- Start your response with { and end with }
- Use null (not empty string) for missing fields
- Escape any quotes inside strings with backslash
- Keep description under 2000 chars
- requirements: top 5 only`;

async function toolsRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // ── POST /fetch-job — fetch a job URL and extract structured job data ──────
  fastify.post('/fetch-job', async (request, reply) => {
    const { url } = request.body ?? {};
    if (!url || !url.startsWith('http')) {
      return reply.code(400).send({ error: 'Valid URL required (must start with http)' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });
    }

    try {
      const html = await fetchURL(url);
      // Take first 8000 chars of stripped text (enough for Claude, avoids token limit)
      const text = stripHTML(html).replace(/\s+/g, ' ').slice(0, 8000);

      if (text.length < 100) {
        return reply.code(422).send({ error: 'Bu sayfa okunabilir metin içermiyor. LinkedIn gibi giriş gerektiren siteler desteklenmez.' });
      }

      const raw = await createMessage({
        model:      request.body?.model || 'claude-haiku',
        max_tokens: 700,
        system:     EXTRACT_JOB_SYSTEM,
        messages:   [{ role: 'user', content: `Extract job info from this webpage text:\n\n${text}` }],
      });

      const jobData = safeParseJSON(raw);
      if (!jobData) return reply.code(500).send({ error: 'Parse failed — tekrar deneyin.' });

      jobData.source_url = url;
      return jobData;

    } catch (err) {
      fastify.log.error(err, '[tools/fetch-job]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /parse-job-text — parse raw text (already fetched by client via BrowserView) ─
  fastify.post('/parse-job-text', async (request, reply) => {
    const { text, url, model } = request.body ?? {};

    if (!text || text.trim().length < 80) {
      return reply.code(400).send({ error: 'text required (min 80 chars)' });
    }

    const trimmed = text.trim().slice(0, 10000);

    try {
      const raw = await createMessage({
        model:      model || 'claude-haiku',
        max_tokens: 900,
        system:     EXTRACT_JOB_SYSTEM,
        messages:   [{ role: 'user', content: `URL: ${url || 'unknown'}\n\nExtract job info from this page text:\n\n${trimmed}` }],
      });

      const jobData = safeParseJSON(raw);
      if (!jobData) {
        fastify.log.error({ raw }, '[tools/parse-job-text] JSON parse failed');
        return reply.code(500).send({ error: 'Parse failed — AI yanıtı JSON formatında değil. Tekrar deneyin.' });
      }

      jobData.source_url = url || null;
      return jobData;
    } catch (err) {
      fastify.log.error(err, '[tools/parse-job-text]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /search-jobs — search Indeed Canada + Job Bank RSS ───────────────
  fastify.post('/search-jobs', async (request, reply) => {
    const {
      keywords = '',
      location = '',
      sources  = ['indeed', 'jobbank'],
      radius   = 50,
    } = request.body ?? {};

    if (!keywords.trim()) {
      return reply.code(400).send({ error: 'keywords required' });
    }

    const kw  = encodeURIComponent(keywords.trim());
    const loc = encodeURIComponent(location.trim());
    const results = [];

    const searches = [];

    if (sources.includes('indeed')) {
      searches.push(
        fetchURL(`https://ca.indeed.com/rss?q=${kw}&l=${loc}&radius=${radius}&sort=date`)
          .then((xml) => {
            const items = parseRSS(xml);
            items.forEach((item) => results.push({ ...item, source: 'Indeed' }));
          })
          .catch((e) => fastify.log.warn(`Indeed fetch failed: ${e.message}`))
      );
    }

    if (sources.includes('jobbank')) {
      searches.push(
        fetchURL(`https://www.jobbank.gc.ca/rss/jobsearch.xml?searchstring=${kw}&locationstring=${loc}`)
          .then((xml) => {
            const items = parseRSS(xml);
            items.forEach((item) => results.push({ ...item, source: 'Job Bank' }));
          })
          .catch((e) => fastify.log.warn(`Job Bank fetch failed: ${e.message}`))
      );
    }

    if (sources.includes('ziprecruiter')) {
      searches.push(
        fetchURL(`https://www.ziprecruiter.com/candidate/search?search=${kw}&location=${loc}&radius=${radius}`)
          .then((html) => {
            // ZipRecruiter doesn't have a public RSS; we do a best-effort HTML parse
            const jobs = [];
            const titleRx = /<h2[^>]*class="[^"]*job_title[^"]*"[^>]*>([\s\S]*?)<\/h2>/g;
            let tm;
            while ((tm = titleRx.exec(html)) !== null) {
              jobs.push({ title: stripHTML(tm[1]).trim(), company: '', link: '', source: 'ZipRecruiter', description: '' });
            }
            jobs.slice(0, 10).forEach((j) => results.push(j));
          })
          .catch((e) => fastify.log.warn(`ZipRecruiter fetch failed: ${e.message}`))
      );
    }

    await Promise.allSettled(searches);

    // Sort by date (newest first), deduplicate by title+company
    const seen = new Set();
    const unique = results.filter((r) => {
      const key = `${r.title}|${r.company}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { count: unique.length, jobs: unique.slice(0, 40) };
  });

  // ── POST /headshot — generate a professional headshot via DALL-E 3 ─────────
  fastify.post('/headshot', async (request, reply) => {
    const {
      style      = 'professional',
      background = 'neutral light gray studio background',
      clothing   = 'business formal',
      gender     = '',
      extra      = '',
    } = request.body ?? {};

    if (!process.env.OPENAI_API_KEY) {
      return reply.code(503).send({ error: 'OPENAI_API_KEY not set in .env' });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const prompt = [
      `Professional LinkedIn headshot portrait photograph of ${gender || 'a person'}.`,
      `Wearing ${clothing}.`,
      `Background: ${background}.`,
      `Style: ${style} — confident, approachable, and polished.`,
      extra || '',
      'Studio-quality lighting, sharp focus, photorealistic, high resolution.',
      'The subject is looking directly at the camera with a natural, professional expression.',
    ].filter(Boolean).join(' ');

    try {
      return reply.code(503).send({ error: 'AI fotoğraf özelliği şu an kullanılamıyor. OpenAI hesabınızda DALL-E erişimi gereklidir.' });
    } catch (err) {
      fastify.log.error(err, '[tools/headshot]');
      if (err.code === 'content_policy_violation') {
        return reply.code(422).send({ error: 'İçerik politikası hatası. Açıklamayı değiştirip tekrar deneyin.' });
      }
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /notify-apply — başvuru bildirimi e-postası ─────────────────────
  fastify.post('/notify-apply', async (request, reply) => {
    const app = request.body ?? {};

    if (!isConfigured()) {
      // Return 200 silently — user hasn't configured email yet
      return { ok: false, reason: 'not_configured', hint: '.env dosyasına GMAIL_USER ve GMAIL_APP_PASSWORD ekle' };
    }

    const result = await sendApplicationNotification(app);
    if (!result.ok) {
      fastify.log.warn(`[notify-apply] E-posta gönderilemedi: ${result.error}`);
      return { ok: false, error: result.error };
    }
    return { ok: true };
  });

  // ── POST /export-excel — başvuruları Excel dosyası olarak indir ──────────
  fastify.post('/export-excel', async (request, reply) => {
    const { applications = [] } = request.body ?? {};

    if (!applications.length) {
      return reply.code(400).send({ error: 'Başvuru listesi boş' });
    }

    // Build worksheet rows
    const rows = applications.map((a) => ({
      'Şirket':           a.company  || '',
      'Pozisyon':         a.role     || '',
      'Başvuru Tarihi':   a.date     || '',
      'Durum':            a.status   || '',
      'İlan URL':         a.url      || '',
      'Notlar':           a.notes    || '',
      'Eklenme Zamanı':   a.id ? new Date(parseInt(a.id)).toLocaleString('tr-TR') : '',
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);

    // Column widths
    ws['!cols'] = [
      { wch: 22 }, // Şirket
      { wch: 30 }, // Pozisyon
      { wch: 16 }, // Tarih
      { wch: 20 }, // Durum
      { wch: 50 }, // URL
      { wch: 40 }, // Notlar
      { wch: 22 }, // Eklenme
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Başvurular');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const today    = new Date().toISOString().slice(0, 10);
    const filename = `basvurular_${today}.xlsx`;

    reply
      .header('Content-Type',        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(buffer);
  });

  // ── POST /parse-cv — PDF veya DOCX base64, AI ile bilgileri çıkar ────────
  fastify.post('/parse-cv', async (request, reply) => {
    try {
      if (!process.env.ANTHROPIC_API_KEY) {
        return reply.code(503).send({ error: 'ANTHROPIC_API_KEY .env dosyasında eksik' });
      }

      const { filename = '', data } = request.body ?? {};
      if (!data) return reply.code(400).send({ error: 'Dosya verisi eksik' });

      // Base64 → Buffer
      let buffer;
      try {
        buffer = Buffer.from(data, 'base64');
      } catch (e) {
        return reply.code(400).send({ error: `Base64 çözümlenemedi: ${e.message}` });
      }

      const name = filename.toLowerCase();
      let text   = '';

      // Dosya türüne göre metin çıkar
      try {
        if (name.endsWith('.pdf')) {
          text = extractPDFText(buffer);
        } else if (name.endsWith('.docx') || name.endsWith('.doc')) {
          const result = await mammoth.extractRawText({ buffer });
          text = result.value;
        } else {
          text = buffer.toString('utf8');
        }
      } catch (err) {
        return reply.code(422).send({ error: `Dosya okunamadı: ${err.message}` });
      }

      if (!text || text.trim().length < 30) {
        return reply.code(422).send({
          error: name.endsWith('.pdf')
            ? 'PDF\'den metin çıkarılamadı. Lütfen DOCX formatında deneyin.'
            : 'Dosyadan yeterli metin çıkarılamadı.',
        });
      }

      const trimmed = text.replace(/\s{3,}/g, '\n\n').trim().slice(0, 8000);

      // AI ile parse et
      let raw;
      try {
        raw = await createMessage({
          model:      request.body?.model || 'claude-haiku',
          max_tokens: 2048,
          system:     CV_PARSE_SYSTEM,
          messages:   [{ role: 'user', content: `Parse this resume:\n\n${trimmed}` }],
        });
      } catch (err) {
        return reply.code(502).send({ error: `AI API hatası: ${err.message}` });
      }

      const parsed = safeParseJSON(raw || '');
      if (!parsed || typeof parsed !== 'object') {
        const preview = (raw || '').slice(0, 300);
        fastify.log.error('[parse-cv] AI raw response:', preview);
        return reply.code(422).send({ error: `AI CV'yi parse edemedi. AI yanıtı: ${preview || '(boş)'}` });
      }

      if (!parsed.cv_text) parsed.cv_text = trimmed;
      return reply.send(parsed);

    } catch (err) {
      fastify.log.error('[parse-cv] Beklenmeyen hata:', err);
      return reply.code(500).send({ error: `Sunucu hatası: ${err.message}` });
    }
  });

  // ── GET /email-status — e-posta yapılandırma durumu ──────────────────────
  fastify.get('/email-status', async () => ({
    configured: isConfigured(),
    user:       process.env.GMAIL_USER ? process.env.GMAIL_USER.replace(/(.{2}).+(@.+)/, '$1…$2') : null,
    notify_to:  process.env.NOTIFY_EMAIL || process.env.GMAIL_USER || null,
  }));

  // ── POST /performance-analysis — post-interview performance ───────────────
  fastify.post('/performance-analysis', async (request, reply) => {
    const { qa_pairs = [], company = '', model } = request.body ?? {};

    if (!qa_pairs || qa_pairs.length === 0) {
      return reply.code(400).send({ error: 'qa_pairs array is required' });
    }

    const PERF_SYSTEM = `You are an expert interview coach. Analyze these interview Q&A pairs and provide detailed performance analysis.
Return ONLY valid JSON, no markdown:
{
  "overall_score": <0-100>,
  "overall_grade": "<A+|A|B|C|D|F>",
  "overall_verdict": "1 sentence overall assessment",
  "star_averages": { "situation": <0-25>, "task": <0-25>, "action": <0-25>, "result": <0-25> },
  "per_question": [
    {
      "question": "the question",
      "score": <0-100>,
      "grade": "A/B/C/D/F",
      "star": { "situation": <0-25>, "task": <0-25>, "action": <0-25>, "result": <0-25> },
      "strength": "1 sentence on what was good",
      "improvement": "1 sentence on key improvement",
      "rewrite": "improved version of the weakest part of their answer (1-2 sentences)"
    }
  ],
  "top_strengths": ["strength 1", "strength 2", "strength 3"],
  "key_improvements": ["improvement 1", "improvement 2", "improvement 3"],
  "next_steps": "2-3 sentence personalized practice recommendation"
}`;

    const prompt = `Company: ${company || 'Not specified'}\n\nInterview Q&A:\n${
      qa_pairs.map((qa, i) => `Q${i+1}: ${qa.question}\nA${i+1}: ${qa.answer}`).join('\n\n')
    }`;

    try {
      const raw = await createMessage({
        model:      model || 'claude-sonnet',
        max_tokens: 1500,
        system:     PERF_SYSTEM,
        messages:   [{ role: 'user', content: prompt }],
      });
      const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      let result;
      try { result = JSON.parse(clean); }
      catch { return reply.code(500).send({ error: 'Parse failed', raw }); }
      return reply.send(result);
    } catch (err) {
      fastify.log.error(err, '[tools/performance-analysis]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /coding-solve — coding interview solution ─────────────────────────
  fastify.post('/coding-solve', async (request, reply) => {
    const { question, language = 'Python', difficulty = 'Medium', attempt, model } = request.body ?? {};

    if (!question || question.trim().length < 20) {
      return reply.code(400).send({ error: 'question required (min 20 chars)' });
    }

    const CODING_SYSTEM = `You are an expert software engineer and coding interview coach.
Solve the given coding problem and explain it for interview use.
Return ONLY valid JSON, no markdown:
{
  "approach": "1 sentence describing the core algorithm/approach",
  "time_complexity": "O(n) notation",
  "space_complexity": "O(n) notation",
  "solution_code": "complete working solution code in the requested language, with inline comments",
  "step_by_step": "numbered step-by-step explanation of the algorithm (plain text, use \\n for line breaks)",
  "edge_cases": ["edge case 1", "edge case 2"],
  "talking_points": [
    "How to explain your approach to the interviewer",
    "Why this solution is optimal",
    "How to mention trade-offs",
    "What follow-up questions to expect"
  ],
  "code_review": "if user provided their own code, specific feedback on it (empty string if no attempt given)"
}`;

    const userPrompt = `Language: ${language}\nDifficulty: ${difficulty}\n\nProblem:\n${question.trim()}${
      attempt ? `\n\nCandidate's attempt:\n\`\`\`${language}\n${attempt.trim()}\n\`\`\`` : ''
    }`;

    try {
      const raw = await createMessage({
        model:      model || 'claude-sonnet',
        max_tokens: 1800,
        system:     CODING_SYSTEM,
        messages:   [{ role: 'user', content: userPrompt }],
      });
      const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      let result;
      try { result = JSON.parse(clean); }
      catch { return reply.code(500).send({ error: 'Parse failed', raw }); }
      return reply.send(result);
    } catch (err) {
      fastify.log.error(err, '[tools/coding-solve]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /web-search — gerçek zamanlı web araması ─────────────────────────
  // Öncelik: 1) Brave Search API  2) Serper.dev  3) DuckDuckGo Instant  4) DDG HTML
  fastify.post('/web-search', async (request, reply) => {
    const { query, max_results = 4 } = request.body ?? {};
    if (!query || query.trim().length < 3) {
      return reply.code(400).send({ error: 'query required' });
    }

    const q = query.trim();
    fastify.log.info({ q }, '[web-search] Aranıyor');

    try {
      let results = [];

      // ── Backend 1: Brave Search API ────────────────────────────────────────
      if (process.env.BRAVE_SEARCH_API_KEY) {
        try {
          const braveUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${max_results}&country=ca&search_lang=en`;
          const raw = await fetchURL(braveUrl + '|brave-api');  // hack: signal for auth header
          // fetchURL doesn't support custom headers, use https directly
          const braveData = await new Promise((resolve, reject) => {
            const parsed = new NodeURL(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${max_results}`);
            const req = https.request({
              hostname: parsed.hostname, path: parsed.pathname + parsed.search,
              method: 'GET',
              headers: {
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip',
                'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY,
              },
            }, (res) => {
              const chunks = [];
              res.on('data', c => chunks.push(c));
              res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve(null); } });
            });
            req.on('error', reject);
            req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
            req.end();
          });
          if (braveData?.web?.results?.length) {
            results = braveData.web.results.slice(0, max_results).map(r => ({
              title: r.title, snippet: r.description || '', url: r.url,
            }));
            fastify.log.info({ count: results.length }, '[web-search] Brave Search OK');
          }
        } catch (e) { fastify.log.warn('[web-search] Brave hatası: ' + e.message); }
      }

      // ── Backend 2: Serper.dev ──────────────────────────────────────────────
      if (!results.length && process.env.SERPER_API_KEY) {
        try {
          const serperData = await new Promise((resolve, reject) => {
            const body = JSON.stringify({ q, num: max_results, gl: 'ca', hl: 'en' });
            const req = https.request({
              hostname: 'google.serper.dev', path: '/search', method: 'POST',
              headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            }, (res) => {
              const chunks = [];
              res.on('data', c => chunks.push(c));
              res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve(null); } });
            });
            req.on('error', reject);
            req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
            req.write(body); req.end();
          });
          if (serperData?.organic?.length) {
            results = serperData.organic.slice(0, max_results).map(r => ({
              title: r.title, snippet: r.snippet || '', url: r.link,
            }));
            fastify.log.info({ count: results.length }, '[web-search] Serper OK');
          }
        } catch (e) { fastify.log.warn('[web-search] Serper hatası: ' + e.message); }
      }

      // ── Backend 3: DuckDuckGo Instant Answer API (no key) ─────────────────
      if (!results.length) {
        try {
          const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1&t=interviewaid`;
          const raw  = await fetchURL(ddgUrl);
          const data = JSON.parse(raw);

          if (data.AbstractText?.length > 30) {
            results.push({ title: data.Heading || q, snippet: data.AbstractText.slice(0, 500), url: data.AbstractURL || '' });
          }
          (data.RelatedTopics || []).slice(0, max_results - 1).forEach(rt => {
            if (rt.Text && rt.FirstURL) {
              results.push({ title: rt.Text.slice(0, 80), snippet: rt.Text.slice(0, 300), url: rt.FirstURL });
            }
          });
          if (results.length) fastify.log.info({ count: results.length }, '[web-search] DDG Instant OK');
        } catch (e) { fastify.log.warn('[web-search] DDG Instant hatası: ' + e.message); }
      }

      // ── Backend 4: DuckDuckGo HTML scraping ───────────────────────────────
      if (!results.length) {
        try {
          const ddgHtml = await fetchURL(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`);
          // Extract snippets
          const snippetMatches = [...ddgHtml.matchAll(/class="result__snippet"[^>]*>([\s\S]{20,400}?)<\/a>/g)];
          const titleMatches   = [...ddgHtml.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]{5,100}?)<\/a>/g)];
          const count = Math.min(snippetMatches.length, titleMatches.length, max_results);
          for (let i = 0; i < count; i++) {
            results.push({
              title:   stripHTML(titleMatches[i][2]),
              snippet: stripHTML(snippetMatches[i][1]),
              url:     titleMatches[i][1],
            });
          }
          if (results.length) fastify.log.info({ count: results.length }, '[web-search] DDG HTML OK');
        } catch (e) { fastify.log.warn('[web-search] DDG HTML hatası: ' + e.message); }
      }

      // ── Context string for AI injection ───────────────────────────────────
      const context = results.length
        ? results.map((r, i) => `[${i+1}] ${r.title}\n${r.snippet}`).join('\n\n')
        : '';

      fastify.log.info({ q, count: results.length }, '[web-search] Tamamlandı');
      return { results, context, query: q, found: results.length > 0 };

    } catch (err) {
      fastify.log.error(err, '[tools/web-search]');
      return { results: [], context: '', query: q, found: false, error: err.message };
    }
  });

  // ── POST /analyze-job-questions ───────────────────────────────────────────
  // İş ilanını analiz et → olası mülakat sorularını üret → döndür
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post('/analyze-job-questions', async (request, reply) => {
    const { title, company, location, description, url, model } = request.body ?? {};

    if (!description || description.trim().length < 50) {
      return reply.code(400).send({ error: 'description required (min 50 chars)' });
    }
    if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
      return reply.code(503).send({ error: 'API key not configured (ANTHROPIC_API_KEY or OPENAI_API_KEY)' });
    }

    const trimmedDesc = description.trim().slice(0, 6000);

    const systemPrompt = `You are an expert job interview coach. Analyze a job posting and return ONLY a JSON object — no prose, no markdown, no code fences.

JSON schema (strictly follow this):
{
  "detectedCategory": "inventory_control|inventory_analyst|inventory_planner|supply_chain|logistics|operations|data_analyst|finance|technology|general",
  "seniority": "entry|mid|senior|manager",
  "requirements": ["key skill 1", "key skill 2", "key skill 3", "key skill 4", "key skill 5"],
  "questions": [
    {
      "q": "The exact question an interviewer would ask",
      "matchKeys": ["2-4 short phrases that would appear in variations of this question"],
      "answerTips": "• Key point 1\\n• Key point 2\\n• Key point 3\\n• Key point 4",
      "category": "technical|behavioral|situational|motivation"
    }
  ]
}

Rules:
- Generate exactly 10 questions
- Mix: 3 behavioral (STAR), 3 technical (role-specific), 2 situational, 1 motivation, 1 "do you have questions"
- Make questions SPECIFIC to the job — reference actual requirements, tools, or duties from the posting
- answerTips: 4-5 concise bullet points starting with •
- matchKeys: lowercase short phrases (2-5 words each)
- Do NOT add any text before or after the JSON object`;

    const userPrompt = `Job Title: ${title || 'Unknown'}
Company: ${company || 'Unknown'}
Location: ${location || 'Unknown'}
URL: ${url || 'n/a'}

Job Description:
${trimmedDesc}

Generate 10 likely interview questions for this specific job.`;

    try {
      const raw = await createMessage({
        model:      model || 'claude-haiku',
        max_tokens: 2500,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userPrompt }],
      });

      const parsed = safeParseJSON(raw);
      if (!parsed || !Array.isArray(parsed.questions)) {
        fastify.log.error({ raw: raw.slice(0, 500) }, '[analyze-job-questions] JSON parse failed');
        return reply.code(500).send({ error: 'AI yanıtı beklenmeyen formatta — tekrar deneyin.' });
      }

      // Normalize et
      parsed.questions = parsed.questions.slice(0, 12).map((q, i) => ({
        q:          q.q || 'Unknown question',
        matchKeys:  Array.isArray(q.matchKeys) ? q.matchKeys : [],
        answerTips: q.answerTips || '',
        category:   q.category || 'behavioral',
        idx:        i,
      }));

      fastify.log.info({ title, company, qCount: parsed.questions.length }, '[analyze-job-questions] OK');
      return parsed;

    } catch (err) {
      fastify.log.error(err, '[analyze-job-questions]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /analyze-job-pattern ─────────────────────────────────────────────
  // Birden fazla analiz edilmiş iş ilanından ortak soru örüntüsü çıkar
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post('/analyze-job-pattern', async (request, reply) => {
    const { jobs, model } = request.body ?? {};

    if (!Array.isArray(jobs) || jobs.length < 2) {
      return reply.code(400).send({ error: 'At least 2 analyzed jobs required' });
    }

    // Her iş ilanından soruları topla
    const allQuestions = jobs.flatMap(j =>
      (j.questions || []).map(q => ({ ...q, jobTitle: j.title, company: j.company }))
    );

    if (allQuestions.length < 4) {
      return reply.code(400).send({ error: 'Not enough questions to find patterns' });
    }

    const qSummary = allQuestions.map((q, i) => `${i+1}. [${q.jobTitle}] ${q.q}`).join('\n');

    const systemPrompt = `You are an expert interview coach. Given a list of interview questions from multiple job analyses, identify which questions recur across different postings and consolidate them into a "high-priority pattern" list.

Return ONLY a JSON array of pattern objects:
[
  {
    "q": "consolidated question text",
    "matchKeys": ["short phrase1", "short phrase2", "short phrase3"],
    "answerTips": "• Key tip 1\\n• Key tip 2\\n• Key tip 3\\n• Key tip 4",
    "category": "technical|behavioral|situational|motivation",
    "frequency": 3,
    "roles": ["role1", "role2"]
  }
]

Consolidate similar questions. Return 6-10 patterns. No text outside the JSON array.`;

    try {
      const raw = await createMessage({
        model:      model || 'claude-haiku',
        max_tokens: 2000,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: `Find patterns in these questions from ${jobs.length} job analyses:\n\n${qSummary}` }],
      });

      const parsed = safeParseJSON(raw);
      if (!Array.isArray(parsed)) {
        return reply.code(500).send({ error: 'AI yanıtı parse edilemedi' });
      }

      return { patterns: parsed, analyzedJobCount: jobs.length };

    } catch (err) {
      fastify.log.error(err, '[analyze-job-pattern]');
      return reply.code(500).send({ error: err.message });
    }
  });

}

module.exports = toolsRoutes;
