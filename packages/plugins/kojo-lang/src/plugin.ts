/**
 * `@kojo/plugin-kojo-lang` —— Kojo 语言面的**插件侧**。
 *
 * ## 它做什么
 *
 * 把 `@kojo/kojo-lang` 的判据接到契约槽 `ui.editor.languageService` 上：
 *
 * | kind | 判据（包） | 供方 |
 * | --- | --- | --- |
 * | `definition` | `definition.ts` 的 `kojo2DefinitionAt` | `src/definition.ts` |
 * | `documentSymbol` | `symbols.ts` 的 `kojo2DocumentSymbols` | `src/symbols.ts` |
 * | `inlayHint` | `inlay.ts` 的 `kojo2InlayHints` | `src/inlay.ts` |
 * | `completion` | `completion.ts` 的 `kojo2CompletionAt` + `completion-snippets.ts` 的 `kojo2SnippetCandidatesAt` | `src/completion.ts` |
 * | `hover` | `hover.ts` 的 `kojo2HoverAt`（+ 展开段 `expand-view.ts`） | `src/hover.ts` |
 * | `signatureHelp`（B3d） | `signature.ts` 的 `kojo2SignatureAt` | `src/signature.ts` |
 * | `formatting`（B3d） | `format.ts` 的 `formatKojo2Source` / `formatKojo2Range` | `src/format.ts` |
 * | `references`（B3e） | `references.ts` 的 `kojo2ReferencesAt` + 项目快照合并 | `src/references.ts` |
 * | `rename`（B3e） | `rename.ts` 的 `kojo2RenameAt` / `kojo2RenamePlanXFile` | `src/rename.ts` |
 * | `documentHighlight`（B3f） | `highlight.ts` 的 `kojo2DocumentHighlights` | `src/highlight.ts` |
 * | `selectionRange`（B3f） | `selection-range.ts` 的 `kojo2SelectionRangeChainsAt` | `src/selection-range.ts` |
 * | `codeLens`（B3g） | `codelens.ts` 的 `kojo2CodeLenses`（计数复用 `references.ts`） | `src/codelens.ts` |
 * | `foldingRange`（B3h） | `folding.ts` 的 `kojo2FoldingSnapshotRanges`（**宿主预取的快照**） | `src/folding.ts` |
 * | `semanticToken`（B3 语义收口） | `semantic.ts` 的 `kojo2SemanticSpansFromCaptures`（**宿主预取的捕获快照**） | `src/semantic.ts` |
 * | `workspaceSymbol`（G4，`Ctrl+T`） | `@kojo/kojo-lang/symbols` 的 `kojo2DocumentSymbols`（**宿主递进来的项目文件快照**） | `src/workspace-symbols.ts` |
 * | `codeAction`（B3j，另一枚槽） | `code-actions.ts` 的 `kojo2CodeActionFacts` | `src/code-actions.ts` |
 *
 * B4 起还有一枚**不同形状**的贡献——槽 `ui.monaco.language` 交的是注册期的一次性数据
 * （Monarch / 语言配置 / 三套主题声明），不是 `provide(request)`：见 `src/monaco-language.ts`。
 *
 * 每一项**分枚注册**，不塞进同一个 `provide`：它们的输入/产出形状不同（单槽 + `kind`
 * 判别），混在一枚里等于让"定义算不出来"顺手把大纲也带走。
 *
 * ## 它不做什么（三条硬边界，与 `@kojo/kojo-lang` 同一套）
 *
 * - **零 Monaco**：翻译成 `CompletionItem` / `DocumentSymbol` / `LocationLink` / `Hover` 的是宿主；
 *   本包只产出契约的 `EditorSymbolLocation` / `EditorDocumentSymbol` / `EditorCompletionItem` /
 *   `EditorHoverResult`；
 * - **零 IO**：不读盘、不看 `project` 的工程事实——请求里的 `text` 就是全文，光标位点就在请求里；
 * - **零游戏知识**：不认识任何一部具体游戏的名字。事件名 / 事件参数 / 颜绘参数 / 行尾提示名
 *   这类**方言事实**一律由调用方注入（`completion` / `hover` 两枚经 `adapter-source` 登记表
 *   在请求时现取并核过 id，见 `src/completion.ts` / `src/hover.ts` 的头注）。
 *
 * ## 为什么"插件没加载"要表现为**无人应答**
 *
 * 宿主那侧的 kojo2 原生 provider 在 B2 批**已删除**（definition / documentSymbol / inlayHint），
 * 补全 / 悬停的原生安装在 B3c 批、签名帮助 / 格式化的原生安装在 B3d 批**也已清零**（宿主那几枚
 * 安装器只把 model / 选区翻成请求、把槽里的作答翻成 Monaco 形状，判据一份不留），
 * 这七项的唯一供方就是本插件。
 * 插件缺席 ⇒ 槽里没有 `languageId: 'kojo2'` 的供方 ⇒ 宿主 provider 交回空结果 ⇒
 * 作者看到"这里没有定义 / 大纲是空的 / 补全不弹 / 悬停没正文"。这是**可见退化**，不是静默：
 * 状态面板会显示本插件 `inactive`，而"功能突然没了"与"插件没装上"两件事能对上号。
 *
 * 反过来，如果为了"兜底"在宿主留一份原生实现，那就永远有两份判据——B1 已经把判据
 * 搬进包，正是为了不让第二份长出来。
 *
 * 语言面（B4）的退化形状**不一样**，而且是契约写死的：宿主仍然认领 `kojo2` 这门语言
 * （文件能打开、语言 id 正确），只是**没有语法着色、没有成对记号、没有缩进规则、没有
 * `kojo2-*` 主题**，并 `console.warn` 一条说清楚。它不会"看起来还有颜色但其实是 v1 那套"——
 * 宿主没有内置 Monarch 可兜，兜了就是第二份判据。
 */
