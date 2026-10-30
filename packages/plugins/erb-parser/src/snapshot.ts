/**
 * 索引快照（2026-10-12「内核优化」批 · 例 1：第二次开项目不用再等）。
 *
 * ## 问题
 *
 * `erb-parser` 的索引是纯内存态：每次 `project.opened` 都全量 walkDir → 逐文件
 * readText + parseErbText（2,317 个文件 / 362 万行 ≈ 2.9 s）。而**文件没变时，
 * 解析结果必然不变**——这是纯函数的定义所保证的。
 *
 * ## 方案
 *
 * 按**项目根**把 `{ path → (mtimeMs, size, textLength, ErbFile) }` 存进本插件的存储域
 * （`{appData}/store/erb-parser/<key>.json`）。重新打开项目时：
 *
 * ```
 * walkDir（1 次，顺带 mtime+size）→ 与快照比对：mtime 与 size 都一致 → **直接复用**
 *   → 不一致/缺失/任一侧取不到 → 只重扫这些文件
 *   → 按本次 walk 顺序聚合（与全量重建的 byName 顺序逐位一致）
 *   → 广播 kojo.functionChanged（消费方无感）→ 异步落盘新快照
 * ```
 *
 * ## 纪律
 *
 * - **fail-closed**：快照结构/版本/项目根任一不符 → 整体弃用 + 删除 + 全量重建
 *   （绝不"修"快照——解析错误的结果比慢更危险）。校验是**急**的（decode 时逐元组查完），
 *   懒的只是**还原成对象**这一步；
 * - **保守失效**：mtime 或 size 任一侧为 null（平台未提供/读失败）→ 视为过期；
 * - **顺序确定**：聚合永远按本次 walkDir 的顺序进行，快照只替换"来源"，
 *   不改变 `byName` 的聚合顺序（消费方对顺序的任何假设都不受影响）；
 * - **零游戏知识**：本模块只认识"文件与函数边界"，不认识任何命名约定。
 */
import type { ErbDim, ErbFile, ErbFunction, ErbFunctionRef, ErbLabel, ErbParam, FileStat } from '@kojo/plugin-api';
import type { FileRefs } from './references';
import { REF_STRIDE } from './references';
import { detachString } from './scanner';

/**
 * 快照格式版本（结构不兼容时整体弃用重建）。
 *
 * **v1 → v2**（用户反馈 9）：`ErbFunction` 新增 `docComment`（函数上方紧邻注释块）。
 * 旧快照里没有这个字段，若继续复用会让函数树悬停**静默空白**且无从察觉——
 * 与其悄悄降级，不如按 `coerceSnapshot` 的 fail-closed 语义整体弃用、一次重建。
 * 代价：升级后首次开项目多等一段索引时间（此后照常走快照）。
 *
 * **v2 → v3**（2026-10-12「快照瘦身」）：真实语料实测 v2 = **44.40 MB / 99,104 函数**，
 * 其中 **16.65 MB（38%）是可派生字段**——`function.filePath`(13.34) 与 `file.path`(0.30)
 * 都等于条目键，`function.normalizedName`(3.02) 就是 `name.toUpperCase()`
 * （scanner.ts:263 唯一定义处）；再加**函数对象的键名本身 9.75 MB**。
 * v3 把这三样从盘上去掉（加载时回填），条目与函数改用位置元组 ⇒ 预计降到 ~18 MB，
 * 热启动 `storage.get`（v2 实测 253 ms）应随之等比下降。
 *
 * **v3 → v4**（2026-10-15 H2 反向索引批）：条目追加第 7 位 `refs`
 * （`[归一化名, 行, 列, 种类旗标]` 流水）。反向引用必须在**读盘解析段**顺手产出
 * （文本不许整份留驻），热复用若无盘上 refs 就得二次读全部文件 ⇒ 快照不存等于白热。
 * v3 快照没有 refs ⇒ 版本 bump ⇒ fail-closed 整体弃用、一次冷重建（此后照常热）。
 *
 * **v4 → v5**（2026-10-16 PERF-7 快照批）：两处改动，都是行为修正/信号增强：
 * - 条目追加 `size`（文件**字节数**，与 walkDir/stat 同源）。原失效判据只看 mtime——
 *   "保留时间戳的替换"（拷贝/工具改写）会被静默复用；mtime+size 双判据把它兜住。
 *   注意：**不能拿 `textLength` 当 size 用**——它是解码后的 UTF-16 码元数，与盘上
 *   字节数在 CJK 语料里差 3 倍，直接比会把几乎每份文件判过期（全量重扫）。
 *   `textLength` 保留为惰性还原前的冗余校验位。
 * - 还原改为**两段**：decode 只做校验 + 建"轻外壳"（ErbFile 视图的 `functions`/`dims`
 *   是惰性 getter，refs 直接别名盘上元组数组、零拷贝），重字段在**首次真正消费时**
 *   才建对象。热开时条件抽取/校验只吃 `files` 的路径与统计、编辑器面板按需拉取 ⇒
 *   100k 级函数对象的构造从"开项目"这一班岗上撤下。
 *   v4 快照没有 size ⇒ 版本 bump ⇒ fail-closed 整体弃用、一次冷重建（此后照常热）。
 *
 * **v5 → v6**（2026-10-16 语言服务批）：`ErbFile` 新增 `labels`（函数内 `$` 标签，
 * `$` 标签转定义的数据面）。条目追加第 9 位 `labels`（`[名, 行, 所属函数定义行]` 元组，
 * **恒在**——v4 收 refs 位的同款先例；内存里无标签 = 缺省不挂，与解析器同形）。
 * v5 快照没有 labels ⇒ 版本 bump ⇒ fail-closed 整体弃用、一次冷重建（此后照常热）。
 *
 * **v6 → v7**（2026-10-16 PERF-12a「作废后分段复用」批）：**不靠 bump 省时间，靠"作废不再连坐"**。
 * 此前"整体弃用"的粒度是**整份快照**：版本不符 / rootDir 写法不符 / 任一条目结构不符
 * ⇒ 2,325 条各自完好、元组相符的条目一起作废 ⇒ 全树重读重扫（真语料实测 read+parse 6.9 s
 * ＋ refs scan 7.4 s）。本批把作废粒度打到**逐条目**：
 * - 条目追加第 10 位 `refsNamesFp`＝该条 refs **是在哪张名字表下扫出来的**摘要。
 *   反向引用的判据是全局 `byName`，"文件没变"只保证正文没变、**不保证名录没变**——
 *   旁处新增一个 `@函数` 会让所有未变文件的存量 refs 少一条边（v4 起就有这个洞，
 *   此前无人记账）。有了溯源位，复用条目的 refs 只在"摘要与当前名录相符"时才续用，
 *   不符则标为可疑、由构建轮的溯源巡检就地重扫补正（PS-3 起热轮同样巡检；信封级 `namesFp`
 *   位在"全体条目记账相符"时写入，命中"摘要相等"即整段免巡检）；
 * - **v6 条目照常复用**：v6 与 v7 的前 9 位逐字同义（本批没动解析口径），只缺第 10 位
 *   ⇒ 见 `SALVAGEABLE_VERSIONS` 的准入纪律；缺溯源位 = 可疑 = 结构续用、refs 待补正；
 * - **单条损坏不再连坐**：`salvageSnapshot` 逐条目校验，坏几条只重读那几条；
 * - **rootDir 只是写法不同（大小写/斜杠方向/尾分隔符）不再连坐**：见 `sameProjectRoot`。
 * 版本 bump 仍然 bump（键换代 ⇒ 升级后第一轮走 salvage，此后走热）。
 *
 * **v7 → v8**（2026-10-16 LS-R6 逗号形函数头修复批）：**解析口径变化 ⇒ 旧版一条都不复用**。
 * 真语料 130 处 `@NAME, ARGS, ARG…` 形态此前解析成名字 `"NAME,"` 且形参全丢；修复后
 * 名字不带尾逗号、形参表完整——条目第 1 位（函数名）与形参位的**值语义**变了。
 * 按准入纪律第 1 条（解析器口径没变才准入），v7 及更早**全部不得入表**：升 v8 后
 * 第一轮对存量盘付一次整体冷重建（fail-closed），此后照常热。
 * 「缺溯源位 ⇒ 结构续用 + refs 补正」机制原样保留，待下个**只加位不动口径**的版本重新准入。
 *
 * **v8 → v9**（W-DEF-COL 批）：函数元组追加第 7 位（下标 6）`nameColumn`＝名字起点列
 * （1 基、UTF-16 码元；见 `ErbFunction.nameColumn`）。**位是纯 additive**（前 6 位一字未动），
 * 但本批**不把 v8 放进 `SALVAGEABLE_VERSIONS`**，判据是"这份数据能不能答上这一批要答的问题"，
 * 不是"字段是不是新增的"：
 * - 续用 v8 条目 = 每个**没被改过**的文件都缺第 7 位 ⇒ 定义腿继续只交行、F12 继续落行首，
 *   而且**没有任何读数能说明为什么**（这正是本批要消灭的症状，静默保留它等于没做）；
 * - 同一份盘整体弃用只付一次冷重建（本文件头注的 v7→v8 实测：读+扫 6.9 s ＋ refs 7.4 s /
 *   2,325 文件），此后照常热；`v1→v2` 为 `docComment` 加字段时做的就是同一个取舍。
 * ⇒ 升 v9 后第一轮整体冷重建（fail-closed），此后逐条目 salvage 只在 v9↔v9 之间发生。
 *
 * **v9 → v10**（LS-DIM 批：`#DIM` 族覆盖面）：**条目第 6 位（`dims`）的值语义变了 ⇒ 旧版一条都不复用**。
 * 基线语料实测 2,866 行声明此前把**引擎关键字**记成了变量名（`#DIM DYNAMIC CNT_CHARA` 收进
 * `DYNAMIC`），另有 22 行 `#DEFINE` 一条不收。修复后同一行的 `name` 是另一个字符串——
 * 与 v7→v8 的逗号形修复同判据（准入纪律第 1 条：解析器口径没变才准入），v9 及更早**不得入表**：
 * 升 v10 后第一轮对存量盘付一次整体冷重建（fail-closed），此后照常热。
 *
 * **v10 → v11**（REFS-PROVENANCE 批，2026-10-22）：**条目追加第 11 位 `candidates`**＝
 * 该文件的**候选记号集**——构建 refs 时被拿去问 `hasName` 的一切归一化记号（命中与否都算，
 * 含 `@` 定义名），`'\n'` 连接成一个字符串（记号判据 `\p{L}\p{N}_` ⇒ 不可能含连接符）。
 * 这是"溯源位"从**名录指纹**细化到**逐文件可证**的一步：v10 的溯源位只能回答"这份 refs 是
 * 哪张名录下扫的"，名录一变就得全树重扫（真语料 3,971 文件实测 7.4 s / 离线 worker 1.4 s）；
 * 有了逐文件候选集，构建轮拿"新旧名录的对称差 ∩ 该文件候选集"就能**证明**"名录变了但这份
 * refs 逐字节不变"——真语料实测改/名一个中等用量名字只牵动个位数文件（见交付读数）。
 * 迁移路径**可见且一次性**：v10 条目没有候选位 ⇒ 按准入纪律 3 落在保守侧 = 该条 refs 判
 * "候选未知"，构建轮照常复用其结构、但 refs 要重扫一遍**顺带收候选**（此后逐轮热）；
 * 即升级后第一轮付一次全树 refs 重扫，与 v9→v10 的冷重建同款代价、只付一次。
 * 盘上 `null` = 候选未知（仅 v10 迁移条目会短暂处于此态，下轮落盘前必然补正）；
 * 内存里键**恒在**（含空串 = "已知没有候选"——空文件/无记号文件据此免于永远重扫）。
 *
 * **v11 → v12**（MEM-6 批，2026-10-30）：**第 11 位的值形态换了，语义不变**——
 * v11 存"`'\n'` 连接的记号串"，v12 存"记号**哈希集**的 base64"（内存里是 `Uint32Array`）。
 * 为什么动它：真语料 3,971 份候选集合计 16,968,188 字符，含日文标识符 ⇒ 两字节串 ⇒
 * 稳态堆 **32.0 MB**（消融实测），而它只在"名录变了"那一刻被读一次。换哈希集后 **6.5 MB**
 * （1,703,214 枚 × 4 B），省 **≈25 MB**——202.9 → 177.8 MB。判据为什么不退化见
 * `hashToken` 的注（碰撞只会多扫、不会漏扫）。
 * **迁移是免费的**：v11 的串就在盘上，就地哈希即可，**不重读一个文件、不重扫一次 refs**
 * ——所以 v11 进 `SALVAGEABLE_VERSIONS`（`candidatesAreTokens: true`），与 v10 那种
 * "缺位 ⇒ 保守侧重扫"不是一回事。
 *
 * **v12 → v13**（MEM-7 批，2026-10-30）：**第 8 位（`refs`）的形态换了，语义不变**——
 * v12 是"一条引用一枚四元组"（`[name, line, column, kind]`），v13 是**每文件一枚扁平数组**
 * （`[name, line, column, kind, name, …]`，步长 4）。为什么动它：真语料 3,971 文件 /
 * 341,779 条引用，一条一个数组要付一枚 JSArray 头 + 一枚 FixedArray 底层 ⇒ 稳态
 * **29.1 MB**（消融实测 `refs 引用流水 -29.1MB`，是稳态里最大的一块单一数组），
 * 而它只在 `references.bySymbol` 被首次消费时才读。扁平化后只剩 3,971 枚数组，
 * 4 格里有 3 格是 Smi（内联在 FixedArray、不装箱）⇒ 约 6 MB，省 **≈23 MB**。
 * 判据为什么不退化：字段顺序、语义、排序全部不变，只是**存放形态**变了；读取侧一律走
 * `forEachRef`（步长布局的唯一出处）。
 * **迁移是免费的**：v12 的四元组就在盘上，就地摊平即可，**不重读一个文件、不重扫一次 refs**
 * ——所以 v12 进 `SALVAGEABLE_VERSIONS`（`refsAreTuples: true`）。
 */
