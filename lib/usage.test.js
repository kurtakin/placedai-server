'use strict';
const assert = require('assert');

// Supabase yok: fonksiyonlar dev moduna duser, saf mantigi sinariz.
const { liveSecondsFor, LIVE_MINUTES, planAllows, minPlanFor, FEATURE_PLANS } = require('./plans');
const u = require('./usage');

let pass=0, fail=0;
const t=(n,f)=>{try{f();pass++;console.log('  ok   '+n);}catch(e){fail++;console.log('  FAIL '+n+'\n       '+e.message);}};

console.log('canli kota');

t('plan basina dakika hakki', () => {
  assert.strictEqual(LIVE_MINUTES.free, 10);
  assert.strictEqual(LIVE_MINUTES.pro, 300);
  assert.strictEqual(LIVE_MINUTES.ultimate, 720);
  assert.strictEqual(LIVE_MINUTES.multi, undefined, 'multi kaldirildi');
});

t('saniyeye cevrim', () => {
  assert.strictEqual(liveSecondsFor('free'), 600);
  assert.strictEqual(liveSecondsFor('pro'), 18000);
  assert.strictEqual(liveSecondsFor('ultimate'), 43200);
});

t('kaldirilan multi plani artik free muamelesi goruyor', () => {
  // Kimse o planda degildi; yine de birisi cikarsa guvenli tarafa dusmeli.
  assert.strictEqual(liveSecondsFor('multi'), liveSecondsFor('free'));
  assert.strictEqual(planAllows('multi', 'coding'), false);
});

t('bilinmeyen plan free sayilir', () => {
  assert.strictEqual(liveSecondsFor('bilinmeyen'), 600);
  assert.strictEqual(liveSecondsFor(undefined), 600);
  assert.strictEqual(liveSecondsFor(null), 600);
});

t('kapi: Ultimate ozellikleri sadece Ultimate\'de', () => {
  for (const f of ['performance', 'online-assessment', 'duo-mode', 'botapply']) {
    assert.strictEqual(planAllows('ultimate', f), true,  f + ' ultimate');
    assert.strictEqual(planAllows('pro', f),      false, f + ' pro');
    assert.strictEqual(planAllows('free', f),     false, f + ' free');
  }
});

t('kapi: coding ucretli katmanlarda, free\'de degil', () => {
  assert.strictEqual(planAllows('free', 'coding'),     false);
  assert.strictEqual(planAllows('pro', 'coding'),      true);
  assert.strictEqual(planAllows('ultimate', 'coding'), true);
});

t('haritada olmayan ozellik herkese acik', () => {
  for (const p of ['free', 'pro', 'ultimate']) {
    assert.strictEqual(planAllows(p, 'job-search'), true);
    assert.strictEqual(planAllows(p, 'cover-letter'), true);
    assert.strictEqual(planAllows(p, 'bilinmeyen-sey'), true);
  }
});

t('minPlanFor dogru katmani soyluyor', () => {
  assert.strictEqual(minPlanFor('performance'), 'ultimate');
  assert.strictEqual(minPlanFor('coding'),      'pro');
  assert.strictEqual(minPlanFor('job-search'),  null);
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
