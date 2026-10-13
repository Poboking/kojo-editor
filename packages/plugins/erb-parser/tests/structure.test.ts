import { describe, expect, it } from 'vitest';
import { checkControlFlowStructure, MAX_STRUCTURE_ISSUES } from '../src/structure';
import { scanControlFlow } from '../src/scanner';

/**
 * ERB 结构体检单测（2026-10-13 UI 反馈 7）。
 *
 * 这一份守的是**精度**，不是覆盖率：三类错误之外的形状一律必须**不报**。
 * 口径来自本项目一贯的"错标比不标危险"——波浪线指错行，作者会开始怀疑所有提示，
 * 包括那些报对的；而漏报的代价只是他多跑一次引擎。
 * 因此每个 `it` 都成对写：既断"该报的报了"，也断"不该报的一条都没有"。
 *
 * 真实语料上的**零误报**由 `structure.corpus.test.ts` 单独钉（有语料才跑），这里只放形态样本。
 */

const L = (...lines: string[]): string => lines.join('\n');

describe('checkControlFlowStructure · 配平时一条都不报', () => {
  it('IF / ELSEIF / ELSE / ENDIF 链，嵌套也配平', () => {
    const text = L(
      'IF LOCAL',
      '\tIF CFLAG:318 == 1',
      '\t\tPRINTFORMW 「甲」',
      '\tELSEIF TCVAR:302',
      '\t\tPRINTFORMW 「乙」',
      '\tENDIF',
      'ELSEIF TALENT:1',
      '\tPRINTFORMW 「丙」',
      'ELSE',
      '\tPRINTFORMW 「丁」',
      'ENDIF',
    );
    expect(checkControlFlowStructure(text)).toEqual([]);
  });

  it('SELECTCASE / CASE / CASEELSE / ENDSELECT 配平', () => {
    const text = L('SELECTCASE ARGS', 'CASE "A"', '\tCALL FOO', 'CASE IS >= 5', 'CASEELSE', '\tPRINTL x', 'ENDSELECT');
    expect(checkControlFlowStructure(text)).toEqual([]);
  });

  it('PRINTDATA 系 / DATALIST / STRDATA 各自闭合', () => {
    const text = L(
      'PRINTDATA',
      '\tDATA:1',
      '\tDATALINE',
      '\t\t甲',
      'ENDDATA',
      'DATALIST :甲:乙',
      'DATALINE',
      '\t1',
      'ENDLIST',
      'STRDATA :甲:乙',
      'DATALINE',
      '\t文本',
      'ENDDATA',
    );
    expect(checkControlFlowStructure(text)).toEqual([]);
  });

  it('TRYC 系：TRYCGOTO → CATCH → ENDCATCH 配平', () => {
    const text = L('TRYCGOTO *先, LABEL:目标', 'CATCH', '\tPRINTL 失败', 'ENDCATCH');
    expect(checkControlFlowStructure(text)).toEqual([]);
  });

  it('TRYCALLLIST → CATCH → ENDFUNC 配平（配对类 funclist）', () => {
    const text = L('TRYCALLLIST', '\tCALL A', '\tCALL B', 'CATCH', '\tCALL C', 'ENDFUNC');
    expect(checkControlFlowStructure(text)).toEqual([]);
  });

  it('NOSKIP / REPEAT / FOR / WHILE / DO 各类闭合语句', () => {
    const text = L(
      'NOSKIP',
      '\tPRINTL 必过',
      'ENDNOSKIP',
      'REPEAT I = 0 : 3',
      '\tPRINTL I',
      'REND',
      'FOR LOCAL:0 = 0 TO 2',
      '\tPRINTL LOCAL:0',
      'NEXT',
      'WHILE LOCAL:1 < 3',
      '\tLOCAL:1 ++',
      'WEND',
      'DO',
      '\tPRINTL 循环',
      'LOOP',
    );
    expect(checkControlFlowStructure(text)).toEqual([]);
  });

  it('叶子语句不产生未闭合（SIF 是单行、TRYCALL 系不开块，BUG-2 口径）', () => {
    const text = L('SIF TFLAG:1 == 0 : RETURN', 'TRYCALL FOO', 'TRYGOTO *甲, LABEL:乙', 'PRINTL 结束');
    expect(checkControlFlowStructure(text)).toEqual([]);
  });

  it('注释行与 [SKIPSTART]…[SKIPEND] 区间里的关键字一概不算', () => {
    const text = L(';ENDIF 这是说明注释', '[SKIPSTART]', 'IF A', 'ENDIF', '[SKIPEND]', 'PRINTL 活着');
    expect(checkControlFlowStructure(text)).toEqual([]);
  });

  it('函数头部那一串 # 指令不算区域边界（否则每个函数都会冒出一批假未闭合）', () => {
    const text = L('@AEGI', '#FUNCTION', '#DIM 计数', '#LOCALS 临时', 'IF A', '\tPRINTL 甲', 'ENDIF');
    expect(checkControlFlowStructure(text)).toEqual([]);
  });

  it('关键字大小写混写仍配平（引擎不分大小写）', () => {
    const text = L('if A', '\tENDIF', 'EndSelect');
    // ENDSELECT 写成 EndSelect 仍然匹配；这一份只有一个多出来的 ENDSELECT ⇒ 只该报孤儿闭合
    const issues = checkControlFlowStructure(text);
    expect(issues.map((i) => i.kind)).toEqual(['orphan-close']);
  });
});

