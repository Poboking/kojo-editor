import type * as Monaco from './entry';
import type { EditorSymbolLocation, ErbIndex, ErbReference, ErbReferenceKind } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from './erb-language';
import { KOJO_LANGUAGE_ID } from './kojo-language';
import { reject } from './rename-rejection';
import { errorText } from '@kojo/plugin-api';
import {
  erbOccurrences,
  findNameTokenPositions,
  isCallShapedMention,
  isKojoSourcePath,
  languageOfPath,
  mergeOccurrences,
  occurrencesFromLocations,
  planReferenceWrites,
  readOnlyFilesReason,
  rewriteClosedFile,
  type ClosedFileIo,
  type ReferenceLanguage,
  type ReferenceOccurrence,
} from '../ui/reference-utils';

/**
 * ERB 函数重命名（F2 / `editor.action.rename`）——**全项目、跨语言一次改齐**，宿主层接线。
 *
 * ## 数据源（零猜测）
 *
 * - 可重命名判定：光标词 → 归一化大写 → `ErbIndex.byName.has` 命中才算数。
 *   索引里没有的名字（`$` 标签、`#DIM` 局部名、拼错词）一律 reject，**不猜**；
 *   索引未建 ⇒ `resolveRenameLocation` 返回 `undefined`（Monaco 走缺省词回退，
 *   不会报错）。
 * - 编辑收集：`referencesTo(归一化名)`——定义点与引用点全集（契约含 `definition`，
 *   rename 必须连定义一起改），按文件分组。
 * - **跨语言腿（W8 XLANG-RENAME）**：同名记号在 `.kojo` 源里的出现点经
 *   `ui.editor.languageService` 槽的 `references` 成员判读（糖线探针法，转译器当判官）
 *   后并入**同一份出现点台账**（`ui/reference-utils.ts`），走**同一条**分组、
 *   只读闸门与送达通道。
 *
 * ## 为什么必须并进来（数据损坏级缺口）
 *
 * `.kojo` 是源、`.erb` 是产物：只改 `.erb` 时，下一次保存 `.kojo` 会把按旧名重新生成的
 * 产物**盖回**改名结果——改名被静默冲掉，作者拿到的是"看着改过其实没改"的文件。
 * 所以本模块对 `.kojo` 侧只有三种态度，没有第四种：
 * ① 糖线证明这些记号是这个函数的引用 ⇒ **同一批**一起改；
 * ② 判据缺席、无法证明 ⇒ **整批拒绝**并说清楚为什么（绝不"先改 `.erb` 那半边"）。
 *    "缺席"含三种现场：判读成员没接上、判读**抛错**（抛错 ≠ 判官答"不是引用"，
 *    那必须是正常返回空集）、宿主 `.kojo` 源**枚举抛错**（没看见的源无从证明）；
 * ③ 该 `.kojo` 文件里根本没有同名记号 ⇒ 与本动作无关，零影响。
 *
 * ## 交付通道（monaco 0.57 standalone 源码取证，两种通道各管一半）
 *
 * monaco standalone 的 `StandaloneBulkEditService.apply` 对**没有 live model 的 resource
 * 直接抛** `bad edit - model not found`（`standaloneServices.js:527`），而重命名的落点
 * 遍布全项目（真语料 2,325 份文件，绝大多数没开标签）⇒ WorkspaceEdit 通道只可能送达
 * **已打开的标签**。所以按文件分两组送达：
 * - **已打开**：进返回的 `WorkspaceEdit`（Monaco 原生落地——脏标记、撤销步、marker 全套现成）；
 * - **未打开**：经宿主注入的 `applyToClosedFile`（内核 io 读改写，保编码保换行 + 原子写 +
 *   备份，写允许域由内核 io 强制——绕开写允许域没有第二条路）。
 *   该通道的**唯一现成实现**是 `createApplyToClosedFile(io)`（与搜索面板「全部替换」
 *   共用 `rewriteClosedFile`，两边不可能再分叉）。
 *
 * ## 写权限收口（铁律 6：不静默）
 *
 * 可写判定 = `kernel.io.isWritable`（与保存按钮/直连编辑同源口径）。只读文件剔除，
 * 且**只要有一份只读 ⇒ 整次重命名取消**、`rejectReason` 明示「n 个文件只读未纳入」
 * （两种语言的文件数合在同一计数里，文案真源 `readOnlyFilesReason`）。
 * 为什么不做"可写的先改一半"：monaco 0.57 的 rename 控制器见到返回值带 `rejectReason`
 * 会**丢弃全部编辑只弹 info**（`rename.js:241`），没有"部分应用 + 提示"的通道——
 * 硬走部分应用就只能静默少改，让作者拿到一套名字分叉的半成品还不自知。宁可全或无。
 * **同一条取证推出的第二条纪律**：`rejectReason` 与"已经落到盘上的改动"永不同时返回——
 * 闭文件写入一处都没成功 ⇒ 拒绝（真全或无）；已有落点后再失败 ⇒ 不再拒绝，
 * 把算好的 WorkspaceEdit 交付并 warn 失败文件（此时拒绝 = 标签回退而盘上半套，更糟）。
 *
 * ## 陈旧索引防误写
 *
 * 索引与现场文本之间没有锁。每一处引用落地前都做**文本验证**：该列区间上现在是不是
 * 这个名字（大小写不敏感）；不匹配（作者已改写 / 行号漂移 / 行越界）⇒ 跳过该处并计数
 * 上报——**绝不按陈旧坐标硬写**。
 *
 * 分层照 `kojo-signature` / `kojo-format`：`wordAtColumn` / `resolveRenameTarget` /
 * `planRenameEdits` / `applyReferenceEdits` 是纯函数（node 单测），`installErbRename`
 * 只做 Monaco 协议翻译。
 */

