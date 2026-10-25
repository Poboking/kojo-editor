/**
 * @kojo/plugin-eratohok-adapter
 *
 * eratohoK 游戏适配器。**全部 eratohoK 领域知识集中于此包**：
 * 内核与通用插件（erb-parser 等）不得包含任何 eratohoK 特有名词与约定。
 *
 * 导出面 = 工程识别 / 装载 + Chara 表解析 + 家族索引 + 约定规则集 +
 * 变量字典 / 指令表装载 + 剧情线预设 + 时机分野模板。
 * 本版**不提供** 2.0 adapter（宿主按「该游戏没有 2.0 面」走 null 语义：
 * 零候选、不抛、绝不借 eraTW 的事实）。
 */
export { createTohokAdapterPlugin } from './plugin';
export { ERATOHOK, TRAIN_CSV } from './constants';
export {
  charaNameFromFileName,
  characterNoOfFunction,
  parseCharaCsv,
  parseCharaNoFromFileName,
  parseKojoDirName,
  type ParsedCharaCsv,
} from './chara-csv';
export {
  ERATOHOK_FACE_LABELS,
  createTohokFamilyIndex,
  parseKojoFamily,
} from './family-index';
export { createTohokConventions } from './conventions';
export {
  loadTohokInstructionNames,
  loadTohokVariableSchema,
  mergeNameTable,
  parseErhDeclarations,
  parseNameTableCsv,
} from './variable-schema';
export { ERATOHOK_STATE_LINES } from './state-lines';
export { createTohokFaceTable } from './face-templates';
