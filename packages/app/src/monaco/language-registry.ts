/**
 * 语言描述符与注册表（LANG-REGISTRY，2026-10-20）。
 *
 * 宿主此前按 `KOJO_LANGUAGE_ID` / `ERB_LANGUAGE_ID` 分支选语言、挂 Monaco 面；
 * 每加一门语言要改 model 池、EditorPane、树层与若干 provider。现在**语言事实**
 * 收进一枚 descriptor：id、认路判据、一次性 Monaco 注册。宿主只按表查，不认识
 * 任何具体语言名。
 *
 * 纪律：
 * - 注册表是**进程级只增表**；同 id 重复注册直接抛错（不静默覆盖，铁律 4）。
 * - 认路按**注册顺序**取第一条命中；若两枚 descriptor 的判据重叠，那是判据本身
 *   写错了（由测试钉住），这里不做投票。
 * - 认不出 = `plaintext` 兜底（与收口前 `languageFor` 的最后一格逐字相同）：
 *   猜成任何 DSL 都会把别的语言的补全 / 悬停塞进不相干文件。
 *
 * ## 可用性门为什么住在这里，而不是设计稿说的 `language-availability.ts`（LAU-3，2026-10-27）
 *
 * `docs/ARCH-language-unification.md` §4.4 把门画成一枚独立模块。落地时改成**注册表内的
 * 一段**，理由是一条实测的闸：开机静态图有硬上限（`ps10-eager-graph.test.ts`：≤194 个
 * 文件 / ≤2,900 KB，现值已贴顶），而门必须在**第一次认领之前**装好 ⇒ 它天然属于开机图，
 * 新增一个文件就是抬一格上限。语义与 §4.4 逐条对齐（纯谓词、注入、门开关不重注册、
 * 已认领的 model 不回头改语言），只是住址不同——文档那三行纠正随本批一起改。
 */
import type * as Monaco from './entry';
import type { LanguageCapability } from './language-capabilities';
import type { StructureLanguageRuntime } from './tree-sitter/structure-runtime';
// 缺省可用性谓词读的就是切流三档（见下方 `DEFAULT_AVAILABILITY_GATE` 的理由）。
// monaco → ui 这条边不是新增先例：`monaco/theme.ts` 同款读 `ui/kojo2-flag`。
import { isKojoLegacySyntaxEnabled } from '../ui/kojo2-flag';

export const FALLBACK_LANGUAGE_ID = 'plaintext';

/**
 * 可以「只挂槽腿」的**能力名**（B2 起，additive）。
 *
 * 取值 = `ui.editor.languageService` 槽的判别成员名。B2 只收**集合型**
 * （`documentSymbol` / `definition` / `references` / `foldingRange` / `inlayHint`）；
 * **B3c 起 `completion`（集合型）与 `hover`（单答型）也在列**——这两条腿的供方已是
 * **插件**，注册一律经 `registerForLanguageServices(monaco, register, kind)` 的 `kind`
 * 参数，只有 descriptor 在 `slotServices` 里点名了这门能力才会被挂上。
 *
 * 单答型"第一家说了算、谁先答取决于注册表顺序"的分歧仍然存在（B2 头注的理由没作废）；
 * 变化在于它现在由"**逐门语言显式声明**"兜住——被谁挂上是写下来的事实，而不是
 * 铺满之后靠顺序碰运气。**B3d 起 `formatting` / `signatureHelp` 也在列**，**B3e 起
 * `references` / `rename` 也在列**——这四条腿的供方同样已是插件，注册一律带能力名。
 */
