import { createElement as h, useEffect, useRef, useState, type ReactNode } from 'react';
import type { FileIO } from '@kojo/plugin-api';
import { errorText } from '@kojo/plugin-api';
import {
  buildDiffViewMenu,
  clearDiff,
  closeDiffPane,
  DIFF_VIEW_MENU_IDS,
  DIFF_VIEW_SURFACE_ID,
  diffEqualityBanner,
  diffEqualityOf,
  diffSummaryText,
  focusDiffPane,
  getDiffPanes,
  languageIdForSide,
  subscribeDiff,
  type DiffPane,
  type DiffRequest,
  type DiffViewMenuInput,
} from './diff-view';
import { declareContextSurface } from './context-surfaces';
import { CODE_FONT_BASELINE } from './code-font'; // 比对面与主编辑器同一张字面（全站唯一一条栈）
import { overlayEditorAppearance } from './overlay-editor-appearance';
import { overlayFrame, overlaySkeletonWell, overlaySpinner } from './overlay-chrome';
import { monacoThemeIdFor } from '../monaco/theme';
import { loadThemePref, useThemePref } from './theme-pref';

/**
 * 通用 diff 视图 overlay（2026-10-15 比对/历史批；W10 第 2 点改多开）。
 *
 * 渲染用 `monaco.editor.createDiffEditor`（Monaco 已打包的内建 contrib）——
 * 行级差异计算在 Monaco 自己的差分级路径里做，宿主**零 diff 算法**；语料最大
 * 单文件（5.2 万行 / 2.35 MB）由 Monaco 的分块渲染扛住，主线程只承担一次
 * 模型创建。**刻意动态 import monaco**：本模块要在 node 测试环境里可静态渲染，
 * 而 monaco 在 node 下加载即炸——编辑器创建本来就只发生在浏览器 effect 里。
 *
 * 比对栈（`diff-core.ts`）在这里投影成一排标签：栈顶是当前这本，关一格回上一格，
 * 栈空才收模态。每格两侧的读取快照按 `key` 各自缓存——换格子不许把别的格子的
 * 读数搅在一起（旧单例正是栽在"后开者顶掉前一个"）。
 */

export interface DiffViewDeps {
  io: FileIO;
  close(): void;
  /**
   * 订阅「这一扇浮层被关掉了」的意图（宿主 `ui.overlay.close` 通道；退订交回）。
   *
   * 为什么要订：**关闭按钮走 `deps.close()`（里面带 `clearDiff()`），而 Esc 与点遮罩
   * 走的是壳层自己的 `setActiveOverlay(null)`**——两条通道只有一条清栈，于是"按 Esc 关掉
   * 比对、下次开窗读到上一次的陈年比对"。本组件订得住自己那枚 id 的关闭事件，
   * 于是任何一条通道只要最终发了关闭意图，栈就跟着收；`clearDiff()` 幂等，
   * 按钮那条自己已经清过也不会重复清出第二件事，更不会反过来再发关闭 ⇒ 无回环。
   * 缺席（旧宿主 / 测试）⇒ 行为与改前逐字一致，只是仍只有按钮那一条通道清栈。
   */
  onCloseIntent?(handler: () => void): () => void;
}

/** 一侧的解析结果：文本已就位，或读取失败（失败可见，不静默） */
type SideResolved =
  | { kind: 'loading' }
  | { kind: 'ok'; text: string; bytes?: Uint8Array }
  | { kind: 'error'; message: string };

/** 一格两侧的读取快照 */
interface PaneSides {
  original: SideResolved;
  modified: SideResolved;
}

/* ─────────────── PS-5 对比体量闸（越界要**说出来**，并留下明知的去路） ─────────────── */

