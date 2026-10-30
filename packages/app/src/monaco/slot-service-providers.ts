/**
 * 槽腿 provider 的**唯一工厂**：`kind` →（Monaco 注册 API、请求构造、契约 → Monaco 形状）
 * （SDK-B5b 车 1，2026-10-31；补全 / 悬停由 `kojo2-providers.ts` 整块搬入并改成语言无关。
 * 车 2–4（同日）再收七格：格式化 / 签名、引用 / 改名、同符号高亮 / 结构化扩选 / 行上注解。
 * 车 5（同日）：快速修复 / 一键迁移（`codeAction`，判据源是**专用槽** `ui.editor.codeAction`）
 * ——它是**写面**，`installSlotServiceProviders` 不装它，由宿主按切流策略单独装
 * （{@link SLOT_SERVICE_WRITE_LEGS}）；工厂不读开关，只当注册与翻译的外壳）。
 *
 * ## 为什么是一张表，而不是每个 kind 一枚安装器
 *
 * 此前每条腿各住一枝文件（`kojo2-providers` / `kojo2-signature` / `kojo2-format` / …），
 * 尾巴上逐字抄同一段"经 `registerForLanguageServices` 铺开 + 半途回滚 + 幂等 dispose"。
 * 抄本一多，下一枚腿就只会抄到其中一半（回滚漏掉、能力名漏写、注册顺序悄悄变了）。
 * 工厂把那段一次性收口，每条腿只剩**三件它自己的事**——注册 API、请求构造、契约 → Monaco
 * 形状；`SlotServiceLeg` 的类型对 `SlotServiceKind` 全集开口（后续腿补一枚 `legOf(...)` 即可），
 * 但**表里没写的 kind 不挂**：宿主不许"顺手"给一门语言挂上一条没有供方的腿。
 *
 * ## 挂载：descriptor 点名，收口铺开
 *
 * 一律经 `registerForLanguageServices(monaco, register, kind)`：它覆盖每一门
 * `languageServices: true` 的语言，**并上** descriptor 的 `slotServices` 点了这一枚能力名的
 * 语言（kojo2 由 `monaco/languages.ts` 点名）。注册调用的首个实参只许是收口给的 `id`——
 * "第一个实参写死某语言 id"的自建注册已清零，`language-parity` 按那条形状 grep。
 *
 * ## 顺序是数据，不是巧合
 *
 * `SLOT_SERVICE_LEGS` 的数组序 = **注册顺序**。车 1 只开补全 / 悬停两格时它与搬家前两枚
 * `push` 的相对序逐字相同（补全先、悬停后）；车 2–4 把其余七格**追加**在尾部，且**只跨
 * provider 种类**重排了相对位置（同一种 provider 只有一枚，Monaco 的"第一家说了算"只在
 * 同种 provider 之间裁决，因此跨种顺序无语义）。真正要守的是**每一种 provider 相对 v1 那条
 * 同种 provider 的先后**：v1 的 ERB / kojo1 面在装配点后半段（`kojo-format` / `erb-rename` /
 * `find-references` / `kojo-code-lens` / …）注册，本表整体仍在它们之前——与搬家前逐格相同。
 * 装配点那道调用也留在原位（语义捕获预取之后、切流块之前），所以它与 v1 那几枚 provider
 * 的相对序同样不变。`packages/app/tests/kojo2-providers.test.ts` 的「注册顺序」组把这几层
 * 都钉住（表格序 / 实际注册序 / 装配点位置 / 与 v1 同种 provider 的先后）。
 *
 * ## 每一腿体内只剩"翻译"（宿主事实从 {@link SlotServiceHost} 注入，判据一枚都不留）
 *
 * 1. **model → 请求**：`path` / `languageId` / `version` 原样取自 model（宿主不改写、不猜）、
 *    全文、光标位点、当前项目（项目事实只在内核里，插件只能从请求里读）。构造一律走 legs 的
 *    `completionRequestOf` / `hoverRequestOf` / `editorRequestIdentityOf` / `modelTextOf` /
 *    `formattingRequestOf` / `signatureRequestOf` / `referencesRequestOf` / `renameRequestOf` /
 *    `documentHighlightRequestOf` / `selectionRangeRequestOf` / `codeLensRequestOf`
 *    ——手抄一份对象字面量，抄漏 `version` 的那条腿就废掉了供方的过期复核；
 *    合并与单答裁决也一律在 legs（并在 provider 里写第二份）。
 * 2. **响应 → Monaco 协议**：`range` → `IRange`、`filterText` 透传、`documentation` 按
 *    `documentationFormat` 分 Markdown / 纯文本、`insertTextFormat` 决定要不要开模板通道；
 *    格式化 edits → `TextEdit`、签名 → `SignatureHelp`、落点 → `Location`、
 *    改名 → `WorkspaceEdit`、扩选链 → 0.57 的扁平数组、注解 → 复用 v1 那枚既有翻译器。
 * 3. **图标表**：契约档（`EditorCompletionItemKind` 十三档）→ Monaco 枚举。挑哪枚图标是
 *    编辑器的事，插件看不到 Monaco；这一层也不许给某一档另发明第二重语义。
 *
 * ## 宿主事实的注入面（{@link SlotServiceHost}）
 *
 * 只有三格，且都**不是语言判据**：`filePathOf`（model 归属实例的磁盘路径——宿主知道哪个
 * EditorPane 持有它，插件不知道）、`projectIndex`（项目文件快照的现取口，只有宿主持有）、
 * `uriForPath`（跨文件落点的 URI 造法）。生产装配点全给；不传 = 各腿退回自己的缺省
 * （`model.uri` / 无快照 / `monaco.Uri.file`），行为与搬家前"没给注入面"逐字相同。
 *
 * 快照只在**显式动作**（Shift+F12 / F2）里取：行上注解是每次停笔重算整篇的那一格，装配点
 * 不给它 `projectIndex`，本层也不替它开（理由与实测口径见文件尾「行上注解」段）。
 *
 * ## 触发字符仍是语言事实
 *
 * 补全的触发字符是 `@kojo/kojo-lang/completion` 那一份（叶子 import）；签名帮助的 `(` / `,`
 * 与合并去重规则住在 `@kojo/kojo-lang/signature` 的宿主侧这一格（`KOJO2_SIGNATURE_TRIGGER_CHARS`
 * 由 `monaco/kojo2-language` 之外的既有单例供给，见车 3 迁入时的注）。descriptor 还没有
 * "哪几个字符算补全 / 签名触发"这一格，**这一格是语言事实、只是暂时由 2.0 的单例供给**；
 * 等某门语言要另一套触发符时，补 descriptor 字段 + 按 id 取，不在本表里分支（审计 M2 也拦在
 * 宿主里按 id 判）。
 *
 * ## 插入语义：`kind: 'snippet'` ≠ `insertTextFormat: 'snippet'`
 *
 * 2.0 有两类候选都叫 snippet，但只有一类带占位符：块级骨架要按模板落地，`# 模` 的**声明名**
 * 只是借那枚图标、名字里没有槽位。规则逐字照契约走：
 * - `InsertAsSnippet` **只随 `insertTextFormat === 'snippet'` 下发**；"凡 kind 是 snippet
 *   就开模板"会把声明名里的 `$` / `}` 当槽位吞掉——挑图标顺手改了插入语义；
 * - 桩 Monaco 缺 `CompletionItemKind.Snippet` 或缺 `CompletionItemInsertTextRule` 时
 *   **丢弃该档**（既不许把 `undefined` 写进 `kind`，也不许把占位符当字面文本插进缓冲）。
 *   只有"纯图标"那一路在缺枚举时退 `Text`：少一枚颜色，不撤一条真候选。
 *
 * ## 悬停：无人应答 ⇒ `undefined`，不是空串
 *
 * 契约里 `contents === ''` 是**作答**（"这家认这篇，但这一格没话说"），`undefined` 才是弃权。
 * Monaco 的悬停取**第一家非空**，所以"没有供方应答"必须如实交回 `undefined`——交回
 * `{ contents: '' }` 会把本该接手的下一路（v1 那枚词义悬浮）顶掉；"作答但没话说"则交回
 * `undefined`（不弹浮层）但**不再问下一家**（单答裁决已在 legs 收口）。
 *
 * ## 同符号高亮 / 扩选 / 改名：只答"点名了这一格"的语言
 *
 * 这三格（`answersOwnSlotOnly`）的供方与**另一门语言**的供方同住一枚槽：`ui.editor.languageService`
 * 的贡献按请求 `languageId` 自认语言，而本层每一腿会被收口挂到**每一门** `languageServices`
 * 语言上。于是 ERB 模型问来时，槽里答的是 ERB 那家——若不先弃权，本层就会把 ERB 的答案
 * 当自己的再交一遍（高亮叠两层、改名两份编辑、扩选两条链）。
 *
 * 判据取 **descriptor 声明**（`slotServices` / `services.slot` 里点名了这一格），不写任何
 * 语言 id：一门语言有没有把这条腿交给插件，是它的 descriptor 已经写下来的事实。今天 kojo2
 * 点名了这三格（答）、ERB / kojo1 没有（弃权）——与搬家前"比 kojo2 常量"的可观测结果逐字
 * 相同，但宿主不再认识具体语言名。桩 model 没有 `getLanguageId`（旧宿主 / 单测）⇒ 照旧服务，
 * 与搬家前那条"缺 getLanguageId 就当目标语言"一致。
 *
 * ## 失败面与 disposal
 *
 * - 每一轮各带 try-catch：取文失败 / 没有编辑器实例（`requireKernel` 抛）/ 编排抛 ⇒ 各腿
 *   交回它读得懂的**空结果**（补全 / 格式化 / 引用 = 空表；悬停 / 签名 / 高亮 / 扩选 /
 *   注解 = `undefined`；改名 = 拒绝理由）。Monaco 把 throw 吞成"这功能突然没了"，空结果是
 *   唯一能被读出的形状；单枚贡献自己抛错由 legs 的 `provideOf` 隔离（warn 带贡献 id）；
 * - 注册半途抛错 ⇒ `registerForLanguageServices` 撤它自己铺的那几门，本层再撤回**已装完的
 *   前几条腿**并原样外抛（宿主那一侧的"全有或全无"回滚才有东西可撤）；
 * - 返回的 disposable 幂等，且逐条腿 try-catch——一条撤不掉不许带走其余。
 *
 * ## 开关
 *
 * 这九条腿都是**只读语言面**（K2-SURFACE-DEFAULT）：不读切流开关，装配即注册。格式化 /
 * 改名会改缓冲，但只服务**显式动作**且可撤销（同一口径，搬家前逐字相同）。
 */
