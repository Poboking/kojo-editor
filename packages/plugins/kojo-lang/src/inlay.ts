/**
 * `inlayHint` 供方：包里的纯提示 → 契约的 `EditorInlayHint`。
 *
 * ## 只做三件事，各自都有理由
 *
 * 1. **语言分派**（`isKojo2Request`）——不认就弃权，让下一家接手；
 * 2. **类别翻译**（`Kojo2InlayHintKind` → `EditorInlayHintKind`）：包里的三种是**语言语义**
 *    （类型 / 绑定名 / 表档摘要），契约的三种是**编辑器怎么画**（类型色 / 形参色 / 无色）。
 *    两者不同构，中间必须有一张表，而这张表属于"谁懂语言谁翻译"——放包或放宿主都是错位；
 * 3. **坐标改名**（`position.lineNumber` → `line`）：包里沿用 Monaco 的字段名（`lineNumber`）
 *    是因为它是从宿主搬过来的、刻意**一个字没改**；契约用的是 `line`。这一层就是把
 *    "搬过来的形状"对到"契约的形状"，不夹取、不排序、不丢条（越界由宿主夹取/丢弃）。
 *
 * ## 不做什么
 *
 * - **不判体量降级**：`lineCount` 在请求里，但"多少行以上不给提示"是**宿主的产品决策**
 *   （`LARGE_FILE_LINES` 那条线同时管粘性滚动 / 面包屑 / codeLens），供方按纪律不据此少报；
 * - **不自己找 adapter**：`@巡` 命名集合要 adapter 事实，而 adapter 由**调用方**经
 *   `adapter` 参数递进来（`plugin.ts` 在请求时现取）。本函数仍是纯的——同一组入参必得
 *   同一组输出；"谁算当前 adapter"是组合根的事，不是判据的事。
 *   没有 adapter ⇒ 只给"本文件自己能证明的数组事实"，命名集合那一路留空（**不猜**）。
 */
import type {
  EditorInlayHint,
  EditorInlayHintKind,
  EditorLanguageServiceRequest,
} from '@kojo/plugin-api';
// 2.0 adapter 的形状住 `@kojo/kojo-core`（`eventCatalog` / `kojo2.foreachCollections` 都在那边），
// 与 `@kojo/plugin-api` 的 v1 `GameAdapter`（`gameId` / `displayName`）**不是同一个类型**。
// 两者混用会编译不过，而不是"差不多能用"——这正是契约把 2.0 事实单列的原因。
import type { GameAdapter } from '@kojo/kojo-core';
import { kojo2InlayHints, type Kojo2InlayHint, type Kojo2InlayHintKind } from '@kojo/kojo-lang/inlay';
import { isKojo2Request } from './request';

/**
 * 语言语义类别 → 编辑器画法（**唯一映射表**）。
 *
 * - `type` → `type`：`# 变量 好感度 整数` 行尾那个 `整数` 就是类型，用类型色；
 * - `binding` → `parameter`：绑定名与形参名是同一句话"这个名字代表哪个值"，同一档颜色；
 * - `value` → `text`：表档摘要（`3 档 / 有兜底`）不是类型也不是形参，**不借邻居的颜色**
 *   ——Monaco 没有"摘要"这一档，硬借会让作者以为那是个参数。
 */
const HINT_KIND: Readonly<Record<Kojo2InlayHintKind, EditorInlayHintKind>> = {
  type: 'type',
  binding: 'parameter',
  value: 'text',
};

/** 纯提示 → 契约提示（纯映射，零判读；`paddingLeft` 只在为真时写出，与旧形状逐字一致） */
export function toEditorInlayHints(hints: readonly Kojo2InlayHint[]): EditorInlayHint[] {
  return hints.map((hint) => ({
    line: hint.position.lineNumber,
    column: hint.position.column,
    label: hint.label,
    kind: HINT_KIND[hint.kind],
    ...(hint.paddingLeft === true ? { paddingLeft: true } : {}),
  }));
}

/**
 * 交回 `{ kind: 'inlayHint', hints }`，或 `undefined`（弃权）。
 *
 * 抛错面：`kojo2InlayHints` 内部已对词法/语法失败回空数组；这里再兜一层——宿主会把 throw
 * 吞成"提示突然没了"，空数组至少是"这篇没有可证明的提示"这个**有语义**的答案。
 */
/** 可选注入面（缺省 = 只用本文件能证明的数组事实，不猜命名集合） */
export interface InlayAdapterInjection {
  /** 当前项目的 2.0 adapter（`@巡` 命名集合 / 作者数组规则的唯一来源） */
  readonly adapter?: GameAdapter | null;
}

export function provideInlayHints(
  request: EditorLanguageServiceRequest,
  injection: InlayAdapterInjection = {},
): { kind: 'inlayHint'; hints: EditorInlayHint[] } | undefined {
  if (request.kind !== 'inlayHint') return undefined;
  if (!isKojo2Request(request)) return undefined;
  try {
    // R1（2026-10-28）：宿主给的行窗口原样下传。判据不变——`kojo2InlayHints` 只少判
    // 窗口外的行；整篇 lex+parse 仍照旧（这也是宿主今天**不给** `kojo2` 传窗口的原因：
    // 那份解析 24,197 行实测 57.7 ms，窗口只省下 12 ms，换屏重跑反而更贵）。
    const hints = kojo2InlayHints(request.text, request.range, {
      adapter: injection.adapter ?? null,
    });
    return { kind: 'inlayHint', hints: toEditorInlayHints(hints) };
  } catch {
    return { kind: 'inlayHint', hints: [] };
  }
}
