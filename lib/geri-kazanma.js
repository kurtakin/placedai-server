'use strict';

/**
 * server/lib/geri-kazanma.js — Geri kazanma e-postasi (K88, 1 Ekim 2026;
 * 6. adimin 6b parcasi).
 *
 * Kullanicinin kararlari (DEVAM.md K87):
 *  * Teklif e-postasi izni vermis, HIC odeme yapmamis Free kullaniciya
 *    uyeliginin 37. gunu, HAYATINDA TEK e-posta.
 *  * Kisiye ozel, TEK kullanimlik, 14 gun gecerli %15 ilk ay kodu (Stripe
 *    promosyon kodu; kupon "15% off, once" kullanicinin Stripe'ta olusturdugu,
 *    kimligi STRIPE_GERI_KAZANMA_KUPON). Kod Stripe'ta "yalnizca ilk odeme"
 *    kisitli: daha once odemis biri kullanamaz.
 *  * Kodun kullanilip kullanilmadigi Stripe'tan olculur (times_redeemed).
 *
 * Guvenlik kilitleri (hepsi saglanmadan HICBIR e-posta gitmez):
 *  * POSTA_ADRESI yoksa (lib/pazarlama.js altBilgi null) gonderilmez.
 *  * Kupon Stripe'ta okunur ve gercekten "%15, once" degilse tur durur
 *    (yanlis kupon kimligiyle %100 indirim dagitilmasin).
 *  * Pencere 37-44. gun: kacan bir gun ertesi gun telafi edilir, ama eski
 *    hesaplara toplu e-posta gitmez.
 *  * Gunluk tavan lib/eposta-kota.js ile ORTAK; bu is hatirlatmadan SONRA
 *    calisir (islem e-postasi once).
 */

const epostaKota = require('./eposta-kota');
const pazarlama = require('./pazarlama');

const GUN_MS = 86400000;
const PENCERE = Object.freeze({ bas: 37, son: 44 });
const GECERLILIK_GUN = 14;
const INDIRIM_YUZDE = 15;
const EN_COK_DENEME = 3;
const APP_URL_VARSAYILAN = 'https://www.placedai.app';
const TABLO = 'ia_geri_kazanma';

function sonuc({ data, error }) {
  if (error) throw new Error(error.message || String(error));
  return data;
}

/** Uyelik kac gunluk (tam gun). */
const yas = (user, simdi) => Math.floor((+simdi - Date.parse(user.created_at)) / GUN_MS);

/**
 * Aday mi? Plan Free, hic abonelik izi yok (subscription_status hic yazilmamis),
 * e-postasi dogrulanmis, uyelik 37-44 gun.
 */
function adayMi(user, simdi) {
  if (!user || !user.email || !user.email_confirmed_at || !user.created_at) return false;
  const am = user.app_metadata || {};
  if ((am.plan || 'free') !== 'free') return false;
  if (am.subscription_status) return false;   // bir kez bile abonelik olmus: "hic odemedi" degil
  const g = yas(user, simdi);
  return g >= PENCERE.bas && g <= PENCERE.son;
}

/** Butun kullanicilari sayfa sayfa okur (Supabase admin). */
async function kullanicilar(sb, sayfaBoyu = 1000) {
  const hepsi = [];
  for (let page = 1; page < 1000; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: sayfaBoyu });
    if (error) throw new Error(error.message || String(error));
    const u = (data && data.users) || [];
    hepsi.push(...u);
    if (u.length < sayfaBoyu) break;
  }
  return hepsi;
}

/** Kupon gercekten "%15, yalnizca ilk ay" mi? Degilse neden. */
function kuponDenetle(k) {
  if (!k || k.valid === false) return 'kupon gecersiz ya da silinmis';
  if (k.percent_off !== INDIRIM_YUZDE) return `kupon %${k.percent_off} (beklenen %${INDIRIM_YUZDE})`;
  if (k.amount_off) return 'kupon sabit tutar indirimi';
  if (k.duration !== 'once') return `kupon suresi '${k.duration}' (beklenen 'once')`;
  return null;
}

