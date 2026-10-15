import { statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ERATW_BIT_TABLES, type CuratedBitTable } from '../src/bit-tables';

// 语料守门：未设语料环境变量时不做「源文件存在」校验（与同目录 .corpus.test.ts 同形）。
const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;

const SOURCE_RE = /^CSV\/([^:]+):\d+(?:-\d+)?$/;

describe('ERATW_BIT_TABLES 结构不变式', () => {
  it('位表非空（至少收录一条）', () => {
    expect(ERATW_BIT_TABLES.length).toBeGreaterThan(0);
  });

  it('每条 bits 非空', () => {
    for (const t of ERATW_BIT_TABLES) {
      expect(t.bits.length, `${t.family}:${t.index}`).toBeGreaterThan(0);
    }
  });

  it('bit 为非负整数', () => {
    for (const t of ERATW_BIT_TABLES) {
      for (const b of t.bits) {
        expect(Number.isInteger(b.bit), `${t.family}:${t.index} bit=${b.bit}`).toBe(true);
        expect(b.bit, `${t.family}:${t.index}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('同条目内 bit 不重复且按升序', () => {
    for (const t of ERATW_BIT_TABLES) {
      const bits = t.bits.map((b) => b.bit);
      expect(new Set(bits).size, `${t.family}:${t.index} 位重复`).toBe(bits.length);
      for (let i = 1; i < bits.length; i += 1) {
        expect(bits[i]!, `${t.family}:${t.index} 未升序`).toBeGreaterThan(bits[i - 1]!);
      }
    }
  });

  it('label 去空白后非空', () => {
    for (const t of ERATW_BIT_TABLES) {
      for (const b of t.bits) {
        expect(b.label.replace(/\s+/g, '').length, `${t.family}:${t.index} bit=${b.bit}`).toBeGreaterThan(0);
      }
    }
  });

  it('每个 label 都出现在 evidence 原文里（禁止翻译 / 润色 / 补全）', () => {
    for (const t of ERATW_BIT_TABLES) {
      for (const b of t.bits) {
        expect(
          t.evidence.includes(b.label),
          `${t.family}:${t.index} bit=${b.bit} 的 label「${b.label}」不在 evidence 原文中`,
        ).toBe(true);
      }
    }
  });

  it('evidence（原注释）与 erbUsage（实证摘记）均非空', () => {
    for (const t of ERATW_BIT_TABLES) {
      expect(t.evidence.trim().length, `${t.family}:${t.index} evidence 为空`).toBeGreaterThan(0);
      expect(t.erbUsage.trim().length, `${t.family}:${t.index} erbUsage 为空`).toBeGreaterThan(0);
    }
  });

  it('(family,index) 全局唯一', () => {
    const seen = new Set<string>();
    for (const t of ERATW_BIT_TABLES) {
      const key = `${t.family}:${t.index}`;
      expect(seen.has(key), `重复条目 ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('inferred===true 当且仅当 form==="bit-mask"', () => {
    for (const t of ERATW_BIT_TABLES) {
      expect(t.inferred, `${t.family}:${t.index}`).toBe(t.form === 'bit-mask');
    }
  });

  it('source 形如 CSV/<file>:<line>（可含行段 a-b）', () => {
    for (const t of ERATW_BIT_TABLES) {
      expect(SOURCE_RE.test(t.source), `${t.family}:${t.index} source=${t.source}`).toBe(true);
    }
  });

  it('usage 取值合法', () => {
    for (const t of ERATW_BIT_TABLES) {
      expect(['used', 'unused'], `${t.family}:${t.index}`).toContain(t.usage);
    }
  });
});

describe.skipIf(!SMOKE)('ERATW_BIT_TABLES source 语料实证', () => {
  it('source 指向的 CSV 文件在语料中真实存在', () => {
    const csvDir = join(SMOKE as string, 'CSV');
    for (const t of ERATW_BIT_TABLES) {
      const file = SOURCE_RE.exec(t.source)?.[1];
      expect(file, `${t.family}:${t.index} source=${t.source}`).toBeTruthy();
      expect(
        statSync(join(csvDir, file as string)).isFile(),
        `${t.family}:${t.index} 缺文件 ${file}`,
      ).toBe(true);
    }
  });
});

describe('ERATW_BIT_TABLES 覆盖率读数', () => {
  it('打印覆盖率', () => {
    const total = ERATW_BIT_TABLES.length;
    const used = ERATW_BIT_TABLES.filter((t) => t.usage === 'used').length;
    const mask = ERATW_BIT_TABLES.filter((t) => t.form === 'bit-mask').length;
    const families = new Set(ERATW_BIT_TABLES.map((t) => t.family));
    const bitCount = ERATW_BIT_TABLES.reduce((n, t) => n + t.bits.length, 0);
    // eslint-disable-next-line no-console
    console.log(
      `[bit-tables] 条目=${total} used=${used} unused=${total - used} ` +
        `bit-mask=${mask} 族数=${families.size} 位条目总数=${bitCount} 族=${[...families].join(',')}`,
    );
    expect(total).toBeGreaterThan(0);
  });
});

// 便于类型检查：CuratedBitTable 被引用时不报未使用。
export type _BitTableShapeCheck = CuratedBitTable;
