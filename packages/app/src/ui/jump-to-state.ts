import type { EditorDocumentSymbol, KernelEventMap } from '@kojo/plugin-api';
import { enclosingChainAt } from '@kojo/plugin-api';
import { revealSpanOf, type RevealSpan } from '../monaco/reveal-position';

/**
 * G1「跳到命中状态」——宿主侧的**纯逻辑**（2026-10-16 批；W9 落点 span 批 2026-10-17 并轨）。
 *
 * 作者站在 `@…` 函数体内的某一行上按下列键，宿主只做三件事：
 * 位置 → 中性符号名 → 发意图事件。方向与既有那条通道正好相反
 * （矩阵/回放面板 → 编辑器早就走 `editor.revealLocation`），
 * 所以这一批**不新建第二套导航**：意图仍是 `kojo.replayFunction`，
 * 只是多带一个"要看的是哪一行"（`locate`，additive 可选成员）。
 *
 * **本文件是全仓唯一的一条"跳到一个可回放状态"的实现路径**（W9 判据③）：
 * 面板与编辑器内跳同一个状态都折到这里来（`planJumpToState` 出意图、
 * `revealSpanOf` / `clampRevealPosition` 出落点），别的模块**不许**再写一份
 * "位点 → 函数名"或"位点 → 落点"——`tests/jump-to-state.test.ts` 扫源码钉住这一点。
 *
 * 分层理由（这批的主要设计判断）：
 * - **不给回放服务加位置入口**。`StateReplayService.replayFunction` 天生按函数
 *   工作，判据来自条件索引；让它吃"文件+行"就得再持有一份"行 → 函数"的表，
 *   而那份表已经在解析器的缓冲区解析里（`documentSymbol`）——第二张表就是漂移源。
 * - **宿主不解析 ERB**。"光标在哪一段里"的数据源仍是 `ui.editor.languageService`
 *   槽的 `documentSymbol` 树（与大纲 / 吸顶 / 面包屑同一棵，第三次上岗），宿主只在
 *   这棵**中性符号树**上做"链上取最内层 function"的一步收窄（判据单源契约层
 *   `enclosingChainAt`，取层口径见 `functionNameAt`）。
 * - **零装饰**：命中/未命中这套读数回放面板早就有，宿主不再在编辑器里画第二份
 *   （因此与 `marker-pool` 的装饰调度、与 B8 CodeLens 天然无交集）。
 */

/** 契约里那位"位点"（反推真源，不另立形状）：面板与编辑器共用同一种写法 */
export type ReplayLocate = NonNullable<KernelEventMap['kojo.replayFunction']['locate']>;

/** 命令按下那一刻的位点事实（由 EditorPane 现取，不常驻监听、零闲置成本） */
export interface JumpProbeResult {
  /** 当前活动文件路径（索引/回放用的同一套路径字符串） */
  readonly path: string;
  /** 光标行（1 基，模型坐标） */
  readonly line: number;
  /**
   * 光标列（1 基）与/或选区（W9，additive 可选：探针给得出就给）。
   * 面板把这条记录拉到眼前时用的就是它——不给就退化成行首，与 `editor.revealLocation`
   * 那条腿**同一条退化判据**（`revealSpanOf`），两屏不会再落到两个地方。
   */
  readonly column?: number;
  readonly span?: RevealSpan;
  /** 该文件的符号树（`null` = 语言服务没答出来：未就绪 / 不认这种文件） */
  readonly symbols: readonly EditorDocumentSymbol[] | null;
  /** `true` = 屏幕上显示的是转出来的派生视图，行号不属于这份文件本身 */
  readonly derivedView: boolean;
}

/** 一条回放意图（宿主发给 `kojo.replayFunction` 的载荷，不含 source） */
export interface ReplayIntent {
  readonly functionName: string;
  readonly locate: ReplayLocate;
}

export type JumpPlan =
  /** 这一按没法兑现：给作者一句人话（铁律 4，按了必须有反应） */
  | { readonly kind: 'say'; readonly message: string }
  | { readonly kind: 'replay'; readonly intent: ReplayIntent };

/** 命令 id（快捷键表 / 命令面板 / 意图事件的 `source` 共用一个真源） */
export const JUMP_TO_STATE_COMMAND_ID = 'workbench.jumpToState';
/** 意图事件的发起方标记（消费方只当它是一条来源标签，不认识发起方是谁） */
export const JUMP_TO_STATE_SOURCE = 'editor.jump-to-state';

