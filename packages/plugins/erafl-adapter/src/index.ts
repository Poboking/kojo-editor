/**
 * @kojo/plugin-erafl-adapter
 *
 * eraFL 游戏适配器。**全部 eraFL 领域知识集中于此包**：
 * 内核与通用插件（erb-parser 等）不得包含任何 eraFL 特有名词与约定。
 *
 * 导出面 = 工程识别 / 装载 + Chara 表解析 + 家族索引 + 约定规则集 + 脚手架 +
 * **2.0 适配数据**（`ERAFL_GAME_ADAPTER`，宿主组合根按 v1 gameId 登记进 2.0 登记簿，
 * 见 `bootstrap.ts` 的 `registerKojo2Adapter`）。
 * 语义层（`variableSchema` / `kojoCallProtocol` …）已由 adapter 对象自己提供，
 * 需要单独取用的只有这几块：约定规则（`createEraflConventions`，宿主可脱离
 * adapter 单跑规则）、脚手架（`scaffoldEraflKojo`，纯函数、不写盘，供向导
 * 在真正落盘前预览产物）与 2.0 数据面。
 */
export { createEraflAdapterPlugin } from './plugin';
export { ERAFL } from './constants';
export { ERAFL_GAME_ADAPTER, ERAFL_GAME_FINGERPRINT } from './kojo2';
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
export { createEraflConventions, type EraflConventionDeps } from './conventions';
export {
  EMPTY_LIBRARY_TABLE,
  ERAFL_LIBRARY_CONFLICTS,
  ERAFL_LIBRARY_FUNCTIONS,
  createEraflLibraryTable,
} from './library-table';
export {
  scaffoldEraflKojo,
  type EraflKojoScaffoldInput,
  type EraflKojoScaffoldResult,
} from './scaffold';
