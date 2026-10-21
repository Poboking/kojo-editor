/**
 * PS-13 等价性：闭文件腿并发窗口化（`CLOSED_REPLACE_CONCURRENCY`）后，
 * 产出与串行版（`closedConcurrency: 1`）**逐项同值同序**。
 *
 * 钉三件事：
 * ① **对拍**——同一份混合面输入（正常 / 只读 / 读失败 / 活面 model / `pathKey`
 *    重复写法），并发版与串行版的 applied / filesChanged / readOnlyFiles /
 *    errors（含顺序，ledger 按原序折叠）逐字相同，盘上最终字节逐文件相同；
 * ② **并发度读数**——200 个闭文件，在途峰值恰为窗口大小（缺省 8；注入 3 ⇒ 3），
 *    证明第二趟真的并发且不越窗；
 * ③ **错误顺序**——读失败文件穿插在正常文件之间时，errors 按文件在去重序列里
 *    的原序说出（不是完成序）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import {
  CLOSED_REPLACE_CONCURRENCY,
  createFileReplaceRunner,
  type FileReplaceDeps,
} from '../src/ui/search-replace-exec';

const P = (i: number) => `C:/p/ERB/f${String(i).padStart(3, '0')}.ERB`;

interface Harness {
  files: Map<string, string>;
  writes: string[];
  io: FileReplaceDeps['io'];
  /** 闭文件 io 在途计数（readText 进 / 出），`maxInFlight` 是峰值——并发度读数 */
  inFlight: number;
  maxInFlight: number;
  delayMs: number;
}

function harness(
  initial: Record<string, string>,
  writable: readonly string[],
  delayMs = 0,
): Harness {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const h = {
    files,
    writes,
    inFlight: 0,
    maxInFlight: 0,
    delayMs,
    io: null as unknown as FileReplaceDeps['io'],
  };
  const gate = async () => {
    h.inFlight++;
    if (h.inFlight > h.maxInFlight) h.maxInFlight = h.inFlight;
    if (h.delayMs > 0) await new Promise((r) => setTimeout(r, h.delayMs));
    h.inFlight--;
  };
  h.io = {
    isWritable: (p) => writable.includes(p),
    readText: async (p) => {
      await gate();
      const text = files.get(p);
      if (text === undefined) throw new Error(`没有这个文件：${p}`);
      return { text };
    },
    writeText: async (p, text) => {
      await gate();
      writes.push(p);
      files.set(p, text);
    },
  };
  return h;
}

const request = (
  files: readonly { path: string; matches?: unknown[] }[],
  patch: Partial<{ query: string; replaceText: string }> = {},
) =>
  ({
    query: patch.query ?? 'FOO',
    replaceText: patch.replaceText ?? 'BAR',
    options: { isRegex: false, wholeWord: true, caseSensitive: false },
    mode: { kind: 'all' },
    files,
  }) as unknown as Parameters<ReturnType<typeof createFileReplaceRunner>>[0];

