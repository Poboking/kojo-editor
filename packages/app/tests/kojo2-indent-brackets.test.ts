/**
 * K2-INDENT-BRACKETS 的闸：`queries/v2/indents.scm` 真捕获 + worker 的规则翻译 +
 * 括号配对 / 自动闭合（含 `@原生` 围栏守卫）+ 区间格式化。
 *
 * ## 打的是什么
 *
 * 1. **indents 真 wasm**：`queries/v2/indents.scm` 用出货 wasm 编译，捕获只落在开体行 /
 *    并列容器上，`@原生` 体内零捕获（围栏里长得像块头的行不进捕获表）；
 * 2. **worker 结果形状**：`indents` 回复从 `query-unavailable` 变成真 `Kojo2IndentRules`；
 *    规则是"行首锚 + 词形"派生（换表名 / 换条件不改规则），`mergeIndentConfig` 直接可吃；
 * 3. **括号配置逐项**：`brackets` / `autoClosingPairs` / `surroundingPairs` 同源一张表，
 *    `（）` / `[]` / `{}` / `「」` 都在，`""` 只进闭合与包裹两格；
 * 4. **`@原生` 不自动补**：围栏内刚打进去的开括号（Monaco 自动闭合留下的指纹）被 on-type
 *    层删掉闭括号；围栏外一个字都不碰。
 *
 * 区间格式化（规则 + provider 纪律）B3d 起不在这里：判据随包走
 * （`packages/kojo-lang/tests/format.test.ts` ⑧），宿主翻译在
 * `packages/app/tests/kojo2-format.test.ts`。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { stubMonaco } from './monarch-harness';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
// B4：成对记号的**真源在语言面库**，而"Monaco 实际拿到什么"由宿主落点翻译那一步决定。
// 本文件因此量 `toMonacoLanguageConfiguration(数据)` 的产物——它比旧口径（直接调宿主自己
// 装配配置的那枚函数）更真：上色与缩进在屏上生效的就是这一副对象。
import { KOJO2_LANGUAGE_CONFIGURATION, KOJO2_PAIRS } from '@kojo/kojo-lang/language-config';
import { toMonacoLanguageConfiguration } from '../src/monaco/monaco-language-surface';
import {
  installKojo2IndentProvider,
  KOJO2_AUTO_CLOSE_GUARD_TRIGGER_CHARS,
  KOJO2_INDENT_TRIGGER_CHARS,
  kojo2AutoCloseGuardEditsAt,
  kojo2IndentConfigWith,
} from '../src/monaco/kojo2-indent';
import { mergeIndentConfig, type BaseIndentPatterns } from '../src/monaco/tree-sitter/indent';
import {
  createKojo2WorkerEngine,
  indentRulesFromCaptures,
  KOJO2_WORKER_MAX_INDENT_PATTERNS,
  type Kojo2WorkerEngine,
} from '../src/monaco/tree-sitter/kojo2-worker';
import type { Kojo2Capture } from '../src/monaco/tree-sitter/kojo2-tokenizer';
import type { Kojo2IndentsReply } from '../src/monaco/tree-sitter/kojo2-worker-protocol';
import {
  disposeKojo2TreeSitterRuntime,
  getKojo2TreeSitterRuntime,
  type Kojo2RuntimeDeps,
} from '../src/monaco/tree-sitter/kojo2-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/app/tests → 仓库根 */
const REPO_ROOT = resolve(HERE, '../../..');
const SYNTAX_ROOT = join(REPO_ROOT, 'packages/kojo-syntax-tree');
const RUNTIME_WASM = join(REPO_ROOT, 'node_modules/web-tree-sitter/web-tree-sitter.wasm');
const GRAMMAR_WASM = join(SYNTAX_ROOT, 'tree-sitter-kojo2.wasm');
const FULL_FIXTURE = join(SYNTAX_ROOT, 'tests/v2-fixtures/full.kojo2');
const FIXTURE_TEXT = readFileSync(FULL_FIXTURE, 'utf8');

