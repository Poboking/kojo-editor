/**
 * W4 PANEL-DEDUP：糖面板共享核（`sugar-panels.ts`）单测。
 *
 * 钉死四件事：
 * - 真相三事件控制器：**attach 一次订齐三条、dispose 一次退净三条**（漏一条 =
 *   面板卸载后仍在收广播），退订后重挂不产生双份回调；
 * - 行池复用：控制器**全生命周期只有同一个池实例**（attach/dispose 不重建 ⇒
 *   不会出现"第二份文本源"的口径分裂）；
 * - 渲染窗口纯函数的边界（初窗 / 步长上界 / total 钉死 / 无增长不重渲）；
 * - 触底哨兵核在无 IntersectionObserver 环境退化为空操作（SSR / 测试不炸）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { EventBus, SugarDiagnostic } from '@kojo/plugin-api';
import {
  DIAG_WINDOW,
  DIAG_WINDOW_INITIAL,
  DIAG_WINDOW_STEP,
  MORE_ROW_TITLE,
  ROW_WINDOW,
  attachGrowSentinel,
  buildPanelDiagnosticRows,
  createLiveTextPool,
  createPanelTruthController,
  degradeForActiveFile,
  degradeText,
  growWindow,
  isKojoFile,
  moreRowLabel,
  nextWindow,
  windowSize,
  type PanelDiagnosticRow,
  type PanelTruthHandlers,
} from '../src/index';

/* ============================== 替身总线 ============================== */

type Handler = (payload: never) => void;

/** 记账替身：每个事件的 handler 集合与挂/退次数全可查 */
function makeFakeBus() {
  const listeners = new Map<string, Set<Handler>>();
  const attachCount = new Map<string, number>();
  const releaseCount = new Map<string, number>();
  const bus = {
    on(type: string, handler: Handler): () => void {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(handler);
      attachCount.set(type, (attachCount.get(type) ?? 0) + 1);
      return () => {
        set!.delete(handler);
        releaseCount.set(type, (releaseCount.get(type) ?? 0) + 1);
      };
    },
    emit(type: string, payload: unknown): void {
      for (const h of [...(listeners.get(type) ?? [])]) h(payload as never);
    },
    listenerCount(type: string): number {
      return listeners.get(type)?.size ?? 0;
    },
  };
  const typed = bus as unknown as Pick<EventBus, 'on'> & {
    emit(type: string, payload: unknown): void;
  };
  return { typed, attachCount, releaseCount };
}

const count = (m: Map<string, number>, k: string): number => m.get(k) ?? 0;

/**
 * 带 `onSticky` 的替身总线：语义对齐契约——只对白名单事件（此处仅
 * `editor.activeFileChanged`）保留最后一条，订阅时同步回放恰好一次。
 * 其余事件的 onSticky 等价 on（无回放），与内核 `TypedEventBus` 同口径。
 */
function makeStickyFakeBus() {
  const base = makeFakeBus();
  // 替身内部只按字符串键记账：把契约的泛型 on 收成"开放签名"再转发
  const baseOn = base.typed.on as unknown as (type: string, handler: Handler) => () => void;
  const sticky = new Map<string, unknown>();
  const bus = {
    on: baseOn,
    emit(type: string, payload: unknown): void {
      if (type === 'editor.activeFileChanged') sticky.set(type, payload);
      base.typed.emit(type, payload);
    },
    onSticky(type: string, handler: Handler): () => void {
      const un = baseOn(type, handler);
      if (sticky.has(type)) handler(sticky.get(type) as never);
      return un;
    },
  };
  const typed = bus as unknown as Pick<EventBus, 'on' | 'onSticky'> & {
    emit(type: string, payload: unknown): void;
  };
  return { typed, attachCount: base.attachCount, releaseCount: base.releaseCount };
}

function recordHandlers() {
  const seen: Array<{ kind: string; payload: unknown }> = [];
  const handlers: PanelTruthHandlers = {
    onActiveFile: (filePath) => seen.push({ kind: 'active', payload: filePath }),
    onLiveText: (filePath, text) => seen.push({ kind: 'live', payload: { filePath, text } }),
    onCursorLine: (line) => seen.push({ kind: 'cursor', payload: line }),
  };
  return { seen, handlers };
}

/* ============================== 真相事件生命周期 ============================== */

