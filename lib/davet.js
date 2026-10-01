'use strict';

/**
 * server/lib/davet.js — Arkadas daveti (K89, 1 Ekim 2026; 6. adimin 6c parcasi).
 *
 * Kullanicinin kararlari (DEVAM.md K87/K89):
 *  * Her uyeye kisisel baglanti: https://www.placedai.app/?ref=KOD.
 *  * Davet edilen ilk odemesini yapip 14 GUN iadesiz ve aboneligi aktif
 *    gecirince SAYILIR. Her 2 sayilan = 1 ay ucretsiz; YILDA EN FAZLA 6 ay.
 *  * Odul herkese: Free davetciye 30 gun Pro erisimi (kart gerekmez, sure
 *    bitince Free'ye doner); ucretli davetcinin bir sonraki faturasina %100
 *    "once" kupon (STRIPE_DAVET_KUPON). Kupon uygulanamazsa odul "bekliyor"
 *    kalir ve hata kaydina dusurulur (admin gorur, ertesi gun yeniden denenir).
 *  * Davet edilen arkadas ilk ayinda %15 (6b kuponu STRIPE_GERI_KAZANMA_KUPON).
 *  * Kendini davet engeli: Stripe kart parmak izi. Davet edilenin karti
 *    davetcininkiyle ayniysa ya da ayni davetcinin iki davetlisi ayni karti
 *    kullaniyorsa sayilmaz. Kart numarasi gorulmez, saklanmaz.
 *  * Gizlilik: davet eden KIMIN kayit oldugunu gormez; yalnizca sayilar.
 *
 * Tablolar: supabase/k89-davet.sql. Supabase/Stripe disaridan verilir (test).
 */

const crypto = require('crypto');

const GUN_MS = 86400000;
const BEKLEME_GUN = 14;          // iade suresi: bu kadar gun aktif kalinca sayilir
const KISI_BASINA = 2;           // her 2 sayilan = 1 odul
const YILLIK_TAVAN = 6;          // son 365 gunde en fazla 6 odul
const PRO_ERISIM_GUN = 30;
const BAGLAMA_GUN = 14;          // hesap acildiktan sonra en gec bu kadar gun icinde baglanir
const ALFABE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // O, 0, I, 1 yok: elle yazarken karismasin
const KOD = /^[A-HJ-NP-Z2-9]{8}$/;
const SITE_VARSAYILAN = 'https://www.placedai.app';
const AKTIF = new Set(['active', 'trialing']);       // sayilmak/odul icin "gercekten odeyen"
const ODEMELI = new Set(['active', 'trialing', 'past_due']);

function sonuc({ data, error }) {
  if (error) { const e = new Error(error.message || String(error)); e.kod = error.code; throw e; }
  return data;
}

