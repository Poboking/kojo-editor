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
//! 纵深：单行体积上限（字段截断 + 超限显式报错）、主文件超限轮转 `.1`、
//! 损坏行（含非法 UTF-8）容错跳过；历史粘连行（一行多条 JSON）只读拆回、不改盘；
//! MCP 侧没有任何写入/删除/改写审计的入口。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::fs::OpenOptions;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use super::protocol::{codes, truncate_chars, McpError};

pub const AUDIT_FILE: &str = "mcp_audit.jsonl";
pub const AUDIT_ROTATED_FILE: &str = "mcp_audit.jsonl.1";
pub const MAX_AUDIT_QUERY: usize = 200;
/// 单行体积上限（字节）：每个字符串字段先截断，序列化后仍超限则显式报错，不静默写半行。
pub const MAX_AUDIT_LINE_BYTES: usize = 4096;
/// 主文件体积上限：超过即轮转成 `.1`（旧 `.1` 覆盖），防止审计无限膨胀。
pub const MAX_AUDIT_FILE_BYTES: u64 = 1024 * 1024;

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
    #[allow(dead_code)] // 仅 `#[cfg(test)]` 的 outcome 字符串判据消费；落盘由 serde(rename_all) 负责，非 test 构建用不到
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
    /// 宿主侧真读数：`Pending.started` → 应答落账（毫秒）。缺真源就不写这一格
    /// （不拿估算冒充实测）；旧审计行没有该字段，读出按 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
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

/// 体积上限（字段级）：每个字符串字段先按上限截断，保证单行不超 MAX_AUDIT_LINE_BYTES。
fn bounded_entry(entry: &AuditEntry) -> AuditEntry {
    AuditEntry {
        ts: truncate_chars(&entry.ts, 64),
        client_id: truncate_chars(&entry.client_id, 128),
        session_id: truncate_chars(&entry.session_id, 128),
        tool: truncate_chars(&entry.tool, 128),
        args_digest: truncate_chars(&entry.args_digest, 1024),
        outcome: entry.outcome,
        landed_path: entry.landed_path.as_deref().map(|p| truncate_chars(p, 256)),
        elapsed_ms: entry.elapsed_ms,
        note: entry.note.as_deref().map(|n| truncate_chars(n, 512)),
    }
}

