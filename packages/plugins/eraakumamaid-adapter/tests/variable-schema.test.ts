/**
 * eraAkumaMaid 变量字典单测（形态照 eratw-adapter/tests/variable-schema.test.ts）。
 *
 * 覆盖（对照 eratw 逐项，差异只在"AM 实测没有哪几层"）：
 * - `parseVariableCsv`：行格式（`编号,名称[,注释]` / `;` 注释 / tab 缩进续行注释 / 行首非数字 /
 *   空名称 / BOM / LF / CRLF / 无尾换行）与"首个定义优先"；
 * - `parseErhConsts`：`.ERH` 具名常量两种声明形态（`#DIM CONST NAME = 1101` / `#DEFINE NAME 0`）
 *   与四类不收（无 CONST 的 `#DIM`、数组、字符串值、负值/表达式）；
 * - `mergeVariableTable`：追加名表（`.als`）只并集不覆盖、source 标注（主表已有的键 `.als`
 *   再写不改源）、同名字跨编号相撞主表胜出；
 * - `loadErakumamaidVariableSchema`（假 io）：三层合并（主表 → `.als` → 市场字典包）、
 *   `_TR` 翻译表 0 条收录、`.ERH` const 层两种形态、lookup 双向 / 家族级 / 回声、
 *   names 枚举、familyAlias 双向、chsMapPath 告警（AM 无 JP→CN 词典）、读失败降级不抛、
 *   inputDigest 稳定 / 顺序无关 / 变体即失效；
 * - 三张策展表（ENGINE_FAMILIES / FAMILY_ALIASES / FAMILY_ALIAS_EXCLUSIONS）的全覆盖闸；
 * - 真实语料读数（`C:/game/eraAkumaMaid` 缺位时跳过）：CSV 头 10 行格式钉结论、
 *   3 份 `ERB/ERH/*.ERH` 声明数统计、全树 9 份 `.ERH` 合计 96 名、`_TR` 7 份全 0 条、
 *   `.als` 全树 0 份、loader 端到端（真 io）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileIO, Logger } from '@kojo/plugin-api';
import {
  ENGINE_FAMILIES,
  FAMILY_ALIASES,
  FAMILY_ALIASES_REVERSE,
  FAMILY_ALIAS_EXCLUSIONS,
  FAMILY_LABELS,
  loadErakumamaidVariableSchema,
  mergeVariableTable,
  parseErhConsts,
  parseVariableCsv,
} from '../src/variable-schema';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** 真实语料根（eraAkumaMaid 安装目录；缺位时真实读数用例整体跳过） */
const GAME_ROOT = 'C:/game/eraAkumaMaid';

/* ============================ 名称表解析（主表 / 追加表同一套行格式） ============================ */

describe('parseVariableCsv', () => {
  it('基础解析：编号,名称', () => {
    const t = parseVariableCsv(['0,キャラ用', '2,好感度', '4,信頼度'].join('\n'));
    expect(t.byIndex.get('2')).toBe('好感度');
    expect(t.byName.get('信頼度')).toBe('4');
  });

  it('注释行 / 空行 / 非数字行 / 空名称跳过', () => {
    const t = parseVariableCsv([';标题注释', '', '  ;缩进注释', '2,好感度', 'abc,非法', ',无名', '3,'].join('\n'));
    expect(t.byIndex.size).toBe(1);
    expect(t.byIndex.get('2')).toBe('好感度');
  });

  it('第三列注释不进入名称（CFLAG.csv:1 实测形态 `0,キャラ用,<tab><tab>;…`）', () => {
    const t = parseVariableCsv('0,キャラ用,\t\t;各キャラ用の自由に使えるフラグ');
    expect(t.byIndex.get('0')).toBe('キャラ用');
  });

  it('tab 缩进的续行注释跳过（Talent.csv 真实形态）', () => {
    const text = ['10,胆量,', '\t; -1=膽怯,;ABL:従順が上げやすい', '11,態度,'].join('\n');
    const t = parseVariableCsv(text);
    expect(t.byIndex.get('10')).toBe('胆量');
    expect(t.byIndex.get('11')).toBe('態度');
    expect(t.byIndex.size).toBe(2);
  });

  it('同编号/名称首个定义优先', () => {
    const t = parseVariableCsv(['2,好感度', '2,重复'].join('\n'));
    expect(t.byIndex.get('2')).toBe('好感度'); // 编号键首个优先
    expect(t.byName.get('好感度')).toBe('2'); // 名称键只新增不覆盖
    expect(t.byName.get('重复')).toBe('2'); // 同编号的第二个名字照收（两名都收）
    expect(t.byIndex.size).toBe(1);
    expect(t.byName.size).toBe(2);
  });

  it('BOM 与无 BOM、LF 与 CRLF、有尾换行与无尾换行都收（AM 的 CSV 全部带 BOM）', () => {
    const cases = [
      '\uFEFF145,泥酔\n',
      '145,泥酔\n',
      '\uFEFF145,泥酔', // 无尾换行
      '145,泥酔\r\n',
      '\uFEFF145,泥酔\r\n', // AM 形态：BOM + CRLF（.ERH 8/9 如此；CSV 侧 LF）
    ];
    for (const text of cases) {
      const t = parseVariableCsv(text);
      expect(t.byIndex.get('145'), JSON.stringify(text)).toBe('泥酔');
      expect(t.byName.get('泥酔'), JSON.stringify(text)).toBe('145');
    }
  });

  it('名称段里的行内 `;` 不截断（与 eratw 同一规则，不为 AM 新开口径）', () => {
    const t = parseVariableCsv('2,季節;（1=春 2=夏 3=秋 4=冬）\n');
    expect(t.byIndex.get('2')).toBe('季節;（1=春 2=夏 3=秋 4=冬）');
  });
});

