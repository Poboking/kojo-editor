import { describe, expect, it } from 'vitest';
import {
  cleanDocBlock,
  DOC_MAX_CHARS,
  parseDimDeclaration,
  parseErbText,
  parseFunctionDefinition,
  parseParams,
  scanControlFlow,
  splitTopLevel,
} from '../src/scanner';

describe('splitTopLevel', () => {
  it('顶层逗号切分，忽略括号/引号内逗号', () => {
    expect(splitTopLevel('A, B, C', ',')).toEqual(['A', ' B', ' C']);
    expect(splitTopLevel('A = FUNC(1, 2), B', ',')).toEqual(['A = FUNC(1, 2)', ' B']);
    expect(splitTopLevel('A = "x,y", B', ',')).toEqual(['A = "x,y"', ' B']);
  });
});

describe('parseParams', () => {
  it('普通参数表', () => {
    const p = parseParams('ARG, ARG:1, ARG:2');
    expect(p.map((x) => x.name)).toEqual(['ARG', 'ARG:1', 'ARG:2']);
    expect(p.every((x) => !x.hasDefault)).toBe(true);
  });

  it('默认值（引用含 = 与空格）', () => {
    const p = parseParams('ARG = -1 ,ARG:1 = 3 ,ARG:2 = 0');
    expect(p.map((x) => x.name)).toEqual(['ARG', 'ARG:1', 'ARG:2']);
    expect(p.every((x) => x.hasDefault)).toBe(true);
  });

  it('字符串默认值含逗号', () => {
    const p = parseParams('A, B = "x, y"');
    expect(p.map((x) => x.name)).toEqual(['A', 'B']);
    expect(p[1]!.hasDefault).toBe(true);
  });

  it('日文参数名（真实 BATTLE.ERB 用法）', () => {
    const p = parseParams('制限時間,DAMAGE');
    expect(p.map((x) => x.name)).toEqual(['制限時間', 'DAMAGE']);
  });

  it('空表', () => {
    expect(parseParams('')).toEqual([]);
    expect(parseParams('   ')).toEqual([]);
  });
});

describe('parseFunctionDefinition', () => {
  it('无参定义', () => {
    expect(parseFunctionDefinition('@M_KOJO_MESSAGE_COUNTER_K1_1')).toEqual({
      name: 'M_KOJO_MESSAGE_COUNTER_K1_1',
      params: [],
      nameOffset: 1,
    });
  });

  it('带参定义', () => {
    const def = parseFunctionDefinition('@MESSAGE_TALK(ARG,ARG:1,ARG:2)');
    expect(def?.name).toBe('MESSAGE_TALK');
    expect(def?.params).toHaveLength(3);
  });

  it('定义行带行内注释', () => {
    const def = parseFunctionDefinition('@CHANGE_CFLAG(変動フラグ,対象,変動数,DISPLAY_TYPE = 2, DESCRIPTION = "") ;custom code, added DISPLAY_TYPE, DESCRIPTION');
    expect(def?.name).toBe('CHANGE_CFLAG');
    expect(def?.params).toHaveLength(5);
    expect(def?.params[4]!.name).toBe('DESCRIPTION');
  });

  it('逗号形定义：名字不带尾逗号、形参表完整（真语料 @IN_ROOM_MEMBER 形态）', () => {
    const def = parseFunctionDefinition('@IN_ROOM_MEMBER, ARGS, ARG, ARGS:1, ARG:1');
    expect(def?.name).toBe('IN_ROOM_MEMBER');
    expect(def?.params.map((p) => p.name)).toEqual(['ARGS', 'ARG', 'ARGS:1', 'ARG:1']);
  });

  it('逗号形定义：形参带默认值与字符串默认', () => {
    const def = parseFunctionDefinition('@PRINTLINE, ARGS, ARGS:1 = "-"');
    expect(def?.name).toBe('PRINTLINE');
    expect(def?.params.map((p) => p.name)).toEqual(['ARGS', 'ARGS:1']);
    expect(def?.params[1]!.hasDefault).toBe(true);
  });

  it('逗号形定义：行内注释不进形参表，字符串里的 ; 不算注释', () => {
    const def = parseFunctionDefinition('@FOO, ARG, ARGS = "a;b" ; 备注');
    expect(def?.name).toBe('FOO');
    expect(def?.params.map((p) => p.name)).toEqual(['ARG', 'ARGS']);
  });

  it('逗号形定义：名字后紧跟逗号（无空格）', () => {
    expect(parseFunctionDefinition('@FOO,ARG')?.name).toBe('FOO');
  });

  it('$ 标签不是 @，null', () => {
    expect(parseFunctionDefinition('$LABEL')).toBeNull();
    expect(parseFunctionDefinition('PRINTL foo')).toBeNull();
  });
});

