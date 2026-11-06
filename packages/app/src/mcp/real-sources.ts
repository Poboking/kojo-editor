/**
 * MCP 真源腿 · 语义面与组装器（A3：消灭可接而未接的 NOT_WIRED，只接真源）。
 *
 * 覆盖：semantic 8 腿（definitionAt / referencesAt / diagnostics / hoverAt / suggestAt /
 * documentSymbols / tokens / codeActionsAt —— 全部只读，绝不 apply codeAction）、
 * runSupplemental 的 UI 腿（document.active / editor.info / editor.cursor / editor.selfCheck /
 * problems.diagnostics / lang.foldingRanges / lang.highlightsAt / lang.signatureAt /
 * lang.markers）、resource 数据源的 diagnostics / active-document 两个 URI、
 * `mcp.prompt` 槽贡献收集、内核事件环形缓冲。
 *
 * 纪律（POOL-HANDOFF §3.1 / ADR-0013）：
 * - 本模块只被 ShellLayout 的 MCP 登记点动态 import 装载，不进 ps10 开机静态图；
 *   顶层不 import Monaco / editor-pane-registry / bridge / kernel 运行时——全部在
 *   腿调用时动态 import 或经 `McpRealSourceInjection` 注入（测试给假实现，不起 GUI）。
 * - 语义取数只走**纯读通道**：definition / references 走装配点登记的判据腿
 *   （`editor-pane-registry.semanticLegsNow()`——provider 那条路会发 revealLocation
 *   打开文件，有副作用，MCP 只读面**不退到它**，判据腿缺席即显式 NOT_WIRED）；
 *   hover / suggest / symbols / folding / highlights / signature / codeActions 走
 *   provider 注册表直调（与真人菜单同源、不改编辑器状态）；诊断走 `getModelMarkers`。
 * - codeActionsAt 只投影「有哪些动作」，绝不调 command、绝不碰 edit 内容。
 * - 失败显式 `{code,message}`；无活动编辑器 / 无项目 / 判据腿未装配一律
 *   `NOT_WIRED` / `RESOURCE_UNAVAILABLE` 可见，不吞错、不伪造读数、不空串冒充成功。
 * - 第五波（LaneH / Wave4 #4）：editor.openDocument / editor.revealPosition 两枚 edit 档工具
 *   经判性确认「宿主没有可从 MCP 注入面安全复用、能诚实回报结果的打开 / 定位通道」，
 *   按铁律刻意不登记（真源不存在 ⇒ 不登记）：不进工具清单 / 不进真源腿表；
 *   `buildRealMcpSources` 的 runSupplemental 分发仍保留前置兜底，对误调显式抛 NOT_WIRED，
 *   绝不 emit fire-and-forget 的 `editor.revealLocation` 冒充打开成功；只读 editor.cursor
 *   是分开记账的加法（纯读焦点编辑器光标），绝不冒充写工具。
 * - promptSlots 只从 `mcp.prompt` 槽收集 adapter 贡献（骨架绝不硬编码领域知识）；
 *   无贡献 ⇒ 显式空数组（骨架并入的开关按契约保留）。
 */
import { McpFailure, collectPromptSlotFragments } from '@kojo/mcp-host';
import type {
  McpHostDeps,
  McpPromptSlotContributionLike,
  McpPromptSlotFragment,
  McpReaderFn,
  McpSessionScope,
} from '@kojo/mcp-host';
import { KERNEL_EVENT_NAMES } from '@kojo/plugin-api';
import type { EditorCommandContext, EditorSymbolLocation } from '@kojo/plugin-api';
import type { CommandEntry } from '../ui/commands';
import { registerMcpWiringSources, type McpWiringSources } from './wiring';
import {
  clampInt,
  createIoResourceData,
  createKernelIo,
  createRunSupplemental,
  KOJO_RESOURCE_URIS,
  normalizeRoot,
  requireProject,
  sanitizeEcho,
  truncateChars,
  type McpInvokeLike,
  type McpIoDeps,
  type McpKernelLike,
  type McpResourceDataReader,
  type McpSearchRequestLike,
  type McpSearchResultLike,
} from './real-sources-io';

/* ------------------------------- 语义面的注入形状 ------------------------------- */

export interface McpMarkerLike {
  readonly resource: unknown;
  readonly severity: number;
  readonly message: string;
  readonly startLineNumber: number;
  readonly startColumn?: number;
  readonly owner?: string;
  readonly source?: string;
}

/** 焦点 model 的最窄投影（真 ITextModel 结构满足；测试给假对象）。 */
export interface McpSemanticModel {
  readonly uri: { toString(): string };
  getLineCount(): number;
  getLineMaxColumn(line: number): number;
  getLineContent(line: number): string;
  getLanguageId(): string;
  getEOL(): string;
  getValue(): string;
}

/** Monaco 模块的最窄投影（真 `monaco-editor/editor/editor.api` 结构满足）。 */
export interface McpSemanticMonaco {
  readonly Position: new (line: number, column: number) => unknown;
  readonly Range: new (startLine: number, startColumn: number, endLine: number, endColumn: number) => unknown;
  readonly CancellationTokenSource: new () => { readonly token: unknown; dispose(): void };
  readonly editor: {
    readonly tokenize: (text: string, languageId: string) => readonly { readonly type: string; readonly offset: number }[][];
    readonly getModelMarkers: (filter: Record<string, unknown>) => readonly McpMarkerLike[];
  };
}

export interface McpSemanticWorkspace {
  readonly model: McpSemanticModel;
  readonly monaco: McpSemanticMonaco;
  /** 光标（1 基；来自焦点编辑器而非 model——model 不知道光标）。 */
  readonly cursor: { readonly line: number; readonly column: number };
  readonly rootDir: string | null;
}

/** 判据腿登记簿的最窄投影（真 `SemanticLegs` 结构满足）。 */
export interface McpSemanticLegsLike {
  readonly definition: (model: unknown, position: unknown) => readonly EditorSymbolLocation[];
  readonly references: (
    model: unknown,
    position: unknown,
  ) => { readonly path: string; readonly locations: readonly EditorSymbolLocation[] } | null;
}

interface FeatureRegistryLike {
  readonly ordered?: (model: unknown) => readonly unknown[];
}

/** `ILanguageFeaturesService` 的最窄投影（0.57 构造字段名逐字核对过）。 */
export interface McpLanguageFeaturesLike {
  readonly definitionProvider?: FeatureRegistryLike;
  readonly referenceProvider?: FeatureRegistryLike;
  readonly codeActionProvider?: FeatureRegistryLike;
  readonly signatureHelpProvider?: FeatureRegistryLike;
  readonly documentSymbolProvider?: FeatureRegistryLike;
  readonly documentHighlightProvider?: FeatureRegistryLike;
  readonly hoverProvider?: FeatureRegistryLike;
  readonly completionProvider?: FeatureRegistryLike;
  readonly foldingRangeProvider?: FeatureRegistryLike;
  readonly codeLensProvider?: FeatureRegistryLike;
  readonly selectionRangeProvider?: FeatureRegistryLike;
}