/* ============================== 纯逻辑：词定位 ============================== */

/**
 * 标识字符集：Unicode 字母 / 数字 / 下划线。与 erb-parser 反向索引的记号字符集同口径
 * （真语料 21% 的函数名含 CJK，ASCII 集会静默漏两成）。
 */
const IDENT_RE = /[\p{L}\p{N}_]/u;

function isIdentPart(ch: string | undefined): boolean {
  return ch !== undefined && IDENT_RE.test(ch);
}

/**
 * 光标列 → 所在词的 0 基半开区间 `[start, end)`（**纯函数**）。
 *
 * `col0` = Monaco 的 1 基列 - 1。词判定向两侧看一格：光标贴着词（词尾后一格、
 * 或词首上一格贴着词）都算在词上，与 Monaco `getWordAtPosition` 的行为一致；
 * 两侧都不是标识字符（空白 / 运算符 / 空行）⇒ `null`。越界列夹取到行尾。
 */
export function wordAtColumn(lineText: string, col0: number): { start: number; end: number } | null {
  if (!Number.isFinite(col0) || col0 < 0) return null;
  const at = Math.min(Math.trunc(col0), lineText.length);
  // 先看光标左侧字符（词尾后一格的情形），再看光标处字符（词首上的情形）
  const anchor = isIdentPart(lineText[at - 1]) ? at - 1 : isIdentPart(lineText[at]) ? at : -1;
  if (anchor < 0) return null;
  let start = anchor;
  while (start > 0 && isIdentPart(lineText[start - 1])) start--;
  let end = anchor + 1;
  while (end < lineText.length && isIdentPart(lineText[end])) end++;
  return { start, end };
}

/* ============================== 纯逻辑：名字判定 ============================== */

/** 名字判定的产物：命中（含原词区间与归一化名）或拒绝（给作者看的理由） */
export type RenameTarget =
  | { readonly kind: 'hit'; readonly startColumn: number; readonly endColumn: number; readonly normalizedName: string }
  | { readonly kind: 'reject'; readonly reason: string };

