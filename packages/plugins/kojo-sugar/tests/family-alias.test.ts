/**
 * D2 批 · 家族头中文别名（`现在` / `时标` / `标记` / `随机` → `NOWEX` / `TFLAG` / `FLAG` / `RAND`）。
 *
 * 三件事：
 * 1. **写侧**：糖表达式 / 段条件里的中文族头 → 引擎族头（走 `lowerExpression` **唯一管线**，
 *    与 `如果` / `当` / 行内条件同源）；
 * 2. **投影侧**：原生 ERB 里的引擎族头 → 糖面中文族头（段头 / 表达式 / 插值三处，复用既有
 *    反向渲染位置，不新造第二张表）；
 * 3. **`随机` 三义消歧**（本批最险）：块头仍走随机块、表达式位降 `RAND`、文件头 `随机形:` 不误伤。
 *
 * 装配不依赖游戏盘：别名表 = adapter **真表**（`@kojo/plugin-eratw-adapter` 导出，
 * 零漂移——测试侧镜像手抄正是 PITFALLS 点名的"形状不同构 ⇒ 空断言"隐患），其余仍用
 * `support.ts` 的桩。**每条正向断言都配负自证**——改一个字符 / 少写冒号必须被抓出。
 */

import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement, SugarDiagnostic } from '@kojo/plugin-api';
import { FAMILY_ALIASES, FAMILY_ALIASES_REVERSE } from '@kojo/plugin-eratw-adapter';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { createSugarTranspileService } from '../src/service';
import { liftProject } from '../src/project';
import { lowerExpression, type ExprContext } from '../src/expression';
import type { LiftDeps } from '../src/lift';
import type { AliasEntry, DictionaryLookup } from '../src/types';
import { stubDict, stubFaceTable } from './support';

/* ================================ 装配夹具 ================================ */

/** 带家族头中文别名的字典：别名表 = adapter 真表（零漂移）；其余沿用 support 桩 */
const aliasDict = (): DictionaryLookup => ({
  ...stubDict,
  familyAlias: (name: string) => FAMILY_ALIASES[name],
  familyAliasReverse: (family: string) => FAMILY_ALIASES_REVERSE[family.toUpperCase()],
});

const svc = () => createSugarTranspileService({ dictionary: aliasDict(), faceTable: stubFaceTable() });
const errsOf = (src: string): SugarDiagnostic[] =>
  svc().transpile(src).diagnostics.filter((d) => d.severity === 'error');
const codesOf = (src: string): string[] => errsOf(src).map((d) => d.code);
const productOf = (src: string): string => svc().transpile(src).erb;

const doc = (body: string): string => `角色: 12\n时机 绝顶：\n${body}\n`;

function bodyOf(erb: string, fn = '@M_KOJO_MESSAGE_PALAMCNG_B_K12_1'): string[] {
  const ls = erb.replace(/\r\n/g, '\n').split('\n');
  const start = ls.findIndex((l) => l.trim() === fn);
  if (start < 0) throw new Error(`产物里没有 ${fn}：\n${erb}`);
  return ls.slice(start).filter((l) => l.trim().length > 0);
}

const projectDeps = (): LiftDeps => ({
  transpile: () => {
    throw new Error('投影不应调用 transpile');
  },
  scanControlFlow: (t: string): ControlFlowStatement[] => scanControlFlow(t),
  faceTable: () => stubFaceTable(),
  dictionary: () => aliasDict(),
});
const segText = (source: string): string[] =>
  liftProject(projectDeps(), { source }).segments.map((s) => s.sugarText);

const exprCtx = (aliases = new Map<string, AliasEntry>()): ExprContext => ({
  aliases,
  dictionary: aliasDict(),
  report: () => {},
  loc: null,
});

/* ============================================================================ */
/* A. 写侧 · lowerExpression 唯一管线（四族 + 同源 + 防护）                          */
/* ============================================================================ */