describe('PS-13：闭文件替换并发窗口化（产出与串行版逐项等价）', () => {
  it('混合面（正常/只读/读失败/活面/pathKey 重复）：并发版与串行版逐项同产出', async () => {
    // 混合面 = 24 个正常闭文件 + 2 只读 + 1 读失败 + 1 活面 + 1 重复写法（pathKey 同键）
    const initial: Record<string, string> = {};
    const paths: string[] = [];
    for (let i = 0; i < 24; i++) {
      initial[P(i)] = 'CALL FOO\nPRINTL FOO\n';
      paths.push(P(i));
    }
    initial['C:/p/ERB/ro1.ERB'] = 'CALL FOO\n';
    initial['C:/p/ERB/ro2.ERB'] = 'CALL FOO\n';
    paths.push('C:/p/ERB/ro1.ERB', 'C:/p/ERB/ro2.ERB');
    paths.push('C:/p/ERB/missing.ERB'); // 不在 files 里：readText 抛错（读失败腿）
    const openModel = {
      getLineCount: () => 2,
      getLineContent: (n: number) => (n === 1 ? 'CALL FOO' : 'PRINTL FOO'),
      // 上栈通道（等价性用例只关心产出计数，落地行为真身取证见 search-replace-exec-undo.test.ts）
      pushStackElement: () => {},
      pushEditOperations: (_before: null, _edits: unknown[], _computer: () => null) => {},
    } as unknown as Monaco.editor.ITextModel;
    paths.push('C:/p/ERB/open.ERB'); // 活面：走 model，不进闭文件清单
    // 重复写法：同一份正文的两种拼写（pathKey 折叠大小写 + 分隔符），只许替换一次
    initial['C:/p/ERB/dup.ERB'] = 'CALL FOO\n';
    paths.push('C:/p/ERB/dup.ERB', 'c:\\p\\erb\\dup.erb');

    const writable = [...Object.keys(initial), 'C:/p/ERB/missing.ERB'].filter(
      (p) => !p.startsWith('C:/p/ERB/ro'), // ro1 / ro2 只读
    );
    const h1 = harness({ ...initial }, writable);
    const h2 = harness({ ...initial }, writable); // 两份输入完全一致（读失败由 missing.ERB 承担）

    const run = (h: Harness, closedConcurrency: number | undefined) =>
      createFileReplaceRunner({
        io: h.io,
        modelFor: (p) => (p === 'C:/p/ERB/open.ERB' ? openModel : undefined),
        ...(closedConcurrency === undefined ? {} : { closedConcurrency }),
      })(request(paths.map((path) => ({ path }))));

    const serial = await run(h1, 1); // 串行封存版（对照旋钮）
    const concurrent = await run(h2, undefined); // 缺省 = CLOSED_REPLACE_CONCURRENCY

    // ① 计数逐项同值
    expect(concurrent.applied).toBe(serial.applied);
    expect(concurrent.filesChanged).toBe(serial.filesChanged);
    expect(concurrent.readOnlyFiles).toBe(serial.readOnlyFiles);
    expect(concurrent.stale).toBe(serial.stale);
    // ② errors 逐字同序（ledger 按去重序列原序折叠，不是完成序）
    expect(concurrent.errors).toEqual(serial.errors);
    expect(serial.errors).toHaveLength(2); // 读失败明细在前、只读汇总在后
    expect(serial.errors[0]).toBe('C:/p/ERB/missing.ERB：没有这个文件：C:/p/ERB/missing.ERB');
    expect(serial.errors[1]).toContain('2 个文件只读未纳入');
    // ③ 盘上最终字节逐文件相同（活面与重复写法不落盘）
    const keys1 = [...h1.files.keys()].sort();
    expect([...h2.files.keys()].sort()).toEqual(keys1);
    for (const k of keys1) expect(h2.files.get(k)).toBe(h1.files.get(k));
    expect(h1.files.get(P(0))).toBe('CALL BAR\nPRINTL BAR\n');
    expect(h1.files.get('C:/p/ERB/dup.ERB')).toBe('CALL BAR\n'); // 重复写法只替换一次（不双写）
    // 有实改才写盘：filesChanged 26 = 闭文件 25 + 活面 1（活面走上栈的 pushEditOperations，不落 io）
    expect(serial.filesChanged).toBe(26);
    expect(h1.writes).toHaveLength(25);
    expect([...h2.writes].sort()).toEqual([...h1.writes].sort()); // 写集合同（顺序不承诺）
  });

  it('读失败穿插在正常文件之间：errors 按文件原序说出（不是完成序）', async () => {
    const initial: Record<string, string> = {};
    const paths: string[] = [];
    for (let i = 0; i < 6; i++) {
      const p = P(i);
      if (i % 2 === 1) {
        paths.push(p); // 奇数位读失败（文件不存在）
        continue;
      }
      initial[p] = 'CALL FOO\n';
      paths.push(p);
    }
    const writable = [P(0), P(1), P(2), P(3), P(4), P(5)];
    const h = harness(initial, writable, 1);
    const out = await createFileReplaceRunner({ io: h.io, modelFor: () => undefined })(
      request(paths.map((path) => ({ path }))),
    );
    expect(out.applied).toBe(3);
    expect(out.errors).toEqual(
      [P(1), P(3), P(5)].map((p) => `${p}：没有这个文件：${p}`),
    );
  });

  it(`并发度读数：200 个闭文件，在途峰值 = 窗口（缺省 ${CLOSED_REPLACE_CONCURRENCY}）`, async () => {
    const initial: Record<string, string> = {};
    const paths: string[] = [];
    for (let i = 0; i < 200; i++) {
      initial[P(i)] = 'CALL FOO\n';
      paths.push(P(i));
    }
    const h = harness(initial, paths, 1);
    const out = await createFileReplaceRunner({ io: h.io, modelFor: () => undefined })(
      request(paths.map((path) => ({ path }))),
    );
    expect(out.applied).toBe(200);
    expect(out.filesChanged).toBe(200);
    expect(out.errors).toEqual([]);
    expect(h.maxInFlight).toBe(CLOSED_REPLACE_CONCURRENCY); // 恰好满窗，不越窗
    expect(h.maxInFlight).toBeGreaterThan(1); // 真的并发了（串行版恒为 1）
  });

  it('注入 closedConcurrency: 3 ⇒ 在途峰值 3（旋钮生效）', async () => {
    const initial: Record<string, string> = {};
    const paths: string[] = [];
    for (let i = 0; i < 20; i++) {
      initial[P(i)] = 'CALL FOO\n';
      paths.push(P(i));
    }
    const h = harness(initial, paths, 1);
    const out = await createFileReplaceRunner({
      io: h.io,
      modelFor: () => undefined,
      closedConcurrency: 3,
    })(request(paths.map((path) => ({ path }))));
    expect(out.applied).toBe(20);
    expect(h.maxInFlight).toBe(3);
  });
});