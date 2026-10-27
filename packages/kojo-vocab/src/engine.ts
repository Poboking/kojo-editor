/**
 * 引擎变量族事实 + 字典适配（LAU-3b 解耦批，2026-10-27 从 `@kojo/plugin-kojo-sugar` 迁出）。
 *
 * ## 为什么住这里而不是插件
 *
 * 这两张表是 **ERB 语言层**的事实（`CFLAG:具名` 的族头、具名索引核对的生效族），
 * 与"kojo1 的转译器"无关：`.erb` 族头补全 / `.kojo` 族头档 / 升糖投影的 `nameAt`
 * 都在用。kojo1 封存后它们仍必须活着，所以跟着 kojo1 的包一起删除是错的——
 * 本文件所在的 `@kojo/kojo-vocab` 才是它们的家。
 *
 * ## 权威读数原件
 *
 * 入库判据与三盘语料读数（ALS 批 / K6 批 / R1 分层批）的逐条原件留在
 * `git log -- packages/plugins/kojo-sugar/src/index.ts`（迁移前那一版）。本文件只保留
 * 结论与口径，读数由 `packages/plugins/kojo-sugar/tests/family-name-*.test.ts` 继续钉住
 * （测试随 kojo1 退役时一并迁入本包）。
 *
 * - 生效族（核对名称表的九张）：`NOWEX` `MARK` `DOWNBASE` `STAIN` `BASE` `FLAG`
 *   `TFLAG` `TEQUIP` `SOURCE`；全语料实际 warn 面 = 3 条（`NOWEX:i`×2 动态索引 +
 *   `TEQUIP:震动棒`×1 真阳性）。
 * - 不入库的高频族：`CFLAG` / `TALENT` / `TCVAR` / `PALAM` / `EQUIP` —— 残余是作者
 *   自定义名、作用域词或字符集截断（三类都不是字典缺表）。
 * - 拒收并钉死的三枚：`MONSTER_ACTION` / `MONSTER_EXPLV` / `DUMMY_EXT`（引擎串面查无）；
 *   `CHILDNAME` / `PLAYER` 也不进本表（前者是作品 `#DIMS` 自造，后者是执行上下文标量）。
 *
 * 清单顺序即优先级（`resolveFamily` 首中胜）：新增族一律追加在末尾，零归属反转。
 */
import type { VariableInfo, VariableSchema } from '@kojo/plugin-api';
import type { DictionaryLookup } from './types';

/**
 * **本清单的入库口径 = "具名索引族"**：作者会把名字写在冒号后面的那些引擎族头
 * （名字→编号换算、`族:具名` 核对、`.erb` 族头补全候选、`.kojo` 族头档都吃这一张）。
 * 显示层名单另有其表：`packages/app/src/monaco/erb-language.ts` 的
 * `ERB_VARIABLE_FAMILY_HEADS`（比本表宽——它还收引擎作用域/上下文标量），两边的差集由
 * `packages/app/tests/erb-family-single-source.test.ts` 双向对拍钉住，只许收窄不许再漂。
 */
export const ENGINE_VARIABLE_FAMILIES: readonly string[] = [
  'CFLAG',
  'TALENT',
  'ABL',
  'EXP',
  'MARK',
  'BASE',
  'PALAM',
  'TEQUIP',
  'TCVAR',
  'FLAG',
  'TFLAG',
  'CALLNAME',
  'NAME',
  'JVEL',
  'STAIN',
  'DOWNBASE',
  'CUP',
  'GOTJUEL',
  'NOWEX',
  'SOURCE',
  // K6 批（2026-10-25）：引擎内建字符串族，与 `CALLNAME` / `NAME` 同形（无具名表 ⇒ 不进核对台账）
  'MASTERNAME',
  // K6 收尾裁决（2026-10-25 lead）：引擎内建道具族（具名索引形与名表均已坐实）
  'ITEM',
];

/**
 * **具名索引核对的生效族 → 其名称表键候选**（P-10③ 立项；ALS 批 2026-10-14 扩族）。
 *
 * 为什么是"候选表键"而不是"族名一律查自己的表"：引擎把**同一张名字表**挂在两个变量上
 * （`NOWEX` 的具名索引住在 `EX` 的表里、`DOWNBASE` 住在 `BASE` 里），游戏目录里并没有
 * `NOWEX.csv`。别名与上面那张族头清单同性质 —— 是 **ERB 语言层**知识，不是某个游戏的数据
 * （数据本身仍由 adapter 的 CSV/ALS 表注入）。
 *
 * **入库判据**：adapter 字典（已含 `CSV/*.als` 追加名表）在真语料上把该族实际 warn 面
 * 打到 0，或只剩**真阳性**。只要残余里还有一条系统性假阳性类，该族就不入库。
 */
