/**
 * @kojo/plugin-eraakumamaid-adapter
 *
 * eraAkumaMaid 游戏适配器。**全部 eraAkumaMaid 领域知识集中于此包**：
 * 内核与通用插件（erb-parser 等）不得包含任何 eraAkumaMaid 特有名词与约定。
 */
export { createErakumamaidAdapterPlugin } from './plugin';
export { ERAAKUMA_MAID, TRAIN_CSV } from './constants';
export {
  deriveCharaNoFromFileNames,
  parseCharaCsv,
  parseCharaNoFromFileName,
  parseKojoDirName,
} from './chara-csv';
export {
  clearKojoFamilyMemo,
  createErakumamaidFamilyIndex,
  createKojoFamilyMemo,
  kojoFamilyMemoStats,
  parseKojoFamily,
} from './family-index';
export { createErakumamaidConventions } from './conventions';
export { createErakumamaidFaceTable } from './face-templates';
export { AM_LIBRARY_FUNCTIONS, createErakumamaidLibraryTable } from './library-table';
export { AM_MUTATOR_FAMILIES, createErakumamaidMutatorTable } from './mutator-table';
export { ERAAKUMA_MAID_NAME_GLOSSARY, glossName } from './name-glossary';
export { loadErakumamaidCallProtocol, type ErakumamaidCallProtocol } from './call-protocol';
export {
  EMPTY_INSTRUCTION_TABLE,
  createErakumamaidInstructionTable,
  loadErakumamaidInstructionTable,
  parseTrainCsv,
} from './instruction-table';
export { loadErakumamaidVariableSchema } from './variable-schema';
export {
  AM_DEPLOY_ROOT,
  AM_FACE_STUB_EXT,
  AM_SCAFFOLD_FILES,
  amCharaCsvRelPath,
  buildAMFileStub,
  buildAMReadme,
  buildErakumamaidCharaCsv,
  scaffoldErakumamaidProject,
  type AMScaffoldFileSpec,
  type ErakumamaidScaffoldOptions,
} from './scaffold';
export * from './kojo2/index.js';
