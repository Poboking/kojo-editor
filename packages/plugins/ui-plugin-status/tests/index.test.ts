import { describe, expect, it } from 'vitest';
import type { OpsMaintenanceRead } from '../src/maintenance';
import { opsMaintenanceRow, pluginErrorNode, pluginErrorText } from '../src/index';

/**
 * 呈现层钉死（审阅整改：普通作者可读性）：
 * ① 维护记录行 = 中文人话 + 默认折叠的"详情"体 + title 全文；
 * ② 错误行 = 截断的 summary 必须带 `title`（完整错误文本），且详情体可展开全文。
 * 组件用 createElement 编写 ⇒ 这里直接检视返回的 React 元素树，无需 DOM。
 */

interface ElLike {
  type: unknown;
  props: { className?: string; title?: string; children?: unknown };
}

/** 深度遍历元素树（children 可能是数组 / 字符串 / 元素） */
function collect(node: unknown, out: ElLike[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out);
    return;
  }
  if (node && typeof node === 'object' && 'type' in node && 'props' in node) {
    const el = node as ElLike;
    out.push(el);
    collect(el.props.children, out);
  }
}

function tree(root: unknown): ElLike[] {
  const out: ElLike[] = [];
  collect(root, out);
  return out;
}

/** 取出元素子树的纯文本（children 可能是字符串 / 数组 / 元素） */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as ElLike).props.children);
  return '';
}

function findByClass(root: unknown, cls: string): ElLike | undefined {
  return tree(root).find((e) => (e.props.className ?? '').split(' ').includes(cls));
}

describe('opsMaintenanceRow · 本地化 + 折叠详情', () => {
  const known: OpsMaintenanceRead = { known: true, total: 3, detail: 'open 残留 1 · 巡检于 2026-10-17' };

  it('根节点是 details（默认折叠），title 挂明细全文', () => {
    const row = opsMaintenanceRow(known);
    const root = tree(row)[0]!;
    expect(root.type).toBe('details');
    expect(root.props.title).toBe(known.detail);
    expect(root.props.className).toContain('panel-ops-maintenance-residue');
  });

  it('summary 只说中文人话，内部术语 ops journal 不露面', () => {
    const els = tree(opsMaintenanceRow(known));
    const s = els.find((e) => e.type === 'summary');
    expect(textOf(s)).toContain('维护记录：3 条');
    expect(textOf(s)).not.toMatch(/ops journal/i);
  });

  it('读数未回（null）也整行在场：未知 + 原因写进 summary 与详情体', () => {
    const root = tree(opsMaintenanceRow(null))[0]!;
    expect(root.type).toBe('details');
    expect(root.props.className).toContain('panel-ops-maintenance-unknown');
    const s = tree(opsMaintenanceRow(null)).find((e) => e.type === 'summary');
    expect(textOf(s)).toContain('维护记录：未知');
    expect(textOf(root)).toContain('巡检尚未完成');
  });
});

describe('pluginErrorNode · 截断行 title 复原全文', () => {
  const long = 'activate 失败：service "x" not found\nat kernel/runtime.ts:42:7\n（第二行同样长的错误上下文）';

  it('summary 保留 plugin-error 省略号样式类，且 title = 完整错误文本', () => {
    const node = pluginErrorNode(long);
    const summary = findByClass(node, 'plugin-error');
    expect(summary?.type).toBe('summary');
    expect(summary?.props.title).toBe(long);
  });

  it('详情体可展开读出完整错误（不依赖 hover）', () => {
    const node = pluginErrorNode(long);
    expect(node.type).toBe('details');
    const full = findByClass(node, 'plugin-error-full');
    expect(textOf(full)).toBe(long);
  });

  it('error 缺席 / 空串时给出占位全文，title 恒非空', () => {
    expect(pluginErrorText(undefined)).toBe('（内核未给出错误详情）');
    expect(pluginErrorText('')).toBe('（内核未给出错误详情）');
    const node = pluginErrorNode(undefined);
    expect(findByClass(node, 'plugin-error')?.props.title).toBe('（内核未给出错误详情）');
  });
});
