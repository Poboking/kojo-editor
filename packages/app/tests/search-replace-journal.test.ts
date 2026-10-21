/**
 * 2026-10-18 undo 覆盖批：闭文件批量替换进 OpJournal 的行为面。
 *
 * 钉五件事（全部用 mock journal + 假 io，不碰 Monaco 注册表与真盘）：
 * ① **正常路径**——整批一次 begin（kind=search-replace）→ 逐文件 record（写之前）
 *    → commit；abort 不被调；
 * ② **record 失败**——该文件跳过不写（记不了账的批量改动不做），其余文件照常，
 *    错误如实出现在 outcome.errors；
 * ③ **begin 失败**——闭文件腿整体取消（fail-safe），活面腿不受影响（Monaco 自己的 undo）；
 * ④ **commit 失败**——文件已写、快照保留，报错不回滚（不假装成功也不丢已做的替换）；
 * ⑤ **中途被打开**——record 之后活面复查发现成标签 ⇒ 跳过并如实报告（io 写盘会
 *    绕过 live buffer 盖掉编辑器里的脏内容，那是数据损坏，宁可少改一处）。
 *
 * journal 缺席 = 旧行为零改动，由 search-replace-exec-concurrent.test.ts 的全部既有
 * 用例（不传 journal）钉住，此处不重复。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { createFileReplaceRunner, type FileReplaceDeps } from '../src/ui/search-replace-exec';

type OpJournalLike = NonNullable<FileReplaceDeps['journal']>;

interface JournalOpts {
  failBegin?: boolean;
  failRecord?: ReadonlySet<string>;
  failCommit?: boolean;
}

/** mock journal：记下 begin/record/commit/abort 的调用序列（与 io 的写盘动作混排，可断顺序） */
function mockJournal(
  opts: JournalOpts = {},
  calls: Array<{ m: string; a?: string; b?: string }> = [],
): { journal: OpJournalLike; calls: Array<{ m: string; a?: string; b?: string }> } {
  let seq = 0;
  return {
    calls,
    journal: {
      async begin(kind: string, label: string): Promise<string> {
        calls.push({ m: 'begin', a: kind, b: label });
        if (opts.failBegin) throw new Error('账本起不来');
        return `op-${++seq}`;
      },
      async record(opId: string, path: string): Promise<void> {
        calls.push({ m: 'record', a: opId, b: path });
        if (opts.failRecord?.has(path)) throw new Error('记账失败');
      },
      async commit(opId: string): Promise<void> {
        calls.push({ m: 'commit', a: opId });
        if (opts.failCommit) throw new Error('收尾失败');
      },
      async abort(opId: string): Promise<void> {
        calls.push({ m: 'abort', a: opId });
      },
    },
  };
}

interface Harness {
  files: Map<string, string>;
  io: FileReplaceDeps['io'];
  calls: Array<{ m: string; a?: string; b?: string }>;
}

/** `calls` 与 mockJournal 共用同一序列（record 与 write 混排才能断"先记账后写盘"） */
function harness(
  initial: Record<string, string>,
  writable: readonly string[],
  calls: Array<{ m: string; a?: string; b?: string }> = [],
): Harness {
  const files = new Map(Object.entries(initial));
  return {
    files,
    calls,
    io: {
      isWritable: (p) => writable.includes(p),
      readText: async (p) => {
        const text = files.get(p);
        if (text === undefined) throw new Error(`没有这个文件：${p}`);
        return { text };
      },
      writeText: async (p, text) => {
        calls.push({ m: 'write', a: p });
        files.set(p, text);
      },
    },
  };
}

const request = (paths: readonly string[], patch: Partial<{ query: string; replaceText: string }> = {}) =>
  ({
    query: patch.query ?? 'FOO',
    replaceText: patch.replaceText ?? 'BAR',
    options: { isRegex: false, wholeWord: true, caseSensitive: false },
    mode: { kind: 'all' },
    files: paths.map((path) => ({ path })),
  }) as unknown as Parameters<ReturnType<typeof createFileReplaceRunner>>[0];

