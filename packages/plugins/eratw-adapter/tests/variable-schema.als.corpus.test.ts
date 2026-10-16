/**
 * 真实语料 `CSV/*.als` 追加名表进字典 —— **盘上自证**
 * （`KOJO_SMOKE_PROJECT` 或 `KOJO_CORPUS_DIR` 守门，没有游戏目录整组跳过）。
 *
 * 为什么要有这个文件（而不只靠夹具）：`.als` 的行格式、简繁双写、BOM 有无、
 * 与同名 `.csv` 的冲突形态**全部来自盘**；夹具能钉住规则，钉不住"规则对不对得上盘"。
 * 本批的五条判据里有三条只能在这盘上成立：
 * - **正自证**：`泥酔`（`CSV/TCVAR.als:76`）、`Ｖ绝顶`（`CSV/ex.als:2`）经字典查得到；
 * - **负自证（防假绿）**：同一张盘**只读 `*.csv`** 时这两个名字必须查无；
 * - **不翻案**：合并 `.als` 后，主表已定义的每个 `编号 → 名称` 逐字不变
 *   （悬停描述与降糖产物的字面都由它决定，动了就是伤到别线）。
 *
 * 读盘走生产同一条 `FileIOServiceImpl`（编码探测 + BOM 剥离 + 换行归一），
 * 与 `structure.corpus.test.ts` 同一做法。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileIO, Logger } from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { loadEratwVariableSchema, parseVariableCsv } from '../src/variable-schema';

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;
const CSV_DIR = SMOKE ? join(SMOKE, 'CSV') : '';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** 真实 io（生产实现）；`dropAls` = 只喂 `*.csv`，用来做"不合并必查无"的负自证 */
function realIo(dropAls: boolean): FileIO {
  const inner = new FileIOServiceImpl(new NodeBridge(CSV_DIR), silentLog);
  return {
    listDir: async (dir: string) => {
      const entries = await inner.listDir(dir);
      return dropAls ? entries.filter((e) => !(e.isDirectory === false && /\.als$/i.test(e.name))) : entries;
    },
    readText: (path: string) => inner.readText(path),
    readTexts: (paths: readonly string[]) => inner.readTexts(paths),
  } as unknown as FileIO;
}

const load = (dropAls = false) =>
  loadEratwVariableSchema({ io: realIo(dropAls), csvDir: CSV_DIR, log: silentLog });

const hasFile = (name: string): boolean => {
  if (!SMOKE) return false;
  try {
    return statSync(join(CSV_DIR, name)).isFile();
  } catch {
    return false;
  }
};

/** 盘上原文解析（只取 `编号 → 名称`，作为"不许被覆盖"的对照源） */
function primaryRows(base: string): [string, string][] {
  const t = parseVariableCsv(readFileSync(join(CSV_DIR, `${base}.csv`), 'utf-8'));
  return [...t.byIndex.entries()];
}

