import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import * as iconv from "iconv-lite";
import { detectEncoding, isUtf8 } from "./encoding";
import { repairEncodedBytes, migrateEncodingBytes, isReversibleMojibakeText, hasStrongCJK, RepairResult } from "./repair";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 诊断日志（输出面板 → “编码切换器”；同时落盘保障故障可读——输出面板
// 重启即丢，故障排查需要持久日志）
let log: vscode.OutputChannel;
let logFile: string | null = null;
const LOG_MAX_BYTES = 2 * 1024 * 1024; // 单文件 2MB，超过轮转为 .old

function appendLogDisk(msg: string): void {
  if (!logFile) {
    return;
  }
  try {
    // 轮转：当前日志过大时改名保留一代，重新开始，防止无限增长
    try {
      const st = fs.statSync(logFile);
      if (st.size > LOG_MAX_BYTES) {
        fs.renameSync(logFile, `${logFile}.old`);
      }
    } catch {
      // 文件不存在等，忽略
    }
    fs.appendFileSync(logFile, msg + "\n");
  } catch {
    // 磁盘日志失败不影响主流程
  }
}

function L(msg: string): void {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  try {
    log?.appendLine(line);
  } catch {
    // 忽略
  }
  appendLogDisk(line);
}

// 打开日志文件（落盘版，可跨会话排查故障）；文件尚未生成时退回输出面板
function openLogFile(): void {
  if (logFile && fs.existsSync(logFile)) {
    void vscode.commands.executeCommand(
      "vscode.open",
      vscode.Uri.file(logFile)
    );
  } else {
    log?.show();
  }
}

// 文本归一化：统一换行、去掉 BOM，便于与预期解码结果比对
function normalizeText(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
}

function findByUri(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === uri.toString()
  );
}

// 将字符串以指定编码写回文件（Node Buffer 不支持 gbk/gb2312，统一用 iconv-lite）
function writeFileWithEncoding(
  filePath: string,
  text: string,
  encoding: string
): boolean {
  try {
    const buf = iconv.encode(text, encoding);
    fs.writeFileSync(filePath, buf);
    return true;
  } catch {
    return false;
  }
}

// 按源编码读取磁盘字节为字符串（保证中文不丢，不依赖当前可能乱码的视图）
function decodeFileBytes(filePath: string, encoding: string): string | null {
  try {
    const buf = fs.readFileSync(filePath);
    let text = iconv.decode(buf, encoding);
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1); // 去 UTF-8 BOM
    }
    return text;
  } catch {
    return null;
  }
}

// ===== 前提：启用内核自带的“自动猜测编码” =====
//
// 内核读取文件的流程支持 files.autoGuessEncoding + files.candidateGuessEncodings。
// 候选编码由插件设置 encoding-guard.kernelGuessEncodings 驱动（不写死）。
// 注意：候选里不要放“自己编码的子集”（如 GBK 候选旁放 gb2312）——
// 内核按子集编码解码/回写会损坏超集扩展字符（AI 改写文件后乱码的常见根因）。

// UTF 系编码判定
function isUtfFamily(enc: string): boolean {
  return enc === "utf8" || enc === "utf-8";
}

// 插件设置：UTF-8 之外要自动识别/纠正的编码（iconv-lite 支持的编码名）
function getDetectionEncodings(): string[] {
  return vscode.workspace
    .getConfiguration("encoding-guard")
    .get<string[]>("detectionEncodings", ["gbk", "gb18030"])
    .filter((e) => !isUtfFamily(e));
}

// 插件设置：写入内核 files.candidateGuessEncodings 的候选编码
function getKernelGuessEncodings(): string[] {
  return vscode.workspace
    .getConfiguration("encoding-guard")
    .get<string[]>("kernelGuessEncodings", ["utf8", "gbk", "gb18030"]);
}

// 插件设置：是否把候选编码写入内核猜码设置（默认关闭，避免破坏内核原生猜测）
function isApplyKernelGuess(): boolean {
  return vscode.workspace
    .getConfiguration("encoding-guard")
    .get<boolean>("applyKernelGuess", false);
}

// 插件设置：检测到可逆编码损坏时自动修复文件字节（默认开启）
function isAutoRepairBytes(): boolean {
  return vscode.workspace
    .getConfiguration("encoding-guard")
    .get<boolean>("autoRepairBytes", true);
}

// 插件设置：修复前是否留 .bak 临时备份（成功后自动删除，默认开启）
function isRepairBackup(): boolean {
  return vscode.workspace
    .getConfiguration("encoding-guard")
    .get<boolean>("repairBackup", true);
}

// 插件设置：自动修复的文件大小上限（字节，默认 5MB，超过只告警）
function maxRepairBytes(): number {
  return vscode.workspace
    .getConfiguration("encoding-guard")
    .get<number>("maxRepairBytes", 5 * 1024 * 1024);
}

// 可选功能：把候选编码写入内核 files.candidateGuessEncodings（默认关闭）。
// 部分内核/版本对候选列表支持不佳（编码名不识别或猜码回落默认编码），
// 强制写入会破坏内核原生猜测能力，因此默认不干预；确有需要时在设置中开启。
// 开启后仅写入当前工作区设置，不污染全局配置。
async function ensureAutoGuessEncoding(): Promise<void> {
  try {
    const cfg = vscode.workspace.getConfiguration("files");
    const wanted = getKernelGuessEncodings();
    await cfg.update("autoGuessEncoding", true, vscode.ConfigurationTarget.Workspace);
    await cfg.update(
      "candidateGuessEncodings",
      wanted,
      vscode.ConfigurationTarget.Workspace
    );
    L(
      `已写入工作区内核猜码设置：autoGuessEncoding=true, candidates=[${wanted.join(", ")}]`
    );
  } catch (e) {
    L(`写入内核猜码设置失败（可能未打开工作区）: ${String(e)}`);
  }
}

// 一次性修复：历史版本曾无条件改写全局 files.candidateGuessEncodings /
// files.autoGuessEncoding，导致部分内核猜测失效（只回落默认编码）。
// 检测到全局候选列表恰好是插件写入过的特征值时自动恢复：
// 删除候选列表（回到内核默认全量猜测），并保持自动猜测开启。
async function restoreKernelGuessSettings(): Promise<void> {
  try {
    const cfg = vscode.workspace.getConfiguration("files");
    const globalCand = cfg.inspect<string[]>("candidateGuessEncodings")
      ?.globalValue;
    if (!Array.isArray(globalCand)) {
      return; // 未设置过，无需恢复
    }
    const legacy = ["utf8,gbk,gb18030", "utf8,gb2312,gb18030", "gbk,gb18030"];
    if (!legacy.includes(globalCand.join(","))) {
      return; // 用户自己的配置，不碰
    }
    await cfg.update(
      "candidateGuessEncodings",
      undefined,
      vscode.ConfigurationTarget.Global
    );
    await cfg.update(
      "autoGuessEncoding",
      true,
      vscode.ConfigurationTarget.Global
    );
    L("已恢复内核编码猜测设置（移除插件历史写入的全局候选列表，保持自动猜测开启）");
    void vscode.window
      .showInformationMessage(
        "编码切换器：已恢复 Files: Auto Guess Encoding 的内核猜测设置（移除了此前写入的候选编码限制）"
      )
      .then(() => {});
  } catch (e) {
    L(`恢复内核编码猜测设置失败: ${String(e)}`);
  }
}

// 检测结果 → VSCode 命令式重开使用的编码标签
// （utf-8 带不带 BOM 都用 utf8 打开；其余编码名原样透传）
function vscodeEncodingLabel(enc: string): string {
  return isUtfFamily(enc) ? "utf8" : enc;
}

// 内部重开标记：重开流程重建文档模型会再次触发 onDidOpenTextDocument，
// 用标记区分“内部重开”与“用户真实打开”，避免把内部事件当作用户打开而造成循环
const internalReopen = new Set<string>();

function markInternalReopen(uri: vscode.Uri): void {
  const key = uri.toString();
  internalReopen.add(key);
  setTimeout(() => internalReopen.delete(key), 5000);
}

// ===== 侦查内核的“指定编码重开”命令 =====
// 不同内核命令 ID 可能不同（Trae SOLO 已移除标准 ID），
// 激活时扫描一次并缓存；找不到时把内核所有编码相关命令写日志，便于排查
let reopenEncodingCmd: string | undefined;

function normCmdId(s: string): string {
  return s.toLowerCase().replace(/[.\-]/g, "");
}

async function detectReopenEncodingCmd(): Promise<void> {
  try {
    const all = await vscode.commands.getCommands(true);
    // 常见已知命令优先
    const known = [
      "workbench.action.reopenWithEncoding",
      "workbench.action.files.reopenWithEncoding",
      "editor.action.reopenWithEncoding",
    ];
    reopenEncodingCmd = known.find((c) => all.includes(c));
    if (reopenEncodingCmd) {
      L(`已找到指定编码重开命令：${reopenEncodingCmd}`);
      return;
    }
    // 模糊匹配变体：命令 ID 标准化后含 reopenwithencoding
    reopenEncodingCmd = all.find((c) =>
      normCmdId(c).includes("reopenwithencoding")
    );
    if (reopenEncodingCmd) {
      L(`已匹配到编码重开命令变体：${reopenEncodingCmd}`);
      return;
    }
    // 都没有：列出编码相关命令，供后续排查/扩展
    const encRelated = all.filter((c) => /encoding/i.test(c) && !c.startsWith("_"));
    L(
      `未找到编码重开命令；内核编码相关命令：${
        encRelated.length ? encRelated.join(", ") : "无"
      }`
    );
  } catch (e) {
    L(`扫描内核命令失败: ${String(e)}`);
  }
}

// 指定编码重开（统一入口）：优先内核命令；Trae 内核无 reopenWithEncoding
// 命令时（探测见 14:31:03 日志），退化为「临时改 files.encoding + 暂停
// autoGuessEncoding + revertFile 强制重解码」，完成后恢复原设置——否则
// 转换/修复后状态栏编码标签永远停在旧值，用户会以为转换没生效
async function reopenDocWithEncoding(
  uri: vscode.Uri,
  encLabel: string
): Promise<void> {
  if (reopenEncodingCmd) {
    markInternalReopen(uri);
    await vscode.commands.executeCommand(reopenEncodingCmd, uri, encLabel);
    return;
  }
  const filesCfg = vscode.workspace.getConfiguration("files", uri);
  const hasWs = !!vscode.workspace.workspaceFolders?.length;
  const scope = hasWs
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  const scopeKey = hasWs ? "workspaceValue" : "globalValue";
  const encInspect = filesCfg.inspect<string>("encoding");
  const guessInspect = filesCfg.inspect<boolean>("autoGuessEncoding");
  const oldEnc = encInspect ? encInspect[scopeKey] : undefined;
  const oldGuess = guessInspect ? guessInspect[scopeKey] : undefined;
  try {
    await filesCfg.update(
      "encoding",
      vscodeEncodingLabel(encLabel).toLowerCase(),
      scope
    );
    await filesCfg.update("autoGuessEncoding", false, scope);
    const doc = findByUri(uri) ?? (await vscode.workspace.openTextDocument(uri));
    await vscode.window.showTextDocument(doc, {
      preview: false,
      preserveFocus: true,
    });
    markInternalReopen(uri);
    await vscode.commands.executeCommand("workbench.action.files.revertFile");
    L(`已按 ${encLabel} 重载文件（files.encoding 临时切换方案）：${uri.fsPath}`);
  } finally {
    try {
      await filesCfg.update("encoding", oldEnc, scope);
      await filesCfg.update("autoGuessEncoding", oldGuess, scope);
    } catch {
      // 恢复失败不阻断（值仅短暂变更，下次用户改动设置会覆盖）
    }
  }
}

