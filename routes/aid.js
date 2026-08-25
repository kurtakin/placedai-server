/**
 * server/routes/aid.js — /api/v1/aid/stream
 *
 * POST /api/v1/aid/stream
 * Body: { question: string, sector: string, seniority: string, model?: string }
 *
 * Supports both Claude (default) and OpenAI models via unified ai.js dispatcher.
 *
 * Response: text/event-stream (SSE)
 *   data: { type: "key_points", data: string[] }
 *   data: { type: "token",      data: string }
 *   data: { type: "done" }
 */

'use strict';

const { Readable }     = require('stream');
const { streamMessage } = require('../lib/ai');
const { requireAuth, requirePlan } = require('../middleware/auth');
const { checkAndIncrement, getUsage } = require('../lib/usage');

// ── System prompts — 3 interview types × 2 lengths ───────────────────────────

const PROMPTS = {

  // ── 💼 Job Interview ────────────────────────────────────────────────────────
  job_interview: {
    short: `You are a real-time interview coach. Write a SHORT spoken answer using the candidate's PROFILE and CAREER BACKGROUND.

Rules:
- 2-3 sentences MAX, natural conversational speech, first person
- Use candidate's actual roles, skills, and career history — be specific
- Sound like talking, not writing — casual but confident
- Output ONLY the spoken answer, nothing else`,

    detailed: `You are a real-time interview coach. Write a DETAILED spoken answer using the candidate's PROFILE and CAREER BACKGROUND.

Rules:
- 5-7 sentences, first person, natural speech
- Structure: (1) direct answer → (2) Situation/context → (3) Action you took → (4) Result/impact → (5) brief takeaway
- Use STAR method for behavioral questions
- Reference specific roles, metrics, or achievements from the candidate's background
- Output ONLY the spoken answer, nothing else`,
  },

  // ── 🤝 Client Discovery Call ────────────────────────────────────────────────
  client_discovery: {
    short: `You are a real-time coaching assistant helping a consultant or agency owner during a client discovery call.
Goal: help them understand the client's needs, qualify the opportunity, and position their services.

Rules:
- 2-3 sentences MAX, natural conversational speech, first person
- Focus: active listening, asking sharp clarifying questions, articulating value without overselling
- Sound consultative and confident — never pushy or salesy
- Output ONLY the spoken response, nothing else`,

    detailed: `You are a real-time coaching assistant for a client discovery call.
Goal: help the consultant deeply understand client needs and position their solution effectively.

Rules:
- 5-6 sentences, first person, natural consultative speech
- Structure: (1) empathize/acknowledge → (2) dig deeper with a clarifying question → (3) share a relevant insight or reframe → (4) position your approach/value → (5) suggest a clear next step
- Sound professional but human — like a trusted advisor, not a salesperson
- Output ONLY the spoken response, nothing else`,
  },

  // ── 🧑‍💻 Freelancer ─────────────────────────────────────────────────────────
  freelancer: {
    short: `You are a real-time coaching assistant helping a freelancer during a client or project scoping call.
Goal: help them negotiate rates, clarify scope, and set professional expectations.

Rules:
- 2-3 sentences MAX, natural conversational speech, first person
- Focus: scope clarification, rate/timeline negotiation, professional boundaries, handling scope creep
- Confident but approachable — protect their time and value without being stiff
- Output ONLY the spoken response, nothing else`,

    detailed: `You are a real-time coaching assistant helping a freelancer during a client call.
Goal: help them articulate value, negotiate confidently, and set clear professional boundaries.

Rules:
- 5-6 sentences, first person, natural speech
- Structure: (1) acknowledge the request → (2) clarify scope or requirements → (3) state your approach/value → (4) address rate, timeline, or deliverables → (5) set expectation or suggest next step
- Confident and warm — position them as the expert without sounding defensive
- Output ONLY the spoken response, nothing else`,
  },

  // ── 💻 Technical Interview ───────────────────────────────────────────────────
  technical_interview: {
    short: `You are a real-time technical interview coach. Help the candidate answer coding, system, or technical questions.

Rules:
- 2-4 sentences, clear and precise technical language, first person
- Lead with the approach/algorithm/pattern, then complexity if relevant
- Reference candidate's actual tech stack and experience when useful
- Sound confident and methodical — not rushed
- Output ONLY the spoken answer, nothing else`,

    detailed: `You are a real-time technical interview coach helping with coding, design, or system questions.

Rules:
- 5-7 sentences, first person, clear technical speech
- Structure: (1) name the approach/pattern → (2) walk through the logic step by step → (3) mention edge cases or trade-offs → (4) state time/space complexity if relevant → (5) reference similar work from candidate's background
- Speak like you're thinking aloud — confident but showing reasoning
- Output ONLY the spoken answer, nothing else`,
  },

  // ── 🧠 Behavioral Interview ──────────────────────────────────────────────────
  behavioral_interview: {
    short: `You are a real-time behavioral interview coach. Help the candidate answer "Tell me about a time…" and competency questions.

Rules:
- 2-3 sentences MAX, first person, natural storytelling voice
- Always ground the answer in a real situation from the candidate's background
- Focus on what THEY specifically did and the result
- Output ONLY the spoken answer, nothing else`,

    detailed: `You are a real-time behavioral interview coach. Help the candidate craft a compelling STAR story.

Rules:
- 5-7 sentences, first person, confident storytelling
- Strict STAR structure: (1) Situation — set the scene briefly → (2) Task — what was your responsibility → (3) Action — specific steps YOU took (use "I", not "we") → (4) Result — quantifiable outcome or impact → (5) brief reflection or takeaway
- Use real details from the candidate's career: roles, companies, metrics
- Output ONLY the spoken answer, nothing else`,
  },

  // ── 📋 Case Study Interview ──────────────────────────────────────────────────
  case_study: {
    short: `You are a real-time case interview coach helping with consulting or business case questions.

Rules:
- 2-3 sentences, structured and analytical, first person
- Lead with clarifying what you understand the problem to be, then your initial hypothesis
- Sound like a sharp consultant: structured, calm, hypothesis-driven
- Output ONLY the spoken answer, nothing else`,

    detailed: `You are a real-time case interview coach helping with consulting, business, or MBA-style case questions.

Rules:
- 5-6 sentences, first person, structured consulting speech
- Structure: (1) restate and clarify the problem → (2) state your framework or approach → (3) identify the key driver or biggest lever → (4) walk through your analysis → (5) give a clear recommendation with rationale
- Sound like McKinsey: structured, hypothesis-first, data-driven but conversational
- Output ONLY the spoken answer, nothing else`,
  },

  // ── 🏗️ System Design Interview ──────────────────────────────────────────────
  system_design: {
    short: `You are a real-time system design interview coach helping with architecture and scalability questions.

Rules:
- 2-4 sentences, technical but conversational, first person
- Lead by clarifying requirements/scale, then name the core architectural choice
- Mention trade-offs briefly (consistency vs availability, SQL vs NoSQL, etc.)
- Output ONLY the spoken answer, nothing else`,

    detailed: `You are a real-time system design interview coach helping with large-scale architecture questions.

Rules:
- 6-8 sentences, first person, methodical engineering speech
- Structure: (1) clarify requirements and scale → (2) high-level architecture (components, services) → (3) data model and storage choice with rationale → (4) key design decisions and trade-offs → (5) how the system scales → (6) mention bottlenecks and mitigations
- Reference patterns: load balancing, caching, CDN, message queues, sharding, microservices as relevant
- Sound like a senior engineer thinking through the design out loud
- Output ONLY the spoken answer, nothing else`,
  },

  // ── 🎯 Product Sense Interview ───────────────────────────────────────────────
  product_sense: {
    short: `You are a real-time product interview coach helping with product sense, strategy, and PM questions.

Rules:
- 2-3 sentences, analytical and user-focused, first person
- Lead with the user/customer lens, then the business opportunity
- Sound like a sharp PM: data-informed, user-obsessed, business-aware
- Output ONLY the spoken answer, nothing else`,

    detailed: `You are a real-time product interview coach helping with product sense and PM strategy questions.

Rules:
- 5-7 sentences, first person, structured PM thinking
- Structure: (1) clarify the goal and constraints → (2) identify user segments and their pain points → (3) propose 2-3 solution directions → (4) recommend one with rationale (impact vs effort) → (5) define success metrics → (6) note risks or dependencies
- Balance user empathy with business outcomes — always tie to metrics
- Output ONLY the spoken answer, nothing else`,
  },

  // ── 🎙️ Media / Press Interview ──────────────────────────────────────────────
  media_press: {
    short: `You are a real-time media coaching assistant helping someone during a press interview, podcast, or public speaking situation.

Rules:
- 2-3 sentences MAX, polished but natural, first person
- Lead with a clear message/soundbite, then one supporting point
- Confident, on-brand, never defensive — pivot away from traps gracefully
- Output ONLY the spoken response, nothing else`,

    detailed: `You are a real-time media coaching assistant helping with press interviews, podcasts, or public speaking.

Rules:
- 4-5 sentences, first person, polished conversational speech
- Structure: (1) clear message or soundbite first → (2) one concrete example or proof point → (3) bridge back to your key narrative → (4) end with a forward-looking or positive statement
- Never get defensive — acknowledge and pivot. Stay on-message.
- Use power language: confident, quotable, zero filler words
- Output ONLY the spoken response, nothing else`,
  },
};

