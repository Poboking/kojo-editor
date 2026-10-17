import type * as Monaco from './entry';
import {
  SUGAR_LEXICON_WORDS,
  TIMING_NAMED_PARAMS,
  type SugarLexiconWord,
} from '@kojo/plugin-kojo-sugar';
import type { CompletionSource } from './kojo-completion';

/**
 * `.kojo` 补全 · **Snippet 模板源**（R4）：把"从零敲一整个块头 + 缩进骨架"收成一条
 * 候选（`insertTextRules: InsertAsSnippet`）。
 *
 * 零新字典（铁律：严禁抄第二份）：
 * - **词形**全部**派生**自 `kojo-sugar` 的 `SUGAR_LEXICON_WORDS`（按 `KeywordId` 查
 *   中文主形，与高亮/转译同一张表）；
 * - **时机块头的命名参数位**（`成否:` / `类型:` / `参数:`）用 choice placeholder
 *   派生自 `TIMING_NAMED_PARAMS` 的键名——"按指令字典形参生成 placeholder"的数据源
 *   就是这份既有键表；
 * - 系统函数的调用模板不在此处：`kojo-completion.ts` 的静态规格表已升级为
 *   `名($1)$0`（表里无形参数据 ⇒ 单 tab-stop，不猜）。
 *
 * **不重复出条目**：本 source 注册在 `KOJO_COMPLETION_SOURCES` **最前**，且只在
 * **行首位置**（token 之前只有空白）给块头模板——行首时与 `kojo-lexicon` 的同名
 * 纯文本关键字按 label 去重（先注册者胜）恰好只留 snippet；行中位置本源零候选，
 * 纯文本关键字照旧出货。
 *
 * **snippet 语法转义**（`escapeSnippetText`）：placeholder 默认值里作者可能写的
 * `$`（`实参$`）/ `}`（`{插值}`）/ `\` 一律转义，用例钉死在
 * `kojo-completion-snippets.test.ts`——漏转义的 `$` 会变成 tab-stop、`}` 会截断
 * placeholder，插入结果悄悄错掉。
 */

/**
 * Monaco snippet 语法转义：`\` / `$` / `}` 前加反斜杠。
 * `第 1 步先转反斜杠`是硬顺序——先转 `$`/`}` 会把新引入的 `\` 再次翻倍。
 */
export function escapeSnippetText(text: string): string {
  return text.replace(/([\\$}])/g, '\\$1');
}

/** 按 `KeywordId` 取中文主形词形（单一真源 = SUGAR_LEXICON_WORDS；查不到 = null，不猜） */
function wordOf(id: string): string | null {
  return SUGAR_LEXICON_WORDS.find((w) => w.id === id && w.primary)?.word ?? null;
}

/** 由词形查词表条目（detail 沿用词表角色标签） */
function lexOf(id: string): SugarLexiconWord | undefined {
  return SUGAR_LEXICON_WORDS.find((w) => w.id === id);
}

/** 时机块头命名参数位的 choice placeholder（候选取 `TIMING_NAMED_PARAMS` 规范键名） */
function namedParamChoice(): string {
  return `\${3|${TIMING_NAMED_PARAMS.map((p) => escapeSnippetText(`${p.name}: `)).join(',')}|}`;
}

/** 一条块头模板规格：label = 中文关键字（与纯文本补全同名 ⇒ 行首去重后只留模板） */
interface BlockSnippetSpec {
  /** 词表 KeywordId（词形从词表派生，不手抄） */
  readonly id: string;
  /** 以词形替换后的 snippet 正文；`w` = 该关键字的中文主形。返回 `null` = 模板**内嵌**
   *  的他键词形（`如果`→`否则` / `当`→`是`/`否则`）在词表查无 ⇒ 与条目级同一纪律
   *  （"查不到 = 不抄词形兜底"，整条跳过——ZH-L 词表守卫把兜底字面量按抄本计红）。 */
  readonly build: (w: string) => string | null;
  /** 面板说明（中文） */
  readonly detail: string;
}

/** 4 空格缩进 = 糖源的缩进惯例（语料样例实测口径） */
const INDENT = '    ';

