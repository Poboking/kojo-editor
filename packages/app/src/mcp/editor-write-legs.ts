/**
 * `editor.*` 具名工具的执行腿 —— 编辑器**写 / 光标副作用**（LaneO B3 批，2026-11-06）。
 *
 * 判性（为什么这五枚现在能登记）：本期队列里「编辑器写 / 光标副作用」这一类缺口的真源
 * **早已存在且已被调试面实现并测过**——`debug/install-debug.ts` 的 `editor.setValue / type /
 * setCursor / setSelection / revealLine`。本模块**不另造一套语义**，只把同一批实现腿接到 MCP 面：
 * - 内容写：`applySetValue`（model 层整篇替换 + **回读核对**）、`applyTypedEdit`
 *   （光标处 `executeEdits` + 回读核对）——两者都拿 `editApplied` 判「值真的变了」，
 *   「报成功但值没变」与只读改不动都如实 `false`（ED-HONESTY 批修掉的正是那记假绿）；
 * - 入参归一：`normalizeCursorTarget`（1 基、脏值即 `null`，**绝不**把未归一的值喂进 `setPosition`）；
 * - 只读判据：`editorReadOnly`（读公开面 `getRawOptions().readOnly`，读不到 ⇒ `false` 不编造）。
 *
 * 与调试面的**两处刻意差别**（都是「MCP 面语义」要求的，不是重写实现）：
 * 1. **不许用焦点**。调试面绑 `focusedCtx()`（「当前聚焦的那个编辑器」），MCP 是多会话、
 *    可无头的通道，「当前聚焦」语义不明 ⇒ 本面一律按 `paneId` 显式反查 `livePanes`。
 *    缺 pane / 编辑器不在场 ⇒ 显式 `NOT_WIRED`（`[E_EDITOR_PANE_GONE]`），绝不悄悄落到别的 pane。
 * 2. **只读即拒绝**。调试面 `setValue` 走 model 层，实测只读项目下仍会改正文，所以它如实回
 *    `true` 并把「要不要改」交给调用方读 `info().readOnly`；MCP 是外部 AI 的通道，
 *    「只读项目里把正文改了」不是可接受的副作用 ⇒ `editorReadOnly===true` 时内容写两枚
 *    （`setValue` / `type`）**先显式拒绝**（`PERMISSION_DENIED` + `[E_EDITOR_READ_ONLY]`），
 *    不回 `applied:true`。光标 / 视口三枚（`setCursor` / `setSelection` / `revealLine`）不动正文，
 *    只读态照常可执行（与 Monaco 自身语义一致），回报里带 `readOnly` 读数即可。
 *
 * 诚实回报（铁律 4）：每次成功都回 `{applied:true, dirty:<模型脏态>, saved:false}`——
 * **本腿只改 Monaco 模型，磁盘一个字节都没动**（落盘仍是 `fileTree.update` + 第四张表
 * `approvedRoots` × 内核 `writablePaths` 双闸那条唯一法定通道；铁律 5/6/7：**零新增写盘通道**）。
 * 脏态读不到（假件 / 老版本没有 `isDirty`）⇒ `dirty:null` + `dirtyReason`，不编造 `false`。
 * 回读核对失败 ⇒ 显式 `[E_EDITOR_APPLY_UNVERIFIED]`，不冒充成功。
 *
 * 档位：五枚全 `edit`。内容写自不必说；光标与视口副作用也按 edit 收口——它们改的是**用户
 * 可见的编辑器状态**，一个 read 会话不该能把作者的光标挪走（端点侧点名见 Rust `EDIT_TOOLS_EXACT`）。
 *
 * ps10 纪律：`ui/*`（`livePanes` 登记簿）只在**执行时**动态 import（与 `quick-fix.ts` 同款）。
 * `install-debug.ts` 的四个纯函数是值导入——本模块唯一的消费者链路（`real-sources-io.ts` →
 * `real-sources.ts`）本身就在 `ShellLayout` 的动态边之下，而 `install-debug` 自己也只经
 * `main.tsx` 的 `?kojo-debug=1` 动态边装载，**开机静态图一分钱不涨**。
 */
