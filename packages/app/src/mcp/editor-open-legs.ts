/**
 * `editor.openDocument` 的执行腿 —— 「在项目里打开一份文档」这条动作的**可观测回执**
 * （LaneV B10 批，2026-11-06；收口 Wave4 #4 那条 `NOT_WIRED` 判性）。
 *
 * ## 判性（为什么这一枚现在能登记，而 Wave4 #4 当时不能）
 * Wave4 #4（LaneH）的结论**在当时是对的**，它的证据一条都没被推翻：
 * `editor.revealLocation` 至今仍是 fire-and-forget 事件——无 ack、无落地确认、落地走 React setState
 * 异步重渲染、订阅者只在 GUI 挂载时存在。**本批没有给这条事件加 ack，也不许加**（那要改宿主与所有
 * 发起方，属"新造通道"，判据 ① 不允许）。本批改的是另一件事：**观察件第一次真的存在了**。
 * B3 批之后，`editor-write-legs.ts` 已经证明 MCP 面可以在执行时动态 import `livePanes` 并按 paneId
 * 反查登记簿里的 ref 壳（`filePathRef` / `entriesRef` / `editorRef` / `sugarModelRef`）。于是
 * 「这条 path 到底有没有真的上屏」从一个推断，变成一个**读得回来的事实**：
 * 发射意图 → 有界轮询登记簿 → 读到「某个实例的活动文件就是它，且上屏的 model 就是它那一份标签的
 * model」才算打开成功；读不到就显式失败，并交代等了多久、看到几个实例、每个实例正显示什么、
 * 为什么判它没打开。这正是把 fire-and-forget 变成有回执的那块新砖——**机制一条没加，观察加了一层**。
 *
 * ## 三条不许越界的纪律
 * 1. **不新造第二套跳转**（判据 ①）：执行体就是宿主既有的 `editor.revealLocation`
 *    （`ui/App.tsx` 的「通用导航意图」落地处，与转到定义 / 问题面板 / 大纲 / 面包屑同一条路），
 *    MCP 侧只 `emit` + 只读登记簿。本模块零 `requestOpenFile`、零 React、零新事件、零新宿主能力。
 * 2. **路径闸与只读面同尺**（判据 ③）：入参只收**项目根内相对路径**，过的是 `fs.readFile` 那一条
 *    `resolveWithinRoot`（= `validateRelativePath` 形态闸 + resolve 后前缀复核，fail-closed）。
 *    Wave4 #4 里「`routeOpenPath` 不校验项目根域」这一条**由本腿在 MCP 侧补上**：绝对路径 / 盘符 /
 *    `..` 一律 `INVALID_ARGS`，宿主事件永远拿不到域外落点。附带一条诚实红利：目标既已锚在当前根内，
 *    `routeOpenPath` 的「换个项目再开」分支构造上不可达，落地必然发生在本会话的登记簿里。
 * 3. **打开文档不写盘、不改正文**（判据 ⑦）：本腿不碰 `kernel.io` 的任何写原语、不 `invoke`、
 *    不改模型、不改光标；回包恒定 `saved:false` + `persisted:false` + `contentChanged:false`；
 *    落盘仍是 `fileTree.update` 双闸 / `exportFile` 对话框那两条法定路（铁律 5/6/7：零新增写盘通道）。
 *
 * ## 观察窗常量（判据 ②：窗口与上限必须是常量并写依据）
 * - `OPEN_DOCUMENT_DEADLINE_MS_DEFAULT = 3_000`：落地链路 = 总线回调 → React setState → 重渲染 →
 *   EditorPane 装载 model（一次 `io.readText` IPC）→ `filePathRef` 随 effect 追平。同一链路上已有的
 *   机器面预算是 `mcp/real-sources.ts` 的 `SEMANTIC_TIMEOUT_MS = 2_000`（纯 provider 读数）与
 *   `tools/debug-cli.mjs` 的开项目窗下限 `OPEN_TIMEOUT_MIN_MS = 3_000`；本窗取后者——比纯读数多给
 *   一次开文件的重渲染预算。
 * - `OPEN_DOCUMENT_DEADLINE_MS_MAX = 10_000`：压在 `mcp/host-bridge.ts` 的整条请求预算
 *   `DEFAULT_TIMEOUT_MS = 30_000` 之内并留 3 倍余量——端点不许被一次 UI 落地拖到超时。
 * - `OPEN_DOCUMENT_POLL_INTERVAL_MS = 25`：一轮 React 提交（含 Monaco `setModel`）在十几毫秒量级，
 *   25ms ≈ 缺省窗内 120 次采样，够细又不会盖过渲染本身（同仓另一条轮询 `debug/install-debug.ts` 的
 *   `LANGUAGE_POLL_INTERVAL_MS = 50` 等的是语言服务就绪这类慢事件，本地重渲染取它的一半）。
 *
 * ps10 纪律：`ui/*`（`livePanes` 登记簿）只在**执行时**动态 import（与 `editor-write-legs.ts` /
 * `quick-fix.ts` 同款）；本模块本身只被 `real-sources-io.ts` 静态引，而那条链整体在 `ShellLayout`
 * 的动态边之下 ⇒ 开机静态图零新增（`pnpm --filter @kojo/app test ps10-eager-graph` 会盯着这条）。
 */
