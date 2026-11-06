//! 路 C 的 Rust 判据（纯函数 + 临时目录落盘 + 真实 TCP/HTTP 端到端）。
//!
//! 覆盖：线协议编解码、路径闸门、危险工具过滤、无状态协商、第四张表读写与
//! 最小权限、审计摘要不落全文、Origin/Bearer/限流三闸、发现文件生命周期；
//! 端到端节用 `server.rs` 的真实 listener 在 127.0.0.1 起端口，`std::net::TcpStream`
//! 发裸 HTTP 打全协议面（WebView 桥注入桩，回填走生产 `deliver` 路径）。

use super::audit::{self, AuditEntry, AuditOutcome};
use super::protocol::*;
use super::scope::{self, SessionGrant};
use super::server::{self, EndpointFile, HttpHead, Limits, McpBridge, McpShared, RateGovernor};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read as _, Write as _};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

static SEQ: AtomicUsize = AtomicUsize::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "kojo-mcp-t-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn empty_scope(tools: Vec<String>) -> McpSessionScope {
    McpSessionScope {
        session_id: "sess-1".to_string(),
        client_id: "client-1".to_string(),
        tier: McpTier::Read,
        approved_roots: Vec::new(),
        approved_tools: tools,
        approved_root_ids: Vec::new(),
    }
}

/* ------------------------------ protocol ------------------------------ */

#[test]
fn decode_single_and_batch() {
    let one = br#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"#;
    let list = decode_request(one).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].method, "tools/list");
    assert_eq!(list[0].id, Some(json!(1)));

    let batch = br#"[{"jsonrpc":"2.0","id":"a","method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"}]"#;
    let list = decode_request(batch).unwrap();
    assert_eq!(list.len(), 2);
    assert!(is_notification(&list[1]));
}

