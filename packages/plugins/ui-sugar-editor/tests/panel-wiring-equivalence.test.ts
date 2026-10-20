/**
 * W4 PANEL-DEDUP 收尾：糖判定面板（`src/index.ts`）接进唯一共享核的**等价性自证**。
 *
 * 钉两件"回退就会红"的事（测试文件，解耦审计 C 项豁免 ⇒ 可相对导入 preview 的
 * 生产码——两侧生产代码仍只经 `@kojo/plugin-api` 相见）：
 *
 * 1. **同一份诊断输入**下，editor 面板（`VerdictDiagList`）与 preview 面板
 *    （`DiagSection`）渲染出的行**集合、顺序、窗口边界逐字段一致**——比较走
 *    真实渲染产物（key/严重度/位置/消息/剩余数），不是模块引用互指，杜绝恒真；
 *    输入特意用**乱序 + 文件级混排**的诊断，两侧若有一方哪天回退成自带拷贝
 *    （排序或窗口算术），行序/边界立刻分叉。
 * 2. **真相三事件的退订在一次 attach/dispose 内全部覆盖**：用最小 React hooks
 *    替身（`vi.mock('react')`）真挂两面板的 `useEffect`，在记账总线上验证
 *    "挂载即每事件恰好一份、卸载即三个 topic 清零、卸载后广播打不进面板状态"。
 *    这是面板**接线**的行为证据，不是对契约层单测的复读。
 *
 * 附带哨兵壳口径：`sv-more-btn` className 不许漂（app 侧 SSR 测试同钉），
 * title/文案/样式必须逐引用等于共享核导出（`MORE_ROW_TITLE` / `moreRowLabel` /
 * `MORE_ROW_STYLE`）；`attachGrowSentinel` 挂卸恰好一次（observe/disconnect 计数）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SugarDiagnostic } from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import {
  DIAG_WINDOW as API_DIAG_WINDOW,
  MORE_ROW_STYLE as API_MORE_ROW_STYLE,
  MORE_ROW_TITLE as API_MORE_ROW_TITLE,
  attachGrowSentinel as apiAttachGrowSentinel,
  createPanelTruthController as apiCreateTruthController,
  degradeForActiveFile as apiDegradeForActiveFile,
  growWindow as apiGrowWindow,
  moreRowLabel as apiMoreRowLabel,
} from '@kojo/plugin-api';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';
import { createSugarTranspileService } from '@kojo/plugin-kojo-sugar';
import * as editorLogic from '../src/panel-logic';
import { VerdictDiagList, createUiSugarEditorPlugin } from '../src/index';
import { DiagSection, createUiSugarPreviewPlugin } from '../../ui-sugar-preview/src/index';
import * as previewLogic from '../../ui-sugar-preview/src/panel-logic';

/* ============================== react 最小替身（hooks 运行时） ============================== */

/**
 * 只够"渲染一次 + 挂 effect + 卸 effect"的 shim：状态槽按组件实例隔离，
 * `sigOf` 给出该实例全部状态的签名（不暴露槽序，断言只比"变没变"）。
 * createElement 顺手调用函数 ref——模拟 React 的 commit-refs-then-effects 次序，
 * 让 MoreRow 的 `attachGrowSentinel(anchor.current, …)` 拿到非空节点。
 */
const rt = vi.hoisted(() => {
  type Comp = { slots: unknown[]; i: number };
  const state = {
    comps: [] as Comp[],
    effects: [] as Array<() => unknown>,
    cleanups: [] as Array<() => void>,
    current: null as Comp | null,
  };
  const react = {
    createElement: (
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ): Record<string, unknown> => {
      const p: Record<string, unknown> = { ...(props ?? {}) };
      if (children.length > 0) p.children = children.length === 1 ? children[0] : children;
      if (typeof p.ref === 'function') (p.ref as (node: unknown) => void)({ __node: true });
      return { type, props: p };
    },
    useState: (init: unknown): [unknown, (v: unknown) => void] => {
      const c = state.current as Comp;
      if (c.i >= c.slots.length) c.slots.push(init);
      const idx = c.i++;
      const set = (v: unknown): void => {
        c.slots[idx] = typeof v === 'function' ? (v as (prev: unknown) => unknown)(c.slots[idx]) : v;
      };
      return [c.slots[idx], set];
    },
    useRef: (init: unknown): { current: unknown } => {
      const c = state.current as Comp;
      if (c.i >= c.slots.length) c.slots.push({ current: init });
      return c.slots[c.i++] as { current: unknown };
    },
    useEffect: (fn: () => unknown): void => {
      state.effects.push(fn);
    },
    useCallback: <F>(fn: F): F => fn,
    useMemo: <T>(fn: () => T): T => fn(),
  };
  return {
    react,
    reset(): void {
      state.comps = [];
      state.effects = [];
      state.cleanups = [];
      state.current = null;
    },
    begin(): void {
      state.current = { slots: [], i: 0 };
      state.comps.push(state.current);
    },
    flush(): void {
      const q = state.effects.splice(0);
      for (const f of q) {
        const c = f();
        if (typeof c === 'function') state.cleanups.push(c as () => void);
      }
    },
    unmount(): void {
      for (const c of state.cleanups.splice(0)) c();
    },
    sigOf(idx: number): string {
      return state.comps[idx]!.slots
        .map((v) =>
          v && typeof v === 'object' ? (Array.isArray(v) ? `arr(${v.length})` : 'obj') : String(v),
        )
        .join('|');
    },
  };
});

