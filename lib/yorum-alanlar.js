'use strict';

/**
 * server/lib/yorum-alanlar.js — Ana sayfa kullanici yorumlarinin SUZGECI
 * (K86, 1 Ekim 2026).
 *
 * Kullanicinin kararlari (DEVAM.md K86):
 *  * Yorum yalnizca acik izinle yazilir; yayindan ONCE admin onaylar.
 *  * Yoruma hicbir odul ya da indirim baglanmaz.
 *  * Gorunen kimlik "Ayse K." bicimi: ad + soyadin bas harfi. Sirket adi yok,
 *    yalnizca pozisyon.
 *  * Metinde e-posta, telefon ya da baglanti olamaz (kisisel bilgi sayfaya
 *    cikmasin; reklam/spam baglantisi da olmasin). Reddedilir, kullaniciya
 *    nedeni soylenir. Metin sessizce DEGISTIRILMEZ: yayinlanan sozler
 *    kullanicinin kendi sozleri olmali.
 *
 * Tablo: supabase/k80-bot-basvuru.sql (ia_yorumlar) + k86-yorum.sql.
 */

const SINIR = Object.freeze({ metinEnAz: 20, metinEnCok: 1000, ad: 40, pozisyon: 120 });
const DURUMLAR = Object.freeze(['bekliyor', 'yayinda', 'reddedildi', 'geri_cekildi']);
// Admin'in verebilecegi kararlar (geri cekme yalnizca kullanicinin).
const KARARLAR = Object.freeze(['yayinda', 'reddedildi']);

const EPOSTA = /[^\s@]+@[^\s@]+\.[^\s@]+/;
// 7+ rakam (aralarinda bosluk, tire, nokta, parantez olabilir): telefon.
// Yil ("2026"), maas ("$85,000") ve "3 ay" gibi sayilar 7 rakama ulasmaz.
const TELEFON = /(?:\+?\d[\s().-]*){7,}/;
const BAGLANTI = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|ca|co|app|ai|dev|me|info|biz|us|uk|tr|de|xyz|ly|link)\b(?:\/\S*)?/i;

function satir(deger, sinir) {
  if (typeof deger !== 'string') return '';
  return deger.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, sinir).trim();
}
function tekSatir(deger, sinir) {
  return satir(deger, sinir).replace(/\s+/g, ' ');
}

/** Metinde iletisim bilgisi ya da baglanti var mi? */
// "2024-2026" gibi yil araliklari telefon sayilmasin.
const YIL_ARALIGI = /\b(?:19|20)\d{2}\s*[-\u2013\/]\s*(?:19|20)\d{2}\b/g;
function iletisimVar(s) {
  return EPOSTA.test(s) || TELEFON.test(s.replace(YIL_ARALIGI, ' ')) || BAGLANTI.test(s);
}

/**
 * "ayse k" / "Ayşe K." / "Mary Ann T." -> "Ayşe K." ; tam soyadi, rakam,
 * tek kelime ya da uc kelimeden fazlasi -> null.
 */
function gorunenAd(ham) {
  const s = tekSatir(ham, 60);
  const m = s.match(/^([\p{L}][\p{L}'-]{0,24}(?: [\p{L}][\p{L}'-]{0,24})?) (\p{L})\.?$/u);
  if (!m) return null;
  const buyuk = (k) => k.charAt(0).toLocaleUpperCase('en') + k.slice(1);
  const ad = m[1].split(' ').map(buyuk).join(' ');
  const sonuc = `${ad} ${m[2].toLocaleUpperCase('en')}.`;
  return sonuc.length <= SINIR.ad ? sonuc : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Istemciden gelen yorum -> ia_yorumlar satiri (user_id haric) ya da hata.
 * @returns {{satir: object} | {hata: 'izin'|'metin_kisa'|'metin_uzun'|'iletisim'|'ad'}}
 */
function yorumTemizle(ham) {
  const b = ham && typeof ham === 'object' && !Array.isArray(ham) ? ham : {};
  if (b.izin !== true) return { hata: 'izin' };
  const ham_metin = typeof b.metin === 'string' ? b.metin.trim() : '';
  if (ham_metin.length > SINIR.metinEnCok) return { hata: 'metin_uzun' };
  const metin = satir(ham_metin, SINIR.metinEnCok);
  if (metin.length < SINIR.metinEnAz) return { hata: 'metin_kisa' };
  const pozisyon = tekSatir(b.pozisyon, SINIR.pozisyon);
  if (iletisimVar(metin) || iletisimVar(pozisyon)) return { hata: 'iletisim' };
  const ad = gorunenAd(b.gorunen_ad);
  if (!ad) return { hata: 'ad' };
  return {
    satir: {
      metin, gorunen_ad: ad, pozisyon,
      basvuru_id: UUID.test(String(b.basvuru_id || '')) ? String(b.basvuru_id).toLowerCase() : null,
      izin_verdi: true,
    },
  };
}

module.exports = { SINIR, DURUMLAR, KARARLAR, UUID, yorumTemizle, gorunenAd, iletisimVar };
