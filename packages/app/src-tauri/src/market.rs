//! 市场（无服务器口上包分发）的 IO 原语：**远程下载**、**ZIP 安全解压**、
//! 以及**不落盘的远程取文本**（注册表索引）。
//!
//! 分层（ADR-0003：Rust 只做 IO 原语、零业务逻辑、零游戏知识）：
//! - **不算任何哈希**：SHA-256 的唯一实现点在 TS（`plugins/kojo-market/src/digest.ts`），
//!   校验语义属于"判定"，判定不下沉本层；本层只保证"字节落盘"与"解压不越界"。
//!   （这条过去只有注释担保 ⇒ 现在有机器闸：`kojo-market/tests/single-source.test.ts`
//!   的扫描面含 `.rs`。）
//! - **落点决定权在本层**：命令不接受绝对目标路径，只接受一个受限的暂存名字，
//!   真实落点由本层拼成 `<appDataDir>/market/.staging/...`（形态照 `export_file`：
//!   授权绑在命令内，JS 拿不到落点决定权）。正式目录的搬运由 TS 侧 `io.rename` 原子完成。
//! - **限额由 TS 从契约常量传入**（`plugin-api/market.ts`），本层不写死第二份真相；
//!   只有下载侧的超时/体积默认值是本地常量（TS 未传时的唯一兜底口径）。

use std::io::{Read, Seek as _, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};

use crate::{ensure_write_allowed, tmp_unique_id, WriteDomainState};

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
/// 取文本（注册表索引）的兜底体积上限：TS 侧恒从契约 `MARKET_MAX_INDEX_BYTES` 传入，
/// 这个数只在没传时生效（照下载侧同一条口径，不是第二份业务真相）。
const MARKET_DEFAULT_MAX_FETCH_BYTES: u64 = 256 * 1024;
const MARKET_USER_AGENT: &str = "kojo-editor-market";

/* ----------------------- 编译期硬顶（不可被 JS 放宽） ----------------------- */
//
// 上面三个默认值只在"JS 没传"时兜底；一旦 JS 传了 `max_bytes` / 解压限额，本层过去
// 全盘接受、没有任何 Rust 侧上界。市场下载会拉进**插件代码**（CSP 已关 ⇒ WebView JS
// 可信度存疑），一条 `invoke('market_fetch_text',{maxBytes: 2**40})` 就能让"整份响应体
// 收进 Vec"直接 OOM（取文本全程在内存），一条 `market_extract` 的巨型限额就拆掉了
// 解压炸弹闸。这些硬顶是**编译期常量**，任何调用方给的限额都只会往下夹、绝不放大——
// 形态照 `lib.rs` 检索段 `threads.clamp(1, 32)`（同样是给 JS 传参兜底）。

/// 单次请求超时硬顶（15 分钟：远大于任何合法包/索引，又能掐死"永不返回"的连接挂线）。
const MARKET_HARD_MAX_TIMEOUT_MS: u64 = 15 * 60_000;
/// 下载落盘体积硬顶（512 MiB：落盘不进内存，但磁盘配额与暂存区不许被无限撑）。
const MARKET_HARD_MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
/// 取文本硬顶（1 MiB：注册表索引实测 ~1.6 KB，这条对合法用量零影响，只拦 OOM）。
const MARKET_HARD_MAX_FETCH_BYTES: u64 = 1024 * 1024;
/// 解压条目数硬顶。
const MARKET_HARD_MAX_ENTRIES: usize = 200_000;
/// 解压嵌套深度硬顶。
const MARKET_HARD_MAX_DEPTH: usize = 64;
/// 解压总字节硬顶（512 MiB）。
const MARKET_HARD_MAX_UNPACKED_BYTES: u64 = 512 * 1024 * 1024;

/// 下载：把调用方给的超时/体积夹进编译期硬顶（默认值也过一遍，口径统一）。
pub(crate) fn cap_download_limits(timeout_ms: u64, max_bytes: u64) -> (u64, u64) {
    (
        timeout_ms.min(MARKET_HARD_MAX_TIMEOUT_MS),
        max_bytes.min(MARKET_HARD_MAX_DOWNLOAD_BYTES),
    )
}

/// 取文本：同上，但体积顶更低（全程驻内存，是最直接的 OOM 面）。
pub(crate) fn cap_fetch_limits(timeout_ms: u64, max_bytes: u64) -> (u64, u64) {
    (
        timeout_ms.min(MARKET_HARD_MAX_TIMEOUT_MS),
        max_bytes.min(MARKET_HARD_MAX_FETCH_BYTES),
    )
}

