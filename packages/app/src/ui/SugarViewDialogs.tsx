/**
 * 糖视图相关的两个模态对话框（2026-10-12 批；宿主 UI，零业务知识）。
 *
 * 两个都是**一次性的选择**，形态与 `SaveWarningDialog` 同款（遮罩 + 卡片 + 按钮组），
 * 但语义截然不同，故分开写、各自单测文案：
 *
 * 1. `SugarViewIntroDialog`——**首次打开 ERB** 时问"要不要用语法糖视图"。
 *    为什么要问：糖视图默认开（本功能的存在理由就是"打开就能读懂"），但一个会改变
 *    文件显示方式的功能，必须在第一次出现时**告诉用户它存在**，并给一次"关掉"的机会——
 *    否则用户只会觉得"我的 ERB 怎么变样了"。
 * 2. `ErbUnlockDialog`——用户**试图编辑只读的 ERB** 时问"要保持只读还是允许编辑"。
 *    诚实地把代价说清：解锁编辑会关闭该文件的语法糖视图（糖视图要求原文让位，
 *    而可编辑的原文必须能看见）。
 *
 * ## 按钮层级与文案跟全站模态对齐（2026-10-12 UI 归一批）
 *
 * 房规（`SaveWarningDialog` / `UnsavedConfirmDialog` / `WritableApprovalDialog` 三家一致）：
 * **`primary` 恒等于推荐项，且排在最右**，其余走 `ghost`。本文件初版把「允许编辑」放上
 * `primary`、把标着"推荐"的「保持只读」压成 `ghost`——视觉重量与文字推荐互相打架，
 * 而且高风险那一侧恰好是更亮的那个。现按房规对调；"推荐"二字随视觉重量归位，故从标签里删掉。
 *
 * 面向作者的句子里不留实现术语：`EraBasic` 是语言名，口上作者的词表里没有它，
 * 换成他能对上号的"这套语法"；「映射」「投影」一类说法同样不上屏（见 `sugar-view.ts`）。
 */

import type { ReactElement } from 'react';
import { useModalEscape } from './modal-stack';

/** 首次引导：是否开启语法糖视图 */
export function SugarViewIntroDialog({
  onDecide,
}: {
  /** true = 开启；false = 不用（写进偏好，之后可在设置里改回来） */
  onDecide: (on: boolean) => void;
}): ReactElement {
  // Esc = 不用（HK-2）：开启会写偏好，且作者可能只是想看清这段说明
  useModalEscape(() => onDecide(false));
  return (
    <div className="modal-mask">
      <div className="modal" role="dialog" aria-modal="true" aria-label="语法糖视图">
        <h2>要开启「语法糖视图」吗？</h2>
        <p>
          这是一份 <b>ERB</b>（游戏原生格式）文件。开启语法糖视图后，编辑器会把它
          <b>就地显示成中文表层写法</b>——台词像剧本、条件变成「如果 …：」，没学过这套语法
          也能读懂别人写的口上；暂时还不支持的行保持原样显示。
        </p>
        <p className="dim">
          只读显示，<b>不会改动文件一个字节</b>；随时可在「设置」里关闭，或用
          <b> Ctrl+Alt+T</b> 切换。
        </p>
        <div className="modal-actions">
          <button className="ghost" onClick={() => onDecide(false)}>
            不用
          </button>
          <button className="primary" onClick={() => onDecide(true)}>
            开启
          </button>
        </div>
      </div>
    </div>
  );
}

/** ERB 解锁确认：保持只读 / 允许编辑 */
export function ErbUnlockDialog({
  fileName,
  onDecide,
}: {
  fileName: string;
  /** true = 允许编辑（该文件语法糖视图将关闭）；false = 继续保持只读 */
  onDecide: (allow: boolean) => void;
}): ReactElement {
  // Esc = 保持只读（HK-2）：解锁会关掉这份文件的糖视图并允许直写游戏目录，
  // 是这五家里唯一"两个方向都有代价"的一个——按 ADR-0005，代价小的那一侧是不写盘。
  useModalEscape(() => onDecide(false));
  return (
    <div className="modal-mask">
      <div className="modal" role="dialog" aria-modal="true" aria-label="ERB 只读保护">
        <h2>这份 ERB 默认是只读的</h2>
        <p>
          <code>{fileName}</code> 是游戏目录里的原生 ERB。
          <b>直接编辑它会让语法糖视图失效</b>——糖视图靠"把原文换成中文表层写法"来读懂，
          而可编辑的原文必须始终看得见。
        </p>
        <p className="dim">
          更稳妥的做法：<b>新建一份口上文件（.kojo）</b>来写自己的内容——它可全程用语法糖书写，
          并能编译为合规 ERB。
        </p>
        <div className="modal-actions">
          <button className="ghost" onClick={() => onDecide(true)}>
            仍要直接编辑
          </button>
          <button className="primary" onClick={() => onDecide(false)}>
            保持只读
          </button>
        </div>
      </div>
    </div>
  );
}
