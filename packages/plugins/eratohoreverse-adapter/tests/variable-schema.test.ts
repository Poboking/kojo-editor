/**
 * eratohoReverse 变量字典判据：CSV 名称表合并口径 / `.ERH` 声明解析 / 装载器（内存盘）/
 * 真盘读数（守卫：缺盘整体跳过）。
 *
 * 形态照 `eratohok-adapter/tests/variable-schema.test.ts`（同一批断言口径、同一组导出名），
 * 差异全部来自本作真盘事实（见 `src/variable-schema.ts` 头注普查）：
 * - **100% 纯 LF**（eraTW / eratohoK 是 CRLF 主导）⇒ 钉一条纯 LF 用例，并当场证明
 *   「按 CRLF split」在本作会把整本表读成一行；
 * - **`Global.csv` 与 `Globals.csv` 并存**⇒ 表键精确按文件名取，不许前缀吞并；
 * - `.ERH` 声明 **74 个名字 0 个带整数初值**（`#DIM CONST` 只挂字符串清单）⇒ const 层只认名字；
 *   另有 4 条声明压在各文件 **BOM 首行**（`grep '^#DIM'` 口径因此只读出 70 条）；
 * - 指令名表 `Train.csv` 只有 67 行 / 33 条 ⇒ **绝不拿 eraTW 的词表补洞**（钉一条
 *   「eraTW 常见指令名在本作查不到」的用例）；
 * - 标签一律取原文（盘上中日混排是机翻仓库所为）⇒ 用例里的中文串全部抄自真盘。
 *
 * 本包还没有 `tests/harness.ts`（只许新增这两个文件），故内存桩与真盘 IO 就地内联。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DirEntry, FileIO, Logger, WalkOptions } from '@kojo/plugin-api';
import {
  loadEratohoreverseInstructionNames,
  loadEratohoreverseVariableSchema,
  mergeNameTable,
  parseErhDeclarations,
  parseNameTableCsv,
} from '../src/variable-schema';
import { ERATOHOREVERSE } from '../src/constants';

/* ============================ 日志桩 ============================ */

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** 记账日志：验「重号 / 读失败必须告警」这类**可见性**断言（不静默是硬要求） */
function recordingLog(): { log: Logger; warns: string[] } {
  const warns: string[] = [];
  return {
    warns,
    log: {
      debug: () => {},
      info: () => {},
      warn: (message: string) => warns.push(message),
      error: () => {},
    },
  };
}

/* ============================ 内存 FileIO 桩 ============================ */

interface StubOpts {
  /** 这些路径读失败（`readTexts` 对应位为 null，`readText` 抛错） */
  failPaths?: readonly string[];
  /** 这些目录不可读（`listDir` / `walkDir` 抛错） */
  failDirs?: readonly string[];
  /** 目录枚举顺序反转（验「摘要与裁决不随枚举顺序漂」） */
  reverse?: boolean;
}

/**
 * 最小内存 IO（`files` 键 = 绝对路径（正斜杠），值 = 正文）：只实现 loader 真正走到的
 * `listDir` / `readText` / `readTexts` / `walkDir` / `exists` 五条，其余由
 * `as unknown as FileIO` 略过——桩要小，且**签名按 `plugin-api/src/io.ts` 原文**。
 */
function memIo(files: Record<string, string>, opts: StubOpts = {}): FileIO {
  const filePaths = Object.keys(files);
  const dirs = new Set<string>();
  for (const p of filePaths) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const directChildren = (dir: string): DirEntry[] => {
    const prefix = `${dir}/`;
    const seen = new Map<string, boolean>();
    for (const d of dirs) {
      if (d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) {
        seen.set(d.slice(prefix.length), true);
      }
    }
    for (const f of filePaths) {
      if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) {
        seen.set(f.slice(prefix.length), false);
      }
    }
    const list: DirEntry[] = [...seen].map(([name, isDirectory]) => ({
      name,
      path: `${prefix}${name}`,
      isDirectory,
    }));
    return opts.reverse === true ? list.reverse() : list;
  };
  const readOne = (path: string): { path: string; text: string } | null => {
    if (opts.failPaths?.includes(path) === true) return null;
    const text = files[path];
    return text === undefined ? null : { path, text };
  };

  return {
    listDir: async (dir: string) => {
      if (opts.failDirs?.includes(dir) === true) throw new Error(`模拟目录不可读：${dir}`);
      if (!dirs.has(dir)) throw new Error(`没有这个目录：${dir}`);
      return directChildren(dir);
    },
    readText: async (path: string) => {
      const r = readOne(path);
      if (r === null) throw new Error(`没有这个文件：${path}`);
      return { path, text: r.text, encoding: 'utf-8-bom', eol: 'lf', mtimeMs: null };
    },
    readTexts: async (paths: readonly string[]) => paths.map(readOne),
    readBytes: async (path: string) => {
      const r = readOne(path);
      if (r === null) throw new Error(`没有这个文件：${path}`);
      return new TextEncoder().encode(r.text);
    },
    exists: async (path: string) => files[path] !== undefined || dirs.has(path),
    /** 递归遍历：返回 root 子树下全部条目（`filter` 由本层兑现，与内核同口径） */
    walkDir: async (root: string, walkOpts?: WalkOptions) => {
      if (opts.failDirs?.includes(root) === true) throw new Error(`模拟目录不可读：${root}`);
      const prefix = `${root}/`;
      const out: DirEntry[] = [];
      for (const d of dirs) {
        if (d.startsWith(prefix)) {
          out.push({ name: d.slice(d.lastIndexOf('/') + 1), path: d, isDirectory: true });
        }
      }
      for (const f of filePaths) {
        if (f.startsWith(prefix)) {
          out.push({ name: f.slice(f.lastIndexOf('/') + 1), path: f, isDirectory: false });
        }
      }
      const filtered = walkOpts?.filter === undefined ? out : out.filter(walkOpts.filter);
      return opts.reverse === true ? filtered.reverse() : filtered;
    },
  } as unknown as FileIO;
}

