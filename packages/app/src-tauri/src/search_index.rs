//! 检索索引（MCP-PERF-S1）：per-file trigram 指纹 + 行偏移表，随进程内字节缓存同生命周期。
//!
//! 定位与红线：索引**只是预筛**——"指纹里没有 ⇒ 文本里必没有"的必要条件判定，
//! 漏报零容忍：最终命中仍走 `lib.rs` 现有 matcher（解码后逐字判），本模块说"不要"的文件
//! 必须真的一个命中都没有。因此：
//! - 指纹基于**原始字节**滑 3 字节窗（不解码、不归一），查询侧只许用"命中处必然原样出现
//!   的字节串"编窗（大小写不敏感 / 宽度折叠 / 正则语法都按保守侧处理，宁可全扫不可漏）；
//! - utf-16（BOM 命中的 utf16ish 文件）字节被 0 隔开，字节窗与文本不等价 ⇒ 永不参与筛。
//!
//! 失效：条目键 = (len, mtime_ns)，与 `SearchTextCache` 同源同口径；对不上就现场重建。

/// 位图位数（8KB/文件：判据 8–16KB 量级的下沿；4258 文件全语料 ≈ 34MB，远低于字节缓存预算）。
const BLOOM_BITS: u32 = 65_536;
/// 探针数（Kirsch–Mitzenmacher：bit_i = h1 + i·h2）。
const BLOOM_K: usize = 4;
/// 饱和闸：新置位数过半 ⇒ 指纹不再可信（假阳性飙升），整条降级为"不筛"（安全侧）。
const BLOOM_SATURATE_BITS: u32 = BLOOM_BITS / 2;
/// 行偏移表准入上限：大文件行偏移动辄上 MB，建表收益（免切行）不值这个内存。
const LINE_MAP_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// UTF-8 BOM（判定 utf8_no_bom 用：行偏移表是字节层前缀和，BOM 会让"字节偏移≠文本偏移"）。
const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// 3 字节窗 → 4 个位探针（splitmix64 终混 + Kirsch–Mitzenmacher 双散布）。
/// 窗按 u24 小端读进 u32 再终混：单字节翻转扩散到全部 64 位。
fn window_probes(w: [u8; 3]) -> [u32; BLOOM_K] {
    let mut z = u32::from_le_bytes([w[0], w[1], w[2], 0]) as u64;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    let h1 = z;
    let h2 = z.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1; // 奇数步长 ⇒ 模周期满
    let mut out = [0u32; BLOOM_K];
    for (i, p) in out.iter_mut().enumerate() {
        *p = (h1.wrapping_add((i as u64).wrapping_mul(h2)) % BLOOM_BITS as u64) as u32;
    }
    out
}

/// per-file 指纹：3 字节窗 Bloom 位图 + 行偏移前缀和。
pub struct FileFingerprint {
    bits: Vec<u64>,
    saturated: bool,
    /// 行起点前缀和（字节偏移；`offsets[k]` = 第 k+1 行的起点，首项恒 0）。
    /// 只对"无 BOM 合法 UTF-8"的文件存在——此时解码文本与原始字节逐字节相同，
    /// 字节层行号 = 文本层行号，切片迭代才能替代 `split('\n')`。
    line_offsets: Option<Vec<u32>>,
    utf8_no_bom: bool,
    /// 整份字节是合法 UTF-8（**含** BOM 文件：解码只剥前缀，命中字节仍在余部）。
    /// 查询侧可筛半径的另一半判据（`ascii_radius` 为 false 时只许筛这类文件）——
    /// 建指纹时 `from_utf8` 已经付过一趟，存下来让调用方零成本复用。
    utf8_valid: bool,
}

