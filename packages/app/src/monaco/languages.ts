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
import { JSON_LANGUAGE_ID, JSON_SOURCE_EXTENSION, registerJsonLanguage } from './json-language';
import { KOJO_LANGUAGE_ID, registerKojoLanguage } from './kojo-language';
import { ERB_CAPABILITIES, KOJO2_CAPABILITIES } from './language-capabilities';
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
  // LANG-PARITY-GATE：已交付的能力面（真源 = language-capabilities.ts 的矩阵；声明只列已交付的）
  capabilities: ERB_CAPABILITIES,
  structure: {
    load: () => import('./tree-sitter/erb-runtime').then((m) => m.ERB_STRUCTURE_RUNTIME),
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
 *   `kojo2` 上只会拿空结果顶掉 Monaco 内建行为（2.0 自建的那几枚——折叠 / 缩进 / 语义着色 /
 *   行上注解 / 高亮 / 扩选 / 诊断——各自只认 `kojo2` 语言 id）；声明面由 `capabilities` 与闸门负责；
 * - **`slotServices`（B2 起）**：只点名**确实已由插件接管**的那几条腿。今天是
 *   `documentSymbol`（B2）、`inlayHint`（B2c）、`definition`（B3b），B3c（2026-10-28）补上的
 *   `completion` 与 `hover`，B3d（2026-10-28）补上的 `signatureHelp` 与 `formatting`，
 *   以及 B3e（2026-10-29）补上的 `references` 与 `rename`——这九条的原生 provider 已在对应
 *   批次删除，唯一供方都是 `@kojo/plugin-kojo-lang`，注册走共享收口
 *   （`registerForLanguageServices` 带能力名那一枚）。
 *   仍**不声明**的是折叠：它仍由 `installKojo2FoldingProvider` 自建，提前声明就是给
 *   `kojo2` 挂上一枚没人应答的空 provider，而折叠那枚的空结果会顶掉 Monaco 的缩进折叠；
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
  ],
  capabilities: KOJO2_CAPABILITIES,
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
