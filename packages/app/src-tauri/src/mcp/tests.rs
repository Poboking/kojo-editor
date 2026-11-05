//! 路 C 的 Rust 判据（纯函数 + 临时目录落盘 + 真实 TCP/HTTP 端到端）。
//!
//! 覆盖：线协议编解码、路径闸门、危险工具过滤、无状态协商、第四张表读写与
//! 最小权限、审计摘要不落全文、Origin/Bearer/限流三闸、发现文件生命周期；
//! 端到端节用 `server.rs` 的真实 listener 在 127.0.0.1 起端口，`std::net::TcpStream`
//! 发裸 HTTP 打全协议面（WebView 桥注入桩，回填走生产 `deliver` 路径）。

use super::audit::{self, AuditEntry, AuditOutcome};
use super::protocol::*;
use super::scope::{self, SessionGrant};
use super::server::{self, EndpointFile, HttpHead, Limits, McpBridge, McpShared, RateState};
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
    let limits = Limits {
        max_calls_per_minute: 2,
        ..Limits::default()
    };
    let rate = Mutex::new(RateState {
        window_start: Instant::now(),
        count: 0,
    });
    assert!(server::check_rate(&rate, &limits).is_ok());
    assert!(server::check_rate(&rate, &limits).is_ok());
    assert_eq!(
        server::check_rate(&rate, &limits).unwrap_err().code,
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
    pending.lock().unwrap().insert(
        "mcp-1".to_string(),
        server::Pending {
            tx,
            rpc_id: json!(1),
            method: "tools/call".to_string(),
            tool_name: Some("export_file".to_string()),
            started: Instant::now(),
        },
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