/* ============================ `.ERH` 具名常量（作者自定名表） ============================ */

describe('parseErhConsts', () => {
  it('两种声明形态都收：`#DIM CONST NAME = 1101` 与 `#DEFINE NAME 0`（含 0x）', () => {
    const m = parseErhConsts(
      [
        '#DIM CONST CHAR_PER_LINE = 133', // TRANSLATION.ERH:2 实测原文
        '#DIM CONST C_YELLOW = 0xFFFF00', // 十六进制色值一族（TRANSLATION.ERH:6）
        '#DEFINE DAILY_デート 101', // DAILY_CMD.ERH:6 实测原文（日文名）
        '#DEFINE K15_MACHINE_COLOR 0xccffe5', // EVENT_K15_槞彁.ERH 实测原文
      ].join('\n'),
    );
    expect(m.get('CHAR_PER_LINE')).toBe(133);
    expect(m.get('C_YELLOW')).toBe(0xffff00);
    expect(m.get('DAILY_デート')).toBe(101);
    expect(m.get('K15_MACHINE_COLOR')).toBe(0xccffe5);
    expect(m.size).toBe(4);
  });

  it('四类不收：无 CONST 的 `#DIM` / 数组 / 字符串值 / 负值·表达式', () => {
    const m = parseErhConsts(
      [
        '#DIM Z_DEPTH = -2', // GLAPHICS.ERH:1 实测：无 CONST 且负值
        '#DIM CUTINID = 2000', // GLAPHICS.ERH 实测：无 CONST ⇒ 可写变量，不收
        '#DIM LATESTCUTINCHARA, 6', // 数组声明（新变量族），不收
        '#DIM CONST ARR = 0, 100, 500', // CONST 数组：无唯一编号，不收
        '#DIM CONST EXPR = 0x44 + 1', // 表达式：不在字典里求值，不收
        '#DEFINE K15_VOICE_COLOR "ffdbff"', // EVENT_K15_槞彁.ERH 实测：字符串值，不收
        '#DIMS SAVEDATA K15_MainStory', // 关键字吃掉后无 CONST，不收
        '#DIMS D20XX_MAP,200,200,3', // EVENT_K15_Demoslaviya20XX.ERH 实测：3 维数组，不收
      ].join('\n'),
    );
    expect(m.size).toBe(0);
  });

  it('行尾 `;` 注释先截后解析（`#DEFINE DAILY_写真撮影をする 190 ;290` 实测）', () => {
    const m = parseErhConsts('#DEFINE DAILY_写真撮影をする 190 ;290');
    expect(m.get('DAILY_写真撮影をする')).toBe(190);
  });

  it('BOM + CRLF 两条都容（AM 9 份 `.ERH` 全部带 BOM、8 份 CRLF，2026-10-18 实测）', () => {
    for (const text of ['\uFEFF#DEFINE BaseTachieSize 4000\r\n', '\uFEFF#DEFINE BaseTachieSize 4000\n']) {
      expect(parseErhConsts(text).get('BASETACHIESIZE')).toBe(4000);
    }
  });

  it('键按大写存、同名首个定义优先', () => {
    const m = parseErhConsts(['#DIM CONST Same = 1', '#DIM CONST SAME = 2'].join('\n'));
    expect(m.size).toBe(1);
    expect(m.get('SAME')).toBe(1);
  });

  it('非 `#` 行 / `#` 后非声明行不收（不抛）', () => {
    expect(parseErhConsts('IF FOO\n; #DIM CONST X = 1\n#PRINT 1').size).toBe(0);
  });
});

