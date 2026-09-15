// 监控 hmi_zh.ts 编码变化，抓现行
const fs = require("fs");
const target = "D:\\svn\\nk8500_kmj\\PowerSys\\program\\app\\graph\\qhmi\\hmi_zh.ts";

function stat() {
  const b = fs.readFileSync(target);
  let utf8 = false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    utf8 = true;
  } catch {}
  return { size: b.length, utf8 };
}

let last = "";
const t0 = Date.now();
const timer = setInterval(() => {
  try {
    const s = stat();
    const cur = `${s.size}|${s.utf8}`;
    if (cur !== last) {
      const sec = Math.round((Date.now() - t0) / 1000);
      console.log(`[${sec}s] size=${s.size} validUTF8=${s.utf8}`);
      last = cur;
    }
  } catch (e) {
    console.log("read error: " + e.message);
  }
  if (Date.now() - t0 > 180000) {
    clearInterval(timer);
    console.log("=== monitor end (180s) ===");
  }
}, 1500);
