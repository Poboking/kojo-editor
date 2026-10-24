/**
 * era紅魔館 的 Chara CSV / 口上目录名解析。
 *
 * CSV 形态（实测 `CSV/Chara1.csv`，UTF-8-BOM + LF）：
 * ```
 * 番号,1,
 * 名前,红美铃,
 * 呼び名,美铃,
 * 基礎,0,2500
 * ```
 * 与 eraTW / eraFL / eraAkumaMaid 同构，故解析策略照它们：**关键字集合宽容、
 * 找不到按 null 返回、绝不猜测**（汉化版把关键字译成中文也能认）。
 *
 * 与 eraFL 的差异只有两点（都由真盘决定）：
 * 1. 文件名是 `Chara{no}.csv`，编号后**没有**名称段 ⇒ 名称缺失时回退 `Chara{no}`
 *    （eraFL 能退回文件名里的名称段）。
 * 2. 口上目录仍是 `{编号}_{名称}`；另有 `U_汎用` 无编号目录（泛用口上）⇒
 *    解析失败返回 null 而非猜编号。
 */

import { ERAKOUMAKAN } from './constants';

export interface ParsedCharaCsv {
  /** 角色编号（来自 `番号` 行；缺失时为 null，由调用方用文件名回退） */
  no: number | null;
  /** 显示名（来自 `名前` 行） */
  name: string | null;
  /** 呼び名（来自 `呼び名` 行） */
  callName: string | null;
}

const NO_KEYS = new Set(['番号', '编号', '编号no', 'no']);
const NAME_KEYS = new Set(['名前', '姓名', '名字', 'なまえ']);
const CALL_KEYS = new Set(['呼び名', '称呼', '别名', '呼びな']);

/** 解析 Chara CSV 文本（宽容：找不到的行按 null 返回，绝不猜测） */
export function parseCharaCsv(text: string): ParsedCharaCsv {
  const result: ParsedCharaCsv = { no: null, name: null, callName: null };
  // BOM 显式剥掉：`trim()` 在多数引擎里也把 \uFEFF 当空白，但依赖这一点太隐晦
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (t.length === 0) continue;
    const fields = t.split(',');
    const key = (fields[0] ?? '').trim();
    if (!key) continue;

    if (result.no === null && (NO_KEYS.has(key) || key.toLowerCase() === 'no')) {
      const v = Number.parseInt((fields[1] ?? '').trim(), 10);
      if (Number.isFinite(v)) result.no = v;
      continue;
    }
    if (result.name === null && NAME_KEYS.has(key)) {
      const v = (fields[1] ?? '').trim();
      if (v.length > 0) result.name = v;
      continue;
    }
    if (result.callName === null && CALL_KEYS.has(key)) {
      const v = (fields[1] ?? '').trim();
      if (v.length > 0) result.callName = v;
      continue;
    }
    if (result.no !== null && result.name !== null && result.callName !== null) break;
  }
  return result;
}

/**
 * 从文件名提取角色编号（`Chara10.csv` → 10）。
 * 文件名前缀是已实测的强特征（`CSV/Chara{no}.csv`）。
 */
export function parseCharaNoFromFileName(fileName: string, pattern: RegExp): number | null {
  const m = pattern.exec(fileName);
  if (!m) return null;
  const v = Number.parseInt(m[1] ?? '', 10);
  return Number.isFinite(v) ? v : null;
}

/**
 * 从 CSV 文件名取出名称段（`Chara10_魔理沙.csv` → `魔理沙`）。
 *
 * 本作真盘是纯 `Chara{no}.csv`（没有名称段）⇒ 实测恒为 null；保留这条回退是给
 * 将来把名称写进文件名的魔改版兜底。取不到返回 null，由调用方再退到 `Chara{no}`。
 */
export function charaNameFromFileName(fileName: string): string | null {
  const stem = fileName.replace(/\.csv$/i, '');
  const m = /^chara\d+[_ ]*(.*)$/i.exec(stem);
  const name = (m?.[1] ?? '').trim();
  return name.length > 0 ? name : null;
}

/**
 * 从口上角色目录名提取编号与显示名：
 * `4_咲夜` → { no: 4, label: '咲夜' }
 * `10_魔理沙` → { no: 10, label: '魔理沙' }
 *
 * 约定：**数字 + 下划线 + 名称**。解析失败返回 null 而非猜测——`U_汎用`（泛用口上）
 * 与口上根上的公共文件都不该被当成角色目录。
 */
export function parseKojoDirName(dirName: string): { no: number; label: string } | null {
  const m = ERAKOUMAKAN.kojoDirPattern.exec(dirName.trim());
  if (!m) return null;
  const no = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(no)) return null;
  return { no, label: m[2]!.trim() };
}
