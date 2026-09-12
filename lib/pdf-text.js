/**
 * server/lib/pdf-text.js — PDF'ten metin cikarma.
 *
 * Neden ayri bir dosya: onceki surum sikistirilmis PDF'leri okuyamiyordu ve
 * bunu SESSIZCE yapiyordu. 12 Eylul 2026'da olculdu:
 *
 *   sikistirilmamis PDF      -> 83 karakter, metin dogru cikti
 *   FlateDecode'lu PDF       -> 68 karakter, "x 0 _ NJ `B P Z }4 z ! . * Q+"
 *
 * Word, Chrome, Google Docs ve LaTeX'in urettigi PDF'lerin icerik akisi
 * sikistirilmistir, yani gercek dunyadaki CV'lerin cogu ikinci durumdaydi.
 * Cop 68 karakterdi ve sunucudaki "30 karakterden uzun mu" korumasini
 * geciyordu; AI'a gidiyor, AI bos alanlar donduruyor, arayuz bunu basari
 * sayip kullanicinin profilini BOS degerlerle eziyordu.
 *
 * Iki duzeltme:
 *   1. FlateDecode akislari aciliyor (zlib zaten Node'da var)
 *   2. Son care olan "ham akistan yazdirilabilir karakterleri al" yolu artik
 *      sonucun METNE BENZEDIGINI de kontrol ediyor; benzemiyorsa bos doner,
 *      cunku cop dondurmek hic dondurmemekten kotudur
 */

'use strict';

const zlib = require('zlib');

/** Metne benzeme esigi: harf + bosluk orani bunun altindaysa cop sayilir. */
const HARF_ORANI_ESIGI = 0.6;

/** Metin sayilmak icin gereken en az kelime sayisi ve kelime orani. */
const ASGARI_KELIME = 5;
const KELIME_ORANI_ESIGI = 0.4;
/** Bu uzunlugu asan bir parca kelime degildir. */
const AZAMI_KELIME_UZUNLUGU = 30;

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

function extractPDFText(buffer) {
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
  //
  //    Acilmis icerigin KENDISI de aday: metin BT/ET operatoru olmadan duz
  //    yaziliysa yalnizca ham akislari taramak onu kaciriyordu.
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

module.exports = { extractPDFText, decodePDFString, metinAnlamliMi, HARF_ORANI_ESIGI, ASGARI_KELIME, KELIME_ORANI_ESIGI, AZAMI_KELIME_UZUNLUGU };
