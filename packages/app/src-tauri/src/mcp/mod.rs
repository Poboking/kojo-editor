//! MCP 宿主模块（路 C：Rust endpoint / 会话授权 / 审计）。
//!
//! 目录分派：`protocol`（线协议与安全闸门）/ `scope`（第四张授权表）/
//! `audit`（审计日志）/ `latency`（逐请求耗时台账）/ `server`（本机 HTTP 端点）/
//! `mod.rs`（Tauri 命令面）。
//!
//! 冻结契约的四个命令 `mcp_start` / `mcp_stop` / `mcp_status` / `mcp_respond`
//! 名称与形状逐字不改；额外四个辅助命令供 WebView 侧的审批 / 审计面板使用
//! （MCP 客户端只能经 `POST /mcp` 调六种方法，够不到这些命令）。

mod audit;
mod latency;
mod protocol;
mod scope;
mod server;

#[cfg(test)]
mod tests;

pub use server::McpState;

use protocol::{McpError, McpRespondArgs};
use server::{ApproveArgs, AuditQueryArgs, McpStartResult, McpStatus, RevokeArgs};
use tauri::{AppHandle, Manager};

fn cmd_err(e: McpError) -> String {
    format!("{}: {}", e.code, e.message)
}

/// 窗口 / 应用退出时清发现文件与后台线程（幂等；由 `lib.rs` 的 `Destroyed` 分支调用）。
pub fn cleanup_on_exit(state: &McpState) -> Result<(), String> {
    server::stop(state).map_err(cmd_err)
}

/// `mcp_start(enabled) -> {port, token, endpoint}`：
/// `enabled=false` 等价于 `mcp_stop` 并返回禁用态的空三元组。
#[tauri::command]
pub fn mcp_start(
    app: AppHandle,
    state: tauri::State<'_, McpState>,
    enabled: bool,
) -> Result<McpStartResult, String> {
    if !enabled {
        server::stop(state.inner()).map_err(cmd_err)?;
        return Ok(McpStartResult {
            port: 0,
            token: String::new(),
            endpoint: String::new(),
        });
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("E_INTERNAL: app_data_dir: {e}"))?;
    server::start(
        std::sync::Arc::new(server::TauriBridge(app)),
        dir,
        state.inner(),
    )
    .map_err(cmd_err)
}

#[tauri::command]
pub fn mcp_stop(state: tauri::State<'_, McpState>) -> Result<(), String> {
    server::stop(state.inner()).map_err(cmd_err)
}

#[tauri::command]
pub fn mcp_status(state: tauri::State<'_, McpState>) -> McpStatus {
    server::status(state.inner())
}

/// `mcp_respond(args)`：路 A 的 host-bridge 收到 `"mcp://request"` 后按 id 回填。
#[tauri::command]
pub fn mcp_respond(state: tauri::State<'_, McpState>, args: McpRespondArgs) -> Result<(), String> {
    server::deliver(state.inner(), args).map_err(cmd_err)
}

/* --------------- WebView 侧辅助命令（不暴露给 MCP 客户端） --------------- */

#[tauri::command]
pub fn mcp_approve(
    app: AppHandle,
    state: tauri::State<'_, McpState>,
    args: ApproveArgs,
) -> Result<scope::McpScopeState, String> {
    server::approve_session(&app, state.inner(), args).map_err(cmd_err)
}

#[tauri::command]
pub fn mcp_revoke(
    app: AppHandle,
    state: tauri::State<'_, McpState>,
    args: RevokeArgs,
) -> Result<scope::McpScopeState, String> {
    server::revoke_session(&app, state.inner(), args).map_err(cmd_err)
}

#[tauri::command]
pub fn mcp_scope_query(app: AppHandle) -> Result<scope::McpScopeState, String> {
    server::scope_query(&app).map_err(cmd_err)
}

#[tauri::command]
pub fn mcp_audit_query(
    app: AppHandle,
    args: AuditQueryArgs,
) -> Result<Vec<audit::AuditEntry>, String> {
    server::audit_query(&app, args).map_err(cmd_err)
}

/// 逐请求耗时台账 + 在途预算读数（B5 吞吐批）：真源＝`Pending.started` → 应答落账。
///
/// 与 `mcp_audit_query` 同一纵深——只由宿主侧（设置面板 / 调试壳 `invoke`）读，
/// MCP 客户端在 `POST /mcp` 协议里没有任何读写台账的入口。服务未启动时显式报错，
/// 不回空台账冒充「零延迟」（不静默）。
#[tauri::command]
pub fn mcp_latency_query(state: tauri::State<'_, McpState>) -> Result<serde_json::Value, String> {
    server::latency_query(state.inner()).map_err(cmd_err)
}

/// 接入台账（2026-11-06 接入可见性批）：首条已鉴权请求起有正面读数，含本地作答的
/// `initialize`。纯内存、按 clientId 去重、有界、随运行时存活；服务未启动显式报错。
/// 与 `mcp_latency_query` 同纵深——只由宿主侧读，MCP 客户端在 `POST /mcp` 里够不到。
#[tauri::command]
pub fn mcp_connections_query(
    state: tauri::State<'_, McpState>,
) -> Result<Vec<server::ClientConnect>, String> {
    server::connections_query(state.inner()).map_err(cmd_err)
}
