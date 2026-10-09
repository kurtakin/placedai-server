/**
 * server/routes/olay.js — Donusum olcumu uclari (mount: /api/v1/olay) (K112).
 *
 *   POST /       → tarayicidan olay. Giris ZORUNLU DEGIL (ziyaretci de sayilir).
 *                  text/plain ya da JSON: { olay, ayrinti?, sayfa? }.
 *                  IP basina dakikada MAX_PER_MIN; bot UA sayilmaz. Her zaman
 *                  204 (gecersiz govde 400). IP hicbir yere YAZILMAZ, yalnizca
 *                  bellekteki sinir icin anlik kullanilir.
 *   POST /kayit  → giris yapmis kullanici: hesap son 7 gunde acildiysa bir kez
 *                  'kayit_tamam'. Dashboard her tarayicida bir kez cagirir.
 *
 * Kayit oncesi olaylar kisiye BAGLANMAZ (user_id bos); yalnizca GIRIS_GEREKEN
 * olaylar (masaustu_ilgi) kullaniciya baglanir.
 */
'use strict';

const { optionalAuth, requireAuth } = require('../middleware/auth');
const O = require('../lib/olay');

const MAX_PER_MIN = 30;
const WINDOW_MS   = 60 * 1000;
const _hits = new Map();   // ip -> { count, resetAt }  (yalnizca bellekte)

function rateLimited(ip) {
  const now = Date.now();
  const rec = _hits.get(ip);
  if (!rec || now > rec.resetAt) { _hits.set(ip, { count: 1, resetAt: now + WINDOW_MS }); return false; }
  rec.count += 1;
  return rec.count > MAX_PER_MIN;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of _hits) if (now > rec.resetAt) _hits.delete(ip);
}, 5 * 60 * 1000).unref();

let _sbTest;   // testler icin
function sb() {
  if (_sbTest !== undefined) return _sbTest;
  try { return require('../lib/bot-depo').getSupabase(); } catch { return null; }
}

async function olayRoutes(fastify) {
  fastify.post('/', { preHandler: optionalAuth, bodyLimit: 1024 }, async (request, reply) => {
    if (rateLimited(request.ip) || O.botMu(request.headers['user-agent'])) return reply.code(204).send();
    const o = O.webOlayiAyikla(request.body);
    if (!o) return reply.code(400).send({ error: 'invalid_event' });
    const kisili = O.GIRIS_GEREKEN.has(o.olay);
    if (kisili && !request.user) return reply.code(204).send();
    // Beklemeden yaz: istemci cevabi beklemiyor, olcum hicbir zaman yavaslatmaz.
    O.olayYaz(sb(), { ...o, user: kisili ? request.user : null, log: fastify.log });
    return reply.code(204).send();
  });

  fastify.post('/kayit', { preHandler: requireAuth, bodyLimit: 256 }, async (request, reply) => {
    O.kayitTamam(sb(), request.user, { log: fastify.log });
    return reply.code(204).send();
  });
}

olayRoutes._testSb = (v) => { _sbTest = v; };
olayRoutes._sifirla = () => { _hits.clear(); };
module.exports = olayRoutes;
