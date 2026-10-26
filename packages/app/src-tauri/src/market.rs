//! 市场（无服务器口上包分发）的 IO 原语：**远程下载**、**不落盘的远程取文本**（注册表索引）
//! 与**发布上传**。ZIP 容器的安全解压（条目路径 / 类型 / 数量 / 命名 / 字节闸与真落盘）
//! 已抽到 `archive_guard.rs`（启动器复用同一份），本文件只经 `pub(crate) use` 转发名字。
//!
//! 分层（ADR-0003：Rust 只做 IO 原语、零业务逻辑、零游戏知识）：
//! - **下载 / 解包侧不算任何哈希**：校验语义属于"判定"，判定不下沉本层；本层只保证
//!   "字节落盘"与"解压不越界"。（这条过去只有注释担保 ⇒ 现在有机器闸：
//!   `kojo-market/tests/single-source.test.ts` 的扫描面含 `.rs`。）
//!   **唯一的例外是发布上传的容器摘要**（2026-10-18）：发布后端强制
//!   `x-market-zip-sha256`（缺头即 400 `container-digest`）。它不是校验锚，而是请求的
//!   事实字段——"实际被上传的那串 zip 原始字节"的 SHA-256，由**同一个文件句柄**
//!   （哈希后 `seek(0)` 再上传）算出；下行校验锚仍只住 TS。
//! - **落点决定权在本层**：命令不接受绝对目标路径，只接受一个受限的暂存名字，
//!   真实落点由本层拼成 `<appDataDir>/market/.staging/...`（形态照 `export_file`：
//!   授权绑在命令内，JS 拿不到落点决定权）。正式目录的搬运由 TS 侧 `io.rename` 原子完成。
//! - **限额由 TS 从契约常量传入**（`plugin-api/market.ts`），本层不写死第二份真相；
//!   只有下载侧的超时/体积默认值是本地常量（TS 未传时的唯一兜底口径）。
//!   入参**只许收紧、不许放宽**：天花板同样取自那张共享表（JS 递不进比表更宽的限额，
//!   否则"契约常量传入"就变成了"调用方自己定"）。
//! - **解包前先过"容器原语"这道闸（W14 往返契约）**：`central_directory` 自己解析中央目录，
//!   拿条目名的**原始字节**、general purpose bit、压缩法、两个尺寸与**本地头互指关系**——
//!   这些是 `zip` 读器看不见或会替调用方"修好"的东西（它按名字建索引时**静默去重**、
//!   bit 11 缺失时按 **CP437** 解码名字）。规则的**唯一共享物**是那张表
//!   `packages/plugin-api/fixtures/zip-roundtrip/contract.json`：写侧（TS `plugin-api/src/zip.ts`）
//!   与解包侧（`archive_guard.rs`）各有一条测试消费同一张表与同一个容器夹具，谁漂谁红。
//!   解包层不止测试在读它——命名闸的两个参数与后缀（`zipContainerNameRule`）、入参天花板
//!   （`limits`）**都从编译期内嵌的这张表取**（`include_str!`，形态照 W12 的
//!   `decode-probe-policy.json`），所以两侧不存在"各写一套 if 再拿测试对齐"的第二份真相。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::{ensure_write_allowed, tmp_unique_id, WriteDomainState};

// 容器安全闸全部住在 `archive_guard.rs`（启动器复用的是同一份实现）；这里 `pub(crate) use`
// 把它们**原样重新导出**——旧调用点与 `market_tests.rs` 的 `crate::market::…` 路径因此一行未改，
// 公开函数签名也不变。
pub(crate) use crate::archive_guard::{
    advance_byte_cap, cap_staging_limits, central_directory, container_name_problem,
    declared_entries_problem, declared_entry_count, entry_contract_problem, entry_type_problem,
    extract_staging, extract_staging_off_thread, staging_component_problem, stream_capped,
    stream_capped_report, zip_roundtrip_contract, DeclaredEntries, MarketExtractResultDto,
    RawEntry, StagingLimits, ZIP_FLAG_UTF8, ZIP_ROUNDTRIP_CONTRACT_JSON,
};

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

/// 下载落盘的缓冲块（1 MiB）。网络流是"一块一写"：reqwest 的 chunk 通常几十 KB，
/// 128 MiB 的包 ⇒ ~2,000 次 `WriteFile`，每次一个内核往返（PS-1 §7）。
/// 垫一层缓冲后按整块落盘；体积双闸与"改名前必 flush"都不受影响。
const DOWNLOAD_WRITE_CHUNK: usize = 1024 * 1024;

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

/// 市场在应用数据区的根 / 暂存子目录（与契约 `MARKET_DIR_NAME` / `MARKET_STAGING_DIR` 同字面；
/// 本层必须自己拼落点，这是"落点决定权留在 Rust"的代价，不是第二份业务真相）。
const MARKET_DIR_NAME: &str = "market";
const MARKET_STAGING_DIR_NAME: &str = ".staging";

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

/// 一个 URL 能不能作为下载目标（[`DOWNLOAD_GATE`] 的表；判定实现在 [`url_problem_in`]）。
/// 返回 `None` = 放行，`Some(原因)` = 拒绝（原因直接进错误串，铁律 4：不静默）。
pub(crate) fn url_problem(url: &reqwest::Url) -> Option<String> {
    url_problem_in(url, &DOWNLOAD_GATE)
}

