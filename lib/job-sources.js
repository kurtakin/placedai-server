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

const SOURCES = {
  jobbank: { name: 'Job Bank',  bolge: 'CA',     ara: jobBank },
  adzuna:  { name: 'Adzuna',    bolge: 'global', ara: adzuna  },
};

const VARSAYILAN_KAYNAKLAR = Object.keys(SOURCES);

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
async function searchJobs({ keywords = '', location = '', sources, rows = 25, env = process.env } = {}) {
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
      const jobs = await kaynak.ara({ keywords: anahtar, location: String(location || '').trim(), rows, env });
      jobs.forEach((j) => hepsi.push(j));
      ozet.push({ key, name: kaynak.name, status: jobs.length ? 'found' : 'none', count: jobs.length, reason: '' });
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

  return { jobs: benzersiz.slice(0, ADET_SINIRI), count: benzersiz.length, sources: ozet };
}

module.exports = { SOURCES, VARSAYILAN_KAYNAKLAR, searchJobs, tekillestir, ADET_SINIRI };
