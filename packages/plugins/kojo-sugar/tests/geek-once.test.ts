/**
 * 1 号任务 · 糖位 `初回` = 引擎 `ONCE`。
 *
 * 判据：
 *   ① 块形 `初回 "key"：` → `IF ONCE(<key>)` … `ENDIF`（块体经 `emitBody`，与其它块同口径）；
 *   ② 表达式形 `初回("key")` → `ONCE("key")`；二参形补 `角色:` 编号、三参形原样；
 *   ③ 取反沿用既有表达式层口径（`非 初回(...)` / `!初回(...)`）；
 *   ④ 缺 key / 空块 → 复用 `block-empty` + **整块不产**（不拼半成品）；
 *   ⑤ 尊重字符串字面量与括号配对；`初回` 只在词首 + 后随 `(` 时触发。
 *
 * 装配不依赖游戏盘（字典 / 分野表用 `support.ts` 的桩）；编号由 adapter 口径的
 * `角色:` 头提供，糖里零硬编码。**每条正向断言都配负自证**——防断言空转。
 */

import { describe, expect, it } from 'vitest';
import type { SugarDiagnostic } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { lowerExpression, type ExprContext } from '../src/expression';
import { stubDict, stubFaceTable } from './support';

/* ================================ 装配夹具 ================================ */

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
const errsOf = (src: string): SugarDiagnostic[] =>
  svc().transpile(src).diagnostics.filter((d) => d.severity === 'error');
const codesOf = (src: string): string[] => errsOf(src).map((d) => d.code);
const productOf = (src: string): string => svc().transpile(src).erb;

/** 正文落在 `时机 绝顶：` 的函数体内（stub 表 → `@M_KOJO_MESSAGE_PALAMCNG_B_K12_1`） */
const doc = (body: string): string => `角色: 12\n时机 绝顶：\n${body}\n`;

/** 取产物里**正文函数**那一段（`@…_1` 头起），滤掉空行 */
function bodyOf(erb: string, fn = '@M_KOJO_MESSAGE_PALAMCNG_B_K12_1'): string[] {
  const ls = erb.replace(/\r\n/g, '\n').split('\n');
  const start = ls.findIndex((l) => l.trim() === fn);
  if (start < 0) throw new Error(`产物里没有 ${fn}：\n${erb}`);
  return ls.slice(start).filter((l) => l.trim().length > 0);
}

/** 最小降糖上下文（`charNo` 可选；别名空表 + support 的字典桩） */
function ctxOf(charNo?: string): { ctx: ExprContext; diags: SugarDiagnostic[] } {
  const diags: SugarDiagnostic[] = [];
  const ctx: ExprContext = {
    aliases: new Map(),
    dictionary: stubDict,
    report: (d) => diags.push(d),
    loc: null,
    ...(charNo !== undefined ? { charNo } : {}),
  };
  return { ctx, diags };
}

/* ============================================================================ */
/* A. 块形：`初回 "key"：` → `IF ONCE(<key>)` … `ENDIF`                            */
/* ============================================================================ */

describe('1 号-A · `初回` 块形产物逐字', () => {
  it('一参：`初回 "KEY"：` → `IF ONCE("KEY")` 信封 + 块体 + `ENDIF`', () => {
    const src = doc('\t初回 "MarisaFirstSeen"：\n\t\t「第一次见面呢。」\n');
    expect(errsOf(src)).toEqual([]);
    expect(bodyOf(productOf(src))).toEqual([
      '@M_KOJO_MESSAGE_PALAMCNG_B_K12_1',
      ';-------------------------------------------------',
      ';記入チェック（=0, 非表示、1, 表示）',
      'LOCAL = 1',
      ';-------------------------------------------------',
      'IF LOCAL',
      '\tIF ONCE("MarisaFirstSeen")',
      '\t\tPRINTFORMW 「第一次见面呢。」',
      '\tENDIF',
      'ENDIF',
      'RETURN 1',
    ]);
  });

  it('二参形补 `角色:` 编号（adapter 口径；doc 的 `角色: 12` → 第三参 12）', () => {
    const src = doc('\t初回 "KEY", 1：\n\t\t「甲」\n');
    expect(errsOf(src)).toEqual([]);
    expect(productOf(src)).toContain('IF ONCE("KEY",1,12)');
  });

  it('三参形原样（作者已显式给角色号，不覆盖）', () => {
    const src = doc('\t初回 "KEY", 1, 11：\n\t\t「甲」\n');
    expect(errsOf(src)).toEqual([]);
    expect(productOf(src)).toContain('IF ONCE("KEY",1,11)');
    expect(productOf(src)).not.toContain('ONCE("KEY",1,12)');
  });

  it('负自证：去掉 `初回` 关键字 ⇒ 块头不成立，缩进正文立刻报红（不是静默少一层）', () => {
    const broken = doc('\t"KEY"：\n\t\t「甲」\n');
    expect(codesOf(broken)).toContain('indent-mismatch');
  });
});

describe('1 号-A · fail-closed：缺 key / 空块一律不产半成品', () => {
  it('空块（块头后无更深缩进）→ `block-empty`，且**零 ONCE 字节**', () => {
    const src = doc('\t初回 "KEY"：\n');
    expect(codesOf(src)).toContain('block-empty');
    expect(productOf(src)).not.toContain('ONCE');
  });

  it('缺 key（`初回：`）→ 复用 `block-empty`，且**零 ONCE 字节**', () => {
    const src = doc('\t初回：\n\t\t「甲」\n');
    expect(codesOf(src)).toContain('block-empty');
    expect(productOf(src)).not.toContain('ONCE');
  });

  it('负自证：正常块头不会误报 `block-empty`（判据没被放宽成空转）', () => {
    expect(codesOf(doc('\t初回 "KEY"：\n\t\t「甲」\n'))).not.toContain('block-empty');
  });
});