describe('parseDimDeclaration', () => {
  it('基础 #DIM', () => {
    expect(parseDimDeclaration('#DIM 喘ぎ強度')).toEqual({ directive: 'DIM', name: '喘ぎ強度' });
  });

  it('修饰词剥离（CONST）', () => {
    expect(parseDimDeclaration('#DIM CONST 省略前括号 = 1')).toEqual({ directive: 'DIM', name: '省略前括号' });
  });

  it('#DIMS / #DIMSTR / 数组尺寸', () => {
    expect(parseDimDeclaration('#DIMS 名前')).toEqual({ directive: 'DIMS', name: '名前' });
    expect(parseDimDeclaration('#DIMSTR リスト, 10')).toEqual({ directive: 'DIMSTR', name: 'リスト' });
  });

  it('非 DIM 行返回 null', () => {
    expect(parseDimDeclaration('#FUNCTION')).toBeNull();
    expect(parseDimDeclaration('PRINTL x')).toBeNull();
  });
});

describe('parseErbText · 结构扫描', () => {
  const sample = `;※※※ 注释头 ※※※
;[SKIPSTART] 注释里的假指令不应触发
@M_KOJO_MESSAGE_COUNTER_K1_1
CALL M_KOJO_MESSAGE_COUNTER_K1_1_1
RETURN RESULT
@M_KOJO_MESSAGE_COUNTER_K1_1_1
	SELECTCASE RAND:2
	CASE 1
		PRINTFORML 「……？什么，太近了？」
	ENDSELECT
$LOCAL_LABEL
	PRINTL after-label
`;

  it('函数边界与行区间', () => {
    const f = parseErbText(sample, 'C:/t/a.ERB');
    expect(f.functions.map((x) => x.name)).toEqual(['M_KOJO_MESSAGE_COUNTER_K1_1', 'M_KOJO_MESSAGE_COUNTER_K1_1_1']);
    const [f1, f2] = f.functions;
    expect(f1!.startLine).toBe(3);
    expect(f1!.endLine).toBe(5); // 下一个定义前一行
    expect(f2!.startLine).toBe(6);
    expect(f2!.endLine).toBe(f.lineCount); // 到文件尾（$ 标签不是函数）
  });

  it('行首注释与 $ 标签不产生函数', () => {
    const f = parseErbText(sample);
    expect(f.functions).toHaveLength(2);
    expect(f.functions.some((x) => x.name.includes('LABEL'))).toBe(false);
  });

  it('归一化名大写', () => {
    const f = parseErbText('@m_kojo_lowercase\nPRINTL x\n');
    expect(f.functions[0]!.normalizedName).toBe('M_KOJO_LOWERCASE');
  });
});

