/**
 * 位糖 = 方案 E（v1.7）：行首**语句形**中文函数调用（严格白名单 3 枚）。
 *
 * 表层与产物**逐形 1:1**：
 * ```
 * 设置标记 X, n → SETBIT X, n
 * 清除标记 X, n → CLEARBIT X, n
 * 反转标记 X, n → INVERTBIT X, n
 * ```
 * `X` 是普通变量引用（走既有代词 / 别名降糖），`n` 是普通**表达式**（位号可为变量）。
 *
 * 硬约束（本批验收项）：
 * - 白名单严格 3 枚，**禁止**泛化到 `SYSTEM_FUNCTION_ALIASES` 全表（`随机` 与
 *   `KEYWORDS.block.random` 撞名会与既有行内随机抢道）——白名单 ∩ KEYWORDS = ∅，本文件钉死；
 * - 词法：整词匹配（`设置标记xx` / `置位状態` 不误判）、关键字后必须紧跟空白（半/全角）；
 * - 赋值守卫：关键字后首个非空白字符是 `=` 必须拒绝（`结算 = 1` 被吞词先例）；
 * - 位槽是**表达式**——`获取标记(HOLD, LOCAL)` 里的逗号不得被当成 target/slot 分隔符；
 * - `设置标记 X, 0` 行首**不再退化为旁白文本**（此前落 `lexer.classifyLine` 兜底 `text`，
 *   被当旁白吞掉，违反铁律「内核不静默」）；
 * - 零新诊断码：缺逗号 / 空位槽 / 位槽解析失败走既有 `unknown-identifier`。
 */

import { describe, expect, it } from 'vitest';
import { createSugarTranspileService } from '../src/service';
import { STATEMENT_FUNCTIONS } from '../src/statement-functions';
import * as sugarIndex from '../src/index';
import { SYSTEM_FUNCTION_ALIASES } from '../src/system-functions';
import { lookupKeyword } from '../src/keywords';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
const t = (src: string) => svc().transpile(src);

/** 正文落在 `时机 绝顶：` 体内（stub 表 = eraTW 真实模板） */
const doc = (body: string): string => `角色: 12\n时机 绝顶：\n${body}\n`;

/** 产物按行展开、去缩进 */
const outLines = (src: string): string[] => t(src).erb.split('\n').map((l) => l.trim());
const errs = (src: string) => t(src).diagnostics.filter((d) => d.severity === 'error');
const codes = (src: string) => t(src).diagnostics.map((d) => d.code);

/* ============================ 单一真源 / 白名单约束 ============================ */

describe('位糖 · 单一真源与白名单约束', () => {
  it('白名单经包入口 `index.ts` 再导出（单一真源对外可见）', () => {
    expect(sugarIndex.STATEMENT_FUNCTIONS).toBe(STATEMENT_FUNCTIONS);
  });

  it('白名单恰为严格 3 枚，且与引擎名一一对应', () => {
    expect([...STATEMENT_FUNCTIONS.entries()]).toEqual([
      ['设置标记', 'SETBIT'],
      ['清除标记', 'CLEARBIT'],
      ['反转标记', 'INVERTBIT'],
    ]);
  });

  it('引擎名与 `SYSTEM_FUNCTION_ALIASES` 一致（防两表漂移）', () => {
    for (const [cn, erb] of STATEMENT_FUNCTIONS) expect(SYSTEM_FUNCTION_ALIASES.get(cn)).toBe(erb);
  });

  it('`获取标记` 是表达式形（`GETBIT`），**不进**语句白名单', () => {
    expect(STATEMENT_FUNCTIONS.has('获取标记')).toBe(false);
    expect(SYSTEM_FUNCTION_ALIASES.get('获取标记')).toBe('GETBIT');
  });

  it('白名单 ∩ KEYWORDS = ∅（用 `lookupKeyword` 钉死；`随机` 不在白名单）', () => {
    for (const name of STATEMENT_FUNCTIONS.keys()) expect(lookupKeyword(name)).toBeUndefined();
    expect(STATEMENT_FUNCTIONS.has('随机')).toBe(false);
  });

  it('回归：`随机 「甲」,「乙」` 行内随机仍走既有路径（不被语句白名单抢道）', () => {
    const src = doc('\t随机 「甲」,「乙」');
    expect(errs(src)).toEqual([]);
    expect(outLines(src).some((l) => l.includes('RAND'))).toBe(true);
  });
});

/* ================================ 正向 · 逐形 1:1 ================================ */