// ===== 兜底：正确编码只读视图 =====
// Trae SOLO 内核既猜不对编码、又没有“指定编码重开”命令时，
// 通过自定义 scheme 提供按正确编码解码的只读视图，保证中文可读；
// 原文件字节保持不变（绝不修改磁盘内容），编辑仍可在原编辑器进行。

const VIEW_SCHEME = "encoding-view";

// 正确编码可读写编辑器：以指定编码解码/编码读写原文件，
// 让“内核猜错编码”的文件拥有可编辑、可保存的正常编辑器（等效于按编码重开）。
// 编辑器文本 ? 原文件字节 的桥接规则：
//   读：原文件字节 --指定编码解码--> 正确文本 --UTF-8--> 编辑器
//   存：编辑器文本 --UTF-8 解码--> 正确文本 --指定编码编码--> 写回原文件
class EncodingViewProvider implements vscode.FileSystemProvider {
  private emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  // 已打开的视图：fsPath(小写) → 视图 uri，用于文件变化时刷新
  private opened = new Map<string, vscode.Uri>();

  // 视图 uri（encoding-view://<编码>/<encodeURIComponent(路径)>）→ 磁盘路径
  private toFsPath(uri: vscode.Uri): string {
    return decodeURIComponent(uri.path.replace(/^\/+/, ""));
  }

  private encOf(uri: vscode.Uri): string {
    return uri.authority === "utf8" ? "utf-8" : uri.authority;
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const s = fs.statSync(this.toFsPath(uri));
    return {
      type: vscode.FileType.File,
      ctime: s.ctimeMs,
      mtime: s.mtimeMs,
      size: s.size,
    };
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const fsPath = this.toFsPath(uri);
    const text = iconv.decode(fs.readFileSync(fsPath), this.encOf(uri));
    return new Uint8Array(Buffer.from(text, "utf-8"));
  }

  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    const fsPath = this.toFsPath(uri);
    const openEnc = this.encOf(uri);
    const text = Buffer.from(content).toString("utf-8");
    // 写回前检测文件当前实际编码，写回编码跟随实际编码而非打开时的固定编码；
    // 实际编码与打开时不一致（被外部改写）则阻止保存，防止覆盖外部修改
    let curEnc = openEnc;
    try {
      const detected = detectEncoding(
        fs.readFileSync(fsPath),
        getDetectionEncodings()
      );
      if (detected !== "unknown") {
        curEnc = detected;
      }
    } catch {
      // 文件可能已被删除，交给下方 writeFileSync 报错
    }
    // 编码变化判定：
    //   1. 跨族变化（GBK 视图遇磁盘已变 UTF-8，或反之）→ 必须阻止：
    //      视图文本是对磁盘字节的错误解读，写回即把好文件写坏；
    //   2. 非 UTF 族内部变化（gbk → big5 等）→ 阻止
    const encChanged =
      isUtfFamily(curEnc) !== isUtfFamily(openEnc) ||
      (!isUtfFamily(curEnc) && !isUtfFamily(openEnc) && curEnc !== openEnc);
    if (encChanged) {
      // 每阻止一次乱码保存，就警告一次，让用户知道有内容被拦下
      const msg =
        `已阻止一次乱码保存：文件实际编码已变为 ${curEnc}（打开时为 ${openEnc}），` +
        `本视图内容已不可信，继续写入会导致中文损坏。请关闭本视图后重新打开文件`;
      L(`已阻止乱码保存：${fsPath}（${openEnc} → ${curEnc}）`);
      void vscode.window
        .showWarningMessage(msg, "重新打开文件")
        .then((c) => {
          if (c === "重新打开文件") {
            // 按提示重新打开真实文件（触发重新检测纠正），编码视图由用户自行关闭
            void vscode.commands.executeCommand(
              "vscode.open",
              vscode.Uri.file(fsPath)
            );
          }
        });
      throw vscode.FileSystemError.NoPermissions(msg);
    }
    fs.writeFileSync(fsPath, iconv.encode(text, curEnc));
  }

  readDirectory(): [] {
    return [];
  }
  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
  delete(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
  rename(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async open(fsPath: string, encLabel: string): Promise<void> {
    const viewUri = vscode.Uri.parse(
      `${VIEW_SCHEME}://${encLabel}/${encodeURIComponent(fsPath)}`
    );
    this.opened.set(fsPath.toLowerCase(), viewUri);
    const doc = await vscode.workspace.openTextDocument(viewUri);
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false,
    });
    // 单视图：关闭原乱码文件的编辑器标签，只保留正确编码编辑器。
    // 优先用 tabGroups API 按标签直接关闭（不依赖激活状态）；
    // 内核裁剪该 API 时退回“激活后关当前编辑器”的老方法
    const isTargetTab = (t: vscode.Tab): boolean =>
      t.input instanceof vscode.TabInputText &&
      t.input.uri.scheme === "file" &&
      t.input.uri.fsPath === fsPath;
    try {
      const tabs = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .filter(isTargetTab);
      if (tabs.length) {
        await vscode.window.tabGroups.close(tabs, true);
      }
    } catch {
      for (const d of [...vscode.workspace.textDocuments]) {
        if (d.uri.scheme !== "file" || d.uri.fsPath !== fsPath) {
          continue;
        }
        try {
          await vscode.window.showTextDocument(d, { preview: false });
          await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        } catch {
          break;
        }
      }
    }
  }

  // 文件被外部修改时刷新对应视图
  refresh(fsPath: string): void {
    const viewUri = this.opened.get(fsPath.toLowerCase());
    if (viewUri) {
      this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri: viewUri }]);
    }
  }

  // 磁盘被外部改写后同步视图：磁盘编码与视图编码不一致（如 GBK 视图
  // 遇到磁盘已被回滚/切换为 UTF-8）时，旧视图显示的是乱码解读，继续
  // 编辑保存会写坏文件 → 自动关闭旧视图并按磁盘真实状态重开
  async syncWithDisk(fsPath: string): Promise<void> {
    const viewUri = this.opened.get(fsPath.toLowerCase());
    if (!viewUri || !this.isOpen(fsPath)) {
      return;
    }
    const viewEnc = viewUri.authority;
    let diskEnc: string;
    try {
      diskEnc = detectEncoding(
        fs.readFileSync(fsPath),
        getDetectionEncodings()
      );
    } catch {
      return; // 文件暂时不可读（删除/占用），不动视图
    }
    if (diskEnc === "unknown") {
      return;
    }
    const sameFamily =
      isUtfFamily(viewEnc) === isUtfFamily(diskEnc) &&
      (isUtfFamily(diskEnc) || viewEnc === diskEnc);
    if (sameFamily) {
      this.refresh(fsPath); // 编码未变，仅内容变化 → 常规刷新
      return;
    }
    L(`磁盘编码已变为 ${diskEnc}（视图为 ${viewEnc}），关闭过时编码视图：${fsPath}`);
    this.opened.delete(fsPath.toLowerCase());
    try {
      const tabs = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .filter(
          (t) =>
            t.input instanceof vscode.TabInputText &&
            (t.input as vscode.TabInputText).uri.toString() ===
              viewUri.toString()
        );
      if (tabs.length) {
        await vscode.window.tabGroups.close(tabs, true);
      }
    } catch {
      // 内核裁剪 tabGroups API 时关闭不了旧标签，仅记录（保存防线仍兜底）
    }
    if (isUtfFamily(diskEnc)) {
      // 磁盘已是正常 UTF 编码：直接打开真实文件（autoGuess 对合法 UTF-8 通常正确）
      void vscode.commands.executeCommand(
        "vscode.open",
        vscode.Uri.file(fsPath)
      );
    } else {
      await this.open(fsPath, vscodeEncodingLabel(diskEnc));
    }
  }

  // 该文件的编码编辑器当前是否处于打开状态
  isOpen(fsPath: string): boolean {
    const viewUri = this.opened.get(fsPath.toLowerCase());
    return !!viewUri && !!findByUri(viewUri);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

let encodingView: EncodingViewProvider | undefined;

// ===== 核心：指定编码重开，并用“实际显示内容”验证 =====
//
// 验证不依赖 doc.encoding 属性，而是轮询读取 doc.getText() 与
// “按正确编码解码出的文本”比对 —— 内容匹配即说明视图已正确。
//
// 重开优先级：
//   1. 内核命令 workbench.action.reopenWithEncoding（指定编码重开，确定性修复，
//      不依赖 autoGuess——GBK 字节恰好构成合法 UTF-8 时，重开多少次内核都会猜错）；
//   2. 命令不存在时（个别精简内核）退回“关闭→重开”，依赖 autoGuess 重新猜。
async function reopenDisplayedCorrectly(
  uri: vscode.Uri,
  expectedText: string,
  encLabel: string
): Promise<boolean> {
  // 有未保存修改时拒绝（避免丢失用户编辑）
  const d0 = findByUri(uri);
  if (d0 && d0.isDirty) {
    L(`放弃重开：${uri.fsPath} 有未保存修改`);
    return false;
  }

  const expect = normalizeText(expectedText);
  if (!expect) {
    L(`无需重开：${uri.fsPath} 内容为空`);
    return true;
  }

  // 轮询等待：重开是异步的，需等新模型就绪；内容与预期一致才算成功
  const displayedOK = async (maxPolls: number): Promise<boolean> => {
    for (let i = 0; i < maxPolls; i++) {
      await sleep(120);
      const d = findByUri(uri);
      if (!d || d.isDirty) {
        continue;
      }
      if (normalizeText(d.getText()) === expect) {
        return true;
      }
    }
    return false;
  };

  // 已经正确显示（打开时已被内核猜对）。
  // 多轮询几次：文档刚打开可能尚未加载完，立即判定会误判并触发无谓的重开刷新
  if (await displayedOK(6)) {
    L(`显示已正确：${uri.fsPath}`);
    return true;
  }

  // 复查：轮询窗口内用户可能已开始编辑（isDirty），立即放弃，
  // 避免误把“用户正在编辑”当成“显示不正确”而触发重开
  const dcNow = findByUri(uri);
  if (dcNow && dcNow.isDirty) {
    L(`放弃重开（用户正在编辑）：${uri.fsPath}`);
    return false;
  }

  // 首选：指定编码重开（内核命令；无命令的 Trae 内核退化为
  // files.encoding 临时切换 + revertFile，见 reopenDocWithEncoding）
  try {
    await reopenDocWithEncoding(uri, encLabel);
    if (await displayedOK(10)) {
      L(`指定编码重开(${encLabel})成功：${uri.fsPath}`);
      return true;
    }
    L(`指定编码重开(${encLabel})后显示仍不正确：${uri.fsPath}`);
  } catch (e) {
    L(`指定编码重开异常: ${String(e)}`);
  }

  // 只尝试一次：内核的猜测是确定性的（同样字节永远猜同样结果），
  // 多次关闭重开不会改变结果，失败即转只读视图，减少闪烁与等待
  for (let attempt = 1; attempt <= 1; attempt++) {
    // 关闭编辑器前复查：用户可能已开始编辑（isDirty），绝不能关掉正在编辑的标签
    const dc = findByUri(uri);
    if (dc && dc.isDirty) {
      L(`放弃重开（用户正在编辑）：${uri.fsPath}`);
      return false;
    }
    // 关闭该 uri 的所有编辑器，释放旧解码缓存的文档模型
    let closed = 0;
    for (const d of [...vscode.workspace.textDocuments]) {
      if (d.uri.toString() !== uri.toString()) {
        continue;
      }
      try {
        await vscode.window.showTextDocument(d, { preview: false });
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        closed++;
      } catch {
        // 忽略
      }
      await sleep(60);
    }
    // 等待旧文档模型真正销毁（textDocuments 中不再包含该 uri），
    // 未释放就重开会命中旧缓存，导致重开无效、反复刷新
    let released = false;
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      if (!findByUri(uri)) {
        released = true;
        break;
      }
    }
    L(
      `第${attempt}次：关闭${closed}个编辑器，模型${released ? "已释放" : "未及时释放（继续尝试）"}`
    );

    let reopened = false;
    try {
      markInternalReopen(uri); // 重开会重建文档模型，标记为内部事件
      const nd = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(nd, { preview: false });
      reopened = true;
    } catch (e) {
      L(`重开异常（第${attempt}次）: ${String(e)}`);
    }
    if (reopened && (await displayedOK(10))) {
      L(`第${attempt}次关闭重开后显示正确：${uri.fsPath}`);
      return true;
    }
    L(`第${attempt}次关闭重开后仍未正确显示：${uri.fsPath}`);
  }

  L(`全部重开策略失败：${uri.fsPath}`);
  // 兜底：非 UTF 系编码文件无法纠正显示时，打开按对应编码解码的可编辑视图
  // 保证内容可读可编辑（编辑器文本不落盘时原文件字节不变；Ctrl+S 按对应编码写回）。
  // 该文件的编码编辑器当前没开着才打开；已开着说明正在正确显示，无需重复
  if (!isUtfFamily(encLabel) && encodingView) {
    if (!encodingView.isOpen(uri.fsPath)) {
      // 打开兜底视图前按磁盘最新字节重检：重开/回滚期间磁盘可能已被改回
      // UTF 系（文件实际已正常），用旧判定开 GBK 视图只会显示乱码误导用户
      let diskEnc = encLabel;
      try {
        const re = detectEncoding(
          fs.readFileSync(uri.fsPath),
          getDetectionEncodings()
        );
        if (re !== "unknown") {
          diskEnc = re;
        }
      } catch {
        // 读取失败按原判定走
      }
      if (isUtfFamily(diskEnc)) {
        L(`兜底前重检：磁盘已是 ${diskEnc}，无需编码视图，直接按新编码重开：${uri.fsPath}`);
        try {
          markInternalReopen(uri);
          await vscode.commands.executeCommand(
            reopenEncodingCmd ?? "workbench.action.reopenWithEncoding",
            uri,
            vscodeEncodingLabel(diskEnc)
          );
        } catch (e) {
          L(`兜底重开失败: ${String(e)}`);
        }
        return true;
      }
      try {
        await encodingView.open(uri.fsPath, encLabel);
        void vscode.window.showInformationMessage(
          `内核不支持自动编码重开，已打开 ${encLabel.toUpperCase()} 编码编辑器（可编辑，Ctrl+S 按原编码保存回文件）`
        );
      } catch (e) {
        L(`打开编码视图失败: ${String(e)}`);
      }
    }
  }
  return false;
}