describe('parseErbText · #FUNCTION / #DIM / SKIPSTART', () => {
  it('#FUNCTIONS 在 @ 行之后（AUTO_AEGI 真实写法）标记该函数', () => {
    const text = `@AEGI_F(ARG = -1 ,ARG:1 = 3 ,ARG:2 = 0)
#FUNCTIONS
#DIM 喘ぎ長度
#DIM CONST 省略前括号 = 1
SIF ARG < 0
	ARG = TARGET
`;
    const f = parseErbText(text);
    expect(f.hasFunctionDirective).toBe(true);
    expect(f.functions[0]!.isExpressionFunction).toBe(true);
    expect(f.dims.map((d) => d.name)).toEqual(['喘ぎ長度', '省略前括号']);
  });

  it('#FUNCTION 写在 @ 行之前也兼容', () => {
    const f = parseErbText('#FUNCTION\n@MY_EXPR(x)\nRETURNF x\n');
    expect(f.functions[0]!.isExpressionFunction).toBe(true);
    expect(f.hasFunctionDirective).toBe(true);
  });

  it('未标记的函数 isExpressionFunction 为 falsy', () => {
    const f = parseErbText('@PLAIN\nPRINTL x\n');
    expect(f.functions[0]!.isExpressionFunction).toBe(false);
    expect(f.hasFunctionDirective).toBe(false);
  });

  it('SKIPSTART…SKIPEND 区间内一律忽略（含函数定义与 #DIM）', () => {
    const text = `@REAL_ONE
PRINTL ok
[SKIPSTART]
@GHOST_FUNC
#DIM 幽灵变量
[SKIPEND]
@REAL_TWO
PRINTL ok
`;
    const f = parseErbText(text);
    expect(f.functions.map((x) => x.name)).toEqual(['REAL_ONE', 'REAL_TWO']);
    expect(f.dims).toHaveLength(0);
    // REAL_ONE 的区间终于 SKIPEND 之后的下一个定义（第 6 行）
    expect(f.functions[0]!.endLine).toBe(6);
  });

  it('未闭合的 SKIPSTART：后续内容全部忽略（宽容）', () => {
    const f = parseErbText('@A\nPRINTL x\n[SKIPSTART]\n@B\n');
    expect(f.functions.map((x) => x.name)).toEqual(['A']);
  });
});

describe('parseErbText · 边界情况', () => {
  it('空文件', () => {
    const f = parseErbText('');
    expect(f.functions).toHaveLength(0);
    expect(f.lineCount).toBe(1);
  });

  it('CRLF 与 CR 混合换行的行号正确', () => {
    const f = parseErbText('@A\r\nPRINTL x\r\n@B\r\nPRINTL y\r\n');
    expect(f.functions.map((x) => x.startLine)).toEqual([1, 3]);
  });

  it('缩进的 @ / #DIM 也能识别', () => {
    const f = parseErbText('  @INDENTED\n\t#DIM 变量名\n');
    expect(f.functions[0]!.name).toBe('INDENTED');
    expect(f.dims[0]!.name).toBe('变量名');
  });
});

