// 诊断目标文件编码状态：字节级分类 + 双重转码检验 + 内容损坏检验
const fs = require("fs");
const iconv = require("iconv-lite");
const target = process.argv[2];
if (!target) {
  console.log("usage: node diag-ts.js <file>");
  process.exit(1);
}
const b = fs.readFileSync(target);
console.log(`file: ${target}`);
console.log(`size: ${b.length} bytes`);

function utf8Strict(x) {
  try {
    const d = new TextDecoder("utf-8", { fatal: true });
    d.decode(x);
    return true;
  } catch {
    return false;
  }
}
const utf8ok = utf8Strict(b);
const asUtf8 = utf8ok ? b.toString("utf8") : null;
const asGbk = iconv.decode(b, "gb18030");
const uffdUtf8 = asUtf8 ? (asUtf8.match(/\ufffd/g) || []).length : -1;
const uffdGbk = (asGbk.match(/\ufffd/g) || []).length;
console.log(`valid UTF-8: ${utf8ok}`);
console.log(`U+FFFD count when decoded as UTF-8: ${uffdUtf8}`);
console.log(`U+FFFD count when decoded as GB18030: ${uffdGbk}`);
console.log(`GBK roundtrip lossless: ${iconv.encode(asGbk, "gb18030").equals(b)}`);

// 双重转码检验：GBK 字节被当 UTF-8 解读再存成 GBK？（mojibake 特征）
// 表现为：按 UTF-8 严格解码失败，但按 latin1 读 GBK 字节得到"汉字串"
if (!utf8ok) {
  const latin = b.toString("latin1");
  const cjkRuns = latin.match(/[\u4e00-\u9fff]{2,}/g);
  console.log(
    `latin1 视角下的连续汉字串（双重转码特征）: ${
      cjkRuns ? cjkRuns.slice(0, 5).join(" | ") : "无"
    }`
  );
}
console.log("--- first 80 bytes hex ---");
console.log(b.subarray(0, 80).toString("hex").replace(/(..)/g, "$1 "));
console.log("--- head lines ---");
const headText = utf8ok && uffdUtf8 === 0 ? asUtf8 : asGbk;
console.log(headText.split(/\r?\n/).slice(0, 6).join("\n"));
