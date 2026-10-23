import { describe, expect, it } from 'vitest';
import {
  ERB_UNDEFINED_NAME,
  collectUndefinedNameDiagnostics,
  type UndefinedNameDiagnosticsInput,
} from '../src/undefined-name';

/**
 * ERB 未定义名诊断（S8）单测。
 *
 * 两路都钉死：真阳性（表达式 / 赋值里的未声明变量与标志）与 **≥ 6 类假阳性**
 * （字符串、注释、数字、函数名、关键字、成员访问、通配展开、调用/跳转行、定义行、
 * SKIP 区、散文行、未知语句行、冒号链赋值）。另有作用域（#DIM / 形参）与
 * did-you-mean 候选的接线测试。
 */
const collect = (
  text: string,
  extra: Partial<Omit<UndefinedNameDiagnosticsInput, 'text'>> = {},
): ReturnType<typeof collectUndefinedNameDiagnostics> => collectUndefinedNameDiagnostics({ text, ...extra });

describe('collectUndefinedNameDiagnostics · 真阳性', () => {
  it('IF 条件里的未声明变量：warning + 中文消息 + 1 基列区间 + 稳定诊断码', () => {
    expect(collect('IF UNDEFINED_VAR > 0')).toEqual([
      {
        line: 1,
        severity: 'warning',
        message: '未定义的名称「UNDEFINED_VAR」：不在已知声明（#DIM / 局部 / 内置 / 引擎全局）中。',
        startColumn: 4,
        endColumn: 17,
        code: ERB_UNDEFINED_NAME,
        name: 'UNDEFINED_VAR',
        suggestions: [],
      },
    ]);
    expect(ERB_UNDEFINED_NAME).toBe('ERB_UNDEFINED_NAME');
  });

  it('写位置视为隐式声明；只报右侧与条件里的读', () => {
    expect(collect('UNDEFINED_VAR = 1')).toEqual([]);
    expect(collect('UNDEFINED_VAR += 1')).toEqual([]);
    expect(collect('UNDEFINED_ARR[0] = 1')).toEqual([]);
    expect(collect('A = 0\nIF A > 0')).toEqual([]);
    expect(collect('LOCAL = UNDEFINED_VAR + 1').map((d) => [d.name, d.startColumn, d.endColumn])).toEqual([
      ['UNDEFINED_VAR', 9, 22],
    ]);
  });

  it('循环条件 / RETURN 表达式 / CJK 名字照报', () => {
    expect(collect('WHILE UNDEFINED_COND > 0').map((d) => [d.name, d.startColumn, d.endColumn])).toEqual([
      ['UNDEFINED_COND', 7, 21],
    ]);
    expect(collect('RETURN UNDEFINED_RESULT').map((d) => d.name)).toEqual(['UNDEFINED_RESULT']);
    expect(collect('IF 未定義変数 == 1').map((d) => [d.name, d.startColumn, d.endColumn])).toEqual([
      ['未定義変数', 4, 9],
    ]);
    // 取模不是 `%...%` 展开形：两侧单 `%` 不该放过
    expect(collect('IF MONEY%UNDEFINED_MOD == 0').map((d) => d.name)).toEqual(['UNDEFINED_MOD']);
  });

  it('#DIM 声明与函数形参都算已知（含旧式数组声明归一）', () => {
    expect(collect('#DIM KNOWN_VAR\nIF KNOWN_VAR > 0')).toEqual([]);
    expect(collect('#DIM ARR[10]\nIF ARR[0] > 0')).toEqual([]);
    expect(collect('@F(PARAM_X)\nIF PARAM_X > 0')).toEqual([]);
  });

  it('四类外部已知名（dim / local / builtin / engine global / known）都能压掉误报', () => {
    expect(collect('IF GAME_GLOBAL > 0', { engineGlobalNames: ['GAME_GLOBAL'] })).toEqual([]);
    expect(collect('IF INJECTED_DIM > 0', { dimNames: ['INJECTED_DIM'] })).toEqual([]);
    expect(collect('IF INJECTED_LOCAL > 0', { localNames: ['INJECTED_LOCAL'] })).toEqual([]);
    expect(collect('IF INJECTED_BUILTIN > 0', { builtinNames: ['INJECTED_BUILTIN'] })).toEqual([]);
    expect(collect('IF INJECTED_KNOWN > 0', { knownNames: ['INJECTED_KNOWN'] })).toEqual([]);
  });

  it('形参作用域按函数隔离：别的函数里的同名形参不算本函数已知', () => {
    const text = '@A(P1)\nIF P1 > 0\n@B\nIF P1 > 0';
    expect(collect(text)).toEqual([
      {
        line: 4,
        severity: 'warning',
        message: '未定义的名称「P1」：不在已知声明（#DIM / 局部 / 内置 / 引擎全局）中。',
        startColumn: 4,
        endColumn: 6,
        code: ERB_UNDEFINED_NAME,
        name: 'P1',
        suggestions: [],
      },
    ]);
  });

  it('did-you-mean：编辑距离 ≤ 2 给候选并写进消息', () => {
    const [diag] = collect('#DIM DECLARED\nIF DECLARD > 0');
    expect(diag?.name).toBe('DECLARD');
    expect(diag?.suggestions).toEqual(['DECLARED']);
    expect(diag?.message).toContain('「DECLARED」');
  });

  it('确定性：同一输入调用两次逐字段相等', () => {
    const text = '#DIM DECLARED\nIF DECLARD > 0\nIF ALSO_UNDEFINED == DECLARD';
    expect(collect(text)).toEqual(collect(text));
  });
});

