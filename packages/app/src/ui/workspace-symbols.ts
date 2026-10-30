import type {
  EditorLanguageServiceContribution,
  EditorProjectFile,
  EditorWorkspaceSymbol,
  GameProject,
  ErbIndexState,
  ErbScopeStamp,
} from '@kojo/plugin-api';
import {
  errorText,
  CANDIDATE_BUDGETS,
  SCOPED_QUERY_FACTOR,
  candidateBudget,
  candidateRank,
  filterByScope,
  pathKey,
  resolveSugarTarget,
} from '@kojo/plugin-api';
import { splitPath } from './path-label';
import { activeNavScope } from './search-scope';
import { workspaceSymbolIndexCopy } from './index-state-copy';

/**
 * 工作区符号搜索（D2，2026-10-15）的**宿主侧纯逻辑**——对标 VSCode 的 `Ctrl+T`。
 *
 * 抽出来的理由与 `palette-search.ts` 的 `rankFiles` 同一口径：**查询与排序是数据
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
 * 提供方侧另有一层 `limit`（`CANDIDATE_BUDGETS.providerQuery`）先兜住对象分配，两层各司其职：
 * 那层省内存，这层省 DOM。
 *
 * 数字本身**不写在这里**：档位表 `CANDIDATE_BUDGETS` 在契约层一处（四通道同读一张表，
 * 谁是谁的上一档从此有据可查）。
 */
export const WORKSPACE_SYMBOL_RENDER_LIMIT = CANDIDATE_BUDGETS.render;

/**
 * 一次查询从各应答方合并到的候选。
 *
 * `totalMatched` = 各家命中总数之和，**减去被糖线并掉的重复报数**（同一函数在源与
 * 产物里各报一次 = 一个符号），故恒 ≥ `symbols.length`、且可大于它（提供方截断）。
 */
export interface WorkspaceSymbolCollection {
  readonly symbols: readonly EditorWorkspaceSymbol[];
  readonly totalMatched: number;
  /**
   * 本次合并**实际按哪个范围**收窄（W7 NAV-SCOPE；`null` = 不限）。
   * 面板据此能说"这轮只看了哪一处"，与全文检索那条 `appliedScope` 同一个形态。
   */
  readonly scope?: ErbScopeStamp | null;
  /**
   * 因为落在范围外而被丢掉的条数（提供方**没有**按范围过滤时的兜底账；
   * 0 = 没丢过或提供方已经按同一个戳自己滤过了）。
   */
  readonly droppedOutOfScope?: number;
}

const NO_SYMBOLS: WorkspaceSymbolCollection = { symbols: [], totalMatched: 0, scope: null, droppedOutOfScope: 0 };

/* ------------------- 项目文件快照（ERB-PARITY G4，additive） ------------------- */

/**
 * 一次查询随请求递下去的**项目文件快照**（形状与宿主既有的事实同源：文件列表 + 是否完整）。
 *
 * 为什么放在这里而不是让 `workspace-symbols.ts` 自己 import 2.0 项目索引：本文件在**开机图**里
 * （`ShellLayout` 静态 import），索引那一链（`monaco/kojo2-project-index` → 语言面）在懒边上；
 * 直接 import 会把整条链拖上首屏（PS-10）。
 */
export interface WorkspaceSymbolProjectFiles {
  readonly files: readonly EditorProjectFile[];
  readonly complete: boolean;
}

/** 快照来源（编辑器装配层注册；返回 `undefined` = 这轮没有快照） */
export type WorkspaceSymbolProjectFilesSource = () => WorkspaceSymbolProjectFiles | undefined;

let projectFilesSource: WorkspaceSymbolProjectFilesSource | null = null;

/**
 * 注册唯一的快照来源（装配层调一次；后装覆盖先装，传 `null` = 撤掉）。
 *
 * 判据仍然只有一份：本文件只把文件**当数据**递进请求，不解释哪门语言要它——要它的供方
 * 自己按路径认领（2.0 的供方 `kojo2-workspaceSymbols`），不要它的供方（ERB 的索引自持）
 * 一个字段都不读。没注册来源 ⇒ 请求里不出现 `projectFiles`，行为与加这一格之前逐字相同。
 */
