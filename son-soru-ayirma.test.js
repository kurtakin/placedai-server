/**
 * son-soru-ayirma.test.js — birlesmis metinde modele YALNIZCA son cumle
 * soru olarak veriliyor mu?
 *
 * Calistir: node --test son-soru-ayirma.test.js
 *
 * Neden var: modele "yalnizca son soruyu cevapla" DEMEK yetmedi. 11 Eylul
 * 2026'da uretimde olculdu, profil verildiginde kural tamamen eziliyordu:
 *
 *   "What is your greatest strength? And what is your biggest weakness?"
 *   + profil -> Data-driven forecasting | SAP IBP modeling | Reduced forecast error
 *   uc kosumda da zaaf hic gecmedi.
 *
 * Ayirt edici testte modelin ne yaptigi gorundu: uc ipucunu IKI soruya
 * bolusturuyor.
 *   "Tell me about your forecasting experience. And are you willing to relocate?"
 *   -> SAP IBP statistical modeling | Reduced MAPE significantly | Willing to relocate
 *
 * Sebep: /cues prompt'u uc ipucunun seklini sabitliyor ("acilis, ornek,
 * sonuc") ve "profile dayandir" diyor; eklenen kural bunlarla yarisip
 * kaybediyor. O yuzden ayirmayi BIZ yapiyoruz: model tek soru goruyor,
 * oncesi ayri ve "cevaplama" diye etiketli bir alana gidiyor.
 *
 * SINIR: konusma tanima noktalama uretmezse ayirma tetiklenmez. Bu bir
 * iyilestirme, garanti degil.
 */
'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const { sonSoruyuAyir } = require('./routes/aid.js');
const src = fs.readFileSync(path.join(__dirname, 'routes', 'aid.js'), 'utf8');

// ── Ayirma ─────────────────────────────────────────────────────────────────
test('D: arka arkaya iki soru ayriliyor, son soru SONUNCUSU', () => {
  const r = sonSoruyuAyir('What is your greatest strength? And what is your biggest weakness?');
  assert.strictEqual(r.son,    'And what is your biggest weakness?');
  assert.strictEqual(r.onceki, 'What is your greatest strength?');
});

test('C: nokta ile ayrilan ikinci istek son soru, oncesi baglam', () => {
  const r = sonSoruyuAyir('Tell me about a project you led that succeeded. And then tell me what you would do differently if you had to do it again with half the budget.');
  assert.match(r.son,    /^And then tell me what you would do differently/);
  assert.strictEqual(r.onceki, 'Tell me about a project you led that succeeded.');
});

test('B: tek cumlelik bolunmus soru AYRILMIYOR', () => {
  const t = 'How do you decide what to work on first when everything on your list looks urgent?';
  const r = sonSoruyuAyir(t);
  assert.strictEqual(r.onceki, '', 'tek cumle ayrilmis — bolunmus soru ikiye bolunur, ikisi de anlamsiz');
  assert.strictEqual(r.son, t);
});

test('kisa kuyruk ayrilmiyor ("Right?" gercek soruyu baglama surmemeli)', () => {
  const t = 'Tell me about yourself. Right?';
  const r = sonSoruyuAyir(t);
  assert.strictEqual(r.onceki, '', 'kirpinti ayrilmis — gercek soru baglama dustu, cevap tamamen kaybolur');
  assert.strictEqual(r.son, t);
});

test('ucten fazla cumlede yalnizca SONUNCUSU soru, geri kalani baglam', () => {
  const r = sonSoruyuAyir('Thanks for joining. Let me start simple. What is your biggest weakness?');
  assert.strictEqual(r.son, 'What is your biggest weakness?');
  assert.strictEqual(r.onceki, 'Thanks for joining. Let me start simple.');
});

test('bos ve bozuk girdide cokmez', () => {
  assert.deepStrictEqual(sonSoruyuAyir(''),        { onceki: '', son: '' });
  assert.deepStrictEqual(sonSoruyuAyir(null),      { onceki: '', son: '' });
  assert.deepStrictEqual(sonSoruyuAyir(undefined), { onceki: '', son: '' });
  assert.strictEqual(sonSoruyuAyir('   hi   ').son, 'hi');
});

// ── Iki yol da ayni ayirmayi kullaniyor ────────────────────────────────────
// Biri ayirip digeri ayirmazsa ekrandaki ipuclari ile sesli cevap FARKLI
// soruyu cevaplar. Kullanici bunu fark edemez, iki yol da makul gorunur.
test('/cues yolu ayirmayi kullaniyor ve oncesini baglam diye etiketliyor', () => {
  const i = src.indexOf("post('/cues'");
  assert.notStrictEqual(i, -1, '/cues rotasi bulunamadi');
  const blok = src.slice(i, src.indexOf("post('/stream'", i) > 0 ? src.indexOf("post('/stream'", i) : src.length);
  assert.match(blok, /sonSoruyuAyir\(question\)/, '/cues ayirmayi cagirmiyor');
  assert.match(blok, /Question: "\$\{son\}"/,     '/cues hala tum metni soru olarak gonderiyor');
  assert.match(blok, /context only, do not answer this/i, '/cues oncesini baglam diye etiketlemiyor');
});

test('/stream yolu da ayni ayirmayi kullaniyor', () => {
  const i = src.indexOf("post('/stream'");
  assert.notStrictEqual(i, -1, '/stream rotasi bulunamadi');
  const blok = src.slice(i, i + 6000);
  assert.match(blok, /sonSoruyuAyir\(question\)/, '/stream ayirmayi cagirmiyor');
  assert.match(blok, /\$\{akisSon\}/,             '/stream hala tum metni soru olarak gonderiyor');
  assert.match(blok, /context only, do not answer this/i, '/stream oncesini baglam diye etiketlemiyor');
});
