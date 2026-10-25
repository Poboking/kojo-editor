/**
 * eraAkumaMaid 2.0 事件目录（游戏事实 —— 只住本包）。
 *
 * **无真盘 · 证据等级 B**：2026-10-26 实测 `C:/game/eraAkumaMaid` 与
 * `D:/Game/eraAkumaMaid` 均不存在，本文件**不含任何真盘计数**；依据 = v1 源码
 * 的 `file:line` 与测试夹具。只声明**有 v1 定义证据**的三条引擎事件。
 *
 * | 事件 | 引擎落点 | 依据 |
 * | --- | --- | --- |
 * | `训练` | `EVENTTRAIN` | `family-index.ts:17`「EVENTTRAIN / EVENTEND 无编号后缀、每角色重复定义、靠 `SIF NO:TARGET` 守卫」 |
 * | `指令` | `EVENTCOM` | `face-templates.ts:108` 引 `ERB/TRAIN/EVENTCOM.ERB:331/338`（指令终了流程文件）；指令号 `SELECTCOM` 是运行期值（`face-templates.ts:19-21`） |
 * | `训练结束` | `EVENTEND` | 同 `family-index.ts:17`（共享钩子） |
 *
 * **未声明的六条**（初见 / 读档 / 商店 / 购买 / 回合末 / 指令结束）：无盘、v1 源码里
 * **没有它们的定义证据** ⇒ 不声明。语言层对这些名字报 unsupported 是**可见降级**，
 * 不是遗漏；等真盘 / 新语料给出定义落点再补，不借别作事件填空。
 */
import type { EventCatalog, EventSpec } from '@kojo/kojo-core';

/** 三事件的公共形状：引擎分发 + Emuera 桶优先级 + 无守卫 */
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
  // 训练：每角色重复定义，靠 `SIF NO:TARGET` 守卫（`family-index.ts:17`）
  event('训练', 'EVENTTRAIN'),
  // 指令：调教指令；编号是 `SELECTCOM` 运行期值 ⇒ 可选 int 参数
  event('指令', 'EVENTCOM', {
    args: Object.freeze([Object.freeze({ name: '编号', kind: 'int' as const, required: false })]),
  }),
  // 训练结束：共享钩子，引擎保证触发（`family-index.ts:17`）
  event('训练结束', 'EVENTEND', { forced: true }),
]);

/** eraAkumaMaid 三事件目录（冻结；`defaultEvent = null` —— 2.0 的 `# 机` 不允许省略事件名） */
export const ERAAKUMAMAID_EVENT_CATALOG: EventCatalog = Object.freeze({
  events: EVENTS,
  defaultEvent: null,
});

/** 事件名清单（诊断文案 / 补全用；顺序 = 三事件固定序） */
export const ERAAKUMAMAID_EVENT_NAMES: readonly string[] = Object.freeze(
  EVENTS.map((spec) => spec.event),
);
