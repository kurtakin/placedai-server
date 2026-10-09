/**
 * olay.test.js — Donusum olcumu (K112, Asama 2, 9 Ekim 2026).
 *
 * Calistir: node --test olay.test.js
 *
 * Kilitlenenler:
 *   OL1 yalnizca izinli olay adlari; sayfa yalnizca yol (sorgu atilir)
 *   OL2 kayit oncesi olaylar kisiye baglanmaz; masaustu_ilgi yalnizca girisle
 *   OL3 bot UA ve hiz siniri sayilmaz; gecersiz govde 400; text/plain kabul
 *   OL4 olayYaz asla firlatmaz; tek seferlik tekrar sessiz
 *   OL5 kayit_tamam yalnizca son 7 gunde acilan hesap
 *   OL6 ilk_canli yalnizca olcumden sonra kayit olan, bir kez, surec basina bir sorgu
 *   OL7 IP, e-posta ya da UA hicbir satira yazilmaz; sunucuya baglanti noktalari yerinde
 */
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');
const O = require('./lib/olay');

const UID = '11111111-2222-4333-8444-555555555555';
const sessiz = { warn() {}, info() {}, error() {} };

/** insert / select cagrilarini kaydeden sahte Supabase. */
function sahteSb({ insertHata = null, secim = [] } = {}) {
  const yazilan = [];
  const sorgu = [];
  return {
    yazilan, sorgu,
    from(tablo) {
      return {
        insert: async (satir) => { yazilan.push({ tablo, satir }); return { error: insertHata }; },
        select() {
          const z = { eq: () => z, in: () => z, then: (ok) => { sorgu.push(tablo); return Promise.resolve({ data: secim, error: null }).then(ok); } };
          return z;
        },
      };
    },
  };
}
const bekle = () => new Promise((r) => setImmediate(r));

test('OL1: yalnizca izinli olaylar; sayfa yalnizca yol; ayrinti kisa ve sade', () => {
  assert.deepStrictEqual(O.webOlayiAyikla('{"olay":"ana_sayfa","sayfa":"/?email=a@b.c","ayrinti":"hero"}'), { olay: 'ana_sayfa', ayrinti: 'hero', sayfa: '/' });
  assert.strictEqual(O.webOlayiAyikla({ olay: 'satin_alma' }), null, 'tarayici satin alma yazamaz');
  assert.strictEqual(O.webOlayiAyikla({ olay: 'kayit_tamam' }), null);
  assert.strictEqual(O.webOlayiAyikla({ olay: 'baska' }), null);
  assert.strictEqual(O.webOlayiAyikla('bozuk json'), null);
  assert.strictEqual(O.webOlayiAyikla('x'.repeat(600)), null);
  assert.strictEqual(O.webOlayiAyikla([1]), null);
  assert.strictEqual(O.webOlayiAyikla({ olay: 'ana_sayfa', ayrinti: 'Ad Soyad <a@b.c>' }).ayrinti, null);
  assert.strictEqual(O.temizSayfa('/download#x'), '/download');
  assert.strictEqual(O.temizSayfa('https://evil.test/'), null);
  assert.strictEqual(O.temizSayfa('/' + 'a'.repeat(200)).length, 80);
  for (const o of O.SUNUCU_OLAYLARI) assert.ok(!O.WEB_OLAYLARI.has(o), `${o} tarayicidan gelemez`);
});

test('OL4: olayYaz asla firlatmaz; tekrar (23505) sessiz; satirda IP/e-posta yok', async () => {
  const sb = sahteSb();
  assert.strictEqual(await O.olayYaz(sb, { olay: 'odeme_basladi', ayrinti: 'pro', user: { id: UID, email: 'a@b.c', app_metadata: { plan: 'free' } }, log: sessiz }), true);
  assert.deepStrictEqual(sb.yazilan[0], { tablo: 'ia_olaylar', satir: { olay: 'odeme_basladi', ayrinti: 'pro', sayfa: null, plan: 'free', user_id: UID } });
  assert.strictEqual(await O.olayYaz(sahteSb({ insertHata: { code: '23505', message: 'dup' } }), { olay: 'ilk_canli', user: { id: UID }, log: sessiz }), false);
  assert.strictEqual(await O.olayYaz(sahteSb({ insertHata: { code: 'XX', message: 'down' } }), { olay: 'ana_sayfa', log: sessiz }), false);
  const patlayan = { from() { throw new Error('ag yok'); } };
  assert.strictEqual(await O.olayYaz(patlayan, { olay: 'ana_sayfa', log: sessiz }), false);
  assert.strictEqual(await O.olayYaz(null, { olay: 'ana_sayfa' }), false, 'Supabase yoksa sessizce gec');
  assert.strictEqual(await O.olayYaz(sb, { olay: 'uydurma', log: sessiz }), false);
  assert.strictEqual(O.planOf({ app_metadata: { plan: 'admin' } }), 'free');
  assert.strictEqual(O.planOf(null), null);
});

