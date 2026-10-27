import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STRUCTURE_PROTOCOL_VERSION } from '@kojo/kojo-core';
import { KOJO_TOKEN_TIERS } from '../src/monaco/kojo-language';
import { ROLE } from '@kojo/kojo-lang/semantic-roles';
import {
  encodeStructureTokens,
  resetStructureSemanticWarnings,
  splitStructureTokensToSpans,
  MAX_STRUCTURE_TOKEN_SPAN,
} from '../src/monaco/tree-sitter/semantic';
import {
  KOJO_STRUCTURE_BASELINE_TOKENS,
  KOJO_STRUCTURE_CAPTURE_TIERS,
  KOJO_STRUCTURE_NODE_TIERS,
  KOJO_STRUCTURE_PROTOCOL,
  isStructureReply,
  structureLegendTypes,
  tierForCapture,
  type KojoStructureIndentRules,
  type KojoStructureToken,
} from '../src/monaco/tree-sitter/types';
import { applyEdit, commonEdit, pointAt } from '../src/monaco/tree-sitter/edit';
import { compilePattern, mergeIndentConfig, type BaseIndentPatterns } from '../src/monaco/tree-sitter/indent';
import { decodeWithMonaco } from './helpers/monaco-semantic-decode';
import {
  degradationNoticeText,
  onStructureDegradation,
  reportStructureDegradation,
  resetStructureDegradationLedger,
} from '../src/monaco/tree-sitter/fallback';
import {
  disposeStructureOverlay,
  installStructureOverlay,
  structureOverlayState,
} from '../src/monaco/tree-sitter/providers';
import type * as Monaco from '../src/monaco/entry';

/**
 * 结构解析叠层（TSIT-M1）的护栏。
 *
 * 钉四件事，全是"错了不会自己发现"的那一类：
 * ① 档位映射闭合——结构层的每档都得在 `KOJO_TOKEN_TIERS` 里已有色（否则语义色无处可取，
 *    屏上就是"开了开关什么也没变"）；
 * ② 协议形状闸——worker 回传的任何不符形状的消息都被判掉（两侧版本对不上时不许硬解）；
 * ③ 增量算术——`commonEdit` + `applyEdit` 必须恒等于新文本（缝错一格就是把错树留在手上着色）；
 * ④ **默认开 = 装配即激活；显式关 = 一毫米都不动**（TS-DEFAULT）：只有存过 `off` 才算关，
 *    关着时装配函数对 Monaco 的调用次数必须是 0。
 *
 * 纯逻辑层全覆盖；worker 线程本体（`kojo-ts.worker.ts`）与真实 wasm 装载归真壳验收
 * （`tools/smoke-tauri-*`），本池是 node，起不了 Worker。
 */

const EMPTY_RULES: KojoStructureIndentRules = { increasePatterns: [], decreasePatterns: [], enterPatterns: [] };

/* ========================= ① 档位映射与 legend ========================= */

