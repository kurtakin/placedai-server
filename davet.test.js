/**
 * davet.test.js — Arkadas daveti (K89, 1 Ekim 2026).
 *
 * Kullanicinin kararlari (DEVAM.md K87/K89): kisisel baglanti; davet edilen
 * odeyip 14 gun iadesiz/aktif kalinca sayilir; her 2 = 1 ay ucretsiz, yilda en
 * fazla 6; Free davetciye 30 gun Pro, ucretliye sonraki faturada %100 kupon;
 * arkadasa ilk ay %15; ayni kartla kendini davet sayilmaz; davet eden kimi
 * davet ettigini gormez.
 *
 * Calistir: node --test
 */
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert');

const D = require('./lib/davet');
const { DAVET } = require('./lib/hata-kodlari');

const GUN = 86400000;
const SIMDI = new Date('2026-12-01T18:30:00Z');

/** Bellekte Postgres benzeri tablolar + auth.admin. Benzersizlik ihlali 23505. */
function sahteSb({ tablolar = {}, kullanicilar = [] } = {}) {
  const T = { ia_davet_kodlari: [], ia_davetler: [], ia_davet_odulleri: [], ...JSON.parse(JSON.stringify(tablolar)) };
  const ANAHTAR = { ia_davet_kodlari: ['user_id', 'kod'], ia_davetler: ['davet_edilen'], ia_davet_odulleri: ['id'] };
  const U = new Map(kullanicilar.map((u) => [u.id, JSON.parse(JSON.stringify(u))]));
  let sira = 0;
  const from = (ad) => {
    const kosul = []; let islem = 'select'; let veri = null; let tek = false; let donus = false;
    const z = {
      select: () => { donus = true; return z; },
      eq: (k, v) => { kosul.push((r) => r[k] === v); return z; },
      neq: (k, v) => { kosul.push((r) => r[k] !== v); return z; },
      lte: (k, v) => { kosul.push((r) => r[k] != null && r[k] <= v); return z; },
      order: () => z, limit: () => z,
      maybeSingle: () => { tek = true; return z; },
      insert: (r) => { islem = 'insert'; veri = Array.isArray(r) ? r : [r]; return z; },
      update: (r) => { islem = 'update'; veri = r; return z; },
      then: (ok, h) => {
        const uy = (r) => kosul.every((f) => f(r));
        let s;
        if (islem === 'insert') {
          s = { data: null, error: null };
          for (const r of veri) {
            const yeni = { ...(ad === 'ia_davet_odulleri' ? { id: `o${++sira}`, durum: 'bekliyor', created_at: SIMDI.toISOString() } : {}), ...(ad === 'ia_davetler' ? { durum: 'kayit' } : {}), ...r };
            if ((ANAHTAR[ad] || []).some((k) => T[ad].some((x) => x[k] === yeni[k]))) { s = { data: null, error: { code: '23505', message: 'duplicate' } }; break; }
            T[ad].push(yeni);
          }
        } else if (islem === 'update') {
          const b = T[ad].filter(uy); for (const r of b) Object.assign(r, veri);
          s = { data: donus ? b : null, error: null };
        } else {
          const b = T[ad].filter(uy);
          s = { data: tek ? (b[0] || null) : b, error: null };
        }
        return Promise.resolve(s).then(ok, h);
      },
    };
    return z;
  };
  const admin = {
    getUserById: async (id) => ({ data: U.has(id) ? { user: U.get(id) } : null, error: U.has(id) ? null : { message: 'yok' } }),
    updateUserById: async (id, { app_metadata }) => { U.get(id).app_metadata = app_metadata; return { data: {}, error: null }; },
    listUsers: async ({ page, perPage }) => ({ data: { users: [...U.values()].slice((page - 1) * perPage, page * perPage) }, error: null }),
  };
  return { T, U, from, auth: { admin } };
}