/** 块头模板表（词形查不到的条目在构建期整条跳过——词表删词不炸补全） */
const BLOCK_SNIPPET_SPECS: readonly BlockSnippetSpec[] = [
  {
    id: 'block.timing',
    build: (w) => `${w} \${1:分野} \${2:编号} ${namedParamChoice()}\n${INDENT}$4\n$0`,
    detail: '时机块模板：分野 · 编号 · 命名参数',
  },
  {
    id: 'block.if',
    // 内嵌的"否则"词形也从词表查（`wordOf`）；查无 ⇒ 返回 null ⇒ 整条跳过（不抄词形兜底）
    build: (w) => {
      const els = wordOf('block.else');
      if (els === null) return null;
      return `${w} \${1:条件}：\n${INDENT}$2\n${els}\n${INDENT}$3$0`;
    },
    detail: '条件块模板：含否则分支',
  },
  { id: 'block.elif', build: (w) => `${w} \${1:条件}：`, detail: '否则如果分支头' },
  { id: 'block.else', build: (w) => `${w}：`, detail: '否则分支头' },
  {
    id: 'block.when',
    build: (w) => {
      const is = wordOf('block.is');
      const els = wordOf('block.else');
      if (is === null || els === null) return null;
      return `${w} \${1:表达式}：\n${INDENT}${is} \${2:值}：\n${INDENT}${INDENT}$3\n${INDENT}${els}：\n${INDENT}${INDENT}$4$0`;
    },
    detail: '分派块模板：是/否则分支',
  },
  { id: 'block.is', build: (w) => `${w} \${1:值}：`, detail: '当分支头' },
  { id: 'block.section', build: (w) => `${w} \${1:条件}：\n${INDENT}$2$0`, detail: '段块模板：多信封分段' },
  { id: 'block.random', build: (w) => `${w}：\n${INDENT}\${1:「……」}\n${INDENT}\${2:「……」}$0`, detail: '随机块模板：等概率候选' },
  { id: 'block.group', build: (w) => `${w}：\n${INDENT}$1$0`, detail: '候选组模板' },
  { id: 'block.choice', build: (w) => `${w}：\n${INDENT}\${1:「文本」}：\n${INDENT}${INDENT}$2$0`, detail: '选项块模板' },
  { id: 'block.menu', build: (w) => `${w}：\n${INDENT}\${1:[1] 标签}：\n${INDENT}${INDENT}$2$0`, detail: '菜单块模板' },
  { id: 'block.color', build: (w) => `${w} \${1:0xFF8080}：\n${INDENT}$2$0`, detail: '着色块模板：自动成对' },
  { id: 'block.customCommand', build: (w) => `${w} \${1:名}：\n${INDENT}$2$0`, detail: '自定指令块模板' },
  { id: 'block.function', build: (w) => `${w} \${1:名}(\${2:形参})：\n${INDENT}$3$0`, detail: '用户函数块模板' },
  { id: 'block.once', build: (w) => `${w} \${1:键}：\n${INDENT}$2$0`, detail: '初回块模板：只走一次' },
  { id: 'block.askM', build: (w) => `${w}：\n${INDENT}\${1:「标签,条件」}：\n${INDENT}${INDENT}$2$0`, detail: '询问块模板：多选' },
  { id: 'block.askYN', build: (w) => `${w}：\n${INDENT}\${1:「标签」}：\n${INDENT}${INDENT}$2$0`, detail: '确认块模板：二择' },
];

/** 构建期展开：词表派生词形 + snippet 正文（模块级一次构建，内容恒定） */
const BLOCK_SNIPPETS: readonly { label: string; insertText: string; detail: string }[] = BLOCK_SNIPPET_SPECS.flatMap(
  (spec) => {
    const w = wordOf(spec.id);
    if (w === null) return []; // 词表查无此 id 的中文主形 ⇒ 不造词形（不猜）
    const insertText = spec.build(w);
    if (insertText === null) return []; // 模板内嵌他键词形查无 ⇒ 整条跳过（同上，不猜）
    return [{ label: w, insertText: insertText, detail: `${spec.detail}` }];
  },
);

/** 光标之前是否只有空白（行首位置判定；与 ERB 侧 `isLineHeadContext` 同口径） */
function atLineHead(model: Monaco.editor.ITextModel, position: Monaco.Position): boolean {
  const line = model.getLineContent(position.lineNumber);
  const before = line.slice(0, position.column - 1);
  return /^[ \t]*$/.test(before);
}

/**
 * `.kojo` 块头 snippet source：**只在行首**给模板（行中零候选——行中的块关键字
 * 是词法意义上的普通词，交回 `kojo-lexicon` 纯文本项）。
 */
export const KOJO_SNIPPET_SOURCE: CompletionSource = {
  id: 'kojo-snippet',
  provide({ monaco, model, position, range }): Monaco.languages.CompletionItem[] {
    if (!atLineHead(model, position)) return [];
    // 常量对象防御性读取（测试桩 / 旧运行时可能不挂 `CompletionItemInsertTextRule`）
    const rule = monaco.languages.CompletionItemInsertTextRule?.InsertAsSnippet;
    const kind = monaco.languages.CompletionItemKind.Snippet;
    return BLOCK_SNIPPETS.map((s, idx) => ({
      label: s.label,
      kind,
      insertText: s.insertText,
      ...(rule !== undefined ? { insertTextRules: rule } : {}),
      detail: s.detail,
      range,
      sortText: `0_${String(idx).padStart(2, '0')}_${s.label}`,
    }));
  },
};

/** 词表派生自检：块头模板条数与规格表一致（词表缺词时漏条在测试里可见） */
export const KOJO_BLOCK_SNIPPET_COUNT = BLOCK_SNIPPETS.length;

/** 测试面：暴露已展开的模板表（只读） */
export function kojoBlockSnippets(): readonly { label: string; insertText: string; detail: string }[] {
  return BLOCK_SNIPPETS;
}

/** 词表条目查词（导出供测试核对派生词形与词表一致） */
export function lexemeOf(id: string): string | null {
  return lexOf(id)?.word ?? null;
}
