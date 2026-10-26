//! 日志采集与读取（§12.1）。
//!
//! 口径：
//! - **宿主不解码**：泵线程逐块读原始字节、原样写会话文件，事件里带 **base64**；
//!   解码（BOM / UTF-8 有效性 / fallback）在 TS 侧用既有编码探测单源做——宿主不做第二套；
//! - **按启动分文件**：`{sessionId}.stdout.log` / `.stderr.log` / `.json`，不覆盖历史；
//! - **节流**：≥64 KiB 或 ≥100 ms 合并一次事件（10k 行/秒的进程不会把 UI 打爆）；
//! - **读有上限**：`launcher_log_tail` / `launcher_log_read` 只回尾部一段（默认 1 MiB / 路），
//!   被截断时 `truncated=true`——UI 拿到的永远是"最近的一段字节"，不是整份文件。

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::error::{internal, io_failure, ErrorCode, LauncherErrorDto, LauncherResult};
use super::paths::{self, LauncherLayout};
use super::store::{self, StoredInstance};
use super::{unix_ms, LauncherHost, EVENT_LOG};

/// 事件合并阈值（契约常量）。
pub const LOG_EMIT_BYTES: usize = 64 * 1024;
pub const LOG_EMIT_INTERVAL: Duration = Duration::from_millis(100);
/// 单次读取的上限（超出部分只回尾部，`truncated=true`）。
pub const DEFAULT_MAX_BYTES: u64 = 1024 * 1024;

/// 两条流的累计字节数（泵线程写、监视线程在会话收尾时读）。
#[derive(Debug, Default)]
pub struct StreamCounters {
    stdout: AtomicU64,
    stderr: AtomicU64,
}

impl StreamCounters {
    fn add(&self, stream: &str, bytes: usize) {
        let slot = if stream == "stderr" {
            &self.stderr
        } else {
            &self.stdout
        };
        slot.fetch_add(bytes as u64, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> (u64, u64) {
        (
            self.stdout.load(Ordering::SeqCst),
            self.stderr.load(Ordering::SeqCst),
        )
    }
}

/// 会话记录（与 `LogSession` 同形）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogSessionDto {
    pub id: String,
    pub instance_id: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub exit_code: Option<i64>,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
}

/// 一块**原始字节**（宿主不解码；`stream` 告诉前端该用哪条解码通道）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogChunkDto {
    pub stream: String,
    pub ts: u64,
    pub bytes_base64: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogPageDto {
    pub session: LogSessionDto,
    pub chunks: Vec<LogChunkDto>,
    pub truncated: bool,
}

/// 前端查询（`LogQuery` 的宿主侧子集）。
///
/// `maxLines` 收而不解：宿主不做行切分（解码在 TS 侧），只按 `maxBytes` 截断；
/// 契约里 `maxLines` 的语义由 TS 侧在已解码的缓冲上执行。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LogQuery {
    pub session_id: Option<String>,
    pub max_bytes: Option<u64>,
    pub stream: Option<String>,
    pub max_lines: Option<u64>,
}

fn session_file(layout: &LauncherLayout, instance_id: &str, session_id: &str) -> Option<PathBuf> {
    layout
        .logs_dir(instance_id)
        .ok()
        .map(|dir| dir.join(format!("{session_id}.json")))
}

/// 会话 id 与实例 id 同形（ASCII 字母数字 + `-`）：它同时是文件名，必须先过形状闸。
pub fn valid_session_id(raw: &str) -> bool {
    paths::valid_instance_id(raw)
}