function sahteStripe({ abonelikler = {}, ucretler = {}, kartlar = {}, pm = {}, kupon = { valid: true, percent_off: 100, duration: 'once' } } = {}) {
  const guncellenen = [];
  return { guncellenen,
    subscriptions: {
      retrieve: async (id) => abonelikler[id] || { id, status: 'canceled' },
      list: async ({ customer }) => ({ data: Object.values(abonelikler).filter((s) => s.customer === customer && s.status === 'active') }),
      update: async (id, p) => { guncellenen.push([id, p]); return { id }; },
    },
    charges: { list: async ({ customer }) => ({ data: ucretler[customer] || [] }) },
    paymentMethods: {
      list: async ({ customer }) => ({ data: (kartlar[customer] || []).map((f) => ({ card: { fingerprint: f } })) }),
      retrieve: async (id) => pm[id] || { card: null },
    },
    coupons: { retrieve: async (id) => { if (id !== 'cpn_100') throw new Error('yok'); return kupon; } },
  };
}

const UA = 'aaaaaaaa-0000-4000-8000-00000000000a';
const UB = 'bbbbbbbb-0000-4000-8000-00000000000b';
const UC = 'cccccccc-0000-4000-8000-00000000000c';
const yeni = (id, ek = {}) => ({ id, created_at: new Date(+SIMDI - 2 * GUN).toISOString(), app_metadata: { plan: 'free' }, ...ek });

// ── Kod ve baglanma ─────────────────────────────────────────────────────────
test('A1: kod: 8 karakter, karisan harf/rakam yok (O 0 I 1); kucuk harf kabul edilir', () => {
  for (let i = 0; i < 200; i++) assert.match(D.kodUret(), /^[A-HJ-NP-Z2-9]{8}$/);
  assert.strictEqual(D.kodTemizle(' abcd2345 '), 'ABCD2345');
  for (const k of ['ABCD234', 'ABCD23456', 'ABCD0345', 'ABCDI345', "AB'--345", null, 42]) assert.strictEqual(D.kodTemizle(k), null, String(k));
});

test('A2: kod kisi basina bir; ikinci istekte ayni kod; cakisirsa yeniden uretir', async () => {
  const sb = sahteSb({ tablolar: { ia_davet_kodlari: [{ user_id: UC, kod: 'AAAAAAAA' }] } });
  let n = 0;
  const rastgele = () => Buffer.alloc(8, n++ === 0 ? 0 : 1);   // ilk deneme 'AAAAAAAA' (cakisma), sonra 'BBBBBBBB'
  assert.strictEqual(await D.kodGetir(sb, UA, rastgele), 'BBBBBBBB');
  assert.strictEqual(await D.kodGetir(sb, UA, rastgele), 'BBBBBBBB');
  assert.strictEqual(sb.T.ia_davet_kodlari.filter((r) => r.user_id === UA).length, 1);
});

test('A3: baglanma: yalnizca yeni (14 gun), hic odememis, baskasinin gecerli koduyla; bir kez', async () => {
  const sb = sahteSb({ tablolar: { ia_davet_kodlari: [{ user_id: UA, kod: 'ABCD2345' }] } });
  assert.deepStrictEqual(await D.baglan(sb, yeni(UB), 'abcd2345', SIMDI), { ok: true });
  assert.deepStrictEqual(sb.T.ia_davetler, [{ durum: 'kayit', davet_edilen: UB, davet_eden: UA }]);
  assert.deepStrictEqual(await D.baglan(sb, yeni(UB), 'ABCD2345', SIMDI), { neden: 'zaten' });
  assert.deepStrictEqual(await D.baglan(sb, yeni(UA), 'ABCD2345', SIMDI), { neden: 'kendisi' });
  assert.deepStrictEqual(await D.baglan(sb, yeni(UC), 'ZZZZ2345', SIMDI), { neden: 'yok' });
  assert.deepStrictEqual(await D.baglan(sb, yeni(UC), 'x', SIMDI), { neden: 'kod' });
  assert.deepStrictEqual(await D.baglan(sb, yeni(UC, { created_at: new Date(+SIMDI - 15 * GUN).toISOString() }), 'ABCD2345', SIMDI), { neden: 'eski' });
  assert.deepStrictEqual(await D.baglan(sb, yeni(UC, { app_metadata: { plan: 'free', subscription_status: 'canceled' } }), 'ABCD2345', SIMDI), { neden: 'odemis' });
  assert.strictEqual(sb.T.ia_davetler.length, 1);
});