/// 重定向逐跳闸（下载闸；发布链路走 [`redirect_problem_in`]，同一份形态）。
pub(crate) fn redirect_problem(previous: &[reqwest::Url], next: &reqwest::Url) -> Option<String> {
    redirect_problem_in(previous, next, &DOWNLOAD_GATE)
}

/// 交给 `reqwest::redirect::Policy::custom` 的策略函数（每一跳都过 [`redirect_problem_in`]，
/// 闸可换——下载闸与发布闸共用这一个实现，只有表不同）。
fn redirect_action_for(
    gate: &'static HostGate,
) -> impl Fn(reqwest::redirect::Attempt<'_>) -> reqwest::redirect::Action {
    move |attempt| match redirect_problem_in(attempt.previous(), attempt.url(), gate) {
        None => attempt.follow(),
        Some(problem) => attempt.error(problem),
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

/// 请求用的 client：UA + 超时 + **逐跳重核**策略（下载闸）；代理只认进程环境（见 `DownloadOptions::proxy`）。
fn http_client(opts: &DownloadOptions) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(MARKET_USER_AGENT)
        .timeout(Duration::from_millis(opts.timeout_ms))
        .redirect(reqwest::redirect::Policy::custom(redirect_action_for(&DOWNLOAD_GATE)));
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
/// `on_progress` 给了就按 [`progress_due`] 节流回报进度（**交给写入缓冲之后**才报；
/// 收尾那一次在 flush 之后 ⇒ 落盘失败不会带着一个"成功"的进度数字返回）。
/// 发不发、怎么节流由调用方闭包决定（取文本用不上进度，走上面的无回调委托）。
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

    // 建目录 + 建临时句柄是两次同步文件系统调用，旧写法直接在 tokio 工作线程上做
    // （慢盘 / 网络盘上会把那条线程的事件循环占住）⇒ 挪到阻塞线程池（PS-1 §7）。
    // 顺序不变：容器名闸与 `guarded_send`（URL / 体积双闸）都在这之前 ⇒ 依旧是"闸在前、写盘在后"。
    let dir_owned = staging_dir.to_path_buf();
    let name_owned = staging_name.to_string();
    let (tmp, file) = tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir_owned)
            .map_err(|e| format!("创建暂存目录失败 {}: {e}", dir_owned.display()))?;
        // tmp 名带 pid + 进程内序号（`write_file_bytes` 同款）：pid 只隔开跨进程，
        // 同一暂存名的并发下载若共用临时名会互踩——一方落盘另一方字节。
        let tmp = dir_owned.join(format!(
            ".{name_owned}.{}.kojo-dl-tmp",
            tmp_unique_id()
        ));
        let file = std::fs::File::create(&tmp)
            .map_err(|e| format!("创建暂存文件失败 {}: {e}", tmp.display()))?;
        Ok::<(PathBuf, std::fs::File), String>((tmp, file))
    })
    .await
    .map_err(|e| format!("market_download: 暂存准备线程失败：{e}"))??;
    let target = staging_dir.join(staging_name);
    // 网络块与写盘调用一比一地对着干（128 MB ÷ 缺省 chunk ⇒ ~2,000 次 `WriteFile`）：
    // 中间垫一层缓冲，落盘按整块走（PS-1 §7）。缓冲不改变判据——体积上限仍在
    // `stream_capped_report` 里**逐块**核，改名之前一定 flush，flush 失败连半成品一起删。
    let mut sink = std::io::BufWriter::with_capacity(DOWNLOAD_WRITE_CHUNK, file);
    let total = match stream_capped_report(response, opts.max_bytes, &mut sink, &mut report).await {
        Ok(n) => n,
        Err(e) => {
            // 缓冲里的半截先丢弃（不 flush），句柄先关再删：半截容器不许留在暂存区
            let file = sink.into_inner();
            drop(file);
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
    };
    if let Err(e) = sink.flush() {
        let file = sink.into_inner();
        drop(file);
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("写响应体失败: {e}"));
    }
    let file = sink.into_inner();
    drop(file);
    if total > 0 {
        report(total);
    }
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


/* --------------------- 发布（上传，2026-10-16 发布批） --------------------- */

