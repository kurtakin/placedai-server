/**
 * yanit-kesilmesi.test.js — "Model olcemedi" ile "biz dinlemeyi kestik"
 * ayri iki hatadir.
 *
 * Calistir: node --test "*.test.js" "lib/*.test.js" "middleware/*.test.js"
 *
 * NEDEN VAR. 18 Eylul 2026'da uretimde olculdu. ATS puani sayfasi gercek bir
 * CV ve gercek bir ilanla "ATS puani hesaplanamadi" dedi. Sebep modelin
 * puan verememesi DEGILDI:
 *
 *   /ats-score max_tokens : 900
 *   gercekci bir TURKCE puan kartinin tuttugu yer : ~815-915 token
 *
 * Yani cevap sinirin tam ustunde duruyordu. Asinca model cumlenin ortasinda
 * kesiliyor, JSON kapanmiyor, `safeParseJSON` null donuyor ve kullaniciya
 * "puan hesaplanamadi" deniyordu. Model puani vermisti; biz dinlemeyi erken
 * kesmistik.
 *
 * Kusuru GORUNMEZ yapan sey `createMessage`'in `stop_reason`'i atmasiydi.
 * Cagiran, cevabin kesildigini bilemiyordu; elinde yalnizca "JSON
 * ayristirilamadi" vardi ve bunu "model beceremedi" diye okuyordu. Yani hata
 * yolunun kendisi teshis edilemiyordu.
 *
 * Bu testler iki seyi kilitler:
 *   1. `stop_reason` cagirana ULASIYOR (davranis, metin degil).
 *   2. Kesilme, /ats-score'da AYRI bir kod donduruyor.
 */

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');

const anthropic = require('./lib/anthropic');
const ai        = require('./lib/ai');
const { ATS, ATS_KODLARI } = require('./lib/hata-kodlari');

const PRACT = fs.readFileSync(path.join(__dirname, 'routes', 'practice.js'), 'utf8');

function yorumsuz(kaynak) {
  return kaynak
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
}

function rotaGovdesi(yol) {
  const bas = PRACT.indexOf(`fastify.post('${yol}'`);
  assert.ok(bas > 0, `${yol} yok`);
  const son = PRACT.indexOf('fastify.post(', bas + 10);
  return yorumsuz(PRACT.slice(bas, son < 0 ? PRACT.length : son));
}

/** Anthropic yanitini taklit eden gecici bir fetch kurar. */
async function sahteYanitla(govde, calistir) {
  const eskiFetch = global.fetch;
  const eskiKey   = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-anahtari-degil-gercek-degil';
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => govde,
    text: async () => JSON.stringify(govde),
  });
  try { return await calistir(); }
  finally {
    global.fetch = eskiFetch;
    if (eskiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = eskiKey;
  }
}

// ── A: stop_reason cagirana ulasiyor (DAVRANIS) ────────────────────────────

test('A1: kesilen yanitta ustveri.kesildi true', async () => {
  const ustveri = {};
  const metin = await sahteYanitla(
    { content: [{ text: '{"score": 72, "grade": "B", "strengths": "Envanter kontrolu' }],
      stop_reason: 'max_tokens',
      usage: { output_tokens: 1600 } },
    () => anthropic.createMessage({ model: 'claude-haiku', max_tokens: 1600, messages: [] }, ustveri),
  );
  assert.strictEqual(ustveri.kesildi, true, 'kesilme cagirana bildirilmiyor');
  assert.strictEqual(ustveri.stop_reason, 'max_tokens');
  assert.strictEqual(ustveri.cikti_token, 1600);
  assert.ok(metin.startsWith('{"score": 72'), 'metin yine de donmeli');
});

test('A2: normal biten yanitta kesildi false', async () => {
  const ustveri = {};
  await sahteYanitla(
    { content: [{ text: '{"score": 72}' }], stop_reason: 'end_turn', usage: { output_tokens: 310 } },
    () => anthropic.createMessage({ model: 'claude-haiku', max_tokens: 1600, messages: [] }, ustveri),
  );
  assert.strictEqual(ustveri.kesildi, false, 'normal yanit kesilmis sayiliyor');
  assert.strictEqual(ustveri.stop_reason, 'end_turn');
});