describe('W4 / createPanelTruthController：三事件订阅生命周期', () => {
  it('attach 一次订齐三条（activeFileChanged / documentChanged / cursorMoved）', () => {
    const { typed, attachCount } = makeFakeBus();
    const c = createPanelTruthController(typed);
    const { handlers } = recordHandlers();
    c.attach(handlers);
    expect(count(attachCount, 'editor.activeFileChanged')).toBe(1);
    expect(count(attachCount, 'editor.documentChanged')).toBe(1);
    expect(count(attachCount, 'editor.cursorMoved')).toBe(1);
  });

  it('dispose 一次退净三条；退订后广播不再进面板回调', () => {
    const { typed, releaseCount } = makeFakeBus();
    const c = createPanelTruthController(typed);
    const { seen, handlers } = recordHandlers();
    const dispose = c.attach(handlers);
    dispose();
    expect(count(releaseCount, 'editor.activeFileChanged')).toBe(1);
    expect(count(releaseCount, 'editor.documentChanged')).toBe(1);
    expect(count(releaseCount, 'editor.cursorMoved')).toBe(1);
    typed.emit('editor.activeFileChanged', { filePath: '/p/a.kojo' });
    typed.emit('editor.documentChanged', { filePath: '/p/a.kojo', text: 't', dirty: true });
    typed.emit('editor.cursorMoved', { filePath: '/p/a.kojo', line: 3, column: 1, derivedView: false });
    expect(seen).toEqual([]);
  });

  it('命中裁决住核内：广播只喂当前文件的 onLiveText；池照收全部文件', () => {
    const { typed } = makeFakeBus();
    const c = createPanelTruthController(typed);
    const { seen, handlers } = recordHandlers();
    c.attach(handlers);
    typed.emit('editor.activeFileChanged', { filePath: 'C:\\proj\\a.kojo' });
    typed.emit('editor.documentChanged', { filePath: 'C:\\proj\\other.kojo', text: 'o', dirty: true });
    typed.emit('editor.documentChanged', { filePath: 'c:/PROJ/A.KOJO', text: 'hit', dirty: true });
    expect(seen.filter((e) => e.kind === 'live')).toEqual([
      { kind: 'live', payload: { filePath: 'c:/PROJ/A.KOJO', text: 'hit' } },
    ]);
    // 不命中的那份也进了池（切回旧文件时真相还在）——且 pathKey 归一后大小写/分隔符不敏感
    expect(c.pool.textFor('c:/proj/OTHER.kojo')).toBe('o');
    expect(c.pool.textFor('C:\\proj\\a.kojo')).toBe('hit');
  });

  it('光标裁决住核内：派生视图 / 别的文件 / 无当前文件 → 一律 null（清高亮）', () => {
    const { typed } = makeFakeBus();
    const c = createPanelTruthController(typed);
    const { seen, handlers } = recordHandlers();
    c.attach(handlers);
    typed.emit('editor.cursorMoved', { filePath: 'C:\\proj\\a.kojo', line: 9, column: 1, derivedView: false });
    typed.emit('editor.activeFileChanged', { filePath: 'C:\\proj\\a.kojo' });
    typed.emit('editor.cursorMoved', { filePath: 'C:\\proj\\a.kojo', line: 4, column: 2, derivedView: true });
    typed.emit('editor.cursorMoved', { filePath: 'C:\\proj\\b.kojo', line: 5, column: 1, derivedView: false });
    typed.emit('editor.cursorMoved', { filePath: null, line: 6, column: 1, derivedView: false });
    typed.emit('editor.cursorMoved', { filePath: 'c:/PROJ/A.KOJO', line: 7, column: 1, derivedView: false });
    expect(seen.filter((e) => e.kind === 'cursor').map((e) => e.payload)).toEqual([null, null, null, null, 7]);
  });

  it('行池复用不产生第二份文本源：dispose 后重挂仍是同一个池、每事件恰好一份回调', () => {
    const { typed, attachCount } = makeFakeBus();
    const c = createPanelTruthController(typed);
    const first = c.pool;
    const { handlers } = recordHandlers();
    const dispose = c.attach(handlers);
    typed.emit('editor.activeFileChanged', { filePath: '/p/a.kojo' });
    typed.emit('editor.documentChanged', { filePath: '/p/a.kojo', text: 'v1', dirty: true });
    dispose();
    expect(c.pool).toBe(first); // 池实例不随 attach/dispose 重建
    const { seen, handlers: again } = recordHandlers();
    c.attach(again);
    typed.emit('editor.documentChanged', { filePath: '/p/a.kojo', text: 'v2', dirty: true });
    // 恰好一份：没有"上一世的 listener"残留双播
    expect(seen.filter((e) => e.kind === 'live')).toHaveLength(1);
    expect(count(attachCount, 'editor.documentChanged')).toBe(2);
    expect(first.textFor('/p/a.kojo')).toBe('v2'); // 两份 attach 写的是同一池
  });

  it('两个控制器各持各的池（面板实例之间不共享可变状态）', () => {
    const { typed } = makeFakeBus();
    const a = createPanelTruthController(typed);
    const b = createPanelTruthController(typed);
    a.pool.apply('/p/x.kojo', 'A');
    expect(b.pool.textFor('/p/x.kojo')).toBeNull();
  });
});