export type SlotServiceKind =
  | 'definition'
  | 'documentSymbol'
  | 'references'
  | 'foldingRange'
  | 'inlayHint'
  | 'completion'
  | 'hover'
  | 'signatureHelp'
  | 'formatting'
  // B3e：改名同批进共享收口。
  | 'rename'
  // B3f：同符号高亮 / 结构化扩选同批进共享收口。
  | 'documentHighlight'
  | 'selectionRange'
  // B3g：行上注解同批进共享收口（供方 = 插件 `kojo2-codeLens`）。
  | 'codeLens'
  // B3 语义收口（2026-10-30）：结构化着色也进共享收口（供方 = 插件 `kojo2-semanticTokens`）。
  | 'semanticToken'
  /**
   * ERB-PARITY G3（2026-10-31）：跳到实现（`Ctrl+F12`）也进共享收口。
   *
   * 为什么这枚必须进联合：它驱动的正是 `registerForLanguageServices` 的挂载名单——
   * 进联合意味着"点名了这条腿的语言自动挂上"。今天**只有 ERB**
   * 会挂（`languageServices: true` 全腿）：kojo2 的矩阵里这条能力明写"不做（F12 已覆盖）"，
   * 它的 descriptor 不点名这条腿，`SlotServiceKind` 里多这一格对它**零影响**。
   * 供方与判据同在 `@kojo/plugin-erb-parser`（同一份"标签 > `#DIM` > 函数索引"），宿主只做
   * 请求装配与落点编排——不再有"实现 = 直读定义索引"的第二条腿。
   *
   * ⚠ 本文件里的 `SlotServiceKind` 联合由 `language-slot-conformance.test.ts` **按源码字面量**
   * 解析（只剥行注释、不剥块注释）⇒ 块注释里别再写带引号的同样的字面量，否则会被数成第二个成员。
   */
  | 'implementation'
  // SDK-B5b 车 5（2026-10-31）：快速修复的 Monaco 适配腿也进这张表。
  // 它与上面十四条**不是同一个槽**：供方在专用槽 `ui.editor.codeAction`（契约头注写死"再开一个
  // 判别成员就是同一能力两条路径"），这一格只驱动"谁挂这枚 provider / 谁翻形状"，**不**驱动
  // `ui.editor.languageService` 的判别。它是**写面 / 迁移入口**：宿主按切流策略单独装
  // （见 `slot-service-providers.ts` 的 `SLOT_SERVICE_WRITE_LEGS`），不随只读语言面无条件装配。
  | 'codeAction';

/**
 * 「语言族」编辑器右键项的身份（additive，ERB-PARITY G8）。
 *
 * 取值 = `ui/editor-pane/editor-context-actions.ts` 里那几条动作的 `id`（同一件事只留一个
 * 命名法，测试对拍）。**不进 `capabilities`**：矩阵记的是 provider / 槽腿的注册面，而
 * 「快速修复」吃 CodeActionProvider（表里那一格 `codeAction` 只驱动注册与翻译，供方仍在专用
 * 槽 `ui.editor.codeAction`——不是 `ui.editor.languageService` 的判别成员）、
 * 「一键修复」查 `decorator` + `codeAction` 两条槽、「看这一行的状态」查 `documentSymbol`
 * 槽腿、「切换 .kojo 预览」是宿主糖视图开关——都只是 descriptor 上的一格声明。
 *
 * 新增一门语言时点名：右键项**自动出现**，宿主目录零改动（出口 = `languageIdsForContextFace`）。
 */
export type EditorContextFaceId = 'quick-fix' | 'fix-all' | 'jump-to-state' | 'toggle-sugar';

/** 全部族级右键项（when 拼装与测试共用一张表；顺序 = 菜单里的摆放序） */
export const EDITOR_CONTEXT_FACE_IDS: readonly EditorContextFaceId[] = Object.freeze([
  'quick-fix',
  'fix-all',
  'jump-to-state',
  'toggle-sugar',
] as const);

/**
 * 一门语言的**可用性档**（LAU-3 / 设计稿 §4.3、§6）。
 *
 * - `default`：缺省档，恒可被认领、恒进选择器；
 * - `opt-in`：要作者显式开（设置项 `settingKey`）才认领；
 * - `legacy`：**封存层**——不再演进，只保证旧文件在作者显式开启后还能打开。
 *
 * 三档都**只影响"能不能被认领"与"选择器里出不出现"，不影响注册**：注册表是进程级
 * 只增表，门若去增删注册项，`registerAllLanguageSurfaces` 与认领判据两个入口就会打架
 * （kojo2 那一课的原文口径）。门关着 ⇒ 认不出 ⇒ 走 `plaintext` 兜底，与"今天认不出的
 * 文件"完全同一条路，不会半死不活。
 */
