/**
 * pazarlama-sunucu.test.js — Pazarlama e-postasi izni (K87, 1 Ekim 2026).
 *
 *   lib/pazarlama.js     izin durumu, kanit, alt bilgi (posta adresi + cikis)
 *   routes/eposta.js     uclar, imzali cikis
 *
 * Calistir: node --test
 */
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert');

const Pz = require('./lib/pazarlama');
const botDepo = require('./lib/bot-depo');
const imza = require('./lib/eposta-imza');
const { EPOSTA } = require('./lib/hata-kodlari');

function sahteSb(sonuclar = []) {
  const kayit = [];
  const sira = [...sonuclar];
  const zincir = (tablo) => {
    const adimlar = [];
    kayit.push({ tablo, adimlar });
    const p = new Proxy({}, {
      get(_, ad) {
        if (ad === 'then') {
          const s = sira.length ? sira.shift() : { data: null, error: null };
          return (ok, h) => Promise.resolve(s).then(ok, h);
        }
        return (...args) => { adimlar.push([ad, ...args]); return p; };
      },
    });
    return p;
  };
  return { kayit, from: (t) => zincir(t) };
}
const adim = (k, ad) => k.adimlar.filter((a) => a[0] === ad).map((a) => a.slice(1));

const UID = '11111111-2222-4333-8444-555555555555';
const ENV = { SUPABASE_SERVICE_ROLE_KEY: 'k', POSTA_ADRESI: 'PO Box 123, Vancouver BC V6B 1A1, Canada' };

// ── Izin durumu ─────────────────────────────────────────────────────────────
test('A1: varsayilan izin YOK; karar verilmemis', () => {
  assert.deepStrictEqual(Pz.izinDurumu(null, { user_metadata: {} }),
    { izin: false, karar_verildi: false, kaynak: null, zaman: null, surum: null });
  assert.deepStrictEqual(Pz.izinDurumu({ pazarlama: false, pazarlama_kaynak: null }, null).karar_verildi, false,
    'K85 tercih satiri (yalnizca hatirlatma) karar sayildi');
});

test('A2: kayit karari: yalnizca kanitli izin; bozuk sekil yok sayilir', () => {
  const u = (m) => ({ user_metadata: { pazarlama: m } });
  assert.deepStrictEqual(Pz.kayitKarari(u({ izin: true, zaman: '2026-10-01T10:00:00Z', surum: 'p1' })),
    { izin: true, zaman: '2026-10-01T10:00:00.000Z', surum: 'p1' });
  assert.strictEqual(Pz.kayitKarari(u({ izin: true })), null, 'kanitsiz izin');
  assert.strictEqual(Pz.kayitKarari(u({ izin: true, zaman: 'dun', surum: 'p1' })), null);
  assert.strictEqual(Pz.kayitKarari(u({ izin: true, zaman: '2026-10-01T10:00:00Z', surum: 'v1; drop' })), null);
  assert.strictEqual(Pz.kayitKarari(u({ izin: 'true', zaman: '2026-10-01T10:00:00Z', surum: 'p1' })), null);
  assert.deepStrictEqual(Pz.kayitKarari(u({ izin: false })), { izin: false, zaman: null, surum: null }, 'hayir da karar');
  assert.strictEqual(Pz.kayitKarari({ user_metadata: { pazarlama: 'evet' } }), null);
});

test('A3: tablodaki son karar kayittakinden onceliklidir (e-postadan cikan, kayitta evet demis olsa da)', () => {
  const user = { user_metadata: { pazarlama: { izin: true, zaman: '2026-10-01T10:00:00Z', surum: 'p1' } } };
  const d = Pz.izinDurumu({ pazarlama: false, pazarlama_kaynak: 'eposta', pazarlama_zamani: 't', pazarlama_surum: 'p1' }, user);
  assert.deepStrictEqual([d.izin, d.kaynak], [false, 'eposta']);
  assert.deepStrictEqual(Pz.izinDurumu(null, user).kaynak, 'kayit');
});

