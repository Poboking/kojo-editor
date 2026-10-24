/**
 * eraFL 剧情线预设（`ERAFL_STATE_LINES`）的判据。
 *
 * 这里钉的是**"这些线在真盘上真的存在"**，不是"文案好看"：预设键是拿来做**精确匹配**的
 * （条件矩阵按 `StateDependency.key` 比行），写错一个字就整条线不亮，而且不报错。
 * 所以守卫断言 `CFLAG:<首下标>:<状态名>` 这一整串在真盘 ERB 里出现过。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERAFL_STATE_LINES } from '../src/state-lines';

const GAME_ROOT = 'D:/Game/erafl';
const hasCorpus = existsSync(GAME_ROOT);

describe('ERAFL_STATE_LINES —— 形状', () => {
  it('五条线，id 唯一，label 与 description 非空', () => {
    expect(ERAFL_STATE_LINES.length).toBe(5);
    expect(new Set(ERAFL_STATE_LINES.map((line) => line.id)).size).toBe(5);
    for (const line of ERAFL_STATE_LINES) {
      expect(line.label.length).toBeGreaterThan(0);
      expect(line.description?.length ?? 0).toBeGreaterThan(0);
      expect(line.keys.length).toBeGreaterThan(0);
    }
  });

  it('每条线的键都是「变量:下标…」形态（矩阵按这个形状比行，写错就永不命中）', () => {
    for (const line of ERAFL_STATE_LINES) {
      for (const key of line.keys) {
        expect(key, `${line.id} 的键形态不对`).toMatch(/^[A-Z]+:[^:]+:[^:]+$/);
      }
    }
  });

  it('键不跨线重复（同一条依赖键挂两条线会让面板选中态分叉）', () => {
    const seen = new Map<string, string>();
    for (const line of ERAFL_STATE_LINES) {
      for (const key of line.keys) {
        expect(seen.has(key), `${key} 同时出现在 ${seen.get(key)} 与 ${line.id}`).toBe(false);
        seen.set(key, line.id);
      }
    }
  });
});

describe('ERAFL_STATE_LINES —— 真盘守卫（D:/Game/erafl 存在才跑）', () => {
  it.skipIf(!hasCorpus)('每个预设键都在真盘 ERB 里出现过（线不是凭 CSV 编的）', () => {
    const texts: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = nodeJoin(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(erb|erm)$/i.test(entry.name)) texts.push(readFileSync(full, 'utf8'));
      }
    };
    walk(nodeJoin(GAME_ROOT, 'ERB'));
    const joined = texts.join('\n');

    const missing = ERAFL_STATE_LINES.flatMap((line) =>
      line.keys.filter((key) => !joined.includes(key)).map((key) => `${line.id}: ${key}`),
    );
    expect(missing, `这些预设键在真盘里一次都没出现（写错或语料已改）：\n${missing.join('\n')}`).toEqual(
      [],
    );
  }, 180_000);
});
