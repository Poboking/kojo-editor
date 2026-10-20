//! 更新检查的环境代理（REL-1 收尾 · STATE.md「updater 跟随环境代理」待办）。
//!
//! 背景：本机直连 GitHub Releases 时通时断；tauri-plugin-updater 的 check 命令
//! 支持可选 `proxy` 参数（`http://…` 字符串），但前端 `check()` 不传参时代理只能
//! 落到 reqwest 的隐式系统探测，行为随环境漂。本模块给出**最小闭环**：Rust 侧读
//! 标准环境变量（`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` 及小写形态），经新命令
//! `updater_env_proxy` 交给前端，前端把值透传进 `check({ proxy })`。
//!
//! 口径（STATE.md 第 45 行批注）：
//! - 优先序 **HTTPS > HTTP > ALL**；同级大写在先小写在后；
//! - 值须形如 `http://host:port`（scheme 只认 http；端口必须能解析成 u16），畸形值
//!   **忽略不报错**——代理只是尽力而为的辅助，绝不因它让更新检查失败；
//! - 未设置任何代理变量时返回 `None`，前端行为与现状一字不差（additive，零回归面）。
//!
//! 纯函数接一个 env 读取闭包做单测（不碰真实进程环境）；命令侧只包一层 `std::env`。

/// 读环境变量得到更新检查用的代理 URL；读不到合法值返回 `None`。
///
/// `env` 为键值读取器（键 → 值；`None` = 未设置，空串也视作未设置），
/// 命令侧传 `std::env` 包装，测试侧传固定表。
pub fn read_env_proxy<E>(env: E) -> Option<String>
where
    E: Fn(&str) -> Option<String>,
{
    let var = |key: &str| env(key).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    for key in [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        if let Some(value) = var(key) {
            if is_http_proxy_url(&value) {
                return Some(value);
            }
            // 畸形值不报错：落空，继续看下一个优先级的变量
        }
    }
    None
}

/// 值须形如 `http://host:port`（后面跟 `/路径` 也不拒；scheme 只认 http）。
fn is_http_proxy_url(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("http://") else {
        return false;
    };
    if rest.is_empty() {
        return false;
    }
    // 问号/井号说明这不是裸的 host:port 形态，视作畸形
    if rest.contains(['?', '#']) {
        return false;
    }
    let authority = rest.split('/').next().unwrap_or("");
    if authority.is_empty() {
        return false;
    }
    // 端口取最后一个冒号之后（兼容 IPv6 字面量 host `[::1]:7890`）
    let Some((_, port)) = authority.rsplit_once(':') else {
        return false;
    };
    if port.is_empty() {
        return false;
    }
    port.parse::<u16>().is_ok()
}

/// 前端在调 `check()` 前取一次：`Some` 透传给 `check({ proxy })`，`None` 与现状同参。
#[tauri::command]
pub fn updater_env_proxy() -> Option<String> {
    read_env_proxy(|key| std::env::var(key).ok().filter(|v| !v.is_empty()))
}

/* ------------------------------- 单测 ------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn table<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + use<'a> {
        let map: HashMap<&str, &str> = pairs.iter().copied().collect();
        move |key: &str| map.get(key).map(|v| v.to_string())
    }

    #[test]
    fn none_set_returns_none() {
        assert_eq!(read_env_proxy(table(&[])), None);
    }

    #[test]
    fn https_wins_over_http_and_all() {
        let env = table(&[
            ("HTTPS_PROXY", "http://h:1"),
            ("HTTP_PROXY", "http://h:2"),
            ("ALL_PROXY", "http://h:3"),
        ]);
        assert_eq!(read_env_proxy(env), Some("http://h:1".into()));
    }

    #[test]
    fn http_wins_over_all() {
        let env = table(&[("HTTP_PROXY", "http://h:2"), ("ALL_PROXY", "http://h:3")]);
        assert_eq!(read_env_proxy(env), Some("http://h:2".into()));
    }

    #[test]
    fn all_proxy_alone_is_used() {
        assert_eq!(read_env_proxy(table(&[("ALL_PROXY", "http://h:3")])), Some("http://h:3".into()));
    }

    #[test]
    fn lowercase_used_when_uppercase_missing() {
        let env = table(&[("https_proxy", "http://h:11"), ("http_proxy", "http://h:22")]);
        assert_eq!(read_env_proxy(env), Some("http://h:11".into()));
    }

    #[test]
    fn uppercase_precedes_lowercase_within_same_family() {
        let env = table(&[
            ("HTTPS_PROXY", "http://up:1"),
            ("https_proxy", "http://low:1"),
        ]);
        assert_eq!(read_env_proxy(env), Some("http://up:1".into()));
    }

    #[test]
    fn malformed_value_is_skipped_and_falls_through() {
        // HTTPS 畸形（scheme 不对）⇒ 落到 HTTP；HTTP 也畸形 ⇒ 落到 ALL（合法）
        let env = table(&[
            ("HTTPS_PROXY", "socks5://h:1"),
            ("HTTP_PROXY", "not a url"),
            ("ALL_PROXY", "http://h:3"),
        ]);
        assert_eq!(read_env_proxy(env), Some("http://h:3".into()));
    }

    #[test]
    fn empty_value_treated_as_unset() {
        let env = table(&[("HTTPS_PROXY", "   "), ("HTTP_PROXY", "http://h:2")]);
        assert_eq!(read_env_proxy(env), Some("http://h:2".into()));
    }

    #[test]
    fn value_is_trimmed() {
        let env = table(&[("HTTPS_PROXY", "  http://h:7890  ")]);
        assert_eq!(read_env_proxy(env), Some("http://h:7890".into()));
    }

    #[test]
    fn malformed_shapes_are_rejected() {
        for bad in [
            "",                      // 裸空（读侧已滤，这里再钉函数本身）
            "https://h:1",           // scheme 只认 http
            "http://",               // 没有 host
            "http://h",              // 没有端口
            "http://h:",             // 空端口
            "http://h:notaport",     // 端口不是数字
            "http://h:70000",        // 端口超 u16
            "h:1",                   // 缺 scheme
            "http:///path",          // 空 authority
            "http://h:1?a=b",        // 问号视作畸形
        ] {
            assert!(!is_http_proxy_url(bad), "应当拒绝：{bad:?}");
        }
    }

    #[test]
    fn valid_shapes_are_accepted() {
        for good in [
            "http://127.0.0.1:7890",
            "http://[::1]:7890",
            "http://proxy.corp.example:8080/",
            "http://user:pw@h:1",
        ] {
            assert!(is_http_proxy_url(good), "应当接受：{good:?}");
        }
    }
}
