/**
 * server/routes/practice.js — POST /api/v1/practice/evaluate
 *
 * Evaluates a user's STAR answer against a question's answer_framework
 * using Claude Sonnet. Returns a detailed scorecard.
 *
 * Request body:
 *   { question_id: string, user_answer: string, sector?: string }
 *
 * Response:
 *   {
 *     star_score: { situation, task, action, result },  // each 0-25
 *     total: 0-100,
 *     grade: "A+/A/B/C/D/F",
 *     key_points_hit: string[],
 *     key_points_missed: string[],
 *     strong_signals_present: string[],
 *     avoid_violations: string[],
 *     strengths: string,
 *     improvements: string,
 *     rewrite_tip: string
 *   }
 */

'use strict';

const { createMessage } = require('../lib/ai');
const { JD: JD_HATA, KAPAK: KAPAK_HATA, ATS: ATS_HATA, CVB: CVB_HATA, LI: LI_HATA, EL: EL_HATA, OA: OA_HATA, ONAY: ONAY_HATA } = require('../lib/hata-kodlari');
const { ONAY_SURUMLERI, onayDurumu, onayKaydet } = require('../lib/onay');
const { profilDenetimi, mevcutBaslikDogrula } = require('../lib/linkedin-denetim');
const { kaynaksizSayilariParantezle, zamanPlaniniDenkle } = require('../lib/oa-denetim');
const { eslesmeleriDogrula } = require('../lib/kelime-eslesme');
const path = require('path');
const fs   = require('fs');
const { requireAuth, requirePlan } = require('../middleware/auth');
const { checkAndIncrement } = require('../lib/usage');
const { NO_EM_DASH } = require('../lib/style-rules');

function safeParseJSON(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw.trim()); } catch {}
  const fenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(fenced); } catch {}
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) { try { return JSON.parse(raw.slice(start, end + 1)); } catch {} }
  return null;
}
// Question bank location.
// Deployed (Railway): the bank ships inside the server folder → server/questions/
// Local (Electron):   the bank lives in the project root → ../..
const BANK_DIR = fs.existsSync(path.join(__dirname, '..', 'questions', 'question_bank_index.json'))
  ? path.join(__dirname, '..', 'questions')
  : path.join(__dirname, '..', '..');

// ── Load question by ID across all sector files ───────────────────────────────
let _questionMap = null;

function getQuestionMap() {
  if (_questionMap) return _questionMap;

  _questionMap = new Map();

  const indexPath = path.join(BANK_DIR, 'question_bank_index.json');
  if (!fs.existsSync(indexPath)) {
    console.warn('[practice] question_bank_index.json not found at', indexPath, '— question bank is empty');
    return _questionMap;
  }

  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (err) {
    console.warn('[practice] Could not parse question_bank_index.json:', err.message);
    return _questionMap;
  }

  for (const entry of index.files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(BANK_DIR, entry.file), 'utf8'));
      for (const q of data.questions) {
        _questionMap.set(q.id, { ...q, _sector: entry.sector, _file: entry.file });
      }
    } catch (err) {
      console.warn(`[practice] Could not load ${entry.file}:`, err.message);
    }
  }

  console.log(`[practice] Loaded ${_questionMap.size} questions from ${BANK_DIR}`);
  return _questionMap;
}

// ── Evaluation system prompt ──────────────────────────────────────────────────
const EVAL_SYSTEM = `You are an expert interview coach evaluating a candidate's behavioral answer.
Your job is to give honest, specific, and constructive feedback based on the STAR method.

Score each STAR component from 0 to 25 (total 100):
- Situation (0-25): Was the context set clearly and concisely?
- Task (0-25): Was the candidate's specific challenge or responsibility clearly defined?
- Action (0-25): Were the candidate's own actions described in concrete, specific detail? (This carries the most weight.)
- Result (0-25): Was the outcome clearly stated with quantifiable impact or clear business value?

Grade scale: A+ (95-100), A (85-94), B (70-84), C (55-69), D (40-54), F (<40)

Return ONLY valid JSON, no markdown, no extra text:
{
  "star_score": { "situation": N, "task": N, "action": N, "result": N },
  "total": N,
  "grade": "X",
  "key_points_hit": ["exact framework points the candidate addressed"],
  "key_points_missed": ["exact framework points the candidate missed or glossed over"],
  "strong_signals_present": ["specific proof points or metrics the candidate demonstrated"],
  "avoid_violations": ["any 'avoid' items that appeared in the answer"],
  "strengths": "1-2 sentences on what the candidate did particularly well.",
  "improvements": "1-2 sentences on the single most impactful improvement to make.",
  "rewrite_tip": "Take their weakest sentence and rewrite it as a stronger version. Start with the original, then show the improved version."
}` + NO_EM_DASH;

// ─────────────────────────────────────────────────────────────────────────────

// ── Job Description Analysis system prompt ───────────────────────────────────
const JD_ANALYSIS_SYSTEM = `You are an expert interview preparation coach. Analyze the job description and extract key interview preparation data.

CRITICAL: Return ONLY a raw JSON object. Start with { and end with }. No markdown, no explanation, no code fences.
{
  "job_title": "extracted or inferred job title",
  "company": "the hiring employer's name exactly as written in the listing, or empty string if the listing does not name it",
  "sector": "one of: Supply Chain & Logistics, Finance, Operations & Manufacturing, General & Operations Management, Nursing (Registered Nurse), Healthcare Support, Accounting & Bookkeeping, Technology, Data Analyst, Logistics & Transportation, Inventory Planner, Inventory Analyst, Inventory Control Analyst, Universal Behavioral",
  "seniority": "one of: entry, mid, senior, manager",
  "key_skills": ["skill 1", "skill 2", "skill 3", "skill 4", "skill 5"],
  "focus_areas": ["theme 1", "theme 2", "theme 3"],
  "predicted_questions": [
    "Tell me about a time you...",
    "How have you handled...",
    "Describe a situation where...",
    "What is your experience with...",
    "How do you approach..."
  ]
}

Rules:
- key_skills: exactly 5-7 most critical skills from the JD, be specific
- focus_areas: exactly 3 interview themes (e.g. "Cross-functional collaboration", "Data-driven decision making")
- predicted_questions: exactly 5 behavioral or situational questions this company is MOST LIKELY to ask, written as actual interview questions
- seniority: infer from years of experience, title, and responsibilities mentioned
- company: the employer, not the recruiting agency and not the candidate. Copy the name as the listing writes it. If no employer is named, use an empty string, never guess` + NO_EM_DASH;

// ── Cover Letter system prompt ───────────────────────────────────────────────
// IKI BELGE KURALI NEDEN VAR. Olculdu (17 Eylul 2026): uydurma yasagi ve
// tarih kurali tuttuktan sonra kalan tek hata buydu. Wesco ilaninda
// "Executes accurate, scheduled daily, weekly, and monthly reports" yaziyordu;
// uretilen mektup "I have built and sustained rigorous inventory reporting
// cycles covering daily, weekly, and monthly cadences" dedi. CV'de `daily`,
// `weekly`, `monthly`, `cadence` kelimelerinin HICBIRI gecmiyor.
//
// Yani model, isverenin ARADIGI gorevi adayin YAPTIGI is gibi yazdi. Bu
// ucuncu ve farkli bir hata turu: ilk ikisi rakam uydurmak ve yanlis hesapti,
// bu iki belgeyi karistirmak. Ustelik en tehlikelisi, cunku hic uydurma gibi
// durmuyor ve mulakatta aday o gorevi anlatmak zorunda kaliyor.
//
// Onceki yasagin deligi belliydi: CV'yi "achievements, numbers, employers and
// dates" icin tek kaynak ilan ediyordu. Gorev tanimi bu dordunun hicbiri degil.
//
// SURE KURALI NEDEN VAR. Olculdu (16 Eylul 2026): kullanicinin CV'sinde
// "Inventory Control Specialist ... September 2022 to Present" yaziyordu,
// uretilen mektup "the past two and a half years" dedi. Gercek sure DORT yil.
// Model bugunun tarihini bilmedigi icin "Present"i kendi egitim verisinden
// tahmin etmis ve deneyimi on sekiz ay EKSIK gostermisti.
//
// Bu teknik olarak uydurma degil: gercek bir tarihten yanlis hesap. Uydurma
// yasagi ("CV'de olmayan sey yazma") bunu yakalayamiyordu, cunku tarih CV'de
// vardi. Cozum iki parcali: isteme bugunun tarihi giriyor ve sistem istemi
// sureyi kendi basina tahmin etmeyi yasakliyor.
const COVER_LETTER_SYSTEM = `You are an expert career coach and professional cover letter writer.
Write a compelling, personalized cover letter based on the provided candidate information and job description.

Rules:
- Exactly 4 paragraphs, 280-350 words total
- Paragraph 1: Strong opening hook: connect the candidate's specific background to THIS role (avoid "I am writing to express my interest")
- Paragraph 2: Most relevant achievement with concrete metrics or outcomes, taken ONLY from the candidate's CV text when one is provided
- Paragraph 3: Why this specific company/role, alignment with their mission or values
- Paragraph 4: Confident call-to-action close
- Match the tone requested (professional / warm / confident)
- Write in the same language as the job description
- Output ONLY the letter text: start with salutation, end with sign-off + candidate name
- Do NOT add subject line, date, or mailing addresses

NEVER INVENT FACTS. This letter is sent to a real employer under the candidate's name.
- If a CV text is provided, every achievement, number, employer, date and job title must come from it. Quote the candidate's real numbers, do not round them up and do not add new ones.
- If NO CV text is provided, you have no achievements to work with. Write about the skills and the role instead, in general but honest terms. Do not invent percentages, dollar amounts, team sizes, years, awards, employers or project names. A letter with no numbers is far better than a letter with invented ones.
- Never claim a certification, degree, tool or language that is not in the provided information

THE TWO DOCUMENTS ARE NOT THE SAME THING
- The job description says what the EMPLOYER WANTS. It is never evidence of what the candidate has done.
- Never write that the candidate has performed a task just because the listing asks for it. Only the CV can establish what they have done.
- You may write that the candidate is interested in or prepared for a responsibility. "I have done X" requires X to be in the CV.
- Do not state facts about the hiring company (rankings, revenue, headcount, awards, history) unless the job description states them. Write about the role and the work instead.

DATES AND DURATIONS
- The user prompt gives you today's date. Use ONLY that date to interpret "Present", "Current" or an open ended role.
- Prefer writing dates the way the CV writes them ("since September 2022") over computing a duration.
- If you do state a duration, compute it from today's date and round DOWN to a whole or half year. Never guess today's date.` + NO_EM_DASH;

