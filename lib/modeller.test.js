/**
 * lib/modeller.test.js — Tek model kaydi (26 Eylul 2026, model yonetimi adim 1).
 *
 * Calistir: node --test "*.test.js" "lib/*.test.js" "middleware/*.test.js"
 *
 * Karar: model kendi kendine degismez; her gorevin modeli tek yerde ve ortam
 * degiskeniyle (kod degismeden, geri alinabilir) degistirilir. Istemcinin
 * gonderdigi model adi izinli listeden gecer: arayuzde olmayan pahali bir
 * model istekle secilemez.
 */

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');

const yenidenYukle = () => {
  delete require.cache[require.resolve('./modeller')];
  delete require.cache[require.resolve('./ai')];
  return { M: require('./modeller'), AI: require('./ai') };
};
function ortamla(degiskenler, fn) {
  const eski = {};
  for (const [k, v] of Object.entries(degiskenler)) { eski[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(eski)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
}

test('M1: katmanlar varsayilanla cozuluyor; ortam degiskeni kod degismeden degistiriyor', () => {
  ortamla({ MODEL_HIZLI: null, MODEL_GUCLU: null }, () => {
    const { AI } = yenidenYukle();
    assert.strictEqual(AI.resolveModel('claude-haiku'), 'claude-haiku-4-5-20251001');
    assert.strictEqual(AI.resolveModel('claude-sonnet'), 'claude-sonnet-4-6');
  });
  ortamla({ MODEL_HIZLI: 'claude-haiku-9', MODEL_GUCLU: 'claude-sonnet-9' }, () => {
    const { AI } = yenidenYukle();
    assert.strictEqual(AI.resolveModel('claude-haiku'), 'claude-haiku-9');
    assert.strictEqual(AI.resolveModel('claude-sonnet'), 'claude-sonnet-9');
  });
  yenidenYukle();
});

test('M2: izinli liste disi (bos, bilinmeyen, dogrudan pahali kimlik) hizli katmana duser', () => {
  ortamla({ MODEL_HIZLI: null }, () => {
    const { AI } = yenidenYukle();
    for (const ad of [undefined, '', 'claude-opus', 'claude-opus-4-6', 'o1-pro', 'IGNORE']) {
      assert.strictEqual(AI.resolveModel(ad), 'claude-haiku-4-5-20251001', `${ad} izinli liste disindan gecti`);
    }
    assert.strictEqual(AI.resolveModel('gpt-4o'), 'gpt-4o');
    assert.strictEqual(AI.isOpenAI(AI.resolveModel('gpt-4.1-mini')), true);
  });
});

// Izinli listenin Ayarlar seciciyle ayni oldugu web tarafinda denetleniyor
// (interview-aid-web/tests/model-kaydi.test.js): sunucu deposu tek basina da
// test edilebilsin.
test('M3: rotalarda elle yazilmis model kimligi yok; hepsi katman adi kullaniyor', () => {
  const ROT = path.join(__dirname, '..', 'routes');
  for (const f of fs.readdirSync(ROT).filter((x) => x.endsWith('.js'))) {
    const kod = fs.readFileSync(path.join(ROT, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    assert.ok(!/'claude-[a-z]+-\d/.test(kod), `${f} icinde elle yazilmis Claude model kimligi var`);
  }
});

test('M4: ozet her gorevin modelini tek yerde gosteriyor', () => {
  ortamla({ REALTIME_STT_MODEL: null, MOCK_TTS_MODEL: 'tts-x' }, () => {
    const { M } = yenidenYukle();
    const o = M.ozet();
    assert.strictEqual(o.ses_tanima, 'gpt-4o-transcribe');
    assert.strictEqual(o.seslendirme, 'tts-x');
    assert.ok(o['claude-haiku'] && o['claude-sonnet']);
  });
});
