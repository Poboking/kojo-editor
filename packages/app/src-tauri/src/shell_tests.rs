//! 「在系统资源管理器中显示」的判据：路径 → 各平台命令 argv 的纯构造。
//!
//! 照 `market_tests` 的分文件先例。进程派发本身（spawn explorer / open / xdg-open）
//! 是副作用，**不测**——这里只钉 argv 的逐字形态（引号、空格、父目录选择），
//! 这些恰是 explorer `/select` 最容易踩坏的细节。

use std::path::Path;

use crate::shell::{external_url_problem, open_url_command, reveal_command, trim_trailing_separators, TargetOs};

/* ---------------------------- Windows 分支 ---------------------------- */

#[test]
fn windows_file_path_verbatim_select_form() {
    let cmd = reveal_command(TargetOs::Windows, Path::new("C:\\proj\\scenario\\a.ERB"));
    assert_eq!(cmd.program, "explorer");
    // /select, 与引号路径之间**没有空格**，引号内是原始路径
    assert_eq!(cmd.args, vec!["/select,\"C:\\proj\\scenario\\a.ERB\"".to_string()]);
}

#[test]
fn windows_path_with_spaces_stays_one_quoted_arg() {
    // 含空格的目录：形态必须仍是 `/select,"…"` 一整段（派发点用 raw_arg 原样出，
    // 不会被 Command 二次加引号包成 `"/select,…"`）
    let cmd = reveal_command(TargetOs::Windows, Path::new("C:\\my works\\口上\\ERB\\ファイル"));
    assert_eq!(
        cmd.args,
        vec!["/select,\"C:\\my works\\口上\\ERB\\ファイル\"".to_string()]
    );
}

#[test]
fn windows_directory_target_selects_the_directory_itself() {
    // 目录目标不需要分叉：/select,"<目录>" = 在父文件夹里选中它
    let cmd = reveal_command(TargetOs::Windows, Path::new("D:\\works\\ERB"));
    assert_eq!(cmd.args, vec!["/select,\"D:\\works\\ERB\"".to_string()]);
}

#[test]
fn windows_trailing_separator_is_trimmed() {
    // 尾分隔符会让引号收在 `\"` 上（cmd 解析成转义引号），必须剪掉
    let cmd = reveal_command(TargetOs::Windows, Path::new("C:\\proj\\scenario\\"));
    assert_eq!(cmd.args, vec!["/select,\"C:\\proj\\scenario\"".to_string()]);
}

#[test]
fn windows_drive_root_keeps_its_separator() {
    // 盘符根不许剪成 `C:`（裸盘符的 /select 行为未定义）
    assert_eq!(trim_trailing_separators("C:\\"), "C:\\");
    assert_eq!(trim_trailing_separators("C:/"), "C:\\");
    assert_eq!(trim_trailing_separators("C:\\proj\\"), "C:\\proj");
    assert_eq!(trim_trailing_separators("relative/dir/"), "relative/dir");
}

/* ---------------------------- macOS 分支（未实测，钉字面） ---------------------------- */

#[test]
fn macos_open_dash_r_reveals_in_finder() {
    let cmd = reveal_command(TargetOs::MacOS, Path::new("/Users/dev/proj/a.ERB"));
    assert_eq!(cmd.program, "open");
    assert_eq!(cmd.args, vec!["-R".to_string(), "/Users/dev/proj/a.ERB".to_string()]);
}

/* ---------------------------- Linux 分支（未实测，钉字面） ---------------------------- */

#[test]
fn linux_opens_parent_directory_not_the_file() {
    // xdg-open 对文件会调默认应用打开它 ⇒ 必须传父目录
    let cmd = reveal_command(TargetOs::Linux, Path::new("/home/dev/proj/a.ERB"));
    assert_eq!(cmd.program, "xdg-open");
    assert_eq!(cmd.args, vec!["/home/dev/proj".to_string()]);
}

#[test]
fn linux_root_target_falls_back_to_itself() {
    // 没有父目录（根）就开它本身，别把空串递给 xdg-open
    let cmd = reveal_command(TargetOs::Linux, Path::new("/"));
    assert_eq!(cmd.args, vec!["/".to_string()]);
}

/* ---------------------------- 外链：argv 构造 ---------------------------- */

#[test]
fn external_url_is_a_single_arg_on_every_platform() {
    // URL 恒是**单个 argv 元素**、三平台同形只有程序名不同——绝不拼进 shell 字符串
    // （`cmd /c start` 是注入洞：URL 里的 `&` / 空格会逃逸成 shell 语法）
    let url = "https://github.com/kojo/editor/releases/download/v1/a.zip";
    for (os, program) in [
        (TargetOs::Windows, "explorer"),
        (TargetOs::MacOS, "open"),
        (TargetOs::Linux, "xdg-open"),
    ] {
        let cmd = open_url_command(os, url);
        assert_eq!(cmd.program, program);
        assert_eq!(cmd.args, vec![url.to_string()]);
    }
}

/* ---------------------------- 外链：双闸 ---------------------------- */

#[test]
fn external_url_gate_accepts_allowlisted_https() {
    // 白名单内 https 原样放行（返回 WHATWG 规范化串）
    assert_eq!(
        external_url_problem("https://github.com/kojo/editor"),
        Ok("https://github.com/kojo/editor".to_string())
    );
    assert!(external_url_problem("https://kojo.github.io/index.json").is_ok());
}

#[test]
fn external_url_gate_rejects_scheme_and_host_outside_allowlist() {
    // scheme 闸：非 https 一律拒
    assert!(external_url_problem("http://github.com/x").is_err());
    assert!(external_url_problem("ftp://github.com/x").is_err());
    assert!(external_url_problem("file:///C:/x").is_err());
    // 主机闸：与 market 下载同一份白名单（第二份真相必然漂，这里零复制）
    assert!(external_url_problem("https://evil.com/path").is_err());
    // `*.github.io` 只认一级子域：前缀拼多级或整体伪装都拦下
    assert!(external_url_problem("https://a.b.github.io/x").is_err());
    assert!(external_url_problem("https://github.io.evil.com/x").is_err());
    // 根本不是 URL
    assert!(external_url_problem("not a url").is_err());
}

#[test]
fn external_url_gate_rejects_userinfo_and_custom_port() {
    // url_problem 的顺带加固闸（与下载闸同一份判定）：userinfo / 非默认端口
    assert!(external_url_problem("https://user@github.com/x").is_err());
    assert!(external_url_problem("https://github.com:8443/x").is_err());
}
