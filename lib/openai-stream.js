/**
 * server/lib/openai-stream.js
 * Thin wrapper around the OpenAI Chat Completions API (native fetch, streaming).
 * Compatible drop-in alongside server/lib/anthropic.js
 */

'use strict';

const OAI_URL = 'https://api.openai.com/v1/chat/completions';

function getKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set');
  return key;
}

/**
 * Map model alias → actual API model name
 */
const MODEL_MAP = {
  'claude-haiku':   null,                    // handled by anthropic.js
  'claude-sonnet':  null,
  'gpt-4o':         'gpt-4o',
  'gpt-4o-mini':    'gpt-4o-mini',
  'gpt-4.1':        'gpt-4.1',
  'gpt-4.1-mini':   'gpt-4.1-mini',
  'gemini':         null,                    // future
};

/**
 * Non-streaming OpenAI call.
 */
async function createMessage({ model, max_tokens, system, messages }) {
  const oaiMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;

  const body = { model, max_tokens, messages: oaiMessages };

  const response = await fetch(OAI_URL, {
    method:  'POST',
    headers: {
      Authorization:   `Bearer ${getKey()}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`OpenAI API ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? '';
}

/**
 * Streaming OpenAI call. Calls onToken(text) for each delta.
 */
async function streamMessage({ model, max_tokens, system, messages, onToken }) {
  const oaiMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;

  const body = { model, max_tokens, messages: oaiMessages, stream: true };

  const response = await fetch(OAI_URL, {
    method:  'POST',
    headers: {
      Authorization:   `Bearer ${getKey()}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`OpenAI API ${response.status}: ${err}`);
  }

  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buf  = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });

    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const json = line.slice(6).trim();
      if (!json || json === '[DONE]') continue;

      let evt;
      try { evt = JSON.parse(json); } catch { continue; }

      const text = evt.choices?.[0]?.delta?.content ?? '';
      if (text) {
        full += text;
        if (onToken) onToken(text);
      }
    }
  }

  return full;
}

module.exports = { createMessage, streamMessage, MODEL_MAP };