export interface McpSemanticDeps {
  readonly getMonaco: () => Promise<unknown | null> | unknown | null;
  readonly getWorkspace: () => Promise<McpSemanticWorkspace | null> | McpSemanticWorkspace | null;
  readonly getLegs: () => Promise<unknown> | unknown;
  readonly getFeaturesService: () => Promise<unknown> | unknown;
  readonly getRootDir: () => string | null;
}

const SEMANTIC_TIMEOUT_MS = 2_000;
const HOVER_TEXT_LIMIT = 2_000;
const HOVER_ROW_LIMIT = 40;
const HOVER_ROW_CHAR_LIMIT = 300;
const DEFINITION_LIMIT = 20;
const REFERENCE_LIMIT = 50;
const CODE_ACTION_LIMIT = 30;
const SYMBOL_LIMIT = 200;
const DIAGNOSTIC_LIMIT = 200;
const TOKEN_WINDOW_LIMIT = 200;
const SUGGEST_LIMIT = 50;
const FOLDING_LIMIT = 500;
const HIGHLIGHT_LIMIT = 50;
const PARAMETER_LIMIT = 50;
const SYMBOL_DEPTH_LIMIT = 20;

/* ------------------------------- 通用小件 ------------------------------- */

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

async function unwrapGetter<T>(value: Promise<unknown> | unknown): Promise<T | null> {
  return (await value) as T | null;
}

function severityName(sev: unknown): string {
  if (sev === 1) return 'hint';
  if (sev === 2) return 'info';
  if (sev === 4) return 'warning';
  if (sev === 8) return 'error';
  return 'unknown';
}

/** provider 回包展开成条目数组：数组摊平、`{value:[...]}`（Signal 形态）解一层。 */
function pushProviderResults(out: unknown[], raw: unknown): void {
  if (raw === null || raw === undefined) return;
  if (Array.isArray(raw)) {
    out.push(...raw);
    return;
  }
  if (typeof raw === 'object') {
    const holder = raw as { value?: unknown };
    if (holder.value !== undefined) {
      pushProviderResults(out, holder.value);
      return;
    }
  }
  out.push(raw);
}

/** 注册表条目 → provider（0.57 的 `ordered()` 已拆包返 provider 本体；包装形态也认）。 */
function unwrapProvider(entry: unknown, method: string): unknown | null {
  if (!entry || typeof entry !== 'object') return null;
  const wrapped = (entry as { provider?: unknown }).provider;
  if (wrapped && typeof wrapped === 'object') return wrapped;
  return typeof (entry as Record<string, unknown>)[method] === 'function' ? entry : null;
}

function providersOf(registry: FeatureRegistryLike | undefined, model: unknown, method: string): unknown[] {
  if (!registry || typeof registry.ordered !== 'function') return [];
  try {
    const entries = registry.ordered(model);
    if (!Array.isArray(entries)) return [];
    const out: unknown[] = [];
    for (const entry of entries) {
      const provider = unwrapProvider(entry, method);
      if (provider) out.push(provider);
    }
    return out;
  } catch {
    return [];
  }
}

/** 一次 provider 调用：同步抛 / 异步 reject / 挂死三种失败都归 null（provider 是第三方代码）。 */
async function callWithin<T>(timeoutMs: number, task: () => T | Promise<T>): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => done(null), timeoutMs);
    const done = (value: T | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let produced: T | Promise<T>;
    try {
      produced = task();
    } catch {
      done(null);
      return;
    }
    Promise.resolve(produced).then((value) => done(value ?? null), () => done(null));
  });
}

interface ProviderCollectStats {
  asked: number;
  answered: number;
  readonly unreachable: boolean;
}

/**
 * 逐 provider 取数：单条抛错只丢它自己。返回原始条目与三态账
 * （unreachable = 没问到 / asked = 无人应答或有人答 / answered = 交回了可辨认结果）。
 */
async function collectFromProviders(
  registry: FeatureRegistryLike | undefined,
  method: string,
  workspace: McpSemanticWorkspace,
  makeArgs: (token: unknown) => unknown[],
): Promise<{ readonly raw: unknown[]; readonly stats: ProviderCollectStats }> {
  const raw: unknown[] = [];
  const providers = providersOf(registry, workspace.model, method);
  const stats: ProviderCollectStats = {
    asked: providers.length,
    answered: 0,
    unreachable: registry === undefined || typeof registry.ordered !== 'function',
  };
  if (providers.length === 0) return { raw, stats };
  const cts = new workspace.monaco.CancellationTokenSource();
  try {
    for (const provider of providers) {
      const fn = (provider as Record<string, unknown>)[method];
      if (typeof fn !== 'function') continue;
      const result = await callWithin(SEMANTIC_TIMEOUT_MS, () =>
        (fn as (...args: unknown[]) => unknown).apply(provider, makeArgs(cts.token)),
      );
      if (result !== null && result !== undefined) stats.answered += 1;
      pushProviderResults(raw, result);
    }
  } finally {
    cts.dispose();
  }
  return { raw, stats };
}

/* ------------------------------- 路径与位置投影 ------------------------------- */

/** URI / 路径文本归一：解百分号编码 → 拆 file:// → 分隔符统一（半截编码按原文继续）。 */
function normalizeUriPath(raw: unknown): string {
  let text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return '';
  if (text.includes('%')) {
    try {
      text = decodeURIComponent(text);
    } catch {
      /* 半截编码：按原文继续，绝不抛 */
    }
  }
  const fileMatch = /^file:\/\/(\/?)(.*)$/i.exec(text);
  if (fileMatch) {
    const rest = fileMatch[2] ?? '';
    if (/^[A-Za-z]:/.test(rest)) text = rest;
    else if (fileMatch[1] === '') text = rest === '' ? '' : `//${rest}`;
    else text = `/${rest}`;
  }
  return text.replace(/\\/g, '/');
}

/** 跳转目标 → 项目根内相对路径（前缀必须落在分隔符上；不是前缀 ⇒ 归一后原样返回）。 */
export function toRelativeLocationPath(rawPath: unknown, rootDir: string | null): string {
  const text = normalizeUriPath(rawPath);
  if (text === '') return '';
  const root = rootDir === null ? null : normalizeRoot(rootDir);
  if (root === null || root === '/' || text.length <= root.length) return text;
  if (text.slice(0, root.length).toLowerCase() !== root.toLowerCase()) return text;
  if (text[root.length] !== '/') return text;
  return text.slice(root.length + 1);
}

function toPositiveInt(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.floor(v);
  return n >= 1 ? n : null;
}

function readRangeStart(raw: unknown): { readonly line: number; readonly column: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const nested = (r['start'] && typeof r['start'] === 'object' ? r['start'] : {}) as Record<string, unknown>;
  const line = toPositiveInt(r['startLineNumber'] ?? nested['lineNumber'] ?? nested['line']);
  if (line === null) return null;
  const column = toPositiveInt(r['startColumn'] ?? nested['column'] ?? nested['character']) ?? 1;
  return { line, column };
}

