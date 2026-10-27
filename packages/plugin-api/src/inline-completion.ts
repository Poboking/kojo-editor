import type { GameProject } from './game';

/**
 * 内联补全（幽灵文本 / ghost text）的**候选源契约**。
 *
 * ## 本文件是纯类型叶子（零运行时导出）
 *
 * 不许出现 `export const` / `export function` / `export class`：`plugin-api` 的桶被宿主
 * 开机必然静态 import，值导出会把本模块**整体拉进开机图**（`ps10-eager-graph` 实测过
 * `plugin-api/slots` +8.3 KB / `plugin-api/index` +0.4 KB 这种逐块归因），而开机图的
 * KB 闸此刻没有余量。类型在编译期擦除，零重量。由
 * `packages/plugin-api/tests/inline-completion.test.ts` 的源码级闸钉住这条纪律。
 *
 * ⇒ **不在契约里放共享常量**：候选上限、超时预算、上下文字符窗都是**宿主的策略**
 * （宿主握着 model、握着用户偏好、也是唯一的截断点），不是供方之间要对齐的协议数字。
 * 把一个数字写成契约常量，等于邀请第二个地方读它、第三个地方抄它。
 *
 * ## 入口只有一条：槽 `completion.source`
 *
 * 候选源是**多贡献者**能力（今天 = 本地源，以后 = 外部模型源），而服务键是
 * **1:1** 的（`kernel/src/container.ts`：同键二次 provide 抛 `ServiceConflictError`）。
 * 所以它走槽——与 `search.scope` / `export.target` 同族（贡献物是**领域事实**，
 * 界面由宿主画，故不带 `ui.` 前缀）。
 *
 * ⚠ **不塞进 `ui.editor.languageService`**，尽管那正是 LSP 式语言能力的家：该槽的
 * `provide` 是**同步纯函数**（`slots.ts` 的 LS-B0 区块明写"契约刻意不发明
 * CancellationToken，发明了也只能是永远不触发的假令牌"）。异步候选源塞进去只有两个
 * 下场——要么给它单开一条异步旁路（同一能力两条路径 = 本仓最贵的一类债），
 * 要么把同步签名改成 Promise（13 处既有请求全体重新过一遍取消语义）。
 * 判据也钉在测试里（"这两行不许一起存在"只能用源码文本证，类型系统证伪不了）。
 *
 * ## 三态 + 弃权（每家一次调用只说一件事）
 *
 * - `undefined` = **弃权**：这家不服务这门语言 / 这个位置。宿主**继续问下一家**，不记账
 *   （没看过就没资格被显示成"检查过"）。
 * - `{state:'no-completion'}` = **看过并确认没有**。宿主同样继续问下一家，但**记账**——
 *   作者面"这一格为什么没字"的口径来自这里（铁律 4：不许静默）。
 *   只有 `'candidates'` 才算作答（停下不再问下一家）：幽灵文本的判据是"这一格有没有字"，
 *   "没有"是**未作答**而不是答案。这一点与 `hover` 的"空结果也算作答"**刻意分开**——
 *   浮层只有一块，两家各说一套会互相盖住；幽灵文本多家轮流是免费的降级阶梯。
 * - `{state:'failed', …}` = 这一家**缺席**（模型没配 / 出网失败 / 响应不认）。宿主记下
 *   `note` 并继续问下一家；失败不伪装成"没有候选"，也不常驻"加载中"。
 *
 * `provideInline` **只在输入本身不合法时抛错**（形状口径同 `SugarLiftService.liftSuggest`），
 * 业务侧的"这次没结果"一律走上面三态。
 *
 * ## 版本与取消：过期只有一条判据
 *
 * 请求带 `version`（宿主从 `ITextModel.getVersionId()` 递来），`'candidates'` 必须**逐字
 * 回带同一个数**——它不是在传信息，是在**自证**"我这份结果确实按你给我的那一版文本算的"。
 * 宿主在把候选交给 Monaco 之前比对 model 现版本，**不等就整批丢弃并重问**；
 * 回带不等者按契约违规处理并出声。`signal` 是 add-on（口径同
 * `ConventionRunOptions.signal`）：置位后供方不再新起工作、可以立刻 resolve 一个
 * `no-completion`，**不许**抛错——被叫停的一次调用本来也没有观众。
 *
 * ## 零 IO 与零切词
 *
 * `provideInline` 不读盘、不写盘、不发事件：缓冲区可能比磁盘新，**读盘就是按旧坐标算结果**。
 * 文本全部由宿主随请求递入；宿主**不切词**（`prefix` / `suffix` 是光标把当前行切成的
 * 两段原始字面，按语言判词边界是供方的知识——与"触发字符原样递来、宿主不判定"同一条纪律）。
 * 上下文窗由宿主按自身预算裁，供方**不得假设窗宽**：递进来多少就是全部可见上下文。
 *
 * ## 键位不在本契约里
 *
 * 接受键（`Tab`）在宿主侧与补全弹窗、缩进、片段占位符**三方争夺**，IME 合成期间的归属
 * 另有护栏；那些判据属于宿主（`packages/app/src/monaco`），写进契约只会诱使第二个
 * 消费方去猜。契约只保证一件事：**候选是有序的，第 0 条就是按接受键拿到的那一条**。
 */

