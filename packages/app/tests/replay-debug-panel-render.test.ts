/**
 * 注入预演面板的渲染钉（2026-11-02 美化批；静态串，默认 node 环境）。
 *
 * 为什么单独钉这一层：`DebugPreviewPanel` 是从面板壳层 `index.ts` 抽出来的纯呈现
 * （状态与回调全由壳层持有），抽出来就是为了能在这里按 DOM 串验收——壳层那条路
 * 要"打开真面板 + 恰好有存档 + 恰好点过预演"才看得到，等于没有判据。
 *
 * 钉的是**口径**不是像素：谁主谁危（预演 primary / 写入 danger）、二次确认的措辞
 * 怎么换、零差异该说什么、没预演过时结果区不许出现空盒子。
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuickEditField, TranscriptLine } from '@kojo/plugin-api';
import { DebugPreviewPanel } from '../../plugins/ui-state-replay/src/preview';
import type { ReplayDiff } from '../../plugins/ui-state-replay/src/panel-logic';

const FIELDS: QuickEditField[] = [
  { id: 'CFLAG:70', label: '好感度', family: 'CFLAG', index: 70, scope: 'chara' },
  { id: 'GLOBAL:12', label: '回合数', family: 'GLOBAL', index: 12, scope: 'global' },
];

function tl(line: number, text: string): TranscriptLine {
  return { line, verb: 'PRINTFORML', visibility: 'shown', payload: text, text, unresolved: 0 };
}

function diffOf(added: number, removed: number): ReplayDiff {
  return {
    added: Array.from({ length: added }, (_, i) => tl(100 + i, `新出现的第 ${i} 句`)),
    removed: Array.from({ length: removed }, (_, i) => tl(200 + i, `不再说的第 ${i} 句`)),
    settled: 0,
    flippedPredicates: 0,
    flippedBranches: 0,
  };
}

type Props = Parameters<typeof DebugPreviewPanel>[0];

function props(patch: Partial<Props> = {}): Props {
  return {
    quickFields: FIELDS,
    fieldId: 'CFLAG:70',
    value: '500',
    busy: false,
    canRun: true,
    canWrite: true,
    error: null,
    diff: null,
    diffSummary: null,
    writeArmed: false,
    writeNote: null,
    onFieldChange: () => undefined,
    onValueChange: () => undefined,
    onPreview: () => undefined,
    onWriteClick: () => undefined,
    ...patch,
  };
}

function render(patch: Partial<Props> = {}): string {
  return renderToStaticMarkup(DebugPreviewPanel(props(patch)) as never);
}

/** 取某个 class 的按钮的开标签（便于断言 disabled 与文案） */
function buttonWith(html: string, cls: string): string {
  const m = html.match(new RegExp(`<button class="${cls}"[^>]*>[^<]*</button>`));
  return m ? m[0] : '';
}

describe('注入预演面板 · 表单', () => {
  it('三件都在：选数值的下拉 / 值输入 / 预演按钮', () => {
    const html = render();
    expect(html).toContain('rp-debug-form');
    expect(html).toContain('挑一个要改的数值');
    expect(html).toContain('预演');
  });

  it('下拉选项带 family:index，全局量额外标「全局」', () => {
    const html = render();
    expect(html).toContain('好感度（CFLAG:70）');
    expect(html).toContain('回合数（GLOBAL:12 · 全局）');
  });

  it('没挑数值 / 没存档时预演按钮是禁用的', () => {
    expect(buttonWith(render({ canRun: false }), 'primary small')).toContain('disabled');
    expect(buttonWith(render(), 'primary small')).not.toContain('disabled');
  });

  it('推演中按钮改口「推演中…」并锁住', () => {
    const btn = buttonWith(render({ busy: true }), 'primary small');
    expect(btn).toContain('推演中…');
    expect(btn).toContain('disabled');
  });
});

describe('注入预演面板 · 权重（谁主谁危）', () => {
  it('预演是主按钮（primary），写入是危险动作（danger）——两枚不同档', () => {
    const html = render();
    expect(buttonWith(html, 'primary small')).toContain('预演');
    expect(buttonWith(html, 'small danger')).toContain('写入存档');
  });

  it('写入值没填时写入钮禁用（不让空值落盘）', () => {
    expect(buttonWith(render({ canWrite: false }), 'small danger')).toContain('disabled');
  });

  it('二次确认：文案换「确认写入」并升成 armed 档 + 明说再点一次就落盘', () => {
    const html = render({ writeArmed: true });
    expect(buttonWith(html, 'small danger armed')).toContain('确认写入');
    expect(html).toContain('再点一次');
    expect(html).toContain('落盘');
  });

  it('未武装时给的是"会改存档、先备份"的前置提醒', () => {
    const html = render();
    expect(html).toContain('写入会改存档文件');
    expect(html).not.toContain('再点一次');
  });
});

describe('注入预演面板 · 结果区', () => {
  it('没预演过（diff 为 null）⇒ 结果区整块不出现，不留空盒子', () => {
    const html = render();
    expect(html).not.toContain('rp-debug-result');
    expect(html).not.toContain('这次改动');
  });

  it('有 diff：结论一句话 + 增删逐行（增绿删红，删除行只划正文）', () => {
    const html = render({ diff: diffOf(2, 1), diffSummary: '3 句变得会说、1 句不说了' });
    expect(html).toContain('这次改动：3 句变得会说、1 句不说了。');
    expect(html).toContain('rp-diff-row add');
    expect(html).toContain('rp-diff-row remove');
    expect(html).toContain('rp-diff-text');
    expect(html).toContain('新出现的第 0 句');
    expect(html).toContain('不再说的第 0 句');
  });

  it('零差异（diff 在、summary 为 null）⇒ 说"没有影响"，并降成灰注脚', () => {
    const html = render({ diff: diffOf(0, 0), diffSummary: null });
    expect(html).toContain('这次改动对这一段没有影响。');
    expect(html).toContain('rp-diff-summary quiet');
  });

  it('超过 12 行只列 12 行，剩下给"还有 N 行没列出"', () => {
    const html = render({ diff: diffOf(20, 0), diffSummary: '很多' });
    expect((html.match(/rp-diff-row add/g) ?? []).length).toBe(12);
    expect(html).toContain('还有 8 行没列出');
  });

  it('错误与写入回执都上屏', () => {
    const html = render({ error: '存档里没有「好感度」这个变量', writeNote: '已写入（原文件备份为 a.sav.bak）' });
    expect(html).toContain('存档里没有「好感度」这个变量');
    expect(html).toContain('原文件备份为 a.sav.bak');
  });
});
