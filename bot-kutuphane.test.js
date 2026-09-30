/**
 * bot-kutuphane.test.js — Sunucu botunun yapi taslari (K81, 30 Eylul 2026).
 *
 *   lib/bot-puan.js      basit uygunluk puani
 *   lib/bot-profil.js    sunucuda yalnizca is profili (kisisel bilgi yok)
 *   lib/eposta-imza.js   "e-postalari kapat" baglantisinin imzasi
 *   ats-kaynaklari.ekSirketleriTemizle  (K81'de routes/tools.js'ten tasindi)
 *
 * Calistir: node --test
 */

const { test } = require('node:test');
const assert   = require('node:assert');

const { uygunlukPuani, KONUM_ORANI, AGIRLIK } = require('./lib/bot-puan');
const { profilTemizle, ayarTemizle, kisiselMi } = require('./lib/bot-profil');
const imza = require('./lib/eposta-imza');
const { ekSirketleriTemizle, EK_SIRKET_SINIRI } = require('./lib/ats-kaynaklari');
const { KADEMELER } = require('./lib/konum');

const PROFIL = { unvan: 'Data Analyst', beceriler: ['SQL', 'Python', 'Power BI', 'Tableau'] };

test('P1: baslik parcasi arama kelimelerinin baslikta gecme orani; kelime basi eslesmesi', () => {
  const p = (title, anahtar = 'data analyst', profil = {}) => uygunlukPuani({ title }, { anahtar, profil, kademe: 'uzak' }).parcalar.baslik;
  assert.strictEqual(p('Senior Data Analyst'), 45);
  assert.strictEqual(p('Pricing Analyst'), 23);                 // 1/2
  assert.strictEqual(p('Backend Developer'), 0);
  assert.strictEqual(p('Specialist - Software Engineering', 'software engineer'), 45);   // engineer -> Engineering
  assert.strictEqual(p('Metadata Analyst'), 23, 'kelime ortasi eslesmemeli (metadata != data)');
  assert.strictEqual(p('Business/Data Analyst'), 45, 'egik cizgi ayirici');
  // profildeki unvan da sayilir; yuksek olan alinir
  assert.strictEqual(p('Data Analyst', 'reporting specialist', PROFIL), 45);
  assert.strictEqual(p('Anything', '', {}), 0, 'bos anahtar sifir, NaN degil');
});

test('P2: beceri parcasi baslik + aciklamada tam ifade; iki eslesme tam puan', () => {
  const b = (ilan) => uygunlukPuani(ilan, { anahtar: 'x', profil: PROFIL, kademe: 'uzak' }).parcalar.beceri;
  assert.strictEqual(b({ title: 'SQL Developer' }), 15);
  assert.strictEqual(b({ title: 'Analyst', description: 'We use SQL and Power BI daily' }), 30);
  assert.strictEqual(b({ title: 'Analyst', description: 'sql python tableau power bi' }), 30, 'tavan 30');
  assert.strictEqual(b({ title: 'Analyst', description: 'Power users of BI tools' }), 0, '"power bi" ifadesi bitisik olmali');
  assert.strictEqual(b({ title: 'MySQL admin' }), 0, 'MySQL != SQL');
  assert.strictEqual(uygunlukPuani({ title: 'SQL' }, { profil: { beceriler: 'SQL' } }).parcalar.beceri, 0, 'dizi olmayan beceri');
});

test('P3: konum parcasi her kademe icin tanimli ve yakindan uzaga azalmiyor degil', () => {
  for (const k of KADEMELER) assert.ok(k in KONUM_ORANI, `${k} tanimsiz`);
  const puan = (kademe) => uygunlukPuani({ title: '' }, { kademe }).parcalar.konum;
  assert.strictEqual(puan('sehir'), 25);
  assert.strictEqual(puan('uzak'), 0);
  assert.ok(puan('sehir') > puan('bolge') && puan('bolge') > puan('eyalet') && puan('eyalet') > puan('ulke'));
  assert.ok(puan('ulke_uzaktan') > puan('uzaktan_belirsiz'));
  assert.strictEqual(puan(null), puan('bilinmiyor'), 'kademe yoksa bilinmiyor');
  assert.strictEqual(puan('uydurma'), puan('bilinmiyor'));
});

test('P4: toplam 0-100 tamsayi; agirliklar 100 ediyor; bos ilan patlamiyor', () => {
  assert.strictEqual(AGIRLIK.baslik + AGIRLIK.beceri + AGIRLIK.konum, 100);
  const tam = uygunlukPuani({ title: 'Data Analyst', description: 'SQL Python' }, { anahtar: 'data analyst', profil: PROFIL, kademe: 'sehir' });
  assert.deepStrictEqual(tam, { puan: 100, parcalar: { baslik: 45, beceri: 30, konum: 25 } });
  const bos = uygunlukPuani(null);
  assert.ok(Number.isInteger(bos.puan) && bos.puan >= 0 && bos.puan <= 100);
  assert.strictEqual(bos.puan, bos.parcalar.baslik + bos.parcalar.beceri + bos.parcalar.konum);
});

