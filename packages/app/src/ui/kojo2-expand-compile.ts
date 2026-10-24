/**
 * 展开视图编译成品的登记表 —— B3a（2026-10-24）起**整张表搬进 `@kojo/kojo-lang`**，
 * 此处只剩 re-export，既有 import 点一行不改。
 *
 * 为什么搬：这张表的两端现在不在同一侧了——登记方仍是宿主（面板持有编译缓存），
 * 但查询方多了一个**插件**（2.0 转定义要追加展开落点，而插件读不到宿主的模块）。
 * 完整理由写在包内 `packages/kojo-lang/src/expand-compile.ts` 的头注里。
 *
 * 本文件留到 B5 与其余 `kojo2-*.ts` 一起删；在那之前它只是"宿主侧那一圈 import 的落脚点"。
 */
export {
  kojo2ExpandCompilationFor,
  kojo2ExpandCompileSourceCount,
  registerKojo2ExpandCompileSource,
  type Kojo2ExpandCompileSource,
} from '@kojo/kojo-lang/expand-compile';
