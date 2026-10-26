import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { splitNoticeMessage } from '../src/ui/NotificationCenter';

/**
 * 壳层通知与状态栏密度的守门（视觉批十一 R5 交付的五条行为，组长补的闸）。
 *
 * 为什么这些断言长这样：R5 那五条里有三条是**纯 CSS 形态**（让位、视觉隐藏、遮罩），
 * 起壳归组长，node 池量不到屏上像素；但"做没做对"的一半是可以静态钉死的——尤其是
 * **不许用哪一招**（降层糊让位、`display:none` 糊隐藏），那两类回潮一旦发生，
 * 读屏与右键复制会静默失效，正是这批反复付过学费的地方（PITFALLS 181/182）。
 * 另一半（屏上到底让没让开、light 档遮罩还灰不灰泥）归真壳复验，不在这里假称已证。
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const noticesCss = read('../src/shell-notices.css');
const tokensCss = read('../src/tokens.css');
const shellLayout = read('../src/ui/ShellLayout.tsx');
const pluginStatus = read('../../plugins/ui-plugin-status/src/index.ts');

describe('splitNoticeMessage：标题 + 一行摘要（有损排版、无损信息）', () => {
  it('实测那条数据倾倒：因果连接符 `：` 切一刀，全文一字不删地留在 rest 里', () => {
    const msg = '结构着色这次没顶上：结构着色丢掉 0 条越界行 / 17 条空区间 / 0 条超宽度 / 0 条同行重叠';
    const { head, rest } = splitNoticeMessage(msg);
    expect(head).toBe('结构着色这次没顶上');
    expect(rest).toBe('结构着色丢掉 0 条越界行 / 17 条空区间 / 0 条超宽度 / 0 条同行重叠');
    expect(head + '：' + rest).toBe(msg);
  });

  it('`⇒` 是结论连接符（丢掉语气）；`。` 是句末（跟着标题走）', () => {
    expect(splitNoticeMessage('取数失败 ⇒ 回到词法层')).toEqual({ head: '取数失败', rest: '回到词法层' });
    expect(splitNoticeMessage('这一版没有改动。要不要再看一眼明细')).toEqual({
      head: '这一版没有改动。',
      rest: '要不要再看一眼明细',
    });
  });

  it('没有天然停顿点 ⇒ 整句就是标题、摘要为空（不硬造半句）', () => {
    expect(splitNoticeMessage('这一句里没有任何天然停顿点')).toEqual({
      head: '这一句里没有任何天然停顿点',
      rest: '',
    });
  });

  it('头一句太长（>30 字）或分隔符贴太前（<2 字）都不切——切出来比原句更难读', () => {
    const long = '一'.repeat(40) + '：后面是细节';
    expect(splitNoticeMessage(long)).toEqual({ head: long, rest: '' });
    expect(splitNoticeMessage('：开头就来了')).toEqual({ head: '：开头就来了', rest: '' });
  });

  it('逗号/顿号不当标题分隔（那是半句，不是标题）', () => {
    const s = '读盘失败，稍后自动重试，也可以现在手动再来一次';
    expect(splitNoticeMessage(s)).toEqual({ head: s, rest: '' });
  });

  /**
   * 真壳 2026-10-24 读数：这条的标题在 262px 的 toast 里被省略号吃掉 24px——
   * 补充语「（这一面已退回原来的做法）」跟着摘要行走，标题才立得住。
   */
  it('补充语 `（…）` 跟着摘要行走（括号是配对符号，一枚字符都不丢）', () => {
    const msg = '结构着色这次没顶上（这一面已退回原来的做法）：结构着色丢掉 0 条越界行 / 17 条空区间';
    expect(splitNoticeMessage(msg)).toEqual({
      head: '结构着色这次没顶上',
      rest: '（这一面已退回原来的做法）：结构着色丢掉 0 条越界行 / 17 条空区间',
    });
    // 这一枚切点是"零丢弃"的：head + rest 逐字还原原句
    const { head, rest } = splitNoticeMessage(msg);
    expect(head + rest).toBe(msg);
  });

  it('括号切点也认独立的短消息（保存失败（磁盘只读）⇒ 标题四字 + 摘要括号）', () => {
    expect(splitNoticeMessage('保存失败（磁盘只读）')).toEqual({ head: '保存失败', rest: '（磁盘只读）' });
  });

  it('括号前的头不足 4 字 ⇒ 不切（「这一版」不是标题，是半句话的开头）', () => {
    const s = '这一版（临时）没有改动';
    expect(splitNoticeMessage(s)).toEqual({ head: s, rest: '' });
  });
});

describe('toast 让位模态：改位不降层（层序是另一条闸钉着的规矩）', () => {
  it('`--z-toast` 仍是 1200——让位不许靠把通知压到遮罩下来糊过去', () => {
    const m = /--z-toast:\s*(\d+)/.exec(tokensCss);
    expect(m, 'tokens.css 里 --z-toast 的定义被搬走了').not.toBeNull();
    expect(m![1]).toBe('1200');
  });

  it('让位整份 CSS 零 `z-index`：只平移，不动层序', () => {
    expect(noticesCss).not.toContain('z-index');
  });

  it('判据写在 CSS 里（`body:has(...)`），不是 JS 里数模态——且给错误条让出左下', () => {
    expect(noticesCss).toContain('body:has(.overlay-backdrop, .modal-mask)');
    expect(noticesCss).toContain('.project-session-error');
  });
});

