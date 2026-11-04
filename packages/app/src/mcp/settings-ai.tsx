/**
 * 设置页「AI 接入」（P0 契约 · 路 A，ADR-0013）。
 *
 * 独立组件：调 Rust 命令 `mcp_start` / `mcp_stop` / `mcp_status`，把 MCP 服务的
 * 开关、token、已连接客户端、状态做成**可见**的面板。本文件还导出 `AiAccessSection`
 * —— 设置页「AI 接入」节的整节编排（挂 SettingsAi + ApprovalUi + AuditPanel，读数 /
 * 审批 / 撤销 / 审计全接 Rust 既有命令），由 `SettingsPanel.tsx` 动态判断桌面壳后挂载。
 *
 * 铁律 4「不静默」：**三态必须可见**——「未启动」（stopped）/「未授权」（unauthorized）/
 * 「连接失败」（error），外加「运行中 / 处理中」。任何一次 invoke 失败都把原错误显示出来，
 * 不吞、不假装成功。`mcp_status` 只回 `clients: number`（契约 v1 没有逐客户端明细），
 * 因此逐客户端列表由可选 `clients` prop 注入（来自第四张授权表，路 C）；未注入时如实
 * 显示计数 + 一句「明细由授权表提供」，不编造列表。
 *
 * token 只在 `mcp_start` 的返回值里出现（状态命令不回传明文）。轮换＝再调一次
 * `mcp_start(true)` 让 Rust 铸一枚新 token（路径由路 C 实现）；轮换会使已授权客户端
 * 失效，界面显式提示，不静默换掉。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { invoke } from '../bridge/invoke';
import {
  ApprovalUi,
  PRIVILEGED_TOOL_NAMES,
  type ApprovalBatch,
  type ApprovalItem,
} from './approval-ui';
import { AuditPanel, type AuditEntryView } from './audit-panel';

export type McpClientTier = 'read' | 'edit' | 'privileged';

/** 逐客户端明细（来自第四张授权表 `mcp_approvals.json`，由集成层注入）。 */
export interface McpClientInfo {
  readonly clientId: string;
  readonly tier?: McpClientTier;
  readonly connected?: boolean;
}

export interface SettingsAiProps {
  /** 可选的逐客户端列表；不给时只显示 `mcp_status().clients` 计数。 */
  readonly clients?: readonly McpClientInfo[];
  /** 状态轮询间隔（毫秒），0 = 关闭轮询；默认 4000。 */
  readonly pollMs?: number;
}

interface McpStartResult {
  readonly port: number;
  readonly token: string;
  readonly endpoint: string;
}

interface McpStatus {
  readonly enabled: boolean;
  readonly port: number | null;
  readonly clients: number;
}

type Phase = 'loading' | 'stopped' | 'running' | 'unauthorized' | 'error' | 'busy';

const PHASE_LABEL: Readonly<Record<Phase, string>> = {
  loading: '正在读取状态…',
  stopped: '未启动',
  running: '运行中',
  unauthorized: '未授权',
  error: '连接失败',
  busy: '处理中…',
};

const POLL_DEFAULT_MS = 4000;

function maskToken(token: string): string {
  if (token.length <= 8) return '••••••••';
  return `${token.slice(0, 4)}••••••••${token.slice(-4)}`;
}

