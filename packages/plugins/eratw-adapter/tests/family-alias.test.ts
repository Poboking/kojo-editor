/**
 * 家族头中文别名表（`FAMILY_ALIASES`）的 adapter 实现自证。
 *
 * **本批（ZH-N）换了闸门分母**：以前全覆盖闸遍历 `FAMILY_LABELS`（显示名表）自己 ⇒
 * 一个族只要没进策展表就**静默漏**（闸门看不见）。现在遍历 `ENGINE_FAMILIES`
 * （引擎族全集，48 族），于是**漏一个族必须报红**。
 *
 * 台账现状（增删条目时三张表必须仍然对账）：
 * - `ENGINE_FAMILIES` 48 族 = 全集分母；
 * - `FAMILY_ALIASES` 46 条 = D2 批 4 + 全量批 19 + **ZH-N 批 23**；
 * - `FAMILY_ALIAS_EXCLUSIONS` 2 条 = `PALAM`（撞关键字）+ `EX`（中文表头形无实证）；
 * - `FAMILY_LABELS` 45 条显示名（= 全集 − `EX` / `NOWEX` / `RAND`，后两族的显示名不在本轴）。
 *
 * 覆盖面：
 * - 正向：表层中文别名 → 引擎族头（**全 46 条**逐条钉）；
 * - 反向：引擎族头 → 表层中文别名（全 46 条 + 大小写不敏感）；
 * - 消歧：同前缀对（`字符串`/`角色字符串`/`存档字符串`/`临时字符串`、`装备`/`临时装备`、
 *   `宝珠`/`取得宝珠`、`标志`族系）各回各头，互不切词；
 * - 负自证：**未登记**的名字 / 族头一律 `undefined`（不猜）；`FAMILY_LABELS` 显示名**不做**
 *   整表别名合并（`全局标志` 不是别名）；
 * - 全覆盖闸（分母 = 全集）+ 全集自身的一致性（无重复族、显示名表不许越出全集）；
 * - **JP→CN 槽名词典**（ZH-N 批后半）：`slotCn` 契约接线（在线装词典 / 无词典两种装配态）+
 *   `createChsSlotDictionary` 单元自证（命中 / 查不到 `undefined` 不猜 / 词形归一 / 首条优先）。
 */

import { describe, expect, it } from 'vitest';
import type { FileIO, Logger } from '@kojo/plugin-api';
import {
  ENGINE_FAMILIES,
  FAMILY_ALIASES,
  FAMILY_ALIASES_REVERSE,
  FAMILY_ALIAS_EXCLUSIONS,
  FAMILY_LABELS,
  createChsSlotDictionary,
  loadEratwVariableSchema,
  parseChsMap,
} from '../src/variable-schema';

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function fakeIo(files: Record<string, string>): FileIO {
  return {
    listDir: async () => [
      { name: 'CFLAG.csv', path: '/game/CSV/CFLAG.csv', isDirectory: false },
    ],
    readText: async (path: string) => ({ text: files[path] ?? '', path }),
    // FileIO 契约的批量读（字典的两条读循环走这里）
    readTexts: async (paths: readonly string[]) => paths.map((p) => ({ text: files[p] ?? '', path: p })),
  } as unknown as FileIO;
}

async function schema() {
  return loadEratwVariableSchema({
    io: fakeIo({ '/game/CSV/CFLAG.csv': '2,好感度\n' }),
    csvDir: '/game/CSV',
    log: silentLog,
  });
}

/**
 * 全表规范快照（手写 pin；顺序 = D2 批 4 条 → 全量批 19 条 → **ZH-N 批 23 条**）。
 * ZH-N 批新增段的顺序 = `ENGINE_FAMILIES` 声明序，逐条都是"显示名原样采纳"（策展口径 1）。
 */