import { McpFailure } from '@kojo/mcp-host';
import type { McpReaderFn } from '@kojo/mcp-host';
import {
  applySetValue,
  applyTypedEdit,
  editorReadOnly,
  normalizeCursorTarget,
} from '../debug/install-debug';
import type { DebugEditEditorLike, DebugEditModelLike } from '../debug/install-debug';

/* ------------------------------- pane 反查 seam ------------------------------- */

/** 归属 pane 的最窄投影：编辑器 + 该 pane 正在显示的糖投影 model（派生视图闸）+ 路径读数。 */
export interface EditorWritePaneHandle {
  readonly editor: unknown;
  /** 该实例**当前**显示的糖投影 model（与 `editor.getModel()` 同一对象即派生视图）；无投影 ⇒ null。 */
  readonly sugarModel: unknown;
  /** pane 当前文件路径（只作回报读数；读不到 ⇒ null，不拿来当判据）。 */
  readonly path: string | null;
}

export type EditorWritePaneResolver = (
  paneId: string,
) => Promise<EditorWritePaneHandle | null> | EditorWritePaneHandle | null;

export interface McpEditorWriteDeps {
  /** pane 反查 seam（测试注入假件；生产缺省动态 import `livePanes`）。 */
  readonly getEditorPane?: EditorWritePaneResolver;
}

/* ------------------------------- 结构面（真 Monaco 与假件都满足） ------------------------------- */

interface EditorPosition {
  readonly line: number;
  readonly column: number;
}

interface EditorRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** 只读读数（真源同一个 `editorReadOnly` 腿：读不到 ⇒ `false`，不编造只读）。 */
function readOnlyOf(editor: unknown): boolean {
  return editorReadOnly(editor as Parameters<typeof editorReadOnly>[0]);
}

/** 从 `unknown` 编辑器上安全取 model（拿不到 ⇒ null，调用方显式拒绝）。 */
function modelOf(editor: unknown): DebugEditModelLike | null {
  const getter = (editor as { getModel?: () => unknown } | null)?.getModel;
  if (typeof getter !== 'function') return null;
  const model = getter.call(editor);
  return model && typeof model === 'object' ? (model as DebugEditModelLike) : null;
}