export function SettingsAi({ clients, pollMs = POLL_DEFAULT_MS }: SettingsAiProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [detail, setDetail] = useState<string>('');
  const [rotateArmed, setRotateArmed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const classify = useCallback((s: McpStatus): Phase => {
    if (!s.enabled) return 'stopped';
    // 已启动但一个已授权客户端都没有 ⇒ 未授权（等待第四张表批准），不是"运行中"
    return s.clients > 0 ? 'running' : 'unauthorized';
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const s = await invoke<McpStatus>('mcp_status');
      if (!mounted.current) return;
      setStatus(s);
      setPhase(classify(s));
      setDetail(
        s.enabled
          ? `端口 ${s.port ?? '—'} · 已连接客户端 ${s.clients}`
          : 'MCP 服务未启动。开启后编辑器会写入 mcp-endpoint.json 供 stdio shim 发现。',
      );
    } catch (err) {
      if (!mounted.current) return;
      setPhase('error'); // 连接失败：显式可见，不静默
      setDetail(`读取 mcp_status 失败：${String(err)}`);
    }
  }, [classify]);

  useEffect(() => {
    void refresh();
    if (pollMs <= 0) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  const fail = useCallback((what: string, err: unknown): void => {
    if (!mounted.current) return;
    setPhase('error');
    setDetail(`${what}失败：${String(err)}`);
  }, []);

  const start = useCallback(async (): Promise<void> => {
    setPhase('busy');
    try {
      const r = await invoke<McpStartResult>('mcp_start', { enabled: true });
      if (!mounted.current) return;
      setToken(r.token);
      setShowToken(false);
      await refresh();
    } catch (err) {
      fail('开启 MCP 服务', err);
    }
  }, [refresh, fail]);

  const stop = useCallback(async (): Promise<void> => {
    setPhase('busy');
    try {
      await invoke<void>('mcp_stop');
      if (!mounted.current) return;
      setToken(null);
      setShowToken(false);
      await refresh();
    } catch (err) {
      fail('关闭 MCP 服务', err);
    }
  }, [refresh, fail]);

  const rotate = useCallback(async (): Promise<void> => {
    setRotateArmed(false);
    setPhase('busy');
    try {
      // 轮换＝再要一枚新 token；Rust mcp_start 每次铸新 token（路 C）
      const r = await invoke<McpStartResult>('mcp_start', { enabled: true });
      if (!mounted.current) return;
      setToken(r.token);
      setShowToken(false);
      await refresh();
      if (mounted.current) setDetail('token 已轮换：已授权客户端需重新授权后重连。');
    } catch (err) {
      fail('轮换 token', err);
    }
  }, [refresh, fail]);

  const enabled = status?.enabled ?? false;
  const clientCount = status?.clients ?? 0;
  const hasDetailedClients = clients !== undefined && clients.length > 0;

  return (
    <section className="settings-ai" aria-label="AI 接入">
      <h2>AI 接入（MCP Server）</h2>
      <p className="settings-ai-hint">
        把编辑器能力开放给 Codex / DeepSeek Harness 等外部 AI。服务仅监听回环，
        需 Bearer token 与逐会话授权；危险工具逐项批准。
      </p>

      {/* 状态：三态 + 运行中/处理中，一律可见 */}
      <div className={`settings-ai-status settings-ai-status--${phase}`} role="status">
        <span className="settings-ai-status-label">状态：{PHASE_LABEL[phase]}</span>
        <span className="settings-ai-status-detail">{detail}</span>
      </div>

      <div className="settings-ai-row">
        <label className="settings-ai-toggle">
          <input
            type="checkbox"
            checked={enabled}
            disabled={phase === 'busy' || phase === 'loading'}
            onChange={(e) => void (e.target.checked ? start() : stop())}
          />
          <span>启用 MCP 服务</span>
        </label>
        <button type="button" onClick={() => void refresh()} disabled={phase === 'busy'}>
          刷新状态
        </button>
      </div>

      {/* token：显示 / 隐藏 / 轮换入口；无 token 时说明原因，不静默留空 */}
      <div className="settings-ai-row settings-ai-token">
        <span className="settings-ai-token-label">Token：</span>
        {token === null ? (
          <span className="settings-ai-token-empty">
            （未显示：开启或轮换 MCP 服务后由 mcp_start 返回；状态命令不回传明文）
          </span>
        ) : (
          <>
            <code>{showToken ? token : maskToken(token)}</code>
            <button type="button" onClick={() => setShowToken((v) => !v)}>
              {showToken ? '隐藏' : '显示'}
            </button>
          </>
        )}
        {token !== null && !rotateArmed && (
          <button type="button" onClick={() => setRotateArmed(true)} disabled={phase === 'busy'}>
            轮换
          </button>
        )}
        {rotateArmed && (
          <span className="settings-ai-rotate-confirm">
            轮换会使现有客户端失效，确认？
            <button type="button" onClick={() => void rotate()}>确认轮换</button>
            <button type="button" onClick={() => setRotateArmed(false)}>取消</button>
          </span>
        )}
        {token !== null && status?.port !== null && status?.port !== undefined && (
          <span className="settings-ai-endpoint">端点：http://127.0.0.1:{status.port}/mcp</span>
        )}
      </div>

      {/* 已连接客户端：契约只回计数；逐客户端明细由授权表注入（不编造） */}
      <div className="settings-ai-clients">
        <h3>已连接客户端（{hasDetailedClients ? clients!.length : clientCount}）</h3>
        {hasDetailedClients ? (
          <ul>
            {clients!.map((c) => (
              <li key={c.clientId}>
                <code>{c.clientId}</code>
                {c.tier !== undefined && <span> · tier {c.tier}</span>}
                {c.connected === false && <span> · 已断开</span>}
              </li>
            ))}
          </ul>
        ) : clientCount > 0 ? (
          <p>已连接 {clientCount} 个客户端；逐客户端明细由第四张授权表（路 C）提供。</p>
        ) : (
          <p>当前没有已连接客户端。</p>
        )}
      </div>
    </section>
  );
}

export default SettingsAi;

/* ------------------------------------------------------------------ *
 * 「AI 接入」整节编排（设置页「AI 接入」节的挂载点）
 *
 * 三块面板同节可见：SettingsAi（开关 / token / 三态）、ApprovalUi（写前 diff + 批量审批）、
 * AuditPanel（审计条目）。数据一律走 Rust 侧既有命令（勿另起命令名）：
 *   mcp_scope_query → 逐客户端明细 / 待批准项 / 根 / clientId
 *   mcp_audit_query → 审计条目
 *   mcp_approve     → 提交审批（写第四张表 mcp_approvals.json）
 *   mcp_revoke      → 撤销会话
 * 三张既有写授权表互不继承；本面板只读写第四张表经上述命令暴露的读数，不碰其它落点。
 *
 * `McpCommandRunner` 是注入 seam：生产用 `invoke`，单测注入假实现即可验证「调用正确
 * 命令名 + args」而不真起 GUI / HTTP。所有失败都显式显示（铁律 4：不静默）。
 * ------------------------------------------------------------------ */

/** 可注入的命令执行器（生产 = Tauri `invoke`；单测 = 假实现）。 */
export type McpCommandRunner = (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/** Rust 侧命令名（单一真源；与 `mcp/mod.rs` 注册名逐字一致，勿在别处再抄字面量）。 */
export const MCP_SETTINGS_COMMANDS = {
  scopeQuery: 'mcp_scope_query',
  auditQuery: 'mcp_audit_query',
  approve: 'mcp_approve',
  revoke: 'mcp_revoke',
  status: 'mcp_status',
  start: 'mcp_start',
  stop: 'mcp_stop',
} as const;

/** Rust `mcp/scope.rs::McpScopeState`（serde camelCase 已保证字段名）。 */
export interface McpScopeState {
  readonly version: number;
  readonly sessions: readonly McpSessionGrant[];
}

/** Rust `mcp/scope.rs::SessionGrant`。 */
export interface McpSessionGrant {
  readonly clientId: string;
  readonly tier: McpClientTier;
  readonly approvedRoots: readonly string[];
  readonly approvedTools: readonly string[];
  readonly createdAt: string;
  readonly revokedAt?: string;
}

/** Rust `mcp/audit.rs::AuditEntry`（camelCase；outcome 是 lowercase 字符串）。 */
export interface McpAuditEntryRaw {
  readonly ts: string;
  readonly clientId: string;
  readonly sessionId?: string;
  readonly tool: string;
  readonly argsDigest: string;
  readonly outcome: AuditEntryView['outcome'];
  readonly landedPath?: string;
  readonly note?: string;
}

/** 仍有效的会话（撤销过的不算已连接；不编造）。 */
function activeSessions(state: McpScopeState | null): readonly McpSessionGrant[] {
  if (!state) return [];
  return (state.sessions ?? []).filter((s) => !s.revokedAt);
}

/** 第四张表 → `SettingsAi` 的逐客户端明细。 */
export function scopeStateToClients(state: McpScopeState | null): McpClientInfo[] {
  return activeSessions(state).map((s) => ({
    clientId: s.clientId,
    tier: s.tier,
    connected: true,
  }));
}

/** 第四张表 → `ApprovalUi` 的 (clientId, pending, roots)。 */
export function scopeStateToApproval(state: McpScopeState | null): {
  clientId: string;
  pending: ApprovalItem[];
  roots: string[];
} {
  const sessions = activeSessions(state);
  const clientId = sessions[0]?.clientId ?? '';
  // 可批准的特权工具来自安全判据真源（approval-ui 的 PRIVILEGED_TOOL_NAMES），
  // 不是伪造的「待批准请求」读数；勾选后由 mcp_approve 写入第四张表。
  const pending: ApprovalItem[] = PRIVILEGED_TOOL_NAMES.map((name) => ({
    name,
    tier: 'privileged',
    reason: '特权工具，默认不进 tools/list，需逐会话显式批准',
  }));
  const roots = [...new Set(sessions.flatMap((s) => s.approvedRoots ?? []))];
  return { clientId, pending, roots };
}

/** `ApprovalBatch` → `mcp_approve` 的 args（camelCase，对齐 Rust `ApproveArgs`）。 */
export function approveArgs(batch: ApprovalBatch): Record<string, unknown> {
  return {
    clientId: batch.clientId,
    tier: batch.tier,
    approvedRoots: batch.approvedRoots,
    approvedTools: batch.approvedTools,
  };
}

/** clientId → `mcp_revoke` 的 args（对齐 Rust `RevokeArgs`）。 */
export function revokeArgs(clientId: string): Record<string, unknown> {
  return { clientId };
}

/** Rust 审计条目 → `AuditPanel` 视图（字段逐字映射，不发明、不补空串）。 */
export function toAuditEntryView(raw: McpAuditEntryRaw): AuditEntryView {
  return {
    ts: raw.ts,
    clientId: raw.clientId,
    tool: raw.tool,
    argsDigest: raw.argsDigest,
    outcome: raw.outcome,
    ...(raw.landedPath !== undefined ? { landedPath: raw.landedPath } : {}),
    ...(raw.note !== undefined ? { note: raw.note } : {}),
  };
}

/* -------------------- 可注入动作（命令名集中，单测可 spy） -------------------- */

export async function queryMcpScope(run: McpCommandRunner): Promise<McpScopeState> {
  return (await run(MCP_SETTINGS_COMMANDS.scopeQuery)) as McpScopeState;
}

export async function queryMcpAudit(
  run: McpCommandRunner,
  opts: { clientId?: string; limit?: number } = {},
): Promise<AuditEntryView[]> {
  const args: Record<string, unknown> = { limit: opts.limit ?? 200 };
  if (opts.clientId) args.clientId = opts.clientId;
  const raw = await run(MCP_SETTINGS_COMMANDS.auditQuery, { args });
  return ((raw ?? []) as McpAuditEntryRaw[]).map(toAuditEntryView);
}

export async function approveMcpSession(
  run: McpCommandRunner,
  batch: ApprovalBatch,
): Promise<McpScopeState> {
  return (await run(MCP_SETTINGS_COMMANDS.approve, { args: approveArgs(batch) })) as McpScopeState;
}

export async function revokeMcpSession(
  run: McpCommandRunner,
  clientId: string,
): Promise<McpScopeState> {
  return (await run(MCP_SETTINGS_COMMANDS.revoke, { args: revokeArgs(clientId) })) as McpScopeState;
}

export interface AiAccessSectionProps {
  /** 命令执行器注入 seam；缺省用 `invoke`（生产 Tauri IPC）。 */
  readonly runner?: McpCommandRunner;
  /** `SettingsAi` 状态轮询间隔；0 = 关（本组件自己刷 scope/audit，故缺省 0）。 */
  readonly pollMs?: number;
}

/**
 * 「AI 接入」整节：把三块面板挂在一起并把读数 / 提交接到 Rust 既有命令。
 * 不吞错、不假装成功、不编造读数（铁律 4）；接不到读数时面板显示显式失败文案。
 */
export function AiAccessSection({ runner, pollMs = 0 }: AiAccessSectionProps): ReactElement {
  // runner 每次渲染可能是新引用 ⇒ 收进 ref，再包一层恒定的 `run`，避免 refresh 的
  // useCallback 依赖抖动导致 useEffect 反复刷新（铁律：不静默地刷爆 IPC）。
  const runnerRef = useRef<McpCommandRunner | undefined>(runner);
  runnerRef.current = runner;
  const run = useCallback<McpCommandRunner>(
    (cmd, args) => (runnerRef.current ? runnerRef.current(cmd, args) : invoke(cmd, args)),
    [],
  );

  const [scope, setScope] = useState<McpScopeState | null>(null);
  const [audit, setAudit] = useState<readonly AuditEntryView[]>([]);
  const [note, setNote] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [s, entries] = await Promise.all([queryMcpScope(run), queryMcpAudit(run)]);
      if (!mounted.current) return;
      setScope(s);
      setAudit(entries);
      setNote('');
    } catch (err) {
      if (mounted.current) setNote(`读取 mcp_scope_query / mcp_audit_query 失败：${String(err)}`);
    }
  }, [run]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onApprove = useCallback(
    async (batch: ApprovalBatch): Promise<void> => {
      if (batch.clientId === '') {
        setNote('没有可批准的会话（第四张表无有效客户端）；未提交 mcp_approve。');
        return;
      }
      setBusy(true);
      try {
        const next = await approveMcpSession(run, batch);
        if (mounted.current) {
          setScope(next);
          setNote('已提交审批（mcp_approve）。');
        }
        await refresh();
      } catch (err) {
        if (mounted.current) setNote(`提交审批失败（mcp_approve）：${String(err)}`);
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [run, refresh],
  );

  const onRevoke = useCallback(
    async (clientId: string): Promise<void> => {
      setBusy(true);
      try {
        const next = await revokeMcpSession(run, clientId);
        if (mounted.current) {
          setScope(next);
          setNote(`已撤销会话 ${clientId}（mcp_revoke）。`);
        }
        await refresh();
      } catch (err) {
        if (mounted.current) setNote(`撤销失败（mcp_revoke）：${String(err)}`);
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [run, refresh],
  );

  const clients = scopeStateToClients(scope);
  const { clientId, pending, roots } = scopeStateToApproval(scope);

  return (
    <div className="settings-mcp">
      <SettingsAi clients={clients} pollMs={pollMs} />

      {/* 写前 diff：当前没有挂起的写请求，故 before/after 如实为空（不编造文件内容）。 */}
      <ApprovalUi
        clientId={clientId}
        pending={pending}
        roots={roots}
        before=""
        after=""
        onApprove={(batch) => void onApprove(batch)}
      />

      <section className="settings-mcp-revoke" aria-label="MCP 会话撤销">
        <h3>撤销会话授权</h3>
        {clients.length === 0 ? (
          <p>当前没有已授权会话。</p>
        ) : (
          <ul>
            {clients.map((c) => (
              <li key={c.clientId}>
                <code>{c.clientId}</code>
                <button type="button" disabled={busy} onClick={() => void onRevoke(c.clientId)}>
                  撤销（mcp_revoke）
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AuditPanel entries={audit} />

      {note !== '' && (
        <p className="settings-mcp-note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
