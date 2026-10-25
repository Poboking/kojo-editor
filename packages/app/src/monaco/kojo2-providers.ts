/**
 * Kojo 2.0 的 **Monaco 语言服务三件**（K2-EDITOR-PROVIDERS）：补全 / 悬停 / 转定义。
 *
 * ## 分层：本文件只做"纯模型 → Monaco 协议"
 *
 * batch-3 交来的四个纯模型（`kojo2-completion.ts` / `kojo2-hover.ts` / `kojo2-definition.ts` /
 * `kojo2-declarations.ts`）已经回答完"这一格该给什么"：源码 + 1 基行列进，候选 / 事实 / 落点出。
 * 本文件是**唯一**把它们翻成 `CompletionItem` / `Hover` / `LocationLink` 的地方——零语法判读、
 * 不写第二份候选词表。唯一多解的一趟源码是"声明类候选那一轮的 `documentation`"
 * （悬停正文住在声明事实上，见 {@link kojo2CompletionItems} 的注）；锚点 / 事件 / 域符号轮次不付这份成本。
 *
 * 三枚 provider **只挂 `kojo2` 语言 id**（`monaco.languages.register*Provider` 的第一个参数即
 * language selector；v1 的 `.kojo` / `.erb` 面由 `registerForLanguageServices` 各挂各的，
 * 两边不重叠）。
 *
 * ## 展开视图（K2-EXPAND-VIEW）：只借同一枚 provider 追加
 *
 * 模板 / 池 / 随机展开的"调用处 ↦ 定义处 ↦ 产物行"全在纯模型 `kojo2-expand-view.ts` 里判完；
 * 本文件只做两件 additive 的事：
 * - **悬停**：光标在**调用行**上时，在声明正文之后追加一段展开 Markdown（同一个 `contents`
 *   数组的第二项，**不新造第二个 `HoverProvider`** —— Monaco 多 provider 的合并顺序不可控）；
 * - **转定义**：光标在**展开体的源行**上时，在声明落点之后追加两条 `LocationLink`
 *   （调用处 / 定义处），同样挂在**同一枚** provider 的返回数组里。
 *
 * 编译成品由 `ui/kojo2-expand-compile.ts` 的模块级登记表提供（面板挂载时登记自己的
 * `compileCache.getLastCompile`）：**绝不二次编译**，也不缓存第二份 source map。登记表空
 * （或这份文件还没编译成功）⇒ 两处行为与 batch-4 逐字一致。
 *
 * ## 零游戏知识（audit A 的硬约束）
 * 本文件**不 import 任何 adapter 包**：事件名住在 `# 机` 的候选里，而候选由
 * `kojo2CompletionAt(query, { adapter })` 经 core 的 `eventNames(adapter)` 派生；域符号同样由
 * 纯模型从 core 的 `KOJO_DOMAIN_SYMBOL_NAMES` 取。adapter 由**调用方注入**
 * （{@link Kojo2ProviderOptions.adapter}），可以是值也可以是一枚 getter——后者让宿主按当前
 * 项目**请求时现取**，项目开闭不必重装 provider。
 *
 * ## 失败面：一律空结果，绝不抛进 Monaco
 *
 * Monaco 把 provider 的 throw 吞成"这个功能突然没了"（悬浮不弹、补全闪一下、F12 没反应），
 * 作者看不到任何原因。所以三条腿都自带 try/catch：
 * - 取文失败 / 位置越界 / 模型没有 uri ⇒ 空结果；
 * - adapter getter 抛错 / 没有 adapter ⇒ 只是 `# 机` 那一路零候选（**不猜内置事件**），
 *   同文件语义（悬停 / 转定义 / 声明名单）照常工作——那两条腿本来就不需要游戏知识，
 *   让它们陪着 adapter 一起静默，等于"没开项目时编辑器整片哑"；
 * - 注册半途抛错 ⇒ 先撤回已挂上的那几枚，再外抛（与
 *   `installKojo2SemanticTokensProvider` 的"全有或全无"同口径，由宿主统一回滚）。
 *
 * ## 开关与 disposal
 *
 * 补全 / 悬停是**只读语言面**（K2-SURFACE-DEFAULT）：不读切流开关，装配即注册。返回的
 * disposable 幂等，且逐枚 try/catch——一枚撤不掉不许带走其余。
 *
 * ## 已知边界（真壳才验得到）
 *
 * - `triggerCharacters` 只覆盖五锚点与 `{`；声明词 / 事件名后的候选仍靠 Monaco 的
 *   `quickSuggestions` 与手动触发（与 v1 `.kojo` 面同一条产品口径）；
 * - 文档注释（`documentation`）只给"声明"类候选（悬停正文取同一份
 *   `kojo2-hover.ts` 的 `kojo2HoverLines`，不另写一套措辞）；锚点 / 声明词 / 事件 / 域符号
 *   的说明在 `detail` 上，不编一段悬停正文。
 */
