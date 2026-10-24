/**
 * eraFL 2.0 演出面（游戏事实 —— 只住本包）。
 *
 * **四项全部不支持（null）**——这不是缺漏，是 eraFL 的结构事实（§2.1）：
 * eraFL 的口上内容在 XML 里（`<command com="300" name="会話" kojoPlace="TOP">`，
 * 演出随属性走：`kojoPlace` / `priority` / `emotion` 一族，白名单见 v1
 * `preview/conditions.ts`），ERB 侧只剩注册壳。心形 / 着色 / 颜绘 / 选项都是
 * **ERB 指令面**的 2.0 构造，在 eraFL 的编辑主战场里没有落点。
 *
 * 真盘佐证（2026-10-24）：`SETCOLOR` 在 `ERB/口上` 下抽 50 份注册壳里出现
 * **0 次**（全树 183 次都在 QUEST/TRAIN 流程档，不归 2.0 语言面）。
 *
 * 未声明的面在使用时报"当前 adapter 不支持"（`core/feature/unsupported` 等，
 * fail-visible）——**不静默降级**，也不借 eraTW 的落点冒充。XML 属性面的 2.0
 * 化（含着色/表情在 XML 里的形态）是入口 E 的设计决策，本入口不预埋。
 */
import type { AdapterPresentation } from '@kojo/kojo-core';

/** eraFL 2.0 演出面：四项均未声明（全部 null 也算"声明了哪些面可用"） */
export const ERAFL_PRESENTATION: AdapterPresentation = Object.freeze({
  heart: null,
  color: null,
  face: null,
  options: null,
});
