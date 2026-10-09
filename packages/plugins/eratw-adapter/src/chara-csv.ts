/**
 * CHARA CSV 解析（eraTW 4.980 实测格式）。
 *
 * 实测样本（UTF-8-BOM，汉化版；日文原版为 Shift-JIS，关键字相同）：
 * ```
 * 番号,1,
 * 名前,博丽 灵梦,
 * 呼び名,灵梦,
 * 基礎,体力,2000
 * 素質,処女,1
 * …
 * ```
 * 关键字为日文（汉化版保留关键字、翻译取值）；同时兼容少量中文关键字变体。
 */

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

/** 解析 CHARA CSV 文本（宽容：找不到的行按 null 返回，绝不猜测） */
export function parseCharaCsv(text: string): ParsedCharaCsv {
  const result: ParsedCharaCsv = { no: null, name: null, callName: null };
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (t.length === 0) continue;
    const fields = t.split(',');
    const key = (fields[0] ?? '').trim();
    if (!key) continue;

    if (result.no === null && NO_KEYS.has(key.toLowerCase() === 'no' ? 'no' : key)) {
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
    // 早期文件在 `名前` 之前只有 `番号`；三样都齐了不必再扫（但文件不大，扫完无妨）
    if (result.no !== null && result.name !== null && result.callName !== null) break;
  }
  return result;
}

/**
 * 从文件名提取角色编号（`Chara51 にとり.CSV` → 51）。
 * 文件名前缀是已实测的强特征（与 `M_KOJO_K{no}` 编号严格对应）。
 */
export function parseCharaNoFromFileName(fileName: string, pattern: RegExp): number | null {
  const m = pattern.exec(fileName);
  if (!m) return null;
  const v = Number.parseInt(m[1] ?? '', 10);
  return Number.isFinite(v) ? v : null;
}

/**
 * 从個人口上角色目录名提取编号与目录显示名：
 * `001 Reimu [霊夢]` → { no: 1, label: 'Reimu [霊夢]' }
 * 约定：三位编号 + 空格 + 名称（实测 155 个目录全部符合，但解析失败返回 null 而非猜测）。
 */
export function parseKojoDirName(dirName: string): { no: number; label: string } | null {
  const m = /^(\d{1,3})\s+(.+)$/.exec(dirName.trim());
  if (!m) return null;
  const no = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(no)) return null;
  return { no, label: m[2]!.trim() };
}
