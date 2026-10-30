/**
 * `window.__kojoDebug` 调试面的安装器（2026-10-24 调试模式批）。
 *
 * **只在选入调试模式时进页面**（`main.tsx` 里 `?kojo-debug=1` 才动态 import 本模块）：
 * 开机图（ps10-eager-graph 闸）一个字节都不受影响；桌面壳与未选入的浏览器页
 * 永远不执行这里的代码。
 *
 * 暴露的分面（全部只读优先，写动作显式命名）：
 * - `mode` / `host`：当前跑在哪（shell = 桌面壳；web-debug = 浏览器 + 调试宿）；
 * - `state()`：一屏聚合读数（相位 / 主题 / 标签 / 面板 / 通知 / 树 / 状态栏 / 当前项目）；
 * - `kernel()`：活内核对象（services / plugins / bus / project 的完整面，高级用法）；
 * - `commands.list() / run(id)`：命令面板注册表——**所有功能只要登记了命令就有一个
 *   可编程入口**，与真人按 Ctrl+Shift+P 走的是同一条路；
 * - `bus.recent(n) / on(name, cb)`：内核事件总线的旁听（环形缓冲 + 订阅）；
 * - `editor.*`：焦点编辑器的读数与受控写（经 editor-pane-registry 的登记簿，
 *   不碰 EditorPane 源码）：info / setValue / type / setCursor / markers；
 * - `editor` 的**语言面读数**（1029 批，只读、绝不抛）：`actions()`（编辑器动作表）、
 *   `hoverAt()`（走真 hover provider 链读屏上文本）、`suggestAt()`（真补全弹窗候选）、
 *   `tokens()`（词法 token）、`foldingRanges()`（折叠区间）、`format()`（格式化前后长度）、
 *   `setSelection()` / `revealLine()`（受控定位）——PITFALLS 247 的手工绕法在此收编成 API；
 * - `editor.selfCheck()`（1030 批，只读、绝不抛）：上一条里那些**私有 DOM 形态**
 *   （`.monaco-hover` / `.suggest-widget` / `.label-name` / `.details-label`）与**私有贡献点**
 *   （`editor.contrib.folding`）在**当前构建**上还成不成立的自检读数。Monaco 一升级，这些
 *   会静默失效、读数恒为 null，看起来像"功能没做"——所以升级后先跑它，`ok===false` 就是
 *   "该重新对照 DOM 了"，不是"调试面坏了"；
 * - `invoke(cmd, args)`：直达宿主命令（桌面壳 = 真 Tauri IPC；浏览器 = 调试宿）；
 * - `dialogPolicy.{arm,armed,clear,status}`：对话框一次性自动应答（真壳 fetch 腿 /
 *   web 页面腿；只答**只选取器** choose_directory 与 pick_save_path——都是"只选不写"，
 *   写域准入门与 export_file 不碰——见 `dialog-policy.ts` 头注裁决）；
 * - `perf.*`：UI 卡顿体检探针（可开关；帧分档 / 长任务×事件相关性 / 交互延迟 /
 *   逐源码文件的帧耗时归因——口径与阈值见 `perf-probe-core.ts`）；
 * - `dom.snapshot()`：结构快照（`dom-snapshot.ts` 的口径）。
 */
import { invoke, isTauri } from '../bridge/invoke';
import { KERNEL_EVENT_NAMES, type GameProject, type KernelEventName } from '@kojo/plugin-api';
import { version as APP_VERSION, dependencies as APP_DEPS } from '../../package.json';
import type { Kernel } from '@kojo/kernel';
// 只取类型面：语言面读数需要 IStandaloneCodeEditor 的签名，但不能把 Monaco 运行时拖进本模块
import type * as Monaco from '../monaco/entry';
import { getDebugCommandRunner, whenDebugKernel } from './debug-registry';
import { webHostActive, webHostOrigin } from './web-host-transport';
import {
  armChooseDir,
  armedChooseDir,
  clearChooseDir,
  installShellDialogIntercept,
  shellDialogInterceptStatus,
  type DialogPolicyArmed,
} from './dialog-policy';
import { snapshotDocument, type DomSnapshot } from './dom-snapshot';
import { createPerfProbe, type PerfProbe } from './perf-probe';
import { summarizeReport } from './perf-probe-core';
// 编辑器登记簿（只 import 这一个轻模块；Monaco 运行时按需再动态取）
import { focusedCtx } from '../ui/editor-pane-registry';

export interface DebugStateReading extends DomSnapshot {
  readonly ready: true;
  readonly project: { rootDir: string; adapterId: string; kojoPaths: string[]; gameVersion?: string } | null;
}