impl FileFingerprint {
    /// 从原始字节建指纹（不解码）。`bytes` 至少 3 字节才有窗；不足 ⇒ 空指纹（必拒一切窗，
    /// 与"文件里不可能有 ≥3 字节命中串"一致——空指纹对短文件也是正确判据）。
    pub fn build(bytes: &[u8]) -> FileFingerprint {
        let mut bits = vec![0u64; (BLOOM_BITS / 64) as usize];
        let mut distinct = 0u32;
        let mut saturated = false;
        if bytes.len() >= 3 {
            'outer: for w in bytes.windows(3) {
                let probes = window_probes([w[0], w[1], w[2]]);
                let mut fresh = false;
                for p in probes {
                    let word = &mut bits[(p / 64) as usize];
                    let mask = 1u64 << (p % 64);
                    if *word & mask == 0 {
                        *word |= mask;
                        fresh = true;
                    }
                }
                if fresh {
                    distinct += 1;
                    if distinct > BLOOM_SATURATE_BITS {
                        saturated = true;
                        break 'outer;
                    }
                }
            }
        }
        let utf8_valid = std::str::from_utf8(bytes).is_ok();
        let utf8_no_bom = utf8_valid && !bytes.starts_with(&UTF8_BOM);
        let line_offsets = if utf8_no_bom && (bytes.len() as u64) <= LINE_MAP_MAX_BYTES {
            let mut offs: Vec<u32> = Vec::with_capacity(4096);
            offs.push(0u32);
            for (i, b) in bytes.iter().enumerate() {
                if *b == b'\n' {
                    offs.push((i + 1) as u32);
                }
            }
            Some(offs)
        } else {
            None
        };
        FileFingerprint { bits, saturated, line_offsets, utf8_no_bom, utf8_valid }
    }

    pub fn saturated(&self) -> bool {
        self.saturated
    }

    pub fn utf8_no_bom(&self) -> bool {
        self.utf8_no_bom
    }

    /// 整份字节是合法 UTF-8（含 BOM 文件）。查询侧"只许筛合法 UTF-8"的半径判据用。
    pub fn utf8_valid(&self) -> bool {
        self.utf8_valid
    }

    /// 行偏移前缀和（字节偏移，首项 0）。仅 utf8_no_bom 且 ≤2MB 的文件存在。
    pub fn line_offsets(&self) -> Option<&[u32]> {
        self.line_offsets.as_deref()
    }

    /// 单个 3 字节窗是否确定不在指纹里（任一探针位为 0 ⇒ 不在）。
    fn window_absent(&self, probes: &[u32; BLOOM_K]) -> bool {
        probes.iter().any(|p| self.bits[(p / 64) as usize] & (1u64 << (p % 64)) == 0)
    }
}

/// 查询侧编译产物：一组"必在窗"。每个窗 = 查询命中处**必然原样出现**的一个字节串的
/// 宽度/转义变体枚举；判定 = 全部窗都"存在某变体、其全部子窗探针都置位"才放行，否则拒。
pub struct TrigramNeedle {
    /// true = 所有窗字节纯 ASCII（对所有 ASCII 兼容族编码成立——ASCII 字节在
    /// utf-8/shift_jis/gbk/big5 里都逐字节透传）；false = 只对合法 UTF-8 文件成立
    /// （非 ASCII 的 UTF-8 字节形在遗留族里不同，拿去筛就是漏报）。
    pub ascii_radius: bool,
    windows: Vec<NeedleWindow>,
}

struct NeedleWindow {
    /// [变体][子窗] → 探针。变体 = 该窗字节串的宽度等价形态枚举（正则段恒 1 个）；
    /// 子窗 = 变体字节串的连续 3 字节窗（串长 3 ⇒ 1 个；更长取首尾两个，采样即可：
    /// 命中处这些子窗全部存在，漏一个采样窗不破坏必要条件）。
    alternatives: Vec<Vec<[u32; BLOOM_K]>>,
}

impl TrigramNeedle {
    /// 判拒：**任一**窗的所有变体都缺子窗 ⇒ 该窗字节串必不在 ⇒ 文件必无命中。
    /// 命中必须同时含每一个窗（各窗是查询不同区段的必要条件），所以缺**任一**窗就够拒；
    /// 用 `.all()` 会弱化成"窗全缺才拒"，筛选率大半白送（NEEDLE_ABC 打到只含前半的
    /// 文件上就筛不动了）。
    ///
    /// 饱和指纹**永不判拒**：饱和 = 建图中途弃窗（distinct 过半即 break），余下窗没进位图，
    /// "位图说不在"不再成立——把降级闸内置在这一层而不是靠调用方记得查 `saturated()`，
    /// 误用即漏报的口子从根上堵死。
    pub(crate) fn rejected_by(&self, fp: &FileFingerprint) -> bool {
        if fp.saturated {
            return false;
        }
        self.windows.iter().any(|w| {
            w.alternatives.iter().all(|alt| alt.iter().any(|p| fp.window_absent(p)))
        })
    }
}

/// 字符的**宽度折叠等价类**（与 `lib.rs::fold_width` 同一张表）：`（` ↔ `(`、`＿` ↔ `_`。
/// 返回 (半角形, 全角形)；单形字符两者相同。
fn width_variants(ch: char) -> (char, char) {
    let half = crate::fold_width(ch);
    let full = crate::unfold_width(half);
    (half, full)
}

/// 大小写不敏感通道的准入：该字符在简单大小写折叠下**无变体**（fold 到自身）。
/// 有变体（ASCII 字母、U+212A 等）⇒ `(?i)` 模式能匹配到不同字节形 ⇒ 字节窗不再必要 ⇒ 放弃。
fn fold_stable(ch: char) -> bool {
    let lower: Vec<char> = ch.to_lowercase().collect();
    let upper: Vec<char> = ch.to_uppercase().collect();
    lower.as_slice() == [ch] && upper.as_slice() == [ch]
}

