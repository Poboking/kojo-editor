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

function insideAny(target, roots) {
  const t = norm(target).toLowerCase();
  return roots.some((r) => {
    const rl = norm(r).toLowerCase();
    return t === rl || t.startsWith(rl.endsWith(path.sep) ? rl : rl + path.sep);
  });
}

/** HostError：宿主命令的「业务失败」——应答 200 + {ok:false,error}（与 Tauri reject 同消费口径） */
class HostError extends Error {}

/* ------------------------------- 命令实现 ------------------------------- */

/**
 * 帧格式镜像 `packages/app/src/bridge/read-files-frame.ts`（真源在 Rust
 * `read_files_frame`，三份实现以帧格式为唯一真源成对演进）：
 *   [u32 文件数] 每文件 [u32 pathLen][path utf-8][u32 status][i64 mtime][u64 size][u64 dataLen][data]
 */
export function encodeReadFilesFrame(files) {
  const parts = [];
  const head = Buffer.alloc(4);
  head.writeUInt32LE(files.length, 0);
  parts.push(head);
  for (const f of files) {
    const pb = Buffer.from(f.path, 'utf-8');
    const status = f.status === 'ok' ? 0 : f.status === 'not-found' ? 1 : 2;
    const data = f.status === 'ok' ? Buffer.from(f.data ?? []) : Buffer.alloc(0);
    const pl = Buffer.alloc(4);
    pl.writeUInt32LE(pb.length, 0);
    // status 之后的元数据尾（mtime/size/dataLen），拼在 path 后面——帧格式要求
    // [pathLen][path][status][mtime][size][dataLen][data] 顺序，path 紧跟 pathLen
    const tail = Buffer.alloc(4 + 8 + 8 + 8);
    let o = 0;
    tail.writeUInt32LE(status, o); o += 4;
    tail.writeBigInt64LE(BigInt(Math.max(0, Math.round(f.mtimeMs ?? 0))), o); o += 8;
    tail.writeBigUInt64LE(BigInt(Math.max(0, f.size ?? 0)), o); o += 8;
    tail.writeBigUInt64LE(BigInt(data.length), o);
    parts.push(pl, pb, tail, data);
  }
  return Buffer.concat(parts);
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

async function walkFiles(root, out, depthBudget) {
  let dirents;
  try {
    dirents = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of dirents) {
    if (d.name === '.kojo-debug' || d.name === 'node_modules' || d.name === '.git') continue;
    const full = path.join(root, d.name);
    if (d.isDirectory()) {
      if (depthBudget > 0) await walkFiles(full, out, depthBudget - 1);
    } else if (d.isFile()) {
      out.push(full);
    }
  }
}

function decodeForSearch(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buf.subarray(2));
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3));
  }
  return new TextDecoder('utf-8').decode(buf);
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `search_text` 的 Node 镜像（口径对齐 `bridge/search.ts` 的 SearchResult）：
 * 列 UTF-16 code unit 与 Monaco 同轴；命中行超长以命中为中心开窗（省略号含在串里）。
 */