describe('位糖 · 表层 → 产物逐形 1:1', () => {
  it('`设置标记 TFLAG:193, 0` → `SETBIT TFLAG:193, 0`', () => {
    const src = doc('\t设置标记 TFLAG:193, 0');
    expect(errs(src)).toEqual([]);
    expect(outLines(src)).toContain('SETBIT TFLAG:193, 0');
  });

  it('`清除标记 TFLAG:193, 1` → `CLEARBIT TFLAG:193, 1`', () => {
    const src = doc('\t清除标记 TFLAG:193, 1');
    expect(errs(src)).toEqual([]);
    expect(outLines(src)).toContain('CLEARBIT TFLAG:193, 1');
  });

  it('`反转标记 TFLAG:193, 2` → `INVERTBIT TFLAG:193, 2`', () => {
    const src = doc('\t反转标记 TFLAG:193, 2');
    expect(errs(src)).toEqual([]);
    expect(outLines(src)).toContain('INVERTBIT TFLAG:193, 2');
  });

  it('行首 `设置标记 X, 0` **不再退化为旁白文本**（不产 PRINTFORM 台词）', () => {
    const src = doc('\t设置标记 TFLAG:193, 0');
    expect(outLines(src).some((l) => /^PRINTFORM/.test(l) && l.includes('设置标记'))).toBe(false);
    expect(outLines(src)).toContain('SETBIT TFLAG:193, 0');
  });

  it('全角空格分隔关键字与内容（`设置标记\u3000…`）同样命中', () => {
    expect(outLines(doc('\t设置标记\u3000TFLAG:193, 0'))).toContain('SETBIT TFLAG:193, 0');
  });
});

/* ============================ 位槽是表达式（含变量） ============================ */

describe('位糖 · 位槽是表达式', () => {
  it('位号为变量引用：`设置标记 TFLAG:193, TFLAG:194` → `SETBIT TFLAG:193, TFLAG:194`', () => {
    expect(outLines(doc('\t设置标记 TFLAG:193, TFLAG:194'))).toContain('SETBIT TFLAG:193, TFLAG:194');
  });

  it('位槽含函数调用 `获取标记(HOLD, LOCAL)`：括号内逗号**不得**被当 target/slot 分隔符', () => {
    const outs = outLines(doc('\t设置标记 TFLAG:193, 获取标记(HOLD, LOCAL)'));
    // 转义降糖：`获取标记` → `GETBIT`；括号内逗号原样保留
    expect(outs).toContain('SETBIT TFLAG:193, GETBIT(HOLD, LOCAL)');
  });
});

/* ============================= 代词 / 别名 降糖 ============================= */

describe('位糖 · 目标走既有代词 / 别名降糖', () => {
  it('代词属性目标：`设置标记 她的好感度, 0` → `SETBIT CFLAG:TARGET:好感度, 0`', () => {
    const src = doc('\t设置标记 她的好感度, 0');
    expect(errs(src)).toEqual([]);
    expect(outLines(src)).toContain('SETBIT CFLAG:TARGET:好感度, 0');
  });

  it('变量别名目标：`设置标记 标记, 0` 展开为别名指向的变量引用', () => {
    const src = '角色: 12\n别名 标记 = CFLAG:TARGET:1088\n时机 绝顶：\n\t设置标记 标记, 0\n';
    expect(errs(src)).toEqual([]);
    expect(outLines(src)).toContain('SETBIT CFLAG:TARGET:1088, 0');
  });

  it('只读别名目标（`.ERB` 位设置语义 + 只读约束）：报既有 `readonly-alias-assignment`，不产半成品', () => {
    const src = '角色: 12\n别名 安静 = 0\n时机 绝顶：\n\t设置标记 安静, 0\n';
    expect(codes(src)).toContain('readonly-alias-assignment');
    expect(outLines(src).some((l) => l.startsWith('SETBIT'))).toBe(false);
  });
});

/* ============================== 赋值守卫 / 负例 ============================== */

describe('位糖 · 赋值守卫与整词负例', () => {
  it('赋值守卫：`设置标记 = 1` 不被吞成语句（退回普通赋值 `设置标记 = 1`）', () => {
    const src = doc('\t设置标记 = 1');
    expect(outLines(src)).toContain('设置标记 = 1');
    expect(outLines(src).some((l) => l.startsWith('SETBIT'))).toBe(false);
  });

  it('整词负例：`设置标记xx 0`（关键字后无空白）不误判，落文本行', () => {
    const src = doc('\t设置标记xx 0');
    expect(outLines(src).some((l) => l.startsWith('SETBIT'))).toBe(false);
    expect(outLines(src).some((l) => /^PRINTFORM/.test(l) && l.includes('设置标记xx'))).toBe(true);
  });

  it('整词负例：`置位状態, 0`（不在白名单）不误判，落文本行', () => {
    const src = doc('\t置位状態, 0');
    expect(outLines(src).some((l) => l.startsWith('SETBIT'))).toBe(false);
    expect(outLines(src).some((l) => /^PRINTFORM/.test(l) && l.includes('置位状態'))).toBe(true);
  });
});

/* ============================== 缺逗号 / 空位槽 ============================== */

describe('位糖 · 缺逗号 / 空位槽 → 既有 `unknown-identifier`（error），不产半成品', () => {
  it('`设置标记 TFLAG:193`（缺逗号）报 error，且无 `SETBIT` 行', () => {
    const src = doc('\t设置标记 TFLAG:193');
    expect(codes(src)).toContain('unknown-identifier');
    expect(errs(src).length).toBeGreaterThan(0);
    expect(outLines(src).some((l) => l.startsWith('SETBIT'))).toBe(false);
  });

  it('`清除标记 TFLAG:193,`（空位槽）同样报 error、不产 `CLEARBIT`', () => {
    const src = doc('\t清除标记 TFLAG:193,');
    expect(codes(src)).toContain('unknown-identifier');
    expect(outLines(src).some((l) => l.startsWith('CLEARBIT'))).toBe(false);
  });
});
