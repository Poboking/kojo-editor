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
// D2 批：家族头中文别名表（additive；糖层的写侧/投影侧消费走契约方法 `familyAlias` /
// `familyAliasReverse`，此处导出纯数据表供**测试**零漂移引用真表，杜绝手抄镜像副本）
export { FAMILY_ALIASES, FAMILY_ALIASES_REVERSE } from './variable-schema';
// 1016 批：数值增减族表（additive；族头 → 目标函数 + 参数序，同形 seam：adapter 建表、糖层只查）
export { EMPTY_MUTATOR_TABLE, createEratwMutatorTable, ERATW_MUTATOR_FAMILIES } from './mutator-table';
// 1016 批：计数器值域表（additive；编号 ↔ 中文名，同形 seam：adapter 建表、糖层只查）
export {
  EMPTY_COUNTER_TABLE,
  createEratwCounterTable,
  ERATW_COUNTER_ENTRIES,
  type EratwCounterEntry,
} from './counter-table';
// C3 批（1016 独占追加区块；勿在他处重排）：检索范围提供方——判据（角色→目录）只住本包，
// 宿主全文检索只消费「标签 + 检索根」两样泛型事实。导出纯函数供单测直接钉判据。
export { charaSearchScopeOptions } from './search-scope';
