/**
 * server/lib/ai.js — Unified AI dispatcher
 *
 * Routes to Anthropic or OpenAI based on the model parameter.
 * OpenAI models: 'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'
 * Claude models : 'claude-haiku', 'claude-sonnet', 'claude-haiku-4-5-20251001', etc.
 *
 * Usage:
 *   const { createMessage, streamMessage } = require('../lib/ai');
 *   await streamMessage({ model: 'gpt-4o', ... });   // → OpenAI
 *   await streamMessage({ model: 'claude-haiku', ... });  // → Anthropic
 */

'use strict';

const anthropic  = require('./anthropic');
const openaiLib  = require('./openai-stream');
const { modelCoz, takmaAdlar } = require('./modeller');

// Varsayilanlar artik lib/modeller.js'te (tek model kaydi); ortam degiskeniyle
// degistirilebilir. Bu iki ad eski cagiranlar kirilmasin diye duruyor.
const DEFAULT_CLAUDE = takmaAdlar()['claude-haiku'];
const DEFAULT_GPT    = takmaAdlar()['gpt-4o-mini'];

// OpenAI model prefixes
const OAI_PREFIXES = ['gpt-', 'o1', 'o3'];

function isOpenAI(model) {
  if (!model) return false;
  return OAI_PREFIXES.some(p => model.startsWith(p));
}

/**
 * Takma adi gercek model kimligine cevirir (lib/modeller.js).
 * 26 Eylul 2026: eskiden bilinmeyen ad oldugu gibi gidiyordu; istemci
 * arayuzde olmayan pahali bir modeli istekle secebiliyordu. Artik izinli
 * liste disindaki her deger hizli katmana duser. 'claude-opus' takma adi
 * hicbir yerde kullanilmiyordu ve arayuzde yoktu; kaldirildi.
 */
function resolveModel(model) {
  return modelCoz(model);
}

// `ustveri` istege bagli cikti nesnesi; iki saglayicida da ayni alanlarla
// doldurulur: { stop_reason, kesildi, cikti_token }.
async function createMessage(opts, ustveri) {
  const model = resolveModel(opts.model);
  if (isOpenAI(model)) {
    return openaiLib.createMessage({ ...opts, model }, ustveri);
  }
  return anthropic.createMessage({ ...opts, model }, ustveri);
}

async function streamMessage(opts) {
  const model = resolveModel(opts.model);
  if (isOpenAI(model)) {
    return openaiLib.streamMessage({ ...opts, model });
  }
  return anthropic.streamMessage({ ...opts, model });
}

module.exports = { createMessage, streamMessage, resolveModel, isOpenAI, DEFAULT_CLAUDE, DEFAULT_GPT };