/// 单字符的查询变体集（字面量通道）：宽度折叠的两形态 ∩ 大小写折叠准入。
/// 返回 None = 该字符在任何通道下都编不出"命中处必然出现"的字节窗 ⇒ 整查询不筛。
fn char_query_variants(ch: char, case_sensitive: bool) -> Option<Vec<char>> {
    let (half, full) = width_variants(ch);
    let mut forms: Vec<char> = if half == full { vec![half] } else { vec![half, full] };
    if !case_sensitive {
        // 任一宽度形态的 fold 不稳定 ⇒ 命中可能落在不同字节形上 ⇒ 整字符放弃（保守）
        if !forms.iter().all(|f| fold_stable(*f)) {
            return None;
        }
    }
    forms.dedup();
    Some(forms)
}

/// 字面量查询 → 必在窗（`whole_word` 不参与：全词判据在命中**之后**过滤，命中本身
/// 必然包含字面字节串，预筛不漏）。准入 = 查询 ≥3 **字节**（判据口径：字面量 ≥3 字节；
/// 「口上」2 字符 6 字节也编得出 3 字节窗）。更短 ⇒ None（不筛，全扫）。
fn literal_needles(query: &str, case_sensitive: bool) -> Option<TrigramNeedle> {
    if query.as_bytes().len() < 3 {
        return None;
    }
    let chars: Vec<char> = query.chars().collect();
    // 窗位按**字符**切（宽度变体在字符级枚举）：3 字符窗信息量最大；查询本身 <3 字符时
    // 整查询就是一个窗（字节串 ≥3 已由准入保证，取其首尾 3 字节子窗探针）
    let n = chars.len();
    let mut spans: Vec<(usize, usize)> = if n >= 3 { vec![(0, 3)] } else { vec![(0, n)] };
    if n >= 3 {
        let tail = (n - 3, n);
        if !spans.contains(&tail) {
            spans.push(tail);
        }
    }
    let mut ascii_radius = true;
    let mut windows = Vec::with_capacity(spans.len());
    for (s, e) in spans {
        let slice = &chars[s..e];
        let mut per_char: Vec<Vec<char>> = Vec::with_capacity(slice.len());
        for c in slice {
            let v = char_query_variants(*c, case_sensitive)?;
            if v.iter().any(|f| !f.is_ascii()) {
                ascii_radius = false;
            }
            per_char.push(v);
        }
        // 变体组合 = 窗内字符笛卡尔积（≤8）；每组合拼字节串，取其连续 3 字节子窗探针
        let mut alternatives = Vec::new();
        for combo in cartesian(&per_char) {
            let mut bytes = Vec::with_capacity(9);
            for ch in &combo {
                let mut buf = [0u8; 4];
                bytes.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
            }
            let sub: Vec<[u8; 3]> = if bytes.len() == 3 {
                vec![[bytes[0], bytes[1], bytes[2]]]
            } else {
                vec![
                    [bytes[0], bytes[1], bytes[2]],
                    [bytes[bytes.len() - 3], bytes[bytes.len() - 2], bytes[bytes.len() - 1]],
                ]
            };
            alternatives.push(sub.iter().map(|w| window_probes(*w)).collect::<Vec<_>>());
        }
        windows.push(NeedleWindow { alternatives });
    }
    Some(TrigramNeedle { ascii_radius, windows })
}

/// 逐字符变体集的笛卡尔积（窗内 1–3 个字符，每字符 1–2 形态 ⇒ 最多 8 组合）。
fn cartesian(per_char: &[Vec<char>]) -> Vec<Vec<char>> {
    let mut out: Vec<Vec<char>> = vec![Vec::new()];
    for forms in per_char {
        let mut next = Vec::new();
        for prefix in &out {
            for f in forms {
                let mut c = prefix.clone();
                c.push(*f);
                next.push(c);
            }
        }
        out = next;
    }
    out
}

/* ---------------------- 正则的必选字面量抽取（轻量手写版） ---------------------- */
//
// regex-syntax 不在本仓依赖面（Cargo.toml 无直接依赖，间接依赖不许 use）⇒ 按判据手写
// 轻量抽取。原则：**只抽铁定必选的字节**，凡语法上有任何一丝"这段可能不出现"的形状
// （分支、量词、字符类、非字面转义、内联 flag）一律断开或整体放弃——抽出错的代价是
// 漏报，宁可不筛。