// ── Depo ────────────────────────────────────────────────────────────────────
test('B1: karar kanitla yazilir; bilinmeyen kaynak reddedilir', async () => {
  const sb = sahteSb();
  botDepo._setSupabase(sb);
  try {
    await Pz.kararYaz(UID, true, 'serit');
    const [[satir, secenek]] = adim(sb.kayit[0], 'upsert');
    assert.strictEqual(sb.kayit[0].tablo, 'ia_eposta_tercihleri');
    assert.deepStrictEqual(secenek, { onConflict: 'user_id' });
    assert.deepStrictEqual([satir.user_id, satir.pazarlama, satir.pazarlama_kaynak, satir.pazarlama_surum], [UID, true, 'serit', Pz.METIN_SURUMU]);
    assert.ok(Date.now() - Date.parse(satir.pazarlama_zamani) < 5000);
    assert.ok(!('hatirlatma' in satir), 'hatirlatma tercihine dokundu');
    await assert.rejects(() => Pz.kararYaz(UID, true, 'satin_alinan_liste'), /gecersiz kaynak/);
  } finally { botDepo._setSupabase(undefined); }
});

test('B2: kayitta verilen karar ilk okumada tabloya, kendi zamaniyla tasinir; ikinci kez tasinmaz', async () => {
  const user = { id: UID, user_metadata: { pazarlama: { izin: true, zaman: '2026-10-01T10:00:00Z', surum: 'p1' } } };
  const sb = sahteSb([{ data: null }, { data: null }]);
  botDepo._setSupabase(sb);
  try {
    const d = await Pz.durumOku(user);
    assert.deepStrictEqual([d.izin, d.karar_verildi], [true, true]);
    const [[satir]] = adim(sb.kayit[1], 'upsert');
    assert.deepStrictEqual([satir.pazarlama, satir.pazarlama_kaynak, satir.pazarlama_zamani], [true, 'kayit', '2026-10-01T10:00:00.000Z']);
  } finally { botDepo._setSupabase(undefined); }
  const sb2 = sahteSb([{ data: { pazarlama: true, pazarlama_kaynak: 'kayit', pazarlama_zamani: 't', pazarlama_surum: 'p1' } }]);
  botDepo._setSupabase(sb2);
  try {
    await Pz.durumOku(user);
    assert.strictEqual(sb2.kayit.length, 1, 'zaten tablodaki karar yeniden yazildi');
  } finally { botDepo._setSupabase(undefined); }
  const sb3 = sahteSb([{ data: null }]);
  botDepo._setSupabase(sb3);
  try {
    const d = await Pz.durumOku({ id: UID, user_metadata: {} });
    assert.deepStrictEqual([d.izin, d.karar_verildi, sb3.kayit.length], [false, false, 1], 'karar yokken satir yazildi');
  } finally { botDepo._setSupabase(undefined); }
});

// ── Alt bilgi ───────────────────────────────────────────────────────────────
test('C1: posta adresi yoksa pazarlama e-postasi GONDERILEMEZ ve izin ISTENEMEZ', () => {
  assert.strictEqual(Pz.gonderen({}), null);
  assert.deepStrictEqual(Pz.gonderen({ POSTA_ADRESI: ' PO Box 9 ', SIRKET_ADI: 'Kurt Inc.', ILETISIM_EPOSTA: 'hi@x.test' }),
    { ad: 'Kurt Inc.', adres: 'PO Box 9', iletisim: 'hi@x.test' });
  assert.strictEqual(Pz.gonderilebilir({}), false);
  assert.strictEqual(Pz.gonderilebilir({ POSTA_ADRESI: '   ' }), false);
  assert.strictEqual(Pz.altBilgi(UID, { SUPABASE_SERVICE_ROLE_KEY: 'k' }), null);
  assert.strictEqual(Pz.altBilgi(UID, { POSTA_ADRESI: 'x' }), null, 'imza anahtari yokken cikissiz e-posta');
});

