/**
 * 跨平台路径工具（纯函数，零平台依赖）。
 * 位于 plugin-api 的原因：任何插件（如 adapter 拼接游戏目录）都需要它，
 * 而插件只允许依赖 plugin-api——公共纯工具必须住在公共包里。
 *
 * 为什么不直接用 node:path：内核与插件运行在 Node（测试）与 WebView（生产）两种环境，
 * 后者没有 node:path。这里实现"够用且行为可测"的子集，覆盖 Windows 盘符路径与
 * POSIX 路径；不做符号链接解析、不做 `C:relative` 这类罕见形态。
 */

export type PathStyle = 'win32' | 'posix';

const WIN_DRIVE = /^[A-Za-z]:[\\/]/;
const WIN_ABS_ONLY = /^[A-Za-z]:$/;

/* --------------------------- 归一化记忆（冷开热路径） --------------------------- */

/**
 * 归一化 / 折叠大小写的记忆表。`isPathUnder` 是「文件 → 范围 / 归属 / 写域」的唯一判据，
 * 一次判定归一化两侧，而调用方是「逐目录根 × 逐文件」的循环 ⇒ 同一批路径被归一化几十万次。
 * P0-2 冷开实测：`normalize` self 936ms + `isPathUnder` self 454ms（读数与归因见批 3 报告）。
 *
 * 语义不变（纯函数 + 有界记忆）；溢出整表清空，避免换项目后旧路径一直占内存。
 */
const MEMO_LIMIT = 32768;
const normMemo = new Map<string, string>();
const foldMemo = new Map<string, string>();

function memo(memoTable: Map<string, string>, p: string, compute: () => string): string {
  const hit = memoTable.get(p);
  if (hit !== undefined) return hit;
  const v = compute();
  if (memoTable.size >= MEMO_LIMIT) memoTable.clear();
  memoTable.set(p, v);
  return v;
}

/** 判定路径风格（以输入形态为准；Windows 盘符/反斜杠 → win32） */
export function pathStyle(p: string): PathStyle {
  if (WIN_DRIVE.test(p) || p.startsWith('\\\\') || WIN_ABS_ONLY.test(p)) return 'win32';
  if (p.startsWith('/')) return 'posix';
  return p.includes('\\') && !p.includes('/') ? 'win32' : 'posix';
}

export function sepOf(style: PathStyle): string {
  return style === 'win32' ? '\\' : '/';
}

export function isAbsolute(p: string): boolean {
  return WIN_DRIVE.test(p) || /^[\\/]/.test(p);
}

/** 归一化：统一分隔符、折叠 `.` 与多余分隔符、按需解析 `..`（带记忆，见上） */
export function normalize(p: string): string {
  if (p.length === 0) return '.';
  return memo(normMemo, p, () => normalizeUncached(p));
}

function normalizeUncached(p: string): string {
  const style = pathStyle(p);
  const sep = sepOf(style);
  const alt = style === 'win32' ? '/' : '\\';
  let s = p.split(alt).join(sep);

  // 剥离前缀（盘符 / 根 / UNC）
  let prefix = '';
  let rooted = false;
  if (style === 'win32') {
    if (WIN_DRIVE.test(s)) {
      const drive = s.slice(0, 2);
      const rest = s.slice(2);
      if (rest.startsWith(sep)) {
        prefix = drive + sep;
        rooted = true;
      } else {
        prefix = drive; // C:relative 形态（罕见）
        rooted = false;
      }
      s = rest;
    } else if (s.startsWith('\\\\')) {
      // UNC：\\server\share —— 保留开头双斜杠即可（罕见，不做完整语义）
      prefix = '\\\\';
      rooted = true;
      s = s.replace(/^\\+/, '');
    }
  } else if (s.startsWith(sep)) {
    prefix = sep;
    rooted = true;
    s = s.slice(1);
  }

  const parts: string[] = [];
  for (const seg of s.split(sep)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!rooted) parts.push('..');
      // 已经到根（rooted）时忽略多余的 ..（C:\.. → C:\）
      continue;
    }
    parts.push(seg);
  }

  const body = parts.join(sep);
  if (prefix === '' && body === '') return '.';
  if (body === '') return prefix;
  return prefix + body;
}

/** 拼接路径分段（不做绝对路径重置语义；空段忽略） */
export function join(...parts: string[]): string {
  const nonEmpty = parts.filter((p) => p.length > 0);
  if (nonEmpty.length === 0) return '';
  const style = pathStyle(nonEmpty[0]!);
  const sep = sepOf(style);
  return normalize(nonEmpty.join(sep));
}

export function dirname(p: string): string {
  const style = pathStyle(p);
  const sep = sepOf(style);
  const n = normalize(p);
  const idx = n.lastIndexOf(sep);
  if (idx < 0) return '.';
  const head = n.slice(0, idx);
  if (head === '') return sep;
  if (style === 'win32' && WIN_ABS_ONLY.test(head)) return head + sep;
  return head;
}

