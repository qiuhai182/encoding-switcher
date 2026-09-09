import * as vscode from "vscode";
import * as fs from "fs";
import * as iconv from "iconv-lite";
import { detectEncoding, isUtf8 } from "./encoding";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 诊断日志（输出面板 → “编码切换器”）
let log: vscode.OutputChannel;
function L(msg: string): void {
  try {
    log?.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
  } catch {
    // 忽略
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

// ===== 兜底：正确编码只读视图 =====
// Trae SOLO 内核既猜不对编码、又没有“指定编码重开”命令时，
// 通过自定义 scheme 提供按正确编码解码的只读视图，保证中文可读；
// 原文件字节保持不变（绝不修改磁盘内容），编辑仍可在原编辑器进行。

const VIEW_SCHEME = "encoding-view";

// 正确编码可读写编辑器：以指定编码解码/编码读写原文件，
// 让“内核猜错编码”的文件拥有可编辑、可保存的正常编辑器（等效于按编码重开）。
// 编辑器文本 ⇄ 原文件字节 的桥接规则：
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
    const encChanged =
      !isUtfFamily(curEnc) && !isUtfFamily(openEnc) && curEnc !== openEnc;
    if (encChanged) {
      // 每阻止一次乱码保存，就警告一次，让用户知道有内容被拦下
      const msg =
        `已阻止一次乱码保存：文件实际编码已变为 ${curEnc}（打开时为 ${openEnc}），` +
        `继续写入会导致中文损坏。请关闭本编辑器后重新打开文件`;
      L(`已阻止乱码保存：${fsPath}（${openEnc} → ${curEnc}）`);
      void vscode.window.showWarningMessage(msg);
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

  // 首选：命令式指定编码重开（使用侦查到的内核命令）
  if (reopenEncodingCmd) {
    try {
      markInternalReopen(uri); // 重开会重建文档模型，标记为内部事件
      await vscode.commands.executeCommand(
        reopenEncodingCmd,
        uri,
        encLabel
      );
      if (await displayedOK(10)) {
        L(`命令式重开(${encLabel}，${reopenEncodingCmd})成功：${uri.fsPath}`);
        return true;
      }
      L(`命令式重开(${encLabel})后显示仍不正确：${uri.fsPath}`);
    } catch (e) {
      L(`命令式重开异常: ${String(e)}`);
    }
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

  // 3) 以目标编码写回（UTF-8 不写 BOM）
  if (!writeFileWithEncoding(filePath, text, targetEnc)) {
    vscode.window.showErrorMessage(`切换为 ${targetLabel} 失败`);
    return;
  }

  // 转换成功后记录新指纹，避免自动检测重复干预
  autoDone.set(doc.uri.toString(), diskFingerprint(doc.uri));

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
    vscode.window
      .showErrorMessage(
        `已转换为 ${targetLabel} 并保存到磁盘，但视图未能自动刷新为新编码。请手动关闭该文件后重新打开。可到输出面板「编码切换器」查看诊断日志。`,
        "打开日志"
      )
      .then((choice) => {
        if (choice === "打开日志") {
          log.show();
        }
      });
    return;
  }

  // 5) 刷新按键显示（文件编码已改变）
  await updateContext();
  vscode.window.showInformationMessage(`已切换为 ${targetLabel} 并保存`);
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
const lastEnc = new Map<string, string>();

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

function warnCorrupted(uri: vscode.Uri, hint?: string): void {
  const name = uri.fsPath.split(/[\\/]/).pop() ?? uri.fsPath;
  L(`疑似编码损坏：${uri.fsPath}`);
  void vscode.window
    .showWarningMessage(
      hint ??
        `${name} 疑似被以错误编码写入，中文内容可能已损坏（如需恢复请用版本管理回退）`,
      "打开日志"
    )
    .then((choice) => {
      if (choice === "打开日志") {
        log.show();
      }
    });
}

// 统计解码文本中的替换字符数量（解码不可逆损坏的典型特征）
function countReplacementChars(text: string): number {
  let n = 0;
  let i = text.indexOf("\ufffd");
  while (i >= 0) {
    n++;
    i = text.indexOf("\ufffd", i + 1);
  }
  return n;
}

// 是否包含中日韩字符
function containsCJK(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text);
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

async function checkWrittenFile(uri: vscode.Uri): Promise<void> {
  const key = uri.toString();
  let fp = diskFingerprint(uri);
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
  const prev = lastEnc.get(key);
  lastEnc.set(key, enc);
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
  watcherDone.set(key, fp);

  if (!isUtfFamily(enc)) {
    return; // 正常的非 UTF 系文件，显示纠正由打开事件负责
  }
  // UTF-8 文件：识别双重转码特征（相对首个非 UTF 候选编码）后只告警提示手动还原
  const headText = iconv.decode(head, "utf-8");
  const firstAlt = candidates[0];
  if (
    firstAlt &&
    containsCJK(headText) &&
    !headText.includes("\ufffd") &&
    isUtf8(iconv.encode(headText, firstAlt))
  ) {
    // 双重转码（UTF-8 被该编码误读后又以 UTF-8 写盘）：转回该编码保存即可无损还原
    if (ext === "log") {
      L(`疑似双重转码乱码：${uri.fsPath}`);
    } else {
      warnCorrupted(
        uri,
        `疑似双重转码乱码，可用标题栏「选择编码保存」→ ${firstAlt.toUpperCase()} 手动还原，或用版本管理回退`
      );
    }
    return;
  }
  if (countReplacementChars(headText) >= 3) {
    // 日志文件同理降级：只记日志不弹窗
    if (ext === "log") {
      L(`文本含替换字符（疑似损坏）：${uri.fsPath}`);
    } else {
      warnCorrupted(uri); // 不可逆损坏（含替换字符），只能告警
    }
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
      scheduleAutoReopen(doc.uri);
    })
  );
  // 外部改写（AI/工具直接写文件）：内核按旧编码标签解码新字节会导致乱码显示，
  // 对非脏文档做“磁盘 vs 显示”全量校验，不一致则重开纠正
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const doc = e.document;
      if (doc.uri.scheme === "file" && !doc.isDirty) {
        scheduleAutoReopen(doc.uri, true);
      }
    })
  );

  // 监督未打开文件的外部写入：AI 不经编辑器直接改盘时无任何文档事件，
  // 用 FileSystemWatcher 兜底，对疑似编码损坏的文本文件及时告警
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  watcher.onDidChange((uri) => {
    if (shouldWatchFile(uri)) {
      scheduleWatchCheck(uri);
      encodingView?.refresh(uri.fsPath); // 已打开的只读编码视图跟随刷新
    }
  });
  watcher.onDidCreate((uri) => {
    if (shouldWatchFile(uri)) {
      scheduleWatchCheck(uri);
      encodingView?.refresh(uri.fsPath);
    }
  });
  watcher.onDidDelete((uri) => {
    const key = uri.toString();
    watcherDone.delete(key);
    lastEnc.delete(key);
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
