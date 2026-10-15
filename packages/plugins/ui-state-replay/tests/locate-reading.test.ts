/**
 * G1「跳到命中状态」的行读数单测（零 React；2026-10-16 批）。
 *
 * 钉住三件事：
 * 1. **八态各自的判据**（尤其"判不出"绝不并入"不走"、外层失配优先于内层结论）；
 * 2. **收口判据**：有 `endLine` 时以真闭合行为准，兄弟链不得越界管辖；
 *    没有 `endLine`（未闭合链）时退回深度判据——这条是假阴性的分水岭；
 * 3. **作者面的措辞**：那句话里不许出现引擎黑话（逐条断言见文末的词汇表用例）。
 */
import { describe, expect, it } from 'vitest';
import type { BranchChainOutcome, FunctionReplay, PredicateReplay, ReplayOutcome } from '@kojo/plugin-api';
import { VERDICT_LABEL, describeReading, readLineAt, sameSourcePath } from '../src/panel-logic';

/* ---------------------------------- 构造器 ---------------------------------- */

const outcomeOf = (o: 'true' | 'false' | 'unknown'): ReplayOutcome =>
  o === 'unknown' ? { kind: 'unknown', unknown: { code: 'pseudo', message: '伪变量（运行期计算值）：RAND' } } : { kind: o };

const pred = (line: number, o: 'true' | 'false' | 'unknown', text = `p${line}`, kind: PredicateReplay['kind'] = 'IF'): PredicateReplay => ({
  kind,
  text,
  line,
  outcome: outcomeOf(o),
  expr: { kind: 'opaque', text },
});

const member = (line: number, kind: BranchChainOutcome['members'][number]['kind'], text = ''): BranchChainOutcome['members'][number] => ({
  line,
  kind,
  text,
});

const chain = (
  headLine: number,
  depth: number,
  members: BranchChainOutcome['members'],
  takenOutcome: BranchChainOutcome['outcome'],
  takenLine: number | null = null,
  endLine?: number,
): BranchChainOutcome => ({
  kind: 'if-chain',
  headLine,
  depth,
  members,
  takenLine,
  outcome: takenOutcome,
  ...(endLine !== undefined ? { endLine } : {}),
  ...(takenOutcome === 'unknown' ? { unknown: { code: 'call' as const, message: '函数调用不可求值' } } : {}),
});

const replay = (opts: {
  startLine?: number;
  predicates?: PredicateReplay[];
  branches?: BranchChainOutcome[];
}): FunctionReplay => {
  const predicates = opts.predicates ?? [];
  const hit = predicates.filter((p) => p.outcome.kind === 'true').length;
  const miss = predicates.filter((p) => p.outcome.kind === 'false').length;
  const unk = predicates.length - hit - miss;
  return {
    normalizedName: 'M_TEST',
    filePath: 'C:/game/kojo/a.erb',
    startLine: opts.startLine ?? 10,
    predicates,
    branches: opts.branches ?? [],
    stats: { total: predicates.length, hit, miss, unknown: unk },
    confidence: unk > 0 ? 'partial' : 'exact',
  };
};

/* ----------------------------------- 用例 ----------------------------------- */

describe('readLineAt — 范围与空记录', () => {
  it('行号早于本段起点 → outside，并带出记录的起始行', () => {
    const r = replay({ startLine: 10, predicates: [pred(11, 'true')] });
    const reading = readLineAt(r, 4);
    expect(reading.verdict).toBe('outside');
    expect(reading.fromLine).toBe(10);
    expect(describeReading(reading)).toContain('第 10 行');
  });

  it('非整数行号不夹取（过期位点不能伪装成"命中旁边那行"）', () => {
    expect(readLineAt(replay({ startLine: 10 }), 1.5).verdict).toBe('outside');
    expect(readLineAt(replay({ startLine: 10 }), 0).verdict).toBe('outside');
  });

  it('整段无可判定记录 → no-record（不硬说"会执行"）', () => {
    const r = replay({ startLine: 10, predicates: [], branches: [] });
    expect(readLineAt(r, 12).verdict).toBe('no-record');
  });

  it('有条件但本行不归任何条件管 → straight', () => {
    const r = replay({ startLine: 10, predicates: [pred(11, 'true')], branches: [chain(11, 0, [member(11, 'IF')], 'taken', 11, 13)] });
    expect(readLineAt(r, 20).verdict).toBe('straight');
    expect(describeReading(readLineAt(r, 20))).toContain('不在任何条件里');
  });
});