function readRangeFull(
  raw: unknown,
): { readonly line: number; readonly column: number; readonly endLine: number; readonly endColumn: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const start = readRangeStart(raw);
  if (start === null) return null;
  const nestedEnd = (r['end'] && typeof r['end'] === 'object' ? r['end'] : {}) as Record<string, unknown>;
  const endLine =
    toPositiveInt(r['endLineNumber'] ?? nestedEnd['lineNumber'] ?? nestedEnd['line']) ?? start.line;
  const endColumn = toPositiveInt(r['endColumn'] ?? nestedEnd['column'] ?? nestedEnd['character']) ?? start.column;
  return { ...start, endLine, endColumn };
}

/** 判据腿落点 → 读数形状（列缺席 ⇒ 1；行非正整条丢弃——定位不到的留着只污染读数）。 */
function slimLegLocations(
  locations: readonly EditorSymbolLocation[],
  rootDir: string | null,
  limit: number,
): { readonly path: string; readonly line: number; readonly column: number }[] {
  const out: { readonly path: string; readonly line: number; readonly column: number }[] = [];
  for (const location of locations) {
    if (out.length >= limit) break;
    if (!location || typeof location !== 'object') continue;
    const path = toRelativeLocationPath(location.filePath, rootDir);
    if (path === '') continue;
    const line = toPositiveInt(location.line);
    if (line === null) continue;
    out.push({ path, line, column: toPositiveInt(location.column) ?? 1 });
  }
  return out;
}

/** provider 的 Location / LocationLink → 读数形状（脏条目整条丢弃，不编造）。 */
function slimProviderLocations(
  raw: unknown[],
  rootDir: string | null,
  limit: number,
): { readonly path: string; readonly line: number; readonly column: number }[] {
  const out: { readonly path: string; readonly line: number; readonly column: number }[] = [];
  for (const item of raw) {
    if (out.length >= limit) break;
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const path = toRelativeLocationPath(r['uri'] ?? r['targetUri'], rootDir);
    if (path === '') continue;
    const start = readRangeStart(r['range'] ?? r['targetSelectionRange'] ?? r['targetRange']);
    if (start === null) continue;
    out.push({ path, line: start.line, column: start.column });
  }
  return out;
}


async function requireWorkspace(deps: McpSemanticDeps): Promise<McpSemanticWorkspace> {
  const ws = await unwrapGetter<McpSemanticWorkspace>(deps.getWorkspace());
  if (!ws || !ws.model || !ws.monaco) {
    throw new McpFailure('NOT_WIRED', '语义读数未接线：当前没有活动编辑器（不静默、不伪造读数）');
  }
  return ws;
}

function slimMarkerList(raw: readonly McpMarkerLike[], cap: number): {
  readonly items: Record<string, unknown>[];
  readonly total: number;
  readonly truncated: boolean;
} {
  const items: Record<string, unknown>[] = [];
  for (const m of raw) {
    if (items.length >= cap) break;
    if (!m || typeof m !== 'object') continue;
    const message = asString(m['message']).replace(/\s+/g, ' ').trim();
    items.push({
      message: message.length > 300 ? `${message.slice(0, 300)}…` : message,
      line: toPositiveInt(m['startLineNumber']) ?? 1,
      column: toPositiveInt(m['startColumn']) ?? 1,
      severity: severityName(m['severity']),
      ...(m['source'] !== undefined ? { source: asString(m['source']) } : {}),
    });
  }
  return { items, total: raw.length, truncated: raw.length > items.length };
}

/* ------------------------------- 语义 8 腿 ------------------------------- */

/** 行列夹取：越界夹而不是拒（「最后一行」是最常猜的位置）；脏值显式 INVALID_ARGS。 */
function targetOf(ws: McpSemanticWorkspace, line: unknown, column: unknown): { readonly line: number; readonly column: number } {
  if (typeof line !== 'number' || !Number.isFinite(line) || typeof column !== 'number' || !Number.isFinite(column)) {
    throw new McpFailure('INVALID_ARGS', `位置须为数字 line/column：${sanitizeEcho(String(line))}:${sanitizeEcho(String(column))}`);
  }
  const lineCount = Math.max(1, ws.model.getLineCount());
  const ln = Math.min(Math.max(1, Math.floor(line)), lineCount);
  const col = Math.min(Math.max(1, Math.floor(column)), ws.model.getLineMaxColumn(ln));
  return { line: ln, column: col };
}

function requireLegs(deps: McpSemanticDeps): McpSemanticLegsLike {
  const legs = deps.getLegs() as McpSemanticLegsLike | null;
  if (!legs || typeof legs.definition !== 'function' || typeof legs.references !== 'function') {
    throw new McpFailure(
      'NOT_WIRED',
      '跳转判据腿未装配（编辑器未装配 SemanticLegs）：MCP 只读面不走 provider 通道（它有导航副作用）',
    );
  }
  return legs;
}

function hoverReadingOf(raw: unknown): { readonly text: string; readonly rows: string[] } {
  const contents = Array.isArray((raw as Record<string, unknown> | null)?.['contents'])
    ? ((raw as Record<string, unknown>)['contents'] as unknown[])
    : [];
  const rows: string[] = [];
  for (const c of contents) {
    if (typeof c === 'string') {
      rows.push(c);
      continue;
    }
    if (c && typeof c === 'object') {
      const value = (c as Record<string, unknown>)['value'];
      if (typeof value === 'string') rows.push(value);
    }
  }
  const norm = rows
    .map((r) => r.replace(/\s+/g, ' ').trim().slice(0, HOVER_ROW_CHAR_LIMIT))
    .filter((r) => r !== '')
    .slice(0, HOVER_ROW_LIMIT);
  const joined = norm.join('\n');
  const text = joined.length > HOVER_TEXT_LIMIT ? `${joined.slice(0, HOVER_TEXT_LIMIT)}…` : joined;
  return { text, rows: norm };
}

function suggestItemsOf(raw: unknown, cap: number): { readonly items: Record<string, unknown>[]; readonly total: number } {
  const list = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const suggestions = Array.isArray(list['suggestions'])
    ? (list['suggestions'] as unknown[])
    : Array.isArray(raw)
      ? raw
      : [];
  const items: Record<string, unknown>[] = [];
  for (const item of suggestions) {
    if (items.length >= cap) break;
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const labelRaw = s['label'];
    const label = typeof labelRaw === 'string' ? labelRaw : asString((labelRaw as Record<string, unknown> | null)?.['label']);
    if (label === '') continue;
    items.push({
      label,
      detail: asString(s['detail']),
      kind: typeof s['kind'] === 'number' ? s['kind'] : null,
    });
  }
  return { items, total: suggestions.length };
}

/**
 * 文档符号树压平：SlimPage 式账目（铁律 4：截断=truncated 可见）。
 * - `total` = 截断前真实合法符号数：不受 SYMBOL_LIMIT 封顶影响，脏条目（无 name / 非对象）整条不算符号，
 *   不把被截掉的部分洗成「总数就这么少」；
 * - `truncated` = 没全呈现（SYMBOL_LIMIT 封顶 ⇒ total > items.length），显式可见；
 * - SYMBOL_DEPTH_LIMIT 是防病态树的深度防御（原本就整棵超深子树不展开），不是数据封顶口径。
 * 旧消费方只取 items/total：两个旧字段保留（additive），新增 truncated 供新消费方判「没全」。
 */
