/**
 * 内置语言的**唯一装配点**（LANG-REGISTRY，2026-10-20）。
 *
 * 每门语言 = 一枚 `LanguageDescriptor`（id / 认路判据 / Monaco 注册）。宿主此后只按
 * descriptor 选语言、挂面；新增一门语言 = 往这里加一枚 descriptor 与它自己的资源，
 * model 池、EditorPane 与 provider 接线零改动。
 *
 * **ERB 与 Kojo 是同级一等语言**：两者都完整登记（Monarch、扩展名映射、配置、主题），
 * 不把 ERB 写成 Kojo 的预览 / 附属形态。JSON 是只读保留面（微型 Monarch，无 worker），
 * 同样走 descriptor，不在选语言处另开分支。
 *
 * 注册顺序 = provider 注册顺序（ERB 先、Kojo 后，与收口前 `registerForKojoDialects`
 * 逐字一致）；认路判据彼此不重叠，路径解析结果不受顺序影响。JSON 不声明
 * `languageServices`，因此不参与通用语言服务双注册。认不出路径 ⇒ plaintext 兜底。
 *
 * **Kojo 2.0 默认可见**（K2-SURFACE-DEFAULT，批次十 S5）：`.kojo2` 的 descriptor
 * **无条件登记**（放在表尾），语言面（Monarch 高亮 / 语言配置 / 括号 / 回车与缩进规则）
 * 与切流阶段无关；切流开关（`ui/kojo2-flag.ts`）只门控**写回 / 迁移 /
 * 解析器切换**那几条有副作用的语义，不再决定 `.kojo2` 打不打得开。
 * v1 的 `.kojo` descriptor 与三枚的注册次序一字不动。
 *
 * **一等语言能力矩阵**（LANG-PARITY-GATE）的声明面也住在这里：ERB / kojo2 各填一份
 * `capabilities`（取值 = `monaco/language-capabilities.ts` 的声明表，矩阵的行由同一份对拍生成）。
 * 注册点仍是各 provider 自己的注册行——`capabilities` 不改行为，只让"缺面"在
 * `tests/language-parity.test.ts` 里红。
 */
import type * as Monaco from './entry';
import { extname, isErbDialectPath, KOJO_SOURCE_EXTENSION, KOJO_V1_SOURCE_EXTENSIONS } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID, registerErbLanguage } from './erb-language';
import { ERB_LINE_COMMENT } from '@kojo/erb-lang/enter';
import { JSON_LANGUAGE_ID, JSON_SOURCE_EXTENSION, registerJsonLanguage } from './json-language';
import { KOJO1_LINE_COMMENT, KOJO_LANGUAGE_ID, registerKojoLanguage } from './kojo-language';
import { ERB_CAPABILITIES, KOJO2_CAPABILITIES } from './language-capabilities';
// B3 语义收口：kojo2 的着色图例是**语法角色层**（`role.*`，与契约名字层正交）。名字集在
// 语言面库的语义叶子里；这里只把它声明给 descriptor（宿主不另抄一份角色名单）。
import { KOJO2_SEMANTIC_TOKEN_TYPES } from '@kojo/kojo-lang/semantic';
// ERB-PARITY G9：2.0 的行注释记号取零依赖身份叶子（`language-config` 的 `comments` 读同一枚）。
import { KOJO2_LINE_COMMENT } from '@kojo/kojo-lang/constants';
import {
  KOJO2_LANGUAGE_ID,
  KOJO2_SOURCE_EXTENSION,
  registerKojo2Language,
} from './kojo2-language';
import {
  languageIdForPath,
  registerAllLanguageSurfaces,
  registerLanguage,
  type LanguageDescriptor,
} from './language-registry';
import {
  KOJO_XML_LANGUAGE_ID,
  KOJO_XML_SOURCE_EXTENSION,
  registerKojoXmlLanguage,
} from './xml-language';