vi.mock('react', () => rt.react);

/* ============================== 记账总线与面板激活替身 ============================== */

type Handler = (payload: never) => void;

function makeBus() {
  const listeners = new Map<string, Set<Handler>>();
  return {
    on(type: string, handler: Handler): () => void {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(handler);
      return () => set!.delete(handler);
    },
    emit(type: string, payload: unknown): void {
      for (const h of [...(listeners.get(type) ?? [])]) h(payload as never);
    },
    count(type: string): number {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

const log = { debug() {}, info() {}, warn() {}, error() {} };
const noop = (): void => undefined;

/** 元素树（createElement 替身产物）的最小形状 */
type El = { type: unknown; props: Record<string, unknown> };

function childrenOf(node: unknown): unknown[] {
  const c = (node as El).props.children;
  if (Array.isArray(c)) return c;
  if (c === null || c === undefined || typeof c !== 'object') return [];
  return [c];
}

/** 行抽取：两面板共有的逐字段口径（key / 严重度标签 / 位置文本 / 消息 / 行 title） */
function extractRows(root: unknown, rowClass: RegExp): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const k of childrenOf(root)) {
    if (typeof k !== 'object' || k === null) continue; // 三元渲染的 null 占位（无哨兵）
    const e = k as El;
    if (typeof e.type !== 'string' || typeof e.props.className !== 'string') continue;
    if (!rowClass.test(e.props.className)) continue;
    const spans = childrenOf(e).filter((s) => typeof s === 'object') as El[];
    out.push({
      key: e.props.key,
      severityToken: e.props.className.split(' ')[1],
      sevLabel: (spans[0] as El).props.children,
      loc: (spans[1] as El).props.children,
      msg: (spans[spans.length - 1] as El).props.children,
      title: e.props.title,
    });
  }
  return out;
}

/** 「显示更多」哨兵元素（函数组件 + remaining 计数） */
function extractMore(root: unknown): El | null {
  for (const k of childrenOf(root)) {
    if (typeof k !== 'object' || k === null) continue;
    const e = k as El;
    if (typeof e.type === 'function' && typeof e.props.remaining === 'number') return e;
  }
  return null;
}

/** 激活 ui-sugar-editor 并取回 `ui.panel`（sugar-verdict）的面板组件 */
function bootVerdictPanel(bus: ReturnType<typeof makeBus>): () => unknown {
  const caps: Array<{ slot: string; contribution: Record<string, unknown> }> = [];
  const ctx = {
    pluginId: 'ui-sugar-editor',
    log,
    inject: (key: string): unknown => {
      if (key === WellKnownServices.SugarTranspile)
        return { transpile: () => { throw new Error('本测试不触发转译'); } };
      if (key === KernelServices.IO) return { isWritable: () => false };
      if (key === KernelServices.Project) return { current: () => null };
      if (key === KernelServices.Slots) return { query: () => [] };
      if (key === KernelServices.Workspaces)
        return { rootDir: () => '/appdata/workspaces', list: async () => [], get: async () => null, projectDir: (id: string) => `/appdata/workspaces/${id}` };
      throw new Error(`未注册的服务：${key}`);
    },
    tryInject: () => undefined,
    slots: {
      register: (slot: string, contribution: Record<string, unknown>) => {
        caps.push({ slot, contribution });
        return noop;
      },
    },
    bus,
    onDispose: (fn: unknown) => fn,
  };
  createUiSugarEditorPlugin().activate(ctx as never);
  const panel = caps.find((c) => c.slot === 'ui.panel' && c.contribution.id === 'sugar-verdict');
  if (!panel) throw new Error('sugar-verdict 面板未注册');
  return panel.contribution.component as () => unknown;
}

/** 激活 ui-sugar-preview 并取回 `ui.panel`（sugar-preview）的面板组件 */
function bootPreviewPanel(bus: ReturnType<typeof makeBus>): () => unknown {
  const caps: Array<{ slot: string; contribution: Record<string, unknown> }> = [];
  const ctx = {
    pluginId: 'ui-sugar-preview',
    log,
    inject: (key: string): unknown => {
      if (key === WellKnownServices.SugarPreview) return { preview: async () => null };
      if (key === KernelServices.IO) return { isWritable: () => false };
      throw new Error(`未注册的服务：${key}`); // SnapshotSource 缺席 = 合法软依赖路径
    },
    slots: {
      register: (slot: string, contribution: Record<string, unknown>) => {
        caps.push({ slot, contribution });
        return noop;
      },
    },
    bus,
    onDispose: (fn: unknown) => fn,
  };
  createUiSugarPreviewPlugin().activate(ctx as never);
  const panel = caps.find((c) => c.slot === 'ui.panel' && c.contribution.id === 'sugar-preview');
  if (!panel) throw new Error('sugar-preview 面板未注册');
  return panel.contribution.component as () => unknown;
}

/* ============================== 诊断样本 ============================== */

const transpile = createSugarTranspileService({ faceTable: createEratwFaceTable() });
/** 真实病句源（unknown-identifier + 引号内续接）——乱序的合法来源 */
const REAL_SRC = [
  '角色: 1',
  '时机 指令 310：',
  '    如果 未定义变量甲：',
  '        「呀。」',
  '    「你好。 续」',
  '',
].join('\n');
const realDiags: readonly SugarDiagnostic[] = transpile.transpile(REAL_SRC, {
  filePath: 'C:\\proj\\口上\\x.kojo',
}).diagnostics;

const d = (code: string, line: number | null, column: number | null, severity: 'error' | 'warning' | 'info' = 'warning'): SugarDiagnostic =>
  ({
    code,
    severity,
    message: `m-${code}`,
    loc: line === null ? null : { line, column: column ?? 1 },
  }) as unknown as SugarDiagnostic;

/** 260 条乱行号 + 每 50 条一枚文件级——足以越过 80/160 两档窗口 */
const MANY: SugarDiagnostic[] = [];
for (let i = 0; i < 260; i++) {
  if (i % 50 === 49) MANY.push(d(`file-${i}`, null, null));
  else MANY.push(d(`h-${i}`, ((i * 37) % 260) + 1, (i % 7) + 1));
}

/* ============================== 一、共享核同一实例（引用 ===，反拷贝钉） ============================== */

describe('W4 收尾 / 两面板 panel-logic 必须指向同一份核实现', () => {
  it('真相控制器 / 哨兵 / 窗口参数 / 降级判据：editor、preview、契约层三者引用全等', () => {
    for (const [name, e, p, a] of [
      ['createPanelTruthController', editorLogic.createPanelTruthController, previewLogic.createPanelTruthController, apiCreateTruthController],
      ['attachGrowSentinel', editorLogic.attachGrowSentinel, previewLogic.attachGrowSentinel, apiAttachGrowSentinel],
      ['growWindow', editorLogic.growWindow, previewLogic.growWindow, apiGrowWindow],
      ['moreRowLabel', editorLogic.moreRowLabel, previewLogic.moreRowLabel, apiMoreRowLabel],
      ['degradeForActiveFile', editorLogic.degradeForActiveFile, previewLogic.degradeForActiveFile, apiDegradeForActiveFile],
    ] as const) {
      expect(p, name).toBe(a);
      expect(e, name).toBe(a);
    }
    expect(editorLogic.DIAG_WINDOW).toBe(API_DIAG_WINDOW);
    expect(previewLogic.DIAG_WINDOW).toBe(API_DIAG_WINDOW);
    expect(editorLogic.MORE_ROW_STYLE).toBe(API_MORE_ROW_STYLE);
    expect(previewLogic.MORE_ROW_STYLE).toBe(API_MORE_ROW_STYLE);
    expect(editorLogic.MORE_ROW_TITLE).toBe(API_MORE_ROW_TITLE);
    expect(previewLogic.MORE_ROW_TITLE).toBe(API_MORE_ROW_TITLE);
  });
});

/* ============================== 二、行集合 / 顺序 / 窗口边界（渲染产物级） ============================== */

describe('W4 收尾 / 同一份诊断输入：两面板渲染行集合、顺序、窗口边界逐字段一致', () => {
  it('真实转译诊断（乱序喂入）→ 两面板渲染行 key/严重度/位置/消息/title 全等，且顺序 ≠ 输入顺序', () => {
    const shuffled = [...realDiags].reverse();
    expect(shuffled.length).toBeGreaterThanOrEqual(2);
    const renderE = (src: readonly SugarDiagnostic[]): El =>
      VerdictDiagList({
        rows: editorLogic.buildVerdictRows(src),
        limit: undefined,
        onGrow: noop,
        onReveal: noop,
      }) as unknown as El;
    const renderP = (src: readonly SugarDiagnostic[]): El =>
      DiagSection({
        diags: previewLogic.buildDiagnosticRows(src),
        limit: undefined,
        onGrow: noop,
        onReveal: noop,
      }) as unknown as El;
    const rowsE = extractRows(renderE(shuffled), /^sv-row\b/);
    const rowsP = extractRows(renderP(shuffled), /^pv-diag\b/);
    expect(rowsE.length).toBe(shuffled.length); // 两面板都渲染全量行（无静默丢弃）
    expect(rowsP).toEqual(rowsE); // 渲染产物逐字段相等（不是引用互指）
    const renderedLines = rowsE.map((r) => {
      const m = /^L(\d+)/.exec(String(r.loc));
      return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER; // 文件级 '—' 殿后
    });
    expect(renderedLines).toEqual([...renderedLines].sort((a, b) => a - b)); // canonical 升序
    // 非恒真：真实诊断的上游顺序本就**不**是 canonical 升序——正着喂必须被排成升序
    // （若上游已升序、或排序缺失，下面断言立刻红），且两种喂入序收敛到同一语义正序。
    // key 内嵌**原始序号 i**（React 稳定键），换喂入序 key 必变——故跨排列只比语义字段。
    const stripKey = (rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
      rows.map(({ key: _key, ...rest }) => rest);
    const reRenderE = extractRows(renderE(realDiags), /^sv-row\b/);
    const reRenderP = extractRows(renderP(realDiags), /^pv-diag\b/);
    expect(reRenderE.map((r) => String(r.msg))).not.toEqual(realDiags.map((x) => x.message)); // 归一确已发生
    expect(stripKey(reRenderE)).toEqual(stripKey(rowsE)); // canonical 与喂入顺序无关，两面板同样收敛到它
    expect(stripKey(reRenderP)).toEqual(stripKey(rowsP));
  });

  it('260 条乱序 + 文件级混排：每个窗口档位下渲染行数、行序、剩余数两面板一致', () => {
    const rowsE = editorLogic.buildVerdictRows(MANY);
    const rowsP = previewLogic.buildDiagnosticRows(MANY);
    // 文件级殿后确实发生（否则"排序走了"断言是空话）
    expect(rowsE[rowsE.length - 1]!.line).toBeNull();
    for (const limit of [undefined, 1, 80, 81, 160, 240, 241, 260, 999]) {
      const listE = VerdictDiagList({ rows: rowsE, limit, onGrow: noop, onReveal: noop }) as unknown as El;
      const secP = DiagSection({ diags: rowsP, limit, onGrow: noop, onReveal: noop }) as unknown as El;
      const gotE = extractRows(listE, /^sv-row\b/);
      const gotP = extractRows(secP, /^pv-diag\b/);
      const expected = Math.min(260, limit ?? 80);
      expect(gotE.length, `editor limit=${limit}`).toBe(expected);
      expect(gotP.length, `preview limit=${limit}`).toBe(expected);
      expect(gotP).toEqual(gotE);
      const moreE = extractMore(listE);
      const moreP = extractMore(secP);
      if (expected === 260) {
        expect(moreE).toBeNull();
        expect(moreP).toBeNull();
      } else {
        expect(moreP!.props.remaining).toBe(moreE!.props.remaining);
        expect(moreE!.props.remaining).toBe(260 - expected);
      }
    }
  });

  it('增长序列两面板逐步一致：undefined → 240 → 260（终局哨兵消失）', () => {
    const rowsE = editorLogic.buildVerdictRows(MANY);
    const rowsP = previewLogic.buildDiagnosticRows(MANY);
    let eLim: number | undefined;
    let pLim: number | undefined;
    for (let step = 0; step < 10 && (eLim ?? 0) < 260; step++) {
      eLim = editorLogic.growWindow(eLim, 260, editorLogic.DIAG_WINDOW);
      pLim = previewLogic.growWindow(pLim, 260, previewLogic.DIAG_WINDOW);
      expect(pLim).toBe(eLim); // 两侧窗口算术逐值同步（一份回退成拷贝就此处红）
      const listE = VerdictDiagList({ rows: rowsE, limit: eLim, onGrow: noop, onReveal: noop }) as unknown as El;
      const secP = DiagSection({ diags: rowsP, limit: pLim, onGrow: noop, onReveal: noop }) as unknown as El;
      const gotE = extractRows(listE, /^sv-row\b/);
      expect(extractRows(secP, /^pv-diag\b/)).toEqual(gotE);
      const moreE = extractMore(listE);
      const moreP = extractMore(secP);
      expect(moreP === null ? null : moreP.props.remaining).toBe(moreE === null ? null : moreE.props.remaining);
    }
    expect(eLim).toBe(260);
    expect(pLim).toBe(260);
  });
});

/* ============================== 三、哨兵壳：同源文案 + sv 视觉口径不漂 ============================== */

describe('W4 收尾 / MoreRow 壳', () => {
  const moreOf = (fn: unknown, remaining: number): El => {
    rt.begin();
    const btn = (fn as (props: { remaining: number; onMore: () => void }) => El)({ remaining, onMore: noop });
    rt.flush();
    return btn;
  };

  it('title/样式/文案逐字来自共享核；editor 保持 sv-more-btn、preview 保持 pv-more-btn', () => {
    const listE = VerdictDiagList({
      rows: editorLogic.buildVerdictRows(MANY),
      limit: 80,
      onGrow: noop,
      onReveal: noop,
    }) as unknown as El;
    const secP = DiagSection({
      diags: previewLogic.buildDiagnosticRows(MANY),
      limit: 80,
      onGrow: noop,
      onReveal: noop,
    }) as unknown as El;
    const eMore = extractMore(listE)!;
    const pMore = extractMore(secP)!;
    rt.reset();
    const btnE = moreOf(eMore.type, 7);
    const btnP = moreOf(pMore.type, 7);
    expect(btnE.type).toBe('button');
    expect(btnE.props.className).toBe('ghost small dim sv-more-btn'); // 视觉口径钉死
    expect(btnP.props.className).toBe('ghost small dim pv-more-btn');
    expect(btnE.props.title).toBe(API_MORE_ROW_TITLE);
    expect(btnP.props.title).toBe(API_MORE_ROW_TITLE); // 两壳同一份 title
    expect(btnE.props.style).toBe(API_MORE_ROW_STYLE);
    expect(btnP.props.style).toBe(API_MORE_ROW_STYLE);
    expect(btnE.props.children).toBe(apiMoreRowLabel(7));
    expect(btnP.props.children).toBe('显示更多（还剩 7）');
  });

  const originalIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  afterEach(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = originalIO;
  });

  it('editor 哨兵接线走核：挂载 observe 恰好一次、相交触发增窗、卸载 disconnect 恰好一次', () => {
    let observed = 0;
    let disconnected = 0;
    let cb: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
      constructor(fn: (entries: Array<{ isIntersecting: boolean }>) => void) {
        cb = fn;
      }
      observe(): void {
        observed++;
      }
      disconnect(): void {
        disconnected++;
      }
    };
    const listE = VerdictDiagList({
      rows: editorLogic.buildVerdictRows(MANY),
      limit: 80,
      onGrow: noop,
      onReveal: noop,
    }) as unknown as El;
    const eMore = extractMore(listE)!;
    rt.reset();
    let grown = 0;
    rt.begin();
    (eMore.type as (props: { remaining: number; onMore: () => void }) => unknown)({
      remaining: eMore.props.remaining as number,
      onMore: () => grown++,
    });
    rt.flush();
    expect(observed).toBe(1); // 只挂一份观察器（第二份 IntersectionObserver 拷贝已除）
    cb!([{ isIntersecting: false }]);
    expect(grown).toBe(0);
    cb!([{ isIntersecting: true }]);
    expect(grown).toBe(1);
    rt.unmount();
    expect(disconnected).toBe(1);
  });
});