import { McpFailure } from '@kojo/mcp-host';
import type { McpReaderFn } from '@kojo/mcp-host';

/* ------------------------------- 观察窗常量 ------------------------------- */

/** 缺省落地窗（依据见模块头「观察窗常量」）。 */
export const OPEN_DOCUMENT_DEADLINE_MS_DEFAULT = 3_000;
/** 调用方可要求的窗上限（依据见模块头「观察窗常量」）。 */
export const OPEN_DOCUMENT_DEADLINE_MS_MAX = 10_000;
/** 调用方可要求的最短窗：低于一拍 React 提交，读数只会是噪声。 */
export const OPEN_DOCUMENT_DEADLINE_MS_MIN = 100;
/** 轮询间隔（依据见模块头「观察窗常量」）。 */
export const OPEN_DOCUMENT_POLL_INTERVAL_MS = 25;
/** 失败账里最多逐个列出的实例数（再多只报数，不冲垮回包）。 */
export const OPEN_DOCUMENT_FAILURE_PANE_SAMPLE = 8;

/** 执行体复用的宿主既有通道名（**发射**用的就是这一条，本批零新事件）。 */
export const EDITOR_OPEN_CHANNEL = 'editor.revealLocation';
/** 事件载荷的 `source` 标记：不是 adapter / plugin id，落地方只当「谁发起的」读，不据此授权。 */
export const EDITOR_OPEN_SOURCE_MARK = 'mcp:editor.openDocument';

/* ------------------------------- 登记簿读数形状 ------------------------------- */

/**
 * 一个编辑器实例在**此刻**的登记簿读数（生产由 `productionObserveEditorPanes` 现扫 `livePanes`
 * 的 ref 壳得到；测试注入假件）。全部是读回来的事实，本模块不写任何一位。
 */
export interface EditorOpenPaneObservation {
  readonly paneId: string;
  /** 该实例此刻的活动文件（`filePathRef.current`，宿主路径原样字符串；空 ⇒ null）。 */
  readonly filePath: string | null;
  /** `filePathRef` 归一后是否就是目标（比较走 `@kojo/plugin-api` 的 `pathKey`）。 */
  readonly filePathIsTarget: boolean;
  /** 该实例的标签表（`entriesRef`）里有没有目标这一条 = 文档是否真被开出来。 */
  readonly hasTargetTab: boolean;
  /** 此刻上屏的 model 是否**正是**目标那一份原文 model（挡住 `EditorPane.tsx` 那条「新路径 + 旧 model」竞态）。 */
  readonly displaysTargetModel: boolean;
  /** 此刻上屏的是不是这一份文档的糖投影（派生视图；原文标签也在表里才算）。 */
  readonly displaysTargetSugar: boolean;
  /** 该实例的标签数（失败账用：证明「登记簿确实在动」）。 */
  readonly tabCount: number;
  /** 目标那一份原文 model 的读数（标签在表里才读得到；拿不到 ⇒ null，不编造）。 */
  readonly lineCount: number | null;
  readonly language: string | null;
  /** 此刻上屏那份 model 的 uri（只作回显事实，**不参与判定**：判定只认登记簿里的宿主路径）。 */
  readonly modelUri: string | null;
  /** 此刻上屏那份编辑器的只读读数（读不到 ⇒ null，不编造 `false`）。 */
  readonly readOnly: boolean | null;
}

