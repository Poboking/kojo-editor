/**
 * erb-paint-coverage.mjs 的钉子（ERB-PAINT-21 的判据本身也要有判据）。
 *
 * 钉五件事：
 *   ① **成因分类逐条正确**（仓内构造行，不依赖语料盘）：八项名册逐格都要有命中样本，
 *      并且钉死三条容易被"顺手改宽"的口径——
 *      · 多成因时按 `CAUSES` 定序取**主因**（`pct` 吃掉同时带 `"` 与 `\` 的那枚）；
 *      · `semicolon` 只在裸文本行成立：同一个 `;` 在串里（`"@…?…;…#…\@"`）就不算成因、今天就该涂；
 *      · `paren-inner-bound` 一半今天已涂（假文段的 `(…?…)`）一半没涂（条件段的），
 *        所以除了 `byCause` 还必须单列 `innerBoundPainted`——看板要的就是这一格「单独量清」。
 *   ② **JSON 形状稳定 + 可复跑**：必需键齐、`byCause` 键 ⊆ 名册、两条自洽式成立、同输入两次逐字节相同；
 *   ③ **`--limit` 真生效**（取路径升序的前 N 份，不是随便 N 份）；
 *   ④ **尺子漂移即 fail-closed**：本脚本的 `findTopLevel` 镜像与真源 `scanTextTernaries` 对拍不上时
 *      必须抛（宁可读数红，不可静默换尺子）——用一枚故意说谎的假真源把这条路打穿。
 *   ⑤ 语料缺席时 rc=1 而不是硬失败（--root 指空 / --help）。
 *
 * 另有一条真语料活闸（`KOJO_SMOKE_PROJECT` / `KOJO_CORPUS_DIR` 守门，无 env 整组 skip，不硬失败）：
 * 只认「分母 > 0 且不出现没登记的成因」，不钉死数字——相位机落地后覆盖率会变，名册不该变。
 */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ERB_SKIP_MARKERS } from '@kojo/plugin-api';
import { CAUSES, MUST_DROP, SKIP_MARKERS, classifyLine } from '../erb-paint-coverage.mjs';
import { scanTextTernaries } from '../../packages/plugins/condition-extractor/src/inline.ts';

const SCRIPT = fileURLToPath(new URL('../erb-paint-coverage.mjs', import.meta.url));
/** 语料活闸与仓规同口径（AGENTS.md §三）：先 KOJO_SMOKE_PROJECT，回落 KOJO_CORPUS_DIR */
const CORPUS = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;
/** 语料里 .ERB/.ERH 有带 BOM 的，夹具照抄一份（用码点写死，别在源码里塞不可见字符） */
const BOM = String.fromCharCode(0xfeff);

