/**
 * server/lib/mock-denetim.js — Sesli deneme mulakati geri bildiriminin
 * KODDA olculen denetimi (yol haritasi M3, 26 Eylul 2026).
 *
 * NEDEN VAR. Ornek alinan projede ("PrepWise") model transkripte 0-100 arasi
 * bes kategori puani veriyor ve hicbir kanit gostermiyordu. K53'te ayni sinifi
 * olctuk: modelin kendi uydurdugu sayi bir olcum gibi ekrana geliyordu.
 * Burada iki sey kodda:
 *   1. Sayi yok, bant var: guclu / orta / gelistirilmeli / degerlendirilemedi.
 *   2. Her bant, adayin KENDI cevabindan bir alintiyla gelir ve alinti kodda
 *      aranir. Cevaplarda gecmiyorsa kategori "degerlendirilemedi" olur ve
 *      yorumu silinir: kaniti olmayan bir yargi gosterilmez.
 * Bu, yorumun DOGRU oldugunu kanitlamaz; alintinin UYDURULMADIGINI kanitlar.
 */

'use strict';

const KATEGORILER = ['communication', 'technical', 'problem_solving', 'role_fit', 'confidence'];
const BANTLAR     = ['strong', 'fair', 'weak', 'not_assessable'];
const EN_AZ_ALINTI_KELIME = 3;

/** Karsilastirma bicimi: kucuk harf, noktalama ve tirnak yok, tek bosluk. */
function sade(m) {
  return String(m || '')
    .toLowerCase()
    .replace(/[‘’“”"'`.,;:!?()\[\]{}…-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Alinti adayin cevaplarinda geciyor mu? Cok kisa alinti kanit sayilmaz. */
function alintiDogrula(alinti, cevaplar) {
  const a = sade(alinti);
  if (a.split(' ').filter(Boolean).length < EN_AZ_ALINTI_KELIME) return false;
  return sade(cevaplar).includes(a);
}

const yazi = (d, en) => (typeof d === 'string' ? d.trim().slice(0, en) : '');
const liste = (d, adet, en) => (Array.isArray(d) ? d : [])
  .map((x) => yazi(x, en)).filter(Boolean).slice(0, adet);

/**
 * Modelin geri bildirimini temizler ve kanitlari dogrular.
 * @param {object} r         modelin JSON'u
 * @param {string} cevaplar  adayin butun cevaplari, birlestirilmis
 * @returns {{categories: object, strengths: string[], improvements: string[], summary: string}}
 */
function geriBildirimDenetle(r, cevaplar) {
  const kaynak = (r && typeof r.categories === 'object' && r.categories) || {};
  const categories = {};
  for (const k of KATEGORILER) {
    const c = (kaynak[k] && typeof kaynak[k] === 'object') ? kaynak[k] : {};
    let band     = BANTLAR.includes(c.band) ? c.band : 'not_assessable';
    let comment  = yazi(c.comment, 500);
    let evidence = yazi(c.evidence, 300);
    let dogrulanamadi = false;
    if (band !== 'not_assessable' && !alintiDogrula(evidence, cevaplar)) {
      band = 'not_assessable';
      dogrulanamadi = true;
    }
    if (band === 'not_assessable') { evidence = ''; if (dogrulanamadi) comment = ''; }
    categories[k] = { band, comment, evidence, ...(dogrulanamadi ? { unverified: true } : {}) };
  }
  return {
    categories,
    strengths:    liste(r && r.strengths, 5, 300),
    improvements: liste(r && r.improvements, 5, 300),
    summary:      yazi(r && r.summary, 800),
  };
}

module.exports = { KATEGORILER, BANTLAR, sade, alintiDogrula, geriBildirimDenetle };
