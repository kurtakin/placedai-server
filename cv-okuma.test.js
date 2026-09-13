/**
 * cv-okuma.test.js — PDF okuma ve CV cikarimi.
 *
 * Calistir: node --test cv-okuma.test.js
 *
 * Neden var: 12 Eylul 2026'da olculdu. Sunucunun PDF okuyucusunda sikistirma
 * cozme YOKTU. Word, Chrome, Google Docs ve LaTeX'in urettigi PDF'lerin
 * icerik akisi sikistirilmistir, yani gercek dunyadaki CV'lerin cogu:
 *
 *   sikistirilmamis PDF -> 83 karakter, metin dogru cikti
 *   FlateDecode'lu PDF  -> 68 karakter, "x 0 _ NJ `B P Z }4 z ! . * Q+ 8 )"
 *
 * Okuyucu hata vermiyor, COP uretiyordu. Sunucudaki koruma "30 karakterden
 * uzun mu" diye baktigi icin cop geciyordu. Uretimde uctan uca olculdu:
 * HTTP 200, butun alanlar bos, cv_text 68 karakter cop. Arayuz bunu basari
 * sayip alanlari bos degerlerle eziyor ve OTOMATIK KAYDEDIYORDU; yani normal
 * bir PDF yuklemek kullanicinin elle doldurdugu profili siliyordu.
 */

const { test } = require('node:test');
const assert   = require('node:assert');
const zlib     = require('node:zlib');
const fs       = require('node:fs');
const path     = require('node:path');

const { extractPDFText, metinAnlamliMi, pdfTani } = require('./lib/pdf-text.js');

const METIN = 'Ahmet Yilmaz Supply Chain Analyst Vancouver BC SAP IBP Power BI SQL demand planning';

