/**
 * eraAV 变量字典判据：CSV 名称表合并口径 / `.ERH` 声明解析 / 装载器（内存盘合成 + 真盘普查）。
 *
 * 本作专属的两条判据（合成与真盘用例都钉住）：
 * - **缺表纪律**：`CFLAG` / `SOURCE` / `TEQUIP` / `EQUIP` 四表缺席而语料 `CFLAG:` 引用
 *   17,400 处 ⇒ `lookup` 返回 `undefined`，不抛错、不借 eraTW 的名字表顶上；
 * - **空表照样建**（eraFL 口径）：`.csv` 在但 0 条（GAMEBASE / STR / VARIABLESIZE）⇒
 *   族在（家族级 `lookup` 回 `{ name }`）、索引无（`names` 为空数组）。
 *
 * 真盘用例按各 adapter 惯例 `skipIf` 守卫（跨主机 skipped 数会变，这是设计不是红）；
 * 合成用例不依赖盘，独立成立。本包暂无 `tests/harness.ts`（批次只允许建本文件），
 * 故内存盘 / 真盘 IO 桩内联于此。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DirEntry, FileIO } from '@kojo/plugin-api';
import {
  loadEraavInstructionNames,
  loadEraavVariableSchema,
  mergeNameTable,
  parseErhDeclarations,
  parseNameTableCsv,
} from '../src/variable-schema';

const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/* ------------------------------ 内存盘（合成用例） ------------------------------ */

/**
 * 内存盘：`files` 是「绝对路径 → 正文」，`dirs` 是显式目录（含空目录）。
 * 路径按 `/` 归一后比较（与 eratohoK harness 同构）。
 */
function memIo(files: Record<string, string>, dirs: readonly string[]): FileIO {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const fileMap = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  const dirSet = new Set(dirs.map(norm));

  /** 由文件路径补出所有父目录 */
  for (const p of fileMap.keys()) {
    let i = p.lastIndexOf('/');
    while (i > 0) {
      dirSet.add(p.slice(0, i));
      i = p.lastIndexOf('/', i - 1);
    }
  }

  const directChildren = (path: string): DirEntry[] => {
    const prefix = `${norm(path).replace(/\/+$/, '')}/`;
    const found = new Map<string, boolean>();
    for (const p of fileMap.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.length === 0 || rest.includes('/')) continue;
      found.set(rest, false);
    }
    for (const d of dirSet) {
      if (!d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (rest.length === 0 || rest.includes('/')) continue;
      found.set(rest, true);
    }
    return [...found].map(([name, isDirectory]) => ({
      name,
      path: `${prefix}${name}`,
      isDirectory,
    }));
  };

  const allEntries = (path: string): DirEntry[] => {
    const prefix = `${norm(path).replace(/\/+$/, '')}/`;
    const out: DirEntry[] = [];
    for (const [p] of fileMap) {
      if (p.startsWith(prefix)) {
        out.push({ name: p.slice(p.lastIndexOf('/') + 1), path: p, isDirectory: false });
      }
    }
    for (const d of dirSet) {
      if (d.startsWith(prefix)) {
        out.push({ name: d.slice(d.lastIndexOf('/') + 1), path: d, isDirectory: true });
      }
    }
    return out;
  };

  return {
    exists: async (path: string) => fileMap.has(norm(path)) || dirSet.has(norm(path)),
    stat: async (path: string) =>
      dirSet.has(norm(path))
        ? { size: 0, mtimeMs: 0, isDirectory: true }
        : fileMap.has(norm(path))
          ? { size: 1, mtimeMs: 0, isDirectory: false }
          : null,
    listDir: async (path: string) => directChildren(path),
    readText: async (path: string) => {
      const text = fileMap.get(norm(path));
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return { path, text, encoding: 'utf-8', eol: 'lf', mtimeMs: 0 };
    },
    readTexts: async (paths: readonly string[]) =>
      paths.map((path) => {
        const text = fileMap.get(norm(path));
        return text === undefined
          ? null
          : { path, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: 0 };
      }),
    readBytes: async (path: string) => {
      const text = fileMap.get(norm(path));
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return new TextEncoder().encode(text);
    },
    walkDir: async (path: string) => allEntries(path),
  } as unknown as FileIO;
}

