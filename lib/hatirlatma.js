'use strict';

/**
 * server/lib/hatirlatma.js — Basvuru sonuc hatirlatmasi e-postasi (K85).
 *
 * Kullanicinin kararlari (K80, 30 Eylul 2026):
 *   * Basvurudan 15 gun ve 1 ay sonra "sonuc ne oldu?" (hemen cevap gelmiyor).
 *     Sayfadaki hatirlatma herkese her zaman (web); bu dosya yalnizca e-posta.
 *   * Kisi basina GUNDE EN FAZLA BIR e-posta; o gunun butun hatirlatmalari
 *     tek e-postada.
 *   * Free kullaniciya hesabi boyunca TEK hatirlatma e-postasi ("sistemin
 *     calistigini gorsun"); sonrakiler yalnizca sayfada. Ucretliye gunde bir.
 *   * Kota dolarsa once ucretliler (Resend ucretsiz 100/gun, ortak tavan
 *     lib/eposta-kota.js).
 *
 * Gunde bir kez, HATIRLATMA_SAATI (UTC, varsayilan 16 = Vancouver sabah 9).
 * Bir kayit: 30. gun zamani geldiyse tek hatirlatma (15 ve 30 birlikte
 * isaretlenir), yoksa 15. gun. Isaret "e-posta gitti ya da gitmeyecek"
 * demek (kapali tercih, Free hakki bitmis): ayni kayit her gun yeniden
 * taranmasin. Gonderilemeyen (kota, gecici hata, 20 saat kurali) isaretlenmez,
 * ertesi gun yeniden denenir.
 */

const epostaKota = require('./eposta-kota');
const imza = require('./eposta-imza');

const GUN_MS = 86400000;
const EN_AZ_ARALIK_MS = 20 * 3600 * 1000;   // "gunde bir": is her gun ayni saatte, 24 saat birkac dakika kacirirdi
const GOSTERILEN = 10;
const APP_URL_VARSAYILAN = 'https://www.placedai.app';
const UCRETLI = new Set(['pro', 'ultimate']);

const gunOnce = (bugun, n) => new Date(Date.parse(`${bugun}T00:00:00Z`) - n * GUN_MS).toISOString().slice(0, 10);

/**
 * Aday satirlari kullaniciya gore gruplar.
 * @returns {Map<string, {kayitlar: object[], ids15: string[], ids30: string[]}>}
 */
function grupla(satirlar, bugun) {
  const d15 = gunOnce(bugun, 15);
  const d30 = gunOnce(bugun, 30);
  const g = new Map();
  for (const r of satirlar || []) {
    if (!r || !r.user_id || !r.id) continue;
    const otuz = r.basvuru_tarihi <= d30 && !r.hatirlatma_30;
    const onbes = r.basvuru_tarihi <= d15 && !r.hatirlatma_15;
    if (!otuz && !onbes) continue;
    if (!g.has(r.user_id)) g.set(r.user_id, { kayitlar: [], ids15: [], ids30: [] });
    const k = g.get(r.user_id);
    k.kayitlar.push(r);
    if (!r.hatirlatma_15) k.ids15.push(r.id);
    if (otuz) k.ids30.push(r.id);
  }
  return g;
}

