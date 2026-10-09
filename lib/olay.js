/**
 * server/lib/olay.js — Donusum olcumu (K112, Asama 2, 9 Ekim 2026).
 *
 * Tablo: public.ia_olaylar (supabase/k112-analytics.sql). Yalnizca bu sunucu
 * yazar (service-role). Kurallar (kullanici onayli plan):
 *   - Cerez yok, IP / e-posta / parmak izi YOK.
 *   - Kayit ONCESI adimlar (ana sayfa, demo, kayit sayfasi, indirme sayfasi)
 *     kisiye baglanmaz: user_id bos.
 *   - Kayit SONRASI adimlar kullaniciya baglanir (kayit, ilk canli kullanim,
 *     masaustu ilgisi, odeme, satin alma).
 *   - Olcum hicbir zaman asil isi bozmaz: buradaki fonksiyonlar ASLA firlatmaz.
 *   - 180 gunden eski satirlari lib/temizlik.js siler.
 *   - K112b: dis_kimlik (Stripe odeme oturumu cs_...) benzersiz: ayni satin
 *     alma / odeme sayfasi bir kez yazilir (supabase/k112b-analytics-duzeltme.sql).
 */
'use strict';

/** Tarayicidan kabul edilen olaylar. Digerleri yalnizca sunucuda yazilir. */
const WEB_OLAYLARI = new Set([
  'ana_sayfa', 'demo_basladi', 'demo_baska_soru', 'demo_kendi_sorun', 'deneme_tiklandi',
  'kayit_sayfasi', 'indirme_sayfasi', 'indirme_tiklandi', 'masaustu_ilgi',
]);
/** Yalnizca giris yapmis kullanicidan anlamli; girissizse sessizce yok sayilir. */
const GIRIS_GEREKEN = new Set(['masaustu_ilgi']);
/** Sunucunun kendi yazdiklari (tarayici bunlari gonderemez). */
const SUNUCU_OLAYLARI = new Set(['kayit_tamam', 'ilk_canli', 'odeme_basladi', 'satin_alma']);

const AYRINTI_RE = /^[a-z0-9_-]{1,40}$/;
const DIS_KIMLIK_RE = /^[A-Za-z0-9_]{1,100}$/;
const SAYFA_RE   = /^\/[A-Za-z0-9/_-]*$/;
// Arama motoru ve otomasyon: sayilmaz.
const BOT_RE     = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|curl|wget|python-requests|axios|node-fetch/i;

const GUN_MS             = 24 * 60 * 60 * 1000;
const KAYIT_PENCERESI_MS = 7 * GUN_MS;   // eski hesaplar "yeni kayit" sayilmasin
const SAKLAMA_GUN        = 180;

function planOf(user) {
  if (!user) return null;
  const p = user.app_metadata && user.app_metadata.plan;
  return p === 'pro' || p === 'ultimate' ? p : 'free';
}

