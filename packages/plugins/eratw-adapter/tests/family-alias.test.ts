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
 * - 全覆盖闸（分母 = 全集）+ 全集自身的一致性（无重复族、显示名表不许越出全集）。
 */

import { describe, expect, it } from 'vitest';
import type { FileIO, Logger } from '@kojo/plugin-api';
import {
  ENGINE_FAMILIES,
  FAMILY_ALIASES,
  FAMILY_ALIASES_REVERSE,
  FAMILY_ALIAS_EXCLUSIONS,
  FAMILY_LABELS,
  loadEratwVariableSchema,
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
