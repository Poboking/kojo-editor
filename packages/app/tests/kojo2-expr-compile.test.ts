/**
 * K2-EXPR-PORT · 表达式端口真管线判据（先红后绿）
 *
 * 实测背景：core 传给 `compileExpression` 端口的是**原样中文源切片**（`我` / `恋慕` /
 * `分数 + 1`），恒等透传会把 `%我%` 原样写进 ERB——引擎不认识，是真缺陷。
 *
 * 口径（与 v1 `transpile.test.ts` 与 core golden 逐条对齐）：
 * - 代词按 adapter `domainSymbols.pronouns` 的 `engineRef` 落：`我`→`%CALLNAME:TARGET%`、
 *   `你`→`%CALLNAME:MASTER%`；
 * - 属性（如 `恋慕`）按 core 契约**原样保留**（adapter.ts:207：只参与名解析、不参与 lowering）；
 * - 双引号字符串字面量内部是正文，一个字都不动；
 * - 其它表达式（算术 / 条件 / 声明变量）原样透传，不重复降糖。
 */
import { describe, expect, it } from 'vitest';
import type { DomainSymbols, KojoExprText } from '@kojo/kojo-core';
import { createDomainSymbolExprCompiler, kojo2IdentityCompileExpression } from '../src/ui/kojo2-expr-compile';
import { compileKojoSource } from '@kojo/kojo-core';
import { createEratwEmitBackend, ERATW_GAME_ADAPTER } from '@kojo/plugin-eratw-adapter';

const SPAN: KojoExprText['span'] = {
  start: { line: 1, column: 1 },
  end: { line: 1, column: 2 },
};
const expr = (text: string): KojoExprText => ({ text, span: SPAN });

const ERATW_SYMBOLS: DomainSymbols = {
  pronouns: [
    { role: 'me', pronoun: '我', engineRef: '%CALLNAME:TARGET%', requiresView: true, viewBound: true, family: 'CALLNAME' },
    { role: 'you', pronoun: '你', engineRef: '%CALLNAME:MASTER%', requiresView: false, viewBound: false, family: 'CALLNAME' },
    { role: 'her', pronoun: '她', engineRef: '%CALLNAME:TARGET%', requiresView: true, viewBound: false, family: 'CALLNAME' },
  ],
  attributes: [],
  nameFunctions: [],
  speakers: { kind: 'closed', names: [] },
  unknown: 'error',
};

describe('K2-EXPR-PORT · 域符号表达式编译器（先红判据）', () => {
  it('红：恒等透传把代词原样写进 ERB（缺陷复现）', () => {
    expect(kojo2IdentityCompileExpression(expr('我'))).toBe('我');
    expect(kojo2IdentityCompileExpression(expr('我'))).not.toContain('CALLNAME');
  });

  it('绿：代词按 adapter engineRef 落点', () => {
    const compile = createDomainSymbolExprCompiler(ERATW_SYMBOLS);
    expect(compile(expr('我'))).toBe('%CALLNAME:TARGET%');
    expect(compile(expr('你'))).toBe('%CALLNAME:MASTER%');
    expect(compile(expr('她'))).toBe('%CALLNAME:TARGET%');
  });

  it('字符串字面量内部的字是正文，不替换', () => {
    const compile = createDomainSymbolExprCompiler(ERATW_SYMBOLS);
    expect(compile(expr('"你最近好吗"'))).toBe('"你最近好吗"');
  });

  it('混合表达式：字面量外的代词替换、字面量内不动', () => {
    const compile = createDomainSymbolExprCompiler(ERATW_SYMBOLS);
    expect(compile(expr('我 + "你" + 她'))).toBe('%CALLNAME:TARGET% + "你" + %CALLNAME:TARGET%');
  });

  it('属性与非符号表达式原样透传（不重复降糖）', () => {
    const compile = createDomainSymbolExprCompiler(ERATW_SYMBOLS);
    expect(compile(expr('恋慕'))).toBe('恋慕');
    expect(compile(expr('分数 + 1'))).toBe('分数 + 1');
    expect(compile(expr('分数 >= 1'))).toBe('分数 >= 1');
  });

  it('连续多枚代词各自落点（运算符边界），互不误伤', () => {
    const compile = createDomainSymbolExprCompiler(ERATW_SYMBOLS);
    expect(compile(expr('你 + 我'))).toBe('%CALLNAME:MASTER% + %CALLNAME:TARGET%');
  });

  it('代词黏在标识符里不替换（与 v1 matchPronoun 词边界同源）', () => {
    const compile = createDomainSymbolExprCompiler(ERATW_SYMBOLS);
    expect(compile(expr('你和我'))).toBe('你和我');
  });

  it('无 adapter 符号时退化为恒等透传（fail-open = 不猜）', () => {
    const empty: DomainSymbols = { ...ERATW_SYMBOLS, pronouns: [] };
    const compile = createDomainSymbolExprCompiler(empty);
    expect(compile(expr('我'))).toBe('我');
  });

  it('纯函数：同一输入多次调用逐字相等', () => {
    const compile = createDomainSymbolExprCompiler(ERATW_SYMBOLS);
    expect(compile(expr('我 + 你'))).toBe(compile(expr('我 + 你')));
  });

  it('端到端：真 adapter + 真 core，代词插值落成引擎引用（恒等透传会红）', () => {
    const source = [
      '# 视角 灵梦',
      '# 机 初见',
      '@巡 队伍',
      '    > {我}来了。',
      '> 都结束了。',
    ].join('\n');
    const compileWith = (port: (e: KojoExprText) => string): string => {
      const backend = createEratwEmitBackend({ compileExpression: port, charNo: '12' });
      return compileKojoSource({ source, adapter: ERATW_GAME_ADAPTER, backend }).erb;
    };
    const identity = compileWith(kojo2IdentityCompileExpression);
    const real = compileWith(createDomainSymbolExprCompiler(ERATW_GAME_ADAPTER.domainSymbols));

    // 恒等透传确实把中文代词写进产物（缺陷复现）
    expect(identity).toContain('%我%');
    // 真管线落成引擎引用，且不再留中文代词
    expect(real).toContain('%CALLNAME:TARGET%');
    expect(real).not.toContain('%我%');
  });
});
