#!/usr/bin/env node
// eslint-disable-next-line @typescript-eslint/no-explicit-any
/**
 * Web 调试宿（2026-10-24 调试模式批）：一个把 **Rust 宿主命令面**（`src-tauri/src/lib.rs`
 * 的 `generate_handler!` 全集）镜像到 Node 的本机 HTTP 服务。页面侧由
 * `packages/app/src/debug/web-host-transport.ts` 把 `?kojo-debug=1` 的浏览器请求转发过来，
 * 于是编辑器可以在纯浏览器里跑完整功能——多 agent 无桌面壳也能做体感 / UI / 功能验证。
 *
 * 协议（刻意零依赖，只用 node 内置）：
 * - `POST /invoke`  `{cmd, args}` → `{ok:true, value}` | `{ok:false, error}`
 *   二进制应答（`read_file_bytes_raw` / `read_files_raw`）装 `{__b64}` 信封，页面侧还原。
 * - `GET /events`   SSE：具名事件 `kojo:fs-changed` / `kojo:fs-watch-error` / `kojo:debug-notice`
 *   （事件名字面与桌面壳 Tauri 事件同对——`tauri-bridge.watchDirs` 的浏览器腿直接消费）。
 * - `GET /health` / `GET /config`、`POST /policy`（运行时改对话框自动应答，CLI `open-project` 用）。
 *
 * 安全面（与产品铁律同向，**不是**产品执法的替代——那层在 Rust 宿与内核 io）：
 * - 只绑 127.0.0.1；
 * - **读域**＝sandbox ∪ appData ∪ 各 `--readonly` 根 ∪ 运行时登记的常驻工作区根；
 * - **写域**＝sandbox ∪ appData ∪ 常驻工作区根 ∪ `register_write_domain` 登记过的根；
 *   域外读 / 写一律显式报错（fail loud），绝不静默;
 * - 对话框命令（choose_* / export_file）是**自动应答**：按 policy 里的路径答，或答 null（取消）。
 *
 * 已知边界（如实说，不静默）：
 * - `market_*` 网络命令显式失败（市场链路的安全闸在 Rust 侧，调试宿不复制那套白名单）；
 * - `encode_string` 支持 utf-8 / utf-8-bom / utf-16le / utf-16be；**shift_jis 编码**（写盘方向）
 *   Node 无原生编码器——显式报错；读取方向不受影响（解码在页面 TextDecoder）。
 *
 * 用法：
 *   node tools/debug-server.mjs [--port 17777] [--sandbox <dir>] [--appdata <dir>]
 *       [--readonly <dir>]... [--choose-dir <path>] [--choose-file <path>] [--quiet]
 * 默认 sandbox / appdata 落在仓库 `.kojo-debug/` 下（已 gitignore）。
 * 退出码：0 正常收尾；1 参数错；2 端口被占。
 */
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as fss from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { debugHome } from './debug-lib.mjs';

const DEFAULT_PORT = Number(process.env.KOJO_DEBUG_PORT ?? 17777);

/* ------------------------------- 路径准入 ------------------------------- */

/** 规范化到绝对路径（不追符号链接——调试宿不做影子判定，够了） */
function norm(p) {
  return path.resolve(String(p ?? ''));
}

/** 准入比较用的形态：Windows 大小写不敏感，统一小写归一（只在命中判定用，不回写路径） */
function normLower(p) {
  return norm(p).toLowerCase();
}

/**
 * 命中判定吃**预归一化的根**（2026-10-26 性能批）：旧实现每次调用都重新
 * `norm + toLowerCase` 全部根并新建数组——批量 stat / 批读两千条路径时这一步
 * 比 stat 本身还贵（实测 stat_files 2000 条 CPU 1.7s）。根表只在域变更时重建。
 */
function insideLower(targetLower, rootsLower) {
  for (const root of rootsLower) {
    if (targetLower === root) return true;
    const base = root.endsWith(path.sep) ? root : root + path.sep;
    if (targetLower.startsWith(base)) return true;
  }
  return false;
}

/** HostError：宿主命令的「业务失败」——应答 200 + {ok:false,error}（与 Tauri reject 同消费口径） */
class HostError extends Error {}

/* ------------------------------- 命令实现 ------------------------------- */

/**
 * 帧格式镜像 `packages/app/src/bridge/read-files-frame.ts`（真源在 Rust
 * `read_files_frame`，三份实现以帧格式为唯一真源成对演进）：
 *   [u32 文件数] 每文件 [u32 pathLen][path utf-8][u32 status][i64 mtime][u64 size][u64 dataLen][data]
 */
const EMPTY_BUFFER = Buffer.alloc(0);

/**
 * 帧切片（性能批）：元数据小块 + **直接引用文件数据缓冲**（不再逐文件 Buffer.from 拷贝）。
 * 两条消费路径：JSON 信封 ⇒ `encodeReadFilesFrame` 一次分配拼成整帧再 base64；
 * 二进制直传 ⇒ 直接逐切片 `res.write`（省掉整帧拼接与 base64 两道大拷贝）。
 */
function readFilesFrameChunks(files) {
  const parts = [];
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32LE(files.length, 0);
  parts.push(head);
  for (const f of files) {
    const pb = Buffer.from(f.path, 'utf-8');
    const status = f.status === 'ok' ? 0 : f.status === 'not-found' ? 1 : 2;
    const data =
      f.status === 'ok'
        ? Buffer.isBuffer(f.data)
          ? f.data
          : Buffer.from(f.data ?? [])
        : EMPTY_BUFFER;
    const pl = Buffer.allocUnsafe(4);
    pl.writeUInt32LE(pb.length, 0);
    // 帧格式：[pathLen][path][status][mtime][size][dataLen][data]
    const tail = Buffer.allocUnsafe(28);
    tail.writeUInt32LE(status, 0);
    tail.writeBigInt64LE(BigInt(Math.max(0, Math.round(f.mtimeMs ?? 0))), 4);
    tail.writeBigUInt64LE(BigInt(Math.max(0, f.size ?? 0)), 12);
    tail.writeBigUInt64LE(BigInt(data.length), 20);
    parts.push(pl, pb, tail, data);
  }
  return parts;
}

export function encodeReadFilesFrame(files) {
  const chunks = readFilesFrameChunks(files);
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const c of chunks) {
    c.copy(out, offset);
    offset += c.length;
  }
  return out;
}

/** utf-16le / utf-16be 编码器（带 BOM 的形态与 Rust encoding_rs 对齐：BOM 只在「编码档」为 bom 档时写） */
function encodeUtf16(text, be) {
  const buf = Buffer.alloc(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (be) { buf.writeUInt16BE(c, i * 2); } else { buf.writeUInt16LE(c, i * 2); }
  }
  return buf;
}

