/**
 * ilan-siniri.test.js — Ucretsiz planda arama basina 10 ilan (yol haritasi 6, K77).
 *
 * Calistir: node --test ilan-siniri.test.js
 *
 * Kullanicinin karari (27 Eylul 2026): ucretsiz planda arama basina 10 ilan,
 * arama sayisi sinirsiz; ucretli planlar hepsini gorur. Kalan ilanlar
 * gonderilmez, yalnizca sayisi. Plan bilinmiyorsa ucretsiz.
 */
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert');
const { FREE_JOB_LISTINGS, jobListingLimitFor } = require('./lib/plans');
const JS = require('./lib/job-sources');

async function uygulama(kullanici, ilanSayisi) {
  const yolA = require.resolve('./middleware/auth');
  const yolJ = require.resolve('./lib/job-sources');
  const eski = { a: require.cache[yolA], j: require.cache[yolJ] };
  const jobs = Array.from({ length: ilanSayisi }, (_, i) => ({ title: `Ilan ${i + 1}`, link: `https://x.test/${i + 1}`, konum_kademe: 'sehir' }));
  require.cache[yolA] = { id: yolA, filename: yolA, loaded: true, exports: { requireAuth: async (q) => { q.user = kullanici; }, requirePlan: () => async () => {} } };
  require.cache[yolJ] = { id: yolJ, filename: yolJ, loaded: true, exports: { ...JS, searchJobs: async () => ({ jobs, count: jobs.length, gizlenen: 4, sources: [{ key: 'adzuna', count: jobs.length }] }) } };
  delete require.cache[require.resolve('./routes/tools')];
  const app = require('fastify')({ logger: false });
  await app.register(require('./routes/tools'), { prefix: '/api/v1/tools' });
  await app.ready();
  try {
    const r = await app.inject({ method: 'POST', url: '/api/v1/tools/search-jobs', payload: { keywords: 'analyst' } });
    return r.json();
  } finally {
    await app.close();
    if (eski.a) require.cache[yolA] = eski.a; else delete require.cache[yolA];
    if (eski.j) require.cache[yolJ] = eski.j; else delete require.cache[yolJ];
    delete require.cache[require.resolve('./routes/tools')];
  }
}
const kisi = (plan) => ({ id: 'u1', app_metadata: plan === undefined ? {} : { plan } });

test('I1: plan tablosu: ucretsiz 10, ucretli sinirsiz, bilinmeyen/bos ucretsiz', () => {
  assert.strictEqual(FREE_JOB_LISTINGS, 10);
  assert.strictEqual(jobListingLimitFor('free'), 10);
  assert.strictEqual(jobListingLimitFor('pro'), null);
  assert.strictEqual(jobListingLimitFor('ultimate'), null);
  for (const x of [undefined, null, '', 'multi', 'PRO', 'admin']) assert.strictEqual(jobListingLimitFor(x), 10, String(x));
});

test('I2: ucretsiz kullanici 25 ilandan ilk 10\'u aliyor, kalan 15 yalnizca sayi olarak; diger alanlar korunuyor', async () => {
  const d = await uygulama(kisi('free'), 25);
  assert.deepStrictEqual(d.jobs.map((j) => j.title), Array.from({ length: 10 }, (_, i) => `Ilan ${i + 1}`));
  assert.strictEqual(d.kilitli, 15);
  assert.strictEqual(d.ilan_siniri, 10);
  assert.strictEqual(d.gizlenen, 4);
  assert.strictEqual(d.count, 25);
  assert.ok(!JSON.stringify(d).includes('Ilan 11'), 'kilitli ilan cevaba sizdi');
});

test('I3: 10 ya da daha az ilanda kilit yok; ucretli planlar hepsini goruyor', async () => {
  const az = await uygulama(kisi('free'), 7);
  assert.deepStrictEqual([az.jobs.length, az.kilitli, az.ilan_siniri], [7, 0, 10]);
  const tam = await uygulama(kisi('free'), 10);
  assert.deepStrictEqual([tam.jobs.length, tam.kilitli], [10, 0]);
  for (const plan of ['pro', 'ultimate']) {
    const d = await uygulama(kisi(plan), 25);
    assert.deepStrictEqual([d.jobs.length, d.kilitli, d.ilan_siniri], [25, 0, null], plan);
  }
});

test('I4: plani olmayan ya da tanimsiz planli hesap ucretsiz sayiliyor; yerel gelistirme kullanicisi sinirsiz', async () => {
  for (const k of [kisi(undefined), kisi('bilinmeyen'), { id: 'u2' }, null]) {
    const d = await uygulama(k, 25);
    assert.deepStrictEqual([d.jobs.length, d.kilitli], [10, 15], JSON.stringify(k));
  }
  const dev = await uygulama({ id: 'dev-user' }, 25);
  assert.deepStrictEqual([dev.jobs.length, dev.kilitli], [25, 0]);
});
