/**
 * server/lib/temizlik.js — Saklama surelerinin uygulanmasi (K94 Adim 4, 3 Ekim 2026).
 *
 * /privacy bu sureleri soyluyor; bu dosya o sozu tutuyor. Kullanicinin
 * 3 Ekim 2026 kararlari (DEVAM.md "Saklama sureleri KESINLESTI"):
 *   - Bot ilanlari 30 gun. Sonra icerik (baslik, sirket, konum, baglanti,
 *     kaynak) silinir; yalnizca kisa anahtar (ilan_anahtari = baslik|sirket|
 *     konum, kisisel veri degil) ve durum kalir ki ayni ilan "yeni" diye geri
 *     gelmesin. 90 gunde satir tamamen silinir.
 *     Basvurulan ilan Basvuru Takibi'nde AYRI kayit (ia_basvurular); ilan
 *     satiri silinince bot_ilan_id null olur, basvuru kalir.
 *   - Hata kayitlari: son gorulmesinden 90 gun sonra.
 *   - Pazarlama izni arsivi (K95): sil_sonra gecince (3 yil).
 *   - Donusum olcumu olaylari (K112): 180 gun.
 *
 * Gunde bir, TEMIZLIK_SAATI (UTC, varsayilan 9 = Vancouver gece 2) sonrasi.
 * Her adim bagimsiz: biri hata verirse digerleri yine calisir. Loga yalnizca
 * sayilar. Kapatma: TEMIZLIK_ZAMANLAYICI=kapali.
 */
'use strict';

const GUN_MS          = 24 * 60 * 60 * 1000;
const ILAN_ICERIK_GUN = 30;
const ILAN_IZ_GUN     = 90;
const HATA_GUN        = 90;
const OLAY_GUN        = 180;

// 30 gun sonra bosaltilan alanlar. ilan_anahtari, durum, bulundu, uygunluk kalir.
const BOS_ICERIK = { baslik: '', sirket: '', konum: '', link: '', kaynak: '', konum_kademe: null };

const once = (simdi, gun) => new Date(simdi.getTime() - gun * GUN_MS).toISOString();
const sayi = (r) => (Array.isArray(r?.data) ? r.data.length : 0);

async function adim(ad, is, log) {
  try {
    const r = await is();
    if (r && r.error) throw new Error(r.error.message);
    return r;
  } catch (e) {
    log.error?.(`[temizlik] ${ad} basarisiz: ${e && e.message}`);
    return null;
  }
}

/**
 * @returns {{ ilanSilindi: number|null, ilanBosaltildi: number|null, hataSilindi: number|null, izinSilindi: number|null, olaySilindi: number|null }}
 *          null = o adim basarisiz
 */
async function turCalistir({ sb, simdi = new Date(), log = console }) {
  const s = {};

  // 1. 90 gunu gecen ilan satirlari tamamen (once bu: bosaltmaya bosuna ugrasmasin)
  let r = await adim('ilan 90 gun', () => sb.from('ia_bot_ilanlari').delete().lt('bulundu', once(simdi, ILAN_IZ_GUN)).select('id'), log);
  s.ilanSilindi = r ? sayi(r) : null;

  // 2. 30 gunu gecen ilanlarin icerigi. Zaten bos olanlara her gun yeniden
  //    yazmamak icin iki gecis: basligi dolu olanlar, sonra baglantisi dolu kalanlar.
  const sinir = once(simdi, ILAN_ICERIK_GUN);
  const a = await adim('ilan 30 gun (baslik)', () => sb.from('ia_bot_ilanlari').update(BOS_ICERIK).lt('bulundu', sinir).neq('baslik', '').select('id'), log);
  const b = await adim('ilan 30 gun (baglanti)', () => sb.from('ia_bot_ilanlari').update(BOS_ICERIK).lt('bulundu', sinir).neq('link', '').select('id'), log);
  s.ilanBosaltildi = a && b ? sayi(a) + sayi(b) : null;

  // 3. Hata kayitlari: son gorulmesinden 90 gun sonra. last_seen bos kalmis
  //    eski bir satir varsa (tablo semasi repoda yok) olusturulma zamanina bakilir.
  const h = once(simdi, HATA_GUN);
  r = await adim('hata 90 gun', () => sb.from('ia_errors').delete().or(`last_seen.lt.${h},and(last_seen.is.null,created_at.lt.${h})`).select('id'), log);
  s.hataSilindi = r ? sayi(r) : null;

  // 4. Pazarlama izni arsivi: suresi dolanlar
  r = await adim('izin arsivi', () => sb.from('ia_izin_arsivi').delete().lt('sil_sonra', simdi.toISOString()).select('id'), log);
  s.izinSilindi = r ? sayi(r) : null;

  // 5. Donusum olcumu olaylari (K112): 180 gun
  r = await adim('olay 180 gun', () => sb.from('ia_olaylar').delete().lt('created_at', once(simdi, OLAY_GUN)).select('id'), log);
  s.olaySilindi = r ? sayi(r) : null;

  log.info?.({ ...s }, '[temizlik] tur bitti');
  return s;
}

function zamaniGeldiMi(simdi, sonGun, env = process.env) {
  const h = env.TEMIZLIK_SAATI;
  const saat = h !== undefined && h !== '' && Number.isFinite(Number(h)) ? Number(h) : 9;
  const d = new Date(simdi);
  return d.getUTCHours() >= saat && sonGun !== d.toISOString().slice(0, 10);
}

let _sonGun = null;
let _calisiyor = false;
function zamanlayiciBaslat(log = console, { env = process.env } = {}) {
  if (String(env.TEMIZLIK_ZAMANLAYICI || '').toLowerCase() === 'kapali') return null;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const calis = async () => {
    const simdi = new Date();
    if (_calisiyor || !zamaniGeldiMi(simdi, _sonGun, env)) return;
    _calisiyor = true;
    _sonGun = simdi.toISOString().slice(0, 10);
    try { await turCalistir({ sb: require('./bot-depo').getSupabase(), simdi, log }); }
    catch (e) { log.error?.(`[temizlik] tur hatasi: ${e && e.message}`); }
    finally { _calisiyor = false; }
  };
  const t = setInterval(calis, 15 * 60 * 1000);
  if (t.unref) t.unref();
  return t;
}

function _sifirla() { _sonGun = null; _calisiyor = false; }

module.exports = { turCalistir, zamaniGeldiMi, zamanlayiciBaslat, BOS_ICERIK, ILAN_ICERIK_GUN, ILAN_IZ_GUN, HATA_GUN, OLAY_GUN, _sifirla };
