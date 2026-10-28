// @vitest-environment happy-dom
/**
 * 结构 client 的**增量编辑路**，用真 Monaco model 打（不是桩 model）。
 *
 * ## 为什么必须再有一份（已经有 `tree-sitter-edit-from-changes.test.ts` 了）
 *
 * 那份打的是纯函数：给定"旧文 + 一段 Monaco 会给的事件"，缝出来的编辑对不对。它证明不了
 * **Monaco 真给的事件就是这个形状**——`rangeOffset` 按哪个 EOL 数、`change.text` 会不会被
 * 归一、`setValue` 是不是 `isFlush`、撤销越界时 `changes` 还讲不讲道理。这些假设一旦错，
 * 纯函数测试全绿而真机静默错位，所以这里用 `monaco.editor.createModel` 造**真模型**，
 * 让 `StructureClient` 直接订阅它，逐条比对"代理手上的快照"与 `model.getValue()`。
 *
 * ## 钉的六条
 *
 * 1. **打字走增量**：一次插入/退格 ⇒ 发出去的是 `parse{edit}`（不带整篇），快照与模型逐字相等；
 * 2. **一次事件多段**（`applyEdits` 两处）⇒ 并成一条保守编辑，快照仍逐字相等；
 * 3. **`setValue` 是 flush** ⇒ 当场退回整篇（带 `text`、不带 `edit`）；
 * 4. **撤销**：不论走哪条腿，快照必须仍与模型逐字相等（判据只认一致性，不认哪条腿）；
 * 5. **CRLF 文档**：偏移按模型 EOL 数，快照与 `getValue()` 逐字相等（串长也等）；
 * 6. **随机 200 步**（固定种子）：每步之后快照 == `model.getValue()`。
 *
 * worker 线程是桩（只记录 `postMessage`、由测试回话），真 wasm 归真壳冒烟。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as monaco from '../src/monaco/entry';
import { StructureClient } from '../src/monaco/tree-sitter/client';
import { applyEdit, type StructureEdit } from '../src/monaco/tree-sitter/edit';
import type { StructureLanguageRuntime } from '../src/monaco/tree-sitter/structure-runtime';
import { STRUCTURE_PROTOCOL_VERSION } from '@kojo/kojo-core';

/* ============================ 可编程 FakeWorker ============================ */

const harness = vi.hoisted(() => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
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
      /* 无副作用 */
    }
    reply(data: unknown): void {
      this.onmessage?.({ data });
    }
  }
  return { FakeWorker };
});

const RUNTIME: StructureLanguageRuntime = {
  runtimeWasmUrl: 'runtime.wasm（桩）',
  grammarWasmUrl: 'grammar.wasm（桩）',
  createWorker: () => new harness.FakeWorker() as unknown as Worker,
};

type Fake = InstanceType<typeof harness.FakeWorker>;

/** 发出去的一条 `parse` 请求里本文件要的那几格 */
interface Post {
  id: number;
  kind: string;
  doc: number;
  version: number;
  text?: string;
  edit?: StructureEdit;
  baseTreeId?: string;
}

const posts = (worker: Fake): Post[] =>
  worker.sent.filter((m): m is Post => (m as { kind?: unknown }).kind === 'parse');

const EMPTY_INDENT = { increasePatterns: [], decreasePatterns: [], enterPatterns: [] };

/** 回一条 `parse`（四面都给：缺面在客户端是"这一面这次没算"的强信号，会被判停） */
function replyParse(worker: Fake, post: Post, treeId = 't1'): void {
  worker.reply({
    ok: true,
    id: post.id,
    kind: 'parse',
    doc: post.doc,
    version: post.version,
    treeId,
    incremental: post.edit !== undefined,
    facets: {
      semantic: { names: [], nodes: [], spans: [] },
      folds: { spans: [] },
      indent: EMPTY_INDENT,
      syntax: { faults: [], truncated: false },
    },
    metrics: { parseMs: 1, queryMs: 0, textLength: 1 },
  });
}

/** 把微任务排干净（client 的等待者都在 promise 链上） */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

/**
 * 把"还没回过的 parse 请求"全部回掉，并**沿路推进快照**。
 *
 * 快照的推进口径就是被测的契约：`parse{text}` ⇒ 整篇替换，`parse{edit}` ⇒ 按编辑缝。
 * 任何一条对不上，后面每一条都会跟着错——所以逐条比 `model.getValue()` 才有意义。
 */
async function settle(worker: Fake, shadow: { text: string }): Promise<void> {
  await flush();
  const sent = posts(worker);
  const pendingCount = sent.length - replied;
  for (let i = 0; i < pendingCount; i += 1) {
    const post = sent[replied + i]!;
    shadow.text = post.text !== undefined ? post.text : applyEdit(shadow.text, post.edit!);
    replyParse(worker, post);
  }
  replied = sent.length;
  await flush();
}

