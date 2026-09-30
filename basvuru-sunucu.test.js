/**
 * basvuru-sunucu.test.js — Basvuru Takibi sunucuda, sonuc hatirlatmasi,
 * "ise girdim" anketi (K85, 30 Eylul 2026).
 *
 *   lib/basvuru-alanlar.js   suzgec (kisisel alan yok, gecerli durum/sonuc)
 *   lib/basvuru-depo.js      Supabase sorgulari (sahte istemciyle: bicim)
 *   lib/hatirlatma.js        15 gun / 1 ay, gunde bir, Free'ye TEK e-posta
 *   routes/basvuru.js        uclar
 *
 * Calistir: node --test
 */
'use strict';

const { test, beforeEach } = require('node:test');
const assert   = require('node:assert');

const alan = require('./lib/basvuru-alanlar');
const botDepo = require('./lib/bot-depo');
const depo = require('./lib/basvuru-depo');
const H = require('./lib/hatirlatma');
const kota = require('./lib/eposta-kota');
const imza = require('./lib/eposta-imza');
const { BASVURU } = require('./lib/hata-kodlari');

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

// ── Suzgec ──────────────────────────────────────────────────────────────────
test('A1: kayit: yalnizca izinli alanlar; durum/sonuc/kaynak gecerli; link http(s)', () => {
  const k = alan.kayitTemizle({
    istemci_id: 1790000000000, sirket: '  Acme  Corp ', pozisyon: 'Data\nAnalyst', konum: '—', link: 'jobs.acme.test/1',
    basvuru_tarihi: '2026-09-01', durum: 'Phone Interview', notlar: 'iyi gecti\nikinci tur', kaynak: 'bot', sonuc: 'davet', sonuc_tarihi: '2026-09-10',
    user_id: 'baskasi', eposta: 'a@b.c', telefon: '604', created_at: 'x',
  }, '2026-09-30');
  assert.deepStrictEqual(k, { istemci_id: '1790000000000', sirket: 'Acme Corp', pozisyon: 'Data Analyst', konum: '', link: 'https://jobs.acme.test/1',
    basvuru_tarihi: '2026-09-01', durum: 'Phone Screen', notlar: 'iyi gecti\nikinci tur', kaynak: 'bot', sonuc: 'davet', sonuc_tarihi: '2026-09-10' });
  const b = alan.kayitTemizle({ sirket: 'X', durum: 'Hired', kaynak: 'robot', link: 'javascript:alert(1)', basvuru_tarihi: '2026-02-30', sonuc: 'kabul' }, '2026-09-30');
  assert.deepStrictEqual([b.durum, b.kaynak, b.link, b.basvuru_tarihi, 'sonuc' in b], ['Applied', 'elle', '', '2026-09-30', false]);
  assert.strictEqual(alan.kayitTemizle({ sirket: '', pozisyon: '—' }), null, 'bos kart');
  assert.strictEqual(alan.kayitTemizle(null), null);
  assert.strictEqual(alan.kayitTemizle({ sirket: 'x'.repeat(500), notlar: 'n'.repeat(5000) }).sirket.length, 200);
  assert.strictEqual(alan.kayitTemizle({ sirket: 'x', notlar: 'n'.repeat(5000) }).notlar.length, 2000);
  assert.strictEqual(alan.kayitTemizle({ sirket: 'x', istemci_id: 'i'.repeat(100) }).istemci_id.length, 64);
});

test('A2: guncelleme: yalnizca gonderilen; gecersiz durum/sonuc hata; sonuc null temizler', () => {
  assert.deepStrictEqual(alan.guncellemeTemizle({ durum: 'Offer', user_id: 'x' }), { alanlar: { durum: 'Offer' } });
  assert.deepStrictEqual(alan.guncellemeTemizle({ sonuc: 'ise_girdi' }, '2026-09-30'), { alanlar: { sonuc: 'ise_girdi', sonuc_tarihi: '2026-09-30' } });
  assert.deepStrictEqual(alan.guncellemeTemizle({ sonuc: null }), { alanlar: { sonuc: null, sonuc_tarihi: null } });
  assert.deepStrictEqual(alan.guncellemeTemizle({ durum: 'Phone Interview' }), { alanlar: { durum: 'Phone Screen' } });
  assert.deepStrictEqual(alan.guncellemeTemizle({ durum: 'Hired' }), { hata: 'durum' });
  assert.deepStrictEqual(alan.guncellemeTemizle({ sonuc: 'kabul' }), { hata: 'sonuc' });
  assert.deepStrictEqual(alan.guncellemeTemizle({}), { hata: 'bos' });
});