import type * as Monaco from './entry';
import { projectEventArgs, type GameAdapter } from '@kojo/kojo-core';
import { KOJO2_LANGUAGE_ID } from './kojo2-language';
import { kojo2ExpandCompilationFor, type Kojo2ExpandCompileSource } from '../ui/kojo2-expand-compile';
import {
  expandViewAt,
  expandViewMarkdown,
  type Kojo2ExpandCompilation,
  type Kojo2ExpandView,
} from '@kojo/kojo-lang';
import { kojo2CompletionAt, type Kojo2CompletionCandidate, type Kojo2CompletionOptions, type Kojo2FaceTemplates } from './kojo2-completion';
import {
  kojo2SnippetCandidatesAt,
  type Kojo2CompletionSnippet,
} from './kojo2-completion-snippets';
import { kojo2HoverAt, kojo2HoverLines, type Kojo2HoverResult } from './kojo2-hover';
import {
  KOJO2_DECL_WORD_BY_KIND,
  kojo2DocumentOf,
  kojo2TokenSpanAt,
  type Kojo2Declaration,
  type Kojo2DeclarationKind,
} from '@kojo/kojo-lang';

/* ============================== 注入面 ============================== */

/**
 * adapter 注入面：直接给一枚（测试 / 单项目），或给一枚 getter 让宿主**请求时现取**
 * （项目可开可关，缓存会把上一个项目的事件目录带过来）。
 */
export type Kojo2AdapterSource =
  | GameAdapter
  | null
  | undefined
  | (() => GameAdapter | null | undefined);

/**
 * 「这份 model 背后是哪个文件」的注入位。
 *
 * 只给转定义用：纯模型交回的是**同文件**落点（`line/column/endColumn`），`targetUri` 得由宿主
 * 补。回 `null` / 抛错 ⇒ 退回 `model.uri`（model 池本来就是 `Uri.file(path)` 建的，
 * 真壳里这条路逐字够用；注入位是给"派生 model / 未来跨面"留的正规口）。
 */
export type Kojo2FilePathSource = (model: Monaco.editor.ITextModel) => string | null;

/** 安装器的注入面（生产全部走缺省；测试注入假 adapter / 假路径） */
export interface Kojo2ProviderOptions {
  /** 当前项目 adapter；`# 机` 事件名的唯一来源（缺省 = 不猜任何内置事件） */
  readonly adapter?: Kojo2AdapterSource;
  /** 文件身份（只服务 `LocationLink.targetUri`；缺省 = 沿用 `model.uri`） */
  readonly getFilePath?: Kojo2FilePathSource;
  /**
   * **展开视图的编译成品**（K2-EXPAND-VIEW）：按文件路径取"那一次编译的产物 + 同源 source map"。
   *
   * 缺省 = 问模块级登记表 {@link kojo2ExpandCompilationFor}（面板挂载时登记了自己的编译缓存，
   * 见 `ui/kojo2-expand-compile.ts`）；两边都取不到 ⇒ 悬停 / 转定义**逐字保持**无展开段的旧行为
   * （零注册零行为，不新造第二个 provider）。
   */
  readonly getCompile?: Kojo2ExpandCompileSource;
  /**
   * 补全的**宿主投影**（K2-COMPLETE-ARGS-FACE / K2-COMPLETE-DATA）：事件参数形状 /
   * `@颜绘` 参数 / 行尾提示名。
   *
   * 每一项缺省时各自回落到 adapter 的契约字段（事件目录现投影 / `presentation.faceTemplates` /
   * `presentation.hintNames`；旧 adapter 没有这些字段 ⇒ 对应候选位零候选，不猜）。
   * 显式注入优先——宿主可换投影而不换 adapter。
   */
  readonly completion?: Omit<Kojo2CompletionOptions, 'adapter'>;
}

