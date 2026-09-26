/**
 * altin-set.test.js — Altin test seti calistiricisinin kendisi (K61).
 *
 * Calistir: node --test "*.test.js" "lib/*.test.js" "middleware/*.test.js"
 *
 * Gercek model yok: sahte bir model once "iyi", sonra "kotu" davraniyor.
 * Amac denetimlerin DENETLENMESI: her denetim iyi yanitta gecmeli, tuzaga
 * dusen yanitta kanitiyla kalmali. Yalnizca hep gecen bir denetim hicbir
 * seyi olcmez.
 */

const { test } = require('node:test');
const assert   = require('node:assert');

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-anahtari';
delete process.env.MODEL_HIZLI;
delete process.env.MODEL_GUCLU;

const { calistir, fiyatBul, maliyet, argumanlar } = require('./olcum/altin-calistir');
const VAKALAR = require('./olcum/altin-set');

const J = (o) => JSON.stringify(o);

function sahteModel(iyi) {
  const cagri = [];
  const fn = async (opts, ustveri) => {
    const s = opts.system || '', icerik = opts.messages[0].content;
    cagri.push(opts.model);
    ustveri.girdi_token = 1000; ustveri.cikti_token = 200;
    if (s.includes('video interview coach')) {
      const tr = icerik.includes('Bir iş');
      const cvli = icerik.includes('Candidate CV:\nDeniz');
      const kendi = icerik.includes("Candidate's own answer");
      if (iyi) {
        return J({ key_points: [tr ? 'Anlaşmazlığı tanımla' : 'Name the disagreement'],
          answer_draft: tr ? 'Bir iş arkadaşımla [konu] hakkında anlaşmazlık yaşadım.'
            : cvli ? 'I redesigned the bin labels and cut picking errors by 18%.'
              : 'At [company], I disagreed with [coworker] about [topic].',
          avoid: [], time_plan: 'S:20s T:20s A:60s R:20s',
          ...(kendi ? { feedback: { strengths: ['ownership'], gaps: [], summary: 'Clear ownership of the mistake.' } } : {}) });
      }
      return J({ key_points: ['Resolved it in 3 days'], answer_draft: 'I fixed it within 12 days and raised output by 40%.', avoid: [], time_plan: '' });
    }
    if (s.includes('preparing a spoken mock interview')) {
      const adet = parseInt(icerik.match(/Number of questions: (\d+)/)[1], 10);
      const tr = icerik.includes('Interview language: Turkish');
      if (iyi) {
        return J({ questions: Array.from({ length: adet }, (_, i) =>
          tr ? `Zorlu bir durumu nasıl çözdünüz? (${i + 1})` : `Tell me about a time you used data to decide something (${i + 1})?`) });
      }
      return J({ questions: ['Tell me about your Power BI inventory dashboard project.', 'Walk me through what you mentioned in your resume.',
        'What changed after you implemented Power BI across the warehouses?'].slice(0, adet - 1) });
    }
    if (s.includes('interview coach reviewing a spoken mock interview')) {
      const tr = icerik.includes('Output language: Turkish');
      const kat = (band, evidence, comment) => ({ band, evidence, comment });
      if (iyi) {
        return J({ categories: tr
          ? { communication: kat('fair', 'Vardiyaları yeniden planladım', 'Somut bir adım anlattın.') }
          : { communication: kat('strong', 'I listened first, apologized', 'You stayed calm.'),
            problem_solving: kat('strong', 'arranged a replacement to ship the same day', 'You fixed the root cause.') },
        strengths: [tr ? 'Net anlatım' : 'Calm tone'], improvements: [tr ? 'Daha fazla ayrıntı' : 'Add detail to short answers'],
        summary: tr ? 'Güçlü ve somut cevaplar verdin.' : 'You gave concrete answers.' });
      }
      return J({ categories: {
        communication: kat('weak', 'My email box and customer requests', 'The candidate gave an off-topic answer.'),
        technical: kat('weak', 'My email box and customer requests', 'Same quote again.'),
        role_fit: kat('fair', 'I have ten years of leadership experience', 'Invented quote.') },
      strengths: [], improvements: [], summary: 'The candidate was brief.' });
    }
    if (s.includes('LinkedIn profile writer')) {
      if (iyi) {
        return J({ headline: 'Customer Success Associate | E-commerce support, returns and order tracking',
          about: 'I help customers get answers fast. I handle emails and calls, track orders, process returns and work with the warehouse team when something goes wrong. I like clear processes and calm conversations.',
          skills: ['Customer Support', 'Order Tracking'], keywords: [], recommendations: [] });
      }
      return J({ headline: 'Support Specialist with 10+ years',
        about: 'Müşteri odaklı. I handled 500 tickets a week and improved satisfaction by 30 percent for our customers, always calm and clear in every conversation.',
        skills: [], keywords: [], recommendations: [] });
    }
    throw new Error('sahte model: tanimsiz istem');
  };
  fn.cagri = cagri;
  return fn;
}

