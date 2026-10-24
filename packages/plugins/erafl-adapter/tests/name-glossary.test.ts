/**
 * eraFL 名字对照表（`ERAFL_NAME_GLOSSARY`）的判据。
 *
 * 三组断言，各自防一种真实退化：
 * 1. **形状**：键值非空、无重复；值里不许残留假名——漏译一条不会报错，只会让作者在
 *    文件树里看到「日文名（日文名）」，这条断言就是把它揪出来的地方。
 * 2. **匹配语义**：复刻消费方（`ProjectView` 的 `nameGloss`）的判据——**键长降序 + includes**，
 *    钉住「`主人公口上_汎用_性悪` 不会被 `汎用_性悪` 抢先命中」这个真实歧义。
 * 3. **真盘守卫**：每个键都必须能在真盘的目录名/文件名里找到。表是照语料生成的，
 *    语料改名/删目录后表就过期；这条守卫让过期变成红灯，而不是悄悄失效。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERAFL_NAME_GLOSSARY } from '../src/name-glossary';

const GAME_ROOT = 'D:/Game/erafl';
const hasCorpus = existsSync(GAME_ROOT);

/** 平假名 + 片假名（值里出现任何一枚都说明还没译完） */
const KANA_RE = /[\u3040-\u309f\u30a0-\u30ff]/;

describe('ERAFL_NAME_GLOSSARY —— 形状', () => {
  const entries = Object.entries(ERAFL_NAME_GLOSSARY);

  it('条数与语料同量级（129 个口上目录 + 36 份角色 CSV，去重后 ≥ 120）', () => {
    expect(entries.length).toBeGreaterThanOrEqual(120);
  });

  it('键与值都非空，且值里不残留假名（漏译检测）', () => {
    for (const [key, value] of entries) {
      expect(key.length, `键为空`).toBeGreaterThan(0);
      expect(value.length, `${key} 的译名为空`).toBeGreaterThan(0);
      expect(KANA_RE.test(value), `${key} 的译名仍是日文：${value}`).toBe(false);
    }
  });

  it('值是纯中文且不含括号（消费方会拼「（中文）」，值里带括号会拼出两层）', () => {
    for (const [key, value] of entries) {
      expect(/[（）()]/.test(value), `${key} 的译名带括号：${value}`).toBe(false);
    }
  });
});

describe('ERAFL_NAME_GLOSSARY —— 匹配语义（复刻 ProjectView 的 gloss 判据）', () => {
  /** 与 `ProjectView.tsx` 的 `nameGloss` 同一套判据：键长降序、includes、已含译名则不重复拼 */
  function glossOf(name: string): string {
    const keys = Object.keys(ERAFL_NAME_GLOSSARY).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      if (!name.includes(key)) continue;
      const zh = ERAFL_NAME_GLOSSARY[key]!;
      if (name.includes(zh)) return name;
      return `${name}（${zh}）`;
    }
    return name;
  }

  it('口上目录名：日文名后补中文名', () => {
    expect(glossOf('1001_汎用_クール')).toBe('1001_汎用_クール（冷静）');
  });

  it('角色 CSV 文件名：按角色名段命中', () => {
    expect(glossOf('Chara10_ティア.csv')).toBe('Chara10_ティア.csv（蒂娅）');
  });

  it('长键优先：主人公口上_汎用_性悪 不被更短的 汎用_性悪 抢先命中', () => {
    expect(glossOf('5192_主人公口上_汎用_性悪')).toBe('5192_主人公口上_汎用_性悪（主人公口上_性格恶劣）');
  });

  it('已含译名的不重复拼（译名出现在原名里就原样返回）', () => {
    expect(glossOf('10_蒂娅_蒂娅')).toBe('10_蒂娅_蒂娅');
  });

  it('没命中的名字原样返回（不猜）', () => {
    expect(glossOf('SYSTEM/VARIABLE.ERH')).toBe('SYSTEM/VARIABLE.ERH');
  });
});

describe('ERAFL_NAME_GLOSSARY —— 真盘守卫（D:/Game/erafl 存在才跑）', () => {
  it.skipIf(!hasCorpus)('每个键都能在口上目录名或角色 CSV 文件名里找到（表未与语料脱节）', () => {
    const haystack: string[] = [];
    for (const dir of readdirSync(nodeJoin(GAME_ROOT, 'ERB', '口上'), { withFileTypes: true })) {
      if (dir.isDirectory()) haystack.push(dir.name);
    }
    for (const file of readdirSync(nodeJoin(GAME_ROOT, 'CSV', 'CHARA'))) {
      haystack.push(file);
    }
    const joined = haystack.join('\n');

    const missing = Object.keys(ERAFL_NAME_GLOSSARY).filter((key) => !joined.includes(key));
    expect(missing, `这些键在真盘里已找不到（表过期）：\n${missing.join('\n')}`).toEqual([]);
  });
});