/* ============================== sticky 回放（面板挂载晚于文件打开） ============================== */

describe('W4 / createPanelTruthController：当前文件走 sticky 回放', () => {
  it('先广播后挂载：attach 当场补发当前文件（同步、恰好一条）', () => {
    const { typed } = makeStickyFakeBus();
    const c = createPanelTruthController(typed);
    typed.emit('editor.activeFileChanged', { filePath: '/p/a.kojo' }); // 此时面板还没挂
    const { seen, handlers } = recordHandlers();
    c.attach(handlers);
    expect(seen).toEqual([{ kind: 'active', payload: '/p/a.kojo' }]); // 首帧即知真相
  });

  it('回放初始化的是 currentFile 本体：不再补播 activeFile，当前文件的真相也进 onLiveText', () => {
    const { typed } = makeStickyFakeBus();
    const c = createPanelTruthController(typed);
    typed.emit('editor.activeFileChanged', { filePath: 'C:\\proj\\A.kojo' });
    const { seen, handlers } = recordHandlers();
    c.attach(handlers);
    seen.length = 0;
    typed.emit('editor.documentChanged', { filePath: 'c:/proj/a.KOJO', text: 'hit', dirty: true });
    expect(seen).toEqual([{ kind: 'live', payload: { filePath: 'c:/proj/a.KOJO', text: 'hit' } }]);
  });

  it('后续广播照常更新（回放不替代订阅）；最后一条是 null 就回放 null（降级文案口径不变）', () => {
    const { typed } = makeStickyFakeBus();
    typed.emit('editor.activeFileChanged', { filePath: '/p/a.kojo' });
    typed.emit('editor.activeFileChanged', { filePath: null }); // 关项目 / 回到欢迎页
    const c = createPanelTruthController(typed);
    const { seen, handlers } = recordHandlers();
    c.attach(handlers);
    expect(seen).toEqual([{ kind: 'active', payload: null }]);
    typed.emit('editor.activeFileChanged', { filePath: '/p/b.ERB' });
    expect(seen).toEqual([
      { kind: 'active', payload: null },
      { kind: 'active', payload: '/p/b.ERB' },
    ]);
  });

  it('dispose 后不再回调（回放只发生在 attach 那一刻）；退订仍覆盖 activeFile 一条', () => {
    const { typed, releaseCount } = makeStickyFakeBus();
    typed.emit('editor.activeFileChanged', { filePath: '/p/a.kojo' });
    const c = createPanelTruthController(typed);
    const { seen, handlers } = recordHandlers();
    const dispose = c.attach(handlers);
    expect(seen).toHaveLength(1);
    dispose();
    expect(count(releaseCount, 'editor.activeFileChanged')).toBe(1);
    typed.emit('editor.activeFileChanged', { filePath: '/p/b.kojo' });
    expect(seen).toHaveLength(1);
  });

  it('没有 onSticky 的旧总线不崩、不回放——行为与引入前逐字一致', () => {
    const { typed } = makeFakeBus(); // 只有 on / emit
    typed.emit('editor.activeFileChanged', { filePath: '/p/a.kojo' });
    const c = createPanelTruthController(typed);
    const { seen, handlers } = recordHandlers();
    expect(() => c.attach(handlers)).not.toThrow();
    expect(seen).toEqual([]); // 无回放（旧口径：错过就是错过）
    typed.emit('editor.activeFileChanged', { filePath: '/p/b.kojo' });
    expect(seen).toEqual([{ kind: 'active', payload: '/p/b.kojo' }]);
  });
});