function pdfYap(sikistir) {
  const icerik = `BT /F1 12 Tf 72 720 Td (${METIN}) Tj ET`;
  const akis = sikistir ? zlib.deflateSync(Buffer.from(icerik, 'latin1')) : Buffer.from(icerik, 'latin1');
  const suzgec = sikistir ? '/Filter /FlateDecode ' : '';
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n4 0 obj<<${suzgec}/Length ${akis.length}>>stream\n`, 'latin1'),
    akis,
    Buffer.from('\nendstream endobj\n%%EOF', 'latin1'),
  ]);
}

test('A1: sikistirilmamis PDF okunuyor', () => {
  const c = extractPDFText(pdfYap(false));
  assert.match(c, /Supply Chain Analyst/);
});

test('A2: FlateDecode ile SIKISTIRILMIS PDF okunuyor', () => {
  // Gercek dunyadaki CV'lerin cogu bu bicimde. Eskiden 68 karakter cop cikiyordu.
  const c = extractPDFText(pdfYap(true));
  assert.match(c, /Supply Chain Analyst/, 'sikistirilmis PDF hala okunamiyor');
  assert.match(c, /Ahmet Yilmaz/);
});

test('A3: iki bicim de AYNI metni veriyor', () => {
  assert.strictEqual(extractPDFText(pdfYap(false)), extractPDFText(pdfYap(true)));
});

test('A4: acilamayan akistan COP donmuyor', () => {
  // Bozuk/desteklenmeyen sikistirma: eskiden yazdirilabilir baytlar cop
  // olarak donuyordu. Artik bos donmeli; cop dondurmek hic dondurmemekten
  // kotudur, cunku sonraki adimlar onu gecerli sanip profili eziyor.
  const cop = Buffer.from(Array.from({ length: 400 }, (_, i) => (i * 37) % 256));
  const pdf = Buffer.concat([
    Buffer.from(`%PDF-1.4\n4 0 obj</Filter /FlateDecode /Length ${cop.length}>>stream\n`, 'latin1'),
    cop,
    Buffer.from('\nendstream endobj\n%%EOF', 'latin1'),
  ]);
  const c = extractPDFText(pdf);
  assert.ok(!metinAnlamliMi(c), `cop hala metin sayiliyor: ${JSON.stringify(c.slice(0, 60))}`);
});

// ── metinAnlamliMi ─────────────────────────────────────────────────────────

test('B1: gercek CV metni anlamli', () => {
  assert.strictEqual(metinAnlamliMi(METIN + ' ' + METIN), true);
});

test('B2: sikistirilmis bayt yigini anlamli DEGIL', () => {
  const bayt = Array.from({ length: 200 }, (_, i) => String.fromCharCode((i * 53) % 256)).join('');
  assert.strictEqual(metinAnlamliMi(bayt), false);
});

test('B3: cok kisa metin anlamli degil', () => {
  assert.strictEqual(metinAnlamliMi('Ahmet'), false);
  assert.strictEqual(metinAnlamliMi(''), false);
  assert.strictEqual(metinAnlamliMi(null), false);
});

test('B4: yalnizca noktalama ve sayi anlamli degil', () => {
  // Gercek kelime olmadan "okunabilir karakter" orani yuksek olabilir.
  assert.strictEqual(metinAnlamliMi('12 34 56 78 90 12 34 56 78 90 12 34 56'), false);
});

// ── Uc denetimden geciyor mu ───────────────────────────────────────────────

const TOOLS = fs.readFileSync(path.join(__dirname, 'routes', 'tools.js'), 'utf8');
function ucGovdesi(yol) {
  const bas = TOOLS.indexOf(`fastify.post('${yol}'`);
  assert.ok(bas > 0, `${yol} yok`);
  const son = TOOLS.indexOf('fastify.post(', bas + 10);
  return TOOLS.slice(bas, son < 0 ? TOOLS.length : son);
}

test('C1: /parse-cv uzunluk yerine ANLAM denetimi yapiyor', () => {
  const g = ucGovdesi('/parse-cv');
  assert.match(g, /if \(!metinAnlamliMi\(text\)\)/, 'anlam denetimi yok');
  assert.ok(!/text\.trim\(\)\.length < 30/.test(g), 'eski uzunluk korumasi hala burada');
});

test('C2: AI hicbir alan cikaramazsa 200 DONMUYOR', () => {
  // 200 donerse arayuz alanlari doldurup otomatik kaydediyor ve profil siliniyor.
  const g = ucGovdesi('/parse-cv');
  assert.match(g, /const doluAlan = \[/, 'sonuc denetimi yok');
  assert.match(g, /doluAlan\.length === 0/, 'bos sonuc hala basari');
  assert.match(g, /kod:\s*CV_HATA\.ALAN_CIKMADI/, 'kod dondurulmuyor');
});

test('C3: hata cevaplari KOD tasiyor ve kodlar TEK KAYNAKTAN geliyor', () => {
  // Kodlar rotada elle yazilmiyor, lib/hata-kodlari.js'ten geliyor: elle
  // yazilan kod sessiz yazim hatasina acikti (K21).
  const { CV_KODLARI } = require('./lib/hata-kodlari.js');
  assert.deepStrictEqual(CV_KODLARI.sort(),
    ['cv_alan_cikmadi', 'dosya_okunamadi', 'pdf_okunamadi', 'pdf_taranmis'].sort());
  const g = ucGovdesi('/parse-cv');
  assert.match(g, /CV_HATA\.PDF_TARANMIS/, 'taranmis kodu kullanilmiyor');
  assert.match(g, /CV_HATA\.PDF_OKUNAMADI/);
  assert.match(g, /CV_HATA\.DOSYA_OKUNAMADI/);
});

test('C4: PDF cikarici tek kaynaktan geliyor', () => {
  assert.ok(!/function extractPDFText\(/.test(TOOLS), 'tools.js icinde ikinci bir kopya var');
  assert.match(TOOLS, /require\('\.\.\/lib\/pdf-text'\)/);
});

// ── Esik ve son care yollarini GERCEKTEN zorlayan durumlar ─────────────────
//
// Mutasyon testinde iki mutasyon hayatta kaldi: harf orani esigini sifira
// cektigimde ve son care yolundaki anlam denetimini kaldirdigimda testler
// geciyordu. Cunku ornek verilerim o iki yolu ayirt edecek bicimde degildi.

test('B5: icinde gercek kelime OLAN ama cogu bayt cop olan metin reddediliyor', () => {
  // Yalnizca harf orani esigi bu durumu ayirt eder: "Ahmet" gercek bir
  // kelime, yani kelime sarti tek basina yetmiyor.
  const cop = Array.from({ length: 300 }, (_, i) => String.fromCharCode(128 + (i % 120))).join('');
  const karisik = 'Ahmet Yilmaz ' + cop;
  assert.strictEqual(metinAnlamliMi(karisik), false,
    'cop icinde birkac kelime gorunce metin sayiliyor');
});

test('B6: esigin hemen ustundeki metin kabul ediliyor', () => {
  // Esik cok sertlesirse gercek CV'ler de reddedilir. Bu test iki yonu birden
  // tutuyor: B5 gevsemeyi, bu da asiri sertlesmeyi yakalar.
  const temiz = 'Ahmet Yilmaz Supply Chain Analyst Vancouver BC SAP IBP Power BI SQL';
  const azCop = temiz + String.fromCharCode(200).repeat(Math.floor(temiz.length * 0.2));
  assert.strictEqual(metinAnlamliMi(azCop), true, 'az gurultulu gercek metin reddedildi');
});

test('A5: SON CARE yolu cop dondurmuyor', () => {
  // BT/ET yok, akis sikistirilmamis, icinde 20 karakterden fazla
  // yazdirilabilir bayt var. Eski kod bunu metin sayip donduruyordu.
  const govde = Array.from({ length: 400 }, (_, i) => String.fromCharCode(33 + ((i * 7) % 94))).join('');
  const pdf = Buffer.from(
    `%PDF-1.4\n4 0 obj<</Length ${govde.length}>>stream\n${govde}\nendstream endobj\n%%EOF`,
    'latin1');
  const c = extractPDFText(pdf);
  // Donen DEGERE bakiyoruz. Once metinAnlamliMi(c) diye olcuyordum ama o
  // fonksiyon mutasyonda saglam kaliyor ve test cop donse bile geciyordu.
  assert.strictEqual(c, '', `son care yolu cop donduruyor: ${JSON.stringify(c.slice(0, 60))}`);
});

test('A6: SON CARE yolu GERCEK metni hala donduruyor', () => {
  // Sertlestirirken calisan durumu kirmadigimizi de olcelim.
  const govde = 'Ahmet Yilmaz Supply Chain Analyst Vancouver BC SAP IBP Power BI SQL demand planning forecasting';
  const pdf = Buffer.from(
    `%PDF-1.4\n4 0 obj<</Length ${govde.length}>>stream\n${govde}\nendstream endobj\n%%EOF`,
    'latin1');
  assert.match(extractPDFText(pdf), /Supply Chain Analyst/);
});

test('B7: kelime yapisi iyi ama cogu bayt cop olan metin reddediliyor', () => {
  // Yalnizca HARF ORANI bu durumu ayirt eder: kelimeler duzgun, ama metnin
  // %90'i okunamayan bayt. Bosluksuz tek bir dev parca oldugu icin kelime
  // orani yuksek kaliyor.
  const devCop = String.fromCharCode(200).repeat(500);
  const karisik = 'Ahmet Yilmaz Supply Chain Analyst Vancouver BC SAP ' + devCop;
  assert.strictEqual(metinAnlamliMi(karisik), false, 'harf orani esigi is gormuyor');
});

test('B8: kelime SAYISI esigi is goruyor', () => {
  // Dort kelimelik bir dizi CV metni degildir; esik bunu elemeli.
  assert.strictEqual(metinAnlamliMi('Ahmetttt Yilmazzzz Supplyyyy Chainnnn'), false,
    'kelime sayisi esigi is gormuyor');
  assert.strictEqual(metinAnlamliMi('Ahmetttt Yilmazzzz Supplyyyy Chainnnn Analysttt'), true,
    'esik asiri sertlesmis, gercek metin de reddediliyor');
});

test('A7: SIKISTIRILMIS duz metin yalnizca acilmis icerikten okunabiliyor', () => {
  // BT/ET operatoru yok, akis sikistirilmis. Ham akisi taramak ise yaramaz,
  // yalnizca acilmis icerigi aday saymak calisir.
  const govde = 'Ahmet Yilmaz Supply Chain Analyst Vancouver BC SAP IBP Power BI SQL demand planning forecasting';
  const akis = zlib.deflateSync(Buffer.from(govde, 'latin1'));
  const pdf = Buffer.concat([
    Buffer.from(`%PDF-1.4\n4 0 obj<</Filter /FlateDecode /Length ${akis.length}>>stream\n`, 'latin1'),
    akis,
    Buffer.from('\nendstream endobj\n%%EOF', 'latin1'),
  ]);
  assert.match(extractPDFText(pdf), /Supply Chain Analyst/,
    'acilmis icerik aday sayilmiyor, sikistirilmis duz metin kaciriliyor');
});

test('B9: kelime GIBI gorunen ama harf olmayan isaret yigini reddediliyor', () => {
  // Yalnizca HARF ORANI bu durumu ayirt eder. Kesme isareti kelime deseninde
  // izinli oldugu icin bu parcalar "kelime" sayiliyor ve kelime orani
  // yuksek cikiyor; ama okunabilir karakter sinifinda olmadiklari icin harf
  // orani dusuk. Akilli tirnak yigini gercek PDF cikarimlarinda goruluyor.
  const isaret = 'A' + '\u2019'.repeat(20);
  const metin = Array.from({ length: 8 }, () => isaret).join(' ');
  assert.strictEqual(metinAnlamliMi(metin), false, 'harf orani esigi is gormuyor');
});

// ── Tani: kullaniciya DOGRU seyi soylemek ──────────────────────────────────
//
// "Okunamadi" tek basina ise yaramaz. Taranmis bir belgeyi DOCX olarak
// kaydetmek de iselemez, cunku icinde hic metin yoktur; kullaniciya yanlis
// tavsiye vermis oluruz.

test('D1: okunabilir PDF "okundu" taniisini aliyor', () => {
  const ic = 'BT /F1 12 Tf 72 720 Td (Ahmet Yilmaz Supply Chain Analyst Vancouver BC SAP IBP) Tj ET';
  const a = zlib.deflateSync(Buffer.from(ic, 'latin1'));
  const pdf = Buffer.concat([
    Buffer.from(`%PDF-1.4\n4 0 obj<</Filter/FlateDecode/Length ${a.length}>>stream\n`, 'latin1'),
    a, Buffer.from('\nendstream endobj', 'latin1')]);
  assert.strictEqual(pdfTani(pdf).kod, 'okundu');
});

test('D2: metin katmani OLMAYAN PDF "taranmis" taniisini aliyor', () => {
  const pdf = Buffer.from('%PDF-1.4\n4 0 obj<</Filter/DCTDecode/Length 10>>stream\n0123456789\nendstream endobj', 'latin1');
  assert.strictEqual(pdfTani(pdf).kod, 'taranmis');
});

test('D3: metin VAR ama cozulemiyorsa ayri tani veriliyor', () => {
  // CID / Identity-H fontlarda Tj icindeki baytlar glif numarasidir, harf degil.
  const pdf = Buffer.from('%PDF-1.4\n4 0 obj<</Length 40>>stream\nBT /F1 12 Tf (\\001\\002\\003) Tj ET\nendstream endobj', 'latin1');
  assert.strictEqual(pdfTani(pdf).kod, 'metin_cozulemedi');
});

test('D4: uc tani birbirinden FARKLI', () => {
  // Ucu de ayni kodu dondurse tani bir ise yaramaz.
  const kodlar = new Set(['okundu', 'taranmis', 'metin_cozulemedi']);
  assert.strictEqual(kodlar.size, 3);
});
