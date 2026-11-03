// Splices data.json into template.html -> concepts.html (next to this script).
// Re-run: node docs/viz-concepts/build.mjs   (data.json comes from extract.py, see its header)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));
const data = readFileSync(`${dir}/data.json`, "utf8");
JSON.parse(data); // fail loudly on bad JSON
const tpl = readFileSync(`${dir}/template.html`, "utf8");
const marker = "/*__DATA__*/null";
if (!tpl.includes(marker)) throw new Error("template marker missing");
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
const safe = data.trim().replace(/<\/script/gi, "<\\/script").split(LS).join("\\u2028").split(PS).join("\\u2029");
writeFileSync(`${dir}/concepts.html`, tpl.replace(marker, () => safe));
console.log("wrote", `${dir}/concepts.html`, (tpl.length + safe.length) / 1024 | 0, "KB");