export type LanguageAvailability = 'default' | 'opt-in' | 'legacy';

export interface LanguageDescriptor {
  /** Monaco 语言 id（也是 `ITextModel.getLanguageId()` 的返回值） */
  readonly id: string;
  /** 人读名（**上屏的那一个**：状态栏语言格与语言菜单读它，id 只进 `title`） */
  readonly label: string;
  /** 可用性档（缺省 `default`）；`opt-in` / `legacy` 必须同时给 {@link settingKey} */
  readonly availability?: LanguageAvailability;
  /**
   * 这一档的开关键名（`opt-in` / `legacy` 必填，`default` 忽略）。
   *
   * 键名只是**身份**：真值由宿主注入的 {@link AvailabilityGate} 回答（注册表不读设置、
   * 不订阅——§4.4 的"纯谓词"口径）。今天 legacy 那一位映射到切流三档
   * （`ui/kojo2-cutover.ts` 的 `kojo2StageAllowsLegacy`），不新造第四枚开关。
   */
  readonly settingKey?: string;
  /** 认领文件路径（大小写不敏感由各 descriptor 自己保证） */
  readonly matchesPath: (filePath: string) => boolean;
  /** 一次性挂 Monaco 面（Monarch / 配置 / 主题）；必须幂等 */
  readonly register: (monaco: typeof Monaco) => void;
  /**
   * 是否参与**宿主通用语言服务**的双注册（definition / references / symbols / folding /
   * hover / signature / codeLens / inlayHint / semanticToken）。缺省 = false：
   * JSON 这类只读保留面不挂，免得空结果顶掉 Monaco 的缩进折叠与内建行为。
   */
  readonly languageServices?: boolean;
  /**
   * **只挂这几条槽腿**（additive，B2）：与 {@link languageServices} 的分工是**粒度**——
   * 后者是"v1 语义的 11 枚 provider 全铺"，前者是"只挂点名的这几种能力，应答全来自
   * `ui.editor.languageService` 槽"。
   *
   * 为什么需要它（而不是让 kojo2 直接声明 `languageServices: true`）：那 11 枚里有几枚
   * 的**空结果会顶掉 Monaco 内建行为**——最典型是折叠：注册了 `FoldingRangeProvider`
   * 之后 Monaco 的缩进折叠就不再兜底，供方不认这篇时作者会看到"整个文件都不能折叠"。
   * kojo2 的折叠 / 悬停 / 补全归它自己的插件，宿主不该替它铺满。
   *
   * 与 `languageServices` 是**并集**关系：声明了 `languageServices: true` 的语言即使
   * 不写这一格，也参与全部槽腿（v1 的 ERB / .kojo 就是这种）。
   */
  readonly slotServices?: readonly SlotServiceKind[];
  /**
   * 这门语言的**语义着色 legend**（additive，B3 语义收口 2026-10-30）。
   *
   * 缺省 = 契约名字层（`EDITOR_SEMANTIC_TOKEN_TYPES` 三值 + 两枚修饰）。一门语言如果
   * 画的是**另一套名字**（kojo2 的 `role.*` 语法角色层与名字层是两个正交维度，见
   * `@kojo/kojo-sdk/semantic-roles` 的 D6），就在这里声明自己的图例；`installSemanticTokensProvider`
   * 按语言发 provider（Monaco 的 `getLegend()` 不带 model 参数，一枚 provider 只有一份图例）。
   *
   * 两套图例**不合并**：名字必须在**本语言**的图例里，否则宿主丢掉并告警。
   */
  readonly semanticTokenLegend?: {
    readonly tokenTypes: readonly string[];
    readonly tokenModifiers: readonly string[];
  };
  /**
   * 语言服务的**归并形状**（LAU-3 additive 那一条路，§4.3 的差量注①）。
   *
   * 与 {@link slotServices} / {@link languageServices} 是**并集**，不是替代：设计稿给的
   * ① 号路线明写"`slotServices` 原位保留、`services` 只装新腿"，所以旧消费方
   * （`languages.ts` / `language-parity.test.ts` / `tools/lang-ux-matrix.mjs`）零改动。
   *
   * - `slot`：与 `slotServices` 同义的新写法（两者都给了以 `services.slot` 为准）；
   * - `legacyBridge`：v1 语义那 11 枚 provider 全铺（＝`languageServices: true` 的显式名）。
   *   LAU-4 把 ERB 搬进槽之后这一格应当清零；在那之前它是"这门语言还走旧桥"的记账位。
   */
  readonly services?: {
    readonly slot?: readonly SlotServiceKind[];
    readonly legacyBridge?: boolean;
  };
  /**
   * 结构层（tree-sitter）资源。**按需加载**：`load()` 里必须用动态 import，
   * 不然 worker / wasm / 查询会跟着主线程静态图一起进首屏，违背"默认关 = 不存在"。
   * 缺省 = 这门语言没有结构层，叠层不会为它注册任何 provider。
   */
  readonly structure?: {
    readonly load: () => Promise<StructureLanguageRuntime>;
  };
  /**
   * 这门语言**已交付**的语言面（LANG-PARITY-GATE，additive：旧 descriptor 零改动）。
   *
   * 取值 = `monaco/language-capabilities.ts` 的 `ERB_CAPABILITIES` / `KOJO2_CAPABILITIES`
   * （矩阵的行由同一份声明对拍生成）。这里**只列已交付的**：已知缺口在矩阵里以
   * `{ exempt }` 记，不写进这一格——声明是"有"，不是"想要"。
   *
   * 宿主今天不按它分支行为（注册点的注册行才是真源）；它是闸门对账的声明面：
   * `language-parity.test.ts` 逐项断言「声明的面 = 矩阵里非豁免的面 = 注册点取证得到的面」。
   */
  readonly capabilities?: readonly LanguageCapability[];
  /**
   * 这门的语言服务供方**按行窗口取数**（additive，R3 2026-10-28）。
   *
   * 声明的不是偏好，是**代价形状 + 等价性承诺**：说 true 等于承诺「给一段行窗口，
   * 这一段里每一行的说法与整篇算出来的一字不差」（等价性由各自的窗口对拍用例钉着：
   * `erb-parser/tests/semantic-tokens-window.test.ts`、`inlay-window.perf` 那条腿的
   * 用例）。宿主据此才敢在编辑时只下传变更行，而不是整篇。
   *
   * 为什么这条事实住在 descriptor（而不是宿主按语言 id 分支）：宿主**不许认识具体语言名**
   * （`audit-language` 的 M2 项就是拦这个）。供方代价形状是这门语言的属性，与 id、
   * 认路判据、注册面同级，所以它和别的语言事实一样进表，宿主只查表。
   *
   * 缺省 = false ⇒ 整篇取数。**这是有意的默认**：判错成 true 会少答窗口外的行（颜色错），
   * 判错成 false 只是白算一遍（颜色对、慢一点）——两个方向的代价不对称。
   */
  readonly lineWindow?: boolean;
  /**
   * 编辑器右键里的「语言族」动作（additive，ERB-PARITY G8）。与 `capabilities` 同口径：
   * 只写已落地的面（快速修复 = CodeActionProvider、一键修复 = decorator + codeAction 槽、
   * 看这一行的状态 = `documentSymbol` 槽腿、切换预览 = v1 糖视图投影面），不写"想要"。
   * 缺省 = 一项都没有（JSON / 口上 XML 这类数据格式面不在菜单里）。
   */
  readonly contextFaces?: readonly EditorContextFaceId[];
  /**
   * 行注释记号（additive，ERB-PARITY G9）。消费方 = `monaco/document-links.ts`：注释里的
   * 可点链接按记号判、不按语言 id 分支。记号不在宿主造第二份，各取自己的单源（ERB /
   * kojo1 的宿主常量、2.0 的 `@kojo/kojo-lang/constants`）。缺省 = 这门语言没有注释链接面。
   */
  readonly lineComment?: string;
  /**
   * 游戏目录里这份语言的盘上文件**默认只读**（additive，ERB-PARITY G6）。声明 = 这门语言的
   * 文件是**作者源文件**（ADR-0005 写保护的对象）；缺省 = 不做只读保护（数据格式面，
   * 如 JSON / 口上 XML）。消费方唯一出口 = `monaco/language-guard.ts` 的只读门，
   * 宿主不按语言 id 分支。**不看可用性**：封存档只影响"能不能被认领"，保护位跟路径走，
   * 否则切流档位一改，`.kojo1` 就会静默从只读变可编辑。
   */
  readonly gameDirReadOnly?: boolean;
}