const ROOT = 'C:/mem/eratohoReverse';
const CSV = `${ROOT}/CSV`;
const ERB = `${ROOT}/ERB`;

const load = (
  files: Record<string, string>,
  opts: StubOpts & { marketAppendDirs?: string[]; erbDir?: string; log?: Logger } = {},
) =>
  loadEratohoreverseVariableSchema({
    io: memIo(files, opts),
    csvDir: CSV,
    erbDir: opts.erbDir ?? ERB,
    log: opts.log ?? silentLog,
    ...(opts.marketAppendDirs !== undefined ? { marketAppendDirs: opts.marketAppendDirs } : {}),
  });

/* ============================ 名称表解析 ============================ */

describe('parseNameTableCsv —— 本作 100% 纯 LF', () => {
  it('纯 LF 正文正常读：三行收三条（真盘所有 CSV 都是这个形态）', () => {
    const text = '\uFEFF0,保持沉默\n1,弱弱地回应\n2,冷淡地回应\n';
    const { table } = parseNameTableCsv(text);
    expect([...table.byIndex.entries()]).toEqual([
      ['0', '保持沉默'],
      ['1', '弱弱地回应'],
      ['2', '冷淡地回应'],
    ]);
    expect(table.byName.get('冷淡地回应')).toBe('2');
    // 当场证明「按 CRLF split」在本作是错的：整本表会被读成一行 ⇒ 全表凭空变成 0 条
    expect(text.split('\r\n')).toHaveLength(1);
  });

  it('`;` 整行注释 + 空行 + BOM 首行都容（真盘表头就是六行 `;` 注释）', () => {
    const text =
      '\uFEFF;────────────\n;反应(COM)名\n;\n\n0,保持沉默\n1,弱弱地回应\n;注释尾巴\n';
    const { table, skippedEmptyName } = parseNameTableCsv(text);
    expect(table.byIndex.size).toBe(2);
    expect(skippedEmptyName).toBe(0);
  });

  it('行内注释三形态都剥净：`;` 紧跟名称 / 粘在名称后 / 第三字段整段是注释', () => {
    // 真盘三形态：Cflag.csv `0,调教等级,;…`、Strname.csv `1300,好感的反应,    ;【屈服:0】…`、
    // 以及名称段直接带 `;` 的 `3,名前\t;注釈`
    const text = [
      '0,调教等级,;各キャラ用の自由に使えるフラグ',
      '1300,好感的反应,    ;【屈服:0】好感的反应(调教对象但积极的服从系被选择)',
      '3,名前\t;注釈',
    ].join('\n');
    const { table } = parseNameTableCsv(text);
    expect(table.byIndex.get('0')).toBe('调教等级');
    expect(table.byIndex.get('1300')).toBe('好感的反应');
    expect(table.byIndex.get('3')).toBe('名前');
    for (const name of table.byIndex.values()) expect(name.includes(';')).toBe(false);
  });

  it('名称为空跳过并计数（真盘 27 行形态）；键值表（GameBase / VariableSize）天然 0 条', () => {
    const { table, skippedEmptyName } = parseNameTableCsv('5,,;不明\n6,絶頂フラグ,;\n7,,\n');
    expect(table.byIndex.size).toBe(1);
    expect(table.byIndex.get('6')).toBe('絶頂フラグ');
    expect(skippedEmptyName).toBe(2);
    const kv = parseNameTableCsv('コード,9224517\nタイトル,eratohoЯeverse\nCFLAG,3000\n');
    expect(kv.table.byIndex.size).toBe(0);
  });

  it('编号重复后者胜 + 逐条回调：旧名不删（它仍指向同一槽位）', () => {
    const hits: string[] = [];
    const { table, overwritten } = parseNameTableCsv('2,旧名\n2,新名\n', {
      onOverwrite: (e) => hits.push(`${e.index}:${e.previous}->${e.next}`),
    });
    expect(table.byIndex.get('2')).toBe('新名');
    expect(overwritten).toBe(1);
    expect(hits).toEqual(['2:旧名->新名']);
    expect(table.byName.get('旧名')).toBe('2');
    expect(table.byName.get('新名')).toBe('2');
  });

  it('追加层只补不盖（`mergeNameTable` 直接可测）', () => {
    const table = parseNameTableCsv('0,保持沉默').table;
    const stats = mergeNameTable(table, '0,心情\n99,汉化新槽', { source: 'append' });
    expect(stats.overwritten).toBe(0);
    expect(table.byIndex.get('0')).toBe('保持沉默');
    expect(table.indexSource.get('0')).toBe('primary');
    expect(table.byIndex.get('99')).toBe('汉化新槽');
    expect(table.indexSource.get('99')).toBe('append');
  });
});

