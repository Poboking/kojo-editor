import type * as Monaco from './entry';
import type { EditorRenameEdit } from '@kojo/plugin-api';
import { unicodeTokenAt } from '@kojo/plugin-api';
import { KOJO_LANGUAGE_ID } from './kojo-language';

/**
 * `.kojo` 用户函数重命名（F2，R1，2026-10-16 语言服务批）——**宿主接线**。
 *
 * 与 `erb-rename` 的分工（两条通道不重叠）：
 * - **ERB 方言**：全项目改名，`erb-rename` 的双通道（已开文件走 WorkspaceEdit、
 *   未开文件走内核 io 读改写）+ 只读全或无——本模块不碰；
 * - **`.kojo`**：用户函数**文件局部**（规范 §7.2 排除跨文件可见），引用集只在同一份
 *   文件里。可证明引用面与"整卷复核"全在糖线（`ui.editor.languageService` 槽的
 *   `rename` 判别成员；探针法，转译器当判官），宿主只做协议翻译与落地验证。
 *
 * ## 落地前的现文本验证（与 `erb-rename` 同一条纪律）
 *
 * 请求与落地之间作者可能已继续打字（F2 输入框开着的那段时间）。每一处编辑落地前
 * 对照 live model 的现文本验证：该列区间上现在是不是原名（`.kojo` 名字**大小写敏感**
 * ——中文与混合名，与 ERB 索引的归一口径不同源，不归一）；任何一处失配 ⇒ **整次拒绝**
 * 让作者重按 F2。为什么不做"失配的跳过、其余照改"：单文件引用集是全有或全无的命题，
 * 少改一处 = 同名分叉，比不改更糟。
 */

/** 宿主注入：怎么应答（活动标签判据）、改名决策（查槽）全在 handlers */
export interface KojoRenameHandlers {
  /** 该不该应答这次请求：只认当前活动标签的真 model（与 codeAction / 转到定义同判据） */
  canAnswer(model: Monaco.editor.ITextModel): boolean;
  /**
   * 改名决策（宿主在此查 `ui.editor.languageService` 槽的 `rename` 成员）。
   * 返回拒绝理由或编辑集（含 `oldName`，供本模块做落地验证）。
   */
  resolve(
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
    newName: string,
  ): { edits: readonly EditorRenameEdit[]; oldName?: string; rejectReason?: string };
}

function reject(reason: string): Monaco.languages.WorkspaceEdit & Monaco.languages.Rejection {
  return { edits: [], rejectReason: reason };
}

/**
 * 对 `KOJO_LANGUAGE_ID` 注册 RenameProvider。判定全在糖线与 handlers，
 * 本函数只做 Monaco 类型翻译与隔离（任何抛错都退成 reject 理由，不让 F2 崩编辑器）。
 */
export function installKojoRename(monaco: typeof Monaco, handlers: KojoRenameHandlers): Monaco.IDisposable {
  const provider: Monaco.languages.RenameProvider = {
    // 词区间给 Monaco 做输入框初值；"可不可以改"在编辑期由槽给拒绝理由（不猜、不拦）
    resolveRenameLocation(model, position) {
      if (!handlers.canAnswer(model)) return undefined;
      const lineText = model.getLineContent(position.lineNumber);
      const token = unicodeTokenAt(lineText, position.column);
      if (!token) return undefined; // 无词 ⇒ Monaco 走缺省词回退，不弹错
      return {
        range: {
          startLineNumber: position.lineNumber,
          startColumn: token.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: token.endColumn,
        },
        text: token.text,
      };
    },

    async provideRenameEdits(model, position, newName) {
      try {
        const result = handlers.resolve(model, position, newName);
        if (result.rejectReason) return reject(result.rejectReason);
        // 落地前逐处对照现文本验证（请求与落地之间缓冲可能已变——陈旧坐标绝不硬写）
        const verified: Monaco.languages.IWorkspaceTextEdit[] = [];
        for (const edit of result.edits) {
          if (
            result.oldName === undefined ||
            edit.line < 1 ||
            edit.line > model.getLineCount() ||
            edit.startColumn < 1 ||
            edit.endColumn > model.getLineMaxColumn(edit.line) + 1
          ) {
            return reject('文件内容已变化，改名坐标失效——请重按 F2 重试');
          }
          const line = model.getLineContent(edit.line);
          if (line.slice(edit.startColumn - 1, edit.endColumn - 1) !== result.oldName) {
            return reject('文件内容已变化，改名坐标失效——请重按 F2 重试');
          }
          verified.push({
            resource: model.uri,
            versionId: undefined,
            textEdit: {
              range: {
                startLineNumber: edit.line,
                startColumn: edit.startColumn,
                endLineNumber: edit.line,
                endColumn: edit.endColumn,
              },
              text: edit.newText,
            },
          });
        }
        if (verified.length === 0) {
          return reject('语言服务未给出可落地的编辑（引用集为空），改名取消');
        }
        return { edits: verified };
      } catch (e: unknown) {
        console.warn(`[kojo-rename] 落地失败：${e instanceof Error ? e.message : String(e)}`);
        return reject(`重命名落地失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
  const sub = monaco.languages.registerRenameProvider(KOJO_LANGUAGE_ID, provider);
  return { dispose: () => sub.dispose() };
}
