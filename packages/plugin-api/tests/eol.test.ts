import { describe, expect, it } from 'vitest';
import { normalizeEol, splitEolLines } from '../src/eol';

/** 旧口径（R7B 收口前全仓 6 份复制里的那一份）——参照实现，**只在测试里**留一份 */
const legacyNormalize = (text: string): string => text.replace(/\r\n?/g, '\n');
const legacyLines = (text: string): string[] => legacyNormalize(text).split('\n');

/**
 * 换行归一/切行的**唯一实现**与旧口径的等价性（R7B，2026-10-31）。
 *
 * 这条测试的存在理由不是"覆盖率高"，而是"允许别人删掉那 6 份复制"：收口的前提是
 * 有人能证明新实现与旧写法逐字节相同。参照实现刻意用旧写法——它就该是"过时的那个"。
 */
describe('eol.ts — 与旧 replace 口径逐字节等价', () => {
  const cases: Record<string, string> = {
    空串: '',
    单行无换行: 'CALL PRINT',
    纯LF: 'a\nb\nc',
    纯CRLF: 'a\r\nb\r\nc',
    纯裸CR_旧Mac: 'a\rb\rc',
    混合三种: 'a\r\nb\nc\rd',
    尾部带换行: 'a\r\nb\r\n',
    连续换行: 'a\r\n\r\n\r\nb',
    只有换行: '\r\n\r\n',
    只有裸CR: '\r\r',
    行首换行: '\rabc',
    单字符CR: '\r',
    单字符LF: '\n',
    CJK正文: '@関数_A\r\n  IF TALENT:1\r\n    PRINT 你好\r\n  ENDIF\r\n',
    CRLF后紧跟CJK: 'a\r\n漢字\r\nb',
  };

  it('normalizeEol 逐字相等', () => {
    for (const [name, text] of Object.entries(cases)) {
      expect(normalizeEol(text), name).toBe(legacyNormalize(text));
    }
  });

  it('splitEolLines 逐元素相等（含空段数）', () => {
    for (const [name, text] of Object.entries(cases)) {
      expect(splitEolLines(text), name).toEqual(legacyLines(text));
    }
  });

  it('无 \\r ⇒ 零拷贝返回入参本身（MEM-16 的零拷贝路）', () => {
    const text = 'a\nb\nc';
    expect(normalizeEol(text)).toBe(text);
  });

  /**
   * 不变量（收口的**结构性**依据，不是抽样）：`splitEolLines(t)` 恒等于
   * `normalizeEol(t).split('\n')`——切分后每段都不含 `\r`/`\n`，故 join 再 split 是恒等。
   * 用一批伪随机串把这条不变量压到边界组合上（CZ 字符集刻意混入 `\r`/`\n`/代理对）。
   */
  it('随机串上 splitEolLines ≡ normalizeEol().split()（1,000 例）', () => {
    const alphabet = ['a', 'Z', '\r', '\n', '\r\n', '漢', '😀', ' ', ';', '@'];
    let seed = 20261031;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 1000; i++) {
      let s = '';
      const len = rand(12);
      for (let k = 0; k < len; k++) s += alphabet[rand(alphabet.length)]!;
      expect(splitEolLines(s), JSON.stringify(s)).toEqual(normalizeEol(s).split('\n'));
      expect(normalizeEol(s), JSON.stringify(s)).toBe(legacyNormalize(s));
    }
  });
});
