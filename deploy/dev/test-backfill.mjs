import { createRequire } from "node:module";
const requirePkg = createRequire(import.meta.resolve("../../src/services/content-next/package.json"));
const pgMod = requirePkg("pg");
const pg = pgMod.default ?? pgMod;

const pool = new pg.Pool({
  host: '127.0.0.1',
  port: 5433,
  user: 'mathpilot_app',
  password: 'mathpilot-app-dev-only',
  database: 'mathpilot',
});

// Test 1: direct char match
const { rows: r1 } = await pool.query("select count(*) from content_paper_answer_item where answer_text ~ '√' OR analysis_text ~ '√'");
console.log('√ match:', r1[0].count);

// Test 2: ^ char match
const { rows: r2 } = await pool.query("select count(*) from content_paper_answer_item where answer_text ~ '\\^' OR analysis_text ~ '\\^'");
console.log('^ match:', r2[0].count);

// Test 3: character class with just ^
const { rows: r3 } = await pool.query("select count(*) from content_paper_answer_item where answer_text ~ '[√^]' OR analysis_text ~ '[√^]'");
console.log('[√^] match:', r3[0].count);

// Test 4: full character class
const { rows: r4 } = await pool.query("select count(*) from content_paper_answer_item where answer_text ~ '[√α-ωΑ-Ω±×÷≤≥≠≡①②③④⑤⑥⑦⑧⑨⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉°^]' OR analysis_text ~ '[√α-ωΑ-Ω±×÷≤≥≠≡①②③④⑤⑥⑦⑧⑨⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉°^]'");
console.log('full class match:', r4[0].count);

// Test 5: split into two patterns
const { rows: r5 } = await pool.query("select count(*) from content_paper_answer_item where answer_text ~ '√|\\^' OR analysis_text ~ '√|\\^'");
console.log('√|\\^ match:', r5[0].count);

await pool.end();