async function searchText(state, request) {
  const started = Date.now();
  const opts = request?.options ?? {};
  const roots = Array.isArray(request?.roots) ? request.roots.map(norm) : [];
  const query = String(request?.query ?? '');
  if (query === '') throw new HostError('检索词为空');
  const extensions = (opts.extensions ?? []).map((e) => String(e).toLowerCase().replace(/^\./, ''));
  let matcher;
  if (opts.isRegex) {
    try {
      matcher = new RegExp(query, opts.caseSensitive ? '' : 'i');
    } catch (err) {
      throw new HostError(`正则不合法：${err?.message ?? String(err)}`);
    }
  } else {
    const esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    matcher = new RegExp(opts.wholeWord ? `(?<!\\w)${esc}(?!\\w)` : esc, opts.caseSensitive ? '' : 'i');
  }
  const maxResults = Math.max(1, Number(opts.maxResults ?? 2000));
  const maxPerFile = 200;
  const files = [];
  let totalMatches = 0;
  let truncated = false;
  const skipped = { binary: 0, tooLarge: 0, unreadable: 0, filtered: 0 };
  let filesScanned = 0;
  const cancelled = () => state.cancelledSearches.has(Number(request.searchId));

  for (const root of roots) {
    const list = [];
    await walkFiles(root, list, 12);
    for (const file of list) {
      if (cancelled()) return finalize(true);
      if (extensions.length > 0) {
        const ext = path.extname(file).slice(1).toLowerCase();
        if (!extensions.includes(ext)) {
          skipped.filtered += 1;
          continue;
        }
      }
      filesScanned += 1;
      if (filesScanned % 200 === 0) await sleep(0); // 让 cancel_search 有机会落进来
      let buf;
      try {
        buf = await fs.readFile(file);
      } catch {
        skipped.unreadable += 1;
        continue;
      }
      if (buf.length > SEARCH_MAX_FILE_BYTES) {
        skipped.tooLarge += 1;
        continue;
      }
      if (looksBinary(buf)) {
        skipped.binary += 1;
        continue;
      }
      const text = decodeForSearch(buf);
      const lines = text.split(/\r\n|\r|\n/);
      const matches = [];
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        matcher.lastIndex = 0;
        const m = matcher.exec(line);
        if (!m) continue;
        if (matches.length >= maxPerFile || totalMatches >= maxResults) {
          truncated = true;
          break;
        }
        const start = m.index;
        const end = start + Math.max(1, m[0].length);
        // 超长行开窗：以命中为中心 ±80 字符
        let preview = line;
        let s0 = start;
        if (line.length > 200) {
          const winStart = Math.max(0, start - 80);
          const winEnd = Math.min(line.length, end + 80);
          preview = `${winStart > 0 ? '…' : ''}${line.slice(winStart, winEnd)}${winEnd < line.length ? '…' : ''}`;
          s0 = start - winStart + (winStart > 0 ? 1 : 0);
        }
        matches.push({
          line: li + 1,
          column: start + 1,
          preview,
          start: s0,
          end: s0 + (end - start),
        });
        totalMatches += 1;
        if (!opts.isRegex && !matcher.global) {
          // 每行只取首个命中（与宿主「逐行首中」口径一致够用；正则带 g 时逐行也只取首中）
        }
      }
      if (matches.length > 0) files.push({ path: file, matches });
      if (totalMatches >= maxResults) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }
  return finalize(false);

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
  'choose_workspace_root', 'clear_write_domain', 'copy_file', 'encode_string', 'ensure_dir',
  'export_file', 'list_dir', 'market_device_token', 'market_download', 'market_extract',
  'market_fetch_text', 'market_publish', 'open_url_external', 'path_exists', 'read_file_bytes_raw',
  'read_files_raw', 'register_write_domain', 'remove_dir', 'remove_file', 'rename_path',
  'search_text', 'show_in_folder', 'start_watch', 'stat_file', 'stat_files', 'stop_watch',
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

  const readRoots = () => [...state.readonlyRoots, ...state.workspaceRoots];
  const writeRoots = () => [sandbox, appdata, ...state.workspaceRoots, ...state.writeDomain];

  function admitRead(p) {
    if (!insideAny(p, readRoots())) {
      throw new HostError(
        `调试宿读域外路径被拒：${p}（可读根：${readRoots().join('；')}；要加根用 --readonly 或先 choose_workspace_root）`,
      );
    }
  }
  function admitWrite(p) {
    if (!insideAny(p, writeRoots())) {
      throw new HostError(
        `调试宿写域外路径被拒：${p}（可写根：${writeRoots().join('；')}；项目要可写需走注册写域 / 常驻工作区根）`,
      );
    }
  }

  async function walkDir(root, opts) {
    const out = [];
    const maxDepth = Number.isFinite(opts?.maxDepth) ? opts.maxDepth : Infinity;
    const includeFiles = opts?.includeFiles !== false;
    const includeDirs = opts?.includeDirs !== false;
    const withMetadata = opts?.withMetadata === true;
    const rec = async (dir, depth) => {
      let dirents;
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // 路径不存在 ⇒ 空数组（契约口径）
      }
      for (const d of dirents) {
        const full = path.join(dir, d.name);
        const meta = {};
        if (withMetadata && d.isFile()) {
          try {
            const st = await fs.stat(full);
            meta.mtimeMs = Math.round(st.mtimeMs);
            meta.size = st.size;
          } catch {
            /* 取不到就不填（契约：不许拿 0 兜底） */
          }
        }
        if (d.isDirectory() && includeDirs) out.push({ name: d.name, path: full, isDirectory: true });
        if (d.isFile() && includeFiles) out.push({ name: d.name, path: full, isDirectory: false, ...meta });
        if (d.isDirectory() && depth < maxDepth) await rec(full, depth + 1);
      }
    };
    await rec(root, 0);
    return out;
  }

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
    choose_workspace_root: async () => {
      const chosen = state.policy.chooseDir;
      if (!chosen) return null;
      const root = norm(chosen);
      if (!state.workspaceRoots.some((r) => norm(r).toLowerCase() === root.toLowerCase())) {
        state.workspaceRoots.push(root);
        log(`[debug-host] 常驻工作区根已登记：${root}`);
      }
      return root;
    },
    clear_write_domain: async () => {
      state.writeDomain = [];
    },
    copy_file: async (args) => {
      const from = norm(args?.from);
      const to = norm(args?.to);
      admitRead(from);
      admitWrite(to);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
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
      const dest = path.join(sandbox, 'exports', name);
      await fs.writeFile(dest, Buffer.from(String(args?.data ?? ''), 'base64'));
      state.recordedShellCalls.push({ cmd: 'export_file', path: dest });
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
        return { __b64: (await fs.readFile(p)).toString('base64') };
      } catch (err) {
        if (err?.code === 'ENOENT') throw new HostError(`文件不存在：${p}`);
        throw new HostError(`读文件失败：${p}（${err?.message ?? String(err)}）`);
      }
    },
    read_files_raw: async (args) => {
      const paths = Array.isArray(args?.paths) ? args.paths.map(norm) : [];
      const files = [];
      for (const p of paths) {
        try {
          admitRead(p);
          const st = await fs.stat(p);
          const data = await fs.readFile(p);
          files.push({ path: p, status: 'ok', mtimeMs: Math.round(st.mtimeMs), size: st.size, data });
        } catch (err) {
          if (err instanceof HostError) throw err; // 域外是整批拒绝，不是逐文件失败
          files.push({
            path: p,
            status: err?.code === 'ENOENT' ? 'not-found' : 'read-error',
            mtimeMs: null,
            size: null,
            data: Buffer.alloc(0),
          });
        }
      }
      return { __b64: encodeReadFilesFrame(files).toString('base64') };
    },
    register_write_domain: async (args) => {
      const root = norm(args?.root);
      admitRead(root); // 注册的根至少要在读域内（--readonly / sandbox / 常驻根）
      if (!state.writeDomain.some((r) => norm(r).toLowerCase() === root.toLowerCase())) {
        state.writeDomain.push(root);
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
    search_text: async (args) => await searchText(state, args?.request),
    show_in_folder: async (args) => {
      state.recordedShellCalls.push({ cmd: 'show_in_folder', path: String(args?.path ?? '') });
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
      const out = [];
      for (const p of paths) {
        try {
          admitRead(p);
          const st = await fs.stat(p);
          out.push({ path: p, exists: true, mtimeMs: Math.round(st.mtimeMs), size: st.size });
        } catch (err) {
          if (err instanceof HostError) throw err;
          out.push({ path: p, exists: false, mtimeMs: null, size: null });
        }
      }
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
      const tmp = path.join(path.dirname(p), `.kojo-debug-tmp-${process.pid}-${Date.now()}`);
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
              if (!state.readonlyRoots.includes(root)) state.readonlyRoots.push(root);
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
          const handler = commands[req2?.cmd];
          if (!handler) {
            json(res, 200, { ok: false, error: `调试宿没有实现命令：${String(req2?.cmd)}` });
            return;
          }
          try {
            const value = await handler(req2?.args ?? {});
            json(res, 200, { ok: true, value: value === undefined ? null : value });
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
