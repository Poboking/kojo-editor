/**
 * `rename` 供方：包里的改名判据（`@kojo/kojo-lang/rename`）→ 契约的 `EditorRenameResult`
 * （B3e，2026-10-29）。
 *
 * ## 这一格回答什么
 *
 * 请求里的 `text` 是**请求文件**的全文；`projectFiles`（additive，缺席 = 只改这一篇）是
 * 项目内其他文档的快照。两条路都落在同一枚 `kojo2RenamePlanXFile` 上：
 * - 没有快照 ⇒ 同文件 plan（`kojo2RenamePlan`），编辑的 `resourcePath` 缺省 = 请求文件；
 * - 有快照 ⇒ `kojo2ProjectFileResolvers` 把快照映射成候选 / 读取两面，plan 层逐文件跑
 *   **同一条** `kojo2RenameAt`（不写第二把尺子）。
 *
 * ## 全或无（与包里 / 旧 provider 同一条纪律）
 *
 * - 快照**不完整**（`projectFilesComplete === false`，宿主触到文件数 / 字节数上限或读不到
 *   某份文本）⇒ **整次拒绝**并给作者一条可读理由：改名一旦漏文件就是同名分叉，
 *   比不改更糟；不拿不完整项目做"这些就是全部落点"的结论；
 * - 包内三道闸（非法名 / 重名 / 引用扫描不可证 / parse 复查）任一不过 ⇒ `edits: []` +
 *   `rejectReason`（blockers 逐条说清）；
 * - 超 64 文件 / 2000 段 ⇒ 同上（超限不做截断）。
 *
 * ## 三态
 *
 * - **非 kojo2 请求 ⇒ `undefined`（弃权）**：宿主那枚 provider 也挂在别的语言上，弃权让
 *   ERB / kojo1 自己的改名通道接手；
 * - **认这门语言 ⇒ 总是作答**：成功 = 编辑集；拒绝 = 空编辑 + `rejectReason`（**不是**弃权）。
 *
 * ## 产物形状
 *
 * 一条包内编辑 → `EditorRenameEdit`：`line` / `startColumn` / `endColumn` 1 基半开，
 * `resourcePath` 表达落点文件（请求文件那一项的路径与 `request.path` 逐字相同；单文件
 * plan 下缺省不写，宿主按 `model.uri` 落地）。`oldName` 交给宿主做落地前对照。
 */
import type {
  EditorLanguageServiceRequest,
  EditorRenameEdit,
  EditorRenameResult,
} from '@kojo/plugin-api';
import {
  kojo2ProjectFileResolvers,
  kojo2RenamePlan,
  kojo2RenamePlanXFile,
  type Kojo2RenamePlan,
} from '@kojo/kojo-lang/rename';
import { isKojo2Request } from './request';

/** 交回 `{ kind: 'rename', edits, oldName? }` 或 `{ …, edits: [], rejectReason }`；非 kojo2 ⇒ `undefined` */
export function provideRename(
  request: EditorLanguageServiceRequest,
): EditorRenameResult | undefined {
  if (request.kind !== 'rename') return undefined;
  if (!isKojo2Request(request)) return undefined;
  try {
    // 宿主明说"快照不完整"：改名全或无，整次拒绝（不让漏改的文件变成同名分叉）。
    if (request.projectFiles !== undefined && request.projectFilesComplete === false) {
      return {
        kind: 'rename',
        edits: [],
        rejectReason:
          '项目文件快照不完整（宿主超过快照上限或有一份读不到）：改名已取消（全或无，本文件也未改）。' +
          '缩小项目，或等索引建好后重试',
      };
    }

    const path = request.path.length > 0 ? request.path : null;
    const files = request.projectFiles;
    const resolvers =
      files !== undefined && files.length > 0 && path !== null
        ? kojo2ProjectFileResolvers(files)
        : undefined;
    const plan: Kojo2RenamePlan =
      resolvers === undefined || path === null
        ? kojo2RenamePlan(
            request.text,
            { line: request.line, column: request.column },
            request.newName,
          )
        : kojo2RenamePlanXFile(
            request.text,
            path,
            { line: request.line, column: request.column },
            request.newName,
            resolvers,
          );

    if (plan.symbol === null) {
      return {
        kind: 'rename',
        edits: [],
        rejectReason: plan.blockers[0] ?? '这里没有可改名的符号',
      };
    }
    if (plan.blockers.length > 0) {
      return { kind: 'rename', edits: [], rejectReason: plan.blockers.join('\n') };
    }
    if (plan.editsByPath.length === 0) {
      return { kind: 'rename', edits: [], rejectReason: '没有可落地的编辑（引用集为空），改名取消' };
    }

    const edits: EditorRenameEdit[] = [];
    for (const group of plan.editsByPath) {
      for (const edit of group.edits) {
        edits.push({
          line: edit.range.startLine,
          startColumn: edit.range.startColumn,
          endColumn: edit.range.endColumn,
          newText: edit.newText,
          // 单文件 plan 的 path 是 `''`：缺省落点 = 请求文件（契约"缺省 = 请求所在文件"）。
          ...(group.path.length === 0 ? {} : { resourcePath: group.path }),
        });
      }
    }
    return { kind: 'rename', edits, oldName: plan.symbol.name };
  } catch {
    return { kind: 'rename', edits: [], rejectReason: '重命名失败：取文或解析抛错，改名取消' };
  }
}