describe('scanControlFlow', () => {
  it('IF 链：IF/ELSEIF/ELSE/ENDIF 同深度，体内语句深度 +1', () => {
    // 真实样本（大妖精 M_KOJO_K13_日常系コマンド.ERB 缩编）
    const text = [
      'IF LOCAL', // 1
      '\tIF CFLAG:318 == 1 || TFLAG:193 == -3 ;custom code, hate mark 3', // 2
      '\t\tPRINTFORMW 「（哽咽）…我现在…什么也不想说」', // 3
      '\tELSEIF TCVAR:302', // 4
      '\t\tPRINTFORMW 「啊、蝴蝶」', // 5
      '\tENDIF', // 6
      'ELSEIF TALENT:恋慕 && BASE:酒気 > (MAXBASE:酒気 / 10) * 8', // 7
      '\tPRINTFORMW 「诶嘿嘿～♪」', // 8
      'ENDIF', // 9
    ].join('\n');
    const stmts = scanControlFlow(text);
    expect(stmts.map((s) => [s.kind, s.depth, s.line])).toEqual([
      ['IF', 0, 1],
      ['IF', 1, 2],
      ['ELSEIF', 1, 4],
      ['ENDIF', 1, 6],
      ['ELSEIF', 0, 7],
      ['ENDIF', 0, 9],
    ]);
    expect(stmts[1]!.expression).toBe('CFLAG:318 == 1 || TFLAG:193 == -3');
    expect(stmts[4]!.expression).toBe('TALENT:恋慕 && BASE:酒気 > (MAXBASE:酒気 / 10) * 8');
  });

  it('SELECTCASE/CASE/CASEELSE/ENDSELECT 配对与深度', () => {
    const text = [
      'SELECTCASE ARGS', // 1
      'CASE "ENCOUNTER"', // 2
      '\tCALL FOO', // 3
      'CASE IS >= 5', // 4
      'CASEELSE', // 5
      '\tPRINTL x', // 6
      'ENDSELECT', // 7
      'PRINTL done', // 8
    ].join('\n');
    const stmts = scanControlFlow(text);
    expect(stmts.map((s) => [s.kind, s.depth, s.expression])).toEqual([
      ['SELECTCASE', 0, 'ARGS'],
      ['CASE', 0, '"ENCOUNTER"'],
      ['CASE', 0, 'IS >= 5'],
      ['CASEELSE', 0, ''],
      ['ENDSELECT', 0, ''],
    ]);
  });

  it('SIF 不配对：不改变后续深度', () => {
    const text = ['SIF RESULT == 1', '\tRETURN 1', 'IF A', 'ENDIF'].join('\n');
    const stmts = scanControlFlow(text);
    expect(stmts.map((s) => [s.kind, s.depth])).toEqual([
      ['SIF', 0],
      ['IF', 0],
      ['ENDIF', 0],
    ]);
    expect(stmts[0]!.expression).toBe('RESULT == 1');
  });

  it('字符串内分号不截断；引号外分号截断', () => {
    const stmts = scanControlFlow(['IF STR == "a;b"', 'IF X == 1 ; 注释', 'IF Y ; 注释'].join('\n'));
    expect(stmts.map((s) => s.expression)).toEqual(['STR == "a;b"', 'X == 1', 'Y']);
  });

  it('SKIPSTART 区间内不产出；注释行/空行/@#/$ 行不参与', () => {
    const text = [
      '; IF FAKE1',
      '@FUNC',
      '#DIM X',
      '$LABEL',
      '[SKIPSTART]',
      'IF FAKE2',
      '[SKIPEND]',
      'IF REAL',
      'ENDIF',
    ].join('\n');
    const stmts = scanControlFlow(text);
    expect(stmts.map((s) => [s.kind, s.line])).toEqual([
      ['IF', 8],
      ['ENDIF', 9],
    ]);
  });

  it('REPEAT/REND、FOR/NEXT、WHILE/WEND 配对', () => {
    const text = [
      'REPEAT 3', // 1
      '\tFOR I, 0, 5', // 2
      '\t\tWHILE X', // 3
      '\t\tWEND', // 4
      '\tNEXT', // 5
      'REND', // 6
    ].join('\n');
    const stmts = scanControlFlow(text);
    expect(stmts.map((s) => [s.kind, s.depth])).toEqual([
      ['REPEAT', 0],
      ['FOR', 1],
      ['WHILE', 2],
      ['WEND', 2],
      ['NEXT', 1],
      ['REND', 0],
    ]);
    expect(stmts[0]!.expression).toBe('3');
    expect(stmts[1]!.expression).toBe('I, 0, 5');
  });

  it('TRYC 系 → CATCH → ENDCATCH；PRINTDATA → ENDDATA（BUG-2 更正：TRYCALLFORM 是单行语句不开块）', () => {
    const text = [
      'TRYCGOTOFORM FOO_{N}, TARGET', // 1（TRYC 六成员之一，配 CATCH）
      'CATCH', // 2
      '\tPRINTL fallback', // 3
      'ENDCATCH', // 4
      'TRYCALLFORM BAR_{N}', // 5（单行语句，不开块——旧版误判为开块）
      'PRINTDATA', // 6
      'DATALIST', // 7
      '\t1', // 8
      'ENDLIST', // 9
      'ENDDATA', // 10
    ].join('\n');
    const stmts = scanControlFlow(text);
    // 注：DATALIST 是独立开块（list），ENDLIST 配对它；PRINTDATA 的 ENDDATA 在 ENDLIST 之后配平
    expect(stmts.map((s) => s.kind)).toEqual(['TRYCGOTOFORM', 'CATCH', 'ENDCATCH', 'PRINTDATA', 'DATALIST', 'ENDLIST', 'ENDDATA']);
    const byKind = new Map(stmts.map((s) => [s.kind, s.depth]));
    expect(byKind.get('CATCH')).toBe(0); // 与 TRYCGOTOFORM 同深度
    expect(byKind.get('ENDCATCH')).toBe(0);
    expect(stmts.some((s) => s.kind === 'TRYCALLFORM')).toBe(false);
  });

  it('孤儿 ENDIF / 错配不中断（宽容，后续深度仍可用）', () => {
    const text = ['ENDIF', 'IF A', 'NEXT', 'PRINTL x', 'ENDIF'].join('\n');
    const stmts = scanControlFlow(text);
    expect(stmts.map((s) => [s.kind, s.depth])).toEqual([
      ['ENDIF', 0],
      ['IF', 0],
      ['NEXT', 1], // 栈内无 for：不动栈，depth = 当前栈长
      ['ENDIF', 0], // 向前找到 IF 并弹掉
    ]);
  });

  it('混合大小写语句宽容识别', () => {
    const stmts = scanControlFlow(['if A', 'EndIf'].join('\n'));
    expect(stmts.map((s) => s.kind)).toEqual(['IF', 'ENDIF']);
    expect(stmts[0]!.depth).toBe(0);
  });

  it('CASE 逗号列表与 TO 区间原文保留', () => {
    const stmts = scanControlFlow(['SELECTCASE X', 'CASE 1, 2, 3', 'CASE 10 TO 20', 'ENDSELECT'].join('\n'));
    expect(stmts.filter((s) => s.kind === 'CASE').map((s) => s.expression)).toEqual(['1, 2, 3', '10 TO 20']);
  });

  it('TRYC 六个 → CATCH → ENDCATCH 配对（BUG-2 精确集合）', () => {
    for (const opener of ['TRYCGOTO', 'TRYCJUMP', 'TRYCCALL', 'TRYCGOTOFORM', 'TRYCJUMPFORM', 'TRYCCALLFORM']) {
      const stmts = scanControlFlow([`${opener} TARGET, FOO`, 'CATCH', 'PRINTFORMW err', 'ENDCATCH'].join('\n'));
      expect(stmts.map((s) => [s.kind, s.depth])).toEqual([
        [opener, 0],
        ['CATCH', 0],
        ['ENDCATCH', 0],
      ]);
    }
  });

  it('TRYCALL / TRYCALLFORM / TRYGOTO / TRYJUMP 是单行语句，不开块（BUG-2）', () => {
    const text = [
      'IF X',
      'TRYCALLFORM FOO_BAR',
      'TRYJUMP TARGET',
      'ENDIF',
    ].join('\n');
    const stmts = scanControlFlow(text);
    expect(stmts.map((s) => [s.kind, s.depth])).toEqual([
      ['IF', 0],
      ['ENDIF', 0],
    ]);
    // 单行 TRY 语句不出现在控制流骨架里（不开块、不成对）
    expect(stmts.some((s) => s.kind.startsWith('TRY'))).toBe(false);
  });

  it('TRYCALLLIST → ENDFUNC 独立配对（funclist）', () => {
    const text = ['TRYCALLLIST', '\tCALL FOO', 'ENDFUNC'].join('\n');
    const stmts = scanControlFlow(text);
    expect(stmts.map((s) => [s.kind, s.depth])).toEqual([
      ['TRYCALLLIST', 0],
      ['ENDFUNC', 0],
    ]);
  });

  it('PRINTDATA 系九个精确命中；PRINTDATAX 等非成员不开块（BUG-2）', () => {
    const members = ['PRINTDATA', 'PRINTDATAL', 'PRINTDATAW', 'PRINTDATAK', 'PRINTDATAKL', 'PRINTDATAKW', 'PRINTDATAD', 'PRINTDATADL', 'PRINTDATADW'];
    for (const opener of members) {
      const stmts = scanControlFlow([opener, '\t"hello"', 'ENDDATA'].join('\n'));
      expect(stmts.map((s) => s.kind)).toEqual([opener, 'ENDDATA']);
    }
    expect(scanControlFlow(['PRINTDATAX', '\t"x"', 'ENDDATA'].join('\n')).map((s) => s.kind)).toEqual(['ENDDATA']);
  });
});

