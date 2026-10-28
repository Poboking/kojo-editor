/**
 * Kojo 2.0 的文档格式化：**契约 → Monaco 的翻译层**（B3d，2026-10-28 供方交给插件）。
 *
 * ## 这一格里只剩"翻译"，规则一枚都不留
 *
 * 本文件曾经同时住着**规则**（缩进归一 / 空行呼吸 / 行尾空白 / EOL 保留 / 幂等 + 可解析两道闸）、
 * **两枚 provider 安装器**与一枚 `applyKojo2Format` 落地端口。B3d 把规则整块搬进
 * `@kojo/kojo-lang/format`（`formatKojo2Source` / `formatKojo2Range`），作答的是插件
 * `@kojo/plugin-kojo-lang` 在 `ui.editor.languageService` 槽里登记的 `kojo2-formatting` 贡献；
 * `applyKojo2Format` **随批删除**（无生产消费方——保存链路本来就不接它，只有测试在调）。
 *
 * 这里若再留一份规则当"兜底"，同一格就有两份答案：Monaco 对格式化按"候选人第一位"落地，
 * 两枚 provider 并存时"排出来的是谁那一版"从此只能靠注册顺序解释。
 *
 * ## 一整条能力 = 两枚 provider（`Shift+Alt+F` + `Ctrl+K Ctrl+F`）
 *
 * 两枚都只是"model + 选区 → 请求"与"契约 edits → Monaco `TextEdit`"：
 * - 整篇那条 `lineRange` **不填**（缺省 = 整篇，与加这一格之前逐字相同）；
 * - 区间那条把 Monaco 的 range 折成 `{ startLine, endLine }` 两枚**行号**（1 基、闭区间）塞进
 *   请求——不切串、不折列：2.0 的缩进深度是文档级判据、围栏状态跨行，切片视角会排错。
 *
 * ## 注册：共享收口 + 能力名
 *
 * 两枚都经 `registerForLanguageServices(monaco, register, 'formatting')` 挂上（kojo2 由
 * descriptor 的 `slotServices` 点名）。落到 ERB / kojo1 上的这一枚**不会**抢它们的格式化：
 * 插件对非 kojo2 请求弃权，本层交回空结果；而它们自己的格式化 provider（`kojo-format.ts` /
 * `kojo-format-range.ts`）是**后注册**的，Monaco 的 provider 顺序是"同分同档时后注册在前"，
 * 所以真被问到第一位的是那枚——两门语言的排版结果零改动（`kojo-format.ts` 头注里那条
 * "一门语言一枚 provider"的纪律因此仍然成立：同一门语言真正作答的那一枚没变）。
 *
 * ## 失败面与 disposal（与删规则之前同一条纪律，没有改弱）
 *
 * - 每轮各带 try-catch：取文失败 / 没有编辑器实例（`requireKernel` 抛）/ 编排抛 ⇒ 空 edits
 *   （Monaco 把 throw 吞成"格式化突然没反应"，空结果就是它读得懂的"这次没改"）；
 * - 注册半途抛错 ⇒ 先撤回已挂上的那几枚再外抛；返回的 disposable 幂等且逐枚隔离。
 *
 * ## 开关
 *
 * 格式化是**语言面**（K2-SURFACE-DEFAULT）：不读切流开关，装配即注册。它只服务显式格式化
 * 动作——作者不按快捷键就不动缓冲内容。
 */
import type * as Monaco from './entry';
import type { EditorRangeEdit } from '@kojo/plugin-api';
import { requireKernel } from '../ui/editor-pane-registry';
import {
  collectFormattingEdits,
  editorRequestIdentityOf,
  formattingRequestOf,
  modelTextOf,
} from './kojo-language-service-legs';
import { registerForLanguageServices } from './register-dialects';

/** 契约区间编辑的列缺省口径：`startColumn` 缺省 = 行首，`endColumn` 缺省 = 行尾（Monaco 口径） */
function textEditsOf(
  model: Monaco.editor.ITextModel,
  edits: readonly EditorRangeEdit[],
): Monaco.languages.TextEdit[] {
  const out: Monaco.languages.TextEdit[] = [];
  for (const edit of edits) {
    let endColumn = edit.endColumn;
    if (endColumn === undefined) {
      try {
        endColumn = model.getLineMaxColumn(edit.endLine);
      } catch {
        endColumn = 1; // 桩 model：不猜列，退成零宽（供方都会给列，这一格只服务别家）
      }
    }
    out.push({
      range: {
        startLineNumber: edit.startLine,
        startColumn: edit.startColumn ?? 1,
        endLineNumber: edit.endLine,
        endColumn,
      },
      text: edit.newText,
    });
  }
  return out;
}

