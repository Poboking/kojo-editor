/**
 * P-7 · `心形：` / `heart：` 连续块（HPH_PRINT 连续块）端到端转译断言。
 *
 * 判据（`docs/SUGAR-INTIMATE-EXPANSION-PROPOSAL.md` §P-7）：
 * - 块体每行是文本行（带「」引号 = 台词 / 不带 = 旁白，行尾可带 `续`），**逐行**产
 *   `CALL HPH_PRINT(@"…","<mode>")`，模式字母规则与单行形 `心形 「…」` **完全一致**；
 * - **宁缺勿编**：块内混入任何非文本行（控制流 / 赋值 / 别的块）⇒ error 且整块**不产字节**。
 *
 * 每条正向断言都配负自证（混入一行非文本行必须被抓出，且产物里一个字都不留）。
 * 装配不依赖游戏盘：字典/分野表用 `support.ts` 的桩。
 */

import { describe, expect, it } from 'vitest';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
const t = (src: string) => svc().transpile(src);

/** 正文落在 `时机 绝顶：` 的函数体内（stub 表 → `@M_KOJO_MESSAGE_PALAMCNG_B_K12`） */
const doc = (body: string): string => `角色: 12\n时机 绝顶：\n${body}\n`;

/** 产物里所有 `CALL HPH_PRINT` 行（保持顺序，去缩进后逐字比对） */
const hphLines = (src: string): string[] =>
  t(src)
    .erb.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('CALL HPH_PRINT'));

const errsOf = (src: string) => t(src).diagnostics.filter((d) => d.severity === 'error');

/* ============================================================================ */
/* A. 正向：逐行 HPH_PRINT，模式字母同单行形                                       */
/* ============================================================================ */

describe('P-7 心形连续块 · 正向', () => {
  it('台词 + 旁白 + `续` 三行 → 逐行 CALL HPH_PRINT，零 error', () => {
    const src = doc('\t心形：\n\t\t「涩涩的话」\n\t\t涩涩的话\n\t\t「涩涩的话」 续\n');
    expect(errsOf(src)).toEqual([]);
    expect(hphLines(src)).toEqual([
      // 台词（「」引号）+ 等待 → `w`
      'CALL HPH_PRINT(@"涩涩的话","w")',
      // 旁白（无引号）+ 等待 → `dw`
      'CALL HPH_PRINT(@"涩涩的话","dw")',
      // 台词 + 行尾 `续`（不等待）→ `l`
      'CALL HPH_PRINT(@"涩涩的话","l")',
    ]);
  });

  it('块形第一行与单行形产物逐字一致（复用同一条 heartCall 管线）', () => {
    const block = doc('\t心形：\n\t\t「同一句话」\n');
    const single = doc('\t心形 「同一句话」\n');
    expect(hphLines(block)).toEqual(hphLines(single));
    expect(hphLines(block)).toEqual(['CALL HPH_PRINT(@"同一句话","w")']);
  });

  it('英文块头 `heart：` 与中文 `心形：` 等价（逐字节）', () => {
    const cn = doc('\t心形：\n\t\t「a」\n\t\ta\n\t\t「a」 续\n');
    const en = doc('\theart：\n\t\t「a」\n\t\ta\n\t\t「a」 续\n');
    expect(t(en).erb).toEqual(t(cn).erb);
    expect(hphLines(en)).toEqual([
      'CALL HPH_PRINT(@"a","w")',
      'CALL HPH_PRINT(@"a","dw")',
      'CALL HPH_PRINT(@"a","l")',
    ]);
  });

  it('半角冒号块头 `心形:` 等价', () => {
    const cn = doc('\t心形：\n\t\t「a」\n');
    const half = doc('\t心形:\n\t\t「a」\n');
    expect(t(half).erb).toEqual(t(cn).erb);
  });

  it('块内注释原样落进产物（"注释不能丢"），不产 HPH 行', () => {
    const src = doc('\t心形：\n\t\t「a」\n\t\t;分节线\n');
    expect(errsOf(src)).toEqual([]);
    const all = t(src).erb.split('\n').map((l) => l.trim());
    expect(all).toContain(';分节线');
    expect(hphLines(src)).toEqual(['CALL HPH_PRINT(@"a","w")']);
  });
});

/* ============================================================================ */
/* B. 负自证：块内混非文本行 → error 且整块不产字节（宁缺勿编）                     */
/* ============================================================================ */

