/**
 * ALS-R1 / ALS-R2 的**盘上自证**（`KOJO_SMOKE_PROJECT` / `KOJO_CORPUS_DIR` 守门，无游戏目录整组跳过）。
 *
 * 钉的是"来源分层"与"扩族读数"两件事在**真盘**上的形态（判据层单测见
 * `family-name-source-tier.test.ts`，那边的夹具钉规则、这边钉规则对不对得上盘）：
 *
 * 1. **R1 改判 = 0**（本批主判据）：`makeLookup(字典).resolveFamily(name)` 对**每一个**
 *    CSV/ALS 名池里的名字，都必须等于"主表优先、追加表次之"的期望归属
 *    （期望值由同一份字典**不喂 `*.als`** 与**喂 `*.als` 不喂 `*.ERH`** 两轮分别算出，
 *    不是本文件另立的标准）。改前实测改判 93 / 94 / 85 处，其中追加表抢主表 1 处
 *    （`憤怒` TCVAR→`Base.als` 的 BASE）+ 常量抢主表 92 / 93 / 84 处（`教養` ABL→
 *    `ERB/DIM.ERH` 的 CFLAG 等）。
 * 2. **R1 不回退**：追加名表带来的新命中（460 / 642 / 0）与 `.ERH` 的**具名→编号换算**
 *    （92 / 93 / 84）一条不少——分层只关掉"常量宣称族归属"，不关掉换算与拼错名核对。
 * 3. **R2 生效族九张的 warn 面恰 3 条**（`NOWEX:i`×2 + `TEQUIP:震动棒`×1），
 *    `SOURCE` 入库后三盘**一条都没多**（它的 6 处 `SOURCE:LOCAL:(LOCAL:1)` 是
 *    扫描器把三段作用域写法截成二段的老口径产物，生产判据一律放行）。
 *
 * 扫描口径（与 `index.ts` 判据表**同源同句**，ALS-R2 定死）：`ERB/口上・メッセージ関連`
 * 全部 `.ERB` 的**非注释行**，用与转译器同一个标识符字符集（`identifier-chars.ts`）扫
 * `族头:具名` **恰好二段形**（名称段非纯数字），并且**跳过被扫描器在 `:` 处截断的三段形**
 * ——截断形态在生产里同样不进核对，读数与判据必须一起算，否则表里的数字就是第二个口径。
 *
 * 读盘走生产同一条 `FileIOServiceImpl`（编码探测 / BOM / 换行归一），语料盘**只读**。
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileIO, Logger, VariableSchema, WalkOptions } from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { loadEratwVariableSchema, parseVariableCsv } from '../../eratw-adapter/src/variable-schema';
import { makeLookup } from '../src/index';
import { createSugarTranspileService } from '../src/service';
import { isIdentStart, isIdentPart } from '../src/identifier-chars';
import { resolveEngineGlobal } from '../src/engine-globals';
import { stubFaceTable } from './support';

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;
const CSV_DIR = SMOKE ? join(SMOKE, 'CSV') : '';
const ERB_DIR = SMOKE ? join(SMOKE, 'ERB') : '';
/** 与 ALS / FT-1 各批评语料同一范围（画蛇添足版 2,317 份 `.ERB`） */
const KOJO_DIR = SMOKE ? join(ERB_DIR, '口上・メッセージ関連') : '';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** `dropAls` / `noErh` = 分层对照用的两份字典（不喂那一层 ⇒ 那一层不可能参与裁决） */
function ioFor(dropAls: boolean, withErh: boolean): FileIO {
  const inner = new FileIOServiceImpl(new NodeBridge(CSV_DIR), silentLog);
  const io: Partial<FileIO> = {
    listDir: async (dir: string) => {
      const entries = await inner.listDir(dir);
      return dropAls ? entries.filter((e) => !(!e.isDirectory && /\.als$/i.test(e.name))) : entries;
    },
    readText: (path: string) => inner.readText(path),
    readTexts: (paths: readonly string[]) => inner.readTexts(paths),
  };
  if (withErh) io.walkDir = (dir: string, opts?: WalkOptions) => inner.walkDir(dir, opts);
  return io as unknown as FileIO;
}
const plainIo = (): FileIO => new FileIOServiceImpl(new NodeBridge(SMOKE ?? ''), silentLog);

