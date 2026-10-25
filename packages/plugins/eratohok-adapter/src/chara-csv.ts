/**
 * eratohoK 的 Chara CSV / 口上目录名解析。
 *
 * CSV 形态（实测 `CSV/Chara/Chara1 霊夢.csv`，UTF-8-BOM + CRLF）：
 * ```
 * 番号,1
 * 名前,霊夢
 * 呼び名,霊夢
 * CSTR,0,博麗
 * ```
 * 与 eraTW / eraFL / era紅魔館 同构，故解析策略照它们：**关键字集合宽容、
 * 找不到按 null 返回、绝不猜测**（汉化版把关键字译成中文也能认）。
 *
 * 与 era紅魔館 的差异全部由真盘决定：
 * 1. 文件名是 `Chara{no} {名前}.csv`（编号后有**空格 + 名称**）⇒ 名称缺失时可退回
 *    文件名里的名称段，再退 `Chara{no}`；
 * 2. 口上目录是 `{编号} {名称}`（空格分隔，非下划线），名称常以 `口上` 收尾 ⇒
 *    显示名剥掉尾部 `口上`，但**不剥编号**；`1204 ランダムキャラ武官` 这类无后缀目录照常解析。
 */

import { ERATOHOK } from './constants';

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

/** 从文件名提取角色编号（`Chara10 美鈴.csv` → 10） */
export function parseCharaNoFromFileName(fileName: string, pattern: RegExp): number | null {
  const m = pattern.exec(fileName);
  if (!m) return null;
  const v = Number.parseInt(m[1] ?? '', 10);
  return Number.isFinite(v) ? v : null;
}

/**
 * 从 CSV 文件名取出名称段（`Chara10 美鈴.csv` → `美鈴`）。
 * 取不到返回 null，由调用方再退到 `Chara{no}`。
 */
export function charaNameFromFileName(fileName: string): string | null {
  const stem = fileName.replace(/\.csv$/i, '');
  const m = /^chara\d+[\s　_]+(.*)$/i.exec(stem);
  const name = (m?.[1] ?? '').trim();
  return name.length > 0 ? name : null;
}

/**
 * 从口上角色目录名提取编号与显示名：
 * `01 霊夢口上` → { no: 1, label: '霊夢' }
 * `1204 ランダムキャラ武官` → { no: 1204, label: 'ランダムキャラ武官' }
 *
 * 约定：**数字 + 空格 + 名称**；名称尾部的 `口上` 只是目录命名习惯，剥掉后才是角色名。
 * 解析失败返回 null 而非猜测——口上根上的公共文件不该被当成角色目录。
 */
export function parseKojoDirName(dirName: string): { no: number; label: string } | null {
  const m = ERATOHOK.kojoDirPattern.exec(dirName.trim());
  if (!m) return null;
  const no = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(no)) return null;
  const label = m[2]!.trim().replace(/口上$/, '').trim();
  return { no, label: label.length > 0 ? label : m[2]!.trim() };
}

/**
 * 口上**函数名**里的角色号（`_K{n}`）。
 * 与目录名解析分开：函数名只认 `_K{数字}`，日文全角数字不认。
 */
export function characterNoOfFunction(fnName: string): number | null {
  const m = ERATOHOK.charaAnchor.exec(fnName);
  if (!m) return null;
  const v = Number.parseInt(m[1]!, 10);
  return Number.isFinite(v) ? v : null;
}
