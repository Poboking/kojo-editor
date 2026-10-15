/**
 * @kojo/plugin-eratw-adapter
 *
 * eraTW 游戏适配器。**全部 eraTW 领域知识集中于此包**：
 * 内核与通用插件（erb-parser 等）不得包含任何 eraTW 特有名词与约定。
 */
export { createEratwAdapterPlugin } from './plugin';
export { ERATW } from './constants';
export { parseCharaCsv, parseCharaNoFromFileName, parseKojoDirName } from './chara-csv';
export {
  clearKojoFamilyMemo,
  createEratwFamilyIndex,
  createKojoFamilyMemo,
  kojoFamilyMemoStats,
  parseKojoFamily,
} from './family-index';
export { createEratwConventions } from './conventions';
export { createEratwFaceTable } from './face-templates';
export { ERATW_NAME_GLOSSARY, glossName } from './name-glossary';
export { loadEratwCallProtocol } from './call-protocol';
// P-5 批：指令表**解析层**对外暴露（additive；测试侧以真解析器 + 真 CSV 行建表，
// 不再各自镜像抄写解析铁律——镜像副本正是 PITFALLS 点名的"形状不同构=空断言"隐患）。
export {
  EMPTY_INSTRUCTION_TABLE,
  createEratwInstructionTable,
  loadEratwInstructionTable,
  parseTrainCsv,
} from './instruction-table';
// ZH-F1 批：基础库 / 常用函数名表（additive；与指令表同形——adapter 建纯数据表，糖层只查）
export { EMPTY_LIBRARY_TABLE, createEratwLibraryTable, ERATW_LIBRARY_FUNCTIONS } from './library-table';