/* ============================ `.ERH` 声明解析 ============================ */

describe('parseErhDeclarations —— 本作真盘形态', () => {
  it('四类真盘声明都收名字：`#DIMS SAVEDATA` / 修饰词连写 / 数组 / `CONST = 字符串清单`', () => {
    const text = [
      '#DIMS SAVEDATA KEY_UP',
      '#DIMS GLOBAL SAVEDATA C_G_LINM',
      '#DIMS UPC_S, 10',
      '#DIMS CONST C_OPTION  = "行数", "列数", "项目"',
      '#DIMS CONST C_DEFAULT = "20"  , "1"   , "名前"',
    ].join('\n');
    const names = parseErhDeclarations(text);
    expect([...names.keys()].sort()).toEqual([
      'C_DEFAULT',
      'C_G_LINM',
      'C_OPTION',
      'KEY_UP',
      'UPC_S',
    ]);
    // 真盘普查：74 个声明名 **0 个带整数初值** ⇒ 一个编号也不换算
    for (const v of names.values()) expect(v).toBeUndefined();
  });

  it('只有整数初值给编号：十进制 / 十六进制认，字符串清单、表达式、数组尺寸不认', () => {
    const names = parseErhDeclarations(
      [
        '#DIM CONST X = 12',
        '#DIM CONST Y = 0x1F',
        '#DIM CONST Z = "字"',
        '#DIM CONST W = 1 + 2',
        '#DIMS V, 10',
      ].join('\n'),
    );
    expect(names.get('X')).toBe(12);
    expect(names.get('Y')).toBe(31);
    expect(names.get('Z')).toBeUndefined();
    expect(names.get('W')).toBeUndefined();
    expect(names.get('V')).toBeUndefined(); // 数组尺寸不是编号
  });

  it('BOM 压在首行的声明也要收（本作 4 条；`grep ^#DIM` 口径会漏）', () => {
    const names = parseErhDeclarations('\uFEFF#DIMS CONST HTML_SUBSTITUTE = "【HTML】"\n');
    expect(names.has('HTML_SUBSTITUTE')).toBe(true);
    expect(names.get('HTML_SUBSTITUTE')).toBeUndefined();
  });

  it('`;` 注释里的声明不算（POSE.ERH 整份只有 `;#DIMS POSE_L, 100, 5` ⇒ 0 条）', () => {
    expect(parseErhDeclarations(';#DIMS POSE_L, 100, 5').size).toBe(0);
    expect(parseErhDeclarations('#DIMS POSE_L, 100, 5 ;#DIMS 尾巴里的不算').size).toBe(1);
  });

  it('同名首个定义优先；纯 LF 逐行切；`#DEFINE` / `#DIMF` 不误收', () => {
    const names = parseErhDeclarations(
      '#DIM CONST X = 1\r\n#DIM CONST X = 2\n#DEFINE MAX_KOJO 30\n#DIMS 口上种类数\n',
    );
    expect(names.get('X')).toBe(1);
    expect(names.has('MAX_KOJO')).toBe(false);
    expect(names.has('口上种类数')).toBe(true);
    expect(names.size).toBe(2);
  });
});

/* ============================ loader（内存盘） ============================ */