export const SNAPSHOT_VERSION = 13;

/**
 * **可以逐条目 salvage 的盘上版本** → 该版本条目元组与当前版本的字段对应关系。
 *
 * 准入纪律（加进这张表之前必须逐条自答，答"是"才准进）：
 * 1. 旧条目的**已有各位含义与当前完全相同**（解析器口径没变、位置没挪）；
 * 2. 新旧差异只能是**新条目多了位**（旧 payload 缺位 ⇒ 该位按"未知"处理，绝不猜值）；
 * 3. 缺位的"未知"必须落在**保守侧**：要么触发一次重扫，要么判该文件过期，不许静默当真。
 *
 * - `13`：同形（11 位；第 8 位 = **扁平**引用流水、第 11 位 = 候选哈希集 base64）。
 * - `12`：同形（11 位）+ **第 8 位是四元组数组**（一条引用一枚 `[name, line, column, kind]`）。
 *   v13 没动解析口径也没动语义，差异只是这一位的**存放形态**；旧形态能就地摊平成新形态
 *   （`refsToFlat`）⇒ 按纪律 1/2/3 准入，且**不落在保守侧**：迁移后语义逐条相同，一个文件都不用重扫。
 * - `11`：同形（11 位）+ **第 11 位是候选记号串**（`'\n'` 连接）+ 第 8 位是四元组数组。
 *   两条差异都能就地翻新（`candidateHashesFromTokens` / `refsToFlat`），同样不落保守侧。
 * - `10`：同形（10 位）+ **缺第 11 位**。v11 没动解析口径（前 10 位逐字同义），差异只是
 *   "新条目多了候选位" ⇒ 按纪律 2/3 准入：缺位 = 候选未知 = 保守侧（refs 重扫一遍补候选，
 *   结构照常复用，见 `SNAPSHOT_VERSION` 头注 v10→v11 的迁移路径）。`hasCandidates: false`
 *   就是给构建轮看的"这批条目必然要付一轮 refs 补扫"的标记。
 * - `9` 及更早**一律不在表**：v10 的 `#DIM` 族修复改了 `dims.name` 的值语义（2,866 行的名字
 *   从引擎关键字变成真名），复用 = 索引脏数据；v9 虽只缺"名字起点列"一位，但续用它等于
 *   静默保留本批要修的症状（缺位的"未知"按纪律 3 本来就得分文件重扫 ⇒ 付一样的钱、多一套分支）；
 *   v7 及更早是逗号形函数头的口径变更。
 */
const SALVAGEABLE_VERSIONS: ReadonlyMap<
  number,
  {
    readonly arity: number;
    readonly hasRefsFp: boolean;
    readonly hasCandidates: boolean;
    /** 第 11 位是 v11 的记号串（需就地哈希），还是 v12 起的哈希集 base64（直接解） */
    readonly candidatesAreTokens: boolean;
    /** 第 8 位是 v12 及更早的**四元组数组**（需就地摊平），还是 v13 的扁平流水（直接用） */
    readonly refsAreTuples: boolean;
  }
> = new Map([
  [13, { arity: 11, hasRefsFp: true, hasCandidates: true, candidatesAreTokens: false, refsAreTuples: false }],
  [12, { arity: 11, hasRefsFp: true, hasCandidates: true, candidatesAreTokens: false, refsAreTuples: true }],
  [11, { arity: 11, hasRefsFp: true, hasCandidates: true, candidatesAreTokens: true, refsAreTuples: true }],
  [10, { arity: 10, hasRefsFp: true, hasCandidates: false, candidatesAreTokens: false, refsAreTuples: true }],
]);

/** 单个文件的快照条目 */
export interface SnapshotEntry {
  /** 构建该条目时的文件 mtime（`readText`/`stat` 同源口径）；null = 平台未提供 → 恒视为过期 */
  readonly mtimeMs: number | null;
  /** 构建该条目时的文件**字节数**（walkDir 顺带 / stat 兜底同源）；null = 取不到 → 恒视为过期 */
  readonly size: number | null;
  /** 冗余校验位：条目文本长度（UTF-16 码元数；**不可与 `size` 混用**——单位不同） */
  readonly textLength: number;
  /**
   * 该文件的解析结果。**懒还原**：`functions` / `dims` 是 getter，首次被读时才建对象；
   * 在此之前只持有盘上元组。消费方读到的值与直接 `parseErbText` 逐字段相同。
   */
  readonly file: ErbFile;
  /**
   * 该文件的反向引用流水（见 `./references` 的 `FileRefs`）。
   * v4 起恒在（缺失 = 结构不符 ⇒ 整体弃用）；构建序 = 行、列升序，聚合序因此确定。
   * **零拷贝**：direct 别名盘上元组的第 7 位（RefTuple 与 RefRun 同形，decode 已逐条验过）。
   */
  readonly refs?: FileRefs;
  /**
   * 这份 `refs` 是在**哪张名录**下扫出来的摘要（`nameSetDigest(index.byName.keys())`）。
   * 反向引用的判据是全局 `byName`，"文件 mtime+size 没变"只保证正文没变，不保证名录没变：
   * 别处新增/删除一个 `@函数` 会让未变文件的存量 refs 少边或多边。
   * 复用条件 = `refsNamesFp === 当前名录摘要`；`undefined` = 溯源未知（v6 及更早的盘上条目）
   * ⇒ 一律判可疑，由**构建轮**的溯源巡检就地重扫补正（PS-3：热轮与 salvage 轮同判据；
   * 补扫结果连新摘要一起落盘 ⇒ 只付这一轮，信封位命中时整段巡检都不走）。
   */
  readonly refsNamesFp?: number;
  /**
   * 该文件的**候选记号哈希集**（REFS-PROVENANCE，2026-10-22；v12 起换哈希，MEM-6）：
   * 构建 `refs` 时被拿去问 `hasName` 的一切归一化记号（命中与否都算，含 `@` 定义名），
   * 每枚取 32 位哈希（`hashToken`）。**空数组 = 已知没有候选**（与"未知"是两回事）。
   * 溯源巡检的逐文件判据：名录新旧对称差（`changedNamesBetween`）里若有名字落在本集
   * ⇒ 这份 refs 可能缺边/多边 ⇒ 重扫；反之可**证明** refs 逐字节不变 ⇒ 只补记新摘要、免扫
   * （`refsProvableUnchanged`）。**键缺席 = 未知**（v10 迁移条目）⇒ 一律重扫补候选。
   *
   * 为什么不是字符串：见 `hashToken` 上面的长注（32.0 MB → 6.5 MB，判据不退化）。
   */
  readonly candidateHashes?: Uint32Array;
}

