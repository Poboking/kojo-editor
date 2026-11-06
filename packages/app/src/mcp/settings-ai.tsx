/**
 * 设置页「AI 接入」（P0 契约 · 路 A，ADR-0013）。
 *
 * 独立组件：调 Rust 命令 `mcp_start` / `mcp_stop` / `mcp_status`，把 MCP 服务的
 * 开关、token、已连接客户端、状态做成**可见**的面板。本文件还导出 `AiAccessSection`
 * —— 设置页「AI 接入」节的整节编排（挂 SettingsAi + ApprovalUi + AuditPanel，读数 /
 * 审批 / 撤销 / 审计全接 Rust 既有命令），由 `SettingsPanel.tsx` 动态判断桌面壳后挂载。
 *
 * 铁律 4「不静默」：**三态必须可见**——「未启动」（stopped）/「未授权」（unauthorized）/
 * 「连接失败」（error），外加「运行中 / 已授权待握手 / 处理中」。任何一次 invoke 失败都把
 * 原错误显示出来，不吞、不假装成功。`mcp_status` 的 `clients` 只是**瞬时并发 TCP 连接数**，
 * additive 的 `connections` / `authorizedSessions` / `discoveryPath` 才是接入读数；
 * 逐客户端明细仍由可选 `clients` prop（第四张授权表）与 `connections` prop（内存接入台账）
 * 分别注入：授权 ≠ 连接，「已接入」只认台账命中，未注入时如实显示计数，不编造列表。
 *
 * token 只在 `mcp_start` 的返回值里出现（状态命令不回传明文）。`mcp_start` 对同一运行时
 * **幂等**（二次调用原样返回既有三元组），所以轮换不能靠「再 start 一次」：轮换＝先
 * `mcp_stop` 收回 listener / 发现文件，再 `mcp_start(true)` 起一个新运行时——新运行时的
 * 首次签发必铸新 token（端口也可能变），旧 token 立即失效。轮换会使已连接客户端失效，
 * 界面显式提示，不静默换掉。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { invoke } from '../bridge/invoke';
import {
  APPROVABLE_PRIVILEGED_TOOLS,
  ApprovalUi,
  type ApprovalBatch,
  type ApprovalItem,
  type ApprovalRootCandidate,
} from './approval-ui';
import { AuditPanel, type AuditEntryView } from './audit-panel';
import { Switch } from '../ui/Switch';
import { useNotify, type Notify } from '../ui/NotificationCenter';
import { rootIdOf } from './workspace-root-id';
// 专用视觉切片走**懒边**：`AiAccessSection` 由 SettingsPanel 动态 import，本 CSS 不进
// main.tsx 的静态链（ps10 开机图把 .css 当叶子，亦不计入文件/字节余量）。
import './settings-ai.css';

/** Rust `server.rs::ClientConnect`（serde camelCase）：接入台账一条回执。 */
export interface McpClientConnection {
  readonly clientId: string;
  readonly ts: string;
  readonly method: string;
}

/** 前端订阅的接入事件名（与 `protocol.rs::MCP_CLIENT_CONNECTED_EVENT` 逐字一致）。 */
export const MCP_CLIENT_CONNECTED_EVENT = 'mcp://client-connected';

/**
 * 生产订阅：Tauri 事件到达即回调。动态 import 保持开机图零 Tauri 依赖；
 * web 调试宿 / 单测没有 Tauri 事件总线时订阅失败不放大成面板故障（轮询读数兜底）。
 */
function defaultSubscribeClientConnected(handler: () => void): () => void {
  let cancelled = false;
  let unlisten: (() => void) | undefined;
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen(MCP_CLIENT_CONNECTED_EVENT, () => handler()))
    .then((off) => {
      if (cancelled) off();
      else unlisten = off;
    })
    .catch(() => {
      // 无 Tauri 事件总线：接入台账仍由 refresh / 轮询读到，不静默编造「未接入」。
    });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/** 默认动作 seam：真实实现按需装载，单测注入 spy 即可断言参数。返回 Promise 供复制反馈判成败。 */
function defaultCopy(text: string): Promise<void> {
  return import('../ui/context-menu-model').then((m) => m.copyTextToClipboard(text));
}
function defaultReveal(path: string): void {
  void import('../ui/reveal-explorer').then((m) => void m.revealInExplorer(path));
}

export type McpClientTier = 'read' | 'edit' | 'privileged';

/** 逐客户端明细（来自第四张授权表 `mcp_approvals.json`，由集成层注入）。 */
export interface McpClientInfo {
  readonly clientId: string;
  readonly tier?: McpClientTier;
  readonly connected?: boolean;
}