import type * as Monaco from './entry';
import type {
  EditorCodeAction,
  EditorCodeActionContribution,
  EditorCompletionItem,
  EditorCompletionItemKind,
  EditorDocumentHighlightKind,
  EditorHoverResult,
  EditorLanguageRange,
  EditorRangeEdit,
  EditorSelectionChain,
  EditorSignature,
  EditorSymbolLocation,
  EditorTextEdit,
  GameProject,
} from '@kojo/plugin-api';
// 值导入（`errorText` 只是错误文案的中性拼法，无语言知识）：与 `kojo2-code-actions.ts` 搬家前同源。
import { errorText } from '@kojo/plugin-api';
// 叶子，不是桶：引 `@kojo/kojo-lang` 会把整包挂上首屏（`ps10-eager-graph` 的叶子纪律）。
import { KOJO2_COMPLETION_TRIGGER_CHARS } from '@kojo/kojo-lang/completion';
import { kojo2PrepareRename, type Kojo2RenameRange } from '@kojo/kojo-lang/rename';
import { requireKernel } from '../ui/editor-pane-registry';
import { LARGE_FILE_LINES } from '../ui/editor-options';
import { declaredSlotKinds, descriptorForLanguageId, type SlotServiceKind } from './language-registry';
import {
  codeLensRequestOf,
  collectCodeLensResult,
  collectCompletionItems,
  collectDocumentHighlights,
  collectFormattingEdits,
  collectHoverResult,
  collectReferences,
  collectRename,
  collectSelectionRanges,
  collectSignatureHelp,
  completionRequestOf,
  documentHighlightRequestOf,
  editorRequestIdentityOf,
  formattingRequestOf,
  hoverRequestOf,
  modelTextOf,
  projectFilesSnapshotOf,
  referencesRequestOf,
  renameRequestOf,
  selectionRangeRequestOf,
  signatureRequestOf,
} from './kojo-language-service-legs';
import type { Kojo2ProjectIndex } from './kojo2-project-index';
import { toMonacoCodeLenses } from './kojo-code-lens';
// 快速修复的类别映射 / 诊断 ↔ marker 翻译复用 **v1 那枚既有模块**（`kojo-code-action.ts`）：
// "动作类别只有 quickfix / refactor 两档"与"关联诊断按 model 夹取"是同一份判据，
// 抄一份新的会立刻漂成两套（与车 4 复用 `toMonacoCodeLenses` 同一条纪律）。
import {
  QUICK_FIX_KIND,
  REFACTOR_KIND,
  actionDiagnostics,
  markersToDecorations,
  monacoActionKind,
} from './kojo-code-action';
import { registerForLanguageServices } from './register-dialects';
import { reject } from './rename-rejection';

/* ============================== 契约档 → Monaco 枚举 ============================== */

/**
 * 契约的十三档 → Monaco `CompletionItemKind`（简报§四的表倒过来读：插件那侧已把语义类别翻成
 * 中性档，这里只负责"这一档挑哪枚图标"）。
 *
 * 未知档 ⇒ `Text`：缺省方向永远是"少说"，不是"借一个像的色"。`snippet` 档缺枚举时同样退
 * `Text`（**不带** `insertTextFormat` 的那一路才走到这里，带模板插入的那一路在
 * `toMonacoCompletionItem` 里已先过枚举闸并整档丢弃）。
 */
export function completionKindOf(
  monaco: typeof Monaco,
  kind: EditorCompletionItemKind | undefined,
): Monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind;
  switch (kind) {
    case 'operator':
      return K.Operator;
    case 'keyword':
      return K.Keyword;
    case 'function':
      return K.Function;
    case 'variable':
      return K.Variable;
    case 'value':
      return K.Value;
    case 'event':
      return K.Event;
    case 'constant':
      return K.Constant;
    case 'struct':
      return K.Struct;
    case 'enum':
      return K.Enum;
    case 'module':
      return K.Module;
    case 'snippet':
      return K.Snippet !== undefined ? K.Snippet : K.Text;
    // LAU-4 补全腿 additive 的第十三档（`$标签` 一类"本文件内可达的具名引用"）
    case 'reference':
      return K.Reference !== undefined ? K.Reference : K.Text;
    case 'text':
      return K.Text;
    default:
      return K.Text;
  }
}

/* ============================== 契约 → Monaco（补全） ============================== */

/**
 * 契约区间 → Monaco `IRange`（两侧口径逐字相同：1 基、尾列半开、单行）。
 *
 * 非法坐标 ⇒ **不给区间**（交回 Monaco 自己的现行口径）并 warn 出候选名：一个越界 / 倒置的
 * 区间会让**整轮**补全在 Monaco 内部炸掉，而"这一条按缺省词段替换"只是精度少一点（与 legs
 * 的 `usableRangeEdits` 同一条处置）。
 */
function monacoRangeOf(range: EditorLanguageRange | undefined, label: string): Monaco.IRange | undefined {
  if (range === undefined) return undefined;
  if (!Number.isFinite(range.line) || !Number.isFinite(range.startColumn) || !Number.isFinite(range.endColumn)) {
    console.warn(
      `[slot-service-providers] 候选 '${label}' 的区间坐标非法（${range.line}:${range.startColumn}..${range.endColumn}），改由编辑器按缺省区间处理`,
    );
    return undefined;
  }
  return {
    startLineNumber: range.line,
    startColumn: range.startColumn,
    endLineNumber: range.line,
    // 尾列不许早于首列：契约写了"须 ≥ startColumn"，这里兜住违约的那一枚，别把它交给 Monaco
    endColumn: Math.max(range.endColumn, range.startColumn),
  };
}

/**
 * `documentation` 的两种形态（按 `documentationFormat` 分，缺省 `'text'` = 旧行为逐字不变）：
 * `'markdown'` ⇒ `IMarkdownString`；缺省 ⇒ **原样纯文本字符串**（Monaco 这一格收
 * `string | IMarkdownString`，宿主不替供方包装、不猜渲染、不编一套转义判据）。
 */
function documentationOf(item: EditorCompletionItem): string | Monaco.IMarkdownString | undefined {
  if (item.documentation === undefined) return undefined;
  return item.documentationFormat === 'markdown' ? { value: item.documentation } : item.documentation;
}

/**
 * 供方**没给** `range` 时的宿主缺省区间（契约口径：补全 = 光标所在词的区间）。
 *
 * Monaco 0.57 的 `CompletionItem.range` 是必填字段，所以"没有区间"在这一层落不成
 * `undefined`，只能落回宿主自己的现行口径：`getWordAtPosition` 的那一段（词外 ⇒ 零宽插在
 * 光标处）。这一条**不是**语言判据——"什么算一个词"是编辑器通用词法；2.0 的名字段边界
 * 由供方给，这里的缺省只服务"别家供方没给"那种情形。
 */
function wordRangeAt(model: Monaco.editor.ITextModel, position: Monaco.Position): Monaco.IRange {
  let word: { startColumn: number; endColumn: number } | undefined;
  try {
    word = model.getWordAtPosition(position) ?? undefined;
  } catch {
    word = undefined; // 桩 model / 越界：零宽插入点，不猜任何边界
  }
  return {
    startLineNumber: position.lineNumber,
    startColumn: word?.startColumn ?? position.column,
    endLineNumber: position.lineNumber,
    endColumn: word?.endColumn ?? position.column,
  };
}

/**
 * 一条契约候选 → 一枚 Monaco `CompletionItem`（导出仅为可单测：装配只经 provider 调它）。
 *
 * 返回 `undefined` = **这一档整枚丢弃**，只有一种情形：带占位符的模板候选落在缺枚举的宿主上
 * （见文件头「插入语义」）。其余字段一律透传，本层不改写排名、不补第二份措辞：
 * `insertText` 缺省 = `label`（契约口径），`range` 缺省 = 宿主现行词段口径（`fallbackRange`）。
 */
