/**
 * eraFL 方言指令表（`src/instruction-table.ts`）的护栏。
 *
 * 分两层：
 * - **合成断言**（不读盘）：表形状、去重、大写归一、族覆盖、方言扩展名形状、`.ERD` 结论；
 * - **真盘守卫**（以 `D:/Game/erafl` 存在为守卫）：表里 129 条**逐条**回到语料里能命中，
 *   差集规模在量级上对得上（行首语句词 ≥200 种、`VARI` ≥1000 次）。
 *
 * 真盘用例的理由：这张表是"从语料里读出来的"，不是拍脑袋写的。语料换了 / 表被手改成
 * 凭空的词，守卫用例会先红——比"看起来有 129 条"有意义得多。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ERB_DIALECT_EXTENSIONS,
  isErbDialectPath,
  type ErbDialectExtension,
} from '@kojo/plugin-api';
import {
  ERAFL_EXTRA_DIRECTIVES,
  ERAFL_ERD_EXTENSIONS,
  createEraflErbDialectExtension,
} from '../src/instruction-table';

const GAME_ROOT = 'D:/Game/erafl';
const ERB_ROOT = join(GAME_ROOT, 'ERB');
const hasCorpus = existsSync(ERB_ROOT);

/** 表长（写死数字：表是逐条复核过的产物，增减必须同时改这里与用例期望） */
const TABLE_SIZE = 129;

/** 递归列出语料里的 `.ERB`（大小写不敏感；只读，不写盘） */
function listErbFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listErbFiles(p, out);
    else if (/\.erb$/i.test(name)) out.push(p);
  }
  return out;
}

/**
 * 语料 → 「行首大写词 → 次数」。
 *
 * 口径比 `src/instruction-table.ts` 的扫描**宽**（这里只做守卫，不做判定）：
 * 行首 token 后跟空白或行尾即计数，不区分语句位/续行/字符串。宽口径只会多算，
 * 所以"表内每词 ≥1 次"这个断言成立就足以证明词是真的。
 */