/**
 * R6 债三（更新提醒卡 1180 档压着模态页脚右端）——**2026-10-24 组长复验后改判处理方式**。
 * R6 的方案是"照抄 ① 挪到左下"，宽窗成立；但窗口有法定下限（`tauri.conf.json` minWidth 960 /
 * minHeight 620），实测 1000×640 时设置浮层的**左侧导航列**就落在左下那一格 ⇒ 挪过去反而盖住了
 * 换页面的入口；而卡自身 z 1180 恒压模态（遮罩 1100 / 宿主 1101），挪到哪一侧都还贴在模态脸上。
 * 改判：模态在场时这张**可再生**的提醒整块不画（免打扰机制本来就允许它几天不出现，关掉模态自己回来）；
 * toast 列仍走 ① 的"改位不降层"——那一条承载的是"失败必须看得见"，不许隐。
 * 本段钉三件事：卡的层序定义没被顺手改、让位判据写在 CSS 而非 JS 数模态、被隐的只有卡。
 */
describe('更新提醒卡给模态让位（组长改判：整块不画，不是挪到左下）', () => {
  const cardCss = read('../src/update-notice-card.css');
  const CARD_YIELD = 'body:has(.overlay-backdrop, .modal-mask) .update-notice-card';

  it('卡的层序定义实质没动：仍落在 1180 这一档（让位不靠压层糊过去）', () => {
    // 体感批 B-2 把裸值 `1180` 收进档位表 `--z-card`。这条判据钉的是"哪一档"而不是
    // "哪个字面量"，所以两侧一起钉：卡吃 `--z-card`，且 `--z-card` 的真值仍是 1180——
    // 谁把档位表挪号、或谁把卡退回裸值，都红（比只钉字面量多拦一种漂移）。
    expect(cardCss).toMatch(/\.update-notice-card\s*\{[^}]*z-index:\s*var\(--z-card\);/);
    expect(read('../src/tokens.css')).toMatch(/--z-card:\s*1180;/);
    expect(noticesCss).not.toMatch(/update-notice-card[^}]*z-index/);
  });

  it('模态在场 ⇒ 这张卡不画；判据写在 CSS 的 `:has()` 里，不是 JS 数模态', () => {
    expect(noticesCss).toContain(CARD_YIELD);
    const at = noticesCss.indexOf(CARD_YIELD);
    const body = noticesCss.slice(at, noticesCss.indexOf('}', at) + 1);
    expect(body).toContain('display: none');
    // 反向红线：承载"失败必须看得见"的通知列绝对不许被整块隐掉
    expect(noticesCss, '通知列被整块隐藏 = 铁律 4 破防').not.toMatch(/\.notification-center[^{]*\{[^}]*display:\s*none/);
    // 旧的"挪到左下"方案不许回潮（它才是窄窗盖住导航列的那一手）
    expect(noticesCss).not.toMatch(/\.update-notice-card\s*\{[^}]*left:\s*16px/);
  });

  it('通知列仍按 R5 挪到左下（改位不降层那两条原样在——挪的是它，不是卡）', () => {
    expect(noticesCss).toMatch(
      /body:has\(\.overlay-backdrop, \.modal-mask\)\s*\.notification-center\.notification-shell\s*\{\s*left:\s*16px;\s*right:\s*auto;/,
    );
  });

  it('卡与错误条不再同屏抢位：模态在场没有卡，通知列只需抬过错误条一档', () => {
    expect(noticesCss).toMatch(
      /body:has\(\.overlay-backdrop, \.modal-mask\):has\(\.project-session-error\)\s*\.notification-center\.notification-shell\s*\{\s*bottom:\s*calc\(\s*var\(--notice-slot-bottom\) \+ var\(--notice-err-h\) \+ var\(--notice-gap\)\);/,
    );
    // "三件同屏再抬一档卡高"那条随本改判一起删——留着就是给未来的叠字埋雷
    expect(noticesCss).not.toContain(':has(.update-notice-card):has(.project-session-error)');
  });

  it('通知列的位移过渡两种降动效口径都压平（卡不再平移，这段只剩通知列）', () => {
    expect(noticesCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.notification-center\.notification-shell\s*\{\s*transition:\s*none;/,
    );
    expect(noticesCss).toMatch(/:root\[data-motion='reduced'\] \.notification-center\.notification-shell\s*\{\s*transition:\s*none;/);
  });
});

describe('视觉隐藏不许吞掉信息（读屏与右键复制仍要拿得到）', () => {
  /** 取某一处规则体，断言它用的是 clip 配方而不是 `display:none` */
  const hiddenRecipeIsNotDisplayNone = (anchor: string): void => {
    const at = noticesCss.indexOf(anchor);
    expect(at, `规则 ${anchor} 不在了`).toBeGreaterThan(-1);
    const body = noticesCss.slice(at, noticesCss.indexOf('}', at) + 1);
    expect(body).toContain('clip-path: inset(50%)');
    expect(body).not.toContain('display: none');
    expect(body).not.toContain('display:none');
  };

  it('状态栏次组三档数字：收起 = 1px 剪贴盒，DOM 逐档都在', () => {
    hiddenRecipeIsNotDisplayNone('.sb-diag-item:nth-last-child(-n + 3):not([style])');
  });

  it('插件行状态词：静息只留点与名字，词仍进 tooltip 与读屏', () => {
    hiddenRecipeIsNotDisplayNone('.plugin-status-quiet');
    expect(pluginStatus).toContain('export function pluginRowTooltip');
    expect(pluginStatus).toContain('STATUS_LABEL[r.status]');
    expect(pluginStatus).toContain('缺少依赖');
  });

  it('有事故那一格永不收起：靠 `:not([style])` 把内联色那两格挡在收起规则外', () => {
    expect(noticesCss).toContain(':not([style])');
    expect(shellLayout).toContain('data-sb-secondary');
  });
});

/**
 * 底部浮层的竖序抬升（2026-10-24 组长真壳复验补）。
 *
 * 为什么单独立一段：R6 交付的 128 / 214 与 L05 的 122 都建立在「卡高 ≈ 86」这个**没量过的数**上，
 * 真壳（1440×900 / 760×700，卡 CSS 到位后逐枚取 rect）量下来卡实际 **116 高** ⇒ toast 列下沿压在
 * 卡的上半截，`card_vs_toast` 三档宽度全部重叠。抬升现在由 `tokens.css` 的 `--notice-*` 实测族算出，
 * 这一段钉三件事：实测余量还在、估算常数没回潮、每条 calc 都含它该含的项（少一项就叠字）。
 */
describe('底部浮层抬升 = 实测 token 的算术（不许回到拍来的常数）', () => {
  const cardCss = read('../src/update-notice-card.css');
  const flat = (s: string): string => s.replace(/\s+/g, ' ');
  const tokenPx = (name: string): number => {
    const m = new RegExp(`${name}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(tokensCss);
    expect(m, `tokens.css 里读不到 ${name}（抬升族不许改名或挪走，判据会瞎）`).not.toBeNull();
    return Number(m![1]);
  };
  const SLOT = tokenPx('--notice-slot-bottom');
  const GAP = tokenPx('--notice-gap');
  const ERR = tokenPx('--notice-err-h');
  const CARD = tokenPx('--notice-card-h');

  /** 取某条选择器里 `bottom: calc(...)` 的内容（空白压平，选择器换行不影响定位） */
  const riseOf = (src: string, selector: string): string => {
    const at = flat(src).indexOf(flat(selector));
    expect(at, `选择器不在了：${selector}`).toBeGreaterThanOrEqual(0);
    const m = /bottom: calc\(([\s\S]*?)\);/.exec(flat(src).slice(at, at + 900));
    expect(m, `${selector} 的 bottom 不是 calc —— 抬升又变回裸常数了`).not.toBeNull();
    return (m?.[1] ?? '').replace(/\s+/g, '');
  };

  it('实测余量：错误条 ≥ 89、卡 ≥ 116（真壳读数，槽位与间隙都得 > 0）', () => {
    expect(ERR).toBeGreaterThanOrEqual(89);
    expect(CARD).toBeGreaterThanOrEqual(116);
    expect(GAP).toBeGreaterThan(0);
    expect(SLOT).toBe(36);
  });

  it('拍来的估算常数（122 / 128 / 214）在两处切片里一处不剩', () => {
    for (const [name, src] of [
      ['shell-notices.css', noticesCss],
      ['update-notice-card.css', cardCss],
    ] as const) {
      expect(src, `${name} 又出现写死的抬升常数`).not.toMatch(/bottom:\s*(?:122|128|214)px/);
    }
  });

  it('两条抬升各含该含的项：让开谁就把谁的高度加进抬升', () => {
    // ① 模态 + 错误条：通知列只抬过错误条，不许凭空多抬一档卡高（卡那档已随 ⑥ 改判删掉）
    const errOnly = riseOf(noticesCss, 'body:has(.overlay-backdrop, .modal-mask):has(.project-session-error) .notification-center.notification-shell {');
    expect(errOnly).toContain('var(--notice-err-h)');
    expect(errOnly).not.toContain('--notice-card-h');
    // 卡文件的基线（无模态、卡在场）：通知列抬过卡，不涉及错误条
    const baseRise = riseOf(cardCss, 'body:has(.update-notice-card) .notification-center {');
    expect(baseRise).toContain('var(--notice-card-h)');
    expect(baseRise).not.toContain('--notice-err-h');
  });

  it('抬升算出来真的够（槽位 + 高度 + 间隙 ≥ 被让位者的顶缘）', () => {
    expect(SLOT + ERR + GAP).toBeGreaterThan(SLOT + 89); // 136 > 错误条顶缘实测 125
    expect(SLOT + CARD + GAP).toBeGreaterThan(SLOT + 116); // 164 > 卡顶缘实测 152
  });
});
