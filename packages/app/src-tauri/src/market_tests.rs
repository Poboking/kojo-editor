//! 市场 IO 原语的判据。四组：URL 白名单（含逐跳重定向）、暂存名字面、解压安全闸、
//! 与注册表真实容器的跨实现对平。
//!
//! 对平用的容器字节**逐字取自线上注册表资产**（`tests/fixtures/*.zip`；注册表侧是
//! `node:zlib` 自写容器，不是 `zip` 命令产物），所以这条链路在开发机离线可复跑。
//! 网络版对平有两条，都 `#[ignore]`（github 直连必 timeout，须经代理）：
//! `download_and_extract_real_release_assets`（显式代理，三资产）与
//! `download_through_env_proxy_uses_system_proxy`（命令侧 `proxy: None` 的生产口径）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::market::{
    advance_byte_cap, container_name_problem, content_length_problem, download_to_staging,
    entry_type_problem, extract_staging, extract_staging_off_thread, fetch_text, host_in_allowlist,
    market_fetch_text, redirect_problem, staging_component_problem, url_problem, utf8_text,
    DownloadOptions, StagingLimits,
};

/// 限额字面照契约常量（`plugin-api/market.ts`）；Rust 侧不写死，测试里显式传入。
const LIMITS: StagingLimits = StagingLimits {
    max_entries: 5000,
    max_depth: 12,
    max_unpacked_bytes: 128 * 1024 * 1024,
};

fn url(s: &str) -> reqwest::Url {
    reqwest::Url::parse(s).expect("测试内 URL 必须可解析")
}

fn hops(list: &[&str]) -> Vec<reqwest::Url> {
    list.iter().map(|s| url(s)).collect()
}

/* ---------------------------- 临时暂存目录 ---------------------------- */

static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

struct Staging {
    dir: PathBuf,
}

impl Staging {
    fn new(tag: &str) -> Self {
        let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "kojo-market-test-{}-{}-{n}",
            std::process::id(),
            tag
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("临时暂存目录必须可建");
        Staging { dir }
    }

    fn dir(&self) -> &Path {
        &self.dir
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/* ---------------------------- 造容器（负例） ---------------------------- */

fn stored() -> zip::write::SimpleFileOptions {
    zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)
}

fn deflated() -> zip::write::SimpleFileOptions {
    zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)
}

/// 按 `(名字, 内容)` 顺序造一个普通容器（deflate，与注册表容器同一压缩口径）。
fn build_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, data) in files {
        writer.start_file(*name, deflated()).unwrap();
        std::io::Write::write_all(&mut writer, data).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

/// 带一个符号链接条目的容器（目标指向容器外）。
fn zip_with_symlink(link_name: &str, target: &str) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    writer.start_file("pack.json", stored()).unwrap();
    std::io::Write::write_all(&mut writer, b"{\"schema\":1}").unwrap();
    writer.add_symlink(link_name, target, stored()).unwrap();
    writer.finish().unwrap().into_inner()
}

fn write_container(staging: &Staging, name: &str, bytes: &[u8]) {
    std::fs::write(staging.dir().join(name), bytes).unwrap();
}

/// 暂存目录里除了合法容器不能有别的东西（"失败不留半成品"判据）。
fn assert_only_container(staging: &Staging, container: &str) {
    let mut names: Vec<String> = std::fs::read_dir(staging.dir())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, vec![container.to_string()], "暂存目录里出现了半成品");
}

/* ------------------------------- 白名单 ------------------------------- */

#[test]
fn allowlist_accepts_pinned_hosts_and_pages_subdomains() {
    for host in [
        "github.com",
        "raw.githubusercontent.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
        "demo.github.io",
        "some-user.github.io",
        "GitHub.COM",
        "github.com.",
    ] {
        assert!(host_in_allowlist(host), "{host} 应在白名单内");
    }
}

#[test]
fn allowlist_rejects_lookalikes_and_nested_labels() {
    for host in [
        "evil.com",
        "github.com.evil.io",
        "notgithub.io",
        ".github.io",
        "a.b.github.io",
        "github.io",
        "",
    ] {
        assert!(!host_in_allowlist(host), "{host} 不该被放行");
    }
}

#[test]
fn url_gate_rejects_scheme_port_and_userinfo_disguise() {
    assert!(url_problem(&url("http://github.com/a/b.zip")).is_some());
    assert!(url_problem(&url("file:///C:/x.zip")).is_some());
    assert!(url_problem(&url("https://github.com@evil.io/a.zip")).is_some());
    assert!(url_problem(&url("https://github.com:8443/a.zip")).is_some());
    assert!(url_problem(&url("https://raw.githubusercontent.com/o/r/a/pack.zip")).is_none());
}