/* ---------------------- 函数上方注释块（用户反馈 9） ---------------------- */

describe('cleanDocBlock · 注释块清洗', () => {
  it('丢掉画框装饰线、去 ; 前缀，保留信息行', () => {
    const out = cleanDocBlock([
      ';==================================================',
      ';660,読書',
      ';TFLAG:193(選択肢文学(1=忍殺 2=失敗 3=文学))',
      ';==================================================',
    ]);
    expect(out).toBe('660,読書\nTFLAG:193(選択肢文学(1=忍殺 2=失敗 3=文学))');
  });

  it('全是装饰线 / 只有分号 → undefined（缺省而非空串）', () => {
    expect(cleanDocBlock([';====', ';-----', ';', ';   *  '])).toBeUndefined();
    expect(cleanDocBlock([])).toBeUndefined();
  });

  it('超上限截断并加省略号（离群长文档不吃掉整份快照）', () => {
    const long = `;${'あ'.repeat(DOC_MAX_CHARS + 200)}`;
    const out = cleanDocBlock([long])!;
    expect(out.length).toBeLessThanOrEqual(DOC_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });

  it('保留 ; 后正文里的分号与缩进内容', () => {
    expect(cleanDocBlock([';作者: 某;人 备注'])).toBe('作者: 某;人 备注');
  });
});

describe('parseErbText · docComment 归属', () => {
  it('紧邻 @ 行的注释块挂到该函数，并保留真实形态', () => {
    const f = parseErbText(
      [
        ';==================================================',
        ';660,読書',
        ';TFLAG:193(選択肢文学)',
        ';==================================================',
        '@M_KOJO_MESSAGE_COM_K1_660',
        '\tPRINTL ok',
        '@M_KOJO_MESSAGE_COM_K1_661',
      ].join('\n'),
      'a.ERB',
    );
    expect(f.functions[0]!.docComment).toBe('660,読書\nTFLAG:193(選択肢文学)');
    // 第二个函数上方没有注释 → 缺省，不是空串
    expect(f.functions[1]!.docComment).toBeUndefined();
  });

  it('注释与 @ 行之间允许一个空行，但连续多空行视为断开（防文件头注释跨半张纸粘上来）', () => {
    const withOne = parseErbText([';読書', '', '@M_KOJO_K1_A'].join('\n'), 'a.ERB');
    expect(withOne.functions[0]!.docComment).toBe('読書');
    const withMany = parseErbText([';読書', '', '', '', '', '@M_KOJO_K1_A'].join('\n'), 'a.ERB');
    expect(withMany.functions[0]!.docComment).toBeUndefined();
  });

  it('张冠李戴防线：注释后若隔了语句行，不得再挂到后面的函数上', () => {
    const f = parseErbText(
      [';这是给下面 DIM 的说明', '#DIM LOCAL, 5', '@M_KOJO_K1_A'].join('\n'),
      'a.ERB',
    );
    expect(f.functions[0]!.docComment).toBeUndefined();
  });

  it('归属规则是「紧邻」：函数体尾部的注释归到下一个函数（确定规则，不猜作者意图）', () => {
    const f = parseErbText(
      ['@M_KOJO_K1_A', '\tPRINTL 1', '; 收尾随手注释', '@M_KOJO_K1_B'].join('\n'),
      'a.ERB',
    );
    // A 自己上方没注释 → 缺省；那行注释紧邻 B → 归 B。
    // 作者意图本就模糊，这里取一条**可预测的确定规则**（紧邻其下的声明），不做二次猜测。
    expect(f.functions[0]!.docComment).toBeUndefined();
    expect(f.functions[1]!.docComment).toBe('收尾随手注释');
  });

  it('[SKIPSTART] 块内的注释不参与收集', () => {
    const f = parseErbText(
      ['[SKIPSTART]', ';被跳过的注释', '[SKIPEND]', '@M_KOJO_K1_A'].join('\n'),
      'a.ERB',
    );
    expect(f.functions[0]!.docComment).toBeUndefined();
  });
});
