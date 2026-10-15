//! 市场（无服务器口上包分发）的两个 IO 原语：**远程下载** 与 **ZIP 安全解压**。
//!
//! 分层（ADR-0003：Rust 只做 IO 原语、零业务逻辑、零游戏知识）：
//! - **不算任何哈希**：SHA-256 的唯一实现点在 TS（`plugins/kojo-market/src/digest.ts`），
//!   校验语义属于"判定"，判定不下沉本层；本层只保证"字节落盘"与"解压不越界"。
//! - **落点决定权在本层**：命令不接受绝对目标路径，只接受一个受限的暂存名字，
//!   真实落点由本层拼成 `<appDataDir>/market/.staging/...`（形态照 `export_file`：
//!   授权绑在命令内，JS 拿不到落点决定权）。正式目录的搬运由 TS 侧 `io.rename` 原子完成。
//! - **限额由 TS 从契约常量传入**（`plugin-api/market.ts`），本层不写死第二份真相；
//!   只有下载侧的超时/体积默认值是本地常量（TS 未传时的唯一兜底口径）。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};

use crate::{ensure_write_allowed, WriteDomainState};

/* --------------------------- 编译期固定的闸 --------------------------- */

/// 下载主机白名单：**编译期常量**，没有任何运行时注入白名单的入口。
const MARKET_HOST_ALLOWLIST: [&str; 4] = [
    "github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];
/// 白名单里唯一的非精确主机：GitHub Pages 的 `*.github.io`（只准一级子域）。
const MARKET_GITHUB_PAGES_SUFFIX: &str = ".github.io";
/// 重定向跳数上限（不含首跳）。实测 release 资产是
/// `github.com/.../releases/download/...` → 302 → `release-assets.githubusercontent.com`，
/// 每一跳都必须重核白名单，否则白名单等于没设。
const MARKET_MAX_REDIRECT_HOPS: usize = 5;
const MARKET_DEFAULT_TIMEOUT_MS: u64 = 60_000;
const MARKET_DEFAULT_MAX_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024;
const MARKET_USER_AGENT: &str = "kojo-editor-market";

/// 市场在应用数据区的根 / 暂存子目录（与契约 `MARKET_DIR_NAME` / `MARKET_STAGING_DIR` 同字面；
/// 本层必须自己拼落点，这是"落点决定权留在 Rust"的代价，不是第二份业务真相）。
const MARKET_DIR_NAME: &str = "market";
const MARKET_STAGING_DIR_NAME: &str = ".staging";
/// 暂存名字符集：小写字母数字与 `.` `_` `-`，长度 1..=64，且不能是纯点名（`.` / `..`）。
const STAGING_NAME_MAX: usize = 64;
const ZIP_SUFFIX: &str = ".zip";

/// unix 文件类型位（zip 的 `external_attr` 高 16 位）。
const S_IFMT: u32 = 0o170000;
const S_IFREG: u32 = 0o100000;

/* ------------------------------- DTO ------------------------------- */

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MarketDownloadResultDto {
    pub bytes: u64,
    pub status: u16,
    pub final_url: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedEntryDto {
    /// posix 分隔符（`/`），与契约 `packEntryPathProblem` 的口径一致。
    pub path: String,
    pub bytes: u64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MarketExtractResultDto {
    pub entries: Vec<ExtractedEntryDto>,
    pub total_bytes: u64,
}

/// 解压限额：三个数**全部由调用方从契约常量传入**，缺一个就报 serde 错，不给默认值
/// （默认值 = 本层私藏的第二份真相）。
#[derive(Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct StagingLimits {
    pub max_entries: usize,
    pub max_depth: usize,
    pub max_unpacked_bytes: u64,
}

#[derive(Debug)]
pub(crate) struct DownloadOptions {
    pub timeout_ms: u64,
    pub max_bytes: u64,
    /// **只有 `download_to_staging` 直接消费时才用得到（判据注入）；`market_download` 一律传 `None`**。
    /// 代理若由 JS 递进来，白名单就形同虚设：任意代理能对白名单 URL 返回任意字节，
    /// 甚至把请求转到内网（SSRF）。生产路径的代理只来自**进程环境**
    /// （reqwest 的 `system-proxy` feature 已由 tauri-plugin-updater 默认启用编进依赖图）。
    pub proxy: Option<String>,
}

/* ---------------------------- 纯判定（可单测） ---------------------------- */

/// 主机是否在白名单内（小写、去尾点；`*.github.io` 只认一级子域）。
pub(crate) fn host_in_allowlist(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if MARKET_HOST_ALLOWLIST.contains(&host.as_str()) {
        return true;
    }
    match host.strip_suffix(MARKET_GITHUB_PAGES_SUFFIX) {
        // 前缀必须是**单个非空 label**：`a.b.github.io` 与 `.github.io` 都不放行。
        Some(label) => !label.is_empty() && !label.contains('.'),
        None => false,
    }
}

/// 一个 URL 能不能作为下载目标：https、无 userinfo、默认端口、主机在白名单内。
/// 返回 `None` = 放行，`Some(原因)` = 拒绝（原因直接进错误串，铁律 4：不静默）。
pub(crate) fn url_problem(url: &reqwest::Url) -> Option<String> {
    if url.scheme() != "https" {
        return Some(format!("协议不是 https：{url}"));
    }
    let host = match url.host_str() {
        Some(h) => h,
        None => return Some(format!("URL 没有主机名：{url}")),
    };
    // `https://github.com@evil.com/` 这类伪装：host 已经是 evil.com，白名单自然拦下；
    // 这里再单独拒一次 userinfo，错误更好诊断。
    if !url.username().is_empty() || url.password().is_some() {
        return Some(format!("URL 带 userinfo：{url}"));
    }
    if let Some(port) = url.port() {
        return Some(format!("URL 带非默认端口 {port}：{url}"));
    }
    if !host_in_allowlist(host) {
        return Some(format!("主机不在白名单内：{host}"));
    }
    None
}

/// 重定向逐跳闸：`previous` = 已请求过的 URL 链（含首跳），`next` = 待跟随的目标。
pub(crate) fn redirect_problem(previous: &[reqwest::Url], next: &reqwest::Url) -> Option<String> {
    // previous 的第一项是初始请求，不是重定向 ⇒ 跟随 next 之后的跳数 = previous.len()
    if previous.len() > MARKET_MAX_REDIRECT_HOPS {
        return Some(format!(
            "重定向跳数超过上限 {MARKET_MAX_REDIRECT_HOPS}：{} → {next}",
            previous.len()
        ));
    }
    url_problem(next).map(|p| format!("重定向跳到不可信目标（{p}）"))
}

/// 交给 `reqwest::redirect::Policy::custom` 的策略函数（每一跳都过 `redirect_problem`）。
fn redirect_action(attempt: reqwest::redirect::Attempt<'_>) -> reqwest::redirect::Action {
    match redirect_problem(attempt.previous(), attempt.url()) {
        None => attempt.follow(),
        Some(problem) => attempt.error(problem),
    }
}

/// 暂存名/目标名共享的字面闸（字符集 + 长度 + 纯点名）。
pub(crate) fn staging_component_problem(name: &str) -> Option<String> {
    if name.is_empty() || name.len() > STAGING_NAME_MAX {
        return Some(format!("名字长度必须在 1..={STAGING_NAME_MAX}：{name:?}"));
    }
    if !name
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Some(format!(
            "名字只允许 [a-z0-9._-]（拒分隔符、反斜杠、盘符、大写）：{name:?}"
        ));
    }
    if name.bytes().all(|b| b == b'.') {
        return Some(format!("名字不能是纯点名：{name:?}"));
    }
    None
}

/// 容器名：共享字符集，且必须以 `.zip` 结尾（下载与解压**共用这一个名字**，
/// 两侧指向同一个文件 ⇒ 不存在"写 .bin 读 .zip"的两份真相）。
pub(crate) fn container_name_problem(name: &str) -> Option<String> {
    match staging_component_problem(name) {
        Some(p) => Some(p),
        None => {
            if !name.ends_with(ZIP_SUFFIX) || name.len() == ZIP_SUFFIX.len() {
                Some(format!("容器名必须以 .zip 结尾且主体非空：{name:?}"))
            } else {
                None
            }
        }
    }
}

/// 条目路径闸：与契约 `packEntryPathProblem` 同口径的**顺序与拒绝码字面**，
/// 两层的错误因此能逐字对上（前缀 `files/` 不在此判定——根 `pack.json` 也是合法条目，
/// 内容口径归 TS）。合法返回 `None`。
fn entry_path_problem(name: &str, max_depth: usize) -> Option<&'static str> {
    if name.is_empty() {
        return Some("path-empty-segment");
    }
    if name.as_bytes()[0].is_ascii_alphabetic() && name.get(1..2) == Some(":") {
        return Some("path-drive");
    }
    if name.contains('\\') {
        return Some("path-backslash");
    }
    if name.starts_with('/') {
        return Some("path-absolute");
    }
    let segments: Vec<&str> = name.split('/').collect();
    // 空段含尾斜杠 ⇒ 目录条目（名字以 `/` 结尾）在这里被拒：本容器只准落普通文件。
    if segments.iter().any(|s| s.is_empty() || *s == ".") {
        return Some("path-empty-segment");
    }
    if segments.contains(&"..") {
        return Some("path-dotdot");
    }
    if segments.len() > max_depth {
        return Some("path-depth");
    }
    None
}

