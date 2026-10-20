/**
 * 裸自增 / 自减行与 `{}` 多行语句括号的显示形验收（TAIL-1）。
 *
 * 这一批砍的是兜底大头（挂盘实测 `other` 3,724 里的 **1,365 行后缀自增/自减**
 * 与 **318 行的 `{` / `}` 括号行**）。两组能力各自的判据都写死在实现文件的注释里，
 * 本文件只钉三件事：
 *
 * 1. **精确形**——每例钉死期望字符串（显示口径漂移 = 立刻红）；
 * 2. **不误判**——非自增的裸引用行（`CFLAG:1:1009` / `ABL:親密` / `Snum`）必须 `null`，
 *    `A + B ++` 这种"目标不是单个引用"的表达式也不许被读成自增；
 * 3. **红线自证**——所有正例都与源行逐字不等（`isVerbatimNativeLine` 复核）。
 *
 * 括号行的判据归属 `control.ts`（结构行归 ZH-C，与 TRY 系 / 分组记号同一档）；
 * 语句层对它们必须弃权（`renderStatementLine` 返 `null`），两档互不认领由本文件钉住。
 */

import { describe, expect, it } from 'vitest';
import { FAMILY_ALIASES_REVERSE } from '@kojo/plugin-eratw-adapter';
import { renderStatementLine } from '../src/native-display/statement';
import { renderControlLine } from '../src/native-display/control';
import { localizeNativeLine } from '../src/native-display/passes';
import { isVerbatimNativeLine } from '../src/native-display/types';
import type { NativeDisplayInput, NativeDisplayLookup } from '../src/native-display/types';
import { lookupKeyword } from '../src/keywords';

/**
 * 桩名表：族头别名取 adapter **真表**（零漂移）；`slotCn` 恒 `undefined`——
 * 本批只验"目标怎么显示"，槽名换算的既有覆盖面在 `native-display-statement.test.ts`，
 * 这里不另造第二套桩。
 */
const DICT: NativeDisplayLookup = {
  familyAlias: (f) => FAMILY_ALIASES_REVERSE[f],
  slotCn: () => undefined,
};

const render = (content: string, lookup?: NativeDisplayLookup): string | null =>
  renderStatementLine({ content, indent: 0, lookup } satisfies NativeDisplayInput);

const renderCtrl = (content: string): string | null =>
  renderControlLine({ content, indent: 0 } satisfies NativeDisplayInput);

/* ==================== 正例：后缀 / 前缀两形精确命中 ==================== */

type Case = readonly [line: string, lookup: NativeDisplayLookup | undefined, expected: string];

const INC_CASES: readonly Case[] = [
  /* —— 语料大盘：后缀自增（`ABL:親密 ++` / `CFLAG:1:1009 ++`）—— */
  ['ABL:親密 ++', DICT, '自增 能力:親密'],
  ['CFLAG:1:1009 ++', DICT, '自增 角色标志:1:1009'],
  ['CFLAG:1:1007  ++', DICT, '自增 角色标志:1:1007'], // 双空格真形
  ['CFLAG:1:1009++', DICT, '自增 角色标志:1:1009'], // 无空格真形
  ['EXP:1:口淫経験 ++', DICT, '自增 快感经验:1:口淫経験'],
  ['TFLAG:193 ++', DICT, '自增 时标:193'],
  /* —— 语言层槽位：lookup 缺席也照常翻 —— */
  ['LOCAL:2 ++', undefined, '自增 局部:2'],
  ['LOCAL:2++', undefined, '自增 局部:2'],
  ['LOCAL++', undefined, '自增 局部'],
  ['--LOCAL:2', undefined, '自减 局部:2'],
  ['-- LOCAL:2', undefined, '自减 局部:2'],
  ['++LOCAL', undefined, '自增 局部'],
  /* —— 作者自造名 / 宏 / 带括号索引：形状是一个引用 ⇒ 逐字带走 —— */
  ['Snum++', DICT, '自增 Snum'],
  ['Snum++;2', DICT, '自增 Snum ;2'], // 行尾 `;` 注释原样保留
  ['Snum++ ;1', DICT, '自增 Snum ;1'],
  ['ORINQI --', DICT, '自减 ORINQI'],
  ['残りムシ数 --', undefined, '自减 残りムシ数'],
  ['ITEM:(ID:ID) ++', DICT, '自增 ITEM:(ID:ID)'],
  /* —— 行尾注释：剥离后原样缀回（`LOCAL:2 ++  ;通话自慰中` 盘上真形） —— */
  ['LOCAL:2 ++\t\t;通话自慰中', undefined, '自增 局部:2 ;通话自慰中'],
  ['--LOCAL:2 ;备注', undefined, '自减 局部:2 ;备注'],
];

describe.each(INC_CASES)('裸自增/自减显示形 · %s', (line, lookup, expected) => {
  it('中文形精确命中 + 红线自证', () => {
    const rendered = render(line, lookup);
    expect(rendered).toBe(expected);
    expect(rendered).not.toBeNull();
    expect(isVerbatimNativeLine(rendered ?? '', line)).toBe(false);
  });
});

/* ==================== 斜线自证：非自增行不许被误判 ==================== */

const NOT_INCREMENT_LINES: readonly string[] = [
  'CFLAG:1:1009', // 裸引用：没有运算符
  'ABL:親密', // 裸引用
  'Snum', // 作者变量裸引用
  'LOCAL:2', // 语言层槽位裸引用
  '++', // 光秃秃的运算符 = 畸形行
  '--',
  '++ ', // 前缀无目标
  '1 ++', // 目标不是引用（数字起头）
  'A + B ++', // 目标不是**单个**引用
  'A ++ B', // 运算符不在行尾
  'PRINTFORM ++', // 表外打印变体不许被读成自增
];

describe.each(NOT_INCREMENT_LINES)('非自增行不误判 · "%s" ⇒ null', (line) => {
  it('语句层弃权（调用方给显式兜底）', () => {
    expect(render(line, DICT)).toBeNull();
    expect(render(line, undefined)).toBeNull();
  });
});

/* ==================== `{}` 多行语句括号：control 认领 / statement 弃权 ==================== */

describe('多行语句括号（`{` / `}` 整行）', () => {
  it('中性显示形精确命中', () => {
    expect(renderCtrl('{')).toBe('多行语句开始');
    expect(renderCtrl('}')).toBe('多行语句结束');
    expect(renderCtrl('{ ;开始')).toBe('多行语句开始 ;开始');
    expect(renderCtrl('} ;结束')).toBe('多行语句结束 ;结束');
  });

  it('语句层对两枚括号弃权（档位互不认领）', () => {
    expect(render('{', DICT)).toBeNull();
    expect(render('}', DICT)).toBeNull();
  });

  it('装配后走 control 的中性形（不落兜底）', () => {
    expect(localizeNativeLine({ content: '{', indent: 0 })).toBe('多行语句开始');
    expect(localizeNativeLine({ content: '}', indent: 0 })).toBe('多行语句结束');
  });

  it('非"整行一个括号"的形状不归本档（括号出现在行中 = 别人的载荷）', () => {
    expect(renderCtrl('{ 1 }')).toBeNull();
    expect(renderCtrl('PRINTFORM {')).toBeNull();
    expect(renderCtrl('{IF LOCAL}')).toBeNull();
  });

  it('词形不靠往 KEYWORDS 加词实现（写形归另一条线）', () => {
    for (const w of ['多行语句开始', '多行语句结束', '自增', '自减']) expect(lookupKeyword(w), w).toBeUndefined();
  });
});
