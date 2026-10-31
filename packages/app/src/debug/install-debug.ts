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
 *   "该重新对照 DOM 了"，不是"调试面坏了"；1030 批次 3 追加 `semantic` 一块：六条语义读数
 *   背后的**动作 / provider 有没有货**，`ok` 判据不动（动作存在 ≠ provider 齐全，照旧不进 `ok`）；
 * - `editor` 的**跳转与诊断读数**（1030 批，只读、绝不抛）：`definitionAt()` / `referencesAt()`
 *   走 Monaco 的 provider 注册表（`ILanguageFeaturesService`，与"转到定义 / 查找引用"菜单吃的是
 *   同一批 provider），跨文件结果归一成仓库内相对路径；`codeActionsAt()` 只读"有哪些动作"、
 *   **绝不 apply**；`signatureAt()` / `documentSymbols()` / `diagnostics()`（复用 `markers()` 的
 *   `getModelMarkers` 取数腿，只加裁剪与当前文档作用域）。全部经纯函数裁剪
 *   （`slimLocations` / `slimCodeActions` / `slimSignature` / `slimSymbols` / `slimDiagnostics`），
 *   **不依赖任何私有 DOM 类名**（`.monaco-hover` 那一类是 `selfCheck` 的职责，不是新读数的）；
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
    /**
     * 私有 DOM 形态 / 私有贡献点的自检读数（只读、绝不抛；升级 Monaco 后先跑它）。
     * `semantic` 一块另给六条语义读数背后的动作 / provider 有没有货，**不进 `ok`**。
     */
    selfCheck(): DebugSelfCheck;
    /**
     * 转到定义（1030 批，只读）：走真 definition provider 链，跨文件结果归一成仓库内相对路径，
     * 前 20 条；无 provider / 读不到 ⇒ `[]`（不抛、不 reject）。
     */
    definitionAt(line: number, column: number, opts?: SemanticQueryOptions): Promise<DebugLocation[]>;
    /** 查找引用（与 `definitionAt` 同一条 provider 链）：前 50 条，另给未截断的 `total` */
    referencesAt(line: number, column: number, opts?: ReferenceQueryOptions): Promise<DebugReferencesReading>;
    /**
     * 该位置的可用动作（快速修复 / 重构）：前 30 条。**只读**——读的是"有哪些动作"，
     * 绝不 apply（apply 是 `commands.run` / 真人点菜单的事）。
     */
    codeActionsAt(line: number, column: number, opts?: SemanticQueryOptions): Promise<DebugCodeAction[]>;
    /** 参数提示（签名帮助）；该位置没有 provider 或 provider 给不出签名 ⇒ null */
    signatureAt(line: number, column: number, opts?: SemanticQueryOptions): Promise<DebugSignature | null>;
    /** 文档符号树（父子关系压平成 `depth`）：前 200 条 */
    documentSymbols(): Promise<DebugSymbol[]>;
    /**
     * 当前文档的诊断：前 200 条。**复用** `markers()` 的取数腿（`getModelMarkers`），
     * 本条只加"当前文档作用域 + 裁剪"（`severity` 与 `markers()` 同口径，见 `slimDiagnostics`）。
     */
    diagnostics(): Promise<DebugDiagnostic[]>;
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

/* -------------------- 跳转与诊断读数（1030 批，只读）的契约面 -------------------- */

/** 一次跳转/查询的共用选项：只给超时（provider 是第三方代码，可能永远不 resolve） */
export interface SemanticQueryOptions {
  readonly timeoutMs?: number;
}

export interface ReferenceQueryOptions extends SemanticQueryOptions {
  /** 是否把声明本身算进结果；缺省 true（与 Monaco 菜单的"查找引用"一致） */
  readonly includeDeclaration?: boolean;
}

/** 跳转目标：`path` 是**归一后的仓库内相对路径**（拿不到工程根时是归一后的绝对路径） */
export interface DebugLocation {
  readonly path: string;
  /** 1 基 */
  readonly line: number;
  /** 1 基 */
  readonly column: number;
}

export interface DebugReferencesReading {
  /** 受上限截断的条目（读不到 ⇒ 空数组） */
  readonly items: DebugLocation[];
  /** provider 交回的有效条目数（未截断；上限 `REFERENCE_TOTAL_LIMIT`） */
  readonly total: number;
}

/**
 * 一条可用动作（**只读**，不含 edit 内容：读数只回答"有哪些动作"，不回答"改成什么"）。
 * `kind` 是 Monaco 的动作种类串（`quickfix` / `refactor.extract` / `source.fixAll` …），
 * 缺 ⇒ 空串（不是 null：调用方不必判两种空值，与 `DebugSuggestItem.detail` 同一纪律）。
 */
export interface DebugCodeAction {
  readonly title: string;
  readonly kind: string;
  /** 只认 provider 的字面量 `true`（读数是给脚本断言的，不猜真值） */
  readonly isPreferred: boolean;
  /** `edit.edits` 非空才算有编辑；只有 `command` 的动作 ⇒ false */
  readonly hasEdit: boolean;
}

/** 当前生效的那条签名（`activeSignature` 指向的那一个）；无签名 ⇒ null */
export interface DebugSignature {
  readonly label: string;
  /** 0 基下标（沿用 provider / Monaco 的语义；**不是**行号那种 1 基）；越界夹到 0..99 */
  readonly activeParameter: number;
  /** 逐条参数的 label（`string | {label}` 两种形态都归一成字符串） */
  readonly parameters: string[];
  /** provider 给了才有这个键（空文档 ⇒ 不挂键，与 `alias` 同一纪律） */
  readonly documentation?: string;
}

/** 文档符号的一条：`kind` 是 Monaco `SymbolKind` 数字（1 起），缺 ⇒ 0 = 未知 */
export interface DebugSymbol {
  readonly name: string;
  readonly kind: number;
  /** 0 = 顶层；父子关系压平后的层级（不按 `children` 递归缩进，脚本自己乘） */
  readonly depth: number;
}

/**
 * 一条诊断：`severity` 与 `markers()` 同口径（Monaco `MarkerSeverity`：1 Hint / 2 Info /
 * 4 Warning / 8 Error），缺 ⇒ 0 = 未知——**不编造"错误"**。
 */
