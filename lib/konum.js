/**
 * server/lib/konum.js — Ilan konumunu kullanicinin konumuna gore KADEMEYE koyar
 * (yol haritasi madde 5, adim 1, K66).
 *
 * NEDEN. 26 Eylul 2026 yoklamasi (K65): sirket panolari dunyadaki butun
 * ilanlari veriyor; Surrey'deki kullaniciya "Atlanta Warehouse; Chicago
 * Warehouse; Dallas Warehouse" geliyor. Kullanicinin karari: arama, kisinin
 * yasadigi yere yakin olani oncelemeli.
 *
 * NEDEN MESAFE DEGIL KADEME. Elimizde koordinat yok; "12 km" ya da "yuzde 90
 * yakin" yazmak uydurma kesinlik olurdu (K53). Bunun yerine bilinen bir
 * iliski soylenir: ayni sehir, ayni bolge (Surrey icin Lower Mainland), ayni
 * eyalet, ayni ulkede uzaktan. Kademe adi ekranda gorunur.
 *
 * GORULEN BICIMLER (yoklamadan, gercek): "Vancouver, BC", "North Vancouver,
 * BC (Corporate)", "Vancouver, British Columbia", "1219 Adanac St,  Vancouver
 * BC", "Remote", "Remote - US", "Canada", "Venezuela", "Toronto, Ontario,
 * Canada", "Atlanta Warehouse; Chicago Warehouse; ...; New York City, New
 * York, United States". Coklu konumda EN YAKIN parca sayilir.
 *
 * BILINEN SINIRLAR (bilerek):
 *   - Yalnizca sehir adi yazan ilan ("Vancouver") kendi tablomuzdaki sehir
 *     sayilir. Acik bir eyalet/ulke celisirse ("Vancouver, WA", "Surrey,
 *     England") sehir eslesmesi atilir.
 *   - Bolge tablolari simdilik Kanada'nin buyuk metropolleri. Tabloda olmayan
 *     sehir yine sehir/eyalet/ulke kademesinden eslesir, bolge kademesi olmaz.
 */

'use strict';

// ── Tablolar ────────────────────────────────────────────────────────────────

const EYALETLER_CA = {
  BC: ['british columbia'], AB: ['alberta'], SK: ['saskatchewan'], MB: ['manitoba'],
  ON: ['ontario'], QC: ['quebec'], NB: ['new brunswick'], NS: ['nova scotia'],
  PE: ['prince edward island', 'pei'], NL: ['newfoundland and labrador', 'newfoundland'],
  YT: ['yukon'], NT: ['northwest territories'], NU: ['nunavut'],
};

const EYALETLER_US = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut',
  DE: 'delaware', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa',
  KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan',
  MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada',
  NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota',
  OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina',
  SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington',
  WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming', DC: 'district of columbia',
};

/** Ulke adlari -> ISO kodu. Listede olmayan ulke adi "bilinmiyor" kalir, uydurulmaz. */
const ULKELER = {
  CA: ['canada'], US: ['united states', 'united states of america', 'usa', 'u s a', 'u s'],
  GB: ['united kingdom', 'uk', 'england', 'scotland', 'wales', 'northern ireland', 'great britain'],
  IE: ['ireland'], AU: ['australia'], NZ: ['new zealand'], DE: ['germany'], FR: ['france'], ES: ['spain'],
  PT: ['portugal'], IT: ['italy'], NL: ['netherlands'], BE: ['belgium'], CH: ['switzerland'], AT: ['austria'],
  SE: ['sweden'], NO: ['norway'], DK: ['denmark'], FI: ['finland'], PL: ['poland'], RO: ['romania'],
  TR: ['turkey', 'turkiye'], IN: ['india'], PH: ['philippines'], SG: ['singapore'], JP: ['japan'],
  CN: ['china'], HK: ['hong kong'], KR: ['south korea', 'korea'], MX: ['mexico'], BR: ['brazil'],
  AR: ['argentina'], CO: ['colombia'], CL: ['chile'], PE: ['peru'], VE: ['venezuela'], IL: ['israel'],
  AE: ['united arab emirates', 'uae'], ZA: ['south africa'], NG: ['nigeria'], EG: ['egypt'],
};

