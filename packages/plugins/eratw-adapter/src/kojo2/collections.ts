/**
 * eraTW 2.0 `@巡` 集合声明（游戏事实 —— 只住本包；K2-FOREACH）。
 *
 * 口径（设计稿 §9.2 / §9.3）：
 * - **作者数组**走 `arrayRule`：`# 设 名 类型[N]` 声明后 `@巡 名` 绑定 `{值}` / `{下标}`。
 *   数组事实（名 / 元素类型 / 长度）由 core 从 `# 设` 收集后经 plan 的 `arrays` 注入；
 *   本表**不预列作者数组**（否则等于把每个作者工程抄进 adapter）。
 * - **角色集合 `队伍`**：eraTW 角色号 0 = 玩家（MASTER），1..`CHARANUM - 1` 是登场角色。
 *   遍历从 1 起、长度 `CHARANUM - 1`（空集合 = `CHARANUM <= 1`，循环条件零轮）；
 *   `{角}` = 角色号（int），`{名}` = 该角色的称呼 —— 用 `CALLNAME` 变量族按角色号索引
 *   （产物形 `CALLNAME:(角色号槽)`，动态索引与 `CFLAG:(A + 1)` 同形），
 *   与 v1 `{她的名字}` → `%CALLNAME:…%` 是同一引擎事实（不另造名字表）。
 * - **不声明键值集合**：eraTW 没有稳定的 `{项}` / `{键}` 集合落点；core 的类型事实支持
 *   该类集合，但本 adapter 的 emitter 会 fail-closed（不猜键的取法）。
 *
 * 数据只读：module 装载时 `deepFreeze` 一次，core / emitter 查表零构造开销。
 */
import type {
  ForeachArrayRule,
  ForeachCollectionDecl,
  ForeachDeclarations,
} from '../../../../kojo-core/src/lower/expand/foreach.js';
import { deepFreeze } from '../../../../kojo-core/src/adapter.js';

/** `@巡 队伍`：角色号 1..CHARANUM-1（0 号是玩家，不进队伍） */
const TEAM: ForeachCollectionDecl = {
  name: '队伍',
  kind: 'characters',
  elementType: 'character',
  base: 1,
  keyType: null,
  length: Object.freeze({ kind: 'engine' as const, counter: 'CHARANUM', minus: 1 }),
  bindings: Object.freeze(['角', '名'] as const),
  nameAccessor: 'CALLNAME',
};

/** 作者数组：0 基，绑定 `{值}` / `{下标}`；元素类型与长度由每份 `# 设` 事实给 */
const AUTHOR_ARRAY: ForeachArrayRule = {
  base: 0,
  bindings: Object.freeze(['值', '下标'] as const),
};

/** eraTW 的整套 `@巡` 集合声明（冻结；plan 的唯一数据源） */
export const ERATW_FOREACH_DECLARATIONS: ForeachDeclarations = deepFreeze({
  collections: [TEAM],
  arrayRule: AUTHOR_ARRAY,
});

/** 命名集合清单（只读视图；测试/补全用） */
export const ERATW_FOREACH_COLLECTIONS: readonly ForeachCollectionDecl[] =
  ERATW_FOREACH_DECLARATIONS.collections;

/** 作者数组规则（只读视图；plan 的 `arrays` 事实由调用方给） */
export const ERATW_FOREACH_ARRAY_RULE: ForeachArrayRule | null = ERATW_FOREACH_DECLARATIONS.arrayRule;