/** 索引快照（按项目根一份） */
export interface IndexSnapshot {
  readonly version: number;
  /** 快照所属项目根（加载时不匹配即弃用——换盘符/移动项目不复用） */
  readonly rootDir: string;
  readonly savedAt: number;
  readonly entries: Readonly<Record<string, SnapshotEntry>>;
  /**
   * 信封级**名录摘要**（PS-3）：`nameSetDigest(byName.keys())`，**仅当落盘时每条条目
   * 的 `refsNamesFp` 都已等于这份摘要**才写入（`verifiedNamesDigest` 判据；否则为 null）。
   * 于是"信封摘要 === 本轮摘要"是"全部存量 refs 可信"的 O(1) 判据——名录没变时
   * 连逐条目巡检都不用走。缺失/为 null（旧盘形态或某条补扫失败）⇒ 逐条目巡检兜底。
   */
  readonly namesFp?: number | null;
}

/**
 * 快照存储键（FNV-1a 32 位 → 8 位十六进制）。
 *
 * 存储域 key 必须是安全段（`[A-Za-z0-9_][A-Za-z0-9._-]{0,119}`），而项目根是
 * 任意文件系统路径，故只存**哈希**；真实 rootDir 记录在快照值里，加载时校验。
 */
export function snapshotKeyFor(rootDir: string, version: number = SNAPSHOT_VERSION): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < rootDir.length; i++) {
    h ^= rootDir.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `index-v${version}-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * 项目根的**同一性**判据（大小写 / 斜杠方向 / 尾分隔符都不算换项目）。
 *
 * 旧口径拿 `rootDir` 字符串逐字比 ⇒ "同一份盘、写法不同"（用户从 `D:\game\eratw`
 * 与 `D:/games/eratw/` 两个入口各开过一次）会被判成两个项目 ⇒ 整份快照作废。
 * 只归一化**写法**，不归一化**位置**：盘符变了、目录挪了 ⇒ 依然不同项目
 * （条目键是绝对路径，跨项目尾巴撞上也不该由这份快照来答，见 `salvageSnapshot` 的头注）。
 */
export function projectRootKey(rootDir: string): string {
  return rootDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 同一项目根（写法无关） */
export function sameProjectRoot(a: string, b: string): boolean {
  return projectRootKey(a) === projectRootKey(b);
}

/**
 * 加载时依次试探的存储键（**纯函数**）：当前版本键在前，其余按 `SALVAGEABLE_VERSIONS`
 * 准入的版本 × rootDir 的写法变体排在后面。
 *
 * 键里嵌了版本 ⇒ 升级后新键必然不存在（实测 `snapshot get 6ms`＝没捡到），
 * 上一版那份 19 MB 的完好条目就此白白作废。这一列候选键把"换代"从"全树重读"
 * 变成"读旧键一次 + 逐条目复用"。写法变体只生成有限几种（原样 / 正斜杠 / 反斜杠 /
 * 去尾分隔符 / 小写），不做全库扫。
 */
export function snapshotKeyCandidatesFor(rootDir: string): string[] {
  const variants: string[] = [];
  const push = (v: string): void => {
    if (v.length > 0 && !variants.includes(v)) variants.push(v);
  };
  const fwd = rootDir.replace(/\\/g, '/');
  const back = rootDir.replace(/\//g, '\\');
  for (const base of [rootDir, fwd, back]) {
    push(base);
    push(base.replace(/\/+$/, ''));
    push(base.replace(/\\+$/, ''));
    push(base.toLowerCase());
  }
  const out: string[] = [];
  const add = (k: string): void => {
    if (!out.includes(k)) out.push(k);
  };
  add(snapshotKeyFor(rootDir));
  for (const version of SALVAGEABLE_VERSIONS.keys()) {
    for (const v of variants) add(snapshotKeyFor(v, version));
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * v3 起盘上形态：位置元组（只在存储边界使用）
 * ------------------------------------------------------------------------- */

/** `[形参名, 是否有默认值(0|1)]` */
type ParamTuple = [string, 0 | 1];
/**
 * `[原名, 起始行, 结束行, 形参, 位标, 注释块?, 名字起点列?]`；位标 bit0 = 表达式函数
 *
 * 第 7 位（下标 6，v9 起）= `nameColumn`（1 基、UTF-16 码元，见 `ErbFunction.nameColumn`）。
 * 位置契约：**要落第 7 位就必须先把第 6 位写出来**（无注释块时写 `null`）——可选位只能
 * 从前往后连着排，不能跳位。缺席（长度 5/6）＝ **这个索引没有列这个事实**，还原侧一律
 * 留空、绝不补 `1`（补了就是假事实：真语料 230 条定义带前导缩进，最深到第 10 列）。
 * 结束列不落盘（= `nameColumn + name.length`，与 `references.ts` 的 `endColumn` 同一条
 * 可派生纪律，快照瘦身 v3 的原话）。
 */
type FunctionTuple = [string, number, number, ParamTuple[], number, (string | null)?, number?];
/** `[变量名, 声明指令, 行号]` */
type DimTuple = [string, string, number];
/**
 * 盘上第 8 位（下标 7）的**旧形态**：一条引用一枚四元组（v12 及更早）。
 * v13 起内存与盘上都是扁平数组（`FileRefs`，步长见 `references.ts` 的 `REF_STRIDE`）——
 * 这一条只剩"迁移 v12 条目时认得出旧形态"这一个用途。
 */
type RefTuple = [string, number, number, 0 | 1 | 2];
/** `[标签名, 行, 所属函数定义行]`（v6 起；无标签 = 空数组） */
type LabelTuple = [string, number, number];
/** `[mtimeMs, size, textLength, 行数, 有#FUNCTION(0|1), 函数, 声明变量, 引用流水, 标签, refs 名录摘要, 候选记号集]`
 * 第 10 位 v7 起才有；第 11 位（候选集）v11 起才有：
 * - **v12 起内存里是 `Uint32Array`**（候选记号的哈希集，见上面的基元注）；
 * - **v11 的盘上是 `'\n'` 连接的记号串**，v12 的盘上是哈希集的 base64 —— 两者都是 `string`，
 *   靠信封版本区分（`SALVAGEABLE_VERSIONS` 的 `candidatesAreTokens`）；
 * - `null` = 候选未知。
 * v6 的盘上元组是前 9 位（`salvageSnapshot` 按版本表处理） */
type EntryTuple = [
  number | null,
  number | null,
  number,
  number,
  0 | 1,
  FunctionTuple[],
  DimTuple[],
  FileRefs | RefTuple[],
  LabelTuple[],
  number | null,
  string | Uint32Array | null,
];

const FLAG_EXPRESSION = 1;

/* ================= 候选记号集：从 17M 字符的串换成哈希集（MEM-6） =================
 *
 * 为什么换：v11 把每文件的候选记号集存成 `'\n'` 连接的**一个字符串**。真语料实测
 * 3,971 份合计 **16,968,188 字符**；候选记号含日文标识符 ⇒ V8 走两字节串 ⇒ 稳态堆
 * **32.0 MB**（消融实测 `candidates 候选集 -32.0MB`），而它只在"名录变了"那一刻被读。
 * 换成每文件一枚 32 位哈希数组：1,703,214 枚 × 4 B = **6.5 MB**，省 **≈25 MB**。
 *
 * 为什么"哈希"而不是"压缩串"：`refsProvableUnchanged` 要回答的只是**成员判定**
 * （"差集里有没有记号落在这份候选集里"），不需要还原原串。32 位哈希的唯一风险是**碰撞**，
 * 而碰撞的方向只有一种：**把不在集合里的记号判成在** ⇒ 多扫一次文件。判据因此仍然
 * fail-closed——**不可能漏扫**（真在集合里 ⇒ 哈希必在集合里）。
 * 真语料实测：1,189,209 个全局唯一记号 → 1,189,047 个唯一哈希（162 处碰撞，占 0.014%）。
 *
 * 为什么 32 位够：碰撞的代价是"白扫一次"，不是"错数据"。换成 64 位要多花 6.5 MB 换
 * 0.014% 的免扫率，不值。
 *
 * 为什么盘上是 base64 而不是 JSON 数字数组：1.7M 个十进制数字 ≈ 17 MB 文本，
 * base64 是 9.1 MB，且解码是"一次扫过"，不用 `split`/`map` 造 170 万个中间值。
 */

/**
 * 候选记号的 32 位哈希（FNV-1a）。
 *
 * **必须跨进程稳定**：结果会落盘，下次开项目直接拿来比对。所以不能用 `Math.random`
 * 系（`Map` 的字符串哈希那种带种子的），也不能用 `JSON.stringify` 顺序敏感的复合键。
 * FNV-1a 逐码元异或乘质数，同串同值、与平台字节序无关。
 */
export function hashToken(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** 解码用的反查表（`-1` = 非法字符） */
const B64_INVERSE = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) t[B64_ALPHABET.charCodeAt(i)] = i;
  return t;
})();

/**
 * `Uint32Array` → base64。每枚哈希固定写 4 字节、**高位在前**。
 *
 * 不用 `new Uint8Array(arr.buffer)` 直接取视图：那是**平台字节序**，小端机器上写出来的盘
 * 换到大端机器就读反了（虽然今天遇不到，但快照是跨轮、跨机器的数据，不该藏这种依赖）。
 */
export function encodeCandidateHashes(hashes: Uint32Array): string {
  const n = hashes.length;
  if (n === 0) return '';
  const codes = new Uint8Array(Math.ceil((n * 4) / 3) * 4);
  let o = 0;
  let buf = 0;
  let bits = 0;
  for (let k = 0; k < n; k++) {
    const v = hashes[k]!;
    for (let shift = 24; shift >= 0; shift -= 8) {
      buf = (buf << 8) | ((v >>> shift) & 0xff);
      bits += 8;
      if (bits === 24) {
        codes[o++] = B64_ALPHABET.charCodeAt((buf >>> 18) & 63);
        codes[o++] = B64_ALPHABET.charCodeAt((buf >>> 12) & 63);
        codes[o++] = B64_ALPHABET.charCodeAt((buf >>> 6) & 63);
        codes[o++] = B64_ALPHABET.charCodeAt(buf & 63);
        buf = 0;
        bits = 0;
      }
    }
  }
  if (bits > 0) {
    buf <<= 24 - bits;
    codes[o++] = B64_ALPHABET.charCodeAt((buf >>> 18) & 63);
    codes[o++] = B64_ALPHABET.charCodeAt((buf >>> 12) & 63);
    codes[o++] = bits === 8 ? 61 : B64_ALPHABET.charCodeAt((buf >>> 6) & 63);
    codes[o++] = 61;
  }
  // 分块 `fromCharCode`：逐字符 `+=` 在 9 MB 上是几万次 rope 拼接，慢一个量级
  const CHUNK = 8192;
  let out = '';
  for (let i = 0; i < o; i += CHUNK) {
    out += String.fromCharCode.apply(null, codes.subarray(i, Math.min(i + CHUNK, o)) as unknown as number[]);
  }
  return out;
}