// 将当前文件从源编码转为目标编码并保存（按源编码正确解码，避免中文乱码）
async function convertTo(targetEnc: string, targetLabel: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("当前没有打开的编辑器");
    return;
  }
  const doc = editor.document;

  if (doc.isUntitled) {
    vscode.window.showWarningMessage("未保存的新文件无法转换，请先保存");
    return;
  }
  if (doc.uri.scheme !== "file") {
    vscode.window.showWarningMessage("当前不是本地文件，无法转换编码");
    return;
  }
  if (doc.isDirty) {
    vscode.window.showWarningMessage(
      "文件有未保存修改，请先保存（Ctrl+S）后再转换编码"
    );
    return;
  }

  const filePath = doc.uri.fsPath;

  // 1) 检测文件真实编码
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch {
    vscode.window.showErrorMessage(`无法读取文件：${filePath}`);
    return;
  }
  const srcEnc = detectEncoding(bytes, getDetectionEncodings());
  if (srcEnc === "unknown") {
    vscode.window.showWarningMessage(
      "无法识别当前文件编码（不在检测编码列表内），未做转换。" +
        "可在设置 encoding-guard.detectionEncodings 中添加候选编码"
    );
    return;
  }

  // 2) 按源编码正确解码磁盘字节（此处必有明确编码）
  const text =
    srcEnc === "utf8" || srcEnc === "utf-8"
      ? decodeFileBytes(filePath, "utf-8")
      : decodeFileBytes(filePath, srcEnc);
  if (text === null) {
    vscode.window.showErrorMessage(`读取源文件失败（编码：${srcEnc}）`);
    return;
  }

  // 3) 以目标编码写回（UTF-8 不写 BOM）。
  //    写盘前先落跨进程立即可见的处理权登记（临时目录文件）：其它平台/窗口
  //    实例的 watcher 可能在本实例的 globalState 意图同步到位前就收到文件
  //    变化事件，把这次切换误判为 AI 改写而回滚成旧编码——即"第一次转换
  //    没生效"的根源。claim 读取无同步延迟，回滚钩子见到即让路。
  forceClaim(filePath, targetEnc, "claimed");
  if (!writeFileWithEncoding(filePath, text, targetEnc)) {
    vscode.window.showErrorMessage(`切换为 ${targetLabel} 失败`);
    return;
  }

  // 转换成功后记录新指纹，避免自动检测重复干预；
  // 同步监督状态，防止 watcher 把用户主动转换误判为外部编码损坏；
  // 登记切换意图（共享），防止其它窗口实例把这次切换回滚（多窗口打架）
  const fp = diskFingerprint(doc.uri);
  autoDone.set(doc.uri.toString(), fp);
  watcherDone.set(doc.uri.toString(), fp);
  repairStates.delete(doc.uri.toString());
  setLastEnc(doc.uri.toString(), targetEnc);
  registerConvertIntent(doc.uri.toString(), fp, targetEnc);

  // 等待文件监听处理完外部写入，再关闭重开触发重新解码
  await sleep(400);

  // 4) 关闭重开并验证显示内容
  L(`转换完成：${filePath} ${srcEnc} → ${targetEnc}，开始重开验证`);
  let ok = false;
  try {
    ok = await reopenDisplayedCorrectly(doc.uri, text, targetEnc);
  } catch (e) {
    L(`重开过程异常: ${String(e)}`);
    ok = false;
  }
  if (!ok) {
    notifyWithOpenFile(
      "warn",
      `已转换为 ${targetLabel} 并保存到磁盘，但视图未能自动刷新为新编码。请手动关闭该文件后重新打开。可到输出面板「编码切换器」查看诊断日志。`,
      doc.uri
    );
    return;
  }

  // 5) 确保文档模型编码标签与磁盘一致：上面的重开验证可能走"显示已正确"
  //    的早退路径（内容匹配但 doc.encoding 仍是旧值，如内核 autoGuess 猜对
  //    了内容），此时底部状态栏的编码显示会停留在旧编码 → 补一次指定编码
  //    重开，强制文档模型（含状态栏标签）同步为目标编码
  const docNow = findByUri(doc.uri);
  if (docNow && !docNow.isDirty) {
    const encAttr = docNow.encoding.toLowerCase();
    const attrUtf = isUtfFamily(encAttr);
    const tgtUtf = isUtfFamily(targetEnc);
    const labelMatches =
      attrUtf === tgtUtf && (tgtUtf || encAttr === targetEnc.toLowerCase());
    if (!labelMatches) {
      try {
        await reopenDocWithEncoding(doc.uri, targetLabel);
        L(
          `文档编码标签已刷新：${filePath} → ${targetLabel}（状态栏与磁盘编码同步）`
        );
      } catch (e) {
        L(
          `编码标签刷新失败（文件已按 ${targetLabel} 保存成功，重载窗口后恢复）：${String(e)}`
        );
      }
    }
  }

  // 6) 磁盘终验：确认磁盘字节确实是目标编码。若在重开/标签刷新窗口期
  //    被其它实例回滚成旧编码，立即重写覆盖——保证第一次转换就落盘生效，
  //    而不是弹了成功提示、文件却还是旧编码，得手动转第二次
  try {
    const finalBytes = fs.readFileSync(filePath);
    const finalEnc = detectEncoding(finalBytes, getDetectionEncodings());
    const finUtf = isUtfFamily(finalEnc);
    const tgtUtf = isUtfFamily(targetEnc);
    const finalOk =
      finUtf === tgtUtf && (tgtUtf || finalEnc === targetEnc);
    if (!finalOk) {
      L(
        `终验发现文件被回滚为 ${finalEnc}（应为 ${targetEnc}），重新写入覆盖：${filePath}`
      );
      forceClaim(filePath, targetEnc, "claimed");
      writeFileWithEncoding(filePath, text, targetEnc);
    }
    finishClaim(filePath, targetEnc);
    // 指纹按（可能重写后的）最新磁盘状态刷新，避免自动检测重复干预
    const fpFinal = diskFingerprint(doc.uri);
    autoDone.set(doc.uri.toString(), fpFinal);
    watcherDone.set(doc.uri.toString(), fpFinal);
    setLastEnc(doc.uri.toString(), targetEnc);
  } catch {
    // 读取失败不阻断收尾（前面写盘已成功过）
  }
  // 跨平台登记当前编码：其它平台实例（可能历史相反）回滚前会查注册表，
  // 与磁盘一致即接受现状——防止手动转换后与其它平台连续抢注转码
  writeEncReg(filePath, targetEnc);

  // 7) 刷新按键显示（文件编码已改变）
  await updateContext();
  notifyWithOpenFile("info", `已切换为 ${targetLabel} 并保存`, doc.uri);
}

// 下拉选择目标编码后转换保存（编码列表由设置 encoding-guard.detectionEncodings 驱动）
interface EncodingPickItem extends vscode.QuickPickItem {
  enc: string;
}

async function pickAndConvert(): Promise<void> {
  const items: EncodingPickItem[] = [
    { label: "UTF-8", description: "无 BOM", enc: "utf8" },
    ...getDetectionEncodings().map((enc) => ({
      label: enc.toUpperCase(),
      description: "按该编码保存",
      enc,
    })),
  ];
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "选择目标编码并保存当前文件",
  });
  if (!pick) {
    return;
  }
  await convertTo(pick.enc, pick.label);
}

// 根据当前活动编辑器文件编码，更新上下文变量控制按钮显示（编码可识别才显示）
async function updateContext(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  let isActive = false;
  if (
    editor &&
    !editor.document.isUntitled &&
    editor.document.uri.scheme === "file"
  ) {
    try {
      const bytes = fs.readFileSync(editor.document.uri.fsPath);
      isActive =
        detectEncoding(bytes, getDetectionEncodings()) !== "unknown";
    } catch {
      // 忽略
    }
  }
  await vscode.commands.executeCommand(
    "setContext",
    "encoding-guard:isActive",
    isActive
  );
}

// ===== 自动检测：打开 GB2312/GBK 文件时自动按正确编码重开，避免乱码 =====
// 外部改写（AI 直接写文件）时：磁盘字节与编辑器显示可能不一致
// （内核按旧编码标签解码新字节），同样走重开流程纠正。

// 已处理指纹表：uri → “磁盘大小:mtimeMs”。
// 重开后会再次触发 onDidOpenTextDocument（同一个文件、同样字节），
// 指纹相同则跳过 —— 防止反复重开的根本手段。
const autoDone = new Map<string, string>();

function diskFingerprint(uri: vscode.Uri): string {
  try {
    const st = fs.statSync(uri.fsPath);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return String(Date.now());
  }
}