/* ============================== 常量 ============================== */

/**
 * 补全触发字符：五锚点 + `{`（`{…}` 是表达式位，与 v1 `.kojo` 的糖位触发同一产品口径）。
 * 其余位置靠 `quickSuggestions` 与手动触发——纯模型自己会按前缀裁剪，触发多了不产生噪声候选。
 */
export const KOJO2_COMPLETION_TRIGGER_CHARS: readonly string[] = Object.freeze([
  '#',
  '@',
  '>',
  '?',
  '!',
  '{',
  // `(`：行尾表演提示组 `(心形)` 的提示名位（K2-COMPLETE-ARGS-FACE）。
  '(',
]);

/** 没有可查的声明索引时用的空表（避免每轮都建一份） */
const NO_DECLARATIONS: ReadonlyMap<string, Kojo2Declaration> = new Map<string, Kojo2Declaration>();

/* ============================== 小工具（全部不抛） ============================== */

/** 取整篇源文；取不到（模型已 dispose / 桩 model）⇒ `null`（调用方给空结果） */
function sourceOf(model: Monaco.editor.ITextModel): string | null {
  try {
    const text = model.getValue();
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/** 取某一行原文（Monaco API 优先；桩 model 缺这一格时退回整篇切行） */
function lineTextOf(model: Monaco.editor.ITextModel, line: number): string {
  try {
    if (typeof model.getLineContent === 'function') {
      const text = model.getLineContent(line);
      if (typeof text === 'string') return text;
    }
  } catch {
    /* 越界 / 桩 model：走下面的整篇切行 */
  }
  const source = sourceOf(model);
  if (source === null) return '';
  return source.split(/\r\n|\r|\n/)[line - 1] ?? '';
}

/** adapter 现取；getter 抛错 = 这一轮没有 adapter（不抛进 Monaco） */
function adapterAt(source: Kojo2AdapterSource): GameAdapter | undefined {
  if (source === null || source === undefined) return undefined;
  if (typeof source === 'function') {
    try {
      return source() ?? undefined;
    } catch {
      return undefined;
    }
  }
  return source;
}

/* ============================== CompletionItemKind 映射 ============================== */

/**
 * adapter 的 `eventCatalog` → 补全参数形状投影（`# 机 <事件> <参数…>` 的参数名候选）。
 *
 * 投影是 core 的纯函数；按 adapter **对象身份**记忆化（`WeakMap`）：项目切换会换一枚 adapter，
 * 旧项目的目录不会被带到新项目上。投影抛错 ⇒ `undefined`（参数位零候选，不猜）。
 */
const EVENT_ARGS_CACHE = new WeakMap<GameAdapter, ReturnType<typeof projectEventArgs>>();

function eventArgsOf(adapter: GameAdapter): ReturnType<typeof projectEventArgs> | undefined {
  const cached = EVENT_ARGS_CACHE.get(adapter);
  if (cached !== undefined) return cached;
  try {
    const projected = projectEventArgs(adapter.eventCatalog);
    EVENT_ARGS_CACHE.set(adapter, projected);
    return projected;
  } catch {
    return undefined;
  }
}

/**
 * adapter 声明的 `@颜绘` 参数候选（K2-COMPLETE-DATA）与行尾提示名：**现取**契约字段。
 *
 * 与 {@link eventArgsOf} 同一条纪律：数据住 adapter，语言层只读；项目切换会换一枚 adapter，
 * 字段本身是引用、不需要缓存。字段缺省（旧 adapter）/ 读取抛错 ⇒ `undefined` ⇒ 各格零候选，
 * 不猜任何内置词。显式注入的 `completion.faceTemplates` / `completion.hintNames` 优先。
 */
function faceTemplatesOf(adapter: GameAdapter): Kojo2FaceTemplates | undefined {
  try {
    return adapter.presentation.faceTemplates;
  } catch {
    return undefined;
  }
}

function hintNamesOf(adapter: GameAdapter): readonly string[] | undefined {
  try {
    return adapter.presentation.hintNames;
  } catch {
    return undefined;
  }
}

/**
 * 声明种类 → Monaco `CompletionItemKind`（比五档粗分更贴作者直觉的一层细分）。
 * 表里没有的种类 ⇒ `Text`（**不猜**：新种类先当纯文本显示，而不是借邻居的颜色）。
 */
function completionKindOfDeclaration(
  K: typeof Monaco.languages.CompletionItemKind,
  kind: Kojo2DeclarationKind | undefined,
): Monaco.languages.CompletionItemKind {
  switch (kind) {
    case 'variable':
      return K.Variable;
    case 'constant':
      return K.Constant;
    case 'table':
      return K.Struct;
    case 'pool':
      return K.Enum;
    case 'template':
      return K.Snippet;
    case 'function':
      return K.Function;
    case 'scene':
      return K.Module;
    default:
      return K.Text;
  }
}

/**
 * 候选的语义类别 → Monaco `CompletionItemKind`（导出的**单一映射层**，测试直接钉这张表）。
 *
 * 分档理由：`# @ > ? !` 是语法标点 ⇒ `Operator`；声明词是保留词族 ⇒ `Keyword`；事件目录是
 * 游戏事实 ⇒ `Event`；域符号（我 / 你 / 她）是代词变量 ⇒ `Variable`；声明名按种类细分。
 * 未知类别 ⇒ `Text`（缺省方向永远是"少说"，不是"借一个像的色"）。
 */
export function kojo2CompletionKindOf(
  monaco: typeof Monaco,
  candidate: Kojo2CompletionCandidate,
): Monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind;
  switch (candidate.kind) {
    case 'anchor':
      return K.Operator;
    case 'declarationWord':
      return K.Keyword;
    case 'event':
      return K.Event;
    case 'domainSymbol':
      return K.Variable;
    case 'declaration':
      return completionKindOfDeclaration(K, candidate.declarationKind);
    // K2-COMPLETE-ARGS-FACE 的新候选位（细分映射只在此处；纯函数层只给语义类别）
    case 'eventArgument':
      return K.Value;
    case 'valueType':
    case 'storagePeriod':
      return K.Keyword;
    case 'templateParam':
      return K.Variable;
    case 'faceObject':
      return K.Variable;
    case 'faceArgument':
      return K.Value;
    case 'templateSlot':
    case 'hintName':
      return K.Text;
    default:
      return K.Text;
  }
}

/* ============================== 声明索引（只为 documentation） ============================== */

/**
 * 候选名 → 声明事实（只在本轮确实有"声明"类候选时才建；见
 * {@link kojo2CompletionItems} 的注——documentation 要的是悬停正文，而悬停正文住在声明事实上）。
 *
 * 键有两份：`种类\u0000名字`（精确）与裸名字（兜底）。**先建者胜**：同名声明由 core 报错，
 * 编辑器在错误状态下也得给出一条确定的说明，而不是随机挑一条。
 */
function declarationsOf(source: string): ReadonlyMap<string, Kojo2Declaration> {
  const map = new Map<string, Kojo2Declaration>();
  for (const declaration of kojo2DocumentOf(source).declarations) {
    const typed = `${declaration.kind}\u0000${declaration.name}`;
    if (!map.has(typed)) map.set(typed, declaration);
    if (!map.has(declaration.name)) map.set(declaration.name, declaration);
  }
  return map;
}

/** 候选 → 它对应的声明（种类精确优先，再按名字兜底） */
function declarationFor(
  candidate: Kojo2CompletionCandidate,
  declarations: ReadonlyMap<string, Kojo2Declaration>,
): Kojo2Declaration | undefined {
  if (candidate.declarationKind !== undefined) {
    const exact = declarations.get(`${candidate.declarationKind}\u0000${candidate.label}`);
    if (exact !== undefined) return exact;
  }
  return declarations.get(candidate.label);
}

/**
 * 悬停正文的 Markdown 形态（**唯一**渲染口径：悬停面与补全的 documentation 共用）。
 * 与 `kojo-hover.ts` 的既有写法同形：首段 `**名字**（种类）`，其余每行一段。
 */
export function kojo2HoverMarkdown(hover: Kojo2HoverResult): string {
  return [`**${hover.name}**（${hover.kind}）`, ...hover.lines].join('\n\n');
}

/** 声明事实 → 同一形态的 Markdown（种类文案取 core 词表，与悬停的 `x声明` 逐字同构） */
function declarationMarkdown(declaration: Kojo2Declaration): string {
  return [
    `**${declaration.name}**（${KOJO2_DECL_WORD_BY_KIND[declaration.kind]}声明）`,
    ...kojo2HoverLines(declaration),
  ].join('\n\n');
}

/* ============================== 区间 ============================== */

/**
 * 光标处名字段的替换区间（1 基、尾列半开）。
 *
 * 用**声明索引的同一枚** `kojo2TokenSpanAt`（纯模型裁前缀用的就是它），不另写一套"什么算名字
 * 字符"——两套判据会漂成"补全列表按一种前缀算、替换区间按另一种算"，上屏就是多一个字 / 少一字。
 * 名字段外（行首 / 空格后）⇒ 零宽区间（插在光标处）。
 */
function tokenRangeAt(line: number, lineText: string, column: number): Monaco.IRange {
  const col0 = Math.min(Math.max(column - 1, 0), lineText.length);
  const span = kojo2TokenSpanAt(lineText, col0);
  if (span === null) {
    return { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column };
  }
  return {
    startLineNumber: line,
    startColumn: span.start + 1,
    endLineNumber: line,
    endColumn: span.end + 1,
  };
}

/* ============================== 补全 ============================== */

/**
 * 一条候选 → `CompletionItem`。
 *
 * 四个字段的口径：
 * - `range` = 光标处**整个名字段**（不是"到光标为止"）：`# 变|量` 补成 `# 变量` 时，替换的是
 *   整枚名字，否则会拼出 `变量量`；
 * - `insertText` = 纯模型给的原文名（本层不塞括号 / snippet：调用形态不归补全管）；
 * - `filterText` = `label`：2.0 名字区分大小写、也没有拼音键，显示名就是匹配键
 *   （v1 的拼音补齐是另一套候选源的事，不在这一层猜）；
 * - `sortText` = 纯模型的排名键（锚点 `0_` / 声明词 `1_` / 事件 `2_` / 域符号 `3_` /
 *   声明 `4_`），直接把"该先看见谁"从模型带过来，本层不改写。
 */
function completionItemOf(
  monaco: typeof Monaco,
  candidate: Kojo2CompletionCandidate,
  range: Monaco.IRange,
  declarations: ReadonlyMap<string, Kojo2Declaration>,
): Monaco.languages.CompletionItem {
  const declaration = declarationFor(candidate, declarations);
  return {
    label: candidate.label,
    kind: kojo2CompletionKindOf(monaco, candidate),
    insertText: candidate.insertText,
    detail: candidate.detail,
    sortText: candidate.sortText,
    filterText: candidate.label,
    range,
    ...(declaration === undefined
      ? {}
      : { documentation: { value: declarationMarkdown(declaration) } }),
  };
}

/**
 * 一轮补全的全部候选（导出仅为可单测：宿主只经 provider 调它）。
 *
 * 文档索引**只在真有声明类候选时**才建（`kojo2CompletionAt` 已经解过一次源码；这一枚是为了
 * 拿声明事实拼 `documentation`，属于第二趟解析）。锚点 / 事件 / 域符号轮次完全不走这条路。
 */
export function kojo2CompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  adapter: GameAdapter | undefined,
  completion?: Omit<Kojo2CompletionOptions, 'adapter'>,
): Monaco.languages.CompletionItem[] {
  const source = sourceOf(model);
  if (source === null) return [];
  const query = { source, line: position.lineNumber, column: position.column };
  const eventArgs =
    completion?.eventArgs ?? (adapter === undefined ? undefined : eventArgsOf(adapter));
  // K2-COMPLETE-DATA：宿主没显式注入时，从 adapter 的契约字段现取（旧 adapter 没有 ⇒ 零候选）
  const faceTemplates =
    completion?.faceTemplates ?? (adapter === undefined ? undefined : faceTemplatesOf(adapter));
  const hintNames =
    completion?.hintNames ?? (adapter === undefined ? undefined : hintNamesOf(adapter));
  const candidates = kojo2CompletionAt(query, {
    ...(completion ?? {}),
    ...(eventArgs === undefined ? {} : { eventArgs }),
    ...(adapter === undefined ? {} : { adapter }),
    ...(faceTemplates === undefined ? {} : { faceTemplates }),
    ...(hintNames === undefined ? {} : { hintNames }),
  });
  const lineText = lineTextOf(model, position.lineNumber);
  const range = tokenRangeAt(position.lineNumber, lineText, position.column);
  const declarations = candidates.some((candidate) => candidate.kind === 'declaration')
    ? declarationsOf(source)
    : NO_DECLARATIONS;
  const items = candidates.map((candidate) =>
    completionItemOf(monaco, candidate, range, declarations),
  );
  // 块级 snippets（K2-COMPLETE-SNIPPET）：只由**宿主翻译层**在行首追加；纯函数永不产 snippet。
  // 宿主 monaco 缺 `Snippet` 档 / 规则枚举时整段跳过（老桩 / 精简宿主不因此整轮补全闪空）。
  if (
    monaco.languages.CompletionItemKind.Snippet !== undefined &&
    monaco.languages.CompletionItemInsertTextRule?.InsertAsSnippet !== undefined
  ) {
    for (const snippet of kojo2SnippetCandidatesAt(query)) {
      items.push(snippetCompletionItemOf(monaco, snippet, range));
    }
  }
  return items;
}