const bul = (r, id) => r.vakalar.find((v) => v.id === id);
const denetim = (v, ad) => v.denetimler.find((d) => d.ad === ad);

test('A1: iyi yanitla butun vakalar ve butun denetimler geciyor', async () => {
  const r = await calistir({ createMessage: sahteModel(true), tekrar: 2 });
  assert.strictEqual(r.vakalar.length, VAKALAR.length);
  for (const v of r.vakalar) {
    assert.strictEqual(v.basarili, 2, `${v.id}: ${v.hatalar.join('; ')}`);
    for (const d of v.denetimler) assert.strictEqual(d.gecen, 2, `${v.id} / ${d.ad}: ${d.kanitlar.join(' | ')}`);
  }
});

test('A2: tuzaga dusen yanitta HER denetim kaliyor ve kaniti gosteriyor', async () => {
  const r = await calistir({ createMessage: sahteModel(false), tekrar: 1 });
  for (const v of r.vakalar) {
    if (v.basarili === 0) continue; // urunun kendi kapisi reddetti (asagida ayrica)
    for (const d of v.denetimler) assert.strictEqual(d.gecen, 0, `${v.id} / ${d.ad} tuzagi yakalamadi`);
  }
  assert.match(denetim(bul(r, 'plan-beceri-proje'), 'beceriyi proje gibi varsayan soru').kanitlar[0], /Power BI inventory dashboard project/);
  assert.match(denetim(bul(r, 'plan-cvsiz'), "olmayan CV'ye atif").kanitlar[0], /your resume/);
  assert.match(denetim(bul(r, 'plan-beceri-proje'), "CV'de olmayan bir basari varsayimi").kanitlar[0], /you implemented Power BI/);
  assert.match(denetim(bul(r, 'oa-cvsiz'), 'kaynaksiz sayi denemesi').kanitlar[0], /^3 \(sinir 0\)/);
  assert.match(denetim(bul(r, 'geri-hitap'), 'ucuncu sahis hitap').kanitlar[0], /The candidate/);
  assert.match(denetim(bul(r, 'geri-kisa-ilgili'), 'dogrulanamayan alinti').kanitlar[0], /role_fit/);
  assert.match(denetim(bul(r, 'geri-kisa-ilgili'), 'ayni alinti birden cok kategoride').kanitlar[0], /technical/);
  assert.match(denetim(bul(r, 'li-sayisiz'), 'kaynaksiz rakam').kanitlar[0], /10.*500.*30/);
  assert.match(denetim(bul(r, 'li-dil'), 'Ingilizce profilde Turkce metin').kanitlar[0], /Müşteri/);
});

test('A3: urunun kendi reddi (bos cikti) basarisiz deneme sayiliyor, denetimi "gecti" saymiyor', async () => {
  // Kotu geri bildirim Turkce vakasinda tum kategoriler dogrulanamiyor ve ozet
  // var; kotu HireVue kendi-cevap vakasinda feedback yok ama taslak var.
  const r = await calistir({ createMessage: sahteModel(false), tekrar: 1, vakalar: VAKALAR.filter((v) => v.id === 'oa-kendi-cevap') });
  const v = r.vakalar[0];
  assert.strictEqual(v.basarili, 1);
  assert.strictEqual(denetim(v, 'geri bildirim var').gecen, 0);
  assert.match(denetim(v, 'geri bildirim var').kanitlar[0], /alan bos/);
});