/// 发布主机白名单：市场发布后端（Cloudflare Worker）。与下载白名单是**两张表**
/// （GitHub 系只在下载闸放行，反之亦然——双闸独立性由测试钉死）。
const MARKET_PUBLISH_HOST_ALLOWLIST: [&str; 1] = ["market.362573581.xyz"];
/// 白名单里唯一的后缀通配：`*.workers.dev`（只准一级子域，照 `.github.io` 的口径）。
const MARKET_WORKERS_DEV_SUFFIX: &str = ".workers.dev";
/// 发布端点的兜底默认值（唯一真源在契约 `MARKET_DEFAULT_PUBLISH_URL`，TS 恒显式传；
/// 这个常量只在没传时兜底，照 `MARKET_DEFAULT_TIMEOUT_MS` 的口径）。
const MARKET_DEFAULT_PUBLISH_ENDPOINT: &str = "https://market.362573581.xyz";
/// 上传容器字节数的兜底上限（TS 恒从契约 `MARKET_MAX_CONTAINER_UPLOAD_BYTES` 显式传入）。
/// 刻意用十进制：CF 免费档请求体边缘上限 **100,000,000 字节**，95_000_000 字节留整 5 MB
/// 余量（99 MiB ≈ 103.8 MB 会算错边、超限包在 CF 边缘即被 413，Worker 收不到）——
/// 本地闸必须先行拒因，别浪费用户流量。
const MARKET_DEFAULT_MAX_PUBLISH_BYTES: u64 = 95_000_000;
/// 换设备令牌的兜底超时（小请求；TS 未传时生效）。
const MARKET_DEVICE_TOKEN_TIMEOUT_MS: u64 = 15_000;
/// 发布上传的容器摘要头：后端强制要求，缺/形态不对即 400 `container-digest`（实测）。
/// 值 = **实际上传的那串 zip 原始字节**的 SHA-256，小写 64 位 hex。
pub(crate) const MARKET_ZIP_SHA256_HEADER: &str = "x-market-zip-sha256";
/// 上传容器的 Content-Type（后端按容器字节解析；不带会被当成别的正文形态）。
pub(crate) const MARKET_ZIP_CONTENT_TYPE: &str = "application/zip";
/// 摘要值形态：64 位小写 hex（大写同样算"形态不对"，后端只认这一种）。
pub(crate) const MARKET_ZIP_SHA256_HEX_LEN: usize = 64;
/// 摘要流式计算的块大小（与上传流同量级：95 MB 包也只占一块内存）。
pub(crate) const MARKET_DIGEST_CHUNK_BYTES: usize = 64 * 1024;

/// 出网闸的宿主判定（下载与发布各一份：放行表不同、判定形态同构）。
struct HostGate {
    host_ok: fn(&str) -> bool,
    /// 拒因里如实转述的放行范围（人话；与契约注释同一句，防两处漂移靠测试对词）。
    allowlist_desc: &'static str,
}

const DOWNLOAD_GATE: HostGate = HostGate {
    host_ok: host_in_allowlist,
    allowlist_desc: "当前仅放行 GitHub 系主机与 *.github.io 一级子域镜像",
};

const PUBLISH_GATE: HostGate = HostGate {
    host_ok: publish_host_in_allowlist,
    allowlist_desc: "当前仅放行市场发布后端 market.362573581.xyz 与 *.workers.dev 一级子域",
};

/// 发布主机闸：固定后端 + `*.workers.dev` 一级子域（小写、去尾点）。
pub(crate) fn publish_host_in_allowlist(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if MARKET_PUBLISH_HOST_ALLOWLIST.contains(&host.as_str()) {
        return true;
    }
    match host.strip_suffix(MARKET_WORKERS_DEV_SUFFIX) {
        // 前缀必须是**单个非空 label**：`a.b.workers.dev` 与裸 `workers.dev` 都不放行。
        Some(label) => !label.is_empty() && !label.contains('.'),
        None => false,
    }
}

/// URL 形态 + 主机闸的参数化实现（下载闸与发布闸共用同一份判定，只有表不同）。
fn url_problem_in(url: &reqwest::Url, gate: &HostGate) -> Option<String> {
    if url.scheme() != "https" {
        return Some(format!("协议不是 https：{url}"));
    }
    let host = match url.host_str() {
        Some(h) => h,
        None => return Some(format!("URL 没有主机名：{url}")),
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Some(format!("URL 带 userinfo：{url}"));
    }
    if let Some(port) = url.port() {
        return Some(format!("URL 带非默认端口 {port}：{url}"));
    }
    if !(gate.host_ok)(host) {
        return Some(format!(
            "主机 {host} 不在平台放行列表（{}）",
            gate.allowlist_desc
        ));
    }
    None
}

/// 重定向逐跳闸的参数化实现（形态同 [`redirect_problem`]，闸可换）。
fn redirect_problem_in(previous: &[reqwest::Url], next: &reqwest::Url, gate: &HostGate) -> Option<String> {
    if previous.len() > MARKET_MAX_REDIRECT_HOPS {
        return Some(format!(
            "重定向跳数超过上限 {MARKET_MAX_REDIRECT_HOPS}：{} → {next}",
            previous.len()
        ));
    }
    url_problem_in(next, gate).map(|p| format!("重定向跳到不可信目标（{p}）"))
}

/// 发布请求用的 client（下载闸换成发布闸，其余口径同一份实现）。
fn publish_http_client(opts: &DownloadOptions) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(MARKET_USER_AGENT)
        .timeout(Duration::from_millis(opts.timeout_ms))
        .redirect(reqwest::redirect::Policy::custom(redirect_action_for(&PUBLISH_GATE)));
    if let Some(proxy) = opts.proxy.as_deref() {
        builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|e| format!("proxy {proxy}: {e}"))?);
    }
    builder.build().map_err(|e| format!("http client: {e}"))
}

