/**
 * yorum-sunucu.test.js — Ana sayfa kullanici yorumlari (K86, 1 Ekim 2026).
 *
 *   lib/yorum-alanlar.js   suzgec: izin, uzunluk, iletisim bilgisi, "Ayse K."
 *   lib/yorum-depo.js      Supabase sorgulari (sahte istemciyle: bicim)
 *   routes/yorum.js        uclar, admin kapisi
 *
 * Calistir: node --test
 */
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert');

const alan = require('./lib/yorum-alanlar');
const botDepo = require('./lib/bot-depo');
const depo = require('./lib/yorum-depo');
const { YORUM } = require('./lib/hata-kodlari');

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

const M = 'PlacedAI helped me prepare for every round of interviews.';
const GECERLI = { metin: M, gorunen_ad: 'ayşe k', pozisyon: ' Data   Analyst ', izin: true };

// ── Suzgec ──────────────────────────────────────────────────────────────────
test('A1: izin kutusu isaretlenmeden yorum yok (true disinda her sey ret)', () => {
  for (const izin of [undefined, false, 'true', 1, 'on']) {
    assert.deepStrictEqual(alan.yorumTemizle({ ...GECERLI, izin }), { hata: 'izin' }, String(izin));
  }
  assert.deepStrictEqual(alan.yorumTemizle(null), { hata: 'izin' });
});

test('A2: gecerli yorum: yalnizca izinli alanlar, ad "Ayşe K.", pozisyon tek satir', () => {
  const r = alan.yorumTemizle({ ...GECERLI, user_id: 'baskasi', yayin_durumu: 'yayinda', sirket: 'Acme', eposta: 'a@b.c' });
  assert.deepStrictEqual(r, { satir: { metin: M, gorunen_ad: 'Ayşe K.', pozisyon: 'Data Analyst', basvuru_id: null, izin_verdi: true } });
});

test('A3: metin 20-1000 karakter; uzun metin KESILMEZ, reddedilir', () => {
  assert.deepStrictEqual(alan.yorumTemizle({ ...GECERLI, metin: 'x'.repeat(19) }), { hata: 'metin_kisa' });
  assert.deepStrictEqual(alan.yorumTemizle({ ...GECERLI, metin: `   ${'x'.repeat(19)}   ` }), { hata: 'metin_kisa' });
  assert.ok(alan.yorumTemizle({ ...GECERLI, metin: 'x'.repeat(20) }).satir);
  assert.ok(alan.yorumTemizle({ ...GECERLI, metin: 'x'.repeat(1000) }).satir);
  assert.deepStrictEqual(alan.yorumTemizle({ ...GECERLI, metin: 'x'.repeat(1001) }), { hata: 'metin_uzun' });
  assert.deepStrictEqual(alan.yorumTemizle({ ...GECERLI, metin: 12345678901234567890123 }), { hata: 'metin_kisa' });
  // Satir sonlari korunur (kullanicinin paragraflari), kontrol karakterleri bosluk olur.
  assert.strictEqual(alan.yorumTemizle({ ...GECERLI, metin: `${M}\n\nSecond paragraph\u0007here.` }).satir.metin, `${M}\n\nSecond paragraph here.`);
});

test('A4: e-posta, telefon, baglanti metinde ya da pozisyonda varsa ret', () => {
  const kotu = [
    'Contact me at ayse.k@gmail.com for tips!!',
    'Call me any time: 604-555-0199, happy to help.',
    'Call me any time: +1 (604) 555 0199 thanks',
    'See my story at https://example.test/story please',
    'See my story at www.example.test/story please',
    'My blog placedai-fan.com has the details of it',
  ];
  for (const metin of kotu) assert.deepStrictEqual(alan.yorumTemizle({ ...GECERLI, metin }), { hata: 'iletisim' }, metin);
  assert.deepStrictEqual(alan.yorumTemizle({ ...GECERLI, pozisyon: 'Analyst (ayse@x.io)' }), { hata: 'iletisim' });
  const iyi = [
    'I got 3 offers in 2026 after 6 weeks of practice with it.',
    'Salary went from $65,000 to $85,000. Worked 2019-2026 in retail.',
    'The STAR answers were great. Node.js and SQL questions too.',
  ];
  for (const metin of iyi) assert.ok(alan.yorumTemizle({ ...GECERLI, metin }).satir, metin);
});

