import type * as Monaco from './entry';
import type { EditorRenameEdit } from '@kojo/plugin-api';
import {errorText,  normalize, unicodeTokenAt } from '@kojo/plugin-api';
import { KOJO_LANGUAGE_ID } from './kojo-language';
import { reject } from './rename-rejection';
import { isKojoSourcePath } from '../ui/reference-utils';

/**
 * `.kojo` 用户函数重命名（F2，R1，2026-10-16 语言服务批）——**宿主接线**。
 *
 * ## 与 `erb-rename` 的分工（W8 XLANG-RENAME 起：两条通道**汇成一条**，不再互不知情）
 *
 * - **ERB 方言**：全项目改名，`erb-rename` 的双通道（已开文件走 WorkspaceEdit、
 *   未开文件走内核 io 读改写）+ 只读全或无——分组闸门与落盘纪律的**唯一实现**在
 *   `ui/reference-utils.ts`（`planReferenceWrites` / `rewriteClosedFile`），本模块不重写一份；
 * - **`.kojo`**：用户函数**文件局部**（规范 §7.2 排除跨文件可见），引用集只在同一份
 *   文件里。可证明引用面与"整卷复核"全在糖线（`ui.editor.languageService` 槽的
 *   `rename` 判别成员；探针法，转译器当判官），宿主只做协议翻译与落地验证。
 * - **反向互通**：`.erb` 侧改名会把 `.kojo` 源里的对应记号一并收进同一次全或无判定
 *   （判读走槽，见 `erb-rename.collectKojoLeg`）；`.kojo` 侧改名的产物名冲突由糖线
 *   `productNameExists` 守门。两条通道各管一半，但**台账、闸门、落盘只有一份**。
 *
 * **跨文件编辑一律拒绝**（W8 新增守门）：本通道只把编辑落到请求的 model 上，
 * 贡献方若给出落在别处的编辑（契约 `EditorRenameEdit.resourcePath`），那属于
 * 全项目改名的范畴，必须走 `erb-rename` 的双通道送达——在这里静默落地 = 改错文件。
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

/** 请求 model 的盘上路径（桩 model / 派生 model 可能没有路径信息 ⇒ 空串，不猜） */
function modelPath(model: Monaco.editor.ITextModel): string {
  const uri = model.uri as Partial<Monaco.Uri> | undefined;
  return uri?.fsPath || uri?.path || '';
}

/** 路径同异（归一分隔符后大小写不敏感——Windows 盘上口径，与内核 io 的判据一致） */
function samePath(a: string, b: string): boolean {
  return normalize(a).toLowerCase() === normalize(b).toLowerCase();
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
        const requestPath = modelPath(model);
        for (const edit of result.edits) {
          // 跨文件编辑一律拒绝：本通道只往请求的 model 上落，全项目改名走 `erb-rename`
          if (edit.resourcePath !== undefined) {
            if (requestPath === '' || !samePath(edit.resourcePath, requestPath)) {
              const where = isKojoSourcePath(edit.resourcePath) ? '另一份 .kojo 源' : '另一份方言（.erb）文件';
              return reject(
                `改名目标越出当前文件（落在${where}「${edit.resourcePath}」）：` +
                  '本通道只改当前文件的同名函数，全项目改名请在 .erb 函数名上按 F2',
              );
            }
          }
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
        console.warn(`[kojo-rename] 落地失败：${errorText(e)}`);
        return reject(`重命名落地失败：${errorText(e)}`);
      }
    },
  };
  const sub = monaco.languages.registerRenameProvider(KOJO_LANGUAGE_ID, provider);
  return { dispose: () => sub.dispose() };
}