const descriptors: LanguageDescriptor[] = [];

export function registerLanguage(descriptor: LanguageDescriptor): void {
  if (descriptors.some((existing) => existing.id === descriptor.id)) {
    throw new Error(
      `[language-registry] 语言 id "${descriptor.id}" 重复注册（${descriptor.label}）`,
    );
  }
  // `opt-in` / `legacy` 必须带开关键：没有键就没有"作者怎么打开它"的答案，
  // 而门默认关 ⇒ 这门语言永远认领不到，且屏上无从解释（铁律 4）。
  if (descriptor.availability !== undefined && descriptor.availability !== 'default' && !descriptor.settingKey) {
    throw new Error(
      `[language-registry] 语言 "${descriptor.id}" 的 availability='${descriptor.availability}' 必须同时给 settingKey`,
    );
  }
  descriptors.push(descriptor);
}

/**
 * 这门语言**声明了**的槽腿（`services.slot` 优先，其次 `slotServices`；都没有 ⇒ 空表）。
 *
 * 为什么收成一枚（SDK-DIALECT，2026-10-31）：descriptor 头注给 `services.slot` 写了
 * "与 `slotServices` 同义、两者都给了以它为准"，而**挂载收口**此前只读 `slotServices`——
 * 照指南用新写法登记的方言一枚 provider 都挂不上（文档与实现之间的一条断口）。
 * 三处消费方（挂载收口 / 按语言弃权 / conformance 台账）从此读同一枚，不许再抄第二份。
 */
