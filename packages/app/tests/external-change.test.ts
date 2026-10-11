import { describe, expect, it } from 'vitest';
import { decideExternalChange } from '../src/ui/external-change';

/**
 * 外部写盘后的 model 重载决策单测（2026-10-12 审阅补丁，修 B1）。
 *
 * 该决策是「💡 升糖写盘后不丢数据」的关键分支：判错任一条都会造成**静默数据
 * 丢失**（要么丢用户的未保存修改，要么被随后的 Ctrl+S 用旧文本覆盖磁盘）。
 */
describe('decideExternalChange —— 外部写盘后的重载决策', () => {
  it('磁盘与 model 相同（自身保存回声）→ noop（不重置撤销栈/光标）', () => {
    expect(decideExternalChange('同一份内容', '同一份内容', false)).toBe('noop');
    expect(decideExternalChange('同一份内容', '同一份内容', true)).toBe('noop');
  });

  it('磁盘变了、model 干净 → reload（可安全用磁盘内容替换）', () => {
    expect(decideExternalChange('旧内容', '升糖后的新内容', false)).toBe('reload');
  });

  it('磁盘变了、model 脏 → conflict（绝不静默覆盖用户的未保存修改）', () => {
    expect(decideExternalChange('含未保存修改', '升糖后的新内容', true)).toBe('conflict');
  });

  it('状态与内容无关：脏判定只看是否相对基线有改动', () => {
    // 同为「磁盘 != model」，dirty 决定走向：干净=重载，脏=交给用户
    expect(decideExternalChange('a', 'b', false)).toBe('reload');
    expect(decideExternalChange('a', 'b', true)).toBe('conflict');
  });

  it('空文本也算内容：空 model 对非空磁盘 → 非 noop', () => {
    expect(decideExternalChange('', '', false)).toBe('noop');
    expect(decideExternalChange('', 'x', false)).toBe('reload');
    expect(decideExternalChange('x', '', true)).toBe('conflict');
  });
});