/* ============================== 四、真相三事件：一次 attach/dispose 全覆盖 ============================== */

const KOJO = 'C:\\proj\\口上\\x.kojo';

describe('W4 收尾 / 面板真相接线（真挂 useEffect，记账总线取证）', () => {
  it('editor 面板：挂载即三条各订一份；一次退订即三条清零；卸载后广播打不进面板状态', () => {
    rt.reset();
    const bus = makeBus();
    const Panel = bootVerdictPanel(bus);
    rt.begin();
    Panel();
    rt.flush();
    expect(bus.count('editor.activeFileChanged')).toBe(1);
    expect(bus.count('editor.documentChanged')).toBe(1);
    expect(bus.count('editor.cursorMoved')).toBe(1);
    // 在挂状态：三条广播都必须改变面板状态（证明"在听"，卸载后的静默才非恒真）
    const sigIdle = rt.sigOf(0);
    bus.emit('editor.activeFileChanged', { filePath: KOJO });
    const sigFile = rt.sigOf(0);
    expect(sigFile).not.toBe(sigIdle); // activeFileChanged 进得来
    bus.emit('editor.documentChanged', { filePath: 'c:/proj/口上/X.KOJO', text: '缓冲真相', dirty: true });
    expect(rt.sigOf(0)).not.toBe(sigFile); // pathKey 归一命中即 tick（C2 liveTick 驱动重算）
    bus.emit('editor.cursorMoved', { filePath: KOJO, line: 5, column: 1, derivedView: false });
    expect(rt.sigOf(0)).not.toBe(sigFile); // cursorMoved 进得来
    rt.unmount();
    expect(bus.count('editor.activeFileChanged')).toBe(0);
    expect(bus.count('editor.documentChanged')).toBe(0);
    expect(bus.count('editor.cursorMoved')).toBe(0);
    const settled = rt.sigOf(0);
    bus.emit('editor.activeFileChanged', { filePath: null });
    bus.emit('editor.documentChanged', { filePath: KOJO, text: '迟到的广播', dirty: true });
    bus.emit('editor.cursorMoved', { filePath: KOJO, line: 9, column: 1, derivedView: false });
    expect(rt.sigOf(0)).toBe(settled); // 一次 dispose 退净三条——残留一条都会改状态
    // 重挂合法：同一面板函数可再次挂载并重新订齐三条
    rt.begin();
    Panel();
    rt.flush();
    expect(bus.count('editor.activeFileChanged')).toBe(1);
    expect(bus.count('editor.documentChanged')).toBe(1);
    expect(bus.count('editor.cursorMoved')).toBe(1);
    rt.unmount();
  });

  it('两面板同挂一份总线：三条真相事件各恰好两份监听；一起卸载清零，插件级订阅不误伤', () => {
    rt.reset();
    const bus = makeBus();
    const EditorPanel = bootVerdictPanel(bus);
    rt.begin();
    EditorPanel();
    rt.flush();
    const PreviewPanel = bootPreviewPanel(bus);
    rt.begin();
    PreviewPanel();
    rt.flush();
    for (const topic of ['editor.activeFileChanged', 'editor.documentChanged', 'editor.cursorMoved']) {
      expect(bus.count(topic), topic).toBe(2);
    }
    expect(bus.count('kojo.snapshotSelected')).toBe(1); // preview 组件级
    expect(bus.count('workspace.projectCreated')).toBe(1); // editor 插件级（不归面板管）
    const sigE = rt.sigOf(0);
    const sigP = rt.sigOf(1);
    rt.unmount();
    for (const topic of ['editor.activeFileChanged', 'editor.documentChanged', 'editor.cursorMoved']) {
      expect(bus.count(topic), `unmount 后 ${topic}`).toBe(0);
    }
    expect(bus.count('kojo.snapshotSelected')).toBe(0);
    expect(bus.count('workspace.projectCreated')).toBe(1); // 插件激活期的订阅**不该**被面板卸载带走
    bus.emit('editor.activeFileChanged', { filePath: KOJO });
    bus.emit('editor.documentChanged', { filePath: KOJO, text: 'x', dirty: true });
    bus.emit('editor.cursorMoved', { filePath: KOJO, line: 2, column: 1, derivedView: false });
    expect(rt.sigOf(0)).toBe(sigE);
    expect(rt.sigOf(1)).toBe(sigP);
  });
});
