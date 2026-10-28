import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { StructureClient } from '../src/monaco/tree-sitter/client';
import { resetStructureDegradationLedger } from '../src/monaco/tree-sitter/fallback';
import type { StructureLanguageRuntime } from '../src/monaco/tree-sitter/structure-runtime';
import type { KojoStructureIndentRules } from '../src/monaco/tree-sitter/types';
import { STRUCTURE_PROTOCOL_VERSION, type StructureFacet } from '@kojo/kojo-core';

/**
 * 结构 client · **首帧分层（R8）**：开文件拆成三拍，折叠先上，着色后补。
 *
 * ## 为什么必须是三条**请求**（不是一条请求里的三条回话）
 *
 * worker 是"一条请求一条回话"（`worker-bootstrap.ts::assemble` 把这一趟要的几面拼进同一条
 * `facets`，而且**这一拍里所有面都算完才发**）⇒ 一条回话里折叠永远排在语义后面到不了。
 * 24,197 行真语料实测（见 `client.ts::FRAME_BEATS` 的读数表）：一条回话 392 ms 才两样都到；
 * 三条拍 186 ms 折叠就到、245 ms 着色到。
 *
 * ## 本文件钉的四件事
 *
 * 1. **拍序与触发条件**：第一拍只要折叠；后面每一拍都由**上一条回话**触发（不是定时器、
 *    也不是一次性全发出去）——否则 worker 会串行排队，跟一条回话没区别；
 * 2. **等待者不许被"别的面先到"打发走**：`foldingRanges()` 在第一拍回话后就该交出折叠，
 *    而 `tokens()` 必须一直等到语义那一拍（中途早退 = 这一屏没颜色，而 Monaco 要等到下一次
 *    内容变化才会再问）；
 * 3. **按 `want` 裁剪**：体量档把语义摘掉的文档只有两拍，且 `tokens()` 当场交 null（不再等）；
 * 4. **编辑会打断拍序**：拍还在飞时作者开始打字 ⇒ 差集回话带全部面，后面的拍作废（不能既发
 *    差集又补发整篇）。
 *
 * 打桩面与 `tree-sitter-client-gating.test.ts` 同款：`?worker` 换成可编程 FakeWorker，
 * wasm / 查询串由 `assets` 桩挡住（本文件只关心消息次序，不碰真语法）。
 */

/* ============================ 可编程 FakeWorker ============================ */

const harness = vi.hoisted(() => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    static reset(): void {
      FakeWorker.instances = [];
    }
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message?: string }) => void) | null = null;
    readonly sent: unknown[] = [];
    constructor() {
      FakeWorker.instances.push(this);
    }
    postMessage(data: unknown): void {
      this.sent.push(data);
    }
    terminate(): void {
      /* 什么都不做 */
    }
    reply(data: unknown): void {
      this.onmessage?.({ data });
    }
  }
  return { FakeWorker };
});

vi.mock('../src/monaco/tree-sitter/kojo-ts.worker?worker', () => ({ default: harness.FakeWorker }));
vi.mock('../src/monaco/tree-sitter/assets', () => ({
  KOJO_STRUCTURE_ASSETS: {
    kojoWasmUrl: 'kojo.wasm（桩）',
    runtimeWasmUrl: 'runtime.wasm（桩）',
    highlightsQuery: '',
    foldsQuery: '',
    indentsQuery: '',
  },
}));

const RUNTIME: StructureLanguageRuntime = {
  runtimeWasmUrl: 'runtime.wasm（桩）',
  grammarWasmUrl: 'kojo.wasm（桩）',
  createWorker: () => new harness.FakeWorker() as unknown as Worker,
};

type Fake = InstanceType<typeof harness.FakeWorker>;

/* ================================ 脚手架 ================================ */

const EMPTY_INDENT: KojoStructureIndentRules = { increasePatterns: [], decreasePatterns: [], enterPatterns: [] };

const captureTable = (): Record<string, unknown> => ({ names: ['comment'], nodes: ['x'], spans: [0, 0, 0, 1, 0, 0] });

