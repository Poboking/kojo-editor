/**
 * 外部写盘后的「model 重载决策」纯逻辑（2026-10-12 审阅补丁，修 B1）。
 *
 * 背景：💡 升糖等**经服务写盘**的操作会在成功路径上发内核事件 `file.changed`
 * （谁改盘谁发，见 events.ts / kojo-sugar 事件纪律）。此时编辑器里对应的 model
 * 仍是旧内容——若不重载，用户随后 `Ctrl+S` 会用旧文本**覆盖**磁盘上的新内容
 * （真实数据丢失）。宿主据此事件重载 model。
 *
 * 决策必须**区分「model 有无未保存修改」**，否则会引入反向数据丢失：
 * - `noop`：磁盘内容与 model 相同（多为自身保存的「回声」）→ 不做任何事，
 *   避免无谓重置撤销栈与光标；
 * - `reload`：磁盘变了、model **干净** → 静默重载（可安全用磁盘内容替换）；
 * - `conflict`：磁盘变了、model **脏** → **绝不静默覆盖**：重载会丢用户的
 *   未保存修改，不重载则用户保存会覆盖磁盘——两条路都有损，只能交给用户选。
 *
 * 抽成纯函数以便单测（React 组件内的分支不便在无 DOM 环境覆盖）。
 */
export type ExternalChangeDecision = 'noop' | 'reload' | 'conflict';

/**
 * @param modelText 当前编辑器 model 的文本
 * @param diskText  重新从磁盘读到的文本
 * @param dirty     model 是否有未保存修改（相对已保存基线）
 */
export function decideExternalChange(
  modelText: string,
  diskText: string,
  dirty: boolean,
): ExternalChangeDecision {
  if (modelText === diskText) return 'noop';
  return dirty ? 'conflict' : 'reload';
}