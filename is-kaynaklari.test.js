/**
 * is-kaynaklari.test.js — is ilani kaynaklari ve besleme ayristirma.
 *
 * Calistir: node --test is-kaynaklari.test.js
 *
 * Neden var: 12 Eylul 2026'da uretimde olculdu, "Fetch Listings (All Sites)"
 * butonu HER sorguda "No results found" donuyordu ama ekrana "9 sites
 * scanned" yaziyordu. Taranan site sayisi sifirdi. Ust uste dort ariza:
 *
 *   1. autoapply.js `const auto = window.electronAPI` satirini kendisi
 *      yuklenirken calistiriyor, web taklidi ise daha SONRA yuklenen
 *      dashboard.js'te kuruluyor. Tarayicida `auto` kalici olarak undefined.
 *      Olculdu: searchSite('linkedin') 0 ms'de hata donuyor.
 *   2. Web taklidinde autoExec zaten null donuyor; kazima gercek bir tarayici
 *      penceresi ister, web surumunde yok.
 *   3. Kazima listesi bos olmadigi icin dashboard.js sunucu yedegini
 *      ATLIYORDU. Web'de calisabilecek tek yol, ihtiyac aninda kapaliydi.
 *   4. Sunucu yedegi de bozuktu: Indeed'in RSS beslemesi artik yok, Job
 *      Bank'in koddaki adresi 404 donuyor ve calisan besleme Atom, eski
 *      parseRSS yalnizca <item> ariyor.
 *
 * 4 numarayi gorunmez yapan sey: fetchURL durum kodunu atiyordu, 404 sayfasi
 * basarili bir cevap gibi ayristiriliyor ve sessizce sifir sonuc uretiyordu.
 * Bu yuzden kaynak katmani fetchWithStatus kullanir ve 200 disini hata sayar.
 */

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');

const { parseAtom, parseRSS, stripHTML } = require('./lib/net-feeds.js');
const { searchJobs, SOURCES, tekillestir } = require('./lib/job-sources.js');

// Uretimden birebir alinan gercek Job Bank girdisi (12 Eylul 2026).
const JOBBANK_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>data analyst - Job Bank</title>
<entry>
	<title type="html"><![CDATA[data mining analyst]]></title>
	<link rel="alternate" type="text/html" href="https://www.jobbank.gc.ca/jobsearch/jobposting/50256501"/>
	<id>https://www.jobbank.gc.ca/jobsearch/jobSearchRSSfeed?id=2236599</id>
	<updated>2026-09-09T23:00:00Z</updated>
	<summary type="html"><![CDATA[<strong>Job number:</strong> 2236599<br /><strong>Location:</strong> Saint John (NB)  <br /><strong>Employer:</strong> Cooke Aquaculture Inc.<br /><strong>Salary:</strong> $30.00 to $69.74 hourly]]></summary>
</entry>
<entry>
	<title type="html"><![CDATA[business systems analyst]]></title>
	<link rel="alternate" type="text/html" href="https://www.jobbank.gc.ca/jobsearch/jobposting/50256502"/>
	<updated>2026-09-08T10:00:00Z</updated>
	<summary type="html"><![CDATA[<strong>Location:</strong> Surrey (BC)<br /><strong>Employer:</strong> Acme Ltd.]]></summary>