describe('结构层档位映射 · 必须落在既有档位表里', () => {
  const tierTokens = new Set<string>(KOJO_TOKEN_TIERS.flatMap((t) => [...t.tokens]));

  it.each(Object.entries(KOJO_STRUCTURE_CAPTURE_TIERS))('捕获 @%s → %s 在档位表里有色', (capture, tier) => {
    expect(tierForCapture(capture)).toBe(tier);
    expect(tierTokens.has(tier) || KOJO_STRUCTURE_BASELINE_TOKENS.includes(tier)).toBe(true);
  });

  it('表里没有的捕获不猜档（返回 null ⇒ 不着色并且说出去）', () => {
    expect(tierForCapture('definitely-not-a-capture')).toBeNull();
  });

  /**
   * 错档护栏（本批改的那一格）：`@keyword` 挂的是**已经中文化**的行
   * （着色 / 心形 / 心形正文 / 隐藏情景 / 空行），wave 1 把它们映射成 `keyword.erb`
   * （引擎指令档 = "一整条还没中文化的骨架"）⇒ 屏上是外来色糊住中文骨架，A/B 也确有 ~620 格判异档。
   * 这一条钉住"不许再借引擎指令档凑数"；真要接全大写 ERB 直通行，走 `@keyword.directive` 自己登记。
   */
  it('@keyword 落中文关键字档，不借引擎指令档', () => {
    expect(tierForCapture('keyword')).toBe(ROLE.keyword);
    expect(Object.values(KOJO_STRUCTURE_CAPTURE_TIERS)).not.toContain(ROLE.engine);
  });

  it('节点类型级覆盖只在它登记的那支捕获里生效，查不到就回落到捕获名表', () => {
    // 心形正文是"整行 @keyword"里唯一一条不含关键字的正文 ⇒ 按台词档
    expect(tierForCapture('keyword', 'heart_text')).toBe(ROLE.speech);
    // 语法升级（节点改名 / 拆分）时这张表自然失效：回落，不猜、不抛
    expect(tierForCapture('keyword', 'node_that_does_not_exist_yet')).toBe(ROLE.keyword);
    // 别的捕获名下的同名节点不许被这一格串色
    expect(tierForCapture('comment', 'heart_text')).toBe(ROLE.comment);
  });

  it('legend 与两张档位表同源：表里每个档名都能反查回下标', () => {
    const legend = structureLegendTypes();
    const tiers = [
      ...Object.values(KOJO_STRUCTURE_CAPTURE_TIERS),
      ...Object.values(KOJO_STRUCTURE_NODE_TIERS).flatMap((byNode) => Object.values(byNode)),
    ];
    for (const tier of tiers) {
      expect(legend.indexOf(tier), `档位 ${tier} 没进 legend ⇒ 编码时无处落 index（悄悄不涂色）`).toBeGreaterThanOrEqual(0);
    }
    expect(new Set(legend).size).toBe(legend.length);
  });

  it('legend 稳定、无重复，且每个档位名都能反查回下标', () => {
    const legend = structureLegendTypes();
    expect(legend).toEqual([...legend].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(new Set(legend).size).toBe(legend.length);
    for (const tier of Object.values(KOJO_STRUCTURE_CAPTURE_TIERS)) {
      expect(legend.indexOf(tier)).toBeGreaterThanOrEqual(0);
    }
  });
});

/* ============================ ② 协议形状闸 ============================ */

/**
 * v3 的收件闸（LAU-1）。协议真源在 `@kojo/kojo-core` 的 `structure-protocol.ts`，
 * 闸在 `tree-sitter/protocol.ts`；这里钉的是"主线程不信来路不明的消息"这条纪律本身。
 *
 * 双跑窗口里还有一条并存的判据：**v2 形状必须被 v3 闸拒掉**（否则旧 worker 的回话会被当成
 * 新形状硬解）——见最后一组用例。
 */
const PARSE_OK = {
  ok: true,
  id: 2,
  kind: 'parse',
  doc: 1,
  version: 3,
  treeId: 't1',
  incremental: true,
  facets: {},
  metrics: { parseMs: 1, queryMs: 0, textLength: 3 },
} as const;

describe('isStructureReply（v3）· 主线程不信来路不明的消息', () => {
  it('认得三类合法回话（ready / parse / 失败）', () => {
    expect(
      isStructureReply({ ok: true, id: 1, kind: 'ready', protocol: STRUCTURE_PROTOCOL_VERSION, loadMs: 12, docBase: 0 }),
    ).toBe(true);
    expect(isStructureReply(PARSE_OK)).toBe(true);
    expect(
      isStructureReply({
        ...PARSE_OK,
        facets: {
          semantic: { names: ['keyword'], nodes: ['case_head'], spans: [0, 0, 0, 4, 0, 0] },
          folds: { spans: [0, 9] },
          indent: EMPTY_RULES,
          syntax: { faults: [{ row: 4, endRow: 4, column: 2, endColumn: 9, faultRow: 4, kind: 'unterminated-string' }], truncated: false },
        },
      }),
    ).toBe(true);
    expect(isStructureReply({ ok: false, id: 3, kind: 'parse', reason: 'timeout', message: 'x' })).toBe(true);
    expect(isStructureReply({ ok: false, id: 4, reason: 'protocol-mismatch', message: 'x', treeId: 't9' })).toBe(true);
  });

  it.each([
    ['null', null],
    ['缺 id（回话配不上任何请求）', { ok: true, kind: 'ready', protocol: STRUCTURE_PROTOCOL_VERSION, loadMs: 1, docBase: 0 }],
    ['id 是 NaN', { ok: true, id: NaN, kind: 'ready', protocol: STRUCTURE_PROTOCOL_VERSION, loadMs: 1, docBase: 0 }],
    ['ok 不是布尔', { ok: 'yes', id: 1, kind: 'ready', protocol: STRUCTURE_PROTOCOL_VERSION, loadMs: 1, docBase: 0 }],
    ['未知 kind', { ok: true, id: 1, kind: 'nope', protocol: STRUCTURE_PROTOCOL_VERSION, loadMs: 1, docBase: 0 }],
    ['ready 缺 protocol', { ok: true, id: 1, kind: 'ready', loadMs: 1, docBase: 0 }],
    ['ready 缺 loadMs', { ok: true, id: 1, kind: 'ready', protocol: STRUCTURE_PROTOCOL_VERSION, docBase: 0 }],
    ['ready 缺 docBase（v4 的池要这一段号）', { ok: true, id: 1, kind: 'ready', protocol: STRUCTURE_PROTOCOL_VERSION, loadMs: 1 }],
    ['ready 的 docBase 是负数', { ok: true, id: 1, kind: 'ready', protocol: STRUCTURE_PROTOCOL_VERSION, loadMs: 1, docBase: -1 }],
    ['parse 缺 doc（跨文档对不上号就是废消息）', { ...PARSE_OK, doc: undefined }],
    ['parse 的 treeId 不是字符串', { ...PARSE_OK, treeId: 7 }],
    ['parse 缺 metrics', { ...PARSE_OK, metrics: undefined }],
    ['parse 的 metrics 缺一条腿', { ...PARSE_OK, metrics: { parseMs: 1, queryMs: 0 } }],
    ['facets 不是对象', { ...PARSE_OK, facets: null }],
    ['捕获表 spans 不是 6 的整数倍', { ...PARSE_OK, facets: { semantic: { names: ['a'], nodes: ['b'], spans: [0, 0, 0, 1, 0] } } }],
    ['捕获表的 nameIndex 越界', { ...PARSE_OK, facets: { semantic: { names: ['a'], nodes: ['b'], spans: [0, 0, 0, 1, 3, 0] } } }],
    ['捕获表缺 nodes 字典', { ...PARSE_OK, facets: { semantic: { names: ['a'], spans: [] } } }],
    ['折叠表 spans 是奇数个', { ...PARSE_OK, facets: { folds: { spans: [0] } } }],
    ['缩进规则缺三条腿', { ...PARSE_OK, facets: { indent: {} } }],
    ['残缺面缺 truncated 标记', { ...PARSE_OK, facets: { syntax: { faults: [] } } }],
    ['失败原因在闭集外', { ok: false, id: 5, reason: 'boom', message: 'x' }],
    ['失败缺 message', { ok: false, id: 6, reason: 'timeout' }],
  ])('丢掉：%s', (_name, payload) => {
    expect(isStructureReply(payload)).toBe(false);
  });

  it('v2 形状一律被 v3 闸拒掉（旧 worker 的回话不许被当成新形状硬解）', () => {
    expect(isStructureReply({ type: 'ready', version: 0 })).toBe(false);
    expect(isStructureReply({ type: 'semantic', doc: 1, version: 3, tokens: [] })).toBe(false);
    expect(isStructureReply({ type: 'error', version: 0, stage: 'wasm', capability: 'all', message: 'x' })).toBe(false);
  });

  it('版本号：v4 在 core（LAU-5 的 `ready.docBase`），v2 常量留给双跑窗口的旧路', () => {
    expect(STRUCTURE_PROTOCOL_VERSION).toBe(4);
    expect(KOJO_STRUCTURE_PROTOCOL).toBe(2);
  });
});

/* =========================== ③ 增量编辑算术 =========================== */

describe('commonEdit / applyEdit · 缝回去必须逐字相等', () => {
  const cases: Array<[string, string, string]> = [
    ['行尾插入', '如果 天气好 :\n  等待\n', '如果 天气好 :\n  等待 X\n'],
    ['行首插入', 'aaa\nbbb\n', 'Xaaa\nbbb\n'],
    ['删掉一整行', 'aaa\nbbb\nccc\n', 'aaa\nccc\n'],
    ['多段改动并成一条', 'aaa\nbbb\nccc\n', 'Aaa\nbbb\nCcc\n'],
    ['只在末尾追加', 'abc', 'abcdef'],
    ['清空', 'abc', ''],
    ['从无到有', '', 'abc'],
    ['完全没变', 'abc\n', 'abc\n'],
  ];

  it.each(cases)('%s', (_name, oldText, newText) => {
    const edit = commonEdit(oldText, newText);
    expect(applyEdit(oldText, edit)).toBe(newText);
    // 区间方向自洽：新区间长度 = 旧区间长度 + 净增减
    expect(edit.newEnd.offset - edit.start.offset).toBe(edit.newText.length);
    expect(edit.oldEnd.offset - edit.start.offset).toBe(oldText.length - newText.length + edit.newText.length);
  });

  it('CJK 文本按 UTF-16 码元计（代理对不让列号漂）', () => {
    const oldText = '口上一段\n';
    const newText = '口上X一段\n';
    const edit = commonEdit(oldText, newText);
    expect(applyEdit(oldText, edit)).toBe(newText);
    expect(edit.start.column).toBe(2);
  });

  it('pointAt 给 0 基行与 0 基列，越界偏移夹到文本内', () => {
    expect(pointAt('ab\ncd', 4)).toEqual({ row: 1, column: 1, offset: 4 });
    expect(pointAt('ab\ncd', 99).offset).toBe(5);
    expect(pointAt('ab\ncd', -3).offset).toBe(0);
  });
});

/* ============================ 缩进规则合并 ============================ */

const BASE: BaseIndentPatterns = {
  indentOnEnter: [/^\s*如果[^\r\n]*:\s*$/],
  increaseIndentPattern: /^\s*如果[^\r\n]*:\s*$/,
  decreaseIndentPattern: /^\s*结束\s*$/,
};

const rules = (over: Partial<KojoStructureIndentRules> = {}): KojoStructureIndentRules => ({
  ...EMPTY_RULES,
  ...over,
});

describe('mergeIndentConfig · 只做加法，空规则一个字都不发', () => {
  it('规则缺席 / 三条腿全空 ⇒ null（= 与没接这条线逐字一致）', () => {
    expect(mergeIndentConfig(BASE, null)).toBeNull();
    expect(mergeIndentConfig(BASE, EMPTY_RULES)).toBeNull();
  });

  it('基底规则一条不少，结构层规则加在后面', () => {
    const merged = mergeIndentConfig(BASE, rules({ enterPatterns: ['^\\s*时机\\s'] }));
    expect(merged).not.toBeNull();
    expect(merged?.onEnterRules).toHaveLength(2);
    expect(merged?.onEnterRules[0]?.beforeText.source).toBe(BASE.indentOnEnter[0]?.source);
    expect(merged?.added).toBe(1);
    expect(merged?.rejected).toBe(0);
  });

  it('与基底逐字相同的规则不重复添', () => {
    const merged = mergeIndentConfig(BASE, rules({ enterPatterns: [BASE.indentOnEnter[0]!.source] }));
    expect(merged).toBeNull();
  });

  it('increase / decrease 与基底并联，非法正则计数并丢掉', () => {
    const merged = mergeIndentConfig(BASE, rules({
      increasePatterns: ['^\\s*随机\\s', '('],
      decreasePatterns: ['^\\s*否则$'],
    }))!;
    expect(merged.rejected).toBe(1);
    expect(merged.increaseIndentPattern.source).toContain('随机');
    expect(merged.increaseIndentPattern.test('  随机 3 次:')).toBe(true);
    expect(merged.increaseIndentPattern.test('  如果 天 :')).toBe(true); // 基底那条还在
    expect(merged.decreaseIndentPattern.test('  否则')).toBe(true);
    expect(merged.decreaseIndentPattern.test('  结束')).toBe(true);
  });

  it('同一批规则的去重键相同 ⇒ 装配层不会重复重发语言配置', () => {
    const a = mergeIndentConfig(BASE, rules({ enterPatterns: ['^\\s*A$'] }))!;
    const b = mergeIndentConfig(BASE, rules({ enterPatterns: ['^\\s*A$'] }))!;
    expect(a.key).toBe(b.key);
  });

  it('compilePattern 对非法与空串都给 null', () => {
    expect(compilePattern('([')).toBeNull();
    expect(compilePattern('')).toBeNull();
    expect(compilePattern('^\\s*x$')?.test('  x')).toBe(true);
  });
});

/* ======================= 语义数据的编码与拆行 ======================= */

const geometry = (lines: readonly string[]) => ({
  lineCount: lines.length,
  maxColumn: (lineNumber: number) => (lines[lineNumber - 1]?.length ?? 0) + 1,
});

const token = (over: Partial<KojoStructureToken>): KojoStructureToken => ({
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 3,
  tier: ROLE.comment,
  ...over,
});

/**
 * 把 5 元增量数据读回来（**Monaco 自己的解码器**：`toMultilineTokens2`；编码错了这里就歪，歪了就红）。
 * 以前这里自写"从 line = 0 起算"的循环，与编码器同为 1 基 ⇒ 两边一起错、闸一直绿。
 */
async function decode(
  data: Uint32Array,
  legend: readonly string[],
): Promise<Array<{ line: number; startColumn: number; length: number; tier: string }>> {
  return (await decodeWithMonaco(data)).map((decoded) => ({
    line: decoded.line,
    startColumn: decoded.startColumn,
    length: decoded.endColumn - decoded.startColumn,
    tier: legend[decoded.type] ?? '<越界>',
  }));
}

describe('encodeStructureTokens · 与词法同色、坐标夹到模型现实', () => {
  beforeEach(() => resetStructureSemanticWarnings());
  afterEach(() => vi.restoreAllMocks());

  it('legend 之外的档位不着色（并说一次，绝不挑个"最像的"凑数）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const encoded = encodeStructureTokens([token({ tier: 'sugar.nope' })], geometry(['abc']));
    expect(encoded.data.length).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('sugar.nope');
  });

  it('跨行节点拆成逐行段：首行到行尾、中间整行、末行到结束列', async () => {
    const lines = [';注释第一行', '第二行内容', '第三行尾'];
    const encoded = encodeStructureTokens([token({ startRow: 0, startCol: 1, endRow: 2, endCol: 4 })], geometry(lines));
    const decoded = await decode(encoded.data, structureLegendTypes());
    expect(decoded.map((d) => d.line)).toEqual([1, 2, 3]);
    expect(decoded[0]).toMatchObject({ startColumn: 2, length: lines[0]!.length - 1 });
    expect(decoded[1]).toMatchObject({ startColumn: 1, length: lines[1]!.length });
    expect(decoded[2]).toMatchObject({ startColumn: 1, length: 4 });
  });

  it('行越界丢掉、列越界夹住（夹完塌成空的也算丢掉并报数）', () => {
    const result = splitStructureTokensToSpans(
      [token({ startRow: 99, endRow: 99 }), token({ startCol: 2, endCol: 99 }), token({ startCol: 3, endCol: 1 })],
      geometry(['abc']),
    );
    expect(result.droppedRows).toBe(1);
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]).toMatchObject({ line: 1, startColumn: 3, endColumn: 4 });
    expect(result.droppedEmpty).toBe(1);
  });

  it('跨度超上限的捕获整条丢掉（错误恢复把块撑到全篇时不许糊屏）', () => {
    const lines = Array.from({ length: 400 }, () => 'x');
    const result = splitStructureTokensToSpans(
      [token({ startRow: 0, endRow: MAX_STRUCTURE_TOKEN_SPAN + 5 })],
      geometry(lines),
    );
    expect(result.droppedWide).toBe(1);
    expect(result.spans).toHaveLength(0);
  });

  it('同行重叠留先到的，后者丢掉并报数', async () => {
    const encoded = encodeStructureTokens(
      [token({ startCol: 0, endCol: 3 }), token({ startCol: 1, endCol: 2 })],
      geometry(['abcdef']),
    );
    expect(encoded.droppedOverlaps).toBe(1);
    expect(await decode(encoded.data, structureLegendTypes())).toHaveLength(1);
  });

  it('按行、列升序编码（deltaLine 不得为负）', async () => {
    const encoded = encodeStructureTokens(
      [token({ startRow: 2, startCol: 0, endRow: 2 }), token({ startRow: 0, startCol: 1, endRow: 0, endCol: 2 }), token({ startRow: 0, startCol: 0, endRow: 0, endCol: 1 })],
      geometry(['ab', 'cd', 'ef']),
    );
    for (let i = 0; i < encoded.data.length; i += 5) expect(encoded.data[i]).toBeGreaterThanOrEqual(0);
    expect((await decode(encoded.data, structureLegendTypes())).map((d) => [d.line, d.startColumn])).toEqual([
      [1, 1],
      [1, 2],
      [3, 1],
    ]);
  });
});