pub fn begin_session(
    layout: &LauncherLayout,
    instance_id: &str,
    session_id: &str,
    started_at: &str,
) -> LauncherResult<()> {
    if !valid_session_id(session_id) {
        return Err(internal("会话 id 形状非法").detail(session_id.to_string()));
    }
    let dir = layout.logs_dir(instance_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| io_failure("创建日志目录", &dir, &e))?;
    // 先各建一份空文件：泵线程只以 append 打开，不做"文件不存在时创建"的分支
    for suffix in ["stdout", "stderr"] {
        let path = dir.join(format!("{session_id}.{suffix}.log"));
        std::fs::File::create(&path).map_err(|e| io_failure("创建日志文件", &path, &e))?;
    }
    let session = LogSessionDto {
        id: session_id.to_string(),
        instance_id: instance_id.to_string(),
        started_at: started_at.to_string(),
        ended_at: None,
        exit_code: None,
        stdout_bytes: 0,
        stderr_bytes: 0,
    };
    let path =
        session_file(layout, instance_id, session_id).ok_or_else(|| internal("日志目录不可用"))?;
    store::write_json(&path, &session)
}

pub fn finish_session(
    layout: &LauncherLayout,
    instance_id: &str,
    session_id: &str,
    ended_at: &str,
    exit_code: Option<i64>,
    stdout_bytes: u64,
    stderr_bytes: u64,
) -> LauncherResult<()> {
    let path =
        session_file(layout, instance_id, session_id).ok_or_else(|| internal("日志目录不可用"))?;
    let mut session =
        store::read_json::<LogSessionDto>(&path, "日志会话")?.unwrap_or(LogSessionDto {
            id: session_id.to_string(),
            instance_id: instance_id.to_string(),
            started_at: ended_at.to_string(),
            ended_at: None,
            exit_code: None,
            stdout_bytes: 0,
            stderr_bytes: 0,
        });
    session.ended_at = Some(ended_at.to_string());
    session.exit_code = exit_code;
    session.stdout_bytes = stdout_bytes;
    session.stderr_bytes = stderr_bytes;
    store::write_json(&path, &session)
}

/// 某实例的全部会话（按开始时间倒序；损坏的会话文件跳过并在宿主日志出声）。
pub fn sessions(layout: &LauncherLayout, instance_id: &str) -> LauncherResult<Vec<LogSessionDto>> {
    let dir = layout.logs_dir(instance_id)?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(io_failure("读取日志目录", &dir, &err)),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        match store::read_json::<LogSessionDto>(&path, "日志会话") {
            Ok(Some(session)) => out.push(session),
            Ok(None) => {}
            Err(err) => eprintln!(
                "[launcher] 日志会话文件不可读，已跳过：{}（{}）",
                path.display(),
                err.message
            ),
        }
    }
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(out)
}

/// 会话 id → (实例 id, 会话记录)。`sessionId` 必须真属于某个实例（契约 §7.2）。
pub fn find_session(
    layout: &LauncherLayout,
    session_id: &str,
) -> LauncherResult<(String, LogSessionDto)> {
    if !valid_session_id(session_id) {
        return Err(internal("会话 id 形状非法").detail(session_id.to_string()));
    }
    let entries = std::fs::read_dir(layout.instances_dir())
        .map_err(|e| io_failure("读取实例目录", &layout.instances_dir(), &e))?;
    for entry in entries.flatten() {
        let instance_id = entry.file_name().to_string_lossy().to_string();
        if !paths::valid_instance_id(&instance_id) {
            continue;
        }
        let Some(path) = session_file(layout, &instance_id, session_id) else {
            continue;
        };
        if let Ok(Some(session)) = store::read_json::<LogSessionDto>(&path, "日志会话") {
            return Ok((instance_id, session));
        }
    }
    Err(
        LauncherErrorDto::new(ErrorCode::InstanceNotFound, "找不到这个日志会话")
            .detail(format!("sessionId={session_id}")),
    )
}

/// 读文件尾部（最多 `max_bytes`）；返回 (字节, 是否被截断)。
fn read_tail(path: &Path, max_bytes: u64) -> LauncherResult<(Vec<u8>, bool)> {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), false)),
        Err(err) => return Err(io_failure("打开日志文件", path, &err)),
    };
    let len = file
        .metadata()
        .map_err(|e| io_failure("读日志文件大小", path, &e))?
        .len();
    let truncated = len > max_bytes;
    if truncated {
        file.seek(SeekFrom::Start(len - max_bytes))
            .map_err(|e| io_failure("定位日志尾部", path, &e))?;
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .map_err(|e| io_failure("读取日志", path, &e))?;
    Ok((buf, truncated))
}

