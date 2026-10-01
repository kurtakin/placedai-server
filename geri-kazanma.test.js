/**
 * geri-kazanma.test.js — Geri kazanma e-postasi (K88, 1 Ekim 2026).
 *
 * Kullanicinin kararlari (DEVAM.md K87): izinli, hic odememis Free uyeye
 * 37. gun HAYATINDA TEK e-posta; kisiye ozel, tek kullanimlik, 14 gun gecerli
 * %15 ilk ay kodu. Posta adresi ve dogru kupon olmadan hicbir e-posta gitmez.
 *
 * Calistir: node --test
 */
'use strict';

const { test, beforeEach } = require('node:test');
const assert   = require('node:assert');

const GK = require('./lib/geri-kazanma');
const Pz = require('./lib/pazarlama');
const kota = require('./lib/eposta-kota');
const imza = require('./lib/eposta-imza');

const GUN = 86400000;
const SIMDI = new Date('2026-11-07T17:30:00Z');
const ENV = { SUPABASE_SERVICE_ROLE_KEY: 'k', POSTA_ADRESI: 'PO Box 123, Vancouver BC', STRIPE_GERI_KAZANMA_KUPON: 'cpn_15', EPOSTA_GUNLUK: '80' };
const kisi = (id, gun, ek = {}) => ({ id, email: `${id}@x.test`, email_confirmed_at: 't', created_at: new Date(+SIMDI - gun * GUN - 3600000).toISOString(),
  app_metadata: { plan: 'free' }, user_metadata: { pazarlama: { izin: true, zaman: '2026-10-01T00:00:00Z', surum: 'p1' } }, ...ek });

/** Bellekte ia_geri_kazanma + auth.admin.listUsers. */
function sahteSb(kullanicilar, satirlar = []) {
  const tablo = [...satirlar];
  const yazilar = [];
  const from = (ad) => {
    assert.strictEqual(ad, 'ia_geri_kazanma');
    let filtre = () => true; let islem = 'select'; let veri = null;
    const z = {
      select: () => z,
      eq: (k, v) => { const f = filtre; filtre = (r) => f(r) && r[k] === v; return z; },
      maybeSingle: () => z,
      insert: (r) => { islem = 'insert'; veri = r; return z; },
      update: (r) => { islem = 'update'; veri = r; return z; },
      then: (ok, h) => {
        let s;
        if (islem === 'insert') { tablo.push({ ...veri }); yazilar.push(['insert', veri]); s = { data: null, error: null }; }
        else if (islem === 'update') { for (const r of tablo.filter(filtre)) Object.assign(r, veri); yazilar.push(['update', veri]); s = { data: null, error: null }; }
        else { const b = tablo.filter(filtre); s = { data: b.length <= 1 ? (b[0] || null) : b, error: null }; }
        return Promise.resolve(s).then(ok, h);
      },
    };
    return z;
  };
  return { tablo, yazilar, from, auth: { admin: { listUsers: async ({ page, perPage }) => ({ data: { users: kullanicilar.slice((page - 1) * perPage, page * perPage) }, error: null }) } } };
}

function sahteStripe({ kupon = { valid: true, percent_off: 15, duration: 'once' } } = {}) {
  const olusan = [];
  return { olusan,
    coupons: { retrieve: async (id) => { if (id !== 'cpn_15') throw new Error('yok'); return kupon; } },
    promotionCodes: {
      create: async (p) => { olusan.push(p); return { id: `promo_${olusan.length}`, code: `WELCOME${olusan.length}X` }; },
      retrieve: async (id) => { if (id === 'promo_bozuk') throw new Error('yok'); return { times_redeemed: id === 'promo_1' ? 1 : 0 }; },
    } };
}

let eskiSatirOku;
beforeEach(() => {
  kota._sifirla();
  if (!eskiSatirOku) eskiSatirOku = Pz.satirOku;
  Pz.satirOku = async () => null;   // tabloda karar yok; kayittaki izin gecerli
});

async function tur({ kullanicilar, satirlar, stripe = sahteStripe(), env = ENV, posta = async () => ({ ok: true }) }) {
  const sb = sahteSb(kullanicilar, satirlar);
  const giden = [];
  const r = await GK.turCalistir({ sb, stripe, postaGonder: async (m) => { giden.push(m); return posta(m); }, simdi: SIMDI, env, log: { info() {}, error() {} } });
  return { ...r, sb, stripe, giden };
}