export interface KojoDebugApi {
  readonly mode: 'shell' | 'web-debug';
  readonly appVersion: string;
  readonly host: string | null;
  state(): DebugStateReading;
  kernel(): Promise<Kernel>;
  commands: {
    list(): readonly { id: string; title: string; category?: string; keybinding?: string }[] | { error: string };
    run(id: string): Promise<void>;
  };
  bus: {
    recent(n?: number): readonly BusRecord[];
    on(name: string, cb: (payload: unknown) => void): () => void;
  };
  editor: {
    info(): EditorInfo | null;
    setValue(text: string): boolean;
    /** 在光标处插入文本（走 executeEdits，进撤销栈——与真人打字同路） */
    type(text: string): boolean;
    setCursor(line: number, column: number): boolean;
    markers(): Promise<{ resource: string; severity: number; message: string; line: number }[]>;
    /** 编辑器动作表（`getSupportedActions()`）：`enabled` 是 `isSupported()` 的实测值 */
    actions(): DebugEditorAction[];
    /** 在指定位置走真 hover provider 链读屏上文本；超时 / 无内容 ⇒ null（不抛） */
    hoverAt(line: number, column: number, opts?: { timeoutMs?: number }): Promise<DebugHoverReading | null>;
    /** 在指定位置触发真补全弹窗并读候选；读不到 ⇒ `{items:[],count:0}` */
    suggestAt(
      line: number,
      column: number,
      opts?: { timeoutMs?: number; limit?: number },
    ): Promise<DebugSuggestReading>;
    /** 整篇格式化：`before`/`after` 是 `model.getValueLength()` */
    format(): Promise<DebugFormatReading>;
    setSelection(startLine: number, startColumn: number, endLine: number, endColumn: number): boolean;
    revealLine(line: number, reveal?: 'center' | 'top' | 'bottom'): boolean;
    /** 折叠区间（尽力而为：Monaco 没有公开 API，内部形状随版本变 ⇒ 拿不到回 null） */
    foldingRanges(): DebugFoldingRange[] | null;
    /** 词法 token（`monaco.editor.tokenize`，逐行；行号 1 基） */
    tokens(lineFrom: number, lineTo: number): Promise<DebugTokenLine[]>;
    /** 私有 DOM 形态 / 私有贡献点的自检读数（只读、绝不抛；升级 Monaco 后先跑它） */
    selfCheck(): DebugSelfCheck;
  };
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  /**
   * 对话框自动应答 policy（2026-10-26 era-pair 批，additive；1028 批扩到第二条只选取器）：
   * 一次性短路**只选取器**——`choose_directory`（打开＝读）与 `pick_save_path`（另存为落点，
   * 只交回路径不写盘）。`export_file` / `choose_file` / 写域准入门不应答。
   * 真壳＝fetch 拦截腿（arm 时拦截腿未就位 ⇒ 抛错如实失败）；web 模式＝`webHostInvoke`
   * 页面级优先，未 armed 时宿的 POST /policy 腿照旧。
   */
  dialogPolicy: {
    arm(value: string | null): DialogPolicyArmed;
    armed(): DialogPolicyArmed;
    clear(): void;
    status(): { readonly mode: 'shell' | 'web-debug'; readonly shellFetchWrapped: boolean };
  };
  /** UI 卡顿体检（可开关；关着零开销）：start → 交互 → stop 出报告 */
  perf: {
    start(opts?: { blockingSampleMs?: number }): { started: true; note: string };
    stop(): ReturnType<PerfProbe['stop']>;
    isRunning(): boolean;
    lastReport(): ReturnType<PerfProbe['lastReport']>;
    /** 上一轮报告的人读摘要行（无报告 ⇒ null） */
    summary(): string[] | null;
  };
  dom: { snapshot(): DomSnapshot };
}

export interface BusRecord {
  readonly t: number;
  readonly name: string;
  readonly payload: unknown;
}

export interface EditorInfo {
  readonly path: string;
  readonly languageId: string;
  readonly eol: 'lf' | 'crlf';
  readonly lineCount: number;
  readonly value: string;
  readonly cursor: { readonly line: number; readonly column: number };
  readonly selection: string | null;
}

/* ------------------------- 语言面读数（1029 批，只读） ------------------------- */

export interface DebugEditorAction {
  readonly id: string;
  readonly label: string;
  /** Monaco 的 `alias` 在运行时可能缺席（类型声明是必选）：缺席时不挂这个键 */
  readonly alias?: string;
  readonly enabled: boolean;
}

export interface DebugHoverReading {
  /** 悬停面板 innerText 的裁剪版（行内空白归一、超长截断） */
  readonly text: string;
  /** 逐条 `.hover-row` 文本（没有行容器时退化为正文按行切） */
  readonly rows: string[];
  readonly line: number;
  readonly column: number;
}

export interface DebugSuggestItem {
  readonly label: string;
  readonly detail: string;
  readonly kind: string;
}

export interface DebugSuggestReading {
  /** 受 `limit` 截断的候选（读不到 ⇒ 空数组） */
  readonly items: DebugSuggestItem[];
  /** 弹窗里实际读到的候选行数（未截断；空弹窗 ⇒ 0） */
  readonly count: number;
}

export interface DebugFormatReading {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly before: number;
  readonly after: number;
  readonly elapsedMs: number;
}

export interface DebugFoldingRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: string;
}

export interface DebugTokenLine {
  readonly line: number;
  readonly tokens: readonly { readonly type: string; readonly startIndex: number }[];
}

/**
 * 自检的六条选择器口径。**这是"能力探测"，不是"此刻屏上有元素"**：
 * 面板没弹出来时 `document.querySelector` 当然是 0 命中，那不代表选择器失效——
 * 所以每项都是"DOM 里见到过 **或** 产出它的那个贡献点还在"，见 `probeSelectors`。
 */
export interface DebugSelfCheckSelectors {
  /** `.monaco-hover`（悬停面板容器） */
  readonly hover: boolean;
  /** `.suggest-widget`（补全弹窗外壳） */
  readonly suggest: boolean;
  /** `.suggest-widget .monaco-list-row`（候选行） */
  readonly suggestRow: boolean;
  /** `.label-name`（候选名字） */
  readonly labelName: boolean;
  /** `.details-label`（候选细节） */
  readonly detailsLabel: boolean;
  /** `getContribution('editor.contrib.folding')` 非空 */
  readonly foldingContribution: boolean;
}

/** 折叠模型的真实形态：0.57 = `promise`（`getFoldingModel()` 返 Promise）/ 早期 = `ranges` */
export type DebugFoldingShape = 'regions' | 'ranges' | 'promise' | 'none';

/**
 * `editor.selfCheck()` 的返回形状（契约面）。`monacoVersion` / `languageId` 取不到就是 null
 * （不编造），`ok` 只由 `monacoVersion !== null && hover && suggest && foldingContribution`
 * 三项决定——`suggestRow` / `labelName` / `detailsLabel` 是纯 DOM 探测，**不参与** `ok`。
 */
export interface DebugSelfCheck {
  readonly monacoVersion: string | null;
  readonly languageId: string | null;
  readonly selectors: DebugSelfCheckSelectors;
  readonly foldingShape: DebugFoldingShape;
  readonly ok: boolean;
}

