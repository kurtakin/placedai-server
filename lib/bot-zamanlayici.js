'use strict';

/**
 * server/lib/bot-zamanlayici.js — Sayfa kapaliyken calisan is botu (K81).
 *
 * Kullanicinin kararlari (K80):
 *   * Bot 12 saatte bir arar. Otomatik basvuru YOK; bulunan ilanlar puanlanip
 *     bot sayfasinda onaya sunulur.
 *   * Ozet e-postasi gunde en fazla bir kez ve yalnizca yeni ilan varsa.
 *   * Yalnizca Ultimate. Plan her turda hesaptan okunur; plani dusen
 *     kullanici icin arama yapilmaz (ayar silinmez, plan geri gelince devam).
 *
 * Kotalar (olculdu, K80): Adzuna ucretsiz 250/gun, Resend ucretsiz 100/gun.
 *   Bot gunde en fazla BOT_ADZUNA_GUNLUK (120) Adzuna aramasi yapar; kalan
 *   pay webdeki elle aramalarin. Sinir dolunca bot yalnizca sirket panolariyla
 *   arar. Bot ozeti ve basvuru hatirlatmasi birlikte gunde en fazla
 *   EPOSTA_GUNLUK (80; eski ad BOT_EPOSTA_GUNLUK) (lib/eposta-kota.js, K85).
 *   Sayaclar BELLEKTE: sunucu yeniden baslarsa o gun icin sifirlanir. Railway
 *   gunde birkac kez yeniden baslatmaz; tavanlar kotanin altinda pay birakiyor.
 *
 * Tur: 15 dakikada bir, zamani gelmis en fazla 5 kullanici (gunde 480 arama
 * kapasitesi; 40 Ultimate kullanici gunde 80 arama ister).
 * BOT_ZAMANLAYICI=kapali ile tamamen durur.
 */

const { searchJobs, SOURCES } = require('./job-sources');
const { uygunlukPuani } = require('./bot-puan');
const { sade } = require('./konum');
const { ozetIcerigi } = require('./bot-ozet');
const imza = require('./eposta-imza');

const SAAT = 3600 * 1000;
const ARALIK_MS      = 12 * SAAT;       // iki arama arasi
const HATA_BEKLE_MS  = 1 * SAAT;        // arama hata verirse
const OZET_ARALIK_MS = 24 * SAAT;       // iki ozet e-postasi arasi en az
const TUR_MS         = 15 * 60 * 1000;
const TUR_BASINA     = 5;
const ILAN_SATIR     = 25;              // kaynak basina istenen ilan

const gunAnahtari = (t) => new Date(t).toISOString().slice(0, 10);   // UTC gunu

function sayac() {
  let gun = null; let adet = 0;
  return {
    kalan(simdi, tavan) { if (gun !== gunAnahtari(simdi)) { gun = gunAnahtari(simdi); adet = 0; } return Math.max(0, tavan - adet); },
    say(simdi) { if (gun !== gunAnahtari(simdi)) { gun = gunAnahtari(simdi); adet = 0; } adet++; },
    _sifirla() { gun = null; adet = 0; },
  };
}
const adzunaSayaci = sayac();
// E-posta tavani bot ozeti ve basvuru hatirlatmasi icin ORTAK (K85).
const epostaKota = require('./eposta-kota');

