/**
 * LAU-6 `@原生` 注入的闸（§4.6 / D14）。
 *
 * 四块，各钉一条主张：
 * 1. **区间口径写死**（LAU-6a 探针的 ④）：整行对齐 + 末行换行收口 + EOF 补虚拟换行；
 *    任何"按节点原始区间""按任意字节切"的写法都必须被这里挡回去；
 * 2. **宿主零节点名**：`injectionHostNodes` 只按 descriptor 的 `hostNode` 等值匹配，
 *    `native_body` 字面量在 `packages/app/src/monaco/` 里只许出现在声明处（DoD 4 的 grep 闸）；
 * 3. **零请求 / 失败不拖垮**：没有宿主节点 ⇒ 注入执行器一次都不调；子树失败 ⇒ 主树
 *    token 原样 + 一条 `core/injection/child-failed`；
 * 4. **探针口径回归**：真 wasm（kojo2 主树 + ERB 子解析）跑三个语境（基础 / `[SKIPSTART]`
 *    嵌套 / 深缩进），断言 ERROR=0、坐标绝对、注释与指令有档位、IF…ENDIF 出折叠。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STRUCTURE_PROTOCOL_VERSION } from '@kojo/kojo-core';
import type * as Monaco from '../src/monaco/entry';
import {
  KOJO2_CAPTURE_TOKEN_TYPES,
  KOJO2_SEMANTIC_TOKEN_TYPES,
  createKojo2SemanticTokensProvider,
  injectionHostNodes,
  injectionLineNumbers,
  injectionTokenSpans,
  mergeInjectionSpans,
} from '../src/monaco/kojo2-semantic';
import { createKojo2FoldsCache } from '../src/monaco/kojo2-folding';
import { KOJO2_INJECTIONS, KOJO2_TOKEN } from '../src/monaco/kojo2-language';
import { ROLE } from '@kojo/kojo-sdk/semantic-roles';
import {
  disposeInjectionClients,
  planInjectionRanges,
  resetInjectionState,
  runInjection,
  type InjectionHost,
  type InjectionOutcome,
} from '../src/monaco/tree-sitter/injection';
import type { StructureLanguageRuntime } from '../src/monaco/tree-sitter/structure-runtime';
import { StructureEngine } from '../src/monaco/tree-sitter/engine';
import { erbCaptureTier } from '../src/monaco/tree-sitter/erb-tiers';
import type { KojoStructureReply, KojoStructureToken } from '../src/monaco/tree-sitter/types';
import type { Kojo2Capture, Kojo2TokenSpan } from '../src/monaco/tree-sitter/kojo2-tokenizer';
import type {
  Kojo2CapturesReply,
  Kojo2FoldsReply,
  Kojo2WorkerResult,
} from '../src/monaco/tree-sitter/kojo2-worker-protocol';
import {
  disposeKojo2TreeSitterRuntime,
  getKojo2TreeSitterRuntime,
  type Kojo2RuntimeDeps,
} from '../src/monaco/tree-sitter/kojo2-runtime';
import { onStructureDegradation, resetStructureDegradationLedger } from '../src/monaco/tree-sitter/fallback';
import { decodeWithMonaco } from './helpers/monaco-semantic-decode';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const KOJO_SYNTAX_ROOT = join(REPO_ROOT, 'packages/kojo-syntax-tree');
const ERB_ROOT = join(REPO_ROOT, 'packages/erb-syntax-tree');
const RUNTIME_WASM = join(REPO_ROOT, 'node_modules/web-tree-sitter/web-tree-sitter.wasm');

afterEach(async () => {
  disposeInjectionClients();
  resetInjectionState();
  await disposeKojo2TreeSitterRuntime();
  resetStructureDegradationLedger();
  vi.restoreAllMocks();
});

/* ============================== 1. 区间口径（纯函数） ============================== */

const BASIC_DOC = [
  '# 幕 神社清晨', // 0
  '', // 1
  '@原生', // 2
  '    ; 逃生舱：底层 ERB 代码', // 3
  '    IF TFLAG:10', // 4
  '        PRINTFORML 天气{x}很好', // 5
  '    ENDIF', // 6
  '', // 7
  '> 正文。', // 8
  '', // 9
].join('\n');

/** 体内从第 3 行起（含），到第 6 行行尾（含换行）收口；宿主节点的起点压在栏头行末的换行上 */
const BASIC_HOST: InjectionHost = {
  languageId: 'erb',
  hostNode: 'native_body',
  startRow: 2,
  startColumn: '@原生'.length,
  endRow: 6,
  endColumn: '    ENDIF'.length,
};