#[test]
fn decode_rejects_bad_envelope() {
    assert!(decode_request(b"not-json").is_err());
    assert!(decode_request(br#"{"jsonrpc":"1.0","method":"ping"}"#).is_err());
    assert!(decode_request(br#"{"jsonrpc":"2.0","id":{},"method":"ping"}"#).is_err());
    assert!(decode_request(b"[]").is_err());
    assert!(decode_request(br#"[1]"#).is_err());
}

#[test]
fn route_covers_contract_surface() {
    assert_eq!(route("initialize"), Route::Initialize);
    assert_eq!(route("ping"), Route::Ping);
    assert_eq!(route("notifications/cancelled"), Route::Notification);
    for name in WEB_METHOD_NAMES {
        assert!(matches!(route(name), Route::Webview(_)), "{name}");
    }
    assert_eq!(route("fs/write_anywhere"), Route::Unknown);
}

#[test]
fn relative_path_gate_is_fail_loud() {
    for good in ["src/main.ts", "docs/a/b.txt", "a.json"] {
        assert!(validate_relative_path(good).is_ok(), "{good}");
    }
    for bad in [
        "", "/abs/x", "\\unc\\x", "C:/x", "a/../b", "./a", "a//b", "a/", "a/./b", "CON", "a/b.",
        "a/b ", "a\0b", "~/x", "a:b",
    ] {
        let e = validate_relative_path(bad).unwrap_err();
        assert_eq!(e.code, codes::PATH_ESCAPE, "{bad}");
    }
}

#[test]
fn kojo_uri_gate() {
    assert!(validate_kojo_uri("kojo://resource/docs/a.txt").is_ok());
    assert!(validate_kojo_uri("kojo://workspace/src?line=3").is_ok());
    for bad in [
        "kojo://",
        "kojo:///abs",
        "kojo://a/../b",
        "kojo://a/./b",
        "kojo://a\\b",
    ] {
        assert!(validate_kojo_uri(bad).is_err(), "{bad}");
    }
    assert_eq!(
        validate_path_value_public("uri", "file:///etc/passwd")
            .unwrap_err()
            .code,
        codes::PATH_SCHEME
    );
}

/// 借 `validate_params` 的 resources/read 分支验证 uri scheme 闸门。
fn validate_path_value_public(key: &str, raw: &str) -> Result<(), McpError> {
    let params = json!({ key: raw });
    validate_params(WebMethod::ResourcesRead, &params)
}

#[test]
fn forbidden_target_param_is_rejected() {
    let params = json!({
        "name": "write_something",
        "arguments": { "outputPath": "C:/tmp/evil.zip" }
    });
    let e = validate_params(WebMethod::ToolsCall, &params).unwrap_err();
    assert_eq!(e.code, codes::PATH_TARGET_FORBIDDEN);
}

#[test]
fn resource_read_requires_kojo_uri() {
    let ok = json!({ "uri": "kojo://resource/a.txt" });
    assert!(validate_params(WebMethod::ResourcesRead, &ok).is_ok());
    let bad = json!({ "uri": "file:///etc/passwd" });
    let e = validate_params(WebMethod::ResourcesRead, &bad).unwrap_err();
    assert_eq!(e.code, codes::PATH_SCHEME);
}

#[test]
fn tool_name_gate_keeps_market_fail_closed() {
    assert!(validate_tool_name("read_file").is_ok());
    assert!(validate_tool_name("market_fetch_text").is_err());
    assert_eq!(
        validate_tool_name("market_fetch_text").unwrap_err().code,
        codes::TOOL_FAIL_CLOSED
    );
    assert!(validate_tool_name("../escape").is_err());
}

#[test]
fn privileged_detection_matches_contract() {
    for name in [
        "launcher_start",
        "market_publish",
        "open_url_external",
        "export_file",
        "remove_file",
        "rename_path",
        // 工具面真实存在的两个破坏性工具（命名空间带点），按精确名判 privileged。
        "fileTree.remove",
        "fileTree.rename",
    ] {
        assert!(is_privileged_tool(name), "{name}");
    }
    assert!(is_market_tool("market_fetch"));
    assert!(!is_privileged_tool("read_file"));
}

/// 命令面板动作（点号命名空间）在宿主侧同样是 privileged：WebView 主闸之外
/// 的第二道纵深。修复前 `host_required_tier("workbench.saveAll")` 判 Read，
/// `filter_tools_list` / `check_tool_call_permission` 两道闸都会整条跳过。
#[test]
fn command_panel_actions_are_privileged_in_host_gate() {
    for name in [
        "workbench.saveAll",
        "workbench.saveAs",
        "workbench.openProjectFolder",
        "workbench.checkUpdates",
        "launcher.openInstances",
        "editor.action.formatDocument",
        "editor.action.replace",
        "editor.fontZoomIn",
        "layout.toggleSidebar",
        "bookmarks.toggle",
    ] {
        assert!(is_command_panel_tool(name), "{name}");
        assert!(is_privileged_tool(name), "{name}");
        assert_eq!(host_required_tier(name), McpTier::Privileged, "{name}");
        assert!(
            check_tool_call_permission(name, &empty_scope(Vec::new())).is_err(),
            "{name} 未获精确批准却放行了"
        );
    }
    // 冻结契约 v1 的具名工具面（与 `tools/mcp-inventory.mjs --print` 的
    // coverage.tools.names 对拍）：一个都不能被命令面板前缀误伤。新增具名工具时同步补表。
    const NAMED_TOOLS: &[&str] = &[
        "semantic.definitionAt",
        "semantic.referencesAt",
        "semantic.diagnostics",
        "semantic.hoverAt",
        "semantic.suggestAt",
        "semantic.documentSymbols",
        "semantic.tokens",
        "semantic.codeActionsAt",
        "project.info",
        "fs.tree",
        "search.all",
        "workspace.searchAll",
        "problems.quickFix",
        "problems.diagnostics",
        "fileTree.create",
        "fileTree.update",
        "fileTree.remove",
        "fileTree.rename",
        "diff.compare",
        "state.replay",
        "preview.document",
        "commands.list",
        "document.active",
        "fs.readFile",
        "fs.stat",
        "io.listDir",
        "io.workspaceRoots",
        "editor.info",
        "editor.selfCheck",
        "lang.foldingRanges",
        "lang.highlightsAt",
        "lang.signatureAt",
        "lang.markers",
    ];
    for &name in NAMED_TOOLS {
        assert!(!is_command_panel_tool(name), "{name} 被误判成命令面板动作");
        // 只有冻结危险名单里的两个精确名可以是 privileged，其余一律不得被抬级。
        let dangerous = matches!(name, "fileTree.remove" | "fileTree.rename");
        assert_eq!(
            is_privileged_tool(name),
            dangerous,
            "{name} 的宿主分级偏离冻结契约"
        );
    }
    // 只读具名工具仍能在 read 会话通过 tools/call 闸门。
    for name in [
        "editor.info",
        "editor.selfCheck",
        "project.info",
        "fs.readFile",
        "semantic.definitionAt",
        "io.listDir",
        "lang.markers",
        "commands.list",
    ] {
        assert_eq!(host_required_tier(name), McpTier::Read, "{name}");
        assert!(
            check_tool_call_permission(name, &empty_scope(Vec::new())).is_ok(),
            "{name}"
        );
    }

    // tools/list 二次过滤：tier=privileged 也不等于放行，须精确批准。
    let result = json!({"tools":[
        {"name":"editor.info"},
        {"name":"workbench.saveAll"},
        {"name":"launcher.openInstances"}
    ]});
    let denied = filter_tools_list(
        &result,
        &McpSessionScope {
            tier: McpTier::Privileged,
            ..empty_scope(Vec::new())
        },
    );
    assert_eq!(names_of(&denied.result), vec!["editor.info"]);
    assert_eq!(denied.filtered.len(), 2);

    let approved = filter_tools_list(
        &result,
        &McpSessionScope {
            tier: McpTier::Privileged,
            ..empty_scope(vec!["workbench.saveAll".to_string()])
        },
    );
    let names = names_of(&approved.result);
    assert!(names.contains(&"workbench.saveAll"));
    assert!(!names.contains(&"launcher.openInstances"));
}

#[test]
fn approved_tool_matches_exact_or_prefix() {
    let scope = empty_scope(vec!["export_file".to_string(), "read_*".to_string()]);
    assert!(approved_tool("export_file", &scope));
    assert!(approved_tool("read_bytes", &scope));
    assert!(!approved_tool("launcher_start", &scope));
}

#[test]
fn filter_tools_list_drops_unapproved_privileged() {
    let scope = empty_scope(Vec::new());
    let result = json!({
        "tools": [
            {"name": "read_file", "description": "ok"},
            {"name": "export_file"},
            {"name": "market_fetch_text"},
            {"name": "launcher_start"},
            {"name": "remove_file"}
        ]
    });
    let out = filter_tools_list(&result, &scope);
    let names: Vec<&str> = out.result["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["read_file"]);
    assert_eq!(out.filtered.len(), 4);
    assert!(out.filtered.contains(&"market_fetch_text".to_string()));

    // scope 显式批准后放行（market 仍 fail-closed）。
    let approved = empty_scope(vec![
        "export_file".to_string(),
        "market_fetch_text".to_string(),
    ]);
    let out2 = filter_tools_list(&result, &approved);
    let names2: Vec<&str> = out2.result["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(names2.contains(&"export_file"));
    assert!(!names2.contains(&"market_fetch_text"));
}

#[test]
fn sanitize_untrusted_caps_and_strips_control() {
    let raw = json!({
        "tools": [{"name": "x", "description": "a\u{0000}b"}],
        "content": "x".repeat(MAX_UNTRUSTED_CHARS + 100)
    });
    let clean = sanitize_untrusted(&raw);
    assert!(!clean["tools"][0]["description"]
        .as_str()
        .unwrap()
        .contains('\0'));
    let body = clean["content"].as_str().unwrap();
    assert!(body.chars().count() <= MAX_UNTRUSTED_CHARS + "…[truncated]".chars().count());
}

#[test]
fn negotiate_is_stateless_and_merges_meta() {
    let params = json!({
        "protocolVersion": "2025-06-18",
        "capabilities": {"roots": {"listChanged": true}},
        "clientInfo": {"name": "harness"}
    });
    let neg = negotiate(&params);
    assert_eq!(neg.protocol_version, "2025-06-18");
    let mut result = json!({"tools": [], "_meta": {"keep": 1}});
    attach_negotiation_meta(&mut result, &neg);
    assert_eq!(result["_meta"]["keep"], json!(1));
    assert_eq!(
        result["_meta"]["io.modelcontextprotocol/protocolVersion"],
        json!("2025-06-18")
    );

    let init = initialize_result(&neg, &params);
    assert_eq!(init["protocolVersion"], json!("2025-06-18"));
    assert_eq!(
        init["_meta"]["io.modelcontextprotocol/clientInfo"]["name"],
        json!("harness")
    );

    // 未知版本 ⇒ 回当前版，不沿用。
    let fallback = negotiate(&json!({"protocolVersion": "1999-01-01"}));
    assert_eq!(fallback.protocol_version, PROTOCOL_VERSION);
}

#[test]
fn tier_and_outcome_labels() {
    assert_eq!(McpTier::Read.as_str(), "read");
    assert_eq!(McpTier::Edit.as_str(), "edit");
    assert_eq!(McpTier::Privileged.as_str(), "privileged");
    assert_eq!(AuditOutcome::Ok.as_str(), "ok");
    assert_eq!(AuditOutcome::Filtered.as_str(), "filtered");
    assert_eq!(AuditOutcome::Denied.as_str(), "denied");
    assert_eq!(AuditOutcome::Cancelled.as_str(), "cancelled");
}

/* ------------------------------ scope ------------------------------ */

#[test]
fn scope_roundtrip_and_minimum_default() {
    let d = TempDir::new();
    assert_eq!(scope::load(d.path()).unwrap().sessions.len(), 0);
    let built = scope::build_scope(&scope::load(d.path()).unwrap(), "client-1", "sess-1").unwrap();
    assert_eq!(built.tier, McpTier::Read);
    assert!(built.approved_roots.is_empty());
    assert!(built.approved_tools.is_empty());

    let state = scope::McpScopeState {
        version: scope::SCOPE_VERSION,
        sessions: vec![SessionGrant {
            client_id: "client-1".to_string(),
            tier: McpTier::Edit,
            approved_roots: vec!["docs".to_string()],
            approved_tools: vec!["read_*".to_string()],
            approved_root_ids: vec![],
            created_at: crate::launcher::iso_now(),
            revoked_at: None,
        }],
    };
    scope::save(d.path(), &state).unwrap();
    let loaded = scope::load(d.path()).unwrap();
    assert_eq!(loaded.sessions.len(), 1);
    let built = scope::build_scope(&loaded, "client-1", "sess-1").unwrap();
    assert_eq!(built.tier, McpTier::Edit);
    assert_eq!(built.approved_tools, vec!["read_*".to_string()]);
}

#[test]
fn scope_rejects_tampered_grant() {
    let d = TempDir::new();
    let bad_root = scope::McpScopeState {
        version: scope::SCOPE_VERSION,
        sessions: vec![SessionGrant {
            client_id: "c".to_string(),
            tier: McpTier::Read,
            approved_roots: vec!["../escape".to_string()],
            approved_tools: vec![],
            approved_root_ids: vec![],
            created_at: crate::launcher::iso_now(),
            revoked_at: None,
        }],
    };
    scope::save(d.path(), &bad_root).unwrap();
    assert_eq!(
        scope::build_scope(&bad_root, "c", "s").unwrap_err().code,
        codes::PATH_ESCAPE
    );
    assert!(scope::approve(
        d.path(),
        "c",
        McpTier::Read,
        vec![],
        vec!["market_fetch".to_string()]
    )
    .is_err());
}

#[test]
fn approve_then_revoke_falls_back_to_minimum() {
    let d = TempDir::new();
    let state = scope::approve(
        d.path(),
        "client-1",
        McpTier::Privileged,
        vec!["docs".to_string()],
        vec!["export_file".to_string()],
    )
    .unwrap();
    let built = scope::build_scope(&state, "client-1", "sess-1").unwrap();
    assert_eq!(built.tier, McpTier::Privileged);
    assert!(built.approved_tools.contains(&"export_file".to_string()));

    let revoked = scope::revoke(d.path(), "client-1").unwrap();
    let built = scope::build_scope(&revoked, "client-1", "sess-1").unwrap();
    assert_eq!(built.tier, McpTier::Read);
    assert!(built.approved_tools.is_empty());
    // revoke 留痕：旧记录标 revokedAt，不物理删。
    assert!(revoked.sessions.iter().all(|g| g.revoked_at.is_some()));
}

/* ------------------------------ audit ------------------------------ */

#[test]
fn digest_args_never_leaks_content() {
    let args = json!({
        "name": "write",
        "arguments": {"content": "IGNORE PREVIOUS INSTRUCTIONS; secret-token-42"},
        "path": "docs/a.txt"
    });
    let digest = audit::digest_args(&args);
    assert!(!digest.contains("IGNORE"));
    assert!(!digest.contains("secret-token-42"));
    assert!(digest.contains("content:str("));
}

fn sample_entry(outcome: AuditOutcome, tool: &str) -> AuditEntry {
    AuditEntry {
        ts: crate::launcher::iso_now(),
        client_id: "client-1".to_string(),
        session_id: "sess-1".to_string(),
        tool: tool.to_string(),
        args_digest: "name:str(4)".to_string(),
        outcome,
        landed_path: None,
        // 无真源 ⇒ 该格缺席（`skip_serializing_if`），不写估算值冒充实测。
        elapsed_ms: None,
        note: None,
    }
}

#[test]
fn audit_append_query_and_corrupt_line() {
    let d = TempDir::new();
    audit::append(d.path(), &sample_entry(AuditOutcome::Ok, "read_file")).unwrap();
    audit::append(
        d.path(),
        &sample_entry(AuditOutcome::Filtered, "export_file"),
    )
    .unwrap();
    std::fs::write(
        audit::audit_path(d.path()).with_extension("jsonl.bak"),
        "ignored",
    )
    .unwrap();
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(audit::audit_path(d.path()))
            .unwrap();
        writeln!(f, "{{broken").unwrap();
    }
    let rows = audit::query(d.path(), 10, None).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].outcome, AuditOutcome::Filtered);
    let only_read = audit::query(d.path(), 10, Some("client-1")).unwrap();
    assert_eq!(only_read.len(), 2);
    assert!(audit::query(d.path(), 10, Some("other"))
        .unwrap()
        .is_empty());
}

/* ------------------------------ server 纯判据 ------------------------------ */

fn head_with(auth: &str, origin: Option<&str>) -> HttpHead {
    let mut headers = HashMap::new();
    headers.insert("authorization".to_string(), auth.to_string());
    if let Some(o) = origin {
        headers.insert("origin".to_string(), o.to_string());
    }
    HttpHead {
        method: "POST".to_string(),
        target: "/mcp".to_string(),
        headers,
        body: Vec::new(),
    }
}

#[test]
fn parse_head_text_normalizes_headers() {
    let text = "POST /mcp HTTP/1.1\r\nAuthorization: Bearer tok\r\nOrigin: http://127.0.0.1\r\nContent-Length: 0\r\n\r\n";
    let (method, target, headers) = server::parse_head_text(text).unwrap();
    assert_eq!(method, "POST");
    assert_eq!(target, "/mcp");
    assert_eq!(headers.get("authorization").unwrap(), "Bearer tok");
    assert_eq!(headers.get("content-length").unwrap(), "0");
    assert!(server::parse_head_text("POST /mcp HTTP/2\r\n\r\n").is_err());
}

#[test]
fn origin_allowlist_is_strict() {
    for ok in [
        "http://127.0.0.1",
        "http://127.0.0.1:5173",
        "http://localhost",
        "http://localhost:8080",
        "http://[::1]:1234",
    ] {
        assert!(server::check_origin(Some(ok)).is_ok(), "{ok}");
    }
    for bad in [
        "http://evil.example",
        "https://127.0.0.1",
        "http://127.0.0.1.evil.example",
        "null",
    ] {
        assert!(server::check_origin(Some(bad)).is_err(), "{bad}");
    }
    assert!(server::check_origin(None).is_err());
}

#[test]
fn bearer_and_origin_three_gates() {
    let peer: SocketAddr = ([127, 0, 0, 1], 4321).into();
    let good = head_with("Bearer tok", Some("http://127.0.0.1"));
    assert!(server::authenticate(&good, "tok", peer).is_ok());
    assert!(server::authenticate(&good, "wrong", peer).is_err());
    let no_origin = head_with("Bearer tok", None);
    assert!(server::authenticate(&no_origin, "tok", peer).is_err());
    let no_bearer = head_with("tok", Some("http://127.0.0.1"));
    assert!(server::authenticate(&no_bearer, "tok", peer).is_err());
    let remote: SocketAddr = ([10, 0, 0, 1], 4321).into();
    assert!(server::authenticate(&good, "tok", remote).is_err());
    assert!(!server::constant_time_eq(b"abc", b"abd"));
    assert!(server::constant_time_eq(b"abc", b"abc"));
}

#[test]
fn rate_limit_window() {
    // B5 起速率闸按会话计量：同一会话键两格放行、第三格显式 E_RATE_LIMITED。
    let limits = Limits {
        max_calls_per_minute: 2,
        ..Limits::default()
    };
    let rate = Mutex::new(RateGovernor::default());
    assert!(server::check_rate(&rate, &limits, "sess-a").is_ok());
    assert!(server::check_rate(&rate, &limits, "sess-a").is_ok());
    assert_eq!(
        server::check_rate(&rate, &limits, "sess-a")
            .unwrap_err()
            .code,
        codes::RATE_LIMITED
    );
    // 全局硬顶＝`max_calls_per_minute` 本身：换一条会话键**也**必须被拒
    // （端点每分钟接受的总量与旧全局单计数器逐字同值，不许因按会话计量而放大）。
    assert_eq!(
        server::check_rate(&rate, &limits, "sess-b")
            .unwrap_err()
            .code,
        codes::RATE_LIMITED
    );
}

#[test]
fn discovery_file_lifecycle() {
    let d = TempDir::new();
    let file = EndpointFile {
        port: 43210,
        token: "hex-token".to_string(),
        endpoint: "http://127.0.0.1:43210/mcp".to_string(),
    };
    server::write_discovery(d.path(), &file).unwrap();
    let text = std::fs::read_to_string(scope::endpoint_path(d.path())).unwrap();
    let parsed: EndpointFile = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed.port, 43210);
    assert_eq!(parsed.endpoint, file.endpoint);
    server::remove_discovery(d.path());
    assert!(!scope::endpoint_path(d.path()).exists());
    server::remove_discovery(d.path()); // 幂等
}

/* ==================================================================== *
 * 路 C 硬化批（协议一致性 / 路径闸 / 纵深防御 / 端点级验证）
 * ==================================================================== */

/* ---------------------- 协议一致性：错误码与握手 ---------------------- */

#[test]
fn json_rpc_error_codes_align_with_spec() {
    for (code, num) in [
        (codes::PARSE, -32700),
        (codes::INVALID_REQUEST, -32600),
        (codes::METHOD_NOT_FOUND, -32601),
        (codes::INVALID_PARAMS, -32602),
        (codes::INTERNAL, -32603),
    ] {
        let e = McpError::new(code, "可读错误消息");
        assert_eq!(e.numeric_code(), num, "{code}");
        let jr = e.to_json_rpc();
        assert_eq!(jr.code, num, "{code}");
        assert!(!jr.message.is_empty(), "{code}");
        assert_eq!(jr.data.as_ref().unwrap()["code"], json!(code));
    }
    // 宿主自定义码统一落到 -32000，且逐条显式、附可读 message。
    for code in [
        codes::UNAUTHORIZED,
        codes::PATH_ESCAPE,
        codes::TOOL_NOT_APPROVED,
        codes::UNSUPPORTED_PROTOCOL_VERSION,
    ] {
        let e = McpError::new(code, "显式说明");
        assert_eq!(e.numeric_code(), -32000, "{code}");
        assert!(!e.to_json_rpc().message.is_empty());
    }
}

#[test]
fn decode_error_codes_are_structured() {
    assert_eq!(decode_request(b"{").unwrap_err().code, codes::PARSE);
    assert_eq!(
        decode_request(br#"{"jsonrpc":"1.0","method":"ping"}"#)
            .unwrap_err()
            .code,
        codes::INVALID_REQUEST
    );
    assert_eq!(
        decode_request(br#"{"jsonrpc":"2.0","id":1,"method":"ping","params":3}"#)
            .unwrap_err()
            .code,
        codes::INVALID_PARAMS
    );
}

#[test]
fn unknown_method_returns_method_not_found() {
    let env = decode_request(br#"{"jsonrpc":"2.0","id":7,"method":"fs/write_anywhere"}"#)
        .unwrap()
        .pop()
        .unwrap();
    match classify_envelope(&env) {
        LocalOutcome::Respond(r) => {
            assert_eq!(r.id, json!(7));
            assert!(r.result.is_none());
            let e = r.error.unwrap();
            assert_eq!(e.code, -32601);
            assert!(!e.message.is_empty());
            assert_eq!(e.data.unwrap()["code"], json!(codes::METHOD_NOT_FOUND));
        }
        _ => panic!("未知方法必须回 method-not-found 响应帧"),
    }
}

#[test]
fn initialize_handshake_is_compatible_and_stateless() {
    let env = decode_request(
        br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"legacy"}}}"#,
    )
    .unwrap()
    .pop()
    .unwrap();
    let r = match classify_envelope(&env) {
        LocalOutcome::Respond(r) => r,
        _ => panic!("initialize 必须作答"),
    };
    assert!(r.error.is_none());
    let result = r.result.unwrap();
    assert_eq!(result["protocolVersion"], json!("2024-11-05"));
    assert!(result["capabilities"]["tools"].is_object());
    assert!(result["capabilities"]["resources"].is_object());
    assert!(result["capabilities"]["prompts"].is_object());
    assert_eq!(result["serverInfo"]["name"], json!(SERVER_NAME));
    assert_eq!(result["serverInfo"]["version"], json!(SERVER_VERSION));
    // 不要求 session id：响应里不编造任何会话状态。
    let lower = serde_json::to_string(&result).unwrap().to_ascii_lowercase();
    assert!(!lower.contains("sessionid"));
    assert!(!lower.contains("mcp-session-id"));
}

#[test]
fn ping_returns_empty_result() {
    let env = decode_request(br#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#)
        .unwrap()
        .pop()
        .unwrap();
    match classify_envelope(&env) {
        LocalOutcome::Respond(r) => {
            assert_eq!(r.id, json!(2));
            assert!(r.error.is_none());
            assert_eq!(r.result.unwrap(), json!({}));
        }
        _ => panic!("ping 必须作答"),
    }
}

#[test]
fn notifications_never_produce_response_frames() {
    for method in [
        "notifications/initialized",
        "notifications/cancelled",
        "notifications/progress",
    ] {
        let no_id = format!(r#"{{"jsonrpc":"2.0","method":"{method}"}}"#);
        let env = decode_request(no_id.as_bytes()).unwrap().pop().unwrap();
        assert!(
            matches!(classify_envelope(&env), LocalOutcome::NoResponse),
            "{method} 无 id"
        );
        let with_id = format!(r#"{{"jsonrpc":"2.0","id":9,"method":"{method}"}}"#);
        let env2 = decode_request(with_id.as_bytes()).unwrap().pop().unwrap();
        assert!(
            matches!(classify_envelope(&env2), LocalOutcome::NoResponse),
            "{method} 带 id 也按通知处理"
        );
    }
    // 任何无 id 的 JSON-RPC 通知（含六种能力方法）也不回帧。
    let env3 = decode_request(br#"{"jsonrpc":"2.0","method":"tools/list","params":{}}"#)
        .unwrap()
        .pop()
        .unwrap();
    assert!(matches!(classify_envelope(&env3), LocalOutcome::NoResponse));
    let env4 = decode_request(br#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#)
        .unwrap()
        .pop()
        .unwrap();
    assert!(matches!(classify_envelope(&env4), LocalOutcome::NoResponse));
}

#[test]
fn batch_mixed_notifications_only_answers_id_bearing() {
    let batch = br#"[
        {"jsonrpc":"2.0","id":1,"method":"ping"},
        {"jsonrpc":"2.0","method":"notifications/initialized"},
        {"jsonrpc":"2.0","id":"b","method":"initialize","params":{"protocolVersion":"2025-03-26"}},
        {"jsonrpc":"2.0","method":"notifications/progress"}
    ]"#;
    let envs = decode_request(batch).unwrap();
    assert_eq!(envs.len(), 4); // decode 不丢条目（既有用例别回退）
    let responses: Vec<JsonRpcResponse> = envs
        .iter()
        .filter_map(|e| match classify_envelope(e) {
            LocalOutcome::Respond(r) => Some(r),
            _ => None,
        })
        .collect();
    assert_eq!(responses.len(), 2);
    assert_eq!(responses[0].id, json!(1));
    assert_eq!(responses[1].id, json!("b"));

    // 全通知 batch ⇒ 零响应帧（对应 HTTP 202 无响应体）。
    let all_notify = br#"[{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"x"}}]"#;
    let envs2 = decode_request(all_notify).unwrap();
    assert!(envs2
        .iter()
        .all(|e| matches!(classify_envelope(e), LocalOutcome::NoResponse)));

    // 能力方法（有 id）转 WebView；通知仍不回帧。
    let with_bridge = decode_request(
        br#"[{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}},{"jsonrpc":"2.0","method":"notifications/initialized"}]"#,
    )
    .unwrap();
    assert!(matches!(
        classify_envelope(&with_bridge[0]),
        LocalOutcome::NeedsBridge(WebMethod::ToolsList)
    ));
    assert!(matches!(
        classify_envelope(&with_bridge[1]),
        LocalOutcome::NoResponse
    ));
}

#[test]
fn protocol_version_header_is_validated() {
    assert!(check_protocol_version(None).is_ok());
    assert!(check_protocol_version(Some(PROTOCOL_VERSION)).is_ok());
    assert!(check_protocol_version(Some(" 2026-07-28 ")).is_ok());
    for v in LEGACY_VERSIONS {
        assert!(check_protocol_version(Some(v)).is_ok(), "{v}");
    }
    for bad in ["1999-01-01", "2026-07-29", "", "2025-06-18; charset=utf-8"] {
        let e = check_protocol_version(Some(bad)).unwrap_err();
        assert_eq!(e.code, codes::UNSUPPORTED_PROTOCOL_VERSION, "{bad}");
        assert!(e.message.contains("不支持"));
    }
}

#[test]
fn accept_negotiation_is_correct() {
    assert_eq!(negotiate_accept(None).unwrap(), AcceptKind::Json);
    assert_eq!(
        negotiate_accept(Some("application/json")).unwrap(),
        AcceptKind::Json
    );
    assert_eq!(
        negotiate_accept(Some("text/event-stream")).unwrap(),
        AcceptKind::Sse
    );
    assert_eq!(
        negotiate_accept(Some("application/json, text/event-stream")).unwrap(),
        AcceptKind::Sse
    );
    assert_eq!(
        negotiate_accept(Some("application/json;q=1, text/event-stream;q=0.5")).unwrap(),
        AcceptKind::Sse
    );
    assert_eq!(negotiate_accept(Some("*/*")).unwrap(), AcceptKind::Json);
    for bad in ["text/plain", "application/xml", ""] {
        let e = negotiate_accept(Some(bad)).unwrap_err();
        assert_eq!(e.code, codes::INVALID_REQUEST, "{bad}");
        assert!(!e.message.is_empty());
    }
}

#[test]
fn session_id_header_is_opaque_label() {
    let mut h = head_with("Bearer tok", Some("http://127.0.0.1"));
    assert_eq!(server::session_id_from_head(&h), "stateless");
    h.headers.insert(
        "mcp-session-id".to_string(),
        "legacy-session-42".to_string(),
    );
    assert_eq!(server::session_id_from_head(&h), "legacy-session-42");
    h.headers
        .insert("mcp-session-id".to_string(), "bad\0session".to_string());
    assert_eq!(server::session_id_from_head(&h), "stateless");
    h.headers
        .insert("mcp-session-id".to_string(), "x".repeat(65));
    assert_eq!(server::session_id_from_head(&h), "stateless");

    // 会话 id 不具授权语义：不同 sessionId 生成完全相同的 scope。
    let empty = scope::McpScopeState::default();
    let a = scope::build_scope(&empty, "client-1", "stateless").unwrap();
    let b = scope::build_scope(&empty, "client-1", "legacy-session-42").unwrap();
    assert_eq!(a.tier, b.tier);
    assert_eq!(a.approved_tools, b.approved_tools);
    assert_eq!(a.approved_roots, b.approved_roots);

    // 授权只由 clientId + 第四张表决定。
    let d = TempDir::new();
    let granted = scope::approve(
        d.path(),
        "client-1",
        McpTier::Edit,
        vec!["docs".to_string()],
        vec!["read_*".to_string()],
    )
    .unwrap();
    assert_eq!(
        scope::build_scope(&granted, "client-1", "any-session")
            .unwrap()
            .tier,
        McpTier::Edit
    );
    assert_eq!(
        scope::build_scope(&granted, "other-client", "any-session")
            .unwrap()
            .tier,
        McpTier::Read
    );
}

#[test]
fn response_head_never_fabricates_session_state() {
    let head = server::response_head(200, "application/json", 12);
    let lower = head.to_ascii_lowercase();
    assert!(lower.contains("mcp-protocol-version: 2026-07-28"));
    assert!(lower.contains("cache-control: no-store"));
    assert!(lower.contains("x-content-type-options: nosniff"));
    assert!(!lower.contains("mcp-session-id"));
    assert!(!lower.contains("set-cookie"));
    assert!(!lower.contains("sessionid"));
    assert!(server::response_head(200, "text/event-stream", 0)
        .contains("Content-Type: text/event-stream"));
}

#[test]
fn mcp_surface_has_no_audit_write_entry() {
    for m in WEB_METHOD_NAMES {
        let lower = m.to_ascii_lowercase();
        assert!(!lower.contains("audit"), "{m}");
        assert!(!lower.contains("log"), "{m}");
    }
    for m in [
        "audit/append",
        "audit/clear",
        "logging/setLevel",
        "mcp/write_audit",
    ] {
        assert_eq!(route(m), Route::Unknown, "{m}");
    }
}

/* ---------------------- 路径闸：逐形态 fail closed ---------------------- */

#[test]
fn path_gate_unc_and_absolute_prefixes_fail_closed() {
    for bad in [
        r"\\server\share\x",
        r"//server/share/x",
        r"/abs/x",
        r"\\?\C:\x",
    ] {
        assert_eq!(
            validate_relative_path(bad).unwrap_err().code,
            codes::PATH_ESCAPE,
            "{bad:?}"
        );
    }
}

#[test]
fn path_gate_drive_letter_and_ads_fail_closed() {
    for bad in ["C:/x", r"D:\x", "C:x", "file.txt:stream", "a:b", "kojo://x"] {
        assert_eq!(
            validate_relative_path(bad).unwrap_err().code,
            codes::PATH_ESCAPE,
            "{bad:?}"
        );
    }
}

#[test]
fn path_gate_url_encoded_traversal_fail_closed() {
    for bad in [
        "a/%2e%2e/b",
        "a%5cb",
        "%2Fetc/passwd",
        "a/%2E%2E%2Fetc",
        "docs/%5c..%5csecret",
    ] {
        assert_eq!(
            validate_relative_path(bad).unwrap_err().code,
            codes::PATH_ESCAPE,
            "{bad:?}"
        );
    }
    // 任意键名下的编码形状也由全局扫描拦下。
    let params = json!({"name":"read_file","arguments":{"note":"%2e%2e%2fetc"}});
    assert_eq!(
        validate_params(WebMethod::ToolsCall, &params)
            .unwrap_err()
            .code,
        codes::PATH_ESCAPE
    );
}

#[test]
fn path_gate_double_encoding_fail_closed() {
    for bad in ["%252e%252e/b", "a%255cb", "%252fetc", "%25252e%25252e"] {
        assert_eq!(
            validate_relative_path(bad).unwrap_err().code,
            codes::PATH_ESCAPE,
            "{bad:?}"
        );
    }
    let params = json!({"name":"read_file","arguments":{"note":"%252e%252e"}});
    assert_eq!(
        validate_params(WebMethod::ToolsCall, &params)
            .unwrap_err()
            .code,
        codes::PATH_ESCAPE
    );
}

#[test]
fn path_gate_nul_control_and_invisible_chars_fail_closed() {
    for bad in [
        "a\0b",
        "a\nb",
        "a\tb",
        "a\rb",
        "a\u{7f}b",
        "a\u{85}b",
        "a\u{202e}b",
        "a\u{200b}b",
        "a\u{feff}b",
    ] {
        assert_eq!(
            validate_relative_path(bad).unwrap_err().code,
            codes::PATH_ESCAPE,
            "{bad:?}"
        );
    }
}

#[test]
fn path_gate_dot_segments_fail_closed() {
    for bad in [
        ".", "..", "a/./b", "a/../b", "a//b", "a/", "/a", "...", "a/.../b", "a/. /b",
    ] {
        assert_eq!(
            validate_relative_path(bad).unwrap_err().code,
            codes::PATH_ESCAPE,
            "{bad:?}"
        );
    }
}

#[test]
fn path_gate_overlong_fail_closed() {
    let whole = "a".repeat(MAX_PATH_CHARS + 1);
    assert_eq!(
        validate_relative_path(&whole).unwrap_err().code,
        codes::PATH_ESCAPE
    );
    let component = format!("ok/{}", "b".repeat(MAX_PATH_COMPONENT_CHARS + 1));
    assert_eq!(
        validate_relative_path(&component).unwrap_err().code,
        codes::PATH_ESCAPE
    );
}

#[test]
fn path_gate_mixed_slashes_fail_closed() {
    for bad in [r"a\b/c", r"src\main.ts", r"a/b\c", r"..\..\etc", r"a\..\b"] {
        assert_eq!(
            validate_relative_path(bad).unwrap_err().code,
            codes::PATH_ESCAPE,
            "{bad:?}"
        );
    }
}

#[test]
fn path_gate_trailing_space_or_dot_fail_closed() {
    for bad in ["a/b.", "a/b ", "a/ ", "a/b..", "a/b. ", "CON.", "a/b\t "] {
        assert_eq!(
            validate_relative_path(bad).unwrap_err().code,
            codes::PATH_ESCAPE,
            "{bad:?}"
        );
    }
}

#[test]
fn path_gate_device_names_extended_fail_closed() {
    for bad in [
        "CON", "con.txt", "PRN", "AUX", "NUL", "COM1", "LPT9", "CONIN$", "CONOUT$", "COM0",
    ] {
        assert_eq!(
            validate_relative_path(bad).unwrap_err().code,
            codes::PATH_ESCAPE,
            "{bad}"
        );
    }
}

#[test]
fn kojo_uri_gate_rejects_encoded_and_control_shapes() {
    for bad in [
        "kojo://a/%2e%2e/b",
        "kojo://a%5cb",
        "kojo://a\u{202e}b",
        "kojo://a\0b",
        "kojo://a/b.",
        "kojo://a/CON",
        "kojo://a/~x",
    ] {
        assert!(validate_kojo_uri(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn forbidden_target_keys_reject_obfuscated_aliases() {
    for key in [
        "outputPath",
        "output.path",
        "Output-Dir",
        "DEST_PATH",
        "save As",
        "destinationFolder",
        "dropFolder",
        "moveTo",
        "copyTo",
        "newFile",
        "downloadTo",
        "artifactDir",
        "landingZip",
        "writeDestination",
    ] {
        let mut arguments = serde_json::Map::new();
        arguments.insert(key.to_string(), json!("docs/ok.txt"));
        let params = json!({
            "name": "some_tool",
            "arguments": serde_json::Value::Object(arguments)
        });
        assert_eq!(
            validate_params(WebMethod::ToolsCall, &params)
                .unwrap_err()
                .code,
            codes::PATH_TARGET_FORBIDDEN,
            "{key}"
        );
    }
    // 深层嵌套 / 数组里也扫到。
    let nested = json!({"name":"t","arguments":{"deep":{"list":[{"outputPath":"x"}]}}});
    assert_eq!(
        validate_params(WebMethod::ToolsCall, &nested)
            .unwrap_err()
            .code,
        codes::PATH_TARGET_FORBIDDEN
    );
    // 合法参数不误伤：正文里出现盘符字面量、timeout/newText/writeContent 都放行。
    let ok = json!({
        "name":"read_file",
        "arguments":{
            "content":"C:/tmp appears in text",
            "timeout":30,
            "newText":"x",
            "writeContent":"y",
            "path":"docs/a.txt"
        }
    });
    assert!(validate_params(WebMethod::ToolsCall, &ok).is_ok());
}

#[test]
fn mcp_never_accepts_export_landing_path() {
    // export_file 即便被显式批准，也不能经 MCP 传任何落点路径：
    // 「系统对话框 + 写盘绑在同一 Rust 命令」是唯一法定绕开写允许域通道，
    // 绝不复用 debug-server 自动落 sandbox/exports 的应答。
    let scope = empty_scope(vec!["export_file".to_string()]);
    assert!(check_tool_call_permission("export_file", &scope).is_ok());
    for key in [
        "outputPath",
        "destination",
        "exportPath",
        "targetPath",
        "saveAs",
    ] {
        let mut arguments = serde_json::Map::new();
        arguments.insert(key.to_string(), json!("C:/Users/me/exports/out.zip"));
        arguments.insert("landingPath".to_string(), json!("sandbox/exports/out.zip"));
        let params = json!({
            "name":"export_file",
            "arguments": serde_json::Value::Object(arguments)
        });
        assert_eq!(
            validate_params(WebMethod::ToolsCall, &params)
                .unwrap_err()
                .code,
            codes::PATH_TARGET_FORBIDDEN,
            "{key}"
        );
    }
    // 落点键本身就不合法，与值是不是相对路径无关。
    let relative_landing = json!({"name":"export_file","arguments":{"outputPath":"docs/ok.txt"}});
    assert_eq!(
        validate_params(WebMethod::ToolsCall, &relative_landing)
            .unwrap_err()
            .code,
        codes::PATH_TARGET_FORBIDDEN
    );
    // 且 export_file 默认不进 tools/list。
    let list = json!({"tools":[{"name":"read_file"},{"name":"export_file"}]});
    let out = filter_tools_list(&list, &empty_scope(Vec::new()));
    let names: Vec<&str> = out.result["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["read_file"]);
    assert!(out.filtered.contains(&"export_file".to_string()));
}

#[test]
fn path_gate_still_accepts_legit_relative_paths() {
    for good in [
        "src/main.ts",
        "docs/a/b.txt",
        "a.json",
        ".config/app.json",
        "dir with space/f.txt",
        "a-b_c/d.json",
    ] {
        assert!(validate_relative_path(good).is_ok(), "{good:?}");
    }
    assert!(validate_params(
        WebMethod::ResourcesRead,
        &json!({"uri":"kojo://resource/docs/a.txt?line=3"})
    )
    .is_ok());
}

/* ---------------------- tools/list 与 tools/call 纵深过滤 ---------------------- */

fn names_of(v: &serde_json::Value) -> Vec<&str> {
    v["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect()
}

#[test]
fn filter_tools_list_gates_by_tier() {
    let result = json!({"tools":[
        {"name":"read_file"},
        {"name":"write_bytes"},
        {"name":"edit_buffer"},
        {"name":"replace_range"},
        {"name":"export_file"},
        {"name":"launcher_start"}
    ]});
    let read = McpSessionScope {
        tier: McpTier::Read,
        ..empty_scope(Vec::new())
    };
    assert_eq!(
        names_of(&filter_tools_list(&result, &read).result),
        vec!["read_file"]
    );
    let edit = McpSessionScope {
        tier: McpTier::Edit,
        ..empty_scope(Vec::new())
    };
    assert_eq!(
        names_of(&filter_tools_list(&result, &edit).result),
        vec!["read_file", "write_bytes", "edit_buffer", "replace_range"]
    );
    // tier=privileged 也不等于放行危险工具：privileged 仍需精确批准。
    let priv_scope = McpSessionScope {
        tier: McpTier::Privileged,
        ..empty_scope(Vec::new())
    };
    let filtered = filter_tools_list(&result, &priv_scope);
    let names = names_of(&filtered.result);
    assert!(!names.contains(&"export_file"));
    assert!(!names.contains(&"launcher_start"));
}

#[test]
fn wildcard_never_approves_privileged_tools() {
    let scope = empty_scope(vec![
        "*".to_string(),
        "launcher_*".to_string(),
        "export_*".to_string(),
    ]);
    let result = json!({"tools":[
        {"name":"read_file"},
        {"name":"export_file"},
        {"name":"launcher_start"}
    ]});
    assert_eq!(
        names_of(&filter_tools_list(&result, &scope).result),
        vec!["read_file"]
    );
    assert_eq!(
        check_tool_call_permission("export_file", &scope)
            .unwrap_err()
            .code,
        codes::TOOL_NOT_APPROVED
    );
    assert_eq!(
        check_tool_call_permission("launcher_start", &scope)
            .unwrap_err()
            .code,
        codes::TOOL_NOT_APPROVED
    );
}

#[test]
fn tools_call_denies_unapproved_privileged_with_denied_audit() {
    let scope = empty_scope(Vec::new());
    let e = check_tool_call_permission("export_file", &scope).unwrap_err();
    assert_eq!(e.code, codes::TOOL_NOT_APPROVED);
    assert!(!e.message.is_empty());
    // 显式精确批准后放行。
    let approved = empty_scope(vec!["export_file".to_string()]);
    assert!(check_tool_call_permission("export_file", &approved).is_ok());
    // market 恒 fail-closed（即便在 approvedTools 里也不行）。
    assert_eq!(
        check_tool_call_permission("market_fetch", &approved)
            .unwrap_err()
            .code,
        codes::TOOL_FAIL_CLOSED
    );
    assert!(check_tool_call_permission("read_file", &scope).is_ok());
    // 闸门命中处写的 denied 审计条目序列化形状正确。
    let entry = sample_entry(AuditOutcome::Denied, "export_file");
    assert_eq!(
        serde_json::to_value(&entry).unwrap()["outcome"],
        json!("denied")
    );
}

/// 口径差⑥收口：`tools/call` 闸门与 `filter_tools_list` **同源**按 tier 拒绝。
/// 收口前的实测口径差真身——read 会话（tier=Read、approvedTools 空）猜名直调
/// `write_bytes` 这类宿主推断 Edit 的工具，`check_tool_call_permission` 返回
/// `Ok(())`：端点不拒，只有 `tools/list` 看不见它（mock 靶却发 `-32000
/// TIER_DENIED`）。本测试先钉这一事实，再钉收口后的显式拒绝。
#[test]
fn tools_call_denies_tier_mismatch_from_read_session() {
    let read = empty_scope(Vec::new());
    for name in ["write_bytes", "edit_buffer", "replace_range"] {
        assert_eq!(host_required_tier(name), McpTier::Edit, "{name}");
        let e = check_tool_call_permission(name, &read)
            .err()
            .unwrap_or_else(|| panic!("口径差复现：{name} 在 read 会话被闸门放行（Ok）"));
        // 钉的是线契约字面码（不借常量），与 harness E_TIER_DENIED 口径对拍。
        assert_eq!(e.code, "E_TIER_DENIED", "{name}");
        assert!(e.message.contains(name), "{name} 拒绝必须可见（带工具名）");
    }
    // edit 会话直调 edit 工具：tier 足够，照旧放行。
    let edit = McpSessionScope {
        tier: McpTier::Edit,
        ..empty_scope(Vec::new())
    };
    assert!(check_tool_call_permission("write_bytes", &edit).is_ok());
    // 批准语义零放宽：显式列进 approvedTools（精确或通配）的工具照旧放行，
    // 与 filter_tools_list 的 `approved_tool` 短路同源，收口不得误伤。
    let approved = empty_scope(vec!["write_bytes".to_string()]);
    assert!(check_tool_call_permission("write_bytes", &approved).is_ok());
    let wildcard = empty_scope(vec!["write_*".to_string()]);
    assert!(check_tool_call_permission("write_bytes", &wildcard).is_ok());
    // Wave4 余项⑤（长任务面）：点名归类的精确名档位判据。
    // `tasks.start` / `tasks.cancel` 动的是运行态（起一条真长操作 / 往壳层取消集合写一位），
    // 不是纯读 ⇒ read 会话必须显式拒；`tasks.status` 与 `kojo://tasks` 是轮询读数面 ⇒ 判 read。
    for name in ["tasks.start", "tasks.cancel"] {
        assert_eq!(host_required_tier(name), McpTier::Edit, "{name}");
        let e = check_tool_call_permission(name, &read)
            .err()
            .unwrap_or_else(|| panic!("长任务面档位漏判：{name} 在 read 会话被闸门放行（Ok）"));
        assert_eq!(e.code, "E_TIER_DENIED", "{name}");
        assert!(e.message.contains(name), "{name} 拒绝必须可见（带工具名）");
        assert!(
            e.message.contains("edit"),
            "{name} 拒绝理由必须点明所需档位"
        );
    }
    assert_eq!(host_required_tier("tasks.status"), McpTier::Read);
    assert!(check_tool_call_permission("tasks.status", &read).is_ok());
    // tools/list 同源剔除（与 check 闸同判据，不靠「看不见就当不调」）：
    // read 会话里两枚写/取消档任务工具被滤掉，只读 status 留下。
    let listing = filter_tools_list(
        &json!({"tools": [
            {"name": "tasks.start", "description": "d"},
            {"name": "tasks.status", "description": "d"},
            {"name": "tasks.cancel", "description": "d"}
        ]}),
        &read,
    );
    let kept: Vec<&str> = listing
        .result
        .get("tools")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.get("name").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(
        kept,
        vec!["tasks.status"],
        "read 会话的 tools/list 漏滤任务写面"
    );
    assert_eq!(listing.filtered, vec!["tasks.start", "tasks.cancel"]);
    // edit 会话（正确 tier）三枚照列照调。
    let edit_tasks = McpSessionScope {
        tier: McpTier::Edit,
        ..empty_scope(Vec::new())
    };
    for name in ["tasks.start", "tasks.status", "tasks.cancel"] {
        assert!(
            check_tool_call_permission(name, &edit_tasks).is_ok(),
            "{name}"
        );
    }
    // 只读工具不受新闸影响。
    assert!(check_tool_call_permission("read_file", &read).is_ok());
    // privileged 未批准仍是 E_TOOL_NOT_APPROVED 优先（错误码优先序不变，
    // 与 harness H12 口径对拍）。
    assert_eq!(
        check_tool_call_permission("export_file", &read)
            .unwrap_err()
            .code,
        codes::TOOL_NOT_APPROVED
    );
}

/// Wave4 余项①：点号命名空间的具名 Edit 工具在宿主侧同判 Edit。
/// 修复前 `problems.quickFix` / `fileTree.create` / `fileTree.update` 既不命中
/// 下划线动词前缀表也不在 privileged 表，`host_required_tier` 判 Read——read 会话
/// 猜名直调即是端点后门（后两枚是已接线写腿的既有同型洞，一并堵上）。
/// 钉死：read 直调 ⇒ 显式 `E_TIER_DENIED`（线契约字面码）；批准短路照旧放行；
/// edit/privileged 会话放行；`filter_tools_list` 对 read 会话剔除；
/// privileged 名单不被抬级（冻结契约：具名面只有 remove/rename 危险）。
#[test]
fn dot_namespaced_edit_tools_are_gated_as_edit_at_host_gate() {
    const EDIT_NAMES: &[&str] = &["problems.quickFix", "fileTree.create", "fileTree.update"];
    let read = empty_scope(Vec::new());
    for name in EDIT_NAMES {
        assert!(is_edit_tool(name), "{name} 未进具名 Edit 表");
        assert_eq!(host_required_tier(name), McpTier::Edit, "{name}");
        assert!(!is_privileged_tool(name), "{name} 不得被抬成 privileged");
        let e = check_tool_call_permission(name, &read)
            .err()
            .unwrap_or_else(|| panic!("后门复现：{name} 在 read 会话被端点放行（Ok）"));
        assert_eq!(e.code, "E_TIER_DENIED", "{name}");
        assert!(e.message.contains(name), "{name} 拒绝必须可见（带工具名）");
    }
    // edit 会话放行；privileged 会话覆盖 edit 档。
    let edit = McpSessionScope {
        tier: McpTier::Edit,
        ..empty_scope(Vec::new())
    };
    let priv_scope = McpSessionScope {
        tier: McpTier::Privileged,
        ..empty_scope(Vec::new())
    };
    for name in EDIT_NAMES {
        assert!(
            check_tool_call_permission(name, &edit).is_ok(),
            "{name} edit 会话应放行"
        );
        assert!(
            check_tool_call_permission(name, &priv_scope).is_ok(),
            "{name} privileged 会话应放行"
        );
    }
    // 批准语义零放宽：显式列进 approvedTools（精确或通配）的 read 会话照旧短路放行，
    // 与 write_* 的批准短路同源（check/filter 两道闸一致）。
    let exact = empty_scope(vec!["problems.quickFix".to_string()]);
    assert!(check_tool_call_permission("problems.quickFix", &exact).is_ok());
    let wildcard = empty_scope(vec!["fileTree.*".to_string()]);
    assert!(check_tool_call_permission("fileTree.create", &wildcard).is_ok());
    // tools/list 第二道闸：read 会话看不见这三枚（与 tools/call 同源判定）。
    let result = json!({"tools":[
        {"name":"semantic.codeActionsAt"},
        {"name":"problems.quickFix"},
        {"name":"fileTree.create"},
        {"name":"fileTree.update"}
    ]});
    let filtered = filter_tools_list(&result, &read);
    assert_eq!(names_of(&filtered.result), vec!["semantic.codeActionsAt"]);
    for name in EDIT_NAMES {
        assert!(
            filtered.filtered.iter().any(|f| f == name),
            "{name} 应从 read 会话 tools/list 剔除"
        );
    }
}

#[test]
fn revoke_falls_back_to_minimum_at_endpoint_gates() {
    let d = TempDir::new();
    let approved = scope::approve(
        d.path(),
        "c",
        McpTier::Privileged,
        vec![],
        vec!["export_file".to_string()],
    )
    .unwrap();
    let s = scope::build_scope(&approved, "c", "sess").unwrap();
    assert_eq!(s.tier, McpTier::Privileged);
    assert!(check_tool_call_permission("export_file", &s).is_ok());
    let tools = json!({"tools":[{"name":"read_file"},{"name":"export_file"}]});
    let before = filter_tools_list(&tools, &s);
    assert!(before.filtered.is_empty());
    assert_eq!(before.result["tools"].as_array().unwrap().len(), 2);

    let revoked_state = scope::revoke(d.path(), "c").unwrap();
    let s2 = scope::build_scope(&revoked_state, "c", "sess").unwrap();
    assert_eq!(s2.tier, McpTier::Read);
    assert!(s2.approved_tools.is_empty());
    assert_eq!(
        check_tool_call_permission("export_file", &s2)
            .unwrap_err()
            .code,
        codes::TOOL_NOT_APPROVED
    );
    let after = filter_tools_list(&tools, &s2);
    assert!(after.filtered.contains(&"export_file".to_string()));
    assert_eq!(names_of(&after.result), vec!["read_file"]);
    assert!(revoked_state
        .sessions
        .iter()
        .all(|g| g.revoked_at.is_some()));
}

/* ---------------------- 第四张表 / token 轮换 / 发现文件 ---------------------- */

#[test]
fn scope_save_is_atomic_and_load_rejects_corrupt() {
    let d = TempDir::new();
    let state = scope::McpScopeState {
        version: scope::SCOPE_VERSION,
        sessions: vec![SessionGrant {
            client_id: "c".to_string(),
            tier: McpTier::Edit,
            approved_roots: vec!["docs".to_string()],
            approved_tools: vec!["read_*".to_string()],
            approved_root_ids: vec![],
            created_at: crate::launcher::iso_now(),
            revoked_at: None,
        }],
    };
    scope::save(d.path(), &state).unwrap();
    let leftovers: Vec<_> = std::fs::read_dir(d.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "原子写不留暂存残渣");
    assert_eq!(scope::load(d.path()).unwrap().sessions.len(), 1);
    // 覆盖写（rename 替换）后仍是完整 JSON。
    scope::save(d.path(), &scope::McpScopeState::default()).unwrap();
    assert!(scope::load(d.path()).unwrap().sessions.is_empty());
    // 损坏 / 版本不符一律显式报错。
    std::fs::write(scope::scope_path(d.path()), "{not-json").unwrap();
    assert_eq!(scope::load(d.path()).unwrap_err().code, codes::INTERNAL);
    std::fs::write(
        scope::scope_path(d.path()),
        r#"{"version":999,"sessions":[]}"#,
    )
    .unwrap();
    assert_eq!(scope::load(d.path()).unwrap_err().code, codes::INTERNAL);
}

#[test]
fn token_rotation_invalidates_old_token_session_and_discovery() {
    let d = TempDir::new();
    let token = Mutex::new("old-token".to_string());
    let pending = Mutex::new(HashMap::new());
    let mirror = Mutex::new(scope::McpScopeState::default());
    let (tx, rx) = std::sync::mpsc::channel();
    // B5 起台账项持有在途预算凭据：轮换 drain 时凭据必须随条目一起归还。
    let budget = Arc::new(server::CallBudget::new(1));
    let slot = budget.try_acquire().expect("测试预算取位");
    pending.lock().unwrap().insert(
        "mcp-1".to_string(),
        server::Pending {
            tx,
            rpc_id: json!(1),
            method: "tools/call".to_string(),
            tool_name: Some("export_file".to_string()),
            started: Instant::now(),
            slot,
        },
    );
    assert_eq!(
        budget.snapshot()["inFlight"].as_u64(),
        Some(1),
        "取位后在途 1"
    );
    server::write_discovery(
        d.path(),
        &EndpointFile {
            port: 1,
            token: "old-token".to_string(),
            endpoint: "http://127.0.0.1:1/mcp".to_string(),
        },
    )
    .unwrap();

    let next = server::rotate_token_parts(
        &token,
        &pending,
        &mirror,
        d.path(),
        43210,
        "http://127.0.0.1:43210/mcp",
    )
    .unwrap();
    assert_ne!(next, "old-token");
    assert_eq!(next.len(), 64);
    assert!(next.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(*token.lock().unwrap(), next);
    // 旧会话（在途请求）作废，给一个明确的 CANCELLED。
    let reply = rx.try_recv().unwrap();
    assert!(!reply.ok);
    assert_eq!(reply.error.unwrap().code, codes::CANCELLED);
    assert!(pending.lock().unwrap().is_empty());
    // 发现文件更新，且只含 {port,token,endpoint}（红线②）。
    let text = std::fs::read_to_string(scope::endpoint_path(d.path())).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed.as_object().unwrap().len(), 3);
    assert_eq!(parsed["port"], json!(43210));
    assert_eq!(parsed["token"], json!(next));
    assert_eq!(parsed["endpoint"], json!("http://127.0.0.1:43210/mcp"));
    // 端点级：旧 token 认证失败、新 token 认证成功。
    let peer: SocketAddr = ([127, 0, 0, 1], 1).into();
    let old_head = head_with("Bearer old-token", Some("http://127.0.0.1"));
    let new_head = head_with(&format!("Bearer {next}"), Some("http://127.0.0.1"));
    assert!(server::authenticate(&old_head, &next, peer).is_err());
    assert!(server::authenticate(&new_head, &next, peer).is_ok());
    // stop / 退出路径：发现文件被清理。
    server::remove_discovery(d.path());
    assert!(!scope::endpoint_path(d.path()).exists());
}

#[test]
fn token_rotation_reloads_scope_from_disk() {
    let d = TempDir::new();
    let token = Mutex::new(String::new());
    let pending = Mutex::new(HashMap::new());
    let stale = scope::McpScopeState {
        version: scope::SCOPE_VERSION,
        sessions: vec![SessionGrant {
            client_id: "c".to_string(),
            tier: McpTier::Privileged,
            approved_roots: vec![],
            approved_tools: vec!["export_file".to_string()],
            approved_root_ids: vec![],
            created_at: crate::launcher::iso_now(),
            revoked_at: None,
        }],
    };
    let mirror = Mutex::new(stale);
    // 盘上是空表（最小权限）：轮换后内存里未落盘的旧授权失效。
    server::rotate_token_parts(
        &token,
        &pending,
        &mirror,
        d.path(),
        2,
        "http://127.0.0.1:2/mcp",
    )
    .unwrap();
    let built = scope::build_scope(&mirror.lock().unwrap(), "c", "s").unwrap();
    assert_eq!(built.tier, McpTier::Read);
    assert!(built.approved_tools.is_empty());
    assert_eq!(
        check_tool_call_permission("export_file", &built)
            .unwrap_err()
            .code,
        codes::TOOL_NOT_APPROVED
    );
}

/* ---------------------- 审计：体积上限 / 轮转 / 损坏行 ---------------------- */

#[test]
fn audit_caps_line_size_and_never_leaks_content() {
    let d = TempDir::new();
    let mut entry = sample_entry(AuditOutcome::Ok, "read_file");
    entry.args_digest = "SECRET-CONTENT-42 ".repeat(1000);
    entry.note = Some("x".repeat(5000));
    entry.landed_path = Some("y".repeat(5000));
    entry.client_id = "c".repeat(500);
    audit::append(d.path(), &entry).unwrap();
    let rows = audit::query(d.path(), 10, None).unwrap();
    assert_eq!(rows.len(), 1);
    assert!(serde_json::to_string(&rows[0]).unwrap().len() <= audit::MAX_AUDIT_LINE_BYTES);
    let tail = "…[truncated]".chars().count();
    assert!(rows[0].args_digest.chars().count() <= 1024 + tail);
    assert!(rows[0].client_id.chars().count() <= 128 + tail);
    assert!(rows[0].note.as_ref().unwrap().chars().count() <= 512 + tail);
    // digest 本身只记键名 / 类型 / 长度，不落全文。
    let digest = audit::digest_args(
        &json!({"content":"IGNORE PREVIOUS INSTRUCTIONS secret-token-42","path":"docs/a.txt"}),
    );
    assert!(!digest.contains("IGNORE"));
    assert!(!digest.contains("secret-token-42"));
    assert!(digest.contains("content:str("));
}

#[test]
fn audit_rotation_and_corrupt_line_tolerance() {
    let d = TempDir::new();
    for i in 0..20 {
        let mut e = sample_entry(AuditOutcome::Ok, &format!("tool_{i}"));
        e.args_digest = "k:str(3),".repeat(8);
        audit::append(d.path(), &e).unwrap();
    }
    assert!(
        std::fs::metadata(audit::audit_path(d.path()))
            .unwrap()
            .len()
            > 100
    );
    assert!(audit::rotate_if_needed(d.path(), 100).unwrap());
    assert!(d.path().join(audit::AUDIT_ROTATED_FILE).exists());
    assert!(!audit::audit_path(d.path()).exists());
    // 下一次 append 重建主文件。
    audit::append(d.path(), &sample_entry(AuditOutcome::Denied, "export_file")).unwrap();
    assert_eq!(audit::query(d.path(), 200, None).unwrap().len(), 1);
    // 损坏行：截断 JSON / 类型不符 / 非法 UTF-8 / 空行 —— 都出声跳过，不致命。
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(audit::audit_path(d.path()))
            .unwrap();
        f.write_all(b"{broken\n").unwrap();
        f.write_all(b"{\"ts\":\"t\",\"outcome\":42}\n").unwrap();
        f.write_all(b"\xff\xfe not utf8\n").unwrap();
        f.write_all(b"\n").unwrap();
        let good = serde_json::to_string(&sample_entry(AuditOutcome::Ok, "after_corrupt")).unwrap();
        writeln!(f, "{good}").unwrap();
    }
    let rows = audit::query(d.path(), 200, None).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].outcome, AuditOutcome::Denied);
    assert_eq!(rows[1].tool, "after_corrupt");
    // 查询条数封顶。
    assert!(audit::query(d.path(), usize::MAX, None).unwrap().len() <= audit::MAX_AUDIT_QUERY);
}

/* ---------------------- Origin 白名单：变体与绕过 ---------------------- */

#[test]
fn origin_loopback_ipv6_and_localhost_variants() {
    for ok in [
        "http://127.0.0.1",
        "http://127.0.0.1:5173",
        "http://localhost",
        "http://LOCALHOST",
        "http://LocalHost:8080",
        "http://localhost.",
        "http://[::1]",
        "http://[::1]:1234",
        "http://[0:0:0:0:0:0:0:1]",
        "http://[0:0:0:0:0:0:0:1]:9999",
    ] {
        assert!(server::check_origin(Some(ok)).is_ok(), "{ok}");
    }
    for bad in [
        "http://127.0.0.1.evil.example",
        "http://localhost.evil.example",
        "http://127.0.0.1:5173@evil.example",
        "http://evil.example@127.0.0.1",
        "http://[::1]evil.example",
        "http://[::1]:notaport",
        "http://[::ffff:127.0.0.1]",
        "http://0x7f000001",
        "http://2130706433",
        "http://127.1",
        "http://127.0.0.1.",
        "https://127.0.0.1",
        "null",
        "http://",
    ] {
        assert!(server::check_origin(Some(bad)).is_err(), "{bad}");
    }
    assert!(server::check_origin(None).is_err());
    // 只绑 127.0.0.1：非回环 peer 一律被 authenticate 拒。
    let remote: SocketAddr = ([10, 0, 0, 1], 1).into();
    let good = head_with("Bearer tok", Some("http://127.0.0.1"));
    assert!(server::authenticate(&good, "tok", remote).is_err());
}
/* ==================================================================== *
 * 真实 TCP/HTTP 端到端：server.rs 的真实 listener + TcpStream 裸 HTTP。
 * WebView 桥注入桩（免 Tauri 运行时），回填走生产 `deliver`（mcp_respond）路径。
 * ==================================================================== */

/// 测试桥：记录 emit 载荷（六方法转 WebView 的证据）；回填经 `server::deliver`。
struct RecordingBridge {
    tx: Mutex<std::sync::mpsc::Sender<McpRequestPayload>>,
}

impl McpBridge for RecordingBridge {
    fn emit_request(&self, payload: McpRequestPayload) -> Result<(), String> {
        self.tx
            .lock()
            .unwrap()
            .send(payload)
            .map_err(|e| format!("桥接收端已关闭：{e}"))
    }
}

/// 测试桥：WebView 永远不可用（显式 `E_BRIDGE_UNAVAILABLE` 路径，验证不静默）。
struct DeadBridge;

impl McpBridge for DeadBridge {
    fn emit_request(&self, _payload: McpRequestPayload) -> Result<(), String> {
        Err("WebView 未运行".to_string())
    }
}

struct TestServer {
    state: server::McpState,
    dir: TempDir,
    rx: Receiver<McpRequestPayload>,
    port: u16,
    token: String,
    shared: Arc<McpShared>,
}

impl TestServer {
    /// RecordingBridge 桥：emit 记 channel，供断言与 deliver 回填。
    fn start() -> Self {
        let (tx, rx) = std::sync::mpsc::channel();
        let bridge: Arc<dyn McpBridge> = Arc::new(RecordingBridge { tx: Mutex::new(tx) });
        Self::spawn(bridge, rx)
    }
    /// DeadBridge 桥：emit 恒失败。
    fn start_dead_bridge() -> Self {
        let (_tx, rx) = std::sync::mpsc::channel();
        Self::spawn(Arc::new(DeadBridge), rx)
    }
    fn spawn(bridge: Arc<dyn McpBridge>, rx: Receiver<McpRequestPayload>) -> Self {
        let dir = TempDir::new();
        let state = server::McpState::default();
        let started = server::start(bridge, dir.path().to_path_buf(), &state).unwrap();
        let shared = Arc::clone(&state.runtime.lock().unwrap().as_ref().unwrap().shared);
        Self {
            state,
            dir,
            rx,
            port: started.port,
            token: started.token,
            shared,
        }
    }
    /// 等下一个转 WebView 的载荷（emit 的证据）。
    fn next_payload(&self) -> McpRequestPayload {
        self.rx
            .recv_timeout(Duration::from_secs(5))
            .expect("等待桥载荷超时")
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        let _ = server::stop(&self.state);
    }
}

struct HttpResp {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

/// 裸 HTTP：手写请求行 + 头 + 体；读到 EOF（服务器 Connection: close）后解析
/// 状态码 / 头（键小写）/ 体。动态端口由 server.rs bind :0 分配（测试间隔离）。
fn send_request(
    port: u16,
    method: &str,
    target: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> HttpResp {
    let mut req = format!("{method} {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n");
    for (key, value) in headers {
        req.push_str(&format!("{key}: {value}\r\n"));
    }
    let body = body.unwrap_or("");
    req.push_str(&format!("Content-Length: {}\r\n", body.len()));
    req.push_str("Connection: close\r\n\r\n");
    req.push_str(body);
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream.write_all(req.as_bytes()).unwrap();
    stream.flush().unwrap();
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).unwrap();
    parse_http_response(&buf)
}

fn parse_http_response(buf: &[u8]) -> HttpResp {
    let text = String::from_utf8_lossy(buf);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .expect("HTTP 响应缺 \\r\\n\\r\\n 分隔");
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .expect("HTTP 状态行缺状态码");
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    HttpResp {
        status,
        headers,
        body: body.to_string(),
    }
}

/// 合法三件套（Bearer + 回环 Origin + Accept: application/json）的默认 POST。
fn mcp_post(port: u16, token: &str, body: &str) -> HttpResp {
    let auth = format!("Bearer {token}");
    send_request(
        port,
        "POST",
        "/mcp",
        &[
            ("Authorization", auth.as_str()),
            ("Origin", "http://127.0.0.1"),
            ("Accept", "application/json"),
            ("Content-Type", "application/json"),
        ],
        Some(body),
    )
}

/// 带 `X-Mcp-Client-Id` 的 POST（第四张表按 clientId 签发 scope）。
fn mcp_post_as(port: u16, token: &str, client_id: &str, body: &str) -> HttpResp {
    let auth = format!("Bearer {token}");
    send_request(
        port,
        "POST",
        "/mcp",
        &[
            ("Authorization", auth.as_str()),
            ("X-Mcp-Client-Id", client_id),
            ("Origin", "http://127.0.0.1"),
            ("Accept", "application/json"),
        ],
        Some(body),
    )
}

fn rpc_json(r: &HttpResp) -> serde_json::Value {
    serde_json::from_str(&r.body).expect("响应体应为 JSON")
}

/// 结构化错误码（`error.data.code`）——宿主自定义码的证据字段。
fn rpc_error_code(r: &HttpResp) -> String {
    let v = rpc_json(r);
    v["error"]["data"]["code"]
        .as_str()
        .expect("错误帧应带 data.code")
        .to_string()
}

/// WebView 侧能力全集（tools/list 的桥回填靶；tier 过滤由 Rust 侧复核）。
fn webview_tools() -> serde_json::Value {
    json!({
        "tools": [
            {"name": "read_file", "description": "read"},
            {"name": "write_bytes", "description": "write"},
            {"name": "export_file", "description": "export"},
            {"name": "market_fetch_text", "description": "market"}
        ]
    })
}

/// 刷第四张表内存镜像（审批命令写穿后的同步语义）。
fn reload_scope_mirror(s: &TestServer) {
    *s.shared.scope_state.lock().unwrap() = scope::load(s.dir.path()).unwrap();
}

#[test]
fn e2e_bearer_rejects_missing_wrong_and_non_bearer() {
    let s = TestServer::start();
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    // 缺 Authorization → 403。
    let r = send_request(
        s.port,
        "POST",
        "/mcp",
        &[
            ("Origin", "http://127.0.0.1"),
            ("Accept", "application/json"),
        ],
        Some(body),
    );
    assert_eq!(r.status, 403);
    assert_eq!(rpc_error_code(&r), "E_UNAUTHORIZED");
    // 错 token → 403。
    let r = mcp_post(s.port, "not-the-real-token", body);
    assert_eq!(r.status, 403);
    assert_eq!(rpc_error_code(&r), "E_UNAUTHORIZED");
    // 非 Bearer 形态（Basic）→ 403。
    let r = send_request(
        s.port,
        "POST",
        "/mcp",
        &[
            ("Authorization", "Basic dXNlcjpwd2Q="),
            ("Origin", "http://127.0.0.1"),
            ("Accept", "application/json"),
        ],
        Some(body),
    );
    assert_eq!(r.status, 403);
    assert_eq!(rpc_error_code(&r), "E_UNAUTHORIZED");
    // 现状行为：错误响应不带 WWW-Authenticate；token 字面量绝不进响应体。
    assert!(!r.headers.contains_key("www-authenticate"));
    assert!(!r.body.contains(&s.token), "错误响应体泄漏 token");
}

#[test]
fn e2e_origin_rejects_and_gate_order() {
    let s = TestServer::start();
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    let auth = format!("Bearer {}", s.token);
    // 好 token + 缺 Origin → 403。
    let r = send_request(
        s.port,
        "POST",
        "/mcp",
        &[
            ("Authorization", auth.as_str()),
            ("Accept", "application/json"),
        ],
        Some(body),
    );
    assert_eq!(r.status, 403);
    assert_eq!(rpc_error_code(&r), "E_FORBIDDEN_ORIGIN");
    // 好 token + 伪造 Origin → 403。
    let r = send_request(
        s.port,
        "POST",
        "/mcp",
        &[
            ("Authorization", auth.as_str()),
            ("Origin", "http://evil.example"),
            ("Accept", "application/json"),
        ],
        Some(body),
    );
    assert_eq!(r.status, 403);
    assert_eq!(rpc_error_code(&r), "E_FORBIDDEN_ORIGIN");
    // https 回环也被拒（只放行 http 回环）。
    let r = send_request(
        s.port,
        "POST",
        "/mcp",
        &[
            ("Authorization", auth.as_str()),
            ("Origin", "https://127.0.0.1"),
            ("Accept", "application/json"),
        ],
        Some(body),
    );
    assert_eq!(r.status, 403);
    assert_eq!(rpc_error_code(&r), "E_FORBIDDEN_ORIGIN");
    // 闸序（以 server.rs authenticate 实现为准）：Bearer 在 Origin 之前——
    // 坏 token + 缺 Origin 报的是 Bearer 闸（E_UNAUTHORIZED）。
    let r = send_request(
        s.port,
        "POST",
        "/mcp",
        &[
            ("Authorization", "Bearer wrong"),
            ("Accept", "application/json"),
        ],
        Some(body),
    );
    assert_eq!(r.status, 403);
    assert_eq!(rpc_error_code(&r), "E_UNAUTHORIZED");
}

#[test]
fn e2e_initialize_shape_over_real_tcp() {
    let s = TestServer::start();
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"harness"}}}"#;
    let r = mcp_post(s.port, &s.token, body);
    assert_eq!(r.status, 200);
    assert_eq!(r.headers.get("content-type").unwrap(), "application/json");
    assert_eq!(
        r.headers.get("mcp-protocol-version").unwrap(),
        PROTOCOL_VERSION
    );
    let v = rpc_json(&r);
    assert_eq!(v["jsonrpc"], json!("2.0"));
    assert_eq!(v["id"], json!(1));
    let result = &v["result"];
    // 旧握手版本按请求回显。
    assert_eq!(result["protocolVersion"], json!("2024-11-05"));
    assert!(result["capabilities"]["tools"].is_object());
    assert!(result["capabilities"]["resources"].is_object());
    assert!(result["capabilities"]["prompts"].is_object());
    assert_eq!(result["serverInfo"]["name"], json!(SERVER_NAME));
    assert_eq!(result["serverInfo"]["version"], json!(SERVER_VERSION));
    assert_eq!(
        result["_meta"]["io.modelcontextprotocol/protocolVersion"],
        json!("2024-11-05")
    );
    // 无状态：响应里不编造任何会话状态。
    let text = serde_json::to_string(&v).unwrap().to_ascii_lowercase();
    assert!(!text.contains("sessionid"));
    assert!(!text.contains("mcp-session-id"));
}

#[test]
fn e2e_tools_list_tier_filter_and_scope_promotion() {
    let s = TestServer::start();
    let port = s.port;
    let token = s.token.clone();
    let token2 = s.token.clone();

    // 第一轮：未审批 ⇒ 最小权限（read、无批准）→ WebView 全集里只回 read_file。
    let req = r#"{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{}}"#.to_string();
    let worker = std::thread::spawn(move || mcp_post_as(port, &token, "harness-1", &req));
    let payload = s.next_payload();
    assert_eq!(payload.method, "tools/list");
    assert_eq!(payload.id, "mcp-1");
    assert_eq!(payload.scope.client_id, "harness-1");
    assert_eq!(payload.scope.tier, McpTier::Read);
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id.clone(),
            ok: true,
            result: Some(webview_tools()),
            error: None,
        },
    )
    .unwrap();
    let r = worker.join().unwrap();
    assert_eq!(r.status, 200);
    let v = rpc_json(&r);
    let names: Vec<&str> = v["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["read_file"]);

    // scope 提升：第四张表精确批准 export_file + privileged tier → 刷镜像 → 可见。
    scope::approve(
        s.dir.path(),
        "harness-1",
        McpTier::Privileged,
        vec![],
        vec!["export_file".to_string()],
    )
    .unwrap();
    reload_scope_mirror(&s);

    let req2 = r#"{"jsonrpc":"2.0","id":8,"method":"tools/list","params":{}}"#.to_string();
    let worker2 = std::thread::spawn(move || mcp_post_as(port, &token2, "harness-1", &req2));
    let payload2 = s.next_payload();
    assert_eq!(payload2.id, "mcp-2");
    assert_eq!(payload2.scope.tier, McpTier::Privileged);
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload2.id.clone(),
            ok: true,
            result: Some(webview_tools()),
            error: None,
        },
    )
    .unwrap();
    let r2 = worker2.join().unwrap();
    let v2 = rpc_json(&r2);
    let names2: Vec<&str> = v2["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(names2.contains(&"read_file"));
    assert!(names2.contains(&"write_bytes"));
    assert!(names2.contains(&"export_file"));
    // market 恒 fail-closed，即便 tier=privileged 也不可见。
    assert!(!names2.contains(&"market_fetch_text"));

    // 过滤审计：两轮的 filtered 记录，market 名下记 market_fail_closed。
    let rows = audit::query(s.dir.path(), 200, None).unwrap();
    let filtered: Vec<&AuditEntry> = rows
        .iter()
        .filter(|e| e.outcome == AuditOutcome::Filtered)
        .collect();
    assert!(filtered.len() >= 4);
    let market = filtered
        .iter()
        .find(|e| e.tool == "market_fetch_text")
        .unwrap();
    assert_eq!(market.note.as_deref(), Some("market_fail_closed"));
    let export = filtered.iter().find(|e| e.tool == "export_file").unwrap();
    assert_eq!(export.note.as_deref(), Some("privileged_not_approved"));
}

#[test]
fn e2e_tools_call_unapproved_privileged_denied_with_audit() {
    let s = TestServer::start();
    let body = r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"export_file","arguments":{}}}"#;
    let r = mcp_post(s.port, &s.token, body);
    // JSON-RPC 错误帧走 HTTP 200；拒绝是显式的（E_TOOL_NOT_APPROVED）。
    assert_eq!(r.status, 200);
    let v = rpc_json(&r);
    assert_eq!(v["id"], json!(3));
    assert_eq!(v["error"]["code"], json!(-32000));
    assert_eq!(v["error"]["data"]["code"], json!("E_TOOL_NOT_APPROVED"));
    assert!(!v["error"]["message"].as_str().unwrap().is_empty());
    // 审计：denied 可查，参数只落摘要（键名/类型/长度）。
    let rows = audit::query(s.dir.path(), 50, None).unwrap();
    let denied: Vec<&AuditEntry> = rows
        .iter()
        .filter(|e| e.outcome == AuditOutcome::Denied)
        .collect();
    assert_eq!(denied.len(), 1);
    assert_eq!(denied[0].tool, "export_file");
    assert_eq!(denied[0].note.as_deref(), Some("E_TOOL_NOT_APPROVED"));
    assert_eq!(denied[0].client_id, "loopback-client");
    assert!(denied[0].args_digest.contains("name:str("));
    // 闸门 2 在 emit 之前拦截：桥从未被调。
    assert!(s.rx.try_recv().is_err());
}

/// 端点级口径差回归（⑥）：read 会话猜名直调宿主推断 Edit 的工具——
/// 收口前真实 TCP 端点把它转给 WebView（Rust 闸门 Ok，只有 tools/list 摘得掉它）；
/// 收口后端点显式回 `-32000 / E_TIER_DENIED`，写一条 denied 审计，桥零调用。
/// 尾段钉批准语义零放宽：显式列进 approvedTools 后同一调用照旧走桥成功。
#[test]
fn e2e_tools_call_denies_tier_mismatch_from_read_session() {
    let s = TestServer::start();
    let body = r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"write_file","arguments":{}}}"#;
    let r = mcp_post(s.port, &s.token, body);
    assert_eq!(r.status, 200);
    let v = rpc_json(&r);
    assert_eq!(v["id"], json!(5));
    assert_eq!(v["error"]["code"], json!(-32000));
    assert_eq!(v["error"]["data"]["code"], json!("E_TIER_DENIED"));
    assert!(v["error"]["message"]
        .as_str()
        .unwrap()
        .contains("write_file"));
    // 闸门命中处一条 Denied 审计（note 即原始码，拒绝可见不静默）。
    let rows = audit::query(s.dir.path(), 50, None).unwrap();
    let denied: Vec<&AuditEntry> = rows
        .iter()
        .filter(|e| e.outcome == AuditOutcome::Denied)
        .collect();
    assert_eq!(denied.len(), 1);
    assert_eq!(denied[0].tool, "write_file");
    assert_eq!(denied[0].note.as_deref(), Some("E_TIER_DENIED"));
    // 拒绝发生在 emit 之前：桥从未被调。
    assert!(s.rx.try_recv().is_err());

    // 批准语义零放宽：第四张表把 write_file 显式列进 approvedTools 后，
    // 同 tier=Read 会话直调照旧走桥并成功（收口不得误伤已批准工具）。
    scope::approve(
        s.dir.path(),
        "loopback-client",
        McpTier::Read,
        vec![],
        vec!["write_file".to_string()],
    )
    .unwrap();
    reload_scope_mirror(&s);
    let port = s.port;
    let token = s.token.clone();
    let req = r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"write_file","arguments":{}}}"#.to_string();
    let worker = std::thread::spawn(move || mcp_post(port, &token, &req));
    let payload = s.next_payload();
    assert_eq!(payload.method, "tools/call");
    assert_eq!(payload.scope.tier, McpTier::Read);
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id.clone(),
            ok: true,
            result: Some(json!({ "content": "written" })),
            error: None,
        },
    )
    .unwrap();
    let r2 = worker.join().unwrap();
    let v2 = rpc_json(&r2);
    assert_eq!(v2["id"], json!(6));
    assert!(v2["error"].is_null(), "批准后仍被拒 ⇒ 收口误伤批准语义");
    assert_eq!(v2["result"]["content"], json!("written"));
}

