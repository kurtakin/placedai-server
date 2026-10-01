'use strict';

/**
 * server/routes/yorum.js — Ana sayfa kullanici yorumlari (K86, 1 Ekim 2026).
 *
 *   GET  /api/v1/yorumlar                 yayindakiler (herkese acik; ana sayfa)
 *   GET  /api/v1/yorumlar/benim           kendi yorumun ve durumu
 *   POST /api/v1/yorumlar                 {metin, gorunen_ad, pozisyon, basvuru_id?, izin:true}
 *   POST /api/v1/yorumlar/geri-cek        izni geri al (sayfadan kalkar)
 *   GET  /api/v1/yorumlar/yonetim?durum=  admin: bekliyor | yayinda | reddedildi
 *   POST /api/v1/yorumlar/yonetim/:id     admin: {karar: 'yayinda' | 'reddedildi'}
 *
 * Kullanicinin kararlari (DEVAM.md K86):
 *  * Her yorum yayindan ONCE admin onayindan gecer; admin metni DEGISTIREMEZ.
 *  * Yoruma hicbir odul/indirim baglanmaz.
 *  * Yorum istegi puandan bagimsiz, anketi dolduran herkese gosterilir.
 * Herkese acik uc yalnizca ad ("Ayse K."), pozisyon, metin ve dogrulanmis
 * "ise girdi" isaretini verir: kimlik, e-posta, sirket, basvuru YOK.
 */

const { requireAuth } = require('../middleware/auth');
const depo = require('../lib/yorum-depo');
const alan = require('../lib/yorum-alanlar');
const { YORUM } = require('../lib/hata-kodlari');

const HATA_KODU = {
  izin: YORUM.IZIN, metin_kisa: YORUM.METIN_KISA, metin_uzun: YORUM.METIN_UZUN, iletisim: YORUM.ILETISIM, ad: YORUM.AD,
};
const YONETIM_DURUMLARI = ['bekliyor', 'yayinda', 'reddedildi'];

function benimYaz(r) {
  if (!r) return null;
  return { durum: r.yayin_durumu, metin: r.metin, gorunen_ad: r.gorunen_ad, pozisyon: r.pozisyon || '', created_at: r.created_at };
}

async function yorumRoutes(fastify) {
  const hata = (request, reply, e, ne) => {
    request.log.error({ err: e }, `[yorum] ${ne}`);
    return reply.code(503).send({ kod: YORUM.KAYDEDILEMEDI, error: 'Testimonials unavailable' });
  };

  // Admin: oturum + app_metadata.role === 'admin' (routes/admin.js ile ayni kural).
  const yonetici = async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    if (request.user?.app_metadata?.role !== 'admin') return reply.code(403).send({ error: 'Admin access required' });
  };

  fastify.get('/', async (request, reply) => {
    try {
      const yorumlar = await depo.yayindakiler(12);
      reply.header('Cache-Control', 'public, max-age=300');
      return { yorumlar };
    } catch (e) {
      // Ana sayfa bos listeyle de cizilir; hata kaydedilir.
      request.log.error({ err: e }, '[yorum] yayindakiler okunamadi');
      return reply.code(503).send({ kod: YORUM.KAYDEDILEMEDI, yorumlar: [] });
    }
  });

  fastify.get('/benim', { preHandler: requireAuth }, async (request, reply) => {
    try { return { yorum: benimYaz(await depo.benim(request.user.id)) }; }
    catch (e) { return hata(request, reply, e, 'okunamadi'); }
  });

  fastify.post('/', { preHandler: requireAuth }, async (request, reply) => {
    const t = alan.yorumTemizle(request.body);
    if (t.hata) return reply.code(400).send({ kod: HATA_KODU[t.hata], error: `invalid ${t.hata}` });
    try { return { yorum: benimYaz(await depo.yaz(request.user.id, t.satir)) }; }
    catch (e) { return hata(request, reply, e, 'yazilamadi'); }
  });

  fastify.post('/geri-cek', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const n = await depo.geriCek(request.user.id);
      if (!n) return reply.code(404).send({ kod: YORUM.YOK, error: 'No testimonial to withdraw' });
      return { ok: true };
    } catch (e) { return hata(request, reply, e, 'geri cekilemedi'); }
  });

  fastify.get('/yonetim', { preHandler: yonetici }, async (request, reply) => {
    const durum = YONETIM_DURUMLARI.includes(request.query && request.query.durum) ? request.query.durum : 'bekliyor';
    try { return { durum, yorumlar: await depo.yonetimListesi(durum) }; }
    catch (e) { return hata(request, reply, e, 'yonetim listesi'); }
  });

  fastify.post('/yonetim/:id', { preHandler: yonetici }, async (request, reply) => {
    const id = request.params.id;
    const k = request.body && request.body.karar;
    if (!alan.UUID.test(String(id || '')) || !alan.KARARLAR.includes(k)) {
      return reply.code(400).send({ error: 'id and karar (yayinda | reddedildi) required' });
    }
    try {
      const r = await depo.karar(id, k);
      if (!r) return reply.code(404).send({ kod: YORUM.YOK, error: 'Testimonial not found or withdrawn' });
      return { yorum: { id: r.id, durum: r.yayin_durumu } };
    } catch (e) { return hata(request, reply, e, 'karar yazilamadi'); }
  });
}

module.exports = yorumRoutes;
