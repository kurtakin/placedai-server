/**
 * server/routes/practice.js — POST /api/v1/practice/evaluate
 *
 * Evaluates a user's STAR answer against a question's answer_framework
 * using Claude Sonnet. Returns a detailed scorecard.
 *
 * Request body:
 *   { question_id: string, user_answer: string, sector?: string }
 *
 * Response:
 *   {
 *     star_score: { situation, task, action, result },  // each 0-25
 *     total: 0-100,
 *     grade: "A+/A/B/C/D/F",
 *     key_points_hit: string[],
 *     key_points_missed: string[],
 *     strong_signals_present: string[],
 *     avoid_violations: string[],
 *     strengths: string,
 *     improvements: string,
 *     rewrite_tip: string
 *   }
 */

'use strict';

const { createMessage } = require('../lib/ai');
const path = require('path');
const fs   = require('fs');
const { requireAuth, requirePlan } = require('../middleware/auth');
const { checkAndIncrement } = require('../lib/usage');

function safeParseJSON(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw.trim()); } catch {}
  const fenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(fenced); } catch {}
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) { try { return JSON.parse(raw.slice(start, end + 1)); } catch {} }
  return null;
}
// Question bank location.
// Deployed (Railway): the bank ships inside the server folder → server/questions/
// Local (Electron):   the bank lives in the project root → ../..
const BANK_DIR = fs.existsSync(path.join(__dirname, '..', 'questions', 'question_bank_index.json'))
  ? path.join(__dirname, '..', 'questions')
  : path.join(__dirname, '..', '..');

// ── Load question by ID across all sector files ───────────────────────────────
let _questionMap = null;

function getQuestionMap() {
  if (_questionMap) return _questionMap;

  _questionMap = new Map();

  const indexPath = path.join(BANK_DIR, 'question_bank_index.json');
  if (!fs.existsSync(indexPath)) {
    console.warn('[practice] question_bank_index.json not found at', indexPath, '— question bank is empty');
    return _questionMap;
  }

  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (err) {
    console.warn('[practice] Could not parse question_bank_index.json:', err.message);
    return _questionMap;
  }

  for (const entry of index.files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(BANK_DIR, entry.file), 'utf8'));
      for (const q of data.questions) {
        _questionMap.set(q.id, { ...q, _sector: entry.sector, _file: entry.file });
      }
    } catch (err) {
      console.warn(`[practice] Could not load ${entry.file}:`, err.message);
    }
  }

  console.log(`[practice] Loaded ${_questionMap.size} questions from ${BANK_DIR}`);
  return _questionMap;
}

// ── Evaluation system prompt ──────────────────────────────────────────────────
const EVAL_SYSTEM = `You are an expert interview coach evaluating a candidate's behavioral answer.
Your job is to give honest, specific, and constructive feedback based on the STAR method.

Score each STAR component from 0 to 25 (total 100):
- Situation (0-25): Was the context set clearly and concisely?
- Task (0-25): Was the candidate's specific challenge or responsibility clearly defined?
- Action (0-25): Were the candidate's own actions described in concrete, specific detail? (This carries the most weight.)
- Result (0-25): Was the outcome clearly stated with quantifiable impact or clear business value?

Grade scale: A+ (95-100), A (85-94), B (70-84), C (55-69), D (40-54), F (<40)

Return ONLY valid JSON, no markdown, no extra text:
{
  "star_score": { "situation": N, "task": N, "action": N, "result": N },
  "total": N,
  "grade": "X",
  "key_points_hit": ["exact framework points the candidate addressed"],
  "key_points_missed": ["exact framework points the candidate missed or glossed over"],
  "strong_signals_present": ["specific proof points or metrics the candidate demonstrated"],
  "avoid_violations": ["any 'avoid' items that appeared in the answer"],
  "strengths": "1-2 sentences on what the candidate did particularly well.",
  "improvements": "1-2 sentences on the single most impactful improvement to make.",
  "rewrite_tip": "Take their weakest sentence and rewrite it as a stronger version. Start with the original, then show the improved version."
}`;

// ─────────────────────────────────────────────────────────────────────────────

// ── Job Description Analysis system prompt ───────────────────────────────────
const JD_ANALYSIS_SYSTEM = `You are an expert interview preparation coach. Analyze the job description and extract key interview preparation data.

CRITICAL: Return ONLY a raw JSON object. Start with { and end with }. No markdown, no explanation, no code fences.
{
  "job_title": "extracted or inferred job title",
  "sector": "one of: Supply Chain & Logistics, Finance, Operations & Manufacturing, Technology, Data Analyst, Logistics & Transportation, Inventory Planner, Inventory Analyst, Inventory Control Analyst, Universal Behavioral",
  "seniority": "one of: entry, mid, senior, manager",
  "key_skills": ["skill 1", "skill 2", "skill 3", "skill 4", "skill 5"],
  "focus_areas": ["theme 1", "theme 2", "theme 3"],
  "predicted_questions": [
    "Tell me about a time you...",
    "How have you handled...",
    "Describe a situation where...",
    "What is your experience with...",
    "How do you approach..."
  ]
}

Rules:
- key_skills: exactly 5-7 most critical skills from the JD, be specific
- focus_areas: exactly 3 interview themes (e.g. "Cross-functional collaboration", "Data-driven decision making")
- predicted_questions: exactly 5 behavioral or situational questions this company is MOST LIKELY to ask, written as actual interview questions
- seniority: infer from years of experience, title, and responsibilities mentioned`;

