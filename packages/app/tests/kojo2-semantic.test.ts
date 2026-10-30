/**
 * Kojo 2.0 **结构捕获预取器**的闸（B3 语义收口，2026-10-30）。
 *
 * 本批把"异步 worker 事实塞不进同步槽"的解法从"宿主 provider 里 await"改成 B3h 折叠的
 * 同形：宿主预取捕获 → 按 model/版本缓存 → 请求里带 `captures` → 插件供方同步作答。
 * 本文件钉宿主这一半（判据在 `packages/kojo-lang/tests/semantic.test.ts`，供方三态在
 * `packages/plugins/kojo-lang/tests/semantic.test.ts`）：
 *
 * 1. **缓存与增量**：同版本命中不重发；版本变了才把上一版 `treeId` 交回 worker；
 * 2. **快照形状**：0 基捕获 → 契约 1 基；注入子树 token 带 `origin: 'injection'`；
 * 3. **未命中不等待**：`snapshotFor` 这一轮答 `undefined`，预取踢进后台；
 * 4. **失败面**：客户端不可用 / 装载抛错 / parse 失败 / 查询失败 ⇒ 空快照、不抛、warn 一次；
 * 5. **语言门**：非 kojo2 model 一条请求都不发；
 * 6. **装配**：安装器**不注册任何 provider**（着色注册在共享收口），dispose 幂等；
 * 7. **真 wasm**：worker 引擎本体 + 真查询 → 快照能喂给包判据并编码成 5 元组。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { encodeSemanticTokens } from '../src/monaco/kojo-semantic-tokens';
import {
  createKojo2SemanticCapturesCache,
  injectionHostNodes,
  installKojo2SemanticCaptures,
  type Kojo2SemanticWorkerClient,
} from '../src/monaco/kojo2-semantic';
import { KOJO2_INJECTIONS, KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
import {
  KOJO2_SEMANTIC_TOKEN_TYPES,
  kojo2SemanticSpansFromCaptures,
} from '@kojo/kojo-lang/semantic';
import type { Kojo2Capture } from '../src/monaco/tree-sitter/kojo2-tokenizer';
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
import { onStructureDegradation, resetStructureDegradationLedger } from '../src/monaco/tree-sitter/fallback';
import type { InjectionOutcome } from '../src/monaco/tree-sitter/injection';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const SYNTAX_ROOT = join(REPO_ROOT, 'packages/kojo-syntax-tree');
const RUNTIME_WASM = join(REPO_ROOT, 'node_modules/web-tree-sitter/web-tree-sitter.wasm');
const GRAMMAR_WASM = join(SYNTAX_ROOT, 'tree-sitter-kojo2.wasm');
const HIGHLIGHTS_SCM = join(SYNTAX_ROOT, 'queries/v2/highlights.scm');
const FULL_FIXTURE = join(SYNTAX_ROOT, 'tests/v2-fixtures/full.kojo2');

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
  resetStructureDegradationLedger();
  vi.restoreAllMocks();
});

/* ============================== 假 model / 假 worker ============================== */

interface FakeModel {
  readonly model: Monaco.editor.ITextModel;
  setText(text: string, version?: number): void;
  setLanguage(languageId: string): void;
}

function fakeModel(initialText: string, initialVersion = 1): FakeModel {
  let text = initialText;
  let version = initialVersion;
  let disposed = false;
  let languageId: string = KOJO2_LANGUAGE_ID;
  const model = {
    getValue: () => text,
    getVersionId: () => version,
    isDisposed: () => disposed,
    getLineCount: () => text.split('\n').length,
    getLineMaxColumn: (line: number) => (text.split('\n')[line - 1] ?? '').length + 1,
    getLanguageId: () => languageId,
    uri: { fsPath: 'D:/proj/chara/灵梦/开场.kojo2', toString: () => 'inmemory://开场.kojo2' },
  } as unknown as Monaco.editor.ITextModel;
  return {
    model,
    setText(next, nextVersion) {
      text = next;
      version = nextVersion ?? version + 1;
    },
    setLanguage(next) {
      languageId = next;
    },
  };
}

