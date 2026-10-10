// demo-cevaplari.test.js icin: gercek AI yerine sahte cevap. Yalnizca testte -r ile yuklenir.
'use strict';
const path = require('path');
const kok = path.join(__dirname, '..');
const ai = require(path.join(kok, 'lib', 'ai'));
const yolAi = require.resolve(path.join(kok, 'lib', 'ai'));
const istekler = [];
require.cache[yolAi].exports = { ...ai,
  streamMessage: async ({ messages, onToken }) => { istekler.push(messages[0].content); for (const t of ['POINTS: A | B | C\n', 'ANSWER: I listened ', 'first, then acted.']) onToken(t); },
  createMessage: async () => '1. Listen first\n2. Explain the risk\n3. Document it' };
const yolG = require.resolve(path.join(kok, 'lib', 'groq'));
const g = require(yolG);
require.cache[yolG].exports = { ...g, isConfigured: () => false };
process.on('exit', () => {
  const fs = require('fs');
  fs.writeFileSync(process.env.DEMO_ISTEKLER, JSON.stringify({ istekler, supabase: process.env.SUPABASE_URL || null }));
});