/// Wave4 余项⑤（长任务面 · `kojo://tasks` / `tasks.*`）的端点级回归。
///
/// 钉的是**三路对齐里宿主这一路**：新登记的写/取消类工具在 `EDIT_TOOLS_EXACT` 真源表里点名判
/// edit，于是即便 WebView 注册表被替换或出错，read 会话直调 `tasks.start` / `tasks.cancel`
/// 仍在 `emit_request` **之前**被显式拒（`E_TIER_DENIED`）+ 写一条 denied 审计 + 桥零调用。
/// 反向同钉：只读面（`tasks.status` 工具与 `kojo://tasks` resource）判 read，read 会话照旧
/// 走桥；edit 会话（正确 tier）两枚写/取消面照旧走桥 ⇒ 收口没有把能力面焊死。
#[test]
fn e2e_tasks_write_face_denied_for_read_session_with_zero_bridge_calls() {
    let s = TestServer::start();
    for (id, name) in [(51u32, "tasks.start"), (52u32, "tasks.cancel")] {
        let body = format!(
            r#"{{"jsonrpc":"2.0","id":{id},"method":"tools/call","params":{{"name":"{name}","arguments":{{"kind":"search","query":"abc","taskId":"tsk-local-1"}}}}}}"#
        );
        let r = mcp_post(s.port, &s.token, &body);
        assert_eq!(r.status, 200);
        let v = rpc_json(&r);
        assert_eq!(v["id"], json!(id), "{name}：拒绝也要回同一条请求 id");
        assert_eq!(
            v["error"]["code"],
            json!(-32000),
            "{name}：必须显式 RPC 错误"
        );
        assert_eq!(
            v["error"]["data"]["code"],
            json!("E_TIER_DENIED"),
            "{name}：写/取消档任务工具在 read 会话必须显式拒"
        );
        let msg = v["error"]["message"].as_str().unwrap_or("");
        assert!(
            msg.contains(name) && msg.contains("edit"),
            "{name} 拒绝理由：{msg}"
        );
    }
    // 两条各写一条 Denied 审计（note＝原始码，拒绝可见不静默）。
    let rows = audit::query(s.dir.path(), 50, None).unwrap();
    let denied: Vec<&AuditEntry> = rows
        .iter()
        .filter(|e| e.outcome == AuditOutcome::Denied)
        .collect();
    assert_eq!(denied.len(), 2, "两枚任务写面各一条 denied 审计");
    for e in &denied {
        assert_eq!(e.note.as_deref(), Some("E_TIER_DENIED"), "{:?}", e.tool);
    }
    let denied_names: Vec<&str> = denied.iter().map(|e| e.tool.as_str()).collect();
    assert!(denied_names.contains(&"tasks.start"));
    assert!(denied_names.contains(&"tasks.cancel"));
    // 闸门命中在 emit 之前 ⇒ 桥从未被调。
    assert!(
        s.rx.try_recv().is_err(),
        "read 会话的任务写面被拒后仍转发了 WebView ⇒ 桥非零调用"
    );

    // 只读面照旧放行：tasks.status 在 read 会话走桥（轮询读是进度契约的真形）。
    let status_req = r#"{"jsonrpc":"2.0","id":53,"method":"tools/call","params":{"name":"tasks.status","arguments":{"taskId":"tsk-local-1"}}}"#.to_string();
    let port = s.port;
    let token = s.token.clone();
    let worker = std::thread::spawn(move || mcp_post(port, &token, &status_req));
    let payload = s.next_payload();
    assert_eq!(payload.method, "tools/call");
    assert_eq!(payload.scope.tier, McpTier::Read);
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id.clone(),
            ok: true,
            result: Some(json!({"contents": "task"})),
            error: None,
        },
    )
    .unwrap();
    let v = rpc_json(&worker.join().unwrap());
    assert!(v["error"].is_null(), "只读 tasks.status 不该被宿主拒：{v}");

    // `kojo://tasks` 是新增条目：URI 闸同尺放行（无 `..` / 无绝对形态），read 会话可读。
    validate_kojo_uri("kojo://tasks").expect("kojo://tasks 必须过 URI 闸（新条目与老条目同尺）");
    let read_req =
        r#"{"jsonrpc":"2.0","id":54,"method":"resources/read","params":{"uri":"kojo://tasks"}}"#
            .to_string();
    let port2 = s.port;
    let token2 = s.token.clone();
    let reader = std::thread::spawn(move || mcp_post(port2, &token2, &read_req));
    let payload2 = s.next_payload();
    assert_eq!(payload2.method, "resources/read");
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload2.id.clone(),
            ok: true,
            result: Some(json!({"contents": [{"uri": "kojo://tasks", "text": "{}"}]})),
            error: None,
        },
    )
    .unwrap();
    let v2 = rpc_json(&reader.join().unwrap());
    assert!(v2["error"].is_null(), "read 会话读 kojo://tasks 被拒：{v2}");

    // 正确 tier（edit 会话）⇒ 两枚写/取消面照旧走桥（收口没把能力面焊死）。
    scope::approve(
        s.dir.path(),
        "loopback-client",
        McpTier::Edit,
        vec![],
        vec![],
    )
    .unwrap();
    reload_scope_mirror(&s);
    let start_req = r#"{"jsonrpc":"2.0","id":55,"method":"tools/call","params":{"name":"tasks.start","arguments":{"kind":"search","query":"abc"}}}"#.to_string();
    let port3 = s.port;
    let token3 = s.token.clone();
    let starter = std::thread::spawn(move || mcp_post(port3, &token3, &start_req));
    let payload3 = s.next_payload();
    assert_eq!(payload3.method, "tools/call");
    assert_eq!(payload3.scope.tier, McpTier::Edit);
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload3.id.clone(),
            ok: true,
            result: Some(json!({"taskId": "tsk-local-1", "status": "running"})),
            error: None,
        },
    )
    .unwrap();
    let v3 = rpc_json(&starter.join().unwrap());
    assert!(v3["error"].is_null(), "edit 会话调 tasks.start 被拒：{v3}");
    assert_eq!(v3["result"]["taskId"], json!("tsk-local-1"));
}

#[test]
fn e2e_notification_yields_202_no_frame() {
    let s = TestServer::start();
    // 单独 notification → HTTP 202 + 空体（无 JSON-RPC 响应帧）。
    let r = mcp_post(
        s.port,
        &s.token,
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
    );
    assert_eq!(r.status, 202);
    assert_eq!(r.headers.get("content-length").unwrap(), "0");
    assert!(r.body.is_empty());
    // 能力方法无 id（JSON-RPC 通知）→ 同样无帧，且不触发桥。
    let r = mcp_post(
        s.port,
        &s.token,
        r#"{"jsonrpc":"2.0","method":"tools/list","params":{}}"#,
    );
    assert_eq!(r.status, 202);
    assert!(r.body.is_empty());
    // id=null 的 ping 也按通知。
    let r = mcp_post(
        s.port,
        &s.token,
        r#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#,
    );
    assert_eq!(r.status, 202);
    assert!(r.body.is_empty());
    assert!(s.rx.try_recv().is_err());
}

#[test]
fn e2e_batch_answers_only_id_bearing() {
    let s = TestServer::start();
    // 混合 batch：只回非 notification 项，顺序与请求一致。
    let body = r#"[
        {"jsonrpc":"2.0","id":1,"method":"ping"},
        {"jsonrpc":"2.0","method":"notifications/initialized"},
        {"jsonrpc":"2.0","id":"b","method":"initialize","params":{"protocolVersion":"2025-03-26"}},
        {"jsonrpc":"2.0","method":"notifications/progress"}
    ]"#;
    let r = mcp_post(s.port, &s.token, body);
    assert_eq!(r.status, 200);
    let v = rpc_json(&r);
    let arr = v.as_array().expect("batch 响应是数组");
    assert_eq!(arr.len(), 2);
    assert_eq!(arr[0]["id"], json!(1));
    assert_eq!(arr[0]["result"], json!({}));
    assert_eq!(arr[1]["id"], json!("b"));
    assert_eq!(arr[1]["result"]["protocolVersion"], json!("2025-03-26"));
    // 全通知 batch → 202 无响应体。
    let r = mcp_post(
        s.port,
        &s.token,
        r#"[{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"1"}}]"#,
    );
    assert_eq!(r.status, 202);
    assert!(r.body.is_empty());
}