/** 夹具的 15 行：每行一枚形状，`cause` / `painted` 是**逐行独立**的预期（与 a.erb 行序一一对应）。 */
const CASES: ReadonlyArray<{ line: string; cause: string; painted: boolean }> = [
  { line: 'PRINTFORML \\@A == 1 ? 真 # 假\\@', cause: 'clean', painted: true },                     // 1
  { line: 'PRINTFORML \\@A?%CALLNAME%#B\\@', cause: 'pct', painted: false },                        // 2 段内 %…% 插值
  { line: 'PRINTFORML \\@A?{X:1}#B\\@', cause: 'brace', painted: false },                           // 3 段内 {…} 插值
  { line: 'PRINTFORML \\@A?B#(C?D)E\\@', cause: 'paren-inner-bound', painted: true },               // 4 假文段括号内含 ? ⇒ 今天已涂
  { line: 'PRINTFORML \\@(A?B)?C#D\\@', cause: 'paren-inner-bound', painted: false },               // 5 条件段括号内含 ? ⇒ 今天弃
  { line: 'PRINTFORML \\@A == [[紫]] ? x # y\\@', cause: 'paren-deep', painted: false },            // 6 两层嵌套（语料高频形）
  { line: 'PRINTFORML \\@A?GMF("x")#y\\@', cause: 'quote', painted: false },                        // 7
  { line: 'PRINTFORML \\@A?B\\n#C\\@', cause: 'backslash', painted: false },                        // 8
  { line: 'PRINTFORML \\@A?B;C#D\\@', cause: 'semicolon', painted: false },                         // 9 root 段内 ;
  { line: 'PRINTFORMLW "@\\@A?B;C#D\\@"', cause: 'clean', painted: true },                          // 10 串里的 ; 是正文
  { line: ';PRINTFORML \\@A?B#C\\@', cause: 'semicolon', painted: false },                          // 11 整枚在注释区
  { line: 'PRINTFORML \\@A?B\\@', cause: 'clean', painted: false },                                 // 12 缺顶层 #（残形）
  { line: 'PRINTFORML "%\\@A?B#C\\@%"', cause: 'pct', painted: false },                             // 13 整枚坐在 %…% 层里
  { line: 'PRINTFORML \\@A?%X%\\n+"y"#B\\@', cause: 'pct', painted: false },                        // 14 多成因取主因
  { line: 'PRINTFORML \\@A)B?C#D\\@', cause: 'paren-deep', painted: false },                        // 15 括号未配平
];
/** b.erb 一枚干净形状，且文件**带 BOM**（语料里有这种，剥不掉会把首行判成别的） */
const BOM_LINE = 'PRINTFORML \\@B1?x#y\\@';
/** c.erb：`[SKIPSTART]` 死区里一枚（今天整行是 `keyword.raw`，三元规则轮不到）+ 块外一枚对照 */
const SKIP_FILE = [
  '[SKIPSTART]',
  'PRINTFORML \\@S1?x#y\\@',
  '[SKIPEND]',
  'PRINTFORML \\@S2?x#y\\@',
].join('\n');

/** 夹具落盘：<tmp>/ERB/{a,b,c}.erb（`--root` 给外层时脚本自己下潜进 ERB/）。 */
async function makeFixture(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-paint-fx-'));
  await fs.mkdir(path.join(tmp, 'ERB'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'ERB', 'a.erb'), CASES.map((c) => c.line).join('\r\n') + '\r\n', 'utf8');
  await fs.writeFile(path.join(tmp, 'ERB', 'b.erb'), BOM + BOM_LINE + '\n', 'utf8');
  await fs.writeFile(path.join(tmp, 'ERB', 'c.erb'), SKIP_FILE + '\n', 'utf8');
  return tmp;
}

