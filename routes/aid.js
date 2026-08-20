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

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a real-time interview coach. Write a short spoken answer using the candidate's PROFILE and CAREER BACKGROUND.

Rules:
- 2-3 sentences MAX, natural conversational speech, first person
- Use candidate's actual roles, skills, and career history — be specific
- If the question relates to past career (e.g. education, management, leadership), reference the candidate's relevant previous experience
- Sound like talking, not writing — casual but confident
- Output ONLY the spoken answer, nothing else`;

const WEB_SYSTEM_PROMPT = SYSTEM_PROMPT;

// ── Route ─────────────────────────────────────────────────────────────────────
async function aidRoutes(fastify) {

  fastify.post('/stream', (request, reply) => {
    const { question, sector = 'universal_behavioral', seniority = 'mid', model, memory = '', web_context = '', jd_context = '' } = request.body ?? {};

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
    const jdSection    = hasJdContext  ? `\n\nJOB CONTEXT: ${jd_context.slice(0, 400)}`          : '';
    const userPrompt = `${sector} / ${seniority}: "${question.trim()}"${memory ? memory : ''}${jdSection}${webSection}`;
    const t0 = Date.now();

    // Use model from request body, fall back to claude-haiku
    const aiModel = model || 'claude-haiku';
    if (hasWebContext) fastify.log.info({ ms: 0 }, '[aid] web context enjekte edildi');

    streamMessage({
      model:      aiModel,
      max_tokens: hasWebContext ? 350 : 320,
      system:     hasWebContext ? WEB_SYSTEM_PROMPT : SYSTEM_PROMPT,
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
      const { question, jd_context = '', model } = request.body ?? {};
      if (!question) return reply.code(400).send({ error: 'question required' });

      const prompt = `Question: "${question}"${jd_context ? `\n\nCANDIDATE PROFILE:\n${jd_context}` : ''}`;

      const { createMessage } = require('../lib/ai');
      const raw = await createMessage({
        model: model || 'claude-haiku',
        max_tokens: 180,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });

      const answer = (raw || '').trim();
      fastify.log.info({ answer: answer.slice(0, 80) }, '[aid/answer]');
      return { points: [], answer };
    } catch(err) {
      fastify.log.error(err, '[aid/answer] hata');
      return reply.code(500).send({ error: err.message });
    }
  });
  // ── POST /screenshot — ekran görüntüsü → AI analiz ──────────────────────────
  fastify.post('/screenshot', async (request, reply) => {
    try {
      const { image_base64, jd_context = '' } = request.body ?? {};
      if (!image_base64) return reply.code(400).send({ error: 'image_base64 required' });

      // "data:image/png;base64,<data>" → parts
      const match = image_base64.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!match) return reply.code(400).send({ error: 'Geçersiz görüntü formatı' });

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
      fastify.log.error(err, '[aid/screenshot] hata');
      return reply.code(500).send({ error: err.message });
    }
  });
}

module.exports = aidRoutes;
