/**
 * P3-10 · CB 规则库契约闸（eratw specs/corpus-bugs.md 36 案 → kojo 判据库映射）。
 *
 * 台账 = 随包语料内容缺陷的可诊断模式到 kojo 侧判据的逐案映射。守住三件事：
 * 1. **无遗漏**：CB-001..CB-036 每案恰好归档一次，状态 ⊆ 四类闭集
 *    （consumed / covered-by / not-covered / platform-na）；
 * 2. **consumed / covered-by 的落点真实存在**（文件漂移即红，engine-error-texts 同款）；
 * 3. **判性可追**：每案 where 必须写明落点或判据缺口（不许「暂不支持」空话），
 *    锚（specs/corpus-bugs.md 案号 + C# 文件:行号）不缺失。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERB_CORPUS_BUG_LEDGER } from '../src/corpus-bug-ledger';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');

describe('CB 规则库契约（specs/corpus-bugs.md 36 案）', () => {
  it('CB-001..036 逐案恰好归档一次，无空号、无重复', () => {
    const ids = ERB_CORPUS_BUG_LEDGER.map((e) => e.id);
    expect(ids).toHaveLength(36);
    const want = Array.from({ length: 36 }, (_, i) => `CB-${String(i + 1).padStart(3, '0')}`);
    expect(ids, '台账 id 必须逐案编号且按序（缺案/重案/跳号即红）').toEqual(want);
  });

  it('状态闭集：consumed / covered-by / not-covered / platform-na', () => {
    const legal = new Set(['consumed', 'covered-by', 'not-covered', 'platform-na']);
    for (const e of ERB_CORPUS_BUG_LEDGER) {
      expect(legal.has(e.status), `${e.id} 状态 ${e.status} 不在闭集`).toBe(true);
      expect(e.where.length, `${e.id} 的 where 必须写明落点或判据缺口`).toBeGreaterThan(20);
      expect(e.anchor, `${e.id} 必须带锚（specs/corpus-bugs.md + C# 文件:行号）`).toMatch(/CB-\d{3}/);
    }
  });

  it('consumed / covered-by 的落点指到真实存在的文件', () => {
    for (const e of ERB_CORPUS_BUG_LEDGER.filter((x) => x.status === 'consumed' || x.status === 'covered-by')) {
      for (const m of e.where.matchAll(/`([\w./-]+\.(?:ts|kt|cs|erb))`/g)) {
        const rel = m[1]!;
        const abs = rel.startsWith('packages/')
          ? path.join(ROOT, rel)
          : rel.startsWith('plugins/')
            ? path.join(ROOT, 'packages', rel)
            : path.join(ROOT, rel);
        expect(() => readFileSync(abs, 'utf8'), `${e.id} 的落点 ${rel} 不存在，落点已漂`).not.toThrow();
      }
    }
  });

  it('判性钉：CB-002/007 covered-by 变量越界闸、CB-004/013 consumed 位域闸、CB-033 consumed 负字面下标', () => {
    const byId = new Map(ERB_CORPUS_BUG_LEDGER.map((e) => [e.id, e]));
    expect(byId.get('CB-002')!.status).toBe('covered-by');
    expect(byId.get('CB-002')!.where).toContain('erb.variable-bounds');
    expect(byId.get('CB-007')!.status).toBe('covered-by');
    expect(byId.get('CB-004')!.status).toBe('consumed');
    expect(byId.get('CB-004')!.where).toContain('erb.engine-line-checks');
    expect(byId.get('CB-013')!.status).toBe('consumed');
    expect(byId.get('CB-033')!.status).toBe('consumed');
    expect(byId.get('CB-033')!.where).toContain('erb.variable-bounds');
    for (const id of ['CB-018', 'CB-019', 'CB-034', 'CB-035', 'CB-036']) {
      expect(byId.get(id)!.status, `${id} 是触屏平台适配补丁，非判据`).toBe('platform-na');
    }
  });
});
