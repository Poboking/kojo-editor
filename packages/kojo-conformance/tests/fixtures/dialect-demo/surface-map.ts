/**
 * **第三列的表层↔原生映射表**（LAU-D4 车② 的方言扩展列；与 `DEMO_CARRIERS` 同一族判据）。
 *
 * 这份数据的唯一目的和 `adapter.ts` / `backend.ts` 一样：**证明加一门方言只加数据**。
 * 同一枚 `checkSurfaceMap`（`@kojo/kojo-core/surface-map`）逐列跑 eraTW / eraFL / demo，
 * 判定零方言分支——列从数据来。
 *
 * 形状读数（本列只有 10 条，缺的全是"事实面本来没有"）：
 * - `event` 一条：本列自己的事件 `初见` → `DEMO_FIRST`（token 不借 eraTW / eraFL）；
 * - `symbol` 八条：抽象 fixture 的两枚代词 / 一枚属性 / 一枚名字函数 / 四枚外部变量
 *   （属性落点写 `族:编号`、外部变量写恒等名字——两侧同尺，见 `factSurfacePairs` 的表）；
 * - `storage` 一条：fixture 只有 `scene` → `LOCAL`；
 * - `presentation` **零条**：本列 `heart = null`（没有演出提示），没落点就不占格——
 *   刻意留成"事实面为空 ⇒ 表也为空"的正例，而不是编一条对不上的数据。
 *
 * eraFL 那一列今天**不声明**这张表（与车① 的 `carriers` 同为"未声明 ⇒ 一概不判"），
 * 所以三列里它是唯一 `core/surface/*` 零诊断的"未参与"列；真接是后续车的事。
 */
import type { SurfaceMap } from '@kojo/kojo-core/surface-map';

/** demo 列的表层↔原生表（冻结；顺序 = 正向查询优先序） */
export const DEMO_SURFACE_MAP: SurfaceMap = Object.freeze([
  Object.freeze({ kind: 'event' as const, surface: '初见', native: 'DEMO_FIRST' }),
  Object.freeze({ kind: 'symbol' as const, surface: '我', native: 'VIEW' }),
  Object.freeze({ kind: 'symbol' as const, surface: '你', native: 'PLAYER' }),
  Object.freeze({ kind: 'symbol' as const, surface: '数值', native: 'VAR:0' }),
  Object.freeze({ kind: 'symbol' as const, surface: '名字', native: 'NAME_OF' }),
  Object.freeze({ kind: 'symbol' as const, surface: '外部计数', native: '外部计数' }),
  Object.freeze({ kind: 'symbol' as const, surface: '外部文本', native: '外部文本' }),
  Object.freeze({ kind: 'symbol' as const, surface: '外部上限', native: '外部上限' }),
  Object.freeze({ kind: 'symbol' as const, surface: '外部角色', native: '外部角色' }),
  Object.freeze({ kind: 'storage' as const, surface: 'scene', native: 'LOCAL' }),
]);
