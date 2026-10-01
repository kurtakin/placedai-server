'use strict';

/**
 * server/routes/eposta.js — Pazarlama e-postasi izni (K87, 1 Ekim 2026).
 *
 *   GET  /api/v1/eposta/gonderen          herkese acik: izin isteginde gosterilecek gonderen
 *                                         (ad, posta adresi, iletisim) ya da null
 *   GET  /api/v1/eposta/pazarlama         {izin, karar_verildi, gonderen}
 *   POST /api/v1/eposta/pazarlama         {izin: boolean, kaynak: 'serit' | 'ayarlar'}
 *   GET|POST /api/v1/eposta/eposta-kapat  imzali baglanti: teklif e-postalarini kapat
 *   GET  /api/v1/eposta/geri-kazanma/olcum admin: gonderilen kod / kullanilan (K88)
 *
 * Izin her zaman kullanicinin kendi istegiyle ve kanitla (zaman, kaynak, metin
 * surumu) yazilir; govdedeki user_id yok sayilir. Kayit sirasindaki karar
 * user_metadata'dan ilk okumada tabloya tasinir (lib/pazarlama.js).
 * POSTA_ADRESI yoksa izin VERILEMEZ (istekte posta adresi zorunlu, CRTC
 * SOR/2012-36 m.4); izni geri almak her zaman mumkun.
 */

const { requireAuth } = require('../middleware/auth');
const pazarlama = require('../lib/pazarlama');
const { kapatmaRotalari } = require('../lib/eposta-sayfa');
const { EPOSTA } = require('../lib/hata-kodlari');

async function epostaRoutes(fastify) {
  const hata = (request, reply, e, ne) => {
    request.log.error({ err: e }, `[eposta] ${ne}`);
    return reply.code(503).send({ kod: EPOSTA.KAYDEDILEMEDI, error: 'Email preferences unavailable' });
  };

  fastify.get('/gonderen', async (request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return { gonderen: pazarlama.gonderen() };
  });

  fastify.get('/pazarlama', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const d = await pazarlama.durumOku(request.user);
      return { izin: d.izin, karar_verildi: d.karar_verildi, gonderen: pazarlama.gonderen() };
    } catch (e) { return hata(request, reply, e, 'okunamadi'); }
  });

  fastify.post('/pazarlama', { preHandler: requireAuth }, async (request, reply) => {
    const b = request.body || {};
    if (typeof b.izin !== 'boolean' || !pazarlama.ISTEK_KAYNAKLARI.includes(b.kaynak)) {
      return reply.code(400).send({ kod: EPOSTA.GECERSIZ, error: 'izin: boolean, kaynak: serit | ayarlar' });
    }
    if (b.izin && !pazarlama.gonderen()) {
      return reply.code(409).send({ kod: EPOSTA.KAPALI, error: 'Offer emails are not available yet' });
    }
    try {
      await pazarlama.kararYaz(request.user.id, b.izin, b.kaynak);
      return { izin: b.izin, karar_verildi: true };
    } catch (e) { return hata(request, reply, e, 'yazilamadi'); }
  });

  // Admin (routes/admin.js ile ayni kural): geri kazanma kodlarinin olcumu (K88).
  fastify.get('/geri-kazanma/olcum', {
    preHandler: async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      if (request.user?.app_metadata?.role !== 'admin') return reply.code(403).send({ error: 'Admin access required' });
    },
  }, async (request, reply) => {
    const sb = require('../lib/bot-depo').getSupabase();
    const key = process.env.STRIPE_SECRET_KEY;
    if (!sb || !key) return reply.code(503).send({ error: 'Supabase or Stripe not configured' });
    try {
      const Stripe = require('stripe');
      return await require('../lib/geri-kazanma').olcum({ sb, stripe: new Stripe(key) });
    } catch (e) { return hata(request, reply, e, 'olcum'); }
  });

  kapatmaRotalari(fastify, {
    amac: 'pazarlama', log: 'eposta', kapat: (u) => pazarlama.kararYaz(u, false, 'eposta'),
    soru: 'Unsubscribe from PlacedAI offers?',
    aciklama: 'You will stop getting offer and product news emails. Account emails (like password resets) are not affected.',
    bitti: 'You will not get offer emails anymore.',
  });
}

module.exports = epostaRoutes;
