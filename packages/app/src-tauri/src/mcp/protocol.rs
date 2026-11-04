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
        .or_else(|| {
            params.pointer("/_meta/io.modelcontextprotocol~1capabilities")
        })
        .cloned()
        .unwrap_or_else(|| json!({}));
    Negotiation {
        protocol_version,
        client_capabilities,
        server_capabilities: server_capabilities(),
    }
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

fn normalize_key(key: &str) -> String {
    key.to_lowercase().replace(['_', '-'], "")
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
];

/// 落点型参数键：MCP 工具**不得**接受任意目标路径（法定通道是 export_file 的
/// 「对话框与写盘绑在同一 Rust 命令」）。命中即显式报错，不静默剥离。
const FORBIDDEN_TARGET_KEYS: &[&str] = &[
    "targetpath",
    "destinationpath",
    "destination",
    "outputpath",
    "savepath",
    "writepath",
    "writeto",
    "absolutepath",
    "exportpath",
    "output",
    "outputdir",
    "targetdir",
    "landingpath",
];

/// 校验六方法的 params：禁止落点参数 + 路径型参数越界显式报错。
pub fn validate_params(method: WebMethod, params: &Value) -> Result<(), McpError> {
    scan_forbidden_targets(params)?;
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
                if FORBIDDEN_TARGET_KEYS.contains(&normalize_key(key).as_str()) {
                    return Err(McpError::new(
                        codes::PATH_TARGET_FORBIDDEN,
                        format!(
                            "MCP 工具不接受目标落点参数 {key}（写盘落点只由宿主对话框决定）"
                        ),
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

/// 项目内相对路径判据：拒空 / 过长 / 控制字符 / 绝对路径 / 盘符 / UNC / `..` /
/// `.` / 尾点尾空格 / 设备保留名。越界一律显式报错（fail loud）。
pub fn validate_relative_path(raw: &str) -> Result<(), McpError> {
    let bad = |why: &str| -> Result<(), McpError> {
        Err(McpError::new(
            codes::PATH_ESCAPE,
            format!("路径越界（{why}）：{raw}"),
        ))
    };
    if raw.is_empty() {
        return bad("空路径");
    }
    if raw.len() > 512 {
        return bad("过长");
    }
    if raw.bytes().any(|b| b == 0 || (b < 0x20 && b != b'\t')) {
        return bad("含控制字符或 NUL");
    }
    if raw.starts_with('/') || raw.starts_with('\\') || raw.starts_with('~') {
        return bad("绝对路径或 UNC 前缀");
    }
    if raw.contains(':') {
        return bad("盘符 / scheme / ADS 冒号");
    }
    let normalized = raw.replace('\\', "/");
    for comp in normalized.split('/') {
        if comp.is_empty() || comp == "." || comp == ".." {
            return bad("空 / 点 / 上跳组件");
        }
        if comp.ends_with('.') || comp.ends_with(' ') {
            return bad("尾点或尾空格");
        }
        if is_device_name(comp) {
            return bad("设备保留名");
        }
    }
    Ok(())
}

fn is_device_name(comp: &str) -> bool {
    let stem = comp.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit())
}

/// `kojo://` 资源 URI：拒绝对路径形态 / `..` / 控制字符；query/fragment 只做长度约束。
pub fn validate_kojo_uri(raw: &str) -> Result<(), McpError> {
    let rest = raw
        .strip_prefix("kojo://")
        .ok_or_else(|| McpError::new(codes::PATH_SCHEME, "不是 kojo:// 资源 URI"))?;
    if rest.is_empty() || rest.len() > 512 {
        return Err(McpError::new(codes::PATH_ESCAPE, "kojo:// 资源路径为空或过长"));
    }
    if rest.starts_with('/') || rest.starts_with('\\') {
        return Err(McpError::new(
            codes::PATH_ESCAPE,
            "kojo:// 不接受绝对形态",
        ));
    }
    if rest.bytes().any(|b| b == 0 || b < 0x20) {
        return Err(McpError::new(codes::PATH_ESCAPE, "kojo:// 含控制字符"));
    }
    if rest.contains('\\') {
        return Err(McpError::new(
            codes::PATH_ESCAPE,
            "kojo:// 不接受反斜杠分隔",
        ));
    }
    let path = rest.split(['?', '#']).next().unwrap_or(rest);
    for comp in path.replace('\\', "/").split('/') {
        if comp.is_empty() || comp == "." || comp == ".." || comp.contains(':') {
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

pub struct FilterOutcome {
    pub result: Value,
    /// 被剔除的工具名（供审计记 `filtered`）。
    pub filtered: Vec<String>,
}

/// 危险工具在 Rust 侧再过滤一道（任务 6）：即使 WebView 误返回 privileged 工具，
/// 未出现在 `scope.approvedTools` 的一律剔除；`market_*` 无条件剔除（fail-closed）。
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
            || (is_privileged_tool(name) && !approved_tool(name, scope));
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
