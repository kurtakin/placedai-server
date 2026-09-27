/**
 * lib/konum.test.js — Konum kademesi (yol haritasi madde 5, adim 1, K66).
 *
 * Calistir: node --test "*.test.js" "lib/*.test.js" "middleware/*.test.js"
 *
 * Ilan konumlari 26 Eylul 2026 Railway yoklamasindan GERCEK ornekler (K65);
 * birkaci da bilinen tuzaklar icin eklendi (Vancouver WA, Surrey England).
 */

const { test } = require('node:test');
const assert   = require('node:assert');
const K = require('./konum');

const KULLANICI = 'Surrey, BC';
const kd = (ilan, yapisal, k = KULLANICI) => K.siniflandir(k, ilan, yapisal).kademe;

test('K1: yoklamadaki gercek konumlar Surrey kullanicisina gore dogru kademede', () => {
  const beklenen = {
    'Surrey, BC': 'sehir',
    'Vancouver, BC': 'bolge',
    'North Vancouver, BC (Corporate)': 'bolge',
    'Vancouver, British Columbia': 'bolge',
    '1219 Adanac St,  Vancouver  BC': 'bolge',
    'Abbotsford, British Columbia, Canada': 'bolge',
    'Squamish, British Columbia, Canada': 'eyalet',
    'Toronto, Ontario, Canada': 'ulke',
    'Ottawa, Ontario, Canada': 'ulke',
    'London, Ontario, Canada': 'ulke',
    'Remote': 'uzaktan_belirsiz',
    'Remote - US': 'uzak',
    'Canada': 'ulke',
    'Venezuela': 'uzak',
    'Australia': 'uzak',
    'Detroit, MI': 'uzak',
    'Indianapolis, Indiana': 'uzak',
    'Covina, California, United States': 'uzak',
    'Atlanta Warehouse; Chicago Warehouse; Dallas Warehouse; New York City, New York, United States; Phillipsburg Warehouse; San Bernardino Warehouse': 'uzak',
  };
  for (const [ilan, k] of Object.entries(beklenen)) assert.strictEqual(kd(ilan), k, ilan);
});

test('K2: ayni adli sehir baska yerde: "Vancouver, WA" ve "Surrey, England" yakin sayilmiyor', () => {
  assert.strictEqual(kd('Vancouver, WA'), 'uzak');
  assert.strictEqual(kd('Surrey, England'), 'uzak');
  assert.strictEqual(kd('Richmond, VA'), 'uzak');
  assert.strictEqual(kd('Richmond, BC'), 'bolge');
  // uzun ad once: "North Vancouver" ayri bir sehir, "Vancouver" sayilmiyor
  assert.strictEqual(kd('North Vancouver, BC', null, 'Vancouver, BC'), 'bolge');
  assert.strictEqual(kd('Richmond Hill, ON', null, 'Richmond, BC'), 'ulke');
});

test('K3: uzaktan calisma: ulke yaziyla, parantezde ya da yapisal alanda', () => {
  assert.strictEqual(kd('Remote, Canada'), 'ulke_uzaktan');
  assert.strictEqual(kd('Remote - Canada'), 'ulke_uzaktan');
  assert.strictEqual(kd('Canada (Remote)'), 'ulke_uzaktan');
  assert.strictEqual(kd('Work from home - BC'), 'ulke_uzaktan');
  // Lever `country` + workplaceType, Workable `telecommuting`
  assert.strictEqual(kd('Remote', { ulke: 'CA' }), 'ulke_uzaktan');
  assert.strictEqual(kd('Remote', { ulke: 'US' }), 'uzak');
  assert.strictEqual(kd('Vancouver, BC', { uzaktan: true, ulke: 'CA' }), 'ulke_uzaktan');
  assert.strictEqual(kd('Anywhere'), 'uzaktan_belirsiz');
});

test('K4: coklu konumda EN YAKIN parca sayiliyor', () => {
  assert.strictEqual(kd('Toronto, ON; Burnaby, BC'), 'bolge');
  assert.strictEqual(kd('New York, NY | Remote - Canada'), 'ulke_uzaktan');
  assert.strictEqual(kd('Seattle, WA / Surrey, BC'), 'sehir');
  // "Portland, OR" bolunmuyor (OR bir eyalet kodu, "or" baglaci degil)
  assert.strictEqual(K.parcalar('Portland, OR').length, 1);
  assert.deepStrictEqual(K.parcalar('Bend, OR (Hybrid)'), ['Bend, OR (Hybrid)']);
  assert.deepStrictEqual(K.parcalar('Calgary or Edmonton'), ['Calgary', 'Edmonton']);
});

test('K5: eyalet kodu yalniz BUYUK harfle; "on", "in" gibi kelimeler eyalet sayilmiyor', () => {
  assert.strictEqual(K.parcaCoz('Work on site').eyalet, null);
  assert.strictEqual(K.parcaCoz('Calgary, AB').eyalet, 'AB');
  assert.strictEqual(K.parcaCoz('Kelowna, BC').sehir, 'kelowna');   // tabloda yok, virgulden once
  assert.strictEqual(kd('Kelowna, BC'), 'eyalet');
  assert.strictEqual(K.parcaCoz('Montréal, Québec').sehir, 'montreal');   // aksansiz karsilastirma
});

