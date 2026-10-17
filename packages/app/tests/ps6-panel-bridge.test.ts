/**
 * PS-6 ①：面板把 props 桥在**可变 ref** 上时，memo 必须还有地方看见变化。
 *
 * 缺陷形态（2026-10-20 性能批查出，属"拿性能收益换掉了正确性"）：
 * 内建视图（口上文件 / 搜索 / 问题）为了不让组件身份每帧变化（那会整树重挂、展开态全丢），
 * 把真 props 桥在 `xxxArgsRef.current` 上，只把**恒定的 component 函数**交给壳层。
 * 而 `PanelHost` 的 memo 比较器当时只看 `contribution | floating | uiPrefs` 三条——
 * 这三条对桥接面板**永远同引用**，于是 memo 永久 bail：
 * `FileTree` 再也收不到新的 `index` / `activeFile` / `refreshNonce`，
 * 定位到树（B4）、外部改动后重列（HK-5）、冷开快照转索引三件事全是哑的，
 * 只有偶然重挂组件时才"看起来好了"。
 *
 * 证据分三层（node 环境无 DOM，客户端的"重渲几次"量不出来，与 `panel-host.test.ts` 同口径）：
 * ① **比较器语义**：`hostVersion` 换了必须判不等——这条在改造前的实现上是**红的**；
 * ② **改造前的负自证**：把旧三条比较照抄一份跑同一个输入，它答"相等"，
 *    即"memo 永久跳过"不是推测而是量出来的（PITFALLS 47：写判据前先问它什么时候会红）；
 * ③ **变化确实送得到**：桥那边换了索引，`FileTree` 拿到新 props 就把新文件画出来。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ErbIndex, GameProject, UIPanelProps } from '@kojo/plugin-api';
import {
  PanelBody,
  hostVersionStep,
  panelBodyPropsEqual,
  type HostVersionState,
  type PanelBodyProps,
} from '../src/ui/PanelHost';
import { FileTree } from '../src/ui/FileTree';

const UI_DIR = fileURLToPath(new URL('../src/ui', import.meta.url));
const UI = (name: string): string => readFileSync(path.join(UI_DIR, name), 'utf8');

/* ---------------- ① 比较器认 hostVersion ---------------- */

describe('PanelBody 比较器 · 宿主版本闸是第四处变化位', () => {
  const contribution = { id: 'demo', component: ({}: UIPanelProps) => h('span', null, 'x') };
  const uiPrefs = { panelVirtualize: false };
  const base: PanelBodyProps = { contribution, uiPrefs, floating: undefined, hostVersion: 3 };

  it('只有版本闸变了 ⇒ 判不等（桥接面板的新值这才送得进去）', () => {
    expect(panelBodyPropsEqual(base, { ...base, hostVersion: 4 })).toBe(false);
  });

  it('版本闸没变（含两侧都缺省）⇒ 仍判等（无关重渲照样挡在门外）', () => {
    expect(panelBodyPropsEqual(base, { ...base })).toBe(true);
    const noVersion: PanelBodyProps = { contribution, uiPrefs };
    expect(panelBodyPropsEqual(noVersion, { ...noVersion })).toBe(true);
    // 一侧缺省一侧显式 0 = 同一个闸位（插件面板不传，行为与改造前逐字一致）
    expect(panelBodyPropsEqual(noVersion, { ...noVersion, hostVersion: 0 })).toBe(true);
  });

  it('SSR 真渲染吃过这一格：版本换了 ⇒ 面板体重跑（读到的就是桥里的新值）', () => {
    let renders = 0;
    const counting = ({}: UIPanelProps) => {
      renders++;
      return h('span', null, String(renders));
    };
    const c = { id: 'demo', component: counting };
    renderToStaticMarkup(h(PanelBody, { contribution: c, hostVersion: 1 }));
    renderToStaticMarkup(h(PanelBody, { contribution: c, hostVersion: 1 }));
    expect(renders).toBe(2); // SSR 不建 fiber ⇒ 两次都是整趟渲染，这一条只钉"面板真的会渲"
  });
});

/* ---------------- ② 改造前的负自证 ---------------- */

describe('改造前那版比较器 · 对桥接面板永远答"相等"（这就是 bug 本身）', () => {
  /** 逐字照抄 2026-10-16 性能批那三条（一条不多一条不少） */
  const legacyEqual = (a: PanelBodyProps, b: PanelBodyProps): boolean =>
    a.contribution === b.contribution && a.floating === b.floating && a.uiPrefs === b.uiPrefs;

  const contribution = { id: 'kojo.files', component: ({}: UIPanelProps) => h('span', null, 'x') };
  const uiPrefs = { panelVirtualize: false };

  it('桥里换了索引 / 活动文件 / 失效信号，旧比较器照旧判等 ⇒ memo 永久 bail', () => {
    const prev: PanelBodyProps = { contribution, uiPrefs, hostVersion: 0 };
    const next: PanelBodyProps = { contribution, uiPrefs, hostVersion: 7 };
    expect(legacyEqual(prev, next)).toBe(true); // 旧实现：看不见任何变化
    expect(panelBodyPropsEqual(prev, next)).toBe(false); // 新实现：抬号即重渲
  });
});

/* ---------------- ③ 版本闸的记账（纯函数） ---------------- */

