/**
 * kariyer-mektup.test.js — Imzalanacak mektupta uydurma ve tahmini tarih yok.
 *
 * Calistir: node --test "*.test.js" "lib/*.test.js" "middleware/*.test.js"
 *
 * NEDEN VAR. 24 Eylul 2026'da olculdu (K54). /experience-letter:
 *   - modele bugunun tarihi verilmiyordu; imzali belgenin tarihi TAHMINDI
 *   - uydurma yasagi yoktu; bos basari alanina "general duties performed
 *     satisfactorily" gidiyordu, yani kullanicinin yazmadigi bir
 *     degerlendirme yoneticinin agzina konuyordu
 *   - "employment" turu isverenin resmi belgesini calisana urettiriyordu;
 *     kullanicinin kararıyla IK'ya rica e-postasina donustu
 *   - cikti, kesilme ve uzunluk denetimi yoktu; hatalar ham metindi
 * Ayrica /linkedin-headlines kaldirildi (LinkedIn Optimizasyon'un denetimsiz
 * ikinci kopyasiydi).
 */

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');

const { EL, EL_KODLARI } = require('./lib/hata-kodlari');
const PRACT = fs.readFileSync(path.join(__dirname, 'routes', 'practice.js'), 'utf8');
const { NO_EM_DASH } = require('./lib/style-rules');

const yorumsuz = (k) => k.replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

let sahte = { yanit: '', kesildi: false, cagri: [] };
require.cache[require.resolve('./lib/ai')] = {
  id: require.resolve('./lib/ai'), filename: require.resolve('./lib/ai'), loaded: true,
  exports: {
    createMessage: async (opts, ustveri) => {
      sahte.cagri.push(opts);
      if (sahte.kesildi && ustveri) ustveri.kesildi = true;
      return sahte.yanit;
    },
    streamMessage: async () => '', resolveModel: (m) => m, isOpenAI: () => false,
  },
};

const MEKTUP = 'To Whom It May Concern, ' + 'This letter confirms the employment of Ayse Yilmaz. '.repeat(10);

async function istek(url, govde, ayar = {}) {
  sahte = { yanit: MEKTUP, kesildi: false, cagri: [], ...ayar };
  const eski = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test';
  const Fastify = require('fastify');
  const app = Fastify({ logger: false });
  await app.register(require('./routes/practice'), { prefix: '/api/v1/practice' });
  await app.ready();
  try {
    const r = await app.inject({ method: 'POST', url: `/api/v1/practice${url}`, payload: govde });
    return { durum: r.statusCode, govde: r.body ? JSON.parse(r.body) : {} };
  } finally {
    await app.close();
    if (eski == null) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = eski;
  }
}

const TAM = { emp_name: 'Ayse Yilmaz', emp_title: 'Inventory Control Specialist', company: 'Wesco' };
const sabit = (ad) => {
  const b = PRACT.indexOf(`const ${ad} = \``);
  assert.ok(b > 0, `${ad} yok`);
  return PRACT.slice(b).split('`')[1];
};
const KURALLAR = () => PRACT.slice(PRACT.indexOf('const LETTER_RULES = `')).split('`')[1];

// ── A: baslik ucu kalkti ───────────────────────────────────────────────────

