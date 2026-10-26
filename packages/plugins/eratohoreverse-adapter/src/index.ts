/**
 * @kojo/plugin-eratohoreverse-adapter
 *
 * eratohoReverse（真盘标题 `eratohoЯeverse`，Я 是西里尔字母）游戏适配器。
 * **全部本作领域知识集中于此包**：内核与通用插件不得包含任何本作特有名词与约定。
 *
 * 本批交付面＝ P0 布线 + P1 识别与导航 + P2 语义层：工程识别 / 装载 + Chara 表解析 +
 * 口上目录名解析（`NNNN_名前`）+ 家族索引（间接转发路由下的真盘枚举）+
 * 变量字典 / 指令名表 + 角色级检索范围 + 约定规则与静默策略 + 展示用中日对照词典。
 * **故意没有**的面（留口，见 `plugin.ts` 头注）：`kojoFaceTemplates` /
 * `stateLinePresets` / `kojoCallProtocol` / 2.0 事实面（`kojo2/`）与发射面（backend）。
 */
export { createEratohoreverseAdapterPlugin } from './plugin';
export { ERATOHOREVERSE } from './constants';
export {
  charaNameFromFileName,
  parseCharaCsv,
  parseCharaNoFromFileName,
  parseKojoDirName,
  type ParsedCharaCsv,
} from './chara-csv';
export {
  RULE_GHOST_CHARACTER_NO,
  RULE_KX_PLACEHOLDER,
  RULE_SKIPSTART_SHIELDED,
  RULE_UNTAGGED_FACE,
  createEratohoreverseConventions,
  type EratohoreverseConventionDeps,
} from './conventions';
export { ERATOHOREVERSE_NAME_GLOSSARY, glossName } from './name-glossary';
export {
  ERATOHOREVERSE_FACE_LABELS,
  characterNoOfFunction,
  createEratohoreverseFamilyIndex,
  parseKojoFamily,
} from './family-index';
export {
  loadEratohoreverseInstructionNames,
  loadEratohoreverseVariableSchema,
  mergeNameTable,
  parseErhDeclarations,
  parseNameTableCsv,
} from './variable-schema';