/// 条目类型闸：只准普通文件。符号链接 / FIFO / socket / 块设备 / 字符设备一律拒。
/// DOS 来源的条目（注册表容器就是 `node:zlib` 自写、`version_made_by=0`）没有 unix 权限位
/// ⇒ `unix_mode()` 为 `None`，此时靠路径闸（尾斜杠=空段）兜目录条目。
/// 硬链接在 zip 容器里**没有独立表示**（zip 4.6.1 全文无 hardlink 概念，链接关系只能落成
/// 重复路径的普通条目），因此由 `entry-duplicate` 与本题闸共同覆盖。
pub(crate) fn entry_type_problem(
    is_symlink: bool,
    unix_mode: Option<u32>,
) -> Option<&'static str> {
    if is_symlink {
        return Some("entry-symlink");
    }
    match unix_mode {
        Some(mode) if mode & S_IFMT != S_IFREG => Some("entry-not-regular-file"),
        _ => None,
    }
}

/* ---------------------------- 下载（落盘） ---------------------------- */

/// reqwest 的错误是一条 source 链（顶层只有 "error sending request for url"），
/// 铁律 4 要求可诊断 ⇒ 整条链拼进错误串。
fn chain_string(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        out.push_str(&format!(" ← {s}"));
        src = s.source();
    }
    out
}

