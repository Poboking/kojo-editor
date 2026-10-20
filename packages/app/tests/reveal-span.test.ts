/**
 * W9 落点 span 统一 · **跨发起方对拍**（判据①②）。
 *
 * 这批的验收不是"每条腿各自测一遍"，而是**同一处位置、六条腿、同一个落点**：
 * 定义（Peek 腿）、定义（事件通道腿）、跳到实现（同一个 provider 核）、问题面板、
 * 检索面板、G1 回放跳转——六份产物按同一个几何夹取后，`(line, columnStart, columnEnd)`
 * 必须逐字相等（对拍不许放宽成恒真）。
 *
 * 判据②单独钉："没有区间"这件事只有一种退法（零宽，起点 = 列，没列就 1），
 * 六条腿在缺信息时也必须给出同一个答案。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { KernelEventMap } from '@kojo/plugin-api';
import { clampRevealPosition, revealLocationOf, revealTargetOf, type RevealGeometry } from '../src/monaco/reveal-position';
import { toDefinitionLinks, type DefinitionLocation } from '../src/monaco/kojo-definition';
import { installImplementationProvider } from '../src/monaco/erb-implementation';
import {
  collectReferenceLocations,
  installReferenceProvider,
  type ReferenceLocation,
} from '../src/monaco/find-references';
import { installCodeLensProvider, CODE_LENS_COMMAND } from '../src/monaco/kojo-code-lens';
import type { EditorLanguageServiceContribution, EditorCodeLens } from '@kojo/plugin-api';
import { problemRevealSpan } from '../src/ui/ProblemPanel';
import type { EditorProblem } from '../src/ui/problem-store';
import { searchMatchSpan, type SearchPanelProps } from '../src/ui/SearchPanel';
import type { SearchMatch } from '../src/bridge/search';
import { planJumpToState } from '../src/ui/jump-to-state';

/** 桩 model：`getLineMaxColumn` = 行长 + 1（与真 Monaco 同口径），目标行 8 上写着 `  @FOO_BAR(...` */
const LINE_LENGTH = 24;
const geometryFor = (): RevealGeometry => ({ lineCount: 20, maxColumn: () => LINE_LENGTH + 1 });
const modelStub = () =>
  ({
    uri: { toString: () => 'file:///a.ERB' },
    getLineCount: () => 20,
    getLineMaxColumn: () => LINE_LENGTH + 1,
    // 代理对边界修正只在这条腿被喂行文本时启用（本桩全 BMP ⇒ 结果与旧口径逐字一致）
    getLineContent: () => '  @FOO_BAR(x'.padEnd(LINE_LENGTH, ' '),
    getWordAtPosition: () => ({ startColumn: 6, endColumn: 13 }),
  }) as unknown as Monaco.editor.ITextModel;

/** 一次落点（对拍比的就是这三元组） */
type Landing = { line: number; columnStart: number; columnEnd: number };
const landingOf = (payload: { line?: number; column?: number; span?: KernelEventMap['editor.revealLocation']['span'] }): Landing => {
  const landed = clampRevealPosition(revealTargetOf(payload, 1), geometryFor());
  return { line: landed.lineNumber, columnStart: landed.column, columnEnd: landed.columnEnd };
};
const linkLandingOf = (range: Monaco.IRange | undefined): Landing => {
  if (!range) throw new Error('没有 targetSelectionRange');
  return { line: range.startLineNumber, columnStart: range.startColumn, columnEnd: range.endColumn };
};

/** 同一条位置事实的六种写法（同一处：第 8 行第 3-11 列那个名字） */
const LINE = 8;
const START = 3;
const END = 11;
const PATH = 'C:/p/a.ERB';

const definitionLocation: DefinitionLocation = {
  filePath: PATH,
  line: LINE,
  column: START,
  span: { columnStart: START, columnEnd: END },
};

const searchMatch: SearchMatch = {
  line: LINE,
  column: START,
  preview: '  @FOO_BAR(1) ; pad pad',
  start: START - 1, // preview 里命中起点（0 基）
  end: END - 1, // preview 里命中终点（0 基，不含）
};

const problem: EditorProblem = {
  path: PATH,
  line: LINE,
  span: { columnStart: START, columnEnd: END },
  severity: 'error',
  message: '结构不闭合',
};

/** 只有行级信息的一条（老装饰器 / 行级 error 就是这个形状：没有区间，只有行） */
const bareProblem: EditorProblem = { path: PATH, line: LINE, severity: 'error', message: '结构不闭合' };

