import { afterEach, describe, expect, it } from 'vitest';
import type {
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  ErbFile,
  ErbFunction,
  ErbIndex,
  ErbScopeStamp,
} from '@kojo/plugin-api';
import { filterByScope, pathInScope } from '@kojo/plugin-api';
import { buildNavigatorTree, searchFunctions } from '@kojo/plugin-ui-kojo-navigator';
import { rankFiles } from '../src/ui/palette-search';
/** 判据住在 palette-search（`Ctrl+P` 文件模式的真身）；测试要的是「只含路径」那条投影 */
const filterFileCandidates = (
  paths: readonly string[],
  q: string,
  cap?: number,
): string[] => rankFiles(paths, q, cap === undefined ? {} : { cap }).map((h) => h.path);
import {
  activeNavScope,
  filterPathsByActiveScope,
  narrowRoots,
  resolveScope,
  setActiveScope,
  type SearchScopeItem,
} from '../src/ui/search-scope';
import { collectWorkspaceSymbols } from '../src/ui/workspace-symbols';

/**
 * W7 NAV-SCOPE · P1 对拍（2026-10-18 接力批）。
 *
 * 「只看某角色/目录」的范围选择器此前**只作用于 Rust 全文那一条通道**——选定范围后
 * 函数树仍扫全量十万条。这里用**同一份假索引 + 同一个范围戳**喂四条通道，
 * 钉"候选集合一致"，并把各自条数写成显式断言（读数不许只靠截图目测）：
 *   ① Rust 全文（宿主侧形态：`narrowRoots` 收窄检索根 + `filterByScope` 过滤命中）
 *   ② 函数树（`ui-kojo-navigator` 的 `searchFunctions` / `buildNavigatorTree` + `options.scope`）
 *   ③ `Ctrl+T`（宿主 `collectWorkspaceSymbols`：提供方**不认得范围**的最坏情形，
 *      由宿主兜底过滤 ⇒ 与提供方认戳的 `erb-parser/workspace-symbols` 同一条 `pathInScope`）
 *   ④ `Ctrl+P`（宿主 ProjectView 那份候选经 `filterPathsByActiveScope` 后交 `filterFileCandidates`）
 * 归属判据全仓只剩 `pathInScope` 一条；角色归属表 `charaOwnersOf/ownerNoOfPath` 是它的投影
 * （旧 `familyIndex.match` 那份"谁属于哪个角色"已并进同一条判据——`attribution === 'dir'`）。
 */

const SCOPE: ErbScopeStamp = { key: 'eratw:chara12', roots: ['C:/game/kojo/chara12'] };

const IN_A = 'C:/game/kojo/chara12/MESSAGE.ERB';
const IN_B = 'C:/game/kojo/chara12/TRAIN.ERB';
const OUT = 'C:/game/kojo/chara20/MESSAGE.ERB';

const fn = (name: string, filePath: string, startLine: number, endLine: number): ErbFunction => ({
  name,
  normalizedName: name.toUpperCase(),
  filePath,
  startLine,
  endLine,
  params: [],
});

const FUNCTIONS: ErbFunction[] = [
  fn('M_KOJO_K12_310', IN_A, 10, 20),
  fn('M_KOJO_K12_311', IN_A, 25, 30),
  fn('M_KOJO_K12_310_TRAIN', IN_B, 5, 9),
  fn('M_KOJO_K20_310', OUT, 3, 12),
  fn('M_KOJO_K20_999', OUT, 20, 26),
];

const index: ErbIndex = {
  files: new Map<string, ErbFile>(
    [IN_A, IN_B, OUT].map((path) => [
      path,
      {
        path,
        functions: FUNCTIONS.filter((f) => f.filePath === path),
        dims: [],
        hasFunctionDirective: false,
        lineCount: 60,
      },
    ]),
  ),
  byName: new Map(),
};

const ALL_PATHS = [IN_A, IN_B, OUT];

afterEach(() => setActiveScope(null));