/// 一个 URL 能不能作为发布目标（与 [`url_problem`] 同形态、[`PUBLISH_GATE`] 的表）。
pub(crate) fn publish_url_problem(url: &reqwest::Url) -> Option<String> {
    url_problem_in(url, &PUBLISH_GATE)
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PublishManifestSummary {
    pub kind: String,
    pub id: String,
    pub version: String,
    pub name: String,
    pub author: String,
}

/// 上传进度（经 Tauri Channel 回 JS）。上传侧总字节恒已知（命令先 `stat` 一次），
/// 不像下载那样会缺 ⇒ 非 Option（契约 `MarketPublishProgress` 同形）。
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MarketUploadProgressDto {
    pub sent_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PublishRejectionDto {
    pub code: String,
    pub message: String,
}

/// 发布结果（命令面）。`ok` + `pr_url` / `rejected` 是后端裁决的**忠实搬运**——
/// 裁决真源是响应体（哪怕配着非 2xx），桥侧投影成契约判别联。
/// `verified` 是服务端校验深度（如 `structure-only`，CF 免费计划下 sha256 由注册表
/// CI 复核）——原样搬运，桥侧只认契约 `MarketPublishVerified` 的字面量。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MarketPublishResultDto {
    pub status: u16,
    pub final_url: String,
    pub ok: bool,
    pub pr_url: Option<String>,
    pub verified: Option<String>,
    pub rejected: Option<PublishRejectionDto>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MarketDeviceTokenDto {
    pub token: String,
}

/// 端点 → 请求 URL（**纯函数**，`device-token` 与 `publish` 共用）：端点当**基座**用——
/// 路径末尾斜杠归一后直接接固定路径。
/// 刻意**不走 `Url::join`**：join 对无尾斜杠基座是"替换末段"语义（`…/api/v1` 配
/// `publish` 会丢成 `/api/publish`），基座拼法才是作者配置 `<端点>/publish` 的直觉；
/// 查询串与片段不参与（基座就是主机 + 路径）。
pub(crate) fn endpoint_url(endpoint: &str, path: &str) -> Result<reqwest::Url, String> {
    let mut base =
        reqwest::Url::parse(endpoint).map_err(|e| format!("发布端点解析失败 {endpoint}: {e}"))?;
    base.set_query(None);
    base.set_fragment(None);
    let trimmed = base.path().trim_end_matches('/');
    base.set_path(&format!("{trimmed}/{path}"));
    Ok(base)
}

/// 发布请求的 URL 构造（**纯函数**）：`<endpoint>/publish` + manifest 概要作查询参数
/// （服务端可用可不用；身份字段随 URL 走，body 恒是 zip 原始字节，**不搞 multipart**）。
pub(crate) fn publish_request_url(
    endpoint: &str,
    manifest: &PublishManifestSummary,
) -> Result<reqwest::Url, String> {
    let mut url = endpoint_url(endpoint, "publish")?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("kind", &manifest.kind);
        q.append_pair("id", &manifest.id);
        q.append_pair("version", &manifest.version);
        q.append_pair("name", &manifest.name);
        q.append_pair("author", &manifest.author);
    }
    Ok(url)
}

/// 设备令牌请求的 URL 构造（**纯函数**）：`<endpoint>/device-token`。
pub(crate) fn device_token_url(endpoint: &str) -> Result<reqwest::Url, String> {
    endpoint_url(endpoint, "device-token")
}

/* --------------- 上传容器摘要（后端强制的 x-market-zip-sha256） --------------- */

/// 字节 → 小写 hex（摘要头的唯一序列化点；纯函数，单测钉形态）。
pub(crate) fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// 摘要值形态闸（纯函数）：必须恰好 64 位小写 hex（后端只认这一种，大写会被 400 打回）。
pub(crate) fn digest_hex_problem(digest: &str) -> Option<String> {
    if digest.len() != MARKET_ZIP_SHA256_HEX_LEN {
        return Some(format!(
            "sha256 必须是 {} 位 hex，实际 {} 位",
            MARKET_ZIP_SHA256_HEX_LEN,
            digest.len()
        ));
    }
    if !digest
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Some(format!("sha256 只允许小写 hex（0-9a-f）：{digest:?}"));
    }
    None
}

/// 上传请求的两个头（**纯函数**：不碰网络，单测直接钉值）。`guarded_post` 只负责挂上。
pub(crate) fn publish_upload_headers(
    zip_sha256_hex: &str,
) -> Result<reqwest::header::HeaderMap, String> {
    if let Some(problem) = digest_hex_problem(zip_sha256_hex) {
        return Err(format!("包体 sha256 形态不对：{problem}"));
    }
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::HeaderName::from_static(MARKET_ZIP_SHA256_HEADER),
        reqwest::header::HeaderValue::from_str(zip_sha256_hex)
            .map_err(|e| format!("包体 sha256 头构造失败：{e}"))?,
    );
    headers.insert(
        reqwest::header::CONTENT_TYPE,
        reqwest::header::HeaderValue::from_static(MARKET_ZIP_CONTENT_TYPE),
    );
    Ok(headers)
}