const tarihMetni = (iso) => new Date(iso).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
function kacis(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** E-posta: sakin, baskisiz; kod, gecerlilik, nasil kullanilir; altbilgi zorunlu. */
function icerik({ kod, gecerlilik, alt, appUrl = APP_URL_VARSAYILAN }) {
  const fiyat = `${String(appUrl).replace(/\/+$/, '')}/#pricing`;
  const son = tarihMetni(gecerlilik);
  const subject = `${INDIRIM_YUZDE}% off your first month of PlacedAI Pro`;
  const text = [
    'You have been using PlacedAI for about a month. If Pro would help with your next interviews,',
    `here is ${INDIRIM_YUZDE}% off your first month.`,
    '',
    `Your code: ${kod}`,
    `Valid until ${son}. One use, for a first payment only.`,
    '',
    `Enter it on the payment page after choosing a plan: ${fiyat}`,
    '',
    'This is the only offer email we send about this. No reply needed.',
    '',
    alt.text,
  ].join('\n');
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:560px">'
    + `<p>You have been using PlacedAI for about a month. If Pro would help with your next interviews, here is ${INDIRIM_YUZDE}% off your first month.</p>`
    + `<p style="font-size:20px;font-weight:bold;letter-spacing:1px;background:#f3f4f6;border-radius:8px;padding:12px 16px;display:inline-block">${kacis(kod)}</p>`
    + `<p>Valid until ${kacis(son)}. One use, for a first payment only.</p>`
    + `<p><a href="${kacis(fiyat)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">See plans</a></p>`
    + '<p style="color:#555">Enter the code on the payment page after choosing a plan. This is the only offer email we send about this.</p>'
    + alt.html
    + '</div>';
  return { subject, text, html };
}

/**
 * Bir tur. Kisi bazinda hatalari yakalar.
 * @param {{sb, stripe, postaGonder, simdi?: Date, env?: object, log?: object}} p
 * @returns {Promise<{durdu?: string, sonuclar: {user_id: string, durum: string}[]}>}
 */
async function turCalistir({ sb, stripe, postaGonder, simdi = new Date(), env = process.env, log = console }) {
  const kuponId = String(env.STRIPE_GERI_KAZANMA_KUPON || '').trim();
  if (!kuponId) return { durdu: 'kupon tanimli degil', sonuclar: [] };
  if (!pazarlama.gonderilebilir(env)) return { durdu: 'posta adresi yok', sonuclar: [] };
  if (!stripe) return { durdu: 'stripe yok', sonuclar: [] };
  const sorun = kuponDenetle(await stripe.coupons.retrieve(kuponId).catch(() => null));
  if (sorun) { log.error?.(`[geri-kazanma] DURDU: ${sorun}`); return { durdu: sorun, sonuclar: [] }; }

  const t = +simdi;
  const adaylar = (await kullanicilar(sb)).filter((u) => adayMi(u, simdi));
  const sonuclar = [];
  for (const u of adaylar) {
    try {
      const kayit = sonuc(await sb.from(TABLO).select('*').eq('user_id', u.id).maybeSingle());
      if (kayit && kayit.durum === 'gonderildi') { sonuclar.push({ user_id: u.id, durum: 'zaten' }); continue; }
      if (kayit && (kayit.deneme >= EN_COK_DENEME || Date.parse(kayit.gecerlilik) - t < 10 * GUN_MS)) {
        sonuclar.push({ user_id: u.id, durum: 'vazgecildi' }); continue;   // kod buyuk olcude dolmus; gec kalinmis teklif yok
      }
      const izin = pazarlama.izinDurumu(await pazarlama.satirOku(u.id), u);
      if (!izin.izin) { sonuclar.push({ user_id: u.id, durum: 'izin_yok' }); continue; }
      const alt = pazarlama.altBilgi(u.id, env);
      if (!alt) { sonuclar.push({ user_id: u.id, durum: 'altbilgi_yok' }); continue; }
      if (epostaKota.kalan(t, env) <= 0) { sonuclar.push({ user_id: u.id, durum: 'tavan' }); continue; }

      let k = kayit;
      if (!k) {
        const gecerlilik = new Date(t + GECERLILIK_GUN * GUN_MS);
        const promo = await stripe.promotionCodes.create({
          promotion: { type: 'coupon', coupon: kuponId },
          max_redemptions: 1,
          expires_at: Math.floor(+gecerlilik / 1000),
          restrictions: { first_time_transaction: true },
          metadata: { user_id: u.id, amac: 'geri_kazanma' },
        });
        k = { user_id: u.id, durum: 'hazirlandi', promosyon_kodu: promo.code, stripe_promosyon_id: promo.id,
          gecerlilik: gecerlilik.toISOString(), deneme: 0 };
        sonuc(await sb.from(TABLO).insert(k));
      }
      const { subject, text, html } = icerik({ kod: k.promosyon_kodu, gecerlilik: k.gecerlilik, alt, ...(env.APP_URL ? { appUrl: env.APP_URL } : {}) });
      epostaKota.say(t);
      const r = await postaGonder({ to: u.email, subject, text, html, headers: alt.headers });
      if (!r || !r.ok) {
        sonuc(await sb.from(TABLO).update({ deneme: (k.deneme || 0) + 1 }).eq('user_id', u.id));
        sonuclar.push({ user_id: u.id, durum: 'gonderilemedi' }); continue;
      }
      sonuc(await sb.from(TABLO).update({ durum: 'gonderildi', gonderildi: new Date(t).toISOString(), deneme: (k.deneme || 0) + 1 }).eq('user_id', u.id));
      sonuclar.push({ user_id: u.id, durum: 'gonderildi' });
    } catch (e) {
      sonuclar.push({ user_id: u.id, durum: 'hata', hata: e && e.message });
    }
  }
  if (sonuclar.length) {
    const say = (d) => sonuclar.filter((s) => s.durum === d).length;
    log.info?.(`[geri-kazanma] ${sonuclar.length} aday: ${say('gonderildi')} gonderildi, ${say('izin_yok')} izinsiz, ${say('tavan')} kota, ${say('hata') + say('gonderilemedi')} hata`);
  }
  return { sonuclar };
}

/**
 * Olcum (veri): gonderilen kodlarin kaci kullanildi. Stripe'taki
 * times_redeemed'den; okunamayan kod "bilinmiyor" sayilir, kullanilmamis degil.
 */
async function olcum({ sb, stripe }) {
  const satirlar = sonuc(await sb.from(TABLO).select('user_id,durum,stripe_promosyon_id,gecerlilik,gonderildi').eq('durum', 'gonderildi')) || [];
  let kullanilan = 0;
  let bilinmiyor = 0;
  for (const r of satirlar) {
    try {
      const p = await stripe.promotionCodes.retrieve(r.stripe_promosyon_id);
      if (p && p.times_redeemed > 0) kullanilan++;
    } catch { bilinmiyor++; }
  }
  return { gonderilen: satirlar.length, kullanilan, bilinmiyor,
    oran: satirlar.length - bilinmiyor > 0 ? Math.round((kullanilan / (satirlar.length - bilinmiyor)) * 1000) / 10 : null };
}

/** Gunde bir: GERI_KAZANMA_SAATI (UTC, varsayilan 17; hatirlatma 16'da) gecmisse ve bugun calismadiysa. */
function zamaniGeldiMi(simdi, sonGun, env = process.env) {
  const h = env.GERI_KAZANMA_SAATI;
  const saat = h !== undefined && h !== '' && Number.isFinite(Number(h)) ? Number(h) : 17;
  const d = new Date(simdi);
  return d.getUTCHours() >= saat && sonGun !== d.toISOString().slice(0, 10);
}

let _sonGun = null;
let _calisiyor = false;
function zamanlayiciBaslat(log = console, { env = process.env, postaGonder = require('./mailer').sendMail } = {}) {
  if (String(env.GERI_KAZANMA_ZAMANLAYICI || '').toLowerCase() === 'kapali') return null;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.STRIPE_SECRET_KEY || !env.STRIPE_GERI_KAZANMA_KUPON) return null;
  const calis = async () => {
    const simdi = new Date();
    if (_calisiyor || !zamaniGeldiMi(simdi, _sonGun, env)) return;
    _calisiyor = true;
    _sonGun = simdi.toISOString().slice(0, 10);
    try {
      const sb = require('./bot-depo').getSupabase();
      const Stripe = require('stripe');
      await turCalistir({ sb, stripe: new Stripe(env.STRIPE_SECRET_KEY), postaGonder, simdi, env, log });
    } catch (e) { log.error?.(`[geri-kazanma] tur hatasi: ${e && e.message}`); }
    finally { _calisiyor = false; }
  };
  const t = setInterval(calis, 15 * 60 * 1000);
  if (t.unref) t.unref();
  return t;
}

function _sifirla() { _sonGun = null; _calisiyor = false; }

module.exports = {
  adayMi, kuponDenetle, icerik, turCalistir, olcum, zamaniGeldiMi, zamanlayiciBaslat, kullanicilar,
  PENCERE, GECERLILIK_GUN, INDIRIM_YUZDE, EN_COK_DENEME, _sifirla,
};