function kodUret(rastgele = crypto.randomBytes) {
  const b = rastgele(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ALFABE[b[i] % ALFABE.length];
  return s;
}

/** Kod bicimi: buyuk harfe cevrilir, gecersizse null. */
function kodTemizle(ham) {
  const s = typeof ham === 'string' ? ham.trim().toUpperCase() : '';
  return KOD.test(s) ? s : null;
}

/** Kullanicinin kodu; yoksa uretir (cakisirsa birkac kez dener). */
async function kodGetir(sb, userId, rastgele) {
  const var_ = sonuc(await sb.from('ia_davet_kodlari').select('kod').eq('user_id', userId).maybeSingle());
  if (var_ && var_.kod) return var_.kod;
  for (let i = 0; i < 5; i++) {
    const kod = kodUret(rastgele);
    const r = await sb.from('ia_davet_kodlari').insert({ user_id: userId, kod });
    if (!r.error) return kod;
    // Ayni anda iki istek: digeri yazdiysa onu kullan; kod cakistiysa yeniden uret.
    const tekrar = sonuc(await sb.from('ia_davet_kodlari').select('kod').eq('user_id', userId).maybeSingle());
    if (tekrar && tekrar.kod) return tekrar.kod;
  }
  throw new Error('davet kodu uretilemedi');
}

/** Hic odeme izi var mi (abonelik bir kez bile olduysa "yeni" degil). */
const hicOdemedi = (user) => !((user && user.app_metadata) || {}).subscription_status;

/**
 * Yeni uyeyi davetcisine baglar.
 * @returns {Promise<{ok: true} | {neden: 'kod'|'yok'|'kendisi'|'eski'|'zaten'|'odemis'}>}
 */
async function baglan(sb, user, hamKod, simdi = new Date()) {
  const kod = kodTemizle(hamKod);
  if (!kod) return { neden: 'kod' };
  if (!user || !user.created_at || +simdi - Date.parse(user.created_at) > BAGLAMA_GUN * GUN_MS) return { neden: 'eski' };
  if (!hicOdemedi(user)) return { neden: 'odemis' };
  const sahip = sonuc(await sb.from('ia_davet_kodlari').select('user_id').eq('kod', kod).maybeSingle());
  if (!sahip) return { neden: 'yok' };
  if (sahip.user_id === user.id) return { neden: 'kendisi' };
  const r = await sb.from('ia_davetler').insert({ davet_edilen: user.id, davet_eden: sahip.user_id });
  if (r.error) {
    if (r.error.code === '23505') return { neden: 'zaten' };
    throw new Error(r.error.message || String(r.error));
  }
  return { ok: true };
}

/** Davet edilmis ve hic odememis mi? Odeme sayfasinda arkadas indirimi icin. */
async function arkadasIndirimi(sb, user, env = process.env) {
  const kupon = String(env.STRIPE_GERI_KAZANMA_KUPON || '').trim();
  if (!kupon || !hicOdemedi(user)) return null;
  const d = sonuc(await sb.from('ia_davetler').select('durum').eq('davet_edilen', user.id).maybeSingle());
  return d && d.durum === 'kayit' ? kupon : null;
}

/** Kullaniciya gosterilen ozet: yalnizca sayilar, kimlik yok. */
async function ozet(sb, userId, { simdi = new Date(), env = process.env, rastgele } = {}) {
  const kod = await kodGetir(sb, userId, rastgele);
  const davetler = sonuc(await sb.from('ia_davetler').select('durum').eq('davet_eden', userId)) || [];
  const oduller = sonuc(await sb.from('ia_davet_odulleri').select('durum,created_at').eq('user_id', userId)) || [];
  const say = (d) => davetler.filter((x) => x.durum === d).length;
  const sayildi = say('sayildi');
  const yillik = oduller.filter((o) => +simdi - Date.parse(o.created_at) < 365 * GUN_MS).length;
  const site = String(env.APP_URL || SITE_VARSAYILAN).replace(/\/+$/, '');
  return {
    kod, link: `${site}/?ref=${kod}`,
    kayit: davetler.length, odedi: say('odedi'), sayildi,
    sonraki_icin: KISI_BASINA - (sayildi % KISI_BASINA),
    odul: oduller.length, bekleyen_odul: oduller.filter((o) => o.durum === 'bekliyor').length,
    yillik_kalan: Math.max(0, YILLIK_TAVAN - yillik),
    kurallar: { kisi_basina: KISI_BASINA, bekleme_gun: BEKLEME_GUN, yillik_tavan: YILLIK_TAVAN, arkadas_indirim: 15 },
  };
}

/** Abonelikten kart parmak izi (yoksa null). Kart numarasi hic istenmez. */
async function kartIzi(stripe, sub) {
  try {
    const pm = sub && sub.default_payment_method;
    if (!pm) return null;
    const p = typeof pm === 'string' ? await stripe.paymentMethods.retrieve(pm) : pm;
    return (p && p.card && p.card.fingerprint) || null;
  } catch { return null; }
}

/**
 * Stripe webhook'undan: davet edilen ilk kez odedi. Yalnizca "kayit"
 * durumundaki satir guncellenir (ikinci odeme ya da davetsiz kisi: degisiklik yok).
 */
async function odemeKaydet(sb, stripe, { userId, sub, zaman = new Date() }) {
  if (!userId || !sub || !sub.id) return false;
  const iz = await kartIzi(stripe, sub);
  const veri = sonuc(await sb.from('ia_davetler')
    .update({ durum: 'odedi', ilk_odeme: new Date(zaman).toISOString(), abonelik_id: sub.id, kart_izi: iz })
    .eq('davet_edilen', userId).eq('durum', 'kayit').select('davet_edilen'));
  return Array.isArray(veri) && veri.length > 0;
}

/** Bir musterinin kartlarinin parmak izleri. */
async function musteriIzleri(stripe, customerId) {
  if (!customerId) return new Set();
  try {
    const l = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 20 });
    return new Set((l.data || []).map((p) => p.card && p.card.fingerprint).filter(Boolean));
  } catch { return new Set(); }
}

