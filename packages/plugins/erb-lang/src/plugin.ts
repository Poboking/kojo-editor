/**
 * `@kojo/plugin-erb-lang` —— ERB 语言面的**插件侧**（LAU-4 第一步，2026-10-30）。
 *
 * ## 它做什么
 *
 * 把 `@kojo/erb-lang` 的判据接到契约槽 `ui.editor.languageService` 上：
 *
 * | kind | 判据（包） | 供方 |
 * | --- | --- | --- |
 * | `documentHighlight` | `highlight.ts` 的 `erbDocumentHighlights` | `src/highlight.ts` |
 * | `selectionRange` | `selection-range.ts` 的 `erbSelectionRangeChainsAt` | `src/selection-range.ts` |
 * | `formatting` | `@kojo/kojo-vocab/formatter` 的 `computeFormatEdits`（与 `.kojo` 共用） | `src/formatting.ts` |
 * | `signatureHelp`（车 5） | `@kojo/kojo-vocab/signature` 的 `resolveSignatureInText`（与 `.kojo1` 共用） | `src/signature.ts` |
 *
 * 三条腿**分枚注册**（`order` 都是 10，与 kojo2 那家同权）：它们的输入 / 产出形状不同
 * （单槽 + `kind` 判别），塞进同一枚 `provide` 等于让"高亮算不出来"顺手把扩选也带走。
 *
 * 2026-10-30（定义判据归位批）：本插件**不再供 `definition`**。那个 kind 的本地名字腿
 * （`$` 标签作用域 + `#DIM` 声明）住在**解析器插件** `@kojo/plugin-erb-parser` 的
 * `erb-definition` 贡献里——标签作用域的真源是解析器的 `labelScopeAt`，放在本插件就得
 * 跨插件 import（审计 C 项）或让库包反向依赖插件包（分层倒置）。
 *
 * ## 与 kojo2 的关系：同一条槽、同一份契约、**互斥作答**
 *
 * 两家认的 `languageId` 不重叠（kojo2 只认 `kojo2`，本插件只认 ERB 的两个 id / 方言扩展名），
 * 所以**永远不会有两家对同一个请求都作答**。这条互斥由 `tests/highlight-selection.test.ts`
 * 双向钉住（本插件对 kojo2 请求弃权 / kojo2 那家对 ERB 请求弃权）。
 *
 * ## 它不做什么
 *
 * - **零 Monaco**：翻 `DocumentHighlightKind`、摊平 0.57 的扁平 `SelectionRange[]` 的是宿主
 *   （`app/src/monaco/erb-highlight.ts` / `erb-selection-range.ts`，只剩请求 / 翻译 / 注册）；
 * - **零 IO**：不读盘、不看项目——请求里的 `text` 就是全文，位点就在请求里；
 * - **零游戏知识**：不认识任何一部具体游戏（配对词表来自非插件库包 `@kojo/erb-vocab`
 *   的引擎控制流表，与游戏无关；本插件与宿主、解析器同是它的读者）。
 *
 * ## 为什么"插件没加载"要表现为**无人应答**
 *
 * 宿主那侧的原生安装器（直挂 `ERB_LANGUAGE_ID` 的两枚 provider）已在本批删除，这两条腿的
 * 唯一供方就是本插件。插件缺席 ⇒ 槽里没有认 ERB 的供方 ⇒ 宿主 provider 交回 `undefined`
 * ⇒ Monaco 退回它自己的行为（高亮不亮 / 扩选只剩词语扩选）。这是**可见退化**，不是静默：
 * 状态面板会显示本插件 `inactive`。反过来，若为了"兜底"在宿主留一份原生实现，就永远有
 * 两份判据——判据进包正是为了不让第二份长出来。
 */
