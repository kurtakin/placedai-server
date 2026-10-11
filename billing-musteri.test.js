/**
 * billing-musteri.test.js — K116 (11 Ekim 2026): Stripe test/canli musteri
 * kimligi uyusmazligi.
 *
 * Calistir: node --test billing-musteri.test.js
 *
 * Sandbox'ta odeme sayfasi acmis hesaplarda app_metadata.stripe_customer_id bir
 * TEST musterisi. Canli anahtarla bu kimlik yoktur. Kilitlenenler:
 *   M1  kimlik yoksa: eskisi gibi bir musteri acilir
 *   M2  kimlik bu ortamda VARSA: dokunulmaz (gercek musteri/abonelik korunur)
 *   M3  Stripe KESIN "No such customer" derse: tek yeni musteri, eski iz olarak
 *       saklanir, PLAN DEGISMEZ (bayat istek plani geri yazmaz)
 *   M4  tekrar gelen istek (bayat oturum / cift tiklama): ikinci musteri YOK
 *   M5  baglanti / hiz siniri / yetki / izin / Stripe ici hata: yeni musteri YOK
 *   M6  baska 404'ler ve baska gecersiz istekler: yeni musteri YOK
 *   M7  silinmis musteri: yeni musteri
 *   M8  kayit yazilamazsa odeme yine surer, tekrar istekte yine tek musteri
 *   M9  portal: musteri yoksa 400 "henuz abonelik yok", hicbir sey olusturulmaz
 *   M10 odeme oturumu parametreleri (fiyat, metadata, donus adresleri) ayni
 *   M11 hata tanima gercek Stripe hata nesneleriyle
 */
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert');

process.env.STRIPE_SECRET_KEY = 'sk_test_sahte';
process.env.SUPABASE_URL = 'https://sahte.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'sahte';
process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_m';
process.env.STRIPE_PRICE_PRO_YEARLY = 'price_pro_y';
process.env.STRIPE_PRICE_ULTIMATE_MONTHLY = 'price_ult_m';
process.env.STRIPE_PRICE_ULTIMATE_YEARLY = 'price_ult_y';
delete process.env.STRIPE_MANAGED_PAYMENTS;

const GERCEK = require('stripe');
const E = GERCEK.errors;
const yokHatasi = (id, param = 'id') => E.StripeError.generate({ type: 'invalid_request_error', code: 'resource_missing', param, statusCode: 404,
  message: `No such customer: '${id}'; a similar object exists in test mode, but a live mode key was used to make this request.` });

const sahte = (yol, exportsObj) => {
  const r = require.resolve(yol);
  require.cache[r] = { id: r, filename: r, loaded: true, exports: exportsObj };
};

// ── Istek sahibi (auth) ──────────────────────────────────────────────────────
let istekKullanicisi;
sahte('./middleware/auth', { requireAuth: async (req) => { req.user = istekKullanicisi; }, requirePlan: () => async () => {}, optionalAuth: async () => {} });
sahte('./lib/usage', { getUsage: async () => ({}), getLiveUsage: async () => ({}) });
sahte('./lib/davet', { arkadasIndirimi: async () => null });
sahte('./lib/olay', { olayYaz: async () => true });

// ── Supabase (app_metadata bellekte) ─────────────────────────────────────────
let db;   // { [userId]: app_metadata }
let dbYazmaHatasi;
sahte('@supabase/supabase-js', { createClient: () => ({ auth: { admin: {
  getUserById: async (id) => ({ data: { user: { id, app_metadata: { ...(db[id] || {}) } } }, error: null }),
  updateUserById: async (id, { app_metadata }) => {
    if (dbYazmaHatasi) return { error: { message: 'yazilamadi' } };
    db[id] = { ...app_metadata }; return { error: null };
  },
} } }) });

