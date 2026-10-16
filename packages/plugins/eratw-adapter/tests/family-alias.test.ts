/**
 * 全量批：家族头中文别名表（`FAMILY_ALIASES`，23 条 = D2 批 4 条 + 新增 19 条）的 adapter 实现自证。
 *
 * 覆盖契约 `VariableSchema.familyAlias` / `familyAliasReverse` 两方法：
 * - 正向：表层中文别名 → 引擎族头（`现在` → `NOWEX`…**全 23 条**逐条钉）；
 * - 反向：引擎族头 → 表层中文别名（全 23 条 + 大小写不敏感）；
 * - 消歧：同前缀对（`字符串`/`角色字符串`、`装备`/`临时装备`）各回各头，互不切词；
 * - 负自证：**未登记**的名字 / 族头一律 `undefined`（不猜）；`FAMILY_LABELS` 显示名**不做**
 *   整表别名合并（`全局标志` 不是别名）；
 * - 全覆盖闸：`FAMILY_LABELS` 每族**要么有别名、要么在 `FAMILY_ALIAS_EXCLUSIONS` 有理由**。
 */

import { describe, expect, it } from 'vitest';
import type { FileIO, Logger } from '@kojo/plugin-api';
import {
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

/** 全表规范快照（手写 pin；顺序 = D2 批 4 条 + `FAMILY_LABELS` 声明序新增 19 条） */
const EXPECTED: readonly (readonly [string, string])[] = [
  ['现在', 'NOWEX'],
  ['时标', 'TFLAG'],
  ['标记', 'FLAG'],
  ['随机', 'RAND'],
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
];

describe('家族头中文别名（D2 起步 + 全量批收官）× adapter', () => {
  it('正向：全表 23 条别名逐条 → 引擎族头', async () => {
    const s = await schema();
    for (const [alias, family] of EXPECTED) {
      expect(s.familyAlias!(alias), `${alias} → ${family}`).toBe(family);
    }
  });

  it('反向：全表 23 个族头逐条 → 中文别名（大小写不敏感）', async () => {
    const s = await schema();
    for (const [alias, family] of EXPECTED) {
      expect(s.familyAliasReverse!(family), `${family} → ${alias}`).toBe(alias);
    }
    // 引擎标识符大小写不敏感 ⇒ 小写族头同样命中（既有 2 + 新增抽样 2）
    expect(s.familyAliasReverse!('nowex')).toBe('现在');
    expect(s.familyAliasReverse!('rand')).toBe('随机');
    expect(s.familyAliasReverse!('abl')).toBe('能力');
    expect(s.familyAliasReverse!('tequip')).toBe('临时装备');
  });

  it('消歧：同前缀对（字符串/角色字符串、装备/临时装备）各回各头，不互切', async () => {
    const s = await schema();
    expect(s.familyAlias!('角色字符串')).toBe('CSTR');
    expect(s.familyAlias!('字符串')).toBe('STR');
    expect(s.familyAlias!('临时装备')).toBe('TEQUIP');
    expect(s.familyAlias!('装备')).toBe('EQUIP');
    expect(s.familyAliasReverse!('STR')).toBe('字符串');
    expect(s.familyAliasReverse!('CSTR')).toBe('角色字符串');
    expect(s.familyAliasReverse!('EQUIP')).toBe('装备');
    expect(s.familyAliasReverse!('TEQUIP')).toBe('临时装备');
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
    expect(s.familyAliasReverse!('NOTAFAMILY')).toBeUndefined();
  });

  it('负自证：Object.prototype 成员名不命中（表无原型 ⇒ 绝不吐函数源码）', async () => {
    const s = await schema();
    // 作者写 `constructor:` / `hasOwnProperty:` 是未登记输入 ⇒ 必须 undefined，
    // 而不是从 Object.prototype 继承到函数（那会静默替换成 `[native code]` 源码）
    expect(s.familyAlias!('constructor')).toBeUndefined();
    expect(s.familyAlias!('hasOwnProperty')).toBeUndefined();
    expect(s.familyAlias!('__proto__')).toBeUndefined();
    expect(s.familyAliasReverse!('CONSTRUCTOR')).toBeUndefined();
    // 三张表（正向 / 反向 / 排除台账）都是无原型对象
    expect(Object.getPrototypeOf(FAMILY_ALIASES)).toBeNull();
    expect(Object.getPrototypeOf(FAMILY_ALIASES_REVERSE)).toBeNull();
    expect(Object.getPrototypeOf(FAMILY_ALIAS_EXCLUSIONS)).toBeNull();
  });

  it('表形态：全表 23 条逐字钉死（与 FAMILY_LABELS 显示名轴不混用）', () => {
    expect(FAMILY_ALIASES).toEqual(Object.fromEntries(EXPECTED));
  });

  it('反向表形态：由正向派生，23 族头 → 别名逐条相等', () => {
    expect(FAMILY_ALIASES_REVERSE).toEqual(
      Object.fromEntries(EXPECTED.map(([alias, family]) => [family, alias])),
    );
  });

  it('全覆盖闸：FAMILY_LABELS 每族要么有别名、要么在排除名单且有理由', () => {
    const labelFamilies = Object.keys(FAMILY_LABELS);
    const labelSet = new Set(labelFamilies);
    for (const family of labelFamilies) {
      const hasAlias = FAMILY_ALIASES_REVERSE[family] !== undefined;
      const excluded = family in FAMILY_ALIAS_EXCLUSIONS;
      expect(hasAlias || excluded, `${family}：既无别名又不在排除名单（悄悄没登记）`).toBe(true);
      expect(hasAlias && excluded, `${family}：既登记又排除（台账打架）`).toBe(false);
    }
    // 排除台账不许 stale：族必须真实存在显示名表，理由不许空
    for (const [family, reason] of Object.entries(FAMILY_ALIAS_EXCLUSIONS)) {
      expect(labelSet.has(family), `${family} 不在 FAMILY_LABELS（过期排除条目）`).toBe(true);
      expect(reason.trim().length, `${family} 排除理由不许空`).toBeGreaterThan(0);
    }
  });
});
