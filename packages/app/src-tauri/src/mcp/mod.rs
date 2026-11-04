//! MCP 宿主模块（路 C：Rust endpoint / 会话授权 / 审计）。
//!
//! 目录分派：`protocol`（线协议与安全闸门）/ `scope`（第四张授权表）/
//! `audit`（审计日志）/ `server`（本机 HTTP 端点）/ `mod.rs`（Tauri 命令面）。
//!
//! 冻结契约的四个命令 `mcp_start` / `mcp_stop` / `mcp_status` / `mcp_respond`
//! 名称与形状逐字不改；额外四个辅助命令供 WebView 侧的审批 / 审计面板使用
//! （MCP 客户端只能经 `POST /mcp` 调六种方法，够不到这些命令）。

mod audit;
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
    server::start(app, dir, state.inner()).map_err(cmd_err)
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
