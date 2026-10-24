/**
 * 文件树的**纯模型层**（零 React、零 IO；FE-REF ⑤ 自 `FileTree.tsx` 逐字搬出）。
 *
 * 这层是"树该长什么样"的唯一口径：分组构建、条目筛选、失效重列清单、归属与取名。
 * 索引路径与冷开 walk 快照**共用同一批函数**，索引就绪切换时结构才可能逐字相同
 * （不重排 = 不抖）。全部可单测，断言见 `packages/app/tests/file-tree.test.ts`。
 */
import type { DirEntry, GameProject } from '@kojo/plugin-api';
import { isErbDialectPath } from '@kojo/plugin-api';
import { pkey } from './file-tree-ops';
import { packageKey } from './file-tree-reveal';
import type { Group, PackageGroup } from './file-tree-types';

/** 压缩包 / 图片等二进制附件：只展示不可打开（打开只会给 Monaco 喂一堆乱码） */
export const BINARY_EXT = /\.(7z|zip|rar|png|jpe?g|gif|bmp|ico|webp|mp3|ogg|wav|ttf|otf|dll|exe)$/i;

/** ERB 方言扩展名：口径直接问契约层的单一真源（`plugin-api/erb-ext`，FT-2 收口），
 *  不再靠注释与人肉对齐。嵌套目录里的方言文件走普通文件行样式，非方言才标「不在索引内」。
 *  与 erb-parser 的索引 walk 共用同一条谓词 ⇒ "标了在索引里"与"真在索引里"不可能再分裂。 */
export function erbExt(name: string): boolean {
  return isErbDialectPath(name);
}

/**
 * 真实文件夹视图某一层该显示哪些条目（纯函数，可单测）。
 *
 * `skip`（包层已平铺的 ERB 路径）**只在 depth === 0 生效**：那里与平铺列表同级，
 * 不去重就是同一层级出现两遍同一个文件。嵌套目录必须原样返回——它们住在另一层，
 * 不是重复；若一并去重，装了 10 个面文件的子目录会被渲染成空目录，
 * **等于对文件系统撒谎**（本函数就是为锁死这条不变量而存在：
 * 实现在 `灵梦-少女之梦/没写的` 上踩过一次）。
 */
export function visibleEntries(
  entries: readonly DirEntry[],
  depth: number,
  skip: ReadonlySet<string>,
): DirEntry[] {
  return depth === 0 ? entries.filter((d) => !skip.has(pkey(d.path))) : [...entries];
}

/**
 * 失效时该重列哪些目录（纯函数，可单测；HK-5）。
 *
 * = **正在显示的**：展开着的子目录 ∪ 已点开「真实文件夹视图」的包目录。
 * 折叠着的不重列——等下次展开惰性取，为看不见的东西打一圈 `listDir` 是纯浪费；
 * 展开态本身一概不动（那是作者的现场，不是缓存的一部分）。
 */
export function dirsToRelist(
  subOpen: ReadonlySet<string>,
  openPkgKeys: ReadonlySet<string>,
  packages: readonly { key: string; dir: string }[],
): string[] {
  const out = new Set<string>(subOpen);
  for (const p of packages) if (openPkgKeys.has(p.key)) out.add(p.dir);
  return [...out];
}

/** 角色目录前缀（长前缀优先，避免嵌套目录误归属） */
export function ownerOf(
  path: string,
  owners: readonly { prefix: string; label: string }[],
): { prefix: string; label: string } | undefined {
  return owners.find((o) => path.startsWith(o.prefix));
}

/** 取角色目录下的第一层子目录名（作者包目录）；直接挂根下 → null */
export function packageDirOf(path: string, prefix: string): string | null {
  const rel = path.slice(prefix.length).replace(/^[\\/]+/, '');
  const m = /[\\/]/.exec(rel);
  return m ? rel.slice(0, m.index) : null;
}