/// `<appDataDir>/market/.staging`
pub(crate) fn staging_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(app_data.join(MARKET_DIR_NAME).join(MARKET_STAGING_DIR_NAME))
}

/// rustls 的进程默认 provider：`reqwest/rustls-no-provider` 口径下必须由宿主装一次
/// （照 tauri-plugin-updater `updater.rs:585` 的同一条守卫；市场下载可能先于任何更新检查发生）。
fn ensure_tls_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// 下载响应体到 `<staging_dir>/<staging_name>`：同目录临时文件 + rename（既有原子写形态），
/// 体积双闸（`Content-Length` 预核 + 累计字节边下边核），超限**中止并删掉半截文件**。
pub(crate) async fn download_to_staging(
    staging_dir: &Path,
    url: &str,
    staging_name: &str,
    opts: &DownloadOptions,
) -> Result<MarketDownloadResultDto, String> {
    if let Some(problem) = container_name_problem(staging_name) {
        return Err(format!("market_download: {problem}"));
    }
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("URL 解析失败 {url}: {e}"))?;
    if let Some(problem) = url_problem(&parsed) {
        return Err(format!("market_download 拒绝（{problem}）"));
    }
    ensure_tls_provider();

    let client = {
        let mut builder = reqwest::Client::builder()
            .user_agent(MARKET_USER_AGENT)
            .timeout(Duration::from_millis(opts.timeout_ms))
            .redirect(reqwest::redirect::Policy::custom(redirect_action));
        if let Some(proxy) = opts.proxy.as_deref() {
            builder = builder
                .proxy(reqwest::Proxy::all(proxy).map_err(|e| format!("proxy {proxy}: {e}"))?);
        }
        builder.build().map_err(|e| format!("http client: {e}"))?
    };

    std::fs::create_dir_all(staging_dir)
        .map_err(|e| format!("创建暂存目录失败 {}: {e}", staging_dir.display()))?;

    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("下载失败 {url}: {}", chain_string(&e)))?;
    let status = response.status();
    let final_url = response.url().clone();
    if !status.is_success() {
        return Err(format!("HTTP 状态非 2xx：{status}（最终 URL {final_url}）"));
    }
    // 终态 URL 再核一次白名单（策略闸管的是"跳"，这一闸管"落点"）。
    if let Some(problem) = url_problem(&final_url) {
        return Err(format!("market_download 拒绝（最终 URL：{problem}）"));
    }
    if let Some(len) = response.content_length() {
        if len > opts.max_bytes {
            return Err(format!(
                "Content-Length {len} 超过上限 {}，已拒绝且未落盘",
                opts.max_bytes
            ));
        }
    }

    let target = staging_dir.join(staging_name);
    let tmp = staging_dir.join(format!(
        ".{staging_name}.{}.kojo-dl-tmp",
        std::process::id()
    ));
    let mut total: u64 = 0;
    let mut stream = response.bytes_stream();
    let mut file = match std::fs::File::create(&tmp) {
        Ok(f) => f,
        Err(e) => return Err(format!("创建暂存文件失败 {}: {e}", tmp.display())),
    };
    loop {
        let chunk = match stream.next().await {
            Some(item) => item.map_err(|e| format!("读取响应体失败: {e}"))?,
            None => break,
        };
        total = total.saturating_add(chunk.len() as u64);
        if total > opts.max_bytes {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!(
                "响应体累计 {total} 字节超过上限 {}，半截文件已删除",
                opts.max_bytes
            ));
        }
        if let Err(e) = file.write_all(&chunk) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("写暂存文件失败 {}: {e}", tmp.display()));
        }
    }
    drop(file);
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("暂存改名失败 {} → {}: {e}", tmp.display(), target.display()));
    }
    Ok(MarketDownloadResultDto {
        bytes: total,
        status: status.as_u16(),
        final_url: final_url.to_string(),
    })
}