/// 流式 SHA-256：按 64 KiB 块吃**原始字节**（文件不进内存），返回 (小写 hex, 读到的字节数)。
/// 泛型只为单测能拿内存 reader 走同一条路径；生产侧传的是 `tokio::fs::File`。
pub(crate) async fn sha256_stream<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<(String, u64), String> {
    use tokio::io::AsyncReadExt as _;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; MARKET_DIGEST_CHUNK_BYTES];
    let mut total: u64 = 0;
    loop {
        let n = reader
            .read(&mut buf)
            .await
            .map_err(|e| format!("读取包体字节失败: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total = total.saturating_add(n as u64);
    }
    Ok((hex_lower(hasher.finalize().as_slice()), total))
}

/// 哈希前后长度一致性闸（纯函数）：预 stat 的长度、实际吃到的字节、哈希后的现长三者必须相等。
/// 不一致 ⇒ 文件在读取过程中变了，**不带着错误摘要上传**（摘要必须描述实际上传的字节）。
pub(crate) fn publish_length_mismatch_problem(
    expected: u64,
    hashed: u64,
    after: u64,
) -> Option<String> {
    if expected == hashed && expected == after {
        return None;
    }
    Some(format!(
        "包在读取过程中发生了变化（打开时 {expected} 字节，读到 {hashed} 字节，哈希后 {after} 字节），请重试"
    ))
}

/* --------------------------- 发布响应归一化 --------------------------- */

/// 非 JSON 正文的摘录上限（字符数）：错误串只带"能认出来是什么"的一小段，
/// 不把整页 HTML 灌进界面 / 日志。
pub(crate) const PUBLISH_BODY_EXCERPT_CHARS: usize = 160;

/// 正文摘录（**纯函数**）：控制字符去掉、连续空白折成一个空格、按字符截断。
/// 非 UTF-8 字节走 lossy（诊断用，不承担解码语义）。
pub(crate) fn body_excerpt(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut normalized = String::with_capacity(text.len().min(1024));
    let mut pending_space = false;
    for ch in text.chars() {
        if ch.is_control() || ch.is_whitespace() {
            pending_space = !normalized.is_empty();
            continue;
        }
        if pending_space {
            normalized.push(' ');
            pending_space = false;
        }
        normalized.push(ch);
    }
    let mut out: String = normalized
        .chars()
        .take(PUBLISH_BODY_EXCERPT_CHARS)
        .collect();
    if normalized.chars().count() > PUBLISH_BODY_EXCERPT_CHARS {
        out.push('…');
    }
    out
}

/// 取 JSON 对象里的非空字符串（trim 后为空视同缺失）。
fn json_text<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// `error` 字段的文本形态：字符串自取；对象取 `code`（没有则 `message`）。
fn error_field_text(value: &serde_json::Value) -> Option<&str> {
    match value.get("error")? {
        serde_json::Value::String(s) => {
            let t = s.trim();
            (!t.is_empty()).then_some(t)
        }
        e @ serde_json::Value::Object(_) => {
            json_text(e, "code").or_else(|| json_text(e, "message"))
        }
        _ => None,
    }
}

/// 非 2xx 的通用错误形状是否"有话可说"（`error` / `message` / `detail` / `code` 任一）。
fn has_http_error_fields(value: &serde_json::Value) -> bool {
    value.get("error").is_some()
        || json_text(value, "message").is_some()
        || json_text(value, "detail").is_some()
        || json_text(value, "code").is_some()
}

/// 拒因码归一（纯函数）：后端给了非空 `code`/`error` 就照搬；没给时 2xx 落 `unknown`、
/// 非 2xx 落 `http-<status>`——**空串不许流出去**（桥侧按码分支）。
pub(crate) fn rejection_code_or_http(raw: Option<&str>, status: u16) -> String {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(code) => code.to_string(),
        None if (200..300).contains(&status) => "unknown".to_string(),
        None => format!("http-{status}"),
    }
}

/// 从 `{rejected:{code,message,detail?}}` 归一（`ok:false` 与"裸 rejected"两条形状共用）。
fn rejection_from_object(
    rejected: &serde_json::Value,
    body: &serde_json::Value,
    status: u16,
    final_url: &str,
) -> MarketPublishResultDto {
    let detail = json_text(rejected, "detail").or_else(|| json_text(body, "detail"));
    if let Some(detail) = detail {
        // Rust 层没有 log 依赖：诊断进 stderr 即可（主 message 不因此丢失）。
        eprintln!("[market_publish] 服务端拒因诊断（HTTP {status}）：{detail}");
    }
    let code = rejection_code_or_http(
        json_text(rejected, "code").or_else(|| json_text(rejected, "error")),
        status,
    );
    // message 为空时用 detail 兜底；两者都空 ⇒ 空串（code 是主键，桥侧有人话兜底）。
    let message = json_text(rejected, "message")
        .or(detail)
        .unwrap_or_default()
        .to_string();
    MarketPublishResultDto {
        status,
        final_url: final_url.to_string(),
        ok: false,
        pr_url: None,
        verified: None,
        rejected: Some(PublishRejectionDto { code, message }),
    }
}