/** 位点 → 计划（纯函数，逐态可单测）。
 *
 * 措辞口径：面向作者，不出现引擎黑话；每一句都带"下一步该干什么"。
 */
export function planJumpToState(probe: JumpProbeResult | null): JumpPlan {
  if (!probe) {
    return { kind: 'say', message: '编辑器还没准备好（没打开文件就看不到状态）——先打开一份文件，把光标放到要看的那一行。' };
  }
  if (probe.derivedView) {
    return {
      kind: 'say',
      message: '现在屏幕上的是转出来的写法视图，它的行号对不上存档里的记录——先按 Ctrl+Alt+T 切回原代码，再跳到那一行看状态。',
    };
  }
  const functionName = functionNameAt(probe.symbols ?? [], probe.line);
  if (functionName === null) {
    return {
      kind: 'say',
      message: `第 ${probe.line} 行不在任何一段程序里——把光标挪到某一段的正文中（这一段的名字那一行往下、下一段的名字之前）。`,
    };
  }
  // 位点**照原样**交出去（列与区间都折成契约那一份 `span`，退化口径见 `reveal-position`）：
  // 面板拿它落点、编辑器拿它落点，两条腿在同一个函数里折，所以不可能一个落名字一个落行首。
  const span = revealSpanOf(probe);
  return {
    kind: 'replay',
    intent: {
      functionName,
      locate: {
        filePath: probe.path,
        line: probe.line,
        ...(span !== undefined ? { column: span.columnStart, span } : {}),
      },
    },
  };
}

/**
 * 光标行所属的函数名（**最内层的 function 层**；找不到 → `null`）。
 *
 * **判据不在本文件**（W7 NAV-SCOPE）：区间包含、平局折法、全树下行与面包屑 / 大纲 /
 * 调用层级读的是契约层**同一条** `enclosingChainAt`——此前这里是第四份独立实现
 * （自己扫树 + 自定平局规则），同一行四把尺子各给各的答案，现在差异只剩**取层方式**：
 * 面包屑要整条链、这里只要链上最后一个 `kind === 'function'` 且名字非空的节点。
 * "从链上再挑 function 层"而不是"整条链最内层"是刻意的：ERB 的大纲树是**平铺**的
 * （函数区间与 `#DIM` 单行声明同层并列，见 erb-parser 的 `erbDocumentSymbols`），
 * 光标落在声明行上时链尾是那枚声明——直接取链尾会给出假答案
 * "这一行不在任何函数里"（这条坑在 `tests/nav-scope-p0.test.ts` 有负自证）。
 * 宿主仍然只认契约里的中性 `kind`，零格式知识。
 */
export function functionNameAt(symbols: readonly EditorDocumentSymbol[], line: number): string | null {
  const chain = enclosingChainAt(symbols, line);
  for (let i = chain.length - 1; i >= 0; i--) {
    const symbol = chain[i]!;
    if (symbol.kind === 'function' && symbol.name.trim().length > 0) return symbol.name;
  }
  return null;
}

/** 发意图 / 说人话两个出口由调用方注入（脱离 React 可单测） */
export interface JumpSinks {
  probe(): JumpProbeResult | null;
  emit(intent: ReplayIntent): void;
  say(message: string): void;
}

/** 按一次命令：算计划 → 要么发意图，要么说一句人话。返回计划类别供调用方记数。 */
export function requestJumpToState(sinks: JumpSinks): JumpPlan['kind'] {
  const plan = planJumpToState(sinks.probe());
  if (plan.kind === 'say') sinks.say(plan.message);
  else sinks.emit(plan.intent);
  return plan.kind;
}

/* --------------------------- 位点探针的注册（模块级单源） --------------------------- */

/**
 * EditorPane 挂载时注册、卸载时清空（与 `file-history.ts` 同款：一次性注册的
 * 闭包读最新 refs，命令侧不必知道编辑器存在）。
 */
export type JumpProbe = () => JumpProbeResult | null;

let jumpProbe: JumpProbe | null = null;

export function setJumpProbe(probe: JumpProbe | null): void {
  jumpProbe = probe;
}

/** 读探针；未注册（编辑器未挂载 / 已卸载）→ `null`，由计划层回一句人话 */
export function readJumpProbe(): JumpProbeResult | null {
  return jumpProbe ? jumpProbe() : null;
}
