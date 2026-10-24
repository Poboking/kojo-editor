/**
 * 剧情线预设守卫：键必须来自真盘读数（每条至少出现一次），且 id / keys 不重复。
 * 真盘计数是本机实测（2026-10-25，`ERB/口上` 403 份 ERB）；语料换了版本会红，
 * 那正是「表已与语料脱节」的信号。
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERAKOUMAKAN_STATE_LINES } from '../src/state-lines';
import { GAME_ROOT, listFilesRecursive } from './harness';

const hasCorpus = existsSync(GAME_ROOT);

/** 本机实测计数（行内 `;` 注释先截断；同一行出现多次按多次计） */
const EXPECTED: Readonly<Record<string, number>> = {
  'TALENT:奴隷:恋慕': 2936,
  'TALENT:TARGET:恋慕': 88,
  'TALENT:恋慕': 564,
  'TALENT:奴隷:处女': 1230,
  'TALENT:处女': 38,
  'CFLAG:奴隷:处女喪失中': 1175,
  'MARK:屈服刻印': 446,
  'TCVAR:奴隷:屈服刻印取得': 34,
  'TALENT:奴隷:浮気公認': 599,
  'TALENT:MASTER:NTR': 20,
  'TALENT:奴隷:NTR': 10,
  'TALENT:奴隷:亲爱': 344,
  'TALENT:亲爱': 11,
};

describe('stateLinePresets 形状', () => {
  it('5 条线；id 唯一；每条至少 1 个键', () => {
    expect(ERAKOUMAKAN_STATE_LINES).toHaveLength(5);
    expect(new Set(ERAKOUMAKAN_STATE_LINES.map((l) => l.id)).size).toBe(5);
    for (const line of ERAKOUMAKAN_STATE_LINES) {
      expect(line.keys.length).toBeGreaterThan(0);
      expect(line.label.length).toBeGreaterThan(0);
    }
  });

  it('表里每个键都有本机实测计数（没有凭 CSV 名字造出来的死键）', () => {
    const keys = ERAKOUMAKAN_STATE_LINES.flatMap((l) => [...l.keys]);
    for (const key of keys) {
      expect(EXPECTED[key], key).toBeGreaterThan(0);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('真盘计数（守卫：D:/Game/eraKoumakan 存在才跑）', () => {
  it.skipIf(!hasCorpus)('每条线的键在口上域的出现次数与实测一致', () => {
    const texts = listFilesRecursive(`${GAME_ROOT}/ERB/口上`, /\.erb$/i).map((p) =>
      readFileSync(p, 'utf8'),
    );
    for (const [key, expected] of Object.entries(EXPECTED)) {
      let count = 0;
      for (const text of texts) {
        for (const rawLine of text.split(/\r?\n/)) {
          const line = rawLine.split(';')[0] ?? '';
          // 逐次出现计数（同一行多次也算）
          let from = 0;
          for (;;) {
            const at = line.indexOf(key, from);
            if (at < 0) break;
            count++;
            from = at + key.length;
          }
        }
      }
      expect(count, key).toBe(expected);
    }
  });
});
