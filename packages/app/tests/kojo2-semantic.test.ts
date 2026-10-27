/**
 * Kojo 2.0 语义着色 provider 的闸（K2 batch-3 → K2-TS-WORKER）。
 *
 * 本批把 provider 的数据源从"主线程真 wasm 单例"换成"worker 客户端"，测试随之改为注入
 * **假 worker 客户端**（结构类型 `Kojo2SemanticWorkerClient`，只实现 `captures`）。18 条用例
 * 的语义逐条保留，只把"旧树 `Tree` 句柄"这一层换成"`treeId` 字符串"：
 *
 * 1. **legend 与主题逐字对齐**：legend 的每个 tokenType 都在暗色角色规则（`ROLE_THEME_RULES`）/
 *    `KOJO2_THEME_TOKEN_MAP` 里，且前景色 / 字体样式逐格相等（不另造色板）；
 * 2. **capture 表不漏档**：`queries/v2/highlights.scm` 里出现的每个捕获名（`@none` 除外）
 *    都在这张表里——查询加档而映射没加时这里先红，而不是静默掉色；
 * 3. **5 元组编码**：首 token 绝对行/列、同行相对列、零宽 / legend 外 / 重叠的处理；
 * 4. **增量与所有权**：版本变了才把上一版 `treeId` 交给 worker；同一版本重复问命中缓存
 *    （不重发请求）；失败回复若带 `treeId` 则下一版继续增量；
 * 5. **失败面与注册纪律**：客户端不可用 / 装载抛错 / parse 失败 / 捕获失败 / 内部异常
 *    ⇒ 空 tokens、不抛、warn 一次；flag 关 ⇒ 零注册；dispose 幂等；
 * 6. **真 wasm**：用**进程内 worker 引擎**（`kojo2-worker.ts` 本体 + 真 wasm + 真查询）
 *    走完整链路，证明"主线程只发文本、收纯数据"之后产物仍可编码。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { ROLE_THEME_RULES } from '../src/monaco/kojo-theme-rules';
import { KOJO2_TOKEN } from '../src/monaco/kojo2-language';
import { KOJO2_THEME_TOKEN_MAP, KOJO2_THEMES, KOJO2_THEME_IDS } from '../src/monaco/kojo2-theme';
import {
  KOJO2_CAPTURE_TOKEN_TYPES,
  KOJO2_SEMANTIC_TOKEN_LEGEND,
  KOJO2_SEMANTIC_TOKEN_TYPES,
  createKojo2SemanticTokensProvider,
  encodeKojo2SemanticTokens,
  installKojo2SemanticTokensProvider,
  mapKojo2Captures,
  type Kojo2SemanticWorkerClient,
} from '../src/monaco/kojo2-semantic';
import type { Kojo2Capture, Kojo2TokenSpan } from '../src/monaco/tree-sitter/kojo2-tokenizer';
import type {
  Kojo2CapturesReply,
  Kojo2WorkerFailureReason,
  Kojo2WorkerResult,
} from '../src/monaco/tree-sitter/kojo2-worker-protocol';
import { createKojo2WorkerEngine } from '../src/monaco/tree-sitter/kojo2-worker';
import {
  disposeKojo2TreeSitterRuntime,
  getKojo2TreeSitterRuntime,
  type Kojo2RuntimeDeps,
} from '../src/monaco/tree-sitter/kojo2-runtime';
import { decodeWithMonaco } from './helpers/monaco-semantic-decode';

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/app/tests → 仓库根 */
const REPO_ROOT = resolve(HERE, '../../..');
const SYNTAX_ROOT = join(REPO_ROOT, 'packages/kojo-syntax-tree');
const RUNTIME_WASM = join(REPO_ROOT, 'node_modules/web-tree-sitter/web-tree-sitter.wasm');
const GRAMMAR_WASM = join(SYNTAX_ROOT, 'tree-sitter-kojo2.wasm');
const HIGHLIGHTS_SCM = join(SYNTAX_ROOT, 'queries/v2/highlights.scm');
const FULL_FIXTURE = join(SYNTAX_ROOT, 'tests/v2-fixtures/full.kojo2');