export function declaredSlotKinds(descriptor: LanguageDescriptor): readonly SlotServiceKind[] {
  return descriptor.services?.slot ?? descriptor.slotServices ?? [];
}

/**
 * 这门语言走不走 v1 语义的**旧桥**（`languageServices: true`，或它的显式新名
 * `services.legacyBridge`）。缺省 `false` = 只挂 {@link declaredSlotKinds} 点名的腿。
 */
export function usesLegacyBridge(descriptor: LanguageDescriptor): boolean {
  return descriptor.languageServices === true || descriptor.services?.legacyBridge === true;
}

/* ============================== 可用性门（LAU-3 / §4.4） ============================== */

/**
 * 可用性谓词：**缺省一枚住在这里，宿主可以整体换掉**（注册表不存设置、不订阅）。
 *
 * ## 缺省为什么不是"全部可用"，而是读切流三档
 *
 * LAU-3 起 `legacy` 那一档（kojo1 / `kojo-legacy`）的开关就是切流三档：`v1-only` / `dual`
 * 可用、缺省档 `2.0-default` 封存。判据只有一份（`ui/kojo2-flag.ts::isKojoLegacySyntaxEnabled`
 * → `kojo2-cutover.ts::kojo2StageAllowsLegacy`），本模块不抄阶段名。
 *
 * ## 为什么谓词不"由组合根注入"，而是留一枚缺省（偏离设计稿 §4.4 的一处）
 *
 * 开机静态图有硬上限（`ps10-eager-graph.test.ts`：≤194 文件，**顶格零余量**）。让 `App.tsx`
 * import 本模块装门 = 把整张 descriptor 表（≈15.8 KB）拖进**欢迎页**首屏，读数实测
 * 195 文件 / 2,913 KB（越闸）——而 `App.tsx` 里那一位在此之前根本不认识语言表。改成
 * "缺省谓词住在本模块"之后，注册表仍只在 monaco 语言面第一次真正启用时才进图，开机图
 * 一字节不增；门在**第一次认领之前**就位（认领都经 `languages.ts` / `editor-model-pool`，
 * 两者都先加载本模块）。
 *
 * `installAvailabilityGate` 因此保留成**覆盖口**：测试装一枚恒真 / 恒假的假门，或将来
 * 把真源搬到别处时整枚换掉（`null` = 回到缺省谓词，不是"全部可用"）。
 */
