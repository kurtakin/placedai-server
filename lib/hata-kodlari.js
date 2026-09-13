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

module.exports = { CV, ILAN, CV_KODLARI: Object.values(CV), ILAN_KODLARI: Object.values(ILAN) };
