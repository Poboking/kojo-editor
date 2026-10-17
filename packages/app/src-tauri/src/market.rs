//! 市场（无服务器口上包分发）的 IO 原语：**远程下载**、**ZIP 安全解压**、
//! 以及**不落盘的远程取文本**（注册表索引）。
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
//!   与解包侧（本文件）各有一条测试消费同一张表与同一个容器夹具，谁漂谁红。
//!   本层不止测试在读它——命名闸的两个参数与后缀（`zipContainerNameRule`）、入参天花板
//!   （`limits`）**都从编译期内嵌的这张表取**（`include_str!`，形态照 W12 的
//!   `decode-probe-policy.json`），所以两侧不存在"各写一套 if 再拿测试对齐"的第二份真相。

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

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
/// 暂存名字符集：小写字母数字与 `.` `_` `-`，长度与后缀由**共享表**给，且不能是纯点名。
/// 这两个数**过去是本层私藏的两个 `const`**（TS 侧 `zip.ts` 另有一份同值字面量，"同一套规则"
/// 只有注释担保）；现在本层读的就是表里那一段 —— 表漂一字节即红，见下面 `zip_roundtrip_contract`。

/// unix 文件类型位（zip 的 `external_attr` 高 16 位）。
const S_IFMT: u32 = 0o170000;
const S_IFREG: u32 = 0o100000;

/* ---------------- 共享表体：命名闸与限额天花板的唯一真相 ---------------- */

/// 表体 = `packages/plugin-api/fixtures/zip-roundtrip/contract.json`（**编译期内嵌**，
/// 不是运行期可丢的外部文件；形态照本宿主的 `decode-probe-policy.json`，W12 ENC-SRC）。
///
/// 打包（TS `plugin-api/src/zip.ts`）与解包（本文件）分家于两种语言、无法共享实现，
/// 于是把**规则参数**收成一份表体：本层的 `staging_component_problem` /
/// `container_name_problem` 用的长度上限、字符集字面、后缀、纯点名那一项，以及
/// `extract_staging` 的入参天花板，**全部**来自这里。TS 侧那两份镜像常量
/// （`ZIP_CONTAINER_NAME_MAX` / `MARKET_ZIP_SUFFIX`）与本表逐项相等，钉在
/// `packages/plugin-api/tests/zip-roundtrip.test.ts`；Rust 侧钉在
/// `market_tests.rs::zip_roundtrip_name_gates_read_the_shared_table`。
/// **表漂一字节必有一边红。**
pub(crate) const ZIP_ROUNDTRIP_CONTRACT_JSON: &str =
    include_str!("../../../plugin-api/fixtures/zip-roundtrip/contract.json");

/// 表里 `containerNameRule.charset` 允许出现的那个字面：它描述的正是下面 `name_byte_allowed`
/// 实现的字节类。表若被改成别的字符集，本层**不跟着改文案**、也不猜——直接判表不可用：
/// 改字符集必须两侧各改一次实现，对拍才认（一张会被"读着生效"的表等于没有表）。
const NAME_CHARSET_SPEC: &str = "[a-z0-9._-]";

/// 暂存名/容器名唯一允许的字节类（`NAME_CHARSET_SPEC` 的实现，大小写与分隔符一律拒）。
fn name_byte_allowed(b: u8) -> bool {
    b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
}

#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ZipContainerNameRule {
    /// 字符集字面（本层只实现 `NAME_CHARSET_SPEC` 那一种）
    pub(crate) charset: String,
    /// 名字长度上限（字节；`1..=maxBytes`）
    pub(crate) max_bytes: usize,
    /// 容器名后缀（下载与解压共用同一个名字 ⇒ 后缀也只此一份）
    pub(crate) suffix: String,
    /// 是否拒纯点名（`.` / `..`）
    pub(crate) reject_pure_dots: bool,
}

#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ZipRoundtripLimits {
    pub(crate) max_entries: usize,
    pub(crate) max_depth: usize,
    pub(crate) max_unpacked_bytes: u64,
}

/// 表里被本层**生产路径**消费的那两段（`golden` / `tampers` / `entryNames` 那三段是给
/// 两侧对拍测试读的，形状在 `market_tests.rs` 里按 `serde_json::Value` 取）。
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ZipRoundtripContract {
    /// 表形状版本闸：v1 = 下面这几段字段各就各位
    pub(crate) schema: u32,
    pub(crate) limits: ZipRoundtripLimits,
    pub(crate) container_name_rule: ZipContainerNameRule,
}