test('A4: arkadas indirimi: davetli + hic odememis + kupon tanimli', async () => {
  const sb = sahteSb({ tablolar: { ia_davetler: [{ davet_edilen: UB, davet_eden: UA, durum: 'kayit' }] } });
  const env = { STRIPE_GERI_KAZANMA_KUPON: 'cpn_15' };
  assert.strictEqual(await D.arkadasIndirimi(sb, yeni(UB), env), 'cpn_15');
  assert.strictEqual(await D.arkadasIndirimi(sb, yeni(UC), env), null, 'davetsiz');
  assert.strictEqual(await D.arkadasIndirimi(sb, yeni(UB), {}), null, 'kuponsuz');
  assert.strictEqual(await D.arkadasIndirimi(sb, yeni(UB, { app_metadata: { subscription_status: 'canceled' } }), env), null, 'daha once odemis');
  sb.T.ia_davetler[0].durum = 'odedi';
  assert.strictEqual(await D.arkadasIndirimi(sb, yeni(UB), env), null, 'davet kaydi odemis gorunuyor (metadata gecikse de) ikinci indirim yok');
});

test('A5: ozet yalnizca sayilar (kimlik yok); sonraki odul icin kalan; yillik kalan', async () => {
  const sb = sahteSb({ tablolar: {
    ia_davet_kodlari: [{ user_id: UA, kod: 'ABCD2345' }],
    ia_davetler: [{ davet_edilen: UB, davet_eden: UA, durum: 'sayildi' }, { davet_edilen: UC, davet_eden: UA, durum: 'odedi' }, { davet_edilen: 'x', davet_eden: UA, durum: 'kayit' }],
    ia_davet_odulleri: [{ id: 'o1', user_id: UA, durum: 'verildi', created_at: new Date(+SIMDI - 400 * GUN).toISOString() }],
  } });
  const o = await D.ozet(sb, UA, { simdi: SIMDI, env: {} });
  assert.deepStrictEqual(o, { kod: 'ABCD2345', link: 'https://www.placedai.app/?ref=ABCD2345', kayit: 3, odedi: 1, sayildi: 1, sonraki_icin: 1,
    odul: 1, bekleyen_odul: 0, yillik_kalan: 6, kurallar: { kisi_basina: 2, bekleme_gun: 14, yillik_tavan: 6, arkadas_indirim: 15 } });
  assert.ok(!JSON.stringify(o).includes(UB), 'davet edilenin kimligi sizdi');
});

// ── Odeme ve degerlendirme ──────────────────────────────────────────────────
test('B1: ilk odeme yalnizca "kayit" satirina yazilir; kart parmak izi abonelikten', async () => {
  const sb = sahteSb({ tablolar: { ia_davetler: [{ davet_edilen: UB, davet_eden: UA, durum: 'kayit' }] } });
  const st = sahteStripe({ pm: { pm_1: { card: { fingerprint: 'fpB' } } } });
  assert.strictEqual(await D.odemeKaydet(sb, st, { userId: UB, sub: { id: 'sub_B', default_payment_method: 'pm_1' }, zaman: SIMDI }), true);
  assert.deepStrictEqual([sb.T.ia_davetler[0].durum, sb.T.ia_davetler[0].kart_izi, sb.T.ia_davetler[0].abonelik_id], ['odedi', 'fpB', 'sub_B']);
  assert.strictEqual(await D.odemeKaydet(sb, st, { userId: UB, sub: { id: 'sub_B2' }, zaman: SIMDI }), false, 'ikinci odeme ilk odemeyi ezdi');
  assert.strictEqual(sb.T.ia_davetler[0].abonelik_id, 'sub_B');
  assert.strictEqual(await D.odemeKaydet(sb, st, { userId: UC, sub: { id: 'sub_C' } }), false, 'davetsiz kisi');
});

