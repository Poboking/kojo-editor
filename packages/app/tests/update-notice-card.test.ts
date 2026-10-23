/**
 * 更新提醒卡（层一）与其纯判据的单测（批次十一 L05）。
 *
 * 环境是 node + `renderToStaticMarkup`（与 `update-dialog.test.ts` 同款）：只钉
 * 「这一次打扰不打扰、以哪层打扰」的判据与卡的静态可读性。hook 的会话编排
 * （dialogOpen / 免打扰落盘）走真壳冒烟，不在这假装跑 effect。
 */
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
    expect(d.notice?.version).toBe('0.4.3');
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
    expect(expired.notice?.version).toBe('0.4.3');
    // 免打扰只对同版本：作者稍后再说 0.4.3，不妨碍提醒 0.5.0
    const other = decideUpdateNotice(found({ version: '0.5.0' }), {
      dismissal: { version: '0.4.3', dismissedAt },
    });
    expect(other.notice?.version).toBe('0.5.0');
  });

  it('非 found 态（checking/latest/failed/downloading/done）连卡都不该有判据', () => {
    for (const phase of [
      { kind: 'idle' },
      { kind: 'checking' },
      { kind: 'latest' },
      { kind: 'failed', stage: 'check' },
    ] satisfies readonly UpdatePhase[]) {
      expect(decideUpdateNotice(phase, { dismissal: null }).notice).toBeNull();
    }
  });
});

describe('UpdateNoticeCard 渲染面', () => {
  const state: UpdateNoticeState = {
    kind: 'found',
    version: '0.4.3',
    currentVersion: '0.4.2',
    date: new Date(2026, 9, 17, 12, 0, 0).toISOString(),
  };

  it('标题 + 版本徽标 + 查看/稍后 齐备；role=status 非阻塞（不是 dialog）', () => {
    const out = renderToStaticMarkup(createElement(UpdateNoticeCard, { state, onOpen: noop, onDismiss: noop }));
    expect(out).toContain('发现新版本 v0.4.3');
    expect(out).toContain('class="update-notice-card-badge">v0.4.3<');
    expect(out).toContain('>查看<');
    expect(out).toContain('>稍后<');
    expect(out).toContain('role="status"');
    expect(out).not.toContain('aria-modal');
    expect(out).toContain('当前 v0.4.2');
    expect(out).toContain('发布于 2026-10-17');
  });

  it('state=null ⇒ 整个组件零节点（不留隐形占位）', () => {
    expect(renderToStaticMarkup(createElement(UpdateNoticeCard, { state: null, onOpen: noop, onDismiss: noop }))).toBe('');
  });

  it('缺 currentVersion / date ⇒ 元信息行整行不画（不出现 "vundefined" 机器味）', () => {
    const out = renderToStaticMarkup(
      createElement(UpdateNoticeCard, {
        state: { kind: 'found', version: '0.4.3' },
        onOpen: noop,
        onDismiss: noop,
      }),
    );
    expect(out).not.toContain('update-notice-card-meta');
    expect(out).not.toContain('vundefined');
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
