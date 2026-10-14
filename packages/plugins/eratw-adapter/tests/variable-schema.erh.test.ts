/**
 * FT-1：`.ERH` 作者自定名表进字典 —— 夹具面（规则钉死，不吃游戏盘）。
 *
 * 语料形态取自**画蛇添足版 153 份 `.ERH` 实测**（份数 / 形态读数见 `variable-schema.ts`
 * 的 `parseErhConsts` 头注），每条"收"都配一条"不收"的相邻断言，防规则松口：
 * - 收：`#DIM CONST NAME = 1101`（5,738 条，本表主体）/ 行尾 `;` 注释 / tab 分隔 /
 *   `0x` 十六进制 / `#DEFINE DT_VAGINA 0`（纯整数 2 条）
 * - 不收：`#DIM NAME, 10`（875 条，声明的是"新变量族"不是"名字=编号"）/
 *   `#DIM NAME = 351`（69 条，**无 CONST ⇒ 可写变量**，运行期可被改写 ⇒ 收了就是猜）/
 *   `#DIM CONST X = 0, 100, 500`（数组，无唯一编号）/ `#DIM CONST X = 0x44 + COLOR_FROMNAME(…)`
 *   （表达式，不求值）/ `#DEFINE DEF_LIST_MARKHEART UNICODE(0x2665)`
 */
import { describe, expect, it } from 'vitest';
import type { FileIO, Logger } from '@kojo/plugin-api';
import { loadEratwVariableSchema, parseErhConsts } from '../src/variable-schema';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** 真实盘上原句（`ERB/Headers/AutoConst_CFLAG.ERH` + 各角色 `*用DIM.ERH`） */
const ERH_TEXT = [
  '; =====================================================',
  '; 自动生成的常量头文件 - 源文件: CFLAG.csv',
  '',
  '#DIM CONST CFLAG_好感度 = 2',
  '#DIM CONST K15C_SETTING_DISABLE_HATE_DIALOG\t\t\t\t\t=\t1101',
  '#DIM CONST K17C_部位V\t\t\t= 1',
  '#DIM CONST MAX_COLUMN = 12 ;無効数値を持つセルの扱いで困ってしまったので',
  '#DIM CONST LIST_COLOR_DEFAULT = 0x44000000 + COLOR_FROMNAME("dimgray") , 0xFF000000',
  '#DIM CONST 好感度ランク = 0, 100, 500, 1000',
  '#DIM K23_选择分支 = 351',
  '#DIM SAVEDATA 催眠系统开关 = 1',
  '#DIMS CONST DT_SORT_TYPE = "DESC" , "ASC"',
  '#DIM PER_PAGE',
  '#DEFINE DT_VAGINA 0',
  '#DEFINE DT_ANUS 1',
  '#DEFINE DEF_LIST_MARKHEART UNICODE(0x2665) ;黒塗りハート',
  '#DEFINE DEF_COLUMN_IS_STR "STR"',
].join('\n');

describe('parseErhConsts（`.ERH` 具名常量）', () => {
  it('收"名字 = 一个整数"：十进制 / 十六进制 / tab 分隔 / 行尾注释 / CJK 名', () => {
    const m = parseErhConsts(ERH_TEXT);
    expect(m.get('K15C_SETTING_DISABLE_HATE_DIALOG')).toBe(1101);
    expect(m.get('K17C_部位V')).toBe(1);
    expect(m.get('CFLAG_好感度')).toBe(2);
    expect(m.get('MAX_COLUMN')).toBe(12); // 行尾 `;` 注释实测常见
  });

  it('#DEFINE 只收纯整数值（2 条），字符串 / 函数调用形态一条不收', () => {
    const m = parseErhConsts(ERH_TEXT);
    expect(m.get('DT_VAGINA')).toBe(0);
    expect(m.get('DT_ANUS')).toBe(1);
    expect(m.has('DEF_LIST_MARKHEART')).toBe(false);
    expect(m.has('DEF_COLUMN_IS_STR')).toBe(false);
  });

  it('不收（宁缺勿猜）：数组常量 / 表达式常量 / 无 CONST 的可写变量 / 普通 #DIM 声明', () => {
    const m = parseErhConsts(ERH_TEXT);
    expect(m.has('好感度ランク')).toBe(false); // `= 0, 100, 500, 1000` 无唯一编号
    expect(m.has('LIST_COLOR_DEFAULT')).toBe(false); // 表达式，不在字典里求值
    expect(m.has('DT_SORT_TYPE')).toBe(false); // `#DIMS CONST` 是字符串常量
    expect(m.has('K23_选择分支')).toBe(false); // `#DIM X = 351` 无 CONST ⇒ 可写变量
    expect(m.has('催眠系统开关')).toBe(false); // `#DIM SAVEDATA …` 同上，且落存档
    expect(m.has('PER_PAGE')).toBe(false); // `#DIM PER_PAGE` 是"新变量族"
  });

  it('键大小写不敏感（`emuera.config` IGNORE CASE:YES），同名首个定义优先', () => {
    const m = parseErhConsts(['#DIM CONST FOO = 1', '#dim const foo = 2', '#DIM CONST FOO = 3'].join('\n'));
    expect(m.get('FOO')).toBe(1);
    expect(m.size).toBe(1);
  });

  it('负值 / 非整数 / 空名一律不收；非 `#` 行与 `;` 起行不解析', () => {
    const m = parseErhConsts([';#DIM CONST X = 1', '#DIM CONST NEG = -5', '#DIM CONST = 7', 'PRINT 1'].join('\n'));
    expect(m.size).toBe(0);
  });
});