describe('区间口径 · 整行对齐 + 末行换行收口 + EOF 补虚拟换行（LAU-6a 的 ④）', () => {
  it('起点退到体首行第 0 列，终点收在末行换行之后（含换行）', () => {
    const plan = planInjectionRanges(BASIC_DOC, [BASIC_HOST]);
    expect(plan.input).toBe(BASIC_DOC);
    expect(plan.ranges).toHaveLength(1);
    const [range] = plan.ranges;
    expect(range!.startPosition).toEqual({ row: 3, column: 0 });
    expect(range!.startIndex).toBe(BASIC_DOC.indexOf('    ; 逃生舱'));
    // 末行（第 6 行）的换行之后 = 第 7 行第 0 列
    expect(range!.endPosition).toEqual({ row: 7, column: 0 });
    expect(BASIC_DOC.slice(range!.startIndex, range!.endIndex)).toBe(
      '    ; 逃生舱：底层 ERB 代码\n    IF TFLAG:10\n        PRINTFORML 天气{x}很好\n    ENDIF\n',
    );
  });

  it('体直达 EOF 且末行无换行 ⇒ 输入补一枚虚拟换行，区间尾取新长度（行首）', () => {
    const text = '@原生\n    CALL HPH_PRINT "w"\n    IF TFLAG:10\n        ENDIF';
    const plan = planInjectionRanges(text, [
      { languageId: 'erb', hostNode: 'native_body', startRow: 0, startColumn: 3, endRow: 3, endColumn: 13 },
    ]);
    expect(plan.input).toBe(`${text}\n`);
    expect(plan.input.length).toBe(text.length + 1);
    const [range] = plan.ranges;
    expect(range!.startPosition).toEqual({ row: 1, column: 0 });
    expect(range!.endIndex).toBe(plan.input.length);
    expect(range!.endPosition).toEqual({ row: 4, column: 0 });
  });

  it('深缩进（体内首行 8 列）同样从该行第 0 列起——不去缩进、不按首字符切', () => {
    const text = [
      '@函 增加羁绊(目标, 数值=10)',
      '    灵梦：「开始」',
      '    @原生',
      '        ; 深一级的逃生舱',
      '        IF TFLAG:10 == 1',
      '            CALL HPH_PRINT "w"',
      '        ENDIF',
      '    灵梦：「结束」',
      '',
    ].join('\n');
    const plan = planInjectionRanges(text, [
      { languageId: 'erb', hostNode: 'native_body', startRow: 2, startColumn: 7, endRow: 6, endColumn: 13 },
    ]);
    const [range] = plan.ranges;
    expect(range!.startPosition).toEqual({ row: 3, column: 0 });
    expect(text.slice(range!.startIndex, range!.startIndex + 10)).toBe('        ; ');
    expect(range!.endPosition).toEqual({ row: 7, column: 0 });
  });

  it('多段 `@原生` 合成一条计划（各自整行对齐，按起点排序）', () => {
    const text = ['@原生', '    A', '', '@原生', '    B', '', '> 正文', ''].join('\n');
    const plan = planInjectionRanges(text, [
      { languageId: 'erb', hostNode: 'native_body', startRow: 0, startColumn: 3, endRow: 1, endColumn: 5 },
      { languageId: 'erb', hostNode: 'native_body', startRow: 3, startColumn: 3, endRow: 4, endColumn: 5 },
    ]);
    expect(plan.ranges).toHaveLength(2);
    expect(plan.ranges[0]!.startPosition).toEqual({ row: 1, column: 0 });
    expect(plan.ranges[0]!.endPosition).toEqual({ row: 2, column: 0 });
    expect(plan.ranges[1]!.startPosition).toEqual({ row: 4, column: 0 });
    expect(plan.ranges[1]!.endPosition).toEqual({ row: 5, column: 0 });
  });

  it('空体 / 坐标倒置 ⇒ 零区间（调用方按"不注入"处理，不猜）', () => {
    const plan = planInjectionRanges(BASIC_DOC, [
      { languageId: 'erb', hostNode: 'native_body', startRow: 3, startColumn: 0, endRow: 3, endColumn: 0 },
    ]);
    expect(plan.ranges).toEqual([]);
  });

  it('`injectionLineNumbers`：末行换行之后那一行不算覆盖行（主树原文不该被白裁一行）', () => {
    const plan = planInjectionRanges(BASIC_DOC, [BASIC_HOST]);
    expect([...injectionLineNumbers(plan.ranges)].sort((a, b) => a - b)).toEqual([4, 5, 6, 7]);
  });
});

/* ============================== 2. 宿主节点挑选 + 合并 ============================== */

function captureOf(
  name: string,
  nodeType: string | undefined,
  startRow: number,
  startColumn: number,
  endRow: number,
  endColumn: number,
): Kojo2Capture {
  return {
    name,
    ...(nodeType === undefined ? {} : { nodeType }),
    startPosition: { row: startRow, column: startColumn },
    endPosition: { row: endRow, column: endColumn },
  };
}