describe('P1 对拍 — 选定范围后四条通道候选集合一致', () => {
  const QUERY = '310';

  /** 范围内函数的**期望全集**（对拍的基准腿：查询 310 命中的全量函数 ∩ 范围） */
  const expectedFunctions = () =>
    FUNCTIONS.filter((f) => f.normalizedName.includes(QUERY) && pathInScope(f.filePath, SCOPE.roots));

  it('② 函数树：范围内 2 条 / 范围外 1 条一条不扫', () => {
    const hits = searchFunctions(index, QUERY, null, 100, { scope: SCOPE });
    expect(hits).toHaveLength(2); // 条数：M_KOJO_K12_310 / M_KOJO_K12_310_TRAIN
    expect(hits.map((h) => h.node.name).sort()).toEqual(['M_KOJO_K12_310', 'M_KOJO_K12_310_TRAIN']);
    const tree = buildNavigatorTree(index, null, new Map(), { scope: SCOPE });
    expect(tree.filesScanned).toBe(2); // 只扫了 chara12 的两个文件
    expect(tree.scopeKey).toBe(SCOPE.key);
  });

  it('③ Ctrl+T：提供方不认戳时宿主兜底后与②同集合（并如实记 droppedOutOfScope）', () => {
    const naive: EditorLanguageServiceContribution = {
      id: 'naive-provider',
      provide: (request: EditorLanguageServiceRequest) =>
        request.kind === 'workspaceSymbol' && request.query.trim().length > 0
          ? {
              kind: 'workspaceSymbol',
              symbols: FUNCTIONS.filter((f) => f.normalizedName.includes(QUERY)).map((f) => ({
                kind: 'function' as const,
                name: f.name,
                filePath: f.filePath,
                line: f.startLine,
              })),
              totalMatched: FUNCTIONS.filter((f) => f.normalizedName.includes(QUERY)).length,
            }
          : undefined,
    } as unknown as EditorLanguageServiceContribution;
    const got = collectWorkspaceSymbols([naive], { query: QUERY, project: null, scope: SCOPE });
    expect(got.symbols).toHaveLength(2); // 条数：与②逐名相等
    expect(got.symbols.map((s) => s.name).sort()).toEqual(['M_KOJO_K12_310', 'M_KOJO_K12_310_TRAIN']);
    expect(got.droppedOutOfScope).toBe(1); // chara20 那条被范围挡掉且**进了读数**（不是静默丢）
    expect(got.totalMatched).toBe(2); // 范围外不算命中——不许把"挡掉的"报成"溢出"
  });

  it('① Rust 全文：narrowRoots 收窄后命中的文件集合 = pathInScope 的集合', () => {
    const item: SearchScopeItem = { key: SCOPE.key, label: 'K12', detail: '', roots: SCOPE.roots };
    const narrowing = narrowRoots(['C:/game/kojo'], item);
    expect(narrowing.roots).toEqual(['C:/game/kojo/chara12']); // 范围落得进现有检索根 ⇒ 根收窄到它
    expect(narrowing.unreachable).toEqual([]);
    // 原生侧返回全项目命中（旧行为），宿主按同一个戳过滤后的文件集合：
    const hitFiles = filterByScope(ALL_PATHS, (p) => p, SCOPE.roots);
    expect(hitFiles).toHaveLength(2); // 条数：IN_A / IN_B
    expect(hitFiles.sort()).toEqual([IN_A, IN_B].sort());
  });

  it('④ Ctrl+P：读唯一状态源 activeNavScope，候选文件集合与①逐条相等', () => {
    setActiveScope(resolveScope([{ key: SCOPE.key, label: 'K12', detail: '', roots: SCOPE.roots }], SCOPE.key));
    expect(activeNavScope()?.key).toBe(SCOPE.key);
    const paths = filterPathsByActiveScope(ALL_PATHS, (p) => p);
    const candidates = filterFileCandidates(paths, 'MESSAGE');
    expect(candidates).toEqual([IN_A]); // 条数：1（OUT 的 MESSAGE.ERB 已随范围出局）
    expect(paths.sort()).toEqual(filterByScope(ALL_PATHS, (p) => p, SCOPE.roots).sort());
  });

  it('四通道交叉：函数候选②=③，文件候选①=④，且都等于基准腿', () => {
    const treeFns = searchFunctions(index, QUERY, null, 100, { scope: SCOPE }).map((h) => `${h.node.name}@${h.node.filePath}`);
    const baseline = expectedFunctions().map((f) => `${f.name}@${f.filePath}`);
    expect(treeFns.sort()).toEqual(baseline.sort());
    expect(expectedFunctions()).toHaveLength(2); // 基准腿条数：2（chara20 的 310 出局）
    // 不限范围 ⇒ 基准腿 3 条（范围判据不是"永远变少"的开关，是戳的函数）
    expect(
      FUNCTIONS.filter((f) => f.normalizedName.includes(QUERY) && pathInScope(f.filePath, [])),
    ).toHaveLength(3);
  });

  it('空 roots 的戳 = 不限（整棵树空白会被读成"项目没有函数"——四通道同一读法）', () => {
    const blank: ErbScopeStamp = { key: 'stale', roots: [] };
    setActiveScope(blank);
    expect(activeNavScope()).toBeNull(); // 状态源自己就把空 roots 归一成 null
    expect(searchFunctions(index, QUERY, null, 100, { scope: blank })).toHaveLength(3);
    expect(filterPathsByActiveScope(ALL_PATHS, (p) => p)).toHaveLength(3);
  });
});