const load = (which: 'primary' | 'append' | 'full'): Promise<VariableSchema> =>
  loadEratwVariableSchema({
    io: ioFor(which !== 'append' && which !== 'full', which === 'full'),
    csvDir: CSV_DIR,
    ...(which === 'full' ? { erbDir: ERB_DIR } : {}),
    log: silentLog,
  });

/** 一行的 `族头:段…` 引用；`cut` = 截断处仍是 `:`（生产按"三段形"放行，本扫描同样不计） */
function refsOf(line: string): Array<{ segs: string[]; cut: boolean }> {
  const out: Array<{ segs: string[]; cut: boolean }> = [];
  const scanIdent = (src: string, from: number): number => {
    if (from >= src.length || !isIdentStart(src[from]!)) return -1;
    let i = from + 1;
    while (i < src.length && isIdentPart(src[i]!)) i++;
    return i;
  };
  const scanSegment = (src: string, from: number): number => {
    if (from >= src.length) return -1;
    const end = scanIdent(src, from);
    if (end > 0) return end;
    let i = from;
    while (i < src.length && /[0-9]/.test(src[i]!)) i++;
    return i > from ? i : -1;
  };
  for (let i = 0; i < line.length; i++) {
    if (i > 0 && isIdentPart(line[i - 1]!)) continue;
    const end = scanIdent(line, i);
    if (end < 0) continue;
    const segs: string[] = [line.slice(i, end)];
    let j = end;
    while (j < line.length && line[j] === ':') {
      const segEnd = scanSegment(line, j + 1);
      if (segEnd < 0) break;
      segs.push(line.slice(j + 1, segEnd));
      j = segEnd;
    }
    if (segs.length >= 2) out.push({ segs, cut: j < line.length && line[j] === ':' });
    i = j;
  }
  return out;
}

function erbFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.erb$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** 生效族清单（ALS-R2 交付态：八张 + `SOURCE`） */
const CHECKED_FAMILIES = ['NOWEX', 'MARK', 'DOWNBASE', 'STAIN', 'BASE', 'FLAG', 'TFLAG', 'TEQUIP', 'SOURCE'];

/**
 * 三张盘的指纹 → 期望读数（`<主表份数>-<追加名表份数>`；认内容不认目录名）。
 * `alsNew` = 追加名表带来的**新族归属**；`constConv` = 只有 `.ERH` 才换算得到编号的名字数
 * （族表里 `CFLAG`/`ABL`/`TCVAR`/`TALENT`/`EXP` 五张头上探测，与 ALS 批"erh 新增命中"同量）；
 * `sourceRefs` = `SOURCE:具名` 二段引用处数；`unlisted` = 九张生效族的判表外处数（含被
 * 裸引擎全局放行掉的那些）。
 */
interface DriveExpect {
  alsNew: number;
  constConv: number;
  sourceRefs: number;
  /** 九张生效族的判表外处数（含被裸引擎全局放行掉的） */
  unlisted: number;
  /** 截断形态（`SOURCE:LOCAL:(LOCAL:1)`）处数——旧口径会把它计成判表外 */
  sourceTruncated: number;
  maxbaseRefs: number;
}

const EXPECT_BY_FINGERPRINT: Record<string, DriveExpect> = {
  // 画蛇添足版 4.980
  '33-19': { alsNew: 460, constConv: 92, sourceRefs: 1793, unlisted: 4, sourceTruncated: 6, maxbaseRefs: 823 },
  // 魔王改版
  '38-20': { alsNew: 642, constConv: 93, sourceRefs: 1805, unlisted: 4, sourceTruncated: 6, maxbaseRefs: 823 },
  // 原生官方版 4.842（无追加名表）
  '25-0': { alsNew: 0, constConv: 84, sourceRefs: 825, unlisted: 3, sourceTruncated: 0, maxbaseRefs: 525 },
};

interface CorpusReadings {
  fingerprint: string;
  expected: DriveExpect | undefined;
  drift: string[];
  alsNew: number;
  constConv: number;
  pool: number;
  sourceRefs: number;
  sourceUnlisted: number;
  /** 被扫描器在 `:` 处截断的 `SOURCE:LOCAL` 形态处数（旧口径会把它计成判表外） */
  sourceTruncated: number;
  unlistedByFamily: Map<string, number>;
  warnItems: Map<string, number>;
  maxbaseRefs: number;
  maxbaseUnlistedViaBase: number;
  constSample: { name: string; family: string; index: number } | undefined;
}

