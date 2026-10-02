'use strict';

/**
 * server/lib/bot-ozet.js — Gunluk bot ozeti e-postasinin ICERIGI (K81).
 *
 * Saf islev: veri girer, {subject, text, html} cikar. Gonderme ve "gunde en
 * fazla bir" kurali lib/bot-zamanlayici.js'te.
 *
 * Ilanlar e-postada tiklanabilir DEGIL; tek dugme bot sayfasina gider.
 * Neden: kullanicinin karari (K79/K80) basvuru webde, onayla kaydedilir. Ilan
 * baglantisi dogrudan e-postadan acilsaydi basvuru takibi bos kalirdi.
 *
 * Puan sayisi gosterilmez, yalnizca sira. Olcum (K81): aciklamasi olmayan
 * ilanda (sirket panolari) beceri parcasi hep sifir, en iyi ilan bile ~70
 * aliyor; "%70 uygun" yazmak yaniltici olurdu.
 *
 * Metin simdilik Ingilizce (arayuzun varsayilan dili). Kullanicinin dili
 * tabloya eklenince burasi cevrilir.
 */

const APP_URL_VARSAYILAN = 'https://www.placedai.app';
const GOSTERILEN = 10;

// Adzuna API sarti (2 Ekim 2026): Adzuna ilani yayinlanan her yerde "Jobs by
// Adzuna", "Jobs" adzuna.co.uk'a, "Adzuna" yerine logo. E-posta da bir
// yayin; ilanlardan biri Adzuna'dansa e-postanin altina eklenir. E-posta
// istemcileri SVG gostermez, logo PNG ve mutlak adresli.
const ADZUNA_ATIF_URL = 'https://www.adzuna.co.uk';
const adzunaMi = (k) => /^adzuna\b/i.test(String(k || '').trim());

function kacis(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Tek satir, e-posta konusu icin: satir sonu ve kontrol karakteri yok. */
function tekSatir(s, sinir) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, sinir);
}

/**
 * @param {{ilanlar: {baslik:string, sirket:string, konum:string, kaynak?:string}[], anahtar: string,
 *          kapatmaLinki: string|null, appUrl?: string}} g
 */
function ozetIcerigi({ ilanlar, anahtar, kapatmaLinki, appUrl = process.env.APP_URL || APP_URL_VARSAYILAN }) {
  const n = ilanlar.length;
  const gosterilen = ilanlar.slice(0, GOSTERILEN);
  const kalan = n - gosterilen.length;
  const sayfa = `${String(appUrl).replace(/\/+$/, '')}/dashboard`;
  const kelime = tekSatir(anahtar, 60);

  const subject = `${n} new job ${n === 1 ? 'match' : 'matches'}${kelime ? ` for "${kelime}"` : ''}`;
  const satir = (j) => [j.baslik, j.sirket, j.konum].map((x) => tekSatir(x, 200)).filter(Boolean).join(' · ');
  const adzuna = gosterilen.some((j) => adzunaMi(j.kaynak));
  const logo = `${String(appUrl).replace(/\/+$/, '')}/adzuna/logo.png`;

  const text = [
    `Your PlacedAI job bot found ${n} new ${n === 1 ? 'listing' : 'listings'}${kelime ? ` for "${kelime}"` : ''}, best matches first:`,
    '',
    ...gosterilen.map((j, i) => `${i + 1}. ${satir(j)}`),
    ...(kalan > 0 ? ['', `+ ${kalan} more on your bot page.`] : []),
    ...(adzuna ? ['', `Jobs by Adzuna: ${ADZUNA_ATIF_URL}`] : []),
    '',
    `Review and approve: ${sayfa}`,
    'The bot never applies on its own. You decide which ones to apply to.',
    '',
    'You get this email because the job bot is on in your PlacedAI account (at most one email a day).',
    ...(kapatmaLinki ? [`Turn off these emails: ${kapatmaLinki}`] : []),
  ].join('\n');

  const li = gosterilen.map((j) => `<li style="margin:0 0 10px"><b>${kacis(tekSatir(j.baslik, 200))}</b><br>`
    + `<span style="color:#555">${kacis([j.sirket, j.konum].map((x) => tekSatir(x, 200)).filter(Boolean).join(' · '))}</span></li>`).join('');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.45;color:#111;max-width:560px">`
    + `<p>Your PlacedAI job bot found <b>${n}</b> new ${n === 1 ? 'listing' : 'listings'}${kelime ? ` for "${kacis(kelime)}"` : ''}, best matches first:</p>`
    + `<ol style="padding-left:20px">${li}</ol>`
    + (kalan > 0 ? `<p>+ ${kalan} more on your bot page.</p>` : '')
    + (adzuna ? `<p style="font-size:13px;color:#555;margin:0 0 12px"><a href="${ADZUNA_ATIF_URL}" style="color:#555">Jobs</a> by `
      + `<a href="${ADZUNA_ATIF_URL}"><img src="${kacis(logo)}" alt="Adzuna" height="23" style="height:23px;vertical-align:middle;border:0"></a></p>` : '')
    + `<p><a href="${kacis(sayfa)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Review and approve</a></p>`
    + '<p style="color:#555">The bot never applies on its own. You decide which ones to apply to.</p>'
    + '<hr style="border:none;border-top:1px solid #ddd">'
    + '<p style="color:#777;font-size:12px">You get this email because the job bot is on in your PlacedAI account (at most one email a day).'
    + (kapatmaLinki ? ` <a href="${kacis(kapatmaLinki)}" style="color:#777">Turn off these emails</a>.` : '')
    + '</p></div>';

  return { subject, text, html };
}

module.exports = { ozetIcerigi, kacis, GOSTERILEN, APP_URL_VARSAYILAN };