describe('宿主节点 · 只按 descriptor 的 hostNode 等值匹配', () => {
  it('nodeType 命中才收；缺失 / 表外都不收（不按捕获名猜）', () => {
    const hosts = injectionHostNodes(KOJO2_INJECTIONS, [
      captureOf('embedded', 'native_line', 3, 0, 3, 10),
      captureOf('none', undefined, 2, 3, 6, 9),
      captureOf('none', 'block_body', 3, 0, 6, 9),
      captureOf('none', 'native_body', 2, 3, 6, 9),
    ]);
    expect(hosts).toEqual([
      { languageId: 'erb', hostNode: 'native_body', startRow: 2, startColumn: 3, endRow: 6, endColumn: 9 },
    ]);
  });

  it('同一节点被多条捕获命中只算一次；空声明 = 不注入', () => {
    const dup = captureOf('none', 'native_body', 2, 3, 6, 9);
    expect(injectionHostNodes(KOJO2_INJECTIONS, [dup, { ...dup, name: 'other' }])).toHaveLength(1);
    expect(injectionHostNodes([], [dup])).toEqual([]);
  });
});

describe('合并 · 子树覆盖主树原文，未涂到的列仍由 role.raw 兜底', () => {
  it('子树涂到的列让位；子树没涂的列保留主树；区间外的行一个字节不动', () => {
    const main: Kojo2TokenSpan[] = [
      { line: 1, startColumn: 1, endColumn: 9, tokenType: KOJO2_TOKEN.raw },
      { line: 2, startColumn: 1, endColumn: 21, tokenType: KOJO2_TOKEN.raw },
      { line: 3, startColumn: 1, endColumn: 6, tokenType: KOJO2_TOKEN.raw },
    ];
    const injected: Kojo2TokenSpan[] = [
      { line: 2, startColumn: 5, endColumn: 12, tokenType: KOJO2_TOKEN.comment },
    ];
    const merged = mergeInjectionSpans(main, injected, new Set([2]));
    expect(merged).toContainEqual({ line: 1, startColumn: 1, endColumn: 9, tokenType: KOJO2_TOKEN.raw });
    expect(merged).toContainEqual({ line: 2, startColumn: 1, endColumn: 5, tokenType: KOJO2_TOKEN.raw });
    expect(merged).toContainEqual({ line: 2, startColumn: 5, endColumn: 12, tokenType: KOJO2_TOKEN.comment });
    expect(merged).toContainEqual({ line: 2, startColumn: 12, endColumn: 21, tokenType: KOJO2_TOKEN.raw });
    expect(merged).toContainEqual({ line: 3, startColumn: 1, endColumn: 6, tokenType: KOJO2_TOKEN.raw });
  });

  it('子树整行盖住主树 ⇒ 那一行没有残留 raw；空子树 = 主树原样', () => {
    const main: Kojo2TokenSpan[] = [{ line: 2, startColumn: 1, endColumn: 10, tokenType: KOJO2_TOKEN.raw }];
    const full = mergeInjectionSpans(main, [{ line: 2, startColumn: 1, endColumn: 10, tokenType: KOJO2_TOKEN.speech }], new Set([2]));
    expect(full).toEqual([{ line: 2, startColumn: 1, endColumn: 10, tokenType: KOJO2_TOKEN.speech }]);
    expect(mergeInjectionSpans(main, [], new Set([2]))).toEqual(main);
  });
});

/* ============================== 2b. 子树捕获 → kojo2 档 ============================== */

describe('子树捕获 → kojo2 档（宿主侧唯一翻译点，按捕获名）', () => {
  it('控制流 / 插值 / 停用区各有同义档；表外捕获安静丢弃', () => {
    const tokens: KojoStructureToken[] = [
      // tier 只作历史遗留名的取证：翻译键是 capture（M3 闸：`keyword.erb` / `sugar.interp` 不新增）
      { startRow: 3, startCol: 0, endRow: 3, endCol: 5, tier: 'keyword.erb', capture: 'keyword.control', node: 'if_line' },
      {
        startRow: 4,
        startCol: 0,
        endRow: 4,
        endCol: 12,
        tier: 'sugar.interp',
        capture: 'string.special',
        node: 'form_interpolation',
      },
      { startRow: 5, startCol: 0, endRow: 5, endCol: 9, tier: 'keyword.raw', capture: 'raw', node: 'skip_body' },
      { startRow: 6, startCol: 0, endRow: 6, endCol: 9, tier: 'anything', capture: 'table.unknown', node: 'x' },
    ];
    const spans = injectionTokenSpans(tokens, { lineCount: 10, maxColumn: () => 40 });
    expect(spans.map((span) => [span.line, span.tokenType])).toEqual([
      [4, KOJO2_TOKEN.keyword],
      [5, KOJO2_TOKEN.interp],
      [6, KOJO2_TOKEN.raw],
    ]);
  });
});

