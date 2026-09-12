/**
 * ilan-cikarimi.test.js — bos cikarim basari sayilmasin.
 *
 * Calistir: node --test ilan-cikarimi.test.js
 *
 * Neden var: 12 Eylul 2026, uretimde olculdu. LinkedIn ilan adresi verilince
 * /fetch-job HTTP 200 donuyordu ve icerik suydu:
 *
 *   title: null, company: null, location: null
 *   description: "The provided text contains only CSS styling code and HTML
 *                 reset styles from LinkedIn's web interface. No job listing
 *                 information is present in this content."  (112 karakter)
 *
 * Arayuz "✅ Listing · ·" yaziyordu. Is tanimi kutusuna bu metin doluyordu,
 * 156 karakter, uretim esigi 50, yani kullanici paketi uretebiliyordu.
 * Urettim: ATS 0, CV bos, hata mesaji yok. Kullanici icin bu "program
 * calismiyor" demek, ama ekranda hicbir yerde oyle yazmiyor.
 *
 * Eski koruma GIRDIYE bakiyordu (sayfa metni > 100 karakter). Giris duvari
 * o esigi CSS metniyle geciyor. Artik CIKTIYA bakiyoruz.
 */

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');

const { ilanCikarimiGecerliMi, ASGARI_ACIKLAMA } = require('./lib/job-extract.js');

// Uretimden birebir alinan LinkedIn cevabi
const LINKEDIN = {
  title: null, company: null, location: null,
  description: "The provided text contains only CSS styling code and HTML reset styles from LinkedIn's web interface. No job listing information is present in this content.",
};

// Uretimden birebir alinan Greenhouse cevabi (kismi ama kullanilabilir)
const GREENHOUSE = {
  title: null,
  company: 'Anthropic',
  location: 'Multiple locations including San Francisco CA, New York City NY, London UK',
  description: 'A'.repeat(416),
  requirements: ['a', 'b', 'c', 'd', 'e'],
};

test('A1: LinkedIn giris duvari GECERSIZ sayiliyor', () => {
  const r = ilanCikarimiGecerliMi(LINKEDIN);
  assert.strictEqual(r.gecerli, false, 'bos cikarim hala basari sayiliyor');
  assert.match(r.sebep, /unvan ve sirket/i);
  assert.match(r.oneri, /yapistir/i, 'kullaniciya calisan bir yol onerilmiyor');
});

test('A2: unvan yok ama sirket ve yeterli aciklama varsa GECERLI', () => {
  // Greenhouse ornegi: unvan cikmadi ama CV uyarlamak icin yeterli veri var.
  // Fazla katı olursak calisan durumu da reddederiz.
  assert.strictEqual(ilanCikarimiGecerliMi(GREENHOUSE).gecerli, true);
});

test('A3: tam ilan GECERLI', () => {
  assert.strictEqual(ilanCikarimiGecerliMi({
    title: 'Data Analyst', company: 'ADF Medical', location: 'Vancouver',
    description: 'B'.repeat(900),
  }).gecerli, true);
});

test('A4: unvan var ama aciklama cok kisaysa GECERSIZ', () => {
  const r = ilanCikarimiGecerliMi({ title: 'Data Analyst', company: 'X', description: 'Kisa.' });
  assert.strictEqual(r.gecerli, false);
  assert.match(r.sebep, /cok kisa/i);
  assert.match(r.sebep, /5 karakter/, 'sebep gercek uzunlugu soylemiyor');
});

test('A5: "null" METNI de bos sayiliyor', () => {
  // Model bazen string olarak "null" donduruyor.
  const r = ilanCikarimiGecerliMi({ title: 'null', company: 'NULL', description: 'C'.repeat(900) });
  assert.strictEqual(r.gecerli, false, '"null" metni dolu sanildi');
});

test('A6: bosluk dolu alanlar bos sayiliyor', () => {
  assert.strictEqual(ilanCikarimiGecerliMi({ title: '   ', company: '\t', description: 'D'.repeat(900) }).gecerli, false);
});

test('A7: esigin tam sinirinda davranis belirli', () => {
  const tam = { title: 'X', company: 'Y', description: 'E'.repeat(ASGARI_ACIKLAMA) };
  const bir_eksik = { title: 'X', company: 'Y', description: 'E'.repeat(ASGARI_ACIKLAMA - 1) };
  assert.strictEqual(ilanCikarimiGecerliMi(tam).gecerli, true);
  assert.strictEqual(ilanCikarimiGecerliMi(bir_eksik).gecerli, false);
});

