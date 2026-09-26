/**
 * server/routes/mock.js — Sesli deneme mulakati (yol haritasi M1-M3, 26 Eylul 2026)
 *
 * practice.js icinden kaydediliyor (/api/v1/practice/mock/*): kimlik dogrulama
 * ve ucretsiz planin AI hakki sayaci oradaki kancalardan geliyor. /plan ve
 * /feedback sayaca giriyor (oturum basina 2 hak); /followup girmiyor.
 *
 * SES BURADA DEGIL. Ses tanima tarayicida, var olan canli hattan
 * (overlay-app/realtime-stt.js, /stt/session) geliyor ve sureyi /stt/heartbeat
 * sayiyor: kullanicinin karari, deneme mulakati canli mulakat dakikalarindan
 * duser. Seslendirme tarayicinin kendi sesi (speechSynthesis), maliyeti yok.
 *
 * Kaynak: "PrepWise" videosu (DEVAM.md, YOL HARITASI EKI). Oradan farkli:
 *   - sorular CV'den ve son ilandan kurulabiliyor, ama aday hakkinda CV'de
 *     olmayan bir sey IDDIA edilmiyor (K32)
 *   - geri bildirim sayi degil bant; her yargi adayin kendi cevabindan bir
 *     alintiyla ve alinti kodda araniyor (lib/mock-denetim.js)
 *
 * CANLI TEST (26 Eylul 2026, kullanicinin gercek CV'si): soru plani "You've
 * built a Power BI dashboard for inventory optimization" diye sordu. CV'de
 * Power BI bir BECERI, envanter kontrolu bir ROL; boyle bir proje yok. Model
 * iki gercegi birlestirip olmayan bir proje kurmustu. Istem artik bunu
 * adiyla yasakliyor. KODDA denetlenemiyor ("you built / you led" kaliplari
 * sayilamayacak kadar cesitli); koruma istemde, test istemin kuralini tutuyor.
 */

'use strict';

const { createMessage } = require('../lib/ai');
const { MOCK } = require('../lib/hata-kodlari');
const { NO_EM_DASH } = require('../lib/style-rules');
const { geriBildirimDenetle } = require('../lib/mock-denetim');

const TURLER   = ['behavioral', 'technical', 'mixed'];
const SEVIYELER = ['entry', 'mid', 'senior', 'lead'];
const EN_AZ_SORU = 3, EN_COK_SORU = 8;

function jsonCoz(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  try { return JSON.parse(s); } catch {}
  const b = s.indexOf('{'), e = s.lastIndexOf('}');
  if (b !== -1 && e > b) { try { return JSON.parse(s.slice(b, e + 1)); } catch {} }
  return null;
}

const MOCK_PLAN_SYSTEM = `You are an experienced interviewer preparing a spoken mock interview.

Return ONLY valid JSON (no markdown): {"questions": ["q1", "q2", ...]}
- Write exactly the requested number of questions, in the requested interview language.
- The candidate answers OUT LOUD. Ask questions that can be answered by speaking: no "write code", no whiteboard. Technical questions are conceptual, scenario or design questions for the role.
- Behavioral questions invite a real past example. Mixed means roughly half and half.
- Match the seniority level.
- If a job description is given, cover its main requirements.
- If a CV is given, you may ask about a role, project or tool that the CV names. NEVER state or assume anything about the candidate that the CV does not say: ask, do not claim.
- A skill listed in the CV is not a project. NEVER combine separate CV items (a skill, a tool, a job title, an employer) into a project, achievement or result the CV does not describe. Ask how they used a skill ("How have you used SAP in your work?"), do not assert a project ("You implemented SAP for the warehouse, walk me through it").
- One question per item, under 40 words, natural spoken style.` + NO_EM_DASH;