export function toMonacoCompletionItem(
  monaco: typeof Monaco,
  item: EditorCompletionItem,
  fallbackRange: Monaco.IRange,
): Monaco.languages.CompletionItem | undefined {
  const K = monaco.languages.CompletionItemKind;
  const rules = monaco.languages.CompletionItemInsertTextRule;
  const asSnippet = item.insertTextFormat === 'snippet';
  if (asSnippet && (K.Snippet === undefined || rules?.InsertAsSnippet === undefined)) return undefined;
  const documentation = documentationOf(item);
  // 供方给的区间优先；非法 / 缺席才落回宿主缺省（见 `wordRangeAt` 的注）
  const range = monacoRangeOf(item.range, item.label) ?? fallbackRange;
  return {
    label: item.label,
    kind: completionKindOf(monaco, item.kind),
    insertText: item.insertText ?? item.label,
    detail: item.detail,
    sortText: item.sortText,
    filterText: item.filterText,
    documentation,
    range,
    // 只在供方**显式**声明模板时才开这条通道：图标档（`kind: 'snippet'` 而无
    // `insertTextFormat`）绝不开——否则 `# 模` 的声明名会按模板解释自己的名字。
    ...(asSnippet ? { insertTextRules: rules!.InsertAsSnippet } : {}),
  };
}

/** 全部候选 → Monaco 数组（被丢弃的那几枚如实少掉，不占位、不改写成别的档） */
export function toMonacoCompletionItems(
  monaco: typeof Monaco,
  items: readonly EditorCompletionItem[],
  fallbackRange: Monaco.IRange,
): Monaco.languages.CompletionItem[] {
  const out: Monaco.languages.CompletionItem[] = [];
  for (const item of items) {
    const translated = toMonacoCompletionItem(monaco, item, fallbackRange);
    if (translated !== undefined) out.push(translated);
  }
  return out;
}

/* ============================== 契约 → Monaco（悬停） ============================== */

/**
 * 契约悬停 → Monaco `Hover`。三条处置的区分是这一层的**全部内容**（见文件头「悬停」）：
 * 弃权 ⇒ `undefined`；作答空串 ⇒ 同样 `undefined` 但不再问下一家；有正文 ⇒ 一段
 * `IMarkdownString`，`range` 在场就落 `IRange`。
 *
 * Monaco 0.57 的 `Hover.contents` 只收 `IMarkdownString[]`，所以 `'markdown'` 与缺省 `'text'`
 * 在浮层这一格同形——差别只落在补全的 `documentation` 上。本层不替纯文本编 Markdown 转义，
 * 也不把一段正文拆回多个 part（拆分顺序属渲染判据，不在翻译层）。
 */
export function toMonacoHover(result: EditorHoverResult | undefined): Monaco.languages.Hover | undefined {
  if (result === undefined) return undefined;
  if (result.contents === '') return undefined;
  const range = monacoRangeOf(result.range, '悬停');
  return {
    contents: [{ value: result.contents }],
    ...(range === undefined ? {} : { range }),
  };
}

/* ============================== 宿主事实的注入面 ============================== */

/**
 * 装配点交给工厂的**宿主事实**（全部可选；不传 = 各腿退回自己的缺省）。
 *
 * 三格都**不是语言判据**：它们答的是"这份 model 是哪个文件 / 这个项目有哪些文件 /
 * 跨文件落点怎么造 URI"，只有宿主知道，插件与工厂都不许猜。
 */
export interface SlotServiceHost {
  /** model → 磁盘路径（宿主取归属 EditorPane 的 filePath）；回空 / 抛错 ⇒ 各腿退回 `model.uri` */
  readonly filePathOf?: (model: Monaco.editor.ITextModel) => string | null | undefined;
  /**
   * 项目索引 getter（宿主常驻那一份）。**缺席 = 请求里不带快照**（引用 / 改名只答同文件，
   * 与搬家前"没给 getIndex"逐字相同）。行上注解永远不取它，理由见文件尾那一截。
   */
  readonly projectIndex?: () => Kojo2ProjectIndex | null | undefined;
  /** 跨文件 `path` → `Monaco.Uri`（缺省 `monaco.Uri.file`；转换抛错 / 转不出 ⇒ 退回 model.uri） */
  readonly uriForPath?: (path: string) => Monaco.Uri | undefined;
  /**
   * **行上注解专用**的项目索引 getter（additive，缺省不给）。
   *
   * 与 {@link projectIndex} 分开不是历史包袱：两条腿的**代价模型不同**。引用 / 改名是显式
   * 动作，一次一份快照天经地义；行上注解是每次停笔重算整篇，把项目快照挂上去等于"每敲一会
   * 儿付一次项目级扫描"（见 `codeLensProvider` 的「为什么不取项目快照」）。所以装配点只给
   * `projectIndex`、**不给**这一格——想开项目级计数得先出读数，那时单独打开这一格即可。
   */
  readonly codeLensProjectIndex?: () => Kojo2ProjectIndex | null | undefined;
  /** 项目快照预算（additive；缺省见 legs 的 `KOJO2_PROJECT_FILES_MAX_*`） */
  readonly snapshotLimits?: {
    readonly maxFiles?: number;
    readonly maxBytes?: number;
  };
  /**
   * 快速修复**落地口**（车 5，additive）：宿主接到既有 `applyTextEdits`（前后各一颗
   * `pushUndoStop`），返回是否真落了。只有宿主知道哪枚 EditorPane 持有这份 model、以及
   * 糖视图那种"编辑无处可落"的实例档案——**不是语言判据**。
   *
   * 缺席 = 本腿不落地（动作照常产出；点了不写）。生产装配点一律给。
   */
  readonly applyCodeActionEdits?: (
    model: Monaco.editor.ITextModel,
    edits: readonly EditorTextEdit[],
  ) => boolean;
  /**
   * 槽 `ui.editor.codeAction` 的当前贡献（车 5，**只为可单测**）：缺省现问内核
   * （`kernel.slots.query('ui.editor.codeAction')`，与其他腿读 `ui.editor.languageService`
   * 同一口径）。插件是 bootstrap 的动态 import ⇒ 可能比本工厂晚激活，所以每轮**现取**、
   * 绝不缓存一次（缓存会在"插件晚到"的首个会话里静默少一条腿）。
   */
  readonly codeActionSlot?: () => readonly EditorCodeActionContribution[];
}

/* ============================== 共享小工具（宿主事实，不是判据） ============================== */

