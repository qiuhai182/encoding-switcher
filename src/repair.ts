// 瀛楄妭绾х紪鐮佷慨澶嶆ā鍧�
//
// 璁捐鍘熷垯锛堝搴旈渶姹傦級锛�
// 1. 鍙仛"绾瓧鑺傝浆鐮�"锛岀粷涓嶉噸缁�/閲嶆帓鏂囨湰 鈥斺€� 淇浠呮敼鍙樺瓧绗︾殑缂栫爜琛ㄧず锛�
//    鏂囨湰鍐呭銆佹崲琛岀浣嶇疆涓€涓€瀵瑰簲锛�
// 2. 琛屾暟涓嶅彉鐨勬暟瀛︿繚璇侊細UTF-8 澶氬瓧鑺傚簭鍒楋紙缁瓧鑺� 0x80~0xBF锛変笌
//    GBK/GB18030 鍙屽瓧鑺傚簭鍒楋紙绗簩瀛楄妭 0x40~0x7E銆�0x80~0xFE锛夐兘涓嶅惈 0x0A锛�
//    鎵€浠ョ函杞爜涓嶄細鎶婃崲琛岀鍚炶繘澶氬瓧鑺傚簭鍒� 鈥斺€� 鍐嶇敤璁℃暟鏍￠獙鍏滃簳锛�
// 3. 涓夐亾纭牎楠岋紝浠讳竴澶辫触鏁翠綋鏀惧純淇锛堣繑鍥� null锛屼氦鐢变笂灞傚憡璀︼級锛�
//    a. 鏃犳崯鏍￠獙锛氫慨澶嶅悗瀛楄妭鎸夌洰鏍囩紪鐮佽В鐮佸繀椤婚浂鏇挎崲瀛楃锛圲+FFFD锛�
//    b. 琛屾暟鏍￠獙锛氫慨澶嶅墠鍚� 0x0A 瀛楄妭璁℃暟蹇呴』鐩哥瓑
//    c. 鍥炵幆/琛岀骇鏍￠獙锛氳浆鐮佹柟鍚戜笂涓嶅彲琛ㄨ揪鐨勫瓧绗︼紙濡� emoji 杞� GBK锛夎绾� round-trip 澶辫触鍗虫斁寮�
// 4. 涓嶅彲閫嗘崯鍧忥紙AI 鍐欑洏鏃跺凡鍙戠敓 U+FFFD 鏇挎崲/瀛楃涓㈠け锛夊湪鏁板涓婃棤娉曟仮澶嶏紝
//    鏈ā鍧楃洿鎺ヨ繑鍥� null锛岀敱涓婂眰鍛婅鎻愮ず銆�

import * as iconv from "iconv-lite";
import { isUtf8 } from "./encoding";

export interface RepairResult {
  bytes: Buffer; // 淇鍚庣殑瀹屾暣鏂囦欢瀛楄妭
  encoding: string; // 鐩爣缂栫爜锛�= 鏂囦欢"鍘熸湰"鐨勭紪鐮侊級
  kind: "mojibake" | "mixed" | "migrate"; // 鍙岄噸杞爜 / 鍒嗘娣峰悎 / 缂栫爜杩佺Щ鍥炴粴
}

// 瑙ｇ爜骞惰姹傞浂鏇挎崲瀛楃锛堜笌 encoding.ts 鐨� decodeWith 鍚岃鍒欙級
function decodeWith(encoding: string, bytes: Uint8Array): string | null {
  try {
    const text = iconv.decode(Buffer.from(bytes), encoding);
    return text.includes("\ufffd") ? null : text;
  } catch {
    return null;
  }
}

// 缁熻 0x0A 瀛楄妭鏁帮紙琛屾暟鍏滃簳鏍￠獙鐢級
function countNewlines(b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x0a) {
      n++;
    }
  }
  return n;
}

// 鏄惁鍖呭惈涓棩闊╄〃鎰忓瓧绗�
export function containsCJK(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(text);
}

