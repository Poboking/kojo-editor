/**
 * 变量字面下标越界规则（P1-4）的判据：先红后绿的那批断言。
 *
 * 钉死四件事：
 * (a) 尺寸真源与快照指纹对拍（119 条，CFLAG 出厂 1000 / TA 三维）；
 * (b) **游戏 CSV 覆盖**：CB-002 的 ITEMNAME 与一万多条 CFLAG 假越界；
 * (c) 三条语料病灶：CB-007 报、CB-014 不报、CB-002 按版本口径；
 * (d) 可见性与成员链：SKIPSTART / 注释 / 字符串 / `CFLAG:MASTER:300` 都不报。
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ConventionCheckContext, ConventionIssue, ErbIndex, GameProject, Logger } from '@kojo/plugin-api';
import { functionLookupOf } from '@kojo/plugin-api';
import { parseErbText } from '@kojo/plugin-erb-parser';
import { visibleCodeLines } from '../../erb-parser/src/references';
import { checkVariableBounds, visibleLines as ruleVisibleLines } from '../src/variable-bounds-impl';
import { ERB_VARIABLE_SIZES, ERB_VARIABLE_SIZE_SHA256 } from '../src/data/variable-sizes';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const ROOT = new URL('..', import.meta.url);
const SNAPSHOT = new URL('../../../../tools/data/variables.yaml', import.meta.url);

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
  return { ctx, run: async () => (await checkVariableBounds(ctx)) as ConventionIssue[] };
}

const CSV = (...rows: string[]) => rows.join('\n') + '\n';

describe('尺寸表与真源指纹', () => {
  it('快照 EOL 归一化 sha 与生成表一致（换代即红）', () => {
    const text = readFileSync(fileURLToPath(SNAPSHOT), 'utf8').replace(/\r\n?/g, '\n');
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(ERB_VARIABLE_SIZE_SHA256);
  });

  it('真值抽样本位（CFLAG 1000 / ITEMNAME 靠 CSV / TA 三维 / 角色两参）', () => {
    expect(ERB_VARIABLE_SIZES.length).toBe(119);
    const get = (n: string) => ERB_VARIABLE_SIZES.find((e) => e.name === n);
    expect(get('CFLAG')).toMatchObject({ dim: 2, sizes: [1000], kind: 'int' });
    expect(get('ITEMNAME')).toMatchObject({ dim: 1, sizes: [], kind: 'str' });
    expect(get('TA')).toMatchObject({ dim: 3, sizes: [100, 100, 100] });
    expect(get('FLAG')).toMatchObject({ dim: 1, sizes: [10000] });
  });
});

describe('CB-002：游戏 CSV 覆盖出厂值', () => {
  it('eraTW 4.981：ITEMNAME,1200 ⇒ ITEMNAME:500 合法（不报）', async () => {
    const { run } = harness({
      'CSV/VariableSize.csv': CSV('ITEM,1200', 'ITEMNAME,1200'),
      'C:/game/a.erb': 'ITEMNAME:500 = 1\n',
    });
    expect(await run()).toEqual([]);
  });

  it('4.980 混装包：ITEMNAME,1000 ⇒ ITEMNAME:1200 报（官方同判）', async () => {
    const { run } = harness({
      'CSV/VariableSize.csv': CSV('ITEMNAME,1000'),
      'C:/game/a.erb': 'ITEMNAME:1200 = 1\n',
    });
    const issues = await run();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('数组变量"ITEMNAME"的第1参数(1200)超出数组范围');
  });

  it('CFLAG 出厂 1000 → CSV 10000：语料 12,825 处 CFLAG:*:1000 不得报', async () => {
    const { run } = harness({
      'CSV/VariableSize.csv': CSV('CFLAG,10000'),
      'C:/game/a.erb': 'CFLAG:14:1000 = 1\nCFLAG:14:9999 = 2\n',
    });
    expect(await run()).toEqual([]);
  });

  it('同一行若照出厂值判会报 1 条（反向证明 CSV 覆盖不是装饰）', async () => {
    const { run } = harness({
      'CSV/VariableSize.csv': CSV('CFLAG,10000'),
      'C:/game/a.erb': 'CFLAG:14:10000 = 1\n',
    });
    expect(await run()).toHaveLength(1);
  });
});

describe('CB-007 / CB-014：用户数组与动态下标', () => {
  const ERH = [
    '#DIM CONST MAXPANTS = 34',
    '#DIM CHARADATA SAVEDATA PANTS_TEMP, MAXPANTS',
  ].join('\n') + '\n';

  it('CB-007：#DIM 长度 34 ⇒ 合法槽 0..33，字面 34/35 都报', async () => {
    const { run } = harness({
      'C:/game/DIM.ERH': ERH,
      'C:/game/a.erb': 'PANTS_TEMP:0:35 += 1\nPANTS_TEMP:0:34 += 1\n',
    });
    const issues = await run();
    expect(issues.map((i) => i.line)).toEqual([1, 2]);
    expect(issues[0]!.message).toContain('数组变量"PANTS_TEMP"的第2参数(35)超出数组范围');
  });

  it('CB-014：SPLIT 截断 + 动态 TEMP_ID 不报（引擎语义：未折叠的实参不查界）', async () => {
    const { run } = harness({
      'CSV/VariableSize.csv': CSV(''),
      'C:/game/a.erb': '#DIMS DYNAMIC TEMP_STR, 1000\nSPLIT TEMP_STR, DISH_TASTE, ","\nFOR TEMP_ID, 0, TEMP_NUM\nPRINTV TEMP_STR:TEMP_ID\nNEXT\n',
    });
    expect(await run()).toEqual([]);
  });

  it('函数体内的 #DIM 是局部，不拿它判同名的全局下标', async () => {
    const { run } = harness({
      'C:/game/a.erb': '@F\n#DIM LOCALPANTS, 5\nLOCALPANTS:9 = 1\n',
    });
    expect(await run()).toEqual([]);
  });
});

describe('可见性与成员链（不得把别的语句里的数字当下标）', () => {
  it('SKIPSTART 死区、整行注释、字符串均不报', async () => {
    const { run } = harness({
      'CSV/VariableSize.csv': CSV('FLAG,10'),
      'C:/game/a.erb': [
        '[SKIPSTART]',
        'FLAG:99 = 1',
        '[SKIPEND]',
        '; FLAG:99 = 1',
        'PRINTFORM "FLAG:99"',
        'S = "FLAG:99"',
        '',
      ].join('\n'),
    });
    expect(await run()).toEqual([]);
  });

  it('CFLAG:MASTER:300 中 MASTER 是角色号表达式，不是 MASTER 数组的第 300 槽', async () => {
    const { run } = harness({
      'CSV/VariableSize.csv': CSV('MASTER,200', 'CFLAG,10000'),
      'C:/game/a.erb': 'IF CFLAG:MASTER:300 == 1\nPRINTL 1\nENDIF\n',
    });
    expect(await run()).toEqual([]);
  });

  it('规则的行可见性与 erb-parser 的 visibleCodeLines 逐条同源', () => {
    const samples = [
      '  FLAG:9 = 1 ; 尾注释',
      '[SKIPSTART]\nFLAG:9 = 1\n[SKIPEND]',
      ';FLAG:9 = 1',
      '#DIM X, 10',
      '$LABEL',
      '@FUNC',
      ';!; FLAG:9 = 1',
      'S = "FLAG:9"',
    ];
    for (const text of samples) {
      const fromErbParser = [...visibleCodeLines(text)].filter((l) => !l.isDefinition).map((l) => l.line);
      const fromRule = ruleVisibleLines(text).map((l) => l.line);
      expect({ text, fromRule }).toEqual({ text, fromRule: fromErbParser });
    }
  });
});
