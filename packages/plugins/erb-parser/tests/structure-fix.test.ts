import { describe, expect, it } from 'vitest';
import {
  applyStructureFix,
  buildStructureFixes,
  structureDiagnostic,
} from '../src/structure-fix';
import { checkControlFlowStructure, structureIssueCode } from '../src/structure';

/**
 * 结构体检的**一键补齐**单测（2026-10-13 反馈 7 的第二步）。
 *
 * 这一份守的是"改完要对"：每条用例都跑**闭环**——补完之后必须再体检一次得零报告。
 * 只断言"生成了 edits"是没有用的：插入点错一行，波浪线会立刻消失，但文件读起来
 * 就不是作者要的那个意思了。闭环 + 反证（不补就还是红的）才叫修好。
 *
 * 坐标口径与 `structure.ts` 一致（1 基、EOL 归一）；这里刻意用 `\n` 与 `\r\n` 各写一份，
 * 因为宿主给的是原始文本，而 ERB 语料是 CRLF。
 */

const L = (...lines: string[]): string => lines.join('\n');

/** 补齐 → 复检必须干净；顺手断言只多了 `addedLines` 行（这些形状都只有一条未闭合） */
function expectFixed(text: string, cursorLine?: number, addedLines = 1): string {
  const fixes = buildStructureFixes(text, cursorLine);
  expect(fixes.length, '修复条数不是 1：' + JSON.stringify(checkControlFlowStructure(text))).toBe(1);
  const base = text.replace(/\r\n?/g, '\n');
  const out = applyStructureFix(base, fixes[0]!);
  expect(out.split('\n').length).toBe(base.split('\n').length + addedLines);
  expect(checkControlFlowStructure(out)).toEqual([]);
  return out;
}

describe('buildStructureFixes · 函数末尾补闭合', () => {
  it('IF 走到文件尾没关 ⇒ 末尾补 ENDIF，补完复检为零', () => {
    const text = L('@AEGI', 'IF LOCAL', 'PRINT A');
    const out = expectFixed(text);
    expect(out).toBe(L('@AEGI', 'IF LOCAL', 'PRINT A', 'ENDIF'));
  });

  it('文件以换行收尾 ⇒ 用那最后一行空行，不额外叠一层空白', () => {
    const text = L('@A', 'IF A', '');
    const out = expectFixed(text, undefined, 0);
    expect(out).toBe(L('@A', 'IF A', 'ENDIF'));
  });

  it('CRLF 原语料：坐标与 LF 同一套，补完照样干净', () => {
    const text = ['@AEGI', 'IF LOCAL', 'PRINT A'].join('\r\n');
    const fixes = buildStructureFixes(text, 2);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]!.edits[0]!.fromLine).toBe(3);
    expect(fixes[0]!.title).toContain('文件末尾');
  });

  it('缩进跟着开块那一行走（ERB 不靠缩进语法，但作者靠缩进读层次）', () => {
    const out = expectFixed(L('@A', '\tIF LOCAL', '\t\tPRINT X'));
    expect(out).toBe(L('@A', '\tIF LOCAL', '\t\tPRINT X', '\tENDIF'));
  });
});

