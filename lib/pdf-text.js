/**
 * server/lib/pdf-text.js — PDF'ten metin cikarma.
 *
 * TARIHCE. Bu dosya iki kez uretimde SESSIZCE yanlis sonuc verdi:
 *
 *   12 Eylul 2026 — sikistirma cozme yoktu.
 *     sikistirilmamis PDF -> 83 karakter, dogru
 *     FlateDecode'lu PDF  -> 68 karakter cop
 *     Cop "30 karakterden uzun mu" korumasini geciyor, AI bos alanlar
 *     donduruyor, arayuz basari sayip kullanicinin profilini eziyordu.
 *     Duzeltme: FlateDecode + metinAnlamliMi().
 *
 *   13 Eylul 2026 — CID / Identity-H fontlar cozulemiyordu.
 *     Kullanicinin gercek CV'si olculdu (Microsoft Word LTSC, PDF 1.7):
 *       7 x Type0/CIDFontType2, hepsi /Encoding /Identity-H, 7 x /ToUnicode
 *       498 BT blogu, 3498 hex dizgi <...>, 0 adet Tj operatoru
 *     Elle yazilmis ayristirici: 40 akisin 19'unu aciyor, 498 metin
 *     blogunun 2'sini buluyor, 0 KARAKTER cikariyor.
 *     Icerik akisindaki ilk blok aynen soyle:
 *       BT /F1 21.96 Tf [<0004003C002F00450003003C>10<0068005A>8<0064>] TJ ET
 *     Bu "AKIN KURT", ama baytlar karakter degil glif numarasi.
 *
 * KARAR (K28). Elle yazilmis ayristirici BIRINCIL yol olmaktan cikti.
 * Ayni dosyada olculdu:
 *
 *   elle yazilmis ayristirici : 0 karakter     ❌
 *   pdfjs-dist 4.10.38        : 5391 karakter  ✅  595 ms  37 MB  3 paket
 *   unpdf 1.8.1               : 5390 karakter  ✅  637 ms  2.6 MB 1 paket
 *
 * unpdf secildi: ayni pdfjs motoru, sunucu icin yeniden paketlenmis hali.
 * Elle yazilmis ayristirici YEDEK olarak duruyor, cunku unpdf gecerli bir
 * xref/trailer bekler ve bozuk ya da elle uretilmis PDF'leri reddeder.
 *
 * DEGISMEYEN SEY: metinAnlamliMi(). O dogrulayici her iki olayda da dogru
 * cevap verdi (sikistirilmis copte false, gercek CV'de true). Okuyucu
 * bozuktu, dogrulayici degil. Iki yolun ciktisi da ondan geciyor.
 */

'use strict';

const zlib = require('zlib');
const { getDocumentProxy } = require('unpdf');

/** Metne benzeme esigi: harf + bosluk orani bunun altindaysa cop sayilir. */
const HARF_ORANI_ESIGI = 0.6;

/** Metin sayilmak icin gereken en az kelime sayisi ve kelime orani. */
const ASGARI_KELIME = 5;
const KELIME_ORANI_ESIGI = 0.4;
/** Bu uzunlugu asan bir parca kelime degildir. */
const AZAMI_KELIME_UZUNLUGU = 30;

/**
 * Okunacak azami sayfa ve karakter. Sunucu suresini sinirlamak icin:
 * bir CV 1-4 sayfadir, 300 sayfalik bir kitabi bastan sona okumanin
 * kullaniciya faydasi yok, Railway'de istek suresi var.
 */
const AZAMI_SAYFA = 30;
const AZAMI_KARAKTER = 60000;