test('A5: gorunen ad yalnizca "Ad S." bicimi; tam soyadi, rakam, tek kelime ret', () => {
  assert.strictEqual(alan.gorunenAd('Ayşe K.'), 'Ayşe K.');
  assert.strictEqual(alan.gorunenAd('  mary   ann t '), 'Mary Ann T.');
  assert.strictEqual(alan.gorunenAd("o'neil d."), "O'neil D.");
  for (const kotu of ['Ayşe', 'Ayşe Kaya', 'Ayşe K. Yılmaz', 'A1 K.', 'Ayşe K..', '', null, 42, 'Mary Ann Jo T.', `${'a'.repeat(30)} K.`]) {
    assert.strictEqual(alan.gorunenAd(kotu), null, String(kotu));
  }
  assert.strictEqual(alan.gorunenAd(`${'a'.repeat(20)} ${'b'.repeat(20)} K.`), null, '40 karakter siniri');
  assert.strictEqual(alan.gorunenAd(`${'a'.repeat(17)} ${'b'.repeat(17)} K.`), `${'A' + 'a'.repeat(16)} ${'B' + 'b'.repeat(16)} K.`);
  assert.deepStrictEqual(alan.yorumTemizle({ ...GECERLI, gorunen_ad: 'Ayşe Kaya' }), { hata: 'ad' });
});

test('A6: basvuru_id yalnizca UUID ise tasinir', () => {
  const U = 'AAAAAAAA-2222-4333-8444-555555555555';
  assert.strictEqual(alan.yorumTemizle({ ...GECERLI, basvuru_id: U }).satir.basvuru_id, U.toLowerCase());
  assert.strictEqual(alan.yorumTemizle({ ...GECERLI, basvuru_id: "1' or 1=1" }).satir.basvuru_id, null);
});

// ── Depo ────────────────────────────────────────────────────────────────────
test('B1: yaz: baskasinin basvurusuna bag kurulmaz; her yazis yeniden onaya duser', async () => {
  const sb = sahteSb([{ data: null }, { data: [{ id: 'y1', yayin_durumu: 'bekliyor' }] }]);
  botDepo._setSupabase(sb);
  try {
    await depo.yaz('U', { metin: M, gorunen_ad: 'Ayşe K.', pozisyon: '', basvuru_id: 'B-baskasi', izin_verdi: true });
    const [bas, yor] = sb.kayit;
    assert.strictEqual(bas.tablo, 'ia_basvurular');
    assert.deepStrictEqual(adim(bas, 'eq'), [['user_id', 'U'], ['id', 'B-baskasi']]);
    assert.strictEqual(yor.tablo, 'ia_yorumlar');
    const [[kayit, secenek]] = adim(yor, 'upsert');
    assert.deepStrictEqual(secenek, { onConflict: 'user_id' });
    assert.strictEqual(kayit.basvuru_id, null, 'baskasinin basvurusu bagli kaldi');
    assert.deepStrictEqual([kayit.user_id, kayit.yayin_durumu, kayit.karar_zamani, kayit.izin_verdi], ['U', 'bekliyor', null, true]);
  } finally { botDepo._setSupabase(undefined); }

  const sb2 = sahteSb([{ data: { id: 'B1' } }, { data: [{ id: 'y1' }] }]);
  botDepo._setSupabase(sb2);
  try {
    await depo.yaz('U', { metin: M, gorunen_ad: 'Ayşe K.', pozisyon: '', basvuru_id: 'B1', izin_verdi: true });
    assert.strictEqual(adim(sb2.kayit[1], 'upsert')[0][0].basvuru_id, 'B1');
  } finally { botDepo._setSupabase(undefined); }
});