describe('readLineAt — 单层分支', () => {
  const r = () =>
    replay({
      startLine: 10,
      predicates: [pred(11, 'true', 'C >= 1'), pred(13, 'false', 'C >= 5')],
      branches: [chain(11, 0, [member(11, 'IF', 'C >= 1'), member(13, 'ELSEIF', 'C >= 5'), member(15, 'ELSE')], 'taken', 11, 17)],
    });

  it('命中的那一支体内 → runs', () => {
    expect(readLineAt(r(), 12).verdict).toBe('runs');
  });

  it('未命中的那一支体内 → skipped，并说清走了哪一行', () => {
    const reading = readLineAt(r(), 16);
    expect(reading.verdict).toBe('skipped');
    expect(reading.wentTo).toBe(11);
    expect(describeReading(reading)).toContain('第 11 行');
  });

  it('链头那一行本身就是命中成员 → runs，且带上条件原文', () => {
    const reading = readLineAt(r(), 11);
    expect(reading.verdict).toBe('runs');
    expect(reading.condition?.text).toBe('C >= 1');
    expect(reading.matchedRows).toBe(1);
  });

  it('链头条件不成立 → skipped（本行是条件行，不写"会执行"）', () => {
    const reading = readLineAt(r(), 13);
    expect(reading.verdict).toBe('skipped');
    expect(reading.condition?.outcome).toBe('false');
  });

  it('兜底 ELSE 行本身：链被走进来就执行', () => {
    const rr = replay({
      startLine: 10,
      predicates: [pred(11, 'false', 'C >= 1')],
      branches: [chain(11, 0, [member(11, 'IF', 'C >= 1'), member(13, 'ELSE')], 'taken', 13, 17)],
    });
    expect(readLineAt(rr, 13).verdict).toBe('runs');
    expect(readLineAt(rr, 14).verdict).toBe('runs');
  });
});