/* ============================== 行池本体 ============================== */

describe('W4 / createLiveTextPool', () => {
  it('覆盖旧值 / pathKey 归一判等 / 空文本也是真相 / 空路径取 null', () => {
    const pool = createLiveTextPool();
    expect(pool.textFor(null)).toBeNull();
    expect(pool.textFor(undefined)).toBeNull();
    pool.apply('C:\\Proj\\X.kojo', 'v1');
    pool.apply('c:/proj/x.kojo', 'v2');
    expect(pool.textFor('/proj/x.kojo')).toBeNull();
    expect(pool.textFor('C:/PROJ/X.KOJO')).toBe('v2');
    pool.apply('/proj/x.kojo', '');
    expect(pool.textFor('/proj/x.kojo')).toBe('');
  });
});

/* ============================== 诊断行成形（唯一口径） ============================== */

const diag = (
  code: string,
  severity: 'error' | 'warning' | 'info',
  line: number | null,
  column: number | null,
): SugarDiagnostic =>
  ({
    code: code as SugarDiagnostic['code'],
    severity,
    message: `m-${code}`,
    loc: line === null ? null : { line, column: column ?? 1 },
  }) as SugarDiagnostic;

describe('W4 / buildPanelDiagnosticRows（两面板同键同序的唯一真源）', () => {
  it('乱序输入 → 有位置的在前、(行,列) 升序、文件级殿后、同位置保序', () => {
    const rows: PanelDiagnosticRow[] = buildPanelDiagnosticRows([
      diag('file-a', 'info', null, null),
      diag('L5', 'warning', 5, 3),
      diag('L2b', 'info', 2, 9),
      diag('L2a', 'error', 2, 1),
      diag('L2c', 'info', 2, 9),
      diag('file-b', 'warning', null, null),
    ]);
    expect(rows.map((r) => r.code)).toEqual(['L2a', 'L2b', 'L2c', 'L5', 'file-a', 'file-b']);
  });

  it('key = code|行|列|原始序号（同码同位不互顶）；undefined / 空 → 空表', () => {
    const rows = buildPanelDiagnosticRows([diag('x', 'info', 1, 1), diag('x', 'info', 1, 1)]);
    expect(rows[0]!.key).toBe('x|1|1|0');
    expect(rows[1]!.key).toBe('x|1|1|1');
    expect(buildPanelDiagnosticRows(undefined)).toEqual([]);
    expect(buildPanelDiagnosticRows([])).toEqual([]);
  });
});

/* ============================== 渲染窗口边界 ============================== */

describe('W4 / 渲染窗口纯函数（初窗 / 步长 / 终值 / 不重渲）', () => {
  it('windowSize：limit 缺省走 initial；被 total 钉住；limit 超 total 也钉住', () => {
    expect(windowSize(10_000, undefined, DIAG_WINDOW)).toBe(DIAG_WINDOW_INITIAL);
    expect(windowSize(5, undefined, DIAG_WINDOW)).toBe(5);
    expect(windowSize(100, 999, DIAG_WINDOW)).toBe(100);
    expect(windowSize(10_000, 120, DIAG_WINDOW)).toBe(120);
  });

  it('nextWindow：首步 initial+step；单调不减；步长有界；终值钉在 total 后不再增长', () => {
    expect(nextWindow(undefined, 10_000, DIAG_WINDOW)).toBe(DIAG_WINDOW_INITIAL + DIAG_WINDOW_STEP);
    let cur: number | undefined = undefined;
    let prev: number | undefined = undefined;
    for (let i = 0; i < 500 && cur !== 10_000; i++) {
      cur = nextWindow(cur, 10_000, DIAG_WINDOW);
      if (prev !== undefined) {
        expect(cur).toBeGreaterThanOrEqual(prev);
        expect(cur - prev).toBeLessThanOrEqual(DIAG_WINDOW_STEP);
      }
      prev = cur;
    }
    expect(cur).toBe(10_000);
    expect(nextWindow(cur, 10_000, DIAG_WINDOW)).toBe(10_000);
    // 末步不足 STEP 也要恰好落在 total（不许越过）
    expect(nextWindow(9_990, 10_000, DIAG_WINDOW)).toBe(10_000);
  });

  it('growWindow：无增长时原样返回 current（含 undefined）⇒ 宿主 setState 跳过重渲', () => {
    expect(growWindow(undefined, DIAG_WINDOW_INITIAL, DIAG_WINDOW)).toBeUndefined();
    expect(growWindow(80, 80, DIAG_WINDOW)).toBe(80);
    expect(growWindow(undefined, 5, DIAG_WINDOW)).toBe(5); // 小表一步到底（哨兵随之消失）
    expect(growWindow(undefined, 10_000, DIAG_WINDOW)).toBe(DIAG_WINDOW_INITIAL + DIAG_WINDOW_STEP);
    expect(growWindow(undefined, 10_000, ROW_WINDOW)).toBe(ROW_WINDOW.initial + ROW_WINDOW.step);
  });

  it('诊断窗口两面板同值：契约层 80/160 是唯一来源（旧 60/120 分叉已除）', () => {
    expect(DIAG_WINDOW).toEqual({ initial: DIAG_WINDOW_INITIAL, step: DIAG_WINDOW_STEP });
    expect(DIAG_WINDOW.initial).toBe(80);
    expect(DIAG_WINDOW.step).toBe(160);
  });
});

