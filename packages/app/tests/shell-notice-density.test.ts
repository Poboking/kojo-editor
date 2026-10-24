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