/* ============================== 3. provider：零请求 / 覆盖 / 失败不拖垮 ============================== */

interface FakeModel {
  readonly model: Monaco.editor.ITextModel;
}

function fakeModel(text: string, version = 1): FakeModel {
  const lines = text.split('\n');
  return {
    model: {
      getValue: () => text,
      getVersionId: () => version,
      isDisposed: () => false,
      getLanguageId: () => 'kojo2',
      getLineCount: () => lines.length,
      getLineMaxColumn: (line: number) => (lines[line - 1] ?? '').length + 1,
      uri: { fsPath: 'D:/proj/chara/灵梦/开场.kojo' },
    } as unknown as Monaco.editor.ITextModel,
  };
}

function capturesReply(captures: readonly Kojo2Capture[]): Kojo2WorkerResult<Kojo2CapturesReply> {
  return {
    ok: true,
    value: {
      ok: true,
      id: 1,
      type: 'captures',
      version: 1,
      treeId: 'tree-1',
      captures,
      incremental: false,
      reparsed: true,
      queryMs: 0,
      loadMs: 0,
    },
  };
}

/** 主树捕获：体内四行各一条 `@embedded`（真查询的形态）+ 体容器 `@none`（LAU-6 新增的捕获） */
function mainCaptures(withHost: boolean): Kojo2Capture[] {
  const captures: Kojo2Capture[] = [
    captureOf('embedded', 'native_line', 3, 0, 3, 20),
    captureOf('embedded', 'native_line', 4, 0, 4, 14),
    captureOf('embedded', 'native_line', 5, 0, 5, 20),
    captureOf('embedded', 'native_line', 6, 0, 6, 9),
  ];
  if (withHost) captures.push(captureOf('none', 'native_body', 2, 3, 6, 9));
  return captures;
}

async function tokensOfProvider(
  text: string,
  runInjection: (
    model: Monaco.editor.ITextModel,
    request: { readonly hosts: readonly InjectionHost[] },
  ) => Promise<InjectionOutcome>,
  withHost = true,
): Promise<{ data: Uint32Array; warn: ReturnType<typeof vi.fn> }> {
  const warn = vi.fn();
  const handle = createKojo2SemanticTokensProvider({
    getClient: async () => ({ captures: async () => capturesReply(mainCaptures(withHost)) }),
    runInjection: runInjection as never,
    warn,
  });
  const result = await handle.provider.provideDocumentSemanticTokens(fakeModel(text).model, null, {} as never);
  const data = (result as { data: Uint32Array }).data;
  return { data, warn };
}

const SEMANTIC_TEXT = BASIC_DOC;

describe('provider · 只在真有宿主节点时才问子树（DoD 2）', () => {
  it('没有 `@原生` 体捕获 ⇒ 注入执行器零调用、ERB 一个字节都不请求', async () => {
    const runInjection = vi.fn();
    const { data } = await tokensOfProvider(SEMANTIC_TEXT, runInjection, false);
    expect(runInjection).not.toHaveBeenCalled();
    expect(data.length).toBeGreaterThan(0);
  });

  it('有宿主节点 ⇒ 调一次，tokens 里出现子树档位（注释盖住原行的一段）', async () => {
    const runInjection = vi.fn(
      async (
        _model: unknown,
        _request: { readonly hosts: readonly InjectionHost[] },
      ): Promise<InjectionOutcome> => ({
        ok: true,
        ranges: planInjectionRanges(SEMANTIC_TEXT, [BASIC_HOST]).ranges,
        input: SEMANTIC_TEXT,
        folds: [],
        tokens: [
          // 夹具第 3 行（0 基）19 字 ⇒ 0 基末列 19 = 1 基末列 20（几何夹取的上界）
          { startRow: 3, startCol: 4, endRow: 3, endCol: 19, tier: ROLE.comment, capture: 'comment', node: 'comment_line' },
        ],
      }),
    );
    const { data } = await tokensOfProvider(SEMANTIC_TEXT, runInjection);
    expect(runInjection).toHaveBeenCalledTimes(1);
    const call = runInjection.mock.calls[0]!;
    expect(call[1].hosts).toHaveLength(1);
    const decoded = await decodeWithMonaco(data);
    const commentType = KOJO2_SEMANTIC_TOKEN_TYPES.indexOf(KOJO2_TOKEN.comment);
    expect(decoded).toContainEqual({ line: 4, startColumn: 5, endColumn: 20, type: commentType, bits: 0 });
    // 子树没涂到的列（行首四格缩进）仍由主树 raw 兜底
    const rawType = KOJO2_SEMANTIC_TOKEN_TYPES.indexOf(KOJO2_TOKEN.raw);
    expect(decoded).toContainEqual({ line: 4, startColumn: 1, endColumn: 5, type: rawType, bits: 0 });
  });

  it('子树失败 ⇒ 主树 token 原样 + 一条 `core/injection/child-failed`（不整档停用，DoD 3）', async () => {
    const seen: Array<{ readonly capability: string; readonly code?: string }> = [];
    const off = onStructureDegradation((degradation) => seen.push(degradation));
    try {
      const runInjection = vi.fn(
        async (): Promise<InjectionOutcome> => ({ ok: false, reason: 'timeout', message: '4s 没回话' }),
      );
      const { data, warn } = await tokensOfProvider(SEMANTIC_TEXT, runInjection);
      expect(data.length).toBeGreaterThan(0); // 主树着色照旧
      const decoded = await decodeWithMonaco(data);
      // 体内四行仍是主树的 raw（子树一段也没有盖上来）
      const rawType = KOJO2_SEMANTIC_TOKEN_TYPES.indexOf(KOJO2_TOKEN.raw);
      expect(decoded.filter((token) => token.type === rawType).length).toBeGreaterThanOrEqual(4);
      expect(seen.some((d) => d.code === 'core/injection/child-failed')).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      off();
    }
  });
});

