/**
 * 上下文带的**窄屏溢出**（VIS-15 E2，1026 编辑器体感批）。
 *
 * ## 为什么要单独立一枚模块
 *
 * 「更多」那一族以前是 EditorPane 就地自造的一套弹出语言：`toolbar-more-pop` 是一坨
 * 绝对定位的 `span`，外部按下 / Esc 的收起逻辑自己写了一遍、焦点归还自己没管、视口夹取
 * 更没有（浮层能顶出窗口右边）。全站右键 / 下拉菜单早就共用 `<ContextMenu>`
 * （遮罩只认左键、Esc 逐级关闭、焦点归还调用者、`clampMenuPosition` 夹视口）。
 * **同一个界面里不该有两种弹窗**——本模块把那簇内容改喂给共享菜单，只留数据，不留 DOM。
 *
 * ## 为什么判据是 1024 而不是原来的 1280
 *
 * `matchMedia('(max-width: 1280px)')` 在**默认窗口宽度上就命中**（壳的默认窗宽正是 1280），
 * 于是每一次正常编辑都被当成窄屏：次要信息永远藏在「更多」后面，那颗按钮天天在场。
 * 收带之后带子里只剩「身份 + 符号链 / 预览开关 · 解锁态 · 状态位 · 保存」，
 * 实测内容宽约 480px，真正挤不下的门槛落在 1024 以下（半屏副屏 / 窄分栏），
 * 所以断点改到 `(max-width: 1024px)`——**判据要的是"真的窄"，不是"默认就不宽"**。
 *
 * ## 溢出里放什么、不放什么
 *
 * 只放**次要项**：糖摘要（一句读数，不可点，全文在悬停里）与「显示语法标记」开关
 * （可点，勾选态 = 当前是否高对比）。主控件一律不藏：预览开关、解锁态、状态位、保存
 * 按下去都有直接后果，藏进菜单等于把可达性换成美观。
 * 旧的「目录前缀」那一格不在这里出现——绝对长前缀**任何宽度都不上屏**（项目相对口径），
 * 完整路径恒在文件名的 `title` 里，要取全文还有面包屑右键的「复制路径 / 复制相对路径」。
 * 两枚降级徽章（校验暂停 / 折叠超额）也已离开带子（见 EditorPane 的 `bandNoticeNodes`
 * 落点说明），所以菜单里不再重复它们。
 */
import type { ContextMenuItem } from '../context-menu';

/** 菜单项 id（EditorPane 的回执分发与单测共用同一串，不写两处字面量） */
export const BAND_STATS_ID = 'band-sugar-stats';
export const BAND_MARKS_ID = 'band-sugar-marks';

/**
 * 糖摘要的全文（作者口径，零内部词）。
 *
 * 单源住在这里：带子里那一格的 `title` 与窄屏菜单项的 `disabledReason` 吃的是**同一句**，
 * 两处抄两遍迟早漂——而漂了没人发现，因为两句都读得通。
 */
export const SUGAR_STATS_DETAIL =
  '其余行按原样显示：.kojo 还没覆盖到的控制流（SIF / 循环 / TRY）、赋值与调用，以及注释和空行。文件内容始终没有被改动。';

/** 「显示语法标记」那颗开关的标签（带子里与菜单里必须逐字一致；换字会横抖，故恒字） */
export const SUGAR_MARKS_LABEL = '显示语法标记';

/** 溢出按钮的悬停（说清里面有什么，别让「更多」读成"坏了的省略号"） */
export const BAND_MORE_TITLE =
  '窄屏让位：糖摘要与「显示语法标记」收在这里——预览开关、解锁态、状态位、保存仍直接可点。';

/** 菜单里一句读数的最长显示宽度（超出交给省略号；全文永远在 disabledReason 里） */
export const BAND_STATS_LABEL_MAX = 40;

/** 溢出簇的现场（纯事实，零判定：带子问"现在预览上屏了吗、标记高对比吗"） */
export interface BandSecondaryFacts {
  /** 预览真在屏上（= 糖摘要与标记开关这一族才存在；与 `sugarPreviewing` 同一口径） */
  readonly previewing: boolean;
  /** 糖摘要那句读数（`null` = 没算过 / 零段） */
  readonly stats: string | null;
  /** 语法标记当前是否高对比显示（= 菜单项的勾选态） */
  readonly marks: boolean;
}

/** 这一族次要项到底有没有（一样都没有 ⇒ 那颗「更多」按钮根本不出现） */
export function bandHasSecondary(facts: BandSecondaryFacts): boolean {
  return facts.previewing && facts.stats !== null;
}

/**
 * 窄屏溢出菜单的条目（纯映射）。
 *
 * 读数那一格是 `disabled` 的信息行——铁律 4 的菜单侧同款：按不动的东西必须说清为什么
 * 按不动（`disabledReason` 进 `title` 与 `aria-description`），不许灰着不说话。
 * 这里没有可点的动作，只有一个"按不动"的理由：**它是一句读数，不是一条命令**。
 */
export function bandOverflowItems(facts: BandSecondaryFacts): ContextMenuItem[] {
  if (!bandHasSecondary(facts)) return [];
  const stats = facts.stats ?? '';
  const label = stats.length > BAND_STATS_LABEL_MAX ? `${stats.slice(0, BAND_STATS_LABEL_MAX)}…` : stats;
  return [
    {
      id: BAND_STATS_ID,
      label,
      disabled: true,
      disabledReason: `这是一句读数，不是一条命令（点开跳不到任何地方）。${SUGAR_STATS_DETAIL}`,
    },
    {
      id: BAND_MARKS_ID,
      label: SUGAR_MARKS_LABEL,
      checked: facts.marks,
      dividerBefore: true,
    },
  ];
}