#[tauri::command]
pub(crate) async fn market_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, WriteDomainState>,
    url: String,
    staging_name: String,
    timeout_ms: Option<u64>,
    max_bytes: Option<u64>,
    proxy: Option<String>,
) -> Result<MarketDownloadResultDto, String> {
    let staging = staging_dir(&app)?;
    // 写允许域第二道闸：落点由本层拼出，恒在 appDataDir 内（`ensure_in_write_domain` 的常驻根）。
    ensure_write_allowed(&app, &state, &staging, "market_staging")?;
    download_to_staging(
        &staging,
        &url,
        &staging_name,
        &DownloadOptions {
            timeout_ms: timeout_ms.unwrap_or(MARKET_DEFAULT_TIMEOUT_MS),
            max_bytes: max_bytes.unwrap_or(MARKET_DEFAULT_MAX_DOWNLOAD_BYTES),
            proxy,
        },
    )
    .await
}

/* ---------------------------- 解压（限流闸） ---------------------------- */

/// 解 `<staging_dir>/<staging_name>` 到 `<staging_dir>/<target_name>/`（全程留在暂存子树）。
///
/// 两遍走：**先全量核中央目录**（路径 / 类型 / 条目数 / 声明总字节）——任一违例就在写第一个
/// 字节之前放弃；**再边读边核**累计真实字节（声明值可以撒谎，真字节不能）。
/// 任何失败 ⇒ 删掉已解出的全部内容并返回明确错误（不留半成品）。
pub(crate) fn extract_staging(
    staging_dir: &Path,
    staging_name: &str,
    target_name: &str,
    limits: &StagingLimits,
) -> Result<MarketExtractResultDto, String> {
    if let Some(problem) = container_name_problem(staging_name) {
        return Err(format!("market_extract: {problem}"));
    }
    if let Some(problem) = staging_component_problem(target_name) {
        return Err(format!("market_extract: {problem}"));
    }
    let archive_path = staging_dir.join(staging_name);
    let target = staging_dir.join(target_name);
    let file = std::fs::File::open(&archive_path)
        .map_err(|e| format!("打开容器失败 {}: {e}", archive_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("容器不可读 {}: {e}", archive_path.display()))?;

    let outcome = extract_into(&mut archive, &target, limits, &archive_path);
    if outcome.is_err() {
        // 失败（含"一个字节都没写出去"的情形）一律清扫目标目录：暂存区不许留残壳。
        if let Err(e) = std::fs::remove_dir_all(&target) {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "[market_extract] 残壳清理失败 {}: {e}",
                    target.display()
                );
            }
        }
        return outcome;
    }
    outcome
}

