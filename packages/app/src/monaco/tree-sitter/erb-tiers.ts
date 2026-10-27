import { ROLE, type SemanticRole } from '@kojo/kojo-lang/semantic-roles';

/**
 * ERB 结构层的**捕获名 → 语义角色**表（worker 与主线程共用；只引零依赖的角色表，
 * 别把它做成第二个重型模块——`semantic-roles.ts` 只有字符串，进 worker 图不拖任何词表）。
 *
 * ## 为什么单独成文件
 *
 * worker 的依赖面只有 `./engine` + `./types` + 入口资源（见 `worker-bootstrap.ts` 头注）。
 * `erb-semantic.ts` 要碰 Monaco 类型与宿主编码，不能进 worker 图；而 worker 里的引擎需要
 * 同一张表才能把 `highlights.scm` 的捕获翻成角色。所以表放在这里，两侧各取所需：
 * - worker（`structure.worker.ts` 经 `StructureEngineAssets.captureTier` 注入，LAU-5 起与
 *   `.kojo` 共用一条线程）用同一张表把捕获翻成档位；
 * - 主线程（`erb-semantic.ts`）用它算 legend、校验 token 档位。
 *
 * ## 档位选型（LAU-2：**只发角色，不再发词法 token 名**）
 *
 * | 捕获 | 角色 | 理由 |
 * |---|---|---|
 * | `@comment` | `role.comment` | 注释 |
 * | `@keyword.directive` | `role.directive` | `#DIM` / `#` 指令与预处理行同档 |
 * | `@tag` | `role.directive` | `[` 标签行（含停用区标记）与预处理同档 |
 * | `@label` | `role.label` | `$标签` |
 * | `@function` | `role.decl` | `@NAME` 的名字（只捕名字，不盖整行） |
 * | `@keyword.control` | `role.engine` | 控制流是**整行不透明**：结构层能说的只有"这一行是引擎骨架" |
 * | `@string` | `role.string` | 台词 / 串 |
 * | `@string.special` | `role.interp` | FORM `{…}` / `%…%` 插值记号 |
 * | `@raw` | `role.raw` | 停用区体内原文 = 不透明整块 |
 * | `@type` | `role.type` | **唯一一档词法层判不出来**（2026-10-27 第三色批）：`#DIM` 的型 / 存储限定词 |
 *
 * `@type` 为什么破例：词法层（`erb-language.ts`）对这一维**没有任何判据**——它把
 * `#DIM CONST 名` 整条 `#` 行按 `#\w+` 只认第一个词，限定词与名字都落进兜底档。
 * 判据只有 CST 有（`dim_directive → dim_modifier` 是子记号节点），所以这一档是"结构层给出的
 * 新信息"，不是"换了个判据重涂同一格"。
 *
 * 表外捕获返回 `null`（引擎说一次并不着色）；`none` 是有意的"不供着色"哨兵，
 * 返回 `undefined` ⇒ 安静跳过（查询里留着只为可读性）。
 */

/** 捕获名 → 语义角色（值必须都能在主题里取到色，见上表） */
export const ERB_SEMANTIC_CAPTURE_TIERS: Readonly<Record<string, SemanticRole>> = {
  comment: ROLE.comment,
  'keyword.directive': ROLE.directive,
  label: ROLE.label,
  tag: ROLE.directive,
  function: ROLE.decl,
  'keyword.control': ROLE.engine,
  string: ROLE.string,
  'string.special': ROLE.interp,
  raw: ROLE.raw,
  // 2026-10-27 第三色批：`#DIM` 行的型 / 存储限定词（`CONST` / `DYNAMIC` / `CHARA` …）。
  // 消费链 = 默认开的结构层（`ui/tree-sitter-pref.ts` 的 `TREE_SITTER_DEFAULT = true`），
  // 命中面见 queries/highlights.scm 的 @type 那段注释与 `tests/erb-ts-facets.test.ts` 的取证用例。
  type: ROLE.type,
};

/** 有意不供着色的捕获（引擎遇到它们不告警；与"表外"是两件事） */
export const ERB_SEMANTIC_QUIET_CAPTURES: readonly string[] = ['none'];

/** 角色的确定性排序（legend / 测试都取这一份） */
export function erbSemanticTiers(): SemanticRole[] {
  return [...new Set(Object.values(ERB_SEMANTIC_CAPTURE_TIERS))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 捕获名（+ 节点类型）→ 角色。
 *
 * 本批没有节点级覆盖（ERB 的捕获都落在"整枚节点头/标记"上，跨度内容同族）；
 * 参数保留节点类型，供将来出现"同一捕获混两形"时按 `KOJO_STRUCTURE_NODE_ROLES` 的同一形态扩展。
 */
export function erbCaptureTier(capture: string, nodeType?: string): SemanticRole | null | undefined {
  void nodeType;
  if (ERB_SEMANTIC_QUIET_CAPTURES.includes(capture)) return undefined;
  return ERB_SEMANTIC_CAPTURE_TIERS[capture] ?? null;
}