#[test]
fn redirect_gate_rejects_hop_outside_allowlist_and_hops_over_cap() {
    // 实测形态：release 资产 302 → release-assets.githubusercontent.com，这一跳必须放行
    let ok = hops(&[
        "https://github.com/Poboking/kojo-market/releases/download/t/a.zip",
        "https://release-assets.githubusercontent.com/signed/asset",
    ]);
    assert_eq!(redirect_problem(&ok[..1], &ok[1]), None);

    let first = hops(&["https://github.com/a/releases/download/t/a.zip"]);
    let problem = redirect_problem(&first, &url("https://evil.io/a.zip")).unwrap();
    assert!(problem.contains("不在平台放行列表"), "白名单外一跳没被拒：{problem}");

    // 中途跳到 pages 之外的主机同样拒（每一跳重核，不是只核首尾）
    let chain = hops(&[
        "https://github.com/1",
        "https://demo.github.io/2",
        "https://objects.githubusercontent.com/3",
    ]);
    assert!(redirect_problem(&chain, &url("https://evil.io/4")).is_some());

    // 跳数上限 5：previous 已有 5 跳（含首跳共 6 个 URL）时再跟一跳即拒
    let long = hops(&[
        "https://github.com/1",
        "https://github.com/2",
        "https://github.com/3",
        "https://github.com/4",
        "https://github.com/5",
        "https://github.com/6",
    ]);
    assert!(redirect_problem(&long, &url("https://github.com/7"))
        .unwrap()
        .contains("跳数"));
    assert!(redirect_problem(&long[..5], &url("https://github.com/6")).is_none());
}

/* ----------------------------- 暂存名字面 ----------------------------- */

#[test]
fn container_name_gate_rejects_traversal_and_bad_charset() {
    for bad in [
        "a/b.zip",
        "..\\a.zip",
        "../a.zip",
        "C:\\a.zip",
        "A.ZIP",
        "a b.zip",
        ".zip",
        &format!("{}.zip", "a".repeat(64)),
        "pack.rar",
        "..",
        ".",
        "",
    ] {
        assert!(
            container_name_problem(bad).is_some(),
            "非法容器名被放行：{bad:?}"
        );
    }
    assert!(container_name_problem("demo.era-tw-1.0.1.zip").is_none());
    assert!(container_name_problem("a_b-c.1.zip").is_none());
    // 边界：恰好 STAGING_NAME_MAX=64（60 主体 + ".zip"）在闸内，65 才拒
    assert!(container_name_problem(&format!("{}.zip", "a".repeat(60))).is_none());
    assert!(container_name_problem(&format!("{}.zip", "a".repeat(61))).is_some());
}

#[test]
fn staging_component_gate_rejects_dot_names_and_separators() {
    for bad in ["", ".", "..", "a/b", "..\\x", "sub dir", "A"] {
        assert!(
            staging_component_problem(bad).is_some(),
            "非法暂存名被放行：{bad:?}"
        );
    }
    assert!(staging_component_problem("demo.era-tw-1.0.1").is_none());
}

/* ------------------------------ 取文本（KM-8） ------------------------------ */

/// `market_fetch_text` 的 URL 闸与 `market_download` **必须是同一份函数**：
/// 同一条非法 URL 走两条链路，错误里的判定文案要逐字相同（复制一份必然漂）。
#[test]
fn fetch_text_rejects_the_same_urls_as_download_gate() {
    let staging = Staging::new("fetch-gate");
    for bad in [
        "http://github.com/a/index.json",
        "file:///C:/x/index.json",
        "https://evil.com/index.json",
        "https://a.b.github.io/index.json",
        "https://github.com:8443/index.json",
        "https://github.com@evil.io/index.json",
    ] {
        let opts = DownloadOptions {
            timeout_ms: 1_000,
            max_bytes: 4_096,
            proxy: None,
        };
        let fetched = tauri::async_runtime::block_on(fetch_text(bad, &opts))
            .expect_err("白名单外 / 非 https 的 URL 不该出网");
        let downloaded = tauri::async_runtime::block_on(download_to_staging(
            staging.dir(),
            bad,
            "index.zip",
            &opts,
        ))
        .expect_err("同一条 URL 在下载链路也必须被拒");
        // 同一条判定 ⇒ 同一段文案；两条链路的差异只许在命令名前缀
        let problem = url_problem(&url(bad)).expect("夹具本身必须被 url_problem 拒");
        assert!(fetched.contains(&problem), "fetch 的判定文案不符：{fetched}");
        assert!(
            downloaded.contains(&problem),
            "download 与 fetch 用的不是同一份判定：{downloaded} vs {fetched}"
        );
        assert!(
            fetched.starts_with("market_fetch_text 拒绝"),
            "错误没自报出处：{fetched}"
        );
        // 拒在出网之前 ⇒ 暂存区一个字节都不许多出来
        assert_eq!(
            std::fs::read_dir(staging.dir()).unwrap().count(),
            0,
            "闸前就写了盘：{bad}"
        );
    }
}

/// 取文本**没有**容器名闸（不落盘 ⇒ 不该有 `.zip` 前提）；这条同时钉住
/// "没为拉索引放宽 `.zip`"与"没把下载侧的名字闸错套到取文本上"。
#[test]
fn fetch_text_has_no_container_name_gate_but_download_still_does() {
    let staging = Staging::new("fetch-name");
    let opts = DownloadOptions {
        timeout_ms: 1_000,
        max_bytes: 4_096,
        proxy: None,
    };
    // 非法容器名 ⇒ 下载侧照旧拒（不放宽）
    let e = tauri::async_runtime::block_on(download_to_staging(
        staging.dir(),
        "https://demo.github.io/index.json",
        "index.bin",
        &opts,
    ))
    .expect_err(".zip 容器名闸不许为拉索引放宽");
    assert!(e.contains(".zip"), "拒因不符：{e}");
    assert_eq!(std::fs::read_dir(staging.dir()).unwrap().count(), 0, "名字闸拒在写盘之前");
    // 同一条 URL 走取文本 ⇒ 不报容器名、不被 URL 闸拒（白名单内）；本机无网 ⇒ 停在请求阶段
    let e = tauri::async_runtime::block_on(fetch_text("https://demo.github.io/index.json", &opts))
        .expect_err("离线夹具不该成功");
    assert!(!e.contains(".zip"), "取文本被错套了容器名闸：{e}");
    assert!(!e.contains("拒绝"), "白名单内的 URL 不该被 URL 闸拒：{e}");
}