describe('P-7 心形连续块 · 负自证（宁缺勿编）', () => {
  it('混控制流（`如果 …：`）→ error，且整块一条 HPH_PRINT 都不产', () => {
    const src = doc('\t心形：\n\t\t「合法行」\n\t\t如果 1：\n\t\t\t「非法行」\n');
    const errs = errsOf(src);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.every((d) => d.code === 'indent-mismatch')).toBe(true);
    // 合法行也不产——错的块整个作废（半成品比没有更坏）
    expect(t(src).erb).not.toContain('HPH_PRINT');
  });

  it('混赋值（`好感度 = 1`）→ error，且整块不产字节', () => {
    const src = doc('\t心形：\n\t\t「合法行」\n\t\t好感度 = 1\n');
    expect(errsOf(src).map((d) => d.code)).toContain('indent-mismatch');
    expect(t(src).erb).not.toContain('HPH_PRINT');
  });

  it('混别的块（嵌套 `心形：`）→ error，且整块不产字节', () => {
    const src = doc('\t心形：\n\t\t「a」\n\t\t心形：\n\t\t\t「b」\n');
    expect(errsOf(src).map((d) => d.code)).toContain('indent-mismatch');
    expect(t(src).erb).not.toContain('HPH_PRINT');
  });

  it('块头后无体 → `block-empty`（不静默）', () => {
    const src = doc('\t心形：\n');
    expect(errsOf(src).map((d) => d.code)).toContain('block-empty');
  });
});

/* ============================================================================ */
/* B. `你：` 自机台词行（B1 口径接进心形块）                                       */
/* ============================================================================ */

describe('P-7 心形连续块 · `你：` 自机台词行', () => {
  it('镶前缀 + run 合并 + run 结束复原：连续行只发一次 SETCOLOR/RESETCOLOR', () => {
    const src = doc(
      '\t心形：\n' + '\t\t你：我也会难过\n' + '\t\t「普通台词」\n' + '\t\t你：这句也是我说的\n' + '\t\t你：还有这句\n',
    );
    expect(errsOf(src)).toEqual([]);
    expect(
      t(src)
        .erb.split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('SETCOLOR') || l.startsWith('RESETCOLOR') || l.startsWith('CALL HPH_PRINT')),
    ).toEqual([
      'SETCOLOR 0x4682B4',
      'CALL HPH_PRINT(@"我也会难过","w")', // 前缀剥掉；自机台词强制非 D（dw 忽略 SETCOLOR）
      'RESETCOLOR', // 非自机行打断 run
      'CALL HPH_PRINT(@"普通台词","w")',
      'SETCOLOR 0x4682B4', // run 重新起
      'CALL HPH_PRINT(@"这句也是我说的","w")',
      'CALL HPH_PRINT(@"还有这句","w")',
      'RESETCOLOR', // 块尾收 run
    ]);
  });

  it('`你：「…」` → 前缀与引号都剥掉，模式非 D', () => {
    const src = doc('\t心形：\n\t\t你：「她说的话」\n');
    expect(hphLines(src)).toEqual(['CALL HPH_PRINT(@"她说的话","w")']);
  });

  it('声明 `自机色:` 覆盖 adapter 缺省（非 D 变体照旧）', () => {
    const src = '角色: 12\n自机色: 0x123456\n时机 绝顶：\n\t心形：\n\t\t你：上色了\n';
    expect(hphLines(src)).toEqual(['CALL HPH_PRINT(@"上色了","w")']);
    expect(t(src).erb).toContain('SETCOLOR 0x123456');
  });

  it('负自证：无色可发（无 `自机色:` 且 adapter 无缺省）→ 报 `face-table-missing`、前缀照剥、退回 D 系', () => {
    const { playerColor: _omit, ...noPlayer } = stubFaceTable();
    const res = createSugarTranspileService({ dictionary: stubDict, faceTable: noPlayer }).transpile(
      doc('\t心形：\n\t\t你：无色的行\n'),
    );
    expect(res.diagnostics.filter((d) => d.severity === 'warning').map((d) => d.code)).toContain('face-table-missing');
    expect(res.erb).not.toContain('SETCOLOR');
    expect(res.erb).toContain('CALL HPH_PRINT(@"无色的行","dw")');
    expect(res.erb).not.toContain('你：');
  });
});