fn file_ts_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_else(|| unix_ms() as u64)
}

fn page_of(
    layout: &LauncherLayout,
    instance_id: &str,
    session: LogSessionDto,
    query: &LogQuery,
) -> LauncherResult<LogPageDto> {
    let max_bytes = query.max_bytes.unwrap_or(DEFAULT_MAX_BYTES).max(1);
    let wanted: Vec<&str> = match query.stream.as_deref() {
        Some("stdout") => vec!["stdout"],
        Some("stderr") => vec!["stderr"],
        _ => vec!["stdout", "stderr"],
    };
    let dir = layout.logs_dir(instance_id)?;
    let mut chunks = Vec::new();
    let mut truncated = false;
    for stream in wanted {
        let path = dir.join(format!("{}.{stream}.log", session.id));
        let (bytes, cut) = read_tail(&path, max_bytes)?;
        truncated = truncated || cut;
        if bytes.is_empty() {
            continue;
        }
        chunks.push(LogChunkDto {
            stream: stream.to_string(),
            ts: file_ts_ms(&path),
            bytes_base64: B64.encode(&bytes),
            truncated: cut,
        });
    }
    Ok(LogPageDto {
        session,
        chunks,
        truncated,
    })
}

/// 最新一场会话的尾部（`launcher_log_tail`）。
pub fn tail(
    layout: &LauncherLayout,
    instance_id: &str,
    query: &LogQuery,
) -> LauncherResult<LogPageDto> {
    let list = sessions(layout, instance_id)?;
    let session = match query.session_id.as_deref() {
        Some(id) => list
            .into_iter()
            .find(|session| session.id == id)
            .ok_or_else(|| {
                LauncherErrorDto::new(ErrorCode::InstanceNotFound, "找不到这个日志会话")
                    .detail(format!("sessionId={id}"))
            })?,
        None => match list.into_iter().next() {
            Some(session) => session,
            None => {
                return Err(LauncherErrorDto::new(
                    ErrorCode::InstanceNotFound,
                    "这个实例还没有运行日志",
                )
                .detail(format!("instance={instance_id}")))
            }
        },
    };
    page_of(layout, instance_id, session, query)
}

/// 按 `sessionId` 读（`launcher_log_read`）：会话必须属于某个实例。
pub fn read(
    layout: &LauncherLayout,
    session_id: &str,
    query: &LogQuery,
) -> LauncherResult<LogPageDto> {
    let (instance_id, session) = find_session(layout, session_id)?;
    page_of(layout, &instance_id, session, query)
}