/** 生产资源的 Node 侧替身：直接读 workspace 内文件（不 fetch、不联网） */
function realRuntimeDeps(): Kojo2RuntimeDeps {
  return {
    loadAssets: async () => ({
      runtimeWasmUrl: RUNTIME_WASM,
      grammarWasm: GRAMMAR_WASM,
      highlightsQuery: readFileSync(HIGHLIGHTS_SCM, 'utf8'),
      foldsQuery: readFileSync(join(SYNTAX_ROOT, 'queries/v2/folds.scm'), 'utf8'),
      indentsQuery: readFileSync(join(SYNTAX_ROOT, 'queries/v2/indents.scm'), 'utf8'),
    }),
  };
}

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

/* ============================== 假 worker 客户端 ============================== */

interface FakeClientCall {
  readonly text: string;
  readonly version: number;
  readonly oldTreeId: string | undefined;
}

interface FakeClientOptions {
  readonly captures?: (call: FakeClientCall) => Kojo2WorkerResult<Kojo2CapturesReply>;
}

/** 只实现 `captures`：provider 对 worker 的最小依赖面（测试要钉的就是这条缝） */
function fakeClient(options: FakeClientOptions = {}): {
  readonly client: Kojo2SemanticWorkerClient;
  readonly log: { calls: FakeClientCall[] };
} {
  const log: { calls: FakeClientCall[] } = { calls: [] };
  let trees = 0;
  return {
    log,
    client: {
      async captures(text, version, oldTreeId) {
        const call = { text, version, oldTreeId };
        log.calls.push(call);
        if (options.captures) return options.captures(call);
        trees += 1;
        return { ok: true, value: capturesReply(`tree-${trees}`, [], version) };
      },
    },
  };
}

function capturesReply(
  treeId: string,
  captures: readonly Kojo2Capture[],
  version = 1,
): Kojo2CapturesReply {
  return {
    ok: true,
    id: 1,
    type: 'captures',
    version,
    treeId,
    captures,
    incremental: false,
    reparsed: true,
    queryMs: 0,
    loadMs: 0,
  };
}

function failed(
  reason: Kojo2WorkerFailureReason,
  message: string,
  treeId?: string,
): Kojo2WorkerResult<Kojo2CapturesReply> {
  return treeId === undefined
    ? { ok: false, reason, message }
    : { ok: false, reason, message, treeId };
}

function capture(name: string, startRow: number, startCol: number, endRow: number, endCol: number): Kojo2Capture {
  return { name, startPosition: { row: startRow, column: startCol }, endPosition: { row: endRow, column: endCol } };
}

/* ============================== 解码（断言用；Monaco 自己的 toMultilineTokens2） ============================== */

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
    const rules = new Map(ROLE_THEME_RULES.map((rule) => [rule.token, rule]));
    for (const token of KOJO2_SEMANTIC_TOKEN_TYPES) {
      const rule = rules.get(token);
      expect(rule, `legend「${token}」在暗色角色规则里没有规则`).toBeDefined();
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

  it('首 token 的 deltaLine 是 0 基行、deltaStart 是 0 基绝对列；换行后取 0 基绝对列；同行取相对列', async () => {
    const keyword = KOJO2_TOKEN.keyword;
    const data = encodeKojo2SemanticTokens([
      span(3, 5, 9, keyword),
      span(3, 12, 14, keyword),
      span(7, 2, 6, keyword),
    ]);
    expect(await decodeWithMonaco(data)).toEqual([
      { line: 3, startColumn: 5, endColumn: 9, type: 1, bits: 0 },
      { line: 3, startColumn: 12, endColumn: 14, type: 1, bits: 0 },
      { line: 7, startColumn: 2, endColumn: 6, type: 1, bits: 0 },
    ]);
    expect(Array.from(data.slice(0, 5))).toEqual([2, 4, 4, 1, 0]); // 行 3-1、列 5-1
  });

  it('零宽 / 未知 tokenType / 同行重叠：都不进数据（先到的留下）', async () => {
    const keyword = KOJO2_TOKEN.keyword;
    const data = encodeKojo2SemanticTokens([
      span(2, 1, 1, keyword), // 零宽
      span(2, 3, 9, keyword),
      span(2, 5, 7, keyword), // 与先到的重叠 ⇒ 丢
      span(2, 12, 15, 'no-such-type'), // legend 外
    ]);
    expect(await decodeWithMonaco(data)).toEqual([{ line: 2, startColumn: 3, endColumn: 9, type: 1, bits: 0 }]);
  });
});

