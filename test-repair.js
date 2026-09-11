// repair.ts 单元验证脚本：双向编码迁移回滚 + 既有修复路径回归 + 项目文件编码巡检
// 运行：node test-repair.js
"use strict";

const fs = require("fs");
const path = require("path");
const iconv = require("iconv-lite");

async function loadRepair() {
  const esbuild = require("esbuild");
  const res = await esbuild.build({
    entryPoints: [path.join(__dirname, "src", "repair.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", res.outputFiles[0].text)(
    mod,
    mod.exports,
    require
  );
  return mod.exports;
}

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`);
  }
}

function bufEq(a, b) {
  return (
    Buffer.isBuffer(a) &&
    Buffer.isBuffer(b) &&
    a.length === b.length &&
    a.equals(b)
  );
}

async function main() {
  const { migrateEncodingBytes, repairEncodedBytes, isMojibakeText, isReversibleMojibakeText, hasStrongCJK } =
    await loadRepair();
  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

  console.log("== 编码迁移回滚 migrateEncodingBytes ==");

  const text =
    "你好，世界！中文编码测试\n第二行：GBK 与 UTF-8 互相修复\r\n第三行：内容无损校验";

  // 场景1：GBK 文件被整体按 UTF-8 重写 → 回滚为 GBK
  const origGbk = iconv.encode(text, "gbk");
  const rewrittenUtf8 = Buffer.from(text, "utf8");
  check(
    "GBK→UTF-8 迁移后回滚为原 GBK 字节",
    bufEq(migrateEncodingBytes(rewrittenUtf8, "utf8", "gbk"), origGbk)
  );

  // 场景2：UTF-8 文件被整体按 GBK 重写 → 回滚为 UTF-8
  check(
    "UTF-8→GBK 迁移后回滚为原 UTF-8 字节",
    bufEq(migrateEncodingBytes(origGbk, "gbk", "utf8"), rewrittenUtf8)
  );

  // 场景3：gb2312 / gb18030 目标
  const g2312Text = "你好世界，中文测试内容";
  check(
    "gb2312 目标回滚（utf8→gb2312）",
    bufEq(
      migrateEncodingBytes(Buffer.from(g2312Text, "utf8"), "utf8", "gb2312"),
      iconv.encode(g2312Text, "gb2312")
    )
  );
  const rare = "生僻字：喆堃龘曜\nGB18030 四字节字符";
  check(
    "gb18030 目标回滚（utf8→gb18030）",
    bufEq(
      migrateEncodingBytes(Buffer.from(rare, "utf8"), "utf8", "gb18030"),
      iconv.encode(rare, "gb18030")
    )
  );

  // 场景4：utf-8（带连字符）与 utf8 同族处理
  check(
    "utf-8 同族判定（gbk→utf-8）",
    bufEq(migrateEncodingBytes(origGbk, "gbk", "utf-8"), rewrittenUtf8)
  );
  check(
    "同族迁移拒绝（utf8→utf-8 返回 null）",
    migrateEncodingBytes(rewrittenUtf8, "utf8", "utf-8") === null
  );

  // 场景5：不可表达字符（emoji→GBK）必须放弃
  // 注意：emoji 用转义序列书写，避免脚本文件自身编码写盘时损坏字面量
  const emoji = "中文内容带 emoji \u{1F600}\n第二行";
  check(
    "目标编码不可表达（emoji→gbk）返回 null",
    migrateEncodingBytes(Buffer.from(emoji, "utf8"), "utf8", "gbk") === null
  );

  // 场景6：边界输入
  check("空文件返回 null", migrateEncodingBytes(Buffer.alloc(0), "utf8", "gbk") === null);
  check(
    "GBK 当前编码有损解码返回 null（非法字节）",
    migrateEncodingBytes(Buffer.from([0xff, 0x10, 0x0a]), "gbk", "utf8") === null
  );

  // 场景7：UTF-8 BOM 剥离（迁移目标无 BOM，内容一致）
  const withBom = Buffer.concat([BOM, rewrittenUtf8]);
  const rolledBack = migrateEncodingBytes(withBom, "utf8", "gbk");
  check(
    "UTF-8 BOM 文件迁移回滚为 GBK（BOM 剥离）",
    rolledBack !== null && iconv.decode(rolledBack, "gbk") === text
  );

  // 场景8：行数保持（CRLF/LF 混合内容，逐字节相等即行数一致）
  const multiline = "第一行\n第二行\r\n第三行\n第四行：中文";
  check(
    "多行 CRLF/LF 混合内容双向回滚逐字节还原",
    bufEq(
      migrateEncodingBytes(
        migrateEncodingBytes(Buffer.from(multiline, "utf8"), "utf8", "gbk"),
        "gbk",
        "utf8"
      ),
      Buffer.from(multiline, "utf8")
    )
  );

  console.log("== 既有修复路径回归 ==");

  // 双重转码：GBK 字节经 latin1 路径变成 UTF-8
  const gbkSrc = iconv.encode("中文乱码修复测试，第一行\n第二行内容", "gbk");
  const mojibake = Buffer.from(gbkSrc.toString("latin1"), "utf8");
  const r1 = repairEncodedBytes(mojibake, ["gbk", "gb18030"]);
  check(
    "双重转码修复还原为 GBK 字节",
    r1 !== null && r1.kind === "mojibake" && bufEq(r1.bytes, gbkSrc),
    r1 ? `kind=${r1.kind}` : "null"
  );

  // 混合编码：GBK 主体 + AI 用 UTF-8 写入的少数行
  const gbkLines = iconv.encode("第一行：中文内容\n第二行：也是GBK\n", "gbk");
  const mixed = Buffer.concat([gbkLines, Buffer.from("第三行：AI写的UTF8\n", "utf8"), iconv.encode("第四行：回到GBK", "gbk")]);
  const r2 = repairEncodedBytes(mixed, ["gbk", "gb18030"]);
  const expectMixed = Buffer.concat([gbkLines, iconv.encode("第三行：AI写的UTF8\n", "gbk"), iconv.encode("第四行：回到GBK", "gbk")]);
  check(
    "混合编码修复：UTF-8 行转入 GBK 主体",
    r2 !== null && r2.kind === "mixed" && r2.encoding === "gbk" && bufEq(r2.bytes, expectMixed),
    r2 ? `kind=${r2.kind} enc=${r2.encoding}` : "null"
  );

  // 对称混合：UTF-8 主体 + GBK 少数行 → 转回 UTF-8
  const utf8Lines = Buffer.from("第一行：中文内容\n第二行：也是UTF8\n", "utf8");
  const mixed2 = Buffer.concat([utf8Lines, iconv.encode("第三行：GBK写入\n", "gbk")]);
  const r3 = repairEncodedBytes(mixed2, ["gbk", "gb18030"]);
  const expectMixed2 = Buffer.concat([utf8Lines, Buffer.from("第三行：GBK写入\n", "utf8")]);
  check(
    "混合编码修复：GBK 行转入 UTF-8 主体",
    r3 !== null && r3.kind === "mixed" && r3.encoding === "utf8" && bufEq(r3.bytes, expectMixed2),
    r3 ? `kind=${r3.kind} enc=${r3.encoding}` : "null"
  );

  check(
    "isMojibakeText：正常中文判定 false",
    isMojibakeText(Buffer.from("这是正常的中文内容", "utf8").toString("utf8")) === false
  );
  check(
    "isMojibakeText：latin1 路径 mojibake 判定 true",
    isMojibakeText(mojibake.toString("utf8")) === true
  );

  console.log("== 欧洲语言误判回归（darkreader ro locale 场景）==");

  // 场景：干净的罗马尼亚语 locale JSON（ă/î/â ≤0xFF，ș/ț >0xFF），几乎全 Latin。
  // 曾被误判为 GBK 双重转码：latin1 逆向时变音字母被静默替换成 '?'，
  // 生成 7267 字节损坏版，再被 GBK 对撞出的 2 个孤立汉字"验证"通过。
  const roText =
    JSON.stringify(
      {
        extension_description: {
          message:
            "Tem\u0103 \u00eentunecat\u0103 pentru orice site. Ai grij\u0103 de ochii t\u0103i, " +
            "folose\u0219te aceast\u0103 extensie pentru modul \u00eenchis \u0219i protejeaz\u0103-te vederea.",
        },
        locale_name: { message: "Rom\u00e2n\u0103" },
        schema_version: 1,
      },
      null,
      4
    ) + "\n";
  const roBytes = Buffer.from(roText, "utf8");
  check(
    "前置确认：罗马尼亚语文本被 isMojibakeText 判为 true（复现误判前提）",
    isMojibakeText(roText) === true
  );
  check(
    "干净罗马尼亚语文件不触发任何修复（返回 null）",
    repairEncodedBytes(roBytes, ["gbk", "gb18030"]) === null
  );
  check(
    "isReversibleMojibakeText：罗马尼亚语文本判定 false（逆向出现 '?'）",
    isReversibleMojibakeText(roText) === false
  );
  check("hasStrongCJK：罗马尼亚语文本判定 false", hasStrongCJK(roText) === false);

  // 法语（é/è/ç 全部在 latin1 内，可逆），保护来自强 CJK 门槛
  const frText =
    "R\u00e9sum\u00e9 : v\u00e9rifi\u00e9 \u00e0 partir d'une cr\u00e9ation d\u00e9j\u00e0 termin\u00e9e. " +
    "D\u00e9\u00e7u, tr\u00e8s d\u00e9\u00e7u par cette r\u00e9p\u00e9tition.\n";
  check(
    "干净法语文本不触发任何修复（返回 null）",
    repairEncodedBytes(Buffer.from(frText, "utf8"), ["gbk", "gb18030"]) === null
  );

  check("hasStrongCJK：真实中文词组判定 true", hasStrongCJK("中文内容修复测试") === true);
  check("hasStrongCJK：零星单个汉字判定 false", hasStrongCJK("a中b文c") === false);
  check(
    "isReversibleMojibakeText：latin1 双重转码判定 true",
    isReversibleMojibakeText(mojibake.toString("utf8")) === true
  );

  console.log("== 项目文件编码巡检 ==");
  const skipDirs = new Set([
    "node_modules", "dist", ".git", ".vscode", ".vscode-test", "out",
  ]);
  const textExts = new Set([
    ".ts", ".js", ".json", ".md", ".bat", ".cfg", ".yml", ".yaml", ".html", ".css",
  ]);
  const files = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        if (!skipDirs.has(name)) walk(p);
      } else if (textExts.has(path.extname(name).toLowerCase())) {
        files.push(p);
      }
    }
  })(__dirname);

  for (const f of files) {
    const bytes = fs.readFileSync(f);
    const rel = path.relative(__dirname, f);
    let enc;
    if (bytes.length === 0) {
      enc = "empty";
    } else {
      const utf8Text = bytes.toString("utf8");
      if (!utf8Text.includes("\ufffd") || isUtf8Strict(bytes)) {
        enc = "UTF-8";
      } else {
        const g = iconv.decode(bytes, "gb18030");
        enc = g.includes("\ufffd") ? "UNKNOWN" : "GB18030/GBK";
      }
    }
    const ok = enc === "UTF-8" || enc === "GB18030/GBK" || enc === "empty";
    check(`${rel} → ${enc}`, ok);
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

// 严格 UTF-8 校验（不依赖 Node 宽松的替换行为）
function isUtf8Strict(bytes) {
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) i++;
    else if ((b & 0xe0) === 0xc0 && i + 1 < bytes.length && (bytes[i + 1] & 0xc0) === 0x80) i += 2;
    else if ((b & 0xf0) === 0xe0 && i + 2 < bytes.length && (bytes[i + 1] & 0xc0) === 0x80 && (bytes[i + 2] & 0xc0) === 0x80) i += 3;
    else if ((b & 0xf8) === 0xf0 && i + 3 < bytes.length && (bytes[i + 1] & 0xc0) === 0x80 && (bytes[i + 2] & 0xc0) === 0x80 && (bytes[i + 3] & 0xc0) === 0x80) i += 4;
    else return false;
  }
  return true;
}

main().catch((e) => {
  console.error("测试执行失败:", e);
  process.exit(1);
});
