/**
 * billing-durum.test.js — Kenar cubugundaki plan ve kalan hak kutusu
 * (yol haritasi madde 4, 25 Eylul 2026).
 *
 * Calistir: node --test "*.test.js" "lib/*.test.js" "middleware/*.test.js"
 *
 * /billing/status plani zaten donuyordu; artik iki sayaci da donuyor. Sayac
 * okunamazsa plan yine gitmeli ve kullanim "0" degil null olmali.
 */

const { test } = require('node:test');
const assert   = require('node:assert');

let kullanici = { id: 'u-7', app_metadata: { plan: 'free' } };
require.cache[require.resolve('./middleware/auth')] = {
  id: require.resolve('./middleware/auth'), filename: require.resolve('./middleware/auth'), loaded: true,
  exports: {
    requireAuth: async (req) => { req.user = kullanici; },
    requirePlan: () => async () => {},
    optionalAuth: async () => {},
  },
};
let sayac = { hata: false, cagri: [] };
require.cache[require.resolve('./lib/usage')] = {
  id: require.resolve('./lib/usage'), filename: require.resolve('./lib/usage'), loaded: true,
  exports: {
    getUsage: async (u) => { sayac.cagri.push(['cevap', u.id]); if (sayac.hata) throw new Error('db'); return { plan: 'free', used: 7, limit: 10 }; },
    getLiveUsage: async (u) => { sayac.cagri.push(['canli', u.id]);
      return { plan: 'free', used_seconds: 240, limit_seconds: 600, remaining_seconds: 360, exhausted: false }; },
  },
};

async function durum() {
  const Fastify = require('fastify');
  const app = Fastify({ logger: false });
  await app.register(require('./routes/billing'), { prefix: '/api/v1/billing' });
  await app.ready();
  try {
    const r = await app.inject({ method: 'GET', url: '/api/v1/billing/status' });
    return { kod: r.statusCode, govde: r.json() };
  } finally { await app.close(); }
}

test('B1: durum plani ve iki sayaci donuyor, sayaclar ISTEYEN kullanicinin', async () => {
  sayac = { hata: false, cagri: [] };
  const r = await durum();
  assert.strictEqual(r.kod, 200);
  assert.strictEqual(r.govde.plan, 'free');
  assert.deepStrictEqual(r.govde.usage, {
    answers: { used: 7, limit: 10 },
    live: { used_seconds: 240, limit_seconds: 600, remaining_seconds: 360 },
  });
  assert.deepStrictEqual(sayac.cagri.map((c) => c[1]), ['u-7', 'u-7']);
});

test('B2: sayac okunamazsa plan yine gidiyor, kullanim null (sifir degil)', async () => {
  sayac = { hata: true, cagri: [] };
  const r = await durum();
  assert.strictEqual(r.kod, 200);
  assert.strictEqual(r.govde.plan, 'free');
  assert.strictEqual(r.govde.usage, null);
});