test('B2: degerlendirme: 14 gun dolmadan dokunulmaz; iptal, iade/itiraz, ayni kart gecersiz; temiz olan sayilir', async () => {
  const od = (gun) => new Date(+SIMDI - gun * GUN).toISOString();
  const sb = sahteSb({ tablolar: { ia_davetler: [
    { davet_edilen: 'e1', davet_eden: UA, durum: 'odedi', ilk_odeme: od(15), abonelik_id: 's1', kart_izi: 'f1' },
    { davet_edilen: 'e2', davet_eden: UA, durum: 'odedi', ilk_odeme: od(13), abonelik_id: 's2', kart_izi: 'f2' },
    { davet_edilen: 'e3', davet_eden: UA, durum: 'odedi', ilk_odeme: od(20), abonelik_id: 's3', kart_izi: 'f3' },
    { davet_edilen: 'e4', davet_eden: UA, durum: 'odedi', ilk_odeme: od(20), abonelik_id: 's4', kart_izi: 'f4' },
    { davet_edilen: 'e5', davet_eden: UA, durum: 'odedi', ilk_odeme: od(20), abonelik_id: 's5', kart_izi: 'fA' },
    { davet_edilen: 'e6', davet_eden: UA, durum: 'odedi', ilk_odeme: od(20), abonelik_id: 's6', kart_izi: 'f1' },
  ] } });
  const st = sahteStripe({
    abonelikler: { s1: { id: 's1', status: 'active', customer: 'c1' }, s3: { id: 's3', status: 'canceled', customer: 'c3' },
      s4: { id: 's4', status: 'active', customer: 'c4' }, s5: { id: 's5', status: 'active', customer: 'c5' }, s6: { id: 's6', status: 'active', customer: 'c6' } },
    ucretler: { c4: [{ refunded: false, amount_refunded: 500 }] },
    kartlar: { cA: ['fA'] },
  });
  const davetci = { id: UA, app_metadata: { stripe_customer_id: 'cA' } };
  const r = await D.degerlendir({ sb, stripe: st, kullaniciGetir: async () => davetci, simdi: SIMDI });
  const durum = Object.fromEntries(sb.T.ia_davetler.map((x) => [x.davet_edilen, [x.durum, x.gecersiz_neden || null]]));
  assert.deepStrictEqual(durum, {
    e1: ['sayildi', null], e2: ['odedi', null], e3: ['gecersiz', 'iptal'], e4: ['gecersiz', 'iade'],
    e5: ['gecersiz', 'ayni_kart'], e6: ['gecersiz', 'ayni_kart'],
  });
  assert.ok(sb.T.ia_davetler.find((x) => x.davet_edilen === 'e1').sayildi);
  assert.strictEqual(r.length, 5);
});

// ── Oduller ─────────────────────────────────────────────────────────────────
test('C1: odul sayisi: her 2 sayilana 1; son 365 gunde en fazla 6', () => {
  const o = (gun) => ({ created_at: new Date(+SIMDI - gun * GUN).toISOString() });
  assert.strictEqual(D.yeniOdulSayisi({ sayildi: 1, oduller: [], simdi: SIMDI }), 0);
  assert.strictEqual(D.yeniOdulSayisi({ sayildi: 2, oduller: [], simdi: SIMDI }), 1);
  assert.strictEqual(D.yeniOdulSayisi({ sayildi: 5, oduller: [o(1)], simdi: SIMDI }), 1);
  assert.strictEqual(D.yeniOdulSayisi({ sayildi: 30, oduller: [], simdi: SIMDI }), 6, 'yillik tavan');
  assert.strictEqual(D.yeniOdulSayisi({ sayildi: 30, oduller: Array.from({ length: 6 }, () => o(10)), simdi: SIMDI }), 0);
  assert.strictEqual(D.yeniOdulSayisi({ sayildi: 30, oduller: Array.from({ length: 6 }, () => o(400)), simdi: SIMDI }), 6, 'eski yilin odulleri tavana sayilmaz');
});

test('C2: odul hesaplama ikinci kez calisinca cift odul yazmaz', async () => {
  const sb = sahteSb({ tablolar: { ia_davetler: ['e1', 'e2', 'e3', 'e4', 'e5'].map((e) => ({ davet_edilen: e, davet_eden: UA, durum: 'sayildi' })) } });
  assert.strictEqual(await D.odulleriHesapla({ sb, simdi: SIMDI }), 2);
  assert.strictEqual(await D.odulleriHesapla({ sb, simdi: SIMDI }), 0);
  assert.strictEqual(sb.T.ia_davet_odulleri.length, 2);
});