const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
const utf16leBom = Buffer.from([0xff, 0xfe]);
const utf16beBom = Buffer.from([0xfe, 0xff]);

async function encodeString(text, encoding) {
  switch (encoding) {
    case 'utf-8':
      return Buffer.from(text, 'utf-8');
    case 'utf-8-bom':
      return Buffer.concat([utf8Bom, Buffer.from(text, 'utf-8')]);
    case 'utf-16le':
      return Buffer.concat([utf16leBom, encodeUtf16(text, false)]);
    case 'utf-16be':
      return Buffer.concat([utf16beBom, encodeUtf16(text, true)]);
    case 'shift_jis':
      // Node 只带 shift_jis 解码器（TextDecoder），没有编码器；如实报错不静默
      throw new HostError(
        '调试宿不支持 shift_jis 编码写盘（Node 无原生编码器）；utf-8 / utf-8-bom / utf-16le / utf-16be 可用',
      );
    default:
      throw new HostError(`调试宿不认识的编码：${String(encoding)}`);
  }
}

/* ------------------------------- 文件监视 ------------------------------- */

function createWatchHub(log) {
  const watchers = new Map(); // root -> fs.FSWatcher
  const sseClients = new Set(); // res
  return {
    sseClients,
    send(event, payload) {
      const frame = `event: ${event}\ndata: ${JSON.stringify(payload ?? null)}\n\n`;
      for (const res of sseClients) {
        try {
          res.write(frame);
        } catch {
          sseClients.delete(res);
        }
      }
    },
    async start(paths) {
      const watched = [];
      const failed = [];
      for (const raw of paths) {
        const root = norm(raw);
        if (watchers.has(root)) {
          watched.push(root);
          continue;
        }
        try {
          await fs.access(root);
          // recursive: true 在 Windows/macOS 原生支持；Linux 需 ≥20.13（不支持则退非递归逐层——够用）
          const w = fss.watch(root, { recursive: true }, (event, filename) => {
            const rel = filename ? String(filename) : '';
            const full = rel ? path.join(root, rel) : root;
            // rename 事件成对（旧名 unlink / 新名 add）；change 保持 change。去抖交给内核。
            this.send('kojo:fs-changed', { kind: event === 'rename' ? 'add' : 'change', path: full });
            fss.stat(full, (err, st) => {
              if (!err && st.isFile()) return;
              // rename 里「旧名」那半是消失：补一条 unlink（add 与 unlink 同拍到达由内核判级）
              this.send('kojo:fs-changed', { kind: 'unlink', path: full });
            });
          });
          watchers.set(root, w);
          watched.push(root);
        } catch (err) {
          failed.push({ path: root, error: `调试宿监视失败：${err?.message ?? String(err)}` });
        }
      }
      return { watched, failed };
    },
    stopAll() {
      for (const w of watchers.values()) w.close();
      watchers.clear();
    },
  };
}

/* ------------------------------- 全文检索 ------------------------------- */

const SEARCH_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** 无换行的巨型行不许把「当前行缓冲」撑爆——内存上限 O(最长行) 的护栏 */
const SEARCH_MAX_LINE_CHARS = 4 * 1024 * 1024;
/** 每批并行扫描的文件数（批内并发、批间按 readdir 序收口 ⇒ 上限/取消语义可预测） */
const SEARCH_CONCURRENCY = Math.max(1, Number(process.env.KOJO_DEBUG_SEARCH_CONCURRENCY ?? 8) || 8);
/** 目录遍历并发（readdir / stat 共用；Windows 上过高反而被 Defender 拖慢） */
const WALK_CONCURRENCY = Math.max(1, Number(process.env.KOJO_DEBUG_WALK_CONCURRENCY ?? 24) || 24);

/**
 * 有界限流器：把任意异步任务压到并发上限内；返回的 Promise 按调用顺序各自解析。
 * 目录树并行遍历、批量 stat、walk_dir 元数据都复用它（递归不会把并发乘成 limit^depth）。
 */
function createLimiter(limit) {
  let active = 0;
  let head = 0;
  const queue = [];
  const pump = () => {
    while (active < limit && head < queue.length) {
      const job = queue[head++];
      active += 1;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
    // 已消费前缀攒多了一次性清掉（shift 每项 O(n)，两千条 stat 会白搬两百万次）
    if (head > 512 && head * 2 > queue.length) {
      queue.splice(0, head);
      head = 0;
    }
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
}

/**
 * 并行 + **顺序确定**的目录遍历：每个目录项按 readdir 序生成「文件串 / 子目录 Promise」，
 * 子目录递归立即入队（限流器压并发），展开时按原序 flatten——结果与旧串行 walkFiles
 * 逐位一致（上限截断的落点因此可复现）。
 */
async function walkFiles(root, depthBudget, limit) {
  const walk = async (dir, depth) => {
    let dirents;
    try {
      dirents = await limit(() => fs.readdir(dir, { withFileTypes: true }));
    } catch {
      return [];
    }
    const parts = [];
    for (const d of dirents) {
      if (d.name === '.kojo-debug' || d.name === 'node_modules' || d.name === '.git') continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (depth > 0) parts.push(walk(full, depth - 1));
      } else if (d.isFile()) {
        parts.push(full);
      }
    }
    const out = [];
    for (const part of parts) {
      if (typeof part === 'string') {
        out.push(part);
      } else {
        const sub = await part;
        for (const f of sub) out.push(f);
      }
    }
    return out;
  };
  return walk(root, depthBudget);
}

/** 首 8KB 探 NUL（二进制判据；原生 Buffer 搜索，不再逐字节 JS 循环） */
function hasNul(buf) {
  const n = Math.min(buf.length, 8192);
  return n > 0 && buf.subarray(0, n).indexOf(0) !== -1;
}

/** BOM → 解码器（utf-8 / utf-16le / utf-16be；BOM 由解码器自行剥离） */
function decoderFor(head) {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return new TextDecoder('utf-16le');
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return new TextDecoder('utf-16be');
  return new TextDecoder('utf-8');
}

/**
 * 一次已命中的 exec 结果 → SearchResult 的 match 形态（列 UTF-16 码元 +1，与 Monaco 同轴；
 * 超 200 字符以命中为中心开窗，省略号含在串里）。
 */
function makeMatch(line, m) {
  const start = m.index;
  const end = start + Math.max(1, m[0].length);
  let preview = line;
  let s0 = start;
  if (line.length > 200) {
    const winStart = Math.max(0, start - 80);
    const winEnd = Math.min(line.length, end + 80);
    preview = `${winStart > 0 ? '…' : ''}${line.slice(winStart, winEnd)}${winEnd < line.length ? '…' : ''}`;
    s0 = start - winStart + (winStart > 0 ? 1 : 0);
  }
  return { column: start + 1, preview, start: s0, end: s0 + (end - start) };
}

/**
 * 整串按行扫描（正则查询路径）：逐行找**全部**不重叠命中（口径对齐 Rust
 * `scan_text` 的 `find_iter(line)`——同一行多处命中都要列出）。
 */
function scanWholeText(text, matcher, maxPerFile) {
  const entries = [];
  let overflow = false;
  let lineNo = 0;
  const take = (line, no) => {
    matcher.lastIndex = 0;
    for (;;) {
      const m = matcher.exec(line);
      if (!m) return false;
      if (entries.length >= maxPerFile) {
        overflow = true;
        return true;
      }
      entries.push({ line: no, ...makeMatch(line, m) });
      if (m[0].length === 0) {
        matcher.lastIndex += 1;
        if (matcher.lastIndex > line.length) return false;
      }
    }
  };
  const len = text.length;
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl < 0) break;
    let end = nl;
    if (end > start && text.charCodeAt(end - 1) === 13) end -= 1;
    lineNo += 1;
    if (take(end > start ? text.slice(start, end) : '', lineNo)) return { entries, overflow };
    start = nl + 1;
  }
  if (start < len) {
    let end = len;
    if (end > start && text.charCodeAt(end - 1) === 13) end -= 1;
    lineNo += 1;
    take(end > start ? text.slice(start, end) : '', lineNo);
  }
  return { entries, overflow };
}