impl ZipRoundtripContract {
    /// 机械校验（铁律 4：不静默）——任何一项不合，本层宁可拒绝所有容器，也不退回本地常量。
    fn validate(&self) -> Result<(), String> {
        if self.schema != 1 {
            return Err(format!(
                "往返契约表版本不受支持：{}（本宿主只实现 v1 形状）",
                self.schema
            ));
        }
        let rule = &self.container_name_rule;
        if rule.charset != NAME_CHARSET_SPEC {
            return Err(format!(
                "共享表的字符集字面 {:?} 与本宿主实现的字节类 {NAME_CHARSET_SPEC:?} 不符（改字符集要两侧各改一次实现）",
                rule.charset
            ));
        }
        if rule.max_bytes == 0 || rule.max_bytes >= 4096 {
            return Err(format!("共享表的容器名长度上限不可信：{}", rule.max_bytes));
        }
        if rule.suffix.is_empty() || rule.suffix.len() >= rule.max_bytes {
            return Err(format!("共享表的容器名后缀不可信：{:?}", rule.suffix));
        }
        if self.limits.max_entries == 0 || self.limits.max_depth == 0 || self.limits.max_unpacked_bytes == 0 {
            return Err(format!(
                "共享表的限额含 0：entries={} depth={} bytes={}",
                self.limits.max_entries, self.limits.max_depth, self.limits.max_unpacked_bytes
            ));
        }
        Ok(())
    }
}

/// 内嵌表的惰性解析 + 校验。失败 = 命名闸与解包闸一律拒绝并给出原因，**不退回本地常量**
/// （退回去就等于又养出第二份真相，那正是这张表要消灭的东西）。
pub(crate) fn zip_roundtrip_contract() -> Result<&'static ZipRoundtripContract, String> {
    static TABLE: OnceLock<ZipRoundtripContract> = OnceLock::new();
    static FAILED: OnceLock<String> = OnceLock::new();
    if let Some(e) = FAILED.get() {
        return Err(e.clone());
    }
    if let Some(t) = TABLE.get() {
        return Ok(t);
    }
    let parsed: ZipRoundtripContract = serde_json::from_str(ZIP_ROUNDTRIP_CONTRACT_JSON)
        .map_err(|e| format!("内嵌 ZIP 往返契约表解析失败：{e}"))?;
    parsed
        .validate()
        .map_err(|e| format!("内嵌 ZIP 往返契约表非法：{e}"))?;
    Ok(TABLE.get_or_init(|| parsed))
}

/* --------------------- 容器原语（往返契约的读侧） --------------------- */

/// ZIP 2.0 的四处签名（字面口径与写侧 `plugin-api/src/zip.ts` 同一张表）。
const SIG_LOCAL: u32 = 0x0403_4b50;
const SIG_CENTRAL: u32 = 0x0201_4b50;
const SIG_EOCD: u32 = 0x0605_4b50;
const SIG_ZIP64_LOCATOR: u32 = 0x0706_4b50;
/// 本地头 / 中央目录记录的定长段（变量段是其后的 名字 + extra + 注释；
/// 往返对拍的篡改用例按这两个数就地改名，两侧同一份布局）。
pub(crate) const LOCAL_HEADER: usize = 30;
pub(crate) const CENTRAL_HEADER: usize = 46;
/// EOCD 的定长 22 字节，加上最长 65,535 字节的注释 = 尾部扫描窗口。
const EOCD_SIZE: u64 = 22;
const EOCD_COMMENT_MAX: u64 = 0xffff;
/// general purpose bit 11：名字与注释是 UTF-8。**缺这一位而名字含非 ASCII 字节时，
/// `zip` 读器把名字按 CP437 解码**（`zip-4.6.1/src/read.rs:1306` → `from_cp437`）——
/// 路径闸照样放行，落盘却是一只乱码文件名，于是"打包与解包互相不认识"这条洞
/// 必须在解包侧自己堵上（写侧恒置这一位，见 `zip.ts` 的 `ZIP_FLAG_UTF8`）。
/// 写侧（`plugin-api/src/zip.ts` 的 `ZIP_FLAG_UTF8`，同名同值）恒置这一位。
pub(crate) const ZIP_FLAG_UTF8: u16 = 0x0800;
/// ZIP64 的哨兵值（计数 `0xFFFF` / 偏移与尺寸 `0xFFFFFFFF`）：本契约明确不支持。
const ZIP64_SENTINEL_U16: u16 = 0xffff;
const ZIP64_SENTINEL_U32: u32 = 0xffff_ffff;
/// 本契约只认这两处压缩法（0 = store，8 = deflate）。加密条目（bit 0/1/2/6）、
/// 带数据描述符的条目（bit 3：头里的两个尺寸是 0）、其它压缩法一律 `container-structure`。
const METHOD_STORE: u16 = 0;
const METHOD_DEFLATE: u16 = 8;
/// general purpose bit 3 = 尺寸写在数据之后的数据描述符里（本契约不接受，理由同上一条）。
const FLAG_DATA_DESCRIPTOR: u16 = 0x0008;
/// general purpose bit 0/1/2 = 加密；bit 6 = 强加密。市场容器一律不许带。
const FLAG_ENCRYPTED: u16 = 0x0007;
const FLAG_STRONG_ENCRYPTION: u16 = 0x0040;

