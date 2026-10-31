/**
 * eraTW 的**表层 ↔ 原生双向映射表**（LAU-D4 车②；`ARCH-language-unification.md` §8 LAU-D4）。
 *
 * 与车① 的 `ERATW_CARRIERS` 同形同纪律：**纯数据、深冻结、零函数、游戏名词只住本包**。
 * 一条 = 一对「作者面写的名字 → eraTW/Emuera 盘上的原生写法」；正向（名字找落点）与
 * 反向（落点找名字）都由 `@kojo/kojo-core/surface-map` 从**这同一批行**投影，没有第二份
 * 数据可漂。表与四个事实面（`eventCatalog` / `domainSymbols` / `presentation` /
 * `storageClasses`）逐条对账，错配必红（`core/surface/{dangling,contested,unmapped}`）。
 *
 * ## 为什么"收成一张表"而不是继续散着
 *
 * 这四类对应今天各住在事实面自己的字段里，每一面只会正向查：
 * - 事件名 → `EventSpec.engine`（`event-catalog.ts`）；
 * - 代词 → `PronounSymbol.engineRef`、属性名 → `AttributeSymbol.family` + `index`、
 *   名字函数 → `NameFunctionSymbol.engine`、外部变量 → `DomainVariableSymbol.name`
 *   （恒等落点）——四条子面四样字段名（`domain-symbols.ts`）；
 * - 演出提示名 → `presentation.heart.engine`（名字与落点隔着两枚字段，`presentation.ts`）；
 * - 存储期 → `StorageClassSpec.engine`（`storage.ts`）。
 * 于是"这个引擎落点对应作者写的哪个词"（悬停、原生区高亮、方言扩展比对那一族需求）
 * 今天每处各抄一遍映射。本表把那**一族**收成一格；补全 / 悬停各自的判据不在本批（那是别的车）。
 *
 * ## 三条刻意的"不收"（不是漏写）
 *
 * 1. **`#`/`@` 关键字本身不收**（`# 机` / `@织` / `@函` 的词位）：按 D9/R6 三轴正交，
 *    它们是跨方言共用的**表层语法位**，住在语法面（descriptor / tree-sitter），
 *    方言级数据里没有它们——车① 头注同一裁决。本表收的是这些标记**里面**填的那个名字；
 * 2. **`@着色` / `@颜绘` / `选项` 的落点不收**：一名对多落点（`SETCOLOR` + `RESETCOLOR`、
 *    两条 `CALL`、`PRINTBUTTON` + `INPUTS` + 读回槽），一张 `(一名 → 一写法)` 的表装不下；
 *    硬塞就得把落点压成字符串，那是把 `presentation` 事实面抄第二份、还抄损了。
 *    演出提示名（`(心形)` → `HPH_PRINT`）是**一名一落点**，所以收它、只收它；
 * 3. **角色名不收**：eraTW 的说话人是开放名表（`domainSymbols.speakers.kind = 'project'`，
 *    上千条 CALLNAME），契约层不猜 ⇒ 表只收方言包自己声明得出的名字，角色名交项目级分析。
 *
 * ## 编号与别名
 *
 * 属性落点写成 `族:编号`（`CFLAG:2`）——这是口上盘上作者与引擎真正对话的形态，也是
 * `core` 侧规范化形状（`factSurfacePairs` 用同一条式子生成，两侧同尺才对得上）。
 * `aliases` 只多一个**入口**、不改落点：`恋慕` 的 `爱慕`、`爱欲` 的 `愛欲` 是本地化常见写法，
 * 正向查得到、反向回到本名。别名不另开一格，因为它不是第二个事实。
 *
 * ## 顺序
 *
 * 声明序 = 正向查询的优先序（与 `carriers` 同口径；合格表里每条名字只有一处，次序不影响结果）。
 * 分组顺序 = 事件 → 代词 → 属性 → 名字函数 → 外部变量 → 存储期 → 演出提示，与四事实面对账序一致。
 */
import type { SurfaceMap, SurfaceMapping } from '../../../../kojo-core/src/surface-map.js';