/** 一轮登记簿观察的结果；`panes:null` = 登记簿根本读不到（GUI 未挂载 / ui 模块装载失败）。 */
export interface EditorOpenObservation {
  readonly panes: readonly EditorOpenPaneObservation[] | null;
  /** `panes:null` 时的如实原因（缺席也要可读，不静默）。 */
  readonly reason?: string;
}

export type EditorOpenObserver = (
  targetAbs: string,
) => Promise<EditorOpenObservation> | EditorOpenObservation;

/** 发射意图的记账（回包原样带上，让调用方看见「走的是哪条通道、有没有人听」）。 */
export interface EditorOpenIntentReceipt {
  readonly emitted: boolean;
  readonly channel: string;
  /** 通道（内核总线 `emit`）是否**被验过**在场：未被验证的分支一律 false，不宣称可用性。 */
  readonly channelAvailable: boolean;
  /** 该事件的订阅者数（`bus.listenerCount` 读数；读不到 ⇒ null，不编造）。 */
  readonly subscribers: number | null;
  readonly note: string;
}

/**
 * 发射腿形状：入参是**已过项目根闸的绝对路径**（腿内部只会传 `resolveWithinRoot` 的产物，
 * 域外路径永远到不了这里）。
 */
export type EditorOpenEmitter = (targetAbs: string) => EditorOpenIntentReceipt;

/** 注入面（生产装配在 `real-sources-io.ts`；测试给假件）。 */
export interface McpEditorOpenDeps {
  /** 项目根读数腿（生产 = `requireProject(kernel)` 的 `rootDir`）；缺席或空 ⇒ 显式 RESOURCE_UNAVAILABLE。 */
  readonly getRootDir?: () => string | null;
  /** 相对路径 → 根内绝对路径（生产注入 `resolveWithinRoot`，与 `fs.readFile` 同尺）。 */
  readonly resolveWithinRoot?: (rootDir: string, relPath: string) => string;
  /** 发射既有宿主事件（生产 = `productionEmitOpenIntent(() => kernel.bus)`）。 */
  readonly emitIntent?: EditorOpenEmitter;
  /** 登记簿观察（生产 = 动态 import `livePanes` 现扫）。 */
  readonly observePanes?: EditorOpenObserver;
  /** 轮询休眠（测试注入即时实现，把整窗压成毫秒级）。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 时钟（测试注入假钟，令超时账可断言）。 */
  readonly now?: () => number;
}

/* ------------------------------- 入参闸 ------------------------------- */

function requireRelPath(args: Record<string, unknown>): string {
  const raw = args['relPath'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new McpFailure(
      'INVALID_ARGS',
      '[E_EDITOR_INVALID_ARGS] editor.openDocument 缺 relPath：本面只收**项目根内相对路径**（与 fs.readFile 同一条闸），不收绝对路径 / 盘符 / ".." 上跳。',
    );
  }
  const relPath = raw.trim();
  if (relPath.length > 512) {
    throw new McpFailure('INVALID_ARGS', `[E_EDITOR_INVALID_ARGS] relPath 过长（${relPath.length} > 512）`);
  }
  return relPath;
}

/** 观察窗覆写入参：只收落在 [下限, 上限] 的整数；脏值显式拒（不静默回落缺省窗）。 */
function deadlineOf(args: Record<string, unknown>): number {
  const raw = args['deadlineMs'];
  if (raw === undefined) return OPEN_DOCUMENT_DEADLINE_MS_DEFAULT;
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < OPEN_DOCUMENT_DEADLINE_MS_MIN ||
    raw > OPEN_DOCUMENT_DEADLINE_MS_MAX
  ) {
    throw new McpFailure(
      'INVALID_ARGS',
      `[E_EDITOR_INVALID_ARGS] editor.openDocument 的 deadlineMs 须为 ${OPEN_DOCUMENT_DEADLINE_MS_MIN}..${OPEN_DOCUMENT_DEADLINE_MS_MAX} 的整数（收到 ${JSON.stringify(raw) ?? 'undefined'}）：越界不夹取，脏值不静默回落缺省窗 ${OPEN_DOCUMENT_DEADLINE_MS_DEFAULT}ms。`,
    );
  }
  return raw;
}

