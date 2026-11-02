/**
 * 糖面板共享核（W4 PANEL-DEDUP，2026-10-18 面板去重批）。
 *
 * 为什么住契约层：`ui-sugar-editor`（糖判定）与 `ui-sugar-preview`（转译检查）
 * 曾把同一套渲染逻辑**逐字抄了两份**——行池、`.kojo` 判定、降级文案、诊断窗口、
 * 触底哨兵、三事件订阅各一对拷贝。后果是新增一种真相事件要改 ≥4 处，同屏两份
 * 诊断列表行序/窗口口径悄悄分叉。插件之间**不许交叉 import**（解耦审计 C 项），
 * 共享件的唯一合法落点就是 `plugin-api`。
 *
 * 框架无关纪律：本模块零 React、零 DOM 类型依赖——触底观察器走最小结构化类型 +
 * `globalThis` 探测（不可用即退化为纯点击，行为不丢），面板壳留在各自插件里。
 *
 * 2026-11-02 kw8a 行键盘批追加：本模块同时是**面板行键盘协议**（`rowNavDecision` /
 * `applyPanelRowNav` / `nextRovingIndex`）的契约层真源——宿主两只面板与插件面板共用
 * 同一把尺子（插件不许 import 宿主，铁律 2），落点理由见该区块头注。
 */

import type { Unsubscribe } from './base';
import type { AnyEventMap, EventBus } from './events';
import { pathKey } from './paths';
import { KOJO_V1_SOURCE_EXTENSIONS } from './sugar';
import type { SugarDiagnostic, SugarSeverity } from './sugar';

/* ============================== 文件判定 ============================== */

/**
 * 是否 kojo1（封存层）的糖源文件（判定面板 / 波浪线 / 预览只作用于糖源；大小写不敏感）。
 *
 * LAU-3b-FLIP（2026-10-27）：`.kojo` 归 kojo（2.0），封存层的源只剩 `.kojo1`。
 * 判据取契约层 `KOJO_V1_SOURCE_EXTENSIONS`，不在本文件另抄一份字面量——否则
 * 2.0 文件会被糖面板接管，正是"封存层污染统一架构"的那条路。
 */
export function isKojoFile(path: string | null | undefined): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  const lower = path.toLowerCase();
  return KOJO_V1_SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/* ============================== 缓冲真相池（C2） ============================== */

/**
 * 编辑器**缓冲真相**池：消费宿主广播 `editor.documentChanged` 的最新文本，
 * **按文件**各留一条。语义（与契约注释同一口径）：
 * - 同一 path 的新广播**覆盖旧**——它就是"这个文件此刻的可编译真相"；
 * - `textFor()` 返回 null = 还没收到该文件的广播（首开窗口期）→ 调用方退回
 *   `io.readText` 读盘兜底；返回非空 = 以广播为准，**不得**再读盘（否则又成分叉）；
 * - path 判等走 `pathKey()` 归一：事件路径平台原样，裸字符串比会在 Windows 上
 *   静默判不上（HK-7 同款坑）；
 * - 只进不删、条数 = 会话内收到过广播的文件数（面板场景就一两份文件，不设上限）。
 */
export interface LiveTextPool {
  /** 记一条广播（同 path 覆盖旧值） */
  apply(filePath: string, text: string): void;
  /** 该文件的最新真相；未收到过广播返回 null（调用方走读盘兜底） */
  textFor(filePath: string | null | undefined): string | null;
}

export function createLiveTextPool(): LiveTextPool {
  const byKey = new Map<string, string>();
  return {
    apply(filePath: string, text: string): void {
      byKey.set(pathKey(filePath), text);
    },
    textFor(filePath: string | null | undefined): string | null {
      if (filePath === null || filePath === undefined) return null;
      return byKey.get(pathKey(filePath)) ?? null;
    },
  };
}

/* ============================== 真相事件订阅生命周期 ============================== */

