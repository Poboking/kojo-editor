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
    container_name_problem, download_to_staging, entry_type_problem, extract_staging,
    host_in_allowlist, redirect_problem, staging_component_problem, url_problem, DownloadOptions,
    StagingLimits,
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
    assert!(problem.contains("不在白名单内"), "白名单外一跳没被拒：{problem}");

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