// ── Stripe (gercek hata nesneleri, bellekte musteriler) ─────────────────────
let st;
function sifirla() {
  st = { musteriler: {}, sayac: 0, idem: new Map(), olusturulan: [], oturumlar: [], portallar: [], retrieveHata: null, retrieveCagri: 0 };
  db = {}; dbYazmaHatasi = false;
}
function SahteStripe() {
  return {
    customers: {
      retrieve: async (id) => {
        st.retrieveCagri++;
        if (st.retrieveHata) throw st.retrieveHata;
        if (!st.musteriler[id]) throw yokHatasi(id);
        return st.musteriler[id];
      },
      create: async (params, opts = {}) => {
        if (opts.idempotencyKey && st.idem.has(opts.idempotencyKey)) return st.idem.get(opts.idempotencyKey);
        const c = { id: `cus_canli_${++st.sayac}`, object: 'customer', ...params };
        st.musteriler[c.id] = c; st.olusturulan.push({ params, opts });
        if (opts.idempotencyKey) st.idem.set(opts.idempotencyKey, c);
        return c;
      },
    },
    checkout: { sessions: { create: async (p) => {
      if (!st.musteriler[p.customer] || st.musteriler[p.customer].deleted) throw yokHatasi(p.customer, 'customer');
      st.oturumlar.push(p); return { id: `cs_test_${st.oturumlar.length}`, url: 'https://checkout.stripe.com/x', livemode: false };
    } } },
    billingPortal: { sessions: { create: async (p) => {
      if (st.portalHata) throw st.portalHata;
      if (!st.musteriler[p.customer]) throw yokHatasi(p.customer, 'customer');
      st.portallar.push(p); return { url: 'https://billing.stripe.com/p' };
    } } },
  };
}
SahteStripe.errors = E;
sahte('stripe', SahteStripe);

const billing = require('./routes/billing');

