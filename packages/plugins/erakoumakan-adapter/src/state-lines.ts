/**
 * era紅魔館 的**剧情线预设**（`GameAdapter.stateLinePresets`；条件矩阵的快捷选格用）。
 *
 * ## 为什么是这五条（真盘读数，不是「CSV 里有这个名字」）
 *
 * 2026-10-25 对 `ERB/口上` 全量 403 份 ERB 的条件位计数（去注释、按原文归一）：
 *
 * | 状态键 | 出现次数 |
 * |---|---|
 * | `TALENT:奴隷:恋慕` | 2,936 |
 * | `TALENT:奴隷:处女` | 1,230 |
 * | `CFLAG:奴隷:处女喪失中` | 1,175 |
 * | `TALENT:奴隷:浮気公認` | 599 |
 * | `TALENT:恋慕`（无作用域形） | 564 |
 * | `TALENT:奴隷:公众便所` | 464 |
 * | `MARK:屈服刻印` | 446 |
 * | `TALENT:奴隷:亲爱` | 344 |
 * | `TALENT:MASTER:NTR` / `TALENT:奴隷:NTR` | 20 / 10 |
 *
 * ## 为什么一条线要列好几个键
 *
 * 本作的状态键有**两种作用域写法**：`TALENT:奴隷:恋慕`（本作主形，`奴隷` 是
 * 目标变量名）与 `TALENT:恋慕`（无作用域，全局/主角形）。对 `dependencyKey()` 来说
 * 这是两条不同的依赖键；矩阵按 `keys` **精确匹配行** ⇒ 少列一种，那条线在那些
 * 函数里就不亮。故每条线把真盘出现过的拼写都列上。
 *
 * 键一律用**游戏原文**（含繁简/日文写法，如 `处女`、`親愛` 未出现则用 `亲爱`），
 * 因为依赖键从源码原文归一，不能自行翻译。
 */
import type { StateLinePreset } from '@kojo/plugin-api';

export const ERAKOUMAKAN_STATE_LINES: readonly StateLinePreset[] = [
  {
    id: 'love',
    label: '恋慕线',
    description: '目标对主人公的恋慕（本作最高频状态，2,936 处；含无作用域形）',
    keys: ['TALENT:奴隷:恋慕', 'TALENT:TARGET:恋慕', 'TALENT:恋慕'],
  },
  {
    id: 'virgin',
    label: '处女线',
    description: '处女状态与丧失过程（`TALENT:奴隷:处女` 1,230 处 / `CFLAG:奴隷:处女喪失中` 1,175 处）',
    keys: ['TALENT:奴隷:处女', 'TALENT:处女', 'CFLAG:奴隷:处女喪失中'],
  },
  {
    id: 'yield-mark',
    label: '屈服刻印线',
    description: '屈服刻印（`MARK:屈服刻印` 446 处；取得记录在 TCVAR）',
    keys: ['MARK:屈服刻印', 'TCVAR:奴隷:屈服刻印取得'],
  },
  {
    id: 'affair',
    label: '浮気公認线',
    description: '浮気公認 / NTR 状态（`TALENT:奴隷:浮気公認` 599 处；主角侧 NTR 20 处）',
    keys: ['TALENT:奴隷:浮気公認', 'TALENT:MASTER:NTR', 'TALENT:奴隷:NTR'],
  },
  {
    id: 'dear',
    label: '亲爱线',
    description: '亲爱（恋慕之后的关系阶段；`TALENT:奴隷:亲爱` 344 处）',
    keys: ['TALENT:奴隷:亲爱', 'TALENT:亲爱'],
  },
];