function flattenSymbols(raw: unknown): {
  readonly items: Record<string, unknown>[];
  readonly total: number;
  readonly truncated: boolean;
} {
  const items: Record<string, unknown>[] = [];
  let total = 0;
  const walk = (nodes: unknown, depth: number): void => {
    if (!Array.isArray(nodes) || depth > SYMBOL_DEPTH_LIMIT) return;
    for (const item of nodes) {
      if (!item || typeof item !== 'object') continue;
      const s = item as Record<string, unknown>;
      if (typeof s['name'] !== 'string' || s['name'] === '') continue;
      total += 1;
      if (items.length < SYMBOL_LIMIT) {
        items.push({ name: s['name'], kind: typeof s['kind'] === 'number' ? s['kind'] : 0, depth });
      }
      walk(s['children'], depth + 1);
    }
  };
  walk(raw, 0);
  return { items, total, truncated: total > items.length };
}

function codeActionsOf(raw: unknown[], cap: number): { readonly items: Record<string, unknown>[]; readonly total: number } {
  const actions: unknown[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const list = (item as Record<string, unknown>)['actions'];
    // CodeActionList{actions,…} 摊 actions（其余是 dispose 句柄）；裸 CodeAction[] 也认。
    if (Array.isArray(list)) actions.push(...list);
    else if ('title' in (item as Record<string, unknown>)) actions.push(item);
  }
  const items: Record<string, unknown>[] = [];
  for (const action of actions) {
    if (items.length >= cap) break;
    if (!action || typeof action !== 'object') continue;
    const a = action as Record<string, unknown>;
    const title = asString(a['title']).replace(/\s+/g, ' ').trim();
    if (title === '') continue;
    const edit = a['edit'];
    // 只读投影：回答「有哪些动作」——绝不调 command、绝不展开 edit 内容。
    items.push({
      title,
      kind: asString(a['kind']),
      isPreferred: a['isPreferred'] === true,
      hasEdit: !!edit && typeof edit === 'object' && Array.isArray((edit as Record<string, unknown>)['edits']) && ((edit as Record<string, unknown>)['edits'] as unknown[]).length > 0,
    });
  }
  return { items, total: actions.length };
}

function signatureOf(raw: unknown): Record<string, unknown> | null {
  const help = raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>)
    ? (raw as Record<string, unknown>)['value']
    : raw;
  if (!help || typeof help !== 'object') return null;
  const h = help as Record<string, unknown>;
  const signatures = Array.isArray(h['signatures']) ? (h['signatures'] as unknown[]) : [];
  if (signatures.length === 0) return null;
  const activeRaw = h['activeSignature'];
  const activeIndex =
    typeof activeRaw === 'number' && Number.isFinite(activeRaw)
      ? Math.min(Math.max(0, Math.floor(activeRaw)), signatures.length - 1)
      : 0;
  const active = signatures[activeIndex];
  if (!active || typeof active !== 'object') return null;
  const s = active as Record<string, unknown>;
  const label = asString(s['label']).replace(/\s+/g, ' ').trim();
  if (label === '') return null;
  const parameters: string[] = [];
  const rawParams = Array.isArray(s['parameters']) ? (s['parameters'] as unknown[]) : [];
  for (const p of rawParams.slice(0, PARAMETER_LIMIT)) {
    const text = typeof p === 'string' ? p : asString((p as Record<string, unknown> | null)?.['label']);
    if (text !== '') parameters.push(text);
  }
  const activeParameter = typeof h['activeParameter'] === 'number' ? Math.min(Math.max(0, Math.floor(h['activeParameter'])), 99) : 0;
  return { label, activeParameter, parameters };
}

/** 语义 8 腿：全部只读；判据腿缺席 / 无活动编辑器一律显式 NOT_WIRED。 */
export function buildSemanticReaders(deps: McpSemanticDeps): NonNullable<McpHostDeps['semantic']> {
  const definitionAt: McpReaderFn = async (args) => {
    const ws = await requireWorkspace(deps);
    const pos = targetOf(ws, args['line'], args['column']);
    const legs = requireLegs(deps);
    const position = new ws.monaco.Position(pos.line, pos.column);
    const locations = legs.definition(ws.model, position);
    const items = slimLegLocations(locations ?? [], ws.rootDir, DEFINITION_LIMIT);
    const total = (locations ?? []).length;
    // 判性：total 原本就是真实数（无造假），但 DEFINITION_LIMIT 封顶 / 脏落点丢弃没有标记 ⇒ 补 truncated。
    return { items, total, truncated: total > items.length };
  };

  const referencesAt: McpReaderFn = async (args) => {
    const ws = await requireWorkspace(deps);
    const pos = targetOf(ws, args['line'], args['column']);
    const legs = requireLegs(deps);
    const includeDeclaration = args['includeDeclaration'] !== false;
    const position = new ws.monaco.Position(pos.line, pos.column);
    const read = legs.references(ws.model, position);
    const all = read === null ? [] : read.locations;
    const kept = includeDeclaration ? all : all.filter((l) => l.kind !== 'definition');
    const items = slimLegLocations(kept, ws.rootDir, REFERENCE_LIMIT);
    // total = 封顶前 kept 的真实数量（includeDeclaration 过滤之后、slim 投影之前）；
    // 脏落点被整条丢弃 + REFERENCE_LIMIT 封顶，都算「没全呈现」⇒ truncated 显式可见，不伪造计数。
    return { items, total: kept.length, truncated: kept.length > items.length };
  };

  const diagnostics: McpReaderFn = async () => {
    const ws = await requireWorkspace(deps);
    const markers = ws.monaco.editor.getModelMarkers({ resource: ws.model.uri });
    return slimMarkerList(markers, DIAGNOSTIC_LIMIT);
  };

  const hoverAt: McpReaderFn = async (args) => {
    const ws = await requireWorkspace(deps);
    const pos = targetOf(ws, args['line'], args['column']);
    const service = (await unwrapGetter<McpLanguageFeaturesLike>(deps.getFeaturesService())) ?? {};
    const position = new ws.monaco.Position(pos.line, pos.column);
    const { raw, stats } = await collectFromProviders(
      service.hoverProvider,
      'provideHover',
      ws,
      (token) => [ws.model, position, token],
    );
    const reading = hoverReadingOf(raw[raw.length - 1] ?? null);
    return { ...reading, line: pos.line, column: pos.column, providers: stats.unreachable ? null : stats.asked, answered: stats.answered };
  };

  const suggestAt: McpReaderFn = async (args) => {
    const ws = await requireWorkspace(deps);
    const pos = targetOf(ws, args['line'], args['column']);
    const service = (await unwrapGetter<McpLanguageFeaturesLike>(deps.getFeaturesService())) ?? {};
    const position = new ws.monaco.Position(pos.line, pos.column);
    const { raw, stats } = await collectFromProviders(
      service.completionProvider,
      'provideCompletionItems',
      ws,
      // triggerKind=1 = Invoke：真人按键触发的就是这一档
      (token) => [ws.model, position, { triggerKind: 1 }, token],
    );
    const { items, total } = suggestItemsOf(raw[raw.length - 1] ?? null, SUGGEST_LIMIT);
    // 判性：total 原本就是真实 suggestions 数（无造假），但 SUGGEST_LIMIT 封顶 / 脏候选丢弃没有标记 ⇒ 补 truncated。
    return { items, count: items.length, total, truncated: total > items.length, providers: stats.unreachable ? null : stats.asked, answered: stats.answered };
  };

  const documentSymbols: McpReaderFn = async () => {
    const ws = await requireWorkspace(deps);
    const service = (await unwrapGetter<McpLanguageFeaturesLike>(deps.getFeaturesService())) ?? {};
    const { raw, stats } = await collectFromProviders(
      service.documentSymbolProvider,
      'provideDocumentSymbols',
      ws,
      (token) => [ws.model, token],
    );
    const { items, total, truncated } = flattenSymbols(raw);
    return { items, total, truncated, providers: stats.unreachable ? null : stats.asked, answered: stats.answered };
  };

  const tokens: McpReaderFn = async (args) => {
    const ws = await requireWorkspace(deps);
    const lineCount = ws.model.getLineCount();
    const from = toPositiveInt(args['lineFrom']) ?? 1;
    const to = toPositiveInt(args['lineTo']) ?? lineCount;
    const start = Math.min(Math.max(1, from), lineCount);
    const endWanted = Math.min(Math.max(1, to), lineCount);
    const end = Math.max(start, Math.min(endWanted, start + TOKEN_WINDOW_LIMIT - 1));
    // 请求的窗口没有被完整满足（文档到头或 200 行窗上限）⇒ 显式 truncated，不冒充完整。
    const truncated = to > end;
    const languageId = ws.model.getLanguageId();
    const items: Record<string, unknown>[] = [];
    for (let line = start; line <= end; line += 1) {
      const raw = ws.monaco.editor.tokenize(ws.model.getLineContent(line), languageId);
      items.push({
        line,
        tokens: (raw[0] ?? []).map((t) => ({ type: t.type, startIndex: t.offset })),
      });
    }
    return { items, total: items.length, truncated };
  };

  const codeActionsAt: McpReaderFn = async (args) => {
    const ws = await requireWorkspace(deps);
    const pos = targetOf(ws, args['line'], args['column']);
    const service = (await unwrapGetter<McpLanguageFeaturesLike>(deps.getFeaturesService())) ?? {};
    const range = new ws.monaco.Range(pos.line, pos.column, pos.line, pos.column);
    const { raw, stats } = await collectFromProviders(
      service.codeActionProvider,
      'provideCodeActions',
      ws,
      (token) => [ws.model, range, { triggerKind: 1, only: undefined }, token],
    );
    const { items, total } = codeActionsOf(raw, CODE_ACTION_LIMIT);
    // 判性：total 原本就是真实 actions 数（无造假），但 CODE_ACTION_LIMIT 封顶 / 脏动作丢弃没有标记 ⇒ 补 truncated。
    return { items, total, truncated: total > items.length, providers: stats.unreachable ? null : stats.asked, answered: stats.answered };
  };

  return { definitionAt, referencesAt, diagnostics, hoverAt, suggestAt, documentSymbols, tokens, codeActionsAt };
}