test('C2: alt bilgi: gonderen, adres, iletisim, calisan tek tik cikis (yalnizca pazarlama amacli)', () => {
  const a = Pz.altBilgi(UID, ENV);
  assert.match(a.text, /PlacedAI, PO Box 123, Vancouver BC V6B 1A1, Canada\. Contact: info@placedai\.app/);
  assert.match(a.text, /Unsubscribe: https:\/\/placedai-server-production\.up\.railway\.app\/api\/v1\/eposta\/eposta-kapat\?u=/);
  assert.strictEqual(a.headers['List-Unsubscribe'], `<${a.link}>`);
  assert.strictEqual(a.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const t = new URL(a.link).searchParams.get('t');
  assert.ok(imza.dogrula(UID, 'pazarlama', t, ENV));
  assert.ok(!imza.dogrula(UID, 'hatirlatma', t, ENV), 'pazarlama baglantisi hatirlatmayi kapatabiliyor');
  const k = Pz.altBilgi(UID, { ...ENV, SIRKET_ADI: 'Acme <Ltd>', POSTA_ADRESI: 'A & B "St"' });
  assert.match(k.html, /Acme &lt;Ltd&gt;, A &amp; B &quot;St&quot;/);
  assert.ok(!/—/.test(a.text + a.html), 'uzun tire');
});

// ── Rotalar ─────────────────────────────────────────────────────────────────
async function uygulama(kullanici, ek = {}) {
  const yolA = require.resolve('./middleware/auth');
  const gercek = require('./middleware/auth');
  const eskiA = require.cache[yolA];
  require.cache[yolA] = { id: yolA, filename: yolA, loaded: true, exports: { ...gercek,
    requireAuth: async (q, r) => { if (!kullanici) return r.code(401).send({ error: 'auth' }); q.user = kullanici; } } };
  const cagri = [];
  const eski = {};
  const sahte = {
    durumOku: async (u) => { cagri.push(['durum', u.id]); return { izin: false, karar_verildi: false }; },
    kararYaz: async (u, izin, kaynak) => { cagri.push(['yaz', u, izin, kaynak]); return {}; },
    ...ek,
  };
  for (const k of Object.keys(sahte)) { eski[k] = Pz[k]; Pz[k] = sahte[k]; }
  delete require.cache[require.resolve('./routes/eposta')];
  const app = require('fastify')({ logger: false });
  await app.register(require('./routes/eposta'), { prefix: '/api/v1/eposta' });
  await app.ready();
  return { app, cagri, bitir: async () => {
    await app.close();
    for (const k of Object.keys(eski)) Pz[k] = eski[k];
    if (eskiA) require.cache[yolA] = eskiA; else delete require.cache[yolA];
    delete require.cache[require.resolve('./routes/eposta')];
  } };
}
const P = (app, url, payload) => app.inject({ method: 'POST', url: `/api/v1/eposta${url}`, payload });

test('Y1: GET/POST oturum ister; kimlik oturumdan; yalnizca serit/ayarlar kaynagi; boolean izin', async () => {
  const anon = await uygulama(null);
  assert.strictEqual((await anon.app.inject({ method: 'GET', url: '/api/v1/eposta/pazarlama' })).statusCode, 401);
  assert.strictEqual((await P(anon.app, '/pazarlama', { izin: true, kaynak: 'serit' })).statusCode, 401);
  await anon.bitir();

  const eskiAdres = process.env.POSTA_ADRESI;
  process.env.POSTA_ADRESI = 'PO Box 1, Vancouver';
  const u = await uygulama({ id: UID });
  assert.deepStrictEqual((await u.app.inject({ method: 'GET', url: '/api/v1/eposta/pazarlama' })).json(),
    { izin: false, karar_verildi: false, gonderen: { ad: 'PlacedAI', adres: 'PO Box 1, Vancouver', iletisim: 'info@placedai.app' } });
  const r = await P(u.app, '/pazarlama', { izin: true, kaynak: 'ayarlar', user_id: 'baskasi' });
  assert.deepStrictEqual(r.json(), { izin: true, karar_verildi: true });
  assert.deepStrictEqual(u.cagri.at(-1), ['yaz', UID, true, 'ayarlar']);
  for (const govde of [{ izin: 'true', kaynak: 'serit' }, { izin: true, kaynak: 'eposta' }, { izin: true, kaynak: 'kayit' }, { izin: true }, {}]) {
    const x = await P(u.app, '/pazarlama', govde);
    assert.deepStrictEqual([x.statusCode, x.json().kod], [400, EPOSTA.GECERSIZ], JSON.stringify(govde));
  }
  assert.strictEqual(u.cagri.filter((c) => c[0] === 'yaz').length, 1);
  await u.bitir();

  // Posta adresi yoksa: izin istenemez/verilemez (SOR/2012-36 m.4); geri almak serbest.
  delete process.env.POSTA_ADRESI;
  const k = await uygulama({ id: UID });
  try {
    assert.strictEqual((await k.app.inject({ method: 'GET', url: '/api/v1/eposta/pazarlama' })).json().gonderen, null);
    assert.deepStrictEqual((await k.app.inject({ method: 'GET', url: '/api/v1/eposta/gonderen' })).json(), { gonderen: null });
    const x = await P(k.app, '/pazarlama', { izin: true, kaynak: 'serit' });
    assert.deepStrictEqual([x.statusCode, x.json().kod], [409, EPOSTA.KAPALI]);
    assert.strictEqual((await P(k.app, '/pazarlama', { izin: false, kaynak: 'ayarlar' })).statusCode, 200);
    assert.deepStrictEqual(k.cagri.filter((c) => c[0] === 'yaz'), [['yaz', UID, false, 'ayarlar']]);
  } finally {
    await k.bitir();
    if (eskiAdres === undefined) delete process.env.POSTA_ADRESI; else process.env.POSTA_ADRESI = eskiAdres;
  }

  const h = await uygulama({ id: UID }, { durumOku: async () => { throw new Error('x'); } });
  const x = await h.app.inject({ method: 'GET', url: '/api/v1/eposta/pazarlama' });
  assert.deepStrictEqual([x.statusCode, x.json().kod], [503, EPOSTA.KAYDEDILEMEDI]);
  await h.bitir();
});

test('Y2: imzali cikis: GET degistirmez, POST kapatir (kaynak eposta); baska amacin imzasi gecmez', async () => {
  const eskiEnv = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
  const u = await uygulama(null);
  try {
    const t = imza.imzala(UID, 'pazarlama');
    const g = await u.app.inject({ method: 'GET', url: `/api/v1/eposta/eposta-kapat?u=${UID}&t=${t}` });
    assert.strictEqual(g.statusCode, 200);
    assert.match(g.body, /Unsubscribe from PlacedAI offers\?/);
    assert.strictEqual(u.cagri.length, 0, 'GET kapatti');
    const p = await u.app.inject({ method: 'POST', url: `/api/v1/eposta/eposta-kapat?u=${UID}&t=${t}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    assert.strictEqual(p.statusCode, 200);
    assert.deepStrictEqual(u.cagri, [['yaz', UID, false, 'eposta']]);
    const baska = imza.imzala(UID, 'hatirlatma');
    assert.strictEqual((await u.app.inject({ method: 'POST', url: `/api/v1/eposta/eposta-kapat?u=${UID}&t=${baska}` })).statusCode, 400);
    assert.strictEqual(u.cagri.length, 1);
  } finally {
    await u.bitir();
    if (eskiEnv === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = eskiEnv;
  }
});

test('Y3: hata kodlari, rota kaydi, izin metni tek yerde', () => {
  assert.deepStrictEqual(require('./lib/hata-kodlari').EPOSTA_KODLARI.sort(), ['eposta_gecersiz', 'eposta_kapali', 'eposta_kaydedilemedi']);
  const idx = require('node:fs').readFileSync(require('node:path').join(__dirname, 'index.js'), 'utf8');
  assert.match(idx, /register\(epostaRoutes,\s*\{ prefix: '\/api\/v1\/eposta' \}\)/);
  assert.match(Pz.IZIN_METNI, /unsubscribe at any time/);
  assert.match(Pz.METIN_SURUMU, /^p\d+$/);
});