const openModel = (applied: () => void): Monaco.editor.ITextModel =>
  ({
    getLineCount: () => 2,
    getLineContent: (n: number) => (n === 1 ? 'CALL FOO' : 'PRINTL FOO'),
    // 活面腿走**上栈通道**（前停点 → pushEditOperations → 后停点）；本文件钉的是 journal 记账序，
    // 撤销段的行为取证在 search-replace-exec-undo.test.ts 的真 monaco model 上
    pushStackElement: () => {},
    pushEditOperations: (_before: null, _edits: unknown[], _computer: () => null) => applied(),
  }) as unknown as Monaco.editor.ITextModel;

describe('闭文件批量替换进 OpJournal（2026-10-18 undo 覆盖批）', () => {
  it('正常路径：begin 一次（含文件数标签）→ 每文件先 record 后写 → commit；abort 不被调', async () => {
    const { journal, calls } = mockJournal();
    const h = harness(
      { 'C:/p/ERB/a.ERB': 'CALL FOO\n', 'C:/p/ERB/b.ERB': 'CALL FOO\n', 'C:/p/ERB/ro.ERB': 'CALL FOO\n' },
      ['C:/p/ERB/a.ERB', 'C:/p/ERB/b.ERB', 'C:/p/ERB/open.ERB'],
      calls,
    );
    let openApplied = 0;
    const out = await createFileReplaceRunner({
      io: h.io,
      modelFor: (p) => (p === 'C:/p/ERB/open.ERB' ? openModel(() => openApplied++) : undefined),
      journal,
    })(request(['C:/p/ERB/a.ERB', 'C:/p/ERB/b.ERB', 'C:/p/ERB/ro.ERB', 'C:/p/ERB/open.ERB']));

    expect(out.applied).toBe(4); // 闭文件两个各 1 处 + 活面 2 处（只读文件不算）
    expect(out.errors.join('\n')).toContain('只读');
    expect(openApplied).toBe(1); // 活面腿不受 journal 影响

    const begin = calls.filter((c) => c.m === 'begin');
    expect(begin).toHaveLength(1);
    expect(begin[0]!.a).toBe('search-replace');
    expect(begin[0]!.b).toContain('2 个未打开文件'); // 只读文件不进闭文件清单
    const opId = calls.find((c) => c.m === 'commit')?.a;
    expect(opId).toBe('op-1');
    // 每个闭文件：record 先于自己的写（记不了账的文件不写）
    const records = calls.filter((c) => c.m === 'record');
    expect(records.map((r) => r.b).sort()).toEqual(['C:/p/ERB/a.ERB', 'C:/p/ERB/b.ERB']);
    for (const r of records) {
      const writeAt = calls.findIndex((c) => c.m === 'write' && c.a === r.b);
      const recordAt = calls.findIndex((c) => c.m === 'record' && c.b === r.b);
      expect(writeAt).toBeGreaterThan(recordAt);
    }
    expect(calls.filter((c) => c.m === 'commit')).toHaveLength(1);
    expect(calls.filter((c) => c.m === 'abort')).toHaveLength(0);
    expect(h.files.get('C:/p/ERB/a.ERB')).toBe('CALL BAR\n');
  });

  it('record 失败：该文件跳过不写并如实报告；其余文件照常进账', async () => {
    const h = harness(
      { 'C:/p/ERB/ok.ERB': 'CALL FOO\n', 'C:/p/ERB/bad.ERB': 'CALL FOO\n' },
      ['C:/p/ERB/ok.ERB', 'C:/p/ERB/bad.ERB'],
    );
    const { journal } = mockJournal({ failRecord: new Set(['C:/p/ERB/bad.ERB']) });
    const out = await createFileReplaceRunner({ io: h.io, modelFor: () => undefined, journal })(
      request(['C:/p/ERB/ok.ERB', 'C:/p/ERB/bad.ERB']),
    );
    expect(out.applied).toBe(1);
    expect(out.filesChanged).toBe(1);
    expect(h.files.get('C:/p/ERB/ok.ERB')).toBe('CALL BAR\n');
    expect(h.files.get('C:/p/ERB/bad.ERB')).toBe('CALL FOO\n'); // 记不了账 ⇒ 没写
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain('C:/p/ERB/bad.ERB');
    expect(out.errors[0]).toContain('记账失败');
  });

  it('begin 失败：闭文件腿整体取消（一条都不写），活面腿照常走 Monaco', async () => {
    const h = harness(
      { 'C:/p/ERB/a.ERB': 'CALL FOO\n', 'C:/p/ERB/b.ERB': 'CALL FOO\n' },
      ['C:/p/ERB/a.ERB', 'C:/p/ERB/b.ERB', 'C:/p/ERB/open.ERB'],
    );
    h.files.set('C:/p/ERB/open.ERB', 'CALL FOO\nPRINTL FOO\n');
    const { journal, calls } = mockJournal({ failBegin: true });
    let openApplied = 0;
    const out = await createFileReplaceRunner({
      io: h.io,
      modelFor: (p) => (p === 'C:/p/ERB/open.ERB' ? openModel(() => openApplied++) : undefined),
      journal,
    })(request(['C:/p/ERB/a.ERB', 'C:/p/ERB/b.ERB', 'C:/p/ERB/open.ERB']));

    expect(out.applied).toBe(2); // 只有活面（一次上栈的 pushEditOperations 落两处 FOO）
    expect(calls.filter((c) => c.m === 'write')).toHaveLength(0); // 一条闭文件都没写
    expect(h.files.get('C:/p/ERB/a.ERB')).toBe('CALL FOO\n'); // 盘没动
    expect(openApplied).toBe(1);
    expect(calls.filter((c) => c.m === 'record')).toHaveLength(0);
    expect(calls.filter((c) => c.m === 'commit')).toHaveLength(0);
    expect(out.errors.some((e) => e.includes('批操作账本不可用') && e.includes('已整体取消'))).toBe(true);
  });

  it('commit 失败：文件已写完（盘上是新内容），报错说明快照保留、不回滚不假装成功', async () => {
    const h = harness({ 'C:/p/ERB/a.ERB': 'CALL FOO\n' }, ['C:/p/ERB/a.ERB']);
    const { journal } = mockJournal({ failCommit: true });
    const out = await createFileReplaceRunner({ io: h.io, modelFor: () => undefined, journal })(
      request(['C:/p/ERB/a.ERB']),
    );
    expect(out.applied).toBe(1);
    expect(h.files.get('C:/p/ERB/a.ERB')).toBe('CALL BAR\n'); // 替换已经落盘
    expect(out.errors.some((e) => e.includes('收尾失败') && e.includes('快照已保留'))).toBe(true);
  });

  it('中途被打开：record 后活面复查发现成标签 ⇒ 跳过该文件并如实报告（不盖编辑器脏内容）', async () => {
    const h = harness({ 'C:/p/ERB/a.ERB': 'CALL FOO\n' }, ['C:/p/ERB/a.ERB']);
    const { journal, calls } = mockJournal();
    // 同一 path 第二次被问（= 第二趟活面复查）⇒ 已被打开成标签
    const seen = new Set<string>();
    const out = await createFileReplaceRunner({
      io: h.io,
      modelFor: (p) => {
        if (seen.has(p)) return openModel(() => {});
        seen.add(p);
        return undefined;
      },
      journal,
    })(request(['C:/p/ERB/a.ERB']));
    expect(out.applied).toBe(0);
    expect(calls.filter((c) => c.m === 'write')).toHaveLength(0); // 没写盘
    expect(h.files.get('C:/p/ERB/a.ERB')).toBe('CALL FOO\n');
    expect(out.errors).toEqual([
      'C:/p/ERB/a.ERB：替换执行期间被打开成编辑器标签，已跳过（未覆盖编辑器中的内容）；请关闭后重试或改在编辑器内替换',
    ]);
    // record 还是发生了（第一趟判定时它确实是闭文件）——账记了、盘没动，undo 是空操作
    expect(calls.filter((c) => c.m === 'record')).toHaveLength(1);
    expect(calls.filter((c) => c.m === 'commit')).toHaveLength(1); // 空批也正常收尾
  });
});