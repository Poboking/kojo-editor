//! 本机 HTTP server（Streamable HTTP，单端点 `POST /mcp`）。
//!
//! - 只 bind `127.0.0.1`，端口 0 由 OS 动态分配；
//! - 三缺一不可：仅回环 + `Authorization: Bearer <token>` + Origin 白名单
//!   （只放行 127.0.0.1 / localhost / [::1]）；
//! - `initialize` 旧握手兼容 + 2026-07-28 无状态按请求协商能力（`_meta.io.modelcontextprotocol/*`）；
//! - 六种方法转成 `"mcp://request"` 事件发给 WebView，带内部 request id 路由表等
//!   `mcp_respond` 回填；超时 / 取消 / 返回体积上限 / 速率限制齐备；
//! - 请求级 SSE 可选（`Accept: text/event-stream`）；
//! - 发现文件 `%APPDATA%/dev.kojo.editor/mcp-endpoint.json` 写 `{port,token,endpoint}`，
//!   `mcp_stop` 与窗口退出时删除。
//!
//! 优先复用仓库既有依赖（std::net + serde_json + tauri）；**只用 std 线程，不引入
//! tokio 网络栈**（tokio 在本仓只开了 fs/io-util 两个 feature）。生成 token 用
//! `rand`（提为直接依赖，已在 Cargo.lock 的 tauri 依赖树里，不新增编译单元）。
//!
//! ADR-0003 例外：本模块是已拍板的 MCP endpoint，承载线协议与会话授权，但**不含
//! 任何游戏语义 / 业务逻辑**；工具的实际能力仍由 WebView 内核与插件提供。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use super::audit::{self, AuditEntry, AuditOutcome};
use super::latency::{self, Ledger};
use super::protocol::{
    attach_negotiation_meta, check_protocol_version, check_root_id_param,
    check_tool_call_permission, classify_envelope, codes, command_run_audit_note, decode_request,
    filter_tools_list, is_market_tool, negotiate, negotiate_accept, sanitize_string,
    sanitize_untrusted_inplace, validate_params, AcceptKind, JsonRpcResponse, LocalOutcome,
    McpError, McpRequestPayload, McpRespondArgs, McpSessionScope, McpTier, Negotiation,
    RequestEnvelope, WebMethod, MCP_CLIENT_CONNECTED_EVENT, MCP_REQUEST_EVENT, PROTOCOL_VERSION,
};
use super::scope;

/* ============================ DTO / 状态 ============================ */

#[derive(Debug, Clone, Serialize)]
pub struct McpStartResult {
    pub port: u16,
    pub token: String,
    pub endpoint: String,
}

/// `clients` 的语义**只是瞬时并发 TCP 连接数**（`Connection: close` 后即减），
/// 不能拿来回答「客户端接上了没」。下面三个 additive 字段把三个读数拆开：
/// - `connections`：本次运行时内**已握手**过的去重 clientId 数（真源＝内存接入台账）；
/// - `authorizedSessions`：第四张授权表里未撤销的会话数（授权 ≠ 连接）；
/// - `discoveryPath`：发现文件真实路径（供 UI 展示 / 复制 / 打开目录；不含 token）。
/// 旧三字段逐字不变、零改名；旧消费方只读前三格时行为零变化。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub enabled: bool,
    pub port: Option<u16>,
    pub clients: usize,
    pub connections: usize,
    pub authorized_sessions: usize,
    pub discovery_path: String,
}

/// 接入台账容量上限（按 clientId 去重，超出淘汰最旧）。纯内存、随运行时存活，
/// 不写盘、不复用 `mcp_audit.jsonl`（避免污染审计契约、给 `initialize` 热路径添 I/O，
/// 也避免 token 轮换后残留 clientId 冒充「还连着」）。
pub const CONNECTION_LEDGER_CAP: usize = 64;