// Legacy aliases
const SYSTEM_PROMPT     = PROMPTS.job_interview.short;
const WEB_SYSTEM_PROMPT = PROMPTS.job_interview.short;

/**
 * Pick the right system prompt + token budget.
 * @param {string} answer_length   'short' | 'detailed'
 * @param {boolean} has_web_context  add web-context note to system prompt
 * @param {string} interview_type  'job_interview'|'client_discovery'|'freelancer'|'technical_interview'|'behavioral_interview'|'case_study'|'system_design'|'product_sense'|'media_press'
 * @param {string} language        ISO-639-1 code: 'en' | 'tr' | 'es' | 'fr' | 'de' | 'pt' | 'ar' | 'it' | 'nl' | 'ru' | 'zh' | 'ja' | 'ko'
 */
const LANGUAGE_NAMES = {
  en: 'English',   tr: 'Turkish',   es: 'Spanish',  fr: 'French',
  de: 'German',    pt: 'Portuguese',ar: 'Arabic',   it: 'Italian',
  nl: 'Dutch',     ru: 'Russian',   zh: 'Chinese',  ja: 'Japanese',
  ko: 'Korean',
};

// Cue-first directive. The candidate is speaking RIGHT NOW, so the three cues
// must arrive before the full answer — they are the only thing a person can
// actually read mid-sentence. The overlay renders them the moment this first
// line completes, while the answer is still streaming.
const POINTS_DIRECTIVE = `
OUTPUT FORMAT — exactly two lines, in this order:

POINTS: <cue 1> | <cue 2> | <cue 3>
ANSWER: <the spoken answer>

The POINTS line comes FIRST and must be complete before the answer starts.
Each cue: at most 5 words, concrete, glanceable — a noun phrase the candidate
can read at a glance and speak from. Draw them from the candidate's own
background and the target role. No full sentences, no filler like "be confident".
Output nothing outside these two lines — no markdown, no labels, no preamble.`;

