/**
 * lib/groq.test.js — model secimi ve ip ucu ayristirmasi
 *
 * Neden var: 5 Eylul 2026'da olculdu. PREFERRED listesinin birinci ve ucuncu
 * maddesi (llama-3.1-8b-instant, llama-3.3-70b-versatile) Groq katalogundan
 * kalkmisti. Sira sessizce openai/gpt-oss-20b'ye dustu, o bir akil yurutme
 * modeli, ve uc sorunun ikisinde sunu donderdi:
 *
 *   "I'm sorry, but I don't have the candidate's profile to generate cues."
 *
 * Sonuc: hizli yol calismiyordu. Ipucu ekranda 1217 ms'de beliriyordu, cunku
 * istemci Claude akisindaki POINTS satirini beklemek zorunda kaliyordu.
 * Groq yavas degildi, 284 ms'de cevap veriyordu; kullanilabilir cevap
 * vermiyordu. Ve logger kapali oldugu icin bu haftalarca gorunmedi.
 *
 * Calistir: node lib/groq.test.js
 */
'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const GROQ_PATH = require.resolve('./groq');

/** Katalogu taklit ederek taze bir groq modulu yukle ve secilen modeli dondur. */
async function pickWith(catalog, env = {}) {
  delete require.cache[GROQ_PATH];
  const oldFetch = global.fetch;
  const oldKey   = process.env.GROQ_API_KEY;
  const oldModel = process.env.GROQ_MODEL;

  process.env.GROQ_API_KEY = 'test-key';
  if (env.GROQ_MODEL) process.env.GROQ_MODEL = env.GROQ_MODEL;
  else delete process.env.GROQ_MODEL;

  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: catalog.map(id => ({ id })) }),
  });

  try {
    return await require('./groq').pickModel();
  } finally {
    global.fetch = oldFetch;
    if (oldKey   === undefined) delete process.env.GROQ_API_KEY;   else process.env.GROQ_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.GROQ_MODEL;     else process.env.GROQ_MODEL   = oldModel;
    delete require.cache[GROQ_PATH];
  }
}

// 5 Eylul 2026'da hesapta gercekten acik olanlar.
const GERCEK_KATALOG = [
  'whisper-large-v3-turbo', 'meta-llama/llama-prompt-guard-2-86m', 'groq/compound',
  'qwen/qwen3.6-27b', 'canopylabs/orpheus-v1-english', 'openai/gpt-oss-safeguard-20b',
  'groq/compound-mini', 'qwen/qwen3.8-27b', 'openai/gpt-oss-120b',
  'canopylabs/orpheus-arabic-saudi', 'whisper-large-v3', 'openai/gpt-oss-20b',
  'meta-llama/llama-prompt-guard-2-22m', 'allam-2-7b',
];

test('gercek katalogda akil yurutmeyen bir model seciliyor', async () => {
  const m = await pickWith(GERCEK_KATALOG);
  assert.ok(!/gpt-oss|reason/i.test(m),
    `secilen model ${m} akil yurutme modeli: dar bir gorevde cevap vermeyi reddedebiliyor`);
});

test('tercih listesi tamamen bayatlasa bile akil yurutme modeline dusulmuyor', async () => {
  // Listedeki hicbir isim katalogda yok, ama akil yurutmeyen bir model var.
  const m = await pickWith(['openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'whisper-large-v3']);
  assert.strictEqual(m, 'qwen/qwen3.8-27b');
});

test("PREFERRED'deki akil yurutme modeli, listede olmayan hizli modeli ezmiyor", async () => {
  // 4 Eylul'de olan tam olarak buydu: PREFERRED'in hizli girdileri katalogdan
  // kalkti, geriye listede DURAN tek isim olarak gpt-oss-20b kaldi ve secildi.
  // Katalogda, listede olmayan ama akil yurutmeyen bir model dururken.
  //
  // Eski mantik (PREFERRED.find || usable[0]) bu testi GECEMEZ: gpt-oss-20b
  // PREFERRED'de oldugu icin kazanirdi. Onceki testler bunu yakalayamiyordu,
  // cunku onlar listenin SIRASINI dogruluyordu, korumayi degil.
  const m = await pickWith(['openai/gpt-oss-20b', 'yeni-hizli-model-v1']);
  assert.strictEqual(m, 'yeni-hizli-model-v1',
    "PREFERRED'de duran akil yurutme modeli, katalogdaki hizli modeli eziyor");
});

test('ses ve guvenlik modelleri metin modeli sanilmiyor', async () => {
  const m = await pickWith(['whisper-large-v3', 'canopylabs/orpheus-v1-english',
                            'meta-llama/llama-prompt-guard-2-86m', 'openai/gpt-oss-safeguard-20b',
                            'qwen/qwen3.6-27b']);
  assert.strictEqual(m, 'qwen/qwen3.6-27b');
});

test('baska hicbir sey yoksa akil yurutme modeli kabul ediliyor', async () => {
  const m = await pickWith(['whisper-large-v3', 'openai/gpt-oss-20b']);
  assert.strictEqual(m, 'openai/gpt-oss-20b', 'son care olarak bile secilmiyor: hizli yol tamamen olur');
});

test('GROQ_MODEL katalogu gecersiz kiliyor', async () => {
  const m = await pickWith(GERCEK_KATALOG, { GROQ_MODEL: 'qwen/qwen3.8-27b' });
  assert.strictEqual(m, 'qwen/qwen3.8-27b',
    'ortam degiskeni ise yaramiyor: katalog degisince deploy beklemek gerekir');
});

// ── parseCues: reddetme metni ip ucu sayilmamali ────────────────────────────

const aidSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'aid.js'), 'utf8');
const parseCues = (() => {
  const i = aidSrc.indexOf('function parseCues');
  assert.ok(i !== -1, 'parseCues bulunamadi');
  const body = aidSrc.slice(i, aidSrc.indexOf('\n}', i) + 2);
  return new Function(body + '\nreturn parseCues;')();
})();

test('modelin reddetme cumlesi ip ucu olarak gecmiyor', () => {
  const red = "I'm sorry, but I don't have the candidate's profile to generate specific cues.";
  assert.deepStrictEqual(parseCues(red), [],
    'reddetme metni ip ucu sayiliyor: kullanici ekranda ozur metni goruyor');
});

test('normal cikti uc ip ucuna ayrisiyor', () => {
  const out = parseCues('Name the decision | The evidence that changed it | What you shipped after');
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[0], 'Name the decision');
});

// ── Yapisal: prompt reddetmeyi yasakliyor mu ────────────────────────────────

test('cues prompt\'u reddetmeyi ve soru sormayi yasakliyor', () => {
  const i = aidSrc.indexOf("fastify.post('/cues'");
  const block = aidSrc.slice(i, i + 3000);
  assert.ok(/Never apologise/i.test(block), 'ozur dilemeyi yasaklayan kural yok');
  assert.ok(/STILL output three cues/i.test(block),
    'profil yoksa yine de uc ip ucu uret kurali yok: model reddedebiliyor');
  assert.ok(/Never ask a question back/i.test(block),
    'modele soru sormayi yasaklayan kural yok: aday konusurken cevap veremez');
});
