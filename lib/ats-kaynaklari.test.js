/**
 * lib/ats-kaynaklari.test.js — Greenhouse / Lever / Workable panolari (K65).
 *
 * Calistir: node --test "*.test.js" "lib/*.test.js" "middleware/*.test.js"
 *
 * Sahte cevaplar platformlarin belgelenmis bicimini taklit ediyor; GERCEK
 * bicim Railway'den yoklamayla (`ham_alanlar`) karsilastirilacak. Sirket
 * kodlari uydurma.
 */

const { test } = require('node:test');
const assert   = require('node:assert');
const A = require('./ats-kaynaklari');

function sahte(cevaplar) {
  const istek = [];
  let aktif = 0, enCok = 0;
  const fn = async (url) => {
    istek.push(url);
    aktif++; enCok = Math.max(enCok, aktif);
    await new Promise((r) => setImmediate(r));
    aktif--;
    const c = typeof cevaplar === 'function' ? cevaplar(url) : cevaplar[url];
    if (c instanceof Error) throw c;
    if (!c) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: c.durum < 400, status: c.durum, json: async () => { if (c.bozuk) throw new SyntaxError('x'); return c.govde; } };
  };
  fn.istek = istek; fn.enCok = () => enCok;
  return fn;
}
const GH = (kod) => `https://boards-api.greenhouse.io/v1/boards/${kod}/jobs`;
const LV = (kod, eu) => `https://api${eu ? '.eu' : ''}.lever.co/v0/postings/${kod}?mode=json`;
const WK = (kod) => `https://apply.workable.com/api/v1/widget/accounts/${kod}`;

test('A1: kariyer linkinden platform ve sirket kodu; tanimayan link null (tahmin yok)', () => {
  const t = (l) => A.linktenSirket(l);
  assert.deepStrictEqual(t('https://boards.greenhouse.io/norhaven/jobs/123'), { platform: 'greenhouse', kod: 'norhaven' });
  assert.deepStrictEqual(t('job-boards.greenhouse.io/norhaven'), { platform: 'greenhouse', kod: 'norhaven' });
  assert.deepStrictEqual(t('https://boards.greenhouse.io/embed/job_board?for=norhaven'), { platform: 'greenhouse', kod: 'norhaven' });
  assert.deepStrictEqual(t('https://boards-api.greenhouse.io/v1/boards/norhaven/jobs'), { platform: 'greenhouse', kod: 'norhaven' });
  assert.deepStrictEqual(t('https://jobs.lever.co/kestrel.co/abc-123'), { platform: 'lever', kod: 'kestrel.co' });
  assert.deepStrictEqual(t('https://jobs.eu.lever.co/kestrel'), { platform: 'lever', kod: 'kestrel', bolge: 'eu' });
  assert.deepStrictEqual(t('https://apply.workable.com/ferngrove-1/j/ABC123'), { platform: 'workable', kod: 'ferngrove-1' });
  assert.deepStrictEqual(t('https://ferngrove.workable.com/'), { platform: 'workable', kod: 'ferngrove' });
  for (const k of ['', 'https://ornek.test/jobs', 'https://apply.workable.com/j/ABC', 'https://www.workable.com/x',
    'https://jobs.lever.co/', 'javascript:alert(1)', 'https://boards.greenhouse.io/embed/job_board', 'ftp://jobs.lever.co/x',
    'https://boards.greenhouse.io/%3Cscript%3E']) {
    assert.strictEqual(t(k), null, k);
  }
});

test('A2: Greenhouse ilanlari normallesiyor; baglantisiz ya da https olmayan ilan atiliyor', async () => {
  const f = sahte({ [GH('norhaven')]: { durum: 200, govde: { jobs: [
    { id: 1, title: ' Inventory Analyst ', absolute_url: 'https://boards.greenhouse.io/norhaven/jobs/1', location: { name: 'Burnaby, BC' }, updated_at: '2026-09-20T10:00:00-07:00', company_name: 'Norhaven Supply' },
    { id: 2, title: 'Baglantisiz', location: { name: 'X' } },
    { id: 3, title: 'Duz http', absolute_url: 'http://boards.greenhouse.io/norhaven/jobs/3' },
  ], meta: { total: 3 } } } });
  const r = await A.sirketIlanlari({ platform: 'greenhouse', kod: 'norhaven' }, f);
  assert.strictEqual(r.durum, 'ok');
  assert.deepStrictEqual(r.ilanlar, [{ title: 'Inventory Analyst', link: 'https://boards.greenhouse.io/norhaven/jobs/1',
    company: 'Norhaven Supply', location: 'Burnaby, BC', date: '2026-09-20T17:00:00.000Z', source: 'Greenhouse' }]);
  assert.deepStrictEqual(r.ham_alanlar, ['id', 'title', 'absolute_url', 'location', 'updated_at', 'company_name']);
});