export interface DebugDiagnostic {
  readonly severity: number;
  readonly message: string;
  readonly line: number;
  readonly column: number;
  /** 产出这条诊断的语言服务名；缺失 ⇒ 不挂键 */
  readonly source?: string;
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
 * 自检的**老契约**（`summarizeSelfCheck` 的返回形状）：`monacoVersion` / `languageId` 取不到
 * 就是 null（不编造），`ok` 只由 `monacoVersion !== null && hover && suggest && foldingContribution`
 * 三项决定——`suggestRow` / `labelName` / `detailsLabel` 是纯 DOM 探测，**不参与** `ok`。
 *
 * 为什么单独立这个类型而不是直接往 `DebugSelfCheck` 里加键：`summarizeSelfCheck` 的返回**形状**
 * 本身是既有契约（`debug-language-surface.test.ts` 按整对象 `toEqual` 断言它），新增读数只许
 * additive 地挂在 `selfCheck()` 的外层，不许把老形状改宽——改宽就等于让所有按整对象断言的
 * 脚本在一夜之间读到多出来的键。
 */
export interface DebugSelfCheckCore {
  readonly monacoVersion: string | null;
  readonly languageId: string | null;
  readonly selectors: DebugSelfCheckSelectors;
  readonly foldingShape: DebugFoldingShape;
  readonly ok: boolean;
}

/**
 * 一条编辑器动作的两个**互不等价**的事实（`probeAction` 的口径）：
 * - `present`：`getAction(id)` 交回了一个对象——只证明这枚动作**注册着**；
 * - `supported`：那枚动作 `isSupported()` 的实测值；动作缺席 / 动作没这个方法 / 调用抛错
 *   ⇒ null（没问到，**不猜**）。
 *
 * 为什么非要拆成两个字段、而不是压成一个布尔：Monaco 的动作是**静态注册**的，
 * 查 `editor.action.revealDefinition`（`getAction` 的入参）在完全没有 definition provider 的
 * 语言里**照样返回动作**——点下去什么也不会发生。把"动作在"与"功能可用"压成一个布尔，就是
 * 把近似当等价；而 `isSupported()` 走的是动作自己的 precondition（definition 那枚的
 * precondition 正是 `hasDefinitionProvider`），它比 `present` 强，但仍然不是 provider 注册表的
 * 直读——不可区分"没有 provider"与"上下文键还没算出来"，所以它是 `boolean | null`，不是结论。
 */
export interface DebugSelfCheckActionProbe {
  readonly present: boolean;
  readonly supported: boolean | null;
}

/** 六条语义读数各自的**代表动作**（为什么是这几枚、为什么 codeAction 不是 quickFix：见 `SEMANTIC_ACTION_IDS`） */
export interface DebugSelfCheckSemanticActions {
  readonly definition: DebugSelfCheckActionProbe;
  readonly codeAction: DebugSelfCheckActionProbe;
  readonly signatureHelp: DebugSelfCheckActionProbe;
  readonly documentSymbol: DebugSelfCheckActionProbe;
}

/**
 * provider 的三态（`probeProviderPresence` 的口径）：
 * - `true`：注册表可查，且对**当前 model** 有 ≥1 个 provider；
 * - `false`：注册表可查，但当前 model 下**一个都没有**——这时候对应读数**必然**是 `[]` / `null`，
 *   与"这里确实没有定义"同形，正是自检要拆掉的那个歧义；
 * - `null`：**没问到**（深路径 import 失败 / 没有 model / 该读数根本不走 provider 注册表）。
 *   null 不是"false 的另一种写法"：false 是"问到了，答案是没有"，null 是"这条问题此刻答不了"。
 */
export type SemanticProviderPresence = boolean | null;

/** 六条语义读数背后的 provider 三态（键与六条读数同名，方便对着结果看） */
export interface DebugSelfCheckProviders {
  readonly definition: SemanticProviderPresence;
  readonly references: SemanticProviderPresence;
  readonly codeAction: SemanticProviderPresence;
  readonly signatureHelp: SemanticProviderPresence;
  readonly documentSymbol: SemanticProviderPresence;
  /** 诊断不走 provider 注册表（`getModelMarkers` 是公开 API）⇒ **恒 null**，见 `probeProviderPresence` */
  readonly diagnostics: SemanticProviderPresence;
}

/** `selfCheck().semantic`：语义读数的可用性（**读数**，不是判据） */
export interface DebugSelfCheckSemantic {
  readonly actions: DebugSelfCheckSemanticActions;
  readonly providers: DebugSelfCheckProviders;
}

/**
 * `editor.selfCheck()` 的返回形状（契约面）= 老形状 + 一块 additive 的 `semantic`。
 *
 * `semantic` 回答"六条语义读数在当前构建 / 当前语言下有没有货可读"，但它**不参与 `ok`**：
 * `ok` 的语义是"这套私有 DOM 形态与私有贡献点还成立吗"（`hover` / `suggest` / `folding`），
 * 而 `semantic` 里全是**近似**——动作注册着不等于 provider 在，provider 在也不等于这一次调用
 * 有结果。把近似塞进 `ok`，`ok===true` 就会从"升级没漂"偷换成"语言服务齐活"，一个结论变成
 * 两个结论，读它的人没法再分开排查。所以：`ok` 一个字节都不动，`semantic` 只当读数看。
 */
export interface DebugSelfCheck extends DebugSelfCheckCore {
  readonly semantic: DebugSelfCheckSemantic;
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
export function summarizeSelfCheck(raw: unknown): DebugSelfCheckCore {
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

/**
 * `semantic` 归一（纯函数，供单测）：与 `summarizeSelfCheck` 同一套纪律——入参 `unknown`、
 * 脏值不许抛、键集固定。
 *
 * 取严的规则：
 * - `present` 只认**字面量 true**（`'true'` / 1 都不算：读数是给脚本断言的，不猜）；
 * - `supported` / `providers.*` 只认字面量 `true` / `false`，其余（缺键、字符串、`undefined`）
 *   一律 null —— null 与 false **不许混**（见 `SemanticProviderPresence` 头注）；
 * - `providers.diagnostics` **恒 null**（连入参都不看）：诊断不走 provider 注册表，
 *   这里出现任何 true / false 都只可能是编造的，正常化的时候就把它按死。
 */
export function summarizeSemanticCheck(raw: unknown): DebugSelfCheckSemantic {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawActions = (
    source.actions && typeof source.actions === 'object' ? source.actions : {}
  ) as Record<string, unknown>;
  const rawProviders = (
    source.providers && typeof source.providers === 'object' ? source.providers : {}
  ) as Record<string, unknown>;
  const probe = (key: string): DebugSelfCheckActionProbe => {
    const entry = rawActions[key];
    const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const supported = record.supported;
    return {
      present: record.present === true,
      supported: supported === true ? true : supported === false ? false : null,
    };
  };
  const presence = (key: string): SemanticProviderPresence => {
    const value = rawProviders[key];
    return value === true ? true : value === false ? false : null;
  };
  return {
    actions: {
      definition: probe('definition'),
      codeAction: probe('codeAction'),
      signatureHelp: probe('signatureHelp'),
      documentSymbol: probe('documentSymbol'),
    },
    providers: {
      definition: presence('definition'),
      references: presence('references'),
      codeAction: presence('codeAction'),
      signatureHelp: presence('signatureHelp'),
      documentSymbol: presence('documentSymbol'),
      diagnostics: null,
    },
  };
}

/* ------------------ 跳转与诊断读数（1030 批）的纯函数裁剪 ------------------ */

const DEFINITION_LIMIT = 20;
const REFERENCE_LIMIT = 50;
/** references 的 `total` 也只数到这把上限：再多就按 500 计（读数不该为一个计数扫全项目） */
const REFERENCE_TOTAL_LIMIT = 500;
const CODE_ACTION_LIMIT = 30;
const SYMBOL_LIMIT = 200;
/** 符号树的递归深度护栏：坏 provider 交回环状 `children` 时不许把读数打爆 */
const SYMBOL_DEPTH_LIMIT = 20;
const DIAGNOSTIC_LIMIT = 200;
const PARAMETER_LIMIT = 50;
const SEMANTIC_TIMEOUT_DEFAULT_MS = 2000;
/** 单行文本上限**沿用 `slimHoverText` 的口径**（300 字符 + 省略号），不另立一套 */
const SLIM_TEXT_LIMIT = HOVER_ROW_CHAR_LIMIT;

/**
 * 单行文本裁剪（纯函数）：空白折叠 + 300 字符截断。
 * 标题 / 符号名 / 诊断消息 / 签名 label 都该是"人能扫一眼的一行"，不是 provider 的原始长串。
 */
function slimText(value: unknown): string {
  const line = normalizeOneLine(value);
  return line.length > SLIM_TEXT_LIMIT ? `${line.slice(0, SLIM_TEXT_LIMIT)}…` : line;
}

/** 正整数归一：非有限数 / 小于 1 ⇒ null（"没有位置"与"位置是 0"不该被混成同一件事） */
function toPositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const n = Math.floor(value);
  return n >= 1 ? n : null;
}

/**
 * URI / 路径文本归一（纯函数，不导出）：解百分号编码 → 拆 `file://` → 分隔符统一成 `/`。
 *
 * - **先解编码再比前缀**：provider 交回的 uri 是第三方拼的，`%E5%8F%A3` 这类编码不解开就永远
 *   对不上工程根；`decodeURIComponent` 对半截编码会抛，所以解不开就按原文继续（绝不抛）。
 * - `file:///C:/x` → `C:/x`（盘符前的斜杠是 URL 形态的一部分）；`file:///home/x` → `/home/x`；
 *   `file://server/share` → `//server/share`（UNC 保留双斜杠，**别把它伪装成相对路径**）。
 * - 非 file scheme（`inmemory://model/3` 这种未落盘模型）原样保留：它不是文件路径，硬算相对
 *   路径只会编造一个不存在的文件。
 */
function normalizeUriText(raw: string): string {
  let text = raw.trim();
  if (!text) return '';
  if (text.includes('%')) {
    try {
      text = decodeURIComponent(text);
    } catch {
      /* 半截编码：按原文继续 */
    }
  }
  const fileMatch = /^file:\/\/(\/?)(.*)$/i.exec(text);
  if (fileMatch) {
    const leadingSlash = fileMatch[1] ?? '';
    const rest = fileMatch[2] ?? '';
    if (/^[A-Za-z]:/.test(rest)) text = rest;
    else if (leadingSlash === '') text = rest ? `//${rest}` : '';
    else text = `/${rest}`;
  }
  return text.replace(/\\/g, '/');
}

/**
 * URI / 路径 → 仓库内相对路径（纯函数，导出供单测）。
 *
 * 三条纪律：
 * 1. 分隔符一律 `/`：Windows 的 `C:\repo\a.kojo` 与 POSIX 的 `/home/me/repo/a.kojo` 走同一条
 *    前缀比对，跨平台读数才对得上脚本里的断言；
 * 2. 前缀必须落在**分隔符**上：`/repo` 不许吃掉 `/repo2/a.kojo`（与
 *    `ui/dialect-binding.ts` 的 `relativeToProjectRoot` 同一把尺）；
 * 3. 大小写不敏感（Windows 盘符与目录不区分大小写），只用于**判前缀**，返回的仍是原文大小写。
 *
 * `rootDir` 缺席 / 空串 / 不是前缀（含相对路径）⇒ **归一后原样返回**：不编造相对路径。
 */
export function toRepoRelativePath(rawPath: unknown, rootDir?: string | null): string {
  const text = normalizeUriText(typeof rawPath === 'string' ? rawPath : '');
  if (!text) return '';
  const root = normalizeUriText(typeof rootDir === 'string' ? rootDir : '').replace(/\/+$/, '');
  if (!root || root === '/' || text.length <= root.length) return text;
  if (text.slice(0, root.length).toLowerCase() !== root.toLowerCase()) return text;
  if (text[root.length] !== '/') return text;
  return text.slice(root.length + 1);
}

/** range 的起点：`IRange`（`startLineNumber`）与 `{start:{lineNumber}}` 两种形态都认 */
function readRangeStart(raw: unknown): { line: number; column: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const nested = (record.start && typeof record.start === 'object' ? record.start : {}) as Record<string, unknown>;
  const line = toPositiveInt(record.startLineNumber ?? nested.lineNumber ?? nested.line);
  if (line === null) return null;
  // 列缺失 ⇒ 1（行内首列是唯一"不编造"的默认值）；行缺失则整条丢弃
  const column = toPositiveInt(record.startColumn ?? nested.column ?? nested.character) ?? 1;
  return { line, column };
}

function slimLocation(raw: unknown, rootDir: string | null | undefined): DebugLocation | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  // 两种 provider 回包：`Location{uri,range}` 与 `LocationLink{targetUri,targetSelectionRange}`
  const path = toRepoRelativePath(record.uri ?? record.targetUri, rootDir);
  if (!path) return null;
  const start = readRangeStart(record.range ?? record.targetSelectionRange ?? record.targetRange);
  if (!start) return null;
  return { path, line: start.line, column: start.column };
}

/**
 * 跳转目标裁剪（纯函数）：空 / 非数组 ⇒ `[]`；缺 uri、缺 range、行号非正的脏条目**整条丢弃**
 * （它们定位不到，留着只会让 `total` 虚高）；默认上限 20 条（`definitionAt` 的口径），
 * `referencesAt` 显式传 50。
 */
export function slimLocations(raw: unknown, opts?: SlimLocationOptions): DebugLocation[] {
  const out: DebugLocation[] = [];
  if (!Array.isArray(raw)) return out;
  const limit = clampInt(opts?.limit, DEFINITION_LIMIT, 1, REFERENCE_TOTAL_LIMIT);
  for (const item of raw) {
    if (out.length >= limit) break;
    const location = slimLocation(item, opts?.rootDir);
    if (location) out.push(location);
  }
  return out;
}

export interface SlimLocationOptions {
  /** 工程根（缺 ⇒ 返回归一后的路径本身，不算相对路径） */
  readonly rootDir?: string | null;
  readonly limit?: number;
}

/** `edit` 里真有编辑才算 `hasEdit`：`{edits: []}` 这种空壳与"只有 command"都不算 */
function hasRealEdit(edit: unknown): boolean {
  if (!edit || typeof edit !== 'object') return false;
  const edits = (edit as { edits?: unknown }).edits;
  return Array.isArray(edits) && edits.length > 0;
}

/**
 * 动作表裁剪（纯函数）：**只读形态**，不碰 `edit` 内容（读数回答"有哪些动作"，不回答"改成什么"）。
 * - 缺 `title` ⇒ 丢弃（没有标题的动作点不到，留着只污染读数，与 `mapSuggestRows` 同一条纪律）；
 * - `kind` 缺 ⇒ 空串；`isPreferred` 只认字面量 `true`；
 * - 默认上限 30 条。
 */
export function slimCodeActions(raw: unknown, limit = CODE_ACTION_LIMIT): DebugCodeAction[] {
  const out: DebugCodeAction[] = [];
  if (!Array.isArray(raw)) return out;
  const cap = clampInt(limit, CODE_ACTION_LIMIT, 1, REFERENCE_TOTAL_LIMIT);
  for (const item of raw) {
    if (out.length >= cap) break;
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const title = slimText(record.title);
    if (!title) continue;
    out.push({
      title,
      kind: slimText(record.kind),
      isPreferred: record.isPreferred === true,
      hasEdit: hasRealEdit(record.edit),
    });
  }
  return out;
}

/** provider 可能返 `{value, dispose}`（Hover/SignatureResult 形态）也可能直接返值：统一解包 */
function unwrapProviderResult(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const holder = raw as { value?: unknown };
    if (holder.value !== undefined) return holder.value;
  }
  return raw;
}