// 寮� CJK 鍒ゅ畾锛氬繀椤诲嚭鐜�"鎴愯瘝"鐨勮〃鎰忔枃瀛楁墠鍙俊銆�
// 鑳屾櫙锛氱綏椹凹浜氳/娉曡绛夋娲茶瑷€鏂囦欢缁� GBK 瑙ｇ爜鏃讹紝鍙橀煶瀛楁瘝涓庣浉閭诲瓧鑺�
// 浼氶殢鏈哄鎾炲嚭闆舵槦 CJK 瀛楃锛堝 ro locale 鍏ㄦ枃鎭板ソ瀵规挒鍑� 2 涓級锛�
// 浠呭嚟 containsCJK锛�1 涓嵆鍙級涓嶈冻浠ユ敮鎾戜竴娆′富鍔ㄦ敼鍐欐枃浠剁殑淇锛�
// 鏇惧鑷存妸骞插噣鐨勬娲茶瑷€ UTF-8 鏂囦欢璇垽涓� GBK 鍙岄噸杞爜骞�"淇"鎹熷潖銆�
// 闂ㄦ锛欳JK 瀛楃 鈮�3 涓� 鐩搁偦 CJK 瀵� 鈮�2 鈥斺€� 鐪熷疄涓枃璇嶇粍锛堚墺3 瀛楄瘝锛�
// 蹇呯劧婊¤冻锛涢殢鏈哄鎾炲嚑涔庝笉鍙兘浜х敓杩炵画 CJK銆�
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

// cp1252 鍦� 0x80~0x9F 鍖洪棿鏄犲皠鍑虹殑鐗规畩瀛楃锛堚偓???鈥� 绛夛級
const CP1252_SPECIAL = /^[\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178]$/;

// 鍙岄噸杞爜蹇€熼鍒わ細UTF-8 瑙ｇ爜鍑虹殑鏂囨湰搴�"鍑犱箮鍏ㄦ槸 Latin 瀛楃"銆�
// 姝ｅ父 UTF-8 涓枃鏂囦欢鐨勬枃鏈惈澶ч噺 CJK锛堢爜鐐� >0xFF锛夛紝姝ゅ垽瀹氫负 false锛�
// 鍥犳涓嶄細璇激姝ｅ父涓枃鏂囦欢锛涘弻閲嶈浆鐮� mojibake锛圙BK 瀛楄妭缁� latin1 璺緞
// 鍙樻垚 UTF-8锛夌殑鏂囨湰鍒欏嚑涔庡叏鍦� Latin 鍖恒€�
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
      // 鍏佽灏戦噺 cp1252 鐗瑰緛瀛楃锛�0x80~0x9F 鍖洪棿鏄犲皠鍑虹殑鏍囩偣/绗﹀彿锛�
      if (CP1252_SPECIAL.test(ch)) {
        latin++;
        ext++;
      } else {
        other++;
      }
    }
  }
  // 鑷冲皯 2 涓墿灞� Latin 瀛楃锛堢函 ASCII 鏃犺浆鐮佹剰涔夛級锛屼笖闈� Latin 鍗犳瘮鏋佷綆
  return ext >= 2 && other / (latin + other) < 0.05;
}

// 鍙€� mojibake 鍒ゅ畾锛氭枃鏈儚鍙岄噸杞爜锛屼笖鑳界粡 latin1/cp1252 閫嗗悜鏃犳崯杩樺師銆�
// 鐢ㄤ簬淇/鍛婅瑙﹀彂鍓嶇殑鎶婂叧锛氭甯哥殑娆ф床璇█鏂囨湰锛堢綏椹凹浜氳 膬/葯/葲銆�
// 娉㈠叞璇� 艂 绛塴atin1 涓嶅彲琛ㄨ揪鐨勫瓧绗︼級閫嗗悜鏃朵細琚浛鎹㈡垚 '?'锛屽洖璇讳笉涓€鑷达紝
// 鎹鎶婂畠浠粠 mojibake 鍊欓€夐噷鎺掗櫎锛岄槻姝㈡妸骞插噣鏂囦欢"淇"鎴愭崯鍧忋€�
// 灏鹃儴鍗曚釜 U+FFFD 瑙嗕负澶撮儴鎴柇浼奖锛�64KB 澶撮儴鍒囨柇澶氬瓧鑺傚簭鍒楋級锛屽墧闄ゅ悗楠岃瘉銆�
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
      // 蹇界暐
    }
  }
  return false;
}

