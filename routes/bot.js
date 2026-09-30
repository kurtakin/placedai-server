'use strict';

/**
 * server/routes/bot.js — Sunucuda calisan is botunun ayarlari (K81).
 *
 *   GET  /api/v1/bot/ayarlar        kendi ayarlarin (oturum gerekir)
 *   POST /api/v1/bot/ayarlar        ayarlari kaydet; YALNIZCA Ultimate
 *   GET  /api/v1/bot/ilanlar        onay bekleyen ilanlar, en uygun once (K82)
 *   POST /api/v1/bot/ilanlar/:id/durum   goruldu | atlandi | basvuruldu (K82)
 *   GET  /api/v1/bot/eposta-kapat   imzali baglanti: onay sayfasi
 *   POST /api/v1/bot/eposta-kapat   imzali baglanti: ozet e-postalarini kapat
 *
 * POST, PUT degil: CORS yalnizca GET/POST/OPTIONS'a izin veriyor (index.js).
 *
 * E-posta kapatma iki adimli: e-posta guvenlik tarayicilari baglantilari
 * kendiliginden acar (GET). GET durumu degistirseydi kullanici hic
 * tiklamadan e-postalari kapanirdi. GET yalnizca dugmeli bir sayfa gosterir;
 * kapatan POST'tur. Gmail/Yahoo'nun tek tik cikisi (List-Unsubscribe-Post)
 * de ayni POST'a gelir.
 */

const { requireAuth, requirePlan } = require('../middleware/auth');
const depo = require('../lib/bot-depo');
const { ayarTemizle } = require('../lib/bot-profil');
const { kapatmaRotalari, UUID } = require('../lib/eposta-sayfa');
const { BOT } = require('../lib/hata-kodlari');

const AMAC = 'bot_ozet';
const YENIDEN_ARAMA_MS = 60 * 60 * 1000;   // ayar degisince en erken bir saat sonra (kota)
const GORUNUR = ['aktif', 'anahtar_kelime', 'konum', 'sirketler', 'profil', 'eposta_ozet', 'son_arama', 'sonraki_arama', 'son_eposta'];
const ARAMAYI_DEGISTIREN = ['anahtar_kelime', 'konum', 'sirketler'];
// Kullanicinin verebilecegi durumlar; 'yeni'ye geri donulmez.
const ILAN_DURUMLARI = new Set(['goruldu', 'atlandi', 'basvuruldu']);

function gorunur(ayar) {
  if (!ayar) return null;
  return Object.fromEntries(GORUNUR.map((k) => [k, ayar[k] ?? null]));
}

const planOf = (u) => (u && u.id === 'dev-user' ? 'ultimate' : ((u && u.app_metadata && u.app_metadata.plan) || 'free'));

/**
 * Bir sonraki aramanin zamani. Bot yeni acildiysa ya da aramayi degistiren
 * bir ayar degistiyse hemen (bir sonraki turda); ama son aramadan bir saat
 * gecmeden degil: ayari art arda degistirmek Adzuna kotasini yememeli.
 * Degismesi gerekmiyorsa undefined.
 */
function sonrakiArama(once, alanlar, simdi) {
  const aktif = 'aktif' in alanlar ? alanlar.aktif : !!(once && once.aktif);
  if (!aktif) return undefined;
  const yeniAcildi = !once || !once.aktif || !once.sonraki_arama;
  const degisti = ARAMAYI_DEGISTIREN.some((k) => k in alanlar && JSON.stringify(alanlar[k]) !== JSON.stringify(once ? once[k] : undefined));
  if (!yeniAcildi && !degisti) return undefined;
  const son = once && once.son_arama ? Date.parse(once.son_arama) : NaN;
  const t = Number.isFinite(son) ? Math.max(+simdi, son + YENIDEN_ARAMA_MS) : +simdi;
  return new Date(t).toISOString();
}