describe('loadEratohoreverseVariableSchema —— 内存盘', () => {
  it('`Global.csv` 与 `Globals.csv` 是**两个独立键**（真盘并存；前缀吞并就是错的）', async () => {
    const schema = await load({
      [`${CSV}/Global.csv`]: '0,动画效果配置\n998,COPY元\n999,COPY先\n',
      [`${CSV}/Globals.csv`]: '10,自动模式登录0\n99,对话窗口用暂时使用\n',
    });
    expect(schema.names!('GLOBAL')).toHaveLength(3);
    expect(schema.names!('GLOBALS')).toHaveLength(2);
    expect(schema.lookup('GLOBAL', 0)?.description).toBe('动画效果配置');
    expect(schema.lookup('GLOBALS', 10)?.description).toBe('自动模式登录0');
    // 跨表不许串味：`GLOBAL` 没有 10 号 ⇒ 只回声，不借 `GLOBALS` 的标签
    expect(schema.lookup('GLOBAL', 10)).toEqual({ name: 'GLOBAL', index: 10 });
    expect(schema.lookup('GLOBALS', '动画效果配置')).toEqual({
      name: 'GLOBALS',
      index: '动画效果配置',
    });
  });

  it('表名归一 =「去扩展名后大写」，匹配一律不敏感（盘上首字母大写形态 + 魔改全大写形态）', async () => {
    const schema = await load({
      [`${CSV}/Cflag.csv`]: '0,调教等级\n',
      [`${CSV}/TFLAG.CSV`]: '10,事件番号\n',
      [`${CSV}/train.Csv`]: '0,保持沉默\n',
    });
    expect(schema.lookup('CFLAG', 0)?.description).toBe('调教等级');
    expect(schema.lookup('cflag', '调教等级')?.resolvedIndex).toBe(0);
    expect(schema.lookup('tflag', 10)?.description).toBe('事件番号');
    expect(schema.names!('Train')).toEqual([
      { name: '保持沉默', index: 0, resolvedIndex: 0, source: 'primary' },
    ]);
  });

  it('键值 / 配置表也建族（族在、索引无）；`.config` 根本不是表', async () => {
    const schema = await load({
      [`${CSV}/GameBase.csv`]: 'コード,9224517\nタイトル,eratohoЯeverse\nバージョン,1214\n',
      [`${CSV}/VariableSize.csv`]: 'CFLAG,3000\n',
      [`${CSV}/_default.config`]: 'ウィンドウ幅:940\n',
    });
    expect(schema.names!('GAMEBASE')).toEqual([]);
    expect(schema.lookup('GAMEBASE', 9224517)?.description).toBeUndefined();
    expect(schema.names!('VARIABLESIZE')).toEqual([]);
    expect(schema.lookup('_DEFAULT.CONFIG')).toBeUndefined();
    expect(schema.lookup('_DEFAULT')).toBeUndefined();
  });

  it('角色表兜底排除：魔改把 `Chara1_霊夢.csv` 挪回根层也不建表（本作真住在 `CSV/CHARA/`）', async () => {
    const schema = await load({
      [`${CSV}/Chara1_霊夢.csv`]: '0,名称\n',
      [`${CSV}/CHARA2_魔理沙.csv`]: '0,名称\n',
      [`${CSV}/Str.csv`]: '0,询问今天的心情\n',
    });
    expect(schema.lookup('CHARA1', 0)).toBeUndefined();
    expect(schema.lookup('CHARA2', 0)).toBeUndefined();
    expect(schema.lookup('STR', 0)?.description).toBe('询问今天的心情');
  });

  it('`.ERH` const 兜底：`CFLAG:{名}` 与 `CFLAG:{号}` 同一槽位，且本作一律不给 resolvedIndex', async () => {
    const schema = await load({
      [`${CSV}/Cflag.csv`]: '0,调教等级\n',
      [`${ERB}/FUNCTION/PANCTION.ERH`]: '\uFEFF#DIMS SAVEDATA KEY_UP\n',
      [`${ERB}/FUNCTION/PROCESS/COMMON_PROCESS_LIST.ERH`]:
        '#DIMS CONST C_OPTION  = "行数", "列数", "项目"\n',
    });
    expect(schema.lookup('CFLAG', 0)?.source).toBe('primary');
    expect(schema.lookup('CFLAG', 'KEY_UP')).toEqual({
      name: 'CFLAG',
      index: 'KEY_UP',
      description: 'KEY_UP',
      source: 'const',
    });
    expect(schema.lookup('CFLAG', 'key_up')?.source).toBe('const'); // 名字也大小写不敏感
    expect(schema.lookup('CFLAG', 'C_OPTION')?.resolvedIndex).toBeUndefined();
    expect(schema.lookup('CFLAG', '查无此名')).toEqual({ name: 'CFLAG', index: '查无此名' });
  });

  it('市场字典包只补不盖：主表 0 号不改写，追加 99 号带 source=append', async () => {
    const files = {
      [`${CSV}/Train.csv`]: '0,保持沉默\n',
      [`${ROOT}/market/zh-pack/Train.csv`]: '0,改写尝试\n99,汉化新槽\n',
    };
    const withPack = await load(files, { marketAppendDirs: [`${ROOT}/market/zh-pack`] });
    expect(withPack.lookup('TRAIN', 0)?.description).toBe('保持沉默');
    expect(withPack.lookup('TRAIN', 99)).toEqual({
      name: 'TRAIN',
      index: 99,
      description: '汉化新槽',
      resolvedIndex: 99,
      source: 'append',
    });
    expect(withPack.names!('TRAIN')).toHaveLength(2);
  });

  it('家族级只回族名、未知族 undefined、未知编号回声（三态分明）', async () => {
    const schema = await load({ [`${CSV}/Cflag.csv`]: '0,调教等级\n' });
    expect(schema.lookup('CFLAG')).toEqual({ name: 'CFLAG' });
    expect(schema.lookup('NOPE', 1)).toBeUndefined();
    expect(schema.lookup('CFLAG', 999)).toEqual({ name: 'CFLAG', index: 999 });
  });

  it('CSV 目录不可读：不抛、字典为空、warn 一次（不静默）、digest 仍是确定值', async () => {
    const rec = recordingLog();
    const schema = await load({}, { failDirs: [CSV], log: rec.log });
    expect(schema.lookup('CFLAG', 0)).toBeUndefined();
    expect(schema.names!('CFLAG')).toEqual([]);
    expect(rec.warns.filter((w) => w.includes('CSV 目录不可读'))).toHaveLength(1);
    expect(schema.inputDigest).toMatch(/^[0-9a-f]{14}$/);
  });

  it('ERB 扫描失败：名称表照常、只 warn 一条（const 层缺席不带走主表）', async () => {
    const rec = recordingLog();
    const schema = await load(
      { [`${CSV}/Cflag.csv`]: '0,调教等级\n', [`${ERB}/X.ERH`]: '#DIM ME_x\n' },
      { failDirs: [ERB], log: rec.log },
    );
    expect(schema.lookup('CFLAG', 0)?.description).toBe('调教等级');
    expect(schema.lookup('CFLAG', 'ME_X')).toEqual({ name: 'CFLAG', index: 'ME_X' });
    expect(rec.warns.filter((w) => w.includes('自定名表扫描失败'))).toHaveLength(1);
  });

  it('单份表读失败：跳过该表并 warn，其余照常（一份坏文件不吃掉整本字典）', async () => {
    const rec = recordingLog();
    const schema = await load(
      { [`${CSV}/Cflag.csv`]: '0,调教等级\n', [`${CSV}/Tflag.csv`]: '10,事件番号\n' },
      { failPaths: [`${CSV}/Tflag.csv`], log: rec.log },
    );
    expect(schema.lookup('CFLAG', 0)?.description).toBe('调教等级');
    expect(schema.lookup('TFLAG', 10)).toBeUndefined();
    expect(rec.warns.some((w) => w.includes('变量表读取失败'))).toBe(true);
  });

  it('重号告警带文件路径与新旧名（「后者胜」必须看得见）', async () => {
    const rec = recordingLog();
    const schema = await load({ [`${CSV}/Cflag.csv`]: '2,旧名\n2,新名\n' }, { log: rec.log });
    expect(schema.lookup('CFLAG', 2)?.description).toBe('新名');
    const warn = rec.warns.find((w) => w.includes('编号重复'));
    expect(warn).toBeDefined();
    expect(warn).toContain(`${CSV}/Cflag.csv`);
    expect(warn).toContain('旧名');
    expect(warn).toContain('新名');
  });

  it('inputDigest：同输入两次相等、改一行即变、与目录枚举顺序无关', async () => {
    const files = {
      [`${CSV}/Cflag.csv`]: '0,调教等级\n',
      [`${CSV}/Globals.csv`]: '10,自动模式登录0\n',
      [`${ERB}/FUNCTION/PANCTION.ERH`]: '#DIMS SAVEDATA KEY_UP\n',
    };
    const a = await load(files);
    const b = await load(files);
    const reordered = await load(files, { reverse: true });
    const changed = await load({ ...files, [`${CSV}/Cflag.csv`]: '0,调教等级（改）\n' });
    expect(typeof a.inputDigest).toBe('string');
    expect(a.inputDigest).toBe(b.inputDigest);
    expect(reordered.inputDigest).toBe(a.inputDigest);
    expect(changed.inputDigest).not.toBe(a.inputDigest);
  });
});

