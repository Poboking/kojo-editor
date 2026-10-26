/**
 * eraAV 2.0 事件目录（游戏事实 —— 只住本包）。
 *
 * **九事件本作有八个有真定义**（2026-10-26 `C:/game/eraAV` 精确匹配 `^@EVENT…$`
 * 函数定义，不是调用点、不是前缀匹配）；**`EVENTLOAD` 全盘 0 处**（本作没有读档
 * 钩子 ⇒ 目录里不声明它，语言层对 `# 机 读档` 报 unknown event）：
 *
 * | 事件 | 主定义落点 | 说明 |
 * | --- | --- | --- |
 * | `EVENTFIRST` | `ERB/SYSTEM/SYSTEM_GAMESTART.ERB:10` | 新游戏首帧 |
 * | `EVENTTRAIN` | `ERB/COMF/TRAIN_MAIN.ERB:11` | 训练主路由（全盘定义 43 处：口上域多份 `#PRI` 成对写法） |
 * | `EVENTSHOP` | `ERB/EVENT/EVENT_K.ERB:16`（另有 `ERB/SYSTEM/SHOP_MAIN.ERB:13`） | 进入商店 |
 * | `EVENTBUY` | `ERB/SYSTEM/SHOP_ITEM.ERB:52` | 商店购买 |
 * | `EVENTCOM` | `ERB/COMF/TRAIN_MAIN.ERB:254` | 调教指令 |
 * | `EVENTCOMEND` | `ERB/COMF/TRAIN_MAIN.ERB:265`（另有 `EVENT_EXIST_MULTIPLAY.ERB:157`） | 指令收尾 |
 * | `EVENTEND` | `ERB/COMF/TRAIN_MAIN.ERB:304` | 训练收尾（全盘定义 45 处） |
 * | `EVENTTURNEND` | `ERB/EVENT/EVENT_TURNEND.ERB:6` | 回合末 |
 * | `EVENTLOAD` | **全盘 0 处** | 不声明（eraAV 没有读档事件钩子） |
 *
 * 多处定义合法是本作的核心事实：`EVENTTRAIN` / `EVENTEND` 在口上域 `ERB/Lines/` 有
 * 大量 `#PRI`（桶优先）成对写法，作者侧钩子借 Emuera 桶机制插到系统侧之前 ⇒
 * `layerPolicy.event-hook = 'shared-hook'`（见 capabilities.ts）。
 *
 * 排除项：名字以事件名打头但带后缀的作者助手函数（精确匹配按 `\b` 边界排除）。
 */
import type { EventCatalog, EventSpec } from '@kojo/kojo-core';

/** 八事件的公共形状：引擎分发 + Emuera 桶优先级 + 无守卫 */
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
    // `#PRI / #LATER / #ONLY` 桶机制——口上域的 `#PRI` 钩子叠加次序也靠它。
    priority: 'emuera-buckets',
    guard: null,
    forced: extra.forced ?? false,
    // 监听内错误无隔离（CodeEE 中断整条链）⇒ 八事件都可被 `@织` 监听。
    weavable: true,
  });
}

const EVENTS: readonly EventSpec[] = Object.freeze([
  // 初见：新游戏首帧；引擎保证触发（`SYSTEM_GAMESTART.ERB:10`）
  event('初见', 'EVENTFIRST', { forced: true }),
  // 训练：进入调教（主路由 `TRAIN_MAIN.ERB:11`；口上域多份 `#PRI` 钩子）
  event('训练', 'EVENTTRAIN'),
  // 商店：进入商店（`EVENT_K.ERB:16` / `SHOP_MAIN.ERB:13`）
  event('商店', 'EVENTSHOP'),
  // 购买：商店购买（`SHOP_ITEM.ERB:52`）
  event('购买', 'EVENTBUY'),
  // 指令：调教指令，`# 机 指令 310` 的 310 是 COM 编号（可选 int）
  event('指令', 'EVENTCOM', {
    args: Object.freeze([Object.freeze({ name: '编号', kind: 'int' as const, required: false })]),
  }),
  // 训练结束：引擎保证触发（`TRAIN_MAIN.ERB:304`；口上域多份 `#PRI` 钩子）
  event('训练结束', 'EVENTEND', { forced: true }),
  // 回合末：引擎保证触发（`EVENT_TURNEND.ERB:6`）
  event('回合末', 'EVENTTURNEND', { forced: true }),
  // 指令结束：指令收尾（`TRAIN_MAIN.ERB:265`）
  event('指令结束', 'EVENTCOMEND'),
]);

/** eraAV 八事件目录（冻结；`defaultEvent = null`——2.0 的 `# 机` 不允许省略事件名） */
export const ERAAV_EVENT_CATALOG: EventCatalog = Object.freeze({
  events: EVENTS,
  defaultEvent: null,
});

/** 事件名清单（诊断文案 / 补全用；顺序 = 八事件固定序） */
export const ERAAV_EVENT_NAMES: readonly string[] = Object.freeze(
  EVENTS.map((spec) => spec.event),
);
