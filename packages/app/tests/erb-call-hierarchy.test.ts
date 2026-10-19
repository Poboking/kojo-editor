/**
 * ERB 调用层级（`erb-call-hierarchy.ts` + overlay）单测——**不依赖 Monaco / 内核**。
 *
 * 三条腿（形态照 `erb-rename.test.ts` + `diff-view.test.ts` + `search-panel-render.test.ts`）：
 * 1. 数据层纯函数：所属函数反查（`functionAt` 优先 / 缺席退化 / 抛错退化 / fail-open）、
 *    入边收集（definition 剔除、按调用者分组、索引缝跳过）、出边收集（只认 `call`、
 *    区间包含、跨文件剔除、缺 callee 跳过）——假索引驱动；
 * 2. 状态单源：set → 订阅 → 清空（关闭后不留旧请求）；
 * 3. overlay 静态渲染（react-dom/server）：给定位点 ⇒ 目标函数名 / 入边组 / 调用点行
 *    / 计数画出来；拒绝与索引缺席都**可见**（铁律「不静默」）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ErbFile, ErbFunction, ErbFunctionRef, ErbIndex, ErbIndexState, ErbReference } from '@kojo/plugin-api';
import {
  incomingCalls,
  outgoingCalls,
  resolveEnclosingFunction,
  type FunctionAtResolver,
} from '../src/monaco/erb-call-hierarchy';
import {
  getCallHierarchyState,
  setCallHierarchyState,
  subscribeCallHierarchy,
} from '../src/ui/call-hierarchy';
import { createCallHierarchyOverlay, CALL_HIERARCHY_WINDOW_INITIAL } from '../src/ui/CallHierarchyOverlay';
import {
  erbOccurrences,
  explainReferenceCounts,
  occurrencesFromLocations,
  tallyReferenceOccurrences,
  type ReferenceTally,
} from '../src/ui/reference-utils';
import { getReferenceTally, referenceTallyFor, setReferenceTally } from '../src/ui/reference-tally-store';

/* ============================== 假索引 ============================== */

const FILE_A = 'C:\\game\\ERB\\A.ERB';
const FILE_B = 'C:\\game\\ERB\\B.ERB';

function fn(name: string, filePath: string, startLine: number, endLine: number): ErbFunction {
  return { name, normalizedName: name.toUpperCase(), params: [], startLine, endLine, filePath };
}

function fnRef(name: string, filePath: string, startLine: number, endLine: number): ErbFunctionRef {
  return { name, normalizedName: name.toUpperCase(), filePath, startLine, endLine };
}

function ref(
  kind: ErbReference['kind'],
  filePath: string,
  line: number,
  column = 1,
  endColumn = column + 5,
): ErbReference {
  return { filePath, line, column, endColumn, kind };
}

function file(path: string, functions: ErbFunction[]): ErbFile {
  return { path, functions, dims: [], hasFunctionDirective: false, lineCount: 200 };
}

function makeIndex(opts: {
  files?: ErbFile[];
  byName?: ReadonlyArray<[string, ErbFunctionRef[]]>;
  bySymbol?: ReadonlyArray<[string, ErbReference[]]>;
  withReferences?: boolean;
}): ErbIndex {
  return {
    files: new Map((opts.files ?? []).map((f) => [f.path, f])),
    byName: new Map(opts.byName ?? []),
    // references 是契约里的只读可选成员，构造期一次性给齐
    ...(opts.withReferences === false ? {} : { references: { bySymbol: new Map(opts.bySymbol ?? []) } }),
  } as ErbIndex;
}

/* ============================== 所属函数反查 ============================== */

