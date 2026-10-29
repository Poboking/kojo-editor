/**
 * Kojo 2.0 的**同符号高亮**：**契约 → Monaco DocumentHighlight 的翻译层**
 * （B3f，2026-10-29 供方交给插件）。
 *
 * ## 这一格里只剩"翻译"，判据一枚都不留
 *
 * 本文件曾同时住着**判据**（光标处符号识别 / write·read·text 三档扫描 / 词边界与位置门）、
 * 一枚 provider 安装器与 Monaco 形状翻译。B3f 把判据整块搬进 `@kojo/kojo-lang/highlight`，
 * 作答的是插件 `@kojo/plugin-kojo-lang` 在 `ui.editor.languageService` 槽里登记的
 * `kojo2-documentHighlight` 贡献。这里若再留一份判据当"兜底"，同一格就有两份答案——
 * Monaco 对同符号高亮取并集，"多一处 / 少一处、这一处算读还是写"从此只能靠注册顺序解释。
 *
 * ## 留下的三件事，每一件都是"插件看不到"的宿主事实
 *
 * 1. **model → 请求**：`path` / `languageId` / `version` 原样取自 model（宿主管线不改写、
 *    不猜）、全文、光标位点与当前项目；
 * 2. **响应 → Monaco `DocumentHighlight[]`**：契约的单行区间（`line` + 起止列）→ 同数值的
 *    `IRange`，档位 → `DocumentHighlightKind`（{@link kojo2HighlightKindToMonaco} 是**唯一**
 *    映射表；契约的 `kind` 必填，缺省不猜）；
 * 3. **注册**：经 `registerForLanguageServices(monaco, register, 'documentHighlight')` 挂上
 *    （kojo2 由 descriptor 的 `slotServices` 点名）。当年那枚"注册调用第一个参数直接写死
 *    `KOJO2_LANGUAGE_ID`"的自建安装器已随批删除（闸门正是按那条形状 grep 归零的）。
 *
 * ## 三态
 *
 * 无人应答（插件没装 / 弃权）⇒ **`undefined`**（不是 `[]`）：Monaco 对同符号高亮按
 * "第一个非空应答的 provider"裁决，而 `[]` 是**有效作答**——交空数组会把排在后头的
 * 提供方（Monaco 内建词高亮 / 那门语言自己的 provider）整段顶掉。所以：
 * 有人作答但 `highlights` 为空（认这门语言、这处没有可高亮的符号）⇒ `[]`（定义性作答，
 * 单答裁决已在 legs 收口）；无人应答 ⇒ `undefined`（照常轮到下一家）。provider 内任何
 * 异常（坏文件 / 取文抛错 / 模型已释放）一律回 `[]`——它已经"认领了这一格"，再交
 * `undefined` 会让别的 provider 在异常之上叠一层解释不清的高亮。
 *
 * ## 开关
 *
 * 同符号高亮是**只读呈现面**（K2-SURFACE-DEFAULT）：不读切流开关，装配即注册。
 */
import type * as Monaco from './entry';
import type { EditorDocumentHighlightKind } from '@kojo/plugin-api';
import { requireKernel } from '../ui/editor-pane-registry';
import {
  collectDocumentHighlights,
  documentHighlightRequestOf,
  editorRequestIdentityOf,
  modelTextOf,
} from './kojo-language-service-legs';
import { registerForLanguageServices } from './register-dialects';

/* ============================== Monaco 翻译层 ============================== */

/**
 * 档位 → Monaco `DocumentHighlightKind`（**唯一映射表**）。
 *
 * `text` = `Text`：Monaco 只画一层弱框（"同名文字"）；`read` / `write` = 引用 / 声明。
 */
export function kojo2HighlightKindToMonaco(
  monaco: typeof Monaco,
  kind: EditorDocumentHighlightKind,
): Monaco.languages.DocumentHighlightKind {
  const K = monaco.languages.DocumentHighlightKind;
  switch (kind) {
    case 'text':
      return K.Text;
    case 'read':
      return K.Read;
    case 'write':
      return K.Write;
  }
}

/* ============================== 安装 ============================== */

/**
 * 为 `kojo2` 语言注册文档高亮 provider，返回**幂等** disposable。
 *
 * - **无条件注册**（K2-SURFACE-DEFAULT）：只读呈现面，切流阶段 `v1-only` 下也照常可见；
 * - 注册经共享收口 + 能力名 `documentHighlight`（kojo2 由 descriptor 点名）；落到 ERB /
 *   kojo1 上的那一枚不会抢它们：插件对非 kojo2 请求弃权，本层交回空列表；
 * - provider 内任何异常回 `[]`；
 * - 注册失败原样外抛（只有一枚注册，没有半成品要回滚）。
 */
export function installKojo2HighlightProvider(monaco: typeof Monaco): Monaco.IDisposable {
  const provider: Monaco.languages.DocumentHighlightProvider = {
    provideDocumentHighlights(model, position) {
      try {
        const text = modelTextOf(model);
        if (text === null) return [];
        const kernel = requireKernel();
        // 单答裁决在 legs（`collectDocumentHighlights` 第一家作答）；这里只递请求、翻形状。
        const result = collectDocumentHighlights(
          kernel.slots.query('ui.editor.languageService'),
          documentHighlightRequestOf(
            editorRequestIdentityOf(model),
            text,
            position.lineNumber,
            position.column,
            kernel.project.current(),
          ),
        );
        if (result === undefined) {
          // 无人应答：交 `undefined`（交 `[]` 会按"第一应答"规则顶掉下一家）。
          return undefined;
        }
        return result.highlights.map((highlight) => ({
          range: {
            startLineNumber: highlight.line,
            startColumn: highlight.startColumn,
            endLineNumber: highlight.line,
            endColumn: highlight.endColumn,
          },
          kind: kojo2HighlightKindToMonaco(monaco, highlight.kind),
        }));
      } catch {
        // Monaco 把 throw 吞成"高亮突然没了"；空数组是它能读出的唯一形状。
        return [];
      }
    },
  };

  // 注册失败原样外抛：`registerForLanguageServices` 已把半途挂上的逐枚撤回（见 register-dialects.ts）。
  const registration = registerForLanguageServices(
    monaco,
    (m, id) => m.languages.registerDocumentHighlightProvider(id, provider),
    // 带能力名：descriptor 的 `slotServices` 点了 `documentHighlight` 的语言（kojo2）也挂这一枚。
    'documentHighlight',
  );

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        registration.dispose();
      } catch {
        /* 幂等 + 不抛：一枚撤不掉不许把卸载链带崩（错误也没有第二个消费者） */
      }
    },
  };
}