/* ============================== 3b. 假 runtime：零请求计数 + includedRanges 真发出去 ============================== */

/** 假子语言 worker：收件即记账，`replyFor` 回一条（`null` = 不回，让超时兜底） */
function fakeChildRuntime(replyFor: (message: Record<string, unknown>) => unknown): {
  runtime: StructureLanguageRuntime;
  posted: Record<string, unknown>[];
} {
  const posted: Record<string, unknown>[] = [];
  const runtime: StructureLanguageRuntime = {
    runtimeWasmUrl: 'fake://web-tree-sitter.wasm',
    grammarWasmUrl: 'fake://erb.wasm',
    createWorker: () => {
      const worker = {
        onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
        onerror: null as ((event: ErrorEvent) => void) | null,
        terminate: (): void => undefined,
        postMessage: (message: Record<string, unknown>): void => {
          posted.push(message);
          const reply = replyFor(message);
          // 同步补一条回话会踩在 `pending.set` 之前（客户端还没登记）⇒ 排到微任务
          if (reply !== null) queueMicrotask(() => worker.onmessage?.({ data: reply } as MessageEvent<unknown>));
        },
      };
      return worker as unknown as Worker;
    },
    captureTier: erbCaptureTier,
  };
  return { runtime, posted };
}

const READY: (message: Record<string, unknown>) => unknown = (message) => ({
  ok: true,
  id: message.id,
  kind: 'ready',
  protocol: STRUCTURE_PROTOCOL_VERSION,
  loadMs: 1,
  // 子语言运行时走的是注入自己的那条线（单引擎、不进池）⇒ docBase 恒 0
  docBase: 0,
});