test('B2: yayindakiler: yalnizca yayinda; "ise girdi" bagli basvurunun sonucundan', async () => {
  const sb = sahteSb([
    { data: [
      { id: 'y1', basvuru_id: 'b1', metin: 'm1', gorunen_ad: 'A B.', pozisyon: 'P', karar_zamani: 't' },
      { id: 'y2', basvuru_id: 'b2', metin: 'm2', gorunen_ad: 'C D.', pozisyon: null, karar_zamani: 't' },
      { id: 'y3', basvuru_id: null, metin: 'm3', gorunen_ad: 'E F.', pozisyon: 'Q', karar_zamani: 't' },
    ] },
    { data: [{ id: 'b1', sonuc: 'ise_girdi' }, { id: 'b2', sonuc: 'davet' }] },
  ]);
  botDepo._setSupabase(sb);
  try {
    const r = await depo.yayindakiler(5);
    assert.deepStrictEqual(adim(sb.kayit[0], 'eq'), [['yayin_durumu', 'yayinda']]);
    assert.deepStrictEqual(adim(sb.kayit[0], 'limit'), [[5]]);
    assert.deepStrictEqual(adim(sb.kayit[1], 'in'), [['id', ['b1', 'b2']]]);
    assert.deepStrictEqual(r, [
      { id: 'y1', metin: 'm1', gorunen_ad: 'A B.', pozisyon: 'P', ise_girdi: true },
      { id: 'y2', metin: 'm2', gorunen_ad: 'C D.', pozisyon: '', ise_girdi: false },
      { id: 'y3', metin: 'm3', gorunen_ad: 'E F.', pozisyon: 'Q', ise_girdi: false },
    ]);
  } finally { botDepo._setSupabase(undefined); }
});

test('B3: geri cek yalnizca kendi satiri; karar geri cekilmis yoruma dokunmaz', async () => {
  const sb = sahteSb([{ data: [{ id: 'y1' }] }, { data: [] }]);
  botDepo._setSupabase(sb);
  try {
    assert.strictEqual(await depo.geriCek('U'), 1);
    assert.deepStrictEqual(adim(sb.kayit[0], 'update'), [[{ yayin_durumu: 'geri_cekildi' }]]);
    assert.deepStrictEqual(adim(sb.kayit[0], 'eq'), [['user_id', 'U']]);
    assert.strictEqual(await depo.karar('Y', 'yayinda'), null);
    assert.deepStrictEqual(adim(sb.kayit[1], 'neq'), [['yayin_durumu', 'geri_cekildi']]);
    assert.strictEqual(adim(sb.kayit[1], 'update')[0][0].yayin_durumu, 'yayinda');
  } finally { botDepo._setSupabase(undefined); }
});

test('B4: Supabase yoksa sessiz basari yok; hata atilir', async () => {
  botDepo._setSupabase(null);
  try {
    await assert.rejects(() => depo.yayindakiler(), /Supabase/);
    await assert.rejects(() => depo.benim('U'), /Supabase/);
  } finally { botDepo._setSupabase(undefined); }
});