describe('D2 写侧 · lowerExpression 家族头别名（唯一管线）', () => {
  it('正例：半角 / 全角冒号四族别名 → 引擎族头', () => {
    expect(lowerExpression('现在:噴乳', exprCtx())).toBe('NOWEX:噴乳');
    expect(lowerExpression('现在：噴乳', exprCtx())).toBe('NOWEX:噴乳'); // 全角冒号归一为半角
    expect(lowerExpression('时标:192 == 0', exprCtx())).toBe('TFLAG:192 == 0');
    expect(lowerExpression('标记:1', exprCtx())).toBe('FLAG:1');
    expect(lowerExpression('随机:2', exprCtx())).toBe('RAND:2');
  });

  it('同源：逻辑否定 `非`（走既有运算符管线）照样命中别名', () => {
    expect(lowerExpression('非 现在：噴乳', exprCtx())).toBe('! NOWEX:噴乳');
  });

  it('防护①：不跟冒号一律不碰（`获取标记(` / 裸词 `标记`）', () => {
    // 系统函数名降糖在前 ⇒ `获取标记(` 此时已是 `GETBIT(`，别名步看不到 `标记`
    expect(lowerExpression('获取标记(1)', exprCtx())).toBe('GETBIT(1)');
    expect(lowerExpression('标记', exprCtx())).toBe('标记');
  });

  it('防护②：作者同名别名优先 ⇒ 不替换（`别名 现在 = …`）', () => {
    const aliases = new Map<string, AliasEntry>([
      ['现在', { value: { kind: 'number', text: '0' }, readonly: true, line: 1 }],
    ]);
    expect(lowerExpression('现在：噴乳', exprCtx(aliases))).not.toContain('NOWEX');
  });

  it('防护③：字符串字面量内不碰', () => {
    expect(lowerExpression('"现在：噴乳"', exprCtx())).toBe('"现在：噴乳"');
  });

  it('防护④：`Object.prototype` 成员名（`constructor:`）不替换（未登记 ⇒ 不猜，绝不吐函数源码）', () => {
    expect(lowerExpression('constructor:5', exprCtx())).toBe('constructor:5');
    expect(lowerExpression('hasOwnProperty:5', exprCtx())).toBe('hasOwnProperty:5');
  });
});

/* ============================================================================ */
/* B. 写侧 · 段产物（`若` 段条件同源）                                             */
/* ============================================================================ */

describe('D2 写侧 · 段条件族头中文化', () => {
  it('`若 现在：噴乳：` ⇒ `LOCAL = 1` + `IF LOCAL && NOWEX:噴乳`', () => {
    const src = doc('\t若 现在：噴乳：\n\t\t「甲」\n');
    expect(errsOf(src)).toEqual([]);
    const lines = bodyOf(productOf(src));
    expect(lines).toContain('LOCAL = 1');
    expect(lines).toContain('IF LOCAL && NOWEX:噴乳');
  });

  it('`若 非 现在：噴乳：` ⇒ `LOCAL = 1` + `IF LOCAL && ! NOWEX:噴乳`', () => {
    const src = doc('\t若 非 现在：噴乳：\n\t\t「甲」\n');
    expect(errsOf(src)).toEqual([]);
    expect(bodyOf(productOf(src))).toContain('IF LOCAL && ! NOWEX:噴乳');
  });

  it('负自证：段条件里少写冒号 ⇒ **不替换** + 报 `unknown-identifier`', () => {
    const src = doc('\t若 现在噴乳：\n\t\t「甲」\n');
    expect(codesOf(src)).toContain('unknown-identifier');
    expect(productOf(src)).not.toContain('NOWEX'); // 没被前缀式误替换
  });
});

/* ============================================================================ */
/* C. 写侧 · 四条别名各自的负自证（少写冒号即不成立、必须被抓）                        */
/* ============================================================================ */

describe('D2 写侧 · 四族别名的负自证（改一个字 / 少写冒号 ⇒ 必须被抓）', () => {
  const neg = (cond: string, engineHead: string) => {
    const src = doc(`\t若 ${cond}：\n\t\t「甲」\n`);
    expect(codesOf(src)).toContain('unknown-identifier');
    expect(productOf(src)).not.toContain(engineHead);
  };

  it('现在：少写冒号 ⇒ `现在噴乳` 为整词 ⇒ unknown-identifier（非 NOWEX）', () => {
    neg('现在噴乳', 'NOWEX');
  });
  it('时标：少写冒号 ⇒ `时标192` 为整词 ⇒ unknown-identifier（非 TFLAG）', () => {
    neg('时标192 == 0', 'TFLAG');
  });
  it('标记：少写冒号 ⇒ `标记1` 为整词 ⇒ unknown-identifier（非 FLAG）', () => {
    neg('标记1', 'FLAG');
  });
  it('随机：少写冒号 ⇒ `随机2` 为整词 ⇒ unknown-identifier（非 RAND）', () => {
    neg('随机2 == 3', 'RAND');
  });

  it('负自证：改一个字符（`现在`→`現栽`）不再是登记别名 ⇒ 不产 `NOWEX`', () => {
    const src = doc('\t若 現栽：噴乳：\n\t\t「甲」\n');
    // 未登记的族头不替换（不猜）；且其兜底诊断（unknown-identifier）必须出现
    expect(codesOf(src)).toContain('unknown-identifier');
    expect(productOf(src)).not.toContain('NOWEX');
  });
});