/**
 * base64 → `Uint32Array`（`encodeCandidateHashes` 的逆）。非法字符 / 长度不是 4 的倍数 ⇒ `null`
 * （调用方据此判该条目结构不符，走 salvage 的"只丢这一条"）。
 *
 * **按 4 字符一组解**（24 位一组），不用"逐字符累积 `buf`"那种写法：后者在 `bits` 到 30 时
 * 再 `<< 6` 会变成 36 位，而 JS 的 `<<` 是 **int32** 运算 ⇒ 高位静默丢失。
 * 这个洞在单测里一测就现形（哈希全变、免扫判据全部误判为"可证不变"），
 * 但它只表现为"少扫了几个文件"，**不会报错**——所以这里宁可多写几行。
 */
export function decodeCandidateHashes(text: string): Uint32Array | null {
  const len = text.length;
  if (len % 4 !== 0) return null;
  let pad = 0;
  if (len > 0 && text.charCodeAt(len - 1) === 61) pad++;
  if (len > 1 && text.charCodeAt(len - 2) === 61) pad++;
  const bytes = (len / 4) * 3 - pad;
  if (bytes % 4 !== 0) return null;
  const out = new Uint32Array(bytes / 4);
  let o = 0;
  let acc = 0; // 当前哈希已拼好的字节数（0..3）
  let word = 0;
  for (let i = 0; i < len; i += 4) {
    let trip = 0;
    for (let k = 0; k < 4; k++) {
      const c = text.charCodeAt(i + k);
      if (c === 61) {
        trip = (trip << 6) | 0; // '=' 只补零位，真实字节由下面的 `bytes` 数兜住
        continue;
      }
      const v = c < 128 ? B64_INVERSE[c]! : -1;
      if (v < 0) return null;
      trip = (trip << 6) | v;
    }
    for (let shift = 16; shift >= 0; shift -= 8) {
      const b = (trip >>> shift) & 0xff;
      word = (word << 8) | b;
      acc++;
      if (acc === 4) {
        if (o >= out.length) return null;
        out[o++] = word >>> 0;
        word = 0;
        acc = 0;
      }
    }
  }
  return o === out.length ? out : null;
}

/**
 * v11 的候选记号串（`'\n'` 连接）→ 哈希集。**v11 → v12 的迁移路径**：
 * 只把已有的串就地哈希，不重读一个文件、不重扫一次 refs。
 */
export function candidateHashesFromTokens(joined: string): Uint32Array {
  if (joined.length === 0) return new Uint32Array(0);
  const out: number[] = [];
  let i = 0;
  for (;;) {
    const nl = joined.indexOf('\n', i);
    const seg = nl === -1 ? joined.slice(i) : joined.slice(i, nl);
    out.push(hashToken(seg));
    if (nl === -1) break;
    i = nl + 1;
  }
  return Uint32Array.from(out);
}

/**
 * 懒还原的原始元组句柄（Symbol ⇒ 不进 `Object.keys`/JSON/spread）。
 * `aggregateIndex` 凭它直接从元组建 `byName`，不经过 ErbFunction 对象。
 */
const RAW = Symbol('kojo.erb.snapshot.raw');

interface RawCarrier {
  [RAW]?: EntryTuple;
}

/** 惰性还原的一个字段：读一次建对象，随后换成普通值属性（再次读写零开销） */
function materialize<T>(obj: object, key: string, build: () => T): T {
  const built = build();
  Object.defineProperty(obj, key, { value: built, enumerable: true, writable: true, configurable: true });
  return built;
}

/**
 * 把内存条目压成盘上元组：剥掉三样可派生数据（`file.path`、`function.filePath`
 * 都等于条目键；`function.normalizedName` = `name.toUpperCase()`），并把键名换成位置。
 *
 * **快路径**：decode 产出的懒外壳（元组原样、refs 零拷贝、functions/dims 未被动过）直接
 * 复用盘上元组，不重建 100k 级函数元组——落盘路径（改一个文件也要存全库）因此也是
 * "改谁编码谁"。被动过的条目（如 `attachRefs` 换过 refs）走逐字段重建，语义不变。
 *
 * ⚠ **位置契约**：`ErbFile` / `ErbFunction` 增删字段时，这里必须同步改并
 * **bump `SNAPSHOT_VERSION`**——元组不会自动兼容新字段。哨兵测试
 * （`snapshot.test.ts` 的「字段清单哨兵」）会在漏改时直接失败，不靠人记。
 */
export function encodeEntries(entries: Readonly<Record<string, SnapshotEntry>>): Record<string, EntryTuple> {
  const out: Record<string, EntryTuple> = {};
  for (const [path, e] of Object.entries(entries)) {
    const raw = (e.file as RawCarrier)[RAW];
    if (
      raw !== undefined &&
      raw[0] === e.mtimeMs &&
      raw[1] === e.size &&
      raw[2] === e.textLength &&
      raw[7] === (e.refs as unknown) &&
      raw.length === 11 &&
      raw[9] === (e.refsNamesFp ?? null) &&
      // 候选位：内存形态是 `Uint32Array`，与元组第 11 位**是同一枚**（decode 时零拷贝别名）
      // ⇒ 身份比较即可，不必重新编码一遍再比字符串
      raw[10] === (e.candidateHashes ?? null) &&
      // functions/dims 仍是 accessor = 惰性外壳未被消费方动过 ⇒ 元组即真相
      Object.getOwnPropertyDescriptor(e.file, 'functions')?.get !== undefined &&
      Object.getOwnPropertyDescriptor(e.file, 'dims')?.get !== undefined
    ) {
      // **浅拷一层**：内存元组的第 11 位是 `Uint32Array`（不能直接 JSON），盘上要 base64。
      // 浅拷保住了 `[5]`（函数元组数组）等各位的**身份**——快路径要省的正是"重建 10 万级
      // 函数元组"，而拷 11 个槽只付一次 3971 条的小钱。
      const disk = raw.slice() as unknown[];
      const hashes = raw[10];
      disk[10] = hashes instanceof Uint32Array ? encodeCandidateHashes(hashes) : null;
      out[path] = disk as unknown as EntryTuple;
      continue;
    }
    const fns: FunctionTuple[] = e.file.functions.map((f): FunctionTuple => {
      const flags = f.isExpressionFunction ? FLAG_EXPRESSION : 0;
      const params: ParamTuple[] = f.params.map((p): ParamTuple => [p.name, p.hasDefault ? 1 : 0]);
      const fn: FunctionTuple = [f.name, f.startLine, f.endLine, params, flags];
      // 可选位从前往后排：要写第 7 位（列）就必须先把第 6 位（注释块）占住（无注释 = null）
      if (f.nameColumn !== undefined) {
        fn.push(f.docComment ?? null, f.nameColumn);
      } else if (f.docComment !== undefined) {
        fn.push(f.docComment);
      }
      return fn;
    });
    const dims: DimTuple[] = e.file.dims.map((d): DimTuple => [d.name, d.directive, d.line]);
    // refs 与 LabelTuple 同理（懒外壳是别名，重扫结果本来就是同形元组）——不再逐条复制。
    // v13 起 refs 是扁平流水，**盘上与内存同形**（不再有四元组这层壳），所以这里零转换。
    const refs = e.refs ?? [];
    const labels = (e.file.labels ?? []).map((l): LabelTuple => [l.name, l.line, l.functionStartLine]);
    out[path] = [
      e.mtimeMs,
      e.size,
      e.textLength,
      e.file.lineCount,
      e.file.hasFunctionDirective ? 1 : 0,
      fns,
      dims,
      refs,
      labels,
      e.refsNamesFp ?? null,
      // 候选集：键缺席（v10 迁移条目没补扫过）= 未知 = 盘上 null，**不猜空串**。
      // v12 起盘上是哈希集的 base64（空集 = `''`，仍是"已知没有"）
      e.candidateHashes === undefined ? null : encodeCandidateHashes(e.candidateHashes),
    ];
  }
  return out;
}

/** 当前版本条目元组的元数（v11 = 11；第 10 位 = refs 名录摘要、第 11 位 = 候选记号集） */
const CURRENT_ARITY = 11;

function isRefTuple(t: unknown): t is RefTuple {
  return (
    Array.isArray(t) && t.length === 4 && typeof t[0] === 'string' && typeof t[1] === 'number' &&
    typeof t[2] === 'number' && (t[3] === 0 || t[3] === 1 || t[3] === 2)
  );
}

/**
 * v13 的引用流水（扁平，步长 `REF_STRIDE`）逐格校验：每 4 格 = `名字(串), 行, 列, 旗标(0|1|2)`。
 *
 * 校验是**急的**（fail-closed 不打折，与函数/声明/标签各位同一条纪律）：只要有一格不符，
 * 整条判过期、整体弃用，绝不"跳过坏的继续用好的"——那会让引用面板少几条边而无人知晓。
 */
function isRefsFlat(t: unknown): t is FileRefs {
  if (!Array.isArray(t) || t.length % REF_STRIDE !== 0) return false;
  for (let i = 0; i < t.length; i += REF_STRIDE) {
    if (typeof t[i] !== 'string') return false;
    if (typeof t[i + 1] !== 'number' || typeof t[i + 2] !== 'number') return false;
    const kind = t[i + 3];
    if (kind !== 0 && kind !== 1 && kind !== 2) return false;
  }
  return true;
}

/**
 * v12 及更早的四元组数组 → v13 的扁平流水（**就地摊平，不重扫**）。
 *
 * 迁移是免费的：字段顺序、语义、排序一字未改，只是把 341,779 枚短数组摊成 3,971 枚长数组
 * ——这正是 MEM-7 要省的那 23 MB。`refsAreTuples` 为假的版本不调它（已经是扁平形态）。
 */
function refsToFlat(tuples: readonly RefTuple[]): FileRefs {
  const out: (string | number)[] = new Array(tuples.length * REF_STRIDE);
  let o = 0;
  for (const [name, line, column, kind] of tuples) {
    out[o++] = name;
    out[o++] = line;
    out[o++] = column;
    out[o++] = kind;
  }
  return out;
}

