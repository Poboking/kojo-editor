/**
 * KW-15B：**派生族 → 名表来源族**（`DERIVED_NAME_TABLE_SOURCES`）的自证。
 *
 * 钉三件事：
 * 1. **全覆盖闸**（分母 = `ENGINE_FAMILIES` 全集，与 `family-alias.test.ts` 同一形态）：
 *    每一族要么登记"借哪一族的表"、要么进排除台账且带理由，**两条台账互斥且相加 = 全集**
 *    ⇒ 漏一个派生族必须报红，不许静默；
 * 2. **借道只在"本族一张表都没有"时发生**：本族自有名表永远优先（模组自带
 *    `MAXBASE.csv` 时登记零生效）、来源族也没表就照旧 `undefined`（**不兜底 0、不 fuzzy、
 *    不猜编号**——假命中比未知更坏）；
 * 3. **借的是成品表**：合并轮序（先 `.csv` → 后 `.als` → 再市场字典包、首个定义优先）
 *    原样生效——本文件专门钉"`.als` 追加名经借道可见"与"借道不许改写主表已有编号"。
 *
 * 另钉两条**不扩面**的边界：`names()`（补全枚举面）与 `slotCn()`（槽名汉化）**不借道**——
 * 把姊妹族的槽位当本族候选推给作者，是另一条轴的假命中。
 *
 * 末段是真实语料盘上自证（`KOJO_SMOKE_PROJECT` / `KOJO_CORPUS_DIR` 守门，无盘整组跳过）：
 * 盘上确实没有 `MAXBASE.csv` / `NOWEX.csv`，而 `MAXBASE:酒気` 与 `BASE:酒気` **同编号**
 * ——这条就是"共用名表"的判性结论本身。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileIO, Logger } from '@kojo/plugin-api';
import {
  DERIVED_NAME_TABLE_EXCLUSIONS,
  DERIVED_NAME_TABLE_SOURCES,
  ENGINE_FAMILIES,
  loadEratwVariableSchema,
} from '../src/variable-schema';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** 一张 CSV 目录的桩：键 = 文件名（`Base.csv` / `Base.als` …），值 = 正文 */
function fakeIo(files: Record<string, string>): FileIO {
  const entries = Object.keys(files).map((name) => ({
    name,
    path: `/game/CSV/${name}`,
    isDirectory: false,
  }));
  return {
    listDir: async () => entries,
    readText: async (path: string) => ({ text: files[path.split('/').pop() as string] ?? '', path }),
    readTexts: async (paths: readonly string[]) =>
      paths.map((p) => ({ text: files[p.split('/').pop() as string] ?? '', path: p })),
  } as unknown as FileIO;
}

const load = (files: Record<string, string>, marketAppendDirs: readonly string[] = []) =>
  loadEratwVariableSchema({
    io: fakeIo(files),
    csvDir: '/game/CSV',
    ...(marketAppendDirs.length > 0 ? { marketAppendDirs } : {}),
    log: silentLog,
  });

/** 借道场景的公共桩：BASE 主表 + BASE 追加名表，派生族一张表都没有 */
const BASE_ONLY = {
  'Base.csv': '0,体力\n1,気力\n6,精力\n15,酒気\n',
  'Base.als': '15,酒气\n10,情绪\n',
};

