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
 *       eratw 无 debug 守卫——正式跑也报）；
 *     - `ARRAYCOPY` 双名实参四判（两实参都是引号字面名才判，其余 fail-open）：
 *       装载相位 `ArgumentParser.cs:2451-2496`（`ArgumentBuilder.warn`，逐条与运行时
 *       `Process.cs:1711-1768` 同构；eratw `StatementExecutor.kt execArrayCopyFlat` 同形）：
 *       非数组（`ArraycopyArgIsNotArray`）、角色变量（`ArraycopyArgIsCharaVar`）、
 *       维度不一致（`DifferentArraycopyArgsDim`）、类型不一致（`DifferentArraycopyArgsType`），
 *       判据顺序与引擎一致：未定义/非数组/角色 → 维度 → 类型。
 *       名字真值 = 引擎名表（`ERB_ENGINE_NAMES`，`section:"角色变量"` = IsCharacterData、
 *       `dim:0` = 标量、`dim`/`kind` 缺席 = fail-open）∪ 全局用户 `#DIM`/`#DIMS`（函数体内的
 *       是局部，同名互不相干 → 对收集器不可见 ⇒ fail-open）。
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

describe('ARRAYCOPY 双名实参四判（error · ArgumentParser.cs:2451-2496 / Process.cs:1711-1768）', () => {
  it('标量（dim:0）当实参 → ArraycopyArgIsNotArray，报第几参与原名', async () => {
    const { run } = harness({ 'C:/game/ERB/A.ERB': 'ARRAYCOPY "GAMEBASE_TITLE", "RESULT"\n' });
    const issues = await run();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.message).toContain('ARRAYCOPY命令的第1参数"GAMEBASE_TITLE"不是一个数组变量');
  });

  it('角色变量当实参 → ArraycopyArgIsCharaVar；两侧都是角色变量各报一条', async () => {
    const { run } = harness({
      'C:/game/ERB/A.ERB': 'ARRAYCOPY "CFLAG", "RESULT"\nARRAYCOPY "CFLAG", "CSTR"\n',
    });
    const issues = await run();
    expect(issues).toHaveLength(3);
    expect(issues[0]!.message).toContain('ARRAYCOPY命令的第1参数"CFLAG"是一个角色变量(不支持)');
    expect(issues[1]!.message).toContain('第1参数"CFLAG"');
    expect(issues[2]!.message).toContain('第2参数"CSTR"');
  });

  it('维度不一致（DA 2维 vs RESULT 1维）→ DifferentArraycopyArgsDim', async () => {
    const { run } = harness({ 'C:/game/ERB/A.ERB': 'ARRAYCOPY "DA", "RESULT"\n' });
    const issues = await run();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('ARRAYCOPY命令的两个参数维度不一致');
  });

  it('类型不一致（RESULT int vs RESULTS str）→ DifferentArraycopyArgsType；维度判据先于类型', async () => {
    const { run } = harness({ 'C:/game/ERB/A.ERB': 'ARRAYCOPY "RESULT", "RESULTS"\n' });
    const issues = await run();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('ARRAYCOPY命令的两个参数的数组变量类型不一致');
  });

  it('用户全局 #DIM/#DIMS 进真值：维度/类型按声明判', async () => {
    const { run } = harness({
      'C:/game/ERB/decl.ERH': '#DIM MYARR, 10\n#DIMS MYSTRS, 5\n#DIM CHARADATA MYCHARA, 10\n',
      'C:/game/ERB/A.ERB':
        'ARRAYCOPY "MYARR", "MYSTRS"\nARRAYCOPY "MYARR", "DA"\nARRAYCOPY "MYCHARA", "RESULT"\nARRAYCOPY "MYARR", "RESULT"\n',
    });
    const issues = await run();
    expect(issues.map((i) => i.message.slice(0, 40))).toEqual([
      expect.stringContaining('类型不一致'),
      expect.stringContaining('维度不一致'),
      expect.stringContaining('是一个角色变量'),
    ]);
  });

  it('合法拷贝不报：同维同型（含同名自拷贝）', async () => {
    const { run } = harness({
      'C:/game/ERB/A.ERB': 'ARRAYCOPY "RESULT", "RESULT"\nARRAYCOPY "STR", "RESULTS"\n',
    });
    expect(await run()).toEqual([]);
  });

  it('两个标量（dim:0）互拷 → 各报一条 ArraycopyArgIsNotArray', async () => {
    const { run } = harness({ 'C:/game/ERB/A.ERB': 'ARRAYCOPY "SAVEDATA_TEXT", "GAMEBASE_TITLE"\n' });
    const issues = await run();
    expect(issues).toHaveLength(2);
    expect(issues[0]!.message).toContain('第1参数"SAVEDATA_TEXT"');
    expect(issues[1]!.message).toContain('第2参数"GAMEBASE_TITLE"');
  });

  it('fail-open：裸名/未知名/函数体 #DIM/名字带逗号/表达式实参', async () => {
    const { run } = harness({
      'C:/game/ERB/A.ERB':
        '@F\n#DIM LOCAL_ARR, 5\nARRAYCOPY "LOCAL_ARR", "RESULT"\nARRAYCOPY "UNKNOWN_NAME", "RESULT"\nARRAYCOPY "A,B", "RESULT"\nARRAYCOPY ARG_VARNAME , "RESULT"\n',
    });
    expect(await run()).toEqual([]);
  });

  it('SKIP 块与注释里的 ARRAYCOPY 不报', async () => {
    const { run } = harness({
      'C:/game/ERB/A.ERB': '[SKIPSTART]\nARRAYCOPY "DA", "RESULT"\n[SKIPEND]\n; ARRAYCOPY "DA", "RESULT"\n',
    });
    expect(await run()).toEqual([]);
  });
});

