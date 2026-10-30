/**
 * `semanticToken` 供方：把请求里**宿主预取的捕获快照**（`captures`，契约 1 基）裁成
 * 语义 token 区间（B3 语义收口，2026-10-30）。
 *
 * ## 为什么这一格是"搬运 + 最后一道闸"而不是"自己解析"
 *
 * 2.0 的"这段语法是什么角色"来自结构 worker 的 `highlights.scm` 捕获，那是**异步**的；
 * 而槽 `ui.editor.languageService` 的 `provide(request)` 是**同步**的。解法与 B3h 折叠同形：
 * 等待留在宿主（打开 / 改动时预取，按 model 版本缓存），请求里带 `captures` 快照，供方只做：
 *
 * 1. **语言分派**：非 kojo2 ⇒ `undefined`（弃权）；
 * 2. **判据**：捕获名 → 档位、跨行拆段、重叠裁剪、每组预算、注入子树优先——唯一实现在
 *    `@kojo/kojo-lang/semantic`（与宿主建快照时用的是同一批常量）。
 *
 * ## 三态
 *
 * - **非 kojo2 ⇒ `undefined`（弃权）**：宿主这枚 provider 也挂在 ERB / kojo1 上（共享收口按
 *   descriptor 铺语言），弃权让那门语言自己的着色供方接手；
 * - **kojo2 且有快照 ⇒ 区间**（可能为空：这一版确实没有可着色的捕获）；
 * - **kojo2 但**没有快照（`captures` 缺席 = 还没预取到）⇒ `spans: []`（作答，不是弃权）。
 *   头注写明口径：**不异步等待**，下一次预取 / 下一版内容变化后可见。
 *
 * 判据抛错（坏输入）⇒ 空结果，不让异常穿回宿主；表外捕获名只在主树侧告警一次
 * （子树表外的捕获静默丢，与旧宿主同——子树查询自己加档时不该刷作者屏）。
 */
import type {
  EditorLanguageServiceRequest,
  EditorSemanticTokenResult,
} from '@kojo/plugin-api';
import { kojo2SemanticSpansFromCaptures } from '@kojo/kojo-lang/semantic';
import { isKojo2Request } from './request';

/** 一次性告警表（同一捕获名只刷一条；与宿主既有 provider 同纪律） */
const warned = new Set<string>();

/**
 * 从请求全文**惰性**取行最大列（Monaco `getLineMaxColumn` = 行长度 + 1）。
 *
 * 为什么惰性：只有**跨行捕获**需要行几何；捕获得到了才拆一次全文（O(行数)）。
 * 单行捕获不查行长——宿主最后一道 `normalizeSemanticSpans` 会把列夹回模型现实。
 */
function maxColumnOfText(text: string): (line: number) => number {
  let widths: number[] | null = null;
  return (line) => {
    if (widths === null) widths = text.split('\n').map((row) => row.length + 1);
    return widths[line - 1] ?? 1;
  };
}

/** 交回 `{ kind: 'semanticToken', spans }`，或 `undefined`（弃权：不是这个 kind / 不是 kojo2） */
export function provideSemanticTokens(
  request: EditorLanguageServiceRequest,
): EditorSemanticTokenResult | undefined {
  if (request.kind !== 'semanticToken') return undefined;
  if (!isKojo2Request(request)) return undefined;
  try {
    const spans = kojo2SemanticSpansFromCaptures(request.captures, {
      lineCount: request.lineCount ?? 0,
      maxColumn: maxColumnOfText(request.text),
      onUnknownCapture: (name) => {
        if (warned.has(name)) return;
        warned.add(name);
        console.warn(
          `[kojo2-semantic] 捕获「@${name}」不在 KOJO2_CAPTURE_TOKEN_TYPES 里 ⇒ 这一条不着色；` +
            '要么在 @kojo/kojo-lang/semantic 给它补档位，要么删掉这条捕获',
        );
      },
    });
    return { kind: 'semanticToken', spans };
  } catch {
    // 快照形状不对 ⇒ 空结果（作者看到的是"这一版没有结构色"，看得见、不崩）
    return { kind: 'semanticToken', spans: [] };
  }
}