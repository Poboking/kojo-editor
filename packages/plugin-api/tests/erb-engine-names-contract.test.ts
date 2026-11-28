/**
 * ERB 引擎名数据契约闸（ERBDIAG-ERATW）。
 *
 * 守住三件事：
 * 1. **生成产物的输入指纹**：`tools/data/variables.yaml` 的 sha256 必须等于产物头记的那枚——
 *    输入被改了没重跑生成器，当场红（不许"改了快照不改产物"悄悄过去）。
 * 2. **语料闸门已定性的 vocab-gap 名必须进权威表**：COUNT / Y / __INT_MAX__ 等。
 * 3. **生产表 = 权威 ∪ 语料补充**：过去手抄的 53 枚里，除 `NOW`（spec 查无、语料实证）
 *    外必须全在权威表里；且生产表确实吃到了权威表的新名（防止接线漏接）。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ERB_ENGINE_NAME_LIST,
  ERB_ENGINE_NAMES,
  ERB_ENGINE_RESERVED_IDENTIFIERS,
} from '@kojo/plugin-api';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const INPUT = path.join(ROOT, 'tools', 'data', 'variables.yaml');
const TARGET = path.join(ROOT, 'packages', 'plugin-api', 'src', 'erb.ts');

/** 这批名此前被语料闸门逐条定性为 `engine-builtin-vocab-gap`，现在必须被权威表收掉。 */
const KNOWN_GAPS = [
  'COUNT',
  'Y',
  '__INT_MAX__',
  '__INT_MIN__',
  'ITEMSALES',
  'GLOBALS',
  'LOSEBASE',
  'PALAMLV',
  'EXPLV',
  'RESULTF',
];

describe('ERB 引擎名数据契约（spec 权威 ∪ 语料补充）', () => {
  it('生成区间的输入 sha256 与快照逐字相符', () => {
    const raw = readFileSync(INPUT, 'utf8');
    const sha = createHash('sha256').update(raw, 'utf8').digest('hex');
    const src = readFileSync(TARGET, 'utf8');
    expect(src, 'variables.yaml 改了但没重跑 node tools/gen-erb-engine-names.mjs')
      .toContain(`sha256 = \`${sha}\``);
  });

  it('语料闸门定性的 vocab-gap 名全部进入权威名单', () => {
    const set = new Set(ERB_ENGINE_NAME_LIST.map((n) => n.toUpperCase()));
    for (const name of KNOWN_GAPS) {
      expect(set.has(name), `${name} 应来自 specs/variables.yaml 的引擎变量表`).toBe(true);
    }
  });

  it('每条权威名带非空来源段，且无重复', () => {
    expect(ERB_ENGINE_NAMES.length).toBeGreaterThan(100);
    const names = ERB_ENGINE_NAMES.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const e of ERB_ENGINE_NAMES) {
      expect(e.section.length, `名字 ${e.name} 缺来源段`).toBeGreaterThan(0);
    }
  });

  it('生产表 = 权威表 + NOW（语料实证补充），不漏接新增', () => {
    const authoritative = new Set(ERB_ENGINE_NAME_LIST.map((n) => n.toUpperCase()));
    const produced = new Set(ERB_ENGINE_RESERVED_IDENTIFIERS.map((n) => n.toUpperCase()));
    // 权威表每一枚都进生产（不漏接）。
    for (const name of authoritative) {
      expect(produced.has(name), `${name} 在权威表但没进 ERB_ENGINE_RESERVED_IDENTIFIERS`).toBe(true);
    }
    // 生产表相对权威表只多 NOW 一枚语料补充。
    const extra = [...produced].filter((n) => !authoritative.has(n));
    expect(extra.sort()).toEqual(['NOW']);
  });
});
