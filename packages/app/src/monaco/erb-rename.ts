import type * as Monaco from './entry';
import type { ErbIndex, ErbReference } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from './erb-language';

/**
 * ERB 函数重命名（F2 / `editor.action.rename`）——**全项目引用一次改齐**，宿主层接线。
 *
 * ## 数据源（零猜测）
 *
 * - 可重命名判定：光标词 → 归一化大写 → `ErbIndex.byName.has` 命中才算数。
 *   索引里没有的名字（`$` 标签、`#DIM` 局部名、拼错词）一律 reject，**不猜**；
 *   索引未建 ⇒ `resolveRenameLocation` 返回 `undefined`（Monaco 走缺省词回退，
 *   不会报错）。
 * - 编辑收集：`referencesTo(归一化名)`——定义点与引用点全集（契约含 `definition`，
 *   rename 必须连定义一起改），按文件分组。
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
 *
 * ## 写权限收口（铁律 6：不静默）
 *
 * 可写判定 = `kernel.io.isWritable`（与保存按钮/直连编辑同源口径）。只读文件剔除，
 * 且**只要有一份只读 ⇒ 整次重命名取消**、`rejectReason` 明示「n 个文件只读未纳入」。
 * 为什么不做"可写的先改一半"：monaco 0.57 的 rename 控制器见到返回值带 `rejectReason`
 * 会**丢弃全部编辑只弹 info**（`rename.js:241`），没有"部分应用 + 提示"的通道——
 * 硬走部分应用就只能静默少改，让作者拿到一套名字分叉的半成品还不自知。宁可全或无。
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
 * monaco 语义取证）。
 */
export function planRenameEdits(
  refs: readonly ErbReference[],
  isWritable: (path: string) => boolean,
): RenamePlan {
  const groups = new Map<string, ErbReference[]>();
  const readOnly = new Set<string>();
  for (const ref of refs) {
    if (!isWritable(ref.filePath)) {
      readOnly.add(ref.filePath);
      continue;
    }
    let list = groups.get(ref.filePath);
    if (!list) {
      list = [];
      groups.set(ref.filePath, list);
    }
    list.push(ref);
  }
  return {
    writable: [...groups].map(([path, list]) => ({ path, refs: list })),
    readOnlyCount: readOnly.size,
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
}

/**
 * 把引用点列区间改写进整篇文本（**纯函数**；闭文件 io 通道与单测共用）。
 *
 * 每处引用先验证：该区间上的现文本 == 原名（大小写不敏感，与索引归一口径一致）；
 * 不匹配 ⇒ 跳过并计 `stale`（陈旧索引绝不做哑替换）。文件整体只读/写失败由调用方
 * （内核 io）兜住，本函数不碰磁盘。
 */
export function applyReferenceEdits(
  text: string,
  refs: readonly ErbReference[],
  newName: string,
  normalizedName: string,
): AppliedReferenceEdits {
  const starts = lineStartOffsets(text);
  const lineCount = starts.length;
  // 绝对偏移降序替换：前面的偏移才不会因替换而位移
  const ops: Array<{ at: number; end: number }> = [];
  let stale = 0;
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
    ops.push({ at, end });
  }
  ops.sort((a, b) => b.at - a.at);
  let next = text;
  for (const op of ops) {
    next = next.slice(0, op.at) + newName + next.slice(op.end);
  }
  return { text: next, applied: ops.length, stale };
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
   */
  applyToClosedFile(
    path: string,
    refs: readonly ErbReference[],
    newName: string,
    normalizedName: string,
  ): Promise<{ applied: number; stale: number }>;
}

function reject(reason: string): Monaco.languages.WorkspaceEdit & Monaco.languages.Rejection {
  return { edits: [], rejectReason: reason };
}

/** live model 上的现文本验证：该列区间现在是不是这个名字（大小写不敏感；越界 = 不匹配） */
function liveRefMatches(
  model: Monaco.editor.ITextModel,
  ref: ErbReference,
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
        console.warn(`[erb-rename] 落地失败：${e instanceof Error ? e.message : String(e)}`);
        return reject(`重命名落地失败：${e instanceof Error ? e.message : String(e)}`);
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
    const plan = planRenameEdits(refs, handlers.isWritable);
    if (plan.readOnlyCount > 0) {
      return reject(
        `${plan.readOnlyCount} 个文件只读未纳入，整次重命名取消（部分改名会造成同名分叉）；` +
          '解锁对应目录后重试',
      );
    }
    const edits: Monaco.languages.IWorkspaceTextEdit[] = [];
    for (const group of plan.writable) {
      const open = handlers.openModelFor(group.path);
      if (!open) {
        const { applied, stale } = await handlers.applyToClosedFile(
          group.path,
          group.refs,
          newName,
          target.normalizedName,
        );
        if (stale > 0) {
          console.warn(`[erb-rename] '${group.path}' 有 ${stale} 处引用因索引陈旧跳过（实改 ${applied} 处）`);
        }
        continue;
      }
      // 已打开：按 live model 的现文本逐处验证（索引与现场无锁，陈旧坐标绝不硬写）
      for (const ref of group.refs) {
        if (!liveRefMatches(open, ref, target.normalizedName)) continue;
        edits.push({
          resource: monaco.Uri.file(group.path),
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
    return { edits };
  }

  const sub = monaco.languages.registerRenameProvider(ERB_LANGUAGE_ID, provider);
  return { dispose: () => sub.dispose() };
}
