'use strict';
const assert = require('assert');
const { periodKey } = require('./period');

const D = (s) => new Date(s + 'T00:00:00.000Z');
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('periodKey');

t('ayin 28inde kayit, ayni ay icinde -> pencere 28inde basladi', () => {
  assert.strictEqual(periodKey('2026-08-28', D('2026-08-30')), '2026-08-28');
});

t('ayin 28inde kayit, takvim ayi degisti ama yildonumu gelmedi -> AYNI pencere', () => {
  // Eski kod burada '2026-09' derdi ve kotayi sifirlardi. Asil hata buydu.
  assert.strictEqual(periodKey('2026-08-28', D('2026-09-01')), '2026-08-28');
  assert.strictEqual(periodKey('2026-08-28', D('2026-09-27')), '2026-08-28');
});

t('yildonumu gelince yeni pencere', () => {
  assert.strictEqual(periodKey('2026-08-28', D('2026-09-28')), '2026-09-28');
});

t('ayin 31inde kayit -> Subatta 28e kirpilir', () => {
  assert.strictEqual(periodKey('2026-01-31', D('2027-02-20')), '2027-01-31');
  assert.strictEqual(periodKey('2026-01-31', D('2027-02-28')), '2027-02-28');
});

t('artik yil: Subat 29 vardir', () => {
  assert.strictEqual(periodKey('2024-01-31', D('2024-02-29')), '2024-02-29');
});

t('kirpilan aydan sonra tam gune geri doner', () => {
  assert.strictEqual(periodKey('2026-01-31', D('2027-03-31')), '2027-03-31');
  assert.strictEqual(periodKey('2026-01-31', D('2027-03-30')), '2027-02-28');
});

t('yil siniri: ocak basinda, yildonumu gelmemis -> gecen yilin aralik penceresi', () => {
  assert.strictEqual(periodKey('2026-03-15', D('2027-01-05')), '2026-12-15');
});

t('ayin 1inde kayit -> takvim ayiyla ayni davranir', () => {
  assert.strictEqual(periodKey('2026-05-01', D('2026-08-17')), '2026-08-01');
});

t('demir tarih yoksa eski davranisa duser', () => {
  assert.strictEqual(periodKey(null, D('2026-08-30')), '2026-08');
  assert.strictEqual(periodKey('bozuk-tarih', D('2026-08-30')), '2026-08');
});

t('saat bileseni olan ISO damgasi da calisir', () => {
  assert.strictEqual(periodKey('2026-08-20T05:32:20.401769Z', D('2026-09-19')), '2026-08-20');
});

console.log(`\n${pass} gecti, ${fail} kaldi`);
process.exit(fail ? 1 : 0);