/* ------------------------------- 判定（纯函数，测试直接钉） ------------------------------- */

/** 一条观察读数是否等于「这份文档真的上屏了」。 */
export function isOpenedInPane(p: EditorOpenPaneObservation): boolean {
  return p.filePathIsTarget && (p.displaysTargetModel || p.displaysTargetSugar);
}

/* ------------------------------- 生产观察腿（动态 import，ps10 纪律） ------------------------------- */

interface OpenPaneCtxLike {
  paneId?: string;
  editorRef: { current: unknown };
  entriesRef: { current: Map<string, { model?: unknown }> };
  filePathRef: { current: string };
  sugarModelRef: { current: unknown };
}

function lineCountOf(model: unknown): number | null {
  const fn = (model as { getLineCount?: () => unknown } | null)?.getLineCount;
  if (typeof fn !== 'function') return null;
  const n = fn.call(model);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function languageOf(model: unknown): string | null {
  const fn = (model as { getLanguageId?: () => unknown } | null)?.getLanguageId;
  if (typeof fn !== 'function') return null;
  const v = fn.call(model);
  return typeof v === 'string' ? v : null;
}

function uriOf(model: unknown): string | null {
  const uri = (model as { uri?: { toString?: () => unknown } } | null)?.uri;
  if (!uri || typeof uri.toString !== 'function') return null;
  const v = uri.toString();
  return typeof v === 'string' ? v : null;
}

function readOnlyOf(editor: unknown): boolean | null {
  const fn = (editor as { getRawOptions?: () => unknown } | null)?.getRawOptions;
  if (typeof fn !== 'function') return null;
  const opts = fn.call(editor) as { readOnly?: unknown } | null;
  if (!opts || typeof opts.readOnly !== 'boolean') return null;
  return opts.readOnly;
}

/** 登记簿里读到的一个实例（`Map` 值形状 = `PaneCtx`，本模块只投影成 `OpenPaneCtxLike`）。 */
type LivePanesLike = Map<string, OpenPaneCtxLike>;

interface EditorPaneRegistryLike {
  readonly livePanes?: LivePanesLike;
}
interface PathKeyModuleLike {
  readonly pathKey?: (p: string) => string;
}

/**
 * 生产观察腿：现扫 `livePanes`（模块级登记簿，与 B3 那五枚读的是**同一份 Map**）。
 * 键比较走 `@kojo/plugin-api` 的 `pathKey`（Windows 折叠大小写 + 分隔符归一），与宿主标签表自己的
 * `matchOpenedPath` 同尺 ⇒ 不另立第三份路径判据。
 * 装载失败（无头宿 / ui 图缺席）⇒ `panes:null` + 如实原因，由腿转成显式 `NOT_WIRED`，绝不空表冒充。
 */
export async function productionObserveEditorPanes(targetAbs: string): Promise<EditorOpenObservation> {
  let registry: EditorPaneRegistryLike | null = null;
  let pathKey: ((p: string) => string) | null = null;
  try {
    const [registryMod, pathsMod] = (await Promise.all([
      import('../ui/editor-pane-registry'),
      import('@kojo/plugin-api'),
    ])) as unknown as [EditorPaneRegistryLike, PathKeyModuleLike];
    registry = registryMod;
    pathKey = typeof pathsMod.pathKey === 'function' ? pathsMod.pathKey : null;
  } catch (err: unknown) {
    return {
      panes: null,
      reason: `编辑器登记簿装载失败（${err instanceof Error ? err.message : String(err)}）：GUI 侧实例档案读不到，落地与否无从核对`,
    };
  }
  const fold = (p: string): string => (pathKey ? pathKey(p) : p.replace(/\\/g, '/').toLowerCase());
  const panes = registry?.livePanes;
  if (!panes || typeof panes.entries !== 'function') {
    return { panes: null, reason: 'livePanes 登记簿缺席（不是空表，是整张表读不到）：GUI 未挂载' };
  }
  const want = fold(targetAbs);
  const out: EditorOpenPaneObservation[] = [];
  for (const [mapKey, ctx] of panes.entries()) {
    const editor = ctx?.editorRef?.current ?? null;
    const displayedModel = (editor as { getModel?: () => unknown } | null)?.getModel?.() ?? null;
    const entries = ctx?.entriesRef?.current ?? null;
    const rawPath = ctx?.filePathRef?.current;
    const filePath = typeof rawPath === 'string' && rawPath !== '' ? rawPath : null;
    let targetKey: string | null = null;
    let targetModel: unknown = null;
    if (entries && typeof entries.keys === 'function') {
      for (const key of entries.keys()) {
        if (fold(String(key)) === want) {
          targetKey = key;
          targetModel = entries.get(key)?.model ?? null;
          break;
        }
      }
    }
    const sugar = ctx?.sugarModelRef?.current ?? null;
    out.push({
      paneId: typeof ctx?.paneId === 'string' && ctx.paneId !== '' ? ctx.paneId : mapKey,
      filePath,
      filePathIsTarget: filePath !== null && fold(filePath) === want,
      hasTargetTab: targetKey !== null,
      displaysTargetModel: targetModel !== null && displayedModel !== null && displayedModel === targetModel,
      displaysTargetSugar:
        sugar !== null && displayedModel !== null && displayedModel === sugar && targetKey !== null,
      tabCount: entries && typeof entries.size === 'number' ? entries.size : 0,
      lineCount: lineCountOf(targetModel),
      language: languageOf(targetModel),
      modelUri: uriOf(displayedModel),
      readOnly: readOnlyOf(editor),
    });
  }
  return { panes: out };
}

/* ------------------------------- 执行腿 ------------------------------- */

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createEditorOpenDocumentLeg(deps: McpEditorOpenDeps = {}): McpReaderFn {
  const observe = deps.observePanes ?? productionObserveEditorPanes;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());

  return async (args: Record<string, unknown>): Promise<unknown> => {
    const relPath = requireRelPath(args);
    const deadlineMs = deadlineOf(args);
    const getRootDir = deps.getRootDir;
    if (!getRootDir) {
      throw new McpFailure(
        'NOT_WIRED',
        '[E_EDITOR_OPEN_HOST_MISSING] editor.openDocument 未接线：宿主没给项目根读数腿（生产由 real-sources-io.ts 注入 requireProject）。真源不在场就不发射意图、不冒充打开。',
      );
    }
    const rootDir = getRootDir();
    if (rootDir === null || rootDir === '') {
      throw new McpFailure(
        'RESOURCE_UNAVAILABLE',
        '项目未打开：editor.openDocument 只开**当前项目根内**的文档，没有可解析的基准根（fail-closed，不猜根、不接绝对路径）。',
      );
    }
    const resolve = deps.resolveWithinRoot;
    if (!resolve) {
      throw new McpFailure(
        'NOT_WIRED',
        '[E_EDITOR_OPEN_HOST_MISSING] editor.openDocument 未接线：宿主没给项目根路径闸（resolveWithinRoot）——缺闸即拒，绝不把未复核的路径透给宿主事件。',
      );
    }
    // 路径闸（判据 ③）：与 fs.readFile 同一条 resolveWithinRoot（形态闸 + resolve 后前缀复核）。
    // Wave4 #4 那句「routeOpenPath 不校验项目根域」在这里补上：越界当场 INVALID_ARGS，
    // 宿主事件永远拿不到域外落点。
    const targetAbs = resolve(rootDir, relPath);
    const emitIntent = deps.emitIntent;
    if (!emitIntent) {
      throw new McpFailure(
        'NOT_WIRED',
        `[E_EDITOR_OPEN_HOST_MISSING] editor.openDocument 未接线：宿主没有 ${EDITOR_OPEN_CHANNEL} 的发射口（kernel.bus.emit 缺席 = 内核未到场 / 精简桥）。不发一条无从发射的"成功"。`,
      );
    }

    const startedAt = now();
    const first = await observe(targetAbs);
    if (first.panes === null) {
      throw new McpFailure(
        'NOT_WIRED',
        `[E_EDITOR_GUI_NOT_MOUNTED] 打开文档失败：编辑器登记簿读不到（${first.reason ?? '无原因读数'}）。本工具的回执只认登记簿读数——读不到就绝不发射一条无法核对的意图，也绝不回 opened:true。`,
      );
    }
    // 已在活动位 ⇒ 不发射任何事件（零重复导航、零重复记账），回执仍是从登记簿读回来的。
    const already = first.panes.find((p) => isOpenedInPane(p));
    if (already) {
      return openReceipt({
        pane: already,
        relPath,
        targetAbs,
        deadlineMs,
        intent: {
          emitted: false,
          channel: EDITOR_OPEN_CHANNEL,
          channelAvailable: false,
          subscribers: null,
          note: '目标此刻已在活动位：本调用没有发射任何事件（不重复导航、不重复记最近文件），故通道可用性未被验证。',
        },
        waitedMs: Math.max(0, now() - startedAt),
        polls: 1,
        panesObserved: first.panes.length,
        alreadyOpen: true,
      });
    }

    // 发射**既有**通道（判据 ①：不新造第二套跳转）。通道缺席 ⇒ 显式 NOT_WIRED，不假发射。
    const intent = emitIntent(targetAbs);
    if (!intent.channelAvailable || !intent.emitted) {
      throw new McpFailure(
        'NOT_WIRED',
        `[E_EDITOR_OPEN_CHANNEL_MISSING] 打开文档失败：宿主事件 ${EDITOR_OPEN_CHANNEL} 没能发射（${intent.note}）。` +
          (intent.subscribers === 0
            ? '此刻该事件零订阅者（GUI 未挂载时订阅者不存在），发射了也不会有人落地。'
            : '') +
          ' 未发射 ⇒ 没有任何落地可核对，绝不回 opened:true。',
      );
    }

    let last = first.panes;
    let polls = 1;
    for (;;) {
      const hit = last.find((p) => isOpenedInPane(p));
      if (hit) {
        return openReceipt({
          pane: hit,
          relPath,
          targetAbs,
          deadlineMs,
          intent,
          waitedMs: Math.max(0, now() - startedAt),
          polls,
          panesObserved: last.length,
          alreadyOpen: false,
        });
      }
      const waitedMs = Math.max(0, now() - startedAt);
      if (waitedMs >= deadlineMs) throw openFailure({ last, relPath, targetAbs, waitedMs, deadlineMs, intent });
      await sleep(Math.min(OPEN_DOCUMENT_POLL_INTERVAL_MS, Math.max(1, deadlineMs - waitedMs)));
      polls += 1;
      const next = await observe(targetAbs);
      if (next.panes === null) {
        throw new McpFailure(
          'NOT_WIRED',
          `[E_EDITOR_GUI_NOT_MOUNTED] 打开文档在观察窗内失去登记簿（${next.reason ?? '无原因读数'}）：已等 ${waitedMs}ms，落地与否无从核对，不冒充 opened:true。`,
        );
      }
      last = next.panes;
    }
  };
}