/// 体积闸的两处纯判定（`Content-Length` 预核 + 逐块累计）：两条链路共用同一份，边界钉住。
#[test]
fn byte_cap_gates_share_boundaries() {
    assert_eq!(content_length_problem(1024, 2048), None);
    assert!(content_length_problem(2049, 2048)
        .unwrap()
        .contains("Content-Length"));
    assert_eq!(advance_byte_cap(2040, 8, 2048).unwrap(), 2048);
    assert!(advance_byte_cap(2048, 1, 2048)
        .unwrap_err()
        .contains("2049"));
    // 溢出兜底：u64 相加不许 wrap（恶意分片长度不能绕过体积闸）
    assert!(advance_byte_cap(u64::MAX, usize::MAX, 2048).is_err());
}

/// UTF-8 闸（纯判定、离线可跑）：取文本只认 UTF-8，非法字节明确拒绝。
#[test]
fn fetch_text_decodes_only_utf8() {
    assert_eq!(utf8_text(b"{\"schema\":1}").unwrap(), "{\"schema\":1}");
    assert!(utf8_text(&[0xff, 0xfe, 0x00]).unwrap_err().contains("UTF-8"));
    // 空响应体不在本层拒（交给上层 JSON 解析去判"形状不受支持"），本层不替它做主
    assert_eq!(utf8_text(b"").unwrap(), "");
}

/// **命令面**（不是内部函数）也被同一条闸管着：`market_fetch_text` 自己就得拒掉白名单外 /
/// 非 https 的 URL，且拒在出网与写盘之前。这条防的是"后来者给命令另起一条 reqwest 调用"——
/// 那种接线绕过 `guarded_send`，单测内部函数是拦不住的。
#[test]
fn fetch_text_command_itself_rejects_before_any_network() {
    for bad in [
        "http://poboking.github.io/kojo-market/index.json",
        "https://evil.example/index.json",
        "https://github.com@evil.example/index.json",
    ] {
        let e = tauri::async_runtime::block_on(market_fetch_text(bad.to_string(), Some(1_000), Some(4_096)))
            .expect_err("命令面不许把内部闸漏掉");
        assert!(e.starts_with("market_fetch_text 拒绝"), "命令没自报出处：{e}");
        // 拒因**逐字**等于同一份 `url_problem` 的判定（命令面不许自己重写一套文案）
        let problem = url_problem(&url(bad)).expect("夹具本身必须被 url_problem 拒");
        assert!(e.contains(&problem), "命令面的拒因与内部闸不符：{e}");
    }
    // 限额走**入参**，本层不私藏第二份业务真相：没传时才有兜底默认值（传了就按传的拒）
    let e = tauri::async_runtime::block_on(market_fetch_text(
        "https://poboking.github.io/kojo-market/index.json".to_string(),
        Some(1),
        Some(1),
    ))
    .expect_err("timeout_ms=1 / max_bytes=1 不可能取回 1.6 KB 索引");
    assert!(!e.starts_with("market_fetch_text 拒绝"), "白名单内被 URL 闸误拒：{e}");
}

/// 真链路（**需联网**；`poboking.github.io` 直连可达，按产品口径不需要代理）：
/// 取回线上注册表索引，钉 200 / 1,586 B / 逐条目读数，
/// 并在同一条链路上证明**体积闸按入参生效**（GitHub Pages 回 Content-Length ⇒ 预核就拒）。
/// 条目读数实测于 2026-10-15（`index.json` 的 sha256 对平归 Node 侧工具，本层**不算哈希**）：
/// `packs` = 2 条（`dict-pack/demo.dict@1.0.0`、`kojo-pack/demo.era-tw@1.0.1`）——
/// 不是"≥3"（任务书给的 ≥3 是旧读数，实测就是 2 条，见 `tools/smoke-tauri-market.mjs` 的同一条锚）。
/// 跑法：`node -e "require('child_process').execSync('cargo test --lib market_tests::fetch_real_index -- --ignored --nocapture',{cwd:'packages/app/src-tauri',stdio:'inherit'})"`
#[test]
#[ignore = "需要网络：离线 CI 阶段不跑（poboking.github.io 直连即可）"]
fn fetch_real_index_matches_pinned_anchor_and_honours_byte_cap() {
    let url = "https://poboking.github.io/kojo-market/index.json";
    let got = tauri::async_runtime::block_on(fetch_text(
        url,
        &DownloadOptions {
            timeout_ms: 15_000,
            max_bytes: 512 * 1024,
            proxy: None,
        },
    ))
    .unwrap_or_else(|e| panic!("真实索引取不回来 {url}: {e}"));
    assert_eq!(got.status, 200, "线上索引状态非 200");
    // 锚点读数（2026-10-15 复算）：1,586 B ⇒ 字节数与 Content-Length 都得钉住
    assert_eq!(got.bytes, 1_586, "线上索引字节与钉数不平");
    assert_eq!(got.text.len() as u64, got.bytes, "回报字节与实际正文不平");
    assert!(got.final_url.starts_with("https://poboking.github.io/"), "落点跑白：{}", got.final_url);

    let v: serde_json::Value = serde_json::from_str(&got.text).expect("线上索引必须是合法 JSON");
    assert_eq!(v["schema"].as_i64(), Some(1), "线上索引 schema 不是 1");
    let packs = v["packs"].as_array().expect("packs 必须是数组");
    let mut rows: Vec<(String, String, String, i64, i64)> = packs
        .iter()
        .map(|p| {
            (
                p["kind"].as_str().unwrap_or_default().to_string(),
                p["id"].as_str().unwrap_or_default().to_string(),
                p["version"].as_str().unwrap_or_default().to_string(),
                p["fileCount"].as_i64().unwrap_or(-1),
                p["unpackedBytes"].as_i64().unwrap_or(-1),
            )
        })
        .collect();
    rows.sort();
    assert_eq!(
        rows,
        vec![
            ("dict-pack".to_string(), "demo.dict".to_string(), "1.0.0".to_string(), 1, 77),
            ("kojo-pack".to_string(), "demo.era-tw".to_string(), "1.0.1".to_string(), 1, 471),
        ],
        "线上索引条目与钉数不平"
    );
    for p in packs {
        let sha = p["zip"]["sha256"].as_str().unwrap_or_default();
        assert!(sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit()), "条目没有 64 位整包 sha256 锚：{p}");
    }

    // 同一条链路、把上限压到 128 B ⇒ 必须被 Content-Length 预核拒掉（闸吃入参，不是写死的）
    let e = tauri::async_runtime::block_on(fetch_text(
        url,
        &DownloadOptions { timeout_ms: 15_000, max_bytes: 128, proxy: None },
    ))
    .expect_err("128 B 的上限必须拒掉 1,586 B 的索引");
    assert!(e.contains("Content-Length"), "体积闸没按入参生效：{e}");
    assert!(e.contains("128"), "拒因里没给出上限值：{e}");
}

