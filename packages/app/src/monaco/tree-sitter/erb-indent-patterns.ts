/**
 * ERB 缩进捕获 → 行首锚正则（worker 侧；零 import，别把插件/UI 拖进 worker 图）。
 *
 * ## 为什么不能沿用引擎缺省的"整行原文锚定"
 *
 * 本语法的控制流行是**整行不透明 token**（`IF A AND B` 不拆表达式，见 grammar.js 头注）。
 * 引擎缺省把捕获节点的首行原文转成 `^\\s*原文$`——对 `IF A AND B` 就是一条只匹配那一行的
 * 规则：下一份文档换个条件即失效，而且作者每改一次条件，`mergeIndentConfig` 的去重键就变，
 * 宿主会重发语言配置（Monaco 会整批编辑器重算缩进）。
 *
 * 这里只取**节点 kind 里的关键字**（`if_line` → `IF`），派生"行首锚 + 词形边界"：
 * `^[ \\t\\u3000]*(?:[Ii][Ff])(?![A-Za-z_])`。实参不参与规则 ⇒ 换条件 / 换表名不改规则，
 * 与 `erb-enter.ts` 从配对表派生的基底规则同一稳定形状（两层判据同源：都来自控制词表）。
 *
 * ## 为什么按节点 kind 而不是读行首词
 *
 * 行首词要再切一次文本（还要处理全角空白 / 大小写），而节点类型本身就是投影派生的
 * `词.toLowerCase() + '_line'`（grammar.js 的 `lineNode()`）——读 kind 是读**结构事实**，
 * 不再从文本反推结构。查不到形状（将来语法改名）⇒ 这一条不产规则（`null`），
 * 由 `tests/projection-single-source.test.ts` / 新 facets 测试的覆盖断言兜住。
 */

/** 控制流行节点名：`if_line` / `trycgotoform_line` / `sif_line` */
const CONTROL_LINE = /^([A-Za-z][A-Za-z0-9]*)_line$/;

/**
 * 同后缀但**不是控制流**的行节点（语法里同样以 `_line` 收尾）。查询只捕控制流行，
 * 这里再挡一层：注入面是公开的，别让一张写错的查询把注释 / 串 / 指令行派生成缩进规则。
 */
const NON_CONTROL_LINES = new Set([
  'comment_line',
  'directive_line',
  'label_line',
  'bracket_line',
  'at_string_line',
  'string_line',
  'statement_line',
]);

/** 关键字大小写不敏感：tree-sitter 记号没有 `/i`，宿主正则也没有 flags ⇒ 逐字母展开 `[xX]`。 */
function caseInsensitive(word: string): string {
  return [...word]
    .map((ch) => (/[A-Za-z]/.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch))
    .join('');
}

/**
 * 一枚缩进捕获 → 正则源码；`null` = 这一条不产规则。
 *
 * 签名与 `StructureEngineAssets.indentPattern` 对齐（引擎原样传捕获名 / 节点类型 / 首行文本，
 * 本函数刻意**不用**行文本——理由见文件头）。
 */
export function erbIndentPattern(capture: string, nodeType: string, line: string): string | null {
  void line;
  if (!capture.startsWith('indent.')) return null;
  if (NON_CONTROL_LINES.has(nodeType)) return null;
  const match = CONTROL_LINE.exec(nodeType);
  if (match === null) return null;
  const word = match[1]!.toUpperCase();
  return `^[ \\t\\u3000]*(?:${caseInsensitive(word)})(?![A-Za-z_])`;
}