test('A3: Lever (dizi cevap, ms tarih) ve AB bolgesi adresi', async () => {
  const f = sahte({ [LV('kestrel', true)]: { durum: 200, govde: [
    { id: 'a', text: 'Demand Planner', hostedUrl: 'https://jobs.eu.lever.co/kestrel/a', categories: { location: 'Vancouver, BC', team: 'Ops' }, createdAt: 1790000000000 },
  ] } });
  const r = await A.sirketIlanlari({ platform: 'lever', kod: 'kestrel', bolge: 'eu' }, f);
  assert.deepStrictEqual(f.istek, [LV('kestrel', true)]);
  assert.deepStrictEqual(r.ilanlar[0], { title: 'Demand Planner', link: 'https://jobs.eu.lever.co/kestrel/a', company: 'kestrel',
    location: 'Vancouver, BC', date: new Date(1790000000000).toISOString(), source: 'Lever' });
});

test('A4: Workable (hesap adi sirket adi olur, konum parcalardan)', async () => {
  const f = sahte({ [WK('ferngrove')]: { durum: 200, govde: { name: 'Ferngrove Foods', jobs: [
    { title: 'Warehouse Lead', url: 'https://apply.workable.com/ferngrove/j/ABC/', city: 'Surrey', state: 'British Columbia', country: 'Canada', published_on: '2026-09-18' },
  ] } } });
  const r = await A.sirketIlanlari({ platform: 'workable', kod: 'ferngrove' }, f);
  assert.deepStrictEqual(r.ilanlar[0], { title: 'Warehouse Lead', link: 'https://apply.workable.com/ferngrove/j/ABC/', company: 'Ferngrove Foods',
    location: 'Surrey, British Columbia, Canada', date: '2026-09-18T00:00:00.000Z', source: 'Workable' });
});

test('A5: hata turleri ayri: 404 = sirket yok, 5xx / ag / bozuk JSON / beklenmeyen bicim = hata, bos liste = bos', async () => {
  const f = sahte((u) => ({
    [GH('yok1')]: null,
    [GH('cokmus')]: { durum: 503, govde: {} },
    [GH('bozuk')]: { durum: 200, bozuk: true },
    [GH('bicim')]: { durum: 200, govde: { ilanlar: [] } },
    [GH('bos')]: { durum: 200, govde: { jobs: [] } },
    [GH('ag')]: new Error('socket hang up'),
  })[u]);
  const d = async (kod) => { const r = await A.sirketIlanlari({ platform: 'greenhouse', kod }, f); return [r.durum, r.http, r.hata || '']; };
  assert.deepStrictEqual(await d('yok1'), ['yok', 404, '']);
  assert.deepStrictEqual(await d('cokmus'), ['hata', 503, 'HTTP 503']);
  assert.deepStrictEqual(await d('bozuk'), ['hata', 200, 'JSON cozulemedi']);
  assert.deepStrictEqual(await d('bicim'), ['hata', 200, 'beklenmeyen bicim']);
  assert.deepStrictEqual(await d('bos'), ['bos', 200, '']);
  assert.deepStrictEqual(await d('ag'), ['hata', null, 'socket hang up']);
});

test('A6: gecersiz sirket kodu ya da platform icin HIC istek atilmiyor', async () => {
  const f = sahte({});
  for (const s of [{ platform: 'greenhouse', kod: '../x' }, { platform: 'greenhouse', kod: '' }, { platform: 'indeed', kod: 'acme' }, { platform: 'lever', kod: 'a/b' }]) {
    const r = await A.sirketIlanlari(s, f);
    assert.strictEqual(r.durum, 'hata');
  }
  assert.strictEqual(f.istek.length, 0);
});