// ── ATS Score system prompt ───────────────────────────────────────────────────
const ATS_SYSTEM = `You are an ATS (Applicant Tracking System) expert and resume analyst.
Compare the candidate's CV/resume against the job description and score their compatibility.

Return ONLY valid JSON, no markdown:
{
  "score": <integer 0-100>,
  "grade": "<A+|A|B|C|D|F>",
  "matched_keywords": ["keyword1", "keyword2"],
  "missing_keywords": ["keyword1", "keyword2"],
  "section_scores": {
    "skills_match": <0-100>,
    "experience_match": <0-100>,
    "education_match": <0-100>
  },
  "strengths": "1-2 sentences on CV strengths for this role",
  "gaps": "1-2 sentences on key gaps",
  "top_recommendations": ["specific actionable recommendation 1", "recommendation 2", "recommendation 3"]
}

Grade scale: A+ (90-100), A (80-89), B (65-79), C (50-64), D (35-49), F (<35)

LENGTH LIMITS (the response is cut off if you exceed them)
- At most 10 entries in "matched_keywords" and at most 10 in "missing_keywords". Pick the most important ones.
- "strengths" and "gaps": at most 2 sentences each.
- Exactly 3 entries in "top_recommendations", each under 30 words.
- Output the JSON only. No preamble, no explanation, no markdown fence.

EVIDENCE RULES
- A term belongs in "matched_keywords" ONLY if it appears in the CV. A term the job description asks for is not evidence that the candidate has it.
- "missing_keywords" are terms the job description uses that the CV does not contain.
- Base "strengths" only on what the CV states. Never credit the candidate with a responsibility that only the job description mentions.
- If the CV is thin on a requirement, say so in "gaps". An inflated score is worse than a low one: the candidate applies believing they match.`;
// Kanit kurallari 17 Eylul 2026'da eklendi. Gerekce K32 ile ayni: yalan iki
// yone de isler. Kapak mektubunda model kullanici ADINA uyduruyordu; burada
// kullaniciya KENDI hakkinda yaniltici bir olcum veriyor. Eslesen anahtar
// kelime listesi ilandan kopyalanirsa puan sisiyor ve kullanici uymadigi bir
// ise "uyuyorum" diyerek basvuruyor. Testler kuralin istemde OLDUGUNU
// kilitler, modelin ona uydugunu degil (K32'deki ayni sinir).

// ── Resume Builder system prompt ──────────────────────────────────────────────
const RESUME_SYSTEM = `You are an expert resume writer specializing in ATS-optimized, professional resumes.
Create a clean, well-structured resume from the provided information.

Format rules:
- Plain text only: no tables, no graphics, no columns, no special characters
- Use exact section headers: PROFESSIONAL SUMMARY, PROFESSIONAL EXPERIENCE, EDUCATION, SKILLS
- Bullet points with strong action verbs (Led, Developed, Achieved, Reduced, Increased, Built)
- Each bullet under 20 words
- Total length: 400-550 words
- Output ONLY the resume text, start directly with the candidate's name

NEVER INVENT FACTS
- Every employer, job title, date, school, degree and skill must come from the information given to you. Invent none of them.
- Numbers are the easiest thing to fabricate and the most damaging. Use a percentage, a dollar amount, a headcount or a volume ONLY if that exact number is in the information given. If none is given, write the achievement without a number.
- Do not upgrade a plain skill into a qualified one. "Excel" does not become "advanced Excel"; "reporting" does not become "executive reporting".

MISSING INFORMATION
- A field that was not provided is simply absent. Do not guess it, do not write a placeholder, and do not carry a label like "Company" or "Dates" into the resume.
- If a whole section has no information, leave that section out rather than filling it with invented content.

DATES
- Write dates exactly as they were given to you. Do not convert them, do not compute durations, and do not infer a year that was not provided.
- If a date was not given, omit it rather than estimating one.` + NO_EM_DASH;
// K32'nin uc kurali burada da geciyor, cunku bu metin de kullanicinin ADIYLA
// isverene gidiyor. Kaldirilan satir sunu diyordu:
//   "Quantify achievements with metrics where possible based on the provided
//    information"
// Nitelik ("based on the provided information") vardi ama emir kipi ondan
// guclu: modele "rakam koy" deniyor, eline rakam verilmiyordu. Kapak
// mektubunda ayni cumlenin bedeli olculmustu (K32): model rakami uyduruyor ve
// kullanici o metni isverene gonderiyordu.

// ── CV Adaptation system prompt ───────────────────────────────────────────────
const ADAPT_CV_SYSTEM = `You are an expert resume writer. Your job is to adapt a candidate's existing CV/resume to better match a specific job description.

Rules:
- Keep contact information, company names, job titles, and dates EXACTLY as provided, do NOT invent or change facts
- Rewrite the Professional Summary (2-3 sentences) to directly address this specific role
- Reorder the Skills section to prioritize the most relevant skills for this job
- Adjust 2-3 experience bullet points to better highlight relevant achievements using the job's keywords, only reframe existing information, never fabricate
- Keep education section unchanged
- Output ONLY the adapted CV text in plain text format
- Use the same section headers as the original CV` + NO_EM_DASH;

// ── Auto-apply package system prompt ─────────────────────────────────────────
const APPLY_PACKAGE_SYSTEM = `You are an expert career coach. Given a job description and candidate profile, create a complete application package.

Return ONLY valid JSON, no markdown:
{
  "match_score": <0-100>,
  "key_selling_points": ["point 1", "point 2", "point 3"],
  "tailored_cover_letter_opening": "2-3 sentence powerful opening paragraph only",
  "talking_points": ["specific talking point for interview", "talking point 2", "talking point 3", "talking point 4"],
  "questions_to_ask": ["thoughtful question to ask interviewer 1", "question 2", "question 3"],
  "red_flags": ["potential concern 1 (or empty array if none)"],
  "apply_recommendation": "Strong Match / Good Match / Partial Match / Weak Match"
}` + NO_EM_DASH;

// ── Online Assessment hazirligi ──────────────────────────────────────────────
// 24 Eylul 2026'da olculdu (K55). Kullanicinin karari: sayfa bir HAZIRLIK
// araci olarak kaliyor (ornek sorularla calismak, sinavdan sonra cevaplari
// gozden gecirmek); islevi ayni. Istemdeki degisiklikler:
//   - HireVue cevabi "Complete spoken STAR answer, first-person" diyordu ve
//     modele adayin gecmisi VERILMIYORDU. Model birinci agizdan bir hikaye
//     uyduruyor, aday onu kayitli bir mulakatta kendi hikayesi gibi
//     anlatiyordu. K32'nin en agir hali. Artik CV varsa oradan kuruluyor,
//     yoksa [koseli parantezli] bir iskelet veriliyor.
//   - 25 Eylul 2026 (K55 eki): gercek CV ile model CV'de OLMAYAN bir olay
//     kurdu ve parantezsiz yazdi. Artik CV'den yalnizca yazanlar (isveren,
//     unvan, tarih, sistem, gorev) kullaniliyor; olayin kendisi CV'de
//     yoksa parantezde kaliyor. Anahtar noktalar basari cumlesi degil,
//     yonlendirme. Sayilar ve zaman plani lib/oa-denetim.js'de kodda.
//   - Kullanici kendi cevabini yazarsa degerlendiriliyor (istege bagli).
//   - Ciktilarin hepsi JSON; eskiden coktan secmeli duz metindi ve cikti
//     denetimi yoktu.
const OA_FEEDBACK_RULES = `
IF THE CANDIDATE'S OWN ANSWER IS GIVEN
- Add a "feedback" object: {"strengths": ["..."], "gaps": ["..."], "summary": "one or two sentences"}.
- Judge only what the candidate wrote. Be specific and honest; an answer that is wrong must be called wrong.
- If no own answer is given, omit "feedback".`;

const OA_CODING_SYSTEM = `You are an expert coding interview coach. The candidate is preparing for or reviewing an online coding assessment.

Return ONLY valid JSON (no markdown):
{"approach": "brief approach", "time_complexity": "O(?)", "space_complexity": "O(?)", "solution_code": "complete runnable code in the requested programming language", "step_by_step": "numbered steps that explain the solution so the candidate can learn it", "talking_points": ["tp1", "tp2", "tp3"]}
- Write explanations in the requested output language. Code, identifiers and complexity notation stay as they are.
${OA_FEEDBACK_RULES}` + NO_EM_DASH;

const OA_WRITTEN_SYSTEM = `You are an expert assessment coach. The candidate is preparing for or reviewing a multiple choice or written assessment question.

Return ONLY valid JSON (no markdown):
{"analysis": "the correct answer and why, the reasoning behind it, and why the other options are wrong when there are options"}
- Be direct and specific. If the question is ambiguous or you are not sure, say so instead of guessing.
${OA_FEEDBACK_RULES}` + NO_EM_DASH;

const OA_VIDEO_SYSTEM = `You are an expert video interview coach (HireVue style). The candidate is preparing an answer they will speak in their own words.

Return ONLY valid JSON (no markdown):
{
  "key_points": ["3-5 things this answer should cover, written as coaching guidance for the candidate (for example 'Name the system where you spotted the gap'), never as achievements; max 10 words each"],
  "answer_draft": "a spoken STAR answer, 60-90 words, natural first-person tone",
  "avoid": ["3 things to avoid for this question"],
  "time_plan": "how to split the time limit across STAR; the seconds must add up to the time limit, e.g. S:20s T:15s A:55s R:30s for 120 seconds"
}

NEVER INVENT THE CANDIDATE'S EXPERIENCE. They will say this answer on a recorded interview as their own story.
- From the CV, use only what it actually states: employers, job titles, dates, systems and tools (for example a WMS or ERP name), duties, and achievements written there.
- A CV rarely describes a specific incident. Every story detail the CV does not state stays as a placeholder in square brackets: the specific situation, its cause, what the candidate did, who they worked with, and the result. For example: "At Acme Logistics I handled stock control in SAP. I noticed [the discrepancy you found] and traced it to [the root cause]. I [what you did], and [the result]."
- A plausible detail is still an invented detail. Do not describe an event, a cause, a colleague, a team or a result unless the CV states it.
- Use numbers ONLY if that exact number is in the CV.
- If no CV is given, you do not know their story. Write the answer as a skeleton with clear placeholders in square brackets, for example "When I was working as [your role] at [company], [the situation]...". Do not fill the placeholders with invented details.
- Situational questions use hypothetical framing ("In that situation I would..."); they may describe an approach without claiming past experience.
${OA_FEEDBACK_RULES}` + NO_EM_DASH;