/** 一条块级 snippet → `CompletionItem`（`InsertAsSnippet` 只在宿主翻译层打开）。 */
function snippetCompletionItemOf(
  monaco: typeof Monaco,
  snippet: Kojo2CompletionSnippet,
  range: Monaco.IRange,
): Monaco.languages.CompletionItem {
  return {
    label: snippet.label,
    kind: monaco.languages.CompletionItemKind.Snippet,
    insertText: snippet.insertText,
    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    detail: snippet.detail,
    sortText: snippet.sortText,
    filterText: snippet.label,
    range,
  };
}

/* ============================== 展开视图的取数缝（K2-EXPAND-VIEW） ============================== */

/**
 * 这份 model 背后的文件路径（注入的身份优先，其次 `model.uri.fsPath`）。
 *
 * 要的是**路径**（去问编译缓存），不是 Uri 对象——转定义那条腿已经在 B3b 归插件，
 * 它当年另有一个 `targetUriOf`（`Uri.file(path)` 可以失败，那就退回 `model.uri`），
 * 随那条腿一起删了。
 * 桩 model 没有 uri ⇒ `null`（展开段不出现，其余腿不受影响）。
 */
function filePathOfModel(
  model: Monaco.editor.ITextModel,
  getFilePath: Kojo2FilePathSource | undefined,
): string | null {
  if (getFilePath !== undefined) {
    try {
      const path = getFilePath(model);
      if (typeof path === 'string' && path.length > 0) return path;
    } catch {
      /* 身份取不到：退回 model.uri（下面） */
    }
  }
  const uri = (model as unknown as { uri?: { fsPath?: unknown } }).uri;
  if (uri !== null && typeof uri === 'object' && typeof uri.fsPath === 'string' && uri.fsPath.length > 0) {
    return uri.fsPath;
  }
  return null;
}