/** 生产资源的 Node 侧替身：直接读 workspace 内文件（不 fetch、不联网） */
function realRuntimeDeps(options: { withIndents?: boolean } = {}): Kojo2RuntimeDeps {
  return {
    loadAssets: async () => ({
      runtimeWasmUrl: RUNTIME_WASM,
      grammarWasm: GRAMMAR_WASM,
      highlightsQuery: readFileSync(join(SYNTAX_ROOT, 'queries/v2/highlights.scm'), 'utf8'),
      foldsQuery: readFileSync(join(SYNTAX_ROOT, 'queries/v2/folds.scm'), 'utf8'),
      ...(options.withIndents === false
        ? {} // 故意不给 indentsQuery：这一面必须回 query-unavailable，不是"没有规则"
        : { indentsQuery: readFileSync(join(SYNTAX_ROOT, 'queries/v2/indents.scm'), 'utf8') }),
    }),
  };
}

const engines: Kojo2WorkerEngine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) engine.dispose();
  await disposeKojo2TreeSitterRuntime();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ============================== 假 Monaco / 假 model ============================== */

interface FakeRegistration {
  readonly kind: 'onType';
  readonly id: string;
  readonly provider: unknown;
}

function fakeMonaco(): {
  readonly monaco: typeof Monaco;
  readonly registrations: FakeRegistration[];
  readonly dispose: ReturnType<typeof vi.fn>;
} {
  const registrations: FakeRegistration[] = [];
  const dispose = vi.fn();
  const register = (kind: 'onType', id: unknown, provider: unknown): Monaco.IDisposable => {
    registrations.push({ kind, id: String(id), provider });
    return { dispose };
  };
  const fake = {
    languages: {
      registerOnTypeFormattingEditProvider: (id: unknown, provider: unknown) =>
        register('onType', id, provider),
    },
  };
  return { monaco: fake as unknown as typeof Monaco, registrations, dispose };
}

/** 假 localStorage（`null` = 没存过 = stage v1-only；`'on'` = dual） */
function stubFlag(on: boolean): void {
  const store = new Map<string, string>();
  if (on) store.set('kojo.ui.kojo2Cutover.v1', 'on');
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        store.set(key, value);
      },
      removeItem: (key: string): void => {
        store.delete(key);
      },
    },
  });
}

interface FakeModel {
  readonly model: Monaco.editor.ITextModel;
  setText(text: string): void;
}

function fakeModel(initialText: string, languageId = KOJO2_LANGUAGE_ID): FakeModel {
  let text = initialText;
  const lineAt = (line: number): string => text.split(/\r\n|\r|\n/)[line - 1] ?? '';
  const model = {
    getValue: () => text,
    getLineContent: (line: number) => lineAt(line),
    getLineCount: () => text.split(/\r\n|\r|\n/).length,
    getLanguageId: () => languageId,
    uri: { fsPath: 'D:/proj/chara/灵梦/开场.kojo2' },
  } as unknown as Monaco.editor.ITextModel;
  return {
    model,
    setText(next) {
      text = next;
    },
  };
}

const positionAt = (line: number, column: number): Monaco.Position =>
  ({ lineNumber: line, column }) as Monaco.Position;

/* ============================== ① indents.scm：真 wasm 捕获 ============================== */

async function realIndentsReply(text: string): Promise<Kojo2IndentsReply> {
  const engine = createKojo2WorkerEngine({ loadRuntime: () => getKojo2TreeSitterRuntime(realRuntimeDeps()) });
  engines.push(engine);
  const reply = await engine.handle({ id: 1, type: 'indents', version: 1, text });
  if (!reply.ok) throw new Error(`indents 请求失败：${reply.reason} ${reply.message}`);
  if (reply.type !== 'indents') throw new Error(`期望 indents 回复，收到 ${reply.type}`);
  return reply;
}