// ── Deneyim / referans mektubu ve IK rica e-postasi ──────────────────────────
// 24 Eylul 2026'da olculdu (K54). Eski istem:
//
//   "Write a formal ${typeLabel} ... Use professional business letter format
//    with date, recipient section, body paragraphs, and signature block."
//
// Uc kusur: (1) modele bugunun tarihi verilmiyordu, yani imzali bir belgenin
// ustundeki tarih modelin TAHMINIYDI (K32'nin tarih hatasi); (2) uydurma
// yasagi yoktu, bos basari alanina "general duties performed
// satisfactorily" gidiyordu ve yonetici dogrulamadigi iddialari
// imzalayacakti; (3) "Employment Verification" turu, isverenin KENDI
// kayitlarindan verecegi resmi belgeyi calisana urettiriyordu. O tur,
// kullanicinin onayiyla IK'dan belge isteyen bir e-postaya donustu.
//
// 24 Eylul 2026, canli deneme (kullanicinin ekran goruntusu): iki kural daha.
//   - Tarih verilmeyince model koseli parantez yerine mektuba NOT yazdi:
//     "the employment dates are not available to me at this time and should
//     be verified...". Yonetici bunu imzalarsa "tarihler bende yok" diyen bir
//     mektup imzalar. Yer tutucu artik cumlenin ICINDE.
//   - Model "Akin" adindan cinsiyet cikarip "his time" yazdi. Bu kullanici
//     icin dogru, bir baskasi icin yanlis; imzali belgede yanlis zamir
//     cok gorunur. Zamir verilmedigi icin ad ya da cinsiyetsiz ifade.
const LETTER_RULES = `
NEVER INVENT FACTS. Someone will sign or send this under their own name.
- Every employer, job title, date, responsibility, achievement and number must come from the information given to you.
- Use a percentage, an amount, a headcount or any other number ONLY if that exact number was given. If none was given, write without numbers.
- If no responsibilities or achievements were given, confirm the employment and the title in plain terms. Do not invent duties or praise.
- Do not upgrade anything: "team member" does not become "team lead", "helped with" does not become "led".

MISSING INFORMATION
- If a name, title or date that the text needs was not given, write a clear placeholder in square brackets, for example [Manager Name] or [Start date - End date], so the person can fill it in before signing or sending. Never guess it.
- Put the placeholder inside the sentence where the information belongs, for example "worked with us from [Start date] to [End date]". Never write a note about missing information into the text (such as "the dates are not available to me"): whoever signs it would be signing that note.

PRONOUNS
- You do not know the employee's gender. Do not infer it from their name. Refer to them by name, or use wording without a gendered pronoun ("during their time with us", or the employee's name).

DATES
- The user prompt gives you today's date. Use it as the date of the letter or email, written in the conventions of the output language. Never guess today's date.
- Write employment dates exactly as they were given. Do not compute or restate a duration that was not given.`;

const EXPERIENCE_LETTER_SYSTEM = `You are an experienced HR professional. Write a DRAFT letter that a former manager will review and sign. The letter is written in the manager's voice about the employee.

Output ONLY the letter text: no explanation, no markdown, no JSON. Use a professional business letter format: date, a "To Whom It May Concern" style salutation, body paragraphs, and a signature block for the manager.
- "experience": confirms the employment, the title, the dates and the responsibilities.
- "reference": a recommendation letter; it may express the manager's opinion only in general terms that follow from the information given.
- Keep the letter between 150 and 350 words.
${LETTER_RULES}` + NO_EM_DASH;

const HR_REQUEST_SYSTEM = `You are an experienced career coach. Write a short, polite email FROM the employee TO the HR department of their former employer, asking for an employment verification letter that confirms their employment dates and job title.

Output ONLY the email: a "Subject:" line, then the body, then the employee's name. No explanation, no markdown, no JSON.
- Ask what the letter should confirm (dates of employment, job title) and ask how and when it can be provided.
- Do not ask for salary information and do not mention salary.
- Keep it under 150 words.
${LETTER_RULES}` + NO_EM_DASH;

// ── LinkedIn optimizer system prompt ─────────────────────────────────────────
// K32'NIN UC KURALI BURADA DA GECIYOR, ve burada daha agir: kapak mektubunu
// tek bir isveren okur, LinkedIn profilini HERKES. 23 Eylul 2026'da olculdu
// (K53), eski istem sunlari diyordu:
//
//   "quantified achievements"   "include 2-3 numbers"
//   "about ... 2400-2500 chars" "Skills: pick the 10 most searched/valued
//                                for the target role"
//
// ve hicbir yerde "uydurma" demiyordu. Profilde rakam yoksa modelin tek
// secenegi rakam uydurmakti; ince bir profili 2.400 karaktere cikarmak icin
// tek secenegi dolgu yazmakti; "hedef pozisyon icin en degerli 10 beceri"
// ise kullanicinin SAHIP OLMADIGI becerileri profiline koymakti.
//
// Beceri ile anahtar kelime bu yuzden ayrildi: `skills` profilde gorunen
// beceriler (kullanici hakkinda iddia), `keywords` recruiter aramalari
// (kullaniciya tavsiye). Ikisini karistirmak K32'nin ucuncu hatasi: isverenin
// ISTEDIGINI adayin YAPTIGI gibi yazmak.
//
// Puan alanlari (score_before, score_after, score_note) kaldirildi; yerine
// kodda olculen liste geldi (lib/linkedin-denetim.js).
const LINKEDIN_SYSTEM = `You are a senior LinkedIn profile writer. You rewrite the candidate's own LinkedIn profile so that recruiters searching for the target role find it and read it.

Return ONLY valid JSON (no markdown, no preamble):
{
  "headline_before": "<the current headline copied exactly from the profile text, or an empty string if you cannot find it>",
  "headline": "<new headline, at most 220 characters>",
  "about": "<new About section, at most 2,600 characters>",
  "skills": ["up to 10 skills"],
  "keywords": ["up to 8 search terms"],
  "recommendations": ["exactly 5 specific improvements"]
}

WHAT EACH FIELD MAY CONTAIN
- headline: role + what the candidate does + a differentiator, 3-4 keywords separated by | or ·. No buzzwords like "results-driven".
- about: first person, open with a hook (not "I am"), put the most important keywords in the first three lines, end with an invitation to connect. Length follows the material: a thin profile gets a short About. Never pad to reach a length.
- skills: skills the profile shows the candidate HAS, ordered by value for the target role. At most 10. If the profile supports fewer, return fewer.
- keywords: terms recruiters search for when hiring for this role. These are advice for the candidate, not claims about them, and may include skills the profile does not show.
- recommendations: specific actions (e.g. "Add a Featured section with your top project", not "improve your profile"). If an important skill for the target role is missing from the profile, write "if you have X, add it"; never assume they have it.

NEVER INVENT FACTS. This text is published on the candidate's public profile under their name.
- Every employer, job title, date, school, degree, certification, tool and achievement in the headline and About must come from the profile text.
- Use a percentage, a dollar amount, a headcount, a volume or any other number ONLY if that exact number is in the profile text. If the profile has no numbers, write the About without numbers. A profile with no numbers is far better than one with invented ones.
- Do not upgrade a skill: "Excel" does not become "advanced Excel", "reporting" does not become "executive reporting".
- Do not upgrade a language level either: "fluent" does not become "native", "proficient" does not become "fluent". Keep the level the profile states.

THE TARGET ROLE IS NOT EVIDENCE
- The target role, the industry and any roles the profile says the candidate is "open to" say what the candidate WANTS. They are never evidence of what the candidate has done.
- Never write that the candidate has done a task or has a skill because the target role usually requires it. You may write that they are moving toward that role or are interested in it.
- In the headline, a wanted role may appear only as something the candidate is open to ("Open to Supply Chain Analyst roles"). Never present it as their current or past title. The title part of the headline must be one the profile shows they hold or held.

DATES AND DURATIONS
- The user prompt gives you today's date. Use ONLY that date to interpret "Present", "Current" or an open ended role.
- Prefer writing dates the way the profile writes them ("since September 2022") over computing a duration.
- If you do state a duration, compute it from today's date and round DOWN to a whole year. Never guess today's date.` + NO_EM_DASH;

// ── Generate prompt for custom questions ─────────────────────────────────────
const GENERATE_SYSTEM = `You are an expert interview coach. Given any interview question, generate a structured answer framework.
Return ONLY valid JSON, no markdown:
{
  "key_points": ["specific point to address", "specific point to address", "specific point to address"],
  "strong_answer_signals": ["metric or proof point to include", "metric or proof point to include"],
  "avoid": ["common mistake to avoid", "common mistake to avoid"],
  "suggested_answer": "1-2 sentence strong STAR-structured model answer under 50 words."
}` + NO_EM_DASH;

// Endpoints that cost an AI call — these count against the Free plan's monthly
// allowance. Cheap lookups (/questions) and plain scraping are deliberately absent.
const METERED_ROUTES = new Set([
  '/analyze-jd',
  '/generate',
  '/generate-answers',
  '/evaluate',
  '/evaluate-custom',
  '/cover-letter',
  '/ats-score',
  '/adapt-cv',
  '/build-resume',
  '/full-package',
  '/apply-package',
  '/online-assessment',
  '/experience-letter',
  '/optimize-linkedin',
  // Sesli deneme mulakati: oturum basina 2 hak (soru plani + geri bildirim).
  // /mock/followup bilerek disarida; takip sorusu ayri bir hak yemesin.
  '/mock/plan',
  '/mock/feedback',
]);

/** Route path without the /api/v1/practice prefix, across Fastify versions. */
function routeTail(request) {
  const full = request.routeOptions?.url || request.routerPath || request.url || '';
  const i = full.indexOf('/api/v1/practice');
  return i === -1 ? full : full.slice(i + '/api/v1/practice'.length);
}