describe('checkControlFlowStructure · 三类可证明错误', () => {
  it('少一个 ENDIF：报未闭合，行号指到**开块那一行**而不是文件尾', () => {
    const text = L('IF A', '\tPRINTL 甲', 'PRINTL 乙');
    const issues = checkControlFlowStructure(text);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'unclosed-open', line: 1, statement: 'IF' });
    expect(issues[0]!.message).toContain('ENDIF');
  });

  it('多一个 ENDIF：报孤儿闭合，指到那一条闭合语句', () => {
    const text = L('IF A', '\tENDIF', 'ENDIF');
    const issues = checkControlFlowStructure(text);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('orphan-close');
    expect(issues[0]!.line).toBe(3);
    expect(issues[0]!.statement).toBe('ENDIF');
  });

  it('ELSE 前面没有开着的 IF：报无主分支', () => {
    const text = L('PRINTL 甲', 'ELSE', 'PRINTL 乙');
    const issues = checkControlFlowStructure(text);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('orphan-branch');
    expect(issues[0]!.line).toBe(2);
  });

  it('CASE / CASEELSE 不在 SELECTCASE 里：各报一条无主分支', () => {
    const text = L('CASE "A"', 'CASEELSE', 'ENDSELECT');
    const kinds = checkControlFlowStructure(text).map((i) => i.kind);
    expect(kinds).toEqual(['orphan-branch', 'orphan-branch', 'orphan-close']);
  });

  it('CATCH 前面没有 TRYC：报无主分支（不是孤儿闭合，别混成一类）', () => {
    const text = L('PRINTL 甲', 'CATCH', 'ENDCATCH');
    expect(checkControlFlowStructure(text).map((i) => i.kind)).toEqual(['orphan-branch', 'orphan-close']);
  });

  it('函数边界（下一个 @ 行）把上一个函数没闭合的块揪出来，行号落在开块处', () => {
    const text = L('@AEGI', 'IF A', '\tPRINTL 甲', '@AEGI2', 'IF B', '\tENDIF');
    const issues = checkControlFlowStructure(text);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('unclosed-open');
    expect(issues[0]!.line).toBe(2);
    // 第二个函数体配平，不该被上一函数的账牵连
    expect(issues.some((i) => i.line === 5)).toBe(false);
  });

  it('闭合语句把更深的层吞掉时（IF → REPEAT → ENDIF），报那层的 REND 缺失', () => {
    const text = L('IF A', '\tREPEAT', '\t\tPRINTL 甲', 'ENDIF');
    const issues = checkControlFlowStructure(text);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.statement).toBe('REPEAT');
    expect(issues[0]!.message).toContain('REND');
    expect(issues[0]!.message).toContain('ENDIF');
  });

  it('同一个根因只报一条：分支压在下层块上时，不额外判分支有罪', () => {
    // IF → REPEAT → ELSE：ELSE 的配对类 if 在栈里存在，所以它不算"无主"，
    // 只有那条没闭合的 REPEAT 才是可证明的事实
    const text = L('IF A', '\tREPEAT', '\tELSE', 'ENDIF');
    const issues = checkControlFlowStructure(text);
    expect(issues.map((i) => [i.kind, i.statement])).toEqual([['unclosed-open', 'REPEAT']]);
  });

  it('嵌套里两层同时没闭合 ⇒ 两条都报（不合并、不隐藏）', () => {
    const text = L('IF A', '\tIF B', '\t\tPRINTL 甲');
    const issues = checkControlFlowStructure(text);
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.line)).toEqual([1, 2]);
  });
});