test('A3: anket: 1-5, bilinen araclar tekil, yorum siniri', () => {
  assert.deepStrictEqual(alan.anketTemizle({ yardim: 5, araclar: ['mock', 'mock', 'hack', 'cv'], yorum: ' tesekkurler ' }), { yardim: 5, araclar: ['mock', 'cv'], yorum: 'tesekkurler' });
  assert.strictEqual(alan.anketTemizle({ yardim: 6 }).yardim, null);
  assert.strictEqual(alan.anketTemizle({ yardim: 2.5 }).yardim, null);
  assert.deepStrictEqual(alan.anketTemizle({ araclar: 'mock' }).araclar, []);
  assert.strictEqual(alan.anketTemizle({ yorum: 'y'.repeat(2000) }).yorum.length, 1000);
});

// ── Depo ────────────────────────────────────────────────────────────────────
test('D1: liste/ekle/guncelle/sil sorgu bicimleri; user_id govdeden ezilemez', async () => {
  const sb = sahteSb([
    { data: [{ id: 'r1' }] },                          // liste
    { data: [{ id: 'n1' }] },                          // upsert
    { data: [{ id: 'n1', istemci_id: 'c1' }, { id: 'n0', istemci_id: 'c0' }] },   // eslesme
    { data: [{ id: 'n1', durum: 'Offer' }] },          // guncelle
    { data: [] },                                      // sil (baskasinin)
  ]);
  botDepo._setSupabase(sb);
  await depo.liste('u1');
  assert.deepStrictEqual(sb.kayit[0].adimlar.slice(1), [['eq', 'user_id', 'u1'], ['order', 'basvuru_tarihi', { ascending: true }], ['order', 'created_at', { ascending: true }], ['limit', 2000]]);
  const e = await depo.ekle('u1', [{ istemci_id: 'c1', sirket: 'A', user_id: 'baskasi' }, { istemci_id: 'c0', sirket: 'B' }]);
  assert.deepStrictEqual(e, { c1: 'n1', c0: 'n0' });
  assert.deepStrictEqual(sb.kayit[1].adimlar[0], ['upsert', [{ istemci_id: 'c1', sirket: 'A', user_id: 'u1' }, { istemci_id: 'c0', sirket: 'B', user_id: 'u1' }], { onConflict: 'user_id,istemci_id', ignoreDuplicates: true }]);
  assert.deepStrictEqual(sb.kayit[2].adimlar.slice(1), [['eq', 'user_id', 'u1'], ['in', 'istemci_id', ['c1', 'c0']]]);
  assert.deepStrictEqual(await depo.guncelle('u1', 'n1', { durum: 'Offer' }), { id: 'n1', durum: 'Offer' });
  assert.deepStrictEqual(sb.kayit[3].adimlar.slice(0, 3), [['update', { durum: 'Offer' }], ['eq', 'user_id', 'u1'], ['eq', 'id', 'n1']]);
  assert.strictEqual(await depo.sil('u1', 'x'), 0);
  assert.deepStrictEqual(sb.kayit[4].adimlar.slice(0, 3), [['delete'], ['eq', 'user_id', 'u1'], ['eq', 'id', 'x']]);
  assert.deepStrictEqual(await depo.ekle('u1', []), {});
  assert.strictEqual(sb.kayit.length, 5, 'bos liste icin sorgu atildi');
  botDepo._setSupabase(undefined);
});

