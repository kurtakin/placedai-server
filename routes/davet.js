'use strict';

/**
 * server/routes/davet.js — Arkadas daveti (K89, 1 Ekim 2026).
 *
 *   GET  /api/v1/davet          kendi baglantin ve yalnizca SAYILAR (kim oldugu yok)
 *   POST /api/v1/davet/baglan   {kod}: yeni uye, kendisini davet edene baglanir
 *
 * Kurallar lib/davet.js'te. Kimlik her zaman oturumdan; govdedeki user_id yok sayilir.
 */

const { requireAuth } = require('../middleware/auth');
const davet = require('../lib/davet');
const { getSupabase } = require('../lib/bot-depo');
const { DAVET } = require('../lib/hata-kodlari');

const NEDEN_KODU = {
  kod: DAVET.GECERSIZ, yok: DAVET.GECERSIZ, kendisi: DAVET.KENDISI, eski: DAVET.ESKI, zaten: DAVET.ZATEN, odemis: DAVET.ESKI,
};

async function davetRoutes(fastify) {
  const hata = (request, reply, e, ne) => {
    request.log.error({ err: e }, `[davet] ${ne}`);
    return reply.code(503).send({ kod: DAVET.KAYDEDILEMEDI, error: 'Referrals unavailable' });
  };
  const sb = () => { const s = getSupabase(); if (!s) throw new Error('Supabase tanimli degil'); return s; };

  fastify.get('/', { preHandler: requireAuth }, async (request, reply) => {
    try { return await davet.ozet(sb(), request.user.id); }
    catch (e) { return hata(request, reply, e, 'ozet'); }
  });

  fastify.post('/baglan', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const r = await davet.baglan(sb(), request.user, request.body && request.body.kod);
      if (r.ok) return { ok: true };
      // 4xx: istemci bu kodu bir daha denememeli (saklanan kod silinir).
      return reply.code(r.neden === 'zaten' ? 409 : 422).send({ kod: NEDEN_KODU[r.neden], neden: r.neden });
    } catch (e) { return hata(request, reply, e, 'baglan'); }
  });
}

module.exports = davetRoutes;