/// 从**顶层** `error` / `message` / `detail` 归一（非 2xx 的通用错误形状）。
fn rejection_from_http_body(
    body: &serde_json::Value,
    status: u16,
    final_url: &str,
) -> MarketPublishResultDto {
    let detail = json_text(body, "detail");
    if let Some(detail) = detail {
        eprintln!("[market_publish] 服务端拒因诊断（HTTP {status}）：{detail}");
    }
    let code = rejection_code_or_http(
        error_field_text(body).or_else(|| json_text(body, "code")),
        status,
    );
    let message = json_text(body, "message")
        .or(detail)
        .or_else(|| error_field_text(body))
        .map(str::to_string)
        .unwrap_or_else(|| format!("服务端以 HTTP {status} 拒绝了发布请求"));
    MarketPublishResultDto {
        status,
        final_url: final_url.to_string(),
        ok: false,
        pr_url: None,
        verified: None,
        rejected: Some(PublishRejectionDto { code, message }),
    }
}

/// 非 JSON / 形状不可读时的平台错误（附 HTTP 状态、finalUrl 与正文摘录——铁律 4 要可诊断）。
fn publish_body_error(prefix: &str, bytes: &[u8], status: u16, final_url: &str) -> String {
    format!(
        "{prefix}（HTTP {status}，最终 URL {final_url}，{} 字节）；正文摘录：{}",
        bytes.len(),
        body_excerpt(bytes)
    )
}

/// 解析发布响应体（**纯函数**）。裁决真源是 body 而非状态码：
/// - 2xx `{ok:true, prUrl, verified?}` ⇒ 成功（prUrl 缺失/空 = 明确错误，绝不演成成功）；
/// - `{ok:false, rejected:{code,message,detail?}}` ⇒ 拒绝；
/// - **`ok` 缺失但带 `rejected` 对象** ⇒ 拒绝（2026-10-18 实测的后端形状：HTTP 400 +
///   裸 `{"rejected":{...}}`；旧实现报"缺 ok"，把真实拒因吞掉了）；
/// - 非 2xx 且带 `error` / `message` / `detail` ⇒ 拒绝（code 取 `error`/`code`，
///   否则 `http-<status>`）；
/// - 非 JSON ⇒ 平台错误（带状态、finalUrl、正文摘录）；解析不出裁决 ⇒ 人话错误（铁律 4）。
pub(crate) fn parse_publish_body(
    bytes: &[u8],
    status: u16,
    final_url: &str,
) -> Result<MarketPublishResultDto, String> {
    let v: serde_json::Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(e) => {
            return Err(publish_body_error(
                &format!("发布响应不是合法 JSON：{e}"),
                bytes,
                status,
                final_url,
            ));
        }
    };

    match v.get("ok") {
        Some(serde_json::Value::Bool(true)) => {
            let pr = v
                .get("prUrl")
                .and_then(|p| p.as_str())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    publish_body_error(
                        "发布响应 ok=true 却没有可用的 prUrl",
                        bytes,
                        status,
                        final_url,
                    )
                })?;
            // verified：服务端校验深度（如 "structure-only"）——原样搬运，桥侧按契约字面量投影
            let verified = v
                .get("verified")
                .and_then(|w| w.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from);
            Ok(MarketPublishResultDto {
                status,
                final_url: final_url.to_string(),
                ok: true,
                pr_url: Some(pr.to_string()),
                verified,
                rejected: None,
            })
        }
        Some(serde_json::Value::Bool(false)) => {
            if let Some(rejected) = v.get("rejected").filter(|r| r.is_object()) {
                return Ok(rejection_from_object(rejected, &v, status, final_url));
            }
            // ok=false 但把话放在顶层 error/message/detail：照拒绝归一，不报"缺 rejected"。
            if has_http_error_fields(&v) {
                return Ok(rejection_from_http_body(&v, status, final_url));
            }
            Err(publish_body_error(
                "发布响应 ok=false 却没有 rejected 结构（code/message 无处可读）",
                bytes,
                status,
                final_url,
            ))
        }
        Some(_) => Err(publish_body_error(
            "发布响应的 ok 字段不是布尔值",
            bytes,
            status,
            final_url,
        )),
        None => {
            // 本次后端形状：ok 缺失 + 裸 rejected 对象（哪怕配着 4xx）⇒ 拒绝，不是"缺 ok"。
            if let Some(rejected) = v.get("rejected").filter(|r| r.is_object()) {
                return Ok(rejection_from_object(rejected, &v, status, final_url));
            }
            if !(200..300).contains(&status) && has_http_error_fields(&v) {
                return Ok(rejection_from_http_body(&v, status, final_url));
            }
            Err(publish_body_error(
                "发布响应缺 ok 字段且没有 rejected 裁决",
                bytes,
                status,
                final_url,
            ))
        }
    }
}

/// 解析设备令牌响应体（**纯函数**）：`{token: "..."}`，空串不给。
pub(crate) fn parse_device_token(bytes: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|e| format!("设备令牌响应不是合法 JSON：{e}"))?;
    v.get("token")
        .and_then(|t| t.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .ok_or_else(|| "设备令牌响应缺 token 字段".to_string())
}