/* ============================ 指令名表（独立 seam） ============================ */

describe('loadEratohoreverseInstructionNames', () => {
  it('`Train.csv` 双向可查 + names 按 CSV 原序', async () => {
    const table = await loadEratohoreverseInstructionNames({
      io: memIo({
        [`${CSV}/Train.csv`]: '0,保持沉默\n1,弱弱地回应\n2,冷淡地回应\n;注释段\n3,友善的回应\n',
      }),
      csvDir: CSV,
      log: silentLog,
    });
    expect(table.hasTable).toBe(true);
    expect(table.lookupByName('保持沉默')).toBe(0);
    expect(table.lookupByNo(3)).toBe('友善的回应');
    expect(table.lookupByNo(999)).toBeUndefined();
    expect(table.names!()).toEqual(['保持沉默', '弱弱地回应', '冷淡地回应', '友善的回应']);
  });

  it('同名多编号取**首条**（降糖期望基础段；本作真盘 0 处重名，裁决照旧保留）', async () => {
    const table = await loadEratohoreverseInstructionNames({
      io: memIo({ [`${CSV}/Train.csv`]: '0,愛撫\n6,胸愛撫\n313,胸愛撫\n' }),
      csvDir: CSV,
      log: silentLog,
    });
    expect(table.lookupByName('胸愛撫')).toBe(6);
    expect(table.lookupByNo(313)).toBe('胸愛撫');
    expect(table.names!()).toEqual(['愛撫', '胸愛撫']);
  });

  it('文件名大小写不敏感（`TRAIN.CSV` 也认；仍精确比对，不认 `Trains.csv`）', async () => {
    const upper = await loadEratohoreverseInstructionNames({
      io: memIo({ [`${CSV}/TRAIN.CSV`]: '0,保持沉默\n' }),
      csvDir: CSV,
      log: silentLog,
    });
    expect(upper.lookupByNo(0)).toBe('保持沉默');
    const near = await loadEratohoreverseInstructionNames({
      io: memIo({ [`${CSV}/Trains.csv`]: '0,保持沉默\n' }),
      csvDir: CSV,
      log: silentLog,
    });
    expect(near.hasTable).toBe(false);
  });

  it('缺表 / 空表 / 目录不可读 ⇒ hasTable=false 且 warn（消费方 fail-closed），**绝不拿 eraTW 词表补洞**', async () => {
    const rec = recordingLog();
    const missing = await loadEratohoreverseInstructionNames({
      io: memIo({ [`${CSV}/Cflag.csv`]: '0,调教等级\n' }),
      csvDir: CSV,
      log: rec.log,
    });
    const empty = await loadEratohoreverseInstructionNames({
      io: memIo({ [`${CSV}/Train.csv`]: ';全是注释\n' }),
      csvDir: CSV,
      log: rec.log,
    });
    const unreadable = await loadEratohoreverseInstructionNames({
      io: memIo({}, { failDirs: [CSV] }),
      csvDir: CSV,
      log: rec.log,
    });
    expect(missing.hasTable).toBe(false);
    expect(empty.hasTable).toBe(false);
    expect(unreadable.hasTable).toBe(false);
    expect(missing.names!()).toEqual([]);
    // eraTW 常见的指令中文名在本作查不到——覆盖率低是事实，不编造
    expect(missing.lookupByName('胸愛撫')).toBeUndefined();
    expect(rec.warns.filter((w) => w.includes('指令名表缺失'))).toHaveLength(1);
    expect(rec.warns.filter((w) => w.includes('指令名表为空'))).toHaveLength(1);
    expect(rec.warns.filter((w) => w.includes('CSV 目录不可读'))).toHaveLength(1);
  });
});