/// 一条接入回执：谁、何时、用哪个 method 首次（或最近一次）触达端点。
/// 字段全部来自已鉴权请求的受限标识，绝不含 token / 请求体 / 任意路径。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConnect {
    pub client_id: String,
    pub ts: String,
    pub method: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EndpointFile {
    pub port: u16,
    pub token: String,
    pub endpoint: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveArgs {
    pub client_id: String,
    pub tier: String,
    #[serde(default)]
    pub approved_roots: Vec<String>,
    #[serde(default)]
    pub approved_tools: Vec<String>,
    /// additive（2026-11-06 写域多根）：人在设置页逐项勾选的常驻根枚举标识。
    #[serde(default)]
    pub approved_root_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeArgs {
    pub client_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditQueryArgs {
    #[serde(default)]
    pub limit: Option<usize>,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Limits {
    pub max_header_bytes: usize,
    pub max_body_bytes: usize,
    pub max_response_bytes: usize,
    pub request_timeout: Duration,
    pub max_calls_per_minute: u32,
    pub max_concurrent: usize,
    /// 跨连接共享的**在途 WebView 调用**预算（B5 batch 并发批新增）。
    ///
    /// 默认值与 `max_concurrent` 同数（8）：改的是**计数口径**而不是额度——
    /// 旧行为「8 条连接 × 每连接 1 枚在途」= 最坏 8 枚在途；新行为「任意来源合起来
    /// 最多 8 枚在途」。并发派发因此**不可能**比改前给 WebView 更大压力。
    pub max_inflight_calls: usize,
    /// 单次耗时台账每键保留的样本数（读数窗口；不改变任何判定）。
    pub latency_window: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_header_bytes: 16 * 1024,
            max_body_bytes: 1024 * 1024,
            max_response_bytes: 1024 * 1024,
            request_timeout: Duration::from_secs(30),
            max_calls_per_minute: 120,
            max_concurrent: 8,
            max_inflight_calls: 8,
            latency_window: crate::mcp::latency::SAMPLE_WINDOW,
        }
    }
}

/// 单会话速率桶（60s 滚动窗，语义与全局窗逐字一致）。
pub struct RateState {
    pub window_start: Instant,
    pub count: u32,
}

/// 速率闸治理器（B5 吞吐批：全局单计数器 → 按会话计量）。
/// - 每个 `clientId|sessionId` 一个 60s 窗、预算 `max_calls_per_minute`；
/// - 另有一条全局 60s 窗聚合计数，硬顶**就是 `max_calls_per_minute` 本身**——
///   端点每分钟接受的总量与改前（全局单计数器）逐字同值，本批不放宽；
/// - 会话桶只决定「谁先被拒」（公平），不决定「一共接受多少」（总量）；
/// - 全局窗到期即清空全部会话桶，故**在跟踪的会话数天然被全局预算界住**（每个新会话
///   至少消耗 1 个全局名额 ⇒ 会话桶数 ≤ 全局预算），无需额外上限，也不吃内存。
pub struct RateGovernor {
    pub window_start: Instant,
    pub total: u32,
    pub sessions: HashMap<String, RateState>,
}

impl Default for RateGovernor {
    fn default() -> Self {
        Self {
            window_start: Instant::now(),
            total: 0,
            sessions: HashMap::new(),
        }
    }
}

pub struct BridgeReply {
    pub ok: bool,
    pub result: Option<Value>,
    pub error: Option<McpError>,
}

pub struct Pending {
    pub tx: Sender<BridgeReply>,
    /// 客户端 JSON-RPC id（供 `notifications/cancelled` 反查）。
    pub rpc_id: Value,
    pub method: String,
    pub tool_name: Option<String>,
    /// 派发起点：应答落账 / 超时 / 取消 / token 轮换都在此处算 `elapsed`，
    /// 进耗时台账与审计行（B5 起是真源读数，不再 `dead_code`）。
    pub started: Instant,
    /// 在途预算凭据：`Pending` 一出路由表（应答到达 / 超时 / 取消 / 停服）即释放，
    /// 于是「在途」的口径就是「WebView 尚未回帧」，不会晚释放、也不会漏释放。
    pub slot: Slot,
}

/* ============================ 在途预算（有界 semaphore） ============================ */

/// 跨连接共享的在途 WebView 调用预算。
///
/// 为什么需要第二道闸：`max_concurrent` 按**连接数**计数，一条连接一次只压一枚
/// 请求；batch 并发派发后，单条 HTTP 请求就能把 N 枚调用同时打进 WebView，
/// 连接闸看不见这件事。预算默认与 `max_concurrent` 同数（见 `Limits` 注释），
/// 所以改的是口径不是额度：**并发不会带来比改前更大的 WebView 压力**。
///
/// 超预算不静默排队：`acquire` 只在**该条信封自己的 `request_timeout` 死线**内等位，
/// 等不到 ⇒ 调用方拿到 `None`，必须回一条显式 `E_CALL_BUDGET_EXCEEDED`（可见拒绝、
/// 不丢帧）；等待与拒绝各自计数，随 `mcp_latency_query` 出账。
pub struct CallBudget {
    in_flight: AtomicUsize,
    max: usize,
    /// 唤醒协议：释放侧先在 `in_flight` 减一，再在锁内抬世代号并 `notify_all`。
    /// 等待侧「持锁读世代 → try_acquire → wait_timeout」，两者交错不会丢唤醒；
    /// 另有 `BUDGET_POLL` 兜底，锁中毒退化成短轮询时也不会永久卡住。
    generation: Mutex<u64>,
    cond: std::sync::Condvar,
    waits: AtomicU64,
    rejections: AtomicU64,
    peak: AtomicUsize,
}

/// 锁通知丢失的兜底轮询间隔（只在 `notify_all` 万一没赶上时用）。
const BUDGET_POLL: Duration = Duration::from_millis(50);

impl CallBudget {
    pub fn new(max: usize) -> Self {
        Self {
            in_flight: AtomicUsize::new(0),
            max: max.max(1),
            generation: Mutex::new(0),
            cond: std::sync::Condvar::new(),
            waits: AtomicU64::new(0),
            rejections: AtomicU64::new(0),
            peak: AtomicUsize::new(0),
        }
    }

    /// 有空位就取，没有立即回 `None`（不阻塞）。`Arc` 形态：凭据要能独立归还。
    pub fn try_acquire(self: &Arc<Self>) -> Option<Slot> {
        let cur = self.in_flight.load(Ordering::SeqCst);
        if cur >= self.max {
            return None;
        }
        match self
            .in_flight
            .compare_exchange(cur, cur + 1, Ordering::SeqCst, Ordering::SeqCst)
        {
            Ok(_) => {
                self.peak.fetch_max(cur + 1, Ordering::SeqCst);
                Some(Slot {
                    budget: Some(Arc::clone(self)),
                })
            }
            Err(_) => None,
        }
    }

    /// 等到空位或死线到期；到期 ⇒ `None`（调用方必须显式拒绝该条，不许静默吞帧）。
    pub fn acquire(self: &Arc<Self>, deadline: Instant) -> Option<Slot> {
        if let Some(s) = self.try_acquire() {
            return Some(s);
        }
        self.waits.fetch_add(1, Ordering::SeqCst);
        loop {
            let now = Instant::now();
            if now >= deadline {
                self.rejections.fetch_add(1, Ordering::SeqCst);
                return None;
            }
            // 先取锁再 try_acquire：释放侧的「减一 → 抬世代 → notify」与本侧交错时，
            // 要么 try_acquire 直接成功，要么 notify 落在 wait_timeout 之后被收到。
            let observed = match self.generation.lock() {
                Ok(g) => *g,
                Err(_) => {
                    std::thread::sleep(BUDGET_POLL);
                    if let Some(s) = self.try_acquire() {
                        return Some(s);
                    }
                    continue;
                }
            };
            if let Some(s) = self.try_acquire() {
                return Some(s);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let wait_for = if remaining > BUDGET_POLL {
                BUDGET_POLL
            } else {
                remaining
            };
            if remaining.is_zero() {
                self.rejections.fetch_add(1, Ordering::SeqCst);
                return None;
            }
            if let Ok(guard) = self.generation.lock() {
                let _ = self
                    .cond
                    .wait_timeout_while(guard, wait_for, |g| *g == observed);
            }
        }
    }

    fn release(&self) {
        let cur = self.in_flight.load(Ordering::SeqCst);
        if cur == 0 {
            return; // 不该发生（Drop 与 Pending 一对一）；真发生了也不许减成负数下溢
        }
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        if let Ok(mut g) = self.generation.lock() {
            *g = g.wrapping_add(1);
            self.cond.notify_all();
        }
    }

    pub fn snapshot(&self) -> Value {
        json!({
            "max": self.max,
            "inFlight": self.in_flight.load(Ordering::SeqCst),
            "peak": self.peak.load(Ordering::SeqCst),
            "waits": self.waits.load(Ordering::SeqCst),
            "rejections": self.rejections.load(Ordering::SeqCst),
        })
    }
}

/// `CallBudget` 的凭据：`Drop` 即归还一个空位。持有者 = `Pending`（在途期间）。
pub struct Slot {
    budget: Option<Arc<CallBudget>>,
}

impl Slot {
    /// 显式归还空位（幂等）：应答到达时由 `deliver_shared` 调用，让「释放点」写在
    /// 代码里而不是只靠隐式 `Drop`；超时 / 取消 / 停服路径仍由 `Drop` 兜底。
    pub fn release(&mut self) {
        if let Some(b) = self.budget.take() {
            b.release();
        }
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.release();
    }
}

/// WebView 桥抽象：六种能力方法经此转发（生产 = Tauri 事件；端点级测试可注入桩，
/// 免构造 Tauri 运行时即可起真实 listener）。
pub trait McpBridge: Send + Sync + 'static {
    fn emit_request(&self, payload: McpRequestPayload) -> Result<(), String>;
    /// additive：接入事件默认空实现，端点级测试桩无需被迫实现；台账查询是唯一真源。
    fn emit_connected(&self, _payload: ClientConnect) -> Result<(), String> {
        Ok(())
    }
}

/// 生产桥：`"mcp://request"` Tauri 事件（WebView 侧 host-bridge 收，回 `mcp_respond`）。
pub struct TauriBridge(pub AppHandle);

impl McpBridge for TauriBridge {
    fn emit_request(&self, payload: McpRequestPayload) -> Result<(), String> {
        self.0
            .emit(MCP_REQUEST_EVENT, payload)
            .map_err(|e| e.to_string())
    }
    fn emit_connected(&self, payload: ClientConnect) -> Result<(), String> {
        self.0
            .emit(MCP_CLIENT_CONNECTED_EVENT, payload)
            .map_err(|e| e.to_string())
    }
}

pub struct McpShared {
    pub bridge: Arc<dyn McpBridge>,
    /// 可轮换：令牌随运行时生命周期存活——`stop` / 退出即随运行时一起作废，下一次
    /// `start` 由 `rotate_token_parts` 铸新 token 并重写发现文件；旧 token 立即失效。
    pub token: Mutex<String>,
    pub pending: Mutex<HashMap<String, Pending>>,
    pub seq: AtomicU64,
    pub clients: AtomicUsize,
    pub shutdown: Arc<AtomicBool>,
    /// 第四张表的内存镜像（审批命令写穿后同步刷新）。
    pub scope_state: Mutex<scope::McpScopeState>,
    pub app_data_dir: PathBuf,
    pub limits: Limits,
    pub rate: Mutex<RateGovernor>,
    /// 跨连接共享的在途 WebView 调用预算（`Limits::max_inflight_calls`）。
    pub budget: Arc<CallBudget>,
    /// 逐请求耗时台账（真源 = `Pending.started`）。
    pub latency: Mutex<Ledger>,
    /// 有界内存接入台账（最新在前，按 clientId 去重）；随运行时存活，stop / 重启清空。
    pub connections: Mutex<VecDeque<ClientConnect>>,
}

pub struct McpRuntime {
    pub port: u16,
    pub token: String,
    pub endpoint: String,
    pub shared: Arc<McpShared>,
    pub handle: Option<std::thread::JoinHandle<()>>,
}

/// Tauri `manage` 的宿主状态。
pub struct McpState {
    pub runtime: Mutex<Option<McpRuntime>>,
}

impl Default for McpState {
    fn default() -> Self {
        Self {
            runtime: Mutex::new(None),
        }
    }
}

/* ============================ 生命周期 ============================ */

fn lock_err() -> McpError {
    McpError::new(codes::INTERNAL, "MCP 状态锁污染")
}

/// 32 字节 CSPRNG → hex（64 字符）。
fn generate_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    let mut rng = rand::rng();
    rng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn write_discovery(app_data_dir: &Path, file: &EndpointFile) -> Result<(), McpError> {
    std::fs::create_dir_all(app_data_dir)
        .map_err(|e| McpError::new(codes::INTERNAL, format!("建发现目录失败：{e}")))?;
    let text = serde_json::to_string_pretty(file)
        .map_err(|e| McpError::new(codes::INTERNAL, format!("序列化发现文件失败：{e}")))?;
    let tmp = app_data_dir.join(format!(".{}.tmp", scope::ENDPOINT_FILE));
    std::fs::write(&tmp, text)
        .map_err(|e| McpError::new(codes::INTERNAL, format!("写发现文件暂存失败：{e}")))?;
    std::fs::rename(&tmp, scope::endpoint_path(app_data_dir))
        .map_err(|e| McpError::new(codes::INTERNAL, format!("落发现文件失败：{e}")))?;
    Ok(())
}

pub fn remove_discovery(app_data_dir: &Path) {
    match std::fs::remove_file(scope::endpoint_path(app_data_dir)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => eprintln!("[mcp] 删除发现文件失败：{e}"),
    }
}

/// 轮换 token（也用于 `start` 的首次签发）：换发新凭据、取消全部在途请求（旧会话
/// 作废）、从盘上重载第四张表（内存里未落盘的旧授权失效）、重写发现文件。
/// 不依赖 `AppHandle`，便于端点级单测直接喂临时目录。
pub fn rotate_token_parts(
    token: &Mutex<String>,
    pending: &Mutex<HashMap<String, Pending>>,
    scope_mirror: &Mutex<scope::McpScopeState>,
    app_data_dir: &Path,
    port: u16,
    endpoint: &str,
) -> Result<String, McpError> {
    // 先复验第四张表：损坏 / 版本不符直接显式报错，不在半轮换态继续服务。
    let fresh = scope::load(app_data_dir)?;
    let next = generate_token();
    *token.lock().map_err(|_| lock_err())? = next.clone();
    if let Ok(mut pending) = pending.lock() {
        for (_id, p) in pending.drain() {
            let _ = p.tx.send(BridgeReply {
                ok: false,
                result: None,
                error: Some(McpError::new(codes::CANCELLED, "token 已轮换，旧会话作废")),
            });
        }
    }
    if let Ok(mut mirror) = scope_mirror.lock() {
        *mirror = fresh;
    }
    write_discovery(
        app_data_dir,
        &EndpointFile {
            port,
            token: next.clone(),
            endpoint: endpoint.to_string(),
        },
    )?;
    Ok(next)
}

pub fn start(
    bridge: Arc<dyn McpBridge>,
    app_data_dir: PathBuf,
    state: &McpState,
) -> Result<McpStartResult, McpError> {
    start_with(bridge, app_data_dir, state, Limits::default())
}

/// `Limits` 可注入的同一条启动路径（端点级测试用它把超时/预算调小，
/// 走的仍是真实 listener + 真实派发循环；生产只经 `start` 用默认值）。
pub fn start_with(
    bridge: Arc<dyn McpBridge>,
    app_data_dir: PathBuf,
    state: &McpState,
    limits: Limits,
) -> Result<McpStartResult, McpError> {
    let mut guard = state.runtime.lock().map_err(|_| lock_err())?;
    if let Some(rt) = guard.as_ref() {
        return Ok(McpStartResult {
            port: rt.port,
            token: rt.token.clone(),
            endpoint: rt.endpoint.clone(),
        });
    }
    // 只 bind 回环；端口 0 ⇒ OS 动态分配。
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| McpError::new(codes::INTERNAL, format!("绑定回环端口失败：{e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| McpError::new(codes::INTERNAL, format!("取本地端口失败：{e}")))?
        .port();
    let endpoint = format!("http://127.0.0.1:{port}/mcp");
    let budget_max = limits.max_inflight_calls;
    let latency_window = limits.latency_window;
    let shared = Arc::new(McpShared {
        bridge,
        token: Mutex::new(String::new()),
        pending: Mutex::new(HashMap::new()),
        seq: AtomicU64::new(0),
        clients: AtomicUsize::new(0),
        shutdown: Arc::new(AtomicBool::new(false)),
        scope_state: Mutex::new(scope::McpScopeState::default()),
        app_data_dir: app_data_dir.clone(),
        limits,
        rate: Mutex::new(RateGovernor::default()),
        budget: Arc::new(CallBudget::new(budget_max)),
        latency: Mutex::new(Ledger::with_window(latency_window)),
        connections: Mutex::new(VecDeque::with_capacity(CONNECTION_LEDGER_CAP)),
    });
    // 首次签发 = 一次 token 轮换：新 token 生效、第四张表从盘上重载、发现文件写
    // {port,token,endpoint}。轮换后旧 token / 旧会话 / 未落盘的旧授权一律失效。
    let token = rotate_token_parts(
        &shared.token,
        &shared.pending,
        &shared.scope_state,
        &app_data_dir,
        port,
        &endpoint,
    )?;
    let shared_for_thread = Arc::clone(&shared);
    let handle = std::thread::Builder::new()
        .name("kojo-mcp-http".to_string())
        .spawn(move || run_accept_loop(listener, shared_for_thread))
        .map_err(|e| {
            // 线程没起来 ⇒ 端点不存在：别把「发现文件指向死端口」留在盘上。
            remove_discovery(&app_data_dir);
            McpError::new(codes::INTERNAL, format!("启动 HTTP 线程失败：{e}"))
        })?;
    *guard = Some(McpRuntime {
        port,
        token: token.clone(),
        endpoint: endpoint.clone(),
        shared,
        handle: Some(handle),
    });
    Ok(McpStartResult {
        port,
        token,
        endpoint,
    })
}

pub fn stop(state: &McpState) -> Result<(), McpError> {
    let runtime = state.runtime.lock().map_err(|_| lock_err())?.take();
    let Some(mut rt) = runtime else {
        return Ok(());
    };
    rt.shared.shutdown.store(true, Ordering::SeqCst);
    // 循环现在阻塞在 accept 上（B5 收口批：不再 50ms 轮询），所以必须自己敲门把它
    // 顶回来，否则下面的 `join` 会永远等不到退出。
    wake_accept(rt.port);
    if let Some(handle) = rt.handle.take() {
        let _ = handle.join();
    }
    // 给所有在途请求一个明确的 CANCELLED，别让桥永久悬挂。
    if let Ok(mut pending) = rt.shared.pending.lock() {
        for (_id, p) in pending.drain() {
            let _ = p.tx.send(BridgeReply {
                ok: false,
                result: None,
                error: Some(McpError::new(codes::CANCELLED, "服务已停止")),
            });
        }
    }
    // 旧运行时的接入读数随 listener 一起作废：token 轮换 / 重启后不许残留冒充「还连着」。
    if let Ok(mut ledger) = rt.shared.connections.lock() {
        ledger.clear();
    }
    remove_discovery(&rt.shared.app_data_dir);
    Ok(())
}

pub fn status(state: &McpState) -> McpStatus {
    let Ok(guard) = state.runtime.lock() else {
        return McpStatus {
            enabled: false,
            port: None,
            clients: 0,
            connections: 0,
            authorized_sessions: 0,
            discovery_path: String::new(),
        };
    };
    match guard.as_ref() {
        Some(rt) => McpStatus {
            enabled: true,
            port: Some(rt.port),
            clients: rt.shared.clients.load(Ordering::SeqCst),
            connections: connection_snapshot(&rt.shared).len(),
            authorized_sessions: rt
                .shared
                .scope_state
                .lock()
                .map(|s| s.sessions.iter().filter(|g| g.revoked_at.is_none()).count())
                .unwrap_or(0),
            // 只回「固定文件名拼接出的本机路径」，不回 token、不收客户端给的目标路径。
            discovery_path: scope::endpoint_path(&rt.shared.app_data_dir)
                .to_string_lossy()
                .to_string(),
        },
        None => McpStatus {
            enabled: false,
            port: None,
            clients: 0,
            connections: 0,
            authorized_sessions: 0,
            discovery_path: String::new(),
        },
    }
}

/// 接入台账快照（最新在前）。锁污染显式回落空表，不 panic、不编造读数。
pub fn connection_snapshot(shared: &Arc<McpShared>) -> Vec<ClientConnect> {
    shared
        .connections
        .lock()
        .map(|c| c.iter().cloned().collect())
        .unwrap_or_default()
}

/// 宿主侧查询（`mcp_connections_query`）：服务没起时显式报错，不回空表冒充「零接入」。
pub fn connections_query(state: &McpState) -> Result<Vec<ClientConnect>, McpError> {
    let guard = state.runtime.lock().map_err(|_| lock_err())?;
    let Some(rt) = guard.as_ref() else {
        return Err(McpError::new(
            codes::BRIDGE_UNAVAILABLE,
            "MCP 服务未启动（接入台账随运行时存活，启动后才有读数）",
        ));
    };
    Ok(connection_snapshot(&rt.shared))
}

/// 记一笔已鉴权触达：**同 clientId 去重**（刷新 ts / method），新客户端返回 `Some` 供
/// 调用方 emit 首次握手事件（toast 不刷屏）；超出 cap 淘汰最旧。
///
/// 只在 `authenticate` 通过之后调用；method 是线协议上的不可信字符串，先消毒 + 截长。
/// 台账是唯一真源：emit 失败不影响它，前端查询 / 轮询照样能拿到正面读数。
pub fn note_client_connect(
    shared: &Arc<McpShared>,
    client_id: &str,
    method: &str,
) -> Option<ClientConnect> {
    let entry = ClientConnect {
        client_id: sanitize_string(client_id, 128),
        ts: crate::launcher::iso_now(),
        method: sanitize_string(method, 64),
    };
    let Ok(mut ledger) = shared.connections.lock() else {
        return None;
    };
    if let Some(existing) = ledger.iter_mut().find(|c| c.client_id == entry.client_id) {
        existing.ts = entry.ts;
        existing.method = entry.method;
        return None;
    }
    ledger.push_front(entry.clone());
    while ledger.len() > CONNECTION_LEDGER_CAP {
        ledger.pop_back();
    }
    Some(entry)
}

/// `mcp_respond`：按内部 request id 从路由表取出等待者并回填；id 未知显式报错。
pub fn deliver(state: &McpState, args: McpRespondArgs) -> Result<(), McpError> {
    let shared = {
        let guard = state.runtime.lock().map_err(|_| lock_err())?;
        guard.as_ref().map(|rt| Arc::clone(&rt.shared))
    };
    let shared =
        shared.ok_or_else(|| McpError::new(codes::BRIDGE_UNAVAILABLE, "MCP 服务未启动"))?;
    deliver_shared(&shared, args)
}

/// `deliver` 的免 `McpState` 形态：走**同一把**台账与**同一条** slot 归还路径。
/// 端点级测试的自动应答桥（`WebView` 桩）经此回填，因此量到的就是生产派发循环本身。
pub fn deliver_shared(shared: &Arc<McpShared>, args: McpRespondArgs) -> Result<(), McpError> {
    let pending = shared
        .pending
        .lock()
        .map_err(|_| lock_err())?
        .remove(&args.id);
    let mut p = pending.ok_or_else(|| {
        McpError::new(
            codes::INVALID_REQUEST,
            format!("未知或已过期的请求 id：{}", args.id),
        )
    })?;
    // 应答到达即归还在途凭据：显式取用 `Pending.slot`（释放点写在代码里，
    // 与「回帧＝不再在途」同一口径），超时 / 取消 / 停服路径由该字段的 `Drop` 兜底。
    p.slot.release();
    p.tx.send(BridgeReply {
        ok: args.ok,
        result: args.result,
        error: args.error,
    })
    .map_err(|_| McpError::new(codes::BRIDGE_UNAVAILABLE, "等待方已离开"))?;
    Ok(())
}

/// 耗时台账 + 在途预算读数（`mcp_latency_query`）：只读、只由宿主侧调用，
/// MCP 客户端在协议里够不到这条命令（与审计查询同一纵深）。
pub fn latency_query(state: &McpState) -> Result<Value, McpError> {
    let guard = state.runtime.lock().map_err(|_| lock_err())?;
    let Some(rt) = guard.as_ref() else {
        return Err(McpError::new(
            codes::BRIDGE_UNAVAILABLE,
            "MCP 服务未启动（台账随运行时存活，启动后才有读数）",
        ));
    };
    Ok(latency_snapshot(&rt.shared))
}

/// 台账快照的可复用形态（端点级测试直接读 `Arc<McpShared>` 也走这里，口径唯一）。
pub fn latency_snapshot(shared: &Arc<McpShared>) -> Value {
    let ledger = match shared.latency.lock() {
        Ok(l) => l.to_json(),
        Err(_) => json!({ "error": "耗时台账锁污染" }),
    };
    let pending = shared.pending.lock().map(|p| p.len()).unwrap_or_default();
    json!({
        "limits": {
            "requestTimeoutMs": shared.limits.request_timeout.as_millis() as u64,
            "maxCallsPerMinute": shared.limits.max_calls_per_minute,
            "maxConcurrentConnections": shared.limits.max_concurrent,
            "maxInflightCalls": shared.limits.max_inflight_calls,
        },
        "budget": shared.budget.snapshot(),
        "pendingNow": pending,
        "clientsNow": shared.clients.load(Ordering::SeqCst),
        "latency": ledger,
    })
}

/// 一次批量审批（WebView 侧调用，MCP 客户端无此入口）：写第四张表 + 刷新内存镜像。
pub fn approve_session(
    app: &AppHandle,
    state: &McpState,
    args: ApproveArgs,
) -> Result<scope::McpScopeState, McpError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| McpError::new(codes::INTERNAL, format!("app_data_dir：{e}")))?;
    let tier = McpTier::parse(&args.tier)
        .ok_or_else(|| McpError::new(codes::INVALID_PARAMS, "tier 非法"))?;
    let new_state = scope::approve_with_root_ids(
        &dir,
        &args.client_id,
        tier,
        args.approved_roots,
        args.approved_tools,
        args.approved_root_ids,
    )?;
    if let Ok(guard) = state.runtime.lock() {
        if let Some(rt) = guard.as_ref() {
            if let Ok(mut mirror) = rt.shared.scope_state.lock() {
                *mirror = new_state.clone();
            }
        }
    }
    Ok(new_state)
}

pub fn revoke_session(
    app: &AppHandle,
    state: &McpState,
    args: RevokeArgs,
) -> Result<scope::McpScopeState, McpError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| McpError::new(codes::INTERNAL, format!("app_data_dir：{e}")))?;
    let new_state = scope::revoke(&dir, &args.client_id)?;
    if let Ok(guard) = state.runtime.lock() {
        if let Some(rt) = guard.as_ref() {
            if let Ok(mut mirror) = rt.shared.scope_state.lock() {
                *mirror = new_state.clone();
            }
        }
    }
    Ok(new_state)
}