// ── Cover Letter system prompt ───────────────────────────────────────────────
const COVER_LETTER_SYSTEM = `You are an expert career coach and professional cover letter writer.
Write a compelling, personalized cover letter based on the provided candidate information and job description.

Rules:
- Exactly 4 paragraphs, 280-350 words total
- Paragraph 1: Strong opening hook — connect the candidate's specific background to THIS role (avoid "I am writing to express my interest")
- Paragraph 2: Most relevant achievement with concrete metrics or outcomes
- Paragraph 3: Why this specific company/role — alignment with their mission or values
- Paragraph 4: Confident call-to-action close
- Match the tone requested (professional / warm / confident)
- Write in the same language as the job description
- Output ONLY the letter text — start with salutation, end with sign-off + candidate name
- Do NOT add subject line, date, or mailing addresses`;

// ── ATS Score system prompt ───────────────────────────────────────────────────
const ATS_SYSTEM = `You are an ATS (Applicant Tracking System) expert and resume analyst.
Compare the candidate's CV/resume against the job description and score their compatibility.

Return ONLY valid JSON, no markdown:
{
  "score": <integer 0-100>,
  "grade": "<A+|A|B|C|D|F>",
  "matched_keywords": ["keyword1", "keyword2"],
  "missing_keywords": ["keyword1", "keyword2"],
  "section_scores": {
    "skills_match": <0-100>,
    "experience_match": <0-100>,
    "education_match": <0-100>
  },
  "strengths": "1-2 sentences on CV strengths for this role",
  "gaps": "1-2 sentences on key gaps",
  "top_recommendations": ["specific actionable recommendation 1", "recommendation 2", "recommendation 3"]
}

Grade scale: A+ (90-100), A (80-89), B (65-79), C (50-64), D (35-49), F (<35)`;

// ── Resume Builder system prompt ──────────────────────────────────────────────
const RESUME_SYSTEM = `You are an expert resume writer specializing in ATS-optimized, professional resumes.
Create a clean, well-structured resume from the provided information.

Format rules:
- Plain text only — no tables, no graphics, no columns, no special characters
- Use exact section headers: PROFESSIONAL SUMMARY, PROFESSIONAL EXPERIENCE, EDUCATION, SKILLS
- Bullet points with strong action verbs (Led, Developed, Achieved, Reduced, Increased, Built)
- Quantify achievements with metrics where possible based on the provided information
- Each bullet under 20 words
- Total length: 400-550 words
- Output ONLY the resume text, start directly with the candidate's name`;

// ── CV Adaptation system prompt ───────────────────────────────────────────────
const ADAPT_CV_SYSTEM = `You are an expert resume writer. Your job is to adapt a candidate's existing CV/resume to better match a specific job description.

Rules:
- Keep contact information, company names, job titles, and dates EXACTLY as provided — do NOT invent or change facts
- Rewrite the Professional Summary (2-3 sentences) to directly address this specific role
- Reorder the Skills section to prioritize the most relevant skills for this job
- Adjust 2-3 experience bullet points to better highlight relevant achievements using the job's keywords — only reframe existing information, never fabricate
- Keep education section unchanged
- Output ONLY the adapted CV text in plain text format
- Use the same section headers as the original CV`;

// ── Auto-apply package system prompt ─────────────────────────────────────────
const APPLY_PACKAGE_SYSTEM = `You are an expert career coach. Given a job description and candidate profile, create a complete application package.

Return ONLY valid JSON, no markdown:
{
  "match_score": <0-100>,
  "key_selling_points": ["point 1", "point 2", "point 3"],
  "tailored_cover_letter_opening": "2-3 sentence powerful opening paragraph only",
  "talking_points": ["specific talking point for interview", "talking point 2", "talking point 3", "talking point 4"],
  "questions_to_ask": ["thoughtful question to ask interviewer 1", "question 2", "question 3"],
  "red_flags": ["potential concern 1 (or empty array if none)"],
  "apply_recommendation": "Strong Match / Good Match / Partial Match / Weak Match"
}`;

// ── Generate prompt for custom questions ─────────────────────────────────────
const GENERATE_SYSTEM = `You are an expert interview coach. Given any interview question, generate a structured answer framework.
Return ONLY valid JSON, no markdown:
{
  "key_points": ["specific point to address", "specific point to address", "specific point to address"],
  "strong_answer_signals": ["metric or proof point to include", "metric or proof point to include"],
  "avoid": ["common mistake to avoid", "common mistake to avoid"],
  "suggested_answer": "1-2 sentence strong STAR-structured model answer under 50 words."
}`;