/* ============================== provider · 增量 / 缓存 / 所有权 ============================== */

describe('provider · 增量解析与版本缓存（treeId 口径）', () => {
  it('首解不带 treeId、版本变了才把上一版 treeId 交给 worker、同版本不重发', async () => {
    const { client, log } = fakeClient();
    const handle = createKojo2SemanticTokensProvider({ getClient: async () => client });
    const fake = fakeModel('> 第一行。\n');
    const first = await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    expect(first).toEqual({ data: new Uint32Array(0) });
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]!.oldTreeId).toBeUndefined();

    // 同一版本重复问：命中缓存，一次请求都不多
    await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    expect(log.calls).toHaveLength(1);

    fake.setText('> 第一行改。\n', 2);
    await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    expect(log.calls).toHaveLength(2);
    expect(log.calls[1]!.oldTreeId).toBe('tree-1');

    handle.dispose();
    const after = await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    expect(after).toEqual({ data: new Uint32Array(0) });
    expect(log.calls).toHaveLength(2);
  });

  it('dispose 幂等：之后请求回空且不再发请求（缓存已丢）', async () => {
    const { client, log } = fakeClient();
    const handle = createKojo2SemanticTokensProvider({ getClient: async () => client });
    const fake = fakeModel('> 一行。\n');
    await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    handle.dispose();
    handle.dispose();
    const after = await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    expect(after).toEqual({ data: new Uint32Array(0) });
    expect(log.calls).toHaveLength(1);
  });
});

/* ============================== provider · 着色结果 ============================== */

describe('provider · capture → 5 元组', () => {
  it('真捕获走完整链路：捕获名 → 档位 → 区间 → legend 下标', async () => {
    const { client } = fakeClient({
      captures: (call) => ({
        ok: true,
        value: capturesReply('tree-1', [
          capture('keyword', 0, 0, 0, 2),
          capture('variable', 0, 3, 0, 5),
          capture('none', 0, 6, 0, 7),
        ], call.version),
      }),
    });
    const handle = createKojo2SemanticTokensProvider({ getClient: async () => client });
    const fake = fakeModel('# 幕 灵梦\n');
    const result = await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    const keywordAt = KOJO2_SEMANTIC_TOKEN_TYPES.indexOf(KOJO2_TOKEN.keyword);
    const speakerAt = KOJO2_SEMANTIC_TOKEN_TYPES.indexOf(KOJO2_TOKEN.speaker);
    expect(await decodeWithMonaco(dataOf(result))).toEqual([
      { line: 1, startColumn: 1, endColumn: 3, type: keywordAt, bits: 0 },
      { line: 1, startColumn: 4, endColumn: 6, type: speakerAt, bits: 0 },
    ]);
  });
});

/* ============================== provider · 失败面 ============================== */