/**
 * 光标处词 → 是否可重命名（**纯函数**；`column` = Monaco 1 基列）。
 *
 * 命中 = 词归一化大写后 `byName.has` 为真；未命中（`$` 标签、`#DIM` 局部名、裸词）与
 * 无词都 reject，理由区分两种，作者一眼知道为什么 F2 不动。
 */
export function resolveRenameTarget(
  lineText: string,
  column: number,
  byName: ReadonlyMap<string, unknown>,
): RenameTarget {
  const col0 = Math.min(Math.max(0, column - 1), lineText.length);
  const word = wordAtColumn(lineText, col0);
  if (!word) return { kind: 'reject', reason: '光标处没有可重命名的名字' };
  const raw = lineText.slice(word.start, word.end);
  const normalizedName = raw.toUpperCase();
  if (!byName.has(normalizedName)) {
    return {
      kind: 'reject',
      reason: `「${raw}」不在 ERB 函数索引内，不能重命名（$ 标签与 #DIM 局部名不在射程）`,
    };
  }
  return {
    kind: 'hit',
    startColumn: word.start + 1,
    endColumn: word.end + 1,
    normalizedName,
  };
}

/* ============================== 纯逻辑：编辑收集与只读剔除 ============================== */

/** 一处落点的最小区间（`ErbReference` 与 `.kojo` 台账项的共同形状——两种语言共用同一个改写器） */
export interface RenameSpan {
  readonly line: number;
  readonly column: number;
  readonly endColumn: number;
  /** 出现点分类（可选；散文跳过判据只认 **ERB 词法 mention**——`.kojo` 腿的 mention 是探针证明的真引用） */
  readonly kind?: ErbReferenceKind;
  /** 语言轴（可选；散文跳过判据只拦 erb 侧——kojo 侧的 mention 全数可写） */
  readonly language?: ReferenceLanguage;
}

/** 一个文件的引用点组（顺序保持 `referencesTo` 的构建序 → 行 → 列） */
export interface RenameFileGroup {
  readonly path: string;
  readonly refs: readonly ErbReference[];
}

/** 编辑收集产物：可写文件的分组（待送达）+ 只读剔除计数（铁律 4：不静默） */
export interface RenamePlan {
  readonly writable: readonly RenameFileGroup[];
  /** 只读文件数（不是引用点数）——`> 0` ⇒ 整次重命名取消并明示 */
  readonly readOnlyCount: number;
}

/**
 * 引用点全集 → 按文件分组 + 写权限筛选（**纯函数**；`isWritable` = 内核 io 口径）。
 *
 * 只读文件整文件剔除并计数；只要有一份只读，调用方必须整次取消（见模块头注的
 * monaco 语义取证）。本函数是台账分组 `planReferenceWrites` 的薄壳——
 * 保留既有形状给上游单测，闸门逻辑只有一份。
 */
export function planRenameEdits(
  refs: readonly ErbReference[],
  isWritable: (path: string) => boolean,
): RenamePlan {
  // 台账项 ↔ 原引用点对象一一对应：闸门只有一份实现，出口形状保持原样（旧消费方零改动）
  const originals = new WeakMap<ReferenceOccurrence, ErbReference>();
  const ledger: ReferenceOccurrence[] = refs.map((ref) => {
    const occ: ReferenceOccurrence = { ...ref, language: languageOfPath(ref.filePath) };
    originals.set(occ, ref);
    return occ;
  });
  const plan = planReferenceWrites(ledger, isWritable);
  return {
    writable: plan.writable.map((group) => ({
      path: group.path,
      refs: group.occurrences.map((occ) => originals.get(occ) ?? (occ as unknown as ErbReference)),
    })),
    readOnlyCount: plan.readOnlyFiles.length,
  };
}

/* ============================== 纯逻辑：按引用点改写全文 ============================== */

/** 每行的 0 基起始偏移（`text` 按 `\r\n` / `\n` 分行，行偏移含换行长度） */
function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