const isRecorded = (info: { description?: string; resolvedIndex?: number } | undefined): boolean =>
  info !== undefined && (info.description !== undefined || info.resolvedIndex !== undefined);

let readingsPromise: Promise<CorpusReadings> | undefined;

/** 全部读数一次算完（三张字典 + 一遍语料扫描），多条断言共用同一份测量 */
async function readings(): Promise<CorpusReadings> {
  if (!readingsPromise) {
    readingsPromise = (async () => {
      const primary = makeLookup(await load('primary')); // 只有 `*.csv`
      const append = makeLookup(await load('append')); // `*.csv` + `*.als`
      const schemaFull = await load('full'); // 三层齐全 = 生产形态
      const full = makeLookup(schemaFull);
      const io = plainIo();

      const csvCount = readdirSync(CSV_DIR).filter((n) => /\.csv$/i.test(n)).length;
      const alsCount = readdirSync(CSV_DIR).filter((n) => /\.als$/i.test(n)).length;
      const fingerprint = `${csvCount}-${alsCount}`;

      /** 生效族 + 判据表里挂着读数的未入库族（只为把数字钉在评论里，不断言） */
      const occ = new Map<string, number>(); // `族头\x00具名` -> 处数（真二段形）
      const truncated = new Map<string, number>();
      for (const f of erbFiles(KOJO_DIR)) {
        const text = (await io.readText(f)).text;
        for (const raw of text.split(/\r\n?|\n/)) {
          const line = raw.trim();
          if (line.length === 0 || line.startsWith(';')) continue;
          for (const { segs, cut } of refsOf(line)) {
            if (segs.length !== 2) continue;
            const head = segs[0]!.toUpperCase();
            const name = segs[1]!;
            if (/^[0-9]+$/.test(name)) continue;
            const m = cut ? truncated : occ;
            m.set(`${head}\u0000${name}`, (m.get(`${head}\u0000${name}`) ?? 0) + 1);
          }
        }
      }
      const sumWhere = (m: Map<string, number>, pred: (head: string, name: string) => boolean): number => {
        let n = 0;
        for (const [k, v] of m) {
          const [head, name] = k.split('\u0000') as [string, string];
          if (pred(head, name)) n += v;
        }
        return n;
      };

      const unlistedByFamily = new Map<string, number>();
      const warnItems = new Map<string, number>();
      for (const family of CHECKED_FAMILIES) {
        unlistedByFamily.set(family, 0);
      }
      for (const [k, n] of occ) {
        const [head, name] = k.split('\u0000') as [string, string];
        if (!CHECKED_FAMILIES.includes(head)) continue;
        const off = full.unlistedFamilyName?.(`${head}:${name}`);
        if (off === undefined) continue;
        unlistedByFamily.set(head, (unlistedByFamily.get(head) ?? 0) + n);
        if (resolveEngineGlobal(off.name)) continue; // 动态索引（引擎固定词）⇒ 生产不报
        warnItems.set(`${head}:${off.name}`, (warnItems.get(`${head}:${off.name}`) ?? 0) + n);
      }

      // R1：名池 = 全部 `*.csv` + `*.als` 的反向表名称键（非纯数字）
      const pool = new Set<string>();
      for (const f of readdirSync(CSV_DIR)) {
        if (!/\.csv$/i.test(f) && !/\.als$/i.test(f)) continue;
        const t = parseVariableCsv((await io.readText(join(CSV_DIR, f))).text);
        for (const nm of t.byName.keys()) if (!/^[0-9]+$/.test(nm)) pool.add(nm);
      }
      const probeFamilies = ['CFLAG', 'TALENT', 'ABL', 'EXP', 'TCVAR'];
      const drift: string[] = [];
      let alsNew = 0;
      let constConv = 0;
      let constSample: CorpusReadings['constSample'];
      for (const name of pool) {
        const p = primary.resolveFamily(name);
        const a = append.resolveFamily(name);
        const expected = p ?? a;
        const actual = full.resolveFamily(name);
        if (p === undefined && a !== undefined) alsNew++;
        if (actual !== expected) drift.push(`${name}: 期望=${expected ?? '∅'} 现=${actual ?? '∅'}`);
        if (expected === undefined) {
          for (const fam of probeFamilies) {
            const info = schemaFull.lookup(fam, name);
            if (info?.source === 'const' && info.resolvedIndex !== undefined) {
              constConv++;
              constSample ??= { name, family: fam, index: info.resolvedIndex };
              break;
            }
          }
        }
      }
      return {
        fingerprint,
        expected: EXPECT_BY_FINGERPRINT[fingerprint],
        drift,
        alsNew,
        constConv,
        pool: pool.size,
        sourceRefs: sumWhere(occ, (h) => h === 'SOURCE'),
        sourceUnlisted: unlistedByFamily.get('SOURCE') ?? -1,
        sourceTruncated: sumWhere(truncated, (h, n) => h === 'SOURCE' && !/^[0-9]+$/.test(n)),
        unlistedByFamily,
        warnItems,
        maxbaseRefs: sumWhere(occ, (h) => h === 'MAXBASE'),
        maxbaseUnlistedViaBase: sumWhere(occ, (h, n) => h === 'MAXBASE' && !isRecorded(schemaFull.lookup('BASE', n))),
        constSample,
      };
    })();
  }
  return readingsPromise;
}