/** 悬浮文本/行的上限：悬停面板里整篇文档也可能被塞进来，读数不该原样搬 */
const HOVER_TEXT_LIMIT = 2000;
const HOVER_ROW_LIMIT = 40;
const HOVER_ROW_CHAR_LIMIT = 300;
const HOVER_TIMEOUT_DEFAULT_MS = 2000;
const SUGGEST_TIMEOUT_DEFAULT_MS = 2000;
const SUGGEST_LIMIT_DEFAULT = 50;
const LANGUAGE_POLL_INTERVAL_MS = 50;
const LANGUAGE_TIMEOUT_MIN_MS = 50;
const LANGUAGE_TIMEOUT_MAX_MS = 15000;

/** 纯函数的入参形态：真实 `IEditorAction` 结构兼容，单测喂普通对象即可 */
export interface SupportedActionLike {
  readonly id?: unknown;
  readonly label?: unknown;
  readonly alias?: unknown;
  isSupported?: () => boolean;
}

/**
 * 动作表映射（纯函数）：
 * - `id` 空 ⇒ 丢弃（没有 id 动作也调不到，留着只会污染读数）；
 * - `label` 缺 ⇒ 退 alias ⇒ 退 id（三处都空就当没标签，用 id 顶上）；
 * - `alias` 缺 ⇒ **不挂键**（与 `WebHostConfig.token` 同一条"空值不挂键"纪律）；
 * - `enabled` 取自 `isSupported()`，拿不到 / 抛错 ⇒ 当 true（表里存在即视为可用，
 *   宁可给"可能可用"也不谎报不可用）。
 */
export function mapSupportedActions(actions: readonly SupportedActionLike[]): DebugEditorAction[] {
  const out: DebugEditorAction[] = [];
  if (!Array.isArray(actions)) return out;
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    const id = normalizeOneLine(action.id);
    if (!id) continue;
    const alias = normalizeOneLine(action.alias);
    const label = normalizeOneLine(action.label) || alias || id;
    let enabled = true;
    if (typeof action.isSupported === 'function') {
      try {
        enabled = action.isSupported() !== false;
      } catch {
        enabled = true;
      }
    }
    out.push({ id, label, ...(alias ? { alias } : {}), enabled });
  }
  return out;
}

/**
 * 悬停文本裁剪（纯函数）：按行归一空白、丢空行、单行超 300 字符截断、最多 40 行、
 * 总长 2000 字符截断。读数要的是"人能看的那几行"，不是 DOM 的原始拼串。
 */
export function slimHoverText(raw: string): { text: string; rows: string[] } {
  const source = typeof raw === 'string' ? raw : '';
  const rows = source
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .slice(0, HOVER_ROW_LIMIT)
    .map((line) => (line.length > HOVER_ROW_CHAR_LIMIT ? `${line.slice(0, HOVER_ROW_CHAR_LIMIT)}…` : line));
  const joined = rows.join('\n');
  const text = joined.length > HOVER_TEXT_LIMIT ? `${joined.slice(0, HOVER_TEXT_LIMIT)}…` : joined;
  return { text, rows };
}

/** 补全行的入参形态（DOM 侧按这些键读；纯函数不碰 DOM） */
export interface SuggestRowLike {
  /** `.label-name` 的文本 */
  readonly labelName?: unknown;
  /** 行的 aria-label（`.label-name` 缺席时的回退） */
  readonly ariaLabel?: unknown;
  /** `.details-label` 的文本（缺失 ⇒ 空串） */
  readonly detailsLabel?: unknown;
  /** 行的 class（`kind-*` 用于取候选种类） */
  readonly className?: unknown;
}

/**
 * 补全候选行映射（纯函数）：
 * - `label` = `.label-name` ⇒ 回退 aria-label；两者都空 ⇒ 丢弃该行（没有可读名字的候选
 *   对调试没有价值，留着只会让 count 虚高）；
 * - `detail` 缺失 ⇒ 空串（不是 null：调用方不必再判两种空值）；
 * - `kind` = 行 class 里的 `kind-<x>` ⇒ 回退整条 aria-label（Monaco 的候选种类没有稳定
 *   的公开 DOM 契约，读不到就交回原文，不编造）。
 */
export function mapSuggestRows(rows: readonly SuggestRowLike[]): DebugSuggestItem[] {
  const out: DebugSuggestItem[] = [];
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const labelName = normalizeOneLine(row.labelName);
    const ariaLabel = normalizeOneLine(row.ariaLabel);
    const label = labelName || ariaLabel;
    if (!label) continue;
    const kindClass = /(?:^|\s)kind-([a-z-]+)/i.exec(normalizeOneLine(row.className));
    const kind = kindClass?.[1] ?? ariaLabel;
    out.push({ label, detail: normalizeOneLine(row.detailsLabel), kind });
  }
  return out;
}

/** 单行归一：非字符串 ⇒ 空串；折叠空白与换行（读数一律单行） */
function normalizeOneLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * `selfCheck` 读数归一（纯函数，供单测）。
 *
 * 入参是 `unknown`：null / 缺字段 / 半截对象 / 脏值（`'true'` 这种字符串）都**不许抛**，
 * 一律归成契约形状——否则"自检自己炸了"就退化成第二个无法定位的静默失败。
 * 归一规则刻意取严：
 * - `selectors.*` 只认**字面量 true**（`'true'` / 1 都不算：读数是给脚本断言的，不猜）；
 * - `monacoVersion` / `languageId` 取单行化后的非空串，否则 null；
 * - `foldingShape` 只认四个枚举值，其余归 `'none'`；
 * - `ok` 只看三项（version + hover + suggest + foldingContribution），**不看** DOM 行级探测。
 */