describe('buildStructureFixes · 插入点由配对器给出，不是猜的', () => {
  it('下一个函数已经开始 ⇒ 补在函数边界**之前**，绝不补进下一个函数里', () => {
    const text = L('@A', 'IF LOCAL', 'PRINT X', '@B', 'PRINT Y');
    const fix = buildStructureFixes(text, 2)[0]!;
    expect(fix.title).toContain('第 4 行之前');
    expect(applyStructureFix(text.replace(/\r\n?/g, '\n'), fix)).toBe(
      L('@A', 'IF LOCAL', 'PRINT X', 'ENDIF', '@B', 'PRINT Y'),
    );
    expectFixed(text);
  });

  it('被更外层的闭合语句吞掉（IF → REPEAT → ENDIF）⇒ 补 REND 在那条 ENDIF 之前', () => {
    const text = L('@A', 'IF LOCAL', 'REPEAT A', 'ENDIF', 'PRINT X');
    const issues = checkControlFlowStructure(text);
    expect(issues.map((i) => [i.kind, i.line, i.statement, i.closer])).toEqual([['unclosed-open', 3, 'REPEAT', 'REND']]);
    const fix = buildStructureFixes(text, 3)[0]!;
    expect(applyStructureFix(text, fix)).toBe(L('@A', 'IF LOCAL', 'REPEAT A', 'REND', 'ENDIF', 'PRINT X'));
    expectFixed(text);
  });

  it('同函数两层都没关 ⇒ 两条动作各自独立，逐条补下去最终干净', () => {
    const text = L('@A', 'IF X', 'REPEAT Y', 'PRINT Z');
    const both = buildStructureFixes(text);
    expect(both.map((f) => f.issueLine)).toEqual([2, 3]);
    let cur = text;
    for (let i = 0; i < 5; i++) {
      const fs = buildStructureFixes(cur);
      if (fs.length === 0) break;
      cur = applyStructureFix(cur, fs[0]!);
    }
    expect(cur.split('\n')).toEqual(['@A', 'IF X', 'REPEAT Y', 'PRINT Z', 'REND', 'ENDIF']);
    expect(checkControlFlowStructure(cur)).toEqual([]);
  });

  it('十一种配对类各自的闭合词都补得对（表在 scanner，这里逐条验一遍出口）', () => {
    const cases: Array<[string, string]> = [
      ['IF A', 'ENDIF'],
      ['SELECTCASE A', 'ENDSELECT'],
      ['FOR LOCAL = 0 TO 3', 'NEXT'],
      ['WHILE A', 'WEND'],
      ['REPEAT A', 'REND'],
      ['DO', 'LOOP'],
      ['DATALIST', 'ENDLIST'],
      ['STRDATA', 'ENDDATA'],
      ['NOSKIP', 'ENDNOSKIP'],
      ['PRINTDATA', 'ENDDATA'],
      ['TRYCCALL FOO', 'ENDCATCH'],
      ['TRYCALLLIST', 'ENDFUNC'],
    ];
    for (const [open, closer] of cases) {
      const text = L('@A', open, 'PRINT X');
      const fix = buildStructureFixes(text, 2)[0]!;
      expect(fix.edits[0]!.newText, open + ' 应补 ' + closer).toBe('PRINT X\n' + closer);
      expectFixed(text);
    }
  });
});

describe('buildStructureFixes · 不确定就不给动作', () => {
  it('孤儿闭合（多写的 ENDIF）**不给删除动作**：漏判函数边界也会长成这个样子', () => {
    const text = L('@A', 'PRINT X', 'ENDIF');
    expect(checkControlFlowStructure(text).map((i) => i.kind)).toEqual(['orphan-close']);
    expect(buildStructureFixes(text)).toEqual([]);
  });

  it('无主分支（ELSE / CASE / CATCH）同样不给动作', () => {
    for (const line of ['ELSE', 'CASE 1', 'CATCH']) {
      const text = L('@A', 'PRINT X', line);
      expect(checkControlFlowStructure(text).map((i) => i.kind)).toEqual(['orphan-branch']);
      expect(buildStructureFixes(text)).toEqual([]);
    }
  });

  it('配平的文件没有任何动作（不空转）', () => {
    const text = L('@A', 'IF X', 'PRINT Y', 'ENDIF');
    expect(buildStructureFixes(text)).toEqual([]);
    expect(buildStructureFixes(text, 2)).toEqual([]);
  });

  it('空文本 / 只有函数头 ⇒ 没有结构问题也没有动作', () => {
    expect(buildStructureFixes('')).toEqual([]);
    expect(buildStructureFixes(L('@A'))).toEqual([]);
  });

  it('光标筛只留波浪线那一行的动作：💡 出现在作者正看着的地方', () => {
    const text = L('@A', 'IF X', 'PRINT Y', '@B', 'REPEAT Z', 'PRINT W');
    expect(buildStructureFixes(text).map((f) => f.issueLine)).toEqual([2, 5]);
    expect(buildStructureFixes(text, 2).map((f) => f.issueLine)).toEqual([2]);
    expect(buildStructureFixes(text, 3)).toEqual([]);
  });

  it('修完就再无修复（幂等，不会把同一行补两次）', () => {
    const text = L('@A', 'IF X', 'PRINT Y');
    const once = applyStructureFix(text, buildStructureFixes(text, 2)[0]!);
    expect(buildStructureFixes(once)).toEqual([]);
  });
});