function decodePDFString(s) {
  return s
    .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\')
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

/**
 * Metne benziyor mu? Harf, rakam, bosluk ve yaygin noktalama orani.
 * Sikistirilmis bayt yiginlari bu esigi gecemez.
 */
function metinAnlamliMi(metin) {
  const s = String(metin || '');
  if (s.trim().length < 30) return false;

  // 1. Okunabilir karakter orani: sikistirilmis baytlar burada elenir
  const iyi = (s.match(/[A-Za-zÀ-ÿ0-9\s.,;:'"()\-@+/]/g) || []).length;
  if (iyi / s.length < HARF_ORANI_ESIGI) return false;

  // 2. KELIME YAPISI. Yalnizca karakter oranina bakmak yetmiyor: tamami
  //    yazdirilabilir ama bosluksuz bir bayt dizisi ("!(/6=DKRY`gnu|%,3:AHOV")
  //    esigi geciyor ve icinde harf dizileri de bulunuyordu. Gercek metin
  //    bosluklarla ayrilmis kelimelerden olusur.
  const parcalar = s.trim().split(/\s+/);
  const kelimeler = parcalar.filter((p) => p.length <= AZAMI_KELIME_UZUNLUGU
    && /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]+$/.test(p));
  if (kelimeler.length < ASGARI_KELIME) return false;

  // Oran PARCA sayisina degil KARAKTER sayisina gore. Sebep: sikistirilmis
  // baytlar latin1'de À-ÿ araligina dustugu icin "harf" sayiliyor ve 500
  // baytlik tek bir yigin, yanindaki 8 gercek kelimeyle birlikte %89 kelime
  // orani veriyordu. Karakterle olcunce ayni durum %9'a dusuyor.
  const kelimeHarfi = kelimeler.reduce((a, k) => a + k.length, 0);
  return kelimeHarfi / s.trim().length >= KELIME_ORANI_ESIGI;
}

// ── YEDEK YOL: elle yazilmis ayristirici ───────────────────────────────────
//
// Artik birincil degil. Yalnizca unpdf dosyayi acamadiginda calisir:
// gecerli xref/trailer tasimayan, elle uretilmis ya da bozuk PDF'ler.

/**
 * Akislari acar ve icerik akislarini latin1 metin olarak birlestirir.
 * Goruntu akislari (DCTDecode, JPXDecode) atlanir.
 */
function akislariAc(raw) {
  const parcalar = [];
  const rx = /<<([\s\S]*?)>>\s*stream\r?\n/g;
  let m;
  while ((m = rx.exec(raw)) !== null) {
    const sozluk = m[1];
    const bas = m.index + m[0].length;
    const son = raw.indexOf('endstream', bas);
    if (son < 0) continue;
    if (/DCTDecode|JPXDecode|CCITTFaxDecode|\/Image/.test(sozluk)) continue;

    const govde = raw.slice(bas, son);
    if (/FlateDecode/.test(sozluk)) {
      try {
        parcalar.push(zlib.inflateSync(Buffer.from(govde, 'latin1')).toString('latin1'));
      } catch {
        try {
          parcalar.push(zlib.inflateRawSync(Buffer.from(govde, 'latin1')).toString('latin1'));
        } catch { /* acilamadi, atla */ }
      }
    } else {
      parcalar.push(govde);
    }
  }
  return parcalar.join('\n');
}

/** BT...ET bloklarindaki Tj / TJ metinlerini topla. */
function metinOperatorleri(kaynak) {
  const parts = [];
  const btBlocks = kaynak.match(/BT[\s\S]{0,5000}?ET/g) || [];
  for (const block of btBlocks) {
    let m;
    const tjRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*Tj/g;
    while ((m = tjRe.exec(block)) !== null) parts.push(decodePDFString(m[1]));
    const tjArrRe = /\[([^\]]*)\]\s*TJ/g;
    while ((m = tjArrRe.exec(block)) !== null) {
      const strRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
      let s;
      while ((s = strRe.exec(m[1])) !== null) parts.push(decodePDFString(s[1]));
    }
  }
  return parts;
}

function temizle(parts) {
  return parts.join(' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/(\w)-\s+(\w)/g, '$1$2')
    .trim();
}

/**
 * Elle yazilmis ayristirici. Anlamli metin ya da bos dizgi doner.
 * Cop DONDURMEZ: cop dondurmek hic dondurmemekten kotudur, cunku sonraki
 * adimlar onu gecerli sanip kullanicinin profilini eziyor.
 */
function yedekAyristirici(buffer) {
  const raw = buffer.toString('latin1');

  // 1. Akislar acilmis haliyle: sikistirilmis PDF'ler burada okunur
  const acilmis = akislariAc(raw);
  let parts = metinOperatorleri(acilmis);

  // 2. Acilmamis ham icerik: eski sade PDF'ler
  if (parts.length === 0) parts = metinOperatorleri(raw);

  if (parts.length) {
    const metin = temizle(parts);
    if (metinAnlamliMi(metin)) return metin;
  }

  // 3. Son care: akis icerigini duz metin olarak dene.
  //    ESKIDEN burada yalnizca uzunluga bakiliyordu ve sikistirilmis baytlar
  //    68 karakterlik cop olarak geciyordu. Artik metne benzemesi de sart.
  const adaylar = [];
  const aday = (metin) => {
    const txt = String(metin).replace(/[^\x20-\x7E\n\r\t]/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (metinAnlamliMi(txt)) adaylar.push(txt);
  };

  if (acilmis) aday(acilmis);

  if (!adaylar.length) {
    const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let sm;
    while ((sm = streamRe.exec(raw)) !== null) aday(sm[1]);
  }
  return adaylar.join(' ').trim();
}

// ── BIRINCIL YOL: unpdf (pdfjs) ────────────────────────────────────────────

/**
 * unpdf ile oku. Gecerli olmayan PDF'te ya da ayristirma hatasinda BOS
 * doner; cagiran yedek yola duser. Hata FIRLATMAZ, cunku bu yolun
 * basarisizligi kullanici hatasi degil, bizim ayristiricimizin sinirlari.
 */
async function unpdfIleOku(buffer) {
  let doc;
  try {
    doc = await getDocumentProxy(new Uint8Array(buffer));
  } catch {
    return '';
  }

  // SAYFA SAYFA okuyoruz. Olculdu: extractText(doc, { pages: [i] }) sayfa
  // suzgecini yok sayip her cagrida BUTUN belgeyi donduruyor, yani 3
  // sayfalik CV 3 kez tekrarlanip 5390 yerine 16172 karakter veriyordu.
  // getPage/getTextContent gercek sayfa denetimi veriyor ve azami sayfa
  // sinirini uygulanabilir kiliyor.
  const sayfaSayisi = Math.min(doc.numPages || 0, AZAMI_SAYFA);
  const parcalar = [];
  let uzunluk = 0;

  for (let i = 1; i <= sayfaSayisi; i++) {
    let sayfaMetni = '';
    try {
      const sayfa = await doc.getPage(i);
      const icerik = await sayfa.getTextContent();
      sayfaMetni = (icerik.items || [])
        .map((p) => (typeof p.str === 'string' ? p.str + (p.hasEOL ? '\n' : '') : ''))
        .join('');
    } catch {
      continue; // tek sayfa cozulemediyse digerlerini kaybetme
    }
    parcalar.push(sayfaMetni);
    uzunluk += sayfaMetni.length;
    if (uzunluk >= AZAMI_KARAKTER) break;
  }

  return parcalar.join('\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * PDF'ten metin cikar. Once unpdf, olmazsa elle yazilmis yedek.
 * Her iki yolun ciktisi da metinAnlamliMi()'den gecer: anlamli metin
 * ya da BOS dizgi doner, asla cop donmez.
 */
async function extractPDFText(buffer) {
  const birincil = await unpdfIleOku(buffer);
  if (metinAnlamliMi(birincil)) return birincil;

  const yedek = yedekAyristirici(buffer);
  return metinAnlamliMi(yedek) ? yedek : '';
}

/**
 * Dosya neden okunamadi? Kullaniciya DOGRU seyi soyleyebilmek icin.
 *
 * "Okunamadi" tek basina ise yaramaz: taranmis bir belgeyi DOCX olarak
 * kaydetmek de iselemez, cunku icinde hic metin yoktur. Kullanicinin ne
 * yapmasi gerektigi duruma gore degisiyor.
 *
 * @returns {Promise<{ kod: string, akis: number, metinBlogu: number, uzunluk: number }>}
 *   kod: 'okundu' | 'taranmis' | 'metin_cozulemedi'
 */
async function pdfTani(buffer) {
  const raw = buffer.toString('latin1');
  const acilmis = akislariAc(raw);
  const kaynak = acilmis || raw;

  const akisSayisi = (raw.match(/stream\r?\n/g) || []).length;
  const metinBlogu = (kaynak.match(/BT[\s\S]{0,5000}?ET/g) || []).length;
  const cikan = await extractPDFText(buffer);

  if (cikan) return { kod: 'okundu', akis: akisSayisi, metinBlogu, uzunluk: cikan.length };

  // Hic metin operatoru yoksa sayfa gorseldir: taranmis belge ya da resim.
  // O dosyayi DOCX yapmak da ise yaramaz, OCR gerekir.
  if (metinBlogu === 0) return { kod: 'taranmis', akis: akisSayisi, metinBlogu, uzunluk: 0 };

  // Metin operatoru VAR ama okunabilir sonuc cikmadi: font kodlamasi
  // cozulemiyor. DOCX'e cevirmek bunu asar.
  return { kod: 'metin_cozulemedi', akis: akisSayisi, metinBlogu, uzunluk: 0 };
}

module.exports = {
  extractPDFText, pdfTani, decodePDFString, metinAnlamliMi, yedekAyristirici,
  HARF_ORANI_ESIGI, ASGARI_KELIME, KELIME_ORANI_ESIGI, AZAMI_KELIME_UZUNLUGU,
  AZAMI_SAYFA, AZAMI_KARAKTER,
};
