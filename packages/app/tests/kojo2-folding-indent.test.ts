/**
 * K2-FOLD-INDENT 的闸：Kojo 2.0 的**折叠区间**（worker `folds` → Monaco `FoldingRange`）与
 * **回车缩进**（`kojo2IndentAfterLine` 纯判据 + on-type formatter）。
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
 * ## 缩进这一半钉什么
 *
 * - **判据表逐格正例**：五锚点块头 / `# 表` 两列 / `# 池` 分支 / `@随机` 候选（含 `@组`）/
 *   `@原生` 围栏 / `?` 链 / `选项：`；
 * - **不动手的那几格**：旁白 / 台词 / `!` 触发（插槽要模板定义才知道）/ 单行声明 /
 *   单行调度（`@颜绘` `@标` `@跳` `@返` `@断` `@续`）/ 空行 / 注释 / 非 4 空格栅格 / Tab；
 * - **单源**：结果恒为 `KOJO2_INDENT_WIDTH`（= core `KOJO_INDENT_WIDTH`）的整数倍，
 *   一级缩进串就是 `KOJO2_INDENT_UNIT`；
 * - **幂等**：同一位置问两次答案逐字相同；落过一次之后已有缩进等于目标值 ⇒ 空结果（不来回抖）；
 * - **真 2.0 夹具**：`tests/v2-fixtures/full.kojo2` 逐行取判据，覆盖每一种结构（词序一变就红）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { KOJO_INDENT_WIDTH } from '@kojo/kojo-core';
import { KOJO2_INDENT_UNIT } from '../src/monaco/kojo2-enter';
import { KOJO2_INDENT_WIDTH } from '../src/monaco/kojo2-lexicon';
import {
  installKojo2IndentProvider,
  KOJO2_AUTO_CLOSE_GUARD_TRIGGER_CHARS,
  KOJO2_INDENT_TRIGGER_CHARS,
  kojo2IndentAfterLine,
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
    const fake = fakeModel('# 表 心情 由 恋慕\n    0..99 疏远\n');

    expect(await provideFolds(handle, fake.model)).toEqual([{ start: 1, end: 2 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.oldTreeId).toBeUndefined();
    expect(calls[0]!.text).toBe('# 表 心情 由 恋慕\n    0..99 疏远\n');

    // 同一版本重复问（Monaco 停笔 / 折叠态变化都会重问）：一次请求都不多
    expect(await provideFolds(handle, fake.model)).toEqual([{ start: 1, end: 2 }]);
    expect(calls).toHaveLength(1);

    fake.setText('# 表 心情 由 恋慕\n    0..99 疏远\n    否 未知\n', 2);
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

  it('读数逐条钉住：`# 表` 块 = 11..15，`# 池` = 17..24，`@随机` = 61..66（含 `@组` 63..65），`@原生` 整块 = 122..129', async () => {
    const { client } = realFoldsClient();
    const handle = createKojo2FoldingProvider({ getClient: async () => client, warn: () => undefined });
    const fake = fakeModel(FIXTURE_TEXT);
    const ranges = await provideFolds(handle, fake.model);
    const keys = ranges.map((range) => `${range.start}:${range.end}`);

    expect(keys).toContain('11:15'); // # 表 心情 由 恋慕（行 11 → 体末行 15）
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

/* ============================== 缩进 · 判据表（正例） ============================== */

/** 独立口径的一级缩进（**手写 4 空格**，不是从被测常量取的：2.0 的"一级 = 4 空格"这条事实要自己钉） */
const FOUR = '    ';

describe('kojo2IndentAfterLine · 开体块头一律 +1 级（4 空格）', () => {
  it.each([
    ['# 表 心情 由 恋慕', '表体（两列行）'],
    ['# 池 早安问候', '池体（`?` 链）'],
    ['# 模 娇羞退场(原因)', '模板体（可含 `[插槽]`）'],
    ['@算', '状态更新块'],
    ['@着色 0xFF8080', '颜色块（体内是叙事）'],
    ['@随机', '随机候选层'],
    ['@组', '多行候选组'],
    ['@循 体力恢复 < 100', '循环体'],
    ['@复 3', '定次循环体'],
    ['@巡 队伍状态', '集合遍历体'],
    ['@函 增加羁绊(目标, 数值=10, 理由="日常")', '函数体'],
    ['@织 回合末 之后', '监听体'],
    ['@原生', '围栏体（比栏头深一级）'],
    ['? 恋慕 >= 500', '条件分支体'],
    ['? 否', '默认分支体'],
    ['选项：', 'UI 块头（2.0 待定，仍是块头）'],
  ])('%s → %s', (line) => {
    expect(kojo2IndentAfterLine(`${line}\n`, 1)).toBe(FOUR);
  });

  it('嵌套层级按行的实际档位算：`# 池` 里的 `?` 在 4 空格上 ⇒ 分支体给 8 空格', () => {
    const text = ['# 池 早安问候', '    ? 恋慕 < 100', '        「……早。」', ''].join('\n');
    expect(kojo2IndentAfterLine(text, 1)).toBe(FOUR);
    expect(kojo2IndentAfterLine(text, 2)).toBe(`${FOUR}${FOUR}`);
  });
});

