//! MCP 逐请求耗时台账（路 C · B5 吞吐与延迟批）。
//!
//! 职责：**纯统计**——把 `Pending.started` 那枚已经在带、此前无人读数的真源落成
//! 可读的分位数（p50 / p95 / p99 / max），按「方法」与「方法#工具名」两种键聚合。
//! 本模块零游戏语义、零线协议知识：只知道「某个键的某次调用花了多少毫秒」。
//!
//! 可见化口径（AGENTS.md 铁律 4「内核不静默」）：
//! - 每个键只保留最近 `SAMPLE_WINDOW` 个样本，**丢弃计数 `dropped` 与真实总次数
//!   `seen` 一并出账**——分位数是「最近窗口」的读数，不冒充全历史；
//! - 键数超过 `MAX_KEYS` 时不再新增键，多出的样本并入溢出键 `OVERFLOW_KEY`
//!   并记 `overflowKeys`，绝不静默丢样本。
//!
//! 台账只由宿主侧写入、只经 `mcp_latency_query`（WebView / 调试壳读）读出；
//! MCP 客户端没有任何入口能读写它——与审计日志同一纵深。

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::time::Duration;

/// 每键保留的样本数（滑动窗口）；更早的样本丢弃但计数出声。
pub const SAMPLE_WINDOW: usize = 512;
/// 键数上限：工具名是开放集合（43 枚具名工具 × 六种方法仍有界），超限并入溢出键。
pub const MAX_KEYS: usize = 1024;
/// 溢出键名：键数超上限后所有样本归到这里（可见，不静默丢）。
pub const OVERFLOW_KEY: &str = "overflow";

/// 单个键的分位数读数（`Serialize` 直接进 IPC 返回体）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LatencyStat {
    /// 键：`方法` 或 `方法#工具名` / `http#方法`（见 `LatencyKey`）。
    pub key: String,
    /// 累计样本数（含被窗口丢弃的）。
    pub seen: u64,
    /// 因窗口滚动被丢弃的样本数（`seen - 窗口内样本数` 的那部分）。
    pub dropped: u64,
    /// 窗口内样本数（参与分位数计算的样本个数）。
    pub samples: usize,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
    pub max_ms: u64,
    /// 全历史均值（用累计毫秒 / 累计次数，不受窗口丢弃影响）。
    pub avg_ms: u64,
}

/// 耗时键的构造口径集中在这里，避免调用方散写字符串格式。
pub enum LatencyKey<'a> {
    /// 端点 → WebView 的往返（`Pending.started` → 应答落账）。
    Bridge {
        method: &'a str,
        tool: Option<&'a str>,
    },
    /// 整趟 HTTP 请求的墙钟（含解析 / 台账 / 派发循环 / 序列化）。
    Http { method: &'a str },
}

impl<'a> LatencyKey<'a> {
    pub fn as_str(&self) -> String {
        match self {
            LatencyKey::Bridge { method, tool } => match tool {
                Some(t) => format!("{method}#{t}"),
                None => method.to_string(),
            },
            LatencyKey::Http { method } => format!("http#{method}"),
        }
    }
}

#[derive(Debug, Default)]
struct KeyStat {
    /// 最近 `SAMPLE_WINDOW` 个样本（毫秒），环形滚动丢弃最旧。
    samples: VecDeque<u64>,
    seen: u64,
    dropped: u64,
    max_ms: u64,
    total_ms: u64,
}

/// 耗时台账（放在 `McpShared` 的一把 `Mutex` 里，写入点全在请求收尾处）。
#[derive(Debug)]
pub struct Ledger {
    per_key: HashMap<String, KeyStat>,
    /// 每键保留样本数（来自 `Limits::latency_window`）。
    window: usize,
    /// 因键数上限而未能单独建键的次数（溢出键的样本数另算）。
    overflow_keys: u64,
}

impl Default for Ledger {
    fn default() -> Self {
        Self::new()
    }
}

impl Ledger {
    pub fn new() -> Self {
        Self::with_window(SAMPLE_WINDOW)
    }
    pub fn with_window(window: usize) -> Self {
        Self {
            per_key: HashMap::new(),
            window: window.max(1),
            overflow_keys: 0,
        }
    }
    pub fn record(&mut self, key: &str, elapsed: Duration) {
        let ms = elapsed.as_millis() as u64;
        let target = match self.per_key.get(key) {
            Some(_) => key.to_string(),
            None => {
                if self.per_key.len() >= MAX_KEYS {
                    self.overflow_keys += 1;
                    OVERFLOW_KEY.to_string()
                } else {
                    key.to_string()
                }
            }
        };
        let stat = self.per_key.entry(target).or_default();
        stat.seen += 1;
        stat.total_ms += ms;
        if stat.max_ms < ms {
            stat.max_ms = ms;
        }
        if stat.samples.len() >= self.window {
            stat.samples.pop_front();
            stat.dropped += 1;
        }
        stat.samples.push_back(ms);
    }

    /// 全键快照（按键名升序，便于逐批对账 diff）。
    pub fn stats(&self) -> Vec<LatencyStat> {
        let mut out: Vec<LatencyStat> = self
            .per_key
            .iter()
            .map(|(key, s)| LatencyStat {
                key: key.clone(),
                seen: s.seen,
                dropped: s.dropped,
                samples: s.samples.len(),
                p50_ms: percentile(&s.samples, 50),
                p95_ms: percentile(&s.samples, 95),
                p99_ms: percentile(&s.samples, 99),
                max_ms: s.max_ms,
                avg_ms: if s.seen == 0 { 0 } else { s.total_ms / s.seen },
            })
            .collect();
        out.sort_by(|a, b| a.key.cmp(&b.key));
        out
    }

    /// 键数溢出计数的出账口径唯一＝`to_json` 的 `overflowKeys` 格（经
    /// `mcp_latency_query` 读出）；不另留 getter——没有调用方的读数口就是死码。
    pub fn to_json(&self) -> Value {
        json!({
            "window": self.window,
            "maxKeys": MAX_KEYS,
            "overflowKeys": self.overflow_keys,
            "keys": self.stats(),
        })
    }
}

/// 最近秩分位数（nearest-rank）：`ceil(p/100 * n)` 排序后取值；空集回 0。
/// 纯函数，单测直接喂样本数组。
pub fn percentile(samples: &VecDeque<u64>, p: u64) -> u64 {
    if samples.is_empty() {
        return 0;
    }
    let mut sorted: Vec<u64> = samples.iter().copied().collect();
    sorted.sort_unstable();
    let n = sorted.len() as u64;
    let rank = ((p * n) + 99) / 100; // ceil(p*n/100)，p 取 1..=100
    let idx = rank.clamp(1, n) as usize - 1;
    sorted[idx]
}
