/**
 * 单行条件 `如果 <条件> 则 <语句>` → 引擎 `SIF`（本批 (a)）
 * 与 值函数裸 `返回` → 裸 `RETURNF`（本批 (b)）。
 *
 * 表层：
 * - `如果 <条件> 则 <语句>`（**无尾冒号**）→ `SIF <条件>` + 紧随**恰好一条**语句行，
 *   **不产** `ENDIF`；语句若会展开成多行（`你：` 自机台词 / 纯条件行）→ **自动退化**
 *   `IF` / 语句 / `ENDIF`（`SIF` 只护一行，护不住就先把它展开）。
 * - 值函数（存在带值返回）里的**裸** `返回` → 裸 `RETURNF`；过程函数仍是 `RETURN`。
 *
 * 组织：① 打印行 / 心形 / 原生行 / 调用（单行形态，走 SIF）→ ② 多行语句自动退化
 *      → ③ 不吞行 / 与块形不冲突 → ④ 空条件 / 空语句 / 块头语句（报错不产半成品）
 *      → ⑤ 值函数裸返回二态。
 */

import { describe, expect, it } from 'vitest';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
const t = (src: string) => svc().transpile(src);
const errs = (src: string) => t(src).diagnostics.filter((d) => d.severity === 'error');
/** 产物逐行（去缩进）——断言"某行恰为 X"比裸子串更稳 */
const lines = (erb: string) => erb.split('\n').map((l) => l.trim());
/** `ENDIF` 行数（每个「时机」的信封自有一个；SIF 不应再加） */
const endifCount = (erb: string) => lines(erb).filter((l) => l === 'ENDIF').length;

/** 公共头：角色号（产物函数名模板用）+ 一个 CFLAG 别名（条件/返回都拿它当引用） */
const HEAD = '角色: 12\n别名 好感 = CFLAG:TARGET:1088\n';

/* ============================================================================ */
/* ① 单行形态 → SIF                                                              */
/* ============================================================================ */