/**
 * 面板对宿主"真相三事件"的回调面。两份糖面板曾各自抄一遍
 * `activeFileChanged / documentChanged / cursorMoved` 的订阅 + 退订 +
 * pathKey 命中比对——口径漂移就发生在那两份拷贝之间，故收成一份控制器：
 * - **attach 一次订齐三条，dispose 一次退净三条**（漏一条 = 面板卸载后仍在收广播）；
 * - **当前文件是状态、走 sticky 回放**（2026-10-18）：`editor.activeFileChanged` 由总线
 *   保留最后一条，面板挂载晚于文件打开时 attach 当场补发——不再靠"订阅恰好赶在广播前"；
 *   另两条是通知，按普通订阅；
 * - 广播**一律先进池**（不管命不命中当前文件，切回旧文件时真相还在）；
 * - 命中判据（当前文件相等 + 非派生视图）住在核内，面板只拿**已裁决**的结果：
 *   `onLiveText` 只在命中当前文件时回调；`onCursorLine` 不命中即 null。
 */
export interface PanelTruthHandlers {
  /** 当前活动文件变了（null = 无打开文件）；面板据此重置自身状态 */
  onActiveFile(filePath: string | null): void;
  /** 当前文件收到新的缓冲真相广播（池已由核写入）；面板据此驱动重算 */
  onLiveText(filePath: string, text: string): void;
  /** 光标行；不属于当前文件 / 派生视图 / 无文件 → null（清高亮，静默） */
  onCursorLine(line: number | null): void;
}

export interface PanelTruthController {
  /** 全生命周期复用**同一个池**（attach/dispose 不重建 = 不产生第二份文本源） */
  readonly pool: LiveTextPool;
  /** 订阅三条真相事件，返回一次性退订（三条全覆盖，可反复 attach/dispose） */
  attach(handlers: PanelTruthHandlers): Unsubscribe;
}

export function createPanelTruthController(
  bus: Pick<EventBus, 'on' | 'onSticky'>,
): PanelTruthController {
  const pool = createLiveTextPool();
  let currentFile: string | null = null;
  return {
    pool,
    attach(handlers): Unsubscribe {
      /**
       * 当前文件裁决（回放与新广播共用同一个入口——两条来路必须落在同一状态上，
       * 否则 currentFile 会只在其中一条路上初始化）。
       */
      const onActiveFile = (p: AnyEventMap['editor.activeFileChanged']): void => {
        currentFile = p.filePath;
        handlers.onActiveFile(p.filePath);
      };
      /**
       * `onSticky` 优先（2026-10-18 面板挂载补真相批）：面板在文件**已打开之后**
       * 才挂载时，`emit` 早已过去——sticky 状态在 attach 这一刻同步补发当前文件，
       * 首帧就有真相（此前要切一次文件才恢复）。
       * 没有 `onSticky` 的总线（旧替身 / 极简实现）退回 `on`：能听但无回放，
       * 行为与引入前逐字一致。
       */
      const unActive = bus.onSticky
        ? bus.onSticky('editor.activeFileChanged', onActiveFile)
        : bus.on('editor.activeFileChanged', onActiveFile);
      const unDoc = bus.on('editor.documentChanged', (ev) => {
        pool.apply(ev.filePath, ev.text);
        if (currentFile !== null && pathKey(ev.filePath) === pathKey(currentFile)) {
          handlers.onLiveText(ev.filePath, ev.text);
        }
      });
      const unCursor = bus.on('editor.cursorMoved', (p) => {
        const here =
          !p.derivedView &&
          currentFile !== null &&
          p.filePath !== null &&
          pathKey(p.filePath) === pathKey(currentFile);
        handlers.onCursorLine(here ? p.line : null);
      });
      return () => {
        unActive();
        unDoc();
        unCursor();
      };
    },
  };
}

/* ============================== 降级态 ============================== */

/** 面板降级原因（能力/项目缺席要"退化可见"，不静默）；两面板共用闭集 */
export type PanelDegrade =
  | 'no-project'
  | 'no-file'
  | 'not-kojo'
  | 'reading'
  | 'previewing'
  | 'read-error'
  | 'preview-error';