/* ============================================================================ */
/* D. 写侧 · `随机` 三义消歧（本批最险）                                           */
/* ============================================================================ */

describe('D2 `随机` 消歧 · 块头 / 表达式位 / 文件头', () => {
  it('① 块头 `随机：` 仍走随机块（绝不被降成 RAND 常量）', () => {
    const src = '角色: 12\n时机 指令 310：\n    随机：\n        「甲。」\n        「乙。」\n';
    expect(codesOf(src)).toEqual([]);
    const erb = productOf(src);
    expect(erb).toContain('LOCAL = RAND:2'); // 随机块产物（LOCAL 槽 + RAND:n）
    expect(erb).toContain('SELECTCASE LOCAL');
  });

  it('② 表达式位 `当 随机:2：` ⇒ `当 RAND:2：`（族头别名降糖生效）', () => {
    const src =
      '角色: 12\n时机 指令 310：\n    当 随机:2：\n        是 0：\n            「甲。」\n        是 1：\n            「乙。」\n';
    expect(codesOf(src)).toEqual([]);
    expect(productOf(src)).toContain('SELECTCASE RAND:2');
  });

  it('③ 文件头 `随机形: 直出` 不被误伤（lexer 先判，直出形照旧）', () => {
    const src = '角色: 12\n随机形: 直出\n时机 指令 310：\n    随机：\n        「甲。」\n        「乙。」\n';
    expect(codesOf(src)).toEqual([]);
    const erb = productOf(src);
    expect(erb).toContain('SELECTCASE RAND:2'); // 直出形
    expect(erb).not.toContain('LOCAL = RAND:2'); // 不占 LOCAL 槽（文件头未被别名步吞掉）
  });
});

/* ============================================================================ */
/* E. 投影侧 · 引擎族头 → 中文族头（段头 / 表达式 / 插值）                          */
/* ============================================================================ */

describe('D2 投影侧 · 族头中文化', () => {
  const threeEnabled = [
    '@M_KOJO_MESSAGE_PALAMCNG_B_K12',
    'LOCAL = 1',
    'IF LOCAL && NOWEX:噴乳',
    '\tPRINTFORMW 「甲」',
    'ENDIF',
    'LOCAL = 1',
    'IF LOCAL && TFLAG:193',
    '\tPRINTFORMW 「乙」',
    'ENDIF',
    'RETURN 1',
  ].join('\n');

  it('段头：`IF LOCAL && NOWEX:噴乳` → `若 现在：噴乳：`（全角冒号）', () => {
    const text = segText(threeEnabled).join('\n');
    expect(text).toContain('若 现在：噴乳：');
    expect(text).toContain('若 时标：193：');
  });

  it('插值 `{…}` / `%…%` 内的已登记族头 → 中文（复用 reverseAttributes 位置）', () => {
    const src = ['@M_KOJO_MESSAGE_PALAMCNG_B_K12_1', 'PRINTFORMW 「{NOWEX:噴乳}」', 'RETURN 1'].join('\n');
    const text = segText(src).join('\n');
    expect(text).toContain('「{现在：噴乳}」');
  });

  it('反例：adapter 未登记的族头（`CFLAG`）**不被**中文化', () => {
    const src = ['@M_KOJO_MESSAGE_PALAMCNG_B_K12_1', 'PRINTFORMW 「{CFLAG:2}」', 'RETURN 1'].join('\n');
    expect(segText(src).join('\n')).toContain('{CFLAG:2}');
  });

  it('闭环：段头投影产物原样喂回转译器 ⇒ 零 error，且折回原信封段', () => {
    const text = segText(threeEnabled).join('\n');
    expect(errsOf(text)).toEqual([]);
    const erb = productOf(text);
    expect(erb).toContain('IF LOCAL && NOWEX:噴乳');
    expect(erb).toContain('IF LOCAL && TFLAG:193');
  });
});