#[test]
fn e2e_unknown_method_and_invalid_params() {
    let s = TestServer::start();
    // 未知方法 → -32601 显式帧。
    let r = mcp_post(
        s.port,
        &s.token,
        r#"{"jsonrpc":"2.0","id":9,"method":"fs/write_anywhere","params":{}}"#,
    );
    assert_eq!(r.status, 200);
    let v = rpc_json(&r);
    assert_eq!(v["error"]["code"], json!(-32601));
    assert_eq!(v["error"]["data"]["code"], json!("E_METHOD_NOT_FOUND"));
    // tools/call 缺 name → -32602（闸门 1）。
    let r = mcp_post(
        s.port,
        &s.token,
        r#"{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{}}"#,
    );
    let v = rpc_json(&r);
    assert_eq!(v["error"]["code"], json!(-32602));
    assert_eq!(v["error"]["data"]["code"], json!("E_INVALID_PARAMS"));
    // resources/read 缺 uri → -32602。
    let r = mcp_post(
        s.port,
        &s.token,
        r#"{"jsonrpc":"2.0","id":11,"method":"resources/read","params":{}}"#,
    );
    let v = rpc_json(&r);
    assert_eq!(v["error"]["data"]["code"], json!("E_INVALID_PARAMS"));
    // 参数闸命中也留 denied 审计。
    let rows = audit::query(s.dir.path(), 50, None).unwrap();
    assert!(rows.iter().any(
        |e| e.outcome == AuditOutcome::Denied && e.note.as_deref() == Some("E_INVALID_PARAMS")
    ));
}

#[test]
fn e2e_unsupported_protocol_version_rejected() {
    let s = TestServer::start();
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    let auth = format!("Bearer {}", s.token);
    // 未知版本头 → 400 + 结构化错误。
    let r = send_request(
        s.port,
        "POST",
        "/mcp",
        &[
            ("Authorization", auth.as_str()),
            ("Origin", "http://127.0.0.1"),
            ("Accept", "application/json"),
            ("MCP-Protocol-Version", "1999-01-01"),
        ],
        Some(body),
    );
    assert_eq!(r.status, 400);
    assert_eq!(rpc_error_code(&r), "E_UNSUPPORTED_PROTOCOL_VERSION");
    // 空值也 fail closed。
    let r = send_request(
        s.port,
        "POST",
        "/mcp",
        &[
            ("Authorization", auth.as_str()),
            ("Origin", "http://127.0.0.1"),
            ("Accept", "application/json"),
            ("MCP-Protocol-Version", ""),
        ],
        Some(body),
    );
    assert_eq!(r.status, 400);
    // 支持的版本（现行 + 旧握手）放行，ping 回空 result。
    for v in [PROTOCOL_VERSION, "2025-06-18"] {
        let r = send_request(
            s.port,
            "POST",
            "/mcp",
            &[
                ("Authorization", auth.as_str()),
                ("Origin", "http://127.0.0.1"),
                ("Accept", "application/json"),
                ("MCP-Protocol-Version", v),
            ],
            Some(body),
        );
        assert_eq!(r.status, 200, "{v}");
        assert_eq!(rpc_json(&r)["result"], json!({}));
    }
}

#[test]
fn e2e_accept_negotiation_and_sse_frame() {
    let s = TestServer::start();
    let body = r#"{"jsonrpc":"2.0","id":5,"method":"initialize","params":{"protocolVersion":"2026-07-28"}}"#;
    let auth = format!("Bearer {}", s.token);
    // 缺 Accept：现状放行，按普通 JSON 应答（negotiate_accept(None) = Json）。
    let r = send_request(
        s.port,
        "POST",
        "/mcp",
        &[
            ("Authorization", auth.as_str()),
            ("Origin", "http://127.0.0.1"),
        ],
        Some(body),
    );
    assert_eq!(r.status, 200);
    assert_eq!(r.headers.get("content-type").unwrap(), "application/json");
    // 只声明不支持的类型 → 400 显式报错。
    let r = send_request(
        s.port,
        "POST",
        "/mcp",
        &[
            ("Authorization", auth.as_str()),
            ("Origin", "http://127.0.0.1"),
            ("Accept", "text/plain"),
        ],
        Some(body),
    );
    assert_eq!(r.status, 400);
    assert_eq!(rpc_error_code(&r), "E_INVALID_REQUEST");
    // application/json → 普通 JSON。
    let r = send_request(
        s.port,
        "POST",
        "/mcp",
        &[
            ("Authorization", auth.as_str()),
            ("Origin", "http://127.0.0.1"),
            ("Accept", "application/json"),
        ],
        Some(body),
    );
    assert_eq!(r.status, 200);
    assert_eq!(r.headers.get("content-type").unwrap(), "application/json");
    // SSE：请求级单帧 `event: message` + `data:` JSON（现状行为：单条 message 后关闭）。
    let r = send_request(
        s.port,
        "POST",
        "/mcp",
        &[
            ("Authorization", auth.as_str()),
            ("Origin", "http://127.0.0.1"),
            ("Accept", "text/event-stream"),
        ],
        Some(body),
    );
    assert_eq!(r.status, 200);
    assert_eq!(r.headers.get("content-type").unwrap(), "text/event-stream");
    assert!(r.body.starts_with("event: message\ndata: "));
    assert!(r.body.ends_with("\n\n"));
    let data = r
        .body
        .strip_prefix("event: message\ndata: ")
        .unwrap()
        .trim_end();
    let v: serde_json::Value = serde_json::from_str(data).expect("SSE data 行应为完整 JSON");
    assert_eq!(v["id"], json!(5));
    assert_eq!(v["result"]["protocolVersion"], json!("2026-07-28"));
    // 两者都声明时优先 SSE。
    let r = send_request(
        s.port,
        "POST",
        "/mcp",
        &[
            ("Authorization", auth.as_str()),
            ("Origin", "http://127.0.0.1"),
            ("Accept", "application/json, text/event-stream"),
        ],
        Some(body),
    );
    assert_eq!(r.headers.get("content-type").unwrap(), "text/event-stream");
}

#[test]
fn e2e_discovery_file_lifecycle_start_stop() {
    let s = TestServer::start();
    let path = scope::endpoint_path(s.dir.path());
    assert!(path.exists());
    let text = std::fs::read_to_string(&path).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        parsed.as_object().unwrap().len(),
        3,
        "只含 {{port,token,endpoint}}"
    );
    assert_eq!(parsed["port"], json!(s.port));
    assert_eq!(
        parsed["endpoint"],
        json!(format!("http://127.0.0.1:{}/mcp", s.port))
    );
    assert!(
        parsed["token"] == json!(s.token),
        "发现文件记录签发的 token"
    );
    // start 幂等：同 state 二次调用返回同一三元组。
    let again = server::start(Arc::new(DeadBridge), s.dir.path().to_path_buf(), &s.state).unwrap();
    assert_eq!(again.port, s.port);
    assert!(again.token == s.token, "二次 start 返回同一 token");
    // stop 清理，不留暂存残渣；stop 幂等。
    server::stop(&s.state).unwrap();
    assert!(!path.exists());
    let leftovers: Vec<_> = std::fs::read_dir(s.dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "发现文件写不留暂存残渣");
    server::stop(&s.state).unwrap();
    // stop 后端口关闭：连接被拒。
    assert!(TcpStream::connect(("127.0.0.1", s.port)).is_err());
}

#[test]
fn e2e_token_rotation_invalidates_old_token_live() {
    let s = TestServer::start();
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    // 轮换前旧 token 放行。
    let r = mcp_post(s.port, &s.token, body);
    assert_eq!(r.status, 200);
    // 轮换（生产语义：凭据吊销 / 重载第四张表 / 重写发现文件）。
    let next = server::rotate_token_parts(
        &s.shared.token,
        &s.shared.pending,
        &s.shared.scope_state,
        s.dir.path(),
        s.port,
        &format!("http://127.0.0.1:{}/mcp", s.port),
    )
    .unwrap();
    assert!(next != s.token, "轮换必须换发新 token");
    assert_eq!(next.len(), 64);
    // 旧 token 立即失效，新 token 放行。
    let r = mcp_post(s.port, &s.token, body);
    assert_eq!(r.status, 403);
    assert_eq!(rpc_error_code(&r), "E_UNAUTHORIZED");
    let r = mcp_post(s.port, &next, body);
    assert_eq!(r.status, 200);
    // 发现文件同步重写为新凭据（断言不打印 token 本体）。
    let text = std::fs::read_to_string(scope::endpoint_path(s.dir.path())).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert!(
        parsed["token"] == json!(next),
        "发现文件应记录轮换后的 token"
    );
    assert_eq!(parsed["port"], json!(s.port));
}

#[test]
fn stop_then_start_rotates_token_for_ui_rotate() {
    // UI 的「轮换 token」= stop + start（`start` 对同一运行时幂等，二次 start 不换 token）。
    // 本用例钉住这条路径：新运行时首次签发必须换发新 token 并重写发现文件。
    let s = TestServer::start();
    let first_token = s.token.clone();
    server::stop(&s.state).unwrap();
    let started =
        server::start(Arc::new(DeadBridge), s.dir.path().to_path_buf(), &s.state).unwrap();
    assert_ne!(
        started.token, first_token,
        "stop 后再 start 必须换发新 token（UI 轮换依赖这条）"
    );
    assert_eq!(started.token.len(), 64);
    let text = std::fs::read_to_string(scope::endpoint_path(s.dir.path())).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["token"], json!(started.token));
    assert_eq!(parsed["port"], json!(started.port));
    // 新 token 在真 listener 上放行。
    let r = mcp_post(
        started.port,
        &started.token,
        r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#,
    );
    assert_eq!(r.status, 200);
}

#[test]
fn e2e_bridge_unavailable_is_loud() {
    let s = TestServer::start_dead_bridge();
    let r = mcp_post(
        s.port,
        &s.token,
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"docs/a.txt"}}}"#,
    );
    assert_eq!(r.status, 200);
    let v = rpc_json(&r);
    // 桥不可用是显式结构化错误，不静默冒充成功。
    assert_eq!(v["error"]["data"]["code"], json!("E_BRIDGE_UNAVAILABLE"));
    // 显式失败也留审计（denied + note 带错误码）。
    let rows = audit::query(s.dir.path(), 50, None).unwrap();
    assert!(rows
        .iter()
        .any(|e| e.outcome == AuditOutcome::Denied
            && e.note.as_deref() == Some("E_BRIDGE_UNAVAILABLE")));
}

#[test]
fn e2e_unknown_endpoint_and_get_rejected() {
    let s = TestServer::start();
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    let auth = format!("Bearer {}", s.token);
    // 非单端点路径 → 400。
    let r = send_request(
        s.port,
        "POST",
        "/other",
        &[
            ("Authorization", auth.as_str()),
            ("Origin", "http://127.0.0.1"),
            ("Accept", "application/json"),
        ],
        Some(body),
    );
    assert_eq!(r.status, 400);
    assert_eq!(rpc_error_code(&r), "E_INVALID_REQUEST");
    // GET /mcp → 400（单端点只接受 POST）。
    let r = send_request(
        s.port,
        "GET",
        "/mcp",
        &[
            ("Authorization", auth.as_str()),
            ("Origin", "http://127.0.0.1"),
            ("Accept", "application/json"),
        ],
        None,
    );
    assert_eq!(r.status, 400);
    assert_eq!(rpc_error_code(&r), "E_INVALID_REQUEST");
}

#[test]
fn e2e_tools_call_ok_via_bridge_with_audit() {
    let s = TestServer::start();
    let port = s.port;
    let token = s.token.clone();
    let req = r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"docs/a.txt"}}}"#.to_string();
    let worker = std::thread::spawn(move || mcp_post(port, &token, &req));
    let payload = s.next_payload();
    assert_eq!(payload.method, "tools/call");
    assert_eq!(payload.scope.client_id, "loopback-client");
    assert_eq!(payload.scope.tier, McpTier::Read);
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id.clone(),
            ok: true,
            result: Some(json!({"content": "file-bytes"})),
            error: None,
        },
    )
    .unwrap();
    let r = worker.join().unwrap();
    assert_eq!(r.status, 200);
    let v = rpc_json(&r);
    assert_eq!(v["result"]["content"], json!("file-bytes"));
    // 请求级协商 _meta 附在 result 上（无状态按请求协商）。
    assert_eq!(
        v["result"]["_meta"]["io.modelcontextprotocol/stateless"],
        json!(true)
    );
    // 成功 call 也留一条 ok 审计。
    let rows = audit::query(s.dir.path(), 50, None).unwrap();
    let ok: Vec<&AuditEntry> = rows
        .iter()
        .filter(|e| e.outcome == AuditOutcome::Ok)
        .collect();
    assert_eq!(ok.len(), 1);
    assert_eq!(ok[0].tool, "read_file");
}

/* ---------------- 线协议形状归一（真壳端到端取证发现的静默失效） ---------------- */

#[test]
fn normalize_bare_list_arrays_before_secondary_filtering() {
    // 真 WebView registry 回的是裸数组；旧线协议直接透传 ⇒ 客户端拿不到 result.tools，
    // 且 filter_tools_list 因取不到 result["tools"] 整条跳过（纵深安全闸门失效）。
    let mut tools = json!([
        { "name": "project.info", "tier": "read" },
        { "name": "fileTree.remove", "tier": "privileged" }
    ]);
    server::normalize_webview_result(WebMethod::ToolsList, &mut tools);
    assert_eq!(
        tools
            .get("tools")
            .and_then(Value::as_array)
            .map(|a| a.len()),
        Some(2)
    );

    let read_scope = empty_scope(Vec::new());
    let out = filter_tools_list(&tools, &read_scope);
    assert!(names_of(&out.result).contains(&"project.info"));
    assert!(
        !names_of(&out.result).contains(&"fileTree.remove"),
        "未批准特权工具必须被二次过滤摘掉"
    );
    assert_eq!(out.filtered, vec!["fileTree.remove".to_string()]);

    let mut resources = json!([{ "uri": "kojo://project/snapshot" }]);
    server::normalize_webview_result(WebMethod::ResourcesList, &mut resources);
    assert_eq!(
        resources
            .get("resources")
            .and_then(Value::as_array)
            .map(|a| a.len()),
        Some(1)
    );

    let mut prompts = json!([{ "name": "workflow.triage-diagnostics" }]);
    server::normalize_webview_result(WebMethod::PromptsList, &mut prompts);
    assert_eq!(
        prompts
            .get("prompts")
            .and_then(Value::as_array)
            .map(|a| a.len()),
        Some(1)
    );

    // 已合规的对象形状不重复包装、不静默改写。
    let mut already = json!({ "tools": [{ "name": "project.info" }] });
    server::normalize_webview_result(WebMethod::ToolsList, &mut already);
    assert_eq!(
        already
            .get("tools")
            .and_then(Value::as_array)
            .map(|a| a.len()),
        Some(1)
    );
}

#[test]
fn normalize_tools_call_adds_content_without_losing_audit_fields() {
    let mut result = json!({ "rootDir": "D:/proj", "path": "ERB/A.ERB" });
    server::normalize_webview_result(WebMethod::ToolsCall, &mut result);
    assert_eq!(result.get("isError"), Some(&json!(false)));
    let content = result.get("content").and_then(Value::as_array).unwrap();
    assert_eq!(content[0]["type"], json!("text"));
    assert!(content[0]["text"].as_str().unwrap().contains("rootDir"));
    // finalize_reply 的审计靠 result["path"] 记落盘点，包装不能吃掉它。
    assert_eq!(
        result.get("path").and_then(Value::as_str),
        Some("ERB/A.ERB")
    );
    assert_eq!(
        result.get("rootDir").and_then(Value::as_str),
        Some("D:/proj")
    );

    let mut already = json!({ "content": [{ "type": "text", "text": "ok" }] });
    server::normalize_webview_result(WebMethod::ToolsCall, &mut already);
    assert!(already.get("isError").is_none(), "已合规形状不该重复包装");
}

/* ==================================================================== *
 * 会话授权生命周期 / 轮换纵深 / 裸数组注册表 —— 端点级回归补钉
 * ==================================================================== */

/// 带旧 token 的**在途请求**（已过三闸、挂在等桥回填）遇上 token 轮换：请求被显式
/// 作废（E_CANCELLED 错误帧），路由表条目随轮换清空（迟到 `mcp_respond` 回填被拒），
/// 审计留 error 痕——旧会话不悬挂、不复活。
#[test]
fn e2e_rotation_cancels_inflight_request_with_old_token() {
    let s = TestServer::start();
    let port = s.port;
    let token = s.token.clone();
    let req = r#"{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"docs/a.txt"}}}"#.to_string();
    let worker = std::thread::spawn(move || mcp_post(port, &token, &req));
    let payload = s.next_payload();
    assert_eq!(payload.method, "tools/call");
    // 轮换：旧 token 立即失效 + 在途请求一并作废。
    let next = server::rotate_token_parts(
        &s.shared.token,
        &s.shared.pending,
        &s.shared.scope_state,
        s.dir.path(),
        s.port,
        &format!("http://127.0.0.1:{}/mcp", s.port),
    )
    .unwrap();
    assert_ne!(next, s.token);
    let r = worker.join().unwrap();
    assert_eq!(r.status, 200);
    let v = rpc_json(&r);
    assert_eq!(v["id"], json!(11));
    assert_eq!(v["error"]["data"]["code"], json!("E_CANCELLED"));
    assert!(
        v["error"]["message"].as_str().unwrap().contains("轮换"),
        "作废原因必须点名轮换"
    );
    // 迟到回填被拒：路由表条目已随轮换清空，不复活旧会话的请求。
    let late = server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id.clone(),
            ok: true,
            result: Some(json!({ "content": "late" })),
            error: None,
        },
    )
    .unwrap_err();
    assert_eq!(late.code, codes::INVALID_REQUEST);
    // 审计：被作废的在途请求留 error 痕（E_CANCELLED）。
    let rows = audit::query(s.dir.path(), 50, None).unwrap();
    assert!(rows.iter().any(|e| e.outcome == AuditOutcome::Error
        && e.tool == "read_file"
        && e.note.as_deref() == Some("E_CANCELLED")));
}

/// 第四张表损坏 ⇒ 轮换**显式失败、不在半轮换态继续服务**：token 不变、在途请求不
/// 被误杀（照常回填成功）、发现文件逐字未动、旧 token 仍在岗；修复第四张表后轮换
/// 恢复：换发新 token、重写发现文件、旧 token 立即失效。
#[test]
fn e2e_corrupt_scope_table_fails_rotation_without_killing_inflight() {
    let s = TestServer::start();
    let port = s.port;
    let token = s.token.clone();
    let req = r#"{"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"docs/a.txt"}}}"#.to_string();
    let worker = std::thread::spawn(move || mcp_post(port, &token, &req));
    let payload = s.next_payload();
    // 在途期间盘上第四张表损坏（运行时磁盘损坏形态）。
    std::fs::write(scope::scope_path(s.dir.path()), "{broken").unwrap();
    let err = server::rotate_token_parts(
        &s.shared.token,
        &s.shared.pending,
        &s.shared.scope_state,
        s.dir.path(),
        s.port,
        &format!("http://127.0.0.1:{}/mcp", s.port),
    )
    .unwrap_err();
    assert_eq!(err.code, codes::INTERNAL);
    // 半轮换态不存在：在途请求照常经 deliver 回填成功。
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id,
            ok: true,
            result: Some(json!({ "content": "file-bytes" })),
            error: None,
        },
    )
    .unwrap();
    let r = worker.join().unwrap();
    assert_eq!(r.status, 200);
    assert_eq!(rpc_json(&r)["result"]["content"], json!("file-bytes"));
    // 旧 token 仍在岗；发现文件逐字未动。
    assert_eq!(
        mcp_post(
            s.port,
            &s.token,
            r#"{"jsonrpc":"2.0","id":22,"method":"ping"}"#
        )
        .status,
        200
    );
    let parsed: EndpointFile =
        serde_json::from_str(&std::fs::read_to_string(scope::endpoint_path(s.dir.path())).unwrap())
            .unwrap();
    assert_eq!(parsed.port, s.port);
    assert_eq!(parsed.token, s.token);
    // 修复第四张表 ⇒ 轮换恢复 + 旧 token 立即失效。
    scope::save(s.dir.path(), &scope::McpScopeState::default()).unwrap();
    let next = server::rotate_token_parts(
        &s.shared.token,
        &s.shared.pending,
        &s.shared.scope_state,
        s.dir.path(),
        s.port,
        &format!("http://127.0.0.1:{}/mcp", s.port),
    )
    .unwrap();
    assert_ne!(next, s.token);
    assert_eq!(
        mcp_post(
            s.port,
            &s.token,
            r#"{"jsonrpc":"2.0","id":23,"method":"ping"}"#
        )
        .status,
        403
    );
    assert_eq!(
        mcp_post(
            s.port,
            &next,
            r#"{"jsonrpc":"2.0","id":24,"method":"ping"}"#
        )
        .status,
        200
    );
    let repaired: EndpointFile =
        serde_json::from_str(&std::fs::read_to_string(scope::endpoint_path(s.dir.path())).unwrap())
            .unwrap();
    assert_eq!(repaired.token, next);
}

/// 第四张表损坏 / 版本不符 ⇒ `start` 整体 fail-closed：端点不起来、**不写发现文件**
/// （死端口不留在盘上）；修复后 `start` 恢复并可服务。
#[test]
fn e2e_start_fails_closed_on_corrupt_scope_table_then_recovers() {
    let dir = TempDir::new();
    let state = server::McpState::default();
    for bad in ["{broken", r#"{"version":999,"sessions":[]}"#] {
        std::fs::write(scope::scope_path(dir.path()), bad).unwrap();
        let err =
            server::start(Arc::new(DeadBridge), dir.path().to_path_buf(), &state).unwrap_err();
        assert_eq!(err.code, codes::INTERNAL, "{bad}");
        assert!(
            !scope::endpoint_path(dir.path()).exists(),
            "start 失败不得留下指向死端口的发现文件"
        );
    }
    // 修复第四张表 → start 恢复：发现文件与端口/token 一致，ping 可服务。
    scope::save(dir.path(), &scope::McpScopeState::default()).unwrap();
    let started = server::start(Arc::new(DeadBridge), dir.path().to_path_buf(), &state).unwrap();
    let parsed: EndpointFile =
        serde_json::from_str(&std::fs::read_to_string(scope::endpoint_path(dir.path())).unwrap())
            .unwrap();
    assert_eq!(parsed.port, started.port);
    assert_eq!(parsed.token, started.token);
    let r = mcp_post(
        started.port,
        &started.token,
        r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#,
    );
    assert_eq!(r.status, 200);
    server::stop(&state).unwrap();
    assert!(!scope::endpoint_path(dir.path()).exists());
}

/// 第四张表生命周期端到端：approve 后 privileged `tools/call` 行为翻转（走桥、ok
/// 审计、scope 载荷带精确批准）；revoke（revokedAt）后**同一 token** 的后续请求被
/// 拒（E_TOOL_NOT_APPROVED + denied 审计、tools/list 收回）；盘上留痕不物理删。
#[test]
fn e2e_approve_flips_tools_call_then_revoke_denies_same_token() {
    let s = TestServer::start();
    let port = s.port;
    let token = s.token.clone();
    let call = r#"{"jsonrpc":"2.0","id":31,"method":"tools/call","params":{"name":"export_file","arguments":{}}}"#.to_string();
    // 未授权（第四张表缺失 = 最小权限）：privileged call 在闸门 2 显式拒绝，桥未被调。
    let r = mcp_post_as(port, &token, "harness-lc", &call);
    assert_eq!(r.status, 200);
    assert_eq!(rpc_error_code(&r), "E_TOOL_NOT_APPROVED");
    assert!(s.rx.try_recv().is_err());

    // approve：tier=privileged + 精确工具 → 刷镜像 → call 翻转为放行（走桥）。
    scope::approve(
        s.dir.path(),
        "harness-lc",
        McpTier::Privileged,
        vec![],
        vec!["export_file".to_string()],
    )
    .unwrap();
    reload_scope_mirror(&s);
    let token2 = s.token.clone();
    let call2 = call.clone();
    let worker = std::thread::spawn(move || mcp_post_as(port, &token2, "harness-lc", &call2));
    let payload = s.next_payload();
    assert_eq!(payload.scope.tier, McpTier::Privileged);
    assert!(payload
        .scope
        .approved_tools
        .contains(&"export_file".to_string()));
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id,
            ok: true,
            result: Some(json!({ "content": [{ "type": "text", "text": "exported" }] })),
            error: None,
        },
    )
    .unwrap();
    let r = worker.join().unwrap();
    assert_eq!(r.status, 200);
    assert_eq!(
        rpc_json(&r)["result"]["content"][0]["text"],
        json!("exported")
    );

    // revoke：同一 token 的后续 call 显式拒绝，桥未被调。
    scope::revoke(s.dir.path(), "harness-lc").unwrap();
    reload_scope_mirror(&s);
    let r = mcp_post_as(s.port, &s.token, "harness-lc", &call);
    assert_eq!(rpc_error_code(&r), "E_TOOL_NOT_APPROVED");
    assert!(s.rx.try_recv().is_err());
    // tools/list 同步收回：export_file 不再出现，filtered 审计留痕。
    let token3 = s.token.clone();
    let list = r#"{"jsonrpc":"2.0","id":32,"method":"tools/list","params":{}}"#.to_string();
    let worker = std::thread::spawn(move || mcp_post_as(port, &token3, "harness-lc", &list));
    let payload = s.next_payload();
    assert_eq!(payload.scope.tier, McpTier::Read);
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id,
            ok: true,
            result: Some(webview_tools()),
            error: None,
        },
    )
    .unwrap();
    let r = worker.join().unwrap();
    let listing = rpc_json(&r);
    let names: Vec<&str> = listing["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(!names.contains(&"export_file"));
    // 审计两态齐备：denied（revoke 前后各一）+ ok（批准窗口内）+ filtered（收回）。
    let rows = audit::query(s.dir.path(), 200, Some("harness-lc")).unwrap();
    assert_eq!(
        rows.iter()
            .filter(|e| e.outcome == AuditOutcome::Denied && e.tool == "export_file")
            .count(),
        2
    );
    assert!(rows
        .iter()
        .any(|e| e.outcome == AuditOutcome::Ok && e.tool == "export_file"));
    assert!(rows.iter().any(|e| e.outcome == AuditOutcome::Filtered
        && e.tool == "export_file"
        && e.note.as_deref() == Some("privileged_not_approved")));
    // 盘上留痕：该 client 的 grant 全部带 revokedAt（不物理删）。
    let loaded = scope::load(s.dir.path()).unwrap();
    let grants: Vec<&SessionGrant> = loaded
        .sessions
        .iter()
        .filter(|g| g.client_id == "harness-lc")
        .collect();
    assert_eq!(grants.len(), 1, "approve 追加一条、revoke 留痕不物理删");
    assert!(grants.iter().all(|g| g.revoked_at.is_some()));
}

/// 不回落其它三张表（冻结契约③）：同目录就算躺着启动器第三张表 `approvals.json`
/// 的授权形状（start 之前落盘），第四张表缺失 ⇒ MCP 会话仍按未授权最小权限处理；
/// 授权只认 `mcp_approvals.json`，任何邻近授权文件都不构成 MCP 授权。
#[test]
fn e2e_third_table_file_never_grants_mcp_scope() {
    let (tx, rx) = std::sync::mpsc::channel();
    let bridge: Arc<dyn McpBridge> = Arc::new(RecordingBridge { tx: Mutex::new(tx) });
    let dir = TempDir::new();
    // 启动器第三张表（launcher/paths.rs APPROVALS_FILE）与内核 writablePaths 形状的
    // 诱饵文件，在 start 之前落盘——钉住 start 与请求路径都不读它们。
    std::fs::write(
        dir.path().join("approvals.json"),
        r#"{"version":1,"approvals":[{"instanceId":"i1","rootId":"game-root","path":"D:/game/root"}]}"#,
    )
    .unwrap();
    std::fs::write(
        dir.path().join("writable-paths.json"),
        r#"{"writablePaths":["D:/game/root"]}"#,
    )
    .unwrap();
    let state = server::McpState::default();
    let started = server::start(bridge, dir.path().to_path_buf(), &state).unwrap();

    // tools/list：WebView 全集回上来，read 会话只见 read_file（无任何回落授权）。
    let port = started.port;
    let token = started.token.clone();
    let list = r#"{"jsonrpc":"2.0","id":41,"method":"tools/list","params":{}}"#.to_string();
    let worker = std::thread::spawn(move || mcp_post(port, &token, &list));
    let payload = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("等待桥载荷超时");
    server::deliver(
        &state,
        McpRespondArgs {
            id: payload.id,
            ok: true,
            result: Some(webview_tools()),
            error: None,
        },
    )
    .unwrap();
    let r = worker.join().unwrap();
    assert_eq!(names_of(&rpc_json(&r)["result"]), vec!["read_file"]);
    // tools/call 特权工具：显式 E_TOOL_NOT_APPROVED（即便第三张表「授了根」）。
    let r = mcp_post(
        started.port,
        &started.token,
        r#"{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"export_file","arguments":{}}}"#,
    );
    assert_eq!(rpc_error_code(&r), "E_TOOL_NOT_APPROVED");
    // 第四张表始终缺席：缺席本身即最小权限，绝不因邻近文件回落。
    assert!(!scope::scope_path(dir.path()).exists());
    server::stop(&state).unwrap();
}

/// 真壳 WebView registry 返回**裸数组**（含特权 / market 工具）时的端到端纵深：
/// 线协议先归一成 `{tools:[...]}`，二次过滤照常生效——未批准会话拿不到任何危险
/// 工具（拒可见不静默），filtered 审计逐个留痕。真壳取证静默失效的端点级回归钉。
#[test]
fn e2e_bare_array_registry_filtered_for_unapproved_session() {
    let s = TestServer::start();
    let port = s.port;
    let token = s.token.clone();
    let list = r#"{"jsonrpc":"2.0","id":51,"method":"tools/list","params":{}}"#.to_string();
    let worker = std::thread::spawn(move || mcp_post(port, &token, &list));
    let payload = s.next_payload();
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id,
            ok: true,
            result: Some(json!([
                { "name": "read_file", "description": "read" },
                { "name": "write_bytes", "description": "write" },
                { "name": "fileTree.remove", "description": "rm" },
                { "name": "fileTree.rename", "description": "mv" },
                { "name": "launcher_start", "description": "launcher" },
                { "name": "market_fetch_text", "description": "market" }
            ])),
            error: None,
        },
    )
    .unwrap();
    let r = worker.join().unwrap();
    assert_eq!(r.status, 200);
    let v = rpc_json(&r);
    // 裸数组已被归一：result.tools 是数组且只剩 read 工具
    //（旧缺陷形态 = result 本身是裸数组，二次过滤整条被跳过）。
    let names: Vec<&str> = v["result"]["tools"]
        .as_array()
        .expect("result.tools 必须是归一后的数组")
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["read_file"]);
    // filtered 审计：market 与特权工具各自留痕。
    let rows = audit::query(s.dir.path(), 50, None).unwrap();
    let filtered: Vec<&AuditEntry> = rows
        .iter()
        .filter(|e| e.outcome == AuditOutcome::Filtered)
        .collect();
    let market = filtered
        .iter()
        .find(|e| e.tool == "market_fetch_text")
        .unwrap();
    assert_eq!(market.note.as_deref(), Some("market_fail_closed"));
    for name in ["fileTree.remove", "fileTree.rename", "launcher_start"] {
        let e = filtered.iter().find(|e| e.tool == name).unwrap();
        assert_eq!(e.note.as_deref(), Some("privileged_not_approved"), "{name}");
    }
}