function lineCountOf(model: DebugEditModelLike): number | null {
  const fn = (model as unknown as { getLineCount?: () => unknown }).getLineCount;
  if (typeof fn !== 'function') return null;
  const n = fn.call(model);
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

function maxColumnOf(model: DebugEditModelLike, line: number): number | null {
  const fn = (model as unknown as { getLineMaxColumn?: (l: number) => unknown }).getLineMaxColumn;
  if (typeof fn !== 'function') return null;
  const n = fn.call(model, line);
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

function positionOf(editor: unknown): EditorPosition | null {
  const fn = (editor as { getPosition?: () => unknown } | null)?.getPosition;
  if (typeof fn !== 'function') return null;
  const p = fn.call(editor) as { lineNumber?: unknown; column?: unknown } | null;
  if (!p || typeof p.lineNumber !== 'number' || typeof p.column !== 'number') return null;
  return { line: p.lineNumber, column: p.column };
}

function rangeOf(editor: unknown): EditorRange | null {
  const fn = (editor as { getSelection?: () => unknown } | null)?.getSelection;
  if (typeof fn !== 'function') return null;
  const r = fn.call(editor) as Record<string, unknown> | null;
  if (!r) return null;
  const keys = ['startLineNumber', 'startColumn', 'endLineNumber', 'endColumn'] as const;
  const nums = keys.map((k) => r[k]);
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return {
    startLine: nums[0] as number,
    startColumn: nums[1] as number,
    endLine: nums[2] as number,
    endColumn: nums[3] as number,
  };
}

/** 模型脏态（回报读数）：读不到 ⇒ `null` + 如实理由，绝不编造「不脏」。 */
function dirtyOf(model: DebugEditModelLike | null): { dirty: boolean | null; dirtyReason?: string } {
  if (!model) return { dirty: null, dirtyReason: '编辑器当前没有 model，脏态无从可取' };
  const fn = (model as unknown as { isDirty?: () => unknown }).isDirty;
  if (typeof fn !== 'function') return { dirty: null, dirtyReason: '当前 model 未提供 isDirty 读数，不编造脏态' };
  try {
    const v = fn.call(model);
    if (typeof v === 'boolean') return { dirty: v };
    return { dirty: null, dirtyReason: `isDirty 读数不是布尔（${String(v)}），不编造脏态` };
  } catch (err: unknown) {
    return { dirty: null, dirtyReason: `isDirty 读数抛错：${err instanceof Error ? err.message : String(err)}` };
  }
}

function versionOf(model: DebugEditModelLike | null): number | null {
  if (!model) return null;
  const fn = (model as unknown as { getVersionId?: () => unknown }).getVersionId;
  if (typeof fn !== 'function') return null;
  try {
    const v = fn.call(model);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function valueLength(model: DebugEditModelLike | null): number | null {
  if (!model) return null;
  try {
    return model.getValue().length;
  } catch {
    return null;
  }
}

/* ------------------------------- 入参闸（1 基，脏值即拒） ------------------------------- */

/** paneId：必填、非空、限长（回显净化：脏字节不原样打回调用方）。 */
function requirePaneId(args: Record<string, unknown>): string {
  const raw = args['paneId'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new McpFailure(
      'INVALID_ARGS',
      '[E_EDITOR_INVALID_ARGS] 缺 paneId：本面按 paneId 显式反查编辑器实例（MCP 面没有「当前聚焦」这个语义），必须原样携带 document.active / editor.info 报回的 paneId。',
    );
  }
  const paneId = raw.trim();
  if (paneId.length > 128) {
    throw new McpFailure('INVALID_ARGS', `[E_EDITOR_INVALID_ARGS] paneId 过长（${paneId.length} > 128）`);
  }
  return paneId;
}

/** 1 基正整数入参（小数 / 0 / 负数 / NaN / 字符串一律显式拒，不静默夹取到隔壁）。 */
function requirePositiveInt(args: Record<string, unknown>, key: string, tool: string): number {
  const raw = args[key];
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new McpFailure(
      'INVALID_ARGS',
      `[E_EDITOR_INVALID_ARGS] ${tool} 的 ${key} 须为 1 基正整数（收到 ${JSON.stringify(raw) ?? 'undefined'}）：0 基 / 小数 / 脏值都拒绝，不静默夹到别处。`,
    );
  }
  return raw;
}

function requireText(args: Record<string, unknown>, key: string, tool: string, max: number): string {
  const raw = args[key];
  if (typeof raw !== 'string') {
    throw new McpFailure('INVALID_ARGS', `[E_EDITOR_INVALID_ARGS] ${tool} 的 ${key} 须为字符串`);
  }
  if (raw.length > max) {
    throw new McpFailure(
      'INVALID_ARGS',
      `[E_EDITOR_INVALID_ARGS] ${tool} 的 ${key} 过长（${raw.length} > ${max}）：本面不夹带截断，请分段或走 fileTree.update 落盘通道。`,
    );
  }
  return raw;
}

/** 派生视图（糖投影）闸：投影上改一个字节不等于改源文件，与 quickFix 同一判据。 */
function assertNotDerivedView(handle: EditorWritePaneHandle, paneId: string): void {
  if (handle.sugarModel === null || handle.sugarModel === undefined) return;
  const model = modelOf(handle.editor);
  if (!model || model !== (handle.sugarModel as DebugEditModelLike)) return;
  throw new McpFailure(
    'NOT_WIRED',
    `[E_EDITOR_DERIVED_VIEW] 实例 ${paneId} 当前显示的是糖投影（派生视图）model：在投影上写正文不等于写源文件，MCP 面不开放（显式缺口，不假成功）。`,
  );
}

/** 只读闸（仅内容写两枚）：只读项目下改正文不是本面开放的副作用。 */
function assertWritable(handle: EditorWritePaneHandle, paneId: string, tool: string): void {
  if (!readOnlyOf(handle.editor)) return;
  throw new McpFailure(
    'PERMISSION_DENIED',
    `[E_EDITOR_READ_ONLY] 实例 ${paneId} 的编辑器是只读态（getRawOptions().readOnly===true）：${tool} 会改正文，MCP 面在只读里显式拒绝，不返回 applied:true 冒充改动了。要编辑请先在宿主里解除只读。`,
  );
}

/** 统一的「成功」回包骨架：诚实标注不落盘 + 脏态 + 撤销语义（每次调用都带，不是可选字段）。 */
function successReport(input: {
  tool: string;
  paneId: string;
  path: string | null;
  model: DebugEditModelLike | null;
  readOnly: boolean;
  undo: string;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const { dirty, dirtyReason } = dirtyOf(input.model);
  return {
    applied: true,
    tool: input.tool,
    paneId: input.paneId,
    path: input.path,
    readOnly: input.readOnly,
    dirty,
    ...(dirtyReason ? { dirtyReason } : {}),
    /** 磁盘写没发生：本腿只改 Monaco 模型（铁律 5/6/7 零新增写盘通道）。 */
    saved: false,
    persisted: false,
    persistNote:
      '本工具只改编辑器模型，磁盘未写入。落盘请走 fileTree.update（第四张表 approvedRoots × 内核 writablePaths 双闸）或宿主保存/导出面。',
    undo: input.undo,
    ...input.extra,
  };
}

/* ------------------------------- 生产 pane 反查（动态 import，ps10 纪律） ------------------------------- */

interface EditorWritePaneCtxLike {
  editorRef: { current: unknown };
  sugarModelRef: { current: unknown };
  filePathRef: { current: string };
}

let livePanesPromise: Promise<Map<string, EditorWritePaneCtxLike> | null> | null = null;

function loadLivePanes(): Promise<Map<string, EditorWritePaneCtxLike> | null> {
  livePanesPromise ??= (async () => {
    try {
      const mod = await import('../ui/editor-pane-registry');
      return mod.livePanes as unknown as Map<string, EditorWritePaneCtxLike>;
    } catch {
      return null;
    }
  })();
  return livePanesPromise;
}

/** 生产 pane 反查：`livePanes`（模块级登记簿）按 id 取那一份**同一 ref 壳**里的编辑器。 */
export async function productionResolveEditorPane(paneId: string): Promise<EditorWritePaneHandle | null> {
  const panes = await loadLivePanes();
  if (!panes) return null;
  const ctx = panes.get(paneId);
  if (!ctx) return null;
  const editor = ctx.editorRef.current;
  if (!editor) return null;
  return {
    editor,
    sugarModel: ctx.sugarModelRef?.current ?? null,
    path: typeof ctx.filePathRef?.current === 'string' && ctx.filePathRef.current !== '' ? ctx.filePathRef.current : null,
  };
}

/* ------------------------------- 五枚执行腿 ------------------------------- */

async function resolveHandle(
  deps: McpEditorWriteDeps,
  paneId: string,
  tool: string,
): Promise<EditorWritePaneHandle> {
  const resolve = deps.getEditorPane ?? productionResolveEditorPane;
  const handle = await resolve(paneId);
  if (!handle || !handle.editor) {
    throw new McpFailure(
      'NOT_WIRED',
      `[E_EDITOR_PANE_GONE] 实例 ${paneId} 不在册或编辑器不在场：${tool} 只认显式 paneId（MCP 面没有「当前聚焦」兜底，不迁移到别的 pane、不伪造成功）。`,
    );
  }
  const model = modelOf(handle.editor);
  if (!model) {
    throw new McpFailure(
      'NOT_WIRED',
      `[E_EDITOR_PANE_GONE] 实例 ${paneId} 当前没有 model（未开文件 / 已关标签）：${tool} 无从落点，显式拒绝（不静默）。`,
    );
  }
  return handle;
}

/** `editor.setValue` —— 整篇替换（真源 = `applySetValue`，model 层 + 回读核对）。 */
export function createEditorSetValueLeg(deps: McpEditorWriteDeps = {}): McpReaderFn {
  return async (args: Record<string, unknown>): Promise<unknown> => {
    const paneId = requirePaneId(args);
    const text = requireText(args, 'text', 'editor.setValue', 4_000_000);
    const handle = await resolveHandle(deps, paneId, 'editor.setValue');
    assertNotDerivedView(handle, paneId);
    assertWritable(handle, paneId, 'editor.setValue');
    const model = modelOf(handle.editor);
    if (!model) {
      throw new McpFailure('NOT_WIRED', `[E_EDITOR_PANE_GONE] 实例 ${paneId} 的 model 在取用瞬间消失：不冒充成功。`);
    }
    const lengthBefore = valueLength(model);
    const versionBefore = versionOf(model);
    let applied: boolean;
    try {
      applied = applySetValue(model, text);
    } catch (err: unknown) {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        `[E_EDITOR_APPLY_FAILED] editor.setValue 抛错：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!applied) {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        '[E_EDITOR_APPLY_UNVERIFIED] editor.setValue 回读核对未通过（值没变）：要么给的 text 与当前正文逐字相同（没有可核对的变化），要么 model 拒收。不拿 true 冒充「我改了」。',
      );
    }
    const readOnly = readOnlyOf(handle.editor);
    return successReport({
      tool: 'editor.setValue',
      paneId,
      path: handle.path,
      model,
      readOnly,
      undo: 'model.setValue 不进撤销栈（与调试面同一判据，见 install-debug.ts applyTypedEdit 注释）：要「可一步退回」的改法用 editor.type。',
      extra: {
        charLengthBefore: lengthBefore,
        charLengthAfter: valueLength(model),
        versionBefore,
        versionAfter: versionOf(model),
        lineCount: lineCountOf(model),
      },
    });
  };
}

/** `editor.type` —— 光标处插入（真源 = `applyTypedEdit`，executeEdits + 回读核对）。 */
export function createEditorTypeLeg(deps: McpEditorWriteDeps = {}): McpReaderFn {
  return async (args: Record<string, unknown>): Promise<unknown> => {
    const paneId = requirePaneId(args);
    const text = requireText(args, 'text', 'editor.type', 200_000);
    const handle = await resolveHandle(deps, paneId, 'editor.type');
    assertNotDerivedView(handle, paneId);
    assertWritable(handle, paneId, 'editor.type');
    const model = modelOf(handle.editor);
    if (!model) {
      throw new McpFailure('NOT_WIRED', `[E_EDITOR_PANE_GONE] 实例 ${paneId} 的 model 在取用瞬间消失：不冒充成功。`);
    }
    const from = positionOf(handle.editor);
    const lengthBefore = valueLength(model);
    const versionBefore = versionOf(model);
    let applied: boolean;
    try {
      applied = applyTypedEdit(handle.editor as DebugEditEditorLike, text);
    } catch (err: unknown) {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        `[E_EDITOR_APPLY_FAILED] editor.type 抛错：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!applied) {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        '[E_EDITOR_APPLY_UNVERIFIED] editor.type 回读核对未通过：executeEdits 被拒（只读 / 无 model / 无光标）或正文没变（空串插入）。不拿 true 冒充插入过。',
      );
    }
    const readOnly = readOnlyOf(handle.editor);
    return successReport({
      tool: 'editor.type',
      paneId,
      path: handle.path,
      model,
      readOnly,
      undo: '单次 executeEdits（前后停点 = 一个撤销步，Ctrl+Z 一次退回）；本腿不落盘。',
      extra: {
        insertedChars: text.length,
        typedAt: from,
        cursor: positionOf(handle.editor),
        charLengthBefore: lengthBefore,
        charLengthAfter: valueLength(model),
        versionBefore,
        versionAfter: versionOf(model),
      },
    });
  };
}

/** `editor.setCursor` —— 光标定位（真源 = `normalizeCursorTarget` + `setPosition`）。 */
export function createEditorSetCursorLeg(deps: McpEditorWriteDeps = {}): McpReaderFn {
  return async (args: Record<string, unknown>): Promise<unknown> => {
    const paneId = requirePaneId(args);
    // 归一交给真源：脏值（0 基 / 小数 / NaN / 字符串）⇒ null ⇒ 显式 INVALID_ARGS，
    // 绝不把未归一的值喂进 setPosition（「看起来动了、实际停在隔壁」是这一族最难查的假绿）。
    const target = normalizeCursorTarget(
      args['line'] as number | undefined,
      args['column'] as number | undefined,
    );
    if (target === null) {
      const line = JSON.stringify(args['line'] ?? null);
      const column = args['column'] === undefined ? '（缺席 ⇒ 落行首 1）' : JSON.stringify(args['column']);
      throw new McpFailure(
        'INVALID_ARGS',
        `[E_EDITOR_INVALID_ARGS] editor.setCursor 的 line/column 须为 1 基正整数（收到 line=${line}, column=${column}）：脏值显式拒绝，不静默夹到别处。`,
      );
    }
    const handle = await resolveHandle(deps, paneId, 'editor.setCursor');
    const model = modelOf(handle.editor);
    const lineCount = lineCountOf(model ?? null);
    if (lineCount !== null && target.line > lineCount) {
      throw new McpFailure(
        'INVALID_ARGS',
        `[E_EDITOR_INVALID_ARGS] editor.setCursor 的行 ${target.line} 越过文档行数（lineCount=${lineCount}，1 基）：越界不夹取、不假装定位成功，请回读 editor.info 的 lineCount。`,
      );
    }
    const requested = { ...target };
    try {
      (handle.editor as { setPosition: (p: { lineNumber: number; column: number }) => void }).setPosition({
        lineNumber: target.line,
        column: target.column,
      });
    } catch (err: unknown) {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        `[E_EDITOR_APPLY_UNVERIFIED] editor.setCursor 的 setPosition 抛错（${err instanceof Error ? err.message : String(err)}）：光标是否真的过去了未知，不假装成功。`,
      );
    }
    const effective = positionOf(handle.editor);
    if (!effective) {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        '[E_EDITOR_APPLY_UNVERIFIED] editor.setCursor 事后取不到光标读数：无法核对光标是否真过去，不冒充 applied:true。',
      );
    }
    const clamped = effective.line !== requested.line || effective.column !== requested.column;
    const readOnly = readOnlyOf(handle.editor);
    return successReport({
      tool: 'editor.setCursor',
      paneId,
      path: handle.path,
      model: model ?? null,
      readOnly,
      undo: '光标移动不是文档编辑：不进撤销栈、不改正文；本腿不落盘。',
      extra: {
        requested,
        cursor: effective,
        clamped,
        ...(clamped
          ? { clampedReason: '编辑器把请求位置夹/移到了别处（Monaco 对越界列号自带夹取）：effective 才是真读数。' }
          : {}),
        contentChanged: false,
      },
    });
  };
}

/** `editor.setSelection` —— 选区设置（真源语义 = 1 基 + 按 lineCount / lineMaxColumn 夹取 + 回读）。 */
export function createEditorSetSelectionLeg(deps: McpEditorWriteDeps = {}): McpReaderFn {
  return async (args: Record<string, unknown>): Promise<unknown> => {
    const paneId = requirePaneId(args);
    const startLine = requirePositiveInt(args, 'startLine', 'editor.setSelection');
    const startColumn = requirePositiveInt(args, 'startColumn', 'editor.setSelection');
    const endLine = requirePositiveInt(args, 'endLine', 'editor.setSelection');
    const endColumn = requirePositiveInt(args, 'endColumn', 'editor.setSelection');
    if (endLine < startLine) {
      throw new McpFailure(
        'INVALID_ARGS',
        `[E_EDITOR_INVALID_ARGS] editor.setSelection 要求 endLine(${endLine}) >= startLine(${startLine})：反向选区不在本面契约里。`,
      );
    }
    const handle = await resolveHandle(deps, paneId, 'editor.setSelection');
    const model = modelOf(handle.editor)!; // resolveHandle 已保证 model 在场
    const lineCount = lineCountOf(model);
    if (lineCount === null) {
      throw new McpFailure('NOT_WIRED', '[E_EDITOR_UNSUPPORTED] 当前 model 未提供 getLineCount 读数：无法判断越界，不夹取、不假装成功。');
    }
    if (startLine > lineCount || endLine > lineCount) {
      throw new McpFailure(
        'INVALID_ARGS',
        `[E_EDITOR_INVALID_ARGS] editor.setSelection 的行越过文档（startLine=${startLine}, endLine=${endLine}, lineCount=${lineCount}）：行越界显式拒绝（列越界按 Monaco 语义夹到该行末尾并在回报里如实标 clamped）。`,
      );
    }
    const sl = startLine;
    const el = endLine;
    const scMax = maxColumnOf(model, sl);
    const ecMax = maxColumnOf(model, el);
    if (scMax === null || ecMax === null) {
      throw new McpFailure('NOT_WIRED', '[E_EDITOR_UNSUPPORTED] 当前 model 未提供 getLineMaxColumn 读数：列夹取无从判断，不假装成功。');
    }
    const sc = Math.min(startColumn, scMax);
    const ec = Math.min(endColumn, ecMax);
    const requested: EditorRange = { startLine, startColumn, endLine, endColumn };
    try {
      (handle.editor as { setSelection: (r: unknown) => void }).setSelection({
        startLineNumber: sl,
        startColumn: sc,
        endLineNumber: el,
        endColumn: ec,
      });
    } catch (err: unknown) {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        `[E_EDITOR_APPLY_UNVERIFIED] editor.setSelection 的 setSelection 抛错（${err instanceof Error ? err.message : String(err)}）：不假装选区已落下。`,
      );
    }
    const effective = rangeOf(handle.editor);
    if (!effective) {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        '[E_EDITOR_APPLY_UNVERIFIED] editor.setSelection 事后取不到 selection 读数：无法核对落点，不冒充 applied:true。',
      );
    }
    const clamped =
      effective.startLine !== requested.startLine ||
      effective.startColumn !== requested.startColumn ||
      effective.endLine !== requested.endLine ||
      effective.endColumn !== requested.endColumn;
    const readOnly = readOnlyOf(handle.editor);
    return successReport({
      tool: 'editor.setSelection',
      paneId,
      path: handle.path,
      model,
      readOnly,
      undo: '选区是编辑器状态，不是文档编辑：不进撤销栈、不改正文；本腿不落盘。',
      extra: {
        requested,
        selection: effective,
        clamped,
        selectionLength: selectionTextLength(model, effective),
        contentChanged: false,
      },
    });
  };
}