test('A1: /linkedin-headlines ARTIK YOK, komsu uc calisiyor', async () => {
  const r = await istek('/linkedin-headlines', { current_title: 'Analyst' });
  assert.strictEqual(r.durum, 404, `uc hala yanit veriyor: ${r.durum}`);
  const k = await istek('/experience-letter', TAM);
  assert.strictEqual(k.durum, 200, 'eklenti yuklenmemis, 404 anlamsiz');
  assert.ok(!/['"]\/linkedin-headlines['"]/.test(yorumsuz(PRACT)), 'rota ya da sayac kaydi duruyor');
});

// ── B: istem ───────────────────────────────────────────────────────────────

test('B1: iki istem de ORTAK kurallari tasiyor', () => {
  const k = KURALLAR();
  for (const baslik of ['NEVER INVENT FACTS', 'MISSING INFORMATION', 'DATES']) assert.ok(k.includes(baslik), baslik);
  assert.match(k, /ONLY if that exact number was given/);
  assert.match(k, /Do not invent duties or praise/);
  assert.match(k, /Never guess today's date/);
  for (const ad of ['EXPERIENCE_LETTER_SYSTEM', 'HR_REQUEST_SYSTEM']) {
    assert.ok(sabit(ad).includes('${LETTER_RULES}'), `${ad} ortak kurallari kullanmiyor`);
  }
});

test('B2: bugunun tarihi isteme GERCEKTEN giriyor, bos alan uydurma deger tasimiyor', async () => {
  await istek('/experience-letter', TAM);
  const k = sahte.cagri[0].messages[0].content;
  assert.ok(k.includes(`Today's date: ${new Date().toISOString().slice(0, 10)}`), 'tarih yok');
  assert.ok(!/general duties performed satisfactorily/i.test(k), 'eski dolgu degerlendirme geri gelmis');
  assert.ok(!/\[Manager Name\]|\[Title\]/.test(k), 'eksik alan yer tutucuyla dolduruldu');
  assert.match(k, /Manager name: \(not given\)/);
  assert.match(k, /Responsibilities and achievements: \(not given\)/);
});

test('B3: tur secimi: mektup, rica e-postasi, eski "employment" ve bilinmeyen', async () => {
  const beklenen = [
    ['experience', 'EXPERIENCE_LETTER_SYSTEM', 'experience'],
    ['reference',  'EXPERIENCE_LETTER_SYSTEM', 'reference'],
    ['hr_request', 'HR_REQUEST_SYSTEM',        'hr_request'],
    ['employment', 'HR_REQUEST_SYSTEM',        'hr_request'],
    ['<script>',   'EXPERIENCE_LETTER_SYSTEM', 'experience'],
  ];
  for (const [tur, istemAdi, donen] of beklenen) {
    const r = await istek('/experience-letter', { ...TAM, type: tur });
    assert.strictEqual(sahte.cagri[0].system, sabit(istemAdi).replace('${LETTER_RULES}', KURALLAR()) + NO_EM_DASH, `${tur}: yanlis istem`);
    assert.strictEqual(r.govde.type, donen, `${tur}: donen tur`);
    assert.match(sahte.cagri[0].messages[0].content, new RegExp(`Type: ${donen}`));
  }
});

test('B4: rica e-postasi maas SORMUYOR ve kullanicinin agzindan', () => {
  const i = sabit('HR_REQUEST_SYSTEM');
  assert.match(i, /FROM the employee TO the HR department/);
  assert.match(i, /Do not ask for salary information/);
});

test('B5: uzunluk istemde sinirli, butce o sinira yetiyor (K36)', () => {
  const i = sabit('EXPERIENCE_LETTER_SYSTEM');
  const m = /between (\d+) and (\d+) words/.exec(i);
  assert.ok(m, 'mektup uzunlugu istemde yok');
  const g = PRACT.slice(PRACT.indexOf("fastify.post('/experience-letter'"));
  const butce = Number(/max_tokens:\s*(\d+)/.exec(g)[1]);
  assert.ok(butce >= Math.ceil(Number(m[2]) * 2.27 * 1.5), `butce ${butce}, Turkce ust sinira pay birakmiyor`);
});

// ── C: rota ────────────────────────────────────────────────────────────────

test('C1: zorunlu alan eksik -> 422 KOD, modele gidilmiyor', async () => {
  for (const eksik of ['emp_name', 'emp_title', 'company']) {
    const r = await istek('/experience-letter', { ...TAM, [eksik]: '  ' });
    assert.strictEqual(r.durum, 422, eksik);
    assert.strictEqual(r.govde.kod, EL.ALAN_EKSIK);
    assert.strictEqual(sahte.cagri.length, 0, `${eksik}: model cagrildi`);
  }
});

test('C2: kesilen yanit -> 422 el_yanit_kesildi', async () => {
  const r = await istek('/experience-letter', TAM, { kesildi: true });
  assert.strictEqual(r.durum, 422);
  assert.strictEqual(r.govde.kod, EL.YANIT_KESILDI);
});

test('C3: bos ya da cok kisa metin BASARI DEGIL', async () => {
  for (const yanit of ['', 'Dear HR,', 'kisa '.repeat(39)]) {
    const r = await istek('/experience-letter', TAM, { yanit });
    assert.strictEqual(r.durum, 422, JSON.stringify(yanit.slice(0, 20)));
    assert.strictEqual(r.govde.kod, EL.URETILEMEDI);
  }
  const r = await istek('/experience-letter', TAM, { yanit: 'kelime '.repeat(40) });
  assert.strictEqual(r.durum, 200, 'sinirdaki 40 kelime reddedildi');
});

test('C4: kodlar listesi tanimli (ceviri testi buradan okur)', () => {
  assert.deepStrictEqual([...EL_KODLARI].sort(), Object.values(EL).sort());
  assert.strictEqual(EL_KODLARI.length, 3);
});
