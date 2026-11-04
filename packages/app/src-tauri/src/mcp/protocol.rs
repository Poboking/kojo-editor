//! MCP 线协议（路 C）。
//!
//! 职责：最小 JSON-RPC 2.0 编解码、方法路由、结构化错误、按请求协商能力、
//! **路径闸门**与危险工具判定。
//!
//! 安全边界（AGENTS.md 铁律 / ADR-0003 的已拍板例外）：
//! - Rust 侧不把任何 MCP 参数用于文件系统写入；路径型参数只接受「项目内相对路径」
//!   或 `kojo://` 资源 URI，越界一律**显式报错**（fail loud，不静默）。
//! - 不得开放任意目标路径参数：绕开写允许域的唯一法定通道是 `export_file`
//!   （对话框与写盘绑在同一个 Rust 命令内，`lib.rs::export_file`），MCP 工具
//!   不接受落点路径。
//! - 本文件零游戏知识（audit A 项）；方法名 / 能力名 / 工具名只是线协议字面量。
//! - 工具描述 / 文件内容一律按不可信输入处理（MCP 2026-07-28：annotations 不可信）：
//!   去控制字符 + 限体积，Rust 不据其内容做任何决策。

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// 冻结契约：发给 WebView 的事件名（路 A 的 host-bridge 收，回 `mcp_respond`）。
pub const MCP_REQUEST_EVENT: &str = "mcp://request";

/// 现行 MCP 规范版本；协商默认值。
pub const PROTOCOL_VERSION: &str = "2026-07-28";
/// 旧版 `initialize` 握手兼容：客户端声明这些版本时按请求回显。
pub const LEGACY_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
pub const SERVER_NAME: &str = "kojo-editor-mcp";
pub const SERVER_VERSION: &str = "0.1.0";

/// 不可信文本的单串上限（返回体积上限的一部分，也是提示注入的第一道）。
pub const MAX_UNTRUSTED_CHARS: usize = 64 * 1024;
/// 工具描述上限（annotations 不可信）。
pub const MAX_DESCRIPTION_CHARS: usize = 2 * 1024;
/// 项目内相对路径整体上限（字节）；单组件再按 Windows 语义 255 收紧。
pub const MAX_PATH_CHARS: usize = 512;
pub const MAX_PATH_COMPONENT_CHARS: usize = 255;

/* ============================ 会话 scope ============================ */

/// 冻结契约 `McpTier` 的 Rust 镜像（**不 import `@kojo/mcp-host`**）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpTier {
    Read,
    Edit,
    Privileged,
}

impl McpTier {
    pub fn as_str(self) -> &'static str {
        match self {
            McpTier::Read => "read",
            McpTier::Edit => "edit",
            McpTier::Privileged => "privileged",
        }
    }
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "read" => Some(Self::Read),
            "edit" => Some(Self::Edit),
            "privileged" => Some(Self::Privileged),
            _ => None,
        }
    }
}

/// 冻结契约 `McpSessionScope` 的 Rust 镜像，逐字对齐字段名。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpSessionScope {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "clientId")]
    pub client_id: String,
    pub tier: McpTier,
    #[serde(rename = "approvedRoots")]
    pub approved_roots: Vec<String>,
    #[serde(rename = "approvedTools")]
    pub approved_tools: Vec<String>,
}

/// 冻结契约：WebView → Rust 的应答载荷。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRespondArgs {
    pub id: String,
    pub ok: bool,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<McpError>,
}

/// 冻结契约：Rust → WebView 的事件载荷。
#[derive(Debug, Clone, Serialize)]
pub struct McpRequestPayload {
    pub id: String,
    /// 六种之一（见 [`WebMethod`]）。
    pub method: String,
    pub params: Value,
    pub scope: McpSessionScope,
}

/* ============================ 结构化错误 ============================ */

pub mod codes {
    pub const PARSE: &str = "E_PARSE";
    pub const INVALID_REQUEST: &str = "E_INVALID_REQUEST";
    pub const METHOD_NOT_FOUND: &str = "E_METHOD_NOT_FOUND";
    pub const INVALID_PARAMS: &str = "E_INVALID_PARAMS";
    pub const UNAUTHORIZED: &str = "E_UNAUTHORIZED";
    pub const FORBIDDEN_ORIGIN: &str = "E_FORBIDDEN_ORIGIN";
    pub const RATE_LIMITED: &str = "E_RATE_LIMITED";
    pub const TIMEOUT: &str = "E_TIMEOUT";
    pub const CANCELLED: &str = "E_CANCELLED";
    pub const RESPONSE_TOO_LARGE: &str = "E_RESPONSE_TOO_LARGE";
    pub const PATH_ESCAPE: &str = "E_PATH_ESCAPE";
    pub const PATH_TARGET_FORBIDDEN: &str = "E_PATH_TARGET_FORBIDDEN";
    pub const PATH_SCHEME: &str = "E_PATH_SCHEME";
    pub const TOOL_FAIL_CLOSED: &str = "E_TOOL_FAIL_CLOSED";
    pub const TOOL_NOT_APPROVED: &str = "E_TOOL_NOT_APPROVED";
    /// `MCP-Protocol-Version` 头声明了宿主不支持的版本（显式结构化错误，不静默回退）。
    pub const UNSUPPORTED_PROTOCOL_VERSION: &str = "E_UNSUPPORTED_PROTOCOL_VERSION";
    pub const BRIDGE_UNAVAILABLE: &str = "E_BRIDGE_UNAVAILABLE";
    pub const INTERNAL: &str = "E_INTERNAL";
}