async function practiceRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // ── Free plan metering ──────────────────────────────────────────────────
  // Paid plans short-circuit inside checkAndIncrement, so this is a no-op for them.
  // 429 + `monthly_limit_reached` matches what the overlay already handles.
  fastify.addHook('preHandler', async (request, reply) => {
    if (request.method !== 'POST') return;
    if (!METERED_ROUTES.has(routeTail(request))) return;

    const usage = await checkAndIncrement(request.user);
    if (!usage.allowed) {
      return reply.code(429).send({
        error:   'monthly_limit_reached',
        message: `Free plan limit of ${usage.limit} AI requests/month reached. Upgrade to Pro for unlimited use.`,
        used:    usage.used,
        limit:   usage.limit,
      });
    }
  });

  // ── POST /analyze-jd — analyze job description, predict interview questions ─
  fastify.post('/analyze-jd', async (request, reply) => {
    const { job_description } = request.body ?? {};

    // Hata METNI degil KOD donuyoruz: sunucu kullanicinin dilini bilmez (K25).
    // Onceden duz Ingilizce metin doner, arayuz onu oldugu gibi basardi.
    const jd = String(job_description || '').trim();

    if (/^https?:\/\//i.test(jd)) {
      return reply.code(422).send({
        kod:   JD_HATA.URL_YAPISTIRILDI,
        error: 'Paste the listing text, not a link.',
      });
    }
    if (jd.length < 50) {
      return reply.code(422).send({
        kod:   JD_HATA.KISA_METIN,
        error: 'job_description required (min 50 chars)',
      });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });
    }

    try {
      const raw = await createMessage({
        model:      request.body?.model || 'claude-haiku',
        max_tokens: 1500,
        system:     JD_ANALYSIS_SYSTEM,
        messages:   [{ role: 'user', content: `Job Description:\n\n${jd}` }],
      });

      const analysis = safeParseJSON(raw);
      if (!analysis) {
        fastify.log.error({ rawChars: (raw || '').length }, '[analyze-jd] AI yaniti cozulemedi');
        return reply.code(422).send({
          kod:   JD_HATA.COZULEMEDI,
          error: 'Could not read that job listing.',
        });
      }

      // ── CIKTI DOGRULAMASI ──────────────────────────────────────────────────
      //
      // 16 Eylul 2026'da olculdu: burada hicbir denetim yoktu. AI bos diziler
      // donse bile 200 donuyor, arayuz sonuc panelini aciyor ve ustune yesil
      // "overlay'e yuklendi" rozetini basiyordu. Kullanici basari goruyor,
      // ekranda hicbir sey yok. CV yuklemede ayni sinif zaten yakalanmisti.
      const beceri = Array.isArray(analysis.key_skills) ? analysis.key_skills.filter(Boolean) : [];
      const soru   = Array.isArray(analysis.predicted_questions)
        ? analysis.predicted_questions.filter(Boolean) : [];

      if (!beceri.length && !soru.length) {
        fastify.log.info({ jdChars: jd.length }, '[analyze-jd] AI hicbir alan cikaramadi');
        return reply.code(422).send({
          kod:   JD_HATA.ALAN_CIKMADI,
          error: 'No interview data could be extracted from that listing.',
        });
      }

      return { ...analysis, key_skills: beceri, predicted_questions: soru };
    } catch (err) {
      fastify.log.error(err, '[practice/analyze-jd]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /generate — generate answer framework for any custom question ────
  fastify.post('/generate', async (request, reply) => {
    const { question_text, sector = 'general', seniority = 'mid' } = request.body ?? {};

    if (!question_text || question_text.trim().length < 10) {
      return reply.code(400).send({ error: 'question_text required (min 10 chars)' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });
    }

    const userPrompt = `Sector: ${sector}\nSeniority: ${seniority}\nQuestion: "${question_text.trim()}"`;

    try {
      const raw = await createMessage({
        model:      request.body?.model || 'claude-haiku',
        max_tokens: 400,
        system:     GENERATE_SYSTEM,
        messages:   [{ role: 'user', content: userPrompt }],
      });
      const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      let framework;
      try { framework = JSON.parse(clean); }
      catch { return reply.code(500).send({ error: 'Parse failed', raw }); }

      return { question_text: question_text.trim(), sector, seniority, ...framework };
    } catch (err) {
      fastify.log.error(err, '[practice/generate]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /evaluate-custom — evaluate answer to a custom (non-bank) question
  fastify.post('/evaluate-custom', async (request, reply) => {
    const { question_text, user_answer, key_points = [], strong_answer_signals = [], avoid = [], sector = 'general', seniority = 'mid' } = request.body ?? {};

    if (!question_text || !user_answer || user_answer.trim().length < 20) {
      return reply.code(400).send({ error: 'question_text and user_answer (min 20 chars) required' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });
    }

    const userPrompt = `
INTERVIEW QUESTION:
"${question_text.trim()}"

Sector: ${sector}
Seniority: ${seniority}

ANSWER FRAMEWORK:
Key points to address:
${key_points.map((p) => `  • ${p}`).join('\n') || '  • Not specified: evaluate on general STAR quality'}

Strong signals:
${strong_answer_signals.map((s) => `  ✓ ${s}`).join('\n') || '  ✓ Quantified outcomes, specific actions'}

Things to avoid:
${avoid.map((a) => `  ✗ ${a}`).join('\n') || '  ✗ Vague answers, no numbers'}

CANDIDATE'S ANSWER:
"${user_answer.trim()}"

Evaluate this answer and return the JSON scorecard.`.trim();

    try {
      const raw = await createMessage({
        model:      request.body?.model || 'claude-sonnet',
        max_tokens: 600,
        system:     EVAL_SYSTEM,
        messages:   [{ role: 'user', content: userPrompt }],
      });
      const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      let evaluation;
      try { evaluation = JSON.parse(clean); }
      catch { return reply.code(500).send({ error: 'Parse failed', raw }); }

      return { question_text: question_text.trim(), ...evaluation };
    } catch (err) {
      fastify.log.error(err, '[practice/evaluate-custom]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── GET /questions — list all questions for the practice UI ───────────────
  fastify.get('/questions', async (request) => {
    const { sector, seniority, category } = request.query;
    const qmap = getQuestionMap();
    let questions = Array.from(qmap.values());

    if (sector)    questions = questions.filter((q) => q._file?.includes(sector));
    if (seniority) questions = questions.filter((q) => q.seniority.includes(seniority));
    if (category)  questions = questions.filter((q) => q.category === category);

    return {
      count: questions.length,
      questions: questions.map(({ id, text, category, seniority, _sector }) => ({
        id, text, category, seniority, sector: _sector,
      })),
    };
  });

  // ── POST /evaluate — evaluate a STAR answer ───────────────────────────────
  fastify.post('/evaluate', async (request, reply) => {
    const { question_id, user_answer } = request.body ?? {};

    if (!question_id || typeof question_id !== 'string') {
      return reply.code(400).send({ error: 'question_id required' });
    }
    if (!user_answer || user_answer.trim().length < 20) {
      return reply.code(400).send({ error: 'user_answer must be at least 20 characters' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set in .env' });
    }

    // ── Find the question ────────────────────────────────────────────────────
    const qmap    = getQuestionMap();
    const question = qmap.get(question_id);

    if (!question) {
      return reply.code(404).send({ error: `Question ${question_id} not found` });
    }

    const { text, answer_framework, seniority, _sector } = question;
    const { key_points, strong_answer_signals, avoid } = answer_framework;

    // ── Build evaluation prompt ──────────────────────────────────────────────
    const userPrompt = `
INTERVIEW QUESTION:
"${text}"

Sector: ${_sector}
Seniority Level: ${seniority.join(', ')}

ANSWER FRAMEWORK (what a strong answer covers):
Key points to address:
${key_points.map((p) => `  • ${p}`).join('\n')}

Strong answer signals to look for:
${strong_answer_signals.map((s) => `  ✓ ${s}`).join('\n')}

Things to avoid:
${avoid.map((a) => `  ✗ ${a}`).join('\n')}

CANDIDATE'S ANSWER:
"${user_answer.trim()}"

Evaluate this answer against the framework and return your JSON scorecard.`.trim();

    const start = Date.now();

    try {
      const raw = await createMessage({
        model:      request.body?.model || 'claude-sonnet',
        max_tokens: 600,
        system:     EVAL_SYSTEM,
        messages:   [{ role: 'user', content: userPrompt }],
      });
      const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

      let evaluation;
      try {
        evaluation = JSON.parse(clean);
      } catch {
        // Ham yanitin tamami degil ilk 200 karakter: bu metin kullanicinin
        // CV'sinden ve sorusundan turuyor, loga tam girmemeli.
        fastify.log.error({ rawPreview: String(raw || '').slice(0, 200) }, '[practice] Failed to parse Claude JSON response');
        return reply.code(500).send({ error: 'Evaluation parsing failed', raw });
      }

      return {
        question_id,
        question_text: text,
        ...evaluation,
        eval_ms: Date.now() - start,
      };

    } catch (err) {
      fastify.log.error(err, '[practice] Claude API error');
      return reply.code(500).send({ error: 'Evaluation failed', detail: err.message });
    }
  });

  // ── GET/POST /onay/:ozellik — ozellik onayi (K56) ─────────────────────────
  //
  // Kullanicinin karari (B secenegi): onay tarayicida degil SUNUCUDA kayitli.
  // Kim, ne zaman, hangi metin surumunu onayladi. Metin surumu tek kaynaktan
  // (lib/onay.js) gelir; istemci eski bir surumu onaylarsa kabul edilmez.
  fastify.get('/onay/:ozellik', async (request, reply) => {
    const ozellik = request.params.ozellik;
    const surum = ONAY_SURUMLERI[ozellik];
    if (!surum) return reply.code(404).send({ kod: ONAY_HATA.BILINMEYEN, error: 'Unknown feature.' });
    const durum = await onayDurumu(request.user, ozellik);
    if (durum === 'okunamadi') {
      return reply.code(503).send({ kod: ONAY_HATA.KAYDEDILEMEDI, error: 'Consent record could not be read.' });
    }
    return { ozellik, surum, onaylandi: durum === 'var' };
  });

  fastify.post('/onay/:ozellik', async (request, reply) => {
    const ozellik = request.params.ozellik;
    const surum = ONAY_SURUMLERI[ozellik];
    if (!surum) return reply.code(404).send({ kod: ONAY_HATA.BILINMEYEN, error: 'Unknown feature.' });
    if (Number(request.body?.surum) !== surum) {
      return reply.code(409).send({ kod: ONAY_HATA.SURUM_ESKI, error: 'The consent text has changed.', surum });
    }
    const yazildi = await onayKaydet(request.user, ozellik, request.body?.dil);
    if (!yazildi) {
      fastify.log.error({ ozellik }, '[onay] kaydedilemedi');
      return reply.code(503).send({ kod: ONAY_HATA.KAYDEDILEMEDI, error: 'Consent could not be saved.' });
    }
    return { ozellik, surum, onaylandi: true };
  });

  // ── POST /online-assessment — sinav hazirligi (K55) ────────────────────────
  // Ucretli katmanlar: HireVue bir video mulakat elemesi, TestGorilla yetenek
  // sinavi. Elemeyi ust katmana kilitlemek, Pro musterisini mulakata varmadan
  // savunmasiz birakirdi.
  //
  // 24 Eylul 2026'da olculdu: girdiler beyaz listesizdi (platform, dil ve zorluk
  // isteme ham giriyordu), cozulemeyen yanitta modelin HAM metni istemciye
  // donuyordu, kesilme ve cikti denetimi yoktu, hatalar duz metindi.
  fastify.post('/online-assessment', { preHandler: requirePlan() }, async (request, reply) => {
    const b = request.body ?? {};
    const sec = (d, liste, varsayilan) => (liste.includes(d) ? d : varsayilan);
    const yazi = (d, en) => (typeof d === 'string' ? d.trim().slice(0, en) : '');

    const soru = yazi(b.question, 6000);
    if (soru.length < 10) {
      return reply.code(422).send({ kod: OA_HATA.KISA_SORU, error: 'question required (min 10 chars)' });
    }
    // ONAY KAPISI (K56). Kullanici uyariyi onaylamadan bolum calismiyor ve
    // onay SUNUCUDA kayitli olmali: istemcideki kutu atlanarak dogrudan bu
    // uca istek atilsa da kapi burada. Tablo okunamazsa kapi KAPALI kalir.
    const onay = await onayDurumu(request.user, 'online-assessment');
    if (onay === 'okunamadi') {
      fastify.log.error('[online-assessment] onay tablosu okunamadi');
      return reply.code(503).send({ kod: OA_HATA.ONAY_OKUNAMADI, error: 'Consent record could not be read.' });
    }
    if (onay !== 'var') {
      return reply.code(428).send({ kod: OA_HATA.ONAY_GEREKLI, error: 'Consent required.',
        surum: ONAY_SURUMLERI['online-assessment'] });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });
    }

    const PLATFORM = { hirevue: 'HireVue', codesignal: 'CodeSignal', hackerrank: 'HackerRank',
      codility: 'Codility', testgorilla: 'TestGorilla', general: 'a general online assessment' };
    const platform  = PLATFORM[b.platform] || PLATFORM.general;
    const tur       = sec(b.question_type, ['video_behavioral', 'video_situational', 'coding', 'mcq', 'written'], 'video_behavioral');
    const programDili = sec(b.language, ['Python', 'JavaScript', 'Java', 'C++', 'SQL'], 'Python');
    const zorluk    = sec(b.difficulty, ['Easy', 'Medium', 'Hard'], 'Medium');
    const sure      = Math.min(Math.max(parseInt(b.time_limit, 10) || 120, 0), 3600);
    const ciktiDili = yazi(b.output_language, 40) || 'auto';
    const kendi     = yazi(b.own_answer, 4000);
    const cv        = yazi(b.cv_text, 6000);

    const dilSatiri = ciktiDili === 'auto'
      ? 'Output language: the same language the question is written in.'
      : `Output language: ${ciktiDili}.`;
    const satirlar = [`Platform: ${platform}`, dilSatiri];
    let system, butce;
    if (tur === 'coding') {
      system = OA_CODING_SYSTEM; butce = kendi ? 2000 : 1500;
      satirlar.push(`Programming language: ${programDili}`, `Difficulty: ${zorluk}`);
    } else if (tur === 'mcq' || tur === 'written') {
      system = OA_WRITTEN_SYSTEM; butce = kendi ? 1200 : 900;
      satirlar.push(`Question type: ${tur === 'mcq' ? 'multiple choice' : 'written'}`);
    } else {
      system = OA_VIDEO_SYSTEM; butce = kendi ? 1100 : 700;
      const dk = Math.floor(sure / 60), sn = sure % 60;
      satirlar.push(`Question type: ${tur === 'video_situational' ? 'situational' : 'behavioral'}`,
        `Time limit: ${sure ? `${`${dk ? `${dk} min ` : ''}${sn ? `${sn}s` : ''}`.trim()} (${sure} seconds)` : 'none'}`,
        cv ? `Candidate CV:\n${cv}` : 'Candidate CV: (not given)');
    }
    satirlar.push(`Question:\n${soru}`);
    if (kendi) satirlar.push(`Candidate's own answer:\n${kendi}`);

    try {
      const ustveri = {};
      const raw = await createMessage({
        model:      b.model || (tur === 'coding' ? 'claude-sonnet' : 'claude-haiku'),
        max_tokens: butce,
        system,
        messages:   [{ role: 'user', content: satirlar.join('\n') }],
      }, ustveri);

      if (ustveri.kesildi) {
        fastify.log.warn({ tur, cikti_token: ustveri.cikti_token }, '[online-assessment] yanit kesildi');
        return reply.code(422).send({ kod: OA_HATA.YANIT_KESILDI, error: 'The response was cut off.' });
      }
      const r = safeParseJSON(raw);
      if (!r || typeof r !== 'object') {
        fastify.log.error({ tur, rawChars: String(raw || '').length }, '[online-assessment] yanit cozulemedi');
        return reply.code(422).send({ kod: OA_HATA.COZULEMEDI, error: 'The response could not be read.' });
      }

      const metin = (d, en = 8000) => (typeof d === 'string' ? d.trim().slice(0, en) : '');
      const liste = (d, en) => (Array.isArray(d) ? d : [])
        .map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean).slice(0, en);
      const geri = r.feedback && typeof r.feedback === 'object' && kendi ? {
        strengths: liste(r.feedback.strengths, 6),
        gaps:      liste(r.feedback.gaps, 6),
        summary:   metin(r.feedback.summary, 800),
      } : null;

      let cikti;
      if (tur === 'coding') {
        cikti = { type: 'coding', approach: metin(r.approach, 1000), time_complexity: metin(r.time_complexity, 60),
          space_complexity: metin(r.space_complexity, 60), solution_code: metin(r.solution_code, 12000),
          step_by_step: metin(r.step_by_step, 4000), talking_points: liste(r.talking_points, 6) };
        if (!cikti.solution_code) cikti = null;
      } else if (tur === 'mcq' || tur === 'written') {
        cikti = { type: 'mcq', analysis: metin(r.analysis, 6000) };
        if (!cikti.analysis) cikti = null;
      } else {
        // K55 eki: CV + soruda olmayan sayi "[number]" olur; plan secilen
        // sureye denklenir. Ikisi de modelden bagimsiz, kodda.
        const kaynak = `${cv}\n${soru}`;
        cikti = { type: 'video',
          key_points: liste(r.key_points, 6).map((k) => kaynaksizSayilariParantezle(k, kaynak)),
          answer_draft: kaynaksizSayilariParantezle(metin(r.answer_draft, 2000), kaynak),
          avoid: liste(r.avoid, 5), time_plan: zamanPlaniniDenkle(metin(r.time_plan, 400), sure) };
        if (!cikti.key_points.length || !cikti.answer_draft) cikti = null;
      }
      if (!cikti) {
        fastify.log.info({ tur }, '[online-assessment] cikti bos');
        return reply.code(422).send({ kod: OA_HATA.URETILEMEDI, error: 'No usable answer was produced.' });
      }
      if (geri) cikti.feedback = geri;
      return cikti;
    } catch (err) {
      fastify.log.error(err, '[practice/online-assessment]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── /linkedin-headlines KALDIRILDI (K54) ──────────────────────────────────
  //
  // Kariyer Araclari'ndaki baslik sekmesi LinkedIn Optimizasyon sayfasinin
  // ikinci kopyasiydi: ayni isi uydurma yasagi ve kodda olculen denetim
  // olmadan yapiyordu (K31'in kalibi). Kullanicinin karariyla sekme ve uc
  // birlikte kaldirildi; baslik uretmenin tek yeri /optimize-linkedin.

  // ── POST /experience-letter — deneyim / referans mektubu, IK rica e-postasi ─
  fastify.post('/experience-letter', async (request, reply) => {
    const b = request.body ?? {};
    const yazi = (d, en = 300) => String(d == null ? '' : d).trim().slice(0, en);

    const ad = yazi(b.emp_name, 120), unvan = yazi(b.emp_title, 120), sirket = yazi(b.company, 160);
    if (!ad || !unvan || !sirket) {
      return reply.code(422).send({
        kod:   EL_HATA.ALAN_EKSIK,
        error: 'emp_name, emp_title and company are required.',
      });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });
    }

    // Eski istemciler "employment" gonderebilir (onbellekteki sayfa); o tur
    // artik yok, en yakin karsiligi IK'ya rica e-postasi.
    const TURLER = ['experience', 'reference', 'hr_request'];
    const tur = b.type === 'employment' ? 'hr_request' : (TURLER.includes(b.type) ? b.type : 'experience');
    const dil = yazi(b.language, 40) || 'English';
    const bugun = new Date().toISOString().slice(0, 10);

    // Eksik alan BOS gider, yer tutucu olarak degil: istemdeki MISSING
    // INFORMATION kurali modele koseli parantez yazdirir. Eskiden bos basari
    // alanina "general duties performed satisfactorily" gidiyordu; yani
    // kullanicinin yazmadigi bir degerlendirme yoneticinin agzina konuyordu.
    const satir = (etiket, deger) => `${etiket}: ${deger || '(not given)'}`;
    const userPrompt = [
      `Today's date: ${bugun}`,
      `Write in ${dil}.`,
      `Type: ${tur}`,
      satir('Employee', ad),
      satir('Job title', unvan),
      satir('Company', sirket),
      satir('Employment dates', yazi(b.duration, 120)),
      satir('Manager name', yazi(b.manager_name, 120)),
      satir('Manager title', yazi(b.manager_title, 120)),
      satir('Responsibilities and achievements', yazi(b.achievements, 2000)),
    ].join('\n');

    try {
      // BUTCE 900'du ve istem hicbir uzunluk vermiyordu. K36'nin kurali:
      // butce, ciktinin kendisi sinirlanmadan buyutulmez. Istem artik en fazla
      // 350 kelime diyor; Turkce ~2,27 token/kelime (K36, cl100k ile olculdu,
      // Claude'un tokenlestiricisi degil, yaklasik) -> ~800 token. 1400 bu
      // tahminin ustunde pay birakiyor. Kesilen mektup mektup gibi gorunur ve
      // imza blogu olmadan biter; o yuzden kesilme ayrica soruluyor.
      const ustveri = {};
      const metin = String(await createMessage({
        model:      b.model || 'claude-sonnet',
        max_tokens: 1400,
        system:     tur === 'hr_request' ? HR_REQUEST_SYSTEM : EXPERIENCE_LETTER_SYSTEM,
        messages:   [{ role: 'user', content: userPrompt }],
      }, ustveri) || '').trim();

      if (ustveri.kesildi) {
        fastify.log.warn({ tur, cikti_token: ustveri.cikti_token }, '[experience-letter] yanit kesildi');
        return reply.code(422).send({
          kod:   EL_HATA.YANIT_KESILDI,
          error: 'The letter was cut off before it was complete.',
        });
      }
      const kelime = metin ? metin.split(/\s+/).filter(Boolean).length : 0;
      if (kelime < 40) {
        fastify.log.info({ tur, kelime }, '[experience-letter] metin uretilemedi');
        return reply.code(422).send({
          kod:   EL_HATA.URETILEMEDI,
          error: 'The letter could not be written.',
        });
      }

      return { letter: metin, type: tur, word_count: kelime };
    } catch (err) {
      fastify.log.error(err, '[practice/experience-letter]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /optimize-linkedin — LinkedIn profile optimizer ─────────────────────
  //
  // 23 Eylul 2026'da olculdu (K53): cikti denetimi yoktu, cozulemeyen yanitta
  // modelin HAM metni istemciye donuyordu, hatalar duz Ingilizce metindi (K25)
  // ve iki "puan" modelin uydurmasiydi. Yanit kesilmesi de hic sorulmuyordu:
  // kesilen JSON "Parse failed" olarak gorunurdu, sebep kaybolurdu.
  fastify.post('/optimize-linkedin', async (request, reply) => {
    const {
      profile_text     = '',
      current_headline = '',
      target_role      = '',
      industry         = 'General',
      tone             = 'professional',
      language         = 'auto',
      model,
    } = request.body ?? {};

    const profil = String(profile_text || '').trim();
    if (profil.length < 50) {
      return reply.code(422).send({
        kod:   LI_HATA.KISA_PROFIL,
        error: 'profile_text required (min 50 chars)',
      });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });
    }

    const kaynak = profil.slice(0, 6000);
    const hedef  = String(target_role || '').trim().slice(0, 120);
    const TONLAR = { professional: 'professional', confident: 'confident and bold', warm: 'warm and approachable' };
    const ton    = TONLAR[tone] || TONLAR.professional;
    // DIL VARSAYILANI PROFILIN KENDI DILI. 24 Eylul 2026'da olculdu: Ingilizce
    // bir profil, arayuz Turkce oldugu icin Turkceye cevrildi; kullanici
    // British Columbia'da is ariyor. Beceri adlari da Turkce geldi ("Depo
    // Yonetimi (WMS)") ve LinkedIn'in Ingilizce beceri listesiyle eslesmez.
    // Metni okuyan recruiter; dili arayuz degil profil belirler (K39).
    const dil    = String(language || 'auto').slice(0, 40);
    const dilSatiri = dil === 'auto'
      ? 'Write the headline, About, skills, keywords and recommendations in the same language the profile text is written in.'
      : `Write the headline, About, skills, keywords and recommendations in ${dil}.`;
    const bugun  = new Date().toISOString().slice(0, 10);

    const userPrompt = `Today's date: ${bugun}
${dilSatiri}
Tone: ${ton}
Target role: ${hedef || '(not given, infer it from the profile)'}
Industry: ${String(industry || 'General').slice(0, 80)}
Current headline: ${String(current_headline || '').trim().slice(0, 300) || '(find it in the profile text)'}

Profile text:
${kaynak}`;

    try {
      const ustveri = {};
      const raw = await createMessage({
        model:      model || 'claude-sonnet',
        max_tokens: 1800,
        system:     LINKEDIN_SYSTEM,
        messages:   [{ role: 'user', content: userPrompt }],
      }, ustveri);

      if (ustveri.kesildi) {
        fastify.log.warn({ cikti_token: ustveri.cikti_token }, '[optimize-linkedin] yanit kesildi');
        return reply.code(422).send({
          kod:   LI_HATA.YANIT_KESILDI,
          error: 'The response was cut off before it was complete.',
        });
      }

      const sonuc = safeParseJSON(raw);
      if (!sonuc || typeof sonuc !== 'object') {
        // Ham metin ISTEMCIYE GITMEZ: kullaniciya bir anlam tasimiyor ve
        // modelin kismi ciktisini disari tasiyor. Iz icin uzunlugu yeter.
        fastify.log.error({ rawChars: String(raw || '').length }, '[optimize-linkedin] yanit cozulemedi');
        return reply.code(422).send({
          kod:   LI_HATA.COZULEMEDI,
          error: 'The response could not be read.',
        });
      }

      const yazi  = (d) => (typeof d === 'string' ? d.trim() : '');
      const liste = (d, en) => (Array.isArray(d) ? d : [])
        .map((x) => (typeof x === 'string' ? x.trim() : ''))
        .filter(Boolean).slice(0, en);

      const temiz = {
        headline:        yazi(sonuc.headline),
        about:           yazi(sonuc.about),
        skills:          liste(sonuc.skills, 15),
        keywords:        liste(sonuc.keywords, 15),
        recommendations: liste(sonuc.recommendations, 8),
      };

      // Bos baslik ya da bos Hakkinda BASARI DEGILDIR. Eskiden 200 donuyor,
      // arayuz bos panelleri aciyor ve ustune iki "puan" basiyordu.
      if (!temiz.headline || temiz.about.length < 100) {
        fastify.log.info({ baslik: temiz.headline.length, hakkinda: temiz.about.length },
          '[optimize-linkedin] metin uretilemedi');
        return reply.code(422).send({
          kod:   LI_HATA.URETILEMEDI,
          error: 'The profile text could not be written.',
        });
      }

      return {
        ...temiz,
        headline_before: mevcutBaslikDogrula(kaynak, sonuc.headline_before),
        denetim:         profilDenetimi({ profil: kaynak, hedef, sonuc: temiz }),
      };
    } catch (err) {
      fastify.log.error(err, '[practice/optimize-linkedin]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /generate-answers — generate STAR answers for predicted questions ──
  // Takes a list of questions + candidate profile, returns personalised answers
  fastify.post('/generate-answers', async (request, reply) => {
    const {
      questions    = [],
      profile      = {},
      jd_context   = '',
      model,
      language     = 'Turkish',
    } = request.body ?? {};

    if (!questions.length) {
      return reply.code(400).send({ error: 'questions array required' });
    }

    const name        = profile.name     || 'Candidate';
    const title       = profile.title    || '';
    const skills      = profile.skills   || '';
    const cvText      = profile.cv_text  || '';
    const background  = cvText
      ? cvText.slice(0, 3000)
      : `Title: ${title}. Skills: ${skills}`;

    const systemPrompt = `You are a senior interview coach. Write natural, engaging spoken STAR answers, the kind that keeps an interviewer nodding, not checking their phone.

Language: ${language}

Tone & style:
- Write exactly as someone would SPEAK in an interview, warm, confident, natural flow
- No bullet points, no headers, no "Situation:", "Task:" labels, just flowing speech
- Use "I", "we", "my team" naturally
- Include one concrete detail or number to make it credible (%, time saved, team size, revenue impact)
- Engaging opening that hooks: don't start with "In my previous role" every time
- Close with a clear result and optionally a lesson learned or what it shows about you

Length: 80-110 words: enough to be complete and satisfying, short enough to stay sharp.
Never pad. Never repeat yourself. If the candidate's background lacks detail, invent plausible specifics consistent with their title and skills.

For each question return a JSON object:
- "question": the original question text
- "answer": the spoken answer (80-110 words, in ${language})
- "key_points": 3 short phrases (each 4-7 words) the candidate should remember to hit

Return a JSON array only, no markdown and no extra text.` + NO_EM_DASH;

    const userPrompt = `Candidate: ${name} · ${title}
Background:
${background}

Job context: ${jd_context ? jd_context.slice(0, 1000) : 'General role'}

Generate personalised STAR answers for these ${questions.length} questions:
${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`;

    try {
      const raw = await createMessage({
        model:      model || 'claude-sonnet',
        max_tokens: 200 * questions.length + 300,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userPrompt }],
      });

      const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      let answers;
      try { answers = JSON.parse(clean); }
      catch {
        // Fallback: try to extract JSON array
        const m = clean.match(/\[[\s\S]+\]/);
        if (m) {
          try { answers = JSON.parse(m[0]); }
          catch { return reply.code(500).send({ error: 'Parse failed', raw }); }
        } else {
          return reply.code(500).send({ error: 'Parse failed', raw });
        }
      }

      return { answers, profile_used: name };
    } catch (err) {
      fastify.log.error(err, '[practice/generate-answers]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /cover-letter — generate a personalized cover letter ─────────────
  fastify.post('/cover-letter', async (request, reply) => {
    const g = request.body ?? {};

    // Alanlar BOS DIZGI ile de gelebilir. Nesne cozmedeki `= 'the company'`
    // varsayilani yalnizca anahtar HIC YOKKEN calisir; istemci alani her zaman
    // gonderdigi icin (bos olsa bile) varsayilan hic devreye girmiyordu ve
    // isteme "Target Company:" diye bos bir satir gidiyordu. Olculdu:
    //   { company_name: '' } -> ''            (varsayilan calismadi)
    //   { }                  -> 'the company'
    const yazi = (deger, yedek) => {
      const d = String(deger == null ? '' : deger).trim();
      return d || yedek;
    };

    const name             = yazi(g.name, 'Candidate');
    const current_title    = yazi(g.current_title, 'not specified');
    const company_name     = yazi(g.company_name, 'the company');
    const experience_years = yazi(g.experience_years, 'not specified');
    const tone             = yazi(g.tone, 'professional');
    const language         = yazi(g.language, '');
    const job_description  = String(g.job_description || '').trim();
    const base_cv          = String(g.base_cv || '').trim();
    const key_skills       = g.key_skills ?? [];

    if (job_description.length < 50) {
      return reply.code(422).send({
        kod:   KAPAK_HATA.KISA_ILAN,
        error: 'job_description required (min 50 chars)',
      });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });
    }

    const skillsText = Array.isArray(key_skills) && key_skills.length
      ? key_skills.join(', ')
      : 'not specified';

    // CV metni ISTEME GIRIYOR. Eskiden hic gonderilmiyordu: sistem istemi
    // "somut rakamlarla en guclu basarisini yaz" diyor, modele verilen tek sey
    // bir unvan ve bir beceri listesiydi. Model rakami uyduruyordu ve o mektup
    // isverene gidiyordu. Sayfa 2'deki /full-package zaten base_cv gonderiyor.
    const cvBolumu = base_cv
      ? `\n\nCandidate CV (the ONLY source of achievements, numbers, employers and dates):\n${base_cv.slice(0, 6000)}`
      : '\n\nNo CV text was provided. You have NO achievements to cite. Do not invent any.';

    // Bugunun tarihi ISTEME GIRIYOR. Model "Present"i kendi egitim verisinden
    // tahmin ediyordu ve deneyimi oldugundan kisa gosteriyordu.
    const bugun = new Date().toISOString().slice(0, 10);

    const userPrompt = `
Today's date: ${bugun}
Candidate Name: ${name}
Current Title: ${current_title}
Years of Experience: ${experience_years}
Key Skills: ${skillsText}
Target Company: ${company_name}
Desired Tone: ${tone}${language ? `\nWrite the letter in: ${language}` : ''}

Job Description:
${job_description}${cvBolumu}

Write the cover letter now.`.trim();

    try {
      const letter = await createMessage({
        model:      g.model || 'claude-sonnet',
        max_tokens: 800,
        system:     COVER_LETTER_SYSTEM,
        messages:   [{ role: 'user', content: userPrompt }],
      });

      const metin = String(letter || '').trim();

      // CIKTI DOGRULAMASI. Eskiden hic yoktu: bos bir yanit 200 ile donuyor,
      // ustelik "1 words" yaziyordu, cunku ''.split(/\s+/) tek elemanli bir
      // dizi verir. Ekranda bos kutu, yaninda basari gorunumu.
      const words = metin ? metin.split(/\s+/).filter(Boolean).length : 0;
      if (words < 40) {
        fastify.log.info({ words, cvVar: Boolean(base_cv) }, '[cover-letter] mektup uretilemedi');
        return reply.code(422).send({
          kod:   KAPAK_HATA.URETILEMEDI,
          error: 'The letter could not be written.',
        });
      }

      return { cover_letter: metin, word_count: words, cv_kullanildi: Boolean(base_cv) };

    } catch (err) {
      fastify.log.error(err, '[practice/cover-letter]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /ats-score — ATS compatibility analysis ──────────────────────────
  fastify.post('/ats-score', async (request, reply) => {
    const g = request.body ?? {};
    const cv_text         = String(g.cv_text || '').trim();
    const job_description = String(g.job_description || '').trim();
    // Varsayilan 'Turkish' idi. Urun Ingilizce birinci; istemci her zaman dil
    // gonderdigi icin maskeliydi ama varsayilanin kendisi yanlisti.
    const language        = String(g.language || '').trim() || 'English';

    if (cv_text.length < 50 || job_description.length < 50) {
      return reply.code(422).send({
        kod:   ATS_HATA.KISA_GIRDI,
        error: 'cv_text and job_description are required (min 50 chars each)',
      });
    }
    if (!process.env.ANTHROPIC_API_KEY)
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });

    const userPrompt = `Provide all text feedback (strengths, gaps, recommendations) in ${language}.

JOB DESCRIPTION:
${job_description}

CANDIDATE CV/RESUME:
${cv_text}

Analyze the match and return the JSON scorecard.`;

    try {
      // BUTCE. 900 idi. Ilk tahminim "Turkce cevap 900'u asiyor" idi ve
      // YANLISTI: o tahmini karakter/2 gibi uydurma bir olcutle yapmistim.
      // Gercek tokenlestiriciyle olculdugunde LENGTH LIMITS icindeki Turkce
      // bir puan karti 366-450 token tutuyor, yani 900 zaten yetiyordu.
      // (Olcum cl100k ile yapildi; Claude'un tokenlestiricisi birebir ayni
      // degil ama ayni buyukluk sinifinda. Turkce ~2.27 token/kelime,
      // Ingilizce ~1.13; yani Turkce iki kat, uc kat degil.)
      //
      // 1600 yine de kaliyor: pay birakmanin bedeli yok, ve LENGTH LIMITS
      // ciktiyi zaten bagliyor. Ama bu sayi bir DUZELTME degil, pay.
      // "Hesaplanamadi" hatasinin gercek sebebi hala bilinmiyor; asagidaki
      // gunluk alanlari onu soyleyecek.
      //
      // Sadece sayiyi buyutmek zaten yanlis duzeltme olurdu: sinirsiz
      // buyuyebilen bir cikti her butceyi bir gun asar.
      const ustveri = {};
      const raw = await createMessage({
        model:      request.body?.model || 'claude-haiku',
        max_tokens: 1600,
        system:     ATS_SYSTEM,
        messages:   [{ role: 'user', content: userPrompt }],
      }, ustveri);
      const result = safeParseJSON(raw);

      // KESILME AYRI BIR HATA. Model puani vermis olabilir; biz dinlemeyi
      // erken kestik. Kullaniciya "olcemedik" demek yanlis olur, cunku
      // yapmasi gereken sey farkli (metni kisaltmak ya da tekrar denemek).
      // GUNLUGE ICERIK DEGIL SEKIL. Ilk yazimda ham metnin ilk 200 karakterini
      // gunluge koymustum; lib/logging.test.js bunu reddetti ve HAKLIYDI.
      // Modelin ciktisi kullanicinin CV'sinden turetiliyor: adi, isvereni,
      // tarihleri tasiyabilir. Railway gunlugu bunun yeri degil.
      //
      // Teshis icin gereken sey zaten icerik degil SEKIL: cevap kac karakter,
      // suslu parantezle basliyor mu, kapaniyor mu. Bu uc alan dort durumu
      // birbirinden ayirir: bos cevap, duz cumle (suslu ile baslamaz),
      // kesilmis JSON (baslar ama kapanmaz), gecerli JSON ama kotu puan.
      const hamMetin = String(raw || '');
      const hamSekli = {
        hamChars:      hamMetin.length,
        susluBasliyor: /^\s*\{/.test(hamMetin),
        susluBitiyor:  /\}\s*$/.test(hamMetin),
      };

      if (!result && ustveri.kesildi) {
        fastify.log.warn(
          { cikti_token: ustveri.cikti_token, ...hamSekli },
          '[ats-score] yanit kesildi');
        return reply.code(422).send({
          kod:   ATS_HATA.YANIT_KESILDI,
          error: 'The response was cut off before it was complete.',
        });
      }

      // ── CIKTI DOGRULAMASI ──────────────────────────────────────────────────
      //
      // Eskiden yoktu ve SIFIR, hata gibi degil OLCUM gibi gorunuyordu:
      //   {}            -> istemcide `data.score || 0` -> ekranda buyuk "0"
      //   score: "85%"  -> Math.max(0,"85%") -> NaN -> ekranda "NaN"
      // Ikisinde de daire ciziliyor, panel aciliyor, kullanici CV'sinin bu ise
      // sifir uydugunu saniyordu. Hicbir sey gostermemek bundan iyidir.
      const puan = Number(result && result.score);
      if (!result || !Number.isFinite(puan) || puan < 0 || puan > 100) {
        // `result` null oldugunda `hamPuan` her zaman undefined dusuyordu ve
        // modelin gercekte NE dondurdugu kayboluyordu. Hata yolunun kendisi
        // teshis edilebilir olmali: ham metnin basi da yaziliyor.
        fastify.log.info({
          hamPuan:      result && result.score,
          ayristirildi: Boolean(result),
          stop_reason:  ustveri.stop_reason,
          cikti_token:  ustveri.cikti_token,
          ...hamSekli,
        }, '[ats-score] puan gecersiz');
        return reply.code(422).send({
          kod:   ATS_HATA.HESAPLANAMADI,
          error: 'The ATS score could not be calculated.',
        });
      }

      // Not ile puan CELISEBILIYORDU: istemde olcek yazili ama donen cevap
      // denetlenmiyordu, `score: 95, grade: "C"` ikisi birden ekrana basilirdi.
      // Notu puandan biz turetiyoruz; tek dogru kaynak puan.
      const not = puan >= 90 ? 'A+' : puan >= 80 ? 'A' : puan >= 65 ? 'B'
                : puan >= 50 ? 'C'  : puan >= 35 ? 'D' : 'F';

      // Number('') === 0, Number(null) === 0, Number(true) === 1. Yalnizca
      // Number()'a guvenen surum bos bir bolum puanini ekranda "0" yapiyordu:
      // ust duzeydeki sahte sifir kusurunun bir kat asagidaki ayni hali.
      // Testte yakalandi (A6), uretimde degil.
      const sayiVeya = (d) => {
        if (typeof d !== 'number' && typeof d !== 'string') return null;
        if (typeof d === 'string' && !d.trim()) return null;
        const n = Number(d);
        return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : null;
      };
      const bs = result.section_scores || {};

      // ── ESLESME DOGRULAMASI ────────────────────────────────────────────────
      //
      // Uretimde olculdu (19 Eylul 2026): on "eslesen" kelimeden ikisi
      // kullanicinin CV'sinde HIC gecmiyordu; biri dogrudan ILANDAN
      // geliyordu ("quantitative research"). Istemdeki EVIDENCE RULES bunu
      // yasakliyordu, model uymadi. K32'nin siniri: kuralin istemde durdugunu
      // kilitleyebiliriz, modelin uydugunu kilitleyemeyiz. O yuzden modele
      // guvenmek yerine iki belgeye bakiyoruz.
      //
      // PUANA DOKUNULMUYOR, bilerek. Model puani bu kelimeleri sayarak
      // hesapladi, yani puan bir miktar sisik. Ama puani kendimiz yeniden
      // hesaplamak uydurma olurdu; elimizde modelin agirliklandirmasi yok.
      // Listeler duzeltiliyor ve kullaniciya durum SOYLENIYOR; istemci
      // `dogrulama.elenen` dolu oldugunda uyari gosteriyor.
      const d = eslesmeleriDogrula(result.matched_keywords, result.missing_keywords,
                                   cv_text, job_description);
      if (d.elenen.length || d.atilan.length) {
        fastify.log.info({ elenen: d.elenen.length, atilan: d.atilan.length },
          '[ats-score] dogrulanmayan eslesme');
      }

      return {
        ...result,
        score: Math.round(puan),
        grade: not,
        matched_keywords: d.eslesen,
        missing_keywords: d.eksik,
        // Kullaniciya gosterilecek: CV'de bulunamadigi icin eslesen
        // listesinden cikarilan terimler.
        dogrulama: { elenen: d.elenen, atilan: d.atilan },
        section_scores: {
          skills_match:     sayiVeya(bs.skills_match),
          experience_match: sayiVeya(bs.experience_match),
          education_match:  sayiVeya(bs.education_match),
        },
      };
    } catch (err) {
      fastify.log.error(err, '[practice/ats-score]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /build-resume — generate ATS-optimized resume text ──────────────
  fastify.post('/build-resume', async (request, reply) => {
    const {
      name, email = '', phone = '', linkedin = '', location = '',
      target_role = '', summary = '',
      experience  = [],
      education   = [],
      skills      = [],
      language    = 'English',
    } = request.body ?? {};

    if (!name || String(name).trim().length < 2) {
      return reply.code(422).send({
        kod:   CVB_HATA.AD_GEREKLI,
        error: 'A name is required.',
      });
    }
    if (!process.env.ANTHROPIC_API_KEY)
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });

    // ── YER TUTUCULAR KALDIRILDI ──────────────────────────────────────────
    //
    // Eskiden bos alanlar isteme SAHTE DEGER olarak giriyordu:
    //   `• ${e.title || 'Role'} at ${e.company || 'Company'} (${e.dates || 'Dates'})`
    // Kullanici sirket adini bos biraktiginda modele su gidiyordu:
    //   "• Analyst at Company (Dates): ..."
    // Modelin iki secenegi vardi ve ikisi de kotu: "Company" kelimesini CV'ye
    // yazmak, ya da bosluga bir sirket ve bir tarih UYDURMAK. Istemdeki
    // MISSING INFORMATION kurali da ancak eksik alan GERCEKTEN eksik
    // gorundugunde ise yarar.
    const yazi = (d) => String(d == null ? '' : d).trim();
    const dizi = (d) => (Array.isArray(d) ? d : []);

    const satir = (parcalar) => parcalar.filter(Boolean).join(' ');

    const expText = dizi(experience).length
      ? dizi(experience).map((e) => {
          const bas = satir([
            '•',
            yazi(e.title),
            yazi(e.company) && `at ${yazi(e.company)}`,
            yazi(e.dates)   && `(${yazi(e.dates)})`,
          ]);
          return yazi(e.description) ? `${bas}: ${yazi(e.description)}` : bas;
        }).filter((x) => x.length > 1).join('\n')
      : 'Not provided';

    const eduText = dizi(education).length
      ? dizi(education).map((e) => satir([
          '•',
          yazi(e.degree),
          yazi(e.institution) && `· ${yazi(e.institution)}`,
          yazi(e.year)        && `(${yazi(e.year)})`,
        ])).filter((x) => x.length > 1).join('\n')
      : 'Not provided';

    const skillsText = dizi(skills).map(yazi).filter(Boolean).join(', ')
      || (typeof skills === 'string' ? yazi(skills) : '');

    const userPrompt = `Write the resume in ${language}.

Full Name: ${name.trim()}
Email: ${email}  |  Phone: ${phone}  |  LinkedIn: ${linkedin}  |  Location: ${location}
Target Role: ${target_role}

Background / Summary notes: ${summary || 'Not provided'}

Work Experience:
${expText}

Education:
${eduText}

Skills: ${skillsText || 'Not provided'}

Write the complete ATS-optimized resume now.`;

    try {
      // BUTCE. 1200 idi. Istem 400-550 KELIME istiyor; Turkce ~2.27
      // token/kelime, yani 550 kelime ~1250 token tutuyor ve 1200 tam
      // sinirin altinda kaliyordu. Kesilen bir CV, kesilen bir JSON gibi
      // gurultu cikarmaz: CV GIBI GORUNUR, cumlenin ortasinda biter ve
      // kullanici fark etmezse isverene yarim bir metin gonderir.
      const ustveri = {};
      const resume = await createMessage({
        model:      request.body?.model || 'claude-sonnet',
        max_tokens: 1800,
        system:     RESUME_SYSTEM,
        messages:   [{ role: 'user', content: userPrompt }],
      }, ustveri);

      const metin = String(resume || '').trim();
      // `''.trim().split(/\s+/).length` BIR verir. Eski kod bunu kullaniyordu,
      // yani bos bir CV ekranda "1 words" ile BASARI gibi gorunuyordu.
      // Kapak mektubunda ayni kusur duzeltilmisti (K33); burada duruyordu.
      const words = metin ? metin.split(/\s+/).filter(Boolean).length : 0;

      if (ustveri.kesildi) {
        fastify.log.warn({ words, cikti_token: ustveri.cikti_token },
          '[build-resume] yanit kesildi');
        return reply.code(422).send({
          kod:   CVB_HATA.YANIT_KESILDI,
          error: 'The resume was cut off before it was complete.',
        });
      }
      if (words < 120) {
        fastify.log.info({ words }, '[build-resume] cv uretilemedi');
        return reply.code(422).send({
          kod:   CVB_HATA.URETILEMEDI,
          error: 'The resume could not be written.',
        });
      }

      return { resume: metin, word_count: words };
    } catch (err) {
      fastify.log.error(err, '[practice/build-resume]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /apply-package — quick application kit for a JD ─────────────────
  fastify.post('/apply-package', async (request, reply) => {
    const {
      job_description,
      candidate_profile = '',
      language          = 'Turkish',
    } = request.body ?? {};

    if (!job_description || job_description.trim().length < 50)
      return reply.code(400).send({ error: 'job_description required (min 50 chars)' });
    if (!process.env.ANTHROPIC_API_KEY)
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });

    const userPrompt = `Provide all text in ${language}.

JOB DESCRIPTION:
${job_description.trim()}

CANDIDATE PROFILE (optional context):
${candidate_profile.trim() || 'Not provided, evaluate based on JD alone'}

Create the application package JSON now.`;

    try {
      const raw = await createMessage({
        model:      request.body?.model || 'claude-haiku',
        max_tokens: 800,
        system:     APPLY_PACKAGE_SYSTEM,
        messages:   [{ role: 'user', content: userPrompt }],
      });
      const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      let result;
      try { result = JSON.parse(clean); }
      catch { return reply.code(500).send({ error: 'Parse failed', raw }); }
      return result;
    } catch (err) {
      fastify.log.error(err, '[practice/apply-package]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /adapt-cv — tailor existing CV to a specific job description ──────
  fastify.post('/adapt-cv', async (request, reply) => {
    const {
      base_cv,
      job_description,
      language = 'English',
    } = request.body ?? {};

    if (!base_cv || base_cv.trim().length < 50)
      return reply.code(400).send({ error: 'base_cv required (min 50 chars)' });
    if (!job_description || job_description.trim().length < 50)
      return reply.code(400).send({ error: 'job_description required (min 50 chars)' });
    if (!process.env.ANTHROPIC_API_KEY)
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });

    const userPrompt = `Adapt the CV. Write the output in ${language}.

JOB DESCRIPTION:
${job_description.trim()}

CANDIDATE'S CURRENT CV:
${base_cv.trim()}

Return the adapted CV now.`;

    try {
      const adapted = await createMessage({
        model:      request.body?.model || 'claude-sonnet',
        max_tokens: 1200,
        system:     ADAPT_CV_SYSTEM,
        messages:   [{ role: 'user', content: userPrompt }],
      });
      return { adapted_cv: adapted.trim(), word_count: adapted.trim().split(/\s+/).length };
    } catch (err) {
      fastify.log.error(err, '[practice/adapt-cv]');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /full-package — JD → adapted CV + cover letter + ATS in one go ──
  fastify.post('/full-package', async (request, reply) => {
    const {
      job_description,
      base_cv         = '',
      candidate_name  = 'Candidate',
      candidate_title = '',
      key_skills      = [],
      tone            = 'professional',
      language        = 'English',
    } = request.body ?? {};

    if (!job_description || job_description.trim().length < 50)
      return reply.code(400).send({ error: 'job_description required (min 50 chars)' });
    if (!process.env.ANTHROPIC_API_KEY)
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not set' });

    const skillsText = Array.isArray(key_skills) ? key_skills.join(', ') : key_skills;

    // Run all three in parallel
    const [cvResult, clResult, atsResult] = await Promise.allSettled([
      // 1. Adapt CV (only if base_cv provided)
      base_cv.trim().length > 50
        ? createMessage({
            model: request.body?.model || 'claude-sonnet', max_tokens: 1200, system: ADAPT_CV_SYSTEM,
            messages: [{ role: 'user', content: `Adapt in ${language}.\n\nJOB DESCRIPTION:\n${job_description.trim()}\n\nCV:\n${base_cv.trim()}` }],
          })
        : Promise.resolve(null),

      // 2. Cover letter
      createMessage({
        model: request.body?.model || 'claude-sonnet', max_tokens: 700, system: COVER_LETTER_SYSTEM,
        messages: [{ role: 'user', content: `Write in ${language}. Tone: ${tone}.\nCandidate: ${candidate_name}, ${candidate_title}.\nSkills: ${skillsText}.\n\nJob Description:\n${job_description.trim()}` }],
      }),

      // 3. ATS score
      createMessage({
        model: 'claude-haiku', max_tokens: 700, system: ATS_SYSTEM,
        messages: [{ role: 'user', content: `Feedback in ${language}.\n\nJOB DESCRIPTION:\n${job_description.trim()}\n\nCV:\n${base_cv.trim() || 'Not provided: evaluate based on candidate skills: ' + skillsText}` }],
      }),
    ]);

    const adapted_cv   = cvResult.status  === 'fulfilled' && cvResult.value  ? cvResult.value.trim()  : null;
    const cover_letter = clResult.status  === 'fulfilled'                    ? clResult.value.trim()  : null;
    let   ats          = null;
    if (atsResult.status === 'fulfilled') {
      try {
        const clean = atsResult.value.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        ats = JSON.parse(clean);
      } catch { /* ignore parse failure */ }
    }

    return { adapted_cv, cover_letter, ats };
  });

  // Sesli deneme mulakati (yol haritasi M1-M3). Kimlik ve AI hakki kancalari
  // yukarida; alt eklenti onlari devraliyor. Yol: /api/v1/practice/mock/*
  fastify.register(require('./mock'));
}

module.exports = practiceRoutes;
