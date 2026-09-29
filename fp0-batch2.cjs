// FP-0 batch 2 — one-shot patcher (run from repo root).
const fs = require("fs");
let n = 0;
const HOME = "https://latch.gridframes.app";
const edit = (file, from, to) => {
  let s = fs.readFileSync(file, "utf8");
  if (!s.includes(from)) { console.error("MISS: " + file + " :: " + String(from).slice(0, 60)); process.exitCode = 1; return; }
  fs.writeFileSync(file, s.replace(from, to)); n++;
};

edit("packages/shared/src/env.ts",
  "export const ZCODE_TELEMETRY_ENABLED: boolean = true;",
  "export const ZCODE_TELEMETRY_ENABLED: boolean = false;");

edit("packages/ui/src/lib/productDocs.ts", "https://zcode.z.ai/docs", HOME);

let cfg = fs.readFileSync("config/default.json", "utf8");
const b = cfg;
cfg = cfg.replace(/https:\/\/zhipu-ai\.feishu\.cn\/share\/base\/form\/[a-zA-Z0-9]+/g, HOME + "/feedback");
cfg = cfg.replace(/https:\/\/applink\.feishu\.cn\/client\/chat\/chatter\/add_by_link\?link_token=[a-z0-9-]+/g, HOME + "/community");
cfg = cfg.replace(/https:\/\/discord\.gg\/z9aBcQXZQ3/g, HOME + "/community");
if (cfg !== b) { fs.writeFileSync("config/default.json", cfg); n++; } else console.error("MISS default.json");

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(d + "/" + e.name) : (/\.(tsx?|css|json)$/.test(e.name) ? [d + "/" + e.name] : []));
for (const p of walk("packages/web/src")) {
  let s = fs.readFileSync(p, "utf8"); const o = s;
  s = s.replace(/Sign in with Z\.AI/g, "Sign in with Latch")
       .replace(/用 Z\.AI 登录/g, "用 Latch 登录")
       .replace(/Connect to Z\.ai/g, "Connect to Latch")
       .replace(/Download ZCode/g, "Download Latch");
  if (s !== o) { fs.writeFileSync(p, s); n++; }
}

edit("scripts/prepare-prebuilds.mjs", "https://cdn.npmmirror.com/binaries/node", "https://nodejs.org/dist");
console.log("batch-2 edits applied:", n);