/** Yalnizca yol; sorgu ve # atilir (e-posta gibi bir sey sizmasin). */
function temizSayfa(s) {
  if (typeof s !== 'string') return null;
  const yol = s.split(/[?#]/)[0].slice(0, 80);
  return SAYFA_RE.test(yol) ? yol : null;
}
function temizAyrinti(a) {
  return typeof a === 'string' && AYRINTI_RE.test(a) ? a : null;
}
function botMu(ua) {
  return !ua || BOT_RE.test(String(ua));
}

/**
 * Tarayicidan gelen govdeyi dogrular. text/plain (sendBeacon / keepalive) ya da
 * JSON gelebilir. Gecersizse null.
 * @returns {{ olay: string, ayrinti: string|null, sayfa: string|null } | null}
 */
function webOlayiAyikla(govde) {
  let g = govde;
  if (typeof g === 'string') {
    if (g.length > 500) return null;
    try { g = JSON.parse(g); } catch { return null; }
  }
  if (!g || typeof g !== 'object' || Array.isArray(g)) return null;
  if (typeof g.olay !== 'string' || !WEB_OLAYLARI.has(g.olay)) return null;
  return { olay: g.olay, ayrinti: temizAyrinti(g.ayrinti), sayfa: temizSayfa(g.sayfa) };
}

/**
 * Tek satir yazar. Asla firlatmaz. Ayni kisinin tek seferlik olayi ikinci kez
 * gelirse (unique index) sessizce false doner.
 * @returns {Promise<boolean>} yazildi mi
 */
async function olayYaz(sb, { olay, ayrinti = null, sayfa = null, user = null, disKimlik = null, plan, log = console } = {}) {
  if (!sb || (!WEB_OLAYLARI.has(olay) && !SUNUCU_OLAYLARI.has(olay))) return false;
  try {
    const satir = {
      olay,
      ayrinti: temizAyrinti(ayrinti),
      sayfa:   temizSayfa(sayfa),
      // plan verildiyse o (null = bilinmiyor), verilmediyse kullanicidan
      plan:    plan === undefined ? planOf(user) : (['free', 'pro', 'ultimate'].includes(plan) ? plan : null),
      user_id: user && user.id ? user.id : null,
    };
    // Yalnizca verilirse: sutun yoksa (SQL calismadan) diger olaylar yine yazilir.
    if (typeof disKimlik === 'string' && DIS_KIMLIK_RE.test(disKimlik)) satir.dis_kimlik = disKimlik;
    const { error } = await sb.from('ia_olaylar').insert(satir);
    if (error) {
      if (error.code === '23505') return false;   // tek seferlik olay ya da ayni dis kimlik zaten var
      throw new Error(error.message);
    }
    return true;
  } catch (e) {
    log.warn?.(`[olay] ${olay} yazilamadi: ${e && e.message}`);
    return false;
  }
}

/** Yeni hesapsa (son 7 gun) 'kayit_tamam'. Eski hesaplar yeni kayit sayilmaz. */
async function kayitTamam(sb, user, { simdi = new Date(), log } = {}) {
  if (!user || !user.id) return false;
  const olusma = Date.parse(user.created_at || '');
  if (!Number.isFinite(olusma) || simdi.getTime() - olusma > KAYIT_PENCERESI_MS) return false;
  return olayYaz(sb, { olay: 'kayit_tamam', user, log });
}

// Ayni kullanici icin her cevapta veritabanina gitmemek icin: surec basina bir kez bakilir.
const _ilkCanliBakildi = new Set();
const ILK_CANLI_BELLEK = 50000;

/**
 * Ilk gercek canli cevap. Yalnizca olcum basladiktan SONRA kayit olanlar icin
 * (kayit_tamam satiri olan): eski kullanicilarin ilk cevabi huniyi sisirmesin.
 */
async function ilkCanli(sb, user, { log } = {}) {
  if (!sb || !user || !user.id || _ilkCanliBakildi.has(user.id)) return false;
  if (_ilkCanliBakildi.size >= ILK_CANLI_BELLEK) _ilkCanliBakildi.clear();
  _ilkCanliBakildi.add(user.id);
  try {
    const { data, error } = await sb.from('ia_olaylar').select('olay').eq('user_id', user.id).in('olay', ['kayit_tamam', 'ilk_canli']);
    if (error) throw new Error(error.message);
    const olaylar = new Set((data || []).map((r) => r.olay));
    if (!olaylar.has('kayit_tamam') || olaylar.has('ilk_canli')) return false;
    return olayYaz(sb, { olay: 'ilk_canli', user, log });
  } catch (e) {
    log?.warn?.(`[olay] ilk_canli bakilamadi: ${e && e.message}`);
    return false;
  }
}

function _sifirla() { _ilkCanliBakildi.clear(); }

module.exports = {
  WEB_OLAYLARI, GIRIS_GEREKEN, SUNUCU_OLAYLARI, SAKLAMA_GUN, KAYIT_PENCERESI_MS,
  planOf, temizSayfa, temizAyrinti, botMu, webOlayiAyikla, olayYaz, kayitTamam, ilkCanli, _sifirla,
};
