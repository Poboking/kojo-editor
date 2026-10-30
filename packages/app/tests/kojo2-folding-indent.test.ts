/**
 * K2-FOLD-INDENT 的闸：Kojo 2.0 的**折叠区间**（worker `folds` → Monaco `FoldingRange`）与
 * **回车缩进的宿主口径**（判据 → on-type `TextEdit` 的翻译 + provider 注册）。
 *
 * ## 折叠这一半钉什么
 *
 * - **0 基 → 1 基**映射、排序（起点升序 / 同起点终点降序），以及四道过滤（越界 / 倒置 /
 *   非整数 / 重复）——这些都是"陈旧的回复不许画到当下文本上"的可执行形态；
 * - **版本缓存与树所有权**：同版本重复问不重发；版本变了才把上一版 `treeId` 交回 worker；
 *   失败回复若带 `treeId` 则下一版继续增量（与 `kojo2-semantic.ts` 同口径）；
 * - **失败面一律 `[]`**：`unavailable` / `timeout` / `query-unavailable` / 取客户端抛错 /
 *   模型已释放 ⇒ 空结果、不抛、同一 reason 只 warn 一次；
 * - **注册纪律**（K2-STRUCTURE-GATE 起改口）：折叠是只读呈现面，**开关关也照常注册**（只为
 *   `kojo2` 一枚）；开关开时行为不变；dispose 幂等；
 * - **真 wasm + 真查询**：用进程内 worker 引擎（`kojo2-worker.ts` 本体 + 真 wasm +
 *   `queries/v2/folds.scm`）走完整链路，读数逐条钉住（区间数、表块、`@原生` 围栏整块）。
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
import {
  installKojo2IndentProvider,
  KOJO2_AUTO_CLOSE_GUARD_TRIGGER_CHARS,
  KOJO2_INDENT_TRIGGER_CHARS,
  kojo2IndentEditsAt,
} from '../src/monaco/kojo2-indent';
import {
  createKojo2FoldingProvider,
  installKojo2FoldingProvider,
  toMonacoFoldingRanges,
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

async function provideFolds(
  handle: { readonly provider: Monaco.languages.FoldingRangeProvider },
  model: Monaco.editor.ITextModel,
): Promise<Monaco.languages.FoldingRange[]> {
  // Monaco 的 provider 契约允许 null（"本模型没有折叠"）；测试里两个实现都必然给数组，
  // 这里只做一次收窄，让调用点按数组断言。
  return (await handle.provider.provideFoldingRanges(model, {}, {} as Monaco.CancellationToken)) ?? [];
}

/* ============================== 折叠 · 0 基 → 1 基 ============================== */

describe('toMonacoFoldingRanges · 0 基行 → 1 基（端到端的唯一坐标换算）', () => {
  it('区间 +1 且按起点升序、同起点终点降序（外层块在前）', () => {
    expect(
      toMonacoFoldingRanges([foldRange(3, 5), foldRange(1, 2), foldRange(3, 9)], 20),
    ).toEqual([
      { start: 2, end: 3 },
      { start: 4, end: 10 },
      { start: 4, end: 6 },
    ]);
  });

  it('倒置 / 零高区间丢掉（没有可隐藏的行，留着只会出一个折不动的假箭头）', () => {
    expect(toMonacoFoldingRanges([foldRange(4, 4), foldRange(6, 3)], 20)).toEqual([]);
  });

  it('越界不夹取：startRow < 0 或 endRow >= 行数 ⇒ 丢（陈旧回复不许折错行）', () => {
    expect(toMonacoFoldingRanges([foldRange(-1, 3)], 20)).toEqual([]);
    expect(toMonacoFoldingRanges([foldRange(0, 20)], 20)).toEqual([]);
    // 边界内侧照常给：endRow = 行数 - 1 是最后一行
    expect(toMonacoFoldingRanges([foldRange(0, 19)], 20)).toEqual([{ start: 1, end: 20 }]);
  });

  it('非整数 / 非有限 / 非对象条目丢掉；空输入与非法行数给空结果', () => {
    expect(
      toMonacoFoldingRanges(
        [
          { startRow: 1.5, endRow: 4 },
          { startRow: Number.NaN, endRow: 3 },
          { startRow: 2, endRow: Number.POSITIVE_INFINITY },
          null as unknown as Kojo2FoldRange,
        ],
        20,
      ),
    ).toEqual([]);
    expect(toMonacoFoldingRanges([], 20)).toEqual([]);
    expect(toMonacoFoldingRanges(null, 20)).toEqual([]);
    expect(toMonacoFoldingRanges([foldRange(0, 2)], 0)).toEqual([]);
  });

  it('重复区间只留第一枚（worker 已去重；这里是防直接调用方）', () => {
    expect(toMonacoFoldingRanges([foldRange(2, 6), foldRange(2, 6)], 20)).toEqual([
      { start: 3, end: 7 },
    ]);
  });
});

