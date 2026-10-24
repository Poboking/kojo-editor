/**
 * eraFL 的 Chara CSV / 口上目录名解析。
 *
 * CSV 形态（实测 `CSV/Chara/Chara10_ティア.csv`，UTF-8-BOM + CRLF）：
 * ```
 * 番号,10,
 * 名前,蒂亚,
 * 呼び名,蒂亚,
 * CSTR,0,读音,
 * ```
 * 与 eraTW / eraAkumaMaid 同构，故解析策略照抄它们：**关键字集合宽容、
 * 找不到按 null 返回、绝不猜测**（汉化版把关键字译成中文也能认）。
 *
 * 与那两个游戏的两处差异（都是 eraFL 实测形态，规则不可照搬）：
 * 1. **目录名用下划线分隔**：`{编号}_{名称}`（eraTW / eraAkumaMaid 是空格）。
 *    编号 1–4 位；名称段可含下划线 ⇒ 只切第一个下划线。
 * 2. **CSV 文件名编号后可能是下划线也可能是空格**（`Chara10_ティア.csv` /
 *    `Chara0 あなた.csv`），且存在小写开头（`chara25_リナ.csv`）⇒ 匹配大小写不敏感、
 *    编号后不强制分隔符。
 */

import { ERAFL } from './constants';

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
 * 从文件名提取角色编号（`Chara10_ティア.csv` → 10）。
 * 文件名前缀是已实测的强特征（`CSV/Chara/Chara{no}[_ ]{名}.csv`）。
 */
export function parseCharaNoFromFileName(fileName: string, pattern: RegExp): number | null {
  const m = pattern.exec(fileName);
  if (!m) return null;
  const v = Number.parseInt(m[1] ?? '', 10);
  return Number.isFinite(v) ? v : null;
}

/**
 * 从 CSV 文件名取出名称段（`Chara10_ティア.csv` → `ティア`）。
 *
 * 用途：`名前` 行缺失时的**显式回退**（绝不静默丢弃角色）。取不到返回 null，
 * 由调用方再退到 `Chara{no}`。
 */
export function charaNameFromFileName(fileName: string): string | null {
  const stem = fileName.replace(/\.csv$/i, '');
  const m = /^chara\d+[_ ]*(.*)$/i.exec(stem);
  const name = (m?.[1] ?? '').trim();
  return name.length > 0 ? name : null;
}

/**
 * 从口上角色目录名提取编号与显示名：
 * `1099_うふふお姉さん` → { no: 1099, label: 'うふふお姉さん' }
 * `5192_主人公口上_汎用_流され人妻` → { no: 5192, label: '主人公口上_汎用_流され人妻' }
 *
 * 约定：**数字 + 下划线 + 名称**。解析失败返回 null 而非猜测——`ERB/口上` 根上
 * 还散着 `_KOJO_SYSTEM.ERB` 等公共文件，它们不该被当成角色目录。
 */
export function parseKojoDirName(dirName: string): { no: number; label: string } | null {
  const m = ERAFL.kojoDirPattern.exec(dirName.trim());
  if (!m) return null;
  const no = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(no)) return null;
  return { no, label: m[2]!.trim() };
}