// 妯″紡涓€锛氬弻閲嶈浆鐮佷慨澶嶏紙鍙€嗭級
// 鎹熷潖璺緞锛氬師 GBK 绛夌紪鐮佸瓧鑺� --latin1/cp1252 閫愬瓧鑺傝В璇�--> 瀛楃涓� --UTF-8 鍐欑洏--> 鐜版枃浠�
// 淇璺緞锛氱幇瀛楄妭 --UTF-8 瑙ｇ爜--> mojibake 瀛楃涓� --latin1/cp1252 缂栫爜--> 鍘樼背鍘熷瓧鑺�
// 鍐嶇敤鍊欓€夌紪鐮侀獙璇佸師瀛楄妭鏃犳崯涓斿惈涓枃锛岄獙璇侀€氳繃鐨勫€欓€夊嵆涓虹洰鏍囩紪鐮�
function tryFixMojibake(
  bytes: Buffer,
  candidates: string[],
  nlCount: number
): RepairResult | null {
  if (!isUtf8(bytes)) {
    return null; // 鍙岄噸杞爜鐨勬枃浠跺繀鐒舵槸鍚堟硶 UTF-8
  }
  const text = bytes.toString("utf8");
  if (!isMojibakeText(text)) {
    return null; // 鏄甯� UTF-8 鍐呭锛堝惈 CJK 绛夛級锛屼笉澶勭悊
  }

  // 閫嗗悜缂栫爜灏濊瘯锛歭atin1锛堝瓧鑺�?鐮佺偣涓€涓€瀵瑰簲锛屾渶甯歌锛夛紱鏂囨湰鍚� cp1252
  // 鐗瑰緛瀛楃锛�>0xFF锛夋椂浼樺厛 cp1252
  const attempts: string[] = ["latin1"];
  let hasSpecial = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp > 0xff && !CP1252_SPECIAL.test(ch)) {
      hasSpecial = false; // 鍗犱綅锛堜笉浼氬埌杈撅細isMojibakeText 宸茶繃婊わ級
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
    // 閫嗗悜缂栫爜鏃犳崯鏍￠獙锛歭atin1/cp1252 琛ㄨ揪涓嶄簡鐨勫瓧绗︼紙缃楅┈灏间簹璇� 膬/葯/葲銆�
    // 娉㈠叞璇� 艂銆佽秺鍗楄 峄� 绛夛級浼氳 iconv 闈欓粯鏇挎崲鎴� '?'锛�0x3F锛夈€�
    // 鐪� mojibake 鐨勯€嗗悜杩樺師鏄€愬瓧鑺傞浂鏇挎崲鐨勶紱鍑虹幇 '?' 鍗宠鏄庤繖鏄�
    // 姝ｅ父鐨勬娲茶瑷€鏂囨湰鑰岄潪杞爜鎹熷潖锛岀粷涓嶈兘"淇"锛堜細鎶婂瓧绗︾湡寮勪涪锛夈€�
    // 鏍￠獙鏂瑰紡锛氶€嗗悜瀛楄妭鎸� revEnc 瑙ｅ洖蹇呴』涓庡師鏂囦竴鑷淬€�
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
      continue; // 琛屾暟鍏滃簳锛堟暟瀛︿笂涓嶄細鍙戠敓锛�
    }
    // 鐢ㄥ€欓€夌紪鐮侀獙璇佽繕鍘熷嚭鐨勫瓧鑺傦細鏃犳崯瑙ｇ爜涓斿惈鎴愯瘝涓枃鍐呭
    // 锛堝己 CJK 闂ㄦ锛氶浂鏄熷鎾炲嚭鐨� 1~2 涓� CJK 瀛楃涓嶅彲淇★級
    for (const cand of candidates) {
      const dec = decodeWith(cand, orig);
      if (dec === null) {
        continue;
      }
      if (!hasStrongCJK(dec)) {
        continue; // 杩樺師鍚庡繀椤诲嚭鐜颁腑鏂囪瘝缁勶紝鍚﹀垯杞爜鏃犳剰涔�
      }
      return { bytes: orig, encoding: cand, kind: "mojibake" };
    }
  }
  return null;
}

