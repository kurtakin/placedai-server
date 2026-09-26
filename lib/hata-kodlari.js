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

/**
 * ATS puani hatalari. Her biri icin ats.hata_* ve ats.oneri_* gerekir.
 *
 * 17 Eylul 2026'da olculdu: /ats-score cikti dogrulamasi YAPMIYORDU.
 *   AI bos nesne donerse  -> ekranda buyuk bir "0" ve kirmizi daire
 *   AI "85%" metni donerse -> ekranda "NaN"
 * Ikisi de hata gibi degil OLCUM gibi gorunuyordu; kullanici CV'sinin bu ise
 * sifir uydugunu saniyordu.
 */
const ATS = {
  KISA_GIRDI:    'ats_kisa_girdi',    // CV ya da ilan 50 karakterin altinda
  HESAPLANAMADI: 'ats_hesaplanamadi', // AI yaniti JSON degil ya da skor sayi degil
  // 18 Eylul 2026: model puani VERDI ama cevap token butcesi dolunca cumlenin
  // ortasinda kesildi, JSON kapanmadi. HESAPLANAMADI ile ayni sey degil.
  // Orada model olcemedi; burada biz dinlemeyi erken kestik. Kullaniciya
  // soylenecek sey de, bizim yapacagimiz sey de farkli.
  YANIT_KESILDI: 'ats_yanit_kesildi',
};

/**
 * CV Olusturucu hatalari. Her biri icin rv.hata_* ve rv.oneri_* gerekir.
 *
 * 19 Eylul 2026'da olculdu: /build-resume cikti dogrulamasi YAPMIYORDU.
 * `resume.trim().split(/\s+/).length` bos metinde 1 verir, yani bos bir CV
 * "1 words" ile basari sayiliyordu. Kapak mektubunda aynisini duzeltmistim
 * (K33), burada duruyordu.
 */
const CVB = {
  AD_GEREKLI:  'rv_ad_gerekli',    // isim yok ya da iki harften kisa
  URETILEMEDI: 'rv_uretilemedi',   // AI bos ya da anlamsiz kisa CV dondu
  YANIT_KESILDI: 'rv_yanit_kesildi', // token butcesi dolunca yarim kaldi
};

/**
 * LinkedIn optimizasyonu hatalari. Her biri icin li.hata_* ve li.oneri_* gerekir.
 *
 * 23 Eylul 2026'da olculdu (K53): /optimize-linkedin cikti dogrulamasi
 * YAPMIYORDU, cozulemeyen yanitta modelin HAM metnini istemciye geri
 * gonderiyordu ve hatalari duz Ingilizce metin olarak donuyordu.
 */
const LI = {
  KISA_PROFIL:   'li_kisa_profil',   // profil metni 50 karakterin altinda
  COZULEMEDI:    'li_cozulemedi',    // AI yaniti JSON degil
  URETILEMEDI:   'li_uretilemedi',   // JSON geldi ama baslik ya da Hakkinda bos
  YANIT_KESILDI: 'li_yanit_kesildi', // token butcesi dolunca yarim kaldi
};

/**
 * Deneyim mektubu / IK rica e-postasi hatalari. Her biri icin ct.hata_* ve
 * ct.oneri_* gerekir.
 *
 * 24 Eylul 2026'da olculdu (K54): /experience-letter cikti ve kesilme
 * denetimi yapmiyordu, hatalari duz Ingilizce metin olarak donuyordu.
 */
const EL = {
  ALAN_EKSIK:    'el_alan_eksik',    // ad, unvan ya da sirket yok
  URETILEMEDI:   'el_uretilemedi',   // AI bos ya da anlamsiz kisa metin dondu
  YANIT_KESILDI: 'el_yanit_kesildi', // token butcesi dolunca yarim kaldi
};

/**
 * Online Assessment hazirligi hatalari. Her biri icin oa.hata_* ve oa.oneri_*
 * gerekir.
 *
 * 24 Eylul 2026'da olculdu (K55): /online-assessment cikti ve kesilme
 * denetimi yapmiyordu, cozulemeyen yanitta modelin ham metnini donuyordu.
 */
const OA = {
  KISA_SORU:     'oa_kisa_soru',     // soru 10 karakterin altinda
  COZULEMEDI:    'oa_cozulemedi',    // AI yaniti JSON degil
  URETILEMEDI:   'oa_uretilemedi',   // JSON geldi ama zorunlu alan bos
  YANIT_KESILDI: 'oa_yanit_kesildi', // token butcesi dolunca yarim kaldi
  // K56: kullanici uyariyi onaylamadan bolum calismiyor; onay sunucuda kayitli.
  ONAY_GEREKLI:  'oa_onay_gerekli',  // bu kullanicinin gecerli surum icin kaydi yok
  ONAY_OKUNAMADI:'oa_onay_okunamadi',// onay tablosu okunamadi; kapi KAPALI kalir
};

/** Sesli deneme mulakati (yol haritasi M1-M3). Her biri icin mock.hata_* gerekir. */
const MOCK = {
  ROL_EKSIK:     'mock_rol_eksik',      // rol 2 karakterin altinda
  CEVAP_YOK:     'mock_cevap_yok',      // geri bildirim icin degerlendirilecek cevap yok
  COZULEMEDI:    'mock_cozulemedi',     // AI yaniti JSON degil
  URETILEMEDI:   'mock_uretilemedi',    // JSON geldi ama zorunlu alan bos
  YANIT_KESILDI: 'mock_yanit_kesildi',  // token butcesi dolunca yarim kaldi
};

/** Onay kaydi uclarinin hatalari. Her biri icin onay.hata_* gerekir. */
const ONAY = {
  BILINMEYEN:    'onay_bilinmeyen_ozellik',
  SURUM_ESKI:    'onay_surum_eski',       // istemci eski metni onayladi
  KAYDEDILEMEDI: 'onay_kaydedilemedi',
};

module.exports = {
  CV, ILAN, JD, KAPAK, ATS, CVB, LI, EL, OA, ONAY, MOCK,
  MOCK_KODLARI: Object.values(MOCK),
  ONAY_KODLARI: Object.values(ONAY),
  OA_KODLARI: Object.values(OA),
  LI_KODLARI: Object.values(LI),
  EL_KODLARI: Object.values(EL),
  ATS_KODLARI: Object.values(ATS),
  CVB_KODLARI: Object.values(CVB),
  KAPAK_KODLARI: Object.values(KAPAK),
  CV_KODLARI:   Object.values(CV),
  ILAN_KODLARI: Object.values(ILAN),
  JD_KODLARI:   Object.values(JD),
};
