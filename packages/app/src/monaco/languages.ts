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
 */
import type * as Monaco from './entry';
import { extname, isErbDialectPath, KOJO_SOURCE_EXTENSION } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID, registerErbLanguage } from './erb-language';
import { JSON_LANGUAGE_ID, JSON_SOURCE_EXTENSION, registerJsonLanguage } from './json-language';
import { KOJO_LANGUAGE_ID, registerKojoLanguage } from './kojo-language';
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

registerLanguage(ERB_DESCRIPTOR);
registerLanguage(KOJO_DESCRIPTOR);
registerLanguage(JSON_DESCRIPTOR);

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