test('A3: ustveri VERILMEZSE eski cagiranlar aynen calisir', async () => {
  // Bu yuzden ikinci parametre secildi: 20'den fazla cagiran var ve hicbiri
  // degismek zorunda kalmamali.
  const metin = await sahteYanitla(
    { content: [{ text: 'merhaba' }], stop_reason: 'end_turn' },
    () => anthropic.createMessage({ model: 'claude-haiku', max_tokens: 10, messages: [] }),
  );
  assert.strictEqual(metin, 'merhaba');
});

test('A4: ai.js ustveriyi ILETIYOR, yutmuyor', async () => {
  // Rotalar anthropic.js'i degil ai.js'i cagiriyor. Aradaki katman ustveriyi
  // gecirmezse butun zincir sessizce ise yaramaz hale gelir.
  const ustveri = {};
  await sahteYanitla(
    { content: [{ text: 'yarim' }], stop_reason: 'max_tokens', usage: { output_tokens: 900 } },
    () => ai.createMessage({ model: 'claude-haiku', max_tokens: 900, messages: [] }, ustveri),
  );
  assert.strictEqual(ustveri.kesildi, true, 'ai.js ustveriyi gecirmiyor');
});

// ── B: /ats-score kesilmeyi AYRI hata sayiyor ──────────────────────────────

test('B1: kesilme icin ayri bir kod var', () => {
  assert.strictEqual(ATS.YANIT_KESILDI, 'ats_yanit_kesildi');
  assert.ok(ATS_KODLARI.includes('ats_yanit_kesildi'));
  assert.notStrictEqual(ATS.YANIT_KESILDI, ATS.HESAPLANAMADI,
    'kesilme ile olcememe ayni koda baglanmis');
});

test('B2: rota ustveri okuyor ve kesilmeyi ayirt ediyor', () => {
  const g = rotaGovdesi('/ats-score');
  assert.match(g, /const ustveri = \{\};/, 'ustveri nesnesi yok');
  assert.match(g, /\}, ustveri\);/, 'ustveri createMessage\'e gecirilmiyor');
  assert.match(g, /if \(!result && ustveri\.kesildi\)/, 'kesilme ayirt edilmiyor');
  assert.match(g, /ATS_HATA\.YANIT_KESILDI/, 'kesilme icin ayri kod dondurulmuyor');

  // Kesilme denetimi, genel "puan gecersiz" denetiminden ONCE olmali; sonra
  // olsaydi kesilen cevap yine "hesaplanamadi" diye raporlanirdi.
  assert.ok(g.indexOf('ustveri.kesildi') < g.indexOf('ATS_HATA.HESAPLANAMADI'),
    'kesilme denetimi gec kaliyor');
});

test('B3: hata yolu TESHIS EDILEBILIR, ama ICERIK degil SEKIL yaziyor', () => {
  // Kusuru bulmak bir gunu aldi, cunku gunluge yalnizca `hamPuan` yaziliyordu
  // ve `result` null oldugunda o alan her zaman undefined dusuyordu. Modelin
  // NE dondurdugu kayboluyordu.
  //
  // ILK DUZELTMEM YANLISTI. Ham metnin ilk 200 karakterini gunluge koydum;
  // lib/logging.test.js bunu reddetti ve haklyydi: modelin ciktisi
  // kullanicinin CV'sinden turetiliyor, adini ve isverenini tasiyabilir.
  // "Modelin ciktisi, kisisel veri degil" diye dusunmustum; yanlisti.
  //
  // Teshis icin gereken sey zaten icerik degil SEKIL. Uc alan dort durumu
  // ayirir: bos cevap, duz cumle, kesilmis JSON, gecerli JSON + kotu puan.
  //
  // Ikinci bir ders: ilk surum "alan kaynakta geciyor mu" diye soruyordu.
  // Mutasyonda IKI gunluk satirindan BIRINDEN silmek hicbir testi dusurmedi.
  // Artik iki dal AYRI AYRI denetleniyor.
  const g = rotaGovdesi('/ats-score');

  const dal = (etiket) => {
    const son = g.indexOf(etiket);
    assert.ok(son > 0, `gunluk satiri yok: ${etiket}`);
    const bas = g.lastIndexOf('fastify.log.', son);
    assert.ok(bas > 0 && bas < son, `gunluk cagrisi bulunamadi: ${etiket}`);
    return g.slice(bas, son);
  };

  assert.match(g, /hamChars:\s+hamMetin\.length/, 'cevabin uzunlugu hesaplanmiyor');
  assert.match(g, /susluBasliyor: \/\^\\s\*\\\{\/\.test\(hamMetin\)/, 'baslangic sekli olculmuyor');
  assert.match(g, /susluBitiyor:  \/\\\}\\s\*\$\/\.test\(hamMetin\)/, 'bitis sekli olculmuyor');

  const kesik = dal("'[ats-score] yanit kesildi'");
  assert.match(kesik, /\.\.\.hamSekli/, 'kesilme dalinda sekil yazilmiyor');
  assert.match(kesik, /cikti_token: ustveri\.cikti_token/, 'kesilme dalinda token sayisi yok');

  const gecersiz = dal("'[ats-score] puan gecersiz'");
  assert.match(gecersiz, /\.\.\.hamSekli/, 'gecersiz puan dalinda sekil yazilmiyor');
  assert.match(gecersiz, /stop_reason:\s+ustveri\.stop_reason/, 'gecersiz puan dalinda stop_reason yok');
  assert.match(gecersiz, /ayristirildi: Boolean\(result\)/, 'ayristirmanin sonucu yazilmiyor');
});