const EXPECTED: readonly (readonly [string, string])[] = [
  // —— D2 批 4 条 ——
  ['现在', 'NOWEX'],
  ['时标', 'TFLAG'],
  ['标记', 'FLAG'],
  ['随机', 'RAND'],
  // —— 全量批 19 条 ——
  ['基础值', 'BASE'],
  ['基础上限', 'MAXBASE'],
  ['能力', 'ABL'],
  ['素质', 'TALENT'],
  ['快感经验', 'EXP'],
  ['刻印', 'MARK'],
  ['角色标志', 'CFLAG'],
  ['角色字符串', 'CSTR'],
  ['字符串', 'STR'],
  ['欲求', 'SOURCE'],
  ['污渍', 'STAIN'],
  ['宝珠', 'JUEL'],
  ['道具', 'ITEM'],
  ['临时装备', 'TEQUIP'],
  ['装备', 'EQUIP'],
  ['临时角色变量', 'TCVAR'],
  ['时间', 'TIME'],
  ['日期', 'DAY'],
  ['技能', 'TRAIN'],
  // —— ZH-N 批 23 条（名表汉化扩面）——
  ['关系', 'RELATION'],
  ['取得宝珠', 'GOTJUEL'],
  ['基础上降', 'DOWNBASE'],
  ['参数上升', 'CUP'],
  ['参数下降', 'CDOWN'],
  ['助手', 'ISASSI'],
  ['角色编号', 'NO'],
  ['真名', 'NAME'],
  ['称呼', 'CALLNAME'],
  ['昵称', 'NICKNAME'],
  ['主人名', 'MASTERNAME'],
  ['角色详细标志', 'CDFLAG'],
  ['金钱', 'MONEY'],
  ['上升', 'UP'],
  ['下降', 'DOWN'],
  ['参数等级', 'PALAMLV'],
  ['经验等级', 'EXPLV'],
  ['射精次数', 'EJAC'],
  ['存档字符串', 'SAVESTR'],
  ['临时字符串', 'TSTR'],
  ['设置', 'CONF'],
  ['怪物标志', 'MFLAG'],
  ['角色自定变量', 'CHARVAR'],
];

/** ZH-N 批**以前静默漏**的族（不在旧分母 `FAMILY_LABELS` 里，闸门看不见；现在必须在表上） */
const ZHN_FAMILIES = EXPECTED.slice(23).map(([, family]) => family);