/// 结构化错误 `{code, message}`（冻结契约里 `mcp_respond` 的 error 形状）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpError {
    pub code: String,
    pub message: String,
}

impl McpError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
    /// JSON-RPC 2.0 数值码；宿主自定义码统一 -32000，原始串进 `data`。
    pub fn numeric_code(&self) -> i64 {
        match self.code.as_str() {
            codes::PARSE => -32700,
            codes::INVALID_REQUEST => -32600,
            codes::METHOD_NOT_FOUND => -32601,
            codes::INVALID_PARAMS => -32602,
            codes::INTERNAL => -32603,
            _ => -32000,
        }
    }
    pub fn to_json_rpc(&self) -> JsonRpcError {
        JsonRpcError {
            code: self.numeric_code(),
            message: self.message.clone(),
            data: Some(json!({ "code": self.code, "message": self.message })),
        }
    }
}

/* ============================ JSON-RPC 2.0 ============================ */

#[derive(Debug, Clone, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl JsonRpcResponse {
    pub fn ok(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(result),
            error: None,
        }
    }
    pub fn err(id: Value, e: &McpError) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(e.to_json_rpc()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RequestEnvelope {
    pub id: Option<Value>,
    pub method: String,
    pub params: Value,
}

/// 解码单个请求或 batch 数组；非法结构显式报错，绝不静默丢弃。
pub fn decode_request(body: &[u8]) -> Result<Vec<RequestEnvelope>, McpError> {
    let value: Value = serde_json::from_slice(body)
        .map_err(|e| McpError::new(codes::PARSE, format!("JSON 解析失败：{e}")))?;
    let list: Vec<Value> = match value {
        Value::Array(items) => items,
        other => vec![other],
    };
    if list.is_empty() {
        return Err(McpError::new(codes::INVALID_REQUEST, "空 batch"));
    }
    let mut out = Vec::with_capacity(list.len());
    for item in list {
        let obj = item
            .as_object()
            .ok_or_else(|| McpError::new(codes::INVALID_REQUEST, "请求必须是对象"))?;
        if obj.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Err(McpError::new(
                codes::INVALID_REQUEST,
                "jsonrpc 必须为 \"2.0\"",
            ));
        }
        let method = obj
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| McpError::new(codes::INVALID_REQUEST, "method 缺失或非字符串"))?
            .to_string();
        if method.is_empty() || method.len() > 128 {
            return Err(McpError::new(codes::INVALID_REQUEST, "method 形状非法"));
        }
        let id = obj.get("id").cloned();
        if let Some(ref v) = id {
            if !(v.is_string() || v.is_number() || v.is_null()) {
                return Err(McpError::new(
                    codes::INVALID_REQUEST,
                    "id 只能是 string/number/null",
                ));
            }
        }
        let params = obj.get("params").cloned().unwrap_or(Value::Null);
        if !(params.is_object() || params.is_array() || params.is_null()) {
            return Err(McpError::new(
                codes::INVALID_PARAMS,
                "params 必须是对象/数组/null",
            ));
        }
        out.push(RequestEnvelope { id, method, params });
    }
    Ok(out)
}

/* ============================ 方法路由 ============================ */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebMethod {
    ToolsList,
    ToolsCall,
    ResourcesList,
    ResourcesRead,
    PromptsList,
    PromptsGet,
}

impl WebMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            WebMethod::ToolsList => "tools/list",
            WebMethod::ToolsCall => "tools/call",
            WebMethod::ResourcesList => "resources/list",
            WebMethod::ResourcesRead => "resources/read",
            WebMethod::PromptsList => "prompts/list",
            WebMethod::PromptsGet => "prompts/get",
        }
    }
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "tools/list" => Some(Self::ToolsList),
            "tools/call" => Some(Self::ToolsCall),
            "resources/list" => Some(Self::ResourcesList),
            "resources/read" => Some(Self::ResourcesRead),
            "prompts/list" => Some(Self::PromptsList),
            "prompts/get" => Some(Self::PromptsGet),
            _ => None,
        }
    }
}

pub const WEB_METHOD_NAMES: &[&str] = &[
    "tools/list",
    "tools/call",
    "resources/list",
    "resources/read",
    "prompts/list",
    "prompts/get",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Initialize,
    Ping,
    Notification,
    Webview(WebMethod),
    Unknown,
}

