/**
 * K2-FOLD-INDENT 的闸：Kojo 2.0 的**折叠区间**（worker `folds` → Monaco `FoldingRange`）与
 * **回车缩进的宿主口径**（判据 → on-type `TextEdit` 的翻译 + provider 注册）。
 *
 * ## 折叠这一半钉什么（B3h 起改口）
 *
 * 折叠已改走**共享收口 + 插件供方**（宿主的原生 provider 清零）：宿主只在模型打开 / 改动
 * （防抖）时**预取** worker 的 `folds`，按 model 版本缓存；provider 被问时同步取快照、塞进
 * 请求的 `folds` 字段。因此这一半钉的是**预取缓存**：
 *
 * - **版本缓存与树所有权**：同版本不重发；版本变了才把上一版 `treeId` 交回 worker；
 *   失败回复若带 `treeId` 则下一版继续增量（与 `kojo2-semantic.ts` 同口径）；
 * - **缓存未命中 ⇒ 同步取空**（槽内不 await），预取落账后同版本可见；`forget` 清一份缓存；
 * - **失败面一律空快照、不抛**：`unavailable` / `timeout` / `query-unavailable` / 取客户端抛错 /
 *   模型已释放 ⇒ 空、同一 reason 只 warn 一次；
 * - **语言门**：非 kojo2 model 一条请求都不发（共享折叠 provider 也会问 ERB / kojo1）；
 * - **真 wasm + 真查询**：用进程内 worker 引擎（`kojo2-worker.ts` 本体 + 真 wasm +
 *   `queries/v2/folds.scm`）走完整链路，读数逐条钉住（区间数、表块、`@原生` 围栏整块）。
 *
 * 0 基 → 1 基的换算与四道过滤（越界 / 倒置 / 非整数 / 重复）**整块搬进
 * `@kojo/kojo-lang/folding`**，逐条边界见 `packages/kojo-lang/tests/folding.test.ts`。
 *
 * ## 缩进这一半钉什么（B3i 之后：判据在包，本文件钉装配与翻译）
 *
 * - **on-type 编辑**：`kojo2IndentEditsAt` 把包内 1 基列区间翻成 Monaco `TextEdit`——只改
 *   新行的行首空白、已有缩进不对就校正、已对齐 / 有内容 / 第一行 / 非 kojo2 / 判据 null ⇒
 *   空结果、落过一次再问不来回抖；
 * - **注册纪律**：一枚 provider 两族触发字符（`\n` + 开括号），flag 关也照挂，dispose 幂等，
 *   注册抛错直接外抛，provider 体内异常不外溢；
 * - 回车层级表（块头 / 同级容器 / `@原生` 围栏 / 行尾冒号 / 不动手 / 栅格 / 夹具逐行 / CRLF /
 *   幂等）**整块搬进 `packages/kojo-lang/tests/indent.test.ts`**——判据住包，不再住宿主。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { kojo2FoldingRangesFromWorkerFolds } from '@kojo/kojo-lang/folding';
import {
  installKojo2IndentOnTypeProvider,
  KOJO2_AUTO_CLOSE_GUARD_TRIGGER_CHARS,
  KOJO2_INDENT_TRIGGER_CHARS,
  kojo2IndentEditsAt,
} from '../src/monaco/kojo2-indent';
import {
  createKojo2FoldsCache,
  installKojo2FoldsCache,
  kojo2FoldsSnapshotFor,
  prefetchKojo2Folds,
  type Kojo2FoldingWorkerClient,
} from '../src/monaco/kojo2-folding';
import type {
  Kojo2FoldRange,
  Kojo2FoldsReply,
  Kojo2WorkerFailureReason,
  Kojo2WorkerResult,
} from '../src/monaco/tree-sitter/kojo2-worker-protocol';
import { createKojo2WorkerEngine } from '../src/monaco/tree-sitter/kojo2-worker';
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

/** 真 2.0 夹具（每一行都是正典写法；缩进的"真实语料"侧证据） */
const FIXTURE_TEXT = readFileSync(FULL_FIXTURE, 'utf8');

