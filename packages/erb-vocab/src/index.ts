/**
 * `@kojo/erb-vocab` —— **ERB 语言面的引擎词表与纯函数**（非插件库包，与 `@kojo/kojo-vocab` 同性质）。
 *
 * 收录判据：这条事实既不是"某个插件的实现细节"，也不是"宿主的 UI 判据"，而是**引擎的
 * 语言事实 + 多个读者必须共享的唯一一份**。今天只有两条腿：
 *
 * | 叶子 | 内容 | 读者 |
 * | --- | --- | --- |
 * | `@kojo/erb-vocab/control-flow` | 控制流配对表 + `classifyControlFlow` | 插件 `@kojo/plugin-erb-parser`（行式扫描 / 结构体检）、库 `@kojo/erb-lang`（同符号高亮 / 扩选）、构建期裸 node 工具 |
 * | `@kojo/erb-vocab/highlight-words` | 高亮补集的词表与纯判据（指令表作参数） | 宿主 `monaco/erb-directives.ts`（物化 `ERB_HIGHLIGHT_*`；不进桶，PS-10 的 B1 纪律照旧） |
 *
 * 零 Monaco、零 React、零 DOM、零 IO、**零运行时 import**（裸 node 要能直接吃这些叶子）；
 * 桶只给"要整块"的调用方与测试，进首屏的代码一律引叶子（PS-10 的 B1 纪律）。
 *
 * ## 控制流表为什么住这里（2026-10-30 ERB-VOCAB 批）
 *
 * 表有两个读者，分属两层：行式结构扫描（插件 `@kojo/plugin-erb-parser` 的 `scanner.ts`，
 * 另有构建期裸 node 工具 `gen-erb-structure.mjs` 吃它的运行时值）与同符号高亮 / 扩选
 * （库 `@kojo/erb-lang`）。表若留在插件里，库包就得 import 插件包——**分层倒置**（上一波
 * 验收记下的架构债）；各抄一份则必然漂移，漂移的表现是"高亮连错块"，比不标更糟。
 * 上提到非插件库包之后：插件 re-export 它、宿主 `monaco/erb-enter.ts` 经插件照旧读，
 * 三方是**并列读者**，谁也不引谁，单一真源一格未动。
 */
export * from './control-flow';