/* ------------------------------ 真盘（只读 Node FileIO） ------------------------------ */

function textFile(path: string): {
  path: string;
  text: string;
  encoding: 'utf-8' | 'utf-8-bom';
  eol: 'crlf' | 'lf';
  mtimeMs: number;
} {
  const raw = readFileSync(path, 'utf8');
  const hadBom = raw.charCodeAt(0) === 0xfeff;
  const text = hadBom ? raw.slice(1) : raw;
  return {
    path,
    text,
    encoding: hadBom ? 'utf-8-bom' : 'utf-8',
    eol: text.includes('\r\n') ? 'crlf' : 'lf',
    mtimeMs: statSync(path).mtimeMs,
  };
}

function walkAll(path: string): DirEntry[] {
  const out: DirEntry[] = [];
  for (const d of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, d.name);
    out.push({ name: d.name, path: p, isDirectory: d.isDirectory() });
    if (d.isDirectory()) out.push(...walkAll(p));
  }
  return out;
}

/** 只读的 Node 文件系统实现（写方法一律不提供；与 eraFL / eratohoK harness 同一方法集） */
function nodeIo(): FileIO {
  return {
    exists: async (path: string) => existsSync(path),
    stat: async (path: string) => {
      try {
        const s = statSync(path);
        return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() };
      } catch {
        return null;
      }
    },
    listDir: async (path: string) =>
      readdirSync(path, { withFileTypes: true }).map((d) => ({
        name: d.name,
        path: join(path, d.name),
        isDirectory: d.isDirectory(),
      })),
    readText: async (path: string) => textFile(path),
    readTexts: async (paths: readonly string[]) =>
      paths.map((p) => {
        try {
          return textFile(p);
        } catch {
          return null;
        }
      }),
    readBytes: async (path: string) => new Uint8Array(readFileSync(path)),
    walkDir: async (path: string) => walkAll(path),
  } as unknown as FileIO;
}

/**
 * 真盘根：约定 `C:/game/eraAV`（2026-10-26 实测在位）；本机若挪盘可用
 * `KOJO_ERAAV_ROOT` 覆盖，兜底再探 `D:/game/eraAV`。都不在 ⇒ 真盘用例整组 skip。
 */
const GAME_ROOT =
  [process.env['KOJO_ERAAV_ROOT'], 'C:/game/eraAV', 'D:/game/eraAV'].find(
    (p): p is string => typeof p === 'string' && p.length > 0 && existsSync(p),
  ) ?? 'C:/game/eraAV';
const hasCorpus = existsSync(join(GAME_ROOT, 'CSV')) && existsSync(join(GAME_ROOT, 'ERB'));

/* ------------------------------ 纯函数：CSV 解析 ------------------------------ */

describe('parseNameTableCsv', () => {
  it('`编号,名称[,注释]` 三形态；`;` 起注释整行跳过', () => {
    const { table, skippedEmptyName } = parseNameTableCsv(
      ['2,好感度,', '3,依存度,;注', '; 整行注释', '154,服従,;説明', '読めない,行'].join('\r\n'),
    );
    expect([...table.byIndex.entries()]).toEqual([
      ['2', '好感度'],
      ['3', '依存度'],
      ['154', '服従'],
    ]);
    expect(table.byName.get('服従')).toBe('154');
    expect(skippedEmptyName).toBe(0);
  });

  it('名称为空的行计数跳过；键值表（`コード,55777844`，真盘 GameBase.csv 形态）天然 0 条', () => {
    const { table, skippedEmptyName } = parseNameTableCsv('1,\nコード,55777844\n');
    expect(table.byIndex.size).toBe(0);
    expect(skippedEmptyName).toBe(1);
  });
});

