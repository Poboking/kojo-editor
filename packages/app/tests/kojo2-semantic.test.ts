/**
 * Kojo 2.0 语义着色 provider 的闸（K2 batch-3）。
 *
 * 钉五件事：
 * 1. **legend 与主题逐字对齐**：legend 的每个 tokenType 都在 `KOJO2_THEME_RULES` /
 *    `KOJO2_THEME_TOKEN_MAP` 里，且前景色 / 字体样式逐格相等（不另造色板）；
 * 2. **capture 表不漏档**：`queries/v2/highlights.scm` 里出现的每个捕获名（`@none` 除外）
 *    都在这张表里——查询加档而映射没加时这里先红，而不是静默掉色；
 * 3. **5 元组编码**：首 token 绝对行/列、同行相对列、零宽 / legend 外 / 重叠的处理；
 * 4. **增量与所有权**：版本变了才把旧树交给 `parse`，拿到新树后旧树立即 `delete()`；
 *    同一版本重复问命中缓存（不重解）；
 * 5. **失败面与注册纪律**：运行时不可用 / parse 失败 / 捕获失败 / 内部异常 ⇒ 空 tokens、
 *    不抛、warn 一次；flag 关 ⇒ 零注册；dispose 幂等。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import type { Tree } from 'web-tree-sitter';
import { KOJO2_THEME_RULES, KOJO2_TOKEN } from '../src/monaco/kojo2-language';
import { KOJO2_THEME_TOKEN_MAP, KOJO2_THEMES, KOJO2_THEME_IDS } from '../src/monaco/kojo2-theme';
import {
  KOJO2_CAPTURE_TOKEN_TYPES,
  KOJO2_SEMANTIC_TOKEN_LEGEND,
  KOJO2_SEMANTIC_TOKEN_TYPES,
  createKojo2SemanticTokensProvider,
  encodeKojo2SemanticTokens,
  installKojo2SemanticTokensProvider,
  mapKojo2Captures,
} from '../src/monaco/kojo2-semantic';
import type { Kojo2Capture, Kojo2TokenSpan } from '../src/monaco/tree-sitter/kojo2-tokenizer';
import type {
  Kojo2CaptureResult,
  Kojo2ParseResult,
  Kojo2RuntimeResult,
  Kojo2TreeSitterRuntime,
} from '../src/monaco/tree-sitter/kojo2-runtime';
import {
  disposeKojo2TreeSitterRuntime,
  getKojo2TreeSitterRuntime,
} from '../src/monaco/tree-sitter/kojo2-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const HIGHLIGHTS_SCM = resolve(HERE, '../../kojo-syntax-tree/queries/v2/highlights.scm');
/** packages/app/tests → 仓库根 */
const REPO_ROOT = resolve(HERE, '../../..');

