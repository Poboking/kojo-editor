import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { ERH_ALLOWED_DIRECTIVES, checkHeaderIssues } from '../src/erh';
import { MAX_STRUCTURE_ISSUES, checkStructure } from '../src/structure';

/**
 * `.ERH` 形态判据（A4 · P1-4 第七条）。
 *
 * 这一份钉的是**行可见性与白名单**两件事：
 * - 引擎看到的行不是文件行——空行 / 注释 / `;!;` 前缀 / `{`…`}` 行连接都会改变"哪一行被看见了"，
 *   判据必须与 `EraStreamReader.ReadEnabledLine` 同口径，否则在合法文件上满屏假红
 *   （8 盘语料里 54 份 `.ERH` 用 `{}` 摊字符串表）；
 * - 允许的头只有 `#DEFINE` / `#DIM` / `#DIMS`（`#FUNCTION` 的加载器实现体是
 *   `throw new NotImplCodeEE()`，等价于不认）。
 */

const lines = (...xs: string[]): string => xs.join('\n');

describe('checkHeaderIssues · 形状', () => {
  it('三种合法头 + 注释 + 空行 + 全角空格行 ⇒ 零报告', () => {
    const text = lines(
      '; 变量定义',
      '',
      '#DIM X, 10',
      '#DIMS Y = "甲", "乙"',
      '#DEFINE FOO 1',
      '   ',
      '\u3000\u3000',
      '\t#DIM Z, 3',
    );
    expect(checkHeaderIssues(text)).toEqual([]);
  });

  it('指令名大小写不敏感（引擎用 OrdinalIgnoreCase 比较）', () => {
    expect(checkHeaderIssues(lines('#dim x, 10', '#Dims y = "a"', '#define f 1'))).toEqual([]);
  });

  it('行尾 `;` 注释不影响头的判定', () => {
    expect(checkHeaderIssues(lines('#DIM X, 10 ; 说明', '#DEFINE FOO 1 ;说明'))).toEqual([]);
  });

  it('非 `#` 行 ⇒ 一条 error，行号 / statement / 文案齐备', () => {
    const issues = checkHeaderIssues(lines('#DIM X, 10', '', 'PRINTL 甲'));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'erh-invalid', severity: 'error', line: 3, statement: 'PRINTL' });
    expect(issues[0]!.message).toContain('#DIM');
    expect(issues[0]!.message).toContain('中止');
  });

  it('`#FUNCTION` / `#FUNCTIONS` 给专文案（指出去 .ERB 写）', () => {
    for (const head of ['#FUNCTION', '#FUNCTIONS']) {
      const issues = checkHeaderIssues(lines(head, '@EXPR', 'RETURNF 1'));
      expect(issues).toHaveLength(3); // #FUNCTION + @EXPR + 正文语句，一条都留不下
      expect(issues[0]).toMatchObject({ line: 1, statement: head });
      expect(issues[0]!.message).toContain('NotImplemented');
      expect(issues[0]!.message).toContain('.ERB');
    }
  });

  it('白名单外的指令（#DIMSTR / #DIMCHAR / #IF / #DIMF）逐条报，文案带指令名', () => {
    const issues = checkHeaderIssues(lines('#DIMSTR A, 10', '#DIMCHAR B, 3', '#IF DEBUG', '#DIMF C'));
    expect(issues.map((i) => i.statement)).toEqual(['#DIMSTR', '#DIMCHAR', '#IF', '#DIMF']);
    for (const i of issues) expect(i.message).toContain(i.statement);
  });

  it('`#` 后没有指令名（含 `# DIM` 的写法）⇒ 一条', () => {
    const issues = checkHeaderIssues(lines('#', '# DIM X, 1'));
    expect(issues.map((i) => i.statement)).toEqual(['#', '#']);
    expect(issues[0]!.message).toContain('指令名');
  });

  it('空白文本 ⇒ 零报告', () => {
    expect(checkHeaderIssues('')).toEqual([]);
    expect(checkHeaderIssues('\n\n  \n')).toEqual([]);
  });
});