pub fn scope_query(app: &AppHandle) -> Result<scope::McpScopeState, McpError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| McpError::new(codes::INTERNAL, format!("app_data_dir：{e}")))?;
    scope::load(&dir)
}

pub fn audit_query(app: &AppHandle, args: AuditQueryArgs) -> Result<Vec<AuditEntry>, McpError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| McpError::new(codes::INTERNAL, format!("app_data_dir：{e}")))?;
    audit::query(&dir, args.limit.unwrap_or(50), args.client_id.as_deref())
}

/* ============================ HTTP 层 ============================ */

#[derive(Debug, Clone)]
pub struct HttpHead {
    pub method: String,
    pub target: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

/// 纯函数：解析请求行 + 头（键小写化），供单测直接喂文本。
pub fn parse_head_text(text: &str) -> Result<(String, String, HashMap<String, String>), McpError> {
    let mut lines = text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| McpError::new(codes::INVALID_REQUEST, "请求行缺失"))?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| McpError::new(codes::INVALID_REQUEST, "请求方法缺失"))?
        .to_string();
    let target = parts
        .next()
        .ok_or_else(|| McpError::new(codes::INVALID_REQUEST, "请求目标缺失"))?
        .to_string();
    let version = parts.next().unwrap_or("");
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return Err(McpError::new(codes::INVALID_REQUEST, "仅支持 HTTP/1.x"));
    }
    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (key, value) = line
            .split_once(':')
            .ok_or_else(|| McpError::new(codes::INVALID_REQUEST, "请求头形状非法"))?;
        headers.insert(key.trim().to_lowercase(), value.trim().to_string());
    }
    Ok((method, target, headers))
}