/// 中央目录里一条记录的**原始事实**（未经读器解码、未经读器去重）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RawEntry {
    pub(crate) name: String,
    pub(crate) raw_name: Vec<u8>,
    pub(crate) flags: u16,
    pub(crate) method: u16,
    pub(crate) crc32: u32,
    pub(crate) compressed_size: u32,
    pub(crate) uncompressed_size: u32,
    pub(crate) local_offset: u64,
    /// 中央目录记录起始偏移（往返对拍的篡改用例按它就地改名，与 TS 侧读器同一份布局）
    pub(crate) central_offset: u64,
    /// 本地头与中央目录是否逐字段互指一致（签名、名字、flags、压缩法、CRC、两个尺寸）
    pub(crate) local_matches_central: bool,
}

/// 一次中央目录解析的结果。
#[derive(Debug)]
pub(crate) struct RawContainer {
    pub(crate) entries: Vec<RawEntry>,
    pub(crate) declared_entries: u64,
    pub(crate) zip64: bool,
    pub(crate) total_unpacked_bytes: u64,
}

/// `container-structure` 那一类拒因（容器本身不是契约范围内的合法 ZIP 2.0 容器）。
fn structure(problem: impl AsRef<str>) -> String {
    format!("container-structure：{}", problem.as_ref())
}

fn le16_at(bytes: &[u8], at: usize) -> Option<u16> {
    let b = bytes.get(at..at + 2)?;
    Some(u16::from_le_bytes([b[0], b[1]]))
}

