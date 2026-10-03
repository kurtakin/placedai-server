/**
 * server/lib/hesap-silme.js — Kullanicinin kendi hesabini silmesi (K95, 3 Ekim 2026).
 *
 * Kararlar (DEVAM.md "K94 Adim 3"):
 *   - Hemen silinir, geri alma suresi yok.
 *   - Ucretli abonelik HEMEN iptal edilir, kalan sure iade edilmez.
 *   - Yorum varsayilan olarak hesapla silinir (veritabani cascade). Kullanici
 *     "yayindaki yorumum kalsin" derse yorum hesaptan AYRILIR; "ise girdi"
 *     dogrulamasi o an sabitlenir, cunku basvuru kaydi hesapla silinecek.
 *   - Pazarlama izni kaniti (CASL) hesaptan bagimsiz arsive (3 yil).
 *
 * SIRA ONEMLI. Geri donulemez adim (hesabi silmek) EN SONDA. Ondan once
 * basarisiz olursa hesap silinmez ve kullanici tekrar deneyebilir:
 *   1. Stripe: abonelik iptal. Basarisizsa DUR: odeme alinmaya devam ederken
 *      hesabi silmek, kullanicinin iptal edemeyecegi bir abonelik birakir.
 *   2. Izin arsivi. Basarisizsa DUR: kanit kaybolmasin.
 *   3. Yorumu ayir (yalnizca istenirse ve yayindaysa). Basarisizsa DUR.
 *   4. Hata kayitlarinda kimlik ve e-posta temizlenir; Mac bekleme listesinden
 *      e-posta silinir. Bunlar basarisiz olursa silme SURER (kayda gecer):
 *      hesabi silmemek daha buyuk bir ihlal olurdu.
 *   5. auth.admin.deleteUser: geri kalan butun tablolar cascade.
 *
 * Loga kimlik ya da e-posta yazilmaz; yalnizca sayilar.
 */
'use strict';

// Stripe'ta hala para cekebilecek ya da cekmeye calisan durumlar.
const IPTAL_EDILECEK = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'];

class SilmeHatasi extends Error {
  constructor(adim, mesaj) { super(mesaj); this.adim = adim; }
}

const hataVar = (r) => r && r.error;

async function abonelikleriIptalEt(stripe, musteriId) {
  if (!musteriId) return 0;
  if (!stripe) throw new SilmeHatasi('stripe', 'billing_not_configured');
  let liste;
  try { liste = await stripe.subscriptions.list({ customer: musteriId, status: 'all', limit: 100 }); }
  catch (e) { throw new SilmeHatasi('stripe', e.message); }
  let n = 0;
  for (const s of liste?.data || []) {
    if (!IPTAL_EDILECEK.includes(s.status)) continue;
    // Varsayilan iptal: oranli iade yok, son fatura kesilmez (kullanici karari).
    try { await stripe.subscriptions.cancel(s.id); n++; }
    catch (e) { throw new SilmeHatasi('stripe', e.message); }
  }
  return n;
}

async function izniArsivle(sb, userId, eposta) {
  const r = await sb.from('ia_eposta_tercihleri')
    .select('pazarlama,pazarlama_zamani,pazarlama_kaynak,pazarlama_surum').eq('user_id', userId).maybeSingle();
  if (hataVar(r)) throw new SilmeHatasi('izin', r.error.message);
  const t = r.data;
  // Hic izin verilmemis (ve geri alinmamis) kisi icin saklanacak kanit yok.
  if (!t || !t.pazarlama_zamani || !eposta) return false;
  const y = await sb.from('ia_izin_arsivi').insert({
    eposta:         String(eposta).toLowerCase(),
    silmede_izinli: !!t.pazarlama,
    son_degisiklik: t.pazarlama_zamani,
    kaynak:         t.pazarlama_kaynak || null,
    surum:          t.pazarlama_surum || null,
  });
  if (hataVar(y)) throw new SilmeHatasi('izin', y.error.message);
  return true;
}

async function yorumuAyir(sb, userId) {
  const r = await sb.from('ia_yorumlar').select('id,basvuru_id,yayin_durumu').eq('user_id', userId).maybeSingle();
  if (hataVar(r)) throw new SilmeHatasi('yorum', r.error.message);
  const y = r.data;
  if (!y || y.yayin_durumu !== 'yayinda') return false;   // yalnizca yayindaki kalabilir
  let iseGirdi = false;
  if (y.basvuru_id) {
    const b = await sb.from('ia_basvurular').select('sonuc').eq('id', y.basvuru_id).eq('user_id', userId).maybeSingle();
    if (hataVar(b)) throw new SilmeHatasi('yorum', b.error.message);
    iseGirdi = b.data?.sonuc === 'ise_girdi';
  }
  const u = await sb.from('ia_yorumlar')
    .update({ user_id: null, hesap_silindi: new Date().toISOString(), ise_girdi_sabit: iseGirdi })
    .eq('id', y.id).eq('user_id', userId);
  if (hataVar(u)) throw new SilmeHatasi('yorum', u.error.message);
  return true;
}

/** Basarisizligi silmeyi durdurmayan temizlikler. Hata sayisini dondurur. */
async function izleriTemizle(sb, userId, eposta) {
  let hata = 0;
  const dene = async (p) => { try { const r = await p; if (hataVar(r)) hata++; } catch { hata++; } };
  await dene(sb.from('ia_errors').update({ user_id: null, user_email: null }).eq('user_id', userId));
  if (eposta) {
    const e = String(eposta).toLowerCase();
    await dene(sb.from('ia_errors').update({ user_id: null, user_email: null }).eq('user_email', e));
    await dene(sb.from('mac_waitlist').delete().eq('email', e));
  }
  return hata;
}

/**
 * @param {object} o
 *   sb          service-role Supabase istemcisi
 *   stripe      Stripe istemcisi ya da null
 *   kullanici   requireAuth'un request.user'i
 *   yorumKalsin boolean
 * @returns {{ abonelik: number, izinArsivi: boolean, yorumKaldi: boolean, temizlikHatasi: number }}
 */
async function hesabiSil({ sb, stripe, kullanici, yorumKalsin = false }) {
  const id = kullanici?.id;
  if (!sb || !id) throw new SilmeHatasi('hazirlik', 'no_supabase_or_user');
  const eposta = kullanici.email || '';

  const abonelik    = await abonelikleriIptalEt(stripe, kullanici.app_metadata?.stripe_customer_id);
  const izinArsivi  = await izniArsivle(sb, id, eposta);
  const yorumKaldi  = yorumKalsin === true ? await yorumuAyir(sb, id) : false;
  const temizlikHatasi = await izleriTemizle(sb, id, eposta);

  const s = await sb.auth.admin.deleteUser(id);
  if (hataVar(s)) throw new SilmeHatasi('hesap', s.error.message);

  return { abonelik, izinArsivi, yorumKaldi, temizlikHatasi };
}

module.exports = { hesabiSil, SilmeHatasi, IPTAL_EDILECEK };