/**
 * 六个发起方各自的**真实出口**（面板给区间、定义/实现给链接或载荷、G1 给 locate）。
 */
function allLegs(): Record<string, Landing> {
  const model = modelStub();
  const findModel = () => model;

  // ① 定义 · Peek 腿
  const peekLink = toDefinitionLinks([definitionLocation], findModel)[0]!;
  // ② 定义 · 事件通道腿（宿主拿同一个目标发总线）
  const navigatePayload = revealLocationOf({ path: PATH, line: LINE, column: START, span: definitionLocation.span }, '转到定义');
  // ③ 跳到实现 · 与②同一个核
  const viaImplementation = implementationLanding(definitionLocation);
  // ④ 问题面板
  const problemPayload = revealLocationOf({ path: PATH, line: LINE, span: problemRevealSpan(problem) }, '问题');
  // ⑤ 检索面板
  const searchPayload = revealLocationOf({ path: PATH, line: searchMatch.line, span: searchMatchSpan(searchMatch) }, '检索');
  // ⑥ G1 回放跳转（locate 与 revealLocation 是同一种位点的两种写法）
  const plan = planJumpToState({
    path: PATH,
    line: LINE,
    column: START,
    span: { columnStart: START, columnEnd: END },
    symbols: [{ name: 'FOO_BAR', kind: 'function', startLine: LINE, endLine: 20 }],
    derivedView: false,
  });
  if (plan.kind !== 'replay') throw new Error('G1 没有兑现：' + plan.message);
  const locate = plan.intent.locate;

  return {
    '定义·Peek腿': linkLandingOf(peekLink.targetSelectionRange),
    '定义·事件腿': landingOf(navigatePayload),
    '跳到实现': viaImplementation,
    '问题面板': landingOf(problemPayload),
    '检索面板': landingOf(searchPayload),
    'G1回放': landingOf({ line: locate.line, column: locate.column, span: locate.span }),
  };
}

/** 经 ImplementationProvider 走一遍真实腿：目标没开标签 ⇒ 事件通道载荷（带区间） */
function implementationLanding(location: DefinitionLocation): Landing {
  const registered: Monaco.languages.ImplementationProvider[] = [];
  const monaco = {
    languages: {
      registerImplementationProvider: (_id: string, provider: Monaco.languages.ImplementationProvider) => {
        registered.push(provider);
        return { dispose: () => undefined };
      },
    },
  } as unknown as typeof Monaco;
  const sent: KernelEventMap['editor.revealLocation'][] = [];
  installImplementationProvider(monaco, {
    resolve: () => [location],
    navigate: (target) =>
      sent.push(
        revealLocationOf(
          { path: target.filePath, line: target.line, column: target.column, span: target.span },
          '跳到实现',
        ),
      ),
    openModelFor: () => undefined, // 没开标签 ⇒ 走事件通道（这条腿的产物就是载荷）
  });
  registered[0]!.provideImplementation(modelStub(), { lineNumber: 2, column: 7 } as Monaco.Position, {
    isCancellationRequested: false,
  } as Monaco.CancellationToken);
  if (sent.length !== 1) throw new Error(`跳到实现没有发事件（实际 ${sent.length} 次）`);
  return landingOf(sent[0]!);
}

describe('W9 判据①：同一处位置，六条腿落同一个三元组', () => {
  it('定义 / 实现 / 问题 / 检索 / G1 全部给出 (8, 3, 11)', () => {
    const legs = allLegs();
    const expected = { line: LINE, columnStart: START, columnEnd: END };
    for (const [name, landing] of Object.entries(legs)) {
      expect({ leg: name, landing }).toEqual({ leg: name, landing: expected });
    }
  });

  it('检索面板的区间宽度来自命中本身（`end - start`），不是"顺手选一个词"', () => {
    expect(searchMatchSpan(searchMatch)).toEqual({ columnStart: START, columnEnd: END });
  });

  it('区间超过行长 ⇒ 六条腿一起夹到同一处（夹取判据只有一份）', () => {
    const over = { filePath: PATH, line: LINE, column: START, span: { columnStart: START, columnEnd: 9_999 } };
    const link = toDefinitionLinks([over], () => modelStub())[0]!;
    const viaLink = linkLandingOf(link.targetSelectionRange);
    const viaBus = landingOf(revealLocationOf({ path: PATH, line: LINE, column: START, span: over.span }));
    expect(viaLink).toEqual(viaBus);
    expect(viaLink.columnEnd).toBe(LINE_LENGTH + 1);
  });
});

