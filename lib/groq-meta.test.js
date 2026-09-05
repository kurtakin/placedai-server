/**
 * lib/groq-meta.test.js — Groq'un kendi zamanlamasi kaydediliyor mu?
 *
 * Calistir: node --test lib/groq-meta.test.js
 *
 * Neden var: Groq yanitinda `usage` icinde queue_time / prompt_time /
 * completion_time / total_time geliyor. Bunlar atildiginda sunucudaki sure
 * tek parca kaliyor ve "Groq mu yavas, aradaki ag mi?" sorusu cevapsiz.
 *
 * Bu ayrim bir bolge kararini belirliyor (G21, 6 Eylul): kullanicidan
 * Railway'e gidis-donus 169 ms olculdu, en yakin CDN kenari 48 ms. Sunucuyu
 * kullaniciya yaklastirmak cazip - ama Groq ABD'deyse o hamle sunucu-Groq
 * bacagini uzatir ve kazanci yer. Karar `ms - groq_ms` farkina bakiyor.
 *
 * Olcum kaybolursa hicbir test dusmez ve karar yeniden tahmine doner.
 */
'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const groqSrc = fs.readFileSync(path.join(__dirname, 'groq.js'), 'utf8');
const aidSrc  = fs.readFileSync(path.join(__dirname, '..', 'routes', 'aid.js'), 'utf8');

test('createMessage onMeta parametresini kabul ediyor', () => {
  const imza = groqSrc.match(/async function createMessage\(\{([^}]*)\}/);
  assert.ok(imza, 'createMessage imzasi okunamadi');
  assert.match(imza[1], /\bonMeta\b/, 'createMessage onMeta almiyor');
});

// Kaynakta gecmesi yetmez: `if (false)` yazip da testi gecirmek mumkun.
// Bu yuzden gercekten CAGRILDIGINI davranisla dogruluyoruz: fetch sahte,
// Groq'un dondugu usage govdesi sabit, onMeta'nin aldigi deger olculuyor.
test('onMeta gercekten cagriliyor ve usage dogru ceviriliyor', async () => {
  const groq = require('./groq');
  const eskiFetch = globalThis.fetch;
  const eskiKey   = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'test-anahtari';

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'bir | iki | uc' } }],
      usage: {
        total_time: 0.284, queue_time: 0.031,
        prompt_time: 0.012, completion_time: 0.241,
        prompt_tokens: 372, completion_tokens: 18,
      },
    }),
  });

  let alinan = null;
  try {
    const metin = await groq.createMessage({
      model: 'llama-3.1-8b-instant', max_tokens: 60,
      messages: [{ role: 'user', content: 'x' }],
      onMeta: (m) => { alinan = m; },
    });
    assert.strictEqual(metin, 'bir | iki | uc', 'geri donus metni bozuldu');
  } finally {
    globalThis.fetch = eskiFetch;
    if (eskiKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = eskiKey;
  }

  assert.ok(alinan, 'onMeta hic cagrilmadi');
  // Saniye -> milisaniye cevrimi
  assert.strictEqual(alinan.groq_ms,   284, 'total_time ms cevrilmedi');
  assert.strictEqual(alinan.kuyruk_ms,  31, 'queue_time ms cevrilmedi');
  assert.strictEqual(alinan.uretim_ms, 241, 'completion_time ms cevrilmedi');
  assert.strictEqual(alinan.giris_tok, 372, 'prompt_tokens tasinmadi');
});

test('usage yoksa onMeta yine cagrilir, alanlar null olur', async () => {
  const groq = require('./groq');
  const eskiFetch = globalThis.fetch, eskiKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'test-anahtari';
  globalThis.fetch = async () => ({ ok: true,
    json: async () => ({ choices: [{ message: { content: 'a | b | c' } }] }) });
  let alinan = null;
  try {
    await groq.createMessage({ model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: 'x' }], onMeta: (m) => { alinan = m; } });
  } finally {
    globalThis.fetch = eskiFetch;
    if (eskiKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = eskiKey;
  }
  assert.ok(alinan, 'usage yokken onMeta cagrilmadi');
  assert.strictEqual(alinan.groq_ms, null, 'usage yokken groq_ms null olmali');
});

test('olcum istegi bozamaz: onMeta cagrisi try icinde', () => {
  const i = groqSrc.indexOf('onMeta({');
  assert.notStrictEqual(i, -1, 'onMeta cagrisi bulunamadi');
  const once = groqSrc.slice(0, i);
  const sonTry   = once.lastIndexOf('try {');
  const sonCatch = once.lastIndexOf('catch');
  assert.ok(sonTry > sonCatch,
    'onMeta cagrisi try blogu icinde degil — olcum hatasi istegi dusurebilir');
});

test('createMessage hala metin donduruyor (cagiranlar bozulmadi)', () => {
  // Geri donus tipi degisirse /cues, /stream ve digerleri sessizce bozulur.
  assert.match(groqSrc, /return \(msg\.content && msg\.content\.trim\(\)\) \? msg\.content/,
    'createMessage artik duz metin dondurmuyor');
});

test('/cues onMeta gecirip logluyor', () => {
  assert.match(aidSrc, /onMeta:\s*\(m\)\s*=>/, '/cues onMeta gecirmiyor');
  assert.match(aidSrc, /groq_ms/, 'log satirinda groq_ms yok');
  assert.match(aidSrc, /ag_ms/, 'log satirinda ag_ms (ms - groq_ms) yok');
});

test('kirilim istemciye de donuyor', () => {
  assert.match(aidSrc, /out\.timing\s*=/,
    'cevapta timing yok — olcum icin her seferinde Railway logu gerekir');
});
