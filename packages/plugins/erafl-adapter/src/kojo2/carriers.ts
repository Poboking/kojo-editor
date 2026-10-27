/**
 * eraFL 的**载体归属**（LAU-D3；`ARCH-language-unification.md` §5.2 ③ / §8 LAU-D3）。
 *
 * 这一格回答的是"作者的叙事正文写在哪"，不是"怎么写"：
 *
 * | 载体 | 真盘形态 | 谁校验 |
 * | --- | --- | --- |
 * | `xml` | `ERB/口上/{编号}_{名称}/*.xml`（`<command com= name= kojoPlace=>`） | 全部事实类——**事件/命令面只在这里** |
 * | `erb` | `ERB` 下各级的 `.ERB`（注册壳 `@KOJO_DEFINE_K{n}` + 引擎流程） | 符号 / 演出 / 存储期；**不校验事件** |
 * | `inline` | `.kojo2`（2.0 面：`# 机` / `@织` 的引擎事件在这里） | 全部事实类 |
 *
 * 三条真盘依据：
 *
 * 1. **正文在 XML**（293 份 / 61,562 条 `<command>`，实测口径见 `kojo-xml/schema.ts` 头注）；
 * 2. **ERB 只剩壳**：`@KOJO_DEFINE_K{n}` 里 `CALL KOJO_XML_REGISTER(...)` 把 XML 挂进引擎
 *    （`ERB/口上/1099_うふふお姉さん/KOJO_DEFINE_K1099.ERB`）。把 `# 机` 写进这类文件
 *    是**事件写错载体**，要报 `core/event/wrong-carrier`（不是"未知事件"）；
 * 3. **2.0 的引擎事件只在 `.kojo2` 上成立**：`# 机 初见` 落成 `@EVENTFIRST` + `#LATER`
 *    （`kojo2/backend.ts`），ERB 文件里没有 `# 机` 这一层。
 *
 * ## `shells`（additive 可选）为什么放在这里
 *
 * "ERB 里那个 `@KOJO_DEFINE_K1099` 是壳"是**游戏事实**：宿主不认识任何一族名字，但
 * 方言可以声明"这个载体在 ERB 上的注册壳长哪些前缀"。悬停据此给一句「这条事件在 xml」，
 * 而不是把壳函数当成"没实现的口上"（§8 LAU-D3 第 4 条 DoD）。
 *
 * 前缀取**最长可判形态**（含 `_K` 锚点），匹配口径 = 「前缀 + 紧跟数字」：这样
 * `KOJO_DEFINE_K1099` 命中 `KOJO_DEFINE_K`，而 `KOJO_DEFINE_KOJO_INFO_K1099` 只命中
 * 它自己那条（`KOJO_DEFINE_K` 后面跟着的是 `O` 不是编号）。五族 + 两个 XML 注册族一次列全。
 *
 * ## 顺序 = 优先序
 *
 * `resolveDialectBinding`/`findCarrierBinding` 按**声明顺序**取第一条命中（`dialect-resolver.ts`）。
 * `ERB/口上/**` 下的 `.xml` 必须排在 ERB 那张 glob 之前吗？**不需要**：两者的扩展名不相交；
 * 但 xml 排前面让"口上域优先"这条意图在数据上可见。
 *
 * 大小写：`dialect-resolver` 的 glob **大小写敏感**（归属是数据不是宽恕）。真盘扩展名是
 * 大写 `.ERB`，魔改盘也有小写 `.erb`，故两条都声明；`.ERH`（预载白名单）同样归 ERB 载体。
 */
import type { CarrierBinding } from '@kojo/kojo-core';

/** 口上 XML 的相对 glob（相对工程根；`**` 跨段，`ERB/口上/*.xml` 也命中） */
export const ERAFL_XML_CARRIER_GLOB = 'ERB/口上/**/*.xml';

/**
 * ERB 载体的校正面：**不含 `event`**——事件面只在 XML / `.kojo2` 上校验。
 * 这不是"少写一格"，而是 LAU-D3 的核心事实（`# 机` 写进 ERB 必须被判错载体）。
 */
const ERB_VALIDATES = Object.freeze(['symbol', 'presentation', 'storage'] as const);

/**
 * ERB 上的注册壳前缀（真盘实测 7 族，读法见 `src/family-index.ts` 头注）。
 *
 * - `KOJO_DEFINE_K`（135 处）/ `KOJO_DEFINE_NAME_K`（96）/ `KOJO_DEFINE_KOJO_INFO_K`（96）
 *   ——`family-index.ts` 里已登记的五族之三；
 * - `KOJO_FOR_MALE_K` / `KOJO_FOR_FEMALE_K`（各 26）——五族之剩两族；
 * - `KOJO_XML_INIT_K`（126）/ `KOJO_XML_COMGROUP_K`（126）——**未进五族**的 XML 注册族
 *   （只出现在壳文件里，正文同样在 XML）。
 *
 * 这一格只用来做悬停提示，**不做**任何校验/改名/补全决定。
 */
export const ERAFL_ERB_SHELL_PREFIXES: readonly string[] = Object.freeze([
  'KOJO_DEFINE_KOJO_INFO_K',
  'KOJO_DEFINE_NAME_K',
  'KOJO_FOR_FEMALE_K',
  'KOJO_FOR_MALE_K',
  'KOJO_XML_COMGROUP_K',
  'KOJO_XML_INIT_K',
  'KOJO_DEFINE_K',
]);

/** eraFL 的载体表（冻结；顺序 = 归属优先序） */
export const ERAFL_CARRIERS: readonly CarrierBinding[] = Object.freeze([
  // 口上正文：XML。事件/命令面只在这一格校验（`command` 三格见 `kojo-xml-dialect.ts`）。
  Object.freeze({
    carrier: 'xml' as const,
    glob: ERAFL_XML_CARRIER_GLOB,
    // XML 数据面今天只接事件/命令校验；符号与演出不在这一层（`kojo-xml-diagnostics` 另有
    // 属性枚举面）。写成集合而不是省缺省，是为了让"这一载体校验哪几类"在数据上可读。
    validates: Object.freeze(['event'] as const),
    shells: ERAFL_ERB_SHELL_PREFIXES,
  }),
  // ERB：注册壳与引擎流程。事件面**不在**这里（写了 `# 机` 就是错载体）。
  Object.freeze({
    carrier: 'erb' as const,
    glob: 'ERB/**/*.ERB',
    validates: ERB_VALIDATES,
  }),
  Object.freeze({
    carrier: 'erb' as const,
    glob: 'ERB/**/*.erb',
    validates: ERB_VALIDATES,
  }),
  Object.freeze({
    carrier: 'erb' as const,
    glob: 'ERB/**/*.ERH',
    validates: ERB_VALIDATES,
  }),
  // 2.0 面：引擎事件（`# 机 初见`）只在 `.kojo2` 文件里成立。
  Object.freeze({
    carrier: 'inline' as const,
    glob: '**/*.kojo2',
  }),
]);