/// 轮转：主文件超过 max_bytes 时改名为 `.1`（覆盖旧 `.1`），下一次 append 重建主文件。
pub fn rotate_if_needed(app_data_dir: &Path, max_bytes: u64) -> Result<bool, McpError> {
    let path = audit_path(app_data_dir);
    let len = match std::fs::metadata(&path) {
        Ok(m) => m.len(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => {
            return Err(McpError::new(
                codes::INTERNAL,
                format!("读审计日志元数据失败：{e}"),
            ))
        }
    };
    if len <= max_bytes {
        return Ok(false);
    }
    let rotated = app_data_dir.join(AUDIT_ROTATED_FILE);
    if rotated.exists() {
        std::fs::remove_file(&rotated)
            .map_err(|e| McpError::new(codes::INTERNAL, format!("删除旧轮转文件失败：{e}")))?;
    }
    std::fs::rename(&path, &rotated)
        .map_err(|e| McpError::new(codes::INTERNAL, format!("轮转审计日志失败：{e}")))?;
    Ok(true)
}

/// 按 appData 目录分片的短锁：同一目录的「轮转 + 打开 + 追加」串行，不同目录
/// （尤其并行测试里几十个临时目录）互不阻塞。O_APPEND 已保证单次 write 原子，
/// 这把锁另挡两件真事：Windows 上多线程并发 open 同路径会「拒绝访问」，以及
/// 轮转 rename 与 open 的竞争。**不要**换成全局一把锁——逐连接落账会被串行化。
static AUDIT_LOCKS: OnceLock<Vec<Mutex<()>>> = OnceLock::new();

fn lock_audit_io(dir: &Path) -> std::sync::MutexGuard<'static, ()> {
    let locks = AUDIT_LOCKS.get_or_init(|| (0..32).map(|_| Mutex::new(())).collect());
    let mut hasher = DefaultHasher::new();
    dir.hash(&mut hasher);
    let idx = (hasher.finish() as usize) % locks.len();
    locks[idx]
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn append(app_data_dir: &Path, entry: &AuditEntry) -> Result<(), McpError> {
    let _guard = lock_audit_io(app_data_dir);
    std::fs::create_dir_all(app_data_dir)
        .map_err(|e| McpError::new(codes::INTERNAL, format!("建审计目录失败：{e}")))?;
    rotate_if_needed(app_data_dir, MAX_AUDIT_FILE_BYTES)?;
    let line = serde_json::to_string(&bounded_entry(entry))
        .map_err(|e| McpError::new(codes::INTERNAL, format!("序列化审计条目失败：{e}")))?;
    if line.len() > MAX_AUDIT_LINE_BYTES {
        return Err(McpError::new(
            codes::INTERNAL,
            format!(
                "审计条目体积超限：{} > {}",
                line.len(),
                MAX_AUDIT_LINE_BYTES
            ),
        ));
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(audit_path(app_data_dir))
        .map_err(|e| McpError::new(codes::INTERNAL, format!("打开审计日志失败：{e}")))?;
    // 一行必须在**单次 write**里落盘：旧写法 `writeln!(file, "{line}")` 会拆成
    // 「JSON」与「换行」两次 write；O_APPEND 只保证每次 write 原子，两个请求线程的
    // JSON 就会粘成一行（读侧报 trailing characters）。合成 buffer 后一次 write_all，
    // 由 O_APPEND 保证追加原子；上面的分片锁只串行化同目录的整段 IO，不跨目录阻塞。
    let mut buf = line.into_bytes();
    buf.push(b'\n');
    file.write_all(&buf)
        .map_err(|e| McpError::new(codes::INTERNAL, format!("写审计日志失败：{e}")))?;
    Ok(())
}

/// 旧版两次 write 交错会把两条 JSON 粘在同一行（无分隔符）。用 stream deserializer
/// 逐对象读回，**全部**都是完整合法的 AuditEntry 才认；末尾残缺 / 类型不符一律判失败，
/// 免得把半条记录当成真记录。只读恢复，不改写盘上的审计原文。
fn recover_concatenated(line: &str) -> Vec<AuditEntry> {
    let mut out = Vec::new();
    for item in serde_json::Deserializer::from_str(line).into_iter::<AuditEntry>() {
        match item {
            Ok(entry) => out.push(entry),
            Err(_) => return Vec::new(),
        }
    }
    out
}

/// 查最近 N 条（可按 clientId 过滤）；损坏行（截断 JSON / 类型不符 / 非法 UTF-8 /
/// 空行）出声后跳过，不静默当成功，也不因单行坏掉让整次查询失败。历史粘连行
/// （一行多条完整 JSON）逐条读回，同样出声。
pub fn query(
    app_data_dir: &Path,
    limit: usize,
    client_id: Option<&str>,
) -> Result<Vec<AuditEntry>, McpError> {
    let _guard = lock_audit_io(app_data_dir);
    let path = audit_path(app_data_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = std::fs::File::open(&path)
        .map_err(|e| McpError::new(codes::INTERNAL, format!("读审计日志失败：{e}")))?;
    let mut reader = BufReader::new(file);
    let mut all = Vec::new();
    let mut buf: Vec<u8> = Vec::new();
    let mut line_no = 0usize;
    loop {
        buf.clear();
        let n = reader
            .read_until(b'\n', &mut buf)
            .map_err(|e| McpError::new(codes::INTERNAL, format!("读审计行失败：{e}")))?;
        if n == 0 {
            break;
        }
        line_no += 1;
        while buf.last() == Some(&b'\n') || buf.last() == Some(&b'\r') {
            buf.pop();
        }
        // from_utf8_lossy：非法字节不致命，整行按损坏跳过。
        let text = String::from_utf8_lossy(&buf);
        let line = text.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<AuditEntry>(line) {
            Ok(entry) => {
                if client_id.map_or(true, |cid| entry.client_id == cid) {
                    all.push(entry);
                }
            }
            Err(e) => {
                let recovered = recover_concatenated(line);
                if recovered.len() >= 2 {
                    eprintln!(
                        "[mcp-audit] 第 {} 行粘连 {} 条记录，已逐条读出（{}）",
                        line_no,
                        recovered.len(),
                        e
                    );
                    for entry in recovered {
                        if client_id.map_or(true, |cid| entry.client_id == cid) {
                            all.push(entry);
                        }
                    }
                } else {
                    eprintln!("[mcp-audit] 第 {} 行损坏，跳过：{}", line_no, e);
                }
            }
        }
    }
    let cap = limit.clamp(1, MAX_AUDIT_QUERY);
    let start = all.len().saturating_sub(cap);
    Ok(all[start..].to_vec())
}
