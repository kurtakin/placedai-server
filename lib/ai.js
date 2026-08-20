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

// Default models per provider
const DEFAULT_CLAUDE = 'claude-haiku-4-5-20251001';
const DEFAULT_GPT    = 'gpt-4o-mini';

// OpenAI model prefixes
const OAI_PREFIXES = ['gpt-', 'o1', 'o3'];

function isOpenAI(model) {
  if (!model) return false;
  return OAI_PREFIXES.some(p => model.startsWith(p));
}

/**
 * Resolve model alias to actual API model string.
 * 'claude-haiku' → 'claude-haiku-4-5-20251001'
 * 'claude-sonnet' → 'claude-sonnet-4-6'
 * 'gpt-4o' → 'gpt-4o' (pass-through)
 */
function resolveModel(model) {
  const aliases = {
    'claude-haiku':  'claude-haiku-4-5-20251001',
    'claude-sonnet': 'claude-sonnet-4-6',
    'claude-opus':   'claude-opus-4-6',
    'gpt-4o':        'gpt-4o',
    'gpt-4o-mini':   'gpt-4o-mini',
    'gpt-4.1':       'gpt-4.1',
    'gpt-4.1-mini':  'gpt-4.1-mini',
  };
  return aliases[model] || model || DEFAULT_CLAUDE;
}

async function createMessage(opts) {
  const model = resolveModel(opts.model);
  if (isOpenAI(model)) {
    return openaiLib.createMessage({ ...opts, model });
  }
  return anthropic.createMessage({ ...opts, model });
}

async function streamMessage(opts) {
  const model = resolveModel(opts.model);
  if (isOpenAI(model)) {
    return openaiLib.streamMessage({ ...opts, model });
  }
  return anthropic.streamMessage({ ...opts, model });
}

module.exports = { createMessage, streamMessage, resolveModel, isOpenAI, DEFAULT_CLAUDE, DEFAULT_GPT };
