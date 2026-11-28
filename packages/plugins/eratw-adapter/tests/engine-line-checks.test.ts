/**
 * 引擎词法/字面实参相位检查（P2-7）的判据：先红后绿的那批断言。
 *
 * 一条规则 `erb.engine-line-checks` 出两类 issue，文案全部是引擎原话
 * （`formatEngineErrorText`，不另造说法）：
 *
 * (a) **info · 赋值位 `==`**：引擎 level 0 提示后照常按 `=` 执行
 *     （eratw `stmt/LineParser.kt parseAssignmentLine`；spec `LogicalLineParser.cs:548-554`）。
 *     判据 = 可见行行首 `标识符(下标)? ==`，标识符不在指令词表（snake 无条件指令面）；
 *     上一可见行以 `,` / `(` 收尾 ⇒ 那是上一条语句的括号续行（PRINTL 多行实参），
 *     fail-open 豁免——真语料仅有的 2 处命中全是这类续行。
 * (b) **error · 字面实参越界**：
 *     - `SETCOLOR`/`SETBGCOLOR` 三值形态逐分量 0..255；**给出第 4 实参即整值形态
 *       （按位取 RGB），全不查**（spec `Process.cs:1409-1439`，eratw `evalColorFlat` 逐字复刻）；
 *     - `ASSERT` 唯一实参为字面量 0 ⇒ 执行到该行必抛（`Process.cs:1790-1795`，
 *       eratw 无 debug 守卫——正式跑也报）。
 *
 * 语料探针读数（eraTW 4.981，4,371 文件）：== 赋值位 0、SETCOLOR/ASSERT 字面越界 0；
 * 全角空格 40,783 处全在 PRINT 输出文本（合法）——该键留 not-covered，见归档表。
 */
import { describe, expect, it } from 'vitest';
import type { ConventionCheckContext, ConventionIssue, ErbIndex, GameProject, Logger } from '@kojo/plugin-api';
import { functionLookupOf } from '@kojo/plugin-api';
import { parseErbText } from '@kojo/plugin-erb-parser';
import { checkEngineLineChecks } from '../src/engine-line-checks-impl';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function harness(files: Readonly<Record<string, string>>): {
  ctx: ConventionCheckContext;
  run(): Promise<ConventionIssue[]>;
} {
  const indexFiles = new Map<string, ReturnType<typeof parseErbText>>();
  for (const [p, text] of Object.entries(files)) {
    if (/\.(erb|erh)$/i.test(p)) indexFiles.set(p, parseErbText(text, p));
  }
  const index: ErbIndex = { files: indexFiles, byName: functionLookupOf(new Map()) } as ErbIndex;
  const project = { rootDir: 'C:/game', adapterId: 'eratw', kojoPaths: [], writablePaths: [], charaIndex: new Map() } as GameProject;
  const ctx: ConventionCheckContext = {
    project,
    index,
    readFile: async (p: string) => {
      const key = p.replace(/\\/g, '/');
      const hit = files[key] ?? files[key.replace('C:/game/', '')];
      if (hit === undefined) throw new Error(`no such file: ${key}`);
      return hit;
    },
    log: silentLog,
  };
  return { ctx, run: async () => checkEngineLineChecks(ctx) };
}