test('P5: olcum verisinde puan sirasi kaynak sirasindan iyi (nDCG@5, K81)', () => {
  // Gercek 46 ilan (Indeed, 30 Eylul 2026), etiketler puanlamadan ONCE yazildi.
  const veri = require('./olcum/bot-puan-indeed.json');
  const konum = require('./lib/konum');
  const dcg = (ls) => ls.reduce((a, l, i) => a + l / Math.log2(i + 2), 0);
  let kaynak = 0, puan = 0;
  for (const a of veri.aramalar) {
    const k = konum.kullaniciKonumu(a.konum);
    const il = a.ilanlar.map(([title, , location, etiket], i) => ({ etiket, i,
      p: uygunlukPuani({ title }, { anahtar: a.kw, profil: veri.profiller[a.kw], kademe: konum.siniflandir(k, location).kademe }).puan }));
    const ideal = dcg(il.map((x) => x.etiket).sort((x, y) => y - x).slice(0, 5));
    kaynak += dcg(il.slice(0, 5).map((x) => x.etiket)) / ideal;
    puan += dcg([...il].sort((x, y) => y.p - x.p || x.i - y.i).slice(0, 5).map((x) => x.etiket)) / ideal;
  }
  const n = veri.aramalar.length;
  assert.ok(puan / n >= 0.85, `puan sirasi nDCG@5 ${(puan / n).toFixed(2)}`);
  assert.ok(puan / n - kaynak / n >= 0.25, 'iyilesme kayboldu');
});

test('R1: profil yalnizca izinli alanlar; kisisel alanlar atiliyor', () => {
  const p = profilTemizle({
    unvan: '  Data   Analyst ', beceriler: ['SQL', 'sql', ' Python ', '', 42, 'jane@doe.com', '+1 (604) 555-0199'],
    sektorler: ['Finance'], deneyim_yili: '4.4',
    ad: 'Jane Doe', telefon: '6045550199', eposta: 'jane@doe.com', adres: '123 Main St', linkedin: 'https://linkedin.com/in/x',
  });
  assert.deepStrictEqual(p, { unvan: 'Data Analyst', beceriler: ['SQL', 'Python'], sektorler: ['Finance'], deneyim_yili: 4 });
  assert.deepStrictEqual(profilTemizle(null), {});
  assert.deepStrictEqual(profilTemizle(['x']), {});
  assert.deepStrictEqual(profilTemizle({ unvan: 'mail me at a@b.co' }), {}, 'unvanda e-posta');
  assert.deepStrictEqual(profilTemizle({ deneyim_yili: 99 }), {});
  assert.deepStrictEqual(profilTemizle({ deneyim_yili: -1 }), {});
  assert.deepStrictEqual(profilTemizle({ deneyim_yili: null }), {});
  assert.deepStrictEqual(profilTemizle({ deneyim_yili: '' }), {});
  assert.deepStrictEqual(profilTemizle({ deneyim_yili: 0 }), { deneyim_yili: 0 });
});

test('R2: sinirlar: 30 beceri, 10 sektor, uzunluk; kontrol karakteri gidiyor', () => {
  const p = profilTemizle({
    beceriler: Array.from({ length: 50 }, (_, i) => `skill${String.fromCharCode(97 + (i % 26))}${i}`),
    sektorler: Array.from({ length: 20 }, (_, i) => `sector ${String.fromCharCode(97 + i)}`),
    unvan: 'x'.repeat(500),
  });
  assert.strictEqual(p.beceriler.length, 30);
  assert.strictEqual(p.sektorler.length, 10);
  assert.strictEqual(p.unvan.length, 120);
  assert.strictEqual(profilTemizle({ beceriler: ['a'.repeat(100)] }).beceriler[0].length, 40);
  assert.deepStrictEqual(profilTemizle({ unvan: 'Data\u0000\nAnalyst' }), { unvan: 'Data Analyst' });
});

test('R3: kisisel bilgi tanima: yanlis pozitifler dusuk', () => {
  for (const x of ['a@b.com', '604-555-0199', '+44 20 7946 0958', 'www.x.com', 'https://a.b', 'V6B 1A1', 'v6b1a1']) assert.ok(kisiselMi(x), x);
  for (const x of ['C++', 'Python 3', 'ISO 27001', 'Windows Server 2019/2022', 'Power BI', 'Node.js', 'S3', 'Six Sigma', 'A/B testing']) assert.ok(!kisiselMi(x), x);
});