// ── Rotalar ─────────────────────────────────────────────────────────────────
const UID = '11111111-2222-4333-8444-555555555555';
const YID = '99999999-2222-4333-8444-555555555555';
async function uygulama(kullanici, ek = {}) {
  const yolA = require.resolve('./middleware/auth');
  const gercek = require('./middleware/auth');
  const eskiA = require.cache[yolA];
  require.cache[yolA] = { id: yolA, filename: yolA, loaded: true, exports: { ...gercek,
    requireAuth: async (q, r) => { if (!kullanici) return r.code(401).send({ error: 'auth' }); q.user = kullanici; } } };
  const cagri = [];
  const eski = {};
  const sahte = {
    yayindakiler: async (n) => { cagri.push(['yayindakiler', n]); return [{ id: YID, metin: M, gorunen_ad: 'Ayşe K.', pozisyon: 'Data Analyst', ise_girdi: true }]; },
    benim: async (u) => { cagri.push(['benim', u]); return { id: YID, user_id: u, metin: M, gorunen_ad: 'Ayşe K.', pozisyon: null, yayin_durumu: 'bekliyor', created_at: 't', basvuru_id: 'b' }; },
    yaz: async (u, s) => { cagri.push(['yaz', u, s]); return { id: YID, ...s, yayin_durumu: 'bekliyor', created_at: 't' }; },
    geriCek: async (u) => { cagri.push(['geriCek', u]); return 1; },
    yonetimListesi: async (d) => { cagri.push(['liste', d]); return []; },
    karar: async (id, k) => { cagri.push(['karar', id, k]); return id === YID ? { id, yayin_durumu: k } : null; },
    ...ek,
  };
  for (const k of Object.keys(sahte)) { eski[k] = depo[k]; depo[k] = sahte[k]; }
  delete require.cache[require.resolve('./routes/yorum')];
  const app = require('fastify')({ logger: false });
  await app.register(require('./routes/yorum'), { prefix: '/api/v1/yorumlar' });
  await app.ready();
  return { app, cagri, bitir: async () => {
    await app.close();
    for (const k of Object.keys(eski)) depo[k] = eski[k];
    if (eskiA) require.cache[yolA] = eskiA; else delete require.cache[yolA];
    delete require.cache[require.resolve('./routes/yorum')];
  } };
}
const kisi = (rol) => ({ id: UID, app_metadata: rol ? { role: rol } : {} });
const P = (app, url, payload) => app.inject({ method: 'POST', url: `/api/v1/yorumlar${url}`, payload });
const G = (app, url) => app.inject({ method: 'GET', url: `/api/v1/yorumlar${url}` });

test('Y1: herkese acik liste oturum istemez; yalnizca gosterilecek alanlar; onbellek', async () => {
  const u = await uygulama(null);
  const r = await G(u.app, '');
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(Object.keys(r.json().yorumlar[0]).sort(), ['gorunen_ad', 'id', 'ise_girdi', 'metin', 'pozisyon']);
  assert.match(r.headers['cache-control'], /public, max-age=300/);
  assert.deepStrictEqual(u.cagri, [['yayindakiler', 12]]);
  await u.bitir();
  const h = await uygulama(null, { yayindakiler: async () => { throw new Error('x'); } });
  const r2 = await G(h.app, '');
  assert.deepStrictEqual([r2.statusCode, r2.json().kod, r2.json().yorumlar], [503, YORUM.KAYDEDILEMEDI, []]);
  await h.bitir();
});

test('Y2: yorum yazma: oturum sart; kullanici kimligi oturumdan; suzgec hatasi kodla', async () => {
  const anon = await uygulama(null);
  assert.strictEqual((await P(anon.app, '', GECERLI)).statusCode, 401);
  assert.strictEqual(anon.cagri.length, 0);
  await anon.bitir();

  const u = await uygulama(kisi());
  const r = await P(u.app, '', { ...GECERLI, user_id: 'baskasi' });
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(r.json().yorum, { durum: 'bekliyor', metin: M, gorunen_ad: 'Ayşe K.', pozisyon: 'Data Analyst', created_at: 't' });
  assert.strictEqual(u.cagri[0][1], UID);
  const kodlar = [];
  for (const govde of [{ ...GECERLI, izin: false }, { ...GECERLI, metin: 'kisa' }, { ...GECERLI, metin: 'x'.repeat(1001) },
    { ...GECERLI, metin: `${M} mail me a@b.co` }, { ...GECERLI, gorunen_ad: 'Ayşe Kaya' }]) {
    const x = await P(u.app, '', govde);
    assert.strictEqual(x.statusCode, 400);
    kodlar.push(x.json().kod);
  }
  assert.deepStrictEqual(kodlar, [YORUM.IZIN, YORUM.METIN_KISA, YORUM.METIN_UZUN, YORUM.ILETISIM, YORUM.AD]);
  assert.strictEqual(u.cagri.length, 1, 'gecersiz yorum depoya gitti');
  await u.bitir();
});

