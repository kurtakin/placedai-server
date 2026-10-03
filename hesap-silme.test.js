/**
 * hesap-silme.test.js — Kullanicinin kendi hesabini silmesi (K95, 3 Ekim 2026).
 *
 * Calistir: node --test hesap-silme.test.js
 *
 * En onemli kural: geri donulemez adim (hesabi silmek) EN SONDA; ondan onceki
 * zorunlu adimlardan biri basarisizsa hesap SILINMEZ.
 */
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert');
const { hesabiSil, SilmeHatasi, IPTAL_EDILECEK } = require('./lib/hesap-silme');

const UID = '11111111-2222-4333-8444-555555555555';

/** Zincirlenebilir sahte Supabase. Her islemi sirayla kaydeder. */
function sahteSb({ tercih = null, yorum = null, basvuru = null, hatalar = {} } = {}) {
  const log = [];
  const sorgu = (tablo) => {
    const d = { tablo, islem: 'select', kosul: [], veri: null };
    const q = {
      select(alanlar) { d.alanlar = alanlar; return q; },
      update(v) { d.islem = 'update'; d.veri = v; return q; },
      insert(v) { d.islem = 'insert'; d.veri = v; log.push(d); return Promise.resolve(hatalar[`${tablo}.insert`] ? { error: { message: 'x' } } : { error: null }); },
      delete() { d.islem = 'delete'; return q; },
      eq(k, v) { d.kosul.push([k, v]); return q; },
      maybeSingle() {
        log.push(d);
        if (hatalar[`${tablo}.select`]) return Promise.resolve({ data: null, error: { message: 'okunamadi' } });
        const data = { ia_eposta_tercihleri: tercih, ia_yorumlar: yorum, ia_basvurular: basvuru }[tablo] ?? null;
        return Promise.resolve({ data, error: null });
      },
      then(ok, kotu) {   // update/delete zinciri await edilince
        log.push(d);
        const hata = hatalar[`${tablo}.${d.islem}`];
        return Promise.resolve(hata ? { error: { message: 'x' } } : { error: null }).then(ok, kotu);
      },
    };
    return q;
  };
  return {
    log,
    from: sorgu,
    auth: { admin: { deleteUser: async (id) => { log.push({ tablo: 'auth', islem: 'deleteUser', id }); return hatalar.deleteUser ? { error: { message: 'x' } } : { error: null }; } } },
  };
}

function sahteStripe(abonelikler = [], { listeHata = false, iptalHata = false } = {}) {
  const iptal = [];
  return {
    iptal,
    subscriptions: {
      list: async (p) => { if (listeHata) throw new Error('stripe down'); assert.strictEqual(p.status, 'all'); return { data: abonelikler }; },
      cancel: async (id, ...r) => { if (iptalHata) throw new Error('no'); assert.strictEqual(r.length, 0, 'iade/oranlama secenegi verilmemeli'); iptal.push(id); return {}; },
    },
  };
}

const kisi = (am = {}) => ({ id: UID, email: 'Kisi@Ornek.com', app_metadata: am });
const silindi = (sb) => sb.log.some((x) => x.islem === 'deleteUser');
const son = (sb) => sb.log[sb.log.length - 1];

test('H1: en sade hesap: hesap EN SON silinir; hata kayitlari ve bekleme listesi temizlenir', async () => {
  const sb = sahteSb();
  const s = await hesabiSil({ sb, stripe: null, kullanici: kisi() });
  assert.deepStrictEqual(s, { abonelik: 0, izinArsivi: false, yorumKaldi: false, temizlikHatasi: 0 });
  assert.deepStrictEqual(son(sb), { tablo: 'auth', islem: 'deleteUser', id: UID });
  const hata = sb.log.filter((x) => x.tablo === 'ia_errors');
  assert.strictEqual(hata.length, 2);
  for (const h of hata) assert.deepStrictEqual(h.veri, { user_id: null, user_email: null });
  assert.deepStrictEqual(hata.map((h) => h.kosul[0]), [['user_id', UID], ['user_email', 'kisi@ornek.com']]);
  const mac = sb.log.find((x) => x.tablo === 'mac_waitlist');
  assert.strictEqual(mac.islem, 'delete');
  assert.deepStrictEqual(mac.kosul, [['email', 'kisi@ornek.com']]);
  assert.ok(!sb.log.some((x) => x.tablo === 'ia_yorumlar'), 'istenmeden yoruma dokunuldu');
});