/** eraTW 的表层↔原生映射表（冻结；条数与四类事实面的名字总数由判据逐列钉住） */
export const ERATW_SURFACE_MAP: SurfaceMap = Object.freeze([
  /* ---------- 事件面：`# 机 <名>` / `@织 <名>` 里填的那个名字 → 引擎事件常量 ---------- */
  Object.freeze({ kind: 'event' as const, surface: '初见', native: 'EVENTFIRST' }),
  Object.freeze({ kind: 'event' as const, surface: '训练', native: 'EVENTTRAIN' }),
  Object.freeze({ kind: 'event' as const, surface: '读档', native: 'EVENTLOAD' }),
  Object.freeze({ kind: 'event' as const, surface: '商店', native: 'EVENTSHOP' }),
  Object.freeze({ kind: 'event' as const, surface: '购买', native: 'EVENTBUY' }),
  Object.freeze({ kind: 'event' as const, surface: '指令', native: 'EVENTCOM' }),
  Object.freeze({ kind: 'event' as const, surface: '训练结束', native: 'EVENTEND' }),
  Object.freeze({ kind: 'event' as const, surface: '回合末', native: 'EVENTTURNEND' }),
  Object.freeze({ kind: 'event' as const, surface: '指令结束', native: 'EVENTCOMEND' }),

  /* ---------- 符号面·代词：`{我}` / `{你}` / `{她}` → 引用模板 ---------- */
  /* `{我}` 与 `{她}` 同指 `TARGET` 是事实面建模过的重合（`# 视角 目标` 时才重合），
     判据按事实面放行；这里照抄那份落点，不另立口径（`domain-symbols.ts` 头注第一条）。 */
  Object.freeze({ kind: 'symbol' as const, surface: '我', native: '%CALLNAME:TARGET%' }),
  Object.freeze({ kind: 'symbol' as const, surface: '你', native: '%CALLNAME:MASTER%' }),
  Object.freeze({ kind: 'symbol' as const, surface: '她', native: '%CALLNAME:TARGET%' }),

  /* ---------- 符号面·角色属性：名字 → `族:编号`（编号是游戏事实） ---------- */
  Object.freeze({ kind: 'symbol' as const, surface: '好感度', native: 'CFLAG:2' }),
  Object.freeze({ kind: 'symbol' as const, surface: '恋慕', native: 'TALENT:3', aliases: Object.freeze(['爱慕']) }),
  Object.freeze({ kind: 'symbol' as const, surface: '恋人', native: 'TALENT:7' }),
  Object.freeze({ kind: 'symbol' as const, surface: '爱欲', native: 'TALENT:184', aliases: Object.freeze(['愛欲']) }),

  /* ---------- 符号面·名字函数：中文名 → 引擎函数名（派生自既有库表，不抄第二份） ---------- */
  Object.freeze({ kind: 'symbol' as const, surface: '角色文本', native: 'CHARA_TEXT' }),
  Object.freeze({ kind: 'symbol' as const, surface: '男性名文本', native: 'PRINT_MALE_CN' }),
  Object.freeze({ kind: 'symbol' as const, surface: '他她', native: 'HE_SHE_CN' }),

  /* ---------- 符号面·外部变量：恒等落点（原生写法就是这个名字本身，作者裸读写） ---------- */
  Object.freeze({ kind: 'symbol' as const, surface: 'TIME', native: 'TIME' }),
  Object.freeze({ kind: 'symbol' as const, surface: 'MONEY', native: 'MONEY' }),
  Object.freeze({ kind: 'symbol' as const, surface: 'RESULTS', native: 'RESULTS' }),
  Object.freeze({ kind: 'symbol' as const, surface: 'RESULT', native: 'RESULT' }),
  Object.freeze({ kind: 'symbol' as const, surface: 'ARG', native: 'ARG' }),

  /* ---------- 存储期面：事实面 `period` → 变量族（`# 设` 的落点族） ---------- */
  Object.freeze({ kind: 'storage' as const, surface: 'scene', native: 'LOCAL' }),
  Object.freeze({ kind: 'storage' as const, surface: 'save', native: 'SAVEDATA' }),
  Object.freeze({ kind: 'storage' as const, surface: 'session', native: 'TCVAR' }),

  /* ---------- 演出面：只收一名一落点的那一格（`(心形)` → 引擎指令名，从库表派生） ---------- */
  Object.freeze({ kind: 'presentation' as const, surface: '心形', native: 'HPH_PRINT' }),
] satisfies readonly SurfaceMapping[]);