describe('kojo2IndentAfterLine · 同级容器（下一行仍是兄弟，不再加深）', () => {
  it('`# 表` 的两列行：行与行同层（表头 → 4；行 → 4）', () => {
    const text = ['# 表 心情 由 恋慕', '    0..99     疏远', '    100..499  平常', ''].join('\n');
    expect(kojo2IndentAfterLine(text, 1)).toBe(FOUR);
    expect(kojo2IndentAfterLine(text, 2)).toBe(FOUR);
    expect(kojo2IndentAfterLine(text, 3)).toBe(FOUR);
  });

  it('`@随机` 的候选行：下一条候选留在候选层（4 空格）', () => {
    const text = ['@随机', '    灵梦：「……呼。」', '    灵梦：「……」', ''].join('\n');
    expect(kojo2IndentAfterLine(text, 1)).toBe(FOUR);
    expect(kojo2IndentAfterLine(text, 2)).toBe(FOUR);
  });

  it('`@组` 开体（+1）而组体行留在组层（8 空格）', () => {
    const text = [
      '@随机',
      '    灵梦：「……呼。」',
      '    @组',
      '        灵梦：「再、再摸摸嘛。」',
      '        > 她把脸别了过去。',
      '',
    ].join('\n');
    expect(kojo2IndentAfterLine(text, 3)).toBe(`${FOUR}${FOUR}`);
    expect(kojo2IndentAfterLine(text, 4)).toBe(`${FOUR}${FOUR}`);
    expect(kojo2IndentAfterLine(text, 5)).toBe(`${FOUR}${FOUR}`);
  });

  it('表的行 / 候选行之后**没有**同级容器（空行结束）⇒ 不动手', () => {
    const text = ['# 表 心情 由 恋慕', '    0..99 疏远', '', '    100..499 平常', ''].join('\n');
    // 第 4 行虽然在栅格上，但它头上隔着一枚物理空行：表已结束（§6.1），本层不替它猜
    expect(kojo2IndentAfterLine(text, 4)).toBeNull();
  });
});

describe('kojo2IndentAfterLine · `@原生` 围栏：栏头 +1，体内一个字都不动', () => {
  it('栏头 +1；体内（含行尾冒号、更深的行、围栏内注释）一律 null', () => {
    const text = [
      '@原生',
      '    ; 逃生舱：底层 ERB 代码',
      '    CALL HPH_PRINT "w"',
      '    IF TFLAG:10',
      '        PRINTFORML {　}',
      '    // 这里不是 2.0 注释',
      '> 围栏结束后的旁白',
      '',
    ].join('\n');
    expect(kojo2IndentAfterLine(text, 1)).toBe(FOUR);
    for (const line of [2, 3, 4, 5, 6]) {
      expect(kojo2IndentAfterLine(text, line), `围栏内第 ${line} 行`).toBeNull();
    }
    // 去缩进到 0 的那一行结束围栏 ⇒ 它自己按普通行判（旁白 = 不动手）
    expect(kojo2IndentAfterLine(text, 7)).toBeNull();
  });

  it('围栏内空行不参与基准、也不开体（§8.5）', () => {
    const text = ['@原生', '    CALL X', '', '    CALL Y', ''].join('\n');
    expect(kojo2IndentAfterLine(text, 3)).toBeNull();
    expect(kojo2IndentAfterLine(text, 4)).toBeNull();
  });

  it('围栏内即使长得像块头（行尾冒号）也不 +1：原文保真优先', () => {
    const text = ['@原生', '    LABEL:', '    CALL X', ''].join('\n');
    expect(kojo2IndentAfterLine(text, 2)).toBeNull();
  });
});