fn le32_at(bytes: &[u8], at: usize) -> Option<u32> {
    let b = bytes.get(at..at + 4)?;
    Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

/// 从 `offset` 起读 `len` 字节（读不满即拒：越界读取不许静默补零）。
fn read_range<R: Read + Seek>(reader: &mut R, offset: u64, len: usize) -> Result<Vec<u8>, String> {
    reader
        .seek(SeekFrom::Start(offset))
        .map_err(|e| structure(format!("定位 {offset} 失败: {e}")))?;
    let mut buf = vec![0u8; len];
    reader
        .read_exact(&mut buf)
        .map_err(|e| structure(format!("读 {offset}+{len} 失败: {e}")))?;
    Ok(buf)
}

/// **中央目录原语**：自己解析 EOCD → 中央目录 → 每条回读本地头核互指关系。
///
/// 为什么在 `zip` 读器之外还要这一层（三条洞，逐条都有对拍用例）：
/// 1. 读器按名字建 `IndexMap`（`zip-4.6.1/src/read.rs:72`），**同名条目被静默去重**
///    ——后写的覆盖前写的，`archive.len()` 报的是去重后的条数。真条目数只能自己数。
/// 2. 读器在 bit 11 缺失时把名字按 **CP437** 解码（`read.rs:1306`）：中文条目名变成
///    制表符块字符，路径闸照样放行，落盘文件名与包内名字不是同一串东西。
/// 3. 数据起点由**本地头**的两个长度字段决定，而尺寸与 CRC 由**中央目录**说话
///    （`read.rs:354` `find_data_start`）：两者不互指时解出来的是错字节，
///    这条不变量只有回到头部本身才核得了。
///
/// 全程只读 `22 + 注释上限` 的尾部窗口、中央目录区与每条 30+名字 字节，
/// **不解压任何一个字节**。
pub(crate) fn central_directory<R: Read + Seek>(reader: &mut R) -> Result<RawContainer, String> {
    let file_len = reader
        .seek(SeekFrom::End(0))
        .map_err(|e| structure(format!("读容器长度失败: {e}")))?;
    if file_len < EOCD_SIZE {
        return Err(structure(format!("容器只有 {file_len} 字节，装不下一个 EOCD")));
    }
    let window = (EOCD_SIZE + EOCD_COMMENT_MAX).min(file_len) as usize;
    let tail = read_range(reader, file_len - window as u64, window)?;
    // EOCD 只能从尾部倒着找（它前面可以是任意多的数据；注释长度必须刚好补满尾部）
    let mut eocd: Option<usize> = None;
    let mut at = window - EOCD_SIZE as usize;
    loop {
        if le32_at(&tail, at) == Some(SIG_EOCD)
            && at + EOCD_SIZE as usize + le16_at(&tail, at + 20).unwrap_or(1) as usize == window
        {
            eocd = Some(at);
            break;
        }
        if at == 0 {
            break;
        }
        at -= 1;
    }
    let eocd = eocd.ok_or_else(|| structure(format!("从尾部 {window} 字节里找不到 EOCD")))?;
    let eocd_abs = file_len - window as u64 + eocd as u64;
    if le16_at(&tail, eocd + 4).unwrap_or(1) != 0 || le16_at(&tail, eocd + 6).unwrap_or(1) != 0 {
        return Err(structure("多磁盘容器不在契约内"));
    }
    if le16_at(&tail, eocd + 20).unwrap_or(1) != 0 {
        return Err(structure("容器带注释，本契约不接受"));
    }
    let declared_entries = le16_at(&tail, eocd + 10).unwrap_or(0);
    let central_size = le32_at(&tail, eocd + 12).unwrap_or(0);
    let central_start = le32_at(&tail, eocd + 16).unwrap_or(0);
    // ZIP64 不"尽力读一读"：哨兵值把计数与偏移都替换掉了，硬读只会读出一堆假条目
    let zip64 = declared_entries == ZIP64_SENTINEL_U16
        || central_size == ZIP64_SENTINEL_U32
        || central_start == ZIP64_SENTINEL_U32
        || (eocd >= 20 && le32_at(&tail, eocd - 20) == Some(SIG_ZIP64_LOCATOR));
    if zip64 {
        return Ok(RawContainer {
            entries: Vec::new(),
            declared_entries: declared_entries as u64,
            zip64: true,
            total_unpacked_bytes: 0,
        });
    }
    if central_start as u64 + central_size as u64 > eocd_abs {
        return Err(structure("中央目录越出容器边界"));
    }
    let central = read_range(reader, central_start as u64, central_size as usize)?;

    let mut entries: Vec<RawEntry> = Vec::with_capacity(declared_entries as usize);
    let mut total: u64 = 0;
    let mut p = 0usize;
    for index in 0..declared_entries {
        let central_offset = central_start as u64 + p as u64;
        if p + CENTRAL_HEADER > central.len() {
            return Err(structure(format!("第 {index} 条中央目录记录越界")));
        }
        if le32_at(&central, p) != Some(SIG_CENTRAL) {
            return Err(structure(format!("第 {index} 条中央目录签名不符")));
        }
        let flags = le16_at(&central, p + 8).unwrap_or(0);
        let method = le16_at(&central, p + 10).unwrap_or(0);
        let crc32 = le32_at(&central, p + 16).unwrap_or(0);
        let compressed_size = le32_at(&central, p + 20).unwrap_or(0);
        let uncompressed_size = le32_at(&central, p + 24).unwrap_or(0);
        let name_len = le16_at(&central, p + 28).unwrap_or(0) as usize;
        let extra_len = le16_at(&central, p + 30).unwrap_or(0) as usize;
        let comment_len = le16_at(&central, p + 32).unwrap_or(0) as usize;
        let local_offset = le32_at(&central, p + 42).unwrap_or(0) as u64;
        // 变量段先核边界再取字节：越界的切片会静默截断，那是"读出来少几个字节"的假成功
        if p + CENTRAL_HEADER + name_len + extra_len + comment_len > central.len() {
            return Err(structure(format!("第 {index} 条中央目录记录跨过 EOCD")));
        }
        let raw_name = central[p + CENTRAL_HEADER..p + CENTRAL_HEADER + name_len].to_vec();
        // 名字先按 UTF-8 解一次交给路径闸判；判不出来（非 UTF-8）时保留 lossy 形态，
        // 由 `entry_name_encoding_problem` 用原始字节拒掉
        let name = String::from_utf8(raw_name.clone()).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
        total = total.saturating_add(u64::from(uncompressed_size));

        // 回到本地头核互指字段（这一条只有读侧能证伪，写侧看不见自己写出的字节）
        let local_matches_central = match read_range(reader, local_offset, LOCAL_HEADER) {
            Ok(local) => {
                let local_name = read_range(
                    reader,
                    local_offset + LOCAL_HEADER as u64,
                    le16_at(&local, 26).unwrap_or(0) as usize,
                )
                .unwrap_or_default();
                le32_at(&local, 0) == Some(SIG_LOCAL)
                    && local_name == raw_name
                    && le16_at(&local, 6) == Some(flags)
                    && le16_at(&local, 8) == Some(method)
                    && le32_at(&local, 14) == Some(crc32)
                    && le32_at(&local, 18) == Some(compressed_size)
                    && le32_at(&local, 22) == Some(uncompressed_size)
            }
            Err(_) => false,
        };
        entries.push(RawEntry {
            name,
            raw_name,
            flags,
            method,
            crc32,
            compressed_size,
            uncompressed_size,
            local_offset,
            central_offset,
            local_matches_central,
        });
        p += CENTRAL_HEADER + name_len + extra_len + comment_len;
    }
    if p != central.len() {
        return Err(structure("中央目录没有刚好走完"));
    }
    Ok(RawContainer {
        entries,
        declared_entries: declared_entries as u64,
        zip64: false,
        total_unpacked_bytes: total,
    })
}

/// 名字编码闸：NUL、非 UTF-8 原始字节、以及 **bit 11 缺失导致的 CP437 解码**。
/// `flags` 为 `None` 时（只有读器解码结果可用那条路）靠"解码名与原始字节是否同一串"判。
fn entry_name_encoding_problem(name: &str, raw: &[u8], flags: Option<u16>) -> Option<&'static str> {
    if raw.iter().any(|b| *b == 0) {
        return Some("entry-name-encoding");
    }
    if std::str::from_utf8(raw).is_err() {
        return Some("entry-name-encoding");
    }
    if name.as_bytes() != raw {
        return Some("entry-name-encoding");
    }
    if let Some(flag) = flags {
        if raw.iter().any(|b| *b >= 0x80) && flag & ZIP_FLAG_UTF8 == 0 {
            return Some("entry-name-encoding");
        }
    }
    None
}