/// 导出用的字节块（原生保存对话框由命令层弹，**写盘与对话框同一命令**）。
///
/// 首版是单文件 `.log`：ASCII 分隔头 + 两路原始字节；`includeDiagnostics=true` 时在末尾
/// 追加实例概况（**只含 id / 名称 / 类型，不含任何绝对路径**——诊断包默认路径脱敏）。
pub fn export_bytes(
    layout: &LauncherLayout,
    instance: &StoredInstance,
    session_id: Option<&str>,
    include_diagnostics: bool,
) -> LauncherResult<(String, Vec<u8>)> {
    let list = sessions(layout, &instance.id)?;
    let session = match session_id {
        Some(id) => list
            .into_iter()
            .find(|session| session.id == id)
            .ok_or_else(|| {
                LauncherErrorDto::new(ErrorCode::InstanceNotFound, "找不到这个日志会话")
                    .detail(format!("sessionId={id}"))
            })?,
        None => list.into_iter().next().ok_or_else(|| {
            LauncherErrorDto::new(ErrorCode::InstanceNotFound, "这个实例还没有运行日志")
        })?,
    };
    let dir = layout.logs_dir(&instance.id)?;
    let mut body: Vec<u8> = Vec::new();
    let header = format!(
        "# launcher log export\n# instance: {}\n# session: {}\n# startedAt: {}\n# endedAt: {}\n",
        instance.id,
        session.id,
        session.started_at,
        session.ended_at.clone().unwrap_or_default()
    );
    body.extend_from_slice(header.as_bytes());
    for stream in ["stdout", "stderr"] {
        let path = dir.join(format!("{}.{stream}.log", session.id));
        let (bytes, _) = read_tail(&path, u64::MAX / 2)?;
        body.extend_from_slice(format!("\n--- {stream} ---\n").as_bytes());
        body.extend_from_slice(&bytes);
        body.push(b'\n');
    }
    if include_diagnostics {
        // 诊断段只挑**不含绝对路径**的字段：sourceRoot / 目录都不写
        let diagnostics = json!({
            "instanceId": instance.id,
            "name": instance.name,
            "adapterId": instance.adapter_id,
            "gameId": instance.game_id,
            "isolation": instance.isolation,
            "state": instance.state,
            "executableRelativePath": instance.executable.relative_path,
            "executableSha256": instance.executable.sha256,
            "runtimeId": instance.runtime_id,
            "launchCount": instance.launch_count,
            "exit": session.exit_code,
            "stdoutBytes": session.stdout_bytes,
            "stderrBytes": session.stderr_bytes,
        });
        body.extend_from_slice(b"\n--- diagnostics ---\n");
        body.extend_from_slice(
            serde_json::to_vec_pretty(&diagnostics)
                .map_err(|e| internal("诊断段序列化失败").detail(e.to_string()))?
                .as_slice(),
        );
        body.push(b'\n');
    }
    let suggested = format!("launcher-{}-{}.log", instance.id, session.id);
    Ok((suggested, body))
}

/* ------------------------------- 日志泵 ------------------------------- */

/// 起一条泵线程：逐块读 → 写会话文件 → 节流发事件（base64，宿主不解码）。
pub fn spawn_pump(
    host: Arc<LauncherHost>,
    instance_id: String,
    session_id: String,
    stream: &'static str,
    path: PathBuf,
    mut reader: Box<dyn Read + Send>,
    counters: Arc<StreamCounters>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name(format!("launcher-log-{stream}-{instance_id}"))
        .spawn(move || {
            let mut file = match std::fs::OpenOptions::new().append(true).open(&path) {
                Ok(file) => file,
                Err(err) => {
                    eprintln!("[launcher] 日志文件打不开（{}）：{err}", path.display());
                    return;
                }
            };
            let mut buf = vec![0u8; 8 * 1024];
            let mut pending: Vec<u8> = Vec::new();
            let mut last_emit = Instant::now();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(read) => {
                        let chunk = &buf[..read];
                        counters.add(stream, read);
                        let _ = file.write_all(chunk);
                        pending.extend_from_slice(chunk);
                        if pending.len() >= LOG_EMIT_BYTES
                            || last_emit.elapsed() >= LOG_EMIT_INTERVAL
                        {
                            emit_chunk(&host, &instance_id, &session_id, stream, &pending);
                            pending.clear();
                            last_emit = Instant::now();
                        }
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            if !pending.is_empty() {
                emit_chunk(&host, &instance_id, &session_id, stream, &pending);
            }
            let _ = file.flush();
        })
        .expect("日志泵线程必须起得来")
}

fn emit_chunk(
    host: &LauncherHost,
    instance_id: &str,
    session_id: &str,
    stream: &str,
    bytes: &[u8],
) {
    host.emit_event(
        EVENT_LOG,
        json!({
            "instanceId": instance_id,
            "sessionId": session_id,
            "stream": stream,
            "bytesBase64": B64.encode(bytes),
        }),
    );
}