/**
 * 整篇格式化（`Shift+Alt+F`，槽腿能力名 `formatting`），返回**幂等** disposable。
 *
 * Monaco 把返回的 edits 一次 `executeEdits('formatEditsCommand', …)` 落地 ⇒ 天然一个撤销步；
 * 这里只做"该不该应答 + 形状翻译"，不碰 undo 停点。
 */
export function installKojo2DocumentFormatter(monaco: typeof Monaco): Monaco.IDisposable {
  const provider: Monaco.languages.DocumentFormattingEditProvider = {
    displayName: 'kojo-editor',
    provideDocumentFormattingEdits(model): Monaco.languages.TextEdit[] {
      try {
        const text = modelTextOf(model);
        if (text === null) return [];
        const kernel = requireKernel();
        // 单答裁决在 legs（`collectFormattingEdits` 第一家作答）；`undefined` = 无人应答，
        // `[]` = 有人认这篇且不需要改——两种都落成"没有 edits"，宿主不再分辨。
        const edits = collectFormattingEdits(
          kernel.slots.query('ui.editor.languageService'),
          formattingRequestOf(editorRequestIdentityOf(model), text, kernel.project.current()),
        );
        if (edits === undefined || edits.length === 0) return [];
        return textEditsOf(model, edits);
      } catch {
        return [];
      }
    },
  };

  const registrations: Monaco.IDisposable[] = [];
  try {
    registrations.push(
      registerForLanguageServices(
        monaco,
        (m, id) => m.languages.registerDocumentFormattingEditProvider(id, provider),
        // 带能力名：descriptor 的 `slotServices` 点了 `formatting` 的语言（kojo2）也挂这一枚。
        'formatting',
      ),
    );
  } catch (error) {
    for (const registration of registrations) {
      try {
        registration.dispose();
      } catch {
        /* 半途回滚：一枚撤不掉不许带走其余（错误原样外抛给宿主） */
      }
    }
    throw error;
  }
  return disposableOf(registrations);
}

/** 幂等 + 逐枚隔离的句柄（两枚安装器同一条） */
function disposableOf(registrations: readonly Monaco.IDisposable[]): Monaco.IDisposable {
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const registration of registrations) {
        try {
          registration.dispose();
        } catch {
          /* 撤不掉也不外抛 */
        }
      }
    },
  };
}

/**
 * 区间格式化（`Ctrl+K Ctrl+F`，同一条能力名 `formatting`），返回**幂等** disposable。
 *
 * 与整篇同一条纪律：只做"该不该应答 + 形状翻译"；规则本体在包里（整篇算 + 行映射裁剪），
 * 本函数一个缩进判据都不写。选区折成 `lineRange` 时**只递行号**——列由供方按整篇判据自己决定。
 */
export function installKojo2RangeFormatter(monaco: typeof Monaco): Monaco.IDisposable {
  const provider: Monaco.languages.DocumentRangeFormattingEditProvider = {
    displayName: 'kojo-editor',
    provideDocumentRangeFormattingEdits(model, range): Monaco.languages.TextEdit[] {
      try {
        const text = modelTextOf(model);
        if (text === null) return [];
        const kernel = requireKernel();
        const edits = collectFormattingEdits(
          kernel.slots.query('ui.editor.languageService'),
          formattingRequestOf(editorRequestIdentityOf(model), text, kernel.project.current(), {
            startLine: range.startLineNumber,
            endLine: range.endLineNumber,
          }),
        );
        if (edits === undefined || edits.length === 0) return [];
        return textEditsOf(model, edits);
      } catch {
        return [];
      }
    },
  };

  const registrations: Monaco.IDisposable[] = [];
  try {
    registrations.push(
      registerForLanguageServices(
        monaco,
        (m, id) => m.languages.registerDocumentRangeFormattingEditProvider(id, provider),
        'formatting',
      ),
    );
  } catch (error) {
    for (const registration of registrations) {
      try {
        registration.dispose();
      } catch {
        /* 半途回滚：同整篇那条 */
      }
    }
    throw error;
  }
  return disposableOf(registrations);
}
