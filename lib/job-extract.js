/**
 * server/lib/job-extract.js — Cikarilan is ilaninin ISE YARAR olup olmadigi.
 *
 * Neden var: 12 Eylul 2026'da uretimde olculdu. LinkedIn ilan adresi verilince
 * /fetch-job HTTP 200 donuyordu ama icerik bostu:
 *
 *   title: null, company: null, location: null, description: 112 karakter
 *   description = "The provided text contains only CSS styling code and HTML
 *                  reset styles from LinkedIn's web interface. No job listing
 *                  information is present in this content."
 *
 * Arayuz bunu basari sayip ekrana yesil tik koyuyordu ("✅ Listing · ·") ve is
 * tanimi kutusuna bu metni dolduruyordu. 156 karakter, uretim esigi 50, yani
 * kullanici "Generate Full Package" butonuna basabiliyordu. Bastim: ATS 0,
 * CV bos, hicbir hata mesaji yok.
 *
 * Eski koruma yalnizca GIRDIYE bakiyordu (sayfa metni 100 karakterden uzun mu).
 * LinkedIn'in giris duvari bu esigi CSS metniyle rahatca geciyor. Bu yuzden
 * artik CIKTI'ya bakiyoruz: elde bir isveren ya da unvan yoksa ve aciklama
 * kisaysa, ortada CV uyarlanacak bir ilan yok demektir.
 */

'use strict';

/** Aciklamanin anlamli sayilmasi icin gereken en az uzunluk. */
const ASGARI_ACIKLAMA = 200;

/**
 * @returns {{ gecerli: boolean, sebep: string, oneri: string }}
 */
function ilanCikarimiGecerliMi(jobData) {
  const bos = (x) => !x || String(x).trim() === '' || String(x).trim().toLowerCase() === 'null';

  const unvan   = !bos(jobData && jobData.title);
  const sirket  = !bos(jobData && jobData.company);
  const aciklama = String((jobData && jobData.description) || '').trim();

  if (!unvan && !sirket) {
    return {
      gecerli: false,
      sebep:   'Bu sayfadan is ilani bilgisi cikarilamadi (unvan ve sirket bulunamadi).',
      oneri:   'Sayfa muhtemelen giris istiyor ya da ilan JavaScript ile yukleniyor. Ilan metnini kopyalayip asagidaki kutuya yapistir, o her zaman calisir.',
    };
  }

  if (aciklama.length < ASGARI_ACIKLAMA) {
    return {
      gecerli: false,
      sebep:   `Ilan aciklamasi cok kisa (${aciklama.length} karakter), CV uyarlamak icin yetmez.`,
      oneri:   'Ilan metnini kopyalayip asagidaki kutuya yapistir.',
    };
  }

  return { gecerli: true, sebep: '', oneri: '' };
}

module.exports = { ilanCikarimiGecerliMi, ASGARI_ACIKLAMA };