afterEach(async () => {
  await disposeKojo2TreeSitterRuntime();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ============================== 假 Monaco / 假 model ============================== */

interface FakeRegistration {
  readonly id: string;
  readonly provider: Monaco.languages.DocumentSemanticTokensProvider;
}

function fakeMonaco(): {
  readonly monaco: typeof Monaco;
  readonly registrations: FakeRegistration[];
  readonly dispose: ReturnType<typeof vi.fn>;
} {
  const registrations: FakeRegistration[] = [];
  const dispose = vi.fn();
  const fake = {
    languages: {
      registerDocumentSemanticTokensProvider: (
        id: string,
        provider: Monaco.languages.DocumentSemanticTokensProvider,
      ): Monaco.IDisposable => {
        registrations.push({ id, provider });
        return { dispose };
      },
    },
  };
  return { monaco: fake as unknown as typeof Monaco, registrations, dispose };
}

/** 假 localStorage（`null` = 没存过 = flag 关；`'on'` = 开） */
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
  setText(text: string, version?: number): void;
  readonly deleted: () => boolean;
}

function fakeModel(initialText: string, initialVersion = 1): FakeModel {
  let text = initialText;
  let version = initialVersion;
  let disposed = false;
  const model = {
    getValue: () => text,
    getVersionId: () => version,
    isDisposed: () => disposed,
    getLineCount: () => text.split('\n').length,
    getLineMaxColumn: (line: number) => (text.split('\n')[line - 1] ?? '').length + 1,
    uri: { fsPath: 'D:/proj/chara/灵梦/开场.kojo2' },
  } as unknown as Monaco.editor.ITextModel;
  return {
    model,
    setText(next, nextVersion) {
      text = next;
      version = nextVersion ?? version + 1;
    },
    deleted: () => disposed,
  };
}

/* ============================== 假运行时 ============================== */

interface FakeTree {
  readonly tree: Tree;
  readonly deleted: () => number;
}

function fakeTree(): FakeTree {
  let deletes = 0;
  const tree = {
    delete: () => {
      deletes += 1;
    },
  } as unknown as Tree;
  return { tree, deleted: () => deletes };
}

interface FakeRuntimeLog {
  parseCalls: { text: string; oldTree: Tree | null }[];
  captureCalls: number;
}

interface FakeRuntimeOptions {
  readonly captures?: (() => Kojo2CaptureResult) | undefined;
  readonly parse?: (text: string, oldTree: Tree | null) => Kojo2ParseResult;
  /** 每次 parse 交出去的新树（不进这里 = 自动造一棵） */
  readonly trees?: FakeTree[];
}

function fakeRuntime(options: FakeRuntimeOptions = {}): {
  readonly runtime: Kojo2TreeSitterRuntime;
  readonly log: FakeRuntimeLog;
  readonly trees: FakeTree[];
} {
  const log: FakeRuntimeLog = { parseCalls: [], captureCalls: 0 };
  const trees = options.trees ?? [];
  let nextTree = 0;
  const runtime: Kojo2TreeSitterRuntime = {
    initMs: 0,
    parse(text, oldTree = null) {
      log.parseCalls.push({ text, oldTree });
      if (options.parse) return options.parse(text, oldTree);
      const entry = trees[nextTree] ?? fakeTree();
      trees[nextTree] = entry;
      nextTree += 1;
      return {
        ok: true,
        tree: entry.tree,
        rootNode: {} as never,
        incremental: oldTree !== null,
        changedRanges: [],
        textLength: text.length,
      };
    },
    captures() {
      log.captureCalls += 1;
      if (options.captures) return options.captures();
      return { ok: true, captures: [] };
    },
    dispose() {
      /* 本 provider 不释放运行时单例 */
    },
  };
  return { runtime, log, trees };
}

function okRuntime(runtime: Kojo2TreeSitterRuntime): () => Promise<Kojo2RuntimeResult> {
  return async () => ({ ok: true, runtime });
}

function capture(name: string, startRow: number, startCol: number, endRow: number, endCol: number): Kojo2Capture {
  return { name, startPosition: { row: startRow, column: startCol }, endPosition: { row: endRow, column: endCol } };
}

/* ============================== 解码（断言用；与 Monaco 的 lastLineNumber=1 同口径） ============================== */

interface DecodedToken {
  readonly line: number;
  readonly startColumn: number;
  readonly length: number;
  readonly type: number;
  readonly bits: number;
}

function decode(data: Uint32Array): DecodedToken[] {
  const out: DecodedToken[] = [];
  let line = 0;
  let start = 0;
  for (let i = 0; i < data.length; i += 5) {
    line += data[i]!;
    start = data[i] === 0 ? start + data[i + 1]! : data[i + 1]!;
    out.push({
      line,
      startColumn: start,
      length: data[i + 2]!,
      type: data[i + 3]!,
      bits: data[i + 4]!,
    });
  }
  return out;
}

/** provider 的返回是 `SemanticTokens | SemanticTokensEdits`；本 provider 只发整份 data */
function dataOf(result: unknown): Uint32Array {
  if (result === null || typeof result !== 'object' || !('data' in result)) {
    throw new Error('provider 没有交出整份 SemanticTokens.data');
  }
  return (result as { data: Uint32Array }).data;
}

/* ============================== legend ↔ 主题 ============================== */

describe('legend · 与 kojo2-theme 的主题规则逐字对齐', () => {
  it('legend 的每个 tokenType 都是一条主题规则，且暗色侧前景 / 字体样式逐格相等', () => {
    expect(KOJO2_SEMANTIC_TOKEN_LEGEND.tokenModifiers).toEqual([]);
    const rules = new Map(KOJO2_THEME_RULES.map((rule) => [rule.token, rule]));
    for (const token of KOJO2_SEMANTIC_TOKEN_TYPES) {
      const rule = rules.get(token);
      expect(rule, `legend「${token}」在 KOJO2_THEME_RULES 里没有规则`).toBeDefined();
      const themeStyle = KOJO2_THEME_TOKEN_MAP[token].dark;
      expect({ foreground: rule!.foreground, fontStyle: rule!.fontStyle }).toEqual({
        foreground: themeStyle.foreground,
        ...(themeStyle.fontStyle === undefined ? {} : { fontStyle: themeStyle.fontStyle }),
      });
    }
  });

  it('三套 2.0 主题的 rules 都覆盖 legend 的每一档（亮色 / 墨绿不靠继承）', () => {
    for (const id of KOJO2_THEME_IDS) {
      const defined = new Set(KOJO2_THEMES[id].rules.map((rule) => rule.token));
      for (const token of KOJO2_SEMANTIC_TOKEN_TYPES) expect(defined.has(token), `${id} 缺 ${token}`).toBe(true);
    }
  });

  it('legend = capture 表实际用到的档位（声明序稳定、无重复）', () => {
    const used = [...new Set(Object.values(KOJO2_CAPTURE_TOKEN_TYPES))];
    expect([...KOJO2_SEMANTIC_TOKEN_TYPES]).toEqual(used);
    expect(new Set(KOJO2_SEMANTIC_TOKEN_LEGEND.tokenTypes).size).toBe(
      KOJO2_SEMANTIC_TOKEN_LEGEND.tokenTypes.length,
    );
    for (const token of KOJO2_SEMANTIC_TOKEN_TYPES) {
      expect(KOJO2_SEMANTIC_TOKEN_LEGEND.tokenTypes).toContain(token);
    }
  });

  it('highlights.scm 里的每个捕获名（`none` 除外）都有档位映射', () => {
    const query = readFileSync(HIGHLIGHTS_SCM, 'utf8');
    // 只认**真正的捕获注解行**（`(node) @capture`）：头注里也会出现 `@keyword.*` 这类
    // 说明文字，按整篇扫会把它们误当成捕获名。
    const names = new Set<string>();
    for (const line of query.split(/\r?\n/)) {
      const match = /^\s*\([^)]*\)\s*@([A-Za-z][\w.]*)\s*$/.exec(line);
      if (match !== null) names.add(match[1]!);
    }
    names.delete('none');
    expect(names.size).toBeGreaterThan(5); // 反空匹配自证
    for (const name of names) {
      expect(KOJO2_CAPTURE_TOKEN_TYPES[name], `查询捕获「@${name}」没有档位`).toBeDefined();
    }
  });

  it('mapKojo2Captures：档位翻译、`none` 跳过、未知 capture 丢掉并只报一次', () => {
    const unknown: string[] = [];
    const mapped = mapKojo2Captures(
      [
        capture('keyword', 0, 0, 0, 1),
        capture('@string', 0, 1, 0, 2),
        capture('none', 0, 2, 0, 3),
        capture('directive.unknown', 0, 3, 0, 4),
      ],
      (name) => unknown.push(name),
    );
    expect(mapped.map((item) => item.name)).toEqual([KOJO2_TOKEN.keyword, KOJO2_TOKEN.speech]);
    expect(unknown).toEqual(['directive.unknown']);
  });
});