describe('子 parse 转发 · 宿主只发区间、不回平移（DoD 2 / §4.6）', () => {
  it('没有宿主节点 ⇒ 子语言运行时装载器与 worker 一次都不碰（零 wasm 请求）', async () => {
    const loadRuntime = vi.fn(async () => null);
    const outcome = await runInjection({
      text: SEMANTIC_TEXT,
      version: 1,
      specs: KOJO2_INJECTIONS,
      hosts: [],
      loadRuntime,
    });
    expect(loadRuntime).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: true, tokens: [], folds: [], ranges: [], input: SEMANTIC_TEXT });
  });

  it('有宿主节点 ⇒ open 之后发 parse{text, includedRanges}；回话按档位名交回、折叠原样', async () => {
    const { runtime, posted } = fakeChildRuntime((message) => {
      if (message.kind === 'open') return READY(message);
      if (message.kind !== 'parse') return null;
      return {
        ok: true,
        id: message.id,
        kind: 'parse',
        doc: message.doc,
        version: message.version,
        treeId: 'child-tree',
        incremental: false,
        facets: {
          // `[startRow, startCol, endRow, endCol, nameIndex, nodeIndex]`（v3 扁平投影）
          semantic: { names: ['comment'], nodes: ['comment_line'], spans: [3, 4, 3, 19, 0, 0] },
          folds: { spans: [4, 6] },
        },
        metrics: { parseMs: 0, queryMs: 0, textLength: String(message.text ?? '').length },
      };
    });
    const loadRuntime = vi.fn(async () => runtime);
    const outcome = await runInjection({
      text: SEMANTIC_TEXT,
      version: 7,
      specs: KOJO2_INJECTIONS,
      hosts: [BASIC_HOST],
      loadRuntime,
    });
    expect(loadRuntime).toHaveBeenCalledTimes(1);
    expect(loadRuntime).toHaveBeenCalledWith('erb');
    if (!outcome.ok) throw new Error(`注入应当成功：${outcome.message}`);
    // 发出去的就是计划里那几段（整行对齐、末行含换行），输入是整篇、不平移不截串
    const plan = planInjectionRanges(SEMANTIC_TEXT, [BASIC_HOST]);
    const parseRequest = posted.find((message) => message.kind === 'parse');
    expect(parseRequest?.includedRanges).toEqual(plan.ranges);
    expect(parseRequest?.text).toBe(plan.input);
    expect(parseRequest?.want).toEqual(['semantic', 'folds']);
    expect(outcome.ranges).toEqual(plan.ranges);
    expect(outcome.tokens).toEqual([
      { startRow: 3, startCol: 4, endRow: 3, endCol: 19, tier: ROLE.comment, capture: 'comment', node: 'comment_line' },
    ]);
    expect(outcome.folds).toEqual([{ startRow: 4, endRow: 6 }]);
  });

  it('多段 `@原生` 并成一条请求（一条 worker 线程，区间多段）', async () => {
    const text = ['@原生', '    A', '', '@原生', '    B', '', '> 正文', ''].join('\n');
    const hosts: InjectionHost[] = [
      { languageId: 'erb', hostNode: 'native_body', startRow: 0, startColumn: 3, endRow: 1, endColumn: 5 },
      { languageId: 'erb', hostNode: 'native_body', startRow: 3, startColumn: 3, endRow: 4, endColumn: 5 },
    ];
    const { runtime, posted } = fakeChildRuntime((message) => {
      if (message.kind === 'open') return READY(message);
      if (message.kind !== 'parse') return null;
      return {
        ok: true,
        id: message.id,
        kind: 'parse',
        doc: message.doc,
        version: message.version,
        treeId: 'child-tree',
        incremental: false,
        facets: { semantic: { names: [], nodes: [], spans: [] }, folds: { spans: [] } },
        metrics: { parseMs: 0, queryMs: 0, textLength: String(message.text ?? '').length },
      };
    });
    const outcome = await runInjection({
      text,
      version: 1,
      specs: KOJO2_INJECTIONS,
      hosts,
      loadRuntime: async () => runtime,
    });
    expect(outcome.ok).toBe(true);
    const parseRequests = posted.filter((message) => message.kind === 'parse');
    expect(parseRequests).toHaveLength(1);
    expect((parseRequests[0]!.includedRanges as unknown[]).length).toBe(2);
  });
});

/* ============================== 4. 折叠：子树折叠与主树并集 ============================== */

describe('折叠 · 子树折叠（体内 IF…ENDIF）与主树折叠并集', () => {
  it('宿主节点账在位 ⇒ 子树折叠并进来；取不回 ⇒ 只给主树折叠', async () => {
    const host: InjectionHost = BASIC_HOST;
    const client = {
      folds: async (): Promise<Kojo2WorkerResult<Kojo2FoldsReply>> => ({
        ok: true,
        value: {
          ok: true,
          id: 1,
          type: 'folds',
          version: 1,
          treeId: 'tree-1',
          folds: [{ startRow: 2, endRow: 6 }],
          incremental: false,
          reparsed: true,
          queryMs: 0,
          loadMs: 0,
        },
      }),
    };
    const runInjection = vi.fn(
      async (): Promise<InjectionOutcome> => ({
        ok: true,
        tokens: [],
        ranges: planInjectionRanges(SEMANTIC_TEXT, [host]).ranges,
        input: SEMANTIC_TEXT,
        folds: [{ startRow: 4, endRow: 6 }],
      }),
    );
    const withHost = createKojo2FoldsCache({
      getClient: async () => client,
      recallInjectionHosts: async () => [host],
      runInjection: runInjection as never,
    });
    const foldModel = fakeModel(SEMANTIC_TEXT);
    await withHost.prefetch(foldModel.model);
    const ranges = withHost.snapshotFor(foldModel.model);
    expect(ranges).toContainEqual({ startLine: 3, endLine: 7 }); // 主树：@原生 整块
    expect(ranges).toContainEqual({ startLine: 5, endLine: 7 }); // 子树：体内 IF…ENDIF
    withHost.dispose();

    const withoutPlan = createKojo2FoldsCache({
      getClient: async () => client,
      recallInjectionHosts: async () => null,
      runInjection: runInjection as never,
    });
    await withoutPlan.prefetch(foldModel.model);
    const onlyMain = withoutPlan.snapshotFor(foldModel.model);
    expect(onlyMain).toEqual([{ startLine: 3, endLine: 7 }]);
    expect(runInjection).toHaveBeenCalledTimes(1); // 第二次没有宿主节点账 ⇒ 不再问子树
    withoutPlan.dispose();
  });
});

