/**
 * server/lib/job-sources.js — Is ilani kaynaklari, tek kaynak.
 *
 * Arayuz hangi sitenin tarandigini kendi listesinden uydurmaz; bu modulun
 * dondurdugu ozeti gosterir (K21). Bir kaynak eklendiginde ya da dustugunde
 * ekrandaki liste kendiliginden degisir.
 *
 * Neden kazima yok:
 *   Web tarayicisi baska bir sitenin sayfasini okuyamaz (same-origin). Sunucu
 *   okumaya kalkarsa kullanicinin uyeligiyle degil, veri merkezi IP'siyle
 *   gider; LinkedIn, Indeed, Glassdoor ve ZipRecruiter bunu engeller. Olculdu:
 *   eski /search-jobs her sorguda count:0 donuyordu. Bu yuzden kaynaklarin
 *   hepsi, ilanlarini kendisi dagitan resmi kanallardir.
 */

'use strict';

const { fetchWithStatus, parseAtom } = require('./net-feeds');

const ADET_SINIRI = 40;

/** Job Bank (Kanada, resmi, anahtar gerekmez). Atom besleme. */
async function jobBank({ keywords, location, rows }) {
  const url = 'https://www.jobbank.gc.ca/jobsearch/feed/jobSearchRSSfeed'
    + `?searchstring=${encodeURIComponent(keywords)}`
    + `&locationstring=${encodeURIComponent(location)}`
    + `&sort=D&rows=${rows}`;

  const { status, body } = await fetchWithStatus(url);
  if (status !== 200) throw new Error(`HTTP ${status}`);

  const items = parseAtom(body);
  if (!items.length && !/<feed/i.test(body)) throw new Error('Besleme bicimi taninmadi');
  return items.map((j) => ({ ...j, source: 'Job Bank' }));
}

/** Adzuna (toplayici, ucretsiz anahtar). Anahtar yoksa kaynak atlanir. */
async function adzuna({ keywords, location, rows, env }) {
  const id  = env.ADZUNA_APP_ID;
  const key = env.ADZUNA_APP_KEY;
  if (!id || !key) {
    const e = new Error('ADZUNA_APP_ID ve ADZUNA_APP_KEY tanimli degil');
    e.yapilandirilmamis = true;
    throw e;
  }

  const ulke = (env.ADZUNA_COUNTRY || 'ca').toLowerCase();
  const url = `https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(ulke)}/search/1`
    + `?app_id=${encodeURIComponent(id)}&app_key=${encodeURIComponent(key)}`
    + `&results_per_page=${rows}`
    + `&what=${encodeURIComponent(keywords)}`
    + (location ? `&where=${encodeURIComponent(location)}` : '')
    + '&content-type=application/json';

  const { status, body } = await fetchWithStatus(url, { headers: { Accept: 'application/json' } });
  if (status !== 200) throw new Error(`HTTP ${status}`);

  let veri;
  try { veri = JSON.parse(body); }
  catch { throw new Error('JSON cozulemedi'); }

  const liste = Array.isArray(veri.results) ? veri.results : [];
  return liste.map((r) => ({
    title:       String(r.title || '').replace(/<[^>]+>/g, '').trim(),
    link:        r.redirect_url || '',
    company:     (r.company && r.company.display_name) || '',
    location:    (r.location && r.location.display_name) || '',
    salary:      r.salary_min ? `${Math.round(r.salary_min)}${r.salary_max ? ` - ${Math.round(r.salary_max)}` : ''}` : '',
    date:        r.created || '',
    description: String(r.description || '').slice(0, 400),
    source:      'Adzuna',
  })).filter((j) => j.title && j.link);
}

// ── Sirket panolari: Greenhouse / Lever / Workable (yol haritasi 5, K68) ────
//
// Onerilen 29 sirket (K67) + kullanicinin ekledikleri. Her pano 6 saat
// onbellekte: ayni sirketi her aramada yeniden sormak hem yavas (Lever 0,5-2
// sn, K65) hem gereksiz. Hata veren pano 10 dakika tutulur ki bozuk bir pano
// her aramayi bekletmesin. Anahtar kelime ILAN BASLIGINDA aranir: her kelime
// bir kelimenin basinda gecmeli ("analyst" -> "Analysts" eslesir).
const ats = require('./ats-kaynaklari');
const { ONERILEN } = require('./ats-sirketler');
const { kademeyeGoreSirala, sade } = require('./konum');

