/**
 * FT-1：真实语料 `.ERH` 作者自定名表进字典 —— **盘上自证**
 * （`KOJO_SMOKE_PROJECT` / `KOJO_CORPUS_DIR` 守门，没有游戏目录整组跳过）。
 *
 * 三条只能在这盘上成立（与 `variable-schema.als.corpus.test.ts` 同一形态）：
 * - **正自证**：口上作者写在 `.ERH` 里的自定名，字典查得到且编号 = 盘上声明的整数
 *   （钉的四条原句：`K15C_SAKUYADIM.ERH:14` / `K58C_1美鈴用DIM.ERH:14` /
 *   `M_KOJO_K17_追加ライブラリ.ERH:233` / `K42C_はたて用DIM.ERH:19`，均取自画蛇添足版）；
 * - **负自证（防假绿）**：同一张盘**不喂 `.ERH`** 时这些名字必须逐字回显（无 description /
 *   resolvedIndex = `isRecorded` 判表外的形态）；
 * - **不翻案**：`.ERH` 并入后每张名称表的 `编号 → 名称` 逐字不变、`*.als` 追加名的
 *   收录数一条不回退（那批读数是 ALS 线交付的）。
 *
 * 另加两条"为什么可以全收录、为什么故意少收"的盘上证词：
 * - **全局一张表无歧义**：整棵 ERB 子树里"同名不同值"的整数常量必须为 **0 组**
 *   （引擎 `IdentifierDictionary.cs:436-444` 用的是 `Dictionary.Add`，重名直接报错 ⇒
 *   盘上能开局就必然没有二义，故不按角色分桶不会引入引擎不认的误判）；
 * - **少收**：`#DIM NAME = 351`（无 `CONST` ⇒ 可写变量，运行期可被改写）**不收**。
 *
 * 读盘一律走生产同一条 `FileIOServiceImpl`（编码探测 + BOM 剥离 + 换行归一）——
 * 盘上混着 Shift-JIS / GBK / UTF-8，`readFileSync` 的固定编码会把 CJK 名解成乱码，
 * 对照断言就会假失败。
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileIO, Logger, WalkOptions } from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { loadEratwVariableSchema, parseErhConsts, parseVariableCsv } from '../src/variable-schema';

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;
const CSV_DIR = SMOKE ? join(SMOKE, 'CSV') : '';
const ERB_DIR = SMOKE ? join(SMOKE, 'ERB') : '';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const probeIo = (): FileIO => new FileIOServiceImpl(new NodeBridge(CSV_DIR), silentLog);

/** `walkDir` 缺位 = 字典一条 `.ERH` 都不该读到（负自证的实现方式） */
function ioFor(erh: boolean): FileIO {
  const inner = probeIo();
  const io: Partial<FileIO> = {
    listDir: (dir: string) => inner.listDir(dir),
    readText: (path: string) => inner.readText(path),
    readTexts: (paths: readonly string[]) => inner.readTexts(paths),
  };
  if (erh) io.walkDir = (dir: string, opts?: WalkOptions) => inner.walkDir(dir, opts);
  return io as unknown as FileIO;
}

const load = (erh: boolean) =>
  loadEratwVariableSchema({
    io: ioFor(erh),
    csvDir: CSV_DIR,
    chsMapPath: SMOKE ? join(SMOKE, 'plugins', 'tw_csv_chs.xml') : undefined,
    ...(erh ? { erbDir: ERB_DIR } : {}),
    log: silentLog,
  });

const hasFile = (name: string): boolean => {
  if (!SMOKE) return false;
  try {
    return statSync(join(CSV_DIR, name)).isFile();
  } catch {
    return false;
  }
};

/** 盘上全部 `.ERH`（整棵 ERB 子树——引擎同样是从 ERB 根递归装载，`Process.cs:221`） */
function erhPaths(): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.erh$/i.test(e.name)) out.push(p);
    }
  };
  if (SMOKE) walk(ERB_DIR);
  return out.sort();
}