/* ------------------------------- 回包形状 ------------------------------- */

function openReceipt(input: {
  pane: EditorOpenPaneObservation;
  relPath: string;
  targetAbs: string;
  deadlineMs: number;
  intent: EditorOpenIntentReceipt;
  waitedMs: number;
  polls: number;
  panesObserved: number;
  alreadyOpen: boolean;
}): Record<string, unknown> {
  const p = input.pane;
  const derivedView = p.displaysTargetSugar && !p.displaysTargetModel;
  return {
    /** 唯一判据：登记簿里某个实例的活动文件就是这条 path，且上屏的 model 就是它那一份。 */
    opened: true,
    tool: 'editor.openDocument',
    relPath: input.relPath,
    path: input.targetAbs,
    paneId: p.paneId,
    /** 「此刻是不是该实例的活动文档」＝判据本身（false 的情形一律走显式失败，不在这儿出现）。 */
    active: p.filePathIsTarget,
    /** 此刻上屏的是不是糖投影（派生视图）：是 ⇒ editor.setValue / editor.type 那一族照旧显式拒。 */
    derivedView,
    /** 目标那一份标签的读数（标签在表里才读得到；读不到 ⇒ null，不编造）。 */
    lineCount: p.lineCount,
    language: p.language,
    modelUri: p.modelUri,
    readOnly: p.readOnly,
    displayedPath: p.filePath,
    tabCount: p.tabCount,
    panesObserved: input.panesObserved,
    alreadyOpen: input.alreadyOpen,
    /** 观察账：等了多久、轮询几轮、间隔与窗各是多少——「可观测」这件事本身也要可核对。 */
    waitedMs: input.waitedMs,
    polls: input.polls,
    pollIntervalMs: OPEN_DOCUMENT_POLL_INTERVAL_MS,
    deadlineMs: input.deadlineMs,
    intent: input.intent,
    /** 打开文档不动正文、不写盘（判据 ⑦）。 */
    contentChanged: false,
    dirty: null,
    dirtyReason:
      '打开文档这一步不产生任何模型改动，脏态不由本腿判定（要读脏态请用 document.active / editor.info，要改正文用 editor.setValue / editor.type）',
    saved: false,
    persisted: false,
    persistNote:
      '本工具只在编辑器里打开文档：磁盘一字节未读写、模型未改。落盘仍只走 fileTree.update（第四张表 approvedRoots × 内核 writablePaths 双闸）或 exportFile 对话框。',
    next: derivedView
      ? `实例 ${p.paneId} 此刻显示的是这份文档的糖投影（派生视图）：写正文的 editor.setValue / editor.type 在投影上会显式拒绝，定位类读数请按派生视图口径回读。`
      : `后续定位请用 editor.setCursor / editor.revealLine，并把 paneId="${p.paneId}" 带上（两枚都有读回核对）。本工具刻意不兼任「一步定位」：那条组合面（editor.revealPosition）判为已被这两枚覆盖，见台账。`,
  };
}

