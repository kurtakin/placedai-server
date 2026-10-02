'use strict';

/**
 * server/lib/bot-depo.js — Sunucu botunun Supabase erisimi, tek yer (K81).
 *
 * Tablolar supabase/k80-bot-basvuru.sql'de. Hepsi service-role ile yazilir;
 * RLS kullaniciya yalnizca kendi satirlarini OKUMA izni veriyor.
 *
 * Supabase tanimli degilse (yerel gelistirme) her islev 'yok' hatasi atar;
 * cagiran taraf bunu "kaydedilemedi" olarak gosterir. Sessizce basarili
 * gibi davranmak, botun calistigini sanan bir kullanici demek olurdu.
 */

let _sb;          // undefined: henuz kurulmadi; null: Supabase yok
function getSupabase() {
  if (_sb !== undefined) return _sb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { _sb = null; return _sb; }
  const { createClient } = require('@supabase/supabase-js');
  _sb = createClient(url, key, { auth: { persistSession: false } });
  return _sb;
}

/** Testler icin: sahte istemci ver ya da sifirla (undefined). */
function _setSupabase(sb) { _sb = sb; }

function sb() {
  const s = getSupabase();
  if (!s) { const e = new Error('Supabase tanimli degil'); e.supabaseYok = true; throw e; }
  return s;
}

function sonuc({ data, error }) {
  if (error) throw new Error(error.message || String(error));
  return data;
}

const AYAR = 'ia_bot_ayarlari';
const ILAN = 'ia_bot_ilanlari';
const iso = (t) => new Date(t).toISOString();

async function ayarOku(userId) {
  return sonuc(await sb().from(AYAR).select('*').eq('user_id', userId).maybeSingle());
}

/** Yalnizca verilen alanlari yazar; satir yoksa varsayilanlarla olusur. */
async function ayarYaz(userId, alanlar) {
  return sonuc(await sb().from(AYAR).upsert({ ...alanlar, user_id: userId }, { onConflict: 'user_id' }).select('*').single());
}

/** Zamani gelmis aktif kullanicilar, en cok bekleyen once. */
async function siradakiler(simdi, adet) {
  return sonuc(await sb().from(AYAR).select('*').eq('aktif', true).lte('sonraki_arama', iso(simdi))
    .order('sonraki_arama', { ascending: true }).limit(adet)) || [];
}

async function aramaBitti(userId, { son_arama, sonraki_arama }) {
  const alan = { sonraki_arama: iso(sonraki_arama) };
  if (son_arama) alan.son_arama = iso(son_arama);
  sonuc(await sb().from(AYAR).update(alan).eq('user_id', userId));
}

/** Yeni ilanlari ekler; ayni ilan (user_id, ilan_anahtari) ikinci kez eklenmez. Eklenen sayi doner. */
async function ilanlariEkle(userId, satirlar) {
  if (!satirlar.length) return 0;
  const veri = sonuc(await sb().from(ILAN)
    .upsert(satirlar.map((s) => ({ ...s, user_id: userId })), { onConflict: 'user_id,ilan_anahtari', ignoreDuplicates: true })
    .select('id'));
  return Array.isArray(veri) ? veri.length : 0;
}

/** Henuz e-postaya girmemis yeni ilanlar, en uygun once. */
async function ozetIlanlari(userId, adet = 200) {
  return sonuc(await sb().from(ILAN).select('id,baslik,sirket,konum,kaynak,uygunluk')
    .eq('user_id', userId).eq('durum', 'yeni').is('epostada', null)
    .order('uygunluk', { ascending: false }).order('bulundu', { ascending: false }).limit(adet)) || [];
}

async function ozetIsaretle(userId, ilanIdleri, simdi) {
  if (ilanIdleri.length) {
    sonuc(await sb().from(ILAN).update({ epostada: iso(simdi) }).eq('user_id', userId).in('id', ilanIdleri));
  }
  sonuc(await sb().from(AYAR).update({ son_eposta: iso(simdi) }).eq('user_id', userId));
}

/**
 * Bot sayfasindaki onay kuyrugu (K82): karar verilmemis ilanlar (yeni,
 * goruldu), en uygun once. Puan da doner ama arayuz yalnizca sirayi kullanir.
 */
async function bekleyenIlanlar(userId, adet = 100) {
  return sonuc(await sb().from(ILAN).select('id,baslik,sirket,konum,link,kaynak,konum_kademe,durum,bulundu')
    .eq('user_id', userId).in('durum', ['yeni', 'goruldu'])
    .order('uygunluk', { ascending: false }).order('bulundu', { ascending: false }).limit(adet)) || [];
}

/** Kullanicinin KENDI ilaninin durumu. Guncellenen satir sayisi doner (0: yok ya da baskasinin). */
async function ilanDurumu(userId, ilanId, durum) {
  const veri = sonuc(await sb().from(ILAN).update({ durum }).eq('user_id', userId).eq('id', ilanId).select('id'));
  return Array.isArray(veri) ? veri.length : 0;
}

/** E-posta ozetini kapatir. Satir yoksa hicbir sey olmaz (acilmamis bot). */
async function epostaKapat(userId) {
  sonuc(await sb().from(AYAR).update({ eposta_ozet: false }).eq('user_id', userId));
}

/** Hesaptan plan ve e-posta (yalnizca o an; hicbir tabloya yazilmaz). Hesap yoksa null. */
async function kullanici(userId) {
  const { data, error } = await sb().auth.admin.getUserById(userId);
  if (error) {
    if (error.status === 404 || /not.?found/i.test(error.message || '')) return null;
    throw new Error(error.message || String(error));
  }
  const u = data && data.user;
  if (!u) return null;
  return { plan: (u.app_metadata && u.app_metadata.plan) || 'free', email: u.email || '' };
}

module.exports = {
  getSupabase, _setSupabase,
  ayarOku, ayarYaz, siradakiler, aramaBitti, ilanlariEkle, ozetIlanlari, ozetIsaretle, epostaKapat, kullanici,
  bekleyenIlanlar, ilanDurumu,
};
