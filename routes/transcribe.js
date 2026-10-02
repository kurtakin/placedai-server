/**
 * server/routes/transcribe.js — POST /api/v1/transcribe
 *
 * Receives base64-encoded audio captured by the Electron renderer,
 * forwards it to OpenAI Whisper, and returns the transcript.
 *
 * Request body (JSON):
 *   { audio_base64: string, mime_type?: string, kanal?: 'soru'|'aday', language?: string }
 *
 * K91 (2 Ekim 2026): `kanal: 'aday'` overlay'in aday kanali. Adayin kendi
 * cevabi, soru tanimaya HIC girmiyor; puan kartina gidiyor. Kendi istemi ve
 * dili var (beyaz liste). Verilmezse eski davranis: 'en' + soru istemi.
 * Metnin kendisi LOGLANMIYOR, yalnizca uzunlugu.
 *
 * Response:
 *   { text: string, duration_ms: number }
 */

'use strict';

const { transcribeBase64 } = require('../lib/whisper');
const { requireAuth }      = require('../middleware/auth');

// Aday kanali icin izin verilen diller: arayuzun alti dili (stt.js ile ayni).
const ADAY_DILLERI = ['en', 'tr', 'de', 'fr', 'es', 'it'];
const ADAY_ISTEMI  = 'A job candidate answering an interview question in their own words, first person.';

/** Istek govdesinden saglayici seceneklerini cikarir. Soru kanali: {}. */
function secenekler(govde) {
  if (!govde || govde.kanal !== 'aday') return {};
  const dil = ADAY_DILLERI.includes(govde.language) ? govde.language : 'en';
  return { language: dil, prompt: ADAY_ISTEMI };
}

async function transcribeRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.post('/', async (request, reply) => {
    const { audio_base64, mime_type = 'audio/webm' } = request.body ?? {};

    if (!audio_base64 || typeof audio_base64 !== 'string' || audio_base64.length < 100) {
      return reply.code(400).send({ error: 'audio_base64 is required and must be a non-trivial base64 string' });
    }

    const start = Date.now();
    const audioBytes = Math.round(audio_base64.length * 0.75);
    fastify.log.info({ audioBytes }, '[transcribe] start');

    try {
      const text = await transcribeBase64(audio_base64, mime_type, secenekler(request.body));

      fastify.log.info({ text_length: text.length, ms: Date.now() - start, audioBytes, kanal: request.body?.kanal === 'aday' ? 'aday' : 'soru' }, '[transcribe] OK');

      return {
        text,
        duration_ms: Date.now() - start,
      };

    } catch (err) {
      fastify.log.error(err, '[transcribe] Whisper API error');

      if (err.message?.includes('OPENAI_API_KEY')) {
        return reply.code(503).send({
          error: 'Transcription service not configured, set OPENAI_API_KEY in .env',
        });
      }

      return reply.code(500).send({
        error: 'Transcription failed',
        detail: err.message,
      });
    }
  });
}

module.exports = transcribeRoutes;
module.exports.secenekler = secenekler;