/// 超时不是装饰（**需可控网络环境**）：进程环境的代理指向不可路由地址 ⇒ 连接挂住，
/// 必须由 client 的 `timeout_ms` 落地成人话错误。命令面 `proxy: None` 时代理来自 env，
/// 这条同时也证明"env 侧的代理设置真的进了这条链路"。
/// 跑法：`node -e "process.env.KOJO_NONE='1';require('child_process').execSync('cargo test --lib market_tests::fetch_text_honours -- --ignored --nocapture',{cwd:'packages/app/src-tauri',stdio:'inherit'})"`
#[test]
#[ignore = "需要把 HTTPS_PROXY 指向不可路由地址：离线 CI 阶段不跑"]
fn fetch_text_honours_the_request_timeout() {
    std::env::set_var("HTTPS_PROXY", "http://10.255.255.1:1");
    let started = std::time::Instant::now();
    let e = tauri::async_runtime::block_on(fetch_text(
        "https://poboking.github.io/kojo-market/index.json",
        &DownloadOptions { timeout_ms: 1_500, max_bytes: 4_096, proxy: None },
    ))
    .expect_err("代理指向黑洞时不该成功");
    let took = started.elapsed();
    assert!(
        e.contains("timeout") || e.contains("timed out") || e.contains("超时"),
        "错误里没有超时形状：{e}"
    );
    // 钉在"超时确实生效"的量级上：远小于系统 TCP 的 21 s，又不能提前到没跑起来
    assert!(took < std::time::Duration::from_secs(10), "超时没在预算内落地：{took:?}");
}

/// 本地头里条目数据的起始偏移（sig4 ver2 flags2 method2 time2 date2 crc4 csize4 usize4 **namelen2 extralen2**）。
fn stored_payload_offset(zip: &[u8]) -> usize {
    assert_eq!(&zip[..4], b"PK\x03\x04".as_slice(), "不是本地文件头");
    30 + u16::from_le_bytes([zip[26], zip[27]]) as usize + u16::from_le_bytes([zip[28], zip[29]]) as usize
}

#[test]
fn extract_rejects_tampered_payload_and_removes_partial_output() {
    // 声明字节没变、只有响应体被改 ⇒ 两遍闸全过，兜底的是 zip 的 CRC32 校验（zip-4.6.1/src/crc32.rs:8）
    let payload = vec![b'k'; 4096];
    let mut bytes = {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer.start_file("files/a.bin", stored()).unwrap();
        std::io::Write::write_all(&mut writer, &payload).unwrap();
        writer.finish().unwrap().into_inner()
    };
    let offset = stored_payload_offset(&bytes);
    bytes[offset] ^= 0xFF;

    let staging = Staging::new("crc");
    write_container(&staging, "a.zip", &bytes);
    let err = extract_staging(staging.dir(), "a.zip", "out", &LIMITS).unwrap_err();
    assert!(
        err.contains("Invalid checksum") || err.contains("checksum"),
        "被改过的响应体没报错：{err}"
    );
    assert!(!staging.dir().join("out").exists(), "校验失败仍留着半截解压内容");
    assert_only_container(&staging, "a.zip");
}