test('C3: odul verme: Free davetciye 30 gun Pro (ust uste); rol korunur', async () => {
  const bitis0 = new Date(+SIMDI + 10 * GUN).toISOString();
  const sb = sahteSb({
    tablolar: { ia_davet_odulleri: [{ id: 'o1', user_id: UA, durum: 'bekliyor', created_at: 't1' }, { id: 'o2', user_id: UB, durum: 'bekliyor', created_at: 't2' }] },
    kullanicilar: [{ id: UA, app_metadata: { plan: 'free', role: 'admin' } }, { id: UB, app_metadata: { plan: 'pro', davet_pro_bitis: bitis0 } }],
  });
  const r = await D.odulleriVer({ sb, stripe: sahteStripe(), kullaniciGetir: async (id) => sb.U.get(id), simdi: SIMDI, env: {} });
  assert.deepStrictEqual(r.map((x) => x.sonuc), ['pro_erisim', 'pro_erisim']);
  assert.deepStrictEqual(sb.U.get(UA).app_metadata, { plan: 'pro', role: 'admin', davet_pro_bitis: new Date(+SIMDI + 30 * GUN).toISOString() });
  assert.strictEqual(sb.U.get(UB).app_metadata.davet_pro_bitis, new Date(Date.parse(bitis0) + 30 * GUN).toISOString(), 'ust uste eklenmedi');
  assert.deepStrictEqual(sb.T.ia_davet_odulleri.map((o) => [o.durum, o.tur]), [['verildi', 'pro_erisim'], ['verildi', 'pro_erisim']]);
});

test('C4: odul verme: ucretli davetciye sonraki faturada %100 kupon; kupon yanlis/yoksa bekler ve kaydedilir; bekleyen indirim varsa sirada', async () => {
  const mk = () => sahteSb({
    tablolar: { ia_davet_odulleri: [{ id: 'o1', user_id: UA, durum: 'bekliyor', created_at: 't' }] },
    kullanicilar: [{ id: UA, app_metadata: { plan: 'pro', subscription_status: 'active', stripe_customer_id: 'cA' } }],
  });
  const abonelik = { sA: { id: 'sA', status: 'active', customer: 'cA', discounts: [] } };
  const sb = mk(); const st = sahteStripe({ abonelikler: abonelik });
  const r = await D.odulleriVer({ sb, stripe: st, kullaniciGetir: async (id) => sb.U.get(id), simdi: SIMDI, env: { STRIPE_DAVET_KUPON: 'cpn_100' } });
  assert.deepStrictEqual(r[0].sonuc, 'fatura_kuponu');
  assert.deepStrictEqual(st.guncellenen, [['sA', { discounts: [{ coupon: 'cpn_100' }] }]]);
  assert.deepStrictEqual([sb.T.ia_davet_odulleri[0].durum, sb.T.ia_davet_odulleri[0].stripe_ref], ['verildi', 'sA']);
  assert.strictEqual(sb.U.get(UA).app_metadata.plan, 'pro');

  for (const [env, kupon] of [[{}, undefined], [{ STRIPE_DAVET_KUPON: 'cpn_100' }, { valid: true, percent_off: 50, duration: 'once' }], [{ STRIPE_DAVET_KUPON: 'cpn_100' }, { valid: true, percent_off: 100, duration: 'forever' }]]) {
    const sb2 = mk(); const kayit = [];
    const st2 = sahteStripe({ abonelikler: abonelik, ...(kupon ? { kupon } : {}) });
    const r2 = await D.odulleriVer({ sb: sb2, stripe: st2, kullaniciGetir: async (id) => sb2.U.get(id), simdi: SIMDI, env, hataKaydet: async (m) => kayit.push(m) });
    assert.deepStrictEqual([r2[0].sonuc, sb2.T.ia_davet_odulleri[0].durum, st2.guncellenen.length], ['kupon_sorunu', 'bekliyor', 0], JSON.stringify(kupon));
    assert.match(kayit[0], /Referral reward waiting/);
  }
  const sb3 = mk(); const st3 = sahteStripe({ abonelikler: { sA: { ...abonelik.sA, discounts: ['di_1'] } } });
  const r3 = await D.odulleriVer({ sb: sb3, stripe: st3, kullaniciGetir: async (id) => sb3.U.get(id), simdi: SIMDI, env: { STRIPE_DAVET_KUPON: 'cpn_100' } });
  assert.deepStrictEqual([r3[0].sonuc, st3.guncellenen.length, sb3.T.ia_davet_odulleri[0].durum], ['sirada', 0, 'bekliyor']);
});

