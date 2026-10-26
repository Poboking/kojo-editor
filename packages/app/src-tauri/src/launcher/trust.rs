//! 可执行文件信任（§13.2 第 6 步 / §13.1「插件绕过信任确认」）。
//!
//! 两条不可协商的事实：
//! - **哈希由宿主算**：命令签名里根本没有"哈希"这个参数，JS 传什么都不存在（不是忽略，
//!   是无处可传）；每次启动前**复算**，与记录逐字比较，变化即 `LAUNCHER_TRUST_CHANGED`；
//! - **确认由原生框给**：`approvedBy` 是固定字面量 `"native-dialog"`，由宿主在同一个命令内
//!   弹框；对话框被取消 = 抛 `LAUNCHER_TRUST_REQUIRED`，不写记录、不放行。
//!
//! 本模块把"算哈希 / 拼确认文案 / 建记录"与"弹框"分开：前三件事是纯 IO + 纯字符串，
//! 单测直接钉；弹框那一层只有命令会走（测试不可自动化，也不该被自动化）。

use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};

use super::error::{io_failure, ErrorCode, LauncherErrorDto, LauncherResult};
use super::store::StoredTrust;

/// 流式哈希的块大小（64 KiB：大 exe 不整包读进内存）。
const HASH_CHUNK: usize = 64 * 1024;

/// 文件摘要：`sha256` 为小写十六进制（与 `ExecutableTrust.sha256` 同形）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDigest {
    pub sha256: String,
    pub size: u64,
}

/// 流式 SHA-256（只读、不写、不改 mtime）。
pub fn sha256_file(path: &Path) -> LauncherResult<FileDigest> {
    let mut file = std::fs::File::open(path).map_err(|e| io_failure("打开可执行文件", path, &e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; HASH_CHUNK];
    let mut size: u64 = 0;
    loop {
        let read = file
            .read(&mut buf)
            .map_err(|e| io_failure("读取可执行文件", path, &e))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
        size = size.saturating_add(read as u64);
    }
    Ok(FileDigest {
        sha256: hex_lower(&hasher.finalize()),
        size,
    })
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 内存字节的 SHA-256（小写十六进制）。
///
/// 内容包 / 存档已经在解包期**整份读进内存**（单条目上限由共享表夹住），落盘前后各算一次
/// 即可；这里复用同一份哈希实现，不引第二个摘要口径。
pub fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex_lower(&hasher.finalize())
}

/// 原生确认框的正文。**把路径与哈希都摆出来**：用户看到的是"要运行哪个文件"。
pub fn confirm_text(display_path: &Path, digest: &FileDigest) -> String {
    format!(
        "即将信任并允许启动这个程序：\n\n{}\n\n大小：{} 字节\nSHA-256：{}\n\n\
         只有在你确认这是该实例应当运行的程序时才继续；此后每次启动宿主都会复算哈希，\
         文件一旦变化会立即拦下。",
        display_path.display(),
        digest.size,
        digest.sha256
    )
}

/// 原生确认框（宿主弹，JS 无法跳步）。用户点「否」/关窗 = `Ok(false)`。
pub async fn confirm_native(title: &str, text: &str) -> LauncherResult<bool> {
    let answer = rfd::AsyncMessageDialog::new()
        .set_title(title)
        .set_description(text)
        .set_buttons(rfd::MessageButtons::YesNo)
        .set_level(rfd::MessageLevel::Warning)
        .show()
        .await;
    Ok(matches!(answer, rfd::MessageDialogResult::Yes))
}

/// 建信任记录。`approved_by` 写死 `"native-dialog"`——本结构体没有别的构造入口。
pub fn make_trust(digest: &FileDigest, approved_at: &str) -> StoredTrust {
    StoredTrust {
        sha256: digest.sha256.clone(),
        size: digest.size,
        approved_at: approved_at.to_string(),
        approved_by: "native-dialog".to_string(),
    }
}

/// 启动前的哈希复验（§13.2 第 6 步）。
///
/// - 没有记录 ⇒ `TRUST_REQUIRED`
/// - 记录与现算不等 ⇒ `TRUST_CHANGED`（附两枚哈希，便于排障）
pub fn verify_trust(expected: Option<&StoredTrust>, actual: &FileDigest) -> LauncherResult<()> {
    let Some(trust) = expected else {
        return Err(LauncherErrorDto::new(
            ErrorCode::TrustRequired,
            "这个实例的可执行文件还没有信任记录，请先确认信任",
        ));
    };
    if trust.sha256 != actual.sha256 {
        return Err(LauncherErrorDto::new(
            ErrorCode::TrustChanged,
            "可执行文件已变化，原本的信任不再成立，请重新确认",
        )
        .detail(format!(
            "记录 sha256={}，现算 sha256={}；大小 {} → {} 字节",
            trust.sha256, actual.sha256, trust.size, actual.size
        ))
        .with_retryable(true));
    }
    Ok(())
}