describe('checkHeaderIssues · 行可见性（不能逐行看）', () => {
  it('`;!;` / `;#;` 是代码前缀，不是注释', () => {
    expect(checkHeaderIssues(lines(';!;#DIM X, 10', ';#;#DIMS Y = "a"'))).toEqual([]);
    // 前缀后面写普通语句仍然要报
    expect(checkHeaderIssues(lines(';!;PRINTL 甲')).map((i) => i.statement)).toEqual(['PRINTL']);
  });

  it('前缀与正文之间允许空白', () => {
    expect(checkHeaderIssues(lines(';!;   #DIM X, 10'))).toEqual([]);
  });

  it('注释行不参与判定（含写着 #DIM 的注释）', () => {
    expect(checkHeaderIssues(lines('; #DIM X, 10', ';!;', ';'))).toEqual([]);
  });

  it('`{`…`}` 行连接合流成一条逻辑行 ⇒ 合法', () => {
    const text = lines(
      '#DIM SAVEDATA CHARADATA 衣装損壊率, CLOTH_PART_NUM',
      '',
      '{',
      '    #DIMS CONST CLOTH_PART_NAME = ',
      '        "头部", "颈部", "上衣", ',
      '        "下衣", "大衣"',
      '}',
    );
    expect(checkHeaderIssues(text)).toEqual([]);
  });

  it('块内出现非声明 ⇒ 一条，行号指 `{` 那一行（作者要改的是块头）', () => {
    const issues = checkHeaderIssues(lines('#DIM X, 1', '{', 'PRINTL 甲', '}'));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ line: 2, statement: 'PRINTL' });
  });

  it('块内空行不影响合流（引擎 append 空串）', () => {
    expect(checkHeaderIssues(lines('{', '#DIMS X = "a",', '', '"b"', '}'))).toEqual([]);
  });

  it('落单的 `}` ⇒ 一条', () => {
    expect(checkHeaderIssues(lines('}', '#DIM X, 1')).map((i) => [i.line, i.statement])).toEqual([[1, '}']]);
  });

  it('收束行 `}` 后面还有内容 ⇒ 一条；块内正文不再判（引擎在收束处就中止）', () => {
    const issues = checkHeaderIssues(lines('{', 'PRINTL 甲', '} ;尾巴'));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('收束行');
  });

  it('块内再开 `{` ⇒ 一条', () => {
    const issues = checkHeaderIssues(lines('{', '#DIM X, 1', '{', '}'));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('不能再开');
  });

  it('块没有收束 ⇒ 一条，行号指 `{` 那一行', () => {
    const issues = checkHeaderIssues(lines('#DIM X, 1', '{', '#DIM Y, 2'));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ line: 2, statement: '{' });
    expect(issues[0]!.message).toContain('没有收束');
  });

  it('`{` 不单独占一行 ⇒ 一条（引擎 CharacterAfterContinuation）', () => {
    const issues = checkHeaderIssues(lines('{ #DIM X, 1', '}'));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('单独占一行');
  });

  it('块内没有任何内容 ⇒ 一条（空逻辑行同样不是 # 开头）', () => {
    const issues = checkHeaderIssues(lines('{', '}', '#DIM X, 1'));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('没有任何内容');
  });

  it('CRLF 与 CR 行尾同口径（行号不漂）', () => {
    const text = '#DIM X, 1\r\nPRINTL 甲\r\n#DIM Y, 2';
    expect(checkHeaderIssues(text).map((i) => i.line)).toEqual([2]);
  });
});

describe('checkHeaderIssues · 护栏与常量', () => {
  it('允许的头就是三枚，`#FUNCTION` 不在里面（加它等于把 NotImplemented 放行）', () => {
    expect([...ERH_ALLOWED_DIRECTIVES].sort()).toEqual(['DEFINE', 'DIM', 'DIMS']);
  });

  it('病态文件不刷爆内存：自身上限 200 条', () => {
    const many = Array.from({ length: 260 }, (_, i) => `PRINTL ${i}`).join('\n');
    expect(checkHeaderIssues(many)).toHaveLength(200);
  });

  it('实际语料口径下不会超过展示上限（与 checkStructure 合并后才截 50）', () => {
    const many = Array.from({ length: 80 }, (_, i) => `PRINTL ${i}`).join('\n');
    expect(checkStructure(many, 'C:/game/ERB/A.ERH')).toHaveLength(MAX_STRUCTURE_ISSUES);
  });
});

describe('checkStructure(text, path) · 按文件种类分派（additive 第二参）', () => {
  const bad = ['#DIM X, 10', 'PRINTL 甲'].join('\n');

  it('`.erh` 才跑头文件一趟', () => {
    expect(checkStructure(bad, 'C:/game/ERB/DIM.ERH').map((i) => i.kind)).toEqual(['erh-invalid']);
    expect(checkStructure(bad, 'C:/game/ERB/DIM.erh').map((i) => i.kind)).toEqual(['erh-invalid']);
  });

  it('正文方言与非方言一律不跑（老行为逐字不变）', () => {
    expect(checkStructure(bad, 'C:/game/ERB/MAIN.ERB')).toEqual([]);
    expect(checkStructure(bad, 'C:/game/ERB/MAIN.erm')).toEqual([]);
    expect(checkStructure(bad, 'C:/notes/readme.md')).toEqual([]);
    expect(checkStructure(bad)).toEqual([]); // 单参调用 = 旧语义
  });

  it('三趟合并后仍按行升序（配对 / 声明 / 头文件三源）', () => {
    const text = ['#DIM PRINT, 10', 'IF A', 'PRINTL 甲', 'PRINTL 乙'].join('\n');
    const issues = checkStructure(text, 'C:/game/ERB/DIM.ERH');
    expect(issues.map((i) => [i.line, i.kind])).toEqual([
      [1, 'dim-invalid'],
      [2, 'unclosed-open'],
      [3, 'erh-invalid'],
      [4, 'erh-invalid'],
    ]);
  });
});

