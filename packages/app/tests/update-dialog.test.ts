import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UpdateDialog } from '../src/ui/UpdateDialog';
import { UPDATE_NOTE_LINE_LIMIT, type UpdateDialogPhase } from '../src/ui/update-check';

/**
 * 更新弹窗（详情模态）的渲染面（用户反馈第 1 条 · 批次十一 L05 重做后同步）。
 *
 * 环境是 node + `renderToStaticMarkup`：不跑 effect、不碰 DOM，只钉**静态可读性**的那几条——
 * 标题 / 当前版本 / 发布日期 / **语义分组**、外链锚点、空说明的人话、超长说明的截断提示、
 * **状态与动作分离**（下载态页脚无假按钮）、完成态重启出口、dialog 的 aria 骨架。
 * 焦点陷阱与 Esc 走的是浏览器生命周期，交给真壳冒烟，不在这假装。
 */

const noop = (): void => {};

const html = (phase: UpdateDialogPhase, extra?: { onRestart?: () => void; forced?: boolean }): string =>
  renderToStaticMarkup(
    createElement(UpdateDialog, { phase, onClose: noop, onInstall: noop, ...extra }) as ReactElement,
  );

/** 本地正午的 ISO：任何时区渲染回来都还是同一天 */
const DATE = new Date(2026, 9, 17, 12, 0, 0).toISOString();

describe('UpdateDialog：found', () => {
  it('标题 / 当前版本 / 发布日期齐备；changelog 按语义分组渲染（组名 + 归组行）', () => {
    const out = html({
      kind: 'found',
      version: '0.5.0',
      currentVersion: '0.4.0',
      date: DATE,
      notes: '## 修复\n- 甲\n## 新增\n- 乙',
    });
    expect(out).toContain('发现新版本 v0.5.0');
    expect(out).toContain('当前 v0.4.0');
    expect(out).toContain('发布于 2026-10-17');
    // 分组：已知小节题被组名吸收，行按组落位；展示序「新增」在「修复」前
    expect(out).toContain('data-group="added"');
    expect(out).toContain('data-group="fixed"');
    expect(out).toContain('>新增<');
    expect(out).toContain('<p class="update-dialog-note-line"><span>- 乙</span></p>');
    expect(out.indexOf('data-group="added"')).toBeLessThan(out.indexOf('data-group="fixed"'));
  });

  it('说明里的 URL 渲染成原生外链锚点（target=_blank + rel=noopener），不裸 window.open', () => {
    const out = html({ kind: 'found', version: '0.5.0', notes: '详见 https://example.com/releases，见上' });
    expect(out).toContain(
      '<a class="update-dialog-note-link" href="https://example.com/releases" target="_blank" rel="noopener noreferrer">https://example.com/releases</a>',
    );
  });

  it('破坏性说明：data-severity 顶缘警示 + 标题旁警示牌；forced 时牌上多一句「需确认」', () => {
    const out = html({ kind: 'found', version: '0.5.0', notes: '- 破坏性：存储格式变更' });
    expect(out).toContain('data-severity="breaking"');
    expect(out).toContain('破坏性更新');
    expect(out).not.toContain('需确认');
    const forcedOut = html({ kind: 'found', version: '0.5.0', notes: '- 破坏性：存储格式变更' }, { forced: true });
    expect(forcedOut).toContain('破坏性更新 · 需确认');
  });

  it('破坏性 found：抬头警示牌之外还有一条动作指令（光一枚胶囊容易被当装饰）', () => {
    const out = html({ kind: 'found', version: '0.5.0', notes: '- 破坏性：存储格式变更' }, { forced: true });
    expect(out).toContain('class="update-dialog-alert"');
    expect(out).toContain('请先读完下面「破坏性变更」那一组');
    // 普通更新不许出现这条（否则每次都提醒作者"要停下读"）
    const normal = html({ kind: 'found', version: '0.5.0', notes: '- 新增：一张卡' });
    expect(normal).not.toContain('update-dialog-alert');
  });

  it('「稍后」把承诺说在明面上：按钮 title 直接写几天不再提醒（天数只有一个真源）', () => {
    const out = html({ kind: 'found', version: '0.5.0' });
    expect(out).toContain('title="这一版 7 天内不再提醒"');
  });

  it('说明为空 ⇒ 一句人话，不留空白井', () => {
    const out = html({ kind: 'found', version: '0.5.0', currentVersion: '0.4.0' });
    expect(out).toContain('这个版本没有附更新说明。');
    expect(out).not.toContain('class="update-dialog-notes"');
    expect(out).toContain('当前 v0.4.0');
    expect(out).not.toContain('发布于');
    expect(out).not.toContain('update-dialog-meta-sep');
  });

  it('超长说明只画前 N 行，并明说截断（不是悄悄吞）', () => {
    const notes = Array.from({ length: UPDATE_NOTE_LINE_LIMIT + 1 }, (_, i) => `第 ${i + 1} 行`).join('\n');
    const out = html({ kind: 'found', version: '0.5.0', notes });
    expect(out).toContain('仅显示前 400 行（共 401 行）');
    expect(out).toContain('第 400 行');
    expect(out).not.toContain('第 401 行');
  });

  it('右下动作齐备：稍后 / 下载并安装；aria 骨架完整', () => {
    const out = html({ kind: 'found', version: '0.5.0' });
    expect(out).toContain('>稍后<');
    expect(out).toContain('>下载并安装<');
    expect(out).toContain('role="dialog"');
    expect(out).toContain('aria-modal="true"');
    expect(out).toContain('aria-labelledby=');
  });
});