export interface AppliedReferenceEdits {
  readonly text: string;
  readonly applied: number;
  /** 文本验证不过（名字已改写 / 行漂移 / 行越界）而跳过的引用点数 */
  readonly stale: number;
  /** **ERB 词法** mention 且现文本非调用形（名字后无 `(`）而跳过的处数——「改名不重写散文」 */
  readonly skippedProse: number;
}

/**
 * 把引用点列区间改写进整篇文本（**纯函数**；闭文件 io 通道与单测共用，
 * `.erb` 与 `.kojo` 两种落点同走这里——入参只要求区间，不要求语言）。
 *
 * 每处引用先验证：该区间上的现文本 == 原名（大小写不敏感，与索引归一口径一致）；
 * 不匹配 ⇒ 跳过并计 `stale`（陈旧索引绝不做哑替换）。文件整体只读/写失败由调用方
 * （内核 io）兜住，本函数不碰磁盘。
 */
export function applyReferenceEdits(
  text: string,
  refs: readonly RenameSpan[],
  newName: string,
  normalizedName: string,
): AppliedReferenceEdits {
  const starts = lineStartOffsets(text);
  const lineCount = starts.length;
  // 绝对偏移降序替换：前面的偏移才不会因替换而位移
  const ops: Array<{ at: number; end: number }> = [];
  let stale = 0;
  let skippedProse = 0;
  for (const ref of refs) {
    if (ref.line < 1 || ref.line > lineCount) {
      stale++;
      continue;
    }
    const at = starts[ref.line - 1]! + ref.column - 1;
    const end = starts[ref.line - 1]! + ref.endColumn - 1;
    if (at < 0 || end > text.length || at > end) {
      stale++;
      continue;
    }
    if (text.slice(at, end).toUpperCase() !== normalizedName) {
      stale++;
      continue;
    }
    // ERB 词法 mention 的落盘判据（isCallShapedMention 单源，**只拦 erb 侧**）：条件表达式位的
    // 真调用（`SIF FOO() == 0`——CALL 直系族表只认 CALL 系，条件位在索引里退化为 mention）
    // 照改；未加引号输出行里的同名词（`PRINTFORML キスする。`）是台词散文 ⇒ 跳过。
    // `.kojo` 腿的 mention 是探针证明的真引用（语义不同源），不受此闸影响。
    if (ref.kind === 'mention' && ref.language === 'erb' && text[end] !== '(') {
      skippedProse++;
      continue;
    }
    ops.push({ at, end });
  }
  ops.sort((a, b) => b.at - a.at);
  let next = text;
  for (const op of ops) {
    next = next.slice(0, op.at) + newName + next.slice(op.end);
  }
  return { text: next, applied: ops.length, stale, skippedProse };
}

/* ============================== Monaco 协议翻译 ============================== */