/** 有界窗耗尽 ⇒ 显式失败；账要能回答「等了多久、看到几个实例、每个正显示什么、为什么判没打开」。 */
function openFailure(input: {
  last: readonly EditorOpenPaneObservation[];
  relPath: string;
  targetAbs: string;
  waitedMs: number;
  deadlineMs: number;
  intent: EditorOpenIntentReceipt;
}): McpFailure {
  const panes = input.last;
  if (panes.length === 0) {
    return new McpFailure(
      'NOT_WIRED',
      `[E_EDITOR_GUI_NOT_MOUNTED] editor.openDocument 未落地：已发射 ${input.intent.channel}，但等了 ${input.waitedMs}ms` +
        `（窗 ${input.deadlineMs}ms / 每 ${OPEN_DOCUMENT_POLL_INTERVAL_MS}ms 复核一次）之后登记簿里**一个编辑器实例都没有**——` +
        'GUI 未挂载（欢迎页 / 无头宿）时落地方与实例都不存在，发射只是把意图丢进没人听的总线。' +
        `判「没打开」的依据：目标「${input.relPath}」→「${input.targetAbs}」没有出现在任何实例的活动文件位。绝不回 opened:true 冒充。`,
    );
  }
  const withTab = panes.filter((p) => p.hasTargetTab).length;
  const listed = Math.min(panes.length, OPEN_DOCUMENT_FAILURE_PANE_SAMPLE);
  const sample = panes
    .slice(0, listed)
    .map((p) => `${p.paneId}=${p.filePath ?? '(无活动文件)'}${p.hasTargetTab ? '[有标签未上屏]' : ''}`)
    .join(' | ');
  const detail =
    panes.length > listed ? `${sample} …（共 ${panes.length} 个实例，只列前 ${listed} 个）` : sample;
  return new McpFailure(
    'TOOL_EXECUTION_FAILED',
    `[E_EDITOR_OPEN_UNVERIFIED] editor.openDocument 无法核对落地：已发射 ${input.intent.channel}` +
      `（订阅者 ${input.intent.subscribers === null ? '读数缺席' : input.intent.subscribers}），` +
      `等了 ${input.waitedMs}ms ≥ 窗 ${input.deadlineMs}ms（每 ${OPEN_DOCUMENT_POLL_INTERVAL_MS}ms 复核），` +
      `登记簿里有 ${panes.length} 个实例、${withTab} 个的标签表已含目标，但没有一个把「${input.targetAbs}」放到活动文件位并让它上屏` +
      `（判据：filePathRef 命中 + 上屏 model 就是那一份标签 model）。此刻各实例显示的是：${detail}。` +
      `可能原因：该路径不是可开的入口（阶段闸拦下 / 非文本产物）、或开文件的落地比窗还慢（可用 deadlineMs 加大窗，上限 ${OPEN_DOCUMENT_DEADLINE_MS_MAX}ms）。` +
      '绝不回 opened:true 冒充。',
  );
}

