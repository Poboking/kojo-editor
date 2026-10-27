import type { ErbIndex, ErbParserService, Plugin, PluginContext } from '@kojo/plugin-api';
import { WellKnownServices } from '@kojo/plugin-api';
import { createLocalContribution, LOCAL_SOURCE_ID, LOCAL_SOURCE_ORDER } from './provider';

/**
 * `@kojo/plugin-inline-completion-local` —— 内联补全（幽灵文本）的**本地候选源**。
 *
 * ## 它是什么
 *
 * 槽 `completion.source` 的第一家供方（契约 `plugin-api/inline-completion.ts`）。
 * 它**不假装是模型**：只在"这一格几乎唯一"时给一条候选，且每一条都能自证——
 *
 * | 形状 | 位置判据 | 名录（唯一真源 = `erb.parser` 的索引） | 自证依据 |
 * | --- | --- | --- | --- |
 * | ①定义位 | 行首 `@`（`;!;`/`;#;` 代码前缀之后），光标在名字段内 | `ErbIndex.byName` | 已打字面的**大写前缀**在名录里只命中 1 条 |
 * | ②调用位 | 行首整词 ∈ `CALL` / `TRYCALL` / `TRYCCALL`（引擎词汇），空白之后那一段 | 同上 | 同上 |
 * | ③声明位 | 行首 `#<指令>`，且指令名出现在本项目 `dims[].directive` 的**派生集合**里 | `ErbIndex.files[*].dims` | 同上 |
 *
 * 命中 0 条 ⇒ `no-completion`（看了，没有）；命中 ≥2 条 ⇒ 同样 `no-completion`
 * （多条时给哪一条都没有依据，让作者去用弹窗列表）。**宁可漏报不可错报**这条口径
 * 取自 `sugar.lift` 的既有判据（round-trip 自证不过者一律不入结果）。
 *
 * ## 它不是什么
 *
 * - 不是第二份索引：名字事实全部现读 `erb.parser` 的 `ErbIndex`，本包只把那两份键集
 *   排好序 + 做一次区间二分（见 `catalog.ts` 头注）；
 * - 不是弹窗补全的替身：弹窗给"可选项"，幽灵文本给"下一格的字"，同一格可能两家都给
 *   ⇒ 互斥归宿主（A 车道的键位/让位裁决），本包不去猜它该不该让；
 * - 零 IO、零事件、零游戏词汇：`provideInline` 不读盘不写盘，文本只来自请求递进来的窗口。
 *
 * ---
 *
 * ## 第二家怎么进来（外部模型源照这一节抄）
 *
 * 这一节是本包的**交付面之一**：契约只规定形状，"多家怎么共处"得有人先写成文字，
 * 否则第二个实现者会按自己的想象排 order、按自己的想象处理超时。
 *
 * ### 1. `order`：本地先、模型后
 *
 * - 本地（本包）= `10`（`LOCAL_SOURCE_ORDER`），外部模型源取 **`20` 起步**。
 * - 为什么这个顺序：槽的语义是"第一家给出 `candidates` 就是答案，宿主停下不再问下一家"
 *   （`inline-completion.ts` 的 `InlineCompletionSourceContribution` 头注）。于是
 *   **本地命中 ⇒ 出网一次都不发生**；本地 `no-completion` / `failed` / 弃权 ⇒ 才轮到模型。
 *   反过来排会让模型替掉"名录里本就只有一个答案"的那一格，付一次网络换一条作者已经写对的名字。
 * - 别用 `order` 表达"我更准"：同槽排序只决定**问的先后**，不决定权重。
 *
 * ### 2. `timeoutMs` / `signal`：模型源自己处理，别交回给宿主
 *
 * - `request.timeoutMs` 是宿主给的**这一趟的预算**。它的正确用法不是"到点抛错"，
 *   而是"过了这个点结果就没有观众了"：到点立刻 resolve `no-completion`（或按下一节给部分结果），
 *   **同时把在途请求自己也取消掉**（`AbortController` 挂在 `fetch` 上，
 *   并把 `request.signal` 接成它的上游 —— 被叫停时不留下"还在跑"的悬挂请求）。
 * - `request.signal` 缺席（旧宿主）时也必须能跑：`signal?.aborted === true` 之外没有第三种状态。
 * - 一次调用**不许抛错**来表示业务性没结果（契约：只有输入本身不合法才抛）。
 *
 * ### 3. `partial`：只有"多条候选可切"的供方才用得上
 *
 * - 模型源可以先把已经解出的第一条完整候选交出去，并标 `partial: true`
 *   （第 0 条必须**自身完整可用**：不接受一条写到一半的标识符）。
 * - 本地源**永不**给 `partial`：唯一性判据要求把整个前缀区间数完，数到一半的结论
 *   是"没有结论"而不是"部分结论"。这是判据差异，不是实现偷懒。
 * - 宿主见到 `partial` 不得把这家记成"已经问完了"（契约原文），也不得据此停掉下一家。
 *
 * ### 4. `failed.stage` 用哪一档
 *
 * | 情形 | `stage` | 说明 |
 * | --- | --- | --- |
 * | 上下文组装失败（窗口拼不出可发的请求体） | `context` | 本地源用 `context` 表示"没开项目" |
 * | 发问本身失败（超时 / 非 2xx / 连接断） | `transport` | **只有模型源会用到** |
 * | 拿到了但解不出形状（JSON 坏 / 字段缺 / 候选越界） | `decode` | 与"没有候选"是两件事，别写成 `no-completion` |
 * | 解出来了但坐标映不回模型（行列对不上） | `locate` | 最容易静默错位的一档；宁可 `failed` 不要"猜一个区间" |
 * | `fetch` | `fetch` | 本地源用在"名录还没建好"（事实缺席但项目已开） |
 *
 * `reason` 给机器（稳定短码，如 `http-503` / `malformed-json`），`note` 给作者：
 * **三段一次给全**（哪段没成 + 为什么 + 可重试），在本包这一层就是 `fail()` 那个形状。
 * 宿主只显示 `note`，不许从 `reason` 复述第二遍。
 *
 * ### 5. 出网只有一条路
 *
 * 模型源**只能**经 `KernelServices.Remote`（`kernel.remote`，`RemoteService`）出网，
 * 不许自己 `fetch`：能力面 = 服务键面（`plugin-api/services.ts` 那枚键的头注写明了理由——
 * 两处各开一条口子，白名单与限额迟早漂）。`requires` 里显式写 `'kernel.remote'`，
 * 缺席时本家该是 `inactive` 可见，而不是每次静默 `no-completion`。
 *
 * ### 6. `version` 逐字回带
 *
 * `'candidates'` 分支必须把 `request.version` 原样写回去。模型源最容易踩这一条：
 * 请求在途时作者又敲了两个字 ⇒ 你算的是上一版文本。**不许**把旧文本的结果标成新版本；
 * 要么回带同一个数（你确实用那一版算的），要么这趟给 `no-completion`。
 */

