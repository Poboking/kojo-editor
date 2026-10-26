//! 归档容器守卫（ZIP 容器安全闸）——从 `market.rs` 抽出，行为逐字不变。
//!
//! 这一层只回答一件事：**这只 ZIP 能不能安全地落到别人的磁盘上**。它不认识网络、
//! 不认识发布、不认识市场语义：主机白名单 / 重定向 / 下载 / 上传 / 令牌全部留在
//! `market.rs`，这里只做容器原语与容器闸（签名解析、中央目录、条目路径 / 类型 / 数量、
//! 暂存与容器命名、解压限额与字节上限、流式解压与真落盘）。
//!
//! 规则的**唯一共享物**仍是那张表 `packages/plugin-api/fixtures/zip-roundtrip/contract.json`
//! （编译期内嵌）：写侧（TS `plugin-api/src/zip.ts`）与解包侧（本模块）各有一条测试
//! 消费同一张表与同一个容器夹具，谁漂谁红。启动器（内容包 / 存档备份 / 整合包）复用的
//! 就是这一份实现，不复制第二份。
//!
//! 迁移纪律：本文件内的函数签名、拒绝码字面、判定顺序全部与迁移前逐字相同；
//! `market.rs` 用 `pub(crate) use` 把这些名字重新导出，旧调用点（含 `market_tests.rs`）
//! 一行未改。

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};

/// 解压条目数硬顶。
const MARKET_HARD_MAX_ENTRIES: usize = 200_000;
/// 解压嵌套深度硬顶。
const MARKET_HARD_MAX_DEPTH: usize = 64;
/// 解压总字节硬顶（512 MiB）。
const MARKET_HARD_MAX_UNPACKED_BYTES: u64 = 512 * 1024 * 1024;

/// 解压：三个限额逐一夹进硬顶（炸弹闸不许被调用方解除）。
pub(crate) fn cap_staging_limits(limits: StagingLimits) -> StagingLimits {
    StagingLimits {
        max_entries: limits.max_entries.min(MARKET_HARD_MAX_ENTRIES),
        max_depth: limits.max_depth.min(MARKET_HARD_MAX_DEPTH),
        max_unpacked_bytes: limits.max_unpacked_bytes.min(MARKET_HARD_MAX_UNPACKED_BYTES),
    }
}

/// 暂存名字符集：小写字母数字与 `.` `_` `-`，长度与后缀由**共享表**给，且不能是纯点名。
/// 这两个数**过去是本层私藏的两个 `const`**（TS 侧 `zip.ts` 另有一份同值字面量，"同一套规则"
/// 只有注释担保）；现在本层读的就是表里那一段 —— 表漂一字节即红，见下面 `zip_roundtrip_contract`。


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

/// unix 文件类型位（zip 的 `external_attr` 高 16 位）。
const S_IFMT: u32 = 0o170000;
const S_IFREG: u32 = 0o100000;

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

/// 逐块累计体积闸：**下载与取文本同一份**（超限即中止，由调用方清半截）。
pub(crate) fn advance_byte_cap(received: u64, chunk: usize, max_bytes: u64) -> Result<u64, String> {
    let total = received.saturating_add(chunk as u64);
    if total > max_bytes {
        return Err(format!("响应体累计 {total} 字节超过上限 {max_bytes}"));
    }
    Ok(total)
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