pub fn route(method: &str) -> Route {
    match method {
        "initialize" => Route::Initialize,
        "ping" => Route::Ping,
        other if other.starts_with("notifications/") => Route::Notification,
        other => match WebMethod::parse(other) {
            Some(m) => Route::Webview(m),
            None => Route::Unknown,
        },
    }
}

/// JSON-RPC 通知：无 id 或 id=null ⇒ 不回响应（HTTP 202）。
pub fn is_notification(envelope: &RequestEnvelope) -> bool {
    envelope.id.is_none() || envelope.id.as_ref().is_some_and(Value::is_null)
}

/// 单个 envelope 的纯函数分派结果（端点级验证可直接调用，无需真实 AppHandle）。
pub enum LocalOutcome {
    /// 本地即可作答（initialize / ping / method-not-found）。
    Respond(JsonRpcResponse),
    /// 通知：绝不产生响应帧（含 `notifications/*` 与任何无 id 的 JSON-RPC 通知）。
    NoResponse,
    /// 六种能力方法：需转 WebView（由 `server::handle_envelope` 接管）。
    NeedsBridge(WebMethod),
}

/// 逐条分派：通知一律无响应；`initialize` 回合法握手；`ping` 回**空** result；
/// 未知方法回显式 `method not found`；六种能力方法交给 WebView。
/// 批量请求里因此天然「只回有 id 的那些」——`decode_request` 不丢条目，本函数
/// 只让真正要响应的条目生成帧。
pub fn classify_envelope(env: &RequestEnvelope) -> LocalOutcome {
    // 通知优先：无论 method 是 `notifications/*` 还是 capabilities 方法，无 id ⇒ 无帧。
    if is_notification(env) {
        return LocalOutcome::NoResponse;
    }
    let neg = negotiate(&env.params);
    let id = env.id.clone().unwrap_or(Value::Null);
    match route(&env.method) {
        // MCP 规范：ping 的 result 必须是空对象；不带 `_meta`，不编造会话状态。
        Route::Ping => LocalOutcome::Respond(JsonRpcResponse::ok(id, json!({}))),
        Route::Initialize => {
            let mut resp = JsonRpcResponse::ok(id, initialize_result(&neg, &env.params));
            if let Some(result) = resp.result.as_mut() {
                attach_negotiation_meta(result, &neg);
            }
            LocalOutcome::Respond(resp)
        }
        // `notifications/*` 即使带了 id 也按通知处理，绝不回帧。
        Route::Notification => LocalOutcome::NoResponse,
        Route::Unknown => LocalOutcome::Respond(JsonRpcResponse::err(
            id,
            &McpError::new(codes::METHOD_NOT_FOUND, format!("未知方法 {}", env.method)),
        )),
        Route::Webview(m) => LocalOutcome::NeedsBridge(m),
    }
}

/* ==================== 按请求协商能力（2026-07-28 无状态） ==================== */

pub fn server_capabilities() -> Value {
    json!({
        "tools": { "listChanged": false },
        "resources": { "subscribe": false, "listChanged": false },
        "prompts": { "listChanged": false },
        "logging": {}
    })
}

#[derive(Debug, Clone)]
pub struct Negotiation {
    pub protocol_version: String,
    pub client_capabilities: Value,
    pub server_capabilities: Value,
}

