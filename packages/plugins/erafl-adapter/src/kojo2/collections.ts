/**
 * eraFL 2.0 `@巡` 集合声明（K2-FOREACH；additive）。
 *
 * **`null` = 本 adapter 不支持 `@巡`**（契约合法值：老 adapter 传 null 即可，
 * 零改动）。eraFL 真盘没有 `@巡` 语料（2.0 构造），也没有可枚举的命名集合
 * 台账——队伍一类的集合是 eraTW 的游戏事实，不跨游戏借。
 *
 * `programFeatures.foreach = false` 与本文本同步（能力闸与数据面自洽）：
 * 作者在 eraFL 2.0 文件里写 `@巡` 会得到 fail-visible 的
 * `core/control/unsupported`，而不是静默落成别的东西。
 *
 * 作者数组规则（`#DIMS 名, N`，154 处在用）走 `programFeatures.arrays` 的
 * 普通数组面，不需要集合声明——两者是不同的落点，不混为一谈。
 */
import type { ForeachDeclarations } from '@kojo/kojo-core';

/** eraFL：无 `@巡` 语料 ⇒ 不声明集合（null = 不支持，不猜、不借） */
export const ERAFL_FOREACH_DECLARATIONS: ForeachDeclarations | null = null;