</entry>
</feed>`;

// ── parseAtom ───────────────────────────────────────────────────────────────

test('A1: Atom girdileri okunuyor, sayi dogru', () => {
  const r = parseAtom(JOBBANK_ATOM);
  assert.strictEqual(r.length, 2);
});

test('A2: baglanti link ETIKETININ METNINDEN degil href OZNITELIGINDEN aliniyor', () => {
  // Eski parseRSS baglantiyi etiket metni olarak okuyordu; Atom'da metin bos,
  // bu yuzden her girdi "title && link" suzgecine takilip dusuyordu.
  const r = parseAtom(JOBBANK_ATOM);
  assert.strictEqual(r[0].link, 'https://www.jobbank.gc.ca/jobsearch/jobposting/50256501');
  assert.ok(r[0].link.length > 0, 'baglanti bos — girdi listeden dusurulur');
});

test('A3: isveren ve konum summary icindeki strong etiketlerinden cikariliyor', () => {
  const r = parseAtom(JOBBANK_ATOM);
  assert.strictEqual(r[0].company,  'Cooke Aquaculture Inc.');
  assert.strictEqual(r[0].location, 'Saint John (NB)');
  assert.strictEqual(r[1].company,  'Acme Ltd.');
  assert.strictEqual(r[1].location, 'Surrey (BC)');
});

test('A4: maas alani okunuyor, yoksa bos kaliyor', () => {
  const r = parseAtom(JOBBANK_ATOM);
  assert.strictEqual(r[0].salary, '$30.00 to $69.74 hourly');
  assert.strictEqual(r[1].salary, '');
});

test('A5: CDATA icindeki baslik duz metin olarak geliyor', () => {
  const r = parseAtom(JOBBANK_ATOM);
  assert.strictEqual(r[0].title, 'data mining analyst');
});

test('A6: rel="alternate" olmayan link de son care olarak kabul ediliyor', () => {
  const xml = '<feed><entry><title>x</title><link href="https://ornek.test/a"/></entry></feed>';
  assert.strictEqual(parseAtom(xml)[0].link, 'https://ornek.test/a');
});

test('A7: eski parseRSS bu beslemeyi OKUYAMIYOR — regresyonun kaniti', () => {
  assert.strictEqual(parseRSS(JOBBANK_ATOM).length, 0,
    'parseRSS Atom okuyabiliyorsa bu testin varlik sebebi kalmaz');
});

test('A8: RSS hala calisiyor, Atom eklemesi onu bozmadi', () => {
  const rss = '<rss><channel><item><title>RSS isi</title><link>https://ornek.test/1</link></item></channel></rss>';
  const r = parseRSS(rss);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].link, 'https://ornek.test/1');
});

// ── searchJobs: kaynak basina durum ─────────────────────────────────────────

function sahteKaynak(sonuc) {
  return async () => {
    if (sonuc instanceof Error) throw sonuc;
    return sonuc;
  };
}

test('B1: anahtar kelime bos ise kullanici hatasi firlatiliyor', async () => {
  await assert.rejects(() => searchJobs({ keywords: '   ' }), (e) => e.kullaniciHatasi === true);
});

test('B2: Adzuna anahtari yoksa kaynak "unconfigured" — sessizce yutulmuyor', async () => {
  const orj = SOURCES.jobbank.ara;
  SOURCES.jobbank.ara = sahteKaynak([]);
  try {
    const r = await searchJobs({ keywords: 'analyst', env: {} });
    const ad = r.sources.find((s) => s.key === 'adzuna');
    assert.strictEqual(ad.status, 'unconfigured');
    assert.match(ad.reason, /ADZUNA_APP_ID/);
  } finally { SOURCES.jobbank.ara = orj; }
});

test('B3: bir kaynak patlarsa digeri sonuc dondurmeye devam ediyor', async () => {
  const oJ = SOURCES.jobbank.ara, oA = SOURCES.adzuna.ara;
  SOURCES.jobbank.ara = sahteKaynak(new Error('HTTP 404'));
  SOURCES.adzuna.ara  = sahteKaynak([{ title: 'Analyst', link: 'https://a.test/1', company: 'X', source: 'Adzuna' }]);
  try {
    const r = await searchJobs({ keywords: 'analyst' });
    assert.strictEqual(r.count, 1, 'saglam kaynak da dusurulmus');
    const jb = r.sources.find((s) => s.key === 'jobbank');
    assert.strictEqual(jb.status, 'error');
    assert.strictEqual(jb.reason, 'HTTP 404');
  } finally { SOURCES.jobbank.ara = oJ; SOURCES.adzuna.ara = oA; }
});

test('B4: sonuc dondurmeyen kaynak "none", donduren "found" ve sayisi dogru', async () => {
  const oJ = SOURCES.jobbank.ara, oA = SOURCES.adzuna.ara;
  SOURCES.jobbank.ara = sahteKaynak([
    { title: 'A', link: 'https://a.test/1' },
    { title: 'B', link: 'https://a.test/2' },
  ]);
  SOURCES.adzuna.ara = sahteKaynak([]);
  try {
    const r = await searchJobs({ keywords: 'analyst' });
    const jb = r.sources.find((s) => s.key === 'jobbank');
    const ad = r.sources.find((s) => s.key === 'adzuna');
    assert.strictEqual(jb.status, 'found');
    assert.strictEqual(jb.count, 2);
    assert.strictEqual(ad.status, 'none');
    assert.strictEqual(ad.count, 0);
  } finally { SOURCES.jobbank.ara = oJ; SOURCES.adzuna.ara = oA; }
});

test('B5: ozet SADECE gercekten sorulan kaynaklari iceriyor', async () => {
  const oJ = SOURCES.jobbank.ara;
  SOURCES.jobbank.ara = sahteKaynak([]);
  try {
    const r = await searchJobs({ keywords: 'analyst', sources: ['jobbank'] });
    assert.strictEqual(r.sources.length, 1, 'sorulmayan kaynak ozette gorunuyor — ekranda uydurma site sayisi cikar');
    assert.strictEqual(r.sources[0].key, 'jobbank');
  } finally { SOURCES.jobbank.ara = oJ; }
});

test('B6: taninmayan kaynak adi sessizce atiliyor, ozette yer almiyor', async () => {
  const oJ = SOURCES.jobbank.ara;
  SOURCES.jobbank.ara = sahteKaynak([]);
  try {
    const r = await searchJobs({ keywords: 'analyst', sources: ['jobbank', 'linkedin'] });
    assert.deepStrictEqual(r.sources.map((s) => s.key), ['jobbank']);
  } finally { SOURCES.jobbank.ara = oJ; }
});

// ── Tekillestirme ───────────────────────────────────────────────────────────

test('C1: ayni baslik ve sirket iki kaynaktan gelirse bir kez listeleniyor', () => {
  const r = tekillestir([
    { title: 'Data Analyst', company: 'Acme', link: 'https://a.test/1' },
    { title: 'data analyst!', company: 'ACME', link: 'https://b.test/2' },
  ]);
  assert.strictEqual(r.length, 1);
});

test('C2: farkli isler birlestirilmiyor', () => {
  const r = tekillestir([
    { title: 'Data Analyst',     company: 'Acme', link: 'https://a.test/1' },
    { title: 'Business Analyst', company: 'Acme', link: 'https://a.test/2' },
  ]);
  assert.strictEqual(r.length, 2);
});

// ── Kaynak listesi kod icinde tek yerde ─────────────────────────────────────

test('D1: kazima tabanli siteler kaynak listesinde YOK', () => {
  // LinkedIn/Indeed/Glassdoor sunucudan taranamiyor. Listede gorunurlerse
  // ekranda "tarandi" yazar ve kullaniciya yalan soyleriz.
  const yasakli = ['linkedin', 'indeed', 'glassdoor', 'ziprecruiter', 'monster'];
  for (const k of yasakli) {
    assert.ok(!Object.prototype.hasOwnProperty.call(SOURCES, k), `${k} kaynak listesinde`);
  }
});

test('D2: Indeed RSS adresi koddan kaldirildi', () => {
  const src = fs.readFileSync(path.join(__dirname, 'lib', 'job-sources.js'), 'utf8');
  assert.ok(!/indeed\.com\/rss/i.test(src), 'Indeed RSS beslemesi artik yok, adres kodda kalmis');
});

test('D3: Job Bank 404 donen eski adresi kullanmiyor', () => {
  const src = fs.readFileSync(path.join(__dirname, 'lib', 'job-sources.js'), 'utf8');
  assert.ok(!/\/rss\/jobsearch\.xml/i.test(src), 'eski 404 donen Job Bank adresi hala kodda');
  assert.ok(/jobsearch\/feed\/jobSearchRSSfeed/.test(src), 'calisan besleme adresi yok');
});

test('D4: stripHTML bos ve null girdide patlamiyor', () => {
  assert.strictEqual(stripHTML(''), '');
  assert.strictEqual(stripHTML(null), 'null');
});