interface FakeClientCall {
  readonly text: string;
  readonly version: number;
  readonly oldTreeId: string | undefined;
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

function fakeClient(options: {
  readonly captures?: (call: FakeClientCall) => Kojo2WorkerResult<Kojo2CapturesReply>;
} = {}): {
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

/* ============================== 缓存 / 增量 ============================== */

describe('预取器 · 版本缓存与增量', () => {
  it('首解不带 treeId、同版本不重发、版本变了才交上一版 treeId', async () => {
    const { client, log } = fakeClient({
      captures: (call) => ({
        ok: true,
        value: capturesReply('tree-1', [capture('keyword', 0, 0, 0, 2)], call.version),
      }),
    });
    const cache = createKojo2SemanticCapturesCache({ getClient: async () => client });
    const fake = fakeModel('# 幕\n');
    await cache.prefetch(fake.model);
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]!.oldTreeId).toBeUndefined();
    // 同一版本：命中缓存，一次不多
    await cache.prefetch(fake.model);
    expect(log.calls).toHaveLength(1);

    fake.setText('# 幕 改\n', 2);
    await cache.prefetch(fake.model);
    expect(log.calls).toHaveLength(2);
    expect(log.calls[1]!.oldTreeId).toBe('tree-1');
    cache.dispose();
  });

  it('快照是契约坐标：0 基捕获 → 1 基；complete = true', async () => {
    const { client } = fakeClient({
      captures: () => ({
        ok: true,
        value: capturesReply('tree-1', [capture('keyword', 0, 0, 0, 2), capture('string', 2, 3, 2, 5)]),
      }),
    });
    const cache = createKojo2SemanticCapturesCache({ getClient: async () => client });
    const fake = fakeModel('# 幕\n\n> 晨光。\n');
    await cache.prefetch(fake.model);
    expect(cache.snapshotFor(fake.model)).toEqual({
      captures: [
        { name: 'keyword', line: 1, startColumn: 1, endColumn: 3 },
        { name: 'string', line: 3, startColumn: 4, endColumn: 6 },
      ],
      complete: true,
    });
    cache.dispose();
  });

  it('快照未命中 ⇒ undefined（不等待），并把预取踢进后台', async () => {
    const { client, log } = fakeClient();
    const cache = createKojo2SemanticCapturesCache({ getClient: async () => client });
    const fake = fakeModel('# 幕\n');
    expect(cache.snapshotFor(fake.model)).toBeUndefined();
    // 同版本的在飞请求复用：再显式 prefetch 只等同一份，不重发
    await cache.prefetch(fake.model);
    expect(log.calls).toHaveLength(1);
    expect(cache.snapshotFor(fake.model)).toEqual({ captures: [], complete: true });
    cache.dispose();
  });

  it('语言门：非 kojo2 model 一条请求都不发', async () => {
    const { client, log } = fakeClient();
    const cache = createKojo2SemanticCapturesCache({ getClient: async () => client });
    const fake = fakeModel('# 幕\n');
    fake.setLanguage('kojo-erb');
    await cache.prefetch(fake.model);
    expect(log.calls).toHaveLength(0);
    expect(cache.snapshotFor(fake.model)).toBeUndefined();
    cache.dispose();
  });

  it('dispose 幂等：之后 prefetch 不请求、snapshotFor 回 undefined', async () => {
    const { client, log } = fakeClient();
    const cache = createKojo2SemanticCapturesCache({ getClient: async () => client });
    const fake = fakeModel('# 幕\n');
    await cache.prefetch(fake.model);
    cache.dispose();
    cache.dispose();
    await cache.prefetch(fake.model);
    expect(log.calls).toHaveLength(1);
    expect(cache.snapshotFor(fake.model)).toBeUndefined();
  });
});

/* ============================== 失败面 ============================== */

