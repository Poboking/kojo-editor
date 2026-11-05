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
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use super::audit::{self, AuditEntry, AuditOutcome};
use super::protocol::{
    attach_negotiation_meta, check_protocol_version, check_tool_call_permission, classify_envelope,
    codes, decode_request, filter_tools_list, is_market_tool, negotiate, negotiate_accept,
    sanitize_string, sanitize_untrusted, validate_params, AcceptKind, JsonRpcResponse,
    LocalOutcome, McpError, McpRequestPayload, McpRespondArgs, McpSessionScope, McpTier,
    RequestEnvelope, WebMethod, MCP_REQUEST_EVENT, PROTOCOL_VERSION,
};
use super::scope;

/* ============================ DTO / 状态 ============================ */

#[derive(Debug, Clone, Serialize)]
pub struct McpStartResult {
    pub port: u16,
    pub token: String,
    pub endpoint: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpStatus {
    pub enabled: bool,
    pub port: Option<u16>,
    pub clients: usize,
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
        }
    }
}

pub struct RateState {
    pub window_start: Instant,
    pub count: u32,
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
    #[allow(dead_code)]
    pub started: Instant,
}

/// WebView 桥抽象：六种能力方法经此转发（生产 = Tauri 事件；端点级测试可注入桩，
/// 免构造 Tauri 运行时即可起真实 listener）。
pub trait McpBridge: Send + Sync + 'static {
    fn emit_request(&self, payload: McpRequestPayload) -> Result<(), String>;
}

/// 生产桥：`"mcp://request"` Tauri 事件（WebView 侧 host-bridge 收，回 `mcp_respond`）。
pub struct TauriBridge(pub AppHandle);

