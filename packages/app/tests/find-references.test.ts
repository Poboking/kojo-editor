/**
 * 查找所有引用（`find-references.ts`）单测——**不依赖真 Monaco**。
 *
 * 纯逻辑腿：多贡献方合并的隔离（单个抛错不影响其余）与去重（文件+行列键）。
 * Monaco 绑定腿：桩 monaco（`registerReferenceProvider` / `registerEditorOpener` /
 * `Uri.file`）+ 桩 model，钉死三条腿的行为契约：
 * (a) 已打开文件用真 model 的 uri（Peek 预览与就地跳的数据源）；
 * (b) 未打开文件发 file URI（ReferencesModel 逐条 catch，树项保留、计数不说谎），
 *     且点击经本模块的 opener 落回 `navigate` 通道；
 * (c) 已打开文件的 URI **不进** opener 反查表（不抢 kojo-definition opener 的活）。
 *
 * W8 XLANG-RENAME 追加（判据④）：出现点**分类随位置穿过槽**（`EditorSymbolLocation.kind`），
 * F12 的"N 处"与「被调用 M 处」在**同一份** tally 上读数、差值可解释，
 * 同位多方上报取最具体分类，且旧消费方看到的位置形状零改动。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { EditorLanguageServiceContribution, EditorSymbolLocation, ErbFunction, ErbIndex, ErbReference } from '@kojo/plugin-api';
import {
  collectReferenceLocations,
  collectReferenceReport,
  installReferenceProvider,
  KNOWN_PATHS_LIMIT,
} from '../src/monaco/find-references';
import { incomingCalls, outgoingCalls } from '../src/monaco/erb-call-hierarchy';
import { erbOccurrences, explainReferenceCounts, tallyReferenceOccurrences } from '../src/ui/reference-utils';

/* ============================== 纯逻辑：合并与去重 ============================== */

const contributionOf = (
  id: string,
  locations: readonly EditorSymbolLocation[],
  boom = false,
): EditorLanguageServiceContribution => ({
  id,
  order: 20,
  provide: (request) => {
    if (request.kind !== 'references') return undefined;
    if (boom) throw new Error(id + ' 炸了');
    return { kind: 'references', locations };
  },
});

describe('collectReferenceLocations', () => {
  it('按槽序合并；同文件同行同列去重', () => {
    const locations = collectReferenceLocations(
      [
        contributionOf('a', [
          { filePath: '/t/A.ERB', line: 1, column: 2 },
          { filePath: '/t/B.ERB', line: 3 },
        ]),
        contributionOf('b', [{ filePath: '/t/A.ERB', line: 1, column: 2 }]),
      ],
      { kind: 'references', path: '/t/A.ERB', text: '', line: 1, column: 1, project: null },
    );
    expect(locations).toEqual([
      { filePath: '/t/A.ERB', line: 1, column: 2 },
      { filePath: '/t/B.ERB', line: 3 },
    ]);
  });

  it('单个贡献方抛错不影响其余（隔离：能力退化可见，不让整条查找消失）', () => {
    const locations = collectReferenceLocations(
      [
        contributionOf('bad', [], true),
        contributionOf('good', [{ filePath: '/t/A.ERB', line: 1 }]),
      ],
      { kind: 'references', path: '/t/A.ERB', text: '', line: 1, column: 1, project: null },
    );
    expect(locations).toEqual([{ filePath: '/t/A.ERB', line: 1 }]);
  });
});

/* ============================== Monaco 绑定腿（桩） ============================== */

interface Stub {
  providers: { languageId: string; provider: Monaco.languages.ReferenceProvider }[];
  monaco: typeof Monaco;
  readonly opener: Monaco.editor.ICodeEditorOpener | undefined;
}