/** `documentation` 的两种形态：字符串 / `{value: string}`；其余 ⇒ 空串 */
function readDocumentation(raw: unknown): unknown {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') return (raw as { value?: unknown }).value;
  return '';
}

/**
 * 签名读数裁剪（纯函数）：只取**当前生效**的那一条（`activeSignature` 指向的），
 * 越界夹到最后一个；`activeParameter` 非数 ⇒ 0、夹到 0..99（不按参数表长度夹：provider 说
 * 第 3 个就是第 3 个，参数表给不全不代表下标错）。缺 `label` / 无签名 ⇒ null。
 */
export function slimSignature(raw: unknown): DebugSignature | null {
  const help = unwrapProviderResult(raw);
  if (!help || typeof help !== 'object') return null;
  const record = help as Record<string, unknown>;
  const signatures = Array.isArray(record.signatures) ? record.signatures : [];
  if (signatures.length === 0) return null;
  const activeIndex = clampInt(record.activeSignature, 0, 0, signatures.length - 1);
  const active = signatures[activeIndex];
  if (!active || typeof active !== 'object') return null;
  const info = active as Record<string, unknown>;
  const label = slimText(info.label);
  if (!label) return null;
  const rawParameters = Array.isArray(info.parameters) ? info.parameters : [];
  const parameters: string[] = [];
  for (const param of rawParameters.slice(0, PARAMETER_LIMIT)) {
    const text = slimText(typeof param === 'string' ? param : (param as { label?: unknown } | null)?.label);
    if (text) parameters.push(text);
  }
  const documentation = slimText(readDocumentation(info.documentation));
  return {
    label,
    activeParameter: clampInt(record.activeParameter, 0, 0, 99),
    parameters,
    ...(documentation ? { documentation } : {}),
  };
}