function isLabelTuple(t: unknown): t is LabelTuple {
  return Array.isArray(t) && t.length === 3 && typeof t[0] === 'string' && typeof t[1] === 'number' && typeof t[2] === 'number';
}

function isFunctionTuple(t: unknown): t is FunctionTuple {
  if (!Array.isArray(t) || (t.length !== 5 && t.length !== 6 && t.length !== 7)) return false;
  if (typeof t[0] !== 'string' || typeof t[1] !== 'number' || typeof t[2] !== 'number') return false;
  if (typeof t[4] !== 'number' || !Array.isArray(t[3])) return false;
  // 第 6 位（注释块）：v8 的老形态只允许字符串；长度到 7 才允许 `null`（= 占位，为的是排第 7 位）
  if (t.length === 6 && typeof t[5] !== 'string') return false;
  if (t.length === 7 && !(typeof t[5] === 'string' || t[5] === null)) return false;
  // 第 7 位（名字起点列）：1 基整数码元列；缺失 = 没有这个事实，坏值 = 整条判过期（不猜、不改正）
  if (t.length === 7 && (!Number.isInteger(t[6]) || (t[6] as number) < 1)) return false;
  return (t[3] as unknown[]).every(
    (p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && (p[1] === 0 || p[1] === 1),
  );
}

/**
 * **逐条目**结构校验（`arity` / `refsAreTuples` 由版本表给：v13 = 11 位扁平、v12 = 11 位四元组、
 * v10 = 10 位）。
 * 通过 ⇒ 归一成 11 位、第 8 位归成**扁平**流水的元组（v10 缺的第 11 位补 `null` = 候选未知，
 * **不猜值**；v12 及更早的四元组就地摊平，**不重扫**）；不通过 ⇒ null。
 * 校验是急的：函数/声明/引用/标签每一位都查完才返回（懒还原不打折 fail-closed）。
 */
function validateEntryTuple(t: unknown, arity: number, refsAreTuples: boolean): EntryTuple | null {
  if (!Array.isArray(t) || t.length !== arity) return null;
  if (t[0] !== null && typeof t[0] !== 'number') return null;
  if (t[1] !== null && typeof t[1] !== 'number') return null;
  if (typeof t[2] !== 'number' || typeof t[3] !== 'number') return null;
  if (t[4] !== 0 && t[4] !== 1) return null;
  if (!Array.isArray(t[5]) || !Array.isArray(t[6]) || !Array.isArray(t[7]) || !Array.isArray(t[8])) return null;
  // 第 10 位（refs 名录摘要）：v7 起才有（表内版本都 ≥10；arity 9 的调用只剩测试面上的旧形态语义）
  if (arity >= 10 && t[9] !== null && typeof t[9] !== 'number') return null;
  // 第 11 位（候选集）：v11 起才有；v10 迁移条目归一时补 null = 候选未知（保守侧，不猜空串）。
  // v12 起内存形态是 `Uint32Array`（盘上仍是 string）⇒ 两种都认：校验发生在"盘上 JSON"这一侧，
  // 但同一函数也被用来复核内存元组（`encodeEntries` 快路径判据），别把内存形态判成损坏。
  if (
    arity === CURRENT_ARITY &&
    t[10] !== null &&
    typeof t[10] !== 'string' &&
    !(t[10] instanceof Uint32Array)
  ) {
    return null;
  }
  const fns = t[5] as unknown[];
  const dims = t[6] as unknown[];
  const refs = t[7] as unknown[];
  const labels = t[8] as unknown[];
  if (!fns.every(isFunctionTuple)) return null;
  if (!dims.every((d) => Array.isArray(d) && d.length === 3 && typeof d[0] === 'string' && typeof d[1] === 'string' && typeof d[2] === 'number')) {
    return null;
  }
  // 引用流水：v13 是扁平（步长 4），v12 及更早是四元组数组。两种都**逐格**查完，
  // 旧形态查过之后就地摊平（免费迁移，见 `refsToFlat`）。
  if (refsAreTuples) {
    if (!refs.every(isRefTuple)) return null;
  } else if (!isRefsFlat(refs)) {
    return null;
  }
  if (!labels.every(isLabelTuple)) return null;
  // 当前形态**原样返回**（不复制）：`encodeEntries` 的落盘快路径靠"元组还是盘上那个对象"来免重建，
  // 复制一下就让 100k 级条目全走重建路径了；旧形态才补缺位（null = 该位未知，不猜值）
  const arr = t as unknown[];
  const normalized: unknown[] = arity === CURRENT_ARITY ? arr : [...arr, null];
  if (refsAreTuples) normalized[7] = refsToFlat(refs as unknown as RefTuple[]);
  return normalized as unknown as EntryTuple;
}

function toFunction(path: string, [name, startLine, endLine, params, flags, doc, nameColumn]: FunctionTuple): ErbFunction {
  return {
    name,
    normalizedName: name.toUpperCase(),
    params: params.map(([pname, hasDefault]): ErbParam => ({ name: pname, hasDefault: hasDefault === 1 })),
    startLine,
    endLine,
    filePath: path,
    // 列缺席（v8 及更早的盘上条目 / 编码时算不出）⇒ **不留这个键**：定义腿据此退化成只给行。
    // 这里最不该做的事是 `nameColumn ?? 1`——那会把"不知道"写成"就在行首"，假事实一旦落盘就再也查不出来。
    ...(nameColumn === undefined || nameColumn === null ? {} : { nameColumn }),
    // scanner 对每个函数都显式写这个布尔（false 也在），还原必须同样显式，不能缺键
    isExpressionFunction: (flags & FLAG_EXPRESSION) !== 0,
    ...(typeof doc === 'string' ? { docComment: doc } : {}),
  };
}

/**
 * 建懒还原的 ErbFile 视图：字段与 `parseErbText` 的产物同形同值，但 `functions`/`dims`
 * 是 getter（首次读才建对象）。`aggregateIndex` 见到 RAW 标记就直接吃元组，
 * 因此"热开时的聚合"不必先把 100k 级函数对象建出来。
 */
function lazyFile(path: string, tuple: EntryTuple): ErbFile {
  const [, , , lineCount, hasDirective, fns, dims, , labels] = tuple;
  const file: ErbFile = {
    path,
    hasFunctionDirective: hasDirective === 1,
    lineCount,
    // 无标签 = 缺省不挂（与 parseErbText 同形同值：不给空数组）
    ...(labels.length > 0
      ? { labels: labels.map(([name, line, fnLine]): ErbLabel => ({ name, line, functionStartLine: fnLine })) }
      : {}),
    get functions(): ErbFunction[] {
      return materialize(file, 'functions', () => fns.map((t) => toFunction(path, t)));
    },
    get dims(): ErbDim[] {
      return materialize(file, 'dims', () => dims.map(([name, directive, line]): ErbDim => ({ name, directive, line })));
    },
  };
  Object.defineProperty(file, RAW, { value: tuple, enumerable: false });
  return file;
}

/** 校验过的元组 → 内存条目（键即路径 ⇒ 回填 `file.path` / `function.filePath`） */
/**
 * 把一枚条目元组里的**所有字符串**过一遍去重表（就地改，不重建元组）。
 *
 * 为什么就地改而不是重建：`refs` 是**零拷贝**别名（`e.refs === tuple[7]`，
 * `encodeEntries` 的快路径靠这个身份判据免重建）。重建 61 万个元组会瞬时造出
 * 20 MB 垃圾、还得让身份判据失效——得不偿失。元组内容不改语义，只换实例。
 *
 * 覆盖的位置就是"逐条重复率最高"的那几格：函数名、注释块、形参名、声明名、
 * 引用名（重复量最大，61 万条引用只有 10 万个不同名字）、标签名。
 */
function internEntryStrings(tuple: EntryTuple, interner: NameInterner): void {
  for (const fn of tuple[5]) {
    fn[0] = interner.intern(fn[0]);
    const doc = fn[5];
    if (typeof doc === 'string') fn[5] = interner.intern(doc);
    for (const p of fn[3]) p[0] = interner.intern(p[0]);
  }
  for (const d of tuple[6]) d[0] = interner.intern(d[0]);
  // 引用流水是扁平数组（v13）：名字在第 0 格，步长 `REF_STRIDE`——这里只换实例、不动布局
  const refs = tuple[7] as (string | number)[];
  for (let i = 0; i < refs.length; i += REF_STRIDE) refs[i] = interner.intern(refs[i] as string);
  for (const l of tuple[8]) l[0] = interner.intern(l[0]);
}

/**
 * 把第 11 位（候选集）从**盘上形态**翻成**内存形态**（`Uint32Array`），就地写回元组。
 *
 * 就地而不重建：与 `internEntryStrings` 同一条理由——`encodeEntries` 的落盘快路径靠
 * "元组还是盘上那个对象"来免重建 10 万级函数元组，重建元组会把这个身份判据废掉。
 *
 * `tokens`（v11 的记号串）走 `candidateHashesFromTokens`（免费的版本迁移）；
 * 否则按 base64 解；解不出来 ⇒ 返回 `false`（调用方判该条目结构不符，只丢这一条）。
 */
function candidatesToMemory(tuple: EntryTuple, tokens: boolean): boolean {
  const slot = tuple[10];
  if (slot === null || slot instanceof Uint32Array) return true;
  const hashes = tokens ? candidateHashesFromTokens(slot) : decodeCandidateHashes(slot);
  if (hashes === null) return false;
  tuple[10] = hashes;
  return true;
}

function entryFromTuple(path: string, tuple: EntryTuple, interner?: NameInterner): SnapshotEntry {
  if (interner !== undefined) internEntryStrings(tuple, interner);
  const refsNamesFp = tuple[9];
  const candidateHashes = tuple[10];
  return {
    mtimeMs: tuple[0],
    size: tuple[1],
    textLength: tuple[2],
    file: lazyFile(path, tuple),
    refs: tuple[7] as FileRefs, // 同形零拷贝（见 SnapshotEntry.refs 注）
    // 溯源未知（v6 补的 null）⇒ **不留这个键**：与"条目本来没这个字段"同形，
    // 也让 round-trip 判据（decodeEntries(encodeEntries(x))toEqual x）不被 null 撑歪
    ...(typeof refsNamesFp === 'number' ? { refsNamesFp } : {}),
    // 候选集：空数组也是已知事实（已知没有候选），**键照留**——只有 null（v10 迁移未知）才缺键。
    // 零拷贝：与元组第 11 位是**同一枚** `Uint32Array`（`encodeEntries` 的快路径靠这个身份判据）
    ...(candidateHashes instanceof Uint32Array ? { candidateHashes } : {}),
  };
}

/**
 * 还原盘上元组为内存条目（**当前版本**形态，11 位）；结构任一不符 ⇒ null（整体弃用）。
 *
 * 走这里的只有"当前键 + 当前版本"那份快照；旧版本 / 部分损坏的盘上数据由
 * `salvageSnapshot` 逐条目处理（PERF-12a）。
 *
 * **校验急、还原懒**：每个函数元组 / 声明元组 / 引用元组在 decode 时逐条查完
 * （fail-closed 不打折），查过之后对象构造才推迟。
 */
/**
 * 解码期的**同内容字符串去重表**（MEM-4，2026-10-29）。
 *
 * 为什么需要：快照把函数名 / 归一化名 / 注释块**逐条**落在元组里，同一个名字在 61 万条
 * 引用里各存一份实例——真语料实测 `ADD_FAMILY_NAME_K` 有 154,975 个实例（5.9 MB），
 * 全库重复串合计 **772,329 个多余实例 / 31.3 MB**。V8 只 intern 字面量，不 intern
 * `JSON.parse` 出来的运行时串，所以解码时过一遍表，让同内容的串共享一枚实例。
 *
 * 为什么同时 `detachString`：解码出来的串是**那份 44.7M 字符 payload 的切片**（V8 的
 * `JSON.parse` 对长串造 `SlicedString`），不摊平就等于把整份 payload 钉在堆里——与
 * PITFALLS 255 同一个坑，只是这条在"从盘上读回来"的路上。
 *
 * 表的寿命：只活到解码结束（随后即可回收），**不进稳态**——它只是这一趟的脚手架。
 *
 * **代价（2026-10-30 补记，MEM-5 批发现）**：这一趟要过约 90 万次 `Map.get`（引用名 61 万
 * + 函数名/注释/形参/声明/标签），热载解码实测 **+66 ms**（合成 2,000 文件 / 100k 函数口径：
 * 99 → 165 ms）。这笔钱此前**没有记账**，直接把 `snapshot-hot-load.perf.test.ts` 的
 * `after ≤ before` 打破——那个 A/B 的 before 臂是"改动前的解码"冻结副本，不含本表，
 * 于是它量到的是"去重表的开销"而不是"急 vs 懒"。修法是让 before 臂付同一笔（见该测试），
 * **不是放宽断言**。导出这个工厂就是为了那条测试不必再抄一份同口径实现。
 */
export interface NameInterner {
  intern(value: string): string;
}
export function createNameInterner(): NameInterner {
  const table = new Map<string, string>();
  return {
    intern(value: string): string {
      const hit = table.get(value);
      if (hit !== undefined) return hit;
      const fresh = detachString(value);
      table.set(fresh, fresh);
      return fresh;
    },
  };
}

export function decodeEntries(raw: unknown): Record<string, SnapshotEntry> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const out: Record<string, SnapshotEntry> = {};
  const interner = createNameInterner();
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    const tuple = validateEntryTuple(value, CURRENT_ARITY, false);
    if (tuple === null) return null;
    // 盘上第 11 位是哈希集的 base64 ⇒ 解成 `Uint32Array`（就地写回，见 `candidatesToMemory`）。
    // 解不出来（非法字符/长度不符）⇒ 与"结构不符"同判：这份数据整体不认。
    if (!candidatesToMemory(tuple, false)) return null;
    out[path] = entryFromTuple(path, tuple, interner);
  }
  return out;
}

