/**
 * 「一次扫描、四家共用」的等价性守门（2026-10-28 批）。
 *
 * `collectErbSemanticDiagnostics` 一轮里四家消费方（实参个数 / 内建实参 / 未定义名的
 * 赋值目标趟与主扫描趟）此前**各扫一遍**整篇可见行。改成先 `splitErbLines` 切一次、
 * `visibleCodeLineList` 摊平一份、四家共用之后，本文件钉住两件事：
 *
 * 1. **判据逐字不变**：同一份文本，传不传共用产物，三家各自的结果必须深度相等；
 * 2. **预筛不改结论**：`arity` / `builtins` 新加的「非 CALL 行且原文无 `(` ⇒ 跳过」
 *    只在**不可能有调用点**的行上生效——带括号的表达式位、字符串里的假括号、
 *    `CALL` 的省略形（无括号）都必须照旧。
 */
import { describe, expect, it } from 'vitest';
import type { ErbParam } from '@kojo/plugin-api';
import { collectArityDiagnostics } from '../src/arity';
import { collectBuiltinArgDiagnostics } from '../src/builtins';
import { splitErbLines, visibleCodeLineList, visibleCodeLines } from '../src/references';
import { parseErbText } from '../src/scanner';
import { collectUndefinedNameDiagnostics } from '../src/undefined-name';

const FIXTURE = [
  '; 文件头注释 FOOBAR(1,2,3)',
  '#DIM COUNTER, 10',
  '#DIMS NAME',
  '@FUNC_A(ARG, ARG:1)',
  'PRINT "FOO(1,2,3)"  ; 串里的括号不是调用点',
  'CALL FOO, 1, 2, 3',
  'CALL BAR',
  'CALL BAZ(1)',
  'COUNTER = 1',
  'X = QUX(1, 2)',
  'FOR I, 0, 3',
  'NEXT',
  '[SKIPSTART]',
  'CALL HIDDEN, 1, 2, 3',
  '[SKIPEND]',
  '$LABEL',
  'RETURN',
].join('\n');

const p = (name: string, hasDefault = false): ErbParam => ({ name, hasDefault });
const catalog = (name: string) => {
  if (name === 'FOO') return [p('ARG')];
  if (name === 'BAR') return [p('ARG'), p('ARG:1')];
  if (name === 'QUX') return [p('ARG', true)];
  return null;
};

const ARITY_INPUT = { path: 'A.ERB', text: FIXTURE, catalog } as const;

describe('共用扫描产物 · 等价性', () => {
  it('摊平的可见行与逐个生成的可见行逐字段相同', () => {
    const shared = visibleCodeLineList(splitErbLines(FIXTURE));
    const fresh = [...visibleCodeLines(FIXTURE)];
    expect(shared.length).toBe(fresh.length);
    for (let i = 0; i < shared.length; i++) {
      const a = shared[i]!;
      const b = fresh[i]!;
      expect({ line: a.line, raw: a.raw, def: a.isDefinition, call: a.isCallLine, kw: a.keywordEnd }).toEqual({
        line: b.line,
        raw: b.raw,
        def: b.isDefinition,
        call: b.isCallLine,
        kw: b.keywordEnd,
      });
      // codeView 是惰性方法：两侧各自算一遍也必须逐字相同（保长刷白）
      expect(a.codeView()).toBe(b.codeView());
    }
  });

  it('预切行与就地切行解析出同一份 ErbFile', () => {
    const a = parseErbText(FIXTURE, 'A.ERB');
    const b = parseErbText(FIXTURE, 'A.ERB', splitErbLines(FIXTURE));
    expect(b).toEqual(a);
  });

  it('实参个数：传共用产物与不传，结果深度相等', () => {
    const fresh = collectArityDiagnostics(ARITY_INPUT);
    const shared = collectArityDiagnostics({
      ...ARITY_INPUT,
      visible: visibleCodeLineList(splitErbLines(FIXTURE)),
    });
    expect(shared).toEqual(fresh);
    // 夹具本身要真出诊断，否则上面那句"相等"没有证明力
    expect(fresh.length).toBeGreaterThan(0);
    // 串里的 `FOO(1,2,3)` 不算调用点；`[SKIPSTART]` 区里的 CALL 不算；`CALL BAR` 省略形算
    expect(fresh.some((d) => d.line === 5)).toBe(false);
    expect(fresh.some((d) => d.line === 14)).toBe(false);
    expect(fresh.some((d) => d.line === 7)).toBe(true);
  });

  it('内建实参：传共用产物与不传，结果深度相等', () => {
    const fresh = collectBuiltinArgDiagnostics({ path: 'A.ERB', text: FIXTURE });
    const shared = collectBuiltinArgDiagnostics({
      path: 'A.ERB',
      text: FIXTURE,
      visible: visibleCodeLineList(splitErbLines(FIXTURE)),
    });
    expect(shared).toEqual(fresh);
  });

  it('未定义名：传共用产物与不传，结果深度相等（两趟重复迭代同一份数组）', () => {
    const fresh = collectUndefinedNameDiagnostics({ text: FIXTURE, path: 'A.ERB', dimNames: [] });
    const shared = collectUndefinedNameDiagnostics({
      text: FIXTURE,
      path: 'A.ERB',
      dimNames: [],
      lines: splitErbLines(FIXTURE),
      visible: visibleCodeLineList(splitErbLines(FIXTURE)),
    });
    expect(shared).toEqual(fresh);
    // `FOR I` 的循环变量与 `COUNTER = 1` / `X = …` 的赋值目标都并入已知集 ⇒ 不报
    expect(fresh.some((d) => d.name === 'I')).toBe(false);
    expect(fresh.some((d) => d.name === 'COUNTER')).toBe(false);
    expect(fresh.some((d) => d.name === 'X')).toBe(false);
  });

  it('预筛只跳过不可能有调用点的行：表达式位与省略形照旧判', () => {
    // 无括号的表达式行、带括号的赋值右侧、字符串里的括号混排
    const text = ['A = 1', 'B = FOO(1, 2, 3)', 'PRINT "BAR(1)"', 'CALL FOO'].join('\n');
    const out = collectArityDiagnostics({ path: 'A.ERB', text, catalog });
    // 第 2 行表达式位多给 ⇒ 报；第 4 行 CALL 省略形少给 ⇒ 报；
    // 第 1 行（无 `(` 无 CALL）与第 3 行（括号只在串里）不报
    expect(out.map((d) => d.line).sort((a, b) => a - b)).toEqual([2, 4]);
  });
});
