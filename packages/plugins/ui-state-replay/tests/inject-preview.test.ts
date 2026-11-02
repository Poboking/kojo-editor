/**
 * 注入预演纯逻辑单测（v0.3 口上调试统一批；零 React）。
 *
 * 三块判据：
 * ① `diffReplays` —— 前后两份同函数回放的差异（台词增删为主、判定翻转为辅）；
 * ② `replayDiffSummary` —— 差异 → 一句白话（零差异 → null，UI 换措辞）；
 * ③ `overridesForField` / `charaBlockOf` —— 快改字段 → 覆盖集，**角色块按 NO 定位**
 *    （`view.characterNo` 是 NO，覆盖集的键是块序号，两者不等时不许错位）。
 */
import { describe, expect, it } from 'vitest';
import type {
  ArchiveVariable,
  BranchChainOutcome,
  FunctionReplay,
  PredicateReplay,
  QuickEditField,
  ReplayOutcome,
  SnapshotArchive,
  TranscriptLine,
} from '@kojo/plugin-api';
import {
  charaBlockOf,
  diffReplays,
  overrideValueForField,
  overridesForField,
  replayDiffSummary,
} from '../src/panel-logic';

const T: ReplayOutcome = { kind: 'true' };
const F: ReplayOutcome = { kind: 'false' };

function tl(line: number, visibility: TranscriptLine['visibility'], text = `t${line}`): TranscriptLine {
  return { line, verb: 'PRINTL', visibility, payload: text, text: visibility === 'hidden' ? '' : text, unresolved: 0 };
}

function pred(line: number, outcome: ReplayOutcome): PredicateReplay {
  return { kind: 'IF', text: `p${line}`, line, expr: { kind: 'opaque', text: `p${line}` }, outcome };
}

function chain(headLine: number, outcome: BranchChainOutcome['outcome'], takenLine: number | null): BranchChainOutcome {
  return { kind: 'if-chain', headLine, depth: 0, members: [], takenLine, outcome };
}

function replay(parts: {
  transcript?: TranscriptLine[];
  predicates?: PredicateReplay[];
  branches?: BranchChainOutcome[];
}): FunctionReplay {
  return {
    normalizedName: 'TEST',
    filePath: 'x.ERB',
    startLine: 1,
    predicates: parts.predicates ?? [],
    branches: parts.branches ?? [],
    stats: { total: 0, hit: 0, miss: 0, unknown: 0 },
    confidence: 'exact',
    ...(parts.transcript ? { transcript: parts.transcript } : {}),
  };
}

describe('diffReplays：台词增删', () => {
  it('不显示 → 会显示 = 新增；会显示 → 不显示 = 消失', () => {
    const base = replay({ transcript: [tl(3, 'hidden'), tl(5, 'shown')] });
    const next = replay({ transcript: [tl(3, 'shown'), tl(5, 'hidden')] });
    const d = diffReplays(base, next);
    expect(d.added.map((t) => t.line)).toEqual([3]);
    expect(d.removed.map((t) => t.line)).toEqual([5]);
    expect(replayDiffSummary(d)).toBe('会多说 1 句、会少说 1 句');
  });

  it('maybe → 会显示 计入"多说"（原来判不出，现在确定会出现）', () => {
    const base = replay({ transcript: [tl(3, 'maybe')] });
    const next = replay({ transcript: [tl(3, 'shown')] });
    const d = diffReplays(base, next);
    expect(d.added.map((t) => t.line)).toEqual([3]);
    expect(d.settled).toBe(0);
    expect(replayDiffSummary(d)).toBe('会多说 1 句');
  });

  it('maybe → 不显示 计入"收窄"（从可能显示变成确定不说）', () => {
    const base = replay({ transcript: [tl(3, 'maybe')] });
    const next = replay({ transcript: [tl(3, 'hidden')] });
    const d = diffReplays(base, next);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.settled).toBe(1);
    expect(replayDiffSummary(d)).toBe('1 句从"判不出"变成确定不说');
  });

  it('基线缺 transcript（旧引擎 / 行文本不可得）→ 不伪造台词差异', () => {
    const d = diffReplays(replay({}), replay({ transcript: [tl(3, 'shown')] }));
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.settled).toBe(0);
  });
});