describe('readLineAt — 嵌套与可达性', () => {
  // 外层 11（走 ELSE 那支，13..19），内层 14 挂在外层**未进入**的那一支里
  const outerTaken = chain(11, 0, [member(11, 'IF', 'A'), member(13, 'ELSE')], 'taken', 13, 19);
  const innerUnreach = { ...chain(12, 1, [member(12, 'IF', 'B')], 'unreachable'), headLine: 12 };
  const innerLive = chain(14, 1, [member(14, 'IF', 'B'), member(16, 'ELSE')], 'taken', 16, 18);

  it('引擎标记 unreachable 的链：本行归为外层没进来', () => {
    const r = replay({ startLine: 10, predicates: [pred(12, 'true', 'B')], branches: [outerTaken, innerUnreach] });
    const reading = readLineAt(r, 12);
    expect(reading.verdict).toBe('skipped'); // 本行是内层链头（成员行），外层走了别支 → 决定性失配
    expect(reading.wentTo).toBe(13);
  });

  it('外层进了另一支：体内行报 outer-blocked，不再往下看内层结论', () => {
    const r = replay({ startLine: 10, branches: [{ ...innerUnreach, members: [member(12, 'IF', 'B')], endLine: 13 }, outerTaken] });
    expect(readLineAt(r, 13).verdict).toBe('outer-blocked');
  });

  it('嵌套 taken 且本行在内层命中支内 → runs', () => {
    const r = replay({ startLine: 10, predicates: [pred(11, 'true', 'A'), pred(14, 'false', 'B')], branches: [outerTaken, innerLive] });
    expect(readLineAt(r, 17).verdict).toBe('runs');
  });

  it('内层判不出、外层走了别支 → 决定性结论是"不会走"，不报"判不出"', () => {
    const unknownInner = chain(14, 1, [member(14, 'IF', 'B')], 'unknown');
    const r = replay({ startLine: 10, branches: [chain(11, 0, [member(11, 'IF', 'A')], 'taken', 11, 19), unknownInner] });
    // 外层 taken=11，本行 15 落在外层 IF 体内 → 外层不阻断；内层判不出 → undecided
    expect(readLineAt(r, 15).verdict).toBe('undecided');
    const r2 = replay({ startLine: 10, branches: [chain(11, 0, [member(11, 'IF', 'A'), member(18, 'ELSE')], 'taken', 18, 20), unknownInner] });
    expect(readLineAt(r2, 15).verdict).toBe('skipped');
  });

  it('全链判不出 → undecided 并带出原因', () => {
    const r = replay({ startLine: 10, branches: [chain(11, 0, [member(11, 'IF', 'A')], 'unknown', null, 20)] });
    const reading = readLineAt(r, 15);
    expect(reading.verdict).toBe('undecided');
    expect(reading.reason).toBe('函数调用不可求值');
    expect(describeReading(reading)).toContain('判不出');
  });

  it('落空（no-match）→ no-entry：说"全都不成立、也没有兜底"', () => {
    const r = replay({ startLine: 10, predicates: [pred(11, 'false', 'A')], branches: [chain(11, 0, [member(11, 'IF', 'A')], 'no-match', null, 20)] });
    expect(readLineAt(r, 15).verdict).toBe('no-entry');
  });
});

describe('readLineAt — 收口判据（endLine 与降级）', () => {
  it('兄弟链已闭合（endLine 在前的 taken 成员不是本行归属）→ 不误报 skipped', () => {
    // C1 外层 10..30 走 ELSE（第 20 行）；C2 内层 12..18 走 IF（第 12 行），已于 18 闭合
    const c1 = chain(10, 0, [member(10, 'IF', 'A'), member(20, 'ELSE')], 'taken', 20, 30);
    const c2 = chain(12, 1, [member(12, 'IF', 'B'), member(15, 'ELSE')], 'taken', 12, 18);
    const r = replay({ startLine: 9, branches: [c1, c2] });
    // 第 22 行在 C1 的 ELSE 体内、且在 C2 闭合之后 → 会执行（若按深度判据，C2 会越界把它误判成别支）
    expect(readLineAt(r, 22).verdict).toBe('runs');
  });

  it('未闭合链（无 endLine）→ 退回深度判据，同深度新链开起即视为本链收口', () => {
    const c1 = chain(10, 0, [member(10, 'IF', 'A')], 'taken', 10); // 无 endLine
    const c2 = chain(14, 0, [member(14, 'IF', 'B'), member(16, 'ELSE')], 'taken', 16, 20);
    const r = replay({ startLine: 9, branches: [c1, c2] });
    // 第 18 行：c1（无闭合信息）按深度判据在 c2（同深度、链头 14 在其前）处收口 → 不再管辖
    expect(readLineAt(r, 18).verdict).toBe('runs');
    // 第 12 行仍归 c1 管
    expect(readLineAt(r, 12).verdict).toBe('runs');
  });

  it('链头行（SELECTCASE 那种"成员都在其后"的形状）不被自己阻断', () => {
    const select: BranchChainOutcome = {
      kind: 'select-chain',
      headLine: 11,
      depth: 0,
      members: [member(12, 'CASE', '1'), member(14, 'CASE', '2')],
      takenLine: 12,
      outcome: 'taken',
      endLine: 16,
    };
    const r = replay({ startLine: 10, branches: [select] });
    expect(readLineAt(r, 11).verdict).toBe('runs'); // SELECTCASE 本身：进了这段就执行
    expect(readLineAt(r, 13).verdict).toBe('runs'); // CASE 1 的体内
    expect(readLineAt(r, 15).verdict).toBe('skipped'); // CASE 2 的体内
  });
});