function countLineStartWords(files: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  const RE = /^[ \t]*([A-Z][A-Z0-9_]{1,})(?=[ \t]|$)/;
  for (const file of files) {
    let text = readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    for (const line of text.split(/\r\n?|\n/)) {
      const t = line.trim();
      if (t.length === 0 || t.startsWith(';') || t.startsWith('@') || t.startsWith('#')) continue;
      const m = RE.exec(line);
      const word = m?.[1];
      if (word !== undefined) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return counts;
}

describe('ERAFL_EXTRA_DIRECTIVES（差集表本体）', () => {
  it('表非空：129 条引擎侧指令（下限 120）', () => {
    expect(ERAFL_EXTRA_DIRECTIVES.length).toBe(TABLE_SIZE);
    expect(ERAFL_EXTRA_DIRECTIVES.length).toBeGreaterThanOrEqual(120);
  });

  it('去重：129 条里 129 个唯一值（大小写归一口径下）', () => {
    const upper = ERAFL_EXTRA_DIRECTIVES.map((w) => w.toUpperCase());
    expect(new Set(upper).size).toBe(TABLE_SIZE);
    expect(new Set(ERAFL_EXTRA_DIRECTIVES).size).toBe(129);
  });

  it('全大写归一：129 条全部匹配 [A-Z][A-Z0-9_]+，大写化后不变', () => {
    const bad = ERAFL_EXTRA_DIRECTIVES.filter((w) => !/^[A-Z][A-Z0-9_]+$/.test(w));
    expect(bad).toEqual([]);
    const changed = ERAFL_EXTRA_DIRECTIVES.filter((w) => w.toUpperCase() !== w);
    expect(changed.length).toBe(0);
  });

  it('频次头部 6 词在表内：VARI / VARS / DT_ROW_ADD / XML_GET / CVARSET / MAP_SET', () => {
    const head = ['VARI', 'VARS', 'DT_ROW_ADD', 'XML_GET', 'CVARSET', 'MAP_SET'];
    const hit = head.filter((w) => ERAFL_EXTRA_DIRECTIVES.includes(w));
    expect(hit.length).toBe(6);
  });

  it('族覆盖：DT_ 12 条、XML_ 9 条、MAP_ 9 条（引擎的四块新能力各成族）', () => {
    const count = (prefix: string) => ERAFL_EXTRA_DIRECTIVES.filter((w) => w.startsWith(prefix)).length;
    expect(count('DT_')).toBe(12);
    expect(count('XML_')).toBe(9);
    expect(count('MAP_')).toBe(9);
    // 三族合计 30 条，占 129 的 23%：数据表/XML/map 是本盘最重的引擎扩展
    expect(count('DT_') + count('XML_') + count('MAP_')).toBe(30);
  });

  it('不收业务函数：表内没有任何以 @ 定义过的游戏函数名（KOJO_/QST_/HO_/COM_ 0 条）', () => {
    const business = ERAFL_EXTRA_DIRECTIVES.filter((w) =>
      /^(KOJO_|QST_|HO_|COM_|CLOTH_|CREATE_MOB_)/.test(w),
    );
    expect(business).toEqual([]);
  });
});

describe('createEraflErbDialectExtension（ErbDialectExtension 形状）', () => {
  it('返回正文类扩展名 .erb：属于 3 条方言清单之一', () => {
    const ext: ErbDialectExtension = createEraflErbDialectExtension();
    expect(ext).toBe('.erb');
    expect(ERB_DIALECT_EXTENSIONS.length).toBe(3);
    expect(ERB_DIALECT_EXTENSIONS as readonly string[]).toContain(ext);
  });

  it('宿主谓词认可：.ERB / .erb 都算方言文件，返回值可直接喂给注册处', () => {
    const ext = createEraflErbDialectExtension();
    expect(isErbDialectPath(`ERB/SYSTEM/DEBUG.ERB`)).toBe(true);
    expect(isErbDialectPath(`ERB/SYSTEM/DEBUG${ext}`)).toBe(true);
    expect(ext.toLowerCase()).toBe(ext); // 小写带点，与清单元素同形
  });
});

describe('ERAFL_ERD_EXTENSIONS（.ERD 的结论）', () => {
  it('空表：0 条 —— .ERD 是 CSV 数据表，不进语言面', () => {
    expect(ERAFL_ERD_EXTENSIONS.length).toBe(0);
    expect(ERAFL_ERD_EXTENSIONS).toEqual([]);
  });

  it('与方言清单交集 0：.ERD 既不在正文类也不在声明类，宿主谓词此刻仍判否', () => {
    const overlap = ERAFL_ERD_EXTENSIONS.filter((e) =>
      (ERB_DIALECT_EXTENSIONS as readonly string[]).includes(e),
    );
    expect(overlap.length).toBe(0);
    expect(isErbDialectPath('ERB/EQUIP/CC_TARGETING.ERD')).toBe(false);
  });
});

describe.skipIf(!hasCorpus)('真盘守卫（D:/Game/erafl 存在时）', () => {
  it('表内 129 条逐条回语料命中：129/129 都有行首出现', () => {
    const files = listErbFiles(ERB_ROOT);
    expect(files.length).toBeGreaterThanOrEqual(2000); // 实测 2,016 份
    const counts = countLineStartWords(files);
    const missed = ERAFL_EXTRA_DIRECTIVES.filter((w) => (counts.get(w) ?? 0) === 0);
    expect(missed).toEqual([]);
    expect(ERAFL_EXTRA_DIRECTIVES.length - missed.length).toBe(129);
  });

  it('差集规模量级：行首大写词 ≥200 种、VARI ≥1000 次、DT_ROW_ADD ≥1000 次', () => {
    const counts = countLineStartWords(listErbFiles(ERB_ROOT));
    expect(counts.size).toBeGreaterThanOrEqual(200);
    expect(counts.get('VARI') ?? 0).toBeGreaterThanOrEqual(1000);
    expect(counts.get('DT_ROW_ADD') ?? 0).toBeGreaterThanOrEqual(1000);
    expect(counts.get('VARS') ?? 0).toBeGreaterThanOrEqual(1000);
  });

  it('两份 .ERD 都是「编号,名称」数据表（首字段是数字）⇒ 不是脚本正文', () => {
    const erds = ['EQUIP/CC_TARGETING.ERD', 'EQUIP/EQUIP_MATERIAL_NAME_SHORT.ERD'].map((rel) =>
      join(ERB_ROOT, rel),
    );
    const existing = erds.filter((p) => existsSync(p));
    expect(existing.length).toBe(2);
    for (const p of existing) {
      let head = readFileSync(p, 'utf8');
      if (head.charCodeAt(0) === 0xfeff) head = head.slice(1);
      const firstLine = head.split(/\r\n?|\n/)[0] ?? '';
      expect(/^\d+,/.test(firstLine)).toBe(true); // 形如 `0,無作為`
      expect(head.includes('@')).toBe(false); // 零 `@` 定义
    }
  });
});
