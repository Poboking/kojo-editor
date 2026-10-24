/**
 * @kojo/plugin-erakoumakan-adapter
 *
 * era紅魔館 游戏适配器。**全部 era紅魔館 领域知识集中于此包**：
 * 内核与通用插件（erb-parser 等）不得包含任何 era紅魔館 特有名词与约定。
 *
 * 导出面 = 工程识别 / 装载 + Chara 表解析 + 家族索引 + 约定规则集 +
 * 变量字典 / 指令表装载 + 展示位（名字对照 / 剧情线）+ 时机分野模板。
 * 本版**不提供** 2.0 adapter（宿主按「该游戏没有 2.0 面」走 null 语义：
 * 零候选、不抛、绝不借 eraTW 的事实）。
 */
export { createKoumakanAdapterPlugin } from './plugin';
export { ERAKOUMAKAN } from './constants';
export {
  charaNameFromFileName,
  parseCharaCsv,
  parseCharaNoFromFileName,
  parseKojoDirName,
  type ParsedCharaCsv,
} from './chara-csv';
export {
  ERAKOUMAKAN_FACE_LABELS,
  createKoumakanFamilyIndex,
  parseKojoFamily,
} from './family-index';
export { createKoumakanConventions } from './conventions';
export {
  loadKoumakanInstructionNames,
  loadKoumakanVariableSchema,
  mergeNameTable,
  parseErhDeclarations,
  parseNameTableCsv,
} from './variable-schema';
export { ERAKOUMAKAN_NAME_GLOSSARY } from './name-glossary';
export { ERAKOUMAKAN_STATE_LINES } from './state-lines';
export { createKoumakanFaceTable } from './face-templates';