const DEGRADE_TEXT: Record<PanelDegrade, string> = {
  'no-project': '未打开 .kojo1 文件（从左侧选一份开始编辑）',
  'no-file': '打开一个 .kojo1 文件后可用',
  'not-kojo': '当前文件不是 .kojo1（转译检查只对封存的 kojo1 源生效）',
  reading: '读取中…',
  previewing: '生成预览中…',
  'read-error': '读取失败',
  'preview-error': '预览生成失败',
};

export function degradeText(d: PanelDegrade): string {
  return DEGRADE_TEXT[d];
}

/** 活动文件 → 初始降级态（曾两面板各抄一遍同一三元表达式；收成一处判据） */
export function degradeForActiveFile(filePath: string | null): PanelDegrade {
  if (!filePath) return 'no-project';
  return isKojoFile(filePath) ? 'reading' : 'not-kojo';
}

/* ============================== 诊断行（两面板同一口径） ============================== */

/**
 * 诊断列表行（渲染数据源）。两面板曾一个排序一个不排——同屏看同一份文件的
 * 诊断，行序竟然不同。此处定唯一口径：**有位置的在前、(行, 列) 升序、文件级
 * 殿后、同位置保留原序**（稳定排序 ⇒ UI 不抖动）。
 */
export interface PanelDiagnosticRow {
  /** 稳定键（React 渲染用；诊断无天然 id，故用序号） */
  readonly key: string;
  readonly severity: SugarSeverity;
  readonly code: string;
  /** 1 基行号；文件级诊断为 null */
  readonly line: number | null;
  /** 1 基列号；无位置时为 null */
  readonly column: number | null;
  readonly message: string;
}

