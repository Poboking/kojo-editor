import { describe, expect, it } from 'vitest';
import type { LineDecoration } from '@kojo/plugin-api';
import {
  checkControlFlowStructure,
  checkStructure,
  checkStructureReport,
  MAX_STRUCTURE_ISSUES,
  STRUCTURE_TRUNCATED_CODE,
} from '../src/structure';
import { structureDiagnostic, buildStructureFixes } from '../src/structure-fix';
import { erbStructureDecorations } from '../src/offload';
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

  it('汉字起首的定义行同样是函数边界（2026-10-16 修复：起始类扩到 ERB 标识符全集）', () => {
    // 修复前：@日本語関数 不认成边界 ⇒ A 函数未闭合的 IF 被 B 函数的 ENDIF 吸收
    //（0 报，跨函数串栈——A 的真缺陷被抹掉，B 的合法 ENDIF 被当成 A 的账）
    const issues = checkControlFlowStructure(L('@AEGI', 'IF A', '@日本語関数', 'ENDIF'));
    expect(issues.map((i) => [i.kind, i.line])).toEqual([
      ['unclosed-open', 2],
      ['orphan-close', 4],
    ]);
  });

  it('CJK / 全角拉丁起首的函数名：体配平时一条都不报（修复不得制造假边界）', () => {
    expect(
      checkControlFlowStructure(L('@日本語関数', 'IF A', '\tPRINTL 甲', 'ENDIF', '@ＥＲＢ処理', 'IF B', 'ENDIF')),
    ).toEqual([]);
  });

  it('`@"` 续行仍然不是边界：续行不当新函数收口、ENDIF 照常配对（排除机制不被误伤）', () => {
    const text = L('@AEGI', 'IF A', '\t@"给%CALLNAME:TARGET%使用（剩余{ITEM:45}枚）",ITEM:45,', '\tENDIF');
    expect(checkControlFlowStructure(text)).toEqual([]);
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

/* ========================================================================== *
 * D04b：截断必须出声
 *
 * `MAX_STRUCTURE_ISSUES` 到顶后不再追加条目——那是显示预算（Monaco 不画上千个 marker），
 * 不是"这个文件只有 50 个错"。这一组钉的是**消费方把这件事说出来**：
 * `checkStructureReport.text.truncated` 给真实计数，装饰器把它变成屏幕上的第 51 条。
 * 构造口径：一行一个未闭合的 `IF`（`flushOpen` 在文件结尾把它们全部报成 unclosed-open），
 * 所以"真实条数 = 行数"是**可手算**的，不是拿生产方的输出当自己的期望值。
 * ========================================================================== */

/** n 条互不配平的开块（每条一个 unclosed-open） */
const stormOf = (n: number): string => L(...Array.from({ length: n }, () => 'IF A'));

const truncationEntries = (decorations: readonly LineDecoration[]): LineDecoration[] =>
  decorations.filter((d) => d.code === STRUCTURE_TRUNCATED_CODE);

describe('D04b · 截断计数（checkStructureReport 的 truncated 是真实溢出量）', () => {
  it('60 条 ⇒ 上屏 50 + 截断 10（数到顶之后继续数，不建对象）', () => {
    const text = stormOf(60);
    const report = checkStructureReport(text);
    expect(report.issues).toHaveLength(MAX_STRUCTURE_ISSUES);
    expect(report.truncated).toBe(10);
    // 与 `checkStructure` 同一处判据：列表逐字相同
    expect(report.issues).toEqual(checkStructure(text));
  });

  it('崩到 120 条也不会只会回一个"到顶"：truncated = 120 − 50 = 70（溢出量不是 0 也不是封顶值）', () => {
    const report = checkStructureReport(stormOf(120));
    expect(report.issues).toHaveLength(MAX_STRUCTURE_ISSUES);
    expect(report.truncated).toBe(70);
  });

  it('两张栈的溢出都算进去（预处理块 30 条 + 控制流 40 条 = 70 ⇒ 截断 20）', () => {
    const text = L(
      ...Array.from({ length: 30 }, () => '[ENDIF]'),
      ...Array.from({ length: 40 }, () => 'ENDIF'),
    );
    const report = checkStructureReport(text);
    expect(report.issues).toHaveLength(MAX_STRUCTURE_ISSUES);
    expect(report.truncated).toBe(20);
  });

  it('正好到顶不算截断（50 条就是 50 条：列表是完整的）', () => {
    expect(checkStructureReport(stormOf(MAX_STRUCTURE_ISSUES)).truncated).toBe(0);
  });

  it('没到顶 ⇒ truncated 恒 0（不许给正常文件挂"还有 N 条"）', () => {
    expect(checkStructureReport(stormOf(3)).truncated).toBe(0);
    expect(checkStructureReport('').truncated).toBe(0);
    expect(checkStructureReport(L('@A', 'IF X', 'PRINT Y', 'ENDIF')).truncated).toBe(0);
  });
});

describe('D04b · 装饰器补一句（截断可观测的那一条）', () => {
  it('60 条 ⇒ 装饰器返回 51 条，最后一条是 info / 新码 / 同一来源，文案带真实条数', () => {
    const text = stormOf(60);
    const decorations = erbStructureDecorations({ path: 'a.erb', text });
    expect(decorations).toHaveLength(MAX_STRUCTURE_ISSUES + 1);
    // 前 50 条仍是结构发现，形状没被这一条挤动（既有五字段那份逐字相等）
    expect(decorations.slice(0, MAX_STRUCTURE_ISSUES).every((d) => d.code === 'erb.unclosed-open')).toBe(true);
    expect(decorations[0]).toEqual(structureDiagnostic(checkStructure(text)[0]!));

    const tail = decorations[MAX_STRUCTURE_ISSUES]!;
    expect(tail).toMatchObject({ severity: 'info', code: STRUCTURE_TRUNCATED_CODE, source: 'erb-structure' });
    expect(tail.message).toContain(String(MAX_STRUCTURE_ISSUES));
    expect(tail.message).toContain('10');
    expect(tail.message, '文案要说清"没列出来"这件事（不许只说"问题太多"）').toContain('没列出来');
  });

  it('数对了才说话：120 条 ⇒ 文案里的"另有 N 条"就是 70', () => {
    const text = stormOf(120);
    const entries = truncationEntries(erbStructureDecorations({ path: 'a.erb', text }));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toContain('70');
  });

  it('没截断的文件上**不出现**这一条（一条都不用补）', () => {
    for (const text of [stormOf(3), stormOf(MAX_STRUCTURE_ISSUES), L('@A', 'IF X', 'ENDIF')]) {
      expect(truncationEntries(erbStructureDecorations({ path: 'a.erb', text }))).toEqual([]);
    }
  });
});

describe('D04b · 这条信息不污染 💡 快速修复面', () => {
  it('`buildStructureFixes` 的 diagnostics 里没有这枚码（没有可修的东西）', () => {
    const text = stormOf(60);
    const fixes = buildStructureFixes(text);
    expect(fixes.length, '风暴文件上本来就有 unclosed-open 的动作').toBeGreaterThan(0);
    expect(fixes.some((f) => f.diagnostic.code === STRUCTURE_TRUNCATED_CODE)).toBe(false);
  });

  it('宿主把整份装饰列表（含这一条）点名为 requested，也答不出动作', () => {
    const text = stormOf(60);
    const decorations = erbStructureDecorations({ path: 'a.erb', text });
    const tailLine = decorations[MAX_STRUCTURE_ISSUES]!.line;
    const answered = buildStructureFixes(text, tailLine, decorations);
    expect(answered.some((f) => f.diagnostic.code === STRUCTURE_TRUNCATED_CODE)).toBe(false);
  });

  it('它不是结构发现：`checkStructure` 的每一条仍是 `erb.${kind}`（新码不混进那个联合）', () => {
    const codes = new Set(checkStructure(stormOf(60)).map((issue) => `erb.${issue.kind}`));
    expect(codes.has(STRUCTURE_TRUNCATED_CODE)).toBe(false);
  });
});
