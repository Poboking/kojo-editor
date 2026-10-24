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
 *
 * 每一项**分枚注册**，不塞进同一个 `provide`：它们的输入/产出形状不同（单槽 + `kind`
 * 判别），混在一枚里等于让"定义算不出来"顺手把大纲也带走。
 *
 * ## 它不做什么（三条硬边界，与 `@kojo/kojo-lang` 同一套）
 *
 * - **零 Monaco**：翻译成 `CompletionItem` / `DocumentSymbol` / `LocationLink` 的是宿主；
 *   本包只产出契约的 `EditorSymbolLocation` / `EditorDocumentSymbol`；
 * - **零 IO**：不读盘、不看 `project`——请求里的 `text` 就是全文，光标位点就在请求里；
 * - **零游戏知识**：不认识 adapter、不认识任何一部具体游戏的名字。事件名 / 变量字典
 *   一律由调用方注入（本批的两项根本不需要）。
 *
 * ## 为什么"插件没加载"要表现为**无人应答**
 *
 * 宿主那侧的 kojo2 原生 provider 在 B2 批**已删除**，这两项的唯一供方就是本插件。
 * 插件缺席 ⇒ 槽里没有 `languageId: 'kojo2'` 的供方 ⇒ 宿主 provider 交回空结果 ⇒
 * 作者看到"这里没有定义 / 大纲是空的"。这是**可见退化**，不是静默：状态面板会显示
 * 本插件 `inactive`，而"功能突然没了"与"插件没装上"两件事能对上号。
 *
 * 反过来，如果为了"兜底"在宿主留一份原生实现，那就永远有两份判据——B1 已经把判据
 * 搬进包，正是为了不让第二份长出来。
 */
import type { Plugin, PluginContext } from '@kojo/plugin-api';
import { kojo2AdapterNow } from '@kojo/kojo-lang/adapter-source';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang/constants';
import { provideDefinition } from './definition';
import { provideDocumentSymbols } from './symbols';
import { provideInlayHints } from './inlay';

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
      ctx.log.info(
        `语言服务已接入：definition / documentSymbol / inlayHint（languageId=${KOJO2_LANGUAGE_ID}）`,
      );
    },
  };
}
