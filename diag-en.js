// 诊断 codepgmctrl_en.ts 磁盘编码
const fs = require("fs");
const f = "D:\\svn\\nk8500_kmj\\PowerSys\\program\\app\\graph\\qcodepgmctrl\\codepgmctrl_en.ts";
const b = fs.readFileSync(f);
let utf8 = false;
try { new TextDecoder("utf-8", { fatal: true }).decode(b); utf8 = true; } catch {}
const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
console.log(`size=${b.length} validUTF8=${utf8} BOM=${bom}`);
console.log("head:", b.subarray(0, 40).toString("hex"));