test('D2: hatirlatma adaylari 15/30 gun, sonucsuz; isaretleme kendi satirlari; tercih varsayilan acik', async () => {
  const sb = sahteSb([{ data: [] }, { data: null }, { data: null }, { data: null }, { data: null }, { data: null }]);
  botDepo._setSupabase(sb);
  await depo.hatirlatmaAdaylari('2026-09-30');
  const a = sb.kayit[0].adimlar;
  assert.deepStrictEqual(a[1], ['is', 'sonuc', null]);
  assert.deepStrictEqual(a[2], ['or', 'and(basvuru_tarihi.lte.2026-09-15,hatirlatma_15.is.null),and(basvuru_tarihi.lte.2026-08-31,hatirlatma_30.is.null)']);
  await depo.hatirlatmaIsaretle('u1', ['a'], ['b'], new Date('2026-09-30T16:00:00Z'));
  assert.deepStrictEqual(sb.kayit[1].adimlar, [['update', { hatirlatma_15: '2026-09-30T16:00:00.000Z' }], ['eq', 'user_id', 'u1'], ['in', 'id', ['a']]]);
  assert.deepStrictEqual(sb.kayit[2].adimlar, [['update', { hatirlatma_30: '2026-09-30T16:00:00.000Z' }], ['eq', 'user_id', 'u1'], ['in', 'id', ['b']]]);
  assert.deepStrictEqual(await depo.tercihOku('u1'), { hatirlatma: true, hatirlatma_sayisi: 0, son_hatirlatma: null });
  await depo.tercihYaz('u1', { hatirlatma: false, user_id: 'x' });
  assert.deepStrictEqual(sb.kayit[4].adimlar[0], ['upsert', { hatirlatma: false, user_id: 'u1' }, { onConflict: 'user_id' }]);
  botDepo._setSupabase(undefined);
});

test('D3: anket yalnizca kendi basvurusuna; Supabase yoksa hata', async () => {
  const sb = sahteSb([{ data: null }, { data: { id: 'b1' } }, { data: null }]);
  botDepo._setSupabase(sb);
  assert.strictEqual(await depo.anketYaz('u1', 'baska', { yardim: 5 }), false);
  assert.strictEqual(sb.kayit.length, 1, 'baskasinin basvurusuna anket yazildi');
  assert.strictEqual(await depo.anketYaz('u1', 'b1', { yardim: 5, user_id: 'x' }), true);
  assert.deepStrictEqual(sb.kayit[2].adimlar[0], ['upsert', { yardim: 5, user_id: 'u1', basvuru_id: 'b1' }, { onConflict: 'user_id,basvuru_id' }]);
  botDepo._setSupabase(null);
  await assert.rejects(depo.liste('u1'), (e) => e.supabaseYok === true);
  botDepo._setSupabase(undefined);
});

// ── Hatirlatma ──────────────────────────────────────────────────────────────
const BUGUN = '2026-09-30';
const SIMDI = new Date('2026-09-30T16:05:00Z');
const R = (id, user, tarih, ek) => ({ id, user_id: user, sirket: `Co${id}`, pozisyon: `Role${id}`, basvuru_tarihi: tarih, hatirlatma_15: null, hatirlatma_30: null, ...ek });

beforeEach(() => { kota._sifirla(); H._sifirla(); });

test('H1: gruplama: 15. gun, 30. gun (15 de isaretlenir), zamani gelmeyen yok', () => {
  const g = H.grupla([
    R('a', 'u1', '2026-09-15'),                                   // tam 15 gun
    R('b', 'u1', '2026-09-16'),                                   // 14 gun: yok
    R('c', 'u1', '2026-08-01'),                                   // 60 gun, hic hatirlatilmamis: tek hatirlatma
    R('d', 'u2', '2026-08-31', { hatirlatma_15: 'x' }),           // 30 gun, 15 gitmis
    R('e', 'u2', '2026-09-10', { hatirlatma_15: 'x' }),           // 20 gun, 15 gitmis: yok
  ], BUGUN);
  assert.deepStrictEqual([...g.keys()], ['u1', 'u2']);
  assert.deepStrictEqual(g.get('u1').kayitlar.map((r) => r.id), ['a', 'c']);
  assert.deepStrictEqual(g.get('u1').ids15, ['a', 'c']);
  assert.deepStrictEqual(g.get('u1').ids30, ['c']);
  assert.deepStrictEqual([g.get('u2').ids15, g.get('u2').ids30], [[], ['d']]);
});