/// `stop` 的在途语义：服务停止给所有在途请求显式 CANCELLED（「服务已停止」，区别
/// 于轮换的「token 已轮换」），发现文件同步清理——桥不悬挂、客户端不空等。
#[test]
fn e2e_stop_cancels_inflight_request_loudly() {
    let s = TestServer::start();
    let port = s.port;
    let token = s.token.clone();
    let req = r#"{"jsonrpc":"2.0","id":61,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"docs/a.txt"}}}"#.to_string();
    let worker = std::thread::spawn(move || mcp_post(port, &token, &req));
    let payload = s.next_payload();
    server::stop(&s.state).unwrap();
    let r = worker.join().unwrap();
    assert_eq!(r.status, 200);
    let v = rpc_json(&r);
    assert_eq!(v["error"]["data"]["code"], json!("E_CANCELLED"));
    assert!(
        v["error"]["message"]
            .as_str()
            .unwrap()
            .contains("服务已停止"),
        "停止原因必须显式"
    );
    // stop 清理发现文件（在途请求形态下复钉生命周期）。
    assert!(!scope::endpoint_path(s.dir.path()).exists());
    // 迟到回填被拒：运行时已拆除（与轮换后回填被拒的 INVALID_REQUEST 相区别）。
    let late = server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id,
            ok: true,
            result: Some(json!({})),
            error: None,
        },
    )
    .unwrap_err();
    assert_eq!(late.code, codes::BRIDGE_UNAVAILABLE);
}

/// B3 批（LaneO 2026-11-06）：`editor.*` 五枚在宿主闸门同判 Edit（与 `dot_namespaced_edit_tools_are_gated_as_edit_at_host_gate`
/// 同型，那张表钉的是 quickFix + fileTree 三枚，这张只钉新增五枚、零改动别人的行）。
/// 为什么要点名：`editor.setValue` / `editor.type` / `editor.setCursor` / `editor.setSelection`
/// / `editor.revealLine` 全是 `命名空间.动词` 形态——`EDIT_TOOL_PREFIXES` 表里是 `set_` `edit_`
/// 这类**下划线**前缀，`starts_with` 对 `editor.setCursor` 不成立，`PRIVILEGED_EXACT` 也不含它们
/// ⇒ 修复前 `host_required_tier` 落末尾判 Read，**read 会话零批准即可改正文 / 挪光标**。
/// 钉：逐枚显式 `E_TIER_DENIED`（带工具名）；edit / privileged 会话放行；批准语义零放宽
/// （精确名与 `editor.*` 通配各自短路放行）；不抬成 privileged（危险面口径不动）。
#[test]
fn editor_write_tools_are_gated_as_edit_at_host_gate() {
    const EDITOR_TOOLS: [&str; 5] = [
        "editor.setValue",
        "editor.type",
        "editor.setCursor",
        "editor.setSelection",
        "editor.revealLine",
    ];
    let read = empty_scope(Vec::new());
    let edit = McpSessionScope {
        tier: McpTier::Edit,
        ..empty_scope(Vec::new())
    };
    let priv_scope = McpSessionScope {
        tier: McpTier::Privileged,
        ..empty_scope(Vec::new())
    };
    for name in EDITOR_TOOLS {
        assert!(is_edit_tool(name), "{name} 未进具名 Edit 表");
        assert_eq!(host_required_tier(name), McpTier::Edit, "{name}");
        assert!(!is_privileged_tool(name), "{name} 不得被抬成 privileged");
        let e = check_tool_call_permission(name, &read)
            .err()
            .unwrap_or_else(|| panic!("后门复现：{name} 在 read 会话被端点放行（Ok）"));
        assert_eq!(e.code, "E_TIER_DENIED", "{name}");
        assert!(e.message.contains(name), "{name} 拒绝必须可见（带工具名）");
        // edit / privileged 会话放行（privileged 覆盖 edit 档）。
        assert!(
            check_tool_call_permission(name, &edit).is_ok(),
            "{name} edit 会话应放行"
        );
        assert!(
            check_tool_call_permission(name, &priv_scope).is_ok(),
            "{name} privileged 会话应放行"
        );
    }
    // 批准语义零放宽：精确名与 `前缀*` 通配命中各自照旧短路放行（与 write_* 同源）。
    let exact = empty_scope(vec!["editor.setValue".to_string()]);
    assert!(check_tool_call_permission("editor.setValue", &exact).is_ok());
    let wildcard = empty_scope(vec!["editor.*".to_string()]);
    for name in EDITOR_TOOLS {
        assert!(
            check_tool_call_permission(name, &wildcard).is_ok(),
            "{name} 通配批准后应放行"
        );
    }
    // tools/list 第二道闸：read 会话看不见这五枚（与 tools/call 同源判定）。
    let tools: Vec<_> = EDITOR_TOOLS.iter().map(|n| json!({ "name": n })).collect();
    let result = json!({ "tools": tools });
    let filtered = filter_tools_list(&result, &read);
    assert!(names_of(&filtered.result).is_empty());
    for name in EDITOR_TOOLS {
        assert!(
            filtered.filtered.iter().any(|f| f == name),
            "{name} 应从 read 会话 tools/list 剔除"
        );
    }
}

/// B3 批（LaneO 2026-11-06）**端点级**回归：read 会话猜名直调 `editor.*` 五枚
/// （改正文 / 挪光标 / 滚视口）——收口前五枚既不命中下划线动词前缀表也不在 privileged 表，
/// `host_required_tier` 判 Read，真实 TCP 端点会把调用转给 WebView（只有 tools/list 摘得掉它）
/// ⇒ read 会话零批准即可动作者正在编辑的文档。点名进 `EDIT_TOOLS_EXACT` 后钉四件事：
/// ① 五枚**各自**显式 `-32000 / E_TIER_DENIED`，且 message 带工具名（拒绝可见）；
/// ② 每次拒各写一条 Denied 审计（5 条，note 即原始码，不静默）；
/// ③ 拒绝发生在 emit **之前** ⇒ 桥零调用（`s.rx.try_recv()` 恒空，WebView 从没收到这五枚）；
/// ④ 批准语义零放宽：第四张表把精确名列进 approvedTools 后同一调用照旧走桥成功，
///    `editor.*` 通配命中同样放行（收口不得误伤已批准工具）。
#[test]
fn e2e_tools_call_denies_editor_write_tools_from_read_session() {
    const EDITOR_TOOLS: [&str; 5] = [
        "editor.setValue",
        "editor.type",
        "editor.setCursor",
        "editor.setSelection",
        "editor.revealLine",
    ];
    let s = TestServer::start();
    for (i, name) in EDITOR_TOOLS.iter().enumerate() {
        let body = format!(
            r#"{{"jsonrpc":"2.0","id":{},"method":"tools/call","params":{{"name":"{}","arguments":{{"paneId":"p1"}}}}}}"#,
            700 + i,
            name
        );
        let r = mcp_post(s.port, &s.token, &body);
        assert_eq!(r.status, 200, "{name} 必须是 JSON-RPC 错误帧而非传输层失败");
        let v = rpc_json(&r);
        assert_eq!(v["id"], json!(700 + i), "{name}");
        assert_eq!(v["error"]["code"], json!(-32000), "{name}");
        assert_eq!(
            v["error"]["data"]["code"],
            json!("E_TIER_DENIED"),
            "{name} 未按 Edit 档拒"
        );
        assert!(
            v["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .contains(name),
            "{name} 拒绝消息必须带上被拒的工具名"
        );
    }
    // ② 闸门命中处逐条写 Denied 审计：五枚 = 五条，一条都不能少（缺席可见）。
    let rows = audit::query(s.dir.path(), 50, None).unwrap();
    let denied: Vec<&AuditEntry> = rows
        .iter()
        .filter(|e| e.outcome == AuditOutcome::Denied)
        .collect();
    assert_eq!(
        denied.len(),
        EDITOR_TOOLS.len(),
        "denied 审计条数应与被拒工具数逐一对应"
    );
    for name in EDITOR_TOOLS {
        assert!(
            denied
                .iter()
                .any(|e| e.tool == name && e.note.as_deref() == Some("E_TIER_DENIED")),
            "{name} 缺一条 E_TIER_DENIED 审计"
        );
    }
    // ③ 拒绝在 emit 之前：桥从未被调 ⇒ 只读会话一个字节都改不到、光标一步都挪不动。
    assert!(
        s.rx.try_recv().is_err(),
        "read 会话直调 editor.* 仍被转给 WebView ⇒ 后门复现"
    );

    // ④ 批准语义零放宽（精确名）：显式列入后同一调用照旧走桥并成功。
    scope::approve(
        s.dir.path(),
        "loopback-client",
        McpTier::Read,
        vec![],
        vec!["editor.setValue".to_string()],
    )
    .unwrap();
    reload_scope_mirror(&s);
    let port = s.port;
    let token = s.token.clone();
    let req = r#"{"jsonrpc":"2.0","id":801,"method":"tools/call","params":{"name":"editor.setValue","arguments":{"paneId":"p1","text":"x"}}}"#.to_string();
    let worker = std::thread::spawn(move || mcp_post(port, &token, &req));
    let payload = s.next_payload();
    assert_eq!(payload.method, "tools/call");
    assert_eq!(payload.scope.tier, McpTier::Read);
    assert_eq!(payload.params["name"], json!("editor.setValue"));
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id.clone(),
            ok: true,
            result: Some(json!({ "applied": true, "saved": false })),
            error: None,
        },
    )
    .unwrap();
    let r2 = worker.join().unwrap();
    let v2 = rpc_json(&r2);
    assert!(
        v2["error"].is_null(),
        "精确名批准后仍被拒 ⇒ 收口误伤批准语义"
    );
    assert_eq!(v2["result"]["applied"], json!(true));
    assert_eq!(v2["result"]["saved"], json!(false));

    // ④ 批准语义零放宽（`前缀*` 通配）：editor.* 覆盖另一枚 editor.setCursor。
    scope::approve(
        s.dir.path(),
        "loopback-client",
        McpTier::Read,
        vec![],
        vec!["editor.*".to_string()],
    )
    .unwrap();
    reload_scope_mirror(&s);
    let port = s.port;
    let token = s.token.clone();
    let req = r#"{"jsonrpc":"2.0","id":802,"method":"tools/call","params":{"name":"editor.setCursor","arguments":{"paneId":"p1","line":3}}}"#.to_string();
    let worker = std::thread::spawn(move || mcp_post(port, &token, &req));
    let payload = s.next_payload();
    assert_eq!(payload.params["name"], json!("editor.setCursor"));
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id.clone(),
            ok: true,
            result: Some(json!({ "applied": true })),
            error: None,
        },
    )
    .unwrap();
    let r3 = worker.join().unwrap();
    let v3 = rpc_json(&r3);
    assert!(
        v3["error"].is_null(),
        "editor.* 通配批准后仍被拒 ⇒ 通配命中判定被收口改动"
    );
    assert_eq!(v3["result"]["applied"], json!(true));
}

/// B10 批（LaneV，2026-11-06）：`editor.openDocument` 的**档位真源同批**判据（端点侧）。
///
/// 背景：Wave4 #4 曾把这枚判成 `NOT_WIRED` 而根本不登记 ⇒ 端点侧也就没有它。B10 批因观察件
/// （`livePanes` 登记簿反查）到位而重判为「可诚实回报」⇒ 工具与档位必须**同批**进
/// `EDIT_TOOLS_EXACT`，否则 WebView 契约说 edit、端点说 read，read 会话猜个名字就能把作者正在
/// 编辑的文件从眼前换走（点号形态不命中 `EDIT_TOOL_PREFIXES` 的下划线前缀，也不在
/// `PRIVILEGED_EXACT` ⇒ 不点名就落末尾 `McpTier::Read`，与 B3 那五枚同型洞）。
/// 钉：宿主闸门逐枚判 Edit（不抬 privileged，危险面口径不动）；read 会话 `E_TIER_DENIED` 带工具名；
/// edit / privileged 会话放行；批准语义零放宽（精确名与 `editor.*` 通配各自短路）；
/// `tools/list` 第二道闸同样对 read 会话摘掉它。
#[test]
fn editor_open_document_is_gated_as_edit_at_host_gate() {
    const TOOL: &str = "editor.openDocument";
    let read = empty_scope(Vec::new());
    let edit = McpSessionScope {
        tier: McpTier::Edit,
        ..empty_scope(Vec::new())
    };
    let priv_scope = McpSessionScope {
        tier: McpTier::Privileged,
        ..empty_scope(Vec::new())
    };
    assert!(is_edit_tool(TOOL), "{TOOL} 未进具名 Edit 表");
    assert_eq!(host_required_tier(TOOL), McpTier::Edit, "{TOOL}");
    assert!(!is_privileged_tool(TOOL), "{TOOL} 不得被抬成 privileged");
    let e = check_tool_call_permission(TOOL, &read)
        .err()
        .unwrap_or_else(|| panic!("后门复现：{TOOL} 在 read 会话被端点放行（Ok）"));
    assert_eq!(e.code, "E_TIER_DENIED", "{TOOL}");
    assert!(e.message.contains(TOOL), "{TOOL} 拒绝必须可见（带工具名）");
    assert!(
        check_tool_call_permission(TOOL, &edit).is_ok(),
        "{TOOL} edit 会话应放行"
    );
    assert!(
        check_tool_call_permission(TOOL, &priv_scope).is_ok(),
        "{TOOL} privileged 会话应放行"
    );
    // 批准语义零放宽：精确名与 `editor.*` 通配各自照旧短路放行。
    let exact = empty_scope(vec![TOOL.to_string()]);
    assert!(check_tool_call_permission(TOOL, &exact).is_ok());
    let wildcard = empty_scope(vec!["editor.*".to_string()]);
    assert!(
        check_tool_call_permission(TOOL, &wildcard).is_ok(),
        "{TOOL} 通配批准后应放行"
    );
    // tools/list 第二道闸：read 会话看不见这一枚（与 tools/call 同源判定）。
    let result = json!({ "tools": [ { "name": TOOL } ] });
    let filtered = filter_tools_list(&result, &read);
    assert!(
        names_of(&filtered.result).is_empty(),
        "{TOOL} 未从 read 会话摘掉"
    );
    assert!(filtered.filtered.iter().any(|f| f == TOOL));
}

/// B10 批（LaneV，2026-11-06）：`editor.openDocument` 的**端点级**回归（与 B3 那枚同型、独立用例）。
///
/// read 会话猜名直调真实 TCP 端点，钉四件事：
/// ① 显式 `-32000` + `data.code = E_TIER_DENIED`，且 message 带工具名（拒绝可见）；
/// ② 闸门命中处写一条 Denied 审计，note 即原始码（缺席必须逐条可见）；
/// ③ 拒绝发生在 emit **之前** ⇒ 桥零调用（`s.rx.try_recv()` 恒空：WebView 从没收到这一枚，
///    连"发射一条无法核对的宿主事件"的机会都没有）；
/// ④ 批准语义零放宽：第四张表把精确名列进 approvedTools 后，同一调用照旧走桥并成功
///    （收口不得误伤已批准工具；回执形态按 WebView 腿的 `opened / paneId / active` 读数透传）。
#[test]
fn e2e_tools_call_denies_editor_open_document_from_read_session() {
    const TOOL: &str = "editor.openDocument";
    let s = TestServer::start();
    let body = format!(
        r#"{{"jsonrpc":"2.0","id":910,"method":"tools/call","params":{{"name":"{}","arguments":{{"relPath":"src/a.kojo"}}}}}}"#,
        TOOL
    );
    let r = mcp_post(s.port, &s.token, &body);
    assert_eq!(r.status, 200, "{TOOL} 必须是 JSON-RPC 错误帧而非传输层失败");
    let v = rpc_json(&r);
    assert_eq!(v["id"], json!(910));
    assert_eq!(v["error"]["code"], json!(-32000), "{TOOL}");
    assert_eq!(
        v["error"]["data"]["code"],
        json!("E_TIER_DENIED"),
        "{TOOL} 未按 Edit 档拒"
    );
    assert!(
        v["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains(TOOL),
        "{TOOL} 拒绝消息必须带上被拒的工具名"
    );
    // ② 一条 Denied 审计（本用例只发这一枚 ⇒ 恰一条，note 即原始码）。
    let rows = audit::query(s.dir.path(), 50, None).unwrap();
    let denied: Vec<&AuditEntry> = rows
        .iter()
        .filter(|e| e.outcome == AuditOutcome::Denied)
        .collect();
    assert_eq!(denied.len(), 1, "read 会话直调应恰写一条 Denied 审计");
    assert!(
        denied
            .iter()
            .any(|e| e.tool == TOOL && e.note.as_deref() == Some("E_TIER_DENIED")),
        "{TOOL} 缺一条 E_TIER_DENIED 审计"
    );
    // ③ 拒绝在 emit 之前：桥从未被调 ⇒ 只读会话一个文档都换不走。
    assert!(
        s.rx.try_recv().is_err(),
        "read 会话直调 editor.openDocument 仍被转给 WebView ⇒ 后门复现"
    );

    // ④ 批准语义零放宽（精确名）：列入后同一调用照旧走桥并成功。
    scope::approve(
        s.dir.path(),
        "loopback-client",
        McpTier::Read,
        vec![],
        vec![TOOL.to_string()],
    )
    .unwrap();
    reload_scope_mirror(&s);
    let port = s.port;
    let token = s.token.clone();
    let req = format!(
        r#"{{"jsonrpc":"2.0","id":911,"method":"tools/call","params":{{"name":"{}","arguments":{{"relPath":"src/a.kojo"}}}}}}"#,
        TOOL
    );
    let worker = std::thread::spawn(move || mcp_post(port, &token, &req));
    let payload = s.next_payload();
    assert_eq!(payload.method, "tools/call");
    assert_eq!(payload.scope.tier, McpTier::Read);
    assert_eq!(payload.params["name"], json!(TOOL));
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id.clone(),
            ok: true,
            result: Some(
                json!({ "opened": true, "paneId": "pane-1", "active": true, "saved": false }),
            ),
            error: None,
        },
    )
    .unwrap();
    let r2 = worker.join().unwrap();
    let v2 = rpc_json(&r2);
    assert!(
        v2["error"].is_null(),
        "精确名批准后 editor.openDocument 仍被拒 ⇒ 收口误伤批准语义"
    );
    assert_eq!(v2["result"]["opened"], json!(true));
    assert_eq!(v2["result"]["paneId"], json!("pane-1"));
    assert_eq!(v2["result"]["saved"], json!(false));
}

/// B4 批（LaneS，2026-11-06）：启动器族 27 枚具名 `launcher_*` 工具的**档位真源**判据。
///
/// 钉四件事（一条都不许漂）：
/// ① 命名纪律：工具名保持 `launcher_<族>_<动词>` 下划线形态 ⇒ 命中 `is_launcher_tool()` 的
///    `launcher_` **前缀**判定；点号形态（`launcher.instance.list`）不命中前缀表，会掉进
///    「未知名字按 read 放行」的后门，本批刻意不用；
/// ② 档位：`host_required_tier()` 一律 Privileged，且**一律不进** `EDIT_TOOLS_EXACT`
///    （它们是危险档，不是编辑档）；
/// ③ 批准语义零改动：第四张表对 privileged 只认**精确名**——`launcher_*` 与 `*` 通配都不构成
///    批准（与 `fileTree.remove` / `rename_path` 同一判据路径）；精确名列进后 read / edit /
///    privileged 三种会话一律放行（收口不许误伤已批准工具）；
/// ④ `market_*` 全族维持 fail-closed（`validate_tool_name` 直接拒），本批零登记、零改动。
#[test]
fn launcher_named_tools_keep_privileged_tier_and_exact_approval_only() {
    const LAUNCHER_TOOLS: [&str; 27] = [
        "launcher_instance_list",
        "launcher_instance_get",
        "launcher_instance_update",
        "launcher_instance_remove",
        "launcher_instance_duplicate",
        "launcher_content_list",
        "launcher_content_diagnose",
        "launcher_content_apply",
        "launcher_content_uninstall",
        "launcher_content_set_enabled",
        "launcher_content_set_order",
        "launcher_process_list",
        "launcher_process_status",
        "launcher_task_list",
        "launcher_task_cancel",
        "launcher_save_list",
        "launcher_save_backups",
        "launcher_save_backup",
        "launcher_save_restore",
        "launcher_save_delete_backup",
        "launcher_save_apply_import",
        "launcher_log_sessions",
        "launcher_log_tail",
        "launcher_log_read",
        "launcher_project_hash",
        "launcher_start",
        "launcher_stop",
    ];
    let read = empty_scope(Vec::new());
    let edit = McpSessionScope {
        tier: McpTier::Edit,
        ..empty_scope(Vec::new())
    };
    let priv_scope = McpSessionScope {
        tier: McpTier::Privileged,
        ..empty_scope(Vec::new())
    };
    // 通配永不批准 privileged（冻结契约③）：这条判据本批一字未改。
    let wildcard = empty_scope(vec!["*".to_string(), "launcher_*".to_string()]);
    for name in LAUNCHER_TOOLS {
        assert!(is_launcher_tool(name), "{name} 未命中 launcher_ 前缀判定");
        assert!(is_privileged_tool(name), "{name} 必须判 privileged");
        assert_eq!(host_required_tier(name), McpTier::Privileged, "{name}");
        assert!(
            !is_edit_tool(name) && !EDIT_TOOLS_EXACT.contains(&name),
            "{name} 出现在具名 Edit 表 ⇒ 危险档口径被改"
        );
        // 未精确批准：read / edit / privileged 三种会话与「通配已批准」会话一律
        // TOOL_NOT_APPROVED（危险面先于 tier 面，码优先序不许变）。
        for (label, scope) in [
            ("read", &read),
            ("edit", &edit),
            ("privileged", &priv_scope),
            ("wildcard", &wildcard),
        ] {
            let e = check_tool_call_permission(name, scope)
                .err()
                .unwrap_or_else(|| panic!("{name} 在 {label} 会话被放行（后门复现）"));
            assert_eq!(e.code, codes::TOOL_NOT_APPROVED, "{name} / {label}");
            assert!(e.message.contains(name), "{name} 拒绝理由必须点名工具");
        }
        // 精确名批准 ⇒ 放行（批准语义零放宽），三种会话同判。
        let approved = empty_scope(vec![name.to_string()]);
        for scope in [&read, &edit, &priv_scope] {
            let granted = McpSessionScope {
                tier: scope.tier,
                approved_tools: approved.approved_tools.clone(),
                ..approved.clone()
            };
            assert!(
                check_tool_call_permission(name, &granted).is_ok(),
                "{name} 在 tier={} 精确批准后仍被拒 ⇒ 收口误伤批准语义",
                scope.tier.as_str()
            );
        }
    }
    // market_* 全族继续 fail-closed：名字形状合法也不给过。
    for name in [
        "market_device_token",
        "market_publish",
        "market_download",
        "market_extract",
        "market_fetch_text",
    ] {
        let e = validate_tool_name(name).unwrap_err();
        assert_eq!(e.code, codes::TOOL_FAIL_CLOSED, "{name}");
    }
}

/// B4 批**端点级**回归：真实 TCP 端点在 `emit_request` **之前**拒掉未精确批准的 `launcher_*`。
/// ① 逐枚显式 `-32000 / E_TOOL_NOT_APPROVED`（message 带工具名，拒绝可见不静默）；
/// ② 每次拒绝各写一条 Denied 审计（note 即原始码，条数与枚数一一对应）；
/// ③ 桥零调用（`s.rx.try_recv()` 恒空 ⇒ WebView 从未收到这一族，宿主命令一条也没跑，
///    第三张表复验 / 确认闸 / 信任闸自然也没有被「多一个入口」绕开）；
/// ④ `tools/list`：未批准的这一族整族不可见（registry 全量报上来也照样二次剔除，
///    filtered 审计逐条留痕）；
/// ⑤ 精确名批准后同一调用照旧走桥成功（批准语义零放宽，收口没把能力面焊死）。
#[test]
fn e2e_launcher_tools_require_exact_approval_with_zero_bridge_calls() {
    const PROBED: [&str; 3] = [
        "launcher_instance_list",
        "launcher_save_list",
        "launcher_start",
    ];
    const REGISTERED: [&str; 6] = [
        "launcher_instance_list",
        "launcher_save_list",
        "launcher_start",
        "launcher_stop",
        "launcher_task_list",
        "launcher_project_hash",
    ];
    let s = TestServer::start();
    for (i, name) in PROBED.iter().enumerate() {
        let body = format!(
            r#"{{"jsonrpc":"2.0","id":{},"method":"tools/call","params":{{"name":"{}","arguments":{{"instanceId":"inst-1"}}}}}}"#,
            900 + i,
            name
        );
        let r = mcp_post(s.port, &s.token, &body);
        assert_eq!(r.status, 200, "{name} 必须是 JSON-RPC 错误帧而非传输层失败");
        let v = rpc_json(&r);
        assert_eq!(v["id"], json!(900 + i), "{name}");
        assert_eq!(v["error"]["code"], json!(-32000), "{name}");
        assert_eq!(
            v["error"]["data"]["code"],
            json!("E_TOOL_NOT_APPROVED"),
            "{name} 未按危险面拒"
        );
        assert!(
            v["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .contains(name),
            "{name} 拒绝消息必须点名"
        );
    }
    let rows = audit::query(s.dir.path(), 200, None).unwrap();
    let denied: Vec<&AuditEntry> = rows
        .iter()
        .filter(|e| e.outcome == AuditOutcome::Denied)
        .collect();
    assert_eq!(
        denied.len(),
        PROBED.len(),
        "denied 审计条数应与被拒枚数逐一对应"
    );
    for name in PROBED {
        assert!(
            denied
                .iter()
                .any(|e| e.tool == name && e.note.as_deref() == Some("E_TOOL_NOT_APPROVED")),
            "{name} 缺一条 E_TOOL_NOT_APPROVED 审计"
        );
    }
    assert!(
        s.rx.try_recv().is_err(),
        "read 会话直调 launcher_* 仍被转给 WebView ⇒ 宿主授权闸被多出来的入口绕开"
    );

    // ④ tools/list 二次过滤：这一族整族缺席，filtered 审计逐条留痕。
    let port = s.port;
    let token = s.token.clone();
    let list = r#"{"jsonrpc":"2.0","id":950,"method":"tools/list","params":{}}"#.to_string();
    let worker = std::thread::spawn(move || mcp_post(port, &token, &list));
    let payload = s.next_payload();
    assert_eq!(payload.method, "tools/list");
    let mut with_read: Vec<Value> = REGISTERED
        .iter()
        .map(|n| json!({ "name": n, "description": "launcher face" }))
        .collect();
    with_read.insert(0, json!({ "name": "read_file", "description": "read" }));
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id.clone(),
            ok: true,
            result: Some(json!({ "tools": with_read })),
            error: None,
        },
    )
    .unwrap();
    let v = rpc_json(&worker.join().unwrap());
    assert_eq!(
        names_of(&v["result"]),
        vec!["read_file"],
        "未批准的 launcher_* 不得进 tools/list"
    );
    let rows = audit::query(s.dir.path(), 200, None).unwrap();
    for name in REGISTERED {
        let e = rows
            .iter()
            .find(|x| x.tool == name && x.outcome == AuditOutcome::Filtered)
            .unwrap_or_else(|| panic!("{name} 缺 filtered 审计（剔除必须可见）"));
        assert_eq!(e.note.as_deref(), Some("privileged_not_approved"), "{name}");
    }

    // ⑤ 精确名批准 ⇒ 同一调用照旧走桥并成功（批准语义零放宽）。
    scope::approve(
        s.dir.path(),
        "loopback-client",
        McpTier::Read,
        vec![],
        vec!["launcher_instance_list".to_string()],
    )
    .unwrap();
    reload_scope_mirror(&s);
    let port = s.port;
    let token = s.token.clone();
    let req = r#"{"jsonrpc":"2.0","id":960,"method":"tools/call","params":{"name":"launcher_instance_list","arguments":{}}}"#.to_string();
    let worker = std::thread::spawn(move || mcp_post(port, &token, &req));
    let payload = s.next_payload();
    assert_eq!(payload.method, "tools/call");
    assert_eq!(payload.params["name"], json!("launcher_instance_list"));
    assert_eq!(payload.scope.tier, McpTier::Read);
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id.clone(),
            ok: true,
            result: Some(json!({ "instances": [], "total": 0, "hasMore": false })),
            error: None,
        },
    )
    .unwrap();
    let v = rpc_json(&worker.join().unwrap());
    assert!(
        v["error"].is_null(),
        "精确名批准后仍被拒 ⇒ 批准语义被本批误伤：{v}"
    );
    assert_eq!(v["result"]["total"], json!(0));
}

/* ==================================================================== *
 * B5 吞吐与延迟批：耗时台账真读数 + batch 并发派发 + 在途预算 + 逐条配额。
 *
 * 这一节的夹具是 **WebView 替身**（`B5Bridge`）：`emit_request` 立即返回，回帧由
 * 后台线程按可控延时经**生产** `deliver_shared` 落账。于是量到的是端点自身的
 * 派发循环 / 台账 / HTTP 形状（真壳里 WebView 往返那一格另说，不许拿这里冒充实测）。
 * `Hold` 模式永不回帧，用来逼出「在途预算耗尽」与「超时」两条显式拒绝路径。
 * ==================================================================== */

/// 回帧形态：按延时回帧（echo 形状）/ 按延时回一整套 `tools/list` 表 / 永不回帧
/// （只由 `request_timeout` 收尾）。
#[derive(Clone, Copy)]
enum B5Mode {
    Reply(Duration),
    /// 回帧体＝`webview_tools()` 的能力全集（收口批新增：钉「端点不往 tools/list
    /// 里多塞任何名字」这条纵深，台账/审计查询命令不许从协议面漏进来）。
    Tools(Duration),
    Hold,
}