export function basename(p: string): string {
  const style = pathStyle(p);
  const sep = sepOf(style);
  const n = normalize(p);
  const idx = n.lastIndexOf(sep);
  return idx < 0 ? n : n.slice(idx + 1);
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i);
}

/** 归一化 + 折叠大小写（判等用的形态；带记忆——热路径上同一路径会被问几十万次） */
function foldedPath(p: string): string {
  return memo(foldMemo, p, () => normalize(p).toLowerCase());
}

/** 折叠形态下的包含判定（`isPathUnder` / `probeContains` 的唯一实现体） */
function containsFolded(a: string, b: string, style: PathStyle): boolean {
  if (a === b) return true;
  const sep = sepOf(style);
  const withSep = a.endsWith(sep) ? a : a + sep;
  return b.startsWith(withSep);
}

/**
 * 判据的**预折叠**形态（`pathProbe` + `probeContains`）：根折一遍、路径折一遍，之后每次判定
 * 只剩两次前缀比较。答案与 `isPathUnder` 逐字相同（`paths.test.ts` 有对拍用例）——判据仍只有
 * 一条，这里只是它的事前形态。
 */
export interface PathProbe {
  /** 折叠后的判等形态（win32 已小写；**空串 = 入参为空** ⇒ 不包含任何路径） */
  readonly key: string;
  /** 分隔符风格（取自入参本身，与 `isPathUnder` 取 parent 风格的口径一致） */
  readonly style: PathStyle;
}

/** 把一条路径折成判等形态（同一路径重复调用只花一次 `Map.get`） */
export function pathProbe(p: string): PathProbe {
  if (p.length === 0) return { key: '', style: 'posix' };
  const style = pathStyle(p);
  return { key: style === 'win32' ? foldedPath(p) : normalize(p), style };
}

/** `child` 是否在 `root` 之下（含相等）——与 `isPathUnder(root, child)` 同答案 */
export function probeContains(root: PathProbe, child: PathProbe): boolean {
  if (root.key === '') return false;
  return containsFolded(root.key, child.key, root.style);
}

/**
 * child 是否位于 parent 之下（含相等）。
 * Windows 路径大小写不敏感；两侧均先归一化。
 *
 * 形态走记忆（`normalize` / `foldedPath`）：判据本身逐字未变，只是不再重复归一化同一份路径。
 */
export function isPathUnder(parent: string, child: string): boolean {
  if (parent.length === 0) return false;
  const style = pathStyle(parent);
  const fold = style === 'win32';
  const a = fold ? foldedPath(parent) : normalize(parent);
  const b = fold ? foldedPath(child) : normalize(child);
  return containsFolded(a, b, style);
}

/** 用于 Map 键的统一形态（Windows 折叠大小写，避免同一路径两种写法重复缓存） */
export function pathKey(p: string): string {
  const n = normalize(p);
  return pathStyle(n) === 'win32' ? foldedPath(p) : n;
}

/**
 * 该文件是否**只属于只读基座库**（语言服务索引面，不属于作者可见/可写范围）。
 *
 * 基座根与口上根可能嵌套（基座 = 整棵 ERB，口上 = 其中某个子树）：落在基座内、
 * 同时又落在任一 `kojoPaths` 内的文件**仍算作者范围**；两者都不落 ⇒ false。
 * 作者工作区根不在游戏目录内（属常见形态），故不在此判据里叠加。
 *
 * 结构参数（不 import `GameProject`）只为让契约层与纯路径工具保持零运行期耦合。
 */
export function isLibraryOnlyPath(
  project: { readonly kojoPaths: readonly string[]; readonly libraryPaths?: readonly string[] } | null | undefined,
  path: string,
): boolean {
  const libs = project?.libraryPaths ?? [];
  if (libs.length === 0) return false;
  if (!libs.some((root) => isPathUnder(root, path))) return false;
  return !project!.kojoPaths.some((root) => isPathUnder(root, path));
}

/**
 * 路径短显示（面板行内的定位文本用）：取**末两段**并以 `/` 连接。
 *
 * 判据口径：分隔符按 `[\\/]` 两者都切（输入可能是 Windows 原样路径，也可能是
 * 归档里 POSIX 形态），输出统一 POSIX 形态——与 `basename` 的差别只在于保留
 * **父目录那一段**，够作者认出这是哪个角色/家族下的文件。
 * 纯字符串操作，不折叠 `..`、不改大小写（短显示要的是"看得懂"，不是判等）。
 *
 * 为什么住契约：同一段三行实现曾在 `ui-kojo-navigator` / `ui-state-replay` /
 * `ui-condition-matrix` / `ui-convention-report` 四个面板里逐字各抄一份（W4
 * PANEL-DEDUP 后续批收口）——上屏文本是用户可见效果，分叉一次就得四个面板逐个核对。
 */
export function shortPath(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.slice(-2).join('/');
}