// 串行队列：多个文件的自动重开逐个执行，避免互相干扰（激活编辑器抢焦点）
let autoChain: Promise<void> = Promise.resolve();
function enqueueAuto(task: () => Promise<void>): void {
  autoChain = autoChain.then(task).catch(() => {});
}

// verifyAll=false：普通打开，只处理 GB 编码文件（UTF-8 内核基本能猜对）；
// verifyAll=true ：外部改写（AI 直接写文件），任何可识别编码都校验
//                  “磁盘按正确编码解码的内容 vs 编辑器显示”，不一致则重开纠正

// 重开失败冷却表：uri → 冷却截止时间。文件被程序持续追加（如运行日志）时，
// 全文比对必然与追加竞态而失败，冷却期内不再重试，避免反复关闭重开打断用户
const reopenCooldown = new Map<string, number>();
const REOPEN_COOLDOWN_MS = 10 * 60 * 1000;

function scheduleAutoReopen(uri: vscode.Uri, verifyAll = false): void {
  enqueueAuto(async () => {
    // 日志类文件被程序持续追加，“全文比对”校验必然与追加竞态失败，
    // 因此跳过外部改写校验（verifyAll=true）；
    // 打开时的显示纠正（verifyAll=false）保留，GBK 日志猜错仍需纠正
    if (verifyAll && fileExt(uri.fsPath) === "log") {
      return;
    }
    await sleep(250); // 等待打开事件尘埃落定
    const key = uri.toString();
    const fp = diskFingerprint(uri);
    if (autoDone.get(key) === fp) {
      return; // 已处理过且文件未变化
    }
    const until = reopenCooldown.get(key);
    if (until && Date.now() < until) {
      return; // 冷却期内不重试
    }
    const d = findByUri(uri);
    if (!d || d.isDirty || d.uri.scheme !== "file") {
      return;
    }
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(uri.fsPath);
    } catch {
      return;
    }
    const enc = detectEncoding(bytes, getDetectionEncodings());
    if (enc === "unknown") {
      return;
    }
    // 普通打开：只处理非 UTF 系文件（UTF-8 内核基本能猜对）
    if (!verifyAll && isUtfFamily(enc)) {
      return;
    }
    const decodeName = isUtfFamily(enc) ? "utf-8" : enc;
    let text = decodeFileBytes(uri.fsPath, decodeName);
    if (text === null) {
      L(`自动检测解码失败：${uri.fsPath}`);
      return;
    }
    // 编码歧义保护：编辑器当前显示与“按检测编码解码”的内容都无损坏（无 U+FFFD）
    // 但不同 —— 说明文件字节存在多种自洽解码（如 GBK 字节恰好构成合法 UTF-8），
    // 无法判定哪个正确，保守不重开，避免打断正常编辑/正常显示的文件
    const shown = normalizeText(d.getText());
    const expect = normalizeText(text);
    if (
      shown &&
      expect &&
      !shown.includes("\ufffd") &&
      !expect.includes("\ufffd") &&
      shown !== expect
    ) {
      autoDone.set(key, fp);
      L(`显示内容无损坏但与磁盘解码不一致（编码歧义），保守不重开：${uri.fsPath}`);
      return;
    }
    // 外部改写校验的二次确认：保存写入中、格式化瞬间等瞬态竞态会让
    // “磁盘 vs 显示”暂时不一致，等待后重新比对，仍不一致才重开，
    // 避免误重开正常编辑/正常保存的文件
    if (verifyAll) {
      await sleep(400);
      const d2 = findByUri(uri);
      if (!d2 || d2.isDirty) {
        L(`放弃校验（文件正在被编辑）：${uri.fsPath}`);
        return;
      }
      const fp2 = diskFingerprint(uri);
      if (fp2 !== fp) {
        autoDone.set(key, fp2); // 文件又变了，交由后续事件重新处理
        return;
      }
      const rechecked = decodeFileBytes(uri.fsPath, decodeName);
      if (rechecked === null) {
        return;
      }
      const shown2 = normalizeText(d2.getText());
      const expect2 = normalizeText(rechecked);
      if (shown2 === expect2) {
        L(`二次确认显示与磁盘一致，无需重开：${uri.fsPath}`);
        return; // 此前为瞬态竞态误报
      }
      if (
        shown2 &&
        expect2 &&
        !shown2.includes("\ufffd") &&
        !expect2.includes("\ufffd")
      ) {
        autoDone.set(key, fp2);
        L(`二次确认编码歧义（两种解码均无损坏），保守不重开：${uri.fsPath}`);
        return;
      }
      text = rechecked; // 以二次确认时的最新内容为准
    }
    // 先登记（无论成败），防止事件风暴期间反复重试
    autoDone.set(key, fp);
    L(`检测到 ${enc} 编码文件，校验显示并尝试自动重开：${uri.fsPath}`);
    const ok = await reopenDisplayedCorrectly(uri, text, vscodeEncodingLabel(enc));
    if (ok) {
      await updateContext();
    } else {
      reopenCooldown.set(key, Date.now() + REOPEN_COOLDOWN_MS);
      L(`自动重开失败（保留手动按钮可用，10分钟内不再自动重试）：${uri.fsPath}`);
    }
  });
}

// ===== 外部写入监督：AI 可不经编辑器直接改写文件（此时无任何文档事件） =====
// 用 FileSystemWatcher 监听磁盘变化，对监督范围内的文本文件做编码体检：
// 编码探测失败、或解码出替换字符，即疑似被错误编码写坏，及时告警提醒回退。
// 显示纠正仍由打开事件兜底，这里负责“完全不可见”的场景。

// 常见二进制扩展名：不在检测范围（探测为 unknown 也不告警）
const BINARY_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "pdf", "zip", "rar",
  "7z", "gz", "tar", "exe", "dll", "so", "dylib", "lib", "obj", "o", "a",
  "bin", "iso", "class", "jar", "mp3", "mp4", "avi", "mov", "wav", "wmv",
  "woff", "woff2", "ttf", "eot", "otf", "db", "sqlite", "doc", "docx",
  "xls", "xlsx", "ppt", "pptx", "vsix", "vsixmanifest",
]);

// 监督的文本扩展名：只有这些文件探测失败才告警（降低二进制误报）
const TEXT_EXTS = new Set([
  "txt", "md", "json", "xml", "html", "htm", "css", "scss", "less", "yml",
  "yaml", "ini", "cfg", "conf", "log", "csv", "sql", "js", "ts", "jsx",
  "tsx", "vue", "py", "java", "kt", "go", "rs", "php", "rb", "sh", "bat",
  "cmd", "ps1", "c", "h", "cpp", "hpp", "cc", "hh", "cs", "m", "mm", "asm",
  "s", "ld", "sct", "uvprojx", "uvproj", "uvoptx", "hex", "s19",
]);

// watcher 检测记录：uri → “磁盘大小:mtimeMs”，同一文件同一状态只检查一次
const watcherDone = new Map<string, string>();

// 上次编码记录：uri → 编码标签（编码迁移仅记日志，不弹窗打扰）
// 多开窗口时每个窗口是独立扩展宿主进程，内存 Map 互不可见：
// A 窗口刚切换/修复的编码会被 B 窗口的陈旧记录当作"外部改写"回滚，
// 两个实例互相撤销形成编码打架。因此以 context.globalState（跨窗口
// 共享）为准，内存仅作加速缓存，读取时取时间戳更新的一方。
interface EncRecord {
  enc: string;
  time: number;
}
const LAST_ENC_STORE_KEY = "lastEncMap";
const lastEnc = new Map<string, string>(); // 内存缓存层
const lastEncTime = new Map<string, number>(); // 内存记录对应的写入时间
let sharedState: vscode.Memento | undefined;

function initSharedState(memento: vscode.Memento): void {
  sharedState = memento;
}

function getLastEnc(key: string): string | undefined {
  const memEnc = lastEnc.get(key);
  const memTime = lastEncTime.get(key) ?? 0;
  const store = sharedState?.get<Record<string, EncRecord>>(LAST_ENC_STORE_KEY) ?? {};
  const rec = store[key];
  if (rec && rec.time > memTime) {
    lastEnc.set(key, rec.enc); // 顺势刷新内存缓存
    lastEncTime.set(key, rec.time);
    return rec.enc;
  }
  return memEnc;
}

function setLastEnc(key: string, enc: string): void {
  const time = Date.now();
  lastEnc.set(key, enc);
  lastEncTime.set(key, time);
  const store = sharedState?.get<Record<string, EncRecord>>(LAST_ENC_STORE_KEY) ?? {};
  store[key] = { enc, time };
  void sharedState?.update(LAST_ENC_STORE_KEY, store);
}

function deleteLastEnc(key: string): void {
  lastEnc.delete(key);
  lastEncTime.delete(key);
  const store = sharedState?.get<Record<string, EncRecord>>(LAST_ENC_STORE_KEY) ?? {};
  if (key in store) {
    delete store[key];
    void sharedState?.update(LAST_ENC_STORE_KEY, store);
  }
}

// 主动切换编码的意图登记：切换成功后记录"新编码 + 磁盘指纹"。
// 其它窗口的 watcher 看到指纹完全一致的外部变化时，确认这是某窗口
// 的主动切换（而非 AI 改写），接受新编码，不做迁移回滚。
interface ConvertIntent {
  fp: string;
  enc: string;
  time: number;
}
const INTENT_STORE_KEY = "convertIntents";
const INTENT_TTL_MS = 5 * 60 * 1000;

function registerConvertIntent(key: string, fp: string, enc: string): void {
  const store = sharedState?.get<Record<string, ConvertIntent>>(INTENT_STORE_KEY) ?? {};
  // 顺手清理过期登记，防止无限膨胀
  const now = Date.now();
  for (const k of Object.keys(store)) {
    if (now - store[k].time > INTENT_TTL_MS) {
      delete store[k];
    }
  }
  store[key] = { fp, enc, time: now };
  void sharedState?.update(INTENT_STORE_KEY, store);
}

function matchConvertIntent(key: string, fp: string, enc: string): boolean {
  const store = sharedState?.get<Record<string, ConvertIntent>>(INTENT_STORE_KEY) ?? {};
  const it = store[key];
  if (!it || Date.now() - it.time > INTENT_TTL_MS) {
    return false;
  }
  if (it.fp !== fp || it.enc !== enc) {
    return false;
  }
  delete store[key]; // 一次性消费
  void sharedState?.update(INTENT_STORE_KEY, store);
  return true;
}

// 多实例打架熔断：10 秒内同一文件被向不同目标编码回滚（来回翻转），
// 判定为多个窗口在争用，暂停自动回滚并告警一次。纯内存实现，
// 不依赖跨窗口通信，是 globalState 同步延迟时的最后防线。
const migrateHistory = new Map<string, { time: number; target: string }[]>();
const raceWarned = new Set<string>();

function noteMigrateAndCheckRace(uri: vscode.Uri, name: string, target: string): boolean {
  const key = uri.toString();
  const now = Date.now();
  const list = (migrateHistory.get(key) ?? []).filter((r) => now - r.time < 15000);
  const conflict = list.some((r) => now - r.time < 10000 && r.target !== target);
  list.push({ time: now, target });
  migrateHistory.set(key, list);
  if (!conflict) {
    return true;
  }
  if (!raceWarned.has(key)) {
    raceWarned.add(key);
    L(`检测到多个编辑器窗口在争用文件编码（来回切换），暂停自动回滚：${name}`);
    notifyWithOpenFile(
      "warn",
      `检测到多个编辑器窗口在同时管理 ${name} 的编码（来回切换）。` +
        `已暂停自动回滚，请只在其中一个窗口操作该文件的编码切换`,
      uri
    );
  }
  return false;
}

