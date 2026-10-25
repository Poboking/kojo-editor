/**
 * ERB 声明面体检（P1-3 `#FUNCTION` 收尾 / P1-4 `#DIM` 族）。
 *
 * 判据出处：Era Wiki `Emuera/UserVars`、`Emuera/ERH`、`Emuera/exfunc` §#FUNCTION。
 * 每条用例都对应"引擎直接拒绝加载"或"返回值静默丢失"的真后果，不做风格判断。
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERB_DIALECT_EXTENSIONS } from '@kojo/plugin-api';
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

  it('头指令名跟着结构走（措辞要分变量名 / 宏名）', () => {
    expect(parseDimLine('#DIM X')).toMatchObject({ directive: 'DIM' });
    expect(parseDimLine('#dims X')).toMatchObject({ directive: 'DIMS' });
    expect(parseDimLine('#DIMSTR X')).toMatchObject({ directive: 'DIMSTR' });
    expect(parseDimLine('#DEFINE X 3')).toMatchObject({ directive: 'DEFINE' });
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

describe('dimLineViolations · 六条硬规则', () => {
  const check = (line: string): string[] => {
    const dim = parseDimLine(line);
    expect(dim, line).not.toBeNull();
    return dimLineViolations(dim!);
  };

  it('名字撞引擎指令名 ⇒ error（引擎侧是致命档，整个文件加载失败）', () => {
    expect(check('#DIM PRINT')[0]).toContain('引擎内建指令名');
    expect(check('#DIM INPUT, 3')[0]).toContain('引擎内建指令名');
    expect(check('#DIM REF PRINT')).toHaveLength(1); // 修饰词先剥掉，判的是变量名
    expect(check('#DIMS VARSET, 3')[0]).toContain('引擎内建指令名');
  });

  it('名字撞内建式中函数名（exmeth）同样致命', () => {
    expect(check('#DIM MAX')[0]).toContain('引擎内建式中函数名');
    expect(check('#DIMS STRLENS')[0]).toContain('引擎内建式中函数名');
  });

  it('引擎里被配置门控的 `VARS` / `VARI` 不算指令（eraSQC / eraSQN 真这么写且能加载）', () => {
    expect(check('#DIMS VARS')).toEqual([]);
    expect(check('#DIM VARI')).toEqual([]);
  });

  it('`#DEFINE` 撞名措辞是"宏名"（引擎的 CheckUserMacroName 一档）', () => {
    expect(check('#DEFINE PRINT 3')[0]).toContain('宏名');
  });

  it('只是前缀 / 大小写不敏感 / 普通名字不误报', () => {
    expect(check('#DIM PRIN')).toEqual([]);
    expect(check('#DIM PRINTX')).toEqual([]);
    expect(check('#DIM PRINT_')).toEqual([]);
    expect(check('#DIM print')[0]).toContain('引擎内建指令名'); // Emuera 默认 IgnoreCase
    expect(check('#DIM MY_PRINT')).toEqual([]);
  });

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

  it('撞引擎保留名的行也走 dim-invalid / error，statement 给的是变量名', () => {
    const text = ['@F', '#DIM PRINT', '#DIM MAX', '#DIM 普通'].join('\n');
    const issues = checkDeclarationIssues(text);
    expect(issues.map((i) => [i.kind, i.severity, i.line, i.statement])).toEqual([
      ['dim-invalid', 'error', 2, 'PRINT'],
      ['dim-invalid', 'error', 3, 'MAX'],
    ]);
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

/**
 * 撞名规则的语料闸（A3）。
 *
 * 钉的是"这条规则在真代码上静音"这件事本身——不是风格问题：真撞上引擎指令名
 * 的 `#DIM` 会让 Emuera 拒绝整个文件，所以真语料里几乎不可能有；一旦闸红，
 * 要么词表混进了不存在的名字，要么某盘真的有一条加载不了的声明。
 *
 * 8 盘实测（eraNAS 4145 / eraTW 3971 / eraKoumakan 408 / eraSQC 351 / eraSQN 363 /
 * eratohoK 2563 / eraNTR 218 / erafl 2128 文件，合计 143,167 行 `#DIM` 族）= **0 命中**。
 * eraSQC/eraSQN 的 `#DIMS VARS` 是 2 条唯一的近似命中，已按配置门控排除（见
 * `src/instructions.ts` 表头）。
 */
const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;

function dialectFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if ((ERB_DIALECT_EXTENSIONS as readonly string[]).includes(path.extname(p).toLowerCase())) out.push(p);
    }
  }
  return out.sort();
}

describe('A3 · 名字撞引擎保留名 × 真语料', () => {
  it.skipIf(!SMOKE)(
    '真语料里一条都不该有（走 checkDeclarationIssues 的完整路径）',
    { timeout: 900_000 },
    () => {
      const files = dialectFiles(path.join(SMOKE!, 'ERB'));
      expect(files.length).toBeGreaterThan(1_000);

      const hits: string[] = [];
      let dimLines = 0;
      for (const p of files) {
        const text = readFileSync(p, 'utf8');
        for (const issue of checkDeclarationIssues(text)) {
          if (!issue.message.includes('引擎内建')) continue;
          hits.push(`${path.relative(SMOKE!, p)}:${issue.line} ${issue.statement}`);
        }
        // 同一条正则做分母，保证"0 命中"不是因为一条声明都没读到
        dimLines += text.split('\n').filter((l) => /^\s*#(DIMSTR|DIMCHAR|DIMF|DIMS|DIM|DEFINE)\s+/i.test(l)).length;
      }
      expect(dimLines).toBeGreaterThan(10_000);
      expect(hits).toEqual([]);
    },
  );
});