/** 一条只带**点名那几面**的回话（真 worker 就是这样：`want` 之外的面不进 `facets`） */
function replyOf(id: number, doc: number, version: number, facets: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: true,
    id,
    kind: 'parse',
    doc,
    version,
    treeId: 't1',
    incremental: false,
    facets,
    metrics: { parseMs: 1, queryMs: 0, textLength: 1 },
  };
}

function fakeModel(text: string): Monaco.editor.ITextModel & { edit(next: string): void } {
  let value = text;
  const listeners = new Set<(event: unknown) => void>();
  return {
    getValue: () => value,
    getLineCount: () => value.split('\n').length,
    isDisposed: () => false,
    onDidChangeContent: (fn: (event: unknown) => void) => {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
    /**
     * 改一行：按 Monaco 给事件的形状推一条（单段、前后缀差集，偏移是旧文的 UTF-16 码元）。
     * 走"整体替换"会让 `editFromChanges` 判形状不认、退回整篇，本文件那两条编辑用例就量不到
     * 差集那条腿了。
     */
    edit: (next: string) => {
      const event = contentChanged(value, next);
      value = next;
      for (const fn of [...listeners]) fn(event);
    },
  } as unknown as Monaco.editor.ITextModel & { edit(next: string): void };
}

/** "旧文 → 新文"化成 Monaco 会给的那条 `IModelContentChangedEvent`（与 gating 那份同口径） */
function contentChanged(before: string, after: string): unknown {
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  const pointAt = (offset: number): { row: number; column: number } => {
    const end = Math.min(Math.max(0, offset), before.length);
    let row = 0;
    let lineStart = 0;
    for (let i = 0; i < end; i += 1) {
      if (before.charCodeAt(i) === 10) {
        row += 1;
        lineStart = i + 1;
      }
    }
    return { row, column: end - lineStart };
  };
  const start = pointAt(prefix);
  const end = pointAt(before.length - suffix);
  return {
    isFlush: false,
    versionId: 0,
    changes: [
      {
        rangeOffset: prefix,
        rangeLength: before.length - suffix - prefix,
        text: after.slice(prefix, after.length - suffix),
        range: {
          startLineNumber: start.row + 1,
          startColumn: start.column + 1,
          endLineNumber: end.row + 1,
          endColumn: end.column + 1,
        },
      },
    ],
  };
}

function fakeWindowTimers(): void {
  (globalThis as unknown as { window: unknown }).window = {
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

/** 发出去的 `parse` 请求（跳过 `open`），按发送次序 */
const parseRequests = (worker: Fake): { id: number; want?: readonly StructureFacet[] }[] =>
  worker.sent
    .filter((m) => (m as { kind?: unknown }).kind === 'parse')
    .map((m) => m as { id: number; want?: readonly StructureFacet[] });

const lastParse = (worker: Fake): { id: number; want?: readonly StructureFacet[] } | undefined => parseRequests(worker).at(-1);

const wantsOf = (worker: Fake): (readonly StructureFacet[] | undefined)[] => parseRequests(worker).map((r) => r.want);

describe('结构 client · 首帧分层（R8：折叠先上，着色后补）', () => {
  let indentCalls: number;

  beforeEach(() => {
    harness.FakeWorker.reset();
    fakeWindowTimers();
    resetStructureDegradationLedger();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    indentCalls = 0;
  });

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  function makeClient(facetsFor?: (model: Monaco.editor.ITextModel) => readonly StructureFacet[] | undefined): {
    client: StructureClient;
    worker: Fake;
  } {
    const client = new StructureClient({
      runtime: RUNTIME,
      languageId: 'kojo',
      timeoutMs: 500,
      bootstrapTimeoutMs: 500,
      ...(facetsFor === undefined ? {} : { facetsFor }),
      onIndent: () => {
        indentCalls += 1;
      },
    });
    client.start();
    const worker = harness.FakeWorker.instances.at(-1)!;
    // v4（LAU-5）：`ready` 必须带 `docBase`（缺了这一格收件闸判"形状不符"并整条降级）
    worker.reply({ ok: true, id: 1, kind: 'ready', protocol: STRUCTURE_PROTOCOL_VERSION, loadMs: 1, docBase: 0 });
    return { client, worker };
  }

  const ALL: readonly StructureFacet[] = ['folds', 'semantic', 'indent', 'syntax'];

  it('开文件三拍：只要折叠 → 只要语义 → 缩进+残缺；每一条都由上一条回话触发（不是一次性全发）', async () => {
    const { client, worker } = makeClient(() => ALL);
    const model = fakeModel('一行\n');
    void client.foldingRanges(model);
    await flush();
    expect(wantsOf(worker), '第一拍只该问折叠（缩进在 ERB 语法上要 +46 ms，会挤破首帧判据）').toEqual([['folds']]);
    // 第一拍还没回话 ⇒ 后两拍一条都不许发（发了就是三份全文一起排进 worker 队列，等于没分层）
    expect(parseRequests(worker)).toHaveLength(1);
    worker.reply(replyOf(lastParse(worker)!.id, 1, 1, { folds: { spans: [0, 3] } }));
    await flush();
    expect(wantsOf(worker).slice(1), '第二拍只该问语义（它最贵，也最显眼）').toEqual([['semantic']]);
    expect(parseRequests(worker), '第二拍在第一拍回话之后 ⇒ 此刻只有两条').toHaveLength(2);
    worker.reply(replyOf(lastParse(worker)!.id, 1, 1, { semantic: captureTable() }));
    await flush();
    expect(wantsOf(worker)[2], '第三拍补缩进与残缺').toEqual(['indent', 'syntax']);
    worker.reply(replyOf(lastParse(worker)!.id, 1, 1, { indent: EMPTY_INDENT, syntax: { faults: [], truncated: false } }));
    await flush();
    expect(parseRequests(worker), '三拍到此为止（再发就是多花一次全文投递）').toHaveLength(3);
    client.dispose();
  });

  it('折叠不等着色：折叠加回来的那一刻就把区间交出去，语义那一拍还在飞', async () => {
    const { client, worker } = makeClient(() => ALL);
    const model = fakeModel('一行\n');
    const folds = client.foldingRanges(model);
    await flush();
    worker.reply(replyOf(lastParse(worker)!.id, 1, 1, { folds: { spans: [0, 3] } }));
    expect(await folds, '折叠该在第一拍回话后立刻到手，不许等语义').toEqual([{ startRow: 0, endRow: 3 }]);
    // 此时语义那一拍刚发出去、还没回话 —— 折叠已经上屏了
    expect(wantsOf(worker)[1]).toEqual(['semantic']);
    client.dispose();
  });

  it('着色必须等语义那一拍：第一拍回话**不**能把它打发成 null（否则这一屏没颜色，要等下一次内容变化）', async () => {
    const { client, worker } = makeClient(() => ALL);
    const model = fakeModel('一行\n');
    let settled: unknown = 'pending';
    const tokens = client.tokens(model).then((value) => {
      settled = value;
      return value;
    });
    await flush();
    worker.reply(replyOf(lastParse(worker)!.id, 1, 1, { folds: { spans: [0, 3] } }));
    await flush();
    expect(settled, '折叠到货不该把等着色的那一趟放走').toBe('pending');
    worker.reply(replyOf(lastParse(worker)!.id, 1, 1, { semantic: captureTable() }));
    await tokens;
    // `tier` 由角色表翻译（捕获名 `comment` → 角色 `role.comment`）；这一格跟着角色表走，
    // 本用例只钉"这一拍把语义交出来了"，不钉角色表怎么取名
    expect(settled).toEqual([{ startRow: 0, startCol: 0, endRow: 0, endCol: 1, tier: 'role.comment', capture: 'comment', node: 'x' }]);
    client.dispose();
  });

  it('`want` 不含语义（体量档摘掉那一面）⇒ 只有两拍，且 `tokens()` 当场交 null 不再等', async () => {
    const { client, worker } = makeClient(() => ['folds', 'indent', 'syntax']);
    const model = fakeModel('一行\n');
    const tokens = client.tokens(model);
    await flush();
    expect(wantsOf(worker), '第一拍照旧只要折叠').toEqual([['folds']]);
    worker.reply(replyOf(lastParse(worker)!.id, 1, 1, { folds: { spans: [0, 3] } }));
    expect(await tokens, '语义这一面这份文档压根没要 ⇒ 立刻交出"没有"').toBeNull();
    await flush();
    expect(wantsOf(worker)[1], '第二拍只补缩进与残缺（语义不在这份文档的清单里）').toEqual(['indent', 'syntax']);
    expect(parseRequests(worker)).toHaveLength(2);
    client.dispose();
  });

  it('缩进那一拍到货 ⇒ 当场回调装配层（否则作者开文件后的第一次回车吃基底规则）', async () => {
    const { client, worker } = makeClient(() => ALL);
    const model = fakeModel('一行\n');
    void client.foldingRanges(model);
    await flush();
    worker.reply(replyOf(lastParse(worker)!.id, 1, 1, { folds: { spans: [0, 3] } }));
    await flush();
    worker.reply(replyOf(lastParse(worker)!.id, 1, 1, { semantic: captureTable() }));
    await flush();
    expect(indentCalls, '缩进还没到货，不该回调').toBe(0);
    worker.reply(replyOf(lastParse(worker)!.id, 1, 1, { indent: EMPTY_INDENT, syntax: { faults: [], truncated: false } }));
    await flush();
    expect(indentCalls, '缩进到货 ⇒ 回调一次').toBe(1);
    client.dispose();
  });

  it('拍还在飞时作者开始打字：差集回话带全部面 ⇒ 后面的拍作废（不许多发一条整篇）', async () => {
    const { client, worker } = makeClient(() => ALL);
    const model = fakeModel('一行');
    void client.foldingRanges(model);
    await flush();
    worker.reply(replyOf(lastParse(worker)!.id, 1, 1, { folds: { spans: [0, 3] } }));
    await flush();
    expect(parseRequests(worker), '此刻第二拍（语义）在飞').toHaveLength(2);
    model.edit('一行字');
    await flush();
    const change = worker.sent.at(-1) as { kind: string; want?: readonly StructureFacet[]; edit?: unknown };
    expect(change.kind, '有基线树 ⇒ 走差集').toBe('parse');
    expect(change.edit, '这条是差集请求').toBeDefined();
    expect(change.want, '差集回话带全部面 ⇒ 这一条不该按拍裁剪').toEqual(['folds', 'semantic', 'indent', 'syntax']);
    const before = parseRequests(worker).length;
    // 差集回话（带全部面）⇒ 不该再补发任何拍
    worker.reply({
      ...replyOf(lastParse(worker)!.id, 1, 2, {
        folds: { spans: [0, 3] },
        semantic: captureTable(),
        indent: EMPTY_INDENT,
        syntax: { faults: [], truncated: false },
      }),
      incremental: true,
    });
    await flush();
    expect(parseRequests(worker), '差集之后又发了拍 ⇒ 白付一次全文投递').toHaveLength(before);
    client.dispose();
  });

  it('还没有基线树就编辑：当场一拍到底（整篇、全集），之后的拍不再补', async () => {
    const { client, worker } = makeClient(() => ALL);
    const model = fakeModel('一行');
    void client.foldingRanges(model);
    await flush();
    expect(parseRequests(worker), '第一拍在飞').toHaveLength(1);
    model.edit('一行字');
    await flush();
    const full = lastParse(worker)!;
    expect(full.want, '没有基线树 ⇒ 只能整篇重发，一拍到底（要全集）').toEqual(['folds', 'semantic', 'indent', 'syntax']);
    const before = parseRequests(worker).length;
    worker.reply(replyOf(full.id, 1, 2, {
      folds: { spans: [0, 3] },
      semantic: captureTable(),
      indent: EMPTY_INDENT,
      syntax: { faults: [], truncated: false },
    }));
    await flush();
    expect(parseRequests(worker), '一拍到底之后不许再补拍').toHaveLength(before);
    client.dispose();
  });
});