export function installWorkspaceSymbolProjectFilesSource(
  source: WorkspaceSymbolProjectFilesSource | null,
): void {
  projectFilesSource = source;
}

/** 现取一份快照（来源抛错按"没有快照"处理：检索的面不该因取数失败而消失） */
function currentProjectFiles(): WorkspaceSymbolProjectFiles | undefined {
  try {
    return projectFilesSource?.() ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 带范围时向提供方多要几档（`SCOPED_QUERY_FACTOR`）：宿主这一层的过滤发生在
 * 提供方**已经按预算截断**之后，仍按原预算问就等于让范围外的那批占掉名额——
 * 范围内该出现的候选会被静默挤掉，读数上却仍是"没有更多了"。
 */
function providerLimitFor(requested: number | undefined, scoped: boolean): number | undefined {
  if (requested === undefined) return undefined;
  const base = candidateBudget('providerQuery', requested);
  return scoped ? Math.min(base * SCOPED_QUERY_FACTOR, CANDIDATE_BUDGETS.ceiling) : base;
}

/**
 * 符号的**身份路径**——去重键的坐标系（W6 之后同一函数会从两个坐标系各来一次）。
 *
 * 病根：ERB 线说的是**产物**（`M.ERB`），糖线说的是作者能改的**源**（`M.kojo`），
 * 键里带 `filePath` ⇒ 天然两行。判据只有一条、且住在契约层：`resolveSugarTarget`
 * （"`.kojo` 源 → 同目录同基名 `.ERB` 产物"的唯一真源，本文件零扩展名正则）。
 *
 * - `.kojo` 源 ⇒ 身份 = 它的产物路径；
 * - 本批里**确有源指向**的产物路径 ⇒ 身份 = 自身（只认本批出现过的源；否则两个
 *   无关的同名文件会因"长得像产物"被误并）；
 * - 其余（非方言路径 / 推不出目标）⇒ `null` = 退回旧键，W6 之前的输出逐字不变。
 */
function sugarIdentityPath(
  target: string | null,
  filePath: string,
  productKeys: ReadonlySet<string>,
): string | null {
  if (target !== null) return pathKey(target);
  if (productKeys.size === 0) return null; // 本批没有源：连 pathKey 都不付（十万条那一趟）
  const own = pathKey(filePath);
  return productKeys.has(own) ? own : null;
}

interface SymbolDedupe {
  readonly symbols: readonly EditorWorkspaceSymbol[];
  /** 被糖线并掉（产物 → 源）的条数：`totalMatched` 必须如实扣回 */
  readonly sugarMerged: number;
}

/**
 * 合并同一符号的两种坐标系（**纯函数**）。
 *
 * 优先级：**源胜产物**——`Ctrl+T` 点开的那条要落在作者能改的文件上；先到的那条
 * 决定可见位置（顺序稳定，不与提供方给的序打架）。键 = `name + 身份路径`，**不含行号**：
 * 同一函数在源与产物里的行号本来就不同，带行号就永远并不上。
 *
 * `sugarMerged` 只数**跨坐标系**并掉的那条：同坐标系的重复（两家给了同一条）沿用
 * W6 之前的旧口径（只留一条、总数不扣）——那条纪律一变，既有读数全变。
 */
function dedupeWorkspaceSymbols(all: readonly EditorWorkspaceSymbol[]): SymbolDedupe {
  const productKeys = new Set<string>();
  for (const s of all) {
    const target = resolveSugarTarget(s.filePath);
    if (target !== null) productKeys.add(pathKey(target));
  }
  const symbols: EditorWorkspaceSymbol[] = [];
  const seenKey = new Map<string, number>();
  const keptSource: boolean[] = [];
  let sugarMerged = 0;
  for (const s of all) {
    const target = resolveSugarTarget(s.filePath);
    const isSource = target !== null;
    const identity = sugarIdentityPath(target, s.filePath, productKeys);
    // 两段键（糖身份）/ 三段键（旧口径）形态不同，不会互相撞
    const key = identity === null ? `${s.name}\u0000${s.filePath}\u0000${s.line}` : `${s.name}\u0000${identity}`;
    const at = seenKey.get(key);
    if (at === undefined) {
      seenKey.set(key, symbols.length);
      symbols.push(s);
      keptSource.push(isSource);
      continue;
    }
    if (isSource && !keptSource[at]) {
      symbols[at] = s; // 产物先到、源后到：源顶掉它，位置不变
      keptSource[at] = true;
      sugarMerged += 1;
    } else if (isSource !== keptSource[at]) {
      sugarMerged += 1; // 源已在位，这条产物就是被并掉的那条
    }
    // 同坐标系重复（两家给了同一条 / 同一文件重名）：只留先到的那条，旧口径
  }
  return { symbols, sugarMerged };
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
 *
 * 合并口径：W6 之后同一函数会从两个坐标系各来一次（ERB 线报产物、糖线报源），去重键
 * 是**符号身份** `name + 身份路径`（见 `dedupeWorkspaceSymbols`），只留源那一条。
 *
 * `scope`（W7 NAV-SCOPE，**additive 可选**）：当前"只看"范围。**不传 ⇒ 读唯一状态源**
 * `activeNavScope()`——这是"选定范围后 `Ctrl+T` 也只看这一处"的接线方式：调用方
 * （壳层快捷键，它不该认识范围这个概念）零改动，也不许抄第二份判据。
 * 显式传 `null` = 本次查询强制不限。
 *
 * 两条腿：① 认得范围戳的应答方在**扫描当时**就收窄（`erb-parser` 走 `ErbIndex.scope`，
 * 少扫就是少扫）；② 宿主再按同一个 `pathInScope` 兜一遍——**不认得的应答方也不漏网**，
 * 这条通道不必给契约请求成员加字段（`limit` 已经是宿主能给的唯一旋钮：带范围时向
 * 提供方多要几档，免得范围外那批占掉名额把范围内的候选挤出去）。
 * 宿主这一遍丢掉的条数如实带在 `droppedOutOfScope` 上——"范围外没扫"必须看得见（铁律 4）。
 */
export function collectWorkspaceSymbols(
  contributions: readonly EditorLanguageServiceContribution[],
  args: {
    query: string;
    project: GameProject | null;
    limit?: number;
    scope?: ErbScopeStamp | null;
    /**
     * 项目文件快照（ERB-PARITY G4，**additive 可选**）。缺省 ⇒ 读唯一来源
     * （{@link installWorkspaceSymbolProjectFilesSource}，与 `scope` 读 `activeNavScope()`
     * 同一个模式：调用方不必认识这个概念的接线细节）；显式传 `null` = 本轮强制不带。
     */
    projectFiles?: WorkspaceSymbolProjectFiles | null;
  },
): WorkspaceSymbolCollection {
  const query = args.query.trim();
  if (query.length === 0) return NO_SYMBOLS;
  const scope = args.scope === undefined ? activeNavScope() : args.scope;
  const roots = scope?.roots ?? [];
  const providerLimit = providerLimitFor(args.limit, roots.length > 0);
  const projectFiles = args.projectFiles === undefined ? currentProjectFiles() : args.projectFiles ?? undefined;

  const answers: (readonly EditorWorkspaceSymbol[])[] = [];
  let reportedTotal = 0;
  for (const contribution of contributions) {
    let result: ReturnType<EditorLanguageServiceContribution['provide']>;
    try {
      result = contribution.provide({
        kind: 'workspaceSymbol',
        query: args.query,
        project: args.project,
        ...(providerLimit !== undefined ? { limit: providerLimit } : {}),
        // 缺席 ⇒ 请求里**不出现**这一格（旧供方零改动；与 references 的 `projectFiles` 同口径）
        ...(projectFiles === undefined
          ? {}
          : { projectFiles: projectFiles.files, projectFilesComplete: projectFiles.complete }),
      });
    } catch (e: unknown) {
      console.warn(
        `[workspace-symbols] '${contribution.id}' provide 抛错：${errorText(e)}`,
      );
      continue;
    }
    if (!result || result.kind !== 'workspaceSymbol') continue;
    answers.push(result.symbols);
    // 提供方没给总数时按"它给了多少就是多少"计（保守：不虚报溢出）
    reportedTotal += result.totalMatched ?? result.symbols.length;
  }
  const deduped = dedupeWorkspaceSymbols(answers.flat());
  const symbols = filterByScope(deduped.symbols, (s) => s.filePath, roots);
  return {
    symbols,
    // 契约的 `totalMatched` 是"提供方报告的命中总数"，而同一函数在源与产物里各被
    // 报过一次（两家、两个坐标系）⇒ 并掉的 `sugarMerged` 条要从和小扣回，否则
    // 面板会报一条永远列不出来的"另有 N 条"（假读数，铁律 4）。
    // 范围外的那批同理不算命中：把"被范围挡掉"报成"溢出未列出"也是假读数。
    totalMatched: Math.max(
      symbols.length,
      reportedTotal - deduped.sugarMerged - (deduped.symbols.length - symbols.length),
    ),
    scope,
    droppedOutOfScope: deduped.symbols.length - symbols.length,
  };
}

/**
 * 排名桶（小者靠前）：**比较器单源** `candidateRank`（契约层）。
 * 四通道（全文检索 / 函数树 / `Ctrl+T` / `Ctrl+P`）读同一张桶表 ⇒ 同一个查询
 * 在任何一处都是同一个顺序；`erb-parser` 提供方侧用的也是这一份。
 */
function rankSymbol(symbol: EditorWorkspaceSymbol, q: string): number {
  return candidateRank(symbol.name, symbol.filePath, q);
}

/**
 * 排序 + 截断（**纯函数**；桶序 = 契约层的 `candidateRank` 一份比较器，
 * 与 `filterFileCandidates` / 函数树搜索 / 全文检索候选**同桶同序**）。
 *
 * - 大小写不敏感（比较前两侧都归一；中文函数名不受影响，与原生大写名同一条路）；
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
    .map((symbol, i) => ({ symbol, i, rank: rankSymbol(symbol, q) }))
    // 先按桶、再按入参序（`Array#sort` 在现代引擎稳定，但这里不依赖实现：显式比 `i`）
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.i - b.i));
  const budget = candidateBudget('render', cap);
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
  /** 已索引文件数（**旧读数**：只在 `indexState` 缺席时当"有没有索引"的兜底判据） */
  readonly fileCount: number;
  /** 当前查询串 */
  readonly query: string;
  /**
   * 索引这一轮的**可查事实**（ST-CONSUMERS，**additive 可选**）：`erb.parser` 的
   * `indexState()` 原样转述，宿主不替提供方判形状（判据单源见 `erb-parser/index-state.ts`）。
   *
   * 为什么非它不可：`fileCount` 只答"有没有索引"，答不出**为什么没有**——
   * "一个可扫的位置都没走到"与"位置走到了、名录确实为空"在 `fileCount` 上是同一个 0，
   * 却是两句不同的话。缺席（旧实现没交事实）⇒ 逐字退回下面那三条旧读数，旧行为零改动。
   */
  readonly indexState?: ErbIndexState | null;
}

/**
 * 空结果的**可见原因**（铁律 4「内核不静默」在 UI 侧的那一半）。
 *
 * 判据次序是有意的：**先说环境、再说查询**。没开项目时回答"无匹配符号"等于把
 * "根本没有名录"伪装成"你的名字起错了"；作者按了快捷键却看见一句和查询无关的话，
 * 才不会以为功能坏了。
 *
 * ST-CONSUMERS 改的那一寸：`fileCount === 0` 那一句此前把"没地方可扫"与"扫了什么都没有"
 * 糊成同一句假话。现在这一格**按 phase 查表**（表与另两条通道同一张，见
 * `ui/index-state-copy.ts`），并把"走了几个位置、扫了几个文件"的原始读数带在括号里；
 * 索引那一侧就绪（`ready`）时查表交回 `null` ⇒ 后面的查询层判据照常生效。
 */
export function workspaceSymbolNotice(a: WorkspaceSymbolAvailability): string {
  if (!a.hasProject) return '未打开项目，没有可搜索的工作区符号';
  if (a.indexError) return `索引不可用：${a.indexError}`;
  const why = workspaceSymbolIndexCopy(a.indexState ?? null);
  if (why !== null) return why;
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
