/**
 * 数据表**分组记号**的中性显示形（`DATALIST` / `ENDLIST` / `STRDATA`，工包：分组记号显示形）。
 *
 * 与 TRY 系九枚同一档先例：批 N **刻意不投影**这些记号（结构判据不动），但显示层不再
 * 谎报"没读懂"——给 `分组 原形 <记号> …：` / `分组结束 原形 <记号>` / `数据表 原形 STRDATA …：`
 * 三形，判据 = **记号逐字回显、载荷逐字带走、不解释义项**（同 `JUMP` / `DATAFORM` 口径）。
 *
 * 独立成文件而不塞进 `native-display-control.test.ts`：钉值表对着的是**语料词形普查**
 * （SANYOUSEI 盘 2026-10-20 实测：`DATALIST`/`ENDLIST` 各 2,380 全裸，`STRDATA` 199 = 197 带名 + 2 裸，
 * 零变体），名单边界与同源闸要一起搬动，别和 ZH-C 全表混成一份口径。
 */

import { describe, expect, it } from 'vitest';
import { renderControlLine } from '../src/native-display/control';
import { localizeNativeLine } from '../src/native-display/passes';
import { isVerbatimNativeLine } from '../src/native-display/types';
import { lookupKeyword } from '../src/keywords';
import { CONTROL_SHAPES } from '../src/sugar-ident';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

const show = (content: string): string | null => renderControlLine({ content, indent: 0 });

/** [输入行原文, 钉住的显示形] */
type Case = readonly [string, string];

/**
 * 语料真形 + 防御性变体（小写 = 记号归一；`:甲:乙` = `sugar-ident` 测试样例形；带名 = `STRDATA` 主流形）。
 * 样例只带**词形**不带路径——语料出处见头注实测数。
 */
const DATA_GROUPING: readonly Case[] = [
  // 盘上主流形：`DATALIST`/`ENDLIST` 2,380 对全裸（行尾注释已被 splitComment 分离）
  ['DATALIST', '分组 原形 DATALIST：'],
  ['ENDLIST', '分组结束 原形 ENDLIST'],
  ['datalist', '分组 原形 DATALIST：'], // 变形：小写记号（回显用规范大写，同 TRY 族）
  ['endlist', '分组结束 原形 ENDLIST'],
  // 防御性载荷形（盘上 0 例，判据与 TRY 系载荷同一条：逐字带走、不中文化运算符）
  ['DATALIST :甲:乙', '分组 原形 DATALIST 甲:乙：'],
  ['ENDLIST 尾注', '分组结束 原形 ENDLIST 尾注'],
  // `STRDATA` = 数据表开词族（配 `ENDDATA`）：盘上 197/199 带名 ⇒ 名段逐字带走
  ['STRDATA', '数据表 原形 STRDATA：'], // 裸形 2 例
  ['STRDATA 台词', '数据表 原形 STRDATA 台词：'], // 带名主流形
  ['STRDATA :甲:乙', '数据表 原形 STRDATA 甲:乙：'],
  ['strdata 台词', '数据表 原形 STRDATA 台词：'], // 变形：小写记号
  ['STRDATA A = 1', '数据表 原形 STRDATA A = 1：'], // 载荷是数据：`=` 不折 `等于`
  // 行尾注释照旧挂回行尾（装配层通用通路，钉住不被分组分支吞掉）
  ['DATALIST ; 分组开', '分组 原形 DATALIST： ; 分组开'],
];

describe('分组记号 · 中性显示形（已知结构不再落 `未识别语句`）', () => {
  it.each(DATA_GROUPING)('%s', (src, want) => {
    const got = show(src);
    expect(got, src).not.toBeNull();
    expect(got, src).not.toBe(src);
    expect(isVerbatimNativeLine(got ?? '', src), src).toBe(false);
    expect(got, src).toBe(want);
    expect(localizeNativeLine({ content: src, indent: 0 }), src).not.toContain('未识别语句');
  });
});

describe('分组记号 · 不进 KEYWORDS（登记 = 承诺写得回去，写形不归本批）', () => {
  it('`分组` / `分组结束` 未登记；`lookupKeyword` 查不到 ⇒ 写侧不认', () => {
    expect(lookupKeyword('分组'), '写形未落地就不许进词表').toBeUndefined();
    expect(lookupKeyword('分组结束'), '写形未落地就不许进词表').toBeUndefined();
  });

  it('把显示形当 `.kojo` 源写回 ⇒ 发不出 DATALIST/ENDLIST/STRDATA 语句（只读面自证）', () => {
    const shown = show('DATALIST')!;
    const result = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() }).transpile(
      `角色: 12\n时机 救济：\n\t${shown}\n${show('ENDLIST')!}\n`,
    );
    const emitted = result.erb.split('\n').map((l) => l.trim());
    expect(emitted.some((l) => /^(DATALIST|ENDLIST|STRDATA)\b/.test(l)), result.erb).toBe(false);
  });
});

describe('分组记号 · 名单与 CONTROL_SHAPES 同源（真源漂了本闸立刻显形）', () => {
  it.each([
    ['DATALIST', 'structural-open', 'list'],
    ['STRDATA', 'structural-open', 'data'],
    ['ENDLIST', 'structural-close', undefined],
  ] as const)('%s 在结构栈表里的档位逐字为 %s', (kind, role, open) => {
    const shape = CONTROL_SHAPES.get(kind);
    expect(shape, `${kind} 必须是识别核在册记号`).toBeDefined();
    expect(shape?.role, kind).toBe(role);
    expect(shape?.open, kind).toBe(open);
  });

  it('开块类别 list/data 的记号**恰为**这两枚（不许悄悄长出第四枚显示形）', () => {
    const groupOpen = [...CONTROL_SHAPES.values()]
      .filter((s) => s.open === 'list' || s.open === 'data')
      .map((s) => s.kind)
      .sort();
    expect(groupOpen, '本层显示形认领的开词名单 = 结构栈 list/data 两枚').toEqual(['DATALIST', 'STRDATA']);
  });
});

describe('分组记号 · 边界（同族但无语料/表内证据的一枚都不认）', () => {
  it('NOSKIP / ENDNOSKIP 不认领（批 N 同款保守：无义项出处 ⇒ 继续落兜底，归因由语料闸读数）', () => {
    for (const src of ['NOSKIP', 'ENDNOSKIP']) {
      expect(show(src), src).toBeNull();
    }
  });

  it('PRINTDATA 开词族零改动（`renderDataOpen` 加默认参不改任何既有钉值）', () => {
    expect(show('PRINTDATA')).toBe('数据表：');
    expect(show('PRINTDATADL')).toBe('数据表 原形 PRINTDATADL：');
    expect(show('ENDDATA')).toBe('数据表结束');
    expect(show('DATAFORM 选项')).toBe('条目 选项');
    expect(show('DATA 选项')).toBe('条目 原形 DATA 选项');
  });
});