/** 真 runtime 上的捕获表（与 worker 用的同一条装载链） */
async function realIndentsCaptures(text: string): Promise<{
  captures: readonly Kojo2Capture[];
  nativeRanges: readonly { from: number; to: number }[];
}> {
  const loaded = await getKojo2TreeSitterRuntime(realRuntimeDeps());
  if (!loaded.ok) throw new Error(`运行时装载失败：${loaded.reason} ${loaded.message}`);
  expect(loaded.runtime.queryStatus('indents').ok).toBe(true);
  const parsed = loaded.runtime.parse(text);
  if (!parsed.ok) throw new Error(`解析失败：${parsed.reason} ${parsed.message}`);
  const captured = loaded.runtime.queryCaptures(parsed.rootNode, 'indents');
  if (!captured.ok) throw new Error(`indents 查询失败：${captured.reason} ${captured.message}`);
  const nativeRanges: { from: number; to: number }[] = [];
  const walk = (node: import('web-tree-sitter').Node): void => {
    if (node.type === 'native_body') {
      // `native_body` 起点是栏头行末的零宽 `indent` 记号 ⇒ 体内从下一行起
      nativeRanges.push({ from: node.startPosition.row + 1, to: node.endPosition.row });
    }
    for (const child of node.children) walk(child);
  };
  walk(parsed.rootNode);
  parsed.tree.delete();
  return { captures: captured.captures, nativeRanges };
}

describe('① indents.scm：真 wasm 捕获（K2-INDENT-BRACKETS）', () => {
  it('查询能在出货 wasm 上编译，捕获名只有 increase / align，且在 full.kojo2 上有命中', async () => {
    const { captures } = await realIndentsCaptures(FIXTURE_TEXT);
    expect(captures.length).toBeGreaterThan(20);
    expect([...new Set(captures.map((capture) => capture.name))].sort()).toEqual([
      'indent.align',
      'indent.increase',
    ]);
  });

  it('五锚点开体行逐格命中：表头 / 池头 / 模头 / @块头 / `?` 链 / `? 否` / `@原生` 栏头', async () => {
    const { captures } = await realIndentsCaptures(FIXTURE_TEXT);
    const rows = new Set(
      captures.filter((capture) => capture.name === 'indent.increase').map((capture) => capture.startPosition.row + 1),
    );
    // 1 基行号；夹具见 packages/kojo-syntax-tree/tests/v2-fixtures/full.kojo2
    for (const row of [11, 17, 26, 39, 48, 53, 56, 61, 63, 72, 82, 86, 100, 106, 111, 122]) {
      expect(rows.has(row), `第 ${row} 行没有开体捕获`).toBe(true);
    }
    // 单行声明 / 旁白 / 台词 / `!` 触发不会进开体捕获（`!` 的裸调用行太常见，§7.2 判不准）
    for (const row of [1, 31, 32, 117, 118]) {
      expect(rows.has(row), `第 ${row} 行不该是开体行`).toBe(false);
    }
  });

  it('并列容器对齐捕获覆盖表两列 / 池分支链 / 随机候选 / 组体', async () => {
    const { captures } = await realIndentsCaptures(FIXTURE_TEXT);
    const alignRows = captures
      .filter((capture) => capture.name === 'indent.align')
      .map((capture) => capture.startPosition.row + 1);
    expect(alignRows).toContain(12); // 表第一行
    expect(alignRows).toContain(18); // # 池 的首条分支（分支层）
    expect(alignRows).toContain(62); // @随机 的首条候选
    expect(alignRows).toContain(64); // @组 的组体首行
    expect(alignRows.length).toBeGreaterThan(5);
  });

  it('`@原生` 围栏体内零捕获（围栏里长得像块头的行不会进捕获表）', async () => {
    const { captures, nativeRanges } = await realIndentsCaptures(FIXTURE_TEXT);
    expect(nativeRanges.length).toBeGreaterThan(0);
    for (const capture of captures) {
      for (const range of nativeRanges) {
        const row = capture.startPosition.row;
        expect(
          row >= range.from && row <= range.to,
          `第 ${row + 1} 行的 ${capture.name} 落在 @原生 体内`,
        ).toBe(false);
      }
    }
  });
});

/* ============================== ② worker：捕获 → 宿主三条腿 ============================== */