export function summarizeSelfCheck(raw: unknown): DebugSelfCheck {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawSelectors = (
    source.selectors && typeof source.selectors === 'object' ? source.selectors : {}
  ) as Record<string, unknown>;
  const selectors: DebugSelfCheckSelectors = {
    hover: rawSelectors.hover === true,
    suggest: rawSelectors.suggest === true,
    suggestRow: rawSelectors.suggestRow === true,
    labelName: rawSelectors.labelName === true,
    detailsLabel: rawSelectors.detailsLabel === true,
    foldingContribution: rawSelectors.foldingContribution === true,
  };
  const monacoVersion = normalizeOneLine(source.monacoVersion) || null;
  const languageId = normalizeOneLine(source.languageId) || null;
  const shape = source.foldingShape;
  const foldingShape: DebugFoldingShape =
    shape === 'regions' || shape === 'ranges' || shape === 'promise' ? shape : 'none';
  return {
    monacoVersion,
    languageId,
    selectors,
    foldingShape,
    ok: monacoVersion !== null && selectors.hover && selectors.suggest && selectors.foldingContribution,
  };
}

const BUS_RING_LIMIT = 500;
// 定长环形缓冲（2026-10-26 性能批）：旧实现每来一条事件就 push + splice 搬移 500 项，
// 内核事件密集时会成为页内热路径；现在 O(1) 覆盖写，读取时按环形序还原（仅取数时分配）。
const busRing: BusRecord[] = new Array<BusRecord>(BUS_RING_LIMIT);
let busHead = 0;
let busCount = 0;

/** kernel 的同步缓存（装配完成即写入）：`state()` 这类同步读数从它取，不 await */
let kernelNow: Kernel | null = null;

function recordBus(name: string, payload: unknown): void {
  // 时基与探针同域（口径修②，2026-10-25 反馈）：performance.now() 与
  // PerformanceObserver 条目的 startTime 同钟——hintForTask 才能对上；
  // Date.now() 是墙钟，两域混用 ⇒ 长任务 hint 恒 null（实测三条全 null）。
  // 消费方（bus.recent 的展示）只相对排序，无墙钟依赖。
  busRing[busHead] = { t: performance.now(), name, payload };
  busHead = (busHead + 1) % BUS_RING_LIMIT;
  if (busCount < BUS_RING_LIMIT) busCount += 1;
}

/** 最近 n 条（时间正序）；n 超上限按上限给。无事件 ⇒ 空数组 */
function busRecent(n: number): BusRecord[] {
  // 外部可传任意值（eval 里手敲）：非有限数回退 40，别让 new Array(NaN) 抛
  const want = Number.isFinite(n) ? Math.floor(n) : 40;
  const k = Math.min(Math.max(0, want), busCount);
  if (k === 0) return [];
  const out = new Array<BusRecord>(k);
  let idx = (busHead - k + BUS_RING_LIMIT) % BUS_RING_LIMIT;
  for (let i = 0; i < k; i++) {
    out[i] = busRing[idx]!;
    idx = (idx + 1) % BUS_RING_LIMIT;
  }
  return out;
}

/** 事件载荷太大时会拖垮 JSON 序列化：旁听面只留摘要形态（数值 / 短串 / 浅结构） */
export function slimPayload(payload: unknown, depth = 0): unknown {
  if (payload === null || payload === undefined) return payload;
  if (typeof payload === 'number' || typeof payload === 'boolean') return payload;
  if (typeof payload === 'string') return payload.length > 200 ? `${payload.slice(0, 200)}…` : payload;
  if (Array.isArray(payload)) {
    const arr = payload as unknown[];
    return { __arr: arr.length, sample: arr.slice(0, 5).map((p) => slimPayload(p, depth + 1)) };
  }
  if (typeof payload === 'object') {
    if (depth >= 2) return '{…}';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload as Record<string, unknown>).slice(0, 12)) {
      out[k] = slimPayload(v, depth + 1);
    }
    return out;
  }
  return String(payload);
}

/* --------------------- 语言面读数的浏览器侧取数腿（不导出） --------------------- */

type LiveEditor = Monaco.editor.IStandaloneCodeEditor;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 外部（eval 里手敲）可传任意值：非有限数走缺省，且夹到 [50, 15000] 免得挂死 */
function clampTimeoutMs(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(LANGUAGE_TIMEOUT_MIN_MS, n), LANGUAGE_TIMEOUT_MAX_MS);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(min, n), max);
}

/**
 * 屏上"有内容且没被隐藏"的悬停面板。Monaco 的 hover 容器类名 `monaco-hover` 是
 * `base/browser/ui/hover/hoverWidget.js` 里硬编码的（0.57 核对过），收起时挂 `hidden`。
 * 从后往前找：后挂的面板才是当前那条 provider 链的结算。
 */
function visibleHoverNode(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const nodes = document.querySelectorAll<HTMLElement>('.monaco-hover');
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (!node || node.classList.contains('hidden')) continue;
    if ((node.textContent ?? '').trim() === '') continue;
    return node;
  }
  return null;
}

async function waitForHoverNode(timeoutMs: number): Promise<HTMLElement | null> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const node = visibleHoverNode();
    if (node) return node;
    if (performance.now() >= deadline) return null;
    await sleep(LANGUAGE_POLL_INTERVAL_MS);
  }
}

/**
 * 收起悬停：先用正牌 `editor.action.hideHover`，没有这枚动作的版本退化为再 run 一次
 * `showHover`（它是切换语义）。两步都是尽力而为——收不起来不该把读数变成失败。
 */
function hideHoverNow(ed: LiveEditor): void {
  try {
    const hide = ed.getAction('editor.action.hideHover');
    if (hide) {
      void hide.run().catch(() => undefined);
      return;
    }
    const show = ed.getAction('editor.action.showHover');
    if (show) void show.run().catch(() => undefined);
  } catch {
    /* 收起失败不影响已读到的文本 */
  }
}

/** 补全弹窗里当前"真实存在于 DOM"的候选行（monaco-list 是虚拟列表，只读得到屏上那几行） */
function visibleSuggestRows(): HTMLElement[] {
  if (typeof document === 'undefined') return [];
  const widget = document.querySelector<HTMLElement>('.suggest-widget.visible');
  if (!widget) return [];
  return Array.from(widget.querySelectorAll<HTMLElement>('.monaco-list-row'));
}