impl McpBridge for TauriBridge {
    fn emit_request(&self, payload: McpRequestPayload) -> Result<(), String> {
        self.0
            .emit(MCP_REQUEST_EVENT, payload)
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
    pub rate: Mutex<RateState>,
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
    let shared = Arc::new(McpShared {
        bridge,
        token: Mutex::new(String::new()),
        pending: Mutex::new(HashMap::new()),
        seq: AtomicU64::new(0),
        clients: AtomicUsize::new(0),
        shutdown: Arc::new(AtomicBool::new(false)),
        scope_state: Mutex::new(scope::McpScopeState::default()),
        app_data_dir: app_data_dir.clone(),
        limits: Limits::default(),
        rate: Mutex::new(RateState {
            window_start: Instant::now(),
            count: 0,
        }),
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
    remove_discovery(&rt.shared.app_data_dir);
    Ok(())
}

pub fn status(state: &McpState) -> McpStatus {
    let Ok(guard) = state.runtime.lock() else {
        return McpStatus {
            enabled: false,
            port: None,
            clients: 0,
        };
    };
    match guard.as_ref() {
        Some(rt) => McpStatus {
            enabled: true,
            port: Some(rt.port),
            clients: rt.shared.clients.load(Ordering::SeqCst),
        },
        None => McpStatus {
            enabled: false,
            port: None,
            clients: 0,
        },
    }
}

/// `mcp_respond`：按内部 request id 从路由表取出等待者并回填；id 未知显式报错。
pub fn deliver(state: &McpState, args: McpRespondArgs) -> Result<(), McpError> {
    let shared = {
        let guard = state.runtime.lock().map_err(|_| lock_err())?;
        guard.as_ref().map(|rt| Arc::clone(&rt.shared))
    };
    let shared =
        shared.ok_or_else(|| McpError::new(codes::BRIDGE_UNAVAILABLE, "MCP 服务未启动"))?;
    let pending = shared
        .pending
        .lock()
        .map_err(|_| lock_err())?
        .remove(&args.id);
    let p = pending.ok_or_else(|| {
        McpError::new(
            codes::INVALID_REQUEST,
            format!("未知或已过期的请求 id：{}", args.id),
        )
    })?;
    p.tx.send(BridgeReply {
        ok: args.ok,
        result: args.result,
        error: args.error,
    })
    .map_err(|_| McpError::new(codes::BRIDGE_UNAVAILABLE, "等待方已离开"))?;
    Ok(())
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
    let new_state = scope::approve(
        &dir,
        &args.client_id,
        tier,
        args.approved_roots,
        args.approved_tools,
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

pub fn check_rate(rate: &Mutex<RateState>, limits: &Limits) -> Result<(), McpError> {
    let mut r = rate.lock().map_err(|_| lock_err())?;
    if r.window_start.elapsed() >= Duration::from_secs(60) {
        r.window_start = Instant::now();
        r.count = 0;
    }
    if r.count >= limits.max_calls_per_minute {
        return Err(McpError::new(codes::RATE_LIMITED, "速率超限"));
    }
    r.count += 1;
    Ok(())
}

/// Accept 循环（`pub(crate)` 供端点级测试直接驱动真实 listener；行为与生产一致）。
pub(crate) fn run_accept_loop(listener: TcpListener, shared: Arc<McpShared>) {
    // nonblocking + 短轮询：stop() 不需要额外唤醒连接即可让循环退出。
    let _ = listener.set_nonblocking(true);
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
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                eprintln!("[mcp] accept 失败：{e}");
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

struct ConnCtx<'a> {
    shared: &'a Arc<McpShared>,
    client_id: &'a str,
    session_id: &'a str,
}

fn handle_connection(mut stream: TcpStream, peer: SocketAddr, shared: Arc<McpShared>) {
    let _ = stream.set_read_timeout(Some(shared.limits.request_timeout));
    let _ = stream.set_write_timeout(Some(shared.limits.request_timeout));
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
    match process_head(&head, peer, &shared) {
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
    check_rate(&shared.rate, &shared.limits)?;
    let envelopes = decode_request(&head.body)?;
    let first = envelopes
        .first()
        .ok_or_else(|| McpError::new(codes::INVALID_REQUEST, "空请求"))?;
    let (client_id, session_id) = client_identity(head, first);
    let ctx = ConnCtx {
        shared,
        client_id: &client_id,
        session_id: &session_id,
    };
    let mut responses: Vec<JsonRpcResponse> = Vec::new();
    for env in envelopes {
        if let Some(resp) = handle_envelope(env, &ctx) {
            responses.push(resp);
        }
    }
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

fn handle_envelope(env: RequestEnvelope, ctx: &ConnCtx) -> Option<JsonRpcResponse> {
    match classify_envelope(&env) {
        LocalOutcome::Respond(resp) => Some(resp),
        LocalOutcome::NoResponse => {
            // 通知无帧；但 `notifications/cancelled` 仍需反查并取消在途请求。
            if env.method == "notifications/cancelled" {
                cancel_pending(&env.params, ctx);
            }
            None
        }
        LocalOutcome::NeedsBridge(method) => {
            let neg = negotiate(&env.params);
            let id = env.id.clone().unwrap_or(Value::Null);
            let mut resp = handle_webview(method, &env, ctx, id);
            // 无状态按请求协商：六种能力方法的 result 都带当次请求的 `_meta`
            // （ping 已在 classify_envelope 里按规范回空 result，不在此附 _meta）。
            if let Some(result) = resp.result.as_mut() {
                attach_negotiation_meta(result, &neg);
            }
            Some(resp)
        }
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
        let _ = p.tx.send(BridgeReply {
            ok: false,
            result: None,
            error: Some(McpError::new(codes::CANCELLED, "客户端取消")),
        });
        record(
            ctx,
            p.tool_name.as_deref().unwrap_or(&p.method),
            &Value::Null,
            AuditOutcome::Cancelled,
            None,
            None,
        );
    }
}

fn handle_webview(
    method: WebMethod,
    env: &RequestEnvelope,
    ctx: &ConnCtx,
    id: Value,
) -> JsonRpcResponse {
    let scope = match current_scope(ctx) {
        Ok(s) => s,
        Err(e) => return JsonRpcResponse::err(id, &e),
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
        );
        return JsonRpcResponse::err(id, &e);
    }
    let tool_name = env
        .params
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string);
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
                );
                return JsonRpcResponse::err(id, &e);
            }
        }
    }
    // 注册内部 request id 路由表 → 发事件 → 等 mcp_respond。
    let internal_id = format!("mcp-{}", ctx.shared.seq.fetch_add(1, Ordering::SeqCst) + 1);
    let (tx, rx) = mpsc::channel();
    {
        let Ok(mut pending) = ctx.shared.pending.lock() else {
            return JsonRpcResponse::err(id, &lock_err());
        };
        pending.insert(
            internal_id.clone(),
            Pending {
                tx,
                rpc_id: id.clone(),
                method: method.as_str().to_string(),
                tool_name: tool_name.clone(),
                started: Instant::now(),
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
        );
        return JsonRpcResponse::err(id, &err);
    }
    let reply = match rx.recv_timeout(ctx.shared.limits.request_timeout) {
        Ok(r) => r,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            if let Ok(mut pending) = ctx.shared.pending.lock() {
                pending.remove(&internal_id);
            }
            let err = McpError::new(codes::TIMEOUT, "等待 WebView 应答超时");
            record(
                ctx,
                tool_name.as_deref().unwrap_or(method.as_str()),
                &env.params,
                AuditOutcome::Timeout,
                None,
                None,
            );
            return JsonRpcResponse::err(id, &err);
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let err = McpError::new(codes::BRIDGE_UNAVAILABLE, "应答通道已断开");
            return JsonRpcResponse::err(id, &err);
        }
    };
    match finalize_reply(method, &scope, &env.params, reply, ctx) {
        Ok(result) => JsonRpcResponse::ok(id, result),
        Err(e) => JsonRpcResponse::err(id, &e),
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

fn finalize_reply(
    method: WebMethod,
    scope: &McpSessionScope,
    params: &Value,
    reply: BridgeReply,
    ctx: &ConnCtx,
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
        );
        return Err(e);
    }
    let raw = reply.result.unwrap_or_else(|| json!({}));
    let raw_len = serde_json::to_vec(&raw)
        .map_err(|e| McpError::new(codes::INTERNAL, format!("应答序列化失败：{e}")))?
        .len();
    if raw_len > ctx.shared.limits.max_response_bytes {
        return Err(McpError::new(codes::RESPONSE_TOO_LARGE, "返回体积超限"));
    }
    let mut result = sanitize_untrusted(&raw);
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
        );
    }
    Ok(result)
}

/// 审计落盘失败出声但不阻断主流程（磁盘满不该把请求放大成整体故障）。
fn record(
    ctx: &ConnCtx,
    tool: &str,
    args: &Value,
    outcome: AuditOutcome,
    note: Option<String>,
    landed_path: Option<String>,
) {
    let mut final_note = note;
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
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
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
