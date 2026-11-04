/**
 * MCP 会话授权：写前 diff 预览 + 一次批量审批（路 C）。
 *
 * 面板只产出 `ApprovalBatch`（交给 `mcp_approve` 命令写第四张表），**不碰任何落点**：
 * 越界根 / `market_*` 工具在纯函数里就地剔除，UI 不持有写盘权限。
 * 「回滚语义」说明：本面板复用 `TrashManager` / `OpsJournal` 的既有回滚语义是跨包接线，
 * 由主 agent 集成时决定（见交付报告偏差项）；此处不假装已接。
 */
import { useMemo, useState } from 'react';

import { KitCheck } from '../ui-kit/kit-check';

export type McpTier = 'read' | 'edit' | 'privileged';

/** 与 Rust `mcp/protocol.rs` 的危险工具判据镜像（双保险的展示侧）。 */
export const PRIVILEGED_TOOL_PREFIXES: readonly string[] = ['launcher_', 'market_', 'remove_'];
export const PRIVILEGED_TOOL_NAMES: readonly string[] = [
  'open_url_external',
  'export_file',
  'rename_path',
];

export function classifyToolTier(name: string): McpTier {
  if (
    PRIVILEGED_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    PRIVILEGED_TOOL_NAMES.includes(name)
  ) {
    return 'privileged';
  }
  if (/^(write_|save_|apply_|update_|set_|create_|delete_|patch_)/.test(name)) return 'edit';
  return 'read';
}

/** 项目内相对路径判据（与 Rust `validate_relative_path` 镜像，UI 先挡一道）。 */
export function isSafeRelativePath(raw: string): boolean {
  if (!raw || raw.length > 512) return false;
  if (/[\x00-\x1f]/.test(raw)) return false;
  if (/^[/\\~]/.test(raw)) return false;
  if (raw.includes(':')) return false;
  for (const comp of raw.replace(/\\/g, '/').split('/')) {
    if (!comp || comp === '.' || comp === '..' || comp.endsWith('.') || comp.endsWith(' ')) {
      return false;
    }
  }
  return true;
}

export interface ApprovalItem {
  name: string;
  tier: McpTier;
  reason: string;
}

export interface ApprovalBatch {
  clientId: string;
  tier: McpTier;
  approvedRoots: string[];
  approvedTools: string[];
}

/** 一次批量审批：`market_*` 保持 fail-closed；越界根与畸形工具名一律剔除。 */
export function buildApprovalBatch(
  clientId: string,
  tier: McpTier,
  items: readonly ApprovalItem[],
  roots: readonly string[],
): ApprovalBatch {
  const approvedTools = items
    .map((item) => item.name)
    .filter((name) => !name.startsWith('market_'))
    .filter((name) => name.length <= 64 && /^[A-Za-z0-9_.-]+$/.test(name));
  return {
    clientId,
    tier,
    approvedRoots: roots.filter(isSafeRelativePath),
    approvedTools,
  };
}

/** 参数摘要：不落全文、去控制字符、限长（提示注入 defense）。 */
export function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args).slice(0, 32)) {
    const safeKey = key.replace(/[\x00-\x1f]/g, '_').slice(0, 64);
    if (typeof value === 'string') parts.push(`${safeKey}:str(${value.length})`);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      parts.push(`${safeKey}:${typeof value}`);
    } else parts.push(`${safeKey}:complex`);
  }
  return parts.join(',').slice(0, 1024);
}

export interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
}

/** 写前 diff 预览（按行位对比，不执行写、不产生落点）。 */
export function renderDiff(before: string, after: string, maxLines = 200): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const lines: DiffLine[] = [];
  const count = Math.max(a.length, b.length);
  for (let i = 0; i < count && lines.length < maxLines; i += 1) {
    const x = a[i] ?? '';
    const y = b[i] ?? '';
    if (x === y) lines.push({ kind: 'context', text: x });
    else {
      if (i < a.length) lines.push({ kind: 'remove', text: x });
      if (i < b.length) lines.push({ kind: 'add', text: y });
    }
  }
  return lines;
}

export interface ApprovalUiProps {
  clientId: string;
  pending: readonly ApprovalItem[];
  roots: readonly string[];
  before: string;
  after: string;
  onApprove: (batch: ApprovalBatch) => void;
}

export function ApprovalUi({
  clientId,
  pending,
  roots,
  before,
  after,
  onApprove,
}: ApprovalUiProps) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set<string>());
  const diff = useMemo(() => renderDiff(before, after), [before, after]);
  const toggle = (name: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(name);
    else next.delete(name);
    setSelected(next);
  };
  const chosen = pending.filter((item) => selected.has(item.name));
  const batch = buildApprovalBatch(clientId, 'edit', chosen, roots);
  return (
    <section aria-label="MCP 会话授权">
      <h3>写前 diff 预览</h3>
      <pre data-testid="mcp-diff">
        {diff.map((line, i) => (
          <div key={i} data-kind={line.kind}>
            {line.kind === 'context' ? '  ' : line.kind === 'add' ? '+ ' : '- '}
            {line.text}
          </div>
        ))}
      </pre>
      <h3>一次批量审批</h3>
      <ul>
        {pending.map((item) => (
          <li key={item.name}>
            <KitCheck
              checked={selected.has(item.name)}
              onChange={(checked) => toggle(item.name, checked)}
              label={`批准 ${item.name}`}
            >
              {item.name}（{item.tier}）— {item.reason}
            </KitCheck>
          </li>
        ))}
      </ul>
      <p>待批准根：{batch.approvedRoots.join(', ') || '（无）'}</p>
      <button type="button" disabled={chosen.length === 0} onClick={() => onApprove(batch)}>
        批准所选（{chosen.length}）
      </button>
    </section>
  );
}
