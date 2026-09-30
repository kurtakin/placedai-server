'use strict';

/**
 * server/lib/basvuru-depo.js — Basvuru Takibi, e-posta tercihleri ve anket
 * icin Supabase erisimi (K85, 30 Eylul 2026).
 *
 * Tablolar: supabase/k80-bot-basvuru.sql (ia_basvurular) ve
 * supabase/k85-hatirlatma-anket.sql (ia_eposta_tercihleri, ia_anketler).
 * Istemci lib/bot-depo.js ile ORTAK (tek service-role baglantisi); Supabase
 * yoksa her islev hata atar, sessiz basari yok.
 *
 * Her sorguda user_id sarti var: kullanici yalnizca kendi satirina dokunur.
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

const BASVURU = 'ia_basvurular';
const TERCIH = 'ia_eposta_tercihleri';
const ANKET = 'ia_anketler';
const iso = (t) => new Date(t).toISOString();
const ALANLAR = 'id,istemci_id,sirket,pozisyon,konum,link,basvuru_tarihi,durum,sonuc,sonuc_tarihi,notlar,kaynak,created_at';

/** Kullanicinin basvurulari, eskiden yeniye (liste en yeniyi sonda tutar). */
async function liste(userId, adet = 2000) {
  return sonuc(await sb().from(BASVURU).select(ALANLAR).eq('user_id', userId)
    .order('basvuru_tarihi', { ascending: true }).order('created_at', { ascending: true }).limit(adet)) || [];
}

async function sayi(userId) {
  const r = await sb().from(BASVURU).select('id', { count: 'exact', head: true }).eq('user_id', userId);
  if (r.error) throw new Error(r.error.message || String(r.error));
  return r.count || 0;
}

/**
 * Kayitlari ekler; ayni (user_id, istemci_id) ikinci kez eklenmez (tasima iki
 * kez calisirsa cift kayit olmasin). Doner: { istemci_id: sunucu id } eslesmesi
 * (daha once eklenmis olanlar dahil).
 */
async function ekle(userId, satirlar) {
  if (!satirlar.length) return {};
  sonuc(await sb().from(BASVURU)
    .upsert(satirlar.map((s) => ({ ...s, user_id: userId })), { onConflict: 'user_id,istemci_id', ignoreDuplicates: true })
    .select('id'));
  const idler = satirlar.map((s) => s.istemci_id).filter(Boolean);
  if (!idler.length) return {};
  const veri = sonuc(await sb().from(BASVURU).select('id,istemci_id').eq('user_id', userId).in('istemci_id', idler)) || [];
  return Object.fromEntries(veri.map((r) => [r.istemci_id, r.id]));
}

/** Kendi kaydini gunceller; guncellenen satir ya da null (yok / baskasinin). */
async function guncelle(userId, id, alanlar) {
  const veri = sonuc(await sb().from(BASVURU).update(alanlar).eq('user_id', userId).eq('id', id).select(ALANLAR));
  return Array.isArray(veri) && veri.length ? veri[0] : null;
}

/** Kendi kaydini siler; silinen sayi. */
async function sil(userId, id) {
  const veri = sonuc(await sb().from(BASVURU).delete().eq('user_id', userId).eq('id', id).select('id'));
  return Array.isArray(veri) ? veri.length : 0;
}

/** Anket: basvuru kullanicinin degilse false. Ayni basvuruya ikinci cevap ustune yazar. */
async function anketYaz(userId, basvuruId, anket) {
  const var_ = sonuc(await sb().from(BASVURU).select('id').eq('user_id', userId).eq('id', basvuruId).maybeSingle());
  if (!var_) return false;
  sonuc(await sb().from(ANKET).upsert({ ...anket, user_id: userId, basvuru_id: basvuruId }, { onConflict: 'user_id,basvuru_id' }));
  return true;
}

const TERCIH_VARSAYILAN = Object.freeze({ hatirlatma: true, hatirlatma_sayisi: 0, son_hatirlatma: null });

async function tercihOku(userId) {
  const r = sonuc(await sb().from(TERCIH).select('hatirlatma,hatirlatma_sayisi,son_hatirlatma').eq('user_id', userId).maybeSingle());
  return r || { ...TERCIH_VARSAYILAN };
}

async function tercihYaz(userId, alanlar) {
  sonuc(await sb().from(TERCIH).upsert({ ...alanlar, user_id: userId }, { onConflict: 'user_id' }));
}

/**
 * Hatirlatma zamani gelmis, sonucu girilmemis basvurular (butun kullanicilar).
 * 15. gun: basvuru_tarihi <= bugun-15 ve hatirlatma_15 bos; 30. gun ayni sekilde.
 */
async function hatirlatmaAdaylari(bugun, adet = 1000) {
  const gun = (n) => new Date(Date.parse(`${bugun}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
  return sonuc(await sb().from(BASVURU).select('id,user_id,sirket,pozisyon,basvuru_tarihi,hatirlatma_15,hatirlatma_30')
    .is('sonuc', null)
    .or(`and(basvuru_tarihi.lte.${gun(15)},hatirlatma_15.is.null),and(basvuru_tarihi.lte.${gun(30)},hatirlatma_30.is.null)`)
    .order('user_id', { ascending: true }).order('basvuru_tarihi', { ascending: true }).limit(adet)) || [];
}

/** Hatirlatmasi yapilan (ya da yapilmayacak) kayitlari isaretler. */
async function hatirlatmaIsaretle(userId, ids15, ids30, simdi) {
  if (ids15.length) sonuc(await sb().from(BASVURU).update({ hatirlatma_15: iso(simdi) }).eq('user_id', userId).in('id', ids15));
  if (ids30.length) sonuc(await sb().from(BASVURU).update({ hatirlatma_30: iso(simdi) }).eq('user_id', userId).in('id', ids30));
}

module.exports = {
  liste, sayi, ekle, guncelle, sil, anketYaz, tercihOku, tercihYaz,
  hatirlatmaAdaylari, hatirlatmaIsaretle, TERCIH_VARSAYILAN, ALANLAR,
};