describe('UpdateDialog：downloading / done / failed', () => {
  it('downloading：进度条 + 百分比；状态在正文胶囊、页脚只剩真动作「后台下载」（无禁用假按钮）', () => {
    const out = html({
      kind: 'downloading',
      version: '0.5.0',
      currentVersion: '0.4.0',
      received: 512,
      total: 1024,
    });
    expect(out).toContain('正在下载 v0.5.0');
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-valuenow="50"');
    expect(out).toContain('已下载 512 B / 1.0 KB（50%）');
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('后台下载');
    expect(out).toContain('class="update-status"');
    // 胶囊与进度条都是三张面共用的基元（`update-progress.css`），设置页/右下卡吃同一份
    expect(out).toContain('class="update-progress"');
    expect(out).toContain('data-size="md"');
    // 缺陷点：「正在下载…」不再是页脚那颗禁用按钮
    expect(out).not.toContain('disabled');
    expect(out).not.toContain('下载并安装');
    expect(out).toContain('aria-label="关闭更新面板"');
  });

  it('总量未知：进度条转不定态，胶囊仍在，右侧报已下载字节', () => {
    const out = html({
      kind: 'downloading',
      version: '0.5.0',
      received: 512,
      total: null,
    });
    expect(out).toContain('data-indeterminate="true"');
    // 版本号只归抬头那一格：胶囊再写一遍就成了同屏三次（改前正是「正在下载 v0.5.0…」）
    expect(out).toContain('正在下载…');
    expect(out.match(/v0\.5\.0/g)?.length).toBeLessThanOrEqual(2);
    expect(out).toContain('已下载 512 B，总量未知');
  });

  it('done（宿主无重启通道）：重启应用后生效 + 只留一个关闭', () => {
    const out = html({ kind: 'done', version: '0.5.0', currentVersion: '0.4.0' });
    expect(out).toContain('已安装 v0.5.0');
    expect(out).toContain('重启应用后生效');
    // 没有重启通道时那句指引要能照着做（白话），而不是再来一遍「重启应用」
    expect(out).toContain('关闭编辑器后重新打开即生效');
    expect(out).toContain('>关闭<');
    expect(out).not.toContain('立即重启');
    expect(out).not.toContain('下载并安装');
  });

  it('done（宿主给 onRestart）：主行动「立即重启」，出口「稍后重启」——缺按钮形态互斥', () => {
    const out = html({ kind: 'done', version: '0.5.0' }, { onRestart: noop });
    expect(out).toContain('>立即重启<');
    expect(out).toContain('>稍后重启<');
    expect(out).not.toContain('>关闭<');
    expect(out).toContain('请先保存手头的工作');
  });

  it('failed(install)：人话 + 重试 + 版本标题', () => {
    const out = html({
      kind: 'failed',
      stage: 'install',
      release: { version: '0.5.0', currentVersion: '0.4.0' },
    });
    expect(out).toContain('更新 v0.5.0 没有装好');
    expect(out).toContain('可重试');
    expect(out).toContain('>重试<');
    expect(out).toContain('role="alert"');
  });
});