/**
 * 普通文本查询的**整串原生扫描**（性能批主力）：非正则、查询不含换行时，
 * 用 `indexOf`（大小写敏感）或全局正则（大小写不敏感 / 整词）在整串上一次走完，
 * 只在命中处回推行号并切预览窗。旧实现每条行一次 `RegExp.exec` + 两次 slice，
 * 300k 行语料上单这一项就是数百毫秒。
 *
 * 语义与逐行扫描一致：命中不跨行（查询本身不含换行）、非重叠、列号 UTF-16 码元 +1、
 * 预览窗口 160 字符 + 省略号；命中上限（maxPerFile）以「再命中一次即 overflow」判。
 */
function scanTextFast(text, fast, maxPerFile) {
  const entries = [];
  let overflow = false;
  let lineNo = 1;
  let lineStart = 0;
  const take = (idx, matchLen) => {
    if (entries.length >= maxPerFile) {
      overflow = true;
      return false;
    }
    // 行号/行首单调前进：匹配索引递增，整体只扫一遍换行
    for (;;) {
      const nl = text.indexOf('\n', lineStart);
      if (nl === -1 || nl >= idx) break;
      lineNo += 1;
      lineStart = nl + 1;
    }
    const start = idx - lineStart;
    const end = start + Math.max(1, matchLen);
    let lineEnd = text.indexOf('\n', idx);
    if (lineEnd === -1) lineEnd = text.length;
    if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13) lineEnd -= 1;
    const lineLen = lineEnd - lineStart;
    let preview;
    let s0 = start;
    if (lineLen <= 200) {
      preview = text.slice(lineStart, lineEnd);
    } else {
      const winStart = Math.max(0, start - 80);
      const winEnd = Math.min(lineLen, end + 80);
      preview = `${winStart > 0 ? '…' : ''}${text.slice(lineStart + winStart, lineStart + winEnd)}${
        winEnd < lineLen ? '…' : ''
      }`;
      s0 = start - winStart + (winStart > 0 ? 1 : 0);
    }
    entries.push({ line: lineNo, column: start + 1, preview, start: s0, end: s0 + (end - start) });
    return true;
  };
  if (fast.kind === 'indexOf') {
    const needle = fast.needle;
    let from = 0;
    for (;;) {
      const idx = text.indexOf(needle, from);
      if (idx === -1) break;
      if (!take(idx, needle.length)) break;
      from = idx + needle.length;
    }
  } else {
    const re = fast.re;
    re.lastIndex = 0;
    for (;;) {
      const m = re.exec(text);
      if (!m) break;
      if (!take(m.index, m[0].length)) break;
      if (m[0].length === 0) re.lastIndex += 1;
    }
  }
  return { entries, overflow };
}

/** 4MiB 以上才扫一遍行界（旧流式实现的「无换行巨行」护栏，整读形态下同样保留） */
function hasOverlongLine(text) {
  if (text.length <= SEARCH_MAX_LINE_CHARS) return false;
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) return text.length - start > SEARCH_MAX_LINE_CHARS;
    if (nl - start > SEARCH_MAX_LINE_CHARS) return true;
    start = nl + 1;
  }
}

/**
 * 单文件扫描入口（2026-10-26 性能批）：open + fstat + readFile 一路句柄（少一次路径查找），
 * 超 8MiB 直接 tooLarge 不读；≤8MiB 整读整解。并发由批调度封顶（默认 8 ⇒ 峰值 ≤64MiB），
 * 不再需要 2026-10-25 的流式扫描（那轮是为无上限并发/整树行数组的 OOM 兜底）。
 * status 口径不变：ok / binary / too-large / unreadable。
 */
async function scanFile(file, matcher, maxPerFile, fast) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
  } catch {
    return { status: 'unreadable', entries: [], overflow: false };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { status: 'unreadable', entries: [], overflow: false };
    if (st.size > SEARCH_MAX_FILE_BYTES) return { status: 'too-large', entries: [], overflow: false };
    const buf = await fh.readFile();
    if (buf.length > SEARCH_MAX_FILE_BYTES) return { status: 'too-large', entries: [], overflow: false };
    if (hasNul(buf)) return { status: 'binary', entries: [], overflow: false };
    const text = decoderFor(buf).decode(buf);
    const r = fast ? scanTextFast(text, fast, maxPerFile) : scanWholeText(text, matcher, maxPerFile);
    if (hasOverlongLine(text)) {
      return { status: 'too-large', entries: r.entries, overflow: r.overflow };
    }
    return { status: 'ok', entries: r.entries, overflow: r.overflow };
  } catch {
    return { status: 'unreadable', entries: [], overflow: false };
  } finally {
    await fh.close().catch(() => {});
  }
}

/** 小并发池（保持逐项顺序；fn 抛错 ⇒ 整批 fail-loud，与逐个 await 同语义） */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** 单次批量读的帧体上限：JSON 信封 + base64 会再放大 ~1.33×，超限 fail-loud 保护两端 */
const READ_BATCH_MAX_BYTES = 32 * 1024 * 1024;

