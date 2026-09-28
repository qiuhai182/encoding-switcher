// repair.ts 鍗曞厓楠岃瘉鑴氭湰锛氬弻鍚戠紪鐮佽縼绉诲洖婊� + 鏃㈡湁淇璺緞鍥炲綊 + 椤圭洰鏂囦欢缂栫爜宸℃
// 杩愯锛歯ode test-repair.js
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

  console.log("== 缂栫爜杩佺Щ鍥炴粴 migrateEncodingBytes ==");

  const text =
    "浣犲ソ锛屼笘鐣岋紒涓枃缂栫爜娴嬭瘯\n绗簩琛岋細GBK 涓� UTF-8 浜掔浉淇\r\n绗笁琛岋細鍐呭鏃犳崯鏍￠獙";

  // 鍦烘櫙1锛欸BK 鏂囦欢琚暣浣撴寜 UTF-8 閲嶅啓 鈫� 鍥炴粴涓� GBK
  const origGbk = iconv.encode(text, "gbk");
  const rewrittenUtf8 = Buffer.from(text, "utf8");
  check(
    "GBK鈫扷TF-8 杩佺Щ鍚庡洖婊氫负鍘� GBK 瀛楄妭",
    bufEq(migrateEncodingBytes(rewrittenUtf8, "utf8", "gbk"), origGbk)
  );

  // 鍦烘櫙2锛歎TF-8 鏂囦欢琚暣浣撴寜 GBK 閲嶅啓 鈫� 鍥炴粴涓� UTF-8
  check(
    "UTF-8鈫扜BK 杩佺Щ鍚庡洖婊氫负鍘� UTF-8 瀛楄妭",
    bufEq(migrateEncodingBytes(origGbk, "gbk", "utf8"), rewrittenUtf8)
  );

  // 鍦烘櫙3锛歡b2312 / gb18030 鐩爣
  const g2312Text = "浣犲ソ涓栫晫锛屼腑鏂囨祴璇曞唴瀹�";
  check(
    "gb2312 鐩爣鍥炴粴锛坲tf8鈫抔b2312锛�",
    bufEq(
      migrateEncodingBytes(Buffer.from(g2312Text, "utf8"), "utf8", "gb2312"),
      iconv.encode(g2312Text, "gb2312")
    )
  );
  const rare = "鐢熷兓瀛楋細鍠嗗爟榫樻洔\nGB18030 鍥涘瓧鑺傚瓧绗�";
  check(
    "gb18030 鐩爣鍥炴粴锛坲tf8鈫抔b18030锛�",
    bufEq(
      migrateEncodingBytes(Buffer.from(rare, "utf8"), "utf8", "gb18030"),
      iconv.encode(rare, "gb18030")
    )
  );

  // 鍦烘櫙4锛歶tf-8锛堝甫杩炲瓧绗︼級涓� utf8 鍚屾棌澶勭悊
  check(
    "utf-8 鍚屾棌鍒ゅ畾锛坓bk鈫抲tf-8锛�",
    bufEq(migrateEncodingBytes(origGbk, "gbk", "utf-8"), rewrittenUtf8)
  );
  check(
    "鍚屾棌杩佺Щ鎷掔粷锛坲tf8鈫抲tf-8 杩斿洖 null锛�",
    migrateEncodingBytes(rewrittenUtf8, "utf8", "utf-8") === null
  );

  // 鍦烘櫙5锛氫笉鍙〃杈惧瓧绗︼紙emoji鈫扜BK锛夊繀椤绘斁寮�
  // 娉ㄦ剰锛歟moji 鐢ㄨ浆涔夊簭鍒椾功鍐欙紝閬垮厤鑴氭湰鏂囦欢鑷韩缂栫爜鍐欑洏鏃舵崯鍧忓瓧闈㈤噺
  const emoji = "涓枃鍐呭甯� emoji \u{1F600}\n绗簩琛�";
  check(
    "鐩爣缂栫爜涓嶅彲琛ㄨ揪锛坋moji鈫抔bk锛夎繑鍥� null",
    migrateEncodingBytes(Buffer.from(emoji, "utf8"), "utf8", "gbk") === null
  );

  // 鍦烘櫙6锛氳竟鐣岃緭鍏�
  check("绌烘枃浠惰繑鍥� null", migrateEncodingBytes(Buffer.alloc(0), "utf8", "gbk") === null);
  check(
    "GBK 褰撳墠缂栫爜鏈夋崯瑙ｇ爜杩斿洖 null锛堥潪娉曞瓧鑺傦級",
    migrateEncodingBytes(Buffer.from([0xff, 0x10, 0x0a]), "gbk", "utf8") === null
  );

  // 鍦烘櫙7锛歎TF-8 BOM 鍓ョ锛堣縼绉荤洰鏍囨棤 BOM锛屽唴瀹逛竴鑷达級
  const withBom = Buffer.concat([BOM, rewrittenUtf8]);
  const rolledBack = migrateEncodingBytes(withBom, "utf8", "gbk");
  check(
    "UTF-8 BOM 鏂囦欢杩佺Щ鍥炴粴涓� GBK锛圔OM 鍓ョ锛�",
    rolledBack !== null && iconv.decode(rolledBack, "gbk") === text
  );

  // 鍦烘櫙8锛氳鏁颁繚鎸侊紙CRLF/LF 娣峰悎鍐呭锛岄€愬瓧鑺傜浉绛夊嵆琛屾暟涓€鑷达級
  const multiline = "绗竴琛孿n绗簩琛孿r\n绗笁琛孿n绗洓琛岋細涓枃";
  check(
    "澶氳 CRLF/LF 娣峰悎鍐呭鍙屽悜鍥炴粴閫愬瓧鑺傝繕鍘�",
    bufEq(
      migrateEncodingBytes(
        migrateEncodingBytes(Buffer.from(multiline, "utf8"), "utf8", "gbk"),
        "gbk",
        "utf8"
      ),
      Buffer.from(multiline, "utf8")
    )
  );

  console.log("== 鏃㈡湁淇璺緞鍥炲綊 ==");

  // 鍙岄噸杞爜锛欸BK 瀛楄妭缁� latin1 璺緞鍙樻垚 UTF-8
  const gbkSrc = iconv.encode("涓枃涔辩爜淇娴嬭瘯锛岀涓€琛孿n绗簩琛屽唴瀹�", "gbk");
  const mojibake = Buffer.from(gbkSrc.toString("latin1"), "utf8");
  const r1 = repairEncodedBytes(mojibake, ["gbk", "gb18030"]);
  check(
    "鍙岄噸杞爜淇杩樺師涓� GBK 瀛楄妭",
    r1 !== null && r1.kind === "mojibake" && bufEq(r1.bytes, gbkSrc),
    r1 ? `kind=${r1.kind}` : "null"
  );

  // 娣峰悎缂栫爜锛欸BK 涓讳綋 + AI 鐢� UTF-8 鍐欏叆鐨勫皯鏁拌
  const gbkLines = iconv.encode("绗竴琛岋細涓枃鍐呭\n绗簩琛岋細涔熸槸GBK\n", "gbk");
  const mixed = Buffer.concat([gbkLines, Buffer.from("绗笁琛岋細AI鍐欑殑UTF8\n", "utf8"), iconv.encode("绗洓琛岋細鍥炲埌GBK", "gbk")]);
  const r2 = repairEncodedBytes(mixed, ["gbk", "gb18030"]);
  const expectMixed = Buffer.concat([gbkLines, iconv.encode("绗笁琛岋細AI鍐欑殑UTF8\n", "gbk"), iconv.encode("绗洓琛岋細鍥炲埌GBK", "gbk")]);
  check(
    "娣峰悎缂栫爜淇锛歎TF-8 琛岃浆鍏� GBK 涓讳綋",
    r2 !== null && r2.kind === "mixed" && r2.encoding === "gbk" && bufEq(r2.bytes, expectMixed),
    r2 ? `kind=${r2.kind} enc=${r2.encoding}` : "null"
  );

  // 瀵圭О娣峰悎锛歎TF-8 涓讳綋 + GBK 灏戞暟琛� 鈫� 杞洖 UTF-8
  const utf8Lines = Buffer.from("绗竴琛岋細涓枃鍐呭\n绗簩琛岋細涔熸槸UTF8\n", "utf8");
  const mixed2 = Buffer.concat([utf8Lines, iconv.encode("绗笁琛岋細GBK鍐欏叆\n", "gbk")]);
  const r3 = repairEncodedBytes(mixed2, ["gbk", "gb18030"]);
  const expectMixed2 = Buffer.concat([utf8Lines, Buffer.from("绗笁琛岋細GBK鍐欏叆\n", "utf8")]);
  check(
    "娣峰悎缂栫爜淇锛欸BK 琛岃浆鍏� UTF-8 涓讳綋",
    r3 !== null && r3.kind === "mixed" && r3.encoding === "utf8" && bufEq(r3.bytes, expectMixed2),
    r3 ? `kind=${r3.kind} enc=${r3.encoding}` : "null"
  );

  check(
    "isMojibakeText锛氭甯镐腑鏂囧垽瀹� false",
    isMojibakeText(Buffer.from("杩欐槸姝ｅ父鐨勪腑鏂囧唴瀹�", "utf8").toString("utf8")) === false
  );
  check(
    "isMojibakeText锛歭atin1 璺緞 mojibake 鍒ゅ畾 true",
    isMojibakeText(mojibake.toString("utf8")) === true
  );

  console.log("== 娆ф床璇█璇垽鍥炲綊锛坉arkreader ro locale 鍦烘櫙锛�==");

  // 鍦烘櫙锛氬共鍑€鐨勭綏椹凹浜氳 locale JSON锛埬�/卯/芒 鈮�0xFF锛屓�/葲 >0xFF锛夛紝鍑犱箮鍏� Latin銆�
  // 鏇捐璇垽涓� GBK 鍙岄噸杞爜锛歭atin1 閫嗗悜鏃跺彉闊冲瓧姣嶈闈欓粯鏇挎崲鎴� '?'锛�
  // 鐢熸垚 7267 瀛楄妭鎹熷潖鐗堬紝鍐嶈 GBK 瀵规挒鍑虹殑 2 涓绔嬫眽瀛�"楠岃瘉"閫氳繃銆�
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
    "鍓嶇疆纭锛氱綏椹凹浜氳鏂囨湰琚� isMojibakeText 鍒や负 true锛堝鐜拌鍒ゅ墠鎻愶級",
    isMojibakeText(roText) === true
  );
  check(
    "骞插噣缃楅┈灏间簹璇枃浠朵笉瑙﹀彂浠讳綍淇锛堣繑鍥� null锛�",
    repairEncodedBytes(roBytes, ["gbk", "gb18030"]) === null
  );
  check(
    "isReversibleMojibakeText锛氱綏椹凹浜氳鏂囨湰鍒ゅ畾 false锛堥€嗗悜鍑虹幇 '?'锛�",
    isReversibleMojibakeText(roText) === false
  );
  check("hasStrongCJK锛氱綏椹凹浜氳鏂囨湰鍒ゅ畾 false", hasStrongCJK(roText) === false);

  // 娉曡锛埫�/猫/莽 鍏ㄩ儴鍦� latin1 鍐咃紝鍙€嗭級锛屼繚鎶ゆ潵鑷己 CJK 闂ㄦ
  const frText =
    "R\u00e9sum\u00e9 : v\u00e9rifi\u00e9 \u00e0 partir d'une cr\u00e9ation d\u00e9j\u00e0 termin\u00e9e. " +
    "D\u00e9\u00e7u, tr\u00e8s d\u00e9\u00e7u par cette r\u00e9p\u00e9tition.\n";
  check(
    "骞插噣娉曡鏂囨湰涓嶈Е鍙戜换浣曚慨澶嶏紙杩斿洖 null锛�",
    repairEncodedBytes(Buffer.from(frText, "utf8"), ["gbk", "gb18030"]) === null
  );

  check("hasStrongCJK锛氱湡瀹炰腑鏂囪瘝缁勫垽瀹� true", hasStrongCJK("涓枃鍐呭淇娴嬭瘯") === true);
  check("hasStrongCJK锛氶浂鏄熷崟涓眽瀛楀垽瀹� false", hasStrongCJK("a涓璪鏂嘽") === false);
  check(
    "isReversibleMojibakeText锛歭atin1 鍙岄噸杞爜鍒ゅ畾 true",
    isReversibleMojibakeText(mojibake.toString("utf8")) === true
  );

  console.log("== 椤圭洰鏂囦欢缂栫爜宸℃ ==");
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
    check(`${rel} 鈫� ${enc}`, ok);
  }

  console.log(`\n缁撴灉锛�${passed} 閫氳繃锛�${failed} 澶辫触`);
  process.exit(failed > 0 ? 1 : 0);
}

// 涓ユ牸 UTF-8 鏍￠獙锛堜笉渚濊禆 Node 瀹芥澗鐨勬浛鎹㈣涓猴級
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
  console.error("娴嬭瘯鎵ц澶辫触:", e);
  process.exit(1);
});