/**
 * 光标处的展开视图（取不到 = `null`，**不抛**）。
 *
 * 编译成品是**诊断那一轮**的缓存（`compileCache.getLastCompile`）：这里绝不二次编译——
 * 展开视图要显示的产物行与屏上预览、波浪线必须是同一份字节。缓存里没有这一份 ⇒ `null`
 * （作者还没停手 / 这份文件还没编译成功）。
 */
function expandViewFor(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  getFilePath: Kojo2FilePathSource | undefined,
  getCompile: Kojo2ExpandCompileSource | undefined,
): Kojo2ExpandView | null {
  const filePath = filePathOfModel(model, getFilePath);
  if (filePath === null) return null;
  let compilation: Kojo2ExpandCompilation | null;
  try {
    compilation = getCompile === undefined ? kojo2ExpandCompilationFor(filePath) : getCompile(filePath);
  } catch {
    return null; // 缓存读取端抛错 = 这一份取不到（悬停 / 转定义照旧给别的事实）
  }
  if (compilation === null || compilation === undefined) return null;
  try {
    const view = expandViewAt(
      compilation.compiled,
      compilation.sourceMapModel,
      { line: position.lineNumber, column: position.column },
      { source: sourceOf(model) ?? undefined },
    );
    return view.kind === 'expand' ? view : null;
  } catch {
    return null; // 展开视图是附加段：它挂了不许带走声明悬停 / 转定义
  }
}