describe('赋值位 ==（info · 引擎按 = 执行并提示）', () => {
  it('裸赋值位 == 报引擎原话', async () => {
    const { run } = harness({ 'C:/game/ERB/A.ERB': 'A == 1\n' });
    const issues = await run();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('info');
    expect(issues[0]!.message).toContain('使用”==”作为赋值运算符');
    expect(issues[0]!.line).toBe(1);
  });

  it('数组形赋值位（CFLAG:98:1221 == 1）同样报', async () => {
    const { run } = harness({ 'C:/game/ERB/A.ERB': 'CFLAG:98:1221 == 1\n' });
    expect(await run()).toHaveLength(1);
  });

  it('条件位不报：IF / SIF 行首是指令词', async () => {
    const { run } = harness({
      'C:/game/ERB/A.ERB': 'IF A == 1\nPRINTL x\nSIF B == 2\nPRINTL y\nENDIF\n',
    });
    expect(await run()).toEqual([]);
  });

  it('比较在赋值右侧不报（A = B == C）', async () => {
    const { run } = harness({ 'C:/game/ERB/A.ERB': 'A = B == C\n' });
    expect(await run()).toEqual([]);
  });

  it('PRINT 输出文本里的 == 不报（指令词豁免）', async () => {
    const { run } = harness({ 'C:/game/ERB/A.ERB': 'PRINTL =====\nPRINT ==\nPRINTPLAIN  ==\n' });
    expect(await run()).toEqual([]);
  });

  it('括号续行豁免：上一可见行以 , / ( 收尾 ⇒ 那是上一条语句的实参（语料仅有的 2 处形态）', async () => {
    const { run } = harness({
      'C:/game/ERB/A.ERB':
        'PRINTL ("a",\n"[7] 背景设定",\nCFLAG:98:1221 == 1?"[8] 机体设置"#"[8] 素质更改",\n"[9] 退出")\n',
    });
    expect(await run()).toEqual([]);
  });

  it('SKIP 块与注释里不报', async () => {
    const { run } = harness({
      'C:/game/ERB/A.ERB': '[SKIPSTART]\nA == 1\n[SKIPEND]\n; A == 1\n',
    });
    expect(await run()).toEqual([]);
  });
});

describe('SETCOLOR / SETBGCOLOR 字面分量（error · Process.cs:1409-1439）', () => {
  it('三值形态逐分量 0..255：超上界/负值各报引擎原话', async () => {
    const { run } = harness({ 'C:/game/ERB/A.ERB': 'SETCOLOR 300,0,0\nSETBGCOLOR -1,0,0\n' });
    const issues = await run();
    expect(issues).toHaveLength(2);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.message).toContain('SETCOLOR的参数指定了超过0的值');
    expect(issues[0]!.message).toContain('255');
    expect(issues[1]!.message).toContain('SETCOLOR的参数指定了小于0的值');
  });

  it('合法值 / 变量 / 0x 字面量不报', async () => {
    const { run } = harness({
      'C:/game/ERB/A.ERB': 'SETCOLOR 255,255,255\nSETCOLOR X,0,0\nSETCOLOR 0xFF,0x00,0\n',
    });
    expect(await run()).toEqual([]);
  });

  it('第 4 实参存在 = C# 丢第 4 / eratw 当整值 ⇒ 两引擎分歧，不判', async () => {
    const { run } = harness({ 'C:/game/ERB/A.ERB': 'SETCOLOR 999,999,999,X\n' });
    expect(await run()).toEqual([]);
  });

  it('单实参 = 整值形态（语料 23,651 处 SETCOLOR 0xXXXXXX 实证），不查范围', async () => {
    const { run } = harness({ 'C:/game/ERB/A.ERB': 'SETCOLOR 0xFF0000\nSETCOLOR 256\nSETCOLOR 16711680\n' });
    expect(await run()).toEqual([]);
  });

  it('2 实参 = 引擎另有装载警告键（InvalidSetcolorArgCount，非本批），不判', async () => {
    const { run } = harness({ 'C:/game/ERB/A.ERB': 'SETCOLOR 300,0\n' });
    expect(await run()).toEqual([]);
  });
});

describe('ASSERT 字面量 0（error · Process.cs:1790-1795）', () => {
  it('ASSERT 0 报；非 0 / 表达式不报', async () => {
    const { run } = harness({ 'C:/game/ERB/A.ERB': 'ASSERT 0\nASSERT 1\nASSERT X\n' });
    const issues = await run();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.message).toContain('ASSERT的参数为0');
  });

  it('ASSERT 00 / 0x0 同样是字面 0', async () => {
    const { run } = harness({ 'C:/game/ERB/A.ERB': 'ASSERT 00\nASSERT 0x0\n' });
    expect(await run()).toHaveLength(2);
  });
});

describe('定位与去重键', () => {
  it('issue 带 filePath / line / 稳定 key，同类同行不重复', async () => {
    const { run } = harness({ 'C:/game/ERB/A.ERB': 'A == 1\nA == 2\n' });
    const issues = await run();
    expect(issues).toHaveLength(2);
    expect(issues[0]!.key).not.toBe(issues[1]!.key);
    expect(issues[0]!.filePath).toBe('C:/game/ERB/A.ERB');
    expect(issues[1]!.line).toBe(2);
  });
});