import type {
  ErbIndex,
  ErbParserService,
  GameAdapter,
  Plugin,
  PluginContext,
  SlotRegistry,
} from '@kojo/plugin-api';
import { activeGameAdapter, KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { provideFormatting } from './formatting';
import { provideDocumentHighlights } from './highlight';
import { provideSelectionRanges } from './selection-range';
import { callProtocolOf, provideErbSignatureHelp } from './signature';

/**
 * 贡献的 `order`：与 kojo2 那家同为 10。
 *
 * 理由不是"谁优先"，而是**互斥**：两家认的语言 id 不重叠，永远不会对同一个请求都作答。
 * `order` 只影响槽查询返回的数组顺序（宿主按它逐家问），给一个固定值是为了让"以后真出现
 * 重叠"时的顺序是**写下来的**，而不是随装载顺序漂。
 */
const CONTRIBUTION_ORDER = 10;

export function createErbLangPlugin(): Plugin {
  return {
    id: 'erb-lang',
    version: '0.0.0',
    activate(ctx: PluginContext): void {
      // 两条腿都是**单答型**，分枚注册：一条腿的"作答与否"不带走另一条。
      // 两条都只读请求里的文本与位点，不取 adapter（没有游戏命名集合参与判据）。
      ctx.slots.register('ui.editor.languageService', {
        id: 'erb-documentHighlight',
        order: CONTRIBUTION_ORDER,
        provide: (request) => provideDocumentHighlights(request),
      });
      ctx.slots.register('ui.editor.languageService', {
        id: 'erb-selectionRange',
        order: CONTRIBUTION_ORDER,
        provide: (request) => provideSelectionRanges(request),
      });
      // ERB-PARITY G2（2026-10-31）：格式化（整篇 + 区间）交给本插件作答。
      // 判据仍是 `@kojo/kojo-vocab/formatter`（与 `.kojo` 共用的那一份，不抄第二套）；
      // 宿主侧的 v1 两枚（`kojo-format.ts` 整篇 / `kojo-format-range.ts` 区间）已按
      // descriptor 的 `slotServices` 让开，ERB 每种 provider 从此恰好一枚。
      // 规则开关（P2-14）随请求的 `options` 进来：偏好读取点是宿主，本插件不读设置。
      ctx.slots.register('ui.editor.languageService', {
        id: 'erb-formatting',
        order: CONTRIBUTION_ORDER,
        provide: (request) => provideFormatting(request),
      });
      /* ---------------- LAU-DUALLEG 车 5（2026-10-31）：签名帮助 ----------------

       ERB 的 `signatureHelp` 此前由宿主旧桥腿 `monaco/kojo-signature.ts` 答，而共享槽腿
       也挂在同一枚 model 上（**双挂**：同一次请求问两趟，"谁在答"由注册顺序判）。本枚
       供方就位后 descriptor 才点名 `signatureHelp`，宿主那条腿随之 `excludeNamed` 让开
       ——点名与让位必须同批，早一步就是"静默没有签名"。

       判据不在本插件：调用位 / 实参位 / 跨行回看 / 组装全在包叶 `@kojo/kojo-vocab/signature`
       （`.kojo1` 那条腿今天还在同一把尺子上）。本插件只备两张表并翻契约形状。

       两张表**每次现取**（表与索引随项目开闭重建，缓存会把上一个项目的带过来），且都软取：
       - `game.adapter` 槽按 `request.project.adapterId` 精确匹配拿 `kojoCallProtocol`
         （与宿主 `editorTables` 同一条判据）；读不到 ⇒ 协议那一路零产出；
       - `erb.parser` 服务的 `currentIndex()`；索引在途 / 解析器缺席 ⇒ 用户函数形参那一路
         零产出。两路都没有 ⇒ 空表作答（"这一格没话说"），不是弃权。 */
      const slotRegistry = (): SlotRegistry | undefined => {
        try {
          return ctx.tryInject<SlotRegistry>(KernelServices.Slots);
        } catch {
          return undefined;
        }
      };
      const erbIndex = (): ErbIndex | null => {
        try {
          return ctx.tryInject<ErbParserService>(WellKnownServices.ErbParser)?.currentIndex() ?? null;
        } catch {
          return null;
        }
      };
      const callProtocolOfRequest = (adapterId: string | undefined) => {
        const slots = slotRegistry();
        if (slots === undefined) return undefined;
        let contributions: readonly { readonly adapter: GameAdapter }[];
        try {
          contributions = slots.query('game.adapter');
        } catch {
          return undefined;
        }
        // 只认 id 对得上的那一枚：拿 A 游戏的调用协议解释 B 游戏的函数是假签名
        return callProtocolOf(activeGameAdapter(contributions, adapterId));
      };
      ctx.slots.register('ui.editor.languageService', {
        id: 'erb-signatureHelp',
        order: CONTRIBUTION_ORDER,
        provide: (request) =>
          provideErbSignatureHelp(request, {
            callProtocol: () => callProtocolOfRequest(request.project?.adapterId),
            index: erbIndex,
          }),
      });
      ctx.log.info(
        '语言服务已接入：documentHighlight / selectionRange / formatting / signatureHelp（languageId=kojo-erb），' +
          '判据在 @kojo/erb-lang、@kojo/kojo-vocab 与契约层，宿主只剩请求与 Monaco 翻译',
      );
    },
  };
}