const CHECKED_FAMILY_NAME_TABLES: Readonly<Record<string, readonly string[]>> = {
  NOWEX: ['NOWEX', 'EX'],
  MARK: ['MARK'],
  DOWNBASE: ['DOWNBASE', 'BASE'],
  STAIN: ['STAIN'],
  BASE: ['BASE'],
  FLAG: ['FLAG'],
  TFLAG: ['TFLAG'],
  TEQUIP: ['TEQUIP'],
  SOURCE: ['SOURCE'],
};

/** 字典 `lookup` 的"真正收录"判据（与 `resolveFamily` 同一口径，不另立标准） */
function isRecorded(info: { description?: string; resolvedIndex?: number } | undefined): boolean {
  return info !== undefined && (info.description !== undefined || info.resolvedIndex !== undefined);
}

/**
 * 名称索引的**建档门槛**（真实线性扫次数）：扫到这么多次才付一次建表成本。
 * 依据（本机微基准，见 `tests/hotpath-bench.test.ts`）：单次线性扫 ~1–2µs，
 * 建表（Σ|names| 次 lookup）~亚毫秒—数毫秒 ⇒ 稀疏查询（小额文档 / 少量属性）
 * 永远走"扫 + 记忆"，稠密会话（多文件、名字面广）建表后全额摊还。
 */
const INDEX_BUILD_AFTER_SCANS = 64;

/** 回退扫结果记忆上限（含负结果；防超长会话里错名无限积累） */
const FALLBACK_MEMO_MAX = 4096;

/**
 * 条目所属的**来源层**（族归属用；ALS-R1）。
 *
 * - `'const'` → `undefined`：作者自定具名常量**不参与族归属**（同一个名字可以写在任意族
 *   后面，宣称归属就是猜）；
 * - `'append'` → 追加名表：只在主表一轮都不中时才用它；
 * - `'primary'` **与缺省**（旧字典不标源）→ 主表：第一优先。
 *   缺省按主表处理 ⇒ 不标源的字典行为与改前**逐字相同**（契约 additive 的另一半）。
 * 未收录（`undefined` / 只回显）同样返回 `undefined`，与 `isRecorded` 同一口径。
 */
function familySourceTier(info: VariableInfo | undefined): 'primary' | 'append' | undefined {
  if (info === undefined || !isRecorded(info)) return undefined;
  if (info.source === 'const') return undefined;
  return info.source === 'append' ? 'append' : 'primary';
}

/**
 * 把 adapter 的 `VariableSchema` 适配为转译器的 `DictionaryLookup`（只读消费）。
 *
 * - `resolveFamily(name)`：变量名字 → 族名。策略：按引擎变量族表逐个
 *   `lookup(FAMILY, name)`，**两轮**取归属（ALS-R1）——第一轮只认**主表**（`'primary'`）
 *   收录、按族表顺序取首个；一轮都不中才第二轮认**追加名表**（`'append'`）；
 *   `'const'`（作者自定具名常量）**一律不参与族归属**（adapter FT-1 的自述口径就是
 *   "本表只做名字→编号换算、不宣称族归属"）。**为什么必须分层**：升糖投影按
 *   `nameAt(族, 编号)` 显示，显示侧走的是主表；作者照抄下来降糖时若 `resolveFamily`
 *   给出另一个族，就是**显示与写不同族**。
 * - `resolve(ident)`：裸标识符 → 原样（引擎变量表已收录的族名 + 冒号索引写法本就合法）。
 * - `unlistedFamilyName(ident)`（P-10③）：`族头:具名索引` 的**名称段**核对——
 *   拼错的具名零诊断进产物违铁律 4。本方法只问不改写，报警由 `expression.ts` 决定
 *   （**warning 起步**）。收录判定三层都算（含 `'const'`）。
 */
