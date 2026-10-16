//! 全文检索原语的判据（同目录模块：`lib.rs` 的 `#[cfg(test)] mod search_tests;` 挂载）。
//!
//! 覆盖：三个开关的合成、编码探测口径、命中行切分（行号 / 列号 / 预览窗口偏移）、
//! 跳过的三类计数、上限截断与取消、并行输出与单线程逐字一致。
//!
//! 整段不依赖 Tauri 运行时——`run_search` 的进度回调是注入的，所以"并行检索"这条路
//! 本身也在单测覆盖之内（真语料基准见文件末尾的 `#[ignore]` 用例）。

use crate::{
    build_matcher, byte_prefilter, decode_for_search, looks_binary, preview_window, run_search,
    scan_text, utf16_len, SearchFileDto, SearchMatchDto, SearchOptionsDto, SearchProgressPayload,
    SearchRequestDto, SearchResultDto, ELLIPSIS_UNIT, SEARCH_PER_FILE_CAP,
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

#[test]
fn byte_prefilter_only_holds_for_ascii_case_sensitive_literal() {
    assert!(byte_prefilter("abc", false, true).is_some());
    // 正则：可能匹配到字节里没有的原样片段（字符类 / 量词…）⇒ 不做预筛
    assert!(byte_prefilter("a.c", true, true).is_none());
    // 大小写不敏感：Unicode 折叠让"字节里有"≠"文本能匹配"⇒ 不做预筛
    assert!(byte_prefilter("abc", false, false).is_none());
    // 非 ASCII：shift_jis 与 utf-8 的编码字节不同 ⇒ 不做预筛
    assert!(byte_prefilter("口上", false, true).is_none());
    assert!(byte_prefilter("", false, true).is_none());
}

/* ---------------------------- 编码口径 ---------------------------- */

#[test]
fn decode_follows_probe_encoding_order() {
    // utf-8-bom：BOM 必须剥掉（否则首个命中行的预览带一个不可见字符）
    assert_eq!(decode_for_search(&[0xEF, 0xBB, 0xBF, b'a', b'b']), "ab");
    // 合法 utf-8 直通
    assert_eq!(decode_for_search("口上".as_bytes()), "口上");
    // shift_jis（非法 utf-8 ⇒ 兜底那一支）
    let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("口上");
    assert_eq!(decode_for_search(&sjis), "口上");
    // utf-16 两个端序（只认 BOM 那一支，与内核 probeEncoding 一致）
    assert_eq!(decode_for_search(&[0xFF, 0xFE, b'a', 0x00]), "a");
    assert_eq!(decode_for_search(&[0xFE, 0xFF, 0x00, b'a']), "a");
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
    let (win, start, end) = preview_window(&"abcXYZ".encode_utf16().collect::<Vec<_>>(), 3, 6, 240);
    assert_eq!(String::from_utf16_lossy(&win), "abcXYZ");
    assert_eq!((start, end), (3, 6));
    assert_eq!(utf16_len("abcXYZ"), 6);
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