describe('② worker indents：从 query-unavailable 转真实规则', () => {
  it('真回环：回复 ok、type=indents、三条腿都是字符串数组、带 treeId 与 queryMs', async () => {
    const reply = await realIndentsReply(FIXTURE_TEXT);
    expect(reply.type).toBe('indents');
    expect(typeof reply.treeId).toBe('string');
    expect(reply.treeId.length).toBeGreaterThan(0);
    expect(reply.queryMs).toBeGreaterThanOrEqual(0);
    for (const leg of [reply.rules.increasePatterns, reply.rules.decreasePatterns, reply.rules.enterPatterns]) {
      expect(Array.isArray(leg)).toBe(true);
      for (const pattern of leg) expect(typeof pattern).toBe('string');
    }
  });

  it('规则是"行首锚 + 词形"：覆盖 # 对照表 / # 池 / # 模 / @ 块头 / ? 链 / @原生，且换实参仍命中', async () => {
    const reply = await realIndentsReply(FIXTURE_TEXT);
    const patterns = reply.rules.increasePatterns.map((source) => new RegExp(source));
    const hits = (line: string): boolean => patterns.some((pattern) => pattern.test(line));
    for (const line of [
      '# 对照表 心情 依据 恋慕',
      '# 对照表 别的名字 依据 其他表达式',
      '# 池 任意名字',
      '# 模 别的模板(参数)',
      '@算',
      '@随机',
      '@组',
      '@循 任意条件',
      '@巡 任意集合',
      '@复 任意次数',
      '@函 别的函数(a, b=1)',
      '@织 别的事件 之后',
      '@着色 0xFF0000',
      '@原生',
      '? 任意条件',
      '? 否',
      '?否',
    ]) {
      expect(hits(line), `没有规则命中：${line}`).toBe(true);
    }
    // 非开体形状不被误伤（`!` 的裸调用行与触发块头同形，§7.2 判不准 ⇒ 不进规则）
    for (const line of ['> 旁白', '灵梦：「台词」', '! 早安问候', '! 记录("{目标}")', '# 幕 开场', '# 设 数 整数', '@颜绘 笑顔', '// 注释']) {
      expect(hits(line), `不该命中：${line}`).toBe(false);
    }
    for (const pattern of patterns) expect(pattern.test('    CALL HPH_PRINT "w"')).toBe(false);
  });

  it('decrease 恒空（2.0 没有收束记号）；enter 与 increase 同批源码（回车 / 粘贴同口径）', async () => {
    const reply = await realIndentsReply(FIXTURE_TEXT);
    expect(reply.rules.decreasePatterns).toEqual([]);
    expect(reply.rules.enterPatterns).toEqual(reply.rules.increasePatterns);
  });

  it('宿主 mergeIndentConfig 直接消费：不拒绝、有增量、onEnterRules 与 increase 同步', async () => {
    const reply = await realIndentsReply(FIXTURE_TEXT);
    const EMPTY_BASE: BaseIndentPatterns = {
      indentOnEnter: [],
      increaseIndentPattern: /(?!)/,
      decreaseIndentPattern: /(?!)/,
    };
    const merged = mergeIndentConfig(EMPTY_BASE, reply.rules);
    expect(merged).not.toBeNull();
    if (merged === null) return;
    expect(merged.rejected).toBe(0);
    // 同批源码进两条腿（enter + increase）⇒ added 按两条腿各数一次
    expect(merged.added).toBe(
      reply.rules.enterPatterns.length + reply.rules.increasePatterns.length + reply.rules.decreasePatterns.length,
    );
    expect(merged.onEnterRules.length).toBe(reply.rules.enterPatterns.length);
    expect(merged.increaseIndentPattern.test('# 对照表 甲 依据 乙')).toBe(true);
    expect(merged.increaseIndentPattern.test('> 旁白')).toBe(false);
    // 同一份规则问两次：去重键稳定（宿主不会每次回复都重写语言配置）
    const again = mergeIndentConfig(EMPTY_BASE, reply.rules);
    expect(again?.key).toBe(merged.key);
  });

  it('宿主便捷口 kojo2IndentConfigWith：2.0 回车判据作基底，结构层规则只加在后面', async () => {
    const reply = await realIndentsReply(FIXTURE_TEXT);
    const merged = kojo2IndentConfigWith(reply.rules);
    expect(merged).not.toBeNull();
    if (merged === null) return;
    expect(merged.rejected).toBe(0);
    // 基底两格一条不撤：`@原生` 栏头 + 行尾全角冒号
    expect(merged.onEnterRules.some((rule) => rule.beforeText.test('@原生'))).toBe(true);
    expect(merged.onEnterRules.some((rule) => rule.beforeText.test('选项：'))).toBe(true);
    // 结构层增量也在：换表名的 `# 对照表` 与 `?` 链
    expect(merged.increaseIndentPattern.test('# 对照表 别的 依据 心情')).toBe(true);
    expect(merged.increaseIndentPattern.test('? 任意条件')).toBe(true);
    // 空规则 = 一个字都不发
    expect(kojo2IndentConfigWith(null)).toBeNull();
    expect(
      kojo2IndentConfigWith({ increasePatterns: [], decreasePatterns: [], enterPatterns: [] }),
    ).toBeNull();
  });

  it('没有开体行的文档：ok + 三条腿全空（不是 query-unavailable）', async () => {
    const reply = await realIndentsReply('> 一行旁白。\n灵梦：「早上好。」\n');
    expect(reply.rules).toEqual({ increasePatterns: [], decreasePatterns: [], enterPatterns: [] });
  });

  it('查询缺席 ⇒ query-unavailable（可判别，不冒充"没有规则"）', async () => {
    const engine = createKojo2WorkerEngine({
      loadRuntime: () => getKojo2TreeSitterRuntime(realRuntimeDeps({ withIndents: false })),
    });
    engines.push(engine);
    const reply = await engine.handle({ id: 1, type: 'indents', version: 1, text: '# 对照表 甲 依据 乙\n    0..1 丙\n' });
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.reason).toBe('query-unavailable');
    expect(reply.message).toContain('indents');
  });

  it('纯函数：对齐 / decrease 档按口径处理，坐标坏值跳过、上限生效、永不抛', () => {
    const capture = (name: string, row: number, column = 0): Kojo2Capture => ({
      name,
      startPosition: { row, column },
      endPosition: { row, column },
    });
    const text = '# 对照表 甲 依据 乙\n    ? 条件\n? 否\n@算\n';
    const rules = indentRulesFromCaptures(
      [
        capture('indent.increase', 0),
        capture('indent.align', 1, 4),
        capture('indent.decrease', 2),
        capture('indent.enter', 3),
      ],
      text,
    );
    // increase 与 enter 都落进 increase 腿（回车 / 粘贴同口径）⇒ 两条开体行各一条规则
    expect(rules.increasePatterns).toHaveLength(2);
    expect(rules.increasePatterns.some((source) => new RegExp(source).test('# 对照表 别的 依据 心情'))).toBe(true);
    expect(rules.enterPatterns).toEqual(rules.increasePatterns);
    expect(rules.decreasePatterns).toHaveLength(1);
    expect(new RegExp(rules.decreasePatterns[0]!).test('? 别的条件')).toBe(true);

    const capped = indentRulesFromCaptures(
      [capture('indent.increase', 0), capture('indent.increase', 3)],
      text,
      1,
    );
    expect(capped.increasePatterns).toHaveLength(1);
    expect(KOJO2_WORKER_MAX_INDENT_PATTERNS).toBeGreaterThanOrEqual(16);

    expect(
      indentRulesFromCaptures(
        [
          capture('indent.increase', 99),
          capture('indent.increase', -1),
          capture('indent.increase', Number.NaN),
          capture('indent.align', 0),
          capture('not.indent', 0),
        ],
        text,
      ),
    ).toEqual({ increasePatterns: [], decreasePatterns: [], enterPatterns: [] });
    expect(indentRulesFromCaptures([], '')).toEqual({
      increasePatterns: [],
      decreasePatterns: [],
      enterPatterns: [],
    });
  });
});

