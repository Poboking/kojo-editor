//! 全文检索原语的判据（同目录模块：`lib.rs` 的 `#[cfg(test)] mod search_tests;` 挂载）。
//!
//! 覆盖：三个开关的合成、解码判据（共享常量表的 Rust 解释者，与 TS 内核逐字对拍）、
//! 命中行切分（行号 / 列号 / 预览窗口偏移）、跳过的三类计数、上限截断与取消、
//! 并行输出与单线程逐字一致。
//!
//! 整段不依赖 Tauri 运行时——`run_search` 的进度回调是注入的，所以"并行检索"这条路
//! 本身也在单测覆盖之内（真语料基准见文件末尾的 `#[ignore]` 用例）。

use super::decode_for_search;
use crate::{
    build_matcher, byte_prefilter, decode_policy, decode_with_policy, fold_width,
    is_utf16_bom_hit, literal_width_pattern, looks_binary, preview_window, run_search, scan_hits,
    scan_text, scan_text_flat, unfold_width, utf16_len, SearchFileDto, SearchMatchDto,
    SearchOptionsDto, SearchProgressPayload, SearchRequestDto, SearchResultDto, ELLIPSIS_UNIT,
    SEARCH_PER_FILE_CAP,
};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

static SEQ: AtomicUsize = AtomicUsize::new(0);