describe('预取器 · 失败一律空快照、不抛、只 warn 一次', () => {
  it('客户端 unavailable ⇒ 空快照 + warn 一次；失败版本被缓存（同版本不重发）', async () => {
    const warn = vi.fn();
    const { client, log } = fakeClient({
      captures: () => failed('unavailable', 'wasm 缺失'),
    });
    const cache = createKojo2SemanticCapturesCache({ getClient: async () => client, warn });
    const fake = fakeModel('# 幕\n');
    await cache.prefetch(fake.model);
    expect(cache.snapshotFor(fake.model)).toEqual({ captures: [], complete: false });
    await cache.prefetch(fake.model);
    expect(log.calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('unavailable');
    cache.dispose();
  });

  it('取客户端抛错 ⇒ 兜住（空快照 + warn），模型事件循环看不到异常', async () => {
    const warn = vi.fn();
    const cache = createKojo2SemanticCapturesCache({
      getClient: async () => {
        throw new Error('装载炸了');
      },
      warn,
    });
    const fake = fakeModel('# 幕\n');
    await expect(cache.prefetch(fake.model)).resolves.toBeUndefined();
    expect(cache.snapshotFor(fake.model)).toEqual({ captures: [], complete: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('装载炸了');
    cache.dispose();
  });

  it('查询失败但带 treeId ⇒ 空快照，下一版继续拿这棵树增量', async () => {
    const warn = vi.fn();
    const { client, log } = fakeClient({
      captures: () => failed('query-unavailable', '没有查询', 'tree-9'),
    });
    const cache = createKojo2SemanticCapturesCache({ getClient: async () => client, warn });
    const fake = fakeModel('# 幕\n');
    await cache.prefetch(fake.model);
    expect(warn).toHaveBeenCalledTimes(1);
    fake.setText('# 幕 改\n', 2);
    await cache.prefetch(fake.model);
    expect(log.calls[1]!.oldTreeId).toBe('tree-9');
    cache.dispose();
  });
});

/* ============================== 注入子树 ============================== */

function injectionOutcome(tokens: readonly { startRow: number; startCol: number; endRow: number; endCol: number; capture: string }[]): InjectionOutcome {
  return {
    ok: true,
    ranges: [
      {
        startIndex: 0,
        endIndex: 8,
        startPosition: { row: 1, column: 0 },
        endPosition: { row: 3, column: 0 },
      },
    ],
    input: 'x',
    folds: [],
    tokens: tokens.map((token) => ({ ...token, tier: 'x', node: 'n' })) as never,
  };
}

describe('预取器 · 注入子树捕获', () => {
  const withHost: Kojo2Capture[] = [
    capture('embedded', 1, 0, 1, 5),
    { ...capture('none', 1, 0, 2, 5), nodeType: 'native_body' },
  ];

  it('没有宿主节点 ⇒ 注入执行器零调用，主树捕获照旧', async () => {
    const runInjection = vi.fn();
    const { client } = fakeClient({
      captures: () => ({ ok: true, value: capturesReply('tree-1', [capture('embedded', 1, 0, 1, 5)]) }),
    });
    const cache = createKojo2SemanticCapturesCache({
      getClient: async () => client,
      runInjection: runInjection as never,
    });
    const fake = fakeModel('# 幕\n@原生\n; x\n');
    await cache.prefetch(fake.model);
    expect(runInjection).not.toHaveBeenCalled();
    expect(cache.snapshotFor(fake.model)!.captures).toEqual([
      { name: 'embedded', line: 2, startColumn: 1, endColumn: 6 },
    ]);
    cache.dispose();
  });

  it('有宿主节点 ⇒ 子树 token 变成 origin: injection 的捕获（列优先由供方判）', async () => {
    const runInjection = vi.fn(async () =>
      injectionOutcome([{ startRow: 1, startCol: 4, endRow: 1, endCol: 9, capture: 'comment' }]),
    );
    const { client } = fakeClient({
      captures: () => ({ ok: true, value: capturesReply('tree-1', withHost) }),
    });
    const cache = createKojo2SemanticCapturesCache({
      getClient: async () => client,
      runInjection: runInjection as never,
    });
    const fake = fakeModel('# 幕\n    ; 注释\n@原生\n');
    await cache.prefetch(fake.model);
    expect(runInjection).toHaveBeenCalledTimes(1);
    expect(cache.snapshotFor(fake.model)!.captures).toEqual([
      { name: 'embedded', line: 2, startColumn: 1, endColumn: 6 },
      { name: 'comment', line: 2, startColumn: 5, endColumn: 10, origin: 'injection' },
    ]);
    cache.dispose();
  });

  it('注入失败 ⇒ 主树捕获原样 + 一条 `core/injection/child-failed`', async () => {
    const seen: Array<{ readonly capability: string; readonly code?: string }> = [];
    const off = onStructureDegradation((degradation) => seen.push(degradation));
    try {
      const { client } = fakeClient({
        captures: () => ({ ok: true, value: capturesReply('tree-1', withHost) }),
      });
      const cache = createKojo2SemanticCapturesCache({
        getClient: async () => client,
        runInjection: async () => ({ ok: false, reason: 'timeout', message: '4s 没回话' }),
      });
      const fake = fakeModel('# 幕\n    ; 注释\n@原生\n');
      await cache.prefetch(fake.model);
      expect(cache.snapshotFor(fake.model)!.captures).toEqual([
        { name: 'embedded', line: 2, startColumn: 1, endColumn: 6 },
      ]);
      expect(seen.some((entry) => entry.code === 'core/injection/child-failed')).toBe(true);
      cache.dispose();
    } finally {
      off();
    }
  });

  it('宿主节点识别只认精确 nodeType（缺省不猜）', () => {
    expect(injectionHostNodes(KOJO2_INJECTIONS, [capture('none', 0, 0, 1, 1)])).toEqual([]);
    expect(injectionHostNodes(KOJO2_INJECTIONS, withHost)).toHaveLength(1);
  });
});

/* ============================== 装配 ============================== */

describe('安装器 · 不注册 provider（注册在共享收口）', () => {
  it('装一枚预取器，零 provider 注册；dispose 幂等', () => {
    const register = vi.fn();
    const fake = {
      languages: {
        registerDocumentSemanticTokensProvider: register,
        setLanguageConfiguration: () => ({ dispose: () => undefined }),
        IndentAction: { Indent: 0, None: 1, Outdent: 2 },
      },
    };
    const disposable = installKojo2SemanticCaptures(fake as unknown as typeof Monaco, {
      getClient: async () => ({ captures: async () => failed('disposed', '不该被调用') }),
    });
    expect(register).not.toHaveBeenCalled();
    disposable.dispose();
    disposable.dispose();
  });
});

/* ============================== 真 wasm ============================== */

describe('真 wasm + 真 highlights：快照 → 包判据 → 可编码 5 元组', () => {
  it('full.kojo2 的捕获经包判据产出非空、类型下标都在 kojo2 legend 内', async () => {
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
      // 注入关掉：本用例只验主树 captures 的完整链路（子树走伪执行器的三条用例）。
      const cache = createKojo2SemanticCapturesCache({ getClient: async () => client, injections: [] });
      const text = readFileSync(FULL_FIXTURE, 'utf8');
      const fake = fakeModel(text);
      await cache.prefetch(fake.model);
      const snapshot = cache.snapshotFor(fake.model)!;
      expect(snapshot.complete).toBe(true);
      expect(snapshot.captures.length).toBeGreaterThan(0);
      const spans = kojo2SemanticSpansFromCaptures(snapshot.captures, {
        lineCount: fake.model.getLineCount(),
        maxColumn: (line) => fake.model.getLineMaxColumn(line),
      });
      expect(spans.length).toBeGreaterThan(0);
      const data = encodeSemanticTokens(spans, {
        tokenTypes: KOJO2_SEMANTIC_TOKEN_TYPES,
        tokenModifiers: [],
      });
      expect(data.length % 5).toBe(0);
      for (let i = 0; i < data.length; i += 5) {
        expect(data[i + 2]!).toBeGreaterThan(0);
        expect(data[i + 3]!).toBeLessThan(KOJO2_SEMANTIC_TOKEN_TYPES.length);
      }
      cache.dispose();
    } finally {
      engine.dispose();
      await disposeKojo2TreeSitterRuntime();
    }
  });
});