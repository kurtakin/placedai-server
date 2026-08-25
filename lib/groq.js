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
const PREFERRED = [
  'llama-3.1-8b-instant',      // en küçük/en hızlı
  'openai/gpt-oss-20b',
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-120b',
];

let _model      = null;   // seçilen model
let _modelAt    = 0;      // ne zaman seçildi
const MODEL_TTL = 6 * 60 * 60 * 1000;

function isConfigured() {
  return !!process.env.GROQ_API_KEY;
}

/** Hesapta açık olan en hızlı metin modelini seç (6 saat önbellek). */
async function pickModel() {
  if (_model && Date.now() - _modelAt < MODEL_TTL) return _model;

  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Groq /models ${res.status}`);

  const data      = await res.json();
  const available = (data.data || []).map(m => m.id);

  _model = PREFERRED.find(m => available.includes(m))
        // tercihlerin hiçbiri yoksa: whisper/tts olmayan ilk model
        || available.find(m => !/whisper|tts|guard|playai/i.test(m))
        || null;

  if (!_model) throw new Error(`No usable Groq text model. Available: ${available.slice(0, 12).join(', ')}`);
  _modelAt = Date.now();
  console.log(`[groq] using model: ${_model}`);
  return _model;
}

async function createMessage({ model, max_tokens, system, messages, temperature }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY is not set');

  const body = {
    model:       model && model !== 'groq-fast' ? model : await pickModel(),
    max_tokens:  max_tokens ?? 80,
    temperature: temperature ?? 0.3,
    messages:    system ? [{ role: 'system', content: system }, ...messages] : messages,
  };

  const res = await fetch(GROQ_URL, {
    method:  'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Groq API ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

module.exports = { createMessage, isConfigured, pickModel };
