/**
 * **出现点台账**（`ui/reference-utils.ts`，W8 XLANG-RENAME）单测。
 *
 * 钉四件事：
 * ① 计数口径单源——F12 的全出现点数与「被调用」面板的 call 数从**同一份** tally 导出，
 *    差值可解释（定义 + 提及 + 未分类）；
 * ② 同位多方上报合并取最具体分类（定义 > 调用 > 提及 > 未分类），供方没给分类就是没给
 *    （进 `unclassified`，不猜成 call）；
 * ③ 写通道闸门：分组 + 只读剔除一份实现，rename 与替换共用同一段文案前缀；
 * ④ `rewriteClosedFile` 的三步纪律（先闸写权限 / 现文本改写 / 零改动不写盘）。
 */

import { describe, expect, it } from 'vitest';
import type { ErbReference } from '@kojo/plugin-api';
import {
  erbOccurrences,
  explainReferenceCounts,
  findNameTokenPositions,
  isKojoSourcePath,
  isMoreSpecificKind,
  languageOfPath,
  mergeOccurrences,
  occurrencePositionKey,
  occurrencesFromLocations,
  occurrencesToLocations,
  planReferenceWrites,
  readOnlyFilesNotice,
  readOnlyFilesReason,
  residualOutsideScopeNotice,
  tallyReferenceOccurrences,
  rewriteClosedFile,
  type ClosedFileIo,
} from '../src/ui/reference-utils';

const erbRef = (filePath: string, line: number, column: number, kind: ErbReference['kind']): ErbReference => ({
  filePath,
  line,
  column,
  endColumn: column + 8,
  kind,
});

/* ============================== ① 语言轴与分类真源 ============================== */

describe('reference-utils 语言轴', () => {
  it('.kojo 归糖源侧，方言面归 erb 侧', () => {
    expect(isKojoSourcePath('C:/p/kojo/A.kojo')).toBe(true);
    expect(isKojoSourcePath('C:/p/kojo/A.KOJO')).toBe(true);
    expect(languageOfPath('C:/p/ERB/a.ERB')).toBe('erb');
    expect(languageOfPath('C:/p/ERH/x.ERH')).toBe('erb');
  });

  it('未分类最弱，定义最强（同位取胜判据）', () => {
    expect(isMoreSpecificKind('definition', 'call')).toBe(true);
    expect(isMoreSpecificKind('call', 'mention')).toBe(true);
    expect(isMoreSpecificKind('mention', undefined)).toBe(true);
    expect(isMoreSpecificKind(undefined, 'mention')).toBe(false);
    expect(isMoreSpecificKind('call', 'call')).toBe(false);
  });
});

/* ============================== ② 台账合并与计数 ============================== */

describe('mergeOccurrences / tallyReferenceOccurrences', () => {
  const A = 'C:/p/ERB/a.ERB';
  const K = 'C:/p/kojo/A.kojo';

  it('同位多方上报 = 一条出现，分类取最具体一侧', () => {
    const erb = erbOccurrences([erbRef(A, 10, 6, 'mention'), erbRef(A, 20, 1, 'definition')]);
    const sugar = occurrencesFromLocations([{ filePath: A, line: 10, column: 6, kind: 'call' }], 8);
    const merged = mergeOccurrences([erb, sugar]);
    expect(merged).toHaveLength(2);
    expect(merged.find((o) => o.line === 10)?.kind).toBe('call'); // call 顶掉 mention
    expect(occurrencePositionKey(merged[0]!)).toBe(occurrencePositionKey({ filePath: A, line: 10, column: 6 }));
  });

  it('跨语言两份台账并进同一次计数，files 轴分得开', () => {
    const ledger = mergeOccurrences([
      erbOccurrences([
        erbRef(A, 1, 2, 'definition'),
        erbRef(A, 30, 6, 'call'),
        erbRef(A, 88, 1, 'call'),
        erbRef(A, 90, 5, 'mention'),
      ]),
      occurrencesFromLocations([{ filePath: K, line: 4, column: 9, kind: 'call' }], 8),
    ]);
    const tally = tallyReferenceOccurrences(ledger);
    expect(tally).toMatchObject({
      total: 5,
      definition: 1,
      call: 3,
      mention: 1,
      unclassified: 0,
      f12Count: 5,
      callSiteCount: 3,
      gap: 2,
      erbCount: 4,
      kojoCount: 1,
      files: 2,
    });
  });

  it('供方没给分类 ⇒ 进 unclassified（不猜成 call，面板读数不虚高）', () => {
    const ledger = occurrencesFromLocations([{ filePath: K, line: 4, column: 9 }], 8);
    const tally = tallyReferenceOccurrences(ledger);
    expect(tally.unclassified).toBe(1);
    expect(tally.callSiteCount).toBe(0);
    expect(ledger[0]!.kind).toBeUndefined();
    expect(ledger[0]!.endColumn).toBe(9 + 8); // 区间由"这一串就是这个名字"派生
  });

  it('差值一句话解释：F12 的 N 与面板的 M 在同一份 tally 上说得清', () => {
    const tally = tallyReferenceOccurrences(
      erbOccurrences([
        erbRef(A, 1, 2, 'definition'),
        erbRef(A, 30, 6, 'call'),
        erbRef(A, 88, 1, 'call'),
        erbRef(A, 90, 5, 'mention'),
      ]),
    );
    const text = explainReferenceCounts(tally);
    expect(text).toContain('共 4 处出现');
    expect(text).toContain('定义 1 + 调用 2 + 提及 1');
    expect(text).toContain('少 2 处');
    // 全调用位时差值为 0，解释必须换成"一致"，不许留一句假话
    const onlyCalls = tallyReferenceOccurrences(erbOccurrences([erbRef(A, 30, 6, 'call')]));
    expect(explainReferenceCounts(onlyCalls)).toContain('计数与本数一致');
  });

  it('台账回出口只带回供方给过的分类（旧消费方零改动）', () => {
    const locations = occurrencesToLocations([
      ...erbOccurrences([erbRef(A, 1, 2, 'definition')]),
      ...occurrencesFromLocations([{ filePath: K, line: 4, column: 9 }], 8),
    ]);
    expect(locations[0]).toEqual({ filePath: A, line: 1, column: 2, kind: 'definition' });
    expect(locations[1]).toEqual({ filePath: K, line: 4, column: 9 });
  });
});

