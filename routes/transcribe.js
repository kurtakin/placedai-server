/**
 * server/routes/transcribe.js — POST /api/v1/transcribe
 *
 * Receives base64-encoded audio captured by the Electron renderer,
 * forwards it to OpenAI Whisper, and returns the transcript.
 *
 * Request body (JSON):
 *   { audio_base64: string, mime_type?: string }
 *
 * Response:
 *   { text: string, duration_ms: number }
 */

'use strict';

const { transcribeBase64 } = require('../lib/whisper');

async function transcribeRoutes(fastify) {

  fastify.post('/', async (request, reply) => {
    const { audio_base64, mime_type = 'audio/webm' } = request.body ?? {};

    if (!audio_base64 || typeof audio_base64 !== 'string' || audio_base64.length < 100) {
      return reply.code(400).send({ error: 'audio_base64 is required and must be a non-trivial base64 string' });
    }

    const start = Date.now();
    const audioBytes = Math.round(audio_base64.length * 0.75);
    fastify.log.info({ audioBytes }, '[transcribe] start');

    try {
      const text = await transcribeBase64(audio_base64, mime_type);

      fastify.log.info({ text_length: text.length, ms: Date.now() - start, audioBytes }, '[transcribe] OK');

      return {
        text,
        duration_ms: Date.now() - start,
      };

    } catch (err) {
      fastify.log.error(err, '[transcribe] Whisper API error');

      if (err.message?.includes('OPENAI_API_KEY')) {
        return reply.code(503).send({
          error: 'Transcription service not configured — set OPENAI_API_KEY in .env',
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