/* ------------------------------ 坐标 ------------------------------ */

/**
 * 一条候选**要替换的区间**（模型坐标）。
 *
 * 字段名与口径与 {@link RevealRange}（`events.ts`）逐字同构：1 基行、1 基列、
 * **UTF-16 码元**、`endColumn` **不含**（半开区间端点）。另起一套坐标名的代价是
 * 宿主要在两套之间换算，而换算就是漂移的入口。
 *
 * 幽灵文本的常见形状是**空区间**（`startLine === endLine && startColumn === endColumn === 光标列`）
 * 与"吃掉光标后半截已打字面"的区间（模型改写时）——两者都是合法形状，宿主不解释其意图，
 * 只夹取越界值。
 */
export interface InlineCompletionRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/* ------------------------------ 请求 ------------------------------ */

/**
 * 触发方式（中性事实，宿主判定）：
 * - `auto` = 键入停顿引起的被动触发；
 * - `explicit` = 作者主动请求（命令面板 / 快捷键）。
 *
 * "这个字符算不算触发符"仍然**不在这里**——那是语言知识，见 `triggerCharacter`。
 */
export type InlineCompletionTriggerKind = 'auto' | 'explicit';

/**
 * 一次内联补全请求。
 *
 * 与 `EditorCompletionRequest`（补全弹窗）的**差别**写在字段上，不靠读者脑补：
 * 弹窗一次要整篇全文 + 候选列表，幽灵文本一次只要光标附近那一段，而且触发频率高一到
 * 两个数量级——所以这里**没有** `text: string`（整篇复制会把它变成逐键的 full-model copy）。
 */
export interface InlineCompletionRequest {
  readonly path: string;
  /**
   * 模型语言 id（宿主从 `ITextModel.getLanguageId()` 原样递来）。
   * 供方**按它认语言**，不拿 `path` 扩展名二次猜测（口径同 `EditorDocumentIdentity`）。
   */
  readonly languageId: string;
  /** `ITextModel.getVersionId()`：见本文件头的"版本与取消" */
  readonly version: number;
  /** 光标行（1 基） */
  readonly line: number;
  /** 光标列（1 基；UTF-16 码元） */
  readonly column: number;
  /** 光标所在行的整行字面（不含换行符） */
  readonly lineText: string;
  /** 光标**之前**的那半行（原始字面；宿主不切词） */
  readonly prefix: string;
  /** 光标**之后**的那半行（原始字面；宿主不切词） */
  readonly suffix: string;
  /** 光标之前的上下文窗（可跨行；宽度由宿主决定并夹取，供方不得假设） */
  readonly contextBefore: string;
  /** 光标之后的上下文窗（同上） */
  readonly contextAfter: string;
  /** 当前项目（`null` = 没开项目：供方按"无事实"降级，绝不回落到任何默认方言） */
  readonly project: GameProject | null;
  /** 文件行数（体量事实，供方按大小自行降级；缺省 = 未知，按不降级处理） */
  readonly lineCount?: number;
  readonly triggerKind: InlineCompletionTriggerKind;
  /** 触发字符（键入的那一个）；缺省 = 非字符触发。宿主原样递来，**不判定** */
  readonly triggerCharacter?: string;
  /**
   * 这一次调用的**时间预算**（毫秒，宿主决定并夹取）。
   * 供方把它当"过了这个点结果就没观众了"的信号用，不当硬闸；超时由宿主判、由宿主丢弃。
   */
  readonly timeoutMs: number;
  /** 取消位（additive，缺省 = 无取消；口径同 `ConventionRunOptions.signal`） */
  readonly signal?: AbortSignal;
}

/* ------------------------------ 候选 ------------------------------ */

/**
 * 候选的中性类别 —— **与 `EditorCompletionItemKind` 同一张词表**（宿主按它挑图标与
 * 排序档，零语言知识）。两张表各写一份必然出现"弹窗认识的档幽灵文本不认"，
 * 故从 `slots.ts` 直接复用，不新造。
 */
export type InlineCompletionItemKind = import('./slots').EditorCompletionItemKind;