/** 取整篇源文；取不到（模型已 dispose / 桩 model）⇒ `null` */
function sourceOf(model: Monaco.editor.ITextModel): string | null {
  try {
    const text = model.getValue();
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/** model 的 uri；没有 uri 的桩 model ⇒ `undefined`（`Location` 缺 uri 无处可落） */
function uriOf(model: Monaco.editor.ITextModel): Monaco.Uri | undefined {
  const uri = (model as unknown as { uri?: unknown }).uri;
  return uri !== null && typeof uri === 'object' ? (uri as Monaco.Uri) : undefined;
}

/**
 * 请求文件路径：注入优先（宿主取归属实例的 filePath），退回 `model.uri` 的 `fsPath` / `path`。
 *
 * `allowUriPath = false` 时**只看 `fsPath`**（改名那条腿的搬家前口径：没有 `fsPath` 就算
 * "没有文件身份"，不拿 `path` 顶替）。两个缺省不同不是笔误，是搬家前两条腿各写了一份。
 */
function pathOfModel(
  model: Monaco.editor.ITextModel,
  filePathOf: SlotServiceHost['filePathOf'],
  allowUriPath = true,
): string | undefined {
  if (filePathOf !== undefined) {
    try {
      const path = filePathOf(model);
      if (typeof path === 'string' && path.length > 0) return path;
    } catch {
      /* 宿主路径解析抛错 ⇒ 退回 uri（绝不让整条腿失败） */
    }
  }
  const uri = uriOf(model) as unknown as { fsPath?: unknown; path?: unknown } | undefined;
  if (uri === undefined) return undefined;
  if (typeof uri.fsPath === 'string' && uri.fsPath.length > 0) return uri.fsPath;
  if (allowUriPath && typeof uri.path === 'string' && uri.path.length > 0) return uri.path;
  return undefined;
}

/** path → Uri（注入优先；缺省 monaco.Uri.file；失败 / 不可用 ⇒ undefined，由调用方兜底） */
function uriForProjectPath(
  monaco: typeof Monaco,
  path: string,
  uriForPath: SlotServiceHost['uriForPath'],
): Monaco.Uri | undefined {
  if (uriForPath !== undefined) {
    try {
      return uriForPath(path);
    } catch {
      return undefined;
    }
  }
  const uriApi = (monaco as unknown as { Uri?: { file?: (path: string) => Monaco.Uri } }).Uri;
  try {
    return typeof uriApi?.file === 'function' ? uriApi.file(path) : undefined;
  } catch {
    return undefined;
  }
}

/** 取一次项目索引：getter 缺席 / 抛错 / 回 null ⇒ `null`（= 请求里没有快照） */
function projectIndexOf(
  getter: SlotServiceHost['projectIndex'],
): Kojo2ProjectIndex | null {
  if (getter === undefined) return null;
  try {
    return getter() ?? null;
  } catch {
    return null;
  }
}

/**
 * 这条腿只答**点名了这一格**的语言吗（见文件头「只答点名了这一格的语言」）。
 *
 * 判据是 descriptor 的声明，不是语言 id：`slotServices`（或新写法 `services.slot`）里
 * 有这一格 ⇒ 这门语言把这条腿交给了插件供方，本层可以替它翻形状；没有 ⇒ 弃权（那门语言
 * 有自己的通道 / 自己的腿）。未登记的语言 id 同样弃权（见函数内注）；只有**桩 model**
 * （没有 `getLanguageId`、或它抛错）⇒ **服务**——旧宿主 / 单测里没有"语言"这回事，
 * 搬家前那条判据对它们也是"当目标语言"。
 */
function servesSlotOf(model: Monaco.editor.ITextModel, kind: SlotServiceKind): boolean {
  let languageId: string | undefined;
  try {
    const id = (model as unknown as { getLanguageId?: () => string }).getLanguageId?.();
    languageId = typeof id === 'string' ? id : undefined;
  } catch {
    return true;
  }
  if (languageId === undefined || languageId.length === 0) return true;
  const descriptor = descriptorForLanguageId(languageId);
  // 未登记的语言 id（外部塞的 / 已退役 / 桩里手写的名字）⇒ **不服务**：没有 descriptor 就没有
  // "这门语言把这条腿交给插件"的声明，替它答就是在替一门不存在的语言说话（搬家前那条
  // "比 kojo2 常量"的判据对这类 id 同样弃权，可观测结果逐字相同）。
  if (descriptor === null) return false;
  // 声明面读语言注册表那一枚（`services.slot` 优先、其次 `slotServices`）：与挂载收口同一份，
  // 别在这里再拼一次三元——拼漏一边就是"挂上了但永远弃权"或"没挂却说在服务"。
  return declaredSlotKinds(descriptor).includes(kind);
}

/* ============================== 契约 → Monaco（格式化） ============================== */

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
 * 一次格式化路（`lineRange` 缺席 = 整篇）：取文 → 单答裁决（legs）→ `TextEdit[]`。
 *
 * `undefined` = 无人应答、`[]` = 有人认这篇且不需要改——两种都落成"没有 edits"，宿主不再分辨。
 * Monaco 把返回的 edits 一次 `executeEdits('formatEditsCommand', …)` 落地 ⇒ 天然一个撤销步；
 * 这里只做"该不该应答 + 形状翻译"，不碰 undo 停点。
 */
function formattingEditsOf(
  model: Monaco.editor.ITextModel,
  lineRange?: { readonly startLine: number; readonly endLine: number },
): Monaco.languages.TextEdit[] {
  const text = modelTextOf(model);
  if (text === null) return [];
  const kernel = requireKernel();
  const edits = collectFormattingEdits(
    kernel.slots.query('ui.editor.languageService'),
    formattingRequestOf(editorRequestIdentityOf(model), text, kernel.project.current(), lineRange),
  );
  if (edits === undefined || edits.length === 0) return [];
  return textEditsOf(model, edits);
}

interface FormattingProviders {
  readonly document: Monaco.languages.DocumentFormattingEditProvider;
  readonly range: Monaco.languages.DocumentRangeFormattingEditProvider;
}

/**
 * 一整条能力 = **两枚 provider**（`Shift+Alt+F` + `Ctrl+K Ctrl+F`），同一个腿、同一条能力名。
 *
 * 区间那条把 Monaco 的 range 折成 `{ startLine, endLine }` 两枚**行号**（1 基、闭区间）塞进
 * 请求——不切串、不折列：2.0 的缩进深度是文档级判据、围栏状态跨行，切片视角会排错。
 */
function formattingProviders(): FormattingProviders {
  return {
    document: {
      displayName: 'kojo-editor',
      provideDocumentFormattingEdits(model) {
        try {
          return formattingEditsOf(model);
        } catch {
          return [];
        }
      },
    },
    range: {
      displayName: 'kojo-editor',
      provideDocumentRangeFormattingEdits(model, range) {
        try {
          return formattingEditsOf(model, {
            startLine: range.startLineNumber,
            endLine: range.endLineNumber,
          });
        } catch {
          return [];
        }
      },
    },
  };
}

/* ============================== 契约 → Monaco（签名帮助） ============================== */

/* -------------------- 触发字符 -------------------- */

/**
 * 签名帮助触发字符（自定并说明）：
 * - `(` —— 刚进调用括号，作者正要填第一个形参；
 * - `,` —— 换到下一个形参（**仅半角**：2.0 的实参分隔符是半角逗号，全角 `，` 不是分隔符）。
 *
 * 不列 `)`：右括号意味着这次调用写完了，提示该收而不是该留。
 *
 * 这一格**只服务注册**（"哪些字符算触发"是编辑器协议的一部分），不是应答判据——
 * 判据在 `@kojo/kojo-lang/signature`，所以它留在宿主、不进包叶。
 */
export const KOJO2_SIGNATURE_TRIGGER_CHARS: readonly string[] = Object.freeze(['(', ',']);

/** 合并触发字符清单并去重（保持先出现者顺序；空串 / 非字符串丢弃）。 */
export function mergeTriggerCharacters(
  base: readonly string[],
  extra: readonly string[] | undefined,
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const ch of [...base, ...(extra ?? [])]) {
    if (typeof ch !== 'string' || ch.length === 0 || seen.has(ch)) continue;
    seen.add(ch);
    merged.push(ch);
  }
  return merged;
}

/* -------------------- 契约 → Monaco -------------------- */

/** `activeSignature` 夹进签名表的合法下标（空表恒 0；编辑器越过只渲染成"无高亮"）。 */
function clampActiveSignature(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(0, Math.trunc(index)), count - 1);
}

/**
 * 契约签名 → Monaco `SignatureHelp`。
 *
 * - `parameters` 只带 `label`：形参的**说明**在契约里是签名级的一枚纯文本（供方已把
 *   "激活那个形参"的说明提到这一层——Monaco 本来也只渲染激活位的说明，屏上文案逐字不变），
 *   所以这里落成 `SignatureInformation.documentation`；
 * - 顶层 `activeParameter` 取当前激活签名的那一格（Monaco 的协议字段在顶层）；
 * - 空表 ⇒ `undefined`（不返回空 help 把提示占住）。
 */
export function toMonacoSignatureHelp(
  signatures: readonly EditorSignature[],
  activeSignature = 0,
): Monaco.languages.SignatureHelp | undefined {
  if (signatures.length === 0) return undefined;
  const active = clampActiveSignature(activeSignature, signatures.length);
  const converted: Monaco.languages.SignatureInformation[] = signatures.map((signature) => ({
    label: signature.label,
    parameters: signature.parameters.map((label) => ({ label })),
    activeParameter: signature.activeParameter,
    ...(signature.documentation === undefined ? {} : { documentation: signature.documentation }),
  }));
  return {
    signatures: converted,
    activeSignature: active,
    activeParameter: converted[active]?.activeParameter ?? 0,
  };
}

/* ============================== 契约 → Monaco（引用） ============================== */

/** 契约落点 → `Monaco.IRange`（区间缺省 = 零宽在落点列；`line` 是唯一必给的行） */
function rangeOfLocation(location: EditorSymbolLocation): Monaco.IRange {
  const startColumn = location.span?.columnStart ?? location.column ?? 1;
  const endColumn = Math.max(location.span?.columnEnd ?? startColumn, startColumn);
  return {
    startLineNumber: location.line,
    startColumn,
    endLineNumber: location.line,
    endColumn,
  };
}

/* ============================== 契约 → Monaco（改名） ============================== */

function toMonacoEditRange(edit: {
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
}): Monaco.IRange {
  return {
    startLineNumber: edit.line,
    startColumn: edit.startColumn,
    endLineNumber: edit.line,
    endColumn: edit.endColumn,
  };
}

/** 名字段区间（prepare 的 1 基四格）→ Monaco `IRange` */
function toMonacoNameRange(range: Kojo2RenameRange): Monaco.IRange {
  return {
    startLineNumber: range.startLine,
    startColumn: range.startColumn,
    endLineNumber: range.endLine,
    endColumn: range.endColumn,
  };
}

/** prepare 的拒绝形状：零宽区间 + 理由（Monaco 见 `rejectReason` 就不弹输入框） */
function prepareRejection(
  position: Monaco.Position,
  reason: string,
): Monaco.languages.RenameLocation & Monaco.languages.Rejection {
  return {
    range: {
      startLineNumber: position.lineNumber,
      startColumn: position.column,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    },
    text: '',
    rejectReason: reason,
  };
}

/** 模型上的静态闸：只读 / 已释放的 model 不是作者源文（预览 / 生成面）——一律不改。 */
function modelRefusal(model: Monaco.editor.ITextModel): string | null {
  try {
    if (typeof model.isDisposed === 'function' && model.isDisposed()) {
      return '模型已释放，改名取消';
    }
    // Monaco 0.57 的 `ITextModel` 没有 `isReadOnly`：只读事实住在 `getOptions().readOnly`。
    const getOptions = (
      model as unknown as { getOptions?: () => { readonly readOnly?: boolean } | undefined }
    ).getOptions;
    if (typeof getOptions === 'function') {
      const options = getOptions.call(model);
      if (options?.readOnly === true) {
        return '这是只读模型（预览 / 生成面）：生成行不能改名，请回到源文件';
      }
    }
  } catch {
    return '读不到模型状态，改名取消';
  }
  return null;
}

/* ============================== 契约 → Monaco（同符号高亮 / 扩选） ============================== */

/**
 * 档位 → Monaco `DocumentHighlightKind`（**唯一映射表**）。
 *
 * `text` = `Text`：Monaco 只画一层弱框（"同名文字"）；`read` / `write` = 引用 / 声明。
 */