const tavan = (ad, varsayilan, env) => {
  const n = Number(env[ad]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : varsayilan;
};

/**
 * Ayni ilanin ikinci kez eklenmemesi icin anahtar: baslik + sirket + konum.
 * Baglanti degil: Adzuna ayni ilani farkli yonlendirme adresiyle yeniden
 * yayinliyor ve ayni ilan hem Adzuna'da hem sirket panosunda cikabiliyor.
 */
function ilanAnahtari(j) {
  const k = [j.title, j.company, j.location].map((x) => sade(x).slice(0, 90)).join('|');
  return k.replace(/\|+$/, '').slice(0, 200) || null;
}

const kes = (s, n) => String(s == null ? '' : s).slice(0, n);
function guvenliLink(u) {
  try { const x = new URL(String(u || '')); return /^https?:$/.test(x.protocol) && x.href.length <= 1000 ? x.href : ''; } catch { return ''; }
}

/** Arama sonucu -> ia_bot_ilanlari satirlari (puanli, tekil). */
function satirlaraCevir(jobs, ayar) {
  const gorulen = new Set();
  const out = [];
  for (const j of jobs || []) {
    const anahtar = ilanAnahtari(j);
    if (!anahtar || gorulen.has(anahtar)) continue;
    gorulen.add(anahtar);
    const { puan } = uygunlukPuani(j, { anahtar: ayar.anahtar_kelime, profil: ayar.profil || {}, kademe: j.konum_kademe });
    out.push({
      ilan_anahtari: anahtar,
      baslik: kes(j.title, 300), sirket: kes(j.company, 200), konum: kes(j.location, 200),
      link: guvenliLink(j.link), kaynak: kes(j.source, 60),
      konum_kademe: j.konum_kademe || null, uygunluk: puan,
    });
  }
  return out;
}

/**
 * Bir kullanicinin aramasi. Hata atmaz; ne oldugunu doner.
 * @returns {Promise<{durum: 'arandi'|'plan'|'anahtar_yok'|'hesap_yok'|'hata', eklenen?: number, adzuna?: boolean, hata?: string}>}
 */
async function kullaniciTara(ayar, { depo, ara = searchJobs, simdi = new Date(), env = process.env, hesap } = {}) {
  const t = +simdi;
  const sonraki = (ms) => depo.aramaBitti(ayar.user_id, { son_arama: simdi, sonraki_arama: new Date(t + ms) });
  try {
    const h = hesap !== undefined ? hesap : await depo.kullanici(ayar.user_id);
    // Hesap silinince satir da silinir (cascade); burada yoksa gecici bir durum.
    if (!h) { await depo.aramaBitti(ayar.user_id, { sonraki_arama: new Date(t + ARALIK_MS) }); return { durum: 'hesap_yok' }; }
    if (h.plan !== 'ultimate') {
      await depo.aramaBitti(ayar.user_id, { sonraki_arama: new Date(t + ARALIK_MS) });
      return { durum: 'plan' };
    }
    if (!String(ayar.anahtar_kelime || '').trim()) {
      await depo.aramaBitti(ayar.user_id, { sonraki_arama: new Date(t + ARALIK_MS) });
      return { durum: 'anahtar_yok' };
    }

    const adzunaVar = !!(env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY) && SOURCES.adzuna;
    const adzunaHakki = adzunaVar && adzunaSayaci.kalan(t, tavan('BOT_ADZUNA_GUNLUK', 120, env)) > 0;
    const kaynaklar = Object.keys(SOURCES).filter((k) => SOURCES[k].sunucudanErisilebilir && (k !== 'adzuna' || adzunaHakki));
    if (adzunaHakki) adzunaSayaci.say(t);   // istek basarisiz olsa da Adzuna sayar

    const r = await ara({
      keywords: ayar.anahtar_kelime, location: ayar.konum || '', sources: kaynaklar, rows: ILAN_SATIR, env,
      kullaniciKonumu: ayar.konum || '', uzaklariGoster: false,
      ekSirketler: Array.isArray(ayar.sirketler) ? ayar.sirketler : [],
    });
    // Butun kaynaklar hata verdiyse "0 ilan" degil hata: bir saat sonra yeniden.
    const ozet = (r && Array.isArray(r.sources)) ? r.sources : [];
    if (ozet.length && ozet.every((x) => x.status === 'error' || x.status === 'unconfigured')) {
      throw new Error(`kaynaklar: ${ozet.map((x) => `${x.key} ${x.status}`).join(', ')}`);
    }
    const eklenen = await depo.ilanlariEkle(ayar.user_id, satirlaraCevir(r && r.jobs, ayar));
    await sonraki(ARALIK_MS);
    return { durum: 'arandi', eklenen, adzuna: !!adzunaHakki };
  } catch (e) {
    try { await sonraki(HATA_BEKLE_MS); } catch { /* tablo da yazilamiyorsa bir sonraki tur yeniden dener */ }
    return { durum: 'hata', hata: e && e.message };
  }
}

/**
 * Ozet e-postasi: son ozetten 24 saat gecmisse ve yeni ilan varsa.
 * @returns {Promise<{durum: 'gonderildi'|'kapali'|'erken'|'bos'|'tavan'|'adres_yok'|'gonderilemedi'|'hata', adet?: number, hata?: string}>}
 */
async function ozetGonder(ayar, { depo, postaGonder, simdi = new Date(), env = process.env, hesap } = {}) {
  const t = +simdi;
  try {
    if (!ayar.eposta_ozet) return { durum: 'kapali' };
    if (ayar.son_eposta && t - Date.parse(ayar.son_eposta) < OZET_ARALIK_MS) return { durum: 'erken' };
    const ilanlar = await depo.ozetIlanlari(ayar.user_id);
    if (!ilanlar.length) return { durum: 'bos' };
    if (epostaKota.kalan(t, env) <= 0) return { durum: 'tavan' };
    const h = hesap !== undefined ? hesap : await depo.kullanici(ayar.user_id);
    if (!h || !h.email) return { durum: 'adres_yok' };

    const link = imza.kapatmaLinki(ayar.user_id, 'bot_ozet', env);
    const { subject, text, html } = ozetIcerigi({ ilanlar, anahtar: ayar.anahtar_kelime, kapatmaLinki: link, ...(env.APP_URL ? { appUrl: env.APP_URL } : {}) });
    const headers = link ? { 'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined;
    epostaKota.say(t);
    const g = await postaGonder({ to: h.email, subject, text, html, ...(headers ? { headers } : {}) });
    if (!g || !g.ok) return { durum: 'gonderilemedi', hata: g && g.error };
    await depo.ozetIsaretle(ayar.user_id, ilanlar.map((x) => x.id), simdi);
    return { durum: 'gonderildi', adet: ilanlar.length };
  } catch (e) {
    return { durum: 'hata', hata: e && e.message };
  }
}

/** Bir tur: zamani gelmis kullanicilar icin arama, ardindan ozet. */
async function turCalistir({ depo, ara, postaGonder, simdi = new Date(), env = process.env, log = console } = {}) {
  const liste = await depo.siradakiler(simdi, TUR_BASINA);
  const sonuclar = [];
  for (const ayar of liste) {
    let hesap;
    try { hesap = await depo.kullanici(ayar.user_id); } catch (e) { hesap = undefined; }
    const tara = await kullaniciTara(ayar, { depo, ara, simdi, env, ...(hesap !== undefined ? { hesap } : {}) });
    const ozet = tara.durum === 'arandi'
      ? await ozetGonder(ayar, { depo, postaGonder, simdi, env, hesap })
      : { durum: 'atlandi' };
    sonuclar.push({ user_id: ayar.user_id, tara, ozet });
    if (tara.durum === 'hata' || ozet.durum === 'hata' || ozet.durum === 'gonderilemedi') {
      log.warn?.(`[bot] ${ayar.user_id}: arama ${tara.durum}${tara.hata ? ` (${tara.hata})` : ''}, ozet ${ozet.durum}${ozet.hata ? ` (${ozet.hata})` : ''}`);
    }
  }
  if (liste.length) {
    const say = (f) => sonuclar.filter(f).length;
    log.info?.(`[bot] tur: ${liste.length} kullanici, ${say((s) => s.tara.durum === 'arandi')} arandi, `
      + `${sonuclar.reduce((a, s) => a + (s.tara.eklenen || 0), 0)} yeni ilan, ${say((s) => s.ozet.durum === 'gonderildi')} e-posta`);
  }
  return sonuclar;
}

let _calisiyor = false;
function zamanlayiciBaslat(log = console, { depo = require('./bot-depo'), postaGonder = require('./mailer').sendMail, env = process.env } = {}) {
  if (String(env.BOT_ZAMANLAYICI || '').toLowerCase() === 'kapali') return null;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const calis = async () => {
    if (_calisiyor) return;          // onceki tur bitmediyse ust uste binme
    _calisiyor = true;
    try { await turCalistir({ depo, postaGonder, env, log }); }
    catch (e) { log.error?.(`[bot] tur hatasi: ${e && e.message}`); }
    finally { _calisiyor = false; }
  };
  const ilk = setTimeout(calis, 60 * 1000);
  const t = setInterval(calis, TUR_MS);
  if (ilk.unref) ilk.unref();
  if (t.unref) t.unref();
  return t;
}

function _sifirla() { adzunaSayaci._sifirla(); epostaKota._sifirla(); _calisiyor = false; }

module.exports = {
  kullaniciTara, ozetGonder, turCalistir, zamanlayiciBaslat, satirlaraCevir, ilanAnahtari,
  ARALIK_MS, HATA_BEKLE_MS, OZET_ARALIK_MS, TUR_MS, TUR_BASINA, _sifirla,
};
