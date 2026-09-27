/**
 * sirket-panolari.test.js — Sirket panolari aramada; konuma gore siralama (K68).
 *
 * Calistir: node --test "*.test.js" "lib/*.test.js" "middleware/*.test.js"
 *
 * Ag yok: panolar sahte fetch ile. Konumlar K65 yoklamasindaki gercek
 * bicimlerde; ilan basliklari uydurma.
 */

const { test } = require('node:test');
const assert   = require('node:assert');

const JS = require('./lib/job-sources');
const { ONERILEN } = require('./lib/ats-sirketler');

const LV = (kod) => `https://api.lever.co/v0/postings/${encodeURIComponent(kod)}?mode=json`;
const WK = (kod) => `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(kod)}`;

function sahteFetch(harita, varsayilan = 404) {
  const istek = [];
  const fn = async (url) => {
    istek.push(url);
    const c = harita[url];
    if (c instanceof Error) throw c;
    if (!c) return { ok: false, status: varsayilan, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => c };
  };
  fn.istek = istek;
  return fn;
}

const LEVER_ILANLAR = [
  { text: 'Inventory Control Analyst', hostedUrl: 'https://jobs.lever.co/arcteryx.com/1', categories: { location: 'North Vancouver, BC (Corporate)' } },
  { text: 'Senior Inventory Analysts', hostedUrl: 'https://jobs.lever.co/arcteryx.com/2', categories: { location: 'Remote' }, country: 'CA', workplaceType: 'remote' },
  { text: 'Demand Planner', hostedUrl: 'https://jobs.lever.co/arcteryx.com/3', categories: { location: 'North Vancouver, BC (Corporate)' } },
  { text: 'Inventory Analyst', hostedUrl: 'https://jobs.lever.co/arcteryx.com/4', categories: { location: 'Remote - US' } },
  { text: 'Inventory Clerk', hostedUrl: 'https://jobs.lever.co/arcteryx.com/5', categories: { location: 'Surrey, BC' } },
];
const WORKABLE = { name: 'COBS Bread', jobs: [
  { title: 'Inventory Analyst', url: 'https://apply.workable.com/cobs-bread-2/j/A', city: 'Surrey', state: 'British Columbia', country: 'Canada' },
  { title: 'Inventory Analyst - Ontario', url: 'https://apply.workable.com/cobs-bread-2/j/B', city: 'Toronto', state: 'Ontario', country: 'Canada' },
  { title: 'Baker', url: 'https://apply.workable.com/cobs-bread-2/j/C', city: 'Surrey', state: 'British Columbia', country: 'Canada' },
] };
const PANOLAR = { [LV('arcteryx.com')]: LEVER_ILANLAR, [WK('cobs-bread-2')]: WORKABLE };

test('S0: sirket panolari varsayilan kaynaklarda (K65: Railway 31/31 ulasti)', () => {
  assert.ok(JS.VARSAYILAN_KAYNAKLAR.includes('sirketler'));
});

test('S1: anahtar kelimeler baslikta, her kelime bir kelime basinda ("analyst" -> "Analysts"); durak kelimeler yok sayiliyor', () => {
  const ks = JS.kelimeler('Inventory and Analyst');
  assert.deepStrictEqual(ks, ['inventory', 'analyst']);
  assert.strictEqual(JS.basliktaVar('Senior Inventory Analysts', ks), true);
  assert.strictEqual(JS.basliktaVar('Inventory Control Analyst', ks), true);
  assert.strictEqual(JS.basliktaVar('Demand Planner', ks), false);
  assert.strictEqual(JS.basliktaVar('Inventory Clerk', ks), false, 'kelimelerin HEPSI aranmali');
  assert.strictEqual(JS.basliktaVar('Reinventory Catalyst', ks), false, 'kelime ortasinda eslesti');
  assert.strictEqual(JS.basliktaVar('Anything', []), false);
});

