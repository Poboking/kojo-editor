/**
 * PS-6 ②③⑦：拖拽不再逐帧掀壳、光标移动不再往上抬状态、监听器收口。
 *
 * 环境口径（与 `panel-host.test.ts` 同）：node 无 DOM，客户端"重渲了几次"量不出来，
 * 所以**能量的都量在机制本体上**——拖拽会话每帧 dispatch 几次、`LayoutState` 换几个身份、
 * localStorage 写几次、读数 store 通知几个订阅方；"这些次数等于几次渲染"的因果
 * 由静态守门那一组钉住（同一份桥接代码里它们是一一对应的）。
 * 本文件零墙钟断言 ⇒ 留在并行功能池（PITFALLS 72）。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createElement as h, memo, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  beginLiveResize,
  beginSplitResize,
  clamp,
  defaultLayout,
  organizePanels,
  reducer,
  saveLayout,
  sizePropOf,
  MIN_SPLIT_WEIGHT,
  type LayoutState,
  type LiveStyleTarget,
} from '../src/ui/layout';
import {
  getShellEditorStatus,
  isSameEditorStatus,
  setShellEditorStatus,
  subscribeShellEditorStatus,
  type EditorStatusInfo,
} from '../src/ui/ShellLayout';

const UI_DIR = fileURLToPath(new URL('../src/ui', import.meta.url));
const UI = (name: string): string => readFileSync(path.join(UI_DIR, name), 'utf8');

/** 一次两秒、60Hz 的拖拽 = 这么多帧 mousemove（体感口径，不是性能预算） */
const DRAG_FRAMES = 120;

const baseLayout = (): LayoutState => defaultLayout(organizePanels([], {}));

/** 只记账的元素替身：`setProperty` 是本批唯一用到的 DOM 面 */
function fakeTarget(): { target: LiveStyleTarget; writes: Array<[string, string]> } {
  const writes: Array<[string, string]> = [];
  return {
    target: { style: { setProperty: (name: string, value: string) => void writes.push([name, value]) } },
    writes,
  };
}