const MOCK_FOLLOWUP_SYSTEM = `You are an interviewer in a spoken mock interview. The candidate just answered.

Return ONLY valid JSON (no markdown): {"followup": "one short follow-up question"} or {"followup": null}
- Ask a follow-up only when it would help the candidate practise: the answer is vague, has no concrete example, does not say what THEY did, or has no result.
- If the answer is complete, return null.
- Base the follow-up only on what the candidate said. Never assume facts they did not say.
- Under 25 words, in the interview language.` + NO_EM_DASH;

const MOCK_FEEDBACK_SYSTEM = `You are an interview coach reviewing a spoken mock interview transcript.

Return ONLY valid JSON (no markdown):
{"categories": {
  "communication":   {"band": "strong|fair|weak|not_assessable", "comment": "...", "evidence": "..."},
  "technical":       {"band": "...", "comment": "...", "evidence": "..."},
  "problem_solving": {"band": "...", "comment": "...", "evidence": "..."},
  "role_fit":        {"band": "...", "comment": "...", "evidence": "..."},
  "confidence":      {"band": "...", "comment": "...", "evidence": "..."}
 },
 "strengths": ["..."], "improvements": ["..."], "summary": "two or three sentences"}

RULES
- Judge ONLY what the candidate said. Be honest and specific; weak answers are called weak.
- Judge each answer against its OWN question (A1 answers Q1, A2 answers Q2).
- A short answer that is relevant to its question is SHORT, not incoherent: say it needs more detail and an example. Call an answer incoherent only if it does not make sense as a reply to its question.
- Never infer a lack of knowledge or skill from a short answer. If no answer touches what a category measures (for example no technical question was asked), use "not_assessable".
- Each quote may support only ONE category; use a different quote for each category or mark it "not_assessable".
- "evidence" is an EXACT quote of at least 3 words copied from the candidate's answers (not from the questions). Copy it word for word.
- If the transcript does not show a category (for example no technical question was asked), use "not_assessable" with an empty evidence.
- No numbers or scores. No other categories.
- Spoken answers come from speech recognition and may contain small transcription errors; do not judge spelling.
- The candidate reads this feedback themselves: address them directly as "you" ("Your answer...", "You explained..."), never as "the candidate".
- Write comments, strengths, improvements and summary in the requested language.` + NO_EM_DASH;

// Mulakatci sesi. Ortam degiskeniyle degistirilebilir (dagitim gerekmeden ses denemek icin).
const MOCK_TTS_MODEL = process.env.MOCK_TTS_MODEL || 'gpt-4o-mini-tts';
// Kullanicinin karari (26 Eylul 2026): "coral" sert geldi. Varsayilan daha
// yumusak "sage"; kullanici kurulumda sesi kendisi secebiliyor. Beyaz liste
// istemcideki seciciyle ayni; disi varsayilana duser.
const MOCK_SESLERI = ['sage', 'shimmer', 'nova', 'coral', 'ash', 'onyx'];
const MOCK_TTS_SESI = MOCK_SESLERI.includes(process.env.MOCK_TTS_VOICE) ? process.env.MOCK_TTS_VOICE : 'sage';
// Ton: "sicak ama notr, profesyonel" resmi ve soguk duyuldu. Nötr kalkti;
// aday iyi yapsin isteyen, rahat, yumusak ve hafif yavas bir mulakatci.
const MOCK_TTS_TALIMAT = 'You are a warm, friendly job interviewer who genuinely wants the candidate to do well. '
  + 'Speak in a gentle, encouraging and relaxed way, as if you are smiling, at a slightly slow, natural '
  + 'conversational pace with soft intonation. Never sound stern, strict, cold, rushed or robotic.';

