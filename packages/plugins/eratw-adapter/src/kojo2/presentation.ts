/**
 * eraTW 2.0 演出面（游戏事实 —— 只住本包）。
 *
 * 权威依据：设计稿 §4.8（`(心形)`）、§8.2（`@着色`）、§8.3（`@颜绘`）、§7.5（`选项`）
 * 与附录 B.4。core 只认"声明了哪些演出面"，具体引擎指令名一律查本表。
 *
 * 这里**不重抄第二份词表**：能在既有库表里查到的引擎函数名，运行时从
 * `ERATW_LIBRARY_FUNCTIONS` 取（心形 → HPH_PRINT、显示表情 → PRINT_FACE），
 * 查不到就在模块装载时报错（fail-closed，绝不静默降级）。
 */
import type { AdapterPresentation } from '../../../../kojo-core/src/adapter.js';
import { ERATW_LIBRARY_FUNCTIONS } from '../library-table.js';
import { ERATW_PROFILE } from './profile.js';

/** 从既有库表取引擎函数名；缺条目 = adapter 数据坏了，装载期直接抛（不静默） */
function engineOf(libraryName: string): string {
  const engine = ERATW_LIBRARY_FUNCTIONS.get(libraryName);
  if (engine === undefined) {
    throw new Error(`eraTW 库函数表缺少“${libraryName}”：presentation 无法派生引擎指令`);
  }
  return engine;
}

/**
 * `(心形)` → `HPH_PRINT(@"…", "<模式>")`。
 * 模式四象限（原型语料实证，v1 tutorial-reference-lines 同口径）：
 * - 台词：等待 `w` / `续` `l`；
 * - 旁白：等待 `dw` / `续` `dl`。
 */
const HEART = Object.freeze({
  engine: engineOf('心形'),
  dialogue: Object.freeze({ wait: 'w' as const, continue: 'l' as const }),
  narration: Object.freeze({ wait: 'dw' as const, continue: 'dl' as const }),
});

/** `@着色 0xRRGGBB` → `SETCOLOR` … `RESETCOLOR`（配对由 core 自动补，作者不手写） */
const COLOR = Object.freeze({
  setColor: 'SETCOLOR',
  resetColor: 'RESETCOLOR',
  hexPrefix: '0x',
});

/**
 * `@颜绘` → `CALL PRINT_FACE, TARGET, …` / `CALL PRINT_FACE_PLAYER, MASTER, …`。
 * `PRINT_FACE` 从库表派生；`PRINT_FACE_PLAYER` 是 2.0 新增玩家立绘面（库表未收，
 * 引擎事实来自设计稿 §8.3），故在此显式登记。默认表情 `通常` 由 adapter 补齐
 * （`PRINT_FACE_PLAYER` 不依赖引擎默认）。
 */
const FACE = Object.freeze({
  defaultExpression: '通常',
  calls: Object.freeze([
    Object.freeze({ object: 'me' as const, call: engineOf('显示表情'), receiverArg: 'TARGET' }),
    Object.freeze({ object: 'you' as const, call: 'PRINT_FACE_PLAYER', receiverArg: 'MASTER' }),
  ]),
  maxArgs: 4,
  placeholder: '""',
});

/** `选项`：2.0 待定 UI；落点 = PRINTBUTTON + INPUTS，单场景最多一个（§7.5） */
const OPTIONS = Object.freeze({
  status: 'pending' as const,
  button: 'PRINTBUTTON',
  input: 'INPUTS',
  // Emuera 按钮输入的读回槽（引擎约定）；落点关键词由这份数据给，backend 不写死
  result: 'RESULTS',
  maxPerScene: 1,
});

/** eraTW 演出面：四项全声明（未声明的面 core 会按 §10.10 报"当前 adapter 不支持"） */
export const ERATW_PRESENTATION: AdapterPresentation = Object.freeze({
  heart: HEART,
  color: COLOR,
  face: FACE,
  options: OPTIONS,
});

/* ============================== `# 池` 等值分派落点数据 ============================== */

/**
 * `# 池` 可证等值时的块形状（引擎块关键字 + 排版事实）：**只住数据，emitter 不写死**。
 *
 * `style` 是 adapter 缺省落点（`ERATW_PROFILE.poolStyle`，eraTW = `if`）：`selectcase`
 * 不是 profile 开关，而是编译器在**等值可证**时的优化（§7.1 / §10.2），所以 emitter
 * 只按 core 的计划落块，不按 `style` 自行决定。
 */
export interface PoolDispatchPresentation {
  /** adapter 缺省落点（core 决定是否优化；`selectcase` 只是等值优化） */
  readonly style: 'if' | 'selectcase';
  /** 块头（主语槽跟在后面） */
  readonly selectCase: string;
  /** 一档（整数跟在后面） */
  readonly case: string;
  /** 兜底档（不带值；池的 `? 否` 必填，恒生成） */
  readonly caseElse: string;
  /** 块尾 */
  readonly endSelect: string;
  /** 一级缩进（档头一层、档内正文再一层） */
  readonly indent: string;
}

/** eraTW 的池等值分派块数据（module 装载时冻结一次） */
export const ERATW_POOL_DISPATCH: PoolDispatchPresentation = Object.freeze({
  style: ERATW_PROFILE.poolStyle,
  selectCase: 'SELECTCASE',
  case: 'CASE',
  caseElse: 'CASE ELSE',
  endSelect: 'ENDSELECT',
  indent: '    ',
});