pub fn read_head(stream: &mut TcpStream, limits: &Limits) -> Result<HttpHead, McpError> {
    let mut buf: Vec<u8> = Vec::new();
    let mut one = [0u8; 1];
    loop {
        if buf.len() > limits.max_header_bytes {
            return Err(McpError::new(codes::INVALID_REQUEST, "请求头超限"));
        }
        let n = stream
            .read(&mut one)
            .map_err(|e| McpError::new(codes::INVALID_REQUEST, format!("读请求头失败：{e}")))?;
        if n == 0 {
            return Err(McpError::new(codes::INVALID_REQUEST, "连接提前关闭"));
        }
        buf.push(one[0]);
        if buf.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let head_end = buf.len() - 4;
    let text = String::from_utf8_lossy(&buf[..head_end]);
    let (method, target, headers) = parse_head_text(&text)?;
    let content_length: usize = headers
        .get("content-length")
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0);
    if content_length > limits.max_body_bytes {
        return Err(McpError::new(codes::RESPONSE_TOO_LARGE, "请求体超限"));
    }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < content_length {
        let mut chunk = [0u8; 4096];
        let n = stream
            .read(&mut chunk)
            .map_err(|e| McpError::new(codes::INVALID_REQUEST, format!("读请求体失败：{e}")))?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    if body.len() < content_length {
        return Err(McpError::new(codes::INVALID_REQUEST, "请求体不完整"));
    }
    body.truncate(content_length);
    Ok(HttpHead {
        method,
        target,
        headers,
        body,
    })
}

/// 常数时间比较，避免 token 逐字节时序泄漏。
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Origin 白名单：只放行 http 回环 `127.0.0.1` / `localhost`（含大小写与单个尾点）
/// / IPv6 回环 `::1`（含展开写法）。userinfo、非数字端口、IPv4-mapped 形态、
/// 十进制/十六进制 IP 变体、DNS 后缀伪装一律拒（三缺一不可里的 Origin 闸）。
/// 注意：这只校验请求头；服务端**只 bind 127.0.0.1**，不因此放宽。
pub fn check_origin(origin: Option<&str>) -> Result<(), McpError> {
    let deny = |why: &str| -> Result<(), McpError> {
        Err(McpError::new(
            codes::FORBIDDEN_ORIGIN,
            format!("Origin 不在白名单（{why}）：{}", origin.unwrap_or("")),
        ))
    };
    let raw = origin
        .ok_or_else(|| McpError::new(codes::FORBIDDEN_ORIGIN, "缺少 Origin 头（三缺一不可）"))?;
    let rest = raw
        .strip_prefix("http://")
        .ok_or_else(|| McpError::new(codes::FORBIDDEN_ORIGIN, "Origin 只放行 http 回环"))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return deny("authority 为空");
    }
    // `http://127.0.0.1:port@evil.example` 之类 userinfo 伪装必须拒。
    if authority.contains('@') {
        return deny("不接受 userinfo");
    }
    let (host, port) = if authority.starts_with('[') {
        let end = authority
            .find(']')
            .ok_or_else(|| McpError::new(codes::FORBIDDEN_ORIGIN, "IPv6 Origin 缺右括号"))?;
        let host = &authority[1..end];
        let tail = &authority[end + 1..];
        let port = if tail.is_empty() {
            None
        } else {
            Some(tail.strip_prefix(':').ok_or_else(|| {
                McpError::new(codes::FORBIDDEN_ORIGIN, "IPv6 Origin 端口形状非法")
            })?)
        };
        (host.to_string(), port)
    } else {
        let mut it = authority.splitn(2, ':');
        let h = it.next().unwrap_or("").to_ascii_lowercase();
        (h, it.next())
    };
    if let Some(p) = port {
        if p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return deny("端口非数字或过长");
        }
    }
    let lower = host.to_ascii_lowercase();
    if lower == "127.0.0.1" || lower == "localhost" || lower == "localhost." {
        return Ok(());
    }
    // 回环 IPv6 变体：只认 std 判定为 loopback 的地址（`::1` / 展开写法），
    // IPv4-mapped `::ffff:127.0.0.1` 不在此列。
    if let Ok(ip) = lower.parse::<Ipv6Addr>() {
        if ip.is_loopback() {
            return Ok(());
        }
    }
    deny("非回环主机")
}

/// 三缺一不可：回环 + Bearer token + Origin 白名单。
pub fn authenticate(head: &HttpHead, token: &str, peer: SocketAddr) -> Result<(), McpError> {
    if !peer.ip().is_loopback() {
        return Err(McpError::new(codes::UNAUTHORIZED, "仅回环"));
    }
    let auth = head
        .headers
        .get("authorization")
        .ok_or_else(|| McpError::new(codes::UNAUTHORIZED, "缺少 Authorization"))?;
    let presented = auth
        .strip_prefix("Bearer ")
        .ok_or_else(|| McpError::new(codes::UNAUTHORIZED, "Authorization 必须是 Bearer"))?;
    if !constant_time_eq(presented.as_bytes(), token.as_bytes()) {
        return Err(McpError::new(codes::UNAUTHORIZED, "Bearer token 不匹配"));
    }
    check_origin(head.headers.get("origin").map(String::as_str))
}

