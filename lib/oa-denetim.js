/**
 * server/lib/oa-denetim.js — HireVue cevap taslaginin KODDA olculen denetimi.
 *
 * NEDEN VAR. 25 Eylul 2026'da olculdu (K55 eki): kullanicinin gercek CV'si
 * verildiginde model CV'de OLMAYAN bir olay kurdu (bir mal kabulunde
 * etiketleme hatasi, Operasyon ekibiyle duzeltme, rastgele sayim kontrolleri)
 * ve bunu koseli parantez olmadan, adayin kendi hikayesi gibi yazdi. Ayni
 * cevapta zaman plani 90 saniyeydi, secilen sure 120.
 *
 * Istemdeki yasak asil koruma; bu dosya modelin uyup uymadigina bakmadan
 * dogrulanabilen iki seyi kodda duzeltir:
 *   1. Kaynakta (CV + soru) olmayan her sayi "[number]" olur.
 *   2. Zaman planindaki S/T/A/R saniyeleri secilen sureye tam denk gelir.
 */

'use strict';

const SAYI = /\d+(?:[.,]\d+)*/g;
const sade = (s) => s.replace(/[.,]/g, '');

/**
 * Kaynakta olmayan sayilari "[number]" yapar. Zaten koseli parantez icinde
 * duran bir sayiya ("[30]") dokunmaz; o zaten doldurulacak bir yer.
 * Yaziyla yazilan sayilar ("thirty") yakalanmaz: bu denetim uydurmayi
 * azaltir, yok etmez.
 */
function kaynaksizSayilariParantezle(metin, kaynak) {
  const var_ = new Set((String(kaynak || '').match(SAYI) || []).map(sade));
  const m = String(metin || '');
  return m.replace(SAYI, (s, yer) => {
    if (var_.has(sade(s))) return s;
    if (m[yer - 1] === '[' && m[yer + s.length] === ']') return s;
    return '[number]';
  });
}

/**
 * "S:25s ... T:15s ... A:35s ... R:15s" planini secilen sureye denkler.
 * Tam olarak S, T, A, R sirasiyla dort parca bulunmazsa plan oldugu gibi
 * doner: bicimini bilmedigimiz bir metni bozmaktansa birakmak daha iyi.
 * Parcalar 5 saniyeye yuvarlanir, fark en uzun parcaya (genelde A) eklenir.
 */
function zamanPlaniniDenkle(plan, sure) {
  const p = String(plan || '');
  if (!(sure >= 20)) return p;
  const parca = [...p.matchAll(/\b([STAR])\s*:\s*(\d+)\s*s\b/g)];
  if (parca.length !== 4 || parca.map((x) => x[1]).join('') !== 'STAR') return p;
  const eski = parca.map((x) => parseInt(x[2], 10));
  const top = eski.reduce((a, b) => a + b, 0);
  if (!top || top === sure) return p;
  const yeni = eski.map((v) => Math.max(5, Math.round((v * sure) / top / 5) * 5));
  let enBuyuk = 0;
  yeni.forEach((v, i) => { if (v > yeni[enBuyuk]) enBuyuk = i; });
  yeni[enBuyuk] += sure - yeni.reduce((a, b) => a + b, 0);
  if (yeni[enBuyuk] < 5) return p;
  let i = 0;
  return p.replace(/\b([STAR])\s*:\s*(\d+)\s*s\b/g, (_, h) => `${h}:${yeni[i++]}s`);
}

module.exports = { kaynaksizSayilariParantezle, zamanPlaniniDenkle };
