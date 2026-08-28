'use strict';
const assert = require('assert');

// Supabase yok: fonksiyonlar dev moduna duser, saf mantigi sinariz.
const { liveSecondsFor, LIVE_MINUTES } = require('./plans');
const u = require('./usage');

let pass=0, fail=0;
const t=(n,f)=>{try{f();pass++;console.log('  ok   '+n);}catch(e){fail++;console.log('  FAIL '+n+'\n       '+e.message);}};

console.log('canli kota');

t('plan basina dakika hakki', () => {
  assert.strictEqual(LIVE_MINUTES.free, 10);
  assert.strictEqual(LIVE_MINUTES.pro, 300);
  assert.strictEqual(LIVE_MINUTES.ultimate, 720);
});

t('saniyeye cevrim', () => {
  assert.strictEqual(liveSecondsFor('free'), 600);
  assert.strictEqual(liveSecondsFor('pro'), 18000);
  assert.strictEqual(liveSecondsFor('ultimate'), 43200);
});

t('eski multi paketi Pro ile ayni', () => {
  assert.strictEqual(liveSecondsFor('multi'), liveSecondsFor('pro'));
});

t('bilinmeyen plan free sayilir', () => {
  assert.strictEqual(liveSecondsFor('bilinmeyen'), 600);
  assert.strictEqual(liveSecondsFor(undefined), 600);
  assert.strictEqual(liveSecondsFor(null), 600);
});

t('tek nabiz atisinin tavani var', () => {
  assert.strictEqual(u.MAX_HEARTBEAT_SECONDS, 180);
});

(async () => {
  const user = (plan) => ({ id: 'u1', created_at: '2026-08-20T00:00:00Z', app_metadata: { plan } });

  t.async = true;
  const free = await u.getLiveUsage(user('free'));
  t('supabase yokken free kullanicinin hakki dogru', () => {
    assert.strictEqual(free.limit_seconds, 600);
    assert.strictEqual(free.exhausted, false);
  });

  const ult = await u.getLiveUsage(user('ultimate'));
  t('supabase yokken ultimate hakki dogru', () => {
    assert.strictEqual(ult.limit_seconds, 43200);
  });

  console.log(`\n${pass} gecti, ${fail} kaldi`);
  process.exit(fail ? 1 : 0);
})();