/// 解压：三个限额逐一夹进硬顶（炸弹闸不许被调用方解除）。
pub(crate) fn cap_staging_limits(limits: StagingLimits) -> StagingLimits {
    StagingLimits {
        max_entries: limits.max_entries.min(MARKET_HARD_MAX_ENTRIES),
        max_depth: limits.max_depth.min(MARKET_HARD_MAX_DEPTH),
        max_unpacked_bytes: limits.max_unpacked_bytes.min(MARKET_HARD_MAX_UNPACKED_BYTES),
    }
}

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

/// 下载进度（经 Tauri Channel 回 JS）。`total_bytes` = 终态响应的 `Content-Length`，
/// 缺失（chunked 等）⇒ `null`——**如实缺**，不拿累计上限冒充总数（那是造谣）。
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MarketProgressDto {
    pub received_bytes: u64,
    pub total_bytes: Option<u64>,
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

/// 远程取文本的结果（**不落盘**：索引只有 ~1.6 KB，字节经 IPC 回去即可）。
/// 刻意只有"内容 + 这次请求的事实"四项：条件请求（ETag/`If-None-Match`）要命令面收
/// 任意请求头 ⇒ 口子比"多打一次 1.6 KB"大得多，本批的新鲜度口径是 TS 侧 TTL。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MarketFetchTextResultDto {
    pub text: String,
    pub bytes: u64,
    pub status: u16,
    pub final_url: String,
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
        return Some(format!(
            "主机 {host} 不在平台放行列表（当前仅放行 GitHub 系主机与 *.github.io 一级子域镜像）"
        ));
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
    // 冒号 anywhere：`C:` 盘符（首字母+冒号）之外的 `foo:stream` 是 NTFS 备用数据流
    // （ADS）注入面——落盘时 `foo` 是宿主文件、`:stream` 是藏进去的第二份数据，
    // 路径闸看不见它、`entry-duplicate` 也拦不住（两个不同条目名）。一律拒。
    // 复用 `path-drive` 码：正是要把"任何 Windows 保留冒号语义"归一类，错误仍逐字可示人。
    if name.as_bytes()[0].is_ascii_alphabetic() && name.get(1..2) == Some(":") {
        return Some("path-drive");
    }
    if name.contains(':') {
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
    // Windows 静默改名面：任一段尾随 `.` 或空格在落盘时被资源管理器/文件系统悄悄剥掉
    // （`a.txt.` → `a.txt`），清单与实际落盘从此不平。逐段核尾，非空段一视同仁。
    if segments
        .iter()
        .any(|s| s.ends_with('.') || s.ends_with(' '))
    {
        return Some("path-windows-unsafe");
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

/* ---------------------------- 体积与解码闸 ---------------------------- */

/// `Content-Length` 预核：**下载与取文本同一份**（声明值超限就拒，一个字节都不收）。
pub(crate) fn content_length_problem(len: u64, max_bytes: u64) -> Option<String> {
    if len > max_bytes {
        Some(format!("Content-Length {len} 超过上限 {max_bytes}，已拒绝"))
    } else {
        None
    }
}

/// 逐块累计体积闸：**下载与取文本同一份**（超限即中止，由调用方清半截）。
pub(crate) fn advance_byte_cap(received: u64, chunk: usize, max_bytes: u64) -> Result<u64, String> {
    let total = received.saturating_add(chunk as u64);
    if total > max_bytes {
        return Err(format!("响应体累计 {total} 字节超过上限 {max_bytes}"));
    }
    Ok(total)
}

/// 远程文本必须是 UTF-8（"看起来像 JSON 的别的编码"不进本层）。
pub(crate) fn utf8_text(bytes: &[u8]) -> Result<String, String> {
    String::from_utf8(bytes.to_vec())
        .map_err(|e| format!("响应体不是 UTF-8 文本（{} 字节）：{e}", bytes.len()))
}

/* ---------------------------- 进度节流（纯判定） ---------------------------- */

/// 节流阈值的字节段：累计新增 ≥64 KiB 才发一条（reqwest 的块常在 8–64 KiB，
/// 逐块直发 128 MiB 会是一万多条 IPC；压到这条后同量级包 ≤2 千条，UI 却已够顺滑）。
const PROGRESS_MIN_DELTA_BYTES: u64 = 64 * 1024;
/// 节流阈值的时间段：距上次发出 ≥100 ms 也发（慢网涓流时 UI 不至于长时间停在旧读数）。
const PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(100);

/// 该不该发这条进度（纯函数）。`delta_bytes` = 距上次已发出的新增字节，
/// `delta_time` = 距上次发出的时长（`None` = 一次都没发过 ⇒ 首块直接发，
/// UI 不该在 0% 停到半程）。字节段与时间段满足其一即发；新增为 0（收尾重复调用）不发。
pub(crate) fn progress_due(delta_bytes: u64, delta_time: Option<Duration>) -> bool {
    if delta_bytes >= PROGRESS_MIN_DELTA_BYTES {
        return true;
    }
    match delta_time {
        None => true,
        Some(t) => delta_bytes > 0 && t >= PROGRESS_MIN_INTERVAL,
    }
}

/* ---------------------------- 出网（唯一一条） ---------------------------- */

/// 请求用的 client：UA + 超时 + **逐跳重核**策略；代理只认进程环境（见 `DownloadOptions::proxy`）。
fn http_client(opts: &DownloadOptions) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(MARKET_USER_AGENT)
        .timeout(Duration::from_millis(opts.timeout_ms))
        .redirect(reqwest::redirect::Policy::custom(redirect_action));
    if let Some(proxy) = opts.proxy.as_deref() {
        builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|e| format!("proxy {proxy}: {e}"))?);
    }
    builder.build().map_err(|e| format!("http client: {e}"))
}

