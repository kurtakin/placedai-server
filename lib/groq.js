/**
 * server/lib/groq.js — Groq (OpenAI uyumlu) istemcisi
 *
 * Neden ayrı bir sağlayıcı: Groq'un ilk token süresi tipik olarak 150–300 ms.
 * Mülakat sırasında ekranda beliren üç ip ucu için gereken tek şey bu —
 * cevabın tamamı daha kaliteli bir modelde kalabilir.
 *
 * Anahtar zaten mevcut: GROQ_API_KEY (Whisper transkripsiyonu da bunu kullanıyor).
 */

'use strict';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Model adlarını sabitlemiyoruz: Groq katalogu değişiyor ve her hesapta her
// model açık değil. Hesabın gerçekten erişebildiklerini bir kez sorup
// tercih sırasına göre seçiyoruz.
// 5 Eylul 2026'da olculdu: bu listenin ilk ve ucuncu maddesi Groq katalogunda
// ARTIK YOK. Sira sessizce openai/gpt-oss-20b'ye dusmustu, o da bir akil
// yurutme modeli, ve uc sorunun ikisinde su cevabi donduruyordu:
//   "I'm sorry, but I don't have the candidate's profile to generate cues."
// Yani hizli yol calismiyordu ve kimse fark etmiyordu. Iki ders:
//   1. Sabit liste bayatliyor. Asagidaki secim artik akil yurutmeyen modelleri
//      ONCE deniyor, liste yine bayatlarsa bile akil yurutme modeline
//      dusmuyoruz.
//   2. GROQ_MODEL ortam degiskeni ile deploy yapmadan model degistirilebilir.
const PREFERRED = [
  'llama-3.1-8b-instant',      // katalogda varsa en hizlisi
  'qwen/qwen3.6-27b',
  'qwen/qwen3.8-27b',
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-20b',        // akil yurutme: ancak baska secenek yoksa
  'openai/gpt-oss-120b',
];

// Metin uretmeyen modeller: ses, guvenlik siniflandirici, konusma sentezi.
const NOT_TEXT = /whisper|tts|guard|playai|orpheus|safeguard/i;

let _model      = null;   // seçilen model
let _available  = [];     // hesapta açık olanlar (teşhis için)
let _modelAt    = 0;      // ne zaman seçildi
const MODEL_TTL = 6 * 60 * 60 * 1000;

function isReasoning(model) {
  return /gpt-oss|reason/i.test(String(model));
}

/**
 * Model dusunme (thinking) uretebiliyor mu?
 *
 * isReasoning'den ayri, cunku ikisi farkli sey soruyor:
 *   isReasoning  - model SECIMINDE kacinilacak mi
 *   isThinking   - istege dusunmeyi kapatan parametre eklenecek mi
 *
 * 9 Eylul 2026'da uretimde olculdu: qwen/qwen3.6-27b bir dusunen model ve
 * isReasoning onu tanimiyordu. Cikti "<think> / Here's a thinking process:"
 * seklinde geliyor, 60 token butcesinin tamami dusunmeye gidiyor
 * (cikis_tok her koside 60) ve gercek cevaba hic sira gelmiyordu.
 * Kullanicinin ekraninda ipucu yerine bu yaziyordu.
 *
 * Modelden kacinamiyoruz: Groq katalogunda duz metin modeli KALMADI.
 * llama-3.1-8b-instant ve llama-3.3-70b-versatile dusmus; geriye gpt-oss
 * (dusunen), qwen3 (dusunen), compound (ajan), allam (Arapca odakli) ve
 * whisper/orpheus/guard (metin modeli degil) kaliyor. Yani tek yol
 * dusunmeyi KAPATMAK.
 */
function isThinking(model) {
  return /qwen3|gpt-oss|reason/i.test(String(model));
}

/**
 * Dusunmeyi kapatan parametre model ailesine gore degisiyor.
 *   qwen3    -> reasoning_effort: 'none'    (Groq'ta qwen3 icin gecerli)
 *   gpt-oss  -> reasoning_effort: 'low'     (none kabul etmiyor)
 * Bilinmeyen aileye parametre gondermiyoruz: gecersiz parametre 400 verir
 * ve /cues tamamen coker.
 */
function dusunmeAyari(model) {
  const m = String(model);
  if (/qwen3/i.test(m))   return 'none';
  if (/gpt-oss/i.test(m)) return 'low';
  return null;
}

function isConfigured() {
  return !!process.env.GROQ_API_KEY;
}