/// 条目形态闸（`path-*` 那一族）：**判定顺序与拒绝码字面都是契约的一部分**——
/// 与契约侧 `packEntryPathProblem`（TS）以及共享表
/// `plugin-api/fixtures/zip-roundtrip/contract.json` 的 `entryNames` 逐字对齐
/// （前缀 `files/` 不在此判定：根 `pack.json` 也是合法条目，内容口径归 TS）。
/// 合法返回 `None`。
fn entry_path_problem(name: &str, max_depth: usize) -> Option<&'static str> {
    if name.is_empty() {
        return Some("path-empty-segment");
    }
    // NUL **先于形态判定**（与 TS `zipEntryContractProblem` 同序，共享表 `entryNames`
    // 的 `files\<NUL>a.txt` / `C:<NUL>a.txt` 两条钉的就是这个顺序）：它不是"路径段"问题，
    // 而是根本无法成为一个文件名——形态闸先跑就会给出另一套码。
    if name.as_bytes().contains(&0) {
        return Some("entry-name-encoding");
    }
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
    if segments.iter().any(|s| s.ends_with('.') || s.ends_with(' ')) {
        return Some("path-windows-unsafe");
    }
    if segments.len() > max_depth {
        return Some("path-depth");
    }
    None
}

/// 一条条目名的完整契约判定：**先形态后编码**（与 TS 侧 `zipEntryContractProblem` 同序）。
pub(crate) fn entry_contract_problem(
    name: &str,
    raw: &[u8],
    flags: Option<u16>,
    max_depth: usize,
) -> Option<&'static str> {
    match entry_path_problem(name, max_depth) {
        Some(code) => Some(code),
        None => entry_name_encoding_problem(name, raw, flags),
    }
}