/**
 * 2.0 的源路径判据（LAU-3b-FLIP）：`.kojo` 是主场、`.kojo2` 是旧名兼容。
 *
 * 两枚都从各自单源现取（`.kojo` = 契约 `KOJO_SOURCE_EXTENSION`，`.kojo2` = kojo-lang
 * 的零依赖叶子），本函数只是把它们并列一次——不在宿主再抄字面量。
 */
function isKojo2SourcePath(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ext === KOJO_SOURCE_EXTENSION || ext === KOJO2_SOURCE_EXTENSION;
}

const ERB_DESCRIPTOR: LanguageDescriptor = {
  id: ERB_LANGUAGE_ID,
  label: 'ERB',
  matchesPath: (filePath) => isErbDialectPath(filePath),
  register: registerErbLanguage,
  languageServices: true,
/**
   * LAU-4 引用腿（2026-10-31）：查找引用的**判据**已整块搬进 `@kojo/plugin-erb-parser`
   * （`$` 标签 / `#DIM` 声明 / 反向索引三腿合一）；这一格点名把"这条腿交给插件答"写下来，
   * 复用的就是 kojo2 那张表。`languageServices: true` 保留——ERB 其余各腿（大纲 / 折叠 /
   * 转定义 / 着色 / 行内提示 / 注解 / 高亮 / 扩选 / 补全 / 签名）都靠这枚旧桥铺满，
   * 点名只用来记"这条腿交给插件答、宿主同种 provider 要让位"；点名这一格
   * 还另有一个消费者：宿主据此做投影面发问位点的行尾对齐，
   * 见 `ui/editor-global-providers.ts` 的 `referenceRequestPointOf`。
*
   * ERB-PARITY G1（2026-10-31）：悬停交给插件供方（`@kojo/plugin-erb-parser` 的 `erb-hover`）。
   * 点名这一格的作用是**把旧桥那枚让开**（`kojo-hover.ts` 的安装器按 `excludeNamed` 跳过
   * 点名了 `hover` 的语言）——注册本身早已由 `languageServices: true` 覆盖。
   *
   * LAU-4 补全腿（2026-10-31 第三批）**不点名**，而且这里没有第二份双挂要收：判据整块住
   * `@kojo/plugin-erb-parser`，宿主那枚自装配 provider（`installErbCompletion`）的**调用点已删**
   * ⇒ 生产路径上 `.erb` 的补全只有共享槽腿那一枚（旧桥铺的，能力名 `completion`）。
   * 不点名的理由：这一格今天没有消费者——补全腿不像 `documentHighlight` / `selectionRange` /
   * `rename` 那样带"只答点名语言"的弃权闸，也没有宿主同种 provider 需要 `excludeNamed` 让位，
   * 重复点名等于第三份台账。**判据留在这里**：若哪天要重新挂宿主自装配的补全 provider，
   * 必须同时①在这张表里点名 `completion`，②挂载写成
   * `registerForLanguageServices(monaco, register, undefined, { excludeNamed: 'completion' })`
   * ——第三参给成 kind 就把点名语言重新挂上，"一个 kind 恰一枚"立刻破（`language-parity`
   * 的补全档与 `erb-completion-slot` 的"恰一枚"格钉着这条）。
   *
   * ERB-PARITY G2（2026-10-31）：格式化（整篇 + 区间）交给插件供方
   * （`@kojo/plugin-erb-lang` 的 `erb-formatting`，判据仍是 `@kojo/kojo-vocab/formatter`
   * 那一把尺子）。点名这一格同时**把旧桥那两枚让开**：`kojo-format.ts` 的整篇安装器按
   * `excludeNamed` 跳过、`kojo-format-range.ts` 的区间注册整条删除（on-type 保留）——
   * 于是 ERB 每种 provider 恰好一枚，「谁在答」不再取决于注册序。
   */
slotServices: [
    'references',
    'hover',
    'formatting',
    /*
     * DOUBLE-LEG-1032（2026-10-31，变基到 G2 之后）：同符号高亮 / 结构化扩选 / 行上注解三格也点名。
     * 点名的消费方是 **`excludeNamed`**（`register-dialects.ts`）：这三格的供方今天已全在插件
     * （`@kojo/plugin-erb-lang` 的 `erb-documentHighlight` / `erb-selectionRange`、
     * `@kojo/plugin-erb-parser` 的 `erb-usage-lens`），宿主那三枚**纯翻译腿**
     * （`erb-highlight.ts` / `erb-selection-range.ts` / `kojo-code-lens.ts` 的 ERB 挂载）
     * 按点名让位，Monaco 每一 kind 只剩共享槽腿那一枚 provider——同一次请求不再白问两趟供方，
     * "谁在答"由这张声明表决定，不再由注册顺序决定。`.kojo1`（不点名）仍由旧桥腿答，零改动。
     */
    'documentHighlight',
    'selectionRange',
    'codeLens',
  ],
  // LAU-4 补全腿第三批（2026-10-31）：ERB 补全的判据全在插件 `@kojo/plugin-erb-parser`，
  // 事实（adapter 表 / 项目名录 / 宿主词表 / 偏好）由组合根经槽腿的 `completionFacts`
  // 现取并随请求递下去。声明在这里 = 收口侧不必按语言 id 分支。
  completionFacts: true,
  /**
   * 中文候选补**拼音可检索键**（`filterText` = `原文 全拼 首字母`）：搬家前 `.erb` 那本册由
   * 装配核无条件补这一格（P2-12 / SUGGEST-PINYIN-GAP），走槽之后落点只剩翻译层 ⇒ 由
   * descriptor 点名（收口不按语言 id 分支）。ERB 的变量名 / `#DIM` 名以中文为主，
   * 罗马字搜索是既有能力，不许在搬家中丢掉。
   */
  completionPinyinFilter: true,
  // 触发字符的**追加**清单：`#` / `@` 已在共享那份里，这里只补 ERB 独有三枚——
  // `[` 区间标记行、`$` 跳转标签目标、`.` 点号成员位（ERB 没有点号语法，它是族查询键）。
  completionTriggerCharacters: ['[', '$', '.'],
  // LANG-PARITY-GATE：已交付的能力面（真源 = language-capabilities.ts 的矩阵；声明只列已交付的）
  capabilities: ERB_CAPABILITIES,
  // ERB-PARITY G8 / G9：四项族级右键项全在（codeAction / decorator + codeAction 槽、
  // `documentSymbol` 槽腿、糖视图原文侧）；行注释 `;` 取 `@kojo/erb-lang/enter` 的唯一常量。
  contextFaces: ['quick-fix', 'fix-all', 'jump-to-state', 'toggle-sugar'],
  lineComment: ERB_LINE_COMMENT,
  // ERB-PARITY G6：游戏目录里的 ERB 是作者源文件 ⇒ 默认只读，解锁后才给写面
  // （判据的唯一出口 = `monaco/language-guard.ts`；宿主不按语言 id 分支）。
  gameDirReadOnly: true,
  /**
   * R3（2026-10-28）：ERB 的两条语言服务腿（行内提示 `callArgumentHints` / 结构化着色
   * `erbSemanticTokens`）都把行窗口吃进了输入，且窗口内逐行说法与整篇一字不差
   * （对拍见 `erb-parser/tests/semantic-tokens-window.test.ts` 与 `inlay-window.perf`）。
   * 声明在表里，宿主才能只下传变更行/视口而不认识"erb"这个名字（M2 铁律）。
   * `.kojo1` 走糖线整篇转译、kojo2 整篇 lex+parse，都不声明。
   */
  lineWindow: true,
  structure: {
    load: () => import('./tree-sitter/erb-runtime').then((m) => m.ERB_STRUCTURE_RUNTIME),
    /**
     * R5（2026-10-29 折叠单源）：折叠**不由结构层供**——`erb-parser` 的 `erb-folding`
     * 在 `ui.editor.languageService` 槽上供的那一份是超集（24,197 行真语料：插件 8,066 条 /
     * 结构层 6,926 条，重合 6,923；结构层独有 3 条里 1 条是它自己的误折、1 条只有空行尾巴之差，
     * 剩下的 `[SKIPSTART]` 块本批补进了插件侧）。留着两家的代价不是"多算一遍"——
     * Monaco 把同语言的多枚折叠供给器**并起来等最慢的那条**，于是首解被 worker 那一趟
     * 顶到 186–210 ms；插件那条是同步的。
     */
    folds: false,
  },
};