describe('resolveEnclosingFunction', () => {
  const index = makeIndex({ files: [file(FILE_A, [fn('FOO', FILE_A, 10, 20), fn('BAR', FILE_A, 30, 40)])] });

  it('functionAt 在场 ⇒ 它的答案就是终局（答 undefined 也不退化自扫）', () => {
    const functionAt: FunctionAtResolver = (path, line) => (path === FILE_A && line === 15 ? fn('FOO', FILE_A, 10, 20) : undefined);
    expect(resolveEnclosingFunction(index, functionAt, FILE_A, 15)?.name).toBe('FOO');
    // 25 行明明落在文件里两个函数之间——通道说没有就没有，不做第二判据叠加
    expect(resolveEnclosingFunction(index, functionAt, FILE_A, 25)).toBeUndefined();
  });

  it('functionAt 抛错 ⇒ 退化到索引定义区间判断', () => {
    const functionAt: FunctionAtResolver = () => {
      throw new Error('service hiccup');
    };
    expect(resolveEnclosingFunction(index, functionAt, FILE_A, 35)?.name).toBe('BAR');
  });

  it('functionAt 缺席 ⇒ 直接走索引定义区间（含端点）', () => {
    expect(resolveEnclosingFunction(index, null, FILE_A, 10)?.name).toBe('FOO'); // @ 行本身
    expect(resolveEnclosingFunction(index, null, FILE_A, 20)?.name).toBe('FOO'); // 末行
    expect(resolveEnclosingFunction(index, null, FILE_A, 25)).toBeUndefined(); // 函数之间
    expect(resolveEnclosingFunction(index, null, FILE_B, 15)).toBeUndefined(); // 未知文件
  });
});

/* ============================== 入边 ============================== */

describe('incomingCalls', () => {
  const files = [
    file(FILE_A, [fn('TARGET', FILE_A, 10, 20), fn('CALLER1', FILE_A, 30, 40)]),
    file(FILE_B, [fn('CALLER2', FILE_B, 5, 15)]),
  ];
  const bySymbol: ReadonlyArray<[string, ErbReference[]]> = [
    [
      'TARGET',
      [
        ref('definition', FILE_A, 10, 2, 8), // 定义行自身：剔除
        ref('call', FILE_A, 31, 3, 9), // CALLER1 体内
        ref('call', FILE_A, 33, 5, 11), // CALLER1 体内第二处
        ref('mention', FILE_B, 7, 1, 7), // CALLER2 体内（表达式调用）
        ref('call', FILE_A, 99, 1, 6), // 顶层代码（不在任何函数体内）：fail-open 跳过
      ],
    ],
  ];
  const index = makeIndex({
    files,
    byName: [['TARGET', [fnRef('TARGET', FILE_A, 10, 20)]]],
    bySymbol,
  });

  it('名字大小写不敏感（归一化大写查表）', () => {
    expect(incomingCalls(index, null, 'target').length).toBeGreaterThan(0);
    expect(incomingCalls(index, null, 'TARGET').length).toBeGreaterThan(0);
  });

  it('definition 剔除；组内点位序、组间首现序；索引缝条目跳过', () => {
    const groups = incomingCalls(index, null, 'TARGET');
    expect(groups.map((g) => g.caller.name)).toEqual(['CALLER1', 'CALLER2']);
    expect(groups[0]!.sites.map((s) => s.line)).toEqual([31, 33]);
    expect(groups[1]!.sites.map((s) => s.line)).toEqual([7]);
  });

  it('functionAt 在场时走通道（反查不了的行照样跳过）', () => {
    const functionAt: FunctionAtResolver = (path, line) => {
      if (path === FILE_A && line >= 30 && line <= 40) return fn('CALLER1', FILE_A, 30, 40);
      return undefined; // CALLER2 的行反查不了 ⇒ 那条整组消失
    };
    const groups = incomingCalls(index, functionAt, 'TARGET');
    expect(groups.map((g) => g.caller.name)).toEqual(['CALLER1']);
  });

  it('名字无记录 / 反向索引缺席 ⇒ 空数组（不猜）', () => {
    expect(incomingCalls(index, null, 'NOBODY')).toEqual([]);
    expect(incomingCalls(makeIndex({ files, withReferences: false }), null, 'TARGET')).toEqual([]);
  });
});

/* ============================== 出边 ============================== */