/* ============================ 真实语料（守卫：缺盘整体跳过） ============================ */

/**
 * 真盘根：约定 `C:/game/eratohoReverse`（constants.ts 同一条盘）；换机时以
 * `KOJO_ERATOHOREVERSE_ROOT` 覆写。缺盘 ⇒ 下面整体 skip（跨主机 skipped 数会变，是设计不是红）。
 */
const GAME_ROOT =
  [process.env['KOJO_ERATOHOREVERSE_ROOT'], 'C:/game/eratohoReverse'].find(
    (p): p is string => typeof p === 'string' && p.length > 0 && existsSync(p),
  ) ?? 'C:/game/eratohoReverse';
const REAL_CSV = join(GAME_ROOT, 'CSV');
const REAL_ERB = join(GAME_ROOT, 'ERB');

const relOf = (p: string): string => relative(GAME_ROOT, p).split(sep).join('/');

/** node:fs 支撑的只读真 FileIO（listDir / readText / readTexts / walkDir 四条路径全覆盖） */
function realIo(): FileIO {
  const entriesOf = (dir: string): DirEntry[] =>
    readdirSync(dir, { withFileTypes: true }).map((d) => ({
      name: d.name,
      path: join(dir, d.name),
      isDirectory: d.isDirectory(),
    }));
  const walkAll = (dir: string): DirEntry[] => {
    const out: DirEntry[] = [];
    for (const e of entriesOf(dir)) {
      out.push(e);
      if (e.isDirectory) out.push(...walkAll(e.path));
    }
    return out;
  };
  const readOne = (path: string) => {
    const raw = readFileSync(path, 'utf-8');
    const hadBom = raw.charCodeAt(0) === 0xfeff;
    const text = hadBom ? raw.slice(1) : raw;
    return { path, text, encoding: hadBom ? ('utf-8-bom' as const) : ('utf-8' as const), eol: 'lf' as const, mtimeMs: null };
  };
  return {
    listDir: async (dir: string) => entriesOf(dir),
    readText: async (path: string) => readOne(path),
    readTexts: async (paths: readonly string[]) =>
      paths.map((p) => {
        try {
          return readOne(p);
        } catch {
          return null;
        }
      }),
    walkDir: async (root: string, opts?: WalkOptions) => {
      const all = walkAll(root);
      return opts?.filter === undefined ? all : all.filter(opts.filter);
    },
  } as unknown as FileIO;
}

