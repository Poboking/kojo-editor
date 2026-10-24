/**
 * @kojo/plugin-erafl-adapter
 *
 * eraFL 游戏适配器。**全部 eraFL 领域知识集中于此包**：
 * 内核与通用插件（erb-parser 等）不得包含任何 eraFL 特有名词与约定。
 *
 * 本批导出面 = 工程识别 / 装载 + Chara 表解析 + 家族索引；
 * 语义层（variableSchema / conventions / callProtocol …）由后续批次追加。
 */
export { createEraflAdapterPlugin } from './plugin';
export { ERAFL } from './constants';
export {
  charaNameFromFileName,
  parseCharaCsv,
  parseCharaNoFromFileName,
  parseKojoDirName,
  type ParsedCharaCsv,
} from './chara-csv';
export {
  ERAFL_FAMILIES,
  ERAFL_FACE_LABELS,
  createEraflFamilyIndex,
  parseKojoFamily,
} from './family-index';

/* Kojo 2.0 数据面（入口 B）：宿主组合根按 `project.adapterId` 解析后注入六条语言腿。
 * 内部 layering 住在 src/kojo2/，包名不出现 kojo2（用户硬指令）。 */
export { ERAFL_GAME_ADAPTER, ERAFL_GAME_FINGERPRINT } from './kojo2/index';