// ---------------------------------------------------------------------------
// 1) 全覆盖闸
// ---------------------------------------------------------------------------
describe('派生族名表登记的台账对账', () => {
  it('每一族恰落一处：借表登记 / 排除台账，漏一族或双登都报红', () => {
    for (const family of ENGINE_FAMILIES) {
      const derived = DERIVED_NAME_TABLE_SOURCES[family] !== undefined;
      const excluded = family in DERIVED_NAME_TABLE_EXCLUSIONS;
      expect(derived || excluded, `${family}：既没登记借表、也不在排除台账（悄悄漏族）`).toBe(true);
      expect(derived && excluded, `${family}：既登记借表又在排除台账（台账打架）`).toBe(false);
    }
    expect(Object.keys(DERIVED_NAME_TABLE_SOURCES).length + Object.keys(DERIVED_NAME_TABLE_EXCLUSIONS).length).toBe(
      ENGINE_FAMILIES.length,
    );
  });

  it('排除台账不许过期：键必须真在全集里，理由不许空', () => {
    const universe = new Set(ENGINE_FAMILIES);
    for (const [family, reason] of Object.entries(DERIVED_NAME_TABLE_EXCLUSIONS)) {
      expect(universe.has(family), `${family} 不在 ENGINE_FAMILIES（过期排除条目）`).toBe(true);
      expect(reason.trim().length, `${family} 排除理由不许空`).toBeGreaterThan(0);
    }
  });

  it('借表登记：键与来源族都在全集内，且**来源族自己不借**（禁链式 / 禁环）', () => {
    const universe = new Set(ENGINE_FAMILIES);
    for (const [derived, source] of Object.entries(DERIVED_NAME_TABLE_SOURCES)) {
      expect(universe.has(derived), `${derived} 不在全集`).toBe(true);
      expect(universe.has(source), `${derived} 的来源族 ${source} 不在全集`).toBe(true);
      expect(derived === source, `${derived} 不许指向自己`).toBe(false);
      expect(DERIVED_NAME_TABLE_SOURCES[source], `${source} 自己也借表 = 链式借道（本登记只允许一跳）`).toBeUndefined();
    }
  });

  it('表无原型：作者字节里的 constructor / hasOwnProperty 不命中登记（fail-open 红线）', () => {
    expect(DERIVED_NAME_TABLE_SOURCES['constructor']).toBeUndefined();
    expect(DERIVED_NAME_TABLE_SOURCES['hasOwnProperty']).toBeUndefined();
    expect(DERIVED_NAME_TABLE_SOURCES['toString']).toBeUndefined();
  });

  it('在册登记逐字钉死（改一条必须带着出处来）', () => {
    expect(Object.entries(DERIVED_NAME_TABLE_SOURCES)).toEqual([
      ['MAXBASE', 'BASE'],
      ['DOWNBASE', 'BASE'],
      ['NOWEX', 'EX'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2) 借道只在"本族无表"时发生，且查不到就照旧落未知
// ---------------------------------------------------------------------------
describe('lookup 的派生族借道腿', () => {
  it('MAXBASE 无自有名表 → 借 BASE：具名索引换算成 BASE 表的编号', async () => {
    const schema = await load(BASE_ONLY);
    expect(schema.lookup('MAXBASE', '酒気')?.resolvedIndex).toBe(15);
    expect(schema.lookup('MAXBASE', '体力')?.resolvedIndex).toBe(0);
    expect(schema.lookup('MAXBASE', '精力')?.resolvedIndex).toBe(6);
    // 编号轴也借得到（悬停 / 反糖同轴）
    expect(schema.lookup('MAXBASE', 15)?.description).toBe('酒気');
  });

  it('借道后的条目仍报**被查的族头**（不许把 MAXBASE 改名成 BASE）', async () => {
    const schema = await load(BASE_ONLY);
    const info = schema.lookup('MAXBASE', '酒気');
    expect(info?.name).toBe('MAXBASE');
    expect(info?.index).toBe('酒気');
  });

  it('DOWNBASE 同轴借 BASE', async () => {
    const schema = await load(BASE_ONLY);
    expect(schema.lookup('DOWNBASE', '気力')?.resolvedIndex).toBe(1);
  });

  it('NOWEX 借的是 EX 那张表，**不是 EXP**（两张表编号不同轴）', async () => {
    const schema = await load({
      'ex.csv': '11,射精\n55,TotalEX\n',
      'exp.csv': '11,射精経験\n', // 同编号不同名：证明取的是 ex 不是 exp
    });
    expect(schema.lookup('NOWEX', 'TotalEX')?.resolvedIndex).toBe(55);
    expect(schema.lookup('NOWEX', '射精')?.resolvedIndex).toBe(11);
    // 只在 exp.csv 里的名字，NOWEX 借不到（借道不跨到 EXP）
    expect(schema.lookup('NOWEX', '射精経験')?.resolvedIndex).toBeUndefined();
  });

  it('本族自有名表 ⇒ 借道零生效（模组自带 MAXBASE.csv 时一切照本族表）', async () => {
    const schema = await load({
      ...BASE_ONLY,
      'MAXBASE.csv': '15,酒気\n7,最大体力\n', // 本族表里 7 = 最大体力（与 BASE 的 7 不同名）
    });
    expect(schema.lookup('MAXBASE', '最大体力')?.resolvedIndex).toBe(7);
    // 本族表没有的名字**不许**再回头去 BASE 找（自有表 = 独占裁决）
    expect(schema.lookup('MAXBASE', '精力')?.resolvedIndex).toBeUndefined();
    expect(schema.lookup('MAXBASE', '精力')?.name).toBe('MAXBASE'); // 只回显，不猜
  });

  it('来源族也没表 ⇒ undefined（不兜底 0、不猜编号）', async () => {
    const schema = await load({ 'CFLAG.csv': '2,好感度\n' }); // 一张 BASE 都没有
    expect(schema.lookup('MAXBASE', '酒気')).toBeUndefined();
    expect(schema.lookup('DOWNBASE', '気力')).toBeUndefined();
    expect(schema.lookup('NOWEX', '射精')).toBeUndefined();
  });

  it('借来的表里查无此名 ⇒ 只回显（无 description / 无 resolvedIndex = 落 named-index 未知）', async () => {
    const schema = await load(BASE_ONLY);
    const info = schema.lookup('MAXBASE', '酒气气');
    expect(info).toBeDefined();
    expect(info?.description).toBeUndefined();
    expect(info?.resolvedIndex).toBeUndefined();
  });

  it('族头大小写不敏感（引擎 IGNORE CASE）', async () => {
    const schema = await load(BASE_ONLY);
    expect(schema.lookup('maxbase', '酒気')?.resolvedIndex).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// 3) 借的是"合并完的成品表"：轮序与来源层不许被破坏
// ---------------------------------------------------------------------------
describe('借道与 .als / 市场字典包轮序的相容性', () => {
  it('.als 追加名经借道可见（主表没有的别名也能借到），且主表已有编号逐字不改', async () => {
    const schema = await load(BASE_ONLY);
    expect(schema.lookup('MAXBASE', '酒气')?.resolvedIndex).toBe(15); // Base.als 的别名
    expect(schema.lookup('MAXBASE', '情绪')?.resolvedIndex).toBe(10);
    // 来源层如实上报：借到的名字仍按**它在成品表里的那一轮**记源
    expect(schema.lookup('MAXBASE', '酒気')?.source).toBe('primary');
    expect(schema.lookup('MAXBASE', '酒气')?.source).toBe('append');
  });

  it('主表已有的编号，借道绝不改写（追加层只并集不覆盖）', async () => {
    const schema = await load({
      'Base.csv': '15,酒気\n',
      'Base.als': '15,别一个酒气名\n16,潜伏率\n',
    });
    expect(schema.lookup('MAXBASE', 15)?.description).toBe('酒気'); // 主表胜出
    expect(schema.lookup('MAXBASE', '潜伏率')?.resolvedIndex).toBe(16); // 追加层补的编号仍可借
  });

  it('市场字典包名表（append 轮）也经借道可见', async () => {
    const market = '/market/dict';
    const io = {
      listDir: async (dir: string) =>
        dir === '/game/CSV'
          ? [{ name: 'Base.csv', path: '/game/CSV/Base.csv', isDirectory: false }]
          : [{ name: 'Base.csv', path: `${market}/Base.csv`, isDirectory: false }],
      readText: async (path: string) => ({ text: '', path }),
      readTexts: async (paths: readonly string[]) =>
        paths.map((p) => ({
          text: p === '/game/CSV/Base.csv' ? '0,体力\n' : '15,酒气\n',
          path: p,
        })),
    } as unknown as FileIO;
    const schema = await loadEratwVariableSchema({ io, csvDir: '/game/CSV', marketAppendDirs: [market], log: silentLog });
    expect(schema.lookup('MAXBASE', '酒气')?.resolvedIndex).toBe(15);
    expect(schema.lookup('MAXBASE', '酒气')?.source).toBe('append');
  });

  it('.ERH 具名常量腿排在借道之后（名称表在前、常量在后，既有读数不改）', async () => {
    const csv = fakeIo(BASE_ONLY);
    const erhPath = '/game/ERB/a.ERH';
    const schema = await loadEratwVariableSchema({
      io: {
        ...csv,
        walkDir: async () => [{ name: 'a.ERH', path: erhPath, isDirectory: false }],
        // 本腿读盘走批量 `readTexts`：`.ERH` 给正文、CSV 轮仍按桩原样回
        readTexts: async (paths: readonly string[]) =>
          paths.map((p) =>
            p === erhPath
              ? { text: '#DIM CONST MY_MAXBASE_NAME = 1101\n', path: p }
              : { text: (BASE_ONLY as Record<string, string>)[p.split('/').pop() as string] ?? '', path: p },
          ),
      } as unknown as FileIO,
      csvDir: '/game/CSV',
      erbDir: '/game/ERB',
      log: silentLog,
    });
    // 借道表里没有 ⇒ 落 .ERH 常量换算
    expect(schema.lookup('MAXBASE', 'MY_MAXBASE_NAME')?.resolvedIndex).toBe(1101);
    expect(schema.lookup('MAXBASE', 'MY_MAXBASE_NAME')?.source).toBe('const');
    // 借道表里有的名字，常量不许抢（名称表优先）
    expect(schema.lookup('MAXBASE', '酒気')?.resolvedIndex).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// 4) 不扩面：枚举 / 汉化两条轴保持原口径
// ---------------------------------------------------------------------------
describe('借道不扩到 names / slotCn', () => {
  it('names(派生族) = 空数组（补全不许把姊妹族槽位当本族候选推给作者）', async () => {
    const schema = await load(BASE_ONLY);
    expect(schema.names?.('MAXBASE') ?? []).toEqual([]);
    expect(schema.names?.('DOWNBASE') ?? []).toEqual([]);
    // 桩的 BASE 成品表：主表 4 条编号 + `.als` 补一枚主表没有的编号 10 ⇒ 枚举面 5 条
    expect(schema.names?.('BASE')?.length).toBe(5);
  });

  it('slotCn(派生族, 编号) 不借道（查不到 = undefined，不冒充命中）', async () => {
    const schema = await load(BASE_ONLY);
    expect(schema.slotCn?.('MAXBASE', '15')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5) 真实语料盘上自证：判性结论本身
// ---------------------------------------------------------------------------
const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;
const CSV_DIR = SMOKE ? join(SMOKE, 'CSV') : '';

const hasFile = (name: string): boolean => {
  if (!SMOKE) return false;
  try {
    return statSync(join(CSV_DIR, name)).isFile();
  } catch {
    return false;
  }
};

describe.skipIf(!SMOKE)('真实语料：派生族名表借道的盘上证词', () => {
  const realIo = (): FileIO => {
    const entries = readdirSync(CSV_DIR)
      .filter((name) => {
        try {
          return statSync(join(CSV_DIR, name)).isFile();
        } catch {
          return false;
        }
      })
      .map((name) => ({ name, path: join(CSV_DIR, name), isDirectory: false }));
    return {
      listDir: async () => entries,
      readText: async (path: string) => ({ text: readFileSync(path, 'utf8'), path }),
      readTexts: async (paths: readonly string[]) =>
        paths.map((p) => ({ text: existsSync(p) ? readFileSync(p, 'utf8') : '', path: p })),
    } as unknown as FileIO;
  };

  it('前提钉死：派生族在盘上确实一张表都没有，来源族确实有', () => {
    for (const absent of ['MAXBASE.csv', 'MAXBASE.als', 'DOWNBASE.csv', 'DOWNBASE.als', 'NOWEX.csv', 'NOWEX.als']) {
      expect(hasFile(absent), `${absent} 竟然在位（借道前提变了）`).toBe(false);
    }
    expect(hasFile('Base.csv')).toBe(true);
    expect(hasFile('ex.csv')).toBe(true);
  });

  it('MAXBASE:酒気 → 与 BASE:酒気 **同编号**（共用名表的盘上证词）', async () => {
    const schema = await loadEratwVariableSchema({ io: realIo(), csvDir: CSV_DIR, log: silentLog });
    const base = schema.lookup('BASE', '酒気');
    const maxbase = schema.lookup('MAXBASE', '酒気');
    expect(base?.resolvedIndex).toBe(15);
    expect(maxbase?.resolvedIndex).toBe(base?.resolvedIndex);
    expect(maxbase?.name).toBe('MAXBASE');
    // 逐条换算取证（判性结论的数）
    for (const name of ['体力', '気力', '精力', '理性', '勃起', 'TSP']) {
      expect(
        schema.lookup('MAXBASE', name)?.resolvedIndex,
        `MAXBASE:${name} 应与 BASE:${name} 同编号`,
      ).toBe(schema.lookup('BASE', name)?.resolvedIndex);
    }
  });

  it('DOWNBASE / NOWEX 同源编号逐条钉死，且 NOWEX 取的是 EX 不是 EXP', async () => {
    const schema = await loadEratwVariableSchema({ io: realIo(), csvDir: CSV_DIR, log: silentLog });
    expect(schema.lookup('DOWNBASE', '気力')?.resolvedIndex).toBe(schema.lookup('BASE', '気力')?.resolvedIndex);
    expect(schema.lookup('NOWEX', '射精')?.resolvedIndex).toBe(schema.lookup('EX', '射精')?.resolvedIndex);
    expect(schema.lookup('NOWEX', 'TotalEX')?.resolvedIndex).toBe(schema.lookup('EX', 'TotalEX')?.resolvedIndex);
    // EXP 那张表没有 TotalEX ⇒ "同源 = EX"不是"随便哪张经验表"
    expect(schema.lookup('EXP', 'TotalEX')?.resolvedIndex).toBeUndefined();
  });

  it('借道不翻案：每张**自有**名表的 编号→名称 逐字不变（借道只碰本来查无的族）', async () => {
    const schema = await loadEratwVariableSchema({ io: realIo(), csvDir: CSV_DIR, log: silentLog });
    expect(schema.lookup('BASE', '酒気')?.resolvedIndex).toBe(15);
    expect(schema.lookup('EX', '射精')?.resolvedIndex).toBe(11);
    expect(schema.lookup('TALENT', '恋慕')?.resolvedIndex).toBe(3);
    expect(schema.lookup('PALAM', '潤滑')?.resolvedIndex).toBe(9);
    // 借来的条目不许带位表（策展位表按 `(族:号)` 点名，MAXBASE 一条都没有 ⇒ 不伪造）
    expect(schema.lookup('MAXBASE', '酒気')?.bits).toBeUndefined();
  });

  it('诚实面：借道表里查无的名字仍然换算不出（不许冒领编号）', async () => {
    const schema = await loadEratwVariableSchema({ io: realIo(), csvDir: CSV_DIR, log: silentLog });
    const info = schema.lookup('MAXBASE', ' KW15B不存在的名 ');
    expect(info?.resolvedIndex).toBeUndefined();
    expect(info?.description).toBeUndefined();
  });
});
