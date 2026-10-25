/**
 * 剧情线预设：六条，键一律真盘原文。
 */

import { describe, expect, it } from 'vitest';
import { ERASQC_STATE_LINES } from '../src/state-lines';

describe('stateLinePresets', () => {
  it('六条线，id 唯一', () => {
    expect(ERASQC_STATE_LINES).toHaveLength(6);
    expect(new Set(ERASQC_STATE_LINES.map((l) => l.id)).size).toBe(6);
  });

  it('最高频的恋慕 / 反发刻印 / 屈服刻印都在线里', () => {
    const keys = new Set(ERASQC_STATE_LINES.flatMap((l) => l.keys));
    expect(keys.has('TALENT:恋慕')).toBe(true);
    expect(keys.has('MARK:反发刻印')).toBe(true);
    expect(keys.has('MARK:屈服刻印')).toBe(true);
    expect(keys.has('TALENT:处女')).toBe(true);
  });

  it('每条线都有中文标签与说明（作者面不出现内部 id）', () => {
    for (const line of ERASQC_STATE_LINES) {
      expect(line.label.length).toBeGreaterThan(0);
      expect(line.description?.length ?? 0).toBeGreaterThan(0);
      expect(line.keys.length).toBeGreaterThan(0);
    }
  });
});