/// 正则模式 → 最长的**必选字面字节段**（≥3 字节才 Some）。
/// 保守规则：`|` 整体放弃（分支两侧都可选）；`(?` 放弃（内联 flag / 命名组）；
/// `\d\w\s\x\u\p\b\A\z` 等非字面转义放弃；`{` 放弃（量词解析不值得为它冒险）；
/// 字符类整段跳过（断点）；`*`/`?` 把前一字面字节除名（可选项不必在）；`+` 保留一个实例。
fn extract_longest_regex_literal(pattern: &str) -> Option<Vec<u8>> {
    let b = pattern.as_bytes();
    let mut i = 0usize;
    let mut cur: Vec<u8> = Vec::new();
    let mut best: Vec<u8> = Vec::new();
    let mut after_quant = false; // 上一 token 是量词 ⇒ 下一个 '?' 是 lazy 标记，不是量词
    macro_rules! flush {
        () => {
            if cur.len() > best.len() {
                best = std::mem::take(&mut cur);
            } else {
                cur.clear();
            }
        };
    }
    while i < b.len() {
        match b[i] {
            b'\\' => {
                if i + 1 >= b.len() {
                    return None; // 尾反斜杠 = 非法模式（matcher 那头也会报错）
                }
                let e = b[i + 1];
                // 标点转义 = 字面字节（"转义后必出该字节"）；显式控制符同理
                const LITERAL_ESCAPES: &[u8] =
                    b".+*?()[]{}|^$-/\"' #<>=!:,;%&~@_ \t";
                // 字符类族（\d \w \s 及其大写）与词/串锚（\b \B \A \z \Z）：
                // 该位置字节任意 ⇒ 断开累积，但**前后段仍各是必选字面段**（K\d+_MSG 的
                // _MSG 必在）——断开安全且保住大部分正则查询的筛选率。
                const CLASS_ESCAPES: &[u8] = b"dDwWsSbBAZ";
                if e == b'n' {
                    cur.push(b'\n');
                    after_quant = false;
                } else if e == b'r' {
                    cur.push(b'\r');
                    after_quant = false;
                } else if LITERAL_ESCAPES.contains(&e) {
                    cur.push(e);
                    after_quant = false;
                } else if CLASS_ESCAPES.contains(&e) {
                    flush!();
                    after_quant = false;
                } else {
                    // \x \u \p \P \Q \E 及其余未知字母转义：形态复杂（\x{41} 尾随花括号
                    // 会被误当字面）⇒ 整体放弃，抽错的代价是漏报
                    return None;
                }
                i += 2;
            }
            b'(' => {
                if i + 1 < b.len() && b[i + 1] == b'?' {
                    return None; // (?i) (?:...) (?<name>) 全部放弃
                }
                flush!();
                after_quant = false;
                i += 1;
            }
            b')' | b'^' | b'$' | b'.' => {
                flush!();
                after_quant = false;
                i += 1;
            }
            b'|' => return None, // 分支让两侧都变可选 ⇒ 抽出的"必选"不可信
            b'[' => {
                // 字符类整段跳过（断点）：[ 首位 ] 字面、[^ 前缀、\ 转义都按 regex 语法处理
                let mut j = i + 1;
                if j < b.len() && b[j] == b'^' {
                    j += 1;
                }
                if j < b.len() && b[j] == b']' {
                    j += 1;
                }
                while j < b.len() && b[j] != b']' {
                    if b[j] == b'\\' {
                        j += 1;
                        if j >= b.len() {
                            return None;
                        }
                    }
                    j += 1;
                }
                if j >= b.len() {
                    return None; // 未闭合 = 非法模式
                }
                flush!();
                after_quant = false;
                i = j + 1;
            }
            b'{' => return None, // {m,n} 不解析（保守）
            b'*' | b'+' | b'?' => {
                if after_quant {
                    if b[i] == b'?' {
                        after_quant = false; // lazy 标记：跳过
                        i += 1;
                        continue;
                    }
                    return None; // 量词叠量词 = 语法错（保守）
                }
                if b[i] == b'?' || b[i] == b'*' {
                    cur.pop(); // 可选：前一字节从必选里除名
                    flush!();
                } // '+'：至少一次 ⇒ 保留一个实例，继续累积
                after_quant = true;
                i += 1;
            }
            c => {
                cur.push(c);
                after_quant = false;
                i += 1;
            }
        }
    }
    flush!();
    (best.len() >= 3).then_some(best)
}

