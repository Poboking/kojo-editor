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
    // 与生成器同尺：先 EOL 归一化再算 sha，避免 git autocrlf 换 EOL 造成假红。
    const sha = createHash('sha256').update(raw.replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
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

  /**
   * 维度/类型读数必须跟着 spec 的**段口径 + 逐条例外**走，不许按段一把梭。
   *
   * 这条断言是踩过坑补的：初版把 `pseudo_vars` 与 `csv_constants` 都默认成 0 维，
   * 结果 `RAND:n`（语料 76,015 处）与 `ABLNAME:0`（400+ 处）全被判成"标量带参数"。
   * 段名相似不等于维度相同，一行默认值就能把 7 万处合法写法变成满屏红。
   */
  it('维度/类型读数：段口径 + 逐条例外 + 「不猜」的段都如实反映', () => {
    const byName = new Map(ERB_ENGINE_NAMES.map((e) => [e.name, e]));
    // 1 维整数 / 字符串 / 函数局部数组（段注释明写 dims 统一为 1）
    expect(byName.get('FLAG')).toMatchObject({ dim: 1, kind: 'int' });
    expect(byName.get('STR')).toMatchObject({ dim: 1, kind: 'str' });
    expect(byName.get('LOCAL')).toMatchObject({ dim: 1, kind: 'int' });
    // 函数局部六名的 kind 不能随段默认一刀切成 int（2026-11-28 语料闸实证订正）：
    // LOCALS/ARGS 是字符串局部（`CreateLocalStr`，VariableData.cs:3184-3187），
    // LOCALF/ARGF 是浮点局部（fork-src VariableData.cs:376-379）。
    expect(byName.get('LOCALS')).toMatchObject({ dim: 1, kind: 'str' });
    expect(byName.get('ARGS')).toMatchObject({ dim: 1, kind: 'str' });
    expect(byName.get('LOCALF')).toMatchObject({ dim: 1, kind: 'float' });
    expect(byName.get('ARGF')).toMatchObject({ dim: 1, kind: 'float' });
    // 多元数组：dim 逐条给（VariableData.cs:3103-3110）
    expect(byName.get('DITEMTYPE')!.dim).toBe(2);
    expect(byName.get('TA')!.dim).toBe(3);
    // 逐条例外：字符串段里唯一的 0 维标量（VariableData.cs:3073，`index: -`）
    expect(byName.get('SAVEDATA_TEXT')).toMatchObject({ dim: 0, kind: 'str' });
    // CSV 名字表是**一维**只读数组（`Str1DConstantToken`）；GAMEBASE 常量才是 0 维
    expect(byName.get('ABLNAME')).toMatchObject({ dim: 1, kind: 'str' });
    expect(byName.get('GAMEBASE_TITLE')).toMatchObject({ dim: 0, kind: 'str' });
    // 「不猜」：`pseudo_vars` 没有 dim 字段且成员形态不一；`character_vars` 子段结构不统一
    expect(byName.get('RAND')!.dim).toBeUndefined();
    expect(byName.get('CHARANUM')!.dim).toBeUndefined();
    expect(byName.get('CFLAG')!.dim).toBeUndefined();
    // 反空匹配自证：确实有一大批名字带维度，否则上面全是空断言
    expect(ERB_ENGINE_NAMES.filter((e) => e.dim !== undefined).length).toBeGreaterThan(100);
  });
});
