/**
 * 教程的语义 id（面板底部四个按钮 ↔ 内核事件 `ui.tutorial.open` 的对应键）。
 *
 * 这四个 id 说的是**口上编辑的三种基础能力 + 一门语言的新一代写法**，不是某个游戏的专有知识：
 * - `kojo`：口上文件的结构与写法；
 * - `sugar`：`.kojo` 糖语言（v1 那套写法）；
 * - `kojo2`：`.kojo2` 的新一代写法（同一个词表的另一档）；
 * - `reference`：变量 / 旗标 / 函数查表。
 *
 * 教程**内容**由各 adapter 提供（那是游戏知识）；共享层只钉 id 与开窗契约。
 * 新 id 是 **additive** 的：`'kojo2'` 追加在 `sugar` 之后，旧消费方（宿主接线、
 * 内核事件载荷、只认三本的旧代码）一个字都不必改。
 */
export type TutorialId = 'sugar' | 'kojo2' | 'kojo' | 'reference';