/// PERF-10 ③：`market_extract` 改成 `async` + `spawn_blocking` 之后的两条判据。
///
/// 结构证据（为什么必须改）：`extract_into` 两遍扫中央目录 + 逐条 64 KB 落盘，限额
/// 5000 条目 / 128 MiB，而同步命令跑在主线程上 ⇒ 大包期间整个 WebView 冻住
/// （今天注册表包 1 文件 / 471 B 量不出来，是结构性隐患而不是"不存在"）。
/// `spawn_blocking` 的闭包要求 `'static + Send`，编译器直接把关 —— 这条改动的形态
/// 与同文件 `market_download` / `market_fetch_text`（都是 `async fn`）对齐。
///
/// 这里**不测异步本身**（那要 AppHandle），测的是"换成异步没换掉任何解压语义"：
/// 1. off-thread 形态与同步形态**逐字段同果**（条目表、总字节、落盘字节）；
/// 2. 容器名字面闸照样在**一个字节都没写出去**之前拒，且拒因文本逐字不变
///    （闸在命令内、与落盘同命令那条纪律，挪线程不许把它挪到线程里去）。
#[test]
fn extract_off_thread_matches_sync_and_keeps_the_name_gate() {
    let staging = Staging::new("off-thread");
    let payload: Vec<u8> = (0..4096usize).map(|i| (i % 251) as u8).collect();
    let bytes = build_zip(&[
        ("pack.json", b"{\"schema\":1}".as_slice()),
        ("files/a.bin", payload.as_slice()),
        ("files/deep/b.bin", payload.as_slice()),
    ]);
    write_container(&staging, "a.zip", &bytes);

    let sync = extract_staging(staging.dir(), "a.zip", "sync-out", &LIMITS).unwrap();
    let off = tauri::async_runtime::block_on(extract_staging_off_thread(
        staging.dir().to_path_buf(),
        "a.zip".to_string(),
        "off-out".to_string(),
        LIMITS,
    ))
    .expect("off-thread 形态必须与同步形态同样成功");

    let pair = |r: &crate::market::MarketExtractResultDto| -> Vec<(String, u64)> {
        r.entries
            .iter()
            .map(|e| (e.path.clone(), e.bytes))
            .collect()
    };
    assert_eq!(pair(&sync), pair(&off), "条目表逐字段不一致：异步换了语义");
    assert_eq!(sync.total_bytes, off.total_bytes, "总字节不一致");
    assert_eq!(off.entries.len(), 3);
    for dir in ["sync-out", "off-out"] {
        assert_eq!(std::fs::read(staging.dir().join(dir).join("files/a.bin")).unwrap(), payload);
        assert_eq!(
            std::fs::read(staging.dir().join(dir).join("files/deep/b.bin")).unwrap(),
            payload,
            "{dir}：深路径的父目录没建出来"
        );
    }

    // 容器名字面闸：拒在动盘之前，且拒因前缀逐字照旧（`market_extract:`）
    let err = tauri::async_runtime::block_on(extract_staging_off_thread(
        staging.dir().to_path_buf(),
        "../evil.zip".to_string(),
        "evil-out".to_string(),
        LIMITS,
    ))
    .expect_err("非法容器名必须拒");
    assert!(err.starts_with("market_extract:"), "拒因前缀变了：{err}");
    assert!(!staging.dir().join("evil-out").exists(), "被拒的调用留下了目标目录");
}

#[test]
fn entry_type_gate_covers_every_unix_file_type() {
    // 普通文件放行；DOS 容器（无 unix 位）由路径闸兜住，这里必须放行
    assert_eq!(entry_type_problem(false, Some(0o100_644)), None);
    assert_eq!(entry_type_problem(false, None), None);
    assert_eq!(entry_type_problem(true, None), Some("entry-symlink"));
    assert_eq!(entry_type_problem(true, Some(0o120_777)), Some("entry-symlink"));
    for weird in [
        0o040_755, // S_IFDIR：目录（add_directory 造的尾斜杠条目另有路径闸拦）
        0o001_644, // S_IFIFO：读它会挂住解压线程
        0o014_644, // S_IFSOCK
        0o002_644, // S_IFCHR：Windows 上是绝对路径设备名
        0o006_644, // S_IFBLK
        0o170_777, // 类型位全置：不属于任何合法普通文件
    ] {
        assert_eq!(
            entry_type_problem(false, Some(weird)),
            Some("entry-not-regular-file"),
            "{weird:#o} 这类条目类型被放行"
        );
    }
}

/* ------------------------------ 解压安全闸 ------------------------------ */

#[test]
fn extract_rejects_dotdot_entry_and_writes_nothing() {
    let staging = Staging::new("dotdot");
    let bytes = build_zip(&[
        ("pack.json", b"{\"schema\":1}".as_slice()),
        ("files/a.txt", b"hello".as_slice()),
        ("../escape.txt", b"escape".as_slice()),
    ]);
    write_container(&staging, "a.zip", &bytes);
    let err = extract_staging(staging.dir(), "a.zip", "out", &LIMITS).unwrap_err();
    assert!(err.contains("path-dotdot"), "错误串缺拒绝码：{err}");
    assert!(!staging.dir().join("out").exists(), "越界容器留下了目标目录");
    assert!(!staging.dir().join("escape.txt").exists(), "写到了暂存目录之外");
    assert_only_container(&staging, "a.zip");
}

