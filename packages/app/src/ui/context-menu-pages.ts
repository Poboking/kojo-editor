/**
 * 页面级右键菜单的**公共小件**（零渲染，可直接打纯函数）：剪贴板判据、一句人话回执、
 * 左键判据转发。原先还装着欢迎页两个面的菜单数据，2026-10-26 随白名单一起退役（见文末）。
 *
 * ## 为什么单开一个模块
 *
 * 菜单项的判据（哪一项显示、哪一项灰着、灰的原因是什么）必须能被单测直接打，
 * 不能建立在"整页渲染出来点一下"上；「复制成功/失败都要说话」这套口径又是跨页共享的
 * ——放在组件里会被复制两遍。
 *
 * ## 模块边界（2026-10 减重后）
 *
 * 本模块在开机图上（`main.tsx → App → WelcomeView → 这里`），所以它**只装首屏要用的东西**。
 * 设置页与快捷键页的两个面已经搬到 `settings-menu.ts`——那两个面依赖设置项索引、
 * 外观偏好与键位表，而它们的宿主（`SettingsPanel.tsx`）本来就是懒加载的，没有理由让
 * 首屏替它们付账。**不要在这里转发 `settings-menu` 的符号**，也不要 value-import
 * `settings-search` / `editor-display-prefs` / `editor-options` / `keybindings`——
 * 那等于把剪断的懒边接回首屏（判据见 `settings-menu.test.ts`）。
 *
 * 本模块留下的公共小件（`clipboardAvailable` / `copyText` / `useMenuNote` / `isFailureNote`）
 * 仍被设置页与快捷键页引用：它们本来就已在首屏，反着依赖（懒 → 常驻）不会带重新东西。
 *
 * ## 铁律的落点
 *
 * 1. **文案全中文**（含 CJK）：回执同样是给作者读的人话，不许出现英文原样；
 * 2. **能力不存在 ⇒ 不说假话**：没有剪贴板时 `copyText` 直接回一条失败，而不是静默；
 * 3. **成败都上屏**：复制这类"最容易读成没生效"的动作，成功与失败各有一句话。
 */
import { useEffect, useState } from 'react';

/* ==========================================================================================
 * 一、公共小件：剪贴板与「一句话回执」
 *
 * 这几件不是欢迎页专属：设置页与快捷键页（`settings-menu.ts`，懒 chunk）也引用它们，
 * 所以留在本模块而不是跟着页面走——懒模块从常驻模块取料，不会把常驻图撑大。
 * ========================================================================================== */

/**
 * 当前环境有没有可写剪贴板。
 *
 * 构建期判据：没有就让「复制…」整项不出现（铁律的「能力不存在」），
 * 而不是给一个按下去只弹失败的入口。
 */
export function clipboardAvailable(): boolean {
  if (typeof navigator === 'undefined') return false;
  const clip: Clipboard | undefined = navigator.clipboard;
  return clip !== undefined && typeof clip.writeText === 'function';
}

/**
 * 写剪贴板并留下人话回执（成功、失败都说一句）。
 *
 * 复制是**最容易读成"没生效"**的动作：不吭声时作者只能反复点，最后怀疑按钮坏了。
 * 回执走各页自己的状态行（`role="status"`），不弹模态、不抢焦点。
 */
export function copyText(text: string, what: string, note: (line: string) => void): void {
  if (!clipboardAvailable()) {
    note('复制失败：当前环境没有可用的剪贴板');
    return;
  }
  void navigator.clipboard.writeText(text).then(
    () => note(`已复制${what}`),
    () => note('复制失败：剪贴板拒绝了这次写入'),
  );
}

/** 菜单回执在屏幕上留多久（毫秒）：够读完一句中文，又不至于赖着） */
const MENU_NOTE_MS = 2600;

/**
 * 页面级的「菜单回执」状态（`note` 人话上屏 + 到时自动收起）。
 *
 * 各页共用这一份：菜单动作的回执不该三种写法——一处 `role="status"`、一处 toast、
 * 一处只写 console，作者会以为只有某一页的复制生效了。
 */
export function useMenuNote(): readonly [string | null, (line: string) => void] {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (note === null) return;
    const timer = setTimeout(() => setNote(null), MENU_NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);
  return [note, setNote] as const;
}

/**
 * 回执是不是一条失败（上错误色用）。
 *
 * 判据落在文案上而不是多开一条 tone 通道：回执的措辞本来就要求把成败说出来
 * （「已复制…」/「复制失败：…」），颜色只是给这句话加一层强调——只靠颜色表意
 * 对色觉障碍与读屏都不作数。
 */
export function isFailureNote(line: string): boolean {
  return line.includes('失败') || line.includes('没法');
}

/**
 * 这次按下是不是**主键**（左键）——实现与文档已上收到数据面 `context-menu-model.ts`
 * （`isPrimaryButton`）：Palette / ShellLayout / 设置页三处共用同一个判据，
 * 各写一份 `button === 0` 迟早会漏掉一处。这里保留转发是为了不让既有 import 断掉。
 */
export { isPrimaryButton } from './context-menu-model';

/* ==========================================================================================
 * 二、欢迎页两个面已撤（2026-10-26）
 *
 * `welcome` / `welcome-recent` 两个面连同构建器与接线桥一起删了：欢迎页现在挂在
 * **免右键白名单**上（`context-surfaces.ts` 的 `NO_CONTEXT_MENU_ATTR`），整片不出菜单。
 * 事由是一起真实事故——弹窗态跑在轻档样式下，菜单没有定位几何，出来的是通栏裸块、
 * 遮罩 0 高：关不掉，还把整窗拖动判据一起带死。页面上的每个动作都有实心入口，
 * 菜单在这里没有独占能力，故整条子系统退役而不是「补一套轻档菜单样式」。
 *
 * 本模块留下的是公共小件（剪贴板 / 回执 / 左键判据），设置页与快捷键页仍在用。
 * ========================================================================================== */