describe.skipIf(!SMOKE)('真实语料 CSV/*.als：合并口径的盘上自证', () => {
  it('盘上的 `.als` 份数决定字典是否变化（原生官方版 0 份 ⇒ 必须逐字不变）', async () => {
    const alsCount = readdirSync(CSV_DIR).filter((n) => /\.als$/i.test(n)).length;
    const withAls = await load();
    const csvOnly = await load(true);
    if (alsCount === 0) {
      // 没有追加名表的盘：读 `.als` 这件事**一个字节都不许动**字典（含摘要）
      expect(withAls.inputDigest).toBe(csvOnly.inputDigest);
    } else {
      expect(alsCount).toBeGreaterThan(0);
      expect(withAls.inputDigest).not.toBe(csvOnly.inputDigest);
    }
  });

  it('正自证：`TCVAR:泥酔`（TCVAR.als:76）与 `EX:Ｖ绝顶`（ex.als:2）查得到且编号正确', async () => {
    if (!hasFile('TCVAR.als') || !hasFile('ex.als')) return;
    const schema = await load();
    expect(schema.lookup('TCVAR', '泥酔')?.resolvedIndex).toBe(145);
    expect(schema.lookup('TCVAR', '泥酔')?.description).toBe('泥酔');
    expect(schema.lookup('EX', 'Ｖ绝顶')?.resolvedIndex).toBe(1);
    // 字典的表键来自文件名（`ex.als` → `EX`）；盘上没有 `NOWEX.csv`，
    // `NOWEX:具名` 经 `EX` 表命中由 sugar 侧的"同名表候选"负责（读数在那边钉）。
  });

  it('负自证（防假绿）：同一张盘**只读 csv** 时，这两个追加名必须查无', async () => {
    if (!hasFile('TCVAR.als') || !hasFile('ex.als')) return;
    const csvOnly = await load(true);
    // "查无" = 只回显、不带 description / resolvedIndex（正是 `isRecorded` 判表外的形态）
    expect(csvOnly.lookup('TCVAR', '泥酔')).toEqual({ name: 'TCVAR', index: '泥酔' });
    expect(csvOnly.lookup('EX', 'Ｖ绝顶')).toEqual({ name: 'EX', index: 'Ｖ绝顶' });
    // 主表自己的写法照旧查得到 ⇒ 查无是"缺追加表"，不是"整张表没读"
    expect(csvOnly.lookup('EX', 'Ｖ絶頂')?.resolvedIndex).toBe(1);
    expect(csvOnly.lookup('TCVAR', '烂醉')?.resolvedIndex).toBe(145);
  });

  it('不翻案：每张表里主表已定义的**每一个编号**，合并 `.als` 后名称逐字不变', async () => {
    if (!hasFile('TCVAR.als')) return;
    const merged = await load();
    const checked: string[] = [];
    for (const name of readdirSync(CSV_DIR)) {
      if (!/\.csv$/i.test(name) || /\.als$/i.test(name)) continue;
      const base = name.replace(/\.csv$/i, '');
      if (!readdirSync(CSV_DIR).some((a) => a.toLowerCase().endsWith('.als') && a.replace(/\.als$/i, '') === base)) {
        continue; // 只查"同名表并存"的那些（画蛇添足版 19 张全在这条件里）
      }
      checked.push(base.toUpperCase());
      for (const [idx, primaryName] of primaryRows(base)) {
        expect(merged.lookup(base.toUpperCase(), Number(idx))?.description, `${base}:${idx}`).toBe(
          primaryName,
        );
      }
    }
    expect(checked.length).toBeGreaterThan(0);
  });

  it('并集确实生效：`.als` 独有的名称合并后**全部**可反查编号（一个都不许漏）', async () => {
    if (!hasFile('Abl.als')) return;
    const merged = await load();
    let checkedNames = 0;
    for (const name of readdirSync(CSV_DIR)) {
      if (!/\.als$/i.test(name)) continue;
      const base = name.replace(/\.als$/i, '').toUpperCase();
      if (!hasFile(`${base}.csv`) && !hasFile(name.replace(/\.als$/i, '.csv'))) continue;
      const als = parseVariableCsv(readFileSync(join(CSV_DIR, name), 'utf-8'));
      const csv = parseVariableCsv(readFileSync(join(CSV_DIR, `${base}.csv`), 'utf-8'));
      for (const alias of als.byName.keys()) {
        if (csv.byName.has(alias)) continue; // 主表本来就有的不算"追加名"
        checkedNames++;
        expect(merged.lookup(base, alias)?.resolvedIndex, `${base}:${alias}`).toBe(
          Number(als.byName.get(alias)),
        );
      }
    }
    // 画蛇添足版实测 757 个；别的盘只多不少（少 = 合并漏了）
    expect(checkedNames).toBeGreaterThanOrEqual(757);
  });

  it('实测冲突原句：`145,烂醉`(csv) 与 `145,泥酔`(als) 并存时，编号读主表、两个名字都认', async () => {
    if (!hasFile('TCVAR.als')) return;
    const merged = await load();
    expect(merged.lookup('TCVAR', 145)?.description).toBe('烂醉'); // 主表胜出
    expect(merged.lookup('TCVAR', '烂醉')?.resolvedIndex).toBe(145); // 原名仍认
    expect(merged.lookup('TCVAR', '泥酔')?.resolvedIndex).toBe(145); // 追加名也认
  });
});