describe('loadEratwVariableSchema：erbDir（作者自定名表）接线', () => {
  const CSV: Record<string, string> = {
    'CFLAG.csv': '1,既成事実\n2,好感度\n',
    'CFLAG.als': '145,泥酔\n',
    'Abl.csv': '1,Ｃ感覚\n',
  };

  /** 具名常量表放在 `/game/ERB/<子目录>/X.ERH`（真实盘就是散在子树里） */
  function ioWithErh(files: Record<string, string>, calls: { walkDir: number }): FileIO {
    return {
      listDir: async (dir: string) =>
        dir === '/game/CSV'
          ? Object.keys(CSV).map((name) => ({ name, path: `/game/CSV/${name}`, isDirectory: false }))
          : [],
      readText: async (path: string) => ({ text: files[path] ?? CSV[path.replace('/game/CSV/', '')] ?? '', path }),
      walkDir: async () => {
        calls.walkDir++;
        return Object.keys(files).map((p) => ({ name: p.split('/').pop() as string, path: p, isDirectory: false }));
      },
    } as unknown as FileIO;
  }

  const erhFiles: Record<string, string> = {
    '/game/ERB/Headers/AutoConst_CFLAG.ERH': ERH_TEXT,
    '/game/ERB/口上・メッセージ関連/個人口上/K15C_SAKUYADIM.ERH': '#DIM CONST K99C_只在别的角色目录里 = 7',
  };

  it('不传 erbDir ⇒ 一个 ERH 字节都不读（walkDir 零调用），具名常量查无 —— 既有调用方逐字不变', async () => {
    const calls = { walkDir: 0 };
    const io = ioWithErh(erhFiles, calls);
    const base = await loadEratwVariableSchema({ io, csvDir: '/game/CSV', log: silentLog });
    expect(calls.walkDir).toBe(0);
    expect(base.lookup('CFLAG', 'K15C_SETTING_DISABLE_HATE_DIALOG')).toEqual({
      name: 'CFLAG',
      index: 'K15C_SETTING_DISABLE_HATE_DIALOG',
    });
    // 一张 io 里连 walkDir 都没有（旧消费方 / 旧夹具形态）也必须照常工作
    const noWalk = { listDir: io.listDir, readText: io.readText } as unknown as FileIO;
    const same = await loadEratwVariableSchema({ io: noWalk, csvDir: '/game/CSV', log: silentLog });
    expect(same.inputDigest).toBe(base.inputDigest);
  });

  it('传 erbDir ⇒ 具名常量按"名字→编号"可查（族头随便写哪个都认，与引擎"索引位是表达式"同口径）', async () => {
    const calls = { walkDir: 0 };
    const schema = await loadEratwVariableSchema({
      io: ioWithErh(erhFiles, calls),
      csvDir: '/game/CSV',
      erbDir: '/game/ERB',
      log: silentLog,
    });
    expect(calls.walkDir).toBe(1);
    expect(schema.lookup('CFLAG', 'K15C_SETTING_DISABLE_HATE_DIALOG')).toEqual({
      name: 'CFLAG',
      index: 'K15C_SETTING_DISABLE_HATE_DIALOG',
      description: 'K15C_SETTING_DISABLE_HATE_DIALOG',
      resolvedIndex: 1101,
    });
    // 声明不属任何族：换个头写一样能查（引擎同样是把名字当表达式求值）
    expect(schema.lookup('ABL', 'K17C_部位V')?.resolvedIndex).toBe(1);
    // 跨角色目录的声明全局可见（实测 0 组同名不同值 ⇒ 不会因此误判）
    expect(schema.lookup('CFLAG', 'K99C_只在别的角色目录里')?.resolvedIndex).toBe(7);
  });

  it('不翻案①：`.ERH` 并入后 `编号 → 名称` 与名称表具名逐字不变', async () => {
    const plain = await loadEratwVariableSchema({
      io: ioWithErh({}, { walkDir: 0 }),
      csvDir: '/game/CSV',
      log: silentLog,
    });
    const merged = await loadEratwVariableSchema({
      io: ioWithErh(erhFiles, { walkDir: 0 }),
      csvDir: '/game/CSV',
      erbDir: '/game/ERB',
      log: silentLog,
    });
    for (const [fam, idx, name] of [
      ['CFLAG', 2, '好感度'],
      ['CFLAG', 1, '既成事実'],
      ['ABL', 1, 'Ｃ感覚'],
    ] as const) {
      expect(merged.lookup(fam, idx)?.description, `${fam}:${idx}`).toBe(name);
      expect(merged.lookup(fam, name)?.resolvedIndex, `${fam}:${name}`).toBe(idx);
      expect(merged.lookup(fam, name)).toEqual(plain.lookup(fam, name));
    }
  });

  it('不翻案②：名称表（含 `.als` 追加名）优先于具名常量——常量不许改写既有编号', async () => {
    const schema = await loadEratwVariableSchema({
      io: ioWithErh(
        { '/game/ERB/X.ERH': '#DIM CONST 泥酔 = 999\n#DIM CONST 既成事実 = 888' },
        { walkDir: 0 },
      ),
      csvDir: '/game/CSV',
      erbDir: '/game/ERB',
      log: silentLog,
    });
    expect(schema.lookup('CFLAG', '泥酔')?.resolvedIndex).toBe(145); // `.als` 追加名照旧
    expect(schema.lookup('CFLAG', '既成事実')?.resolvedIndex).toBe(1); // 主表照旧
  });

  it('ERB 目录不可读 ⇒ 只 warn 跳过，名称表功能不受影响（不静默、不抛）', async () => {
    const inner = ioWithErh(erhFiles, { walkDir: 0 });
    const io = {
      listDir: inner.listDir,
      readText: inner.readText,
      walkDir: async () => {
        throw new Error('目录不存在');
      },
    } as unknown as FileIO;
    const warns: string[] = [];
    const log: Logger = { ...silentLog, warn: (m: string) => warns.push(m) };
    const schema = await loadEratwVariableSchema({ io, csvDir: '/game/CSV', erbDir: '/game/ERB', log });
    expect(warns.some((w) => w.includes('自定名表扫描失败'))).toBe(true);
    expect(schema.lookup('CFLAG', 2)?.description).toBe('好感度');
    expect(schema.lookup('CFLAG', 'K17C_部位V')).toEqual({ name: 'CFLAG', index: 'K17C_部位V' }); // 读不到 = 回显，绝不猜
  });

  it('摘要随 `.ERH` 内容变化而失效；`.ERH` 缺席时与不传 erbDir 完全相同', async () => {
    const without = await loadEratwVariableSchema({ io: ioWithErh(erhFiles, { walkDir: 0 }), csvDir: '/game/CSV', log: silentLog });
    const withErh = await loadEratwVariableSchema({
      io: ioWithErh(erhFiles, { walkDir: 0 }),
      csvDir: '/game/CSV',
      erbDir: '/game/ERB',
      log: silentLog,
    });
    const edited = await loadEratwVariableSchema({
      io: ioWithErh({ ...erhFiles, '/game/ERB/Headers/AutoConst_CFLAG.ERH': `${ERH_TEXT}\n#DIM CONST K15C_SETTING_DISABLE_HATE_DIALOG = 1101\nNEW_ONE = 3` }, { walkDir: 0 }),
      csvDir: '/game/CSV',
      erbDir: '/game/ERB',
      log: silentLog,
    });
    expect(withErh.inputDigest).not.toBe(without.inputDigest);
    // 内容变化必须进摘要（改一行常量声明 = 下游派生缓存作废）
    const edited2 = await loadEratwVariableSchema({
      io: ioWithErh(
        { ...erhFiles, '/game/ERB/Headers/AutoConst_CFLAG.ERH': ERH_TEXT.replace('1101', '1102') },
        { walkDir: 0 },
      ),
      csvDir: '/game/CSV',
      erbDir: '/game/ERB',
      log: silentLog,
    });
    expect(edited.inputDigest).not.toBe(withErh.inputDigest);
    expect(edited2.inputDigest).not.toBe(withErh.inputDigest);
    // 顺序无关（目录枚举顺序变了不该换摘要）
    const swapped = await loadEratwVariableSchema({
      io: (() => {
        const base = ioWithErh(erhFiles, { walkDir: 0 });
        return {
          ...base,
          walkDir: async () => (await base.walkDir('/game/ERB')).reverse(),
        } as unknown as FileIO;
      })(),
      csvDir: '/game/CSV',
      erbDir: '/game/ERB',
      log: silentLog,
    });
    expect(swapped.inputDigest).toBe(withErh.inputDigest);
  });
});