/// 查询 → 必在窗编译入口（None = 不筛，走全扫）。
/// `case_sensitive=false` 时：字面量走"fold 稳定字符"通道（中文/假名/数字/符号照常筛，
/// ASCII 字母放弃）；正则一律不筛（`(?i)` 的字节形不可枚举，保守全扫）。
pub fn trigram_needles(query: &str, is_regex: bool, case_sensitive: bool) -> Option<TrigramNeedle> {
    if is_regex {
        if !case_sensitive {
            return None;
        }
        let lit = extract_longest_regex_literal(query)?;
        let probes: Vec<[u32; BLOOM_K]> = if lit.len() == 3 {
            vec![window_probes([lit[0], lit[1], lit[2]])]
        } else {
            vec![
                window_probes([lit[0], lit[1], lit[2]]),
                window_probes([lit[lit.len() - 3], lit[lit.len() - 2], lit[lit.len() - 1]]),
            ]
        };
        let ascii_radius = lit.iter().all(|b| b.is_ascii());
        return Some(TrigramNeedle {
            ascii_radius,
            windows: vec![NeedleWindow { alternatives: vec![probes] }],
        });
    }
    literal_needles(query, case_sensitive)
}

/* ------------------------------ 进程内索引缓存 ------------------------------ */

/// 索引条目：判定键与 `SearchTextCache` 同源（len + mtime_ns 必须与磁盘现状一致）。
struct IndexedEntry {
    len: u64,
    mtime_ns: u64,
    fp: std::sync::Arc<FileFingerprint>,
}

#[derive(Default)]
struct CorpusBucket {
    files: std::collections::HashMap<std::path::PathBuf, IndexedEntry>,
}

/// 跨查询的指纹缓存：corpus 键（`corpus_cache_key`）分桶，逐文件 (len, mtime) 对账。
/// 生命周期与 `SearchTextCache` 相同：进程内、跨检索；不落盘（现有字节缓存也不落盘，
/// 指纹建造成本是单趟 O(n) 字节滑窗，冷启动一拍内摊完）。
#[derive(Default)]
pub struct SearchIndexCache {
    corpora: std::sync::Mutex<std::collections::HashMap<String, CorpusBucket>>,
}

impl SearchIndexCache {
    /// 对账 + 取指纹：键对上 ⇒ 返回现成条目；对不上/没有 ⇒ 从 `bytes` 现场建并回填。
    /// 建（O(n) 字节滑窗，大文件可到几十 ms）在**锁外**做——检索是 8 线程并行的，
    /// 冷启动那一轮谁都不该在锁里等别人建图；回填前双检（别的线程可能已插同键条目，
    /// 同字节建出的指纹相同，取谁的都一样，取现成的省一份内存）。
    pub fn ensure(
        &self,
        corpus: &str,
        path: &std::path::Path,
        len: u64,
        mtime_ns: u64,
        bytes: &[u8],
    ) -> std::sync::Arc<FileFingerprint> {
        {
            let g = self.corpora.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(fp) = g
                .get(corpus)
                .and_then(|b| b.files.get(path))
                .filter(|e| e.len == len && e.mtime_ns == mtime_ns)
                .map(|e| e.fp.clone())
            {
                return fp;
            }
        }
        let fp = std::sync::Arc::new(FileFingerprint::build(bytes));
        let mut g = self.corpora.lock().unwrap_or_else(|e| e.into_inner());
        let bucket = g.entry(corpus.to_string()).or_default();
        if let Some(e) = bucket
            .files
            .get(path)
            .filter(|e| e.len == len && e.mtime_ns == mtime_ns)
        {
            return e.fp.clone();
        }
        bucket.files.insert(
            path.to_path_buf(),
            IndexedEntry { len, mtime_ns, fp: fp.clone() },
        );
        fp
    }

    #[cfg(test)]
    pub(crate) fn entry_count(&self, corpus: &str) -> usize {
        self.corpora
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(corpus)
            .map(|b| b.files.len())
            .unwrap_or(0)
    }
}

