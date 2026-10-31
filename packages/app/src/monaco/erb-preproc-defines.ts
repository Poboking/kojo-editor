/**
 * 预处理条件块判据的**取数腿**：项目级 `#DEFINE` 名集（叶子模块，零 monaco 依赖）。
 *
 * 为什么单独成叶：`erb-preproc-dim.ts` 要点 Monaco 的装饰 API，而这条取数判据是**纯数据**
 * （索引进、集合出），单测要在 node 里直接跑——挂在装饰模块里就会把整个 Monaco 拖进
 * 测试进程（`window is not defined`）。同指令词表拆叶的理由（判据现下沉在包叶 `@kojo/erb-vocab/directives`）。
 *
 * 复用 `ErbFile.dims` 而不是另扫文本：`#DEFINE` 早已被扫描器收进 `dims`
 * （`directive === 'DEFINE'`，与 `#DIM` 族同一条解析路径），索引就是它的真源——
 * 另扫一遍等于允许"索引说定义了、装饰层说没定义"这种自相矛盾。
 */
import type { ErbIndex } from '@kojo/plugin-api';

/** 缓存键 = 索引对象（每次重建都是新对象，同 `projectDeclaredNames` 的失效判据） */
const cache = new WeakMap<ErbIndex, ReadonlySet<string>>();

/**
 * 从已建索引里取**项目级 `#DEFINE` 名集**（大写归一，与引擎 `GetMacro` 的忽略大小写默认档同向）。
 *
 * - 索引不存在 / 一份文件都没扫到 ⇒ `null`（无法证明，消费方一律不判）；
 * - 空集**不是** `null`：索引在手且项目确实没有宏时，"`[IF X]` 必被裁"仍然是可证明的。
 *
 * 已知保守面（方向都是"少压"）：`#DEFINE` 在引擎里还受加载顺序约束，这里按**项目全集**判，
 * 顺序上晚定义的宏会被当成"已定义"⇒ 少压一支，不误压。
 */
export function definedMacrosOf(index: ErbIndex | null): ReadonlySet<string> | null {
  if (index === null || index.files.size === 0) return null;
  const cached = cache.get(index);
  if (cached !== undefined) return cached;
  const names = new Set<string>();
  for (const file of index.files.values()) {
    for (const dim of file.dims) {
      if (dim.directive.toUpperCase() === 'DEFINE') names.add(dim.name.toUpperCase());
    }
  }
  cache.set(index, names);
  return names;
}