/// 拒绝码字面与顺序抄自契约 `plugin-api/src/market.ts:258-267`（`packEntryPathProblem`）：
/// 两层必须逐字对得上，所以这里按码断言而不是只断言"报错了"。
#[test]
fn extract_rejects_absolute_and_backslash_and_drive_entries() {
    for (case, name, code) in [
        ("abs", "/etc/passwd", "path-absolute"),
        ("backslash", "files\\a.txt", "path-backslash"),
        ("unc", "\\\\server\\a.txt", "path-backslash"),
        ("drive", "C:/windows/a.txt", "path-drive"),
        ("drive-relative", "C:files/a.txt", "path-drive"),
        ("empty-segment", "files//a.txt", "path-empty-segment"),
        ("self", "files/./a.txt", "path-empty-segment"),
        ("dir-entry", "files/sub/", "path-empty-segment"),
    ] {
        let staging = Staging::new(case);
        write_container(&staging, "a.zip", &build_zip(&[(name, b"x".as_slice())]));
        let err = extract_staging(staging.dir(), "a.zip", "out", &LIMITS).unwrap_err();
        assert!(
            err.starts_with(&format!("{code}：")) && err.contains(&format!("{name:?}")),
            "{case} 的拒绝码或名字不可诊断：{err}"
        );
        assert!(!staging.dir().join("out").exists(), "{case} 留下了目标目录");
    }
}

#[test]
fn extract_rejects_symlink_entry() {
    let staging = Staging::new("symlink");
    write_container(
        &staging,
        "a.zip",
        &zip_with_symlink("files/link", "../escape.txt"),
    );
    let err = extract_staging(staging.dir(), "a.zip", "out", &LIMITS).unwrap_err();
    assert!(err.contains("entry-symlink"), "符号链接没被拒：{err}");
    assert!(!staging.dir().join("out").exists());
    assert!(!staging.dir().join("escape.txt").exists());
}

/// 回归（seen 集合大小写敏感去重）：`files/A.erb` 与 `files/a.erb` 在 Windows 的
/// 大小写不敏感文件系统上是**同一个文件**——按字节比较会放行两条，落盘互覆，
/// 清单还虚报条目数。去重键与写允许域同款 `to_lowercase` 折叠后，容器在写第一个
/// 字节之前按 entry-duplicate 拒绝（清单恒与盘面一致：报几条就是真落了几条）。
#[test]
fn extract_rejects_case_colliding_duplicate_entries() {
    let staging = Staging::new("case-dup");
    write_container(
        &staging,
        "a.zip",
        &build_zip(&[
            ("files/A.erb", b"from upper".as_slice()),
            ("files/a.erb", b"from lower".as_slice()),
        ]),
    );
    let err = extract_staging(staging.dir(), "a.zip", "out", &LIMITS).unwrap_err();
    assert!(err.contains("entry-duplicate"), "大小写重名条目没被拒：{err}");
    assert!(err.contains("files/"), "错误应带原始条目名：{err}");
    assert!(!staging.dir().join("out").exists(), "大小写重名容器留下了目标目录");
}

// 注：没有"精确同名重复仍拒绝"的用例——zip crate（≥1.3）的 ZipWriter 自身拒绝写
// 精确同名条目（InvalidArchive("Duplicate filename")），同款夹具物理上造不出；
// 且折叠键下它与上面的 case-colliding 用例走生产代码**同一个分支**（同一折叠键的
// 第二次 seen.insert → entry-duplicate），删去不丢覆盖。勿盲补。
#[test]
fn extract_enforces_entry_count_and_depth_limits() {
    let staging = Staging::new("counts");
    write_container(
        &staging,
        "a.zip",
        &build_zip(&[("pack.json", b"{}".as_slice()), ("files/a.txt", b"a".as_slice())]),
    );
    let limits = StagingLimits {
        max_entries: 1,
        ..LIMITS
    };
    let err = extract_staging(staging.dir(), "a.zip", "out", &limits).unwrap_err();
    assert!(err.contains("entries-limit"), "条目数上限没生效：{err}");

    let deep = Staging::new("depth");
    write_container(
        &deep,
        "a.zip",
        &build_zip(&[("files/a/b/c/d.txt", b"x".as_slice())]),
    );
    let too_deep = StagingLimits {
        max_depth: 4,
        ..LIMITS
    };
    let err = extract_staging(deep.dir(), "a.zip", "out", &too_deep).unwrap_err();
    assert!(err.contains("path-depth"), "深度上限没生效：{err}");
    assert!(extract_staging(deep.dir(), "a.zip", "ok", &LIMITS).is_ok());
}

#[test]
fn extract_enforces_unpacked_bytes_and_removes_partial_output() {
    let payload: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let staging = Staging::new("bytes");
    write_container(
        &staging,
        "a.zip",
        &build_zip(&[
            ("files/a.bin", payload.as_slice()),
            ("files/b.bin", payload.as_slice()),
        ]),
    );
    // 中央目录声明的总字节就超限 ⇒ 第一遍（一个字节都还没写）就拒
    let small = StagingLimits {
        max_unpacked_bytes: 100_000,
        ..LIMITS
    };
    let err = extract_staging(staging.dir(), "a.zip", "out", &small).unwrap_err();
    assert!(err.contains("bytes-limit"), "声明总字节上限没生效：{err}");
    assert!(!staging.dir().join("out").exists());

    // 卡在两条目之间的上限：第一条目已落盘，第二条目触发"边解边核真字节"闸
    // ⇒ 已解出的内容必须整包删掉。
    let live = Staging::new("bytes-live");
    write_container(
        &live,
        "one.zip",
        &build_zip(&[("files/a.bin", payload.as_slice())]),
    );
    write_container(
        &live,
        "two.zip",
        &build_zip(&[
            ("files/a.bin", payload.as_slice()),
            ("files/b.bin", payload.as_slice()),
        ]),
    );
    let cap_one = StagingLimits {
        max_unpacked_bytes: 200_000,
        ..LIMITS
    };
    assert!(extract_staging(live.dir(), "one.zip", "ok", &cap_one).is_ok());
    let err = extract_staging(live.dir(), "two.zip", "bad", &cap_one).unwrap_err();
    assert!(err.contains("bytes-limit"), "真字节上限没生效：{err}");
    assert!(
        !live.dir().join("bad").exists(),
        "超限后仍留着半截解压内容"
    );
    assert!(live.dir().join("ok").join("files").join("a.bin").is_file());
}

