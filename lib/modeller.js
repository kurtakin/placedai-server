/**
 * server/lib/modeller.js — TEK MODEL KAYDI (26 Eylul 2026, yol haritasi: model yonetimi, adim 1)
 *
 * NEDEN. Kullanicinin sorusu: "Her gun yeni AI modeli cikiyor; bizimkiler nasil
 * guncel kalacak?" Karar (DEVAM.md): yazilim modeli KENDI KENDINE degistirmez,
 * yeni modeli fark edip haber verir; gecis olculup onayla yapilir. Bunun ilk
 * sarti, hangi gorevin hangi modeli kullandiginin TEK bir yerde durmasi ve
 * her birinin kod degismeden (ortam degiskeniyle) degistirilip geri
 * alinabilmesi. Rotalar model KIMLIGI degil KATMAN adi kullanir
 * ('claude-haiku' = hizli, 'claude-sonnet' = guclu); kimlik burada cozulur.
 *
 * IZINLI LISTE. Eskiden istemcinin gonderdigi herhangi bir model adi oldugu
 * gibi saglayiciya gidiyordu: arayuzde olmayan pahali bir modeli dogrudan
 * istekle secmek mumkundu (maliyet acigi). Artik yalnizca asagidaki takma
 * adlar kabul edilir; bilinmeyen ad hizli katmana duser.
 *
 * Ses tanima (REALTIME_STT_MODEL, routes/stt.js), mulakatci sesi
 * (MOCK_TTS_MODEL, routes/mock.js) ve Groq (GROQ_MODEL, lib/groq.js) zaten
 * kendi ortam degiskenleriyle ayarlanabiliyor; ozet() hepsini tek yerde
 * gosterir (adim 2'deki model takibi ve adim 3'teki olcum bunu kullanacak).
 */

'use strict';

const ortam = (ad, varsayilan) => {
  const d = process.env[ad];
  return typeof d === 'string' && d.trim() ? d.trim() : varsayilan;
};

/** Katmanlar: her biri bir ortam degiskeniyle degistirilebilir. */
function katmanlar() {
  return {
    hizli: ortam('MODEL_HIZLI', 'claude-haiku-4-5-20251001'),   // canli ipucu, kisa uretimler
    guclu: ortam('MODEL_GUCLU', 'claude-sonnet-4-6'),           // belge, geri bildirim, analiz
  };
}

/**
 * Istemcinin ve rotalarin kullanabilecegi takma adlar -> gercek kimlik.
 * Ayarlar sayfasindaki secicilerle ayni liste (index.html #model-aid, #model-docs).
 */
function takmaAdlar() {
  const k = katmanlar();
  return {
    'claude-haiku':  k.hizli,
    'claude-sonnet': k.guclu,
    'gpt-4o-mini':   ortam('MODEL_GPT_HIZLI', 'gpt-4o-mini'),
    'gpt-4o':        ortam('MODEL_GPT_GUCLU', 'gpt-4o'),
    'gpt-4.1-mini':  'gpt-4.1-mini',
    'gpt-4.1':       'gpt-4.1',
  };
}

/**
 * Takma adi gercek kimlige cevirir. Izinli listede olmayan her deger
 * (bos, bilinmeyen, dogrudan kimlik) hizli katmana duser.
 */
function modelCoz(ad) {
  const t = takmaAdlar();
  return Object.prototype.hasOwnProperty.call(t, ad) ? t[ad] : t['claude-haiku'];
}

/** Hangi gorev hangi modeli kullaniyor: tek bakista (izleme ve olcum icin). */
function ozet() {
  return {
    ...takmaAdlar(),
    ses_tanima: ortam('REALTIME_STT_MODEL', 'gpt-4o-transcribe'),
    seslendirme: ortam('MOCK_TTS_MODEL', 'gpt-4o-mini-tts'),
    groq: ortam('GROQ_MODEL', '(otomatik secim)'),
  };
}

module.exports = { katmanlar, takmaAdlar, modelCoz, ozet };
