/**
 * era紅魔館 2.0 事件目录（游戏事实 —— 只住本包）。
 *
 * **七条引擎事件有真定义，两条没有**。证据 = 2026-10-26 `D:/Game/eraKoumakan`
 * 真盘读数：精确匹配 `^@EVENT…$` 函数定义，不是调用点、不是前缀匹配；
 * 全树 403 份 `.ERB` 逐行扫描。
 *
 * | 事件 | 定义落点 | 说明 |
 * | --- | --- | --- |
 * | `EVENTFIRST` | `ERB/SYSTEM.ERB:4` | 新游戏首帧 |
 * | `EVENTTRAIN` | `ERB/BEFORETRAIN.ERB:3` | 训练前，带 `#PRI` |
 * | `EVENTTRAIN`（第二处） | `ERB/COMMON.ERB:123` | 同一事件第二个定义，两处都执行 |
 * | `EVENTLOAD` | `ERB/SYSTEM.ERB:176` | 读档完成后 |
 * | `EVENTCOM` | `ERB/EVENTCOMEND.ERB:4` | 调教指令 |
 * | `EVENTEND` | `ERB/AFTERTRA.ERB:4` | 训练收尾 |
 * | `EVENTTURNEND` | `ERB/EVENTTURNEND.ERB:4` | 回合末 |
 * | `EVENTCOMEND` | `ERB/EVENTCOMEND.ERB:9` | 指令收尾 |
 *
 * **本作没有商店**：`@EVENTSHOP` / `@EVENTBUY` 全树 0 处 ⇒ 不声明这两个事件。
 * 宁可少两条，也不拿 eraTohoK 的商店事实填空。
 *
 * **`EVENTTRAIN` 的两处定义共存不是「重复定义错误」**：`BEFORETRAIN.ERB:3` 带
 * `#PRI` 参与 Emuera 桶排序，`COMMON.ERB:123` 是另一处无条件定义，引擎两处全部执行
 * ⇒ `layerPolicy.event-hook = 'shared-hook'`（见 `capabilities.ts`）。
 *
 * 排除项：`@EVENT_COUNTER_*` / `@EVENT_WC_COUNTER_*` / `@EVENT_MESSAGE` 一族是作者
 * 助手函数（名字以 EVENT 打头但不是引擎事件），精确匹配按 `\b` 边界排除。
 */
import type { EventCatalog, EventSpec } from '@kojo/kojo-core';

/** 七事件的公共形状：引擎分发 + Emuera 桶优先级 + 无守卫 */
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
    // `#PRI / #LATER / #ONLY` 桶机制 —— EVENTTRAIN 的两处定义正靠它排序。
    priority: 'emuera-buckets',
    guard: null,
    forced: extra.forced ?? false,
    // 监听内错误无隔离（CodeEE 中断整条链）⇒ 七事件都可被 `@织` 监听。
    weavable: true,
  });
}

const EVENTS: readonly EventSpec[] = Object.freeze([
  // 初见：新游戏首帧；引擎保证触发（`SYSTEM.ERB:4`）
  event('初见', 'EVENTFIRST', { forced: true }),
  // 训练：进入调教（`BEFORETRAIN.ERB:3` + `COMMON.ERB:123` 两处定义共存）
  event('训练', 'EVENTTRAIN'),
  // 读档：`SAVEDATA` / `CHARADATA` 已恢复后触发（`SYSTEM.ERB:176`）
  event('读档', 'EVENTLOAD'),
  // 指令：调教指令，`# 机 指令 310` 的 310 是 COM 编号（可选 int）
  event('指令', 'EVENTCOM', {
    args: Object.freeze([Object.freeze({ name: '编号', kind: 'int' as const, required: false })]),
  }),
  // 训练结束：引擎保证触发（`AFTERTRA.ERB:4`）
  event('训练结束', 'EVENTEND', { forced: true }),
  // 回合末：引擎保证触发（`EVENTTURNEND.ERB:4`）
  event('回合末', 'EVENTTURNEND', { forced: true }),
  // 指令结束：指令收尾（`EVENTCOMEND.ERB:9`）
  event('指令结束', 'EVENTCOMEND'),
]);

/** era紅魔館 七事件目录（冻结；`defaultEvent = null` —— 2.0 的 `# 机` 不允许省略事件名） */
export const ERAKOUMAKAN_EVENT_CATALOG: EventCatalog = Object.freeze({
  events: EVENTS,
  defaultEvent: null,
});

/** 事件名清单（诊断文案 / 补全用；顺序 = 七事件固定序） */
export const ERAKOUMAKAN_EVENT_NAMES: readonly string[] = Object.freeze(
  EVENTS.map((spec) => spec.event),
);