/** `SymbolKind` 归一并夹住：非数字 ⇒ 0 = 未知（**不猜**成 Function 之类） */
function toSymbolKind(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/**
 * 符号树裁剪（纯函数）：父子关系压平成 `depth`（0 = 顶层）。
 *
 * 逐节点丢弃的界限：**缺 `name` 的节点连子树一起丢**——读数里点不到的名字没有价值，它的
 * 子节点也失去了「谁的子节点」这层语境，硬留着只会让脚本读到一堆无主条目。递归另有
 * `SYMBOL_DEPTH_LIMIT` 护栏（provider 交回环状 `children` 时不许打爆）。默认上限 200 条。
 */
export function slimSymbols(raw: unknown, limit = SYMBOL_LIMIT): DebugSymbol[] {
  const out: DebugSymbol[] = [];
  const cap = clampInt(limit, SYMBOL_LIMIT, 1, 1000);
  const walk = (list: unknown, depth: number): void => {
    if (!Array.isArray(list) || depth > SYMBOL_DEPTH_LIMIT || out.length >= cap) return;
    for (const item of list) {
      if (out.length >= cap) return;
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const name = slimText(record.name);
      if (!name) continue;
      out.push({ name, kind: toSymbolKind(record.kind), depth });
      walk(record.children, depth + 1);
    }
  };
  walk(raw, 0);
  return out;
}

/**
 * 诊断裁剪（纯函数）：`markers()` 的原始条目（`startLineNumber`）与 `diagnostics()` 的契约形态
 * （`line` / `column` / `source`）都认。
 * - 缺 `message` / 缺行号 ⇒ 丢弃（定位不到或没有内容的诊断在读数里没有价值）；
 * - `column` 缺 ⇒ 1；`severity` 缺 ⇒ 0 = 未知（**不编造错误等级**）；
 * - `source` 空串 ⇒ **不挂键**（与 `alias` 同一条"空值不挂键"纪律）；默认上限 200 条。
 */
export function slimDiagnostics(raw: unknown, limit = DIAGNOSTIC_LIMIT): DebugDiagnostic[] {
  const out: DebugDiagnostic[] = [];
  if (!Array.isArray(raw)) return out;
  const cap = clampInt(limit, DIAGNOSTIC_LIMIT, 1, 1000);
  for (const item of raw) {
    if (out.length >= cap) break;
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const message = slimText(record.message);
    if (!message) continue;
    const line = toPositiveInt(record.line ?? record.startLineNumber);
    if (line === null) continue;
    const column = toPositiveInt(record.column ?? record.startColumn) ?? 1;
    const severity =
      typeof record.severity === 'number' && Number.isFinite(record.severity)
        ? Math.max(0, Math.floor(record.severity))
        : 0;
    const source = slimText(record.source);
    out.push({ severity, message, line, column, ...(source ? { source } : {}) });
  }
  return out;
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

/* --------- 跳转与诊断的取数腿（1030 批，不导出；provider 链，不碰私有 DOM） --------- */

/**
 * 为什么走 **provider 注册表**而不是编辑器动作（revealDefinition / peekDefinition / quickFix 那一套）：
 *
 * - 动作是**副作用**，不是**查询**：revealDefinition 会把光标与视图搬到目标（跨文件还会换标签），
 *   peekDefinition 只弹 peek 面板——想拿到结果就得读 peek 面板的 DOM（那一串私有类名），
 *   quickFix 更糟：触发之后动作清单只活在弹出的菜单里。三条都不满足"只读"。
 * - provider 注册表（`ILanguageFeaturesService`）是那些动作**背后的同一批 provider**：菜单点
 *   "转到定义"时走的就是 `definitionProvider.ordered(model)`。直接调它 = 读与真人同源的数据，
 *   且完全不改编辑器状态（不改光标、不弹面板、不动模型）。
 * - 代价是这两条深路径没有公开类型面（包只发 `editor.api` 的 .d.ts），所以取数腿整套放在
 *   `try/catch` 后面：路径不可用 ⇒ 如实 null / 空数组，绝不让调试面自己炸掉。
 */
interface RegistryLike {
  ordered?: (model: unknown) => readonly { provider?: unknown }[];
}

interface LanguageFeaturesLike {
  definitionProvider?: RegistryLike;
  referenceProvider?: RegistryLike;
  codeActionProvider?: RegistryLike;
  signatureHelpProvider?: RegistryLike;
  documentSymbolProvider?: RegistryLike;
}

/** `ILanguageFeaturesService` 只取一次（standalone 的 DI 单例，与 editor 同寿） */
let featuresServicePromise: Promise<LanguageFeaturesLike | null> | null = null;
/**
 * 同一枚服务的**同步快照**：`selfCheck()` 是同步 API，等不了 Promise；结算后写在这里，
 * `probeProvidersNow` 只读它。没结算（还在 import / 这条路不通）⇒ null ⇒ provider 三态全 null。
 */
let featuresServiceNow: LanguageFeaturesLike | null = null;

function languageFeaturesService(): Promise<LanguageFeaturesLike | null> {
  if (featuresServicePromise === null) {
    featuresServicePromise = (async () => {
      try {
        // @ts-ignore 深路径不带 .d.ts（包只发 editor.api 的类型面）；形态在 monaco 0.57 核对过
        const services = await import('monaco-editor/editor/standalone/browser/standaloneServices.js');
        // @ts-ignore 同上：`ILanguageFeaturesService` 是 createDecorator 出来的令牌
        const decorators = await import('monaco-editor/editor/common/services/languageFeatures.js');
        const standalone = (services as { StandaloneServices?: { get(token: unknown): unknown } })
          .StandaloneServices;
        const instance = standalone?.get((decorators as { ILanguageFeaturesService?: unknown }).ILanguageFeaturesService);
        featuresServiceNow = (instance ?? null) as LanguageFeaturesLike | null;
        return featuresServiceNow;
      } catch {
        // 打包器不认 exports 映射 / 版本改名：这条路在当前构建上不通，如实回 null（不编造 provider）
        return null;
      }
    })();
  }
  return featuresServicePromise;
}

/**
 * 注册表条目 → provider（两种形态都收）。
 *
 * 0.57 的 `LanguageFeatureRegistry.ordered()` **直接返回 provider 数组**：上游实现是
 * `_orderedForEach(model, …, entry => result.push(entry.provider))`（见
 * `monaco-editor/esm/vs/editor/common/languageFeatureRegistry.js`），也就是说拆包这一步
 * 它自己做完了，交给调用方的已经是 provider 本身。
 *
 * 这里原先按 `{ provider }` 包装去解，于是每条都解出 `undefined` ⇒ `providersOf` 恒空、
 * `presenceOf` 恒 `false`，六个语义读数在真机上**一直返回空**；而当时的单测喂的正是包装
 * 形状，所以全绿也照不出来（真机读数只有端到端冒烟才会撞破）。教训记在 PITFALLS 291。
 *
 * 两种形态都收：条目上挂着 `provider` 对象就用它（上游若改回包装不必再改这里），否则看
 * 条目自己有没有该特性的方法 —— 有方法才算这个特性的 provider，不是随便一个对象都算。
 */
function unwrapProvider(entry: unknown, method: string): unknown | null {
  if (!entry || typeof entry !== 'object') return null;
  const wrapped = (entry as { provider?: unknown }).provider;
  if (wrapped && typeof wrapped === 'object') return wrapped;
  return typeof (entry as Record<string, unknown>)[method] === 'function' ? entry : null;
}

/** 某个特性注册表里对当前 model 生效的 provider（顺序即 Monaco 的打分顺序） */
function providersOf(registry: RegistryLike | undefined, model: unknown, method: string): unknown[] {
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

/**
 * 一次 provider 调用：**同步抛 / 异步 reject / 挂死** 三种失败都归成 null。
 * provider 是第三方代码（本仓的 kojo-* 与插件都算），读数器不能让它把调试会话拖住——
 * 所以每条腿都自带超时（缺省 2s，`opts.timeoutMs` 可调，夹在 50ms..15s）。
 */
function callWithin<T>(timeoutMs: number, task: () => T | Promise<T>): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (value: T | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => done(null), timeoutMs);
    let produced: T | Promise<T>;
    try {
      produced = task();
    } catch {
      done(null);
      return;
    }
    Promise.resolve(produced).then(
      (value) => done(value ?? null),
      () => done(null),
    );
  });
}