/* ============================ 追加名表合并（只并集、不覆盖） ============================ */

describe('mergeVariableTable：追加名表并入 = 只并集、不覆盖', () => {
  it('并入 `.als` 后主表编号的名称一字不改，追加名进反向表', () => {
    const table = parseVariableCsv('9,親密\n'); // 主表形态
    const merged = mergeVariableTable(table, '9,亲密\n', 'append'); // 追加表同编号双写
    expect(table.byIndex.get('9')).toBe('親密'); // **没有被改成 亲密**
    expect(table.byName.get('亲密')).toBe('9');
    expect(table.byName.get('親密')).toBe('9');
    expect(merged).toEqual({ addedIndex: 0, addedName: 1 });
  });

  it('`.als` 独有的编号补得进、主表没有的键才记 append 源', () => {
    const table = parseVariableCsv('5,肛用振動棒,4500,\n;6,後庭拉珠,4500,\n');
    const merged = mergeVariableTable(table, '6,アナルビーズ,4500,\n', 'append');
    expect(table.byIndex.get('6')).toBe('アナルビーズ');
    expect(table.indexSource.get('6')).toBe('append');
    expect(merged).toEqual({ addedIndex: 1, addedName: 1 });
  });

  it('同名字**跨编号**相撞时主表胜出（名称仍指主表编号）', () => {
    const table = parseVariableCsv('4,バイブ\n');
    const merged = mergeVariableTable(table, '5,バイブ\n', 'append');
    expect(table.byName.get('バイブ')).toBe('4');
    expect(table.byIndex.get('5')).toBe('バイブ');
    expect(merged).toEqual({ addedIndex: 1, addedName: 0 });
  });

  it('source 标注（ALS-R1）：主表已有的键 `.als` 再写一遍**不改源**', () => {
    const table = parseVariableCsv('2,好感度\n');
    mergeVariableTable(table, '2,心情\n3,新名\n', 'append');
    // 编号 2 与名称「好感度」都仍是主表源（"只并集不覆盖"的另一面）
    expect(table.indexSource.get('2')).toBe('primary');
    expect(table.nameSource.get('好感度')).toBe('primary');
    // 只有新键才记 append
    expect(table.indexSource.get('3')).toBe('append');
    expect(table.nameSource.get('新名')).toBe('append');
  });

  it('同一份表内同编号两个名字：编号取首条，两名都收', () => {
    const t = parseVariableCsv('10,情绪\n10,情緒\n');
    expect(t.byIndex.get('10')).toBe('情绪');
    expect(t.byName.get('情绪')).toBe('10');
    expect(t.byName.get('情緒')).toBe('10');
  });

  it('`source` 缺省 = primary（主表轮不显式传参）', () => {
    const table = parseVariableCsv('');
    mergeVariableTable(table, '1,x\n');
    expect(table.indexSource.get('1')).toBe('primary');
    expect(table.nameSource.get('x')).toBe('primary');
  });
});

/* ============================ loader（假 io 三层合并） ============================ */