export function buildPanelDiagnosticRows(
  diagnostics: readonly SugarDiagnostic[] | undefined,
): PanelDiagnosticRow[] {
  const rows: PanelDiagnosticRow[] = (diagnostics ?? []).map((d, i) => ({
    key: `${d.code}|${d.loc?.line ?? 0}|${d.loc?.column ?? 0}|${i}`,
    severity: d.severity,
    code: d.code,
    line: d.loc?.line ?? null,
    column: d.loc?.column ?? null,
    message: d.message,
  }));
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const al = a.r.line ?? Number.MAX_SAFE_INTEGER;
      const bl = b.r.line ?? Number.MAX_SAFE_INTEGER;
      if (al !== bl) return al - bl;
      const ac = a.r.column ?? Number.MAX_SAFE_INTEGER;
      const bc = b.r.column ?? Number.MAX_SAFE_INTEGER;
      if (ac !== bc) return ac - bc;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

/* ============================== 渲染窗口（触底增窗） ============================== */

/** 窗口参数：INITIAL 是首帧 DOM 上界，触底/点击按 STEP 增长，全量可达 */
export interface RenderWindow {
  readonly initial: number;
  readonly step: number;
}

/**
 * 诊断列表窗口。两面板曾一个 80/160 一个 60/120——同一份诊断列表在同屏出现
 * 两套首帧行数，是纯粹的口径分叉；统一取宽的那档（initial=80），因为**首帧
 * 行数唯一影响的是"典型文件一窗看全"，两面板必须同值**才可能互相印证。
 * 取值依据沿用判定面板侧：诊断行单行 ~20px，典型 .kojo 文件诊断 <50 条 ⇒
 * 一窗盖住绝大多数文件，步长按 1:2 节奏（与函数树的面窗口同比例）。
 */
export const DIAG_WINDOW: RenderWindow = { initial: 80, step: 160 };

/** 逐行映射区窗口（仅预览面板消费；单行 ~19px 等宽小字，INITIAL=120 ≈ 两屏余） */
export const ROW_WINDOW: RenderWindow = { initial: 120, step: 240 };

/** 兼容旧导入名（两面板及其 app 侧 SSR 测试都引这四个常量，勿动形状） */
export const DIAG_WINDOW_INITIAL = DIAG_WINDOW.initial;
export const DIAG_WINDOW_STEP = DIAG_WINDOW.step;
export const ROW_WINDOW_INITIAL = ROW_WINDOW.initial;
export const ROW_WINDOW_STEP = ROW_WINDOW.step;

/** 当前窗口应渲染的行数（纯函数）：[0, min(total, limit ?? initial)] */
export function windowSize(total: number, limit: number | undefined, w: RenderWindow): number {
  return Math.min(total, limit ?? w.initial);
}

/**
 * 窗口下一步（纯函数）：min(total, max(initial, 当前 + step))。
 * 单调不减、单步增量 ≤ step、终值 = total——「显示更多」与触底自动加载共用。
 */
export function nextWindow(current: number | undefined, total: number, w: RenderWindow): number {
  const base = current ?? w.initial;
  return Math.min(total, Math.max(w.initial, base + w.step));
}

/** 增窗一步；无增长时**原样返回 current**（含 undefined）⇒ 宿主 setState 可跳过重渲 */
export function growWindow(
  current: number | undefined,
  total: number,
  w: RenderWindow,
): number | undefined {
  const next = nextWindow(current, total, w);
  if (next === (current ?? w.initial)) return current;
  return next;
}

/** 诊断窗口两步（钉死"两面板同参数"——走同一 RenderWindow，不再有 80/60 隐性分叉） */
export function diagWindowSize(total: number, limit: number | undefined): number {
  return windowSize(total, limit, DIAG_WINDOW);
}

export function nextDiagWindow(current: number | undefined, total: number): number {
  return nextWindow(current, total, DIAG_WINDOW);
}

/** 逐行映射窗口两步 */
export function rowWindowSize(total: number, limit: number | undefined): number {
  return windowSize(total, limit, ROW_WINDOW);
}

export function nextRowWindow(current: number | undefined, total: number): number {
  return nextWindow(current, total, ROW_WINDOW);
}

/* ============================== 「显示更多」触底哨兵 ============================== */

/**
 * 哨兵行为核：进入滚动视口即回调一次增窗（IntersectionObserver——列表所在面板
 * 自带滚动裁剪，浏览器按可见矩形判相交，不必手动传 root）；观察器不可用
 * （SSR / 测试 / 旧环境）时返回**空退订**，按钮退化为纯点击——功能不丢。
 * 类型口径：插件编译在无 DOM lib 下，节点与观察器一律走最小结构化类型。
 */
type IntersectionObserverLike = new (
  cb: (entries: ReadonlyArray<{ isIntersecting: boolean }>) => void,
) => { observe(target: object): void; disconnect(): void };

export function attachGrowSentinel(node: unknown, onGrow: () => void): Unsubscribe {
  const el = node as object | null;
  const IO = (globalThis as { IntersectionObserver?: IntersectionObserverLike }).IntersectionObserver;
  if (!el || !IO) return () => undefined;
  const io = new IO((entries) => {
    if (entries.some((e) => e.isIntersecting)) onGrow();
  });
  io.observe(el);
  return () => io.disconnect();
}

/** 哨兵外观单一真源（曾两份拷贝各抄一份 style/title/文案）：hint 语言 + 主题令牌 */
export const MORE_ROW_STYLE = { width: '100%', textAlign: 'center', borderStyle: 'dashed' } as const;
export const MORE_ROW_TITLE = '滚到此处会自动加载下一批；也可直接点击';
export function moreRowLabel(remaining: number): string {
  return `显示更多（还剩 ${remaining}）`;
}

/* ============================== 面板行键盘导航（行键盘协议） ============================== */

/**
 * 结果类面板的**行导航**（1020 编辑器体感批定稿的用户反馈项 9；kw8a 1102 行键盘批
 * 从宿主 `ui/panel-row-nav.ts` + `ui/shell-keys.ts` 上提成契约层单源）。
 *
 * 协议口径**逐字不变**：
 *
 * - **↑↓ = 只在可见行之间移动焦点**，不打开任何东西：焦点不在行上时，↓ 从第一行走、
 *   ↑ 从最后一行走（同一条回绕尺子，不留特例）；
 * - **F4 / F8 = 移动焦点并当场打开**（Shift 反向）：等价于"按 ↑↓ 走到那一行再敲 Enter"，
 *   所以打开动作走的还是那一行按钮自己的 `onClick`，面板里不留第二条跳转路径；
 * - **`<select>` / `<textarea>` 里的方向键一律让位**：下拉框的方向键是改选项、
 *   多行框的方向键是移光标，把它们吃掉就成了"排序框按不动"那种新 bug。
 *   单行检索框不放这条：那里 ↑↓ 本来什么都不做，让给行导航正是作者要的手感。
 * - **输入法合成期一律放行**（宿主全局键那条已登记缺口的行导航侧：合成中的键归输入法，
 *   行导航一个字节都不动）。
 *
 * **为什么住契约层**：这条协议要同时喂宿主两只面板与插件面板，而插件不许 import 宿主
 * 模块（铁律 2）——共享件的唯一合法落点是 `plugin-api`（本文件先例：`attachGrowSentinel`
 * 同款最小结构化类型，零 DOM 类型依赖，测试桩不必起 jsdom）。
 * **为什么并入本文件而不另立叶子**：`nextRovingIndex` 的消费者 `ui/shell-keys.ts` 住在
 * 开机图里，新开一枚文件就是把 201 顶格的文件闸顶爆（本闸纪律"再进图必须先出图"）；
 * 并入这枚已在图里的面板共享核，文件数持平、只付真实字节（归因见
 * `packages/app/tests/ps10-eager-graph.test.ts` 台账）。
 */

/** 结果行的 DOM 标记：容器里带这个属性的按钮才参与行导航（折叠组里没画出来的行自然不在名单上） */
export const PANEL_ROW_ATTR = 'data-panel-row';

/** 行名单的选择器（与行标记 `PANEL_ROW_ATTR` 同一个真源，两处不许各写一遍字符串） */
export const PANEL_ROW_SELECTOR = `[${PANEL_ROW_ATTR}]`;

/** 方向键让位的那几种控件（单行检索框不在内，理由见协议头注） */
const FIELD_SELECTOR = 'select, textarea';

/** 一次导航的落点：第几行（容器内可见行的下标），要不要顺手打开。
 * **只给"是否打开"这一格事实，不给任何跳转路径**——打开永远敲行自己的 `onClick`。 */
export interface RowNavDecision {
  readonly index: number;
  readonly open: boolean;
}

export interface RowNavInput {
  readonly key: string;
  readonly shiftKey: boolean;
  /** 当前聚焦行的下标；焦点不在结果行上 = `-1` */
  readonly current: number;
  /** 可见结果行数（0 = 没有可导航的行） */
  readonly count: number;
  /** 按键落在下拉框 / 多行框里（方向键要让位，功能键不用） */
  readonly inField: boolean;
}

/**
 * 方向键漫游（roving tabindex）的下一个落点（2026-10-14 HK-4 UI 批：焦点环与键盘可达；
 * kw8a 1102 行键盘批从宿主 `ui/shell-keys.ts` 原样上提——文件树与 tablist 的
 * `shell-keys.nextRovingIndex` 改成薄转发，全仓只有这一把漫游尺子）。
 *
 * 语义（调用方原样消费返回值）：
 * - `ArrowRight` / `ArrowDown` 前进一格，`ArrowLeft` / `ArrowUp` 后退一格；
 * - `Home` → `0`，`End` → `count - 1`；
 * - **边界一律回绕**（wrap-around）：末尾再前进落到 `0`，`0` 再后退落到 `count - 1`。
 *   选回绕而非停在末尾，与 ARIA APG 的 tablist 范例一致——一组控件是一圈，不是一条死胡同。
 * - 非漫游键 → `null`（调用方**原样让位**给原生行为：Enter/Space 激活、Tab 跳走都不该被吞）。
 *
 * 边界：`count <= 0` 返回 `null`（空集合无可漫游）；`current` 先夹取到 `[0, count-1]`
 * 再算（`Array#indexOf` 的 `-1` 就是靠这一步归位到 0）。
 */
export function nextRovingIndex(current: number, count: number, key: string): number | null {
  if (count <= 0) return null;
  const cur = Math.min(count - 1, Math.max(0, current));
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (cur + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (cur - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * 一次按键该怎么走（纯函数；`null` = 不消费，原样让位，绝不吞别人的键）。
 *
 * F4 与 F8 走同一条腿是有意的：VS Code 里 F4 属于"检索结果"、F8 属于"问题"，
 * 但在**面板里**它们问的是同一件事——"下一个 / 上一个"。一把尺子两处用，
 * 作者从哪个面板学到的手感都到得了另一个。
 */
export function rowNavDecision(input: RowNavInput): RowNavDecision | null {
  const { key, shiftKey, current, count, inField } = input;
  let dir: 1 | -1;
  let open: boolean;
  if (key === 'ArrowDown') {
    dir = 1;
    open = false;
  } else if (key === 'ArrowUp') {
    dir = -1;
    open = false;
  } else if (key === 'F4' || key === 'F8') {
    dir = shiftKey ? -1 : 1;
    open = true;
  } else {
    return null;
  }
  if (open === false && inField) return null; // 下拉框 / 多行框里的方向键归那个控件
  if (count <= 0) return null;
  // 焦点还没进列表（在检索框里）：↓ 进**第一行**、↑ 进**最后一行**——这一步不走回绕，
  // 因为 `nextRovingIndex` 把 `-1` 先夹到 `0` 再加一，从输入框按 ↓ 会跳到第二行（少一行）。
  if (current < 0) return { index: dir === 1 ? 0 : count - 1, open };
  const index = nextRovingIndex(current, count, dir === 1 ? 'ArrowDown' : 'ArrowUp');
  return index === null ? null : { index, open };
}

/** 一个可导航的结果行（DOM 元素满足这个形状；测试里给桩即可，不必起 jsdom） */
export interface PanelRowElement {
  focus(): void;
  click(): void;
  closest?(selector: string): unknown;
}

/** 行导航要找的那一段容器（只含结果区，工具条与过滤框不参与 ⇒ 不在同一棵子树里） */
export interface PanelRowNavHost {
  querySelectorAll(selector: string): ArrayLike<PanelRowElement>;
}

/** 键盘事件里本模块要看的那几样（React 合成事件与原生事件都满足 ⇒ 接线处零适配） */
export interface RowNavDomEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly target: unknown;
  /** 输入法合成期（事件级判据；宿主全局键那三条证据的另两条是会话标志，不归行导航） */
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  preventDefault(): void;
}

/** 挂在容器上的键盘事件：`currentTarget` 就是行名单容器 ⇒ 接线处一行调用，不再自己抓 ref */
export interface RowNavHostEvent extends RowNavDomEvent {
  readonly currentTarget: PanelRowNavHost | null;
}

/**
 * `keyCode === 229`（`Process`）：输入法合成期的键码。
 * 与宿主 `ui/shell-keys.ts` 的 `IME_PROCESS_KEY_CODE` 同值不同渠道——那枚喂全局键的
 * 三层早退（还要叠会话标志），这里只看事件级证据，不许反向 import 宿主（铁律 2）。
 */
const IME_COMPOSING_KEY_CODE = 229;

/** 把一次按键落到容器里的行按钮上。返回 `true` = 已消费。
 *
 * 行名单每次现取（不缓存）：结果随流式检索一行行长出来、过滤与折叠也会改名单，
 * 缓存下标一定会指错行。取的是 **DOM 序**，与面板画行的序同一条 ⇒ 所见即所跳。
 */
export function applyPanelRowNav(host: PanelRowNavHost | null, e: RowNavDomEvent): boolean {
  if (host === null) return false;
  // 合成中的方向键归输入法（候选列表就靠它翻页）——不 preventDefault，原样放行
  if (e.isComposing === true || e.keyCode === IME_COMPOSING_KEY_CODE) return false;
  const target = e.target as { closest?(selector: string): unknown } | null;
  // `closest` 只在这一处判一次存在性（TS narrowing 穿不过布尔变量，写成 canClimb 就得再断言一次）
  if (typeof target?.closest !== 'function') {
    return applyRowNav(host, e, null, false);
  }
  const climb = target.closest.bind(target);
  return applyRowNav(host, e, climb(PANEL_ROW_SELECTOR) as PanelRowElement | null, climb(FIELD_SELECTOR) !== null);
}

/** 挂在容器上的便捷入口：宿主 = 事件自己的 `currentTarget`（接线处只留一行）。 */
export function applyPanelRowNavFromEvent(e: RowNavHostEvent): boolean {
  return applyPanelRowNav(e.currentTarget, e);
}

function applyRowNav(
  host: PanelRowNavHost,
  e: RowNavDomEvent,
  owner: PanelRowElement | null,
  inField: boolean,
): boolean {
  const rows = Array.from(host.querySelectorAll(PANEL_ROW_SELECTOR));
  const decision = rowNavDecision({
    key: e.key,
    shiftKey: e.shiftKey,
    current: owner === null ? -1 : rows.indexOf(owner),
    count: rows.length,
    inField,
  });
  if (decision === null) return false;
  const next = rows[decision.index];
  if (next === undefined) return false;
  e.preventDefault();
  next.focus();
  // Tab 序跟着焦点走：漫游位只有踩住的那一行是 0（`syncRovingTabIndexes` 同款，就地办结，
  // 不等重渲染——键盘移动焦点往往恰恰不触发渲染）
  roveTabIndexesTo(rows, next);
  // 打开就敲这一枚按钮本身：跳转判据仍然只住在行的 onClick 那一处
  if (decision.open) next.click();
  return true;
}

/** 带漫游 tabindex 的行形状（真实 DOM 元素天然满足；桩没有该属性时赋值即补上，无害） */
export interface PanelRovingRowElement extends PanelRowElement {
  tabIndex: number;
}

/** 能列出行名单、行上带 tabindex 的容器（= `PanelRowNavHost` 的行加强形状） */
export interface PanelRowRovingHost {
  querySelectorAll(selector: string): ArrayLike<PanelRovingRowElement>;
}

function roveTabIndexesTo(rows: readonly PanelRowElement[], target: PanelRowElement | null): void {
  const keep = target === null ? rows[0] : target;
  for (const row of rows) {
    const tabbable = row as { tabIndex?: number };
    const next = row === keep ? 0 : -1;
    if (tabbable.tabIndex !== next) tabbable.tabIndex = next;
  }
}

/**
 * 行级 **roving tabindex**（照宿主 `FileTree.tsx` 每帧一趟扫描的先例）：整段名单里只留
 * 一枚 `tabIndex = 0`——焦点踩住的那一行；焦点不在任何行上时兜底给第一行，其余一律 `-1`。
 * 面板在渲染后的 effect 与容器 focus 事件两处调用（键盘移动焦点那一腿由
 * `applyPanelRowNav` 就地办结）。无 `document` 的环境（SSR / 纯函数桩）按"焦点不在行上"
 * 处理 ⇒ 兜底第一行，判据不静默。
 */
export function syncRovingTabIndexes(host: PanelRowRovingHost | null): void {
  if (host === null) return;
  const rows = Array.from(host.querySelectorAll(PANEL_ROW_SELECTOR));
  if (rows.length === 0) return;
  const active = (globalThis as { document?: { activeElement?: unknown } }).document?.activeElement ?? null;
  roveTabIndexesTo(rows, rows.find((row) => row === active) ?? rows[0] ?? null);
}