test('H2: Stripe: yalnizca para cekebilecek abonelikler iptal edilir, iadesiz', async () => {
  assert.deepStrictEqual(IPTAL_EDILECEK, ['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);
  const stripe = sahteStripe([{ id: 's1', status: 'active' }, { id: 's2', status: 'canceled' }, { id: 's3', status: 'past_due' }, { id: 's4', status: 'incomplete_expired' }]);
  const sb = sahteSb();
  const s = await hesabiSil({ sb, stripe, kullanici: kisi({ stripe_customer_id: 'cus_1' }) });
  assert.deepStrictEqual(stripe.iptal, ['s1', 's3']);
  assert.strictEqual(s.abonelik, 2);
  assert.ok(silindi(sb));
});

test('H3: Stripe basarisizsa HESAP SILINMEZ ve hicbir sey yazilmaz', async () => {
  for (const [stripe, ad] of [[sahteStripe([], { listeHata: true }), 'liste'], [sahteStripe([{ id: 's1', status: 'active' }], { iptalHata: true }), 'iptal'], [null, 'yapilandirma yok']]) {
    const sb = sahteSb({ tercih: { pazarlama: true, pazarlama_zamani: '2026-09-01T00:00:00Z', pazarlama_kaynak: 'serit', pazarlama_surum: 'p1' } });
    await assert.rejects(() => hesabiSil({ sb, stripe, kullanici: kisi({ stripe_customer_id: 'cus_1' }) }), (e) => e instanceof SilmeHatasi && e.adim === 'stripe', ad);
    assert.strictEqual(sb.log.length, 0, `${ad}: Stripe'tan once bir sey yazildi`);
  }
});

test('H4: pazarlama izni kaniti arsive; hic izin yoksa arsiv yok; arsiv yazilamazsa silinmez', async () => {
  // Izinli
  let sb = sahteSb({ tercih: { pazarlama: true, pazarlama_zamani: '2026-09-01T00:00:00Z', pazarlama_kaynak: 'serit', pazarlama_surum: 'p1' } });
  let s = await hesabiSil({ sb, stripe: null, kullanici: kisi() });
  assert.strictEqual(s.izinArsivi, true);
  const a = sb.log.find((x) => x.tablo === 'ia_izin_arsivi');
  assert.deepStrictEqual(a.veri, { eposta: 'kisi@ornek.com', silmede_izinli: true, son_degisiklik: '2026-09-01T00:00:00Z', kaynak: 'serit', surum: 'p1' });
  assert.ok(sb.log.indexOf(a) < sb.log.findIndex((x) => x.islem === 'deleteUser'));
  // Once izin verip geri almis
  sb = sahteSb({ tercih: { pazarlama: false, pazarlama_zamani: '2026-09-05T00:00:00Z', pazarlama_kaynak: 'eposta', pazarlama_surum: 'p1' } });
  s = await hesabiSil({ sb, stripe: null, kullanici: kisi() });
  assert.strictEqual(sb.log.find((x) => x.tablo === 'ia_izin_arsivi').veri.silmede_izinli, false);
  // Hic izin vermemis
  sb = sahteSb({ tercih: { pazarlama: false, pazarlama_zamani: null } });
  s = await hesabiSil({ sb, stripe: null, kullanici: kisi() });
  assert.strictEqual(s.izinArsivi, false);
  assert.ok(!sb.log.some((x) => x.tablo === 'ia_izin_arsivi'));
  // Arsiv ya da tercih okunamazsa: dur
  for (const h of ['ia_izin_arsivi.insert', 'ia_eposta_tercihleri.select']) {
    sb = sahteSb({ tercih: { pazarlama: true, pazarlama_zamani: '2026-09-01T00:00:00Z', pazarlama_kaynak: 'serit', pazarlama_surum: 'p1' }, hatalar: { [h]: true } });
    await assert.rejects(() => hesabiSil({ sb, stripe: null, kullanici: kisi() }), (e) => e.adim === 'izin', h);
    assert.ok(!silindi(sb), `${h}: hesap silindi`);
  }
});

test('H5: yorum: yalnizca istenirse ve YAYINDAYSA ayrilir; "ise girdi" o an sabitlenir', async () => {
  // Kalsin + yayinda + ise girdi
  let sb = sahteSb({ yorum: { id: 'y1', basvuru_id: 'b1', yayin_durumu: 'yayinda' }, basvuru: { sonuc: 'ise_girdi' } });
  let s = await hesabiSil({ sb, stripe: null, kullanici: kisi(), yorumKalsin: true });
  assert.strictEqual(s.yorumKaldi, true);
  const u = sb.log.find((x) => x.tablo === 'ia_yorumlar' && x.islem === 'update');
  assert.strictEqual(u.veri.user_id, null);
  assert.strictEqual(u.veri.ise_girdi_sabit, true);
  assert.ok(!Number.isNaN(Date.parse(u.veri.hesap_silindi)));
  assert.deepStrictEqual(u.kosul, [['id', 'y1'], ['user_id', UID]], 'baskasinin yorumuna dokunabilir');
  assert.deepStrictEqual(sb.log.find((x) => x.tablo === 'ia_basvurular').kosul, [['id', 'b1'], ['user_id', UID]]);
  // Kalsin + bekliyor: ayrilmaz, hesap yine silinir (yorum cascade ile gider)
  sb = sahteSb({ yorum: { id: 'y1', basvuru_id: null, yayin_durumu: 'bekliyor' } });
  s = await hesabiSil({ sb, stripe: null, kullanici: kisi(), yorumKalsin: true });
  assert.strictEqual(s.yorumKaldi, false);
  assert.ok(!sb.log.some((x) => x.tablo === 'ia_yorumlar' && x.islem === 'update'));
  assert.ok(silindi(sb));
  // Bagli basvuru var ama "ise girdi" degil: dogrulama false
  sb = sahteSb({ yorum: { id: 'y1', basvuru_id: 'b1', yayin_durumu: 'yayinda' }, basvuru: { sonuc: 'davet' } });
  await hesabiSil({ sb, stripe: null, kullanici: kisi(), yorumKalsin: true });
  assert.strictEqual(sb.log.find((x) => x.islem === 'update' && x.tablo === 'ia_yorumlar').veri.ise_girdi_sabit, false);
  // Yayinda ama basvuru bagli degil: dogrulama false
  sb = sahteSb({ yorum: { id: 'y1', basvuru_id: null, yayin_durumu: 'yayinda' } });
  await hesabiSil({ sb, stripe: null, kullanici: kisi(), yorumKalsin: true });
  assert.strictEqual(sb.log.find((x) => x.islem === 'update' && x.tablo === 'ia_yorumlar').veri.ise_girdi_sabit, false);
  // Istenmedi: ia_yorumlar'a hic dokunulmaz ("true" disinda hicbir deger kalsin sayilmaz)
  for (const k of [false, undefined, 'true', 1]) {
    sb = sahteSb({ yorum: { id: 'y1', basvuru_id: null, yayin_durumu: 'yayinda' } });
    s = await hesabiSil({ sb, stripe: null, kullanici: kisi(), yorumKalsin: k });
    assert.strictEqual(s.yorumKaldi, false, String(k));
    assert.ok(!sb.log.some((x) => x.tablo === 'ia_yorumlar'), String(k));
  }
  // Ayirma basarisiz: dur
  sb = sahteSb({ yorum: { id: 'y1', basvuru_id: null, yayin_durumu: 'yayinda' }, hatalar: { 'ia_yorumlar.update': true } });
  await assert.rejects(() => hesabiSil({ sb, stripe: null, kullanici: kisi(), yorumKalsin: true }), (e) => e.adim === 'yorum');
  assert.ok(!silindi(sb));
});

test('H6: temizlik hatasi silmeyi DURDURMAZ; hesap silinemezse adim "hesap"', async () => {
  let sb = sahteSb({ hatalar: { 'ia_errors.update': true, 'mac_waitlist.delete': true } });
  const s = await hesabiSil({ sb, stripe: null, kullanici: kisi() });
  assert.strictEqual(s.temizlikHatasi, 3);
  assert.ok(silindi(sb));
  sb = sahteSb({ hatalar: { deleteUser: true } });
  await assert.rejects(() => hesabiSil({ sb, stripe: null, kullanici: kisi() }), (e) => e.adim === 'hesap');
  await assert.rejects(() => hesabiSil({ sb: null, stripe: null, kullanici: kisi() }), (e) => e.adim === 'hazirlik');
  await assert.rejects(() => hesabiSil({ sb: sahteSb(), stripe: null, kullanici: {} }), (e) => e.adim === 'hazirlik');
});

// ── Rota ────────────────────────────────────────────────────────────────────
async function uygulama(kullanici, davranis) {
  const yolA = require.resolve('./middleware/auth');
  const yolH = require.resolve('./lib/hesap-silme');
  const yolE = require.resolve('./lib/errors');
  const eskiA = require.cache[yolA], eskiH = require.cache[yolH], eskiE = require.cache[yolE];
  const gercek = require('./middleware/auth');
  const cagri = [], hatalar = [];
  require.cache[yolA] = { id: yolA, filename: yolA, loaded: true, exports: { ...gercek, requireAuth: async (q) => { q.user = kullanici; } } };
  require.cache[yolH] = { id: yolH, filename: yolH, loaded: true, exports: { SilmeHatasi, hesabiSil: async (o) => { cagri.push(o); return davranis(o); } } };
  require.cache[yolE] = { id: yolE, filename: yolE, loaded: true, exports: { logError: async (e) => { hatalar.push(e); }, makeFingerprint: () => '' } };
  const eskiEnv = { u: process.env.SUPABASE_URL, k: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://ornek.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
  delete require.cache[require.resolve('./routes/hesap')];
  const app = require('fastify')({ logger: false });
  await app.register(require('./routes/hesap'), { prefix: '/api/v1/hesap' });
  await app.ready();
  return { app, cagri, hatalar, bitir: async () => {
    await app.close();
    for (const [y, e] of [[yolA, eskiA], [yolH, eskiH], [yolE, eskiE]]) { if (e) require.cache[y] = e; else delete require.cache[y]; }
    delete require.cache[require.resolve('./routes/hesap')];
    if (eskiEnv.u === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = eskiEnv.u;
    if (eskiEnv.k === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = eskiEnv.k;
  } };
}
const SIL = (app, payload) => app.inject({ method: 'POST', url: '/api/v1/hesap/sil', payload });

test('R1: onay "DELETE" olmadan silinmez; kimlik govdeden degil oturumdan', async () => {
  const u = await uygulama(kisi(), async () => ({ abonelik: 0, izinArsivi: false, yorumKaldi: true, temizlikHatasi: 0 }));
  try {
    for (const g of [{}, { onay: 'delete' }, { onay: 'YES' }, { onay: true }]) {
      assert.strictEqual((await SIL(u.app, g)).statusCode, 400, JSON.stringify(g));
    }
    assert.strictEqual(u.cagri.length, 0);
    const r = await SIL(u.app, { onay: 'DELETE', yorum_kalsin: true, user_id: 'baskasi' });
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(r.json(), { ok: true, yorum_kaldi: true });
    assert.strictEqual(u.cagri[0].kullanici.id, UID);
    assert.strictEqual(u.cagri[0].yorumKalsin, true);
    await SIL(u.app, { onay: 'DELETE' });
    assert.strictEqual(u.cagri[1].yorumKalsin, false);
  } finally { await u.bitir(); }
});

test('R2: basarisizlikta 502 + adim kodu + "hesap silinmedi"; hata kaydinda e-posta yok', async () => {
  for (const [adim, kod] of [['stripe', 'billing_cancel_failed'], ['izin', 'consent_archive_failed'], ['yorum', 'testimonial_detach_failed'], ['hesap', 'delete_failed']]) {
    const u = await uygulama(kisi(), async () => { throw new SilmeHatasi(adim, 'kisi@ornek.com patladi'); });
    try {
      const r = await SIL(u.app, { onay: 'DELETE' });
      assert.strictEqual(r.statusCode, 502);
      assert.strictEqual(r.json().kod, kod);
      assert.match(r.json().error, /was not deleted/);
      assert.strictEqual(u.hatalar.length, 1);
      assert.ok(!('user_email' in u.hatalar[0]) && !('user_id' in u.hatalar[0]), 'silinen kisinin kimligi hata kaydina yazildi');
      assert.doesNotMatch(u.hatalar[0].message, /@/, 'saglayici mesajindaki e-posta kayda gecti');
      assert.match(u.hatalar[0].message, new RegExp(`^\\[hesap/sil\\] ${adim}: \\[email\\] patladi`));
    } finally { await u.bitir(); }
  }
});
