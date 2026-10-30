//! 市场 IO 原语的判据。五组：URL 白名单（含逐跳重定向）、暂存名字面、解压安全闸、
//! 与注册表真实容器的跨实现对平，以及 **W14 往返对拍的 Rust 半边**（`zip_roundtrip_*` 那六条：
//! 与 TS 侧 `packages/plugin-api/tests/zip-roundtrip.test.ts` 读**同一张共享表**
//! `plugin-api/fixtures/zip-roundtrip/contract.json` 与**同一只夹具** `container.zip`，
//! 命名闸/限额闸逐项、逐条目名逐码、正常往返逐字节、篡改逐码）。
//!
//! 对平用的容器字节**逐字取自线上注册表资产**（`tests/fixtures/*.zip`；注册表侧是
//! `node:zlib` 自写容器，不是 `zip` 命令产物），所以这条链路在开发机离线可复跑。
//! 网络版对平有两条，都 `#[ignore]`（github 直连必 timeout，须经代理）：
//! `download_and_extract_real_release_assets`（显式代理，三资产）与
//! `download_through_env_proxy_uses_system_proxy`（命令侧 `proxy: None` 的生产口径）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

// 容器守卫（ZIP / 解包 / 往返契约）住在 `archive_guard.rs`，**直引那一份**——
// `market.rs` 的旧转发层已撤（启动器改直调后只剩测试在用转发名，留着就是非测试构建里的
// 一堆悬空导入）；守卫只有一份实现，不留第二条名字路径。
use crate::archive_guard::{
    advance_byte_cap, cap_staging_limits, central_directory, container_name_problem,
    declared_entries_problem, declared_entry_count, entry_contract_problem, entry_type_problem,
    extract_staging, extract_staging_off_thread, staging_component_problem, zip_roundtrip_contract,
    DeclaredEntries, StagingLimits, ZIP_FLAG_UTF8, ZIP_ROUNDTRIP_CONTRACT_JSON,
};
use crate::market::{
    cap_download_limits, cap_fetch_limits, content_length_problem, download_to_staging, fetch_text,
    host_in_allowlist, market_fetch_text, redirect_problem, url_problem, utf8_text, DownloadOptions,
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

/* -------------------- 造容器（F7 预检：EOCD 声明值） -------------------- */

/// 一个合法容器的尾注必是 EOCD32（22 字节、无注释）——两个夹具构造器都靠这条前提改写字段。
const EOCD_TAIL: usize = 22;

fn assert_eocd_tail(zip: &[u8]) {
    assert!(zip.len() >= EOCD_TAIL, "夹具太短，容不下 22 字节 EOCD32");
    assert_eq!(
        &zip[zip.len() - EOCD_TAIL..][..4],
        b"PK\x05\x06".as_slice(),
        "夹具尾注必须是 EOCD32（本测试只改写它的条目数字段）"
    );
}

/// 只把 EOCD32 的两个条目数字段（u16@8 / u16@10）改成 `count`，其余字节逐字不动。
/// ⇒ 真条目数还是夹具那几条，但**声明值**说了算的是解析成本（zip crate 就按它迭代）。
fn patch_declared_count(zip: &[u8], count: u16) -> Vec<u8> {
    assert_eocd_tail(zip);
    assert_ne!(count, 0xFFFF, "写满哨兵会走 zip64 分支，用 zip64_claimed() 造");
    let mut out = zip.to_vec();
    let base = out.len() - EOCD_TAIL;
    out[base + 8..base + 10].copy_from_slice(&count.to_le_bytes());
    out[base + 10..base + 12].copy_from_slice(&count.to_le_bytes());
    out
}

/// 把尾注换成"zip64 声明 `claimed` 个条目"的形态：原 zip64 记录 + locator + EOCD32
/// （条目数字段写满哨兵）。中央目录与条目字节一概不动 ⇒ 量到的正是**预检读的那段头**。
fn zip64_claimed(zip: &[u8], claimed: u64) -> Vec<u8> {
    assert_eocd_tail(zip);
    let mut out = zip[..zip.len() - EOCD_TAIL].to_vec();
    let record_at = out.len() as u64;
    out.extend_from_slice(b"PK\x06\x06");
    out.extend_from_slice(&44u64.to_le_bytes()); // record_size = 头 12 字节之后还剩 44
    out.extend_from_slice(&[0u8; 4]); // version made by / version needed
    out.extend_from_slice(&0u32.to_le_bytes()); // disk number
    out.extend_from_slice(&0u32.to_le_bytes()); // disk with central directory
    out.extend_from_slice(&claimed.to_le_bytes()); // 本盘条目数
    out.extend_from_slice(&claimed.to_le_bytes()); // 全目录条目数
    out.extend_from_slice(&0u64.to_le_bytes()); // CD size（预检不读）
    out.extend_from_slice(&0u64.to_le_bytes()); // CD offset（预检不读）
    out.extend_from_slice(b"PK\x06\x07");
    out.extend_from_slice(&0u32.to_le_bytes()); // disk with CD
    out.extend_from_slice(&record_at.to_le_bytes()); // zip64 EOCD 记录的绝对偏移
    out.extend_from_slice(&1u32.to_le_bytes()); // 总盘数
    out.extend_from_slice(b"PK\x05\x06");
    out.extend_from_slice(&[0u8; 4]); // disk number / disk with CD
    out.extend_from_slice(&0xFFFFu16.to_le_bytes());
    out.extend_from_slice(&0xFFFFu16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // CD size（预检不读）
    out.extend_from_slice(&0u32.to_le_bytes()); // CD offset（预检不读）
    out.extend_from_slice(&0u16.to_le_bytes()); // 注释长度 = 0
    out
}

fn open_in(staging: &Staging, name: &str) -> std::fs::File {
    std::fs::File::open(staging.dir().join(name)).unwrap()
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
            None,
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
        None,
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

/* ---------------------- 编译期硬顶（JS 不可放宽） ---------------------- */

/// 取文本硬顶：全程驻内存，是最直接的 OOM 面 ⇒ 调用方给的 `maxBytes` 只会往下夹到 1 MiB。
#[test]
fn fetch_limits_are_capped_at_compile_time_ceiling() {
    // 恶意/失控入参（u64::MAX）被夹到硬顶；合法小值原样保留（只降不升）
    let (_t, mb) = cap_fetch_limits(60_000, u64::MAX);
    assert_eq!(mb, 1024 * 1024, "取文本体积没夹进 1 MiB 硬顶");
    assert_eq!(cap_fetch_limits(60_000, 1_600).1, 1_600, "合法小限额被误压");
    // 超时同样夹顶（u64::MAX → 15 分钟）
    let (t, _) = cap_fetch_limits(u64::MAX, 1024);
    assert_eq!(t, 15 * 60_000, "超时没夹进 15 分钟硬顶");
}

/// 下载硬顶：落盘不进内存，但仍受磁盘/暂存配额顶（512 MiB）。
#[test]
fn download_limits_are_capped_at_compile_time_ceiling() {
    let (_t, mb) = cap_download_limits(60_000, u64::MAX);
    assert_eq!(mb, 512 * 1024 * 1024, "下载体积没夹进 512 MiB 硬顶");
    assert_eq!(cap_download_limits(60_000, 8 * 1024 * 1024).1, 8 * 1024 * 1024);
}

/// 解压三限额逐一夹顶：炸弹闸（条目/深度/解压总字节）不许被调用方解除。
#[test]
fn staging_limits_are_capped_at_compile_time_ceilings() {
    let huge = StagingLimits {
        max_entries: usize::MAX,
        max_depth: usize::MAX,
        max_unpacked_bytes: u64::MAX,
    };
    let capped = cap_staging_limits(huge);
    assert_eq!(capped.max_entries, 200_000, "条目数没夹进硬顶");
    assert_eq!(capped.max_depth, 64, "深度没夹进硬顶");
    assert_eq!(capped.max_unpacked_bytes, 512 * 1024 * 1024, "解压字节没夹进硬顶");
    // 合法小值原样保留
    let small = cap_staging_limits(LIMITS);
    assert_eq!(small.max_entries, LIMITS.max_entries);
    assert_eq!(small.max_unpacked_bytes, LIMITS.max_unpacked_bytes);
}

/* ---------------------- 条目名 Windows 不安全面（审阅批） ---------------------- */

/// ADS 冒号与尾随 `.` / 空格：`files/a:stream` 是备用数据流注入（两个不同条目名、路径闸
/// 与 entry-duplicate 都拦不住）；尾随点/空格会被文件系统静默改名 ⇒ 清单与落盘不平。
/// 一律在写第一个字节之前拒。
#[test]
fn extract_rejects_ads_colon_and_trailing_dot_or_space() {
    for (case, name, code) in [
        ("ads", "files/a:stream.txt", "path-drive"),
        ("ads-mid", "pack:json", "path-drive"),
        ("trailing-dot", "files/a.txt.", "path-windows-unsafe"),
        ("trailing-space", "files/a.txt ", "path-windows-unsafe"),
        ("trailing-dot-seg", "files/sub./a.txt", "path-windows-unsafe"),
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
    // 反向：无冒号、无尾随点/空格的正常条目照常放行（不误伤既有容器）
    let ok = Staging::new("unsafe-ok");
    write_container(
        &ok,
        "a.zip",
        &build_zip(&[("files/a.txt", b"x".as_slice()), ("pack.json", b"{}".as_slice())]),
    );
    assert!(extract_staging(ok.dir(), "a.zip", "out", &LIMITS).is_ok());
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

    let pair = |r: &crate::archive_guard::MarketExtractResultDto| -> Vec<(String, u64)> {
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

/* ------------------- F7：解析中央目录之前的条目数预检 ------------------- */

/// 预检读的是** EOCD 头的声明值 **，不是"解析出来的条目数"——三态各钉一条：
/// 真容器的声明值、被改大的声明值（zip32）、尾部形态不认识 ⇒ `Unknown`。
/// 纯函数闸再钉边界（`== ceiling` 放行、`+1` 拒、`Unknown` 永不拒）。
#[test]
fn precheck_reads_declared_count_from_eocd_header_only() {
    let staging = Staging::new("f7-read");
    let honest = build_zip(&[
        ("pack.json", b"{}".as_slice()),
        ("files/a.txt", b"x".as_slice()),
        ("files/b.txt", b"y".as_slice()),
    ]);
    write_container(&staging, "honest.zip", &honest);
    assert_eq!(declared_entry_count(&mut open_in(&staging, "honest.zip")), DeclaredEntries::Count(3));

    // zip32 字段被改大（真条目仍是 3 条）：预检量的正是"解析要花多少"，声明值说了算
    write_container(&staging, "lying.zip", &patch_declared_count(&honest, 60_000));
    assert_eq!(declared_entry_count(&mut open_in(&staging, "lying.zip")), DeclaredEntries::Count(60_000));

    // zip64 分支：哨兵写满 ⇒ 真值从 locator 指向的 zip64 记录读（可超过 u16 的 65535）
    write_container(&staging, "zip64.zip", &zip64_claimed(&honest, 200_001));
    assert_eq!(
        declared_entry_count(&mut open_in(&staging, "zip64.zip")),
        DeclaredEntries::Count(200_001)
    );

    // 形态不认识（连 EOCD 都没有）⇒ Unknown：预检**绝不**据此拒绝，判定权交回 zip crate
    write_container(&staging, "not-a-zip.bin", b"not a zip: no EOCD anywhere");
    assert_eq!(declared_entry_count(&mut open_in(&staging, "not-a-zip.bin")), DeclaredEntries::Unknown);

    // 上界口径（Rust 侧硬顶常量 = 200_000，测试里显式传等价的小数钉边界）
    assert_eq!(declared_entries_problem(DeclaredEntries::Count(5), 5), None);
    assert_eq!(declared_entries_problem(DeclaredEntries::Count(0), 0), None);
    let err = declared_entries_problem(DeclaredEntries::Count(6), 5).expect("超一条就该拒");
    assert!(err.starts_with("entries-limit："), "拒绝码字面必须与 extract_into 的同一条：{err}");
    assert_eq!(declared_entries_problem(DeclaredEntries::Unknown, 0), None);
}

/// **端到端**：失控声明的容器在"解析中央目录 / 写第一个字节"之前就被拒，
/// 且暂存区不留残壳。上界 = 硬顶与调用方限额的较小者（只降不升，同 `cap_staging_limits`），
/// 所以两条各自都能单独触发提前拒。
#[test]
fn extract_rejects_over_ceiling_declaration_before_any_parsing() {
    // ① zip64 声明 200_001 > 硬顶 200_000：即便调用方把限额放到硬顶也照样提前拒
    let staging = Staging::new("f7-e2e-ceiling");
    write_container(
        &staging,
        "a.zip",
        &zip64_claimed(&build_zip(&[("pack.json", b"{}".as_slice())]), 200_001),
    );
    let at_ceiling = StagingLimits {
        max_entries: 200_000,
        ..LIMITS
    };
    let err = extract_staging(staging.dir(), "a.zip", "out", &at_ceiling).unwrap_err();
    assert!(err.starts_with("market_extract: entries-limit："), "拒因前缀/码不符：{err}");
    assert!(err.contains("未解析条目"), "这是解析后那条闸的口径，预检没生效：{err}");
    assert!(err.contains("200001"), "拒因没给出声明值：{err}");
    assert!(!staging.dir().join("out").exists(), "预检留下了目标目录");
    assert_only_container(&staging, "a.zip");

    // ② 合法容器 + 调用方限额 1：预检直接给出与 `archive.len()` 闸同一条结论（更早、更省）
    let small = Staging::new("f7-e2e-caller");
    write_container(
        &small,
        "a.zip",
        &build_zip(&[("pack.json", b"{}".as_slice()), ("files/a.txt", b"x".as_slice())]),
    );
    let err = extract_staging(
        small.dir(),
        "a.zip",
        "out",
        &StagingLimits {
            max_entries: 1,
            ..LIMITS
        },
    )
    .unwrap_err();
    assert!(err.contains("entries-limit"), "条目数上限没生效：{err}");
    assert!(err.contains("未解析条目"), "该由预检提前拒：{err}");
    assert_only_container(&small, "a.zip");
}

/// 零行为回归：预检**只多不少**——声明值在上界内、形态不认识的容器一律放行到原有链路，
/// 判词仍由 `ZipArchive::new` 给（错误字面没被预检劫持）。
#[test]
fn precheck_never_hijacks_archives_it_cannot_read() {
    let staging = Staging::new("f7-fallthrough");
    write_container(&staging, "a.zip", b"plain bytes without any EOCD signature");
    let err = extract_staging(staging.dir(), "a.zip", "out", &LIMITS).unwrap_err();
    assert!(err.contains("容器不可读"), "该由 zip crate 自己拒，错误字面却变了：{err}");
    assert!(!err.contains("entries-limit"), "Unknown 被误当成超限");
    assert_only_container(&staging, "a.zip");
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
                None,
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
        None,
    ))
    .unwrap_or_else(|e| panic!("proxy: None 且 env 有 HTTPS_PROXY 时下载失败：{e}"));
    assert_eq!(downloaded.bytes, fixture.container_bytes, "{target} 字节不平");
    reconcile(&staging, fixture);
}

/* ---------------------------- 进度节流（纯判定） ---------------------------- */

/// 节流判据全部钉常量语义：新增 ≥64 KiB / 时隔 ≥100 ms / 首块直发 / 零新增不发。
/// 不含真实时钟读数 ⇒ 全确定性，离线可跑。
#[test]
fn progress_due_throttles_by_bytes_or_interval() {
    use crate::market::progress_due;
    use std::time::Duration;
    let zero = Duration::ZERO;
    // 首块直发：UI 不该在 0% 停到半程（received>0 由调用方闭包保证，这里只钉"None ⇒ 发"）
    assert!(progress_due(1, None), "首块必须直发");
    assert!(progress_due(0, None), "None（没发过）就是发，与新增量无关");
    // 字节段：满 64 KiB 立即发，差一字节且时间未到不发
    assert!(progress_due(64 * 1024, Some(zero)), "满 64 KiB 该发");
    assert!(!progress_due(64 * 1024 - 1, Some(zero)), "差一字节且时间未到不该发");
    // 时间段：涓流（新增>0 但 <64 KiB）满了 100 ms 也要发，否则 UI 长时间停在旧读数
    assert!(progress_due(1, Some(Duration::from_millis(100))), "100 ms 到点且新增>0 该发");
    assert!(!progress_due(1, Some(Duration::from_millis(99))), "时间未到且新增不足不该发");
    // 零新增永远不发（收尾补发的重复调用被压掉）
    assert!(!progress_due(0, Some(Duration::from_secs(10))), "零新增不该发");
}

/* ================= W14 往返对拍 · Rust 半边（同一张表、同一只容器） ================= */

/* ---------------- 共享 fixture ---------------- */

/// 共享表体 = 内嵌给生产路径用的**同一份字节**（`market.rs` 的 `include_str!`）。
/// TS 半边 `packages/plugin-api/tests/zip-roundtrip.test.ts` 读的是磁盘上那个 JSON 文件；
/// 这里读的是编译期内嵌的那一份 ⇒ "表漂一字节"要么两侧同时红，要么本层解析当场失败。
fn contract_table() -> &'static serde_json::Value {
    use std::sync::OnceLock;
    static TABLE: OnceLock<serde_json::Value> = OnceLock::new();
    TABLE.get_or_init(|| {
        serde_json::from_str(ZIP_ROUNDTRIP_CONTRACT_JSON).expect("共享表必须是合法 JSON")
    })
}

/// 共享容器夹具（由 TS 侧 `buildZip` 真造出来并钉进仓库的那只；两侧读同一个文件）。
/// 刻意走**文件系统**而不是 `include_bytes!`：夹具被 `KOJO_ZIP_FIXTURE_UPDATE=1` 重写后，
/// 本用例必须立刻看到新字节，而不是拿到一份编译期固化的旧副本。
fn roundtrip_container_bytes() -> Vec<u8> {
    // `CARGO_MANIFEST_DIR` 是 `packages/app/src-tauri`（`include_str!` 那个相对路径以
    // `src/` 为原点，两者差一层 ⇒ 这里少一个 `..` 就会指到仓库外面去）
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../plugin-api/fixtures/zip-roundtrip/container.zip");
    std::fs::read(&path).unwrap_or_else(|e| panic!("读往返夹具失败 {}: {e}", path.display()))
}

/// 表里的三个限额 → 本层入参形状（对拍**按表跑**，不用本文件顶上那组字面 `LIMITS`）
fn table_limits() -> StagingLimits {
    let t = contract_table();
    StagingLimits {
        max_entries: t["limits"]["maxEntries"].as_u64().unwrap() as usize,
        max_depth: t["limits"]["maxDepth"].as_u64().unwrap() as usize,
        max_unpacked_bytes: t["limits"]["maxUnpackedBytes"].as_u64().unwrap(),
    }
}

/* ---------------- 头部布局（与 TS 侧 zip-roundtrip.test.ts:88-94 同一份） ---------------- */

const LOCAL_FLAGS: usize = 6;
const LOCAL_NAME: usize = 30;
const CENTRAL_FLAGS: usize = 8;
const CENTRAL_NAME: usize = 46;
const EOCD_SIZE_AT: usize = 22;
const EOCD_TOTAL_ENTRIES: usize = 10;

fn put_u16(bytes: &mut [u8], at: usize, value: u16) {
    bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
}

fn hex_u32(s: &str) -> u32 {
    u32::from_str_radix(s.trim_start_matches("0x"), 16).unwrap_or_else(|e| panic!("表里 CRC {s:?} 不是十六进制: {e}"))
}

fn from_base64(s: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::prelude::BASE64_STANDARD
        .decode(s)
        .unwrap_or_else(|e| panic!("表里内容不是合法 base64: {e}"))
}

/// 拒绝码 = 冒号前那一段（**码是契约，冒号后面那句话各层自己写**；与 TS 侧 `codeOf` 同一口径，
/// `{:?}` 调试引号那种语言差异不进契约）。命令自报出处那一段（`market_extract: `）先摘掉——
/// 那是"哪条命令说的"，不是契约码。
fn code_of(problem: &str) -> &str {
    let body = problem
        .strip_prefix("market_extract: ")
        .unwrap_or(problem);
    let ascii = body.find(':').unwrap_or(body.len());
    let full = body.find('：').unwrap_or(body.len());
    &body[..ascii.min(full)]
}

/// 解包**必须失败**的那一类用例：`MarketExtractResultDto` 没有 Debug ⇒ `expect_err` 用不上，
/// 而"解开了"这条失败必须报得出来（解了几条、什么形状），别让它静默变成一条类型错误。
fn expect_extract_err(
    staging_dir: &Path,
    container: &str,
    target: &str,
    limits: &StagingLimits,
    tag: &str,
) -> String {
    match extract_staging(staging_dir, container, target, limits) {
        Ok(ok) => panic!(
            "{tag}: 本该被拒，却解出了 {} 条目 / {} 字节",
            ok.entries.len(),
            ok.total_bytes
        ),
        Err(e) => e,
    }
}

/// 按表做一次**长度不变**的篡改（本地头与中央目录同步改 ⇒ 夹具这才是一只"像真的"坏包，
/// 而不是一眼就能靠"头不互指"打发的畸形包）。判据与 TS 侧 `tamper` 逐字同形。
fn tamper(bytes: &[u8], case_of: &serde_json::Value) -> Vec<u8> {
    let mut out = bytes.to_vec();
    // 篡改前先用自己的中央目录原语定位（两侧同一份布局：偏移由读器给出，不靠猜）
    let container = central_directory(&mut std::io::Cursor::new(bytes.to_vec()))
        .expect("篡改前的夹具必须能被中央目录原语读出");
    let hit = |name: &str| -> crate::archive_guard::RawEntry {
        let hits: Vec<crate::archive_guard::RawEntry> = container
            .entries
            .iter()
            .filter(|e| e.name == name)
            .cloned()
            .collect();
        assert_eq!(hits.len(), 1, "篡改目标 {name:?} 命中 {} 条", hits.len());
        hits[0].clone()
    };
    if let Some(r) = case_of.get("rename") {
        let from = r["from"].as_str().expect("rename.from 必须是字符串");
        let to = r["to"].as_str().expect("rename.to 必须是字符串");
        let (from_b, to_b) = (from.as_bytes(), to.as_bytes());
        assert_eq!(from_b.len(), to_b.len(), "篡改必须保持字节长度不变：{from:?} → {to:?}");
        let entry = hit(from);
        let at_local = entry.local_offset as usize + LOCAL_NAME;
        let at_central = entry.central_offset as usize + CENTRAL_NAME;
        out[at_local..at_local + to_b.len()].copy_from_slice(to_b);
        out[at_central..at_central + to_b.len()].copy_from_slice(to_b);
    }
    if let Some(name) = case_of.get("clearUtf8FlagOf").and_then(|v| v.as_str()) {
        let entry = hit(name);
        let cleared = entry.flags & !ZIP_FLAG_UTF8;
        put_u16(&mut out, entry.central_offset as usize + CENTRAL_FLAGS, cleared);
        put_u16(&mut out, entry.local_offset as usize + LOCAL_FLAGS, cleared);
    }
    if let Some(n) = case_of
        .get("setEocdTotalEntryCount")
        .and_then(|v| v.as_u64())
    {
        let at = out.len() - EOCD_SIZE_AT + EOCD_TOTAL_ENTRIES;
        put_u16(&mut out, at, n as u16);
    }
    out
}

/* ---------------- 1. 命名闸读的就是那张表 ---------------- */

/// **命名判据只许一份**：本层生产路径用的长度上限 / 字符集字面 / 后缀 / 纯点名，
/// 逐项等于共享表的 `containerNameRule`；`containerNames` 每条**同判且拒因文案逐字**相等
/// （TS 半边比的是整句，这里比冒号前那一段）。表里改一个数而实现不改 ⇒ 这条红；
/// 实现里私藏一个数而表不改 ⇒ 同样红（因为实现读的是表，不是字面量）。
#[test]
fn zip_roundtrip_name_gates_read_the_shared_table() {
    let table = contract_table();
    let policy = zip_roundtrip_contract().expect("内嵌共享表必须能解析并通过校验");
    let rule = &table["containerNameRule"];
    assert_eq!(policy.container_name_rule.charset, rule["charset"].as_str().unwrap());
    assert_eq!(
        policy.container_name_rule.max_bytes,
        rule["maxBytes"].as_u64().unwrap() as usize
    );
    assert_eq!(policy.container_name_rule.suffix, rule["suffix"].as_str().unwrap());
    assert_eq!(
        policy.container_name_rule.reject_pure_dots,
        rule["rejectPureDots"].as_bool().unwrap()
    );
    // 限额三个数：本层入参天花板 = 表；且 = 本文件其余用例一直在传的那组字面
    // （否则"对拍过了"用的是另一套没人走的限额）
    let ceiling = &table["limits"];
    assert_eq!(policy.limits.max_entries, ceiling["maxEntries"].as_u64().unwrap() as usize);
    assert_eq!(policy.limits.max_depth, ceiling["maxDepth"].as_u64().unwrap() as usize);
    assert_eq!(
        policy.limits.max_unpacked_bytes,
        ceiling["maxUnpackedBytes"].as_u64().unwrap()
    );
    assert_eq!(LIMITS, table_limits(), "本文件顶部的 LIMITS 与共享表漂了");

    let cases = table["containerNames"].as_array().unwrap();
    assert!(cases.len() > 10, "命名用例不许跑在空表上：{}", cases.len());
    for case_of in cases {
        let name = case_of["name"].as_str().unwrap();
        let got = container_name_problem(name);
        assert_eq!(
            got.is_none(),
            case_of["ok"].as_bool().unwrap(),
            "{name:?} 的本侧判定与表漂了：{:?}",
            got
        );
        if let Some(reason) = case_of["reason"].as_str() {
            let text = got.unwrap_or_default();
            assert_eq!(code_of(&text), reason, "{name:?} 的拒因文案与表不符：{text}");
        }
    }
    // 长度上限真的来自表（把数硬编码进实现的话，这两条会跟着字面量走而不是跟着表走）
    let max = policy.container_name_rule.max_bytes;
    let suffix = policy.container_name_rule.suffix.len();
    assert!(container_name_problem(&format!("{}.zip", "a".repeat(max - suffix))).is_none());
    assert!(container_name_problem(&format!("{}.zip", "a".repeat(max - suffix + 1))).is_some());
    // 暂存名（无后缀那一段）走同一条闸：表里的字符集字面就是它实现的字节类
    assert!(staging_component_problem(&"a".repeat(max)).is_none());
    assert!(staging_component_problem(&format!("{}A", "a".repeat(max - 1))).is_some());
}

/// `entryNames` 逐条同码（**判定顺序一并钉住**：`C:\…` 报盘符不报反斜杠、
/// `files\<NUL>` 报编码不报反斜杠）。TS 半边是 `zipEntryContractProblem`，本侧是
/// `entry_contract_problem`，两侧读的都是表里同一批名字与同一个 `maxDepth`。
#[test]
fn zip_roundtrip_entry_name_cases_match_the_table_code_for_code() {
    let table = contract_table();
    let depth = table["limits"]["maxDepth"].as_u64().unwrap() as usize;
    let cases = table["entryNames"].as_array().unwrap();
    assert!(cases.len() > 15, "条目名用例不许跑在空表上：{}", cases.len());
    for case_of in cases {
        let name = case_of["name"].as_str().unwrap();
        let raw = name.as_bytes().to_vec();
        let want = case_of["code"].as_str();
        let got = entry_contract_problem(name, &raw, Some(ZIP_FLAG_UTF8), depth);
        assert_eq!(got, want, "{name:?} 的拒绝码与表不符");
    }
    // 编码那一族光看字符串判不出来的形态：原始字节非法 UTF-8（CP437 日文假名段）
    // 与"非 ASCII 却没置 bit 11"——两条都是解包侧独有的洞，写侧看不见自己写的字节。
    let sjis: Vec<u8> = vec![0x82, 0xA0, 0x82, 0xA2];
    let lossy = String::from_utf8_lossy(&sjis).into_owned();
    assert_eq!(
        entry_contract_problem(&lossy, &sjis, Some(ZIP_FLAG_UTF8), depth),
        Some("entry-name-encoding")
    );
    let cjk = "files/说明.txt".as_bytes().to_vec();
    assert_eq!(entry_contract_problem("files/说明.txt", &cjk, Some(0), depth), Some("entry-name-encoding"), "bit 11 缺失时 CP437 解码那条洞被放行");
    assert_eq!(
        entry_contract_problem("files/ascii.txt", b"files/ascii.txt".to_vec().as_slice(), Some(0), depth),
        None,
        "纯 ASCII 名字没 bit 11 是合法的（CP437 与 UTF-8 对 ASCII 同解），不许误拒"
    );
}

/* ---------------- 2. 正常往返：逐条目 + 逐字节 ---------------- */

/// TS `buildZip` 产出的那只容器，本层解包器必须**读出同一名、同一 CRC、同一大小，
/// 并逐字节还原内容**。期望值全部来自共享表（名字 / 名字字节数 / CRC / 字节数 / base64 内容），
/// 条目顺序也按表核（写侧按入参顺序落中央目录，顺序漂了说明两侧读的根本不是同一份布局）。
#[test]
fn zip_roundtrip_golden_container_restores_every_entry_byte_for_byte() {
    let table = contract_table();
    let golden = &table["golden"];
    assert_eq!(golden["contract"].as_str(), Some("extractable"), "夹具必须是契约档产物");
    let want_entries = golden["entries"].as_array().unwrap();
    let count = golden["entryCount"].as_u64().unwrap() as usize;
    assert_eq!(want_entries.len(), count);
    let bytes = roundtrip_container_bytes();

    // 第一层：中央目录原语（不经 `zip` 读器 ⇒ 条数、原始名字、bit、互指关系都是容器本身的事实）
    let container = central_directory(&mut std::io::Cursor::new(bytes.clone()))
        .expect("TS 打出来的包，本层中央目录原语必须读得动");
    assert!(!container.zip64);
    assert_eq!(container.declared_entries, count as u64);
    assert_eq!(container.entries.len(), count, "条目数不平（读器会静默去重，这里数的是真条数）");
    assert_eq!(container.total_unpacked_bytes, golden["totalUnpackedBytes"].as_u64().unwrap());
    for (i, entry) in container.entries.iter().enumerate() {
        let want = &want_entries[i];
        let name = want["name"].as_str().unwrap();
        assert_eq!(entry.name, name, "第 {i} 条名字往返不符");
        assert_eq!(entry.raw_name.len(), want["nameBytes"].as_u64().unwrap() as usize, "{name}: 原始名字字节数不符");
        assert_eq!(entry.crc32, hex_u32(want["crc"].as_str().unwrap()), "{name}: CRC 不符");
        assert_eq!(entry.uncompressed_size, want["bytes"].as_u64().unwrap() as u32, "{name}: 声明字节不符");
        assert_ne!(entry.flags & ZIP_FLAG_UTF8, 0, "{name}: 写侧没置 bit 11");
        assert!(entry.local_matches_central, "{name}: 本地头与中央目录不互指");
    }

    // 第二层：走**生产链路**解一遍（`extract_staging` 含两遍闸 + 真落盘），限额来自表
    let staging = Staging::new("roundtrip-golden");
    write_container(&staging, "container.zip", &bytes);
    let got = extract_staging(staging.dir(), "container.zip", "out", &table_limits())
        .unwrap_or_else(|e| panic!("契约档容器解不开（TS 打的包本层不认识）: {e}"));
    assert_eq!(got.entries.len(), count);
    assert_eq!(got.total_bytes, container.total_unpacked_bytes);
    for want in want_entries {
        let name = want["name"].as_str().unwrap();
        let body = from_base64(want["contentBase64"].as_str().unwrap());
        assert_eq!(body.len(), want["bytes"].as_u64().unwrap() as usize, "{name}: 表自证不平");
        let row = got
            .entries
            .iter()
            .find(|e| e.path == name)
            .unwrap_or_else(|| panic!("{name} 没被解出来：{:?}", got.entries.iter().map(|e| &e.path).collect::<Vec<_>>()));
        assert_eq!(row.bytes as usize, body.len(), "{name}: 落盘字节与表不符");
        assert_eq!(
            std::fs::read(staging.dir().join("out").join(name)).unwrap_or_else(|e| panic!("{name} 落盘失败: {e}")),
            body,
            "{name}: 内容逐字节往返不符"
        );
    }
    // 中文条目名落盘后**还叫那个名字**（bit 11 的口径一路管到 Windows 文件名）
    assert!(staging.dir().join("out").join("files/说明.txt").is_file());
}

/* ---------------- 3. 非 ASCII 条目名：两侧对 bit 11 的口径一致 ---------------- */

/// 作者工作区的真实形态（根 = 中文目录名、段里带日文与全角标点，见 eratw-adapter 的导出链）。
/// 这一条量三件事：①本层造出来的非 ASCII 容器**置了 bit 11**（与写侧同一口径）；
/// ②名字与内容逐字节回来；③把 bit 11 摘掉（`zip` 读器会按 CP437 解码名字、路径闸照样放行）
/// ⇒ 必须拒在动盘之前，且拒到 `entry-name-encoding` 那一个码上与 TS 侧一致。
#[test]
fn zip_roundtrip_cjk_names_keep_the_utf8_flag_on_both_sides() {
    let root = "东方口上-灵梦 v1.0";
    let body = "@A\n口上・メッセージ関連\n";
    let names: Vec<String> = vec![
        format!("{root}/README.md"),
        format!("{root}/ERB/口上・メッセージ関連/事件.ERB"),
        format!("{root}/CSV/Chara/Chara1 测试角色.csv"),
        "说明/データ.ERH".to_string(),
    ];
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for n in &names {
        writer.start_file(n.as_str(), deflated()).unwrap();
        std::io::Write::write_all(&mut writer, body.as_bytes()).unwrap();
    }
    let bytes = writer.finish().unwrap().into_inner();

    let container = central_directory(&mut std::io::Cursor::new(bytes.clone()))
        .expect("非 ASCII 条目名的容器必须读得动");
    assert_eq!(
        container.entries.iter().map(|e| e.name.clone()).collect::<Vec<_>>(),
        names,
        "条目名往返不符（含顺序）"
    );
    for entry in &container.entries {
        assert!(entry.raw_name.iter().any(|b| *b >= 0x80), "{}: 夹具本该是非 ASCII 名字", entry.name);
        assert_ne!(entry.flags & ZIP_FLAG_UTF8, 0, "{}: 非 ASCII 名字必须置 bit 11", entry.name);
        assert!(entry.local_matches_central, "{}: 本地头与中央目录不互指", entry.name);
    }

    let staging = Staging::new("roundtrip-cjk");
    write_container(&staging, "a.zip", &bytes);
    let got = extract_staging(staging.dir(), "a.zip", "out", &table_limits())
        .unwrap_or_else(|e| panic!("中文/日文条目名的包解不开: {e}"));
    assert_eq!(got.entries.len(), names.len());
    assert_eq!(got.total_bytes, (body.len() * names.len()) as u64);
    for n in &names {
        assert_eq!(
            std::fs::read(staging.dir().join("out").join(n)).unwrap_or_else(|e| panic!("{n} 落盘失败: {e}")),
            body.as_bytes(),
            "{n}: 内容逐字节往返不符"
        );
    }

    // 摘掉全部条目的 bit 11 ⇒ 与 TS 侧同一个码、且一个字节都不许多写
    let mut stripped = bytes.clone();
    for entry in &container.entries {
        let cleared = entry.flags & !ZIP_FLAG_UTF8;
        put_u16(&mut stripped, entry.central_offset as usize + CENTRAL_FLAGS, cleared);
        put_u16(&mut stripped, entry.local_offset as usize + LOCAL_FLAGS, cleared);
    }
    let bad = Staging::new("roundtrip-cjk-stripped");
    write_container(&bad, "a.zip", &stripped);
    let err = expect_extract_err(
        bad.dir(),
        "a.zip",
        "out",
        &table_limits(),
        "非 ASCII 名字缺 bit 11 的容器（否则落盘是 CP437 乱码名）",
    );
    assert_eq!(code_of(&err), "entry-name-encoding", "拒因不符：{err}");
    assert!(!bad.dir().join("out").exists(), "被拒的容器留下了目标目录");
    assert_only_container(&bad, "a.zip");
    // ASCII-only 条目名缺 bit 11 不受这一条管（两种解码对 ASCII 同解）
    let ascii_only = build_zip(&[("pack.json", b"{\"schema\":1}".as_slice())]);
    let good = Staging::new("roundtrip-ascii");
    write_container(&good, "a.zip", &ascii_only);
    assert!(extract_staging(good.dir(), "a.zip", "out", &table_limits()).is_ok());
}

/* ---------------- 4. 篡改负例：两侧同一个码，且拒在动盘之前 ---------------- */

/// 表里每一只篡改容器（改名 / 摘 bit 11 / ZIP64 哨兵）都必须：本层拒、**码与表逐字**、
/// 长度不变（`container-structure` 那一族除外，它靠的是畸形而不是长度）、
/// 暂存区里除了容器**一个字节都不许多出来**（zip-slip 的判据是"没越界写"，不是"报错了"）。
#[test]
fn zip_roundtrip_tampers_reject_with_the_table_code_and_write_nothing() {
    let table = contract_table();
    let limits = table_limits();
    let pinned = roundtrip_container_bytes();
    let count = table["golden"]["entryCount"].as_u64().unwrap() as usize;
    let cases = table["tampers"].as_array().unwrap();
    assert!(cases.len() >= 7, "篡改用例不许跑在空表上：{}", cases.len());
    for case_of in cases {
        let id = case_of["id"].as_str().unwrap();
        let want_code = case_of["code"].as_str().unwrap();
        let bad = tamper(&pinned, case_of);
        if case_of.get("setEocdTotalEntryCount").is_none() {
            assert_eq!(bad.len(), pinned.len(), "{id}: 篡改改了字节长度");
        }
        // 中央目录原语自己数出的条数才是真条数（`zip` 读器按名字建索引会静默去重）
        let mut cursor = std::io::Cursor::new(bad.clone());
        match central_directory(&mut cursor) {
            Ok(c) if !c.zip64 => assert_eq!(c.entries.len(), count, "{id}: 中央目录条数漂了"),
            Ok(c) => assert_eq!(c.declared_entries, 65535, "{id}: ZIP64 哨兵形态不符"),
            Err(e) => panic!("{id}: 篡改后连中央目录都读不动：{e}"),
        }
        let staging = Staging::new(&format!("roundtrip-tamper-{}", id.replace('-', "_")));
        write_container(&staging, "a.zip", &bad);
        let err = expect_extract_err(staging.dir(), "a.zip", "out", &limits, id);
        assert_eq!(code_of(&err), want_code, "{id}: 拒绝码与表不符（完整错误：{err}）");
        assert!(!staging.dir().join("out").exists(), "{id}: 拒了却留下了目标目录");
        assert!(!staging.dir().join("escape.txt").exists(), "{id}: 写到了暂存目录之外");
        assert_only_container(&staging, "a.zip");
    }
}

/* ---------------- 5. 限额闸：数字来自表，入参只许收紧 ---------------- */

/// ①表里那个条数在闸内、少一条即 `entries-limit`；②解压总字节同理 → `bytes-limit`；
/// ③**入参宽于表**（JS 想把上限调大）一律拒——三个数由表说话，不由调用方说话。
#[test]
fn zip_roundtrip_limit_gates_come_from_the_table() {
    let bytes = roundtrip_container_bytes();
    let table = contract_table();
    let count = table["golden"]["entryCount"].as_u64().unwrap() as usize;
    let total = table["golden"]["totalUnpackedBytes"].as_u64().unwrap();
    let limits = table_limits();
    let staging = Staging::new("roundtrip-limits");
    write_container(&staging, "a.zip", &bytes);

    assert!(extract_staging(staging.dir(), "a.zip", "ok", &limits).is_ok());
    for (tag, tight, want_code) in [
        ("entries", StagingLimits { max_entries: count - 1, ..limits }, "entries-limit"),
        ("bytes", StagingLimits { max_unpacked_bytes: total - 1, ..limits }, "bytes-limit"),
    ] {
        let err = expect_extract_err(staging.dir(), "a.zip", &format!("over-{tag}"), &tight, tag);
        assert_eq!(code_of(&err), want_code, "{tag}: 拒因不符：{err}");
        assert!(!staging.dir().join(format!("over-{tag}")).exists(), "{tag}: 超限仍留下了目录");
    }
    // 入参放宽那一侧：三个数各 +1 都得被天花板拦下（错误串自带两个数，可诊断）
    let loose_entries = StagingLimits { max_entries: limits.max_entries + 1, ..limits };
    let loose_depth = StagingLimits { max_depth: limits.max_depth + 1, ..limits };
    let loose_bytes = StagingLimits {
        max_unpacked_bytes: limits.max_unpacked_bytes + 1,
        ..limits
    };
    for (tag, loose, want_code) in [
        ("宽条目数", loose_entries, "entries-limit"),
        ("宽深度", loose_depth, "path-depth"),
        ("宽字节", loose_bytes, "bytes-limit"),
    ] {
        let err = expect_extract_err(staging.dir(), "a.zip", "loose", &loose, tag);
        assert_eq!(code_of(&err), want_code, "{tag}: 拒因不符：{err}");
        assert!(err.contains("平台上限"), "{tag}: 错误里没给出天花板值：{err}");
        assert!(!staging.dir().join("loose").exists(), "{tag}: 拒了却留下了目录");
    }
}

/* ---------------- 6. Windows 落盘不安全的名字：保留名 / 尾点尾空格 / ADS ---------------- */

/// L0 批补的三类「Win32 根本落不了盘」的条目名：保留设备名段（本侧新补）、
/// 任一段尾随 `.` / 空格、段内 `:`（NTFS 备用数据流 ADS，复用 `path-drive` 码）。
/// 走的是**生产链路** `extract_staging`（不是纯函数），并核「拒在动盘之前、暂存区无残壳」；
/// 期望码与 TS 侧 `zipEntryContractProblem` 同一套（共享表 `entryNames` / `tampers` 已加行）。
#[test]
fn zip_roundtrip_windows_unsafe_entry_names_stop_before_touching_disk() {
    for (name, want_code) in [
        ("files/CON.txt", "entry-name-encoding"),
        ("files/a.txt.", "path-windows-unsafe"),
        ("files/a.txt ", "path-windows-unsafe"),
        ("files/a.txt:stream", "path-drive"),
    ] {
        let bytes = build_zip(&[("pack.json", b"{\"schema\":1}".as_slice()), (name, b"x")]);
        let staging = Staging::new("l0-windows-unsafe-name");
        write_container(&staging, "a.zip", &bytes);
        let err = expect_extract_err(staging.dir(), "a.zip", "out", &table_limits(), name);
        assert_eq!(code_of(&err), want_code, "{name:?}: 拒绝码与 TS 侧不一致：{err}");
        assert!(!staging.dir().join("out").exists(), "{name:?}: 拒了却留下了目标目录");
        assert_only_container(&staging, "a.zip");
    }
    // 合法名相邻形态零误伤（中间有点 / 点多于一个 / 中文深目录都得过闸）
    for name in ["files/v1.0/README.md", "files/a.b.c.txt", "files/deep/说明.txt"] {
        assert_eq!(
            entry_contract_problem(name, name.as_bytes(), Some(ZIP_FLAG_UTF8), table_limits().max_depth),
            None,
            "{name:?} 被误拒"
        );
    }
}

/* ------------------------ 发布（上传）闸与解析 ------------------------ */

use crate::market::{
    body_excerpt, device_token_url, digest_hex_problem, parse_device_token, parse_publish_body,
    publish_host_in_allowlist, publish_length_mismatch_problem, publish_request_url,
    publish_upload_headers, publish_url_problem, rejection_code_or_http, sha256_stream,
    PublishManifestSummary, MARKET_ZIP_CONTENT_TYPE, MARKET_ZIP_SHA256_HEADER,
    PUBLISH_BODY_EXCERPT_CHARS,
};

fn manifest_summary(id: &str, name: &str) -> PublishManifestSummary {
    PublishManifestSummary {
        kind: "dict-pack".to_string(),
        id: id.to_string(),
        version: "1.0.0".to_string(),
        name: name.to_string(),
        author: "作者&Co".to_string(),
    }
}

#[test]
fn publish_allowlist_accepts_backend_and_workers_dev_subdomains() {
    for host in [
        "market.362573581.xyz",
        "MARKET.362573581.XYZ",
        "market.362573581.xyz.",
        "preview.workers.dev",
        "market-preview.workers.dev",
    ] {
        assert!(publish_host_in_allowlist(host), "{host} 应在发布白名单内");
    }
}

#[test]
fn publish_allowlist_rejects_lookalikes_and_nested_labels() {
    for host in [
        "evil.com",
        "market.3625735381.xyz.evil.io",
        "3625735381.xyz",
        "a.b.workers.dev",
        "workers.dev",
        ".workers.dev",
        "evil.workers.dev.example.com",
        // 双闸独立性：下载侧的 GitHub 系主机**不在**发布闸放行
        "github.com",
        "demo.github.io",
        "",
    ] {
        assert!(!publish_host_in_allowlist(host), "{host} 不该被发布闸放行");
    }
}

#[test]
fn publish_url_gate_shares_shape_but_not_host_table() {
    // 形态闸同一份：http / userinfo / 非默认端口照拒
    assert!(publish_url_problem(&url("http://market.3625735381.xyz/publish")).is_some());
    assert!(publish_url_problem(&url("https://x@market.3625735381.xyz/publish")).is_some());
    assert!(publish_url_problem(&url("https://market.3625735381.xyz:8443/publish")).is_some());
    assert!(publish_url_problem(&url("https://market.362573581.xyz/publish")).is_none());
    assert!(publish_url_problem(&url("https://t.workers.dev/publish")).is_none());
    // 反向独立性：下载闸放行的 GitHub 主机在发布闸下被拒（同形不同表，防"表合并漂移"）
    let gh = url("https://github.com/a.zip");
    let gh_problem = publish_url_problem(&gh).unwrap();
    assert!(gh_problem.contains("不在平台放行列表"), "GitHub 主机没被发布闸拒：{gh_problem}");
    assert!(url_problem(&gh).is_none(), "同一 URL 下载闸应放行（双闸独立）");
    let market = url("https://market.362573581.xyz/publish");
    assert!(url_problem(&market).is_some(), "发布后端主机不该被下载闸放行");
}

#[test]
fn publish_request_url_encodes_summary_and_joins_endpoint_paths() {
    // 默认 origin 直拼 + 五个查询参数（身份字段随 URL，body 恒是 zip 原始字节）
    let u = publish_request_url("https://market.362573581.xyz", &manifest_summary("demo.dict", "白面&飞雪")).unwrap();
    assert_eq!(u.host_str(), Some("market.362573581.xyz"));
    assert_eq!(u.path(), "/publish");
    let q: Vec<(String, String)> = u.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    assert_eq!(
        q,
        vec![
            ("kind".into(), "dict-pack".into()),
            ("id".into(), "demo.dict".into()),
            ("version".into(), "1.0.0".into()),
            ("name".into(), "白面&飞雪".into()),
            ("author".into(), "作者&Co".into()),
        ],
        "概要五字段必须逐位随行（& 等保留字须编码而不是截断）"
    );
    assert_eq!(u.query().unwrap(), "kind=dict-pack&id=demo.dict&version=1.0.0&name=%E7%99%BD%E9%9D%A2%26%E9%A3%9E%E9%9B%AA&author=%E4%BD%9C%E8%80%85%26Co");
    // 尾斜杠端点：join 语义不产生双斜杠
    let slash = publish_request_url("https://market.362573581.xyz/", &manifest_summary("d", "n")).unwrap();
    assert_eq!(slash.path(), "/publish");
    // 带路径的端点按 RFC 3986 相对解析（内测源形态）
    let nested = publish_request_url("https://t.workers.dev/api/v1", &manifest_summary("d", "n")).unwrap();
    assert_eq!(nested.host_str(), Some("t.workers.dev"));
    assert_eq!(nested.path(), "/api/v1/publish");
    // device-token 的拼法
    assert_eq!(device_token_url("https://market.362573581.xyz").unwrap().path(), "/device-token");
}

#[test]
fn parse_publish_body_honours_outcome_and_rejects_garbage() {
    // 成功：{ok:true, prUrl}；带 verified（structure-only）时原样搬运
    let ok = parse_publish_body(br#"{"ok":true,"prUrl":"https://github.com/p/pull/1"}"#, 200, "https://market.362573581.xyz/publish?id=d").unwrap();
    assert!(ok.ok);
    assert_eq!(ok.pr_url.as_deref(), Some("https://github.com/p/pull/1"));
    assert!(ok.rejected.is_none());
    assert_eq!(ok.status, 200);
    assert!(ok.verified.is_none(), "后端没说 verified 就不带");
    let ok_v = parse_publish_body(
        br#"{"ok":true,"prUrl":"https://github.com/p/pull/1","verified":"structure-only"}"#,
        200,
        "u",
    )
    .unwrap();
    assert_eq!(ok_v.verified.as_deref(), Some("structure-only"));
    // 拒绝：{ok:false, rejected:{code,message}}（后端配 4xx 也按裁决走——真源是 body）。
    // 字节串字面量只许 ASCII ⇒ 中文 message 用 &str 原样取 as_bytes（UTF-8 逐字节同形）
    let rej_body = r#"{"ok":false,"rejected":{"code":"container-invalid","message":"包体缺 pack.json"}}"#;
    let rej = parse_publish_body(
        rej_body.as_bytes(),
        422,
        "https://market.362573581.xyz/publish",
    )
    .unwrap();
    assert!(!rej.ok);
    let r = rej.rejected.expect("ok=false 必须带 rejected");
    assert_eq!(r.code, "container-invalid");
    assert_eq!(r.message, "包体缺 pack.json");
    assert_eq!(rej.status, 422);
    // 垃圾：缺 ok / 缺 prUrl / ok=false 缺 rejected / 非 JSON
    assert!(parse_publish_body(br#"{"prUrl":"x"}"#, 200, "u").unwrap_err().contains("缺 ok"));
    assert!(parse_publish_body(br#"{"ok":true}"#, 200, "u").unwrap_err().contains("prUrl"));
    assert!(parse_publish_body(br#"{"ok":false}"#, 200, "u").unwrap_err().contains("rejected"));
    assert!(parse_publish_body(b"<html>502</html>", 502, "u").unwrap_err().contains("JSON"));
    // message 缺失给空串不炸（code 是主键，message 只是给人话）
    let no_msg = parse_publish_body(br#"{"ok":false,"rejected":{"code":"x"}}"#, 200, "u").unwrap();
    assert_eq!(no_msg.rejected.unwrap().message, "");
}

/// 响应归一化的表驱动判据（2026-10-18 实测回归）：真实后端用 **HTTP 400 + 裸
/// `{"rejected":{...}}`** 表达拒绝，旧实现只看 `ok` ⇒ 报"缺 ok"把拒因吞了。
/// 这里逐形状钉住裁决与兜底：成功 / ok:false / 裸 rejected / 空 code / 顶层 message /
/// 顶层 error（含对象形态）/ 非 JSON / 2xx 缺 prUrl。
#[test]
fn parse_publish_body_normalizes_every_backend_shape() {
    let final_url = "https://market.362573581.xyz/publish?kind=kojo-pack&id=demo";

    // ① 成功：2xx + ok:true + prUrl（verified 原样搬运，status/finalUrl 语义不变）
    let ok = parse_publish_body(
        br#"{"ok":true,"prUrl":"https://github.com/p/pull/7","verified":"structure-only"}"#,
        201,
        final_url,
    )
    .unwrap();
    assert!(ok.ok);
    assert_eq!(ok.pr_url.as_deref(), Some("https://github.com/p/pull/7"));
    assert!(ok.rejected.is_none());
    assert_eq!(ok.status, 201);
    assert_eq!(ok.final_url, final_url);
    assert_eq!(ok.verified.as_deref(), Some("structure-only"));

    // ② ok:false + rejected：照裁决搬运
    let rej = parse_publish_body(
        r#"{"ok":false,"rejected":{"code":"container-invalid","message":"包体缺 pack.json"}}"#
            .as_bytes(),
        422,
        final_url,
    )
    .unwrap();
    assert!(!rej.ok);
    let r = rej.rejected.expect("ok=false 必须带 rejected");
    assert_eq!(
        (r.code.as_str(), r.message.as_str()),
        ("container-invalid", "包体缺 pack.json")
    );

    // ③ 裸 rejected（本次后端形状：HTTP 400 + 无 ok）⇒ 拒绝，不是"缺 ok"
    let bare = parse_publish_body(
        r#"{"rejected":{"code":"container-digest","message":"包体 sha256 校验值缺失、形态不对或与实际内容不符——请更新编辑器后重新导出上传","detail":"缺 x-market-zip-sha256 头或形态不对"}}"#
            .as_bytes(),
        400,
        final_url,
    )
    .unwrap();
    assert!(!bare.ok, "裸 rejected 必须归一成拒绝");
    assert_eq!(bare.status, 400);
    let r = bare.rejected.expect("裸 rejected 必须带 rejected");
    assert_eq!(r.code, "container-digest");
    assert_eq!(
        r.message, "包体 sha256 校验值缺失、形态不对或与实际内容不符——请更新编辑器后重新导出上传",
        "主 message 不许被 detail 顶掉"
    );

    // ④ rejected.code 为空 ⇒ 非空兜底（非 2xx 落 http-<status>，2xx 落 unknown）
    let empty = parse_publish_body(r#"{"rejected":{"code":"","message":"x"}}"#.as_bytes(), 400, final_url)
        .unwrap();
    assert_eq!(empty.rejected.unwrap().code, "http-400");
    let empty_2xx =
        parse_publish_body(br#"{"ok":false,"rejected":{"code":""}}"#, 200, final_url).unwrap();
    assert_eq!(empty_2xx.rejected.unwrap().code, "unknown");

    // ⑤ 非 2xx + {message} ⇒ 拒绝，code 兜底 http-<status>
    let msg = parse_publish_body(r#"{"message":"请求体签名不对"}"#.as_bytes(), 400, final_url)
        .unwrap();
    assert!(!msg.ok);
    let r = msg.rejected.unwrap();
    assert_eq!((r.code.as_str(), r.message.as_str()), ("http-400", "请求体签名不对"));

    // ⑤b 非 2xx + {error, detail} ⇒ code 取 error，message 空时用 detail 兜底
    let err_shape = parse_publish_body(
        r#"{"error":"invalid-container","detail":"zip 头不完整"}"#.as_bytes(),
        502,
        final_url,
    )
    .unwrap();
    let r = err_shape.rejected.unwrap();
    assert_eq!((r.code.as_str(), r.message.as_str()), ("invalid-container", "zip 头不完整"));
    // error 是对象时取它的 code
    let err_obj = parse_publish_body(
        r#"{"error":{"code":"bad-gateway","message":"上游失败"}}"#.as_bytes(),
        502,
        final_url,
    )
    .unwrap();
    assert_eq!(err_obj.rejected.unwrap().code, "bad-gateway");

    // ⑥ 非 JSON / HTML：平台错误带状态、finalUrl、正文摘录（去控制字符、截断）
    let e = parse_publish_body(b"<html>\x00\x07<body>400 Bad Request</body></html>", 400, final_url)
        .unwrap_err();
    assert!(e.contains("HTTP 400"), "错误里没有状态：{e}");
    assert!(e.contains(final_url), "错误里没有 finalUrl：{e}");
    assert!(e.contains("JSON"), "错误没说是非 JSON：{e}");
    assert!(e.contains("400 Bad Request"), "错误里没有正文摘录：{e}");
    assert!(
        !e.contains('\u{0}') && !e.contains('\u{7}'),
        "摘录里留了控制字符：{e:?}"
    );
    let huge = parse_publish_body(&vec![b'A'; 10_000], 502, final_url).unwrap_err();
    assert!(
        huge.len() < 1_000,
        "非 JSON 错误把整页正文灌出来了：{} 字节",
        huge.len()
    );

    // ⑦ 2xx 缺 prUrl ⇒ 明确错误，不演成成功
    for body in [br#"{"ok":true}"#.as_slice(), br#"{"ok":true,"prUrl":""}"#.as_slice()] {
        let e = parse_publish_body(body, 200, final_url).unwrap_err();
        assert!(e.contains("prUrl"), "缺 prUrl 没被明确报错：{e}");
    }
}

/// 摘要与头部：**纯函数**判据（白名单不放宽 localhost，所以不起本地 HTTP）。
/// 1) 流式 SHA-256 与已知向量逐字相同（含跨 64 KiB 块的多轮读取）；
/// 2) 摘要头就挂 `x-market-zip-sha256`（小写 64 hex）+ `Content-Type: application/zip`；
/// 3) 形态不对的摘要一律拒（大写 / 短 / 非 hex / 空）。
#[test]
fn upload_digest_streams_exact_bytes_and_forms_the_required_headers() {
    // 已知向量（FIPS 180-2）：SHA-256("abc")
    let mut abc: &[u8] = b"abc";
    let (digest, n) = tauri::async_runtime::block_on(sha256_stream(&mut abc)).expect("内存流必须可哈希");
    assert_eq!(n, 3);
    assert_eq!(
        digest,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert!(
        digest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "摘要不是小写 hex：{digest}"
    );

    // 跨块：100 KiB 全零（>64 KiB 缓冲 ⇒ 至少两轮 read），与 node:crypto 复算值钉住
    let payload = vec![0u8; 100 * 1024];
    let mut reader: &[u8] = &payload;
    let (big, read) = tauri::async_runtime::block_on(sha256_stream(&mut reader)).expect("大流必须可哈希");
    assert_eq!(read, 100 * 1024, "流式读取丢字节或多字节");
    assert_eq!(
        big,
        "f627ca4c2c322f15db26152df306bd4f983f0146409b81a4341b9b340c365a16",
        "跨块摘要与已知值不符（分块边界改变了摘要？）"
    );

    // 头部：两件都要挂上，且摘要头名/值逐字可读
    let headers = publish_upload_headers(&digest).expect("64 位小写 hex 必须能挂头");
    assert_eq!(MARKET_ZIP_SHA256_HEADER, "x-market-zip-sha256");
    assert_eq!(MARKET_ZIP_CONTENT_TYPE, "application/zip");
    assert_eq!(
        headers
            .get(MARKET_ZIP_SHA256_HEADER)
            .and_then(|v| v.to_str().ok()),
        Some(digest.as_str())
    );
    assert_eq!(
        headers
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        Some("application/zip")
    );

    // 形态闸：大写 / 短 / 长 / 非 hex / 空一律拒（后端只认小写 64 hex）
    for bad in [
        String::new(),
        "abc".to_string(),
        "A".repeat(64),
        "g".repeat(64),
        "a".repeat(63),
        "a".repeat(65),
        format!("{digest} "),
    ] {
        assert!(
            publish_upload_headers(&bad).is_err(),
            "非法摘要被放行：{bad:?}"
        );
        assert!(digest_hex_problem(&bad).is_some(), "摘要形态闸漏了：{bad:?}");
    }
    assert_eq!(digest_hex_problem(&digest), None);
}

/// 读前 / 读后长度一致性（纯函数）：三值全等才放行；文件在读取中变长变短都拒。
#[test]
fn upload_length_mismatch_is_rejected_and_digest_code_falls_back() {
    assert_eq!(publish_length_mismatch_problem(10, 10, 10), None);
    for (expected, hashed, after) in [(10, 9, 10), (10, 10, 11), (10, 12, 10), (0, 0, 1)] {
        let msg = publish_length_mismatch_problem(expected, hashed, after)
            .unwrap_or_else(|| panic!("{expected}/{hashed}/{after} 该被拒"));
        assert!(msg.contains("读取过程中发生了变化"), "拒因不可诊断：{msg}");
        assert!(msg.contains("请重试"), "拒因没给出行动：{msg}");
    }
    // 拒因码兜底：后端给了照搬；空串不许流出去
    assert_eq!(rejection_code_or_http(Some("container-digest"), 400), "container-digest");
    assert_eq!(rejection_code_or_http(Some("  "), 400), "http-400");
    assert_eq!(rejection_code_or_http(None, 422), "http-422");
    assert_eq!(rejection_code_or_http(None, 200), "unknown");
}

/// 非 JSON 摘录：控制字符去掉、空白折叠、按字符截断（不输出海量 HTML）。
#[test]
fn publish_body_excerpt_is_clean_and_bounded() {
    let excerpt = body_excerpt(b"<html>\x00\x07\n  <body>400 Bad Request</body></html>");
    assert!(
        !excerpt.chars().any(|c| c.is_control()),
        "摘录里还有控制字符：{excerpt:?}"
    );
    assert!(excerpt.starts_with("<html>"), "{excerpt:?}");
    assert!(excerpt.contains("400 Bad Request"), "{excerpt:?}");
    assert!(!excerpt.contains("  "), "连续空白没折叠：{excerpt:?}");
    let long = body_excerpt(&vec![b'x'; 10_000]);
    assert_eq!(
        long.chars().count(),
        PUBLISH_BODY_EXCERPT_CHARS + 1,
        "长正文没按字符上限截断"
    );
    assert!(long.ends_with('…'), "截断没给出省略号：{long:?}");
    assert_eq!(body_excerpt(b""), "");
}

#[test]
fn parse_device_token_extracts_and_rejects_garbage() {
    assert_eq!(parse_device_token(br#"{"token":"dev_abc123"}"#).unwrap(), "dev_abc123");
    assert!(parse_device_token(b"not json").is_err());
    assert!(parse_device_token(br#"{"token":""}"#).is_err(), "空串 token 不给");
    assert!(parse_device_token(br#"{"ok":true}"#).is_err());
}