const DEFAULT_AVAILABILITY_GATE: AvailabilityGate = (descriptor) =>
  descriptor.availability !== 'legacy' || isKojoLegacySyntaxEnabled();

export type AvailabilityGate = (descriptor: LanguageDescriptor) => boolean;

let availabilityGate: AvailabilityGate | null = null;

/** 换门（传 `null` = 回到缺省谓词）。幂等：后装的覆盖先装的。 */
export function installAvailabilityGate(gate: AvailabilityGate | null): void {
  availabilityGate = gate;
}

/**
 * 这枚 descriptor 此刻可不可用（缺省谓词见上）。
 *
 * 谓词抛错按**不可用**处理并 warn 一次：门是"少露"方向的闸，抛错时宁可落 `plaintext`
 * 兜底，也不要把一门没开的语言放进来（那正是封存层要拦的）。
 */
export function isAvailable(descriptor: LanguageDescriptor): boolean {
  const gate = availabilityGate ?? DEFAULT_AVAILABILITY_GATE;
  try {
    return gate(descriptor) !== false;
  } catch (e) {
    console.warn(
      `[language-registry] 可用性谓词对 "${descriptor.id}" 抛错，按不可用处理：${String(e)}`,
    );
    return false;
  }
}

/**
 * 门关上时**已认领的 model 不回头改语言**（LAU §4.4 的 v1.1 补条 / LAU-3 DoD 那一条测试）。
 *
 * 判据只此一处：目标语言 = 兜底 `plaintext`，而当前语言是一枚**登记了但此刻不可用**的
 * descriptor ⇒ 保持当前语言不动。理由与"少露"那条并不冲突：门关着时把在编文件刷成
 * `plaintext`，作者当场丢高亮与四面，比"这一层暂时不可用"严重得多；而**新开**的文件
 * 走的是 {@link descriptorForPath}（`currentLanguageId` 缺省），照样落兜底。
 *
 * 谁来调：重挂路径（`ui/kojo2-model-language.ts` 的 `reconcile`，切档 / 改名 / 内容指纹
 * 变化都会走它）。建 model 那一刻**没有**当前语言，不传第三格即可。
 */
export function keepClaimedLanguageWhenGated(
  currentLanguageId: string | undefined,
  desiredLanguageId: string,
): string {
  if (currentLanguageId === undefined || currentLanguageId === desiredLanguageId) {
    return desiredLanguageId;
  }
  if (desiredLanguageId !== FALLBACK_LANGUAGE_ID) return desiredLanguageId;
  const claimed = descriptorForLanguageId(currentLanguageId);
  if (claimed === null) return desiredLanguageId; // 认不出的 id（外部塞的 / 已退役）不参与守门
  return isAvailable(claimed) ? desiredLanguageId : currentLanguageId;
}

/**
 * 认领文件（**按可用性过滤**）：门关着的语言认不出 ⇒ 落 `plaintext` 兜底。
 *
 * 判据顺序不变（注册序首次命中）；只是多了一道"命中但不可用 ⇒ 继续找下一枚"。
 * 两枚 descriptor 的判据本就不许重叠（模块头纪律），所以"继续找"在实践里等于"兜底"。
 */
export function descriptorForPath(filePath: string): LanguageDescriptor | null {
  for (const descriptor of descriptors) {
    if (!descriptor.matchesPath(filePath)) continue;
    if (!isAvailable(descriptor)) continue;
    return descriptor;
  }
  return null;
}

/** 全部已登记 descriptor（顺序 = 注册顺序；供宿主按能力批量挂面。**不过滤可用性**：注册与认领是两件事） */
export function languageDescriptors(): readonly LanguageDescriptor[] {
  return descriptors;
}