export function documentHighlightKindOf(
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

/** 契约链 → 0.57 provider 的扁平数组（内 → 外；运行时自己会按包含关系再排一遍） */
function flattenChain(chain: EditorSelectionChain): Monaco.languages.SelectionRange[] {
  const out: Monaco.languages.SelectionRange[] = [];
  let cursor: EditorSelectionChain | undefined = chain;
  while (cursor !== undefined) {
    out.push({
      range: {
        startLineNumber: cursor.range.startLine,
        startColumn: cursor.range.startColumn,
        endLineNumber: cursor.range.endLine,
        endColumn: cursor.range.endColumn,
      },
    });
    cursor = cursor.parent;
  }
  return out;
}

/* ============================== 契约 → Monaco（行上注解） ============================== */

/** `provideCodeLenses` 的空结果（Monaco 只读；每轮新建一个，不共享可变对象） */
function emptyLensList(): { lenses: Monaco.languages.CodeLens[]; dispose: () => void } {
  return { lenses: [], dispose: () => undefined };
}

/* ============================== 各腿 provider ============================== */

/**
 * 补全 provider（集合型）：取文 / 身份 / 项目 / 触发字符 → 槽 → 并集去重 → Monaco 条目。
 * 任何一抛都只让**这一轮**空结果（Monaco 读得懂的唯一空形状）。
 */
function completionProvider(monaco: typeof Monaco): Monaco.languages.CompletionItemProvider {
  return {
    triggerCharacters: [...KOJO2_COMPLETION_TRIGGER_CHARS],
    provideCompletionItems(model, position, context) {
      try {
        const text = modelTextOf(model);
        if (text === null) return { suggestions: [] };
        const kernel = requireKernel();
        // 合并 / 去重在 legs（`collectCompletionItems`），这里只做协议翻译——provider 里
        // 再写一份合并，就是第二套"谁的答案算数"的判据。
        const items = collectCompletionItems(
          kernel.slots.query('ui.editor.languageService'),
          completionRequestOf(
            editorRequestIdentityOf(model),
            text,
            position.lineNumber,
            position.column,
            kernel.project.current(),
            // 触发字符**原样递**：键入的那一个字符是不是触发符，判据在语言层
            context?.triggerCharacter,
          ),
        );
        return { suggestions: toMonacoCompletionItems(monaco, items, wordRangeAt(model, position)) };
      } catch {
        return { suggestions: [] };
      }
    },
  };
}

/**
 * 悬停 provider（单答型）：声明段 + 展开段由**同一家**供方合成一条 `contents`
 * （K2-EXPAND-VIEW 的分家）。这里不新造第二个 HoverProvider，也不把两段拆回两个 part——
 * Monaco 多 provider 的合并顺序不可控，当年写下的那条理由照旧成立。
 */
function hoverProvider(): Monaco.languages.HoverProvider {
  return {
    provideHover(model, position) {
      try {
        const text = modelTextOf(model);
        if (text === null) return undefined;
        const kernel = requireKernel();
        return toMonacoHover(
          collectHoverResult(
            kernel.slots.query('ui.editor.languageService'),
            hoverRequestOf(editorRequestIdentityOf(model), text, position.lineNumber, position.column, kernel.project.current()),
          ),
        );
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * 签名帮助 provider（单答型）：三态与补全 / 悬停同一套——无人应答 ⇒ `undefined`（Monaco
 * 继续问下一家）、答空表 ⇒ `undefined`（不弹浮层、也不再问下一家）、有签名 ⇒ 一条 help。
 */
function signatureHelpProvider(): Monaco.languages.SignatureHelpProvider {
  return {
    signatureHelpTriggerCharacters: mergeTriggerCharacters(
      KOJO2_SIGNATURE_TRIGGER_CHARS,
      undefined,
    ),
    provideSignatureHelp(model, position) {
      try {
        const text = modelTextOf(model);
        if (text === null) return undefined;
        const kernel = requireKernel();
        // 单答裁决在 legs（`collectSignatureHelp` 第一家作答），这里只递请求、翻形状。
        const signatures = collectSignatureHelp(
          kernel.slots.query('ui.editor.languageService'),
          signatureRequestOf(
            editorRequestIdentityOf(model),
            text,
            position.lineNumber,
            position.column,
            kernel.project.current(),
          ),
        );
        if (signatures === undefined) return undefined;
        const help = toMonacoSignatureHelp(signatures);
        return help === undefined ? undefined : { value: help, dispose: () => undefined };
      } catch {
        // 抛错的另一面是"提示突然没了"；`undefined` 是 Monaco 读得懂的"这次不应答"。
        return undefined;
      }
    },
  };
}

/**
 * 引用 provider（集合型，Shift+F12）。三态：无人应答 ⇒ `[]`；有人答空 ⇒ `[]`；有结果 ⇒ 逐条
 * 翻译。`truncated === true` 时 warn 一条（Peek 列表没有"截断"位；不静默少给，是这一层能做的
 * 如实表达）。`includeDeclaration === false` 去掉声明位（契约里声明位的 `kind` 是 `definition`）。
 */
function referencesProvider(
  monaco: typeof Monaco,
  host: SlotServiceHost,
): Monaco.languages.ReferenceProvider {
  return {
    provideReferences(model, position, context) {
      try {
        const source = sourceOf(model);
        if (source === null) return [];
        const modelUri = uriOf(model);
        if (modelUri === undefined) return [];

        const identity = editorRequestIdentityOf(model);
        const path = pathOfModel(model, host.filePathOf);
        const requestIdentity = path === undefined ? identity : { ...identity, path };

        const snapshot = projectFilesSnapshotOf(
          projectIndexOf(host.projectIndex),
          path ?? '',
          host.snapshotLimits ?? {},
        );

        const kernel = requireKernel();
        // 单答裁决在 legs（`collectReferences` 第一家作答），这里只递请求、翻形状。
        const result = collectReferences(
          kernel.slots.query('ui.editor.languageService'),
          referencesRequestOf(
            requestIdentity,
            source,
            position.lineNumber,
            position.column,
            kernel.project.current(),
            snapshot,
          ),
        );
        if (result === undefined) return [];

        const includeDeclaration = context?.includeDeclaration !== false;
        const locations: Monaco.languages.Location[] = [];
        for (const location of result.locations) {
          if (!includeDeclaration && location.kind === 'definition') continue;
          const sameFile = path === undefined || location.filePath === path || location.filePath === '';
          const uri = sameFile
            ? modelUri
            : (uriForProjectPath(monaco, location.filePath, host.uriForPath) ?? modelUri);
          locations.push({ uri, range: rangeOfLocation(location) });
        }
        if (result.truncated === true) {
          console.warn(
            `[slot-service-providers] 引用集合被截断（${locations.length} 条已显示）：项目快照或单次上限先到`,
          );
        }
        return locations;
      } catch {
        // Monaco 把 throw 吞成"引用面板突然空了"；空数组是它能读出的唯一形状。
        return [];
      }
    },
  };
}

/**
 * 改名 provider（F2）。四件宿主事实：只读 / 已释放闸、model → 请求（含项目快照）、
 * 契约 → `WorkspaceEdit`（`rejectReason` 原样交给 `rename-rejection` 的回执）、弃权门。
 *
 * `resolveRenameLocation` **不持有第二套判据**：只调包里的 `kojo2PrepareRename`（唯一那把
 * 尺子），把它的「符号名 + 名字段区间 / 第一条拒绝理由」翻成 Monaco 的 prepare 形状。放在
 * 这里是因为宿主才有 model 与光标（插件拿不到）；F2 的第一道体验——不在符号上 / 只读 /
 * 本文件重名时**不弹输入框**、直接就近说明理由——由它保住。
 */
function renameProvider(monaco: typeof Monaco, host: SlotServiceHost): Monaco.languages.RenameProvider {
  return {
    resolveRenameLocation(model, position) {
      try {
        if (!servesSlotOf(model, 'rename')) return undefined;
        const refusal = modelRefusal(model);
        if (refusal !== null) return prepareRejection(position, refusal);
        const source = sourceOf(model);
        if (source === null) return prepareRejection(position, '取不到这份文件的内容，改名取消');
        // 判据只有包里那一把尺子：这里只翻形状（不复制 locate / duplicates / 位置门）。
        const prepared = kojo2PrepareRename(source, {
          line: position.lineNumber,
          column: position.column,
        });
        if (prepared.blockers.length > 0) {
          return prepareRejection(position, prepared.blockers[0] ?? '这里不能改名');
        }
        if (prepared.symbol === null || prepared.range === null) {
          return prepareRejection(position, '这里没有可改名的符号');
        }
        return { range: toMonacoNameRange(prepared.range), text: prepared.symbol.name };
      } catch {
        return prepareRejection(position, '解析改名位置失败，改名取消');
      }
    },
    provideRenameEdits(model, position, newName) {
      try {
        if (!servesSlotOf(model, 'rename')) return undefined;
        const refusal = modelRefusal(model);
        if (refusal !== null) return reject(refusal);
        const source = sourceOf(model);
        if (source === null) return reject('取不到这份文件的内容，改名取消');

        // 改名那条腿的搬家前口径：只看 `fsPath`（没有就算"没有文件身份"，不拿 `path` 顶替）。
        const path = pathOfModel(model, host.filePathOf, false) ?? null;
        const identity = editorRequestIdentityOf(model);
        const requestIdentity = path === null ? identity : { ...identity, path };

        const snapshot = projectFilesSnapshotOf(
          projectIndexOf(host.projectIndex),
          path ?? '',
          host.snapshotLimits ?? {},
        );

        const kernel = requireKernel();
        // 单答裁决在 legs（`collectRename` 第一家作答），这里只递请求、翻形状。
        const result = collectRename(
          kernel.slots.query('ui.editor.languageService'),
          renameRequestOf(
            requestIdentity,
            source,
            position.lineNumber,
            position.column,
            newName,
            kernel.project.current(),
            snapshot,
          ),
        );
        if (result === undefined) {
          return reject('没有语言服务应答这次改名（插件未安装或弃权），改名取消');
        }
        if (result.rejectReason !== undefined) return reject(result.rejectReason);
        if (result.edits.length === 0) {
          return reject('没有可落地的编辑（引用集为空），改名取消');
        }

        const modelUri = uriOf(model);
        if (modelUri === undefined) {
          return reject('这份文件没有 URI，无法构造 WorkspaceEdit');
        }
        const uriForPath: (target: string) => Monaco.Uri | undefined = (target) =>
          host.uriForPath !== undefined ? host.uriForPath(target) : monaco.Uri.file(target);
        return {
          edits: result.edits.map((edit) => {
            const resourcePath = edit.resourcePath;
            // 请求文件自己（或缺省落点）用 model 的 URI（保留编辑器侧的 scheme / 大小写口径），
            // 其余路径交给宿主注入的映射（缺省按磁盘路径造 file URI）。
            const sameFile =
              resourcePath === undefined ||
              resourcePath.length === 0 ||
              (path !== null && resourcePath === path);
            const resource = sameFile
              ? modelUri
              : (uriForProjectPath(monaco, resourcePath, host.uriForPath) ??
                uriForPath(resourcePath) ??
                modelUri);
            return {
              resource,
              versionId: undefined,
              textEdit: { range: toMonacoEditRange(edit), text: edit.newText },
            };
          }),
        };
      } catch {
        return reject('重命名失败：取文或编排抛错，改名取消');
      }
    },
  };
}

/**
 * 同符号高亮 provider（单答型）。三态：无人应答 ⇒ **`undefined`**（不是 `[]`）——
 * Monaco 按"第一个非空应答"裁决，而 `[]` 是**有效作答**，会顶掉排在后头的提供方；
 * 有人答空 ⇒ `[]`（定义性作答）；异常 ⇒ `[]`（已"认领这一格"，再交 `undefined` 会让别家
 * 在异常之上叠一层解释不清的高亮）。
 */
function documentHighlightProvider(
  monaco: typeof Monaco,
): Monaco.languages.DocumentHighlightProvider {
  return {
    provideDocumentHighlights(model, position) {
      try {
        if (!servesSlotOf(model, 'documentHighlight')) return undefined;
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
          kind: documentHighlightKindOf(monaco, highlight.kind),
        }));
      } catch {
        // Monaco 把 throw 吞成"高亮突然没了"；空数组是它能读出的唯一形状。
        return [];
      }
    },
  };
}

/**
 * 结构化扩选 provider（单答型，0.57 扁平形状）。三态：无人应答 ⇒ `undefined`（不伪造
 * "没有扩选"的作答）、某位点 `null` ⇒ 该位点 `[]` 其余照常、异常 ⇒ `[]`。
 *
 * 摊平**只在这一层做**（契约给的是嵌套链，0.57 要"每位点一个 `SelectionRange[]`"）——
 * 换 Monaco 版本只动这里。
 */
function selectionRangeProvider(): Monaco.languages.SelectionRangeProvider {
  return {
    provideSelectionRanges(model, positions) {
      try {
        if (!servesSlotOf(model, 'selectionRange')) return undefined;
        const text = modelTextOf(model);
        if (text === null) return [];
        const wanted = Array.isArray(positions)
          ? positions.map((position) => ({ line: position.lineNumber, column: position.column }))
          : [];
        const kernel = requireKernel();
        const result = collectSelectionRanges(
          kernel.slots.query('ui.editor.languageService'),
          selectionRangeRequestOf(
            editorRequestIdentityOf(model),
            text,
            wanted,
            kernel.project.current(),
          ),
        );
        if (result === undefined) {
          // 无人应答：交 `undefined`（不伪造一份"没有扩选"的作答）。
          return undefined;
        }
        return result.selections.map((chain) => (chain === null ? [] : flattenChain(chain)));
      } catch {
        return [];
      }
    },
  };
}

/**
 * 行上注解 provider（单答型按第一应答裁决）。三态：无人应答 ⇒ `undefined`（别交
 * `{ lenses: [] }` 去顶掉别家）、有人答空 ⇒ `{ lenses: [] }`、异常 ⇒ `{ lenses: [] }`。
 *
 * 翻译复用 **v1 那枚既有翻译器**（`kojo-code-lens.ts` 的 `toMonacoCodeLenses`）：越界行一律
 * 丢弃、零宽区间钉在行首、命令 id 就是已注册的那个（点击复用既有导航通道）。抄一份新的会
 * 立刻漂成两套落点口径。
 *
 * ## 大文件闸判在**问供方之前**，与 v1 注解同一条线
 *
 * `LARGE_FILE_LINES` 之上不问供方：省掉的是一次整篇词法 + 每个定义一次引用查询。判在问之前
 * （`getLineCount` 一行就有）。供方自己还有一道"只产前 N 条"的渲染预算（口径在包里），
 * 两档不重叠：这里决定"这一篇办不办"，那里决定"办的话画几条"。
 *
 * ## 为什么不取项目快照（B3g 明说的一格缺口，理由在此）
 *
 * 契约这一格与插件那侧都已装得下项目快照（{@link codeLensRequestOf} 走
 * `projectFilesSnapshotOf`——与引用 / 改名同一条腿、同一组上限）。**装配点不给它**：
 * 引用（Shift+F12）/ 改名（F2）是**显式动作**，一次一份快照天经地义；行上注解是**每次停笔
 * 都重算整篇**（`codelensController.js` 的 `onDidChangeModelContent → scheduler.schedule()`），
 * 一份快照 = 全项目文本（最多 400 份 / 8 MiB）再建一张临时索引（每份一次 `lex + parse`）。
 * 于是这一格默认**缺席**：供方按同文件计数（与 B3g 之前逐字相同）。
 */
function codeLensProvider(host: SlotServiceHost): Monaco.languages.CodeLensProvider {
  return {
    provideCodeLenses(model) {
      try {
        if (typeof model.isDisposed === 'function' && model.isDisposed()) return emptyLensList();
        const text = modelTextOf(model);
        if (text === null) return emptyLensList();
        // 大文件档：判在**问供方之前**（省一次整篇词法 + 每个定义一次引用查询）。
        if (typeof model.getLineCount === 'function' && model.getLineCount() >= LARGE_FILE_LINES) {
          return emptyLensList();
        }

        const identity = editorRequestIdentityOf(model);
        const path = pathOfModel(model, host.filePathOf) ?? undefined;
        const requestIdentity = path === undefined ? identity : { ...identity, path };

        // 索引**只认这一格**（见上面「为什么不取项目快照」）：装配点不给 ⇒ 请求里没有
        // `projectFiles`，供方按同文件计数。
        const snapshot = projectFilesSnapshotOf(
          projectIndexOf(host.codeLensProjectIndex),
          path ?? '',
          host.snapshotLimits ?? {},
        );
        const kernel = requireKernel();
        // 单答裁决在 legs（`collectCodeLensResult` 第一家作答），这里只递请求、翻形状。
        const result = collectCodeLensResult(
          kernel.slots.query('ui.editor.languageService'),
          codeLensRequestOf(requestIdentity, text, kernel.project.current(), snapshot),
        );
        // 无人应答 ⇒ `undefined`（别交空列表去顶掉别家）。
        if (result === undefined) return undefined;
        return { lenses: toMonacoCodeLenses(model, result.lenses), dispose: () => undefined };
      } catch {
        // 注解是只读呈现面：出错就"这一篇没有注解"，绝不把编辑器的输入链带崩
        return emptyLensList();
      }
    },
  };
}

/* ============================== 契约 → Monaco（快速修复 / 迁移动作） ============================== */

/**
 * 动作执行命令 id（宿主统一注册一次；参数 = 待落地动作的反查 key）。
 *
 * id 字面量**逐字保留**自 B3j（命令 id 是对外可见的身份：键位 / 手记 / 调试脚本可能按它查），
 * 改名只在导出符号上做——它现在住通用工厂，名字不再带某一门语言。
 */
export const SLOT_CODE_ACTION_COMMAND = 'kojo2.codeAction.run';

/**
 * 本腿会产出的 Monaco 类别（`providedCodeActionKinds` 的交集判据）。
 *
 * 为什么不是"只声明 quickfix"：槽里的贡献方两类都给（结构修复是 quickfix、写法重写类动作
 * 是 refactor）。`mayIncludeActionsOfKind` 是**交集**判定——只声明 quickfix 会让 provider 在
 * "重构"这条显式请求下不被调用（那是回退，不是收益）。判据与 v1 那枚同源
 * （`kojo-code-action.ts` 的 `PROVIDED_CODE_ACTION_KINDS`）。
 */
export const SLOT_CODE_ACTION_KINDS: readonly string[] = [QUICK_FIX_KIND, REFACTOR_KIND];

/** 待落地动作表的上限（每次请求登记若干条；超了丢最老的，绝不无界增长） */
const PENDING_ACTION_LIMIT = 256;

/** 空动作表（Monaco 读得懂的"这一轮没有动作"） */
function emptyCodeActionList(): Monaco.languages.CodeActionList {
  return { actions: [], dispose: () => undefined };
}

/** 槽贡献的现取口：注入优先（可单测），缺省现问内核——插件晚到也不会被缓存吃掉 */
function codeActionContributionsOf(
  host: SlotServiceHost,
): readonly EditorCodeActionContribution[] {
  if (host.codeActionSlot !== undefined) {
    try {
      return host.codeActionSlot();
    } catch {
      return [];
    }
  }
  try {
    return requireKernel().slots.query('ui.editor.codeAction');
  } catch {
    return [];
  }
}

/** 当前项目（喂 `run` 型动作；没有内核 / 未开项目 ⇒ `null`，与注入面的旧缺省逐字相同） */
function currentProjectOf(): GameProject | null {
  try {
    return requireKernel().project.current();
  } catch {
    return null;
  }
}

/** 槽里的一家贡献抛错 ⇒ 只丢这一家（与共享收口同一条隔离纪律） */
function provideActionsSafely(
  contribution: EditorCodeActionContribution,
  request: Parameters<EditorCodeActionContribution['provideActions']>[0],
): EditorCodeAction[] {
  try {
    return contribution.provideActions(request);
  } catch (error: unknown) {
    console.warn(
      `[slot-service-providers] '${contribution.id}' provideActions 抛错：${errorText(error)}`,
    );
    return [];
  }
}

/**
 * 槽动作 → Monaco `CodeAction[]`（**只做翻译**，判据与文案全在插件与包）。
 *
 * - `command` 而不是 `edit`：落地必须走宿主那条带 undo 停点的通道（见 {@link codeActionProviders}）；
 * - `diagnostics`：把动作认领的诊断翻成 marker（Monaco 据此排序 / 画"已修复区间"）；
 *   省略而不是空数组——`undefined` 才是"这条动作不是冲着某条诊断来的"的原意；
 * - `isPreferred`：**本次请求里恰好只有一条 quickfix** 时置（多解不替作者选，与 v1 那枚
 *   `pickPreferred` 同一产品意图）；
 * - 顺序：贡献方顺序 × 各自产出顺序，一条都不重排（Monaco 的 CodeAction 列表按它展示）。
 */
function codeActionsOf(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  contributions: readonly EditorCodeActionContribution[],
  request: Parameters<EditorCodeActionContribution['provideActions']>[0],
  register: (action: EditorCodeAction) => string,
): Monaco.languages.CodeAction[] {
  const actions: Monaco.languages.CodeAction[] = [];
  const quickfixes: Monaco.languages.CodeAction[] = [];
  for (const contribution of contributions) {
    for (const action of provideActionsSafely(contribution, request)) {
      const actionId = register(action);
      const kind = monacoActionKind(action.kind);
      const markers = actionDiagnostics(monaco, model, action);
      const translated: Monaco.languages.CodeAction = {
        title: action.title,
        kind,
        command: { id: SLOT_CODE_ACTION_COMMAND, title: action.title, arguments: [actionId] },
        ...(markers !== undefined ? { diagnostics: markers } : {}),
      };
      actions.push(translated);
      if (kind === QUICK_FIX_KIND) quickfixes.push(translated);
    }
  }
  if (quickfixes.length === 1) quickfixes[0]!.isPreferred = true;
  return actions;
}

/** 一次安装里的快速修复腿：provider（逐门语言共用）+ 全局命令（首次挂上时注册） */
interface CodeActionProviders {
  readonly provider: Monaco.languages.CodeActionProvider;
  /**
   * 命令句柄（**幂等、按使用者计数**）：命令是全局的、不是语言级的，同一条腿铺到几门语言
   * 也只有一个处理器；撤到最后一门才真撤（半途回滚不会把还在服务的语言留成"点了没反应"）。
   */
  readonly command: (monaco: typeof Monaco) => Monaco.IDisposable;
}

/**
 * 快速修复 / 迁移动作 provider（车 5，判据与供方都在插件与包）。
 *
 * 本层只做四件事：**定位**（model / 光标 / marker）、**问槽**（`ui.editor.codeAction`）、
 * **翻译**（契约动作 → Monaco `CodeAction`）、**落地**（宿主注入的 `applyCodeActionEdits`
 * → 既有 `applyTextEdits`，前后各一颗 undo 停点 ⇒ `Ctrl+Z` 只退机器那一步）。
 *
 * 只答**点名了 `codeAction`** 的语言（{@link servesSlotOf}，与同符号高亮 / 改名同一道门）：
 * 这一腿也会被 `registerForLanguageServices` 铺到 `languageServices: true` 的语言上，而
 * 那些语言的 💡 有自己的接线（v1 的 `kojo-code-action` 合并 provider）——不先弃权就会把
 * 别人的动作当自己的再交一遍。
 *
 * 三态：没点名 / 零波浪线 / 取不到文 / 取不到路径 ⇒ **空表**（不伪造动作）；贡献方抛错只丢
 * 那一家；本轮任何异常都收成空表（Monaco 会把 throw 吞成"💡 突然空了"，作者看不到原因）。
 */
function codeActionProviders(
  monaco: typeof Monaco,
  host: SlotServiceHost,
): CodeActionProviders {
  const pending = new Map<
    string,
    { readonly uri: string; readonly path: string; readonly action: EditorCodeAction }
  >();
  const order: string[] = [];
  let seq = 0;
  let commandRegistration: Monaco.IDisposable | null = null;
  let commandUsers = 0;

  const remember = (uri: string, path: string, action: EditorCodeAction): string => {
    const key = `${++seq}`;
    pending.set(key, { uri, path, action });
    order.push(key);
    while (order.length > PENDING_ACTION_LIMIT) {
      const oldest = order.shift();
      if (oldest !== undefined) pending.delete(oldest);
    }
    return key;
  };

  const land = (monaco: typeof Monaco, key: string): void => {
    const entry = pending.get(key);
    if (entry === undefined) return;
    const model = monaco.editor.getModel(monaco.Uri.parse(entry.uri));
    if (model === null || model.isDisposed()) return;
    try {
      if (entry.action.edits !== undefined && entry.action.edits.length > 0) {
        host.applyCodeActionEdits?.(model, entry.action.edits);
        return;
      }
      // 没有 edits 的动作退回契约旧语义（`run` 发意图）：本供方今天不产这种，但槽是开放的
      // ——第三方贡献方给"导航型"动作时不该被这层吞掉。
      void entry.action.run({ project: currentProjectOf(), activeFile: entry.path });
    } catch (error: unknown) {
      console.warn(`[slot-service-providers] 落地动作时抛错：${errorText(error)}`);
    }
  };

  const command = (monaco: typeof Monaco): Monaco.IDisposable => {
    commandUsers += 1;
    if (commandRegistration === null) {
      commandRegistration = monaco.editor.registerCommand(
        SLOT_CODE_ACTION_COMMAND,
        (_accessor, key: unknown) => {
          if (typeof key !== 'string') return;
          land(monaco, key);
        },
      );
    }
    let released = false;
    return {
      dispose() {
        if (released) return;
        released = true;
        commandUsers -= 1;
        if (commandUsers > 0) return;
        const handle = commandRegistration;
        commandRegistration = null;
        try {
          handle?.dispose();
        } catch {
          /* 撤命令失败不改结论：撤到最后一门时编辑器正在关，命令随窗口走 */
        }
      },
    };
  };

  const provider: Monaco.languages.CodeActionProvider = {
    provideCodeActions(model, range, context) {
      try {
        if (!servesSlotOf(model, 'codeAction')) return emptyCodeActionList();
        const source = sourceOf(model);
        if (source === null) return emptyCodeActionList();
        // 零波浪线 ⇒ 一条都不问槽：本族动作全部按"面上画着的那条红线"应答（判据之前那次
        // 整篇 parse 也白付）。这一档**不减能力**：没有可修的红线时本来也是零条动作。
        const diagnostics = markersToDecorations(monaco, context.markers ?? []);
        if (diagnostics.length === 0) return emptyCodeActionList();
        const path = pathOfModel(model, host.filePathOf);
        if (path === undefined || path.length === 0) return emptyCodeActionList();
        const line = Number.isFinite(range.startLineNumber) ? range.startLineNumber : undefined;
        const actions = codeActionsOf(
          monaco,
          model,
          codeActionContributionsOf(host),
          {
            path,
            text: source,
            project: currentProjectOf(),
            ...(line !== undefined ? { line } : {}),
            lineCount: model.getLineCount(),
            diagnostics,
          },
          (action) => remember(uriOf(model)?.toString() ?? '', path, action),
        );
        if (actions.length === 0) return emptyCodeActionList();
        return { actions, dispose: () => undefined };
      } catch (error: unknown) {
        console.warn(`[slot-service-providers] 产出动作时抛错：${errorText(error)}`);
        return emptyCodeActionList();
      }
    },
  };

  return { provider, command };
}

/* ============================== 表 + 安装 ============================== */

/**
 * 一条槽腿：`kind` + Monaco 注册 API + provider 工厂（请求构造与契约 → Monaco 都封在工厂里）。
 *
 * 类型对 `SlotServiceKind` 全集开放；后续腿（`foldingRange` / `inlayHint` / `documentSymbol` /
 * `definition` / `semanticToken`）只需在 {@link SLOT_SERVICE_LEGS} 里补一枚 `legOf(...)`，
 * 安装器与回滚一行都不用改。
 */
export interface SlotServiceLeg {
  readonly kind: SlotServiceKind;
  /**
   * 建 provider（**每次安装建一次**，同一条腿铺到的每一门语言共用那一枚）。
   * 与搬家前逐字相同：七枚安装器都是"建一枚 provider，再挂到每一门语言上"。
   */
  readonly create: (monaco: typeof Monaco, host: SlotServiceHost) => unknown;
  /** 挂到收口给的 `id` 上（provider 由 {@link SlotServiceLeg.create} 给，无共享可变状态） */
  readonly register: (
    monaco: typeof Monaco,
    languageId: string,
    provider: unknown,
  ) => Monaco.IDisposable;
}

function legOf<P>(
  kind: SlotServiceKind,
  create: (monaco: typeof Monaco, host: SlotServiceHost) => P,
  register: (monaco: typeof Monaco, languageId: string, provider: P) => Monaco.IDisposable,
): SlotServiceLeg {
  return {
    kind,
    create,
    // 唯一一处 `unknown → P` 的收窄：`legOf` 的实参已在编译期配好对，表本身是异构数组
    register: (monaco, languageId, provider) => register(monaco, languageId, provider as P),
  };
}

/**
 * 已实现的槽腿——**数组序即注册序**。车 1 两格（补全先、悬停后）与搬家前逐字相同；车 2–4
 * 的七格一律**追加**，别插队。
 */
export const SLOT_SERVICE_LEGS: readonly SlotServiceLeg[] = [
  legOf('completion', completionProvider, (m, id, provider) =>
    m.languages.registerCompletionItemProvider(id, provider),
  ),
  legOf('hover', hoverProvider, (m, id, provider) => m.languages.registerHoverProvider(id, provider)),
  // 车 2：格式化（整篇 + 区间，一条能力两枚 provider）与签名帮助
  legOf('formatting', formattingProviders, (m, id, providers) => {
    // 两枚 provider 同挂在一个 id 上：区间那条**先**注册也**先**撤——整篇那条是
    // `Shift+Alt+F` 的主路，撤一半时留下的必须是它（与搬家前"两枚安装器各自回滚"同向）。
    const document = m.languages.registerDocumentFormattingEditProvider(id, providers.document);
    try {
      const range = m.languages.registerDocumentRangeFormattingEditProvider(id, providers.range);
      return {
        dispose: () => {
          document.dispose();
          range.dispose();
        },
      };
    } catch (error) {
      // 半途抛错：这一门已挂上的整篇那枚先撤回，再原样外抛（收口那层才有东西可撤）
      try {
        document.dispose();
      } catch {
        /* 撤不掉也不外抛：错误已在上抛路上 */
      }
      throw error;
    }
  }),
  legOf('signatureHelp', signatureHelpProvider, (m, id, provider) =>
    m.languages.registerSignatureHelpProvider(id, provider),
  ),
  // 车 3：引用与改名（显式动作，项目快照由宿主注入口现取）
  legOf('references', referencesProvider, (m, id, provider) =>
    m.languages.registerReferenceProvider(id, provider),
  ),
  legOf('rename', renameProvider, (m, id, provider) => m.languages.registerRenameProvider(id, provider)),
  // 车 4：同符号高亮 / 结构化扩选 / 行上注解（三格都只答点名了这一格的语言，见文件头）
  legOf('documentHighlight', documentHighlightProvider, (m, id, provider) =>
    m.languages.registerDocumentHighlightProvider(id, provider),
  ),
  legOf('selectionRange', selectionRangeProvider, (m, id, provider) =>
    m.languages.registerSelectionRangeProvider(id, provider),
  ),
  legOf('codeLens', (_monaco, host) => codeLensProvider(host), (m, id, provider) =>
    m.languages.registerCodeLensProvider(id, provider),
  ),
  // 车 5：快速修复 / 一键迁移（供方在专用槽 `ui.editor.codeAction`；它是**写面**，
  // 宿主按切流策略单独装——见 {@link SLOT_SERVICE_WRITE_LEGS}）
  legOf('codeAction', codeActionProviders, (m, id, providers) => {
    // 命令是**全局**的（不是语言级）：第一次挂上时注册，撤到最后一门才撤。
    const command = providers.command(m);
    try {
      const provider = m.languages.registerCodeActionProvider(id, providers.provider, {
        providedCodeActionKinds: [...SLOT_CODE_ACTION_KINDS],
      });
      return {
        dispose: () => {
          try {
            command.dispose();
          } finally {
            provider.dispose();
          }
        },
      };
    } catch (error) {
      // 半途抛错：这一门已注册的那枚命令先撤回（其余语言由收口回滚），再原样外抛
      try {
        command.dispose();
      } catch {
        /* 撤不掉也不外抛：错误已在上抛路上 */
      }
      throw error;
    }
  }),
];

/**
 * 表里属于**写面 / 迁移入口**的腿（车 5）：它们的动作会改写缓冲（或引导一次改写），
 * 不属 K2-SURFACE-DEFAULT 的只读语言面 ⇒ {@link installSlotServiceProviders} **不装**它们，
 * 由宿主按自己的策略单独装（今天 = `editor-global-providers.ts` 的切流开关块里
 * `installSlotServiceLegs(monaco, SLOT_SERVICE_WRITE_LEGS, host)`）。
 *
 * 这是**数据**不是注释：把它从这张表里摘掉，切流关着时那条写面 provider 就会被无条件挂上
 * （`kojo2-structure-gate.test.ts` ③ 逐枚量注册次数）；把别的腿塞进来，那条腿就会从
 * "无条件装配"悄悄变成"受门控"。
 */
export const SLOT_SERVICE_WRITE_LEGS: readonly SlotServiceKind[] = Object.freeze(['codeAction']);

/** 按 kind 取一条腿（没实现 ⇒ `undefined`：调用方自己决定怎么报，别在这里造空 provider） */
export function slotServiceLegOf(kind: SlotServiceKind): SlotServiceLeg | undefined {
  return SLOT_SERVICE_LEGS.find((leg) => leg.kind === kind);
}

/**
 * 装**指定的**那几条腿（按 `kinds` 给定顺序；不存在的 kind 跳过），返回**幂等** disposable。
 *
 * 单测按 kind 只装一条腿时走这里（桩 Monaco 只桩那一两条注册函数）；生产装配走
 * {@link installSlotServiceProviders}（表里**除写面腿之外**的全部），写面腿（
 * {@link SLOT_SERVICE_WRITE_LEGS}）由宿主在自己的策略块里用本函数单独装。
 */
export function installSlotServiceLegs(
  monaco: typeof Monaco,
  kinds: readonly SlotServiceKind[],
  host: SlotServiceHost = {},
): Monaco.IDisposable {
  const registrations: Monaco.IDisposable[] = [];
  try {
    for (const kind of kinds) {
      const leg = slotServiceLegOf(kind);
      // 表里没写这枚 kind ⇒ 不挂：宿主不许"顺手"给一门语言挂上一条没有供方的腿。
      if (leg === undefined) continue;
      // provider **建一次**（与搬家前"建一枚挂多门"逐字相同）；建它本身不接触 Monaco，
      // 抛错只可能来自各腿自己的工厂，那时还没有任何注册需要回滚。
      const provider = leg.create(monaco, host);
      // **逐条 push，不写成 `push(a, b)`**：求值都在参数位上，第二条抛错时第一条的句柄还没进
      // 数组，catch 里就是"无东西可撤"——那正是"全有或全无"承诺的反面。
      registrations.push(
        registerForLanguageServices(
          monaco,
          (m, id) => leg.register(m, id, provider),
          leg.kind,
          // 写面腿只挂**点名**它的语言（见 `register-dialects.ts` 的 `namedOnly`）：
          // v1 的语言自带写面 provider，不该被铺一枚永远弃权的空腿。
          { namedOnly: SLOT_SERVICE_WRITE_LEGS.includes(leg.kind) },
        ),
      );
    }
  } catch (error) {
    for (const registration of registrations) {
      try {
        registration.dispose();
      } catch {
        /* 半途回滚：一条撤不掉不许带走其余（错误原样外抛给宿主） */
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
          /* 幂等 + 逐枚隔离：一条抛错不影响其余撤离 */
        }
      }
    },
  };
}

/**
 * 装**表里全部**槽腿，返回**幂等**的 disposable。
 *
 * 不传任何语言判据：adapter / 文件身份 / 编译成品 / 候选投影都由插件供方在请求时现取，
 * 宿主只交 {@link SlotServiceHost} 那三格（"这份 model 是哪个文件 + 当前项目有哪些文件 +
 * 跨文件 URI 怎么造"）。
 *
 * 无条件注册（K2-SURFACE-DEFAULT）。注册半途抛错 ⇒ 撤回已装完的那几条腿再外抛；每条腿的
 * 错误面收在各自体内：任何一腿抛错都只让**那一轮**空结果，编辑器不受影响。
 */
export function installSlotServiceProviders(
  monaco: typeof Monaco,
  host: SlotServiceHost = {},
): Monaco.IDisposable {
  return installSlotServiceLegs(
    monaco,
    // 写面 / 迁移入口的腿不在这条"无条件装配"里（见 {@link SLOT_SERVICE_WRITE_LEGS}）。
    SLOT_SERVICE_LEGS.map((leg) => leg.kind).filter(
      (kind) => !SLOT_SERVICE_WRITE_LEGS.includes(kind),
    ),
    host,
  );
}