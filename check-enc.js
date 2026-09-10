// Temp encoding scanner (ASCII only, safe regardless of this file's own encoding).
// Usage: node check-enc.js [dir]
const fs = require("fs");
const path = require("path");

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".vscode", "out", ".vscode-test"]);
const TEXT_EXTS = new Set([
  ".ts", ".js", ".cjs", ".mjs", ".json", ".md", ".bat", ".cmd", ".sh",
  ".py", ".txt", ".yml", ".yaml", ".html", ".css", ".c", ".h", ".cpp",
]);

function utf8Strict(b) {
  let i = 0;
  while (i < b.length) {
    const x = b[i];
    if (x < 0x80) i++;
    else if ((x & 0xe0) === 0xc0 && i + 1 < b.length && (b[i + 1] & 0xc0) === 0x80) i += 2;
    else if ((x & 0xf0) === 0xe0 && i + 2 < b.length && (b[i + 1] & 0xc0) === 0x80 && (b[i + 2] & 0xc0) === 0x80) i += 3;
    else if ((x & 0xf8) === 0xf0 && i + 3 < b.length && (b[i + 1] & 0xc0) === 0x80 && (b[i + 2] & 0xc0) === 0x80 && (b[i + 3] & 0xc0) === 0x80) i += 4;
    else return false;
  }
  return true;
}

function classify(b) {
  if (b.length === 0) return "EMPTY";
  const hasBom = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  const body = hasBom ? b.subarray(3) : b;
  const ascii = body.every((x) => x < 0x80);
  if (ascii) return hasBom ? "ASCII+BOM" : "ASCII";
  if (utf8Strict(body)) {
    const t = body.toString("utf8");
    return t.includes("\ufffd") ? "UTF8(BAD)" : hasBom ? "UTF8-BOM" : "UTF8";
  }
  // try gb18030
  const iconv = require("iconv-lite");
  const g = iconv.decode(body, "gb18030");
  return g.includes("\ufffd") ? "OTHER" : "GBK";
}

const root = process.argv[2] || ".";
const rows = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p);
    } else if (TEXT_EXTS.has(path.extname(name).toLowerCase())) {
      const b = fs.readFileSync(p);
      rows.push([path.relative(root, p), classify(b), b.length]);
    }
  }
})(root);

rows.sort((a, b) => a[0].localeCompare(b[0]));

const doFix = process.argv.includes("--fix");
const iconv = require("iconv-lite");
if (doFix) {
  for (const [f, enc] of rows) {
    if (enc !== "GBK") continue;
    const p = path.join(root, f);
    const bytes = fs.readFileSync(p);
    const text = iconv.decode(bytes, "gb18030");
    if (text.includes("\ufffd")) {
      console.log(`SKIP (lossy) ${f}`);
      continue;
    }
    fs.writeFileSync(p, Buffer.from(text, "utf8"));
    console.log(`FIXED ${f}  gb18030 -> utf8  (${bytes.length} bytes)`);
  }
  console.log("");
  // re-scan after fix
  rows.length = 0;
  (function walk2(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk2(p);
      } else if (TEXT_EXTS.has(path.extname(name).toLowerCase())) {
        const b = fs.readFileSync(p);
        rows.push([path.relative(root, p), classify(b), b.length]);
      }
    }
  })(root);
  rows.sort((a, b) => a[0].localeCompare(b[0]));
}

const bad = rows.filter((r) => r[1] === "GBK" || r[1] === "OTHER" || r[1] === "UTF8(BAD)");
for (const [f, enc, size] of rows) {
  console.log(`${enc.padEnd(10)} ${String(size).padStart(7)}  ${f}`);
}
console.log(`\nTotal ${rows.length} files, suspicious ${bad.length}`);
for (const [f, enc] of bad) {
  console.log(`  !! ${enc}  ${f}`);
}