test('A1: aday: Free, hic abonelik izi yok, e-posta dogrulanmis, uyelik 37-44. gun', () => {
  assert.ok(GK.adayMi(kisi('a', 37), SIMDI));
  assert.ok(GK.adayMi(kisi('a', 44), SIMDI));
  assert.ok(!GK.adayMi(kisi('a', 36), SIMDI), '36. gun');
  assert.ok(!GK.adayMi(kisi('a', 45), SIMDI), 'eski hesaplara toplu e-posta');
  assert.ok(!GK.adayMi(kisi('a', 40, { app_metadata: { plan: 'pro' } }), SIMDI));
  assert.ok(!GK.adayMi(kisi('a', 40, { app_metadata: { plan: 'free', subscription_status: 'canceled' } }), SIMDI), 'odemis ve birakmis');
  assert.ok(!GK.adayMi(kisi('a', 40, { email_confirmed_at: null }), SIMDI));
  assert.ok(GK.adayMi(kisi('a', 40, { app_metadata: {} }), SIMDI), 'plan yazilmamis = free');
});

test('A2: kupon denetimi: yalnizca %15 ve "once"', () => {
  assert.strictEqual(GK.kuponDenetle({ valid: true, percent_off: 15, duration: 'once' }), null);
  assert.match(GK.kuponDenetle({ valid: true, percent_off: 100, duration: 'once' }), /%100/);
  assert.match(GK.kuponDenetle({ valid: true, percent_off: 15, duration: 'forever' }), /forever/);
  assert.match(GK.kuponDenetle({ valid: true, amount_off: 500, percent_off: 15, duration: 'once' }), /sabit tutar/);
  assert.match(GK.kuponDenetle({ valid: false }), /gecersiz/);
  assert.match(GK.kuponDenetle(null), /gecersiz/);
});

test('B1: gonderim: kisiye ozel tek kullanimlik 14 gunluk ilk-odeme kodu; once kayit, sonra e-posta; altbilgi ve tek tik cikis', async () => {
  const r = await tur({ kullanicilar: [kisi('u1', 37)] });
  assert.deepStrictEqual(r.sonuclar, [{ user_id: 'u1', durum: 'gonderildi' }]);
  const [p] = r.stripe.olusan;
  assert.deepStrictEqual(p.promotion, { type: 'coupon', coupon: 'cpn_15' });
  assert.deepStrictEqual([p.max_redemptions, p.restrictions], [1, { first_time_transaction: true }]);
  assert.strictEqual(p.expires_at, Math.floor((+SIMDI + 14 * GUN) / 1000));
  assert.deepStrictEqual(p.metadata, { user_id: 'u1', amac: 'geri_kazanma' });
  assert.deepStrictEqual(r.sb.yazilar.map((y) => y[0]), ['insert', 'update'], 'e-postadan once kayit yok');
  assert.deepStrictEqual([r.sb.tablo[0].durum, r.sb.tablo[0].promosyon_kodu], ['gonderildi', 'WELCOME1X']);
  const [m] = r.giden;
  assert.strictEqual(m.to, 'u1@x.test');
  assert.strictEqual(m.subject, '15% off your first month of PlacedAI Pro');
  assert.match(m.text, /Your code: WELCOME1X/);
  assert.match(m.text, /Valid until November 21, 2026\. One use, for a first payment only\./);
  assert.match(m.text, /PlacedAI, PO Box 123, Vancouver BC\. Contact: info@placedai\.app/);
  assert.match(m.html, /Unsubscribe<\/a>/);
  const link = new URL(m.headers['List-Unsubscribe'].slice(1, -1));
  assert.ok(imza.dogrula('u1', 'pazarlama', link.searchParams.get('t'), ENV));
  assert.ok(!/—/.test(m.text + m.html), 'uzun tire');
});

