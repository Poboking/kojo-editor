/**
 * eraFL 变量字典单测。
 *
 * 形态照 `eraakumamaid-adapter/tests/variable-schema.test.ts`（同一套内存 FileIO 桩、
 * 同一批断言口径），差异只在 eraFL 的实测行形态与两条本包独有的裁决：
 * - 名称表：**行内注释三种前缀**（裸 `;` / tab / 空格）、**编号重复后者胜 + 告警**、
 *   空名称跳过计数；
 * - `.ERH`：`#DIM` / `#DIMS` / `#DIM CONST` **三种形态的名字都收**，只有整数初值才给编号；
 * - 追加层（市场字典包）**只补不盖**（跨层不吃"后者胜"）。
 *
 * 真盘用例以 `D:/Game/erafl/CSV` 是否存在为守卫（缺位整体跳过），断言的是本机实测读数。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DirEntry, FileIO, Logger, WalkOptions } from '@kojo/plugin-api';
import {
  loadEraflInstructionNames,
  loadEraflVariableSchema,
  mergeNameTable,
  parseErhDeclarations,
  parseNameTableCsv,
} from '../src/variable-schema';

/** 静默日志（loader 的 info 只是进度播报，不该进测试输出） */
const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** 记账日志：验"重号必须告警"这类**可见性**断言（不静默是硬要求） */
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
  /** 这些目录不可读（`listDir` 抛错） */
  failDirs?: readonly string[];
  /** 目录枚举顺序反转（验"摘要与裁决不随枚举顺序漂"） */
  reverse?: boolean;
}

