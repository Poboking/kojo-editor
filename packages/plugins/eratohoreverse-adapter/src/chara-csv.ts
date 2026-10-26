/**
 * eratohoReverse 的 Chara CSV / 口上目录名解析。
 *
 * CSV 形态（实测 `C:/game/eratohoReverse/CSV/CHARA/Chara1_霊夢.csv`，
 * UTF-8 BOM + 纯 LF——本作全树 CRLF 0 份，换行一律 `\r?\n` 兼容，绝不许按 CRLF 假定）：
 * ```
 * [BOM]␣
 * ;角色番号(NO)
 * 番号,1
 * ␣
 * ;名前(NAME), 呼び名(CALLNAME)
 * 名前,霊夢
 * 呼び名,霊夢
 * ```
 * 键名与 eraTW / eratohoK 同拼写（`番号` / `名前` / `呼び名`，数据行**无尾随逗号**）；
 * 头注是中文（`;角色番号(NO)`）与日文数据键混排（机翻盘），`;` 注释行的键段带 `;`
 * 前缀、落单空格行 trim 后为空，天然不命中关键字集，无需特判。
 * 实测 108 份 CSV：`番号` 值与文件名编号**逐份一致（0 份失配）**，号 **0–107 全连续**
 * （并非「0–240 稀疏」——2026-10-26 复核修正）；名称段是自由文本且**可能是中文**
 * （`Chara0_あなた.csv` 的 `名前` 为 `您`，`Chara100_ネムノ.csv` 为 `合欢`），不做语言校验。
 *
 * 口上目录（实测 `ERB/口上/` 共 27 个条目 = 25 个角色目录 + 根层 2 份公共 ERB）：
 * 形态 `0001_霊夢` … `0079_神子`——**四位零补齐 + 下划线**，号稀疏、无玩家目录。
 * 与 eratohoK 的「数字+空格」分隔不同（hok 口径在本作实测 0/25 命中）；
 * 「四位零补齐 + 下划线」这条判据**只写在 `ERATOHOREVERSE.kojoDirPattern` 一处**，
 * 本函数不再叠第二道闸（两处判据迟早会漂）。
 * 本作目录名**没有** `口上` 尾缀可剥，不照抄 hok 的剥尾逻辑。
 * 干扰树（`口上テンプレ/modern/ERB/口上/キャラ番号_キャラ名/`、模板占位函数 `KX2`）
 * 与根层 `EVENT_K.ERB` / `KOJO_PROFILE.ERB` 一律解析为 null；目录遍历归 plugin.ts，
 * 本模块只吃「目录名 / 文件名」字符串。函数名角色号分析归同包 `family-index.ts`，此处不提供。
 */

import { ERATOHOREVERSE } from './constants';

export interface ParsedCharaCsv {
  /** 角色编号（来自 `番号` 行；缺失时为 null，由调用方用文件名回退。0 是合法值） */
  no: number | null;
  /** 显示名（来自 `名前` 行） */
  name: string | null;
  /** 呼び名（来自 `呼び名` 行） */
  callName: string | null;
}

const NO_KEYS = new Set(['番号', '编号', '编号no', 'no']);
const NAME_KEYS = new Set(['名前', '姓名', '名字', 'なまえ']);
const CALL_KEYS = new Set(['呼び名', '称呼', '别名', '呼びな']);

/** 解析 Chara CSV 文本（宽容：找不到的行按 null 返回，绝不猜测；`;` 注释行天然不命中键集） */
export function parseCharaCsv(text: string): ParsedCharaCsv {
  const result: ParsedCharaCsv = { no: null, name: null, callName: null };
  // BOM 显式剥掉：`trim()` 在多数引擎里也把 \uFEFF 当空白，但依赖这一点太隐晦。
  // 换行必须 `\r?\n`：本作实测 100% 纯 LF，任何 CRLF 假定都是错的；兼容外来文本仅靠这写法。
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

/** 从文件名提取角色编号（`Chara100_ネムノ.csv` → 100；hok 的空格形态文件名不认） */
export function parseCharaNoFromFileName(fileName: string): number | null {
  const m = ERATOHOREVERSE.charaCsvPattern.exec(fileName.trim());
  if (!m) return null;
  const v = Number.parseInt(m[1] ?? '', 10);
  return Number.isFinite(v) ? v : null;
}

/**
 * 从 CSV 文件名取出名称段（`Chara1_霊夢.csv` → `霊夢`）。
 * 分隔符**只认下划线**（实测 108/108 皆 `Chara{no}_{名前}.csv`）；
 * 取不到返回 null，由调用方再退 `Chara{no}`。名称段内部可再含下划线，全归名称。
 */
export function charaNameFromFileName(fileName: string): string | null {
  const stem = fileName.trim().replace(/\.csv$/i, '');
  const m = /^chara\d+_(.+)$/i.exec(stem);
  const name = (m?.[1] ?? '').trim();
  return name.length > 0 ? name : null;
}

/**
 * 从口上角色目录名提取编号与显示名：
 * `0001_霊夢` → { no: 1, label: '霊夢' }；`0079_神子` → { no: 79, label: '神子' }
 *
 * 判据（四位零补齐 + 下划线，实测 25/25）全在 `ERATOHOREVERSE.kojoDirPattern` 里，
 * 本函数只负责「取不到就返回 null，不猜」——根层的 `EVENT_K.ERB` / `KOJO_PROFILE.ERB`
 * 与模板占位目录（`キャラ番号_キャラ名`、`KX2`）都不该被当成角色。
 */
export function parseKojoDirName(dirName: string): { no: number; label: string } | null {
  const m = ERATOHOREVERSE.kojoDirPattern.exec(dirName.trim());
  if (!m) return null;
  const label = (m[2] ?? '').trim();
  if (label.length === 0) return null;
  const no = Number.parseInt(m[1] ?? '', 10);
  return Number.isFinite(no) ? { no, label } : null;
}