describe('provider · 失败一律空 tokens、不抛、只 warn 一次', () => {
  it('worker 客户端 unavailable ⇒ 空 tokens + warn 一次（不重试、不刷屏）', async () => {
    const warn = vi.fn();
    const handle = createKojo2SemanticTokensProvider({
      getClient: async () => ({
        captures: async () => failed('unavailable', 'wasm 缺失'),
      }),
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

  it('取客户端抛错 ⇒ provider 兜住（空 tokens + warn），Monaco 看不到异常', async () => {
    const warn = vi.fn();
    const handle = createKojo2SemanticTokensProvider({
      getClient: async () => {
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

  it('worker 回 parse-failed ⇒ 空 tokens，失败版本被缓存（同版本不再发请求）', async () => {
    const warn = vi.fn();
    const { client, log } = fakeClient({
      captures: () => failed('parse-failed', '树没了'),
    });
    const handle = createKojo2SemanticTokensProvider({ getClient: async () => client, warn });
    const fake = fakeModel('# 幕\n');
    const result = await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    expect(result).toEqual({ data: new Uint32Array(0) });
    expect(warn).toHaveBeenCalledTimes(1);
    await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    expect(log.calls).toHaveLength(1);
  });

  it('worker 回查询失败但带 treeId ⇒ 空 tokens，下一版继续拿这棵树增量', async () => {
    const warn = vi.fn();
    const { client, log } = fakeClient({
      captures: () => failed('query-unavailable', '没有查询', 'tree-9'),
    });
    const handle = createKojo2SemanticTokensProvider({ getClient: async () => client, warn });
    const fake = fakeModel('# 幕\n');
    await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    expect(warn).toHaveBeenCalledTimes(1);
    fake.setText('# 幕 改\n', 2);
    await handle.provider.provideDocumentSemanticTokens(fake.model, null, {} as never);
    expect(log.calls[1]!.oldTreeId).toBe('tree-9');
    handle.dispose();
  });
});

/* ============================== 注册纪律 ============================== */

describe('install · 不读开关（语言面），只给 kojo2 注册一次', () => {
  it('缺省档（v1-only）⇒ 照样注册一枚（dispose 幂等）', () => {
    stubFlag(false);
    const fake = fakeMonaco();
    const disposable = installKojo2SemanticTokensProvider(fake.monaco, {
      getClient: async () => ({ captures: async () => failed('disposed', '不该被调用') }),
    });
    expect(fake.registrations).toHaveLength(1);
    disposable.dispose();
    disposable.dispose();
    expect(fake.registrations).toHaveLength(1);
  });

  it('flag 开 ⇒ 只为 kojo2 注册；dispose 幂等（注册只撤一次）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    const disposable = installKojo2SemanticTokensProvider(fake.monaco, {
      getClient: async () => ({ captures: async () => failed('disposed', '未使用') }),
    });
    expect(fake.registrations.map((entry) => entry.id)).toEqual(['kojo2']);
    expect(fake.registrations[0]!.provider.getLegend()).toBe(KOJO2_SEMANTIC_TOKEN_LEGEND);
    disposable.dispose();
    disposable.dispose();
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });
});

/* ============================== 真 wasm（worker 引擎本体 + 真查询） ============================== */

describe('真 wasm + 真 highlights：worker 链路（进程内回环）仍产出可编码的 5 元组', () => {
  it('full.kojo2 的 tokens 非空、类型下标都在 legend 内、长度为 5 的倍数', async () => {
    const engine = createKojo2WorkerEngine({
      loadRuntime: () => getKojo2TreeSitterRuntime(realRuntimeDeps()),
    });
    let id = 0;
    const client: Kojo2SemanticWorkerClient = {
      async captures(text, version, oldTreeId) {
        const reply = await engine.handle({
          id: ++id,
          type: 'captures',
          version,
          text,
          ...(oldTreeId === undefined ? {} : { oldTreeId }),
        });
        if (reply.ok && reply.type === 'captures') return { ok: true, value: reply };
        if (!reply.ok) return failed(reply.reason, reply.message, reply.treeId);
        return failed('protocol-error', `期望 captures 回复，收到 ${reply.type}`);
      },
    };
    try {
      const handle = createKojo2SemanticTokensProvider({ getClient: async () => client });
      const text = readFileSync(FULL_FIXTURE, 'utf8');
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
    } finally {
      engine.dispose();
      await disposeKojo2TreeSitterRuntime();
    }
  });
});
