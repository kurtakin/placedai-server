'use strict';

/**
 * server/lib/bot-profil.js — Botun sunucuda tuttugu ayarlarin ve profilin
 * SUZGECI (K81).
 *
 * Kullanicinin karari (K80): sunucuda yalnizca isle ilgili bilgi. Unvan,
 * beceriler, sektorler, deneyim yili ve BOLGE. Telefon, adres, e-posta, ad
 * soyad GIRMEZ. Istemci ne gonderirse gondersin burada izin verilen alanlar
 * disindaki her sey atilir; izinli alanin icinde e-posta, telefon, posta kodu
 * ya da baglanti gibi duran bir deger de atilir.
 *
 * E-posta adresi bu tablolarda hic tutulmaz: ozet gonderilirken Supabase
 * Auth'taki hesap e-postasi o anda okunur.
 */

const { ekSirketleriTemizle } = require('./ats-kaynaklari');

const SINIR = Object.freeze({
  unvan: 120, beceri: 40, beceri_adet: 30, sektor: 60, sektor_adet: 10,
  anahtar_kelime: 120, konum: 120, deneyim_yili: 60,
});

// Kisisel bilgiye benzeyen degerler. Bilerek genis: bir beceriyi yanlislikla
// atmak, bir telefon numarasini sunucuda tutmaktan ucuz.
const KISISEL = [
  /[^\s@]+@[^\s@]+\.[^\s@]+/,              // e-posta
  /(?:\d[\s().+-]*){7,}/,                  // 7+ haneli numara (telefon)
  /https?:\/\/|www\./i,                    // baglanti (LinkedIn profili vb.)
  /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i,         // Kanada posta kodu
];

function kisiselMi(deger) {
  const s = String(deger == null ? '' : deger);
  return KISISEL.some((r) => r.test(s));
}

/** Tek satir metin: kontrol karakterleri ve fazla bosluk gider, sinirda kesilir. */
function satir(deger, sinir) {
  if (typeof deger !== 'string') return '';
  return deger.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, sinir).trim();
}

function liste(ham, tekSinir, adet) {
  if (!Array.isArray(ham)) return [];
  const gorulen = new Set();
  const out = [];
  for (const x of ham) {
    const s = satir(x, tekSinir);
    if (!s || kisiselMi(s)) continue;
    const k = s.toLowerCase();
    if (gorulen.has(k)) continue;
    gorulen.add(k);
    out.push(s);
    if (out.length >= adet) break;
  }
  return out;
}

/**
 * Istemciden gelen profil -> sunucuda tutulacak is profili.
 * @returns {{unvan?:string, beceriler?:string[], sektorler?:string[], deneyim_yili?:number}}
 */
function profilTemizle(ham) {
  const p = ham && typeof ham === 'object' && !Array.isArray(ham) ? ham : {};
  const out = {};
  const unvan = satir(p.unvan, SINIR.unvan);
  if (unvan && !kisiselMi(unvan)) out.unvan = unvan;
  const beceriler = liste(p.beceriler, SINIR.beceri, SINIR.beceri_adet);
  if (beceriler.length) out.beceriler = beceriler;
  const sektorler = liste(p.sektorler, SINIR.sektor, SINIR.sektor_adet);
  if (sektorler.length) out.sektorler = sektorler;
  const y = Number(p.deneyim_yili);
  if (p.deneyim_yili !== null && p.deneyim_yili !== '' && Number.isFinite(y) && y >= 0 && y <= SINIR.deneyim_yili) {
    out.deneyim_yili = Math.round(y);
  }
  return out;
}

/**
 * PUT /bot/ayarlar govdesi -> tabloya yazilacak alanlar.
 * Yalnizca GONDERILEN alanlar doner (gonderilmeyen alan degismez).
 * Konum yalnizca bolge olabilir: rakam iceren konum (sokak numarasi, posta
 * kodu) reddedilir, kesip saklamak yerine kullaniciya soylenir.
 * @returns {{alanlar: object} | {hata: 'konum_bolge'}}
 */
function ayarTemizle(govde) {
  const b = govde && typeof govde === 'object' && !Array.isArray(govde) ? govde : {};
  const alanlar = {};
  if (typeof b.aktif === 'boolean') alanlar.aktif = b.aktif;
  if (typeof b.eposta_ozet === 'boolean') alanlar.eposta_ozet = b.eposta_ozet;
  if ('anahtar_kelime' in b) {
    const k = satir(b.anahtar_kelime, SINIR.anahtar_kelime);
    alanlar.anahtar_kelime = kisiselMi(k) ? '' : k;
  }
  if ('konum' in b) {
    const k = satir(b.konum, SINIR.konum);
    if (/\d/.test(k) || kisiselMi(k)) return { hata: 'konum_bolge' };
    alanlar.konum = k;
  }
  if ('sirketler' in b) alanlar.sirketler = ekSirketleriTemizle(b.sirketler);
  if ('profil' in b) alanlar.profil = profilTemizle(b.profil);
  return { alanlar };
}

module.exports = { profilTemizle, ayarTemizle, kisiselMi, satir, SINIR };
