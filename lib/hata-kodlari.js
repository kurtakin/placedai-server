/**
 * server/lib/hata-kodlari.js — Kullaniciya gosterilecek hata kodlari, tek kaynak.
 *
 * Neden var: sunucu hazir METIN dondurdugunde arayuz Ingilizce'yken Turkce
 * mesaj goruntuleniyordu (12 Eylul 2026, kullanicinin ekran goruntusunde
 * yakalandi). Sunucu kullanicinin dilini bilmez, bu yuzden KOD donduruyor ve
 * metni arayuz kendi sozlugunden yaziyor (K25).
 *
 * Kodlar burada tanimli cunku:
 *   1. Rotada elle yazilinca yazim hatasi sessizce gecerdi
 *   2. Web tarafindaki ceviri testi listeyi BURADAN okuyor; yeni bir kod
 *      eklenip cevirisi yazilmazsa test duser (K21)
 */

'use strict';

/** CV dosyasi okuma hatalari. Her biri icin cvm.hata_* ve cvm.oneri_* gerekir. */
const CV = {
  PDF_OKUNAMADI:  'pdf_okunamadi',    // metin var ama cozulemedi (CID font)
  PDF_TARANMIS:   'pdf_taranmis',     // metin katmani hic yok (tarama/foto)
  DOSYA_OKUNAMADI:'dosya_okunamadi',  // PDF disi dosya okunamadi
  ALAN_CIKMADI:   'cv_alan_cikmadi',  // metin okundu ama AI alan cikaramadi
};

/** Is ilani cekme hatalari. Her biri icin apm.hata_* ve apm.oneri_* gerekir. */
const ILAN = {
  OKUNAMADI:     'ilan_okunamadi',
  ACIKLAMA_KISA: 'aciklama_kisa',
};

/**
 * Ilan analizi (JD) hatalari. Her biri icin jd.hata_* ve jd.oneri_* gerekir.
 *
 * 16 Eylul 2026'da olculdu: /analyze-jd cikti dogrulamasi YAPMIYORDU. AI bos
 * key_skills ve bos predicted_questions donse bile 200 doner, arayuz sonuc
 * panelini acar ve ustune yesil "overlay'e yuklendi" rozetini basardi. CV
 * yuklemede ayni sinif zaten yakalanmisti; burada da vardi.
 */
const JD = {
  URL_YAPISTIRILDI: 'jd_url_yapistirildi', // kutuya ilan metni degil adres girildi
  KISA_METIN:       'jd_kisa_metin',       // 50 karakterin altinda
  COZULEMEDI:       'jd_cozulemedi',       // AI yaniti JSON degil
  ALAN_CIKMADI:     'jd_alan_cikmadi',     // JSON geldi ama beceri/soru bos
};

/**
 * Kapak mektubu hatalari. Her biri icin clm.hata_* ve clm.oneri_* gerekir.
 *
 * 16 Eylul 2026'da olculdu: /cover-letter cikti dogrulamasi YAPMIYORDU. AI bos
 * dizgi donse bile 200 doner, ustelik kelime sayisi 1 gorunurdu, cunku
 * ''.trim().split(/\s+/).length === 1. Ekranda bos bir kutu ve "1 words".
 */
const KAPAK = {
  KISA_ILAN:   'cl_kisa_ilan',   // ilan metni 50 karakterin altinda
  URETILEMEDI: 'cl_uretilemedi', // AI bos ya da anlamsiz kisa mektup dondu
};

module.exports = {
  CV, ILAN, JD, KAPAK,
  KAPAK_KODLARI: Object.values(KAPAK),
  CV_KODLARI:   Object.values(CV),
  ILAN_KODLARI: Object.values(ILAN),
  JD_KODLARI:   Object.values(JD),
};