describe('1 号-A · 块体经 `emitBody`（块内 run / 嵌套同源）', () => {
  it('块内 `你：` 自机台词照发 SETCOLOR run（块体不是逐字直贴）', () => {
    const src = doc('\t初回 "KEY"：\n\t\t你：我说。\n\t\t「角色说。」\n');
    const p = productOf(src);
    expect(p).toContain('IF ONCE("KEY")');
    expect(p).toContain('SETCOLOR'); // 自机色 run 起点
    expect(p).toContain('PRINTFORMW 我说。');
    expect(p).toContain('RESETCOLOR'); // run 收尾复原
    // run 必须在 ONCE 信封**内部**（次序证明，不是块外乱发色）
    expect(p.indexOf('SETCOLOR')).toBeGreaterThan(p.indexOf('IF ONCE("KEY")'));
  });

  it('嵌在 `如果` 块体里也站得住（`初回` 是普通块，可任意嵌套）', () => {
    const src = doc('\t如果 TFLAG:193：\n\t\t初回 "KEY"：\n\t\t\t「甲」\n');
    expect(errsOf(src)).toEqual([]);
    const p = productOf(src);
    expect(p).toContain('IF TFLAG:193');
    expect(p).toContain('IF ONCE("KEY")');
  });

  it('与普通语句混排**不**触发 `section-mixed`（`初回` 不是 `段`，不走逐段信封）', () => {
    const src = doc('\t初回 "KEY"：\n\t\t「甲」\n\t「乙」\n');
    expect(codesOf(src)).not.toContain('section-mixed');
    expect(errsOf(src)).toEqual([]);
  });

  it('函数体内也站得住（`初回` 块里 `返回`，文法与 `时机` 体同口径）', () => {
    const src = '角色: 12\n函数 检查(次数)：\n\t初回 "KEY"：\n\t\t返回 次数\n';
    expect(errsOf(src)).toEqual([]);
    const erb = productOf(src);
    expect(erb).toContain('@M_KOJO_K12_检查(ARG)');
    expect(erb).toContain('IF ONCE("KEY")');
    expect(erb).toContain('RETURNF ARG');
  });
});

/* ============================================================================ */
/* B. 表达式形：`初回(...)` → `ONCE(...)`                                       */
/* ============================================================================ */

describe('1 号-B · `初回(...)` 表达式降糖（单元口径）', () => {
  it('一参 / 二参（有 charNo 补、无则不补）/ 三参原样', () => {
    expect(lowerExpression('初回("k")', ctxOf('12').ctx)).toBe('ONCE("k")');
    expect(lowerExpression('初回("k", 1)', ctxOf().ctx)).toBe('ONCE("k",1)');
    expect(lowerExpression('初回("k", 1)', ctxOf('12').ctx)).toBe('ONCE("k",1,12)');
    expect(lowerExpression('初回("k", 1, 11)', ctxOf('12').ctx)).toBe('ONCE("k",1,11)');
  });

  it('顶层逗号规整为无空格半角 `,`；括号内的逗号不拆参', () => {
    expect(lowerExpression('初回("k" ,  1)', ctxOf().ctx)).toBe('ONCE("k",1)');
    // 参数里的 `(`…`,`…`)` 属同一实参（深度 > 0 不拆），后续系统函数名照降
    expect(lowerExpression('初回(分组匹配(1, 2))', ctxOf().ctx)).toBe('ONCE(GROUPMATCH(1, 2))');
  });

  it('取反沿用既有表达式层口径（`非` / `!`）', () => {
    expect(lowerExpression('非 初回("k")', ctxOf().ctx)).toBe('! ONCE("k")');
    expect(lowerExpression('!初回("k")', ctxOf().ctx)).toBe('!ONCE("k")');
  });

  it('负自证：字符串字面量里的 `初回(` 不被误换', () => {
    expect(lowerExpression('"初回(不是调用)"', ctxOf().ctx)).toBe('"初回(不是调用)"');
  });

  it('负自证：`初回` 作为更大标识符的一部分（前面粘标识符字符）不触发', () => {
    // `待初回(` 里 `待初回` 是一个标识符 ⇒ 不重写成 `待ONCE(`（原样透传）
    const { ctx } = ctxOf();
    expect(lowerExpression('待初回("k")', ctx)).toBe('待初回("k")');
  });

  it('零参 `初回()` → 复用 `block-empty`（不静默）', () => {
    const { ctx, diags } = ctxOf();
    expect(lowerExpression('初回()', ctx)).toBe('ONCE()');
    expect(diags.map((d) => d.code)).toContain('block-empty');
  });
});

describe('1 号-B · 表达式形落在真实语句里', () => {
  it('`如果 初回("KEY")：` 的条件降为 `ONCE("KEY")`', () => {
    const src = doc('\t如果 初回("MarisaEventsSeen")：\n\t\t「甲」\n');
    expect(errsOf(src)).toEqual([]);
    expect(productOf(src)).toContain('IF ONCE("MarisaEventsSeen")');
  });

  it('`如果 初回("KEY", 1)：` 条件补角色号', () => {
    const src = doc('\t如果 初回("KEY", 1)：\n\t\t「甲」\n');
    expect(productOf(src)).toContain('IF ONCE("KEY",1,12)');
  });

  it('`如果 !初回("KEY")：` 取反条件', () => {
    const src = doc('\t如果 !初回("KEY")：\n\t\t「甲」\n');
    expect(errsOf(src)).toEqual([]);
    expect(productOf(src)).toContain('IF !ONCE("KEY")');
  });
});