/** 宿主注入：monaco 之外的一切知识都从这里进（与 `kojo-definition` 的 handlers 同款） */
export interface ErbRenameHandlers {
  /**
   * 该不该应答这次请求：只认**当前活动标签的真 model**。派生预览 model 的行列属于
   * 派生物，重命名它改的不是真文件（与 codeAction / 转到定义同一判据）。
   */
  canAnswer(model: Monaco.editor.ITextModel): boolean;
  /** 当前 ERB 索引（`null` = 未建 / 服务缺席；软取不抛） */
  currentIndex(): ErbIndex | null;
  /** 归一化名 → 定义点与引用点全集（`null` = 反向索引缺席；软取不抛） */
  referencesTo(name: string): readonly ErbReference[] | null;
  /** 写权限判定（内核 io `isWritable`，与保存同源口径） */
  isWritable(path: string): boolean;
  /** 文件路径 → 已打开标签的 live model（查不到 = 未打开，走 io 通道） */
  openModelFor(path: string): Monaco.editor.ITextModel | undefined;
  /**
   * 未打开文件的落盘通道（内核 io 读改写：保编码保换行 + 原子写 + 备份）。
   * 返回实改 / 跳过计数；抛错 = 这次写被内核拒绝（写允许域 / io 故障）。
   * 入参是**区间**而非 `ErbReference`：`.erb` 与 `.kojo` 的落点共用这一个改写器，
   * 现成实现见 `createApplyToClosedFile`（与搜索面板「全部替换」同一条通道）。
   */
  applyToClosedFile(
    path: string,
    spans: readonly RenameSpan[],
    newName: string,
    normalizedName: string,
  ): Promise<{ applied: number; stale: number; skippedProse?: number }>;
  /**
   * **跨语言腿 ①**：归一化名可能出现在哪些 `.kojo` 源里（宿主枚举 + 读文，
   * 内核 io 的读权限由宿主兜）。缺席 = 只能看到**已打开标签**里的 `.kojo` 源
   * （本模块经 monaco model 注册表枚举，这条腿不需要新接线就能生效）。
   */
  kojoSources?(normalizedName: string): Promise<readonly KojoSourceFile[]> | readonly KojoSourceFile[];
  /**
   * **跨语言腿 ②**：`.kojo` 源里这一处记号**是不是**这个函数的引用
   * （宿主查 `ui.editor.languageService` 槽的 `references` 成员——糖线探针法，转译器当判官，
   * 本模块零糖语法知识）。返回该文件内可证明的引用点全集；空数组 = 认这个文件但这些
   * 记号不是函数引用（台词散文 / 注释一类），不动它们。
   * **缺席 ⇒ 该文件的同名记号判为"不可证明" ⇒ 整次重命名拒绝**（绝不静默改一半）。
   */
  kojoReferences?(
    probe: KojoReferenceProbe,
  ): Promise<readonly EditorSymbolLocation[]> | readonly EditorSymbolLocation[];
}

/** `kojoSources` 的产出：一份 `.kojo` 源文件的路径与全文 */
export interface KojoSourceFile {
  readonly filePath: string;
  readonly text: string;
}

/** 交给糖线判读的一处候选（文件 + 该文件内某个同名记号的起点） */
export interface KojoReferenceProbe {
  readonly filePath: string;
  readonly text: string;
  readonly line: number;
  readonly column: number;
}

/** 跨语言腿的读数：可证明的 `.kojo` 出现点 + 判据缺席、无法证明的项（每项一句给作者看的label） */
interface KojoLeg {
  readonly occurrences: readonly ReferenceOccurrence[];
  readonly unprovable: readonly { readonly label: string }[];
}

/** 一份候选源判据缺席时的label（文件 + 该文件内同名记号处数） */
const unprovableFileLabel = (filePath: string, positions: number, note?: string): string =>
  `'${filePath}'（${positions} 处${note === undefined ? '' : `，${note}`}）`;

/**
 * `.erb` 改名时把生成它的 `.kojo` 源一起收进台账（**同一条全或无判定**）。
 *
 * 判读全在糖线：本函数只负责"找到候选文件"（已开标签 + 宿主枚举）与"问一次槽"，
 * 把回来的位置换算成落点区间（`endColumn` = 列 + 名字长度，与反向索引同一条派生纪律）。
 */
