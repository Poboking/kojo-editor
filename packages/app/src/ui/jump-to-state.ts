import type { EditorDocumentSymbol } from '@kojo/plugin-api';

/**
 * G1「跳到命中状态」——宿主侧的**纯逻辑**（2026-10-16 批）。
 *
 * 作者站在 `@…` 函数体内的某一行上按下列键，宿主只做三件事：
 * 位置 → 中性符号名 → 发意图事件。方向与既有那条通道正好相反
 * （矩阵/回放面板 → 编辑器早就走 `editor.revealLocation`），
 * 所以这一批**不新建第二套导航**：意图仍是 `kojo.replayFunction`，
 * 只是多带一个"要看的是哪一行"（`locate`，additive 可选成员）。
 *
 * 分层理由（这批的主要设计判断）：
 * - **不给回放服务加位置入口**。`StateReplayService.replayFunction` 天生按函数
 *   工作，判据来自条件索引；让它吃"文件+行"就得再持有一份"行 → 函数"的表，
 *   而那份表已经在解析器的缓冲区解析里（`documentSymbol`）——第二张表就是漂移源。
 * - **宿主不解析 ERB**。"光标在哪一段里"的数据源仍是 `ui.editor.languageService`
 *   槽的 `documentSymbol` 树（与大纲 / 吸顶 / 面包屑同一棵，第三次上岗），宿主只在
 *   这棵**中性符号树**上做"区间包含 + 取最紧一层"的两行折衷（判据与理由见
 *   `functionNameAt`——那里记着为什么不能直接借道面包屑的 `symbolChainAt`）。
 * - **零装饰**：命中/未命中这套读数回放面板早就有，宿主不再在编辑器里画第二份
 *   （因此与 `marker-pool` 的装饰调度、与 B8 CodeLens 天然无交集）。
 */

/** 命令按下那一刻的位点事实（由 EditorPane 现取，不常驻监听、零闲置成本） */
export interface JumpProbeResult {
  /** 当前活动文件路径（索引/回放用的同一套路径字符串） */
  readonly path: string;
  /** 光标行（1 基，模型坐标） */
  readonly line: number;
  /** 该文件的符号树（`null` = 语言服务没答出来：未就绪 / 不认这种文件） */
  readonly symbols: readonly EditorDocumentSymbol[] | null;
  /** `true` = 屏幕上显示的是转出来的派生视图，行号不属于这份文件本身 */
  readonly derivedView: boolean;
}

/** 一条回放意图（宿主发给 `kojo.replayFunction` 的载荷，不含 source） */
export interface ReplayIntent {
  readonly functionName: string;
  readonly locate: { readonly filePath: string; readonly line: number };
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
  return { kind: 'replay', intent: { functionName, locate: { filePath: probe.path, line: probe.line } } };
}

/**
 * 光标行所属的函数名（**最紧**的那一层 function；找不到 → `null`）。
 *
 * 为什么不是直接复用面包屑的 `symbolChainAt`（同一棵树的另一位消费者）：
 * 那条判据是"每层只留区间最小的一枚再下钻"，而 ERB 的大纲树是**平铺**的
 * （函数区间与 `#DIM` 单行声明同层并列，见 erb-parser 的 `erbDocumentSymbols`）。
 * 光标正好落在声明行上时，链条里只剩那枚声明、外层函数被同层淘汰掉了 ⇒
 * "这一行不在任何函数里"会是个**假答案**。所以这里自己做一次全树下行：
 * 收集**所有**包住这一行的 function 层，取区间最紧的一枚（同宽取靠后的，
 * 再同取文档序第一枚 = 确定性）。宿主仍然只认契约里的中性 `kind`，零格式知识。
 */
export function functionNameAt(symbols: readonly EditorDocumentSymbol[], line: number): string | null {
  const hits: EditorDocumentSymbol[] = [];
  const walk = (list: readonly EditorDocumentSymbol[]): void => {
    for (const symbol of list) {
      if (symbol.startLine > line || line > symbol.endLine) continue;
      if (symbol.kind === 'function' && symbol.name.trim().length > 0) hits.push(symbol);
      if (symbol.children) walk(symbol.children);
    }
  };
  walk(symbols);
  let best: EditorDocumentSymbol | undefined;
  const span = (s: EditorDocumentSymbol): number => s.endLine - s.startLine;
  for (const hit of hits) {
    if (!best) {
      best = hit;
      continue;
    }
    // 区间更紧者胜；同宽时靠后的定义胜（嵌套同名块少见，取最内层）；再同保持文档序第一枚
    if (span(hit) < span(best) || (span(hit) === span(best) && hit.startLine > best.startLine)) best = hit;
  }
  return best ? best.name : null;
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
