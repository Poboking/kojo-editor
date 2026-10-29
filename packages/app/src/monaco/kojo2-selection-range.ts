/**
 * Kojo 2.0 的**选择范围**：**契约 → Monaco SelectionRange 的翻译层**
 * （B3f，2026-10-29 供方交给插件）。
 *
 * ## 这一格里只剩"翻译"，层级判据一枚都不留
 *
 * 本文件曾同时住着**层级判据**（词 → 行 → 块（声明体 / `?` 分支体 / `@原生` 整块 /
 * `# 机` 体）→ 幕 → 全文，以及"表行整行、`?` 链按分支、尾随空行不吃外层"这些边界）、
 * 一枚 provider 安装器与形状翻译。B3f 把判据整块搬进
 * `@kojo/kojo-lang/selection-range`，作答的是插件 `@kojo/plugin-kojo-lang` 在
 * `ui.editor.languageService` 槽里登记的 `kojo2-selectionRange` 贡献。
 *
 * 这里若再留一份层级当"兜底"，同一格就有两份答案：Monaco 只认一个 provider 的扩选链，
 * "按一下扩到哪一级"从此只能靠注册顺序解释。
 *
 * ## 留下的三件事
 *
 * 1. **model → 请求**：全文 + **全部位点**（Monaco 多光标一次就问多个）+ 身份三格 + 项目；
 *    位点原样递（1 基，与 `Position` 同列口径），宿主不排序、不夹取；
 * 2. **响应 → Monaco 0.57 的扁平数组**：契约给的是经典嵌套链 `{ range, parent? }`（最内层
 *    在前，`parent` 逐级向外），而 0.57 的 provider 入参形状是"**每位点一个
 *    `SelectionRange[]`**（内 → 外）"——摊平**只在这一层做**（换 Monaco 版本只动这里）。
 *    契约里的 `null`（该位点空链）摊成空数组：**不夹取、不猜**，也绝不缩短别的位点；
 * 3. **注册**：经 `registerForLanguageServices(monaco, register, 'selectionRange')` 挂上
 *    （kojo2 由 descriptor 的 `slotServices` 点名）。当年那枚直挂 `KOJO2_LANGUAGE_ID` 的
 *    自建安装器已随批删除。
 *
 * ## 三态
 *
 * 无人应答（插件没装 / 弃权）⇒ **`undefined`**（不是 `[]`）——这一格 Monaco 会把所有
 * provider 的答案并起来（还恒有内建词语扩选兜底），所以空表本身不致命；但"没人应答"
 * 就不该由本层伪造一份空作答（那是把"没有这条能力"说成"这条能力说没有"）。
 * 作答但某位点 `null` ⇒ 该位点 `[]`，其余位点照常（单答裁决已在 legs 收口）；
 * provider 内异常 ⇒ `[]`——Monaco 把 throw 吞成"扩选突然没了"。
 *
 * ## 开关
 *
 * 结构化扩选是**只读呈现面**（K2-SURFACE-DEFAULT）：不读切流开关，装配即注册。
 */
import type * as Monaco from './entry';
import type { EditorSelectionChain } from '@kojo/plugin-api';
import { requireKernel } from '../ui/editor-pane-registry';
import {
  collectSelectionRanges,
  editorRequestIdentityOf,
  modelTextOf,
  selectionRangeRequestOf,
} from './kojo-language-service-legs';
import { registerForLanguageServices } from './register-dialects';

/* ============================== Monaco 翻译层 ============================== */

/** 契约链 → 0.57 provider 的扁平数组（内 → 外；运行时自己会按包含关系再排一遍） */
function flattenChain(chain: EditorSelectionChain): Monaco.languages.SelectionRange[] {
  const out: Monaco.languages.SelectionRange[] = [];
  let cursor: EditorSelectionChain | undefined = chain;
  while (cursor !== undefined) {
    out.push({
      range: {
        startLineNumber: cursor.range.startLine,
        startColumn: cursor.range.startColumn,
        endLineNumber: cursor.range.endLine,
        endColumn: cursor.range.endColumn,
      },
    });
    cursor = cursor.parent;
  }
  return out;
}

/* ============================== 安装 ============================== */

/**
 * 为 `kojo2` 语言注册选择范围 provider，返回**幂等** disposable。
 *
 * - **无条件注册**（K2-SURFACE-DEFAULT：结构化扩选是只读呈现面，不读切流开关）；
 * - 注册经共享收口 + 能力名 `selectionRange`（kojo2 由 descriptor 点名）；
 * - provider 内任何异常回 `[]`；
 * - 注册失败原样外抛（只有一枚注册，没有半成品要回滚）。
 */
export function installKojo2SelectionRangeProvider(
  monaco: typeof Monaco,
): Monaco.IDisposable {
  const provider: Monaco.languages.SelectionRangeProvider = {
    provideSelectionRanges(model, positions) {
      try {
        const text = modelTextOf(model);
        if (text === null) return [];
        const wanted = Array.isArray(positions)
          ? positions.map((position) => ({ line: position.lineNumber, column: position.column }))
          : [];
        const kernel = requireKernel();
        const result = collectSelectionRanges(
          kernel.slots.query('ui.editor.languageService'),
          selectionRangeRequestOf(
            editorRequestIdentityOf(model),
            text,
            wanted,
            kernel.project.current(),
          ),
        );
        if (result === undefined) {
          // 无人应答：交 `undefined`（不伪造一份"没有扩选"的作答）。
          return undefined;
        }
        return result.selections.map((chain) => (chain === null ? [] : flattenChain(chain)));
      } catch {
        return [];
      }
    },
  };

  // 注册失败原样外抛：`registerForLanguageServices` 已把半途挂上的逐枚撤回（见 register-dialects.ts）。
  const registration = registerForLanguageServices(
    monaco,
    (m, id) => m.languages.registerSelectionRangeProvider(id, provider),
    // 带能力名：descriptor 的 `slotServices` 点了 `selectionRange` 的语言（kojo2）也挂这一枚。
    'selectionRange',
  );

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        registration.dispose();
      } catch {
        /* 幂等 + 不抛 */
      }
    },
  };
}
