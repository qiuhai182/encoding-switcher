// 字节级编码修复模块
//
// 设计原则（对应需求）：
// 1. 只做"纯字节转码"，绝不重组/重排文本 —— 修复仅改变字符的编码表示，
//    文本内容、换行符位置一一对应；
// 2. 行数不变的数学保证：UTF-8 多字节序列（续字节 0x80~0xBF）与
//    GBK/GB18030 双字节序列（第二字节 0x40~0x7E、0x80~0xFE）都不含 0x0A，
//    所以纯转码不会把换行符吞进多字节序列 —— 再用计数校验兜底；
// 3. 三道硬校验，任一失败整体放弃修复（返回 null，交由上层告警）：
//    a. 无损校验：修复后字节按目标编码解码必须零替换字符（U+FFFD）
//    b. 行数校验：修复前后 0x0A 字节计数必须相等
//    c. 回环/行级校验：转码方向上不可表达的字符（如 emoji 转 GBK）行级 round-trip 失败即放弃
// 4. 不可逆损坏（AI 写盘时已发生 U+FFFD 替换/字符丢失）在数学上无法恢复，
//    本模块直接返回 null，由上层告警提示。

import * as iconv from "iconv-lite";
import { isUtf8 } from "./encoding";

export interface RepairResult {
  bytes: Buffer; // 修复后的完整文件字节
  encoding: string; // 目标编码（= 文件"原本"的编码）
  kind: "mojibake" | "mixed" | "migrate"; // 双重转码 / 分段混合 / 编码迁移回滚
}

// 解码并要求零替换字符（与 encoding.ts 的 decodeWith 同规则）
function decodeWith(encoding: string, bytes: Uint8Array): string | null {
  try {
    const text = iconv.decode(Buffer.from(bytes), encoding);
    return text.includes("\ufffd") ? null : text;
  } catch {
    return null;
  }
}

// 统计 0x0A 字节数（行数兜底校验用）
function countNewlines(b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x0a) {
      n++;
    }
  }
  return n;
}

// 是否包含中日韩表意字符
export function containsCJK(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(text);
}

// 强 CJK 判定：必须出现"成词"的表意文字才可信。
// 背景：罗马尼亚语/法语等欧洲语言文件经 GBK 解码时，变音字母与相邻字节
// 会随机对撞出零星 CJK 字符（如 ro locale 全文恰好对撞出 2 个），
// 仅凭 containsCJK（1 个即可）不足以支撑一次主动改写文件的修复，
// 曾导致把干净的欧洲语言 UTF-8 文件误判为 GBK 双重转码并"修复"损坏。
// 门槛：CJK 字符 ≥3 且 相邻 CJK 对 ≥2 —— 真实中文词组（≥3 字词）
// 必然满足；随机对撞几乎不可能产生连续 CJK。
export function hasStrongCJK(text: string): boolean {
  let cjk = 0;
  let pairs = 0;
  let prevCjk = false;
  for (const ch of text) {
    const isCjk = /[\u3400-\u4dbf\u4e00-\u9fff]/.test(ch);
    if (isCjk) {
      cjk++;
      if (prevCjk) {
        pairs++;
      }
    }
    prevCjk = isCjk;
  }
  return cjk >= 3 && pairs >= 2;
}

// cp1252 在 0x80~0x9F 区间映射出的特殊字符（€???… 等）
const CP1252_SPECIAL = /^[\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178]$/;

// 双重转码快速预判：UTF-8 解码出的文本应"几乎全是 Latin 字符"。
// 正常 UTF-8 中文文件的文本含大量 CJK（码点 >0xFF），此判定为 false，
// 因此不会误伤正常中文文件；双重转码 mojibake（GBK 字节经 latin1 路径
// 变成 UTF-8）的文本则几乎全在 Latin 区。
export function isMojibakeText(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  let latin = 0;
  let other = 0;
  let ext = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0xff) {
      latin++;
      if (cp > 0x7f) {
        ext++;
      }
    } else {
      // 允许少量 cp1252 特征字符（0x80~0x9F 区间映射出的标点/符号）
      if (CP1252_SPECIAL.test(ch)) {
        latin++;
        ext++;
      } else {
        other++;
      }
    }
  }
  // 至少 2 个扩展 Latin 字符（纯 ASCII 无转码意义），且非 Latin 占比极低
  return ext >= 2 && other / (latin + other) < 0.05;
}

