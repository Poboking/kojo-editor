/**
 * eraTW「常用状态」策展表（`GameAdapter.quickEditFields` 供数；游戏知识只住 adapter，铁律 3）。
 *
 * 目标读者是**零编程基础的口上作者**：他们要的是「把她的好感度改成 600」，
 * 不是「CFLAG 是角色标志族、第 2 号单元才是好感度」。状态注入面板按本表渲染
 * 「常用」卡——作者只看见人话标签 + 当前值 + 一个输入框，族头 / 下标 / 作用域
 * 的换算全部由面板按本表承担（显示名运行时优先查 `variableSchema`，词典汉化跟随游戏）。
 *
 * **策展口径（宁缺毋滥）**：
 * - 只收**有实据**（游戏名表 / 引擎常量 / 本仓既有策展）且语义跨版本稳定的项；
 * - 实据逐条注在行内：
 *   - `CFLAG:2 好感度` / `CFLAG:4 信頼度`——`docs/STATE.md` 的 CFLAG.csv 实证（`2,好感度` / `4,信頼度`）；
 *   - `BASE:0 体力` / `BASE:1 気力`——Emuera 引擎常量（全 era 版通用，角色基础值族固定头两格）；
 *   - `TALENT:3 恋慕` / `TALENT:7 恋人`——同 `plugin.ts` 的 stateLinePresets 既有实据；
 *   - `MONEY:0 所持金`——Emuera 引擎常量（金钱族固定头格，全局区）。
 * - 布尔型素质（恋慕 / 恋人）的值域是 0/1，说明文里写明「0=没有 1=有」；
 * - 没实据的（各 ABL / EXP 编号、魔改版自加槽位）**一律不收**——猜一个编号就是教人写错存档。
 */

import type { QuickEditField } from '@kojo/plugin-api';

/** eraTW 常用状态快捷编辑项（顺序 = 面板「常用」卡的呈现序：先数值后布尔） */
export const ERATW_QUICK_EDIT_FIELDS: readonly QuickEditField[] = Object.freeze([
  {
    id: 'base-hp',
    label: '体力',
    family: 'BASE',
    index: 0,
    description: '角色的当前体力（BASE:0）。',
    scope: 'chara',
  },
  {
    id: 'base-mp',
    label: '气力',
    family: 'BASE',
    index: 1,
    description: '角色的当前气力（BASE:1）。',
    scope: 'chara',
  },
  {
    id: 'cflag-affection',
    label: '好感度',
    family: 'CFLAG',
    index: 2,
    description: '角色的好感度（CFLAG:2）——口上分支最常读的一个数。',
    scope: 'chara',
  },
  {
    id: 'cflag-trust',
    label: '信赖度',
    family: 'CFLAG',
    index: 4,
    description: '角色的信赖度（CFLAG:4）。',
    scope: 'chara',
  },
  {
    id: 'talent-love',
    label: '恋慕（0/1）',
    family: 'TALENT',
    index: 3,
    description: '恋慕素质（TALENT:3）：0=没有 1=有。改 1 后口上的恋慕分支即可走到。',
    scope: 'chara',
  },
  {
    id: 'talent-lover',
    label: '恋人（0/1）',
    family: 'TALENT',
    index: 7,
    description: '恋人素质（TALENT:7）：0=没有 1=有。',
    scope: 'chara',
  },
  {
    id: 'money',
    label: '所持金',
    family: 'MONEY',
    index: 0,
    description: '主人的金钱（MONEY:0）——住在「主变量区」，不在角色块里。',
    scope: 'global',
  },
]);