/// **本模块唯一一条出网路径**：URL 形态 + 白名单 → client → 发送 → 状态码 →
/// 终态 URL 重核 → `Content-Length` 预核。
///
/// `market_download` 与 `market_fetch_text` 都只经这里，两份判定因此**不存在**
/// （协议、主机白名单、逐跳重核、声明体积各只有一处实现）。
pub(crate) async fn guarded_send(
    url: &str,
    opts: &DownloadOptions,
    gate: &str,
) -> Result<(reqwest::Response, u16, reqwest::Url), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("URL 解析失败 {url}: {e}"))?;
    if let Some(problem) = url_problem(&parsed) {
        return Err(format!("{gate} 拒绝（{problem}）"));
    }
    ensure_tls_provider();
    let client = http_client(opts)?;
    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("{gate} 请求失败 {url}: {}", chain_string(&e)))?;
    let status = response.status();
    let final_url = response.url().clone();
    if !status.is_success() {
        return Err(format!("HTTP 状态非 2xx：{status}（最终 URL {final_url}）"));
    }
    // 终态 URL 再核一次白名单（策略闸管的是"跳"，这一闸管"落点"）。
    if let Some(problem) = url_problem(&final_url) {
        return Err(format!("{gate} 拒绝（最终 URL：{problem}）"));
    }
    if let Some(len) = response.content_length() {
        if let Some(problem) = content_length_problem(len, opts.max_bytes) {
            return Err(format!("{gate} 拒绝（{problem}）"));
        }
    }
    Ok((response, status.as_u16(), final_url))
}

/// 收响应体进任意 `sink`，**逐块核累计上限**（落盘与进内存因此共用同一把尺）。
pub(crate) async fn stream_capped<W: Write>(
    response: reqwest::Response,
    max_bytes: u64,
    sink: &mut W,
) -> Result<u64, String> {
    stream_capped_report(response, max_bytes, sink, &mut |_| {}).await
}