/**
 * 14 gunu dolan "odedi" satirlarini degerlendirir: iade/itiraz, iptal, ayni kart.
 * @returns {Promise<{davet_edilen: string, sonuc: string}[]>}
 */
async function degerlendir({ sb, stripe, kullaniciGetir, simdi = new Date() }) {
  const sinir = new Date(+simdi - BEKLEME_GUN * GUN_MS).toISOString();
  const satirlar = sonuc(await sb.from('ia_davetler').select('*').eq('durum', 'odedi').lte('ilk_odeme', sinir)) || [];
  const cikti = [];
  const yaz = async (r, alanlar, s) => {
    sonuc(await sb.from('ia_davetler').update(alanlar).eq('davet_edilen', r.davet_edilen).eq('durum', 'odedi'));
    cikti.push({ davet_edilen: r.davet_edilen, sonuc: s });
  };
  for (const r of satirlar) {
    try {
      const sub = await stripe.subscriptions.retrieve(r.abonelik_id);
      if (!sub || !AKTIF.has(sub.status)) { await yaz(r, { durum: 'gecersiz', gecersiz_neden: 'iptal' }, 'iptal'); continue; }
      // Iade/itiraz: en iyi caba. Managed Payments'ta ucret listesi okunamazsa
      // aktif abonelik yeterli sayilir (iade genelde aboneligi de bitirir).
      const ucretler = await stripe.charges.list({ customer: sub.customer, limit: 20 }).catch(() => ({ data: [] }));
      if ((ucretler.data || []).some((c) => c.refunded || c.amount_refunded > 0 || c.disputed)) {
        await yaz(r, { durum: 'gecersiz', gecersiz_neden: 'iade' }, 'iade'); continue;
      }
      if (r.kart_izi) {
        const davetci = await kullaniciGetir(r.davet_eden);
        const izler = await musteriIzleri(stripe, davetci && davetci.app_metadata && davetci.app_metadata.stripe_customer_id);
        const kardesler = sonuc(await sb.from('ia_davetler').select('davet_edilen,kart_izi')
          .eq('davet_eden', r.davet_eden).eq('durum', 'sayildi')) || [];
        if (izler.has(r.kart_izi) || kardesler.some((k) => k.kart_izi === r.kart_izi)) {
          await yaz(r, { durum: 'gecersiz', gecersiz_neden: 'ayni_kart' }, 'ayni_kart'); continue;
        }
      }
      await yaz(r, { durum: 'sayildi', sayildi: new Date(simdi).toISOString() }, 'sayildi');
    } catch (e) {
      cikti.push({ davet_edilen: r.davet_edilen, sonuc: 'hata', hata: e && e.message });
    }
  }
  return cikti;
}

/** Hak edilen ama henuz yazilmamis oduller (yillik tavanla). Saf islev. */
function yeniOdulSayisi({ sayildi, oduller, simdi }) {
  const hak = Math.floor(sayildi / KISI_BASINA);
  const yillik = oduller.filter((o) => +simdi - Date.parse(o.created_at) < 365 * GUN_MS).length;
  return Math.max(0, Math.min(hak - oduller.length, YILLIK_TAVAN - yillik));
}

/** Her davetci icin yeni odul satirlari ("bekliyor"). */
async function odulleriHesapla({ sb, simdi = new Date() }) {
  const sayilanlar = sonuc(await sb.from('ia_davetler').select('davet_eden').eq('durum', 'sayildi')) || [];
  const kisiler = new Map();
  for (const s of sayilanlar) kisiler.set(s.davet_eden, (kisiler.get(s.davet_eden) || 0) + 1);
  const yeni = [];
  for (const [userId, sayildi] of kisiler) {
    const oduller = sonuc(await sb.from('ia_davet_odulleri').select('id,created_at').eq('user_id', userId)) || [];
    const n = yeniOdulSayisi({ sayildi, oduller, simdi });
    for (let i = 0; i < n; i++) yeni.push({ user_id: userId });
  }
  if (yeni.length) sonuc(await sb.from('ia_davet_odulleri').insert(yeni));
  return yeni.length;
}

