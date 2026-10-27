import { isPathUnder } from '@kojo/plugin-api';

/**
 * 文件树盘上操作的纯逻辑（B1 标签收尾 + 删除/重命名守门）。
 *
 * 状态单源在 App，本模块只做「给定路径 / 集合 → 下一集合」的无副作用换算——
 * App 与测试共用同一份口径（照 `project-switch.ts` 的先例）。
 *
 * 这里的「删除命中」谓词（相等或位于被删目录之下，含 rename 换键）与 `omitPaths`
 * 那种「按路径精确剔除」是两件事，**不许合并**：递归删目录会把子路径一起带走，
 * 关标签只端走恰好在集合里的那一条。
 */

/** 路径是否被某个「已删除目标」命中：自身相等，或位于被删目录之下（递归删除是大刀） */
export function pathGoneByDelete(deleted: readonly string[], p: string): boolean {
  return deleted.some((d) => p === d || isPathUnder(d, p));
}

/** 分隔符折叠 + 去尾分隔符（**不改大小写**；判等仍交给 `isPathUnder`） */
function slashed(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
}

/** 把归一形态（`/`）按原路径的分隔符风格还回去：上屏/落库看到的仍是一条"原样"的路径 */
function inStyle(p: string, sep: string): string {
  return sep === '/' ? p : p.replace(/\//g, sep);
}

/**
 * 改名的**前缀感知**映射（WS-02）：自身相等，或位于被改名目录之下 ⇒ 映射到
 * `to` + 相对后缀；否则原样返回该条引用。
 *
 * 为什么不是精确 Map：目录改名后，其下打开的文件标签 / 脏态 / 固定 / 最近记录 / 视图状态
 * 全都还是旧路径。精确命中只能换掉目录那一条，子路径全成悬空旧路径（幽灵行）。
 *
 * 口径：
 * - 命中判据用契约的 `isPathUnder`（Windows 折叠大小写与分隔符；POSIX 保留大小写）；
 * - 多条目**按给定顺序**应用，命中即返回（与 `renamed` 的产地语义一致）；
 * - 输出分隔符跟随**入参 path 的写法**（Windows 路径回 Windows 写法），不让同一条路径
 *   在 UI 上出现两种斜杠混拼。
 */
export function mapRenamedPath(
  path: string,
  renamed: ReadonlyArray<{ from: string; to: string }>,
): string {
  for (const r of renamed) {
    if (!isPathUnder(r.from, path)) continue;
    // 双向互为前缀 = 同一条（大小写 / 分隔符写法不同也算），只需换成 `to`
    if (isPathUnder(path, r.from)) return r.to;
    const sep = path.includes('\\') ? '\\' : '/';
    const from = slashed(r.from);
    const to = inStyle(slashed(r.to), sep);
    return `${to}${inStyle(slashed(path).slice(from.length), sep)}`;
  }
  return path;
}

/**
 * 删除/重命名的守门：涉及**打开中且有未保存修改**的文件就拦下，给一句人话。
 * 目录同样拦——脏文件在被删目录之下时，"删目录"会把它一起带走（递归删除是大刀）。
 */
export function fileOpGuardMessage(
  paths: readonly string[],
  dirtyPaths: ReadonlySet<string>,
): string | null {
  for (const target of paths) {
    for (const p of dirtyPaths) {
      if (p === target || isPathUnder(target, p)) {
        const name = p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
        return `文件「${name}」有未保存修改，请先保存或关闭它，再进行删除/重命名。`;
      }
    }
  }
  return null;
}

/**
 * 搬运的脏闸（WS-13 2a 车）：给一批路径，返回其中**带着未保存修改**的那些的名字
 * （按入参顺序、名字去重；目录命中时点名的是它底下那份脏文件）。
 *
 * 与 `fileOpGuardMessage` 共用**同一条匹配判据**（精确命中，或脏文件落在被搬目录之下）——
 * 守门回答"能不能动"（一刀拒绝），这里回答"哪几份是脏的"（让作者选）。两问一份真源，
 * 不留第二份"脏"的定义；执行层（`file-ops-exec.DirtyGate`）拿的就是这个投影。
 */
export function dirtyNamesIn(paths: readonly string[], dirtyPaths: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const target of paths) {
    for (const p of dirtyPaths) {
      if (p !== target && !isPathUnder(target, p)) continue;
      const name = p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/**
 * 盘上事实变更后的路径集合收尾（脏态与固定态同一份口径）：被删的（含被删目录下的
 * 子路径）退出、被改名的**连同其下子路径**换新路径——不留悬空旧路径。没命中时返回
 * **同一个引用**，不给 React 制造无谓的重渲染。
 *
 * 改名迁移走 `mapRenamedPath`（前缀感知）：目录改名后其下每一份脏/固定条目都要跟随，
 * 精确 `from → to` 只能换掉目录自身那一条。
 */
export function reconcilePathsAfterDiskChange(
  prev: ReadonlySet<string>,
  deleted: readonly string[],
  renamed: ReadonlyArray<{ from: string; to: string }>,
): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const p of prev) {
    if (pathGoneByDelete(deleted, p)) {
      next ??= new Set(prev);
      next.delete(p);
      continue;
    }
    // 改名的脏标签不该出现（守门拦了），但真发生时也不能留出悬空旧路径
    const moved = mapRenamedPath(p, renamed);
    if (moved !== p) {
      next ??= new Set(prev);
      next.delete(p);
      next.add(moved);
    }
  }
  return next ?? prev;
}
