/**
 * 设置页「AI 接入」（P0 契约 · 路 A，ADR-0013）。
 *
 * 独立组件：调 Rust 命令 `mcp_start` / `mcp_stop` / `mcp_status`，把 MCP 服务的
 * 开关、token、已连接客户端、状态做成**可见**的面板。本路不改 `SettingsPanel.tsx`
 * （不在独占文件清单里），集成时由主 agent 把本组件挂进设置的「AI 接入」节。
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
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../bridge/invoke';

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