/* ---------------- 排除模式（WS-10）的 Node 镜像腿 ----------------
 *
 * 判据与 Rust `compile_exclude_rules` / `is_excluded` 逐字同向：`**` 跨目录、`*` / `?`
 * 不跨目录、前导 `!` 取反、**按给出顺序求值最后一条命中赢**、不含 `/` 的模式按文件名
 * 匹配任意深度、两侧分隔符都先归一成 `/`、大小写**敏感**。
 * 前端镜像在 `ui/search-query.parseExcludePatterns`（解析那半），这里是匹配那半。
 *
 * 为什么镜像必须自己认这一条：调试宿是 agent 验 UI 的唯一通道。宿侧不认识
 * `excludeGlobs` 的话，「排除」框在浏览器里永远是"打了没反应"——那是一条假读数，
 * 比没有这个功能更坏（作者会据此判定功能没做）。
 *
 * 已知不对称（**先记下来，不在本批顺手改**）：include 侧的 `globs`（P2-15）镜像至今
 * 未实现，Rust 侧才有。排除与 include 是两条独立维度，缺 include 不影响排除的自证。
 */

/** glob → 正则源码（镜像 Rust `glob_to_regex`：星号对加斜杠 = 任意层含 0 层，单星与问号不跨目录） */
function globToRegExpSource(glob) {
  const norm = String(glob).replace(/\\/g, '/');
  let out = '^';
  for (let i = 0; i < norm.length; i += 1) {
    const c = norm[i];
    if (c === '*' && norm[i + 1] === '*') {
      if (norm[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return `${out}$`;
}

/** 排除模式 → 规则序列（镜像 Rust `exclude_regex_source` + `compile_exclude_rules`） */
function compileExcludeRules(patterns) {
  const rules = [];
  for (const raw of Array.isArray(patterns) ? patterns : []) {
    let g = String(raw ?? '').trim().replace(/\\/g, '/');
    if (g === '' || g === '!') continue;
    const negated = g.startsWith('!');
    if (negated) g = g.slice(1).trim();
    if (g === '') continue;
    const anchored = g.replace(/^\/+/, '');
    const body = globToRegExpSource(anchored);
    // 不含 `/` 的模式 = 按文件名匹配任意深度（前缀组必须以 `/` 收尾，段边界才不对齐错）
    const source = anchored.includes('/') ? body : `^(?:.*/)?${body.slice(1, -1)}$`;
    try {
      rules.push({ negated, re: new RegExp(source) });
    } catch {
      // 与 Rust 同口径：编译不了的那条忽略并出声，绝不静默当成"没写"
      console.warn(`[debug-host] 排除模式编译失败（该条已忽略）：${raw}`);
    }
  }
  return rules;
}

/** 某条路径是否被排除（按序求值，最后一条命中赢；相对与绝对两种写法都试） */
function isExcludedByRules(rules, rel, full) {
  let excluded = false;
  for (const rule of rules) {
    if (rule.re.test(rel) || rule.re.test(full)) excluded = !rule.negated;
  }
  return excluded;
}

/** 绝对路径 → 相对该根的 `/` 形态（strip 不掉就退回全路径，与 Rust `relative_slash_path` 同兜底） */
function relSlashPath(root, file) {
  const r = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
  const f = String(file).replace(/\\/g, '/');
  const prefix = `${r}/`;
  return f.startsWith(prefix) ? f.slice(prefix.length) : f;
}

/**
 * `search_text` 的 Node 镜像（口径对齐 `bridge/search.ts` 的 SearchResult）：
 * 列 UTF-16 code unit 与 Monaco 同轴；命中行超长以命中为中心开窗（省略号含在串里）。
 * `admitRead` 由宿实例注入（读域闸在 createDebugServer 的闭包里，这里不复制第二份真相）。
 */
async function searchText(state, request, admitRead) {
  const started = Date.now();
  const opts = request?.options ?? {};
  const roots = Array.isArray(request?.roots) ? request.roots.map(norm) : [];
  const query = String(request?.query ?? '');
  if (query === '') throw new HostError('检索词为空');
  for (const root of roots) admitRead(root); // 读域闸补位：旧实现的 walkFiles 绕过了它
  const extensions = (opts.extensions ?? []).map((e) => String(e).toLowerCase().replace(/^\./, ''));
  // 排除模式（WS-10）：DTO → 规则序列（判据与 Rust 同向，见上面「排除模式的 Node 镜像腿」）
  const excludeRules = compileExcludeRules(opts.excludeGlobs ?? []);
  let matcher;
  // 全局标志：逐行扫时同一行的多处命中都要列出（口径对齐 Rust `find_iter(line)`）
  if (opts.isRegex) {
    try {
      matcher = new RegExp(query, opts.caseSensitive ? 'g' : 'gi');
    } catch (err) {
      throw new HostError(`正则不合法：${err?.message ?? String(err)}`);
    }
  } else {
    const esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    matcher = new RegExp(opts.wholeWord ? `(?<!\\w)${esc}(?!\\w)` : esc, opts.caseSensitive ? 'g' : 'gi');
  }
  // 普通文本查询（非正则、不含换行）走整串原生扫描快路径；正则查询保持逐行语义
  // （正则可能跨行，整串搜会改变 `a.*b` 这类查询的命中）。
  let fast = null;
  if (!opts.isRegex && !query.includes('\n') && !query.includes('\r')) {
    if (opts.caseSensitive && !opts.wholeWord) {
      fast = { kind: 'indexOf', needle: query };
    } else {
      const esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      fast = {
        kind: 'regex',
        re: new RegExp(opts.wholeWord ? `(?<!\\w)${esc}(?!\\w)` : esc, opts.caseSensitive ? 'g' : 'gi'),
      };
    }
  }
  const maxResults = Math.max(1, Number(opts.maxResults ?? 2000));
  const maxPerFile = 200;
  const files = [];
  let totalMatches = 0;
  let truncated = false;
  const skipped = { binary: 0, tooLarge: 0, unreadable: 0, filtered: 0, excluded: 0 };
  let filesScanned = 0;
  const searchId = Number(request.searchId);
  const cancelled = () => state.cancelledSearches.has(searchId);
  let wasCancelled = false;

  try {
    // 1) 目录遍历并行（结果保持 readdir 序；多根之间也并行，收口时按 roots 序拼接）
    const walkLimit = createLimiter(WALK_CONCURRENCY);
    const lists = await Promise.all(roots.map((root) => walkFiles(root, 12, walkLimit)));
    const candidates = [];
    for (let li = 0; li < lists.length; li += 1) {
      // 排除判据的基准 = **相对该检索根**的路径（与 Rust `collect_files` 同一条尺子）；
      // 同时拿归一后的全路径再试一遍（作者抄地址栏的绝对写法也要能兑现）。
      const root = roots[li];
      for (const file of lists[li]) {
        if (extensions.length > 0) {
          const ext = path.extname(file).slice(1).toLowerCase();
          if (!extensions.includes(ext)) {
            skipped.filtered += 1;
            continue;
          }
        }
        if (excludeRules.length > 0) {
          const rel = relSlashPath(root, file);
          if (isExcludedByRules(excludeRules, rel, String(file).replace(/\\/g, '/'))) {
            skipped.excluded += 1;
            continue;
          }
        }
        candidates.push(file);
      }
    }

    // 2) 逐批并行扫描：批内并发、批间按 readdir 序收口 ⇒ 截断落点确定、读盘不无限超前。
    //    取消在批界与批内逐文件检查（cancel_search 从另一条 HTTP 请求落进来）。
    outer: for (let start = 0; start < candidates.length; start += SEARCH_CONCURRENCY) {
      if (cancelled()) {
        wasCancelled = true;
        break;
      }
      const slice = candidates.slice(start, start + SEARCH_CONCURRENCY);
      const batch = await Promise.all(
        slice.map(async (file) => {
          if (cancelled()) return null;
          filesScanned += 1;
          return { path: file, ...(await scanFile(file, matcher, maxPerFile, fast)) };
        }),
      );
      for (const r of batch) {
        if (!r) continue;
        if (r.status === 'binary') skipped.binary += 1;
        else if (r.status === 'too-large') skipped.tooLarge += 1;
        else if (r.status === 'unreadable') skipped.unreadable += 1;
        if (r.entries.length === 0) continue;
        if (totalMatches >= maxResults) {
          truncated = true;
          continue;
        }
        const room = maxResults - totalMatches;
        const take = r.entries.length > room ? r.entries.slice(0, room) : r.entries;
        if (r.entries.length > room || r.overflow) truncated = true;
        files.push({ path: r.path, matches: take });
        totalMatches += take.length;
        if (totalMatches >= maxResults) {
          truncated = true;
          break outer;
        }
      }
      if (cancelled()) {
        wasCancelled = true;
        break;
      }
    }
  } finally {
    // 生命周期收口：取消标记用完即清（旧实现只增不减，长会话里泄漏）
    state.cancelledSearches.delete(searchId);
  }
  return finalize(wasCancelled);

  function finalize(wasCancelled) {
    return {
      files,
      totalMatches,
      truncated,
      cancelled: wasCancelled,
      filesScanned,
      skipped,
      elapsedMs: Date.now() - started,
    };
  }
}

/* ------------------------------- 服务本体 ------------------------------- */

export const SUPPORTED_COMMANDS = Object.freeze([
  'app_data_dir', 'append_frontend_log', 'cancel_search', 'choose_directory', 'choose_file',
  'choose_workspace_root', 'clear_write_domain', 'copy_file', 'create_dir_exclusive',
  'create_file_exclusive', 'encode_string', 'ensure_dir',
  'export_file', 'list_dir', 'market_device_token', 'market_download', 'market_extract',
  'market_fetch_text', 'market_publish', 'open_url_external', 'path_exists', 'read_file_bytes_raw',
  'pick_directory', 'pick_save_path', 'read_files_raw', 'register_write_domain', 'remove_dir', 'remove_file', 'rename_path',
  'revoke_workspace_root', 'search_text', 'show_in_folder', 'start_watch', 'stat_file', 'stat_files', 'stop_watch',
  'updater_env_proxy', 'walk_dir', 'workspace_roots', 'write_file_bytes',
]);

/**
 * 建一个调试宿实例（导出供 vitest 直接拉起；CLI 形态只是包了 argv 解析的这一层）。
 *
 * @param options {port?, sandbox, appdata, readonly?: string[], policy?: {chooseDir?, chooseFile?}, log?}
 */
export async function createDebugServer(options) {
  const log = options.log ?? (() => {});
  const sandbox = norm(options.sandbox);
  const appdata = norm(options.appdata);
  await fs.mkdir(path.join(appdata, 'kojo-logs'), { recursive: true });
  await fs.mkdir(path.join(sandbox, 'exports'), { recursive: true });

  const state = {
    readonlyRoots: [...(options.readonly ?? []).map(norm), sandbox, appdata],
    workspaceRoots: [],
    writeDomain: [],
    policy: { chooseDir: options.policy?.chooseDir ?? null, chooseFile: options.policy?.chooseFile ?? null },
    cancelledSearches: new Set(),
    recordedShellCalls: [],
  };
  const hub = createWatchHub(log);

  // 根表缓存（性能批）：readonly / workspace / writeDomain 只在域变更时重建小写归一表；
  // 命中判定每次只归一目标路径一次。错误文案仍用原始大小写根（可读）。
  let readRootsLower = null;
  let writeRootsLower = null;
  const invalidateRoots = () => {
    readRootsLower = null;
    writeRootsLower = null;
  };
  const readRoots = () => {
    readRootsLower ??= [...state.readonlyRoots, ...state.workspaceRoots].map(normLower);
    return readRootsLower;
  };
  const writeRoots = () => {
    writeRootsLower ??= [sandbox, appdata, ...state.workspaceRoots, ...state.writeDomain].map(normLower);
    return writeRootsLower;
  };
  const readRootsDisplay = () => [...state.readonlyRoots, ...state.workspaceRoots];
  const writeRootsDisplay = () => [sandbox, appdata, ...state.workspaceRoots, ...state.writeDomain];

  function admitRead(p) {
    if (!insideLower(normLower(p), readRoots())) {
      throw new HostError(
        `调试宿读域外路径被拒：${p}（可读根：${readRootsDisplay().join('；')}；要加根用 --readonly 或先 choose_workspace_root）`,
      );
    }
  }
  function admitWrite(p) {
    if (!insideLower(normLower(p), writeRoots())) {
      throw new HostError(
        `调试宿写域外路径被拒：${p}（可写根：${writeRootsDisplay().join('；')}；项目要可写需走注册写域 / 常驻工作区根）`,
      );
    }
  }

  async function walkDir(root, opts) {
    // 并行版（2026-10-26 性能批）：readdir / stat 走同一个有界限流器，输出顺序与旧实现
    // 逐项一致（readdir 序：目录项 → 该目录子树 → 下一个兄弟），方便 UI 差分。
    const maxDepth = Number.isFinite(opts?.maxDepth) ? opts.maxDepth : Infinity;
    const includeFiles = opts?.includeFiles !== false;
    const includeDirs = opts?.includeDirs !== false;
    const withMetadata = opts?.withMetadata === true;
    const limit = createLimiter(WALK_CONCURRENCY);
    const rec = async (dir, depth) => {
      let dirents;
      try {
        dirents = await limit(() => fs.readdir(dir, { withFileTypes: true }));
      } catch {
        return []; // 路径不存在 ⇒ 空数组（契约口径）
      }
      const pieces = [];
      for (const d of dirents) {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) {
          if (includeDirs) pieces.push({ name: d.name, path: full, isDirectory: true });
          if (depth < maxDepth) pieces.push(rec(full, depth + 1));
        } else if (d.isFile() && includeFiles) {
          const entry = { name: d.name, path: full, isDirectory: false };
          if (withMetadata) {
            // 先发起 stat（并发），按 readdir 序 await；取不到就不填（契约：不许拿 0 兜底）
            entry.__meta = limit(() => fs.stat(full)).then(
              (st) => ({ mtimeMs: Math.round(st.mtimeMs), size: st.size }),
              () => null,
            );
          }
          pieces.push(entry);
        }
      }
      const out = [];
      for (const piece of pieces) {
        if (typeof piece?.then === 'function') {
          const sub = await piece;
          for (const e of sub) out.push(e);
          continue;
        }
        if (piece.__meta) {
          const meta = await piece.__meta;
          delete piece.__meta;
          if (meta) Object.assign(piece, meta);
        }
        out.push(piece);
      }
      return out;
    };
    return rec(root, 0);
  }

  let tmpWriteSeq = 0;
  const commands = {
    app_data_dir: async () => appdata,
    append_frontend_log: async (args) => {
      const stamp = new Date().toISOString();
      const line = `[${stamp}] [${String(args?.level ?? 'info')}] ${String(args?.message ?? '')}${
        args?.detail ? `\n  ${String(args.detail).split('\n').join('\n  ')}` : ''
      }\n`;
      const file = path.join(appdata, 'kojo-logs', `frontend-${stamp.slice(0, 10)}.log`);
      await fs.appendFile(file, line, 'utf-8');
    },
    cancel_search: async (args) => {
      state.cancelledSearches.add(Number(args?.searchId));
    },
    choose_directory: async () => state.policy.chooseDir,
    choose_file: async () => state.policy.chooseFile,
    choose_workspace_root: async (args) => {
      const chosen = state.policy.chooseDir;
      if (!chosen) return null;
      const root = norm(chosen);
      // 游戏目录防护（与 Rust 同口径）：与任一 forbid 根双向重叠 ⇒ 登记之前就拒
      const forbid = Array.isArray(args?.forbidRoots) ? args.forbidRoots : [];
      for (const f of forbid.map(norm)) {
        if (insideLower(normLower(root), [normLower(f)]) || insideLower(normLower(f), [normLower(root)])) {
          throw new HostError(
            `这个文件夹不能当项目位置：它与当前游戏的目录重叠（${f}）。请另选一个只存你自己作品的文件夹。`,
          );
        }
      }
      if (!state.workspaceRoots.some((r) => norm(r).toLowerCase() === root.toLowerCase())) {
        state.workspaceRoots.push(root);
        invalidateRoots();
        log(`[debug-host] 常驻工作区根已登记：${root}`);
      }
      return root;
    },
    // 目录选择：只选不授权（与 Rust `pick_directory` 同口径）
    pick_directory: async () => (state.policy.chooseDir ? norm(state.policy.chooseDir) : null),
    // 另存为落点选择：只交回路径，**一字节不写、不授予任何许可**（与 Rust `pick_save_path` 同口径；
    // 1028 批——落盘照旧回内核 io 写允许域双闸，页面上的写链路不因本应答放宽）
    pick_save_path: async () => (state.policy.chooseDir ? norm(state.policy.chooseDir) : null),
    revoke_workspace_root: async (args) => {
      const target = normLower(args?.path);
      if (target === '') throw new HostError('要撤销的项目位置不能是空路径。');
      const before = state.workspaceRoots.length;
      state.workspaceRoots = state.workspaceRoots.filter((r) => normLower(r) !== target);
      if (state.workspaceRoots.length === before) {
        throw new HostError(`这个位置不在已授权的项目位置清单里：${norm(args?.path)}（可能已经撤销过）`);
      }
      invalidateRoots();
      log(`[debug-host] 常驻工作区根已撤销：${norm(args?.path)}`);
    },
    clear_write_domain: async () => {
      state.writeDomain = [];
      invalidateRoots();
    },
    copy_file: async (args) => {
      const from = norm(args?.from);
      const to = norm(args?.to);
      admitRead(from);
      admitWrite(to);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
    },
    create_dir_exclusive: async (args) => {
      // 独占建目录（WS-01 的调试宿镜像）：非递归 mkdir，EEXIST ⇒ false（与 Rust create_dir 同口径）
      const p = norm(args?.path);
      admitWrite(p);
      try {
        await fs.mkdir(p);
        return true;
      } catch (err) {
        if (err?.code === 'EEXIST') return false;
        throw err;
      }
    },
    create_file_exclusive: async (args) => {
      // O_CREAT|O_EXCL：判存在与建文件是同一个原子调用，EEXIST ⇒ false（一个字节都不动）
      const p = norm(args?.path);
      admitWrite(p);
      try {
        const handle = await fs.open(p, 'wx');
        await handle.close();
        return true;
      } catch (err) {
        if (err?.code === 'EEXIST') return false;
        throw err;
      }
    },
    encode_string: async (args) => (await encodeString(String(args?.text ?? ''), args?.encoding)).toString('base64'),
    ensure_dir: async (args) => {
      const p = norm(args?.path);
      admitWrite(p);
      await fs.mkdir(p, { recursive: true });
    },
  export_file: async (args) => {
    // 对话框即授权的调试形态：落点固定在 sandbox/exports/<文件名>，返回全路径（界面会显示它）
    const name = path.basename(String(args?.fileName ?? 'export.bin'));
    if (name === '' || name === '.' || name === '..') {
      throw new HostError(`export_file 的文件名不合法：${JSON.stringify(String(args?.fileName ?? ''))}`);
    }
    const dest = path.join(sandbox, 'exports', name);
    await fs.writeFile(dest, Buffer.from(String(args?.data ?? ''), 'base64'));
    state.recordedShellCalls.push({ cmd: 'export_file', path: dest });
    if (state.recordedShellCalls.length > 200) state.recordedShellCalls.splice(0, state.recordedShellCalls.length - 200);
    return dest;
  },
    list_dir: async (args) => {
      const p = norm(args?.path);
      admitRead(p);
      try {
        const dirents = await fs.readdir(p, { withFileTypes: true });
        return dirents.map((d) => ({ name: d.name, path: path.join(p, d.name), isDirectory: d.isDirectory() }));
      } catch {
        return []; // 契约：不存在 ⇒ 空数组
      }
    },
    market_device_token: async () => failMarket('market_device_token'),
    market_download: async () => failMarket('market_download'),
    market_extract: async () => failMarket('market_extract'),
    market_fetch_text: async () => failMarket('market_fetch_text'),
    market_publish: async () => failMarket('market_publish'),
    open_url_external: async (args) => {
      state.recordedShellCalls.push({ cmd: 'open_url_external', url: String(args?.url ?? '') });
      if (state.recordedShellCalls.length > 200) state.recordedShellCalls.splice(0, state.recordedShellCalls.length - 200);
    },
    path_exists: async (args) => {
      const p = norm(args?.path);
      admitRead(p);
      try {
        await fs.access(p);
        return true;
      } catch {
        return false;
      }
    },
    read_file_bytes_raw: async (args) => {
      const p = norm(args?.path);
      admitRead(p);
      try {
        // 返回 Buffer：JSON 应答由响应层装 {__b64} 信封，二进制直传（?binary=1）原样回字节
        return await fs.readFile(p);
      } catch (err) {
        if (err?.code === 'ENOENT') throw new HostError(`文件不存在：${p}`);
        throw new HostError(`读文件失败：${p}（${err?.message ?? String(err)}）`);
      }
    },
    read_files_raw: async (args) => {
      const paths = Array.isArray(args?.paths) ? args.paths.map(norm) : [];
      // 并发 16 + open/fstat/read 一趟句柄（少一次路径查找）：批量打开项目时是单次最大读盘口
      const files = await mapPool(paths, 16, async (p) => {
        try {
          admitRead(p);
          const fh = await fs.open(p, 'r');
          try {
            const st = await fh.stat();
            if (!st.isFile()) {
              const err = new Error('不是普通文件');
              err.code = 'EISDIR';
              throw err;
            }
            const data = await fh.readFile();
            return { path: p, status: 'ok', mtimeMs: Math.round(st.mtimeMs), size: st.size, data };
          } finally {
            await fh.close().catch(() => {});
          }
        } catch (err) {
          if (err instanceof HostError) throw err; // 域外是整批拒绝，不是逐文件失败
          return {
            path: p,
            status: err?.code === 'ENOENT' ? 'not-found' : 'read-error',
            mtimeMs: null,
            size: null,
            data: EMPTY_BUFFER,
          };
        }
      });
      const total = files.reduce((acc, f) => acc + (f.data?.length ?? 0), 0);
      if (total > READ_BATCH_MAX_BYTES) {
        throw new HostError(
          `单次批量读 ${(total / 1048576).toFixed(1)} MiB 超上限 32 MiB（base64 信封会再放大）——拆小批`,
        );
      }
      // 返回帧 Buffer：JSON 应答装信封；二进制直传原样送回（省 base64 1.33× 与页面 atob）
      return encodeReadFilesFrame(files);
    },
    register_write_domain: async (args) => {
      const root = norm(args?.root);
      admitRead(root); // 注册的根至少要在读域内（--readonly / sandbox / 常驻根）
      if (!state.writeDomain.some((r) => norm(r).toLowerCase() === root.toLowerCase())) {
        state.writeDomain.push(root);
        invalidateRoots();
      }
    },
    remove_dir: async (args) => {
      const p = norm(args?.path);
      admitWrite(p);
      await fs.rm(p, { recursive: true, force: true }); // 不存在幂等成功（契约）
    },
    remove_file: async (args) => {
      const p = norm(args?.path);
      admitWrite(p);
      await fs.rm(p, { force: true });
    },
    rename_path: async (args) => {
      const from = norm(args?.from);
      const to = norm(args?.to);
      admitRead(from);
      admitWrite(to);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
    },
    search_text: async (args) => await searchText(state, args?.request, admitRead),
    show_in_folder: async (args) => {
      state.recordedShellCalls.push({ cmd: 'show_in_folder', path: String(args?.path ?? '') });
      if (state.recordedShellCalls.length > 200) state.recordedShellCalls.splice(0, state.recordedShellCalls.length - 200);
    },
    start_watch: async (args) => {
      const paths = (Array.isArray(args?.paths) ? args.paths : []).map(norm);
      for (const p of paths) admitRead(p);
      return await hub.start(paths);
    },
    stat_file: async (args) => {
      const p = norm(args?.path);
      admitRead(p);
      try {
        const st = await fs.stat(p);
        return { size: st.size, mtimeMs: Math.round(st.mtimeMs), isDirectory: st.isDirectory() };
      } catch {
        return null;
      }
    },
    stat_files: async (args) => {
      const paths = Array.isArray(args?.paths) ? args.paths.map(norm) : [];
      // 并发 16：本机实测 32/64 反而在 Defender 下抖动，16 的 p50 最稳（2026-10-26 性能批）
      const out = await mapPool(paths, 16, async (p) => {
        try {
          admitRead(p);
          const st = await fs.stat(p);
          return { path: p, exists: true, mtimeMs: Math.round(st.mtimeMs), size: st.size };
        } catch (err) {
          if (err instanceof HostError) throw err;
          return { path: p, exists: false, mtimeMs: null, size: null };
        }
      });
      return out;
    },
    stop_watch: async () => {
      hub.stopAll();
    },
    updater_env_proxy: async () => null,
    walk_dir: async (args) => {
      const p = norm(args?.path);
      admitRead(p);
      const opts = args?.opts ?? undefined;
      return await walkDir(p, opts);
    },
    workspace_roots: async () => [...state.workspaceRoots],
    write_file_bytes: async (args) => {
      const p = norm(args?.path);
      admitWrite(p);
      // 原子写镜像（Rust 侧同目录临时文件 + rename）
      await fs.mkdir(path.dirname(p), { recursive: true });
      // 同毫秒并发写同目录也不许撞临时名（批量化调试会并发保存多个文件）
      const tmp = path.join(path.dirname(p), `.kojo-debug-tmp-${process.pid}-${Date.now()}-${tmpWriteSeq++}`);
      await fs.writeFile(tmp, Buffer.from(String(args?.data ?? ''), 'base64'));
      await fs.rename(tmp, p);
    },
  };

  function failMarket(cmd) {
    throw new HostError(
      `调试宿不支持市场网络命令（${cmd}）：市场链路的出网白名单 / 签名 / 暂存闸在桌面壳（Rust）侧，浏览器调试不复制这套执法——市场面板的联网功能请走桌面壳验证`,
    );
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // 二进制直传选入（页面 web-host-transport 对两个二进制命令自动带 ?binary=1）：
    // 应答体原样回帧/字节，不走 base64 + JSON（大文件读的 1.33× 膨胀与页面 atob 全省）。
    // 命令返回非 Buffer / 命令失败 ⇒ 仍按 JSON 应答，旧页面与 CLI 无感。
    const wantBinary = url.searchParams.get('binary') === '1';
    // CORS：页面在 vite 端口（如 1420），跨 origin fetch / EventSource 都要这条
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true, service: 'kojo-debug-host', pid: process.pid });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/config') {
      json(res, 200, {
        ok: true,
        sandbox,
        appdata,
        readonlyRoots: state.readonlyRoots,
        workspaceRoots: state.workspaceRoots,
        writeDomain: state.writeDomain,
        policy: state.policy,
        recordedShellCalls: state.recordedShellCalls.slice(-50),
        supportedCommands: SUPPORTED_COMMANDS,
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/policy') {
      readBody(req)
        .then((body) => {
          const b = JSON.parse(body || '{}');
          if ('chooseDir' in b) state.policy.chooseDir = b.chooseDir === null ? null : norm(b.chooseDir);
          if ('chooseFile' in b) state.policy.chooseFile = b.chooseFile === null ? null : norm(b.chooseFile);
          if (Array.isArray(b.readonly)) {
            for (const r of b.readonly) {
              const root = norm(r);
              if (!state.readonlyRoots.includes(root)) {
                state.readonlyRoots.push(root);
                invalidateRoots();
              }
            }
          }
          json(res, 200, { ok: true, policy: state.policy });
        })
        .catch((err) => json(res, 400, { ok: false, error: String(err?.message ?? err) }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/invoke') {
      readBody(req)
        .then(async (body) => {
          let req2;
          try {
            req2 = JSON.parse(body || '{}');
          } catch {
            json(res, 400, { ok: false, error: '/invoke 应答体不是 JSON' });
            return;
          }
          const handler = Object.prototype.hasOwnProperty.call(commands, req2?.cmd)
            ? commands[req2?.cmd]
            : undefined;
          if (!handler) {
            json(res, 200, { ok: false, error: `调试宿没有实现命令：${String(req2?.cmd)}` });
            return;
          }
          try {
            const value = await handler(req2?.args ?? {});
            if (wantBinary && Buffer.isBuffer(value)) {
              res.writeHead(200, {
                'content-type': 'application/octet-stream',
                'content-length': value.length,
              });
              res.end(value);
              return;
            }
            json(res, 200, {
              ok: true,
              value:
                value === undefined
                  ? null
                  : Buffer.isBuffer(value)
                    ? { __b64: value.toString('base64') }
                    : value,
            });
          } catch (err) {
            const error = err instanceof HostError ? err.message : `${err?.message ?? String(err)}`;
            log(`[debug-host] 命令失败 ${req2?.cmd}: ${error}`);
            json(res, 200, { ok: false, error });
          }
        })
        .catch((err) => json(res, 400, { ok: false, error: String(err?.message ?? err) }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`retry: 2000\n\n`);
      res.write(`event: kojo:debug-notice\ndata: ${JSON.stringify({ hello: 'kojo-debug-host' })}\n\n`);
      hub.sseClients.add(res);
      req.on('close', () => hub.sseClients.delete(res));
      return;
    }
    json(res, 404, { ok: false, error: `调试宿没有这个路由：${req.method} ${url.pathname}` });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // 只绑回环：这是一个本机调试面，不是服务
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });

  return {
    port: server.address().port,
    sandbox,
    appdata,
    async close() {
      hub.stopAll();
      for (const res of hub.sseClients) {
        try {
          res.end();
        } catch {}
      }
      hub.sseClients.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体超限（64 MiB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/* ------------------------------- CLI 形态 ------------------------------- */

function parseArgv(argv) {
  const out = { port: DEFAULT_PORT, readonly: [], _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--sandbox') out.sandbox = argv[++i];
    else if (a === '--appdata') out.appdata = argv[++i];
    else if (a === '--readonly') out.readonly.push(argv[++i]);
    else if (a === '--choose-dir') out.chooseDir = argv[++i];
    else if (a === '--choose-file') out.chooseFile = argv[++i];
    else if (a === '--quiet') out.quiet = true;
    else out._.push(a);
  }
  return out;
}

// `node tools/debug-server.mjs` 直跑（被 import 时不执行——测试走 createDebugServer）
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // 反哺修（2026-10-25）：长会话里 uncaught / unhandled rejection 不许无声带走宿——先落日志
  // 再退（退出码保留给 watchChild 记账；真 OOM 是 Rust/进程级杀，由 CLI 侧 --max-old-space-size 兜）
  process.on('uncaughtException', (err) => {
    console.error(`[debug-host] uncaughtException：${err?.stack ?? err}`);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(`[debug-host] unhandledRejection：${reason?.stack ?? reason}`);
  });
  const args = parseArgv(process.argv.slice(2));
  // 默认落点在系统临时目录（debugHome）：仓库内的运行时残留会弄红对仓库建 watcher 的
  // 别的工具（PITFALLS 189 姊妹坑，2026-10-24 实测）；要放仓库用 --sandbox/--appdata 显式给。
  const base = debugHome();
  const sandbox = norm(args.sandbox ?? path.join(base, 'sandbox'));
  const appdata = norm(args.appdata ?? path.join(base, 'appdata'));
  const log = args.quiet ? () => {} : (s) => console.log(s);
  createDebugServer({
    port: args.port,
    sandbox,
    appdata,
    readonly: args.readonly,
    policy: { chooseDir: args.chooseDir ?? null, chooseFile: args.chooseFile ?? null },
    log,
  })
    .then((server) => {
      log(`[debug-host] 就绪：http://127.0.0.1:${server.port}（sandbox=${sandbox}，appdata=${appdata}）`);
      log(`[debug-host] 页面侧用法：在编辑器地址后加 ?kojo-debug=1（或 ?kojo-debug=${server.port}）`);
      const shutdown = () => {
        server.close().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      if (err?.code === 'EADDRINUSE') {
        console.error(`[debug-host] 端口 ${args.port} 已被占用（换 --port，或先 node tools/debug-cli.mjs stop）`);
        process.exit(2);
      }
      console.error(`[debug-host] 起不来：${err?.stack ?? err}`);
      process.exit(1);
    });
}
