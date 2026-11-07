/**
 * MCP 审计面板（路 C）：把宿主侧 `mcp_audit.jsonl` 的条目可见化。
 *
 * 审计记录由 Rust 宿主独占追加，MCP 客户端没有写入口（面板只经 `mcp_audit_query`
 * 读，不改不删）；`argsDigest` 只含键名/类型/长度，工具描述与文件内容不落全文。
 *
 * 列式行与空态分场景（additive，2026-11-06 UI-04/18/29）：
 *   · 每行改结构化 span（时间 / 工具 / 结果 / 耗时 / 落点），样式走 settings-ai.css 的
 *     `.mcp-audit-row*`；`argsDigest` / `sessionId` / `clientId` / `note` / 完整 ISO 时间
 *     收进 `title` 悬浮——88px 时间列放短格式（UI 实拍：完整 ISO 必折行）、第五列只放
 *     `landedPath`（无落点显 `—`），note 不再占列宽折行；
 *   · 结果列保留 `[denied]` 方括号字面量——mcp-approval-ui 回归钉住行文本，色彩
 *     chip 化由 `data-outcome` + CSS 完成，字面不动；
 *   · 空态分两种：一条都没有（还没接入）vs 有条目但筛空了（给「清空筛选」退路）；
 *   · 客户端过滤框换 `KitSearchField`（UI-04：暗色下不再出现裸白 input）。
 */
import { useMemo, useState } from 'react';

import { KitEmpty } from '../ui-kit';
import { KitSearchField } from '../ui-kit/kit-search-field';
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

/**
 * 审计时间列短格式 `MM-DD HH:mm:ss`（如 `11-06 23:41:09`，88px 列宽正好放下）。
 * 只做**字面裁切**（宿主 `mcp_audit.jsonl` 的 ISO 串原样摘月日与时分秒），
 * 不做时区换算——换算会让屏面时间与审计文件对不上，宁短不编。
 * 非 ISO 形态（旧条目 / 脏数据）原样返回，不静默吞。
 */
export function formatAuditTime(ts: string): string {
  const match = /^(\d{4})-(\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(ts);
  if (match === null) return ts;
  return `${match[2]} ${match[3]}`;
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
  const filtered = rows.length === 0 && entries.length > 0;
  const resetFilters = () => {
    setOutcome('all');
    setClientId('');
  };
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
            <KitSearchField
              value={clientId}
              onChange={setClientId}
              ariaLabel="按 clientId 过滤审计条目"
              placeholder="按 clientId 过滤"
            />
          </label>
        </div>
      </div>
      {rows.length === 0 ? (
        filtered ? (
          <KitEmpty
            variant="inline"
            announce
            title="没有匹配当前筛选的条目"
            action={{ label: '清空筛选', onClick: resetFilters }}
          />
        ) : (
          <KitEmpty
            variant="inline"
            announce
            title="还没有审计条目"
            hint="客户端首次 tools/call 后会出现。"
          />
        )
      ) : (
        <ul className="settings-mcp-audit-rows" data-testid="mcp-audit-rows">
          {rows.map((row, i) => (
            <li
              key={`${row.ts}-${row.tool}-${i}`}
              data-outcome={row.outcome}
              className="mcp-audit-row"
              title={[row.ts, row.clientId, row.argsDigest, row.sessionId, row.note]
                .filter(Boolean)
                .join(' · ')}
            >
              {/* 五列 span 全量渲染（缺项显 —）：grid 按子元素序落列，条件渲染会把
                  后面的列挤进前面的列宽（elapsed 缺席时落点会掉进 56px 耗时列）。 */}
              <span className="mcp-audit-row-time" title={row.ts}>{formatAuditTime(row.ts)}</span>
              <span className="mcp-audit-row-tool">{row.tool}</span>
              <span className="mcp-audit-row-outcome">[{row.outcome}]</span>
              <span className="mcp-audit-row-elapsed">
                {row.elapsedMs !== undefined ? `${row.elapsedMs}ms` : '—'}
              </span>
              <span className="mcp-audit-row-path">
                {row.landedPath !== undefined ? `→ ${row.landedPath}` : '—'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