#[test]
fn extract_rejects_missing_container_and_bad_target_name() {
    let staging = Staging::new("missing");
    let err = extract_staging(staging.dir(), "absent.zip", "out", &LIMITS).unwrap_err();
    assert!(err.contains("打开容器失败"), "错误不可诊断：{err}");
    let err = extract_staging(staging.dir(), "a.zip", "../out", &LIMITS).unwrap_err();
    assert!(err.contains("名字只允许"), "越界目标名被放行：{err}");
}

/* ------------------------- 跨实现对平（真实容器） ------------------------- */

/// 期望值逐字抄自注册表仓 `packs/**/pack.json` 的 `files[]` 声明
/// （根 `pack.json` 由本层一并解出，字节数单独核对）。
/// `container_bytes` = 线上 release 资产的字节数（哈希归 TS，本层只核字节）。
struct Fixture {
    container: &'static str,
    version: &'static str,
    container_bytes: u64,
    manifest_bytes: u64,
    entries: &'static [(&'static str, u64)],
}

const FIXTURES: &[Fixture] = &[
    Fixture {
        container: "demo.era-tw-1.0.1.zip",
        version: "1.0.1",
        container_bytes: 1051,
        manifest_bytes: 625,
        entries: &[("files/M_KOJO_K900_DEMO.ERB", 471)], // audit-allow: 注册表真实资产文件名字面量，逐条目对平判据
    },
    Fixture {
        container: "demo.era-tw-1.0.0.zip",
        version: "1.0.0",
        container_bytes: 1004,
        manifest_bytes: 625,
        entries: &[("files/M_KOJO_K900_DEMO.ERB", 368)], // audit-allow: 注册表真实资产文件名字面量，逐条目对平判据
    },
    Fixture {
        container: "demo.dict-1.0.0.zip",
        version: "1.0.0",
        container_bytes: 709,
        manifest_bytes: 611,
        entries: &[("files/names.csv", 77)],
    },
];

fn fixture_bytes(container: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(container);
    std::fs::read(&path).unwrap_or_else(|e| panic!("读 fixture 失败 {}: {e}", path.display()))
}

fn sorted_entries(entries: &[(String, u64)]) -> Vec<(String, u64)> {
    let mut v = entries.to_vec();
    v.sort();
    v
}

/// 容器已在 `staging` 里（离线写死的 fixture 或刚下载回来的）⇒ 解出并与该包 `pack.json`
/// 的声明逐条目对平。**离线与网络两条链路共用这一份判据**，不存在两套口径。
fn reconcile(staging: &Staging, fixture: &Fixture) {
    let container = fixture.container;
    let declared = fixture.entries;
    let manifest_bytes = fixture.manifest_bytes;

    // 容器字节数钉在线上资产的值上（哈希归 TS 的 digest.ts，本层只核字节）。
    let on_disk_container = staging.dir().join(container);
    assert_eq!(
        std::fs::metadata(&on_disk_container)
            .unwrap_or_else(|e| panic!("容器不在位 {}: {e}", on_disk_container.display()))
            .len(),
        fixture.container_bytes,
        "{container} 容器字节与线上资产钉数不平"
    );

    let result = extract_staging(staging.dir(), container, "out", &LIMITS)
        .unwrap_or_else(|e| panic!("{container} 解不开：{e}"));

    let got = sorted_entries(
        &result
            .entries
            .iter()
            .map(|e| (e.path.clone(), e.bytes))
            .collect::<Vec<_>>(),
    );
    let want = sorted_entries(
        &declared
            .iter()
            .map(|(p, b)| (p.to_string(), *b))
            .chain(std::iter::once(("pack.json".to_string(), manifest_bytes)))
            .collect::<Vec<_>>(),
    );
    assert_eq!(got, want, "{container} 的逐条目 path+bytes 与声明对不平");
    assert_eq!(
        result.total_bytes,
        want.iter().map(|(_, b)| b).sum::<u64>(),
        "{container} 总字节对平失败"
    );

    // 根 pack.json 必须在位、声明条目必须恒在 files/ 下，且落盘文件字节与声明一致。
    let manifest_raw = std::fs::read(staging.dir().join("out").join("pack.json"))
        .expect("根 pack.json 没解出来");
    assert_eq!(
        manifest_raw.len(),
        manifest_bytes as usize,
        "{container} pack.json 字节不平"
    );
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_raw).unwrap();
    let items = manifest["files"].as_array().unwrap();
    assert_eq!(items.len(), declared.len(), "{container} 清单条目数不平");
    for item in items {
        let path = item["path"].as_str().unwrap();
        let item_bytes = item["bytes"].as_u64().unwrap();
        assert!(path.starts_with("files/"), "清单条目不在 files/ 下：{path}");
        let found = result
            .entries
            .iter()
            .find(|e| e.path == path)
            .unwrap_or_else(|| panic!("清单条目 {path:?} 不在解压结果里"));
        assert_eq!(found.bytes, item_bytes, "{container}::{path} 字节不平");
        let on_disk = staging.dir().join("out").join(path);
        assert_eq!(
            std::fs::metadata(&on_disk)
                .unwrap_or_else(|e| panic!("{path} 落盘失败: {e}"))
                .len(),
            item_bytes,
            "{container}::{path} 落盘字节与声明不平"
        );
    }
}