describe('readLineAt — 同一行多条条件（CASE 区间）', () => {
  const pair = (line: number, a: 'true' | 'false' | 'unknown', b: 'true' | 'false' | 'unknown'): PredicateReplay[] => [
    { ...pred(line, a, `V >= ${line}`), conjunction: 'and' },
    { ...pred(line, b, `V <= ${line + 9}`), conjunction: 'and' },
  ];

  it('TO 区间两条半边：一真一未知 → 判不出（不因为"有真"就说会走）', () => {
    const r = replay({ startLine: 10, predicates: pair(11, 'true', 'unknown') });
    expect(readLineAt(r, 11).verdict).toBe('undecided');
  });

  it('TO 区间两条半边：含假即假 → skipped', () => {
    const r = replay({ startLine: 10, predicates: pair(11, 'true', 'false') });
    expect(readLineAt(r, 11).verdict).toBe('skipped');
  });

  it('逗号列表（同行不带 and）：任一为真即会走', () => {
    const r = replay({ startLine: 10, predicates: [pred(11, 'false', 'V==1'), pred(11, 'true', 'V==5')] });
    expect(readLineAt(r, 11).verdict).toBe('runs');
    expect(readLineAt(r, 11).matchedRows).toBe(2);
  });
});

describe('作者面的措辞', () => {
  const sentences = [
    readLineAt(replay({ startLine: 10, predicates: [pred(11, 'true')], branches: [chain(11, 0, [member(11, 'IF')], 'taken', 11, 13)] }), 12),
    readLineAt(replay({ startLine: 10, predicates: [pred(11, 'false')], branches: [chain(11, 0, [member(11, 'IF')], 'taken', 13, 20)] }), 12),
    readLineAt(replay({ startLine: 10, branches: [{ ...chain(11, 1, [member(11, 'IF')], 'unreachable'), endLine: 20 }] }), 15),
    readLineAt(replay({ startLine: 10, predicates: [pred(11, 'false')], branches: [chain(11, 0, [member(11, 'IF')], 'no-match', null, 20)] }), 15),
    readLineAt(replay({ startLine: 10, branches: [chain(11, 0, [member(11, 'IF')], 'unknown', null, 20)] }), 15),
    readLineAt(replay({ startLine: 10, predicates: [pred(11, 'true')], branches: [chain(11, 0, [member(11, 'IF')], 'taken', 11, 13)] }), 30),
    readLineAt(replay({ startLine: 10, predicates: [] }), 3),
    readLineAt(replay({ startLine: 10 }), 12),
  ];

  it('八态各出一句非空人话，且短标都在册', () => {
    expect(sentences).toHaveLength(8);
    for (const s of sentences) {
      expect(describeReading(s).length).toBeGreaterThan(0);
      expect(VERDICT_LABEL[s.verdict].label).toBeTruthy();
      expect(s.line).toBe(s.line);
    }
  });

  it('句子与短标里不出现引擎黑话（作者面去术语）', () => {
    const jargon = ['回放', '谓词', '链', '矩阵', '可达', 'replay', 'predicate', 'matrix', 'branch', 'outcome', 'unknown'];
    const all = sentences.map((s) => `${describeReading(s)} ${VERDICT_LABEL[s.verdict].label}`).join(' | ');
    for (const word of jargon) {
      expect(all.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});

describe('sameSourcePath', () => {
  it('分隔符与大小写不同 = 同一份文本（宿主与索引各拿各的路径字符串）', () => {
    expect(sameSourcePath('C:\\game\\KOJO\\A.ERB', 'c:/game/kojo/a.erb')).toBe(true);
    expect(sameSourcePath('C:\\game\\a.erb', 'C:\\game\\b.erb')).toBe(false);
  });
});
