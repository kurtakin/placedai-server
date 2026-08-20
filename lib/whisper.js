/**
 * server/lib/whisper.js
 * Transcribes audio using Groq Whisper (primary, ~300 ms) with
 * automatic fallback to OpenAI Whisper (~1500 ms) if Groq is unavailable.
 *
 * Uses Node 20 native fetch + FormData + File (no node-fetch dependency).
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ── Provider config ───────────────────────────────────────────────────────────
const PROVIDERS = [
  {
    name:    'Groq',
    url:     'https://api.groq.com/openai/v1/audio/transcriptions',
    model:   'whisper-large-v3-turbo',
    getKey:  () => process.env.GROQ_API_KEY,
  },
  {
    name:    'OpenAI',
    url:     'https://api.openai.com/v1/audio/transcriptions',
    model:   'whisper-1',
    getKey:  () => process.env.OPENAI_API_KEY,
  },
];

/**
 * Transcribe base64-encoded audio.
 * Tries Groq first (fast), falls back to OpenAI if Groq key is missing or fails.
 *
 * @param {string} base64   - base64-encoded audio data
 * @param {string} mimeType - e.g. "audio/webm;codecs=opus"
 * @returns {Promise<string>} transcript text
 */
async function transcribeBase64(base64, mimeType = 'audio/webm') {
  const buffer = Buffer.from(base64, 'base64');
  const ext    = mimeType.includes('wav')  ? 'wav'
               : mimeType.includes('ogg')  ? 'ogg'
               : mimeType.includes('mp4')  ? 'mp4'
               : 'webm';

  const tmpPath = path.join(
    os.tmpdir(),
    `ia_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
  );

  try {
    fs.writeFileSync(tmpPath, buffer);

    // Try each provider in order
    for (const provider of PROVIDERS) {
      const key = provider.getKey();
      if (!key) {
        console.log(`[whisper] ${provider.name}: no API key, skipping`);
        continue;
      }

      try {
        const t0      = Date.now();
        const text    = await callProvider(provider, tmpPath, ext, mimeType, key);
        console.log(`[whisper] ${provider.name}: ${Date.now() - t0} ms`);
        return text;
      } catch (err) {
        console.warn(`[whisper] ${provider.name} failed: ${err.message} — trying next provider`);
      }
    }

    throw new Error('All transcription providers failed. Set GROQ_API_KEY or OPENAI_API_KEY in .env');

  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
  }
}

// ── Internal: call a single provider ─────────────────────────────────────────
async function callProvider(provider, tmpPath, ext, mimeType, key) {
  const fileBuffer = fs.readFileSync(tmpPath);
  const file       = new File([fileBuffer], `audio.${ext}`, { type: mimeType });

  const formData = new FormData();
  formData.append('file',            file);
  formData.append('model',           provider.model);
  formData.append('language',        'en');
  formData.append('response_format', 'json');
  formData.append('prompt',
    'Interview question about professional experience, STAR method, business outcomes.'
  );

  const response = await fetch(provider.url, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${key}` },
    body:    formData,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`${provider.name} ${response.status} ${response.statusText}: ${errBody}`);
  }

  const data = await response.json();
  return (data.text ?? '').trim();
}

module.exports = { transcribeBase64 };
