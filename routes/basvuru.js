'use strict';

/**
 * server/routes/basvuru.js — Basvuru Takibi sunucuda (K85, 30 Eylul 2026).
 *
 *   GET  /api/v1/basvurular                 kendi basvurularin + e-posta tercihin
 *   POST /api/v1/basvurular                 {kayitlar:[...]} ekle / tarayicidan tasi
 *   POST /api/v1/basvurular/:id             {durum?, notlar?, sonuc?} guncelle
 *   POST /api/v1/basvurular/:id/sil         sil
 *   POST /api/v1/basvurular/anket           "ise girdim" anketi (yayinlanmaz)
 *   POST /api/v1/basvurular/tercih          {hatirlatma: boolean}
 *   GET|POST /api/v1/basvurular/eposta-kapat  imzali baglanti: hatirlatmalari kapat
 *
 * Butun planlar (kullanicinin karari, K80). Kisi basina en fazla 2000 kayit.
 * POST, PUT/DELETE degil: CORS yalnizca GET/POST/OPTIONS'a izin veriyor.
 * Kullanici kimligi her zaman oturumdan; govdedeki user_id yok sayilir.
 */

const { requireAuth } = require('../middleware/auth');
const depo = require('../lib/basvuru-depo');
const alan = require('../lib/basvuru-alanlar');
const { kapatmaRotalari, UUID } = require('../lib/eposta-sayfa');
const { BASVURU } = require('../lib/hata-kodlari');

const KISI_SINIRI = 2000;
const ISTEK_SINIRI = 500;

function yaz(r) {
  return { id: r.id, istemci_id: r.istemci_id, sirket: r.sirket, pozisyon: r.pozisyon, konum: r.konum, link: r.link,
    basvuru_tarihi: r.basvuru_tarihi, durum: r.durum, sonuc: r.sonuc || null, sonuc_tarihi: r.sonuc_tarihi || null,
    notlar: r.notlar, kaynak: r.kaynak };
}

async function basvuruRoutes(fastify) {
  const hata = (request, reply, e, ne) => {
    request.log.error({ err: e }, `[basvuru] ${ne}`);
    return reply.code(503).send({ kod: BASVURU.KAYDEDILEMEDI, error: 'Applications unavailable' });
  };

  fastify.get('/', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const [liste, tercih] = await Promise.all([depo.liste(request.user.id, KISI_SINIRI), depo.tercihOku(request.user.id)]);
      return { basvurular: liste.map(yaz), tercih: { hatirlatma: tercih.hatirlatma !== false } };
    } catch (e) { return hata(request, reply, e, 'okunamadi'); }
  });

  fastify.post('/', { preHandler: requireAuth }, async (request, reply) => {
    const ham = request.body && Array.isArray(request.body.kayitlar) ? request.body.kayitlar : null;
    if (!ham || ham.length > ISTEK_SINIRI) return reply.code(400).send({ kod: BASVURU.GECERSIZ, error: 'kayitlar: 1-500 records' });
    const gorulen = new Set();
    const satirlar = ham.map((k) => alan.kayitTemizle(k)).filter((k) => {
      if (!k) return false;
      if (k.istemci_id && gorulen.has(k.istemci_id)) return false;
      if (k.istemci_id) gorulen.add(k.istemci_id);
      return true;
    });
    try {
      if (satirlar.length && (await depo.sayi(request.user.id)) + satirlar.length > KISI_SINIRI) {
        return reply.code(422).send({ kod: BASVURU.SINIR, error: `At most ${KISI_SINIRI} applications` });
      }
      const eslesme = await depo.ekle(request.user.id, satirlar);
      return { eslesme, atlanan: ham.length - satirlar.length };
    } catch (e) { return hata(request, reply, e, 'eklenemedi'); }
  });

  fastify.post('/anket', { preHandler: requireAuth }, async (request, reply) => {
    const id = request.body && request.body.basvuru_id;
    if (!UUID.test(String(id || ''))) return reply.code(400).send({ kod: BASVURU.GECERSIZ, error: 'basvuru_id' });
    try {
      const ok = await depo.anketYaz(request.user.id, id, alan.anketTemizle(request.body));
      if (!ok) return reply.code(404).send({ kod: BASVURU.YOK, error: 'Application not found' });
      return { ok: true };
    } catch (e) { return hata(request, reply, e, 'anket yazilamadi'); }
  });

  fastify.post('/tercih', { preHandler: requireAuth }, async (request, reply) => {
    const h = request.body && request.body.hatirlatma;
    if (typeof h !== 'boolean') return reply.code(400).send({ kod: BASVURU.GECERSIZ, error: 'hatirlatma: boolean' });
    try {
      await depo.tercihYaz(request.user.id, { hatirlatma: h });
      return { tercih: { hatirlatma: h } };
    } catch (e) { return hata(request, reply, e, 'tercih yazilamadi'); }
  });

  // Imzali "hatirlatmalari kapat" baglantisi (oturum gerekmez). /:id'den ONCE
  // tanimli olmasi sart degil (fastify statik yolu tercih eder) ama okunur olsun.
  kapatmaRotalari(fastify, {
    amac: 'hatirlatma', log: 'basvuru', kapat: (u) => depo.tercihYaz(u, { hatirlatma: false }),
    soru: 'Turn off application reminders?',
    aciklama: 'You will stop getting the email that asks how an application went. Reminders still appear in your Application Tracker.',
    bitti: 'You will not get application reminder emails anymore.',
  });

  fastify.post('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const id = request.params.id;
    if (!UUID.test(String(id || ''))) return reply.code(400).send({ kod: BASVURU.GECERSIZ, error: 'id' });
    const t = alan.guncellemeTemizle(request.body);
    if (t.hata) return reply.code(400).send({ kod: BASVURU.GECERSIZ, error: `invalid ${t.hata}` });
    try {
      const r = await depo.guncelle(request.user.id, id, t.alanlar);
      if (!r) return reply.code(404).send({ kod: BASVURU.YOK, error: 'Application not found' });
      return { basvuru: yaz(r) };
    } catch (e) { return hata(request, reply, e, 'guncellenemedi'); }
  });

  fastify.post('/:id/sil', { preHandler: requireAuth }, async (request, reply) => {
    const id = request.params.id;
    if (!UUID.test(String(id || ''))) return reply.code(400).send({ kod: BASVURU.GECERSIZ, error: 'id' });
    try {
      const n = await depo.sil(request.user.id, id);
      if (!n) return reply.code(404).send({ kod: BASVURU.YOK, error: 'Application not found' });
      return { ok: true };
    } catch (e) { return hata(request, reply, e, 'silinemedi'); }
  });
}

module.exports = basvuruRoutes;
module.exports.KISI_SINIRI = KISI_SINIRI;
