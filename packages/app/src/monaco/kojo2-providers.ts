/**
 * Kojo 2.0 的补全与悬停：**契约 → Monaco 的翻译层**（B3c，2026-10-28 供方交给插件）。
 *
 * ## 这一格里只剩"翻译"，判据一枚都不许留
 *
 * 本文件曾经同时住着三类东西：**语言判据**（触发字符、名字段怎么切、声明索引、悬停正文的
 * Markdown 措辞、adapter 的三路投影）、**供方编排**（问谁、怎么合并）与 **Monaco 协议翻译**。
 * B3c 把前两类整块搬走：判据的唯一落点是 `@kojo/kojo-lang`（`completion.ts` /
 * `completion-snippets.ts` / `hover.ts`），作答的是插件 `@kojo/plugin-kojo-lang` 在
 * `ui.editor.languageService` 槽里登记的 `kojo2-completion` / `kojo2-hover` 两枚贡献。
 * 这里若再留一份判据当"兜底"，同一格就有了两份答案——两枚 provider 并存时 Monaco 的合并
 * 顺序不可控，"补全少一条 / 悬停多一段"从此只能靠注册顺序解释（B3b 删原生 DefinitionProvider
 * 是同一条理由，那条理由现在更硬）。
 *
 * ## 留下的三件事，每一件都是"插件看不到"的宿主事实
 *
 * 1. **model → 请求**：`path`（`model.uri.fsPath`；插件拿它去查展开编译成品的登记表，
 *    取不到就是没有文件身份 ⇒ 少展开那一段，**不猜**）、`languageId` / `version`（原样取自
 *    model，宿主不改写、不猜）、全文，以及当前项目（`kernel.project.current()`——项目事实
 *    只在内核里，插件只能从请求里读）。构造一律走 legs 的 `completionRequestOf` /
 *    `hoverRequestOf`（与 `formattingRequestOf` 同源形状）：手抄一份对象字面量，抄漏
 *    `version` 的那条腿就废掉了供方的过期复核，而这类失准只在"改完文件后的第一次应答"里
 *    出现，事后极难归因。合并与单答裁决也一律在 legs（`collectCompletionItems` 并集去重 /
 *    `collectHoverResult` 第一家作答），provider 里不写第二份。
 * 2. **响应 → Monaco 协议**：`range` → `IRange`、`filterText` 透传、`documentation` 按
 *    `documentationFormat` 分 Markdown / 纯文本、`insertTextFormat` 决定要不要打开模板插入
 *    通道（见下）。
 * 3. **图标表**：`kojo2CompletionKindOf` 吃**契约档**（`EditorCompletionItemKind` 十二档）、
 *    吐 Monaco 枚举。这是本文件唯一保留的映射——挑哪枚图标是编辑器的事，插件看不到 Monaco；
 *    宿主也不许给某一档另发明第二重语义。
 *
 * adapter 事实**不再由宿主注入**：插件经 `@kojo/kojo-lang/adapter-source` 登记簿在请求时
 * 现取，并且只认 `adapter.id === request.project.adapterId` 的那一枚（对不上 ⇒ `# 机` /
 * `@织` / 事件参数 / 颜绘参数四路零候选，其余照给）。装配点因此不再传
 * `{ adapter, getFilePath, getCompile, completion }`——那四格注入面连同它们背后的判据副本
 * 一起没了，留下的只有"这份 model 是谁"。
 *
 * ## 插入语义：`kind: 'snippet'` ≠ `insertTextFormat: 'snippet'`
 *
 * 2.0 有两类候选都叫 snippet，但只有一类带占位符：块级骨架（一整块 `# 模 …` 的模板）要按
 * 模板落地，`# 模` 的**声明名**只是借那一枚图标、名字里没有槽位。契约因此把两件事拆成两格，
 * 本层的规则逐字照这格走：
 * - `InsertAsSnippet` **只随 `insertTextFormat === 'snippet'` 下发**。若"凡 kind 是 snippet
 *   就开模板"，声明名里的 `$` / `}` 会被当成槽位吞掉——挑图标这件事顺手改了插入语义；
 * - 桩 Monaco 缺 `CompletionItemKind.Snippet` 或缺 `CompletionItemInsertTextRule` 时
 *   **丢弃该档**（与删判据之前那枚守卫等价）：既不许把 `undefined` 写进 `kind`，也不许把
 *   占位符当字面文本插进缓冲——插进去的垃圾比少一条候选更难撤。只有"纯图标"的那一路
 *   （`kind: 'snippet'` 而不带 `insertTextFormat`）在缺枚举时退到 `Text`：少一枚颜色，
 *   不撤一条真候选。
 *
 * ## 悬停：无人应答 ⇒ `undefined`，不是空串
 *
 * 契约的单答口径里 `contents === ''` 是**作答**（"这家认这篇，但这一格没话说"），
 * `undefined` 才是弃权。Monaco 的悬停取**第一家非空**，所以"没有供方应答"必须如实交回
 * `undefined`——交回 `{ contents: '' }` 会把本该接手的下一路（v1 那枚词义悬浮）顶掉，作者
 * 读到的是浮层凭空没了。"作答但没话说"则是另一种处置：本层交回 `undefined`（不弹浮层），
 * 但**不再去问下一家**——单答裁决已经在 legs 收口，这里只是把"不弹"翻给 Monaco。
 * 展开视图那一段现在由插件的 hover 供方与声明段合成**一条** `contents`（`'\n\n'` 相连，
 * 正文逐字相同）；与今天的差别只是 Monaco 从"两个 part"变成"一个 part 两段"。
 *
 * ## 注册：共享收口，不再点名语言 id
 *
 * 两枚 provider 都经 `registerForLanguageServices(monaco, register, 'completion' | 'hover')`
 * 挂上：它覆盖每一门 `languageServices: true` 的语言，**并上** descriptor 的 `slotServices`
 * 点了这一枚能力名的语言（kojo2 由 `monaco/languages.ts` 点名）。当年那两枚"注册调用的第一个
 * 参数直接写死 `KOJO2_LANGUAGE_ID`"的自建注册已删除（闸门正是按那两条形状 grep 归零的）。
 * 落到 ERB / kojo1 上的这一枚此刻不会给出任何候选（没有供方答 completion / hover），交回的
 * 是空结果——v1 那两门的自有装配（`erb-completion.ts` / `kojo-hover.ts`）零改动，等 B4/B5
 * 把它们的供方也交进槽。
 *
 * ## 失败面与 disposal（与删判据之前同一条纪律，没有改弱）
 *
 * - 每一轮各带 try-catch：取文失败 / 没有编辑器实例（`requireKernel` 抛）/ 编排抛 ⇒ 补全交回
 *   `{ suggestions: [] }`、悬停交回 `undefined`。Monaco 把 provider 的 throw 吞成"这个功能
 *   突然没了"，作者读不出任何原因，空结果是它读得懂的形状；
 * - 单枚贡献自己抛错由 legs 的 `provideOf` 隔离（warn 带贡献 id），一条坏腿不许带走其余；
 * - 注册半途抛错 ⇒ 先撤回已挂上的那几枚再外抛（宿主那一侧的"全有或全无"回滚才有东西可撤）；
 *   返回的 disposable 幂等，且逐枚 try-catch——一枚撤不掉不许带走其余。
 *
 * ## 开关
 *
 * 补全 / 悬停是**只读语言面**（K2-SURFACE-DEFAULT）：不读切流开关，装配即注册。
 * 转定义（B3b）与语义着色都不在本文件；折叠与引用仍由各枚 `installKojo2*` 自建。
 */
