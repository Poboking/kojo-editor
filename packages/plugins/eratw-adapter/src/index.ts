/**
 * @kojo/plugin-eratw-adapter
 *
 * eraTW 游戏适配器。**全部 eraTW 领域知识集中于此包**：
 * 内核与通用插件（erb-parser 等）不得包含任何 eraTW 特有名词与约定。
 */
export { createEratwAdapterPlugin } from './plugin';
export { ERATW } from './constants';
export { parseCharaCsv, parseCharaNoFromFileName, parseKojoDirName } from './chara-csv';
