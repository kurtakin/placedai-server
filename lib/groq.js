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

// Kısa çıktı için en hızlısı; alias'lar rota kodunu model adına bağımlı kılmasın
const MODELS = {
  'groq-fast':     'llama-3.1-8b-instant',
  'groq-balanced': 'llama-3.3-70b-versatile',
};

function isConfigured() {
  return !!process.env.GROQ_API_KEY;
}

function resolve(model) {
  return MODELS[model] || model || MODELS['groq-fast'];
}

async function createMessage({ model, max_tokens, system, messages, temperature }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY is not set');

  const body = {
    model:       resolve(model),
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

module.exports = { createMessage, isConfigured, MODELS };