// 可逆 mojibake 判定：文本像双重转码，且能经 latin1/cp1252 逆向无损还原。
// 用于修复/告警触发前的把关：正常的欧洲语言文本（罗马尼亚语 ă/ș/ț、
// 波兰语 ł 等latin1 不可表达的字符）逆向时会被替换成 '?'，回读不一致，
// 据此把它们从 mojibake 候选里排除，防止把干净文件"修复"成损坏。
// 尾部单个 U+FFFD 视为头部截断伪影（64KB 头部切断多字节序列），剔除后验证。
export function isReversibleMojibakeText(text: string): boolean {
  if (!isMojibakeText(text)) {
    return false;
  }
  const t = text.endsWith("\ufffd") ? text.slice(0, -1) : text;
  for (const revEnc of ["latin1", "cp1252"]) {
    try {
      const orig = iconv.encode(t, revEnc);
      if (iconv.decode(orig, revEnc) === t) {
        return true;
      }
    } catch {
      // 忽略
    }
  }
  return false;
}

// 模式一：双重转码修复（可逆）
// 损坏路径：原 GBK 等编码字节 --latin1/cp1252 逐字节解读--> 字符串 --UTF-8 写盘--> 现文件
// 修复路径：现字节 --UTF-8 解码--> mojibake 字符串 --latin1/cp1252 编码--> 厘米原字节
// 再用候选编码验证原字节无损且含中文，验证通过的候选即为目标编码
function tryFixMojibake(
  bytes: Buffer,
  candidates: string[],
  nlCount: number
): RepairResult | null {
  if (!isUtf8(bytes)) {
    return null; // 双重转码的文件必然是合法 UTF-8
  }
  const text = bytes.toString("utf8");
  if (!isMojibakeText(text)) {
    return null; // 是正常 UTF-8 内容（含 CJK 等），不处理
  }

  // 逆向编码尝试：latin1（字节?码点一一对应，最常见）；文本含 cp1252
  // 特征字符（>0xFF）时优先 cp1252
  const attempts: string[] = ["latin1"];
  let hasSpecial = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp > 0xff && !CP1252_SPECIAL.test(ch)) {
      hasSpecial = false; // 占位（不会到达：isMojibakeText 已过滤）
      break;
    }
    if (cp > 0xff) {
      hasSpecial = true;
    }
  }
  if (hasSpecial) {
    attempts.unshift("cp1252");
  }

  for (const revEnc of attempts) {
    let orig: Buffer;
    try {
      orig = iconv.encode(text, revEnc);
    } catch {
      continue;
    }
    // 逆向编码无损校验：latin1/cp1252 表达不了的字符（罗马尼亚语 ă/ș/ț、
    // 波兰语 ł、越南语 ệ 等）会被 iconv 静默替换成 '?'（0x3F）。
    // 真 mojibake 的逆向还原是逐字节零替换的；出现 '?' 即说明这是
    // 正常的欧洲语言文本而非转码损坏，绝不能"修复"（会把字符真弄丢）。
    // 校验方式：逆向字节按 revEnc 解回必须与原文一致。
    let back: string | null;
    try {
      const dec = iconv.decode(orig, revEnc);
      back = dec.includes("\ufffd") ? null : dec;
    } catch {
      back = null;
    }
    if (back !== text) {
      continue;
    }
    if (countNewlines(orig) !== nlCount) {
      continue; // 行数兜底（数学上不会发生）
    }
    // 用候选编码验证还原出的字节：无损解码且含成词中文内容
    // （强 CJK 门槛：零星对撞出的 1~2 个 CJK 字符不可信）
    for (const cand of candidates) {
      const dec = decodeWith(cand, orig);
      if (dec === null) {
        continue;
      }
      if (!hasStrongCJK(dec)) {
        continue; // 还原后必须出现中文词组，否则转码无意义
      }
      return { bytes: orig, encoding: cand, kind: "mojibake" };
    }
  }
  return null;
}