/* ------------------------------- runSupplemental 的 UI 腿 ------------------------------- */

/** 无项目时的校验层自检：服务缺席 ⇒ NOT_WIRED（写明缺什么，不编造 findings）。 */
function selfCheckFindings(kernel: McpKernelLike | null, maxResults: number): unknown {
  if (!kernel) {
    throw new McpFailure('RESOURCE_UNAVAILABLE', '内核未到场：校验层自检数据源不可用（不静默）');
  }
  const linter = kernel.services.tryGet<{ report?: () => unknown }>('convention.linter');
  if (!linter || typeof linter.report !== 'function') {
    throw new McpFailure('NOT_WIRED', '校验层自检未接线：convention.linter 服务未装配（不静默）');
  }
  const report = linter.report();
  // 报告尚未运行与「运行了且零失败」是两件事：note 字段显式分开，不静默。
  if (!report || typeof report !== 'object') {
    return { items: [], total: 0, truncated: false, note: '校验尚未运行（没有可读的报告；这不是「零失败」）' };
  }
  const failed = (report as Record<string, unknown>)['failedRules'];
  const rules = Array.isArray(failed) ? (failed as unknown[]) : [];
  const items = rules.slice(0, maxResults).map((r) => {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    return { rule: asString(o['ruleId']), message: asString(o['error']), severity: 'error' };
  });
  return { items, total: rules.length, truncated: rules.length > items.length };
}