/** span → Monaco 区间（1 基；span 可以是跨行的，`LocationLink.range` 允许） */
function rangeOfSpan(span: { readonly start: { readonly line: number; readonly column: number }; readonly end: { readonly line: number; readonly column: number } }): Monaco.IRange {
  return {
    startLineNumber: span.start.line,
    startColumn: span.start.column,
    endLineNumber: span.end.line,
    endColumn: span.end.column,
  };
}

/* ============================== 悬停 ============================== */

/** 悬停的可选注入面（缺省 = 不注入文件身份、不取编译缓存：与 batch-4 逐字一致） */
export interface Kojo2HoverOptions {
  readonly getFilePath?: Kojo2FilePathSource;
  readonly getCompile?: Kojo2ExpandCompileSource;
}

/** 转定义的附加注入面（只服务展开视图的编译成品；缺省 = 问模块级登记表） */
export interface Kojo2ExpandLookupOptions {
  readonly getCompile?: Kojo2ExpandCompileSource;
}

/**
 * 悬停结果（声明事实 + **追加**展开段；`undefined` = 此处没有可讲的事实）。
 *
 * 展开段只挂在**调用行**命中时（`view.via === 'call-site'`）：光标已在展开体的源行上时，
 * 作者要看的是"这一行是谁展开出来的"，那是转定义那一条腿的事（两条 LocationLink），
 * 不在悬停里再贴一遍同样的产物。两段 Markdown **同一枚 provider 的两个 contents**：
 * Monaco 多 provider 的合并顺序不可控，绝不为展开视图新造第二个 `HoverProvider`。
 */