let replied = 0;

/* ================================ 脚手架 ================================ */

const models: monaco.editor.ITextModel[] = [];
let seq = 0;

function makeModel(text: string): monaco.editor.ITextModel {
  const model = monaco.editor.createModel(
    text,
    'plaintext',
    monaco.Uri.parse(`inmemory://ts-client-real/${++seq}`),
  );
  models.push(model);
  return model;
}

/** 真 client + 桩 worker，装配完（ready 已回） */
function makeReadyClient(): { client: StructureClient; worker: Fake } {
  const client = new StructureClient({
    runtime: RUNTIME,
    languageId: 'erb',
    timeoutMs: 5_000,
    bootstrapTimeoutMs: 5_000,
    onFatal: () => undefined,
  });
  expect(client.start()).toBe(true);
  const worker = harness.FakeWorker.instances.at(-1)!;
  // v4（LAU-5）：`ready` 必须带 `docBase`——单引擎桩回 0，号段起点就落在 0 上
  worker.reply({
    ok: true,
    id: (worker.sent[0] as { id: number }).id,
    kind: 'ready',
    protocol: STRUCTURE_PROTOCOL_VERSION,
    loadMs: 1,
    docBase: 0,
  });
  return { client, worker };
}

/** 在 (行, 列) 处插入/替换一段（与作者打字同一条 `pushEditOperations`） */
function typeAt(model: monaco.editor.ITextModel, start: [number, number], end: [number, number], text: string): void {
  model.pushEditOperations(
    null,
    [{ range: new monaco.Range(start[0], start[1], end[0], end[1]), text }],
    () => null,
  );
}

const SEED_SAMPLES = `
[IF A == 1]
  PRINTFORM 台詞
[ENDIF]
#DIM 心情 = 0
$ 一行注释
`;

beforeEach(() => {
  replied = 0;
  harness.FakeWorker.instances = [];
});

afterEach(() => {
  for (const model of models.splice(0)) if (!model.isDisposed()) model.dispose();
});

/* ================================ 判据 ================================ */