/** 生产资源的 Node 侧替身：直接读 workspace 内文件（不 fetch、不联网） */
function realRuntimeDeps(options: { withFolds?: boolean } = {}): Kojo2RuntimeDeps {
  return {
    loadAssets: async () => ({
      runtimeWasmUrl: RUNTIME_WASM,
      grammarWasm: GRAMMAR_WASM,
      highlightsQuery: readFileSync(join(SYNTAX_ROOT, 'queries/v2/highlights.scm'), 'utf8'),
      ...(options.withFolds === false
        ? {} // 故意不给 foldsQuery：折叠这一面必须回 []（可判别地不可用），不是"没有折叠"
        : { foldsQuery: readFileSync(join(SYNTAX_ROOT, 'queries/v2/folds.scm'), 'utf8') }),
      indentsQuery: readFileSync(join(SYNTAX_ROOT, 'queries/v2/indents.scm'), 'utf8'),
    }),
  };
}

afterEach(async () => {
  for (const engine of engines.splice(0)) engine.dispose();
  await disposeKojo2TreeSitterRuntime();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ============================== 假 Monaco / 假 model ============================== */

interface FakeRegistration {
  readonly kind: 'folding' | 'onType';
  readonly id: string;
  readonly provider: unknown;
}

function fakeMonaco(options: { failOn?: 'folding' | 'onType' } = {}): {
  readonly monaco: typeof Monaco;
  readonly registrations: FakeRegistration[];
  readonly dispose: ReturnType<typeof vi.fn>;
} {
  const registrations: FakeRegistration[] = [];
  const dispose = vi.fn();
  const register = (kind: 'folding' | 'onType', id: unknown, provider: unknown): Monaco.IDisposable => {
    if (options.failOn === kind) throw new Error(`桩：注册 ${kind} 抛错`);
    registrations.push({ kind, id: String(id), provider });
    return { dispose };
  };
  const fake = {
    languages: {
      registerFoldingRangeProvider: (id: unknown, provider: unknown) => register('folding', id, provider),
      registerOnTypeFormattingEditProvider: (id: unknown, provider: unknown) => register('onType', id, provider),
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
  disposeModel(): void;
}

function fakeModel(initialText: string, initialVersion = 1, languageId = 'kojo2'): FakeModel {
  let text = initialText;
  let version = initialVersion;
  let disposed = false;
  const lineAt = (line: number): string => text.split(/\r\n|\r|\n/)[line - 1] ?? '';
  const model = {
    getValue: () => text,
    getVersionId: () => version,
    getAlternativeVersionId: () => version,
    isDisposed: () => disposed,
    getLineCount: () => text.split(/\r\n|\r|\n/).length,
    getLineContent: (line: number) => lineAt(line),
    getLineMaxColumn: (line: number) => lineAt(line).length + 1,
    getLanguageId: () => languageId,
    uri: { fsPath: 'D:/proj/chara/灵梦/开场.kojo2' },
  } as unknown as Monaco.editor.ITextModel;
  return {
    model,
    setText(next, nextVersion) {
      text = next;
      version = nextVersion ?? version + 1;
    },
    disposeModel() {
      disposed = true;
    },
  };
}

const positionAt = (line: number, column = 1): Monaco.Position =>
  ({ lineNumber: line, column }) as Monaco.Position;

/* ============================== 假 worker 客户端（折叠） ============================== */

interface FoldCall {
  readonly text: string;
  readonly version: number;
  readonly oldTreeId: string | undefined;
}

function foldRange(startRow: number, endRow: number): Kojo2FoldRange {
  return { startRow, endRow, kind: 'block' };
}

function foldsReply(
  treeId: string,
  folds: readonly Kojo2FoldRange[] = [],
  version = 1,
): Kojo2FoldsReply {
  return {
    ok: true,
    id: 1,
    type: 'folds',
    version,
    treeId,
    folds,
    incremental: false,
    reparsed: true,
    queryMs: 0,
    loadMs: 0,
  };
}

function failedFolds(
  reason: Kojo2WorkerFailureReason,
  message: string,
  treeId?: string,
): Kojo2WorkerResult<Kojo2FoldsReply> {
  return treeId === undefined ? { ok: false, reason, message } : { ok: false, reason, message, treeId };
}

function fakeFoldingClient(options: {
  readonly folds?: (call: FoldCall) => Kojo2WorkerResult<Kojo2FoldsReply>;
} = {}): { readonly client: Kojo2FoldingWorkerClient; readonly calls: FoldCall[] } {
  const calls: FoldCall[] = [];
  let trees = 0;
  return {
    calls,
    client: {
      async folds(text, version, oldTreeId) {
        const call = { text, version, oldTreeId };
        calls.push(call);
        if (options.folds) return options.folds(call);
        trees += 1;
        return { ok: true, value: foldsReply(`tree-${trees}`, [foldRange(0, 1)], version) };
      },
    },
  };
}

/** 预取一次再取快照（B3h 的宿主侧两步：`prefetch` 等 worker，`snapshotFor` 是同步的那一格） */
async function snapshotAfterPrefetch(
  cache: ReturnType<typeof createKojo2FoldsCache>,
  model: Monaco.editor.ITextModel,
): Promise<readonly { startLine: number; endLine: number }[]> {
  await cache.prefetch(model);
  return cache.snapshotFor(model) ?? [];
}

/* ============================== 折叠 · 0 基 → 1 基（判据已进包） ============================== */

/**
 * 坐标换算与四道过滤（越界 / 倒置 / 非整数 / 重复）**整块搬进 `@kojo/kojo-lang/folding`**
 * （B3h），逐条边界由 `packages/kojo-lang/tests/folding.test.ts` 自己钉——那边一份判据一条断言，
 * 这里只钉"宿主真的用了包里那一条"（下一条用例）与端到端的真 wasm 读数。
 */
describe('折叠判据住在包里（宿主这一侧只做预取与缓存）', () => {
  it('宿主与供方用的是同一份换算：包内函数把 0 基行对翻成 1 基契约区间', () => {
    expect(kojo2FoldingRangesFromWorkerFolds([foldRange(3, 5), foldRange(1, 2)], 20)).toEqual([
      { startLine: 2, endLine: 3 },
      { startLine: 4, endLine: 6 },
    ]);
  });
});

/* ============================== 折叠 · 预取缓存行为 ============================== */

describe('预取缓存 · 版本缓存与树所有权（treeId 口径）', () => {
  it('首问不带 treeId、同版本不重发、版本变了才把上一版 treeId 交回', async () => {
    const { client, calls } = fakeFoldingClient();
    const cache = createKojo2FoldsCache({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel('# 对照表 心情 依据 恋慕\n    0..99 -> 疏远\n');

    expect(await snapshotAfterPrefetch(cache, fake.model)).toEqual([{ startLine: 1, endLine: 2 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.oldTreeId).toBeUndefined();
    expect(calls[0]!.text).toBe('# 对照表 心情 依据 恋慕\n    0..99 -> 疏远\n');

    // 同一版本重复问（Monaco 停笔 / 折叠态变化都会重问）：一次请求都不多，快照逐字相同
    expect(cache.snapshotFor(fake.model)).toEqual([{ startLine: 1, endLine: 2 }]);
    await cache.prefetch(fake.model);
    expect(calls).toHaveLength(1);

    fake.setText('# 对照表 心情 依据 恋慕\n    0..99 -> 疏远\n    否 -> 未知\n', 2);
    // 版本一变，旧快照当场失效（同步那一格不返回上一版的区间）
    expect(cache.snapshotFor(fake.model)).toBeUndefined();
    expect(await snapshotAfterPrefetch(cache, fake.model)).toEqual([{ startLine: 1, endLine: 2 }]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.oldTreeId).toBe('tree-1');
    cache.dispose();
  });

  it('同版本同一份预取在飞时复用同一个 promise（模型事件与请求构造点各踢一次也只发一条请求）', async () => {
    const { client, calls } = fakeFoldingClient();
    const cache = createKojo2FoldsCache({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel('> 一行。\n');
    const first = cache.prefetch(fake.model);
    const second = cache.prefetch(fake.model);
    expect(second).toBe(first);
    await first;
    expect(calls).toHaveLength(1);
    cache.dispose();
  });

  it('缓存未命中 ⇒ 同步取空（不异步等待），预取完成后同版本可见', async () => {
    const { client, calls } = fakeFoldingClient();
    const cache = createKojo2FoldsCache({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel('> 一行。\n');
    // 第一次：还没预取过 ⇒ 这一轮交空（provider 那一侧据此答"这一版没有折叠"）
    expect(cache.snapshotFor(fake.model)).toBeUndefined();
    // 但预取已经被踢进后台 ⇒ 等它落账之后同版本可见
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await cache.prefetch(fake.model);
    expect(cache.snapshotFor(fake.model)).toEqual([{ startLine: 1, endLine: 2 }]);
    cache.dispose();
  });

  it('forget 清掉一份 model 的缓存 ⇒ 下次重新整篇取（不带上一版的 treeId）', async () => {
    const { client, calls } = fakeFoldingClient();
    const cache = createKojo2FoldsCache({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel('> 一行。\n');
    await cache.prefetch(fake.model);
    expect(cache.snapshotFor(fake.model)).toEqual([{ startLine: 1, endLine: 2 }]);
    cache.forget(fake.model);
    expect(cache.snapshotFor(fake.model)).toBeUndefined();
    await cache.prefetch(fake.model);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.oldTreeId).toBeUndefined();
    cache.dispose();
  });

  it('非 kojo2 model ⇒ 一条请求都不发（共享折叠 provider 也会问 ERB / kojo1）', async () => {
    const { client, calls } = fakeFoldingClient();
    const cache = createKojo2FoldsCache({ getClient: async () => client, warn: () => undefined });
    const erb = fakeModel('@A\nIF x\nENDIF', 1, 'kojo-erb');
    expect(cache.snapshotFor(erb.model)).toBeUndefined();
    await cache.prefetch(erb.model);
    expect(calls).toHaveLength(0);
    cache.dispose();
  });
});

describe('预取缓存 · 失败一律空快照、不抛、同一 reason 只 warn 一次', () => {
  it('失败带 treeId（查询失败但树已解出）⇒ 下一版继续拿这棵树增量', async () => {
    const warn = vi.fn();
    const { client, calls } = fakeFoldingClient({
      folds: () => failedFolds('query-unavailable', 'folds.scm 缺席', 'tree-9'),
    });
    const cache = createKojo2FoldsCache({ getClient: async () => client, warn });
    const fake = fakeModel('> 一行。\n');
    expect(await snapshotAfterPrefetch(cache, fake.model)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('query-unavailable');

    fake.setText('> 一行改。\n', 2);
    await cache.prefetch(fake.model);
    expect(calls[1]!.oldTreeId).toBe('tree-9');
    cache.dispose();
  });

  it('worker unavailable ⇒ 空快照 + warn 一次；同版本不再重试（不刷屏）', async () => {
    const warn = vi.fn();
    const { client, calls } = fakeFoldingClient({
      folds: () => failedFolds('unavailable', 'wasm 缺失'),
    });
    const cache = createKojo2FoldsCache({ getClient: async () => client, warn });
    const fake = fakeModel('# 幕\n');
    expect(await snapshotAfterPrefetch(cache, fake.model)).toEqual([]);
    expect(cache.snapshotFor(fake.model)).toEqual([]);
    await cache.prefetch(fake.model);
    expect(calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('unavailable');
    cache.dispose();
  });

  it('worker timeout ⇒ 空快照（这一条丢弃，编辑器不等）', async () => {
    const { client } = fakeFoldingClient({
      folds: () => failedFolds('timeout', '2000ms 内没有回话'),
    });
    const cache = createKojo2FoldsCache({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel('# 幕\n');
    expect(await snapshotAfterPrefetch(cache, fake.model)).toEqual([]);
    cache.dispose();
  });

  it('取客户端抛错 / 客户端本身抛错 ⇒ 预取兜住（空快照 + warn），模型事件循环看不到异常', async () => {
    const warn = vi.fn();
    const loading = createKojo2FoldsCache({
      getClient: async () => {
        throw new Error('装载炸了');
      },
      warn,
    });
    const fake = fakeModel('# 幕\n');
    await expect(loading.prefetch(fake.model)).resolves.toBeUndefined();
    expect(loading.snapshotFor(fake.model)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('装载炸了');
    loading.dispose();

    const throwing = createKojo2FoldsCache({
      getClient: async () => ({
        folds: async () => {
          throw new Error('查询炸了');
        },
      }),
      warn,
    });
    await expect(throwing.prefetch(fake.model)).resolves.toBeUndefined();
    expect(throwing.snapshotFor(fake.model)).toEqual([]);
    expect(String(warn.mock.calls.at(-1)![0])).toContain('查询炸了');
    throwing.dispose();
  });

  it('模型已释放 ⇒ 不再交出旧快照、也不再发请求（缓存随模型生命期）', async () => {
    const { client, calls } = fakeFoldingClient();
    const cache = createKojo2FoldsCache({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel('# 幕\n');
    // 先让这一版落账 ⇒ 释放后的"清缓存"不是靠"从没存过"蒙混过关
    await cache.prefetch(fake.model);
    expect(cache.snapshotFor(fake.model)).toEqual([{ startLine: 1, endLine: 2 }]);
    fake.disposeModel();
    expect(cache.snapshotFor(fake.model)).toBeUndefined();
    await cache.prefetch(fake.model);
    expect(calls).toHaveLength(1);
    cache.dispose();
  });

  it('从没预取过的已释放模型 ⇒ 一条请求都不发', async () => {
    const { client, calls } = fakeFoldingClient();
    const cache = createKojo2FoldsCache({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel('# 幕\n');
    fake.disposeModel();
    expect(cache.snapshotFor(fake.model)).toBeUndefined();
    await cache.prefetch(fake.model);
    expect(calls).toHaveLength(0);
    cache.dispose();
  });

  it('dispose 幂等：之后的取快照回 undefined 且不再发请求（缓存已丢）', async () => {
    const { client, calls } = fakeFoldingClient();
    const cache = createKojo2FoldsCache({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel('> 一行。\n');
    await cache.prefetch(fake.model);
    cache.dispose();
    cache.dispose();
    expect(cache.snapshotFor(fake.model)).toBeUndefined();
    await cache.prefetch(fake.model);
    expect(calls).toHaveLength(1);
  });
});

/* ============================== 折叠 · 装配（全局那枚预取器） ============================== */

describe('install · 全局预取器的装配纪律', () => {
  it('装完 ⇒ 请求构造点取得到快照；dispose 幂等且之后回 undefined', async () => {
    const { client, calls } = fakeFoldingClient();
    const disposable = installKojo2FoldsCache({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel('> 一行。\n');
    // 未命中：同步取空，并把预取踢进后台
    expect(kojo2FoldsSnapshotFor(fake.model)).toBeUndefined();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await vi.waitFor(() =>
      expect(kojo2FoldsSnapshotFor(fake.model)).toEqual([{ startLine: 1, endLine: 2 }]),
    );
    disposable.dispose();
    disposable.dispose();
    expect(kojo2FoldsSnapshotFor(fake.model)).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('不装预取器 ⇒ 取快照回 undefined（折叠腿答空，一切照旧）', () => {
    expect(kojo2FoldsSnapshotFor(fakeModel('> 一行。\n').model)).toBeUndefined();
  });

  it('模型事件口 `prefetchKojo2Folds` 不等待、不抛（没装预取器时是空操作）', async () => {
    const fake = fakeModel('> 一行。\n');
    expect(() => prefetchKojo2Folds(fake.model)).not.toThrow();
    const { client, calls } = fakeFoldingClient();
    const disposable = installKojo2FoldsCache({ getClient: async () => client, warn: () => undefined });
    prefetchKojo2Folds(fake.model);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    disposable.dispose();
  });
});

/* ============================== 折叠 · 真 wasm + 真查询（进程内回环） ============================== */

/** 真回环用到的引擎（每个用例自己 `engine.dispose()`；这里留一份账防漏收） */
const engines: ReturnType<typeof createKojo2WorkerEngine>[] = [];

function realFoldsClient(options: { withFolds?: boolean } = {}): {
  readonly client: Kojo2FoldingWorkerClient;
  readonly calls: FoldCall[];
} {
  const engine = createKojo2WorkerEngine({
    loadRuntime: () => getKojo2TreeSitterRuntime(realRuntimeDeps(options)),
  });
  engines.push(engine);
  const calls: FoldCall[] = [];
  let id = 0;
  return {
    calls,
    client: {
      async folds(text, version, oldTreeId) {
        calls.push({ text, version, oldTreeId });
        const reply = await engine.handle({
          id: ++id,
          type: 'folds',
          version,
          text,
          ...(oldTreeId === undefined ? {} : { oldTreeId }),
        });
        if (reply.ok && reply.type === 'folds') return { ok: true, value: reply };
        if (!reply.ok) return failedFolds(reply.reason, reply.message, reply.treeId);
        return failedFolds('protocol-error', `期望 folds 回复，收到 ${reply.type}`);
      },
    },
  };
}

describe('真 wasm + 真 folds.scm：整条链路仍产出可用的 1 基区间', () => {
  it('full.kojo2：30 枚区间、全部 1 基且在行内、end > start、升序', async () => {
    const { client } = realFoldsClient();
    const cache = createKojo2FoldsCache({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel(FIXTURE_TEXT);
    const ranges = await snapshotAfterPrefetch(cache, fake.model);
    const lineCount = fake.model.getLineCount();

    expect(ranges).toHaveLength(30);
    for (const range of ranges) {
      expect(range.startLine).toBeGreaterThanOrEqual(1);
      expect(range.endLine).toBeLessThanOrEqual(lineCount);
      expect(range.endLine).toBeGreaterThan(range.startLine);
    }
    for (let i = 1; i < ranges.length; i += 1) {
      const previous = ranges[i - 1]!;
      const current = ranges[i]!;
      expect(current.startLine > previous.startLine || current.startLine === previous.startLine).toBe(true);
    }
    cache.dispose();
  });

  it('读数逐条钉住：`# 对照表` 块 = 11..15，`# 池` = 17..24，`@随机` = 61..66（含 `@组` 63..65），`@原生` 整块 = 122..129', async () => {
    const { client } = realFoldsClient();
    const cache = createKojo2FoldsCache({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel(FIXTURE_TEXT);
    const ranges = await snapshotAfterPrefetch(cache, fake.model);
    const keys = ranges.map((range) => `${range.startLine}:${range.endLine}`);

    expect(keys).toContain('11:15'); // # 对照表 心情 依据 恋慕（行 11 → 体末行 15）
    expect(keys).toContain('17:24'); // # 池 早安问候（% 链三分支）
    expect(keys).toContain('18:19'); //   └ 第一个分支体
    expect(keys).toContain('61:66'); // @随机
    expect(keys).toContain('63:65'); //   └ @组（多行候选）
    expect(keys).toContain('122:129'); // @原生：整块 raw（围栏内不解释 2.0）
    cache.dispose();
  });

  it('真回环下同版本命中缓存：引擎只跑一次 folds，版本变了带 treeId 再问', async () => {
    const { client, calls } = realFoldsClient();
    const cache = createKojo2FoldsCache({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel(FIXTURE_TEXT);
    await snapshotAfterPrefetch(cache, fake.model);
    await cache.prefetch(fake.model);
    expect(calls).toHaveLength(1);

    fake.setText(`${FIXTURE_TEXT}\n> 追加一行。\n`, 2);
    const next = await snapshotAfterPrefetch(cache, fake.model);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.oldTreeId).toBeTypeOf('string');
    expect(next.length).toBeGreaterThan(0);
    cache.dispose();
  });

  it('folds 查询缺席（worker 回 query-unavailable）⇒ 空快照（不冒充"没有折叠"），不抛', async () => {
    const { client } = realFoldsClient({ withFolds: false });
    // 这一面的可判别性由 worker 的 reason 本身证明（`query-unavailable`，不是空数组冒充"没有折叠"）
    const direct = await client.folds(FIXTURE_TEXT, 1);
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.reason).toBe('query-unavailable');

    const cache = createKojo2FoldsCache({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel(FIXTURE_TEXT);
    await expect(snapshotAfterPrefetch(cache, fake.model)).resolves.toEqual([]);
    cache.dispose();
  });
});

/* ============================== 缩进 · 判据已随 B3i 搬进包 ============================== */

// 回车层级表（开体块头 / 同级容器 / `@原生` 围栏 / 行尾冒号 / 不动手的那几格 / 栅格与 Tab /
// 行号越界 / 整篇夹具逐行读数 / CRLF / 幂等）**整块搬进 `packages/kojo-lang/tests/indent.test.ts`**：
// 判据住包（`@kojo/kojo-lang/indent`），宿主只剩装配与翻译。本文件保留下面两组宿主口径的闸：
// on-type 编辑（判据 → Monaco `TextEdit` 的区间翻译）与 provider 注册纪律。

/** 独立口径的一级缩进（**手写 4 空格**，不是从被测常量取的：2.0 的"一级 = 4 空格"这条事实要自己钉） */
const FOUR = '    ';


/* ============================== 缩进 · on-type 编辑 ============================== */

describe('kojo2IndentEditsAt · 只改新行的行首空白', () => {
  it('`# 对照表` 表头后回车：新行是空行 ⇒ 一条 edit 把 0 个字符换成 4 空格', () => {
    const fake = fakeModel('# 对照表 心情 依据 恋慕\n');
    expect(kojo2IndentEditsAt(fake.model, positionAt(2))).toEqual([
      {
        range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 },
        text: FOUR,
      },
    ]);
  });

  it('已有缩进不对（onEnterRules 给多了）⇒ 校正到精确值', () => {
    const fake = fakeModel('@算\n        \n');
    expect(kojo2IndentEditsAt(fake.model, positionAt(2))).toEqual([
      {
        range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 9 },
        text: FOUR,
      },
    ]);
  });

  it('已经对齐 ⇒ 空结果（落过一次之后再问不来回抖，幂等）', () => {
    const fake = fakeModel('@算\n    \n');
    expect(kojo2IndentEditsAt(fake.model, positionAt(2))).toEqual([]);
  });

  it('当前行有内容（行中回车切出来的半截）⇒ 空结果', () => {
    const fake = fakeModel('@算\n    心情快照 = 心\n');
    expect(kojo2IndentEditsAt(fake.model, positionAt(2))).toEqual([]);
  });

  it('第一行 / 非 kojo2 语言 / 判据为 null ⇒ 空结果', () => {
    const fake = fakeModel('# 对照表 心情 依据 恋慕\n');
    expect(kojo2IndentEditsAt(fake.model, positionAt(1))).toEqual([]);
    const other = fakeModel('@算\n', 1, 'erb');
    expect(kojo2IndentEditsAt(other.model, positionAt(2))).toEqual([]);
    const narration = fakeModel('> 旁白\n');
    expect(kojo2IndentEditsAt(narration.model, positionAt(2))).toEqual([]);
  });

  it('把 edit 落进去再问一次 ⇒ 空结果（同一位置两次请求答案一致）', () => {
    const fake = fakeModel('# 对照表 心情 依据 恋慕\n');
    const first = kojo2IndentEditsAt(fake.model, positionAt(2));
    expect(first).toHaveLength(1);
    fake.setText(`# 对照表 心情 依据 恋慕\n${first[0]!.text}\n`);
    expect(kojo2IndentEditsAt(fake.model, positionAt(2))).toEqual([]);
  });
});

/* ============================== 缩进 · 注册纪律 ============================== */

describe('install · 回车缩进 provider 的注册纪律', () => {
  it('flag 关 ⇒ 照挂（回车缩进是语言面，不看切流阶段）', () => {
    stubFlag(false);
    const fake = fakeMonaco();
    const disposable = installKojo2IndentOnTypeProvider(fake.monaco);
    expect(fake.registrations.map((entry) => [entry.kind, entry.id])).toEqual([['onType', 'kojo2']]);
    disposable.dispose();
    disposable.dispose();
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });

  it('flag 开 ⇒ 只为 kojo2 注册一枚 on-type，触发字符只有换行；dispose 幂等', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    const disposable = installKojo2IndentOnTypeProvider(fake.monaco);
    expect(fake.registrations.map((entry) => [entry.kind, entry.id])).toEqual([['onType', 'kojo2']]);
    const provider = fake.registrations[0]!.provider as Monaco.languages.OnTypeFormattingEditProvider;
    // 一枚 provider 两条腿：回车缩进 + 围栏内自动闭合守卫（开括号一族）
    expect(provider.autoFormatTriggerCharacters).toEqual([
      ...KOJO2_INDENT_TRIGGER_CHARS,
      ...KOJO2_AUTO_CLOSE_GUARD_TRIGGER_CHARS,
    ]);
    expect([...KOJO2_INDENT_TRIGGER_CHARS]).toEqual(['\n']);
    disposable.dispose();
    disposable.dispose();
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });

  it('注册抛错 ⇒ 直接外抛（本 provider 无自有资源可收）', () => {
    stubFlag(true);
    const fake = fakeMonaco({ failOn: 'onType' });
    expect(() => installKojo2IndentOnTypeProvider(fake.monaco)).toThrow(/桩：注册 onType/);
    expect(fake.registrations).toEqual([]);
  });

  it('provider 体内异常不外溢：桩 model 缺 getValue ⇒ 空结果', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2IndentOnTypeProvider(fake.monaco);
    const provider = fake.registrations[0]!.provider as Monaco.languages.OnTypeFormattingEditProvider;
    const broken = {
      getLineContent: () => '',
      getValue: () => {
        throw new Error('模型已释放');
      },
      getLanguageId: () => 'kojo2',
    } as unknown as Monaco.editor.ITextModel;
    expect(provider.provideOnTypeFormattingEdits(broken, positionAt(2), '\n', {} as never, {} as never)).toEqual([]);
  });
});

/* ============================== 判据住包（B3i 的反向闸） ============================== */

/**
 * 判据既然整块进了 `@kojo/kojo-lang/indent`，宿主就不许再长出第二份：词表位序 / `lex()` /
 * 形状正则只要在这里出现一次，两边就会开始各判各的（B3c–B3f 反复踩过的那条路）。
 * 本闸读源码，不跑判据——它守的是"下一批人顺手把一段判据抄回宿主"。
 */
describe('判据住包：宿主 kojo2-indent.ts 只剩装配与翻译', () => {
  const source = readFileSync(resolve(HERE, '../src/monaco/kojo2-indent.ts'), 'utf8');

  it('只引包叶子（`@kojo/kojo-lang/indent`），不引 core 词法 / 词表', () => {
    expect(source).toContain("from '@kojo/kojo-lang/indent'");
    expect(source).not.toContain("from '@kojo/kojo-core'");
    expect(source).not.toMatch(/\blex\s*\(/);
    expect(source).not.toMatch(/KOJO_DECL_WORDS|KOJO_DISPATCH_WORDS/);
  });

  it('形状正则不再写第二份（块头 / 栏头 / 缩进单位 / indentationRules）', () => {
    for (const name of [
      'KOJO2_BLOCK_HEADER_COLON_RE',
      'KOJO2_NATIVE_HEADER_RE',
      'KOJO2_INDENT_UNIT',
      'KOJO2_INDENTATION_RULES',
    ]) {
      expect(source, name).not.toContain(name);
    }
  });

  it('装配面仍在：on-type 注册 + 两枚翻译口 + 包内基底规则', () => {
    expect(source).toContain('registerOnTypeFormattingEditProvider');
    expect(source).toContain('kojo2IndentReplacementAt');
    expect(source).toContain('kojo2AutoCloseTargetAt');
    expect(source).toContain('KOJO2_BASE_INDENT_RULES');
  });
});