#[test]
fn extract_real_registry_containers_entry_by_entry() {
    for fixture in FIXTURES {
        let staging = Staging::new(fixture.container);
        write_container(&staging, fixture.container, &fixture_bytes(fixture.container));
        reconcile(&staging, fixture);
    }
}

/* ----------------------- 网络版对平（默认不跑） ----------------------- */

/// 真实链路：下载（含 302 逐跳重核）→ 落盘 → 解压 → 与同一份声明对平（三资产全跑）。
/// 本机 `github.com:443` 直连必 connect timeout，须经代理；跑法（Git-Bash，代理经 node 传环境变量）：
/// `node -e "process.env.KOJO_MARKET_TEST_PROXY='http://127.0.0.1:7890';require('child_process')
///  .execSync('cargo test --lib market_tests::download_and_extract_real_release_assets -- --ignored --nocapture',{cwd:'packages/app/src-tauri',stdio:'inherit'})"`
#[test]
#[ignore = "需要网络与本机代理：离线 CI 阶段不跑"]
fn download_and_extract_real_release_assets() {
    let proxy = std::env::var("KOJO_MARKET_TEST_PROXY")
        .unwrap_or_else(|_| "http://127.0.0.1:7890".to_string());
    for fixture in FIXTURES {
        // 线上资产形态：`<id>-v<ver>/<id>-<ver>.zip`（id = 容器名去掉 `-<ver>.zip`）
        let id = fixture
            .container
            .trim_end_matches(&format!("-{}.zip", fixture.version))
            .to_string();
        assert!(!id.is_empty(), "容器名不符 `<id>-<ver>.zip` 形态：{}", fixture.container);
        let target = format!(
            "https://github.com/Poboking/kojo-market/releases/download/{id}-v{}/{container}",
            fixture.version,
            container = fixture.container
        );
        let staging = Staging::new(&format!("net-{}", fixture.container));
        let opts = DownloadOptions {
            timeout_ms: 60_000,
            max_bytes: 8 * 1024 * 1024,
            proxy: Some(proxy.clone()),
        };
        let downloaded =
            tauri::async_runtime::block_on(download_to_staging(
                staging.dir(),
                &target,
                fixture.container,
                &opts,
            ))
            .unwrap_or_else(|e| panic!("真实下载失败 {target}: {e}"));
        assert_eq!(downloaded.status, 200, "{target} 状态非 200");
        assert_eq!(
            downloaded.bytes, fixture.container_bytes,
            "{target} 下载字节与钉数不平"
        );
        assert_eq!(
            downloaded.bytes,
            std::fs::metadata(staging.dir().join(fixture.container)).unwrap().len(),
            "回报字节与落盘文件不一致"
        );
        assert!(
            downloaded
                .final_url
                .starts_with("https://release-assets.githubusercontent.com/"),
            "重定向落点不符合实测形态：{}",
            downloaded.final_url
        );
        // 下载落盘的容器走**同一份**对平判据
        reconcile(&staging, fixture);
    }
}

/// 生产路径的代理口径：`market_download` 固定 `proxy: None` ⇒ 代理只能由**进程环境**生效
/// （reqwest 的 `system-proxy`，实测已编进依赖图）。这条用例量的就是这个假设本身：
/// 显式传 proxy 的链路（上一条）过得去、env 过不去 ⇒ 命令侧删 proxy 参数就是把用户锁在墙外。
/// 跑法：`HTTPS_PROXY=http://127.0.0.1:7890 cargo test --lib market_tests::download_through_env_proxy -- --ignored`
#[test]
#[ignore = "需要网络与进程环境代理：离线 CI 阶段不跑"]
fn download_through_env_proxy_uses_system_proxy() {
    let fixture = &FIXTURES[2]; // demo.dict：最小的一个，够核这条链路
    // env 由本用例自己钉：证明的是"命令不传 proxy 时代理仍生效"，不是"碰巧有人设过"
    std::env::set_var(
        "HTTPS_PROXY",
        std::env::var("KOJO_MARKET_TEST_PROXY").unwrap_or_else(|_| "http://127.0.0.1:7890".to_string()),
    );
    let target = format!(
        "https://github.com/Poboking/kojo-market/releases/download/demo.dict-v{}/{container}",
        fixture.version,
        container = fixture.container
    );
    let staging = Staging::new("env-proxy");
    let opts = DownloadOptions {
        timeout_ms: 60_000,
        max_bytes: 8 * 1024 * 1024,
        proxy: None,
    };
    let downloaded = tauri::async_runtime::block_on(download_to_staging(
        staging.dir(),
        &target,
        fixture.container,
        &opts,
    ))
    .unwrap_or_else(|e| panic!("proxy: None 且 env 有 HTTPS_PROXY 时下载失败：{e}"));
    assert_eq!(downloaded.bytes, fixture.container_bytes, "{target} 字节不平");
    reconcile(&staging, fixture);
}