function stubMonaco(): Stub {
  const providers: Stub['providers'] = [];
  let openerRef: Monaco.editor.ICodeEditorOpener | undefined;
  const monaco = {
    languages: {
      registerReferenceProvider: (languageId: string, provider: Monaco.languages.ReferenceProvider) => {
        providers.push({ languageId, provider });
        return { dispose: () => undefined };
      },
    },
    editor: {
      registerEditorOpener: (o: Monaco.editor.ICodeEditorOpener) => {
        openerRef = o;
        return { dispose: () => undefined };
      },
    },
    Uri: {
      file: (p: string) => ({ fsPath: p, toString: () => `file:///${p.replace(/\\/g, '/')}` }),
    },
  } as unknown as typeof Monaco;
  return { providers, monaco, get opener() { return openerRef; } };
}

function modelOf(path: string, lines: readonly string[]): Monaco.editor.ITextModel {
  return {
    uri: { fsPath: path, toString: () => `file:///${path.replace(/\\/g, '/')}` } as Monaco.Uri,
    getLineCount: () => lines.length,
    getLineContent: (n: number) => lines[n - 1] ?? '',
    // W9：引用腿的夹取经 `clampRevealPosition`（与定义腿同一个函数），它按 Monaco
    // 口径问 `getLineMaxColumn`（行长 + 1，UTF-16 码元）——桩必须给真口径，不许糊
    getLineMaxColumn: (n: number) => (lines[n - 1]?.length ?? 0) + 1,
  } as unknown as Monaco.editor.ITextModel;
}

const AT = (lineNumber: number, column: number): Monaco.Position => ({ lineNumber, column }) as Monaco.Position;

const LOCATIONS: readonly EditorSymbolLocation[] = [
  { filePath: '/t/A.ERB', line: 1, column: 6 },
  { filePath: '/t/B.ERB', line: 4, column: 8 },
];

