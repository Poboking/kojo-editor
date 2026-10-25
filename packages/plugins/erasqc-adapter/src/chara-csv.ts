/**
 * eraSQC 的 Chara CSV / 口上文件名解析。
 *
 * CSV 形态（实测 `CSV/Chara7.csv`，UTF-8-BOM + LF）：
 * ```
 * 番号,7,
 * 名前,狼女,
 * 呼び名,狼女,
 * 基礎,体力,2500
 * ```
 * 与其它 era 系适配器同构，故解析策略相同：**关键字集合宽容、找不到按 null
 * 返回、绝不猜测**（汉化版把关键字译成中文也能认）。
 *
 * 本作差异：编号可能只出现在文件名里（`番号` 行并非所有魔改版都有）⇒
 * 调用方用 `parseCharaNoFromFileName` 回退；名称缺失时回退 `Chara{no}`。
 */

import { extname, isErbBodyPath } from '@kojo/plugin-api';

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
  // BOM 显式剥掉：真盘 63 份 Chara CSV 全部 UTF-8-BOM，不剥会认不出首行 `番号`
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

/** 从文件名提取角色编号（`Chara10.csv` → 10）。 */
export function parseCharaNoFromFileName(fileName: string, pattern: RegExp): number | null {
  const m = pattern.exec(fileName);
  if (!m) return null;
  const v = Number.parseInt(m[1] ?? '', 10);
  return Number.isFinite(v) ? v : null;
}

/**
 * 从口上文件名提取角色编号与尾段（**先按契约的方言谓词确认是正文 ERB**）：
 * `EVENT_K07.ERB` → { no: 7, tail: '' }
 * `DEVENT_K25_2.ERB` → { no: 25, tail: '2' }
 * `EVENT_K12_1_43+140.ERB` → { no: 12, tail: '1_43+140' }
 *
 * 尾段只是作者标记，**不参与 CFLAG:209 口上模式的判定**（模式在函数名尾）。
 * 文件名不符合形态返回 null，不猜。
 */
export function parseKojoFileName(
  fileName: string,
  pattern: RegExp,
): { no: number; tail: string } | null {
  if (!isErbBodyPath(fileName)) return null;
  const ext = extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  const m = pattern.exec(stem.trim());
  if (!m) return null;
  const no = Number.parseInt(m[1] ?? '', 10);
  if (!Number.isFinite(no)) return null;
  const tail = (m[2] ?? '').trim();
  return { no, tail };
}

/** 解析失败时的最小显示名（与真盘 `Chara{no}.csv` 文件名同形，不编造角色名） */
export function fallbackCharaName(no: number): string {
  return `Chara${no}`;
}
