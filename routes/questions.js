/**
 * server/routes/questions.js — /api/v1/questions
 *
 * GET /api/v1/questions/search?q=<query>&sector=<sector>&seniority=<level>
 *
 * Simple keyword search over the local JSON question bank.
 * Later: replace with pgvector semantic search via Supabase.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const BANK_DIR = path.join(__dirname, '..', '..'); // root of interview-aid-app

// ── Load and cache all question files on startup ──────────────────────────────
const INDEX_PATH = path.join(BANK_DIR, 'question_bank_index.json');

let questionCache = null;

function loadQuestions() {
  if (questionCache) return questionCache;

  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  const all   = [];

  for (const entry of index.files) {
    const filePath = path.join(BANK_DIR, entry.file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      all.push(...data.questions.map((q) => ({ ...q, _sector: entry.sector, _file: entry.file })));
    } catch (err) {
      console.warn(`[questions] Could not load ${entry.file}:`, err.message);
    }
  }

  questionCache = all;
  console.log(`[questions] Loaded ${all.length} questions from ${index.files.length} files`);
  return all;
}

// ── Keyword search ─────────────────────────────────────────────────────────────
function keywordSearch(questions, query, sector, seniority, limit = 5) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  return questions
    .filter((q) => {
      if (sector && sector !== 'all' && !q._file.includes(sector)) return false;
      if (seniority && !q.seniority.includes(seniority)) return false;
      return true;
    })
    .map((q) => {
      const haystack = (q.text + ' ' + q.answer_framework.key_points.join(' ')).toLowerCase();
      const score = terms.reduce((acc, t) => acc + (haystack.includes(t) ? 1 : 0), 0);
      return { ...q, _score: score };
    })
    .filter((q) => q._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ _score, _file, ...q }) => q); // strip internal fields
}

// ── Route ─────────────────────────────────────────────────────────────────────
async function questionsRoutes(fastify) {

  // Pre-load on startup
  fastify.addHook('onReady', async () => { loadQuestions(); });

  fastify.get('/search', async (request, reply) => {
    const { q, sector, seniority, limit = '5' } = request.query;

    if (!q || q.trim().length < 3) {
      return reply.code(400).send({ error: 'q param required (min 3 chars)' });
    }

    const all     = loadQuestions();
    const results = keywordSearch(all, q.trim(), sector, seniority, parseInt(limit, 10));

    return { query: q, count: results.length, results };
  });

  fastify.get('/sectors', async () => {
    const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    return { sectors: index.files.map((f) => ({ sector: f.sector, file: f.file, total: f.total })) };
  });

  fastify.get('/stats', async () => {
    const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    return index.metadata;
  });
}

module.exports = questionsRoutes;
