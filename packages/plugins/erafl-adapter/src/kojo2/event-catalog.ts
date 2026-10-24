/**
 * eraFL 2.0 事件目录（游戏事实 —— 只住本包）。
 *
 * **不能照抄 eraTW 的九事件**：eraFL 真盘实测（`^@EVENT(…)\b` 精确匹配函数
 * **定义**，不是调用点、不是前缀匹配），九个引擎事件里只有 4 个有真定义：
 *
 * | 引擎事件 | eraFL 真盘 | 说明 |
 * | --- | --- | --- |
 * | `EVENTFIRST` | ✅ `ERB/SYSTEM/NEWGAME.ERB:76` | 真定义；新游戏首帧，引擎保证触发 |
 * | `EVENTLOAD` | ✅ `ERB/SYSTEM/SAVELOAD.ERB:441` | 真定义；读档完成后触发 |
 * | `EVENTSHOP` | ✅ `ERB/SHOP/SHOP.ERB:6` | 真定义 |
 * | `EVENTBUY` | ✅ `ERB/SHOP/SHOP.ERB:113` | 真定义 |
 * | `EVENTTRAIN` / `EVENTCOM` / `EVENTEND` | ❌ 无定义 | eraFL 用自己的流程函数取代 |
 * | `EVENTTURNEND` | ❌ 无定义 | `ERB/SYSTEM/TURNEND.ERB:4` 是 `@FL_EVENTTURNEND`（eraFL 自己的回合末流程）；第 9 行的 `@EVENTTURNEND` 只是 `DEBUGPRINTFORML` 的字符串 |
 * | `EVENTCOMEND` | ❌ 无定义 | `ERB/QUEST/QUEST_MAIN.ERB:218` 是 `@QST_EVENTCOMEND`；注释说它「从 `@EVENTCOMEND` 被调用」，但那个 `@EVENTCOMEND` 在树里不存在 |
 *
 * **更坑的一点**：树里有 27 个以 `EVENTTRAIN_` / `EVENTEND_` 打头的**作者助手函数**
 * （`@EVENTTRAIN_K28_COMFORT` / `@EVENTEND_IAN` …），它们不是引擎事件，只是名字
 * 以事件名打头。任何按「前缀匹配事件函数」的判据都会把它们全收进来——本表的
 * 判据是精确匹配定义，语料扫描时已按 `\b` 边界排除。
 *
 * ⇒ 只声明 4 条。声明 9 条（把没有的五个也写上）等于对 eraFL 作者撒谎：
 * `# 机 训练` 会通过事件表校验，落到一个不存在的引擎函数上（红线 4：fail-visible，
 * 不静默造一个假函数）。缺的事件在 core 侧报 `event/unknown`，文案列出本表。
 *
 * 落点形状（`# 机` 落成什么 ERB）**不在本批决定**——eraFL 没有引擎事件函数可落，
 * 要么落「CALL 到自己的流程函数」的壳，要么这一版不支持；等入口 D 有真语料再定
 * （交接文档 §2.4 第 3 条）。
 */
import type { EventCatalog, EventSpec } from '@kojo/kojo-core';

/** 四条事件的公共形状：引擎分发 + Emuera 桶优先级 + 无守卫 */
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
    // Emuera 的 `#PRI / #LATER / #ONLY` 桶机制（eraFL 与 eraTW 同引擎）——
    // 这是 `@织 之前/之后/接管` 能落地的前提（§8.6）。
    priority: 'emuera-buckets',
    guard: null,
    forced: extra.forced ?? false,
    // 监听内错误无隔离（中断整条链）⇒ 四个事件都可被 `@织` 监听，编辑器要显示冲突。
    weavable: true,
  });
}

const EVENTS: readonly EventSpec[] = Object.freeze([
  // 初见：新游戏/首次见面；引擎保证触发（`NEWGAME.ERB:76`）
  event('初见', 'EVENTFIRST', { forced: true }),
  // 读档：SAVEDATA / CHARADATA 已恢复后触发（`SAVELOAD.ERB:441`）
  event('读档', 'EVENTLOAD'),
  // 商店：进入商店（`SHOP.ERB:6`）
  event('商店', 'EVENTSHOP'),
  // 购买：商店购买（`SHOP.ERB:113`）
  event('购买', 'EVENTBUY'),
]);

/** eraFL 四事件目录（冻结；`defaultEvent = null`——2.0 的 `# 机` 不允许省略事件名） */
export const ERAFL_EVENT_CATALOG: EventCatalog = Object.freeze({
  events: EVENTS,
  defaultEvent: null,
});

/** 事件名清单（诊断文案/补全用） */
export const ERAFL_EVENT_NAMES: readonly string[] = Object.freeze(EVENTS.map((spec) => spec.event));
