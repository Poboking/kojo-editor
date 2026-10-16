import { describe, expect, it } from 'vitest';
import type { FileIO, Logger } from '@kojo/plugin-api';
import { loadEratwVariableSchema } from '../src/variable-schema';

/**
 * 市场字典包 → 变量字典「追加轮次」（KM-15）。
 *
 * 口径（与游戏 `CSV/*.als` 同一套合并裁决，一行不许另立）：
 * - 市场目录里的名表文件（`.csv` / `.als` 两种扩展名）**一律按 `source: 'append'` 并入**；
 * - 主表**只认游戏 CSV 目录**——市场包没有"主表"语义：`byIndex` 是悬停描述与降糖产物
 *   的唯一来源，市场包改一个编号的名称 = 改所有人已有产物的字面；
 * - 目录间与文件间按路径排序（先定义优先的裁决不随枚举顺序漂）；
 * - 市场缺席 / 读失败 ⇒ 与历史（无第三轮）逐字一致。
 *
 * fake io 照 `variable-schema.test.ts` 的既有模式：内存树 + 按前缀列一层。
 */

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** 内存树：路径 → 文本 / 'DIR' */
type Tree = Record<string, 'DIR' | string>;

interface IoOpts {
  /** listDir 对这些目录抛错（模拟目录不可读） */
  failDirs?: readonly string[];
}

function treeIo(tree: Tree, opts: IoOpts = {}): FileIO {
  return {
    async listDir(dir: string) {
      if (opts.failDirs?.includes(dir)) throw new Error(`模拟目录不可读：${dir}`);
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const out: Array<{ name: string; path: string; isDirectory: boolean }> = [];
      for (const key of Object.keys(tree)) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const name = rest.split('/')[0]!;
        if (out.some((x) => x.name === name)) continue;
        out.push({
          name,
          path: `${prefix}${name}`,
          isDirectory: tree[`${prefix}${name}`] === 'DIR' || rest.includes('/'),
        });
      }
      return out;
    },
    async readText(path: string) {
      const text = tree[path];
      if (typeof text !== 'string') throw new Error(`not a file: ${path}`);
      return { path, text };
    },
  } as unknown as FileIO;
}

const GAME = '/game';
const CSV_DIR = `${GAME}/CSV`;
/** 字典包落点形态：`<appData>/market/packs/dict-pack/<id>/<version>/files`（上一级是 pack.json） */
const DICT_A = '/appdata/market/packs/dict-pack/demo.lang/1.0.0/files';
const DICT_B = '/appdata/market/packs/dict-pack/demo.lore/2.0.0/files';

const MAIN_ABILITY = '1,力量\n2,敏捷\n';

/** 市场同名表：一条新名称 + 一条与主表同编号但异名 + 一条与主表同名但异编号 */
const MARKET_ABILITY = ['; 市场字典包追加名表（同一套行格式）', '3,幸运', '', '2,敏捷性', '5,敏捷'].join('\n');

const baseTree = (market: Tree): Tree => ({
  [`${CSV_DIR}/ABILITY.csv`]: MAIN_ABILITY,
  ...market,
});

