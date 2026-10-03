/**
 * server/lib/kisisellestirme.js — Adayin deneyim seviyesi ve konusma uslubu
 * (K92, 3 Ekim 2026).
 *
 * Overlay'de iki secim: Level ve Style. Varsayilan "Not set": hicbir satir
 * eklenmez, cevap bugunkuyle birebir ayni. Secilirse sistem istemine birer
 * satir eklenir (~30 token; maliyet etkisi ihmal edilebilir).
 *
 * Neden beyaz liste: istemci ne gonderirse gondersin istem metnine YALNIZCA
 * buradaki sabit cumleler girer. Kullanici metni isteme tasinmaz.
 *
 * Neden ilan analizinin `seniority`'si yetmiyor: o ISIN seviyesi (ilandan).
 * Bu adayin KENDI deneyimi. Kidemli bir ilana 2 yillik biri basvurabilir;
 * model onu 8 yillik gibi konusturursa aday mulakatta yalan soylemis olur.
 *
 * Uslup listesi BIZIM (rakibin 10 uslubu kopyalanmadi, kullanici karari
 * 2 Ekim 2026). Uslup uzunlugu degistirmez; o Short/Detailed dugmesinde.
 */
'use strict';

const DENEYIM = {
  student: 'CANDIDATE LEVEL: student or new graduate. Draw on coursework, projects, internships, part-time work and volunteering.',
  '1_3':   'CANDIDATE LEVEL: 1 to 3 years of experience. Show hands-on contribution and fast learning; do not overstate scope or leadership.',
  '3_7':   'CANDIDATE LEVEL: 3 to 7 years of experience. Show ownership of projects and measurable impact, and mentoring only where the profile supports it.',
  '8_plus': 'CANDIDATE LEVEL: 8 or more years of experience. Show judgement, cross-team influence and business impact; avoid entry-level framing.',
  lead:    'CANDIDATE LEVEL: manager or team lead. Frame answers around leading people, decisions, trade-offs and team results.',
};

const USLUP = {
  concise:    'SPEAKING STYLE: concise and direct. Lead with the point, short sentences, no warm-up phrases.',
  warm:       'SPEAKING STYLE: warm and conversational. Friendly, natural phrasing, still professional.',
  structured: 'SPEAKING STYLE: structured. Follow Situation, Task, Action, Result in that order where the question allows it.',
  confident:  'SPEAKING STYLE: confident. Active voice and clear ownership ("I led", "I decided"); no hedging words like "maybe" or "kind of".',
  technical:  'SPEAKING STYLE: technical and precise. Use the exact tools, terms and figures from the candidate profile; avoid vague wording.',
};

// Seviye secildiginde her zaman eklenir: model seviyeyi "abartma izni" sanmasin.
const DENEYIM_SINIRI = 'Never claim experience, seniority or results beyond what the candidate profile shows.';
// Uslup secildiginde: uzunluk kurali ayri, uslup onu ezmesin.
const USLUP_SINIRI = 'The speaking style changes tone only, not the required length or format.';

const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

/**
 * Istek govdesinden istem satirlari. Gecersiz/bos deger = satir yok.
 * @returns {string} '' ya da "\n\n..." ile baslayan blok
 */
function kisiselBlok({ experience_level, communication_style } = {}) {
  const satirlar = [];
  if (has(DENEYIM, experience_level)) satirlar.push(DENEYIM[experience_level], DENEYIM_SINIRI);
  if (has(USLUP, communication_style)) satirlar.push(USLUP[communication_style], USLUP_SINIRI);
  return satirlar.length ? `\n\n${satirlar.join('\n')}` : '';
}

module.exports = { kisiselBlok, DENEYIM, USLUP, DENEYIM_SINIRI, USLUP_SINIRI };