const KOJO_DESCRIPTOR: LanguageDescriptor = {
  id: KOJO_LANGUAGE_ID,
  // 上屏名（LAU-3 / §6）：作者面只叫「kojo1（封存）」——「kojo」这个名字归 2.0。
  label: 'kojo1（封存）',
  /**
   * 封存层（D7）：**不是版本开关，是另一门语言**。默认可用性由宿主注入的门回答
   * （`ui/kojo2-cutover.ts` 的 `kojo2StageAllowsLegacy`：三档里 `v1-only` / `dual` 为开），
   * 门是纯谓词、注册表不读设置也不订阅（§4.4）。
   *
   * 认路判据（LAU-3b-FLIP，2026-10-27 用户口径「`.kojo` 当场让给 2.0」）：**只剩 `.kojo1`**。
   * `.kojo` 是 2.0 的源（见下面的 KOJO2_DESCRIPTOR），两门语言的认路判据从此不重叠。
   * 判据取契约层 `KOJO_V1_SOURCE_EXTENSIONS`，不在宿主另抄一份。
   *
   * `settingKey` 是**身份**不是第二枚开关：本仓已有切流三档，再造一枚布尔就是两处状态
   * 必漂（用户 2026-10-27 口径「用现成三档」）。
   */
  availability: 'legacy',
  settingKey: 'ui.legacy-kojo-syntax',
  matchesPath: (filePath) => KOJO_V1_SOURCE_EXTENSIONS.includes(extname(filePath).toLowerCase()),
  register: registerKojoLanguage,
  languageServices: true,
  // 与 ERB 同面（行为零变化：它此前就在那枚手写名单里）；糖视图的**投影侧**就是它。
  contextFaces: ['quick-fix', 'fix-all', 'jump-to-state', 'toggle-sugar'],
  lineComment: KOJO1_LINE_COMMENT,
  // ERB-PARITY G6：糖源同样是作者源文件 ⇒ 游戏目录里默认只读（与语言可用性无关：
  // 封存档只影响"能不能被认领"，保护位跟路径走）。
  gameDirReadOnly: true,
  structure: {
    load: () => import('./tree-sitter/kojo-runtime').then((m) => m.KOJO_STRUCTURE_RUNTIME),
  },
};