describe('维度/类型族可证子集（error · VariableParser.cs:177-179 / IdentifierDictionary.cs:258-300,354-359）', () => {
  it('全局 #DIM 重名 → VarNameAlreadyUsed，报后到者', async () => {
    const { run } = harness({
      'C:/game/ERB/decl.erh': '#DIM DUP_ARR, 5\n',
      'C:/game/ERB/A.ERB': '#DIM DUP_ARR, 10\nARRAYCOPY "DUP_ARR", "RESULT"\n',
    });
    const issues = await run();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.message).toContain('变量名"DUP_ARR"已经被使用');
    expect(issues[0]!.line).toBe(1);
  });

  it('名字以半角数字开头 → VarStartedHalfDigit', async () => {
    const { run } = harness({ 'C:/game/ERB/A.ERB': '#DIM 1ABC, 5\n' });
    const issues = await run();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('变量名"1ABC"以半角数字开始');
  });

  it('0 维变量带下标 → ZeroDVarHasArg（VariableParser.cs:177-179 求值前就抛）', async () => {
    const { run } = harness({
      'C:/game/ERB/A.ERB': 'X = GAMEBASE_TITLE:0\nY = RESULTF:X\nZ = SAVEDATA_TEXT[1]\n',
    });
    const issues = await run();
    expect(issues).toHaveLength(3);
    expect(issues[0]!.message).toContain('变量"GAMEBASE_TITLE"不是数组却带了一个参数');
    expect(issues[2]!.message).toContain('变量"SAVEDATA_TEXT"不是数组却带了一个参数');
  });

  it('fail-open：0 维名裸用合法 / 函数体 #DIM 遮蔽同名 0 维 / SKIP 块与字符串内容', async () => {
    const { run } = harness({
      'C:/game/ERB/A.ERB':
        '@F\n#DIM GAMEBASE_TITLE, 5\nX = GAMEBASE_TITLE:0\n[SKIPSTART]\nX = GAMEBASE_TITLE:0\n[SKIPEND]\nPRINTL "GAMEBASE_TITLE:0"\n',
      'C:/game/ERB/B.ERB': 'X = GAMEBASE_TITLE\n',
    });
    expect(await run()).toEqual([]);
  });

  it('SKIP 块内的全局重名不报（整段死代码，引擎不装载，语料实证 COLOR_CLAC.ERB 形态）', async () => {
    const { run } = harness({
      'C:/game/ERB/A.ERB': '[SKIPSTART]\n#DIM DUP2, 5\n#DIM DUP2, 9\n[SKIPEND]\n',
    });
    expect(await run()).toEqual([]);
  });
});