/* ============================== 真语料闸 ============================== */

/**
 * 8 盘口径（本机实测，2026-10-26）：
 * **648 份 `.ERH` / 53,867 行 / 34,466 条有效逻辑行**（`#DIM` 32,642 + `#DIMS` 1,660 +
 * `#DEFINE` 164）——不合规行 **0**；其中 54 份用 `{}` 行连接摊初值表。
 *
 * 这一闸守的是"这条规则在真代码上静音"。它一旦红，只可能是两件事之一：
 * 某盘真有一条加载不了的头文件，或者判据把引擎看不见的东西（注释 / 空行 / 块边界）
 * 当成了正文。两种都必须先看文件再改判据。
 *
 * 盘面差异要认：eraSQC 的 `ERB/` 下**一份 `.ERH` 都没有**（8 盘里唯一），单跑它时
 * 本用例只打印读数后返回——那是"这个盘没有头文件"，不是判据失效。
 *
 * 解码走 `io.readText`（与宿主同一条探测链）：8 盘里 utf-8-bom 452 / utf-8 179 /
 * utf-16le 17，按 utf-8 硬读会把 utf-16 那 17 份读成"每行都不是 # 开头"。
 */
const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;

function erhFilesUnder(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) erhFilesUnder(p, out);
    else if (/\.erh$/i.test(e.name)) out.push(p);
  }
}

describe.skipIf(!SMOKE)('A4 · .ERH 形态 × 真语料', () => {
  it(
    '真语料里一条都不该有（走 io 解码的真实路径）',
    { timeout: 900_000 },
    async () => {
      const erbRoot = join(SMOKE!, 'ERB');
      const files: string[] = [];
      erhFilesUnder(erbRoot, files);
      // 盘上口径先证明"根找对了"：eraSQC 的 ERB/ 下一份 .ERH 都没有（8 盘里唯一），
      // 那不是判据失效，所以只要求"路径存在 + 有文件才继续"，并把读数打出来。
      if (files.length === 0) {
        console.log(`[erh-a4] ${erbRoot} 下没有 .ERH（本盘无头文件，形态闸无事可做）`);
        return;
      }
      expect(files.length, '.ERH 份数').toBeGreaterThan(0);

      const io = new FileIOServiceImpl(new NodeBridge(SMOKE!));
      const hits: string[] = [];
      let headerLines = 0;
      let braceFiles = 0;

      for (const p of files) {
        const { text } = await io.readText(p);
        if (/^\s*\{\s*$/m.test(text)) braceFiles++;
        headerLines += text.split('\n').filter((l) => /^\s*(?:;!;|;#;)?\s*#(?:DIM|DIMS|DEFINE)\b/i.test(l)).length;
        for (const issue of checkHeaderIssues(text)) {
          hits.push(`${p.replace(SMOKE!, '')}:${issue.line} ${issue.statement} ${issue.message}`);
        }
      }
      console.log(
        `[erh-a4] ${files.length} 份 .ERH / ${headerLines} 条声明行 / ${braceFiles} 份用 {} 行连接；不合规 ${hits.length} 条`,
      );
      // 分母：证"0 命中"不是因为一条声明都没读到
      expect(headerLines, '至少读到一条声明（0 命中不能是"什么都没读到"）').toBeGreaterThan(0);
      expect(hits, `真语料上的头文件假阳性（应为空）：\n${hits.slice(0, 20).join('\n')}`).toEqual([]);
    },
  );
});

/** 反证：同一份合法头文件里插一行 ⇒ 必红（防"判据根本没在工作"的假绿） */
describe('A4 · 反证', () => {
  it('在合法花括号头文件末尾插一行 PRINTL ⇒ 恰好一条，行号是插入行', () => {
    const ok = lines('#DIM X, 1', '{', '#DIMS Y = "a",', '"b"', '}');
    expect(checkHeaderIssues(ok)).toEqual([]);
    expect(checkHeaderIssues(lines(ok, 'PRINTL 甲')).map((i) => [i.line, i.statement])).toEqual([[6, 'PRINTL']]);
  });
});