test('R4: ayarlar: yalnizca gonderilen alanlar; konum bolge olmali', () => {
  assert.deepStrictEqual(ayarTemizle({ aktif: true }), { alanlar: { aktif: true } });
  assert.deepStrictEqual(ayarTemizle({ aktif: 'true', eposta_ozet: 0 }), { alanlar: {} }, 'boolean olmayan yok sayilir');
  assert.deepStrictEqual(ayarTemizle({ konum: ' Toronto,  ON ' }), { alanlar: { konum: 'Toronto, ON' } });
  assert.deepStrictEqual(ayarTemizle({ konum: '123 Main St, Toronto' }), { hata: 'konum_bolge' });
  assert.deepStrictEqual(ayarTemizle({ konum: 'Toronto M5V 2T6' }), { hata: 'konum_bolge' });
  assert.deepStrictEqual(ayarTemizle({ konum: '' }), { alanlar: { konum: '' } }, 'konumu silmek serbest');
  assert.deepStrictEqual(ayarTemizle({ anahtar_kelime: 'call 604 555 0199' }), { alanlar: { anahtar_kelime: '' } });
  const s = ayarTemizle({ sirketler: [{ platform: 'lever', kod: 'plaid' }, { platform: 'x', kod: 'y' }], profil: { unvan: 'QA', ad: 'Jane' }, user_id: 'baskasi', son_eposta: null });
  assert.deepStrictEqual(s, { alanlar: { sirketler: [{ platform: 'lever', kod: 'plaid' }], profil: { unvan: 'QA' } } }, 'user_id gibi alanlar gecmez');
  assert.deepStrictEqual(ayarTemizle(null), { alanlar: {} });
});

test('R5: sirket listesi denetimi (tasindi, davranis ayni)', () => {
  assert.strictEqual(EK_SIRKET_SINIRI, 20);
  assert.deepStrictEqual(ekSirketleriTemizle('x'), []);
  const r = ekSirketleriTemizle([
    { platform: 'greenhouse', kod: 'stripe', ad: '  Stripe  ' },
    { platform: 'lever', kod: 'x', bolge: 'eu' },
    { platform: 'workable', kod: '../etc' },
    { platform: 'lever', kod: 5 },
    null,
  ]);
  assert.deepStrictEqual(r, [{ platform: 'greenhouse', kod: 'stripe', ad: 'Stripe' }, { platform: 'lever', kod: 'x', bolge: 'eu' }]);
  assert.strictEqual(ekSirketleriTemizle(Array.from({ length: 30 }, (_, i) => ({ platform: 'lever', kod: `k${i}` }))).length, 20);
});

test('I1: imza: dogru kullanici ve amacla dogrulaniyor, baskasininki ve baska amac gecmiyor', () => {
  const env = { SUPABASE_SERVICE_ROLE_KEY: 'gizli' };
  const t = imza.imzala('u1', 'bot_ozet', env);
  assert.match(t, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(imza.dogrula('u1', 'bot_ozet', t, env));
  assert.ok(!imza.dogrula('u2', 'bot_ozet', t, env));
  assert.ok(!imza.dogrula('u1', 'kampanya', t, env));
  assert.ok(!imza.dogrula('u1', 'bot_ozet', t.slice(0, 31) + (t[31] === 'A' ? 'B' : 'A'), env));
  assert.ok(!imza.dogrula('u1', 'bot_ozet', undefined, env));
  assert.ok(!imza.dogrula('u1', 'bot_ozet', t, { SUPABASE_SERVICE_ROLE_KEY: 'baska' }), 'anahtar degisince eski imza gecmez');
  // anahtar service-role anahtarinin kendisi degil
  assert.notStrictEqual(imza.anahtar(env), 'gizli');
  assert.strictEqual(imza.anahtar({ BOT_EPOSTA_ANAHTARI: 'k', SUPABASE_SERVICE_ROLE_KEY: 'gizli' }), 'k');
});

test('I2: anahtar yoksa imza ve baglanti yok; baglanti adresi dogru', () => {
  assert.strictEqual(imza.imzala('u1', 'bot_ozet', {}), null);
  assert.strictEqual(imza.kapatmaLinki('u1', 'bot_ozet', {}), null);
  assert.ok(!imza.dogrula('u1', 'bot_ozet', 'x'.repeat(32), {}));
  const env = { SUPABASE_SERVICE_ROLE_KEY: 'gizli', API_URL: 'https://api.ornek.com/' };
  const l = imza.kapatmaLinki('a b', 'bot_ozet', env);
  assert.ok(l.startsWith('https://api.ornek.com/api/v1/bot/eposta-kapat?u=a%20b&t='), l);
  assert.ok(imza.kapatmaLinki('u1', 'bot_ozet', { SUPABASE_SERVICE_ROLE_KEY: 'g' }).startsWith(imza.API_URL_VARSAYILAN));
});
