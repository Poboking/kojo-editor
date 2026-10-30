/**
 * `codeLens` 供方：包里的行上注解判据（`@kojo/kojo-lang/codelens`）→ 契约的
 * `EditorCodeLensResult`（B3g，2026-10-30）。
 *
 * ## 这一格回答什么
 *
 * 整篇 → 三条行型的注解：`# 机`（事件 + 参数个数）、`@织`（事件 + 监听层）、
 * `@函`（被用到几处）。判据、词形、列口径、大文件闸**一枚都不在本文件**——这里是供方，
 * 只做"请求 → 包的调用 → 契约形状"。
 *
 * ## 三态（与 hover / references / documentHighlight 同一条纪律）
 *
 * - **非 kojo2 请求 ⇒ `undefined`（弃权）**：宿主那枚 provider 也经共享收口挂在别的语言上
 *   （按 descriptor 铺），弃权让它交回空结果、**不**去顶掉那门语言自己的 code lens 供方；
 * - **认这门语言 ⇒ 总是作答**：`lenses: []` = 这一篇没有可证明的注解（**不是**弃权）；
 * - 快照不完整（`projectFilesComplete === false`）⇒ 照样作答，计数那几条的标题如实写
 *   「未看全」（判据在包里，标法只此一份）。
 *
 * ## 点击去向（为什么 `mode` 不进契约）
 *
 * 包的注解带 `target.mode`（`reveal` / `references`），但契约的 `EditorCodeLens.target` 是
 * `EditorSymbolLocation`（文件 + 行 + 列 + 区间），没有去向判别位；宿主落地一律走既有导航
 * 通道 `editor.revealLocation`。B3g 之前那个 `mode` 也**从未被消费**（宿主命令处理端第一行
 * 就判掉它，只读 `filePath` / `line`），所以这里丢掉它**不改任何实际行为**：`@函` 的注解
 * 今天落到函数名那一处，与 `# 机` / `@织` 同一条腿。将来真要"点开引用面"，那是宿主侧
 * 新增一条分流（契约要 additive 一格），不该靠这里偷偷塞进 `arguments`。
 *
 * ## 文件身份
 *
 * 请求的 `path` 为空（桩 model / 无文件身份）⇒ **不给 `target`**：契约口径
 * "省略 = 这条注解不可点"，宿主据此交空参数——与"写一个点不动的假落点"是两件事。
 */
import type {
  EditorCodeLens,
  EditorCodeLensResult,
  EditorLanguageServiceRequest,
} from '@kojo/plugin-api';
import { kojo2CodeLenses } from '@kojo/kojo-lang/codelens';
import { isKojo2Request } from './request';

/** 交回 `{ kind: 'codeLens', lenses }`，或 `undefined`（弃权：不是 codeLens / 不是 kojo2） */
export function provideCodeLenses(
  request: EditorLanguageServiceRequest,
): EditorCodeLensResult | undefined {
  if (request.kind !== 'codeLens') return undefined;
  if (!isKojo2Request(request)) return undefined;
  try {
    const path = request.path.length > 0 ? request.path : undefined;
    const lenses = kojo2CodeLenses(request.text, {
      ...(path === undefined ? {} : { path }),
      ...(request.projectFiles === undefined ? {} : { projectFiles: request.projectFiles }),
      ...(request.projectFilesComplete === undefined
        ? {}
        : { projectFilesComplete: request.projectFilesComplete }),
    });
    const out: EditorCodeLens[] = [];
    for (const lens of lenses) {
      out.push({
        line: lens.line,
        label: lens.title,
        ...(path === undefined
          ? {}
          : {
              target: {
                filePath: path,
                line: lens.target.line,
                column: lens.target.column,
                span: {
                  columnStart: lens.target.span.columnStart,
                  columnEnd: lens.target.span.columnEnd,
                },
              },
            }),
      });
    }
    return { kind: 'codeLens', lenses: out };
  } catch {
    // 判据抛错（坏输入 / 意外）⇒ 空结果：注解是只读呈现面，"这一篇没有注解"是作者能读懂的退化。
    return { kind: 'codeLens', lenses: [] };
  }
}
