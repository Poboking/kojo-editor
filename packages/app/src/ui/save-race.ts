/**
 * 保存竞态守卫（2026-10-16 深审 A1）——「写盘窗口内的输入静默丢字」的治法。
 *
 * 旧链路：savePath 先 getValue 捕文本，`await kernel.io.writeText` 之后才 markSaved，
 * 而 markSaved 用**此刻**的版本号立基线——写盘窗口内的新输入留在 model 却不在盘上，
 * 却被标记为已保存：脏点消失、saveAll 跳过、关标签/关项目不再确认，输入静默丢失。
 *
 * 协议（调用方 = EditorPane.savePath）：
 * 1. 文本定稿后（保存前整理 pushEditOperations 已落地）立即快照版本号；
 * 2. await 写盘；
 * 3. 写盘成功后用本函数比对——`unchanged` 才允许 markSaved 立基线；`raced` ⇒
 *    保持脏 + 如实报失败（saveAll 返回 false、关标签/关项目的确认流不放过）。
 * 盘上永远是定稿那份字节；窗口内的新输入留在 model，下一次 Ctrl+S 再落盘。
 */
export type SaveRaceVerdict = 'unchanged' | 'raced';

/** 比对「文本定稿时」与「写盘回包时」的 model 版本号：只有相等才算这次保存真正落账 */
export function classifySaveRace(versionAtFinalize: number, versionAfterWrite: number): SaveRaceVerdict {
  return versionAtFinalize === versionAfterWrite ? 'unchanged' : 'raced';
}