/** 路径的**对号入座**键（写法无关：斜杠方向 + 大小写 + 尾分隔符） */
function pathKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/**
 * 逐条目 salvage（**纯函数**，PERF-12a 的"作废不连坐"）：结构不符的条目**只丢那一条**，
 * 其余原样还原成可复用条目。
 *
 * `keyToPath`（本次 walkDir 的路径表，按 `pathKey` 索引）负责把条目键**对号入座**到
 * 本轮真正在盘上的那串写法——rootDir 换了写法（`\` vs `/`、大小写）时条目键也跟着换写法，
 * 不归位就一条都认不出、白 salvage 一场。归位发生在建懒外壳**之前**，
 * 所以 `file.path` / `function.filePath` 用的就是本轮的写法（下游按路径比对才不串）。
 *
 * 与 `decodeEntries` 的分工不是"松一档"而是**换了粒度**：`decodeEntries` 的 fail-closed
 * 说的是"这份数据的形状不是我认识的那份 ⇒ 一条都不信"，那由**信封版本**（`salvageSnapshot`
 * 的版本表）决定；进了版本表之后，单条目结构不符只是"这一条我读不懂" ⇒ 那一条判过期、
 * 由调用方重读该文件——重读的结果是真值，不存在"复用错数据"的可能。
 */
export function salvageEntries(
  raw: unknown,
  arity: number,
  keyToPath?: ReadonlyMap<string, string>,
  /** 第 11 位是 v11 的记号串（`true`）还是 v12 起的哈希集 base64（`false`）；见版本表 */
  candidatesAreTokens = false,
  /**
   * 第 8 位是 v12 及更早的**四元组数组**（`true`，就地摊平）还是 v13 的扁平流水（`false`）。
   * 缺省 `true` = 最老的在表形态，让"只传 arity 的调用"（含单测夹具）语义不变；
   * 生产路径由 `salvageSnapshot` 按版本表显式传。
   */
  refsAreTuples = true,
): { entries: Record<string, SnapshotEntry>; skipped: number } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, SnapshotEntry> = {};
  let skipped = 0;
  // **salvage 也要过 MEM-4 的去重表**（MEM-6 批补）。此前只有 `decodeEntries` 挂表，
  // 而"版本换代后的第一轮"走的恰恰是这里 ⇒ 那一轮白丢 26 MB（真语料实测：
  // 同一条代码，salvage 轮索引就绪 184.7 MB / 纯热轮 158.8 MB）。
  // 去重是语义中性的（同内容的串共享一枚实例），顺带把 `JSON.parse` 造出来的切片摊平，
  // 不让 67 MB 的 payload 被这些切片钉在堆里（PITFALLS 255 的同一个坑）。
  const interner = createNameInterner();
  for (const [stored, value] of Object.entries(raw as Record<string, unknown>)) {
    const tuple = validateEntryTuple(value, arity, refsAreTuples);
    if (tuple === null) {
      skipped++;
      continue;
    }
    // 候选位翻成内存形态；解不出来 ⇒ 只丢这一条（与结构不符同判，不连坐）
    if (!candidatesToMemory(tuple, candidatesAreTokens)) {
      skipped++;
      continue;
    }
    const path = keyToPath?.get(pathKey(stored)) ?? stored;
    out[path] = entryFromTuple(path, tuple, interner);
  }
  return { entries: out, skipped };
}

/** salvage 的产出（`salvageSnapshot` 的返回） */
export interface SalvagedSnapshot extends IndexSnapshot {
  /** 结构不符被丢弃、需要重读重扫的条目数 */
  readonly skipped: number;
  /** 来自**旧版本**盘上形态（条目缺 refs 名录摘要 ⇒ 其 refs 一律标为可疑） */
  readonly legacy: boolean;
  /** 装载用的键（供"换代后必须改写回当前键"的判定） */
  readonly key: string;
}

/**
 * 把**任意候选键**上的盘上数据 salvage 成可用快照（**纯函数**，不碰存储）。
 *
 * 判据顺序（任一步不过 ⇒ null ⇒ 该键整体 unusable，绝不全盘当真）：
 * 1. `version` 必须在 `SALVAGEABLE_VERSIONS` 里（准入纪律见那张表的头注）——
 *    不在表里 = 条目字段含义不可证 = **一条都不复用**（≤v5 缺 `labels` 就是这种）；
 * 2. `rootDir` 必须是同一项目根（写法无关，见 `sameProjectRoot`）——
 *    盘符变了 / 目录挪了 ⇒ 不是同一项目 ⇒ 不复用（条目键是绝对路径，跨项目不许对号入座）；
 * 3. `savedAt` 必须是有限数；
 * 4. 条目逐条校验，坏几条丢几条（`skipped`）。
 */
export function salvageSnapshot(
  raw: unknown,
  opts: { readonly rootDir: string; readonly key: string; readonly knownPaths?: readonly string[] },
): SalvagedSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const shape = SALVAGEABLE_VERSIONS.get(r.version as number);
  if (shape === undefined) return null;
  if (typeof r.rootDir !== 'string' || !sameProjectRoot(r.rootDir, opts.rootDir)) return null;
  if (typeof r.savedAt !== 'number' || !Number.isFinite(r.savedAt)) return null;
  let keyToPath: Map<string, string> | undefined;
  if (opts.knownPaths !== undefined) {
    keyToPath = new Map();
    for (const p of opts.knownPaths) keyToPath.set(pathKey(p), p);
  }
  const salvaged = salvageEntries(r.entries, shape.arity, keyToPath, shape.candidatesAreTokens, shape.refsAreTuples);
  if (salvaged === null) return null;
  return {
    version: SNAPSHOT_VERSION,
    rootDir: opts.rootDir,
    savedAt: r.savedAt,
    entries: salvaged.entries,
    // 信封名录摘要原样带上（只认数；旧盘没这一位 ⇒ 逐条目巡检）。不变量"信封命中 ⇒ 全体条目
    // 相符"由**写侧**（`verifiedNamesDigest`）保证，salvage 只搬运条目与信封，不新造摘要。
    ...(typeof r.namesFp === 'number' ? { namesFp: r.namesFp } : {}),
    skipped: salvaged.skipped,
    legacy: !shape.hasRefsFp,
    key: opts.key,
  };
}

/**
 * 建一枚 `ErbFunctionRef`（两条聚合路径共用，键序与旧的内联写法逐字一致：
 * name → normalizedName → filePath → startLine → endLine → [nameColumn] → [docComment]）。
 *
 * ## 为什么**不**换成"固定形状字面量"（MEM-9，2026-10-30 量过三条路线）
 *
 * 真实语料、隔离于其它插件、同一条 `decodeBuckets`，`byName + files Map` 三次实测：
 * - 条件展开（本函数，基线）：**33.2 MB**；
 * - "字面量建 5 键 + `if` 补位"：**35.7 MB**——补位让 in-object 槽用尽后另挂一条
 *   `PropertyArray`，**反向优化**；
 * - 四种形状各写一条完整字面量：**32.8 MB**，与基线在噪声内。
 * ⇒ `byName` 的 **311 B/条**（32.7 MB / 110,073 条）**不是条件展开的锅**，是"11 万枚
 * 1 元素数组 + 11 万枚对象 + 11 万条 Map 项 + 11 万条大写名串"的结构成本；真要压下去
 * 只能改结构（列式 + 视图），属单独立项（见 STATE 的 MEM-9 行）。
 * 真正把这一块压下来的是**数组的建法**（见 `aggregateIndex` 里的 `[ref]`）：−13.5 MB。
 */