describe('collectUndefinedNameDiagnostics · 假阳性（一条都不许报）', () => {
  it('字符串内容与注释尾巴', () => {
    expect(collect('IF MONEY == "UNDEFINED_IN_STRING"')).toEqual([]);
    expect(collect('MONEY = 1 ; UNDEFINED_IN_COMMENT')).toEqual([]);
    expect(collect('; IF UNDEFINED_IN_COMMENT > 0')).toEqual([]);
  });

  it('数字字面量', () => {
    expect(collect('IF 123 == 456')).toEqual([]);
    expect(collect('MONEY = 12345')).toEqual([]);
  });

  it('函数调用形（记号后紧跟 `(`，允许名字与括号之间有空白）', () => {
    expect(collect('IF SOME_FUNC(1) > 0')).toEqual([]);
    expect(collect('IF FINDELEMENT (LOCAL, ARG:0) == 0')).toEqual([]);
    expect(collect('MONEY = RAND(10) + NO(ARG)')).toEqual([]);
  });

  it('ERB 关键字 / 字面量 / 词运算符 / 引擎通用标量', () => {
    expect(collect('IF MONEY == NULL AND TRUE')).toEqual([]);
    expect(collect('WHILE LOCAL || GLOBAL || FALSE')).toEqual([]);
    expect(collect('CASE ELSE\nCASE IS < 5\nCASE 1 TO 3')).toEqual([]);
    expect(collect('IF CHARANUM > 0 && NAME == CALLNAME')).toEqual([]);
  });

  it('FOR 循环变量是语法声明位（语料常不写 #DIM）', () => {
    expect(collect('FOR LOOP_I, 0, 10\nIF LOOP_I > 0')).toEqual([]);
  });

  it('字符串型赋值右侧的无引号文本（#DIMS / LOCALS / RESULTS / 外部 stringNames）', () => {
    expect(collect('#DIMS CNAME\nCNAME = 你这家伙')).toEqual([]);
    expect(collect('#DIMS AA, 0\nAA:05 = ┃森林三┃')).toEqual([]);
    expect(collect('LOCALS = 今日は晴れ')).toEqual([]);
    expect(collect('RESULTS:0 = 今日の天気')).toEqual([]);
    expect(collect('CNAME2 = 未定義文字列', { stringNames: ['CNAME2'] })).toEqual([]);
  });

  it('成员访问 / 变量族索引链（紧邻半/全角冒号）', () => {
    expect(collect('IF CFLAG:TARGET:100 > 0')).toEqual([]);
    expect(collect('CFLAG:ARG:UNDEFINED = 1')).toEqual([]);
    expect(collect('IF TCVAR:K17C_ID:中止接吻 == 0')).toEqual([]);
  });

  it('通配 / 展开形（成对 `%`）、`￥` 具名索引、`[[…]]` 与名字内符号', () => {
    expect(collect('IF MONEY == %EXPANDED%')).toEqual([]);
    expect(collect('IF FLAG:￥人気 >= 300')).toEqual([]);
    expect(collect('IF [[霊夢]] == NAME')).toEqual([]);
    expect(collect('IF TALENT:ARG:幼児／幼児退行')).toEqual([]);
    expect(collect('IF MONEY < 増加_２０％')).toEqual([]);
  });

  it('CASE 值的无引号文本（含非 ASCII）不猜', () => {
    expect(collect('CASE P512魔理沙宅・寝室, P521人偶洋館・愛麗絲的房間')).toEqual([]);
  });

  it('CALL / JUMP / GOTO / CALLFORM 等调用与跳转行（整行不扫）', () => {
    expect(collect('CALL NOPE\nJUMP NOPE\nGOTO NOPE\nCALLFORM NOPE\nTRYCALLFORM NOPE')).toEqual([]);
  });

  it('`@` 定义 / `#` 指令 / `$` 标签行', () => {
    expect(collect('@F\n#DIM X\n$LABEL')).toEqual([]);
  });

  it('[SKIPSTART]…[SKIPEND] 死代码段', () => {
    expect(collect('[SKIPSTART]\nIF UNDEFINED > 0\n[SKIPEND]')).toEqual([]);
  });

  it('PRINT 散文行（无引号台词里的词不是变量）', () => {
    expect(collect('PRINTFORML UNDEFINED 今日は晴れ')).toEqual([]);
    expect(collect('PRINTFORM UNDEFINED = 1')).toEqual([]);
  });

  it('未知语句行（VARSET / SETBIT 等不是表达式也不是赋值形）', () => {
    expect(collect('VARSET UNDEFINED, 0\nSETBIT UNDEFINED, 1')).toEqual([]);
  });

  it('空文本与非方言路径（`.kojo` 归糖线管）', () => {
    expect(collect('')).toEqual([]);
    expect(collect('IF UNDEFINED > 0', { path: '/a.kojo' })).toEqual([]);
    expect(collect('IF UNDEFINED > 0', { path: '/a.ERB' }).map((d) => d.name)).toEqual(['UNDEFINED']);
  });
});