describe('单行条件 · SIF（打印行 / 心形 / 原生行 / 调用）', () => {
  it('打印行：`如果 <条件> 则 「…」` → `SIF <条件>` 紧随一条 PRINTFORMW，SIF 自身不加 ENDIF', () => {
    const { erb, diagnostics } = t(HEAD + '时机 初见：\n    如果 好感 至少 50 则 「你好。」\n');
    const ls = lines(erb);
    const si = ls.findIndex((l) => l.startsWith('SIF '));
    expect(si).toBeGreaterThanOrEqual(0);
    expect(ls[si + 1]).toBe('PRINTFORMW 「你好。」');
    expect(endifCount(erb)).toBe(1); // 只有时机信封的 ENDIF
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('心形单行：`则 心形 「…」` → `SIF` 紧随 `HPH_PRINT`，不加 ENDIF', () => {
    const { erb } = t(HEAD + '时机 初见：\n    如果 好感 至少 50 则 心形 「噢。」\n');
    const ls = lines(erb);
    const si = ls.findIndex((l) => l.startsWith('SIF '));
    expect(si).toBeGreaterThanOrEqual(0);
    expect(ls[si + 1]!.startsWith('CALL HPH_PRINT')).toBe(true);
    expect(endifCount(erb)).toBe(1);
  });

  it('原生指令行：`则 SETCOLOR …` 逐字透传为 SIF 的**下一行**', () => {
    const { erb } = t(HEAD + '时机 初见：\n    如果 好感 至少 50 则 SETCOLOR 0xFF8080\n');
    const ls = lines(erb);
    const si = ls.findIndex((l) => l.startsWith('SIF '));
    expect(si).toBeGreaterThanOrEqual(0);
    expect(ls[si + 1]).toBe('SETCOLOR 0xFF8080');
    expect(endifCount(erb)).toBe(1);
  });

  it('`则 调用 …` → `SIF` + `CALL <产物名>(实参)`', () => {
    const src =
      HEAD +
      '函数 问候(次数)：\n    「你好。」\n    返回\n' +
      '时机 初见：\n    如果 好感 至少 50 则 调用 问候(1)\n';
    const { erb } = t(src);
    expect(erb).toContain('SIF ');
    expect(erb).toContain('CALL M_KOJO_K12_问候(1)');
    expect(endifCount(erb)).toBe(1);
  });

  it('英文别名：`if <条件> then <语句>` 同形（`then` 与 `则` 等价）', () => {
    const { erb } = t(HEAD + '时机 初见：\n    if 好感 至少 50 then 「你好。」\n');
    expect(lines(erb).some((l) => l.startsWith('SIF '))).toBe(true);
    expect(endifCount(erb)).toBe(1);
  });
});

/* ============================================================================ */
/* ② 多行语句自动退化 IF/ENDIF                                                    */
/* ============================================================================ */

describe('单行条件 · 多行语句自动退化（SIF 只护一行）', () => {
  it('`你：` 自机台词（换色 run ≥ 2 行）→ 退化 IF/ENDIF，色切换仍在', () => {
    const src =
      '角色: 12\n自机色: 0xFFFF00\n别名 好感 = CFLAG:TARGET:1088\n' +
      '时机 初见：\n    如果 好感 至少 50 则 你：你好。\n';
    const { erb } = t(src);
    expect(erb).toMatch(/(^|\n)\s*IF /);
    expect(erb).toContain('ENDIF');
    expect(erb).toContain('SETCOLOR 0xFFFF00');
    expect(erb).toContain('PRINTFORMW 你好。');
  });

  it('纯条件行语句（自身就是 IF 块）→ 同样退化 IF/ENDIF', () => {
    const src = HEAD + '时机 初见：\n    如果 好感 至少 50 则 {好感 至少 50 ? "「哦。」" : ""}\n';
    const { erb } = t(src);
    expect(erb).toMatch(/(^|\n)\s*IF /);
    expect(erb).toContain('ENDIF');
  });
});

/* ============================================================================ */
/* ③ 不吞行 / 与块形不冲突                                                        */
/* ============================================================================ */

describe('单行条件 · 不吞后续行 / 与块形共存', () => {
  it('单行条件之后同级行的照常转译（绝不吞后续行）', () => {
    const src = HEAD + '时机 初见：\n    如果 好感 至少 50 则 「甲。」\n    「乙。」\n';
    const { erb } = t(src);
    const ls = lines(erb);
    const si = ls.findIndex((l) => l.startsWith('SIF '));
    expect(si).toBeGreaterThanOrEqual(0);
    expect(ls[si + 1]).toBe('PRINTFORMW 「甲。」'); // SIF 只护它
    expect(ls).toContain('PRINTFORMW 「乙。」');     // 后续行照常转译
    expect(endifCount(erb)).toBe(1);
  });

  it('块形 `如果 …：` 不受影响：仍产 IF/ENDIF（信封 + 块），且不产 SIF', () => {
    const src = HEAD + '时机 初见：\n    如果 好感 至少 50：\n        「你好。」\n';
    const { erb } = t(src);
    expect(erb).toMatch(/(^|\n)\s*IF /);
    expect(endifCount(erb)).toBe(2); // 信封 + 块
    expect(erb).not.toContain('SIF ');
  });
});

/* ============================================================================ */
/* ④ 残缺形态：报错、不产半成品                                                   */
/* ============================================================================ */

describe('单行条件 · 残缺形态（复用既有码，不产半成品）', () => {
  it('条件为空（`如果 则 …`）→ error，不产 SIF', () => {
    const src = HEAD + '时机 初见：\n    如果 则 「你好。」\n';
    expect(errs(src).map((d) => d.code)).toContain('indent-mismatch');
    expect(t(src).erb).not.toContain('SIF ');
  });

  it('`则` 后无语句（`如果 … 则`）→ error，不产 SIF', () => {
    const src = HEAD + '时机 初见：\n    如果 好感 至少 50 则\n';
    expect(errs(src).map((d) => d.code)).toContain('block-empty');
    expect(t(src).erb).not.toContain('SIF ');
  });

  it('`则` 后是块头（带 `：`）→ error（不认、不递归解块、不吞后续行）', () => {
    const src = HEAD + '时机 初见：\n    如果 好感 至少 50 则 如果 好感 至少 80：\n';
    expect(errs(src).map((d) => d.code)).toContain('indent-mismatch');
    expect(t(src).erb).not.toContain('SIF ');
  });
});

/* ============================================================================ */
/* ⑤ 值函数裸返回 → 裸 RETURNF（(b)）                                             */
/* ============================================================================ */

describe('值函数裸返回 · RETURNF 二态', () => {
  it('过程函数：裸 `返回` → `RETURN`，不挂 `#FUNCTION`，无 `RETURNF`', () => {
    const src = '角色: 12\n函数 问候(次数)：\n    「你好。」\n    返回\n';
    const ls = lines(t(src).erb);
    expect(ls).toContain('RETURN');
    expect(ls).not.toContain('RETURNF');
    expect(ls).not.toContain('#FUNCTION');
  });

  it('值函数：`返回 <值>` → `#FUNCTION` + `RETURNF <值>`（既有行为不变）', () => {
    const src = '角色: 12\n函数 加倍(份)：\n    返回 份\n';
    const ls = lines(t(src).erb);
    expect(ls).toContain('#FUNCTION');
    expect(ls).toContain('RETURNF ARG');
  });

  it('值函数的**裸** `返回`（提前返回）→ 裸 `RETURNF`；首个返回是裸返回也算值函数', () => {
    const src =
      HEAD +
      '函数 挑选()：\n    如果 好感 至少 50 则 返回\n    返回 1\n';
    const ls = lines(t(src).erb);
    expect(ls).toContain('#FUNCTION');
    expect(ls).toContain('RETURNF'); // 裸（无值）
    expect(ls).toContain('RETURNF 1');
    expect(ls.some((l) => l.startsWith('SIF '))).toBe(true);
    expect(ls).not.toContain('RETURN'); // 过程返回不出现
  });

  it('唯一的值返回藏在单行条件里 → 仍判为值函数（挂 `#FUNCTION`）', () => {
    const src = HEAD + '函数 值函()：\n    如果 好感 至少 50 则 返回 1\n';
    const ls = lines(t(src).erb);
    expect(ls).toContain('#FUNCTION');
    expect(ls).toContain('RETURNF 1');
  });
});