/* ============================== 触底哨兵核 ============================== */

const originalIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;

afterEach(() => {
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = originalIO;
});

describe('W4 / attachGrowSentinel', () => {
  it('无 IntersectionObserver（node / SSR）→ 返回空退订、不抛（退化纯点击）', () => {
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    const off = attachGrowSentinel({}, () => {
      throw new Error('不该被调用');
    });
    expect(() => off()).not.toThrow();
    // 节点缺失同样空操作
    const off2 = attachGrowSentinel(null, () => {});
    expect(() => off2()).not.toThrow();
  });

  it('有观察器：isIntersecting 命中即回调；退订即 disconnect', () => {
    let disconnected = 0;
    let cb: ((entries: ReadonlyArray<{ isIntersecting: boolean }>) => void) | null = null;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
      constructor(fn: (entries: ReadonlyArray<{ isIntersecting: boolean }>) => void) {
        cb = fn;
      }
      observe(): void {}
      disconnect(): void {
        disconnected++;
      }
    };
    let grown = 0;
    const off = attachGrowSentinel({ node: true }, () => grown++);
    cb!.call(null, [{ isIntersecting: false }]);
    expect(grown).toBe(0);
    cb!.call(null, [{ isIntersecting: true }]);
    expect(grown).toBe(1);
    off();
    expect(disconnected).toBe(1);
  });
});

/* ============================== 哨兵文案 / 降级判据 ============================== */

describe('W4 / 哨兵文案与活动文件降级判据', () => {
  it('moreRowLabel / title 单一真源', () => {
    expect(moreRowLabel(7)).toBe('显示更多（还剩 7）');
    expect(MORE_ROW_TITLE).toContain('自动加载');
  });

  it('degradeForActiveFile：null → no-project；非 .kojo1 → not-kojo；.kojo1 → reading', () => {
    expect(degradeForActiveFile(null)).toBe('no-project');
    expect(degradeForActiveFile('/p/a.ERB')).toBe('not-kojo');
    // `.kojo` 是 2.0 的源（LAU-3b-FLIP），封存层的糖面板不再接管它
    expect(degradeForActiveFile('/p/a.kojo')).toBe('not-kojo');
    expect(degradeForActiveFile('/p/a.KOJO1')).toBe('reading');
  });

  it('降级闭集每个键都有非空中文文案（同屏两面板共用一份 map）', () => {
    for (const d of ['no-project', 'no-file', 'not-kojo', 'reading', 'previewing', 'read-error', 'preview-error'] as const) {
      expect(degradeText(d).length).toBeGreaterThan(0);
      expect(degradeText(d)).toMatch(/[\u4e00-\u9fa5]/);
    }
  });

  it('isKojoFile：大小写不敏感；空串 / 非 .kojo1 / null / undefined → false', () => {
    expect(isKojoFile('/p/x.kojo1')).toBe(true);
    expect(isKojoFile('/p/x.KOJO1')).toBe(true);
    expect(isKojoFile('/p/x.kojo')).toBe(false); // 2.0 的源不归封存层面板
    expect(isKojoFile('/p/x.kojo2')).toBe(false);
    expect(isKojoFile('/p/x.ERB')).toBe(false);
    expect(isKojoFile('')).toBe(false);
    expect(isKojoFile(null)).toBe(false);
    expect(isKojoFile(undefined)).toBe(false);
  });
});