/* ============================== 5 元组编码 ============================== */

describe('encodeKojo2SemanticTokens · delta 编码', () => {
  const span = (line: number, startColumn: number, endColumn: number, tokenType: string): Kojo2TokenSpan => ({
    line,
    startColumn,
    endColumn,
    tokenType,
  });

  it('空输入 → 长度 0（认这份文件但无可着色区间）', () => {
    expect(encodeKojo2SemanticTokens([])).toEqual(new Uint32Array(0));
  });

  it('首 token 绝对行 / 绝对列；换行后 deltaStart 取绝对列；同行取相对列', () => {
    const keyword = KOJO2_TOKEN.keyword;
    const data = encodeKojo2SemanticTokens([
      span(3, 5, 9, keyword),
      span(3, 12, 14, keyword),
      span(7, 2, 6, keyword),
    ]);
    expect(decode(data)).toEqual([
      { line: 3, startColumn: 5, length: 4, type: 1, bits: 0 },
      { line: 3, startColumn: 12, length: 2, type: 1, bits: 0 },
      { line: 7, startColumn: 2, length: 4, type: 1, bits: 0 },
    ]);
    expect(Array.from(data.slice(0, 5))).toEqual([3, 5, 4, 1, 0]);
  });

  it('零宽 / 未知 tokenType / 同行重叠：都不进数据（先到的留下）', () => {
    const keyword = KOJO2_TOKEN.keyword;
    const data = encodeKojo2SemanticTokens([
      span(2, 1, 1, keyword), // 零宽
      span(2, 3, 9, keyword),
      span(2, 5, 7, keyword), // 与先到的重叠 ⇒ 丢
      span(2, 12, 15, 'no-such-type'), // legend 外
    ]);
    expect(decode(data)).toEqual([{ line: 2, startColumn: 3, length: 6, type: 1, bits: 0 }]);
  });
});