/**
 * 一条幽灵文本候选。
 *
 * 排序即语义：结果里的**第 0 条**就是按下接受键拿到的那一条，其余是宿主侧
 * "逐候选切换"命令的候选池。宿主**不重排**（重排的判据会漂），只做夹取、去重与截断。
 */
export interface InlineCompletionCandidate {
  /**
   * 供方内唯一、且**在宿主侧带命名空间**的 id（同 `SearchScopeOption.id` 的纪律：
   * 两个提供方的 id 相同也不串线，因为宿主用 `pluginId` 给它加前缀）。
   */
  readonly sourceId: string;
  /** 要替换的区间（见 {@link InlineCompletionRange}） */
  readonly range: InlineCompletionRange;
  /** 真正写进缓冲区的文本（接受键落的就是它） */
  readonly insertText: string;
  /**
   * 只用于**显示**的字面（例如 `insertText` 含制表符或多行时，面上想显示的单行形态）。
   * 缺省 = 宿主显示 `insertText`；**宿主不许自行转义或裁切**（猜出来的显示文本是第二份真相）。
   */
  readonly displayText?: string;
  readonly kind?: InlineCompletionItemKind;
  /**
   * 一句话理由 / 来源说明（作者面浅色跟在幽灵文本后头的提示语）。
   * 由供方生成，宿主原文显示、不解析、不改写（同 `SearchScopeOption.label` 纪律）。
   */
  readonly note?: string;
}

/* ------------------------------ 结果 ------------------------------ */

/**
 * 失败发生在**哪一段**（中性词汇，零游戏名词，也不预设"一定是网络"）。
 * 外部模型源用满这五档；本地源通常只会出现 `assemble` / `decode`。
 */
export type InlineCompletionStage =
  /** 组装上下文（把请求里的窗口拼成供方内部表示） */
  | 'context'
  /** 取候选（本地查表 / 远程发问都在这一段） */
  | 'fetch'
  /** 传输（出网那一段；本地源用不到） */
  | 'transport'
  /** 解析响应 */
  | 'decode'
  /** 定位（把供方内部坐标映回模型坐标；这一段最容易静默错位） */
  | 'locate';

/**
 * 一条失败态：**哪一段没成 + 为什么 + 可重试**，三段一次给全。
 *
 * `note` 由**供方在这一份对象里就生成好**（口径同 `makeUpdateFailure`）：作者面的失败
 * 话术若留给每个消费方自己拼，就会拼出两套。消费方只许显示 `note`，
 * 不从 `reason` 复述第二遍。`detail` 给机器（日志 / 状态面板），不给作者。
 */
export interface InlineCompletionFailure {
  readonly stage: InlineCompletionStage;
  readonly reason: string;
  readonly detail?: string;
  readonly note: string;
}

/**
 * 一次调用的结果（**判别联**；`undefined` = 弃权，见本文件头）。
 *
 * `candidates` 分支**不许**是空数组——"没有"只有 `no-completion` 一种写法，
 * 两种写法并存时宿主就得决定信哪个（本仓的静默事故大半长这样）。
 * 宿主见到空数组按**契约违规**处理并出声，不当作 `no-completion` 悄悄咽下。
 */
export type InlineCompletionOutcome =
  | {
      readonly state: 'candidates';
      /** 必须逐字等于 `request.version`（不等 = 供方拿旧文本算的结果，宿主丢弃并出声） */
      readonly version: number;
      readonly candidates: readonly InlineCompletionCandidate[];
      /**
       * 这一批**不完整**（供方主动声明：预算用尽 / 被叫停前只算出一部分）。
       * 不完整的一批照样能接受（第 0 条是完整的），但宿主**不得**把它当"这家已经问完了"
       * 记进缓存，也不得据此停掉下一家。缺省 = 完整。
       */
      readonly partial?: boolean;
    }
  | { readonly state: 'no-completion' }
  | ({ readonly state: 'failed' } & InlineCompletionFailure);

/* ------------------------------ 贡献方 ------------------------------ */

/**
 * 候选源贡献方（槽 `completion.source`）。
 *
 * - `id` / `order` / `pluginId` 来自 `ContributionBase`：`order` 小者先问，
 *   **第一家给出 `candidates` 的就是答案**（单答型呈现，多家轮流 = 天然的主/备降级）；
 * - `title` 是作者面显示名（设置页与"这一格的字来自谁"的说明都显示它；
 *   宿主原文显示，不解析）；
 * - `provideInline` 可弃权返回 `undefined`（不服务 = 不记账，见本文件头）。
 */
export interface InlineCompletionSourceContribution {
  readonly id: string;
  readonly order?: number;
  readonly pluginId?: string;
  readonly title: string;
  provideInline(request: InlineCompletionRequest): Promise<InlineCompletionOutcome | undefined>;
}