export function buildUiSupplemental(
  deps: McpSemanticDeps,
  kernel: McpKernelLike | null,
): Map<string, McpReaderFn> {
  const requireWorkspaceOf = async (): Promise<McpSemanticWorkspace> => requireWorkspace(deps);

  const documentActive: McpReaderFn = async (args) => {
    const ws = await requireWorkspaceOf();
    const maxChars = clampInt(args['maxChars'], 8_000, 1, 100_000);
    const text = ws.model.getValue();
    const { text: cut, truncated } = truncateChars(text, maxChars);
    return {
      path: toRelativeLocationPath(ws.model.uri.toString(), ws.rootDir),
      language: ws.model.getLanguageId(),
      cursor: ws.cursor,
      text: cut,
      textLength: text.length,
      truncated,
    };
  };

  const editorInfo: McpReaderFn = async (args) => {
    const ws = await requireWorkspaceOf();
    const section = args['section'] === 'editor' || args['section'] === 'document' ? args['section'] : 'all';
    const editor = {
      languageId: ws.model.getLanguageId(),
      eol: ws.model.getEOL() === '\r\n' ? 'crlf' : 'lf',
      lineCount: ws.model.getLineCount(),
      valueChars: ws.model.getValue().length,
    };
    const document = {
      path: toRelativeLocationPath(ws.model.uri.toString(), ws.rootDir),
      cursor: ws.cursor,
    };
    if (section === 'editor') return { editor };
    if (section === 'document') return { document };
    return { editor, document };
  };

  /**
   * 只读读数加法（LaneH / Wave4 #4）：焦点编辑器光标。
   * 与打开 / 定位缺口判性**分开记账**——这是纯读（getPosition 已在 productionGetWorkspace
   * 取好），不打开文件、不移动光标、不发事件；没有活动编辑器由 requireWorkspace 显式 NOT_WIRED。
   */
  const editorCursor: McpReaderFn = async () => {
    const ws = await requireWorkspaceOf();
    return {
      path: toRelativeLocationPath(ws.model.uri.toString(), ws.rootDir),
      language: ws.model.getLanguageId(),
      line: ws.cursor.line,
      column: ws.cursor.column,
      lineCount: ws.model.getLineCount(),
    };
  };

  const editorSelfCheck: McpReaderFn = async (args) => {
    const maxResults = clampInt(args['maxResults'], 200, 1, 500);
    return selfCheckFindings(kernel, maxResults);
  };

  const problemsDiagnostics: McpReaderFn = async (args) => {
    const monaco = (await unwrapGetter<McpSemanticMonaco>(deps.getMonaco())) ?? null;
    if (!monaco) {
      throw new McpFailure('NOT_WIRED', '诊断读数未接线：Monaco 未到场（不静默）');
    }
    const maxResults = clampInt(args['maxResults'], DIAGNOSTIC_LIMIT, 1, 500);
    const markers = monaco.editor.getModelMarkers({});
    const { items, total, truncated } = slimMarkerList(markers, maxResults);
    return { items, total, truncated };
  };

  const foldingRanges: McpReaderFn = async (args) => {
    const ws = await requireWorkspaceOf();
    const service = (await unwrapGetter<McpLanguageFeaturesLike>(deps.getFeaturesService())) ?? {};
    const { raw, stats } = await collectFromProviders(
      service.foldingRangeProvider,
      'provideFoldingRanges',
      ws,
      (token) => [ws.model, {}, token],
    );
    const maxRanges = clampInt(args['maxRanges'], FOLDING_LIMIT, 1, 2000);
    const items: Record<string, unknown>[] = [];
    for (const item of raw) {
      if (items.length >= maxRanges) break;
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      const start = toPositiveInt(r['start']);
      const end = toPositiveInt(r['end']);
      if (start === null || end === null) continue;
      items.push({ startLine: start, endLine: end, ...(typeof r['kind'] === 'string' ? { kind: r['kind'] } : {}) });
    }
    return { items, total: items.length, truncated: raw.length > items.length, providers: stats.unreachable ? null : stats.asked, answered: stats.answered };
  };

  const highlightsAt: McpReaderFn = async (args) => {
    const ws = await requireWorkspaceOf();
    const pos = targetOf(ws, args['line'], args['column']);
    const service = (await unwrapGetter<McpLanguageFeaturesLike>(deps.getFeaturesService())) ?? {};
    const position = new ws.monaco.Position(pos.line, pos.column);
    const { raw, stats } = await collectFromProviders(
      service.documentHighlightProvider,
      'provideDocumentHighlights',
      ws,
      (token) => [ws.model, position, token],
    );
    const items: Record<string, unknown>[] = [];
    for (const item of raw) {
      if (items.length >= HIGHLIGHT_LIMIT) break;
      if (!item || typeof item !== 'object') continue;
      const holder = item as Record<string, unknown>;
      // DocumentHighlight{range, kind} 形态取 range；provider 直接给 IRange 也认。
      const range = readRangeFull(holder['range'] ?? holder);
      if (range === null) continue;
      items.push({
        ...range,
        kind: typeof holder['kind'] === 'number' ? holder['kind'] : 0,
      });
    }
    return { items, total: items.length, providers: stats.unreachable ? null : stats.asked, answered: stats.answered };
  };

  const signatureAt: McpReaderFn = async (args) => {
    const ws = await requireWorkspaceOf();
    const pos = targetOf(ws, args['line'], args['column']);
    const service = (await unwrapGetter<McpLanguageFeaturesLike>(deps.getFeaturesService())) ?? {};
    const position = new ws.monaco.Position(pos.line, pos.column);
    const { raw } = await collectFromProviders(
      service.signatureHelpProvider,
      'provideSignatureHelp',
      ws,
      (token) => [ws.model, position, token, { triggerKind: 1, isRetrigger: false }],
    );
    // 第一个给得出签名的 provider 就是答案：与 Monaco 对多 provider 的取舍一致。
    for (const item of raw) {
      const reading = signatureOf(item);
      if (reading) return { ...reading, line: pos.line, column: pos.column };
    }
    return null;
  };

  const langMarkers: McpReaderFn = async (args) => {
    const ws = await requireWorkspaceOf();
    const maxResults = clampInt(args['maxResults'], DIAGNOSTIC_LIMIT, 1, 500);
    const markers = ws.monaco.editor.getModelMarkers({ resource: ws.model.uri });
    const { items, total, truncated } = slimMarkerList(markers, maxResults);
    return { items, total, truncated };
  };

  /* ---- 第四波（LaneF）：debug 面让位三腿里另两枚只读 provider 读数 ----
   * 与 highlightsAt / foldingRanges 同一 collectFromProviders 通道（ILanguageFeaturesService 真源），
   * 只读投影原始 provider 结果：不做 resolveCodeLens、不做 UI 合并/排序，明说未解析 / 保留供方原序。 */
  const lensesAt: McpReaderFn = async (args) => {
    const ws = await requireWorkspaceOf();
    const service = (await unwrapGetter<McpLanguageFeaturesLike>(deps.getFeaturesService())) ?? {};
    const { raw, stats } = await collectFromProviders(
      service.codeLensProvider,
      'provideCodeLenses',
      ws,
      (token) => [ws.model, token],
    );
    const maxResults = clampInt(args['maxResults'], 30, 1, 200);
    const line = toPositiveInt(args['line']);
    // provider 返回 CodeLensList{lenses:[...]} 或裸 CodeLens[]：两种都摊成 lens 对象；无可用 range 的整条丢。
    const flat: unknown[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      if (Array.isArray(o['lenses'])) flat.push(...(o['lenses'] as unknown[]));
      else if ('range' in o) flat.push(o);
    }
    const projected: Record<string, unknown>[] = [];
    for (const lens of flat) {
      if (!lens || typeof lens !== 'object') continue;
      const l = lens as Record<string, unknown>;
      const range = readRangeFull(l['range']);
      if (range === null) continue;
      const command = l['command'] && typeof l['command'] === 'object' ? (l['command'] as Record<string, unknown>) : null;
      projected.push({
        ...range,
        title: command ? asString(command['title']) : '',
        commandId: command ? asString(command['id']) : '',
        resolved: command !== null, // MCP 不调 resolveCodeLens：没 command 就是没解出，绝不编造
      });
    }
    const kept = line === null ? projected : projected.filter((p) => line >= (p['line'] as number) && line <= (p['endLine'] as number));
    const items = kept.slice(0, maxResults);
    return { items, total: kept.length, truncated: kept.length > items.length, providers: stats.unreachable ? null : stats.asked, answered: stats.answered };
  };

  const selectionRangesAt: McpReaderFn = async (args) => {
    const ws = await requireWorkspaceOf();
    const pos = targetOf(ws, args['line'], args['column']);
    const service = (await unwrapGetter<McpLanguageFeaturesLike>(deps.getFeaturesService())) ?? {};
    const position = new ws.monaco.Position(pos.line, pos.column);
    const { raw, stats } = await collectFromProviders(
      service.selectionRangeProvider,
      'provideSelectionRanges',
      ws,
      (token) => [ws.model, [position], token],
    );
    const maxChains = clampInt(args['maxChains'], 8, 1, 200);
    // provideSelectionRanges 回 SelectionRange[][]（外层=逐位置）；pushProviderResults 摊一层后
    // raw 的元素是一条链（SelectionRange[]）。兼容 provider 直接给裸对象（单档链）。
    const chains: Record<string, unknown>[][] = [];
    const pushChain = (src: unknown): void => {
      const steps = Array.isArray(src) ? src : [src];
      const ranges: Record<string, unknown>[] = [];
      for (const step of steps) {
        if (!step || typeof step !== 'object') continue;
        const range = readRangeFull((step as Record<string, unknown>)['range']);
        if (range === null) continue;
        ranges.push({ ...range });
      }
      if (ranges.length > 0) chains.push(ranges);
    };
    for (const item of raw) {
      if (Array.isArray(item) || (item && typeof item === 'object')) pushChain(item);
    }
    const items = chains.slice(0, maxChains).map((ranges) => ({ ranges }));
    return { items, total: chains.length, truncated: chains.length > items.length, providers: stats.unreachable ? null : stats.asked, answered: stats.answered };
  };

  return new Map<string, McpReaderFn>([
    ['document.active', documentActive],
    ['editor.info', editorInfo],
    ['editor.cursor', editorCursor],
    ['editor.selfCheck', editorSelfCheck],
    ['problems.diagnostics', problemsDiagnostics],
    ['lang.foldingRanges', foldingRanges],
    ['lang.highlightsAt', highlightsAt],
    ['lang.signatureAt', signatureAt],
    ['lang.markers', langMarkers],
    ['lang.lensesAt', lensesAt],
    ['lang.selectionRangesAt', selectionRangesAt],
  ]);
}