import type { Plugin, PluginContext } from '@kojo/plugin-api';
import { kojo2AdapterNow } from '@kojo/kojo-lang/adapter-source';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang/constants';
import { provideCompletion } from './completion';
import { provideDefinition } from './definition';
import { provideFormatting } from './format';
import { provideHover } from './hover';
import { provideDocumentSymbols } from './symbols';
import { provideInlayHints } from './inlay';
import { provideReferences } from './references';
import { provideRename } from './rename';
import { provideDocumentHighlights } from './highlight';
import { provideSelectionRanges } from './selection-range';
import { provideFoldingRanges } from './folding';
import { provideSemanticTokens } from './semantic';
import { provideSignatureHelp } from './signature';
import { provideCodeLenses } from './codelens';
import { provideWorkspaceSymbols } from './workspace-symbols';
import { provideCodeActions } from './code-actions';
import { createKojo2DiagnosticsContribution } from './diagnostics';
import { createKojo2InlineContribution } from './inline-completion';
import { KOJO2_MONACO_LANGUAGE_SURFACE } from './monaco-language';

/**
 * 贡献的 `order`：比 ERB 的 20 早一点（10）。
 *
 * 理由不是"2.0 更优先"，而是**互斥**：本插件只认 `languageId === 'kojo2'`，ERB 只认
 * 方言路径，两者永远不会对同一个请求都作答。`order` 在这里只影响槽查询返回的数组顺序
 * （宿主按它逐家问），给一个固定值是为了让"以后真出现重叠"时的顺序是**写下来的**，
 * 而不是随装载顺序漂。
 */
const CONTRIBUTION_ORDER = 10;