function makeRef(
  name: string,
  normalizedName: string,
  filePath: string,
  startLine: number,
  endLine: number,
  nameColumn: number | null | undefined,
  docComment: string | null | undefined,
): ErbFunctionRef {
  return {
    name,
    normalizedName,
    filePath,
    startLine,
    endLine,
    // 第 6 位 = 注释块、第 7 位 = 名字起点列（v9 起；旧条目没有 ⇒ 留空，不补 1）
    ...(nameColumn === undefined || nameColumn === null ? {} : { nameColumn }),
    ...(typeof docComment === 'string' ? { docComment } : {}),
  };
}

/**
 * 聚合为索引（`files` + `byName`）。
 *
 * 从 `plugin.ts` 的内联循环抽出：**全量重建**与**快照复用**必须走同一份聚合代码，
 * 否则两条路径会悄悄分叉。顺序 = 传入顺序 = 本次 walkDir 顺序。
 *
 * `sources` 可混装：本次重扫的 `ErbFile` 与快照懒外壳（带 RAW 标记）。后者直接
 * 从元组建 `byName`（`name.toUpperCase()` 与 `toFunction` 同一条口径）⇒ 聚合阶段
 * 不触发任何 ErbFunction 对象的构造；`files` 里存的就是那个懒视图，消费方读
 * `functions` 时才按文件补齐。
 */
export function aggregateIndex(sources: Iterable<ErbFile>): {
  files: Map<string, ErbFile>;
  byName: Map<string, ErbFunctionRef[]>;
} {
  const fileMap = new Map<string, ErbFile>();
  const byName = new Map<string, ErbFunctionRef[]>();
  for (const file of sources) {
    const path = file.path;
    fileMap.set(path, file);
    const raw = (file as RawCarrier)[RAW];
    if (raw !== undefined) {
      for (const t of raw[5]) {
        const name = t[0];
        const normalizedName = name.toUpperCase();
        const ref = makeRef(name, normalizedName, path, t[1], t[2], t[6], t[5]);
        // **首条定义用 `[ref]` 字面量**，不要 `get() ?? []` 再 `push`：空字面量 push 一枚时
        // V8 按 `容量 = 需求 + 16` 重新分配（1 槽 → **17 槽**，底层 FixedArray 152 B vs 24 B），
        // 而真实语料 110,049 个名字里有 **110,043 个只有一条定义** ⇒ 白占 ~13.5 MB
        // （PITFALLS 271 的同款：容量看不见，`length` 也不反映它）。
        const refs = byName.get(normalizedName);
        if (refs === undefined) byName.set(normalizedName, [ref]);
        else refs.push(ref);
      }
      continue;
    }
    for (const fn of file.functions) {
      const ref = makeRef(fn.name, fn.normalizedName, fn.filePath, fn.startLine, fn.endLine, fn.nameColumn, fn.docComment);
      const refs = byName.get(fn.normalizedName);
      if (refs === undefined) byName.set(fn.normalizedName, [ref]);
      else refs.push(ref);
    }
  }
  return { files: fileMap, byName };
}

/**
 * 索引快照的存储键形态（`snapshotKeyFor` 的产出）：`index-v<版本>-<8 位十六进制>`。
 * 清理时用它识别"确实是索引快照"，绝不误删同域里的其它文件。
 */
const SNAPSHOT_KEY_RE = /^index-v\d+-[0-9a-f]{8}$/;

/**
 * 该删掉的旧快照键（**纯函数**，可单测）。
 *
 * 语义（2026-10-16 PERF-7 批修订）：**保留 = 本会话工作集**
 * （`keepKeys` = 本会话已构建过的各项目键），其余索引快照键（含格式升级遗留的
 * `index-v1-*` / `v2-*` 孤儿）一律清理。
 *
 * 为什么不是"只留当前项目那一份"（上一版语义）：那会让**交替开两个游戏目录**
 * 演变成"每次切换都全冷重建"——A 存盘即删 B 的键，回头开 B 又全冷……
 * 实测（合成 2,000 文件口径）交替 3 轮 6 次全冷。作者拿两三个版本对拍是真实工作流
 * （本仓 STATE 就挂着三盘语料），每次切换付一次冷索引（真语料 ~2.3 s）不是可接受的代价。
 *
 * 为什么不是"全部保留"：开过的项目越多攒得越多、永不回收（v3 每份约 12 MB），
 * 单文件覆盖式（抽取/校验两段）的初衷就是用**有界**换"不留无上限的磁盘口子"。
 * 本会话工作集给两条约束一个交点：常用项目的来回切换落在工作集内（热），
 * 工作集之外的旧键在下次构建时回收（界 = 一次会话摸过的项目数）。
 * 代价说清楚：跨会话首次打开别的项目仍可能清掉未入工作集的旧键——那一次是冷的。
 */
export function pruneSnapshotKeys(keys: readonly string[], keepKeys: string | readonly string[]): string[] {
  const keep = typeof keepKeys === 'string' ? new Set([keepKeys]) : new Set(keepKeys);
  return keys.filter((k) => SNAPSHOT_KEY_RE.test(k) && !keep.has(k));
}

/** 快照比对结果 */
export interface SnapshotDiff {
  /** mtime 与 size 都一致、可直接复用解析结果的文件 */
  readonly reusable: string[];
  /** 需要重新读盘解析的文件（缺失 / mtime 或 size 变了 / 任一侧不可判） */
  readonly stale: string[];
}

/**
 * 比对快照与当前文件清单（**纯函数**）。
 *
 * 判据 = **mtimeMs 与 size 双等**。`stats` 取自 walkDir 顺带 / `io.stat` 兜底
 * ——与构建条目时同源（内核 readText 内部就是 stat），口径一致才可比。
 * 任一侧为 null（平台未提供 / stat 失败）一律判过期：size 是"mtime 同值替换"
 * （保留时间戳的拷贝/工具改写）的唯一防线，取不到就不敢复用。
 */
export function diffSnapshot(
  snapshot: IndexSnapshot,
  paths: readonly string[],
  stats: ReadonlyMap<string, FileStat | null>,
): SnapshotDiff {
  const reusable: string[] = [];
  const stale: string[] = [];
  for (const p of paths) {
    const entry = snapshot.entries[p];
    const st = stats.get(p) ?? null;
    const fresh =
      entry !== undefined &&
      entry.mtimeMs !== null &&
      entry.size !== null &&
      st !== null &&
      st.mtimeMs === entry.mtimeMs &&
      st.size === entry.size;
    (fresh ? reusable : stale).push(p);
  }
  return { reusable, stale };
}

/**
 * 名录摘要**信封位**（PS-3）：全部条目的 `refsNamesFp` 都等于当前摘要才把摘要写进信封，
 * 否则给 null（含"某条条目溯源未知/补扫失败"的情形）。信封命中"摘要相等"因此**蕴含**
 * "全部存量 refs 与当前名录相符"——巡检可以整段跳过。判定只看条目自身记的账，
 * 不看名录本身，所以旧盘（无信封位）只是走慢路（逐条目巡检），不会走错路。
 */
export function verifiedNamesDigest(entries: Readonly<Record<string, SnapshotEntry>>, currentDigest: number): number | null {
  for (const path in entries) {
    if (entries[path]!.refsNamesFp !== currentDigest) return null;
  }
  return currentDigest;
}

/** 纯计数（不物化 2,325 条键数组；只服务读数行与 dirty 判据） */
export function countEntries(entries: Readonly<Record<string, SnapshotEntry>>): number {
  let n = 0;
  for (const _k in entries) n++;
  return n;
}

/**
 * 跨轮保留的快照条目的**结构普查**（MEM 批的量测面，纯读：不物化懒外壳、不读盘）。
 *
 * 为什么需要它：热载稳态里这份条目是最大的一块常驻，但它藏在插件的闭包里，
 * 外面只能拿"索引总量 − `byName`"倒推（上一轮就是这么推的，结论是"约 112 MB"，
 * 但说不清是元组、refs 还是候选集占的）。有了这组数，压哪一格就不用猜。
 *
 * `lazyShells` / `materialized` 分开报：只有还带 RAW 元组的条目才走快路径，
 * 被消费方动过（`functions` 已被读）的条目会退回对象形态、成本另算——
 * 把两者混成一个数会把"懒还原被破坏"这件事藏起来。
 */
export interface SnapshotStats {
  entries: number;
  /** 还带盘上元组（未被物化）的条目数 */
  lazyShells: number;
  /** 已被物化的条目数（`functions` 已建对象，成本不在本表里） */
  materialized: number;
  /** 正文总码元数（条目的 `textLength` 合计，与 `size` 单位不同） */
  textLength: number;
  functions: number;
  dims: number;
  /** 反向引用流水条目合计（RefTuple 数） */
  refs: number;
  labels: number;
  /** 函数名字符数合计 */
  nameChars: number;
  /** 注释块字符数合计 */
  docChars: number;
  /** 候选记号**哈希**枚数合计（v12；每枚 4 B ⇒ 稳态占用 ≈ 本数 × 4） */
  candidateHashes: number;
  /** 带候选集的条目数（`null` = 未知，v10 迁移条目） */
  candidatesKnown: number;
  /** 带 refs 的条目数 */
  withRefs: number;
}