/** Bolgeler: gunluk gidip gelinebilen metropol alanlari. Anahtar ekranda cevrilir (K25). */
const BOLGELER = {
  lower_mainland: { eyalet: 'BC', ulke: 'CA', sehirler: ['vancouver', 'north vancouver', 'west vancouver', 'burnaby',
    'richmond', 'surrey', 'delta', 'ladner', 'tsawwassen', 'langley', 'coquitlam', 'port coquitlam', 'port moody',
    'new westminster', 'maple ridge', 'pitt meadows', 'white rock', 'abbotsford', 'chilliwack', 'mission',
    'anmore', 'belcarra', 'bowen island', 'lions bay', 'aldergrove', 'cloverdale'] },
  capital_region: { eyalet: 'BC', ulke: 'CA', sehirler: ['victoria', 'saanich', 'langford', 'esquimalt', 'oak bay',
    'colwood', 'sidney', 'sooke', 'view royal', 'central saanich', 'north saanich'] },
  gta: { eyalet: 'ON', ulke: 'CA', sehirler: ['toronto', 'mississauga', 'brampton', 'markham', 'vaughan',
    'richmond hill', 'oakville', 'burlington', 'oshawa', 'whitby', 'ajax', 'pickering', 'milton', 'newmarket',
    'aurora', 'scarborough', 'etobicoke', 'north york', 'caledon', 'halton hills', 'clarington', 'stouffville'] },
  ottawa_gatineau: { eyalet: null, ulke: 'CA', sehirler: ['ottawa', 'gatineau', 'kanata', 'nepean', 'orleans'] },
  greater_montreal: { eyalet: 'QC', ulke: 'CA', sehirler: ['montreal', 'laval', 'longueuil', 'brossard',
    'terrebonne', 'boucherville', 'dorval', 'pointe claire', 'saint laurent', 'repentigny'] },
  calgary_region: { eyalet: 'AB', ulke: 'CA', sehirler: ['calgary', 'airdrie', 'cochrane', 'chestermere', 'okotoks'] },
  edmonton_region: { eyalet: 'AB', ulke: 'CA', sehirler: ['edmonton', 'st albert', 'sherwood park', 'spruce grove',
    'leduc', 'fort saskatchewan', 'nisku', 'beaumont'] },
};
// Ottawa ON, Gatineau QC: bolge iki eyaleti kapsiyor; sehir basina eyalet.
const SEHIR_EYALET_ISTISNA = { gatineau: 'QC' };

/** sehir adi -> { bolge, eyalet, ulke }. Uzun adlar once denenir ("north vancouver" > "vancouver"). */
const SEHIRLER = {};
for (const [bolge, b] of Object.entries(BOLGELER)) {
  for (const s of b.sehirler) SEHIRLER[s] = { bolge, eyalet: SEHIR_EYALET_ISTISNA[s] || b.eyalet || 'ON', ulke: b.ulke };
}
const SEHIR_ADLARI = Object.keys(SEHIRLER).sort((a, b) => b.length - a.length);

const UZAKTAN = /\b(remote|telecommut\w*|work from home|wfh|anywhere|distributed)\b/;

// ── Cozumleme ───────────────────────────────────────────────────────────────