describe('W9 判据②：span 缺失的退化显式且唯一（零宽落点）', () => {
  it('六条腿都没有列信息 ⇒ 全部 (8, 1, 1)', () => {
    const model = modelStub();
    const bare: DefinitionLocation = { filePath: PATH, line: LINE };
    const viaLink = linkLandingOf(toDefinitionLinks([bare], () => model)[0]!.targetSelectionRange);
    const legs = {
      '定义·Peek腿': viaLink,
      '定义·事件腿': landingOf(revealLocationOf({ path: PATH, line: LINE })),
      '问题面板': landingOf(revealLocationOf({ path: PATH, line: LINE, span: problemRevealSpan(bareProblem) })),
      'G1回放': (() => {
        const plan = planJumpToState({
          path: PATH,
          line: LINE,
          symbols: [{ name: 'FOO_BAR', kind: 'function', startLine: LINE, endLine: 20 }],
          derivedView: false,
        });
        if (plan.kind !== 'replay') throw new Error('G1 没兑现');
        return landingOf({ line: plan.intent.locate.line, column: plan.intent.locate.column, span: plan.intent.locate.span });
      })(),
    };
    const expected = { line: LINE, columnStart: 1, columnEnd: 1 };
    for (const [name, landing] of Object.entries(legs)) {
      expect({ leg: name, landing }).toEqual({ leg: name, landing: expected });
    }
  });

  it('只有列没有区间 ⇒ 零宽（光标放到那一列，**不**铺到行尾、**不**选整词）', () => {
    const landing = landingOf(revealLocationOf({ path: PATH, line: LINE, column: START }));
    expect(landing).toEqual({ line: LINE, columnStart: START, columnEnd: START });
    const link = toDefinitionLinks([{ filePath: PATH, line: LINE, column: START }], () => modelStub())[0]!;
    expect(linkLandingOf(link.targetSelectionRange)).toEqual(landing);
    // 列表里显示的**行上下文**仍然是整行（选区与显示行是两件事）
    expect(link.range).toEqual({
      startLineNumber: LINE,
      startColumn: 1,
      endLineNumber: LINE,
      endColumn: LINE_LENGTH + 1,
    });
  });

  it('坏区间（反向 / NaN）与没给区间退到同一档，不产生第三种答案', () => {
    const bad = landingOf(revealLocationOf({ path: PATH, line: LINE, span: { columnStart: 12, columnEnd: 4 } }));
    expect(bad).toEqual({ line: LINE, columnStart: 1, columnEnd: 1 });
    const nan = landingOf(
      revealLocationOf({ path: PATH, line: LINE, span: { columnStart: Number.NaN, columnEnd: Number.NaN } }),
    );
    expect(nan).toEqual(bad);
  });

  it('面板回调的第三位在两条面板上都是同一个类型，第四位是焦点选项（additive）', () => {
    const span = { columnStart: START, columnEnd: END };
    const seen: (number | undefined)[][] = [];
    const foci: (boolean | undefined)[] = [];
    const onReveal: SearchPanelProps['onReveal'] = (path, line, s, options) => {
      seen.push([line, s?.columnStart, s?.columnEnd]);
      foci.push(options?.focus);
      expect(path).toBe(PATH);
    };
    onReveal(PATH, LINE, span);
    onReveal(PATH, LINE, span, { focus: false });
    expect(seen).toEqual([
      [LINE, START, END],
      [LINE, START, END],
    ]);
    // 老调用不传 ⇒ undefined（现行聚焦行为）；键盘逐项跳传 false
    expect(foci).toEqual([undefined, false]);
    expect(onReveal.length).toBeLessThanOrEqual(4); // 第四位是 W7-B 的焦点选项，没有第五位
  });
});

/* ============================== 判据①补腿：引用 / 行上注解（W9 接力批） ============================== */

/** 同一个位置事实的引用写法（供方 `erb-parser/references.ts` 给得出 span 时的形状） */
const referenceLocation: ReferenceLocation = {
  filePath: PATH,
  line: LINE,
  column: START,
  span: { columnStart: START, columnEnd: END },
  kind: 'call',
};

const refContribution: EditorLanguageServiceContribution = {
  id: 'ref-stub',
  order: 20,
  provide: (request) =>
    request.kind === 'references'
      ? { kind: 'references', locations: [referenceLocation] }
      : undefined,
} as EditorLanguageServiceContribution;

const REF_REQ = {
  kind: 'references',
  path: PATH,
  text: '',
  line: 1,
  column: 1,
  project: null,
} as const;