/**
 * 工厂选项。
 *
 * `minTypedLength` / `enableDeclarationShape` 是**判据旋钮**，只给测试与语料活闸用
 * （量"这一形状在真盘上命中多少"），宿主接线一律走缺省值。它们不是用户偏好：
 * 用户偏好归宿主（同契约头注里"候选上限/超时/窗宽是宿主策略"那条纪律）。
 */
export interface InlineCompletionLocalPluginOptions {
  readonly minTypedLength?: number;
  readonly enableDeclarationShape?: boolean;
  /** 测试注入的时钟（生产缺省 `Date.now`） */
  readonly now?: () => number;
  /** 索引的取用方式（测试注入；缺省 = 现取 `erb.parser` 服务的 `currentIndex()`） */
  readonly indexSource?: () => ErbIndex | null;
}

export function createInlineCompletionLocalPlugin(
  options: InlineCompletionLocalPluginOptions = {},
): Plugin {
  return {
    id: 'inline-completion-local',
    version: '0.1.0',
    /**
     * `erb.parser` 在 `optionalRequires` 而不是 `requires`：
     * 那条键缺席时本包的**全部**判据都成立不了，但把整枚插件打成 `inactive` 会让
     * 作者面读成"补全功能没装"，而真实事实是"这一格的名录还没到位"——后者由
     * `failed` 的 `note` 说得更准（铁律 4：inactive 要可见，但可见的应该是**这一格**的原因）。
     * 两种呈现都满足"不静默"，取信息量更大的那一个。
     */
    optionalRequires: [WellKnownServices.ErbParser],
    provides: [],
    activate(ctx: PluginContext): void {
      const parser = ctx.tryInject<ErbParserService>(WellKnownServices.ErbParser);
      const currentIndex = () => {
        if (options.indexSource !== undefined) return options.indexSource();
        // **每次现读**：项目开闭会换索引对象，activate 那一刻抓到的实例迟早是上一棵树的
        // （口径同 `@kojo/plugin-kojo-lang` 的 `adapterFor`）
        if (parser === undefined) return null;
        try {
          return parser.currentIndex();
        } catch {
          return null; // 服务在、但这一趟读不出名录 ⇒ 交给 provider 说 failed
        }
      };
      ctx.slots.register(
        'completion.source',
        createLocalContribution(
          {
            currentIndex,
            // 提供方在场与否决定 `failed.note` 说哪一句（见 `LocalProviderDeps.serviceAvailable`）；
            // 测试经 `indexSource` 直接喂名录时，"在场"这件事由那枚注入本身成立
            serviceAvailable: () => parser !== undefined || options.indexSource !== undefined,
            // 每次现读（同一棵索引上 `indexState?` 是纯读；服务缺席时如实给 null）
            indexState: () => parser?.indexState?.() ?? null,
            ...(options.now === undefined ? {} : { now: options.now }),
          },
          {
            ...(options.minTypedLength === undefined ? {} : { minTypedLength: options.minTypedLength }),
            ...(options.enableDeclarationShape === undefined
              ? {}
              : { enableDeclarationShape: options.enableDeclarationShape }),
          },
        ),
      );
      ctx.log.info(
        `本地候选源已接入：槽 completion.source / id=${LOCAL_SOURCE_ID} / order=${String(LOCAL_SOURCE_ORDER)}`,
      );
    },
  };
}