/**
 * 最小内存 IO：`files` 键 = 绝对路径（正斜杠），值 = 文件正文。
 *
 * 只实现 loader 真正走到的 6 条路径（`listDir` / `readText` / `readTexts` / `walkDir` /
 * `exists` / `readBytes`），其余方法由 `as unknown as FileIO` 略过——桩要小，且**签名
 * 按 `plugin-api/src/io.ts` 原文**（不猜形状）。
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
      return { path, text: r.text, encoding: 'utf-8', eol: 'lf', mtimeMs: null };
    },
    readTexts: async (paths: readonly string[]) => paths.map(readOne),
    readBytes: async (path: string) => {
      const r = readOne(path);
      if (r === null) throw new Error(`没有这个文件：${path}`);
      return new TextEncoder().encode(r.text);
    },
    exists: async (path: string) => files[path] !== undefined || dirs.has(path),
    /** 递归遍历：返回 root 子树下全部文件与目录条目（`filter` 由本层兑现，与内核同口径） */
    walkDir: async (root: string, walkOpts?: WalkOptions) => {
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

const load = (
  files: Record<string, string>,
  opts: StubOpts & { marketAppendDirs?: string[]; erbDir?: string; log?: Logger } = {},
) =>
  loadEraflVariableSchema({
    io: memIo(files, opts),
    csvDir: '/game/CSV',
    erbDir: opts.erbDir ?? '/game/ERB',
    log: opts.log ?? silentLog,
    ...(opts.marketAppendDirs !== undefined ? { marketAppendDirs: opts.marketAppendDirs } : {}),
  });

/* ============================ 名称表解析 ============================ */

describe('parseNameTableCsv', () => {
  it('基础形态 `编号,名称`：正查 2 条、反查 2 条，双向都能落到对方', () => {
    const { table } = parseNameTableCsv('2,好感度\n3,依存度\n');
    expect(table.byIndex.size).toBe(2);
    expect(table.byName.size).toBe(2);
    expect(table.byIndex.get('2')).toBe('好感度');
    expect(table.byName.get('好感度')).toBe('2');
  });

  it('BOM + CRLF + 空行 + `;` 整行注释都容：4 行有效内容只收 2 条', () => {
    const text = '\uFEFF;标题注释\r\n\r\n1,所属\r\n  ;缩进注释\r\n2,好感度\r\n';
    const { table, skippedEmptyName } = parseNameTableCsv(text);
    expect(table.byIndex.size).toBe(2);
    expect(table.byIndex.get('1')).toBe('所属');
    expect(table.byIndex.get('2')).toBe('好感度');
    expect(skippedEmptyName).toBe(0);
  });

  it('行内注释三种前缀（裸 `;` / 制表符 / 空格）全部剥净：名称里 0 个 `;`', () => {
    // 三种都是 eraFL 实测形态：Cstr.csv:3 `3,NAMEカナ,;`、CFLAG.CSV `0,キャラ用,\t\t;…`、Tstr.csv `0,COM_SITUATION, ;…`
    const text = ['0,キャラ用,\t\t;各キャラ用の自由に使えるフラグ', '1,あ, ;空格注释', '2,字,;実質未使用'].join(
      '\n',
    );
    const { table } = parseNameTableCsv(text);
    expect(table.byIndex.size).toBe(3);
    expect(table.byIndex.get('0')).toBe('キャラ用');
    expect(table.byIndex.get('1')).toBe('あ');
    expect(table.byIndex.get('2')).toBe('字');
    for (const name of table.byIndex.values()) expect(name.includes(';')).toBe(false);
  });

  it('注释直接粘在名称后（无第三字段）：`3,名前\\t;注` 名称仍是 2 个字', () => {
    const { table } = parseNameTableCsv('3,名前\t;注釈');
    expect(table.byIndex.get('3')).toBe('名前');
  });

  it('名称为空跳过并计数：`5,,;不明` 不入表，2 条空名只收 1 条', () => {
    const text = ['5,,;不明', '6,絶頂フラグ,;', '7,,;'].join('\n');
    const { table, skippedEmptyName } = parseNameTableCsv(text);
    expect(table.byIndex.size).toBe(1);
    expect(table.byIndex.has('5')).toBe(false);
    expect(table.byIndex.get('6')).toBe('絶頂フラグ');
    expect(skippedEmptyName).toBe(2);
  });

  it('编号重复后者胜 + 逐条回调：1 条编号、1 次告警，旧名仍可反查', () => {
    const hits: string[] = [];
    const { table, overwritten } = parseNameTableCsv('2,旧名\n2,新名\n', {
      onOverwrite: (e) => hits.push(`${e.index}:${e.previous}->${e.next}`),
    });
    expect(table.byIndex.size).toBe(1);
    expect(table.byIndex.get('2')).toBe('新名');
    expect(overwritten).toBe(1);
    expect(hits).toEqual(['2:旧名->新名']);
    // 旧名不删：它仍指向同一槽位（删掉只会让旧口上突然查不到）
    expect(table.byName.get('旧名')).toBe('2');
    expect(table.byName.get('新名')).toBe('2');
  });

  it('行首非数字 / 空编号不收：键值表与配置表天然 0 条', () => {
    const text = ['コード,9224518', 'SAVE_DTS, WEAPON_STOCK', ',无名', ';注释', '1,所属'].join('\n');
    const { table } = parseNameTableCsv(text);
    expect(table.byIndex.size).toBe(1);
    expect(table.byIndex.get('1')).toBe('所属');
  });

  it('四列道具表只取名称：`100,梳子,1000,` → 名称 2 字、不吞价格', () => {
    const { table } = parseNameTableCsv('100,梳子,1000,\n110,鞭,2000,');
    expect(table.byIndex.size).toBe(2);
    expect(table.byIndex.get('100')).toBe('梳子');
    expect(table.byIndex.get('110')).toBe('鞭');
  });

  it('同名跨编号时反查指向最后一条（与"编号后者胜"同向，两表不打架）', () => {
    const { table } = parseNameTableCsv('100,ダミー\n101,ダミー');
    expect(table.byIndex.size).toBe(2);
    expect(table.byIndex.get('100')).toBe('ダミー');
    expect(table.byName.get('ダミー')).toBe('101');
  });

  it('追加层只补不盖：主表 2 号与「好感度」都不被改写，只多出 99 号', () => {
    const table = parseNameTableCsv('2,好感度').table;
    const stats = mergeNameTable(table, '2,心情\n99,追加名', { source: 'append' });
    expect(stats.overwritten).toBe(0);
    expect(table.byIndex.size).toBe(2);
    expect(table.byIndex.get('2')).toBe('好感度');
    expect(table.byIndex.get('99')).toBe('追加名');
    expect(table.indexSource.get('99')).toBe('append');
    expect(table.indexSource.get('2')).toBe('primary');
    expect(table.nameSource.get('好感度')).toBe('primary');
  });
});

/* ============================ `.ERH` 声明解析 ============================ */

describe('parseErhDeclarations', () => {
  it('三种声明形态的名字都收：`#DIM` / `#DIMS` / `#DIM CONST` → 4 个名字', () => {
    const text = [
      '#DIM CONST 衣装部位_頭 = 0',
      '#DIM ME_selectedNode',
      '#DIMS SAVEDATA CHARADATA CLOTH, CLOTH_PART_NUM',
      '#DIMS CONST 衣装状態描写 = "","(半脱)"',
    ].join('\n');
    const names = parseErhDeclarations(text);
    expect(names.size).toBe(4);
    expect([...names.keys()].sort()).toEqual([
      'CLOTH',
      'ME_SELECTEDNODE',
      '衣装状態描写',
      '衣装部位_頭',
    ]);
  });

  it('只有整数初值给编号：十进制 12 / 十六进制 0x1F=31，字符串与表达式 → undefined', () => {
    const text = [
      '#DIM CONST A = 12',
      '#DIM CONST B = 0x1F',
      '#DIM CONST C = "字"',
      '#DIM CONST D = 0x44 + 1',
      '#DIM E, 10',
    ].join('\n');
    const names = parseErhDeclarations(text);
    expect(names.get('A')).toBe(12);
    expect(names.get('B')).toBe(31);
    expect(names.get('C')).toBeUndefined();
    expect(names.get('D')).toBeUndefined();
    expect(names.get('E')).toBeUndefined(); // 数组尺寸不是编号
    expect(names.size).toBe(5);
  });

  it('BOM、`=` 两侧无空格、行尾 `;` 注释、前置修饰词都容', () => {
    const text = ['\uFEFF#DIM CONST 衣装部位_装飾=12 ;注释', '#DIM SAVEDATA CHARADATA CLOTH, 14'].join(
      '\r\n',
    );
    const names = parseErhDeclarations(text);
    expect(names.size).toBe(2);
    expect(names.get('衣装部位_装飾')).toBe(12);
    expect(names.get('CLOTH')).toBeUndefined();
  });

  it('同名首个定义优先：后一条同值不覆盖、只留 1 个名字', () => {
    const names = parseErhDeclarations('#DIM CONST X = 1\n#DIM CONST X = 2');
    expect(names.size).toBe(1);
    expect(names.get('X')).toBe(1);
  });
});

/* ============================ loader（内存桩） ============================ */

describe('loadEraflVariableSchema', () => {
  /** 17 张有编号行的表：表名 → 合成行数（1..17 各不相同，便于逐表核对读数） */
  const SEVENTEEN: ReadonlyArray<readonly [string, number]> = [
    ['CFLAG', 1],
    ['TALENT', 2],
    ['PALAM', 3],
    ['ABL', 4],
    ['EX', 5],
    ['STAIN', 6],
    ['MARK', 7],
    ['SOURCE', 8],
    ['CSTR', 9],
    ['TSTR', 10],
    ['TFLAG', 11],
    ['TCVAR', 12],
    ['TRAIN', 13],
    ['ITEM', 14],
    ['FLCONFIG', 15],
    ['KOJOEVENT', 16],
    ['FLTUTOR', 17],
  ];

  it('17 张表按文件名大写建表：逐表条目数与合成行数一一相等', async () => {
    const files: Record<string, string> = {};
    for (const [name, rows] of SEVENTEEN) {
      const body = Array.from({ length: rows }, (_, i) => `${i},${name}名${i}`).join('\r\n');
      files[`/game/CSV/${name}.csv`] = body;
    }
    const schema = await load(files);
    for (const [name, rows] of SEVENTEEN) {
      expect(schema.names?.(name)?.length, name).toBe(rows);
    }
    expect(schema.names?.('CFLAG')?.length).toBe(1);
    expect(schema.names?.('FLTUTOR')?.length).toBe(17);
  });

  it('文件名大小写混用归一：`CFLAG.CSV` 与 `Talent.csv` 都按大写族名可查', async () => {
    const schema = await load({
      '/game/CSV/CFLAG.CSV': '2,好感度',
      '/game/CSV/Talent.csv': '3,恋慕',
    });
    expect(schema.lookup('CFLAG', 2)?.description).toBe('好感度');
    expect(schema.lookup('talent', 3)?.description).toBe('恋慕');
    expect(schema.lookup('TALENT', '恋慕')).toEqual({
      name: 'TALENT',
      index: '恋慕',
      description: '恋慕',
      resolvedIndex: 3,
      source: 'primary',
    });
  });

  it('家族级只回族名、未知族 undefined、未知编号回声（三态分明）', async () => {
    const schema = await load({ '/game/CSV/CFLAG.CSV': '2,好感度' });
    expect(schema.lookup('CFLAG')).toEqual({ name: 'CFLAG' });
    expect(schema.lookup('NOPE', 1)).toBeUndefined();
    expect(schema.lookup('CFLAG', 999)).toEqual({ name: 'CFLAG', index: 999 });
  });

  it('空表也建族（`GameBase.csv` 是键值表）：族在、索引无', async () => {
    const schema = await load({ '/game/CSV/GameBase.csv': 'コード,9224518\nタイトル,eraFL' });
    expect(schema.names?.('GAMEBASE')).toEqual([]);
    expect(schema.lookup('GAMEBASE', 1)).toEqual({ name: 'GAMEBASE', index: 1 });
  });

  it('names 枚举：条目名 = 索引名、resolvedIndex = 编号、source = primary', async () => {
    const schema = await load({ '/game/CSV/Train.csv': '0,愛撫\n1,胸愛撫' });
    expect(schema.names?.('TRAIN')).toEqual([
      { name: '愛撫', index: 0, resolvedIndex: 0, source: 'primary' },
      { name: '胸愛撫', index: 1, resolvedIndex: 1, source: 'primary' },
    ]);
  });

  it('`.ERH` 名表兜底：`CFLAG:衣装部位_頭` → 编号 0、source=const', async () => {
    const withErh = await load({
      '/game/CSV/CFLAG.CSV': '2,好感度',
      '/game/ERB/VARIABLE.ERH': '\uFEFF#DIM CONST 衣装部位_頭 = 0\r\n#DIM CONST 衣装部位_首 = 1',
    });
    // 名称表在前、常量表在后：2 号仍是主表源（const 层不抢主表的条目）
    expect(withErh.lookup('CFLAG', 2)?.source).toBe('primary');
    expect(withErh.lookup('CFLAG', '衣装部位_頭')).toEqual({
      name: 'CFLAG',
      index: '衣装部位_頭',
      description: '衣装部位_頭',
      resolvedIndex: 0,
      source: 'const',
    });
  });

  it('无整数初值的 `#DIM NAME` 收录但无 resolvedIndex（名字在、编号运行期才知道）', async () => {
    const schema = await load({
      '/game/CSV/CFLAG.CSV': '2,好感度',
      '/game/ERB/sub/GUI.ERH': '#DIM ME_selectedNode',
    });
    expect(schema.lookup('CFLAG', 'ME_selectedNode')).toEqual({
      name: 'CFLAG',
      index: 'ME_selectedNode',
      description: 'ME_selectedNode',
      source: 'const',
    });
    expect(schema.lookup('CFLAG', 'ME_selectedNode')?.resolvedIndex).toBeUndefined();
  });

  it('市场字典包只补不盖：主表 2 号不改写，追加 99 号带 source=append', async () => {
    const files = {
      '/game/CSV/CFLAG.CSV': '2,好感度',
      '/market/zh-pack/CFLAG.csv': '2,心情\n99,汉化新槽',
    };
    const noPack = await load({ '/game/CSV/CFLAG.CSV': '2,好感度' });
    const withPack = await load(files, { marketAppendDirs: ['/market/zh-pack'] });
    expect(noPack.names?.('CFLAG')?.length).toBe(1);
    expect(withPack.names?.('CFLAG')?.length).toBe(2);
    expect(withPack.lookup('CFLAG', 2)?.description).toBe('好感度');
    expect(withPack.lookup('CFLAG', 99)).toEqual({
      name: 'CFLAG',
      index: 99,
      description: '汉化新槽',
      resolvedIndex: 99,
      source: 'append',
    });
  });

  it('inputDigest：同输入两次相等、改一行即变、与目录枚举顺序无关', async () => {
    const files = {
      '/game/CSV/CFLAG.CSV': '2,好感度',
      '/game/CSV/Talent.csv': '3,恋慕',
      '/game/ERB/VARIABLE.ERH': '#DIM CONST X = 1',
    };
    const a = await load(files);
    const b = await load(files);
    const reordered = await load(files, { reverse: true });
    const changed = await load({ ...files, '/game/CSV/CFLAG.CSV': '2,好感度（改）' });
    expect(typeof a.inputDigest).toBe('string');
    expect(a.inputDigest).toBe(b.inputDigest);
    expect(reordered.inputDigest).toBe(a.inputDigest);
    expect(changed.inputDigest).not.toBe(a.inputDigest);
  });

  it('CSV 目录不可读：不抛、字典为空、warn 一次（不静默）', async () => {
    const rec = recordingLog();
    const schema = await load({}, { failDirs: ['/game/CSV'], log: rec.log });
    expect(schema.lookup('CFLAG', 2)).toBeUndefined();
    expect(schema.names?.('CFLAG')).toEqual([]);
    expect(rec.warns.length).toBe(1);
    expect(rec.warns[0]).toContain('CSV 目录不可读');
  });

  it('单份表读失败：跳过该表并 warn，其余表照常（一份坏文件不吃掉整本字典）', async () => {
    const rec = recordingLog();
    const schema = await load(
      { '/game/CSV/CFLAG.CSV': '2,好感度', '/game/CSV/Talent.csv': '3,恋慕' },
      { failPaths: ['/game/CSV/Talent.csv'], log: rec.log },
    );
    expect(schema.names?.('CFLAG')?.length).toBe(1);
    expect(schema.lookup('TALENT', 3)).toBeUndefined();
    expect(rec.warns.some((w) => w.includes('变量表读取失败'))).toBe(true);
  });

  it('重号告警带文件路径与新旧名（"后者胜"必须看得见）', async () => {
    const rec = recordingLog();
    const schema = await load(
      { '/game/CSV/CFLAG.CSV': '2,旧名\n2,新名' },
      { log: rec.log },
    );
    expect(schema.lookup('CFLAG', 2)?.description).toBe('新名');
    const warn = rec.warns.find((w) => w.includes('编号重复'));
    expect(warn).toBeDefined();
    expect(warn).toContain('/game/CSV/CFLAG.CSV');
    expect(warn).toContain('旧名');
    expect(warn).toContain('新名');
  });
});

/* ============================ 指令名表（独立导出） ============================ */

describe('loadEraflInstructionNames', () => {
  it('`Train.csv` 双向可查：名 → 编号 310、编号 → 名，names 去重', async () => {
    const table = await loadEraflInstructionNames({
      io: memIo({ '/game/CSV/Train.csv': '0,愛撫\n310,摸屁股\n311,摸屁股' }),
      csvDir: '/game/CSV',
      log: silentLog,
    });
    expect(table.hasTable).toBe(true);
    expect(table.lookupByName('摸屁股')).toBe(311); // 同名跨编号按后者（与字典同一条裁决）
    expect(table.lookupByNo(0)).toBe('愛撫');
    expect(table.lookupByNo(999)).toBeUndefined();
    expect(table.lookupByName('不存在')).toBeUndefined();
    expect(table.names?.()).toEqual(['愛撫', '摸屁股']);
  });

  it('文件名大小写不敏感（`TRAIN.CSV` 也认）', async () => {
    const table = await loadEraflInstructionNames({
      io: memIo({ '/game/CSV/TRAIN.CSV': '0,愛撫' }),
      csvDir: '/game/CSV',
      log: silentLog,
    });
    expect(table.hasTable).toBe(true);
    expect(table.lookupByNo(0)).toBe('愛撫');
  });

  it('缺表 / 空表 → hasTable=false 且 warn（消费方据此 fail-closed）', async () => {
    const rec = recordingLog();
    const missing = await loadEraflInstructionNames({
      io: memIo({ '/game/CSV/CFLAG.CSV': '2,好感度' }),
      csvDir: '/game/CSV',
      log: rec.log,
    });
    const empty = await loadEraflInstructionNames({
      io: memIo({ '/game/CSV/Train.csv': ';全是注释' }),
      csvDir: '/game/CSV',
      log: rec.log,
    });
    expect(missing.hasTable).toBe(false);
    expect(empty.hasTable).toBe(false);
    expect(missing.names?.()).toEqual([]);
    expect(rec.warns.some((w) => w.includes('指令名表缺失'))).toBe(true);
    expect(rec.warns.some((w) => w.includes('指令名表为空'))).toBe(true);
  });
});

/* ============================ 真实语料（守卫：缺盘整体跳过） ============================ */

const GAME_ROOT = 'D:/Game/erafl';

/** node:fs 支撑的真 FileIO（listDir / readText / readTexts / walkDir 四条路径全覆盖） */
function realIo(): FileIO {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const p = join(dir, e);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  return {
    listDir: async (dir: string) =>
      readdirSync(dir).map((name) => {
        const p = join(dir, name);
        return { name, path: p, isDirectory: statSync(p).isDirectory() };
      }),
    readText: async (path: string) => ({
      path,
      text: readFileSync(path, 'utf-8'),
      encoding: 'utf-8',
      eol: 'crlf',
      mtimeMs: null,
    }),
    readTexts: async (paths: readonly string[]) =>
      paths.map((p) => ({
        path: p,
        text: readFileSync(p, 'utf-8'),
        encoding: 'utf-8',
        eol: 'crlf',
        mtimeMs: null,
      })),
    walkDir: async (root: string) =>
      walk(root)
        .sort()
        // win32 的 join 产反斜杠：条目名两种分隔符都要切
        .map((p) => ({
          name: p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1),
          path: p,
          isDirectory: false,
        })),
  } as unknown as FileIO;
}

