//! 插件项目宿主面（`launcher_project_hash` / `launcher_project_extract`）的判据。
//!
//! 全部跑在 `temp_dir()` 下的一次性目录里，**不碰真游戏目录、不碰真工作区**。
//! 断言的是盘上事实与逐字段读数：摘要 = 同一份字节的 SHA-256、两次同内容逐字段相同、
//! 任何越界都在读到/写出字节之前被拒、解包落点只可能在 `launcher/project-staging/` 下。

use std::path::PathBuf;

use super::content_tests::{test_host, write_zip, TestDir};
use super::paths;
use super::project::{self, ProjectExtractOptionsDto};
use super::trust;
use crate::archive_guard::StagingLimits;

/// 解包限额（三个数从契约常量那一档里取，测试只是把它写成显式入参）。
const LIMITS: StagingLimits = StagingLimits {
    max_entries: 1000,
    max_depth: 8,
    max_unpacked_bytes: 8 * 1024 * 1024,
};

fn opts() -> ProjectExtractOptionsDto {
    ProjectExtractOptionsDto { limits: LIMITS }
}

/// 造一个最小插件项目：`{proj}/plugin/{a.txt, sub/b.bin}`。
fn write_project(dir: &TestDir) -> PathBuf {
    let project = dir.join("proj");
    std::fs::create_dir_all(project.join("plugin/sub")).expect("项目目录");
    std::fs::write(project.join("plugin/a.txt"), b"alpha").expect("a.txt");
    std::fs::write(project.join("plugin/sub/b.bin"), b"beta-beta").expect("b.bin");
    project
}

/// 造一只 `pack.json` + 载荷的项目 ZIP。
fn project_zip(dir: &TestDir, payload: &[(&str, &[u8])]) -> PathBuf {
    let manifest = serde_json::json!({
        "schemaVersion": 1,
        "id": "demo.packed",
        "name": "包里的插件",
        "version": "0.9.0",
        "kind": "plugin",
        "gameId": "demo",
        "files": [],
        "loadOrder": 0,
    });
    let mut entries: Vec<(String, Vec<u8>)> = vec![(
        "pack.json".to_string(),
        serde_json::to_vec_pretty(&manifest).expect("清单序列化"),
    )];
    entries.extend(payload.iter().map(|(name, bytes)| (name.to_string(), bytes.to_vec())));
    let path = dir.join("demo.zip");
    write_zip(&path, &entries);
    path
}

fn staging_children(host: &super::LauncherHost) -> usize {
    std::fs::read_dir(host.layout.project_staging_root())
        .map(|read| read.count())
        .unwrap_or(0)
}

/* ------------------------------- 摘要 ------------------------------- */

#[test]
fn hashes_each_entry_with_the_same_bytes() {
    let dir = TestDir::new("hash");
    let project = write_project(&dir);

    let out = project::hash_project(
        &project,
        "plugin",
        &["a.txt".to_string(), "sub/b.bin".to_string()],
    )
    .expect("正常目录必须能摘要");

    assert_eq!(out.len(), 2);
    // 入参顺序 + path 原样回显（消费方按它配对）
    assert_eq!(out[0].path, "a.txt");
    assert_eq!(out[0].sha256, trust::sha256_bytes(b"alpha"));
    assert_eq!(out[0].size, 5);
    assert_eq!(out[1].path, "sub/b.bin");
    assert_eq!(out[1].sha256, trust::sha256_bytes(b"beta-beta"));
    assert_eq!(out[1].size, 9);
}

#[test]
fn hashing_the_same_content_twice_is_identical() {
    let dir = TestDir::new("hash-twice");
    let project = write_project(&dir);
    let entries = ["a.txt".to_string(), "sub/b.bin".to_string()];

    let first = project::hash_project(&project, "plugin", &entries).expect("首轮摘要");
    let second = project::hash_project(&project, "plugin", &entries).expect("次轮摘要");

    assert_eq!(first, second, "同内容两次摘要必须逐字段相同");
}

#[test]
fn rejects_entries_that_escape_the_artifact_dir() {
    let dir = TestDir::new("hash-escape");
    let project = write_project(&dir);

    for bad in [
        "../outside.txt",
        "sub/../../outside.txt",
        "/etc/passwd",
        "C:/Windows/win.ini",
        "sub\\b.bin",
    ] {
        let err = project::hash_project(&project, "plugin", &[bad.to_string()])
            .expect_err("越界条目必须被拒");
        assert_eq!(err.code, "LAUNCHER_PATH_ESCAPE", "条目 {bad} 应拒");
    }

    // 制品目录本身也只许单层
    let err = project::hash_project(&project, "plugin/sub", &[]).expect_err("多层制品目录必须被拒");
    assert_eq!(err.code, "LAUNCHER_PATH_ESCAPE");
}