/// WebView 替身：统计「派发到 WebView 的调用数」与「同时在途峰值」。
/// 峰值就是「并发派发真的发生了」的直接证据（串行恒为 1）。
struct B5Bridge {
    mode: B5Mode,
    slot: Arc<Mutex<Option<Arc<McpShared>>>>,
    calls: Arc<AtomicUsize>,
    inflight: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
}

impl McpBridge for B5Bridge {
    fn emit_request(&self, payload: McpRequestPayload) -> Result<(), String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let now = self.inflight.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(now, Ordering::SeqCst);
        let shared = self
            .slot
            .lock()
            .unwrap()
            .clone()
            .ok_or("B5 夹具：台账尚未接线")?;
        let inflight = Arc::clone(&self.inflight);
        let (id, method) = (payload.id.clone(), payload.method.clone());
        let (delay, is_tool_table) = match self.mode {
            B5Mode::Reply(d) => (d, false),
            B5Mode::Tools(d) => (d, true),
            B5Mode::Hold => {
                // Hold：不回帧，等在途凭据随超时从台账摘走时归还。
                return Ok(());
            }
        };
        let result = if is_tool_table {
            webview_tools()
        } else {
            json!({ "content": method, "echo": true })
        };
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            let _ = server::deliver_shared(
                &shared,
                McpRespondArgs {
                    id,
                    ok: true,
                    result: Some(result),
                    error: None,
                },
            );
            inflight.fetch_sub(1, Ordering::SeqCst);
        });
        Ok(())
    }
}

/// B5 端到端夹具：`Limits` 可注入的同一条生产启动路径（真实 listener）。
struct B5Server {
    state: server::McpState,
    dir: TempDir,
    port: u16,
    token: String,
    shared: Arc<McpShared>,
    calls: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
    inflight: Arc<AtomicUsize>,
}

impl B5Server {
    fn start(mode: B5Mode, limits: Limits) -> Self {
        let calls = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let inflight = Arc::new(AtomicUsize::new(0));
        let slot: Arc<Mutex<Option<Arc<McpShared>>>> = Arc::new(Mutex::new(None));
        let bridge: Arc<dyn McpBridge> = Arc::new(B5Bridge {
            mode,
            slot: Arc::clone(&slot),
            calls: Arc::clone(&calls),
            inflight: Arc::clone(&inflight),
            peak: Arc::clone(&peak),
        });
        let dir = TempDir::new();
        let state = server::McpState::default();
        let started = server::start_with(bridge, dir.path().to_path_buf(), &state, limits).unwrap();
        let shared = Arc::clone(&state.runtime.lock().unwrap().as_ref().unwrap().shared);
        // 接线：桥的后台回帧线程要经**生产** `deliver_shared` 落账。
        *slot.lock().unwrap() = Some(Arc::clone(&shared));
        Self {
            state,
            dir,
            port: started.port,
            token: started.token,
            shared,
            calls,
            peak,
            inflight,
        }
    }
    fn snapshot(&self) -> Value {
        server::latency_snapshot(&self.shared)
    }
    fn ledger_entry<'a>(&'a self, snap: &'a Value, needle: &str) -> Value {
        snap["latency"]["keys"]
            .as_array()
            .expect("台账快照带 keys 数组")
            .iter()
            .find(|k| k["key"].as_str().unwrap_or("").contains(needle))
            .cloned()
            .unwrap_or_else(|| panic!("台账缺键 {needle}：{snap}"))
    }
    fn b5_limits(timeout_ms: u64, budget: usize, per_minute: u32) -> Limits {
        Limits {
            request_timeout: Duration::from_millis(timeout_ms),
            max_inflight_calls: budget,
            max_calls_per_minute: per_minute,
            ..Limits::default()
        }
    }
}

impl Drop for B5Server {
    fn drop(&mut self) {
        let _ = server::stop(&self.state);
    }
}

/// 造 JSON-RPC batch 体：`tools/call` × n 条（id 从 1 递增）。
fn b5_batch_body(ids: &[u64], tool: &str) -> String {
    let items: Vec<String> = ids
        .iter()
        .map(|id| {
            format!(
                r#"{{"jsonrpc":"2.0","id":{id},"method":"tools/call","params":{{"name":"{tool}","arguments":{{"path":"docs/a.txt"}}}}}}"#
            )
        })
        .collect();
    format!("[{}]", items.join(","))
}

/// 纯函数判据：分位数（最近秩）+ 窗口滚动出声 + 锁不静默。
#[test]
fn b5_latency_percentile_and_window_are_exactly_defined() {
    use super::latency::Ledger;
    let mut l = Ledger::new();
    assert_eq!(super::latency::percentile(&Default::default(), 95), 0);
    for i in 1..=100u64 {
        l.record("tools/call#t", Duration::from_millis(i));
    }
    let stats = l.stats();
    assert_eq!(stats.len(), 1, "同键聚合");
    let s = &stats[0];
    assert_eq!(s.seen, 100);
    assert_eq!(s.dropped, 0);
    assert_eq!(s.p50_ms, 50, "最近秩：p50 = 第 50 个");
    assert_eq!(s.p95_ms, 95);
    assert_eq!(s.p99_ms, 99);
    assert_eq!(s.max_ms, 100);
    assert_eq!(s.avg_ms, 50, "均值＝全历史累计/累计次数");
    // 窗口滚动：多出的样本丢弃但**计数出声**，max/seen 仍按全历史。
    let mut small = Ledger::with_window(4);
    for i in [10u64, 20, 30, 40, 50] {
        small.record("k", Duration::from_millis(i));
    }
    let w = &small.stats()[0];
    assert_eq!(w.seen, 5, "seen 是全历史次数");
    assert_eq!(w.samples, 4, "窗口只留最近 4 个");
    assert_eq!(w.dropped, 1, "丢弃数必须与 seen 对账，不静默");
    assert_eq!(w.max_ms, 50, "max 是全历史读数，不因窗口滚动而缩");
    // 键数上限：溢出并入可见溢出键，绝不静默丢样本。
    let mut many = Ledger::with_window(4);
    for k in 0..(super::latency::MAX_KEYS + 40) {
        many.record(&format!("k{k}"), Duration::from_millis(1));
    }
    let json = many.to_json();
    assert!(json["overflowKeys"].as_u64().unwrap_or(0) >= 40);
    assert!(json["keys"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["key"] == json!(super::latency::OVERFLOW_KEY)));
}

/// 真读数出账：`Pending.started` 的耗时同时进台账、审计行与 `tools/call` 的
/// `_meta.elapsedMs`；三个口径必须互相对得上（同一次调用不许各说一套）。
#[test]
fn b5_latency_readout_reaches_ledger_audit_and_meta_together() {
    let s = B5Server::start(
        B5Mode::Reply(Duration::from_millis(30)),
        B5Server::b5_limits(5_000, 8, 120),
    );
    let body = r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"docs/a.txt"}}}"#;
    let r = mcp_post(s.port, &s.token, body);
    let v = rpc_json(&r);
    let elapsed = v["result"]["_meta"]["elapsedMs"]
        .as_u64()
        .expect("tools/call 的 result._meta 必须带 elapsedMs 真读数");
    assert!(
        elapsed >= 25,
        "elapsedMs 是实测回帧耗时（夹具延时 30ms），不得是常数：{elapsed}"
    );

    let snap = s.snapshot();
    let bridge = s.ledger_entry(&snap, "tools/call#read_file");
    assert_eq!(bridge["seen"].as_u64(), Some(1), "一调用一样本");
    // `LatencyStat` 走 camelCase 出账（p50Ms / p95Ms / maxMs / avgMs）。
    assert_eq!(
        bridge["p50Ms"].as_u64(),
        Some(elapsed),
        "p50 就是这一笔的真读数"
    );
    assert_eq!(bridge["maxMs"].as_u64(), Some(elapsed));
    assert_eq!(bridge["dropped"].as_u64(), Some(0));
    // 端点自身开销的单列读数：`http#方法` 键（连接起点 → 该条定案）。
    let http = s.ledger_entry(&snap, "http#tools/call");
    assert_eq!(http["seen"].as_u64(), Some(1));
    assert!(
        http["maxMs"].as_u64().unwrap_or(0) >= elapsed,
        "端点墙钟不可能短于 WebView 往返：{http}"
    );
    // 预算出账带现场值（缺席=没接线，不许挂空值）。
    assert_eq!(snap["budget"]["max"].as_u64(), Some(8));
    assert_eq!(snap["budget"]["rejections"].as_u64(), Some(0));
    assert_eq!(snap["limits"]["maxCallsPerMinute"].as_u64(), Some(120));

    // 审计行的 elapsedMs 与 `_meta` 同源。
    let rows = audit::query(s.dir.path(), 10, None).unwrap();
    let ok = rows
        .iter()
        .find(|e| e.outcome == AuditOutcome::Ok && e.tool == "read_file")
        .expect("一笔 ok 审计");
    assert_eq!(ok.elapsed_ms, Some(elapsed), "审计与 _meta 必须同读数");
}

/// 并发派发本身（实测判据）：batch 20 条 × 夹具回帧 30ms，串行要 600ms；
/// 并发 + 在途预算 8 时应在数倍之内完成，且**同时在途峰值**必须真的 >1（串行恒 1）。
#[test]
fn b5_batch_is_dispatched_concurrently_within_inflight_budget() {
    let s = B5Server::start(
        B5Mode::Reply(Duration::from_millis(30)),
        B5Server::b5_limits(5_000, 8, 1200),
    );
    let ids: Vec<u64> = (1..=20).collect();
    let started = Instant::now();
    let r = mcp_post(s.port, &s.token, &b5_batch_body(&ids, "read_file"));
    let wall = started.elapsed();
    assert_eq!(r.status, 200);
    let arr = rpc_json(&r).as_array().cloned().expect("batch 响应是数组");
    assert_eq!(arr.len(), 20, "每条都有响应帧");
    for (i, item) in arr.iter().enumerate() {
        assert_eq!(item["id"], json!(i as u64 + 1), "响应顺序＝请求顺序");
        assert!(item["result"].is_object(), "第 {i} 条应成功：{item}");
    }
    assert_eq!(s.calls.load(Ordering::SeqCst), 20, "20 条全部进 WebView");
    let peak = s.peak.load(Ordering::SeqCst);
    assert!(peak >= 2, "并发派发没发生（同时在途峰值 {peak}＝串行）");
    assert!(peak <= 8, "在途峰值 {peak} 突破预算 8 ⇒ 第二道闸失效");
    assert!(
        wall < Duration::from_millis(400),
        "batch 20 条墙钟 {}ms：串行下限是 20×30ms，未体现并发",
        wall.as_millis()
    );
    let snap = s.snapshot();
    assert_eq!(
        snap["budget"]["rejections"].as_u64(),
        Some(0),
        "没超预算不该拒绝"
    );
    assert_eq!(
        snap["budget"]["peak"].as_u64(),
        Some(peak as u64),
        "台账峰值与桥侧对账"
    );
    assert_eq!(
        snap["budget"]["inFlight"].as_u64(),
        Some(0),
        "收尾后在途归零"
    );
    assert_eq!(s.inflight.load(Ordering::SeqCst), 0);
    // 台账：20 样同键聚合（窗口 512 ⇒ 无丢弃）。
    let bridge = s.ledger_entry(&snap, "tools/call#read_file");
    assert_eq!(bridge["seen"].as_u64(), Some(20));
    assert_eq!(bridge["dropped"].as_u64(), Some(0));
}

/// 在途预算耗尽＝显式拒绝（不静默排队、不丢帧、不进 WebView）。
/// 夹具 `Hold` 永不回帧：预算 2 ⇒ 只有 2 条进 WebView 并各走 `E_TIMEOUT`，
/// 其余 4 条取不到位 ⇒ 各自一条 `E_CALL_BUDGET_EXCEEDED` + 一条 denied 审计。
#[test]
fn b5_inflight_overrun_is_rejected_explicitly_with_zero_extra_bridge_calls() {
    let s = B5Server::start(B5Mode::Hold, B5Server::b5_limits(400, 2, 1200));
    let ids: Vec<u64> = (1..=6).collect();
    let r = mcp_post(s.port, &s.token, &b5_batch_body(&ids, "read_file"));
    assert_eq!(r.status, 200);
    let arr = rpc_json(&r).as_array().cloned().expect("batch 响应是数组");
    assert_eq!(arr.len(), 6, "六条都得有帧——预算耗尽也不许丢帧");
    let code = |v: &Value| {
        v["error"]["data"]["code"]
            .as_str()
            .unwrap_or("")
            .to_string()
    };
    let timed_out: Vec<u64> = arr
        .iter()
        .filter(|v| code(v) == codes::TIMEOUT)
        .map(|v| v["id"].as_u64().unwrap_or(0))
        .collect();
    let rejected: Vec<u64> = arr
        .iter()
        .filter(|v| code(v) == codes::CALL_BUDGET_EXCEEDED)
        .map(|v| v["id"].as_u64().unwrap_or(0))
        .collect();
    assert_eq!(timed_out.len(), 2, "恰好预算那么多条进了 WebView：{arr:?}");
    assert_eq!(
        rejected.len(),
        4,
        "其余 4 条显式 E_CALL_BUDGET_EXCEEDED：{arr:?}"
    );
    assert_eq!(s.calls.load(Ordering::SeqCst), 2, "超预算的 4 条零桥调用");
    let snap = s.snapshot();
    assert_eq!(snap["budget"]["rejections"].as_u64(), Some(4));
    assert_eq!(
        snap["budget"]["inFlight"].as_u64(),
        Some(0),
        "超时后凭据必归还"
    );
    // 两条口径不同的拒绝各留审计：超时＝timeout，超预算＝denied（note 原始码）。
    let rows = audit::query(s.dir.path(), 50, None).unwrap();
    assert_eq!(
        rows.iter()
            .filter(|e| e.outcome == AuditOutcome::Timeout)
            .count(),
        2
    );
    let overrun: Vec<&AuditEntry> = rows
        .iter()
        .filter(|e| {
            e.outcome == AuditOutcome::Denied
                && e.note.as_deref() == Some(codes::CALL_BUDGET_EXCEEDED)
        })
        .collect();
    assert_eq!(overrun.len(), 4, "超预算逐条 denied 审计");
    for e in &overrun {
        assert!(e.elapsed_ms.is_some(), "等位耗时也要出账：{e:?}");
    }
}

/// 并发不许把逐条判定上移：read 会话的 batch 里，edit 档工具仍在**本条**派发时被
/// `E_TIER_DENIED` 拒（桥零调用），同批的只读工具照旧走桥成功。
#[test]
fn b5_batch_keeps_per_envelope_tier_gate_with_zero_bridge_calls_for_denied() {
    let s = B5Server::start(
        B5Mode::Reply(Duration::from_millis(0)),
        B5Server::b5_limits(5_000, 8, 120),
    );
    let body = r#"[
        {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tasks.status","arguments":{"taskId":"tsk-1"}}},
        {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"tasks.start","arguments":{"kind":"search","query":"abc","taskId":"tsk-1"}}}
    ]"#;
    let r = mcp_post(s.port, &s.token, body);
    let arr = rpc_json(&r).as_array().cloned().expect("batch 响应是数组");
    assert!(arr[0]["result"].is_object(), "只读面照旧走桥：{}", arr[0]);
    assert_eq!(
        arr[1]["error"]["data"]["code"],
        json!("E_TIER_DENIED"),
        "read 会话里的 edit 档任务写面必须显式拒"
    );
    assert_eq!(s.calls.load(Ordering::SeqCst), 1, "被拒的那条零桥调用");
    let rows = audit::query(s.dir.path(), 50, None).unwrap();
    assert!(rows.iter().any(|e| e.outcome == AuditOutcome::Denied
        && e.tool == "tasks.start"
        && e.note.as_deref() == Some("E_TIER_DENIED")));
}

/// 配额口径（本批**收紧**）：batch 第 2 条起逐条另计一格。
/// `max_calls_per_minute=3` 时一次 batch 5 条 ⇒ 前 3 条走桥、后 2 条显式
/// `E_RATE_LIMITED`；单条请求照旧命中 HTTP 429（与改前逐字同形）。
#[test]
fn b5_batch_charges_rate_quota_per_envelope_not_per_request() {
    let s = B5Server::start(
        B5Mode::Reply(Duration::from_millis(0)),
        B5Server::b5_limits(5_000, 8, 3),
    );
    let ids: Vec<u64> = (1..=5).collect();
    let r = mcp_post(s.port, &s.token, &b5_batch_body(&ids, "read_file"));
    let arr = rpc_json(&r).as_array().cloned().expect("batch 响应是数组");
    assert_eq!(arr.len(), 5);
    let limited: Vec<u64> = arr
        .iter()
        .filter(|v| v["error"]["data"]["code"] == json!("E_RATE_LIMITED"))
        .map(|v| v["id"].as_u64().unwrap_or(0))
        .collect();
    assert_eq!(limited.len(), 2, "5 条只给 3 格配额：{arr:?}");
    assert_eq!(s.calls.load(Ordering::SeqCst), 3, "配额外的条目零桥调用");
    // 配额已尽：单条请求仍是 HTTP 429（改前语义逐字保持）。
    let after = mcp_post(
        s.port,
        &s.token,
        r#"{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"docs/a.txt"}}}"#,
    );
    assert_eq!(after.status, 429, "端点总量闸没因按会话计量而放宽");
    // 换一条会话键也仍被全局顶拒住（全局硬顶＝max_calls_per_minute 本身）。
    let other = mcp_post_as(
        s.port,
        &s.token,
        "another-client",
        r#"{"jsonrpc":"2.0","id":100,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"docs/a.txt"}}}"#,
    );
    assert_eq!(other.status, 429);
}

/// 审计单行体积闸（`MAX_AUDIT_LINE_BYTES`）不许被 elapsedMs 撑破：
/// 并发批次跑完后逐行复核长度与字段。
#[test]
fn b5_audit_lines_with_elapsed_stay_under_line_size_cap() {
    let s = B5Server::start(
        B5Mode::Reply(Duration::from_millis(1)),
        B5Server::b5_limits(5_000, 4, 1200),
    );
    let ids: Vec<u64> = (1..=8).collect();
    let r = mcp_post(s.port, &s.token, &b5_batch_body(&ids, "read_file"));
    assert_eq!(r.status, 200);
    let text = std::fs::read_to_string(super::audit::audit_path(s.dir.path())).unwrap();
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    assert!(lines.len() >= 8, "八笔调用至少八行审计：{lines:?}");
    assert!(
        lines
            .iter()
            .all(|l| l.chars().count() <= super::audit::MAX_AUDIT_LINE_BYTES),
        "单行体积闸被撑破"
    );
    assert!(
        lines.iter().any(|l| l.contains("\"elapsedMs\"")),
        "elapsedMs 必须真进审计行：{}",
        lines.join("\n")
    );
    assert_eq!(s.snapshot()["budget"]["inFlight"].as_u64(), Some(0));
}

/// 缺真源就不出该格：`_meta.elapsedMs` 与审计 `elapsedMs` 只在**有实测**时出现。
/// 本地即定案的帧（ping / initialize）不进 WebView，也就没有 WebView 往返读数。
#[test]
fn b5_no_bridge_call_means_no_elapsed_reading() {
    let s = B5Server::start(
        B5Mode::Reply(Duration::from_millis(0)),
        B5Server::b5_limits(5_000, 8, 120),
    );
    let r = mcp_post(
        s.port,
        &s.token,
        r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#,
    );
    let v = rpc_json(&r);
    assert_eq!(v["result"], json!({}), "ping 按规范回空 result");
    assert_eq!(s.calls.load(Ordering::SeqCst), 0);
    // 端点墙钟仍然出账（这一格是端点自身开销，与 WebView 无关）。
    let snap = s.snapshot();
    let http = s.ledger_entry(&snap, "http#ping");
    assert_eq!(http["seen"].as_u64(), Some(1));
    assert_eq!(
        snap["latency"]["keys"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|k| k["key"].as_str().unwrap_or("") == "ping")
            .count(),
        0,
        "没走桥的调用不许伪造 bridge# 读数"
    );
}

/* ==================================================================== *
 * B5 收口批（LaneU 2026-11-07）：把半成品里三处「声称」变成用例，再加一张
 * 端点自身开销的实测探针。
 *   ①`sanitize_untrusted_inplace` 与整树版逐字节等价——用**独立 oracle** 对拍；
 *   ②线字节序（顶层键字母序）是对外契约——用精确字节钉住，顺带反证
 *     「`to_value→to_vec` 合并成一次 `to_vec(&JsonRpcResponse)`」会改线字节；
 *   ③`mcp_latency_query` 与 `mcp_audit_query` 同一纵深——协议面六法够不到台账；
 *   ④`Limits` 既有五格一字未动 + 两枚新格有界。
 * ==================================================================== */

