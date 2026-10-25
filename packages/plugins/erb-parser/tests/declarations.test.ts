/**
 * ERB 声明面体检（P1-3 `#FUNCTION` 收尾 / P1-4 `#DIM` 族）。
 *
 * 判据出处：Era Wiki `Emuera/UserVars`、`Emuera/ERH`、`Emuera/exfunc` §#FUNCTION。
 * 每条用例都对应"引擎直接拒绝加载"或"返回值静默丢失"的真后果，不做风格判断。
 */
import { describe, expect, it } from 'vitest';
import { checkDeclarationIssues, dimLineViolations, parseDimLine } from '../src/declarations';

describe('parseDimLine · 真语料里的声明形态', () => {
  it('一维 + 元素数 / 多维冒号段', () => {
    expect(parseDimLine('#DIM X, 10')).toMatchObject({ name: 'X', elements: '10' });
    expect(parseDimLine('#DIM MAP:10:20')).toMatchObject({ name: 'MAP', dims: ['10', '20'] });
  });

  it('修饰词逐个剥离（含多枚叠写）', () => {
    expect(parseDimLine('#DIM DYNAMIC CNT_CHARA, 10')).toMatchObject({ modifiers: ['DYNAMIC'], name: 'CNT_CHARA' });
    expect(parseDimLine('#DIM CONST SAVEDATA X = 1')).toMatchObject({ modifiers: ['CONST', 'SAVEDATA'], name: 'X' });
  });

  it('元素数是常量名 / 初值是字符串表 / #DEFINE 裸值形', () => {
    expect(parseDimLine('#DIMS SORT_TARGET, LIST_MAX_SORT')).toMatchObject({ name: 'SORT_TARGET', elements: 'LIST_MAX_SORT' });
    expect(parseDimLine('#DIMS 賭け = "丁","半"')).toMatchObject({ name: '賭け', inits: ['"丁"', '"半"'] });
    expect(parseDimLine('#DEFINE TEST_CONST 3')).toMatchObject({ name: 'TEST_CONST', elements: '3' });
  });

  it('初值摊在行连接块里 ⇒ 个数未知（null），不猜', () => {
    expect(parseDimLine('#DIM CONST X = {')).toMatchObject({ name: 'X', inits: null });
    expect(parseDimLine('#DIM CONST X =')).toMatchObject({ name: 'X', inits: null });
  });

  it('行内注释截断；非 `#DIM` 族行返回 null', () => {
    expect(parseDimLine('#DIM X, 10 ; 注释')).toMatchObject({ name: 'X', elements: '10' });
    expect(parseDimLine('#FUNCTION')).toBeNull();
    expect(parseDimLine('PRINTL X')).toBeNull();
  });
});

describe('dimLineViolations · 五条硬规则', () => {
  const check = (line: string): string[] => {
    const dim = parseDimLine(line);
    expect(dim, line).not.toBeNull();
    return dimLineViolations(dim!);
  };

  it('维数超过 3 维', () => {
    expect(check('#DIM X:1:2:3')).toEqual([]);
    expect(check('#DIM X:1:2:3:4')[0]).toContain('最多 3 维');
  });

  it('CONST 必须有初值', () => {
    expect(check('#DIM CONST X, 3')).toHaveLength(1);
    expect(check('#DIM CONST X = 1, 2, 3')).toEqual([]);
    expect(check('#DIM CONST X = {')).toEqual([]); // 行连接块里给了初值
  });

  it('CONST 不能与 GLOBAL / SAVEDATA / REF / DYNAMIC 并用', () => {
    for (const mod of ['GLOBAL', 'SAVEDATA', 'REF', 'DYNAMIC']) {
      const v = check(`#DIM CONST ${mod} X = 1`);
      expect(v, mod).toHaveLength(1);
      expect(v[0]).toContain(mod);
    }
    expect(check('#DIM CONST LOCAL X = 1')).toEqual([]); // LOCAL 不冲突
  });

  it('REF 的元素数必须写 0（多格空槽 / 多格 0 都是合法写法）', () => {
    expect(check('#DIM REF X, 0')).toEqual([]);
    expect(check('#DIM REF X')).toEqual([]);
    expect(check('#DIM REF 集合,,')).toEqual([]); // 真语料：两格空槽
    expect(check('#DIM REF カラーマトリクス, 0, 0')).toEqual([]); // 真语料：两格 0
    expect(check('#DIM REF X, 5')).toHaveLength(1);
    expect(check('#DIM REF X, 0, 5')).toHaveLength(1);
  });

  it('初值个数不得多于元素数（元素数是字面量时才判）', () => {
    expect(check('#DIM X, 3 = 1, 2, 3')).toEqual([]);
    expect(check('#DIM X, 3 = 1, 2, 3, 4')).toHaveLength(1);
    expect(check('#DIMS X, SOME_MAX = 1, 2, 3, 4, 5')).toEqual([]); // 元素数是常量名 ⇒ 无从判断
  });
});

describe('checkDeclarationIssues · 文本级体检', () => {
  it('`#DIM` 违规逐行产 dim-invalid / error，带行号与变量名', () => {
    const text = ['#DIM CONST X, 3', '#DIM REF Y, 5', '#DIM OK, 3 = 1,2,3'].join('\n');
    const issues = checkDeclarationIssues(text);
    expect(issues.map((i) => [i.kind, i.severity, i.line, i.statement])).toEqual([
      ['dim-invalid', 'error', 1, 'X'],
      ['dim-invalid', 'error', 2, 'Y'],
    ]);
  });

  it('停用区里的声明不看（引擎不编译那段）', () => {
    expect(checkDeclarationIssues(['[SKIPSTART]', '#DIM CONST X, 3', '[SKIPEND]'].join('\n'))).toEqual([]);
  });

  it('`#FUNCTION` 体内裸 RETURN → return-form / warning；RETURNF 与普通函数不误报', () => {
    const text = [
      '@EXPR', // 1
      '#FUNCTION', // 2
      'RETURNF 1', // 3
      'RETURN', // 4 ← 裸 RETURN
      '@NORMAL', // 5
      'RETURN', // 6
    ].join('\n');
    const issues = checkDeclarationIssues(text);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'return-form', severity: 'warning', line: 4, statement: 'RETURN' });
    expect(issues[0]!.message).toContain('EXPR');
  });

  it('`#FUNCTION` 写在 `@` 行之前同样认（扫描器同一条宽容口径）', () => {
    const text = ['#FUNCTION', '@EXPR', 'RETURN'].join('\n');
    expect(checkDeclarationIssues(text).map((i) => i.line)).toEqual([3]);
  });

  it('停用区里的裸 RETURN 不报（真语料 3 处全是这种形态）', () => {
    const text = ['@EXPR', '#FUNCTION', '[SKIPSTART]', 'RETURN', '[SKIPEND]', 'RETURNF 1'].join('\n');
    expect(checkDeclarationIssues(text)).toEqual([]);
  });

  it('`@"…"` 续行不被当成函数头（名字必须像标识符）', () => {
    const text = ['@EXPR', '#FUNCTION', 'CALL F, @"文本", 1', 'RETURN'].join('\n');
    // 续行不切函数头 ⇒ 后续 RETURN 仍归 EXPR
    expect(checkDeclarationIssues(text).map((i) => i.line)).toEqual([4]);
  });
});
