/**
 * eraFL 2.0 事件目录（游戏事实 —— 只住本包）。
 *
 * `# 机` 只认这里声明的事件名；core 不含任何一条（未知事件报错时列本表）。
 *
 * 真盘读数（2026-10-24，D:/Game/erafl，`^@EVENT(…)$` 精确匹配函数**定义**，
 * 2,027 份 ERB 全树；eraTW 是九事件全量，eraFL **只有 4 个**是真定义）：
 *
 * | 引擎事件 | eraFL 真盘定义 | 说明 |
 * | --- | --- | --- |
 * | `EVENTFIRST` | ✅ `ERB/SYSTEM/NEWGAME.ERB:76` | 新游戏首帧；引擎保证触发 |
 * | `EVENTLOAD`  | ✅ `ERB/SYSTEM/SAVELOAD.ERB:441` | 读档恢复后触发 |
 * | `EVENTSHOP`  | ✅ `ERB/SHOP/SHOP.ERB:6` | 进入商店 |
 * | `EVENTBUY`   | ✅ `ERB/SHOP/SHOP.ERB:113` | 商店购买 |
 * | `EVENTTRAIN` / `EVENTCOM` / `EVENTEND` | ❌ 无定义 | eraFL 用自己的流程函数取代 |
 * | `EVENTTURNEND` | ❌ 无定义 | `ERB/SYSTEM/TURNEND.ERB:4` 是 **`@FL_EVENTTURNEND`**（eraFL 自己的回合末流程） |
 * | `EVENTCOMEND` | ❌ 无定义 | 流程函数在 QUEST 侧（`@QST_*` 族），树里没有这个引擎事件 |
 *
 * 两个必须写进判据的坑：
 * 1. **前缀匹配会全军覆没**：树里有 27 个 `@EVENTTRAIN_*` / `@EVENTEND_*` 作者
 *    助手函数（`@EVENTTRAIN_K28_COMFORT` 一类）——名字以事件名打头，但不是引擎
 *    事件。本表只收精确同名的 4 条。
 * 2. **`forced` 不许撒谎**：只有 EVENTFIRST 是引擎保证触发的（eraTW 同口径）；
 *    eraFL 的 EVENTEND / EVENTTURNEND 根本没有引擎事件，标 forced 就是假声明。
 *
 * `# 机` 的发射落点（wrapMachine：eraTW 落 `@EVENTxxx` + `#PRI/#LATER/#ONLY`）
 * 归入口 D —— eraFL 没有引擎事件函数可落，形状要从真盘流程函数反推，本入口不猜。
 */
import type { EventCatalog, EventSpec } from '@kojo/kojo-core';

/**
 * 四个事件的公共形状：引擎分发 + emuera 桶优先级 + 无守卫。
 *
 * - `engine-dispatch`：四个事件在 2,027 份 ERB 里**没有任何 CALL 站点**（唯一
 *   命中的 `CALL EVENTBUY_LIFE` 是作者助手，不同名）⇒ 只能由引擎分发；
 * - `emuera-buckets`：eraFL = Emuera 变体（根目录 `EmueraFL_v1.45-preview.exe`），
 *   事件优先级走引擎的 PRI/LATER/ONLY 桶模型（eraTW 同口径）；
 * - `weavable: true`：同一引擎事实——事件函数可被别的事件钩挂（eraTW 九事件同口径）。
 */
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

/** eraFL 真盘存在的 4 个引擎事件（源端名沿用 eraTW 对同引擎事件的既有译名，口径一致） */
const EVENTS: readonly EventSpec[] = Object.freeze([
  // 初见：新游戏首帧；引擎保证触发（NEWGAME.ERB:76）
  event('初见', 'EVENTFIRST', { forced: true }),
  // 读档：SAVEDATA / CHARADATA 已恢复后触发（SAVELOAD.ERB:441）
  event('读档', 'EVENTLOAD'),
  // 商店：进入商店（SHOP.ERB:6）
  event('商店', 'EVENTSHOP'),
  // 购买：商店购买（SHOP.ERB:113）
  event('购买', 'EVENTBUY'),
]);

/** eraFL 2.0 事件目录（冻结；`defaultEvent = null`——2.0 的 `# 机` 不允许省略事件名） */
export const ERAFL_EVENT_CATALOG: EventCatalog = Object.freeze({
  events: EVENTS,
  defaultEvent: null,
});

/** 事件名清单（诊断文案/补全用；顺序 = 上表真盘定义序） */
export const ERAFL_EVENT_NAMES: readonly string[] = Object.freeze(EVENTS.map((spec) => spec.event));

/**
 * eraTW 有而 eraFL **没有**的 5 个引擎事件（测试侧独立抄一份期望值：
 * 防数据侧漂移，也防后人"补齐九事件"的顺手照抄）。
 */
export const ERAFL_ABSENT_EVENTS: readonly string[] = Object.freeze([
  'EVENTTRAIN',
  'EVENTCOM',
  'EVENTEND',
  'EVENTTURNEND',
  'EVENTCOMEND',
]);