/* ============================== 5. 探针口径回归（真 wasm，LAU-6a ④） ============================== */

function erbEngine(): { engine: StructureEngine; replies: KojoStructureReply[] } {
  const replies: KojoStructureReply[] = [];
  const engine = new StructureEngine({
    assets: {
      runtimeWasm: RUNTIME_WASM,
      grammarWasm: readFileSync(join(ERB_ROOT, 'tree-sitter-erb.wasm')),
      highlightsQuery: readFileSync(join(ERB_ROOT, 'queries', 'highlights.scm'), 'utf8'),
      foldsQuery: readFileSync(join(ERB_ROOT, 'queries', 'folds.scm'), 'utf8'),
      captureTier: erbCaptureTier,
    },
    emit: (reply) => replies.push(reply),
  });
  return { engine, replies };
}

function kojo2Deps(): Kojo2RuntimeDeps {
  return {
    loadAssets: async () => ({
      runtimeWasmUrl: RUNTIME_WASM,
      grammarWasm: join(KOJO_SYNTAX_ROOT, 'tree-sitter-kojo2.wasm'),
      highlightsQuery: readFileSync(join(KOJO_SYNTAX_ROOT, 'queries/v2/highlights.scm'), 'utf8'),
      foldsQuery: readFileSync(join(KOJO_SYNTAX_ROOT, 'queries/v2/folds.scm'), 'utf8'),
      indentsQuery: readFileSync(join(KOJO_SYNTAX_ROOT, 'queries/v2/indents.scm'), 'utf8'),
    }),
  };
}

/** 探针的三个稳定语境：基础 / `[SKIPSTART]` 嵌套 / 深缩进（8 列并再深 12 列） */
const REGRESSION_CASES: readonly {
  id: string;
  text: string;
  folds: readonly (readonly [number, number])[];
  needsComment: boolean;
  needsDirective: boolean;
  needsRaw: boolean;
  /** `#DIM` 的存储 / 型限定词（`STATIC`）走 `@type` 档（third 色批的判据，只在 C 里出现） */
  needsType?: boolean;
}[] = [
  {
    id: 'A-基础',
    text: BASIC_DOC,
    folds: [[4, 6]],
    needsComment: true,
    needsDirective: false,
    needsRaw: false,
  },
  {
    id: 'B-[SKIPSTART] 嵌套',
    text: [
      '# 幕 跳过',
      '',
      '@原生',
      '    [SKIPSTART]',
      '    @HPH_PRINT(ARG)',
      '        ; 区内任意字符 " 未闭合引号 { 散括号',
      '    CALL X 1',
      '    [SKIPEND]',
      '    PRINTL 区外语句',
      '',
      '> 正文。',
      '',
    ].join('\n'),
    folds: [[3, 7]],
    needsComment: false, // `[SKIPSTART]` 区内整段是 raw（external scanner 一次吞掉），不是 comment
    needsDirective: false,
    needsRaw: true,
  },
  {
    id: 'C-深缩进',
    text: [
      '# 幕 深层',
      '',
      '@函 增加羁绊(目标, 数值=10)',
      '    灵梦：「开始」',
      '    @原生',
      '        #DIM STATIC i COUNTER 10',
      '        IF TFLAG:10 == 1',
      '            PRINTFORML 天气{x}',
      '            CALL HPH_PRINT "w"',
      '        ENDIF',
      '    灵梦：「结束」',
      '',
      '> 正文。',
      '',
    ].join('\n'),
    folds: [[6, 9]], // IF（0 基 6）… ENDIF（0 基 9，含末行——与 A 的 [4,6] 同口径）
    needsComment: false,
    needsDirective: true,
    // C 的体内**没有** `[SKIPSTART]` ⇒ 语法上不存在 `skip_body`，`raw` 这一档只能由 B 独占；
    // 深缩进这一语境要看的是 `#DIM` 行（指令 + 限定词两档）没有被深度带偏。
    needsRaw: false,
    needsType: true,
  },
];