function fileExt(p: string): string {
  const i = p.lastIndexOf(".");
  return i > 0 ? p.slice(i + 1).toLowerCase() : "";
}

// 只读头部探测，避免大文件全量读取
function headBytes(p: string, max: number): Buffer | null {
  try {
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(max);
      const n = fs.readSync(fd, buf, 0, max, 0);
      return buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// 头部截断容错探测：固定长度头部可能切在多字节字符中间
// （如双字节编码首字节落单、UTF-8 序列截断），依次去掉末尾 1~3 字节
// 再判定，避免把完整文件稳定误判为 unknown
function detectHeadTolerant(
  head: Buffer,
  candidates: string[]
): ReturnType<typeof detectEncoding> {
  let enc = detectEncoding(head, candidates);
  for (const trim of [1, 2, 3]) {
    if (enc !== "unknown" || head.length <= trim) {
      break;
    }
    enc = detectEncoding(head.subarray(0, head.length - trim), candidates);
  }
  return enc;
}

// 文件告警统一弹窗：点击「打开文件」直达目标文件，「打开日志」查看诊断
function warnWithOpenFile(msg: string, uri: vscode.Uri): void {
  void vscode.window
    .showWarningMessage(msg, "打开文件", "打开日志")
    .then((choice) => {
      if (choice === "打开文件") {
        void vscode.commands.executeCommand("vscode.open", uri);
      } else if (choice === "打开日志") {
        openLogFile();
      }
    });
}

// 文件提示/告警统一弹窗（信息级或警告级）：
// 凡是涉及具体文件的弹窗都带「打开文件」按钮，一键跳到目标文件
function notifyWithOpenFile(
  kind: "info" | "warn",
  msg: string,
  uri: vscode.Uri
): void {
  const show =
    kind === "info"
      ? vscode.window.showInformationMessage.bind(vscode.window)
      : vscode.window.showWarningMessage.bind(vscode.window);
  void show(msg, "打开文件", "打开日志").then((choice) => {
    if (choice === "打开文件") {
      void vscode.commands.executeCommand("vscode.open", uri);
    } else if (choice === "打开日志") {
      openLogFile();
    }
  });
}

function warnCorrupted(uri: vscode.Uri, hint?: string): void {
  const name = uri.fsPath.split(/[\\/]/).pop() ?? uri.fsPath;
  L(`疑似编码损坏：${uri.fsPath}`);
  warnWithOpenFile(
    hint ??
      `${name} 疑似被以错误编码写入，中文内容可能已损坏（如需恢复请用版本管理回退）`,
    uri
  );
}

// 解码并要求零替换字符（全文一致性校验用）
function decodeWith(encoding: string, bytes: Buffer): string | null {
  try {
    const text = iconv.decode(bytes, encoding);
    return text.includes("\ufffd") ? null : text;
  } catch {
    return null;
  }
}

// ===== 字节级自动修复：静默窗口 + 备份 + 原子替换 + 回写对抗 =====
//
// 并发约束（AI 可能在持续增删）：
// 1. 绝不与 AI 同时写：只有文件静默（指纹 2 秒不变）才动手，避免交错损坏
// 2. 动手瞬间重读校验：磁盘字节与检测时不一致（AI 刚又写了）立即放弃重新排队
// 3. 原子替换：写临时文件后 rename 覆盖（同卷 rename 原子，AI 不会读到半截文件）
// 4. 回写对抗：AI 用它内存里的旧快照把乱码再写回时（指纹=修复前乱码）自动再修，
//    上限 3 次，超限告警提示让 AI 重新读取文件 —— 文件系统层无法阻止 AI 写旧内容，
//    这是无锁可用的现实约束下能做到的最强保护

// 修复状态表：uri → 修复指纹与对抗计数
interface RepairState {
  badFp: string; // 修复前（乱码）指纹
  goodFp: string; // 修复后（正确）指纹
  count: number; // 已修复次数（回写对抗用）
}
const repairStates = new Map<string, RepairState>();

// 迁移回滚反复对抗计数：同一文件短时间内被多次回滚（IDE 自动保存用错误
// 编码标签反复写回 / 多实例互搏）时熔断——继续重写只会无限打架，改为
// 纠正标签页编码（根治自动保存的写入编码）并告警
interface MigrateState {
  count: number;
  time: number;
}
const migrateStates = new Map<string, MigrateState>();
const MIGRATE_STRIKES = 3;
const MIGRATE_WINDOW_MS = 3 * 60 * 1000;

// 修复静默放弃计数：文件持续变化/编辑器未保存修改导致修复反复放弃时，
// 不能一直只记日志——累计到阈值弹窗告知用户真正原因
const repairAbandons = new Map<string, { count: number; time: number }>();

function noteRepairAbandon(uri: vscode.Uri, advice: string): void {
  const key = uri.toString();
  const now = Date.now();
  const st = repairAbandons.get(key);
  if (!st || now - st.time > MIGRATE_WINDOW_MS) {
    repairAbandons.set(key, { count: 1, time: now });
    return;
  }
  st.count++;
  st.time = now;
  if (st.count === MIGRATE_STRIKES) {
    repairAbandons.delete(key);
    warnWithOpenFile(
      `编码守护连续 ${MIGRATE_STRIKES} 次放弃修复：${advice}`,
      uri
    );
  }
}

// 纠正已打开标签页的编码标签：文件实际编码与标签页编码不同族时（如文件
// 已转回 UTF-8、标签页还是 GB2312），IDE 自动保存会按旧标签反复把编码写
// 坏——修复字节治标，纠正标签页才治本。按目标编码强制重开（内部事件，
// 不触发外部改写监督）
async function fixOpenTabEncoding(uri: vscode.Uri, targetEnc: string): Promise<void> {
  const doc = findByUri(uri);
  if (!doc || doc.isDirty) {
    return;
  }
  const encAttr = doc.encoding.toLowerCase();
  const attrUtf = isUtfFamily(encAttr);
  const tgtUtf = isUtfFamily(targetEnc);
  const sameFamily =
    attrUtf === tgtUtf && (tgtUtf || encAttr === targetEnc.toLowerCase());
  if (sameFamily) {
    return; // 标签页编码与实际一致，无需纠正
  }
  try {
    await reopenDocWithEncoding(uri, vscodeEncodingLabel(targetEnc));
    L(`已按 ${targetEnc} 纠正标签页编码（防止自动保存继续写坏）：${uri.fsPath}`);
  } catch (e) {
    L(`纠正标签页编码失败（文件字节已修复，建议手动重开该文件）: ${String(e)}`);
  }
}


// 修复互斥：同一文件的修复不并发（静默窗口期间 watcher 可能再触发）
const repairing = new Set<string>();

// 执行修复（选主版）：跨进程抢修复租约，同一文件同一时刻只有一个实例动手
async function executeRepair(
  uri: vscode.Uri,
  detectedBytes: Buffer,
  result: RepairResult
): Promise<boolean> {
  const lease = acquireRepairLease(uri.fsPath, result.encoding);
  if (lease) {
    L(
      `修复租约已被 ${lease.platform} 实例持有（→ ${lease.enc}），本实例让路（选主落败）：${uri.fsPath}`
    );
    return false; // 执行者完成后磁盘即恢复，无需重试
  }
  try {
    return await executeRepairInner(uri, detectedBytes, result);
  } finally {
    releaseRepairLease(uri.fsPath);
  }
}

// 执行修复主体：前置校验 → 备份 → 原子写 → 状态登记 → 通知
// 返回 false 表示被并发/静默校验拦下（交由后续 watcher 事件重试）
async function executeRepairInner(
  uri: vscode.Uri,
  detectedBytes: Buffer,
  result: RepairResult
): Promise<boolean> {
  const key = uri.toString();
  const name = uri.fsPath.split(/[\\/]/).pop() ?? uri.fsPath;
  const ext = fileExt(uri.fsPath);
  const quiet = ext === "log"; // 日志文件通知降级：只记日志不弹窗

  // 静默窗口：指纹 2 秒不变才动手，保证 AI 此刻没有在写
  const fp1 = diskFingerprint(uri);
  await sleep(2000);
  const fp2 = diskFingerprint(uri);
  if (fp1 !== fp2) {
    L(`修复放弃（文件仍在变化，等待下次静默）：${uri.fsPath}`);
    watcherDone.delete(key); // 清除拦截记录，重排队的检查才能继续
    scheduleWatchCheck(uri); // 重新进入防抖队列
    noteRepairAbandon(
      uri,
      `${name} 反复被外部程序写入（文件持续变化无法修复）。` +
        `常见原因：IDE 用错误编码打开该文件且开启了自动保存，每次保存都把编码写坏。` +
        `请关闭并按正确编码重新打开该文件，或暂停自动保存后再试`
    );
    return false;
  }
  // 动手前最后确认：磁盘字节必须与检测时一致（AI 刚又写了就放弃）
  let current: Buffer;
  try {
    current = fs.readFileSync(uri.fsPath);
  } catch {
    return false;
  }
  if (!current.equals(detectedBytes)) {
    L(`修复放弃（磁盘内容已变化，交由下次事件重新检测）：${uri.fsPath}`);
    scheduleWatchCheck(uri);
    return false;
  }
  // 用户正在编辑器里改这个文件时不动手（防止保存时覆盖修复结果）
  const doc = findByUri(uri);
  if (doc && doc.isDirty) {
    L(`修复放弃（编辑器有未保存修改）：${uri.fsPath}`);
    noteRepairAbandon(
      uri,
      `${name} 的编辑器有未保存修改，无法自动修复。` +
        `请先保存或关闭该文件，插件会在下次外部写入时重新修复`
    );
    return false;
  }

  // 备份 + 原子替换
  const backupPath = uri.fsPath + ".bak";
  const tmpPath = uri.fsPath + ".encoding-guard.tmp";
  try {
    if (isRepairBackup()) {
      fs.writeFileSync(backupPath, detectedBytes);
    }
    fs.writeFileSync(tmpPath, result.bytes);
    fs.renameSync(tmpPath, uri.fsPath);
  } catch (e) {
    L(`修复写盘失败: ${String(e)}`);
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // 忽略
    }
    try {
      fs.unlinkSync(backupPath);
    } catch {
      // 忽略
    }
    warnCorrupted(uri);
    return true;
  }
  // 修复成功：删除备份，登记状态
  try {
    fs.unlinkSync(backupPath);
  } catch {
    // 忽略
  }
  const goodFp = diskFingerprint(uri);
  const prev = repairStates.get(key);
  repairStates.set(key, {
    badFp: fp2,
    goodFp,
    count: (prev?.count ?? 0) + 1,
  });
  setLastEnc(key, result.encoding);
  writeEncReg(uri.fsPath, result.encoding); // 跨平台登记当前编码（方向仲裁依据）
  watcherDone.set(key, goodFp);
  encodingView?.refresh(uri.fsPath);
  const kindLabel =
    result.kind === "mojibake"
      ? "双重转码"
      : result.kind === "mixed"
        ? "混合编码"
        : "编码迁移回滚";
  L(
    `已自动修复：${uri.fsPath}（${kindLabel} → ${result.encoding}，内容与行数未变）`
  );
  const msg =
    result.kind === "migrate"
      ? `${name} 的文件编码被外部程序（可能是 AI）整体改写，已自动转回 ` +
        `${result.encoding.toUpperCase()}，内容与行数未变`
      : `${name} 的编码已被外部程序（可能是 AI）写坏，已自动修复还原为 ` +
        `${result.encoding.toUpperCase()}，内容与行数未变（${kindLabel}修复）`;
  if (quiet) {
    L(msg);
  } else {
    notifyWithOpenFile("info", msg, uri);
  }
  return true;
}

// 检测并修复：全文分析 → 可逆修复；不可逆/不安全 → 告警
async function tryRepairCorrupted(uri: vscode.Uri, full: Buffer): Promise<void> {
  const key = uri.toString();
  if (repairing.has(key)) {
    // 同一文件修复进行中，不并发；重排队等待下一次检查
    scheduleWatchCheck(uri);
    return;
  }
  const ext = fileExt(uri.fsPath);
  if (!isAutoRepairBytes()) {
    const name = uri.fsPath.split(/[\\/]/).pop() ?? uri.fsPath;
    L(`疑似编码损坏（自动修复已关闭）：${uri.fsPath}`);
    if (ext !== "log") {
      warnWithOpenFile(
        `${name} 疑似被以错误编码写入。可在设置开启 encoding-guard.autoRepairBytes 自动修复，或用版本管理回退`,
        uri
      );
    }
    return;
  }
  repairing.add(key);
  try {
    const result = repairEncodedBytes(full, getDetectionEncodings());
    if (!result) {
      // 不可逆损坏或无法安全切分，只能告警（日志文件降级为只记日志）
      L(`无法安全修复（不可逆损坏或行内混合），放弃自动修复：${uri.fsPath}`);
      if (ext !== "log") {
        warnCorrupted(uri);
      }
      return;
    }
    await executeRepair(uri, full, result);
  } finally {
    repairing.delete(key);
  }
}

// 编码迁移回滚执行：内容无损但编码被整体改写，转回 watcher 记录的上次编码
async function tryRepairMigrated(
  uri: vscode.Uri,
  full: Buffer,
  converted: Buffer,
  targetEnc: string
): Promise<void> {
  const key = uri.toString();
  if (repairing.has(key)) {
    scheduleWatchCheck(uri); // 修复进行中，重排队
    return;
  }
  // 多窗口防打架：短时间内被向相反方向回滚 → 多实例争用，熔断告警
  const name0 = uri.fsPath.split(/[\\/]/).pop() ?? uri.fsPath;
  if (!noteMigrateAndCheckRace(uri, name0, targetEnc)) {
    return;
  }
  // 新文件编码归一登记有效期内（本文件刚被某平台实例归一）：接受现状不回滚，
  // 防止其它平台实例把归一结果（如按其 files.encoding 转成的编码）再转回去
  const claim = getFreshClaim(uri.fsPath);
  if (claim) {
    L(
      `文件近期有编码归一登记（${claim.platform} → ${claim.enc}），接受现状不做迁移回滚：${uri.fsPath}`
    );
    return;
  }
  // 反复对抗熔断：短时间内已被多次回滚又被写坏 → 大概率是 IDE 自动保存
  // 按错误编码标签反复写盘。继续重写只会无限打架（外部看到"插件在乱改
  // 编码"）——改为纠正标签页编码根治写入源头，并明确告警
  const nowMs = Date.now();
  const ms = migrateStates.get(key);
  if (ms && nowMs - ms.time < MIGRATE_WINDOW_MS) {
    ms.count++;
    ms.time = nowMs;
    if (ms.count >= MIGRATE_STRIKES) {
      migrateStates.delete(key);
      L(
        `迁移回滚达 ${MIGRATE_STRIKES} 次仍被写回，停止重写字节，改为纠正标签页编码：${uri.fsPath}`
      );
      await fixOpenTabEncoding(uri, targetEnc);
      const name1 = uri.fsPath.split(/[\\/]/).pop() ?? uri.fsPath;
      warnWithOpenFile(
        `${name1} 的编码已被反复改写 ${ms.count} 次又写坏 ${MIGRATE_STRIKES} 次，` +
          `插件已停止反复重写。最常见原因：该文件在编辑器里用错误编码打开且开启了自动保存，` +
          `每次保存都会写坏编码。已尝试按 ${targetEnc.toUpperCase()} 纠正标签页；` +
          `若仍反复出现，请关闭该文件标签页后重新打开`,
        uri
      );
      return;
    }
  } else {
    migrateStates.set(key, { count: 1, time: nowMs });
  }
  const ext = fileExt(uri.fsPath);
  if (!isAutoRepairBytes()) {
    const name = uri.fsPath.split(/[\\/]/).pop() ?? uri.fsPath;
    L(`检测到文件编码被整体改写（自动回滚已关闭）：${uri.fsPath}`);
    if (ext !== "log") {
      warnWithOpenFile(
        `${name} 的文件编码被外部程序整体改写（内容完好）。可在设置开启 encoding-guard.autoRepairBytes 自动转回原编码`,
        uri
      );
    }
    return;
  }
  repairing.add(key);
  try {
    const done = await executeRepair(uri, full, {
      bytes: converted,
      encoding: targetEnc,
      kind: "migrate",
    });
    if (done) {
      // 字节已转回目标编码：立即同步标签页编码，否则 IDE 自动保存仍按
      // 旧标签（错误编码）写盘，立刻把文件再次写坏 → 无限反复
      await fixOpenTabEncoding(uri, targetEnc);
    }
  } finally {
    repairing.delete(key);
  }
}

// watcher 事件防抖合并：短时间大量文件变化（构建/安装依赖）只批量处理一次
let watchTimer: NodeJS.Timeout | undefined;
const pendingWatch = new Map<string, vscode.Uri>();

function scheduleWatchCheck(uri: vscode.Uri): void {
  pendingWatch.set(uri.toString(), uri);
  if (watchTimer) {
    clearTimeout(watchTimer);
  }
  watchTimer = setTimeout(() => {
    const list = [...pendingWatch.values()];
    pendingWatch.clear();
    for (const u of list) {
      void checkWrittenFile(u);
    }
  }, 500);
}

// 内容自声明的编码：XML 声明 <?xml version="1.0" encoding="utf-8"?>、
// HTML meta charset 等。声明必须是 ASCII 且位于文件头部。迁移回滚方向
// 与声明冲突时以声明为准（工具链按声明解码，磁盘编码违背声明即为损坏）
function declaredEncoding(head: Buffer): string | null {
  const probe = head.subarray(0, 256);
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] >= 0x80) {
      return null; // 声明区含非 ASCII → 无有效声明
    }
  }
  const s = probe.toString("latin1");
  const m =
    s.match(/encoding\s*=\s*["']([-A-Za-z0-9_.]+)["']/i) ??
    s.match(/charset\s*=\s*["']([-A-Za-z0-9_.]+)["']/i);
  if (!m) {
    return null;
  }
  const alias: Record<string, string> = {
    utf8: "utf8",
    "utf-8": "utf8",
    gb2312: "gb2312",
    gbk: "gbk",
    gb18030: "gb18030",
    big5: "big5",
  };
  return alias[m[1].toLowerCase()] ?? null;
}

async function checkWrittenFile(uri: vscode.Uri): Promise<void> {
  const key = uri.toString();
  let fp = diskFingerprint(uri);

  // 回写对抗：修复后的乱码又被写回（指纹=修复前 badFp）时，
  // 无视检查记录强制重检，再次走修复流程（次数上限在下方判断）
  const rs = repairStates.get(key);
  if (rs) {
    if (fp === rs.goodFp) {
      watcherDone.set(key, fp);
      return; // 修复写盘自身触发的事件
    }
    if (fp === rs.badFp) {
      if (rs.count >= 3) {
        // 已自动修复 3 次仍被写回旧乱码：AI 在用它内存里的旧快照覆盖，
        // 插件无法阻止其写入（文件系统无锁可用），停止对抗并明确告知
        const name = uri.fsPath.split(/[\\/]/).pop() ?? uri.fsPath;
        L(`回写对抗达上限（已修复 ${rs.count} 次），停止自动修复：${uri.fsPath}`);
        repairStates.delete(key);
        watcherDone.set(key, fp);
        warnWithOpenFile(
          `${name} 的编码损坏已被自动修复 ${rs.count} 次，但又被外部程序（可能是 AI）用旧内容覆盖。` +
            `请让 AI 重新读取该文件后再继续修改，或先暂停 AI 任务`,
          uri
        );
        return;
      }
      L(
        `修复后的乱码又被写回（第 ${rs.count + 1} 次修复，AI 可能在用旧内容覆盖）：${uri.fsPath}`
      );
      // 继续走下方检测修复流程（不 return，也不更新 watcherDone）
    } else {
      repairStates.delete(key); // 内容既非修复结果也非旧乱码 → 状态失效
    }
  }

  if (watcherDone.get(key) === fp) {
    return; // 该文件该状态已检查过
  }
  const ext = fileExt(uri.fsPath);
  if (!TEXT_EXTS.has(ext)) {
    watcherDone.set(key, fp);
    return; // 非监督范围，静默
  }
  const head = headBytes(uri.fsPath, 64 * 1024);
  if (!head || head.length === 0) {
    watcherDone.set(key, fp);
    return;
  }
  const candidates = getDetectionEncodings();
  const enc = detectHeadTolerant(head, candidates);
  // 其它窗口主动切换编码的落盘：磁盘指纹与意图登记完全一致 →
  // 确认是某窗口的有意切换而非 AI 改写，接受新编码并同步记录
  if (matchConvertIntent(key, fp, enc)) {
    setLastEnc(key, enc);
    watcherDone.set(key, fp);
    L(`接受其它窗口的编码切换：${uri.fsPath} → ${enc}`);
    return;
  }
  const prev = getLastEnc(key);
  setLastEnc(key, enc);
  if (prev && prev !== enc) {
    L(`编码变化：${uri.fsPath} ${prev} → ${enc}`);
  }
  if (enc === "unknown") {
    // 可能仍在写入读到半截：稍等后重读确认，仍不可识别才告警
    await sleep(400);
    const re = headBytes(uri.fsPath, 64 * 1024);
    if (!re) {
      return;
    }
    fp = diskFingerprint(uri);
    watcherDone.set(key, fp);
    if (detectHeadTolerant(re, candidates) === "unknown") {
      // 日志文件由程序持续写入，截断/异常字节概率高，只记日志不弹窗
      if (ext === "log") {
        L(`无法识别编码（可能仍在写入或含异常字节）：${uri.fsPath}`);
      } else {
        warnCorrupted(uri);
      }
    }
    return;
  }

  // 超过修复大小上限：不做全文分析，仅保留头部告警
  let size = 0;
  try {
    size = fs.statSync(uri.fsPath).size;
  } catch {
    return;
  }
  if (size > maxRepairBytes()) {
    watcherDone.set(key, fp);
    if (isUtfFamily(enc)) {
      const headText = iconv.decode(head, "utf-8");
      if (isReversibleMojibakeText(headText) && ext !== "log") {
        warnCorrupted(
          uri,
          `疑似双重转码乱码（文件超过自动修复大小上限），可用版本管理回退`
        );
      }
    }
    return;
  }

  // 全文读取做一致性校验（头部合法 ≠ 全文合法，AI 可能只改写/追加了部分内容）
  let full: Buffer;
  try {
    full = fs.readFileSync(uri.fsPath);
  } catch {
    return;
  }
  if (full.length === 0) {
    watcherDone.set(key, fp);
    return;
  }
  fp = diskFingerprint(uri);
  watcherDone.set(key, fp);

  if (isUtfFamily(enc)) {
    // UTF-8 文件三种情况：
    // 1) 全文不是合法 UTF-8 → 混入了非 UTF-8 字节（AI 用 GBK 等写入）→ 混合修复
    // 2) 全文合法但文本几乎全是 Latin 扩展字符 → 双重转码 mojibake → 转码还原
    // 3) 全文合法且内容正确（含中文）→ 但上次记录是非 UTF 族编码 →
    //    疑似 AI 把原 GBK 等文件整体按 UTF-8 重写 → 编码迁移回滚
    const body =
      full.length >= 3 &&
      full[0] === 0xef &&
      full[1] === 0xbb &&
      full[2] === 0xbf
        ? full.subarray(3)
        : full;
    if (!isUtf8(body) || isReversibleMojibakeText(iconv.decode(head, "utf-8"))) {
      await tryRepairCorrupted(uri, full);
      return;
    }
    // 编码迁移回滚：上次是非 UTF 族、这次变成 UTF-8 且内容含成词中文
    // （强 CJK 门槛：零星对撞出的汉字不支持一次主动改写文件的回滚）
    if (
      prev &&
      prev !== "unknown" &&
      !isUtfFamily(prev) &&
      hasStrongCJK(iconv.decode(body, "utf-8"))
    ) {
      // 跨平台注册表仲裁：登记为 UTF 族（最近某平台修复/切换成 UTF）→
      // 与磁盘一致，接受现状并同步本地历史——否则两个平台各按自己的
      // lastEnc 反向回滚，连续抢注转码直到熔断
      const reg = readEncReg(uri.fsPath);
      if (reg && isUtfFamily(reg.enc)) {
        setLastEnc(uri.toString(), enc);
        L(
          `跨平台登记为 ${reg.enc}（${reg.platform}），与磁盘一致，接受现状：${uri.fsPath}`
        );
        return;
      }
      // 内容声明与回滚目标冲突（如 XML 声明 utf-8、历史是 GBK）→ 声明优先：
      // 文件当前已是声明编码（自洽），"迁移"实为 AI/工具的有意转换，不回滚
      const declared = declaredEncoding(head);
      if (declared && isUtfFamily(declared)) {
        L(
          `内容声明 ${declared} 与当前一致，接受现状不做迁移回滚：${uri.fsPath}`
        );
        return;
      }
      // 回滚目标以注册表为准（跨平台共识比本平台历史更新）；无登记才用 prev
      const target = reg && !isUtfFamily(reg.enc) ? reg.enc : prev;
      const converted = migrateEncodingBytes(full, enc, target);
      if (converted) {
        await tryRepairMigrated(uri, full, converted, target);
      } else {
        L(`疑似编码迁移但无法无损转回 ${target}（含不可表达字符），放弃：${uri.fsPath}`);
      }
    }
    return;
  }

  // 非 UTF 系（如 GBK）两种情况：
  // 1) 全文按该编码解码有损 → 混入了其他编码的字节（AI 写入）→ 混合修复
  // 2) 全文无损且内容正确 → 但上次记录是 UTF 族编码 →
  //    疑似 AI 把原 UTF-8 文件整体按当前编码重写 → 编码迁移回滚
  if (decodeWith(enc, full) === null) {
    await tryRepairCorrupted(uri, full);
    return;
  }
  if (
    prev &&
    prev !== "unknown" &&
    isUtfFamily(prev) &&
    hasStrongCJK(decodeWith(enc, full) ?? "")
  ) {
    // 跨平台注册表仲裁：登记为非 UTF 族（最近某平台确认是 GBK 等）→ 与
    // 磁盘一致，接受现状并同步本地历史，防止与其它平台方向相反的拉锯
    const reg = readEncReg(uri.fsPath);
    if (reg && !isUtfFamily(reg.enc)) {
      setLastEnc(uri.toString(), enc);
      L(
        `跨平台登记为 ${reg.enc}（${reg.platform}），与磁盘一致，接受现状：${uri.fsPath}`
      );
      return;
    }
    // 磁盘编码违背内容声明（如 XML 声明 utf-8、磁盘却是 GBK）→ 以声明为
    // 修复目标（工具链按声明解码，声明优先于历史编码记录）；无声明时按
    // 注册表（跨平台共识），最后才是 utf8
    const declared = declaredEncoding(head);
    const target =
      declared && !isUtfFamily(declared)
        ? declared
        : reg && isUtfFamily(reg.enc)
          ? reg.enc
          : "utf8";
    if (declared && !isUtfFamily(declared)) {
      L(
        `磁盘编码 ${enc} 违背内容声明 ${declared}，按声明编码修复：${uri.fsPath}`
      );
    }
    const converted = migrateEncodingBytes(full, enc, target);
    if (converted) {
      await tryRepairMigrated(uri, full, converted, target);
    } else {
      L(`疑似编码迁移但无法无损转回 ${target}（含不可表达字符），放弃：${uri.fsPath}`);
    }
  }
}

// ===== AI 新建文件的初始编码归一 =====
// AI/工具新建的文件常按系统 ANSI（GBK）落盘，与本平台 files.encoding 设置
// （如 UTF-8）不一致，导致后续 AI 编辑/内核显示沿用错误编码。新文件落盘后
// 自动转换为设置默认编码（无损校验，失败放弃不动文件）。
//
// 多平台隔离：Trae/Cursor/VSCode 可同时开同一工作区，各平台 files.encoding
// 可能互相冲突；文件系统不记录写者身份，无法直接判断"是哪个平台的 AI 新建
// 的"。改用抢占式处理权登记（claim）实现等效隔离——登记写入系统临时目录
// （跨平台实例均可见），同一新文件只有先抢到登记的实例执行归一，其它平台
// 实例看到登记就让路；归一结果登记在案（TTL 内），所有实例的编码迁移回滚
// 接受现状，避免多平台来回转换打架。

interface EncClaim {
  platform: string;
  time: number;
  status: "claimed" | "done";
  enc: string;
}

const CLAIM_TTL_MS = 60 * 1000;
const CLAIM_DIR = path.join(os.tmpdir(), "encoding-guard-claims");

function claimPath(fsPath: string): string {
  const h = crypto
    .createHash("sha1")
    .update(fsPath.replace(/\\/g, "/").toLowerCase())
    .digest("hex");
  return path.join(CLAIM_DIR, `${h}.json`);
}

function platformId(): string {
  return vscode.env.uriScheme || vscode.env.appName || "unknown";
}

// 读取有效期内的处理权登记；过期即视为无效
function getFreshClaim(fsPath: string): EncClaim | null {
  try {
    const raw = fs.readFileSync(claimPath(fsPath), "utf8");
    const claim = JSON.parse(raw) as EncClaim;
    if (Date.now() - claim.time < CLAIM_TTL_MS) {
      return claim;
    }
  } catch {
    // 无登记/损坏 → 视为无
  }
  return null;
}

// 原子抢占处理权（flag "wx" 保证并发下只有一个实例成功）；
// 返回 null 表示抢占成功，返回登记内容表示已有新鲜登记需让路
function tryClaimFile(fsPath: string, enc: string): EncClaim | null {
  const existing = getFreshClaim(fsPath);
  if (existing) {
    return existing;
  }
  const claim: EncClaim = {
    platform: platformId(),
    time: Date.now(),
    status: "claimed",
    enc,
  };
  try {
    fs.mkdirSync(CLAIM_DIR, { recursive: true });
    fs.writeFileSync(claimPath(fsPath), JSON.stringify(claim), { flag: "wx" });
    return null;
  } catch {
    // wx 失败 = 并发抢占输了 → 读取对方的登记让路
    return getFreshClaim(fsPath) ?? claim;
  }
}

// 强制写入处理权登记（覆盖已有登记；用于本实例主动接管：手动切换编码等）
function forceClaim(fsPath: string, enc: string, status: EncClaim["status"]): void {
  const claim: EncClaim = {
    platform: platformId(),
    time: Date.now(),
    status,
    enc,
  };
  try {
    fs.mkdirSync(CLAIM_DIR, { recursive: true });
    fs.writeFileSync(claimPath(fsPath), JSON.stringify(claim));
  } catch {
    // 登记失败不影响主流程
  }
}

// 归一完成，登记结果（保留至 TTL 过期，供迁移回滚接受现状）
function finishClaim(fsPath: string, enc: string): void {
  forceClaim(fsPath, enc, "done");
}

// ===== 跨平台编码注册表（回滚方向权威仲裁）=====
// lastEnc 存于各平台自己的 globalState，Trae 与 VSCode 互不可见——同一共享
// 文件两边历史不同（一边 gbk 一边 utf8）时，迁移回滚方向相反：租约只能
// 串行化"每一次"修复，管不住方向相反的连续拉锯（表现为连续抢注转码，
// 直到 3 次熔断才停）。注册表落文件系统（claims 目录，全平台可见）：
// 修复/手动转换完成后登记"文件当前编码"，回滚前先查注册表——登记与磁盘
// 一致就接受现状并同步本地历史，方向分歧从源头消除。TTL 7 天防陈旧登记
const ENC_REG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function encRegPath(fsPath: string): string {
  return claimPath(fsPath).replace(/\.json$/, ".enc.json");
}

function readEncReg(fsPath: string): EncClaim | null {
  try {
    const reg = JSON.parse(
      fs.readFileSync(encRegPath(fsPath), "utf8")
    ) as EncClaim;
    if (reg.enc && Date.now() - reg.time < ENC_REG_TTL_MS) {
      return reg;
    }
  } catch {
    // 无登记/损坏 → 视为无
  }
  return null;
}

function writeEncReg(fsPath: string, enc: string): void {
  try {
    fs.mkdirSync(CLAIM_DIR, { recursive: true });
    fs.writeFileSync(
      encRegPath(fsPath),
      JSON.stringify({
        platform: platformId(),
        time: Date.now(),
        status: "done" as const,
        enc,
      })
    );
  } catch {
    // 登记失败不阻断主流程
  }
}

// ===== 修复租约（选主机制）=====
// 同一工作区多开实例（Trae/Cursor/VSCode）时，各实例的 watcher 都会看到
// 同一次外部写入并独立触发修复。同向修复幂等但浪费 IO；反向修复（各实例
// 编码历史不同）会无限打架。租约保证同一文件的修复只有一个实例执行：
// 原子 wx 抢租约，抢到的修，其余实例让路。租约含 20s TTL 防实例中途崩溃
// 死锁；修复完成（含放弃路径）立即释放，落败实例可在下次事件重试
const REPAIR_LEASE_TTL_MS = 20 * 1000;

function repairLeasePath(fsPath: string): string {
  return claimPath(fsPath) + ".lease";
}

// 抢占修复租约：返回 null 表示抢到（本实例执行修复），
// 返回租约内容表示其它实例正在修复（让路）
function acquireRepairLease(fsPath: string, enc: string): EncClaim | null {
  const leasePath = repairLeasePath(fsPath);
  try {
    const raw = fs.readFileSync(leasePath, "utf8");
    const lease = JSON.parse(raw) as EncClaim;
    if (Date.now() - lease.time < REPAIR_LEASE_TTL_MS) {
      return lease; // 新鲜租约被他人持有 → 让路
    }
    // 过期租约（持有者可能已崩溃）→ 清除后重新抢占
    try {
      fs.unlinkSync(leasePath);
    } catch {
      // 忽略
    }
  } catch {
    // 无租约 → 直接抢
  }
  const lease: EncClaim = {
    platform: platformId(),
    time: Date.now(),
    status: "claimed",
    enc,
  };
  try {
    fs.mkdirSync(CLAIM_DIR, { recursive: true });
    fs.writeFileSync(leasePath, JSON.stringify(lease), { flag: "wx" });
    return null; // 抢到
  } catch {
    // wx 失败 = 并发抢租约输了 → 读对方租约让路
    try {
      return JSON.parse(fs.readFileSync(leasePath, "utf8")) as EncClaim;
    } catch {
      return lease; // 读不到也保守让路一轮
    }
  }
}

function releaseRepairLease(fsPath: string): void {
  try {
    fs.unlinkSync(repairLeasePath(fsPath));
  } catch {
    // 已释放/不存在
  }
}

// 顺手清理过期登记（低频调用，防止目录无限膨胀）
function pruneClaims(): void {
  try {
    const deadline = Date.now() - CLAIM_TTL_MS * 10;
    for (const f of fs.readdirSync(CLAIM_DIR)) {
      if (f.endsWith(".enc.json")) {
        continue; // 编码注册表有自己的 7 天 TTL（读取时校验），不按 claim 清理
      }
      const p = path.join(CLAIM_DIR, f);
      try {
        if (fs.statSync(p).mtimeMs < deadline) {
          fs.unlinkSync(p);
        }
      } catch {
        // 单个失败忽略
      }
    }
  } catch {
    // 目录不存在等，忽略
  }
}

// VSCode files.encoding 设置值 → iconv-lite 编码名
const FILES_ENC_MAP: Record<string, string> = {
  utf8: "utf8",
  "utf-8": "utf8",
  utf8bom: "utf8",
  shiftjis: "shift_jis",
  windows1252: "cp1252",
  windows1251: "cp1251",
  big5hkscs: "big5-hkscs",
};

// 本平台（含工作区覆盖）的默认文件编码
function platformDefaultEncoding(uri: vscode.Uri): string {
  const raw =
    vscode.workspace
      .getConfiguration("files", uri)
      .get<string>("encoding", "utf8") ?? "utf8";
  const lower = raw.toLowerCase();
  return FILES_ENC_MAP[lower] ?? lower;
}

function countNewlineBytes(b: Buffer): number {
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x0a) {
      n++;
    }
  }
  return n;
}

const normalizePending = new Set<string>();
// 归一白名单：本会话亲眼见证创建（onDidCreate）的文件才允许归一，
// 防止把已存在的老文件按 files.encoding 强转（0.10.4 前的严重误伤）
const witnessedNewFiles = new Set<string>();

// 新文件落盘 → 按本平台 files.encoding 归一编码（无损转换，失败不动文件）
function normalizeNewFileEncoding(uri: vscode.Uri): void {
  const key = uri.toString();
  if (normalizePending.has(key) || !shouldWatchFile(uri)) {
    return;
  }
  if (!TEXT_EXTS.has(fileExt(uri.fsPath))) {
    return; // 只处理文本文件，防止误改二进制
  }
  normalizePending.add(key);
  try {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(uri.fsPath);
    } catch {
      return;
    }
    if (bytes.length === 0) {
      return; // 空文件（AI 先建后写）：等后续写入事件再归一
    }
    let ascii = true;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] >= 0x80) {
        ascii = false;
        break;
      }
    }
    if (ascii) {
      return; // 纯 ASCII 在各编码下字节相同，无需处理
    }
    const actual = detectEncoding(bytes, getDetectionEncodings());
    if (actual === "unknown") {
      return; // 无法识别（半截写入/二进制特征），交给后续事件
    }
    // 归一目标：内容编码声明优先（工具链按声明解码，如 XML encoding=），
    // 无声明才跟随本平台 files.encoding
    const declared = declaredEncoding(bytes);
    const defEnc = declared ?? platformDefaultEncoding(uri);
    if (declared) {
      L(`新文件带编码声明 ${declared}，按声明归一：${uri.fsPath}`);
    }
    setLastEnc(key, actual); // 无论是否转换，先记录基线编码
    const sameFamily =
      isUtfFamily(actual) === isUtfFamily(defEnc) &&
      (isUtfFamily(defEnc) || actual === defEnc);
    if (sameFamily) {
      return; // 已符合设置默认编码
    }
    // 抢占处理权：其它平台实例已登记 → 让路（由对方归一）
    const blocker = tryClaimFile(uri.fsPath, actual);
    if (blocker) {
      L(
        `新文件编码归一已由 ${blocker.platform} 实例接管（${blocker.status}），本实例让路：${uri.fsPath}`
      );
      return;
    }
    // 无损转码：实际编码解码 → 设置默认编码编码 → 回读校验 + 行数校验
    const text = isUtfFamily(actual)
      ? bytes.toString("utf8")
      : iconv.decode(bytes, actual);
    if (text.includes("\ufffd")) {
      L(`新文件含不可解码字节，放弃编码归一：${uri.fsPath}`);
      return;
    }
    const converted = isUtfFamily(defEnc)
      ? Buffer.from(text, "utf8")
      : iconv.encode(text, defEnc);
    const back = isUtfFamily(defEnc)
      ? converted.toString("utf8")
      : iconv.decode(converted, defEnc);
    if (back !== text || countNewlineBytes(converted) !== countNewlineBytes(bytes)) {
      L(
        `新文件无法无损转为 ${defEnc.toUpperCase()}（内容或行数有损），放弃归一：${uri.fsPath}`
      );
      return;
    }
    fs.writeFileSync(uri.fsPath, converted);
    finishClaim(uri.fsPath, defEnc);
    setLastEnc(key, defEnc);
    writeEncReg(uri.fsPath, defEnc); // 跨平台登记（方向仲裁依据）
    const fp = diskFingerprint(uri);
    watcherDone.set(key, fp);
    autoDone.set(key, fp);
    pruneClaims();
    L(
      `新文件编码归一：${uri.fsPath}（${actual} → ${defEnc}，跟随本平台 files.encoding 设置）`
    );
  } finally {
    normalizePending.delete(key);
  }
}