export function createKojoLangPlugin(): Plugin {
  return {
    id: 'kojo-lang',
    version: '0.0.0',
    activate(ctx: PluginContext): void {
      /**
       * 请求时**现取**当前项目的 2.0 adapter（不要在 activate 时缓存）。
       *
       * 两条理由都是踩过的坑：适配器可能比本插件晚激活，而项目开闭会换人——activate
       * 那一刻抓到的实例迟早是上一个项目的。
       *
       * **为什么走登记表而不是 `ctx.tryInject('game.adapter')`**：那个服务键在契约里存在，
       * 但全仓**没有任何插件 provide 过它**（v1 adapter 只往**槽**里注册，插件读不到槽）；
       * 而且槽里那枚是 v1 契约对象，**没有** 2.0 的 `eventCatalog` / `kojo2.foreachCollections`。
       * 2.0 adapter 事实的唯一持有者是宿主组合根，它经
       * `@kojo/kojo-lang/adapter-source` 的登记表交出来（同一张表、同一份实例）。
       *
       * **只认 id 对得上的那一枚**：请求带着它自己那份 `project.adapterId`。对不上就
       * 返回 `null`（不猜）——宁可少给命名集合的绑定名，也不拿 A 游戏的集合表去解释
       * B 游戏的 `@巡`。
       */
      const adapterFor = (adapterId: string | undefined): ReturnType<typeof kojo2AdapterNow> => {
        if (adapterId === undefined) return null;
        const adapter = kojo2AdapterNow();
        return adapter !== null && adapter.id === adapterId ? adapter : null;
      };
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo2-definition',
        order: CONTRIBUTION_ORDER,
        provide: (request) => provideDefinition(request),
      });
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo2-symbols',
        order: CONTRIBUTION_ORDER,
        provide: (request) => provideDocumentSymbols(request),
      });
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo2-inlay',
        order: CONTRIBUTION_ORDER,
        provide: (request) =>
          provideInlayHints(request, { adapter: adapterFor(request.project?.adapterId) }),
      });
      // B3c：补全 / 悬停同样**分枚注册**——completion 是并集型、hover 是单答型，混在一枚
      // `provide` 里等于让"补全无候选"顺手把悬停的作答与否也带走（三态在两条腿上口径不同）。
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo2-completion',
        order: CONTRIBUTION_ORDER,
        provide: (request) =>
          provideCompletion(request, { adapter: adapterFor(request.project?.adapterId) }),
      });
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo2-hover',
        order: CONTRIBUTION_ORDER,
        provide: (request) =>
          provideHover(request, { adapter: adapterFor(request.project?.adapterId) }),
      });
      // B3d：签名帮助同样是**单答型**，与悬停分枚注册（一条腿的"作答与否"不许带走另一条）。
      // `@巡` 的集合绑定名要 adapter 事实 ⇒ 与 inlay / completion / hover 同一条现取纪律；
      // 格式化不依赖任何游戏事实，注入面留空（少给的是 adapter 那一路，不是整条能力）。
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo2-signatureHelp',
        order: CONTRIBUTION_ORDER,
        provide: (request) =>
          provideSignatureHelp(request, { adapter: adapterFor(request.project?.adapterId) }),
      });
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo2-formatting',
        order: CONTRIBUTION_ORDER,
        provide: (request) => provideFormatting(request),
      });
      // B3e：引用 / 改名同样**单答型**、分枚注册——一条腿的"作答与否 / 拒绝理由"不许带走另一条。
      // 两者都只读请求里的文本与项目快照（宿主事实），不取 adapter：没有游戏命名集合参与判据。
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo2-references',
        order: CONTRIBUTION_ORDER,
        provide: (request) => provideReferences(request),
      });
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo2-rename',
        order: CONTRIBUTION_ORDER,
        provide: (request) => provideRename(request),
      });
      // B3f：同符号高亮 / 结构化扩选同样**单答型**、分枚注册——一条腿的"作答与否"不许带走另一条；
      // 两者都只读请求里的文本与位点，不取 adapter（没有游戏命名集合参与判据）。
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo2-documentHighlight',
        order: CONTRIBUTION_ORDER,
        provide: (request) => provideDocumentHighlights(request),
      });
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo2-selectionRange',
        order: CONTRIBUTION_ORDER,
        provide: (request) => provideSelectionRanges(request),
      });
      // B3g：行上注解是**单答型**（整篇一次、供方唯一），同样分枚注册——它只读请求里的文本与
      // 项目快照，不取 adapter（没有游戏命名集合参与判据）。
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo2-codeLens',
        order: CONTRIBUTION_ORDER,
        provide: (request) => provideCodeLenses(request),
      });
      // B3h：折叠区间同样**单答型**、分枚注册。与其它腿的差别只有一处：可折区间来自结构
      // worker（异步），宿主在打开 / 改动时预取进缓存、随请求的 `folds` 字段递过来；
      // 供方**同步**作答，不在槽内 await（缺席 = 这一版还没预取到，答空，下一次可见）。
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo2-foldingRange',
        order: CONTRIBUTION_ORDER,
        provide: (request) => provideFoldingRanges(request),
      });
      // B3 语义收口（2026-10-30）：结构化着色同样**单答型**、分枚注册。形状与折叠同一条：
      // 捕获来自结构 worker（异步），宿主预取后随请求的 `captures` 递过来；供方同步翻译
      // （判据在 `@kojo/kojo-lang/semantic`），选中哪份 legend 由宿主按语言决定。
      // 非 kojo2 一律 `undefined`（弃权），不顶掉 ERB / kojo1 的着色供方。
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo2-semanticTokens',
        order: CONTRIBUTION_ORDER,
        provide: (request) => provideSemanticTokens(request),
      });
      // ERB-PARITY G4（2026-10-31）：`Ctrl+T`（工作区符号）的 2.0 供方。
      // 与文档大纲同一份事实（`@kojo/kojo-lang/symbols`），文件由宿主随请求递进来
      // （`projectFiles`，additive）——插件不读盘、不碰宿主索引；没有快照就弃权，
      // 不把"还没名录"答成"没有匹配"。
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo2-workspaceSymbols',
        order: CONTRIBUTION_ORDER,
        provide: (request) => provideWorkspaceSymbols(request),
      });
      // B3j（2026-10-30）：一键迁移动作进**既有槽** `ui.editor.codeAction`（不是给语言服务
      // 再开一个判别成员——诊断 / 快速修复各有专用槽，开新路等于同一能力两条路径）。判据在
      // `@kojo/kojo-lang/code-actions`；宿主那枚 provider 只做定位、翻译、落地与切流开关。
      // 非 2.0 文件一律 `[]`（弃权写在供方里，见 `src/code-actions.ts` 头注）。
      ctx.slots.register('ui.editor.codeAction', {
        id: 'kojo2-codeActions',
        order: CONTRIBUTION_ORDER,
        provideActions: (file) => provideCodeActions(file),
      });
      // B3 收口最后一格（2026-10-30）：文档级诊断进**既有专用槽** `ui.editor.decorator`
      // （诊断没有独立的能力判别成员——`LineDecoration` 就是 LSP 诊断形状，见契约注释）。
      // 判据在 `@kojo/kojo-lang/diagnostics`；宿主诊断接线只做调度、markers / 问题面板翻译
      // 与降级。项目级扫描轮（`bulk`）本贡献弃权，见 `src/diagnostics.ts` 头注。
      ctx.slots.register('ui.editor.decorator', createKojo2DiagnosticsContribution(CONTRIBUTION_ORDER));
      ctx.slots.register('ui.monaco.language', {
        id: 'kojo2-monaco-language',
        order: CONTRIBUTION_ORDER,
        surface: KOJO2_MONACO_LANGUAGE_SURFACE,
      });
      // LAU-KOJO2-INLINE（2026-10-31）：**行内续写（幽灵文本）**进**专用槽** `completion.source`
      // （它不是 `ui.editor.languageService` 的判别成员——多供方、异步、可弃权三态与那十四条都不同形，
      // 契约 `plugin-api/inline-completion.ts` 为它单开了一份文件）。判据仍住 `@kojo/kojo-lang`：
      // 位置门与名录是弹窗补全那一枚 `kojo2CompletionAt`，本家只加"几乎唯一才给"。
      // `order` 取 11（本地源一族：ERB 那家 10，外部模型源从 20 起步）。
      ctx.slots.register('completion.source', createKojo2InlineContribution({ adapterFor }));
      ctx.log.info(
        `语言服务已接入：definition / documentSymbol / inlayHint / completion / hover / signatureHelp / formatting / references / rename / documentHighlight / selectionRange / codeLens / foldingRange / semanticToken（languageId=${KOJO2_LANGUAGE_ID}）；` +
          `语言面已交出：Monarch / 语言配置 / 三套主题（ui.monaco.language）；` +
          `一键迁移动作已交出：codeAction；` +
          `文档级诊断已交出：ui.editor.decorator；` +
          `行内续写已交出：completion.source`,
      );
    },
  };
}