function runTool(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
/** stdout 第一行 = JSON 汇总（其后才是样例；stdout 里不许有别的东西挤在 JSON 前面） */
function summaryOf(out: string): any {
  return JSON.parse(out.split('\n')[0]!);
}
const sampleRows = (out: string, cause: string): string[] =>
  out.split('\n').filter((l) => l.startsWith(`${cause}\t`));

describe('erb-paint-coverage · 成因名册与分类', () => {
  it('① 逐行分类：主因 / 今天就涂否，全部命中预期', () => {
    for (const c of CASES) {
      const hits = classifyLine(c.line, scanTextTernaries, 'fixture');
      expect(hits, `这行该认出一枚形状：${c.line}`).toHaveLength(1);
      expect([hits[0].cause, hits[0].painted], `分类不符：${c.line}`).toEqual([c.cause, c.painted]);
    }
  });

  it('①a 名册八项全部有命中样本（少一格 = 夹具退化，多一格 = 名册被偷改）', () => {
    const seen = new Set(CASES.map((c) => c.cause));
    for (const cause of CAUSES) expect(seen.has(cause), `名册项 ${cause} 没有夹具样本`).toBe(true);
    expect([...seen].sort()).toEqual([...CAUSES].sort());
  });

  it('①b 多成因取主因：pct 赢过 quote/backslash（定序即名册顺序）；ceiling 的扣减看全标志', () => {
    const [hit] = classifyLine(CASES[13]!.line, scanTextTernaries, 'fixture');
    expect([hit.flags.pct, hit.flags.quote, hit.flags.backslash]).toEqual([true, true, true]);
    expect(hit.cause).toBe(CAUSES[0]);
    // 这枚主因是 pct（相位机吃得下），但它同时带 `"` ⇒ ceiling 仍把它算进 mustDrop：
    // 「主因定序」是给 byCause 用的，「全标志」是给上限用的，两者不许混。
    expect(MUST_DROP.some((c) => hit.flags[c])).toBe(true);
  });

  it('①c 串里的 `;` 不算成因（root 态才算），注释区的整枚才算', () => {
    const inStr = classifyLine(CASES[9]!.line, scanTextTernaries, 'fixture')[0];
    expect([inStr.cause, inStr.painted, inStr.flags.semicolon]).toEqual(['clean', true, false]);
    const inComment = classifyLine(CASES[10]!.line, scanTextTernaries, 'fixture')[0];
    expect([inComment.cause, inComment.painted, inComment.flags.semicolon]).toEqual(['semicolon', false, true]);
  });

  it('①d 缺顶层 `#` 的残形计入 clean 但不计入 paintableToday（名册无此格，靠 noElse 单列）', () => {
    const [noElse] = classifyLine(CASES[11]!.line, scanTextTernaries, 'fixture');
    expect([noElse.cause, noElse.painted, noElse.noElse]).toEqual(['clean', false, true]);
  });

  it('①e `[SKIPSTART]` 死区与 `;` 注释同族（都归 semicolon 格、今天都不涂），块外对照照旧 clean', () => {
    const inBlock = classifyLine('PRINTFORML \\@S1?x#y\\@', scanTextTernaries, 'fixture', true)[0];
    expect([inBlock.cause, inBlock.painted, inBlock.skip, inBlock.flags.semicolon]).toEqual(['semicolon', false, true, true]);
    const outside = classifyLine('PRINTFORML \\@S2?x#y\\@', scanTextTernaries, 'fixture', false)[0];
    expect([outside.cause, outside.painted, outside.skip]).toEqual(['clean', true, false]);
    // 死区成因的标记两枚是**字形镜像**（裸 node 吃不下 plugin-api 桶，PITFALLS 151/207），逐字节对拍契约
    expect(SKIP_MARKERS).toEqual({ start: ERB_SKIP_MARKERS.start, end: ERB_SKIP_MARKERS.end });
  });

  it('② 汇总读数：键齐、ΣbyCause = 分母、两条自洽式成立、样例按路径升序', async () => {
    const tmp = await makeFixture();
    try {
      const run = runTool(['--root', tmp]);
      expect(run.code, run.stderr).toBe(0);
      const s = summaryOf(run.stdout);
      expect(Object.keys(s).sort()).toEqual([
        'byCause', 'ceiling', 'completeShapes', 'files', 'innerBoundPainted', 'linesScanned',
        'mustDrop', 'noElse', 'paintableToday', 'parenUnbalanced', 'skipBlockShapes',
      ].sort());
      expect(s.files).toBe(3);
      expect(s.completeShapes).toBe(CASES.length + 3); // b.erb 一枚（带 BOM 的首行）+ c.erb 两枚（死区一 / 块外一）
      expect(Object.keys(s.byCause).every((k: string) => (CAUSES as readonly string[]).includes(k))).toBe(true);
      expect(Object.values(s.byCause).reduce((a: number, b: number) => a + b, 0)).toBe(s.completeShapes);
      expect(s.ceiling + s.mustDrop).toBe(s.completeShapes);
      expect(s.paintableToday).toBe(CASES.filter((c) => c.painted).length + 2);
      expect(s.paintableToday).toBeLessThanOrEqual(s.byCause.clean + s.byCause['paren-inner-bound']);
      // 逐格绝对值（夹具是构造行集，读数本该逐字可推）
      expect(s.byCause).toEqual({
        pct: 3, brace: 1, 'paren-inner-bound': 2, 'paren-deep': 2, quote: 1, backslash: 1, semicolon: 3, clean: 5,
      });
      expect(s.noElse).toBe(1);
      expect(s.innerBoundPainted).toBe(1); // 假文段那枚今天已涂；条件段那枚没涂
      expect(s.parenUnbalanced).toBe(1); // `A)B` 落单括号归 paren-deep，另立一格备复验
      expect(s.skipBlockShapes).toBe(1); // c.erb 死区那一枚（同族屏蔽语义，归 semicolon 格）
      // 样例：`成因<TAB>相对路径:行号<TAB>整行原文`；默认每成因 3 条，按「路径升序 → 行号升序」取前 3
      const pct = sampleRows(run.stdout, 'pct');
      expect(pct.length).toBe(3);
      expect(pct[0]).toContain('ERB/a.erb:2\t');
      expect(pct[0]).toContain(CASES[1]!.line);
      expect(sampleRows(run.stdout, 'clean').map((l) => l.split('\t')[1])).toEqual([
        'ERB/a.erb:1', 'ERB/a.erb:10', 'ERB/a.erb:12',
      ]);
      // 放宽样例上限 ⇒ b.erb / c.erb 才露面（路径升序的末两份，同时证明 BOM 没把首行读坏）
      const wide = runTool(['--root', tmp, '--samples', '9']);
      expect(sampleRows(wide.stdout, 'clean').map((l) => l.split('\t')[1])).toEqual([
        'ERB/a.erb:1', 'ERB/a.erb:10', 'ERB/a.erb:12', 'ERB/b.erb:1', 'ERB/c.erb:4',
      ]);
      expect(sampleRows(wide.stdout, 'clean')[3]).toContain(BOM_LINE);
      expect(sampleRows(runTool(['--root', tmp, '--samples', '0']).stdout, 'pct')).toEqual([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('②a 同输入两次逐字节相同（可复跑是长期判据的底线）', async () => {
    const tmp = await makeFixture();
    try {
      const a = runTool(['--root', tmp]);
      const b = runTool(['--root', tmp]);
      expect(a.code).toBe(0);
      expect(b.stdout).toBe(a.stdout);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('③ --limit 取路径升序的前 N 份（b.erb 被切掉，不是随机 N 份）', async () => {
    const tmp = await makeFixture();
    try {
      const s = summaryOf(runTool(['--root', tmp, '--limit', '1', '--samples', '0']).stdout);
      expect(s.files).toBe(1);
      expect(s.completeShapes).toBe(CASES.length);
      expect(s.paintableToday).toBe(CASES.filter((c) => c.painted).length);
      expect(s.byCause.clean).toBe(3);
      const none = runTool(['--root', tmp, '--limit', '0', '--samples', '0']);
      expect(summaryOf(none.stdout).files).toBe(3); // 0 = 不限（全量）
      const bad = runTool(['--root', tmp, '--limit', '-3']);
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain('--limit');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('④ 镜像与真源对拍不上就抛（fail-closed，绝不静默换尺子）', () => {
    const line = CASES[0].line;
    expect(() => classifyLine(line, scanTextTernaries, 'fixture')).not.toThrow();
    // 假真源：凭空多报一列 ⇒ 与镜像的区间序列不符 ⇒ 必须当场抛，且信息里带上定位
    const lying = () => [{ text: 'A == 1', column: 999 }];
    expect(() => classifyLine(line, lying as never, 'ERB/x.ERB:1')).toThrow(/尺子漂移/);
    expect(() => classifyLine(line, lying as never, 'ERB/x.ERB:1')).toThrow(/ERB\/x\.ERB:1/);
  });

  it('⑤ --root 不成立 ⇒ rc=1；--help 打口径', () => {
    const missing = runTool(['--root', path.join(os.tmpdir(), 'kojo-paint-不存在-请别创建')]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('--root');
    const help = runTool(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--samples');
  });
});

describe.skipIf(!CORPUS)('erb-paint-coverage · 真语料活闸（KOJO_SMOKE_PROJECT / KOJO_CORPUS_DIR 守门）', () => {
  it('真语料分母 > 0，且不出现没登记的成因', { timeout: 240_000 }, () => {
    const run = runTool(['--root', CORPUS as string, '--limit', '600', '--samples', '1']);
    expect(run.code, run.stderr).toBe(0);
    const s = summaryOf(run.stdout);
    expect(s.files).toBe(600);
    expect(s.completeShapes).toBeGreaterThan(0);
    for (const key of Object.keys(s.byCause)) {
      expect((CAUSES as readonly string[]).includes(key), `成因名册外冒出 ${key}`).toBe(true);
    }
    expect(Object.values(s.byCause).reduce((a: number, b: number) => a + b, 0)).toBe(s.completeShapes);
    expect(s.ceiling + s.mustDrop).toBe(s.completeShapes);
    expect(s.paintableToday).toBeLessThanOrEqual(s.completeShapes);
  });
});