/** kucuk harf, aksansiz, noktalama bosluk. */
function sade(m) {
  return String(m == null ? '' : m).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const kelimeVar = (metin, ad) => (` ${metin} `).includes(` ${ad} `);

/**
 * Tek bir konum parcasini cozer.
 * @param {string} ham     ilan ya da kullanici metni (tek parca)
 * @param {{ulke?: string, uzaktan?: boolean}} [yapisal]  Lever/Workable'in ayri alanlari
 * @returns {{sehir: string|null, bolge: string|null, eyalet: string|null, ulke: string|null, uzaktan: boolean}}
 */
function parcaCoz(ham, yapisal) {
  const orijinal = String(ham == null ? '' : ham);
  const m = sade(orijinal);
  // Parantez icerigi de okunur: "Canada (Remote)" uzaktandir.
  const s = { sehir: null, bolge: null, eyalet: null, ulke: null, uzaktan: UZAKTAN.test(m) };

  // Ulke (yazili)
  for (const [kod, adlar] of Object.entries(ULKELER)) {
    if (adlar.some((a) => kelimeVar(m, a))) { s.ulke = kod; break; }
  }
  // Eyalet: tam ad (kucuk harf) ya da iki harfli kod (orijinal metinde BUYUK harf,
  // "on", "in" gibi Ingilizce kelimelerle karismasin)
  const kodlar = new Set((orijinal.match(/\b[A-Z]{2}\b/g) || []));
  for (const [kod, adlar] of Object.entries(EYALETLER_CA)) {
    if (adlar.some((a) => kelimeVar(m, a)) || kodlar.has(kod)) { s.eyalet = kod; s.ulke = s.ulke || 'CA'; break; }
  }
  if (!s.eyalet) {
    for (const [kod, ad] of Object.entries(EYALETLER_US)) {
      // "new york city, new york" ve "washington dc": tam ad; kod BUYUK harf
      if (kelimeVar(m, ad) || kodlar.has(kod)) { s.eyalet = `US-${kod}`; s.ulke = s.ulke && s.ulke !== 'CA' ? s.ulke : 'US'; break; }
    }
  }
  // "US" iki harfli kod da ulkedir ("Remote - US")
  if (!s.ulke && kodlar.has('US')) s.ulke = 'US';
  if (!s.ulke && kodlar.has('UK')) s.ulke = 'GB';

  // Sehir: once bilinen tablodan (uzun ad once)
  for (const ad of SEHIR_ADLARI) {
    if (!kelimeVar(m, ad)) continue;
    const t = SEHIRLER[ad];
    const celiskili = (s.ulke && s.ulke !== t.ulke) || (s.eyalet && s.eyalet !== t.eyalet);
    if (celiskili) continue;                 // "Vancouver, WA", "Surrey, England"
    s.sehir = ad; s.bolge = t.bolge; s.eyalet = s.eyalet || t.eyalet; s.ulke = s.ulke || t.ulke;
    break;
  }
  // Tabloda olmayan sehir: ilk virgul parcasi, rakamsizsa ve eyalet/ulke/uzaktan degilse
  if (!s.sehir) {
    const ilk = sade(orijinal.split(',')[0]);
    const kelimeDegil = !ilk || /\d/.test(ilk) || UZAKTAN.test(ilk) || ilk.length > 40
      || Object.values(ULKELER).some((a) => a.includes(ilk))
      || Object.values(EYALETLER_CA).some((a) => a.includes(ilk))
      || Object.values(EYALETLER_US).includes(ilk)
      || /^[a-z]{2}$/.test(ilk) || /\b(warehouse|office|hq|headquarters|campus|store|site|hybrid|onsite|on site)\b/.test(ilk);
    if (!kelimeDegil && orijinal.includes(',')) s.sehir = ilk;
  }

  // Yapisal alanlar (varsa metinden guclu): Lever country ISO, workplaceType; Workable telecommuting
  if (yapisal) {
    const u = String(yapisal.ulke || '').trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(u)) s.ulke = u === 'UK' ? 'GB' : u;
    if (yapisal.uzaktan === true) s.uzaktan = true;
  }
  return s;
}

/** Coklu konum: ";", "|", " / " ve kucuk harf " or " ile ayrilmis parcalar
 *  ("Portland, OR" bolunmesin diye buyuk/kucuk harfe duyarli). */
function parcalar(ham) {
  return String(ham == null ? '' : ham).split(/;|\||\s\/\s|\s+or\s+/).map((x) => x.trim()).filter(Boolean);
}

// ── Kademe ──────────────────────────────────────────────────────────────────

/**
 * Kademeler, yakindan uzaga. GORUNUR olanlar varsayilan listede, gerisi
 * "uzak ilanlari da goster" ile acilir (kullanicinin karari).
 * 'uzaktan_belirsiz': "Remote" yazan ama ulkesi belli olmayan ilan. Acik
 * etiketle en sonda gosterilir: ABD'ye ozel olabilir, bunu soyleriz.
 */