// 妯″紡浜岋細鍒嗘娣峰悎缂栫爜淇锛堣绾э級
// 鍦烘櫙锛氬師 GBK 鏂囦欢琚� AI 鐢� UTF-8 杩藉姞/鏀瑰啓閮ㄥ垎琛岋紙鎴栧绉板満鏅級銆�
// 鍏抽敭瑙傚療锛氫换浣曞瀛楄妭搴忓垪閮戒笉鍚� 0x0A锛屾寜 \n 鍒囪涓嶄細鎴柇瀛楃锛�
// 鍥犳鍙互閫愯鍒ゅ畾缂栫爜褰掑睘锛屾妸灏戞暟娲剧紪鐮佺殑琛屾棤鎹熻浆鎴愬鏁版淳缂栫爜銆�
// 琛屽唴娣峰悎锛堝悓涓€琛屾棦鏈夊師缂栫爜鍙堟湁 AI 鍐欏叆鐨勭紪鐮侊級鏃犳硶浠呭嚟瀛楄妭鍙潬鍒囧垎锛�
// 璇ヨ褰掍负 bad锛屾暣浣撴斁寮冧慨澶嶏紙浜ょ敱涓婂眰鍛婅锛夛紝缁濅笉鐚滄祴銆�
function tryFixMixed(
  bytes: Buffer,
  candidates: string[],
  nlCount: number
): RepairResult | null {
  // 鍓ョ BOM锛圔OM 涓嶅弬涓庤浆鐮侊紝鍘熸牱淇濈暀锛�
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

  // 鎸� \n 鍒囪锛圽n 淇濈暀鍦ㄨ灏撅紱鏈€鍚庡彲鑳芥湁鏃犳崲琛岀殑灏捐锛�
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
  // 瀵规瘡涓€欓€夌紪鐮佸仛琛屽垎绫伙紝閫夌涓€涓�"鑷唇"锛堟棤 bad 琛屻€乸rimary 琛屽惈涓枃锛夌殑鍊欓€�
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
        cls = "utf8"; // AI 鍐欏叆鐨� UTF-8 涓枃琛岋紙浼樺厛褰掔被锛�
      } else if (decodeWith(cand, ln) !== null) {
        cls = "primary";
      } else if (isUtf8(ln)) {
        cls = "utf8"; // 鍚堟硶 UTF-8 浣嗛潪涓枃鍐呭锛堢鍙�/鍏朵粬璇█锛�
      } else {
        cls = "bad";
        bad++;
      }
      rows.push(cls);
    }
    if (bad > 0) {
      continue; // 瀛樺湪鏃犳硶褰掔被鐨勮锛堝彲鑳借鍐呮贩鍚�/鎹熷潖锛夛紝璇ュ€欓€変笉鍙嚜娲�
    }
    // primary 琛屽繀椤诲瓨鍦ㄤ笖鍚腑鏂囷紝纭繚瀹冪湡鏄�"鍐呭涓讳綋"鑰岄潪宸у悎
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
    break; // 鎸夐厤缃紭鍏堢骇鍙栫涓€涓嚜娲藉€欓€�
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
    return null; // 鏃犳贩鍚堬紙鍏ㄦ枃鍚屼竴缂栫爜锛�
  }

  // 淇鏂瑰悜锛氭妸灏戞暟娲剧紪鐮佺殑琛屾棤鎹熻浆鎴愬鏁版淳缂栫爜
  const parts: Buffer[] = [];
  if (bom) {
    parts.push(bom);
  }
  let target: string;
  if (utf8N <= primaryN) {
    // 鍘熺紪鐮佹槸 cand锛孉I 鐢� UTF-8 鍐欏叆浜嗗皯鏁拌 鈫� 杞洖 cand
    // 锛堝钩绁ㄦ椂鍋忓悜 cand锛歞etectionEncodings 鏈韩琛ㄨ揪浜嗙幆澧冧富瀵肩紪鐮侊紝
    //   涓旇绾� round-trip 鏍￠獙淇濊瘉浠讳竴鏂瑰悜鍐呭閮芥棤鎹燂級
    target = cand;
    for (let i = 0; i < lines.length; i++) {
      if (rows[i] === "utf8") {
        const t = lines[i].toString("utf8");
        const enc = iconv.encode(t, cand);
        // 琛岀骇 round-trip 鏍￠獙锛氳浆杩囧幓鍐嶈В鍥炴潵蹇呴』涓€鑷达紙闃� emoji 绛変笉鍙〃杈惧瓧绗︿涪澶憋級
        if (decodeWith(cand, enc) !== t) {
          return null;
        }
        parts.push(enc);
      } else {
        parts.push(Buffer.from(lines[i]));
      }
    }
  } else if (primaryN < utf8N) {
    // 鍘熺紪鐮佹槸 UTF-8锛孉I 鐢� cand 鍐欏叆浜嗗皯鏁拌 鈫� 杞洖 UTF-8
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
    return null; // 瀵瑰崐鍒嗭紝鏃犳硶鍒ゅ畾涓讳綋缂栫爜锛屼繚瀹堟斁寮�
  }

  const result = Buffer.concat(parts);
  // 鏈€缁堟牎楠岋細鍏ㄦ枃鎸夌洰鏍囩紪鐮佹棤鎹熻В鐮� + 琛屾暟涓嶅彉
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