/* ============================ 回落台账 ============================ */

describe('reportStructureDegradation · 一次性，但不静默', () => {
  beforeEach(() => {
    resetStructureDegradationLedger();
    vi.restoreAllMocks();
  });

  it('同一句话只说一遍（每击键重复报 = 刷屏）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seen: string[] = [];
    const un = onStructureDegradation((d) => seen.push(d.message));
    expect(reportStructureDegradation({ capability: 'folds', stage: 'query', message: '没有 @fold' })).toBe(true);
    expect(reportStructureDegradation({ capability: 'folds', stage: 'query', message: '没有 @fold' })).toBe(false);
    expect(seen).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    un();
    // 退订后仍计入台账（"这一种错说过"这件事与谁在听无关）
    expect(reportStructureDegradation({ capability: 'folds', stage: 'query', message: '没有 @fold' })).toBe(false);
  });

  it('换一面 / 换一句还是会说', () => {
    expect(reportStructureDegradation({ capability: 'folds', stage: 'query', message: 'x' })).toBe(true);
    expect(reportStructureDegradation({ capability: 'semantic', stage: 'query', message: 'x' })).toBe(true);
    expect(reportStructureDegradation({ capability: 'folds', stage: 'parse', message: 'y' })).toBe(true);
    expect(reportStructureDegradation({ capability: 'folds', stage: 'parse', message: 'y' })).toBe(false);
  });

  it('上屏文案说"退回原样"，不带机器词', () => {
    const text = degradationNoticeText({ capability: 'all', stage: 'wasm', message: '语法载入失败' });
    expect(text).toContain('结构解析');
    expect(text).toContain('已退回原来的配色与折叠');
    expect(text).not.toContain('tree-sitter');
    expect(text).not.toContain('semantic');
  });

  it('订阅者抛回来不许打断回落本身', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const un = onStructureDegradation(() => {
      throw new Error('通知链路坏了');
    });
    expect(() => reportStructureDegradation({ capability: 'indent', stage: 'query', message: 'z' })).not.toThrow();
    un();
  });
});