const REAL_TABLES: ReadonlyArray<readonly [string, number]> = [
  ['ABL', 26],
  ['BASE', 9],
  ['CFLAG', 77],
  ['CSTR', 33],
  ['EQUIP', 40],
  ['EX', 8],
  ['EXP', 35],
  ['FLAG', 68],
  ['GAMEBASE', 0],
  ['GLOBAL', 3],
  ['GLOBALS', 6],
  ['ITEM', 23],
  ['MARK', 5],
  ['PALAM', 14],
  ['SAVESTR', 2],
  ['SOURCE', 19],
  ['STAIN', 7],
  ['STR', 198],
  ['STRNAME', 79],
  ['TALENT', 111],
  ['TCVAR', 65],
  ['TEQUIP', 55],
  ['TFLAG', 117],
  ['TIME', 2],
  ['TRAIN', 33],
  ['TSTR', 3],
  ['VARIABLESIZE', 0],
  ['_REPLACE', 0],
];

describe.skipIf(!existsSync(REAL_CSV))(
  `真实语料读数（${GAME_ROOT}，2026-10-26 实测）`,
  () => {
    it('CSV 根层 28 张表逐表读数相等；普查合计 28 张 / 1038 条标签 / 空名 27 行', async () => {
      const schema = await loadEratohoreverseVariableSchema({
        io: realIo(),
        csvDir: REAL_CSV,
        erbDir: REAL_ERB,
        log: silentLog,
      });
      expect(REAL_TABLES).toHaveLength(28);
      let entries = 0;
      for (const [family, count] of REAL_TABLES) {
        const got = schema.names?.(family)?.length ?? 0;
        expect(got, family).toBe(count);
        entries += got;
      }
      expect(entries).toBe(1038);
      // 清洗计数也钉住：真盘跳过空名称 27 行、层内重号 0 处（「后者胜」在真盘是死分支）
      let emptyName = 0;
      let overwritten = 0;
      for (const name of readdirSync(REAL_CSV)) {
        if (!/\.csv$/i.test(name)) continue;
        const raw = readFileSync(join(REAL_CSV, name), 'utf-8');
        const stats = parseNameTableCsv(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
        emptyName += stats.skippedEmptyName;
        overwritten += stats.overwritten;
      }
      expect(emptyName).toBe(27);
      expect(overwritten).toBe(0);
      // 真盘标签原文（抄盘，不编造）
      expect(schema.lookup('CFLAG', 0)?.description).toBe('调教等级');
      expect(schema.lookup('TFLAG', 10)?.description).toBe('事件番号');
      expect(schema.lookup('TALENT', 0)?.description).toBe('处女');
      expect(schema.lookup('STR', 0)?.description).toBe('询问今天的心情');
      expect(schema.lookup('TRAIN', 0)?.description).toBe('保持沉默');
    }, 120000);

    it('`Global.csv`(15 行/3 条) 与 `Globals.csv`(17 行/6 条) 各是一张独立表：编号段互不相交', async () => {
      const schema = await loadEratohoreverseVariableSchema({
        io: realIo(),
        csvDir: REAL_CSV,
        erbDir: REAL_ERB,
        log: silentLog,
      });
      expect(schema.lookup('GLOBAL', 0)?.description).toBe('动画效果配置');
      expect(schema.lookup('GLOBAL', 999)?.description).toBe('COPY先');
      expect(schema.lookup('GLOBALS', 10)?.description).toBe('自动模式登录0');
      expect(schema.lookup('GLOBALS', 99)?.description).toBe('对话窗口用暂时使用');
      // 前缀吞并（把两张表并一张）会让下面两条同时成立 ⇒ 这条断言就是那张闸
      expect(schema.lookup('GLOBAL', 10)).toEqual({ name: 'GLOBAL', index: 10 });
      expect(schema.lookup('GLOBALS', 0)).toEqual({ name: 'GLOBALS', index: 0 });
    }, 120000);

    it('`.ERH` 普查：17 份全在 ERB/ 下、16 份含声明、74 个唯一声明名、0 个带整数初值', async () => {
      const erh: string[] = [];
      const walk = (dir: string): void => {
        for (const d of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, d.name);
          if (d.isDirectory()) walk(p);
          else if (/\.erh$/i.test(d.name)) erh.push(p);
        }
      };
      walk(GAME_ROOT);
      expect(erh.filter((p) => relOf(p).startsWith('ERB/')).length).toBe(erh.length); // 全在受管 ERB/ 下
      expect(erh.length).toBe(17);
      const union = new Map<string, number | undefined>();
      let withDecl = 0;
      let lines = 0;
      for (const p of erh) {
        const raw = readFileSync(p, 'utf-8');
        const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
        const found = parseErhDeclarations(text);
        lines += found.size;
        if (found.size > 0) withDecl++;
        for (const [k, v] of found) if (!union.has(k)) union.set(k, v);
      }
      expect(withDecl).toBe(16); // `POSE.ERH` 那条声明整行被 `;` 注释 ⇒ 0 条
      expect(union.size).toBe(74);
      expect([...union.values()].filter((v) => v !== undefined)).toHaveLength(0);

      const schema = await loadEratohoreverseVariableSchema({
        io: realIo(),
        csvDir: REAL_CSV,
        erbDir: REAL_ERB,
        log: silentLog,
      });
      // const 层只认名字（真盘没有任何整数初值 ⇒ 一律不换算编号）
      expect(schema.lookup('CFLAG', 'KEY_UP')?.source).toBe('const');
      expect(schema.lookup('CFLAG', 'KEY_UP')?.resolvedIndex).toBeUndefined();
      expect(schema.lookup('CFLAG', 'C_G_LINM')?.source).toBe('const');
      expect(schema.lookup('CFLAG', 'HTML_SUBSTITUTE')?.source).toBe('const'); // BOM 首行那 4 条之一
      // `POSE.ERH` 那条声明整行被 `;` 注释 ⇒ 不在 const 层（查无 ⇒ 只回声，不宣称来源）
      expect(schema.lookup('CFLAG', 'POSE_L')).toEqual({ name: 'CFLAG', index: 'POSE_L' });
      expect(lines).toBe(74);
    }, 120000);

    it('真盘指令名表：Train.csv 67 行 / 33 条编号 / 33 个唯一名（覆盖率天然低，不补洞）', async () => {
      const table = await loadEratohoreverseInstructionNames({
        io: realIo(),
        csvDir: REAL_CSV,
        log: silentLog,
      });
      expect(table.hasTable).toBe(true);
      expect(table.names!()).toHaveLength(33);
      expect(table.lookupByName('保持沉默')).toBe(0);
      expect(table.lookupByNo(0)).toBe('保持沉默');
      expect(ERATOHOREVERSE.instructionCsv).toBe('Train.csv');
      // eraTW 的指令名不在本作表里 ⇒ 查不到（不许拿别的游戏的表补洞）
      expect(table.lookupByName('胸愛撫')).toBeUndefined();
    }, 120000);

    it('编码普查：真盘数据文件 100% 纯 LF（含 CR 的 0 份）⇒ 任何按 CRLF split 的写法都是错的', () => {
      const files: string[] = [];
      const walk = (dir: string): void => {
        for (const d of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, d.name);
          if (d.isDirectory()) walk(p);
          else if (/\.(erb|erh|csv|config)$/i.test(d.name)) files.push(p);
        }
      };
      walk(GAME_ROOT);
      // 逐份普查（非抽样）：全树 `.ERB` 929 + `.ERH` 17 + `.csv` 137 + `.config` 2 = 1085 份
      expect(files.length).toBe(1085);
      let crlf = 0;
      let bom = 0;
      for (const p of files) {
        const raw = readFileSync(p, 'utf-8');
        if (raw.charCodeAt(0) === 0xfeff) bom++;
        if (raw.includes('\r\n')) crlf++;
      }
      expect(crlf).toBe(0);
      expect(bom).toBe(files.length);
    }, 120000);

    it('角色表 108 份全在 `CSV/CHARA/`：根层扫描天然不含它们', async () => {
      const charaFiles = readdirSync(join(REAL_CSV, 'CHARA'));
      expect(charaFiles.length).toBe(108);
      expect(charaFiles.filter((n) => /^chara\d+_.+\.csv$/i.test(n)).length).toBe(108);
      expect(readdirSync(REAL_CSV).filter((n) => ERATOHOREVERSE.charaCsvPattern.test(n))).toEqual(
        [],
      );
      const schema = await loadEratohoreverseVariableSchema({
        io: realIo(),
        csvDir: REAL_CSV,
        erbDir: REAL_ERB,
        log: silentLog,
      });
      expect(schema.lookup('CHARA0', 0)).toBeUndefined();
      expect(schema.lookup('CHARA100', 0)).toBeUndefined();
    }, 120000);

    it('`inputDigest` 同盘两次相等（派生缓存判据稳定）', async () => {
      const once = () =>
        loadEratohoreverseVariableSchema({
          io: realIo(),
          csvDir: REAL_CSV,
          erbDir: REAL_ERB,
          log: silentLog,
        });
      const a = await once();
      const b = await once();
      expect(typeof a.inputDigest).toBe('string');
      expect(a.inputDigest).toBe(b.inputDigest);
    }, 120000);
  },
);