function resolvePrompt(answer_length, has_web_context, interview_type = 'job_interview', language = 'en', with_points = false) {
  const type     = PROMPTS[interview_type] ? interview_type : 'job_interview';
  const detailed = answer_length === 'detailed';
  let   system   = PROMPTS[type][detailed ? 'detailed' : 'short'];

  if (has_web_context && !detailed) {
    system += '\n\n[Web search results about the company are included — reference them naturally if relevant]';
  }

  if (with_points) {
    // The base prompts end with "Output ONLY the spoken answer" — the format
    // block below replaces that instruction, so it must come last.
    system += '\n' + POINTS_DIRECTIVE;
  }

  // Language directive — append only when not English
  const langName = LANGUAGE_NAMES[language];
  if (langName && language !== 'en') {
    system += `\n\nIMPORTANT: Respond ONLY in ${langName}. Do not use English at all.`;
  }

  return {
    system,
    // +60 tokens for the POINTS line so it never eats into the answer budget
    max_tokens: (detailed ? 550 : (has_web_context ? 350 : 320)) + (with_points ? 60 : 0),
  };
}

/**
 * Split the model's two-line output into cues and the spoken answer.
 * Tolerates a missing POINTS line — then everything is the answer.
 */
function splitPointsAndAnswer(raw) {
  const text = (raw || '').trim();
  const pointsMatch = text.match(/POINTS:\s*(.+?)(?:\r?\n|ANSWER:|$)/i);
  const answerMatch = text.match(/ANSWER:\s*([\s\S]+)/i);

  const points = pointsMatch
    ? pointsMatch[1].split('|').map(x => x.trim()).filter(Boolean).slice(0, 3)
    : [];

  let answer = answerMatch ? answerMatch[1].trim() : '';
  if (!answer) {
    // No ANSWER: label — treat the whole thing as the answer, minus any
    // POINTS line we already consumed.
    answer = pointsMatch ? text.replace(pointsMatch[0], '').trim() : text;
  }
  return { points, answer };
}