const JSON_DESCRIPTOR: LanguageDescriptor = {
  id: JSON_LANGUAGE_ID,
  label: 'JSON',
  matchesPath: (filePath) => extname(filePath).toLowerCase() === JSON_SOURCE_EXTENSION,
  register: registerJsonLanguage,
};

/**
 * Kojo 2.0 的 descriptor（K2-SURFACE-DEFAULT，**默认登记**）：无条件追加在表尾。
 *
 * - 认 **`.kojo`（主场，2026-10-27 起从 v1 手里接过）与 `.kojo2`（旧名，兼容）**；
 *   v1 的 descriptor 只剩 `.kojo1`，两边不重叠；
 * - **不声明 `languageServices`**：通用双注册那 11 枚 provider 是 v1 语义的供方，挂到
 *   `kojo2` 上只会拿空结果顶掉 Monaco 内建行为（2.0 仍自建的那几枚——缩进 / 诊断——各自
 *   只认 `kojo2` 语言 id；行上注解、折叠与语义着色自 B3g / B3h / B3 语义收口起改走共享
 *   收口 + 插件供方）；声明面由 `capabilities` 与闸门负责；
 * - **`slotServices`（B2 起）**：只点名**确实已由插件接管**的那几条腿。今天是
 *   `documentSymbol`（B2）、`inlayHint`（B2c）、`definition`（B3b），B3c（2026-10-28）补上的
 *   `completion` 与 `hover`，B3d（2026-10-28）补上的 `signatureHelp` 与 `formatting`，
 *   B3e（2026-10-29）补上的 `references` 与 `rename`，B3f（2026-10-29）补上的
 *   `documentHighlight` 与 `selectionRange`，B3g（2026-10-30）补上的 `codeLens`，以及
 *   B3h（2026-10-30）补上的 `foldingRange`，以及 B3 语义收口（2026-10-30）补上的
 *   `semanticToken`——这十四条的原生 provider 已在对应批次删除，
 *   唯一供方都是 `@kojo/plugin-kojo-lang`，注册走共享收口（`registerForLanguageServices`
 *   带能力名那一枚）。B5b（2026-10-30）把两条最老的腿残留的宿主模块
 *   （`kojo2-symbols.ts` / `kojo2-inlay.ts`，各自零生产调用）也删了 ⇒ 这两条腿的 Monaco 翻译
 *   只剩共享收口那一份，槽登记表本身一字未动。折叠之所以能被点名，是因为 B3h 把"worker 事实塞不进同步槽"解决了：
 *   宿主预取 + 请求里带快照（`EditorFoldingRangeRequest.folds`），供方同步裁与答；
 * - **不声明 `structure`**：`monaco/tree-sitter/kojo2-runtime.ts` 只导出主线程单例
 *   （`getKojo2TreeSitterRuntime`：parse / captures）与内核类型，**没有**
 *   `StructureLanguageRuntime`（`runtimeWasmUrl` / `grammarWasmUrl` / `createWorker`）这一层
 *   适配器；2.0 的结构面走自己的 worker 客户端（`tree-sitter/kojo2-worker-runtime.ts`），
 *   由 `kojo2-folding` / `kojo2-indent` / `kojo2-semantic` 直接消费。在这里声明 `structure`
 *   等于要求通用叠层再起一套 worker / 资源接线（与既有那三枚并行、互相重复），所以不硬编；
 * - `capabilities`（LANG-PARITY-GATE，additive）是**声明面**，不是注册开关：与注册点由闸门
 *   对账，缺口以矩阵的 `{ exempt }` 记账，不进这一格；
 * - 表是进程级只增表，本行在**模块求值**时登记一次；开关开 / 关都不再改变注册表
 *   （K2-SURFACE-DEFAULT：2.0 面不随切流阶段增减）。
 */