/* ============ 默认开 = 装配即激活；显式关 = 对 Monaco 零调用（闸门本体） ============ */

/** 计数桩：任何一次调用都记下来（显式关着时这张表必须是空的） */
function countingMonaco(): { monaco: typeof Monaco; calls: string[] } {
  const calls: string[] = [];
  const make = (path: string): unknown =>
    new Proxy(() => undefined, {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        return make(`${path}.${String(prop)}`);
      },
      apply: (_target, _thisArg, args) => {
        calls.push(`${path}(${args.length})`);
        // 返回"空可迭代 + dispose"：装配面既会 for-of 遍历 getEditors()，也会把返回值当 disposable 收下
        return Object.assign([], { dispose: () => undefined });
      },
    });
  return { monaco: make('monaco') as unknown as typeof Monaco, calls };
}

function storageWith(value: string | null): void {
  const store = new Map<string, string>();
  if (value !== null) store.set('kojo.ui.treeSitter.v1', value);
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
}

describe('installStructureOverlay · 默认开装配，显式关才一毫米都不动', () => {
  afterEach(() => {
    disposeStructureOverlay();
    delete (globalThis as { window?: unknown }).window;
  });

  /**
   * 空候选：本文件只判"装不装、动不动 Monaco"，真 wasm / worker 的装配归
   * `tree-sitter-default.test.ts` 与真壳冒烟；空表让激活体走完不触任何资源装载。
   */
  const noCandidates: never[] = [];

  it('node 环境（无 window ⇒ 偏好回默认开）：装配即激活并碰 Monaco 注册面', () => {
    const { monaco, calls } = countingMonaco();
    installStructureOverlay(monaco, noCandidates);
    expect(structureOverlayState()).toMatchObject({ installed: true, active: true, client: null });
    expect(calls.length).toBeGreaterThan(0);
  });

  it('localStorage 里没存过 / 脏值 ⇒ 仍然开（脏数据的方向是多露，不能把未关过的当关）', () => {
    storageWith('yes-please'); // 不是 'off' ⇒ 回默认（开）
    const { monaco, calls } = countingMonaco();
    installStructureOverlay(monaco, noCandidates);
    expect(structureOverlayState().active).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('显式存过 off ⇒ 装配不动 Monaco（零调用、active false）', () => {
    storageWith('off');
    const { monaco, calls } = countingMonaco();
    installStructureOverlay(monaco, noCandidates);
    expect(structureOverlayState()).toEqual({ installed: true, active: false, client: null });
    expect(calls).toEqual([]);
  });

  it('重复装配被幂等门挡住（第二次也不碰 Monaco）', () => {
    const { monaco, calls } = countingMonaco();
    installStructureOverlay(monaco, noCandidates);
    const afterFirst = calls.length;
    installStructureOverlay(monaco, noCandidates);
    expect(calls.length).toBe(afterFirst);
  });
});
