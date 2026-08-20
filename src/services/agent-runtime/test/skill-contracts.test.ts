import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const skills = path.resolve(here, "../skills");
const qwenUpstream = path.resolve(root, "references/qwen-mm-plugins");
const fixtures = path.resolve(here, "fixtures");

function python(script: string, args: string[], expected = 0) {
  const run = spawnSync("python3", [path.join(skills, script), ...args], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, expected, `${script}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
}

test("every production skill has metadata, a template, and a validator", () => {
  const names = readdirSync(skills).filter((name) => statSync(path.join(skills, name)).isDirectory()).sort();
  assert.deepEqual(names, ["database", "er-research", "ktq-extraction", "ocr-routing", "teaching-artifact-adapter", "teaching-card"]);
  for (const name of names) {
    for (const relative of ["SKILL.md", "agents/openai.yaml", "assets", "scripts"]) {
      assert.ok(statSync(path.join(skills, name, relative)), `${name}/${relative}`);
    }
    assert.ok(readdirSync(path.join(skills, name, "assets")).length > 0, `${name} template missing`);
    assert.ok(readdirSync(path.join(skills, name, "scripts")).length > 0, `${name} validator missing`);
    const instructions = readFileSync(path.join(skills, name, "SKILL.md"), "utf8");
    assert.doesNotMatch(instructions, /比赛|赛题|评委|竞赛|硬门槛/, `${name} exposes internal evaluation language`);
    assert.doesNotMatch(readFileSync(path.join(skills, name, "agents/openai.yaml"), "utf8"), /比赛|赛题|评委|竞赛|硬门槛/,
      `${name} agent metadata exposes internal evaluation language`);
    for (const asset of readdirSync(path.join(skills, name, "assets"))) {
      const assetPath = path.join(skills, name, "assets", asset);
      if (statSync(assetPath).isFile()) {
        assert.doesNotMatch(readFileSync(assetPath, "utf8"), /比赛|赛题|评委|竞赛|硬门槛/,
          `${name}/assets/${asset} exposes internal evaluation language`);
      }
    }
    const runtimeSkills = new Set(["core", "database", "edu-agent", "er-research", "ktq-extraction", "ocr-routing", "search", "teaching-artifact-adapter", "teaching-card"]);
    for (const match of instructions.matchAll(/\/opt\/mathpilot-skills\/([^/\s]+)/g)) {
      assert.ok(runtimeSkills.has(match[1]!), `${name} contains a stale runtime skill path: ${match[1]}`);
    }
  }
});

test("the staged runtime has one complete nine-skill tree", () => {
  const expectedRevision = readFileSync(path.join(root, "src/services/agent-runtime/qwen-mm-plugins.revision"), "utf8").trim();
  const revision = spawnSync("git", ["-C", qwenUpstream, "rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  assert.equal(revision.status, 0, revision.stderr);
  assert.equal(revision.stdout.trim(), expectedRevision, "local Qwen-MM-Plugins checkout does not match the pinned build input");
  const temporary = mkdtempSync(path.join(tmpdir(), "mathpilot-staged-skills-"));
  const stage = spawnSync("sh", [path.join(root, "src/services/agent-runtime/scripts/stage-skills.sh"), temporary, qwenUpstream], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(stage.status, 0, `stdout: ${stage.stdout}\nstderr: ${stage.stderr}`);
  const names = readdirSync(temporary).filter((name) => statSync(path.join(temporary, name)).isDirectory()).sort();
  assert.deepEqual(names, ["core", "database", "edu-agent", "er-research", "ktq-extraction", "ocr-routing", "search", "teaching-artifact-adapter", "teaching-card"]);
  for (const name of names) {
    assert.ok(statSync(path.join(temporary, name, "SKILL.md")), `${name}/SKILL.md`);
    assert.ok(statSync(path.join(temporary, name, "agents/openai.yaml")), `${name}/agents/openai.yaml`);
    assert.ok(statSync(path.join(temporary, name, "assets")), `${name}/assets`);
    assert.ok(statSync(path.join(temporary, name, "scripts")), `${name}/scripts`);
    assert.ok(readdirSync(path.join(temporary, name, "assets")).length > 0, `${name} staged assets missing`);
    assert.ok(readdirSync(path.join(temporary, name, "scripts")).length > 0, `${name} staged scripts missing`);
  }
  assert.equal(readFileSync(path.join(temporary, ".provenance.json"), "utf8").includes(
    expectedRevision,
  ), true);
  for (const name of ["core", "search"]) {
    const validation = spawnSync("python3", [path.join(temporary, name, "scripts/validate_install.py"), path.join(temporary, name)], {
      cwd: root, encoding: "utf8",
    });
    assert.equal(validation.status, 0, `${name} staged validation failed\n${validation.stdout}\n${validation.stderr}`);
  }
});

test("skill validators accept valid fixtures and reject unsafe or malformed output", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "mathpilot-skill-contracts-"));
  python("database/scripts/validate_query.py", [path.join(skills, "database/assets/query-template.sql")]);
  python("ocr-routing/scripts/validate_evidence.py", [path.join(fixtures, "ocr-evidence-valid.json"), "--workspace", root]);
  python("teaching-card/scripts/validate_card.py", [path.join(fixtures, "card-valid.json")]);
  python("teaching-artifact-adapter/scripts/validate_artifact.py", [path.join(fixtures, "artifact")]);
  python("ktq-extraction/scripts/validate.py", [path.join(fixtures, "ktq-valid.json"), "--workspace", root, "--receipt", path.join(temporary, "ktq.receipt.json")]);
  python("er-research/scripts/validate.py", [path.join(fixtures, "er-valid.json"), "--frozen", path.join(fixtures, "frozen-ktq.json"), "--receipt", path.join(temporary, "er.receipt.json")]);

  const write = (name: string, value: unknown) => {
    const file = path.join(temporary, name);
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };
  python("database/scripts/validate_query.py", [write("write.sql", "delete from content_question")], 1);
  python("ocr-routing/scripts/validate_evidence.py", [write("ocr.json", { schema: "mathpilot.ocr-evidence/v1", original: "missing", ocr_used: true, reason: "test", derived_files: [], verified_against_original: false }), "--workspace", temporary], 1);
  python("teaching-card/scripts/validate_card.py", [write("card.json", { schema: "mathpilot.question-card/v1", card_id: "bad", prompt_markdown: "?", response_type: "free_text", allow_skip: true, allow_free_text: true, score: 1 })], 1);
  python("teaching-artifact-adapter/scripts/validate_artifact.py", [write("not-a-directory.json", {})], 1);
  python("ktq-extraction/scripts/validate.py", [write("ktq.json", { schema: "wrong", questions: [] }), "--workspace", temporary, "--receipt", path.join(temporary, "bad-ktq.receipt")], 1);
  python("er-research/scripts/validate.py", [write("er.json", { schema: "wrong", error_causes: [], diagnosis_rules: [] }), "--frozen", path.join(fixtures, "frozen-ktq.json"), "--receipt", path.join(temporary, "bad-er.receipt")], 1);
});

test("OCR and KTQ skills require bounded durable checkpoints", () => {
  const ocr = readFileSync(path.join(skills, "ocr-routing/SKILL.md"), "utf8");
  const ktq = readFileSync(path.join(skills, "ktq-extraction/SKILL.md"), "utf8");
  for (const instructions of [ocr, ktq]) {
    assert.match(instructions, /output\/ocr-evidence\/raw/);
    assert.match(instructions, /four consecutive pages/);
    assert.match(instructions, /PyPDF2/);
  }
});