fn extract_into<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    target: &Path,
    limits: &StagingLimits,
    archive_path: &Path,
) -> Result<MarketExtractResultDto, String> {
    if archive.len() > limits.max_entries {
        return Err(format!(
            "entries-limit：条目数 {} 超过上限 {}",
            archive.len(),
            limits.max_entries
        ));
    }
    // 第一遍：只读中央目录，全部闸过了才动磁盘。
    let mut declared_total: u64 = 0;
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|e| format!("读中央目录条目 {index} 失败: {e}"))?;
        let name = entry.name().to_string();
        if let Some(code) = entry_path_problem(&name, limits.max_depth) {
            return Err(format!("{code}：条目路径非法 {name:?}（容器 {}）", archive_path.display()));
        }
        if let Some(code) = entry_type_problem(entry.is_symlink(), entry.unix_mode()) {
            return Err(format!("{code}：条目不是普通文件 {name:?}（容器 {}）", archive_path.display()));
        }
        if !seen.insert(name.clone()) {
            return Err(format!("entry-duplicate：条目路径重复 {name:?}"));
        }
        declared_total = declared_total.saturating_add(entry.size());
        if declared_total > limits.max_unpacked_bytes {
            return Err(format!(
                "bytes-limit：声明解压总字节 {declared_total} 超过上限 {}",
                limits.max_unpacked_bytes
            ));
        }
    }

    std::fs::create_dir_all(target).map_err(|e| format!("mkdir {}: {e}", target.display()))?;
    // 第二遍：边读边核真字节（zip  crate 在读到条目末尾时自带 CRC32 校验）。
    let mut entries: Vec<ExtractedEntryDto> = Vec::with_capacity(archive.len());
    let mut written_total: u64 = 0;
    let mut buffer = vec![0u8; 64 * 1024];
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("读条目 {index} 失败: {e}"))?;
        let name = entry.name().to_string();
        let path = target.join(&name); // `name` 已过路径闸：相对、无反斜杠、无 `..`
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let mut out = std::fs::File::create(&path)
            .map_err(|e| format!("create {}: {e}", path.display()))?;
        let budget = limits.max_unpacked_bytes - written_total;
        let mut limited = (&mut entry).take(budget + 1);
        let mut written: u64 = 0;
        loop {
            let read = limited
                .read(&mut buffer)
                .map_err(|e| format!("读条目 {name:?} 失败: {e}"))?;
            if read == 0 {
                break;
            }
            out.write_all(&buffer[..read])
                .map_err(|e| format!("写 {} 失败: {e}", path.display()))?;
            written += read as u64;
        }
        if written > budget {
            return Err(format!(
                "bytes-limit：解压真实累计字节超过上限 {}",
                limits.max_unpacked_bytes
            ));
        }
        written_total += written;
        entries.push(ExtractedEntryDto { path: name, bytes: written });
    }
    Ok(MarketExtractResultDto {
        entries,
        total_bytes: written_total,
    })
}

#[tauri::command]
pub(crate) fn market_extract(
    app: tauri::AppHandle,
    state: tauri::State<'_, WriteDomainState>,
    staging_name: String,
    target_name: String,
    limits: StagingLimits,
) -> Result<MarketExtractResultDto, String> {
    let staging = staging_dir(&app)?;
    ensure_write_allowed(&app, &state, &staging, "market_staging")?;
    extract_staging(&staging, &staging_name, &target_name, &limits)
}