/// 速率闸会话键：**只取请求头**（`X-Mcp-Client-Id` + `Mcp-Session-Id`），在 decode 请求体
/// 之前即可算出——保住"先拒后再解析"的 DoS 顺序。两者皆缺时归一个共享兜底键（匿名流量
/// 仍共账、仍受全局预算约束，绝不因"没有会话头"而绕过速率闸）。
pub fn rate_session_key(head: &HttpHead) -> String {
    let client = head
        .headers
        .get("x-mcp-client-id")
        .map(|s| s.trim())
        .unwrap_or("");
    let session = session_id_from_head(head);
    format!(
        "{}\u{1f}{}",
        if client.is_empty() { "" } else { client },
        session
    )
}

/// 审计用的客户端标签（**不落任何凭据值**）：只取 `X-Mcp-Client-Id` 头，缺省与
/// `client_identity` 的兜底名同字（`loopback-client`），并过一遍 `validate_client_id`
/// 的长度/控制字符口径，超长或非法一律退成兜底名——审计行不许被客户端塞任意文本。
fn header_client_id(head: &HttpHead) -> String {
    let raw = head
        .headers
        .get("x-mcp-client-id")
        .map(|s| s.trim())
        .unwrap_or("");
    if !raw.is_empty() && scope::validate_client_id(raw).is_ok() {
        raw.to_string()
    } else {
        "loopback-client".to_string()
    }
}

/// 按会话速率闸（B5 吞吐批，替换旧全局单计数器）。返回 Ok 已把该会话与全局各计 1。
/// 命中显式 `E_RATE_LIMITED`（不静默丢帧）。60s 窗语义保持：会话窗与全局窗各自独立归零。
pub fn check_rate(
    gov: &Mutex<RateGovernor>,
    limits: &Limits,
    session_key: &str,
) -> Result<(), McpError> {
    let mut g = gov.lock().map_err(|_| lock_err())?;
    // 全局窗：到期即整体清零（连会话桶一起回收，故被跟踪会话数天然受全局预算界住）。
    if g.window_start.elapsed() >= Duration::from_secs(60) {
        g.window_start = Instant::now();
        g.total = 0;
        g.sessions.clear();
    }
    // 全局硬顶＝`max_calls_per_minute` 本身：**端点每分钟接受的总量与改前逐字同值**。
    // （工作树里曾写成 `max_concurrent × max_calls_per_minute`＝960/分，那是在没有实测
    // 依据的情况下把端点总量闸放宽 8 倍，本批按红线收回；会话级桶只改「谁被拒」，
    // 不改「一共接受多少」。真要抬全局顶，得单独立批带证据。）
    let global_budget = limits.max_calls_per_minute;
    if g.total >= global_budget {
        return Err(McpError::new(codes::RATE_LIMITED, "端点总速率超限"));
    }
    // 会话窗：独立 60s 滚动，预算＝max_calls_per_minute。
    let now = Instant::now();
    let entry = g
        .sessions
        .entry(session_key.to_string())
        .or_insert(RateState {
            window_start: now,
            count: 0,
        });
    if entry.window_start.elapsed() >= Duration::from_secs(60) {
        entry.window_start = now;
        entry.count = 0;
    }
    if entry.count >= limits.max_calls_per_minute {
        return Err(McpError::new(codes::RATE_LIMITED, "会话速率超限"));
    }
    entry.count += 1;
    g.total += 1;
    Ok(())
}

/// Accept 循环（`pub(crate)` 供端点级测试直接驱动真实 listener；行为与生产一致）。
pub(crate) fn run_accept_loop(listener: TcpListener, shared: Arc<McpShared>) {
    // **阻塞式 accept**（B5 收口批实测修复）：旧形态是「nonblocking + 50ms 轮询」，
    // 于是每一条**新连接**都要等下一个轮询 tick 才被接住——实测单条 `tools/call`
    // p50 = 50.5ms，而同笔在端点台账里自报只有 ~3ms ⇒ 那 47ms 全花在 accept 之前；
    // 它按连接数交、不按请求数交（batch 20 条只交一次），正是本期最大的那堵墙。
    // 退出不再靠轮询：`stop` 先置 `shutdown` 再自连一次（`wake_accept`）把阻塞中的
    // accept 顶回来，循环顶部复核标志后退出。空连接在 `handle_connection` 读到 EOF
    // 即返回，不留悬挂线程。真错误（非 WouldBlock）才退避 50ms，避免刷循环。
    while !shared.shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, peer)) => {
                let s = Arc::clone(&shared);
                if let Err(e) = std::thread::Builder::new()
                    .name("kojo-mcp-conn".to_string())
                    .spawn(move || handle_connection(stream, peer, s))
                {
                    eprintln!("[mcp] 连接线程创建失败：{e}");
                }
            }
            Err(e) => {
                if shared.shutdown.load(Ordering::SeqCst) {
                    break;
                }
                eprintln!("[mcp] accept 失败：{e}");
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

/// 唤醒阻塞在 `accept` 上的循环线程：连上即断（`stop` 已置 `shutdown`，那一侧
/// accept 返回后立刻在循环顶部退出）。连不上也不算事故——那只会是循环已经自己退出。
fn wake_accept(port: u16) {
    let _ = std::net::TcpStream::connect(("127.0.0.1", port));
}

struct ConnCtx<'a> {
    shared: &'a Arc<McpShared>,
    client_id: &'a str,
    session_id: &'a str,
    /// 连接起点（含请求头读取）：`http#方法` 键的墙钟真源，与 `bridge#` 键的差
    /// 就是「端点自身开销」（解析 + 台账 + 派发循环 + 序列化）。
    conn_started: Instant,
    /// 本条连接的速率闸会话键（`rate_session_key`，只取请求头）：batch 里第 2 条起
    /// 逐条另计时用的就是同一个键——同一连接的配额账只有一本，不许因 batch 而分账。
    rate_key: String,
}

fn handle_connection(mut stream: TcpStream, peer: SocketAddr, shared: Arc<McpShared>) {
    let conn_started = Instant::now();
    let _ = stream.set_read_timeout(Some(shared.limits.request_timeout));
    let _ = stream.set_write_timeout(Some(shared.limits.request_timeout));
    // 关掉 Nagle：本端点是「一问一答 + 立即关闭」的小报文形状，Nagle 只会让响应段
    // 等对端的延迟确认。**注意这不是那 47ms 的来源**——大头在 accept 轮询，见
    // `run_accept_loop`；这一格与 `write_http` 的合并写出只体现在并发吞吐段（见该函数注释）。
    let _ = stream.set_nodelay(true);
    if !peer.ip().is_loopback() {
        let _ = write_error_http(
            &mut stream,
            403,
            &McpError::new(codes::UNAUTHORIZED, "仅回环"),
        );
        return;
    }
    let active = shared.clients.fetch_add(1, Ordering::SeqCst) + 1;
    if active > shared.limits.max_concurrent {
        shared.clients.fetch_sub(1, Ordering::SeqCst);
        let _ = write_error_http(
            &mut stream,
            429,
            &McpError::new(codes::RATE_LIMITED, "并发连接超限"),
        );
        return;
    }
    let head = match read_head(&mut stream, &shared.limits) {
        Ok(h) => h,
        Err(e) => {
            let _ = write_error_http(&mut stream, 400, &e);
            shared.clients.fetch_sub(1, Ordering::SeqCst);
            return;
        }
    };
    match process_head(&head, peer, &shared, conn_started) {
        Ok((status, content_type, body)) => {
            let _ = write_http(&mut stream, status, content_type, &body);
        }
        Err(e) => {
            let status = if e.code == codes::UNAUTHORIZED || e.code == codes::FORBIDDEN_ORIGIN {
                403
            } else if e.code == codes::RATE_LIMITED {
                429
            } else {
                400
            };
            let _ = write_error_http(&mut stream, status, &e);
        }
    }
    shared.clients.fetch_sub(1, Ordering::SeqCst);
}

