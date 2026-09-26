/**
 * server/lib/anthropic.js
 * Thin wrapper around the Anthropic Messages API using Node 20 native fetch.
 * Bypasses the @anthropic-ai/sdk and its bundled node-fetch,
 * which causes ECONNRESET on Windows.
 */

'use strict';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VER = '2023-06-01';

function getKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  return key;
}

/**
 * Send a non-streaming message to Claude.
 *
 * @param {object} opts
 * @param {string} opts.model
 * @param {number} opts.max_tokens
 * @param {string} [opts.system]
 * @param {Array}  opts.messages
 * @returns {Promise<string>} content text
 */
/**
 * Tek seferlik mesaj.
 *
 * `ustveri` istege bagli bir CIKTI nesnesi: verilirse yanitin nasil bittigi
 * doldurulur. Neden var: `stop_reason` atiliyordu ve cagiran, cevabin
 * KESILDIGINI bilemiyordu. 18 Eylul 2026'da ATS puani sayfasinda bunun
 * bedeli olculdu: Turkce cevap 900 token butcesini asiyor, JSON yarim
 * kaliyor, ayristirma basarisiz oluyor ve kullaniciya "model puan veremedi"
 * deniyordu. Oysa model puani vermisti, cumlenin ortasinda kesilmisti.
 * Ikisi ayri hata ve kullaniciya soylenecek sey de ayri.
 *
 * Ikinci parametre oldugu icin mevcut butun cagiranlar aynen calisir.
 */
async function createMessage({ model, max_tokens, system, messages }, ustveri) {
  const body = { model, max_tokens, messages };
  if (system) body.system = system;

  const response = await fetch(API_URL, {
    method:  'POST',
    headers: {
      'x-api-key':         getKey(),
      'anthropic-version': API_VER,
      'content-type':      'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`Anthropic API ${response.status}: ${err}`);
  }

  const data = await response.json();
  if (ustveri && typeof ustveri === 'object') {
    ustveri.stop_reason  = data.stop_reason ?? null;
    ustveri.kesildi      = data.stop_reason === 'max_tokens';
    ustveri.cikti_token  = data.usage?.output_tokens ?? null;
    ustveri.girdi_token  = data.usage?.input_tokens ?? null;   // altin test seti maliyet olcumu (K61)
  }
  return data.content?.[0]?.text ?? '';
}

/**
 * Stream tokens from Claude via the Anthropic SSE API.
 *
 * Calls onToken(text) for each text delta as it arrives.
 * Returns the complete accumulated text when the stream finishes.
 *
 * @param {object}   opts
 * @param {string}   opts.model
 * @param {number}   opts.max_tokens
 * @param {string}   [opts.system]
 * @param {Array}    opts.messages
 * @param {Function} [opts.onToken]  — called with each text chunk
 * @returns {Promise<string>} full response text
 */
async function streamMessage({ model, max_tokens, system, messages, onToken }) {
  const body = { model, max_tokens, messages, stream: true };
  if (system) body.system = system;

  const response = await fetch(API_URL, {
    method:  'POST',
    headers: {
      'x-api-key':         getKey(),
      'anthropic-version': API_VER,
      'content-type':      'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`Anthropic API ${response.status}: ${err}`);
  }

  // ── Read SSE stream ────────────────────────────────────────────────────────
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buf  = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });

    // Process complete lines
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete last line for next chunk

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const json = line.slice(6).trim();
      if (!json || json === '[DONE]') continue;

      let evt;
      try { evt = JSON.parse(json); } catch { continue; }

      if (
        evt.type === 'content_block_delta' &&
        evt.delta?.type === 'text_delta'
      ) {
        const text = evt.delta.text ?? '';
        full += text;
        if (onToken && text) onToken(text);
      }
    }
  }

  return full;
}

module.exports = { createMessage, streamMessage };
