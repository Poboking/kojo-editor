/**
 * **契约形状**（语言包作者要认识的每一格事实）——纯类型叶子，运行时零字节。
 *
 * 两类来源，各一条：
 *
 * | 来源 | 是什么 | 作者拿它做什么 |
 * |---|---|---|
 * | `@kojo/kojo-core` | 游戏侧契约：`GameAdapter` 及其下每一格（事件 / 域符号 / 存储期 / 发射面 / 结构协议） | 写一份**方言 profile**：把这部游戏的引擎事实声明成数据 |
 * | `@kojo/plugin-api` | 插件侧契约：`ui.monaco.language`（词法 / 配置 / 主题）与 `ui.editor.languageService`（补全 / 悬停 / 定义…） | 写**编辑器面插件**：把上面那份数据接到槽位上 |
 *
 * ## 为什么是纯类型
 *
 * 值面（`freezeAdapter` / `validateGameAdapter` / `compileKojoSource` / 各 `create*EmitBackend`）
 * 是**实现**，不是形状：它们各自有依赖图与体量，混进契约叶子会把"只想拿类型"的人也拖进运行时代码。
 * 所以本文件只有 `export type`，作者要值面时从 `@kojo/kojo-core` 取（同一个作者面，不是绕开 SDK）。
 *
 * ## 为什么形状要在这里再列一遍
 *
 * 不是为了"多一层转发"，而是为了让**第三方作者**有一个稳定的入口名：
 * 上游把 `EventSpec` 从 `adapter.ts` 挪到别处、或把 `EditorInlayHint` 从 `slots.ts` 拆走时，
 * 变的是本文件的 import 行，不是每个作者包里的一百处 import。
 */

/* ---------- 游戏侧：adapter 契约（`@kojo/kojo-core`） ---------- */

export type {
  /** 一份方言 profile 的根对象 */
  GameAdapter,
  /** 盘面指纹（换盘 / 换汉化包时必须变） */
  GameFingerprint,
  FingerprintEntry,
  FingerprintKind,
  /** `# 机` 事件目录 */
  EventCatalog,
  EventSpec,
  EventArgumentSpec,
  EventGuard,
  EventDispatchModel,
  EventPriorityModel,
  /** 域符号：代词 / 属性 / 变量 / 名字函数 / 说话人来源 */
  DomainSymbols,
  PronounSymbol,
  PersonRole,
  AttributeSymbol,
  DomainVariableSymbol,
  NameFunctionSymbol,
  SpeakerSource,
  /** 落点 profile（等待 / 取色 / 池 / 随机 / 扩展能力） */
  AdapterProfile,
  NarrationColorPolicy,
  DialogueColorPolicy,
  WaitDefault,
  ColorMode,
  PoolStyle,
  RandStyle,
  ExtensionFeature,
  /** 演出面（心形 / 取色 / 颜绘 / 选项） */
  AdapterPresentation,
  PresentationFeature,
  HeartPresentation,
  HeartMode,
  ColorPresentation,
  FacePresentation,
  FaceCall,
  FaceObject,
  FaceTemplateNames,
  OptionsPresentation,
  /** 存储期 */
  StorageClasses,
  StorageClassSpec,
  StoragePeriod,
  StorageInit,
  /** 程序层开关 */
  ProgramFeatures,
  ProgramFeatureKey,
  /** 编码 / 分层 / 诊断命名空间 / 能力 / source map / 一致性套件 */
  EncodingPolicy,
  TextEncoding,
  EolPolicy,
  LayerPolicy,
  LayerRule,
  LayerMode,
  LayerTarget,
  DiagnosticNamespacePolicy,
  Capability,
  FileAccessScope,
  SourceMapPolicy,
  ConformanceSuite,
  ConformanceCase,
  ConformanceKind,
  /** 载体归属（LAU-D3：正文在哪、注册壳在哪）与方言绑定 */
  CarrierBinding,
  DialectBinding,
  DialectCarrier,
  DialectFactKind,
  DialectId,
} from '@kojo/kojo-core';

/* ---------- 游戏侧：发射面与诊断（`@kojo/kojo-core`） ---------- */

export type {
  /** 一门方言的落点实现（`# 机` / 文本 / 条件 / 表 / 池 / 随机 / 程序层…） */
  KojoEmitBackend,
  KojoLoweringProfile,
  /** 一条诊断（1 基行列、UTF-16 码元、半开区间） */
  KojoDiagnostic,
} from '@kojo/kojo-core';

/* ---------- 编辑器侧：`ui.monaco.language`（`@kojo/plugin-api`） ---------- */

export type {
  /** 一门语言的 Monaco 语言面 = 词法 + 配置 + 主题（纯数据） */
  MonacoLanguageSurface,
  MonacoLanguageContribution,
  MonacoMonarchData,
  MonacoMonarchRule,
  MonacoMonarchAction,
  MonacoMonarchPattern,
  MonacoMonarchWordLists,
  MonacoLanguageConfigurationData,
  MonacoIndentAction,
  MonacoOnEnterAction,
  MonacoOnEnterRule,
  MonacoIndentationRules,
  MonacoAutoClosingPair,
  MonacoSurroundingPair,
  MonacoThemeContributionData,
  MonacoTokenThemeRuleData,
  MonacoThemeBase,
  MonacoComponentPaletteSide,
} from '@kojo/plugin-api';

/* ---------- 编辑器侧：`ui.editor.languageService`（`@kojo/plugin-api`） ---------- */

export type {
  /** 请求：给位置 / 给文档，回事实 */
  EditorLanguageServiceRequest,
  EditorLanguageServiceResult,
  EditorCompletionRequest,
  EditorCompletionResult,
  EditorCompletionItem,
  EditorCompletionItemKind,
  EditorHoverRequest,
  EditorHoverResult,
  EditorFormattingRequest,
  EditorFormattingResult,
  EditorRangeEdit,
  EditorTextEdit,
  EditorSignatureHelpRequest,
  EditorSignatureHelpResult,
  EditorSymbolLocation,
  EditorSemanticTokenRequest,
  EditorSemanticTokenResult,
  EditorSemanticTokenSpan,
  EditorSemanticTokenType,
  EditorSemanticTokenModifier,
  EditorInlayHintRequest,
  EditorInlayHintResult,
  EditorInlayHint,
  EditorInlayHintKind,
} from '@kojo/plugin-api';
