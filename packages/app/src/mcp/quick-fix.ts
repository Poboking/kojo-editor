/**
 * `problems.quickFix` —— 稳定 actionId 台账 + 宿主受控 apply 腿（Wave4 余项 ①）。
 *
 * BOARD 判据：不许假实现——稳定 `actionId` 与宿主受控 apply 通道**同批**落地。
 *
 * 真源（不另造一套 id）：宿主 `provideCodeActionsFor`（ui/editor-global-providers.ts）本就给
 * 每条动作签发 `${paneId}:${contributionId}#${seq}` 并把动作实例挂进该 pane 的
 * `pendingActionsRef`（超阈值整体清理、seq 单调不复用）；MCP 只读清单腿 `semantic.codeActionsAt`
 * 调的是**同一个 provider**，id 一直在回包 `command.arguments[0]` 里，只是旧投影把它丢掉了。
 * 本模块把两头接起来：
 * - `recordQuickFixTickets`：codeActionsAt 每次清单，给带 id 的条目记一张**有界台账**
 *   （id → 会话 + pane + 文档 URI + 文档版本 + 清单位置 + 标题），条目里没有 id（假 provider /
 *   非宿主命令形态）⇒ 不记，apply 时自然显式失败，不造假账；
 * - `createQuickFixApplyLeg`：受控 apply 链，逐闸显式拒绝（消息带 `[E_QUICKFIX_*]` 机器码字面）：
 *   ① 参数形状；② 台账未命中（未列过 / 已被有界清理）；③ 跨会话挪用；④ 位置与清单不符；
 *   ⑤ TTL 过期；⑥ pane 退册 / 编辑器缺席；⑦ 文档换页或版本前进（**文档一变旧 id 必失效**，
 *   编辑、撤销、重做都会推高 Monaco versionId）；⑧ 宿主反查表已清（actionId 不再挂任何动作）；
 *   ⑨ `run` 式意图（无 edits）⇒ 保持 NOT_WIRED——跑任意 EditorCommandContext 副作用
 *   （对话框 / 写盘）不是本批开放的通道，能力没接上的部分显式留着；
 *   ⑩ 糖投影（派生视图）⇒ NOT_WIRED，整行改写在投影上不等于改源文件；
 *   ⑪ edits 形状非法 ⇒ 整条拒绝（fail-closed，不夹带脏条目进编辑器）。
 *
 * apply 落点（铁律 5/6/7：**本腿不新建任何写通道**）：复用宿主既有
 * `applyTextEdits`（ui/editor-global-providers.ts）——Monaco **模型内**单次
 * `executeEdits` + 前后停点 = **一个撤销步**（Ctrl+Z 一次退回），文档面上可见脏，
 * **不落盘、不触 io、不 invoke**。要持久化走宿主既有保存/导出面，不在此列。
 *
 * ps10 纪律：ui/* 运行时（livePanes / applyTextEdits）只在 apply 时**动态 import**
 * （与 productionGetWorkspace / productionGetLegs 同款），本模块顶层零 Monaco/kernel 依赖。
 */
import { McpFailure } from '@kojo/mcp-host';
import type { McpReaderFn, McpSessionScope } from '@kojo/mcp-host';

/* ------------------------------- 台账（有界 + 过期） ------------------------------- */

/** 一条清单位次换来的可执行凭据（宿主 pendingActions 反查表的 MCP 侧登记）。 */
export interface QuickFixTicket {
  readonly actionId: string;
  readonly sessionId: string;
  readonly paneId: string;
  readonly uri: string;
  /** 清单时文档版本；model 不支持版本读数时为 null（apply 侧降级为「不可核验」并显式说明）。 */
  readonly versionId: number | null;
  readonly line: number;
  readonly column: number;
  readonly title: string;
  readonly at: number;
}

/** 台账上限：30 条/次清单 × 若干轮；超出按最旧先清（去向：清掉的 id 再 apply 必显式失败）。 */
const TICKET_LIMIT = 300;
const TICKET_TTL_MS = 10 * 60_000;

const tickets = new Map<string, QuickFixTicket>();

