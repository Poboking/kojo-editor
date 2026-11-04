//! 第四张授权表：MCP 会话授权（`%APPDATA%/dev.kojo.editor/mcp_approvals.json`）。
//!
//! **互不继承（冻结契约③ / AGENTS.md 铁律 7）**：本表与下面三张表没有任何继承或自动
//! 派生关系，各自独立签发、独立复验：
//!   1. 内核 `writablePaths`（JS 闸 `kernel/src/io.ts:1011 assertWritable`）；
//!   2. Rust `exportFile`（`lib.rs::export_file`；对话框与写盘绑在同一命令内）；
//!   3. 启动器 `launcher/paths.rs` 的 `approvals.json`。
//!
//! 本表只回答「某个 MCP 客户端会话能用哪一级 tier、哪些根、哪些工具」，**不授予任何
//! 写盘权限**：
//! - 项目内写仍要求内核 `assertWritable` + Rust `ensure_write_allowed` 双闸；
//! - 域外写只能走 `export_file` 的「对话框与写盘同一命令」形态，MCP 工具不得接受
//!   落点路径（见 `protocol.rs` 的路径闸门）；
//! - `open_url_external` / `launcher_*` / `market_*` / `export_file` 一律不自动落盘 /
//!   不自动放行；`market_*` 保持 fail-closed。
//!
//! 时间戳复用宿主时钟 `crate::launcher::iso_now()`（pub(crate)，不复制第二份日历算法）。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::protocol::{
    codes, is_market_tool, validate_relative_path, McpError, McpSessionScope, McpTier,
};

pub const SCOPE_FILE: &str = "mcp_approvals.json";
pub const ENDPOINT_FILE: &str = "mcp-endpoint.json";
pub const SCOPE_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpScopeState {
    pub version: u32,
    #[serde(default)]
    pub sessions: Vec<SessionGrant>,
}

impl Default for McpScopeState {
    fn default() -> Self {
        Self {
            version: SCOPE_VERSION,
            sessions: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionGrant {
    #[serde(rename = "clientId")]
    pub client_id: String,
    pub tier: McpTier,
    #[serde(rename = "approvedRoots", default)]
    pub approved_roots: Vec<String>,
    #[serde(rename = "approvedTools", default)]
    pub approved_tools: Vec<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "revokedAt", default, skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<String>,
}

pub fn scope_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(SCOPE_FILE)
}

pub fn endpoint_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(ENDPOINT_FILE)
}

/// 读第四张表：文件不存在 = 首次运行（空表，最小权限）；损坏 / 版本不符一律显式报错。
pub fn load(app_data_dir: &Path) -> Result<McpScopeState, McpError> {
    let path = scope_path(app_data_dir);
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let state: McpScopeState = serde_json::from_str(&text)
                .map_err(|e| McpError::new(codes::INTERNAL, format!("第四张表损坏：{e}")))?;
            if state.version != SCOPE_VERSION {
                return Err(McpError::new(
                    codes::INTERNAL,
                    format!("第四张表版本不符：{}", state.version),
                ));
            }
            Ok(state)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(McpScopeState::default()),
        Err(e) => Err(McpError::new(
            codes::INTERNAL,
            format!("读第四张表失败：{e}"),
        )),
    }
}

/// 原子写（唯一 tmp + rename）：`rename` 在同一卷上原子替换，读方永远看不到半截 JSON。
/// 暂存名带进程号 + 序号，避免并发审批互相覆盖同一个 tmp；失败路径清理暂存，不留残渣。
pub fn save(app_data_dir: &Path, state: &McpScopeState) -> Result<(), McpError> {
    std::fs::create_dir_all(app_data_dir)
        .map_err(|e| McpError::new(codes::INTERNAL, format!("建应用数据目录失败：{e}")))?;
    let text = serde_json::to_string_pretty(state)
        .map_err(|e| McpError::new(codes::INTERNAL, format!("序列化第四张表失败：{e}")))?;
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = app_data_dir.join(format!(
        ".{SCOPE_FILE}.{}-{}.tmp",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&tmp, text).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        McpError::new(codes::INTERNAL, format!("写第四张表暂存失败：{e}"))
    })?;
    std::fs::rename(&tmp, scope_path(app_data_dir)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        McpError::new(codes::INTERNAL, format!("落第四张表失败：{e}"))
    })?;
    Ok(())
}

