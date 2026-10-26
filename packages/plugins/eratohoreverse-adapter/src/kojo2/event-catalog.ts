/**
 * eratohoReverse 2.0 事件目录（游戏事实 —— 只住本包）。
 *
 * **九事件本作有八个有真定义**（2026-10-26 `C:/game/eratohoReverse` 精确匹配
 * `^@EVENT…$` 函数定义，不是调用点、不是前缀匹配）；**`EVENTBUY` 全盘 0 处**
 * （本作没有购买事件钩子 ⇒ 目录里不声明它，语言层对 `# 机 购买` 报 unknown event）：
 *
 * | 事件 | 主定义落点 | 共享钩子 |
 * | --- | --- | --- |
 * | `EVENTFIRST` | `ERB/SYSTEM/SYSTEM.ERB:4` | `ERB/FUNCTION/PROCESS/KOMEIJI_FUNCTIONS/KCOLOR.ERB:57` |
 * | `EVENTTRAIN` | `ERB/TRAIN/EVETRAIN.ERB:4` | `ERB/FUNCTION/USEFUL/COMMON_USEFUL.ERB:437` |
 * | `EVENTLOAD` | `ERB/SYSTEM/SYSTEM_DATAMENU.ERB:48` | `KCOLOR.ERB:62` |
 * | `EVENTSHOP` | `ERB/SYSTEM/ROUTINE.ERB:133` | — |
 * | `EVENTCOM` | `ERB/SYSTEM/ROUTINE.ERB:4` | — |
 * | `EVENTEND` | `ERB/TRAIN/AFTERTRA.ERB:4` | — |
 * | `EVENTTURNEND` | `ERB/SYSTEM/EVENT_S.ERB:3` | — |
 * | `EVENTCOMEND` | `ERB/TRAIN/EVENTCOMEND.ERB:6` | — |
 * | `EVENTBUY` | **全盘 0 处** | 不声明（eratohoReverse 没有购买事件钩子） |
 *
 * **共享钩子不是「重复定义错误」**：`EVENTFIRST` / `EVENTTRAIN` / `EVENTLOAD` 各有
 * 两处定义，其中 `KCOLOR.ERB`（小魔界函数树）与 `COMMON_USEFUL.ERB` 是作者侧的
 * 公共叠加点。2.0 作者再声明同名事件钩子是合法叠加 ⇒
 * `layerPolicy.event-hook = 'shared-hook'`（见 capabilities.ts）。
 *
 * 排除项：`readme/開発資料/` 下 3 处 `@EVENTTURNEND` 落在受管 `ERB/` 之外（教学资料树），
 * 不计入。
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
    // `#PRI / #LATER / #ONLY` 桶机制——共享钩子的叠加次序也靠它。
    priority: 'emuera-buckets',
    guard: null,
    forced: extra.forced ?? false,
    // 监听内错误无隔离（CodeEE 中断整条链）⇒ 八事件都可被 `@织` 监听。
    weavable: true,
  });
}

const EVENTS: readonly EventSpec[] = Object.freeze([
  // 初见：新游戏首帧；引擎保证触发（`SYSTEM.ERB:4` + `KCOLOR.ERB:57` 共享钩子）
  event('初见', 'EVENTFIRST', { forced: true }),
  // 训练：进入调教（主路由 `EVETRAIN.ERB:4` + `COMMON_USEFUL.ERB:437` 共享钩子）
  event('训练', 'EVENTTRAIN'),
  // 读档：`SAVEDATA` / `CHARADATA` 已恢复后触发（`SYSTEM_DATAMENU.ERB:48` + `KCOLOR.ERB:62`）
  event('读档', 'EVENTLOAD'),
  // 商店：进入商店（`ROUTINE.ERB:133`）
  event('商店', 'EVENTSHOP'),
  // 指令：调教指令，`# 机 指令 310` 的 310 是 COM 编号（可选 int）
  event('指令', 'EVENTCOM', {
    args: Object.freeze([Object.freeze({ name: '编号', kind: 'int' as const, required: false })]),
  }),
  // 训练结束：引擎保证触发（`AFTERTRA.ERB:4`）
  event('训练结束', 'EVENTEND', { forced: true }),
  // 回合末：引擎保证触发（`EVENT_S.ERB:3`）
  event('回合末', 'EVENTTURNEND', { forced: true }),
  // 指令结束：指令收尾（`EVENTCOMEND.ERB:6`）
  event('指令结束', 'EVENTCOMEND'),
]);

/** eratohoReverse 八事件目录（冻结；`defaultEvent = null`——2.0 的 `# 机` 不允许省略事件名） */
export const ERATOHOREVERSE_EVENT_CATALOG: EventCatalog = Object.freeze({
  events: EVENTS,
  defaultEvent: null,
});

/** 事件名清单（诊断文案 / 补全用；顺序 = 八事件固定序） */
export const ERATOHOREVERSE_EVENT_NAMES: readonly string[] = Object.freeze(
  EVENTS.map((spec) => spec.event),
);