test('Y3: benim ve geri cek; geri cekilecek yorum yoksa 404', async () => {
  const u = await uygulama(kisi());
  const b = await G(u.app, '/benim');
  assert.deepStrictEqual(b.json().yorum, { durum: 'bekliyor', metin: M, gorunen_ad: 'Ayşe K.', pozisyon: '', created_at: 't' });
  assert.deepStrictEqual((await P(u.app, '/geri-cek', {})).json(), { ok: true });
  assert.deepStrictEqual(u.cagri.map((c) => c.slice(0, 2)), [['benim', UID], ['geriCek', UID]]);
  await u.bitir();
  const y = await uygulama(kisi(), { benim: async () => null, geriCek: async () => 0 });
  assert.deepStrictEqual((await G(y.app, '/benim')).json(), { yorum: null });
  const g = await P(y.app, '/geri-cek', {});
  assert.deepStrictEqual([g.statusCode, g.json().kod], [404, YORUM.YOK]);
  await y.bitir();
});

test('Y4: yonetim yalnizca admin; karar yalnizca yayinda/reddedildi; metin degistirilemez', async () => {
  const u = await uygulama(kisi());
  assert.strictEqual((await G(u.app, '/yonetim')).statusCode, 403);
  assert.strictEqual((await P(u.app, `/yonetim/${YID}`, { karar: 'yayinda' })).statusCode, 403);
  assert.strictEqual(u.cagri.length, 0);
  await u.bitir();
  const anon = await uygulama(null);
  assert.strictEqual((await G(anon.app, '/yonetim')).statusCode, 401);
  await anon.bitir();

  const a = await uygulama(kisi('admin'));
  assert.strictEqual((await G(a.app, '/yonetim')).json().durum, 'bekliyor');
  assert.strictEqual((await G(a.app, '/yonetim?durum=yayinda')).json().durum, 'yayinda');
  assert.strictEqual((await G(a.app, '/yonetim?durum=geri_cekildi')).json().durum, 'bekliyor', 'geri cekilenler listelendi');
  const r = await P(a.app, `/yonetim/${YID}`, { karar: 'yayinda', metin: 'admin yazdi' });
  assert.deepStrictEqual(r.json(), { yorum: { id: YID, durum: 'yayinda' } });
  assert.deepStrictEqual(a.cagri.at(-1), ['karar', YID, 'yayinda']);
  for (const govde of [{ karar: 'geri_cekildi' }, { karar: 'bekliyor' }, {}]) {
    assert.strictEqual((await P(a.app, `/yonetim/${YID}`, govde)).statusCode, 400, JSON.stringify(govde));
  }
  assert.strictEqual((await P(a.app, '/yonetim/abc', { karar: 'yayinda' })).statusCode, 400);
  const yok = await P(a.app, '/yonetim/88888888-2222-4333-8444-555555555555', { karar: 'reddedildi' });
  assert.deepStrictEqual([yok.statusCode, yok.json().kod], [404, YORUM.YOK]);
  await a.bitir();
});

test('Y5: hata kodlari listesi ve index.js kaydi', () => {
  assert.deepStrictEqual(require('./lib/hata-kodlari').YORUM_KODLARI.sort(),
    ['yorum_ad', 'yorum_iletisim', 'yorum_izin', 'yorum_kaydedilemedi', 'yorum_metin_kisa', 'yorum_metin_uzun', 'yorum_yok']);
  const idx = require('node:fs').readFileSync(require('node:path').join(__dirname, 'index.js'), 'utf8');
  assert.match(idx, /register\(yorumRoutes,\s*\{ prefix: '\/api\/v1\/yorumlar' \}\)/);
});