/** 桩 monaco（引用腿）：记 provider 与 opener（同 find-references.test.ts 口径） */
function stubReferenceMonaco() {
  const providers: Monaco.languages.ReferenceProvider[] = [];
  let opener: Monaco.editor.ICodeEditorOpener | undefined;
  const monaco = {
    languages: {
      registerReferenceProvider: (_id: string, provider: Monaco.languages.ReferenceProvider) => {
        providers.push(provider);
        return { dispose: () => undefined };
      },
    },
    editor: {
      registerEditorOpener: (o: Monaco.editor.ICodeEditorOpener) => {
        opener = o;
        return { dispose: () => undefined };
      },
    },
    Uri: { file: (p: string) => ({ toString: () => `file:///${p.replace(/\\/g, '/')}` }) },
  } as unknown as typeof Monaco;
  return { monaco, providers, get opener() { return opener; } };
}

describe('W9 判据①补腿：引用与行上注解也落同一个三元组', () => {
  it('引用 · Peek 腿（已开文件）：range 经 `clampRevealPosition` 带真实区间，与定义腿同判据', () => {
    const stub = stubReferenceMonaco();
    installReferenceProvider(stub.monaco, {
      resolve: () => collectReferenceLocations([refContribution], REF_REQ),
      navigate: () => undefined,
      openModelFor: () => modelStub(),
    });
    const refs = stub.providers[0]!.provideReferences!(
      modelStub(),
      { lineNumber: 1, column: 6 } as Monaco.Position,
      {} as Monaco.languages.ReferenceContext,
      { isCancellationRequested: false } as Monaco.CancellationToken,
    ) as Monaco.languages.Location[];
    expect(refs).toHaveLength(1);
    expect({ line: refs[0]!.range.startLineNumber, columnStart: refs[0]!.range.startColumn, columnEnd: refs[0]!.range.endColumn }).toEqual({
      line: LINE,
      columnStart: START,
      columnEnd: END,
    });
  });

  it('引用 · 事件通道腿（未开文件）：navigate 收到带区间的目标，载荷与其余腿同三元组', () => {
    const stub = stubReferenceMonaco();
    const sent: KernelEventMap['editor.revealLocation'][] = [];
    installReferenceProvider(stub.monaco, {
      resolve: () => collectReferenceLocations([refContribution], REF_REQ),
      navigate: (location) =>
        sent.push(
          revealLocationOf(
            { path: location.filePath, line: location.line, column: location.column, span: location.span },
            '查找引用',
          ),
        ),
      openModelFor: () => undefined,
    });
    stub.providers[0]!.provideReferences!(
      modelStub(),
      { lineNumber: 1, column: 6 } as Monaco.Position,
      {} as Monaco.languages.ReferenceContext,
      { isCancellationRequested: false } as Monaco.CancellationToken,
    );
    // 未开文件的 URI 走本模块自己的 opener（点击兜底腿）
    expect(sent).toHaveLength(0);
    const landed = stub.opener!.openCodeEditor(
      modelStub() as unknown as Monaco.editor.ICodeEditor,
      { toString: () => `file:///${PATH.replace(/\\/g, '/')}` } as Monaco.Uri,
      { startLineNumber: LINE, startColumn: START, endLineNumber: LINE, endColumn: END },
    );
    expect(landed).toBe(true);
    expect(sent).toHaveLength(1);
    // 夹取仍归落地腿（App→编辑器），发起侧交原样区间 ⇒ 经同一个夹取函数后与六条腿一致
    expect(landingOf(sent[0]!)).toEqual({ line: LINE, columnStart: START, columnEnd: END });
  });

  it('引用合并：同位两枚（一枚带 span 一枚不带）不抹掉区间，与定义合并同口径', () => {
    const merged = collectReferenceLocations(
      [
        { id: 'a', order: 20, provide: () => ({ kind: 'references', locations: [{ filePath: PATH, line: LINE, column: START }] }) },
        refContribution,
      ] as unknown as EditorLanguageServiceContribution[],
      REF_REQ,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.span).toEqual({ columnStart: START, columnEnd: END });
  });

  it('引用缺 span 的退化与其余腿同档（裸 column ⇒ 零宽；什么都没有 ⇒ 行首，不猜终点）', () => {
    const stub = stubReferenceMonaco();
    installReferenceProvider(stub.monaco, {
      resolve: () => [
        { filePath: PATH, line: LINE, column: START },
        { filePath: 'C:/p/b.ERB', line: LINE },
      ],
      navigate: () => undefined,
      openModelFor: () => modelStub(),
    });
    const refs = stub.providers[0]!.provideReferences!(
      modelStub(),
      { lineNumber: 1, column: 6 } as Monaco.Position,
      {} as Monaco.languages.ReferenceContext,
      { isCancellationRequested: false } as Monaco.CancellationToken,
    ) as Monaco.languages.Location[];
    expect({ columnStart: refs[0]!.range.startColumn, columnEnd: refs[0]!.range.endColumn }).toEqual({
      columnStart: START,
      columnEnd: START, // 裸 column = 零宽，与 `revealSpanOf` 第 2 档逐字一致
    });
    expect({ columnStart: refs[1]!.range.startColumn, columnEnd: refs[1]!.range.endColumn }).toEqual({
      columnStart: 1,
      columnEnd: 1, // 什么都没给 = 行首，与问题面板那枚"只有行"的老装饰同档
    });
  });

  it('行上注解：target 的区间原样穿过命令参数到达 navigate（宿主不截窄），载荷同三元组', () => {
    let commandFn: ((accessor: unknown, ...args: unknown[]) => void) | undefined;
    const navigated: ReferenceLocation[] = [];
    const monaco = {
      languages: { registerCodeLensProvider: () => ({ dispose: () => undefined }) },
      editor: {
        registerCommand: (id: string, fn: (accessor: unknown, ...args: unknown[]) => void) => {
          if (id === CODE_LENS_COMMAND) commandFn = fn;
          return { dispose: () => undefined };
        },
      },
    } as unknown as typeof Monaco;
    const lens: EditorCodeLens = { line: LINE, label: '被 3 处用到', target: referenceLocation };
    installCodeLensProvider(monaco, {
      resolve: () => [lens],
      navigate: (target) => navigated.push(target as ReferenceLocation),
    });
    expect(commandFn).toBeTypeOf('function');
    commandFn!({}, referenceLocation); // Monaco 的调用形状：accessor 打头，命令参数原样是发出去的那枚对象
    expect(navigated).toHaveLength(1);
    const target = navigated[0]!;
    expect(target.span).toEqual({ columnStart: START, columnEnd: END });
    expect(
      landingOf(revealLocationOf({ path: target.filePath, line: target.line, column: target.column, span: target.span }, '行上注解')),
    ).toEqual({ line: LINE, columnStart: START, columnEnd: END });
  });
});

