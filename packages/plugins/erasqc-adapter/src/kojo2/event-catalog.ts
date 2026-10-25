/**
 * eraSQC 2.0 事件目录（游戏事实 —— 只住本包）。
 *
 * **九个引擎事件全部有真定义**（2026-10-26 `D:/Game/eraSQC` 精确匹配
 * `^@EVENT…$` 函数定义，不是调用点、不是前缀匹配）：
 *
 * | 事件 | 定义落点 | 说明 |
 * | --- | --- | --- |
 * | `EVENTFIRST` | `ERB/SYSTEM_NEWGAME.ERB:1` | 新游戏首帧 |
 * | `EVENTTRAIN` | `ERB/EVENT_K/EVENT_K.ERB:579` + 90 份角色口上文件 | **共享钩子**：每角色一定义，`RETURN` 守卫按 `TARGET` 分流 |
 * | `EVENTLOAD` | `ERB/SAVELOAD.ERB:259` | 读档完成后 |
 * | `EVENTSHOP` | `ERB/SHOP/SHOP.ERB:10` | 进入商店 |
 * | `EVENTBUY` | `ERB/SHOP/SHOP.ERB:611` | 商店购买 |
 * | `EVENTCOM` | `ERB/TRAIN/EVENTCOM.ERB:30` | 调教指令 |
 * | `EVENTEND` | `ERB/EVENT_K/EVENT_K01.ERB:334` + 89 份角色口上文件 | **共享钩子**：每角色一收尾定义 |
 * | `EVENTTURNEND` | `ERB/SYSTEM.ERB:392` | 回合末 |
 * | `EVENTCOMEND` | `ERB/TRAIN/EVENTCOM.ERB:208` | 指令收尾 |
 *
 * **共享钩子不是「重复定义错误」**：91 份 `@EVENTTRAIN` / 90 份 `@EVENTEND`
 * 是按角色拆分的钩子（`EVENT_K01.ERB:14` 起，函数体首行 `SIF TARGET != 1` 一族
 * `RETURN` 守卫），引擎侧全部调用 ⇒ `layerPolicy.event-hook = 'shared-hook'`。
 * 2.0 作者再声明同名事件钩子是合法叠加，不是覆盖。
 *
 * 排除项：`EVENTTRAIN_K48_2L` / `EVENTEND_K48_2L` / `EVENT_HOPE` 一类是作者助手
 * 函数，名字以事件名打头但不是引擎事件（精确匹配已按 `\b` 边界排除）。
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
    // `#PRI / #LATER / #ONLY` 桶机制（`EVENT_K.ERB:579` 的 `@EVENTTRAIN` 头即
    // `#PRI`）——共享钩子的叠加次序也靠它。
    priority: 'emuera-buckets',
    guard: null,
    forced: extra.forced ?? false,
    // 监听内错误无隔离（CodeEE 中断整条链）⇒ 九事件都可被 `@织` 监听。
    weavable: true,
  });
}

const EVENTS: readonly EventSpec[] = Object.freeze([
  // 初见：新游戏首帧；引擎保证触发（`SYSTEM_NEWGAME.ERB:1`）
  event('初见', 'EVENTFIRST', { forced: true }),
  // 训练：进入调教（共享钩子：主路由 + 90 份角色口上）
  event('训练', 'EVENTTRAIN'),
  // 读档：`SAVEDATA` / `CHARADATA` 已恢复后触发（`SAVELOAD.ERB:259`）
  event('读档', 'EVENTLOAD'),
  // 商店：进入商店（`SHOP.ERB:10`）
  event('商店', 'EVENTSHOP'),
  // 购买：商店购买（`SHOP.ERB:611`）
  event('购买', 'EVENTBUY'),
  // 指令：调教指令，`# 机 指令 310` 的 310 是 COM 编号（可选 int）
  event('指令', 'EVENTCOM', {
    args: Object.freeze([Object.freeze({ name: '编号', kind: 'int' as const, required: false })]),
  }),
  // 训练结束：引擎保证触发（共享钩子：89 份角色收尾 + 系统收尾）
  event('训练结束', 'EVENTEND', { forced: true }),
  // 回合末：引擎保证触发（`SYSTEM.ERB:392`）
  event('回合末', 'EVENTTURNEND', { forced: true }),
  // 指令结束：指令收尾（`EVENTCOM.ERB:208`）
  event('指令结束', 'EVENTCOMEND'),
]);

/** eraSQC 九事件目录（冻结；`defaultEvent = null`——2.0 的 `# 机` 不允许省略事件名） */
export const ERASQC_EVENT_CATALOG: EventCatalog = Object.freeze({
  events: EVENTS,
  defaultEvent: null,
});

/** 事件名清单（诊断文案 / 补全用；顺序与源语料定义次序无关，取九事件固定序） */
export const ERASQC_EVENT_NAMES: readonly string[] = Object.freeze(
  EVENTS.map((spec) => spec.event),
);