export function kojo2HoverOf(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  options: Kojo2HoverOptions = {},
): Monaco.languages.Hover | undefined {
  const source = sourceOf(model);
  if (source === null) return undefined;
  const hover = kojo2HoverAt({
    source,
    line: position.lineNumber,
    column: position.column,
  });
  const expand = expandViewFor(model, position, options.getFilePath, options.getCompile);
  const expandSegment =
    expand !== null && expand.via === 'call-site' ? expandViewMarkdown(expand) : null;
  if (hover === undefined && expandSegment === null) return undefined;
  const contents: Monaco.IMarkdownString[] = [];
  if (hover !== undefined) contents.push({ value: kojo2HoverMarkdown(hover) });
  if (expandSegment !== null) contents.push(expandSegment);
  if (hover !== undefined) {
    return {
      contents,
      range: {
        startLineNumber: position.lineNumber,
        startColumn: hover.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: hover.endColumn,
      },
    };
  }
  // 只有展开段（`@随机` 块头这类没有声明事实的位置）：区间取调用处 span（单行、精确）
  return { contents, range: expand === null ? undefined : rangeOfSpan(expand.callSite) };
}

/* ============================== 安装 ============================== */

/**
 * 为 `kojo2` 语言注册**两枚** provider（补全 / 悬停），返回**幂等**的 disposable。
 *
 * **无条件注册**（K2-SURFACE-DEFAULT：补全 / 悬停是只读语言面）。注册半途抛错 ⇒ 撤回已挂上的那几枚再外抛（宿主那一侧的
 * "全有或全无"回滚才有东西可撤）。两条 provider 腿的错误面收在各自体内：任何一腿抛错都
 * 只让**那一轮**空结果，编辑器不受影响。
 *
 * **转定义不在这一批里了**（B3b，2026-10-24）：那条腿的判据与展开落点都已归插件
 * `@kojo/plugin-kojo-lang`，由 descriptor 的 `slotServices: ['definition']` 经共享收口
 * （`kojo-definition.ts` 的 `installDefinitionProvider`）挂上。这里**绝不能**再注册一枚
 * `DefinitionProvider`：Monaco 多 provider 的合并顺序不可控，`F12` 到底跳哪一条就变得
 * 不可断言——这条理由当年就写在这里，删掉这条腿之后它更硬。
 */