test('B4: gunluge kullanici metni GIRMIYOR', () => {
  // Bu testin gorevi B3'un tersini korumak. B3 "yeterince bilgi yaz" diyor;
  // bu da "fazlasini yazma" diyor. Ikisi olmadan biri digerine kayar.
  const g = rotaGovdesi('/ats-score');
  const gunlukler = [...g.matchAll(/fastify\.log\.\w+\(([\s\S]{0,300}?)\)\s*;/g)].map((m) => m[1]);
  assert.ok(gunlukler.length >= 2, `gunluk cagrisi bulunamadi (${gunlukler.length})`);
  for (const args of gunlukler) {
    const alanlar = args.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '');
    assert.ok(!/\braw\b/.test(alanlar), `ham cevap gunluge giriyor: ${args.slice(0, 80)}`);
    assert.ok(!/\bcv_text\b|\bjob_description\b/.test(alanlar),
      `kullanici metni gunluge giriyor: ${args.slice(0, 80)}`);
  }
});

// ── C: butce ve ciktinin sinirlanmasi ──────────────────────────────────────

test('C1: token butcesi 900\'un uzerine cikti', () => {
  const g = rotaGovdesi('/ats-score');
  const m = /max_tokens: (\d+)/.exec(g);
  assert.ok(m, 'max_tokens bulunamadi');
  assert.ok(Number(m[1]) >= 1400, `butce ${m[1]}, Turkce cevap icin dar`);
});

test('C2: butce TEK BASINA duzeltme sayilmiyor: cikti da sinirli', () => {
  // Sinirsiz buyuyebilen bir cikti her butceyi bir gun asar. Istem, listeleri
  // ve cumle sayisini bagliyor; butce ona pay birakiyor.
  const bas = PRACT.indexOf('const ATS_SYSTEM');
  const istem = PRACT.slice(bas, PRACT.indexOf('const RESUME_SYSTEM', bas)).split('`')[1] || '';
  assert.match(istem, /LENGTH LIMITS/, 'uzunluk siniri bolumu yok');
  assert.match(istem, /At most 10 entries in "matched_keywords"/, 'liste uzunlugu baglanmamis');
  assert.match(istem, /at most 2 sentences each/, 'cumle sayisi baglanmamis');
  assert.match(istem, /Exactly 3 entries in "top_recommendations", each under 30 words/,
    'oneri uzunlugu baglanmamis');
});

test('C3: olcum kayitli: 900 neden yetmiyordu', () => {
  // Bu test bir SAYIYI degil, GEREKCEYI kilitler. Gerekce kaybolursa biri
  // "1600 fazla" deyip geri dusurur ve hata geri gelir.
  const g = PRACT.slice(PRACT.indexOf("fastify.post('/ats-score'"));
  assert.match(g, /900 idi/, 'eski butce kayitli degil');
  assert.match(g, /815-915 token/, 'olcum kayitli degil');
});