fn process_head(
    head: &HttpHead,
    peer: SocketAddr,
    shared: &Arc<McpShared>,
    conn_started: Instant,
) -> Result<(u16, &'static str, Vec<u8>), McpError> {
    let token = shared.token.lock().map_err(|_| lock_err())?.clone();
    authenticate(head, &token, peer)?;
    if head.method != "POST" {
        return Err(McpError::new(
            codes::INVALID_REQUEST,
            "单端点只接受 POST /mcp",
        ));
    }
    if head.target.split('?').next().unwrap_or("") != "/mcp" {
        return Err(McpError::new(codes::INVALID_REQUEST, "未知端点"));
    }
    // 请求头一致性：`MCP-Protocol-Version` 有就校验（未知版本显式结构化错误），
    // Accept 在 application/json / text/event-stream 之间正确协商。
    check_protocol_version(head.headers.get("mcp-protocol-version").map(String::as_str))?;
    let accept = negotiate_accept(head.headers.get("accept").map(String::as_str))?;
    // 速率闸：按会话计量（B5 吞吐批）。命中显式 E_RATE_LIMITED 且留一条 denied 审计——
    // 绝不静默丢帧。身份只取请求头（decode 之前），保住"先拒后解析"的 DoS 顺序。
    let rate_key = rate_session_key(head);
    if let Err(e) = check_rate(&shared.rate, &shared.limits, &rate_key) {
        let client = header_client_id(head);
        let session = session_id_from_head(head);
        let ctx = ConnCtx {
            shared,
            client_id: &client,
            session_id: &session,
            conn_started,
            rate_key: rate_key.clone(),
        };
        record(
            &ctx,
            "__rate_limit__",
            &Value::Null,
            AuditOutcome::Denied,
            Some(e.code.clone()),
            None,
            None,
        );
        return Err(e);
    }
    let envelopes = decode_request(&head.body)?;
    let first = envelopes
        .first()
        .ok_or_else(|| McpError::new(codes::INVALID_REQUEST, "空请求"))?;
    let (client_id, session_id) = client_identity(head, first);
    // 接入信号：鉴权已过 ⇒ 这一次触达（含本地作答的 `initialize` / `ping`）成为正面证据。
    // 只在**新 clientId 首次出现**时推 UI 事件；台账本身是唯一真源，emit 失败出声但
    // 不把请求放大成故障（前端查询 / 轮询仍拿得到读数）。
    if let Some(entry) = note_client_connect(shared, &client_id, &first.method) {
        if let Err(e) = shared.bridge.emit_connected(entry) {
            eprintln!("[mcp-connect] 接入事件推送失败（台账已记录）：{e}");
        }
    }
    let ctx = ConnCtx {
        shared,
        client_id: &client_id,
        session_id: &session_id,
        conn_started,
        rate_key,
    };
    let responses = run_envelopes(envelopes, &ctx);
    if responses.is_empty() {
        // JSON-RPC 通知不回响应体。
        return Ok((202, "application/json", Vec::new()));
    }
    let value: Value = if responses.len() == 1 {
        serde_json::to_value(&responses[0])
    } else {
        let arr: Result<Vec<Value>, serde_json::Error> =
            responses.iter().map(serde_json::to_value).collect();
        arr.map(Value::Array)
    }
    .map_err(|e| McpError::new(codes::INTERNAL, format!("序列化响应失败：{e}")))?;
    let body = serde_json::to_vec(&value)
        .map_err(|e| McpError::new(codes::INTERNAL, format!("编码响应失败：{e}")))?;
    if body.len() > shared.limits.max_response_bytes {
        let err = McpError::new(codes::RESPONSE_TOO_LARGE, "返回体积超限");
        let resp = JsonRpcResponse::err(Value::Null, &err);
        let small = serde_json::to_vec(&resp).unwrap_or_default();
        return Ok((200, "application/json", small));
    }
    if accept == AcceptKind::Sse {
        // 请求级 SSE：单条 `message` 事件后关闭（Connection: close）。
        let text = String::from_utf8_lossy(&body);
        let frame = format!("event: message\ndata: {text}\n\n");
        Ok((200, "text/event-stream", frame.into_bytes()))
    } else {
        Ok((200, "application/json", body))
    }
}

/// 旧客户端可能带 `Mcp-Session-Id`：无状态服务**安全地接受/忽略**，只把它当作
/// 审计标签（长度/控制字符受限），绝不据此建立或恢复任何会话状态；授权只看
/// 第四张表（按 clientId 签发）。响应里不编造 `Mcp-Session-Id`、不造 sessionId 字段。
pub fn session_id_from_head(head: &HttpHead) -> String {
    head.headers
        .get("mcp-session-id")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && s.len() <= 64 && !s.bytes().any(|b| b.is_ascii_control()))
        .map(str::to_string)
        .unwrap_or_else(|| "stateless".to_string())
}

