/**
 * server/lib/ats-kaynaklari.js — Greenhouse, Lever, Workable: sirketlerin
 * KENDI ilan panolari (yol haritasi madde 5, K65).
 *
 * NEDEN RESMI API. K21: yalnizca ilanini kendisi dagitan resmi kanallar. Bu uc
 * platform her sirketin ilanlarini herkese acik bir JSON ucundan veriyor;
 * kazima yok, anahtar yok. Karsiligi: "tum ilanlarda ara" diye bir uc yok,
 * sirket sirket sorulur. Bu yuzden bir SIRKET LISTESI gerekiyor (kullanicinin
 * karari: biz oneririz, kullanici da kariyer sayfasi linkiyle ekler).
 *
 * ADIM 0, OLCUM. Job Bank'in dersi (12 Eylul 2026): kaynak kagit uzerinde
 * resmiydi ama Railway'in IP'sini reddetti. Bu dosyanin ilk kullanimi
 * `yoklama()`: aday listeyi Railway'den gercekten sorar ve her sirket icin
 * durum, ilan sayisi, sure ve gelen alan adlarini dondurur. Normallestirme
 * alan adlari belgelere gore yazildi; yoklamanin `ornek_alanlar` ciktisi
 * onlari gercek cevapla karsilastirmak icin.
 */

'use strict';

const ZAMAN_ASIMI_MS = 12000;
const KOD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/**
 * Onerilecek sirket ADAYLARI. 26 Eylul 2026'da web aramasindan (site:
 * aramalari, Vancouver/BC ve tedarik zinciri/depo odakli) toplandi. HENUZ
 * DOGRULANMADI: arama sonuclari eski olabilir. Listeye girmenin sarti
 * Railway'den yoklamada ilan dondurmek.
 */
const ADAYLAR = [
  ...['ibkr', 'asana', 'vaco', 'lush', 'twilio', 'stockx', 'flexport', 'supplyhouse', 'unybrands']
    .map((kod) => ({ platform: 'greenhouse', kod })),
  ...['arcteryx.com', 'paralleldomain', 'badge-group', 'matchgroup', 'invinity', 'voltus', 'minesense', 'knix', 'Black-White-Zebra']
    .map((kod) => ({ platform: 'lever', kod })),
  ...['veritree', 'novacom', 'bardel-entertainment', 'export-development-canada', 'keycafe', 'joey-restaurants-1',
    'cobs-bread-2', 'doman-building-materials', 'woodfibre-management-limited', 'now-courier', 'spt-labtech',
    'efm-warehousing', 'silver-hills-bakery']
    .map((kod) => ({ platform: 'workable', kod })),
];

// ── Linkten sirket ─────────────────────────────────────────────────────────

/**
 * Kullanicinin yapistirdigi kariyer sayfasi linkinden platform ve sirket kodu.
 * Taninmayan link null: tahmin yok.
 * @returns {{platform: 'greenhouse'|'lever'|'workable', kod: string, bolge?: 'eu'} | null}
 */
function linktenSirket(ham) {
  const metin = String(ham == null ? '' : ham).trim();
  if (!metin) return null;
  let u;
  try { u = new URL(/^https?:\/\//i.test(metin) ? metin : `https://${metin}`); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const parca = u.pathname.split('/').filter(Boolean);
  const sonuc = (platform, kod, ek) => (kod && KOD.test(kod) ? { platform, kod, ...(ek || {}) } : null);

  if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(host)) {
    if (parca[0] === 'embed') return sonuc('greenhouse', u.searchParams.get('for'));
    return sonuc('greenhouse', parca[0]);
  }
  if (host === 'boards-api.greenhouse.io' && parca[0] === 'v1' && parca[1] === 'boards') return sonuc('greenhouse', parca[2]);
  if (host === 'jobs.lever.co') return sonuc('lever', parca[0]);
  if (host === 'jobs.eu.lever.co') return sonuc('lever', parca[0], { bolge: 'eu' });
  if (host === 'apply.workable.com') return (parca[0] === 'api' || parca[0] === 'j') ? null : sonuc('workable', parca[0]);
  const alt = host.match(/^([a-z0-9-]+)\.workable\.com$/);
  if (alt && !['www', 'apply', 'jobs'].includes(alt[1])) return sonuc('workable', alt[1]);
  return null;
}

// ── Platform uclari ve normallestirme ──────────────────────────────────────

const metin = (d) => (typeof d === 'string' ? d.trim() : '');
function guvenliHttps(u) {
  try { const x = new URL(String(u || '')); return x.protocol === 'https:' ? x.href : ''; } catch { return ''; }
}
const tarih = (d) => {
  const t = typeof d === 'number' ? d : Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
};

const PLATFORMLAR = {
  greenhouse: {
    ad: 'Greenhouse',
    adres: (kod) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(kod)}/jobs`,
    liste: (d) => (d && Array.isArray(d.jobs) ? d.jobs : null),
    ilan: (j, kod) => ({
      title: metin(j.title),
      link: guvenliHttps(j.absolute_url),
      company: metin(j.company_name) || kod,
      location: metin(j.location && j.location.name),
      date: tarih(j.first_published || j.updated_at),
    }),
  },
  lever: {
    ad: 'Lever',
    adres: (kod, bolge) => `https://api${bolge === 'eu' ? '.eu' : ''}.lever.co/v0/postings/${encodeURIComponent(kod)}?mode=json`,
    liste: (d) => (Array.isArray(d) ? d : null),
    ilan: (j, kod) => ({
      title: metin(j.text),
      link: guvenliHttps(j.hostedUrl),
      company: kod,
      location: metin(j.categories && j.categories.location),
      date: tarih(j.createdAt),
    }),
  },
  workable: {
    ad: 'Workable',
    adres: (kod) => `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(kod)}`,
    liste: (d) => (d && Array.isArray(d.jobs) ? d.jobs : null),
    ilan: (j, kod, d) => ({
      title: metin(j.title),
      link: guvenliHttps(j.url || j.shortlink || j.application_url),
      company: metin(d && d.name) || kod,
      location: [j.city, j.state, j.country].map(metin).filter(Boolean).join(', '),
      date: tarih(j.published_on || j.created_at),
    }),
  },
};