async function waitForSuggestRows(timeoutMs: number): Promise<HTMLElement[]> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const rows = visibleSuggestRows();
    if (rows.length > 0) return rows;
    if (performance.now() >= deadline) return [];
    await sleep(LANGUAGE_POLL_INTERVAL_MS);
  }
}

function readSuggestRow(row: HTMLElement): SuggestRowLike {
  return {
    labelName: row.querySelector('.label-name')?.textContent ?? '',
    ariaLabel: row.getAttribute('aria-label') ?? '',
    detailsLabel: row.querySelector('.details-label')?.textContent ?? '',
    className: row.className,
  };
}

/**
 * 折叠区间：Monaco 至今**没有公开 API**（`editor.api.d.ts` 只有 `editor.action.*`），
 * 只能摸贡献点内部。0.57 的形状是 `getFoldingModel()` 返回 **Promise**、模型上叫
 * `regions`（`FoldingRegions` 实例，带 `length` + `getStartLineNumber(i)`）；早期版本是
 * 同步返回 + `ranges` 数组。两种都探，探不到（含 Promise 形态——同步 API 不能等）⇒ null：
 * **不许假装有**，调用方看到 null 才知道这条路在当前版本上不通。
 */
function foldingRangesOf(ed: LiveEditor): DebugFoldingRange[] | null {
  try {
    const contribution = (
      ed as unknown as { getContribution(id: string): unknown }
    ).getContribution('editor.contrib.folding');
    if (!contribution || typeof contribution !== 'object') return null;
    const holder = contribution as { foldingModel?: unknown; getFoldingModel?: () => unknown };
    // 0.57 的私有字段 `foldingModel` 是同步可用的那一枚；没有才问方法
    const model = holder.foldingModel ?? holder.getFoldingModel?.();
    if (!model || typeof model !== 'object') return null;
    if (typeof (model as { then?: unknown }).then === 'function') return null;
    return mapFoldingModel(model);
  } catch {
    return null;
  }
}

function mapFoldingModel(model: object): DebugFoldingRange[] | null {
  const arrayRanges = (model as { ranges?: unknown }).ranges;
  if (Array.isArray(arrayRanges)) {
    const out: DebugFoldingRange[] = [];
    for (const item of arrayRanges) {
      if (!item || typeof item !== 'object') continue;
      const r = item as { startLineNumber?: unknown; endLineNumber?: unknown; kind?: unknown };
      if (typeof r.startLineNumber !== 'number' || typeof r.endLineNumber !== 'number') continue;
      out.push({
        startLine: r.startLineNumber,
        endLine: r.endLineNumber,
        kind: typeof r.kind === 'string' ? r.kind : '',
      });
    }
    return out;
  }
  // 0.57：FoldingRegions（不是数组，用 length + 访问器逐条取）
  const regions = (model as { regions?: unknown }).regions;
  if (!regions || typeof regions !== 'object') return null;
  const length = (regions as { length?: unknown }).length;
  if (typeof length !== 'number' || !Number.isFinite(length)) return null;
  const reader = regions as {
    getStartLineNumber(index: number): unknown;
    getEndLineNumber(index: number): unknown;
    getType?: (index: number) => unknown;
  };
  const out: DebugFoldingRange[] = [];
  for (let i = 0; i < length; i += 1) {
    const startLine = reader.getStartLineNumber(i);
    const endLine = reader.getEndLineNumber(i);
    if (typeof startLine !== 'number' || typeof endLine !== 'number') continue;
    const kind = reader.getType?.(i);
    out.push({ startLine, endLine, kind: typeof kind === 'string' ? kind : '' });
  }
  return out;
}

/* --------------------------- 自检读数（1030 批，只读） --------------------------- */

/**
 * 本仓的 monaco 是**精确钉版**（`packages/app/package.json` 里 `"monaco-editor": "0.57.0"`，
 * `monaco/entry.ts` 头注也钉了这条纪律）。为什么要拿钉版号兜底：0.57 的
 * `editor/editor.api.js` **不导出 `version`**（导出面只有 CancellationTokenSource / KeyCode /
 * editor / languages 等），所以"从 monaco entry 的 version 取"在 0.57 上恒为 undefined。
 * 取数优先级见 `resolveMonacoVersion`：运行时 `globalThis.monaco.version`（AMD/globalAPI 形态）
 * → 钉版号 → null。**不猜**：钉版号不合 semver 形态就交回 null（ok=false 如实）。
 */
const PINNED_MONACO_VERSION = APP_DEPS['monaco-editor'];

/** DOM 里见不见得到这条选择器（0 命中也只是 false，不代表选择器坏了） */
function domSeen(selector: string): boolean {
  try {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return false;
    return document.querySelector(selector) !== null;
  } catch {
    return false;
  }
}

/**
 * Monaco 版本：先问运行时入口（`globalThis.monaco.version`，AMD / globalAPI 装配才有），
 * 再退到本仓钉版号（0.57 的实际取数路径）。都拿不到 ⇒ null。
 */
function resolveMonacoVersion(): string | null {
  try {
    const globalApi = (globalThis as { monaco?: { version?: unknown } }).monaco;
    const runtime = normalizeOneLine(globalApi?.version);
    if (runtime) return runtime;
  } catch {
    /* 全局被冻结 / 代理拦住都不该让自检失败 */
  }
  const pinned = normalizeOneLine(PINNED_MONACO_VERSION);
  // 钉版号不合 semver 形态（被改成 workspace: / ^0.57 / git 引用）⇒ 如实 null，不猜
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pinned)) return null;
  return pinned;
}

/** 私有贡献点是否还在（`getContribution` 抛错 / 返回空 ⇒ false） */
function hasContribution(ed: LiveEditor | null, id: string): boolean {
  if (!ed) return false;
  try {
    return !!(ed as unknown as { getContribution(id: string): unknown }).getContribution(id);
  } catch {
    return false;
  }
}