/// 容器级契约判定（限额全部来自入参，本层不写死第二份真相）。
/// 拒在**动盘之前**：`extract_staging` 拿到 Err 就直接返回，一个字节都不会写出去。
fn container_contract_problem(
    container: &RawContainer,
    limits: &StagingLimits,
    archive_path: &Path,
) -> Result<(), String> {
    if container.zip64 {
        return Err("container-zip64：容器使用 ZIP64，平台解包器不接受".to_string());
    }
    if container.entries.len() as u64 != container.declared_entries {
        return Err(structure(format!(
            "EOCD 声明 {} 条，实际读出 {} 条",
            container.declared_entries,
            container.entries.len()
        )));
    }
    if container.entries.len() > limits.max_entries {
        return Err(format!(
            "entries-limit：条目数 {} 超过上限 {}",
            container.entries.len(),
            limits.max_entries
        ));
    }
    if container.total_unpacked_bytes > limits.max_unpacked_bytes {
        return Err(format!(
            "bytes-limit：声明解压总字节 {} 超过上限 {}",
            container.total_unpacked_bytes, limits.max_unpacked_bytes
        ));
    }
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for entry in &container.entries {
        let name = &entry.name;
        if let Some(code) = entry_contract_problem(name, &entry.raw_name, Some(entry.flags), limits.max_depth)
        {
            return Err(format!(
                "{code}：条目路径非法 {name:?}（容器 {}）",
                archive_path.display()
            ));
        }
        if entry.flags & FLAG_ENCRYPTED != 0 || entry.flags & FLAG_STRONG_ENCRYPTION != 0 {
            return Err(structure(format!("条目 {name:?} 是加密条目")));
        }
        if entry.flags & FLAG_DATA_DESCRIPTOR != 0 {
            return Err(structure(format!(
                "条目 {name:?} 用数据描述符携带尺寸（头里两个尺寸为 0）"
            )));
        }
        if entry.method != METHOD_STORE && entry.method != METHOD_DEFLATE {
            return Err(structure(format!(
                "条目 {name:?} 用了契约外的压缩法 {}",
                entry.method
            )));
        }
        if !entry.local_matches_central {
            return Err(structure(format!("条目 {name:?} 的本地头与中央目录不互指")));
        }
        // 去重键大小写折叠（与写允许域 `lowered_components` 同款 `to_lowercase` 口径）：
        // Windows 文件系统大小写不敏感，`A.erb` 与 `a.erb` 落盘互覆，清单还虚报条目数。
        // 这条闸**必须在中央目录原语上跑**：`zip` 读器按名字建索引（`read.rs:72` 的 IndexMap），
        // 同名条目在它那里被静默合并，`archive.len()` 已经是去过重的数——
        // 中央目录里的真条目数只有这里看得见（对拍用例 `exact-duplicate` 钉的就是这条）。
        if !seen.insert(name.to_lowercase()) {
            return Err(format!("entry-duplicate：条目路径重复 {name:?}"));
        }
    }
    Ok(())
}

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
#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StagingLimits {
    pub max_entries: usize,
    pub max_depth: usize,
    pub max_unpacked_bytes: u64,
}