describe('mergeNameTable —— 层内后者胜 / 跨层主表胜', () => {
  it('同编号后者胜并回调', () => {
    const table = { byIndex: new Map(), byName: new Map(), indexSource: new Map(), nameSource: new Map() };
    const seen: unknown[] = [];
    mergeNameTable(table as never, '2,旧名\n2,新名\n', { onOverwrite: (e) => seen.push(e) });
    expect(table.byIndex.get('2')).toBe('新名');
    expect(seen).toHaveLength(1);
  });

  it('追加层不覆盖主表同名编号', () => {
    const table = { byIndex: new Map(), byName: new Map(), indexSource: new Map(), nameSource: new Map() };
    mergeNameTable(table as never, '2,主表名\n', { source: 'primary' });
    mergeNameTable(table as never, '2,追加名\n9,新增\n', { source: 'append' });
    expect(table.byIndex.get('2')).toBe('主表名');
    expect(table.byIndex.get('9')).toBe('新增');
    expect(table.indexSource.get('9')).toBe('append');
  });
});

describe('parseErhDeclarations', () => {
  it('收 `#DIM` / `#DIMS` / `#DIM CONST`；只认整数与 0x 字面量', () => {
    const names = parseErhDeclarations(
      [
        '#DIM SAVEDATA 冒険回数',
        '#DIM CONST RANDCHOOSE_MAX = 10000',
        '#DIM CONST 色設定_清潔度 = 0x39E639',
        '#DIMS 依頼内容, 8',
        '#DIM CONST 既成事実 = 告白&1p0',
        '; #DIM 注释里的不算',
      ].join('\r\n'),
    );
    expect(names.get('RANDCHOOSE_MAX')).toBe(10000);
    expect(names.get('色設定_清潔度')).toBe(0x39e639);
    expect(names.get('冒険回数')).toBeUndefined();
    expect(names.has('依頼内容')).toBe(true);
    expect(names.get('既成事実')).toBeUndefined();
    expect(names.has('注釈')).toBe(false);
  });
});

/* ------------------------------ 装载器：内存盘合成 ------------------------------ */

