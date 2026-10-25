/**
 * @kojo/plugin-erasqc-adapter
 *
 * eraSQC（eraSQN 中文汉化魔改版）游戏适配器。**全部 eraSQC 领域知识集中于此包**：
 * 内核与通用插件（erb-parser 等）不得包含任何 eraSQC 特有名词与约定。
 *
 * 导出面 = 工程识别 / 装载 + Chara CSV / 口上文件名解析 + 家族索引 + 约定规则集 +
 * 变量字典 / 指令表装载 + 时机分野模板 + 剧情线预设 + 2.0 语言事实面（kojo2）。
 * 2.0 面由宿主组合根按清单 `kojo2AdapterExport` 懒登记（键 = v1 `gameId`）；
 * 本包**不建 backend**（发射面是下一批的事）。
 */
export { createErasqcAdapterPlugin } from './plugin';
export { ERASQC, TRAIN_CSV } from './constants';
export {
  fallbackCharaName,
  parseCharaCsv,
  parseCharaNoFromFileName,
  parseKojoFileName,
  type ParsedCharaCsv,
} from './chara-csv';
export {
  ERASQC_FACE_LABELS,
  createErasqcFamilyIndex,
  parseKojoFamily,
} from './family-index';
export { createErasqcConventions, RULE_CHARA_MISMATCH } from './conventions';
export { createErasqcFaceTable } from './face-templates';
export { ERASQC_STATE_LINES } from './state-lines';
export {
  loadErasqcInstructionNames,
  loadErasqcVariableSchema,
  mergeNameTable,
  parseErhDeclarations,
  parseNameTableCsv,
} from './variable-schema';
// 2.0 语言事实面（纯数据、零 IO；adapter-only，无 backend）
export * from './kojo2/index.js';