/* ============================== provider · 增量 / 缓存 / 所有权 ============================== */

describe('provider · 增量解析与版本缓存', () => {
  it('首解整篇、版本变了才拿旧树增量、旧树拿到新树后立即 delete', async () => {
    const { runtime, log, trees } = fakeRuntime();
    const handle = createKojo2SemanticTokensProvider({ getRuntime: okRuntime(runtime) });
    const fake = fakeModel('> 第一行。\n');
    const first = await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    expect(first).toEqual({ data: new Uint32Array(0) });
    expect(log.parseCalls).toHaveLength(1);
    expect(log.parseCalls[0]!.oldTree).toBeNull();
    expect(trees[0]!.deleted()).toBe(0);

    // 同一版本重复问：命中缓存，一次 parse 都不多
    await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    expect(log.parseCalls).toHaveLength(1);

    fake.setText('> 第一行改。\n', 2);
    await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    expect(log.parseCalls).toHaveLength(2);
    expect(log.parseCalls[1]!.oldTree).toBe(trees[0]!.tree);
    expect(trees[0]!.deleted()).toBe(1); // 旧树已被增量解改写过 ⇒ 立即释放

    handle.dispose();
    expect(trees[1]!.deleted()).toBe(1);
  });

  it('dispose 幂等：缓存树只 delete 一次，之后请求回空且不再 parse', async () => {
    const { runtime, log, trees } = fakeRuntime();
    const handle = createKojo2SemanticTokensProvider({ getRuntime: okRuntime(runtime) });
    const fake = fakeModel('> 一行。\n');
    await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    handle.dispose();
    handle.dispose();
    expect(trees[0]!.deleted()).toBe(1);
    const after = await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    expect(after).toEqual({ data: new Uint32Array(0) });
    expect(log.parseCalls).toHaveLength(1);
  });
});

/* ============================== provider · 着色结果 ============================== */

describe('provider · capture → 5 元组', () => {
  it('真捕获走完整链路：捕获名 → 档位 → 区间 → legend 下标', async () => {
    const { runtime } = fakeRuntime({
      captures: () => ({
        ok: true,
        captures: [capture('keyword', 0, 0, 0, 2), capture('variable', 0, 3, 0, 5), capture('none', 0, 6, 0, 7)],
      }),
    });
    const handle = createKojo2SemanticTokensProvider({ getRuntime: okRuntime(runtime) });
    const fake = fakeModel('# 幕 灵梦\n');
    const result = await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    const keywordAt = KOJO2_SEMANTIC_TOKEN_TYPES.indexOf(KOJO2_TOKEN.keyword);
    const speakerAt = KOJO2_SEMANTIC_TOKEN_TYPES.indexOf(KOJO2_TOKEN.speaker);
    expect(decode(dataOf(result))).toEqual([
      { line: 1, startColumn: 1, length: 2, type: keywordAt, bits: 0 },
      { line: 1, startColumn: 4, length: 2, type: speakerAt, bits: 0 },
    ]);
  });
});

/* ============================== provider · 失败面 ============================== */