/// 参考实现＝`git show origin/dev:packages/app/src-tauri/src/mcp/protocol.rs` 里
/// `sanitize_untrusted`（整树版）的**逐字抄录**，只把该模块私有的 `normalize_key`
/// 就地展开（口径不变：只留 ASCII 字母数字并小写）。它是独立 oracle，不复用被测代码。
fn sanitize_untrusted_reference(v: &Value) -> Value {
    fn normalize_key_ref(key: &str) -> String {
        key.to_ascii_lowercase()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect()
    }
    match v {
        Value::String(s) => Value::String(sanitize_string(s, MAX_UNTRUSTED_CHARS)),
        Value::Array(items) => {
            Value::Array(items.iter().map(sanitize_untrusted_reference).collect())
        }
        Value::Object(map) => {
            let mut out: serde_json::Map<String, Value> = serde_json::Map::new();
            for (key, child) in map {
                let nk = normalize_key_ref(key);
                let cap = if nk == "description" {
                    MAX_DESCRIPTION_CHARS
                } else {
                    MAX_UNTRUSTED_CHARS
                };
                let cleaned = match sanitize_untrusted_reference(child) {
                    Value::String(s) => Value::String(truncate_chars(&s, cap)),
                    other => other,
                };
                out.insert(key.clone(), cleaned);
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// ①就地净化 == 整树净化（逐字节）。覆盖：控制字符、两级二次截断、`description`
/// 键（含大小写 / 标点变形与「normalize 后同键」的双写）、深层嵌套、非字符串子节点、
/// 多字节字符边界、空容器、顶层标量 / 数组。
#[test]
fn b5_sanitize_inplace_is_byte_identical_to_whole_tree_reference() {
    let long = "x".repeat(MAX_UNTRUSTED_CHARS + 7);
    let desc = "y".repeat(MAX_DESCRIPTION_CHARS + 5);
    let cjk = "日本語".repeat(MAX_DESCRIPTION_CHARS);
    let corpus: Vec<Value> = vec![
        json!(null),
        json!(42),
        json!(true),
        json!("plain string"),
        Value::String(long.clone()),
        json!("a\u{1}b\u{7}c\u{7f}d"),
        json!("\u{1}\u{2}\u{3}"),
        json!([]),
        json!({}),
        json!({ "description": desc.clone() }),
        json!({ "Description": desc.clone() }),
        json!({ "descrip tion": desc.clone() }),
        // 同一 normalize_key 结果的两个不同原键：两张表都得各自收紧，不许合并 / 丢键。
        json!({ "description": desc.clone(), "Descrip-tion": long.clone() }),
        json!({ "nested": { "deeper": { "description": desc.clone() } } }),
        json!({ "description": { "inner": desc.clone() } }),
        json!({ "list": [long.clone(), desc.clone(), 1, null, [desc.clone()], { "description": desc.clone() }] }),
        json!({ "cjk": cjk.clone(), "s": "émoji 🎉 边界" }),
        json!([{ "description": desc.clone() }, long.clone(), "id"]),
        json!({ "keep": { "a": [1, 2, { "b": null }] }, "description": desc.clone() }),
    ];
    for item in corpus {
        let before = serde_json::to_vec(&item).unwrap();
        let reference = serde_json::to_vec(&sanitize_untrusted_reference(&item)).unwrap();
        // 现整树版（= 克隆 + 就地）
        let via_wrapper = serde_json::to_vec(&sanitize_untrusted(&item)).unwrap();
        // 热路径就地版
        let mut inplace = item.clone();
        sanitize_untrusted_inplace(&mut inplace);
        let via_inplace = serde_json::to_vec(&inplace).unwrap();
        assert_eq!(
            reference, via_wrapper,
            "整树版与参考实现不再逐字节等价：{before:?}"
        );
        assert_eq!(
            reference, via_inplace,
            "就地版与整树版不再逐字节等价：{before:?}"
        );
        // 就地版必须只改字符串「值」：键集与键序不变（结构不许被重写）。
        let ref_keys: Vec<String> = serde_json::to_value(&sanitize_untrusted_reference(&item))
            .unwrap()
            .as_object()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        let inplace_keys: Vec<String> = inplace
            .as_object()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        assert_eq!(ref_keys, inplace_keys, "对象键集/键序被就地版改动");
        // 参考路径不得改写输入（输入与 `before` 对拍）。
        assert_eq!(serde_json::to_vec(&item).unwrap(), before);
    }
}

/// ②线字节序（对外契约）：`process_head` 走 `to_value → to_vec`，顶层键因此是
/// **字母序**（serde_json 的 `Map` = BTreeMap）。合并成一次 `to_vec(&JsonRpcResponse)`
/// 会按**声明序**（`jsonrpc` 在前）输出＝改线字节。这里用精确字节钉住，并反证合并的后果。
#[test]
fn b5_response_wire_bytes_keep_alphabetical_top_level_key_order() {
    let s = B5Server::start(
        B5Mode::Reply(Duration::from_millis(0)),
        B5Server::b5_limits(5_000, 8, 120),
    );
    // 单条 ok 帧（ping 本地定案，形状完全确定）。
    let ok = mcp_post(
        s.port,
        &s.token,
        r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#,
    );
    assert_eq!(ok.status, 200);
    assert_eq!(
        ok.body, r#"{"id":1,"jsonrpc":"2.0","result":{}}"#,
        "线字节必须是字母序 id < jsonrpc < result"
    );
    // 反证：直接序列化结构体＝声明序，与上面的线字节不同（这就是不许合并的原因）。
    let merged = serde_json::to_vec(&JsonRpcResponse::ok(json!(1), json!({}))).unwrap();
    assert_eq!(
        String::from_utf8(merged.clone()).unwrap(),
        r#"{"jsonrpc":"2.0","id":1,"result":{}}"#
    );
    assert_ne!(merged.as_slice(), ok.body.as_bytes());
    // 错误帧：error < id < jsonrpc，且 error 内部 code < data < message（同样是 BTreeMap 序）。
    let err = mcp_post(
        s.port,
        &s.token,
        r#"{"jsonrpc":"2.0","id":9,"method":"fs/write_anywhere","params":{}}"#,
    );
    assert_eq!(rpc_error_code(&err), "E_METHOD_NOT_FOUND");
    assert!(
        err.body
            .starts_with(r#"{"error":{"code":-32601,"data":{"code":"E_METHOD_NOT_FOUND""#),
        "错误帧顶层与嵌套键序被改动：{}",
        err.body
    );
    assert!(
        err.body.ends_with(r#"},"id":9,"jsonrpc":"2.0"}"#),
        "错误帧尾序被改动：{}",
        err.body
    );
    // batch 帧：数组逐元素同序，元素顺序＝请求顺序。
    let batch = mcp_post(
        s.port,
        &s.token,
        r#"[{"jsonrpc":"2.0","id":2,"method":"ping"},{"jsonrpc":"2.0","id":1,"method":"ping"}]"#,
    );
    assert_eq!(
        batch.body,
        r#"[{"id":2,"jsonrpc":"2.0","result":{}},{"id":1,"jsonrpc":"2.0","result":{}}]"#
    );
    // 有界 keep-alive 未采纳 ⇒ 每帧恒 `Connection: close`（改这条必须带实测依据）。
    assert_eq!(
        ok.headers.get("connection").map(String::as_str),
        Some("close"),
        "Connection 头形状变了：{:?}",
        ok.headers
    );
}

/// ③台账读口的纵深：`mcp_latency_query` 只由宿主侧（`invoke`）经 `&McpState` 读，
/// MCP 协议面的六法里没有任何一条能读到台账，Rust 也不为宿主命令名开本地入口；
/// 服务未启动时显式报错，不返空台账冒充「零延迟」。
#[test]
fn b5_latency_readout_is_host_only_and_loud_when_service_absent() {
    // 未启动＝显式报错（不静默回空数组 / 空台账）。
    let e = server::latency_query(&server::McpState::default()).unwrap_err();
    assert_eq!(e.code, codes::BRIDGE_UNAVAILABLE);
    assert!(
        e.message.contains("服务未启动"),
        "未启动的读数必须自带理由：{}",
        e.message
    );
    let s = B5Server::start(
        B5Mode::Tools(Duration::from_millis(0)),
        B5Server::b5_limits(5_000, 8, 120),
    );
    // 协议面全枚举：够得到台账的路径一条也没有（六法之外全是显式 METHOD_NOT_FOUND）。
    assert_eq!(
        WEB_METHOD_NAMES,
        &[
            "tools/list",
            "tools/call",
            "resources/list",
            "resources/read",
            "prompts/list",
            "prompts/get"
        ]
    );
    for name in ["mcp_latency_query", "latency_query", "mcp_audit_query"] {
        let before = s.calls.load(Ordering::SeqCst);
        let r = mcp_post(
            s.port,
            &s.token,
            &format!(
                r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"{name}","arguments":{{}}}}}}"#
            ),
        );
        assert_eq!(r.status, 200);
        // 端点把它当**普通工具名**转给 WebView（tier / 批准闸照判），Rust 侧没有本地入口，
        // 响应里也只有这一笔自己的真读数，绝没有台账快照那几格。
        assert_eq!(
            s.calls.load(Ordering::SeqCst),
            before + 1,
            "{name} 必须走桥（由 WebView 判定未知工具），不得被端点短路"
        );
        for forbidden in [
            "overflowKeys",
            "maxInflightCalls",
            "pendingNow",
            "p95Ms",
            "maxCallsPerMinute",
        ] {
            assert!(
                !r.body.contains(forbidden),
                "协议面读到了台账快照的 {forbidden}：{}",
                r.body
            );
        }
    }
    assert_eq!(s.calls.load(Ordering::SeqCst), 3, "三枚猜名全部只是转桥");
    // tools/list：端点不往 WebView 回填的表里多塞任何名字（台账 / 审计命令不在其中）。
    let list = mcp_post(
        s.port,
        &s.token,
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
    );
    let names: Vec<String> = rpc_json(&list)["result"]["tools"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|t| t["name"].as_str().map(str::to_string))
        .collect();
    assert!(
        !names.is_empty(),
        "tools/list 应有回填的工具表：{}",
        list.body
    );
    for forbidden in ["latency", "audit", "mcp_latency_query", "mcp_audit_query"] {
        assert!(
            names.iter().all(|n| !n.contains(forbidden)),
            "协议面工具表多出 {forbidden}：{names:?}"
        );
    }
    // 台账确实只在宿主侧累积（上面几笔走桥的调用进了 bridge# 键，但没有一条读口）。
    let snap = s.snapshot();
    assert!(
        serde_json::to_string(&snap)
            .unwrap()
            .contains("tools/call#mcp_latency_query"),
        "走桥的调用照常出账（读数与协议面入口是两件事）：{snap}"
    );
}

/// ④闸值冻结：既有五格数值一字未动；两枚新格各有依据且有界。
#[test]
fn b5_limits_defaults_are_frozen_and_inflight_budget_is_bounded() {
    let d = Limits::default();
    assert_eq!(d.max_header_bytes, 16 * 1024);
    assert_eq!(d.max_body_bytes, 1024 * 1024);
    assert_eq!(d.max_response_bytes, 1024 * 1024);
    assert_eq!(d.request_timeout, Duration::from_secs(30));
    assert_eq!(d.max_calls_per_minute, 120);
    assert_eq!(d.max_concurrent, 8);
    // 新格 1：在途预算＝连接闸同数 ⇒ 改的是口径不是额度（并发绝不给 WebView 更大压力）。
    assert_eq!(d.max_inflight_calls, 8);
    assert_eq!(d.max_inflight_calls, d.max_concurrent);
    // 新格 2：台账窗口＝`latency::SAMPLE_WINDOW`（纯读数窗口，不参与任何判定）。
    assert_eq!(d.latency_window, super::latency::SAMPLE_WINDOW);
    assert_eq!(d.latency_window, 512);
    // 预算真的有界：取满即拒（`try_acquire`），归还得能再取。
    let b = Arc::new(server::CallBudget::new(2));
    let a = b.try_acquire().expect("第 1 格");
    let c = b.try_acquire().expect("第 2 格");
    assert!(b.try_acquire().is_none(), "第 3 格必须取不到");
    // 取满后、死线已过 ⇒ 等位不做无谓等待，直接显式 None 并计数（不静默排队）。
    assert!(
        b.acquire(Instant::now()).is_none(),
        "已过死线还取到位＝没尊重 deadline"
    );
    assert_eq!(b.snapshot()["rejections"].as_u64(), Some(1));
    assert_eq!(b.snapshot()["waits"].as_u64(), Some(1));
    assert_eq!(b.snapshot()["peak"].as_u64(), Some(2));
    drop(a);
    drop(c);
    assert!(b.try_acquire().is_some(), "归还后必须重新可取");
    assert_eq!(
        b.snapshot()["inFlight"].as_u64(),
        Some(0),
        "凭据 Drop 即归还"
    );
    // 死线之内有位 ⇒ 等到并取到（等位不是拒绝，只是排队到有位）。
    let held = b.try_acquire().expect("占用 1 格");
    let waiter = {
        let b2 = Arc::clone(&b);
        std::thread::spawn(move || {
            b2.acquire(Instant::now() + Duration::from_secs(2))
                .is_some()
        })
    };
    std::thread::sleep(Duration::from_millis(80));
    drop(held);
    assert!(waiter.join().unwrap(), "死线内等到空位必须取到");
}

/// ⑤实测探针（表一：端点自身开销，CI 可跑；可控假 bridge）。
/// 读数经 stdout 出账：`cargo test --lib mcp::tests::b5_endpoint_self_cost_probe -- --nocapture`。
/// 这里**不拿它冒充真壳端到端**——假 bridge 的往返是夹具延时，真壳那一格另测。
#[test]
fn b5_endpoint_self_cost_probe_reports_p50_p95_and_batch_vs_serial() {
    fn pct(v: &[u64], p: u64) -> u64 {
        super::latency::percentile(&std::collections::VecDeque::from(v.to_vec()), p)
    }
    let single_body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"docs/a.txt"}}}"#;
    let ids20: Vec<u64> = (1..=20).collect();

    // ---- A 组：回帧延时 0 ⇒ 墙钟几乎全是端点自身（HTTP 解析 + 闸门 + 台账 + 派发 + 序列化）
    let a = B5Server::start(
        B5Mode::Reply(Duration::from_millis(0)),
        B5Server::b5_limits(5_000, 8, 200_000),
    );
    for _ in 0..10 {
        assert_eq!(mcp_post(a.port, &a.token, single_body).status, 200);
    }
    let mut micros: Vec<u64> = Vec::with_capacity(100);
    let mut fail = 0usize;
    for _ in 0..100 {
        let t = Instant::now();
        let r = mcp_post(a.port, &a.token, single_body);
        micros.push(t.elapsed().as_micros() as u64);
        if r.status != 200 || rpc_json(&r).get("error").map(Value::is_null) == Some(false) {
            fail += 1;
        }
    }
    assert_eq!(fail, 0, "探针期间出现非 200 / 错误帧");
    let batch_warms: Vec<u64> = (0..3)
        .map(|_| {
            let t = Instant::now();
            let r = mcp_post(a.port, &a.token, &b5_batch_body(&ids20, "read_file"));
            assert_eq!(r.status, 200);
            assert_eq!(rpc_json(&r).as_array().map(Vec::len), Some(20));
            t.elapsed().as_micros() as u64
        })
        .collect();
    let serial_warms: Vec<u64> = (0..3)
        .map(|_| {
            let t = Instant::now();
            for _ in 0..20 {
                assert_eq!(mcp_post(a.port, &a.token, single_body).status, 200);
            }
            t.elapsed().as_micros() as u64
        })
        .collect();

    // ---- B 组：回帧延时 20ms（真壳量级）⇒ batch 并发派发 vs 改前串行的等价墙钟
    let b = B5Server::start(
        B5Mode::Reply(Duration::from_millis(20)),
        B5Server::b5_limits(5_000, 8, 200_000),
    );
    let batch_hot: Vec<u64> = (0..3)
        .map(|_| {
            let t = Instant::now();
            let r = mcp_post(b.port, &b.token, &b5_batch_body(&ids20, "read_file"));
            assert_eq!(r.status, 200);
            assert_eq!(rpc_json(&r).as_array().map(Vec::len), Some(20));
            t.elapsed().as_micros() as u64
        })
        .collect();
    let serial_hot: Vec<u64> = (0..3)
        .map(|_| {
            let t = Instant::now();
            for _ in 0..20 {
                assert_eq!(mcp_post(b.port, &b.token, single_body).status, 200);
            }
            t.elapsed().as_micros() as u64
        })
        .collect();
    // 改前 batch 20 条＝同一连接内 20 趟**首尾相接**的往返（`for env in envelopes` 串行），
    // 墙钟等价于「20 条单发串行」那一格，故二者之比就是本批的收益。
    assert!(
        pct(&sorted(&batch_hot), 50) * 2 < pct(&sorted(&serial_hot), 50),
        "batch 并发派发没体现收益：batch {batch_hot:?}µs vs 串行 {serial_hot:?}µs"
    );

    // ---- C 组：8 连接 × 12 条并发吞吐（max_concurrent 的连接闸就在这一格）
    let (port, token) = (a.port, a.token.clone());
    let t0 = Instant::now();
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let token = token.clone();
            std::thread::spawn(move || {
                let mut n = 0usize;
                for _ in 0..12 {
                    if mcp_post(port, &token, single_body).status == 200 {
                        n += 1;
                    }
                }
                n
            })
        })
        .collect();
    let done: usize = workers.into_iter().map(|w| w.join().unwrap()).sum();
    let span = t0.elapsed();
    assert_eq!(
        done, 96,
        "并发 8×12 必须全部成帧（连接闸 / 预算没把它们吃掉）"
    );
    let per_sec = done as f64 / span.as_secs_f64();

    let snap = a.snapshot();
    println!("================ B5 表一：端点自身开销（假 bridge，CI 可跑） ================");
    println!(
        "单条 tools/call（回帧延时 0，n=100，预热 10 后）: p50={}µs p95={}µs p99={}µs max={}µs",
        pct(&micros, 50),
        pct(&micros, 95),
        pct(&micros, 99),
        microsin_max(&micros)
    );
    println!(
        "batch 20 条（同组）: min={}µs med={}µs max={}µs ｜ 20 条单发串行（改前等价）: min={}µs med={}µs max={}µs",
        batch_warms.iter().min().unwrap(),
        pct(&sorted(&batch_warms), 50),
        batch_warms.iter().max().unwrap(),
        serial_warms.iter().min().unwrap(),
        pct(&sorted(&serial_warms), 50),
        serial_warms.iter().max().unwrap()
    );
    println!("---- 回帧延时 20ms（真壳量级）----");
    println!(
        "batch 20 条并发: min={}µs med={}µs max={}µs ｜ 20 条串行: min={}µs med={}µs max={}µs ｜ 收益={:.1}×",
        batch_hot.iter().min().unwrap(),
        pct(&sorted(&batch_hot), 50),
        batch_hot.iter().max().unwrap(),
        serial_hot.iter().min().unwrap(),
        pct(&sorted(&serial_hot), 50),
        serial_hot.iter().max().unwrap(),
        pct(&sorted(&serial_hot), 50) as f64 / pct(&sorted(&batch_hot), 50) as f64
    );
    println!(
        "并发吞吐 8 连接 × 12 条 = {} 条 / {}ms ⇒ {:.1} 次每秒",
        done,
        span.as_millis(),
        per_sec
    );
    println!(
        "端点台账对账：http#tools/call p50={}ms p95={}ms max={}ms seen={} ｜ tools/call#read_file p50={}ms p95={}ms seen={}",
        snap["latency"]["keys"].as_array().unwrap().iter().find(|k| k["key"]=="http#tools/call").unwrap()["p50Ms"].as_u64().unwrap(),
        snap["latency"]["keys"].as_array().unwrap().iter().find(|k| k["key"]=="http#tools/call").unwrap()["p95Ms"].as_u64().unwrap(),
        snap["latency"]["keys"].as_array().unwrap().iter().find(|k| k["key"]=="http#tools/call").unwrap()["maxMs"].as_u64().unwrap(),
        snap["latency"]["keys"].as_array().unwrap().iter().find(|k| k["key"]=="http#tools/call").unwrap()["seen"].as_u64().unwrap(),
        snap["latency"]["keys"].as_array().unwrap().iter().find(|k| k["key"]=="tools/call#read_file").unwrap()["p50Ms"].as_u64().unwrap(),
        snap["latency"]["keys"].as_array().unwrap().iter().find(|k| k["key"]=="tools/call#read_file").unwrap()["p95Ms"].as_u64().unwrap(),
        snap["latency"]["keys"].as_array().unwrap().iter().find(|k| k["key"]=="tools/call#read_file").unwrap()["seen"].as_u64().unwrap(),
    );
    println!("预算现场：{}", snap["budget"]);
    println!("==============================================================================");
    assert!(per_sec > 20.0, "并发吞吐低到说明探针没跑通：{per_sec}");
}

/// 探针打印辅助（只服务读数，不参与判定）。
fn microsin_max(v: &[u64]) -> u64 {
    *v.iter().max().unwrap()
}
fn sorted(v: &[u64]) -> Vec<u64> {
    let mut x = v.to_vec();
    x.sort_unstable();
    x
}

/* ---------------- 写域多根（2026-11-06，additive 判据） ---------------- */

/// 稳定枚举标识，**不是路径**：与 TS `workspace-root-id.ts` 的 `ws:` + 8 hex 对齐。
const ROOT_A: &str = "ws:1a2b3c4d";
const ROOT_B: &str = "ws:deadbeef";

fn tool_call(name: &str, arguments: Value) -> Value {
    json!({"name": name, "arguments": arguments})
}

#[test]
fn multiroot_root_id_shape_accepts_only_enumerated_ids() {
    for good in [ROOT_A, ROOT_B, "ws:00000000"] {
        assert!(is_root_id_shape(good), "应接受 {good}");
    }
    for bad in [
        "",
        "ws:",
        "ws:1a2b3c4",
        "ws:1a2b3c4d5",
        "ws:ABCDEF12",
        "ws:zzzzzzzz",
        "ws:1a2b3c4g",
        "1a2b3c4d",
        "D:\\author-workspace",
        "D:/author-workspace",
        "../../etc",
        "ws:1a2b3c4d/../../etc",
    ] {
        assert!(!is_root_id_shape(bad), "不该接受 {bad}");
    }
}

#[test]
fn multiroot_endpoint_default_scope_denies_every_root_id() {
    // 零变化：不带 rootId 的四枚写腿照旧走项目根，端点不额外拦。
    for name in MULTIROOT_WRITE_TOOLS {
        let p = tool_call(name, json!({"relPath": "docs/a.erb"}));
        assert!(check_root_id_param(WebMethod::ToolsCall, &p, &empty_scope(Vec::new())).is_ok());
    }
    // 一旦带 rootId，默认拒绝：形状合法也不许过。
    let p = tool_call("fileTree.create", json!({"rootId": ROOT_A}));
    let err = check_root_id_param(WebMethod::ToolsCall, &p, &empty_scope(Vec::new())).unwrap_err();
    assert_eq!(err.code, codes::TOOL_NOT_APPROVED);
}

#[test]
fn multiroot_endpoint_second_check_requires_shape_approval_and_write_leg() {
    let mut scope = empty_scope(Vec::new());
    scope.approved_root_ids = vec![ROOT_A.to_string()];

    // 四枚写腿逐一：合法 + 精确批准 ⇒ 放行（真源腿还会再反查一次只读真源）。
    for name in MULTIROOT_WRITE_TOOLS {
        let p = tool_call(name, json!({"relPath": "docs/a.erb", "rootId": ROOT_A}));
        assert!(
            check_root_id_param(WebMethod::ToolsCall, &p, &scope).is_ok(),
            "{name}"
        );
    }

    // 绝对路径 / 盘符 / 穿越形态：钉死「rootId 绝不是任意目标路径入口」。
    for evil in [
        "D:\\author-workspace",
        "D:/author-workspace",
        "../../etc",
        "ws:1a2b3c4d/../x",
    ] {
        let p = tool_call("fileTree.create", json!({"rootId": evil}));
        let e = check_root_id_param(WebMethod::ToolsCall, &p, &scope).unwrap_err();
        assert_eq!(e.code, codes::PATH_TARGET_FORBIDDEN, "{evil}");
    }

    // 形状非法 / 非字符串 ⇒ 显式 INVALID_PARAMS，绝不静默剥离。
    for bad in ["ws:ZZZZZZZZ", "ws:1a2b3c4d5", "ws:zzzzzzzz"] {
        let p = tool_call("fileTree.create", json!({"rootId": bad}));
        assert_eq!(
            check_root_id_param(WebMethod::ToolsCall, &p, &scope)
                .unwrap_err()
                .code,
            codes::INVALID_PARAMS
        );
    }
    let numeric = tool_call("fileTree.create", json!({"rootId": 42}));
    assert_eq!(
        check_root_id_param(WebMethod::ToolsCall, &numeric, &scope)
            .unwrap_err()
            .code,
        codes::INVALID_PARAMS
    );

    // 合法形状但没批准 ⇒ 仍拒绝，绝不退回项目根。
    let other = tool_call("fileTree.update", json!({"rootId": ROOT_B}));
    assert_eq!(
        check_root_id_param(WebMethod::ToolsCall, &other, &scope)
            .unwrap_err()
            .code,
        codes::TOOL_NOT_APPROVED
    );

    // 不得把 rootId 旁路到非写腿（例如 export_file / 只读发现工具）。
    for name in ["export_file", "io.workspaceRoots", "read_file"] {
        let p = tool_call(name, json!({"rootId": ROOT_A}));
        assert_eq!(
            check_root_id_param(WebMethod::ToolsCall, &p, &scope)
                .unwrap_err()
                .code,
            codes::INVALID_PARAMS,
            "{name}"
        );
    }

    // `args` 别名位置同样被复核（与 host-bridge 的 `arguments ?? args` 对齐）。
    let alias = json!({"name": "fileTree.rename", "args": {"rootId": ROOT_A}});
    assert!(check_root_id_param(WebMethod::ToolsCall, &alias, &scope).is_ok());
    let alias_bad = json!({"name": "fileTree.rename", "args": {"rootId": ROOT_B}});
    assert_eq!(
        check_root_id_param(WebMethod::ToolsCall, &alias_bad, &scope)
            .unwrap_err()
            .code,
        codes::TOOL_NOT_APPROVED
    );

    // null 等同未传；只读发现面的回包是 response，不经过请求侧这道闸。
    let null_id = tool_call("fileTree.create", json!({"rootId": Value::Null}));
    assert!(check_root_id_param(WebMethod::ToolsCall, &null_id, &scope).is_ok());
    let listing = json!({"rootId": ROOT_A});
    assert!(check_root_id_param(WebMethod::ToolsList, &listing, &scope).is_ok());
}

#[test]
fn multiroot_grant_roundtrips_explicit_root_ids() {
    let d = TempDir::new();
    let state = scope::approve_with_root_ids(
        d.path(),
        "c1",
        McpTier::Edit,
        vec!["docs".to_string()],
        vec!["fileTree.create".to_string()],
        vec![ROOT_A.to_string(), ROOT_B.to_string(), ROOT_A.to_string()],
    )
    .unwrap();
    assert_eq!(state.sessions.len(), 1);
    // 落盘序列化用冻结契约字段名，不是 Rust 下划线名；重复项去重。
    let text = std::fs::read_to_string(scope::scope_path(d.path())).unwrap();
    assert!(
        text.contains("approvedRootIds"),
        "第四张表要落 approvedRootIds"
    );
    assert!(text.contains(ROOT_A));
    assert!(text.contains(ROOT_B));
    assert_eq!(state.sessions[0].approved_root_ids.len(), 2);

    let loaded = scope::load(d.path()).unwrap();
    let built = scope::build_scope(&loaded, "c1", "sess-1").unwrap();
    assert_eq!(
        built.approved_root_ids,
        vec![ROOT_A.to_string(), ROOT_B.to_string()]
    );
    assert_eq!(built.approved_roots, vec!["docs".to_string()]);
    assert_eq!(built.tier, McpTier::Edit);

    // 端点复核拿这份 scope 就放行；revoke 后又回到默认拒绝。
    let p = tool_call("fileTree.create", json!({"rootId": ROOT_A}));
    assert!(check_root_id_param(WebMethod::ToolsCall, &p, &built).is_ok());
    scope::revoke(d.path(), "c1").unwrap();
    let revoked = scope::build_scope(&scope::load(d.path()).unwrap(), "c1", "sess-2").unwrap();
    assert!(revoked.approved_root_ids.is_empty());
    assert_eq!(
        check_root_id_param(WebMethod::ToolsCall, &p, &revoked)
            .unwrap_err()
            .code,
        codes::TOOL_NOT_APPROVED
    );
}

#[test]
fn multiroot_legacy_five_arg_approve_keeps_default_deny() {
    let d = TempDir::new();
    scope::approve(
        d.path(),
        "legacy",
        McpTier::Edit,
        vec!["docs".to_string()],
        vec!["read_*".to_string()],
    )
    .unwrap();
    let built = scope::build_scope(&scope::load(d.path()).unwrap(), "legacy", "s").unwrap();
    assert!(
        built.approved_root_ids.is_empty(),
        "旧调用不得隐式批准任何根"
    );
    let p = tool_call("fileTree.create", json!({"rootId": ROOT_A}));
    assert_eq!(
        check_root_id_param(WebMethod::ToolsCall, &p, &built)
            .unwrap_err()
            .code,
        codes::TOOL_NOT_APPROVED
    );
}

#[test]
fn multiroot_bad_root_ids_fail_loud_on_approve_and_load() {
    let d = TempDir::new();
    // 批量里混进路径 / 脏形状：整批拒绝，不静默过滤、不落盘。
    for bad in [
        "D:\\author-workspace",
        "ws:ZZZZZZZZ",
        "ws:1a2b3c4d5",
        "../escape",
    ] {
        let err = scope::approve_with_root_ids(
            d.path(),
            "c1",
            McpTier::Edit,
            vec![],
            vec![],
            vec![ROOT_A.to_string(), bad.to_string()],
        )
        .unwrap_err();
        assert_eq!(err.code, codes::INVALID_PARAMS, "{bad}");
    }
    assert!(!scope::scope_path(d.path()).exists(), "拒绝的批次不得落盘");

    // 表里被手工塞进脏 rootId ⇒ build_scope fail loud（不静默丢弃）。
    let forged = scope::McpScopeState {
        version: scope::SCOPE_VERSION,
        sessions: vec![SessionGrant {
            client_id: "c2".to_string(),
            tier: McpTier::Edit,
            approved_roots: vec![],
            approved_tools: vec![],
            approved_root_ids: vec!["ws:ZZZZZZZZ".to_string()],
            created_at: crate::launcher::iso_now(),
            revoked_at: None,
        }],
    };
    scope::save(d.path(), &forged).unwrap();
    assert_eq!(
        scope::build_scope(&scope::load(d.path()).unwrap(), "c2", "s")
            .unwrap_err()
            .code,
        codes::INTERNAL
    );
}

/// 真实 TCP 端点：rootId 的第二道闸必须在 **Rust 端点** 命中，而不只是 WebView
/// 真源腿自己判。四步钉住「默认拒绝 → 批准工具仍拒 → 显式批准根才放行并透传
/// scope → revoke 收回」，且拒绝路径桥零调用。
#[test]
fn e2e_multiroot_root_id_is_second_checked_at_endpoint() {
    let s = TestServer::start();
    let port = s.port;
    let token = s.token.clone();
    let call = r#"{"jsonrpc":"2.0","id":71,"method":"tools/call","params":{"name":"fileTree.create","arguments":{"relPath":"docs/a.erb","kind":"file","content":"x","rootId":"ws:1a2b3c4d"}}}"#.to_string();

    // ① 第四张表缺失（最小权限）：端点显式拒绝，桥从未被调。
    let r = mcp_post_as(port, &token, "harness-mr", &call);
    assert_eq!(r.status, 200);
    assert_eq!(rpc_error_code(&r), "E_TOOL_NOT_APPROVED");
    assert!(s.rx.try_recv().is_err());

    // ② 只提 tier + 精确批准工具、但不批准 rootId ⇒ 照旧拒（工具批准不捎带根）。
    scope::approve(
        s.dir.path(),
        "harness-mr",
        McpTier::Edit,
        vec!["docs".to_string()],
        vec!["fileTree.create".to_string()],
    )
    .unwrap();
    reload_scope_mirror(&s);
    let r = mcp_post_as(port, &token, "harness-mr", &call);
    assert_eq!(rpc_error_code(&r), "E_TOOL_NOT_APPROVED");
    assert!(s.rx.try_recv().is_err());

    // ③ 显式批准 rootId ⇒ 放行到桥；发往 WebView 的 scope 带上 approvedRootIds。
    scope::approve_with_root_ids(
        s.dir.path(),
        "harness-mr",
        McpTier::Edit,
        vec!["docs".to_string()],
        vec!["fileTree.create".to_string()],
        vec![ROOT_A.to_string()],
    )
    .unwrap();
    reload_scope_mirror(&s);
    let token2 = token.clone();
    let call2 = call.clone();
    let worker = std::thread::spawn(move || mcp_post_as(port, &token2, "harness-mr", &call2));
    let payload = s.next_payload();
    assert_eq!(payload.scope.approved_root_ids, vec![ROOT_A.to_string()]);
    assert_eq!(payload.params["arguments"]["rootId"], json!(ROOT_A));
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id,
            ok: true,
            result: Some(json!({"content": [{"type": "text", "text": "created"}]})),
            error: None,
        },
    )
    .unwrap();
    let r = worker.join().unwrap();
    assert_eq!(
        rpc_json(&r)["result"]["content"][0]["text"],
        json!("created")
    );

    // ④ revoke ⇒ 同一调用回到默认拒绝，桥零调用。
    scope::revoke(s.dir.path(), "harness-mr").unwrap();
    reload_scope_mirror(&s);
    let r = mcp_post_as(port, &token, "harness-mr", &call);
    assert_eq!(rpc_error_code(&r), "E_TOOL_NOT_APPROVED");
    assert!(s.rx.try_recv().is_err());
}

/* ==================================================================== *
 * 接入可见性批次（2026-11-06）：首条已鉴权请求 = 可查询、可推送的「接入」信号。
 *
 * 现实问题：`initialize` 在 Rust 本地作答，既不 emit 也不落审计；`status().clients`
 * 只是瞬时并发 TCP 连接数（`Connection: close` 后即减）。于是「客户端到底接上没」
 * 在宿主侧没有任何正面证据，用户只能靠 shim 不报错 / 首次 tools/call 审计间接猜。
 *
 * 这里的判据钉住：有界内存台账（不复用 mcp_audit.jsonl）、只在鉴权通过后记、
 * 同 clientId 去重、首次 emit 事件、查询读数与状态读数 additive、stop/重启清空。
 * ==================================================================== */

/// 记录 `mcp://client-connected` 的测试桥：默认 `emit_request` 照常回填，
/// 新事件单独走一条 channel，便于断言「只在首次握手时推送一次」。
struct EventRecordingBridge {
    tx: Mutex<std::sync::mpsc::Sender<McpRequestPayload>>,
    events: Mutex<std::sync::mpsc::Sender<server::ClientConnect>>,
}

impl McpBridge for EventRecordingBridge {
    fn emit_request(&self, payload: McpRequestPayload) -> Result<(), String> {
        self.tx
            .lock()
            .unwrap()
            .send(payload)
            .map_err(|e| format!("桥接收端已关闭：{e}"))
    }
    fn emit_connected(&self, payload: server::ClientConnect) -> Result<(), String> {
        self.events
            .lock()
            .unwrap()
            .send(payload)
            .map_err(|e| format!("事件接收端已关闭：{e}"))
    }
}

const INIT_BODY: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"harness"}}}"#;
const PING_BODY: &str = r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#;

#[test]
fn e2e_initialize_is_a_visible_handshake() {
    let s = TestServer::start();
    assert!(server::connections_query(&s.state).unwrap().is_empty());
    let r = mcp_post_as(s.port, &s.token, "harness-a", INIT_BODY);
    assert_eq!(r.status, 200);

    let rows = server::connections_query(&s.state).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].client_id, "harness-a");
    assert_eq!(rows[0].method, "initialize");
    assert!(!rows[0].ts.is_empty());
    // 台账不是审计：不落 token、不落请求体、不落端点凭据。
    let text = serde_json::to_string(&rows).unwrap();
    assert!(!text.contains(&s.token));
    assert!(!text.contains("Bearer"));

    // 状态读数 additive：瞬时并发 / 已授权会话 / 已握手 / 发现文件真实路径。
    let status = server::status(&s.state);
    assert_eq!(status.clients, 0); // 请求结束即减：这才是它的真实语义
    assert_eq!(status.connections, 1);
    assert_eq!(status.authorized_sessions, 0); // 第四张表没批准过任何会话
    assert!(status.discovery_path.ends_with("mcp-endpoint.json"));
    assert!(!status.discovery_path.contains(&s.token));
}

#[test]
fn e2e_unauthenticated_request_never_records_a_handshake() {
    let s = TestServer::start();
    let bad = send_request(
        s.port,
        "POST",
        "/mcp",
        &[
            ("Origin", "http://127.0.0.1"),
            ("Accept", "application/json"),
        ],
        Some(INIT_BODY),
    );
    // 端点缺 Bearer 的结构化失败状态码（与既有 e2e_bearer_rejects_* 同口径）。
    assert_eq!(bad.status, 403);
    assert_eq!(rpc_error_code(&bad), "E_UNAUTHORIZED");
    assert!(server::connections_query(&s.state).unwrap().is_empty());
}

#[test]
fn e2e_same_client_refreshes_one_ledger_entry() {
    let s = TestServer::start();
    mcp_post_as(s.port, &s.token, "harness-a", INIT_BODY);
    mcp_post_as(s.port, &s.token, "harness-a", PING_BODY);
    let rows = server::connections_query(&s.state).unwrap();
    assert_eq!(rows.len(), 1, "同 clientId 不该刷出一串条目");
    assert_eq!(rows[0].method, "ping");
}

#[test]
fn e2e_distinct_clients_get_distinct_entries() {
    let s = TestServer::start();
    mcp_post_as(s.port, &s.token, "harness-a", INIT_BODY);
    mcp_post_as(s.port, &s.token, "harness-b", INIT_BODY);
    let rows = server::connections_query(&s.state).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].client_id, "harness-b"); // 最新在前
}

#[test]
fn e2e_connection_ledger_is_bounded() {
    let s = TestServer::start();
    for i in 0..(server::CONNECTION_LEDGER_CAP + 8) {
        mcp_post_as(s.port, &s.token, &format!("client-{i}"), INIT_BODY);
    }
    let rows = server::connections_query(&s.state).unwrap();
    assert_eq!(rows.len(), server::CONNECTION_LEDGER_CAP);
    assert_eq!(
        rows[0].client_id,
        format!("client-{}", server::CONNECTION_LEDGER_CAP + 7)
    );
}

#[test]
fn e2e_connected_event_emits_only_on_first_seen_client() {
    let (tx, rx) = std::sync::mpsc::channel();
    let (etx, erx) = std::sync::mpsc::channel();
    let bridge: Arc<dyn McpBridge> = Arc::new(EventRecordingBridge {
        tx: Mutex::new(tx),
        events: Mutex::new(etx),
    });
    let s = TestServer::spawn(bridge, rx);
    mcp_post_as(s.port, &s.token, "harness-a", INIT_BODY);
    let ev = erx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(ev.client_id, "harness-a");
    assert_eq!(ev.method, "initialize");
    // 同 clientId 再来一次：台账刷新，但不再推送（toast 不刷屏）。
    mcp_post_as(s.port, &s.token, "harness-a", PING_BODY);
    assert!(erx.recv_timeout(Duration::from_millis(200)).is_err());
    // 另一个客户端首次出现：再推一次。
    mcp_post_as(s.port, &s.token, "harness-b", INIT_BODY);
    assert_eq!(
        erx.recv_timeout(Duration::from_secs(5)).unwrap().client_id,
        "harness-b"
    );
}

