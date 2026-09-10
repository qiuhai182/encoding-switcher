#!/usr/bin/env python3
"""批量将目录内文本文件转换为 UTF-8 编码。

用法:
    python convert_to_utf8.py [目录] [--dry-run] [--backup] [--ext .py,.txt] [--strip-bom]

说明:
    - 自动跳过二进制文件及常见二进制扩展名
    - 已是 UTF-8 的文件不重写（带 BOM 的 UTF-8 默认保留，可用 --strip-bom 去除）
    - 依次尝试识别编码: UTF-8 / UTF-8(BOM) / UTF-16(BOM) / GB18030 / Big5 / Shift-JIS / Latin-1
"""

import argparse
import shutil
import sys
from pathlib import Path

# UTF-8 之后的候选编码（按顺序尝试）
CANDIDATE_ENCODINGS = ["gb18030", "big5", "shift_jis", "latin-1"]

# 跳过的目录名
SKIP_DIRS = {".git", ".hg", ".svn", "__pycache__", "node_modules", ".venv", "venv", ".idea", ".vscode"}

# 常见二进制扩展名，直接跳过
BINARY_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".zip", ".rar", ".7z", ".tar", ".gz",
    ".exe", ".dll", ".so", ".dylib", ".bin", ".dat",
    ".mp3", ".mp4", ".avi", ".mkv", ".mov", ".wav", ".flac",
    ".ttf", ".otf", ".woff", ".woff2", ".eot",
    ".pyc", ".pyd", ".class", ".jar", ".db", ".sqlite",
}

STATUS_LABELS = {
    "converted": "已转换",
    "utf8": "已是UTF-8",
    "bom": "UTF-8 BOM",
    "binary": "二进制",
    "locked": "被占用跳过",
    "unknown": "未识别",
}


def looks_binary(data: bytes) -> bool:
    """启发式判断是否为二进制内容。"""
    if not data:
        return False
    if b"\x00" in data:
        return True
    sample = data[:8192]
    # 不可打印控制字节（除 \t \n \v \f \r）占比过高视为二进制
    non_text = sum(b < 9 or 13 < b < 32 for b in sample)
    return non_text / len(sample) > 0.3


def detect_encoding(data: bytes) -> str | None:
    """返回检测到的编码名；'utf-8'/'utf-8-sig' 表示无需转换；None 表示无法识别。"""
    if data.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return "utf-16"
    try:
        data.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError:
        pass
    for enc in CANDIDATE_ENCODINGS:
        try:
            data.decode(enc)
        except UnicodeDecodeError:
            continue
        # latin-1 永远能解码成功，若几乎不含可打印 ASCII 则视为二进制误判
        if enc == "latin-1":
            sample = data[:8192]
            printable = sum(32 <= b < 127 for b in sample)
            if printable < len(sample) * 0.3:
                return None
        return enc
    return None


def process_file(path: Path, args: argparse.Namespace) -> tuple[str, str]:
    """处理单个文件，返回 (状态, 详情)。"""
    data = path.read_bytes()
    if looks_binary(data):
        return "binary", "疑似二进制内容"

    enc = detect_encoding(data)
    if enc is None:
        return "unknown", "无法识别编码"

    if enc == "utf-8":
        return "utf8", ""

    if enc == "utf-8-sig":
        if args.strip_bom:
            text = data.decode("utf-8-sig")
            if not args.dry_run:
                path.write_bytes(text.encode("utf-8"))
            return "converted", "UTF-8 BOM -> UTF-8"
        return "bom", "已是 UTF-8（带 BOM）"

    # 其他编码 -> UTF-8
    text = data.decode(enc)
    if args.dry_run:
        return "converted", f"{enc} -> UTF-8（未写入）"
    if args.backup:
        shutil.copy2(path, path.with_name(path.name + ".bak"))
    path.write_bytes(text.encode("utf-8"))
    return "converted", f"{enc} -> UTF-8"


def main() -> None:
    parser = argparse.ArgumentParser(description="批量将目录内文本文件转换为 UTF-8 编码")
    parser.add_argument("directory", nargs="?", default=".", help="目标目录，默认当前目录")
    parser.add_argument("--dry-run", action="store_true", help="仅检测，不实际写入")
    parser.add_argument("--backup", action="store_true", help="转换前生成 <文件名>.bak 备份")
    parser.add_argument("--ext", default="", help="仅处理指定扩展名，逗号分隔，如: .py,.txt")
    parser.add_argument("--strip-bom", action="store_true", help="将带 BOM 的 UTF-8 文件重写为无 BOM UTF-8")
    args = parser.parse_args()

    root = Path(args.directory)
    if not root.is_dir():
        print(f"错误: 目录不存在 -> {root}")
        sys.exit(1)

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")

    exts = None
    if args.ext:
        exts = {x.lower() if x.lower().startswith(".") else "." + x.lower()
                for x in (e.strip() for e in args.ext.split(",")) if x}

    counts = dict.fromkeys(STATUS_LABELS, 0)
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if exts is not None and path.suffix.lower() not in exts:
            continue
        if path.suffix.lower() in BINARY_EXTS:
            counts["binary"] += 1
            continue

        try:
            status, detail = process_file(path, args)
        except PermissionError:
            # 被其他进程锁定（如浏览器缓存），计入汇总但不逐个打印
            counts["locked"] += 1
            continue
        except (UnicodeDecodeError, UnicodeEncodeError, OSError) as e:
            status, detail = "unknown", f"处理失败: {e}"
        counts[status] += 1

        if status == "converted":
            print(f"[已转换] {path}  ({detail})")
        elif status == "unknown":
            print(f"[未识别] {path}  ({detail})")
        elif status == "bom":
            print(f"[UTF-8 BOM] {path}  (可用 --strip-bom 去除)")

    print("\n===== 汇总 =====")
    for key, label in STATUS_LABELS.items():
        print(f"{label}: {counts[key]}")


if __name__ == "__main__":
    main()