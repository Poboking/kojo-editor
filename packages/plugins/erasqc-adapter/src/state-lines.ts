/**
 * eraSQC 的**剧情线预设**（`GameAdapter.stateLinePresets`；条件矩阵的快捷选格用）。
 *
 * ## 为什么是这六条（真盘读数，不是「CSV 里有这个名字」）
 *
 * 2026-10-25 对 `ERB/EVENT_K` 全量 111 份 ERB 的条件位计数（去注释、按原文归一）：
 *
 * | 状态键 | 出现次数 |
 * |---|---|
 * | `TALENT:恋慕` | 23,037 |
 * | `MARK:反发刻印` | 16,739 |
 * | `MARK:屈服刻印` | 4,375 |
 * | `ABL:奉仕精神` | 2,478 |
 * | `TALENT:处女` | 618 |
 * | `TALENT:淫乱` | 555 |
 * | `TALENT:孕娠` | 386 |
 * | `TALENT:相思相爱` | 297 |
 *
 * 键一律用**游戏原文**（本作是简体汉化版，如 `反发刻印` 用「发」不用「發」）——
 * 依赖键从源码原文归一，不能自行翻译。
 */
import type { StateLinePreset } from '@kojo/plugin-api';

export const ERASQC_STATE_LINES: readonly StateLinePreset[] = [
  {
    id: 'love',
    label: '恋慕线',
    description: '目标对主人公的恋慕（本作最高频状态，23,037 处）',
    keys: ['TALENT:恋慕'],
  },
  {
    id: 'repulse-mark',
    label: '反发刻印线',
    description: '反发刻印（16,739 处，调教失败/反感路线的主判据）',
    keys: ['MARK:反发刻印'],
  },
  {
    id: 'yield-mark',
    label: '屈服刻印线',
    description: '屈服刻印（4,375 处，调教推进的主要阶段）',
    keys: ['MARK:屈服刻印'],
  },
  {
    id: 'service',
    label: '奉仕精神线',
    description: '奉仕精神能力（2,478 处，调教者奉仕指令的分支）',
    keys: ['ABL:奉仕精神'],
  },
  {
    id: 'virgin',
    label: '处女线',
    description: '处女状态（`TALENT:处女` 618 处）',
    keys: ['TALENT:处女'],
  },
  {
    id: 'lewd',
    label: '淫乱线',
    description: '淫乱 / 孕娠 / 相思相爱（`TALENT:淫乱` 555 / `孕娠` 386 / `相思相爱` 297 处）',
    keys: ['TALENT:淫乱', 'TALENT:孕娠', 'TALENT:相思相爱'],
  },
];