const PANO_ONBELLEK_MS = 6 * 3600 * 1000;
const PANO_HATA_MS     = 10 * 60 * 1000;
const _panolar = new Map();
const DURAK = new Set(['and', 'or', 'the', 'of', 'in', 'at', 'for', 'to', 've', 'ile']);

async function panoIlanlari(s, fetchFn, simdi) {
  const anahtar = `${s.platform}/${String(s.kod).toLowerCase()}`;
  const kayit = _panolar.get(anahtar);
  if (kayit && simdi - kayit.zaman < kayit.omur) return kayit.r;
  const r = await ats.sirketIlanlari(s, fetchFn);
  _panolar.set(anahtar, { zaman: simdi, omur: r.durum === 'hata' ? PANO_HATA_MS : PANO_ONBELLEK_MS, r });
  return r;
}

function kelimeler(k) {
  return sade(k).split(' ').filter((w) => w.length >= 2 && !DURAK.has(w));
}
function basliktaVar(baslik, ks) {
  const t = ` ${sade(baslik)}`;
  return ks.length > 0 && ks.every((w) => t.includes(` ${w}`));
}

async function sirketPanolari({ keywords, fetchFn = fetch, ekSirketler = [], simdi = Date.now() }) {
  const gorulen = new Set();
  const liste = [...ONERILEN, ...(Array.isArray(ekSirketler) ? ekSirketler : [])].filter((s) => {
    const a = s && `${s.platform}/${String(s.kod || '').toLowerCase()}`;
    if (!a || gorulen.has(a)) return false;
    gorulen.add(a); return true;
  }).slice(0, 60);
  const sonuc = await ats.sirayla(liste, 6, (s) => panoIlanlari(s, fetchFn, simdi));
  const okunamayan = sonuc.filter((r) => r.durum === 'hata').length;
  if (okunamayan === liste.length) throw new Error(`${okunamayan}/${liste.length} pano okunamadi`);
  const ks = kelimeler(keywords);
  const jobs = sonuc.flatMap((r) => r.ilanlar).filter((j) => basliktaVar(j.title, ks)).map((j) => ({ ...j }));
  // Kismi ariza gizlenmez: ozet satirinda "3/29 pano okunamadi" yazar.
  jobs.uyari = okunamayan ? `${okunamayan}/${liste.length} pano okunamadi` : '';
  return jobs;
}

const SOURCES = {
  jobbank:   { name: 'Job Bank',  bolge: 'CA',     ara: jobBank, sunucudanErisilebilir: false },
  adzuna:    { name: 'Adzuna',    bolge: 'global', ara: adzuna,  sunucudanErisilebilir: true  },
  // K65: Railway'den 31/31 pano yanit verdi.
  sirketler: { name: 'Company job boards', bolge: 'global', ara: sirketPanolari, sunucudanErisilebilir: true },
};

/**
 * Varsayilanda YALNIZCA sunucudan gercekten erisilebilen kaynaklar var.
 *
 * Job Bank tanimi silinmedi, cunku masaustu uygulamasi kullanicinin kendi
 * baglantisindan cikiyor ve orada calisabilir. Ama Railway'den erisilemiyor:
 * 12 Eylul 2026'da olculdu, bes kez uste uste 'read ECONNRESET', ana sayfa
 * dahil her adres. Ayni anda example.com 200 donuyordu, yani sunucunun agi
 * saglamdi. jobbank.gc.ca IP'mizi reddediyor ve kullanicinin yapabilecegi bir
 * sey yok; her aramada kirmizi bir hata gostermek urunu bozuk gosterirdi.
 *
 * Gerekirse sources: ['jobbank'] ile acikca istenebilir.
 */
const VARSAYILAN_KAYNAKLAR = Object.keys(SOURCES).filter((k) => SOURCES[k].sunucudanErisilebilir);