/// 上传用的流式 body：tokio 文件逐块读出，**节流口径与下载同一份**（[`progress_due`]，
/// ≥64 KiB 或 ≥100 ms；首块直发、EOF 收尾补一发终值）。读文件失败把错误塞进流
/// （reqwest 中止请求）⇒ 调用方收到人话。zip 原文件**零解包零改写**：这里只读不写。
fn upload_stream(
    file: tokio::fs::File,
    total: u64,
    on_progress: Option<tauri::ipc::Channel<MarketUploadProgressDto>>,
) -> impl futures_util::Stream<Item = Result<Vec<u8>, std::io::Error>> + Send + 'static {
    struct State {
        file: tokio::fs::File,
        buf: Vec<u8>,
        sent: u64,
        last_report: Option<(u64, Instant)>,
        channel: Option<tauri::ipc::Channel<MarketUploadProgressDto>>,
        total: u64,
    }
    futures_util::stream::unfold(
        State {
            file,
            buf: vec![0u8; 64 * 1024],
            sent: 0,
            last_report: None,
            channel: on_progress,
            total,
        },
        |mut st| async move {
            use tokio::io::AsyncReadExt as _;
            match st.file.read(&mut st.buf).await {
                Ok(0) => {
                    // EOF：收尾补一发让 UI 落在终值（重复读数由节流判定压掉；
                    // 空容器不发——预校验在 TS 侧根本到不了这里）。
                    if st.total > 0 {
                        if let Some(ch) = &st.channel {
                            let _ = ch.send(MarketUploadProgressDto {
                                sent_bytes: st.sent,
                                total_bytes: st.total,
                            });
                        }
                    }
                    None
                }
                Ok(n) => {
                    st.sent += n as u64;
                    let now = Instant::now();
                    let due = match st.last_report {
                        None => progress_due(n as u64, None),
                        Some((sent_at, at)) => progress_due(
                            st.sent.saturating_sub(sent_at),
                            Some(now.duration_since(at)),
                        ),
                    };
                    if due {
                        if let Some(ch) = &st.channel {
                            let _ = ch.send(MarketUploadProgressDto {
                                sent_bytes: st.sent,
                                total_bytes: st.total,
                            });
                        }
                        st.last_report = Some((st.sent, now));
                    }
                    Some((Ok(st.buf[..n].to_vec()), st))
                }
                Err(e) => Some((
                    Err(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())),
                    st,
                )),
            }
        },
    )
}

/// 发布链路（`guarded_send` 的 POST 亲兄弟，两处结构差别）：**不按非 2xx 预判失败**——
/// 后端的拒绝裁决在响应体里（可能配 4xx），状态码交给 [`parse_publish_body`] 裁决；
/// `bearer` 以 `Authorization` 头携带（**唯一**的鉴权通道，token 不进 URL——查询串会进日志）。
/// 出网闸（形态 + 发布白名单 + 逐跳重核 + 终态重核）与下载是同一份形态。
/// `upload_headers` 由 [`publish_upload_headers`] 从容器摘要构造（`x-market-zip-sha256` +
/// `Content-Type: application/zip`）：后端缺这个头直接 400，摘要必须是实际上传字节的摘要。
async fn guarded_post(
    url: &reqwest::Url,
    body: reqwest::Body,
    bearer: &str,
    upload_headers: &reqwest::header::HeaderMap,
    opts: &DownloadOptions,
) -> Result<(u16, reqwest::Url, Vec<u8>), String> {
    if let Some(problem) = publish_url_problem(url) {
        return Err(format!("market_publish 拒绝（{problem}）"));
    }
    ensure_tls_provider();
    let client = publish_http_client(opts)?;
    let response = client
        .post(url.clone())
        .bearer_auth(bearer)
        .headers(upload_headers.clone())
        .body(body)
        .send()
        .await
        .map_err(|e| format!("market_publish 请求失败 {url}: {}", chain_string(&e)))?;
    let status = response.status().as_u16();
    let final_url = response.url().clone();
    // 终态 URL 再核一次发布放行表（策略闸管"跳"，这一闸管"落点"）。
    if let Some(problem) = publish_url_problem(&final_url) {
        return Err(format!("market_publish 拒绝（最终 URL：{problem}）"));
    }
    // 裁决 JSON 很小：256 KiB 兜底上限（与取文本同口径），超了按截断处理不硬收。
    let mut body_bytes: Vec<u8> = Vec::new();
    stream_capped(response, MARKET_DEFAULT_MAX_FETCH_BYTES, &mut body_bytes).await?;
    Ok((status, final_url, body_bytes))
}

