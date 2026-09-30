'use strict';

/**
 * server/routes/bot.js — Sunucuda calisan is botunun ayarlari (K81).
 *
 *   GET  /api/v1/bot/ayarlar        kendi ayarlarin (oturum gerekir)
 *   POST /api/v1/bot/ayarlar        ayarlari kaydet; YALNIZCA Ultimate
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
const imza = require('../lib/eposta-imza');
const { BOT } = require('../lib/hata-kodlari');

const AMAC = 'bot_ozet';
const YENIDEN_ARAMA_MS = 60 * 60 * 1000;   // ayar degisince en erken bir saat sonra (kota)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GORUNUR = ['aktif', 'anahtar_kelime', 'konum', 'sirketler', 'profil', 'eposta_ozet', 'son_arama', 'sonraki_arama', 'son_eposta'];
const ARAMAYI_DEGISTIREN = ['anahtar_kelime', 'konum', 'sirketler'];

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

function kacis(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sayfa(baslik, govde) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<meta name="robots" content="noindex"><title>${kacis(baslik)}</title>`
    + '<style>body{font-family:Arial,Helvetica,sans-serif;background:#f6f7fb;color:#111;margin:0;padding:48px 16px}'
    + 'main{max-width:460px;margin:0 auto;background:#fff;border-radius:10px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.1)}'
    + 'h1{font-size:20px;margin:0 0 12px}p{line-height:1.5}button{background:#4f46e5;color:#fff;border:0;border-radius:6px;padding:10px 16px;font-size:15px;cursor:pointer}'
    + 'a{color:#4f46e5}</style></head>'
    + `<body><main><h1>${kacis(baslik)}</h1>${govde}</main></body></html>`;
}

const PANO = () => `${String(process.env.APP_URL || 'https://www.placedai.app').replace(/\/+$/, '')}/dashboard`;

async function botRoutes(fastify) {
  // Kapatma formu ve List-Unsubscribe-Post form govdesi gonderir; icerigine
  // ihtiyac yok (kimlik adreste, imzali). Yalnizca bu eklenti icinde gecerli.
  fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 },
    (req, govde, done) => done(null, {}));

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

  const gecerli = (q) => q && typeof q.u === 'string' && UUID.test(q.u) && imza.dogrula(q.u, AMAC, q.t);

  fastify.get('/eposta-kapat', async (request, reply) => {
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store');
    if (!gecerli(request.query)) {
      return reply.code(400).send(sayfa('Link not valid', `<p>This link is not valid. You can turn off bot emails from your <a href="${kacis(PANO())}">PlacedAI dashboard</a>.</p>`));
    }
    const eylem = `?u=${encodeURIComponent(request.query.u)}&t=${encodeURIComponent(request.query.t)}`;
    return sayfa('Turn off job bot emails?',
      '<p>You will stop getting the daily job bot summary. The bot keeps finding listings; you can see them on your bot page.</p>'
      + `<form method="post" action="${kacis(eylem)}"><button type="submit">Turn off emails</button></form>`);
  });

  fastify.post('/eposta-kapat', async (request, reply) => {
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store');
    if (!gecerli(request.query)) {
      return reply.code(400).send(sayfa('Link not valid', `<p>This link is not valid. You can turn off bot emails from your <a href="${kacis(PANO())}">PlacedAI dashboard</a>.</p>`));
    }
    try {
      await depo.epostaKapat(request.query.u);
    } catch (e) {
      request.log.error({ err: e }, '[bot] e-posta kapatilamadi');
      return reply.code(503).send(sayfa('Something went wrong', '<p>We could not turn off the emails right now. Please try again in a few minutes.</p>'));
    }
    return sayfa('Emails turned off', `<p>You will not get job bot emails anymore. You can turn them back on from your <a href="${kacis(PANO())}">PlacedAI dashboard</a>.</p>`);
  });
}

module.exports = botRoutes;
module.exports.sonrakiArama = sonrakiArama;
module.exports.gorunur = gorunur;
