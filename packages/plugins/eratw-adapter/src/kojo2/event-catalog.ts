/**
 * eraTW 2.0 事件目录（游戏事实 —— 只住本包）。
 *
 * 权威依据：设计稿附录 B.1（eraTW / Emuera 九事件）。`# 机` 与 `@织` 只认这里
 * 声明的事件名；core 不含任何一条（§3.5：未知事件报错时列本表，而不是内置九事件）。
 *
 * 共同事实：
 * - 九个事件都走引擎分发（`engine-dispatch`），优先级模型都是 `emuera-buckets`
 *   —— 这是 `@织 之前 / 之后 / 接管` 能落 `#PRI / #LATER / #ONLY` 的前提（§8.6）；
 * - 强制事件（`forced`）：`EVENTFIRST` / `EVENTEND` / `EVENTTURNEND` 由引擎保证触发；
 *   `EVENTLOAD` 在读档完成后触发；
 * - 监听内错误无隔离（CodeEE 中断整条链），故九个事件都可被 `@织` 监听，编辑器要显示冲突。
 */
import type { EventCatalog, EventSpec } from '../../../../kojo-core/src/adapter.js';

/** 九个事件的公共形状：引擎分发 + emuera 桶优先级 + 无守卫 */
function event(
  name: string,
  engine: string,
  extra: Partial<Pick<EventSpec, 'args' | 'forced'>> = {},
): EventSpec {
  return Object.freeze({
    event: name,
    engine,
    args: Object.freeze(extra.args ?? []),
    dispatch: 'engine-dispatch',
    priority: 'emuera-buckets',
    guard: null,
    forced: extra.forced ?? false,
    weavable: true,
  });
}

const EVENTS: readonly EventSpec[] = Object.freeze([
  // 初见：新游戏/首次见面；引擎保证触发
  event('初见', 'EVENTFIRST', { forced: true }),
  // 训练：进入调教
  event('训练', 'EVENTTRAIN'),
  // 读档：SAVEDATA / CHARADATA 已恢复后触发
  event('读档', 'EVENTLOAD'),
  // 商店：进入商店
  event('商店', 'EVENTSHOP'),
  // 购买：商店购买
  event('购买', 'EVENTBUY'),
  // 指令：调教指令，`# 机 指令 310` 的 310 是 COM 编号（可选 int）
  event('指令', 'EVENTCOM', {
    args: Object.freeze([Object.freeze({ name: '编号', kind: 'int' as const, required: false })]),
  }),
  // 训练结束：引擎保证触发
  event('训练结束', 'EVENTEND', { forced: true }),
  // 回合末：引擎保证触发
  event('回合末', 'EVENTTURNEND', { forced: true }),
  // 指令结束：指令收尾
  event('指令结束', 'EVENTCOMEND'),
]);

/** eraTW 九事件目录（冻结；`defaultEvent = null`——2.0 的 `# 机` 不允许省略事件名） */
export const ERATW_EVENT_CATALOG: EventCatalog = Object.freeze({
  events: EVENTS,
  defaultEvent: null,
});

/** 事件名清单（诊断文案/补全用；顺序 = 附录 B.1 表序） */
export const ERATW_EVENT_NAMES: readonly string[] = Object.freeze(EVENTS.map((spec) => spec.event));