/** 替身 localStorage：只数写盘次数（真实现就是 `JSON.stringify` + 一次 setItem） */
function withFakeStorage(run: (writes: string[]) => void): void {
  const writes: string[] = [];
  const store = {
    getItem: () => null,
    setItem: (_k: string, v: string) => void writes.push(v),
    removeItem: () => {},
  } as unknown as Storage;
  const saved = globalThis.localStorage;
  (globalThis as { localStorage?: Storage }).localStorage = store;
  try {
    run(writes);
  } finally {
    if (saved === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
    else (globalThis as { localStorage?: Storage }).localStorage = saved;
  }
}

/** 沿拖拽轴走 120 步（每步 1px） */
const dragPositions = (from: number): number[] =>
  Array.from({ length: DRAG_FRAMES }, (_, i) => from + i + 1);

describe('容器尺寸拖拽 · 改造前每帧一次全壳重渲 + 一次写盘', () => {
  it('旧路径（每次 mousemove 走 dispatch）实测：120 个新 LayoutState + 120 次写盘', () => {
    withFakeStorage((writes) => {
      let layout = baseLayout();
      let states = 0;
      for (const pos of dragPositions(100)) {
        const next = reducer(layout, { type: 'resize', container: 'sidebar', size: 260 + (pos - 100) });
        states++;
        layout = next;
        saveLayout(layout); // ShellLayout 的 useEffect(..., [layout]) 就是这么跟着写的
      }
      expect(states).toBe(DRAG_FRAMES);
      expect(writes.length).toBe(DRAG_FRAMES);
    });
  });

  it('新路径实测：整次拖拽 1 个新 LayoutState + 1 次写盘，样式照样每帧跟手（120 次）', () => {
    withFakeStorage((writes) => {
      const { target, writes: styleWrites } = fakeTarget();
      let layout = baseLayout();
      const session = beginLiveResize({
        target,
        container: 'sidebar',
        startSize: layout.sidebar.size,
        startPos: 100,
        sign: 1,
      });
      let states = 0;
      for (const pos of dragPositions(100)) {
        session.onMove(pos); // 拖拽期只做这一件事
      }
      const size = session.finish();
      expect(styleWrites.length).toBe(DRAG_FRAMES);
      if (size !== null) {
        layout = reducer(layout, { type: 'resize', container: 'sidebar', size });
        states++;
        saveLayout(layout);
      }
      expect(states).toBe(1);
      expect(writes.length).toBe(1);
      // 松手 commit 的值与最后一次写进 inline 的那个数逐字相同 ⇒ 不跳一下（旧批的硬约束）
      expect(styleWrites[DRAG_FRAMES - 1]?.[1]).toBe(`${size}px`);
    });
  });

  it('一次都没拖动 ⇒ 不 commit、不写盘（旧实现按下即 dispatch 一次）', () => {
    const { target } = fakeTarget();
    const session = beginLiveResize({
      target,
      container: 'bottom',
      startSize: 200,
      startPos: 500,
      sign: -1,
    });
    expect(session.finish()).toBeNull();
  });

  it('钳制照旧生效（SIZE_LIMITS 那条尺没换）', () => {
    const { target, writes } = fakeTarget();
    const session = beginLiveResize({
      target,
      container: 'sidebar',
      startSize: 260,
      startPos: 0,
      sign: 1,
    });
    for (const pos of dragPositions(0)) session.onMove(pos);
    for (let i = 0; i < 5_000; i++) session.onMove(9_999);
    const size = session.finish();
    expect(size).toBe(clamp('sidebar', 9_999));
    expect(size).toBe(520);
    expect(writes[writes.length - 1]?.[0]).toBe(sizePropOf('sidebar'));
  });

  it('底部区改的是 height（写错属性=拖了没反应，这条钉住两轴各归各）', () => {
    expect(sizePropOf('bottom')).toBe('height');
    expect(sizePropOf('aux')).toBe('width');
    const { target, writes } = fakeTarget();
    const session = beginLiveResize({
      target,
      container: 'bottom',
      startSize: 200,
      startPos: 0,
      sign: -1,
    });
    session.onMove(60);
    expect(writes[0]?.[0]).toBe('height');
  });

  it('拿不到元素（理论上不会发生）⇒ 仍只 commit 一次，不炸也不逐帧写盘', () => {
    const session = beginLiveResize({
      target: undefined,
      container: 'aux',
      startSize: 360,
      startPos: 1000,
      sign: -1,
    });
    for (const pos of dragPositions(0)) session.onMove(pos);
    expect(session.finish()).toBeTypeOf('number');
  });
});

/* ---------------- ② 的读数本体：一次两秒拖拽究竟提交几回 ---------------- */

/**
 * 壳层子树的替身。**node 池没有 DOM**（PITFALLS 72 那套口径），所以"提交几次"用
 * **React 被要求整趟渲染壳层子树的次数**来量：一次新 `LayoutState` = 一次
 * `ShellLayout` 渲染 = 下面每个组件函数各跑一遍。计数由 React 自己触发，不由循环记。
 */
function makeShellProbe(): {
  Shell: (props: { size: number }) => ReactElement;
  counts: { shell: number; editorArea: number; panel: number };
} {
  const counts = { shell: 0, editorArea: 0, panel: 0 };
  // 面板体挂着真 memo（PanelHost 同款）：SSR 一趟必然各跑一次，这一格只作参考
  const Panel = memo((): ReactElement => {
    counts.panel++;
    return h('div', { className: 'panel-body' });
  });
  const EditorArea = (): ReactElement => {
    counts.editorArea++;
    return h(Panel, null);
  };
  const Shell = ({ size }: { size: number }): ReactElement => {
    counts.shell++;
    return h('div', { className: 'shell', style: { width: size } }, h(EditorArea, null));
  };
  return { Shell, counts };
}

describe('一次两秒拖拽的读数（本批承诺的那两个数）', () => {
  it('改造前：120 次整壳提交 + 120 次 localStorage 写盘', () => {
    withFakeStorage((writes) => {
      const { Shell, counts } = makeShellProbe();
      let layout = baseLayout();
      for (const pos of dragPositions(100)) {
        // 旧 mousemove 处理器：dispatch ⇒ 新 LayoutState ⇒ 整壳再渲一趟
        layout = reducer(layout, { type: 'resize', container: 'sidebar', size: 260 + (pos - 100) });
        renderToStaticMarkup(h(Shell, { size: layout.sidebar.size }));
        saveLayout(layout); // 就是 useEffect(..., [layout]) 那行跟着干的活
      }
      expect(counts.shell).toBe(DRAG_FRAMES);
      expect(counts.editorArea).toBe(DRAG_FRAMES);
      expect(writes.length).toBe(DRAG_FRAMES);
    });
  });

  it('改造后：1 次整壳提交 + 1 次写盘，而样式仍每帧跟手（120 次 inline 写）', () => {
    withFakeStorage((writes) => {
      const { Shell, counts } = makeShellProbe();
      const { target, writes: styleWrites } = fakeTarget();
      let layout = baseLayout();
      const session = beginLiveResize({
        target,
        container: 'sidebar',
        startSize: layout.sidebar.size,
        startPos: 100,
        sign: 1,
      });
      for (const pos of dragPositions(100)) session.onMove(pos); // 拖拽期 React 一次都不动
      const size = session.finish();
      if (size !== null) {
        layout = reducer(layout, { type: 'resize', container: 'sidebar', size });
        renderToStaticMarkup(h(Shell, { size: layout.sidebar.size }));
        saveLayout(layout);
      }
      expect(counts.shell).toBe(1);
      expect(counts.editorArea).toBe(1);
      expect(writes.length).toBe(1);
      expect(styleWrites.length).toBe(DRAG_FRAMES);
    });
  });
});

describe('侧栏分栏拖拽 · 同款口径', () => {
  it('旧路径：120 次 setSplitWeights（每次一整帧全壳）；新路径：1 次', () => {
    const weights = [1, 1];
    let legacySets = 0;
    for (const pos of dragPositions(0)) {
      const d = ((pos - 0) / 600) * 2;
      const newA = Math.min(2 - MIN_SPLIT_WEIGHT, Math.max(MIN_SPLIT_WEIGHT, 1 + d));
      void [...weights, newA, 2 - newA];
      legacySets++;
    }
    expect(legacySets).toBe(DRAG_FRAMES);

    const a = fakeTarget();
    const b = fakeTarget();
    const session = beginSplitResize({
      targets: [a.target, b.target],
      weights: [1, 1],
      index: 0,
      totalPx: 600,
      startPos: 0,
    });
    for (const pos of dragPositions(0)) session.onMove(pos);
    const next = session.finish();
    expect(next).not.toBeNull();
    expect(next).toHaveLength(2);
    // 守恒：总和不变；钳制：都不小于最小权重
    expect(next!.reduce((x, y) => x + y, 0)).toBeCloseTo(2, 6);
    expect(Math.min(...next!)).toBeGreaterThanOrEqual(MIN_SPLIT_WEIGHT - 1e-9);
    expect(a.writes.length).toBe(DRAG_FRAMES);
    expect(a.writes[0]?.[0]).toBe('flex-grow');
  });
});

/* ---------------- ③ 光标移动不再往上抬状态 ---------------- */

const info = (over: Partial<EditorStatusInfo> = {}): EditorStatusInfo => ({
  encoding: 'utf-8-bom',
  eol: 'LF',
  lines: 1_200,
  ...over,
});

describe('编辑器读数 store · 一次光标移动只惊动订阅它的小叶子', () => {
  it('内容相等 ⇒ 一次通知都不发（旧实现靠调用方自己比，比漏了就整壳重渲）', () => {
    let notified = 0;
    const un = subscribeShellEditorStatus(() => notified++);
    setShellEditorStatus(info());
    expect(notified).toBe(1);
    setShellEditorStatus(info());
    expect(notified).toBe(1);
    // `sel` 缺省与显式 '' 是同一次读数
    setShellEditorStatus(info({ sel: '' }));
    expect(notified).toBe(1);
    un();
  });

  it('选区文案变了 ⇒ 只通知订阅者；订阅者数量就是重渲半径（一枚叶子 = 1）', () => {
    let leaves = 0;
    const un = subscribeShellEditorStatus(() => leaves++);
    for (const sel of ['1:1', '1:2', '1:3', '选中 12字符']) setShellEditorStatus(info({ sel }));
    expect(leaves).toBe(4); // 每次光标移动 = 1 次叶子重渲，不再 = ProjectView + ShellLayout 两整帧
    un();
    setShellEditorStatus(info({ sel: '9:9' }));
    expect(leaves).toBe(4); // 退订之后不再收到（订阅面自己收口）
  });

  it('没订阅者时也照常记账（读数唯一的真源是这个 store）', () => {
    setShellEditorStatus(info({ encoding: 'shift_jis' }));
    expect(getShellEditorStatus()?.encoding).toBe('shift_jis');
    setShellEditorStatus(null);
    expect(getShellEditorStatus()).toBeNull();
  });

  it('isSameEditorStatus 六字段全比（新增字段漏比会退化成"每次都算变了"）', () => {
    expect(isSameEditorStatus(null, null)).toBe(true);
    expect(isSameEditorStatus(info(), null)).toBe(false);
    expect(isSameEditorStatus(info(), info({ lines: 1_201 }))).toBe(false);
    expect(isSameEditorStatus(info(), info({ autosavedAt: 1 }))).toBe(false);
    expect(isSameEditorStatus(info({ autosavedAt: null }), info())).toBe(true);
  });
});

/* ---------------- ⑦ 监听器与"每次现建对象"的卫生 ---------------- */

describe('监听器与重渲源收口（静态守门）', () => {
  const shell = UI('ShellLayout.tsx');
  const pv = UI('ProjectView.tsx');
  const tabs = UI('tabs-bar.tsx');

  it('ShellLayout 里已经没有 mousemove/mouseup 的全局监听（拖拽全改 pointer + capture）', () => {
    expect(shell).not.toContain("addEventListener('mousemove'");
    expect(shell).not.toContain("addEventListener('mouseup'");
    expect(shell.match(/addEventListener\('pointercancel'/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('两类把手都挂 pointercancel 且在同一处解绑（出窗松手不再留监听）', () => {
    expect(shell).toContain("window.removeEventListener('pointercancel', onUp)");
    expect(shell).toContain('setPointerCapture?.(pointerId)');
  });

  it('ProjectView 的分隔条拖拽补上了 pointercancel 这条收场', () => {
    expect(pv).toContain("window.addEventListener('pointercancel', up)");
    expect(pv).toContain("window.removeEventListener('pointercancel', up)");
  });

  it('标签条 dragover 不再每次塞新对象（同一落点原样留着 ⇒ 不再每移动一像素整条重渲）', () => {
    expect(tabs).toContain('setTabDropAt((cur) =>');
    expect(tabs).not.toMatch(/setTabDropAt\(\{ path: p, before:/);
  });

  it('ProjectView 不再持有 editorStatus state，也不把它当 props 递给壳层', () => {
    expect(pv).not.toMatch(/useState<EditorStatusInfo \| null>/);
    expect(pv).not.toContain('editorStatus={');
    expect(pv).toContain('setShellEditorStatus(info)');
  });

  it('EditorPane 在**调用侧**被 memo 包住（模块级常量，不许写进组件里造新类型）', () => {
    expect(pv).toContain('const EditorPaneMemo = memo(EditorPane)');
    expect(pv).toContain('<EditorPaneMemo');
    // 判据 = **位置**，不是"有没有出现在 ProjectView 之前"（模块级常量本来就该在前面，
    // 写成 `[\s\S]*?function ProjectView` 会把正确实现判成红——PITFALLS 47：先问这条判据什么时候会红）。
    const memoAt = pv.indexOf('const EditorPaneMemo = memo(EditorPane)');
    const bodyAt = pv.indexOf('export function ProjectView');
    expect(memoAt).toBeGreaterThanOrEqual(0);
    expect(bodyAt).toBeGreaterThanOrEqual(0);
    // ① 声明行零缩进 ⇒ 真在模块作用域，不是某个函数体里每帧造一个新类型
    expect(pv.slice(pv.lastIndexOf('\n', memoAt) + 1, memoAt)).toBe('');
    // ② 组件体内不再出现第二处 `memo(EditorPane)`
    expect(pv.slice(bodyAt)).not.toContain('memo(EditorPane)');
    // 送进去的两条回调是恒定身份（否则 memo 等于没包）
    expect(pv).toContain('onDirtyChange={stableDirtyChange}');
    expect(pv).toContain('onReauth={stableReauth}');
  });

  it('状态栏可写胶囊的判定 memo 住了（内核那侧每次调用现拼一份根数组）', () => {
    expect(shell).toMatch(/const writableArea = useMemo\(\(\) => fileWritableArea\(kernel, activeFile/);
  });

  it('文件数 / 函数数那道循环挂在索引身份上，不再每渲一次数一遍 2,325 条', () => {
    expect(pv).toMatch(/const stats = useMemo\(\(\) => \{[\s\S]*?for \(const f of index\.files\.values\(\)\)/);
  });
});