async function mockRoutes(fastify) {
  const yazi = (d, en) => (typeof d === 'string' ? d.trim().slice(0, en) : '');
  const dilSatiri = (b) => `Interview language: ${yazi(b.language, 40) || 'English'}`;

  async function sor({ system, icerik, butce, model }) {
    const ustveri = {};
    const raw = await createMessage({
      model, max_tokens: butce, system, messages: [{ role: 'user', content: icerik }],
    }, ustveri);
    return { raw, kesildi: !!ustveri.kesildi };
  }

  // ── POST /mock/plan — sorulari kur ──────────────────────────────────────
  fastify.post('/mock/plan', async (request, reply) => {
    const b = request.body ?? {};
    const rol = yazi(b.role, 120);
    if (rol.length < 2) return reply.code(422).send({ kod: MOCK.ROL_EKSIK, error: 'role required' });
    const tur    = TURLER.includes(b.type) ? b.type : 'mixed';
    const seviye = SEVIYELER.includes(b.level) ? b.level : 'mid';
    const adet   = Math.min(EN_COK_SORU, Math.max(EN_AZ_SORU, parseInt(b.count, 10) || 5));
    const cv = yazi(b.cv_text, 6000), ilan = yazi(b.jd_text, 6000);

    const satirlar = [`Role: ${rol}`, `Interview type: ${tur}`, `Seniority: ${seviye}`,
      `Number of questions: ${adet}`, dilSatiri(b),
      cv ? `Candidate CV:\n${cv}` : 'Candidate CV: (not given)',
      ilan ? `Job description:\n${ilan}` : 'Job description: (not given)'];
    try {
      const { raw, kesildi } = await sor({ system: MOCK_PLAN_SYSTEM, icerik: satirlar.join('\n'), butce: 900, model: 'claude-haiku' });
      if (kesildi) return reply.code(422).send({ kod: MOCK.YANIT_KESILDI, error: 'The response was cut off.' });
      const r = jsonCoz(raw);
      if (!r || typeof r !== 'object') {
        fastify.log.error({ rawChars: String(raw || '').length }, '[mock/plan] yanit cozulemedi');
        return reply.code(422).send({ kod: MOCK.COZULEMEDI, error: 'The response could not be read.' });
      }
      const sorular = (Array.isArray(r.questions) ? r.questions : [])
        .map((q) => yazi(q, 400)).filter(Boolean).slice(0, adet);
      if (!sorular.length) return reply.code(422).send({ kod: MOCK.URETILEMEDI, error: 'No questions were produced.' });
      return { questions: sorular, type: tur, level: seviye };
    } catch (err) {
      fastify.log.error(err, '[mock/plan]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /mock/followup — takip sorusu gerekli mi ───────────────────────
  // Mulakatin akisini durdurmamali: her hata "takip sorusu yok" demek.
  fastify.post('/mock/followup', async (request) => {
    const b = request.body ?? {};
    const soru = yazi(b.question, 600), cevap = yazi(b.answer, 4000);
    if (!soru || cevap.split(/\s+/).filter(Boolean).length < 4) return { followup: null };
    try {
      const { raw, kesildi } = await sor({ system: MOCK_FOLLOWUP_SYSTEM, butce: 200, model: 'claude-haiku',
        icerik: [dilSatiri(b), `Question:\n${soru}`, `Candidate's answer:\n${cevap}`].join('\n') });
      if (kesildi) return { followup: null };
      const r = jsonCoz(raw);
      const f = r && typeof r.followup === 'string' ? r.followup.trim().slice(0, 300) : '';
      return { followup: f || null };
    } catch (err) {
      fastify.log.warn({ err: err.message }, '[mock/followup] takip sorusu yok sayildi');
      return { followup: null };
    }
  });

  // ── POST /mock/speak — mulakatcinin sesi ────────────────────────────────
  // 26 Eylul 2026, kullanicinin karari (B): tarayici sesi robotikti ve masaustu
  // uygulamasinda dogal ses yok. OpenAI gpt-4o-mini-tts, dakikasi yaklasik
  // 0,015 dolar; bir oturumda sorular toplam 1-2 dakika. AI hakkindan dusmez
  // (oturumun suresi zaten canli dakikalardan dusuyor). Hata olursa istemci
  // tarayici sesine duser; bu yuzden hata govdesi kullaniciya gosterilmez.
  fastify.post('/mock/speak', async (request, reply) => {
    const b = request.body ?? {};
    const metin = yazi(b.text, 600);
    if (!metin) return reply.code(422).send({ error: 'text required' });
    const key = process.env.OPENAI_API_KEY;
    if (!key) return reply.code(503).send({ error: 'tts_unavailable' });
    try {
      const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MOCK_TTS_MODEL,
          voice: MOCK_SESLERI.includes(b.voice) ? b.voice : MOCK_TTS_SESI,
          input: metin,
          instructions: MOCK_TTS_TALIMAT,
          response_format: 'mp3',
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        fastify.log.warn({ status: res.status, body: t.slice(0, 200) }, '[mock/speak] seslendirme basarisiz');
        return reply.code(502).send({ error: 'tts_failed' });
      }
      const ses = Buffer.from(await res.arrayBuffer());
      return reply.type('audio/mpeg').send(ses);
    } catch (err) {
      fastify.log.warn({ err: err.message }, '[mock/speak] seslendirme hatasi');
      return reply.code(502).send({ error: 'tts_failed' });
    }
  });

  // ── POST /mock/feedback — oturum sonu geri bildirim ─────────────────────
  fastify.post('/mock/feedback', async (request, reply) => {
    const b = request.body ?? {};
    const turlar = (Array.isArray(b.turns) ? b.turns : []).slice(0, 24)
      .map((t) => ({ soru: yazi(t && t.question, 600), cevap: yazi(t && t.answer, 4000) }))
      .filter((t) => t.soru);
    const cevaplar = turlar.map((t) => t.cevap).filter(Boolean).join('\n');
    if (cevaplar.split(/\s+/).filter(Boolean).length < 5) {
      return reply.code(422).send({ kod: MOCK.CEVAP_YOK, error: 'No answers to review.' });
    }
    const transkript = turlar.map((t, i) =>
      `Q${i + 1} (interviewer): ${t.soru}\nA${i + 1} (candidate): ${t.cevap || '(no answer)'}`).join('\n\n');
    const satirlar = [`Role: ${yazi(b.role, 120) || '(not given)'}`, `Output language: ${yazi(b.language, 40) || 'English'}`,
      `Transcript:\n${transkript}`];
    try {
      const { raw, kesildi } = await sor({ system: MOCK_FEEDBACK_SYSTEM, icerik: satirlar.join('\n'), butce: 1800, model: 'claude-sonnet' });
      if (kesildi) return reply.code(422).send({ kod: MOCK.YANIT_KESILDI, error: 'The response was cut off.' });
      const r = jsonCoz(raw);
      if (!r || typeof r !== 'object') {
        fastify.log.error({ rawChars: String(raw || '').length }, '[mock/feedback] yanit cozulemedi');
        return reply.code(422).send({ kod: MOCK.COZULEMEDI, error: 'The response could not be read.' });
      }
      const g = geriBildirimDenetle(r, cevaplar);
      const hicYok = Object.values(g.categories).every((c) => c.band === 'not_assessable') && !g.summary;
      if (hicYok) return reply.code(422).send({ kod: MOCK.URETILEMEDI, error: 'No usable feedback was produced.' });
      return g;
    } catch (err) {
      fastify.log.error(err, '[mock/feedback]');
      return reply.code(500).send({ error: err.message });
    }
  });
}

module.exports = mockRoutes;
module.exports.MOCK_PLAN_SYSTEM = MOCK_PLAN_SYSTEM;
module.exports.MOCK_FOLLOWUP_SYSTEM = MOCK_FOLLOWUP_SYSTEM;
module.exports.MOCK_FEEDBACK_SYSTEM = MOCK_FEEDBACK_SYSTEM;