function selectionTextLength(model: DebugEditModelLike, r: EditorRange): number | null {
  const fn = (model as unknown as { getValueInRange?: (range: unknown) => unknown }).getValueInRange;
  if (typeof fn !== 'function') return null;
  try {
    const v = fn.call(model, {
      startLineNumber: r.startLine,
      startColumn: r.startColumn,
      endLineNumber: r.endLine,
      endColumn: r.endColumn,
    });
    return typeof v === 'string' ? v.length : null;
  } catch {
    return null;
  }
}

/** `editor.revealLine` —— 视口定位（真源语义 = 按 lineCount 夹取 + center/top/nearest 三变体）。 */
export function createEditorRevealLineLeg(deps: McpEditorWriteDeps = {}): McpReaderFn {
  return async (args: Record<string, unknown>): Promise<unknown> => {
    const paneId = requirePaneId(args);
    const line = requirePositiveInt(args, 'line', 'editor.revealLine');
    const revealRaw = args['reveal'];
    const reveal = revealRaw === undefined ? 'nearest' : revealRaw;
    if (reveal !== 'center' && reveal !== 'top' && reveal !== 'nearest') {
      throw new McpFailure(
        'INVALID_ARGS',
        `[E_EDITOR_INVALID_ARGS] editor.revealLine 的 reveal 只认 'center' | 'top' | 'nearest'（收到 ${JSON.stringify(revealRaw)}）：'bottom' 一类没有对应 Monaco API，不编造对齐。`,
      );
    }
    const handle = await resolveHandle(deps, paneId, 'editor.revealLine');
    const model = modelOf(handle.editor)!;
    const lineCount = lineCountOf(model);
    if (lineCount === null) {
      throw new McpFailure('NOT_WIRED', '[E_EDITOR_UNSUPPORTED] 当前 model 未提供 getLineCount 读数：越界无从判断，不夹取、不假装定位成功。');
    }
    const target = Math.min(line, lineCount);
    const ed = handle.editor as Record<string, unknown>;
    const call = (key: string): boolean => {
      const fn = ed[key];
      if (typeof fn !== 'function') return false;
      try {
        (fn as (l: number) => void).call(ed, target);
        return true;
      } catch {
        return false;
      }
    };
    // center / nearTop 是 Monaco 的两个定位变体；nearest 与兜底走 revealLine（最小滚动）。
    const ok = reveal === 'center' ? call('revealLineInCenter') : reveal === 'top' ? call('revealLineNearTop') : call('revealLine');
    if (!ok) {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        `[E_EDITOR_APPLY_UNVERIFIED] editor.revealLine 的 ${reveal === 'center' ? 'revealLineInCenter' : reveal === 'top' ? 'revealLineNearTop' : 'revealLine'} 未执行成功（方法缺席或抛错）：不假装视口已滚到那一行。`,
      );
    }
    const clamped = target !== line;
    const readOnly = readOnlyOf(handle.editor);
    return successReport({
      tool: 'editor.revealLine',
      paneId,
      path: handle.path,
      model,
      readOnly,
      undo: '视口滚动不是文档编辑：不进撤销栈、不改正文；本腿不落盘。',
      extra: {
        requestedLine: line,
        revealedLine: target,
        reveal,
        clamped,
        lineCount,
        contentChanged: false,
      },
    });
  };
}

/* ------------------------------- 组装（腿表名字必须与契约表逐字同） ------------------------------- */

export interface EditorWriteLegs {
  readonly editorSetValue: McpReaderFn;
  readonly editorType: McpReaderFn;
  readonly editorSetCursor: McpReaderFn;
  readonly editorSetSelection: McpReaderFn;
  readonly editorRevealLine: McpReaderFn;
}

export function createEditorWriteLegs(deps: McpEditorWriteDeps = {}): EditorWriteLegs {
  return {
    editorSetValue: createEditorSetValueLeg(deps),
    editorType: createEditorTypeLeg(deps),
    editorSetCursor: createEditorSetCursorLeg(deps),
    editorSetSelection: createEditorSetSelectionLeg(deps),
    editorRevealLine: createEditorRevealLineLeg(deps),
  };
}
