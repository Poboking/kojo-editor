/**
 * @kojo/plugin-eraav-adapter
 *
 * eraAV 游戏适配器。**全部 eraAV 领域知识集中于此包**：内核与通用插件（erb-parser 等）
 * 不得包含任何 eraAV 特有名词与约定。
 *
 * 本批交付面＝ P0 布线 + P1 识别与导航：工程识别 / 装载 + Chara 表解析 +
 * 家族索引（本作三种命名形态）+ 变量字典 / 指令表。
 * **故意没有**的面（留口，见 `plugin.ts` 头注）：`conventions` / `kojoFaceTemplates` /
 * `stateLinePresets` / `search.scope` / 2.0 事实面（`kojo2/`）与发射面（backend）。
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
  ERAAV_FACE_LABELS,
  characterNoOfFunction,
  createEraavFamilyIndex,
  parseKojoFamily,
} from './family-index';
export {
  loadEraavInstructionNames,
  loadEraavVariableSchema,
  mergeNameTable,
  parseErhDeclarations,
  parseNameTableCsv,
} from './variable-schema';
