/**
 * ZH-F3 外部改动三方合并单测。
 * 判据只有一条：**任何一份内容都不许被静默丢掉**——合得动就两份都在，合不动就逐块给全三份。
 */
import { describe, expect, it } from 'vitest';
import {
  decideExternalChange,
  mergeExternalChange,
  type ExternalChangeDecision,
  type MergeConflictChunk,
} from '../src/ui/external-change';

/** 合得动 ⇒ 取整篇文本；取不到就直接红掉（不让断言悄悄降级成"没测到"） */
const mergedText = (d: ExternalChangeDecision): string => {
  if (typeof d !== 'string' && d.kind === 'merge') return d.text;
  throw new Error(`应能自动合，实得 ${JSON.stringify(d)}`);
};
const conflictChunks = (d: ExternalChangeDecision): readonly MergeConflictChunk[] => {
  if (typeof d !== 'string' && d.kind === 'merge-conflict') return d.conflicts;
  throw new Error(`应判冲突，实得 ${JSON.stringify(d)}`);
};

describe('decideExternalChange · 三方（带 base）', () => {
  it('单侧改动 = 自动合：盘上改的和内存改的都在结果里', () => {
    const base = '甲\n乙\n丙\n丁';
    const disk = '甲改\n乙\n丙\n丁';
    const memory = '甲\n乙\n丙改\n丁';
    expect(mergedText(decideExternalChange(memory, disk, true, base))).toBe('甲改\n乙\n丙改\n丁');
  });

  it('盘上改 / 内存改 对称：谁改的都别丢', () => {
    const base = '甲\n乙\n丙\n丁';
    expect(decideExternalChange('甲\n乙\n丙改\n丁', '甲改\n乙\n丙\n丁', true, base)).toEqual(
      decideExternalChange('甲改\n乙\n丙\n丁', '甲\n乙\n丙改\n丁', true, base),
    );
  });

  it('双侧同区改动 = 冲突：块里 base/盘/内存三份片段齐全', () => {
    const chunks = conflictChunks(decideExternalChange('甲\n内存版\n丙', '甲\n盘上版\n丙', true, '甲\n乙\n丙'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({
      baseStart: 1,
      baseEnd: 2,
      base: '乙',
      disk: '盘上版',
      memory: '内存版',
    });
  });

  it('两处各自撞车 = 逐块列出，不合成一坨', () => {
    const chunks = conflictChunks(decideExternalChange('A1\nB\nC\nD\nE1', 'A2\nB\nC\nD\nE2', true, 'A\nB\nC\nD\nE'));
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => [c.base, c.disk, c.memory])).toEqual([
      ['A', 'A2', 'A1'],
      ['E', 'E2', 'E1'],
    ]);
  });

  it('盘上删 + 内存改同一段 = 冲突（不许默默按删除合掉）', () => {
    const chunks = conflictChunks(decideExternalChange('甲\n乙改\n丙\n丁', '甲\n丁', true, '甲\n乙\n丙\n丁'));
    expect(chunks).toHaveLength(1);
    const chunk = chunks[0]!;
    expect(chunk.base).toBe('乙\n丙');
    expect(chunk.disk).toBe('');
    expect(chunk.memory).toBe('乙改\n丙');
  });

  it('盘上删 + 内存改**不同段** = 自动合（删除与修改都生效）', () => {
    expect(mergedText(decideExternalChange('甲\n乙\n丙\n丁改\n戊', '甲\n丙\n丁\n戊', true, '甲\n乙\n丙\n丁\n戊'))).toBe(
      '甲\n丙\n丁改\n戊',
    );
  });

  it('两侧做了同一件事 = 不报冲突，也不重复写两遍', () => {
    expect(mergedText(decideExternalChange('甲\n同改\n丙\n丁', '甲\n同改\n丙\n丁\n追加', true, '甲\n乙\n丙\n丁'))).toBe(
      '甲\n同改\n丙\n丁\n追加',
    );
  });

  it('盘上那份已在内存里（合并结果 == 内存）→ noop，不重刷 model', () => {
    expect(decideExternalChange('甲\n乙\n丙\n追加', '甲\n乙\n丙\n追加', true, '甲\n乙\n丙')).toBe('noop');
    expect(decideExternalChange('甲改\n乙\n丙\n追加', '甲改\n乙\n丙', true, '甲\n乙\n丙')).toBe('noop');
  });

  it('两侧在同一位置各插各的 = 冲突，两份插入都在块里', () => {
    const chunks = conflictChunks(decideExternalChange('甲\n内存插\n乙', '甲\n盘上插\n乙', true, '甲\n乙'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.base).toBe('');
    expect(chunks[0]!.disk).toBe('盘上插');
    expect(chunks[0]!.memory).toBe('内存插');
  });

  it('base 缺失（老会话 / 恢复件首开）→ 逐字退回旧两方语义', () => {
    expect(decideExternalChange('内存脏改', '盘上新内容', true)).toBe('conflict');
    expect(decideExternalChange('内存脏改', '盘上新内容', true, undefined)).toBe('conflict');
    // 空串不是"没有 base"——真把空 base 记下来就该照三方走
    expect(decideExternalChange('内存', '盘上', true, '')).toMatchObject({ kind: 'merge-conflict' });
  });

  it('旧值语义零改动：同内容仍 noop、干净仍 reload（base 在场也不得翻成 merge）', () => {
    expect(decideExternalChange('同一份', '同一份', true, '很旧的 base')).toBe('noop');
    expect(decideExternalChange('旧内容', '盘上新内容', false, '很旧的 base')).toBe('reload');
    expect(decideExternalChange('旧内容', '盘上新内容', false, '旧内容')).toBe('reload');
  });
});

describe('mergeExternalChange · 规模守卫', () => {
  const lines = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n');

  it('任一侧超过逐行上限 → 判不动（null），调用方退回两方', () => {
    const huge = lines(4001, 'L');
    expect(mergeExternalChange(huge, `${huge}\n盘上追加`, `${huge}\n内存追加`)).toBeNull();
    expect(decideExternalChange(`${huge}\n内存追加`, `${huge}\n盘上追加`, true, huge)).toBe('conflict');
  });

  it('中段过大（LCS 表超单元上限）整段视作一次改写：只会多判冲突，一行不丢', () => {
    const base = lines(1200, 'B');
    const disk = lines(1200, 'D');
    const memLines = Array.from({ length: 1200 }, (_, i) => `B${i}`);
    memLines[1199] = 'B1199·内存改';
    const outcome = mergeExternalChange(base, disk, memLines.join('\n'));
    if (!outcome || outcome.ok) throw new Error('整段撞车应判冲突');
    expect(outcome.conflicts).toHaveLength(1);
    const chunk = outcome.conflicts[0]!;
    // 三份都在块里：盘上整段 + 内存整段 + base 整段，没有任何一份被静默吃掉
    expect(chunk.base.split('\n')).toHaveLength(1200);
    expect(chunk.disk.split('\n')).toHaveLength(1200);
    expect(chunk.memory.split('\n')).toHaveLength(1200);
    expect(chunk.memory.split('\n')[1199]).toBe('B1199·内存改');
  });

  it('正常量级（几千行里的两处小改）仍走逐行合并', () => {
    const baseLines = Array.from({ length: 1200 }, (_, i) => `行${i}`);
    const diskLines = [...baseLines];
    diskLines[10] = '行10·盘上';
    const memLines = [...baseLines];
    memLines[1100] = '行1100·内存';
    const outcome = mergeExternalChange(baseLines.join('\n'), diskLines.join('\n'), memLines.join('\n'));
    if (!outcome || !outcome.ok) throw new Error('应能自动合');
    const merged = outcome.text.split('\n');
    expect(merged).toHaveLength(1200);
    expect(merged[10]).toBe('行10·盘上');
    expect(merged[1100]).toBe('行1100·内存');
  });
});

describe('mergeExternalChange · 行尾与边界', () => {
  it('行尾以内存为准：不把整篇 CRLF 翻成 LF', () => {
    expect(mergeExternalChange('甲\r\n乙\r\n丙', '甲改\r\n乙\r\n丙', '甲\r\n乙\r\n丙改')).toEqual({
      ok: true,
      text: '甲改\r\n乙\r\n丙改',
    });
  });

  it('末尾空行也算一行：追加换行不会被当成改动丢弃', () => {
    const outcome = mergeExternalChange('甲\n乙', '甲\n乙\n', '甲\n乙改');
    if (!outcome || !outcome.ok) throw new Error('应能自动合');
    expect(outcome.text).toBe('甲\n乙改\n');
  });

  it('空 base 对两侧内容 = 同一区域双改 → 冲突（不默认取任一侧）', () => {
    const outcome = mergeExternalChange('', '盘上一行', '内存一行');
    if (!outcome || outcome.ok) throw new Error('应判冲突');
    expect(outcome.conflicts[0]).toMatchObject({ disk: '盘上一行', memory: '内存一行' });
  });

  it('盘上没动（disk === base）→ 合并结果就是内存内容', () => {
    const base = '甲\n乙\n丙';
    expect(mergeExternalChange(base, base, '甲\n乙改\n丙')).toEqual({ ok: true, text: '甲\n乙改\n丙' });
  });
});
