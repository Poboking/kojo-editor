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
 * **Kojo 2.0 是开关后的追加项**（K2-EDITOR-WIRE，预演）：开关（`ui/kojo2-flag.ts`，默认关）
 * 关着时本文件行为与收口前逐字一致（仍只有 ERB / Kojo / JSON 三枚）；打开后**在末尾追加**
 * 一枚暂挂 `.kojo2` 的 `kojo2` descriptor，v1 的 `.kojo` descriptor 与注册次序一字不动。
 *
 * **一等语言能力矩阵**（LANG-PARITY-GATE）的声明面也住在这里：ERB / kojo2 各填一份
 * `capabilities`（取值 = `monaco/language-capabilities.ts` 的声明表，矩阵的行由同一份对拍生成）。
 * 注册点仍是各 provider 自己的注册行——`capabilities` 不改行为，只让"缺面"在
 * `tests/language-parity.test.ts` 里红。
 */
import type * as Monaco from './entry';
import { extname, isErbDialectPath, KOJO_SOURCE_EXTENSION } from '@kojo/plugin-api';
import { isKojo2CutoverEnabled } from '../ui/kojo2-flag';
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
  label: 'kojo',
  matchesPath: (filePath) => extname(filePath).toLowerCase() === KOJO_SOURCE_EXTENSION,
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
 * Kojo 2.0 的 descriptor（K2-EDITOR-WIRE，**预演**）：只在开关打开时**追加**进表。
 *
 * - 暂挂 `.kojo2`，**不抢** v1 的 `.kojo`（v1 三枚 descriptor 与注册次序逐字不动）；
 * - 与 v1 两门一等语言不同，这里**不声明** `languageServices` / `structure`：2.0 的宿主
 *   语言服务与结构层还没接，声明了只会把 v1 的 provider 挂到 2.0 的语言 id 上
 *   （空结果顶掉 Monaco 内建行为 = 假承诺）。预演要的只是"文件打得开、脸是对的"；
 * - `capabilities`（LANG-PARITY-GATE，additive）是**声明面**，不是注册开关：2.0 的 provider
 *   逐枚自建（`installKojo2*` 各挂各的 `kojo2` id），声明与注册由闸门对账；缺口以矩阵的
 *   `{ exempt }` 记账，不进这一格；
 * - 表是进程级只增表，本行在**模块求值**时按开关定一次；改开关后重载窗口才换表。
 */
const KOJO2_DESCRIPTOR: LanguageDescriptor = {
  id: KOJO2_LANGUAGE_ID,
  label: 'kojo2',
  matchesPath: (filePath) => extname(filePath).toLowerCase() === KOJO2_SOURCE_EXTENSION,
  register: registerKojo2Language,
  capabilities: KOJO2_CAPABILITIES,
};

registerLanguage(ERB_DESCRIPTOR);
registerLanguage(KOJO_DESCRIPTOR);
registerLanguage(JSON_DESCRIPTOR);
// 追加式：开关关时这一行整体不执行，上面三枚的注册结果与收口前逐字一致。
if (isKojo2CutoverEnabled()) registerLanguage(KOJO2_DESCRIPTOR);

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
