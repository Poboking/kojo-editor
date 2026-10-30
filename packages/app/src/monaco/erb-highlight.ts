/**
 * ERB 的**同符号高亮**：**契约 → Monaco DocumentHighlight 的翻译层**
 * （LAU-4 第一步，2026-10-30；供方交给插件 `@kojo/plugin-erb-lang`）。
 *
 * ## 这一格里只剩"翻译"，判据一枚都不留
 *
 * 本文件曾同时住着**判据**（光标处符号识别 / write·read·text 三档扫描 / 词边界与位置门 /
 * `[SKIPSTART]` 死区 / 控制流块配对）、一枚 provider 安装器与 Monaco 形状翻译。
 * LAU-4 把判据整块搬进 `@kojo/erb-lang/highlight`，作答的是插件 `@kojo/plugin-erb-lang`
 * 在 `ui.editor.languageService` 槽里登记的 `erb-documentHighlight` 贡献。这里若再留一份
 * 判据当"兜底"，同一格就有两份答案——Monaco 对同符号高亮取"第一非空应答"，
 * "多一处 / 少一处、这一处算读还是写"从此只能靠注册顺序解释。
 *
 * ## 留下的三件事，每一件都是"插件看不到"的宿主事实
 *
 * 1. **model → 请求**：`path` / `languageId` / `version` 原样取自 model（宿主管线不改写、
 *    不猜）、全文、光标位点与当前项目；
 * 2. **响应 → Monaco `DocumentHighlight[]`**：契约的单行区间（`line` + 起止列）→ 同数值的
 *    `IRange`，档位 → `DocumentHighlightKind`（{@link erbHighlightKindToMonaco} 是**唯一**
 *    映射表；契约的 `kind` 必填，缺省不猜）；
 * 3. **注册**：经 `registerForLanguageServices(monaco, register, 'documentHighlight')` 挂上
 *    ——ERB descriptor 已声明 `languageServices: true`，共享收口按 descriptor 铺；
 *    当年那枚"注册调用第一个参数直接写死 `ERB_LANGUAGE_ID`"的原生安装器已随批删除
 *    （闸门正是按那条形状 grep 归零的）。
 *
 * ## 三态
 *
 * 无人应答（插件没装 / 弃权）⇒ **`undefined`**（不是 `[]`）：Monaco 对同符号高亮按
 * "第一个非空应答的 provider"裁决，而 `[]` 是**有效作答**——交空数组会把排在后头的
 * 提供方（Monaco 内建词高亮 / 那门语言自己的 provider）整段顶掉。所以：
 * 有人作答但 `highlights` 为空 ⇒ `[]`（定义性作答）；无人应答 ⇒ `undefined`。
 * provider 内任何异常一律回 `[]`——它已经"认领了这一格"，再交 `undefined` 会让别的
 * provider 在异常之上叠一层解释不清的高亮。
 *
 * ## 开关
 *
 * 同符号高亮是**只读呈现面**（K2-SURFACE-DEFAULT）：不读切流开关，装配即注册。
 * 与结构层那条实验开关（`kojo.ui.treeSitter.v1`）无关。
 */
import type * as Monaco from './entry';
import type { EditorDocumentHighlightKind } from '@kojo/plugin-api';
import { requireKernel } from '../ui/editor-pane-registry';
import { ERB_LANGUAGE_ID } from './erb-language';
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
 * `text` = `Text`（Monaco 只画一层弱框）、`read` = `Read`、`write` = `Write`。
 * 判据那侧（`@kojo/erb-lang/highlight`）的档位值域与契约逐字相同，本函数是整条链上
 * **唯一**把它们翻成 Monaco 枚举的地方。
 */
export function erbHighlightKindToMonaco(
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
 * 共享收口会把这枚 provider 也挂到 kojo2（两门语言都 `languageServices: true`）。
 * 宿主层必须先按 model 的语言弃权：插件只按请求里的 `languageId` 认语言，而 kojo2 的
 * 请求会由 kojo2 那家插件作答——不弃权就会在 kojo2 里叠出**两份**同一结果。
 * 老桩 model 没有 `getLanguageId` ⇒ 保持旧行为（直接调用方按 ERB 用）。
 */
function servesErb(model: Monaco.editor.ITextModel): boolean {
  try {
    const id = model.getLanguageId();
    return typeof id !== 'string' || id.length === 0 || id === ERB_LANGUAGE_ID;
  } catch {
    return true;
  }
}

/**
 * 为声明了通用语言服务的语言（ERB 是其中之一）注册文档高亮 provider，返回**幂等**
 * disposable。
 *
 * - **无条件注册**（K2-SURFACE-DEFAULT）：只读呈现面，切流阶段 `v1-only` 下也照常可见；
 * - 注册经共享收口 + 能力名 `documentHighlight`——落到 `.kojo` / `kojo2` 上的那一枚不会抢
 *   它们：插件对非 ERB 请求弃权，本层交回空列表/`undefined`；
 * - provider 内任何异常回 `[]`；
 * - 注册失败原样外抛（共享收口已把半途挂上的逐枚撤回，见 `register-dialects.ts`）。
 */
export function installErbHighlightProvider(monaco: typeof Monaco): Monaco.IDisposable {
  const provider: Monaco.languages.DocumentHighlightProvider = {
    provideDocumentHighlights(model, position) {
      try {
        if (!servesErb(model)) return undefined;
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
          kind: erbHighlightKindToMonaco(monaco, highlight.kind),
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
    // 带能力名：descriptor 点名了 `documentHighlight` 的语言（kojo2）也挂这一枚；
    // ERB 由 `languageServices: true` 收进来（与其它 11 枚共享 provider 同一条路）。
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