describe('loadErakumamaidVariableSchema', () => {
  /** 合成 io：`files` 键 = 绝对路径；`fail` 里的路径读失败（readTexts 失败位 null） */
  function fakeIo(
    files: Record<string, string>,
    opts: { fail?: readonly string[]; failDirs?: readonly string[] } = {},
  ): FileIO {
    const readOne = async (path: string): Promise<{ path: string; text: string } | null> => {
      if (opts.fail?.some((f) => path.endsWith(f))) return null;
      const body = files[path];
      if (body === undefined) return null;
      return { path, text: body };
    };
    return {
      listDir: async (dir: string) => {
        if (opts.failDirs?.includes(dir)) throw new Error(`模拟目录不可读：${dir}`);
        const prefix = dir.endsWith('/') ? dir : `${dir}/`;
        return Object.keys(files)
          .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
          .map((p) => ({
            name: p.slice(prefix.length),
            path: p,
            isDirectory: false,
          }))
          .concat({ name: 'Chara', path: `${prefix}Chara`, isDirectory: true });
      },
      readText: async (path: string) => {
        const r = await readOne(path);
        if (r === null) throw new Error(`没有这个文件：${path}`);
        return r;
      },
      readTexts: async (paths: readonly string[]) => Promise.all(paths.map(readOne)),
      /** 递归遍历（ERH 扫描用）：返回 `root` 下全部文件条目（含子目录里的） */
      walkDir: async (root: string) => {
        const prefix = root.endsWith('/') ? root : `${root}/`;
        return Object.keys(files)
          .filter((p) => p.startsWith(prefix))
          .map((p) => ({ name: p.slice(p.lastIndexOf('/') + 1), path: p, isDirectory: false }));
      },
    } as unknown as FileIO;
  }

  const load = (
    files: Record<string, string>,
    opts: { fail?: readonly string[]; erbDir?: string; marketAppendDirs?: readonly string[] } = {},
  ) =>
    loadErakumamaidVariableSchema({
      io: fakeIo(files, { fail: opts.fail }),
      csvDir: '/game/CSV',
      ...(opts.erbDir !== undefined ? { erbDir: opts.erbDir } : {}),
      ...(opts.marketAppendDirs !== undefined ? { marketAppendDirs: opts.marketAppendDirs } : {}),
      log: silentLog,
    });

  it('扫描目录、按文件名大写建表、lookup 双向可用', async () => {
    const schema = await load({
      '/game/CSV/CFLAG.csv': '2,好感度\n4,信頼度\n',
      '/game/CSV/Talent.csv': '3,恋慕\n',
    });

    expect(schema.lookup('CFLAG', 2)).toEqual({
      name: 'CFLAG',
      index: 2,
      description: '好感度',
      resolvedIndex: 2,
      source: 'primary',
    });
    expect(schema.lookup('cflag', '2')).toEqual({
      name: 'CFLAG',
      index: '2',
      description: '好感度',
      resolvedIndex: 2,
      source: 'primary',
    });
    expect(schema.lookup('TALENT', '恋慕')).toEqual({
      name: 'TALENT',
      index: '恋慕',
      description: '恋慕',
      resolvedIndex: 3,
      source: 'primary',
    });
    // 家族级（无索引）：游戏无机读族名表 → 取适配器内置策展常量（不是索引条目 ⇒ 不标源）
    expect(schema.lookup('CFLAG')).toEqual({ name: 'CFLAG', description: '角色标志' });
    // 未知编号 → 只回显（"族在、索引无"）
    expect(schema.lookup('CFLAG', 999)).toEqual({ name: 'CFLAG', index: 999 });
    // 未知族 → undefined（"族无"）
    expect(schema.lookup('NOPE', 1)).toBeUndefined();
  });

  it('三层合并：先全部 `.csv` 后全部 `.als`；枚举顺序无关（`.als` 排前面也主表优先）', async () => {
    const pair = {
      '/game/CSV/TCVAR.csv': '144,薬\n145,烂醉\n146,不耐烦\n',
      '/game/CSV/TCVAR.als': '144,お薬\n145,泥酔\n146,待たぬ\n',
    };
    for (const files of [pair, { '/game/CSV/TCVAR.als': pair['/game/CSV/TCVAR.als']!, '/game/CSV/TCVAR.csv': pair['/game/CSV/TCVAR.csv']! }]) {
      const schema = await load(files);
      // 主表编号名称逐字不变
      expect(schema.lookup('TCVAR', 145)?.description).toBe('烂醉');
      // `.als` 别名进反向表且如实标源（ALS-R1）
      expect(schema.lookup('TCVAR', '泥酔')).toEqual({
        name: 'TCVAR',
        index: '泥酔',
        description: '泥酔',
        resolvedIndex: 145,
        source: 'append',
      });
      // 主表写法仍是 primary（同一张表两个名字来源不同，正是分层要区分的）
      expect(schema.lookup('TCVAR', '烂醉')?.source).toBe('primary');
    }
  });

  it('只有 `.als`、没有同名 `.csv` 时照样建表', async () => {
    const schema = await load({ '/game/CSV/BUFF.als': '1,状態A\n2,状態B\n' });
    expect(schema.lookup('BUFF', '状態B')?.resolvedIndex).toBe(2);
    expect(schema.lookup('BUFF', 1)?.description).toBe('状態A');
    expect(schema.lookup('BUFF', 1)?.source).toBe('append');
  });

  it('`.als` 读失败：主表照旧可用，且失败必须进日志（铁律 4：不许静默）', async () => {
    const warnings: string[] = [];
    const schema = await loadErakumamaidVariableSchema({
      io: fakeIo(
        {
          '/game/CSV/TCVAR.csv': '145,烂醉\n',
          '/game/CSV/TCVAR.als': '145,泥酔\n',
        },
        { fail: ['TCVAR.als'] },
      ),
      csvDir: '/game/CSV',
      log: { ...silentLog, warn: (m: string) => warnings.push(m) },
    });
    expect(schema.lookup('TCVAR', '烂醉')?.resolvedIndex).toBe(145); // 主表没被牵连
    expect(schema.lookup('TCVAR', '泥酔')?.resolvedIndex).toBeUndefined(); // 追加名确实没进来
    expect(warnings.some((w) => w.includes('TCVAR.als'))).toBe(true);
  });

  it('市场字典包（KM-15）：目录与文件按路径排序并入、一律 append 源', async () => {
    const schema = await load(
      {
        '/game/CSV/TCVAR.csv': '145,烂醉\n',
        '/market/TCVAR.als': '145,泥酔\n147,市場名\n',
      },
      { marketAppendDirs: ['/market'] },
    );
    expect(schema.lookup('TCVAR', 145)?.description).toBe('烂醉'); // 主表不被市场包覆盖
    expect(schema.lookup('TCVAR', '市場名')?.source).toBe('append');
    expect(schema.lookup('TCVAR', '泥酔')?.resolvedIndex).toBe(145);
  });

  it('`_TR` 变体表不是追加名表：首列是名称不是编号 ⇒ 天然 0 条（实测结论）', async () => {
    // TALENT_TR.csv:1-4 实测原文（JP→EN 翻译表）
    const schema = await load({
      '/game/CSV/TALENT_TR.csv': '\uFEFF;[性別]種族も含む\nオンナ,Female\nふたなり,Futanari\nオトコ,Male\n男の娘,Trap\n',
      '/game/CSV/ABL_TR.csv': '\uFEFF;0～9は基本的なもの\n信頼,Trust\n欲望,Desire\n',
    });
    // 表被建出（族在）但 0 条目；lookup 回显"族在、索引无"而非 undefined
    expect(schema.lookup('TALENT_TR', 1)).toEqual({ name: 'TALENT_TR', index: 1 });
    expect(schema.names?.('TALENT_TR')).toEqual([]);
    expect(schema.lookup('ABL_TR', '信頼')).toEqual({ name: 'ABL_TR', index: '信頼' });
  });

  it('`.ERH` const 层（FT-1）：两种声明形态经 loader 收录，const 源不宣称族归属', async () => {
    const schema = await load(
      {
        '/game/CSV/CFLAG.csv': '2,好感度\n',
        '/game/ERB/ERH/A.ERH': '#DIM CONST C_YELLOW = 0xFFFF00\n',
        '/game/ERB/ERH/B.ERH': '#DEFINE DAILY_デート 101\n#DEFINE K15_VOICE_COLOR "ffdbff"\n',
      },
      { erbDir: '/game/ERB' },
    );
    // 名称表查无 → const 兜底：`CFLAG:C_YELLOW` 与 `CFLAG:16776960` 是同一个槽位
    expect(schema.lookup('CFLAG', 'C_YELLOW')).toEqual({
      name: 'CFLAG',
      index: 'C_YELLOW',
      description: 'C_YELLOW',
      resolvedIndex: 0xffff00,
      source: 'const',
    });
    // 日文名 + 大小写不敏感（键大写存）；const 层只对**已存在的族**兜底（族无 ⇒ 直接 undefined）
    expect(schema.lookup('CFLAG', 'daily_デート')?.resolvedIndex).toBe(101);
    // 字符串值不收 ⇒ 只回显
    expect(schema.lookup('CFLAG', 'K15_VOICE_COLOR')).toEqual({ name: 'CFLAG', index: 'K15_VOICE_COLOR' });
    // 名称表优先于 const 层（既有读数一条不受影响）
    expect(schema.lookup('CFLAG', 2)?.description).toBe('好感度');
  });

  it('`.ERH` 扫描失败 / 读失败：降级跳过不抛，名称表照常', async () => {
    const warnings: string[] = [];
    const schema = await loadErakumamaidVariableSchema({
      io: {
        ...fakeIo({ '/game/CSV/CFLAG.csv': '2,好感度\n' }),
        walkDir: async () => {
          throw new Error('boom');
        },
      } as unknown as FileIO,
      csvDir: '/game/CSV',
      erbDir: '/game/ERB',
      log: { ...silentLog, warn: (m: string) => warnings.push(m) },
    });
    expect(schema.lookup('CFLAG', 2)?.description).toBe('好感度');
    expect(schema.lookup('CFLAG', 'C_YELLOW')).toEqual({ name: 'CFLAG', index: 'C_YELLOW' });
    expect(warnings.some((w) => w.includes('自定名表扫描失败'))).toBe(true);
  });

  it('erbDir 缺省 = 完全不读 `.ERH`（历史调用方行为逐字不变）', async () => {
    const schema = await load({ '/game/CSV/CFLAG.csv': '2,好感度\n' });
    expect(schema.lookup('CFLAG', 'C_YELLOW')).toEqual({ name: 'CFLAG', index: 'C_YELLOW' });
  });

  it('chsMapPath：AM 无 JP→CN 名词典 ⇒ 传入即告警、不消费（不静默）', async () => {
    const warnings: string[] = [];
    const schema = await loadErakumamaidVariableSchema({
      io: fakeIo({ '/game/CSV/CFLAG.csv': '2,好感度\n' }),
      csvDir: '/game/CSV',
      chsMapPath: '/game/plugins/tw_csv_chs.xml',
      log: { ...silentLog, warn: (m: string) => warnings.push(m) },
    });
    expect(schema.lookup('CFLAG', 2)?.description).toBe('好感度'); // 名称一律原文
    expect(warnings.some((w) => w.includes('chsMapPath'))).toBe(true);
    // slotCn 缺省（AM 不实现 JP→CN 查询面；缺省 = 不猜）
    expect(schema.slotCn).toBeUndefined();
  });

  it('CSV 目录不可读时返回空字典（不抛错）', async () => {
    const schema = await loadErakumamaidVariableSchema({
      io: fakeIo({}, { failDirs: ['/game/CSV'] }),
      csvDir: '/game/CSV',
      log: silentLog,
    });
    expect(schema.lookup('CFLAG', 2)).toBeUndefined();
  });

  it('inputDigest：同输入稳定、与目录顺序无关、改描述即变、`.als`/`.ERH` 也算输入', async () => {
    const base = {
      '/game/CSV/CFLAG.csv': '2,好感度\n',
      '/game/CSV/Talent.csv': '3,恋慕\n',
      '/game/ERB/A.ERH': '#DIM CONST X = 1\n',
    };
    const a = await load(base, { erbDir: '/game/ERB' });
    const b = await load(
      { '/game/ERB/A.ERH': '#DIM CONST X = 1\n', '/game/CSV/Talent.csv': '3,恋慕\n', '/game/CSV/CFLAG.csv': '2,好感度\n' },
      { erbDir: '/game/ERB' },
    );
    const changed = await load({ ...base, '/game/CSV/CFLAG.csv': '2,心情\n' }, { erbDir: '/game/ERB' });
    const noErh = await load(base); // 不传 erbDir ⇒ ERH 不进判据
    const changedErh = await load({ ...base, '/game/ERB/A.ERH': '#DIM CONST X = 2\n' }, { erbDir: '/game/ERB' });

    expect(typeof a.inputDigest).toBe('string');
    expect(a.inputDigest).toBe(b.inputDigest); // 顺序无关（foldDigest 先排序）
    expect(changed.inputDigest).not.toBe(a.inputDigest);
    expect(noErh.inputDigest).not.toBe(a.inputDigest);
    expect(changedErh.inputDigest).not.toBe(a.inputDigest);
    // 一张都读不到也是确定值（区别于 undefined = "没有判据"）
    const none = await load({});
    expect(typeof none.inputDigest).toBe('string');
    expect(none.inputDigest).not.toBe(a.inputDigest);
  });

  /* ---------------- KC-1：`names`（枚举索引名，供插值补全） ---------------- */

  it('names：由 `byIndex` 枚举该族索引名；`.als` 新编号也进枚举且标源；未知族空', async () => {
    const schema = await load({
      '/game/CSV/CFLAG.csv': '2,好感度\n4,信頼度\n30,好色\n',
      '/game/CSV/Talent.csv': '3,恋慕\n',
      '/game/CSV/CFLAG.als': '5,追加名\n',
    });

    const cflag = schema.names?.('CFLAG') ?? [];
    expect(cflag.length).toBe(4);
    const byName = new Map(cflag.map((i) => [i.name, i]));
    expect(byName.get('好感度')).toMatchObject({ index: 2, resolvedIndex: 2, source: 'primary' });
    expect(byName.get('好色')).toMatchObject({ index: 30, resolvedIndex: 30, source: 'primary' });
    expect(byName.get('追加名')).toMatchObject({ index: 5, resolvedIndex: 5, source: 'append' });

    // 族名大小写不敏感（与 lookup 同口径）；未收录的族 → 空数组（不猜、不抛）
    expect((schema.names?.('talent') ?? []).map((i) => i.name)).toEqual(['恋慕']);
    expect(schema.names?.('NOPE')).toEqual([]);
  });

  /* ---------------- D2：家族头中文别名（写侧 / 读侧反向） ---------------- */

  it('familyAlias / familyAliasReverse：双向可查、未登记不猜', async () => {
    const schema = await load({ '/game/CSV/CFLAG.csv': '2,好感度\n' });
    expect(schema.familyAlias?.('现在')).toBe('NOWEX');
    expect(schema.familyAlias?.('标记')).toBe('FLAG');
    expect(schema.familyAlias?.('不存在的名')).toBeUndefined();
    expect(schema.familyAliasReverse?.('nowex')).toBe('现在');
    expect(schema.familyAliasReverse?.('CFLAG')).toBe('角色标志');
    expect(schema.familyAliasReverse?.('NOPE')).toBeUndefined();
  });

  /* ---------------- 三张策展表的全覆盖闸 ---------------- */

  it('全覆盖闸：ENGINE_FAMILIES 每族要么有别名、要么在排除台账且有理由', () => {
    const aliasTargets = new Set(Object.values(FAMILY_ALIASES));
    const missing = ENGINE_FAMILIES.filter((f) => !aliasTargets.has(f) && FAMILY_ALIAS_EXCLUSIONS[f] === undefined);
    expect(missing, `未覆盖的引擎族：${missing.join(', ')}`).toEqual([]);
  });

  it('三张表互相对账：别名指向 ⊆ 全集、排除台账键 ⊆ 全集、标签表不造全集外的族', () => {
    const engine = new Set(ENGINE_FAMILIES);
    // 别名指向的族必须在引擎全集里（防打错族头）
    const badTargets = Object.entries(FAMILY_ALIASES)
      .filter(([, f]) => !engine.has(f))
      .map(([a, f]) => `${a}→${f}`);
    expect(badTargets).toEqual([]);
    // 排除台账键必须在引擎全集里（防给不存在的族写理由）
    const badExclusions = Object.keys(FAMILY_ALIAS_EXCLUSIONS).filter((f) => !engine.has(f));
    expect(badExclusions).toEqual([]);
    // 排除台账每条都有非空理由（"留名给理由"，不留白）
    for (const [family, reason] of Object.entries(FAMILY_ALIAS_EXCLUSIONS)) {
      expect(reason.length, family).toBeGreaterThan(0);
    }
    // 显示标签表不造引擎全集之外的族
    const badLabels = Object.keys(FAMILY_LABELS).filter((f) => !engine.has(f));
    expect(badLabels).toEqual([]);
    // 反向表由别名表派生：每个别名都能round-trip（AM 别名无重目标，实测 44/44）
    for (const [alias, family] of Object.entries(FAMILY_ALIASES)) {
      expect(FAMILY_ALIASES_REVERSE[family], alias).toBe(alias);
    }
  });
});

