import type {
  EditorLanguageServiceContribution,
  EditorWorkspaceSymbol,
  GameProject,
} from '@kojo/plugin-api';
import { splitPath } from './path-label';

/**
 * 工作区符号搜索（D2，2026-10-15）的**宿主侧纯逻辑**——对标 VSCode 的 `Ctrl+T`。
 *
 * 抽出来的理由与 `commands.ts` 的 `filterFileCandidates` 同一口径：**查询与排序是数据
 * 判据，不是渲染细节**，只有脱离 React 才钉得住（渲染层在 node 环境跑不了）。
 *
 * 分层纪律：宿主**不认识**这些符号是什么语言结构、也不认识它们从哪个索引来——
 * 候选一律来自 `ui.editor.languageService` 槽的 `workspaceSymbol` 应答方
 * （ERB 侧由解析器答，实现见 `erb-parser/workspace-symbols.ts`），宿主只做三件事：
 * 问（`collectWorkspaceSymbols`）、排（`pickWorkspaceSymbols`）、说清为什么没有
 * （`workspaceSymbolNotice`）。跳转走既有 `editor.revealLocation`，不新造机制。
 */

/**
 * 一次查询的**渲染预算**（条）。
 *
 * 为什么是 100 而不是"全部"：语料 99,104 个函数，一屏灌十万行 DOM 会把面板打死；
 * 而**上限不等于丢弃**——被预算挡掉的条数由 `hidden` 原样报给作者在面板里看（铁律 4）。
 * 提供方侧另有一层 `limit`（默认 200）先兜住对象分配，两层各司其职：
 * 那层省内存，这层省 DOM。
 */
export const WORKSPACE_SYMBOL_RENDER_LIMIT = 100;

/** 一次查询从各应答方合并到的候选（`totalMatched` = 各家命中总数之和，可大于 `symbols.length`） */
export interface WorkspaceSymbolCollection {
  readonly symbols: readonly EditorWorkspaceSymbol[];
  readonly totalMatched: number;
}

const NO_SYMBOLS: WorkspaceSymbolCollection = { symbols: [], totalMatched: 0 };

/** 去重键（同一处定义被两个应答方同时给出时只留一条；口径与 `collectDefinitionLocations` 一致） */
function symbolKey(s: EditorWorkspaceSymbol): string {
  return `${s.name}\u0000${s.filePath}\u0000${s.line}`;
}

/**
 * 按槽序问齐全部 `workspaceSymbol` 应答方并合并候选（**纯函数**，可单测）。
 *
 * 三态语义（契约 `EditorLanguageServiceContribution`）在这里的落地：
 * - `undefined` = 该方不答这个查询（没索引 / 不是它的名录）→ **跳过**，不产生"没有结果"的假象；
 * - `symbols: []` = 它认得这个查询但一条没命中 → 同样不加东西（多家合并无法区分，
 *   "到底为什么没有" 由 `workspaceSymbolNotice` 按宿主已知的事实说）；
 * - 抛错 = 单个应答方故障**不影响其余**（隔离记日志，能力不退化成整条搜索消失）。
 *
 * 空 / 全空白查询不发问：那时要的是"提示作者先打字"，不是十万条名字。
 */