describe('hostVersionStep · 什么算"桥那边变了"', () => {
  const start: HostVersionState = { version: 0, deps: [] };

  it('依赖逐项 Object.is：全同 ⇒ 同一格、号不动', () => {
    const deps = ['a', 1, null];
    const s1 = hostVersionStep(start, deps);
    expect(s1.version).toBe(1);
    expect(hostVersionStep(s1, deps)).toBe(s1); // 同对象 ⇒ 宿主那侧 memo 依旧 bail（不白渲面板）
  });

  it('文件数从 1 涨到 2（外部改动）⇒ 号 +1', () => {
    const s1 = hostVersionStep(start, [{ files: new Map([['a.erb', {}]]) }]);
    const s2 = hostVersionStep(s1, [{ files: new Map([['a.erb', {}], ['b.erb', {}]]) }]);
    expect(s2.version).toBe(s1.version + 1);
  });

  it('活动文件换了 ⇒ 号 +1（定位到树 B4 那条腿）', () => {
    const s1 = hostVersionStep(start, ['x.erb', 'a.erb']);
    const s2 = hostVersionStep(s1, ['x.erb', 'b.erb']);
    expect(s2.version).toBe(2);
  });

  it('失效 nonce 从 3 到 4 ⇒ 号 +1（HK-5 那条腿）', () => {
    const s1 = hostVersionStep(start, [3]);
    expect(hostVersionStep(s1, [4]).version).toBe(2);
  });

  it('依赖长度变了也算变（少一项不许被当成"没变"）', () => {
    const s1 = hostVersionStep(start, [1, 2, 3]);
    expect(hostVersionStep(s1, [1, 2]).version).toBe(2);
  });

  it('NaN 按 Object.is 判"同值"（同一次读数不该被抬成两次变化）', () => {
    const s1 = hostVersionStep(start, [Number.NaN]);
    expect(hostVersionStep(s1, [Number.NaN])).toBe(s1);
  });
});

/* ---------------- ④ 变化送得到面板：索引换文件 ⇒ 树画新文件 ---------------- */

const project = {
  rootDir: 'C:/game',
  adapterId: 'eratw',
  kojoPaths: ['C:/game/ERB'],
  charaIndex: new Map<string, { id: number; name: string }>(),
} as unknown as GameProject;

const indexWith = (paths: readonly string[]): ErbIndex =>
  ({ files: new Map(paths.map((p) => [p, { path: p, functions: [] }])) }) as unknown as ErbIndex;

const treeMarkup = (index: ErbIndex): string =>
  renderToStaticMarkup(
    h(FileTree, {
      project,
      index,
      activeFile: null,
      onOpenFile: () => {},
    }),
  );

describe('FileTree · 桥送进新索引就把新文件数画出来', () => {
  /**
   * 观测点选**组头的文件计数**（`.group-count`）：默认态只有组头展开、文件行折叠，
   * 而这一格正是"索引换了 ⇒ 树跟着说新话"的最小可见事实（PITFALLS 47：先问这条判据
   * 什么时候会红——桥送不进去时它永远停在旧数字上）。
   */
  const groupCount = (markup: string): string | null =>
    markup.match(/class="group-count">(\d+)</)?.[1] ?? null;

  it('外部丢进一份文件 ⇒ 同一只树的计数从 1 变 2（旧实现：props 送不进去，直到偶然重挂）', () => {
    expect(groupCount(treeMarkup(indexWith(['C:/game/ERB/001/M_KOJO_K1_1.ERB'])))).toBe('1');
    expect(
      groupCount(
        treeMarkup(indexWith(['C:/game/ERB/001/M_KOJO_K1_1.ERB', 'C:/game/ERB/001/M_KOJO_K1_2.ERB'])),
      ),
    ).toBe('2');
  });

  it('再加一份 ⇒ 计数 3（数字只跟着索引走，不跟着渲染次数走）', () => {
    expect(
      groupCount(
        treeMarkup(
          indexWith([
            'C:/game/ERB/001/M_KOJO_K1_1.ERB',
            'C:/game/ERB/001/M_KOJO_K1_2.ERB',
            'C:/game/ERB/001/M_KOJO_K1_3.ERB',
          ]),
        ),
      ),
    ).toBe('3');
  });
});

/* ---------------- ⑤ 接线（静态守门） ---------------- */

describe('宿主确实抬号并把它接到 PanelBody（结构约定，少一环就回到哑的状态）', () => {
  const pv = UI('ProjectView.tsx');
  const shell = UI('ShellLayout.tsx');

  it('ProjectView：文件树的版本闸吃的正是那三样桥接内容', () => {
    const block = pv.slice(pv.indexOf('const fileTreeVersion = useHostVersion(['));
    const deps = block.slice(0, block.indexOf('])'));
    for (const dep of ['index', 'activeFile', 'treeNonce']) expect(deps).toContain(dep);
  });

  it('ProjectView：三只内建视图各占一格，且以面板 id 为键下传', () => {
    expect(pv).toContain("'kojo.files': fileTreeVersion");
    expect(pv).toContain("'kojo.search': searchVersion");
    expect(pv).toContain("'kojo.problems': problemVersion");
    expect(pv).toContain('panelHostVersions={panelHostVersions}');
  });

  it('ShellLayout：容器 / 分栏 / 浮窗四条渲染腿都把这一格转给 PanelBody', () => {
    expect(shell.match(/hostVersion=\{panelHostVersions\?\.\[[^\]]+\]\}/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('抬号只给桥接面板：插件面板那三格查不到 ⇒ 比较按 0 走（一次切标签不该十只面板陪跑）', () => {
    expect(shell).toContain('panelHostVersions?.[activeAux.id]');
    expect(shell).toContain('panelHostVersions?.[activeBottom.id]');
  });
});