// 模式二：分段混合编码修复（行级）
// 场景：原 GBK 文件被 AI 用 UTF-8 追加/改写部分行（或对称场景）。
// 关键观察：任何多字节序列都不含 0x0A，按 \n 切行不会截断字符，
// 因此可以逐行判定编码归属，把少数派编码的行无损转成多数派编码。
// 行内混合（同一行既有原编码又有 AI 写入的编码）无法仅凭字节可靠切分，
// 该行归为 bad，整体放弃修复（交由上层告警），绝不猜测。
function tryFixMixed(
  bytes: Buffer,
  candidates: string[],
  nlCount: number
): RepairResult | null {
  // 剥离 BOM（BOM 不参与转码，原样保留）
  let bom: Buffer | null = null;
  let body = bytes;
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    bom = Buffer.from(bytes.subarray(0, 3));
    body = bytes.subarray(3);
  }

  // 按 \n 切行（\n 保留在行尾；最后可能有无换行的尾行）
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === 0x0a) {
      lines.push(body.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (start < body.length) {
    lines.push(body.subarray(start));
  }
  if (lines.length === 0) {
    return null;
  }

  type RowClass = "ascii" | "utf8" | "primary" | "bad";
  // 对每个候选编码做行分类，选第一个"自洽"（无 bad 行、primary 行含中文）的候选
  let best: { cand: string; rows: RowClass[] } | null = null;
  for (const cand of candidates) {
    const rows: RowClass[] = [];
    let bad = 0;
    for (const ln of lines) {
      let cls: RowClass;
      let isAscii = true;
      for (let i = 0; i < ln.length; i++) {
        if (ln[i] >= 0x80) {
          isAscii = false;
          break;
        }
      }
      if (isAscii) {
        cls = "ascii";
      } else if (isUtf8(ln) && containsCJK(ln.toString("utf8"))) {
        cls = "utf8"; // AI 写入的 UTF-8 中文行（优先归类）
      } else if (decodeWith(cand, ln) !== null) {
        cls = "primary";
      } else if (isUtf8(ln)) {
        cls = "utf8"; // 合法 UTF-8 但非中文内容（符号/其他语言）
      } else {
        cls = "bad";
        bad++;
      }
      rows.push(cls);
    }
    if (bad > 0) {
      continue; // 存在无法归类的行（可能行内混合/损坏），该候选不可自洽
    }
    // primary 行必须存在且含中文，确保它真是"内容主体"而非巧合
    let primaryHasCJK = false;
    for (let i = 0; i < lines.length; i++) {
      if (rows[i] === "primary") {
        const dec = decodeWith(cand, lines[i]);
        if (dec && containsCJK(dec)) {
          primaryHasCJK = true;
          break;
        }
      }
    }
    if (!primaryHasCJK) {
      continue;
    }
    best = { cand, rows };
    break; // 按配置优先级取第一个自洽候选
  }
  if (!best) {
    return null;
  }
  const { cand, rows } = best;
  let primaryN = 0;
  let utf8N = 0;
  for (const r of rows) {
    if (r === "primary") {
      primaryN++;
    } else if (r === "utf8") {
      utf8N++;
    }
  }
  if (utf8N === 0) {
    return null; // 无混合（全文同一编码）
  }

  // 修复方向：把少数派编码的行无损转成多数派编码
  const parts: Buffer[] = [];
  if (bom) {
    parts.push(bom);
  }
  let target: string;
  if (utf8N <= primaryN) {
    // 原编码是 cand，AI 用 UTF-8 写入了少数行 → 转回 cand
    // （平票时偏向 cand：detectionEncodings 本身表达了环境主导编码，
    //   且行级 round-trip 校验保证任一方向内容都无损）
    target = cand;
    for (let i = 0; i < lines.length; i++) {
      if (rows[i] === "utf8") {
        const t = lines[i].toString("utf8");
        const enc = iconv.encode(t, cand);
        // 行级 round-trip 校验：转过去再解回来必须一致（防 emoji 等不可表达字符丢失）
        if (decodeWith(cand, enc) !== t) {
          return null;
        }
        parts.push(enc);
      } else {
        parts.push(Buffer.from(lines[i]));
      }
    }
  } else if (primaryN < utf8N) {
    // 原编码是 UTF-8，AI 用 cand 写入了少数行 → 转回 UTF-8
    target = "utf8";
    for (let i = 0; i < lines.length; i++) {
      if (rows[i] === "primary") {
        const t = decodeWith(cand, lines[i]);
        if (t === null) {
          return null;
        }
        parts.push(Buffer.from(t, "utf8"));
      } else {
        parts.push(Buffer.from(lines[i]));
      }
    }
  } else {
    return null; // 对半分，无法判定主体编码，保守放弃
  }

  const result = Buffer.concat(parts);
  // 最终校验：全文按目标编码无损解码 + 行数不变
  if (target === "utf8") {
    if (!isUtf8(result)) {
      return null;
    }
  } else if (decodeWith(target, result) === null) {
    return null;
  }
  if (countNewlines(result) !== nlCount) {
    return null;
  }
  return { bytes: result, encoding: target, kind: "mixed" };
}

// ===== 编码迁移回滚：内容无损但编码被整体改写 =====
//
// 场景：AI 工具正确读出文本后，用错误编码写盘 ——
//   GBK 文件被整体按 UTF-8 重写（内容正确、编码变 utf8），或对称地
//   UTF-8 文件被整体按 GBK 重写（内容正确、编码变 gbk）。
// 修复 = 转回原编码。调用方依据 watcher 的历史编码记录（lastEnc）判定
// "原编码"，本函数只负责安全转换：
//   1. 跨编码族校验（UTF 族 ↔ 非 UTF 族才有意义）
//   2. 当前编码必须无损解码（内容完好是回滚前提）
//   3. round-trip 校验：转回目标编码再解回来必须与原文一致 ——
//      拦下目标编码不可表达的字符（如 emoji 转 GBK），防止修复本身丢内容
//   4. 行数不变校验
export function migrateEncodingBytes(
  bytes: Buffer,
  currentEnc: string,
  targetEnc: string
): Buffer | null {
  if (bytes.length === 0) {
    return null;
  }
  const curUtf = currentEnc === "utf8" || currentEnc === "utf-8";
  const tgtUtf = targetEnc === "utf8" || targetEnc === "utf-8";
  if (curUtf === tgtUtf) {
    return null; // 同族（utf8/utf-8 视为一致），无需迁移
  }
  // 当前编码无损解码（BOM 剥离：内容文本不应含 BOM 字符）
  let text: string | null;
  if (curUtf) {
    text = bytes.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
  } else {
    text = decodeWith(currentEnc, bytes);
  }
  if (text === null || text.length === 0) {
    return null;
  }
  // 转回目标编码（目标为 UTF 族时统一无 BOM）
  const converted = iconv.encode(text, tgtUtf ? "utf8" : targetEnc);
  // round-trip 校验：转过去再解回来必须与原文逐字一致
  let back: string | null;
  if (tgtUtf) {
    back = isUtf8(converted) ? converted.toString("utf8") : null;
  } else {
    back = decodeWith(targetEnc, converted);
  }
  if (back !== text) {
    return null; // 目标编码无法无损表达（emoji 等），放弃修复并交由上层告警
  }
  if (countNewlines(converted) !== countNewlines(bytes)) {
    return null;
  }
  return converted;
}

// 修复入口：依次尝试双重转码、分段混合；无法安全修复返回 null
export function repairEncodedBytes(
  bytes: Buffer,
  candidates: string[]
): RepairResult | null {
  if (bytes.length === 0) {
    return null;
  }
  const nlCount = countNewlines(bytes);
  return tryFixMojibake(bytes, candidates, nlCount) ?? tryFixMixed(bytes, candidates, nlCount);
}