/**
 * provider 回包展开成"条目数组"：`Location[]` / `LocationLink[]` 直接摊平，
 * `{value: [...]}`（Signal 形态）解一层，单条结果包成一项。null / undefined 一律不算。
 */
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

/** 当前工程的根目录（拿不到 ⇒ null：路径就只做归一、不硬算相对） */
function currentRootDir(): string | null {
  try {
    const root = kernelNow?.project.current()?.rootDir;
    return typeof root === 'string' && root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

interface ModelTarget {
  readonly model: Monaco.editor.ITextModel;
  readonly monaco: typeof Monaco;
  readonly rootDir: string | null;
}

async function modelTarget(): Promise<ModelTarget | null> {
  const model = focusedCtx()?.editorRef.current?.getModel() ?? null;
  if (!model) return null;
  const monaco = await import('../monaco/entry');
  return { model, monaco, rootDir: currentRootDir() };
}

interface SemanticTarget extends ModelTarget {
  readonly position: Monaco.Position;
  readonly line: number;
  readonly column: number;
}

/**
 * 把外部手敲的行列夹进当前 model 的合法范围（eval 里传 0 / 1e9 / 小数都不许抛）。
 * 越界夹而不是拒绝：调试时"最后一行"是最常猜的一个位置。
 */
async function semanticTarget(line: unknown, column: unknown): Promise<SemanticTarget | null> {
  const base = await modelTarget();
  if (!base) return null;
  if (typeof line !== 'number' || !Number.isFinite(line)) return null;
  if (typeof column !== 'number' || !Number.isFinite(column)) return null;
  const lineCount = Math.max(1, base.model.getLineCount());
  const lineNumber = Math.min(Math.max(1, Math.floor(line)), lineCount);
  const columnNumber = Math.min(Math.max(1, Math.floor(column)), base.model.getLineMaxColumn(lineNumber));
  return { ...base, line: lineNumber, column: columnNumber, position: new base.monaco.Position(lineNumber, columnNumber) };
}

/** 逐 provider 取数（query 决定调哪个方法、吃什么参数）；单条抛错只丢它自己 */
async function collectFromProviders(
  providerName: keyof LanguageFeaturesLike,
  method: string,
  target: ModelTarget,
  timeoutMs: number,
  makeArgs: (token: unknown) => unknown[],
): Promise<unknown[]> {
  const raw: unknown[] = [];
  const service = await languageFeaturesService();
  const providers = providersOf(service?.[providerName], target.model, method);
  if (providers.length === 0) return raw;
  const cts = new target.monaco.CancellationTokenSource();
  try {
    for (const provider of providers) {
      const fn = (provider as Record<string, unknown>)[method];
      if (typeof fn !== 'function') continue;
      const result = await callWithin(timeoutMs, () =>
        (fn as (...args: unknown[]) => unknown).apply(provider, makeArgs(cts.token)),
      );
      pushProviderResults(raw, result);
    }
  } finally {
    cts.dispose();
  }
  return raw;
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

/* -------------- 语义读数的可用性自检（1030 批次 3，additive；口径见契约面） -------------- */

/**
 * 六条语义读数各自的**代表动作** id。
 *
 * 这不是读数的取数腿——六条读数走 provider 注册表（见 `collectFromProviders` 头注：动作是
 * **副作用**、不是**查询**）。这里只问一句"这枚动作还在 `getAction` 表里吗"，抓的是
 * "升级改名 / 贡献点被裁掉"这类静默漂移。
 *
 * `codeAction` 为什么取 `editor.action.refactor` 而不是更贴切的 quickFix：0.57 的 quickFix 是
 * `registerAction2` 注册的（走 CommandService，**不进** `editor._actions` 那张表），拿它当
 * `getAction` 探针恒为 null——只会得到永远 false 的假阴性；refactor 是同一批 codeActionProvider
 * 背后、由 `registerEditorAction` 注册的那一枚，连 precondition 都同一条
 * （`writable && hasCodeActionsProvider`）。
 */
const SEMANTIC_ACTION_IDS = {
  definition: 'editor.action.revealDefinition',
  codeAction: 'editor.action.refactor',
  signatureHelp: 'editor.action.triggerParameterHints',
  documentSymbol: 'editor.action.quickOutline',
} as const;

/** 只取 `getAction` 这一面：真实 `IStandaloneCodeEditor` 结构兼容，单测喂伪对象即可 */
export interface ActionLookupLike {
  getAction?(id: string): unknown;
}

/**
 * 单枚动作探测：`present` 只认"`getAction` 交回了一个对象"。
 *
 * 为什么不把 `isSupported() === false` 也算成 `present: false`：两个字段回答的不是同一个问题。
 * `present` 回答"这枚动作还注册着吗"（升级改名 ⇒ false，正是要抓的漂移）；`supported` 回答
 * "它自己此刻认不认能跑"。混在一起，`present: false` 就再也没法区分"Monaco 改了这个 id"与
 * "没有 provider 让它的 precondition 不成立"——而这两件事的修法完全相反。
 *
 * `supported` 的取法刻意**不同于** `mapSupportedActions`：那里"拿不到就当 true"是动作表读数的
 * 乐观默认（表里存在即视为可用）；自检的职责恰恰是把"可用 / 不可用 / 不知道"分开，所以
 * 没这个方法、返回非布尔、抛错，一律记 null，不许借用乐观默认。
 */
function probeAction(ed: ActionLookupLike | null, id: string): DebugSelfCheckActionProbe {
  if (!ed || typeof ed.getAction !== 'function') return { present: false, supported: null };
  let action: unknown;
  try {
    action = ed.getAction(id);
  } catch {
    // getAction 抛错（编辑器半销毁 / 被代理拦住）⇒ 与"没有"同形：拿不到就是拿不到
    return { present: false, supported: null };
  }
  if (!action || typeof action !== 'object') return { present: false, supported: null };
  let supported: boolean | null = null;
  const fn = (action as { isSupported?: unknown }).isSupported;
  if (typeof fn === 'function') {
    try {
      const value = (fn as () => unknown).call(action);
      supported = typeof value === 'boolean' ? value : null;
    } catch {
      supported = null;
    }
  }
  return { present: true, supported };
}

/** 四枚动作一次探完（导出供单测：伪 editor 即可，不碰 Monaco 运行时） */
export function probeSemanticActions(
  ed: ActionLookupLike | null | undefined,
): DebugSelfCheckSemanticActions {
  const lookup = ed ?? null;
  return {
    definition: probeAction(lookup, SEMANTIC_ACTION_IDS.definition),
    codeAction: probeAction(lookup, SEMANTIC_ACTION_IDS.codeAction),
    signatureHelp: probeAction(lookup, SEMANTIC_ACTION_IDS.signatureHelp),
    documentSymbol: probeAction(lookup, SEMANTIC_ACTION_IDS.documentSymbol),
  };
}

/**
 * 一个特性注册表对当前 model 有没有 provider（三态）。
 *
 * 只有"注册表在、`ordered` 能调、返回的是数组"这三件事都成立，答案才是 true / false；
 * 其余一切（服务没到手 / 这版注册表换了名字 / `ordered` 抛错 / 返回值形态不认识）都归 null：
 * 升级之后我们看不懂它，就说看不懂，**不拿猜的当答案**。
 *
 * `method` 是判"这个条目到底是不是该特性的 provider"的依据（见 `unwrapProvider`）：
 * 注册表里可能混着别的特性的条目，光看"有条目"会把没有 provider 说成 true。
 */
function presenceOf(registry: unknown, model: unknown, method: string): SemanticProviderPresence {
  if (!model || !registry || typeof registry !== 'object') return null;
  const ordered = (registry as RegistryLike).ordered;
  if (typeof ordered !== 'function') return null;
  try {
    const entries = ordered.call(registry, model);
    if (!Array.isArray(entries)) return null;
    // 与 `providersOf` 同一条判据（同一个 `unwrapProvider`），两处读数才不会互相打架
    return entries.some((entry) => unwrapProvider(entry, method) !== null);
  } catch {
    return null;
  }
}

/**
 * 特性注册表字段 → provider 上的方法名。
 *
 * 0.57 把拆包做在 `ordered()` 里，条目就是 provider；要判断"这条到底是哪个特性的 provider"，
 * 唯一可靠的办法是看它有没有该特性的方法名。名字取自 Monaco 的 provider 契约
 * （`DocumentSymbolProvider.provideDocumentSymbols` 等），不是我们编的。
 */
const PROVIDER_METHODS: Record<keyof LanguageFeaturesLike, string> = {
  definitionProvider: 'provideDefinition',
  referenceProvider: 'provideReferences',
  codeActionProvider: 'provideCodeActions',
  signatureHelpProvider: 'provideSignatureHelp',
  documentSymbolProvider: 'provideDocumentSymbols',
};

/**
 * 语义读数的 provider 三态（导出供单测：伪 service + 伪 model 即可）。
 *
 * `service` 是 `ILanguageFeaturesService`（`languageFeaturesService()` 的结算值）。**它为什么
 * 会整体是 null**：Monaco 的 provider 注册表**没有公开读接口**——`monaco.languages.*` 只发
 * register*（0.57 上没有对应的 get*），注册表活在 standalone 的 DI 单例里，只能走
 * `monaco-editor/editor/standalone/browser/standaloneServices.js` 深路径 import（同文件
 * `languageFeaturesService` 那条腿）。打包器不认 exports / 版本改名 ⇒ 整块 null。
 * 所以整块 null 的含义是"这条路在当前构建上不通"，**不是**"当前语言没有 provider"——后者是 false。
 *
 * `diagnostics` 恒 null：`diagnostics()` 读的是 `monaco.editor.getModelMarkers`（公开 API，
 * 标记由语言服务自己往模型上推），**根本不经过 provider 注册表**。这里没有可问的 provider：
 * 给 true 会让人以为"诊断会自己来"，给 false 会让人以为"诊断坏了"，两种都是编造。
 */
export function probeProviderPresence(service: unknown, model: unknown): DebugSelfCheckProviders {
  const svc = (service && typeof service === 'object' ? service : null) as LanguageFeaturesLike | null;
  return {
    definition: presenceOf(svc?.definitionProvider, model, PROVIDER_METHODS.definitionProvider),
    references: presenceOf(svc?.referenceProvider, model, PROVIDER_METHODS.referenceProvider),
    codeAction: presenceOf(svc?.codeActionProvider, model, PROVIDER_METHODS.codeActionProvider),
    signatureHelp: presenceOf(svc?.signatureHelpProvider, model, PROVIDER_METHODS.signatureHelpProvider),
    documentSymbol: presenceOf(svc?.documentSymbolProvider, model, PROVIDER_METHODS.documentSymbolProvider),
    diagnostics: null,
  };
}

/**
 * provider 三态的**实时**读数。
 *
 * 拿不到 model / 服务还没结算 ⇒ 全 null（首调就是这种情形）：`selfCheck()` 是同步 API，
 * 这里只**踢一脚** `languageFeaturesService()` 不让它白等，本次如实给 null，下一次调用
 * 就能读到真实注册表。宁可第一次答"不知道"，也不许为了好看把同步读数退化成 async。
 */
function probeProvidersNow(ed: LiveEditor | null): DebugSelfCheckProviders {
  let model: unknown = null;
  try {
    model = ed?.getModel() ?? null;
  } catch {
    model = null; // 编辑器已销毁：取不到 model 就没有"当前语言"可言
  }
  if (!model) return probeProviderPresence(null, null);
  if (featuresServiceNow === null) void languageFeaturesService();
  return probeProviderPresence(featuresServiceNow, model);
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
  const core = summarizeSelfCheck({
    monacoVersion: resolveMonacoVersion(),
    languageId,
    selectors: probeSelectors(ed),
    foldingShape: foldingShapeOf(ed),
  });
  return {
    ...core,
    // `semantic` 拼在 `summarizeSelfCheck` **之外**：那个函数的返回形状是既有契约（单测按整对象
    // 断言），新读数只许 additive 地挂在外层。两块各探各的、各吞各的错：动作是同步查询，
    // provider 要等 DI 服务结算（首调如实 null），谁拿不到都不许拖垮另一半。
    semantic: summarizeSemanticCheck({
      actions: probeSemanticActions(ed),
      providers: probeProvidersNow(ed),
    }),
  };
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
          // 兜底也要交回**完整**形状（含 semantic）：只给 core 会让脚本读到 undefined
          return { ...summarizeSelfCheck(null), semantic: summarizeSemanticCheck(null) };
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
      async definitionAt(line, column, opts) {
        try {
          const target = await semanticTarget(line, column);
          if (!target) return [];
          const timeoutMs = clampTimeoutMs(opts?.timeoutMs, SEMANTIC_TIMEOUT_DEFAULT_MS);
          const raw = await collectFromProviders(
            'definitionProvider',
            'provideDefinition',
            target,
            timeoutMs,
            (token) => [target.model, target.position, token],
          );
          return slimLocations(raw, { rootDir: target.rootDir, limit: DEFINITION_LIMIT });
        } catch {
          return [];
        }
      },
      async referencesAt(line, column, opts) {
        try {
          const target = await semanticTarget(line, column);
          if (!target) return { items: [], total: 0 };
          const timeoutMs = clampTimeoutMs(opts?.timeoutMs, SEMANTIC_TIMEOUT_DEFAULT_MS);
          // 与菜单里的"查找引用"同源：`includeDeclaration` 缺省 true
          const includeDeclaration = opts?.includeDeclaration !== false;
          const raw = await collectFromProviders(
            'referenceProvider',
            'provideReferences',
            target,
            timeoutMs,
            (token) => [target.model, target.position, { includeDeclaration }, token],
          );
          const all = slimLocations(raw, { rootDir: target.rootDir, limit: REFERENCE_TOTAL_LIMIT });
          return { items: all.slice(0, REFERENCE_LIMIT), total: all.length };
        } catch {
          return { items: [], total: 0 };
        }
      },
      async codeActionsAt(line, column, opts) {
        try {
          const target = await semanticTarget(line, column);
          if (!target) return [];
          const timeoutMs = clampTimeoutMs(opts?.timeoutMs, SEMANTIC_TIMEOUT_DEFAULT_MS);
          // 零宽区间：与"光标停在这一格按 Alt+Enter"完全一样的位置语义
          const range = new target.monaco.Range(target.line, target.column, target.line, target.column);
          const raw = await collectFromProviders(
            'codeActionProvider',
            'provideCodeActions',
            target,
            timeoutMs,
            // triggerKind=1 是 `CodeActionTriggerKind.Invoke`：真人按键触发的就是这一档
            (token) => [target.model, range, { triggerKind: 1, only: undefined }, token],
          );
          // 回包是 `CodeActionList{actions,…}`：只摊 `actions`（其余是给你 dispose 的句柄）。
          // 少数 provider 直接返 `CodeAction[]`：带 title 的裸动作也认，别让它们静默消失。
          const actions: unknown[] = [];
          for (const item of raw) {
            if (!item || typeof item !== 'object') continue;
            const list = (item as { actions?: unknown }).actions;
            if (Array.isArray(list)) actions.push(...list);
            else if ('title' in (item as Record<string, unknown>)) actions.push(item);
          }
          return slimCodeActions(actions, CODE_ACTION_LIMIT);
        } catch {
          return [];
        }
      },
      async signatureAt(line, column, opts) {
        try {
          const target = await semanticTarget(line, column);
          if (!target) return null;
          const timeoutMs = clampTimeoutMs(opts?.timeoutMs, SEMANTIC_TIMEOUT_DEFAULT_MS);
          const raw = await collectFromProviders(
            'signatureHelpProvider',
            'provideSignatureHelp',
            target,
            timeoutMs,
            (token) => [
              target.model,
              target.position,
              token,
              { triggerKind: 1, isRetrigger: false, triggerCharacter: undefined },
            ],
          );
          // 第一个给得出签名的 provider 就是答案：与 Monaco 对多 provider 的取舍一致
          for (const item of raw) {
            const reading = slimSignature(item);
            if (reading) return reading;
          }
          return null;
        } catch {
          return null;
        }
      },
      async documentSymbols() {
        try {
          const target = await modelTarget();
          if (!target) return [];
          const raw = await collectFromProviders(
            'documentSymbolProvider',
            'provideDocumentSymbols',
            target,
            SEMANTIC_TIMEOUT_DEFAULT_MS,
            (token) => [target.model, token],
          );
          return slimSymbols(raw, SYMBOL_LIMIT);
        } catch {
          return [];
        }
      },
      async diagnostics() {
        // **复用** `markers()` 的取数腿：同一条 `editor.getModelMarkers`，本条只加
        // "当前文档作用域 + 裁剪"（markers() 仍是全模型、不裁剪，行为一个字节都不动）。
        try {
          const model = focusedCtx()?.editorRef.current?.getModel() ?? null;
          if (!model) return [];
          const monaco = await import('../monaco/entry');
          return slimDiagnostics(monaco.editor.getModelMarkers({ resource: model.uri }), DIAGNOSTIC_LIMIT);
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