/* ------------------------------- 内核事件环形缓冲 ------------------------------- */

const EVENT_RING_LIMIT = 500;

export interface McpEventRecord {
  readonly t: number;
  readonly name: string;
  readonly payload: unknown;
}

const eventRing = new Array<McpEventRecord | undefined>(EVENT_RING_LIMIT);
let eventHead = 0;
let eventCount = 0;
let eventUnsubs: (() => void)[] = [];
let eventsBoundTo: McpKernelLike | null | undefined;

/** 事件载荷只留摘要形态（大文本 / 深结构不进缓冲，防 JSON 化拖垮读数）。 */
function slimEventPayload(payload: unknown, depth = 0): unknown {
  if (payload === null || payload === undefined) return payload;
  if (typeof payload === 'number' || typeof payload === 'boolean') return payload;
  if (typeof payload === 'string') return payload.length > 200 ? `${payload.slice(0, 200)}…` : payload;
  if (Array.isArray(payload)) {
    return { __arr: payload.length, sample: payload.slice(0, 5).map((p) => slimEventPayload(p, depth + 1)) };
  }
  if (typeof payload === 'object') {
    if (depth >= 2) return '{…}';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload as Record<string, unknown>).slice(0, 12)) {
      out[k] = slimEventPayload(v, depth + 1);
    }
    return out;
  }
  return String(payload);
}

/** 绑定内核事件环形缓冲（幂等：同一内核重复绑定不重复订阅；换内核先退订旧的）。 */
export function bindEventRing(kernel: McpKernelLike | null): void {
  if (eventsBoundTo !== undefined && kernel === eventsBoundTo) return;
  for (const off of eventUnsubs) off();
  eventUnsubs = [];
  eventsBoundTo = kernel;
  eventRing.fill(undefined);
  eventHead = 0;
  eventCount = 0;
  if (!kernel) return;
  for (const name of KERNEL_EVENT_NAMES) {
    eventUnsubs.push(
      kernel.bus.on(name as string, (payload: unknown) => {
        eventRing[eventHead] = { t: performance.now(), name, payload: slimEventPayload(payload) };
        eventHead = (eventHead + 1) % EVENT_RING_LIMIT;
        if (eventCount < EVENT_RING_LIMIT) eventCount += 1;
      }),
    );
  }
}

function recentEvents(max: number): unknown[] {
  const want = Number.isFinite(max) ? Math.floor(max) : 40;
  const k = Math.min(Math.max(0, want), eventCount);
  if (k === 0) return [];
  const out: McpEventRecord[] = [];
  let idx = (eventHead - k + EVENT_RING_LIMIT) % EVENT_RING_LIMIT;
  for (let i = 0; i < k; i += 1) {
    const record = eventRing[idx];
    if (record) out.push(record);
    idx = (idx + 1) % EVENT_RING_LIMIT;
  }
  return out;
}

function countEvents(): number {
  return eventCount;
}

/* ------------------------------- 组装 ------------------------------- */

/** 宿主真源钩子（ShellLayout 持有当拍最新的 ref 与内核实例）。 */
export interface McpRealSourceHost {
  readonly getCommands: () => readonly CommandEntry[];
  readonly getCommandContext: () => EditorCommandContext;
  readonly getKernel: () => unknown;
}

/** 测试 seam（生产缺省走动态 import 的真模块）；给到的项覆盖生产装配。 */
export interface McpRealSourceInjection {
  readonly invoke?: McpInvokeLike;
  readonly searchInFiles?: (request: McpSearchRequestLike) => Promise<McpSearchResultLike>;
  readonly getMonaco?: () => Promise<McpSemanticMonaco | null> | McpSemanticMonaco | null;
  readonly getWorkspace?: () => Promise<McpSemanticWorkspace | null> | McpSemanticWorkspace | null;
  readonly getLegs?: () => Promise<unknown> | unknown;
  readonly getFeaturesService?: () => Promise<unknown> | unknown;
}

function currentRootDirOf(kernel: McpKernelLike | null): string | null {
  try {
    const current = kernel?.project.current();
    if (!current || typeof current !== 'object') return null;
    const root = (current as Record<string, unknown>)['rootDir'];
    return typeof root === 'string' && root !== '' ? root : null;
  } catch {
    return null;
  }
}

/* 生产取数腿：Monaco / 判据腿登记簿 / DI 深路径全部懒装载（模块缓存，极轻）。 */

async function productionGetMonaco(): Promise<unknown | null> {
  try {
    return await import('../monaco/entry');
  } catch {
    return null;
  }
}

function productionGetWorkspace(kernel: McpKernelLike | null): () => Promise<McpSemanticWorkspace | null> {
  return async () => {
    try {
      const [registryMod, monacoRaw] = await Promise.all([
        import('../ui/editor-pane-registry'),
        import('../monaco/entry'),
      ]);
      const ctx = registryMod.focusedCtx();
      const editor = ctx?.editorRef.current ?? null;
      const model = editor?.getModel() ?? null;
      if (!ctx || !editor || !model) return null;
      const pos = editor.getPosition();
      return {
        model: model as unknown as McpSemanticModel,
        monaco: monacoRaw as unknown as McpSemanticMonaco,
        cursor: { line: pos?.lineNumber ?? 1, column: pos?.column ?? 1 },
        rootDir: currentRootDirOf(kernel),
      };
    } catch {
      return null;
    }
  };
}

let legsModulePromise: Promise<typeof import('../ui/editor-pane-registry')> | null = null;

async function productionGetLegs(): Promise<unknown> {
  try {
    legsModulePromise ??= import('../ui/editor-pane-registry');
    return (await legsModulePromise).semanticLegsNow();
  } catch {
    return null;
  }
}

let featuresServicePromise: Promise<unknown> | null = null;

