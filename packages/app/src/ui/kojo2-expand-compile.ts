/**
 * 展开视图的**编译成品来源**登记表（K2-EXPAND-VIEW 的接线缝）。
 *
 * ## 为什么要有这一层
 *
 * 展开视图（`monaco/kojo2-expand-view.ts`）要"那一次编译的产物 + 同一份 source map"；
 * 这份成品在宿主里**已经存在**——`ui/kojo2-problem-wiring.ts` 的 `Kojo2CompileCache`
 * 留的就是诊断那一轮 core 编译的 `compiled` + `sourceMapModel`（一次编译两处消费）。
 *
 * 问题在**作用域**：缓存按编辑器面板建（`ui/editor-pane/use-monaco-instance.ts` 里每面板
 * 一枚），而语言服务 provider 是**全局注册一次**（`ui/editor-global-providers.ts`）。
 * provider 拿到的是一个 model，没法顺着它找到"这个面板的缓存实例"。所以这里放一张
 * **模块级登记表**：面板挂载时登记自己的读取器（`cache.getLastCompile`），provider 按
 * 模型路径问一遍。多面板（分屏）各登记各的，按路径命中，天然互不串。
 *
 * ## 口径
 *
 * - **零注册零行为**：没人登记 ⇒ 查询恒 `null` ⇒ provider 不追加展开段（与今天逐字一致）；
 * - 返回值形状只认 `{ compiled: { erb: string }, sourceMapModel }`（即
 *   `Kojo2PreviewCompilation`，结构兼容，不 import 预览模块，避免把 React 侧拖进来）；
 * - 读取器抛错 = 这一份取不到（**不抛进 Monaco**）；后登记的先问（面板可重挂，新实例优先）；
 * - 注销只撤自己（面板卸载时不会把后来者的读取器一并撤掉）。
 */
import type { Kojo2ExpandCompilation } from '@kojo/kojo-lang';

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