export function snapshotStats(entries: Readonly<Record<string, SnapshotEntry>>): SnapshotStats {
  const s: SnapshotStats = {
    entries: 0,
    lazyShells: 0,
    materialized: 0,
    textLength: 0,
    functions: 0,
    dims: 0,
    refs: 0,
    labels: 0,
    nameChars: 0,
    docChars: 0,
    candidateHashes: 0,
    candidatesKnown: 0,
    withRefs: 0,
  };
  for (const path in entries) {
    const e = entries[path]!;
    s.entries++;
    s.textLength += e.textLength;
    if (e.refs !== undefined) s.withRefs++;
    const cand = e.candidateHashes;
    if (cand !== undefined) {
      s.candidatesKnown++;
      s.candidateHashes += cand.length;
    }
    const raw = (e.file as RawCarrier)[RAW];
    if (raw === undefined) {
      s.materialized++;
      continue;
    }
    s.lazyShells++;
    for (const fn of raw[5]) {
      s.functions++;
      s.nameChars += fn[0].length;
      if (typeof fn[5] === 'string') s.docChars += fn[5].length;
    }
    s.dims += raw[6].length;
    // 引用流水是扁平数组（v13，步长 `REF_STRIDE`）⇒ 条数 = 格数 / 4，不是格数
    s.refs += raw[7].length / REF_STRIDE;
    s.labels += raw[8].length;
  }
  return s;
}

/** 校验未知数据是否为**本项目**的当前版本快照；任一不符返回 null（整体弃用） */
export function coerceSnapshot(raw: unknown, rootDir: string): IndexSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== SNAPSHOT_VERSION) return null;
  // 同一项目根的**写法变体**（大小写 / 斜杠方向 / 尾分隔符）不算换项目（PERF-12a）；
  // 盘符变了、目录挪了依然判不同项目 ⇒ 不复用
  if (typeof r.rootDir !== 'string' || !sameProjectRoot(r.rootDir, rootDir)) return null;
  if (typeof r.savedAt !== 'number' || !Number.isFinite(r.savedAt)) return null;
  // 条目结构（元组长度 / 类型 / 形参与注释位 / refs 名录摘要位）由 decodeEntries 逐条校验，不符 ⇒ 整体弃用
  const entries = decodeEntries(r.entries);
  if (entries === null) return null;
  // 信封名录摘要：只认数（旧盘没这一位 = 未知 ⇒ 调用方走逐条目巡检，不猜）
  return {
    version: SNAPSHOT_VERSION,
    rootDir,
    savedAt: r.savedAt,
    entries,
    ...(typeof r.namesFp === 'number' ? { namesFp: r.namesFp } : {}),
  };
}

/* ---------------------------------------------------------------------------
 * 名录摘要（refs 溯源判据，PERF-12a）
 * ------------------------------------------------------------------------- */

/**
 * 名字表摘要（**顺序无关**的 48 位整型指纹，可直接进 JSON、可用 `number` 逐位比）。
 *
 * 为什么需要它：反向引用"哪些记号算引用"的判据是全局 `byName`，而快照复用只按
 * mtime+size 判"正文没变"。旁处新增一个 `@函数` 时，未变文件的正文没动、**它的 refs 却缺边**
 * （v4 起就有这个洞，此前无人记账）——所以每条 refs 都要记下"我是在哪张名录下扫出来的"。
 * 摘要只服务这一等比，不参与任何解析语义。
 *
 * 双通道累加（加法和 ⊕ 旋转后异或）+ 条数掺进种子：单条 32 位太薄；
 * 两条独立通道合成一个 48 位值（`< 2^53` ⇒ JSON 往返逐位精确，不必退化成字符串）。
 */
export function nameSetDigest(names: Iterable<string>): number {
  let sum = 0x811c9dc5;
  let xor = 0x01000193;
  let count = 0;
  for (const name of names) {
    count++;
    let h = (0x811c9dc5 ^ name.length) >>> 0;
    for (let i = 0; i < name.length; i++) {
      h ^= name.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h >>>= 0;
    sum = (sum + h) >>> 0;
    xor = (xor ^ (((h << 7) | (h >>> 25)) >>> 0)) >>> 0;
  }
  sum = (sum + Math.imul(count, 0x9e3779b1)) >>> 0;
  xor = (xor ^ Math.imul(count ^ 0x5bf03635, 0x85ebca6b)) >>> 0;
  return sum * 0x10000 + (xor >>> 16);
}

/**
 * 存量 refs 能不能直接续用：条目记下的名录摘要 === 当前名录摘要。
 * 不等（含 `undefined`＝溯源未知，v6 及更早的盘上条目）⇒ 判可疑，由构建轮溯源巡检补扫。
 */
export function refsAreReusable(entry: SnapshotEntry, currentDigest: number): boolean {
  return entry.refs !== undefined && entry.refsNamesFp === currentDigest;
}

/* ---------------------------------------------------------------------------
 * refs 溯源位 · 逐文件判据（REFS-PROVENANCE，2026-10-22）
 * ------------------------------------------------------------------------- */

/**
 * 快照条目全集的**名录**（构建轮拿它和当前 `byName` 求对称差）。
 *
 * 为什么能从条目还原旧名录：落盘快照的条目集 = 上一次构建时的文件全集
 * （`mergeEntries` 丢弃已消失文件），每条目的函数名 = 那次聚合进 `byName` 的名字。
 * 惰性外壳走 RAW 元组快路径（`raw[5]` 的名字逐个 `toUpperCase`，与 `aggregateIndex`
 * 同一条口径、不触发 100k 级函数对象构造）；已物化的文件走 `normalizedName`。
 */
export function entryNamesOf(entries: Readonly<Record<string, SnapshotEntry>>): Set<string> {
  const out = new Set<string>();
  for (const path in entries) {
    const e = entries[path]!;
    const raw = (e.file as RawCarrier)[RAW];
    if (raw !== undefined) {
      for (const t of raw[5]) out.add(t[0].toUpperCase());
      continue;
    }
    for (const fn of e.file.functions) out.add(fn.normalizedName);
  }
  return out;
}

/**
 * 新旧名录的**对称差**（旧有新无 + 新有旧无）＝"变掉了的名字"。
 *
 * 溯源巡检的嫌疑名单：一个名字在差集里 ⇔ 它的**加入或移除**会让"判据含它/不含它"
 * 的存量 refs 变样。名字没变 ⇒ 任何文件的 refs 与它无关。与 `nameSetDigest` 的关系：
 * 摘要负责"变没变"（O(1) 快答），差集负责"变了**哪些**"（逐文件判据的原料）。
 */
export function changedNamesBetween(oldNames: ReadonlySet<string>, newNames: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const n of oldNames) if (!newNames.has(n)) out.add(n);
  for (const n of newNames) if (!oldNames.has(n)) out.add(n);
  return out;
}

/**
 * **可证免扫**判据：名录变了（`changed` 非空）但这份条目的 refs 逐字节不变的证明。
 *
 * 证明链：`scanFileRefs` 的产出只取决于"每个候选记号过不过 `hasName`"——记号没变、
 * 名录里 `candidates ∩ changed = ∅` ⇒ 每个记号的判定结果不变 ⇒ refs 逐字节不变。
 *
 * **v12 起用哈希集做这件事**（MEM-6）：`changed` 是"变掉的名字"的**哈希集**（调用方算一次），
 * 本函数逐枚比对该文件候选集的哈希。方向是**遍历文件侧、查名录侧**——反过来（遍历 11 万
 * 个 changed、逐文件二分）在"大范围改名"时会退化到十亿级比较。
 *
 * 保守侧**一点没松**：碰撞只会把"不在集合里"的记号判成在 ⇒ 多扫一次文件；
 * 真在集合里 ⇒ 哈希必在集合里 ⇒ **不可能漏扫**。refs 缺失 / 候选未知（键缺席 = v10 迁移
 * 未知态）⇒ `false`（重扫），绝不猜。
 */
export function refsProvableUnchanged(entry: SnapshotEntry, changedHashes: ReadonlySet<number>): boolean {
  if (entry.refs === undefined) return false;
  const hashes = entry.candidateHashes;
  if (hashes === undefined) return false;
  for (let i = 0; i < hashes.length; i++) {
    if (changedHashes.has(hashes[i]!)) return false;
  }
  return true;
}

/**
 * 合并出新快照的 entries：本次重扫的用新结果，其余沿用旧条目；
 * **已从磁盘消失的文件不保留**（快照不收尸就会越攒越大）。
 */
export function mergeEntries(
  prev: IndexSnapshot | null,
  paths: readonly string[],
  fresh: ReadonlyMap<string, SnapshotEntry>,
): Record<string, SnapshotEntry> {
  const out: Record<string, SnapshotEntry> = {};
  for (const p of paths) {
    const f = fresh.get(p);
    if (f) {
      out[p] = f;
      continue;
    }
    const old = prev?.entries[p];
    if (old) out[p] = old;
  }
  return out;
}

/**
 * 把引用流水挂回快照条目（H2 批）。
 *
 * 为什么单独一步而不是并进 `mergeEntries`：`refs` 要等**全项目 `byName` 建好**才能扫
 * （判据是全局名字表），而 `mergeEntries` 发生在解析段。挂接是纯函数重建条目对象，
 * 不原地改——`SnapshotEntry` 的 readonly 纪律不破。
 *
 * `refsNamesFp`（PERF-12a）只跟着**这次真的挂上去的**那批 refs 走：谁被挂上新流水，
 * 谁才配有"我是在这张名录下扫的"这条溯源；没有新流水的条目零触碰（原样的 refs +
 * 原样的溯源位留在一起，不能被别人的名录摘要冒充）。
 *
 * `candidatesByPath`（REFS-PROVENANCE，2026-10-22）同理：候选集是**这次扫描顺带**收的
 * （`scanFileRefs` 的收集位 / `erb.scanRefs` 的产出第 2 位），只跟着新流水一起挂——
 * 调用方必须给**每个**重扫路径都备好候选串（空集 = `''`，键照写：''是"已知没有"，
 * 缺键是"未知"，两者差一轮重扫）。
 */
export function attachRefs(
  entries: Record<string, SnapshotEntry>,
  refsByPath: ReadonlyMap<string, FileRefs>,
  refsNamesFp?: number,
  candidatesByPath?: ReadonlyMap<string, string>,
): Record<string, SnapshotEntry> {
  const out: Record<string, SnapshotEntry> = {};
  for (const [path, e] of Object.entries(entries)) {
    const refs = refsByPath.get(path);
    if (refs === undefined) {
      out[path] = e;
      continue;
    }
    const candidates = candidatesByPath?.get(path);
    out[path] = {
      ...e,
      refs,
      ...(refsNamesFp === undefined ? {} : { refsNamesFp }),
      // 候选集在这里**就地哈希**（v12）：上游（`scanFileRefs` / `erb.scanRefs`）产出的仍是
      // `'\n'` 连接串——worker 边界那一段一个字都不用改，转换只发生在挂接这一处。
      ...(candidates === undefined ? {} : { candidateHashes: candidateHashesFromTokens(candidates) }),
    };
  }
  return out;
}