/**
 * Bir sirketin ilanlari, normallesmis. Baglantisi olmayan ya da basliksiz
 * ilan atilir (tiklanamayan bir kart gostermenin anlami yok).
 * @returns {Promise<{durum:'ok'|'bos'|'yok'|'hata', http:number|null, ilanlar:object[], ham_alanlar:string[], hata?:string}>}
 */
async function sirketIlanlari({ platform, kod, bolge }, fetchFn = fetch) {
  const p = PLATFORMLAR[platform];
  if (!p || !KOD.test(String(kod || ''))) return { durum: 'hata', http: null, ilanlar: [], ham_alanlar: [], hata: 'gecersiz sirket' };
  let r;
  try {
    r = await fetchFn(p.adres(kod, bolge), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(ZAMAN_ASIMI_MS) });
  } catch (e) {
    return { durum: 'hata', http: null, ilanlar: [], ham_alanlar: [], hata: String((e && e.message) || e).slice(0, 120) };
  }
  if (r.status === 404) return { durum: 'yok', http: 404, ilanlar: [], ham_alanlar: [] };
  if (!r.ok) return { durum: 'hata', http: r.status, ilanlar: [], ham_alanlar: [], hata: `HTTP ${r.status}` };
  let d;
  try { d = await r.json(); } catch { return { durum: 'hata', http: r.status, ilanlar: [], ham_alanlar: [], hata: 'JSON cozulemedi' }; }
  const liste = p.liste(d);
  if (!liste) return { durum: 'hata', http: r.status, ilanlar: [], ham_alanlar: [], hata: 'beklenmeyen bicim' };
  const ilanlar = liste.filter((j) => j && typeof j === 'object')
    .map((j) => ({ ...p.ilan(j, kod, d), source: p.ad }))
    .filter((j) => j.title && j.link);
  const ham_alanlar = liste[0] && typeof liste[0] === 'object' ? Object.keys(liste[0]).slice(0, 40) : [];
  return { durum: ilanlar.length ? 'ok' : 'bos', http: r.status, ilanlar, ham_alanlar };
}

// ── Adim 0: Railway'den yoklama ────────────────────────────────────────────

/** Sinirli eszamanlilikla calistir (bir platformu ayni anda 30 istekle bogmayalim). */
async function sirayla(isler, esZaman, fn) {
  const sonuc = new Array(isler.length);
  let i = 0;
  const isci = async () => { while (i < isler.length) { const n = i++; sonuc[n] = await fn(isler[n]); } };
  await Promise.all(Array.from({ length: Math.min(esZaman, isler.length) }, isci));
  return sonuc;
}

/**
 * Her sirketi gercekten sorar. Icerik DONDURMEZ: yalnizca durum, sayi, sure,
 * alan adlari ve bir ornek baslik (eslesmenin dogru calistigini gormek icin).
 */
async function yoklama(sirketler, fetchFn = fetch, simdi = () => Date.now()) {
  const liste = (Array.isArray(sirketler) && sirketler.length ? sirketler : ADAYLAR).slice(0, 60);
  const sonuclar = await sirayla(liste, 6, async (s) => {
    const bas = simdi();
    const r = await sirketIlanlari(s, fetchFn);
    return { platform: s.platform, kod: s.kod, durum: r.durum, http: r.http, adet: r.ilanlar.length,
      ms: simdi() - bas, ham_alanlar: r.ham_alanlar, ...(r.hata ? { hata: r.hata } : {}),
      ...(r.ilanlar[0] ? { ornek: { title: r.ilanlar[0].title, location: r.ilanlar[0].location, company: r.ilanlar[0].company } } : {}) };
  });
  const ozet = { ok: 0, bos: 0, yok: 0, hata: 0 };
  for (const s of sonuclar) ozet[s.durum] = (ozet[s.durum] || 0) + 1;
  // ASIL SORU: Railway bu platforma ULASABILIYOR mu? Herhangi bir HTTP cevabi
  // (404 dahil: yanlis sirket kodu ama sunucu cevap verdi) ulasildi demek;
  // cevapsiz hata (baglanti kesildi, zaman asimi) ulasilamadi demek.
  const platformlar = {};
  for (const s of sonuclar) {
    const p = (platformlar[s.platform] ||= { toplam: 0, ulasilan: 0, ilanli: 0 });
    p.toplam++;
    if (s.http != null) p.ulasilan++;
    if (s.durum === 'ok') p.ilanli++;
  }
  return { ozet, platformlar, sonuclar };
}

module.exports = { ADAYLAR, linktenSirket, sirketIlanlari, yoklama, PLATFORMLAR };
