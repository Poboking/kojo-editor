/**
 * ERB 结构层的**捕获名 → 词法档位名**表（worker 与主线程共用；零 import，别把它做成第二个重型模块）。
 *
 * ## 为什么单独成文件
 *
 * worker 的依赖面只有 `./engine` + `./types` + 入口资源（见 `worker-bootstrap.ts` 头注）。
 * `erb-semantic.ts` 要碰 Monaco 类型与宿主编码，不能进 worker 图；而 worker 里的引擎需要
 * 同一张表才能把 `highlights.scm` 的捕获翻成档位名。所以表放在这里，两侧各取所需：
 * - worker（`erb-ts.worker.ts`）通过 `captureTier` 注入 `StructureEngineAssets`；
 * - 主线程（`erb-semantic.ts`）用它算 legend、校验 token 档位。
 *
 * ## 档位选型（与 `kojo-language.ts` 的 `KOJO_TOKEN_TIERS` 同源，不新配色）
 *
 * | 捕获 | 档位 | 理由 |
 * |---|---|---|
 * | `@comment` | `comment` | Monaco 基线 token，主题基色已有 |
 * | `@keyword.directive` | `keyword.preprocessor` | `#DIM` / `#` 指令与 Monarch 同档 |
 * | `@tag` | `keyword.preprocessor` | `[` 标签行（含停用区标记）与预处理/标签同色 |
 * | `@label` | `label` | `$标签` 与 Monarch 同档 |
 * | `@function` | `entity.name.function` | `@NAME` 的名字（只捕名字，不盖整行） |
 * | `@keyword.control` | `keyword.erb` | 控制流是**整行不透明 token**：结构层能说的只有"这一行是引擎骨架" |
 * | `@string` | `string` | 台词 / 串，与 Monarch 同档 |
 * | `@string.special` | `sugar.interp` | FORM `{…}` / `%…%` 插值记号 |
 * | `@raw` | `keyword.raw` | 停用区体内原文 = 不透明整块 |
 *
 * 表外捕获返回 `null`（引擎说一次并不着色）；`none` 是有意的"不供着色"哨兵，
 * 返回 `undefined` ⇒ 安静跳过（查询里留着只为可读性）。
 */

/** 捕获名 → 档位名（值必须都能在主题里取到色，见上表） */
export const ERB_SEMANTIC_CAPTURE_TIERS: Readonly<Record<string, string>> = {
  comment: 'comment',
  'keyword.directive': 'keyword.preprocessor',
  label: 'label',
  tag: 'keyword.preprocessor',
  function: 'entity.name.function',
  'keyword.control': 'keyword.erb',
  string: 'string',
  'string.special': 'sugar.interp',
  raw: 'keyword.raw',
};

/** 有意不供着色的捕获（引擎遇到它们不告警；与"表外"是两件事） */
export const ERB_SEMANTIC_QUIET_CAPTURES: readonly string[] = ['none'];

/** 档位名的确定性排序（legend / 测试都取这一份） */
export function erbSemanticTiers(): string[] {
  return [...new Set(Object.values(ERB_SEMANTIC_CAPTURE_TIERS))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 捕获名（+ 节点类型）→ 档位名。
 *
 * 本批没有节点级覆盖（ERB 的捕获都落在"整枚节点头/标记"上，跨度内容同族）；
 * 参数保留节点类型，供将来出现"同一捕获混两形"时按 `KOJO_STRUCTURE_NODE_TIERS` 的同一形态扩展。
 */
export function erbCaptureTier(capture: string, nodeType?: string): string | null | undefined {
  void nodeType;
  if (ERB_SEMANTIC_QUIET_CAPTURES.includes(capture)) return undefined;
  return ERB_SEMANTIC_CAPTURE_TIERS[capture] ?? null;
}