/// `stream_capped` 的带进度形态：每收一块（写盘后）把**运行总量**交给 `on_chunk`，
/// 发不发、怎么节流由调用方闭包决定（取文本用不上进度，走上面的无回调委托）。
/// `+ Send`：tauri 命令的 future 必须 `Send`，闭包随循环跨 await 持有。
pub(crate) async fn stream_capped_report<W: Write>(
    response: reqwest::Response,
    max_bytes: u64,
    sink: &mut W,
    on_chunk: &mut (dyn FnMut(u64) + Send),
) -> Result<u64, String> {
    let mut stream = response.bytes_stream();
    let mut total: u64 = 0;
    loop {
        let chunk = match stream.next().await {
            Some(item) => item.map_err(|e| format!("读取响应体失败: {e}"))?,
            None => break,
        };
        total = advance_byte_cap(total, chunk.len(), max_bytes)?;
        sink.write_all(&chunk)
            .map_err(|e| format!("写响应体失败: {e}"))?;
        on_chunk(total);
    }
    Ok(total)
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
/// 体积双闸走 `guarded_send` / `stream_capped`（**与取文本同一份判定**），
/// 超限**中止并删掉半截文件**。
///
/// `on_progress` 给了就按 [`progress_due`] 节流回报进度（**写盘后**才报——报的是"真落了盘"
/// 的量；收尾补一发让 UI 落在终值，重复调用由节流判定压掉）；没给则全程零回调。
/// 总数取终态响应的 `Content-Length`（`guarded_send` 已核 ≤ 体积上限），缺失如实回 `None`。
pub(crate) async fn download_to_staging(
    staging_dir: &Path,
    url: &str,
    staging_name: &str,
    opts: &DownloadOptions,
    on_progress: Option<&tauri::ipc::Channel<MarketProgressDto>>,
) -> Result<MarketDownloadResultDto, String> {
    if let Some(problem) = container_name_problem(staging_name) {
        return Err(format!("market_download: {problem}"));
    }
    let (response, status, final_url) = guarded_send(url, opts, "market_download").await?;
    let total_declared = response.content_length();
    let mut last_report: Option<(u64, Instant)> = None;
    let mut report = |received: u64| {
        let Some(channel) = on_progress else { return };
        let now = Instant::now();
        let due = match last_report {
            None => progress_due(received, None),
            Some((sent, at)) => {
                progress_due(received.saturating_sub(sent), Some(now.duration_since(at)))
            }
        };
        if due {
            let _ = channel.send(MarketProgressDto {
                received_bytes: received,
                total_bytes: total_declared,
            });
            last_report = Some((received, now));
        }
    };

    std::fs::create_dir_all(staging_dir)
        .map_err(|e| format!("创建暂存目录失败 {}: {e}", staging_dir.display()))?;

    let target = staging_dir.join(staging_name);
    // tmp 名带 pid + 进程内序号（`write_file_bytes` 同款）：pid 只隔开跨进程，
    // 同一暂存名的并发下载若共用临时名会互踩——一方落盘另一方字节。
    let tmp = staging_dir.join(format!(
        ".{staging_name}.{}.kojo-dl-tmp",
        tmp_unique_id()
    ));
    let mut file = match std::fs::File::create(&tmp) {
        Ok(f) => f,
        Err(e) => return Err(format!("创建暂存文件失败 {}: {e}", tmp.display())),
    };
    let total = match stream_capped_report(response, opts.max_bytes, &mut file, &mut report).await {
        Ok(n) => n,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp); // 半截容器不许留在暂存区
            return Err(e);
        }
    };
    if total > 0 {
        report(total);
    }
    drop(file);
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("暂存改名失败 {} → {}: {e}", tmp.display(), target.display()));
    }
    Ok(MarketDownloadResultDto {
        bytes: total,
        status,
        final_url: final_url.to_string(),
    })
}