describe('真 Monaco model 上的增量编辑路', () => {
  it('(1) 打字走增量：发 edit、不发整篇，快照与模型逐字相等', async () => {
    const { client, worker } = makeReadyClient();
    const model = makeModel(SEED_SAMPLES);
    const shadow = { text: model.getValue() };
    void client.tokens(model);
    await settle(worker, shadow); // 整篇那一条（track 时的 parse）

    // 行内插入
    typeAt(model, [2, 3], [2, 3], 'X');
    await flush();
    expect(posts(worker).at(-1), '插入该走 edit').toMatchObject({ version: 2, baseTreeId: 't1' });
    expect(posts(worker).at(-1)!.edit, '必须带 edit').toBeDefined();
    expect(posts(worker).at(-1)!.text, '不许再带整篇').toBeUndefined();
    await settle(worker, shadow);
    expect(shadow.text, '插入后快照').toBe(model.getValue());

    // 退格（删一个字符）
    typeAt(model, [2, 3], [2, 4], '');
    await settle(worker, shadow);
    expect(posts(worker).at(-1)!.text, '删除也不该带整篇').toBeUndefined();
    expect(shadow.text).toBe(model.getValue());

    // 换行插入（跨行，新终点落到下一行行首）
    typeAt(model, [1, 9], [1, 9], '\nNEW\n');
    await settle(worker, shadow);
    expect(shadow.text).toBe(model.getValue());
    expect(shadow.text).toContain('NEW');
    client.dispose();
  });

  it('(2) 一次事件多段（多光标 applyEdits）⇒ 并成一条保守编辑，快照仍相等', async () => {
    const { client, worker } = makeReadyClient();
    const model = makeModel(SEED_SAMPLES);
    const shadow = { text: model.getValue() };
    void client.tokens(model);
    await settle(worker, shadow);

    model.applyEdits([
      { range: new monaco.Range(2, 3, 2, 7), text: 'PRINTFORM2' },
      { range: new monaco.Range(5, 1, 5, 2), text: '//' },
    ]);
    await settle(worker, shadow);
    const last = posts(worker).at(-1)!;
    expect(last.text, '多段也是一条 edit').toBeUndefined();
    expect(last.edit, '并成一条').toBeDefined();
    expect(shadow.text).toBe(model.getValue());
    client.dispose();
  });

  it('(3) setValue 是 flush ⇒ 当场退回整篇', async () => {
    const { client, worker } = makeReadyClient();
    const model = makeModel(SEED_SAMPLES);
    const shadow = { text: model.getValue() };
    void client.tokens(model);
    await settle(worker, shadow);

    model.setValue('完全换掉\n第二行\n');
    await settle(worker, shadow);
    const last = posts(worker).at(-1)!;
    expect(last.edit, 'flush 不许走增量').toBeUndefined();
    expect(last.text).toBe('完全换掉\n第二行\n');
    expect(shadow.text).toBe(model.getValue());
    client.dispose();
  });

  it('(4) 撤销：不论走哪条腿，快照必须仍与模型逐字相等', async () => {
    const { client, worker } = makeReadyClient();
    const model = makeModel(SEED_SAMPLES);
    const shadow = { text: model.getValue() };
    void client.tokens(model);
    await settle(worker, shadow);

    model.pushStackElement();
    typeAt(model, [1, 1], [1, 1], 'AAA');
    model.pushStackElement();
    typeAt(model, [3, 1], [3, 1], 'BBB');
    await settle(worker, shadow);
    expect(shadow.text).toBe(model.getValue());

    model.undo();
    await settle(worker, shadow);
    expect(shadow.text, '撤销一步后').toBe(model.getValue());
    model.undo();
    await settle(worker, shadow);
    expect(shadow.text, '再撤一步').toBe(model.getValue());
    expect(shadow.text).not.toContain('AAA');
    client.dispose();
  });

  it('(5) CRLF 文档：偏移按模型 EOL 数，快照与 getValue() 逐字相等', async () => {
    const { client, worker } = makeReadyClient();
    const model = makeModel('甲\r\n乙\r\n丙');
    expect(model.getEOL()).toBe('\r\n');
    const shadow = { text: model.getValue() };
    expect(shadow.text.length, 'CRLF 串长').toBe(7);
    void client.tokens(model);
    await settle(worker, shadow);

    typeAt(model, [2, 1], [2, 1], '插入\r\n');
    await settle(worker, shadow);
    expect(posts(worker).at(-1)!.text, 'CRLF 下也该走增量').toBeUndefined();
    expect(shadow.text).toBe(model.getValue());
    expect(shadow.text.length).toBe(model.getValue().length);
    expect(model.getValue().split('\r\n').length, '行数（含插进来的那一行）').toBe(4);
    client.dispose();
  });

  it('(6) 行数对账不符 ⇒ 退回整篇（自检真的在起作用）', async () => {
    const { client, worker } = makeReadyClient();
    const model = makeModel(SEED_SAMPLES);
    const shadow = { text: model.getValue() };
    void client.tokens(model);
    await settle(worker, shadow);

    // 让模型自报一个错的行数：增量口径与它对不上，就只许退回整篇
    const real = model.getLineCount();
    const spy = vi.spyOn(model, 'getLineCount').mockReturnValue(real + 7);
    typeAt(model, [1, 1], [1, 1], 'X');
    await settle(worker, shadow);
    spy.mockRestore();
    expect(posts(worker).at(-1)!.edit, '对账不符 ⇒ 不许发增量').toBeUndefined();
    expect(posts(worker).at(-1)!.text).toBe(model.getValue());
    client.dispose();
  });

  it('(7) 随机 200 步（固定种子）：每一步之后快照都与模型逐字相等', async () => {
    const { client, worker } = makeReadyClient();
    const model = makeModel(SEED_SAMPLES.repeat(3));
    const shadow = { text: model.getValue() };
    void client.tokens(model);
    await settle(worker, shadow);

    const random = mulberry32(0x9e3779b9);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const SNIPPETS = ['x', '', '\n', 'PRINT 1\n', '😀', '台詞を書く', '\r\n'] as const;

    for (let step = 0; step < 200; step += 1) {
      const lineCount = model.getLineCount();
      const line = 1 + Math.floor(random() * lineCount);
      const maxColumn = model.getLineMaxColumn(line);
      const startColumn = 1 + Math.floor(random() * maxColumn);
      const endLine = Math.min(lineCount, line + Math.floor(random() * 2));
      const endColumn = endLine === line ? Math.min(maxColumn, startColumn + Math.floor(random() * 4)) : 1;
      typeAt(model, [line, startColumn], [endLine, endColumn], pick(SNIPPETS));
      await settle(worker, shadow);
      expect(shadow.text, `第 ${step} 步之后`).toBe(model.getValue());
    }
    // 这一路走下来的增量请求必须占多数（否则"快照相等"只是整篇重解的副作用）
    const total = posts(worker).length;
    const incremental = posts(worker).filter((p) => p.edit !== undefined).length;
    expect(incremental / total, `增量占比 ${incremental}/${total}`).toBeGreaterThan(0.9);
    client.dispose();
  });
});

/** 固定种子（mulberry32）：可复现的随机编辑序列 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
