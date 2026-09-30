'use strict';

/**
 * server/lib/basvuru-alanlar.js — Basvuru Takibi kayitlarinin sunucudaki
 * SUZGECI (K85, 30 Eylul 2026).
 *
 * Kullanicinin karari (K80): basvurular ve sonuclari Supabase'de, butun
 * planlarda, notlar dahil. Kisisel bilgi alani YOK: yalnizca sirket, pozisyon,
 * konum, ilan baglantisi, tarih, takip durumu, sonuc, notlar ve kaynak.
 * Istemci ne gonderirse gondersin bunlarin disindaki alanlar atilir.
 *
 * Tablo: supabase/k80-bot-basvuru.sql (ia_basvurular).
 */

// Takip durumlari: web'deki public/shared/placedai-durumlar.js ile AYNI
// liste (web testi iki listeyi karsilastirir). Saklanan deger Ingilizce.
const DURUMLAR = Object.freeze(['Applied', 'Phone Screen', 'Interview', 'Technical Interview', 'Offer', 'Rejected']);
const DURUM_ESKI = Object.freeze({ 'Phone Interview': 'Phone Screen' });

const SONUCLAR = Object.freeze(['davet', 'ret', 'cevap_yok', 'ise_girdi']);
const KAYNAKLAR = Object.freeze(['elle', 'bot', 'is_arama', 'tam_paket']);

// "Hangi araclar ise yaradi" anketinin secenekleri (web'deki kutularla ayni).
const ANKET_ARACLARI = Object.freeze(['canli_yardim', 'mock', 'cv', 'kapak', 'ats', 'is_arama', 'bot', 'linkedin', 'diger']);

const SINIR = Object.freeze({ sirket: 200, pozisyon: 200, konum: 200, link: 1000, notlar: 2000, istemci_id: 64, yorum: 1000 });

function satir(deger, sinir) {
  if (typeof deger !== 'string' && typeof deger !== 'number') return '';
  return String(deger).replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, sinir).trim();
}
function tekSatir(deger, sinir) {
  return satir(deger, sinir).replace(/\s+/g, ' ');
}

function guvenliLink(ham) {
  const s = satir(ham, SINIR.link);
  if (!s) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
    return /^https?:$/.test(u.protocol) && u.href.length <= SINIR.link ? u.href : '';
  } catch { return ''; }
}

/** "YYYY-MM-DD" ve gercek bir gun ise o; degilse null. */
function tarih(ham) {
  const s = typeof ham === 'string' ? ham.trim().slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d) && d.toISOString().slice(0, 10) === s ? s : null;
}

function durum(ham) {
  const s = DURUM_ESKI[ham] || ham;
  return DURUMLAR.includes(s) ? s : 'Applied';
}

const bosTire = (s) => (s === '—' || s === '-' ? '' : s);

/**
 * Istemciden gelen tek kayit -> ia_basvurular satiri (user_id haric).
 * Sirket ya da pozisyon yoksa null (bos kart anlamsiz).
 */
function kayitTemizle(ham, bugun = new Date().toISOString().slice(0, 10)) {
  const k = ham && typeof ham === 'object' && !Array.isArray(ham) ? ham : null;
  if (!k) return null;
  const sirket = bosTire(tekSatir(k.sirket, SINIR.sirket));
  const pozisyon = bosTire(tekSatir(k.pozisyon, SINIR.pozisyon));
  if (!sirket && !pozisyon) return null;
  const out = {
    istemci_id: tekSatir(k.istemci_id, SINIR.istemci_id) || null,
    sirket, pozisyon,
    konum: bosTire(tekSatir(k.konum, SINIR.konum)),
    link: guvenliLink(k.link),
    basvuru_tarihi: tarih(k.basvuru_tarihi) || bugun,
    durum: durum(k.durum),
    notlar: satir(k.notlar, SINIR.notlar),
    kaynak: KAYNAKLAR.includes(k.kaynak) ? k.kaynak : 'elle',
  };
  if (SONUCLAR.includes(k.sonuc)) {
    out.sonuc = k.sonuc;
    out.sonuc_tarihi = tarih(k.sonuc_tarihi) || bugun;
  }
  return out;
}

/**
 * Guncelleme govdesi -> yalnizca GONDERILEN ve gecerli alanlar.
 * sonuc: null gonderilirse temizlenir. Gecersiz deger hata.
 * @returns {{alanlar: object} | {hata: string}}
 */
function guncellemeTemizle(ham, bugun = new Date().toISOString().slice(0, 10)) {
  const b = ham && typeof ham === 'object' && !Array.isArray(ham) ? ham : {};
  const alanlar = {};
  if ('durum' in b) {
    const s = DURUM_ESKI[b.durum] || b.durum;
    if (!DURUMLAR.includes(s)) return { hata: 'durum' };
    alanlar.durum = s;
  }
  if ('notlar' in b) alanlar.notlar = satir(b.notlar, SINIR.notlar);
  if ('sonuc' in b) {
    if (b.sonuc === null) { alanlar.sonuc = null; alanlar.sonuc_tarihi = null; }
    else if (SONUCLAR.includes(b.sonuc)) { alanlar.sonuc = b.sonuc; alanlar.sonuc_tarihi = bugun; }
    else return { hata: 'sonuc' };
  }
  if (!Object.keys(alanlar).length) return { hata: 'bos' };
  return { alanlar };
}

/** Anket cevabi -> ia_anketler satiri (user_id haric). */
function anketTemizle(ham) {
  const b = ham && typeof ham === 'object' && !Array.isArray(ham) ? ham : {};
  const y = Number(b.yardim);
  const araclar = Array.isArray(b.araclar) ? [...new Set(b.araclar.filter((a) => ANKET_ARACLARI.includes(a)))] : [];
  return {
    yardim: Number.isInteger(y) && y >= 1 && y <= 5 ? y : null,
    araclar,
    yorum: satir(b.yorum, SINIR.yorum),
  };
}

module.exports = {
  DURUMLAR, DURUM_ESKI, SONUCLAR, KAYNAKLAR, ANKET_ARACLARI, SINIR,
  kayitTemizle, guncellemeTemizle, anketTemizle, tarih, guvenliLink,
};
