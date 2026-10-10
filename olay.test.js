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
 *   OL15 (K115b) kayit kaynagi: bes etiket, yalnizca kendi satiri, 24 saat, ilk yazilan kalir
 *   OL16 (K115b) /kayit ucu kaynakla ve kaynaksiz; plan/odeme/guvenlik kodu etiketi okumaz
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
async function uygulama(kullanici, sb = sahteSb()) {
  const yolA = require.resolve('./middleware/auth');
  const gercek = require('./middleware/auth');
  const eskiA = require.cache[yolA];
  require.cache[yolA] = { id: yolA, filename: yolA, loaded: true, exports: { ...gercek,
    requireAuth: async (q, r) => { if (!kullanici) return r.code(401).send({ error: 'auth' }); q.user = kullanici; },
    optionalAuth: async (q) => { q.user = kullanici; } } };
  delete require.cache[require.resolve('./routes/olay')];
  const rota = require('./routes/olay');
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
const KOKEN = 'https://www.placedai.app';
const gonder = (app, payload, ek = {}) => app.inject({ method: 'POST', url: '/api/v1/olay', headers: { 'content-type': 'text/plain', 'user-agent': TARAYICI, origin: KOKEN, 'x-forwarded-for': '203.0.113.7', ...ek }, payload });

test('OL2: kayit oncesi olaylar kisiye baglanmaz; masaustu_ilgi yalnizca girisle ve kisiye bagli', async () => {
  const kisi = { id: UID, app_metadata: { plan: 'free' }, created_at: new Date().toISOString() };
  const g = await uygulama(kisi);
  try {
    assert.strictEqual((await gonder(g.app, JSON.stringify({ olay: 'ana_sayfa', sayfa: '/' }))).statusCode, 204);
    assert.strictEqual((await gonder(g.app, JSON.stringify({ olay: 'masaustu_ilgi', ayrinti: 'dashboard' }))).statusCode, 204);
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
    const j = await g.app.inject({ method: 'POST', url: '/api/v1/olay', headers: { 'user-agent': TARAYICI, origin: KOKEN }, payload: { olay: 'kayit_sayfasi', sayfa: '/signup' } });
    assert.strictEqual(j.statusCode, 204);
    await bekle();
    assert.strictEqual(g.sb.yazilan.length, 1, 'JSON govde yazilmadi');
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
  assert.match(bil, /if \(session\.livemode === true\) \{\s*require\('\.\.\/lib\/olay'\)\.olayYaz\(getSupabase\(\), \{ olay: 'odeme_basladi', ayrinti: wanted, user, disKimlik: session\.id/);
  // satin_alma YALNIZCA odeme oturumu olaylarinda yazilir; abonelik / fatura olaylari sayim yapmaz
  const satinYerleri = [...bil.matchAll(/olay: 'satin_alma'/g)].length;
  assert.strictEqual(satinYerleri, 2, 'satin_alma baska bir Stripe olayinda da yaziliyor');
  for (const m of bil.matchAll(/olay: 'satin_alma'[^}]*\}[^}]*disKimlik: s\.id/g)) assert.ok(m);
  assert.strictEqual([...bil.matchAll(/disKimlik: s\.id/g)].length, 2);
  const rota = fs.readFileSync(path.join(__dirname, 'routes', 'olay.js'), 'utf8');
  const lib = fs.readFileSync(path.join(__dirname, 'lib', 'olay.js'), 'utf8');
  // Satira giden alanlar yalnizca bunlar: IP / UA / e-posta yazilmaz.
  const satir = lib.slice(lib.indexOf('const satir = {'), lib.indexOf("sb.from('ia_olaylar').insert(satir)"));
  for (const alan of ['olay', 'ayrinti', 'sayfa', 'plan', 'user_id', 'dis_kimlik']) assert.ok(satir.includes(alan), alan);
  assert.ok(!/\bip\b|user_agent|email/i.test(satir), 'satira IP/UA/e-posta giriyor');
  assert.ok(!/request\.ip[^)]*olayYaz|ip:\s*request\.ip/.test(rota), 'IP yaziliyor');
  assert.strictEqual(require('./lib/temizlik').OLAY_GUN, O.SAKLAMA_GUN);
});


// ── K112b: kotuye kullanima karsi katmanlar ─────────────────────────────────
test('OL8: koken kontrolu (Origin, yoksa Referer); izinsiz kaynaktan yazilmaz', async () => {
  const g = await uygulama(null);
  try {
    await gonder(g.app, JSON.stringify({ olay: 'ana_sayfa', sayfa: '/' }), { origin: 'https://kotu.example' });
    await gonder(g.app, JSON.stringify({ olay: 'ana_sayfa', sayfa: '/' }), { origin: '' });
    await gonder(g.app, JSON.stringify({ olay: 'ana_sayfa', sayfa: '/' }), { origin: 'http://localhost:3000' });
    await bekle();
    assert.strictEqual(g.sb.yazilan.length, 0, 'izinsiz koken yazildi');
    const r = await g.app.inject({ method: 'POST', url: '/api/v1/olay', headers: { 'content-type': 'text/plain', 'user-agent': TARAYICI, referer: 'https://placedai.app/signup?plan=pro', 'x-forwarded-for': '203.0.113.8' }, payload: JSON.stringify({ olay: 'kayit_sayfasi', sayfa: '/signup' }) });
    assert.strictEqual(r.statusCode, 204);
    await bekle();
    assert.strictEqual(g.sb.yazilan.length, 1, 'Referer yedegi calismadi');
  } finally { await g.bitir(); }
});

test('OL9: tekrar engeli (10 dk) ve IP basina dakika/saat siniri', async () => {
  const g = await uygulama(null);
  try {
    for (let i = 0; i < 5; i++) await gonder(g.app, JSON.stringify({ olay: 'ana_sayfa', sayfa: '/' }));
    await bekle();
    assert.strictEqual(g.sb.yazilan.length, 1, 'ayni olay tekrar sayildi');
    // farkli sayfalarla dakika siniri (20)
    for (let i = 0; i < 40; i++) await gonder(g.app, JSON.stringify({ olay: 'ana_sayfa', sayfa: `/p${i}` }), { 'x-forwarded-for': '198.51.100.1' });
    await bekle();
    const birIp = g.sb.yazilan.length - 1;
    assert.ok(birIp <= 20, `dakika siniri calismadi (${birIp})`);
    // baska IP etkilenmez
    await gonder(g.app, JSON.stringify({ olay: 'ana_sayfa', sayfa: '/x' }), { 'x-forwarded-for': '198.51.100.2' });
    await bekle();
    assert.strictEqual(g.sb.yazilan.length, birIp + 2);
  } finally { await g.bitir(); }
});

test('OL10: istemci IP once X-Real-IP (Railway yazar), sonra XFF en sag; uydurulmus sol XFF siniri asamaz', async () => {
  const rota = require('./routes/olay');
  assert.strictEqual(rota._istemciIp({ headers: { 'x-real-ip': '5.5.5.5', 'x-forwarded-for': '1.1.1.1, 9.9.9.9' }, ip: '10.0.0.1' }), '5.5.5.5');
  assert.strictEqual(rota._istemciIp({ headers: { 'x-forwarded-for': '1.1.1.1, 9.9.9.9' }, ip: '10.0.0.1' }), '9.9.9.9');
  assert.strictEqual(rota._istemciIp({ headers: {}, ip: '10.0.0.1' }), '10.0.0.1');
  assert.strictEqual(rota._istemciIp({ headers: { 'x-real-ip': 'x'.repeat(200) }, ip: '10.0.0.1' }), '10.0.0.1', 'asiri uzun baslik');
  const g = await uygulama(null);
  try {
    for (let i = 0; i < 30; i++) await gonder(g.app, JSON.stringify({ olay: 'ana_sayfa', sayfa: `/u${i}` }), { 'x-forwarded-for': `10.0.${i}.1, 198.51.100.9` });
    await bekle();
    assert.ok(g.sb.yazilan.length <= 20, `sahte XFF siniri asti (${g.sb.yazilan.length})`);
    // Railway X-Real-IP'yi gercek IP ile ezdiginde, istemcinin XFF'i ne olursa olsun tek kisi sayilir
    const once = g.sb.yazilan.length;
    for (let i = 0; i < 30; i++) await gonder(g.app, JSON.stringify({ olay: 'ana_sayfa', sayfa: `/r${i}` }), { 'x-real-ip': '198.51.100.50', 'x-forwarded-for': `10.9.${i}.1` });
    await bekle();
    assert.ok(g.sb.yazilan.length - once <= 20, `X-Real-IP sabitken XFF degistirerek sinir asildi (${g.sb.yazilan.length - once})`);
  } finally { await g.bitir(); }
});

test('OL11: gunluk anonim tavan; asilinca o gun yazilmaz', async () => {
  const g = await uygulama(null);
  const rota = require('./routes/olay');
  rota._ayarla({ tavan: 3 });
  try {
    for (let i = 0; i < 6; i++) await gonder(g.app, JSON.stringify({ olay: 'ana_sayfa', sayfa: `/t${i}` }), { 'x-forwarded-for': `192.0.2.${i}` });
    await bekle();
    assert.strictEqual(g.sb.yazilan.length, 3);
  } finally { rota._ayarla({ tavan: 20000 }); await g.bitir(); }
});

test('OL12: IP hicbir yerde ham durmaz (bellek dahil)', async () => {
  const g = await uygulama(null);
  const rota = require('./routes/olay');
  try {
    await gonder(g.app, JSON.stringify({ olay: 'ana_sayfa', sayfa: '/' }), { 'x-forwarded-for': '203.0.113.77' });
    await bekle();
    const durum = JSON.stringify(rota._durum());
    assert.ok(!durum.includes('203.0.113.77'), 'ham IP bellekte');
    assert.ok(!JSON.stringify(g.sb.yazilan).includes('203.0.113'), 'IP satira yazildi');
  } finally { await g.bitir(); }
});

// ── K112b: Stripe webhook, imzali sahte bildirim (gercek odeme YOK) ─────────
async function webhookUygulamasi() {
  const SIR = 'whsec_test_placedai';
  const eskiEnv = { ...process.env };
  Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk_test_sahte', STRIPE_WEBHOOK_SECRET: SIR, SUPABASE_URL: 'https://sahte.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sahte' });
  const olaylar = [];       // ia_olaylar satirlari (dis_kimlik benzersiz)
  const planlar = [];
  const sahteSb = {
    auth: { admin: {
      getUserById: async () => ({ data: { user: { app_metadata: {} } }, error: null }),
      updateUserById: async (id, a) => { planlar.push([id, a.app_metadata.plan]); return { error: null }; },
    } },
    from(tablo) {
      return { insert: async (satir) => {
        if (tablo !== 'ia_olaylar') return { error: null };
        if (satir.dis_kimlik && olaylar.some((o) => o.dis_kimlik === satir.dis_kimlik)) return { error: { code: '23505', message: 'dup' } };
        olaylar.push(satir); return { error: null };
      } };
    },
  };
  const yolS = require.resolve('@supabase/supabase-js');
  const eskiS = require.cache[yolS];
  require.cache[yolS] = { id: yolS, filename: yolS, loaded: true, exports: { createClient: () => sahteSb } };
  delete require.cache[require.resolve('./routes/billing')];
  const app = require('fastify')({ logger: false });
  await app.register(require('./routes/billing'), { prefix: '/api/v1/billing' });
  await app.ready();
  const Stripe = require('stripe');
  const stripe = new Stripe('sk_test_sahte');
  const gonderOlay = (olay) => {
    const govde = JSON.stringify(olay);
    const imza = stripe.webhooks.generateTestHeaderString({ payload: govde, secret: SIR });
    return app.inject({ method: 'POST', url: '/api/v1/billing/webhook', headers: { 'content-type': 'application/json', 'stripe-signature': imza }, payload: govde });
  };
  return { app, olaylar, planlar, gonderOlay, bitir: async () => {
    await app.close();
    if (eskiS) require.cache[yolS] = eskiS; else delete require.cache[yolS];
    delete require.cache[require.resolve('./routes/billing')];
    process.env = eskiEnv;
  } };
}
const oturum = (id, ek = {}) => ({ id: 'evt_' + Math.random().toString(36).slice(2, 10), object: 'event', type: 'checkout.session.completed', livemode: true,
  data: { object: { id, object: 'checkout.session', client_reference_id: UID, customer: 'cus_1', subscription: null, payment_status: 'paid', ...ek } }, ...(ek.__ust || {}) });

test('OL13: Stripe tekrar bildirimi ve ayni odemenin farkli olaylari CIFT SAYILMAZ; yalnizca canli + odenmis', async () => {
  const w = await webhookUygulamasi();
  try {
    const ilk = oturum('cs_live_A1');
    assert.strictEqual((await w.gonderOlay(ilk)).statusCode, 200);
    assert.strictEqual((await w.gonderOlay(ilk)).statusCode, 200, 'tekrar bildirim');                  // ayni event tekrar
    assert.strictEqual((await w.gonderOlay({ ...oturum('cs_live_A1'), id: 'evt_baska' })).statusCode, 200);  // ayni odeme, farkli event
    const gecikmeli = { ...oturum('cs_live_A1'), type: 'checkout.session.async_payment_succeeded' };
    assert.strictEqual((await w.gonderOlay(gecikmeli)).statusCode, 200);                               // ayni odeme, baska olay turu
    await bekle();
    assert.strictEqual(w.olaylar.filter((o) => o.olay === 'satin_alma').length, 1, 'ayni odeme birden fazla sayildi');
    assert.strictEqual(w.olaylar[0].dis_kimlik, 'cs_live_A1');
    // plan atamasi her bildirimde calismaya devam ediyor (davranis degismedi)
    assert.ok(w.planlar.length >= 3);

    // test modu, odenmemis ve %100 indirimli: satin alma sayilmaz
    await w.gonderOlay({ ...oturum('cs_test_B1'), livemode: false });
    await w.gonderOlay(oturum('cs_live_C1', { payment_status: 'unpaid' }));
    await w.gonderOlay(oturum('cs_live_D1', { payment_status: 'no_payment_required' }));
    await bekle();
    assert.strictEqual(w.olaylar.filter((o) => o.olay === 'satin_alma').length, 1);

    // ikinci gercek odeme sayilir
    await w.gonderOlay(oturum('cs_live_E1'));
    await bekle();
    assert.strictEqual(w.olaylar.filter((o) => o.olay === 'satin_alma').length, 2);
  } finally { await w.bitir(); }
});

test('OL14: imzasiz ya da sahte imzali webhook hicbir sey yazmaz', async () => {
  const w = await webhookUygulamasi();
  try {
    const govde = JSON.stringify(oturum('cs_live_Z9'));
    const r1 = await w.app.inject({ method: 'POST', url: '/api/v1/billing/webhook', headers: { 'content-type': 'application/json' }, payload: govde });
    const r2 = await w.app.inject({ method: 'POST', url: '/api/v1/billing/webhook', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' }, payload: govde });
    assert.strictEqual(r1.statusCode, 400);
    assert.strictEqual(r2.statusCode, 400);
    await bekle();
    assert.strictEqual(w.olaylar.length, 0);
    assert.strictEqual(w.planlar.length, 0);
  } finally { await w.bitir(); }
});


// ── K115b: kayit kaynagi ────────────────────────────────────────────────────
/** insert + update(...).eq().is().select() destekleyen, durum tutan sahte Supabase. */
function durumluSb(satirlar = []) {
  return {
    satirlar,
    from() {
      return {
        insert: async (s) => {
          if (s.olay === 'kayit_tamam' && satirlar.some((r) => r.user_id === s.user_id && r.olay === 'kayit_tamam')) return { error: { code: '23505', message: 'tekrar' } };
          satirlar.push({ ayrinti: null, ...s });
          return { error: null };
        },
        update(deg) {
          const f = [];
          const z = {
            eq: (k, v) => { f.push((r) => r[k] === v); return z; },
            is: (k, v) => { f.push((r) => (r[k] ?? null) === v); return z; },
            select: async () => {
              const hit = satirlar.filter((r) => f.every((fn) => fn(r)));
              hit.forEach((r) => Object.assign(r, deg));
              return { data: hit.map((_, i) => ({ id: i })), error: null };
            },
          };
          return z;
        },
      };
    },
  };
}
const UID2 = '99999999-2222-4333-8444-555555555555';

test('OL15: kaynak etiketi: bes deger, yalnizca kendi satiri, 24 saat, ilk yazilan kalir', async () => {
  assert.deepStrictEqual([...O.KAYIT_KAYNAKLARI].sort(), ['demo', 'direct', 'hero', 'other', 'pricing']);
  const simdi = new Date('2026-10-10T12:00:00Z');
  const yeni = { id: UID, created_at: '2026-10-10T11:00:00Z' };
  const baska = { id: UID2, created_at: '2026-10-10T11:30:00Z' };
  const sb = durumluSb([
    { olay: 'kayit_tamam', user_id: UID, ayrinti: null },
    { olay: 'kayit_tamam', user_id: UID2, ayrinti: null },
    { olay: 'ilk_canli', user_id: UID, ayrinti: null },
  ]);
  assert.strictEqual(await O.kaynakEkle(sb, yeni, 'facebook', { simdi, log: sessiz }), false, 'listede olmayan deger');
  assert.strictEqual(await O.kaynakEkle(sb, yeni, 'demo', { simdi, log: sessiz }), true);
  assert.strictEqual(await O.kaynakEkle(sb, yeni, 'hero', { simdi, log: sessiz }), false, 'ilk etiket ezildi');
  assert.deepStrictEqual(sb.satirlar.map((r) => [r.olay, r.user_id === UID ? 'A' : 'B', r.ayrinti]),
    [['kayit_tamam', 'A', 'demo'], ['kayit_tamam', 'B', null], ['ilk_canli', 'A', null]], 'baska kullanici ya da baska olay degisti');
  // 24 saatten eski hesap: etiket yazilamaz
  assert.strictEqual(await O.kaynakEkle(sb, { ...baska, created_at: '2026-10-09T10:00:00Z' }, 'pricing', { simdi, log: sessiz }), false);
  assert.strictEqual(await O.kaynakEkle(sb, { id: UID2 }, 'pricing', { simdi, log: sessiz }), false, 'olusma zamani yok');
  assert.strictEqual(sb.satirlar[1].ayrinti, null);
  // satir yoksa kayitTamam etiketle yazar; gecersiz etiket bos kalir
  const bos = durumluSb();
  assert.strictEqual(await O.kayitTamam(bos, baska, { simdi, log: sessiz, kaynak: 'pricing' }), true);
  assert.strictEqual(bos.satirlar[0].ayrinti, 'pricing');
  const bos2 = durumluSb();
  await O.kayitTamam(bos2, baska, { simdi, log: sessiz, kaynak: '<script>' });
  assert.strictEqual(bos2.satirlar[0].ayrinti, null);
  // asla firlatmaz
  const bozuk = { from() { throw new Error('ag'); } };
  assert.strictEqual(await O.kaynakEkle(bozuk, yeni, 'demo', { simdi, log: sessiz }), false);
});

test('OL16: /kayit ucu kaynakla ve kaynaksiz; plan / odeme / guvenlik kodu etiketi okumaz', async () => {
  const kisi = { id: UID, app_metadata: { plan: 'free' }, created_at: new Date(Date.now() - 60 * 1000).toISOString() };
  // tetikleyici satiri yazmis; panel kaynakla geliyor (JSON)
  const sb = durumluSb([{ olay: 'kayit_tamam', user_id: UID, ayrinti: null }]);
  let g = await uygulama(kisi, sb);
  try {
    const r = await g.app.inject({ method: 'POST', url: '/api/v1/olay/kayit', headers: { 'content-type': 'application/json' }, payload: { kaynak: 'demo' } });
    assert.strictEqual(r.statusCode, 204);
    assert.strictEqual(sb.satirlar[0].ayrinti, 'demo');
    // ikinci kez (yenileme, baska sekme): degismez
    await g.app.inject({ method: 'POST', url: '/api/v1/olay/kayit', headers: { 'content-type': 'application/json' }, payload: { kaynak: 'pricing' } });
    assert.strictEqual(sb.satirlar[0].ayrinti, 'demo');
    assert.strictEqual(sb.satirlar.length, 1, 'ikinci kayit satiri');
    // govdesiz eski cagri hala calisir; bozuk govde 204, hicbir sey yazmaz
    assert.strictEqual((await g.app.inject({ method: 'POST', url: '/api/v1/olay/kayit' })).statusCode, 204);
    assert.strictEqual((await g.app.inject({ method: 'POST', url: '/api/v1/olay/kayit', headers: { 'content-type': 'text/plain' }, payload: '{bozuk' })).statusCode, 204);
    assert.strictEqual(sb.satirlar[0].ayrinti, 'demo');
  } finally { await g.bitir(); }
  // e-posta kaydi: etiket hesap bilgisinde; adres baska bir sey soylese de hesabinki gecer
  const sb3 = durumluSb([{ olay: 'kayit_tamam', user_id: UID, ayrinti: null }]);
  g = await uygulama({ ...kisi, user_metadata: { kayit_kaynagi: 'pricing' } }, sb3);
  try {
    await g.app.inject({ method: 'POST', url: '/api/v1/olay/kayit', headers: { 'content-type': 'application/json' }, payload: { kaynak: 'hero' } });
    assert.strictEqual(sb3.satirlar[0].ayrinti, 'pricing');
  } finally { await g.bitir(); }
  // farkli cihaz: adres parametresi yok, panel govdesiz cagirir; etiket yine hesaptan gelir
  const sb4 = durumluSb([{ olay: 'kayit_tamam', user_id: UID, ayrinti: null }]);
  g = await uygulama({ ...kisi, user_metadata: { kayit_kaynagi: 'demo' } }, sb4);
  try {
    await g.app.inject({ method: 'POST', url: '/api/v1/olay/kayit' });
    assert.strictEqual(sb4.satirlar[0].ayrinti, 'demo');
  } finally { await g.bitir(); }
  // hesap bilgisinde gecersiz deger: yazilmaz
  const sb5 = durumluSb([{ olay: 'kayit_tamam', user_id: UID, ayrinti: null }]);
  g = await uygulama({ ...kisi, user_metadata: { kayit_kaynagi: 'admin' } }, sb5);
  try {
    await g.app.inject({ method: 'POST', url: '/api/v1/olay/kayit', headers: { 'content-type': 'application/json' }, payload: { kaynak: 'demo' } });
    assert.strictEqual(sb5.satirlar[0].ayrinti, null, 'gecersiz hesap etiketi yerine adres de yazilmamali');
  } finally { await g.bitir(); }
  // satir yoksa (tetikleyici yazamadi): kayit + etiket tek seferde
  const sb2 = durumluSb();
  g = await uygulama(kisi, sb2);
  try {
    await g.app.inject({ method: 'POST', url: '/api/v1/olay/kayit', headers: { 'content-type': 'text/plain' }, payload: JSON.stringify({ kaynak: 'hero' }) });
    assert.deepStrictEqual(sb2.satirlar.map((r) => [r.olay, r.ayrinti]), [['kayit_tamam', 'hero']]);
  } finally { await g.bitir(); }
  // etiket yalnizca olcum dosyalarinda: plan, odeme, sinir, kimlik kodu okumaz
  const okuyan = [];
  const tara = (d) => { for (const a of fs.readdirSync(d, { withFileTypes: true })) {
    const y = path.join(d, a.name);
    if (a.isDirectory()) { if (!['node_modules', '.git'].includes(a.name)) tara(y); }
    else if (a.name.endsWith('.js') && !a.name.endsWith('.test.js') && /kaynakEkle|KAYIT_KAYNAKLARI|govde\.kaynak|kaynakGecerli|kayit_kaynagi/.test(fs.readFileSync(y, 'utf8'))) okuyan.push(path.relative(__dirname, y).replace(/\\/g, '/'));
  } };
  tara(__dirname);
  assert.deepStrictEqual(okuyan.sort(), ['lib/olay.js', 'routes/olay.js'], 'kaynak etiketi baska kodda kullaniliyor');
  for (const f of ['routes/billing.js', 'lib/plans.js', 'middleware/auth.js']) {
    if (fs.existsSync(path.join(__dirname, f))) assert.ok(!/\.kaynak\b|'kaynak'|kaynakEkle|KAYIT_KAYNAKLARI|kayit_kaynagi/.test(fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), `${f} kaynak etiketini okuyor`);
  }
});