/* ============================ 真实语料读数（2026-10-18，eraAkumaMaid） ============================ */

const hasCorpus = existsSync(GAME_ROOT);
const corpus = hasCorpus ? describe : describe.skip;

corpus('真实语料读数：CSV 格式与 `.ERH` 声明数（实测钉结论）', () => {
  it('CSV/CFLAG.csv 前 10 行：BOM + `编号,名称,<tab><tab>;注释` 形态', () => {
    const text = readFileSync(join(GAME_ROOT, 'CSV/CFLAG.csv'), 'utf-8');
    const lines = text.split(/\r\n?|\n/).slice(0, 10);
    expect(lines[0]?.startsWith('\uFEFF0,キャラ用,')).toBe(true); // 首行即编号行（无分组注释头）
    expect(lines[2]).toBe('2,好感度'); // CFLAG:2 = 好感度
    expect(lines[7]).toBe('7,日常イベント回数,\t;日常イベントを選ぶ毎に+1。回数に応じて特殊なセリフを喋らせると良いでしょう');
    // 解析口径：342 条编号行 / 341 个唯一名（"ランダム" 简繁…同编号双名实测 1 组）
    const t = parseVariableCsv(text);
    expect(t.byIndex.size).toBe(342);
    expect(t.byName.size).toBe(341);
  });

  it('CSV/TALENT.csv 前 10 行：BOM + `;性別` 分组注释头', () => {
    const text = readFileSync(join(GAME_ROOT, 'CSV/TALENT.csv'), 'utf-8');
    const lines = text.split(/\r\n?|\n/).slice(0, 10);
    expect(lines[0]).toBe('\uFEFF;性別');
    expect(lines[4]).toBe('3,男の娘,\t\t;男にも女にも見える魅力的な容姿で、男だというのに女性的な振る舞いも好みます');
    const t = parseVariableCsv(text);
    expect(t.byIndex.size).toBe(191);
    expect(t.byIndex.get('3')).toBe('男の娘');
  });

  it('3 份 `ERB/ERH/*.ERH` 声明数统计：ANIMATION 0 / DAILY_CMD 41 / GLAPHICS 0', () => {
    const expected: Record<string, number> = {
      'ANIMATION.ERH': 0, // 全是 `#DIM/#DIMS` 新变量族声明，无 CONST
      'DAILY_CMD.ERH': 41, // `#DEFINE DAILY_* 整数`（含行尾 `;290` 注释）
      'GLAPHICS.ERH': 0, // `#DIM Z_DEPTH = -2` 一族：无 CONST / 负值 / 数组
    };
    for (const [name, n] of Object.entries(expected)) {
      const text = readFileSync(join(GAME_ROOT, 'ERB/ERH', name), 'utf-8');
      expect(parseErhConsts(text).size, name).toBe(n);
    }
  });

  it('全树 9 份 `.ERH` 合计收录 96 个唯一名字（0 组同名不同值）', () => {
    const erhDir = join(GAME_ROOT, 'ERB');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((e) => {
        const p = join(dir, e);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    const erhFiles = walk(erhDir)
      .filter((p) => /\.erh$/i.test(p))
      .sort();
    expect(erhFiles.length).toBe(9);
    const merged = new Map<string, number>();
    for (const p of erhFiles) {
      for (const [k, v] of parseErhConsts(readFileSync(p, 'utf-8'))) {
        if (!merged.has(k)) merged.set(k, v); // 首个定义优先
      }
    }
    expect(merged.size).toBe(96);
    expect(merged.get('C_YELLOW')).toBe(0xffff00);
    expect(merged.get('DAILY_デート')).toBe(101);
  });

  it('`_TR` 翻译表 7 份全部 0 条收录（JP→EN，不是 `编号,名称` 名表）', () => {
    const csvDir = join(GAME_ROOT, 'CSV');
    const trFiles = readdirSync(csvDir).filter((n) => /_TR\.csv$/i.test(n));
    expect(trFiles.length).toBe(7); // SOURCE_TR.csv.disabled 扩展名进不了扫描
    for (const name of trFiles) {
      expect(parseVariableCsv(readFileSync(join(csvDir, name), 'utf-8')).byIndex.size, name).toBe(0);
    }
  });

  it('全树 0 份 `.als` ⇒ 追加层空转（代码路径保留，行为与 eratw 一致）', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((e) => {
        const p = join(dir, e);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    const als = walk(GAME_ROOT).filter((p) => /\.als$/i.test(p));
    expect(als).toEqual([]);
  });
});

corpus('真实语料读数：loader 端到端（真 io）', () => {
  /** node:fs 支撑的真 FileIO（listDir / readTexts / walkDir 三条路径全覆盖） */
  function realIo(): FileIO {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((e) => {
        const p = join(dir, e);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    return {
      listDir: async (dir: string) =>
        readdirSync(dir).map((name) => ({ name, path: join(dir, name), isDirectory: statSync(join(dir, name)).isDirectory() })),
      readText: async (path: string) => ({ path, text: readFileSync(path, 'utf-8') }),
      readTexts: async (paths: readonly string[]) => paths.map((p) => ({ path: p, text: readFileSync(p, 'utf-8') })),
      walkDir: async (root: string) =>
        walk(root)
          .sort()
          // 条目名取 basename（win32 的 join 产反斜杠，两种分隔符都切）
          .map((p) => ({ name: p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1), path: p, isDirectory: false })),
    } as unknown as FileIO;
  }

  it('全量加载：主表 + `.ERH` const 层 + digest（同输入两次相等）', async () => {
    const load = () =>
      loadErakumamaidVariableSchema({
        io: realIo(),
        csvDir: join(GAME_ROOT, 'CSV'),
        erbDir: join(GAME_ROOT, 'ERB'),
        log: silentLog,
      });
    const schema = await load();
    const again = await load();

    // 主表双向（实测读数；注意 AM 的 `恋慕` = TALENT:150，与 eraTW 的 3 不同）
    expect(schema.lookup('CFLAG', 2)?.description).toBe('好感度');
    expect(schema.lookup('TALENT', '恋慕')?.resolvedIndex).toBe(150);
    expect(schema.lookup('TALENT', 3)?.description).toBe('男の娘');
    // 家族级标签
    expect(schema.lookup('CFLAG')?.description).toBe('角色标志');
    // const 层（0xFFFF00 / DAILY 编号）
    expect(schema.lookup('CFLAG', 'C_YELLOW')?.resolvedIndex).toBe(0xffff00);
    expect(schema.lookup('CFLAG', 'C_YELLOW')?.source).toBe('const');
    expect(schema.lookup('TALENT', 'DAILY_デート')?.resolvedIndex).toBe(101);
    // `_TR` 空表形态（族在、索引无）
    expect(schema.lookup('TALENT_TR', 1)).toEqual({ name: 'TALENT_TR', index: 1 });
    // names 枚举规模（实测）
    expect(schema.names?.('CFLAG')?.length).toBe(342);
    expect(schema.names?.('TALENT')?.length).toBe(191);
    // digest：确定值 + 同输入两次相等
    expect(typeof schema.inputDigest).toBe('string');
    expect(schema.inputDigest).toBe(again.inputDigest);
  }, 120000);
});
