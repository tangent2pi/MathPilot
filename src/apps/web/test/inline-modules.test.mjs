import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { SourceTextModule } from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.resolve(here, "../public");
const pages = readdirSync(publicRoot).filter((name) => name.endsWith(".html")).sort();
let modules = 0;

for (const page of pages) {
  const source = readFileSync(path.join(publicRoot, page), "utf8");
  assert.doesNotMatch(source, /比赛|赛题|评委|竞赛|硬门槛/, `${page} contains internal evaluation language`);
  for (const match of source.matchAll(/<script\s+type=["']module["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    modules++;
    assert.doesNotThrow(() => new SourceTextModule(match[1], { identifier: page }), `${page} contains invalid module syntax`);
  }
}

assert.ok(modules > 0, "no inline modules were checked");
console.log(`checked ${modules} inline modules across ${pages.length} product pages`);