// ===== 缂栫爜杩佺Щ鍥炴粴锛氬唴瀹规棤鎹熶絾缂栫爜琚暣浣撴敼鍐� =====
//
// 鍦烘櫙锛欰I 宸ュ叿姝ｇ‘璇诲嚭鏂囨湰鍚庯紝鐢ㄩ敊璇紪鐮佸啓鐩� 鈥斺€�
//   GBK 鏂囦欢琚暣浣撴寜 UTF-8 閲嶅啓锛堝唴瀹规纭€佺紪鐮佸彉 utf8锛夛紝鎴栧绉板湴
//   UTF-8 鏂囦欢琚暣浣撴寜 GBK 閲嶅啓锛堝唴瀹规纭€佺紪鐮佸彉 gbk锛夈€�
// 淇 = 杞洖鍘熺紪鐮併€傝皟鐢ㄦ柟渚濇嵁 watcher 鐨勫巻鍙茬紪鐮佽褰曪紙lastEnc锛夊垽瀹�
// "鍘熺紪鐮�"锛屾湰鍑芥暟鍙礋璐ｅ畨鍏ㄨ浆鎹細
//   1. 璺ㄧ紪鐮佹棌鏍￠獙锛圲TF 鏃� 鈫� 闈� UTF 鏃忔墠鏈夋剰涔夛級
//   2. 褰撳墠缂栫爜蹇呴』鏃犳崯瑙ｇ爜锛堝唴瀹瑰畬濂芥槸鍥炴粴鍓嶆彁锛�
//   3. round-trip 鏍￠獙锛氳浆鍥炵洰鏍囩紪鐮佸啀瑙ｅ洖鏉ュ繀椤讳笌鍘熸枃涓€鑷� 鈥斺€�
//      鎷︿笅鐩爣缂栫爜涓嶅彲琛ㄨ揪鐨勫瓧绗︼紙濡� emoji 杞� GBK锛夛紝闃叉淇鏈韩涓㈠唴瀹�
//   4. 琛屾暟涓嶅彉鏍￠獙
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
    return null; // 鍚屾棌锛坲tf8/utf-8 瑙嗕负涓€鑷达級锛屾棤闇€杩佺Щ
  }
  // 褰撳墠缂栫爜鏃犳崯瑙ｇ爜锛圔OM 鍓ョ锛氬唴瀹规枃鏈笉搴斿惈 BOM 瀛楃锛�
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
  // 杞洖鐩爣缂栫爜锛堢洰鏍囦负 UTF 鏃忔椂缁熶竴鏃� BOM锛�
  const converted = iconv.encode(text, tgtUtf ? "utf8" : targetEnc);
  // round-trip 鏍￠獙锛氳浆杩囧幓鍐嶈В鍥炴潵蹇呴』涓庡師鏂囬€愬瓧涓€鑷�
  let back: string | null;
  if (tgtUtf) {
    back = isUtf8(converted) ? converted.toString("utf8") : null;
  } else {
    back = decodeWith(targetEnc, converted);
  }
  if (back !== text) {
    return null; // 鐩爣缂栫爜鏃犳硶鏃犳崯琛ㄨ揪锛坋moji 绛夛級锛屾斁寮冧慨澶嶅苟浜ょ敱涓婂眰鍛婅
  }
  if (countNewlines(converted) !== countNewlines(bytes)) {
    return null;
  }
  return converted;
}

// 淇鍏ュ彛锛氫緷娆″皾璇曞弻閲嶈浆鐮併€佸垎娈垫贩鍚堬紱鏃犳硶瀹夊叏淇杩斿洖 null
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