describe('探针 ④ 回归（真 wasm）：整行对齐 + 末行换行 + EOF 虚拟换行', () => {
  it.each(REGRESSION_CASES)('$id：ERROR=0、坐标绝对、注释/指令有档位、IF…ENDIF 出折叠', async (testCase) => {
    const runtimeResult = await getKojo2TreeSitterRuntime(kojo2Deps());
    if (!runtimeResult.ok) throw new Error(`kojo2 runtime 装载失败：${runtimeResult.message}`);
    const runtime = runtimeResult.runtime;
    const parsed = runtime.parse(testCase.text);
    if (!parsed.ok) throw new Error(`kojo2 主树解析失败：${parsed.message}`);
    try {
      const captures = runtime.captures(parsed.rootNode);
      if (!captures.ok) throw new Error(`kojo2 捕获失败：${captures.message}`);
      const hosts = injectionHostNodes(KOJO2_INJECTIONS, captures.captures);
      expect(hosts, '主树里应当恰好一枚 `@原生` 体').toHaveLength(1);

      const plan = planInjectionRanges(testCase.text, hosts);
      expect(plan.ranges).toHaveLength(1);
      const [range] = plan.ranges;
      const bodyFirstRow = range!.startPosition.row;
      const bodyLastRow = range!.endPosition.row - 1;

      const { engine, replies } = erbEngine();
      try {
        expect(await engine.init()).toBe(true);
        engine.parse(1, 1, plan.input, ['semantic', 'folds'], plan.ranges);
        expect(replies.filter((reply) => reply.type === 'error')).toEqual([]);

        const semantic = replies.find((reply) => reply.type === 'semantic');
        if (semantic?.type !== 'semantic') throw new Error('子树没有 semantic 回话');
        const tokens: readonly KojoStructureToken[] = semantic.tokens;
        expect(tokens.length).toBeGreaterThan(0);
        // 坐标绝对 + 全部落在区间内（探针的四条硬判据：错位 / 越界都为 0）
        for (const token of tokens) {
          expect(token.startRow).toBeGreaterThanOrEqual(bodyFirstRow);
          expect(token.startRow).toBeLessThanOrEqual(bodyLastRow);
          expect(token.endRow).toBeLessThanOrEqual(range!.endPosition.row);
        }
        const capturesSeen = new Set(tokens.map((token) => token.capture));
        if (testCase.needsComment) {
          expect(capturesSeen.has('comment'), `${testCase.id} 体内注释没有档位`).toBe(true);
        }
        if (testCase.needsDirective) {
          expect(capturesSeen.has('keyword.directive'), `${testCase.id} 体内 #DIM 没有指令档`).toBe(true);
        }
        if (testCase.needsRaw) {
          // `[SKIPSTART]` 区内是 raw：external scanner 整段吞掉 ⇒ 不被当成函数块 / 语句
          expect(capturesSeen.has('raw'), `${testCase.id} 停用区没有 raw 档`).toBe(true);
        }
        if (testCase.needsType === true) {
          // `#DIM STATIC …` 的限定词是 `dim_directive → dim_modifier` 子记号 ⇒ `@type`
          expect(capturesSeen.has('type'), `${testCase.id} 体内限定词没有类型档`).toBe(true);
        }

        const folds = replies.find((reply) => reply.type === 'folds');
        if (folds?.type !== 'folds') throw new Error('子树没有 folds 回话');
        const pairs = folds.folds.map((fold) => [fold.startRow, fold.endRow]);
        for (const expected of testCase.folds) expect(pairs).toContainEqual([...expected]);
      } finally {
        engine.dispose();
      }
    } finally {
      parsed.tree.delete();
    }
  });
});

/* ============================== 6. DoD 4：宿主零节点名 ============================== */

/** 递归列出 `packages/app/src/monaco` 下的 .ts 源（不含测试） */
function monacoSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) monacoSources(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('DoD 4 · `native_body` / `native_head` 只出现在注入声明那一行', () => {
  it('宿主与其它模块零命中（grep 闸：只许声明处）', () => {
    const offenders: string[] = [];
    for (const file of monacoSources(join(REPO_ROOT, 'packages/app/src/monaco'))) {
      const rel = file.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');
      const source = readFileSync(file, 'utf8');
      source.split('\n').forEach((line, index) => {
        if (!/native_body|native_head/.test(line)) return;
        const isDeclarationLine = line.includes("{ hostNode: 'native_body'");
        if (!isDeclarationLine) offenders.push(`${rel}:${index + 1}`);
      });
    }
    expect(offenders, `宿主里出现了节点名硬编码：${offenders.join(', ')}`).toEqual([]);
  });

  it('声明形状：宿主节点 + 子语言 id，且是冻结的只读数据', () => {
    expect(KOJO2_INJECTIONS).toEqual([{ hostNode: 'native_body', languageId: 'erb' }]);
    expect(Object.isFrozen(KOJO2_INJECTIONS)).toBe(true);
    // 捕获表里 `none` 是"不上色"哨兵：这条宿主捕获不会把整块涂色
    expect(KOJO2_CAPTURE_TOKEN_TYPES.none).toBeUndefined();
  });
});
