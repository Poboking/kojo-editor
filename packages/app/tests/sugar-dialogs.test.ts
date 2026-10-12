/**
 * 全站模态对话框的一致性守门（2026-10-12 UI 归一批）。
 *
 * 为什么用 `renderToString` 而不是只测纯函数：这两条房规本身就是**结构**约定，
 * 拆成纯函数反而要把 JSX 拆散。仓内此前没有渲染型测试（vitest 只收 `*.test.ts`，
 * 但 `resolve.extensions` 含 `.tsx`，从 `.ts` 里引组件是可行的——`file-tree.test.ts`
 * 已这么引过 TSX 里的纯函数）。
 *
 * 两条约定：
 * 1. **`primary` 恒排在按钮组最右**（三家既有模态如此，糖视图那版初版反了）；
 * 2. 模态卡片必须带 `role="dialog" aria-modal="true"` 与 `aria-label`
 *    （读屏才能报出"这是对话框、标题是什么"；此前只有糖组那两个带）。
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ErbUnlockDialog, SugarViewIntroDialog } from '../src/ui/SugarViewDialogs';
import { SaveWarningDialog } from '../src/ui/SaveWarningDialog';
import { UnsavedConfirmDialog } from '../src/ui/UnsavedConfirmDialog';
import { WritableApprovalDialog } from '../src/ui/WritableApprovalDialog';

/** 取按钮组里每个按钮的 `[样式类, 文案]`，按 DOM 顺序（= 视觉左→右） */
function buttons(html: string): { kind: string; label: string }[] {
  return [...html.matchAll(/<button class="([^"]*)"[^>]*>(.*?)<\/button>/gs)].map((m) => ({
    kind: m[1]!,
    label: m[2]!.replace(/<[^>]*>/g, '').trim(),
  }));
}

const noop = () => {};

const cases: { name: string; html: string }[] = [
  {
    name: '语法糖视图首次引导',
    html: renderToString(createElement(SugarViewIntroDialog, { onDecide: noop })),
  },
  {
    name: 'ERB 解锁确认',
    html: renderToString(
      createElement(ErbUnlockDialog, { fileName: 'A_一般.erb', onDecide: noop }),
    ),
  },
  {
    name: '保存提醒',
    html: renderToString(
      createElement(SaveWarningDialog, {
        warning: { kind: 'fullwidth-space', message: '含全角空格', lines: [3, 17] },
        onDecide: noop,
      }),
    ),
  },
  {
    name: '未保存切换',
    html: renderToString(
      createElement(UnsavedConfirmDialog, {
        filePath: 'A_一般.kojo',
        context: 'switch',
        onDecide: noop,
      }),
    ),
  },
  {
    name: '写权限确认',
    html: renderToString(
      createElement(WritableApprovalDialog, {
        // 对话框只读 `adapterId` 与 `writablePaths`，其余字段与本题无关，不给全量假件
        project: { adapterId: 'eratw', writablePaths: ['C:/game/kojo'] } as never,
        onDecide: noop,
      }),
    ),
  },
];

describe('全站模态对话框', () => {
  for (const { name, html } of cases) {
    it(`${name}：卡片带 dialog 语义`, () => {
      expect(html).toContain('role="dialog"');
      expect(html).toContain('aria-modal="true"');
      expect(html).toMatch(/<div class="modal" role="dialog" aria-modal="true" aria-label="[^"]+"/);
    });

    it(`${name}：primary 按钮排在最右`, () => {
      const bs = buttons(html);
      expect(bs.length).toBeGreaterThan(0);
      expect(bs.filter((b) => b.kind === 'primary')).toHaveLength(1);
      expect(bs[bs.length - 1]!.kind).toBe('primary');
    });
  }

  it('ERB 解锁确认：推荐项（保持只读）才是 primary', () => {
    const bs = buttons(
      renderToString(createElement(ErbUnlockDialog, { fileName: 'A_一般.erb', onDecide: noop })),
    );
    // 初版把高风险的"允许编辑"放上 primary，视觉重量与文字推荐互相打架。
    expect(bs.find((b) => b.kind === 'primary')!.label).toBe('保持只读');
    expect(bs.find((b) => b.kind === 'ghost')!.label).toBe('仍要直接编辑');
  });

  it('面向作者的对话框不含实现术语（用户反馈 5）', () => {
    const all = cases.map((c) => c.html).join('\n');
    for (const jargon of ['EraBasic', '已映射', '升糖不写原文件', 'round-trip', 'ViewZone']) {
      expect(all).not.toContain(jargon);
    }
  });

  it('解锁对话框把文件名原样呈现（作者靠它对号）', () => {
    const html = renderToString(
      createElement(ErbUnlockDialog, { fileName: 'A_一般.erb', onDecide: vi.fn() }),
    );
    expect(html).toContain('<code>A_一般.erb</code>');
  });
});