describe('loadEraavVariableSchema —— 内存盘', () => {
  const ROOT = 'C:/mem/eraAV';

  /** 仿真盘形态：大小写混用文件名 + 键值表 + 空名称表 + 无 CFLAG（真盘即如此） */
  function io() {
    return memIo(
      {
        [`${ROOT}/CSV/Abl.csv`]: '0,性感,\r\n1,青春力,\r\n',
        [`${ROOT}/CSV/BASE.csv`]: '0,体力\r\n',
        [`${ROOT}/CSV/CSTR.csv`]: '0,不明,処女喪失の対象\r\n1,不明,\r\n',
        [`${ROOT}/CSV/exp.csv`]: '0,Ｖ経験\r\n',
        [`${ROOT}/CSV/GameBase.csv`]: 'コード,55777844\r\nタイトル,Erav优化整合版\r\n',
        [`${ROOT}/CSV/Str.csv`]: '0,\r\n1,\r\n',
        [`${ROOT}/CSV/Talent.csv`]: '0,処女,\r\n154,服従,;説明\r\n',
        [`${ROOT}/CSV/Train.csv`]: '0,爱抚\r\n6,胸愛撫\r\n313,胸愛撫\r\n',
        [`${ROOT}/CSV/VariableSize.CSV`]: 'TA,100,100,100\r\n',
        [`${ROOT}/CSV/_default.config`]: 'whatever\r\n',
        [`${ROOT}/CSV/Chara/Chara01_宮間かなで.csv`]: '0,不会被根层扫到\r\n',
        [`${ROOT}/ERB/FUNCTIONS/common/RANDCHOOSE/#DIM.ERH`]: '#DIM RANDCHOOSE_NUM\r\n#DIM CONST RANDCHOOSE_MAX = 10000\r\n',
        [`${ROOT}/ERB/SYSTEM/SHOP.ERH`]: '#DIMS CHARASALES, 8\r\n',
      },
      [`${ROOT}/CSV`, `${ROOT}/CSV/Chara`, `${ROOT}/ERB`],
    );
  }

  it('大小写混用归一建表 + `.ERH` 常量兜底；同名反查归并（CSTR 双「不明」）', async () => {
    const schema = await loadEraavVariableSchema({
      io: io(),
      csvDir: `${ROOT}/CSV`,
      erbDir: `${ROOT}/ERB`,
      log: silentLog,
    });
    // `Abl.csv` → 表名 `ABL`；`exp.csv` / `VariableSize.CSV` 同理（去扩展名后大写归一）
    expect(schema.lookup('ABL', 0)?.description).toBe('性感');
    expect(schema.lookup('abl', '青春力')?.resolvedIndex).toBe(1);
    expect(schema.lookup('EXP', 0)?.description).toBe('Ｖ経験');
    expect(schema.lookup('VARIABLESIZE')).toEqual({ name: 'VARIABLESIZE' });
    // CSTR 两行同名「不明」：正向两条编号都在；反查按「层内后者胜」归**最后落地**的编号
    expect(schema.names!('CSTR').length).toBe(2);
    expect(schema.lookup('CSTR', '不明')?.resolvedIndex).toBe(1);
    // `.ERH` 常量兜底只走「表在的族」（ITEM 表在合成盘缺席 ⇒ 族缺席，与真盘 CFLAG 同理）
    expect(schema.lookup('ABL', 'RANDCHOOSE_MAX')?.resolvedIndex).toBe(10000);
    expect(schema.lookup('ABL', 'RANDCHOOSE_MAX')?.source).toBe('const');
    expect(schema.lookup('BASE', 'RANDCHOOSE_NUM')?.source).toBe('const');
    expect(schema.lookup('BASE', 'RANDCHOOSE_NUM')?.resolvedIndex).toBeUndefined();
    // `#DIM.ERH` 这个怪文件名必须被 `.ERH` 扫描收进来
    expect(schema.lookup('ABL', 'CHARASALES')?.source).toBe('const');
    expect(schema.inputDigest).toMatch(/^[0-9a-f]{14}$/);
  });

  it('缺表纪律：CFLAG 表缺席 ⇒ 族缺席 `undefined`（引用再多也不抛、不编名）；空表照样建 ⇒ 族在索引无', async () => {
    const schema = await loadEraavVariableSchema({
      io: io(),
      csvDir: `${ROOT}/CSV`,
      erbDir: `${ROOT}/ERB`,
      log: silentLog,
    });
    // 缺表族（真盘同样缺 CFLAG/SOURCE/TEQUIP/EQUIP）：三层查询全 `undefined`
    expect(schema.lookup('CFLAG')).toBeUndefined();
    expect(schema.lookup('CFLAG', 2)).toBeUndefined();
    expect(schema.lookup('CFLAG', '好感度')).toBeUndefined();
    expect(schema.names!('CFLAG')).toEqual([]);
    // 0 条目表照样建（GameBase/VariableSize 键值形态、Str 空名称形态）：族在、索引无
    for (const family of ['GAMEBASE', 'STR', 'VARIABLESIZE']) {
      expect(schema.lookup(family)).toEqual({ name: family });
      expect(schema.names!(family)).toEqual([]);
      // 具名索引落空 ⇒ 回声（不猜描述）
      expect(schema.lookup(family, 0)?.description).toBeUndefined();
    }
  });

  it('市场字典包追加：只补不盖', async () => {
    const io = memIo(
      {
        [`${ROOT}/CSV/ABL.csv`]: '0,主表名\r\n',
        [`${ROOT}/MARKET/DICT/ABL.csv`]: '0,追加名（不该盖主表）\r\n7,追加新增\r\n',
        [`${ROOT}/MARKET/DICT/CFLAG.csv`]: '9,借来的 CFLAG（本作没有的族由市场包补上）\r\n',
      },
      [`${ROOT}/CSV`, `${ROOT}/ERB`, `${ROOT}/MARKET/DICT`],
    );
    const schema = await loadEraavVariableSchema({
      io,
      csvDir: `${ROOT}/CSV`,
      erbDir: `${ROOT}/ERB`,
      log: silentLog,
      marketAppendDirs: [`${ROOT}/MARKET/DICT`],
    });
    expect(schema.lookup('ABL', 0)?.description).toBe('主表名');
    expect(schema.lookup('ABL', 7)?.description).toBe('追加新增');
    expect(schema.lookup('ABL', 7)?.source).toBe('append');
    // 追加层可以把「真盘缺的族」补出来（这是市场包的本职，不是编造真盘事实）
    expect(schema.lookup('CFLAG', 9)?.description).toBe('借来的 CFLAG（本作没有的族由市场包补上）');
  });

  it('0 份 `.ERH` 优雅返回：自定名表层零存在，其余两轮照常', async () => {
    const schema = await loadEraavVariableSchema({
      io: memIo({ [`${ROOT}/CSV/Abl.csv`]: '0,性感,\r\n' }, [`${ROOT}/CSV`, `${ROOT}/ERB`]),
      csvDir: `${ROOT}/CSV`,
      erbDir: `${ROOT}/ERB`,
      log: silentLog,
    });
    expect(schema.lookup('ABL', 0)?.description).toBe('性感');
    // 表在而名字三层皆无 ⇒ 回声条目（`{name, index}`），不是 `undefined`、也不带 source
    expect(schema.lookup('ABL', 'RANDCHOOSE_MAX')).toEqual({ name: 'ABL', index: 'RANDCHOOSE_MAX' });
    expect(schema.inputDigest).toMatch(/^[0-9a-f]{14}$/);
  });

  it('CSV 目录不可读 → 不抛，字典为空且 digest 为确定值', async () => {
    const schema = await loadEraavVariableSchema({
      io: memIo({}, []),
      csvDir: `${ROOT}/CSV`,
      erbDir: `${ROOT}/ERB`,
      log: silentLog,
    });
    expect(schema.lookup('CFLAG', 2)).toBeUndefined();
    expect(schema.lookup('ABL')).toBeUndefined();
    expect(schema.inputDigest).toMatch(/^[0-9a-f]{14}$/);
  });
});