/** Hesapta açık olan en hızlı metin modelini seç (6 saat önbellek). */
async function pickModel() {
  // Elle secim: katalog yine degisirse deploy beklemeden mudahale edilebilsin.
  if (process.env.GROQ_MODEL) {
    if (_model !== process.env.GROQ_MODEL) {
      _model = process.env.GROQ_MODEL;
      _modelAt = Date.now();
      console.log(`[groq] GROQ_MODEL ile sabitlendi: ${_model}`);
    }
    return _model;
  }

  if (_model && Date.now() - _modelAt < MODEL_TTL) return _model;

  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Groq /models ${res.status}`);

  const data      = await res.json();
  const available = (data.data || []).map(m => m.id);
  _available = available;

  const usable = available.filter(m => !NOT_TEXT.test(m));

  // Sira: tercih listesindeki akil yurutmeyenler -> katalogdaki diger
  // akil yurutmeyenler -> tercih listesindeki akil yurutenler -> kalan her sey.
  // Akil yurutme modeli son care: dusunme token'lari butceden cikiyor ve dar
  // bir gorevde ("uc ip ucu yaz") cevap vermeyi tamamen reddedebiliyor.
  _model = PREFERRED.find(m => usable.includes(m) && !isReasoning(m))
        || usable.find(m => !isReasoning(m))
        || PREFERRED.find(m => usable.includes(m))
        || usable[0]
        || null;

  if (!_model) throw new Error(`No usable Groq text model. Available: ${available.slice(0, 12).join(', ')}`);
  _modelAt = Date.now();
  console.log(`[groq] using model: ${_model}`);
  return _model;
}

async function createMessage({ model, max_tokens, system, messages, temperature, onMeta }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY is not set');

  const chosen = model && model !== 'groq-fast' ? model : await pickModel();

  const ayar = dusunmeAyari(chosen);
  // Dusunme kapaliysa dar butce yeterli ve hizli kalir. Acik kalirsa
  // dusunme token'lari da ayni butceden cikiyor ve dar sinir icerigi
  // tamamen yutuyor - o durumda butceyi acmak sart.
  const dusunmeAcik = isThinking(chosen) && ayar !== 'none';

  const body = {
    model:       chosen,
    max_tokens:  dusunmeAcik ? Math.max(max_tokens ?? 80, 300) : (max_tokens ?? 80),
    temperature: temperature ?? 0.3,
    messages:    system ? [{ role: 'system', content: system }, ...messages] : messages,
  };
  if (ayar) body.reasoning_effort = ayar;

  const gonder = (govde) => fetch(GROQ_URL, {
    method:  'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(govde),
  });

  let res = await gonder(body);

  // Groq katalogu degisiyor ve reasoning_effort'un gecerli degerleri modele
  // gore farkli. Parametre reddedilirse istegi tamamen kaybetmek yerine
  // parametresiz tekrar deniyoruz: dusunme metni gelir ama parseCues onu
  // zaten eliyor, yani sonuc "yavas ama dogru" olur, "coktu" degil.
  if (res.status === 400 && ayar) {
    const ilkHata = await res.text().catch(() => '');
    console.warn('[groq] reasoning_effort reddedildi, parametresiz tekrar deneniyor:',
      String(ilkHata).slice(0, 160));
    const { reasoning_effort, ...parametresiz } = body;
    parametresiz.max_tokens = Math.max(max_tokens ?? 80, 300);
    res = await gonder(parametresiz);
  }

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Groq API ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();

  // Groq kendi zamanlamasini `usage` icinde donuyor: queue_time, prompt_time,
  // completion_time, total_time (saniye). Bunu atmak, sunucudaki sureyi tek
  // parca birakiyordu ve "Groq mu yavas, aradaki ag mi?" sorusu cevapsiz
  // kaliyordu. Bolge kararini (G21) tam olarak bu ayrim belirliyor.
  //
  // Geri donus tipi degismiyor: cagiran isterse onMeta ile alir, istemezse
  // hicbir sey degismez.
  if (typeof onMeta === 'function') {
    const u = data.usage || {};
    try {
      onMeta({
        model:      chosen,
        groq_ms:    u.total_time      != null ? Math.round(u.total_time * 1000)      : null,
        kuyruk_ms:  u.queue_time      != null ? Math.round(u.queue_time * 1000)      : null,
        prompt_ms:  u.prompt_time     != null ? Math.round(u.prompt_time * 1000)     : null,
        uretim_ms:  u.completion_time != null ? Math.round(u.completion_time * 1000) : null,
        giris_tok:  u.prompt_tokens     ?? null,
        cikis_tok:  u.completion_tokens ?? null,
      });
    } catch (e) { /* olcum asla istegi bozmasin */ }
  }

  const msg  = data.choices?.[0]?.message ?? {};
  // Reasoning modellerinde içerik boş kalıp cevap `reasoning` alanına düşebiliyor
  return (msg.content && msg.content.trim()) ? msg.content : (msg.reasoning || '');
}

/** Teşhis: hangi model seçildi, hesapta neler açık. */
function diagnostics() {
  return { model: _model, available: _available.slice(0, 20) };
}

module.exports = { createMessage, isConfigured, pickModel, diagnostics, isThinking, dusunmeAyari };