/**
 * UPD-F（2026-11-05）行内富文本微渲染的判据。每条钉 **DOM 结构**（renderToStaticMarkup
 * 的逐字节片段），不钉快照——结构就是契约：`<strong>` / `<code>` 只在闭合标记处出现、
 * 未闭合原样成文、URL 段永远先于富文本（先 linkify 后富文本）。
 */
describe('changelog 行内富文本（UPD-F）', () => {
  const noteLine = (line: string): string =>
    html({ kind: 'found', version: '0.5.0', notes: line }).match(
      /<p class="update-dialog-note-line">[\s\S]*?<\/p>/,
    )?.[0] ?? '';

  it('加粗：`**甲**` → <strong>，两侧普通文本各自成 span（不整行裹进强调）', () => {
    expect(noteLine('- 支持 **增量解析**')).toBe(
      '<p class="update-dialog-note-line"><span>- 支持 </span><strong>增量解析</strong></p>',
    );
  });

  it('代码：`` `savDir` `` → <code>，前后文不变', () => {
    expect(noteLine('- 改 `savDir` 后生效')).toBe(
      '<p class="update-dialog-note-line"><span>- 改 </span><code>savDir</code><span> 后生效</span></p>',
    );
  });

  it('混排按出现顺序切；谁先出现谁先赢（代码里的星号、加粗里的反引号都是普通文本）', () => {
    expect(noteLine('**甲** 与 `乙`')).toBe(
      '<p class="update-dialog-note-line"><strong>甲</strong><span> 与 </span><code>乙</code></p>',
    );
    // 反引号先出现：一对代码整段成 <code>，内容里的 `**` 不再解释（不嵌套）
    expect(noteLine('`a**b` c')).toBe(
      '<p class="update-dialog-note-line"><code>a**b</code><span> c</span></p>',
    );
    // 星号先出现：一对加粗整段成 <strong>，内容里的反引号原样保留
    expect(noteLine('**a`b**')).toBe(
      '<p class="update-dialog-note-line"><strong>a`b</strong></p>',
    );
  });

  it('未闭合按原文渲染：`**只有一边` / `****` / 半对反引号都不产生 <strong>/<code>', () => {
    expect(noteLine('**只有一边')).toBe(
      '<p class="update-dialog-note-line"><span>**只有一边</span></p>',
    );
    expect(noteLine('****')).toBe('<p class="update-dialog-note-line"><span>****</span></p>');
    expect(noteLine('未闭合 `代码')).toBe(
      '<p class="update-dialog-note-line"><span>未闭合 `代码</span></p>',
    );
  });

  it('URL 优先级最高：链接两侧的星号按普通文本、URL 永远是纯 <a>（先 linkify 后富文本）', () => {
    const out = noteLine('**看 https://x 后续**');
    expect(out).toBe(
      '<p class="update-dialog-note-line"><span>**看 </span>' +
        '<a class="update-dialog-note-link" href="https://x" target="_blank" rel="noopener noreferrer">https://x</a>' +
        '<span> 后续**</span></p>',
    );
    expect(out).not.toContain('<strong>');
    // 反向面：URL 撞上代码标记也是 URL 赢——反引号不在 URL 字符集里，被切出去按普通文本
    const codeMangled = noteLine('看 `https://x`');
    expect(codeMangled).toContain('<a class="update-dialog-note-link" href="https://x"');
    expect(codeMangled).not.toContain('<code>');
  });

  it('转义不支持（明说的取舍）：`\\*\\*` 里没有连续星号，整段按原文成文', () => {
    expect(noteLine('\\*\\*不是标记\\*\\*')).toBe(
      '<p class="update-dialog-note-line"><span>\\*\\*不是标记\\*\\*</span></p>',
    );
  });
});

