/**
 * cv-olusturucu.test.js — Boş bir alan, uydurulacak bir alan değildir.
 *
 * Calistir: node --test "*.test.js" "lib/*.test.js" "middleware/*.test.js"
 *
 * NEDEN VAR. 19 Eylul 2026'da /build-resume okundu ve uc kusur cikti. Ucu de
 * daha once BASKA sayfalarda olculup duzeltilmis kusurlarin ayni sayfadaki
 * kopyalariydi; yani K31 kalibi: ayni isin ikinci kopyasi sessizce bozuk.
 *
 * 1. YER TUTUCULAR MODELE "BURAYI DOLDUR" DIYORDU.
 *
 *      `• ${e.title || 'Role'} at ${e.company || 'Company'} (${e.dates || 'Dates'})`
 *
 *    Kullanici sirket adini bos biraktiginda modele su gidiyordu:
 *      "• Analyst at Company (Dates): ..."
 *    Modelin iki secenegi vardi, ikisi de kotu: "Company" kelimesini CV'ye
 *    yazmak, ya da bosluga bir sirket ve bir tarih UYDURMAK. Ustelik bu metin
 *    kullanicinin ADIYLA isverene gidiyor.
 *
 * 2. BOS CV "1 words" ILE BASARI SAYILIYORDU.
 *
 *      resume.trim().split(/\s+/).length   // bos metinde 1
 *
 *    Kapak mektubunda ayni satir K33'te duzeltilmisti; burada duruyordu.
 *
 * 3. ISTEM RAKAM UYDURMAYA DAVET EDIYORDU.
 *
 *      "Quantify achievements with metrics where possible based on the
 *       provided information"
 *
 *    Nitelik vardi ama emir kipi ondan gucluydu: modele "rakam koy" deniyor,
 *    eline rakam verilmiyordu. Kapak mektubunda ayni cumlenin bedeli
 *    olculmustu (K32).
 */

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');

const { CVB, CVB_KODLARI } = require('./lib/hata-kodlari');
const PRACT = fs.readFileSync(path.join(__dirname, 'routes', 'practice.js'), 'utf8');

function yorumsuz(kaynak) {
  return kaynak
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
}

function rotaGovdesi(yol) {
  const bas = PRACT.indexOf(`fastify.post('${yol}'`);
  assert.ok(bas > 0, `${yol} yok`);
  const son = PRACT.indexOf('fastify.post(', bas + 10);
  return yorumsuz(PRACT.slice(bas, son < 0 ? PRACT.length : son));
}

function resumeIstemi() {
  const bas = PRACT.indexOf('const RESUME_SYSTEM');
  assert.ok(bas > 0, 'RESUME_SYSTEM yok');
  const ham = PRACT.slice(bas, PRACT.indexOf('const ADAPT_CV_SYSTEM', bas));
  return ham.split('`')[1] || '';
}

/** Rotadaki deneyim/egitim satiri kurucularini GERCEKTEN calistirir. */
function kurucular() {
  const g = rotaGovdesi('/build-resume');
  const bas = g.indexOf('const yazi = (d) =>');
  const skillsBas = g.indexOf('const skillsText');
  const son = g.indexOf(';', g.indexOf("typeof skills === 'string'", skillsBas)) + 1;
  assert.ok(bas > 0 && skillsBas > bas && son > skillsBas, 'kurucu blok bulunamadi');
  const kod = g.slice(bas, son);
  return new Function('experience', 'education', 'skills', kod + '\n return { expText, eduText, skillsText };');
}

// ── A: yer tutucu yok ──────────────────────────────────────────────────────

test('A1: eski yer tutucular kaynakta KALMADI', () => {
  const g = rotaGovdesi('/build-resume');
  for (const yt of ["|| 'Role'", "|| 'Company'", "|| 'Dates'", "|| 'Degree'", "|| 'Institution'"]) {
    assert.ok(!g.includes(yt), `yer tutucu geri gelmis: ${yt}`);
  }
});

test('A2: BOS alan isteme hic girmiyor (davranis)', () => {
  const kur = kurucular();
  const r = kur([{ title: 'Inventory Control Specialist', description: 'Reconciled stock records' }], [], []);
  assert.ok(!/Company|Dates|Role/.test(r.expText), `yer tutucu sizmis: ${r.expText}`);
  assert.strictEqual(r.expText, '• Inventory Control Specialist: Reconciled stock records');
});