describe('provider · 失败一律空 tokens、不抛、只 warn 一次', () => {
  it('运行时 unavailable ⇒ 空 tokens + warn 一次（不重试、不刷屏）', async () => {
    const warn = vi.fn();
    const handle = createKojo2SemanticTokensProvider({
      getRuntime: async () => ({ ok: false, reason: 'unavailable', message: 'wasm 缺失' }),
      warn,
    });
    const fake = fakeModel('# 幕\n');
    expect(await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never)).toEqual({
      data: new Uint32Array(0),
    });
    expect(await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never)).toEqual({
      data: new Uint32Array(0),
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('unavailable');
  });

  it('运行时装载抛错 ⇒ provider 兜住（空 tokens + warn），Monaco 看不到异常', async () => {
    const warn = vi.fn();
    const handle = createKojo2SemanticTokensProvider({
      getRuntime: async () => {
        throw new Error('装载炸了');
      },
      warn,
    });
    const fake = fakeModel('# 幕\n');
    await expect(
      handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never),
    ).resolves.toEqual({ data: new Uint32Array(0) });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('装载炸了');
  });

  it('parse 失败 ⇒ 空 tokens，失败版本被缓存（同版本不再重解）', async () => {
    const warn = vi.fn();
    const { runtime, log } = fakeRuntime({
      parse: () => ({ ok: false, reason: 'parse-failed', message: '树没了' }),
    });
    const handle = createKojo2SemanticTokensProvider({ getRuntime: okRuntime(runtime), warn });
    const fake = fakeModel('# 幕\n');
    const result = await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    expect(result).toEqual({ data: new Uint32Array(0) });
    expect(warn).toHaveBeenCalledTimes(1);
    await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    expect(log.parseCalls).toHaveLength(1);
  });

  it('captures 失败（查询缺席）⇒ 空 tokens，但树继续缓存（下一版仍可增量）', async () => {
    const warn = vi.fn();
    const { runtime, log, trees } = fakeRuntime({
      captures: () => ({ ok: false, reason: 'query-unavailable', message: '没有查询' }),
    });
    const handle = createKojo2SemanticTokensProvider({ getRuntime: okRuntime(runtime), warn });
    const fake = fakeModel('# 幕\n');
    await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    expect(warn).toHaveBeenCalledTimes(1);
    fake.setText('# 幕 改\n', 2);
    await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    expect(log.parseCalls[1]!.oldTree).toBe(trees[0]!.tree);
    handle.dispose();
  });
});

/* ============================== 注册纪律 ============================== */

describe('install · flag 关时零注册，flag 开只给 kojo2 注册一次', () => {
  it('flag 关 ⇒ 一个注册调用都不发生（dispose 也无副作用）', () => {
    stubFlag(false);
    const fake = fakeMonaco();
    const disposable = installKojo2SemanticTokensProvider(fake.monaco, {
      getRuntime: async () => ({ ok: false, reason: 'disposed', message: '不该被调用' }),
    });
    expect(fake.registrations).toEqual([]);
    disposable.dispose();
    disposable.dispose();
    expect(fake.registrations).toEqual([]);
  });

  it('flag 开 ⇒ 只为 kojo2 注册；dispose 幂等（注册只撤一次）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    const disposable = installKojo2SemanticTokensProvider(fake.monaco, {
      getRuntime: async () => ({ ok: false, reason: 'disposed', message: '未使用' }),
    });
    expect(fake.registrations.map((entry) => entry.id)).toEqual(['kojo2']);
    expect(fake.registrations[0]!.provider.getLegend()).toBe(KOJO2_SEMANTIC_TOKEN_LEGEND);
    disposable.dispose();
    disposable.dispose();
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });
});

/* ============================== 真 wasm（不 mock 解析器） ============================== */

describe('真 wasm + 真 highlights：完整夹具产出可编码的 5 元组', () => {
  it('full.kojo2 的 tokens 非空、类型下标都在 legend 内、长度为 5 的倍数', async () => {
    const loaded = await getKojo2TreeSitterRuntime({
      loadAssets: async () => ({
        runtimeWasmUrl: join(REPO_ROOT, 'node_modules/web-tree-sitter/web-tree-sitter.wasm'),
        grammarWasm: join(REPO_ROOT, 'packages/kojo-syntax-tree/tree-sitter-kojo2.wasm'),
        highlightsQuery: readFileSync(HIGHLIGHTS_SCM, 'utf8'),
      }),
    });
    expect(loaded.ok, loaded.ok ? '' : loaded.message).toBe(true);

    const handle = createKojo2SemanticTokensProvider();
    const text = readFileSync(join(REPO_ROOT, 'packages/kojo-syntax-tree/tests/v2-fixtures/full.kojo2'), 'utf8');
    const fake = fakeModel(text);
    const result = await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    const data = dataOf(result);
    expect(data.length).toBeGreaterThan(0);
    expect(data.length % 5).toBe(0);
    for (let i = 0; i < data.length; i += 5) {
      expect(data[i + 2]!).toBeGreaterThan(0);
      expect(data[i + 3]!).toBeLessThan(KOJO2_SEMANTIC_TOKEN_LEGEND.tokenTypes.length);
    }
    handle.dispose();
  });
});
