/**
 * eratohoK 2.0 事件目录（游戏事实 —— 只住本包）。
 *
 * **九个引擎事件全部有真定义**（2026-10-26 `D:/Game/eratohok` 精确匹配
 * `^@EVENT…$` 函数定义，不是调用点、不是前缀匹配）：
 *
 * | 事件 | 定义落点 | 说明 |
 * | --- | --- | --- |
 * | `EVENTFIRST` | `ERB/SYSTEM/NEWGAME.ERB:73` | 新游戏首帧 |
 * | `EVENTTRAIN` | `ERB/TRAIN/SYSTEM_TRAIN.ERB:6` | 训练主路由 |
 * | `EVENTTRAIN`（共享钩子） | `ERB/口上/_KOJO_SYSTEM.ERB:104` | 作者口上共享钩子 |
 * | `EVENTLOAD` | `ERB/SYSTEM/SAVELOAD.ERB:298` | 读档完成后 |
 * | `EVENTSHOP` | `ERB/SHOP/SHOP.ERB:6` | 进入商店 |
 * | `EVENTBUY` | `ERB/SHOP/SHOP.ERB:152` | 商店购买 |
 * | `EVENTCOM` | `ERB/TRAIN/SYSTEM_TRAIN.ERB:280` | 调教指令 |
 * | `EVENTEND` | `ERB/TRAIN/EVENT_AFTER.ERB:6` | 训练收尾 |
 * | `EVENTEND`（共享钩子） | `ERB/口上/_KOJO_SYSTEM.ERB:137` | 作者口上共享钩子 |
 * | `EVENTTURNEND` | `ERB/SYSTEM/TURNEND.ERB:4` | 回合末 |
 * | `EVENTCOMEND` | `ERB/TRAIN/SYSTEM_TRAIN.ERB:527` | 指令收尾 |
 *
 * **共享钩子不是「重复定义错误」**：`EVENTTRAIN` / `EVENTEND` 各有两处定义，
 * 其中 `_KOJO_SYSTEM.ERB` 是作者侧的公共叠加点（按角色号 `TRYCALLFORM` 路由）。
 * 2.0 作者再声明同名事件钩子是合法叠加 ⇒ `layerPolicy.event-hook = 'shared-hook'`。
 *
 * 排除项：名字以事件名打头但带后缀的作者助手函数（精确匹配按 `\b` 边界排除）。
 */
import type { EventCatalog, EventSpec } from '@kojo/kojo-core';

/** 九事件的公共形状：引擎分发 + Emuera 桶优先级 + 无守卫 */
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
    // `#PRI / #LATER / #ONLY` 桶机制——共享钩子的叠加次序也靠它。
    priority: 'emuera-buckets',
    guard: null,
    forced: extra.forced ?? false,
    // 监听内错误无隔离（CodeEE 中断整条链）⇒ 九事件都可被 `@织` 监听。
    weavable: true,
  });
}

const EVENTS: readonly EventSpec[] = Object.freeze([
  // 初见：新游戏首帧；引擎保证触发（`NEWGAME.ERB:73`）
  event('初见', 'EVENTFIRST', { forced: true }),
  // 训练：进入调教（主路由 `SYSTEM_TRAIN.ERB:6` + `_KOJO_SYSTEM.ERB:104` 共享钩子）
  event('训练', 'EVENTTRAIN'),
  // 读档：`SAVEDATA` / `CHARADATA` 已恢复后触发（`SAVELOAD.ERB:298`）
  event('读档', 'EVENTLOAD'),
  // 商店：进入商店（`SHOP.ERB:6`）
  event('商店', 'EVENTSHOP'),
  // 购买：商店购买（`SHOP.ERB:152`）
  event('购买', 'EVENTBUY'),
  // 指令：调教指令，`# 机 指令 310` 的 310 是 COM 编号（可选 int）
  event('指令', 'EVENTCOM', {
    args: Object.freeze([Object.freeze({ name: '编号', kind: 'int' as const, required: false })]),
  }),
  // 训练结束：引擎保证触发（`EVENT_AFTER.ERB:6` + `_KOJO_SYSTEM.ERB:137` 共享钩子）
  event('训练结束', 'EVENTEND', { forced: true }),
  // 回合末：引擎保证触发（`TURNEND.ERB:4`）
  event('回合末', 'EVENTTURNEND', { forced: true }),
  // 指令结束：指令收尾（`SYSTEM_TRAIN.ERB:527`）
  event('指令结束', 'EVENTCOMEND'),
]);

/** eratohoK 九事件目录（冻结；`defaultEvent = null`——2.0 的 `# 机` 不允许省略事件名） */
export const ERATOHOK_EVENT_CATALOG: EventCatalog = Object.freeze({
  events: EVENTS,
  defaultEvent: null,
});

/** 事件名清单（诊断文案 / 补全用；顺序 = 九事件固定序） */
export const ERATOHOK_EVENT_NAMES: readonly string[] = Object.freeze(
  EVENTS.map((spec) => spec.event),
);