test('A3: dolu alanlar aynen geciyor', () => {
  const kur = kurucular();
  const r = kur([{ title: 'Analyst', company: 'Wesco', dates: 'Sep 2022 - Present', description: 'Did things' }],
                [{ degree: 'MBA', institution: 'UCW', year: '2022' }], ['SQL', 'Excel']);
  assert.strictEqual(r.expText, '• Analyst at Wesco (Sep 2022 - Present): Did things');
  assert.strictEqual(r.eduText, '• MBA · UCW (2022)');
  assert.strictEqual(r.skillsText, 'SQL, Excel');
});

test('A4: bombos bir kayit satir URETMIYOR', () => {
  // Kullanici "+ Deneyim Ekle"ye basip doldurmadan birakabilir. Eskiden bu
  // isteme "• Role at Company (Dates):" diye giriyordu.
  const kur = kurucular();
  const r = kur([{}, { title: '' }], [{}], []);
  assert.strictEqual(r.expText, '', `bos kayit satir uretti: ${JSON.stringify(r.expText)}`);
  assert.strictEqual(r.eduText, '');
});

test('A5: hic kayit yoksa "Not provided" yaziyor, uydurma degil', () => {
  const kur = kurucular();
  const r = kur([], [], []);
  assert.strictEqual(r.expText, 'Not provided');
  assert.strictEqual(r.eduText, 'Not provided');
  assert.strictEqual(r.skillsText, '');
});

test('A6: bozuk girdiler patlamiyor', () => {
  const kur = kurucular();
  for (const x of [null, undefined, 'metin', 42, {}]) {
    const r = kur(x, x, x);
    assert.strictEqual(typeof r.expText, 'string');
    assert.strictEqual(typeof r.eduText, 'string');
  }
});

// ── B: cikti dogrulamasi ───────────────────────────────────────────────────

test('B1: BOS CV 200 ile donmuyor', () => {
  const g = rotaGovdesi('/build-resume');
  assert.match(g, /if \(words < 120\)/, 'cikti denetimi yok');
  assert.match(g, /CVB_HATA\.URETILEMEDI/, 'kod dondurulmuyor');
  assert.match(g, /reply\.code\(422\)/, '422 yerine basarili yanit donuyor');
});

test('B2: kelime sayisi BOS metinde 1 demiyor', () => {
  // JS davranisini kayda gecirir: gerekce silinirse test de duser.
  assert.strictEqual(''.trim().split(/\s+/).length, 1, 'JS degismis, test guncellenmeli');
  assert.strictEqual(''.split(/\s+/).filter(Boolean).length, 0);
  const g = rotaGovdesi('/build-resume');
  assert.match(g, /metin \? metin\.split\(\/\\s\+\/\)\.filter\(Boolean\)\.length : 0/,
    'kelime sayisi hala bos metinde 1 verebilir');
});

test('B3: KESILME ayri bir hata', () => {
  // Kesilen bir CV, kesilen bir JSON gibi gurultu cikarmaz: CV GIBI GORUNUR,
  // cumlenin ortasinda biter. Kullanici fark etmezse isverene yarim bir metin
  // gonderir. Bu yuzden "uretilemedi" ile ayni cumleyi gormemeli.
  const g = rotaGovdesi('/build-resume');
  assert.match(g, /const ustveri = \{\};/, 'ustveri yok');
  assert.match(g, /\}, ustveri\);/, 'ustveri createMessage\'e gecirilmiyor');
  assert.match(g, /if \(ustveri\.kesildi\)/, 'kesilme ayirt edilmiyor');
  assert.match(g, /CVB_HATA\.YANIT_KESILDI/, 'kesilme icin ayri kod yok');
  assert.ok(g.indexOf('ustveri.kesildi') < g.indexOf('words < 120'),
    'kesilme denetimi gec kaliyor, kesilen CV "uretilemedi" diye raporlanir');
});

