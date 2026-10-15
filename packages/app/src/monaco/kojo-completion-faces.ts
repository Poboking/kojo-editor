import type * as Monaco from 'monaco-editor';
import type { KojoFaceTable } from '@kojo/plugin-api';

/**
 * 语法糖（`.kojo`）补全 · **时机分野**（KC-2）—— 行首 `时机 <分野>：` 在 `<分野>`
 * 位置弹出分野候选。
 *
 * 分野清单的**唯一真源** = adapter 的 `KojoFaceTable.faces`（`Object.keys` 枚举）——
 * 本模块**不硬编码任何游戏分野名**（游戏知识只进 adapter，架构铁律 3）。
 *
 * 纯函数：只读模型、不产生编辑、不写盘、不发事件；位置不符 / 表缺省一律 `[]`、绝不抛。
 * Monaco 绑定（provider 注册）刻意不在此处——编排层负责把本函数接进补全基座。
 */

/** 行首 `时机 ` 前缀（允许行首空白；`时机` 后至少一个空白） */
const TIMING_PREFIX_RE = /^[ \t]*时机[ \t]+/;
/** 分野名令牌的终止符：空白 / 全角冒号 / 半角冒号 */
const FACE_TOKEN_END_RE = /[\s：:]/;
/** 块头终结的全角冒号——`该名之后`已出现即分野段收尾，不再补全 */
const BLOCK_COLON = '：';

/**
 * 计算行首 `时机 <分野>` 处的分野候选。行为：
 * - 仅当光标处在**行首 `时机 ` 之后的第一个令牌（分野名）位置**（同行内）时产出候选；
 * - 该名之后一旦出现全角 `：`（块头已收尾）→ `[]`；
 * - 候选取自 `Object.keys(faceTable.faces)`，**按已输入前缀过滤**（前缀为空 = 全量），
 *   顺序即表的声明序（`sortText` 前缀零填充 → 排序受控）；
 * - `kind` = `EnumMember`（枚举成员语义），`insertText` = 分野名；
 * - `detail`/`documentation` 取模板可读字段（`template` / `success` / `messageCheck`）；
 * - 替换范围只覆盖分野名那一段（不含其后的编号 / 命名参数）。
 */
export function faceCompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  faceTable: KojoFaceTable | undefined,
): Monaco.languages.CompletionItem[] {
  if (!faceTable || !model || !position) return [];
  if (!Number.isFinite(position.lineNumber) || position.lineNumber < 1) return [];
  if (!Number.isFinite(position.column) || position.column < 1) return [];

  const line = model.getLineContent(position.lineNumber);
  const head = TIMING_PREFIX_RE.exec(line);
  if (!head) return [];

  const faceStart = head[0]!.length;
  const col0 = position.column - 1;
  if (col0 < faceStart) return [];

  // 分野名令牌 = `时机 ` 之后的第一个空白 / 冒号之前的整段
  let faceEnd = faceStart;
  while (faceEnd < line.length && !FACE_TOKEN_END_RE.test(line[faceEnd]!)) faceEnd++;
  if (col0 > faceEnd) return [];

  // 该名之后已出现块头终结冒号 → 分野段已收尾（交回其它补全面）
  if (line.slice(faceStart).includes(BLOCK_COLON)) return [];

  const prefix = line.slice(faceStart, col0);
  const range: Monaco.IRange = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: faceStart + 1,
    endColumn: faceEnd + 1,
  };
  const kind = monaco.languages.CompletionItemKind.EnumMember;

  const out: Monaco.languages.CompletionItem[] = [];
  Object.keys(faceTable.faces).forEach((face, idx) => {
    if (prefix.length > 0 && !face.startsWith(prefix)) return;
    const tpl = faceTable.faces[face];
    const item: Monaco.languages.CompletionItem = {
      label: face,
      kind,
      insertText: face,
      filterText: face,
      range,
      sortText: `${String(idx).padStart(3, '0')}_${face}`,
    };
    if (tpl && tpl.template) {
      item.detail = tpl.template;
      const doc = [`**${face}** · 函数名模板 \`${tpl.template}\``];
      if (tpl.success?.template) doc.push(`成否模板 \`${tpl.success.template}\``);
      if (tpl.messageCheck?.template) doc.push(`MESSAGECHECK 模板 \`${tpl.messageCheck.template}\``);
      item.documentation = { value: doc.join('\n\n') };
    }
    out.push(item);
  });
  return out;
}