describe('家族头中文别名（D2 起步 + 全量批 + ZH-N 扩面）× adapter', () => {
  it('正向：全表 46 条别名逐条 → 引擎族头', async () => {
    const s = await schema();
    for (const [alias, family] of EXPECTED) {
      expect(s.familyAlias!(alias), `${alias} → ${family}`).toBe(family);
    }
  });

  it('反向：全表 46 个族头逐条 → 中文别名（大小写不敏感）', async () => {
    const s = await schema();
    for (const [alias, family] of EXPECTED) {
      expect(s.familyAliasReverse!(family), `${family} → ${alias}`).toBe(alias);
    }
    // 引擎标识符大小写不敏感 ⇒ 小写族头同样命中（既有 2 + 新增抽样 2）
    expect(s.familyAliasReverse!('nowex')).toBe('现在');
    expect(s.familyAliasReverse!('rand')).toBe('随机');
    expect(s.familyAliasReverse!('abl')).toBe('能力');
    expect(s.familyAliasReverse!('tequip')).toBe('临时装备');
    expect(s.familyAliasReverse!('gotjuel')).toBe('取得宝珠');
    expect(s.familyAliasReverse!('charvar')).toBe('角色自定变量');
  });

  it('消歧：同前缀族（字符串系 / 装备系 / 宝珠系 / 标志系）各回各头，不互切', async () => {
    const s = await schema();
    for (const [alias, family] of EXPECTED) {
      // 表内任何两条互不成"别名轴上互为前后缀"以外的共享形（一形一族的另一面）
      expect(s.familyAlias!(alias), `${alias} 必须回 ${family}`).toBe(family);
    }
    expect(s.familyAlias!('角色字符串')).toBe('CSTR');
    expect(s.familyAlias!('字符串')).toBe('STR');
    expect(s.familyAlias!('存档字符串')).toBe('SAVESTR');
    expect(s.familyAlias!('临时字符串')).toBe('TSTR');
    expect(s.familyAlias!('临时装备')).toBe('TEQUIP');
    expect(s.familyAlias!('装备')).toBe('EQUIP');
    expect(s.familyAlias!('取得宝珠')).toBe('GOTJUEL');
    expect(s.familyAlias!('宝珠')).toBe('JUEL');
    expect(s.familyAlias!('角色标志')).toBe('CFLAG');
    expect(s.familyAlias!('角色详细标志')).toBe('CDFLAG');
    expect(s.familyAlias!('怪物标志')).toBe('MFLAG');
    expect(s.familyAlias!('临时角色变量')).toBe('TCVAR');
    expect(s.familyAlias!('角色自定变量')).toBe('CHARVAR');
    expect(s.familyAliasReverse!('STR')).toBe('字符串');
    expect(s.familyAliasReverse!('CSTR')).toBe('角色字符串');
    expect(s.familyAliasReverse!('EQUIP')).toBe('装备');
    expect(s.familyAliasReverse!('TEQUIP')).toBe('临时装备');
    expect(s.familyAliasReverse!('GOTJUEL')).toBe('取得宝珠');
    expect(s.familyAliasReverse!('SAVESTR')).toBe('存档字符串');
  });

  it('负自证：未登记的名字 / 族头 → undefined（不猜）', async () => {
    const s = await schema();
    expect(s.familyAlias!('CFLAG')).toBeUndefined(); // 引擎族头当输入：不是登记别名
    expect(s.familyAlias!('現在')).toBeUndefined(); // 繁体写法不在表
    expect(s.familyAlias!('参数')).toBeUndefined(); // 排除族（PALAM）：撞命名参数关键字，不登记
    expect(s.familyAlias!('装备品')).toBeUndefined(); // 表外近义词一律不猜
    expect(s.familyAlias!('全局标志')).toBeUndefined(); // 显示名≠别名：FLAG 别名是「标记」，不做整表合并
    expect(s.familyAlias!('临时标志')).toBeUndefined(); // 同上：TFLAG 别名是「时标」
    expect(s.familyAliasReverse!('PALAM')).toBeUndefined(); // 排除族：反向同样不猜
    expect(s.familyAliasReverse!('EX')).toBeUndefined(); // 排除族：中文表头形无实证
    expect(s.familyAliasReverse!('NOTAFAMILY')).toBeUndefined();
    // ZH-N 批新增段的"表外近义词"负例（扩面不许把猜测带进来）
    expect(s.familyAlias!('钱')).toBeUndefined();
    expect(s.familyAlias!('昵称名')).toBeUndefined();
    expect(s.familyAlias!('怪物变量')).toBeUndefined();
    expect(s.familyAlias!('上限')).toBeUndefined();
  });

  it('负自证：Object.prototype 成员名不命中（表无原型 ⇒ 绝不吐函数源码）', async () => {
    const s = await schema();
    // 作者写 `constructor:` / `hasOwnProperty:` 是未登记输入 ⇒ 必须 undefined，
    // 而不是从 Object.prototype 继承到函数（那会静默替换成 `[native code]` 源码）
    expect(s.familyAlias!('constructor')).toBeUndefined();
    expect(s.familyAlias!('hasOwnProperty')).toBeUndefined();
    expect(s.familyAlias!('__proto__')).toBeUndefined();
    expect(s.familyAliasReverse!('CONSTRUCTOR')).toBeUndefined();
    // 四张表（正向 / 反向 / 排除台账 / 全集）都是冻结或无原型对象
    expect(Object.getPrototypeOf(FAMILY_ALIASES)).toBeNull();
    expect(Object.getPrototypeOf(FAMILY_ALIASES_REVERSE)).toBeNull();
    expect(Object.getPrototypeOf(FAMILY_ALIAS_EXCLUSIONS)).toBeNull();
  });

  it('表形态：全表 46 条逐字钉死（与 FAMILY_LABELS 显示名轴不混用）', () => {
    expect(FAMILY_ALIASES).toEqual(Object.fromEntries(EXPECTED));
  });

  it('反向表形态：由正向派生，46 族头 → 别名逐条相等', () => {
    expect(FAMILY_ALIASES_REVERSE).toEqual(
      Object.fromEntries(EXPECTED.map(([alias, family]) => [family, alias])),
    );
  });

  /* -------------------------------------------------------------------------- */
  /* ZH-N 批：分母 = 引擎族全集                                                  */
  /* -------------------------------------------------------------------------- */

  it('全集自身：48 族、无重复、一律大写（分母坏了闸就白装）', () => {
    expect(ENGINE_FAMILIES.length).toBe(48);
    expect(new Set(ENGINE_FAMILIES).size, '全集有重复族').toBe(ENGINE_FAMILIES.length);
    for (const family of ENGINE_FAMILIES) {
      expect(family, '全集族名必须大写（引擎大小写不敏感 ⇒ 键只认大写形）').toBe(family.toUpperCase());
      expect(family.trim(), '全集族名不许有空隙').toBe(family);
    }
    // 全集是**冻结**只读常量：装配代码不许在运行期往里塞族
    expect(Object.isFrozen(ENGINE_FAMILIES)).toBe(true);
  });

  it('全覆盖闸（分母 = 引擎族全集）：每族要么有别名、要么在排除名单且有理由', () => {
    const universe = ENGINE_FAMILIES;
    for (const family of universe) {
      const hasAlias = FAMILY_ALIASES_REVERSE[family] !== undefined;
      const excluded = family in FAMILY_ALIAS_EXCLUSIONS;
      expect(hasAlias || excluded, `${family}：既无别名又不在排除名单（悄悄没登记）`).toBe(true);
      expect(hasAlias && excluded, `${family}：既登记又排除（台账打架）`).toBe(false);
    }
    // 排除台账不许 stale：族必须真实在全集里，理由不许空
    const universeSet = new Set(universe);
    for (const [family, reason] of Object.entries(FAMILY_ALIAS_EXCLUSIONS)) {
      expect(universeSet.has(family), `${family} 不在 ENGINE_FAMILIES（过期排除条目）`).toBe(true);
      expect(reason.trim().length, `${family} 排除理由不许空`).toBeGreaterThan(0);
    }
    // 台账对账（三张表）：|别名| + |排除| = |全集|，一条不多一条不少
    expect(Object.keys(FAMILY_ALIASES_REVERSE).length + Object.keys(FAMILY_ALIAS_EXCLUSIONS).length).toBe(
      universe.length,
    );
  });

  it('差集自证：ZH-N 批前"静默漏"的 23 族现在别名 + 显示名都在表', () => {
    // 旧分母 = 旧 `FAMILY_LABELS` 的 22 族 ⇒ 本批新增段的族**必须全部不在旧分母里**
    // （这条钉死"换分母"这件事本身：这些族以前根本进不了闸门，漏了也没人报红）
    const legacyLabels = new Set([
      'BASE', 'MAXBASE', 'ABL', 'TALENT', 'EXP', 'MARK', 'CFLAG', 'FLAG', 'TFLAG', 'CSTR', 'STR',
      'PALAM', 'SOURCE', 'STAIN', 'JUEL', 'ITEM', 'TEQUIP', 'EQUIP', 'TCVAR', 'TIME', 'DAY', 'TRAIN',
    ]);
    expect(ZHN_FAMILIES.length).toBe(23);
    for (const family of ZHN_FAMILIES) {
      expect(legacyLabels.has(family), `${family} 本批以前不在旧分母 ⇒ 以前静默漏`).toBe(false);
      expect(FAMILY_ALIASES_REVERSE[family], `${family} 现在必须有别名`).toBeDefined();
      expect(FAMILY_LABELS[family], `${family} 现在必须有显示名`).toBeDefined();
    }
    // 反面对账：旧分母里除排除族外都仍有别名（扩面不许把旧条目挤掉）
    for (const family of legacyLabels) {
      if (family in FAMILY_ALIAS_EXCLUSIONS) continue;
      expect(FAMILY_ALIASES_REVERSE[family], `${family} 旧条目不许丢`).toBeDefined();
    }
    // 一形一族（策展口径 2）：46 条别名的键与值都各自唯一（TEQUIP / EQUIP 同显示名的历史
    // 冲突已由「临时装备」/「装备」拆开，故值轴也须唯一）
    expect(new Set(EXPECTED.map(([alias]) => alias)).size).toBe(EXPECTED.length);
    expect(new Set(EXPECTED.map(([, family]) => family)).size).toBe(EXPECTED.length);
  });

  it('显示名表不许越出全集（`FAMILY_LABELS` 每族都在分母里）', () => {
    const universe = new Set(ENGINE_FAMILIES);
    for (const family of Object.keys(FAMILY_LABELS)) {
      expect(universe.has(family), `${family} 有显示名却不在 ENGINE_FAMILIES（全集漏收）`).toBe(true);
    }
    // 显示名轴与别名轴各自策展：显示名**不是**别名（未登记的近义词不猜）
    for (const [family, label] of Object.entries(FAMILY_LABELS)) {
      if (family in FAMILY_ALIAS_EXCLUSIONS) {
        expect(FAMILY_ALIASES[label], `${family} 的显示名不许同时是别名`).toBeUndefined();
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* ZH-N 批后半：JP→CN 槽名词典（契约 `slotCn` + 工厂 `createChsSlotDictionary`） */
/* -------------------------------------------------------------------------- */

describe('JP→CN 槽名词典 × adapter', () => {
  /**
   * 词典 fixture（对齐真 `tw_csv_chs.xml` 形态：`<p><k>日文</k><v>中文</v></p>`）。
   * 覆盖要点：正常词条 ×2 / 同名重条（首条优先）/ 空键 / 空值 / 两侧夹空白 / 文件头 BOM。
   */
  const XML =
    '\uFEFF<map>' +
    '<p><k>信頼度</k><v>信赖度</v></p>' +
    '<p><k>信頼度</k><v>重名第二条（不许翻出来——同名取首条）</v></p>' +
    '<p><k>噴乳</k><v>喷乳</v></p>' +
    '<p><k></k><v>空键不收</v></p>' +
    '<p><k>空值别收</k><v></v></p>' +
    '<p><k>  触典  </k><v>  触值  </v></p>' +
    '</map>';

  it('命中：登记词 → 中文名（首条优先 · 空词条剔除 · size 对账）', () => {
    // parseChsMap 收：信頼度 / 噴乳 / 空值别收（空键跳过；同名取首条）= 4 条
    const parsed = parseChsMap(XML);
    expect(parsed.size).toBe(4);
    // 造只读词典时再剔除空值 ⇒ size 3；包装层不再改内容
    const d = createChsSlotDictionary(parsed);
    expect(d.size).toBe(3);
    expect(d.cnForJp('信頼度')).toBe('信赖度');
    expect(d.cnForJp('噴乳')).toBe('喷乳');
    expect(d.cnForJp('触典')).toBe('触值');
  });

  it('查不到：undefined，绝不回原文冒充命中（shutdown fail-open 的红线）', () => {
    const d = createChsSlotDictionary([['信頼度', '信赖度']]);
    expect(d.cnForJp('不在词典')).toBeUndefined();
    expect(d.cnForJp('信赖度')).toBeUndefined(); // 反方向（CN→JP）不是本词典面，不猜
    expect(d.cnForJp('')).toBeUndefined();
    // 空词典（词典缺席 / 读失败 ⇒ 与描述轴同一回落口径）：有问必 undefined
    const empty = createChsSlotDictionary([]);
    expect(empty.size).toBe(0);
    expect(empty.cnForJp('噴乳')).toBeUndefined();
  });

  it('词形归一只做 BOM / 去空白；大小写、全半角都不折叠（折叠 = 猜等价）', () => {
    const d = createChsSlotDictionary(parseChsMap(XML));
    expect(d.cnForJp('\uFEFF信頼度')).toBe('信赖度'); // 词典进口 BOM（文件头）照常命中
    expect(d.cnForJp('  噴乳\uFEFF')).toBe('喷乳'); // 查询侧同一条归一
    // 中文显示词没有大小写概念；全半角工程实测常见（ex.csv: Ｖ絶頂）——都不折叠，逐字为界
    const halfWidth = createChsSlotDictionary([['Ｖ絶頂', 'Ｖ绝顶']]);
    expect(halfWidth.cnForJp('Ｖ絶頂')).toBe('Ｖ绝顶');
    expect(halfWidth.cnForJp('V絶頂')).toBeUndefined();
  });

  it('契约接线：schema.slotCn 与 description 轴同一词典、同一装载（在线装词典的装配态）', async () => {
    const s = await loadEratwVariableSchema({
      io: fakeIo({
        '/game/CSV/CFLAG.csv': '2,好感度\n4,信頼度\n',
        '/plugins/tw_csv_chs.xml': XML,
      }),
      csvDir: '/game/CSV',
      chsMapPath: '/plugins/tw_csv_chs.xml',
      log: silentLog,
    });
    expect(s.slotCn!('CFLAG', '信頼度')).toBe('信赖度');
    expect(s.slotCn!('NOWEX', '噴乳')).toBe('喷乳');
    // 第一参数（族头）当前**不参与裁决**：词典是引擎 MAP_FROMXML 装出的**一张扁平表**，
    // 键侧无族维度 ⇒ 换个族问同一个词，答案不变（这不是歧义，是词典形状本身）。
    expect(s.slotCn!('NOTAFAMILY', '信頼度')).toBe('信赖度');
    // 词典没有的词 / 中文已然的词：undefined（不猜）——`好感度` 由主表得名，词典无此键
    expect(s.slotCn!('CFLAG', '好感度')).toBeUndefined();
    expect(s.slotCn!('CFLAG', '不在词典')).toBeUndefined();
    // 旧 description 路径**零改动**：悬停仍走「词典查名 → 原文回落」，本包新增面不碰它
    expect(s.lookup('CFLAG', 2)?.description).toBe('好感度');
    expect(s.lookup('CFLAG', 4)?.description).toBe('信赖度');
  });

  it('契约缺省：不装词典 ⇒ slotCn 恒 undefined（悬停回落原文的既有口径逐字不变）', async () => {
    const s = await schema();
    expect(s.slotCn!('CFLAG', '好感度')).toBeUndefined();
    expect(s.slotCn!('CFLAG', '不在词典的假名')).toBeUndefined();
    expect(s.lookup('CFLAG', 2)?.description).toBe('好感度');
  });

  it('编号通道（批 F 口径）：纯数字索引 → 主表原名 → 同一份词典；每一步查不到 ⇒ undefined（不猜）', async () => {
    // fixture 名字对取自真盘形态：CFLAG.csv 的 `2` 位原名 信頼度、词典 `信頼度→信赖度`
    const s = await loadEratwVariableSchema({
      io: fakeIo({
        '/game/CSV/CFLAG.csv': '2,信頼度\n4,好感度\n',
        '/plugins/tw_csv_chs.xml': XML,
      }),
      csvDir: '/game/CSV',
      chsMapPath: '/plugins/tw_csv_chs.xml',
      log: silentLog,
    });
    // 编号 → byIndex 原名（信頼度）→ 词典 → 中文（与具名直查同一份词典、同一条首条优先）
    expect(s.slotCn!('CFLAG', '2')).toBe('信赖度');
    // 原名在位但**词典缺这一条** ⇒ undefined——绝不把原名（好感度）冒充命中
    expect(s.slotCn!('CFLAG', '4')).toBeUndefined();
    // 该族无名称表 / 编号不在表 ⇒ undefined（不换个族再猜）
    expect(s.slotCn!('NOWEX', '2')).toBeUndefined();
    expect(s.slotCn!('CFLAG', '999')).toBeUndefined();
    // 非数字查不到 ⇒ 不触发编号通道（原名直查未中就是未中）
    expect(s.slotCn!('CFLAG', '不在词典')).toBeUndefined();
    // 具名直查的既有裁决零改动：词典命中优先、族头仍不参与名侧
    expect(s.slotCn!('NOTAFAMILY', '信頼度')).toBe('信赖度');
  });

  it('编号通道 fail-closed 对照：词典缺席时数字与具名一律 undefined（名称表在位也不产中文名）', async () => {
    const s = await loadEratwVariableSchema({
      io: fakeIo({ '/game/CSV/CFLAG.csv': '2,信頼度\n' }),
      csvDir: '/game/CSV',
      log: silentLog,
    });
    expect(s.slotCn!('CFLAG', '2')).toBeUndefined();
    expect(s.slotCn!('CFLAG', '信頼度')).toBeUndefined();
  });
});
