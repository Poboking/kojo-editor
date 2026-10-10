/**
 * @kojo/plugin-erb-parser
 *
 * ERB 结构感知解析器（服务 `erb.parser`）。
 * 零游戏知识——命名约定与家族识别属于 game.adapter。
 */
export { createErbParserPlugin } from './plugin';
export {
  parseErbText,
  parseFunctionDefinition,
  parseParams,
  parseDimDeclaration,
  splitTopLevel,
  scanControlFlow,
} from './scanner';