describe('loadEraavInstructionNames', () => {
  const ROOT = 'C:/mem/eraAV';

  it('同名多编号取**首条**（降糖期望基础指令段）', async () => {
    const io = memIo(
      { [`${ROOT}/CSV/Train.csv`]: '0,愛撫\r\n6,胸愛撫\r\n313,胸愛撫\r\n' },
      [`${ROOT}/CSV`],
    );
    const table = await loadEraavInstructionNames({ io, csvDir: `${ROOT}/CSV`, log: silentLog });
    expect(table.hasTable).toBe(true);
    expect(table.lookupByName('胸愛撫')).toBe(6);
    expect(table.lookupByNo(313)).toBe('胸愛撫');
    expect(table.names!()).toEqual(['愛撫', '胸愛撫']);
  });

  it('缺表 → hasTable=false（fail-closed），不抛', async () => {
    const io = memIo({ [`${ROOT}/CSV/Abl.csv`]: '0,性感\r\n' }, [`${ROOT}/CSV`]);
    const table = await loadEraavInstructionNames({ io, csvDir: `${ROOT}/CSV`, log: silentLog });
    expect(table.hasTable).toBe(false);
    expect(table.names!()).toEqual([]);
  });
});

/* ------------------------------ 真盘普查（skipIf 守卫） ------------------------------ */