/**
 * 声明了某一项「语言族右键项」的语言 id（注册序）——宿主认识"哪些语言进右键菜单"的**唯一出口**
 * （ERB-PARITY G8；旧写法是一枚手写名单，把 2.0 漏在外面且不随 descriptor 扩展）。
 * **不过滤可用性**：注册与认领是两件事（见模块头）。
 */
export function languageIdsForContextFace(face: EditorContextFaceId): readonly string[] {
  return descriptors
    .filter((descriptor) => descriptor.contextFaces?.includes(face) === true)
    .map((descriptor) => descriptor.id);
}

/**
 * 声明了行注释记号的语言 id（注册序）——文档链接 provider 的注册面（ERB-PARITY G9）。
 * 注册面与扫注释的判据同源：同一格声明既决定挂哪些语言、也决定按什么记号扫。
 */
export function lineCommentLanguageIds(): readonly string[] {
  return descriptors
    .filter((descriptor) => (descriptor.lineComment ?? '') !== '')
    .map((descriptor) => descriptor.id);
}

/** 这门语言的行注释起头（未登记 / 未声明 ⇒ `null`，调用方自己决定退化到哪） */
export function lineCommentForLanguageId(languageId: string): string | null {
  const declared = descriptorForLanguageId(languageId)?.lineComment;
  return declared === undefined || declared === '' ? null : declared;
}

/**
 * 这份路径命中一门**已登记、但此刻不可用**的语言（例：`2.0-default` 档下的 `.kojo`）。
 *
 * 与 {@link descriptorForPath} 的区别：那一枚答"该挂哪门语言"（封存 ⇒ `plaintext`），
 * 这一枚答"它本来属于一门被封掉的语言吗"。宿主拿它停掉该文件的**语义分析面**
 * （旧装饰器的波浪线 / 问题面板）——只换语言 id 不够：屏上会留下"纯文本 + v1 红波浪线"
 * 这种自相矛盾（真壳体感实测抓到的正是这一条）。
 *
 * **已认领的 model 例外**（与 {@link keepClaimedLanguageWhenGated} 同一条 §4.4 口径）：
 * 传进来的 `claimedLanguageId` 就是这门被封语言的 id ⇒ 返回 `false`（分析照跑）。
 * 否则改档那一刻，在编文件的波浪线会被当场抽走，与设置页"已打开的标签保持原样"
 * 的承诺打架。新开的文件（`claimedLanguageId` 缺省 = 还没认领）才落 `true`。
 *
 * 判据与认领同序（注册序首次命中、判据不重叠），不另造一张表。
 */
export function isLanguageGatedForPath(filePath: string, claimedLanguageId?: string): boolean {
  for (const descriptor of descriptors) {
    if (!descriptor.matchesPath(filePath)) continue;
    if (isAvailable(descriptor)) return false;
    return claimedLanguageId === undefined || claimedLanguageId !== descriptor.id;
  }
  return false;
}

/** 此刻**可被认领**的 descriptor（选择器 / 语言菜单读这一份，不读全表） */
export function availableLanguageDescriptors(): readonly LanguageDescriptor[] {
  return descriptors.filter((descriptor) => isAvailable(descriptor));
}

/**
 * 按 id 问可用性；**注册表里没有这个 id ⇒ true**（不管）。
 *
 * 为什么"没有 = 可用"：门只对自己登记过的那几枚语言说话。存量偏好表 / 外部塞进来的 id
 * （单测环境里注册表本就是空的、插件语言也可能还没登记）一律原样放行，否则门会变成
 * "凡是我不认识的语言都禁掉"——那是把兜底判据反过来用，方向错了。
 *
 * 消费方：`ui/language-mode-pref.ts::resolveModelLanguage`（手工覆盖也要过门，
 * 否则封存档里一条旧偏好就把语言挂回来了）。
 */
export function isLanguageIdAvailable(languageId: string): boolean {
  const descriptor = descriptorForLanguageId(languageId);
  return descriptor === null ? true : isAvailable(descriptor);
}

export function descriptorForLanguageId(languageId: string): LanguageDescriptor | null {
  return descriptors.find((descriptor) => descriptor.id === languageId) ?? null;
}

