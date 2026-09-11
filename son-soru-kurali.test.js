/**
 * son-soru-kurali.test.js — arka arkaya sorulan iki soruda model SONUNCUYU
 * cevaplamali.
 *
 * Calistir: node --test son-soru-kurali.test.js
 *
 * Neden var: audio.js soruyu parca parca aliyor ve devam niteligindeki
 * parcalari birlestiriyor. Birlestirme OLCULDU ve gerekli:
 *
 *   B "How do you decide what to work on first" + "when everything on your
 *     list looks urgent?"                       -> birlesmeli
 *   C "Tell me about a project you led that succeeded." + "And then tell me
 *     what you would do differently ... half the budget."  -> birlesmeli
 *
 * Ama ayni birlestirme ARKA ARKAYA IKI AYRI soruyu da birlestiriyor:
 *
 *   D "What is your greatest strength?" + "And what is your biggest weakness?"
 *
 * 11 Eylul 2026'da uretimde olculdu: model bu metinde yalnizca BIRINCI
 * soruyu cevapliyordu. Ekrandaki ipuclari
 *
 *     "Data-driven forecasting | SAP IBP modeling | Reduced forecast error"
 *
 * yani aday "en buyuk zaafin ne" sorusuyla karsi karsiyayken ekraninda GUCLU
 * YONLERI yaziyordu. Yanlis cevabi guvenle okumak, hic cevap gormemekten
 * daha kotu.
 *
 * Cozum istemcide degil: birlestirmeyi bozmak B ve C'yi kirar. Sinirin
 * nerede oldugunu dilbilgisiyle tahmin etmek yerine modele soyluyoruz.
 *
 * Bu dosya resolvePrompt'u KAYNAKTAN kesip GERCEKTEN calistiriyor ve uretilen
 * system prompt'una bakiyor.
 */
'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const src = fs.readFileSync(path.join(__dirname, 'routes', 'aid.js'), 'utf8');

/** resolvePrompt'u bagimliliklariyla birlikte kaynaktan kesip calistirir. */
function resolvePromptYukle() {
  const bas = src.indexOf('const PROMPTS = {');
  assert.notStrictEqual(bas, -1, 'PROMPTS bulunamadi');
  const fn = src.indexOf('function resolvePrompt(');
  assert.notStrictEqual(fn, -1, 'resolvePrompt bulunamadi');
  // Fonksiyonun sonu: govde girintisiz bir } ile bitiyor.
  const son = src.indexOf('\n}\n', fn) + 3;
  assert.ok(son > fn, 'resolvePrompt sonu bulunamadi');
  return new Function('NO_EM_DASH',
    src.slice(bas, son) + '\nreturn resolvePrompt;'
  )('\n\nDo not use em dashes.');
}

const resolvePrompt = resolvePromptYukle();

// ── Asil kural ─────────────────────────────────────────────────────────────
test('system prompt "yalnizca SON soruyu cevapla" kuralini iceriyor', () => {
  const { system } = resolvePrompt('short', false, 'job_interview', 'en', true);
  assert.match(system, /Answer ONLY the question asked\s+LAST/i,
    'son soru kurali yok — arka arkaya iki soruda model birincisini cevaplar');
});

test('kural, oncesini BAGLAM olarak kullanmayi da soyluyor (C senaryosu bozulmasin)', () => {
  const { system } = resolvePrompt('short', false, 'job_interview', 'en', true);
  assert.match(system, /context/i, 'oncesinin baglam oldugu soylenmemis');
  assert.match(system, /refers back|do it again|that project/i,
    'geriye atif yapan son soru icin aciklama yok — C senaryosu (yarim butce) bozulabilir');
});

// ── Her yolda var mi ───────────────────────────────────────────────────────
// Kural NO_FABRICATION'in yanina konuldu, yani with_points'ten bagimsiz.
// /cues hizli yolu ile /stream akis yolu ayni kurali gormeli; biri gormezse
// ekrandaki ipuclari ile sesli cevap FARKLI soruyu cevaplar.
test('kural hem ipucu yolunda hem akis yolunda var', () => {
  for (const withPoints of [true, false]) {
    const { system } = resolvePrompt('short', false, 'job_interview', 'en', withPoints);
    assert.match(system, /Answer ONLY the question asked\s+LAST/i,
      `with_points=${withPoints} yolunda kural yok — ipuclari ve cevap farkli soruyu cevaplayabilir`);
  }
});

test('kural her mulakat tipinde ve her uzunlukta var', () => {
  const tipler = ['job_interview', 'technical_interview', 'behavioral_interview',
                  'case_study', 'system_design', 'product_sense'];
  for (const t of tipler) {
    for (const uzunluk of ['short', 'detailed']) {
      const { system } = resolvePrompt(uzunluk, false, t, 'en', true);
      assert.match(system, /Answer ONLY the question asked\s+LAST/i,
        `${t}/${uzunluk} kurali kaybetmis`);
    }
  }
});

test('Ingilizce disi dilde de kural duruyor', () => {
  const { system } = resolvePrompt('short', false, 'job_interview', 'tr', true);
  assert.match(system, /Answer ONLY the question asked\s+LAST/i);
  assert.match(system, /Respond ONLY in/i, 'dil yonergesi kaybolmus');
});

// ── Sira ───────────────────────────────────────────────────────────────────
// POINTS_DIRECTIVE cikti bicimini tarif ediyor ve taban prompt'un "Output ONLY
// the spoken answer" satirini gecersiz kilmasi icin EN SONDA olmali. Son soru
// kurali onun onune girmeli, arasina degil.
test('cikti bicimi yonergesi hala en sonda (dil yonergesi haric)', () => {
  const { system } = resolvePrompt('short', false, 'job_interview', 'en', true);
  const iKural  = system.search(/Answer ONLY the question asked/i);
  const iFormat = system.indexOf('OUTPUT FORMAT:');
  assert.ok(iFormat > iKural,
    'cikti bicimi yonergesi son soru kuralinin ONUNE gecmis — bicim bozulabilir');
});

test('uydurma yasagi ve em dash yasagi kaybolmadi', () => {
  const { system } = resolvePrompt('short', false, 'job_interview', 'en', true);
  assert.match(system, /NEVER invent facts/, 'uydurma yasagi kaybolmus');
  assert.match(system, /em dash/i, 'em dash yasagi kaybolmus');
});

test('token butcesi degismedi (kural butceyi yemesin)', () => {
  assert.strictEqual(resolvePrompt('short',    false, 'job_interview', 'en', false).max_tokens, 320);
  assert.strictEqual(resolvePrompt('short',    false, 'job_interview', 'en', true).max_tokens,  380);
  assert.strictEqual(resolvePrompt('detailed', false, 'job_interview', 'en', true).max_tokens,  610);
});