describe('outgoingCalls', () => {
  const index = makeIndex({
    files: [file(FILE_A, [fn('FOO', FILE_A, 10, 20), fn('BAR', FILE_A, 30, 40)])],
    byName: [
      ['FOO', [fnRef('FOO', FILE_A, 10, 20)]],
      ['BAR', [fnRef('BAR', FILE_A, 30, 40)]],
      ['BAZ', [fnRef('BAZ', FILE_B, 1, 9)]],
    ],
    bySymbol: [
      [
        'BAR',
        [
          ref('call', FILE_A, 12, 1, 4), // FOO 体内调 BAR
          ref('mention', FILE_A, 14, 1, 4), // mention 不进出边
          ref('call', FILE_A, 31, 1, 4), // BAR 自己体内——不属于 FOO
          ref('call', FILE_B, 12, 1, 4), // 别的文件
        ],
      ],
      ['BAZ', [ref('call', FILE_A, 18, 2, 6)]], // FOO 体内调 BAZ
      ['QUX', [ref('call', FILE_A, 11, 1, 4)]], // byName 没有这个名字：fail-open 跳过
    ],
  });

  it('只认 call + 本文件 + 本函数区间；组按首调用行排序', () => {
    const groups = outgoingCalls(index, { filePath: FILE_A, startLine: 10, endLine: 20 });
    // QUX（byName 查不到）被 fail-open 跳过；mention 与跨文件/跨函数的 call 都不沾；
    // 首调用行 12（BAR）在 18（BAZ）之前
    expect(groups.map((g) => g.callee.name)).toEqual(['BAR', 'BAZ']);
    expect(groups[0]!.sites.map((s) => s.line)).toEqual([12]);
    expect(groups[1]!.sites.map((s) => s.line)).toEqual([18]);
  });

  it('区间按函数切：BAR 区间只收它体内的调用（含自调用递归边）', () => {
    const groups = outgoingCalls(index, { filePath: FILE_A, startLine: 30, endLine: 40 });
    // line 31 是 BAR 体内的 CALL BAR（自调用）；12/18 在 FOO 区间、FILE_B 的不沾
    expect(groups.map((g) => g.callee.name)).toEqual(['BAR']);
    expect(groups[0]!.sites.map((s) => s.line)).toEqual([31]);
  });

  it('反向索引缺席 ⇒ 空数组（与入边同源，索引没有就都没有）', () => {
    const bare = makeIndex({ files: [file(FILE_A, [fn('FOO', FILE_A, 10, 20)])], withReferences: false });
    expect(outgoingCalls(bare, { filePath: FILE_A, startLine: 10, endLine: 20 })).toEqual([]);
  });
});

/* ============================== 状态单源 ============================== */

describe('调用层级状态单源', () => {
  afterEach(() => setCallHierarchyState(null));

  it('set → 订阅者收到；清空后回到 null', () => {
    let seen: unknown = 'untouched';
    const un = subscribeCallHierarchy(() => {
      seen = getCallHierarchyState();
    });
    setCallHierarchyState({ kind: 'request', request: { filePath: FILE_A, line: 12 } });
    expect(seen).toEqual({ kind: 'request', request: { filePath: FILE_A, line: 12 } });
    setCallHierarchyState(null);
    expect(getCallHierarchyState()).toBeNull();
    un();
  });
});

/* ============================== overlay 静态渲染 ============================== */