function sahteDepo({ satirlar, tercihler = {}, hesaplar = {} } = {}) {
  const c = { isaret: [], tercihYaz: [] };
  return {
    c,
    hatirlatmaAdaylari: async (bugun) => { assert.strictEqual(bugun, BUGUN); return satirlar; },
    tercihOku: async (u) => ({ hatirlatma: true, hatirlatma_sayisi: 0, son_hatirlatma: null, ...(tercihler[u] || {}) }),
    tercihYaz: async (u, a) => { c.tercihYaz.push([u, a]); },
    hatirlatmaIsaretle: async (u, a, b) => { c.isaret.push([u, a, b]); },
    kullanici: async (u) => (u in hesaplar ? hesaplar[u] : { plan: 'pro', email: `${u}@ornek.test` }),
  };
}
const calistir = (d, ek = {}) => {
  const giden = [];
  return H.turCalistir({ depo: d, kullanici: d.kullanici, postaGonder: async (m) => { giden.push(m); return { ok: true }; },
    simdi: SIMDI, env: { SUPABASE_SERVICE_ROLE_KEY: 'g', EPOSTA_GUNLUK: '80' }, log: { info() {} }, ...ek }).then((s) => ({ s, giden }));
};

test('H2: kisi basina TEK e-posta (butun kayitlar birlikte); isaretlenir; sayac artar', async () => {
  const d = sahteDepo({ satirlar: [R('a', 'u1', '2026-09-15'), R('c', 'u1', '2026-08-01')] });
  const { s, giden } = await calistir(d);
  assert.deepStrictEqual(s, [{ user_id: 'u1', durum: 'gonderildi', adet: 2 }]);
  assert.strictEqual(giden.length, 1);
  assert.strictEqual(giden[0].to, 'u1@ornek.test');
  assert.strictEqual(giden[0].subject, 'How did your 2 applications go?');
  assert.match(giden[0].text, /Rolea at Coa \(applied 15 days ago\)/);
  assert.match(giden[0].text, /Rolec at Coc \(applied 60 days ago\)/);
  const link = imza.kapatmaLinki('u1', 'hatirlatma', { SUPABASE_SERVICE_ROLE_KEY: 'g' }, 'basvurular');
  assert.ok(link.includes('/api/v1/basvurular/eposta-kapat?u=u1&t='));
  assert.ok(giden[0].text.includes(link));
  assert.deepStrictEqual(giden[0].headers, { 'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  assert.ok(!/one reminder by email/.test(giden[0].text), 'ucretliye Free notu');
  assert.deepStrictEqual(d.c.isaret, [['u1', ['a', 'c'], ['c']]]);
  assert.deepStrictEqual(d.c.tercihYaz, [['u1', { son_hatirlatma: SIMDI.toISOString(), hatirlatma_sayisi: 1 }]]);
  // ucretli kullanicinin sayaci birikir (Free'nin tek hakki bu sayactan okunur)
  const d2 = sahteDepo({ satirlar: [R('a', 'u1', '2026-09-15')], tercihler: { u1: { hatirlatma_sayisi: 4, son_hatirlatma: '2026-09-28T16:00:00Z' } } });
  await calistir(d2);
  assert.strictEqual(d2.c.tercihYaz[0][1].hatirlatma_sayisi, 5);
});

test('H3: Free: ilk e-posta gider ve bunun tek oldugu yazar; sonraki gun yalnizca isaretlenir', async () => {
  const d = sahteDepo({ satirlar: [R('a', 'u1', '2026-09-15')], hesaplar: { u1: { plan: 'free', email: 'f@ornek.test' } } });
  const { s, giden } = await calistir(d);
  assert.strictEqual(s[0].durum, 'gonderildi');
  assert.match(giden[0].text, /On the Free plan this is your one reminder by email/);
  assert.strictEqual(giden[0].subject, 'How did your application go?');
  const d2 = sahteDepo({ satirlar: [R('a', 'u1', '2026-09-15')], hesaplar: { u1: { plan: 'free', email: 'f@ornek.test' } }, tercihler: { u1: { hatirlatma_sayisi: 1 } } });
  const r2 = await calistir(d2);
  assert.deepStrictEqual(r2.s, [{ user_id: 'u1', durum: 'free_hakki_bitti' }]);
  assert.strictEqual(r2.giden.length, 0);
  assert.deepStrictEqual(d2.c.isaret, [['u1', ['a'], []]], 'Free kaydi her gun yeniden taranirdi');
  // bilinmeyen plan Free sayilir
  const d3 = sahteDepo({ satirlar: [R('a', 'u1', '2026-09-15')], hesaplar: { u1: { plan: 'multi', email: 'm@o.t' } }, tercihler: { u1: { hatirlatma_sayisi: 3 } } });
  assert.strictEqual((await calistir(d3)).s[0].durum, 'free_hakki_bitti');
});

test('H4: gonderilmez: tercih kapali (isaretlenir), 20 saat dolmadi / kota / hata (isaretlenmez), adres yok', async () => {
  const kapali = sahteDepo({ satirlar: [R('a', 'u1', '2026-09-15')], tercihler: { u1: { hatirlatma: false } } });
  const k = await calistir(kapali);
  assert.deepStrictEqual([k.s[0].durum, k.giden.length, kapali.c.isaret.length], ['kapali', 0, 1]);

  const erken = sahteDepo({ satirlar: [R('a', 'u1', '2026-09-15')], tercihler: { u1: { son_hatirlatma: new Date(+SIMDI - 19 * 3600e3).toISOString() } } });
  const e = await calistir(erken);
  assert.deepStrictEqual([e.s[0].durum, e.giden.length, erken.c.isaret.length], ['erken', 0, 0]);
  const dun = sahteDepo({ satirlar: [R('a', 'u1', '2026-09-15')], tercihler: { u1: { son_hatirlatma: new Date(+SIMDI - 23.9 * 3600e3).toISOString() } } });
  assert.strictEqual((await calistir(dun)).s[0].durum, 'gonderildi', 'dun ayni saatte giden e-posta bugunkunu engelledi');

  const hata = sahteDepo({ satirlar: [R('a', 'u1', '2026-09-15')] });
  const h = await calistir(hata, { postaGonder: async () => ({ ok: false, error: 'rate' }) });
  assert.deepStrictEqual([h.s[0].durum, hata.c.isaret.length, hata.c.tercihYaz.length], ['gonderilemedi', 0, 0]);

  const adressiz = sahteDepo({ satirlar: [R('a', 'u1', '2026-09-15')], hesaplar: { u1: { plan: 'pro', email: '' } } });
  assert.strictEqual((await calistir(adressiz)).s[0].durum, 'adres_yok');
  const yok = sahteDepo({ satirlar: [R('a', 'u1', '2026-09-15')], hesaplar: { u1: null } });
  const y = await calistir(yok);
  assert.deepStrictEqual([y.s[0].durum, yok.c.isaret.length], ['hesap_yok', 0]);
});

test('H5: kota dolarsa once ucretliler; kalan ertesi gune (isaretlenmez)', async () => {
  const d = sahteDepo({
    satirlar: [R('a', 'free1', '2026-09-15'), R('b', 'pro1', '2026-09-15'), R('c', 'ult1', '2026-09-15')],
    hesaplar: { free1: { plan: 'free', email: 'f@o.t' }, pro1: { plan: 'pro', email: 'p@o.t' }, ult1: { plan: 'ultimate', email: 'u@o.t' } },
  });
  const { s, giden } = await calistir(d, { env: { SUPABASE_SERVICE_ROLE_KEY: 'g', EPOSTA_GUNLUK: '2' } });
  assert.deepStrictEqual(giden.map((m) => m.to).sort(), ['p@o.t', 'u@o.t']);
  assert.deepStrictEqual(s.find((x) => x.user_id === 'free1').durum, 'tavan');
  assert.ok(!d.c.isaret.some(([u]) => u === 'free1'));
});

test('H6: kota bot ozetiyle ORTAK; eski ad BOT_EPOSTA_GUNLUK da okunuyor', () => {
  assert.strictEqual(kota.tavan({}), 80);
  assert.strictEqual(kota.tavan({ BOT_EPOSTA_GUNLUK: '5' }), 5);
  assert.strictEqual(kota.tavan({ EPOSTA_GUNLUK: '7', BOT_EPOSTA_GUNLUK: '5' }), 7);
  const t = Date.parse('2026-09-30T10:00:00Z');
  kota.say(t); kota.say(t);
  assert.strictEqual(kota.kalan(t, { EPOSTA_GUNLUK: '3' }), 1);
  assert.strictEqual(kota.kalan(Date.parse('2026-10-01T00:01:00Z'), { EPOSTA_GUNLUK: '3' }), 3, 'yeni gunde sifirlanmadi');
  const Z = require('./lib/bot-zamanlayici');
  assert.ok(!/epostaSayaci/.test(require('fs').readFileSync(require.resolve('./lib/bot-zamanlayici'), 'utf8')), 'bot ayri sayac tutuyor');
  assert.strictEqual(typeof Z._sifirla, 'function');
});

test('H7: icerik: kacisli, 10 sinir, satir sonu yok, uzun tire yok; zamanlama gunde bir', () => {
  const kayitlar = Array.from({ length: 12 }, (_, i) => R(`k${i}`, 'u', '2026-09-01', { sirket: i ? `C${i}` : '<script>x</script>' }));
  const e = H.icerik({ kayitlar, bugun: BUGUN, kapatmaLinki: 'https://a.test/k?u=1&t=2', free: false, appUrl: 'https://app.test/' });
  assert.ok(!e.html.includes('<script>') && e.html.includes('&lt;script&gt;'));
  assert.ok(e.text.includes('+ 2 more') && !e.text.includes('C11'));
  assert.ok(e.html.includes('href="https://app.test/dashboard"') && e.html.includes('https://a.test/k?u=1&amp;t=2'));
  assert.ok(!/[\r\n]/.test(e.subject));
  assert.ok(!/—/.test(e.text + e.html));
  assert.ok(!H.zamaniGeldiMi(new Date('2026-09-30T15:59:00Z'), null, {}));
  assert.ok(H.zamaniGeldiMi(new Date('2026-09-30T16:00:00Z'), null, {}));
  assert.ok(!H.zamaniGeldiMi(new Date('2026-09-30T20:00:00Z'), '2026-09-30', {}), 'ayni gun iki kez');
  assert.ok(H.zamaniGeldiMi(new Date('2026-09-30T09:00:00Z'), '2026-09-29', { HATIRLATMA_SAATI: '9' }));
  assert.strictEqual(H.zamanlayiciBaslat({}, { env: { HATIRLATMA_ZAMANLAYICI: 'kapali', SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'y' } }), null);
  assert.strictEqual(H.zamanlayiciBaslat({}, { env: {} }), null);
});

// ── Rotalar ─────────────────────────────────────────────────────────────────
const UID = '11111111-2222-4333-8444-555555555555';
const BID = '99999999-2222-4333-8444-555555555555';
async function uygulama(kullanici, ek = {}) {
  const yolA = require.resolve('./middleware/auth');
  const gercek = require('./middleware/auth');
  const eskiA = require.cache[yolA];
  require.cache[yolA] = { id: yolA, filename: yolA, loaded: true, exports: { ...gercek, requireAuth: async (q) => { q.user = kullanici; } } };
  const cagri = [];
  const eski = {};
  const sahte = {
    liste: async () => [{ id: BID, istemci_id: 'c1', sirket: 'A', pozisyon: 'B', konum: '', link: '', basvuru_tarihi: '2026-09-01', durum: 'Applied', sonuc: null, sonuc_tarihi: null, notlar: '', kaynak: 'elle', created_at: 'x', user_id: UID, hatirlatma_15: null }],
    tercihOku: async () => ({ hatirlatma: false, hatirlatma_sayisi: 1, son_hatirlatma: 'x' }),
    tercihYaz: async (u, a) => { cagri.push(['tercih', u, a]); },
    sayi: async () => 0,
    ekle: async (u, s) => { cagri.push(['ekle', u, s]); return Object.fromEntries(s.map((x, i) => [x.istemci_id, `id${i}`])); },
    guncelle: async (u, id, a) => { cagri.push(['guncelle', u, id, a]); return id === BID ? { id, ...a, user_id: u } : null; },
    sil: async (u, id) => { cagri.push(['sil', u, id]); return id === BID ? 1 : 0; },
    anketYaz: async (u, id, a) => { cagri.push(['anket', u, id, a]); return id === BID; },
    ...ek,
  };
  for (const k of Object.keys(sahte)) { eski[k] = depo[k]; depo[k] = sahte[k]; }
  delete require.cache[require.resolve('./routes/basvuru')];
  const app = require('fastify')({ logger: false });
  await app.register(require('./routes/basvuru'), { prefix: '/api/v1/basvurular' });
  await app.ready();
  return { app, cagri, bitir: async () => {
    await app.close();
    for (const k of Object.keys(eski)) depo[k] = eski[k];
    if (eskiA) require.cache[yolA] = eskiA; else delete require.cache[yolA];
    delete require.cache[require.resolve('./routes/basvuru')];
  } };
}
const kisi = (plan = 'free') => ({ id: UID, app_metadata: { plan } });
const P = (app, url, payload) => app.inject({ method: 'POST', url: `/api/v1/basvurular${url}`, payload });

test('Y1: GET: kendi listesi, izinli alanlar, tercih; Free da kullanabilir', async () => {
  const u = await uygulama(kisi('free'));
  const r = await u.app.inject({ method: 'GET', url: '/api/v1/basvurular' });
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(Object.keys(r.json().basvurular[0]).sort(), ['basvuru_tarihi', 'durum', 'id', 'istemci_id', 'kaynak', 'konum', 'link', 'notlar', 'pozisyon', 'sirket', 'sonuc', 'sonuc_tarihi']);
  assert.deepStrictEqual(r.json().tercih, { hatirlatma: false });
  await u.bitir();
  const h = await uygulama(kisi(), { liste: async () => { throw new Error('x'); } });
  const r2 = await h.app.inject({ method: 'GET', url: '/api/v1/basvurular' });
  assert.deepStrictEqual([r2.statusCode, r2.json().kod], [503, BASVURU.KAYDEDILEMEDI]);
  await h.bitir();
});

test('Y2: ekleme/tasima: suzulur, ayni istemci_id bir kez, bos kart atlanir, eslesme doner; sinirlar', async () => {
  const u = await uygulama(kisi());
  const r = await P(u.app, '', { kayitlar: [{ istemci_id: 'c1', sirket: 'A', pozisyon: 'B', eposta: 'x@y.z', user_id: 'baskasi' }, { istemci_id: 'c1', sirket: 'A2' }, { sirket: '' }] });
  assert.deepStrictEqual(r.json(), { eslesme: { c1: 'id0' }, atlanan: 2 });
  const [, uid, satirlar] = u.cagri[0];
  assert.strictEqual(uid, UID);
  assert.strictEqual(satirlar.length, 1);
  assert.ok(!('eposta' in satirlar[0]) && !('user_id' in satirlar[0]));
  for (const g of [{}, { kayitlar: 'x' }, { kayitlar: Array.from({ length: 501 }, () => ({ sirket: 'a' })) }]) {
    assert.strictEqual((await P(u.app, '', g)).statusCode, 400);
  }
  await u.bitir();
  const dolu = await uygulama(kisi(), { sayi: async () => 1999 });
  const d = await P(dolu.app, '', { kayitlar: [{ sirket: 'a' }, { sirket: 'b' }] });
  assert.deepStrictEqual([d.statusCode, d.json().kod], [422, BASVURU.SINIR]);
  await dolu.bitir();
});

test('Y3: guncelle/sil: kendi kaydi; baskasininki 404; gecersiz 400', async () => {
  const u = await uygulama(kisi());
  const g = await P(u.app, `/${BID}`, { sonuc: 'ise_girdi', user_id: 'baskasi' });
  assert.strictEqual(g.statusCode, 200);
  assert.deepStrictEqual(u.cagri[0].slice(0, 3), ['guncelle', UID, BID]);
  assert.strictEqual(u.cagri[0][3].sonuc, 'ise_girdi');
  assert.ok(!('user_id' in g.json().basvuru));
  const baska = '88888888-2222-4333-8444-555555555555';
  assert.deepStrictEqual([(await P(u.app, `/${baska}`, { durum: 'Offer' })).statusCode], [404]);
  assert.strictEqual((await P(u.app, `/${BID}`, { durum: 'Hired' })).statusCode, 400);
  assert.strictEqual((await P(u.app, '/abc', { durum: 'Offer' })).statusCode, 400);
  assert.strictEqual((await P(u.app, `/${BID}/sil`)).statusCode, 200);
  assert.strictEqual((await P(u.app, `/${baska}/sil`)).statusCode, 404);
  assert.strictEqual((await P(u.app, '/abc/sil')).statusCode, 400);
  await u.bitir();
});

test('Y4: anket ve tercih; kapatma baglantisi yalnizca "hatirlatma" imzasiyla, GET kapatmaz', async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY_ESKI = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-gizli';
  try {
    const u = await uygulama(kisi());
    assert.strictEqual((await P(u.app, '/anket', { basvuru_id: BID, yardim: 5, araclar: ['mock', 'x'] })).statusCode, 200);
    assert.deepStrictEqual(u.cagri.at(-1), ['anket', UID, BID, { yardim: 5, araclar: ['mock'], yorum: '' }]);
    assert.strictEqual((await P(u.app, '/anket', { basvuru_id: '88888888-2222-4333-8444-555555555555' })).statusCode, 404);
    assert.strictEqual((await P(u.app, '/anket', { basvuru_id: 'x' })).statusCode, 400);
    assert.deepStrictEqual((await P(u.app, '/tercih', { hatirlatma: false })).json(), { tercih: { hatirlatma: false } });
    assert.deepStrictEqual(u.cagri.at(-1), ['tercih', UID, { hatirlatma: false }]);
    assert.strictEqual((await P(u.app, '/tercih', { hatirlatma: 'no' })).statusCode, 400);

    const t = imza.imzala(UID, 'hatirlatma');
    const n = u.cagri.length;
    const g = await u.app.inject({ method: 'GET', url: `/api/v1/basvurular/eposta-kapat?u=${UID}&t=${t}` });
    assert.strictEqual(g.statusCode, 200);
    assert.match(g.body, /Turn off application reminders\?/);
    assert.strictEqual(u.cagri.length, n, 'GET kapatti');
    const p = await u.app.inject({ method: 'POST', url: `/api/v1/basvurular/eposta-kapat?u=${UID}&t=${t}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    assert.strictEqual(p.statusCode, 200);
    assert.deepStrictEqual(u.cagri.at(-1), ['tercih', UID, { hatirlatma: false }]);
    const botImza = imza.imzala(UID, 'bot_ozet');
    assert.strictEqual((await u.app.inject({ method: 'POST', url: `/api/v1/basvurular/eposta-kapat?u=${UID}&t=${botImza}` })).statusCode, 400, 'bot baglantisi hatirlatmayi kapatti');
    await u.bitir();
  } finally {
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY_ESKI;
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY_ESKI;
  }
});

test('Y5: index.js rotayi ve zamanlayiciyi bagliyor; hata kodlari disa acik', () => {
  const src = require('fs').readFileSync(require.resolve('./index.js'), 'utf8');
  assert.match(src, /app\.register\(basvuruRoutes,\s*\{ prefix: '\/api\/v1\/basvurular' \}\)/);
  assert.match(src, /require\('\.\/lib\/hatirlatma'\)\.zamanlayiciBaslat\(app\.log\)/);
  assert.deepStrictEqual(require('./lib/hata-kodlari').BASVURU_KODLARI.sort(), ['basvuru_gecersiz', 'basvuru_kaydedilemedi', 'basvuru_sinir', 'basvuru_yok']);
});