/* ============================== 宿主发射腿：两块内建面板不许各拼一份载荷 ============================== */

/**
 * 判据①的**接线**守卫：`revealLocationOf` 是发起侧唯一的载荷出口，而 `ProjectView`
 * 正是问题面板 / 检索面板两条腿的装配点。钉的是"span 有没有一路带到总线"——
 * 列在半路丢了，点问题落在行首、同一处按 F12 落在名字那一列（W9 要杀的那句谎）。
 */
describe('W9 判据① · ProjectView 的两条面板腿都只经 revealLocationOf', () => {
  const projectViewSource = async (): Promise<string> => {
    const { readFileSync } = await import('node:fs');
    return readFileSync(new URL('../src/ui/ProjectView.tsx', import.meta.url), 'utf8')
      .split('\n')
      .filter((line: string) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
  };

  it('每一处 `editor.revealLocation` 发射都经 revealLocationOf（没有手拼的第三种形状）', async () => {
    const code = await projectViewSource();
    const emissions = [...code.matchAll(/emit\(\s*'editor\.revealLocation'[\s\S]{0,200}/g)].map((m) => m[0]);
    expect(emissions.length).toBeGreaterThanOrEqual(2);
    for (const emission of emissions) expect(emission).toContain('revealLocationOf(');
  });

  it('问题面板把面板给的列区间转交总线（source 仍是「问题」）', async () => {
    const code = await projectViewSource();
    expect(code).toMatch(/onReveal=\{\(path, line, span\)[\s\S]{0,160}revealLocationOf\(\{ path, line, span \}, '问题'\)/);
  });

  it('检索面板不再自己折列：`column: span.columnStart` 这第二份折法已经消失', async () => {
    const code = await projectViewSource();
    expect(code).not.toMatch(/column:\s*span\.columnStart/);
    // W7-B：键盘逐项跳的焦点选项也走这个出口（`focus` 与落点同一份载荷）
    expect(code).toMatch(/revealLocationOf\(\{ path, line, span, focus: options\?\.focus \}, '搜索'\)/);
  });
});