/* ================= B9：波浪线 ↔ 快速修复的关联键 ================= */

/**
 * 这一段钉的是"**Ctrl+. 落在哪条红线上，就拿得到那一条的修复**"的因：
 * 诊断形状只有一份（`structureDiagnostic`），匹配只认 `code` + 行，
 * 对不上就**没有动作**——不是"给个差不多的动作"。
 */
describe('structureDiagnostic · 波浪线与修复共用同一份形状', () => {
  const text = L('@AEGI', 'IF LOCAL', '\tPRINTL 甲');
  const issue = checkControlFlowStructure(text)[0]!;

  it('诊断的四个字段逐一对应那条发现（码走 `structureIssueCode`，不复述第二遍）', () => {
    expect(structureDiagnostic(issue)).toEqual({
      line: issue.line,
      severity: 'error',
      message: issue.message,
      code: structureIssueCode(issue),
    });
    expect(structureIssueCode(issue)).toBe('erb.unclosed-open');
  });

  it('修复动作携带的就是那一条 ⇒ 与装饰器给宿主的是同一份数据（关联不可能断）', () => {
    const fix = buildStructureFixes(text, 2)[0]!;
    expect(fix.diagnostic).toEqual(structureDiagnostic(checkControlFlowStructure(text)[0]!));
    expect(fix.diagnostic.line).toBe(fix.issueLine);
  });
});

describe('buildStructureFixes · 按宿主点明的诊断应答（B9）', () => {
  const two = L('@A', 'IF X', 'PRINT Y', '@B', 'REPEAT Z', 'PRINT W');

  it('给了诊断就**只**答对得上的那些：同一行另一族问题不进这次菜单', () => {
    const fixes = buildStructureFixes(two);
    expect(fixes.map((f) => f.issueLine)).toEqual([2, 5]);
    const asked = [fixes[1]!.diagnostic];
    expect(buildStructureFixes(two, 5, asked).map((f) => f.issueLine)).toEqual([5]);
    // 宿主按区间给出的 `line` 与 `requested` 指向同一条时才会出动作（两个约束取交集）
    expect(buildStructureFixes(two, 2, asked)).toEqual([]);
  });

  it('空诊断数组 ⇒ 零动作（区间里没有波浪线，就没有"这条诊断的修复"可给）', () => {
    expect(buildStructureFixes(two, 2, [])).toEqual([]);
  });

  it('`code` 对不上 ⇒ 不给动作（**不假装能修**：孤儿闭合至今没有安全修法）', () => {
    const orphan = L('@A', 'PRINT X', 'ENDIF');
    const issue = checkControlFlowStructure(orphan)[0]!;
    expect(structureIssueCode(issue)).toBe('erb.orphan-close');
    expect(buildStructureFixes(orphan, 3, [structureDiagnostic(issue)])).toEqual([]);
  });

  it('宿主没给诊断（旧宿主 / 非编辑器消费方）⇒ 沿用行判据，行为与改动前一致', () => {
    expect(buildStructureFixes(two, 2).map((f) => f.issueLine)).toEqual([2]);
    expect(buildStructureFixes(two).map((f) => f.issueLine)).toEqual([2, 5]);
  });

  it('行号对不上但码相同 ⇒ 依旧不答（匹配是 code+行，不是"同一个码就万事大吉"）', () => {
    const asked = { line: 99, severity: 'error' as const, message: '别处的', code: 'erb.unclosed-open' };
    expect(buildStructureFixes(two, undefined, [asked])).toEqual([]);
  });
});