async function istek(yol, govde) {
  const Fastify = require('fastify');
  const app = Fastify({ logger: false });
  await app.register(billing, { prefix: '/api/v1/billing' });
  await app.ready();
  try {
    const r = await app.inject({ method: 'POST', url: `/api/v1/billing/${yol}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(govde || {}) });
    return { kod: r.statusCode, govde: r.json() };
  } finally { await app.close(); }
}
const odeme = (plan = 'pro', period = 'monthly') => istek('checkout', { plan, period });
const kullanici = (meta, email = 'a@ornek.com') => { istekKullanicisi = { id: 'u-1', email, app_metadata: { ...meta } }; };

test('M1: kayitli kimlik yok -> eskisi gibi bir musteri acilir ve kaydedilir', async () => {
  sifirla(); kullanici({ plan: 'free' }); db['u-1'] = { plan: 'free' };
  const r = await odeme();
  assert.strictEqual(r.kod, 200);
  assert.strictEqual(st.olusturulan.length, 1);
  assert.strictEqual(st.retrieveCagri, 0, 'kimlik yokken Stripe sorgulanmaz');
  assert.strictEqual(db['u-1'].stripe_customer_id, 'cus_canli_1');
  assert.strictEqual(st.oturumlar[0].customer, 'cus_canli_1');
});

test('M2: kimlik bu ortamda VAR -> dokunulmaz, yeni musteri yok, kayit yazilmaz', async () => {
  sifirla();
  st.musteriler.cus_gercek = { id: 'cus_gercek', object: 'customer' };
  kullanici({ plan: 'pro', stripe_customer_id: 'cus_gercek', subscription_status: 'active' });
  db['u-1'] = { plan: 'pro', stripe_customer_id: 'cus_gercek', subscription_status: 'active', role: 'admin' };
  const once = JSON.stringify(db['u-1']);
  const r = await odeme('ultimate', 'yearly');
  assert.strictEqual(r.kod, 200);
  assert.strictEqual(st.olusturulan.length, 0);
  assert.strictEqual(JSON.stringify(db['u-1']), once);
  assert.strictEqual(st.oturumlar[0].customer, 'cus_gercek');
});

test('M3: Stripe kesin "No such customer" -> tek yeni musteri, eski iz, plan ve diger alanlar korunur', async () => {
  sifirla();
  // Veritabaninda plan pro (webhook az once yazdi); istekteki oturum bayat: free.
  db['u-1'] = { plan: 'pro', role: 'admin', stripe_customer_id: 'cus_test_ESKI', billing_anchor: '2026-10-01T00:00:00.000Z' };
  kullanici({ plan: 'free', stripe_customer_id: 'cus_test_ESKI' });
  const r = await odeme();
  assert.strictEqual(r.kod, 200, JSON.stringify(r.govde));
  assert.strictEqual(st.olusturulan.length, 1);
  assert.deepStrictEqual(st.olusturulan[0].params.metadata, { user_id: 'u-1', onceki_musteri: 'cus_test_ESKI' });
  assert.match(st.olusturulan[0].opts.idempotencyKey, /^placedai-musteri-yenile:u-1:cus_test_ESKI:a@ornek\.com$/);
  assert.deepStrictEqual(db['u-1'], { plan: 'pro', role: 'admin', billing_anchor: '2026-10-01T00:00:00.000Z',
    stripe_customer_id: 'cus_canli_1', stripe_customer_id_onceki: 'cus_test_ESKI' });
  assert.strictEqual(st.oturumlar[0].customer, 'cus_canli_1');
});

test('M4: tekrar gelen istek (bayat oturum, cift tiklama) ikinci musteri ACMAZ', async () => {
  sifirla(); db['u-1'] = { plan: 'free', stripe_customer_id: 'cus_test_ESKI' };
  kullanici({ plan: 'free', stripe_customer_id: 'cus_test_ESKI' });
  await Promise.all([odeme(), odeme()]);
  await odeme();   // oturum hala eski kimligi tasiyor (60 sn onbellek)
  assert.strictEqual(Object.keys(st.musteriler).length, 1, 'Stripe tarafinda tek musteri');
  assert.strictEqual(st.oturumlar.length, 3);
  assert.ok(st.oturumlar.every((o) => o.customer === 'cus_canli_1'));
  // Oturum tazelenince: kimlik artik var, Stripe'a yeni musteri istegi bile gitmez
  kullanici({ plan: 'free', stripe_customer_id: 'cus_canli_1' });
  const tekrar = st.olusturulan.length;
  await odeme();
  assert.strictEqual(st.olusturulan.length, tekrar);
});

test('M5: baglanti, hiz siniri, yetki, izin, Stripe ici hata -> yeni musteri YOK, kayit degismez', async () => {
  const hatalar = {
    baglanti: new E.StripeConnectionError({ message: 'An error occurred with our connection to Stripe.' }),
    hiz:      E.StripeError.generate({ type: 'invalid_request_error', code: 'rate_limit', statusCode: 429, message: 'Too many requests' }),
    yetki:    new E.StripeAuthenticationError({ message: 'Invalid API Key provided', statusCode: 401 }),
    izin:     new E.StripePermissionError({ message: 'The provided key does not have access', statusCode: 403 }),
    api:      new E.StripeAPIError({ message: 'Something went wrong on Stripe\'s end.', statusCode: 500 }),
    duz:      new Error('ECONNRESET'),
  };
  for (const [ad, hata] of Object.entries(hatalar)) {
    sifirla(); st.retrieveHata = hata;
    db['u-1'] = { plan: 'pro', stripe_customer_id: 'cus_belki_gercek' };
    kullanici({ plan: 'pro', stripe_customer_id: 'cus_belki_gercek' });
    const r = await odeme();
    assert.strictEqual(r.kod, 500, ad);
    assert.strictEqual(st.olusturulan.length, 0, `${ad}: musteri acildi`);
    assert.strictEqual(st.oturumlar.length, 0, ad);
    assert.deepStrictEqual(db['u-1'], { plan: 'pro', stripe_customer_id: 'cus_belki_gercek' }, ad);
  }
});

test('M6: baska 404 ve baska gecersiz istekler "musteri yok" sayilmaz', async () => {
  const hatalar = [
    E.StripeError.generate({ type: 'invalid_request_error', code: 'resource_missing', statusCode: 404, param: 'price', message: "No such price: 'price_x'" }),
    E.StripeError.generate({ type: 'invalid_request_error', code: 'resource_missing', statusCode: 404, param: 'id', message: "No such customerx: 'cus_1'" }),
    E.StripeError.generate({ type: 'invalid_request_error', code: 'parameter_invalid', statusCode: 400, param: 'id', message: "No such customer: 'cus_1'" }),
    E.StripeError.generate({ type: 'invalid_request_error', statusCode: 404, message: "No such customer: 'cus_1'" }),
    E.StripeError.generate({ type: 'invalid_request_error', code: 'resource_missing', statusCode: 400, param: 'id', message: "No such customer: 'cus_1'" }),
  ];
  for (const [i, hata] of hatalar.entries()) {
    sifirla(); st.retrieveHata = hata;
    db['u-1'] = { plan: 'free', stripe_customer_id: 'cus_1' }; kullanici({ plan: 'free', stripe_customer_id: 'cus_1' });
    const r = await odeme();
    assert.strictEqual(r.kod, 500, `hata ${i}`);
    assert.strictEqual(st.olusturulan.length, 0, `hata ${i}`);
  }
});

test('M7: silinmis musteri (deleted: true) -> yeni musteri, eski iz', async () => {
  sifirla(); st.musteriler.cus_silinmis = { id: 'cus_silinmis', deleted: true };
  db['u-1'] = { plan: 'free', stripe_customer_id: 'cus_silinmis' }; kullanici({ plan: 'free', stripe_customer_id: 'cus_silinmis' });
  const r = await odeme();
  assert.strictEqual(r.kod, 200);
  assert.strictEqual(db['u-1'].stripe_customer_id, 'cus_canli_1');
  assert.strictEqual(db['u-1'].stripe_customer_id_onceki, 'cus_silinmis');
});

test('M8: kayit yazilamazsa odeme yine surer; tekrar istekte yine TEK musteri', async () => {
  sifirla(); dbYazmaHatasi = true;
  db['u-1'] = { plan: 'free', stripe_customer_id: 'cus_test_ESKI' }; kullanici({ plan: 'free', stripe_customer_id: 'cus_test_ESKI' });
  assert.strictEqual((await odeme()).kod, 200);
  assert.strictEqual((await odeme()).kod, 200);
  assert.strictEqual(Object.keys(st.musteriler).length, 1);
  assert.strictEqual(db['u-1'].stripe_customer_id, 'cus_test_ESKI', 'yazilamadi, eski deger duruyor');
  assert.ok(st.oturumlar.every((o) => o.customer === 'cus_canli_1'));
  // e-posta degisirse farkli anahtar: Stripe ayni anahtarla farkli govdeyi reddederdi
  kullanici({ plan: 'free', stripe_customer_id: 'cus_test_ESKI' }, 'b@ornek.com');
  assert.strictEqual((await odeme()).kod, 200);
});

test('M9: portal: musteri bu ortamda yoksa 400 "henuz abonelik yok", hicbir sey olusturulmaz', async () => {
  sifirla(); db['u-1'] = { plan: 'free', stripe_customer_id: 'cus_test_ESKI' }; kullanici({ plan: 'free', stripe_customer_id: 'cus_test_ESKI' });
  let r = await istek('portal');
  assert.strictEqual(r.kod, 400);
  assert.deepStrictEqual(r.govde, { error: 'You do not have a subscription yet.' });
  assert.strictEqual(st.olusturulan.length, 0);
  assert.deepStrictEqual(db['u-1'], { plan: 'free', stripe_customer_id: 'cus_test_ESKI' });
  // var olan musteri: portal acilir
  st.musteriler.cus_gercek = { id: 'cus_gercek' }; kullanici({ plan: 'pro', stripe_customer_id: 'cus_gercek' });
  r = await istek('portal');
  assert.strictEqual(r.kod, 200);
  assert.strictEqual(r.govde.url, 'https://billing.stripe.com/p');
  // gecici hata: eskisi gibi 500, "abonelik yok" denmez
  st.portalHata = new E.StripeConnectionError({ message: 'baglanti' });
  r = await istek('portal');
  assert.strictEqual(r.kod, 500);
  // kimlik hic yoksa: eskisi gibi
  kullanici({ plan: 'free' }); st.portalHata = null;
  r = await istek('portal');
  assert.strictEqual(r.kod, 400);
});

test('M10: odeme oturumu parametreleri ayni (fiyat, metadata, donus adresleri, kod alani)', async () => {
  sifirla(); db['u-1'] = { plan: 'free', stripe_customer_id: 'cus_test_ESKI' }; kullanici({ plan: 'free', stripe_customer_id: 'cus_test_ESKI' });
  await odeme('ultimate', 'yearly');
  assert.deepStrictEqual(st.oturumlar[0], {
    mode: 'subscription', customer: 'cus_canli_1', line_items: [{ price: 'price_ult_y', quantity: 1 }],
    client_reference_id: 'u-1', subscription_data: { metadata: { user_id: 'u-1', plan: 'ultimate' } },
    allow_promotion_codes: true,
    success_url: 'https://www.placedai.app/dashboard?checkout=success&plan=ultimate',
    cancel_url: 'https://www.placedai.app/#pricing',
  });
});

test('M11: hata tanima gercek Stripe hata nesneleriyle', () => {
  const yok = billing._musteriYokHatasi;
  assert.strictEqual(yok(yokHatasi('cus_1')), true);
  assert.strictEqual(yok(yokHatasi('cus_1', 'customer')), true);
  assert.strictEqual(yok(E.StripeError.generate({ type: 'invalid_request_error', code: 'resource_missing', statusCode: 404, message: "No such customer: 'cus_1'" })), true);
  assert.strictEqual(yok(new E.StripeConnectionError({ message: "No such customer: 'cus_1'" })), false);
  assert.strictEqual(yok(new E.StripeAuthenticationError({ message: "No such customer", statusCode: 404 })), false);
  assert.strictEqual(yok(null), false);
  assert.strictEqual(yok(new Error("No such customer: 'cus_1'")), false);
});