describe('installReferenceProvider', () => {
  it('为 ERB 与 .kojo 两种语言 id 注册同一 provider', () => {
    const stub = stubMonaco();
    installReferenceProvider(stub.monaco, { resolve: () => [], navigate: () => undefined });
    expect(stub.providers.map((p) => p.languageId).sort()).toEqual(['kojo-erb', 'kojo-sugar']);
  });

  it('已打开文件用真 model 的 uri；未打开文件发 file URI 且不进 opener 反查表', () => {
    const stub = stubMonaco();
    const openB = modelOf('/t/B.ERB', ['x', 'y', 'z']);
    installReferenceProvider(stub.monaco, {
      resolve: () => LOCATIONS,
      navigate: () => undefined,
      openModelFor: (p) => (p === '/t/B.ERB' ? openB : undefined),
    });
    const provider = stub.providers[0]!.provider;
    const out = provider.provideReferences!(modelOf('/t/A.ERB', ['CALL ALPHA']), AT(1, 6), {} as Monaco.languages.ReferenceContext, {} as Monaco.CancellationToken) as Monaco.languages.Location[];
    expect(out).toHaveLength(2);
    expect(out[0]!.uri.toString()).toBe('file:////t/A.ERB'); // 未打开 → file URI（Peek 物化逐条 catch，树项保留）
    expect(out[1]!.uri.toString()).toBe('file:////t/B.ERB');
  });

  it('未打开文件的引用点击 → opener 反查路径 → navigate（跨文件跳转可达）', () => {
    const stub = stubMonaco();
    const navigated: EditorSymbolLocation[] = [];
    installReferenceProvider(stub.monaco, {
      resolve: () => LOCATIONS,
      navigate: (l) => navigated.push(l),
      openModelFor: () => undefined,
    });
    const provider = stub.providers[0]!.provider;
    provider.provideReferences!(modelOf('/t/A.ERB', ['CALL ALPHA']), AT(1, 6), {} as Monaco.languages.ReferenceContext, {} as Monaco.CancellationToken);
    const landed = stub.opener!.openCodeEditor(
      modelOf('/t/A.ERB', ['CALL ALPHA']) as unknown as Monaco.editor.ICodeEditor,
      { toString: () => 'file:////t/B.ERB' } as Monaco.Uri,
      { lineNumber: 4, column: 8 },
    );
    expect(landed).toBe(true);
    expect(navigated).toEqual([{ filePath: '/t/B.ERB', line: 4, column: 8 }]);
  });

  it('不是本 provider 发过的 URI → opener 返回 false（不抢别人的请求）', () => {
    const stub = stubMonaco();
    installReferenceProvider(stub.monaco, { resolve: () => [], navigate: () => undefined });
    const landed = stub.opener!.openCodeEditor(
      modelOf('/t/A.ERB', ['x']) as unknown as Monaco.editor.ICodeEditor,
      { toString: () => 'file:////other.ERB' } as Monaco.Uri,
      { lineNumber: 1, column: 1 },
    );
    expect(landed).toBe(false);
  });

  it('resolve 抛错 ⇒ undefined（不让 Shift+F12 崩编辑器）', () => {
    const stub = stubMonaco();
    installReferenceProvider(stub.monaco, {
      resolve: () => {
        throw new Error('宿主炸了');
      },
      navigate: () => undefined,
    });
    const provider = stub.providers[0]!.provider;
    const out = provider.provideReferences!(modelOf('/t/A.ERB', ['x']), AT(1, 1), {} as Monaco.languages.ReferenceContext, {} as Monaco.CancellationToken);
    expect(out).toBeUndefined();
  });

  it('opener 反查表有 LRU 上限：整会话只增不减 = 无界表 + 换项目后的陈旧路由', () => {
    const stub = stubMonaco();
    const navigated: EditorSymbolLocation[] = [];
    installReferenceProvider(stub.monaco, {
      resolve: () => Array.from({ length: KNOWN_PATHS_LIMIT + 10 }, (_, i) => ({
        filePath: `/t/f${String(i).padStart(4, '0')}.ERB`,
        line: 1,
      })),
      navigate: (l) => navigated.push(l),
      openModelFor: () => undefined, // 全部未打开 ⇒ 全部进反查表
    });
    const provider = stub.providers[0]!.provider;
    const locations = provider.provideReferences!(
      modelOf('/t/A.ERB', ['CALL ALPHA']),
      AT(1, 6),
      {} as Monaco.languages.ReferenceContext,
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.Location[];
    expect(locations).toHaveLength(KNOWN_PATHS_LIMIT + 10);
    const editor = modelOf('/t/A.ERB', ['x']) as unknown as Monaco.editor.ICodeEditor;
    const at = { lineNumber: 1, column: 1 };
    // 最旧的 10 条被淘汰：点击不再被接到（可能属于已切换走的）旧项目的落点
    expect(stub.opener!.openCodeEditor(editor, locations[0]!.uri, at)).toBe(false);
    // 队尾的仍在表里：正常路由
    const last = locations[locations.length - 1]!;
    expect(stub.opener!.openCodeEditor(editor, last.uri, at)).toBe(true);
    expect(navigated).toEqual([{ filePath: `/t/f${String(KNOWN_PATHS_LIMIT + 9).padStart(4, '0')}.ERB`, line: 1, column: 1 }]);
  });
});

/* ============================== W8：分类随位置穿槽，计数与列表同源 ============================== */

/** 带分类的贡献方（真源是 `erb-parser/references.ts` 的 `erbReferenceLocationsAt`） */
const kindedContribution = (
  id: string,
  locations: readonly EditorSymbolLocation[],
): EditorLanguageServiceContribution => ({
  id,
  order: 20,
  provide: (request) => (request.kind === 'references' ? { kind: 'references', locations } : undefined),
});

const REQ = { kind: 'references', path: '/t/A.ERB', text: '', line: 1, column: 6, project: null } as const;

describe('collectReferenceReport（计数与列表同源）', () => {
  it('F12 的 N 与「被调用」的 M 出自同一份 tally，差值一句话可解释', () => {
    const report = collectReferenceReport(
      [
        kindedContribution('erb-references', [
          { filePath: '/t/A.ERB', line: 1, column: 2, kind: 'definition' },
          { filePath: '/t/B.ERB', line: 4, column: 8, kind: 'call' },
          { filePath: '/t/B.ERB', line: 9, column: 5, kind: 'call' },
          { filePath: '/t/C.ERB', line: 2, column: 7, kind: 'mention' },
        ]),
      ],
      { ...REQ },
    );
    expect(report.locations).toHaveLength(4);
    expect(report.tally.f12Count).toBe(4);
    expect(report.tally.callSiteCount).toBe(2);
    expect(report.tally.gap).toBe(2); // = 定义 1 + 提及 1，不是"丢了 2 处"
    expect(report.explanation).toContain('共 4 处出现');
    expect(report.explanation).toContain('少 2 处');
    expect(report.answeredBy).toEqual(['erb-references']);
  });

  it('同位多方上报：分类取最具体的一侧，位置形状不变（旧消费方零改动）', () => {
    const report = collectReferenceReport(
      [
        kindedContribution('a', [{ filePath: '/t/A.ERB', line: 7, column: 3 }]),
        kindedContribution('b', [{ filePath: '/t/A.ERB', line: 7, column: 3, kind: 'call' }]),
      ],
      { ...REQ },
    );
    expect(report.locations).toEqual([{ filePath: '/t/A.ERB', line: 7, column: 3, kind: 'call' }]);
    expect(report.tally.total).toBe(1);
    expect(report.tally.callSiteCount).toBe(1);
  });

  it('供方没给分类 ⇒ unclassified（不猜成 call，面板读数不虚高）', () => {
    const report = collectReferenceReport(
      [kindedContribution('sugar', [{ filePath: '/t/A.kojo', line: 3, column: 4 }])],
      { ...REQ },
    );
    expect(report.tally.unclassified).toBe(1);
    expect(report.tally.callSiteCount).toBe(0);
    expect(report.tally.kojoCount).toBe(1);
  });

  it('collectReferenceLocations 仍是同一份读数的位置投影（两条腿不可能分叉）', () => {
    const contributions = [
      kindedContribution('a', [
        { filePath: '/t/A.ERB', line: 1, column: 2, kind: 'definition' },
        { filePath: '/t/B.ERB', line: 4, column: 8, kind: 'call' },
      ]),
    ];
    const locations = collectReferenceLocations(contributions, { ...REQ });
    expect(locations).toEqual(collectReferenceReport(contributions, { ...REQ }).locations);
  });

  it('没有任何贡献方应答 ⇒ answeredBy 空（"没人答"与"答了但无引用"分得开）', () => {
    const report = collectReferenceReport([{ id: 'na', order: 20, provide: () => undefined }], { ...REQ });
    expect(report.answeredBy).toEqual([]);
    expect(report.tally.total).toBe(0);
  });
});

describe('installReferenceProvider 的读数出口（onTally）', () => {
  it('列表与读数一次算出：宿主拿到的是同一份 tally 与解释', () => {
    const stub = stubMonaco();
    const seen: Array<[number, number]> = [];
    installReferenceProvider(stub.monaco, {
      resolve: () => [
        { filePath: '/t/A.ERB', line: 1, column: 2, kind: 'definition' },
        { filePath: '/t/B.ERB', line: 4, column: 8, kind: 'call' },
      ],
      navigate: () => undefined,
      onTally: (tally) => seen.push([tally.f12Count, tally.callSiteCount]),
    });
    const provider = stub.providers[0]!.provider;
    const out = provider.provideReferences!(
      modelOf('/t/A.ERB', ['x']),
      AT(1, 1),
      {} as Monaco.languages.ReferenceContext,
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.Location[];
    expect(out).toHaveLength(2);
    expect(seen).toEqual([[2, 1]]); // 与列表同一次计算，不是第二份计数
  });

  it('onTally 抛错不影响列表交付（读数是附加面，不是主链路）', () => {
    const stub = stubMonaco();
    installReferenceProvider(stub.monaco, {
      resolve: () => LOCATIONS,
      navigate: () => undefined,
      onTally: () => {
        throw new Error('面板炸了');
      },
    });
    const provider = stub.providers[0]!.provider;
    const out = provider.provideReferences!(
      modelOf('/t/A.ERB', ['x']),
      AT(1, 1),
      {} as Monaco.languages.ReferenceContext,
      {} as Monaco.CancellationToken,
    );
    expect(out).toHaveLength(LOCATIONS.length);
  });
});

/* ============================== 判据②：出现点口径只剩一份（F12 读数 vs 调用层级读数对拍） ============================== */

/**
 * 「这个名字出现在哪」的计数**必须**是一个数据结构的两枚投影：
 * F12/Peek 走 `collectReferenceReport` 的台账，调用层级面板走 `erb-call-hierarchy` 的
 * 入边/出边集——两者读的必须是同一份 `ErbReference.kind`（判据真源在
 * `erb-parser/references.ts`），数字必须相等，差值必须叫得出名字。
 * 这条对拍钉的就是"面板各数一遍"永远回不来。
 */
describe('F12 台账读数与调用层级读数同源对拍', () => {
  const A = '/t/A.ERB';
  const B = '/t/B.ERB';
  const REFS: ErbReference[] = [
    { filePath: A, line: 1, column: 2, endColumn: 5, kind: 'definition' },
    { filePath: A, line: 30, column: 6, endColumn: 9, kind: 'call' },
    { filePath: B, line: 5, column: 1, endColumn: 4, kind: 'call' },
    { filePath: B, line: 9, column: 5, endColumn: 8, kind: 'mention' },
  ];
  const CALLER = { normalizedName: 'CALLER_X', name: 'CALLER_X', filePath: A, startLine: 20, endLine: 60 } as unknown as ErbFunction;
  const index = {
    byName: new Map([['FOO', [CALLER]]]),
    files: new Map<string, unknown>(),
    references: { bySymbol: new Map([['FOO', REFS]]) },
  } as unknown as ErbIndex;

  it('面板的「被调用 N 处」= tally 的非定义位投影（不是第三次计数）', () => {
    const tally = tallyReferenceOccurrences(erbOccurrences(REFS));
    const incoming = incomingCalls(index, () => CALLER, 'FOO');
    const panelCount = incoming.reduce((n, g) => n + g.sites.length, 0);
    expect(panelCount).toBe(tally.nonDefinitionCount); // 3 = 定义以外的一切出现点
    expect(tally.nonDefinitionCount).toBe(3);
    expect(tally.callSiteCount).toBe(2); // 其中 CALL 直系族
    expect(tally.f12Count).toBe(4); // F12 看到的总数
    // 差值一句话必须把这三个数都点名，作者不必自己减
    const text = explainReferenceCounts(tally);
    expect(text).toContain('非定义位 3 处');
    expect(text).toContain('CALL 直系族 2 处');
    expect(text).toContain('少 2 处');
  });

  it('出边只数 CALL 直系族（与 callSiteCount 同一判据，不另起一份正则）', () => {
    const tally = tallyReferenceOccurrences(erbOccurrences(REFS));
    const outgoing = outgoingCalls(index, { filePath: A, startLine: 1, endLine: 40 });
    const sites = outgoing.reduce((n, g) => n + g.sites.length, 0);
    expect(sites).toBe(1); // A 文件区间内的 CALL 槽只有一处（B 的两处不归本函数）
    expect(outgoing.every((g) => g.sites.every((s) => s.kind === 'call'))).toBe(true);
    expect(tally.callSiteCount).toBe(2); // 直系族全集（跨文件）
  });
});