/// 取一段远程文本（注册表索引）：**不落盘**、不碰写允许域，闸与下载同一份。
pub(crate) async fn fetch_text(url: &str, opts: &DownloadOptions) -> Result<MarketFetchTextResultDto, String> {
    let (response, status, final_url) = guarded_send(url, opts, "market_fetch_text").await?;
    let mut body: Vec<u8> = Vec::new();
    let bytes = stream_capped(response, opts.max_bytes, &mut body).await?;
    Ok(MarketFetchTextResultDto {
        text: utf8_text(&body)?,
        bytes,
        status,
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
    // Channel **必传**（tauri 2 的 `Option<Channel>` 不走 CommandArg：Option 的 blanket
    // 实现要 T: Deserialize，Channel 没有）。JS 侧没进度回调也传一个空通道——照发不误，没人听。
    on_progress: tauri::ipc::Channel<MarketProgressDto>,
) -> Result<MarketDownloadResultDto, String> {
    let staging = staging_dir(&app)?;
    // 写允许域第二道闸：落点由本层拼出，恒在 appDataDir 内（`ensure_in_write_domain` 的常驻根）。
    ensure_write_allowed(&app, &state, &staging, "market_staging")?;
    // 调用方限额一律夹进编译期硬顶（默认值也过一遍，口径统一；只降不升）。
    let (timeout_ms, max_bytes) = cap_download_limits(
        timeout_ms.unwrap_or(MARKET_DEFAULT_TIMEOUT_MS),
        max_bytes.unwrap_or(MARKET_DEFAULT_MAX_DOWNLOAD_BYTES),
    );
    download_to_staging(
        &staging,
        &url,
        &staging_name,
        &DownloadOptions {
            timeout_ms,
            max_bytes,
            // 代理不在这里决定：见 `DownloadOptions::proxy`（env ⇒ reqwest system-proxy）
            proxy: None,
        },
        Some(&on_progress),
    )
    .await
}

#[tauri::command]
pub(crate) async fn market_fetch_text(
    url: String,
    timeout_ms: Option<u64>,
    max_bytes: Option<u64>,
) -> Result<MarketFetchTextResultDto, String> {
    // 没有 `app` / 没有 `WriteDomainState`：这条命令**一个字节都不写盘**，
    // 也就没有任何写允许域参与（索引经 TS 侧 `io.writeText` 落到常驻可写根之内）。
    // 全程驻内存的取文本是最直接的 OOM 面 ⇒ 调用方限额夹进编译期硬顶（只降不升）。
    let (timeout_ms, max_bytes) = cap_fetch_limits(
        timeout_ms.unwrap_or(MARKET_DEFAULT_TIMEOUT_MS),
        max_bytes.unwrap_or(MARKET_DEFAULT_MAX_FETCH_BYTES),
    );
    fetch_text(
        &url,
        &DownloadOptions {
            timeout_ms,
            max_bytes,
            // 与 `market_download` 同一口径：代理只认进程环境（env ⇒ reqwest system-proxy）
            proxy: None,
        },
    )
    .await
}

/* ------------------------ 中央目录条目数预检（F7） ------------------------ */
//
// `ZipArchive::new` **先把整个中央目录解析进内存**（zip-4.6.1 `read.rs:691` 按 EOCD 声明的
// 条目数逐条建 `ZipFileData`），之后 `extract_into` 才拿 `archive.len()` 去比限额。
// 于是硬顶夹住的是"允许解出的量"，不是"为拒绝而付出的代价"：一个条目数失控的容器，
// RAM + 解析先花完，才被第一道限额拒掉。本段自己只读文件尾 `22 + 65535`（EOCD 窗口）
// 与 zip64 记录 56 字节，拿**EOCD 头的声明值**在"一次条目解析都不做"的前提下先拒。
//
// 为什么这条预检既不误判也不放过：zip crate 解析中央目录时**恰好**迭代 EOCD 声明的条目数
// （同上），声明值以下的条目才是它看得见的全部内容 ⇒ 声明值是"解析成本"的上界。
// 声明值偏高（撒谎/失控）⇒ 这里提前给出与稍后**同一条结论**；声明值偏低 ⇒ crate 只会解得更少、
// 成本更小，`extract_into` 的 `archive.len()` 闸照旧。两条都不成立时（尾部形态不认识）
// ⇒ **绝不据此拒绝**，判定权原样交回 `ZipArchive::new`（零行为回归）。
//
// 上界口径：`MARKET_HARD_MAX_ENTRIES`（Rust 侧编译期常量、JS 放宽不了）；调用方限额只许把它
// 继续往下压（与 `cap_staging_limits` 同一条"只降不升"）。

/// EOCD（zip32）：`PK\x05\x06`，定长 22 字节 + 最长 65535 注释 ⇒ 只需回看文件尾这一段。
const EOCD32_SIGNATURE: [u8; 4] = *b"PK\x05\x06";
const EOCD32_LEN: usize = 22;
const EOCD32_MAX_SCAN: u64 = (EOCD32_LEN + 0xFFFF) as u64;
/// zip32 EOCD 内的字段偏移：本盘条目数 u16@8、全目录条目数 u16@10、注释长度 u16@20。
const EOCD32_DISK_ENTRIES: usize = 8;
const EOCD32_TOTAL_ENTRIES: usize = 10;
const EOCD32_COMMENT_LEN: usize = 20;
/// zip32 条目数字段写满 ⇒ 真值在 zip64 记录里（crate 同口径的 `may_be_zip64`）。
const ZIP32_COUNT_SENTINEL: u16 = 0xFFFF;
/// zip64：locator `PK\x06\x07` 定长 20 字节、紧贴 EOCD 之前；记录 `PK\x06\x06`。
const EOCD64_LOCATOR_SIGNATURE: [u8; 4] = *b"PK\x06\x07";
const EOCD64_LOCATOR_LEN: u64 = 20;
/// locator 内 zip64 EOCD 记录的绝对偏移（u64@8）。
const EOCD64_LOCATOR_RECORD_OFFSET: usize = 8;
const EOCD64_SIGNATURE: [u8; 4] = *b"PK\x06\x06";
/// zip64 EOCD 记录头部（sig4 + record_size8 + ver2 + ver2 + disk4 + disk_cd4 + 条目数8+8）。
const EOCD64_HEADER_LEN: u64 = 56;
const EOCD64_DISK_ENTRIES: usize = 24;
const EOCD64_TOTAL_ENTRIES: usize = 32;

/// 从 EOCD 头读到的声明条目数（**不解析任何中央目录条目**）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeclaredEntries {
    /// EOCD（含 zip64 记录）声明的条目数（取"本盘/全目录"两者的较大值）
    Count(u64),
    /// 尾部形态不认识（没有 EOCD / 签名是注释里的假字节 / zip64 记录读不出）
    /// ⇒ 预检放行，判定交回 `ZipArchive::new`
    Unknown,
}

fn le_u16(bytes: &[u8], at: usize) -> Option<u16> {
    let raw = <[u8; 2]>::try_from(bytes.get(at..at + 2)?).ok()?;
    Some(u16::from_le_bytes(raw))
}

fn le_u64(bytes: &[u8], at: usize) -> Option<u64> {
    let raw = <[u8; 8]>::try_from(bytes.get(at..at + 8)?).ok()?;
    Some(u64::from_le_bytes(raw))
}

/// 只读文件尾的 EOCD / zip64 记录拿声明条目数；任何不确定 ⇒ `Unknown`（不据此拒绝）。
pub(crate) fn declared_entry_count(file: &mut std::fs::File) -> DeclaredEntries {
    let unknown = DeclaredEntries::Unknown;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len < EOCD32_LEN as u64 {
        return unknown;
    }
    let win = len.min(EOCD32_MAX_SCAN) as usize;
    let tail_start = len - win as u64;
    let mut tail = vec![0u8; win];
    if file.seek(SeekFrom::Start(tail_start)).is_err() || file.read_exact(&mut tail).is_err() {
        return unknown;
    }
    // 从后往前找签名，并要求注释长度不越过文件末尾（口径照 crate：容忍"注释后还有垃圾"）。
    // 假签名（注释里恰好这四个字节）会因条目数/长度读不出或后续定位失败而落到 Unknown。
    let Some(eocd_at) = (0..=win - EOCD32_LEN).rev().find(|i| tail[*i..*i + 4] == EOCD32_SIGNATURE)
    else {
        return unknown;
    };
    let Some(comment_len) = le_u16(&tail, eocd_at + EOCD32_COMMENT_LEN) else {
        return unknown;
    };
    if eocd_at + EOCD32_LEN + comment_len as usize > win {
        return unknown;
    }
    let (Some(disk), Some(total)) = (
        le_u16(&tail, eocd_at + EOCD32_DISK_ENTRIES),
        le_u16(&tail, eocd_at + EOCD32_TOTAL_ENTRIES),
    ) else {
        return unknown;
    };
    if disk < ZIP32_COUNT_SENTINEL && total < ZIP32_COUNT_SENTINEL {
        return DeclaredEntries::Count(u64::from(disk.max(total)));
    }
    // zip64：locator 紧贴 EOCD 之前，记录偏移写在 locator 里（u64）
    let eocd_abs = tail_start + eocd_at as u64;
    if eocd_abs < EOCD64_LOCATOR_LEN {
        return unknown;
    }
    let mut locator = [0u8; EOCD64_LOCATOR_LEN as usize];
    if file.seek(SeekFrom::Start(eocd_abs - EOCD64_LOCATOR_LEN)).is_err()
        || file.read_exact(&mut locator).is_err()
        || locator[..4] != EOCD64_LOCATOR_SIGNATURE
    {
        return unknown;
    }
    let Some(record_at) = le_u64(&locator, EOCD64_LOCATOR_RECORD_OFFSET) else {
        return unknown;
    };
    let mut header = [0u8; EOCD64_HEADER_LEN as usize];
    if file.seek(SeekFrom::Start(record_at)).is_err()
        || file.read_exact(&mut header).is_err()
        || header[..4] != EOCD64_SIGNATURE
    {
        return unknown;
    }
    let (Some(disk64), Some(total64)) = (
        le_u64(&header, EOCD64_DISK_ENTRIES),
        le_u64(&header, EOCD64_TOTAL_ENTRIES),
    ) else {
        return unknown;
    };
    DeclaredEntries::Count(disk64.max(total64))
}

/// 预检闸（纯函数）：声明条目数超过上界 ⇒ 拒因（拒绝码字面与 `extract_into` 的同一条）。
/// `Unknown` 一律放行——预检只在**确有把握**时提前拒。
pub(crate) fn declared_entries_problem(
    declared: DeclaredEntries,
    ceiling: usize,
) -> Option<String> {
    match declared {
        DeclaredEntries::Count(n) if n > ceiling as u64 => Some(format!(
            "entries-limit：容器声明条目数 {n} 超过上限 {ceiling}（读中央目录头即拒绝，未解析条目、未写一个字节）"
        )),
        _ => None,
    }
}

/* ---------------------------- 解压（限流闸） ---------------------------- */

/// 解 `<staging_dir>/<staging_name>` 到 `<staging_dir>/<target_name>/`（全程留在暂存子树）。
///
/// 预检在最前：**条目数先按 EOCD 头夹上界**（F7，见上段），一次解析都不做就拒掉失控声明；
/// 两遍走：**再全量核中央目录**（路径 / 类型 / 条目数 / 声明总字节）——任一违例就在写第一个
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
    let mut file = std::fs::File::open(&archive_path)
        .map_err(|e| format!("打开容器失败 {}: {e}", archive_path.display()))?;
    // F7 预检（见上段口径）：条目数先从 EOCD 头读出来夹上界，**解析一个条目都不做**就拒。
    if let Some(problem) = declared_entries_problem(
        declared_entry_count(&mut file),
        limits.max_entries.min(MARKET_HARD_MAX_ENTRIES),
    ) {
        return Err(format!("market_extract: {problem}（容器 {}）", archive_path.display()));
    }
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
        // 去重键大小写折叠（与写允许域 `lowered_components` 同款 `to_lowercase` 口径）：
        // Windows 文件系统大小写不敏感，`A.erb` 与 `a.erb` 落盘互覆，清单还虚报条目数；
        // 折叠后在写第一个字节之前按重复拒绝 ⇒ `entries` 报的恒是真落盘的条目。
        if !seen.insert(name.to_lowercase()) {
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

/// 把解压这段纯 CPU + 磁盘的活挪到**阻塞线程池**上跑（形态照 `lib.rs` 的 `search_text`）。
///
/// 为什么必须是 `async` + `spawn_blocking`：`extract_into` 两遍扫中央目录 + 逐条 64 KB
/// 落盘，限额是 5000 条目 / 128 MiB。同步命令跑在主线程上 ⇒ 大包解压期间**整个 WebView
/// 冻住**（今天注册表包只有 1 文件 / 471 B 量不出来，属结构性隐患，不是"不存在"）。
///
/// **语义一点没改**：闸与落点决定权仍留在命令内（`market_extract` 先 `staging_dir` +
/// `ensure_write_allowed` 再把路径交下来，本函数只碰暂存子树），失败清扫、两遍核闸、
/// 逐条目字节上限全部沿用 `extract_staging`（下面那条判据钉的是"逐字段同果"）。
pub(crate) async fn extract_staging_off_thread(
    staging: PathBuf,
    staging_name: String,
    target_name: String,
    limits: StagingLimits,
) -> Result<MarketExtractResultDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        extract_staging(&staging, &staging_name, &target_name, &limits)
    })
    .await
    .map_err(|e| format!("market_extract: 解压线程失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn market_extract(
    app: tauri::AppHandle,
    state: tauri::State<'_, WriteDomainState>,
    staging_name: String,
    target_name: String,
    limits: StagingLimits,
) -> Result<MarketExtractResultDto, String> {
    // 写允许域第二道闸**留在命令内、与落盘同命令**（铁律 6 的形态），且仍在移交之前：
    // 越权连阻塞线程池都上不去，一个字节都不会被解出来。
    let staging = staging_dir(&app)?;
    ensure_write_allowed(&app, &state, &staging, "market_staging")?;
    // 解压限额夹进编译期硬顶：JS 递来的 `limits` 只会往下压，绝不让解压炸弹闸被解除。
    let limits = cap_staging_limits(limits);
    extract_staging_off_thread(staging, staging_name, target_name, limits).await
}
