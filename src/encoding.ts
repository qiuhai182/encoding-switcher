// 缂栫爜妫€娴嬪伐鍏锋ā鍧楋紙閫氱敤鍖栵細鍊欓€夌紪鐮佺敱璋冪敤鏂逛紶鍏ワ紝涓嶉檺瀹氬叿浣撶紪鐮侊級
// 璁捐鎬濊矾锛�
// 1. 鍏堝垽鏂槸鍚︿负 UTF-8 BOM锛圗F BB BF锛夛紝鍛戒腑杩斿洖 "utf-8"銆�
// 2. 鍚﹀垯鍒ゆ槸鍚︿负鍚堟硶 UTF-8锛堟棤 BOM锛夛紝鍛戒腑杩斿洖 "utf8"锛圴SCode 涓� = UTF-8 鏃� BOM锛夈€�
//    娉ㄦ剰锛歏SCode 缂栫爜鏍囩閲� "utf-8" 甯� BOM锛�"utf8" 涓嶅甫 BOM锛屼簩鑰呬笉鍙贩鐢ㄣ€�
// 3. 鑻ヤ笉鏄� UTF-8锛屾寜璋冪敤鏂逛紶鍏ョ殑鍊欓€夌紪鐮佸垪琛ㄤ緷娆¤瘯瑙ｇ爜锛�
//    鏃犳浛鎹㈠瓧绗︼紙U+FFFD锛夊嵆瑙嗕负鍛戒腑锛岃繑鍥炶缂栫爜鍚嶃€�
// 4. 鍏ㄩ儴澶辫触杩斿洖 "unknown"銆�

import * as iconv from "iconv-lite";

// 妫€娴嬬粨鏋滐細"utf-8" = UTF-8 with BOM锛�"utf8" = UTF-8 鏃� BOM锛�
// "unknown" = 鏃犳硶璇嗗埆锛涘叾浣欎负璋冪敤鏂瑰€欓€夊垪琛ㄤ腑鐨勭紪鐮佸悕锛坕conv-lite 鏀寔鐨勭紪鐮侊級
export type DetectedEncoding = "utf-8" | "utf8" | "unknown" | (string & {});

// 鍒ゆ柇瀛楄妭搴忓垪鏄惁涓哄悎娉� UTF-8锛堜笉鍚� BOM 鍒ゅ畾锛岃皟鐢ㄦ柟宸插鐞� BOM锛�
export function isUtf8(bytes: Uint8Array): boolean {
  let i = 0;
  const n = bytes.length;

  while (i < n) {
    const b0 = bytes[i];
    let extra = 0;
    let min = 0;
    if (b0 < 0x80) {
      i += 1;
      continue;
    } else if ((b0 & 0xe0) === 0xc0) {
      extra = 1;
      min = 0x80;
    } else if ((b0 & 0xf0) === 0xe0) {
      extra = 2;
      min = 0x800;
    } else if ((b0 & 0xf8) === 0xf0) {
      extra = 3;
      min = 0x10000;
    } else {
      return false; // 闈炴硶棣栧瓧鑺�
    }

    if (i + extra >= n) {
      return false;
    }

    let cp = b0 & (0xff >> (extra + 1));
    for (let k = 1; k <= extra; k++) {
      const bk = bytes[i + k];
      if ((bk & 0xc0) !== 0x80) {
        return false;
      }
      cp = (cp << 6) | (bk & 0x3f);
    }

    if (cp < min) {
      return false; // 杩囧害缂栫爜
    }
    // 浠ｇ悊鍖洪潪娉�
    if (cp >= 0xd800 && cp <= 0xdfff) {
      return false;
    }
    i += extra + 1;
  }
  return true;
}

// 鐢� iconv-lite 鍋氭潈濞佽В鐮�
// iconv-lite 閬囨棤娉曡В鐮佸瓧鑺備細杈撳嚭鏇挎崲瀛楃 U+FFFD锛堜笉鎶涢敊锛夛紝闇€鑷鍒ゅ畾涓洪潪娉�
function decodeWith(encoding: string, bytes: Uint8Array): string | null {
  try {
    const text = iconv.decode(Buffer.from(bytes), encoding);
    if (text.includes("\ufffd")) {
      return null;
    }
    return text;
  } catch {
    return null;
  }
}

// 涓绘娴嬪叆鍙ｏ細candidates 涓� UTF-8 涔嬪鐨勫€欓€夌紪鐮佸垪琛紙鎸変紭鍏堢骇鎺掑簭锛夛紝
// 浣跨敤 iconv-lite 鏀寔鐨勭紪鐮佸悕锛堝 gbk銆乬b18030銆乥ig5銆乻hift_jis銆乧p1252 绛夛級
export function detectEncoding(
  bytes: Uint8Array,
  candidates: string[] = ["gbk", "gb18030"]
): DetectedEncoding {
  if (bytes.length === 0) {
    return "utf8";
  }

  // 1. UTF-8 BOM 鐩存帴鍒ゅ畾锛堝甫 BOM锛�
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return "utf-8";
  }

  // 2. 鍚堟硶 UTF-8锛堟棤 BOM锛�
  if (isUtf8(bytes)) {
    return "utf8";
  }

  // 3. 渚濇灏濊瘯鍊欓€夌紪鐮侊細鍙畬鏁磋В鐮侊紙鏃犳浛鎹㈠瓧绗︼級鍗冲懡涓�
  for (const enc of candidates) {
    if (enc === "utf8" || enc === "utf-8") {
      continue; // 宸插湪涓婇潰鏍￠獙杩�
    }
    if (decodeWith(enc, bytes) !== null) {
      return enc;
    }
  }

  return "unknown";
}