/** 宿主签发形态 `pane-N:…#seq` 才算可执行 id（假 provider 的野路子 id 不进台账，不造假账）。 */
function hostActionIdParts(actionId: string): string | null {
  if (!/^pane-\d+:.*#\d+$/.test(actionId)) return null;
  return actionId.slice(0, actionId.indexOf(':'));
}

function pruneTickets(now: number): void {
  for (const [id, t] of tickets) {
    if (now - t.at > TICKET_TTL_MS) tickets.delete(id);
  }
  if (tickets.size <= TICKET_LIMIT) return;
  const stale = [...tickets.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [id] of stale.slice(0, tickets.size - TICKET_LIMIT)) tickets.delete(id);
}

export interface QuickFixRecordInput {
  readonly sessionId: string;
  readonly uri: string;
  readonly versionId: number | null;
  readonly line: number;
  readonly column: number;
  /** codeActionsAt 的投影条目（含 actionId 的才记账）。 */
  readonly items: readonly Record<string, unknown>[];
}

/** 清单 → 记账（同 id 重复清单 ⇒ 刷新时刻；台账有界，最旧先清）。返回记账条数（供测试账目对拍）。 */
export function recordQuickFixTickets(input: QuickFixRecordInput): number {
  const now = Date.now();
  pruneTickets(now);
  let recorded = 0;
  for (const item of input.items) {
    const actionId = typeof item['actionId'] === 'string' ? item['actionId'] : '';
    if (actionId === '') continue;
    const paneId = hostActionIdParts(actionId);
    if (paneId === null) continue;
    tickets.set(actionId, {
      actionId,
      sessionId: input.sessionId,
      paneId,
      uri: input.uri,
      versionId: input.versionId,
      line: input.line,
      column: input.column,
      title: typeof item['title'] === 'string' ? item['title'] : '',
      at: now,
    });
    recorded += 1;
  }
  // 入账后再收一次口：单次清单最多 30 条，插完再限 ⇒ 台账条数恒 ≤ TICKET_LIMIT（去向账：被清的 id 再 apply ⇒ UNLISTED）。
  pruneTickets(now);
  return recorded;
}

/** 测试 / 会话销毁钩子：清空台账（清空后所有旧 id 一律显式失败，不静默放行）。 */
export function resetQuickFixTickets(): void {
  tickets.clear();
}

/** 当前台账条数（有界性可测）。 */
export function quickFixTicketCount(): number {
  return tickets.size;
}

/* ------------------------------- pane 反查 seam ------------------------------- */

/** `EditorTextEdit`（@kojo/plugin-api）的最窄投影。 */
export interface QuickFixTextEdit {
  readonly fromLine: number;
  readonly toLine: number;
  readonly newText: string;
}

/** 归属 pane 的可执行投影：编辑器 + 宿主动作反查表 + 糖投影 URI（派生视图闸）+ 既有 apply 通道。 */
export interface QuickFixPaneHandle {
  readonly editor: unknown;
  readonly pendingActions: Map<string, unknown>;
  readonly sugarModelUri: string | null;
  readonly applyEdits: (editor: unknown, edits: readonly QuickFixTextEdit[]) => boolean;
}

export type QuickFixPaneResolver = (
  paneId: string,
) => Promise<QuickFixPaneHandle | null> | QuickFixPaneHandle | null;

export interface McpQuickFixDeps {
  /** pane 反查 seam（测试注入假件；生产缺省动态 import livePanes + applyTextEdits）。 */
  readonly getQuickFixPane?: QuickFixPaneResolver;
}

/* 生产装载缓存（动态 import 一次，模块缓存极轻；不进 ps10 开机静态图）。 */

/** `livePanes` 条形的最窄投影（真 PaneCtx 结构满足）。 */
interface QuickFixPaneCtxLike {
  editorRef: { current: unknown };
  pendingActionsRef: { current: Map<string, unknown> };
  sugarModelRef: { current: { uri: { toString(): string } } | null };
}

interface QuickFixRuntime {
  livePanes: Map<string, QuickFixPaneCtxLike>;
  applyTextEdits: (editor: unknown, edits: readonly QuickFixTextEdit[]) => boolean;
}

let quickFixRuntimePromise: Promise<QuickFixRuntime | null> | null = null;

async function loadQuickFixRuntime(): Promise<QuickFixRuntime | null> {
  quickFixRuntimePromise ??= (async () => {
    try {
      const [registryMod, providersMod] = await Promise.all([
        import('../ui/editor-pane-registry'),
        import('../ui/editor-global-providers'),
      ]);
      return {
        livePanes: registryMod.livePanes as unknown as QuickFixRuntime['livePanes'],
        applyTextEdits: providersMod.applyTextEdits as unknown as QuickFixRuntime['applyTextEdits'],
      };
    } catch {
      return null;
    }
  })();
  return quickFixRuntimePromise;
}

/** 生产 pane 反查：`livePanes`（模块级登记簿）+ 宿主既有 `applyTextEdits`（模型内一次撤销步）。 */
export async function productionResolveQuickFixPane(paneId: string): Promise<QuickFixPaneHandle | null> {
  const runtime = await loadQuickFixRuntime();
  if (!runtime) return null;
  const ctx = runtime.livePanes.get(paneId);
  if (!ctx) return null;
  const editor = ctx.editorRef.current;
  if (!editor) return null;
  return {
    editor,
    pendingActions: ctx.pendingActionsRef.current,
    sugarModelUri: ctx.sugarModelRef.current?.uri.toString() ?? null,
    applyEdits: (ed, edits) => runtime.applyTextEdits(ed, edits),
  };
}

/* ------------------------------- apply 链 ------------------------------- */

function modelOf(editor: unknown): {
  uri: { toString(): string };
  getVersionId?: () => number;
} | null {
  const getter = (editor as { getModel?: () => unknown } | null)?.getModel;
  if (typeof getter !== 'function') return null;
  const model = getter.call(editor) as Record<string, unknown> | null;
  if (!model || typeof model !== 'object') return null;
  return model as unknown as { uri: { toString(): string }; getVersionId?: () => number };
}

/** edits 形状判据：缺省 / 空数组 ⇒ run 式意图（未接线）；脏条目 ⇒ 整条拒绝（fail-closed）。 */
function sanitizeActionEdits(raw: unknown): { readonly kind: 'no-edits' } | { readonly kind: 'bad-shape'; readonly reason: string } | { readonly kind: 'edits'; readonly edits: QuickFixTextEdit[] } {
  if (raw === undefined || raw === null) return { kind: 'no-edits' };
  if (!Array.isArray(raw)) return { kind: 'bad-shape', reason: 'edits 不是数组' };
  if (raw.length === 0) return { kind: 'no-edits' };
  const out: QuickFixTextEdit[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') return { kind: 'bad-shape', reason: 'edit 条目不是对象' };
    const r = e as Record<string, unknown>;
    const fromLine = r['fromLine'];
    const toLine = r['toLine'];
    const newText = r['newText'];
    if (typeof fromLine !== 'number' || !Number.isFinite(fromLine) || fromLine < 1) {
      return { kind: 'bad-shape', reason: 'fromLine 须为 ≥1 的数字' };
    }
    if (typeof toLine !== 'number' || !Number.isFinite(toLine) || toLine < fromLine) {
      return { kind: 'bad-shape', reason: 'toLine 须为 ≥fromLine 的数字' };
    }
    if (typeof newText !== 'string') return { kind: 'bad-shape', reason: 'newText 须为字符串' };
    out.push({ fromLine: Math.trunc(fromLine), toLine: Math.trunc(toLine), newText });
  }
  return { kind: 'edits', edits: out };
}

/**
 * `problems.quickFix` 受控 apply 腿（edit 档，进 `ioTools` 表）。
 * 逐闸拒绝均显式 `{code, message}`（消息带 `[E_QUICKFIX_*]` 机器码字面，铁律 4 不静默）；
 * 成功后台账条目**一次性消耗**（同 id 再 apply ⇒ 未命中显式失败；即便不消耗，
 * apply 本身已推高文档版本，版本闸同样会拒）。
 */
export function createQuickFixApplyLeg(deps: McpQuickFixDeps = {}): McpReaderFn {
  const resolvePane = deps.getQuickFixPane ?? productionResolveQuickFixPane;
  return async (args: Record<string, unknown>, scope: McpSessionScope): Promise<unknown> => {
    const actionId = typeof args['actionId'] === 'string' ? args['actionId'] : '';
    if (actionId === '') {
      throw new McpFailure('INVALID_ARGS', 'problems.quickFix 缺 actionId：须原样携带 semantic.codeActionsAt 清单返回的 id，不许编造');
    }
    const line = args['line'];
    const column = args['column'];
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1 ||
        typeof column !== 'number' || !Number.isInteger(column) || column < 1) {
      throw new McpFailure('INVALID_ARGS', 'problems.quickFix 的 line/column 须为 1 基正整数（清单时的同一位置）');
    }

    const ticket = tickets.get(actionId);
    if (!ticket) {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        `[E_QUICKFIX_UNLISTED] actionId ${actionId.slice(0, 120)} 没有台账记录：未列过、已过期或已被有界清理。` +
          '请先 semantic.codeActionsAt 取当前清单里的 id，不许拿旧清单或编造的 id 执行。',
      );
    }
    const sessionId = typeof scope?.sessionId === 'string' ? scope.sessionId : '';
    if (ticket.sessionId !== sessionId) {
      throw new McpFailure(
        'PERMISSION_DENIED',
        '[E_QUICKFIX_CROSS_SESSION] actionId 属于另一会话的清单，跨会话挪用在台账上直接拒绝（不执行）。',
      );
    }
    if (ticket.line !== line || ticket.column !== column) {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        `[E_QUICKFIX_POSITION_MISMATCH] 入参位置 ${line}:${column} 与清单时记下的 ${ticket.line}:${ticket.column} 不一致：` +
          '动作是对那个位置列出来的，换位置执行是假实现，拒绝。',
      );
    }
    if (Date.now() - ticket.at > TICKET_TTL_MS) {
      tickets.delete(actionId);
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        `[E_QUICKFIX_STALE] 台账已过期（TTL ${Math.round(TICKET_TTL_MS / 60000)} 分钟）：重新清单取新 id。`,
      );
    }

    const handle = await resolvePane(ticket.paneId);
    if (!handle) {
      throw new McpFailure(
        'NOT_WIRED',
        `[E_QUICKFIX_PANE_GONE] 归属实例 ${ticket.paneId} 已退册或编辑器不在场：动作只活在归属 pane 的反查表里，不迁移、不伪造。`,
      );
    }
    const model = modelOf(handle.editor);
    if (!model || !model.uri) {
      throw new McpFailure(
        'NOT_WIRED',
        `[E_QUICKFIX_PANE_GONE] 归属实例 ${ticket.paneId} 当前没有可执行编辑器 model：拒绝执行（不静默）。`,
      );
    }
    const uriNow = model.uri.toString();
    if (uriNow !== ticket.uri) {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        `[E_QUICKFIX_DOC_CHANGED] 归属实例已换文档（清单时 ${ticket.uri} → 现在 ${uriNow}）：旧 actionId 作废，请重新清单。`,
      );
    }
    if (handle.sugarModelUri !== null && handle.sugarModelUri === ticket.uri) {
      throw new McpFailure(
        'NOT_WIRED',
        '[E_QUICKFIX_DERIVED_VIEW] 清单落在糖投影（派生视图）model 上：整行改写在投影上不等于改源文件，MCP 面不开放（显式缺口，不假成功）。',
      );
    }
    const versionNow = typeof model.getVersionId === 'function' ? model.getVersionId() : null;
    if (ticket.versionId !== null && versionNow !== null && versionNow !== ticket.versionId) {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        `[E_QUICKFIX_DOC_CHANGED] 文档自清单以来已变更（版本 ${ticket.versionId} → ${versionNow}，编辑/撤销/重做都算）：` +
          '旧 actionId 的行号与语义都可能已过期，拒绝拿过期动作 apply；请重新清单。',
      );
    }

    const action = handle.pendingActions.get(actionId);
    if (!action || typeof action !== 'object') {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        '[E_QUICKFIX_ACTION_EXPIRED] 宿主反查表里这条 actionId 已不在场（整体清理过 / 实例重建）：重新清单取新 id。',
      );
    }
    const shape = sanitizeActionEdits((action as Record<string, unknown>)['edits']);
    if (shape.kind === 'no-edits') {
      throw new McpFailure(
        'NOT_WIRED',
        '[E_QUICKFIX_RUN_INTENT] 这条动作是 run 式意图（没有就地 edits）：执行它等于跑任意 EditorCommandContext 副作用' +
          '（对话框 / 写盘 / 布局），MCP 面没有开放该通道——能力未接线部分保持显式，不假成功。',
      );
    }
    if (shape.kind === 'bad-shape') {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        `[E_QUICKFIX_EDIT_SHAPE] 动作 edits 形状非法（${shape.reason}）：整条拒绝，不夹带脏条目进编辑器。`,
      );
    }

    const versionBefore = versionNow;
    let applied: boolean;
    try {
      applied = handle.applyEdits(handle.editor, shape.edits);
    } catch (err: unknown) {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        `[E_QUICKFIX_APPLY_FAILED] 宿主 applyTextEdits 抛错：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!applied) {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        '[E_QUICKFIX_APPLY_FAILED] 宿主 applyTextEdits 回报未落任何编辑（无 model / 空改写）：不冒充成功。',
      );
    }
    tickets.delete(actionId);
    const versionAfter = typeof model.getVersionId === 'function' ? model.getVersionId() : null;
    return {
      actionId,
      title: ticket.title,
      uri: ticket.uri,
      editsApplied: shape.edits.length,
      versionBefore,
      versionAfter,
      undo: '模型内单次 executeEdits（前后停点 = 一个撤销步，Ctrl+Z 一次退回）；本腿不落盘（铁律 5/6/7：未新建任何写通道）',
    };
  };
}