export function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/**
 * 中段省略（L16 美学短板批）：尾部 ellipsis 会把扩展名与末段语义吃掉——
 * `.ERH` / `.kojo` 这类后缀**就是信息**（`.ERH` 和 `.ERB` 是两种文件，名字头一段还常常相同）。
 * 纯函数、可单测：超长时保住后缀（最后一个 `.` 起）与头部，裁中段，省略号占一位。
 *
 * 口径：`maxChars` 是**结果串**的字符上限（含省略号）；不足 4 没有裁的意义原样返回；
 * 无扩展名（或以 `.` 开头的隐藏名）退化为保头裁尾。
 * // ui-kit-candidate: middleEllipsis 值得进 ui-kit（文件树/标签页两处要用）
 */
export function middleEllipsis(name: string, maxChars: number): string {
  if (maxChars < 4 || name.length <= maxChars) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  const keepTail = Math.min(ext.length, maxChars - 3);
  const keepHead = maxChars - 1 - keepTail;
  if (keepHead < 2) return `${name.slice(0, maxChars - 1)}…`;
  return `${name.slice(0, keepHead)}…${name.slice(name.length - keepTail)}`;
}

/** 树内文件名/包名的中段省略上限（字符数硬闸；标签页另有 `TAB_LABEL_MAX` 同值口径） */
export const TREE_LABEL_MAX = 24;

/**
 * 角色归属表（charaIndex → 目录前缀；长前缀优先，避免嵌套目录误归属）。
 * 单一来源：索引路径与冷开 walk 快照共用 —— 两边的分组结果才可能逐字一致。
 */
export function kojoOwners(project: GameProject): Array<{ prefix: string; label: string }> {
  const owners: Array<{ prefix: string; label: string }> = [];
  for (const c of project.charaIndex.values()) {
    if (c.kojoDir) owners.push({ prefix: c.kojoDir, label: `#${c.no} ${c.name}` });
  }
  owners.sort((a, b) => b.prefix.length - a.prefix.length);
  return owners;
}

/**
 * 路径清单 → 角色 / 作者包分组（纯函数，可单测）。
 *
 * **索引路径与冷开 walk 快照共用这一个构建函数**：快照期与索引期按同一口径分组，
 * 索引就绪切换时结构逐字相同 —— 不会出现"树重排"的视觉抖动。
 * 旧实现把这段逻辑内嵌在 useMemo 里并直接吃 `index.files.keys()`，无法被 walk 复用。
 */
export function buildFileGroups(
  paths: Iterable<string>,
  owners: readonly { prefix: string; label: string }[],
): Group[] {
  const map = new Map<string, { prefix: string; subs: Map<string | null, string[]> }>();
  for (const path of paths) {
    const owner = ownerOf(path, owners) ?? { prefix: '', label: '(未归属)' };
    let g = map.get(owner.label);
    if (!g) {
      g = { prefix: owner.prefix, subs: new Map() };
      map.set(owner.label, g);
    }
    const sub = owner.prefix ? packageDirOf(path, owner.prefix) : null;
    const arr = g.subs.get(sub);
    if (arr) arr.push(path);
    else g.subs.set(sub, [path]);
  }

  // 归属组按编号排（label 前缀 #n），未归属垫底；包按字典序，根散文件在前
  const sorted = [...map.entries()].sort((a, b) => {
    if (a[0] === '(未归属)') return 1;
    if (b[0] === '(未归属)') return -1;
    return parseInt(a[0].slice(1), 10) - parseInt(b[0].slice(1), 10);
  });
  return sorted.map(([label, g]) => {
    const subs: PackageGroup[] = [...g.subs.entries()]
      .sort((a, b) => {
        if (a[0] === null) return -1;
        if (b[0] === null) return 1;
        return a[0].localeCompare(b[0]);
      })
      .map(([subLabel, files]) => ({ label: subLabel, files: files.sort() }));
    return { label, prefix: g.prefix, subs, total: subs.reduce((n, s) => n + s.files.length, 0) };
  });
}

/** 包行键（组标签 + 包标签；根散文件 = 空串）——口径真源在 `file-tree-reveal.packageKey` */
export function rowKeyOf(groupLabel: string, subLabel: string | null): string {
  return packageKey(groupLabel, subLabel ?? '');
}