/* ============================== ③ 括号配置（语言面 additive） ============================== */

const { monaco: configMonaco } = stubMonaco();
const LANGUAGE_CONFIG = toMonacoLanguageConfiguration(
  configMonaco,
  KOJO2_LANGUAGE_CONFIGURATION,
  'kojo2-indent-brackets',
);

function pairKey(open: string, close: string): string {
  return `${open}${close}`;
}

describe('③ 括号配置：brackets / autoClosingPairs / surroundingPairs 同源一张表', () => {
  it('brackets 覆盖 （） / [] / {} / 「」，不含 open===close 的 `""`', () => {
    const brackets = (LANGUAGE_CONFIG.brackets ?? []).map((pair) => pairKey(pair[0], pair[1]));
    for (const key of ['（）', '[]', '{}', '「」', '()']) expect(brackets, `brackets 缺 ${key}`).toContain(key);
    expect(brackets).not.toContain('""');
  });

  it('autoClosingPairs 逐项：四类括号 + 半角括号 + 引号（含 2.0 的 `[]`）', () => {
    const pairs = (LANGUAGE_CONFIG.autoClosingPairs ?? []).map((pair) => pairKey(pair.open, pair.close));
    for (const key of ['（）', '[]', '{}', '「」', '()', '""']) expect(pairs, `自动闭合缺 ${key}`).toContain(key);
    expect(pairs).toHaveLength(KOJO2_PAIRS.length);
  });

  it('surroundingPairs 与 autoClosingPairs 逐项相等（能自动闭合的也必须能包围）', () => {
    expect(LANGUAGE_CONFIG.surroundingPairs).toEqual(LANGUAGE_CONFIG.autoClosingPairs);
  });

  it('三格都由同一张 KOJO2_PAIRS 派生（没有第二份成对记号表）', () => {
    const fromTable = KOJO2_PAIRS.map(([open, close]) => pairKey(open, close));
    expect((LANGUAGE_CONFIG.autoClosingPairs ?? []).map((pair) => pairKey(pair.open, pair.close))).toEqual(fromTable);
    expect((LANGUAGE_CONFIG.brackets ?? []).map((pair) => pairKey(pair[0], pair[1]))).toEqual(
      KOJO2_PAIRS.filter(([open, close]) => open !== close).map(([open, close]) => pairKey(open, close)),
    );
  });

  it('`：` / `，` / `『』` 不是括号对（块头终止符与字面文本不进表）', () => {
    const pairs = (LANGUAGE_CONFIG.autoClosingPairs ?? []).map((pair) => pairKey(pair.open, pair.close));
    for (const key of ['：', '，', '『』']) expect(pairs).not.toContain(key);
  });
});

