//! 路 C 的 Rust 判据（纯函数 + 临时目录落盘；不启动线程 / 不碰真 Tauri 运行时）。
//!
//! 覆盖：线协议编解码、路径闸门、危险工具过滤、无状态协商、第四张表读写与
//! 最小权限、审计摘要不落全文、Origin/Bearer/限流三闸、发现文件生命周期。

use super::audit::{self, AuditEntry, AuditOutcome};
use super::protocol::*;
use super::scope::{self, SessionGrant};
use super::server::{self, EndpointFile, HttpHead, Limits, RateState};
use serde_json::json;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

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