export function installKojo2LanguageProviders(
  monaco: typeof Monaco,
  options: Kojo2ProviderOptions = {},
): Monaco.IDisposable {

  const adapterSource: Kojo2AdapterSource = options.adapter;
  const getFilePath = options.getFilePath;
  const getCompile = options.getCompile;

  const completionProvider: Monaco.languages.CompletionItemProvider = {
    triggerCharacters: [...KOJO2_COMPLETION_TRIGGER_CHARS],
    provideCompletionItems(model, position) {
      try {
        return {
          suggestions: kojo2CompletionItems(
            monaco,
            model,
            position,
            adapterAt(adapterSource),
            options.completion,
          ),
        };
      } catch {
        // Monaco 把 throw 吞成"补全闪一下没了"；空列表是它能读出"这里没有候选"的唯一形状。
        return { suggestions: [] };
      }
    },
  };

  const hoverProvider: Monaco.languages.HoverProvider = {
    provideHover(model, position) {
      try {
        // 展开段与声明悬停**同一个** provider 的两个 contents（K2-EXPAND-VIEW）：
        // 不新造第二个 HoverProvider——Monaco 多 provider 的合并顺序不可控。
        return kojo2HoverOf(model, position, { getFilePath, getCompile });
      } catch {
        return undefined;
      }
    },
  };

  const registrations: Monaco.IDisposable[] = [];
  try {
    // 语言 selector 形态：只认 `kojo2`（v1 的 `.kojo` / `.erb` 各由 `registerForLanguageServices`
    // 挂自己的方言表，这里不重不漏）。
    registrations.push(
      monaco.languages.registerCompletionItemProvider(KOJO2_LANGUAGE_ID, completionProvider),
    );
    registrations.push(monaco.languages.registerHoverProvider(KOJO2_LANGUAGE_ID, hoverProvider));
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

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const registration of registrations) {
        try {
          registration.dispose();
        } catch {
          /* 幂等 + 逐枚隔离：一枚抛错不影响其余撤离 */
        }
      }
    },
  };
}