async function collectKojoLeg(
  monaco: typeof Monaco,
  handlers: ErbRenameHandlers,
  normalizedName: string,
): Promise<KojoLeg> {
  /** 候选文件（路径 → 全文）：已开的 `.kojo` 标签先收，宿主枚举的补在后面 */
  const candidates = new Map<string, string>();
  const getModels = monaco.editor?.getModels;
  if (typeof getModels === 'function') {
    for (const model of getModels.call(monaco.editor)) {
      try {
        if (model.getLanguageId() !== KOJO_LANGUAGE_ID) continue;
        // 派生预览 model（`inmemory://sugar/`）的行列属于派生物，不是盘上的源
        if (model.uri.scheme !== 'file') continue;
        const filePath = model.uri.fsPath || model.uri.path;
        if (!filePath) continue;
        candidates.set(filePath, model.getValue());
      } catch (e: unknown) {
        console.warn(`[erb-rename] 已开 .kojo 标签枚举失败：${errorText(e)}`);
      }
    }
  }
  const occurrences: ReferenceOccurrence[] = [];
  const unprovable: { label: string }[] = [];
  if (handlers.kojoSources) {
    try {
      for (const file of await handlers.kojoSources(normalizedName)) {
        if (isKojoSourcePath(file.filePath)) candidates.set(file.filePath, file.text);
      }
    } catch (e: unknown) {
      // 枚举抛错 = **看不见**未打开的 .kojo 源（判据不是"这份源没有这个记号"，是"我没看见它"）。
      // 此时只改 .erb 半边 = 下次保存被 .kojo 冲掉（数据损坏），所以同样整批拒绝。
      return {
        occurrences: [],
        unprovable: [
          {
            label: `宿主 .kojo 源枚举抛错（${errorText(e)}）——未打开的 .kojo 源无从查证`,
          },
        ],
      };
    }
  }

  for (const [filePath, text] of candidates) {
    const positions = findNameTokenPositions(text, normalizedName);
    if (positions.length === 0) continue; // 这份源里没有同名记号 ⇒ 与本动作无关
    if (!handlers.kojoReferences) {
      // 判据缺席 ⇒ 无从知道这些记号是不是函数引用。改了 .erb 却漏了生成它的 .kojo 源
      // = 下次保存把改名冲掉（数据损坏），不改只是这一批不走 —— 只能拒绝。
      unprovable.push({ label: unprovableFileLabel(filePath, positions.length, '引用判读未接入') });
      continue;
    }
    const first = positions[0]!;
    let locations: readonly EditorSymbolLocation[];
    try {
      locations = await handlers.kojoReferences({ filePath, text, line: first.line, column: first.column });
    } catch (e: unknown) {
      // 判读抛错 ≠ 判官答"这些记号不是函数引用"（那必须是**正常返回空集**）。
      // 抛错就是没判 ⇒ 静默不收这批 = 只改 .erb、下次保存被冲掉 ⇒ 同样整批拒绝。
      unprovable.push({
        label: unprovableFileLabel(filePath, positions.length, `判读抛错：${errorText(e)}`),
      });
      continue;
    }
    // 只收本文件的判读结果（糖线引用面是文件局部的，规范 §7.2；越界一律不收，不猜）
    for (const location of locations) {
      if (location.filePath !== filePath) continue;
      const span = occurrencesFromLocations([location], normalizedName.length);
      if (span.length > 0) occurrences.push(...span);
    }
  }
  return { occurrences, unprovable };
}

/** live model 上的现文本验证：该列区间现在是不是这个名字（大小写不敏感；越界 = 不匹配） */
function liveRefMatches(
  model: Monaco.editor.ITextModel,
  ref: RenameSpan,
  normalizedName: string,
): boolean {
  if (ref.line < 1 || ref.line > model.getLineCount()) return false;
  const line = model.getLineContent(ref.line);
  const at = ref.column - 1;
  const end = ref.endColumn - 1;
  if (at < 0 || end > line.length || at > end) return false;
  return line.slice(at, end).toUpperCase() === normalizedName;
}

/**
 * 未打开文件的落盘通道**唯一实现**（内核 io 读改写：保编码保换行 + 原子写 + 备份）。
 *
 * 与搜索面板「全部替换」共用 `rewriteClosedFile` 的同一条纪律（先闸写权限、在现文本上
 * 验证、有实改才写回），所以 rename 与替换不可能在"怎么落盘"上分叉——
 * 宿主接线只需 `applyToClosedFile: createApplyToClosedFile(kernel.io)`。
 */
export function createApplyToClosedFile(io: ClosedFileIo): ErbRenameHandlers['applyToClosedFile'] {
  return (path, spans, newName, normalizedName) =>
    rewriteClosedFile(io, path, (text) => applyReferenceEdits(text, spans, newName, normalizedName));
}

/**
 * 对 `ERB_LANGUAGE_ID` 注册 RenameProvider。全部决策在纯函数与 handlers，
 * 本函数只做 Monaco 类型翻译与隔离（任何抛错都退成 reject 理由，不让 F2 崩编辑器）。
 */