/* ---------------------------------- 判据 ---------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    /// 指纹判定方向的零漏报底座：包含某字节串的文本，其全部 3 字节窗必置位
    /// ⇒ 任何"命中必含的窗"都不可被拒（漏报零容忍的第一道闸）。
    #[test]
    fn fingerprint_never_rejects_text_containing_the_window() {
        let texts: Vec<Vec<u8>> = vec![
            "口上：テスト".as_bytes().to_vec(),
            b"abcabcabc".to_vec(),
            b"K12_MESSAGE_x99".to_vec(),
            "mixed ascii ａｎｄ 全角\nwith CRLF\r\nand 日本語".as_bytes().to_vec(),
            vec![0xFF, 0xFE, 0x00, 0x41], // 非 UTF-8 字节也要能建（原始字节，不解码）
        ];
        for t in texts {
            let fp = FileFingerprint::build(&t);
            for w in t.windows(3) {
                let probes = window_probes([w[0], w[1], w[2]]);
                assert!(
                    !fp.window_absent(&probes),
                    "窗 {w:?} 在文本里却被判不在 = 漏报事故"
                );
            }
        }
    }

    #[test]
    fn fingerprint_saturates_on_high_entropy_input() {
        // 伪随机高熵字节：独特窗远超饱和闸 ⇒ 必须降级 saturated（查询侧不再筛它）
        let mut bytes = Vec::with_capacity(1 << 20);
        let mut x: u64 = 0x243F_6A88_85A3_08D3;
        for _ in 0..(1 << 20) {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            bytes.push((x & 0xFF) as u8);
        }
        let fp = FileFingerprint::build(&bytes);
        assert!(fp.saturated(), "高熵大文件必须饱和降级，否则假阳性把筛选率吃光");
        // 饱和 = 建图中途弃窗 ⇒ 位图不完整 ⇒ 判拒必须整体停用（把真命中的文件拒掉 = 漏报事故）
        let needle = trigram_needles("abc", false, true).unwrap();
        let mut with_needle = bytes.clone();
        with_needle.extend_from_slice(b"xxabcxx");
        let fp2 = FileFingerprint::build(&with_needle);
        assert!(fp2.saturated(), "夹具本身必须饱和，否则这条没钉住降级闸");
        assert!(
            !needle.rejected_by(&fp2),
            "饱和指纹永不判拒：文本里明明有 abc，拒了就是漏报"
        );
    }

    #[test]
    fn literal_needles_reject_absent_and_accept_present() {
        // 中文 3 字符查询：窗 = 前后两个 3 字符窗
        let needle = trigram_needles("口上デー", false, true).expect("3 字符该编出窗");
        let hit = FileFingerprint::build("これは口上デーです".as_bytes());
        assert!(!needle.rejected_by(&hit), "包含查询的文本不许被拒");
        let miss = FileFingerprint::build("全然違う内容のファイル".as_bytes());
        assert!(needle.rejected_by(&miss), "不含查询的字节串该被拒（必要条件成立）");

        // ASCII 长查询：前后两窗都要在。半径注意：`unfold_width` 给每个 ASCII 可见字符
        // 都折出全角形（Ｎ ∈ 变体集）⇒ 变体非 ASCII ⇒ 半径收窄到合法 UTF-8 文件——
        // 这正是 byte_prefilter「含可折字符 ⇒ 遗留族字节形不同 ⇒ 只筛 UTF-8」的同一条结论。
        let n2 = trigram_needles("NEEDLE_ABC", false, true).unwrap();
        assert!(!n2.ascii_radius, "含可折字符（ASCII 可见字符全可折）⇒ 只许筛合法 UTF-8 文件");
        let hit2 = FileFingerprint::build(b"xxNEEDLE_ABCyy");
        assert!(!n2.rejected_by(&hit2));
        let miss2 = FileFingerprint::build(b"NEEDLE_ABZy");
        assert!(
            n2.rejected_by(&miss2),
            "尾窗 ABC 缺失 ⇒ 尽管前窗在也必须拒（两窗与判定）"
        );

        // ≥3 字节的短字符查询（判据口径是字节不是字符）：2 字符 6 字节照常编窗
        let n3 = trigram_needles("口上", false, true).expect("6 字节该编出窗");
        let hit3 = FileFingerprint::build("これは口上です".as_bytes());
        assert!(!n3.rejected_by(&hit3));
        let miss3 = FileFingerprint::build("別の内容".as_bytes());
        assert!(n3.rejected_by(&miss3));
    }

    #[test]
    fn width_folded_queries_enumerate_both_forms() {
        // 半角查询可命中全角正文：窗必须枚举宽度等价形态（漏了就是漏报）
        let needle = trigram_needles("abc", false, true).expect("3 字符");
        let fullwidth = FileFingerprint::build("ｘｙｚａｂｃｘｙ".as_bytes());
        assert!(!needle.rejected_by(&fullwidth), "全角正文被半角查询命中 ⇒ 预筛不许拒它");
        let absent = FileFingerprint::build(" completely unrelated bytes ".as_bytes());
        assert!(needle.rejected_by(&absent));
    }

    #[test]
    fn case_insensitive_cjk_passes_but_ascii_letters_do_not() {
        // 中文查询大小写不敏感：字符 fold 稳定 ⇒ 照常编窗（主收益路径）
        let zh = trigram_needles("口上デー", false, false).expect("fold 稳定字符该有窗");
        let hit = FileFingerprint::build("口上デー Walpurgis".as_bytes());
        assert!(!zh.rejected_by(&hit));
        // ASCII 字母 fold 不稳定 ⇒ 不筛（命中可能是别的字节形）
        assert!(trigram_needles("abc", false, false).is_none());
        // 混合：任一字符含 fold 不稳定成员 ⇒ 整查询放弃
        assert!(trigram_needles("口ab", false, false).is_none());
    }

    #[test]
    fn short_queries_and_regex_flags_stay_unindexed() {
        assert!(trigram_needles("ab", false, true).is_none(), "<3 字节编不出窗");
        assert!(trigram_needles("", false, true).is_none());
        // 正则 + 大小写不敏感：保守不筛
        assert!(trigram_needles("K\\d+_MSG", true, false).is_none());
        // 内联 flag：放弃
        assert!(trigram_needles("(?i)abc", true, true).is_none());
        // 分支：放弃
        assert!(trigram_needles("abc|xyz", true, true).is_none());
        // 非字面转义：放弃
        assert!(trigram_needles(r"\d+", true, true).is_none());
    }

    #[test]
    fn regex_literal_extraction_picks_the_safe_segment() {
        // `\d` 断开 ⇒ 前段 "K" 1 字节、后段 "_MSG" 4 字节 ⇒ 取后者
        let seg = extract_longest_regex_literal(r"K\d+_MSG").unwrap();
        assert_eq!(seg, b"_MSG");
        let needle = trigram_needles(r"K\d+_MSG", true, true).unwrap();
        // 夹具必须是**真命中**（K\d+_MSG 真匹配的文本）："K12_MESSAGE_here" 里没有
        // `_MSG` 子串（_ME…），正则根本不命中，拿它当 hit 是自欺。
        let hit = FileFingerprint::build(b"K12_MSG_here");
        assert!(!needle.rejected_by(&hit), "正则命中处必含字面段 _MSG");
        let miss = FileFingerprint::build(b"K12_OTHER_here");
        assert!(needle.rejected_by(&miss));
        // MESSAGE 这种"前缀像、字面段不在"的文本正则也不命中 ⇒ 必须拒（尾窗 MSG 缺）
        assert!(
            needle.rejected_by(&FileFingerprint::build(b"K12_MESSAGE_here")),
            "字面段 _MSG 不在（_ME…）⇒ 正则无命中 ⇒ 必拒"
        );

        // `?` 把前一字节除名：NEEDLE? = "NEEDL" + 可选 E ⇒ 必选段 = "NEEDL"
        let seg2 = extract_longest_regex_literal(r"NEEDLE?").unwrap();
        assert_eq!(seg2, b"NEEDL");
        // `+` 保留实例：a+bc → 段 abc（a 必在至少一次）
        assert_eq!(extract_longest_regex_literal(r"a+bc").unwrap(), b"abc");
        // lazy 标记：a+?bc → '+' 保留 a、lazy '?' 跳过 ⇒ 段 abc
        assert_eq!(extract_longest_regex_literal(r"a+?bc").unwrap(), b"abc");
        // 锚点与组是断点：^(abc)$ → 段 abc
        assert_eq!(extract_longest_regex_literal(r"^(abc)$").unwrap(), b"abc");
        // 字符类跳过：a[xy]bcd → 段 bcd
        assert_eq!(extract_longest_regex_literal(r"a[xy]bcd").unwrap(), b"bcd");
        // 转义标点是字面：a\.b → 段 a.b（3 字节）
        assert_eq!(extract_longest_regex_literal(r"a\.b").unwrap(), b"a.b");
        // `{` 保守放弃
        assert!(extract_longest_regex_literal(r"a{2,3}b").is_none());
        // 未闭合类
        assert!(extract_longest_regex_literal(r"a[xy").is_none());
    }

    #[test]
    fn regex_extraction_never_accepts_unsafe_patterns() {
        // 这些形态里"抽出的段可能不在命中处" ⇒ 必须整体放弃（漏报零容忍）
        for pat in [
            r"a|bc",      // 分支：bc 可不出现
            r"(?i)abc",   // 大小写折叠改字节形
            r"a?bc",      // a 可选——但 bc 必在！段 bc 2 字节 <3 ⇒ None
            r"[abc]def",  // 类跳过后段 def 必在 ⇒ 实际抽得到，不该 None
        ] {
            let got = extract_longest_regex_literal(pat);
            if pat == r"[abc]def" {
                assert_eq!(got.unwrap(), b"def");
            } else {
                assert!(got.is_none(), "{pat} 不该抽出任何段，却得了 {got:?}");
            }
        }
    }

    /// **抽取安全性质（对拍闸）**：预筛拒掉的文件，matcher 必须（在可筛半径内）零命中。
    /// 随机模式 × 随机文本 × 有/无索引两条路径逐字同产出 —— 这条红了就是漏报事故。
    #[test]
    fn indexed_scan_never_loses_matches_versus_unindexed() {
        // 伪随机但可复现：固定种子 LCG
        let mut seed: u64 = 0x2026_1106;
        let mut next = move || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) as usize
        };
        let alphabet: [&str; 8] = ["abc", "口上", "TEST", "12", "＿", "デ", "z", "々"];
        let dir = std::env::temp_dir().join(format!("kojo-idx-prop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut paths = Vec::new();
        for f in 0..40 {
            let mut body = String::new();
            for _ in 0..(50 + next() % 300) {
                body.push_str(alphabet[next() % alphabet.len()]);
                if next() % 7 == 0 {
                    body.push('\n');
                }
            }
            let p = dir.join(format!("f{f:02}.erb"));
            std::fs::write(&p, body.as_bytes()).unwrap();
            paths.push(p);
        }
        let index = SearchIndexCache::default();
        for q in ["口上", "abc", "TEST12", "＿デz", "zzz", "abc口上TEST"] {
            let needle = trigram_needles(q, false, true).expect("非空查询该有窗");
            for p in &paths {
                let bytes = std::fs::read(p).unwrap();
                let fp = index.ensure("prop", p, bytes.len() as u64, 0, &bytes);
                let rejected = needle.rejected_by(&fp);
                let m = crate::build_matcher(q, false, true, false).unwrap();
                let (hits, _) = crate::scan_hits(&decode(&bytes), &m, 5000, true);
                // 断言只在**可筛半径内**成立（生产路径同判）：半径外（如中文查询打到
                // 遗留族字节上）预筛根本不参与，"拒了"不构成漏报
                if rejected && (needle.ascii_radius || fp.utf8_no_bom()) {
                    assert!(hits.is_empty(), "文件 {} 被预筛拒掉却有 {} 条命中 = 漏报", p.display(), hits.len());
                }
            }
        }
        assert!(index.entry_count("prop") == 40, "40 份文件都该进了索引");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 解码 helper：性质测试里 matcher 在解码文本上跑，而指纹在字节上跑——
    /// 合法 UTF-8 时两者逐字节相同（这正是可筛半径的定义）。
    fn decode(bytes: &[u8]) -> std::borrow::Cow<'_, str> {
        match std::str::from_utf8(bytes) {
            Ok(s) => std::borrow::Cow::Borrowed(s),
            Err(_) => {
                let (s, _, _) = encoding_rs::SHIFT_JIS.decode(bytes);
                s
            }
        }
    }

    #[test]
    fn line_offsets_are_prefix_sums_and_utf8_only() {
        let fp = FileFingerprint::build("一行\n二行\n三行".as_bytes());
        let offs = fp.line_offsets().unwrap();
        assert_eq!(offs, &[0, 7, 14], "每行起点 = 前一行 \\n 之后（UTF-8 每汉字 3 字节）");
        assert!(fp.utf8_no_bom());
        // BOM 文件：字节偏移与解码文本错位 3 字节 ⇒ 不供建表
        let mut bom = UTF8_BOM.to_vec();
        bom.extend_from_slice("a\nb".as_bytes());
        let fp2 = FileFingerprint::build(&bom);
        assert!(fp2.line_offsets().is_none(), "BOM 文件不供建行偏移（字节≠文本）");
        assert!(!fp2.utf8_no_bom());
        // 非 UTF-8（shift_jis）：不建
        let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("口上\n第二行\n");
        let fp3 = FileFingerprint::build(&sjis);
        assert!(fp3.line_offsets().is_none() && !fp3.utf8_no_bom());
        // 0x0A 不可能落在 sjis/gbk/big5 多字节序列内部 ⇒ 二进制字节里建的表也不歪
        // （但二进制文件本就不参与检索，这条只为守住"建表不 panic"）
    }

    #[test]
    fn index_cache_invalidates_on_len_or_mtime_change() {
        let idx = SearchIndexCache::default();
        let path = std::path::Path::new("C:\\fake\\a.erb");
        let fp1 = idx.ensure("corpus", path, 100, 111, b"abc def ghi");
        assert_eq!(idx.entry_count("corpus"), 1);
        // 同键命中：不重建
        let fp1b = idx.ensure("corpus", path, 100, 111, b"abc def ghi");
        assert!(std::sync::Arc::ptr_eq(&fp1, &fp1b), "同键必须复用现成指纹");
        // len 变 ⇒ 重建
        let fp2 = idx.ensure("corpus", path, 200, 111, b"xyz");
        assert!(!std::sync::Arc::ptr_eq(&fp1, &fp2));
        // mtime 变 ⇒ 重建
        let _fp3 = idx.ensure("corpus", path, 200, 222, b"xyz");
        assert_eq!(idx.entry_count("corpus"), 1, "同路径只留最新条目");
    }
}