#[test]
fn missing_directory_or_file_fails_closed() {
    let dir = TestDir::new("hash-missing");
    let project = write_project(&dir);

    let err = project::hash_project(&dir.join("ghost"), "plugin", &[]).expect_err("缺项目目录要拒");
    assert_eq!(err.code, "LAUNCHER_PATH_ESCAPE");

    let err = project::hash_project(&project, "build", &[]).expect_err("缺制品目录要拒");
    assert_eq!(err.code, "LAUNCHER_PATH_ESCAPE");

    let err = project::hash_project(&project, "plugin", &["ghost.txt".to_string()])
        .expect_err("缺文件要拒");
    assert_eq!(err.code, "LAUNCHER_INTERNAL");

    let err = project::hash_project(std::path::Path::new("relative/proj"), "plugin", &[])
        .expect_err("相对项目路径要拒");
    assert_eq!(err.code, "LAUNCHER_PATH_ESCAPE");
}

/// 符号链接逃逸：目录链接指向项目外时，条目即使字面在制品根下也必须被拒。
/// 无符号链接权限的账户跳过（Windows 非开发者模式下的正常态）。
#[cfg(windows)]
#[test]
fn rejects_symlink_that_points_outside_the_artifact_dir() {
    use std::os::windows::fs::symlink_dir;

    let dir = TestDir::new("hash-link");
    let project = write_project(&dir);
    let outside = dir.join("outside");
    std::fs::create_dir_all(&outside).expect("外部目录");
    std::fs::write(outside.join("secret.txt"), b"secret").expect("外部文件");
    let link = project.join("plugin/link");
    if let Err(e) = symlink_dir(&outside, &link) {
        eprintln!("跳过符号链接用例：当前账户不能创建目录符号链接（{e}）");
        return;
    }

    let err = project::hash_project(&project, "plugin", &["link/secret.txt".to_string()])
        .expect_err("链接逃逸必须被拒");
    assert_eq!(err.code, "LAUNCHER_PATH_ESCAPE");
}

/* ------------------------------- 解包 ------------------------------- */

#[test]
fn extract_unpacks_into_host_staging_and_reads_manifest_back() {
    let dir = TestDir::new("extract");
    let host = test_host(dir.path());
    host.layout.ensure_root().expect("启动器骨架");
    let zip = project_zip(
        &dir,
        &[("script/a.txt", b"a\n"), ("script/deep/b.txt", b"b\n")],
    );

    let out = project::extract_project(&host, &zip.to_string_lossy(), &opts()).expect("解包");

    assert_eq!(out.manifest.id, "demo.packed");
    assert_eq!(out.manifest.game_id, "demo");
    let staging = PathBuf::from(&out.staging_dir);
    assert!(
        paths::path_has_prefix(&host.layout.project_staging_root(), &staging),
        "暂存落点必须在 launcher/project-staging/ 下：{}",
        staging.display()
    );
    assert_eq!(std::fs::read(staging.join("script/a.txt")).expect("a.txt"), b"a\n");
    assert_eq!(
        std::fs::read(staging.join("script/deep/b.txt")).expect("b.txt"),
        b"b\n"
    );
    // `pack.json` 是清单不是载荷：不进 entries（否则消费方会把它当 {rootId}/{path} 分组）
    assert_eq!(
        out.entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>(),
        vec!["script/a.txt", "script/deep/b.txt"]
    );
    assert!(out.entries.iter().all(|entry| entry.kind == "file"));
    assert_eq!(out.entries[0].size, 2);
    assert_eq!(out.entries[1].size, 2);
}

#[test]
fn extract_without_manifest_fails_closed_and_leaves_no_staging() {
    let dir = TestDir::new("extract-nomanifest");
    let host = test_host(dir.path());
    host.layout.ensure_root().expect("启动器骨架");
    let zip_path = dir.join("nomanifest.zip");
    write_zip(&zip_path, &[("script/a.txt".to_string(), b"a\n".to_vec())]);

    let err = project::extract_project(&host, &zip_path.to_string_lossy(), &opts())
        .expect_err("缺 pack.json 必须拒");
    assert_eq!(err.code, "LAUNCHER_ARCHIVE_INVALID");
    assert_eq!(staging_children(&host), 0, "失败不许留下暂存残壳");
}

#[test]
fn extract_rejects_entries_escaping_the_staging_dir() {
    let dir = TestDir::new("extract-escape");
    let host = test_host(dir.path());
    host.layout.ensure_root().expect("启动器骨架");
    let zip = project_zip(&dir, &[("../evil.txt", b"evil")]);

    let err = project::extract_project(&host, &zip.to_string_lossy(), &opts())
        .expect_err("越界条目必须拒");
    assert_eq!(err.code, "LAUNCHER_PATH_ESCAPE");
    assert!(!dir.join("evil.txt").exists(), "越界条目一个字节都不许落到暂存外");
    assert_eq!(staging_children(&host), 0, "失败不许留下暂存残壳");
}