/* ============================== ③ 写通道闸门 ============================== */

describe('planReferenceWrites', () => {
  const A = 'C:/p/ERB/a.ERB';
  const B = 'C:/p/ERB/b.ERB';
  const K = 'C:/p/kojo/A.kojo';
  const ledger = () =>
    mergeOccurrences([
      erbOccurrences([erbRef(A, 1, 2, 'definition'), erbRef(A, 88, 1, 'call')]),
      erbOccurrences([erbRef(B, 30, 6, 'call')]),
      occurrencesFromLocations([{ filePath: K, line: 4, column: 9, kind: 'call' }], 8),
    ]);

  it('跨语言并进同一份分组，出现序保持台账序', () => {
    const plan = planReferenceWrites(ledger(), () => true);
    expect(plan.readOnlyFiles).toEqual([]);
    expect(plan.writable.map((g) => g.path)).toEqual([A, B, K]);
    expect(plan.writable.map((g) => g.language)).toEqual(['erb', 'erb', 'kojo']);
    expect(plan.writable[0]!.occurrences.map((o) => o.line)).toEqual([1, 88]);
  });

  it('只读文件整文件剔除并列名（两种语言合在同一个计数里）', () => {
    const plan = planReferenceWrites(ledger(), (p) => p !== B && p !== K);
    expect(plan.readOnlyFiles).toEqual([B, K]);
    expect(plan.writable.map((g) => g.path)).toEqual([A]);
    expect(readOnlyFilesReason(plan.readOnlyFiles.length, '重命名')).toContain('2 个文件只读未纳入');
  });

  it('两条通道的只读文案共享同一段前缀（读数可对拍）', () => {
    const prefix = '3 个文件只读未纳入';
    expect(readOnlyFilesReason(3, '重命名').startsWith(prefix)).toBe(true);
    expect(readOnlyFilesNotice(3, '替换').startsWith(prefix)).toBe(true);
    expect(readOnlyFilesReason(1, '重命名')).toContain('1 个文件只读未纳入');
    expect(residualOutsideScopeNotice(4, 2, 'M_KOJO_A')).toContain('检索范围外还有 4 处');
  });
});

/* ============================== ④ 闭文件落盘纪律 ============================== */

function fakeIo(files: Map<string, string>, writable: Set<string>): ClosedFileIo & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    isWritable: (p) => writable.has(p),
    readText: async (p) => {
      const text = files.get(p);
      if (text === undefined) throw new Error(`没有这个文件：${p}`);
      return { text };
    },
    writeText: async (p, text) => {
      writes.push(p);
      files.set(p, text);
    },
  };
}

describe('rewriteClosedFile', () => {
  it('先闸写权限：不可写直接抛，一次读盘都不发生', async () => {
    const files = new Map([['p', 'CALL FOO\n']]);
    const io = fakeIo(files, new Set());
    let rewritten = 0;
    await expect(
      rewriteClosedFile(io, 'p', (text) => {
        rewritten++;
        return { text: text.replace('FOO', 'BAR'), applied: 1 };
      }),
    ).rejects.toThrow(/只读/);
    expect(rewritten).toBe(0);
    expect(io.writes).toEqual([]);
  });

  it('零改动不写盘（不产生备份、不把文件弄脏）', async () => {
    const files = new Map([['p', 'CALL FOO\n']]);
    const io = fakeIo(files, new Set(['p']));
    const out = await rewriteClosedFile(io, 'p', (text) => ({ text, applied: 0 }));
    expect(out).toEqual({ applied: 0, stale: 0 });
    expect(io.writes).toEqual([]);
  });

  it('改写落盘 + stale 计数透出', async () => {
    const files = new Map([['p', 'CALL FOO\n']]);
    const io = fakeIo(files, new Set(['p']));
    const out = await rewriteClosedFile(io, 'p', (text) => ({
      text: text.replace('FOO', 'BAR'),
      applied: 1,
      stale: 2,
    }));
    expect(out).toEqual({ applied: 1, stale: 2 });
    expect(files.get('p')).toBe('CALL BAR\n');
  });
});

/* ============================== 名字记号位置（单源字符集） ============================== */

describe('findNameTokenPositions', () => {
  it('整串匹配、大小写不敏感；前后粘字符不算', () => {
    const text = 'CALL FOO\nfoo = 1\nXFOO\nSIF FOO() == 0\n';
    const positions = findNameTokenPositions(text, 'FOO');
    expect(positions).toEqual([
      { line: 1, column: 6, endColumn: 9, text: 'FOO' },
      { line: 2, column: 1, endColumn: 4, text: 'foo' },
      { line: 4, column: 5, endColumn: 8, text: 'FOO' },
    ]);
  });

  it('CJK 记号与 ASCII 同一把尺子（真语料 21% 名字含 CJK）', () => {
    const positions = findNameTokenPositions('CALL 问候_処理\n', '问候_処理');
    expect(positions).toHaveLength(1);
    expect(positions[0]!.text).toBe('问候_処理');
  });

  it('空名字 ⇒ 空集（空串匹配每一处 = 灾难）', () => {
    expect(findNameTokenPositions('CALL FOO', '')).toEqual([]);
  });
});