/** Baslik + sirket ve baglantiya gore tekillestir. */
function tekillestir(jobs) {
  const gorulen = new Set();
  return jobs.filter((j) => {
    const baslik = String(j.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
    const sirket = String(j.company || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 25);
    const anahtar = `${baslik}|${sirket}`;
    if (gorulen.has(anahtar)) return false;
    gorulen.add(anahtar);

    const url = String(j.link || '').split('?')[0].split('#')[0];
    if (url) {
      if (gorulen.has(url)) return false;
      gorulen.add(url);
    }
    return true;
  });
}

/**
 * Secilen kaynaklari paralel tarar.
 * Doner: { jobs, sources: [{ key, name, status, count, reason }] }
 *   status: 'found' | 'none' | 'error' | 'unconfigured'
 */
async function searchJobs({ keywords = '', location = '', sources, rows = 25, env = process.env,
  kullaniciKonumu = '', uzaklariGoster = false, ekSirketler = [], fetchFn } = {}) {
  const anahtar = String(keywords || '').trim();
  if (!anahtar) {
    const e = new Error('keywords required');
    e.kullaniciHatasi = true;
    throw e;
  }

  const secilen = (Array.isArray(sources) && sources.length ? sources : VARSAYILAN_KAYNAKLAR)
    .filter((k) => Object.prototype.hasOwnProperty.call(SOURCES, k));

  const ozet = [];
  const hepsi = [];

  await Promise.all(secilen.map(async (key) => {
    const kaynak = SOURCES[key];
    try {
      const jobs = await kaynak.ara({ keywords: anahtar, location: String(location || '').trim(), rows, env,
        ekSirketler, ...(fetchFn ? { fetchFn } : {}) });
      jobs.forEach((j) => { j._kaynakAnahtari = key; hepsi.push(j); });
      ozet.push({ key, name: kaynak.name, status: jobs.length ? 'found' : 'none', count: jobs.length, reason: jobs.uyari || '' });
    } catch (err) {
      ozet.push({
        key,
        name:   kaynak.name,
        status: err.yapilandirilmamis ? 'unconfigured' : 'error',
        count:  0,
        reason: err.message || 'bilinmeyen hata',
      });
    }
  }));

  ozet.sort((a, b) => secilen.indexOf(a.key) - secilen.indexOf(b.key));
  const benzersiz = tekillestir(hepsi);

  // Kaynak sayilari tekrar ayiklama SONRASI bildirilir. Yoksa kutuda 25,
  // ozet satirinda 23 yaziyor ve kullanici icin tutarsiz gorunuyordu:
  // ikisi farkli sey sayiyordu.
  const kalanSayim = benzersiz.reduce((a, j) => {
    if (j._kaynakAnahtari) a[j._kaynakAnahtari] = (a[j._kaynakAnahtari] || 0) + 1;
    return a;
  }, {});
  for (const s of ozet) {
    if (s.status === 'found' || s.status === 'none') {
      s.count  = kalanSayim[s.key] || 0;
      s.status = s.count ? 'found' : 'none';
    }
  }

  // KONUM (K68, kullanicinin karari): yakindan uzaga siralanir; uzak ilanlar
  // varsayilanda gizlenir ve SAYISI soylenir, istenirse gosterilir. Kullanici
  // konumu yoksa arama konumu kullanilir; o da yoksa sira degismez, gizleme yok.
  const siralanmis = kademeyeGoreSirala(benzersiz, String(kullaniciKonumu || location || '').trim());
  const gorunen = uzaklariGoster ? siralanmis : siralanmis.filter((j) => j.konum_gorunur);

  const cikti = gorunen.slice(0, ADET_SINIRI).map((j) => {
    const { _kaynakAnahtari, _yapisal, konum_gorunur, ...kalan } = j;
    return kalan;
  });

  return { jobs: cikti, count: benzersiz.length, gizlenen: siralanmis.length - gorunen.length, sources: ozet };
}

function _panoOnbelleginiBosalt() { _panolar.clear(); }

module.exports = { SOURCES, VARSAYILAN_KAYNAKLAR, searchJobs, tekillestir, ADET_SINIRI, basliktaVar, kelimeler, _panoOnbelleginiBosalt };