/// 协商完全由**当前请求**决定：不读任何上一次 initialize 的残留状态（无状态）。
/// 版本从 `protocolVersion` 或 `_meta.io.modelcontextprotocol/protocolVersion` 取；
/// 客户端能力从 `capabilities` 或 `_meta.io.modelcontextprotocol/capabilities` 取。
pub fn negotiate(params: &Value) -> Negotiation {
    let requested = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .or_else(|| {
            params
                .pointer("/_meta/io.modelcontextprotocol~1protocolVersion")
                .and_then(Value::as_str)
        });
    let protocol_version = match requested {
        Some(v) if v == PROTOCOL_VERSION || LEGACY_VERSIONS.contains(&v) => v.to_string(),
        Some(_) => PROTOCOL_VERSION.to_string(),
        None => PROTOCOL_VERSION.to_string(),
    };
    let client_capabilities = params
        .get("capabilities")
        .or_else(|| params.pointer("/_meta/io.modelcontextprotocol~1capabilities"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    Negotiation {
        protocol_version,
        client_capabilities,
        server_capabilities: server_capabilities(),
    }
}

/// 支持的协议版本：现行版 + 旧握手版（`initialize` 请求体按这些版本回显）。
pub fn is_supported_protocol_version(v: &str) -> bool {
    v == PROTOCOL_VERSION || LEGACY_VERSIONS.contains(&v)
}

/// 请求头 `MCP-Protocol-Version`：**有就校验**，未知版本显式结构化错误。
/// 不带头（旧客户端）按无状态服务放行；带空值也判非法（fail closed）。
pub fn check_protocol_version(raw: Option<&str>) -> Result<(), McpError> {
    let Some(raw) = raw else {
        return Ok(());
    };
    let v = raw.trim();
    if is_supported_protocol_version(v) {
        return Ok(());
    }
    Err(McpError::new(
        codes::UNSUPPORTED_PROTOCOL_VERSION,
        format!(
            "不支持的 MCP-Protocol-Version：{v}（支持 {PROTOCOL_VERSION} 及旧版 {}）",
            LEGACY_VERSIONS.join(", ")
        ),
    ))
}

/// 单端点 `POST /mcp` 的 Accept 协商结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcceptKind {
    Json,
    Sse,
}

/// MCP Streamable HTTP：客户端必须能接受 `application/json` 或 `text/event-stream`。
/// 两者都声明时优先 SSE（请求级流）；只声明 JSON / `*/*` 回普通 JSON；
/// 两者都不声明 ⇒ 显式 `invalid request`，不静默选一种。
pub fn negotiate_accept(accept: Option<&str>) -> Result<AcceptKind, McpError> {
    let Some(raw) = accept else {
        return Ok(AcceptKind::Json);
    };
    let lower = raw.to_ascii_lowercase();
    let mut has_json = false;
    let mut has_sse = false;
    for part in lower.split(',') {
        let media = part.split(';').next().unwrap_or("").trim();
        match media {
            "application/json" | "*/*" | "application/*" => has_json = true,
            "text/event-stream" => has_sse = true,
            _ => {}
        }
    }
    if !has_json && !has_sse {
        return Err(McpError::new(
            codes::INVALID_REQUEST,
            format!("Accept 必须包含 application/json 或 text/event-stream：{raw}"),
        ));
    }
    Ok(if has_sse {
        AcceptKind::Sse
    } else {
        AcceptKind::Json
    })
}

pub fn meta_for(neg: &Negotiation) -> Value {
    json!({
        "io.modelcontextprotocol/protocolVersion": neg.protocol_version,
        "io.modelcontextprotocol/capabilities": neg.server_capabilities,
        "io.modelcontextprotocol/clientCapabilities": neg.client_capabilities,
        "io.modelcontextprotocol/stateless": true
    })
}

/// 把协商 `_meta` 附到每个 result（请求级，无状态）；与已有 `_meta` 合并，不覆盖
/// （initialize 的 `clientInfo` 要保留）。
pub fn attach_negotiation_meta(result: &mut Value, neg: &Negotiation) {
    if let Some(obj) = result.as_object_mut() {
        if !obj.contains_key("_meta") {
            obj.insert("_meta".to_string(), json!({}));
        }
        let negotiated = meta_for(neg);
        if let (Some(m), Some(n)) = (
            obj.get_mut("_meta").and_then(Value::as_object_mut),
            negotiated.as_object(),
        ) {
            for (key, value) in n {
                m.insert(key.clone(), value.clone());
            }
        }
    }
}

/// 旧握手 `initialize` 兼容：返回服务端能力 + 版本 + 协商 `_meta`。
pub fn initialize_result(neg: &Negotiation, params: &Value) -> Value {
    let client_info = params
        .get("clientInfo")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut meta = meta_for(neg);
    if let Some(obj) = meta.as_object_mut() {
        obj.insert(
            "io.modelcontextprotocol/clientInfo".to_string(),
            client_info,
        );
    }
    json!({
        "protocolVersion": neg.protocol_version,
        "capabilities": neg.server_capabilities,
        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
        "_meta": meta
    })
}

/* ============================ 路径闸门 ============================ */

/// 键名归一化：只保留 ASCII 字母数字并小写。`output.path` / `Output-Dir` /
/// `DEST_PATH` / `save As` 这类混入标点、大小写、camelCase 的形态全部收敛，
/// 堵住「换个写法就绕过落点键判据」的整类绕过。
fn normalize_key(key: &str) -> String {
    key.to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

/// 把键名切成词：按非字母数字与 camelCase 边界分词后小写。
/// 例 `outputPath` → ["output","path"]，`Output-Dir` → ["output","dir"]，
/// `saveAs` → ["save","as"]，`timeout` → ["timeout"]（不会误命中 "to"）。
fn key_tokens(key: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    for c in key.chars() {
        if c.is_ascii_alphanumeric() {
            if c.is_ascii_uppercase() && !cur.is_empty() {
                tokens.push(cur.to_ascii_lowercase());
                cur.clear();
            }
            cur.extend(c.to_lowercase());
        } else if !cur.is_empty() {
            tokens.push(cur.to_ascii_lowercase());
            cur.clear();
        }
    }
    if !cur.is_empty() {
        tokens.push(cur.to_ascii_lowercase());
    }
    tokens
}

/// 路径型参数键（归一化后比较）。命中即按「项目内相对路径或 `kojo://` URI」校验。
const PATH_KEYS: &[&str] = &[
    "path",
    "uri",
    "file",
    "filename",
    "filepath",
    "dir",
    "dirname",
    "root",
    "target",
    "source",
    "folder",
    "resource",
    "resourceuri",
    "projectpath",
    "relpath",
    "relativepath",
    "pathname",
    "subpath",
    "dirpath",
    "folderpath",
    "resourcepath",
    "fileuri",
    "srcpath",
    "rootpath",
    "basepath",
    "locationpath",
    "workspaceroot",
    "projectroot",
];

/// 落点型参数键（归一化后）：MCP 工具**不得**接受任意目标路径（法定通道是
/// export_file 的「对话框与写盘绑在同一 Rust 命令」）。命中即显式报错，不静默剥离。
const FORBIDDEN_TARGET_KEYS: &[&str] = &[
    "targetpath",
    "targetdir",
    "targetfile",
    "targetfolder",
    "targetname",
    "destinationpath",
    "destinationdir",
    "destinationfile",
    "destinationfolder",
    "destination",
    "destpath",
    "destdir",
    "destfile",
    "destfolder",
    "dest",
    "dst",
    "dstpath",
    "dstfile",
    "dstdir",
    "outputpath",
    "outputdir",
    "outputfile",
    "outputfilename",
    "outputfolder",
    "output",
    "outpath",
    "outfile",
    "outfilename",
    "savepath",
    "savedir",
    "savefile",
    "savefilename",
    "savefolder",
    "saveas",
    "savedestination",
    "writepath",
    "writedir",
    "writefile",
    "writefilename",
    "writefolder",
    "writeto",
    "writedestination",
    "absolutepath",
    "exportpath",
    "exportdir",
    "exportto",
    "exportfile",
    "exportfilename",
    "landingpath",
    "landingdir",
    "landingfile",
    "landing",
    "landingzip",
    "zippath",
    "newpath",
    "newfile",
    "newfilename",
    "moveto",
    "copyto",
    "downloadpath",
    "downloadto",
    "artifactpath",
    "artifactdir",
];

/// 固定黑名单之外的「落点语义」判据：键名同时含一个落点动词与一个位置名词才命中，
/// 覆盖未知别名（`dropFolder` / `moveTo` / `saveAs` …），又不误伤 `timeout`、
/// `content`、`writeContent`、`newText` 这类合法参数。
fn is_forbidden_target_key(key: &str) -> bool {
    let nk = normalize_key(key);
    if FORBIDDEN_TARGET_KEYS.contains(&nk.as_str()) {
        return true;
    }
    const LANDING: &[&str] = &[
        "dest",
        "destination",
        "output",
        "save",
        "write",
        "export",
        "target",
        "landing",
        "drop",
        "dst",
        "artifact",
        "download",
        "new",
        "move",
        "copy",
    ];
    const WHERE: &[&str] = &[
        "path", "dir", "file", "folder", "to", "as", "name", "location", "into",
    ];
    let tokens = key_tokens(key);
    tokens.iter().any(|t| LANDING.contains(&t.as_str()))
        && tokens.iter().any(|t| WHERE.contains(&t.as_str()))
}

/// 全局编码形状扫描：任何字符串参数只要含 URL 编码的点 / 分隔符 / 百分号 / NUL
/// （含双重编码 `%252e` 里的 `%25`），一律拒。宿主从不解码参数，先把整类形状掐断。
const ENCODED_TRAVERSAL_TOKENS: &[&str] = &["%2e", "%2f", "%5c", "%25", "%00"];

fn has_encoded_traversal(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    ENCODED_TRAVERSAL_TOKENS
        .iter()
        .any(|token| lower.contains(token))
}

/// 校验六方法的 params：三层闸门——落点键黑名单（含未知别名/混淆写法）、
/// 全局编码形状、路径型参数越界。越界一律显式报错，绝不静默剥离。
pub fn validate_params(method: WebMethod, params: &Value) -> Result<(), McpError> {
    scan_forbidden_targets(params)?;
    scan_encoded_targets(params)?;
    scan_path_values(params)?;
    match method {
        WebMethod::ResourcesRead => {
            let uri = params
                .get("uri")
                .and_then(Value::as_str)
                .ok_or_else(|| McpError::new(codes::INVALID_PARAMS, "resources/read 需要 uri"))?;
            validate_kojo_uri(uri)?;
        }
        WebMethod::ToolsCall | WebMethod::PromptsGet => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| McpError::new(codes::INVALID_PARAMS, "需要 name"))?;
            validate_tool_name(name)?;
        }
        _ => {}
    }
    Ok(())
}