// Endpoints that cost an AI call — these count against the Free plan's monthly
// allowance. Cheap lookups (/questions) and plain scraping are deliberately absent.
const METERED_ROUTES = new Set([
  '/analyze-jd',
  '/generate',
  '/generate-answers',
  '/evaluate',
  '/evaluate-custom',
  '/cover-letter',
  '/ats-score',
  '/adapt-cv',
  '/build-resume',
  '/full-package',
  '/apply-package',
  '/online-assessment',
  '/experience-letter',
  '/optimize-linkedin',
  '/linkedin-headlines',
]);

/** Route path without the /api/v1/practice prefix, across Fastify versions. */
function routeTail(request) {
  const full = request.routeOptions?.url || request.routerPath || request.url || '';
  const i = full.indexOf('/api/v1/practice');
  return i === -1 ? full : full.slice(i + '/api/v1/practice'.length);
}

async function practiceRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // ── Free plan metering ──────────────────────────────────────────────────
  // Paid plans short-circuit inside checkAndIncrement, so this is a no-op for them.
  // 429 + `monthly_limit_reached` matches what the overlay already handles.
  fastify.addHook('preHandler', async (request, reply) => {
    if (request.method !== 'POST') return;
    if (!METERED_ROUTES.has(routeTail(request))) return;

    const usage = await checkAndIncrement(request.user);
    if (!usage.allowed) {
      return reply.code(429).send({
        error:   'monthly_limit_reached',
        message: `Free plan limit of ${usage.limit} AI requests/month reached. Upgrade to Pro for unlimited use.`,
        used:    usage.used,
        limit:   usage.limit,
      });
    }
  });

  // ── POST /analyze-jd — analyze job description, predict interview questions ─
  fastify.post('/analyze-jd', async (request, reply) => {
    const { job_description } = request.body ?? {};

    if (!job_description || job_description.trim().length < 50) {
      return reply.code(400).send({ error: 'job_description required (min 50 chars)' });
    }
    if (/^https?:\/\//i.test(job_description.trim())) {
      return reply.code(400).send({ error: 'Not a URL — paste the listing text: open the page → Ctrl+A → Ctrl+C → paste here.' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });
    }

    try {
      const raw = await createMessage({
        model:      request.body?.model || 'claude-haiku',
        max_tokens: 1500,
        system:     JD_ANALYSIS_SYSTEM,
        messages:   [{ role: 'user', content: `Job Description:\n\n${job_description.trim()}` }],
      });

      const analysis = safeParseJSON(raw);
      if (!analysis) {
        fastify.log.error('[analyze-jd] AI raw:', (raw||'').slice(0,400));
        return reply.code(500).send({ error: `Parse failed — AI yanıtı: ${(raw||'(boş)').slice(0,200)}` });
      }

      return analysis;
    } catch (err) {
      fastify.log.error(err, '[practice/analyze-jd]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /generate — generate answer framework for any custom question ────
  fastify.post('/generate', async (request, reply) => {
    const { question_text, sector = 'general', seniority = 'mid' } = request.body ?? {};

    if (!question_text || question_text.trim().length < 10) {
      return reply.code(400).send({ error: 'question_text required (min 10 chars)' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });
    }

    const userPrompt = `Sector: ${sector}\nSeniority: ${seniority}\nQuestion: "${question_text.trim()}"`;

    try {
      const raw = await createMessage({
        model:      request.body?.model || 'claude-haiku',
        max_tokens: 400,
        system:     GENERATE_SYSTEM,
        messages:   [{ role: 'user', content: userPrompt }],
      });
      const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      let framework;
      try { framework = JSON.parse(clean); }
      catch { return reply.code(500).send({ error: 'Parse failed', raw }); }

      return { question_text: question_text.trim(), sector, seniority, ...framework };
    } catch (err) {
      fastify.log.error(err, '[practice/generate]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /evaluate-custom — evaluate answer to a custom (non-bank) question
  fastify.post('/evaluate-custom', async (request, reply) => {
    const { question_text, user_answer, key_points = [], strong_answer_signals = [], avoid = [], sector = 'general', seniority = 'mid' } = request.body ?? {};

    if (!question_text || !user_answer || user_answer.trim().length < 20) {
      return reply.code(400).send({ error: 'question_text and user_answer (min 20 chars) required' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });
    }

    const userPrompt = `
INTERVIEW QUESTION:
"${question_text.trim()}"

Sector: ${sector}
Seniority: ${seniority}

ANSWER FRAMEWORK:
Key points to address:
${key_points.map((p) => `  • ${p}`).join('\n') || '  • Not specified — evaluate on general STAR quality'}

Strong signals:
${strong_answer_signals.map((s) => `  ✓ ${s}`).join('\n') || '  ✓ Quantified outcomes, specific actions'}

Things to avoid:
${avoid.map((a) => `  ✗ ${a}`).join('\n') || '  ✗ Vague answers, no numbers'}

CANDIDATE'S ANSWER:
"${user_answer.trim()}"

Evaluate this answer and return the JSON scorecard.`.trim();

    try {
      const raw = await createMessage({
        model:      request.body?.model || 'claude-sonnet',
        max_tokens: 600,
        system:     EVAL_SYSTEM,
        messages:   [{ role: 'user', content: userPrompt }],
      });
      const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      let evaluation;
      try { evaluation = JSON.parse(clean); }
      catch { return reply.code(500).send({ error: 'Parse failed', raw }); }

      return { question_text: question_text.trim(), ...evaluation };
    } catch (err) {
      fastify.log.error(err, '[practice/evaluate-custom]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── GET /questions — list all questions for the practice UI ───────────────
  fastify.get('/questions', async (request) => {
    const { sector, seniority, category } = request.query;
    const qmap = getQuestionMap();
    let questions = Array.from(qmap.values());

    if (sector)    questions = questions.filter((q) => q._file?.includes(sector));
    if (seniority) questions = questions.filter((q) => q.seniority.includes(seniority));
    if (category)  questions = questions.filter((q) => q.category === category);

    return {
      count: questions.length,
      questions: questions.map(({ id, text, category, seniority, _sector }) => ({
        id, text, category, seniority, sector: _sector,
      })),
    };
  });

  // ── POST /evaluate — evaluate a STAR answer ───────────────────────────────
  fastify.post('/evaluate', async (request, reply) => {
    const { question_id, user_answer } = request.body ?? {};

    if (!question_id || typeof question_id !== 'string') {
      return reply.code(400).send({ error: 'question_id required' });
    }
    if (!user_answer || user_answer.trim().length < 20) {
      return reply.code(400).send({ error: 'user_answer must be at least 20 characters' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set in .env' });
    }

    // ── Find the question ────────────────────────────────────────────────────
    const qmap    = getQuestionMap();
    const question = qmap.get(question_id);

    if (!question) {
      return reply.code(404).send({ error: `Question ${question_id} not found` });
    }

    const { text, answer_framework, seniority, _sector } = question;
    const { key_points, strong_answer_signals, avoid } = answer_framework;

    // ── Build evaluation prompt ──────────────────────────────────────────────
    const userPrompt = `
INTERVIEW QUESTION:
"${text}"

Sector: ${_sector}
Seniority Level: ${seniority.join(', ')}

ANSWER FRAMEWORK (what a strong answer covers):
Key points to address:
${key_points.map((p) => `  • ${p}`).join('\n')}

Strong answer signals to look for:
${strong_answer_signals.map((s) => `  ✓ ${s}`).join('\n')}

Things to avoid:
${avoid.map((a) => `  ✗ ${a}`).join('\n')}

CANDIDATE'S ANSWER:
"${user_answer.trim()}"

Evaluate this answer against the framework and return your JSON scorecard.`.trim();

    const start = Date.now();

    try {
      const raw = await createMessage({
        model:      request.body?.model || 'claude-sonnet',
        max_tokens: 600,
        system:     EVAL_SYSTEM,
        messages:   [{ role: 'user', content: userPrompt }],
      });
      const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

      let evaluation;
      try {
        evaluation = JSON.parse(clean);
      } catch {
        fastify.log.error({ raw }, '[practice] Failed to parse Claude JSON response');
        return reply.code(500).send({ error: 'Evaluation parsing failed', raw });
      }

      return {
        question_id,
        question_text: text,
        ...evaluation,
        eval_ms: Date.now() - start,
      };

    } catch (err) {
      fastify.log.error(err, '[practice] Claude API error');
      return reply.code(500).send({ error: 'Evaluation failed', detail: err.message });
    }
  });

  // ── POST /online-assessment — platform bazlı sınav yardımı ──────────────────
  // Ultimate: bes ayri platform destegi (HireVue, CodeSignal, HackerRank,
  // Codility, TestGorilla) — eleme surecini yogun yasayan aday profili.
  fastify.post('/online-assessment', { preHandler: requirePlan(['ultimate']) }, async (request, reply) => {
    const { platform = 'general', question_type = 'video_behavioral', question = '', language = 'Python', difficulty = 'Medium', time_limit = 120, model } = request.body ?? {};
    if (!question.trim()) return reply.code(400).send({ error: 'question required' });

    // Coding sorusu → coding-solve'a yönlendir
    if (question_type === 'coding') {
      const systemPrompt = `You are an expert coding interview coach for ${platform}. Solve the problem and return JSON only:
{"approach":"brief approach","time_complexity":"O(?)","space_complexity":"O(?)","solution_code":"complete runnable code in ${language}","step_by_step":"numbered steps","talking_points":["tp1","tp2","tp3"]}`;
      try {
        const raw = await createMessage({ model: model || 'claude-sonnet', max_tokens: 1200, system: systemPrompt, messages: [{ role: 'user', content: `${platform} ${difficulty} problem:\n${question}` }] });
        const clean = raw.replace(/^```json\s*/i,'').replace(/```\s*$/,'').trim();
        let r; try { r = JSON.parse(clean); } catch { return reply.code(500).send({ error: 'Parse failed', raw }); }
        return { type: 'coding', ...r };
      } catch (err) { return reply.code(500).send({ error: err.message }); }
    }

    // MCQ / Yazılı
    if (question_type === 'mcq' || question_type === 'written') {
      const systemPrompt = `You are an expert assessment coach for ${platform}. Analyze the question and provide a comprehensive answer guide. Be direct and specific. Return plain text (no JSON).`;
      try {
        const analysis = await createMessage({ model: model || 'claude-haiku', max_tokens: 600, system: systemPrompt, messages: [{ role: 'user', content: `Platform: ${platform}\nType: ${question_type}\nQuestion:\n${question}` }] });
        return { type: 'mcq', analysis };
      } catch (err) { return reply.code(500).send({ error: err.message }); }
    }

    // Video Behavioral / Situational (HireVue style)
    const timeSec = parseInt(time_limit) || 120;
    const timeStr = timeSec >= 60 ? `${Math.floor(timeSec/60)} min ${timeSec%60 > 0 ? timeSec%60+'s' : ''}`.trim() : `${timeSec}s`;
    const isSituational = question_type === 'video_situational';

    const systemPrompt = `You are an expert HireVue & video interview coach for ${platform}. Return JSON only:
{
  "key_points": ["3-5 key points to hit, each starting with a strong verb, max 8 words"],
  "answer_draft": "Complete spoken STAR answer, 60-90 words, natural conversational tone, first-person",
  "avoid": ["3 things to avoid specific to this question"],
  "time_plan": "How to split ${timeStr} across STAR: e.g. S:15s T:10s A:45s R:20s (adjust for actual limit)"
}
${isSituational ? 'This is situational — use hypothetical framing: "In that situation I would…"' : 'This is behavioral — use past tense: "There was a time when…"'}`;

    try {
      const raw = await createMessage({ model: model || 'claude-haiku', max_tokens: 500, system: systemPrompt, messages: [{ role: 'user', content: `Platform: ${platform}\nTime limit: ${timeStr}\nQuestion: "${question}"` }] });
      const clean = raw.replace(/^```json\s*/i,'').replace(/```\s*$/,'').trim();
      let r; try { r = JSON.parse(clean); } catch { const m = clean.match(/\{[\s\S]+\}/); r = m ? JSON.parse(m[0]) : null; if (!r) return reply.code(500).send({ error: 'Parse failed', raw }); }
      return { type: 'video', ...r };
    } catch (err) {
      fastify.log.error(err, '[practice/online-assessment]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /linkedin-headlines — LinkedIn headline varyasyonları ──────────────
  fastify.post('/linkedin-headlines', async (request, reply) => {
    const { current_title = '', target_role = '', skills = '', industry = 'General', tone = 'professional', count = 5, model } = request.body ?? {};
    if (!current_title.trim()) return reply.code(400).send({ error: 'current_title required' });

    const systemPrompt = `You are a LinkedIn profile expert. Generate ${count} distinct headline variations. Return ONLY a JSON array of strings, no markdown:
["headline 1", "headline 2", ...]

Rules:
- Max 220 chars each
- Tone: ${tone}
- Mix separators: | · — / (vary between options)
- Front-load the most important keyword
- Include role + top 2-3 skills + value hint
- Avoid clichés: "results-driven", "passionate", "dynamic", "guru", "ninja"
- Each variation should feel genuinely different (not just reordered)`;

    const userPrompt = `Current title: ${current_title}
Target role: ${target_role || current_title}
Key skills: ${skills || 'not specified'}
Industry: ${industry}

Generate ${count} headline variations.`;

    try {
      const raw = await createMessage({ model: model || 'claude-haiku', max_tokens: 600, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] });
      const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      let headlines;
      try { headlines = JSON.parse(clean); }
      catch { const m = clean.match(/\[[\s\S]+\]/); headlines = m ? JSON.parse(m[0]) : [clean]; }
      return { headlines: (Array.isArray(headlines) ? headlines : [headlines]).slice(0, count) };
    } catch (err) {
      fastify.log.error(err, '[practice/linkedin-headlines]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /experience-letter — deneyim / referans mektubu ─────────────────────
  fastify.post('/experience-letter', async (request, reply) => {
    const { emp_name = '', emp_title = '', company = '', duration = '', manager_name = '', manager_title = '', achievements = '', language = 'Turkish', type = 'experience', model } = request.body ?? {};
    if (!emp_name.trim() || !emp_title.trim() || !company.trim()) return reply.code(400).send({ error: 'emp_name, emp_title, company required' });

    const typeLabel = { experience: 'Deneyim Mektubu / Experience Letter', reference: 'Referans/Tavsiye Mektubu / Reference Letter', employment: 'Çalışma Belgesi / Employment Certificate' }[type] || 'Experience Letter';

    const systemPrompt = `You are an expert HR professional. Write a formal ${typeLabel} in ${language}. Output ONLY the letter text — no explanation, no markdown, no JSON. Use professional business letter format with date, recipient section, body paragraphs, and signature block.`;

    const userPrompt = `Employee: ${emp_name}, ${emp_title}
Company: ${company}
Duration: ${duration || 'not specified'}
Signing manager: ${manager_name || '[Manager Name]'}, ${manager_title || '[Title]'}
Key responsibilities & achievements: ${achievements || 'general duties performed satisfactorily'}
Letter type: ${type}
Language: ${language}

Write the complete formal letter.`;

    try {
      const letter = await createMessage({ model: model || 'claude-sonnet', max_tokens: 900, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] });
      return { letter: letter.trim() };
    } catch (err) {
      fastify.log.error(err, '[practice/experience-letter]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /optimize-linkedin — LinkedIn profile optimizer ─────────────────────
  fastify.post('/optimize-linkedin', async (request, reply) => {
    const {
      profile_text  = '',
      current_headline = '',
      target_role   = '',
      industry      = 'General',
      tone          = 'professional',
      language      = 'English',
      model,
    } = request.body ?? {};

    if (!profile_text || profile_text.trim().length < 50) {
      return reply.code(400).send({ error: 'profile_text required (min 50 chars)' });
    }

    const trimmed = profile_text.trim().slice(0, 6000);

    const systemPrompt = `You are a senior LinkedIn profile optimizer and career coach. Analyze the LinkedIn profile and return a JSON optimization report.

Return ONLY valid JSON (no markdown):
{
  "score_before": <0-100 number based on the current profile>,
  "score_after": <0-100 projected score after optimization>,
  "score_note": "<one sentence why the score changed>",
  "headline_before": "<extracted current headline from profile text, or empty string>",
  "headline": "<optimized headline in ${language}, max 220 chars, keyword-rich, role + value proposition + differentiator>",
  "about": "<optimized About/Summary section in ${language}, 2400-2500 chars, hook first line, keywords in first 3 lines, quantified achievements, call-to-action last line>",
  "skills": ["skill1", "skill2", "skill3", "skill4", "skill5", "skill6", "skill7", "skill8", "skill9", "skill10"],
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5", "keyword6", "keyword7", "keyword8"],
  "recommendations": [
    "Specific actionable improvement 1",
    "Specific actionable improvement 2",
    "Specific actionable improvement 3",
    "Specific actionable improvement 4",
    "Specific actionable improvement 5"
  ]
}

Rules:
- Tone: ${tone}
- Target role: ${target_role || 'not specified — infer from profile'}
- Industry: ${industry}
- Headline: pack 3-4 keywords, separate with | or ·, no buzzwords like "results-driven"
- About: use first-person, start with a hook (not "I am"), include 2-3 numbers, end with "Let's connect" or similar
- Skills: pick the 10 most searched/valued for the target role, mix technical + soft
- Keywords: terms recruiters actually search for this role in LinkedIn Recruiter
- Recommendations: be specific (e.g. "Add a Featured section with your top project", not "improve your profile")`;

    const userPrompt = `Target role: ${target_role || '(infer from profile)'}
Industry: ${industry}
Current headline: ${current_headline || '(extract from profile)'}

Profile text:
${trimmed}`;

    try {
      const raw = await createMessage({
        model:      model || 'claude-sonnet',
        max_tokens: 1800,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userPrompt }],
      });

      const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      let result;
      try { result = JSON.parse(clean); }
      catch {
        const m = clean.match(/\{[\s\S]+\}/);
        if (m) { try { result = JSON.parse(m[0]); } catch { return reply.code(500).send({ error: 'Parse failed', raw }); } }
        else   { return reply.code(500).send({ error: 'Parse failed', raw }); }
      }

      return result;
    } catch (err) {
      fastify.log.error(err, '[practice/optimize-linkedin]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /generate-answers — generate STAR answers for predicted questions ──
  // Takes a list of questions + candidate profile, returns personalised answers
  fastify.post('/generate-answers', async (request, reply) => {
    const {
      questions    = [],
      profile      = {},
      jd_context   = '',
      model,
      language     = 'Turkish',
    } = request.body ?? {};

    if (!questions.length) {
      return reply.code(400).send({ error: 'questions array required' });
    }

    const name        = profile.name     || 'Candidate';
    const title       = profile.title    || '';
    const skills      = profile.skills   || '';
    const cvText      = profile.cv_text  || '';
    const background  = cvText
      ? cvText.slice(0, 3000)
      : `Title: ${title}. Skills: ${skills}`;

    const systemPrompt = `You are a senior interview coach. Write natural, engaging spoken STAR answers — the kind that keeps an interviewer nodding, not checking their phone.

Language: ${language}

Tone & style:
- Write exactly as someone would SPEAK in an interview — warm, confident, natural flow
- No bullet points, no headers, no "Situation:", "Task:" labels — just flowing speech
- Use "I", "we", "my team" naturally
- Include one concrete detail or number to make it credible (%, time saved, team size, revenue impact)
- Engaging opening that hooks — don't start with "In my previous role" every time
- Close with a clear result and optionally a lesson learned or what it shows about you

Length: 80-110 words — enough to be complete and satisfying, short enough to stay sharp.
Never pad. Never repeat yourself. If the candidate's background lacks detail, invent plausible specifics consistent with their title and skills.

For each question return a JSON object:
- "question": the original question text
- "answer": the spoken answer (80-110 words, in ${language})
- "key_points": 3 short phrases (each 4-7 words) the candidate should remember to hit

Return a JSON array only — no markdown, no extra text.`;

    const userPrompt = `Candidate: ${name} — ${title}
Background:
${background}

Job context: ${jd_context ? jd_context.slice(0, 1000) : 'General role'}

Generate personalised STAR answers for these ${questions.length} questions:
${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`;

    try {
      const raw = await createMessage({
        model:      model || 'claude-sonnet',
        max_tokens: 200 * questions.length + 300,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userPrompt }],
      });

      const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      let answers;
      try { answers = JSON.parse(clean); }
      catch {
        // Fallback: try to extract JSON array
        const m = clean.match(/\[[\s\S]+\]/);
        if (m) {
          try { answers = JSON.parse(m[0]); }
          catch { return reply.code(500).send({ error: 'Parse failed', raw }); }
        } else {
          return reply.code(500).send({ error: 'Parse failed', raw });
        }
      }

      return { answers, profile_used: name };
    } catch (err) {
      fastify.log.error(err, '[practice/generate-answers]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /cover-letter — generate a personalized cover letter ─────────────
  fastify.post('/cover-letter', async (request, reply) => {
    const {
      name             = 'Candidate',
      current_title    = '',
      company_name     = 'the company',
      job_description  = '',
      experience_years = '',
      key_skills       = [],
      tone             = 'professional',
    } = request.body ?? {};

    if (!job_description || job_description.trim().length < 50) {
      return reply.code(400).send({ error: 'job_description required (min 50 chars)' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });
    }

    const skillsText = Array.isArray(key_skills) && key_skills.length
      ? key_skills.join(', ')
      : 'not specified';

    const userPrompt = `
Candidate Name: ${name}
Current Title: ${current_title || 'not specified'}
Years of Experience: ${experience_years || 'not specified'}
Key Skills: ${skillsText}
Target Company: ${company_name}
Desired Tone: ${tone}

Job Description:
${job_description.trim()}

Write the cover letter now.`.trim();

    try {
      const letter = await createMessage({
        model:      request.body?.model || 'claude-sonnet',
        max_tokens: 800,
        system:     COVER_LETTER_SYSTEM,
        messages:   [{ role: 'user', content: userPrompt }],
      });

      const words = letter.trim().split(/\s+/).length;
      return { cover_letter: letter.trim(), word_count: words };

    } catch (err) {
      fastify.log.error(err, '[practice/cover-letter]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /ats-score — ATS compatibility analysis ──────────────────────────
  fastify.post('/ats-score', async (request, reply) => {
    const { cv_text, job_description, language = 'Turkish' } = request.body ?? {};

    if (!cv_text || cv_text.trim().length < 50)
      return reply.code(400).send({ error: 'cv_text required (min 50 chars)' });
    if (!job_description || job_description.trim().length < 50)
      return reply.code(400).send({ error: 'job_description required (min 50 chars)' });
    if (!process.env.ANTHROPIC_API_KEY)
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });

    const userPrompt = `Provide all text feedback (strengths, gaps, recommendations) in ${language}.

JOB DESCRIPTION:
${job_description.trim()}

CANDIDATE CV/RESUME:
${cv_text.trim()}

Analyze the match and return the JSON scorecard.`;

    try {
      const raw = await createMessage({
        model:      request.body?.model || 'claude-haiku',
        max_tokens: 900,
        system:     ATS_SYSTEM,
        messages:   [{ role: 'user', content: userPrompt }],
      });
      const result = safeParseJSON(raw);
      if (!result) return reply.code(500).send({ error: 'Parse failed — please try again.' });
      return result;
    } catch (err) {
      fastify.log.error(err, '[practice/ats-score]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /build-resume — generate ATS-optimized resume text ──────────────
  fastify.post('/build-resume', async (request, reply) => {
    const {
      name, email = '', phone = '', linkedin = '', location = '',
      target_role = '', summary = '',
      experience  = [],
      education   = [],
      skills      = [],
      language    = 'English',
    } = request.body ?? {};

    if (!name || name.trim().length < 2)
      return reply.code(400).send({ error: 'name required' });
    if (!process.env.ANTHROPIC_API_KEY)
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });

    const expText = experience.length
      ? experience.map((e) =>
          `• ${e.title || 'Role'} at ${e.company || 'Company'} (${e.dates || 'Dates'}): ${e.description || ''}`
        ).join('\n')
      : 'Not provided';

    const eduText = education.length
      ? education.map((e) =>
          `• ${e.degree || 'Degree'} — ${e.institution || 'Institution'} (${e.year || ''})`
        ).join('\n')
      : 'Not provided';

    const skillsText = Array.isArray(skills) ? skills.join(', ') : skills;

    const userPrompt = `Write the resume in ${language}.

Full Name: ${name.trim()}
Email: ${email}  |  Phone: ${phone}  |  LinkedIn: ${linkedin}  |  Location: ${location}
Target Role: ${target_role}

Background / Summary notes: ${summary || 'Not provided'}

Work Experience:
${expText}

Education:
${eduText}

Skills: ${skillsText || 'Not provided'}

Write the complete ATS-optimized resume now.`;

    try {
      const resume = await createMessage({
        model:      request.body?.model || 'claude-sonnet',
        max_tokens: 1200,
        system:     RESUME_SYSTEM,
        messages:   [{ role: 'user', content: userPrompt }],
      });
      const words = resume.trim().split(/\s+/).length;
      return { resume: resume.trim(), word_count: words };
    } catch (err) {
      fastify.log.error(err, '[practice/build-resume]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /apply-package — quick application kit for a JD ─────────────────
  fastify.post('/apply-package', async (request, reply) => {
    const {
      job_description,
      candidate_profile = '',
      language          = 'Turkish',
    } = request.body ?? {};

    if (!job_description || job_description.trim().length < 50)
      return reply.code(400).send({ error: 'job_description required (min 50 chars)' });
    if (!process.env.ANTHROPIC_API_KEY)
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });

    const userPrompt = `Provide all text in ${language}.

JOB DESCRIPTION:
${job_description.trim()}

CANDIDATE PROFILE (optional context):
${candidate_profile.trim() || 'Not provided — evaluate based on JD alone'}

Create the application package JSON now.`;

    try {
      const raw = await createMessage({
        model:      request.body?.model || 'claude-haiku',
        max_tokens: 800,
        system:     APPLY_PACKAGE_SYSTEM,
        messages:   [{ role: 'user', content: userPrompt }],
      });
      const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      let result;
      try { result = JSON.parse(clean); }
      catch { return reply.code(500).send({ error: 'Parse failed', raw }); }
      return result;
    } catch (err) {
      fastify.log.error(err, '[practice/apply-package]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /adapt-cv — tailor existing CV to a specific job description ──────
  fastify.post('/adapt-cv', async (request, reply) => {
    const {
      base_cv,
      job_description,
      language = 'English',
    } = request.body ?? {};

    if (!base_cv || base_cv.trim().length < 50)
      return reply.code(400).send({ error: 'base_cv required (min 50 chars)' });
    if (!job_description || job_description.trim().length < 50)
      return reply.code(400).send({ error: 'job_description required (min 50 chars)' });
    if (!process.env.ANTHROPIC_API_KEY)
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });

    const userPrompt = `Adapt the CV. Write the output in ${language}.

JOB DESCRIPTION:
${job_description.trim()}

CANDIDATE'S CURRENT CV:
${base_cv.trim()}

Return the adapted CV now.`;

    try {
      const adapted = await createMessage({
        model:      request.body?.model || 'claude-sonnet',
        max_tokens: 1200,
        system:     ADAPT_CV_SYSTEM,
        messages:   [{ role: 'user', content: userPrompt }],
      });
      return { adapted_cv: adapted.trim(), word_count: adapted.trim().split(/\s+/).length };
    } catch (err) {
      fastify.log.error(err, '[practice/adapt-cv]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /full-package — JD → adapted CV + cover letter + ATS in one go ──
  fastify.post('/full-package', async (request, reply) => {
    const {
      job_description,
      base_cv         = '',
      candidate_name  = 'Candidate',
      candidate_title = '',
      key_skills      = [],
      tone            = 'professional',
      language        = 'English',
    } = request.body ?? {};

    if (!job_description || job_description.trim().length < 50)
      return reply.code(400).send({ error: 'job_description required (min 50 chars)' });
    if (!process.env.ANTHROPIC_API_KEY)
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });

    const skillsText = Array.isArray(key_skills) ? key_skills.join(', ') : key_skills;

    // Run all three in parallel
    const [cvResult, clResult, atsResult] = await Promise.allSettled([
      // 1. Adapt CV (only if base_cv provided)
      base_cv.trim().length > 50
        ? createMessage({
            model: request.body?.model || 'claude-sonnet', max_tokens: 1200, system: ADAPT_CV_SYSTEM,
            messages: [{ role: 'user', content: `Adapt in ${language}.\n\nJOB DESCRIPTION:\n${job_description.trim()}\n\nCV:\n${base_cv.trim()}` }],
          })
        : Promise.resolve(null),

      // 2. Cover letter
      createMessage({
        model: request.body?.model || 'claude-sonnet', max_tokens: 700, system: COVER_LETTER_SYSTEM,
        messages: [{ role: 'user', content: `Write in ${language}. Tone: ${tone}.\nCandidate: ${candidate_name}, ${candidate_title}.\nSkills: ${skillsText}.\n\nJob Description:\n${job_description.trim()}` }],
      }),

      // 3. ATS score
      createMessage({
        model: 'claude-haiku-4-5-20251001', max_tokens: 700, system: ATS_SYSTEM,
        messages: [{ role: 'user', content: `Feedback in ${language}.\n\nJOB DESCRIPTION:\n${job_description.trim()}\n\nCV:\n${base_cv.trim() || 'Not provided — evaluate based on candidate skills: ' + skillsText}` }],
      }),
    ]);

    const adapted_cv   = cvResult.status  === 'fulfilled' && cvResult.value  ? cvResult.value.trim()  : null;
    const cover_letter = clResult.status  === 'fulfilled'                    ? clResult.value.trim()  : null;
    let   ats          = null;
    if (atsResult.status === 'fulfilled') {
      try {
        const clean = atsResult.value.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        ats = JSON.parse(clean);
      } catch { /* ignore parse failure */ }
    }

    return { adapted_cv, cover_letter, ats };
  });
}

module.exports = practiceRoutes;