import type * as Monaco from './entry';
import type {
  EditorCompletionItem,
  EditorCompletionItemKind,
  EditorHoverResult,
  EditorLanguageRange,
} from '@kojo/plugin-api';
// 叶子，不是桶：引 `@kojo/kojo-lang` 会把整包挂上首屏（`ps10-eager-graph` 的叶子纪律）。
// 这里只取触发字符——"哪些字符算触发"是语言知识，宿主不再留第二份。
import { KOJO2_COMPLETION_TRIGGER_CHARS } from '@kojo/kojo-lang/completion';
import { requireKernel } from '../ui/editor-pane-registry';
import {
  collectCompletionItems,
  collectHoverResult,
  completionRequestOf,
  hoverRequestOf,
} from './kojo-language-service-legs';
import { registerForLanguageServices } from './register-dialects';

/* ============================== 宿主事实（model → 请求） ============================== */

/** 取整篇源文；模型已 dispose / 桩 model ⇒ `null`（调用方给空结果，绝不抛进 Monaco） */
function textOf(model: Monaco.editor.ITextModel): string | null {
  try {
    const text = model.getValue();
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/**
 * 这份 model 背后是哪个文件。
 *
 * 桩 model 没有 `uri` ⇒ `''`（= 没有文件身份）：插件据此**少给**要路径的那一部分
 * （悬停的展开段查的是编译成品登记表），其余从源文能证明的照常作答——不猜路径。
 */
function pathOfModel(model: Monaco.editor.ITextModel): string {
  const fsPath = (model as unknown as { uri?: { fsPath?: unknown } }).uri?.fsPath;
  return typeof fsPath === 'string' ? fsPath : '';
}

/** 此刻按哪门语言着色（`getLanguageId` 原样取；桩 model 缺这一格 ⇒ 键不出现） */
function languageIdOf(model: Monaco.editor.ITextModel): string | undefined {
  try {
    const id = model.getLanguageId();
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** 第几版（供方复核应答是否过期用；取不到 ⇒ 键不出现，而不是补一个假版本号） */
function versionOf(model: Monaco.editor.ITextModel): number | undefined {
  try {
    const version = model.getVersionId();
    return Number.isFinite(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/** model → 请求身份三格（`identity` 的"缺省就不出现"口径由 legs 的构造器守住，这里不另写） */
function identityOf(model: Monaco.editor.ITextModel): {
  readonly path: string;
  readonly languageId?: string;
  readonly version?: number;
} {
  const languageId = languageIdOf(model);
  const version = versionOf(model);
  return {
    path: pathOfModel(model),
    ...(languageId !== undefined ? { languageId } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

/* ============================== 契约档 → Monaco 枚举 ============================== */

/**
 * 契约的十二档 → Monaco `CompletionItemKind`（**简报§四的表倒过来读**：插件那侧已经把
 * 语义类别翻成中性档，这里只负责"这一档挑哪枚图标"）。
 *
 * 未知档 ⇒ `Text`：缺省方向永远是"少说"，不是"借一个像的色"。`snippet` 档缺枚举时同样退
 * `Text`（见文件头「插入语义」一节——**不带** `insertTextFormat` 的那一路才走到这里，带模板
 * 插入的那一路在 `toMonacoCompletionItem` 里已经先过了枚举闸并整档丢弃）。
 */
export function kojo2CompletionKindOf(
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
 * 区间会让**整轮**补全在 Monaco 内部炸掉，而"这一条按缺省词段替换"只是精度少一点——宁可少
 * 一格精确，不可整轮凭空消失（与 legs 的 `usableRangeEdits` 同一条处置）。
 */
function monacoRangeOf(range: EditorLanguageRange | undefined, label: string): Monaco.IRange | undefined {
  if (range === undefined) return undefined;
  if (!Number.isFinite(range.line) || !Number.isFinite(range.startColumn) || !Number.isFinite(range.endColumn)) {
    console.warn(
      `[kojo2-providers] 候选 '${label}' 的区间坐标非法（${range.line}:${range.startColumn}..${range.endColumn}），改由编辑器按缺省区间处理`,
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
 * - `'markdown'` ⇒ `IMarkdownString`（`{ value }`，与今天宿主 / `kojo-hover.ts` 同一写法）；
 * - 缺省 ⇒ **原样纯文本字符串**（Monaco 这一格收 `string | IMarkdownString`，宿主不替供方
 *   包装、不猜渲染、更不编一套"把纯文本转成 Markdown"的转义判据）。
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
 * 光标处）。这一条**不是**语言判据——"什么算一个词"是编辑器通用词法，2.0 的名字段边界
 * 由供方给（`kojo2CompletionRangeAt`），今天每一枚候选都带着它；这里的缺省只服务
 * "别家供方没给"那种情形，与本语言的候选集无关。
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
    kind: kojo2CompletionKindOf(monaco, item.kind),
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
 * 契约悬停 → Monaco `Hover`。三条处置的区分是这一层的**全部内容**：
 * - `result === undefined`（无人应答 / 全体弃权）⇒ `undefined`：下一路（v1 词义悬浮）
 *   还在，绝不用空串把它顶掉；
 * - `contents === ''`（有人作答、明确说这一格没话说）⇒ 同样 `undefined`（不弹浮层），
 *   但单答裁决已在 legs 收口，**不会再问下一家**；
 * - 有正文 ⇒ 一段 `IMarkdownString`，`range` 在场就落 `IRange`。
 *
 * **两档落成的形状**：Monaco 0.57 的 `Hover.contents` 只收 `IMarkdownString[]`（本仓 v1
 * 悬停 `kojo-hover.ts` 交回的也是 `{ value }`），所以 `'markdown'` 与缺省 `'text'` 在浮层这一格
 * 上同形——差别落在补全的 `documentation` 上（那一格 Monaco 收 `string`，见 `documentationOf`）。
 * 本层不替纯文本编一套 Markdown 转义，也不把一段正文拆回多个 part（拆分顺序属渲染判据，
 * 不在翻译层）。
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

/* ============================== 安装 ============================== */

/**
 * 注册**两枚**语言服务 provider（补全 / 悬停），返回**幂等**的 disposable。
 *
 * 不传任何注入面（B3c 的交付口径）：adapter / 文件身份 / 编译成品 / 补全投影都由插件供方
 * 自己在请求时现取，宿主只负责"这份 model 是谁 + 当前项目是什么"。
 *
 * 无条件注册（K2-SURFACE-DEFAULT）。注册半途抛错 ⇒ 撤回已挂上的那几枚再外抛；两条腿的错误
 * 面收在各自体内：任何一腿抛错都只让**那一轮**空结果，编辑器不受影响。
 */
export function installKojo2LanguageProviders(monaco: typeof Monaco): Monaco.IDisposable {
  const completionProvider: Monaco.languages.CompletionItemProvider = {
    triggerCharacters: [...KOJO2_COMPLETION_TRIGGER_CHARS],
    provideCompletionItems(model, position, context) {
      try {
        const text = textOf(model);
        if (text === null) return { suggestions: [] };
        const kernel = requireKernel();
        // 合并 / 去重在 legs（`collectCompletionItems`），这里只做协议翻译——provider 里
        // 再写一份合并，就是第二套"谁的答案算数"的判据。
        const items = collectCompletionItems(
          kernel.slots.query('ui.editor.languageService'),
          completionRequestOf(
            identityOf(model),
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
        // Monaco 把 throw 吞成"补全闪一下没了"；空列表是它能读出"这里没有候选"的唯一形状。
        return { suggestions: [] };
      }
    },
  };

  const hoverProvider: Monaco.languages.HoverProvider = {
    provideHover(model, position) {
      try {
        const text = textOf(model);
        if (text === null) return undefined;
        const kernel = requireKernel();
        // 声明段 + 展开段由**同一家**供方合成一条 `contents`（K2-EXPAND-VIEW 的分家）：
        // 这里不新造第二个 HoverProvider，也不把两段拆回两个 part——Monaco 多 provider 的
        // 合并顺序不可控，当年写下的那条理由现在照旧成立。
        return toMonacoHover(
          collectHoverResult(
            kernel.slots.query('ui.editor.languageService'),
            hoverRequestOf(identityOf(model), text, position.lineNumber, position.column, kernel.project.current()),
          ),
        );
      } catch {
        return undefined;
      }
    },
  };

  const registrations: Monaco.IDisposable[] = [];
  try {
    // **逐枚 push，不写成 `push(a, b)`**：两枚的求值都在参数位上，第二枚抛错时第一枚的句柄
    // 还没进数组，catch 里就是"无东西可撤"——那正是本批删掉的原生安装器当年承诺过的
    // "全有或全无"（旧注释：注册半途抛错 ⇒ 撤回已挂上的那几枚再外抛）。分开 push 之后，
    // completion 已挂、hover 抛错 ⇒ 这枚 completion 句柄留在数组里被撤掉，语义与旧实现一致。
    registrations.push(
      registerForLanguageServices(
        monaco,
        (m, id) => m.languages.registerCompletionItemProvider(id, completionProvider),
        // B3c：带能力名 —— descriptor 的 `slotServices` 点了 `completion` 的语言（kojo2）
        // 也挂这一枚；供方是插件，宿主侧零原生判据。
        'completion',
      ),
    );
    registrations.push(
      registerForLanguageServices(
        monaco,
        (m, id) => m.languages.registerHoverProvider(id, hoverProvider),
        'hover',
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
