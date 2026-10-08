/**
 * server/routes/koc.js — AI kariyer kocu (K102, 8 Ekim 2026). Yalnizca Ultimate.
 *
 *   GET  /api/v1/koc/durum   kalan plan ve mesaj hakki
 *   POST /api/v1/koc/plan    kariyer plani (Sonnet), basarida 1 plan hakki
 *   POST /api/v1/koc/sohbet  sohbet (Haiku, SSE), her mesaj 1 hak
 *
 * Hicbir sey saklanmaz: plan istemciye doner, istemci tarayicida tutar.
 * Istemler ve sinirlar: lib/koc.js. Sayaclar: lib/usage.js (ia_usage,
 * koc_plan / koc_mesaj sutunlari, supabase/k102-koc-sayac.sql).
 */
'use strict';

const { Readable } = require('stream');
const { requireAuth, requirePlan } = require('../middleware/auth');
const { createMessage, streamMessage } = require('../lib/ai');
const { sayacOku, sayacKullan } = require('../lib/usage');
const K = require('../lib/koc');

const kapi = [requireAuth, requirePlan(['ultimate'])];

async function kalan(user) {
  const [p, m] = await Promise.all([sayacOku(user, 'koc_plan'), sayacOku(user, 'koc_mesaj')]);
  return {
    plan:  p.used === null ? null : Math.max(0, K.SINIR.plan - p.used),
    mesaj: m.used === null ? null : Math.max(0, K.SINIR.mesaj - m.used),
    sinir: K.SINIR,
  };
}

module.exports = async function kocRoutes(fastify) {
  fastify.get('/durum', { preHandler: kapi }, async (request) => kalan(request.user));

  fastify.post('/plan', { preHandler: kapi }, async (request, reply) => {
    const { cv, tanisma, kartlar, basvurular, language = 'en' } = request.body ?? {};
    const b = K.baglamHazirla({ cv, tanisma, kartlar, basvurular });
    if (!b.ozet.cv) return reply.code(400).send({ error: 'cv_required' });

    // Hak once okunur; sayac yalnizca BASARILI planda artar (model hatasi hak yemesin).
    const once = await sayacOku(request.user, 'koc_plan');
    if (once.used !== null && once.used >= K.SINIR.plan) {
      return reply.code(429).send({ error: 'koc_plan_limit', sinir: K.SINIR.plan });
    }

    let plan;
    try {
      const ham = await createMessage({
        model: 'claude-sonnet',
        max_tokens: 3000,   // K103: + yakin alanlar
        system: K.planIstemi({ language }),
        messages: [{ role: 'user', content: b.metin }],
      });
      plan = K.planAyristir(ham);
    } catch (err) {
      fastify.log.error({ hata: err && err.message }, '[koc/plan] basarisiz');
      return reply.code(502).send({ error: 'koc_plan_failed' });
    }

    await sayacKullan(request.user, 'koc_plan', K.SINIR.plan);
    fastify.log.info({ ...b.ozet, roller: plan.roles.length }, '[koc/plan] tamam');   // icerik loglanmaz
    return { plan, kullanilan: b.ozet, kalan: await kalan(request.user) };
  });

  fastify.post('/sohbet', { preHandler: kapi }, async (request, reply) => {
    const { messages, plan, cv, tanisma, kartlar, basvurular, language = 'en' } = request.body ?? {};
    const mesajlar = K.mesajlariHazirla(messages);
    if (!mesajlar) return reply.code(400).send({ error: 'messages_required' });

    // Sohbette hak once harcanir: akis baslayinca durdurulamaz, kotuye kullanim sinirli kalsin.
    const hak = await sayacKullan(request.user, 'koc_mesaj', K.SINIR.mesaj);
    if (!hak.allowed) return reply.code(429).send({ error: 'koc_mesaj_limit', sinir: K.SINIR.mesaj });

    const b = K.baglamHazirla({ cv, tanisma, kartlar, basvurular });
    const system = K.sohbetIstemi({ plan, baglam: b.metin, language });

    const readable = new Readable({ read() {} });
    const send = (obj) => readable.push(`data: ${JSON.stringify(obj)}\n\n`);
    reply
      .header('Content-Type', 'text/event-stream')
      .header('Cache-Control', 'no-cache')
      .header('Connection', 'keep-alive')
      .header('X-Accel-Buffering', 'no')
      .send(readable);

    streamMessage({
      model: 'claude-haiku',
      max_tokens: 700,
      system,
      messages: mesajlar,
      onToken: (token) => send({ type: 'token', data: token }),
    })
      .then(() => {
        send({ type: 'done', kalan_mesaj: hak.used === null ? null : Math.max(0, K.SINIR.mesaj - hak.used) });
        readable.push(null);
      })
      .catch((err) => {
        fastify.log.error({ hata: err && err.message }, '[koc/sohbet] basarisiz');
        send({ type: 'error', data: 'koc_chat_failed' });
        readable.push(null);
      });
    return reply;   // async isleyicide akis: reply dondurulmeli, yoksa govde bos kapanir
  });
};
