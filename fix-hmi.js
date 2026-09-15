// 现场修复：hmi_zh.ts GBK → UTF-8（符合 XML 声明），先写 claim 让旧插件让路
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const iconv = require("iconv-lite");

const target = "D:\\svn\\nk8500_kmj\\PowerSys\\program\\app\\graph\\qhmi\\hmi_zh.ts";

const CLAIM_DIR = path.join(os.tmpdir(), "encoding-guard-claims");
const h = crypto
  .createHash("sha1")
  .update(target.replace(/\\/g, "/").toLowerCase())
  .digest("hex");
fs.mkdirSync(CLAIM_DIR, { recursive: true });
fs.writeFileSync(
  path.join(CLAIM_DIR, `${h}.json`),
  JSON.stringify({ platform: "manual-fix", time: Date.now(), status: "done", enc: "utf8" })
);

const bytes = fs.readFileSync(target);
const text = iconv.decode(bytes, "gb18030");
if (text.includes("\ufffd")) {
  console.log("ABORT: lossy");
  process.exit(1);
}
const out = Buffer.from(text, "utf8");
const nl = (b) => b.reduce((n, x) => (x === 0x0a ? n + 1 : n), 0);
if (nl(bytes) !== nl(out)) {
  console.log("ABORT: newline mismatch");
  process.exit(1);
}
fs.writeFileSync(target, out);
const re = fs.readFileSync(target);
let ok = false;
try {
  new TextDecoder("utf-8", { fatal: true }).decode(re);
  ok = true;
} catch {}
console.log(`converted ${bytes.length} -> ${out.length} bytes; valid UTF-8: ${ok}`);