test('OL5: kayit_tamam yalnizca son 7 gunde acilan hesap', async () => {
  const simdi = new Date('2026-10-09T12:00:00Z');
  const sb = sahteSb();
  assert.strictEqual(await O.kayitTamam(sb, { id: UID, created_at: '2026-10-08T12:00:00Z' }, { simdi, log: sessiz }), true);
  assert.strictEqual(await O.kayitTamam(sb, { id: UID, created_at: '2026-09-01T12:00:00Z' }, { simdi, log: sessiz }), false, 'eski hesap yeni kayit sayildi');
  assert.strictEqual(await O.kayitTamam(sb, { id: UID }, { simdi, log: sessiz }), false);
  assert.strictEqual(sb.yazilan.length, 1);
  assert.strictEqual(sb.yazilan[0].satir.olay, 'kayit_tamam');
});

test('OL6: ilk_canli yalnizca olcumden sonra kayit olan, bir kez; surec basina tek sorgu', async () => {
  O._sifirla();
  const yeni = sahteSb({ secim: [{ olay: 'kayit_tamam' }] });
  assert.strictEqual(await O.ilkCanli(yeni, { id: UID }, { log: sessiz }), true);
  assert.strictEqual(await O.ilkCanli(yeni, { id: UID }, { log: sessiz }), false, 'ikinci cevap');
  assert.strictEqual(yeni.sorgu.length, 1, 'her cevapta veritabanina gidildi');
  O._sifirla();
  const eski = sahteSb({ secim: [] });
  assert.strictEqual(await O.ilkCanli(eski, { id: UID }, { log: sessiz }), false, 'olcumden onceki kullanici');
  O._sifirla();
  const zaten = sahteSb({ secim: [{ olay: 'kayit_tamam' }, { olay: 'ilk_canli' }] });
  assert.strictEqual(await O.ilkCanli(zaten, { id: UID }, { log: sessiz }), false);
  assert.strictEqual(zaten.yazilan.length, 0);
});

// ── Rota ────────────────────────────────────────────────────────────────────
async function uygulama(kullanici) {
  const yolA = require.resolve('./middleware/auth');
  const gercek = require('./middleware/auth');
  const eskiA = require.cache[yolA];
  require.cache[yolA] = { id: yolA, filename: yolA, loaded: true, exports: { ...gercek,
    requireAuth: async (q, r) => { if (!kullanici) return r.code(401).send({ error: 'auth' }); q.user = kullanici; },
    optionalAuth: async (q) => { q.user = kullanici; } } };
  delete require.cache[require.resolve('./routes/olay')];
  const rota = require('./routes/olay');
  const sb = sahteSb();
  rota._testSb(sb);
  rota._sifirla();
  const app = require('fastify')({ logger: false });
  await app.register(rota, { prefix: '/api/v1/olay' });
  await app.ready();
  return { app, sb, bitir: async () => {
    await app.close();
    if (eskiA) require.cache[yolA] = eskiA; else delete require.cache[yolA];
    delete require.cache[require.resolve('./routes/olay')];
  } };
}
const TARAYICI = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const gonder = (app, payload, ek = {}) => app.inject({ method: 'POST', url: '/api/v1/olay', headers: { 'content-type': 'text/plain', 'user-agent': TARAYICI, ...ek }, payload });