fn client_identity(head: &HttpHead, first: &RequestEnvelope) -> (String, String) {
    let from_header = head
        .headers
        .get("x-mcp-client-id")
        .map(|s| s.trim())
        .unwrap_or("");
    let from_info = first
        .params
        .get("clientInfo")
        .and_then(|v| v.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let from_meta = first
        .params
        .pointer("/_meta/io.modelcontextprotocol~1clientId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let client_id = [from_header, from_info, from_meta]
        .iter()
        .copied()
        .find(|s| !s.is_empty() && scope::validate_client_id(s).is_ok())
        .map(str::to_string)
        .unwrap_or_else(|| "loopback-client".to_string());
    let session_id = session_id_from_head(head);
    (client_id, session_id)
}

/// batch 派发的一条出口：本地即可定案，或已进 WebView 在途等回帧。
enum Dispatched {
    /// 本地判定 / 闸门即定案（通知 ⇒ `None`，不回帧）。
    Done(Option<JsonRpcResponse>),
    /// 已 `emit_request`，凭 `rx` 等 `mcp_respond` 落账。
    InFlight(PendingCall),
}

/// 在途调用的收帧凭据。
///
/// 在途预算凭据挂在 `Pending.slot` 上（不在这里）：回帧一到、`deliver` 把台账条目
/// 摘走的那一刻就释放，所以预算口径严格等于「WebView 尚未回帧的调用数」。
struct PendingCall {
    /// 在请求数组里的下标：收帧后按原位写回，保证响应数组与请求数组同序。
    index: usize,
    id: Value,
    method: WebMethod,
    params: Value,
    scope: McpSessionScope,
    neg: Negotiation,
    tool_name: Option<String>,
    internal_id: String,
    rx: mpsc::Receiver<BridgeReply>,
    /// 派发起点（与 `Pending.started` 同源）：收帧时算 `elapsedMs` 真读数。
    started: Instant,
    /// 本条的应答死线 = 派发时刻 + `Limits::request_timeout`（改前串行时每条各享
    /// 一份 30 s；并发派发后仍然逐条独立计时，不因排队友的队而延长）。
    deadline: Instant,
}

/// JSON-RPC batch 的派发 / 收帧循环（B5 吞吐批）。
///
/// 改前：`for env in envelopes { handle_envelope(env) }` **串行**——batch 里 N 条就是
/// N 趟 WebView 往返依次排队，一次 HTTP 的墙钟 = N × 单条往返。
/// 改后：先把全部信封**并发派发**（跨连接在途预算 `CallBudget` 约束，取不到位就在本条
/// 死线内有界等位），再按请求顺序收帧。
///
/// 逐条判定不许上移也不许跳过：tier / 第四张表 / `approvedRoots` / 参数闸仍在**每条**
/// 派发里跑；某条被拒不牵连其余条目，拒绝逐条可见（审计 + RPC 错误帧）。
///
/// 配额口径（本批**收紧**）：第 1 条信封的配额仍在 `process_head` 计（与改前逐字一致，
/// 非法帧也照样记账），第 2 条起**另计一格**——改前「一次 HTTP 的 batch 只扣 1 次
/// `max_calls_per_minute`」对并发派发而言是偏松的账，现在 N 条真调用就是 N 格。
fn run_envelopes(envelopes: Vec<RequestEnvelope>, ctx: &ConnCtx) -> Vec<JsonRpcResponse> {
    let total = envelopes.len();
    let mut out: Vec<Option<JsonRpcResponse>> = (0..total).map(|_| None).collect();
    let mut inflight: Vec<PendingCall> = Vec::new();
    for i in 0..total {
        let id = envelopes[i].id.clone().unwrap_or(Value::Null);
        if i > 0 {
            if let Err(e) = check_rate(&ctx.shared.rate, &ctx.shared.limits, &ctx.rate_key) {
                record(
                    ctx,
                    envelopes[i].method.as_str(),
                    &Value::Null,
                    AuditOutcome::Denied,
                    Some(e.code.clone()),
                    None,
                    None,
                );
                out[i] = Some(JsonRpcResponse::err(id, &e));
                continue;
            }
        }
        match dispatch_envelope(&envelopes[i], ctx, i) {
            Dispatched::Done(resp) => out[i] = resp,
            Dispatched::InFlight(call) => inflight.push(call),
        }
    }
    // 收帧：按派发顺序（= 请求顺序）逐条等自己的死线，响应数组与请求数组同序。
    for call in inflight {
        let index = call.index;
        out[index] = Some(collect_call(call, ctx));
    }
    out.into_iter().flatten().collect()
}

fn dispatch_envelope(env: &RequestEnvelope, ctx: &ConnCtx, index: usize) -> Dispatched {
    match classify_envelope(env) {
        LocalOutcome::Respond(resp) => {
            record_http(ctx, &env.method);
            Dispatched::Done(Some(resp))
        }
        LocalOutcome::NoResponse => {
            // 通知无帧；但 `notifications/cancelled` 仍需反查并取消在途请求。
            if env.method == "notifications/cancelled" {
                cancel_pending(&env.params, ctx);
            }
            Dispatched::Done(None)
        }
        LocalOutcome::NeedsBridge(method) => dispatch_webview(method, env, ctx, index),
    }
}

/// 转 WebView 的一条：闸门（scope / 参数 / tier / 工具批准 / 在途预算）逐条判定后派发。
/// 到 `emit_request` 为止**不阻塞等帧**（那是 `collect_call` 的事）。
fn dispatch_webview(
    method: WebMethod,
    env: &RequestEnvelope,
    ctx: &ConnCtx,
    index: usize,
) -> Dispatched {
    let id = env.id.clone().unwrap_or(Value::Null);
    let neg = negotiate(&env.params);
    let scope = match current_scope(ctx) {
        Ok(s) => s,
        Err(e) => {
            record_http(ctx, &env.method);
            return Dispatched::Done(Some(JsonRpcResponse::err(id, &e)));
        }
    };
    // 闸门 1：参数（路径越界 / 落点参数 / 形状）显式报错。
    if let Err(e) = validate_params(method, &env.params) {
        record(
            ctx,
            method.as_str(),
            &env.params,
            AuditOutcome::Denied,
            Some(e.code.clone()),
            None,
            None,
        );
        record_http(ctx, &env.method);
        return Dispatched::Done(Some(JsonRpcResponse::err(id, &e)));
    }
    let tool_name = env
        .params
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string);
    // 闸门 1b：写域多根 `rootId` 的**端点级二次复核**（形状 / 四写腿 / 第四张表
    // 精确批准）。放在工具 tier 闸之前：低 tier 会话带 rootId 也先按根授权面
    // 显式拒绝，不因「工具本就被 tier 挡住」而掩盖 rootId 的可见拒绝。
    if let Err(e) = check_root_id_param(method, &env.params, &scope) {
        record(
            ctx,
            tool_name.as_deref().unwrap_or(method.as_str()),
            &env.params,
            AuditOutcome::Denied,
            Some(e.code.clone()),
            None,
            None,
        );
        record_http(ctx, &env.method);
        return Dispatched::Done(Some(JsonRpcResponse::err(id, &e)));
    }
    // 闸门 2：tools/call 的危险工具（Rust 侧双保险，与 tools/list 过滤同源）。
    // 未获精确授权的 privileged 工具显式拒绝，并写一条审计 denied。
    if method == WebMethod::ToolsCall {
        if let Some(name) = tool_name.as_deref() {
            if let Err(e) = check_tool_call_permission(name, &scope) {
                record(
                    ctx,
                    name,
                    &env.params,
                    AuditOutcome::Denied,
                    Some(e.code.clone()),
                    None,
                    None,
                );
                record_http(ctx, &env.method);
                return Dispatched::Done(Some(JsonRpcResponse::err(id, &e)));
            }
        }
    }
    // 闸门 3：跨连接共享的在途 WebView 调用预算（batch 并发派发的第二道闸）。
    // 取位只等到**本条自己的** `request_timeout` 死线；等不到 ⇒ 显式
    // `E_CALL_BUDGET_EXCEEDED`（可见拒绝，不丢帧、不无界排队、不进 WebView）。
    let wait_started = Instant::now();
    let deadline = wait_started + ctx.shared.limits.request_timeout;
    let Some(slot) = ctx.shared.budget.acquire(deadline) else {
        let err = McpError::new(
            codes::CALL_BUDGET_EXCEEDED,
            format!(
                "在途 WebView 调用预算已满（上限 {}），本条在 {} 内未取到位：改走更小批次的 batch 或稍后重试",
                ctx.shared.limits.max_inflight_calls,
                humantime(ctx.shared.limits.request_timeout)
            ),
        );
        record(
            ctx,
            tool_name.as_deref().unwrap_or(method.as_str()),
            &env.params,
            AuditOutcome::Denied,
            Some(err.code.clone()),
            None,
            Some(wait_started.elapsed().as_millis() as u64),
        );
        record_http(ctx, &env.method);
        return Dispatched::Done(Some(JsonRpcResponse::err(id, &err)));
    };
    // 注册内部 request id 路由表 → 发事件（等帧在 `collect_call`）。
    let internal_id = format!("mcp-{}", ctx.shared.seq.fetch_add(1, Ordering::SeqCst) + 1);
    let (tx, rx) = mpsc::channel();
    let started = Instant::now();
    {
        let Ok(mut pending) = ctx.shared.pending.lock() else {
            // slot 在这里随作用域结束自动归还（不落台账 = 不在途）。
            record_http(ctx, &env.method);
            return Dispatched::Done(Some(JsonRpcResponse::err(id, &lock_err())));
        };
        pending.insert(
            internal_id.clone(),
            Pending {
                tx,
                rpc_id: id.clone(),
                method: method.as_str().to_string(),
                tool_name: tool_name.clone(),
                started,
                slot,
            },
        );
    }
    let payload = McpRequestPayload {
        id: internal_id.clone(),
        method: method.as_str().to_string(),
        params: env.params.clone(),
        scope: scope.clone(),
    };
    if let Err(e) = ctx.shared.bridge.emit_request(payload) {
        // 先摘台账：slot 随条目一起归还（口径与「回帧即释放」一致）。
        if let Ok(mut pending) = ctx.shared.pending.lock() {
            pending.remove(&internal_id);
        }
        let err = McpError::new(
            codes::BRIDGE_UNAVAILABLE,
            format!("WebView 事件发送失败：{e}"),
        );
        record(
            ctx,
            tool_name.as_deref().unwrap_or(method.as_str()),
            &env.params,
            AuditOutcome::Denied,
            Some(err.code.clone()),
            None,
            Some(started.elapsed().as_millis() as u64),
        );
        record_http(ctx, &env.method);
        return Dispatched::Done(Some(JsonRpcResponse::err(id, &err)));
    }
    Dispatched::InFlight(PendingCall {
        index,
        id,
        method,
        params: env.params.clone(),
        scope,
        neg,
        tool_name,
        internal_id,
        rx,
        started,
        deadline,
    })
}

/// 收一帧：等 WebView 回帧 → 耗时落账（台账 + 审计 + `_meta.elapsedMs`）→ 归一化过滤。
fn collect_call(call: PendingCall, ctx: &ConnCtx) -> JsonRpcResponse {
    let PendingCall {
        id,
        method,
        params,
        scope,
        neg,
        tool_name,
        internal_id,
        rx,
        started,
        deadline,
        ..
    } = call;
    let label = tool_name.as_deref().unwrap_or(method.as_str());
    let remaining = deadline.saturating_duration_since(Instant::now());
    let reply = match rx.recv_timeout(remaining) {
        Ok(r) => r,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            if let Ok(mut pending) = ctx.shared.pending.lock() {
                pending.remove(&internal_id);
            }
            let elapsed_ms = started.elapsed().as_millis() as u64;
            record_latency(ctx, method, tool_name.as_deref(), started.elapsed());
            let err = McpError::new(codes::TIMEOUT, "等待 WebView 应答超时");
            record(
                ctx,
                label,
                &params,
                AuditOutcome::Timeout,
                None,
                None,
                Some(elapsed_ms),
            );
            record_http(ctx, method.as_str());
            return JsonRpcResponse::err(id, &err);
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            record_latency(ctx, method, tool_name.as_deref(), started.elapsed());
            let err = McpError::new(codes::BRIDGE_UNAVAILABLE, "应答通道已断开");
            record_http(ctx, method.as_str());
            return JsonRpcResponse::err(id, &err);
        }
    };
    let elapsed = started.elapsed();
    let elapsed_ms = elapsed.as_millis() as u64;
    record_latency(ctx, method, tool_name.as_deref(), elapsed);
    let mut resp = match finalize_reply(method, &scope, &params, reply, ctx, Some(elapsed_ms)) {
        Ok(result) => JsonRpcResponse::ok(id, result),
        Err(e) => JsonRpcResponse::err(id, &e),
    };
    // 无状态按请求协商：六种能力方法的 result 都带当次请求的 `_meta`
    // （ping 已在 classify_envelope 里按规范回空 result，不在此附 _meta）。
    // 同一 `_meta` 里再带 `elapsedMs`＝宿主侧这枚调用的真读数（Pending.started → 回帧），
    // 客户端据此知道慢在哪一段；错误帧是 RPC 层形状，不塞 result 字段。
    if let Some(result) = resp.result.as_mut() {
        attach_negotiation_meta(result, &neg);
        attach_elapsed_meta(result, elapsed_ms);
    }
    record_http(ctx, method.as_str());
    resp
}

/// `Duration` 的人类可读短形（只用于错误文案，不参与判定）。
fn humantime(d: Duration) -> String {
    let secs = d.as_secs();
    if secs >= 1 {
        format!("{secs} 秒")
    } else {
        format!("{} 毫秒", d.as_millis())
    }
}

/// 耗时真读数入账：`方法#工具`（WebView 往返）；键构造口径集中在 `latency::LatencyKey`。
fn record_latency(ctx: &ConnCtx, method: WebMethod, tool: Option<&str>, elapsed: Duration) {
    let key = latency::LatencyKey::Bridge {
        method: method.as_str(),
        tool,
    }
    .as_str();
    if let Ok(mut ledger) = ctx.shared.latency.lock() {
        ledger.record(&key, elapsed);
    }
}

/// 整条 HTTP 请求（从连接起到该条定案）的墙钟：与 `bridge#` 的差就是端点自身开销。
fn record_http(ctx: &ConnCtx, method: &str) {
    let key = latency::LatencyKey::Http { method }.as_str();
    let elapsed = ctx.conn_started.elapsed();
    if let Ok(mut ledger) = ctx.shared.latency.lock() {
        ledger.record(&key, elapsed);
    }
}

/// `_meta.elapsedMs`：宿主侧真读数（不是客户端估算）。只挂 object 形态 result。
fn attach_elapsed_meta(result: &mut Value, elapsed_ms: u64) {
    if !result.is_object() {
        return;
    }
    let Some(obj) = result.as_object_mut() else {
        return;
    };
    let meta = obj
        .entry("_meta")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if !meta.is_object() {
        *meta = Value::Object(serde_json::Map::new());
    }
    if let Some(m) = meta.as_object_mut() {
        m.insert("elapsedMs".to_string(), json!(elapsed_ms));
    }
}

fn current_scope(ctx: &ConnCtx) -> Result<McpSessionScope, McpError> {
    let state = ctx.shared.scope_state.lock().map_err(|_| lock_err())?;
    scope::build_scope(&state, ctx.client_id, ctx.session_id)
}

fn rpc_id_matches(v: &Value, raw: &str) -> bool {
    match v {
        Value::String(s) => s == raw,
        Value::Number(n) => n.to_string() == raw,
        _ => false,
    }
}