describe.skipIf(!existsSync(join(GAME_ROOT, 'CSV')))('真实语料读数（D:/Game/erafl）', () => {
  /** 任务书点名的 17 张表（`GameBase.csv` 是 `键,值` 表 ⇒ 0 条编号行） */
  const SEVENTEEN: ReadonlyArray<readonly [string, number]> = [
    ['CFLAG', 127],
    ['TALENT', 174],
    ['PALAM', 20],
    ['ABL', 50],
    ['EX', 10],
    ['STAIN', 6],
    ['MARK', 1],
    ['SOURCE', 39],
    ['CSTR', 28],
    ['TSTR', 11],
    ['TFLAG', 71],
    ['TCVAR', 106],
    ['TRAIN', 233],
    ['ITEM', 201],
    ['FLCONFIG', 44],
    ['KOJOEVENT', 142],
    ['GAMEBASE', 0],
  ];

  /** 同目录另有 4 张有编号的表（不在点名之列，一并钉住，防"漏扫整个目录"回归） */
  const EXTRA: ReadonlyArray<readonly [string, number]> = [
    ['FLAG', 91],
    ['EXP', 78],
    ['BASE', 10],
    ['FLTUTOR', 4],
  ];

  it('端到端加载：17 张点名表 + 4 张附加表读数逐条相等，4 张键值/配置表 0 条', async () => {
    const schema = await loadEraflVariableSchema({
      io: realIo(),
      csvDir: join(GAME_ROOT, 'CSV'),
      erbDir: join(GAME_ROOT, 'ERB'),
      log: silentLog,
    });
    for (const [family, count] of [...SEVENTEEN, ...EXTRA]) {
      expect(schema.names?.(family)?.length, family).toBe(count);
    }
    // 键值 / 尺寸 / 替换配置表：族在、索引无
    for (const family of ['VARIABLESIZE', 'VAREXTFL', '_RENAME', '_REPLACE']) {
      expect(schema.names?.(family), family).toEqual([]);
    }
    expect(schema.lookup('CFLAG', 2)?.description).toBe('好感度');
    expect(schema.lookup('TRAIN', 0)?.description).toBe('愛撫');
    // 空名称行（Tflag.csv 14 条 `n,,;不明`）跳过 ⇒ 5 号"族在、索引无"
    expect(schema.lookup('TFLAG', 5)).toEqual({ name: 'TFLAG', index: 5 });
  }, 120000);

  it('`.ERH` 名表：112 份 / 3507 个声明名，const 层可换算编号', async () => {
    const erbDir = join(GAME_ROOT, 'ERB');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((e) => {
        const p = join(dir, e);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    const erh = walk(erbDir).filter((p) => /\.erh$/i.test(p));
    const all = new Map<string, number | undefined>();
    for (const p of erh) {
      for (const [name, value] of parseErhDeclarations(readFileSync(p, 'utf-8'))) {
        if (!all.has(name)) all.set(name, value);
      }
    }
    expect(erh.length).toBe(112);
    expect(all.size).toBe(3507);
    expect([...all.values()].filter((v) => v !== undefined).length).toBe(1868);

    const schema = await loadEraflVariableSchema({
      io: realIo(),
      csvDir: join(GAME_ROOT, 'CSV'),
      erbDir,
      log: silentLog,
    });
    expect(schema.lookup('CFLAG', '衣装部位_頭')?.resolvedIndex).toBe(0);
    expect(schema.lookup('CFLAG', '衣装部位_頭')?.source).toBe('const');
    expect(schema.lookup('CFLAG', 'ME_NodeSize')?.resolvedIndex).toBe(20);
    // 无整数初值的 `#DIM`：收录但无编号
    expect(schema.lookup('CFLAG', 'ME_selectedNode')?.source).toBe('const');
    expect(schema.lookup('CFLAG', 'ME_selectedNode')?.resolvedIndex).toBeUndefined();
  }, 120000);

  it('`inputDigest` 同盘两次相等（派生缓存判据稳定）', async () => {
    const loadOnce = () =>
      loadEraflVariableSchema({
        io: realIo(),
        csvDir: join(GAME_ROOT, 'CSV'),
        erbDir: join(GAME_ROOT, 'ERB'),
        log: silentLog,
      });
    const a = await loadOnce();
    const b = await loadOnce();
    expect(typeof a.inputDigest).toBe('string');
    expect(a.inputDigest).toBe(b.inputDigest);
  }, 120000);

  it('真盘指令名表：233 条编号 / 230 个唯一名，`愛撫` → 0', async () => {
    const table = await loadEraflInstructionNames({
      io: realIo(),
      csvDir: join(GAME_ROOT, 'CSV'),
      log: silentLog,
    });
    expect(table.hasTable).toBe(true);
    // 233 条编号里有 3 组同名多编号（吃饭 351/704、狩猟 357/753、脱衣服 852/853）⇒ 枚举去重后 230
    expect(table.names?.().length).toBe(230);
    expect(table.lookupByName('愛撫')).toBe(0);
    expect(table.lookupByNo(0)).toBe('愛撫');
  }, 120000);
});