test('A4: cozulemeyen JSON ve model hatasi ayri sayiliyor; token, sure ve maliyet olculuyor', async () => {
  let n = 0;
  const bozuk = async (opts, ustveri) => {
    n++; ustveri.girdi_token = 1000; ustveri.cikti_token = 200;
    if (n === 1) return 'duz metin, JSON degil';
    throw new Error('Anthropic API 400: model not found');
  };
  const r = await calistir({ createMessage: bozuk, tekrar: 2, vakalar: VAKALAR.filter((v) => v.id === 'plan-cvsiz') });
  const v = r.vakalar[0];
  assert.deepStrictEqual([v.deneme, v.basarili, v.json_hata], [2, 0, 1]);
  assert.strictEqual(v.hatalar.length, 1);
  assert.match(v.hatalar[0], /model not found/);
  assert.strictEqual(v.model, 'claude-haiku-4-5-20251001');
  assert.deepStrictEqual([v.ort_girdi_token, v.ort_cikti_token], [1000, 200]);
  assert.ok(v.ort_ms >= 0);
  // haiku 4.5: 1 / 5 USD milyon token basina -> iki cagri x 0,002
  assert.ok(Math.abs(v.toplam_maliyet_usd - 0.004) < 1e-9, String(v.toplam_maliyet_usd));
  // denetim sayaci basarisiz denemeyi gecti saymiyor
  assert.ok(v.denetimler.every((d) => d.gecen === 0 && d.toplam === 2));
});

test('A5: aday model ortam degiskeniyle seciliyor (uretimdeki gecisin aynisi)', async () => {
  const s = sahteModel(true);
  process.env.MODEL_HIZLI = 'claude-haiku-aday-9';
  process.env.MODEL_GUCLU = 'gpt-aday-9';
  try {
    const r = await calistir({ createMessage: s, vakalar: VAKALAR.filter((v) => ['plan-cvsiz', 'geri-hitap'].includes(v.id)) });
    assert.strictEqual(bul(r, 'plan-cvsiz').model, 'claude-haiku-aday-9');
    assert.strictEqual(bul(r, 'geri-hitap').model, 'gpt-aday-9');
    assert.deepStrictEqual(r.modeller, { hizli: 'claude-haiku-aday-9', guclu: 'gpt-aday-9' });
    // fiyat tablosunda yok: maliyet uydurulmuyor
    assert.strictEqual(bul(r, 'plan-cvsiz').toplam_maliyet_usd, null);
  } finally { delete process.env.MODEL_HIZLI; delete process.env.MODEL_GUCLU; }
});

test('A6: fiyat eslesmesi en uzun onekle; arguman okuma', () => {
  const t = { 'gpt-4o': { girdi: 2.5, cikti: 10 }, 'gpt-4o-mini': { girdi: 0.15, cikti: 0.6 } };
  assert.strictEqual(fiyatBul(t, 'gpt-4o-mini').girdi, 0.15);
  assert.strictEqual(fiyatBul(t, 'gpt-4o-2024-08-06').girdi, 2.5);
  assert.strictEqual(fiyatBul(t, 'claude-x'), null);
  assert.strictEqual(maliyet(t, [{ model: 'gpt-4o', girdi: null, cikti: 5 }]), null);
  assert.deepStrictEqual(argumanlar(['--hizli', 'm1', '--tekrar', '3', '--sahte']), { hizli: 'm1', tekrar: '3', sahte: true });
});

test('A7: vakalar benzersiz, her biri uretimdeki bir rotaya gidiyor ve en az bir denetim tasiyor', () => {
  const idler = VAKALAR.map((v) => v.id);
  assert.strictEqual(new Set(idler).size, idler.length);
  for (const v of VAKALAR) {
    assert.ok(['/online-assessment', '/mock/plan', '/mock/feedback', '/optimize-linkedin'].includes(v.rota), v.id);
    assert.ok(v.tuzak && v.denetimler.length, v.id);
  }
});