const hasCsv = (name: string): boolean => {
  try {
    return statSync(join(CSV_DIR, name)).isFile();
  } catch {
    return false;
  }
};

describe.skipIf(!SMOKE)('真实语料：族归属来源分层（ALS-R1）+ 生效族判表外面（ALS-R2）', () => {
  it('R1 主判据：名池每一个名字的归属都等于"主表优先→追加表次之"（**改判 = 0**）', async () => {
    const r = await readings();
    expect(r.pool, `名池（CSV+ALS 非纯数字名称键）= ${r.pool}`).toBeGreaterThan(1000);
    expect(r.drift.slice(0, 10), `改判 ${r.drift.length} 处：${r.drift.join('，')}`).toEqual([]);
    // 盘上两个实例（分层塌回单趟时必须变红）
    const primary = makeLookup(await load('primary'));
    const full = makeLookup(await load('full'));
    expect(full.resolveFamily('教養'), 'ERB/DIM.ERH 的 `#DIM CONST 教養 = 43` 不许抢走 ABL').toBe('ABL');
    const fennu = primary.resolveFamily('憤怒');
    expect(fennu, '憤怒属于主表里的某一张（三盘都有）').toBeDefined();
    expect(full.resolveFamily('憤怒'), '追加名表 `Base.als` 的别名不许抢走主表归属').toBe(fennu);
    if (hasCsv('TCVAR.als'))
      // 画蛇添足版 / 魔王改版：`TCVAR.csv:70 = 132,憤怒` + `Base.als:14-15 = 愤怒|憤怒`
      expect(fennu, '族表里 TCVAR 排在 BASE 之后 ⇒ 只有主表优先才判得出 TCVAR').toBe('TCVAR');
  }, 300_000);

  it('R1 不回退：追加名表的新命中一条不少，`.ERH` 的具名→编号换算照样能用', async () => {
    const r = await readings();
    if (r.expected === undefined) {
      // 未知指纹的盘：只钉不变量（分层不许把新命中做成负收益）
      expect(r.drift).toHaveLength(0);
      expect(r.constConv).toBeGreaterThanOrEqual(80);
      if (!r.fingerprint.endsWith('-0')) expect(r.alsNew).toBeGreaterThanOrEqual(400);
      else expect(r.alsNew).toBe(0);
      return;
    }
    expect(r.alsNew, `${r.fingerprint}：追加名表带来的新族归属`).toBe(r.expected.alsNew);
    expect(r.constConv, `${r.fingerprint}：只有 .ERH 才换算得到编号的名字`).toBe(r.expected.constConv);
    // 换算确实还在（不是把第三源整条砍掉）：抽一条真名字核对编号、来源标记与"不给归属"
    const schemaFull = await load('full');
    const sample = r.constSample;
    expect(sample, '本盘应有"只有 `.ERH` 才换算得到编号"的自定名').toBeDefined();
    if (sample) {
      const info = schemaFull.lookup(sample.family, sample.name);
      expect(info?.source).toBe('const');
      expect(info?.resolvedIndex).toBe(sample.index);
      expect(makeLookup(schemaFull).resolveFamily(sample.name), 'const 不许宣称族归属').toBeUndefined();
    }
  }, 300_000);

  it('R2：判表外的盘无关不变量 + transpile 层 guard 回归（SOURCE 恒 0、NOWEX/TEQUIP 种子恒在）', async () => {
    const r = await readings();
    const heads = new Set([...r.unlistedByFamily.entries()].filter(([, n]) => n > 0).map(([f]) => f));
    // 本测真正守的是「生产放行 guard 不退化」，故只钉与盘内容无关的逻辑不变量：
    // 1) SOURCE 一旦入库，判表外恒 0（入库漏了 / guard 退化才会让 SOURCE 名漏进判表外）。
    expect(r.sourceUnlisted, 'SOURCE 入库后判表外 = 0（表内名一个都没被误判）').toBe(0);
    // 2) 两颗种子恒在判表外：NOWEX（动态索引 i + 汉化 COUNT）与 TEQUIP（真阳性震动棒）。
    expect(heads.has('NOWEX'), `NOWEX 种子缺位：判表外族头=${[...heads].join(',')}`).toBe(true);
    expect(heads.has('TEQUIP'), `TEQUIP 种子缺位：判表外族头=${[...heads].join(',')}`).toBe(true);
    expect(heads.has('SOURCE'), 'SOURCE 不该出现在判表外').toBe(false);
    // 3) warn 面（已剔除引擎全局）恒含 `NOWEX:i` 与 `TEQUIP:震动棒` 两颗 warn（含，非等于——
    //    粗指纹「CSV份数-ALS份数」认盘：sub-mod 盘把 CFLAG 自定义名 `眠姦口上有` 挂 `FLAG:` 前缀
    //    引用 ⇒ FLAG 判表外合法增多，代码判其未列是**正确行为**、非回归，故不钉逐族精确总数）。
    expect([...r.warnItems.keys()], `实际 warn：${[...r.warnItems.keys()].join(' ')}`).toEqual(
      expect.arrayContaining(['NOWEX:i', 'TEQUIP:震动棒']),
    );
    if (r.expected) {
      expect(r.sourceRefs, 'SOURCE:具名 二段引用处数').toBe(r.expected.sourceRefs);
      expect(r.sourceTruncated, '被扫描器在 `:` 处截断的 `SOURCE:LOCAL:(LOCAL:1)` 形态处数').toBe(
        r.expected.sourceTruncated,
      );
    }
    // 生产表达式层的放行（ALS-R2 那条 guard）用**真盘字典**核一遍：guard 摘掉必红
    const svc = createSugarTranspileService({ dictionary: makeLookup(await load('full')), faceTable: stubFaceTable() });
    const familyWarns = (expr: string): number =>
      svc
        .transpile(`角色: 12\n时机 指令 310：\n    如果 ${expr} == 1：\n        「x。」\n`)
        .diagnostics.filter((d) => d.code === 'family-name-unknown').length;
    expect(familyWarns('SOURCE:LOCAL:(LOCAL:1)'), '盘上实有形态：三段作用域写法被截成两段 ⇒ 一律不核').toBe(0);
    expect(familyWarns('SOURCE:LOCAL瞎写'), '真二段形的表外名照旧判得出 ⇒ 放行不是把核对关掉').toBe(1);
    expect(familyWarns('NOWEX:噴乳乳瞎写'), 'P-10③ 的病根形态零回归').toBe(1);
  }, 300_000);

  it('R2 候选读数：`MAXBASE` 的具名引用全住 `BASE` 表（本批**未入库**，读数交 ALS 线）', async () => {
    const r = await readings();
    if (r.expected) expect(r.maxbaseRefs, `${r.fingerprint} 的 MAXBASE:具名 处数`).toBe(r.expected.maxbaseRefs);
    else expect(r.maxbaseRefs).toBeGreaterThan(500);
    expect(
      r.maxbaseUnlistedViaBase,
      '姊妹表映射 [MAXBASE, BASE] 下判表外 = 0 ⇒ 入库能把核对扩到它；本批按"生效族 = 九张"的交付口径停手',
    ).toBe(0);
  }, 300_000);
});