export function collectWorkspaceSymbols(
  contributions: readonly EditorLanguageServiceContribution[],
  args: {
    query: string;
    project: GameProject | null;
    limit?: number;
  },
): WorkspaceSymbolCollection {
  const query = args.query.trim();
  if (query.length === 0) return NO_SYMBOLS;

  const out: EditorWorkspaceSymbol[] = [];
  const seen = new Set<string>();
  let totalMatched = 0;
  for (const contribution of contributions) {
    let result: ReturnType<EditorLanguageServiceContribution['provide']>;
    try {
      result = contribution.provide({
        kind: 'workspaceSymbol',
        query: args.query,
        project: args.project,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
    } catch (e: unknown) {
      console.warn(
        `[workspace-symbols] '${contribution.id}' provide 抛错：${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    if (!result || result.kind !== 'workspaceSymbol') continue;
    for (const symbol of result.symbols) {
      const key = symbolKey(symbol);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(symbol);
    }
    // 提供方没给总数时按"它给了多少就是多少"计（保守：不虚报溢出）
    totalMatched += result.totalMatched ?? result.symbols.length;
  }
  return { symbols: out, totalMatched };
}

/** 排名桶（小者靠前）：精确名 → 前缀名 → 名含子串 → 只有路径含子串 */
function symbolRank(lowerName: string, lowerPath: string, q: string): number {
  if (lowerName === q) return 0;
  if (lowerName.startsWith(q)) return 1;
  if (lowerName.includes(q)) return 2;
  if (lowerPath.includes(q)) return 3;
  return 4;
}

/**
 * 排序 + 截断（**纯函数**；照 `filterFileCandidates` 的口径：**名字命中优先于路径命中**）。
 *
 * - 大小写不敏感（比较前两侧都 `toLowerCase()`；中文函数名不受影响，与原生大写名同一条路）；
 * - **只排名、不再过滤一次**：候选合不合查询是**应答方**的口径（它可能是子串、也可能是
 *   将来的拼音/模糊命中），宿主拿自己的子串判据二次筛等于抄第二份口径——被偷偷滤掉的那条
 *   就是"明明有却说没有"的成因。认不出的候选排到最后，不删；
 * - 同桶内**保持入参顺序**（提供方已给确定序，宿主不再按名字重排——否则"同一个查询两次
 *   点出不同顺序"这种鬼故事就是这么来的）；
 * - `hidden` = 被预算挡掉的条数（含提供方侧就截断的部分），渲染层据此显示溢出提示。
 */
export function pickWorkspaceSymbols(
  collected: WorkspaceSymbolCollection,
  query: string,
  cap: number = WORKSPACE_SYMBOL_RENDER_LIMIT,
): { items: readonly EditorWorkspaceSymbol[]; hidden: number } {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return { items: [], hidden: 0 };
  const ranked = collected.symbols
    .map((symbol, i) => ({
      symbol,
      i,
      rank: symbolRank(symbol.name.toLowerCase(), symbol.filePath.toLowerCase(), q),
    }))
    // 先按桶、再按入参序（`Array#sort` 在现代引擎稳定，但这里不依赖实现：显式比 `i`）
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.i - b.i));
  const budget = Number.isFinite(cap) && cap > 0 ? Math.trunc(cap) : WORKSPACE_SYMBOL_RENDER_LIMIT;
  const items = ranked.slice(0, budget).map((r) => r.symbol);
  return { items, hidden: Math.max(0, collected.totalMatched - items.length) };
}

/** 溢出提示（`hidden` = 0 时不给；提供方没报总数时不编数字） */
export function workspaceSymbolOverflowText(hidden: number): string | null {
  if (hidden <= 0) return null;
  return `另有 ${hidden} 条未列出——继续输入可缩小范围`;
}

/** 面板可用的"为什么没有结果"事实（宿主已知，零业务知识） */
export interface WorkspaceSymbolAvailability {
  /** 是否打开了项目（`commandCtx.project`） */
  readonly hasProject: boolean;
  /** 索引正在构建 */
  readonly indexing: boolean;
  /** 索引构建失败的原因（状态栏同源） */
  readonly indexError: string | null;
  /** 已索引文件数（0 = 名录还是空的） */
  readonly fileCount: number;
  /** 当前查询串 */
  readonly query: string;
}

/**
 * 空结果的**可见原因**（铁律 4「内核不静默」在 UI 侧的那一半）。
 *
 * 判据次序是有意的：**先说环境、再说查询**。没开项目时回答"无匹配符号"等于把
 * "根本没有名录"伪装成"你的名字起错了"；作者按了快捷键却看见一句和查询无关的话，
 * 才不会以为功能坏了。
 */
export function workspaceSymbolNotice(a: WorkspaceSymbolAvailability): string {
  if (!a.hasProject) return '未打开项目，没有可搜索的工作区符号';
  if (a.indexError) return `索引不可用：${a.indexError}`;
  if (a.indexing) return '索引构建中，稍候即可搜索函数名';
  if (a.fileCount === 0) return '当前项目还没有可用的函数索引';
  if (a.query.trim().length === 0) return '输入函数名以搜索（中文名与原生大写名都可）';
  return '无匹配符号';
}

/** 一行候选的呈现形状（`Picker` 的条目字段；抽出来才钉得住"副行到底是哪个目录"这条判据） */
export interface SymbolPickerItem {
  readonly key: string;
  readonly primary: string;
  readonly secondaryDir?: string;
  readonly hint?: string;
  readonly title?: string;
}

/** 一行的稳定身份（选中回传时按它找回符号；`Picker` 的 `key` 与回查用同一个真源） */
export function symbolPickerKey(s: EditorWorkspaceSymbol): string {
  return `${s.filePath}\u0000${s.line}\u0000${s.name}`;
}

/**
 * 符号 → `Picker` 条目（纯映射，`Palette.tsx` 只做渲染）。
 *
 * 三段各自的职责（同名多定义**并列**时靠这三段区分，一条都不能少）：
 * - `primary` = 符号名（作者搜的就是它）；
 * - `secondaryDir` = 所在**目录**，沿用 `Picker` 现成的"目录两段渲染"（前缀可缩、
 *   最深一层恒显——被裁掉的恰好是包名，见 `path-label.ts`）；
 * - `hint` = 行号；`title` = 完整 `文件:行`（悬停即得全路径，窄面板不靠它区分）。
 */
export function symbolPickerItems(items: readonly EditorWorkspaceSymbol[]): SymbolPickerItem[] {
  return items.map((s) => {
    const { dir } = splitPath(s.filePath);
    return {
      key: symbolPickerKey(s),
      primary: s.name,
      ...(dir !== '' ? { secondaryDir: dir } : {}),
      hint: `:${s.line}`,
      title: `${s.filePath}:${s.line}`,
    };
  });
}