/// 入参限额的**天花板 = 共享表 `limits`**（三个数各只许收紧、不许放宽）。
///
/// 为什么本层要管入参：`limits` 是 JS 递进来的，"限额由契约常量传入"这句话本身拦不住
/// 一个递 `maxEntries: 1_000_000` 的调用方（插件写错、或被后来的批当成"可调参数"）。
/// 天花板取自编译期内嵌的那张表 ⇒ 平台上限由**表**说话，TS 侧传的就是同一张表的三个数
/// （`plugin-api/src/market.ts` 的 `MARKET_MAX_*`，相等性钉在 zip-roundtrip 对拍里），
/// 生产链路零改动，只有"想放宽"的那条路当场红。
fn limits_ceiling_problem(limits: &StagingLimits) -> Option<String> {
    let ceiling = match zip_roundtrip_contract() {
        Ok(c) => &c.limits,
        Err(e) => return Some(format!("限额天花板不可用：{e}")),
    };
    if limits.max_entries > ceiling.max_entries {
        return Some(format!(
            "entries-limit：入参条目数上限 {} 超过共享表钉住的平台上限 {}",
            limits.max_entries, ceiling.max_entries
        ));
    }
    if limits.max_depth > ceiling.max_depth {
        return Some(format!(
            "path-depth：入参深度上限 {} 超过共享表钉住的平台上限 {}",
            limits.max_depth, ceiling.max_depth
        ));
    }
    if limits.max_unpacked_bytes > ceiling.max_unpacked_bytes {
        return Some(format!(
            "bytes-limit：入参解压字节上限 {} 超过共享表钉住的平台上限 {}",
            limits.max_unpacked_bytes, ceiling.max_unpacked_bytes
        ));
    }
    None
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

/// 暂存名/目标名共享的字面闸（字符集 + 长度 + 纯点名）。三个参数**只来自内嵌共享表**；
/// 表不可用（不可能，但不静默）时一律拒，不退回本地常量。
pub(crate) fn staging_component_problem(name: &str) -> Option<String> {
    let rule = match zip_roundtrip_contract() {
        Ok(c) => &c.container_name_rule,
        Err(e) => return Some(format!("容器命名闸不可用：{e}")),
    };
    if name.is_empty() || name.len() > rule.max_bytes {
        return Some(format!("名字长度必须在 1..={}", rule.max_bytes));
    }
    if !name.bytes().all(name_byte_allowed) {
        return Some(format!(
            "名字只允许 {}（拒分隔符、反斜杠、盘符、大写）：{name:?}",
            rule.charset
        ));
    }
    if rule.reject_pure_dots && name.bytes().all(|b| b == b'.') {
        return Some(format!("名字不能是纯点名：{name:?}"));
    }
    None
}

/// 容器名：共享字符集，且必须以表里那个后缀结尾（下载与解压**共用这一个名字**，
/// 两侧指向同一个文件 ⇒ 不存在"写 .bin 读 .zip"的两份真相）。
pub(crate) fn container_name_problem(name: &str) -> Option<String> {
    let rule = match zip_roundtrip_contract() {
        Ok(c) => &c.container_name_rule,
        Err(e) => return Some(format!("容器命名闸不可用：{e}")),
    };
    match staging_component_problem(name) {
        Some(p) => Some(p),
        None => {
            if !name.ends_with(rule.suffix.as_str()) || name.len() == rule.suffix.len() {
                Some(format!(
                    "容器名必须以 {} 结尾且主体非空：{name:?}",
                    rule.suffix
                ))
            } else {
                None
            }
        }
    }
}

/// 条目路径闸：与契约 `packEntryPathProblem` 同口径的**顺序与拒绝码字面**，
/// 两层的错误因此能逐字对上（前缀 `files/` 不在此判定——根 `pack.json` 也是合法条目，
/// 内容口径归 TS）。合法返回 `None`。

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
    // 它必须先于入参天花板闸：调用方若把限额放到硬顶（200k），这里的"声明 > 上界"才是
    // 第一判据（上游 F7 的两条端到端用例钉的就是这个顺序）。
    if let Some(problem) = declared_entries_problem(
        declared_entry_count(&mut file),
        limits.max_entries.min(MARKET_HARD_MAX_ENTRIES),
    ) {
        return Err(format!("market_extract: {problem}（容器 {}）", archive_path.display()));
    }
    // 天花板闸在动盘与打开容器之前：入参宽于共享表 = 直接拒（不是"按入参加宽"）
    if let Some(problem) = limits_ceiling_problem(limits) {
        return Err(format!("market_extract: {problem}"));
    }
    // **第一道闸走中央目录原语**（自己解析 EOCD / 中央目录 / 本地头互指），
    // 且必须在 `zip` 读器之前：读器按名字建索引会**静默去重**同名条目、
    // bit 11 缺失时按 CP437 解码名字，两条都把"往返不一致"藏在它自己那套读数里。
    // 拒了就一个字节都不许写出去（此时 `target` 还不存在，无需清扫）。
    // 解析失败（无 EOCD / 截断）沿用上游"容器不可读"字面，别让预检劫持 zip crate 的判词。
    let container = central_directory(&mut file)
        .map_err(|e| format!("容器不可读 {}: {e}", archive_path.display()))?;
    container_contract_problem(&container, limits, &archive_path)?;
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
        if let Some(code) = entry_contract_problem(
            &name,
            entry.name_raw(),
            None,
            limits.max_depth,
        ) {
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