// ── Route ─────────────────────────────────────────────────────────────────────
/**
 * meterFreePlan — preHandler that spends one Free-plan credit.
 *
 * Used on streaming routes, where the check has to happen before the SSE
 * response starts. Paid plans short-circuit inside checkAndIncrement.
 */
async function meterFreePlan(request, reply) {
  const usage = await checkAndIncrement(request.user);
  if (!usage.allowed) {
    return reply.code(429).send({
      error:   'monthly_limit_reached',
      message: `Free plan limit of ${usage.limit} answers/month reached. Upgrade to Pro for unlimited answers.`,
      used:    usage.used,
      limit:   usage.limit,
    });
  }
}

async function aidRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // The live interview answer endpoint — the core paid feature, so it spends
  // a Free-plan credit before the stream opens.
  fastify.post('/stream', { preHandler: meterFreePlan }, (request, reply) => {
    const { question, sector = 'universal_behavioral', seniority = 'mid', model, memory = '', web_context = '', jd_context = '', answer_length = 'short', interview_type = 'job_interview', language = 'en', with_points = false } = request.body ?? {};

    if (!question || typeof question !== 'string' || question.trim().length < 5) {
      return reply.code(400).send({ error: 'question is required (min 5 chars)' });
    }

    if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
      return reply.code(500).send({ error: 'No AI API key configured' });
    }

    // ── Create Readable stream for SSE ────────────────────────────────────────
    const readable = new Readable({ read() {} });

    const send = (obj) => {
      readable.push(`data: ${JSON.stringify(obj)}\n\n`);
    };

    reply
      .header('Content-Type',  'text/event-stream')
      .header('Cache-Control', 'no-cache')
      .header('Connection',    'keep-alive')
      .header('X-Accel-Buffering', 'no')
      .send(readable);

    // ── Streaming parse state ─────────────────────────────────────────────────
    let accumulated  = '';
    let lastSentIdx  = 0;
    let pointsSent   = false;
    let answerOffset = -1;

    const ANSWER_PREFIX = 'ANSWER: ';

    function flushBuffer() {
      // Her yeni token'ı direkt gönder — client tarafı parse eder
      const newText = accumulated.slice(lastSentIdx);
      if (newText.length > 0) {
        send({ type: 'token', data: newText });
        lastSentIdx = accumulated.length;
      }
    }

    const hasWebContext = web_context && web_context.trim().length > 20;
    const hasJdContext  = jd_context  && jd_context.trim().length  > 10;
    const webSection   = hasWebContext ? `\n\nWEB SEARCH RESULTS:\n${web_context.slice(0, 1200)}` : '';
    // 1500 chars, not 400: the candidate profile, the target role and the
    // learned corrections all travel in this field — 400 truncated the CV away.
    const jdSection    = hasJdContext  ? `\n\nJOB CONTEXT: ${jd_context.slice(0, 1500)}`         : '';
    const userPrompt = `${sector} / ${seniority}: "${question.trim()}"${memory ? memory : ''}${jdSection}${webSection}`;
    const t0 = Date.now();

    // Use model from request body, fall back to claude-haiku
    const aiModel = model || 'claude-haiku';
    if (hasWebContext) fastify.log.info({ ms: 0 }, '[aid] web context enjekte edildi');

    const { system: streamSystem, max_tokens: streamMaxTokens } = resolvePrompt(answer_length, hasWebContext, interview_type, language, with_points);

    streamMessage({
      model:      aiModel,
      max_tokens: streamMaxTokens,
      system:     streamSystem,
      messages:   [{ role: 'user', content: userPrompt }],
      onToken: (token) => {
        if (accumulated === '') {
          fastify.log.info({ ms: Date.now() - t0, model: aiModel }, '[aid] first token');
        }
        accumulated += token;
        flushBuffer();
      },
    })
    .then(() => {
      flushBuffer();
      send({ type: 'done' });
      fastify.log.info({ ms: Date.now() - t0 }, '[aid] stream complete');
      readable.push(null);
    })
    .catch((err) => {
      fastify.log.error(err, '[aid/stream] AI API error');
      send({ type: 'error', data: err.message });
      readable.push(null);
    });
  });
  // ── POST /answer — basit JSON, SSE yok ───────────────────────────────────
  fastify.post('/answer', async (request, reply) => {
    try {
      const { question, jd_context = '', model, answer_length = 'short', interview_type = 'job_interview', language = 'en', conversation_history = [] } = request.body ?? {};
      if (!question) return reply.code(400).send({ error: 'question required' });

      // ── Free plan monthly limit ───────────────────────────────────────────
      const usage = await checkAndIncrement(request.user);
      if (!usage.allowed) {
        return reply.code(429).send({
          error: 'monthly_limit_reached',
          message: `Free plan limit of ${usage.limit} answers/month reached. Upgrade to Pro for unlimited answers.`,
          used:  usage.used,
          limit: usage.limit,
        });
      }

      // Build conversation history block (last 3 Q&As for context coherence)
      const historyBlock = conversation_history.slice(-3).map((h, i) =>
        `[Previous Q${i + 1}]: ${(h.question || '').trim()}\n[Your answer]: ${(h.answer || '').trim()}`
      ).join('\n\n');

      const prompt = [
        historyBlock ? `RECENT CONVERSATION CONTEXT:\n${historyBlock}\n\n---\n` : '',
        `Current question: "${question}"`,
        jd_context ? `\n\nCANDIDATE PROFILE:\n${jd_context}` : '',
      ].join('');

      const { createMessage } = require('../lib/ai');
      const { system: ansSystem, max_tokens: ansTokens } = resolvePrompt(answer_length, false, interview_type, language, true);
      const raw = await createMessage({
        model:      model || 'claude-haiku',
        max_tokens: ansTokens,
        system:     ansSystem,
        messages: [{ role: 'user', content: prompt }],
      });

      // Same two-line format as /stream, parsed here so the non-streaming
      // fallback shows the cues too instead of always returning points: [].
      const { points, answer } = splitPointsAndAnswer(raw);
      fastify.log.info({ points: points.length, answer: answer.slice(0, 80) }, '[aid/answer]');
      return { points, answer };
    } catch(err) {
      fastify.log.error(err, '[aid/answer] error');
      return reply.code(500).send({ error: err.message });
    }
  });
  // ── POST /screenshot — ekran görüntüsü → AI analiz ──────────────────────────
  // Screenshot analysis is a Pro feature (see lib/features-config.ts).
  fastify.post('/screenshot', { preHandler: requirePlan() }, async (request, reply) => {
    try {
      const { image_base64, jd_context = '' } = request.body ?? {};
      if (!image_base64) return reply.code(400).send({ error: 'image_base64 required' });

      // ── Free plan monthly limit (screenshot counts as 1 answer) ──────────
      const usage = await checkAndIncrement(request.user);
      if (!usage.allowed) {
        return reply.code(429).send({
          error: 'monthly_limit_reached',
          message: `Free plan limit of ${usage.limit} answers/month reached. Upgrade to Pro for unlimited answers.`,
          used:  usage.used,
          limit: usage.limit,
        });
      }

      // "data:image/png;base64,<data>" → parts
      const match = image_base64.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!match) return reply.code(400).send({ error: 'Invalid image format' });

      const mediaType = 'image/' + match[1]; // e.g. 'image/png'
      const imgData   = match[2];            // raw base64

      const { createMessage } = require('../lib/ai');

      const systemPrompt = [
        'You are a real-time interview assistant analyzing the candidate\'s screen.',
        'Identify any interview question, coding problem, technical task, or assessment question visible in the screenshot.',
        'Then provide a concise, practical answer or approach.',
        jd_context ? `Candidate context: ${jd_context.slice(0, 400)}` : '',
        '',
        'Output format (strictly two labeled sections):',
        'QUESTION: [the question or task you identified, 1 sentence]',
        'ANSWER: [2-4 sentence spoken answer; for coding: key approach + 2-3 steps]',
      ].filter(Boolean).join('\n');

      const raw = await createMessage({
        model:      'claude-haiku',
        max_tokens: 450,
        system:     systemPrompt,
        messages:   [{
          role:    'user',
          content: [
            {
              type:   'image',
              source: { type: 'base64', media_type: mediaType, data: imgData },
            },
            {
              type: 'text',
              text: 'Identify the interview question or task and provide a helpful answer.',
            },
          ],
        }],
      });

      const qMatch = raw.match(/QUESTION:\s*(.+?)(?:\n|$)/i);
      const aMatch = raw.match(/ANSWER:\s*([\s\S]+)/i);

      fastify.log.info({ q: (qMatch?.[1] || '').slice(0, 80) }, '[aid/screenshot]');
      return reply.send({
        question: (qMatch?.[1] || '📸 Ekran görüntüsü').trim(),
        answer:   (aMatch?.[1] || raw).trim(),
      });

    } catch (err) {
      fastify.log.error(err, '[aid/screenshot] error');
      return reply.code(500).send({ error: err.message });
    }
  });
  // ── POST /chat — mülakat sonrası koçluk sohbeti (SSE) ──────────────────────
  // Post-interview coaching chat is a Pro feature (see lib/features-config.ts).
  fastify.post('/chat', { preHandler: requirePlan() }, (request, reply) => {
    const { messages = [], transcripts = [], jd_context = '', language = 'en' } = request.body ?? {};

    if (!messages.length) {
      return reply.code(400).send({ error: 'messages required' });
    }

    // Build transcript block — last 20 Q&As
    const pairs = transcripts.slice(-20);
    const transcriptBlock = pairs.length > 0
      ? pairs.map((t, i) =>
          `Q${i + 1}: ${(t.question || '').trim()}\nA${i + 1}: ${(t.answer || '').trim()}`
        ).join('\n\n')
      : '(No interview transcript provided)';

    const systemPrompt = [
      'You are an expert interview coach. The candidate just completed an interview session and wants to review their performance.',
      `\nINTERVIEW TRANSCRIPT:\n${transcriptBlock}`,
      jd_context ? `\nCANDIDATE CONTEXT:\n${jd_context.slice(0, 400)}` : '',
      '\nGuidelines:',
      '- Give specific, actionable feedback referencing their ACTUAL answers (quote them when relevant)',
      '- Help rewrite weak answers using the STAR method (Situation → Task → Action → Result)',
      '- Identify missing concrete examples, vague language, or missed opportunities',
      '- Be encouraging but direct and honest',
      '- Keep responses concise (3-5 sentences) unless asked for a detailed rewrite',
      LANGUAGE_NAMES[language] && language !== 'en'
        ? `\nIMPORTANT: Respond ONLY in ${LANGUAGE_NAMES[language]}. Do not use English at all.`
        : '',
    ].filter(Boolean).join('\n');

    const readable = new Readable({ read() {} });
    const send = (obj) => readable.push(`data: ${JSON.stringify(obj)}\n\n`);

    reply
      .header('Content-Type',      'text/event-stream')
      .header('Cache-Control',     'no-cache')
      .header('Connection',        'keep-alive')
      .header('X-Accel-Buffering', 'no')
      .send(readable);

    streamMessage({
      model:      'claude-haiku',
      max_tokens: 600,
      system:     systemPrompt,
      messages:   messages.map((m) => ({ role: m.role, content: m.content })),
      onToken:    (token) => send({ type: 'token', data: token }),
    })
    .then(() => {
      send({ type: 'done' });
      readable.push(null);
      fastify.log.info({ msgs: messages.length, q: pairs.length }, '[aid/chat] done');
    })
    .catch((err) => {
      fastify.log.error(err, '[aid/chat] error');
      send({ type: 'error', data: err.message });
      readable.push(null);
    });
  });

  // ── POST /scorecard — session sonu değerlendirme ────────────────────────────
  fastify.post('/scorecard', async (request, reply) => {
    try {
      const { transcripts = [], jd_context = '', language = 'en' } = request.body ?? {};
      if (!transcripts.length) return reply.code(400).send({ error: 'No transcripts provided' });

      const { createMessage } = require('../lib/ai');

      // Q&A metni oluştur (en fazla 20 soru)
      const pairs = transcripts.slice(-20);
      const qaText = pairs.map((t, i) =>
        `Q${i + 1}: ${(t.question || '').trim()}\nA${i + 1}: ${(t.answer || '').trim()}`
      ).join('\n\n');

      const systemPrompt = [
        'You are an expert interview coach scoring a candidate\'s session.',
        jd_context ? `Candidate context: ${jd_context.slice(0, 400)}` : '',
        '',
        'Evaluate the Q&A pairs holistically. Consider: structure (STAR), specificity, confidence, conciseness, relevance.',
        '',
        'Output EXACTLY this format — no extra text:',
        'SCORE: [1-10]',
        'GRADE: [A+|A|A-|B+|B|B-|C+|C|C-|D|F]',
        'SUMMARY: [2-3 sentences overall assessment]',
        'STRENGTHS:',
        '- [specific strength 1]',
        '- [specific strength 2]',
        '- [specific strength 3]',
        'IMPROVEMENTS:',
        '- [specific improvement 1]',
        '- [specific improvement 2]',
        '- [specific improvement 3]',
        LANGUAGE_NAMES[language] && language !== 'en'
          ? `\nIMPORTANT: Write SUMMARY, STRENGTHS, and IMPROVEMENTS in ${LANGUAGE_NAMES[language]} only. Keep the labels (SCORE:, GRADE:, SUMMARY:, STRENGTHS:, IMPROVEMENTS:) in English so the parser works.`
          : '',
      ].filter(Boolean).join('\n');

      const raw = await createMessage({
        model:      'claude-haiku',
        max_tokens: 500,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: `Interview session (${pairs.length} questions):\n\n${qaText}` }],
      });

      // Parse structured output
      const scoreMatch   = raw.match(/SCORE:\s*(\d+)/i);
      const gradeMatch   = raw.match(/GRADE:\s*([A-F][+\-]?)/i);
      const summaryMatch = raw.match(/SUMMARY:\s*(.+?)(?:\n(?:STRENGTHS|IMPROVEMENTS):|$)/is);
      const strengthsMatch    = raw.match(/STRENGTHS:\s*([\s\S]+?)(?:\nIMPROVEMENTS:|$)/i);
      const improvementsMatch = raw.match(/IMPROVEMENTS:\s*([\s\S]+?)$/i);

      const parseList = (str) =>
        (str || '').match(/[-•*]\s*(.+)/g)
          ?.map((s) => s.replace(/^[-•*]\s*/, '').trim())
          .filter(Boolean)
          .slice(0, 3) || [];

      const result = {
        overall_score: Math.min(10, Math.max(1, parseInt(scoreMatch?.[1] || '7', 10))),
        grade:         gradeMatch?.[1] || 'B',
        summary:       (summaryMatch?.[1] || '').trim(),
        strengths:     parseList(strengthsMatch?.[1]),
        improvements:  parseList(improvementsMatch?.[1]),
        question_count: pairs.length,
      };

      fastify.log.info({ score: result.overall_score, grade: result.grade }, '[aid/scorecard]');
      return reply.send(result);

    } catch (err) {
      fastify.log.error(err, '[aid/scorecard] error');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── GET /usage — free plan kullanım durumu ───────────────────────────────
  fastify.get('/usage', async (request, reply) => {
    try {
      const result = await getUsage(request.user);
      return reply.send(result);
    } catch (err) {
      fastify.log.error(err, '[aid/usage] error');
      return reply.code(500).send({ error: err.message });
    }
  });
}

module.exports = aidRoutes;
