/**
 * MCP 审计面板（路 C）：把宿主侧 `mcp_audit.jsonl` 的条目可见化。
 *
 * 审计记录由 Rust 宿主独占追加，MCP 客户端没有写入口（面板只经 `mcp_audit_query`
 * 读，不改不删）；`argsDigest` 只含键名/类型/长度，工具描述与文件内容不落全文。
 */
import { useMemo, useState } from 'react';

import { KitEmpty } from '../ui-kit';
import { KitSelect, type KitSelectOption } from '../ui-kit/kit-select';

export type AuditOutcome = 'ok' | 'error' | 'filtered' | 'denied' | 'timeout' | 'cancelled';

export interface AuditEntryView {
  ts: string;
  clientId: string;
  tool: string;
  argsDigest: string;
  outcome: AuditOutcome;
  landedPath?: string;
  note?: string;
  /** additive：宿主侧会话标签 / 实测耗时；旧审计行缺席时整格不写，格式逐字不变。 */
  sessionId?: string;
  elapsedMs?: number;
}

export function formatAuditEntry(entry: AuditEntryView): string {
  const base = `${entry.ts} ${entry.clientId} ${entry.tool} [${entry.outcome}] ${entry.argsDigest}`;
  const session = entry.sessionId ? ` <${entry.sessionId}>` : '';
  const elapsed = entry.elapsedMs !== undefined ? ` ${entry.elapsedMs}ms` : '';
  const landed = entry.landedPath ? ` → ${entry.landedPath}` : '';
  const note = entry.note ? `（${entry.note}）` : '';
  return `${base}${session}${elapsed}${landed}${note}`;
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

const OUTCOME_OPTIONS: readonly KitSelectOption[] = [
  { value: 'all', label: '全部' },
  { value: 'ok', label: 'ok' },
  { value: 'error', label: 'error' },
  { value: 'filtered', label: 'filtered' },
  { value: 'denied', label: 'denied' },
  { value: 'timeout', label: 'timeout' },
  { value: 'cancelled', label: 'cancelled' },
];

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
    <section className="settings-mcp-card settings-mcp-audit" aria-label="MCP 审计">
      <div className="settings-mcp-audit-head">
        <h3>调用审计</h3>
        <div className="settings-mcp-audit-filters">
          <label>
            结果
            <KitSelect
              value={outcome}
              onChange={(value) => setOutcome(value as AuditOutcome | 'all')}
              options={OUTCOME_OPTIONS}
              ariaLabel="按结果过滤审计条目"
            />
          </label>
          <label>
            客户端
            <input value={clientId} onChange={(e) => setClientId(e.currentTarget.value)} />
          </label>
        </div>
      </div>
      {rows.length === 0 ? (
        <KitEmpty
          variant="inline"
          title="暂无审计条目"
          hint="客户端首次 tools/call 之后这里会出现逐笔回执（含 sessionId 与实测耗时）。"
        />
      ) : (
        <ul className="settings-mcp-audit-rows" data-testid="mcp-audit-rows">
          {rows.map((row, i) => (
            <li key={`${row.ts}-${row.tool}-${i}`} data-outcome={row.outcome}>
              {formatAuditEntry(row)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
