/**
 * eraFL 的**剧情线预设**（`GameAdapter.stateLinePresets`；条件矩阵的快捷选格用）。
 *
 * ## 为什么是这五条
 *
 * 判据是**真盘读数**，不是"CSV 里有这个名字"：`ERB` 全树里这五个状态被口上/事件脚本
 * 反复当条件用（2026-10-24 实测：好感度 45 处、面識 16、依存度 27、従属度 11、支配度 11），
 * 且都集中在 `CFLAG:CHARA_ID:*` 这一种主形上。CSV 里另有 170 多个 CFLAG 名字，绝大多数
 * 是流程标记（`妊娠期間` / `捕虜先` / `労働内容`），当"剧情线"展示只会把矩阵塞满噪声。
 *
 * ## 为什么一条线要列好几个键
 *
 * eraFL 的 CFLAG 是**二维**的：`CFLAG:{角色}:{索引}`。同一个「好感度」在不同函数里写成
 * `CFLAG:CHARA_ID:好感度` / `CFLAG:対象:好感度` / `CFLAG:MAIN_PLAYER:好感度`——对
 * `dependencyKey()` 来说这是**三条不同的依赖键**（它按原文归一，不做语义归并），
 * 而矩阵按 `keys` **精确匹配行**。所以一条线必须把真盘出现过的拼写都列上，
 * 少列一种就等于"这条线在那些函数里不亮"。
 *
 * 键一律用**游戏原文**（日文名），因为依赖键是从源码原文归一出来的：把 `好感度` 写成
 * 中文 `好感度` 看着一样，但 `従属度` 写成 `臣服度` 就再也匹配不上了。
 */
import type { StateLinePreset } from '@kojo/plugin-api';

export const ERAFL_STATE_LINES: readonly StateLinePreset[] = [
  {
    id: 'favor',
    label: '好感线',
    description: '对象对主人公的好感度（CFLAG:好感度）',
    keys: ['CFLAG:CHARA_ID:好感度', 'CFLAG:対象:好感度', 'CFLAG:MAIN_PLAYER:好感度'],
  },
  {
    id: 'depend',
    label: '依存线',
    description: '对象对主人公的依存度（CFLAG:依存度）',
    keys: ['CFLAG:CHARA_ID:依存度', 'CFLAG:対象:依存度'],
  },
  {
    id: 'servile',
    label: '従属线',
    description: '对象的従属度（CFLAG:従属度）',
    keys: ['CFLAG:CHARA_ID:従属度', 'CFLAG:対象:従属度'],
  },
  {
    id: 'dominate',
    label: '支配线',
    description: '对象的支配度（CFLAG:支配度）',
    keys: ['CFLAG:CHARA_ID:支配度', 'CFLAG:対象:支配度'],
  },
  {
    id: 'acquaint',
    label: '相识线',
    description: '是否与主人公见过面（CFLAG:面識）',
    keys: ['CFLAG:CHARA_ID:面識', 'CFLAG:対象:面識'],
  },
];
