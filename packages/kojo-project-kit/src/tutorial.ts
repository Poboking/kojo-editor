/**
 * 教程的语义 id（面板底部三个按钮 ↔ 内核事件 `ui.tutorial.open` 的对应键）。
 *
 * 这三个 id 说的是**口上编辑的三种基础能力**，不是某个游戏的专有知识：
 * - `kojo`：口上文件的结构与写法；
 * - `sugar`：`.kojo` 糖语言；
 * - `reference`：变量 / 旗标 / 函数查表。
 *
 * 教程**内容**由各 adapter 提供（那是游戏知识）；共享层只钉 id 与开窗契约。
 */
export type TutorialId = 'sugar' | 'kojo' | 'reference';