/** Kupon gercekten %100 ve "once" mi? */
function davetKuponuDenetle(k) {
  if (!k || k.valid === false) return 'kupon gecersiz';
  if (k.percent_off !== 100 || k.amount_off) return `kupon %${k.percent_off} (beklenen %100)`;
  if (k.duration !== 'once') return `kupon suresi '${k.duration}' (beklenen 'once')`;
  return null;
}

/** app_metadata'yi birlestirerek yazar (rol vb. silinmesin). */
async function metaYaz(sb, userId, ek) {
  const { data, error } = await sb.auth.admin.getUserById(userId);
  if (error || !data || !data.user) throw new Error((error && error.message) || 'kullanici yok');
  const am = { ...(data.user.app_metadata || {}), ...ek };
  for (const k of Object.keys(am)) if (am[k] === undefined) delete am[k];
  const r = await sb.auth.admin.updateUserById(userId, { app_metadata: am });
  if (r.error) throw new Error(r.error.message || String(r.error));
  return am;
}

/**
 * Bekleyen odulleri verir. Ucretli (aktif abonelikli) davetci: aboneligine
 * %100 "once" kupon; abonelikte zaten bekleyen indirim varsa ertesi gune.
 * Odemeyen davetci: 30 gun Pro erisimi (ust uste eklenir).
 */
async function odulleriVer({ sb, stripe, kullaniciGetir, simdi = new Date(), env = process.env, hataKaydet = async () => {} }) {
  const bekleyen = sonuc(await sb.from('ia_davet_odulleri').select('*').eq('durum', 'bekliyor').order('created_at', { ascending: true })) || [];
  const cikti = [];
  let kuponSorunu;
  for (const o of bekleyen) {
    try {
      const u = await kullaniciGetir(o.user_id);
      if (!u) { cikti.push({ id: o.id, sonuc: 'kullanici_yok' }); continue; }
      const am = u.app_metadata || {};
      const ucretli = ODEMELI.has(am.subscription_status) && am.stripe_customer_id;
      if (ucretli) {
        const kupon = String(env.STRIPE_DAVET_KUPON || '').trim();
        if (kuponSorunu === undefined) {
          kuponSorunu = !kupon ? 'STRIPE_DAVET_KUPON tanimli degil' : davetKuponuDenetle(await stripe.coupons.retrieve(kupon).catch(() => null));
        }
        if (kuponSorunu) {
          await hataKaydet(`Referral reward waiting: ${kuponSorunu}`, { odul: o.id });
          cikti.push({ id: o.id, sonuc: 'kupon_sorunu' }); continue;
        }
        const l = await stripe.subscriptions.list({ customer: am.stripe_customer_id, status: 'active', limit: 1 });
        const sub = l.data && l.data[0];
        if (!sub) { cikti.push({ id: o.id, sonuc: 'abonelik_yok' }); continue; }
        if (Array.isArray(sub.discounts) && sub.discounts.length) { cikti.push({ id: o.id, sonuc: 'sirada' }); continue; }
        await stripe.subscriptions.update(sub.id, { discounts: [{ coupon: kupon }] });
        sonuc(await sb.from('ia_davet_odulleri').update({ durum: 'verildi', tur: 'fatura_kuponu', stripe_ref: sub.id, verildi: new Date(simdi).toISOString() }).eq('id', o.id));
        cikti.push({ id: o.id, sonuc: 'fatura_kuponu' });
      } else {
        const simdiMs = +simdi;
        const onceki = Date.parse(am.davet_pro_bitis || '') || 0;
        const bitis = new Date(Math.max(onceki, simdiMs) + PRO_ERISIM_GUN * GUN_MS).toISOString();
        await metaYaz(sb, o.user_id, { plan: 'pro', davet_pro_bitis: bitis });
        sonuc(await sb.from('ia_davet_odulleri').update({ durum: 'verildi', tur: 'pro_erisim', bitis, verildi: new Date(simdi).toISOString() }).eq('id', o.id));
        cikti.push({ id: o.id, sonuc: 'pro_erisim' });
      }
    } catch (e) {
      await hataKaydet(`Referral reward failed: ${e && e.message}`, { odul: o.id });
      cikti.push({ id: o.id, sonuc: 'hata', hata: e && e.message });
    }
  }
  return cikti;
}

/**
 * Suresi biten odul Pro erisimlerini Free'ye dondurur. Bu arada kendisi
 * abone olduysa (odemeli durum) plana DOKUNULMAZ, yalnizca isaret silinir.
 */
