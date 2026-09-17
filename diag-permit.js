// 诊断 hmipermit.xml 当前状态
const fs = require("fs");
const f = "d:\\svn\\nk8500_kmj\\NK8500_20260416_kmj\\config\\host\\hmipermit.xml";
const b = fs.readFileSync(f);
let ok = false;
try { new TextDecoder("utf-8", { fatal: true }).decode(b); ok = true; } catch {}
const head = b.subarray(0, 60).toString("latin1");
console.log(`size=${b.length} validUTF8=${ok}`);
console.log("head:", JSON.stringify(head));
// GBK 解码检查可读性
const iconv = require("iconv-lite");
const g = iconv.decode(b, "gb18030");
console.log("gbk-lossless:", !g.includes("\ufffd"), " utf8-head:", JSON.stringify(b.toString("utf8").slice(0, 50)));