/**
 * 两侧文本合计长度上限（UTF-16 码元）。
 *
 * 为什么必须自己钉一条：monaco 的 diff 在 standalone 里**没有 worker 通道**
 * （`externalLinesDiffComputer` 那条走 VS Code 的 `DiffEditorController`，
 * monaco-editor 产物里取不到），行级差异就在主线程算——两份 2.35 MB 的正文对拍一次，
 * 卡的是整个窗口。vendor 自带的两道刹车（`maxComputationTime` 缺省 5,000ms、
 * `maxFileSize` 缺省 50 MB）都太晚：前者是"跑满 5 秒才放弃"，后者按字节算，
 * 语料最大单文件的 20 倍才触发。
 *
 * 尺子：真实语料最大单文件 52,601 行 / 2.35 MB（UTF-8 字节，折码元约 0.8–1.3 M）
 * ⇒ **两侧合计 ~2.6 M 码元**。取 3,000,000 就是把"语料里最大那一对的正常对比"
 * 留在闸内（不给真实用户加一次点击），只挡住比它还大一截的盘。
 */
export const DIFF_GATE_MAX_UNITS = 3_000_000;

/** 两侧合计行数上限（与码元数**并判**，任一越界即停；理由同 marker 闸：行级状态机的固定开销随行数走） */
export const DIFF_GATE_MAX_LINES = 150_000;

/**
 * 这一对要不要先停下来（纯函数）。
 *
 * 停 ≠ 藏：调用方**必须**把"为什么没对比"写在原处，并给一条「仍然对比」的明示去路
 * （铁律 4——降级不许静默；对比是只读呈现面，明知要卡是用户的权利）。
 */
export function diffGatePaused(units: number, lines: number): boolean {
  return units > DIFF_GATE_MAX_UNITS || lines > DIFF_GATE_MAX_LINES;
}

/**
 * 折叠"未改动区域"的门槛（两侧合计行数）。
 *
 * 大对比里真正的渲染账不是算差异，而是**把两遍全文铺成行**：一屏看不了 5 万行，
 * 而未改动区段占其中绝大多数。过了这道门槛就让 monaco 的 `hideUnchangedRegions`
 * 把连续未改动段折起来（视口行数随改动密度而不是随文件长度增长）。
 * 门槛以下**行为与改前逐字一致**（选项在建编辑器时一次性给出，不改已有对比的观感）。
 */
export const DIFF_COLLAPSE_MIN_LINES = 20_000;

const loadingSides: PaneSides = { original: { kind: 'loading' }, modified: { kind: 'loading' } };