describe('kojo2IndentAfterLine · 行尾全角冒号（迁移期块头 / 按钮标签）', () => {
  it('`选项：` 的按钮标签 `「标签」：` → +1（与按钮体同一条判据）', () => {
    const text = ['选项：', '    「用亲吻代替回答」：', '        灵梦：「……唔。」', '    「摸摸头」：', ''].join('\n');
    expect(kojo2IndentAfterLine(text, 1)).toBe(FOUR);
    expect(kojo2IndentAfterLine(text, 2)).toBe(`${FOUR}${FOUR}`);
    expect(kojo2IndentAfterLine(text, 4)).toBe(`${FOUR}${FOUR}`);
  });

  it('旁白的行尾冒号是正文（`> 请选择你的行动：`）⇒ 不动手', () => {
    expect(kojo2IndentAfterLine('> 请选择你的行动：\n', 1)).toBeNull();
  });

  it('行首转义行的行尾冒号是字面文本 ⇒ 不动手', () => {
    expect(kojo2IndentAfterLine('\\选项：\n', 1)).toBeNull();
  });
});

describe('kojo2IndentAfterLine · 不动手的那几格', () => {
  it.each([
    ['# 幕 神社清晨', '单行声明（体是顶层叙事）'],
    ['# 视 灵梦', '单行声明'],
    ['# 机 指令 310', '单行声明'],
    ['# 变量 今天已触发 整数 = 0 存档', '单行声明'],
    ['# 常量 亲近线 整数 = 500', '单行声明'],
    ['> 晨光透过鸟居。', '旁白没有体'],
    ['灵梦：「早上好。」', '台词没有体'],
    ['! 早安问候', '池调用没有体'],
    ['! 娇羞退场("被夸奖")', '模板插槽块要定义处才知道 ⇒ 不猜'],
    ['@颜绘 笑顔', '单行演出'],
    ['@标 主菜单', '单行语句'],
    ['@跳 主菜单', '单行语句'],
    ['@返', '单行语句'],
    ['@断', '单行语句'],
    ['@续', '单行语句'],
    ['// 整行注释', '注释不打断块、自己也不开体'],
    ['', '空行'],
    ['    ', '纯空白行'],
  ])('%s → null（%s）', (line) => {
    expect(kojo2IndentAfterLine(`${line}\n`, 1)).toBeNull();
  });

  it('`空行` 语句（`空行` / `空行 等待` / `空行 续`）不开体', () => {
    for (const line of ['空行', '空行 等待', '空行 续']) {
      expect(kojo2IndentAfterLine(`${line}\n`, 1), line).toBeNull();
    }
  });
});

describe('kojo2IndentAfterLine · 判不准就 null（绝不给一个猜的缩进）', () => {
  it('不在 4 空格栅格上的行（2 / 6 空格）⇒ null', () => {
    expect(kojo2IndentAfterLine('  # 表 心情 由 恋慕\n', 1)).toBeNull();
    expect(kojo2IndentAfterLine('      @算\n', 1)).toBeNull();
  });

  it('含 Tab 的结构行 ⇒ null（2.0 结构缩进只用空格，§8.5）', () => {
    expect(kojo2IndentAfterLine('\t@算\n', 1)).toBeNull();
    expect(kojo2IndentAfterLine('\t# 池 早安问候\n', 1)).toBeNull();
  });

  it('行号越界 / 非整数 / 非正数 ⇒ null', () => {
    const text = '# 表 心情 由 恋慕\n';
    expect(kojo2IndentAfterLine(text, 0)).toBeNull();
    expect(kojo2IndentAfterLine(text, -3)).toBeNull();
    expect(kojo2IndentAfterLine(text, 1.5)).toBeNull();
    expect(kojo2IndentAfterLine(text, 99)).toBeNull();
  });

  it('空文本 / 非字符串 ⇒ null（不抛）', () => {
    expect(kojo2IndentAfterLine('', 1)).toBeNull();
    expect(kojo2IndentAfterLine(undefined as unknown as string, 1)).toBeNull();
    expect(kojo2IndentAfterLine(42 as unknown as string, 1)).toBeNull();
  });
});

/* ============================== 缩进 · 单源 / 幂等 / 真夹具 ============================== */

describe('缩进的单源与幂等', () => {
  it('一级缩进串 = core 的 4 空格；判据里的宽度与它同源', () => {
    expect(KOJO2_INDENT_WIDTH).toBe(KOJO_INDENT_WIDTH);
    expect(KOJO2_INDENT_UNIT).toBe(' '.repeat(KOJO_INDENT_WIDTH));
    expect(KOJO2_INDENT_UNIT).toHaveLength(4);
    expect(FOUR).toBe(KOJO2_INDENT_UNIT);
  });

  it('结果恒为 4 空格整数倍个空格：整篇夹具逐行扫一遍（含 null 行）', () => {
    const lineCount = FIXTURE_TEXT.split('\n').length;
    let positive = 0;
    for (let line = 1; line <= lineCount; line += 1) {
      const indent = kojo2IndentAfterLine(FIXTURE_TEXT, line);
      if (indent === null) continue;
      positive += 1;
      expect(indent, `第 ${line} 行`).toMatch(/^(?: {4})+$/);
      expect(indent.length % KOJO_INDENT_WIDTH).toBe(0);
    }
    // 反空匹配自证：夹具里确实有成片的开体行（不是整篇 null 蒙混过关）
    expect(positive).toBeGreaterThan(15);
  });

  it('幂等：同一输入问两次答案逐字相同（纯函数、无内部状态）', () => {
    const lineCount = FIXTURE_TEXT.split('\n').length;
    for (let line = 1; line <= lineCount; line += 1) {
      expect(kojo2IndentAfterLine(FIXTURE_TEXT, line)).toBe(kojo2IndentAfterLine(FIXTURE_TEXT, line));
    }
  });
});

