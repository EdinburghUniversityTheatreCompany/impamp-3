/** Zero-reference export scan across the whole tree. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(p)) files.push(p);
  }
}
["src", "e2e-tests"].forEach(walk);
const texts = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

const decl =
  /^export\s+(?:async\s+)?(?:const|function|class|interface|type|enum)\s+([A-Za-z0-9_]+)/gm;
const list = /^export\s*\{([^}]*)\}/gm;

for (const file of files.sort()) {
  if (file.includes(".test.")) continue;
  const src = texts.get(file);
  const names = new Set([...src.matchAll(decl)].map((m) => m[1]));
  for (const m of src.matchAll(list)) {
    for (let part of m[1].split(",")) {
      part = part.trim().split(" as ").pop().trim();
      if (/^[A-Za-z0-9_]+$/.test(part)) names.add(part);
    }
  }
  for (const name of [...names].sort()) {
    const word = new RegExp(`\\b${name}\\b`, "g");
    let ext = 0;
    for (const [other, text] of texts) {
      if (other === file) continue;
      ext += (text.match(word) ?? []).length;
    }
    if (ext === 0) {
      const internal = (src.match(word) ?? []).length - 1;
      console.log(`${file}: ${name} (internal ${internal})`);
    }
  }
}