export interface SettingsAiProps {
  /** 可选的逐会话授权列表（第四张表；**不是**连接态，连接态由 `connections` 判定）。 */
  readonly clients?: readonly McpClientInfo[];
  /** additive：Rust 内存接入台账（首条已鉴权请求起，含 `initialize`）。 */
  readonly connections?: readonly McpClientConnection[];
  /**
   * 注入动作 seam：生产按需装载剪贴板 / 资源管理器，单测注入 spy。允许返回 Promise：
   * resolve ⇒ 按钮短暂变「已复制 ✓」；reject ⇒ 走 notify（UI-05 复制反馈）。旧的
   * fire-and-forget 形状（返回 void）依旧兼容，旧消费方零改动。
   */
  readonly onCopy?: (text: string) => void | Promise<void>;
  readonly onReveal?: (path: string) => void;
  /** 状态轮询间隔（毫秒），0 = 关闭轮询；默认 4000。 */
  readonly pollMs?: number;
  /** 每次读数（含读失败 ⇒ null）回传 status；宿主据此门控台账查询（UI-01）。 */
  readonly onStatus?: (s: McpStatus | null) => void;
  /** 可选：传入后在「已授权会话」每行渲染撤销按钮（UI-14）；缺省不渲染，旧消费方形状不变。 */
  readonly onRevoke?: (clientId: string) => void;
  /** 撤销动作进行中：行内撤销按钮禁用。 */
  readonly revokeDisabled?: boolean;
  /** 通知 seam（复制失败等）；缺省用全局 NotificationCenter。 */
  readonly onNotify?: Notify;
  /**
   * 命令执行器注入 seam（additive，2026-11-06）：缺省沿用 `invoke`（生产 Tauri IPC），
   * 单测注入假实现即可验证「轮换先 stop 再 start」「三态上屏」而不起 GUI / HTTP。
   * 旧消费方只传 clients / pollMs 时形状零变化；类型定义在下方「可注入动作」区。
   */
  readonly runner?: McpCommandRunner;
}

interface McpStartResult {
  readonly port: number;
  readonly token: string;
  readonly endpoint: string;
}

/** Rust `server.rs::McpStatus`；后三格是接入可见性批的 additive 读数（旧响应可缺席）。 */
export interface McpStatus {
  readonly enabled: boolean;
  readonly port: number | null;
  /** 瞬时并发 TCP 连接数（`Connection: close` 后即减），**不是**「已接入客户端数」。 */
  readonly clients: number;
  /** 本次运行时已握手的去重 clientId 数（真源＝内存接入台账）。 */
  readonly connections?: number;
  /** 第四张表里未撤销的授权会话数（授权 ≠ 连接）。 */
  readonly authorizedSessions?: number;
  /** 发现文件真实路径（供展示 / 复制 / 打开目录；**不含 token**）。 */
  readonly discoveryPath?: string;
  readonly endpoint?: string;
}

export type Phase =
  | 'loading'
  | 'stopped'
  | 'running'
  | 'awaiting'
  | 'unauthorized'
  | 'error'
  | 'busy';

const PHASE_LABEL: Readonly<Record<Phase, string>> = {
  loading: '正在读取状态…',
  stopped: '未启动',
  running: '运行中', // 旧三态判据钉住这个字面量；正面接入确认在下方接入卡里给
  awaiting: '已授权 · 等待首次握手',
  unauthorized: '未授权',
  error: '连接失败',
  busy: '处理中…',
};

/** 徽标短态（UI-27）：徽标只留两三个字，完整状态句由状态条负责。 */
const PHASE_SHORT: Readonly<Record<Phase, string>> = {
  loading: '读取中',
  stopped: '未启动',
  running: '已接入',
  awaiting: '待握手',
  unauthorized: '未授权',
  error: '失败',
  busy: '处理中',
};

const POLL_DEFAULT_MS = 4000;
/** 操作回执（receipt）保留时长（UI-03）：30s 或到下一次操作。 */
const RECEIPT_TTL_MS = 30_000;
/** 复制按钮「已复制 ✓」反馈时长（UI-05）。 */
const COPY_FEEDBACK_MS = 1200;

/** 档位人话（UI-14 会话行）：原始 tier 收进 title。 */
const TIER_LABEL: Readonly<Record<McpClientTier, string>> = {
  read: '只读',
  edit: '可编辑',
  privileged: '特权',
};

/** 错误 → 单行人话：去掉 `Error: ` 前缀（UI-01：黄条不再复读「Error:」）。 */
function errText(err: unknown): string {
  return String(err).replace(/^Error:\s*/, '');
}

/**
 * ISO 时间戳 → 人话相对时间（UI-21）：<60s「刚刚」/ <60m「N 分钟前」/ <24h「N 小时前」/
 * 其余落到本地日期。解析失败如实回原串，不编造「刚刚」。
 */
export function formatRelativeTime(ts: string): string {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return ts;
  const diff = Date.now() - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(t).toLocaleDateString('zh-CN');
}

/** 秒龄 → 「N 秒前 / N 分钟前 / N 小时前」（UI-24 状态条年龄胶囊；纯函数便于单测）。 */
export function formatAgeSeconds(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  return `${Math.floor(s / 3600)} 小时前`;
}

/** `name@hash` 拆开（UI-21）：屏上只留名字，hash 随完整 clientId 收进 title。 */
export function splitClientId(clientId: string): { name: string; hash: string } {
  const at = clientId.indexOf('@');
  return at === -1
    ? { name: clientId, hash: '' }
    : { name: clientId.slice(0, at), hash: clientId.slice(at + 1) };
}

/**
 * 状态机（纯函数，可单测）：三读数拆开后再判相，不再拿瞬时并发连接数冒充接入成功。
 * additive 字段缺席时回落旧口径（`clients > 0 ⇒ running`），旧消费方 / 旧响应零变化。
 */
export function classifyMcpPhase(s: McpStatus): Phase {
  if (!s.enabled) return 'stopped';
  if (s.connections === undefined || s.authorizedSessions === undefined) {
    return s.clients > 0 ? 'running' : 'unauthorized';
  }
  if (s.connections > 0) return 'running';
  return s.authorizedSessions > 0 ? 'awaiting' : 'unauthorized';
}

