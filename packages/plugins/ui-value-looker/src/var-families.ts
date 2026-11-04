/**
 * 看板候选**引擎族词汇表**（游戏无关；本插件私有）。
 *
 * 这些是 **era 引擎语言层**的变量族头（跨游戏一致，依据 `VariableCode.cs` 的内置族形；
 * 同一套判定表的先例见 `state-replay/src/var-model.ts`），**不是**游戏知识——
 * 具体某个游戏里每个族有哪些名字、叫什么，全部经 `game.adapter` 槽的
 * `VariableSchema` 运行时流入（铁律 3）。
 *
 * 为什么需要候选表：契约 `VariableSchema` 只有 `names(family)` **按族枚举**，
 * 没有「枚举族本身」的能力。面板要列出可浏览的族，只能拿引擎族词汇逐族去问
 * ——`names()` 返回空数组的族（该游戏没有这族 / 没有名称表）自动不出现，
 * **不猜**（缺表 = 不显示，绝不显示 0 行的空壳族）。
 */

/** 族元信息：id = 引擎族头（大写）；charaScoped = 引用时需要角色维度（`CFLAG:角色:2`） */
export interface FamilyMeta {
  readonly id: string;
  readonly charaScoped: boolean;
}

/**
 * 角色系族（引用形式 `X:i` 补位 TARGET；`X:c:i` 显式角色）。
 * 名单与 `state-replay/src/var-model.ts` 的 `CHARA_INT_1D` / `CHARA_STR_*` /
 * `CHARA_INT_2D` 同源（同一份引擎事实，各自私有持有——插件间禁交叉 import）。
 */
const CHARA_FAMILIES: readonly string[] = [
  'BASE',
  'MAXBASE',
  'ABL',
  'TALENT',
  'EXP',
  'MARK',
  'PALAM',
  'SOURCE',
  'EX',
  'CFLAG',
  'JUEL',
  'RELATION',
  'EQUIP',
  'TEQUIP',
  'STAIN',
  'GOTJUEL',
  'NOWEX',
  'DOWNBASE',
  'CUP',
  'CDOWN',
  'TCVAR',
  'CSTR',
  'CDFLAG',
  'ISASSI',
  'NO',
  'NAME',
  'CALLNAME',
  'NICKNAME',
  'MASTERNAME',
  'CHARVAR',
];

/** 全局系族（`X` 等价 `X:0`）。单字母通用数组 A–Z 不进候选——它们没有名称表，问了也是空。 */
const GLOBAL_FAMILIES: readonly string[] = [
  'FLAG',
  'TFLAG',
  'MFLAG',
  'DAY',
  'TIME',
  'MONEY',
  'ITEM',
  'ITEMSALES',
  'UP',
  'DOWN',
  'PALAMLV',
  'EXPLV',
  'EJAC',
  'STR',
  'SAVESTR',
  'TSTR',
  'GLOBALS',
  'DITEMTYPE',
  'DA',
  'DB',
  'DC',
  'DD',
  'DE',
  'TA',
  'TB',
  'PBAND',
  'BOUGHT',
  'RANDDATA',
  'LOSEBASE',
  'RESULT',
  'COUNT',
];

/** 候选族有序清单：角色系在前（作者最高频），全局系在后；`charaScoped` 随组取值 */
export const CANDIDATE_FAMILIES: readonly FamilyMeta[] = [
  ...CHARA_FAMILIES.map((id) => ({ id, charaScoped: true })),
  ...GLOBAL_FAMILIES.map((id) => ({ id, charaScoped: false })),
];

const CHARA_SCOPED_SET: ReadonlySet<string> = new Set(CHARA_FAMILIES);

/** 引擎族头是否需要角色维度（大小写不敏感；未登记 = 不猜，按全局族处理） */
export function isCharaScopedFamily(family: string): boolean {
  return CHARA_SCOPED_SET.has(family.toUpperCase());
}
