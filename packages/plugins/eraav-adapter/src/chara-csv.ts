/**
 * eraAV 的 Chara CSV / 口上文件名解析。
 *
 * CSV 形态（实测 `CSV/Chara/Chara01_宮間かなで.csv`，UTF-8-BOM + CRLF）：
 * ```
 * 番号,1,,
 * 名前,宫间奏美,,
 * 呼び名,奏美,,
 * あだ名,深山奏美,,
 * ```
 * 与 eraTW / eraFL / era紅魔館 / eraSQC 同构，故解析策略照它们：**关键字集合宽容、
 * 找不到按 null 返回、绝不猜测**（汉化版把关键字译成中文也能认）。
 *
 * 本作的差异全部由真盘决定（`C:/game/eraAV`，2026-10-26 全量 120 份 CSV 实测；
 * 路径与正则一律取 `constants.ts`，此处不另定）：
 * 1. **文件名里的号可带零填充**（`Chara01` → 1），号段稀疏（0–240）；
 * 2. **名称段是日文、`名前` 行是中文**，两者不必一致（`Chara01_宮間かなで.csv` 的
 *    `名前` 是 `宫间奏美`，同名的 `Chara91_宮間かなで.csv` 却是 `宫间香奈`）⇒
 *    本模块两条都给、由调用方裁决取哪条，**绝不拿名称当身份**：同一角色可占多个号
 *    （`宮間かなで` 01/91、`春風南` 70/76、`神園すみれ` 71/77），重号与同名都不合并；
 * 3. **名称段一律当自由文本**：`Chara207_両島みちる..csv`（段尾双点）、
 *    `Chara51_【求人広告】.csv` / `Chara92_アンドロイド.csv` / `Chara180_元カノ.csv`
 *    这类非人物条目照样解析 ⇒ 取段后只剥掉**尾部的孤立句点与空白**（文件名写法残留），
 *    内部字符（`・`、`【】`、全角）原样保留；`Chara0.csv` 是盘上唯一无名段；
 * 4. **BOM 不是全员都有**（113/120 带，`Chara70`–`Chara75` 与 `Chara78` 共 7 份不带），
 *    另有 4 份（`Chara98`/`211`/`214`/`215`）在 `番号` 之前先写一条 `;` 注释行 ⇒
 *    解析逐行扫、只认行首键名，**不假设 `番号` 在第 1 行**；换行则齐整：120/120 纯 CRLF。
 *
 * 口上侧与 eraTW / eratohoK 根本不同：**没有角色目录**，`ERB/Lines/` 是 17 份扁平
 * `EVENT_K{零填充}_{角色名}.ERB` ⇒ 本模块只提供 `parseKojoFileName`（文件名那一层），
 * 不设 `parseKojoDirName`。文件名里的号**不参与函数路由**（实测 `EVENT_K01` 里定义的是
 * `KOJO_MESSAGE_COM_1`），函数名归属与家族解析归同包 `family-index.ts`，此处不越界。
 */

import { basename, extname, isErbBodyPath } from '@kojo/plugin-api';
import { ERAAV } from './constants';

export interface ParsedCharaCsv {
  /** 角色编号（来自 `番号` 行；缺失时为 null，由调用方用文件名回退） */
  no: number | null;
  /** 显示名（来自 `名前` 行；汉化版这里是**中文**，与文件名里的日文名称段不必一致） */
  name: string | null;
  /** 呼び名（来自 `呼び名` 行；实测存在空值条目，如 `Chara51_【求人広告】.csv` ⇒ null） */
  callName: string | null;
}

const NO_KEYS = new Set(['番号', '编号', '编号no', 'no']);
const NAME_KEYS = new Set(['名前', '姓名', '名字', 'なまえ']);
const CALL_KEYS = new Set(['呼び名', '称呼', '别名', '呼びな']);

/** 解析 Chara CSV 文本（宽容：找不到的行按 null 返回，绝不猜测） */
export function parseCharaCsv(text: string): ParsedCharaCsv {
  const result: ParsedCharaCsv = { no: null, name: null, callName: null };
  // BOM 显式剥掉：真盘 113/120 带 BOM、7 份不带，两种都要过；
  // 且 `trim()` 在多数引擎里把 \uFEFF 当空白，但依赖这一点太隐晦
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
 * 从 CSV 文件名提取角色编号（`Chara01_宮間かなで.csv` → 1）。
 * 零填充只是盘上写法，号段本身按 `\d+` 收（`constants.ts` 的 `charaCsvPattern`）；
 * 非 `Chara{数字}…csv` 形态（`Train.csv`、`VariableSize.CSV`、`Chara１０_…csv` 全角数字）
 * 一律 null，不猜。
 */
export function parseCharaNoFromFileName(fileName: string): number | null {
  const m = ERAAV.charaCsvPattern.exec(basename(fileName));
  if (!m) return null;
  const v = Number.parseInt(m[1] ?? '', 10);
  return Number.isFinite(v) ? v : null;
}

/**
 * 从 CSV 文件名取出名称段（`Chara01_宮間かなで.csv` → `宮間かなで`）。
 *
 * 名称段是**自由文本**（见文件头第 3 条）：`両島みちる..csv` 只剥尾点、`【求人広告】`
 * 原样保留。`Chara0.csv`（盘上唯一无名段）与非角色文件名返回 null，
 * 由调用方再退到 `Chara{no}`。**注意**：这一段是日文，不等于 `名前` 行的中文显示名，
 * 也不保证唯一（01 与 91 同名）⇒ 不得作为条目身份。
 */
export function charaNameFromFileName(fileName: string): string | null {
  const name = basename(fileName);
  if (!ERAAV.charaCsvPattern.test(name)) return null;
  const ext = extname(name);
  const stem = ext.length > 0 ? name.slice(0, name.length - ext.length) : name;
  const m = /^chara\d+(?:_(.*))?$/i.exec(stem);
  // 尾部的孤立句点/空白是文件名写法残留（实测 `Chara207_両島みちる..csv`）；内部字符不动
  const seg = (m?.[1] ?? '').trim().replace(/\.+$/, '').trim();
  return seg.length > 0 ? seg : null;
}

/**
 * 从口上**文件名**（本作无角色目录）提取编号与显示名：
 * `EVENT_K01_宮間かなで.ERB` → { no: 1, label: '宮間かなで' }
 *
 * 大小写不敏感（盘上另有 5 份小写 `.erb`），扩展名先过契约层的正文谓词
 * （`isErbBodyPath`），于是 `ERB/Lines` 里那份 `想达成调教结束后表白效果.txt`、
 * 以及主路由 `EVENT_K.ERB`（无名称段）都不会被当成口上条目。
 * 解析失败返回 null 而非猜测——**这里的号只是文件名标记，不参与函数路由**。
 */
export function parseKojoFileName(fileName: string): { no: number; label: string } | null {
  const name = basename(fileName);
  if (!isErbBodyPath(name)) return null;
  // 词干（去扩展名）才进 `kojoFilePattern`：扩展名口径归 `isErbBodyPath` 那一处真源
  const m = ERAAV.kojoFilePattern.exec(name.slice(0, name.length - extname(name).length));
  if (!m) return null;
  const no = Number.parseInt(m[1] ?? '', 10);
  if (!Number.isFinite(no)) return null;
  const label = (m[2] ?? '').trim();
  return label.length > 0 ? { no, label } : null;
}
