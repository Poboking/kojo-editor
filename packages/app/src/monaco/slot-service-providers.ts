/**
 * 槽腿 provider 的**唯一工厂**：`kind` →（Monaco 注册 API、请求构造、契约 → Monaco 形状）
 * （SDK-B5b 车 1，2026-10-31；补全 / 悬停由 `kojo2-providers.ts` 整块搬入并改成语言无关）。
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
 * `SLOT_SERVICE_LEGS` 的数组序 = **注册顺序**，且与搬家前两枚 `push` 的相对序逐字相同
 * （补全先、悬停后）。理由见 `register-dialects.ts` 头注：Monaco 对**单答型** provider
 * （悬停）是"第一家说了算"，顺序变了就是"谁答悬停"变了。装配点那道调用也留在原位
 * （语义捕获预取之后、切流块之前），所以它与 v1 那几枚 provider 的相对序同样不变。
 * `packages/app/tests/kojo2-providers.test.ts` 的「注册顺序」组把这两层都钉住。
 *
 * ## 每一腿体内只剩"翻译"（三件宿主事实，判据一枚都不留）
 *
 * 1. **model → 请求**：`path` / `languageId` / `version` 原样取自 model（宿主不改写、不猜）、
 *    全文、光标位点、当前项目（项目事实只在内核里，插件只能从请求里读）。构造一律走 legs 的
 *    `completionRequestOf` / `hoverRequestOf` / `editorRequestIdentityOf` / `modelTextOf`
 *    ——手抄一份对象字面量，抄漏 `version` 的那条腿就废掉了供方的过期复核；
 *    合并与单答裁决也一律在 legs（并在 provider 里写第二份）。
 * 2. **响应 → Monaco 协议**：`range` → `IRange`、`filterText` 透传、`documentation` 按
 *    `documentationFormat` 分 Markdown / 纯文本、`insertTextFormat` 决定要不要开模板通道。
 * 3. **图标表**：契约档（`EditorCompletionItemKind` 十三档）→ Monaco 枚举。挑哪枚图标是
 *    编辑器的事，插件看不到 Monaco；这一层也不许给某一档另发明第二重语义。
 *
 * 触发字符仍是 `@kojo/kojo-lang/completion` 那一份（叶子 import）：descriptor 还没有
 * "哪几个字符算补全触发"这一格，**这一格是语言事实、只是暂时由 2.0 的单例供给**；等某门
 * 语言要另一套触发符时，补 descriptor 字段 + 按 id 取，不在本表里分支（审计 M2 也拦在
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
 * ## 失败面与 disposal
 *
 * - 每一轮各带 try-catch：取文失败 / 没有编辑器实例（`requireKernel` 抛）/ 编排抛 ⇒ 补全交回
 *   `{ suggestions: [] }`、悬停交回 `undefined`。Monaco 把 throw 吞成"这功能突然没了"，
 *   空结果是它读得懂的形状；单枚贡献自己抛错由 legs 的 `provideOf` 隔离（warn 带贡献 id）；
 * - 注册半途抛错 ⇒ `registerForLanguageServices` 撤它自己铺的那几门，本层再撤回**已装完的
 *   前几条腿**并原样外抛（宿主那一侧的"全有或全无"回滚才有东西可撤）；
 * - 返回的 disposable 幂等，且逐条腿 try-catch——一条撤不掉不许带走其余。
 *
 * ## 开关
 *
 * 补全 / 悬停是**只读语言面**（K2-SURFACE-DEFAULT）：不读切流开关，装配即注册。
 */
import type * as Monaco from './entry';
import type {
  EditorCompletionItem,
  EditorCompletionItemKind,
  EditorHoverResult,
  EditorLanguageRange,
} from '@kojo/plugin-api';
// 叶子，不是桶：引 `@kojo/kojo-lang` 会把整包挂上首屏（`ps10-eager-graph` 的叶子纪律）。
import { KOJO2_COMPLETION_TRIGGER_CHARS } from '@kojo/kojo-lang/completion';
import { requireKernel } from '../ui/editor-pane-registry';
import type { SlotServiceKind } from './language-registry';
import {
  collectCompletionItems,
  collectHoverResult,
  completionRequestOf,
  editorRequestIdentityOf,
  hoverRequestOf,
  modelTextOf,
} from './kojo-language-service-legs';
import { registerForLanguageServices } from './register-dialects';

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

/* ============================== 两腿（本车开的两格） ============================== */

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

/* ============================== 表 + 安装 ============================== */

/**
 * 一条槽腿：`kind` + Monaco 注册 API + provider 工厂（请求构造与契约 → Monaco 都封在工厂里）。
 *
 * 类型对 `SlotServiceKind` 全集开放；后续腿（`signatureHelp` / `formatting` / `references` /
 * `rename` / `documentHighlight` / `selectionRange` / `codeLens` / `foldingRange` / `inlayHint` /
 * `documentSymbol` / `definition` / `semanticToken`）只需在 {@link SLOT_SERVICE_LEGS} 里补一枚
 * `legOf(...)`，安装器与回滚一行都不用改。
 */
export interface SlotServiceLeg {
  readonly kind: SlotServiceKind;
  /** 挂到收口给的 `id` 上；provider 由本腿自建（多门语言各一枚，无共享可变状态） */
  readonly register: (monaco: typeof Monaco, languageId: string) => Monaco.IDisposable;
}

function legOf<P>(
  kind: SlotServiceKind,
  create: (monaco: typeof Monaco) => P,
  register: (monaco: typeof Monaco, languageId: string, provider: P) => Monaco.IDisposable,
): SlotServiceLeg {
  return { kind, register: (monaco, languageId) => register(monaco, languageId, create(monaco)) };
}

/**
 * 已实现的槽腿——**数组序即注册序**（补全先、悬停后，与搬家前 `registrations.push` 的相对序
 * 逐字相同）。新腿一律**追加**，别插队：插进中间等于改掉"谁排在前"的既有事实。
 */
export const SLOT_SERVICE_LEGS: readonly SlotServiceLeg[] = [
  legOf('completion', completionProvider, (m, id, provider) =>
    m.languages.registerCompletionItemProvider(id, provider),
  ),
  legOf('hover', hoverProvider, (m, id, provider) => m.languages.registerHoverProvider(id, provider)),
];

/**
 * 装**表里全部**槽腿，返回**幂等**的 disposable。
 *
 * 不传任何注入面：adapter / 文件身份 / 编译成品 / 候选投影都由插件供方在请求时现取，
 * 宿主只负责"这份 model 是谁 + 当前项目是什么"。
 *
 * 无条件注册（K2-SURFACE-DEFAULT）。注册半途抛错 ⇒ 撤回已装完的那几条腿再外抛；每条腿的
 * 错误面收在各自体内：任何一腿抛错都只让**那一轮**空结果，编辑器不受影响。
 */
export function installSlotServiceProviders(monaco: typeof Monaco): Monaco.IDisposable {
  const registrations: Monaco.IDisposable[] = [];
  try {
    for (const leg of SLOT_SERVICE_LEGS) {
      // **逐条 push，不写成 `push(a, b)`**：求值都在参数位上，第二条抛错时第一条的句柄还没进
      // 数组，catch 里就是"无东西可撤"——那正是"全有或全无"承诺的反面。
      registrations.push(
        registerForLanguageServices(
          monaco,
          leg.register,
          leg.kind,
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