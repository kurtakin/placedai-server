/**
 * lib/thinking-off.test.js — dusunme kapatiliyor mu?
 *
 * Calistir: node --test lib/thinking-off.test.js
 *
 * 9 Eylul 2026'da uretimde olculdu: qwen/qwen3.6-27b bir dusunen model ve
 * /cues su ucluyu donduruyordu, dort sorunun dordunde de ayni:
 *   <think> | Here's a thinking process: | **Analyze User Input:**
 * Kullanicinin ekraninda mulakat sirasinda ipucu yerine bu yaziyordu.
 * 60 token butcesinin TAMAMI dusunmeye gidiyordu (cikis_tok her koside 60).
 *
 * Modelden kacinamiyoruz. Groq katalogunda (9 Eylul, uretim hesabi) duz
 * metin modeli KALMADI:
 *   gpt-oss-120b / gpt-oss-20b   dusunen
 *   qwen3.6-27b / qwen3.8-27b    dusunen
 *   compound / compound-mini     ajan sistemi
 *   allam-2-7b                   Arapca odakli
 *   whisper-* orpheus-* *guard*  metin modeli degil
 * llama-3.1-8b-instant ve llama-3.3-70b-versatile dusmus (K10'da bir donem
 * dustugu not edilmisti, geri gelmemis).
 *
 * Tek yol dusunmeyi kapatmak. Bu dosya o ayarin sessizce kaybolmamasini
 * sagliyor: kaybolursa hicbir test dusmez, sadece kullanici ekraninda
 * yine dusunme metni gorunur.
 */
'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const groq   = require('./groq');

// ── 1. Hangi modeller dusunuyor ────────────────────────────────────────────
test('qwen3 dusunen model olarak taniniyor', () => {
  assert.ok(groq.isThinking('qwen/qwen3.6-27b'),
    'qwen3.6 taninmiyor — uretimde ekrana <think> yazan model buydu');
  assert.ok(groq.isThinking('qwen/qwen3.8-27b'), 'qwen3.8 taninmiyor');
});

test('gpt-oss ailesi de taniniyor', () => {
  assert.ok(groq.isThinking('openai/gpt-oss-20b'));
  assert.ok(groq.isThinking('openai/gpt-oss-120b'));
});

test('duz modeller dusunen sayilmiyor', () => {
  for (const m of ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'allam-2-7b']) {
    assert.ok(!groq.isThinking(m), `${m} yanlislikla dusunen sayildi`);
  }
});

// ── 2. Hangi ayar gonderiliyor ─────────────────────────────────────────────
test('qwen3 icin dusunme KAPATILIYOR (none)', () => {
  assert.strictEqual(groq.dusunmeAyari('qwen/qwen3.6-27b'), 'none',
    'qwen3 icin none gonderilmiyor — dusunme acik kalir ve ekrana cikar');
});

test('gpt-oss icin low (none kabul etmiyor)', () => {
  assert.strictEqual(groq.dusunmeAyari('openai/gpt-oss-20b'), 'low');
});

test('bilinmeyen modele parametre gonderilmiyor', () => {
  // Gecersiz parametre 400 verir ve /cues tamamen coker. Bilmedigimiz
  // aileye dokunmuyoruz.
  assert.strictEqual(groq.dusunmeAyari('yeni-model-v9'), null);
  assert.strictEqual(groq.dusunmeAyari('llama-3.1-8b-instant'), null);
});

// ── 3. Davranis: istek govdesi dogru kuruluyor mu ──────────────────────────
async function govdeYakala(model, opts = {}) {
  const eskiFetch = globalThis.fetch, eskiKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'test';
  const govdeler = [];
  globalThis.fetch = async (_url, init) => {
    govdeler.push(JSON.parse(init.body));
    if (opts.ilkIstek400 && govdeler.length === 1) {
      return { ok: false, status: 400, text: async () => 'reasoning_effort not supported' };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'a | b | c' } }] }) };
  };
  try {
    await groq.createMessage({ model, max_tokens: 60, messages: [{ role: 'user', content: 'x' }] });
  } finally {
    globalThis.fetch = eskiFetch;
    if (eskiKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = eskiKey;
  }
  return govdeler;
}

test('qwen3 istegi reasoning_effort none tasiyor', async () => {
  const [g] = await govdeYakala('qwen/qwen3.6-27b');
  assert.strictEqual(g.reasoning_effort, 'none', 'istekte none yok');
});

test('dusunme kapaliyken token butcesi dar kaliyor (hizli)', async () => {
  // Butce acilirsa uretim suresi uzar. Olculdu: 60 token uretimi 118 ms.
  const [g] = await govdeYakala('qwen/qwen3.6-27b');
  assert.strictEqual(g.max_tokens, 60,
    'dusunme kapaliyken butce acilmis — bosuna yavaslar');
});

test('dusunme acik kalan modelde butce aciliyor', async () => {
  // gpt-oss'ta dusunme kapatilamiyor; dar butce icerigi tamamen yutar.
  const [g] = await govdeYakala('openai/gpt-oss-20b');
  assert.ok(g.max_tokens >= 300, 'gpt-oss icin butce acilmamis, icerik yutulur');
});

test('parametre reddedilirse istek kaybolmuyor, parametresiz tekrar deneniyor', async () => {
  const govdeler = await govdeYakala('qwen/qwen3.6-27b', { ilkIstek400: true });
  assert.strictEqual(govdeler.length, 2, 'tekrar denenmedi — /cues tamamen cokerdi');
  assert.strictEqual(govdeler[1].reasoning_effort, undefined, 'ikinci istek hala parametre tasiyor');
  assert.ok(govdeler[1].max_tokens >= 300,
    'parametresiz denemede butce acilmali, yoksa dusunme icerigi yutar');
});
