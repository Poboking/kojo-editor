/**
 * Kojo 2.0 结构引擎的**捕获纯数据类型**（0 基行列；B3 语义收口起只剩类型）。
 *
 * B3 之前本文件还带着"捕获 → Monaco 区间"的翻译层（`capturesToTokenSpans`）——那一格是
 * **着色判据**，2026-10-30 的语义收口把它整块搬进了 `@kojo/kojo-lang/semantic`
 * （`kojo2SemanticSpansFromCaptures`）与 `kojo2ContractCaptures`（0 基 → 契约 1 基）。
 * 宿主不再有第二份实现：这里只留 worker 回复 / 运行时共用的**形状**，值导出为零
 * （类型导入会被擦除，不进开机静态图）。
 *
 * 坐标口径：`row` / `column` 都是 **0 基**（tree-sitter 原生）；契约的 1 基换算只在
 * `@kojo/kojo-lang/semantic` 与宿主最后一道 `normalizeSemanticSpans` 里发生。
 */

/** tree-sitter 坐标（0 基行 / 0 基列） */
export interface Kojo2Point {
  readonly row: number;
  readonly column: number;
}

/** `Query.captures()` 一枚捕获的**纯数据投影**（runtime 交出来的就是它） */
export interface Kojo2Capture {
  readonly name: string;
  readonly startPosition: Kojo2Point;
  readonly endPosition: Kojo2Point;
  /**
   * 捕获节点的**类型名**（LAU-6 additive）：注入层按 descriptor 的 `injections.hostNode`
   * 找宿主节点时只认这一格——宿主不硬编码任何节点名。
   * 缺省（旧回复 / 测试替身没给）= 不知道，注入层跳过这一条（不猜）。
   */
  readonly nodeType?: string;
}
