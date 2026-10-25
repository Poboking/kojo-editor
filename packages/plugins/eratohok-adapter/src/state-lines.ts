/**
 * eratohoK 的**剧情线预设**（`GameAdapter.stateLinePresets`；条件矩阵的快捷选格用）。
 *
 * ## 为什么是这几条（真盘读数，不是「CSV 里有这个名字」）
 *
 * 2026-10-25 对 `ERB/口上` 全量 694 份 ERB 的条件位计数（去注释、按原文归一）：
 *
 * | 状态键 | 出现次数 |
 * |---|---|
 * | `TALENT:恋慕` | 41,622 |
 * | `TALENT:服従` | 40,698 |
 * | `TALENT:恋人` | 4,881 |
 * | `TALENT:合意` | 4,040 |
 * | `TALENT:親友` | 2,866 |
 * | `TALENT:MASTER:処女`（作用域形） | 1,183 |
 * | `TALENT:処女`（无作用域形） | 1,034 |
 * | `TALENT:親愛` | 888 |
 * | `TALENT:隷属` | 867 |
 * | `CFLAG:対象:好感度` / `CFLAG:好感度` | 328 / 262 |
 *
 * 名称全部在 `CSV/Talent.csv` 里核对过编号（恋慕 150 / 親友 151 / 親愛 152 /
 * 恋人 153 / 服従 154 / 隷属 155 / 合意 160 / 処女 1）——**不写凭印象的名字**。
 *
 * ## 为什么一条线要列好几个键
 *
 * 本作的状态键有两种作用域写法：`TALENT:MASTER:処女`（带目标变量名）与
 * `TALENT:処女`（无作用域）。对 `dependencyKey()` 来说这是两条不同的依赖键；
 * 矩阵按 `keys` **精确匹配行** ⇒ 少列一种，那条线在那些函数里就不亮。
 * `CFLAG:好感度` 同理（`CFLAG:対象:好感度` 与裸形并存）。
 *
 * 键一律用**游戏原文**（日文汉字写法，如 `服従` 而非 `服从`），因为依赖键从源码
 * 原文归一，不能自行翻译。
 */
import type { StateLinePreset } from '@kojo/plugin-api';

export const ERATOHOK_STATE_LINES: readonly StateLinePreset[] = [
  {
    id: 'love',
    label: '恋慕线',
    description: '恋慕（本作最高频状态，41,622 处；Talent.csv 150 号）',
    keys: ['TALENT:恋慕'],
  },
  {
    id: 'obey',
    label: '服従线',
    description: '服従（仅次于恋慕，40,698 处；Talent.csv 154 号）',
    keys: ['TALENT:服従'],
  },
  {
    id: 'lover',
    label: '恋人线',
    description: '恋人（告白成功后的关系，4,881 处；Talent.csv 153 号）',
    keys: ['TALENT:恋人'],
  },
  {
    id: 'consent',
    label: '合意线',
    description: '合意（允许过激行为的许可位，4,040 处；Talent.csv 160 号）',
    keys: ['TALENT:合意'],
  },
  {
    id: 'friend',
    label: '親友线',
    description: '親友（同性且非两刀时的恋慕替代，2,866 处；Talent.csv 151 号）',
    keys: ['TALENT:親友'],
  },
  {
    id: 'virgin',
    label: '処女线',
    description: '処女（含 `TALENT:MASTER:処女` 作用域形 1,183 处 / 裸形 1,034 处）',
    keys: ['TALENT:MASTER:処女', 'TALENT:処女'],
  },
  {
    id: 'dear',
    label: '親愛线',
    description: '親愛（恋慕上位，888 处；Talent.csv 152 号）',
    keys: ['TALENT:親愛'],
  },
  {
    id: 'servant',
    label: '隷属线',
    description: '隷属（服従上位，867 处；Talent.csv 155 号）',
    keys: ['TALENT:隷属'],
  },
  {
    id: 'favor',
    label: '好感度线',
    description: '好感度（CFLAG:2；含 `CFLAG:対象:好感度` 作用域形 328 处与裸形 262 处）',
    keys: ['CFLAG:対象:好感度', 'CFLAG:好感度'],
  },
];