async function botRoutes(fastify) {
  fastify.get('/ayarlar', { preHandler: requireAuth }, async (request, reply) => {
    const plan = planOf(request.user);
    try {
      const ayar = await depo.ayarOku(request.user.id);
      return { ayarlar: gorunur(ayar), plan_uygun: plan === 'ultimate' };
    } catch (e) {
      request.log.error({ err: e }, '[bot] ayarlar okunamadi');
      return reply.code(503).send({ kod: BOT.KAYDEDILEMEDI, error: 'Bot settings unavailable' });
    }
  });

  fastify.post('/ayarlar', { preHandler: [requireAuth, requirePlan(['ultimate'])] }, async (request, reply) => {
    const t = ayarTemizle(request.body);
    if (t.hata === 'konum_bolge') return reply.code(422).send({ kod: BOT.KONUM_BOLGE, error: 'Location must be a city or region' });
    const alanlar = { ...t.alanlar };
    try {
      const once = await depo.ayarOku(request.user.id);
      const aktif = 'aktif' in alanlar ? alanlar.aktif : !!(once && once.aktif);
      const anahtar = 'anahtar_kelime' in alanlar ? alanlar.anahtar_kelime : (once && once.anahtar_kelime) || '';
      if (aktif && !String(anahtar).trim()) return reply.code(422).send({ kod: BOT.ANAHTAR_BOS, error: 'Keywords required' });
      const sonraki = sonrakiArama(once, alanlar, new Date());
      if (sonraki) alanlar.sonraki_arama = sonraki;
      const kayit = await depo.ayarYaz(request.user.id, alanlar);
      return { ayarlar: gorunur(kayit) };
    } catch (e) {
      request.log.error({ err: e }, '[bot] ayarlar yazilamadi');
      return reply.code(503).send({ kod: BOT.KAYDEDILEMEDI, error: 'Bot settings could not be saved' });
    }
  });

  // ── Onay kuyrugu (K82) ──────────────────────────────────────────────────
  // Plan kapisi yok: plani dusen kullanici da onceden bulunan ilanlarini
  // gorebilmeli ve kapatabilmeli. Yalnizca kendi satirlari (user_id sarti).
  fastify.get('/ilanlar', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const ilanlar = await depo.bekleyenIlanlar(request.user.id);
      return { ilanlar: ilanlar.map(({ id, baslik, sirket, konum, link, kaynak, konum_kademe, durum, bulundu }) =>
        ({ id, baslik, sirket, konum, link, kaynak, konum_kademe, durum, bulundu })) };
    } catch (e) {
      request.log.error({ err: e }, '[bot] ilanlar okunamadi');
      return reply.code(503).send({ kod: BOT.KAYDEDILEMEDI, error: 'Bot listings unavailable' });
    }
  });

  fastify.post('/ilanlar/:id/durum', { preHandler: requireAuth }, async (request, reply) => {
    const id = request.params && request.params.id;
    const durum = request.body && request.body.durum;
    if (!UUID.test(String(id || '')) || !ILAN_DURUMLARI.has(durum)) return reply.code(400).send({ error: 'Invalid listing or status' });
    try {
      const n = await depo.ilanDurumu(request.user.id, id, durum);
      if (!n) return reply.code(404).send({ kod: BOT.ILAN_YOK, error: 'Listing not found' });
      return { id, durum };
    } catch (e) {
      request.log.error({ err: e }, '[bot] ilan durumu yazilamadi');
      return reply.code(503).send({ kod: BOT.KAYDEDILEMEDI, error: 'Listing could not be updated' });
    }
  });

  // E-postalari kapatma sayfalari: ortak (lib/eposta-sayfa.js, K85).
  kapatmaRotalari(fastify, {
    amac: AMAC, log: 'bot', kapat: (u) => depo.epostaKapat(u),
    soru: 'Turn off job bot emails?',
    aciklama: 'You will stop getting the daily job bot summary. The bot keeps finding listings; you can see them on your bot page.',
    bitti: 'You will not get job bot emails anymore.',
  });
}

module.exports = botRoutes;
module.exports.sonrakiArama = sonrakiArama;
module.exports.gorunur = gorunur;
