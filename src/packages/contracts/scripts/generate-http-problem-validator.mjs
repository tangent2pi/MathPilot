import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";
import { build } from "esbuild";

const schemaUrl = new URL("../schemas/http/problem-details.schema.json", import.meta.url);
const outputUrl = new URL("../src/generated/problem-details-validator.ts", import.meta.url);
const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
const ajv = new Ajv2020({ strict: true, code: { source: true, esm: true } });
const validate = ajv.compile(schema);
const standalone = standaloneCode(ajv, validate);
const bundled = await build({
  bundle: true,
  charset: "utf8",
  format: "esm",
  legalComments: "none",
  minify: true,
  platform: "browser",
  stdin: {
    contents: standalone,
    loader: "js",
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    sourcefile: "problem-details-validator.standalone.js",
  },
  treeShaking: true,
  write: false,
});
const generated = bundled.outputFiles[0]?.text;
if (!generated) {
  throw new Error("esbuild did not produce a standalone Problem validator");
}
const output = [
  "// Generated from schemas/http/problem-details.schema.json by scripts/generate-http-problem-validator.mjs.",
  "// Do not edit by hand. Regenerate with pnpm generate:http-problem-validator.",
  "// @ts-nocheck -- Ajv standalone emits optimized JavaScript, consumed as TypeScript source.",
  generated.trim(),
  "",
].join("\n");

if (process.argv.includes("--check")) {
  const current = await readFile(outputUrl, "utf8").catch(() => "");
  if (current !== output) {
    throw new Error(`generated validator is stale: ${fileURLToPath(outputUrl)}`);
  }
} else {
  await mkdir(new URL("../src/generated/", import.meta.url), { recursive: true });
  await writeFile(outputUrl, output, "utf8");
}
