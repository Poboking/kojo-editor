//! MCP 审计日志（`%APPDATA%/dev.kojo.editor/mcp_audit.jsonl`）。
//!
//! **不可被 MCP 侧篡改**：MCP 客户端只能经 `POST /mcp` 调六种方法，协议里没有任何
//! 写审计 / 删审计 / 改审计的入口；文件落在 appData 由 Rust 宿主独占追加。
//! WebView 是受信任的宿主面（审计查询命令只在 WebView 侧调用，不暴露给 MCP）。
//!
//! 每笔 `tools/call` 留一条：时间、clientId、sessionId、工具名、参数摘要、结果
//! ok/error、落盘路径；`filtered` / `denied` / `timeout` / `cancelled` 也各留一条。
//! 参数只记**摘要**（键名 / 类型 / 长度），不落全文——工具描述与文件内容按不可信
//! 输入处理（MCP 2026-07-28：annotations 不可信），同时压住日志体积。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use super::protocol::{codes, truncate_chars, McpError};

pub const AUDIT_FILE: &str = "mcp_audit.jsonl";
pub const MAX_AUDIT_QUERY: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuditOutcome {
    Ok,
    Error,
    Filtered,
    Denied,
    Timeout,
    Cancelled,
}

impl AuditOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            AuditOutcome::Ok => "ok",
            AuditOutcome::Error => "error",
            AuditOutcome::Filtered => "filtered",
            AuditOutcome::Denied => "denied",
            AuditOutcome::Timeout => "timeout",
            AuditOutcome::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    /// ISO-8601 UTC（复用宿主时钟 `crate::launcher::iso_now()` 写入）。
    pub ts: String,
    pub client_id: String,
    pub session_id: String,
    pub tool: String,
    /// 参数摘要，绝不落全文。
    pub args_digest: String,
    pub outcome: AuditOutcome,
    /// 写盘落点：只由宿主侧写入；若取自 WebView 应答则 `note` 标明来源。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub landed_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

pub fn audit_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(AUDIT_FILE)
}

/// 参数摘要：递归只记键名 / 类型 / 长度，深度与键数都封顶，控制字符替换为 `_`。
pub fn digest_args(args: &Value) -> String {
    fn walk(v: &Value, out: &mut Vec<String>, depth: usize) {
        if depth > 4 {
            out.push("…".to_string());
            return;
        }
        match v {
            Value::Object(map) => {
                for (i, (key, child)) in map.iter().enumerate() {
                    if i >= 32 {
                        out.push("…".to_string());
                        break;
                    }
                    let safe_key = truncate_chars(
                        &key.chars()
                            .map(|c| if c.is_control() { '_' } else { c })
                            .collect::<String>(),
                        64,
                    );
                    match child {
                        Value::String(s) => {
                            out.push(format!("{safe_key}:str({})", s.chars().count()))
                        }
                        Value::Number(_) => out.push(format!("{safe_key}:num")),
                        Value::Bool(_) => out.push(format!("{safe_key}:bool")),
                        Value::Null => out.push(format!("{safe_key}:null")),
                        _ => {
                            out.push(format!("{safe_key}:"));
                            walk(child, out, depth + 1);
                        }
                    }
                }
            }
            Value::Array(items) => out.push(format!("arr({})", items.len())),
            _ => out.push("scalar".to_string()),
        }
    }
    let mut parts = Vec::new();
    walk(args, &mut parts, 0);
    truncate_chars(&parts.join(","), 1024)
}

pub fn append(app_data_dir: &Path, entry: &AuditEntry) -> Result<(), McpError> {
    std::fs::create_dir_all(app_data_dir)
        .map_err(|e| McpError::new(codes::INTERNAL, format!("建审计目录失败：{e}")))?;
    let line = serde_json::to_string(entry)
        .map_err(|e| McpError::new(codes::INTERNAL, format!("序列化审计条目失败：{e}")))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(audit_path(app_data_dir))
        .map_err(|e| McpError::new(codes::INTERNAL, format!("打开审计日志失败：{e}")))?;
    writeln!(file, "{line}")
        .map_err(|e| McpError::new(codes::INTERNAL, format!("写审计日志失败：{e}")))?;
    Ok(())
}

/// 查最近 N 条（可按 clientId 过滤）；损坏行出声后跳过，不静默当成功。
pub fn query(
    app_data_dir: &Path,
    limit: usize,
    client_id: Option<&str>,
) -> Result<Vec<AuditEntry>, McpError> {
    let path = audit_path(app_data_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = std::fs::File::open(&path)
        .map_err(|e| McpError::new(codes::INTERNAL, format!("读审计日志失败：{e}")))?;
    let mut all = Vec::new();
    for (i, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|e| {
            McpError::new(codes::INTERNAL, format!("读审计行失败：{e}"))
        })?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<AuditEntry>(&line) {
            Ok(entry) => {
                if client_id.map_or(true, |cid| entry.client_id == cid) {
                    all.push(entry);
                }
            }
            Err(e) => eprintln!("[mcp-audit] 第 {} 行损坏，跳过：{}", i + 1, e),
        }
    }
    let cap = limit.clamp(1, MAX_AUDIT_QUERY);
    let start = all.len().saturating_sub(cap);
    Ok(all[start..].to_vec())
}
