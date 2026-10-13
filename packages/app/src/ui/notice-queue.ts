/**
 * 通知队列的淘汰规则（壳层私有，2026-10-13 看板 HK-8 裁决批）。
 *
 * 为什么单独成文件（不写在 NotificationCenter 里）：这是**判据**，不是渲染细节。
 * 抽成纯函数才能被单测钉住——与 §5.105 把布局 reducer 搬到 `layout.ts` 同一个做法。
 *
 * 背景：外部改动撞上脏缓冲区时，宿主发的是 `kind: 'error'` 通知，而 error **没有 TTL**
 * （`NotificationCenter` 只给 info 挂定时器）。§5.96 实机却看到"作者随后按保存就覆盖了磁盘"，
 * 当时的解读是"toast 会自己消失"。读代码得到的真相不是 TTL，而是**同屏上限淘汰最旧**：
 * 溢出时不分 kind 一律丢最旧 ⇒ 一条要命的常驻警告，会被后面五条无关的 info 挤掉。
 * 那才是"真正的静默风险"，也是本批唯一该动的地方。
 */

/** 同屏上限（含 error）：防刷屏堆叠，也保证 error 队列本身有界 */
export const MAX_NOTICES = 5;

export interface NoticeItem {
  readonly kind: 'info' | 'error';
}

/**
 * 追加一条通知后的队列。
 *
 * 规则（按优先级）：
 * 1. 没超限 → 直接追加；
 * 2. 超限 → **先丢最旧的 info**；
 * 3. 一个 info 都没有（全是 error 还溢出）→ 才丢最旧的那条 error。
 *
 * 3 存在是为了有界：某个循环报错时不能把 toast 堆到无限高。
 * 但代价被压到最小——只有 error 挤 error 时才会丢掉一条常驻警告。
 */
export function pushNotice<T extends NoticeItem>(list: readonly T[], next: T, max = MAX_NOTICES): T[] {
  const out = [...list, next];
  if (out.length <= max) return out;
  const victim = out.findIndex((n) => n.kind === 'info');
  const dropAt = victim >= 0 ? victim : 0;
  out.splice(dropAt, 1);
  return out;
}
