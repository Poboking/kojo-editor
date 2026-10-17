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
 */

import type { Unsubscribe } from './base';
import type { EventBus } from './events';
import { pathKey } from './paths';
import type { SugarDiagnostic, SugarSeverity } from './sugar';

/* ============================== 文件判定 ============================== */

/** 是否 `.kojo` 糖源文件（判定面板 / 波浪线 / 预览只作用于糖源；大小写不敏感） */
export function isKojoFile(path: string | null | undefined): boolean {
  return typeof path === 'string' && /\.kojo$/i.test(path);
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

export function createPanelTruthController(bus: Pick<EventBus, 'on'>): PanelTruthController {
  const pool = createLiveTextPool();
  let currentFile: string | null = null;
  return {
    pool,
    attach(handlers): Unsubscribe {
      const unActive = bus.on('editor.activeFileChanged', (p) => {
        currentFile = p.filePath;
        handlers.onActiveFile(p.filePath);
      });
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
  'no-project': '未打开 .kojo 文件（从左侧选一份开始编辑）',
  'no-file': '打开一个 .kojo 文件后可用',
  'not-kojo': '当前文件不是 .kojo（转译检查只对 .kojo 文件生效）',
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