/**
 * UPD-C UI 打磨批（2026-11-05）的 CSS 判据。node 池量不到屏上像素，但「用没用对 token、
 * 配方对不对」可以静态钉死（读 CSS 的口径同 `shell-notice-density.test.ts`）；每条判据
 * 头上挂着它的对比度/几何算术（sRGB 合成算法同 `theme-contrast.test.ts`），谁要改值先改算式。
 */
describe('更新面 CSS 打磨判据（UPD-C）', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const dialogCss = read('../src/update-dialog.css');
  const progressCss = read('../src/update-progress.css');

  it('changelog 外链：字吃文字档 --accent-text、常态带下划线（色-only 区分不够 3:1）', () => {
    const block = /(^|\n)\.update-dialog-note-link \{([^}]*)\}/.exec(dialogCss)?.[2] ?? '';
    expect(
      block,
      '外链字色退回 --accent ⇒ 压玻璃校准面 dark 只有 4.41:1（正文破线）；文字档是 6.08 / light 6.51',
    ).toContain('color: var(--accent-text)');
    expect(
      block,
      '外链常态没有下划线 ⇒ 链色与相邻正文（--fg）的差最多 2.50:1 < 3.0，WCAG 1.4.1 的非颜色线索就没了',
    ).toContain('text-decoration: underline');
    // 悬停/焦点那条要还在（简写把 text-decoration-color 复位成 currentColor = 洗色升全色）
    expect(dialogCss).toContain('.update-dialog-note-link:hover');
    expect(dialogCss).toContain('.update-dialog-note-link:focus-visible');
  });

  it('破坏性警示牌：字吃 --danger-text、洗色 8%、描边保持 --danger（字换文字档、线留语义档）', () => {
    const block = /(^|\n)\.update-dialog-severity-tag \{([^}]*)\}/.exec(dialogCss)?.[2] ?? '';
    expect(
      block,
      '警示牌字色退回 --danger ⇒ 压 10% danger 洗色 dark 只有 4.03:1（fs-0 小字破 4.5）；文字档 + 8% 洗色下六档最低 4.56',
    ).toContain('color: var(--danger-text)');
    expect(
      block,
      '洗色涨回 10% ⇒ synthwave84（danger-text 与 --danger 同值档）跌回 4.43 破 4.5；8% 是六档全过的上限档',
    ).toContain('color-mix(in srgb, var(--danger) 8%');
    expect(block, '描边是"写在底上的线"不是字，语义档 --danger 不许顺手换掉（非文字判 3.0，4.58 过）').toContain(
      'border: 1px solid var(--danger)',
    );
  });

  it('模态关闭钮三态齐：hover 之外还有按下与焦点环（改前按下输给自己的 hover 规则）', () => {
    expect(
      dialogCss,
      '关闭钮缺按下态：全局 button:active (0,2,1) 输给这条 hover (0,3,0)，"点到了"没有反馈',
    ).toMatch(/\.update-dialog \.update-dialog-close:active:not\(:disabled\) \{[^}]*background:\s*var\(--active\)/);
    expect(
      dialogCss,
      '关闭钮缺焦点环：键盘 Tab 到它只借全局硬 outline，与卡关闭钮/枚 toast-close 的柔光环配方脱族',
    ).toMatch(/\.update-dialog \.update-dialog-close:focus-visible \{[^}]*box-shadow:\s*var\(--shadow-focus\)/);
  });

  it('不定态光带行程两端不出轨：38% 定宽下 from/to 都留一段在轨内（停成空轨 = 状态被吞）', () => {
    const kf = /@keyframes update-progress-indeterminate \{([\s\S]*?)\n\}/.exec(progressCss)?.[1] ?? '';
    const from = Number(/from \{[^}]*translateX\((-?[\d.]+)%\)/.exec(kf)?.[1]);
    const to = Number(/to \{[^}]*translateX\((-?[\d.]+)%\)/.exec(kf)?.[1]);
    expect(Number.isFinite(from) && Number.isFinite(to), 'keyframes update-progress-indeterminate 不在了').toBe(true);
    // 位移 % 以光带自身宽（轨道的 38%）为基准：带左缘 = 0.38×p，右缘 = 0.38×p + 38。
    // 端点要求「左缘 < 100 且右缘 > 0」＝至少一角仍在轨内——ease-in-out 在端点速度归零，
    // 整条带停在轨道外就会给出每周期两段的空轨窗口（改前 -110%/300% 正是这一幕）。
    const visibleAt = (p: number): boolean => 0.38 * p < 100 && 0.38 * p + 38 > 0;
    expect(visibleAt(from), `from ${from}%：整条带已滑出轨道 ⇒ 每周期开头有空轨窗口`).toBe(true);
    expect(visibleAt(to), `to ${to}%：整条带已滑出轨道 ⇒ 每周期结尾有空轨窗口`).toBe(true);
    // 反向红线：行程也不许收得太小——光带要真能扫过全轨（to 的左缘 ≥ 80%），
    // 不然不定态读起来像"卡在半道"
    expect(from, 'from 收得太小 ⇒ 光带没扫到左端就读不出"在进行"').toBeLessThanOrEqual(-50);
    expect(0.38 * to, 'to 的带左缘不够靠右 ⇒ 光带扫不到轨道右端').toBeGreaterThanOrEqual(80);
  });
});