test('C5: suresi biten odul Pro erisimi Free\'ye doner; bu arada abone olana dokunulmaz', async () => {
  const gecmis = new Date(+SIMDI - GUN).toISOString(); const gelecek = new Date(+SIMDI + GUN).toISOString();
  const sb = sahteSb({ kullanicilar: [
    { id: UA, app_metadata: { plan: 'pro', davet_pro_bitis: gecmis, role: 'admin' } },
    { id: UB, app_metadata: { plan: 'pro', davet_pro_bitis: gecmis, subscription_status: 'active' } },
    { id: UC, app_metadata: { plan: 'pro', davet_pro_bitis: gelecek } },
  ] });
  const r = await D.erisimleriBitir({ sb, kullanicilar: [...sb.U.values()], simdi: SIMDI });
  assert.deepStrictEqual(r.map((x) => x.sonuc), ['free', 'isaret_silindi']);
  assert.deepStrictEqual(sb.U.get(UA).app_metadata, { plan: 'free', role: 'admin' });
  assert.deepStrictEqual(sb.U.get(UB).app_metadata, { plan: 'pro', subscription_status: 'active' });
  assert.strictEqual(sb.U.get(UC).app_metadata.plan, 'pro');
});

test('C6: davet kuponu denetimi', () => {
  assert.strictEqual(D.davetKuponuDenetle({ valid: true, percent_off: 100, duration: 'once' }), null);
  assert.ok(D.davetKuponuDenetle({ valid: true, percent_off: 15, duration: 'once' }));
  assert.ok(D.davetKuponuDenetle({ valid: true, percent_off: 100, duration: 'repeating' }));
  assert.ok(D.davetKuponuDenetle(null));
});

test('C7: gunluk tur ucu uca: sayilir, odul yazilir, verilir', async () => {
  const od = new Date(+SIMDI - 20 * GUN).toISOString();
  const sb = sahteSb({
    tablolar: { ia_davetler: [
      { davet_edilen: UB, davet_eden: UA, durum: 'odedi', ilk_odeme: od, abonelik_id: 'sB', kart_izi: 'fB' },
      { davet_edilen: UC, davet_eden: UA, durum: 'odedi', ilk_odeme: od, abonelik_id: 'sC', kart_izi: 'fC' },
    ] },
    kullanicilar: [{ id: UA, app_metadata: { plan: 'free' } }, { id: UB, app_metadata: {} }, { id: UC, app_metadata: {} }],
  });
  const st = sahteStripe({ abonelikler: { sB: { id: 'sB', status: 'active', customer: 'cB' }, sC: { id: 'sC', status: 'active', customer: 'cC' } } });
  const r = await D.turCalistir({ sb, stripe: st, simdi: SIMDI, env: {}, log: { info() {} } });
  assert.deepStrictEqual([r.degerlendirme.length, r.yeni, r.verilen[0].sonuc], [2, 1, 'pro_erisim']);
  assert.strictEqual(sb.U.get(UA).app_metadata.plan, 'pro');
});

test('C8: zamanlama 18 UTC (geri kazanmadan sonra); Stripe yoksa kurulmaz; index kaydi', () => {
  assert.ok(!D.zamaniGeldiMi(new Date('2026-12-01T17:59:00Z'), null, {}));
  assert.ok(D.zamaniGeldiMi(new Date('2026-12-01T18:00:00Z'), null, {}));
  assert.strictEqual(D.zamanlayiciBaslat({}, { env: { SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'k' } }), null);
  const idx = require('node:fs').readFileSync(require('node:path').join(__dirname, 'index.js'), 'utf8');
  assert.match(idx, /register\(davetRoutes,\s*\{ prefix: '\/api\/v1\/davet' \}\)/);
  assert.ok(idx.indexOf("require('./lib/davet').zamanlayiciBaslat") > idx.indexOf("require('./lib/geri-kazanma').zamanlayiciBaslat"));
});