describe('CallHierarchyOverlay 渲染', () => {
  beforeEach(() => {
    setCallHierarchyState(null);
    setReferenceTally(null); // 台账读数也是模块级单源：不留上一个用例的读数
  });
  afterEach(() => {
    setCallHierarchyState(null);
    setReferenceTally(null);
  });

  const index = makeIndex({
    files: [
      file(FILE_A, [fn('TARGET', FILE_A, 10, 20), fn('CALLER1', FILE_A, 30, 40)]),
      file(FILE_B, [fn('CALLEE', FILE_B, 1, 9)]),
    ],
    byName: [
      ['TARGET', [fnRef('TARGET', FILE_A, 10, 20)]],
      ['CALLER1', [fnRef('CALLER1', FILE_A, 30, 40)]],
      ['CALLEE', [fnRef('CALLEE', FILE_B, 1, 9)]],
    ],
    bySymbol: [
      [
        'TARGET',
        [ref('definition', FILE_A, 10, 2), ref('call', FILE_A, 31, 3), ref('call', FILE_A, 33, 5)],
      ],
      ['CALLEE', [ref('call', FILE_A, 12, 1)]],
    ],
  });

  const deps = {
    currentIndex: () => index,
    functionAt: (): null => null, // 通道缺席 ⇒ 走数据层退化腿（索引自扫）
    reveal: () => undefined,
    close: () => undefined,
  };

  // 工厂返回 `() => unknown`（UIPanelComponent 形状）；渲染判据按 React 组件消费
  function render(): string {
    const Overlay = createCallHierarchyOverlay(deps) as () => ReactElement;
    return renderToStaticMarkup(createElement(Overlay));
  }

  /** 把 F12 那一次计算的读数写进单源（与 `EditorPane` 的 `onTally` 逐字同一动作） */
  function feedTally(normalizedName: string, tally: ReferenceTally, path = FILE_A): void {
    setReferenceTally({ tally, explanation: explainReferenceCounts(tally), path, normalizedName });
  }

  /** 面板头的入边处数（`被调用（n 个调用者 · m 处）`；没读数时这一位是「处数未读」） */
  function incomingCountOf(html: string): number | null {
    const m = /被调用（\d+ 个调用者 · (\d+) 处）/.exec(html);
    return m ? Number(m[1]) : null;
  }

  it('就绪请求 ⇒ 目标函数名 / 入边组与点位 / 出边画出来，入边处数取自台账读数', () => {
    const tally = tallyReferenceOccurrences(erbOccurrences(index.references!.bySymbol.get('TARGET')!));
    feedTally('TARGET', tally); // 定义 1 + 调用 2 ⇒ 非定义位 2
    setCallHierarchyState({ kind: 'request', request: { filePath: FILE_A, line: 15 } });
    const html = render();
    expect(html).toContain('调用层级');
    expect(html).toContain('TARGET');
    expect(html).toContain('1 个调用者 · 2 处');
    expect(html).toContain('CALLER1');
    expect(html).toContain('A.ERB:31:3');
    expect(html).toContain('1 个目标 · 1 处');
    expect(html).toContain('CALLEE');
    expect(html).toContain('A.ERB:12:1');
    // 差值那句话也是抄的台账原文（面板不写第二份文案）
    expect(html).toContain(explainReferenceCounts(tally));
  });

  it('处数由台账说了算：读数与清单行数不一致时以读数为准（第二把尺子已经删掉）', () => {
    // 台账里另有两处引用点落在索引缝里（`incomingCalls` fail-open 不收进清单）
    const refs = [
      ref('definition', FILE_A, 10, 2),
      ref('call', FILE_A, 31, 3),
      ref('call', FILE_A, 33, 5),
      ref('mention', FILE_B, 7, 4),
      ref('call', FILE_B, 8, 4),
    ];
    const tally = tallyReferenceOccurrences(erbOccurrences(refs));
    feedTally('TARGET', tally); // 非定义位 4，而清单只能列出 2 处
    setCallHierarchyState({ kind: 'request', request: { filePath: FILE_A, line: 15 } });
    const html = render();
    expect(incomingCountOf(html)).toBe(tally.nonDefinitionCount);
    expect(tally.nonDefinitionCount).toBe(4);
    expect(html).toContain('A.ERB:31:3'); // 清单仍是面板自己的点位数据，没被读数改写
    expect(html).toContain(explainReferenceCounts(tally));
  });

  it('没有台账读数 ⇒ 明说「处数未读」，不拿清单行数冒充', () => {
    setCallHierarchyState({ kind: 'request', request: { filePath: FILE_A, line: 15 } });
    const html = render();
    expect(html).toContain('1 个调用者 · 处数未读');
    expect(incomingCountOf(html)).toBeNull();
    expect(html).toContain('同一份台账');
  });

  it('同文件里别名的读数不冒充（`referenceTallyFor` 是唯一匹配判据）', () => {
    const tally = tallyReferenceOccurrences(erbOccurrences([ref('call', FILE_A, 31, 3)]));
    feedTally('OTHER_ONE', tally);
    expect(referenceTallyFor(FILE_A, 'TARGET')).toBeNull();
    setCallHierarchyState({ kind: 'request', request: { filePath: FILE_A, line: 15 } });
    expect(render()).toContain('1 个调用者 · 处数未读');
  });

  it('对拍：面板头的处数 = F12 那次计算交来的同一个数', () => {
    const locations = index
      .references!.bySymbol.get('TARGET')!
      .map((r) => ({ filePath: r.filePath, line: r.line, column: r.column, kind: r.kind }));
    // F12 腿：`installReferenceProvider` 的 onTally 用的正是这条纯计算（位置进台账 → 出读数）
    const f12Tally = tallyReferenceOccurrences(occurrencesFromLocations(locations));
    feedTally('TARGET', f12Tally);
    setCallHierarchyState({ kind: 'request', request: { filePath: FILE_A, line: 15 } });
    expect(incomingCountOf(render())).toBe(f12Tally.nonDefinitionCount);
    expect(getReferenceTally()?.tally).toBe(f12Tally);
  });

  it('面板源码里不再有第二把尺子（`incoming.reduce` 已收口）', async () => {
    const { readFileSync } = await import('node:fs');
    const code = readFileSync(new URL('../src/ui/CallHierarchyOverlay.tsx', import.meta.url), 'utf8')
      .split('\n')
      .filter((line: string) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/incoming\.reduce/);
    expect(code).toMatch(/nonDefinitionCount/);
  });

  it('拒绝态画进面板（拒绝不许只进控制台）', () => {
    setCallHierarchyState({ kind: 'rejected', reason: '现在屏幕上的是派生视图（行号不属于原文）。' });
    const html = render();
    expect(html).toContain('无法查看调用层级');
    expect(html).toContain('派生视图');
  });

  it('索引未建 / 光标不在函数体内 ⇒ 可见说明，不画空列表', () => {
    setCallHierarchyState({ kind: 'request', request: { filePath: FILE_A, line: 15 } });
    const noIndex = renderToStaticMarkup(
      createElement(createCallHierarchyOverlay({ ...deps, currentIndex: () => null }) as () => ReactElement),
    );
    expect(noIndex).toContain('索引未建');

    setCallHierarchyState({ kind: 'request', request: { filePath: FILE_A, line: 999 } });
    const offBody = render();
    expect(offBody).toContain('不在任何 ERB 函数体内');
  });

  /* ── ST-CONSUMERS：这一格也改成按 phase 查表（旧形态对"没地方可扫"承诺"稍后再试"） ── */

  const fact = (over: Partial<ErbIndexState>): ErbIndexState => ({
    phase: 'ready',
    sources: [
      { source: 'project', offered: 0, available: false, reason: 'roots() 抛错：EPERM' },
      { source: 'workspace', offered: 0, available: true },
    ],
    rootsWalked: 0,
    filesScanned: 0,
    functions: 0,
    coverage: 'none',
    ...over,
  });

  /** 带事实面的 deps（空索引 = 本轮产出了索引对象但什么都没有） */
  const emptyIndexDeps = (indexState: ErbIndexState | null) => ({
    ...deps,
    currentIndex: () => (indexState === null ? index : makeIndex({ files: [], byName: [], bySymbol: [] })),
    indexState: () => indexState,
  });

  function renderWith(d: unknown): string {
    setCallHierarchyState({ kind: 'request', request: { filePath: FILE_A, line: 999 } });
    return renderToStaticMarkup(createElement(d as () => ReactElement));
  }

  it('没地方可扫 ⇒ 说"没有可扫描的位置"并带原始读数，不再把锅甩给光标', () => {
    const html = renderWith(
      createCallHierarchyOverlay(emptyIndexDeps(fact({ phase: 'nothing-to-scan' }))) as () => ReactElement,
    );
    expect(html).toContain('没有可扫描的位置');
    expect(html).toContain('走了 0 个位置 · 扫了 0 个文件 · 名录 0 名');
    expect(html).not.toContain('不在任何 ERB 函数体内');
    // 悬停里逐来源读数一条不丢（读不到的那一类位置连原因一起给）
    expect(html).toContain('project 交出 0 个根');
    expect(html).toContain('roots() 抛错：EPERM');
  });

  it('扫了什么都没有 ⇒ 另一句（与"没地方可扫"不同句）', () => {
    const html = renderWith(
      createCallHierarchyOverlay(
        emptyIndexDeps(fact({ phase: 'empty', rootsWalked: 2, filesScanned: 40, functions: 0, coverage: 'full' })),
      ) as () => ReactElement,
    );
    expect(html).toContain('确实一条都没有');
    expect(html).not.toContain('没有可扫描的位置');
  });

  it('失败 ⇒ 说"构建失败"并逐字带上原始错误', () => {
    const html = renderWith(
      createCallHierarchyOverlay(
        { ...deps, currentIndex: () => null, indexState: () => fact({ phase: 'failed', error: 'boom' }) },
      ) as () => ReactElement,
    );
    expect(html).toContain('构建失败');
    expect(html).toContain('原始错误：boom');
    expect(html).not.toContain('稍后再试');
  });

  it('就绪 / 正在构建 / 提供方没交事实 ⇒ 三格逐字用回改前的句子（旧行为零改动）', () => {
    const ready = renderWith(
      createCallHierarchyOverlay(
        emptyIndexDeps(fact({ phase: 'ready', rootsWalked: 2, filesScanned: 40, functions: 9, coverage: 'full' })),
      ) as () => ReactElement,
    );
    expect(ready).toContain('不在任何 ERB 函数体内');
    const scanning = renderToStaticMarkup(
      createElement(
        createCallHierarchyOverlay({
          ...deps,
          currentIndex: () => null,
          indexState: () => fact({ phase: 'scanning', rootsWalked: 2, functions: 9, coverage: 'full' }),
        }) as () => ReactElement,
      ),
    );
    expect(scanning).toContain('ERB 函数索引未建（索引随项目打开自动构建，稍后再试）。');
    const legacy = renderToStaticMarkup(
      createElement(createCallHierarchyOverlay({ ...deps, currentIndex: () => null }) as () => ReactElement),
    );
    expect(legacy).toContain('索引未建');
  });

  it('PS-15 行清单窗口化：首帧 120 行 + 哨兵说得出差额（RENDER_CAP=300 死顶已除）', () => {
    // 1 个调用者名下 400 个点位 ⇒ 入边清单 401 行（组行 1 + 点位 400）
    const refs: ErbReference[] = [ref('definition', FILE_A, 10, 2)];
    for (let line = 31; line <= 430; line++) refs.push(ref('call', FILE_A, line, 3));
    const bigIndex = makeIndex({
      files: [file(FILE_A, [fn('TARGET', FILE_A, 10, 20), fn('CALLER1', FILE_A, 30, 431)])],
      byName: [
        ['TARGET', [fnRef('TARGET', FILE_A, 10, 20)]],
        ['CALLER1', [fnRef('CALLER1', FILE_A, 30, 431)]],
      ],
      bySymbol: [['TARGET', refs]],
    });
    setCallHierarchyState({ kind: 'request', request: { filePath: FILE_A, line: 15 } });
    const html = renderToStaticMarkup(
      createElement(
        createCallHierarchyOverlay({ ...deps, currentIndex: () => bigIndex }) as () => ReactElement,
      ),
    );
    // 首帔窗口 = 组行 1 + 点位 119（`↳` 每点位行一枚）
    expect((html.match(/↳/g) ?? []).length).toBe(CALL_HIERARCHY_WINDOW_INITIAL - 1);
    // 哨兵：全量可达（差额与总数都说出来），不再有「仅显示前 N 行」的告别
    expect(html).toContain(`还有 ${401 - CALL_HIERARCHY_WINDOW_INITIAL} 行，共 401 行`);
    expect(html).not.toContain('仅显示前');
  });
});
