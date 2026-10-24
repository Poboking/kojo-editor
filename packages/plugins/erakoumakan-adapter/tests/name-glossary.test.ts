/**
 * 名字对照表守卫：每个键都必须能在真盘的目录名 / 文件名里找到（表与语料同源）。
 * 无真盘机器整组跳过。
 */

import { existsSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { ERAKOUMAKAN_NAME_GLOSSARY } from '../src/name-glossary';
import { GAME_ROOT } from './harness';

const hasCorpus = existsSync(GAME_ROOT);

function allNamesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      out.push(d.name);
      if (d.isDirectory()) walk(join(dir, d.name));
    }
  };
  walk(root);
  return out;
}

describe('nameGlossary 口径', () => {
  it('键/值不为空、互不相同、不含括号（避免拼出两层）', () => {
    for (const [key, value] of Object.entries(ERAKOUMAKAN_NAME_GLOSSARY)) {
      expect(key.length).toBeGreaterThan(0);
      expect(value.length).toBeGreaterThan(0);
      expect(key).not.toBe(value);
      expect(key).not.toContain('（');
      expect(value).not.toContain('（');
    }
  });

  it('真盘守卫：每个键都能在 ERB 树的名字里找到', () => {
    if (!hasCorpus) return;
    const names = allNamesUnder(`${GAME_ROOT}/ERB`);
    for (const key of Object.keys(ERAKOUMAKAN_NAME_GLOSSARY)) {
      expect(names.some((name) => name.includes(key)), key).toBe(true);
    }
  });

  it.skipIf(!hasCorpus)('代表性条目（角色 / 口上文件 / 扩展目录）', () => {
    expect(ERAKOUMAKAN_NAME_GLOSSARY['美鈴']).toBe('美铃');
    expect(ERAKOUMAKAN_NAME_GLOSSARY['お持ち帰り']).toBeUndefined();
    expect(ERAKOUMAKAN_NAME_GLOSSARY['NTR口上_お持ち帰り']).toBe('NTR口上_带回');
    expect(ERAKOUMAKAN_NAME_GLOSSARY['SexHara休憩中口上']).toBe('休息中被骚扰口上');
    expect(ERAKOUMAKAN_NAME_GLOSSARY['妖精メイド拡張']).toBe('妖精女仆扩展');
  });
});