#[test]
fn e2e_connections_query_is_fail_loud_when_stopped() {
    let s = TestServer::start();
    mcp_post_as(s.port, &s.token, "harness-a", INIT_BODY);
    assert_eq!(server::connections_query(&s.state).unwrap().len(), 1);
    server::stop(&s.state).unwrap();
    assert!(server::connections_query(&s.state).is_err());
    // 重启是全新运行时：旧接入读数不许残留冒充「已连接」。
    let next = server::start(Arc::new(DeadBridge), s.dir.path().to_path_buf(), &s.state).unwrap();
    assert!(server::connections_query(&s.state).unwrap().is_empty());
    assert_ne!(next.token, s.token);
}
/// MCP-PERF-S3 批（LaneI，2026-11-06）：`fileTree.applyChangeset` 的**档位真源**判据。
///
/// 钉四件事（B10 `editor.openDocument` 同型同尺）：
/// ① 点名进 `EDIT_TOOLS_EXACT` 后，read 会话直调 ⇒ E_TIER_DENIED（消息带工具名）；
/// ② 每条拒绝恰写一条 Denied 审计（note = 原始码），绝不静默；
/// ③ 拒绝在 emit 之前：桥从未被调 ⇒ read 会话零批准整批改写不了任何文件；
/// ④ 精确名批准语义零放宽：列入 approvedTools 后同一调用照旧走桥并成功，
///    且成功批次在审计台账记一条 Ok（tool 精确点名 ⇒ 批次可追账）。
#[test]
fn e2e_tools_call_denies_file_tree_apply_changeset_from_read_session() {
    const TOOL: &str = "fileTree.applyChangeset";
    let s = TestServer::start();
    let body = format!(
        r#"{{"jsonrpc":"2.0","id":920,"method":"tools/call","params":{{"name":"{}","arguments":{{"changes":[{{"path":"docs/a.kojo","content":"x"}}]}}}}}}"#,
        TOOL
    );
    let r = mcp_post(s.port, &s.token, &body);
    assert_eq!(r.status, 200, "{TOOL} 必须是 JSON-RPC 错误帧而非传输层失败");
    let v = rpc_json(&r);
    assert_eq!(v["id"], json!(920));
    assert_eq!(v["error"]["code"], json!(-32000), "{TOOL}");
    assert_eq!(
        v["error"]["data"]["code"],
        json!("E_TIER_DENIED"),
        "{TOOL} 未按 Edit 档拒（缺席点名 ⇒ read 会话零批准整批改写）"
    );
    assert!(
        v["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains(TOOL),
        "{TOOL} 拒绝消息必须带上被拒的工具名"
    );
    // ② 恰一条 Denied 审计（本用例只发这一枚 ⇒ 恰一条，note 即原始码）。
    let rows = audit::query(s.dir.path(), 50, None).unwrap();
    let denied: Vec<&AuditEntry> = rows
        .iter()
        .filter(|e| e.outcome == AuditOutcome::Denied)
        .collect();
    assert_eq!(denied.len(), 1, "read 会话直调应恰写一条 Denied 审计");
    assert!(
        denied
            .iter()
            .any(|e| e.tool == TOOL && e.note.as_deref() == Some("E_TIER_DENIED")),
        "{TOOL} 缺一条 E_TIER_DENIED 审计"
    );
    // ③ 拒绝在 emit 之前：桥从未被调。
    assert!(
        s.rx.try_recv().is_err(),
        "read 会话直调 fileTree.applyChangeset 仍被转给 WebView ⇒ 后门复现"
    );

    // ④ 精确名批准语义零放宽：列入后同一调用照旧走桥并成功，审计台账记批次（一条 Ok）。
    scope::approve(
        s.dir.path(),
        "loopback-client",
        McpTier::Read,
        vec![],
        vec![TOOL.to_string()],
    )
    .unwrap();
    reload_scope_mirror(&s);
    let port = s.port;
    let token = s.token.clone();
    let req = format!(
        r#"{{"jsonrpc":"2.0","id":921,"method":"tools/call","params":{{"name":"{}","arguments":{{"changes":[{{"path":"docs/a.kojo","content":"x"}}]}}}}}}"#,
        TOOL
    );
    let worker = std::thread::spawn(move || mcp_post(port, &token, &req));
    let payload = s.next_payload();
    assert_eq!(payload.method, "tools/call");
    assert_eq!(payload.params["name"], json!(TOOL));
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id,
            ok: true,
            result: Some(
                json!({"content": [{"type": "text", "text": "{\"totals\":{\"applied\":1}}"}]}),
            ),
            error: None,
        },
    )
    .unwrap();
    let r2 = worker.join().unwrap();
    let v2 = rpc_json(&r2);
    assert!(
        v2["error"].is_null(),
        "精确名批准后 fileTree.applyChangeset 仍被拒 ⇒ 收口误伤批准语义"
    );
    let rows = audit::query(s.dir.path(), 50, None).unwrap();
    let ok: Vec<&AuditEntry> = rows
        .iter()
        .filter(|e| e.outcome == AuditOutcome::Ok)
        .collect();
    assert_eq!(
        ok.len(),
        1,
        "批准后成功批次应恰记一条 Ok 审计（批次可追账）"
    );
    assert_eq!(ok[0].tool, TOOL, "Ok 审计必须精确点名批次工具");
}

/// MCP-PERF-S3 批（LaneI，2026-11-06）：`fileTree.applyChangeset` 的 **rootId 端点级二次复核**。
///
/// 新工具进 `MULTIROOT_WRITE_TOOLS` 后同尺复验（e2e_multiroot 同型）：整批一个根，
/// 未批准根拒绝 / 批准后放行并透传 scope / revoke 回到默认拒绝；审计台账全程可追。
#[test]
fn e2e_apply_changeset_root_id_is_second_checked_at_endpoint() {
    let s = TestServer::start();
    let port = s.port;
    let token = s.token.clone();
    let call = format!(
        r#"{{"jsonrpc":"2.0","id":81,"method":"tools/call","params":{{"name":"fileTree.applyChangeset","arguments":{{"changes":[{{"path":"docs/a.kojo","content":"x"}}],"rootId":"{ROOT_A}"}}}}}}"#
    );

    // ① 第四张表缺失（最小权限）：端点显式拒绝，桥从未被调。
    let r = mcp_post_as(port, &token, "harness-cs", &call);
    assert_eq!(r.status, 200);
    assert_eq!(rpc_error_code(&r), "E_TOOL_NOT_APPROVED");
    assert!(s.rx.try_recv().is_err());

    // ② 只提 tier + 精确批准工具、但不批准 rootId ⇒ 照旧拒（工具批准不捎带根）。
    scope::approve(
        s.dir.path(),
        "harness-cs",
        McpTier::Edit,
        vec!["docs".to_string()],
        vec!["fileTree.applyChangeset".to_string()],
    )
    .unwrap();
    reload_scope_mirror(&s);
    let r = mcp_post_as(port, &token, "harness-cs", &call);
    assert_eq!(rpc_error_code(&r), "E_TOOL_NOT_APPROVED");
    assert!(s.rx.try_recv().is_err());

    // ③ 显式批准 rootId ⇒ 放行到桥；发往 WebView 的 scope 带上 approvedRootIds，整批透传。
    scope::approve_with_root_ids(
        s.dir.path(),
        "harness-cs",
        McpTier::Edit,
        vec!["docs".to_string()],
        vec!["fileTree.applyChangeset".to_string()],
        vec![ROOT_A.to_string()],
    )
    .unwrap();
    reload_scope_mirror(&s);
    let token2 = token.clone();
    let call2 = call.clone();
    let worker = std::thread::spawn(move || mcp_post_as(port, &token2, "harness-cs", &call2));
    let payload = s.next_payload();
    assert_eq!(payload.scope.approved_root_ids, vec![ROOT_A.to_string()]);
    assert_eq!(payload.params["arguments"]["rootId"], json!(ROOT_A));
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id,
            ok: true,
            result: Some(json!({"content": [{"type": "text", "text": "changeset-applied"}]})),
            error: None,
        },
    )
    .unwrap();
    let r = worker.join().unwrap();
    assert_eq!(
        rpc_json(&r)["result"]["content"][0]["text"],
        json!("changeset-applied")
    );
    // 审计台账：本用例的一条成功批次可追（Ok + 精确点名）。
    let rows = audit::query(s.dir.path(), 50, None).unwrap();
    assert!(rows
        .iter()
        .any(|e| e.outcome == AuditOutcome::Ok && e.tool == "fileTree.applyChangeset"));

    // ④ revoke ⇒ 同一调用回到默认拒绝，桥零调用。
    scope::revoke(s.dir.path(), "harness-cs").unwrap();
    reload_scope_mirror(&s);
    let r = mcp_post_as(port, &token, "harness-cs", &call);
    assert_eq!(rpc_error_code(&r), "E_TOOL_NOT_APPROVED");
    assert!(s.rx.try_recv().is_err());
}

/// MCP-PERF-S3 批：`MULTIROOT_WRITE_TOOLS` 表内自证——新写腿在册（缺席 = 表漂移），
/// 且 rootId 复核对五枚写腿逐一放行、对非写腿照旧拒绝。
#[test]
fn apply_changeset_is_registered_multiroot_write_leg_and_edit_tier() {
    assert!(
        MULTIROOT_WRITE_TOOLS.contains(&"fileTree.applyChangeset"),
        "fileTree.applyChangeset 不在 MULTIROOT_WRITE_TOOLS ⇒ rootId 端点复核对它失效"
    );
    assert!(
        EDIT_TOOLS_EXACT.contains(&"fileTree.applyChangeset"),
        "fileTree.applyChangeset 不在 EDIT_TOOLS_EXACT ⇒ 端点判 read 后门复现"
    );
    assert_eq!(host_required_tier("fileTree.applyChangeset"), McpTier::Edit);
    let scope = McpSessionScope {
        tier: McpTier::Edit,
        approved_root_ids: vec![ROOT_A.to_string()],
        ..empty_scope(Vec::new())
    };
    let p = tool_call(
        "fileTree.applyChangeset",
        json!({"changes": [{"path": "docs/a.kojo", "content": "x"}], "rootId": ROOT_A}),
    );
    assert!(
        check_root_id_param(WebMethod::ToolsCall, &p, &scope).is_ok(),
        "批准后的合法批次 + rootId 必须放行"
    );
    let p = tool_call(
        "fileTree.applyChangeset",
        json!({"changes": [{"path": "docs/a.kojo", "content": "x"}], "rootId": ROOT_B}),
    );
    assert_eq!(
        check_root_id_param(WebMethod::ToolsCall, &p, &scope)
            .unwrap_err()
            .code,
        codes::TOOL_NOT_APPROVED,
        "未批准根必须逐枚拒绝（绝不退回项目根）"
    );
}

/* ==================================================================== *
 * MCP-PERF-S4 批（LaneK，2026-11-07）：范围读 + 结构读两枚 read 面
 *
 * TRAE 性能分析 P1：「范围读/结构读：read_range（行区间）＋outline（函数列表）必须先有，
 * 否则 agent 只能整文件读 5 万行」。端点级回归钉三件事：
 *   ① 两枚都是 `命名空间.动词` 点号形态 ⇒ 宿主按**默认 read** 放行（不点名即 read 是
 *      既有口径；本批不进 EDIT_TOOLS_EXACT / PRIVILEGED_EXACT，read 会话零批准可调）；
 *   ② 端到端：read 会话直调两枚都放行到桥，审计 Ok 精确点名、零 Denied（未批准语义
 *      零变化——本批不给任何既有面新增拦截）；
 *   ③ `fs.readRange` 收可选 rootId（选域基准根，与写腿同一条三道拦截）⇒ 必须进
 *      MULTIROOT 端点复核表（防旁路闸对它生效：形状 / PATH_TARGET_FORBIDDEN /
 *      第四张表精确列名，默认拒绝一字不变）；不在表内的读面带 rootId 照旧被拒。
 * ==================================================================== */

#[test]
fn perf_s4_read_range_and_project_symbols_are_read_tier() {
    assert_eq!(host_required_tier("fs.readRange"), McpTier::Read);
    assert_eq!(host_required_tier("semantic.projectSymbols"), McpTier::Read);
    assert!(
        !EDIT_TOOLS_EXACT.contains(&"fs.readRange"),
        "fs.readRange 是纯读面，进 EDIT 表＝误升档"
    );
    assert!(
        !EDIT_TOOLS_EXACT.contains(&"semantic.projectSymbols"),
        "semantic.projectSymbols 是纯读面，进 EDIT 表＝误升档"
    );
    assert!(
        MULTIROOT_WRITE_TOOLS.contains(&"fs.readRange"),
        "fs.readRange 收可选 rootId ⇒ 必须在端点复核表内，否则防旁路闸对它失效"
    );
    // read 会话（零批准）直调两枚：纯函数闸放行（默认拒绝只对 edit/privileged 生效）。
    let scope = empty_scope(Vec::new());
    assert!(check_tool_call_permission("fs.readRange", &scope).is_ok());
    assert!(check_tool_call_permission("semantic.projectSymbols", &scope).is_ok());

    // rootId 防旁路闸照旧：不在表内的读面带 rootId ⇒ INVALID_PARAMS；
    // fs.readRange 的 rootId 走路径形态拒绝（绝不把 rootId 当任意落点入口）。
    let p = tool_call("semantic.projectSymbols", json!({"rootId": ROOT_A}));
    assert_eq!(
        check_root_id_param(WebMethod::ToolsCall, &p, &scope)
            .unwrap_err()
            .code,
        codes::INVALID_PARAMS
    );
    let p = tool_call(
        "fs.readRange",
        json!({"relPath": "a.erb", "startLine": 1, "endLine": 2, "rootId": "D:/evil"}),
    );
    assert_eq!(
        check_root_id_param(WebMethod::ToolsCall, &p, &scope)
            .unwrap_err()
            .code,
        codes::PATH_TARGET_FORBIDDEN
    );
    // 第四张表批准后 fs.readRange 的合法 rootId 放行（与五枚写腿逐字同尺）。
    let scope2 = McpSessionScope {
        tier: McpTier::Read,
        approved_root_ids: vec![ROOT_A.to_string()],
        ..empty_scope(Vec::new())
    };
    let p = tool_call(
        "fs.readRange",
        json!({"relPath": "a.erb", "startLine": 1, "endLine": 2, "rootId": ROOT_A}),
    );
    assert!(
        check_root_id_param(WebMethod::ToolsCall, &p, &scope2).is_ok(),
        "批准后的合法 rootId 必须放行（读腿与写腿同尺，不另立口径）"
    );
}

#[test]
fn e2e_read_session_calls_read_range_and_project_symbols_via_bridge() {
    let s = TestServer::start();
    let port = s.port;
    let token = s.token.clone();

    // ① read 会话零批准直调 fs.readRange：放行到桥（read 档面不新增任何拦截）。
    let req = r#"{"jsonrpc":"2.0","id":91,"method":"tools/call","params":{"name":"fs.readRange","arguments":{"relPath":"k/a.erb","startLine":2,"endLine":3}}}"#.to_string();
    let worker = std::thread::spawn(move || mcp_post(port, &token, &req));
    let payload = s.next_payload();
    assert_eq!(payload.scope.tier, McpTier::Read);
    assert_eq!(payload.params["name"], json!("fs.readRange"));
    assert_eq!(payload.params["arguments"]["startLine"], json!(2));
    assert_eq!(payload.params["arguments"]["endLine"], json!(3));
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id,
            ok: true,
            result: Some(json!({"content": [{"type": "text", "text": "rows"}]})),
            error: None,
        },
    )
    .unwrap();
    let r = worker.join().unwrap();
    assert!(
        rpc_json(&r)["error"].is_null(),
        "read 会话调 read 面不许被端点拦"
    );

    // ② semantic.projectSymbols 同尺：零参调用照常转发。
    let token2 = s.token.clone();
    let req2 = r#"{"jsonrpc":"2.0","id":92,"method":"tools/call","params":{"name":"semantic.projectSymbols","arguments":{}}}"#.to_string();
    let worker2 = std::thread::spawn(move || mcp_post(port, &token2, &req2));
    let payload2 = s.next_payload();
    assert_eq!(payload2.scope.tier, McpTier::Read);
    assert_eq!(payload2.params["name"], json!("semantic.projectSymbols"));
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload2.id,
            ok: true,
            result: Some(json!({"content": [{"type": "text", "text": "symbols"}]})),
            error: None,
        },
    )
    .unwrap();
    let r2 = worker2.join().unwrap();
    assert!(rpc_json(&r2)["error"].is_null());

    // ③ 审计：两条 Ok 精确点名；本用例零 Denied（未批准语义零变化——两枚 read 面不新拦）。
    let rows = audit::query(s.dir.path(), 50, None).unwrap();
    assert!(rows
        .iter()
        .any(|e| e.outcome == AuditOutcome::Ok && e.tool == "fs.readRange"));
    assert!(rows
        .iter()
        .any(|e| e.outcome == AuditOutcome::Ok && e.tool == "semantic.projectSymbols"));
    assert!(
        !rows.iter().any(|e| e.outcome == AuditOutcome::Denied),
        "read 面调用不该产生 Denied 审计"
    );
}

/* ==================================================================== *
 * MCP-PERF-S10 批（LaneT，2026-11-07）：semantic.batchAt 批量读面
 *
 * TRAE P1：「语言服务……补批量接口；50 个符号批量 <200ms」。端点级回归同 S4 双钉：
 *   ① `semantic.batchAt` 是 `命名空间.动词` 点号形态的**纯读**面 ⇒ 宿主按默认 read 放行
 *      （不点名即 read 是既有口径；本批不进 EDIT_TOOLS_EXACT / PRIVILEGED_EXACT，
 *      read 会话零批准可调，四张授权表零改动）；
 *   ② 端到端：read 会话直调放行到桥（items 原样转发），审计 Ok 精确点名、零 Denied
 *      （未批准语义零变化——本批不给任何既有面新增拦截）。
 * ==================================================================== */

#[test]
fn perf_s10_semantic_batch_at_is_read_tier() {
    assert_eq!(host_required_tier("semantic.batchAt"), McpTier::Read);
    assert!(
        !EDIT_TOOLS_EXACT.contains(&"semantic.batchAt"),
        "semantic.batchAt 是纯读面，进 EDIT 表＝误升档"
    );
    assert!(
        !PRIVILEGED_EXACT.contains(&"semantic.batchAt"),
        "semantic.batchAt 不碰危险面，进 PRIVILEGED 表＝误升档"
    );
    // read 会话（零批准）直调：纯函数闸放行（默认拒绝只对 edit/privileged 生效）。
    let scope = empty_scope(Vec::new());
    assert!(check_tool_call_permission("semantic.batchAt", &scope).is_ok());
}

#[test]
fn e2e_read_session_calls_semantic_batch_at_via_bridge() {
    let s = TestServer::start();
    let port = s.port;
    let token = s.token.clone();

    // ① read 会话零批准直调 semantic.batchAt：放行到桥，items 原样转发（read 档面不新增拦截）。
    let req = r#"{"jsonrpc":"2.0","id":910,"method":"tools/call","params":{"name":"semantic.batchAt","arguments":{"items":[{"line":1,"column":1,"kind":"definition"},{"line":2,"column":2,"kind":"references","includeDeclaration":false}]}}}"#.to_string();
    let worker = std::thread::spawn(move || mcp_post(port, &token, &req));
    let payload = s.next_payload();
    assert_eq!(payload.scope.tier, McpTier::Read);
    assert_eq!(payload.params["name"], json!("semantic.batchAt"));
    assert_eq!(
        payload.params["arguments"]["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        payload.params["arguments"]["items"][0]["kind"],
        json!("definition")
    );
    assert_eq!(
        payload.params["arguments"]["items"][1]["includeDeclaration"],
        json!(false)
    );
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id,
            ok: true,
            result: Some(json!({"content": [{"type": "text", "text": "batch"}]})),
            error: None,
        },
    )
    .unwrap();
    let r = worker.join().unwrap();
    assert!(
        rpc_json(&r)["error"].is_null(),
        "read 会话调 read 批量面不许被端点拦"
    );

    // ② 审计：恰一条 Ok 精确点名；本用例零 Denied（未批准语义零变化——read 批量面不新拦）。
    let rows = audit::query(s.dir.path(), 50, None).unwrap();
    assert!(rows
        .iter()
        .any(|e| e.outcome == AuditOutcome::Ok && e.tool == "semantic.batchAt"));
    assert!(
        !rows.iter().any(|e| e.outcome == AuditOutcome::Denied),
        "read 批量面调用不该产生 Denied 审计"
    );
}

/// MCP-PERF-S6 批（LaneN，2026-11-07）：`fileTree.patchLines` 的**档位真源**判据。
///
/// 与 S3 `fileTree.applyChangeset` 三条同型同尺：
/// ① 点名进 `EDIT_TOOLS_EXACT` 后，read 会话直调 ⇒ E_TIER_DENIED（消息带工具名）；
/// ② 每条拒绝恰写一条 Denied 审计（note = 原始码），绝不静默；
/// ③ 拒绝在 emit 之前：桥从未被调 ⇒ read 会话零批准 patch 改写不了任何文件；
/// ④ 精确名批准语义零放宽：列入 approvedTools 后同一调用照旧走桥并成功，
///    且成功批次在审计台账记一条 Ok（tool 精确点名 ⇒ 批次可追账）。
#[test]
fn e2e_tools_call_denies_file_tree_patch_lines_from_read_session() {
    const TOOL: &str = "fileTree.patchLines";
    let s = TestServer::start();
    let body = format!(
        r#"{{"jsonrpc":"2.0","id":930,"method":"tools/call","params":{{"name":"{}","arguments":{{"relPath":"docs/a.kojo","hunks":[{{"startLine":1,"endLine":1,"replacement":"x"}}]}}}}}}"#,
        TOOL
    );
    let r = mcp_post(s.port, &s.token, &body);
    assert_eq!(r.status, 200, "{TOOL} 必须是 JSON-RPC 错误帧而非传输层失败");
    let v = rpc_json(&r);
    assert_eq!(v["id"], json!(930));
    assert_eq!(v["error"]["code"], json!(-32000), "{TOOL}");
    assert_eq!(
        v["error"]["data"]["code"],
        json!("E_TIER_DENIED"),
        "{TOOL} 未按 Edit 档拒（缺席点名 ⇒ read 会话零批准 patch 级改写）"
    );
    assert!(
        v["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains(TOOL),
        "{TOOL} 拒绝消息必须带上被拒的工具名"
    );
    // ② 恰一条 Denied 审计（本用例只发这一枚 ⇒ 恰一条，note 即原始码）。
    let rows = audit::query(s.dir.path(), 50, None).unwrap();
    let denied: Vec<&AuditEntry> = rows
        .iter()
        .filter(|e| e.outcome == AuditOutcome::Denied)
        .collect();
    assert_eq!(denied.len(), 1, "read 会话直调应恰写一条 Denied 审计");
    assert!(
        denied
            .iter()
            .any(|e| e.tool == TOOL && e.note.as_deref() == Some("E_TIER_DENIED")),
        "{TOOL} 缺一条 E_TIER_DENIED 审计"
    );
    // ③ 拒绝在 emit 之前：桥从未被调。
    assert!(
        s.rx.try_recv().is_err(),
        "read 会话直调 fileTree.patchLines 仍被转给 WebView ⇒ 后门复现"
    );

    // ④ 精确名批准语义零放宽：列入后同一调用照旧走桥并成功，审计台账记批次（一条 Ok）。
    scope::approve(
        s.dir.path(),
        "loopback-client",
        McpTier::Read,
        vec![],
        vec![TOOL.to_string()],
    )
    .unwrap();
    reload_scope_mirror(&s);
    let port = s.port;
    let token = s.token.clone();
    let req = format!(
        r#"{{"jsonrpc":"2.0","id":931,"method":"tools/call","params":{{"name":"{}","arguments":{{"relPath":"docs/a.kojo","hunks":[{{"startLine":1,"endLine":1,"replacement":"x"}}]}}}}}}"#,
        TOOL
    );
    let worker = std::thread::spawn(move || mcp_post(port, &token, &req));
    let payload = s.next_payload();
    assert_eq!(payload.method, "tools/call");
    assert_eq!(payload.params["name"], json!(TOOL));
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id,
            ok: true,
            result: Some(
                json!({"content": [{"type": "text", "text": "{\"totals\":{\"applied\":1}}"}]}),
            ),
            error: None,
        },
    )
    .unwrap();
    let r2 = worker.join().unwrap();
    let v2 = rpc_json(&r2);
    assert!(
        v2["error"].is_null(),
        "精确名批准后 fileTree.patchLines 仍被拒 ⇒ 收口误伤批准语义"
    );
    let rows = audit::query(s.dir.path(), 50, None).unwrap();
    let ok: Vec<&AuditEntry> = rows
        .iter()
        .filter(|e| e.outcome == AuditOutcome::Ok)
        .collect();
    assert_eq!(
        ok.len(),
        1,
        "批准后成功批次应恰记一条 Ok 审计（批次可追账）"
    );
    assert_eq!(ok[0].tool, TOOL, "Ok 审计必须精确点名批次工具");
}

/// MCP-PERF-S6 批（LaneN，2026-11-07）：`fileTree.patchLines` 的 **rootId 端点级二次复核**。
///
/// 新工具进 `MULTIROOT_WRITE_TOOLS` 后同尺复验（S3 e2e_apply_changeset 同型）：
/// 整批一个根，未批准根拒绝 / 批准后放行并透传 scope / revoke 回到默认拒绝；
/// 审计台账全程可追。
#[test]
fn e2e_patch_lines_root_id_is_second_checked_at_endpoint() {
    let s = TestServer::start();
    let port = s.port;
    let token = s.token.clone();
    let call = format!(
        r#"{{"jsonrpc":"2.0","id":82,"method":"tools/call","params":{{"name":"fileTree.patchLines","arguments":{{"relPath":"docs/a.kojo","hunks":[{{"startLine":1,"endLine":1,"replacement":"x"}}],"rootId":"{ROOT_A}"}}}}}}"#
    );

    // ① 第四张表缺失（最小权限）：端点显式拒绝，桥从未被调。
    let r = mcp_post_as(port, &token, "harness-pl", &call);
    assert_eq!(r.status, 200);
    assert_eq!(rpc_error_code(&r), "E_TOOL_NOT_APPROVED");
    assert!(s.rx.try_recv().is_err());

    // ② 只提 tier + 精确批准工具、但不批准 rootId ⇒ 照旧拒（工具批准不捎带根）。
    scope::approve(
        s.dir.path(),
        "harness-pl",
        McpTier::Edit,
        vec!["docs".to_string()],
        vec!["fileTree.patchLines".to_string()],
    )
    .unwrap();
    reload_scope_mirror(&s);
    let r = mcp_post_as(port, &token, "harness-pl", &call);
    assert_eq!(rpc_error_code(&r), "E_TOOL_NOT_APPROVED");
    assert!(s.rx.try_recv().is_err());

    // ③ 显式批准 rootId ⇒ 放行到桥；发往 WebView 的 scope 带上 approvedRootIds，整批透传。
    scope::approve_with_root_ids(
        s.dir.path(),
        "harness-pl",
        McpTier::Edit,
        vec!["docs".to_string()],
        vec!["fileTree.patchLines".to_string()],
        vec![ROOT_A.to_string()],
    )
    .unwrap();
    reload_scope_mirror(&s);
    let token2 = token.clone();
    let call2 = call.clone();
    let worker = std::thread::spawn(move || mcp_post_as(port, &token2, "harness-pl", &call2));
    let payload = s.next_payload();
    assert_eq!(payload.scope.approved_root_ids, vec![ROOT_A.to_string()]);
    assert_eq!(payload.params["arguments"]["rootId"], json!(ROOT_A));
    server::deliver(
        &s.state,
        McpRespondArgs {
            id: payload.id,
            ok: true,
            result: Some(json!({"content": [{"type": "text", "text": "patch-lines-applied"}]})),
            error: None,
        },
    )
    .unwrap();
    let r = worker.join().unwrap();
    assert_eq!(
        rpc_json(&r)["result"]["content"][0]["text"],
        json!("patch-lines-applied")
    );
    // 审计台账：本用例的一条成功批次可追（Ok + 精确点名）。
    let rows = audit::query(s.dir.path(), 50, None).unwrap();
    assert!(rows
        .iter()
        .any(|e| e.outcome == AuditOutcome::Ok && e.tool == "fileTree.patchLines"));

    // ④ revoke ⇒ 同一调用回到默认拒绝，桥零调用。
    scope::revoke(s.dir.path(), "harness-pl").unwrap();
    reload_scope_mirror(&s);
    let r = mcp_post_as(port, &token, "harness-pl", &call);
    assert_eq!(rpc_error_code(&r), "E_TOOL_NOT_APPROVED");
    assert!(s.rx.try_recv().is_err());
}

/// MCP-PERF-S6 批：`MULTIROOT_WRITE_TOOLS` / `EDIT_TOOLS_EXACT` 表内自证——
/// 新写腿在册（缺席 = 表漂移），且 rootId 复核对它放行（批准根）/ 对未批准根拒绝。
#[test]
fn patch_lines_is_registered_multiroot_write_leg_and_edit_tier() {
    assert!(
        MULTIROOT_WRITE_TOOLS.contains(&"fileTree.patchLines"),
        "fileTree.patchLines 不在 MULTIROOT_WRITE_TOOLS ⇒ rootId 端点复核对它失效"
    );
    assert!(
        EDIT_TOOLS_EXACT.contains(&"fileTree.patchLines"),
        "fileTree.patchLines 不在 EDIT_TOOLS_EXACT ⇒ 端点判 read 后门复现"
    );
    assert_eq!(host_required_tier("fileTree.patchLines"), McpTier::Edit);
    let scope = McpSessionScope {
        tier: McpTier::Edit,
        approved_root_ids: vec![ROOT_A.to_string()],
        ..empty_scope(Vec::new())
    };
    let p = tool_call(
        "fileTree.patchLines",
        json!({"relPath": "docs/a.kojo", "hunks": [{"startLine": 1, "endLine": 1, "replacement": "x"}], "rootId": ROOT_A}),
    );
    assert!(
        check_root_id_param(WebMethod::ToolsCall, &p, &scope).is_ok(),
        "批准后的合法批次 + rootId 必须放行"
    );
    let p = tool_call(
        "fileTree.patchLines",
        json!({"relPath": "docs/a.kojo", "hunks": [{"startLine": 1, "endLine": 1, "replacement": "x"}], "rootId": ROOT_B}),
    );
    assert_eq!(
        check_root_id_param(WebMethod::ToolsCall, &p, &scope)
            .unwrap_err()
            .code,
        codes::TOOL_NOT_APPROVED,
        "未批准根必须逐枚拒绝（绝不退回项目根）"
    );
}