/**
 * 这门语言的供方**按行窗口取数**吗（{@link LanguageDescriptor.lineWindow}）。
 *
 * 认不出的 id / 没声明 ⇒ `false`（整篇）——见那一格的理由：两个方向代价不对称。
 *
 * 与 {@link isLanguageIdAvailable} 一样**不抛**：这是每次编辑都要问一次的判据，
 * 抛出去等于"着色没了"。
 *
 * 表由 `monaco/languages.ts` 装（`register-dialects.ts` 的 `import './languages'` 保证
 * 在挂任何 provider 之前已在），所以请求期调用时表必已就位；单测要自己装表。
 */
export function lineWindowFor(languageId: string): boolean {
  return descriptorForLanguageId(languageId)?.lineWindow === true;
}

/**
 * 兜底 id 的人话名（`plaintext` → 「纯文本」）。
 *
 * 兜底 id 不是 descriptor（它是"没认出来"的**出口**，不是一门语言），但作者在状态栏看到的
 * 「纯文本」与设置页文案、封存后果说明必须是同一个词。键与 `FALLBACK_LANGUAGE_ID` 的一致性
 * 由 `language-registry.test.ts` 钉住（常量改名而这里没跟 ⇒ 那条断言当场红）；本行不写常量名
 * 是为了不新增 `audit:language` M2 的"按 id 分支"计数。
 */
const FALLBACK_LANGUAGE_LABELS: Readonly<Record<string, string>> = { plaintext: '纯文本' };

/**
 * id → 人读名（上屏用；查不到就原样交回 id，绝不显示空串）。
 *
 * 存在理由：状态栏语言格与语言菜单过去直接渲染 id，于是作者看到的是 `kojo-erb` /
 * `kojo-sugar` 这种契约名。label 是 descriptor 自带的字段，这一格只是把它取出来的唯一出口。
 */
export function languageLabelForId(languageId: string): string {
  const descriptor = descriptorForLanguageId(languageId);
  if (descriptor !== null) return descriptor.label;
  return FALLBACK_LANGUAGE_LABELS[languageId] ?? languageId;
}

/**
 * 一门语言此刻不可用的**人话原因**（可用 ⇒ `null`）。
 *
 * `short` 上屏（语言菜单那一行的括注），`full` 进 `title`（带上 `settingKey`，
 * 便于对着设置页 / devtools 找那一格）。文案只此一份，调用方不许自己按 `availability` 拼。
 */
export interface LanguageUnavailableReason {
  readonly short: string;
  readonly full: string;
}

export function unavailableReason(descriptor: LanguageDescriptor): LanguageUnavailableReason | null {
  if (isAvailable(descriptor)) return null;
  const key = descriptor.settingKey ?? '—';
  return descriptor.availability === 'legacy'
    ? {
        short: '已封存',
        full: `已封存的语言：需在「设置 › Kojo 2.0 档位」里切到「双轨」或「只认 v1」才会启用（settingKey=${key}）`,
      }
    : {
        short: '未启用',
        full: `这一门语言没有启用：需在设置里打开它（settingKey=${key}）`,
      };
}

/**
 * 此刻**不可用**的 descriptor（顺序 = 注册顺序）。
 *
 * 存在的唯一理由是**不静默**（铁律 4）：选择器只列可用的那一批（§4.4），于是一门被封存的
 * 语言会从菜单里凭空消失——作者看到 `.kojo` 变成"纯文本"却找不到为什么。语言菜单据此
 * 在列表末尾补一行说明（label + 原因），不把它做成可点项。
 */
export function unavailableLanguageDescriptors(): readonly LanguageDescriptor[] {
  return descriptors.filter((descriptor) => !isAvailable(descriptor));
}

export function languageIdForPath(filePath: string): string {
  return descriptorForPath(filePath)?.id ?? FALLBACK_LANGUAGE_ID;
}

/** 把每门已登记语言的 Monaco 面挂上（各 descriptor 的 `register` 自带幂等） */
export function registerAllLanguageSurfaces(monaco: typeof Monaco): void {
  for (const descriptor of descriptors) descriptor.register(monaco);
}
