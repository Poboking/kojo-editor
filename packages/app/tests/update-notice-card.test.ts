/**
 * 更新提醒卡（层一）与其纯判据的单测（批次十一 L05 · UI 打磨批改四态后同步）。
 *
 * 环境是 node + `renderToStaticMarkup`（与 `update-dialog.test.ts` 同款）：只钉
 * 「这一次打扰不打扰、以哪层打扰」的判据与卡的静态可读性。hook 的会话编排
 * （模态开合 / 免打扰落盘 / X 收起）在真 React 生命周期里跑，见同批的
 * `update-notice-flow.test.ts`——这里不假装 effect。
 *
 * 本批同步的两处口径（不是放宽判据，是判据本身改了）：
 * - 卡从「只画 found」扩到模态可渲染的那四态，`notice.version` 这种直读联合类型的写法
 *   改吃 `updateReleaseVersion`（`failed` 的版本在 `release` 里）；
 * - 免打扰只拦「作者能拒绝这一版」的两态（found / failed），下载中与已装好不许被拦——
 *   否则点过「稍后」的同一版一旦开下起来，屏上就再没有任何进度落点（本批要修的死角）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  UpdateNoticeCard,
  decideUpdateNotice,
  type UpdateNoticeState,
} from '../src/ui/UpdateNoticeCard';
import {
  UPDATE_NOTE_LINE_LIMIT,
  detectUpdateSeverity,
  groupUpdateNotes,
  linkifyUpdateNoteLine,
  updateReleaseVersion,
  visibleUpdateNoteGroups,
  type UpdatePhase,
} from '../src/ui/update-check';

const noop = (): void => {};
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const found = (over?: Partial<Extract<UpdatePhase, { kind: 'found' }>>): UpdatePhase => ({
  kind: 'found',
  version: '0.4.3',
  currentVersion: '0.4.2',
  date: new Date(2026, 9, 17, 12, 0, 0).toISOString(),
  notes: '## 新增\n- 更新提醒卡',
  ...over,
});

describe('decideUpdateNotice · 打扰判据（卡/模态/安静的唯一分流）', () => {
  it('found 且没被免打扰 ⇒ 出卡；breaking ⇒ 不出卡、判 forced（打开即模态的许可位）', () => {
    const d = decideUpdateNotice(found(), { dismissal: null, now: Date.now() });
    expect(d.notice === null ? '' : updateReleaseVersion(d.notice)).toBe('0.4.3');
    expect(d.forced).toBe(false);

    const b = decideUpdateNotice(found({ notes: '## 破坏性变更\n- 换存储格式' }), { dismissal: null });
    expect(b.notice).toBeNull();
    expect(b.forced).toBe(true);
  });

  it('同版本免打扰期内 ⇒ 安静；过期 ⇒ 恢复举卡（缺陷③的核心判据）', () => {
    const dismissedAt = Date.now() - 3 * DAY;
    const within = decideUpdateNotice(found(), { dismissal: { version: '0.4.3', dismissedAt } });
    expect(within.notice).toBeNull();
    expect(within.forced).toBe(false);
    const expired = decideUpdateNotice(found(), {
      dismissal: { version: '0.4.3', dismissedAt: dismissedAt - 8 * DAY },
    });
    expect(expired.notice === null ? '' : updateReleaseVersion(expired.notice)).toBe('0.4.3');
    // 免打扰只对同版本：作者稍后再说 0.4.3，不妨碍提醒 0.5.0
    const other = decideUpdateNotice(found({ version: '0.5.0' }), {
      dismissal: { version: '0.4.3', dismissedAt },
    });
    expect(other.notice === null ? '' : updateReleaseVersion(other.notice)).toBe('0.5.0');
  });

  it('破坏性更新被作者推辞过（免打扰期内）⇒ 连模态都不自动开（forced 让位）', () => {
    const d = decideUpdateNotice(found({ notes: '- 破坏性：换存储格式' }), {
      dismissal: { version: '0.4.3', dismissedAt: Date.now() - HOUR },
    });
    expect(d.forced).toBe(false);
    expect(d.notice).toBeNull();
  });

  it('「更新在路上」不吃免打扰：下载中 / 已装好照样举卡（后台下载必须有屏上落点）', () => {
    const quiet = { dismissal: { version: '0.4.3', dismissedAt: Date.now() - HOUR } };
    const downloading: UpdatePhase = { kind: 'downloading', version: '0.4.3', received: 1, total: 2 };
    const done: UpdatePhase = { kind: 'done', version: '0.4.3' };
    expect(decideUpdateNotice(downloading, quiet).notice?.kind).toBe('downloading');
    expect(decideUpdateNotice(done, quiet).notice?.kind).toBe('done');
  });

  it('非四态（idle/checking/latest/failed(check)）连卡都不该有判据', () => {
    for (const phase of [
      { kind: 'idle' },
      { kind: 'checking' },
      { kind: 'latest' },
      { kind: 'failed', stage: 'check' },
    ] satisfies readonly UpdatePhase[]) {
      expect(decideUpdateNotice(phase, { dismissal: null }).notice).toBeNull();
    }
  });

  it('安装失败也举卡；同一版被推辞过就安静（推辞语义与 found 同一条）', () => {
    const failedInstall: UpdatePhase = { kind: 'failed', stage: 'install', release: { version: '0.4.3' } };
    expect(decideUpdateNotice(failedInstall, { dismissal: null }).notice?.kind).toBe('failed');
    expect(
      decideUpdateNotice(failedInstall, { dismissal: { version: '0.4.3', dismissedAt: Date.now() - HOUR } })
        .notice,
    ).toBeNull();
  });
});

describe('UpdateNoticeCard 渲染面（四态）', () => {
  const state: UpdateNoticeState = {
    kind: 'found',
    version: '0.4.3',
    currentVersion: '0.4.2',
    date: new Date(2026, 9, 17, 12, 0, 0).toISOString(),
  };

  const html = (s: UpdateNoticeState | null): string =>
    renderToStaticMarkup(createElement(UpdateNoticeCard, { state: s, onOpen: noop, onDismiss: noop, onInstall: noop }));

  it('found：标题只说状态、版本归徽标（改前两处各写一遍 v0.4.3）；查看/稍后齐备；role=status 非阻塞', () => {
    const out = html(state);
    expect(out).toContain('发现新版本');
    expect(out).toContain('class="update-notice-card-badge">v0.4.3<');
    expect(out).not.toContain('发现新版本 v0.4.3');
    expect(out).toContain('>查看<');
    expect(out).toContain('>稍后<');
    expect(out).toContain('data-phase="found"');
    expect(out).toContain('role="status"');
    expect(out).not.toContain('aria-modal');
    expect(out).toContain('当前 v0.4.2');
    expect(out).toContain('发布于 2026-10-17');
    // 「稍后」把承诺说在明面上（天数只有一个来源：UPDATE_NOTICE_QUIET_DAYS）
    expect(out).toContain('7 天内不再提醒');
  });

  it('state=null ⇒ 整个组件零节点（不留隐形占位）', () => {
    expect(html(null)).toBe('');
  });

  it('缺 currentVersion / date ⇒ 元信息行整行不画（不出现 "vundefined" 机器味）', () => {
    const out = html({ kind: 'found', version: '0.4.3' });
    expect(out).not.toContain('update-notice-card-meta');
    expect(out).not.toContain('vundefined');
  });

  it('downloading：缩略进度条 + 读数同排；只留「查看」（下载收不回，不给假退路）', () => {
    const out = html({ kind: 'downloading', version: '0.4.3', received: 512, total: 1024 });
    expect(out).toContain('data-phase="downloading"');
    expect(out).toContain('正在下载');
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-valuenow="50"');
    expect(out).toContain('data-inline="true"');
    expect(out).toContain('已下载 512 B / 1.0 KB（50%）');
    expect(out).toContain('>查看<');
    expect(out).not.toContain('>稍后<');
  });

  it('downloading 总量未知：轨道转不定态，读数说「总量未知」而不是画个假 0%', () => {
    const out = html({ kind: 'downloading', version: '0.4.3', received: 512, total: null });
    expect(out).toContain('data-indeterminate="true"');
    expect(out).toContain('已下载 512 B，总量未知');
  });

  it('done：那句「重启后生效」在卡上就看得见（不用进设置页找）；出口是「知道了」', () => {
    const out = html({ kind: 'done', version: '0.4.3', currentVersion: '0.4.2' });
    expect(out).toContain('data-phase="done"');
    expect(out).toContain('更新已就位');
    expect(out).toContain('更新已安装，重启应用后生效');
    expect(out).toContain('>知道了<');
    expect(out).not.toContain('>稍后<');
  });

  it('failed(install)：病因上卡 + 「重试」走同一个 install（与模态、设置页同一条腿）', () => {
    const out = html({ kind: 'failed', stage: 'install', release: { version: '0.4.3' } });
    expect(out).toContain('data-phase="failed"');
    expect(out).toContain('更新没装好');
    expect(out).toContain('可重试');
    expect(out).toContain('>重试<');
    expect(out).toContain('>稍后<');
  });
});

/**
 * UPD-C UI 打磨批（2026-11-05）的 CSS 判据（读 CSS 的口径同 `shell-notice-density.test.ts`）。
 * 徽标那格的算术：`--accent` 压 12% accent 洗色（洗色再压玻璃校准面）dark 只有 **3.74:1**，
 * fs-0 小字破 4.5；`--accent-text` 是 5.16 / light 5.48（sRGB 合成，算法同 `theme-contrast.test.ts`）。
 */
