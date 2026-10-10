/**
 * demo-cevaplari.test.js — ana sayfa demo cevap uretici (K113, 9 Ekim 2026).
 * Gercek AI CAGRILMAZ: sahte ai modulu -r ile yuklenir.
 *
 *   DC1 canli rotalari (/cues, /stream) overlay'in istek bicimiyle cagirir,
 *       8 sahne yazar, ipuclarini /cues'tan alir, cevabi ANSWER:'dan sonra keser
 *   DC2 veritabanina baglanmaz (Supabase degiskenleri surecte bos)
 *   DC3 profiller hayali; gercek sirket adi yok; anahtar yoksa hicbir sey uretmez
 *   DC4 (K113b) secili sahne yenileme: yalnizca verilen sahne yeniden uretilir,
 *       digerleri aynen korunur; bilinmeyen sahne adi reddedilir
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BETIK = path.join(__dirname, 'scripts', 'demo-cevaplari.js');
const SAHTE = path.join(__dirname, 'test-yardim', 'demo-sahte-ai.js');

test('DC1+DC2: canli rotalarla 8 sahne, overlay baglami, veritabani yok', () => {
  const gec = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-'));
  const cikti = path.join(gec, 'c.json'), istek = path.join(gec, 'i.json');
  const r = spawnSync(process.execPath, ['-r', SAHTE, BETIK], { cwd: __dirname, encoding: 'utf8',
    env: { ...process.env, ANTHROPIC_API_KEY: 'sahte', SUPABASE_URL: 'https://gercek.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'gizli', DEMO_CIKTI: cikti, DEMO_ISTEKLER: istek } });
  assert.strictEqual(r.status, 0, r.stderr);
  const d = JSON.parse(fs.readFileSync(cikti, 'utf8'));
  assert.deepStrictEqual(d.sahneler.map((s) => s.id), ['genel', 'hemsire', 'yazilim', 'satis', 'musteri', 'veri', 'depo', 'ogretmen']);
  for (const s of d.sahneler) {
    assert.deepStrictEqual(s.ipuclari, ['Listen first', 'Explain the risk', 'Document it'], '/cues yolu');
    assert.strictEqual(s.cevap, 'I listened first, then acted.', 'ANSWER: sonrasi');
  }
  const { istekler, supabase } = JSON.parse(fs.readFileSync(istek, 'utf8'));
  assert.strictEqual(supabase, null, 'Supabase degiskeni surecte kaldi');
  assert.strictEqual(istekler.length, 8);
  assert.match(istekler[1], /JOB CONTEXT: Candidate: Maria Okafor\nRole: .*\nLocation: .*\nSkills: .*\nCV: .*\nTarget role: Registered Nurse, Medical-Surgical\nCompany: Alderpoint Health/);
  assert.ok(!r.stdout.includes('sahte') && !r.stderr.includes('gizli'), 'anahtar ekrana basildi');
});

test('DC3: profiller hayali; anahtar yoksa durur', () => {
  const p = JSON.parse(fs.readFileSync(path.join(__dirname, 'scripts', 'demo-profilleri.json'), 'utf8'));
  assert.strictEqual(p.sahneler.length, 8);
  const BILINEN = /\b(google|amazon|microsoft|apple|meta|walmart|target|kaiser|mayo|ups|fedex|costco|starbucks|deloitte|salesforce)\b/i;
  for (const s of p.sahneler) assert.ok(!BILINEN.test(s.ilan.sirket), s.ilan.sirket);
  const env = { ...process.env }; delete env.ANTHROPIC_API_KEY;
  const r = spawnSync(process.execPath, [BETIK], { cwd: os.tmpdir(), encoding: 'utf8', env: { ...env, DEMO_CIKTI: path.join(os.tmpdir(), 'olmamali.json') } });
  // .env bulunursa anahtar oradan gelir; bu ortamda yok
  if (!fs.existsSync(path.join(__dirname, '..', '.env')) && !fs.existsSync(path.join(__dirname, '.env'))) {
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /ANTHROPIC_API_KEY bulunamadi/);
  }
});

test('DC4: secili sahne yenileme digerlerini aynen korur', () => {
  const gec = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-'));
  const cikti = path.join(gec, 'c.json'), istek = path.join(gec, 'i.json');
  const env = { ...process.env, ANTHROPIC_API_KEY: 'sahte', DEMO_CIKTI: cikti, DEMO_ISTEKLER: istek };
  // onceki tam uretim: elle isaretlenmis bir dosya
  const eski = { uretildi: '2026-10-01T00:00:00.000Z', model: 'x', not: 'y', sahneler: ['genel', 'hemsire', 'yazilim', 'satis', 'musteri', 'veri', 'depo', 'ogretmen']
    .map((id) => ({ id, etiket: id, soru: 'Q?', ipuclari: ['eski'], cevap: `eski ${id}` })) };
  fs.writeFileSync(cikti, JSON.stringify(eski));
  const r = spawnSync(process.execPath, ['-r', SAHTE, BETIK, 'depo'], { cwd: __dirname, encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  const d = JSON.parse(fs.readFileSync(cikti, 'utf8'));
  assert.strictEqual(JSON.parse(fs.readFileSync(istek, 'utf8')).istekler.length, 1, 'yalnizca bir sahne uretilmeli');
  for (const s of d.sahneler) {
    if (s.id === 'depo') { assert.strictEqual(s.cevap, 'I listened first, then acted.'); assert.ok(s.uretildi > eski.uretildi); }
    else { assert.strictEqual(s.cevap, `eski ${s.id}`); assert.strictEqual(s.uretildi, eski.uretildi); }
  }
  const k = spawnSync(process.execPath, ['-r', SAHTE, BETIK, 'pilot'], { cwd: __dirname, encoding: 'utf8', env });
  assert.notStrictEqual(k.status, 0);
  assert.match(k.stderr, /bilinmeyen sahne: pilot/);
});
