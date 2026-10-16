import type * as Monaco from './entry';
import type { ErbIndex, EditorSymbolLocation } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from './erb-language';
import { wordAtColumn } from './erb-rename';
import { planDefinitionJump, toDefinitionLinks, type DefinitionModelResolver } from './kojo-definition';

/**
 * 跳到实现（R3 残项，2026-10-16 语言服务批）——`Ctrl+F12` / Peek Implementation。
 *
 * ## 数据源（零猜测）
 *
 * ERB 的"实现"只有一个可证明的答案：**本项目用户函数的定义位**（`ErbIndex.byName`，
 * `@` 行本体）。判定与重命名（`erb-rename`）同一把尺子：光标词归一化大写后
 * `byName` 命中才算数——索引里没有的名字（引擎系统函数、`$` 标签、`#DIM` 局部名、
 * 拼错词）一律"没有实现"（Monaco 会提示未找到，这是**真话**：系统函数的实现不在
 * 本项目里，我们不去猜引擎源码在哪）；索引未建 ⇒ 不应答。
 *
 * ## 交付通道（三条腿与转到定义逐字同构）
 *
 * 复用 `kojo-definition` 的分腿判据（`planDefinitionJump`）与链接构造
 * （`toDefinitionLinks`——它自带"绝不把指向未建 model 的 URI 交给 Monaco"的自证）：
 * - 全部目标有 live model ⇒ 返回真 `LocationLink[]`（`Ctrl+F12` 就地跳、Peek 有数据）；
 * - 有目标没开标签 ⇒ 发 `editor.revealLocation`（宿主既有导航通道，零新机制）；
 * - 没有定义 ⇒ 不应答。
 *
 * 与转到定义（`ui.editor.languageService` 槽）刻意**不同层**：槽是插件数据通道，而
 * "实现 = byName 定义位"的数据源是 `erb.parser` 服务本体（宿主直接拿，同 `erb-rename`
 * 的既有先例）——为一层转发去新增判别联合成员，换不来任何新数据。
 *
 * 分层照旧：`resolveImplementationTarget`（纯函数）+ `installImplementationProvider`
 * （只做 Monaco 协议翻译）。
 */

/** 名字判定的产物：命中（含原词区间与归一化名）或无（"没有实现"） */
export type ImplementationTarget =
  | { readonly kind: 'hit'; readonly normalizedName: string }
  | { readonly kind: 'miss' };

/**
 * 光标处词 → 是否有可跳的实现（**纯函数**；`column` = Monaco 1 基列）。
 *
 * 词定位复用 `erb-rename` 的 `wordAtColumn`（同一套 Unicode 记号字符集，CJK 函数名
 * 不漏）；命中判据与重命名同一条：`byName.has(归一化名)`。
 */
export function resolveImplementationTarget(
  lineText: string,
  column: number,
  byName: ReadonlyMap<string, unknown>,
): ImplementationTarget {
  const col0 = Math.min(Math.max(0, column - 1), lineText.length);
  const word = wordAtColumn(lineText, col0);
  if (!word) return { kind: 'miss' };
  const normalizedName = lineText.slice(word.start, word.end).toUpperCase();
  return byName.has(normalizedName) ? { kind: 'hit', normalizedName } : { kind: 'miss' };
}

/** 宿主注入：判活动标签、给索引、落地导航（与 definition / rename 的 handlers 同款分工） */
export interface ImplementationHandlers {
  /**
   * 该不该应答这次请求：只认**当前活动标签的真 model**。派生预览 model 的行列属于
   * 派生物（与 codeAction / 转到定义同一判据）。
   */
  canAnswer(model: Monaco.editor.ITextModel): boolean;
  /** 当前 ERB 索引（`null` = 未建 / 服务缺席；软取不抛） */
  currentIndex(): ErbIndex | null;
  /** 落地一次跳转（宿主注入；经 `editor.revealLocation` 复用既有导航通道） */
  navigate(location: EditorSymbolLocation): void;
  /** 目标路径 → 已打开标签的 live model（查不到 = 未打开） */
  openModelFor(filePath: string): Monaco.editor.ITextModel | undefined;
  /** model URI → 宿主路径（Peek 内跳转的反查；查不到交回 Monaco 缺省行为） */
  pathForUri?(uri: string): string | undefined;
}

/**
 * 为 ERB 方言注册 ImplementationProvider。多定义（重名函数）全给——Peek 列表就是
 * 那个选择器，与转到定义的取舍逐字一致（`installDefinitionProvider` 的多目标注）。
 */
export function installImplementationProvider(
  monaco: typeof Monaco,
  handlers: ImplementationHandlers,
): Monaco.IDisposable {
  const findModel: DefinitionModelResolver = (filePath) => {
    try {
      return handlers.openModelFor(filePath);
    } catch (e: unknown) {
      console.warn(
        `[erb-implementation] openModelFor('${filePath}') 抛错：${e instanceof Error ? e.message : String(e)}`,
      );
      return undefined;
    }
  };
  const provider: Monaco.languages.ImplementationProvider = {
    provideImplementation(model, position) {
      if (!handlers.canAnswer(model)) return undefined;
      let index: ErbIndex | null;
      try {
        index = handlers.currentIndex();
      } catch {
        return undefined;
      }
      if (!index) return undefined;
      const lineText = model.getLineContent(position.lineNumber);
      const target = resolveImplementationTarget(lineText, position.column, index.byName);
      if (target.kind === 'miss') return undefined; // 引擎系统函数等 ⇒ 真话："没有实现"
      const locations: EditorSymbolLocation[] = (index.byName.get(target.normalizedName) ?? []).map(
        (ref) => ({ filePath: ref.filePath, line: ref.startLine }),
      );
      const plan = planDefinitionJump(locations, findModel);
      if (plan.kind === 'none') return undefined;
      if (plan.kind === 'navigate') {
        handlers.navigate(plan.location);
        return undefined;
      }
      const word = model.getWordAtPosition(position);
      const origin: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        startColumn: word?.startColumn ?? position.column,
        endLineNumber: position.lineNumber,
        endColumn: word?.endColumn ?? position.column,
      };
      const links = toDefinitionLinks(plan.locations, findModel, origin);
      // 双保险（同 kojo-definition）：构造期 model 又少了一个 ⇒ 退事件通道，不让 Peek 哑掉
      if (links.length === 0) {
        handlers.navigate(plan.locations[0]!);
        return undefined;
      }
      return links;
    },
  };
  const sub = monaco.languages.registerImplementationProvider(ERB_LANGUAGE_ID, provider);
  return { dispose: () => sub.dispose() };
}
