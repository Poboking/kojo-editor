/**
 * 展开视图的**编译成品来源**登记表（K2-EXPAND-VIEW 的接线缝）。
 *
 * ## 为什么要有这一层
 *
 * 展开视图（`expand-view.ts` 的 `expandViewAt`）要"那一次编译的产物 + 同一份 source map"；
 * 这份成品在宿主里**已经存在**——`ui/kojo2-problem-wiring.ts` 的 `Kojo2CompileCache`
 * 留的就是诊断那一轮 core 编译的 `compiled` + `sourceMapModel`（一次编译两处消费）。
 *
 * 问题在**作用域**：缓存按编辑器面板建（`ui/editor-pane/use-monaco-instance.ts` 里每面板
 * 一枚），而语言服务 provider 是**全局注册一次**（`ui/editor-global-providers.ts`）。
 * provider 拿到的是一个 model，没法顺着它找到"这个面板的缓存实例"。所以这里放一张
 * **模块级登记表**：面板挂载时登记自己的读取器（`cache.getLastCompile`），provider 按
 * 模型路径问一遍。多面板（分屏）各登记各的，按路径命中，天然互不串。
 *
 * ## 为什么住在 `@kojo/kojo-lang` 而不是宿主（B3a，2026-10-24）
 *
 * 这张表的两端现在**不在同一侧**了：登记方仍是宿主（面板持有缓存），但查询方多了一个
 * **插件**（`@kojo/plugin-kojo-lang`）——2.0 的转定义要追加展开落点，那两条落点由
 * `expand-view.ts` 的纯函数算，而插件读不到宿主的模块。
 *
 * 三条路都比这个差：
 * - 插件 `import` 宿主模块：包与插件的硬边界（零宿主依赖）当场破掉，且方向是反的；
 * - 让宿主 provide 一个服务键：宿主组合根今天**从不** provide 服务（它只消费槽），
 *   为这一格新开一条链路，等于给"宿主是不是插件"这件事开先例；
 * - 插件自己再收一份成品：两份来源必然漂（一次编译两处消费的前提就是"同一份"）。
 *
 * 于是整张表搬进语言面库：宿主登记、宿主与插件都查。这也是 B1 那条纪律的延伸——
 * **判据与它的取数缝同侧，宿主只做翻译与装配**。
 *
 * ## 口径
 *
 * - **零注册零行为**：没人登记 ⇒ 查询恒 `null` ⇒ provider 不追加展开段（与今天逐字一致）；
 * - 返回值形状只认 `{ compiled: { erb: string }, sourceMapModel }`（即
 *   {@link Kojo2ExpandCompilation}，结构兼容，不 import 预览模块，避免把 React 侧拖进来）；
 * - 读取器抛错 = 这一份取不到（**不抛进 Monaco**）；后登记的先问（面板可重挂，新实例优先）；
 * - 注销只撤自己（面板卸载时不会把后来者的读取器一并撤掉）。
 */
import type { Kojo2ExpandCompilation } from './expand-view';

/** 按文件路径取那一份编译成品（`null` = 还没编译 / 编译失败 / 不是本面板的文件） */
export type Kojo2ExpandCompileSource = (filePath: string) => Kojo2ExpandCompilation | null;

/** 登记顺序 = 查询顺序的逆序（后登记的优先：同路径下新面板的成品更新） */
const sources: Kojo2ExpandCompileSource[] = [];

/**
 * 登记一枚读取器；返回**只撤自己**的注销函数（重复调用幂等）。
 *
 * 宿主在编辑器面板挂载 effect 里登记、卸载时注销；测试直接登记桩。
 */
export function registerKojo2ExpandCompileSource(source: Kojo2ExpandCompileSource): () => void {
  sources.push(source);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const at = sources.lastIndexOf(source);
    if (at >= 0) sources.splice(at, 1);
  };
}

/** 该路径此刻的编译成品（没有 / 形状不对 / 读取器抛错 ⇒ `null`） */
export function kojo2ExpandCompilationFor(filePath: string): Kojo2ExpandCompilation | null {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  for (let index = sources.length - 1; index >= 0; index--) {
    const source = sources[index]!;
    let compilation: Kojo2ExpandCompilation | null;
    try {
      compilation = source(filePath);
    } catch {
      continue; // 这一枚读不出（面板正在重建等）⇒ 问下一枚，不把异常带进 provider
    }
    if (compilation === null || compilation === undefined) continue;
    if (typeof compilation.compiled?.erb !== 'string') continue;
    if (compilation.sourceMapModel === undefined || compilation.sourceMapModel === null) continue;
    return compilation;
  }
  return null;
}

/** 当前登记了几枚（观测面：宿主导出 / 测试钉"卸载不留登记"） */
export function kojo2ExpandCompileSourceCount(): number {
  return sources.length;
}