/**
 * 一键生成客户端配置：只指向零依赖 stdio shim，**不含 token / 端口 / 主机地址**。
 * shim 运行时从发现文件读凭据，所以配置可以安全复制进任何客户端文件（README §3 / §4）。
 * `<KOJO_REPO>` 是给人看的占位符，需换成仓库根目录绝对路径；不猜、不编造机器路径。
 */
export function clientConfigSnippet(): string {
  return JSON.stringify(
    {
      mcpServers: {
        kojo: {
          command: 'node',
          args: ['<KOJO_REPO>/tools/kojo-mcp.mjs'],
        },
      },
    },
    null,
    2,
  );
}

function maskToken(token: string): string {
  if (token.length <= 8) return '••••••••';
  return `${token.slice(0, 4)}••••••••${token.slice(-4)}`;
}

export function SettingsAi({
  clients,
  connections = [],
  onCopy = defaultCopy,
  onReveal = defaultReveal,
  pollMs = POLL_DEFAULT_MS,
  runner,
  onStatus,
  onRevoke,
  revokeDisabled = false,
  onNotify,
}: SettingsAiProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [detail, setDetail] = useState<string>('');
  const [rotateArmed, setRotateArmed] = useState(false);
  // 回执通道（UI-03）：开启 / 关闭 / 轮换的成功或失败走 receipt，30s TTL 或到下一次操作；
  // 4s 轮询的 refresh 只更新 detail、**永不覆盖** receipt。状态条优先显示 receipt。
  const [receipt, setReceipt] = useState<string>('');
  // 复制反馈（UI-05）：key ∈ path / config / endpoint，1.2s 后还原按钮文案。
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  // 状态条年龄（UI-24）：最近一次成功 refresh 的时刻 + 每秒跳动的 now ⇒「更新于 N 秒前」。
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const mounted = useRef(true);
  const receiptTimerRef = useRef<number | undefined>(undefined);
  const copyTimerRef = useRef<number | undefined>(undefined);
  // runner / onCopy / onStatus 每次渲染可能是新引用 ⇒ 收进 ref，避免依赖抖动反复刷 IPC
  // （与 AiAccessSection 同口径）。
  const runnerRef = useRef<McpCommandRunner | undefined>(runner);
  runnerRef.current = runner;
  const onCopyRef = useRef(onCopy);
  onCopyRef.current = onCopy;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const run = useCallback(
    (cmd: string, args?: Record<string, unknown>): Promise<unknown> =>
      runnerRef.current ? runnerRef.current(cmd, args) : invoke(cmd, args),
    [],
  );
  const fallbackNotify = useNotify();
  const notify = onNotify ?? fallbackNotify;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // 卸载清尾：回执 / 复制反馈的 setTimeout 不许在组件死后 setState。
  useEffect(
    () => () => {
      window.clearTimeout(receiptTimerRef.current);
      window.clearTimeout(copyTimerRef.current);
    },
    [],
  );
  // 「更新于 N 秒前」每秒跳动（UI-24）。
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  /** 操作回执入口（UI-03）：重置 30s TTL。 */
  const showReceipt = useCallback((message: string): void => {
    setReceipt(message);
    window.clearTimeout(receiptTimerRef.current);
    receiptTimerRef.current = window.setTimeout(() => {
      if (mounted.current) setReceipt('');
    }, RECEIPT_TTL_MS);
  }, []);

  /** 复制 + 按钮反馈（UI-05）：成功短暂变「已复制 ✓」，失败走 notify，不静默。 */
  const copyWithFeedback = useCallback(
    async (key: string, text: string): Promise<void> => {
      try {
        await onCopyRef.current(text);
        if (!mounted.current) return;
        setCopiedKey(key);
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = window.setTimeout(() => {
          if (mounted.current) setCopiedKey(null);
        }, COPY_FEEDBACK_MS);
      } catch (err) {
        if (!mounted.current) return;
        notify({ kind: 'error', title: '复制失败', message: errText(err) });
      }
    },
    [notify],
  );

  const classify = useCallback((s: McpStatus): Phase => classifyMcpPhase(s), []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const s = (await run('mcp_status')) as McpStatus;
      if (!mounted.current) return;
      setStatus(s);
      setPhase(classify(s));
      setLastUpdated(Date.now());
      setDetail(
        s.enabled
          ? `端口 ${s.port ?? '—'} · 瞬时并发连接 ${s.clients} · 已握手 ${s.connections ?? 0}`
          : 'MCP 服务未启动。开启后编辑器会写入 mcp-endpoint.json 供 stdio shim 发现。',
      );
      onStatusRef.current?.(s);
    } catch (err) {
      if (!mounted.current) return;
      setPhase('error'); // 连接失败：显式可见，不静默
      setStatus(null); // 读数未知 ⇒ 三张读数卡如实「—」，不拿旧值或 0 冒充（UI-02）
      setDetail(`读取 mcp_status 失败：${errText(err)}`);
      onStatusRef.current?.(null);
    }
  }, [classify, run]);

  useEffect(() => {
    void refresh();
    if (pollMs <= 0) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  const fail = useCallback(
    (what: string, err: unknown): void => {
      if (!mounted.current) return;
      setPhase('error');
      const message = `${what}失败：${errText(err)}`;
      setDetail(message);
      showReceipt(message); // 操作失败是回执：不被 4s 轮询冲掉（UI-03）
    },
    [showReceipt],
  );

  const start = useCallback(async (): Promise<void> => {
    setPhase('busy');
    try {
      const r = (await run('mcp_start', { enabled: true })) as McpStartResult;
      if (!mounted.current) return;
      setToken(r.token);
      setShowToken(false);
      await refresh();
      showReceipt('MCP 服务已开启：发现文件已写入，等待客户端握手。');
    } catch (err) {
      fail('开启 MCP 服务', err);
    }
  }, [refresh, fail, run, showReceipt]);

  const stop = useCallback(async (): Promise<void> => {
    setPhase('busy');
    try {
      await run('mcp_stop');
      if (!mounted.current) return;
      setToken(null);
      setShowToken(false);
      await refresh();
      showReceipt('MCP 服务已关闭：listener 与发现文件已收回。');
    } catch (err) {
      fail('关闭 MCP 服务', err);
    }
  }, [refresh, fail, run, showReceipt]);

  const rotate = useCallback(async (): Promise<void> => {
    setRotateArmed(false);
    setPhase('busy');
    try {
      // `mcp_start` 幂等（同一运行时返回旧 token）⇒ 轮换必须停一次再起：
      // stop 收回 listener 与发现文件，start 新起运行时首次签发必铸新 token。
      await run('mcp_stop');
      if (!mounted.current) return;
      setToken(null);
      const r = (await run('mcp_start', { enabled: true })) as McpStartResult;
      if (!mounted.current) return;
      setToken(r.token);
      setShowToken(false);
      await refresh();
      if (mounted.current) {
        // 轮换回执走 receipt 通道：4s 轮询不再把它冲掉（UI-03）。
        showReceipt(
          'token 已轮换（端点已重启并换发）：旧 token 立即失效，客户端需用新 token 重连；' +
            '已批准的工具授权按 clientId 保留。',
        );
      }
    } catch (err) {
      fail('轮换 token', err);
    }
  }, [refresh, fail, run, showReceipt]);

  const enabled = status?.enabled ?? false;
  const discoveryPath = status?.discoveryPath ?? '';
  // UI-02：status 为 null（读取中 / 读取失败）时读数**未知** ⇒ 一律「—」，不编造 0；
  // authorizedCount 的第四张表兜底只在真拿到 status 后参与。
  const concurrentNow = status === null ? null : status.clients;
  const handshakeCount = status === null ? null : (status.connections ?? connections.length);
  const authorizedCount =
    status === null ? null : (status.authorizedSessions ?? (clients?.length ?? 0));
  const hasDetailedClients = clients !== undefined && clients.length > 0;
  const latest = connections[0];
  // UI-06：端点与 token 解耦——enabled 即显示；优先真源 status.endpoint，缺了才按端口兜底拼接。
  const endpointUrl =
    status?.endpoint !== undefined && status.endpoint !== ''
      ? status.endpoint
      : status?.port != null
        ? `http://127.0.0.1:${status.port}/mcp`
        : '';

  /** 读数卡：未知（null）显「—」并弱化（settings-ai-metric--unknown，样式归 Lane B）。 */
  const metric = (label: string, value: number | null, hint: string): ReactElement => (
    <div className={`settings-ai-metric${value === null ? ' settings-ai-metric--unknown' : ''}`}>
      <span className="settings-ai-metric-label">{label}</span>
      <strong className="settings-ai-metric-value">{value === null ? '—' : value}</strong>
      <span className="settings-ai-metric-hint">{value === null ? '读数不可用' : hint}</span>
    </div>
  );

  return (
    <section className="settings-ai" aria-label="AI 接入">
      <header className="settings-ai-head">
        <div className="settings-ai-head-copy">
          <h2>AI 接入（MCP Server）</h2>
          <p className="settings-ai-hint">
            把编辑器能力开放给 Codex / DeepSeek Harness 等外部 AI。服务仅监听回环，
            需 Bearer token 与逐会话授权；危险工具逐项批准。
          </p>
        </div>
        {/* 徽标只留短态（UI-27）：完整状态句在下方状态条 */}
        <span className={`settings-ai-badge settings-ai-badge--${phase}`} aria-hidden="true">
          {PHASE_SHORT[phase]}
        </span>
      </header>

      {/* 状态条：三态 + detail 一律可见；receipt（操作回执）优先于轮询 detail（UI-03）；
          右侧「更新于 N 秒前」胶囊可点击手动刷新（UI-24，替代无反馈的「刷新状态」死按钮） */}
      <div className={`settings-ai-status settings-ai-status--${phase}`} role="status">
        <span className="settings-ai-status-label">状态：{PHASE_LABEL[phase]}</span>
        <span className="settings-ai-status-detail">{receipt !== '' ? receipt : detail}</span>
        {lastUpdated !== null && (
          <button
            type="button"
            className="settings-ai-status-age"
            aria-label="手动刷新 AI 接入状态"
            onClick={() => void refresh()}
          >
            更新于 {formatAgeSeconds(Math.max(0, Math.floor((nowMs - lastUpdated) / 1000)))}
          </button>
        )}
      </div>

      {/* 主操作前置（UI-13）：开关挪到状态头之后、读数卡之前，首屏就能完成「开启」这一步 */}
      <div className="settings-ai-row settings-ai-controls">
        <label className="settings-ai-toggle">
          <Switch
            checked={enabled}
            disabled={phase === 'busy' || phase === 'loading'}
            onChange={(next) => void (next ? start() : stop())}
            label="启用 MCP 服务"
          />
          <span>启用 MCP 服务</span>
        </label>
      </div>

      {/* 三个读数拆开：并发连接 ≠ 已授权会话 ≠ 已握手客户端（旧实现把三者混成 clients） */}
      <div className="settings-ai-metrics">
        {metric('瞬时并发连接', concurrentNow, '当前打开的 TCP 连接；请求结束即减')}
        {metric('已授权会话', authorizedCount, '第四张表未撤销的会话；授权不等于连接')}
        {metric('已握手客户端', handshakeCount, '本次运行时真实触达端点的去重 clientId')}
      </div>

      {/* 接入确认卡（UI-12）两态互斥：已接入 → 回执 + 发现文件 + 操作；未接入 → 三步向导 */}
      <section className="settings-ai-onboard" aria-label="MCP 接入确认">
        <div className="settings-ai-onboard-head">
          <h3>接入确认</h3>
          <span className="settings-ai-onboard-tag">握手回执</span>
        </div>
        {latest !== undefined ? (
          <p className="settings-ai-onboard-ok" role="status">
            已接入 <span title={latest.clientId}>{splitClientId(latest.clientId).name}</span>
            {' · '}最近 {latest.method === 'initialize' ? '首次握手' : latest.method}
            {' · '}
            {formatRelativeTime(latest.ts)}
            {connections.length > 1 ? ` · 共 ${connections.length} 个客户端` : ''}
          </p>
        ) : (
          <>
            <p className="settings-ai-onboard-wait" role="status">
              尚未检测到客户端接入：完成下面三步，首次握手会在这里变成正面确认。
            </p>
            {/* 三步向导（UI-13）：开启服务 → 复制配置 → 等待握手 */}
            <ol className="settings-ai-onboard-steps">
              <li>开启服务：拨动上方开关，编辑器写入发现文件（真实路径见下）。</li>
              <li>
                复制配置：把 stdio shim（<code>node tools/kojo-mcp.mjs</code>）配进客户端；配置里不含 token。
              </li>
              <li>等待握手：客户端首次握手后，本页自动刷新并给出正面确认。</li>
            </ol>
          </>
        )}
        <div className="settings-ai-discovery">
          <span className="settings-ai-discovery-label">发现文件</span>
          <code className="settings-ai-discovery-path" title={discoveryPath || undefined}>
            {discoveryPath || '（服务未启动或路径未知）'}
          </code>
        </div>
        <div className="settings-ai-onboard-actions">
          <button
            type="button"
            className="small"
            disabled={discoveryPath === ''}
            onClick={() => void copyWithFeedback('path', discoveryPath)}
          >
            {copiedKey === 'path' ? '已复制 ✓' : '复制路径'}
          </button>
          <button
            type="button"
            className="small"
            disabled={discoveryPath === ''}
            onClick={() => onReveal(discoveryPath)}
          >
            打开所在目录
          </button>
          <button
            type="button"
            className="small"
            onClick={() => void copyWithFeedback('config', clientConfigSnippet())}
          >
            {copiedKey === 'config' ? '已复制 ✓' : '复制客户端配置'}
          </button>
        </div>
        <p className="settings-ai-onboard-foot">
          路径只用于定位；token 永远不进客户端配置、日志或 stdout。
        </p>
      </section>

      {/* token 行：空态一句话（UI-22），机制细节收进 title；端点与 token 解耦（UI-06） */}
      <div className="settings-ai-row settings-ai-token">
        <span className="settings-ai-token-label">Token：</span>
        {token === null ? (
          <span
            className="settings-ai-token-empty"
            title="明文只在开启 / 轮换（mcp_start）的返回值里出现；状态命令不回传明文，token 不进日志、客户端配置或 stdout。stdio shim 运行时从发现文件读取凭据。"
          >
            凭据由发现文件托管，无需手动复制
          </span>
        ) : (
          <>
            <code>{showToken ? token : maskToken(token)}</code>
            <button type="button" className="small" onClick={() => setShowToken((v) => !v)}>
              {showToken ? '隐藏' : '显示'}
            </button>
          </>
        )}
        {token !== null && !rotateArmed && (
          <button type="button" className="small" onClick={() => setRotateArmed(true)} disabled={phase === 'busy'}>
            轮换
          </button>
        )}
        {rotateArmed && (
          <span className="settings-ai-rotate-confirm">
            轮换会使现有客户端失效，确认？
            <button type="button" className="small" onClick={() => void rotate()}>确认轮换</button>
            <button type="button" className="small" onClick={() => setRotateArmed(false)}>取消</button>
          </span>
        )}
        {enabled && endpointUrl !== '' && (
          <span className="settings-ai-endpoint">
            端点：<code>{endpointUrl}</code>
            <button
              type="button"
              className="small"
              onClick={() => void copyWithFeedback('endpoint', endpointUrl)}
            >
              {copiedKey === 'endpoint' ? '已复制 ✓' : '复制端点'}
            </button>
          </span>
        )}
      </div>

      {/* 已授权会话（UI-14）：撤销做进行内（onRevoke 可选，缺省不渲染按钮）；
          连接态仍由接入台账判定，最近握手时间用相对时间（UI-21），clientId 拆名、hash 进 title */}
      <div className="settings-ai-clients">
        <h3>
          已授权会话（
          {authorizedCount === null ? '—' : hasDetailedClients ? clients!.length : authorizedCount}）
        </h3>
        {hasDetailedClients ? (
          <ul className="settings-ai-client-list">
            {clients!.map((c) => {
              const seen = connections.find((x) => x.clientId === c.clientId);
              return (
                <li key={c.clientId}>
                  <code title={c.clientId}>{splitClientId(c.clientId).name}</code>
                  {c.tier !== undefined && (
                    <span className="settings-ai-client-tier" title={`tier ${c.tier}`}>
                      {TIER_LABEL[c.tier]}
                    </span>
                  )}
                  <span className={`settings-ai-client-state settings-ai-client-state--${c.connected === true ? 'on' : 'off'}`}>
                    {c.connected === true ? '已接入' : '未接入'}
                  </span>
                  {seen !== undefined && (
                    <span className="settings-ai-client-seen" title={seen.ts}>
                      最近握手 {formatRelativeTime(seen.ts)}
                    </span>
                  )}
                  {onRevoke !== undefined && (
                    <button
                      type="button"
                      className="small"
                      disabled={revokeDisabled}
                      onClick={() => onRevoke(c.clientId)}
                    >
                      撤销
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : authorizedCount === null ? (
          <p>会话读数暂不可用（状态读取失败或仍在读取）。</p>
        ) : authorizedCount > 0 ? (
          <p>有 {authorizedCount} 个已授权会话；逐会话明细由第四张授权表（路 C）提供。</p>
        ) : (
          <p>当前没有已授权会话。客户端首次握手后仍需在此逐项批准工具。</p>
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
  /** additive：端点内存接入台账（只读，服务未启动时显式报错）。 */
  connectionsQuery: 'mcp_connections_query',
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
  /** additive（写域多根）：人类逐项批准的常驻可写根枚举标识；旧表缺席 ⇒ 空（默认拒绝）。 */
  readonly approvedRootIds?: readonly string[];
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
  /** 宿主侧真读数（B5）；缺真源就整格缺席，不拿估算冒充实测。 */
  readonly elapsedMs?: number;
}

/** 仍有效的会话（撤销过的不算已连接；不编造）。 */
function activeSessions(state: McpScopeState | null): readonly McpSessionGrant[] {
  if (!state) return [];
  return (state.sessions ?? []).filter((s) => !s.revokedAt);
}

/**
 * 第四张表 → `SettingsAi` 的逐会话明细。
 *
 * 旧实现硬编码 `connected: true`，把「授权台账里有这条记录」冒充「客户端还连着」——
 * 这是审阅发现的语义坑。现在 `connected` 只由**端点内存接入台账**判定：命中即 true，
 * 没命中（含旧消费方不传台账）如实 false。授权与连接从此是两件事。
 */
export function scopeStateToClients(
  state: McpScopeState | null,
  handshakes: readonly McpClientConnection[] = [],
): McpClientInfo[] {
  const seen = new Set(handshakes.map((h) => h.clientId));
  return activeSessions(state).map((s) => ({
    clientId: s.clientId,
    tier: s.tier,
    connected: seen.has(s.clientId),
  }));
}

/** 批准面候选来源（additive）：不传时保持旧形状（两枚具名特权工具）。 */
export interface ApprovalCandidates {
  /**
   * 宿主注入的**运行时工具目录**（命令注册表 ID ∪ 具名工具名）。命令面板动作是运行时
   * 动态投影成同名工具的，不在 `*_TOOL_SPECS` 静态规格里，因此只有从宿主真源注入才
   * 列得全；不注入就退回旧的两枚，旧消费方零改动。
   */
  readonly candidateTools?: readonly string[];
}

/** 与 `buildApprovalBatch` 同一把形状闸：列出的项必须真能写进第四张表，不许「列得出、批不进」。 */
const APPROVABLE_TOOL_NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * 只读真源 `workspace_roots`（`Vec<String>`）→ 批准面板的候选常驻根。
 * - `id` 按**根绝对路径**算稳定标识（与 MCP 写腿 / Rust 端点同一函数口径），不随增删顺序漂移；
 * - `label` 只用于给人看，绝不作为落点入参下发；
 * - 读数不是数组 / 元素不是字符串 ⇒ 如实得空表（不编造根、不猜路径）。
 */
export function workspaceRootIdCandidates(raw: unknown): ApprovalRootCandidate[] {
  const roots = Array.isArray(raw)
    ? raw.filter((r): r is string => typeof r === 'string' && r !== '')
    : [];
  return roots.map((label) => ({ id: rootIdOf(label), label }));
}

/** 第四张表 → `ApprovalUi` 的 (clientId, pending, roots, approvedTools)。 */
export function scopeStateToApproval(
  state: McpScopeState | null,
  options: ApprovalCandidates = {},
): {
  clientId: string;
  pending: ApprovalItem[];
  roots: string[];
  /** 当前会话已批准的工具名（铁律 4：批准落没落地要在面板上看得见，不许靠猜）。 */
  approvedTools: string[];
  /** additive：当前会话已批准的常驻可写根标识（旧表缺席 ⇒ 空数组）。 */
  approvedRootIds: string[];
} {
  const sessions = activeSessions(state);
  const clientId = sessions[0]?.clientId ?? '';
  // 静态具名特权工具是规格真源（`APPROVABLE_PRIVILEGED_TOOLS`，由 mcp-security
  // 漂移闸对拍；B4 起含启动器族，枚数随批次涨）；命令面板动作是运行时投影，
  // 只能由宿主注入。两者合起来＝完整可批准面。
  // 第四张表按工具名**精确**授权，所有候选一律 privileged，勾选后由 mcp_approve 写入。
  // 形状闸与 buildApprovalBatch 同尺：不合法的候选不列（绝不列出来再静默剔除）。
  const names =
    options.candidateTools === undefined
      ? [...APPROVABLE_PRIVILEGED_TOOLS]
      : [...new Set([...APPROVABLE_PRIVILEGED_TOOLS, ...options.candidateTools])];
  const pending: ApprovalItem[] = names
    .filter(
      (name) =>
        name.length <= 64 &&
        APPROVABLE_TOOL_NAME.test(name) &&
        !name.startsWith('market_'), // market_* 保持 fail-closed，不进批准面
    )
    .map((name) => ({
      name,
      tier: 'privileged',
      reason: '特权工具，默认不进 tools/list，需逐会话显式批准（按工具名精确授权）',
    }));
  const roots = [...new Set(sessions.flatMap((s) => s.approvedRoots ?? []))];
  const approvedTools = [
    ...new Set(
      sessions
        .filter((s) => s.clientId === clientId)
        .flatMap((s) => s.approvedTools ?? []),
    ),
  ];
  const approvedRootIds = [
    ...new Set(
      sessions
        .filter((s) => s.clientId === clientId)
        .flatMap((s) => s.approvedRootIds ?? []),
    ),
  ];
  return { clientId, pending, roots, approvedTools, approvedRootIds };
}

/** `ApprovalBatch` → `mcp_approve` 的 args（camelCase，对齐 Rust `ApproveArgs`）。 */
export function approveArgs(batch: ApprovalBatch): Record<string, unknown> {
  // additive：未批准任何常驻根时**一字不加**（旧四键形状零变化，Rust `#[serde(default)]`
  // 把缺席读成空表 ⇒ 默认拒绝）；只有人类真的勾了候选根才把精确列名带下去。
  const rootIds = [...new Set(batch.approvedRootIds ?? [])].filter((id) =>
    /^ws:[0-9a-f]{8}$/.test(id),
  );
  return {
    clientId: batch.clientId,
    tier: batch.tier,
    approvedRoots: batch.approvedRoots,
    approvedTools: batch.approvedTools,
    ...(rootIds.length > 0 ? { approvedRootIds: rootIds } : {}),
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
    ...(raw.sessionId !== undefined ? { sessionId: raw.sessionId } : {}),
    ...(raw.elapsedMs !== undefined ? { elapsedMs: raw.elapsedMs } : {}),
    ...(raw.landedPath !== undefined ? { landedPath: raw.landedPath } : {}),
    ...(raw.note !== undefined ? { note: raw.note } : {}),
  };
}

/* -------------------- 可注入动作（命令名集中，单测可 spy） -------------------- */

export async function queryMcpScope(run: McpCommandRunner): Promise<McpScopeState> {
  return (await run(MCP_SETTINGS_COMMANDS.scopeQuery)) as McpScopeState;
}

/** 接入台账读数；服务未启动时 Rust 显式报错，本函数不吞、不回空表冒充「零接入」。 */
export async function queryMcpConnections(
  run: McpCommandRunner,
): Promise<readonly McpClientConnection[]> {
  const raw = await run(MCP_SETTINGS_COMMANDS.connectionsQuery);
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is McpClientConnection =>
      typeof r === 'object' &&
      r !== null &&
      typeof (r as McpClientConnection).clientId === 'string',
  );
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
  /**
   * `SettingsAi` 状态轮询间隔。接入可见性批改为**默认 4000ms 自动轮询**（旧值 0
   * 让生产界面停在首次读数不动），配合 `mcp://client-connected` 事件即时刷新。
   * 单测 / 主动关闭时传 0。
   */
  readonly pollMs?: number;
  /** 接入事件订阅 seam；生产默认动态装载 Tauri `listen`，单测注入假订阅即可触发。 */
  readonly subscribeClientConnected?: (handler: () => void) => () => void;
  /** 注入动作 / 通知 seam，透传给 `SettingsAi` 与首次握手 toast。 */
  readonly onCopy?: (text: string) => void | Promise<void>;
  readonly onReveal?: (path: string) => void;
  readonly onNotify?: Notify;
  /**
   * 运行时工具目录（additive）：由设置页注入统一命令注册表 ID，让批准面列得出全部
   * 命令面板动作；不传则退回两枚具名特权工具（旧消费方零改动）。
   */
  readonly candidateTools?: readonly string[];
}

/**
 * 「AI 接入」整节：把三块面板挂在一起并把读数 / 提交接到 Rust 既有命令。
 * 不吞错、不假装成功、不编造读数（铁律 4）；接不到读数时面板显示显式失败文案。
 */
export function AiAccessSection({
  runner,
  pollMs = POLL_DEFAULT_MS,
  candidateTools,
  subscribeClientConnected = defaultSubscribeClientConnected,
  onCopy,
  onReveal,
  onNotify,
}: AiAccessSectionProps): ReactElement {
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
  // additive（接入可见性）：端点内存接入台账；读失败单独上屏，不连累既有三块面板。
  const [connections, setConnections] = useState<readonly McpClientConnection[]>([]);
  const [connectionNote, setConnectionNote] = useState<string>('');
  // UI-01：SettingsAi 每次读数经 onStatus 回传；仅 enabled 时才查台账——服务未启动不查、
  // 不报「读取失败」，disabled 时清空台账与警告。
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  // 握手事件到达时 bump：让下方台账 effect 即时重查（不必等下一次 status 轮询）。
  const [connTick, setConnTick] = useState(0);
  const defaultNotify = useNotify();
  const notify = onNotify ?? defaultNotify;
  // additive（写域多根）：候选常驻根来自只读真源 workspace_roots；枚举失败单独上屏，
  // 不连累 scope / audit 两块既有读数（铁律 4：不静默，也不吞掉其它面板）。
  const [rootCandidates, setRootCandidates] = useState<readonly ApprovalRootCandidate[]>([]);
  const [rootEnumerationNote, setRootEnumerationNote] = useState<string | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onStatus = useCallback((s: McpStatus | null): void => {
    if (mounted.current) setMcpStatus(s);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [s, entries] = await Promise.all([queryMcpScope(run), queryMcpAudit(run)]);
      // 候选根只是**发现面**：单独取、单独失败上屏，绝不让一次只读枚举失败把
      // scope / audit 一起拖成「连接失败」，也绝不静默装作「没有候选根」。
      let rootRaw: unknown = null;
      let rootErr = '';
      try {
        rootRaw = await run('workspace_roots');
      } catch (err) {
        rootErr = String(err);
      }
      if (!mounted.current) return;
      setScope(s);
      setAudit(entries);
      setRootCandidates(workspaceRootIdCandidates(rootRaw));
      setRootEnumerationNote(
        rootErr === ''
          ? undefined
          : `常驻可写根枚举失败：${rootErr}（本次不列候选根；已批准授权不受影响）`,
      );
      setNote('');
    } catch (err) {
      if (mounted.current) setNote(`读取 mcp_scope_query / mcp_audit_query 失败：${String(err)}`);
    }
  }, [run]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // UI-01：台账读数按 status.enabled 门控——服务未启动时不查、不报「读取失败」；
  // disabled 时清空台账与警告；enabled 下真读失败才上屏（去掉 Error: 前缀）。
  // status 每次 refresh 都是新对象 ⇒ 本 effect 随轮询自动重查；connTick 供握手事件即时触发。
  useEffect(() => {
    if (mcpStatus === null) return; // 状态未知：不查、不报（不编造坏消息）
    if (!mcpStatus.enabled) {
      setConnections([]);
      setConnectionNote('');
      return;
    }
    let cancelled = false;
    queryMcpConnections(run)
      .then((conns) => {
        if (!cancelled && mounted.current) {
          setConnections(conns);
          setConnectionNote('');
        }
      })
      .catch((err) => {
        if (!cancelled && mounted.current) {
          setConnectionNote(`接入台账读取失败：${errText(err)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mcpStatus, connTick, run]);

  /** 首次握手事件：立刻重查台账（不必等 4s 轮询）+ 一条正面通知。 */
  const onClientConnected = useCallback(async (): Promise<void> => {
    await refresh();
    if (!mounted.current) return;
    setConnTick((t) => t + 1);
    notify({
      kind: 'info',
      title: 'MCP 接入',
      message: '已接入：外部客户端首次握手成功',
    });
  }, [refresh, notify]);

  useEffect(
    () => subscribeClientConnected(() => void onClientConnected()),
    [subscribeClientConnected, onClientConnected],
  );

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

  // 连接态现在由端点接入台账判定，不再由「授权表里有记录」硬编码推出来。
  const clients = scopeStateToClients(scope, connections);
  const { clientId, pending, roots, approvedTools, approvedRootIds } = scopeStateToApproval(
    scope,
    { candidateTools },
  );

  return (
    <div className="settings-mcp">
      <SettingsAi
        clients={clients}
        connections={connections}
        pollMs={pollMs}
        runner={runner}
        onStatus={onStatus}
        onRevoke={(id) => void onRevoke(id)}
        revokeDisabled={busy}
        onNotify={notify}
        {...(onCopy !== undefined ? { onCopy } : {})}
        {...(onReveal !== undefined ? { onReveal } : {})}
      />
      {connectionNote !== '' && (
        <p className="settings-mcp-note settings-mcp-note--warn" role="status">
          {connectionNote}
        </p>
      )}

      {/* 写前 diff：当前没有挂起的写请求，故 before/after 如实为空（不编造文件内容）。
          approvedTools：第四张表里本会话已批准的工具，批准 / 撤销后随刷新在面板翻转（不静默）。 */}
      <ApprovalUi
        clientId={clientId}
        pending={pending}
        roots={roots}
        before=""
        after=""
        approvedTools={approvedTools}
        candidateRootIds={rootCandidates}
        approvedRootIds={approvedRootIds}
        {...(rootEnumerationNote !== undefined ? { rootEnumerationNote } : {})}
        onApprove={(batch) => void onApprove(batch)}
      />

      {/* UI-14：撤销入口已并入上方「已授权会话」行内，独立撤销卡删除——
          页面只出现一次 clientId 列表 */}

      <AuditPanel entries={audit} />

      {note !== '' && (
        <p className="settings-mcp-note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
