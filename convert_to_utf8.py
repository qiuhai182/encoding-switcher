#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""批量将目录内文本文件转换为 UTF-8 编码并统一换行符为 LF。

用法:
    python convert_to_utf8.py [目录] [--dry-run] [--backup] [--ext .py,.txt] [--strip-bom] [--eol lf|crlf|none] [--workers N] [--verbose]

说明:
    - 默认按文件量与 CPU 自适应开启线程池并行处理（编码转换属 I/O 密集，
      线程数＝min(文件数, 32, max(4, CPU×4))，封顶防内存与句柄暴涨）
    - --workers N 可显式指定线程数（1＝串行；0＝自动，默认）
    - 自动跳过二进制文件及常见二进制扩展名
    - 已是 UTF-8 的文件不重写（带 BOM 的 UTF-8 默认保留，可用 --strip-bom 去除）
    - 默认只打印实际转换与未识别的文件，无需转换的（已 UTF-8 / UTF-8 BOM）不逐条列出，仅计入汇总
    - --verbose 逐条列出带 BOM 的 UTF-8 文件（排查用）
    - 依次尝试识别编码: UTF-8 / UTF-8(BOM) / UTF-16(BOM) / GB18030 / Big5 / Shift-JIS / Latin-1
    - 默认只转换编码，不改动换行符；需要统一换行时显式指定 --eol lf 或 --eol crlf
      （CRLF→目标、孤立 CR→目标；文件内混用（混合换行）一律拉平）
"""

import argparse
import os
import re
import shutil
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# 并行参数：I/O 密集任务，线程数＝min(文件数, MAX_WORKERS, max(MIN_WORKERS, CPU×4))
MAX_WORKERS = 32
MIN_WORKERS = 4

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


def unify_eol(text: str, eol: str) -> tuple[str, str | None]:
    """统一换行符；返回 (文本, 变更说明)。变更说明为 None 表示无需改动。

    先把 CRLF 与孤立 CR 拉平为 LF，再按目标形态落位——保证混合换行（LF/CRLF/CR 混用）一律统一。
    """
    if eol == "lf":
        if "\r" not in text:
            return text, None
        fixed = text.replace("\r\n", "\n").replace("\r", "\n")
        return fixed, "CRLF/CR -> LF"
    if eol == "crlf":
        has_lone_lf = bool(re.search(r"(?<!\r)\n", text))
        has_lone_cr = bool(re.search(r"\r(?!\n)", text))
        if not has_lone_lf and not has_lone_cr:
            return text, None
        fixed = text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n")
        return fixed, "LF/CR -> CRLF"
    return text, None


def auto_worker_count(task_count: int) -> int:
    """按任务量与 CPU 自适应线程数：I/O 密集取 4×CPU，封顶 32、保底 4，且不超过任务数。"""
    cpu = os.cpu_count() or 4
    ideal = min(MAX_WORKERS, max(MIN_WORKERS, cpu * 4))
    return max(1, min(ideal, task_count))


def process_file_safe(path: Path, args: argparse.Namespace) -> tuple[Path, str, str]:
    """线程池入口：把单文件异常收敛为状态值，避免单点失败打断整批。"""
    try:
        status, detail = process_file(path, args)
    except PermissionError:
        # 被其他进程锁定（如浏览器缓存），计入汇总但不逐个打印
        return path, "locked", ""
    except (UnicodeDecodeError, UnicodeEncodeError, OSError) as e:
        return path, "unknown", f"处理失败: {e}"
    return path, status, detail


def process_file(path: Path, args: argparse.Namespace) -> tuple[str, str]:
    """处理单个文件，返回 (状态, 详情)。"""
    data = path.read_bytes()
    if looks_binary(data):
        return "binary", "疑似二进制内容"

    enc = detect_encoding(data)
    if enc is None:
        return "unknown", "无法识别编码"

    # 已是 UTF-8 且不改换行：无需二次解码，直接计入汇总
    if enc == "utf-8" and args.eol == "none":
        return "utf8", ""

    needs_rewrite = False
    details: list[str] = []

    if enc == "utf-8-sig":
        if args.strip_bom:
            text = data.decode("utf-8-sig")
            needs_rewrite = True
            details.append("UTF-8 BOM -> UTF-8")
        else:
            # BOM 保留语义：不做任何改写（换行统一也跳过，防静默剥 BOM）
            return "bom", "已是 UTF-8（带 BOM）"
    else:
        text = data.decode(enc)
        if enc != "utf-8":
            needs_rewrite = True
            details.append(f"{enc} -> UTF-8")

    if args.eol != "none":
        text, eol_detail = unify_eol(text, args.eol)
        if eol_detail:
            needs_rewrite = True
            details.append(eol_detail)

    if not needs_rewrite:
        return "utf8", ""

    if args.dry_run:
        return "converted", "、".join(details) + "（未写入）"
    if args.backup:
        shutil.copy2(path, path.with_name(path.name + ".bak"))
    path.write_bytes(text.encode("utf-8"))
    return "converted", "、".join(details)


def main() -> None:
    parser = argparse.ArgumentParser(description="批量将目录内文本文件转换为 UTF-8 编码")
    parser.add_argument("directory", nargs="?", default=".", help="目标目录，默认当前目录")
    parser.add_argument("--dry-run", action="store_true", help="仅检测，不实际写入")
    parser.add_argument("--backup", action="store_true", help="转换前生成 <文件名>.bak 备份")
    parser.add_argument("--ext", default="", help="仅处理指定扩展名，逗号分隔，如: .py,.txt")
    parser.add_argument("--strip-bom", action="store_true", help="将带 BOM 的 UTF-8 文件重写为无 BOM UTF-8")
    parser.add_argument("--eol", choices=["lf", "crlf", "none"], default="none",
                        help="换行符统一目标（可选）：lf / crlf / none（默认，不改动换行符）")
    parser.add_argument("--workers", type=int, default=0,
                        help="并行线程数（0＝按文件量与 CPU 自适应，1＝串行）")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="逐条列出带 BOM 的 UTF-8 文件（默认不列出，仅计入汇总）")
    args = parser.parse_args()
    if args.workers < 0:
        parser.error("--workers 必须 >= 0")

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
    targets: list[Path] = []
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
        targets.append(path)

    def render(path: Path, status: str, detail: str) -> None:
        counts[status] += 1
        if status == "converted":
            print(f"[已转换] {path}  ({detail})")
        elif status == "unknown":
            print(f"[未识别] {path}  ({detail})")
        elif status == "bom" and args.verbose:
            print(f"[UTF-8 BOM] {path}  (可用 --strip-bom 去除)")

    workers = args.workers if args.workers > 0 else auto_worker_count(len(targets))
    if args.verbose:
        print(f"[并行] 线程数 {workers} / 待处理文件 {len(targets)}")

    if workers <= 1:
        for path in targets:
            render(*process_file_safe(path, args))
    else:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            # map 保序：输出仍按路径排序，结果与串行执行一致
            for path, status, detail in pool.map(lambda p: process_file_safe(p, args), targets):
                render(path, status, detail)

    print("\n===== 汇总 =====")
    for key, label in STATUS_LABELS.items():
        print(f"{label}: {counts[key]}")


if __name__ == "__main__":
    main()