describe('diffReplays：判定翻转', () => {
  it('谓词三值变化按行配对计数', () => {
    const d = diffReplays(replay({ predicates: [pred(2, F)] }), replay({ predicates: [pred(2, T)] }));
    expect(d.flippedPredicates).toBe(1);
  });

  it('分支走向 / 命中分支变化按链头配对计数', () => {
    const d = diffReplays(
      replay({ branches: [chain(2, 'taken', 2)] }),
      replay({ branches: [chain(2, 'taken', 4)] }),
    );
    expect(d.flippedBranches).toBe(1);
  });

  it('只有条件翻转（无台词增删）时摘要说"条件判定改变"', () => {
    const d = diffReplays(replay({ predicates: [pred(2, F)] }), replay({ predicates: [pred(2, T)] }));
    expect(replayDiffSummary(d)).toBe('1 处条件判定改变');
  });

  it('零差异 → 摘要 null（UI 说"没有影响"）', () => {
    const same = replay({ transcript: [tl(3, 'shown')], predicates: [pred(2, T)] });
    expect(replayDiffSummary(diffReplays(same, same))).toBeNull();
  });
});

describe('overridesForField：角色块按 NO 定位', () => {
  const intVar = (key: string, value: number): ArchiveVariable => ({ type: 'int', key, value, offset: 0 });
  const arrVar = (key: string, cells: { index: number[]; value: number }[]): ArchiveVariable => ({
    type: 'int-array-1d',
    key,
    saveLen: [100],
    cursor: [0],
    nonEmpty: cells.length,
    cells,
    offset: 0,
  });

  /** 块序号 0 / 1，但 NO 分别是 3 / 7（角色表有缺号）——正是错位会现形的形状 */
  const archive: SnapshotArchive = {
    path: 'save01.sav',
    fileName: 'save01.sav',
    size: 1,
    format: 'raw',
    version: 1808,
    fileType: 'normal',
    uniqueCode: '1',
    gameVersion: '1',
    saveMes: '',
    charCount: 2,
    decompressedSize: 1,
    chars: [
      { index: 0, dimSepIndex: null, vars: [intVar('NO', 3), arrVar('CFLAG', [{ index: [2], value: 100 }])] },
      { index: 1, dimSepIndex: null, vars: [intVar('NO', 7), arrVar('CFLAG', [{ index: [2], value: 500 }])] },
    ],
    vars: [intVar('DAY', 3)],
    bodySize: 1,
    consumed: 1,
    remaining: 0,
  };

  const cflag: QuickEditField = { id: 'cflag-2', label: '好感度', family: 'CFLAG', index: 2 };
  const day: QuickEditField = { id: 'day', label: '天数', family: 'DAY', index: 0, scope: 'global' };

  it('charaBlockOf 按 NO 找块（不是按块序号）', () => {
    expect(charaBlockOf(archive, 7)?.index).toBe(1);
    expect(charaBlockOf(archive, 1)).toBeNull(); // 1 不是任何角色的 NO
  });

  it('角色数组变量 → 块序号 + 单元补丁', () => {
    const ov = overridesForField(archive, cflag, 7, 800)!;
    expect([...ov.chars!.keys()]).toEqual([1]);
    expect(ov.chars!.get(1)!.get('CFLAG')).toEqual([{ index: [2], value: 800 }]);
  });

  it('全局标量变量 → vars 直接替换', () => {
    const ov = overridesForField(archive, day, 3, 9)!;
    expect(ov.vars!.get('DAY')).toBe(9);
    expect(ov.chars).toBeUndefined();
  });

  it('角色不在档里 → null（调用方显式报错，不猜块）', () => {
    expect(overridesForField(archive, cflag, 99, 1)).toBeNull();
    expect(overrideValueForField(archive, cflag, 99, 1)).toBeNull();
  });

  it('变量不在该块 → null', () => {
    const missing: QuickEditField = { id: 'x', label: '不存在', family: 'TALENT', index: 2 };
    expect(overridesForField(archive, missing, 7, 1)).toBeNull();
  });
});