test('A7: yoklama: ulasilabilirlik platform basina; 404 ULASILDI sayilir, ag hatasi sayilmaz; icerik tasinmiyor', async () => {
  const f = sahte((u) => (u.includes('greenhouse') ? (u.includes('/a1/') ? { durum: 200, govde: { jobs: [{ title: 'T', absolute_url: 'https://g.test/1', location: { name: 'L' }, content: 'GIZLI ACIKLAMA' }] } } : null)
    : u.includes('lever') ? new Error('ECONNRESET')
      : u.includes('/c2') ? { durum: 503, govde: {} } : { durum: 200, govde: { name: 'W', jobs: [] } }));
  let saat = 0;
  const r = await A.yoklama([{ platform: 'greenhouse', kod: 'a1' }, { platform: 'greenhouse', kod: 'a2' },
    { platform: 'lever', kod: 'b1' }, { platform: 'workable', kod: 'c1' }, { platform: 'workable', kod: 'c2' }], f, () => (saat += 5));
  assert.deepStrictEqual(r.platformlar, {
    greenhouse: { toplam: 2, ulasilan: 2, ilanli: 1 },
    lever: { toplam: 1, ulasilan: 0, ilanli: 0 },
    workable: { toplam: 2, ulasilan: 2, ilanli: 0 },   // 503 de bir cevap: sunucuya ulasildi
  });
  assert.deepStrictEqual(r.ozet, { ok: 1, bos: 1, yok: 1, hata: 2 });
  const a1 = r.sonuclar[0];
  assert.deepStrictEqual([a1.durum, a1.adet, a1.ornek], ['ok', 1, { title: 'T', location: 'L', company: 'a1' }]);
  assert.ok(a1.ms > 0);
  assert.ok(!JSON.stringify(r).includes('GIZLI ACIKLAMA'), 'ilan metni yoklama ciktisina tasindi');
  assert.strictEqual(r.sonuclar[2].hata, 'ECONNRESET');
});

test('A8: yoklama listesi verilmezse adaylar; en cok 60 sirket; ayni anda en cok 6 istek', async () => {
  const f = sahte(() => ({ durum: 200, govde: { jobs: [] } }));
  const r = await A.yoklama(undefined, f);
  assert.strictEqual(r.sonuclar.length, A.ADAYLAR.length);
  assert.ok(f.enCok() <= 6 && f.enCok() > 1, String(f.enCok()));
  const f2 = sahte(() => ({ durum: 200, govde: { jobs: [] } }));
  const cok = Array.from({ length: 80 }, (_, i) => ({ platform: 'greenhouse', kod: `s${i}` }));
  assert.strictEqual((await A.yoklama(cok, f2)).sonuclar.length, 60);
  // aday listesi yalnizca bilinen platformlar ve gecerli kodlar
  for (const s of A.ADAYLAR) {
    assert.ok(A.PLATFORMLAR[s.platform], s.platform);
    assert.ok(A.linktenSirket(`https://${s.platform === 'greenhouse' ? 'boards.greenhouse.io' : s.platform === 'lever' ? 'jobs.lever.co' : 'apply.workable.com'}/${s.kod}`), s.kod);
  }
});

test('A9: admin ucu: admin olmayana 403; linkler cozuluyor, taninmayanlar ayrica donuyor', async () => {
  let kullanici = { id: 'u', app_metadata: { role: 'user' } };
  const yolA = require.resolve('../middleware/auth');
  const yolL = require.resolve('./ats-kaynaklari');
  const eskiA = require.cache[yolA], eskiL = require.cache[yolL];
  let gelen = null;
  require.cache[yolA] = { id: yolA, filename: yolA, loaded: true, exports: { requireAuth: async (q) => { q.user = kullanici; } } };
  require.cache[yolL] = { id: yolL, filename: yolL, loaded: true,
    exports: { ...A, yoklama: async (s) => { gelen = s; return { ozet: {}, platformlar: {}, sonuclar: [] }; } } };
  delete require.cache[require.resolve('../routes/admin')];
  const app = require('fastify')({ logger: false });
  await app.register(require('../routes/admin'), { prefix: '/api/v1/admin' });
  await app.ready();
  try {
    assert.strictEqual((await app.inject({ method: 'GET', url: '/api/v1/admin/ats-dogrula' })).statusCode, 403);
    kullanici = { id: 'u', app_metadata: { role: 'admin' } };
    await app.inject({ method: 'GET', url: '/api/v1/admin/ats-dogrula' });
    assert.deepStrictEqual(gelen, []);   // bos: yoklama adaylari kullanir
    const r = await app.inject({ method: 'POST', url: '/api/v1/admin/ats-dogrula',
      payload: { linkler: ['https://jobs.lever.co/kestrel/1', 'https://ornek.test/kariyer'] } });
    assert.deepStrictEqual(gelen, [{ platform: 'lever', kod: 'kestrel' }]);
    assert.deepStrictEqual(r.json().tanimsiz, ['https://ornek.test/kariyer']);
    const r2 = await app.inject({ method: 'POST', url: '/api/v1/admin/ats-dogrula', payload: { linkler: ['https://ornek.test/x'] } });
    assert.strictEqual(r2.statusCode, 422);
  } finally {
    await app.close();
    if (eskiA) require.cache[yolA] = eskiA; else delete require.cache[yolA];
    if (eskiL) require.cache[yolL] = eskiL; else delete require.cache[yolL];
    delete require.cache[require.resolve('../routes/admin')];
  }
});