test('S2: sirket panolari aramada; Lever adi listeden; baslik suzgeci calisiyor', async () => {
  JS._panoOnbelleginiBosalt();
  const f = sahteFetch(PANOLAR);
  const r = await JS.searchJobs({ keywords: 'inventory analyst', sources: ['sirketler'], fetchFn: f });
  assert.strictEqual(f.istek.length, ONERILEN.length, 'her onerilen pano bir kez sorulmali');
  const basliklar = r.jobs.map((j) => j.title).sort();
  assert.deepStrictEqual(basliklar, ['Inventory Analyst', 'Inventory Analyst', 'Inventory Analyst - Ontario', 'Inventory Control Analyst', 'Senior Inventory Analysts']);
  assert.ok(r.jobs.filter((j) => j.source === 'Lever').every((j) => j.company === "Arc'teryx"));
  const s = r.sources.find((x) => x.key === 'sirketler');
  assert.deepStrictEqual([s.status, s.count, s.reason], ['found', 5, '']);
});

test('S3: pano onbellegi 6 saat; hata veren pano 10 dakika sonra yeniden soruluyor', async () => {
  JS._panoOnbelleginiBosalt();
  const f = sahteFetch({ ...PANOLAR, [WK('now-courier')]: new Error('ECONNRESET') });
  const bir = await JS.SOURCES.sirketler.ara({ keywords: 'analyst', fetchFn: f, simdi: 1000 });
  assert.strictEqual(f.istek.length, ONERILEN.length);
  assert.strictEqual(bir.uyari, `1/${ONERILEN.length} pano okunamadi`, 'kismi ariza gizlendi');
  await JS.SOURCES.sirketler.ara({ keywords: 'analyst', fetchFn: f, simdi: 1000 + 5 * 60e3 });
  assert.strictEqual(f.istek.length, ONERILEN.length, '5 dakikada yeniden soruldu');
  await JS.SOURCES.sirketler.ara({ keywords: 'analyst', fetchFn: f, simdi: 1000 + 11 * 60e3 });
  assert.strictEqual(f.istek.length, ONERILEN.length + 1, 'hatali pano 10 dakika sonra yeniden sorulmadi');
  await JS.SOURCES.sirketler.ara({ keywords: 'analyst', fetchFn: f, simdi: 1000 + 6 * 3600e3 + 1 });
  assert.strictEqual(f.istek.length, 2 * ONERILEN.length + 1, '6 saat dolunca yenilenmedi');
  JS._panoOnbelleginiBosalt();
  const ozet = await JS.searchJobs({ keywords: 'analyst', sources: ['sirketler'], fetchFn: f });
  assert.strictEqual(ozet.sources[0].reason, `1/${ONERILEN.length} pano okunamadi`, 'kismi ariza ozete yazilmadi');
});

test('S4: butun panolar okunamazsa kaynak hata; kullanicinin ekledigi sirket tekrarsiz ekleniyor', async () => {
  JS._panoOnbelleginiBosalt();
  const cokmus = async () => { throw new Error('ag yok'); };
  const r = await JS.searchJobs({ keywords: 'analyst', sources: ['sirketler'], fetchFn: cokmus });
  const s = r.sources[0];
  assert.deepStrictEqual([s.status, s.reason], ['error', `${ONERILEN.length}/${ONERILEN.length} pano okunamadi`]);
  JS._panoOnbelleginiBosalt();
  const f = sahteFetch(PANOLAR);
  const tek = await JS.SOURCES.sirketler.ara({ keywords: 'inventory', fetchFn: f });
  const cift = await JS.SOURCES.sirketler.ara({ keywords: 'inventory', fetchFn: f, ekSirketler: [
    { platform: 'lever', kod: 'kestrel' }, { platform: 'lever', kod: 'ARCTERYX.COM' },
  ] });
  assert.strictEqual(f.istek.length, ONERILEN.length + 1, 'eklenen sirket sorulmadi');
  assert.strictEqual(cift.length, tek.length, 'onerilen sirket kullanici listesinden ikinci kez eklendi');
  // searchJobs de kullanicinin sirketlerini kaynaga iletiyor
  JS._panoOnbelleginiBosalt();
  const f2 = sahteFetch(PANOLAR);
  await JS.searchJobs({ keywords: 'x', sources: ['sirketler'], fetchFn: f2, ekSirketler: [{ platform: 'lever', kod: 'kestrel' }] });
  assert.ok(f2.istek.includes(LV('kestrel')), 'searchJobs kullanicinin sirketini iletmedi');
});

