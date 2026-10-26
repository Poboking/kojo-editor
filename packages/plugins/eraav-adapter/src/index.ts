/**
 * @kojo/plugin-eraav-adapter
 *
 * eraAV 游戏适配器。**全部 eraAV 领域知识集中于此包**：内核与通用插件（erb-parser 等）
 * 不得包含任何 eraAV 特有名词与约定。
 *
 * 本批交付面＝ P0 布线 + P1 识别与导航 + P2 语义层：工程识别 / 装载 + Chara 表解析 +
 * 家族索引（本作三种命名形态）+ 变量字典 / 指令表 + 约定规则与静默策略 +
 * 角色级检索范围（**文件根**）+ 展示用中日对照词典。
 * **故意没有**的面（留口，见 `plugin.ts` 头注）：`kojoFaceTemplates` /
 * `stateLinePresets` / 2.0 事实面（`kojo2/`）与发射面（backend）。
 */
export { createEraavAdapterPlugin } from './plugin';
export { ERAAV } from './constants';
export {
  charaNameFromFileName,
  parseCharaCsv,
  parseCharaNoFromFileName,
  parseKojoFileName,
  type ParsedCharaCsv,
} from './chara-csv';
export {
  RULE_ANNOTATION_NO_CONFLICT,
  RULE_CHARA_DUPLICATE_SHADOW,
  RULE_NON_ERB_IN_KOJO_DOMAIN,
  RULE_ROUTER_FACE_MISSING,
  createEraavConventions,
} from './conventions';
export type { EraavKojoFileEntry, EraavKojoScan } from './kojo-scan';
export { ERAAV_NAME_GLOSSARY, glossName } from './name-glossary';
export {
  ERAAV_FACE_LABELS,
  characterNoOfFunction,
  createEraavFamilyIndex,
  parseKojoFamily,
} from './family-index';
export { eraavSearchScopeOptions } from './search-scope';
export {
  loadEraavInstructionNames,
  loadEraavVariableSchema,
  mergeNameTable,
  parseErhDeclarations,
  parseNameTableCsv,
} from './variable-schema';
// 2.0 语言事实面（纯数据、零 IO；adapter-only，无 backend）
export * from './kojo2/index.js';