fn cancel_pending(params: &Value, ctx: &ConnCtx) {
    let request_id = match params.get("requestId") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    };
    let Some(rid) = request_id else {
        return;
    };
    let removed = {
        let Ok(mut pending) = ctx.shared.pending.lock() else {
            return;
        };
        let key = pending
            .iter()
            .find(|(_, p)| rpc_id_matches(&p.rpc_id, &rid))
            .map(|(k, _)| k.clone());
        key.and_then(|k| pending.remove(&k))
    };
    if let Some(p) = removed {
        // 取消也走「摘台账 ⇒ slot 随条目 drop」：在途预算立刻归还。
        let elapsed = p.started.elapsed();
        let elapsed_ms = elapsed.as_millis() as u64;
        let tool = p.tool_name.clone().unwrap_or_else(|| p.method.clone());
        let _ = p.tx.send(BridgeReply {
            ok: false,
            result: None,
            error: Some(McpError::new(codes::CANCELLED, "客户端取消")),
        });
        record(
            ctx,
            &tool,
            &Value::Null,
            AuditOutcome::Cancelled,
            None,
            None,
            Some(elapsed_ms),
        );
    }
}

/// WebView 注册表（冻结契约 v1）把三个 list 方法返回成**裸数组**、tools/call 返回
/// **裸结果对象**；Rust 是线协议层（ADR-0013），在这里补成 MCP 2026-07-28 规范形状。
///
/// 必须在 `filter_tools_list` **之前**调用：后者只认 `result["tools"]`，裸数组会让
/// tier / approvedTools 的二次过滤整条被跳过——真壳端到端取证发现的静默失效。
/// `resources/read` / `prompts/get` 的 registry 已回 `{contents}` / `{messages}`，不动。
pub(crate) fn normalize_webview_result(method: WebMethod, result: &mut Value) {
    match method {
        WebMethod::ToolsList | WebMethod::ResourcesList | WebMethod::PromptsList => {
            if !result.is_array() {
                return; // 已是对象形状（或异常形态）：不编造、不静默改写
            }
            let key = match method {
                WebMethod::ToolsList => "tools",
                WebMethod::ResourcesList => "resources",
                _ => "prompts",
            };
            let mut obj = serde_json::Map::new();
            obj.insert(key.to_string(), result.take());
            *result = Value::Object(obj);
        }
        WebMethod::ToolsCall => {
            if result.get("content").is_some() {
                return;
            }
            // 文本 content 取整个结构化结果的 JSON 文本；原字段（含审计用的 path）全部保留。
            let text = serde_json::to_string(result).unwrap_or_else(|_| "{}".to_string());
            if let Some(obj) = result.as_object_mut() {
                obj.insert(
                    "content".to_string(),
                    json!([{ "type": "text", "text": text }]),
                );
                obj.insert("isError".to_string(), json!(false));
            } else {
                *result =
                    json!({ "content": [{ "type": "text", "text": text }], "isError": false });
            }
        }
        WebMethod::ResourcesRead | WebMethod::PromptsGet => {}
    }
}

/// 只数不存的 `io::Write`：`serde_json::to_writer` 走它，序列化输出被丢弃、只累加字节数。
/// 用于「净化前 raw 体积」的体积闸——与 `to_vec(&raw).len()` 逐字节同长，但不分配整包 Vec。
struct CountingWrite(usize);

impl std::io::Write for CountingWrite {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 += buf.len();
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn finalize_reply(
    method: WebMethod,
    scope: &McpSessionScope,
    params: &Value,
    reply: BridgeReply,
    ctx: &ConnCtx,
    elapsed_ms: Option<u64>,
) -> Result<Value, McpError> {
    if !reply.ok {
        let mut e = reply
            .error
            .unwrap_or_else(|| McpError::new(codes::INTERNAL, "WebView 未给出错误详情"));
        // WebView 的 message 也是不可信输入：去控制字符 + 限长。
        e.message = sanitize_string(&e.message, 1024);
        record(
            ctx,
            params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(method.as_str()),
            params,
            AuditOutcome::Error,
            Some(e.code.clone()),
            None,
            elapsed_ms,
        );
        return Err(e);
    }
    let mut raw = reply.result.unwrap_or_else(|| json!({}));
    // 体积闸判据＝**净化前** raw 的序列化字节数（1MiB，口径不许变宽）。用计数写出器只累加
    // serde 将要吐出的字节数，不再为此分配一份当场丢弃的整包 Vec（B5 吞吐批削分配）。
    // `to_writer` 的输出与 `to_vec` 逐字节同长，故闸值语义零漂移。
    let mut counter = CountingWrite(0usize);
    serde_json::to_writer(&mut counter, &raw)
        .map_err(|e| McpError::new(codes::INTERNAL, format!("应答序列化失败：{e}")))?;
    if counter.0 > ctx.shared.limits.max_response_bytes {
        return Err(McpError::new(codes::RESPONSE_TOO_LARGE, "返回体积超限"));
    }
    // 就地净化：不再新建整树（与 `sanitize_untrusted` 由构造保证逐字节等价）。
    sanitize_untrusted_inplace(&mut raw);
    let mut result = raw;
    // 线协议形状归一必须早于二次过滤：裸数组会让 filter_tools_list 静默跳过。
    normalize_webview_result(method, &mut result);
    if method == WebMethod::ToolsList {
        let outcome = filter_tools_list(&result, scope);
        result = outcome.result;
        for name in &outcome.filtered {
            let reason = if is_market_tool(name) {
                "market_fail_closed"
            } else {
                "privileged_not_approved"
            };
            record(
                ctx,
                name,
                &Value::Null,
                AuditOutcome::Filtered,
                Some(reason.to_string()),
                None,
                elapsed_ms,
            );
        }
    }
    // 每笔 tools/call 留一条审计（含 ok/error 与落盘路径）。
    if method == WebMethod::ToolsCall {
        let landed = result
            .get("path")
            .and_then(Value::as_str)
            .map(|p| sanitize_string(p, 256));
        record(
            ctx,
            params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(method.as_str()),
            params,
            AuditOutcome::Ok,
            None,
            landed,
            elapsed_ms,
        );
    }
    Ok(result)
}

/// 审计落盘失败出声但不阻断主流程（磁盘满不该把请求放大成整体故障）。
///
/// `elapsed_ms`＝宿主侧 `Pending.started` 起的真读数（毫秒）；拿不到真源就传 `None`，
/// 该字段整格缺席（`skip_serializing_if`），绝不写估算值冒充实测。
fn record(
    ctx: &ConnCtx,
    tool: &str,
    args: &Value,
    outcome: AuditOutcome,
    note: Option<String>,
    landed_path: Option<String>,
    elapsed_ms: Option<u64>,
) {
    let mut final_note = note;
    // B24：命令执行面（`commands.run`）的每一条账都要看得见**被点名的那枚命令 id**——
    // 工具名只有一个（`commands.run`），真正的动作在参数里。附注由纯函数从请求帧取，
    // 非这一枚工具 ⇒ `None`，其它工具的审计形状一字不变。跑（Ok/Error）与拒（Denied）
    // 都走这里，故「每次跑 / 每次拒各一条可查的账」不需要新增任何入口。
    if let Some(command_note) = command_run_audit_note(tool, args) {
        final_note = Some(match final_note {
            Some(n) => format!("{n}; {command_note}"),
            None => command_note,
        });
    }
    if landed_path.is_some() {
        let tag = "landedPath reported by WebView response (untrusted)";
        final_note = Some(match final_note {
            Some(n) => format!("{n}; {tag}"),
            None => tag.to_string(),
        });
    }
    let entry = AuditEntry {
        ts: crate::launcher::iso_now(),
        client_id: ctx.client_id.to_string(),
        session_id: ctx.session_id.to_string(),
        tool: tool.to_string(),
        args_digest: audit::digest_args(args),
        outcome,
        landed_path,
        elapsed_ms,
        note: final_note,
    };
    if let Err(e) = audit::append(&ctx.shared.app_data_dir, &entry) {
        eprintln!("[mcp-audit] 落盘失败：{} / {}", e.code, e.message);
    }
}

/* ============================ 响应写出 ============================ */

/// 纯函数：构造响应头。无状态服务**不编造会话状态**——绝不写 `Mcp-Session-Id`、
/// 不写 `Set-Cookie`；只回显服务端当前 `MCP-Protocol-Version` 与禁缓存/nosniff。
pub fn response_head(status: u16, content_type: &str, body_len: usize) -> String {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        403 => "Forbidden",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        _ => "OK",
    };
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {body_len}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nMCP-Protocol-Version: {PROTOCOL_VERSION}\r\n\r\n"
    )
}

fn write_http(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let head = response_head(status, content_type, body.len());
    // **一次写出**（B5 收口批实测修复）：头与体分两次 `write_all` 会切成两个 TCP 段。
    // 读数出处（`b5_endpoint_self_cost_probe`，本机回环、假 bridge、`--test-threads=1`）：
    // 单条 p50 两次写出 3.38ms vs 一次写出 3.19 / 3.39 / 3.70ms（同量级，n=1/3）；
    // 并发 8 连接 × 12 条吞吐 两次写出 ≈110 次/秒（n=1）vs 一次写出 ≈1411 / 1554 / 1618
    // 次/秒（n=3）。⇒ 收益全在并发段，单条不敏感。
    // 形状、字节、`Connection: close` 语义逐字不变，只改写出次数。
    let mut out = Vec::with_capacity(head.len() + body.len());
    out.extend_from_slice(head.as_bytes());
    out.extend_from_slice(body);
    stream.write_all(&out)?;
    stream.flush()
}

fn write_error_http(stream: &mut TcpStream, status: u16, e: &McpError) -> std::io::Result<()> {
    // 错误消息可能回显客户端提供的 Origin / 路径，按不可信输入净化后再回。
    let mut safe = e.clone();
    safe.message = sanitize_string(&safe.message, 512);
    let resp = JsonRpcResponse::err(Value::Null, &safe);
    let body = serde_json::to_vec(&resp).unwrap_or_default();
    write_http(stream, status, "application/json", &body)
}