function productionGetFeaturesService(): Promise<unknown> {
  featuresServicePromise ??= (async () => {
    try {
      // @ts-ignore 深路径不带 .d.ts（形态在 monaco 0.57 核对过；同调试面取数腿的判据）
      const services = await import('monaco-editor/editor/standalone/browser/standaloneServices.js');
      // @ts-ignore 同上：ILanguageFeaturesService 是 createDecorator 出来的令牌
      const decorators = await import('monaco-editor/editor/common/services/languageFeatures.js');
      const standalone = (services as { StandaloneServices?: { get(token: unknown): unknown } }).StandaloneServices;
      return standalone?.get((decorators as { ILanguageFeaturesService?: unknown }).ILanguageFeaturesService) ?? null;
    } catch {
      // 打包器不认 exports 映射 / 版本改名：这条路不通 ⇒ null（provider 三态如实 null，不编造）
      return null;
    }
  })();
  return featuresServicePromise;
}

/** `mcp.prompt` 槽贡献 → 领域片段；无内核 / 无贡献 ⇒ 显式空数组（绝不硬编码领域知识）。 */
async function collectPromptSlots(kernel: McpKernelLike | null): Promise<McpPromptSlotFragment[]> {
  if (!kernel) return [];
  let contributions: readonly unknown[] = [];
  try {
    contributions = kernel.slots.query('mcp.prompt');
  } catch {
    contributions = [];
  }
  if (contributions.length === 0) return [];
  const like = contributions as readonly McpPromptSlotContributionLike[];
  return collectPromptSlotFragments(like, {});
}

function buildReadResourceData(
  ioResources: McpResourceDataReader,
  deps: McpSemanticDeps,
): NonNullable<McpHostDeps['readResourceData']> {
  return async (uri: string): Promise<unknown> => {
    switch (uri) {
      case KOJO_RESOURCE_URIS.diagnostics: {
        const monaco = (await unwrapGetter<McpSemanticMonaco>(deps.getMonaco())) ?? null;
        if (!monaco) {
          throw new McpFailure('RESOURCE_UNAVAILABLE', '诊断 resource 未接线：Monaco 未到场（不静默）');
        }
        return monaco.editor.getModelMarkers({}) as unknown[];
      }
      case KOJO_RESOURCE_URIS.activeDocument: {
        const ws = await unwrapGetter<McpSemanticWorkspace>(deps.getWorkspace());
        if (!ws || !ws.model) {
          throw new McpFailure('RESOURCE_UNAVAILABLE', '当前文档 resource 未接线：没有活动编辑器（不静默、不空串冒充）');
        }
        const text = ws.model.getValue();
        const { text: cut, truncated } = truncateChars(text, 8_000);
        return {
          path: toRelativeLocationPath(ws.model.uri.toString(), ws.rootDir),
          language: ws.model.getLanguageId(),
          cursor: ws.cursor,
          text: cut,
          textLength: text.length,
          truncated,
        };
      }
      default:
        return ioResources(uri, null as unknown as McpSessionScope);
    }
  };
}

/**
 * 组装生产真源 `McpWiringSources`（不登记——登记走 `installRealMcpSources`）。
 * 全部真源给到才接；这里组装出的每一腿都指向生产真源，接不到的运行期状态
 * 由腿自身显式抛 `NOT_WIRED` / `RESOURCE_UNAVAILABLE`。
 */
export async function buildRealMcpSources(
  host: McpRealSourceHost,
  injection?: McpRealSourceInjection,
): Promise<McpWiringSources> {
  // 真 Kernel 结构在组装点一次性窄化（project/io/plugins/services/slots/bus 五面逐字段核对过）。
  const kernel = (host.getKernel() ?? null) as unknown as McpKernelLike | null;
  bindEventRing(kernel);

  const ioDeps: McpIoDeps = {
    getKernel: () => kernel,
    getCommands: host.getCommands,
    invoke: injection?.invoke ?? (await import('../bridge/invoke')).invoke,
    searchInFiles:
      injection?.searchInFiles ??
      (await import('../bridge/search')).searchInFiles as unknown as McpIoDeps['searchInFiles'],
  };

  const semanticDeps: McpSemanticDeps = {
    getMonaco: injection?.getMonaco ?? productionGetMonaco,
    getWorkspace: injection?.getWorkspace ?? productionGetWorkspace(kernel),
    getLegs: injection?.getLegs ?? productionGetLegs,
    getFeaturesService: injection?.getFeaturesService ?? productionGetFeaturesService,
    getRootDir: () => currentRootDirOf(kernel),
  };

  const uiSupplemental = buildUiSupplemental(semanticDeps, kernel);
  const ioSupplemental = createRunSupplemental(ioDeps);

  return {
    commands: host.getCommands(),
    commandContext: host.getCommandContext(),
    semantic: buildSemanticReaders(semanticDeps),
    kernelIo: createKernelIo(ioDeps),
    readResourceData: buildReadResourceData(createIoResourceData(ioDeps, recentEvents, countEvents), semanticDeps),
    runSupplemental: (name, args, scope) => {
      // LaneH / Wave4 #4 判性落地（逐条证据见 mcp-host/src/index.ts 第五波注释与 commit 回执）：
      // 宿主没有可从 MCP 注入面安全复用、且能诚实回报结果的「打开文档 / 定位光标」真源。
      // 这两枚 edit 档工具按铁律刻意不登记（真源不存在 ⇒ 不登记 + 显式缺口）：不进
      // SUPPLEMENTAL_TOOL_SPECS / MCP_TOOL_GAP_MAP / buildUiSupplemental / ioTools 腿表。
      // 这里保留前置防御性显式失败：万一有人绕过 registry 直调，调用必得带判性理由的
      // 可见 NOT_WIRED，绝不 emit 一个 fire-and-forget 的 editor.revealLocation 冒充打开成功。
      if (name === 'editor.openDocument' || name === 'editor.revealPosition') {
        throw new McpFailure(
          'NOT_WIRED',
          `工具 ${name} 未接线（Wave4 #4 判性）：宿主没有可从 MCP 注入面安全复用的打开 / 定位通道。` +
            'editor.revealLocation 是 fire-and-forget 事件（无 ack / 无落地确认 / 落地走 React setState ' +
            '异步重渲染 / routeOpenPath 不校验项目根域 / 订阅者只在 GUI 挂载时存在），发射后无法诚实回报执行结果；' +
            'EditorCommandContext / McpRealSourceHost / CommandEntry.run / editor-pane-registry / io.readText ' +
            '全为只读或 void 通道。刻意不接真源腿：调用必得可见 NOT_WIRED，' +
            '绝不返回空串 / 假成功 / 静默成功。只读的活动文档 / 光标读数请用 document.active / editor.info / editor.cursor。',
        );
      }
      const ui = uiSupplemental.get(name);
      if (ui) return ui(args ?? {}, scope);
      return ioSupplemental(name, args ?? {}, scope);
    },
    promptSlots: await collectPromptSlots(kernel),
  };
}

/**
 * 生产登记入口（ShellLayout 的 MCP 登记点调用；幂等——重复调用以最新真源覆盖登记，
 * 事件环形缓冲按内核实例幂等绑定）。cleanup 保持 cancelled 语义，不制造空 deps 窗口。
 */
export async function installRealMcpSources(
  host: McpRealSourceHost,
  injection?: McpRealSourceInjection,
): Promise<void> {
  const sources = await buildRealMcpSources(host, injection);
  registerMcpWiringSources(sources);
}