test('K6: bolge baska kullanicilar icin de calisiyor; eyalet sinirini asan bolge', () => {
  assert.strictEqual(kd('Mississauga, ON', null, 'Toronto, Ontario'), 'bolge');
  assert.strictEqual(kd('Laval, QC', null, 'Montréal, Québec'), 'bolge');
  assert.strictEqual(kd('Ottawa, ON', null, 'Gatineau, QC'), 'bolge');
  assert.strictEqual(kd('Vancouver, BC', null, 'Toronto, ON'), 'ulke');
  assert.strictEqual(kd('Vancouver, BC', null, 'Victoria, BC'), 'eyalet');
});

test('K7: gorunurluk: ulke ici yerinde, uzak ve bilinmeyen varsayilanda gizli', () => {
  const g = (ilan) => K.siniflandir(KULLANICI, ilan).gorunur;
  assert.deepStrictEqual(['Surrey, BC', 'Burnaby, BC', 'Kelowna, BC', 'Remote, Canada', 'Remote'].map(g), [true, true, true, true, true]);
  assert.deepStrictEqual(['Toronto, ON', 'Chicago, IL', 'Atlanta Warehouse', ''].map(g), [false, false, false, false]);
});

test('K8: kullanici konumu yoksa hicbir ilan gizlenmiyor ve sira degismiyor', () => {
  assert.strictEqual(K.kullaniciKonumu(''), null);
  assert.strictEqual(K.kullaniciKonumu('abc'), null);
  const ilanlar = [{ title: 'A', location: 'Chicago, IL' }, { title: 'B', location: 'Surrey, BC' }];
  const r = K.kademeyeGoreSirala(ilanlar, '');
  assert.deepStrictEqual(r.map((j) => j.title), ['A', 'B']);
  assert.deepStrictEqual(r.map((j) => [j.konum_kademe, j.konum_gorunur]), [[null, true], [null, true]]);
});

test('K9: siralama yakindan uzaga, ayni kademede gelis sirasi korunuyor; yapisal alan kullaniliyor', () => {
  const ilanlar = [
    { title: 'Chicago', location: 'Chicago, IL' },
    { title: 'BurnabyA', location: 'Burnaby, BC' },
    { title: 'Uzaktan', location: 'Remote', _yapisal: { ulke: 'CA' } },
    { title: 'Surrey', location: 'Surrey, BC' },
    { title: 'BurnabyB', location: 'Vancouver, British Columbia' },
    { title: 'Kelowna', location: 'Kelowna, BC' },
  ];
  const r = K.kademeyeGoreSirala(ilanlar, KULLANICI);
  assert.deepStrictEqual(r.map((j) => j.title), ['Surrey', 'BurnabyA', 'BurnabyB', 'Kelowna', 'Uzaktan', 'Chicago']);
  assert.deepStrictEqual(r.map((j) => j.konum_kademe), ['sehir', 'bolge', 'bolge', 'eyalet', 'ulke_uzaktan', 'uzak']);
  assert.strictEqual(r[1].konum_bolge, 'lower_mainland');
  assert.strictEqual(r[5].konum_gorunur, false);
  assert.strictEqual(ilanlar[0].konum_kademe, undefined, 'girdi dizisi degistirildi');
});

test('K10: metinde iki sehir adi varsa ILK gecen sehirdir (Adzuna "Surrey, Greater Vancouver")', () => {
  const k = K.kullaniciKonumu('Surrey, BC, Canada');
  assert.strictEqual(K.siniflandir(k, 'Surrey, Greater Vancouver').kademe, 'sehir');
  assert.strictEqual(K.parcaCoz('Burnaby, Greater Vancouver').sehir, 'burnaby');
  assert.strictEqual(K.siniflandir(k, 'Burnaby, Greater Vancouver').kademe, 'bolge');
  // ayni yerde baslayan: uzun ad
  assert.strictEqual(K.parcaCoz('North Vancouver, BC').sehir, 'north vancouver');
  assert.strictEqual(K.parcaCoz('Richmond Hill, Greater Toronto').sehir, 'richmond hill');
  assert.strictEqual(K.siniflandir(k, 'Richmond Hill').kademe, 'ulke');   // Ontario; kisa ad "richmond" (BC) olsa 'bolge' derdi
  // celiskili ilk sehir atlanir, sonraki gecerli sehir kalir
  assert.strictEqual(K.parcaCoz('Vancouver, WA').bolge, null);
  assert.strictEqual(K.siniflandir(k, 'Vancouver, WA').kademe, 'uzak');
  assert.strictEqual(K.parcaCoz('Richmond, Greater Vancouver, BC').sehir, 'richmond');
});