/* ============================== 折叠 · provider 行为 ============================== */

describe('provider · 版本缓存与树所有权（treeId 口径）', () => {
  it('首问不带 treeId、同版本命中缓存不重发、版本变了才把上一版 treeId 交回', async () => {
    const { client, calls } = fakeFoldingClient();
    const handle = createKojo2FoldingProvider({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel('# 对照表 心情 依据 恋慕\n    0..99 -> 疏远\n');

    expect(await provideFolds(handle, fake.model)).toEqual([{ start: 1, end: 2 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.oldTreeId).toBeUndefined();
    expect(calls[0]!.text).toBe('# 对照表 心情 依据 恋慕\n    0..99 -> 疏远\n');

    // 同一版本重复问（Monaco 停笔 / 折叠态变化都会重问）：一次请求都不多
    expect(await provideFolds(handle, fake.model)).toEqual([{ start: 1, end: 2 }]);
    expect(calls).toHaveLength(1);

    fake.setText('# 对照表 心情 依据 恋慕\n    0..99 -> 疏远\n    否 -> 未知\n', 2);
    await provideFolds(handle, fake.model);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.oldTreeId).toBe('tree-1');
    handle.dispose();
  });

  it('失败带 treeId（查询失败但树已解出）⇒ 下一版继续拿这棵树增量', async () => {
    const warn = vi.fn();
    const { client, calls } = fakeFoldingClient({
      folds: () => failedFolds('query-unavailable', 'folds.scm 缺席', 'tree-9'),
    });
    const handle = createKojo2FoldingProvider({ getClient: async () => client, warn });
    const fake = fakeModel('> 一行。\n');
    expect(await provideFolds(handle, fake.model)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('query-unavailable');

    fake.setText('> 一行改。\n', 2);
    await provideFolds(handle, fake.model);
    expect(calls[1]!.oldTreeId).toBe('tree-9');
    handle.dispose();
  });
});

describe('provider · 失败一律空区间、不抛、同一 reason 只 warn 一次', () => {
  it('worker unavailable ⇒ [] + warn 一次；同版本不再重试（不刷屏）', async () => {
    const warn = vi.fn();
    const { client, calls } = fakeFoldingClient({
      folds: () => failedFolds('unavailable', 'wasm 缺失'),
    });
    const handle = createKojo2FoldingProvider({ getClient: async () => client, warn });
    const fake = fakeModel('# 幕\n');
    expect(await provideFolds(handle, fake.model)).toEqual([]);
    expect(await provideFolds(handle, fake.model)).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('unavailable');
    handle.dispose();
  });

  it('worker timeout ⇒ []（这一条丢弃，编辑器不等）', async () => {
    const { client } = fakeFoldingClient({
      folds: () => failedFolds('timeout', '2000ms 内没有回话'),
    });
    const handle = createKojo2FoldingProvider({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel('# 幕\n');
    expect(await provideFolds(handle, fake.model)).toEqual([]);
    handle.dispose();
  });

  it('取客户端抛错 ⇒ provider 兜住（[] + warn），Monaco 看不到异常', async () => {
    const warn = vi.fn();
    const handle = createKojo2FoldingProvider({
      getClient: async () => {
        throw new Error('装载炸了');
      },
      warn,
    });
    const fake = fakeModel('# 幕\n');
    await expect(provideFolds(handle, fake.model)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('装载炸了');
    handle.dispose();
  });

  it('模型已释放 ⇒ []，不再发请求', async () => {
    const { client, calls } = fakeFoldingClient();
    const handle = createKojo2FoldingProvider({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel('# 幕\n');
    fake.disposeModel();
    expect(await provideFolds(handle, fake.model)).toEqual([]);
    expect(calls).toHaveLength(0);
    handle.dispose();
  });

  it('dispose 幂等：之后的请求回空且不再发请求（缓存已丢）', async () => {
    const { client, calls } = fakeFoldingClient();
    const handle = createKojo2FoldingProvider({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel('> 一行。\n');
    await provideFolds(handle, fake.model);
    handle.dispose();
    handle.dispose();
    expect(await provideFolds(handle, fake.model)).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

/* ============================== 折叠 · 注册纪律 ============================== */

describe('install · 折叠 provider 的注册纪律', () => {
  it('flag 关 ⇒ 仍注册一枚（只读呈现面不受写面开关门控；K2-STRUCTURE-GATE）', () => {
    // 旧口径「flag 关零注册」已作废：cutover 只管写回 / 迁移 / 切解析器，折叠是大纲式只读面。
    // 这里**保留 stubFlag(false)**：断言的重点正是"开关确实关着，注册仍发生"。
    stubFlag(false);
    const fake = fakeMonaco();
    const disposable = installKojo2FoldingProvider(fake.monaco, {
      getClient: async () => fakeFoldingClient().client,
    });
    expect(fake.registrations.map((entry) => [entry.kind, entry.id])).toEqual([['folding', 'kojo2']]);
    disposable.dispose();
    disposable.dispose();
    // dispose 幂等：两次调用只撤一轮
    expect(fake.dispose).toHaveBeenCalledTimes(1);
    expect(fake.registrations).toHaveLength(1);
  });

  it('flag 开 ⇒ 只为 kojo2 注册一枚 foldingRange；dispose 幂等（只撤一次）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    const disposable = installKojo2FoldingProvider(fake.monaco, {
      getClient: async () => fakeFoldingClient().client,
    });
    expect(fake.registrations.map((entry) => [entry.kind, entry.id])).toEqual([['folding', 'kojo2']]);
    expect(fake.registrations[0]!.provider).toBeTruthy();
    disposable.dispose();
    disposable.dispose();
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });

  it('注册抛错 ⇒ 直接外抛（宿主的"全有或全无"才有东西可回滚）', () => {
    stubFlag(true);
    const fake = fakeMonaco({ failOn: 'folding' });
    expect(() =>
      installKojo2FoldingProvider(fake.monaco, { getClient: async () => fakeFoldingClient().client }),
    ).toThrow(/桩：注册 folding/);
    expect(fake.registrations).toEqual([]);
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
    const handle = createKojo2FoldingProvider({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel(FIXTURE_TEXT);
    const ranges = await provideFolds(handle, fake.model);
    const lineCount = fake.model.getLineCount();

    expect(ranges).toHaveLength(30);
    for (const range of ranges) {
      expect(range.start).toBeGreaterThanOrEqual(1);
      expect(range.end).toBeLessThanOrEqual(lineCount);
      expect(range.end).toBeGreaterThan(range.start);
    }
    for (let i = 1; i < ranges.length; i += 1) {
      const previous = ranges[i - 1]!;
      const current = ranges[i]!;
      expect(current.start > previous.start || current.start === previous.start).toBe(true);
    }
    handle.dispose();
  });

  it('读数逐条钉住：`# 对照表` 块 = 11..15，`# 池` = 17..24，`@随机` = 61..66（含 `@组` 63..65），`@原生` 整块 = 122..129', async () => {
    const { client } = realFoldsClient();
    const handle = createKojo2FoldingProvider({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel(FIXTURE_TEXT);
    const ranges = await provideFolds(handle, fake.model);
    const keys = ranges.map((range) => `${range.start}:${range.end}`);

    expect(keys).toContain('11:15'); // # 对照表 心情 依据 恋慕（行 11 → 体末行 15）
    expect(keys).toContain('17:24'); // # 池 早安问候（% 链三分支）
    expect(keys).toContain('18:19'); //   └ 第一个分支体
    expect(keys).toContain('61:66'); // @随机
    expect(keys).toContain('63:65'); //   └ @组（多行候选）
    expect(keys).toContain('122:129'); // @原生：整块 raw（围栏内不解释 2.0）
    handle.dispose();
  });

  it('真回环下同版本命中缓存：引擎只跑一次 folds，版本变了带 treeId 再问', async () => {
    const { client, calls } = realFoldsClient();
    const handle = createKojo2FoldingProvider({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel(FIXTURE_TEXT);
    await provideFolds(handle, fake.model);
    await provideFolds(handle, fake.model);
    expect(calls).toHaveLength(1);

    fake.setText(`${FIXTURE_TEXT}\n> 追加一行。\n`, 2);
    const next = await provideFolds(handle, fake.model);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.oldTreeId).toBeTypeOf('string');
    expect(next.length).toBeGreaterThan(0);
    handle.dispose();
  });

  it('folds 查询缺席（worker 回 query-unavailable）⇒ []（不冒充"没有折叠"），不抛', async () => {
    const { client } = realFoldsClient({ withFolds: false });
    // 这一面的可判别性由 worker 的 reason 本身证明（`query-unavailable`，不是空数组冒充"没有折叠"）
    const direct = await client.folds(FIXTURE_TEXT, 1);
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.reason).toBe('query-unavailable');

    const handle = createKojo2FoldingProvider({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel(FIXTURE_TEXT);
    await expect(provideFolds(handle, fake.model)).resolves.toEqual([]);
    handle.dispose();
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
    const disposable = installKojo2IndentProvider(fake.monaco);
    expect(fake.registrations.map((entry) => [entry.kind, entry.id])).toEqual([['onType', 'kojo2']]);
    disposable.dispose();
    disposable.dispose();
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });

  it('flag 开 ⇒ 只为 kojo2 注册一枚 on-type，触发字符只有换行；dispose 幂等', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    const disposable = installKojo2IndentProvider(fake.monaco);
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
    expect(() => installKojo2IndentProvider(fake.monaco)).toThrow(/桩：注册 onType/);
    expect(fake.registrations).toEqual([]);
  });

  it('provider 体内异常不外溢：桩 model 缺 getValue ⇒ 空结果', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2IndentProvider(fake.monaco);
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