// ── Rotalar ve odeme sayfasi ────────────────────────────────────────────────
async function uygulama(kullanici, ek = {}) {
  const yolA = require.resolve('./middleware/auth');
  const gercek = require('./middleware/auth');
  const eskiA = require.cache[yolA];
  require.cache[yolA] = { id: yolA, filename: yolA, loaded: true, exports: { ...gercek,
    requireAuth: async (q, r) => { if (!kullanici) return r.code(401).send({ error: 'auth' }); q.user = kullanici; } } };
  const botDepo = require('./lib/bot-depo');
  botDepo._setSupabase({});
  const cagri = []; const eski = {};
  const sahte = {
    ozet: async (sb, id) => { cagri.push(['ozet', id]); return { kod: 'ABCD2345', sayildi: 0 }; },
    baglan: async (sb, u, kod) => { cagri.push(['baglan', u.id, kod]); return kod === 'ABCD2345' ? { ok: true } : kod === 'ZATEN000' ? { neden: 'zaten' } : { neden: 'yok' }; },
    ...ek,
  };
  for (const k of Object.keys(sahte)) { eski[k] = D[k]; D[k] = sahte[k]; }
  delete require.cache[require.resolve('./routes/davet')];
  const app = require('fastify')({ logger: false });
  await app.register(require('./routes/davet'), { prefix: '/api/v1/davet' });
  await app.ready();
  return { app, cagri, bitir: async () => {
    await app.close();
    for (const k of Object.keys(eski)) D[k] = eski[k];
    botDepo._setSupabase(undefined);
    if (eskiA) require.cache[yolA] = eskiA; else delete require.cache[yolA];
    delete require.cache[require.resolve('./routes/davet')];
  } };
}

test('Y1: uclar: oturum sart; kimlik oturumdan; kalici red 4xx (istemci kodu siler), gecici 503', async () => {
  const anon = await uygulama(null);
  assert.strictEqual((await anon.app.inject({ method: 'GET', url: '/api/v1/davet' })).statusCode, 401);
  await anon.bitir();
  const u = await uygulama({ id: UB });
  assert.strictEqual((await u.app.inject({ method: 'GET', url: '/api/v1/davet' })).json().kod, 'ABCD2345');
  const P = (kod) => u.app.inject({ method: 'POST', url: '/api/v1/davet/baglan', payload: { kod, user_id: 'baskasi' } });
  assert.deepStrictEqual((await P('ABCD2345')).json(), { ok: true });
  const z = await P('ZATEN000'); assert.deepStrictEqual([z.statusCode, z.json().kod], [409, DAVET.ZATEN]);
  const y = await P('YOKYOKYO'); assert.deepStrictEqual([y.statusCode, y.json().kod], [422, DAVET.GECERSIZ]);
  assert.deepStrictEqual(u.cagri.filter((c) => c[0] === 'baglan').map((c) => c[1]), [UB, UB, UB]);
  await u.bitir();
  const h = await uygulama({ id: UB }, { baglan: async () => { throw new Error('db'); } });
  const x = await h.app.inject({ method: 'POST', url: '/api/v1/davet/baglan', payload: { kod: 'ABCD2345' } });
  assert.deepStrictEqual([x.statusCode, x.json().kod], [503, DAVET.KAYDEDILEMEDI]);
  await h.bitir();
});

test('Y2: odeme sayfasi: davetliye otomatik %15 (kod alani yok), digerlerine kod alani; webhook ilk odemeyi kaydeder', () => {
  const b = require('node:fs').readFileSync(require('node:path').join(__dirname, 'routes', 'billing.js'), 'utf8');
  assert.match(b, /\.\.\.\(arkadasKuponu \? \{ discounts: \[\{ coupon: arkadasKuponu \}\] \} : \{ allow_promotion_codes: true \}\)/);
  assert.match(b, /arkadasKuponu = await require\('\.\.\/lib\/davet'\)\.arkadasIndirimi\(sb, user\)/);
  assert.match(b, /await require\('\.\.\/lib\/davet'\)\.odemeKaydet\(sb, stripe, \{ userId, sub \}\)/);
  assert.deepStrictEqual(require('./lib/hata-kodlari').DAVET_KODLARI.sort(), ['davet_eski', 'davet_gecersiz', 'davet_kaydedilemedi', 'davet_kendisi', 'davet_zaten']);
});