test('A8: bos nesne ve null girdide patlamiyor', () => {
  assert.strictEqual(ilanCikarimiGecerliMi({}).gecerli, false);
  assert.strictEqual(ilanCikarimiGecerliMi(null).gecerli, false);
  assert.strictEqual(ilanCikarimiGecerliMi(undefined).gecerli, false);
});

// ── Uclar denetimi gercekten kullaniyor mu ────────────────────────────────

const TOOLS = fs.readFileSync(path.join(__dirname, 'routes', 'tools.js'), 'utf8');

function ucGovdesi(yol) {
  const bas = TOOLS.indexOf(`fastify.post('${yol}'`);
  assert.ok(bas > 0, `${yol} bulunamadi`);
  const son = TOOLS.indexOf('fastify.post(', bas + 10);
  return TOOLS.slice(bas, son < 0 ? TOOLS.length : son);
}

test('B1: /fetch-job denetimi cagiriyor, SONUCUNA BAKIYOR ve 422 donuyor', () => {
  const g = ucGovdesi('/fetch-job');
  assert.match(g, /ilanCikarimiGecerliMi\(jobData\)/, 'denetim cagrilmiyor');
  // Cagirmak yetmez, sonucuna gore dallanmali. Mutasyon testinde `if (false)`
  // yazdim ve iki test de gecti: cagri da 422 de yerinde duruyordu.
  assert.match(g, /if \(!denetim\.gecerli\)/, 'denetim sonucu KULLANILMIYOR');
  assert.match(g, /reply\.code\(422\)/, 'gecersiz cikarim yine 200 donuyor');
  assert.match(g, /oneri:/, 'kullaniciya calisan yol onerilmiyor');
});

test('B2: /parse-job-text de ayni denetimden geciyor', () => {
  const g = ucGovdesi('/parse-job-text');
  assert.match(g, /ilanCikarimiGecerliMi\(jobData\)/, 'masaustu yolu denetimsiz kalmis');
  assert.match(g, /if \(!denetim2\.gecerli\)/, 'denetim sonucu KULLANILMIYOR');
  assert.match(g, /reply\.code\(422\)/);
});

test('B4: sunucuda kapatilmis dal yok', () => {
  // `if (false && ...)` istemci tarafinda tam bir ozelligi sessizce olduruyordu
  // (Electron ile ilan cekme). Ayni desen sunucuya da girmesin.
  const kapali = [];
  TOOLS.split('\n').forEach((l, i) => {
    if (/if\s*\(\s*false\b/.test(l) && !/\/\//.test(l.split('if')[0])) kapali.push(`${i + 1}: ${l.trim().slice(0, 70)}`);
  });
  assert.deepStrictEqual(kapali, [], `kapatilmis dallar:\n    ${kapali.join('\n    ')}`);
});

test('B3: denetim source_url atanmadan ONCE yapiliyor', () => {
  // Sonra yapilirsa gecersiz veri yine de sekillenip donuyor.
  const g = ucGovdesi('/fetch-job');
  const d = g.indexOf('ilanCikarimiGecerliMi');
  const u = g.indexOf('jobData.source_url');
  assert.ok(d > 0 && u > d, 'denetim cikti sekillendikten sonra yapiliyor');
});

// ── Kod dondurme: metni sunucu degil arayuz yazar ──────────────────────────

test('C1: gecersiz cikarim KOD donduruyor', () => {
  // Sunucu kullanicinin dilini bilmez. Ilk surumde hazir Turkce metin
  // donuyordu ve Ingilizce arayuzde Turkce hata gorunuyordu; kullanicinin
  // ekran goruntusunde yakalandi.
  assert.strictEqual(ilanCikarimiGecerliMi(LINKEDIN).kod, 'ilan_okunamadi');
  assert.strictEqual(ilanCikarimiGecerliMi({ title: 'A', company: 'B', description: 'kisa' }).kod, 'aciklama_kisa');
  assert.strictEqual(ilanCikarimiGecerliMi({ title: 'A', company: 'B', description: 'x'.repeat(300) }).kod, '');
});

test('C2: 422 cevabinda kod alani var', () => {
  for (const yol of ['/fetch-job', '/parse-job-text']) {
    const g = ucGovdesi(yol);
    assert.match(g, /reply\.code\(422\)\.send\(\{ kod:/, `${yol} kod gondermiyor`);
  }
});