pub fn validate_client_id(raw: &str) -> Result<(), McpError> {
    if raw.is_empty()
        || raw.len() > 64
        || !raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':'))
    {
        return Err(McpError::new(codes::INVALID_PARAMS, "clientId 形状非法"));
    }
    Ok(())
}

/// 授权项的工具名 / 通配模式形状闸：`market_*` 一律拒（fail-closed）。
fn validate_tool_pattern(pattern: &str) -> Result<(), McpError> {
    if pattern.is_empty()
        || pattern.len() > 64
        || !pattern
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'*'))
    {
        return Err(McpError::new(codes::INVALID_PARAMS, "工具授权项形状非法"));
    }
    if pattern.trim_end_matches('*').starts_with("market") {
        return Err(McpError::new(
            codes::TOOL_FAIL_CLOSED,
            "market_* 不可批准（fail-closed）",
        ));
    }
    Ok(())
}

/// 按客户端生成会话 scope（`mcp_start` 时调用；每个请求在 server 侧现算，反映最新审批）。
/// 表里出现越界根 / market 工具 ⇒ 显式报错（fail loud，不静默过滤）。
pub fn build_scope(
    state: &McpScopeState,
    client_id: &str,
    session_id: &str,
) -> Result<McpSessionScope, McpError> {
    validate_client_id(client_id)?;
    let grant = state
        .sessions
        .iter()
        .rev()
        .find(|g| g.client_id == client_id && g.revoked_at.is_none())
        .cloned();
    let (tier, approved_roots, approved_tools) = match grant {
        Some(g) => (g.tier, g.approved_roots, g.approved_tools),
        None => (McpTier::Read, Vec::new(), Vec::new()),
    };
    for root in &approved_roots {
        validate_relative_path(root)?;
    }
    for tool in &approved_tools {
        validate_tool_pattern(tool)?;
        if is_market_tool(tool) {
            return Err(McpError::new(
                codes::TOOL_FAIL_CLOSED,
                "第四张表含 market_* 授权，拒绝加载",
            ));
        }
    }
    Ok(McpSessionScope {
        session_id: session_id.to_string(),
        client_id: client_id.to_string(),
        tier,
        approved_roots,
        approved_tools,
    })
}

/// 一次批量审批：追加一条新 grant，同 client 的旧记录标 `revokedAt`（留痕不物理删）。
pub fn approve(
    app_data_dir: &Path,
    client_id: &str,
    tier: McpTier,
    roots: Vec<String>,
    tools: Vec<String>,
) -> Result<McpScopeState, McpError> {
    validate_client_id(client_id)?;
    for root in &roots {
        validate_relative_path(root)?;
    }
    for tool in &tools {
        validate_tool_pattern(tool)?;
    }
    let mut state = load(app_data_dir)?;
    let now = crate::launcher::iso_now();
    for grant in state.sessions.iter_mut() {
        if grant.client_id == client_id && grant.revoked_at.is_none() {
            grant.revoked_at = Some(now.clone());
        }
    }
    state.sessions.push(SessionGrant {
        client_id: client_id.to_string(),
        tier,
        approved_roots: roots,
        approved_tools: tools,
        created_at: now,
        revoked_at: None,
    });
    save(app_data_dir, &state)?;
    Ok(state)
}

pub fn revoke(app_data_dir: &Path, client_id: &str) -> Result<McpScopeState, McpError> {
    validate_client_id(client_id)?;
    let mut state = load(app_data_dir)?;
    let now = crate::launcher::iso_now();
    for grant in state.sessions.iter_mut() {
        if grant.client_id == client_id && grant.revoked_at.is_none() {
            grant.revoked_at = Some(now.clone());
        }
    }
    save(app_data_dir, &state)?;
    Ok(state)
}