/** 盘上原句 → `大写名称 → { 值, 出处 }`（首个定义优先，与 loader 同裁决） */
async function diskConsts(): Promise<Map<string, { value: number; at: string }>> {
  const io = probeIo();
  const map = new Map<string, { value: number; at: string }>();
  for (const p of erhPaths()) {
    for (const [name, value] of parseErhConsts((await io.readText(p)).text)) {
      if (!map.has(name)) map.set(name, { value, at: resolve(p) });
    }
  }
  return map;
}

/** 盘上名称表原文（`.csv` / `.als` 同一套行格式）→ `编号↔名称` */
async function parseDisk(file: string): Promise<{ byIndex: Map<string, string>; byName: Map<string, string> }> {
  return parseVariableCsv((await probeIo().readText(join(CSV_DIR, file))).text);
}

describe.skipIf(!SMOKE)('真实语料 .ERH 作者自定名表：盘上自证', () => {
  it('正自证：作者写在 `.ERH` 的自定名查得到，编号 = 盘上声明的整数', async () => {
    const schema = await load(true);
    const consts = await diskConsts();
    // [族头, 作者自定名, 期望编号]——画蛇添足版原句行号见文件头注
    const cases: Array<[string, string, number]> = [
      ['CFLAG', 'K15C_SETTING_DISABLE_HATE_DIALOG', 1101],
      ['TCVAR', 'K58C_MeiLingNewVision_居睡眠フラグ', 360],
      ['ABL', 'K17C_部位V', 1],
      // 名称含全角数字：字典收得下（sugar 的标识符字符集切词是 ALS-R2 那行任务的地盘）
      ['CFLAG', 'K42C_果と通販その３', 1405],
    ];
    let checked = 0;
    for (const [fam, name, value] of cases) {
      const disk = consts.get(name.toUpperCase());
      if (disk === undefined) continue; // 换一张盘（角色目录不同）就跳过这一条，不硬顶
      checked++;
      expect(disk.value, `${name} 盘上声明值`).toBe(value);
      const info = schema.lookup(fam, name);
      expect(info?.resolvedIndex, `${fam}:${name}`).toBe(value);
      expect(info?.description, `${fam}:${name}`).toBe(name); // 描述 = 作者原文，不喂汉化词典
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('负自证（防假绿）：同一张盘**不喂 `.ERH`** 时这些名字必须逐字回显', async () => {
    const csvOnly = await load(false);
    const erhSchema = await load(true);
    const consts = await diskConsts();
    let checked = 0;
    for (const name of ['K15C_SETTING_DISABLE_HATE_DIALOG', 'K17C_部位V']) {
      if (consts.get(name.toUpperCase()) === undefined) continue;
      checked++;
      expect(csvOnly.lookup('CFLAG', name)).toEqual({ name: 'CFLAG', index: name });
      expect(erhSchema.lookup('CFLAG', name)?.resolvedIndex).toBeGreaterThan(0);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('不翻案①：`.ERH` 并入后每张名称表的**每一个编号 → 名称**与每一个具名逐字不变', async () => {
    const merged = await load(true);
    const plain = await load(false);
    let checkedIndexes = 0;
    let checkedNames = 0;
    for (const file of readdirSync(CSV_DIR)) {
      if (!/\.csv$/i.test(file)) continue;
      const fam = file.replace(/\.csv$/i, '').toUpperCase();
      const t = await parseDisk(file);
      for (const [idx, primaryName] of t.byIndex.entries()) {
        checkedIndexes++;
        // 与不并 `.ERH` 时逐字一致（`编号→名称` 永不被常量改写）
        expect(merged.lookup(fam, Number(idx)), `${fam}:${idx}`).toEqual(plain.lookup(fam, Number(idx)));
      }
      for (const nm of t.byName.keys()) {
        checkedNames++;
        expect(merged.lookup(fam, nm), `${fam}:${nm}`).toEqual(plain.lookup(fam, nm));
      }
    }
    expect(checkedIndexes).toBeGreaterThan(1000);
    expect(checkedNames).toBeGreaterThan(500);
  });

  it('不翻案②：`*.als` 追加名的收录数一条都不回退', async () => {
    if (!hasFile('TCVAR.als')) return;
    const plain = await load(false);
    const merged = await load(true);
    let alsOnlyNames = 0;
    let alsOnlyIndexes = 0;
    for (const f of readdirSync(CSV_DIR)) {
      if (!/\.als$/i.test(f)) continue;
      const base = f.replace(/\.als$/i, '');
      if (!hasFile(`${base}.csv`)) continue;
      const als = await parseDisk(f);
      const csv = await parseDisk(`${base}.csv`);
      const fam = base.toUpperCase();
      for (const [alias, idx] of als.byName.entries()) {
        if (csv.byName.has(alias)) continue;
        alsOnlyNames++;
        // 并入 `.ERH` 前后：追加名照旧查得到、编号照旧
        expect(plain.lookup(fam, alias)?.resolvedIndex, `${fam}:${alias}`).toBe(Number(idx));
        expect(merged.lookup(fam, alias)).toEqual(plain.lookup(fam, alias));
      }
      for (const idx of als.byIndex.keys()) {
        if (csv.byIndex.has(idx)) continue;
        alsOnlyIndexes++;
        expect(merged.lookup(fam, Number(idx))).toEqual(plain.lookup(fam, Number(idx)));
      }
    }
    // 画蛇添足版实测 757 名 / 26 编号；魔王版 973 / 27 ⇒ 只许 ≥
    expect(alsOnlyNames).toBeGreaterThanOrEqual(757);
    expect(alsOnlyIndexes).toBeGreaterThanOrEqual(26);
  });

  it('全局一张表的正当性：整棵 ERB 子树里"同名不同值"的整数常量 = 0 组', async () => {
    const io = probeIo();
    const conflicts: string[] = [];
    const seen = new Map<string, { value: number; at: string }>();
    for (const p of erhPaths()) {
      for (const [name, value] of parseErhConsts((await io.readText(p)).text)) {
        const prev = seen.get(name);
        if (prev === undefined) seen.set(name, { value, at: p });
        else if (prev.value !== value) conflicts.push(`${name}: ${prev.at}=${prev.value} vs ${p}=${value}`);
      }
    }
    expect(conflicts.slice(0, 5), `同名不同值 ${conflicts.length} 组`).toEqual([]);
    // 这张盘上确实有可观的自定名量（读数：画蛇添足版 5,755 个 / 魔王版 6,407 个 / 官方版 1,094 个）
    expect(seen.size).toBeGreaterThan(100);
  });

  it('故意少收：`#DIM NAME = 351`（无 CONST ⇒ 可写变量）不进字典', async () => {
    const schema = await load(true);
    const io = probeIo();
    const lines: string[] = [];
    for (const p of erhPaths()) lines.push(...(await io.readText(p)).text.split('\n'));
    const dynamic = lines
      .map((l) => /^\s*#DIM\s+(?!CONST)([^\s,=]+)\s*=\s*(\d+)\s*(?:;.*)?$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null);
    if (dynamic.length === 0) return;
    const name = (dynamic[0]![1] as string).toUpperCase();
    expect(schema.lookup('CFLAG', name)).toEqual({ name: 'CFLAG', index: name });
    expect((await diskConsts()).has(name)).toBe(false);
  });

  it('摘要：读到 `.ERH` 就变；同一张盘重复加载同值（可当失效判据）', async () => {
    const withErh = await load(true);
    const noErh = await load(false);
    const again = await load(true);
    expect(again.inputDigest).toBe(withErh.inputDigest);
    if (erhPaths().length === 0) expect(withErh.inputDigest).toBe(noErh.inputDigest);
    else expect(withErh.inputDigest).not.toBe(noErh.inputDigest);
    // 不喂 ERH 的那条路 = 今天的字典形态
    expect(noErh.lookup('CFLAG')).toEqual(withErh.lookup('CFLAG'));
  });
});
