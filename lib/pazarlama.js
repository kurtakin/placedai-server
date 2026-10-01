'use strict';

/**
 * server/lib/pazarlama.js — Pazarlama (teklif / kampanya) e-postasi izni ve
 * e-posta alt bilgisi (K87, 1 Ekim 2026; 6. adimin 6a parcasi).
 *
 * Kullanicinin kararlari (DEVAM.md K87):
 *  * Teklif e-postasi YALNIZCA acik izinle (Kanada CASL). Ucretsiz hesap acmak
 *    tek basina izin sayilmaz. Izin kutusu her yerde ISARETSIZ.
 *  * Kanit: zaman, kaynak (kayit / serit / ayarlar / eposta), metin surumu.
 *    IP adresi saklanmaz.
 *  * Her pazarlama e-postasinda tek tikla cikis + gonderenin adi + posta
 *    adresi. POSTA_ADRESI (Railway) tanimli degilse HICBIR pazarlama e-postasi
 *    gitmez: PO Box alinmadan kampanya fiilen baslayamaz.
 *  * Izin ISTEMEK de posta adresine bagli: istekte gonderenin adi, posta
 *    adresi ve iletisim bilgisi bulunmali (SOR/2012-36 m.4). POSTA_ADRESI
 *    yoksa kayit kutusu, panel seridi ve ayarlardaki "ac" gorunmez.
 *  * Izin istemek icin e-posta ATILMAZ (CASL onu da ticari ileti sayar);
 *    mevcut uyelere panelde bir kez serit gosterilir.
 *
 * Tablo: ia_eposta_tercihleri (K85) + supabase/k87-pazarlama-izni.sql.
 */

const { getSupabase } = require('./bot-depo');
const imza = require('./eposta-imza');

// Kullaniciya gosterilen izin metni. DEGISIRSE surumu artir (eski izinler
// hangi metinle verildiyse o surumle kayitli kalir). Web'deki metinler bununla
// AYNI olmali (tests/pazarlama-istemci.test.js karsilastirir).
const METIN_SURUMU = 'p1';
const IZIN_METNI = 'Email me offers and product news from PlacedAI. I can unsubscribe at any time.';
const KAYNAKLAR = Object.freeze(['kayit', 'serit', 'ayarlar', 'eposta']);
// Kullanicinin istekle verebilecegi kaynaklar ('eposta' yalnizca imzali cikis, 'kayit' yalnizca kayit verisinden).
const ISTEK_KAYNAKLARI = Object.freeze(['serit', 'ayarlar']);
const TABLO = 'ia_eposta_tercihleri';
const ALANLAR = 'pazarlama,pazarlama_zamani,pazarlama_kaynak,pazarlama_surum';

function sb() {
  const s = getSupabase();
  if (!s) { const e = new Error('Supabase tanimli degil'); e.supabaseYok = true; throw e; }
  return s;
}
function sonuc({ data, error }) {
  if (error) throw new Error(error.message || String(error));
  return data;
}

/**
 * Kayit sirasinda verilen karar (user_metadata.pazarlama), bicimi dogruysa.
 * Kayit sayfasi {izin, zaman, surum} yazar; baska sekil yok sayilir.
 */
function kayitKarari(user) {
  const m = user && user.user_metadata && user.user_metadata.pazarlama;
  if (!m || typeof m !== 'object' || typeof m.izin !== 'boolean') return null;
  const zaman = typeof m.zaman === 'string' && !isNaN(Date.parse(m.zaman)) ? new Date(m.zaman).toISOString() : null;
  const surum = typeof m.surum === 'string' && /^p\d{1,3}$/.test(m.surum) ? m.surum : null;
  if (m.izin && (!zaman || !surum)) return null; // kanitsiz izin sayilmaz
  return { izin: m.izin, zaman, surum };
}

/**
 * Tablodaki satir varsa o gecerli (en son karar); yoksa kayit sirasindaki karar.
 * @returns {{izin: boolean, karar_verildi: boolean, kaynak: string|null, zaman: string|null, surum: string|null}}
 */