const KOJO2_DESCRIPTOR: LanguageDescriptor = {
  id: KOJO2_LANGUAGE_ID,
  // 上屏名（用户 2026-10-27 口径）：**只有一个「kojo」**，它就是 2.0；id 仍是 `kojo2`
  // （全仓 200+ 处引用 + M2 棘轮按常量名计数，改 id 是另一场迁移）。
  label: 'kojo',
  matchesPath: (filePath) => isKojo2SourcePath(filePath),
  register: registerKojo2Language,
  slotServices: [
    'documentSymbol',
    'inlayHint',
    'definition',
    'completion',
    'hover',
    'signatureHelp',
    'formatting',
    // B3e：引用 / 改名也交给插件供方。
    'references',
    'rename',
    // B3f：同符号高亮 / 结构化扩选也交给插件供方。
    'documentHighlight',
    'selectionRange',
    // B3g：行上注解（`# 机` / `@织` / `@函` 计数）也交给插件供方。
    'codeLens',
    // B3h（2026-10-30）：折叠交给共享收口 + 插件供方——可折区间来自结构 worker（异步），
    // 宿主打开 / 改动时预取进缓存、随请求的 `folds` 递过去；槽内同步作答。
    'foldingRange',
    // B3 语义收口（2026-10-30）：结构化着色同样交给共享收口 + 插件供方——捕获快照由宿主
    // 预取（`monaco/kojo2-semantic.ts`），随请求的 `captures` 递过去；槽内同步作答。
    'semanticToken',
    // SDK-B5b 车 5（2026-10-31）：快速修复 / 一键迁移也点名——"点名的语言才挂这枚
    // CodeActionProvider"（供方仍在专用槽 `ui.editor.codeAction`）。它是写面，宿主按切流
    // 策略单独装（`SLOT_SERVICE_WRITE_LEGS`），**不**随只读语言面无条件装配。
    'codeAction',
  ],
  // 着色图例是**语法角色层**（`role.*`）：与契约名字层正交（D6），故按语声明、不与 ERB 合并。
  semanticTokenLegend: {
    tokenTypes: KOJO2_SEMANTIC_TOKEN_TYPES,
    tokenModifiers: [],
  },
  capabilities: KOJO2_CAPABILITIES,
  // ERB-PARITY G8：三项与 ERB / kojo1 同口径（旧手写名单把它漏在外面 = G8 的缺陷）——
  // 快速修复有 2.0 自己的 CodeActionProvider（判据在 `@kojo/kojo-lang/code-actions`）、
  // 一键修复查 decorator（供方 `kojo2-diagnostics`）+ codeAction 槽、看状态只要
  // `documentSymbol` 槽腿。**不声明 `toggle-sugar`**：`.kojo` 预览是 v1 糖视图，
  // 2.0 源没有可投影面，声明它只会长出一项按下去只能回"当前不可用"的菜单项。
  // ERB-PARITY G9：行注释 `//` 取 `@kojo/kojo-lang/constants`（语言配置读同一枚）。
  contextFaces: ['quick-fix', 'fix-all', 'jump-to-state'],
  lineComment: KOJO2_LINE_COMMENT,
  // ERB-PARITY G6：`.kojo` / `.kojo2` 也是作者源文件 ⇒ 游戏目录里默认只读
  // （门在 `monaco/language-guard.ts`；JSON / 口上 XML 这类数据格式面不声明）。
  gameDirReadOnly: true,
};