/**
 * 六条选择器的**能力探测**（尽力而为，契约 §2.1 的简化裁决）。
 *
 * 口径声明：`hoverAt` / `suggestAt` 靠的是 Monaco 私有 DOM 形态，升级就可能静默变空。
 * 但"此刻 0 命中"不等于"选择器失效"——面板没弹的时候本来就 0 命中。所以每条取
 * `document.querySelector(sel) !== null || <产出它的那枚贡献点还在>`：
 * - `hover`：贡献点 id 在 0.57 改过名（`editor.contrib.hover` → `editor.contrib.contentHover`，
 *   见 `contrib/hover/browser/contentHoverController.js`），**两个都探**——这正是"升级即改名"
 *   的活例子；
 * - `suggest`：`editor.contrib.suggestController` 仍在 ⇒ 补全弹窗仍会被生产；
 * - `suggestRow` / `labelName` / `detailsLabel`：没有独立的贡献点可问，只能看 DOM 里有没有
 *   这个类的元素（**纯尽力而为**，0 命中就 false，且**不参与 `ok`**）。0.57 实测：候选行
 *   `.details-label` 还在，`.label-name` 已漂（0.57 的行用 `.left` + IconLabel 渲染，
 *   `suggestAt` 因此退到 aria-label 取名字）——`labelName:false` 是这条读数**该报**的真相；
 * - `foldingContribution`：`getContribution('editor.contrib.folding')` 非空（真实探测）。
 *
 * 结论：`selectors` 是"这套私有形态在当前构建上还成立吗"的最佳猜测，不是布尔事实；
 * 脚本只该断言 `ok` 与 `foldingShape`，逐项值用于人工定位。
 */
function probeSelectors(ed: LiveEditor | null): DebugSelfCheckSelectors {
  return {
    hover:
      domSeen('.monaco-hover') ||
      hasContribution(ed, 'editor.contrib.contentHover') ||
      hasContribution(ed, 'editor.contrib.hover'),
    suggest: domSeen('.suggest-widget') || hasContribution(ed, 'editor.contrib.suggestController'),
    suggestRow: domSeen('.suggest-widget .monaco-list-row') || domSeen('.monaco-list-row'),
    labelName: domSeen('.label-name'),
    detailsLabel: domSeen('.details-label'),
    foldingContribution: hasContribution(ed, 'editor.contrib.folding'),
  };
}

/**
 * 折叠模型形态（只判形状，不取数）：0.57 的 `getFoldingModel()` 返 **Promise**（⇒ `'promise'`，
 * 同步读数取不到值）；早期版本同步返回、模型上是 `ranges` 数组；更有版本用 `regions`
 * （`FoldingRegions` 实例，带 `length` + 访问器）。都探不到 ⇒ `'none'`。
 */
function foldingShapeOf(ed: LiveEditor | null): DebugFoldingShape {
  try {
    if (!ed) return 'none';
    const contribution = (
      ed as unknown as { getContribution(id: string): unknown }
    ).getContribution('editor.contrib.folding');
    if (!contribution || typeof contribution !== 'object') return 'none';
    const holder = contribution as { foldingModel?: unknown; getFoldingModel?: () => unknown };
    const model = holder.foldingModel ?? holder.getFoldingModel?.();
    if (!model || typeof model !== 'object') return 'none';
    if (typeof (model as { then?: unknown }).then === 'function') return 'promise';
    if (Array.isArray((model as { ranges?: unknown }).ranges)) return 'ranges';
    const regions = (model as { regions?: unknown }).regions;
    if (regions && typeof regions === 'object') return 'regions';
    return 'none';
  } catch {
    return 'none';
  }
}

/** 自检的原始读数：每一步各自吞错，最后统一过 `summarizeSelfCheck` 归一 */
function readSelfCheckRaw(): DebugSelfCheck {
  let ed: LiveEditor | null = null;
  try {
    ed = focusedCtx()?.editorRef.current ?? null;
  } catch {
    ed = null; // 登记簿被拆 / 编辑器已销毁 ⇒ 无焦点编辑器，照样给形状
  }
  let languageId: string | null = null;
  try {
    languageId = ed?.getModel()?.getLanguageId() || null;
  } catch {
    languageId = null;
  }
  return summarizeSelfCheck({
    monacoVersion: resolveMonacoVersion(),
    languageId,
    selectors: probeSelectors(ed),
    foldingShape: foldingShapeOf(ed),
  });
}