describe('loadEratwVariableSchema · 市场字典包追加轮次（KM-15）', () => {
  it('主表逐字不变；新名称以 append 源并入；同编号异名不改写主表编号；同名异编号主表胜出', async () => {
    const schema = await loadEratwVariableSchema({
      io: treeIo(baseTree({ [`${DICT_A}/ABILITY.csv`]: MARKET_ABILITY })),
      csvDir: CSV_DIR,
      marketAppendDirs: [DICT_A],
      log: silentLog,
    });

    // ① 主表逐字不变：编号 1 / 2 的描述与来源层都是主表的（市场包没抢走任何一个）
    expect(schema.lookup('ABILITY', 1)).toEqual({
      name: 'ABILITY',
      index: 1,
      description: '力量',
      resolvedIndex: 1,
      source: 'primary',
    });
    expect(schema.lookup('ABILITY', 2)).toEqual({
      name: 'ABILITY',
      index: 2,
      description: '敏捷',
      resolvedIndex: 2,
      source: 'primary',
    });

    // ② 新名称（`3,幸运`）以 append 源并入，编号正确
    expect(schema.lookup('ABILITY', '幸运')).toEqual({
      name: 'ABILITY',
      index: '幸运',
      description: '幸运',
      resolvedIndex: 3,
      source: 'append',
    });
    expect(schema.lookup('ABILITY', 3)?.source).toBe('append');

    // ③ 同编号异名（`2,敏捷性`）：**不进 byIndex**（编号 2 的名称仍是主表原文），
    //    但作为别名进 byName 且如实标 append —— 与 `.als` 同一条"只并集、不覆盖"裁决
    expect(schema.lookup('ABILITY', '敏捷性')?.resolvedIndex).toBe(2);
    expect(schema.lookup('ABILITY', '敏捷性')?.source).toBe('append');
    expect(schema.lookup('ABILITY', 2)?.description).toBe('敏捷');

    // ④ 同名异编号（`5,敏捷`）：名字 `敏捷` 仍指主表编号 2（source 不变），
    //    市场行只贡献编号 5 这个新键
    expect(schema.lookup('ABILITY', '敏捷')).toMatchObject({ resolvedIndex: 2, source: 'primary' });
    expect(schema.lookup('ABILITY', 5)).toMatchObject({ description: '敏捷', resolvedIndex: 5, source: 'append' });

    // 枚举（KC-1 `names`）里市场条目同样标 append
    const byIndex = new Map((schema.names?.('ABILITY') ?? []).map((i) => [i.resolvedIndex, i]));
    expect(byIndex.get(3)).toMatchObject({ name: '幸运', source: 'append' });
    expect(byIndex.get(2)).toMatchObject({ name: '敏捷', source: 'primary' });
  });

  it('市场目录里 `.als` 与 `.csv` 同轮同语义（都按 append 并入）；非名表文件与子目录不进', async () => {
    const tree = baseTree({
      [`${DICT_B}/Trait.csv`]: '1,开朗\n',
      [`${DICT_B}/Mood.als`]: '1,爽朗\n2,内向\n',
      [`${DICT_B}/readme.txt`]: '9,这不是名表\n',
      [`${DICT_B}/sub`]: 'DIR',
      [`${DICT_B}/sub/Hidden.csv`]: '9,隐藏\n',
    });
    const schema = await loadEratwVariableSchema({
      io: treeIo(tree),
      csvDir: CSV_DIR,
      marketAppendDirs: [DICT_B],
      log: silentLog,
    });

    // 两种扩展名都是追加层（`.csv` 在这层也**不**当主表）
    expect(schema.lookup('TRAIT', 1)).toMatchObject({ description: '开朗', resolvedIndex: 1, source: 'append' });
    expect(schema.lookup('MOOD', 1)).toMatchObject({ description: '爽朗', resolvedIndex: 1, source: 'append' });
    expect(schema.lookup('MOOD', 2)).toMatchObject({ description: '内向', resolvedIndex: 2, source: 'append' });
    // 非名表扩展名 / 子目录里的表都不进（与游戏侧"子目录不进入"同一口径）：
    // 查无 = 只回显（不带 description / resolvedIndex）；子目录文件连表都没建
    expect(schema.lookup('TRAIT', '9')).toEqual({ name: 'TRAIT', index: '9' });
    expect(schema.lookup('TRAIT', '隐藏')).toEqual({ name: 'TRAIT', index: '隐藏' });
    expect(schema.lookup('HIDDEN', '9')).toBeUndefined();
  });

  it('同一变量名两种扩展名撞编号：文件按路径序裁决（`.als` 字典序在前 ⇒ 先定义优先），不随枚举顺序漂', async () => {
    const treeA = baseTree({ [`${DICT_B}/Trait.als`]: '1,甲\n', [`${DICT_B}/Trait.csv`]: '1,乙\n' });
    const treeB = baseTree({ [`${DICT_B}/Trait.csv`]: '1,乙\n', [`${DICT_B}/Trait.als`]: '1,甲\n' });
    const load = (t: Tree) =>
      loadEratwVariableSchema({ io: treeIo(t), csvDir: CSV_DIR, marketAppendDirs: [DICT_B], log: silentLog });

    const a = await load(treeA);
    const b = await load(treeB);
    expect(a.lookup('TRAIT', 1)?.description).toBe('甲'); // 路径序：Trait.als < Trait.csv
    expect(b.lookup('TRAIT', 1)?.description).toBe('甲'); // 枚举顺序反过来也同裁决
    expect(a.lookup('TRAIT', 1)?.source).toBe('append');
    expect(a.lookup('TRAIT', '乙')).toMatchObject({ resolvedIndex: 1, source: 'append' }); // 第二定义仍进别名
    expect(b.inputDigest).toBe(a.inputDigest);
  });

  it('确定性：目录顺序与文件枚举顺序都不影响裁决与指纹', async () => {
    const dirs = [DICT_A, DICT_B];
    // 两个目录在同一个编号上各写一个名字：按路径序先定义者胜出，且与入参顺序无关
    const tree = baseTree({
      [`${DICT_A}/ABILITY.csv`]: '2,甲\n',
      [`${DICT_B}/ABILITY.csv`]: '2,乙\n',
    });
    const load = (ordered: readonly string[]) =>
      loadEratwVariableSchema({
        io: treeIo(tree),
        csvDir: CSV_DIR,
        marketAppendDirs: ordered,
        log: silentLog,
      });

    const forward = await load(dirs);
    const reversed = await load([...dirs].reverse());
    // 主表 2 号仍是主表原文；市场两条都进 byName，编号 2 的名称由"路径序先者"贡献不了（主表已占）
    expect(forward.lookup('ABILITY', 2)?.description).toBe('敏捷');
    expect(forward.lookup('ABILITY', '甲')?.source).toBe('append');
    expect(forward.lookup('ABILITY', '乙')?.source).toBe('append');
    expect(forward.inputDigest).toBe(reversed.inputDigest);
  });

  it('市场目录不可读：warn 出声、其余市场目录与游戏主表照常（不整体失败）', async () => {
    const warnings: string[] = [];
    const tree = baseTree({
      [`${DICT_A}/ABILITY.csv`]: MARKET_ABILITY,
      [`${DICT_B}/Trait.csv`]: '1,开朗\n',
    });
    const schema = await loadEratwVariableSchema({
      io: treeIo(tree, { failDirs: [DICT_B] }),
      csvDir: CSV_DIR,
      marketAppendDirs: [DICT_A, DICT_B],
      log: { ...silentLog, warn: (m: string) => warnings.push(m) },
    });

    expect(schema.lookup('ABILITY', 2)?.description).toBe('敏捷'); // 主表没被牵连
    expect(schema.lookup('ABILITY', '幸运')?.source).toBe('append'); // 可读的那个市场目录照常并入
    expect(schema.lookup('TRAIT', 1)).toBeUndefined(); // 不可读目录确实没进来
    expect(warnings.some((w) => w.includes(DICT_B))).toBe(true);
  });

  it('市场缺席（不传 / 传空数组）⇒ 与历史逐字一致，且零新增日志', async () => {
    const io = treeIo(baseTree({}));
    const infosA: string[] = [];
    const infosB: string[] = [];
    const without = await loadEratwVariableSchema({
      io,
      csvDir: CSV_DIR,
      log: { ...silentLog, info: (m: string) => infosA.push(m) },
    });
    const empty = await loadEratwVariableSchema({
      io,
      csvDir: CSV_DIR,
      marketAppendDirs: [],
      log: { ...silentLog, info: (m: string) => infosB.push(m) },
    });

    expect(empty.inputDigest).toBe(without.inputDigest);
    expect(empty.lookup('ABILITY', 2)).toEqual(without.lookup('ABILITY', 2));
    expect(infosA).toEqual(infosB);
    expect(infosB.some((m) => m.includes('市场'))).toBe(false);

    // 有市场目录时那条日志如实出声（单独一行，不混进 `.als` 那条）
    const infosC: string[] = [];
    await loadEratwVariableSchema({
      io: treeIo(baseTree({ [`${DICT_A}/ABILITY.csv`]: MARKET_ABILITY })),
      csvDir: CSV_DIR,
      marketAppendDirs: [DICT_A],
      log: { ...silentLog, info: (m: string) => infosC.push(m) },
    });
    const marketLine = infosC.find((m) => m.includes('市场字典包追加名表'));
    expect(marketLine).toBeTruthy();
    expect(marketLine).toContain('1 个目录 / 1 份');
  });

  it('inputDigest 把市场名表算作字典输入（改一行 / 加目录，派生缓存必须失效）', async () => {
    const load = (market: Tree, dirs: string[]) =>
      loadEratwVariableSchema({
        io: treeIo(baseTree(market)),
        csvDir: CSV_DIR,
        marketAppendDirs: dirs,
        log: silentLog,
      });
    const none = await load({}, []);
    const withA = await load({ [`${DICT_A}/ABILITY.csv`]: MARKET_ABILITY }, [DICT_A]);
    const edited = await load({ [`${DICT_A}/ABILITY.csv`]: MARKET_ABILITY.replace('幸运', '好运') }, [DICT_A]);

    expect(withA.inputDigest).not.toBe(none.inputDigest);
    expect(edited.inputDigest).not.toBe(withA.inputDigest);
  });
});
