/**
 * server/routes/stt.js — Akışlı konuşma tanıma için geçici oturum anahtarı
 *
 * Tarayıcı OpenAI Realtime'a doğrudan bağlanır (WebRTC). Gerçek API anahtarı
 * tarayıcıya asla inmez: sunucu kısa ömürlü bir "client secret" üretir.
 *
 * Neden: bugün Whisper her ses parçasını ayrı bir HTTP isteğiyle yazıya
 * çeviriyor, bu 0.5–1.5 sn ekliyor. Akışlı tanımada kısmi metin ~300 ms'de
 * gelir; mülakatçı cümlesini bitirmeden üretim başlayabilir.
 */

'use strict';

const { requireAuth } = require('../middleware/auth');

// Model adı sabitlenmedi: katalog değişiyor. Ortam değişkeniyle geçersiz
// kılınabilir; hata metni istemciye döner ki körlemesine tahmin etmeyelim.
const MODEL = process.env.REALTIME_STT_MODEL || 'gpt-4o-transcribe';

async function sttRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.post('/session', async (request, reply) => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      return reply.code(503).send({ error: 'realtime_stt_unavailable', reason: 'OPENAI_API_KEY not set' });
    }

    const body = {
      session: {
        type: 'transcription',
        audio: {
          input: {
            format:         { type: 'audio/pcm', rate: 24000 },
            transcription:  { model: MODEL },
            turn_detection: { type: 'server_vad', silence_duration_ms: 500 },
          },
        },
      },
    };

    try {
      const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${key}`,
          'Content-Type': 'application/json',
          'OpenAI-Safety-Identifier': String(request.user?.id || 'anon').slice(0, 64),
        },
        body: JSON.stringify(body),
      });

      const text = await res.text();
      if (!res.ok) {
        fastify.log.warn({ status: res.status, body: text.slice(0, 300) }, '[stt/session] mint failed');
        return reply.code(502).send({
          error: 'realtime_stt_mint_failed', status: res.status,
          detail: text.slice(0, 300), model: MODEL,
        });
      }

      let data; try { data = JSON.parse(text); } catch { data = {}; }
      const secret = data.value || data.client_secret?.value || data.client_secret;
      if (!secret) {
        return reply.code(502).send({ error: 'realtime_stt_no_secret', shape: Object.keys(data).slice(0, 10) });
      }

      return { client_secret: secret, model: MODEL, expires_at: data.expires_at || null };
    } catch (err) {
      fastify.log.error(err, '[stt/session] error');
      return reply.code(500).send({ error: err.message });
    }
  });
}

module.exports = sttRoutes;