describe('真 2.0 夹具（full.kojo2）逐结构读数', () => {
  const cases: ReadonlyArray<readonly [number, string | null, string]> = [
    [11, FOUR, '# 表 心情 由 恋慕'],
    [12, FOUR, '    0..99     疏远（表行与行同层）'],
    [15, FOUR, '    否        未知（默认分支也是行）'],
    [17, FOUR, '# 池 早安问候'],
    [18, `${FOUR}${FOUR}`, '    ? 恋慕 < 100（池里的分支体）'],
    [19, null, '        「……早。」（分支体里再回车不加深）'],
    [26, FOUR, '# 模 娇羞退场(原因)'],
    [39, FOUR, '@算'],
    [48, FOUR, '? 恋慕 >= 500'],
    [56, FOUR, '@着色 0xFF8080'],
    [61, FOUR, '@随机'],
    [62, FOUR, '    灵梦：「……呼。」（候选层）'],
    [63, `${FOUR}${FOUR}`, '    @组'],
    [64, `${FOUR}${FOUR}`, '        灵梦：「再、再摸摸嘛。」（组体层）'],
    [66, FOUR, '    灵梦：「……」（组之后的候选）'],
    [72, FOUR, '@循 体力恢复 < 100'],
    [74, `${FOUR}${FOUR}`, '    ? 体力恢复 == 50'],
    [82, FOUR, '@巡 队伍状态'],
    [86, FOUR, '@复 3'],
    [90, null, '> 请选择你的行动：（旁白行尾冒号是正文）'],
    [100, FOUR, '@函 斐波那契(n)'],
    [111, FOUR, '@织 回合末 之后'],
    [117, null, '! 早安问候'],
    [119, null, '    灵梦：「才、才没有很开心呢！」（插槽块不猜）'],
    [122, FOUR, '@原生'],
    [123, null, '    ; 逃生舱：底层 ERB 代码（围栏内）'],
    [129, null, '    // 这里不是 2.0 注释（围栏内）'],
  ];
  it.each(cases)('第 %i 行 %s → %s', (line: number, expected: string | null) => {
    expect(kojo2IndentAfterLine(FIXTURE_TEXT, line)).toBe(expected);
  });
});

/* ============================== 缩进 · on-type 编辑 ============================== */

describe('kojo2IndentEditsAt · 只改新行的行首空白', () => {
  it('`# 表` 表头后回车：新行是空行 ⇒ 一条 edit 把 0 个字符换成 4 空格', () => {
    const fake = fakeModel('# 表 心情 由 恋慕\n');
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
    const fake = fakeModel('# 表 心情 由 恋慕\n');
    expect(kojo2IndentEditsAt(fake.model, positionAt(1))).toEqual([]);
    const other = fakeModel('@算\n', 1, 'erb');
    expect(kojo2IndentEditsAt(other.model, positionAt(2))).toEqual([]);
    const narration = fakeModel('> 旁白\n');
    expect(kojo2IndentEditsAt(narration.model, positionAt(2))).toEqual([]);
  });

  it('把 edit 落进去再问一次 ⇒ 空结果（同一位置两次请求答案一致）', () => {
    const fake = fakeModel('# 表 心情 由 恋慕\n');
    const first = kojo2IndentEditsAt(fake.model, positionAt(2));
    expect(first).toHaveLength(1);
    fake.setText(`# 表 心情 由 恋慕\n${first[0]!.text}\n`);
    expect(kojo2IndentEditsAt(fake.model, positionAt(2))).toEqual([]);
  });
});

/* ============================== 缩进 · 注册纪律 ============================== */

describe('install · 回车缩进 provider 的注册纪律', () => {
  it('flag 关 ⇒ 零注册（dispose 也无副作用）', () => {
    stubFlag(false);
    const fake = fakeMonaco();
    const disposable = installKojo2IndentProvider(fake.monaco);
    expect(fake.registrations).toEqual([]);
    disposable.dispose();
    disposable.dispose();
    expect(fake.registrations).toEqual([]);
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