export function installErbRename(monaco: typeof Monaco, handlers: ErbRenameHandlers): Monaco.IDisposable {
  const provider: Monaco.languages.RenameProvider = {
    // 索引未建 ⇒ `undefined`（Monaco 走缺省词回退，不弹错）；名字不认 ⇒ 带理由拒绝
    resolveRenameLocation(model, position) {
      if (!handlers.canAnswer(model)) return undefined;
      const index = handlers.currentIndex();
      if (!index) return undefined;
      const lineText = model.getLineContent(position.lineNumber);
      const target = resolveRenameTarget(lineText, position.column, index.byName);
      if (target.kind === 'reject') {
        return {
          range: {
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          },
          text: '',
          rejectReason: target.reason,
        };
      }
      return {
        range: {
          startLineNumber: position.lineNumber,
          startColumn: target.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: target.endColumn,
        },
        text: lineText.slice(target.startColumn - 1, target.endColumn - 1),
      };
    },

    async provideRenameEdits(model, position, newName) {
      try {
        return await provideEdits(model, position, newName);
      } catch (e: unknown) {
        console.warn(`[erb-rename] 落地失败：${errorText(e)}`);
        return reject(`重命名落地失败：${errorText(e)}`);
      }
    },
  };

  async function provideEdits(
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
    newName: string,
  ): Promise<Monaco.languages.WorkspaceEdit & Monaco.languages.Rejection> {
    if (!handlers.canAnswer(model)) {
      return reject('当前视图不参与重命名（请在原文视图内按 F2）');
    }
    const index = handlers.currentIndex();
    if (!index) return reject('ERB 函数索引未建，暂不可重命名');
    const lineText = model.getLineContent(position.lineNumber);
    const target = resolveRenameTarget(lineText, position.column, index.byName);
    if (target.kind === 'reject') return reject(target.reason);
    const refs = handlers.referencesTo(target.normalizedName);
    if (!refs || refs.length === 0) {
      return reject('反向引用索引缺席，无法全项目收集引用（不猜，不部分改）');
    }
    // ---- 跨语言腿：`.kojo` 源里的同名记号（判读在糖线，送达在这一批） ----
    const kojo = await collectKojoLeg(monaco, handlers, target.normalizedName);
    if (kojo.unprovable.length > 0) {
      return reject(
        `${target.normalizedName} 的改名需要连带 .kojo 源，但 ${kojo.unprovable.length} 项 .kojo 侧判据缺席：` +
          kojo.unprovable.map((u) => u.label).join('、') +
          '。无法证明这些记号是否指向本函数——' +
          '只改 .erb 会被下一次保存 .kojo 冲掉，故整次重命名取消（不静默改一半）。' +
          '请先在对应 .kojo 源内改名，或由宿主接入 ui.editor.languageService 的引用判读',
      );
    }
    // ---- 两种语言的出现点并成一份台账 → 一份写计划（分组 + 只读闸门只有一份实现） ----
    const ledger = mergeOccurrences([erbOccurrences(refs), kojo.occurrences]);
    const plan = planReferenceWrites(ledger, handlers.isWritable);
    if (plan.readOnlyFiles.length > 0) {
      return reject(readOnlyFilesReason(plan.readOnlyFiles.length, '重命名'));
    }
    const edits: Monaco.languages.IWorkspaceTextEdit[] = [];
    /** io 写入失败的落点（逐文件可见，同「全部替换」执行器的口径） */
    const writeFailures: string[] = [];
    /** 已经落到盘上的闭文件数（>0 ⇒ 绝不能再返回 rejectReason，见下方取证） */
    let landedFiles = 0;
    /** 非调用形 mention（散文）跳过计数——两通道各自计数，汇总出声一次 */
    let proseSkipped = 0;
    for (const group of plan.writable) {
      const open = handlers.openModelFor(group.path);
      if (!open) {
        try {
          const { applied, stale, skippedProse } = await handlers.applyToClosedFile(
            group.path,
            group.occurrences,
            newName,
            target.normalizedName,
          );
          if (applied > 0) landedFiles++;
          proseSkipped += skippedProse ?? 0;
          if (stale > 0) {
            console.warn(`[erb-rename] '${group.path}' 有 ${stale} 处引用因索引陈旧跳过（实改 ${applied} 处）`);
          }
        } catch (e: unknown) {
          // 写允许域 / io 故障：这一份没落（rewriteClosedFile 只在有实改时写），其余继续
          writeFailures.push(`'${group.path}'：${errorText(e)}`);
        }
        continue;
      }
      // 已打开：按 live model 的现文本逐处验证（索引与现场无锁，陈旧坐标绝不硬写）
      for (const ref of group.occurrences) {
        if (!liveRefMatches(open, ref, target.normalizedName)) continue;
        // ERB 词法 mention 的落盘判据（isCallShapedMention 单源，**只拦 erb 侧**）：调用形照改，
        // 散文形跳过——与闭文件通道同一条判据；kojo 腿的 mention 是探针证明的真引用，不拦
        if (
          ref.kind === 'mention' &&
          ref.language === 'erb' &&
          !isCallShapedMention(open.getLineContent(ref.line) ?? '', ref.endColumn)
        ) {
          proseSkipped++;
          continue;
        }
        edits.push({
          // resource 必须取自**解析到的那份 live model**（先例：`find-references.ts` 用
          // `live.uri`、`kojo-rename.ts` 用 `model.uri`）。`Uri.file(group.path)` 用的是索引
          // 拼写：盘符大小写/分隔符与标签建立时那份不一致时，`Uri.file` 只归一分隔符、
          // 保留大小写，URI 字符串就与注册表里的 model 对不上 ⇒ WorkspaceEdit 落到一个
          // 没有 model 的 resource（standalone 直接抛 `model not found`）——已开标签静默漏改。
          resource: open.uri,
          versionId: undefined,
          textEdit: {
            range: {
              startLineNumber: ref.line,
              startColumn: ref.column,
              endLineNumber: ref.line,
              endColumn: ref.endColumn,
            },
            text: newName,
          },
        });
      }
    }
    // ---- 全或无的**最后一道**：rejectReason 与已落盘的编辑永不同时出现 ----
    // monaco 0.57 standalone 的 rename 控制器见 rejectReason 会**丢弃全部 WorkspaceEdit**
    // （`rename.js:241`）。若此时已有闭文件写过盘，丢弃 = 盘上半套 + 标签没改，
    // 作者拿到的是名字分叉的半成品还不自知。所以：
    //  - 一处盘上改动都没发生 ⇒ 拒绝（真全或无，编辑集本来也没落地）；
    //  - 已有改动落盘 ⇒ 不再拒绝，把已算好的 WorkspaceEdit 交付（补齐这一批能补的全部落点），
    //    失败文件逐个 warn——少改这一处的责任在 io/写允许域，不靠谎报"整次取消"来掩盖。
    if (writeFailures.length > 0 && landedFiles === 0) {
      return reject(
        `未打开文件写入失败（${writeFailures.length} 个）：${writeFailures.join('；')}。` +
          '整次重命名取消——没有任何落点被改动（不静默改一半）',
      );
    }
    if (writeFailures.length > 0) {
      console.warn(
        `[erb-rename] 已有 ${landedFiles} 个闭文件落盘，剩余 ${writeFailures.length} 个写入失败（不再整批取消，避免半成品分叉）：` +
          writeFailures.join('；'),
      );
    }
    if (proseSkipped > 0) {
      console.warn(
        `[erb-rename] '${target.normalizedName}'：${proseSkipped} 处 ERB 词法 mention 非调用形（名字后无 "("），按「改名不重写散文」跳过`,
      );
    }
    return { edits };
  }

  const sub = monaco.languages.registerRenameProvider(ERB_LANGUAGE_ID, provider);
  return { dispose: () => sub.dispose() };
}