describe('checkControlFlowStructure · 边界与上限', () => {
  it('空文本一条不报（编辑器的空缓冲区不该长波浪线）', () => {
    expect(checkControlFlowStructure('')).toEqual([]);
    expect(checkControlFlowStructure('\n\n   \n')).toEqual([]);
  });

  it('CRLF 与 LF 同一坐标（行号 1 基，与 Monaco 一致）', () => {
    const crlf = ['IF A', '\tPRINTL 甲', ''].join('\r\n');
    const issues = checkControlFlowStructure(crlf);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.line).toBe(1);
  });

  it('崩坏到底的文件也不会刷出无上限的波浪线：封顶且封顶值就是那个数', () => {
    const text = L(...Array.from({ length: MAX_STRUCTURE_ISSUES + 40 }, () => 'IF A'));
    const issues = checkControlFlowStructure(text);
    expect(issues).toHaveLength(MAX_STRUCTURE_ISSUES);
    expect(issues.every((i) => i.kind === 'unclosed-open')).toBe(true);
  });

  it('波浪线指的行，骨架扫描里必须有这一条语句（两套视野不许分叉）', () => {
    // 这是"配对表只在 scanner 一份"那条纪律的机器化：一旦行过滤规则被抄成两份，
    // 这里就会出现"体检查出的行号在骨架里找不到"的形状
    const text = L('@AEGI', ';ENDIF 注释', '[SKIPSTART]', 'ENDIF', '[SKIPEND]', 'IF A', '\tELSE', 'ENDIF', 'ENDIF');
    const stmtLines = new Set(scanControlFlow(text).map((s) => s.line));
    for (const issue of checkControlFlowStructure(text)) {
      expect(stmtLines.has(issue.line), `第 ${issue.line} 行（${issue.statement}）不在骨架里`).toBe(true);
    }
  });
});

describe('checkControlFlowStructure · 修复入口只给得起证据的那一类', () => {
  it('未闭合：带得上闭合词与建议插入行（💡 一键补齐的输入）', () => {
    const issues = checkControlFlowStructure(L('@AEGI', 'IF LOCAL', 'PRINT A'));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'unclosed-open', line: 2, closer: 'ENDIF', fixBeforeLine: 4 });
  });

  it('走到下一个函数才收口：插入点就是那条函数边界，不是文件末尾', () => {
    const issues = checkControlFlowStructure(L('@A', 'IF X', 'PRINT Y', '@B', 'PRINT Z'));
    expect(issues.map((i) => [i.line, i.closer, i.fixBeforeLine])).toEqual([[2, 'ENDIF', 4]]);
  });

  it('被外层闭合吞掉：插入点是那条吞它的语句，不是文件末尾', () => {
    const issues = checkControlFlowStructure(L('@A', 'IF X', 'REPEAT Y', 'ENDIF', 'PRINT Z'));
    expect(issues.map((i) => [i.line, i.closer, i.fixBeforeLine])).toEqual([[3, 'REND', 4]]);
  });

  it('孤儿闭合与无主分支**不带**修复字段（删行是不确定的推断，不给动作）', () => {
    for (const text of [L('@A', 'PRINT X', 'ENDIF'), L('@A', 'PRINT X', 'ELSE')]) {
      const issues = checkControlFlowStructure(text);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.closer).toBeUndefined();
      expect(issues[0]!.fixBeforeLine).toBeUndefined();
    }
  });
});