async function erisimleriBitir({ sb, kullanicilar, simdi = new Date() }) {
  const cikti = [];
  for (const u of kullanicilar) {
    const am = u.app_metadata || {};
    if (!am.davet_pro_bitis || Date.parse(am.davet_pro_bitis) > +simdi) continue;
    try {
      if (ODEMELI.has(am.subscription_status)) await metaYaz(sb, u.id, { davet_pro_bitis: undefined });
      else await metaYaz(sb, u.id, { plan: 'free', davet_pro_bitis: undefined });
      cikti.push({ user_id: u.id, sonuc: ODEMELI.has(am.subscription_status) ? 'isaret_silindi' : 'free' });
    } catch (e) { cikti.push({ user_id: u.id, sonuc: 'hata', hata: e && e.message }); }
  }
  return cikti;
}

/** Gunluk tur: degerlendir -> odul hesapla -> odul ver -> suresi bitenler. */
async function turCalistir({ sb, stripe, simdi = new Date(), env = process.env, log = console, hataKaydet }) {
  const kullanicilar = await require('./geri-kazanma').kullanicilar(sb);
  const harita = new Map(kullanicilar.map((u) => [u.id, u]));
  const kullaniciGetir = async (id) => harita.get(id) || null;
  const d = await degerlendir({ sb, stripe, kullaniciGetir, simdi });
  const yeni = await odulleriHesapla({ sb, simdi });
  const v = await odulleriVer({ sb, stripe, kullaniciGetir, simdi, env, hataKaydet });
  const b = await erisimleriBitir({ sb, kullanicilar, simdi });
  const say = (l, s) => l.filter((x) => x.sonuc === s).length;
  log.info?.(`[davet] ${say(d, 'sayildi')} sayildi, ${d.length - say(d, 'sayildi') - say(d, 'hata')} gecersiz, ${yeni} yeni odul, `
    + `${say(v, 'pro_erisim') + say(v, 'fatura_kuponu')} verildi, ${say(b, 'free')} erisim bitti`);
  return { degerlendirme: d, yeni, verilen: v, biten: b };
}

function zamaniGeldiMi(simdi, sonGun, env = process.env) {
  const h = env.DAVET_SAATI;
  const saat = h !== undefined && h !== '' && Number.isFinite(Number(h)) ? Number(h) : 18;
  const d = new Date(simdi);
  return d.getUTCHours() >= saat && sonGun !== d.toISOString().slice(0, 10);
}

let _sonGun = null;
let _calisiyor = false;
function zamanlayiciBaslat(log = console, { env = process.env } = {}) {
  if (String(env.DAVET_ZAMANLAYICI || '').toLowerCase() === 'kapali') return null;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.STRIPE_SECRET_KEY) return null;
  const calis = async () => {
    const simdi = new Date();
    if (_calisiyor || !zamaniGeldiMi(simdi, _sonGun, env)) return;
    _calisiyor = true;
    _sonGun = simdi.toISOString().slice(0, 10);
    try {
      const sb = require('./bot-depo').getSupabase();
      const Stripe = require('stripe');
      const { logError } = require('./errors');
      await turCalistir({ sb, stripe: new Stripe(env.STRIPE_SECRET_KEY), simdi, env, log,
        hataKaydet: (mesaj, meta) => logError({ source: 'server', level: 'warn', message: mesaj, route: 'davet', meta }) });
    } catch (e) { log.error?.(`[davet] tur hatasi: ${e && e.message}`); }
    finally { _calisiyor = false; }
  };
  const t = setInterval(calis, 15 * 60 * 1000);
  if (t.unref) t.unref();
  return t;
}

function _sifirla() { _sonGun = null; _calisiyor = false; }

module.exports = {
  kodUret, kodTemizle, kodGetir, baglan, arkadasIndirimi, ozet, kartIzi, odemeKaydet, degerlendir,
  yeniOdulSayisi, odulleriHesapla, davetKuponuDenetle, odulleriVer, erisimleriBitir, turCalistir,
  zamaniGeldiMi, zamanlayiciBaslat, _sifirla,
  BEKLEME_GUN, KISI_BASINA, YILLIK_TAVAN, PRO_ERISIM_GUN, BAGLAMA_GUN, KOD,
};
