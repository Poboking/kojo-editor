/**
 * MCP 审计面板（路 C）：把宿主侧 `mcp_audit.jsonl` 的条目可见化。
 *
 * 审计记录由 Rust 宿主独占追加，MCP 客户端没有写入口（面板只经 `mcp_audit_query`
 * 读，不改不删）；`argsDigest` 只含键名/类型/长度，工具描述与文件内容不落全文。
 */
import { useMemo, useState } from 'react';

export type AuditOutcome = 'ok' | 'error' | 'filtered' | 'denied' | 'timeout' | 'cancelled';

export interface AuditEntryView {
  ts: string;
  clientId: string;
  tool: string;
  argsDigest: string;
  outcome: AuditOutcome;
  landedPath?: string;
  note?: string;
}

export function formatAuditEntry(entry: AuditEntryView): string {
  const base = `${entry.ts} ${entry.clientId} ${entry.tool} [${entry.outcome}] ${entry.argsDigest}`;
  const landed = entry.landedPath ? ` → ${entry.landedPath}` : '';
  const note = entry.note ? `（${entry.note}）` : '';
  return `${base}${landed}${note}`;
}

export function filterAuditEntries(
  entries: readonly AuditEntryView[],
  outcome: AuditOutcome | 'all',
  clientId: string,
  limit: number,
): AuditEntryView[] {
  const cap = Math.max(1, Math.min(200, limit));
  return entries
    .filter(
      (entry) =>
        (outcome === 'all' || entry.outcome === outcome) &&
        (!clientId || entry.clientId === clientId),
    )
    .slice(-cap);
}

export interface AuditPanelProps {
  entries: readonly AuditEntryView[];
}

export function AuditPanel({ entries }: AuditPanelProps) {
  const [outcome, setOutcome] = useState<AuditOutcome | 'all'>('all');
  const [clientId, setClientId] = useState('');
  const rows = useMemo(
    () => filterAuditEntries(entries, outcome, clientId, 200),
    [entries, outcome, clientId],
  );
  return (
    <section aria-label="MCP 审计">
      <label>
        结果
        <select
          value={outcome}
          onChange={(e) => setOutcome(e.currentTarget.value as AuditOutcome | 'all')}
        >
          <option value="all">全部</option>
          <option value="ok">ok</option>
          <option value="error">error</option>
          <option value="filtered">filtered</option>
          <option value="denied">denied</option>
          <option value="timeout">timeout</option>
          <option value="cancelled">cancelled</option>
        </select>
      </label>
      <label>
        客户端
        <input value={clientId} onChange={(e) => setClientId(e.currentTarget.value)} />
      </label>
      <ul data-testid="mcp-audit-rows">
        {rows.map((row, i) => (
          <li key={`${row.ts}-${row.tool}-${i}`}>{formatAuditEntry(row)}</li>
        ))}
      </ul>
    </section>
  );
}
