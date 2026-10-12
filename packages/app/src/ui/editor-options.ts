/**
 * Monaco 选项：按文件体量分级（2026-10-12「内核优化」批；目标 = 超长文件丝滑）。
 *
 * ## 背景（实测，见 `docs/PERF-REVIEW-2026-10-11.md` §7.3/§7.6）
 *
 * 真实口上语料里最大的单个 ERB 达 **52,601 行 / 2.35 MB**（2,317 个文件中 ≥5,000 行的
 * 占 6.0%）。原先 `monaco.editor.create` 里**一个相关开关都没设**，全部走 Monaco 默认值，
 * 其中三项的默认值在大文件上是"全文级"操作：
 *
 * | 选项 | 默认 | 大文件上的代价 |
 * |---|---|---|
 * | `occurrencesHighlight` | `singleFile` | 光标一停就**整篇找同词** |
 * | `bracketPairColorization` | 开 | 需在**整篇文档**上建配对标色 |
 * | `matchBrackets` | `always` | 整篇文档找配对括号 |
 *
 * 本模块把这些开关按体量分两档（阈值 `LARGE_FILE_LINES`），编辑口上的实际需求
 * （读/改台词行）不需要上述任何一项在大文件上开启。
 *
 * **纯函数**（`editorOptionsForLineCount`）便于单测；宿主在**每次切文件**时调用并
 * `editor.updateOptions(...)`。
 */
import type * as Monaco from 'monaco-editor';

/** 大文件阈值（行）：≥ 此行数即降级若干"全文级"Monaco 特性 */
export const LARGE_FILE_LINES = 5000;

/** 供 `editor.updateOptions` 使用的选项补丁 */
export type EditorOptionPatch = Monaco.editor.IEditorOptions & Monaco.editor.IGlobalEditorOptions;

/**
 * 与文件规模相称的 Monaco 选项（**纯函数**）。
 *
 * 小文件档 = 保留全部便利特性；大文件档 = 关掉"全文级"开销，只留视图内的那些。
 */
export function editorOptionsForLineCount(lineCount: number): EditorOptionPatch {
  const large = lineCount >= LARGE_FILE_LINES;
  return {
    // 光标停留即"整篇找同词"——大文件头号隐性开销
    occurrencesHighlight: large ? 'off' : 'singleFile',
    // 基于词的建议对 ERB / 口上中文文本无意义（补全由自带 provider 提供），
    // 且默认会在输入时扫文档——一律关
    wordBasedSuggestions: 'off',
    // 括号配对高亮：'always' 对整篇文档找配对；大文件降为"仅视口附近"
    matchBrackets: large ? 'near' : 'always',
    // 括号对着色需在整篇文档上建索引——大文件关
    bracketPairColorization: { enabled: !large },
    // 缩略图：小文件保留"文本块"模式（口上是长行文，色块更干净也更省）；
    // 大文件整篇渲染不划算，关掉
    minimap: large ? { enabled: false } : { enabled: true, renderCharacters: false, maxColumn: 72 },
    // 当前行高亮：'all' 会额外整行铺色；大文件只保留行号侧
    renderLineHighlight: large ? 'line' : 'all',
    // 粘性滚动一律关闭（层级信息由函数树 / 糖折叠承担，不靠编辑器贴顶）
    stickyScroll: { enabled: false },
  };
}