export function installDebug(): KojoDebugApi {
  // 总线旁听：kernel 到场即挂全量已知事件（环形缓冲 + slim）
  void whenDebugKernel().then((kernel) => {
    kernelNow = kernel;
    for (const name of KERNEL_EVENT_NAMES) {
      kernel.bus.on(name as KernelEventName, (payload: unknown) => recordBus(name, slimPayload(payload)));
    }
  });

  // 性能探针（关着零开销；bus 相关性在 stop 时从环形缓冲取，不在采集期加订阅）
  const probe = createPerfProbe({ getBusRecent: (n) => busRecent(n) });

  // 真壳对话框应答腿（2026-10-26 era-pair 批，PITFALLS 230）：调试面装载（?kojo-debug 选入）
  // 才包 window.fetch；装载失败必须出声（铁律 4），dialogPolicy.arm 会随之如实抛错。
  if (isTauri()) {
    const intercept = installShellDialogIntercept((m) => console.info(`[kojo-debug] ${m}`));
    if (!intercept.wrapped) {
      console.warn(`[kojo-debug] 真壳对话框拦截腿未就位：${intercept.reason}——open-project 的目录应答不会生效`);
    }
  }

  const api: KojoDebugApi = {
    mode: isTauri() ? 'shell' : 'web-debug',
    appVersion: APP_VERSION,
    host: webHostActive() ? webHostOrigin() : null,
    state() {
      const p: GameProject | null = kernelNow?.project.current() ?? null;
      return {
        ...snapshotDocument(document),
        ready: true,
        project: p
          ? {
              rootDir: p.rootDir,
              adapterId: p.adapterId,
              kojoPaths: p.kojoPaths,
              ...(p.gameVersion !== undefined ? { gameVersion: p.gameVersion } : {}),
            }
          : null,
      };
    },
    kernel() {
      return whenDebugKernel();
    },
    commands: {
      list() {
        const runner = getDebugCommandRunner();
        if (!runner) return { error: '命令注册表未登记（ShellLayout 未挂载或未注册调试通道）' };
        return runner.list();
      },
      async run(id) {
        const runner = getDebugCommandRunner();
        if (!runner) throw new Error('命令注册表未登记（ShellLayout 未挂载或未注册调试通道）');
        await runner.run(id);
      },
    },
    bus: {
      recent(n = 40) {
        return busRecent(n);
      },
      on(name, cb) {
        let un: (() => void) | null = null;
        void whenDebugKernel().then((kernel) => {
          un = (kernel.bus as unknown as {
            on(n: string, cb: (p: unknown) => void): () => void;
          }).on(name, cb);
        });
        return () => {
          un?.();
        };
      },
    },
    editor: {
      info() {
        const ctx = focusedCtx();
        const ed = ctx?.editorRef.current;
        if (!ctx || !ed) return null;
        const model = ed.getModel();
        const pos = ed.getPosition();
        const sel = ed.getSelection();
        return {
          path: ctx.filePathRef.current,
          languageId: model?.getLanguageId() ?? '',
          eol: model?.getEOL() === '\r\n' ? ('crlf' as const) : ('lf' as const),
          lineCount: model?.getLineCount() ?? 0,
          value: model?.getValue() ?? '',
          cursor: { line: pos?.lineNumber ?? 1, column: pos?.column ?? 1 },
          selection: sel && !sel.isEmpty() ? ((model?.getValueInRange(sel) ?? null) as string | null) : null,
        };
      },
      setValue(text) {
        const model = focusedCtx()?.editorRef.current?.getModel();
        if (!model) return false;
        model.setValue(text);
        return true;
      },
      type(text) {
        const ed = focusedCtx()?.editorRef.current;
        const pos = ed?.getPosition();
        if (!ed || !pos) return false;
        // executeEdits 进 undo 栈（setValue 不进）——「像真人一样改」用它
        ed.executeEdits('kojo-debug', [
          {
            range: {
              startLineNumber: pos.lineNumber,
              startColumn: pos.column,
              endLineNumber: pos.lineNumber,
              endColumn: pos.column,
            },
            text,
            forceMoveMarkers: true,
          },
        ]);
        return true;
      },
      setCursor(line, column) {
        const ed = focusedCtx()?.editorRef.current;
        if (!ed) return false;
        ed.setPosition({ lineNumber: line, column });
        return true;
      },
      async markers() {
        const monaco = await import('../monaco/entry');
        return monaco.editor
          .getModelMarkers({})
          .map((m) => ({ resource: m.resource.toString(), severity: m.severity, message: m.message, line: m.startLineNumber }));
      },
      actions() {
        const ed = focusedCtx()?.editorRef.current;
        if (!ed) return [];
        try {
          return mapSupportedActions(ed.getSupportedActions());
        } catch {
          return [];
        }
      },
      async hoverAt(line, column, opts) {
        const ed = focusedCtx()?.editorRef.current;
        if (!ed || !Number.isFinite(line) || !Number.isFinite(column)) return null;
        const target = { lineNumber: Math.max(1, Math.floor(line)), column: Math.max(1, Math.floor(column)) };
        const timeoutMs = clampTimeoutMs(opts?.timeoutMs, HOVER_TIMEOUT_DEFAULT_MS);
        try {
          ed.setPosition(target);
          ed.focus();
          const show = ed.getAction('editor.action.showHover');
          if (!show) return null; // 没装 hover 贡献 ⇒ 这条路本来就不通，别等满超时
          // 不等 run()：真 provider 链慢时它会把读数拖住，且它自己可能永远不 resolve；
          // 轮询 DOM 才是唯一可靠的"等它画出来"。rejection 就地吞掉，别变成未处理拒绝。
          void show.run().catch(() => undefined);
          const node = await waitForHoverNode(timeoutMs);
          if (!node) return null;
          const body = slimHoverText(node.innerText || node.textContent || '');
          const rowTexts = Array.from(node.querySelectorAll<HTMLElement>('.hover-row'))
            .map((row) => row.innerText || row.textContent || '')
            .filter((text) => text.trim() !== '');
          // 行容器是结构化读数的主口径；它缺席（或无文本）时退化为正文按行切
          const rows = rowTexts.length > 0 ? slimHoverText(rowTexts.join('\n')).rows : body.rows;
          if (body.text === '' && rows.length === 0) return null;
          return { text: body.text, rows, line: target.lineNumber, column: target.column };
        } catch {
          return null;
        } finally {
          // 读数完必须收起：留着悬停会盖住下一次点击 / 滚动
          hideHoverNow(ed);
        }
      },
      async suggestAt(line, column, opts) {
        const ed = focusedCtx()?.editorRef.current;
        if (!ed || !Number.isFinite(line) || !Number.isFinite(column)) return { items: [], count: 0 };
        const target = { lineNumber: Math.max(1, Math.floor(line)), column: Math.max(1, Math.floor(column)) };
        const timeoutMs = clampTimeoutMs(opts?.timeoutMs, SUGGEST_TIMEOUT_DEFAULT_MS);
        const limit = clampInt(opts?.limit, SUGGEST_LIMIT_DEFAULT, 1, 500);
        try {
          ed.setPosition(target);
          ed.focus();
          ed.trigger('kojo-debug', 'editor.action.triggerSuggest', {});
          const rows = await waitForSuggestRows(timeoutMs);
          const mapped = mapSuggestRows(rows.map(readSuggestRow));
          return { items: mapped.slice(0, limit), count: mapped.length };
        } catch {
          return { items: [], count: 0 };
        } finally {
          try {
            // 与契约同形：source='keyboard'，handlerId='hideSuggestWidget'
            ed.trigger('keyboard', 'hideSuggestWidget', null);
          } catch {
            /* 收起失败不影响已读到的候选 */
          }
        }
      },
      async format() {
        const ed = focusedCtx()?.editorRef.current;
        const model = ed?.getModel();
        if (!ed || !model) return { ok: false, changed: false, before: 0, after: 0, elapsedMs: 0 };
        const before = model.getValueLength();
        const startedAt = performance.now();
        const finish = (ok: boolean): DebugFormatReading => {
          const after = model.getValueLength();
          return { ok, changed: after !== before, before, after, elapsedMs: Math.round(performance.now() - startedAt) };
        };
        try {
          const action = ed.getAction('editor.action.formatDocument');
          if (!action) return finish(false);
          await action.run();
          return finish(true);
        } catch {
          // provider 抛错时内容可能已改了一半：仍然给出真实的前后长度，ok=false 如实
          return finish(false);
        }
      },
      setSelection(startLine, startColumn, endLine, endColumn) {
        const ed = focusedCtx()?.editorRef.current;
        const model = ed?.getModel();
        if (!ed || !model) return false;
        if (![startLine, startColumn, endLine, endColumn].every((n) => Number.isFinite(n))) return false;
        try {
          const lineCount = model.getLineCount();
          const sl = Math.min(Math.max(1, Math.floor(startLine)), lineCount);
          const el = Math.min(Math.max(1, Math.floor(endLine)), lineCount);
          const sc = Math.min(Math.max(1, Math.floor(startColumn)), model.getLineMaxColumn(sl));
          const ec = Math.min(Math.max(1, Math.floor(endColumn)), model.getLineMaxColumn(el));
          ed.setSelection({ startLineNumber: sl, startColumn: sc, endLineNumber: el, endColumn: ec });
          return true;
        } catch {
          return false;
        }
      },
      revealLine(line, reveal) {
        const ed = focusedCtx()?.editorRef.current;
        const model = ed?.getModel();
        if (!ed || !model || !Number.isFinite(line)) return false;
        const target = Math.min(Math.max(1, Math.floor(line)), model.getLineCount());
        try {
          // 公开面只有 center / nearTop 两个定位变体；'bottom' 没有对应 API，
          // 用 revealLine（最小滚动，已是能保证可见的最接近语义）兜住，不编造对齐。
          if (reveal === 'center') ed.revealLineInCenter(target);
          else if (reveal === 'top') ed.revealLineNearTop(target);
          else ed.revealLine(target);
          return true;
        } catch {
          return false;
        }
      },
      foldingRanges() {
        const ed = focusedCtx()?.editorRef.current;
        if (!ed) return null;
        return foldingRangesOf(ed);
      },
      selfCheck() {
        // 每一步都自己吞错 + 末尾 `summarizeSelfCheck` 归一：`ok===false` 也不许抛，
        // 已有的 hoverAt / suggestAt / foldingRanges 行为一个字节都不变。
        try {
          return readSelfCheckRaw();
        } catch {
          return summarizeSelfCheck(null);
        }
      },
      async tokens(lineFrom, lineTo) {
        const ed = focusedCtx()?.editorRef.current;
        const model = ed?.getModel();
        if (!ed || !model) return [];
        if (!Number.isFinite(lineFrom) || !Number.isFinite(lineTo)) return [];
        try {
          // dev 下与应用同一模块实例（PITFALLS 247 的那条 `import('/src/monaco/entry.ts')` 同源）
          const monaco = await import('../monaco/entry');
          const lineCount = model.getLineCount();
          const from = Math.min(Math.max(1, Math.floor(lineFrom)), lineCount);
          const to = Math.min(Math.max(1, Math.floor(lineTo)), lineCount);
          if (to < from) return [];
          const languageId = model.getLanguageId();
          const out: DebugTokenLine[] = [];
          for (let line = from; line <= to; line += 1) {
            // tokenize 吃的是"一行文本"：多行一起喂会被当成一行，行号就对不上了
            const raw = monaco.editor.tokenize(model.getLineContent(line), languageId);
            const tokens = (raw[0] ?? []).map((token) => ({ type: token.type, startIndex: token.offset }));
            out.push({ line, tokens });
          }
          return out;
        } catch {
          return [];
        }
      },
    },
    invoke(cmd, args) {
      return invoke(cmd, args);
    },
    dialogPolicy: {
      arm(value) {
        armChooseDir(value);
        // 真壳里拦截腿没就位 ⇒ arm 不会有任何应答，别留"armed 但没人消费"的假状态：清掉并如实抛
        if (isTauri() && !shellDialogInterceptStatus().wrapped) {
          clearChooseDir();
          throw new Error('真壳对话框拦截腿（fetch 包点）未就位，arm 不会生效——如实失败');
        }
        return armedChooseDir();
      },
      armed: () => armedChooseDir(),
      clear: () => clearChooseDir(),
      status: () => ({ mode: isTauri() ? ('shell' as const) : ('web-debug' as const), shellFetchWrapped: shellDialogInterceptStatus().wrapped }),
    },
    perf: {
      start: (opts) => probe.start(opts),
      stop: () => probe.stop(),
      isRunning: () => probe.isRunning(),
      lastReport: () => probe.lastReport(),
      summary: () => {
        const r = probe.lastReport();
        return r ? summarizeReport(r) : null;
      },
    },
    dom: {
      snapshot() {
        return snapshotDocument(document);
      },
    },
  };
  (window as unknown as { __kojoDebug?: KojoDebugApi }).__kojoDebug = api;
  console.info(
    `[kojo-debug] 调试面已安装（mode=${api.mode}，host=${api.host ?? '（桌面壳直连 IPC）'}；API 见 window.__kojoDebug）`,
  );
  return api;
}