function izinDurumu(satir, user) {
  if (satir && satir.pazarlama_kaynak) {
    return { izin: satir.pazarlama === true, karar_verildi: true, kaynak: satir.pazarlama_kaynak,
      zaman: satir.pazarlama_zamani || null, surum: satir.pazarlama_surum || null };
  }
  const k = kayitKarari(user);
  if (k) return { izin: k.izin, karar_verildi: true, kaynak: 'kayit', zaman: k.zaman, surum: k.surum };
  return { izin: false, karar_verildi: false, kaynak: null, zaman: null, surum: null };
}

async function satirOku(userId) {
  return sonuc(await sb().from(TABLO).select(ALANLAR).eq('user_id', userId).maybeSingle()) || null;
}

/** Karari yazar (kanitla). zaman verilmezse simdi. */
async function kararYaz(userId, izin, kaynak, { zaman = null, surum = METIN_SURUMU } = {}) {
  if (!KAYNAKLAR.includes(kaynak)) throw new Error(`gecersiz kaynak: ${kaynak}`);
  const satir = {
    user_id: userId, pazarlama: izin === true,
    pazarlama_zamani: zaman || new Date().toISOString(), pazarlama_kaynak: kaynak, pazarlama_surum: surum || METIN_SURUMU,
  };
  sonuc(await sb().from(TABLO).upsert(satir, { onConflict: 'user_id' }));
  return satir;
}

/**
 * Kullanicinin durumu. Kayitta karar verilmis ama tabloda yoksa tabloya
 * tasinir (kanit tek yerde dursun; gonderici tabloyu okur).
 */
async function durumOku(user) {
  const satir = await satirOku(user.id);
  const d = izinDurumu(satir, user);
  if (d.karar_verildi && !(satir && satir.pazarlama_kaynak)) {
    await kararYaz(user.id, d.izin, 'kayit', { zaman: d.zaman, surum: d.surum || METIN_SURUMU });
  }
  return d;
}

/** Pazarlama e-postasi gonderilebilir mi (posta adresi tanimli mi)? */
function gonderilebilir(env = process.env) {
  return Boolean(String(env.POSTA_ADRESI || '').trim());
}

/**
 * Izin isteginde gosterilmesi ZORUNLU gonderen bilgisi (CRTC Elektronik Ticaret
 * Yonetmeligi SOR/2012-36 m.4: ad, posta adresi, e-posta/telefon/web, geri
 * alinabilecegi). Posta adresi yoksa null: izin ISTENMEZ (kayit kutusu, panel
 * seridi ve ayarlardaki "ac" gizlenir); izni geri almak her zaman mumkun.
 */
function gonderen(env = process.env) {
  if (!gonderilebilir(env)) return null;
  return {
    ad: String(env.SIRKET_ADI || 'PlacedAI').trim(),
    adres: String(env.POSTA_ADRESI).trim(),
    iletisim: String(env.ILETISIM_EPOSTA || 'info@placedai.app').trim(),
  };
}

/**
 * Pazarlama e-postasinin alt bilgisi: gonderen, posta adresi, iletisim, cikis.
 * POSTA_ADRESI yoksa ya da cikis baglantisi uretilemezse null: gonderilmez.
 */
function altBilgi(userId, env = process.env) {
  const g = gonderen(env);
  if (!g) return null;
  const link = imza.kapatmaLinki(userId, 'pazarlama', env, 'eposta');
  if (!link) return null;
  const { ad: gonderenAd, adres, iletisim } = g;
  const text = [
    '--',
    `You are getting this because you agreed to receive offers from ${gonderenAd}.`,
    `${gonderenAd}, ${adres}. Contact: ${iletisim}`,
    `Unsubscribe: ${link}`,
  ].join('\n');
  const k = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = '<hr style="border:0;border-top:1px solid #ddd;margin:24px 0 12px">'
    + `<p style="font-size:12px;color:#666;line-height:1.5">You are getting this because you agreed to receive offers from ${k(gonderenAd)}.<br>`
    + `${k(gonderenAd)}, ${k(adres)}. Contact: <a href="mailto:${k(iletisim)}">${k(iletisim)}</a><br>`
    + `<a href="${k(link)}">Unsubscribe</a></p>`;
  return { text, html, link, headers: { 'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
}

module.exports = {
  METIN_SURUMU, IZIN_METNI, KAYNAKLAR, ISTEK_KAYNAKLARI,
  kayitKarari, izinDurumu, satirOku, kararYaz, durumOku, gonderilebilir, gonderen, altBilgi,
};