test('B2: hayatinda tek: gonderilmis olana bir daha yok; izinsize, adressize, kuponsuza hic yok', async () => {
  const gonderilmis = { user_id: 'u1', durum: 'gonderildi', promosyon_kodu: 'X1X', stripe_promosyon_id: 'promo_9', gecerlilik: new Date(+SIMDI + 5 * GUN).toISOString(), deneme: 1 };
  const r = await tur({ kullanicilar: [kisi('u1', 40)], satirlar: [gonderilmis] });
  assert.deepStrictEqual([r.sonuclar[0].durum, r.giden.length, r.stripe.olusan.length], ['zaten', 0, 0]);

  const iz = await tur({ kullanicilar: [kisi('u2', 40, { user_metadata: {} }), kisi('u3', 40, { user_metadata: { pazarlama: { izin: false } } })] });
  assert.deepStrictEqual(iz.sonuclar.map((s) => s.durum), ['izin_yok', 'izin_yok']);
  assert.strictEqual(iz.stripe.olusan.length, 0, 'izinsize kod uretildi');

  Pz.satirOku = async () => ({ pazarlama: false, pazarlama_kaynak: 'eposta', pazarlama_zamani: 't', pazarlama_surum: 'p1' });
  const cikan = await tur({ kullanicilar: [kisi('u4', 40)] });
  assert.strictEqual(cikan.sonuclar[0].durum, 'izin_yok', 'e-postadan cikmis kisiye (kayitta evet demis olsa da) gitti');
  Pz.satirOku = async () => null;

  for (const [env, neden] of [[{ ...ENV, POSTA_ADRESI: '' }, 'posta adresi yok'], [{ ...ENV, STRIPE_GERI_KAZANMA_KUPON: '' }, 'kupon tanimli degil']]) {
    const x = await tur({ kullanicilar: [kisi('u5', 40)], env });
    assert.deepStrictEqual([x.durdu, x.giden.length, x.stripe.olusan.length], [neden, 0, 0]);
  }
  const yanlis = await tur({ kullanicilar: [kisi('u6', 40)], stripe: sahteStripe({ kupon: { valid: true, percent_off: 100, duration: 'once' } }) });
  assert.match(yanlis.durdu, /%100/);
  assert.deepStrictEqual([yanlis.giden.length, yanlis.stripe.olusan.length], [0, 0]);
});

test('B3: gonderim basarisizsa ertesi gun AYNI kodla; 3 denemeden ya da kodun cogu dolduktan sonra vazgecilir', async () => {
  const r = await tur({ kullanicilar: [kisi('u1', 37)], posta: async () => ({ ok: false }) });
  assert.strictEqual(r.sonuclar[0].durum, 'gonderilemedi');
  assert.deepStrictEqual([r.sb.tablo[0].durum, r.sb.tablo[0].deneme], ['hazirlandi', 1]);
  kota._sifirla();
  const r2 = await tur({ kullanicilar: [kisi('u1', 38)], satirlar: r.sb.tablo });
  assert.strictEqual(r2.sonuclar[0].durum, 'gonderildi');
  assert.strictEqual(r2.stripe.olusan.length, 0, 'yeni kod uretildi');
  assert.match(r2.giden[0].text, /Your code: WELCOME1X/);

  const uc = { user_id: 'u2', durum: 'hazirlandi', promosyon_kodu: 'A1A', stripe_promosyon_id: 'promo_1', gecerlilik: new Date(+SIMDI + 12 * GUN).toISOString(), deneme: 3 };
  const gec = { user_id: 'u3', durum: 'hazirlandi', promosyon_kodu: 'B1B', stripe_promosyon_id: 'promo_2', gecerlilik: new Date(+SIMDI + 9 * GUN).toISOString(), deneme: 1 };
  const v = await tur({ kullanicilar: [kisi('u2', 40), kisi('u3', 40)], satirlar: [uc, gec] });
  assert.deepStrictEqual(v.sonuclar.map((s) => s.durum), ['vazgecildi', 'vazgecildi']);
  assert.strictEqual(v.giden.length, 0);
});

test('B4: ortak gunluk tavan dolunca durur (kod da uretilmez); kisi hatasi digerlerini durdurmaz', async () => {
  const r = await tur({ kullanicilar: [kisi('u1', 37), kisi('u2', 37), kisi('u3', 37)], env: { ...ENV, EPOSTA_GUNLUK: '2' } });
  assert.deepStrictEqual(r.sonuclar.map((s) => s.durum), ['gonderildi', 'gonderildi', 'tavan']);
  assert.strictEqual(r.stripe.olusan.length, 2);
  kota._sifirla();
  let n = 0;
  const h = await tur({ kullanicilar: [kisi('u1', 37), kisi('u2', 37)], posta: async () => { if (!n++) throw new Error('ag'); return { ok: true }; } });
  assert.deepStrictEqual(h.sonuclar.map((s) => s.durum), ['hata', 'gonderildi']);
});