function shouldWatchFile(uri: vscode.Uri): boolean {
  if (uri.scheme !== "file") {
    return false;
  }
  const p = uri.fsPath.replace(/\\/g, "/").toLowerCase();
  return !p.includes("/node_modules/") && !p.includes("/.git/");
}

export function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel("编码切换器");
  context.subscriptions.push(log);
  // 日志落盘：全局存储目录（随插件持久化，重装/重启不丢）
  try {
    const dir = context.globalStorageUri.fsPath;
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, "encoding-guard.log");
  } catch {
    logFile = null; // 目录不可用时仅用输出面板
  }
  L(`===== 会话启动 v${context.extension.packageJSON.version} =====`);
  initSharedState(context.globalState); // 跨窗口共享编码历史（防多实例打架）

  context.subscriptions.push(
    vscode.commands.registerCommand("encoding-guard.saveWithEncoding", () => {
      void pickAndConvert();
    })
  );

  // 手动打开当前文件的正确编码只读视图
  context.subscriptions.push(
    vscode.commands.registerCommand("encoding-guard.openEncodingView", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.isUntitled || editor.document.uri.scheme !== "file") {
        void vscode.window.showWarningMessage("当前没有打开的本地文件");
        return;
      }
      try {
        const fsPath = editor.document.uri.fsPath;
        const enc = detectEncoding(fs.readFileSync(fsPath), getDetectionEncodings());
        if (enc === "unknown") {
          void vscode.window.showWarningMessage(
            "无法识别该文件编码（不在检测编码列表内），无法打开正确编码视图"
          );
          return;
        }
        void encodingView?.open(fsPath, vscodeEncodingLabel(enc));
      } catch (e) {
        void vscode.window.showErrorMessage(`读取文件失败: ${String(e)}`);
      }
    })
  );

  // 注册正确编码可读写文件系统（内核重开命令缺失时的兜底：等效按编码重开的可编辑器）
  const viewProvider = new EncodingViewProvider();
  encodingView = viewProvider;
  context.subscriptions.push(
    viewProvider,
    vscode.workspace.registerFileSystemProvider(VIEW_SCHEME, viewProvider, {
      isCaseSensitive: true,
    })
  );

  // 内核猜码设置：默认不干预（部分内核对候选列表支持不佳，强制写入会破坏猜测）。
  // 开启 encoding-guard.applyKernelGuess 后按工作区写入；
  // 关闭状态下自动恢复历史版本误写过的全局设置
  if (isApplyKernelGuess()) {
    void ensureAutoGuessEncoding();
  } else {
    void restoreKernelGuessSettings();
  }

  // 侦查内核可用的“指定编码重开”命令（命令式重开的前提）
  void detectReopenEncodingCmd();

  // 活动编辑器变化时刷新上下文（决定显示哪个按键）
  // 防抖：切换/打开事件可能密集触发，避免每次都同步读盘
  let ctxTimer: NodeJS.Timeout | undefined;
  const scheduleContextUpdate = () => {
    if (ctxTimer) {
      clearTimeout(ctxTimer);
    }
    ctxTimer = setTimeout(() => updateContext(), 120);
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => scheduleContextUpdate())
  );
  // 保存也可能改变磁盘编码（如系统自带“通过编码保存”），需同步刷新按钮
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => scheduleContextUpdate())
  );
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      scheduleContextUpdate();
      if (doc.uri.scheme !== "file") {
        return;
      }
      const key = doc.uri.toString();
      if (internalReopen.has(key)) {
        // 内部重开流程重建模型触发的事件，不是用户打开，避免重复处理造成循环
        internalReopen.delete(key);
        return;
      }
      // 用户真实（重新）打开：清除历史结论，重新完整检测纠正
      autoDone.delete(key);
      reopenCooldown.delete(key);
      // 注意：打开事件不做编码归一——旧文件打开时绝不能按 files.encoding
      // 强转（0.10.4 前曾把用户修好的 UTF-8 老文件转回 GBK）
      scheduleAutoReopen(doc.uri);
    })
  );
  // 外部改写（AI/工具直接写文件）：内核按旧编码标签解码新字节会导致乱码显示，
  // 对非脏文档做“磁盘 vs 显示”全量校验，不一致则重开纠正
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const doc = e.document;
      if (!doc || doc.isDirty) {
        return;
      }
      if (doc.uri.scheme === "file") {
        scheduleAutoReopen(doc.uri, true);
        void encodingView?.syncWithDisk(doc.uri.fsPath); // 视图编码落后于磁盘时自纠
      } else if (doc.uri.scheme === VIEW_SCHEME) {
        // 编码视图：磁盘编码已与视图不一致时，禁编辑/自纠
        void encodingView?.syncWithDisk(doc.uri.fsPath);
      }
    })
  );

  // 监督未打开文件的外部写入：AI 不经编辑器直接改盘时无任何文档事件，
  // 用 FileSystemWatcher 兜底，对疑似编码损坏的文本文件及时告警
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  watcher.onDidChange((uri) => {
    if (shouldWatchFile(uri)) {
      // 仅对"本会话亲眼见证创建"的文件补归一（AI 先建空文件后写入）；
      // 老文件的变化事件绝不归一，防止把已有文件强转成 files.encoding
      if (witnessedNewFiles.has(uri.toString())) {
        normalizeNewFileEncoding(uri);
      }
      scheduleWatchCheck(uri);
      void encodingView?.syncWithDisk(uri.fsPath); // 视图跟随磁盘（编码变化时自动纠正）
    }
  });
  watcher.onDidCreate((uri) => {
    if (shouldWatchFile(uri)) {
      witnessedNewFiles.add(uri.toString()); // 见证创建：允许后续归一
      normalizeNewFileEncoding(uri); // AI 新建文件 → 按声明/files.encoding 归一
      scheduleWatchCheck(uri);
      void encodingView?.syncWithDisk(uri.fsPath);
    }
  });
  watcher.onDidDelete((uri) => {
    const key = uri.toString();
    watcherDone.delete(key);
    deleteLastEnc(key);
    repairStates.delete(key);
  });
  context.subscriptions.push(watcher);

  // 覆盖编辑器启动时恢复的已打开标签（不触发 onDidOpenTextDocument）
  setTimeout(() => {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === "file") {
        scheduleAutoReopen(doc.uri);
      }
    }
  }, 800);

  // 初次激活时刷新一次
  updateContext();
  L("扩展已激活");
}

export function deactivate() {}
