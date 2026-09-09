/**
 * cues-parse.test.js — modelin dusunme metni ipucu diye ekrana cikmasin.
 *
 * Calistir: node --test cues-parse.test.js
 *
 * 9 Eylul 2026'da uretimde olculdu. Model qwen/qwen3.6-27b bir "dusunen"
 * model ve /cues su ucluyu donduruyordu, dort sorunun dordunde de ayni:
 *
 *   ipucu 1: <think>
 *   ipucu 2: Here's a thinking process:
 *   ipucu 3: **Analyze User Input:**
 *
 * Yani mulakat sirasinda kullanicinin ekraninda ipucu yerine bu yaziyordu.
 *
 * Neden gunlerce gorunmedi:
 *   1. Cikti tam uce boluniyor ve uzunluk filtresini geciyor, yani sistem
 *      "uc ipucu urettim" saniyor.
 *   2. /cues yalnizca cues.length === 0 oldugunda alarm veriyor. Uzunluk 3'tu.
 *   3. Olcumlerde hep cues.length ve sureye bakildi, ipuclarinin NE YAZDIGINA
 *      bakilmadi. Hiz olculurken dogruluk kontrol edilmedi.
 *
 * Bos donmek yanlis donmekten iyi: bos donunce overlay Claude akisindaki
 * gercek cevabi bekliyor. Yavas ama dogru.
 */
'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const src   = fs.readFileSync(path.join(__dirname, 'routes', 'aid.js'), 'utf8');
const dilim = src.slice(src.indexOf('const DUSUNME_KALIBI'), src.indexOf('// ── Route'));
assert.ok(dilim.length > 300, 'parseCues blogu aid.js icinde bulunamadi');

const { parseCues, dusunmeMetni } = new Function(
  dilim + '\nreturn { parseCues, dusunmeMetni };'
)();

// ── 1. Uretimde gorulen gercek cikti ────────────────────────────────────────
test('uretimde gorulen dusunme ciktisi ipucu sayilmaz', () => {
  const gercek = "<think>\nHere's a thinking process:\n**Analyze User Input:**";
  assert.deepStrictEqual(parseCues(gercek), [],
    'uretimde kullaniciya gosterilen cikti hala ipucu sayiliyor');
});

test('kapanmamis <think> blogu atiliyor', () => {
  // Token butcesi dusunmeye gidince kapanis etiketi hic gelmiyor.
  assert.deepStrictEqual(parseCues('<think> the user wants three cues so I should'), []);
});

test('kapali <think> blogu atilir, sonrasindaki gercek ipuclari kalir', () => {
  const c = parseCues('<think>hmm let me think about this</think>\nOwn the pivot | Forecast error 32 to 19 | Team stayed aligned');
  assert.deepStrictEqual(c, ['Own the pivot', 'Forecast error 32 to 19', 'Team stayed aligned']);
});

test('gecerli ipuclarindan SONRA gelen think kalintisi ipuclari yok etmez', () => {
  // Kapanmamis <think> atilmazsa, ikinci kontrol metinde <think> gordugu icin
  // hepsini reddeder ve gecerli uc ipucu bosa gider.
  const c = parseCues('Own the pivot | Forecast error 32 to 19 | Team stayed aligned\n<think> wait maybe');
  assert.deepStrictEqual(c, ['Own the pivot', 'Forecast error 32 to 19', 'Team stayed aligned'],
    'sondaki think kalintisi gecerli ipuclarini da sildi');
});

// ── 2. Dusunme kaliplari ───────────────────────────────────────────────────
test('dusunme baslangiclari yakalaniyor', () => {
  for (const t of [
    "Here's a thinking process:",
    "Here's my reasoning: first I need to",
    '**Analyze User Input:** the candidate is',
    '**Deconstruct the request** and then',
    'Okay, so the user wants three cues',
    'Let me think about what matters here',
  ]) {
    assert.ok(dusunmeMetni(t), `dusunme metni yakalanmadi: ${t.slice(0, 40)}`);
    assert.deepStrictEqual(parseCues(t), [], `ipucu olarak gecti: ${t.slice(0, 40)}`);
  }
});

// ── 3. Gercek ipuclari BOZULMAMALI ─────────────────────────────────────────
// Koruma fazla genis olursa gecerli ipuclari da atilir ve hizli yol tamamen
// olur. Yavaslamak kotu, ama sessizce hicbir sey gostermemek daha kotu.
test('gercek ipuclari etkilenmiyor', () => {
  const durumlar = [
    ['Own the pivot | Forecast error 32 to 19 | Team stayed aligned',
      ['Own the pivot', 'Forecast error 32 to 19', 'Team stayed aligned']],
    ['POINTS: Name the tradeoff | Cite the SKU cut | Close with the number',
      ['Name the tradeoff', 'Cite the SKU cut', 'Close with the number']],
    ['- Lead with the decision\n- The data that forced it\n- What changed after',
      ['Lead with the decision', 'The data that forced it', 'What changed after']],
    ['Analyzed three vendors | Chose the cheaper one | Saved 12 percent',
      ['Analyzed three vendors', 'Chose the cheaper one', 'Saved 12 percent']],
  ];
  for (const [girdi, beklenen] of durumlar) {
    assert.deepStrictEqual(parseCues(girdi), beklenen, `bozuldu: ${girdi.slice(0, 40)}`);
  }
});

test('bos ve gecersiz girdi', () => {
  assert.deepStrictEqual(parseCues(''), []);
  assert.deepStrictEqual(parseCues(null), []);
  assert.deepStrictEqual(parseCues('   '), []);
});

// ── 4. Log ayrimi ──────────────────────────────────────────────────────────
// Dusunme metni gecici bir aksaklik degil, model yanlis secilmis demektir.
// Log'da ayirt edilemezse aylarca "bazen bos donuyor" diye gecistirilir.
test('dusunme metni log da ayri isaretleniyor', () => {
  assert.match(src, /MODEL DUSUNME METNI DONDURDU/,
    'dusunme metni ayri loglanmiyor — bos ipucuyla ayni kefeye konur');
  assert.match(src, /fastify\.log\.error\(/,
    'bos ipucu error seviyesinde loglanmiyor');
});