test('B4: ad reddi KOD tasiyor, elle yazilmis kod yok', () => {
  const g = rotaGovdesi('/build-resume');
  assert.match(g, /CVB_HATA\.AD_GEREKLI/, 'ad reddi kod tasimiyor');
  const elle = [...g.matchAll(/kod:\s*'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(elle, [], `elle yazilmis kodlar: ${elle.join(', ')}`);
});

test('B5: token butcesi 400-550 KELIMELIK Turkce cikti icin yeterli', () => {
  // 1200 idi. Istem 400-550 kelime istiyor; Turkce ~2.27 token/kelime, yani
  // 550 kelime ~1250 token. 1200 tam sinirin ALTINDA kaliyordu.
  const g = rotaGovdesi('/build-resume');
  const m = /max_tokens: (\d+)/.exec(g);
  assert.ok(m, 'max_tokens yok');
  assert.ok(Number(m[1]) >= 1500, `butce ${m[1]}, 550 kelimelik Turkce cikti icin dar`);
});

test('B6: her CVB kodunun istemci cevirisi var', () => {
  const I18N = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'public', 'dashboard-app', 'i18n.js'), 'utf8');
  const eksik = [];
  for (const k of CVB_KODLARI) {
    if (!I18N.includes(`'rv.hata_${k}'`))  eksik.push(`rv.hata_${k}`);
    if (!I18N.includes(`'rv.oneri_${k}'`)) eksik.push(`rv.oneri_${k}`);
  }
  assert.deepStrictEqual(eksik, [], `cevirisi olmayan kodlar: ${eksik.join(', ')}`);
});

// ── C: istemdeki K32 kurallari ─────────────────────────────────────────────

test('C1: rakam uydurmaya DAVET eden cumle kaldirildi', () => {
  const istem = resumeIstemi();
  assert.ok(!/Quantify achievements with metrics where possible/.test(istem),
    'modele "rakam koy" diyen emir hala duruyor');
});

test('C2: uydurma yasagi ve rakam kurali var', () => {
  const istem = resumeIstemi();
  assert.match(istem, /NEVER INVENT FACTS/, 'uydurma yasagi yok');
  assert.match(istem, /ONLY if that exact number is in the information given/,
    'rakam sarti yazilmamis');
  assert.match(istem, /write the achievement without a number/,
    'rakam yoksa ne yapilacagi yazilmamis');
});

test('C3: beceri SISIRME yasagi var', () => {
  // Sayfa 6'da sinirda kalan vaka: beceri listesinde "Excel" yaziyordu,
  // ilanda "advanced Excel"; uretilen metin "use Excel at an advanced level"
  // dedi. DEVAM.md'de "ayni sinif baska sayfalarda da gorulurse kural
  // sertlestirilir" diye kayitliydi. CV Olusturucu tam olarak beceri
  // listesinden cumle ureten sayfa.
  const istem = resumeIstemi();
  assert.match(istem, /Do not upgrade a plain skill into a qualified one/,
    'sisirme yasagi yok');
  assert.match(istem, /"Excel" does not become "advanced Excel"/, 'ornek yok');
});

test('C4: eksik alan kurali ve tarih kurali var', () => {
  const istem = resumeIstemi();
  assert.match(istem, /MISSING INFORMATION/, 'eksik alan bolumu yok');
  assert.match(istem, /do not carry a label like "Company" or "Dates"/,
    'yer tutucu yasagi yazilmamis');
  assert.match(istem, /DATES/, 'tarih bolumu yok');
  assert.match(istem, /do not compute durations/, 'sure hesabi yasagi yok');
});

test('C5: istemde TURKCE gerekce metni yok', () => {
  // Gerekce kod yorumunda durmali: istemdeki her satir modele gidiyor ve
  // ciktinin dilini karistirabilir (Sayfa 6, F5).
  const istem = resumeIstemi();
  const turkce = istem.match(/\b(olculdu|icin|degil|kullanici|uydurma|gerekce|yasagi)\b/gi) || [];
  assert.deepStrictEqual(turkce, [], `istemde Turkce kalinti: ${turkce.join(', ')}`);
});

test('C6: kod tarafi CVB kodlarini TANIYOR', () => {
  assert.strictEqual(CVB.AD_GEREKLI, 'rv_ad_gerekli');
  assert.strictEqual(CVB.URETILEMEDI, 'rv_uretilemedi');
  assert.strictEqual(CVB.YANIT_KESILDI, 'rv_yanit_kesildi');
  assert.notStrictEqual(CVB.URETILEMEDI, CVB.YANIT_KESILDI,
    'uretilememe ile kesilme ayni koda baglanmis');
});