/**
 * UPD-F 的 CSS 判据（读法同上）：strong 只强调不换色，code 走效果库 `.u-chip` 同一条
 * 芯片配方 + 全局 `code` 元素的同一份等宽栈——弹窗先于 styles-project 进 bundle，
 * 配方整份照抄是刻意的，这里钉住「抄的是这一份」不走样。
 */
describe('changelog 行内富文本 CSS 判据（UPD-F）', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const dialogCss = read('../src/update-dialog.css');

  it('strong：600 + 正文色（强调靠字重，不引入第五种花色）', () => {
    const block = /(^|\n)\.update-dialog-note-line strong \{([^}]*)\}/.exec(dialogCss)?.[2] ?? '';
    expect(block, 'strong 字重丢了').toContain('font-weight: 600');
    expect(block, 'strong 字色必须吃 --fg').toContain('color: var(--fg)');
  });

  it('code：等宽栈与全局 code 元素同源（--font-mono），芯片配方与 .u-chip 同一条', () => {
    const block = /(^|\n)\.update-dialog-note-line code \{([^}]*)\}/.exec(dialogCss)?.[2] ?? '';
    expect(block, '等宽栈要吃 --font-mono（全局 code 元素那一份，别造第二份）').toContain(
      'font-family: var(--font-mono)',
    );
    expect(block, '芯片底与 .u-chip 同配方（chip-bg 缺省落 --surface-overlay）').toContain(
      'background: var(--chip-bg, var(--surface-overlay))',
    );
    expect(block, '芯片圆角走 --radius-xs（定义点注释就写着"行内代码芯片"）').toContain(
      'border-radius: var(--radius-xs)',
    );
  });
});