test('OL2: kayit oncesi olaylar kisiye baglanmaz; masaustu_ilgi yalnizca girisle ve kisiye bagli', async () => {
  const kisi = { id: UID, app_metadata: { plan: 'free' }, created_at: new Date().toISOString() };
  const g = await uygulama(kisi);
  try {
    assert.strictEqual((await gonder(g.app, JSON.stringify({ olay: 'ana_sayfa', sayfa: '/' }))).statusCode, 204);
    assert.strictEqual((await gonder(g.app, JSON.stringify({ olay: 'masaustu_ilgi', ayrinti: 'dashboard' }))).statusCode, 204);
    await bekle();
    assert.deepStrictEqual(g.sb.yazilan.map((y) => [y.satir.olay, y.satir.user_id, y.satir.plan]), [['ana_sayfa', null, null], ['masaustu_ilgi', UID, 'free']]);
  } finally { await g.bitir(); }

  const z = await uygulama(null);
  try {
    assert.strictEqual((await gonder(z.app, JSON.stringify({ olay: 'masaustu_ilgi' }))).statusCode, 204);
    await bekle();
    assert.strictEqual(z.sb.yazilan.length, 0, 'girissiz masaustu_ilgi yazildi');
    assert.strictEqual((await z.app.inject({ method: 'POST', url: '/api/v1/olay/kayit' })).statusCode, 401);
  } finally { await z.bitir(); }
});

test('OL3: bot sayilmaz, hiz siniri, gecersiz govde 400, JSON da kabul', async () => {
  const g = await uygulama(null);
  try {
    assert.strictEqual((await gonder(g.app, JSON.stringify({ olay: 'ana_sayfa' }), { 'user-agent': 'Googlebot/2.1' })).statusCode, 204);
    assert.strictEqual((await gonder(g.app, JSON.stringify({ olay: 'ana_sayfa' }), { 'user-agent': '' })).statusCode, 204);
    await bekle();
    assert.strictEqual(g.sb.yazilan.length, 0, 'bot sayildi');
    assert.strictEqual((await gonder(g.app, 'bozuk')).statusCode, 400);
    assert.strictEqual((await gonder(g.app, JSON.stringify({ olay: 'satin_alma' }))).statusCode, 400);
    const j = await g.app.inject({ method: 'POST', url: '/api/v1/olay', headers: { 'user-agent': TARAYICI }, payload: { olay: 'kayit_sayfasi', sayfa: '/signup' } });
    assert.strictEqual(j.statusCode, 204);
    for (let i = 0; i < 40; i++) await gonder(g.app, JSON.stringify({ olay: 'ana_sayfa' }));
    await bekle();
    assert.ok(g.sb.yazilan.length <= 30, `hiz siniri calismadi (${g.sb.yazilan.length})`);
  } finally { await g.bitir(); }
});

test('OL7: baglanti noktalari ve gizlilik', () => {
  const idx = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(idx, /app\.register\(require\('\.\/routes\/olay'\), \{ prefix: '\/api\/v1\/olay' \}\)/);
  const aid = fs.readFileSync(path.join(__dirname, 'routes', 'aid.js'), 'utf8');
  const akis = aid.slice(aid.indexOf("fastify.post('/stream'"), aid.indexOf("fastify.post('/cues'"));
  assert.match(akis, /require\('\.\.\/lib\/olay'\)\.ilkCanli\(/, '/stream ilk canli olcmuyor');
  assert.ok(!/await require\('\.\.\/lib\/olay'\)\.ilkCanli/.test(aid), 'ilk canli cevabi bekletiyor');
  const bil = fs.readFileSync(path.join(__dirname, 'routes', 'billing.js'), 'utf8');
  assert.match(bil, /olay: 'odeme_basladi', ayrinti: wanted/);
  assert.match(bil, /olay: 'satin_alma', ayrinti: plan/);
  const rota = fs.readFileSync(path.join(__dirname, 'routes', 'olay.js'), 'utf8');
  const lib = fs.readFileSync(path.join(__dirname, 'lib', 'olay.js'), 'utf8');
  // Satira giden alanlar yalnizca bunlar: IP / UA / e-posta yazilmaz.
  assert.match(lib, /insert\(\{\s*olay,\s*ayrinti: temizAyrinti\(ayrinti\),\s*sayfa:\s+temizSayfa\(sayfa\),\s*plan:\s+planOf\(user\),\s*user_id: user && user\.id \? user\.id : null,\s*\}\)/);
  assert.ok(!/request\.ip[^)]*olayYaz|ip:\s*request\.ip/.test(rota), 'IP yaziliyor');
  assert.strictEqual(require('./lib/temizlik').OLAY_GUN, O.SAKLAMA_GUN);
});