/** 真盘 12 张表（普查基线 2026-10-26，`C:/game/eraAV`） */
const REAL_FAMILIES = [
  'ABL',
  'BASE',
  'CSTR',
  'EXP',
  'GAMEBASE',
  'ITEM',
  'MARK',
  'PALAM',
  'STR',
  'TALENT',
  'TRAIN',
  'VARIABLESIZE',
] as const;

describe.skipIf(!hasCorpus)('loadEraavVariableSchema —— 真盘普查（eraAV）', () => {
  it('12 张表 / 641 个有条目编号；缺表族 undefined；空表族在而索引无', async () => {
    const schema = await loadEraavVariableSchema({
      io: nodeIo(),
      csvDir: `${GAME_ROOT}/CSV`,
      erbDir: `${GAME_ROOT}/ERB`,
      log: silentLog,
    });
    // 普查读数：逐族条目数（大小写混用文件名全部归一建表）
    expect(schema.names!('ABL').length).toBe(34);
    expect(schema.names!('BASE').length).toBe(24);
    expect(schema.names!('CSTR').length).toBe(4);
    expect(schema.names!('EXP').length).toBe(82);
    expect(schema.names!('ITEM').length).toBe(109);
    expect(schema.names!('MARK').length).toBe(4);
    expect(schema.names!('PALAM').length).toBe(17);
    expect(schema.names!('TALENT').length).toBe(262);
    expect(schema.names!('TRAIN').length).toBe(105);
    const total = REAL_FAMILIES.reduce((n, f) => n + schema.names!(f).length, 0);
    expect(total).toBe(641);
    // 抽查正向 / 反向双向
    expect(schema.lookup('BASE', 0)?.description).toBe('体力');
    expect(schema.lookup('ITEM', '跳蛋')?.resolvedIndex).toBe(0);
    // 缺表纪律：CFLAG 引用 17,400 处，但表不在 ⇒ 族缺席，不抛不编名
    for (const absent of ['CFLAG', 'SOURCE', 'TEQUIP', 'EQUIP']) {
      expect(schema.lookup(absent)).toBeUndefined();
      expect(schema.lookup(absent, 1)).toBeUndefined();
    }
    // 0 条目照样建空表（eraFL 口径）：键值表 GAMEBASE/VARIABLESIZE + 空名称表 STR（2 行）
    for (const empty of ['GAMEBASE', 'STR', 'VARIABLESIZE']) {
      expect(schema.lookup(empty)).toEqual({ name: empty });
      expect(schema.names!(empty)).toEqual([]);
    }
    // 真盘 3 份 `.ERH` / 7 个声明名：带初值的换算编号，其余只收名字
    expect(schema.lookup('ABL', 'RANDCHOOSE_MAX')?.resolvedIndex).toBe(10000);
    expect(schema.lookup('ABL', 'RANDCHOOSE_MAX')?.source).toBe('const');
    expect(schema.lookup('BASE', 'FNAME')?.source).toBe('const');
    expect(schema.lookup('BASE', 'CHARASALES')?.resolvedIndex).toBeUndefined();
    expect(schema.inputDigest).toMatch(/^[0-9a-f]{14}$/);
  });
});

describe.skipIf(!hasCorpus)('loadEraavInstructionNames —— 真盘（eraAV/Train.csv）', () => {
  it('105 条编号；`爱抚`=0、`具现`=180', async () => {
    const table = await loadEraavInstructionNames({
      io: nodeIo(),
      csvDir: `${GAME_ROOT}/CSV`,
      log: silentLog,
    });
    expect(table.hasTable).toBe(true);
    expect(table.names!().length).toBe(105);
    expect(table.lookupByName('爱抚')).toBe(0);
    expect(table.lookupByNo(180)).toBe('具现');
  });
});