describe('GETBIT/SETBIT/CLEARBIT/BITXOR 字面位域（error · ArgIsOoRBit · FunctionMethodCreator.cs:4783-4786 / snake Creator.Method.cs:5238-5247）', () => {
  it('字面 bit ∉ 0..63 报引擎原话（CB-004/013 病灶形态：GETBIT(STAIN:ARG:2,64)）', async () => {
    const { run } = harness({
      'C:/game/ERB/A.ERB': 'IF GETBIT(STAIN:ARG:2,64)\nSETBIT X, -1, 1\n',
    });
    const issues = await run();
    expect(issues).toHaveLength(2);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.message).toContain('第2参数(64)超出范围(0-63)');
    expect(issues[1]!.message).toContain('第2参数(-1)超出范围(0-63)');
  });

  it('合法位 / 动态位 / 注释与 SKIP 块不报（语料探针：K77 的 78 是注释行，_TR Lib 的 64 在 SKIP 块内）', async () => {
    const { run } = harness({
      'C:/game/ERB/A.ERB':
        'IF GETBIT(X, 63)\nSETBIT X, 0, 1\nIF GETBIT(X, ARG)\n; GETBIT(X, 78)\n[SKIPSTART]\nIF GETBIT(X, 64)\n[SKIPEND]\n',
    });
    expect(await run()).toEqual([]);
  });
});

describe('RAND 族字面越界（warning · snake 钳制口径 · eratw ClampWarnings.kt / 4.981 VariableToken.cs:1413-1436）', () => {
  it('RAND:0 / RAND:-N → snake 钳 0 告警原话（1.824 会抛 RandArgIsNegative 中断，注分歧）', async () => {
    const { run } = harness({ 'C:/game/ERB/A.ERB': 'X = RAND:0\nY = RAND:-5\n' });
    const issues = await run();
    expect(issues).toHaveLength(2);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.message).toContain('RAND不能指定0以下的值(0)');
    expect(issues[0]!.message).toContain('已钳制为 0');
    expect(issues[0]!.message).toContain('1.824');
    expect(issues[1]!.message).toContain('RAND不能指定0以下的值(-5)');
  });

  it('RAND(m,n) 字面 max≤min / RAND(n) 字面 n≤0 → 钳下界告警原话', async () => {
    const { run } = harness({ 'C:/game/ERB/A.ERB': 'X = RAND(5, 3)\nY = RAND(0)\nZ = RAND(-2)\n' });
    const issues = await run();
    expect(issues).toHaveLength(3);
    expect(issues[0]!.message).toContain('函数RAND: 最大值被指定为小于或等于最小值的值(3)');
    expect(issues[0]!.message).toContain('已钳制为下界');
    expect(issues[1]!.message).toContain('值(0)');
    expect(issues[2]!.message).toContain('值(-2)');
  });

  it('合法区间 / 动态实参 / 输出文本内的 RAND 不报', async () => {
    const { run } = harness({
      'C:/game/ERB/A.ERB':
        'X = RAND(3, 5)\nY = RAND:18\nZ = RAND:ARG\nW = RAND(A, B)\nPRINTL RAND:0\n',
    });
    expect(await run()).toEqual([]);
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
