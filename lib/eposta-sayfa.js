'use strict';

/**
 * server/lib/eposta-sayfa.js — E-postadaki "bu e-postalari kapat" baglantisinin
 * sayfalari, ORTAK (K81'de routes/bot.js icindeydi; K85'te basvuru
 * hatirlatmasi da kullaniyor).
 *
 * Iki adim: GET yalnizca dugmeli bir sayfa gosterir (e-posta guvenlik
 * tarayicilari baglantilari kendiliginden acar; GET durumu degistirseydi
 * kullanici tiklamadan kapanirdi). Kapatan POST; Gmail/Yahoo tek tik cikisi
 * (List-Unsubscribe-Post) da ayni POST'a gelir. Kimlik adreste, HMAC imzali
 * (lib/eposta-imza.js); imzaya AMAC girer, bir e-posta turunun baglantisi
 * digerini kapatamaz.
 */

const imza = require('./eposta-imza');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * GET ve POST /eposta-kapat rotalarini ekler.
 * @param {import('fastify').FastifyInstance} fastify
 * @param {{amac: string, kapat: (userId: string) => Promise<void>, log: string,
 *          soru: string, aciklama: string, bitti: string}} s
 */
function kapatmaRotalari(fastify, s) {
  // Form govdesinin icerigine ihtiyac yok (kimlik adreste). Eklenti basina bir kez.
  if (!fastify.hasContentTypeParser('application/x-www-form-urlencoded')) {
    fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 },
      (req, govde, done) => done(null, {}));
  }
  const gecerli = (q) => q && typeof q.u === 'string' && UUID.test(q.u) && imza.dogrula(q.u, s.amac, q.t);
  const gecersiz = () => sayfa('Link not valid', `<p>This link is not valid. You can turn off these emails from your <a href="${kacis(PANO())}">PlacedAI dashboard</a>.</p>`);

  fastify.get('/eposta-kapat', async (request, reply) => {
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store');
    if (!gecerli(request.query)) return reply.code(400).send(gecersiz());
    const eylem = `?u=${encodeURIComponent(request.query.u)}&t=${encodeURIComponent(request.query.t)}`;
    return sayfa(s.soru, `<p>${kacis(s.aciklama)}</p>`
      + `<form method="post" action="${kacis(eylem)}"><button type="submit">Turn off emails</button></form>`);
  });

  fastify.post('/eposta-kapat', async (request, reply) => {
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store');
    if (!gecerli(request.query)) return reply.code(400).send(gecersiz());
    try {
      await s.kapat(request.query.u);
    } catch (e) {
      request.log.error({ err: e }, `[${s.log}] e-posta kapatilamadi`);
      return reply.code(503).send(sayfa('Something went wrong', '<p>We could not turn off the emails right now. Please try again in a few minutes.</p>'));
    }
    return sayfa('Emails turned off', `<p>${kacis(s.bitti)} You can turn them back on from your <a href="${kacis(PANO())}">PlacedAI dashboard</a>.</p>`);
  });
}

module.exports = { kapatmaRotalari, sayfa, kacis, PANO, UUID };