test('S5: konuma gore: yakindan uzaga, uzaklar gizli ve SAYISI donuyor; istenirse hepsi', async () => {
  JS._panoOnbelleginiBosalt();
  const f = sahteFetch(PANOLAR);
  const r = await JS.searchJobs({ keywords: 'inventory analyst', sources: ['sirketler'], fetchFn: f, kullaniciKonumu: 'Surrey, BC' });
  assert.deepStrictEqual(r.jobs.map((j) => [j.title, j.konum_kademe]), [
    ['Inventory Analyst', 'sehir'],
    ['Inventory Control Analyst', 'bolge'],
    ['Senior Inventory Analysts', 'ulke_uzaktan'],
  ]);
  assert.strictEqual(r.gizlenen, 2, 'Toronto ve Remote - US gizlenmeli');
  assert.strictEqual(r.count, 5, 'toplam gizleme ONCESI');
  assert.strictEqual(r.jobs[1].konum_bolge, 'lower_mainland');
  for (const j of r.jobs) assert.ok(!('_yapisal' in j) && !('konum_gorunur' in j), 'ic alan sizdi');
  const hepsi = await JS.searchJobs({ keywords: 'inventory analyst', sources: ['sirketler'], fetchFn: f, kullaniciKonumu: 'Surrey, BC', uzaklariGoster: true });
  assert.strictEqual(hepsi.jobs.length, 5);
  assert.strictEqual(hepsi.gizlenen, 0);
  assert.deepStrictEqual(hepsi.jobs.slice(3).map((j) => j.konum_kademe), ['ulke', 'uzak']);
});

test('S6: kullanici konumu yoksa arama konumu kullaniliyor; ikisi de yoksa gizleme ve siralama yok', async () => {
  JS._panoOnbelleginiBosalt();
  const f = sahteFetch(PANOLAR);
  const r = await JS.searchJobs({ keywords: 'inventory analyst', sources: ['sirketler'], fetchFn: f, location: 'Burnaby, BC' });
  assert.strictEqual(r.gizlenen, 2);
  const yok = await JS.searchJobs({ keywords: 'inventory analyst', sources: ['sirketler'], fetchFn: f });
  assert.strictEqual(yok.gizlenen, 0);
  assert.strictEqual(yok.jobs.length, 5);
  assert.ok(yok.jobs.every((j) => j.konum_kademe === null));
});

test('S7: /search-jobs kullanici konumunu ve "uzaklari goster" secimini iletiyor', async () => {
  const yolA = require.resolve('./middleware/auth');
  const yolJ = require.resolve('./lib/job-sources');
  const eskiA = require.cache[yolA], eskiJ = require.cache[yolJ];
  let gelen = null;
  require.cache[yolA] = { id: yolA, filename: yolA, loaded: true, exports: { requireAuth: async (q) => { q.user = { id: 'u' }; }, requirePlan: () => async () => {} } };
  require.cache[yolJ] = { id: yolJ, filename: yolJ, loaded: true, exports: { ...JS, searchJobs: async (a) => { gelen = a; return { jobs: [], count: 0, gizlenen: 0, sources: [] }; } } };
  delete require.cache[require.resolve('./routes/tools')];
  const app = require('fastify')({ logger: false });
  await app.register(require('./routes/tools'), { prefix: '/api/v1/tools' });
  await app.ready();
  try {
    await app.inject({ method: 'POST', url: '/api/v1/tools/search-jobs', payload: { keywords: 'analyst', location: '', kullanici_konumu: 'Surrey, BC', uzaklari_goster: true } });
    assert.deepStrictEqual([gelen.kullaniciKonumu, gelen.uzaklariGoster], ['Surrey, BC', true]);
    await app.inject({ method: 'POST', url: '/api/v1/tools/search-jobs', payload: { keywords: 'analyst', kullanici_konumu: 42, uzaklari_goster: 'evet' } });
    assert.deepStrictEqual([gelen.kullaniciKonumu, gelen.uzaklariGoster], ['', false]);
  } finally {
    await app.close();
    if (eskiA) require.cache[yolA] = eskiA; else delete require.cache[yolA];
    if (eskiJ) require.cache[yolJ] = eskiJ; else delete require.cache[yolJ];
    delete require.cache[require.resolve('./routes/tools')];
  }
});
