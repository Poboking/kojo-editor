import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement } from '@kojo/plugin-api';
import { collectExprSyntaxDecorations, expressionSurfaces } from '../src/decorator';

/** 手造一条控制流语句（只填本测试关心的字段；depth 与过滤无关，恒 0）。 */
function stmt(kind: string, expression: string, line: number): ControlFlowStatement {
  return { kind, expression, depth: 0, line };
}

/**
 * 假扫描器：无视文本、直接返回预置语句表。
 * 本测试只验 `collectExprSyntaxDecorations` 的**过滤 / 排序 / 去重**口径，
 * 骨架扫描本身由 erb-parser 的测试覆盖——所以这里不打桩那个真实实现。
 */
function fakeScan(
  statements: readonly ControlFlowStatement[],
): (text: string) => readonly ControlFlowStatement[] {
  return () => statements;
}

describe('collectExprSyntaxDecorations · 过滤口径', () => {
  it('IF/ELSEIF/SIF/WHILE/SELECTCASE 上的非法表达式 → 报（warning 语义）', () => {
    // 非法样例照 expr.ts 的实际语法构造：非法字符（A $ B）/ 括号不闭合（(A）
    // 注意：行尾悬空运算符（`A &&`）自 2026-10-19 起按续行 fail-open（见 expr-diagnostic.test.ts）
    const out = collectExprSyntaxDecorations(
      'x',
      fakeScan([
        stmt('IF', 'A $ B', 1),
        stmt('ELSEIF', '(A', 2),
        stmt('SIF', '(A', 3),
        stmt('WHILE', 'A $ B', 4),
        stmt('SELECTCASE', 'A $ B', 5),
      ]),
    );
    expect(out.map((d) => d.line)).toEqual([1, 2, 3, 4, 5]);
    for (const d of out) {
      expect(d.message.length).toBeGreaterThan(0);
      expect(d.code).toMatch(/^erb\.expr-(lexical|syntax)$/);
    }
  });

  it('CASE / PRINTDATA 等（逗号列表 / 范围写法）→ 不报', () => {
    const out = collectExprSyntaxDecorations(
      'x',
      fakeScan([stmt('CASE', 'A $ B', 1), stmt('PRINTDATA', 'A $ B', 2)]),
    );
    expect(out).toEqual([]);
  });

  it('expression 为空 / 只有空白 → 不报', () => {
    const out = collectExprSyntaxDecorations(
      'x',
      fakeScan([stmt('IF', '', 1), stmt('WHILE', '   ', 2), stmt('SIF', '\t', 3)]),
    );
    expect(out).toEqual([]);
  });

  it('合法条件 → 不报', () => {
    const out = collectExprSyntaxDecorations(
      'x',
      fakeScan([
        stmt('IF', 'CFLAG:2 >= 500', 1),
        stmt('ELSEIF', 'TALENT:恋慕', 2),
        stmt('WHILE', 'A && B', 3),
        stmt('SELECTCASE', 'GROUPMATCH(ARGS, "COMMAND", "COM")', 4),
      ]),
    );
    expect(out).toEqual([]);
  });

  it('文本为空 → 返回 []', () => {
    expect(collectExprSyntaxDecorations('', fakeScan([stmt('IF', 'A $ B', 1)]))).toEqual([]);
  });

  it('返回按行号升序（与语句扫描顺序无关）', () => {
    const out = collectExprSyntaxDecorations(
      'x',
      fakeScan([stmt('IF', '(A', 9), stmt('IF', '(A', 3), stmt('WHILE', '(A', 7)]),
    );
    expect(out.map((d) => d.line)).toEqual([3, 7, 9]);
  });

  it('同一行多条 → 只留第一条', () => {
    const out = collectExprSyntaxDecorations(
      'x',
      fakeScan([stmt('IF', 'A $ B', 5), stmt('SIF', '(A', 5)]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.line).toBe(5);
  });

  it('列区间：表达式内偏移 + 行内起点 → 1 基 UTF-16 半开区间', () => {
    const text = 'PRINTL 甲\n\tSIF A $ B\n';
    const out = collectExprSyntaxDecorations(text, fakeScan([stmt('SIF', 'A $ B', 2)]));
    expect(out).toHaveLength(1);
    // 行 = `\tSIF A $ B`：表达式 `A $ B` 从 0 基 5 起，`$` 在表达式内偏移 2 ⇒ 起点列 8
    expect(out[0]!.startColumn).toBe(8);
    expect(out[0]!.endColumn).toBe(9);
  });

  it('定位不到表达式（假扫描器给的行号不在文本里）→ 不给列号，退回整行', () => {
    const out = collectExprSyntaxDecorations('x', fakeScan([stmt('IF', 'A $ B', 9)]));
    expect(out).toHaveLength(1);
    expect(out[0]!.startColumn).toBeUndefined();
    expect(out[0]!.endColumn).toBeUndefined();
  });

  it('反证：真错 `IF (1 + ) == 0` 仍报（装饰链不许把诊断整体关掉）', () => {
    const out = collectExprSyntaxDecorations(
      'IF (1 + ) == 0\n',
      fakeScan([stmt('IF', '(1 + ) == 0', 1)]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe('erb.expr-syntax');
    // 多出来的 `)` 在表达式内偏移 5；`IF ` 占 3 列 ⇒ 1 基列 9
    expect(out[0]!.startColumn).toBe(9);
  });

  it('扫描器抛错 → 不抛错、返回 []（本函数不得抛错）', () => {
    const boom = (): readonly ControlFlowStatement[] => {
      throw new Error('boom');
    };
    expect(collectExprSyntaxDecorations('x', boom)).toEqual([]);
  });
});

/**
 * T8 表面扩面：赋值右侧 + 字符串插值。同一套 diagnoseExpression，新表面只换"从哪挖"。
 * 断言分两层：`expressionSurfaces`（挖得对不对）与 `collectExprSyntaxDecorations`（诊得出不出）。
 */
describe('expressionSurfaces · 赋值右侧（高置信表达式）', () => {
  it('引号 / 数字 / `(` 打头 → 提取 RHS', () => {
    expect(expressionSurfaces('A = (B +')).toEqual([{ line: 1, expression: '(B +', origin: 'assign' }]);
    expect(expressionSurfaces('MONEY -= 100')).toEqual([{ line: 1, expression: '100', origin: 'assign' }]);
    expect(expressionSurfaces('CFLAG:ARG:0 += (BASE:1')).toEqual([
      { line: 1, expression: '(BASE:1', origin: 'assign' },
    ]);
    expect(expressionSurfaces('DA:(X + 1):2 = 0')).toEqual([{ line: 1, expression: '0', origin: 'assign' }]);
    expect(expressionSurfaces('A <<= 2')).toEqual([{ line: 1, expression: '2', origin: 'assign' }]);
    expect(expressionSurfaces('A = "a" +')).toEqual([{ line: 1, expression: '"a" +', origin: 'assign' }]);
  });

  it('ident 打头 → 须带索引链 / 调用才提取（裸文本赋值的形态空间是开放集，fail-open）', () => {
    expect(expressionSurfaces('A = CFLAG:2 +')).toEqual([{ line: 1, expression: 'CFLAG:2 +', origin: 'assign' }]);
    expect(expressionSurfaces('A = TALENT:恋慕 + 1')).toEqual([
      { line: 1, expression: 'TALENT:恋慕 + 1', origin: 'assign' },
    ]);
    expect(expressionSurfaces('A = F(X, Y)')).toEqual([{ line: 1, expression: 'F(X, Y)', origin: 'assign' }]);
    // `wait:`（冒号后无段）/ 纯变量运算（`A = B + C`）→ 不猜
    expect(expressionSurfaces('strFlag:LOCAL = wait:')).toEqual([]);
    expect(expressionSurfaces('A = B + C')).toEqual([]);
  });

  it('比较 / 相等 / 位移不是赋值 → 不提取', () => {
    expect(expressionSurfaces('A == B\nC != D\nE <= F\nG >= H\nI << 2\nJ >> 3')).toEqual([]);
  });

  it('LHS 形状门：不像变量引用的行整行不猜', () => {
    expect(expressionSurfaces('IF A = 1')).toEqual([]);
    expect(expressionSurfaces('SIF X = 1')).toEqual([]);
    expect(expressionSurfaces('CALL FOO, X = 1')).toEqual([]);
    expect(expressionSurfaces('#DIM X = 1')).toEqual([]);
    expect(expressionSurfaces('PRINT A = B')).toEqual([]);
  });

  it('fail-open：`\\@…\\@` 条件插值 / ERA 三元 `#` / 实数 / 字符字面量 → 不提取', () => {
    expect(expressionSurfaces('A = X ? 1 # 2')).toEqual([]);
    expect(expressionSurfaces('A = @"\\@C ? "多" # "少" \\@"')).toEqual([]);
    expect(expressionSurfaces('A = 1.5')).toEqual([]);
    expect(expressionSurfaces("A = 'x'")).toEqual([]);
  });

  it('fail-open（语料实证形态）：插值展开 RHS / 多重代入 / 中缀 @"…" → 不提取', () => {
    // STR 变量的 %…% 插值展开是合法 ERA（`%` 的模/插值两读无法从语法分辨 → 整条不猜）
    expect(expressionSurfaces('LOCALS = %RESULTS%')).toEqual([]);
    expect(expressionSurfaces('会場 = %DATENAME_PLACE()%')).toEqual([]);
    expect(expressionSurfaces('LOCALS = 体力(%CALLNAME:MASTER%)')).toEqual([]);
    // 顶层逗号（多重代入形态）；括号内逗号是实参表，照常提取
    expect(expressionSurfaces('LOCAL = 5, 6, 7, 14, 111')).toEqual([]);
    expect(expressionSurfaces('count = REGEXPMATCH(X, @"\\\\[a:b]", groupCount)')).toEqual([]);
    expect(expressionSurfaces('A = F(X, Y)')).toEqual([{ line: 1, expression: 'F(X, Y)', origin: 'assign' }]);
  });

  it('fail-open（语料实证形态 II）：裸文本赋值 / 美术图行 / 空实参 / 调用式索引 → 不提取', () => {
    // 裸文本：全角标点 / 非法首记号 / 空格断 token（美术图与台词，出引号外）
    expect(expressionSurfaces('台词 = 「哦呀哦呀…还没玩够吗？」/「好啊」')).toEqual([]);
    expect(expressionSurfaces('LIST_BY_DT_XML = <ROOT />')).toEqual([]);
    expect(expressionSurfaces('RESULTS:3 = =')).toEqual([]);
    expect(expressionSurfaces('L_SPR = {L_G}_{L_TEMP}')).toEqual([]);
    expect(expressionSurfaces('AA:05 = 森森森　　林森森▲▲')).toEqual([]);
    expect(expressionSurfaces('AA:02 = ┃|…│┃')).toEqual([]);
    // 空实参（ERA 缺省实参）与 变量:函数() 调用式索引
    expect(expressionSurfaces('L_TEMP = FINDELEMENT(SORT_TARGET , DEF , , , 1)')).toEqual([]);
    expect(expressionSurfaces('count = DT_CELL_GET(A , CHRLIST:TOINT(L_RS) , C , 1)')).toEqual([]);
    // 实数科学计数法 / 纯符号裸文本 / 英文词典裸文本（SYNONYMS 系）
    expect(expressionSurfaces('mCID:1 = 19e2')).toEqual([]);
    expect(expressionSurfaces('LOCAL:1 = MAX(mCID:1/1e3,1)')).toEqual([]);
    expect(expressionSurfaces('ARGS:1 = -')).toEqual([]);
    expect(expressionSurfaces('LOCALS = !')).toEqual([]);
    expect(expressionSurfaces('strType:2 = enjoy the sensation')).toEqual([]);
    // 内嵌引号：@"…%F("A", B)%…" 引号总数 > 2 → 配对不可靠 → 不猜
    expect(expressionSurfaces('HTMLText += @"%getHtmlXray("XRAY", W * 3 / 10)%\""')).toEqual([]);
    // 对照：真表达式照常提取
    expect(expressionSurfaces('A = TALENT:恋慕 + 1')).toEqual([{ line: 1, expression: 'TALENT:恋慕 + 1', origin: 'assign' }]);
  });

  it('行内注释截断（引号感知）；字符串内的 `;` 保留', () => {
    expect(expressionSurfaces('A = CFLAG:1 ; 加算')).toEqual([{ line: 1, expression: 'CFLAG:1', origin: 'assign' }]);
    expect(expressionSurfaces('STR:0 = "a;b" +')).toEqual([{ line: 1, expression: '"a;b" +', origin: 'assign' }]);
  });

  it('未闭合引号的 RHS → 照提取（词法错，该报）', () => {
    expect(expressionSurfaces('A = "abc')).toEqual([{ line: 1, expression: '"abc', origin: 'assign' }]);
  });

  it('`@"…"` 扩展字面量剥前缀后提取', () => {
    expect(expressionSurfaces('STR:0 = @" greeting "')).toEqual([
      { line: 1, expression: '" greeting "', origin: 'assign' },
    ]);
  });

  it('右侧是合法表达式 / 纯字符串 → 提取但诊断不出（collect 层无波浪线）', () => {
    expect(collectExprSyntaxDecorations('A = B % 10\n', () => [])).toEqual([]);
    expect(collectExprSyntaxDecorations('STR:0 = "ok"\n', () => [])).toEqual([]);
  });
});

describe('expressionSurfaces · 字符串插值', () => {
  it('`{表达式}` / `%表达式%` → 提取段内容', () => {
    expect(expressionSurfaces('PRINT "HP{MONEY}枚"')).toEqual([{ line: 1, expression: 'MONEY', origin: 'interp' }]);
    expect(expressionSurfaces('PRINT "%CALLNAME%は{TALENT:恋慕}された"')).toEqual([
      { line: 1, expression: 'CALLNAME', origin: 'interp' },
      { line: 1, expression: 'TALENT:恋慕', origin: 'interp' },
    ]);
  });

  it('`%…, 对齐, 宽度%` 与 `{…, 对齐, 宽度%}` 同制：只诊第一段', () => {
    expect(expressionSurfaces('PRINT "%CALLNAME, 26, LEFT%です"')).toEqual([
      { line: 1, expression: 'CALLNAME', origin: 'interp' },
    ]);
    expect(expressionSurfaces('PRINTBUTTON @"[{LOCAL, 2, RIGHT}]"')).toEqual([
      { line: 1, expression: 'LOCAL', origin: 'interp' },
    ]);
    // 括号内的逗号是实参表，留在段里照诊（ERB 单引号包不住内嵌双引号，用无引号实参构造）
    expect(expressionSurfaces('PRINT "%DIC_GET(A:1, X), 36%"')).toEqual([
      { line: 1, expression: 'DIC_GET(A:1, X)', origin: 'interp' },
    ]);
  });

  it('fail-open（语料实证形态）：mod 撞闭合 / 美术包裹 / 空实参调用 → 不猜；合法段照常', () => {
    // `%…%` 内含 mod 的嵌套：朴素 indexOf 提取出"有开无闭"的 `C_SAMPLE_CHAR:(CNT` → 不猜
    expect(expressionSurfaces('PRINT @"[%C_SAMPLE_CHAR:(CNT % VARSIZE("X")) * W%]"')).toEqual([]);
    // `%\"…\"%` 美术包裹（整幅 AA 用转义引号塞进插值，内层 {} 全是图）
    expect(expressionSurfaces('PRINTFORMDL %\\"　 |　{::} {/　　　}\\"%')).toEqual([]);
    // 合法但表达式子集不覆盖的 ref 后缀调用索引；同串里合法的 `{mCID}` 照常提取
    expect(expressionSurfaces('PRINT @"顔絵_%Emot:IFEstr()%_{mCID}"')).toEqual([
      { line: 1, expression: 'mCID', origin: 'interp' },
    ]);
    // 空实参调用（ERA 缺省实参，口上高频）
    expect(expressionSurfaces('PRINT @"…%MOAN(,,2)%！"')).toEqual([]);
    // 插值内容含 mod → 提取合法段，诊断不出（`%` 在 {} 内容里就是模运算）
    expect(collectExprSyntaxDecorations('PRINTBUTTON @"[{LOCAL % 100, 2}]"\n', () => [])).toEqual([]);
  });

  it('未闭合 / 转义 / 条件插值 → 不提取', () => {
    expect(expressionSurfaces('PRINT "成功率50%"')).toEqual([]); // 单个 % = 字面量
    expect(expressionSurfaces('PRINT "\\{A\\}乙"')).toEqual([]); // \X 转义对
    expect(expressionSurfaces('PRINT "値は\\@A > 0 ? "多" # "少" \\@です"')).toEqual([]); // 条件插值
    expect(expressionSurfaces('PRINT "没有插值"')).toEqual([]);
  });

  it('散文守卫：`%`/`{}` 夹住的散文不进诊断（表达式标记才放行）', () => {
    // 两段散文（带空格断 token 的形态，朴素提取会假红）
    expect(expressionSurfaces('PRINT "5%でクリティカル、 10%は外れ"')).toEqual([]);
    expect(expressionSurfaces('PRINT "パンツ { を脱ぐ } なり"')).toEqual([]); // 无标记散文
    expect(expressionSurfaces('PRINT "{LOAD中...}完了"')).toEqual([]); // 非记号非纯 ASCII
  });

  it('插值段真错 → 报', () => {
    // 夹具避开"行尾二元运算符"：dev 侧 `diagnoseExpression` 把残句尾的运算符/逗号判为
    // 折行续写（真实语料大量 `IF … &&` / `SIF …,` 跨行），条件面与表面共用同一条抑制，
    // 这里换成真错形态（多余右括号 / 非法成员访问 / 括号不配对）。
    expect(collectExprSyntaxDecorations('PRINT "{A )}"\n', () => []).length).toBe(1);
    expect(collectExprSyntaxDecorations('PRINT "{A + * B}"\n', () => []).length).toBe(1);
    expect(collectExprSyntaxDecorations('PRINT "{D)}"\n', () => []).length).toBe(1);
  });
});

describe('expressionSurfaces · 区域屏蔽', () => {
  it('注释行 / 指令行 / [SKIPSTART] 区 → 不提取', () => {
    expect(expressionSurfaces('; A = B +')).toEqual([]);
    expect(expressionSurfaces('@FUNC(A, B)\n$label\nA = (B +')).toEqual([{ line: 3, expression: '(B +', origin: 'assign' }]);
    expect(expressionSurfaces('[SKIPSTART]\nA = B +\n[SKIPEND]\nA = (B +')).toHaveLength(1);
  });

  it('data 块（PRINTDATA/STRDATA/DATALIST…）内整段是台词原文 → 不提取；嵌套 ENDLIST 正确弹栈', () => {
    const text = [
      'PRINTDATA',
      '  "50%の確率で{CRASH}発生"',
      'DATALIST',
      '  DATA "{名前}"',
      'ENDLIST',
      'ENDDATA',
      'A = (B +',
    ].join('\n');
    expect(expressionSurfaces(text)).toEqual([{ line: 7, expression: '(B +', origin: 'assign' }]);
  });

  it('CRLF 归一后行号正确（1 基）', () => {
    const out = expressionSurfaces('PRINTL 甲\r\nA = (B +\r\n');
    expect(out).toEqual([{ line: 2, expression: '(B +', origin: 'assign' }]);
  });
});

describe('collectExprSyntaxDecorations · T8 合流口径', () => {
  it('条件行优先：同一行上条件链的发现先于表面', () => {
    // IF 行上 `A )` 被条件链报；插值段 `{X}` 合法不报——一行只留第一条
    const out = collectExprSyntaxDecorations('IF A ) "{X}"\n', () => [
      { kind: 'IF', expression: 'A )', depth: 0, line: 1 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toMatch(/^erb\.expr-/);
  });

  it('表面发现与条件发现按行号合流排序', () => {
    const out = collectExprSyntaxDecorations('A = (B ))\nIF C )\nPRINT "{D)}"\n', () => [
      { kind: 'IF', expression: 'C )', depth: 0, line: 2 },
    ]);
    expect(out.map((d) => d.line)).toEqual([1, 2, 3]);
    for (const d of out) expect(d.code).toMatch(/^erb\.expr-(lexical|syntax)$/);
  });

  it('既有过滤口径不受扩面影响（条件空串 / 非条件 kind 仍不报）', () => {
    expect(collectExprSyntaxDecorations('x', fakeScan([stmt('IF', '', 1), stmt('CASE', 'A $ B', 2)]))).toEqual([]);
  });
});
