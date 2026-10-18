/**
 * CHARA CSV / 口上目录名解析（eraAkumaMaid 实测格式）。
 *
 * 本模块是 eratw-adapter 同名模块的**薄改造**：eraAkumaMaid 的 CHARA CSV 与
 * eraTW 逐字同构（实测 `CSV/CHARA/CHARA{0,1,100}.csv`，UTF-8-BOM、CRLF）：
 * ```
 * 番号,0,
 * 名前,あなた,
 * 呼び名,あなた,
 * CSTR,ふりがな,あなた,
 * ```
 * ⇒ `parseCharaCsv` 的宽容策略（关键字集合、找不到按 null、绝不猜测）原样保留。
 *
 * 与 eraTW 的差异只在「命名体系」，共两处：
 * 1. **口上角色目录编号是 1–3 位数字**（eraTW 固定三位）：实测
 *    `00 あなた`(0) / `01 フェリシエル`(1) / `100 パトラ`(100)。
 *    正则与 eraTW 同为 `\d{1,3}`，但 eraTW 的头注写"固定三位"是以实测
 *    155 目录全三位为前提；AM 有 1/2 位，注释口径据此改正。
 *    实测坑：目录 `67` / `68` **只有数字、无空格与名称**（不匹配本约定，
 *    返回 null），由调用方按目录内 `EVENT_K67*.ERB` 文件名反推编号兜底。
 * 2. **文件名反推改扫 `^EVENT_K(\d+)`**（eraTW 是 `^M_KOJO_K(\d+)`）：
 *    eraTW 是中缀式 `M_KOJO_K{n}_{家族}`，AM 是后缀式 `{家族}_K{n}`，
 *    角色主文件即 `EVENT_K{n}.ERB`（= eratw 的 `M_KOJO_K{n}.ERB` 等价物）。
 *    - **去掉了 eraTW 的 `(?!\[)` 占位排除**：eraTW 4.842 有
 *      `M_KOJO_K1[]_…` 这类 dummy 编号占位文件名，而 AM 实测 76 个口上
 *      目录、全部文件 0 处 `EVENT_K{n}[` 形态 ⇒ 无此坑，不保留死逻辑。
 *    - 根层共享文件天然不误伤：`EVENT_K.ERB` / `EVENT_K_COMM.ERB` 的
 *      `EVENT_K` 后紧跟非数字（`.` / `_`），`\d+` 不匹配 ⇒ 不计入。
 *    - 实测坑：共享目录 `汎用喘ぎ`（内为 `PANT.ERB` 等）同样不匹配任何
 *      `EVENT_K{n}` 文件名 ⇒ 反推返回 null，由调用方跳过（绑定角色是
 *      调用方策略，本函数只管把「名字/编号」解析对）。
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

    // AM 原版是日文关键字；中文变体集合是给汉化版/作者的容错（照 eratw 口径）
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
    // 早期文件在 `名前` 之前只有 `番号`；三样都齐了不必再扫（但文件不大，扫完无妨）
    if (result.no !== null && result.name !== null && result.callName !== null) break;
  }
  return result;
}

/**
 * 从文件名提取角色编号（`CHARA100.csv` → 100）。
 * 文件名前缀是已实测的强特征（`CSV/CHARA/CHARA{no}.csv`，与 `番号` 行严格对应）。
 */
export function parseCharaNoFromFileName(fileName: string, pattern: RegExp): number | null {
  const m = pattern.exec(fileName);
  if (!m) return null;
  const v = Number.parseInt(m[1] ?? '', 10);
  return Number.isFinite(v) ? v : null;
}

/**
 * 从個人口上角色目录名提取编号与目录显示名：
 * `01 フェリシエル` → { no: 1, label: 'フェリシエル' }
 * 约定：**1–3 位编号 + 空白 + 名称**（eraTW 是固定三位；AM 实测有 1/2 位，
 * 如 `00 あなた` / `100 パトラ`）。解析失败返回 null 而非猜测——实测目录
 * `67` / `68` 只有数字无名称即走此路，由调用方用文件名反推兜底。
 */
export function parseKojoDirName(dirName: string): { no: number; label: string } | null {
  const m = /^(\d{1,3})\s+(.+)$/.exec(dirName.trim());
  if (!m) return null;
  const no = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(no)) return null;
  return { no, label: m[2]!.trim() };
}

/**
 * 从一组文件名反推角色编号：扫 `^EVENT_K(\d+)`（忽略大小写，与引擎
 * `EVENT_K.ERB` 路由的 `EVENT_K{NO:TARGET}_…` 同口径）。
 * AM 实测无 eraTW 的 `K{n}[]` dummy 占位文件名形态（76 目录 0 命中），
 * 故不设 `(?!\[)` 排除；根层共享文件（`EVENT_K.ERB` 等）`EVENT_K` 后
 * 紧跟非数字，天然不匹配，不会把共享文件算成角色编号。
 *
 * 纯角色名目录（目录名不带编号）时编号只在目录内文件名里——这是回退绑定的
 * 依据。多个不同编号取**出现次数最多**者（并列取最小）；一个都没有返回 null。
 */
export function deriveCharaNoFromFileNames(names: readonly string[]): number | null {
  const counts = new Map<number, number>();
  for (const name of names) {
    const m = /^EVENT_K(\d+)/i.exec(name);
    if (!m) continue;
    const no = Number.parseInt(m[1] ?? '', 10);
    if (!Number.isFinite(no)) continue;
    counts.set(no, (counts.get(no) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = -1;
  for (const [no, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && no < best)) {
      best = no;
      bestCount = count;
    }
  }
  return best;
}