/* ------------------------------- 生产发射腿（内核既有总线） ------------------------------- */

/** 内核总线的最小投影（生产传 `kernel.bus`；测试给假件）。 */
export interface EditorOpenBusLike {
  readonly emit?: (name: string, payload: unknown) => void;
  /**
   * 内核 `EventBus` 的调试辅助读数。它**不在 `@kojo/plugin-api` 的 EventBus 契约里**
   * （契约只有 on/once/emit ⇒ 这里按结构性可选处理）：读不到 ⇒ `subscribers:null` 如实标注，
   * 绝不为拿这一位去改契约，也绝不编造订阅数。
   */
  readonly listenerCount?: (name: string) => number;
}

export type EditorOpenBusGetter = () => EditorOpenBusLike | null;

/**
 * 生产发射腿：订阅者数**在发射之前**读一次（缺席 ⇒ null 不编造）。读到 0 ⇒ 不发射并如实回报——
 * 这正是 Wave4 #4「订阅者只在 GUI 挂载时存在」那一格的正面处理：与其发一条注定没人落地的事件再猜
 * 结果，不如显式拒绝（零副作用的拒绝）。
 * 载荷只给 `filePath`（已过根闸）+ `source` 标记：**不给 line / column**——本腿不兼任定位，
 * 「定位到第几行」是 `editor.setCursor` / `editor.revealLine` 的活（两枚都带读回核对）。
 */