fn scan_forbidden_targets(v: &Value) -> Result<(), McpError> {
    match v {
        Value::Object(map) => {
            for (key, child) in map {
                if is_forbidden_target_key(key) {
                    return Err(McpError::new(
                        codes::PATH_TARGET_FORBIDDEN,
                        format!("MCP 工具不接受目标落点参数 {key}（写盘落点只由宿主对话框决定）"),
                    ));
                }
                scan_forbidden_targets(child)?;
            }
            Ok(())
        }
        Value::Array(items) => {
            for item in items {
                scan_forbidden_targets(item)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn scan_encoded_targets(v: &Value) -> Result<(), McpError> {
    match v {
        Value::String(s) if has_encoded_traversal(s) => Err(McpError::new(
            codes::PATH_ESCAPE,
            "参数含 URL 编码 / 双重编码的路径形状（宿主不解码，一律拒）",
        )),
        Value::Object(map) => {
            for child in map.values() {
                scan_encoded_targets(child)?;
            }
            Ok(())
        }
        Value::Array(items) => {
            for item in items {
                scan_encoded_targets(item)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn scan_path_values(v: &Value) -> Result<(), McpError> {
    match v {
        Value::Object(map) => {
            for (key, child) in map {
                let nk = normalize_key(key);
                if PATH_KEYS.contains(&nk.as_str()) {
                    match child {
                        Value::String(s) => validate_path_value(&nk, s)?,
                        Value::Null => {}
                        _ => {
                            return Err(McpError::new(
                                codes::INVALID_PARAMS,
                                format!("路径参数 {key} 必须是字符串"),
                            ))
                        }
                    }
                }
                scan_path_values(child)?;
            }
            Ok(())
        }
        Value::Array(items) => {
            for item in items {
                scan_path_values(item)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn validate_path_value(key: &str, raw: &str) -> Result<(), McpError> {
    if raw.starts_with("kojo://") {
        return validate_kojo_uri(raw);
    }
    if key == "uri" || key == "resourceuri" {
        return Err(McpError::new(
            codes::PATH_SCHEME,
            "资源 URI 只接受 kojo:// 形态",
        ));
    }
    validate_relative_path(raw)
}

/// 双向控制 / 零宽格式字符（Trojan-source 类）：不属于 `char::is_control()` 的 Cc，
/// 但同样能把 `..` / 分隔符伪装成肉眼不可见形态，一并 fail closed。
fn has_invisible_format_char(s: &str) -> bool {
    s.chars().any(|c| {
        matches!(c,
            '\u{200B}'..='\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{2069}'
                | '\u{FEFF}'
                | '\u{00AD}')
    })
}

/// 项目内相对路径判据（MCP 参数值绝不用于任意目标落点）：
/// 拒空 / 过长 / 控制字符与不可见字符 / 百分号编码（含双重编码）/ 盘符 /
/// UNC / 反斜杠与混斜杠 / `~` 展开 / `.` 与 `..` 段 / 尾点尾空格 / 设备保留名。
/// 越界一律显式报错（fail loud），消息里回显的 raw 先按不可信输入净化。
pub fn validate_relative_path(raw: &str) -> Result<(), McpError> {
    let bad = |why: &str| -> Result<(), McpError> {
        Err(McpError::new(
            codes::PATH_ESCAPE,
            format!("路径越界（{why}）：{}", sanitize_string(raw, 128)),
        ))
    };
    if raw.is_empty() {
        return bad("空路径");
    }
    if raw.len() > MAX_PATH_CHARS {
        return bad("过长");
    }
    if raw.chars().any(char::is_control) {
        return bad("含 NUL / 控制字符（含 C1、DEL、制表换行）");
    }
    if has_invisible_format_char(raw) {
        return bad("含双向 / 零宽不可见字符");
    }
    // 任何百分号都拒：宿主不解码，URL 编码 `%2e%2e` / `%5c` 与双重编码 `%252e`
    // 整类形状在这里一次性掐断，避免下游按不同解码口径二次解释。
    if raw.contains('%') {
        return bad("含百分号编码（URL 编码 / 双重编码）");
    }
    if raw.contains(':') {
        return bad("盘符 / scheme / ADS 冒号");
    }
    if raw.contains('~') {
        return bad("家目录展开前缀");
    }
    // 反斜杠一律拒：WebView 侧按字面量处理，`\\` 与正反斜杠混用都不放行。
    if raw.contains('\\') {
        return bad("反斜杠分隔 / 正反斜杠混用");
    }
    if raw.starts_with('/') {
        return bad("绝对路径或 UNC 前缀");
    }
    for comp in raw.split('/') {
        if comp.is_empty() {
            return bad("空组件（双斜杠或尾斜杠）");
        }
        if comp.chars().count() > MAX_PATH_COMPONENT_CHARS {
            return bad("组件过长（Windows 255）");
        }
        if comp == "." || comp == ".." {
            return bad("点 / 上跳组件");
        }
        if comp.ends_with('.') || comp.ends_with(' ') {
            return bad("尾点或尾空格（Windows 语义）");
        }
        if is_device_name(comp) {
            return bad("设备保留名");
        }
    }
    Ok(())
}

fn is_device_name(comp: &str) -> bool {
    let stem = comp.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || (stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && stem.as_bytes()[3].is_ascii_digit())
}

/// `kojo://` 资源 URI：与相对路径同口径收紧（绝对形态 / `..` / 控制字符 /
/// 百分号编码 / 反斜杠 / 尾点尾空格 / 设备名）；query/fragment 只做长度约束。
pub fn validate_kojo_uri(raw: &str) -> Result<(), McpError> {
    let rest = raw
        .strip_prefix("kojo://")
        .ok_or_else(|| McpError::new(codes::PATH_SCHEME, "不是 kojo:// 资源 URI"))?;
    if rest.is_empty() || rest.len() > MAX_PATH_CHARS {
        return Err(McpError::new(
            codes::PATH_ESCAPE,
            "kojo:// 资源路径为空或过长",
        ));
    }
    if rest.starts_with('/') || rest.starts_with('\\') {
        return Err(McpError::new(codes::PATH_ESCAPE, "kojo:// 不接受绝对形态"));
    }
    if rest.chars().any(char::is_control) || has_invisible_format_char(rest) {
        return Err(McpError::new(codes::PATH_ESCAPE, "kojo:// 含控制字符"));
    }
    if rest.contains('%') {
        return Err(McpError::new(
            codes::PATH_ESCAPE,
            "kojo:// 不接受百分号编码",
        ));
    }
    if rest.contains('\\') {
        return Err(McpError::new(
            codes::PATH_ESCAPE,
            "kojo:// 不接受反斜杠分隔",
        ));
    }
    if rest.contains('~') {
        return Err(McpError::new(
            codes::PATH_ESCAPE,
            "kojo:// 不接受家目录展开",
        ));
    }
    let path = rest.split(['?', '#']).next().unwrap_or(rest);
    for comp in path.split('/') {
        if comp.is_empty()
            || comp == "."
            || comp == ".."
            || comp.contains(':')
            || comp.chars().count() > MAX_PATH_COMPONENT_CHARS
            || comp.ends_with('.')
            || comp.ends_with(' ')
            || is_device_name(comp)
        {
            return Err(McpError::new(
                codes::PATH_ESCAPE,
                "kojo:// 资源路径含非法组件",
            ));
        }
    }
    Ok(())
}

/* ============================ 危险工具 ============================ */

/// 危险工具（路 B 标 `tier:'privileged'`）：Rust 侧默认不进 tools/list，
/// 且必须显式出现在 `scope.approvedTools` 才放行（双保险）。
pub const PRIVILEGED_EXACT: &[&str] = &["open_url_external", "export_file", "rename_path"];

pub fn is_market_tool(name: &str) -> bool {
    name.starts_with("market_")
}
pub fn is_launcher_tool(name: &str) -> bool {
    name.starts_with("launcher_")
}
pub fn is_privileged_tool(name: &str) -> bool {
    is_market_tool(name)
        || is_launcher_tool(name)
        || PRIVILEGED_EXACT.contains(&name)
        || name.starts_with("remove_")
}

/// 宿主侧按工具名形状推断所需 tier（**不读 WebView 的 annotations**：annotations
/// 不可信）。只认线协议字面的动词前缀，零游戏语义；未知名字一律按 read 放行。
pub const EDIT_TOOL_PREFIXES: &[&str] = &[
    "write_",
    "edit_",
    "apply_",
    "insert_",
    "delete_",
    "create_",
    "save_",
    "set_",
    "replace_",
    "format_",
    "patch_",
    "update_",
    "append_",
    "clear_",
    "toggle_",
    "move_",
    "copy_",
    "duplicate_",
];

pub fn host_required_tier(name: &str) -> McpTier {
    if is_privileged_tool(name) {
        return McpTier::Privileged;
    }
    let lower = name.to_ascii_lowercase();
    if EDIT_TOOL_PREFIXES.iter().any(|p| lower.starts_with(p)) {
        return McpTier::Edit;
    }
    McpTier::Read
}

fn tier_rank(t: McpTier) -> u8 {
    match t {
        McpTier::Read => 0,
        McpTier::Edit => 1,
        McpTier::Privileged => 2,
    }
}

/// `market_*` 保持 fail-closed：名字形状合法也不放行。
pub fn validate_tool_name(name: &str) -> Result<(), McpError> {
    if name.is_empty() || name.len() > 64 {
        return Err(McpError::new(codes::INVALID_PARAMS, "工具名形状非法"));
    }
    if !name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
    {
        return Err(McpError::new(codes::INVALID_PARAMS, "工具名形状非法"));
    }
    if is_market_tool(name) {
        return Err(McpError::new(
            codes::TOOL_FAIL_CLOSED,
            "market_* 保持 fail-closed，不开放给 MCP",
        ));
    }
    Ok(())
}

pub fn pattern_matches(pattern: &str, name: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => name.starts_with(prefix),
        None => pattern == name,
    }
}

pub fn approved_tool(name: &str, scope: &McpSessionScope) -> bool {
    scope
        .approved_tools
        .iter()
        .any(|p| pattern_matches(p, name))
}

/// privileged 工具要求**精确名字**授权：通配 `*` / `launcher_*` 不构成显式批准
/// （冻结契约③：危险工具默认不进 tools/list，宿主显式授权）。
pub fn approved_privileged_tool(name: &str, scope: &McpSessionScope) -> bool {
    scope.approved_tools.iter().any(|p| p == name)
}

/// `tools/call` 的会话闸门（纯函数，端点级可测）：market fail-closed；
/// privileged 未获精确授权 ⇒ 显式 `E_TOOL_NOT_APPROVED`。
/// 闸门命中处由 `server::handle_webview` 写一条 `AuditOutcome::Denied` 审计。
pub fn check_tool_call_permission(name: &str, scope: &McpSessionScope) -> Result<(), McpError> {
    validate_tool_name(name)?;
    if is_privileged_tool(name) && !approved_privileged_tool(name, scope) {
        return Err(McpError::new(
            codes::TOOL_NOT_APPROVED,
            format!("危险工具未获会话授权：{name}"),
        ));
    }
    Ok(())
}

pub struct FilterOutcome {
    pub result: Value,
    /// 被剔除的工具名（供审计记 `filtered`）。
    pub filtered: Vec<String>,
}

/// 危险工具在 Rust 侧再过滤一道（纵深）：按**会话 tier + approvedTools** 双维度过滤。
/// - `market_*` 无条件剔除（fail-closed）；
/// - privileged 工具必须精确出现在 `scope.approvedTools`，否则一律不返回；
/// - 非 privileged 工具若宿主推断所需 tier 高于会话 tier 且未显式批准，也剔除
///   （read 会话拿不到 `write_*` / `edit_*` 这类编辑工具）；
/// - annotations 不可信，tier 只由宿主按工具名形状推断。
/// 同时把工具描述按不可信输入净化（限体积 + 去控制字符）。
pub fn filter_tools_list(result: &Value, scope: &McpSessionScope) -> FilterOutcome {
    let mut filtered = Vec::new();
    let Some(tools) = result.get("tools").and_then(Value::as_array) else {
        return FilterOutcome {
            result: sanitize_untrusted(result),
            filtered,
        };
    };
    let mut kept = Vec::with_capacity(tools.len());
    for tool in tools {
        let name = tool.get("name").and_then(Value::as_str).unwrap_or("");
        let drop = is_market_tool(name)
            || (is_privileged_tool(name) && !approved_privileged_tool(name, scope))
            || (!approved_tool(name, scope)
                && tier_rank(host_required_tier(name)) > tier_rank(scope.tier));
        if drop {
            filtered.push(name.to_string());
            continue;
        }
        kept.push(sanitize_tool_descriptor(tool));
    }
    let mut out = sanitize_untrusted(result);
    if let Some(obj) = out.as_object_mut() {
        obj.insert("tools".to_string(), Value::Array(kept));
    }
    FilterOutcome {
        result: out,
        filtered,
    }
}

fn sanitize_tool_descriptor(tool: &Value) -> Value {
    let mut v = sanitize_untrusted(tool);
    if let Some(obj) = v.as_object_mut() {
        if let Some(desc) = obj.get("description").and_then(Value::as_str) {
            let capped = truncate_chars(desc, MAX_DESCRIPTION_CHARS);
            obj.insert("description".to_string(), Value::String(capped));
        }
    }
    v
}

/// 不可信输入净化：去控制字符、单串限长、`description` 再收紧。
/// Rust 不据净化后的内容做任何决策——它只作为 JSON 值转发给 MCP 客户端。
pub fn sanitize_untrusted(v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(sanitize_string(s, MAX_UNTRUSTED_CHARS)),
        Value::Array(items) => Value::Array(items.iter().map(sanitize_untrusted).collect()),
        Value::Object(map) => {
            let mut out: Map<String, Value> = Map::new();
            for (key, child) in map {
                let nk = normalize_key(key);
                let cap = if nk == "description" {
                    MAX_DESCRIPTION_CHARS
                } else {
                    MAX_UNTRUSTED_CHARS
                };
                let cleaned = match sanitize_untrusted(child) {
                    Value::String(s) => Value::String(truncate_chars(&s, cap)),
                    other => other,
                };
                out.insert(key.clone(), cleaned);
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

pub fn sanitize_string(s: &str, cap: usize) -> String {
    let cleaned: String = s
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect();
    truncate_chars(&cleaned, cap)
}

pub fn truncate_chars(s: &str, cap: usize) -> String {
    if s.chars().count() <= cap {
        return s.to_string();
    }
    let mut out: String = s.chars().take(cap).collect();
    out.push_str("…[truncated]");
    out
}