/// 发布一个 zip（**唯一**的上传出网路径）。zip 由**绝对路径**给出——
/// 授权模型照 `export_file` 的"对话框即授权"哲学：路径来自用户经系统对话框选定的文件
/// （TS 侧预校验编排保证），读侧无闸是既有口径（`read_file_bytes` 同样读任意路径）；
/// 闸在**出网侧**（发布放行表）与**体积侧**（TS 从契约常量传入）。
/// 字节**不经 IPC 回 JS**：本层流式读原文件上传（128 MiB 的包体不该过一遍 JS 堆），
/// 进度按 [`progress_due`] 节流经 Channel 回报。
///
/// 摘要与上传**共用同一个文件句柄**：先逐块（64 KiB）算原始字节的 SHA-256（不进内存、
/// 不报进度——那不是上传进度），核过"打开时 / 读到 / 哈希后"三个长度一致后再 `seek(0)`
/// 交给 [`upload_stream`]。文件在读取中变化 ⇒ 明确报错，不带着错误摘要上传。
pub(crate) async fn publish_zip(
    zip_path: &Path,
    endpoint: &str,
    manifest: &PublishManifestSummary,
    device_token: &str,
    opts: &DownloadOptions,
    on_progress: Option<&tauri::ipc::Channel<MarketUploadProgressDto>>,
) -> Result<MarketPublishResultDto, String> {
    if device_token.is_empty() {
        return Err("market_publish 拒绝（设备令牌为空，先经 /device-token 换一枚）".to_string());
    }
    let url = publish_request_url(endpoint, manifest)?;
    let meta = tokio::fs::metadata(zip_path)
        .await
        .map_err(|e| format!("要发布的包文件读不到 {}: {e}", zip_path.display()))?;
    if !meta.is_file() {
        return Err(format!("要发布的不是一个普通文件：{}", zip_path.display()));
    }
    let total = meta.len();
    if total > opts.max_bytes {
        return Err(format!(
            "包体 {total} 字节超过上限 {}，先瘦身再发",
            opts.max_bytes
        ));
    }
    let mut file = tokio::fs::File::open(zip_path)
        .await
        .map_err(|e| format!("打开要发布的包失败 {}: {e}", zip_path.display()))?;
    let (zip_sha256, hashed_bytes) = sha256_stream(&mut file)
        .await
        .map_err(|e| format!("计算包体 sha256 失败 {}: {e}", zip_path.display()))?;
    let after = file
        .metadata()
        .await
        .map_err(|e| format!("读包体状态失败 {}: {e}", zip_path.display()))?
        .len();
    if let Some(problem) = publish_length_mismatch_problem(total, hashed_bytes, after) {
        return Err(format!(
            "market_publish 拒绝（{problem}）：{}",
            zip_path.display()
        ));
    }
    {
        use tokio::io::AsyncSeekExt as _;
        file.seek(std::io::SeekFrom::Start(0))
            .await
            .map_err(|e| format!("包体回绕失败 {}: {e}", zip_path.display()))?;
    }
    let headers = publish_upload_headers(&zip_sha256)?;
    let body = reqwest::Body::wrap_stream(upload_stream(file, total, on_progress.cloned()));
    let (status, final_url, body_bytes) =
        guarded_post(&url, body, device_token, &headers, opts).await?;
    parse_publish_body(&body_bytes, status, final_url.as_str())
}

#[tauri::command]
pub(crate) async fn market_publish(
    zip_path: String,
    manifest: PublishManifestSummary,
    device_token: String,
    endpoint: Option<String>,
    max_bytes: Option<u64>,
    timeout_ms: Option<u64>,
    // Channel **必传**（同 `market_download`：Option<Channel> 不走 CommandArg）。
    on_progress: tauri::ipc::Channel<MarketUploadProgressDto>,
) -> Result<MarketPublishResultDto, String> {
    publish_zip(
        Path::new(&zip_path),
        endpoint
            .as_deref()
            .unwrap_or(MARKET_DEFAULT_PUBLISH_ENDPOINT),
        &manifest,
        &device_token,
        &DownloadOptions {
            timeout_ms: timeout_ms.unwrap_or(MARKET_DEFAULT_TIMEOUT_MS),
            max_bytes: max_bytes.unwrap_or(MARKET_DEFAULT_MAX_PUBLISH_BYTES),
            // 代理只认进程环境（同 `market_download`）
            proxy: None,
        },
        Some(&on_progress),
    )
    .await
}

/// 换一枚设备令牌（`POST /device-token`，零请求体）：与发布同一条出网链路
/// （发布放行表 + 逐跳重核 + 终态重核）。令牌的存取（storage 复用）归 TS 侧编排。
#[tauri::command]
pub(crate) async fn market_device_token(
    endpoint: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<MarketDeviceTokenDto, String> {
    let url = device_token_url(endpoint.as_deref().unwrap_or(MARKET_DEFAULT_PUBLISH_ENDPOINT))?;
    ensure_tls_provider();
    let client = publish_http_client(&DownloadOptions {
        timeout_ms: timeout_ms.unwrap_or(MARKET_DEVICE_TOKEN_TIMEOUT_MS),
        max_bytes: MARKET_DEFAULT_MAX_FETCH_BYTES,
        proxy: None,
    })?;
    if let Some(problem) = publish_url_problem(&url) {
        return Err(format!("market_device_token 拒绝（{problem}）"));
    }
    let response = client
        .post(url.clone())
        .send()
        .await
        .map_err(|e| format!("market_device_token 请求失败 {url}: {}", chain_string(&e)))?;
    let final_url = response.url().clone();
    if let Some(problem) = publish_url_problem(&final_url) {
        return Err(format!("market_device_token 拒绝（最终 URL：{problem}）"));
    }
    let status = response.status();
    let mut body_bytes: Vec<u8> = Vec::new();
    stream_capped(response, MARKET_DEFAULT_MAX_FETCH_BYTES, &mut body_bytes).await?;
    if !status.is_success() {
        return Err(format!(
            "HTTP 状态非 2xx：{status}（最终 URL {final_url}）"
        ));
    }
    Ok(MarketDeviceTokenDto {
        token: parse_device_token(&body_bytes)?,
    })
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