function kacis(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const tek = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** E-posta icerigi. Free ise bunun tek e-posta oldugu durustce soylenir. */
function icerik({ kayitlar, bugun, kapatmaLinki, free, appUrl = APP_URL_VARSAYILAN }) {
  const n = kayitlar.length;
  const gosterilen = kayitlar.slice(0, GOSTERILEN);
  const kalan = n - gosterilen.length;
  const sayfa = `${String(appUrl).replace(/\/+$/, '')}/dashboard`;
  const gunler = (r) => Math.max(0, Math.round((Date.parse(`${bugun}T00:00:00Z`) - Date.parse(`${r.basvuru_tarihi}T00:00:00Z`)) / GUN_MS));
  const satir = (r) => `${[tek(r.pozisyon, 120), tek(r.sirket, 120)].filter(Boolean).join(' at ')} (applied ${gunler(r)} days ago)`;
  const subject = n === 1 ? 'How did your application go?' : `How did your ${n} applications go?`;
  const freeNot = 'On the Free plan this is your one reminder by email. Later reminders appear in your Application Tracker.';
  const text = [
    n === 1 ? 'It has been a while since you applied. Did you hear back?' : 'It has been a while since you applied to these roles. Did you hear back?',
    '',
    ...gosterilen.map((r) => `- ${satir(r)}`),
    ...(kalan > 0 ? [`+ ${kalan} more in your tracker.`] : []),
    '',
    `Record the outcome (interview, rejected, no reply, got the job): ${sayfa}`,
    'Keeping track shows you what works, and when you land the job we would love to hear about it.',
    ...(free ? ['', freeNot] : []),
    '',
    'You get this email because you track your applications in PlacedAI (at most one email a day).',
    ...(kapatmaLinki ? [`Turn off these reminders: ${kapatmaLinki}`] : []),
  ].join('\n');
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.45;color:#111;max-width:560px">'
    + `<p>${n === 1 ? 'It has been a while since you applied. Did you hear back?' : 'It has been a while since you applied to these roles. Did you hear back?'}</p>`
    + `<ul style="padding-left:20px">${gosterilen.map((r) => `<li style="margin:0 0 8px">${kacis(satir(r))}</li>`).join('')}</ul>`
    + (kalan > 0 ? `<p>+ ${kalan} more in your tracker.</p>` : '')
    + `<p><a href="${kacis(sayfa)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Record the outcome</a></p>`
    + '<p style="color:#555">Interview, rejected, no reply or got the job. Keeping track shows you what works, and when you land the job we would love to hear about it.</p>'
    + (free ? `<p style="color:#555">${kacis(freeNot)}</p>` : '')
    + '<hr style="border:none;border-top:1px solid #ddd">'
    + '<p style="color:#777;font-size:12px">You get this email because you track your applications in PlacedAI (at most one email a day).'
    + (kapatmaLinki ? ` <a href="${kacis(kapatmaLinki)}" style="color:#777">Turn off these reminders</a>.` : '')
    + '</p></div>';
  return { subject, text, html };
}

/**
 * Bir tur. Hata atmaz (kullanici bazinda yakalar).
 * @returns {Promise<{user_id:string, durum:string}[]>}
 */
async function turCalistir({ depo, kullanici, postaGonder, simdi = new Date(), env = process.env, log = console } = {}) {
  const t = +simdi;
  const bugun = new Date(t).toISOString().slice(0, 10);
  const gruplar = grupla(await depo.hatirlatmaAdaylari(bugun), bugun);

  // Plan ve tercihi oku; kota dolarsa once ucretliler gonderilsin.
  const kisiler = [];
  for (const [userId, g] of gruplar) {
    try {
      const [hesap, tercih] = await Promise.all([kullanici(userId), depo.tercihOku(userId)]);
      kisiler.push({ userId, g, hesap, tercih });
    } catch (e) {
      kisiler.push({ userId, g, hata: e });
    }
  }
  const ucretli = (k) => !!(k.hesap && UCRETLI.has(k.hesap.plan));
  kisiler.sort((a, b) => Number(ucretli(b)) - Number(ucretli(a)));

  const sonuclar = [];
  for (const k of kisiler) {
    const { userId, g, hesap, tercih } = k;
    const isaretle = () => depo.hatirlatmaIsaretle(userId, g.ids15, g.ids30, simdi);
    try {
      if (k.hata) throw k.hata;
      if (!hesap) { sonuclar.push({ user_id: userId, durum: 'hesap_yok' }); continue; }
      if (!tercih.hatirlatma) { await isaretle(); sonuclar.push({ user_id: userId, durum: 'kapali' }); continue; }
      const free = !ucretli(k);
      if (free && tercih.hatirlatma_sayisi >= 1) { await isaretle(); sonuclar.push({ user_id: userId, durum: 'free_hakki_bitti' }); continue; }
      if (tercih.son_hatirlatma && t - Date.parse(tercih.son_hatirlatma) < EN_AZ_ARALIK_MS) { sonuclar.push({ user_id: userId, durum: 'erken' }); continue; }
      if (!hesap.email) { await isaretle(); sonuclar.push({ user_id: userId, durum: 'adres_yok' }); continue; }
      if (epostaKota.kalan(t, env) <= 0) { sonuclar.push({ user_id: userId, durum: 'tavan' }); continue; }

      const link = imza.kapatmaLinki(userId, 'hatirlatma', env, 'basvurular');
      const { subject, text, html } = icerik({ kayitlar: g.kayitlar, bugun, kapatmaLinki: link, free, ...(env.APP_URL ? { appUrl: env.APP_URL } : {}) });
      const headers = link ? { 'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined;
      epostaKota.say(t);
      const r = await postaGonder({ to: hesap.email, subject, text, html, ...(headers ? { headers } : {}) });
      if (!r || !r.ok) { sonuclar.push({ user_id: userId, durum: 'gonderilemedi', hata: r && r.error }); continue; }
      await isaretle();
      await depo.tercihYaz(userId, { son_hatirlatma: new Date(t).toISOString(), hatirlatma_sayisi: (tercih.hatirlatma_sayisi || 0) + 1 });
      sonuclar.push({ user_id: userId, durum: 'gonderildi', adet: g.kayitlar.length });
    } catch (e) {
      sonuclar.push({ user_id: userId, durum: 'hata', hata: e && e.message });
    }
  }
  if (sonuclar.length) {
    const say = (d) => sonuclar.filter((s) => s.durum === d).length;
    log.info?.(`[hatirlatma] ${sonuclar.length} kisi: ${say('gonderildi')} e-posta, ${say('free_hakki_bitti')} Free (yalnizca sayfada), ${say('tavan')} kota, ${say('hata') + say('gonderilemedi')} hata`);
  }
  return sonuclar;
}

/** Gunde bir: saat HATIRLATMA_SAATI (UTC) gecmisse ve bugun henuz calismadiysa. */
function zamaniGeldiMi(simdi, sonGun, env = process.env) {
  const saat = Number.isFinite(Number(env.HATIRLATMA_SAATI)) && env.HATIRLATMA_SAATI !== '' && env.HATIRLATMA_SAATI !== undefined ? Number(env.HATIRLATMA_SAATI) : 16;
  const d = new Date(simdi);
  return d.getUTCHours() >= saat && sonGun !== d.toISOString().slice(0, 10);
}

let _sonGun = null;
let _calisiyor = false;
function zamanlayiciBaslat(log = console, { depo = require('./basvuru-depo'), kullanici = require('./bot-depo').kullanici,
  postaGonder = require('./mailer').sendMail, env = process.env } = {}) {
  if (String(env.HATIRLATMA_ZAMANLAYICI || '').toLowerCase() === 'kapali') return null;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const calis = async () => {
    const simdi = new Date();
    if (_calisiyor || !zamaniGeldiMi(simdi, _sonGun, env)) return;
    _calisiyor = true;
    _sonGun = simdi.toISOString().slice(0, 10);
    try { await turCalistir({ depo, kullanici, postaGonder, simdi, env, log }); }
    catch (e) { log.error?.(`[hatirlatma] tur hatasi: ${e && e.message}`); }
    finally { _calisiyor = false; }
  };
  const t = setInterval(calis, 15 * 60 * 1000);
  if (t.unref) t.unref();
  return t;
}

function _sifirla() { _sonGun = null; _calisiyor = false; }

module.exports = { grupla, icerik, turCalistir, zamaniGeldiMi, zamanlayiciBaslat, EN_AZ_ARALIK_MS, GOSTERILEN, _sifirla };