export function makeLookup(schema: VariableSchema): DictionaryLookup {
  /**
   * 生效族的**名称表键**：按上面登记的候选依次找（族名自己 → 引擎层同名表姊妹族）；
   * 一张都不在位 → undefined（= 无表 = 不许校验，正是"字典未加载不误伤"的口径；
   * 未登记的族头同样直接返回 undefined）。
   */
  const nameTableKey = (family: string): string | undefined => {
    for (const key of CHECKED_FAMILY_NAME_TABLES[family] ?? []) {
      // 无索引的 lookup：表存在必回一条（哪怕只有变量名），表不存在回 undefined
      if (schema.lookup(key) !== undefined) return key;
    }
    return undefined;
  };

  /**
   * 名称 → 族 的**惰性索引**（L2 批；命中路径由"每名 22 族线性扫"改 O(1) 查）。
   *
   * 枚举面 = `schema.names(family)`（KC-1 的可选枚举能力）。`lookup` 还能命中
   * `byName` 独有的别名（同编号重名行），那类名字**不在枚举面内** ⇒ 正表未中时走
   * **精确回退线性扫**并把结果记忆（含 undefined——负结果也记忆）。
   * 累计**真实线性扫**达到门槛才建表；`names()` 缺席 ⇒ 不建表（行为与改前逐字相同）。
   * 生命周期 = `makeLookup` 产物（随代际 memo 复用）⇒ 建表账每个项目代际只付一次。
   */
  let familyIndex: { primary: Map<string, string>; append: Map<string, string> } | null | undefined;
  let scansSeen = 0;
  /** 回退扫结果记忆（含负结果；上限防超长会话积累） */
  const fallbackMemo = new Map<string, string | undefined>();

  const buildFamilyIndex = (): { primary: Map<string, string>; append: Map<string, string> } | null => {
    if (typeof schema.names !== 'function') return null;
    const primary = new Map<string, string>();
    const append = new Map<string, string>();
    for (const family of ENGINE_VARIABLE_FAMILIES) {
      for (const info of schema.names(family) ?? []) {
        const name = info.name;
        if (name.length === 0) continue;
        const tier = familySourceTier(schema.lookup(family, name));
        if (tier === 'primary') {
          if (!primary.has(name)) primary.set(name, family); // 族表顺序即优先级（首个命中胜）
        } else if (tier === 'append') {
          if (!append.has(name)) append.set(name, family);
        }
      }
    }
    return { primary, append };
  };

  /** 线性扫（建档前 / 枚举面外 / 无枚举能力时的原口径） */
  const resolveFamilyLinear = (name: string): string | undefined => {
    let appendHit: string | undefined;
    for (const family of ENGINE_VARIABLE_FAMILIES) {
      // lookup 在"表不存在 / 名称不在表内"时返回 undefined 或仅回显 name；
      // 只有**真正收录**（description 或 resolvedIndex 落地）才算命中。
      const tier = familySourceTier(schema.lookup(family, name));
      if (tier === 'primary') return family;
      if (tier === 'append' && appendHit === undefined) appendHit = family;
    }
    return appendHit;
  };

  return {
    resolveFamily(name: string): string | undefined {
      // 两轮（ALS-R1）：主表优先，追加名表只在主表一轮都不中时才给出归属；
      // `'const'`（`.ERH` 具名常量）不参与——它照样让 `lookup` 换算编号，但不再宣称族归属。
      //
      // L2：正表 O(1)（建表有门槛）；枚举面外走精确回退扫 + 结果记忆（含负结果）。
      if (familyIndex === undefined && scansSeen >= INDEX_BUILD_AFTER_SCANS) {
        familyIndex = buildFamilyIndex(); // 扫描量证明工作量足够，建表摊销
      }
      if (familyIndex) {
        const hit = familyIndex.primary.get(name) ?? familyIndex.append.get(name);
        if (hit !== undefined) return hit;
      }
      const memo = fallbackMemo.get(name);
      if (memo !== undefined || fallbackMemo.has(name)) return memo;
      const result = resolveFamilyLinear(name);
      if (scansSeen < INDEX_BUILD_AFTER_SCANS) scansSeen++;
      if (fallbackMemo.size < FALLBACK_MEMO_MAX) fallbackMemo.set(name, result);
      return result;
    },
    resolve(ident: string): string | undefined {
      // 原生 ERB 变量引用（`CFLAG:2` 形态）与引擎族名——原样保留。
      // **注意**：无族头的**裸引擎全局**（`SELECTCOM` / `PREVCOM` / `ARG` …）不在这里判
      // ——它们不属字典（CSV 建不出"引擎自带标量"这张表），判据见 `engine-globals.ts`。
      // 同一条"可选注入"纪律也约束着具名索引核对——它**不在这里**报（`resolve` 只能
      // 返回原文或 undefined，返回 undefined 会被调用方报成 error），走 `unlistedFamilyName`。
      const head = ident.split(':')[0]!.toUpperCase();
      if (ENGINE_VARIABLE_FAMILIES.includes(head)) return ident;
      return undefined;
    },
    unlistedFamilyName(ident: string): { family: string; name: string } | undefined {
      // 只核 `族头:名称` **二段形**（P-10③ 的病根形态）。三段及以上混着作用域语义，
      // 实测表外率高、误伤面大，本批不碰。
      const sep = ident.indexOf(':');
      if (sep <= 0 || ident.indexOf(':', sep + 1) >= 0) return undefined;
      const family = ident.slice(0, sep).toUpperCase();
      const name = ident.slice(sep + 1);
      if (name.length === 0) return undefined;
      // 生效族 = 上面按实测表权威登记的那几张（未登记的族头逐字保持今天的放行）
      if (CHECKED_FAMILY_NAME_TABLES[family] === undefined) return undefined;
      // 纯数字索引是引擎合法写法（`CFLAG:1088`），没有"名称表"可核 ⇒ 放行
      if (/^[0-9]+$/.test(name)) return undefined;
      const table = nameTableKey(family);
      if (table === undefined) return undefined; // 无表则放行
      if (isRecorded(schema.lookup(table, name))) return undefined; // 表内 ⇒ 放行
      return { family, name };
    },
    nameAt(family: string, index: string): string | undefined {
      // 反向查询（升糖投影的属性反糖用）：`lookup(族, 索引).description` 即名称源。
      // 依据 adapter `variable-schema.ts`：编号索引 → `description = byIndex.get(编号)`；
      // 具名索引 → `description = 名称本身`；**未收录 → 无 description**（不猜）。
      const info = schema.lookup(family, index);
      const name = info?.description;
      return name !== undefined && name.length > 0 ? name : undefined;
    },
    bitIndexOf(variableName: string, bitLabel: string): number | undefined {
      // 位名 → 引擎位号（v1.8）。只认 `族头:…:索引`（**索引 = 末段**；中间的作用域词
      // 如 `TARGET` / `MASTER` / 角色号跳过），族头必须是引擎变量族。位表数据由 adapter
      // 挂在 `lookup(族, 索引).bits` 上（`variable-schema.withBits`，KC-1b）——
      // 本方法**零游戏知识**：只按 `label` 整词精确匹配；查无 / 同位表内多枚同名（歧义）
      // ⇒ `undefined`（不猜）。
      const segs = variableName.split(':');
      if (segs.length < 2) return undefined;
      const family = segs[0]!.toUpperCase();
      if (!ENGINE_VARIABLE_FAMILIES.includes(family)) return undefined;
      const index = segs[segs.length - 1]!;
      if (index.length === 0) return undefined;
      const bits = schema.lookup(family, index)?.bits;
      if (bits === undefined) return undefined;
      let hit: number | undefined;
      for (const b of bits) {
        if (b.label !== bitLabel) continue;
        if (hit !== undefined) return undefined; // 同一位表内多枚同名 → 歧义（不猜）
        hit = b.bit;
      }
      return hit;
    },
    // 家族头中文别名（D2）：直接转发 adapter 的 `familyAlias` / `familyAliasReverse`
    // （单一真源，本包零硬编码）；**adapter 未提供 ⇒ 不挂**（消费方据 `undefined` 不替换，不猜）。
    ...(schema.familyAlias
      ? { familyAlias: (name: string) => schema.familyAlias!(name) }
      : {}),
    ...(schema.familyAliasReverse
      ? { familyAliasReverse: (family: string) => schema.familyAliasReverse!(family) }
      : {}),
    // 槽位原名→中文名（ZH-N 接线批）：同样**逐字转发** adapter 的 `VariableSchema.slotCn`
    // （词典与编号换算都住 adapter，本包零解释）；adapter 未提供 ⇒ 不挂（投影不标注记，不猜）。
    ...(schema.slotCn
      ? { slotCn: (family: string, jpName: string) => schema.slotCn!(family, jpName) }
      : {}),
  };
}
