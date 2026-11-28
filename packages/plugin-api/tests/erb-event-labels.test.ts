/**
 * 引擎事件标签名契约（4.981 `IdentifierDictionary.cs::IsEventLabelName`）。
 *
 * 这批名字允许多处定义且**全部执行**，`erb.duplicate-function` 按本集合做结构豁免；
 * 所以集合本身必须与引擎 switch 逐字对拍，少一枚就会漏掉一个假问题族，
 * 多一枚就会把一个真重复悄悄放过。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ERB_EVENT_LABEL_NAMES, isErbEventLabelName } from '../src/erb';

const SNAPSHOT_URL = new URL('../../../tools/data/IdentifierDictionary.4.981.cs', import.meta.url);
const SNAPSHOT_SHA256 = 'ab05d95d52b6a1a69bc26d335f7c8e3bb98279d717949e38818c06228622d3a3';

/** eraTW 4.981 真语料实测：6 枚 / 30 条定义（loader.md 附录 D.4）。 */
const CORPUS_OBSERVED = [
  'EVENTFIRST', 'EVENTLOAD', 'EVENTTURNEND', 'EVENTCOMEND', 'EVENTTRAIN', 'EVENTCOM',
];

describe('ERB 引擎事件标签名 ↔ 4.981 IsEventLabelName', () => {
  it('快照 sha 逐字钉住（EOL 归一化后算）', () => {
    const text = readFileSync(fileURLToPath(SNAPSHOT_URL), 'utf8').replace(/\r\n?/g, '\n');
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(SNAPSHOT_SHA256);
  });

  it('生产集合 == 源码 switch 的全体 case（双向差集为空）', () => {
    const text = readFileSync(fileURLToPath(SNAPSHOT_URL), 'utf8').replace(/\r\n?/g, '\n');
    const from = text.indexOf('bool IsEventLabelName(string labelName)');
    const to = text.indexOf('public static bool', from);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const fromSource = new Set(
      [...text.slice(from, to).matchAll(/case\s+"([A-Z_0-9]+)"\s*:/g)].map((m) => m[1]!),
    );
    const produced = new Set(ERB_EVENT_LABEL_NAMES);
    expect([...fromSource].filter((n) => !produced.has(n))).toEqual([]);
    expect([...produced].filter((n) => !fromSource.has(n))).toEqual([]);
    expect(produced.size).toBe(11);
  });

  it('eraTW 真语料实测的 6 枚逐条在位；非事件名不许混进来', () => {
    for (const name of CORPUS_OBSERVED) {
      expect(isErbEventLabelName(name), name).toBe(true);
    }
    for (const name of ['AAA', 'EVENT', 'SHOW_STATUS', 'CALLTRAINEND']) {
      expect(isErbEventLabelName(name), name).toBe(false);
    }
  });

  it('大小写不敏感、前后空白裁掉（eraTW IGNORE CASE:YES）', () => {
    expect(isErbEventLabelName('  eventfirst ')).toBe(true);
    expect(isErbEventLabelName('Before_Throw')).toBe(true);
  });
});