fn temp_dir(tag: &str) -> PathBuf {
    let n = SEQ.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("kojo-search-{}-{tag}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 单线程 + 大小写敏感的缺省请求：线程数为 1 时输出顺序确定，判据可逐字比对。
fn request(root: &Path, query: &str) -> SearchRequestDto {
    SearchRequestDto {
        search_id: 1,
        roots: vec![root.to_string_lossy().into_owned()],
        query: query.to_string(),
        options: SearchOptionsDto {
            is_regex: Some(false),
            case_sensitive: Some(true),
            whole_word: Some(false),
            extensions: None,
            globs: None, // P2-15：DTO 加了 globs 字段（缺省 None = 老调用方零改动）
            exclude_globs: None, // WS-10：同款 additive，缺省 None = 不排除（老用例零改动）
            max_results: None,
            threads: Some(1),
        },
    }
}

fn run(req: &SearchRequestDto) -> SearchResultDto {
    let cancel = Mutex::new(HashSet::new());
    let emit = |_p: SearchProgressPayload| {};
    run_search(&emit, &cancel, req).expect("检索应成功")
}

/* ------------------------------ 匹配器 ------------------------------ */

#[test]
fn literal_query_is_escaped_not_regex() {
    let m = build_matcher("a.b", false, true, false).unwrap();
    assert!(m.is_match("a.b"));
    assert!(!m.is_match("axb"), "字面量模式不该把 . 当通配");
}

#[test]
fn regex_mode_interprets_the_pattern() {
    let m = build_matcher("a.b", true, true, false).unwrap();
    assert!(m.is_match("axb"));
    let m2 = build_matcher(r"^K\d+_", true, true, false).unwrap();
    assert!(m2.is_match("K12_MESSAGE"));
    assert!(!m2.is_match("xK12_"));
}

#[test]
fn case_insensitive_flag_widens_the_match() {
    assert!(!build_matcher("abc", false, true, false).unwrap().is_match("ABC"));
    assert!(build_matcher("abc", false, false, false).unwrap().is_match("ABC"));
}

#[test]
fn whole_word_rejects_substring_hits() {
    let m = build_matcher("flag", false, true, true).unwrap();
    assert!(m.is_match("FLAG1 flag;"));
    assert!(!m.is_match("flagpole"), "全词模式下 flagpole 里的 flag 不算命中");
}

#[test]
fn invalid_regex_is_reported_not_swallowed() {
    let err = build_matcher("a(", true, true, false).unwrap_err();
    assert!(err.contains("正则无效"), "unexpected: {err}");
}

/* --------------------------- 字节级预筛 --------------------------- */

/// 预筛的成立条件与**作用半径**（PS-1 §3 + 2026-10-20 宽度折叠）：
/// 字面量 + 大小写敏感就建预筛，但预筛正则必须与匹配器用**同一份宽度等价类**；
/// 含可折字符的查询（正常查询几乎都含）只许对"整份字节就是合法 UTF-8"的文件生效
/// ——遗留族（shift_jis/gbk/big5）里全角形的字节与 UTF-8 不同，拿 UTF-8 的查询字节
/// 去筛它们就会**漏报**。
#[test]
fn byte_prefilter_holds_for_case_sensitive_literals_and_reports_its_reach() {
    let ascii = byte_prefilter("abc", false, true, false).expect("ASCII 字面量该有预筛");
    assert!(
        !ascii.ascii_safe,
        "含可折字符（半角 a 可折成全角 ａ）⇒ 遗留族编码不同，只许筛合法 UTF-8 文件"
    );
    assert!(ascii.re.is_match(b"xxabcxx"), "半角原样要筛得出");
    assert!(
        ascii.re.is_match("xxａｂｃxx".as_bytes()),
        "全角形（UTF-8）也要筛得出——否则半角查询会被字节层误杀全角正文"
    );
    assert!(
        !ascii.re.is_match(b"xxABCxx"),
        "大小写敏感的预筛不许折叠大小写（宽度与大小写是两个维度）"
    );

    let zh = byte_prefilter("口上", false, true, false).expect("中文查询也该有预筛");
    assert!(!zh.ascii_safe, "非 ASCII 查询对遗留族不成立 ⇒ 只许筛合法 UTF-8 的文件");
    assert!(zh.re.is_match("这里有口上这个词".as_bytes()), "UTF-8 字节形要筛得出");
    assert!(!zh.re.is_match("没有这个词".as_bytes()), "没有就该筛掉");
    // GBK 的「口上」字节（u8 解不出该词）：预筛按 UTF-8 字节筛它会误杀 ⇒ 半径外，不筛
    let (gbk_kojou, _, _) = encoding_rs::GBK.encode("口上");
    assert!(
        !zh.re.is_match(&gbk_kojou),
        "夹具：GBK 字节形本就与 UTF-8 不同（这条断言反过来才说明半径标记是必要的）"
    );

    // 正则 / 大小写不敏感 / 全词 / 空查询：一条都不预筛
    assert!(byte_prefilter("a.c", true, true, false).is_none(), "正则可能匹配到字节里没有的原样片段");
    assert!(byte_prefilter("abc", false, false, false).is_none(), "大小写折叠让'字节里有'≠'文本能匹配'");
    assert!(
        byte_prefilter("abc", false, true, true).is_none(),
        "全词边界在解码后的字符上，字节级无法等价复刻 ⇒ 不预筛（宁可多解码，不可漏报）"
    );
    assert!(byte_prefilter("", false, true, false).is_none());
}

/// **中文查询打到遗留族文件上不许漏**（预筛放宽 + 三族裁决接线两条一起的端到端判据）。
/// 改造前：预筛只认 ASCII ⇒ 中文查询对 12,657 份全不筛，而兜底只解 shift_jis ⇒
/// GBK 正文是乱码、查询词匹配不上；两头现在都接对了。
#[test]
fn chinese_query_hits_legacy_family_files_and_prefilter_cannot_lose_them() {
    let dir = temp_dir("legacy-e2e");
    let line = "口上：你好，世界\n";
    std::fs::write(dir.join("u8.erb"), line).unwrap();
    let mut bom = vec![0xEF, 0xBB, 0xBF];
    bom.extend_from_slice(line.as_bytes());
    std::fs::write(dir.join("bom.erb"), &bom).unwrap();
    let (gbk, _, had_err) = encoding_rs::GBK.encode(line);
    assert!(!had_err, "夹具：GBK 必须严格解得动");
    std::fs::write(dir.join("gbk.erb"), &gbk[..]).unwrap();
    // 干扰项：同一目录一份**不含该词**的 UTF-8 ⇒ 该被预筛挡在解码之前（不误报也不漏报）
    std::fs::write(dir.join("miss.erb"), "无关内容\n第二行\n").unwrap();

    let mut req = request(&dir, "你好"); // request() = 字面量 + 大小写敏感 + 单线程
    req.options.extensions = Some(vec!["erb".to_string()]);
    let out = run(&req);
    let names: Vec<String> = out
        .files
        .iter()
        .map(|f| f.path.rsplit(['\\', '/']).next().unwrap_or("").to_string())
        .collect();
    for want in ["u8.erb", "bom.erb", "gbk.erb"] {
        assert!(names.iter().any(|n| n == want), "{want} 该命中却没了：{names:?}");
    }
    assert!(!names.iter().any(|n| n == "miss.erb"), "不含词的文件不该出现：{names:?}");
    assert_eq!(out.total_matches, 3, "三份各一次命中");
    for f in &out.files {
        assert_eq!(f.matches[0].line, 1);
        assert_eq!(f.matches[0].column, 4, "「口上：」= 3 个单元 ⇒ 1 基列 4：{}", f.path);
        assert_eq!(
            f.matches[0].preview,
            "口上：你好，世界",
            "检索预览必须与编辑器打开同一份字节看到的文本逐字相同：{}",
            f.path
        );
        assert_eq!(hit_text(&f.matches[0]), "你好");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/* ---------------------------- 解码判据（共享常量表） ---------------------------- */

/// 内嵌表本体可校验：解析 + 校验通过，且形状与 TS 侧 `DECODE_PROBE_POLICY` 约定一致
/// （TS 侧对拍钉在 `packages/kernel/tests/encoding-decode-policy.test.ts`——两份测试读的是
/// **同一个 JSON 文件**，表漂一个字节必有一边红）。
#[test]
fn embedded_policy_table_is_the_shared_one() {
    let p = decode_policy().expect("内嵌策略表应能解析并通过校验");
    assert_eq!(p.version, 1);
    assert_eq!(p.fallback_encoding, "shift_jis");
    assert_eq!(
        p.bom_rules
            .iter()
            .map(|r| (r.bom.clone(), r.encoding.clone()))
            .collect::<Vec<_>>(),
        vec![
            (vec![0xEF, 0xBB, 0xBF], "utf-8-bom".to_string()),
            (vec![0xFF, 0xFE], "utf-16le".to_string()),
            (vec![0xFE, 0xFF], "utf-16be".to_string()),
        ]
    );
}

/// 与 `packages/kernel/tests/encoding-decode-policy.test.ts` 的 GOLDEN 表**逐字同源**：
/// 同一组字节样本、同一组期望文本（UTF-16 只认 BOM 那一支的代价照旧——无 BOM 的 utf-16
/// 按 shift_jis 解成乱码并因含 NUL 计入 skipped.binary，可见可数）。
/// 旧 `decode_for_search` 的分叉桶（UTF-8 BOM + 非法尾随 ⇒ 整份含 BOM 落 SJIS）已被表判序
/// **消除**；`EF BB BF FF FE 41` 正是 §5.90 对照探针实测的唯一分叉——`utf8_decode_whatwg`
/// 按 TextDecoder 的"逐错误事件一个 U+FFFD"口径解码，两侧现在逐字相同。
#[test]
fn policy_table_decodes_golden_samples() {
    let p = decode_policy().unwrap();
    let cases: Vec<(Vec<u8>, &str)> = vec![
        // UTF-8 BOM，正文合法（BOM 剥掉）
        (vec![0xEF, 0xBB, 0xBF, b'a', b'b'], "ab"),
        // 裸 BOM
        (vec![0xEF, 0xBB, 0xBF], ""),
        // UTF-8 BOM + 流尾截断序列 ⇒ 一个 U+FFFD（与 TextDecoder 同）
        (vec![0xEF, 0xBB, 0xBF, 0xE3, 0x81], "\u{FFFD}"),
        // UTF-8 BOM + 非法字节连跑 ⇒ 逐错误两个 U+FFFD（encoding_rs 旧口径会给一个——分叉已消除）
        (vec![0xEF, 0xBB, 0xBF, 0xFF, 0xFE, b'A'], "\u{FFFD}\u{FFFD}A"),
        // UTF-8 序列中途非法：E0 要求续字节 A0-BF，80 违例 ⇒ 逐错误三个 U+FFFD（与 TextDecoder 同）
        (vec![0xEF, 0xBB, 0xBF, 0xE0, 0x80, 0x80], "\u{FFFD}\u{FFFD}\u{FFFD}"),
        // 无 BOM 合法 UTF-8
        ("日本".as_bytes().to_vec(), "日本"),
        // UTF-16 LE / BE（BOM 剥掉）
        (vec![0xFF, 0xFE, b'a', 0x00], "a"),
        (vec![0xFE, 0xFF, 0x00, b'a'], "a"),
        // UTF-16 BE 代理对
        (vec![0xFE, 0xFF, 0xD8, 0x3D, 0xDE, 0x00], "\u{1F600}"),
        // UTF-16 LE 奇数尾字节 ⇒ 一个 U+FFFD
        (vec![0xFF, 0xFE, b'a'], "\u{FFFD}"),
        // Shift-JIS（非法 UTF-8 ⇒ 兜底那一支）
        (vec![0x82, 0xA0, 0x82, 0xA2, 0x82, 0xA4], "あいう"),
        // Shift-JIS 中孤立非法字节
        (vec![b'A', 0xFF, b'B'], "A\u{FFFD}B"),
        // Shift-JIS 引导字节截断在流尾
        (vec![0x82], "\u{FFFD}"),
    ];
    for (bytes, want) in cases {
        let got = decode_with_policy(&bytes, p).expect("策略解码不该硬失败");
        assert_eq!(got.as_ref(), want, "样本 {:02X?}", bytes);
    }
}

/// utf-16 二进制豁免同样只读表（BOM 判序 = 唯一一处）：
/// 旧实现自带一份 `utf16_bom_encoding` if 链——已删，此测试钉"表是唯一判据"。
#[test]
fn utf16_binary_exemption_reads_the_same_table() {
    let p = decode_policy().unwrap();
    assert!(is_utf16_bom_hit(&[0xFF, 0xFE, b'a', 0x00], p));
    assert!(is_utf16_bom_hit(&[0xFE, 0xFF, 0x00, b'a'], p));
    assert!(!is_utf16_bom_hit(&[0xEF, 0xBB, 0xBF, b'a'], p));
    assert!(!is_utf16_bom_hit(b"plain", p));
}

/// 三族评分（2026-10-17 编码标签批）——**与内核 `encoding.test.ts` 的 GBK/Big5 用例逐条同判据**：
/// 检索预览与编辑器必须对同一份字节看到同一文本。
#[test]
fn gbk_and_big5_chinese_no_longer_forced_into_shift_jis() {
    // GBK 的 你好，世界（c4e3 bac3 a3ac cac0 bde7）：SJIS 兜底解含 U+FFFD 且零假名证据 ⇒ gbk 胜
    let gbk: [u8; 10] = [0xC4, 0xE3, 0xBA, 0xC3, 0xA3, 0xAC, 0xCA, 0xC0, 0xBD, 0xE7];
    assert_eq!(decode_for_search(&gbk), "你好，世界");
    // Big5 的 你好（a741 a66e）：gbk 族解出的是符号区垃圾（0 分）⇒ big5 以 2 分上位
    let big5: [u8; 4] = [0xA7, 0x41, 0xA6, 0x6E];
    assert_eq!(decode_for_search(&big5), "你好");
    // 真 Shift-JIS 日文不被抢（假名独有证据每字 +2）
    let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("「こんにちは」");
    assert_eq!(decode_for_search(&sjis), "「こんにちは」");
    // 纯高位垃圾三族零分 ⇒ 仍兜底 shift_jis（含替换字符，与旧口径逐字节一致）
    let junk = decode_for_search(&[0x41, 0xFF, 0x42]);
    assert!(junk.contains('\u{FFFD}'), "非法字节必须留下可见的替换字符");
    assert!(junk.starts_with('A') && junk.ends_with('B'));
}

#[test]
fn binary_detection_ignores_utf16_nul_bytes() {
    assert!(!looks_binary(&[0xFF, 0xFE, b'a', 0x00], true), "utf-16 的 NUL 不是二进制信号");
    assert!(looks_binary(b"text\x00binary", false));
    assert!(!looks_binary("口上の本文".as_bytes(), false));
}

/* ------------------------ 命中行切分 / 偏移 ------------------------ */

#[test]
fn line_and_column_are_one_based_and_utf16_counted() {
    let m = build_matcher("ABC", false, true, false).unwrap();
    let (hits, clipped) = scan_text("一行目\n二行目にABC\n", &m, 10);
    assert!(!clipped);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].line, 2);
    // 列号是 UTF-16 单元（JS/Monaco 口径）："二行目に" = 4 个 BMP 字符 ⇒ 1 基列 = 5
    assert_eq!(hits[0].column, 5);
    assert_eq!(hits[0].preview, "二行目にABC");
    assert_eq!((hits[0].start, hits[0].end), (4, 7));
    // 区间按 UTF-16 单元切（Rust 的 &str 下标是字节，故先转单元再看命中文本）
    assert_eq!(hit_text(&hits[0]), "ABC");
}

/// 按 `start`/`end`（UTF-16 单元）从预览里取命中文本——正是前端 <mark> 的算法
fn hit_text(h: &SearchMatchDto) -> String {
    let units: Vec<u16> = h.preview.encode_utf16().collect();
    String::from_utf16_lossy(&units[h.start as usize..h.end as usize])
}

#[test]
fn surrogate_pairs_count_as_two_units() {
    // U+1F600（BMP 外，UTF-16 里占两个单元）——列号必须按单元数算
    let m = build_matcher("尾", false, true, false).unwrap();
    let (hits, _) = scan_text("😀尾\n", &m, 10);
    assert_eq!(hits[0].column, 3, "BMP 外字符占两个 UTF-16 单元");
    assert_eq!(hit_text(&hits[0]), "尾");
}

#[test]
fn preview_window_keeps_the_hit_and_reports_window_offsets() {
    let line = format!("{}NEEDLE{}", "0".repeat(250), "9".repeat(250));
    let units: Vec<u16> = line.encode_utf16().collect();
    let (win, start, end) = preview_window(&units, 250, 256, 240);
    assert!(win.len() > 240, "窗口含两侧省略号");
    assert_eq!(win[0], ELLIPSIS_UNIT);
    assert_eq!(*win.last().unwrap(), ELLIPSIS_UNIT);
    assert_eq!(
        String::from_utf16_lossy(&win),
        format!("…{}NEEDLE{}…", "0".repeat(117), "9".repeat(117))
    );
    assert_eq!(&win[start as usize..end as usize], "NEEDLE".encode_utf16().collect::<Vec<_>>());
}

#[test]
fn short_lines_are_returned_whole_without_ellipsis() {
    let units = "abcXYZ".encode_utf16().collect::<Vec<_>>();
    let (win, start, end) = preview_window(&units, 3, 6, 240);
    assert_eq!(String::from_utf16_lossy(&win), "abcXYZ");
    assert_eq!((start, end), (3, 6));
    assert_eq!(utf16_len("abcXYZ"), 6);
}

/// 不截断那一支必须是**借用**（PS-1 §3：命中行绝大多数本来就短于窗口，
/// 旧口径每个命中先整行复制一遍单元、再 `from_utf16_lossy` 复制一遍文本）。
#[test]
fn preview_window_borrows_when_the_line_fits() {
    let units = "短行".encode_utf16().collect::<Vec<_>>();
    let (win, _, _) = preview_window(&units, 0, 1, 240);
    assert!(
        matches!(win, std::borrow::Cow::Borrowed(_)),
        "整行装得下就不该复制单元数组"
    );
    let long = "x".repeat(400).encode_utf16().collect::<Vec<_>>();
    let (win2, _, _) = preview_window(&long, 200, 201, 240);
    assert!(matches!(win2, std::borrow::Cow::Owned(_)), "开窗那支必然是新建的");
}

#[test]
fn scan_text_reports_clipping_at_the_cap() {
    let m = build_matcher("x", false, true, false).unwrap();
    let (hits, clipped) = scan_text("x\nx\nx\nx\n", &m, 2);
    assert_eq!(hits.len(), 2);
    assert!(clipped, "还有命中没装下 ⇒ 必须报截断");
    let (all, clipped2) = scan_text("x\nx\n", &m, 2);
    assert_eq!(all.len(), 2);
    assert!(!clipped2, "恰好装满不算截断");
}

/* ------------------- 字面量单趟快道 ≡ 逐行口径（PS-1 §3） ------------------- */

/// **对拍**：字面量查询下，"整篇一次 find_iter + 增量数行/数列"与旧的"逐行 find_iter"
/// 必须产出**逐字段相同**的命中（行号 / 列号 / 预览 / 窗口偏移 / 截断标记）。
/// 快道只在该前提下成立 —— 正则查询仍走逐行原口径（锚点语义不许动），故这里覆盖
/// 大小写敏感 / 不敏感 / 全词三档开关，以及跨行不跨行、`\r\n`、代理对、超长行、
/// 命中贴着行首行尾、空行、cap 卡边界这些形态。
#[test]
fn scan_text_flat_matches_line_by_line_for_literals() {
    let long = format!("{}NEEDLE{}", "0".repeat(300), "9".repeat(300));
    // 夹具形态逐条有账：命中贴行首 / 空行 / 同行三命中 + CRLF / BMP 外字符（列按 UTF-16 单元）
    // / 行中多段 / 命中贴行尾 / 超长行（预览开窗）/ 末行无换行
    // / **孤立 `\r` 与 U+2028**：本仓的分行判据是 `split('\n')`（不是 `str::lines()`，后者把
    //   `\r`、U+0085/U+2028/U+2029 也当行终止）⇒ 快道必须跟**慢道**同判据，而不是跟 lines()。
    //   这两条夹具就是把"分行口径不许顺手换成 lines()"钉在这里。
    let body = "NEEDLE:甲\n\nNEEDLENEEDLENEEDLE 尾\r\n\u{1F600}NEEDLE\u{1F600}\n\
                前置很长的一段中文然后NEEDLE然后又一串\n尾NEEDLE\n\
                甲\rNEEDLE尾\u{2028}NEEDLE\n"
        .to_string()
        + &long
        + "\nNEEDLE";
    for (query, case_sensitive, whole_word) in [
        ("NEEDLE", true, false),
        ("needle", false, false), // 大小写不敏感的字面量
        ("NEEDLE", true, true),   // 全词：行边界上的 \b 两侧同判
        ("needle", false, true),
        ("甲", true, false),
        ("尾NEEDLE", true, false),
        ("0NEEDLE", true, false),
    ] {
        let m = build_matcher(query, false, case_sensitive, whole_word).unwrap();
        for cap in [1usize, 2, 5, 500] {
            let (lines, clip_lines) = scan_text(&body, &m, cap);
            let (flat, clip_flat) = scan_text_flat(&body, &m, cap);
            assert_eq!(
                lines, flat,
                "查询={query} case={case_sensitive} word={whole_word} cap={cap} 两条扫描产出不同"
            );
            assert_eq!(clip_lines, clip_flat, "截断标记不同：{query} cap={cap}");
            if cap >= 5 {
                assert!(!lines.is_empty(), "夹具本身该有命中（{query}）");
            }
        }
    }
    // 分流点：字面量走快道、正则走逐行 —— 两条都必须给出上面的同产出（正则由原实现给）
    let m = build_matcher("NEEDLE", false, true, false).unwrap();
    assert_eq!(
        scan_hits(&body, &m, 500, true).0,
        scan_hits(&body, &m, 500, false).0,
        "分流后产出漂了"
    );
}

/// 正则口径**没有**被顺手改掉：`^` 仍落在每一行（grep 语义），锚点在 CRLF 上仍
/// 认剥掉 `\r` 之后的行尾。这两条就是"字面量快道不套到正则上"的理由。
#[test]
fn regex_queries_keep_line_anchored_semantics() {
    let dir = temp_dir("anchor");
    std::fs::write(dir.join("a.erb"), "K1_x\nK2_y\nK3_z\n").unwrap();
    std::fs::write(dir.join("crlf.erb"), "abc\r\nabc\r\n").unwrap();

    let mut req = request(&dir, r"^K\d");
    req.options.is_regex = Some(true);
    let out = run(&req);
    assert_eq!(out.total_matches, 3, "^ 必须逐行生效，不是只在文件首生效");

    let mut req2 = request(&dir, r"c$");
    req2.options.is_regex = Some(true);
    req2.options.extensions = Some(vec!["erb".to_string()]);
    let out2 = run(&req2);
    // ^K\d 三份 + crlf.erb 两行（剥 \r 后行尾是 c）
    assert_eq!(out2.total_matches, 2, "CRLF 的 $ 要认剥掉 \\r 之后的行尾");
    assert!(out2.files.iter().all(|f| f.path.ends_with("crlf.erb")));
    let _ = std::fs::remove_dir_all(&dir);
}

/* ---------------------------- 端到端 ---------------------------- */

#[test]
fn search_over_a_directory_reports_hits_and_skips() {
    let dir = temp_dir("e2e");
    std::fs::write(dir.join("a.erb"), "一行目\n二行目にABC\n").unwrap();
    std::fs::write(dir.join("b.erb"), "no match here\n").unwrap();
    // shift_jis 文件：编码不同，命中必须照样找到
    let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("口上\n");
    std::fs::write(dir.join("c.erb"), &sjis[..]).unwrap();
    // 二进制（含 NUL，且非 utf-16 BOM）
    std::fs::write(dir.join("bin.erb"), b"\x00\x01A\x02\x00").unwrap();
    // 扩展名之外
    std::fs::write(dir.join("note.md"), "ABC\n").unwrap();

    let mut req = request(&dir, "ABC");
    req.options.extensions = Some(vec![" .ERB ".to_string()]); // 脏输入必须被归一化
    let out = run(&req);

    assert_eq!(out.total_matches, 1);
    assert_eq!(out.files.len(), 1);
    assert!(out.files[0].path.ends_with("a.erb"));
    assert_eq!(out.files[0].matches[0].line, 2);
    assert_eq!(out.skipped.filtered, 1, "note.md 被扩展名挡下并计数");
    assert_eq!(out.skipped.binary, 1);
    assert!(!out.truncated);
    assert!(!out.cancelled);
    assert_eq!(out.files_scanned, 4, "四个 .erb 都扫过（二进制那个也算扫过）");

    // 同一个查询打到 shift_jis 文件上也要命中
    let mut req2 = request(&dir, "口上");
    req2.options.extensions = Some(vec!["erb".to_string()]);
    let out2 = run(&req2);
    assert_eq!(out2.total_matches, 1);
    assert!(out2.files[0].path.ends_with("c.erb"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn hidden_entries_are_skipped_and_overlapping_roots_dedup() {
    let dir = temp_dir("hidden");
    std::fs::create_dir_all(dir.join(".git")).unwrap();
    std::fs::write(dir.join(".git").join("config"), "ABC\n").unwrap();
    std::fs::write(dir.join("a.erb"), "ABC\n").unwrap();

    let mut req = request(&dir, "ABC");
    // 根嵌套（同一批文件给两次）⇒ 去重后不该出现两份结果
    req.roots = vec![
        dir.to_string_lossy().into_owned(),
        dir.join("").to_string_lossy().into_owned(),
    ];
    let out = run(&req);
    assert_eq!(out.files.len(), 1, "隐藏目录跳过 + 重叠根去重");
    assert_eq!(out.total_matches, 1);
    let _ = std::fs::remove_dir_all(&dir);
}

/// 去重键 = **整条路径的小写形**（Windows 大小写不敏感），口径与改造前逐字相同；
/// 改造只是把这条键从"每次比较现算"提成"每条路径算一次"。同目录的大小写两种写法
/// 必须仍然折叠成一次 ⇒ 键算错就会在这里露出来。
#[test]
fn case_variant_roots_dedup_on_the_lowered_key() {
    let dir = temp_dir("casevar");
    std::fs::write(dir.join("a.erb"), "ABC\n").unwrap();
    let lower = dir.to_string_lossy().to_lowercase();
    let upper = dir.to_string_lossy().to_uppercase();
    if lower == upper {
        let _ = std::fs::remove_dir_all(&dir);
        return; // 纯非 ASCII 路径（无大小写可言）⇒ 这条没有可断言的形态
    }
    let mut req = request(&dir, "ABC");
    req.roots = vec![lower, upper];
    let out = run(&req);
    assert_eq!(out.files.len(), 1, "同一个目录的两种写法该折叠成一次检索");
    assert_eq!(out.total_matches, 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn max_results_truncates_and_says_so() {
    let dir = temp_dir("cap");
    let body: String = (0..10).map(|_| "hit\n").collect();
    std::fs::write(dir.join("a.erb"), body).unwrap();

    let mut req = request(&dir, "hit");
    req.options.max_results = Some(3);
    let out = run(&req);
    assert_eq!(out.total_matches, 3);
    assert!(out.truncated, "被上限截断必须显式回报");

    let mut req2 = request(&dir, "hit");
    req2.options.max_results = Some(10_000_000); // 硬顶之上再夹一道
    let out2 = run(&req2);
    assert_eq!(out2.total_matches, 10);
    assert!(!out2.truncated);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn per_file_cap_is_reported_as_truncation() {
    let dir = temp_dir("perfile");
    let body: String = (0..SEARCH_PER_FILE_CAP + 20).map(|_| "hit\n").collect();
    std::fs::write(dir.join("a.erb"), body).unwrap();
    let req = request(&dir, "hit");
    let out = run(&req);
    assert_eq!(out.total_matches as usize, SEARCH_PER_FILE_CAP);
    assert!(out.truncated);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cancel_stops_early_and_says_so() {
    let dir = temp_dir("cancel");
    std::fs::write(dir.join("a.erb"), "hit\n").unwrap();
    let req = request(&dir, "hit");
    let cancel = Mutex::new(HashSet::new());
    cancel.lock().unwrap().insert(req.search_id);
    let emit = |_p: SearchProgressPayload| {};
    let out = run_search(&emit, &cancel, &req).unwrap();
    assert!(out.cancelled);
    assert_eq!(out.files_scanned, 0);
    assert_eq!(out.total_matches, 0);
    // 取消标记用完即清：下一次同 id 的检索不该被旧标记掐死
    assert!(cancel.lock().unwrap().is_empty());
    let out2 = run_search(&emit, &cancel, &req).unwrap();
    assert!(!out2.cancelled);
    assert_eq!(out2.total_matches, 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn empty_query_is_rejected() {
    let dir = temp_dir("empty");
    let cancel = Mutex::new(HashSet::new());
    let emit = |_p: SearchProgressPayload| {};
    assert!(run_search(&emit, &cancel, &request(&dir, "")).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn parallel_run_matches_single_thread_result() {
    let dir = temp_dir("par");
    for i in 0..40 {
        std::fs::write(dir.join(format!("f{i:02}.erb")), "hit\nmiss\nhit\n").unwrap();
    }
    let one = run(&request(&dir, "hit"));
    let mut multi = request(&dir, "hit");
    multi.options.threads = Some(8);
    let many = run(&multi);
    assert_eq!(one.total_matches, many.total_matches);
    let paths = |r: &SearchResultDto| -> Vec<String> {
        r.files.iter().map(|f: &SearchFileDto| f.path.clone()).collect()
    };
    assert_eq!(paths(&one), paths(&many), "输出顺序与线程数无关");
    assert_eq!(many.total_matches, 80);
    let _ = std::fs::remove_dir_all(&dir);
}

/* ------------------------- 前后端载荷契约（camelCase） ------------------------- */
//
// 这两条是**跨语言契约**的护栏：字段名一漂，前端拿到的是 undefined 而不是报错
// （JS 读不到 key 不会抛），表现为"检索永远零结果"这类最难查的静默失灵。

#[test]
fn request_dto_accepts_the_frontend_json_shape() {
    // 与 `packages/app/src/bridge/search.ts` 的 `SearchRequest` 逐字同形
    let json = r#"{"searchId":7,"roots":["C:\\game","C:\\ws"],"query":"abc",
        "options":{"isRegex":true,"caseSensitive":false,"wholeWord":true,
        "extensions":["erb","csv"],"maxResults":300}}"#;
    let req: SearchRequestDto = serde_json::from_str(json).unwrap();
    assert_eq!(req.search_id, 7);
    assert_eq!(req.roots, vec!["C:\\game", "C:\\ws"]);
    assert_eq!(req.query, "abc");
    assert_eq!(req.options.is_regex, Some(true));
    assert_eq!(req.options.case_sensitive, Some(false));
    assert_eq!(req.options.whole_word, Some(true));
    assert_eq!(req.options.max_results, Some(300));
    assert_eq!(
        req.options.extensions.as_deref(),
        Some(["erb".to_string(), "csv".to_string()].as_slice())
    );
}

#[test]
fn request_dto_tolerates_missing_option_keys() {
    // 前端只送它认识的开关：缺键必须落到缺省（不是解析失败）
    let req: SearchRequestDto =
        serde_json::from_str(r#"{"searchId":1,"roots":["C:\\game"],"query":"a"}"#).unwrap();
    assert_eq!(req.options.is_regex, None);
    assert_eq!(req.options.threads, None);
    assert_eq!(req.options.max_results, None);
}

#[test]
fn result_json_is_camel_case_with_the_keys_the_panel_reads() {
    let dir = temp_dir("contract");
    std::fs::write(dir.join("a.erb"), "hit\n").unwrap();
    let out = run(&request(&dir, "hit"));
    let json = serde_json::to_value(&out).unwrap();
    assert_eq!(json["totalMatches"], 1);
    assert_eq!(json["filesScanned"], 1);
    assert_eq!(json["truncated"], false);
    assert_eq!(json["cancelled"], false);
    assert!(json["elapsedMs"].is_number());
    assert_eq!(json["skipped"]["tooLarge"], 0);
    assert_eq!(json["skipped"]["filtered"], 0);
    let m = &json["files"][0]["matches"][0];
    assert_eq!(m["line"], 1);
    assert_eq!(m["column"], 1);
    assert_eq!(m["preview"], "hit");
    assert_eq!(m["start"], 0);
    assert_eq!(m["end"], 3);
    let _ = std::fs::remove_dir_all(&dir);
}

/// 真语料基准（不进常规矩阵；语料目录名会变、也可能整份暂离，与仓库既有口径一致）：
/// `KOJO_SEARCH_BENCH_ROOT=<语料目录> cargo test --lib -- --ignored --nocapture`
///
/// 可调项：`KOJO_SEARCH_BENCH_QUERY`（缺省「口上」）、`KOJO_SEARCH_BENCH_EXT`
/// （逗号分隔；缺省 = 面板的缺省词表 erb,erh,erd,kojo,txt,csv,als）、
/// `KOJO_SEARCH_BENCH_THREADS`（缺省 8）。
#[test]
#[ignore]
fn bench_against_real_corpus() {
    let Ok(root) = std::env::var("KOJO_SEARCH_BENCH_ROOT") else {
        eprintln!("跳过：未设 KOJO_SEARCH_BENCH_ROOT");
        return;
    };
    if !Path::new(&root).is_dir() {
        eprintln!("跳过：{root} 不是目录");
        return;
    }
    let query = std::env::var("KOJO_SEARCH_BENCH_QUERY").unwrap_or_else(|_| "口上".to_string());
    let extensions: Vec<String> = match std::env::var("KOJO_SEARCH_BENCH_EXT") {
        Ok(v) => v.split(',').map(|s| s.trim().to_string()).collect(),
        Err(_) => ["erb", "erh", "erd", "kojo", "txt", "csv", "als"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
    };
    let threads: usize = std::env::var("KOJO_SEARCH_BENCH_THREADS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8);

    let mut req = request(Path::new(&root), &query);
    req.search_id = 99;
    req.options.extensions = Some(extensions);
    req.options.max_results = Some(5000);
    req.options.threads = Some(threads);
    let cancel = Mutex::new(HashSet::new());
    let emit = |_p: SearchProgressPayload| {};
    let out = run_search(&emit, &cancel, &req).unwrap();
    println!(
        "[bench] 查询={query} 线程={threads} 文件={} 命中={} 结果文件={} 耗时={}ms 截断={} 跳过(二进制/超大/读失败/类型)={}/{}/{}/{}",
        out.files_scanned,
        out.total_matches,
        out.files.len(),
        out.elapsed_ms,
        out.truncated,
        out.skipped.binary,
        out.skipped.too_large,
        out.skipped.unreadable,
        out.skipped.filtered
    );
}

/* --------------------- 流式增量（P2-11） --------------------- */
//
// 三条判据钉的是同一件契约：**事件流与完成态必须对得上**。
//  ① 每个命中文件都经事件流送到（累积 ∪ 收口残留 = 完成态，一条不丢）；
//  ② `done` 只有最后一批，且终态标志与完成态一致（中途批次的标志不作准）；
//  ③ 截断 / 取消时事件流也不许多出文件（累积 ⊆ 完成态）——"事件说三条、
//      最终态说两条"这种撒谎读数在这里就必须红。
//
// 实现走 `run_search_with_files`（生产入口）；`SearchFilesPayload` 的 `files`
// 是借用的，故测试里只落投影（路径 + 标志），不搬 DTO。

#[test]
fn streamed_batches_cover_every_file_and_close_with_done() {
    let dir = temp_dir("stream");
    // 250 份：够跨过 SEARCH_PROGRESS_FILES(200) 的节流点 ⇒ 至少出一批中途批次 + 一批收口批
    for i in 0..250 {
        std::fs::write(dir.join(format!("f{i:03}.erb")), "hit\nmiss\nhit\n").unwrap();
    }
    let mut req = request(&dir, "hit");
    req.search_id = 7;
    req.options.threads = Some(4);
    let cancel = Mutex::new(HashSet::new());
    // 批次投影：(searchId, 本批路径, done, truncated, cancelled)
    let seen: Mutex<Vec<(u64, Vec<String>, bool, bool, bool)>> = Mutex::new(Vec::new());
    let out = crate::run_search_with_files(
        &|_p| {},
        &|b: &crate::SearchFilesPayload<'_>| {
            seen.lock().unwrap().push((
                b.search_id,
                b.files.iter().map(|f| f.path.clone()).collect(),
                b.done,
                b.truncated,
                b.cancelled,
            ));
        },
        &cancel,
        &req,
        &crate::SearchTextCache::default(),
    )
    .expect("检索应成功");
    let seen = seen.into_inner().unwrap();

    // ① 每条批次都认领本次检索的 id
    assert!(seen.iter().all(|(id, ..)| *id == 7), "批次 searchId 必须与请求一致");

    // ② 累积 ∪ 残留 = 完成态（路径多重集逐条相等）
    let mut streamed: Vec<String> = seen
        .iter()
        .flat_map(|(_, files, ..)| files.iter().cloned())
        .collect();
    streamed.sort();
    let mut final_paths: Vec<String> = out.files.iter().map(|f| f.path.clone()).collect();
    final_paths.sort();
    assert_eq!(streamed.len(), 250, "250 个命中文件都必须经事件流送到");
    assert_eq!(streamed, final_paths, "事件流必须覆盖完成态的每个文件（一条不丢、一条不多）");

    // ③ done 只有最后一批，且终态标志与完成态一致
    assert_eq!(seen.iter().filter(|(_, _, done, ..)| *done).count(), 1, "只能有一批 done");
    let last = seen.last().unwrap();
    assert!(last.2, "最后一批必须 done");
    assert_eq!(last.3, out.truncated, "done 批的 truncated 必须与完成态一致");
    assert_eq!(last.4, out.cancelled, "done 批的 cancelled 必须与完成态一致");

    // ④ 完成态读数不变（线程化 + 流式不许动最终口径）
    assert_eq!(out.total_matches, 500, "250 份 × 2 命中");
    assert_eq!(out.files_scanned, 250);
    assert!(!out.truncated);
    assert!(!out.cancelled);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn streamed_final_batch_reports_cancellation() {
    let dir = temp_dir("stream-cancel");
    for i in 0..20 {
        std::fs::write(dir.join(format!("f{i:02}.erb")), "hit\n").unwrap();
    }
    let req = request(&dir, "hit");
    let cancel = Mutex::new(HashSet::new());
    cancel.lock().unwrap().insert(req.search_id); // 开扫前就取消
    let seen: Mutex<Vec<(bool, bool, usize)>> = Mutex::new(Vec::new());
    let out = crate::run_search_with_files(
        &|_p| {},
        &|b: &crate::SearchFilesPayload<'_>| {
            seen.lock().unwrap().push((b.done, b.cancelled, b.files.len()));
        },
        &cancel,
        &req,
        &crate::SearchTextCache::default(),
    )
    .unwrap();
    let seen = seen.into_inner().unwrap();
    assert_eq!(seen.len(), 1, "取消在扫第一个文件前生效 ⇒ 只有收口一批");
    assert!(seen[0].0 && seen[0].1, "收口批必须 done + cancelled");
    assert_eq!(seen[0].2, 0);
    assert!(out.cancelled);
    assert_eq!(out.total_matches, 0);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn streamed_batches_never_exceed_the_final_result_when_truncated() {
    let dir = temp_dir("stream-cap");
    let body: String = (0..10).map(|_| "hit\n").collect();
    for i in 0..10 {
        std::fs::write(dir.join(format!("f{i:02}.erb")), &body).unwrap();
    }
    let mut req = request(&dir, "hit");
    req.options.max_results = Some(3); // 撞上限 ⇒ truncated
    let cancel = Mutex::new(HashSet::new());
    let streamed: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let last_flags: Mutex<Option<(bool, bool)>> = Mutex::new(None);
    let out = crate::run_search_with_files(
        &|_p| {},
        &|b: &crate::SearchFilesPayload<'_>| {
            streamed
                .lock()
                .unwrap()
                .extend(b.files.iter().map(|f| f.path.clone()));
            *last_flags.lock().unwrap() = Some((b.done, b.truncated));
        },
        &cancel,
        &req,
        &crate::SearchTextCache::default(),
    )
    .unwrap();
    assert!(out.truncated, "夹具必须真的撞上限");
    let (done, truncated) = last_flags.into_inner().unwrap().unwrap();
    assert!(done && truncated, "done 批的 truncated 必须与完成态一致");
    // 截断时事件流也不许多出文件（累积 ⊆ 完成态）
    let streamed = streamed.into_inner().unwrap();
    let final_paths: std::collections::HashSet<&String> = out.files.iter().map(|f| &f.path).collect();
    assert!(
        streamed.iter().all(|p| final_paths.contains(p)),
        "事件流不许出现完成态没有的文件"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/* ------------------------------ glob 文件过滤（P2-15） ------------------------------ */
//
// 翻译规则与前端 `packages/app/tests/search-glob.test.ts` 的 TS 镜像逐字对拍：
//   `*` → `[^/]*`、`?` → `[^/]`、其余 regex 转义、分隔符归一成 `/`；
//   `**/` 序列 → `(.*/)?`（任意层含 0 层——工程修正，理由见 lib.rs 的
//   `glob_to_regex` 注释：否则 `src/**/*.erb` 匹配不到直档子文件），裸 `**` → `.*`。
// 匹配基准 = **相对检索根**的路径（glob 按仓库相对位置写，拿全路径匹配只会让
// `**` 前缀永远对不上盘符）。glob 与扩展名是**且**的关系。

/// 翻译规则逐条钉死（**对拍的真源**：TS 镜像按这张表逐字复刻）。
#[test]
fn glob_to_regex_translates_wildcards_and_escapes_the_rest() {
    let t = |g: &str| super::glob_to_regex(g);
    assert_eq!(t("*.kojo"), "^[^/]*\\.kojo$");
    assert_eq!(t("**/x/*.erb"), "^(.*/)?x/[^/]*\\.erb$");
    assert_eq!(t("src/**/*.erb"), "^src/(.*/)?[^/]*\\.erb$");
    assert_eq!(t("**"), "^.*$"); // 裸 `**`：跨目录
    assert_eq!(t("a?b"), "^a[^/]b$");
    // 元字符是字面（不转义会把作者的点当成任意字符）
    assert_eq!(t("a.b"), "^a\\.b$");
    assert_eq!(t("a+b(c)|d"), "^a\\+b\\(c\\)\\|d$");
    // Windows 反斜杠先归一成 `/`（glob 写法按仓库相对位置，分隔符不该有两种）
    assert_eq!(t("sub\\*.erb"), "^sub/[^/]*\\.erb$");
}

/// 翻译产出必须**可直接编译**（`regex::escape` 保证通配符之外的字符全字面）。
#[test]
fn glob_to_regex_output_is_always_a_valid_regex() {
    for g in ["*.kojo", "**/x/*.erb", "a?b", "a.b", "a+b(c)", "sub\\*.erb", "[", "(", "*?"] {
        let src = super::glob_to_regex(g);
        assert!(regex::Regex::new(&src).is_ok(), "翻译产出编译失败：{g} -> {src}");
    }
}

/// 相对根匹配 + `**` / `*` / `?` 三档通配的行文语义（`**/` 含 0 层 ⇒ 根下直档也命中）。
#[test]
fn glob_filter_matches_relative_to_the_root() {
    let dir = temp_dir("glob-rel");
    std::fs::write(dir.join("a.erb"), "hit\n").unwrap();
    std::fs::create_dir_all(dir.join("sub").join("deep")).unwrap();
    std::fs::write(dir.join("sub").join("b.erb"), "hit\n").unwrap();
    std::fs::write(dir.join("sub").join("deep").join("c.erb"), "hit\n").unwrap();
    std::fs::write(dir.join("note.md"), "hit\n").unwrap();

    let paths_of = |out: &SearchResultDto| -> Vec<String> {
        let mut v: Vec<String> = out.files.iter().map(|f| f.path.replace('\\', "/")).collect();
        v.sort();
        v
    };
    let ends = |v: &[String]| -> Vec<String> {
        v.iter().map(|p| p.rsplit('/').next().unwrap().to_string()).collect()
    };

    // `**/*.erb`：跨目录且含 0 层 ⇒ 三个 erb 全中（根下直档 a.erb 也在内）
    let mut req = request(&dir, "hit");
    req.options.globs = Some(vec!["**/*.erb".to_string()]);
    let out = run(&req);
    assert_eq!(ends(&paths_of(&out)), vec!["a.erb", "b.erb", "c.erb"]);
    assert_eq!(out.skipped.filtered, 1, "只有 note.md 被 glob 挡下并计数");

    // `src/**/*.erb` 形态：前缀目录 + 任意层（含直档 b.erb）
    let mut req2 = request(&dir, "hit");
    req2.options.globs = Some(vec!["sub/**/*.erb".to_string()]);
    assert_eq!(ends(&paths_of(&run(&req2))), vec!["b.erb", "c.erb"]);

    // `?.erb` = 一级单字符 ⇒ 只认根下 a.erb（`[^/]` 不跨目录，证明匹配基准是相对路径）
    let mut req3 = request(&dir, "hit");
    req3.options.globs = Some(vec!["?.erb".to_string()]);
    let out3 = run(&req3);
    assert_eq!(ends(&paths_of(&out3)), vec!["a.erb"]);
    assert_eq!(out3.skipped.filtered, 3);

    // 空 globs = 今天行为（仅扩展名过滤；此处扩展名也没给 ⇒ 四个文件全扫）
    let mut req4 = request(&dir, "hit");
    req4.options.globs = Some(vec![]);
    let out4 = run(&req4);
    assert_eq!(out4.files.len(), 4);
    assert_eq!(out4.skipped.filtered, 0);

    let _ = std::fs::remove_dir_all(&dir);
}

/// glob 与扩展名是**且**的关系：两类词来自两个独立维度（后缀 vs 位置），
/// 写成"或"会让「类型=erb + glob=*.md」这种自相矛盾的条件悄悄扫全项目。
#[test]
fn glob_and_extensions_are_both_required() {
    let dir = temp_dir("glob-and");
    std::fs::write(dir.join("a.erb"), "hit\n").unwrap();
    std::fs::write(dir.join("note.md"), "hit\n").unwrap();

    let mut req = request(&dir, "hit");
    req.options.extensions = Some(vec!["erb".to_string()]);
    req.options.globs = Some(vec!["*.md".to_string()]);
    let out = run(&req);
    assert_eq!(out.total_matches, 0, "扩展名与 glob 必须同时满足");
    assert_eq!(out.files_scanned, 0);
    assert_eq!(out.skipped.filtered, 2, "两类挡下都计入 filtered（界面上同一行读数，不静默）");

    let _ = std::fs::remove_dir_all(&dir);
}

/// Windows 反斜杠写法的 glob 也要能匹配（分隔符先归一成 `/` 再翻正则）。
#[test]
fn glob_backslashes_are_normalized_before_matching() {
    let dir = temp_dir("glob-bslash");
    std::fs::create_dir_all(dir.join("sub")).unwrap();
    std::fs::write(dir.join("sub").join("b.erb"), "hit\n").unwrap();
    std::fs::write(dir.join("a.erb"), "hit\n").unwrap();

    let mut req = request(&dir, "hit");
    req.options.globs = Some(vec!["sub\\*.erb".to_string()]);
    let out = run(&req);
    assert_eq!(out.files.len(), 1);
    assert!(out.files[0].path.replace('\\', "/").ends_with("sub/b.erb"));

    let _ = std::fs::remove_dir_all(&dir);
}

/// 载荷契约：`globs` 缺键 ⇒ None（老调用方零改动）；给出 ⇒ 按 camelCase 解析。
#[test]
fn request_dto_globs_default_to_none_when_absent() {
    let with: SearchRequestDto =
        serde_json::from_str(r#"{"searchId":1,"roots":["C://game"],"query":"a",
            "options":{"globs":["*.kojo","src/**/*.erb"]}}"#)
        .unwrap();
    assert_eq!(
        with.options.globs.as_deref(),
        Some(["*.kojo".to_string(), "src/**/*.erb".to_string()].as_slice())
    );
    let without: SearchRequestDto =
        serde_json::from_str(r#"{"searchId":1,"roots":["C://game"],"query":"a"}"#).unwrap();
    assert_eq!(without.options.globs, None);
}

/* ------------------------- 排除模式（WS-10，gitignore-lite） ------------------------- */

/// 纯函数：模式 → 正则源码。不含 `/` 补"任意深度"前缀段；含 `/` 钉相对根；
/// 前导 `/` 剥掉；反斜杠归一。
#[test]
fn exclude_regex_source_shapes() {
    // 裸文件名模式 ⇒ 允许任意深度、但段边界必须对齐（前缀组以 `/` 收尾）
    assert_eq!(super::exclude_regex_source("*.tmp"), "^(.*/)?[^/]*\\.tmp$");
    // 含 `/` ⇒ 原样钉相对根（glob_to_regex 的产物）
    assert_eq!(
        super::exclude_regex_source("backup/**"),
        super::glob_to_regex("backup/**")
    );
    // 前导 `/` = 锚定根的相对写法 ⇒ 与不带斜杠同判据
    assert_eq!(
        super::exclude_regex_source("/backup/*.erb"),
        super::glob_to_regex("backup/*.erb")
    );
    // Windows 反斜杠写法先归一成 `/`（含分隔符 ⇒ 仍走"钉相对根"那条腿）
    assert_eq!(
        super::exclude_regex_source("sub\\*.erb"),
        super::glob_to_regex("sub/*.erb")
    );
}

/// 纯函数：`is_excluded` 的三条判据——排除不吃掉合法命中、取反回捞、后写赢。
#[test]
fn exclude_rules_evaluate_in_order_last_match_wins() {
    let rules = super::compile_exclude_rules(&[
        "**/backup/**".to_string(),
        "!**/backup/keep.erb".to_string(),
        "*.tmp".to_string(),
    ]);
    let hit = |rel: &str| super::is_excluded(&rules, rel, rel);
    assert!(hit("x/backup/old.erb"), "backup 深处的文件被挡");
    assert!(!hit("x/backup/keep.erb"), "! 取反把它放回");
    assert!(!hit("mybackup/a.erb"), "段边界对齐：`backup` 不吃 `mybackup`（排除不吃掉合法命中）");
    assert!(hit("a/b/c.tmp"), "裸文件名模式挡任意深度");
    assert!(!hit("a.erb"), "合法命中一个不少");
    // 后写赢：同一目标"先放回再挡下"就真是挡下
    let r2 = super::compile_exclude_rules(&[
        "!a.erb".to_string(),
        "*.erb".to_string(),
    ]);
    assert!(super::is_excluded(&r2, "a.erb", "a.erb"));
}

/// 绝对 / 相对两种写法都兑现：模式写全路径（抄自资源管理器）时按归一全路径命中。
#[test]
fn exclude_matches_absolute_and_relative_spellings() {
    let rules = super::compile_exclude_rules(&["C:/game/backup/**".to_string()]);
    assert!(super::is_excluded(&rules, "ignored/whatever.erb", "C:/game/backup/x.erb"), "绝对写法按全路径命中");
    let rel = super::compile_exclude_rules(&["backup/**".to_string()]);
    assert!(super::is_excluded(&rel, "backup/x.erb", "C:/game/backup/x.erb"), "相对写法按相对路径命中");
    assert!(!super::is_excluded(&rel, "other/x.erb", "C:/game/other/x.erb"));
}

/// 大小写与分隔符：模式大小写敏感（显式路径显式匹配，与 include glob 同口径）；
/// 路径与模式的分隔符两侧都归一成 `/`。
#[test]
fn exclude_is_case_sensitive_and_separator_normalized() {
    let rules = super::compile_exclude_rules(&["Backup/*.erb".to_string()]);
    assert!(super::is_excluded(&rules, "Backup/a.erb", "Backup/a.erb"));
    assert!(!super::is_excluded(&rules, "backup/a.erb", "backup/a.erb"), "大小写不同 = 不是同一路径段");
    // 反斜杠**模式**写法（作者从 Windows 地址栏抄的）归一后照样命中
    let bs = super::compile_exclude_rules(&["Backup\\*.erb".to_string()]);
    assert!(super::is_excluded(&bs, "Backup/a.erb", "Backup/a.erb"));
}

/// 坏输入不出声不放行也不炸：空白条目丢弃、光杆 `!` 丢弃、空清单 = 不排除。
#[test]
fn exclude_tolerates_blank_and_bogus_entries() {
    assert!(super::compile_exclude_rules(&[]).is_empty());
    assert!(super::compile_exclude_rules(&[
        "  ".to_string(),
        "!".to_string(),
        "!  ".to_string(),
    ])
    .is_empty());
}

/// 端到端：检索目录里排除 `backup/` 与 `*.tmp`——备份里的命中不进结果、
/// 合法命中一条不少，`skipped.excluded` 如实计数（不静默）。
#[test]
fn search_exclude_globs_blocks_backup_and_keeps_legit_hits() {
    let dir = temp_dir("exclude-e2e");
    std::fs::create_dir_all(dir.join("backup")).unwrap();
    std::fs::write(dir.join("a.erb"), "hit\n").unwrap();
    std::fs::write(dir.join("backup").join("old.erb"), "hit\nhit\n").unwrap();
    std::fs::write(dir.join("scratch.tmp"), "hit\n").unwrap();

    let mut req = request(&dir, "hit");
    req.options.exclude_globs = Some(vec!["**/backup/**".to_string(), "*.tmp".to_string()]);
    let out = run(&req);
    assert_eq!(out.total_matches, 1, "只剩 a.erb 的一条命中");
    assert_eq!(out.files.len(), 1);
    assert_eq!(out.skipped.excluded, 2, "backup/old.erb 与 scratch.tmp 各计一笔");
    assert_eq!(out.skipped.filtered, 0, "排除与类型过滤分账，不混成一笔");

    // 缺省（None）与老行为逐字一致：三个文件全扫
    let base = run(&request(&dir, "hit"));
    assert_eq!(base.total_matches, 4);
    assert_eq!(base.skipped.excluded, 0);

    // 取反回捞：! 一条把 keep 放回来
    let mut req2 = request(&dir, "hit");
    req2.options.exclude_globs = Some(vec![
        "**/backup/**".to_string(),
        "!**/backup/keep.erb".to_string(),
    ]);
    std::fs::write(dir.join("backup").join("keep.erb"), "hit\n").unwrap();
    let out2 = run(&req2);
    assert!(out2.files.iter().any(|f| f.path.replace('\\', "/").ends_with("backup/keep.erb")));
    assert!(!out2.files.iter().any(|f| f.path.replace('\\', "/").ends_with("backup/old.erb")));

    let _ = std::fs::remove_dir_all(&dir);
}

/// 载荷契约：`excludeGlobs` 缺键 ⇒ None；给出 ⇒ camelCase 解析（跨语言字段名一漂就是静默失灵）。
#[test]
fn request_dto_exclude_globs_default_and_camel_case() {
    let with: SearchRequestDto =
        serde_json::from_str(r#"{"searchId":1,"roots":["C://game"],"query":"a",
            "options":{"excludeGlobs":["**/backup/**","!keep.erb"]}}"#)
        .unwrap();
    assert_eq!(
        with.options.exclude_globs.as_deref(),
        Some(["**/backup/**".to_string(), "!keep.erb".to_string()].as_slice())
    );
    let without: SearchRequestDto =
        serde_json::from_str(r#"{"searchId":1,"roots":["C://game"],"query":"a"}"#).unwrap();
    assert_eq!(without.options.exclude_globs, None);
    // 完成态 JSON 带上 `excluded` 键（面板读它；缺键 = JS 拿 undefined 而不是报错）
    let dir = temp_dir("exclude-contract");
    std::fs::write(dir.join("a.erb"), "hit\n").unwrap();
    let json = serde_json::to_value(run(&request(&dir, "hit"))).unwrap();
    assert_eq!(json["skipped"]["excluded"], 0);
    let _ = std::fs::remove_dir_all(&dir);
}

/* ------------------------- 全词判据跨语言对账（WW-1） ------------------------- */
//
// ## 尺子
// 全词 = 命中区间两侧的相邻一格都**不是**标识字符 `[\p{L}\p{N}_]`（行首/行尾 = 没有相邻字符）。
// 唯一真源住 TS（`packages/app/src/ui/search-replace.ts` 的 `wholeWordOk`，与 `erb-rename.ts`
// 的 `IDENT_RE` 同口径）——替换是写盘操作；检索必须与它同判，否则同一个「全词」勾选项
// 在面板（本层）与真实替换（TS 层）里给出不同结果。
//
// ## 改前 / 改后（同一批 38 例，两侧真实调用取证；完整对照表见
// `packages/app/tests/search-whole-word.test.ts` 的文件头）
// 改前 Rust = `\b(?:…)\b`，改前 TS = `wholeWordOk`（即改后的尺）。38 例里 31 例两侧同判，
// 分歧只在两类（改后全部对齐）：
//   ① 模式首尾是非词字符（`（测试）`，5 例）：`\b` 要求两侧是"词符↔非词符"过渡 ⇒ 行首/行尾
//      与空格旁**没有**边界（Rust 0 命中），而行内贴着 CJK 反而**有**边界（Rust 1 命中）——
//      与相邻格判据正好相反（TS 分别为 1 / 0）；
//   ② 词符集合不同（2 例）：`\w` 含组合记号（`C_FLAG` + U+0301 ⇒ Rust 0 / TS 1）、
//      但不含 `No` 类数字（`C_FLAG²` ⇒ Rust 1 / TS 0），而 `\p{L}\p{N}` 相反。
//
// ## 样例清单是跨语言契约的两端
// `WHOLE_WORD_CASES` 与 `packages/app/tests/search-whole-word.test.ts` 的 `CASES`
// **逐字同源**（查询 / 行文本 / 期望命中数三项一字不差）。为什么各写一份、
// 不引共享 JSON：两套测试各有自己的加载面（Rust 单测不读 node 侧文件，vitest 也不读
// Rust 源码），两份字面量就是两端的契约文本。**改一处必须改两处**——漂一个字符，
// 那一侧的对账就会红（两侧都不读对方，靠这份约定 + 双跑兜住）。

/// 交叉对账样例：(查询, 行文本, 全词命中数)。与 TS 侧 `CASES` 逐字同源（见上）。
const WHOLE_WORD_CASES: &[(&str, &str, usize)] = &[
    ("测试", "测试", 1),
    ("测试", "这是测试文本", 0),
    ("测试", "这是 测试 文本", 1),
    ("测试", "测试2", 0),
    ("测试", "A测试", 0),
    ("测试", "「测试」", 1),
    ("测试", "测试 测试", 2),
    ("（测试）", "（测试）", 1),
    ("（测试）", "这是（测试）文本", 0),
    ("（测试）", "这是 （测试） 文本", 1),
    ("（测试）", "（测试）。", 1),
    ("（测试）", "a（测试）b", 0),
    ("test-case", "test-case", 1),
    ("test-case", "a test-case b", 1),
    ("test-case", "mytest-case", 0),
    ("test-case", "test-cases", 0),
    ("test-case", "test-case2", 0),
    ("test-case", "test_case", 0),
    ("test-case", "test-case, test-case", 2),
    ("好感度", "好感度", 1),
    ("好感度", "好感度上升", 0),
    ("好感度", "提升好感度", 0),
    ("好感度", "好感度+1", 1),
    ("好感度", "「好感度」", 1),
    ("C_FLAG", "C_FLAG", 1),
    ("C_FLAG", "if C_FLAG then", 1),
    ("C_FLAG", "C_FLAG_X", 0),
    ("C_FLAG", "MYC_FLAG", 0),
    ("C_FLAG", "C_FLAG1", 0),
    ("C_FLAG", "(C_FLAG)", 1),
    ("C_FLAG", "C_FLAG²", 0),
    ("C_FLAG", "C_FLAG\u{0301}", 1),
    ("_x", "_x", 1),
    ("_x", "a_x", 0),
    ("_x", "( _x )", 1),
    ("_x", "_x2", 0),
    ("_x", "x_x", 0),
    ("_x", "_x _x", 2),
];

/// 逐例对账：逐行扫描与单趟快道都必须给出 TS 替换侧的裁决（命中数 + 命中文本）。
#[test]
fn whole_word_matches_the_ts_replacement_oracle_case_by_case() {
    for &(query, line, want) in WHOLE_WORD_CASES {
        let m = build_matcher(query, false, true, true).unwrap();
        let (per_line, _) = scan_text(line, &m, 100);
        let (flat, _) = scan_text_flat(line, &m, 100);
        assert_eq!(per_line.len(), want, "逐行扫描：查询 {query:?} / 行 {line:?}");
        assert_eq!(flat, per_line, "两条扫描路径不同判：查询 {query:?} / 行 {line:?}");
        for h in &per_line {
            assert_eq!(hit_text(h), query, "命中文本必须是查询本身：查询 {query:?}");
        }
    }
}

/// 端到端（真文件 + 预筛 + 流式之前的收口路径）：每个查询一份文件，文件内是该查询的
/// 全部样例行（`\n` 连接——行边界对全词判据等价于"没有相邻字符"）。
#[test]
fn whole_word_end_to_end_agrees_with_the_same_cases() {
    let dir = temp_dir("whole-word-e2e");
    let mut by_query: Vec<(&str, Vec<&str>, usize)> = Vec::new();
    for &(query, line, want) in WHOLE_WORD_CASES {
        match by_query.iter_mut().find(|(qq, _, _)| *qq == query) {
            Some((_, lines, total)) => {
                lines.push(line);
                *total += want;
            }
            None => by_query.push((query, vec![line], want)),
        }
    }
    for (i, (query, lines, want)) in by_query.iter().enumerate() {
        std::fs::write(dir.join(format!("q{i}.erb")), lines.join("\n")).unwrap();
        let mut req = request(&dir, query);
        req.options.whole_word = Some(true);
        req.options.extensions = Some(vec!["erb".to_string()]);
        let out = run(&req);
        assert_eq!(out.total_matches as usize, *want, "端到端：查询 {query:?}");
        assert_eq!(out.files.len(), 1, "只该命中自己那份文件：查询 {query:?}");
        assert!(
            out.files[0].path.ends_with(&format!("q{i}.erb")),
            "命中文件错位：查询 {query:?}"
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// 正则模式同样走相邻格判据（全词不是"字面量专用"开关）。
#[test]
fn whole_word_applies_to_regex_mode_too() {
    let m = build_matcher(r"\d+", true, true, true).unwrap();
    assert!(m.is_match("12"), "整行都是数字 ⇒ 两侧无相邻字符");
    assert!(!m.is_match("a12"), "贴着标识字符不算全词");
    let (hits, _) = scan_text("12 a12 34", &m, 10);
    assert_eq!(hits.len(), 2, "只认 12 与 34；a12 该被全词判据拒掉");
    assert_eq!(hit_text(&hits[0]), "12");
    assert_eq!(hit_text(&hits[1]), "34");
}

/* ------------------------- 宽度折叠跨语言对账（WF-1） ------------------------- */
//
// ## 表（只折宽度）
// 全角 ASCII 区 U+FF01–U+FF5E ↔ 半角 U+0021–U+007E（位移 0xFEE0），
// U+3000（全角空格）↔ U+0020。**不折**繁简（`髙`≠`高`）、不折假名（`ア`≠`ｱ`）、
// 不折大小写（大小写是 `caseSensitive` 开关的事）。折叠只作用于**字面量**查询：
// 正则模式下作者拥有 pattern 的解释权，本层原样编译（需要精确宽度时这是逃生口）。
//
// ## 实现形态（Rust）
// 不改写查询/正文，而是把查询逐字符展开成"宽度等价类"（`（` → `[（(]`）——命中偏移
// 仍落在原文上，预览 / 高亮 / 替换坐标不用二次换算。全词边界也先折相邻一格再判标识字符
// （`＿` 折成 `_` ⇒ 是标识字符）。
//
// ## 样例清单是跨语言契约的两端
// `WIDTH_FOLD_CASES` 与 `packages/app/tests/search-width-fold.test.ts` 的
// `WIDTH_FOLD_CASES` **逐字同源**（查询 / 行文本 / 命中数 / 首个命中文本四项一字不差）。
// 为什么各写一份、不引共享数据文件：两套测试各有自己的加载面（Rust 单测不读 node 侧
// 文件，vitest 也不读 Rust 源码），两份字面量就是契约文本。**改一处必须改两处**——
// 漂一个字符，两侧对账必有一边红（两侧都不读对方，靠这条约定 + 双跑兜住）。
//
// 样例均按 `字面量 + 大小写敏感 + 全词` 取值（与 TS 侧 `matcherFor` 同一组开关）。

const WIDTH_FOLD_CASES: &[(&str, &str, usize, &str)] = &[
    // 全角 ↔ 半角：括号 / 字母 / 标点
    ("（测试）", "(测试)", 1, "(测试)"),
    ("(测试)", "（测试）", 1, "（测试）"),
    ("（测试）", "（测试）", 1, "（测试）"),
    ("（测试）", "这是 (测试) 文本", 1, "(测试)"),
    ("（测试）", "这是（测试）文本", 0, ""),
    ("测试", "（测试）", 1, "测试"),
    ("ＡＢＣ", "ABC", 1, "ABC"),
    ("ABC", "ＡＢＣ", 1, "ＡＢＣ"),
    ("ＡＢＣ", "x ABC y", 1, "ABC"),
    ("ＡＢＣ", "xABCy", 0, ""),
    ("ＡＢＣ", "xＡＢＣy", 0, ""),
    ("ＡＢＣ", "ABC ABC", 2, "ABC"),
    ("abc", "ＡＢＣ", 0, ""), // 宽度折、大小写不折（caseSensitive）
    ("！", "!", 1, "!"),
    ("～", "~", 1, "~"),
    ("＿", "_", 1, "_"),
    ("_", "＿", 1, "＿"),
    ("x", "＿x", 0, ""), // 全角下划线折成 `_` = 标识字符
    ("x", "x＿", 0, ""),
    ("x", "（x）", 1, "x"),
    ("（x）", "(x)", 1, "(x)"),
    ("Ｃ_FLAG", "C_FLAG", 1, "C_FLAG"),
    ("C_FLAG", "Ｃ＿ＦＬＡＧ", 1, "Ｃ＿ＦＬＡＧ"),
    ("（Ａ）", "(A)", 1, "(A)"),
    ("，", ",", 1, ","),
    // U+3000 ↔ 半角空格（整词判据下，空格贴着标识字符不算命中）
    ("\u{3000}", "\u{3000}", 1, "\u{3000}"),
    (" ", "\u{3000}", 1, "\u{3000}"),
    ("\u{3000}", "（ ）", 1, " "),
    (" ", "（\u{3000}）", 1, "\u{3000}"),
    ("\u{3000}", ". . .", 2, " "),
    ("\u{3000}", "a b", 0, ""),
    ("a b", "a\u{3000}b", 1, "a\u{3000}b"),
    ("\u{3000}", "a\u{3000}b", 0, ""),
    // 负例：表外字符一律不折
    ("①", "①", 1, "①"),
    ("①", "1", 0, ""),
    ("①", "１", 0, ""), // `１` 折成 `1`，但 `①` 不折
    ("髙", "高", 0, ""),
    ("髙", "髙", 1, "髙"),
    ("、", ",", 0, ""),
    (",", "、", 0, ""),
    ("ア", "ｱ", 0, ""), // 半角片假名 U+FF71 在 U+FF5E 之外
];

#[test]
fn width_fold_table_covers_only_the_two_ranges_and_the_ideographic_space() {
    assert_eq!(fold_width('Ａ'), 'A', "U+FF21 → U+0041");
    assert_eq!(fold_width('！'), '!', "U+FF01 下界");
    assert_eq!(fold_width('～'), '~', "U+FF5E 上界");
    assert_eq!(fold_width('\u{3000}'), ' ', "全角空格 → 半角空格");
    assert_eq!(fold_width('A'), 'A', "半角已是规范形");
    assert_eq!(fold_width(' '), ' ');
    // 表外：一律原样（不折繁简 / 假名 / 圈号 / 其余 CJK 标点）
    assert_eq!(fold_width('①'), '①');
    assert_eq!(fold_width('髙'), '髙');
    assert_eq!(fold_width('ア'), 'ア');
    assert_eq!(fold_width('ｱ'), 'ｱ', "半角片假名 U+FF71 在 U+FF5E 之外");
    assert_eq!(fold_width('、'), '、', "只折 U+3000，不是整个 CJK 标点区");
    // 反向：规范半角 → 全角
    assert_eq!(unfold_width('A'), 'Ａ');
    assert_eq!(unfold_width(' '), '\u{3000}');
    assert_eq!(unfold_width('①'), '①');
    assert_eq!(unfold_width('\u{3000}'), '\u{3000}');
}

#[test]
fn literal_width_pattern_expands_each_char_into_its_width_class() {
    let re = regex::Regex::new(&literal_width_pattern("（Ａ)")).unwrap();
    assert!(re.is_match("(A)"), "半角全形都要命中");
    assert!(re.is_match("（Ａ）"), "全角形同一类");
    assert!(!re.is_match("(B)"));

    let space = regex::Regex::new(&literal_width_pattern("\u{3000}")).unwrap();
    assert!(space.is_match(" "));
    assert!(space.is_match("\u{3000}"));

    // 字符类元字符（`]`）两形都得转义后仍可编译
    let bracket = regex::Regex::new(&literal_width_pattern("]")).unwrap();
    assert!(bracket.is_match("]"));
    assert!(bracket.is_match("］"));

    // 全部可打印 ASCII 的等价类都必须可编译（类内转义无死角）
    for cp in 0x21u32..=0x7E {
        let ch = char::from_u32(cp).unwrap();
        let src = literal_width_pattern(&ch.to_string());
        assert!(regex::Regex::new(&src).is_ok(), "字符 {ch:?} 的等价类编译失败：{src}");
    }
}

/// 逐例对账：逐行扫描与单趟快道都必须给出 TS 替换侧的裁决（命中数 + 首个命中文本）。
#[test]
fn width_fold_matches_the_ts_replacement_oracle_case_by_case() {
    for &(query, line, want, first) in WIDTH_FOLD_CASES {
        let m = build_matcher(query, false, true, true).unwrap();
        let (per_line, _) = scan_text(line, &m, 100);
        let (flat, _) = scan_text_flat(line, &m, 100);
        assert_eq!(per_line.len(), want, "逐行扫描：查询 {query:?} / 行 {line:?}");
        assert_eq!(flat, per_line, "两条扫描路径不同判：查询 {query:?} / 行 {line:?}");
        if want > 0 {
            assert_eq!(
                hit_text(&per_line[0]),
                first,
                "首个命中文本：查询 {query:?} / 行 {line:?}"
            );
        }
    }
}

/// 宽度与大小写是两个维度：折叠后大小写开关照旧生效。
#[test]
fn width_fold_does_not_fold_case() {
    let sensitive = build_matcher("ＡＢＣ", false, true, false).unwrap();
    assert!(sensitive.is_match("ABC"));
    assert!(!sensitive.is_match("abc"), "宽度折、大小写不折");
    let loose = build_matcher("ＡＢＣ", false, false, false).unwrap();
    assert!(loose.is_match("abc"));
    assert!(loose.is_match("ａｂｃ"));
}

/// 正则模式不折宽度（作者拥有 pattern）；需要精确宽度匹配时这是逃生口。
#[test]
fn width_fold_is_literal_only_and_regex_mode_stays_verbatim() {
    let re = build_matcher("（测试）", true, true, false).unwrap();
    assert!(re.is_match("（测试）"));
    assert!(!re.is_match("(测试)"), "正则模式不折：作者拥有 pattern");
    let re2 = build_matcher("Ａ", true, true, false).unwrap();
    assert!(re2.is_match("Ａ"));
    assert!(!re2.is_match("A"));
}

/// 全词边界先折宽度再判标识字符（`＿` → `_`）。
#[test]
fn whole_word_boundary_folds_width_before_ident_check() {
    let m = build_matcher("x", false, true, true).unwrap();
    assert!(m.is_match("（x）"));
    assert!(!m.is_match("＿x"), "全角下划线折成 `_` 后是标识字符");
    assert!(!m.is_match("x＿"));
}

/// 端到端：预筛 + 解码 + 匹配一起走。两个方向都不能漏：
/// ① UTF-8 全角正文 ← 半角查询（预筛正则必须含折叠后的 UTF-8 字节形）；
/// ② 遗留族（shift_jis）全角正文 ← 半角查询（预筛对非 UTF-8 不成立 ⇒ 退回解码后匹配）。
#[test]
fn width_fold_survives_the_byte_prefilter_and_legacy_decoding() {
    let dir = temp_dir("width-e2e");
    std::fs::write(dir.join("full.erb"), "口上：（测试）\nＡＢＣ\n").unwrap();
    std::fs::write(dir.join("miss.erb"), "无关内容\n").unwrap();

    let out = run(&request(&dir, "（测试）"));
    assert_eq!(out.total_matches, 1, "全角查询打到全角正文");
    assert_eq!(out.files.len(), 1);
    assert!(out.files[0].path.ends_with("full.erb"));
    assert_eq!(hit_text(&out.files[0].matches[0]), "（测试）");
    assert_eq!(out.files[0].matches[0].column, 4, "「口上：」= 3 单元 ⇒ 1 基列 4");

    // 遗留族（shift_jis）里的全角 ＡＢＣ：半角查询也要命中
    let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("ＡＢＣ\n");
    std::fs::write(dir.join("sjis.erb"), &sjis[..]).unwrap();
    let mut req = request(&dir, "ABC");
    req.options.extensions = Some(vec!["erb".to_string()]);
    let out2 = run(&req);
    let names: Vec<&str> = out2
        .files
        .iter()
        .map(|f| f.path.rsplit(['\\', '/']).next().unwrap_or(""))
        .collect();
    assert!(names.contains(&"full.erb"), "UTF-8 全角正文该命中：{names:?}");
    assert!(names.contains(&"sjis.erb"), "shift_jis 全角正文该命中：{names:?}");
    assert!(!names.contains(&"miss.erb"), "不含词的文件不该出现：{names:?}");
    assert_eq!(out2.total_matches, 2);
    let _ = std::fs::remove_dir_all(&dir);
}

/* ------------------------- 热文本缓存（打字即搜） ------------------------- */

/// 同一批文件第二拍必须走缓存、且结果逐条相同；盘上文件变了（长度 + mtime 都动）
/// ⇒ 缓存必须失效，结果说新真相——这是"缓存不许把改过的文件当成旧内容"的唯一判据。
///
/// 缓存的是**原始字节**（不是解码正文），所以连"这一问不命中"的文件也会入表：
/// 打字即搜的下一拍要重跑预筛，缺了它就还得读盘（见 `SearchTextCache` 的头注）。
#[test]
fn text_cache_reuses_decoded_bodies_and_invalidates_on_change() {
    let dir = temp_dir("cache-reuse");
    std::fs::write(dir.join("a.erb"), "口上 一行\n").unwrap();
    std::fs::write(dir.join("b.erb"), "没有\n").unwrap();
    let req = request(&dir, "口");
    let cancel = Mutex::new(HashSet::new());
    let cache = crate::SearchTextCache::default();

    let out1 = crate::run_search_with_files(&|_p| {}, &|_b| {}, &cancel, &req, &cache).unwrap();
    assert_eq!(out1.total_matches, 1);
    let (hits1, misses1) = cache.counters();
    assert_eq!(hits1, 0, "第一拍表是空的，必然全未命中");
    assert!(misses1 >= 2, "两个候选文件各查一次表（实际 {misses1}）");

    let out2 = crate::run_search_with_files(&|_p| {}, &|_b| {}, &cancel, &req, &cache).unwrap();
    assert_eq!(out2.total_matches, out1.total_matches);
    assert_eq!(out2.files.len(), out1.files.len());
    let (hits2, _) = cache.counters();
    assert!(hits2 >= 2, "第二拍两个文件都该命中缓存（实际 {hits2}）");

    // 改内容（长度与 mtime 双判据都变）⇒ 下一次必须是新真相
    std::thread::sleep(std::time::Duration::from_millis(15));
    std::fs::write(dir.join("a.erb"), "口上 口上\n").unwrap();
    let out3 = crate::run_search_with_files(&|_p| {}, &|_b| {}, &cancel, &req, &cache).unwrap();
    assert_eq!(out3.total_matches, 2, "缓存不许把改过的文件当成旧内容");

    let _ = std::fs::remove_dir_all(&dir);
}