/** 换行符计数（1 基行数；零中间分配，代价是一次线性扫描，只在两侧就位后各跑一次） */
export function countLines(text: string): number {
  if (text.length === 0) return 1;
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/**
 * 量级怎么说给作者听：中文里读"多少字"，不读 byte / UTF-16 码元这类内部口径
 * （`guard: no-sugar-jargon` 一族的要求——状态栏与弹窗是作者看的，不是实现日志）。
 */
export function formatCharCount(units: number): string {
  return units >= 10_000 ? `${(Math.round(units / 1000) / 10).toLocaleString('zh-CN')} 万` : String(units);
}

/**
 * 解析一侧内容：`text` 直用；否则按 `path` 经内核 io 现读（读侧无写闸，
 * 游戏目录 / 备份目录同样读得到）。路径侧顺手取原始字节——判等核的**字节态**
 * 要靠它（行同字节不同 = 编码/换行差异，必须在横幅里说出来）。字节取不到时
 * 只降级字节态（行态照判），不拿"没取到"冒充"相同"。
 */
async function resolveSide(side: { text?: string; path?: string }, io: FileIO): Promise<SideResolved> {
  if (typeof side.text === 'string') return { kind: 'ok', text: side.text };
  if (typeof side.path === 'string' && side.path.length > 0) {
    try {
      const [tf, bytes] = await Promise.all([
        io.readText(side.path),
        io.readBytes(side.path).catch(() => undefined),
      ]);
      return { kind: 'ok', text: tf.text, bytes };
    } catch (err) {
      return { kind: 'error', message: `${side.path} 读取失败：${errorText(err)}` };
    }
  }
  return { kind: 'error', message: '该侧没有可显示的内容' };
}

/** 收摊：清栈 + 请宿主关模态（栈留着会让下次"没内容"的开窗读到陈年比对） */
function dismissAll(deps: DiffViewDeps): void {
  clearDiff();
  deps.close();
}

/* ------------------------------ 右键菜单（WP3.6） ------------------------------ */

/** 剪贴板入口（缺席 ⇒ null：复制项禁用并说清原因） */
function clipboardApi(): Clipboard | null {
  return typeof navigator === 'undefined' ? null : (navigator.clipboard ?? null);
}

/**
 * 面 ↔ 组件之间的动作桥（面在模块顶层声明，读不到 React 闭包）。
 *
 * `snapshot` / `run` 由组件在每次渲染时写进 ref（三个早退分支里写 `null`：这一屏
 * 没有可复制 / 可跳转的对象，面就不表态，右键落到兜底菜单）。
 */
interface DiffViewFaceBridge {
  readonly clipboardAvailable: boolean;
  snapshot(): DiffViewMenuInput | null;
  run(id: string): void;
}

let faceBridge: DiffViewFaceBridge | null = null;

declareContextSurface({
  id: DIFF_VIEW_SURFACE_ID,
  ariaLabel: '差异视图菜单',
  area: 'panel',
  build: () => {
    const bridge = faceBridge;
    if (bridge === null) return null;
    const input = bridge.snapshot();
    if (input === null) return null;
    const menu = buildDiffViewMenu(input);
    if (menu === null) return null;
    return { items: menu.items, onSelect: (id) => bridge.run(id) };
  },
});

export function createDiffViewOverlay(deps: DiffViewDeps): () => unknown {
  return function DiffViewOverlay(): unknown {
    const [, setTick] = useState(0);
    useEffect(() => subscribeDiff(() => setTick((t) => t + 1)), []);
    // 关闭意图收栈（见 `DiffViewDeps.onCloseIntent`）：只清栈，**不再发关闭事件**——
    // 发关闭的那一步归壳层，这里再发一次就成环。deps 由工厂闭包持有，挂载期恒定。
    useEffect(() => {
      const subscribe = deps.onCloseIntent;
      if (subscribe === undefined) return;
      return subscribe(() => {
        clearDiff();
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // 主题联动（反馈 3）：Monaco 的 `setTheme` 是全局的（主编辑器与 diff 一起换），
    // 这里订阅同一偏好——overlay 打开期间翻主题同样立刻跟上，创建时也按偏好落初值。
    const themePref = useThemePref();
    useEffect(() => {
      let alive = true;
      void import('../monaco/entry').then((monaco) => {
        if (alive) monaco.editor.setTheme(monacoThemeIdFor(themePref));
      });
      return () => {
        alive = false;
      };
    }, [themePref]);
    const panes: readonly DiffPane[] = getDiffPanes();
    const active: DiffPane | null = panes.length === 0 ? null : panes[panes.length - 1]!;

    /** 每格两侧的读取快照，按格子 key 隔离 */
    const [sidesByKey, setSidesByKey] = useState<Record<string, PaneSides>>({});
    /** PS-5 体量闸：作者**逐格明示**"就是要对比这一对大的"（按格子 key 记，不全局放行） */
    const [forcedKeys, setForcedKeys] = useState<Record<string, boolean>>({});
    /** 并排 / 内联（只影响布局；`renderSideBySide` 由菜单与创建时共用同一个偏好） */
    const [sideBySide, setSideBySide] = useState(true);
    /** 布局偏好的即时值（建编辑器时读它，避免把 sideBySide 塞进创建 effect 的依赖里重建编辑器） */
    const sideBySideRef = useRef(true);
    /** 复制一类的轻反馈（成败都上屏） */
    const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
    /** 差异编辑器的两只手（上一处/下一处、切换布局）；null = 当前没有画出差异 */
    const diffApiRef = useRef<{
      goToDiff(target: 'next' | 'previous'): void;
      updateOptions(options: { renderSideBySide: boolean }): void;
    } | null>(null);
    /** 右键菜单的即时投影（每次渲染重写：三个早退分支写 null = 这一面不表态） */
    const menuSnapshotRef = useRef<DiffViewMenuInput | null>(null);
    const menuRunRef = useRef<(id: string) => void>(() => undefined);

    const copyToClipboard = (text: string, doneNote: string): void => {
      const clip = clipboardApi();
      if (clip === null) {
        setNotice({ tone: 'err', text: '复制失败：当前环境没有可用的剪贴板' });
        return;
      }
      void clip.writeText(text).then(
        () => setNotice({ tone: 'ok', text: doneNote }),
        () => setNotice({ tone: 'err', text: '复制失败：剪贴板拒绝了这次写入' }),
      );
    };

    /** 并排/内联切换：只改呈现（`readOnly` 不变，一个字节也不写盘） */
    const applyLayout = (next: boolean): void => {
      sideBySideRef.current = next;
      setSideBySide(next);
      diffApiRef.current?.updateOptions({ renderSideBySide: next });
    };

    /**
     * 右键菜单的动作桥（每次渲染后刷新）。菜单只接既有能力：复制、Monaco 差异编辑器
     * 自己的 `goToDiff` / `updateOptions`、比对栈既有的关闭出口。
     */
    useEffect(() => {
      const entry: DiffViewFaceBridge = {
        clipboardAvailable: clipboardApi() !== null,
        snapshot: () => menuSnapshotRef.current,
        run: (id) => menuRunRef.current(id),
      };
      faceBridge = entry;
      return () => {
        if (faceBridge === entry) faceBridge = null;
      };
    });
    /** 已发起过读取的格子（StrictMode 二次执行也不重复读盘） */
    const requestedRef = useRef<Set<string>>(new Set());
    const containerRef = useRef<HTMLDivElement | null>(null);

    const activeKey = active?.key ?? null;
    const activeRequest: DiffRequest | null =
      active !== null && active.state.kind === 'request' ? active.state.request : null;
    const sides = activeKey === null ? null : (sidesByKey[activeKey] ?? null);
    const original = sides?.original ?? loadingSides.original;
    const modified = sides?.modified ?? loadingSides.modified;

    /* PS-5 体量闸的读数：两侧**都就位**才算（读盘这一步本身必要，拦在拦得住的那一拍）。
       行数用 countLines 逐字符数换行符，不 split——两份 2 MB 正文各 split 一次就是
       两次整篇数组分配，白付。 */
    const bothOk = original.kind === 'ok' && modified.kind === 'ok';
    const gateUnits = bothOk ? original.text.length + modified.text.length : 0;
    const gateLines = bothOk ? countLines(original.text) + countLines(modified.text) : 0;
    const forced = activeKey === null ? false : forcedKeys[activeKey] === true;
    const gated = bothOk && !forced && diffGatePaused(gateUnits, gateLines);

    // 这一格第一次进视野 ⇒ 两侧并行现读；读回来过就不重复读
    useEffect(() => {
      if (activeKey === null || activeRequest === null) return;
      if (requestedRef.current.has(activeKey)) return;
      requestedRef.current.add(activeKey);
      const key = activeKey;
      setSidesByKey((prev) => ({ ...prev, [key]: loadingSides }));
      void resolveSide(activeRequest.original, deps.io).then((r) => {
        setSidesByKey((prev) => ({ ...prev, [key]: { ...(prev[key] ?? loadingSides), original: r } }));
      });
      void resolveSide(activeRequest.modified, deps.io).then((r) => {
        setSidesByKey((prev) => ({ ...prev, [key]: { ...(prev[key] ?? loadingSides), modified: r } }));
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeKey, activeRequest]);

    // 已被关掉的格子 ⇒ 缓存与"已读取"标记一起丢（不留陈旧读数；重开同一对还会现读）
    useEffect(() => {
      const live = new Set(panes.map((p) => p.key));
      for (const k of [...requestedRef.current]) if (!live.has(k)) requestedRef.current.delete(k);
      setSidesByKey((prev) => {
        let changed = false;
        const next: Record<string, PaneSides> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (live.has(k)) next[k] = v;
          else changed = true;
        }
        return changed ? next : prev;
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [panes.length]);

    // 两侧就位且确有差异才建编辑器；卸载（Esc/关闭/换格）即 dispose 模型与编辑器
    useEffect(() => {
      if (activeKey === null || activeRequest === null) return;
      if (original.kind !== 'ok' || modified.kind !== 'ok') return;
      // PS-5：体量越界 ⇒ 这一拍根本不建（连 model 都不做两次整篇复制）；文案与「仍然对比」在渲染处
      if (gated) return;
      // 行级无差异就不建编辑器（与横幅同一条判等核：行态从 compareContent 派生）
      if (diffEqualityOf(original, modified).linesEqual === true) return; // 无差异：横幅已讲清
      const host = containerRef.current;
      if (!host) return;
      let disposed = false;
      let editor: { dispose(): void } | null = null;
      const textA = original.text;
      const textB = modified.text;
      void (async () => {
        const monaco = await import('../monaco/entry');
        if (disposed || !containerRef.current) return;
        // 外观与主编辑器同源（留白 / 缩略图 / 粘性滚动 / 当前行高亮）：按**两侧较大那本**
        // 的行数取档位表，动态装载、取不到就维持改前的字面基线（见 overlay-editor-appearance）
        const appearance = await overlayEditorAppearance(Math.max(countLines(textA), countLines(textB)));
        if (disposed || !containerRef.current) return;
        const langA = languageIdForSide(activeRequest.original);
        const langB = languageIdForSide(activeRequest.modified);
        const modelA = monaco.editor.createModel(textA, langA);
        const modelB = monaco.editor.createModel(textB, langB);
        const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
          theme: monacoThemeIdFor(loadThemePref()),
          readOnly: true,
          originalEditable: false,
          // 布局偏好由菜单切换；新开一格沿用当前偏好（同一个 ref，不进创建依赖）
          renderSideBySide: sideBySideRef.current,
          renderOverviewRuler: true,
          // eraTW 缩进有语义（tab 层级），空白差异必须如实可见
          ignoreTrimWhitespace: false,
          diffAlgorithm: 'advanced',
          renderIndicators: true,
          automaticLayout: true,
          // PS-5：把 vendor 那两道太晚的刹车收到与体量闸同一量级（缺省 5,000ms / 50 MB）。
          // 3s 是"窗口还能点动"的上限；20 MB 换算成"最大真实文件的 ~8 倍"，
          // 越过它的对比由 monaco 自己说话（它有可见提示），不靠我们猜。
          maxComputationTime: 3000,
          maxFileSize: 20,
          // 大对比才折叠未改动段（阈值以上才开；小对比的行为与改前逐字一致）
          hideUnchangedRegions: { enabled: gateLines >= DIFF_COLLAPSE_MIN_LINES },
          // 编程字体：与主编辑器同一份真源（createDiffEditor 也吃 IEditorOptions 这些键）
          ...CODE_FONT_BASELINE,
          // 外观档：与主编辑器同一张档位表（`wordWrap` 刻意不并——并排 diff 与折行互斥）
          ...appearance,
        });
        diffEditor.setModel({ original: modelA, modified: modelB });
        // 只把两只手交出去（上一处/下一处差异、并排/内联切换）：编辑器本身仍归本 effect 管
        const api = {
          goToDiff: (target: 'next' | 'previous'): void => diffEditor.goToDiff(target),
          updateOptions: (options: { renderSideBySide: boolean }): void => diffEditor.updateOptions(options),
        };
        diffApiRef.current = api;
        editor = {
          dispose: () => {
            if (diffApiRef.current === api) diffApiRef.current = null;
            diffEditor.dispose();
            modelA.dispose();
            modelB.dispose();
          },
        };
      })();
      return () => {
        disposed = true;
        editor?.dispose();
        diffApiRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeKey, original, modified, gated, gateLines]);

    if (active === null) {
      // 这一屏没有可比对的对象：面不表态（右键落到兜底菜单），别拿上一次的旧投影糊弄
      menuSnapshotRef.current = null;
      menuRunRef.current = () => undefined;
      // 空态也带标题栏与 ✕：改前这一格只有一句「没有要对比的内容」，**一个关闭控件都没有**，
      // 只能靠 Esc——而 Esc 又不走清栈那条通道（见 `onCloseIntent`）。
      return overlayFrame({
        hostClass: 'kd-host',
        title: '比对',
        tier: 'xl',
        fill: true,
        onClose: () => dismissAll(deps),
        closeHint: '收掉比对窗（比对栈一并清空）',
        contextSurface: DIFF_VIEW_SURFACE_ID,
        children: h('p', { className: 'dim' }, '没有要对比的内容。'),
      });
    }

    // 多开：栈里超过一本才出标签条；点标签切过去，点 × 只关那一本
    const tabs: ReactNode[] =
      panes.length > 1
        ? [
            h(
              'div',
              { key: 'tabs', className: 'kd-tabs' },
              ...panes.map((p) =>
                h(
                  'span',
                  {
                    key: p.key,
                    className: `kd-tab${p.key === active.key ? ' active' : ''}`,
                    title: p.state.kind === 'request' ? p.state.request.title : '无法对比',
                    onClick: () => focusDiffPane(p.key),
                  },
                  p.state.kind === 'request' ? p.state.request.title : '（无法对比）',
                  h(
                    'button',
                    {
                      className: 'ghost small kd-tab-close',
                      'aria-label': '关闭这组比对',
                      onClick: (e: { stopPropagation(): void }) => {
                        e.stopPropagation();
                        if (closeDiffPane(p.key)) deps.close();
                      },
                    },
                    '×',
                  ),
                ),
              ),
            ),
          ]
        : [];

    if (active.state.kind === 'rejected') {
      menuSnapshotRef.current = null;
      menuRunRef.current = () => undefined;
      return overlayFrame({
        hostClass: 'kd-host',
        title: '无法打开对比',
        tier: 'xl',
        onClose: () => dismissAll(deps),
        closeHint: '收掉比对窗（比对栈一并清空）',
        contextSurface: DIFF_VIEW_SURFACE_ID,
        children: [...tabs, h('p', { key: 'err', className: 'kd-error' }, active.state.reason)],
        footer: h('button', { className: 'ghost small', onClick: () => dismissAll(deps) }, '关闭'),
      });
    }

    const { request } = active.state;
    // 判等只认一条核：字节态 + 行态同源派生（W17；宿主不再各写 if 链）
    const banner =
      original.kind === 'ok' && modified.kind === 'ok'
        ? diffEqualityBanner(diffEqualityOf(original, modified))
        : null;
    const identical = banner?.noLineDiff === true;
    const errLine: ReactNode[] = [];
    if (original.kind === 'error') errLine.push(h('p', { key: 'a', className: 'kd-error' }, original.message));
    if (modified.kind === 'error') errLine.push(h('p', { key: 'b', className: 'kd-error' }, modified.message));

    /* ------------------------------ 右键菜单投影 ------------------------------ */

    const pathOf = (side: { path?: string }): string | null =>
      typeof side.path === 'string' && side.path.length > 0 ? side.path : null;
    const leftPath = pathOf(request.original);
    const rightPath = pathOf(request.modified);

    menuSnapshotRef.current = {
      title: request.title,
      leftLabel: request.original.label,
      rightLabel: request.modified.label,
      leftPath,
      rightPath,
      // 差异编辑器已建才有「上一处 / 下一处」与布局切换（体量闸拦下 / 无差异时它不在）
      editorReady: diffApiRef.current !== null,
      sideBySide,
      paneCount: panes.length,
      bannerMessage: banner === null ? null : banner.message,
      clipboardAvailable: clipboardApi() !== null,
    };
    menuRunRef.current = (id) => {
      switch (id) {
        case DIFF_VIEW_MENU_IDS.copySummary: {
          const snapshot = menuSnapshotRef.current;
          if (snapshot !== null) copyToClipboard(diffSummaryText(snapshot), '已复制对比摘要');
          return;
        }
        case DIFF_VIEW_MENU_IDS.copyLeftPath:
          if (leftPath !== null) copyToClipboard(leftPath, '已复制左侧路径');
          return;
        case DIFF_VIEW_MENU_IDS.copyRightPath:
          if (rightPath !== null) copyToClipboard(rightPath, '已复制右侧路径');
          return;
        case DIFF_VIEW_MENU_IDS.prevDiff:
          diffApiRef.current?.goToDiff('previous');
          return;
        case DIFF_VIEW_MENU_IDS.nextDiff:
          diffApiRef.current?.goToDiff('next');
          return;
        case DIFF_VIEW_MENU_IDS.toggleLayout:
          // 只翻呈现（readOnly 不变）：并排 ⇄ 内联
          applyLayout(!sideBySideRef.current);
          return;
        case DIFF_VIEW_MENU_IDS.closePane:
          if (closeDiffPane(active.key)) deps.close();
          return;
        default:
          return;
      }
    };

    return overlayFrame({
      hostClass: 'kd-host',
      title: request.title,
      tier: 'xl',
      fill: true,
      // ✕ = 收整扇窗（清栈），页脚那颗 = 只关这一本（栈里还有就回上一本）——分工写在 title 里
      onClose: () => dismissAll(deps),
      closeHint: '收掉比对窗（比对栈一并清空）',
      contextSurface: DIFF_VIEW_SURFACE_ID,
      children: [
        ...tabs,
        h(
          'div',
          { key: 'labels', className: 'kd-labels' },
          h('span', { className: 'kd-label' }, request.original.label),
          h('span', { className: 'kd-label-arrow' }, '⇄'),
          h('span', { className: 'kd-label' }, request.modified.label),
        ),
        banner !== null ? h('p', { key: 'banner', className: 'kd-banner ok' }, banner.message) : null,
        // 复制一类的轻反馈（菜单与按钮共用同一份 notice；有才画，没有这一行也不占位）
        notice === null
          ? null
          : h('p', { key: 'feedback', className: notice.tone === 'ok' ? 'kd-banner ok' : 'kd-error' }, notice.text),
        // 装载态有脸可读：转圈 + 一句话 + 一口井的骨架（改前只有一句裸 `.dim`，读作"这里什么都没有"）
        !bothOk && errLine.length === 0
          ? h('div', { key: 'loading' }, overlaySpinner('正在读取两侧内容…'), overlaySkeletonWell())
          : null,
        errLine,
        // PS-5 体量闸：拦下了就把"拦了什么、代价多大、要不要照样办"一次讲完（不许静默）
        gated
          ? h(
              'div',
              { key: 'gate', className: 'kd-gate' },
              h(
                'p',
                { className: 'kd-banner' },
                `这两份内容合计约 ${formatCharCount(gateUnits)}字 / ${gateLines.toLocaleString('zh-CN')} 行，` +
                  '一次性对比会把界面卡住好几秒，所以先停下来没有自动开始。',
              ),
              h(
                'div',
                { className: 'wizard-actions' },
                h(
                  'button',
                  {
                    className: 'ghost small',
                    onClick: () => {
                      if (activeKey !== null) setForcedKeys((prev) => ({ ...prev, [activeKey]: true }));
                    },
                  },
                  '仍然对比（可能会卡几秒）',
                ),
              ),
            )
          : null,
        bothOk && !identical && !gated ? h('div', { key: 'editor', ref: containerRef, className: 'kd-editor' }) : null,
      ],
      footer: h(
        'button',
        {
          className: 'ghost small',
          onClick: () => {
            // 关当前这格：栈里还有别的比对就回到上一本，栈空才收模态
            if (closeDiffPane(active.key)) deps.close();
          },
        },
        panes.length > 1 ? `关闭这组比对（还剩 ${panes.length - 1} 组）` : '关闭',
      ),
    });
  };
}