/* ============================== ④ `@原生` 围栏内不自动补 ============================== */

describe('④ 围栏内自动闭合守卫：只删 Monaco 自动补出来的闭括号', () => {
  it('`@原生` 体内：刚打进 `「` ⇒ 删掉自动补的 `」`', () => {
    const fake = fakeModel('@原生\n    CALL X「」\n');
    // 行 2 内容 `    CALL X「」`：`「` 在 0 基 10，光标在它之后 ⇒ column 12
    expect(kojo2AutoCloseGuardEditsAt(fake.model, positionAt(2, 12), '「')).toEqual([
      {
        range: { startLineNumber: 2, startColumn: 12, endLineNumber: 2, endColumn: 13 },
        text: '',
      },
    ]);
  });

  it('围栏内空行（`native` 记录）也守：`（` 自动补的 `）` 被删', () => {
    const fake = fakeModel('@原生\n    CALL X\n\n（\n');
    // 第 4 行 `（` 缩进 0 ⇒ 已经退出围栏（围栏体必须更深）⇒ 不删
    expect(kojo2AutoCloseGuardEditsAt(fake.model, positionAt(4, 2), '（')).toEqual([]);
    // 缩进更深时才在围栏内
    const inside = fakeModel('@原生\n    CALL X\n\n    （）\n');
    expect(kojo2AutoCloseGuardEditsAt(inside.model, positionAt(4, 6), '（')).toHaveLength(1);
  });

  it('围栏外（旁白 / 台词 / 块体）⇒ 一个字都不碰', () => {
    const narration = fakeModel('> 旁白「」\n');
    expect(kojo2AutoCloseGuardEditsAt(narration.model, positionAt(1, 6), '「')).toEqual([]);
    const speech = fakeModel('灵梦：「」\n');
    expect(kojo2AutoCloseGuardEditsAt(speech.model, positionAt(1, 5), '「')).toEqual([]);
    // 围栏结束后去缩进的那一行不再是 native
    const after = fakeModel('@原生\n    CALL X\n「」\n');
    expect(kojo2AutoCloseGuardEditsAt(after.model, positionAt(3, 2), '「')).toEqual([]);
  });

  it('指纹不完整（没自动补 / 触发的不是开括号）⇒ 空结果', () => {
    const noClose = fakeModel('@原生\n    CALL X「\n');
    expect(kojo2AutoCloseGuardEditsAt(noClose.model, positionAt(2, 12), '「')).toEqual([]);
    const wrongTrigger = fakeModel('@原生\n    CALL X「」\n');
    expect(kojo2AutoCloseGuardEditsAt(wrongTrigger.model, positionAt(2, 12), '（')).toEqual([]);
    const closeTrigger = fakeModel('@原生\n    CALL X「」\n');
    expect(kojo2AutoCloseGuardEditsAt(closeTrigger.model, positionAt(2, 13), '」')).toEqual([]);
  });

  it('非 kojo2 语言 / 模型取文抛错 ⇒ 空结果（不掀桌子）', () => {
    const other = fakeModel('@原生\n    CALL X「」\n', 'erb');
    expect(kojo2AutoCloseGuardEditsAt(other.model, positionAt(2, 13), '「')).toEqual([]);
    const broken = {
      getLineContent: () => '    CALL X「」',
      getValue: () => {
        throw new Error('模型已释放');
      },
      getLanguageId: () => KOJO2_LANGUAGE_ID,
    } as unknown as Monaco.editor.ITextModel;
    expect(kojo2AutoCloseGuardEditsAt(broken, positionAt(2, 13), '「')).toEqual([]);
  });

  it('provider 一条龙：flag 开注册一枚 on-type，触发字符两族；围栏内请求回删除编辑', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    const handle = installKojo2IndentProvider(fake.monaco);
    expect(fake.registrations.map((entry) => [entry.kind, entry.id])).toEqual([['onType', KOJO2_LANGUAGE_ID]]);
    const provider = fake.registrations[0]!.provider as Monaco.languages.OnTypeFormattingEditProvider;
    expect(provider.autoFormatTriggerCharacters).toEqual([
      ...KOJO2_INDENT_TRIGGER_CHARS,
      ...KOJO2_AUTO_CLOSE_GUARD_TRIGGER_CHARS,
    ]);
    expect([...KOJO2_AUTO_CLOSE_GUARD_TRIGGER_CHARS]).toEqual(['{', '[', '「', '（', '(', '"']);
    const model = fakeModel('@原生\n    CALL X「」\n').model;
    expect(provider.provideOnTypeFormattingEdits(model, positionAt(2, 12), '「', {} as never, {} as never)).toHaveLength(1);
    handle.dispose();
    handle.dispose();
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });

  it('flag 关 ⇒ 照挂（缩进是语言面，不看切流阶段）', () => {
    stubFlag(false);
    const fake = fakeMonaco();
    const handle = installKojo2IndentProvider(fake.monaco);
    expect(fake.registrations.map((entry) => [entry.kind, entry.id])).toEqual([['onType', KOJO2_LANGUAGE_ID]]);
    handle.dispose();
    handle.dispose();
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });
});

/* ============================== ⑤⑥ 已随 B3d 搬走 ============================== */

// 区间格式化的**规则**（`formatKojo2Range`：只动选中行 / 保留 CRLF / 非法行号原样返回）与
// **provider 纪律**（共享收口 + `lineRange` 请求 + 三态）B3d 起各有各的闸：
// - 规则：`packages/kojo-lang/tests/format.test.ts` ⑧（判据跟包走）；
// - 宿主翻译：`packages/app/tests/kojo2-format.test.ts`（契约 → Monaco / 两条请求 / 注册）。
// 本文件保留 indents.scm 真 wasm、worker 规则形状、括号配置与 `@原生` 守卫那四组。
