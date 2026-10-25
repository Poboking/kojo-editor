/**
 * @kojo/plugin-eratohok-adapter
 *
 * eratohoK 游戏适配器。**全部 eratohoK 领域知识集中于此包**：
 * 内核与通用插件（erb-parser 等）不得包含任何 eratohoK 特有名词与约定。
 *
 * 导出面 = 工程识别 / 装载 + Chara 表解析 + 家族索引 + 约定规则集 +
 * 变量字典 / 指令表装载 + 剧情线预设 + 时机分野模板 + 2.0 语言事实面（kojo2）。
 * 2.0 面由宿主组合根按清单 `kojo2AdapterExport` 懒登记（键 = v1 `gameId`）；
 * 本包**不建 backend**（发射面是下一批的事）。
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
// 2.0 语言事实面（纯数据、零 IO；adapter-only，无 backend）
export * from './kojo2/index.js';