test('B5: sayfa sayfa butun kullanicilar okunur', async () => {
  const cok = Array.from({ length: 2500 }, (_, i) => ({ id: `k${i}` }));
  const sb = sahteSb(cok);
  assert.strictEqual((await GK.kullanicilar(sb, 1000)).length, 2500);
});

test('C1: olcum: gonderilen ve kullanilan kod (Stripe times_redeemed); okunamayan "bilinmiyor"', async () => {
  const sat = (id, promo) => ({ user_id: id, durum: 'gonderildi', stripe_promosyon_id: promo, gecerlilik: 't', gonderildi: 't', promosyon_kodu: 'X', deneme: 1 });
  const sb = sahteSb([], [sat('a', 'promo_1'), sat('b', 'promo_2'), sat('c', 'promo_bozuk'), { ...sat('d', 'promo_3'), durum: 'hazirlandi' }]);
  const r = await GK.olcum({ sb, stripe: sahteStripe() });
  assert.deepStrictEqual(r, { gonderilen: 3, kullanilan: 1, bilinmiyor: 1, oran: 50 });
});

test('C2: zamanlama: gunde bir, hatirlatmadan (16) sonra 17 UTC; eksik ayarla zamanlayici kurulmaz', () => {
  assert.ok(!GK.zamaniGeldiMi(new Date('2026-11-07T16:59:00Z'), null, {}));
  assert.ok(GK.zamaniGeldiMi(new Date('2026-11-07T17:00:00Z'), null, {}));
  assert.ok(!GK.zamaniGeldiMi(new Date('2026-11-07T18:00:00Z'), '2026-11-07', {}));
  assert.ok(GK.zamaniGeldiMi(new Date('2026-11-07T09:00:00Z'), null, { GERI_KAZANMA_SAATI: '9' }));
  assert.strictEqual(GK.zamanlayiciBaslat({}, { env: { SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'k', STRIPE_SECRET_KEY: 's' } }), null, 'kuponsuz');
  assert.strictEqual(GK.zamanlayiciBaslat({}, { env: { ...ENV, SUPABASE_URL: 'x', STRIPE_SECRET_KEY: 's', GERI_KAZANMA_ZAMANLAYICI: 'kapali' } }), null);
  const idx = require('node:fs').readFileSync(require('node:path').join(__dirname, 'index.js'), 'utf8');
  assert.ok(idx.indexOf("require('./lib/geri-kazanma').zamanlayiciBaslat") > idx.indexOf("require('./lib/hatirlatma').zamanlayiciBaslat"));
});

test('C3: olcum ucu yalnizca admin', async () => {
  const yolA = require.resolve('./middleware/auth');
  const gercek = require('./middleware/auth');
  const eskiA = require.cache[yolA];
  for (const [kullanici, beklenen] of [[null, 401], [{ id: 'u', app_metadata: {} }, 403], [{ id: 'u', app_metadata: { role: 'admin' } }, 503]]) {
    require.cache[yolA] = { id: yolA, filename: yolA, loaded: true, exports: { ...gercek,
      requireAuth: async (q, r) => { if (!kullanici) return r.code(401).send({ error: 'auth' }); q.user = kullanici; } } };
    delete require.cache[require.resolve('./routes/eposta')];
    const app = require('fastify')({ logger: false });
    await app.register(require('./routes/eposta'), { prefix: '/api/v1/eposta' });
    const r = await app.inject({ method: 'GET', url: '/api/v1/eposta/geri-kazanma/olcum' });
    assert.strictEqual(r.statusCode, beklenen, JSON.stringify(kullanici));   // admin: Stripe yok -> 503, veri sizmaz
    await app.close();
  }
  if (eskiA) require.cache[yolA] = eskiA; else delete require.cache[yolA];
  delete require.cache[require.resolve('./routes/eposta')];
});