export function productionEmitOpenIntent(getBus: EditorOpenBusGetter): EditorOpenEmitter {
  return (targetAbs: string) => {
    const bus = getBus();
    if (!bus) {
      return {
        emitted: false,
        channel: EDITOR_OPEN_CHANNEL,
        channelAvailable: false,
        subscribers: null,
        note: '内核未到场（没有 bus）：无发射通道',
      };
    }
    if (typeof bus.emit !== 'function') {
      return {
        emitted: false,
        channel: EDITOR_OPEN_CHANNEL,
        channelAvailable: false,
        subscribers: null,
        note: '内核总线没有 emit（精简桥 / 假件）：无发射通道',
      };
    }
    const subscribers = typeof bus.listenerCount === 'function' ? safeListenerCount(bus, EDITOR_OPEN_CHANNEL) : null;
    if (subscribers === 0) {
      return {
        emitted: false,
        channel: EDITOR_OPEN_CHANNEL,
        channelAvailable: true,
        subscribers: 0,
        note: '该事件此刻零订阅者（GUI 未挂载时订阅者不存在）：发射不会有落地方，故不发射',
      };
    }
    try {
      bus.emit(EDITOR_OPEN_CHANNEL, { filePath: targetAbs, source: EDITOR_OPEN_SOURCE_MARK });
    } catch (err: unknown) {
      return {
        emitted: false,
        channel: EDITOR_OPEN_CHANNEL,
        channelAvailable: true,
        subscribers,
        note: `发射抛错（${err instanceof Error ? err.message : String(err)}）：落地与否无从谈起`,
      };
    }
    return {
      emitted: true,
      channel: EDITOR_OPEN_CHANNEL,
      channelAvailable: true,
      subscribers,
      note: `已发射 ${EDITOR_OPEN_CHANNEL}（订阅者 ${subscribers === null ? '读数缺席' : subscribers}）`,
    };
  };
}

function safeListenerCount(bus: EditorOpenBusLike, name: string): number | null {
  try {
    const n = bus.listenerCount?.(name);
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/* ------------------------------- 组装（腿表名字必须与契约表逐字同） ------------------------------- */

export interface EditorOpenLegs {
  readonly editorOpenDocument: McpReaderFn;
}

export function createEditorOpenLegs(deps: McpEditorOpenDeps = {}): EditorOpenLegs {
  return { editorOpenDocument: createEditorOpenDocumentLeg(deps) };
}
