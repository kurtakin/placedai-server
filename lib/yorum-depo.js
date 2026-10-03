'use strict';

/**
 * server/lib/yorum-depo.js — Kullanici yorumlari icin Supabase erisimi
 * (K86, 1 Ekim 2026). Tablo: ia_yorumlar (K80 + k86-yorum.sql).
 *
 * Istemci lib/bot-depo.js ile ORTAK. Supabase yoksa hata atar.
 * Kullanici islevlerinde her sorguda user_id sarti var.
 */

const { getSupabase } = require('./bot-depo');

function sb() {
  const s = getSupabase();
  if (!s) { const e = new Error('Supabase tanimli degil'); e.supabaseYok = true; throw e; }
  return s;
}
function sonuc({ data, error }) {
  if (error) throw new Error(error.message || String(error));
  return data;
}

const YORUM = 'ia_yorumlar';
const BASVURU = 'ia_basvurular';
const ALANLAR = 'id,basvuru_id,metin,gorunen_ad,pozisyon,yayin_durumu,created_at,karar_zamani';

/**
 * Kullanicinin yorumunu yazar; varsa yerine gecer ve YENIDEN onaya duser
 * (yayindaki metin onaysiz degismesin). Bagli basvuru kullanicinin degilse
 * bag kurulmaz (baskasinin "ise girdi" sonucuyla rozet alinmasin).
 */
async function yaz(userId, satir) {
  let basvuruId = satir.basvuru_id || null;
  if (basvuruId) {
    const b = sonuc(await sb().from(BASVURU).select('id').eq('user_id', userId).eq('id', basvuruId).maybeSingle());
    if (!b) basvuruId = null;
  }
  const kayit = {
    ...satir, basvuru_id: basvuruId, user_id: userId,
    yayin_durumu: 'bekliyor', izin_verdi: true, izin_zamani: new Date().toISOString(), karar_zamani: null,
  };
  const veri = sonuc(await sb().from(YORUM).upsert(kayit, { onConflict: 'user_id' }).select(ALANLAR));
  return Array.isArray(veri) ? veri[0] || null : veri;
}

/** Kullanicinin kendi yorumu ya da null. */
async function benim(userId) {
  return sonuc(await sb().from(YORUM).select(ALANLAR).eq('user_id', userId).maybeSingle()) || null;
}

/** Kullanici izni geri ceker: yorum sayfadan kalkar (satir durur). Etkilenen sayi. */
async function geriCek(userId) {
  const veri = sonuc(await sb().from(YORUM).update({ yayin_durumu: 'geri_cekildi' })
    .eq('user_id', userId).neq('yayin_durumu', 'geri_cekildi').select('id'));
  return Array.isArray(veri) ? veri.length : 0;
}

/** Bagli basvurulardan "ise girdi" olanlarin kimlikleri. */
async function iseGirenler(basvuruIdler) {
  const idler = [...new Set(basvuruIdler.filter(Boolean))];
  if (!idler.length) return new Set();
  const veri = sonuc(await sb().from(BASVURU).select('id,sonuc').in('id', idler)) || [];
  return new Set(veri.filter((r) => r.sonuc === 'ise_girdi').map((r) => r.id));
}

/**
 * Ana sayfa: yayindakiler, en yeni once. Yalnizca gosterilecek alanlar +
 * dogrulanmis "ise girdi" isareti.
 */
async function yayindakiler(adet = 12) {
  const veri = sonuc(await sb().from(YORUM).select('id,basvuru_id,metin,gorunen_ad,pozisyon,karar_zamani,ise_girdi_sabit')
    .eq('yayin_durumu', 'yayinda').order('karar_zamani', { ascending: false }).limit(adet)) || [];
  const girdi = await iseGirenler(veri.map((r) => r.basvuru_id));
  return veri.map((r) => ({ id: r.id, metin: r.metin, gorunen_ad: r.gorunen_ad, pozisyon: r.pozisyon || '', ise_girdi: girdi.has(r.basvuru_id) || r.ise_girdi_sabit === true }));   // K95: hesabi silinen, yorumu kalan
}

/** Admin listesi: bir durumdaki yorumlar (bekleyenler eskiden yeniye). */
async function yonetimListesi(durum, adet = 200) {
  const veri = sonuc(await sb().from(YORUM).select(ALANLAR).eq('yayin_durumu', durum)
    .order('created_at', { ascending: durum === 'bekliyor' }).limit(adet)) || [];
  const girdi = await iseGirenler(veri.map((r) => r.basvuru_id));
  return veri.map((r) => ({ ...r, ise_girdi: girdi.has(r.basvuru_id) }));
}

/**
 * Admin karari. Geri cekilmis yoruma karar verilemez (izin yok). Doner:
 * guncellenen satir ya da null (yok / geri cekilmis).
 */
async function karar(id, yeniDurum) {
  const veri = sonuc(await sb().from(YORUM).update({ yayin_durumu: yeniDurum, karar_zamani: new Date().toISOString() })
    .eq('id', id).neq('yayin_durumu', 'geri_cekildi').select(ALANLAR));
  return Array.isArray(veri) && veri.length ? veri[0] : null;
}

module.exports = { yaz, benim, geriCek, yayindakiler, yonetimListesi, karar, iseGirenler, ALANLAR };