const KADEMELER = ['sehir', 'bolge', 'eyalet', 'ulke_uzaktan', 'uzaktan_belirsiz', 'ulke', 'uzak', 'bilinmiyor'];
const GORUNUR = new Set(['sehir', 'bolge', 'eyalet', 'ulke_uzaktan', 'uzaktan_belirsiz']);

function tekKademe(k, i) {
  if (i.uzaktan) {
    // parcaCoz eyalet bulunca ulkeyi de koyar; ulke yoksa "Remote" tek basina.
    if (i.ulke && k.ulke) return i.ulke === k.ulke ? 'ulke_uzaktan' : 'uzak';
    return 'uzaktan_belirsiz';
  }
  // Ayni adli sehir baska eyalet/ulkede olabilir: "Surrey, England", "Vancouver, WA".
  const eyaletCelisir = (i.eyalet && k.eyalet && i.eyalet !== k.eyalet) || (i.ulke && k.ulke && i.ulke !== k.ulke);
  if (!eyaletCelisir && i.sehir && k.sehir && i.sehir === k.sehir) return 'sehir';
  // Bolge eyalet sinirini asabilir (Ottawa ON / Gatineau QC); bolge zaten
  // celiskisiz cozulmus bir sehirden geliyor.
  if (i.bolge && k.bolge && i.bolge === k.bolge) return 'bolge';
  if (i.eyalet && k.eyalet && i.eyalet === k.eyalet) return 'eyalet';
  if (i.ulke && k.ulke) return i.ulke === k.ulke ? 'ulke' : 'uzak';
  return 'bilinmiyor';
}

/**
 * Kullanicinin konum metnini cozer. Bos ya da hicbir sey taninmadiysa null:
 * o zaman siralama yapilmaz, hicbir ilan gizlenmez.
 */
function kullaniciKonumu(ham) {
  const k = parcaCoz(ham);
  return (k.sehir || k.eyalet || k.ulke) ? k : null;
}

/**
 * Bir ilanin kullaniciya gore kademesi. Coklu konumda en yakin parca.
 * @returns {{kademe: string, gorunur: boolean, yer: {sehir:string|null,bolge:string|null,eyalet:string|null,ulke:string|null}}}
 */
function siniflandir(kullanici, ilanKonumu, yapisal) {
  const k = kullanici && typeof kullanici === 'object' ? kullanici : kullaniciKonumu(kullanici);
  const ps = parcalar(ilanKonumu);
  const cozuler = (ps.length ? ps : ['']).map((p) => parcaCoz(p, yapisal));
  if (!k) return { kademe: 'bilinmiyor', gorunur: true, yer: cozuler[0] };
  let en = null;
  for (const c of cozuler) {
    const kd = tekKademe(k, c);
    if (!en || KADEMELER.indexOf(kd) < KADEMELER.indexOf(en.kademe)) en = { kademe: kd, yer: c };
  }
  return { kademe: en.kademe, gorunur: GORUNUR.has(en.kademe), yer: en.yer };
}

/**
 * Ilanlari kademeye gore siralar (kararli: ayni kademede gelis sirasi korunur)
 * ve her ilana `konum_kademe` ekler. Kullanici konumu yoksa sira degismez.
 * @param {object[]} ilanlar   { location, _yapisal? }
 */
function kademeyeGoreSirala(ilanlar, kullaniciMetni) {
  const k = kullaniciKonumu(kullaniciMetni);
  const isaretli = (ilanlar || []).map((j, n) => {
    const s = siniflandir(k, j.location, j._yapisal);
    return { j: { ...j, konum_kademe: k ? s.kademe : null, konum_gorunur: k ? s.gorunur : true, ...(k ? { konum_bolge: s.yer.bolge } : {}) }, n, r: KADEMELER.indexOf(s.kademe) };
  });
  if (k) isaretli.sort((a, b) => a.r - b.r);   // sort kararli (ES2019): ayni kademede gelis sirasi kalir
  return isaretli.map((x) => x.j);
}

module.exports = { parcaCoz, parcalar, kullaniciKonumu, siniflandir, kademeyeGoreSirala, KADEMELER, GORUNUR, BOLGELER, sade };
