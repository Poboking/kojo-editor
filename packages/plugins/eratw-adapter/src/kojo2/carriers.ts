/**
 * eraTW 的**载体归属**（LAU-D4 车 ①；`ARCH-language-unification.md` §5.2 ③ / §8 LAU-D4）。
 *
 * 与 eraFL 那份（`erafl-adapter/src/kojo2/carriers.ts`，LAU-D3）**同一契约、不同数据**——
 * 这正是"归属是数据不是宿主分支"的第一枚实证：宿主读的还是同一张 `CarrierBinding`，
 * 两门方言填的是各自的盘上事实，谁也不给谁让路。
 *
 * | 载体 | eraTW 真盘形态 | 校验哪几类事实 |
 * | --- | --- | --- |
 * | `erb` | `ERB/**` 的 `.ERB` / `.erb` / `.ERH`（口上域 `ERB/口上・メッセージ関連/`，含 `個人口上/`） | **全部四类**（省略 `validates` = 全量，`dialect-resolver.ts::factKindsOf`） |
 * | `inline` | `.kojo2`（2.0 面） | 全部四类（同上） |
 *
 * ## 为什么 eraTW 的 ERB 校验 `event`（eraFL 刻意不校验的那一格的对面）
 *
 * eraTW 的 `# 机` 落**口上运行时**（`# 机 初见` → `@M_KOJO_ENCOUNTER_K12` + `CALL`/`RETURN`，
 * 实测口径见 `packages/kojo-conformance/tests/language-shared.test.ts` 头注与
 * `tests/kojo2/backend.test.ts`）：事件面与正文同住在 ERB 这一格里。所以 eraTW 的 ERB
 * 载体**不剥** `event`——剥了就是把 eraFL 的"ERB 只剩注册壳"错嫁到 eraTW 盘上。
 *
 * ## 为什么 eraTW **不声明** XML 载体（不是漏写）
 *
 * 1. eraTW 的 `eventCatalog` 事件全部落 ERB / 2.0 面（`ui-kojo-xml/src/kojo-xml-dialect.ts`
 *    头注记的是这条等价判据），XML 在 eraTW 盘上不是方言的事实载体；
 * 2. 若声明一条 `validates: []` 的 xml 归属，`eventCarrierGateOf` 会判"本载体不校验事件、
 *    别处校验"⇒ XML 三格的**每个挂点**一律 `core/event/wrong-carrier`（error）——给真盘
 *    合法在用 XML 的 eraTW 作者铺一屏错，这是数据写反，不是"多声明一格更严"；
 * 3. 不声明的效果是诚实的：XML 文件走 `resolveDialectBinding` 得 `carrier = null` +
 *    一条可见的 `core/carrier/unowned`（不静默，铁律 4），事件级校验跳过；v1 的 XML
 *    形状 lint（`kojo-xml-diagnostics` 属性枚举面）不吃 `carriers`，零受影响。
 *
 * ## 大小写与顺序
 *
 * 与 eraFL 同口径：glob **大小写敏感**（归属是数据不是宽恕），真盘魔改盘有小写 `.erb`，
 * 故 `.ERB` / `.erb` 各声明一条；`.ERH`（预载声明面）归 erb。顺序 = 归属优先序
 * （第一条命中即返回，`dialect-resolver.ts::findCarrierBinding`）；`.kojo2` 排最后：
 * 它与 ERB 三枚的扩展名不相交，次序只表达"2.0 面是并列载体、不是 ERB 的附庸"。
 */
import type { CarrierBinding } from '@kojo/kojo-core';

/** eraTW 的载体表（冻结；顺序 = 归属优先序）。形状口径逐字同 `erafl-adapter` 那份。 */
export const ERATW_CARRIERS: readonly CarrierBinding[] = Object.freeze([
  // 主战场：口上正文与事件落点同住的 ERB 面。`validates` 省略 = 四类事实全在这一格校验
  // （event / symbol / presentation / storage）——这是 eraTW 的盘上事实，见头注第一条。
  Object.freeze({
    carrier: 'erb' as const,
    glob: 'ERB/**/*.ERB',
  }),
  Object.freeze({
    carrier: 'erb' as const,
    glob: 'ERB/**/*.erb',
  }),
  Object.freeze({
    carrier: 'erb' as const,
    glob: 'ERB/**/*.ERH',
  }),
  // 2.0 面：`# 机` / `@织` 的内联文档。同样省略 validates（四类全校验，与 ERB 面同权）。
  Object.freeze({
    carrier: 'inline' as const,
    glob: '**/*.kojo2',
  }),
]);