registerLanguage(ERB_DESCRIPTOR);
registerLanguage(KOJO_DESCRIPTOR);
registerLanguage(JSON_DESCRIPTOR);
// K2-SURFACE-DEFAULT：无条件登记（切流阶段只管写回 / 迁移 / 解析器切换，不管语言面可不可见）。
registerLanguage(KOJO2_DESCRIPTOR);

/**
 * 口上 XML（`kojo-xml`，2026-10-24 eraFL 适配批）：**声明式口上文件**的语言面。
 *
 * - 只认 `.xml`；不声明 `languageServices`（理由见 `xml-language.ts` 头注：
 *   通用双注册会给它挂上 ERB/kojo 那 11 枚 provider，空结果会顶掉内建行为）；
 * - 不声明 `structure`（没有 tree-sitter 语法，折叠由自建 provider 按标签配对给）；
 * - `capabilities` 不填：能力矩阵（LANG-PARITY-GATE）当前只覆盖 ERB / kojo2 两门
 *   一等语言，XML 是**数据格式面**而非作者编程语言，硬拉进同一张矩阵会把矩阵的
 *   "缺面"语义搅浑。它的面由自己的测试钉住。
 */
const KOJO_XML_DESCRIPTOR: LanguageDescriptor = {
  id: KOJO_XML_LANGUAGE_ID,
  label: '口上 XML',
  matchesPath: (filePath) => extname(filePath).toLowerCase() === KOJO_XML_SOURCE_EXTENSION,
  register: registerKojoXmlLanguage,
};

registerLanguage(KOJO_XML_DESCRIPTOR);

/** 按路径选 Monaco 语言 id（收口前 `languageFor` 的单源） */
export function languageForPath(filePath: string): string {
  return languageIdForPath(filePath);
}

/**
 * 一次性挂上全部内置语言的 Monaco 面。调用点只有 EditorPane 模块顶层一处
 * （与收口前那次 `registerErbLanguage` + `registerKojoLanguage` 同一时刻）。
 */
export function registerBuiltinLanguageSurfaces(monaco: typeof Monaco): void {
  registerAllLanguageSurfaces(monaco);
}