describe('版本徽标字色（UPD-C）', () => {
  const cardCss = readFileSync(fileURLToPath(new URL('../src/update-notice-card.css', import.meta.url)), 'utf8');

  it('徽标字吃 --accent-text；洗色与描边保持 --accent 语义档（非文字按 3.0 判，4.41 过）', () => {
    const block = /(^|\n)\.update-notice-card-badge \{([^}]*)\}/.exec(cardCss)?.[2] ?? '';
    expect(
      block,
      '徽标字色退回 --accent ⇒ dark 压 12% 洗色只有 3.74:1，fs-0 的版本号破 4.5 线',
    ).toContain('color: var(--accent-text)');
    expect(block).toContain('border: 1px solid var(--accent)');
    expect(block).toContain('color-mix(in srgb, var(--accent) 12%');
  });
});

describe('changelog 语义分组 / 严重度 / 外链切段（update-check 增补的纯逻辑）', () => {
  it('标题上下文归组：已知小节题被组名吸收，其下各行进对应组', () => {
    const groups = groupUpdateNotes('## 新增\n- 卡\n## 修复\n- 崩溃');
    expect(groups.map((g) => g.id)).toEqual(['added', 'fixed']);
    expect(groups[0]?.lines).toEqual(['- 卡']);
    expect(groups[1]?.label).toBe('修复');
  });

  it('裸列表按行判词；破坏性组永远排最前', () => {
    const groups = groupUpdateNotes('- 修复：某崩溃\n- 新增：提醒卡\n- breaking: 存储格式变更');
    expect(groups.map((g) => g.id)).toEqual(['breaking', 'added', 'fixed']);
  });

  it('认不出的小节（## 性能）原文进「其它」，语境不丢', () => {
    const groups = groupUpdateNotes('## 性能\n- 打开提速');
    expect(groups.map((g) => g.id)).toEqual(['other']);
    expect(groups[0]?.lines).toEqual(['性能', '- 打开提速']);
  });

  it('无说明 ⇒ 空数组（弹窗画那句人话，不是空分组）', () => {
    expect(groupUpdateNotes('   ')).toEqual([]);
  });

  it('检测严重度：任一命中红线词即 breaking；普通说明是 normal', () => {
    expect(detectUpdateSeverity('随手修了点东西')).toBe('normal');
    expect(detectUpdateSeverity('- Breaking Change: x')).toBe('breaking');
    expect(detectUpdateSeverity(undefined)).toBe('normal');
  });

  it('分组显示面共用 400 行上限：截显示、total 报全量', () => {
    const notes = ['## 新增', ...Array.from({ length: UPDATE_NOTE_LINE_LIMIT + 5 }, (_, i) => `- 第 ${i + 1} 行`)].join(
      '\n',
    );
    const view = visibleUpdateNoteGroups(notes);
    expect(view.truncated).toBe(true);
    expect(view.total).toBe(UPDATE_NOTE_LINE_LIMIT + 5);
    expect(view.groups.reduce((sum, g) => sum + g.lines.length, 0)).toBe(UPDATE_NOTE_LINE_LIMIT);
  });

  it('URL 切段：行中链接单独成段，中文标点不当 URL 的一部分；无 URL 原样一段', () => {
    const segs = linkifyUpdateNoteLine('详情 https://example.com/a_1，见上');
    expect(segs).toEqual([
      { text: '详情 ' },
      { text: 'https://example.com/a_1', url: 'https://example.com/a_1' },
      { text: '，见上' },
    ]);
    expect(linkifyUpdateNoteLine('没有链接')).toEqual([{ text: '没有链接' }]);
    // 只认 http(s)：file:// / javascript: 不切段
    expect(linkifyUpdateNoteLine('javascript:alert(1)')).toEqual([{ text: 'javascript:alert(1)' }]);
  });
});
