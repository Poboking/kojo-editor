import type { FileChangeKind, FileEncoding, PlatformBridge, WatchCallback, WatchReportCallback } from '@kojo/plugin-api';
import { base64ToBytes, bytesToBase64, invoke, isTauri } from './invoke';
import { decodeReadFilesFrame } from './read-files-frame';

/**
 * PlatformBridge 的 Tauri 实现。
 *
 * Rust 侧同名命令见 src-tauri/src/lib.rs。
 * **写路径**的二进制仍用 base64 跨 IPC（低频、用户触发，形态确定）。
 * **读路径不再**把整份字节送回 Rust 解码——2026-10-13 实机复测（IMPLEMENTATION-LOG §5.90）
 * 量到每读一个文件要三趟 IPC（读字节 + 解码 + stat），真实 app 里读一个 12.5 MB 快照要 4.1 s，
 * 而 node bridge 同一份文件 74 ms ⇒ 解码改在客户端做（见 `decode`）。
 *
 * `watchDirs`（BUG-5，2026-10-13 已接 Rust notify）：本层只做"事件名 ↔ 回调"的接线，
 * 去抖 / 判级 / 广播都在内核（`packages/kernel/src/watcher.ts`）。
 */

/**
 * `FileEncoding` → WHATWG 编码标签。`utf-8-bom` 走 `utf-8`：TextDecoder 默认剥前导 BOM，
 * 与 Rust `encoding_rs::UTF_8.decode` 同语义——encoding_rs 实现的正是这份标准，
 * 所以五个标签在两侧是同一套解码规则（含非法字节替换为 U+FFFD 的不严格口径）。
 */
export const DECODE_LABEL: Record<FileEncoding, string> = {
  'utf-8': 'utf-8',
  'utf-8-bom': 'utf-8',
  shift_jis: 'shift_jis',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
};

export const tauriBridge: PlatformBridge = {
  async readFileBytes(path: string): Promise<Uint8Array> {
    // 二进制响应：字节以 ArrayBuffer 过界，不再 base64 膨胀 1.34× + 逐字节还原（§5.91）
    const buf = await invoke<ArrayBuffer>('read_file_bytes_raw', { path });
    return new Uint8Array(buf);
  },

  async readFilesRaw(paths: readonly string[]) {
    // 批量读：一次 IPC 带回 N 个文件的字节+元数据（二进制帧，无 base64 膨胀）。
    // 解帧是纯 DataView 函数（可单测）；帧与 Rust 侧 read_files_frame 成对演进。
    const buf = await invoke<ArrayBuffer>('read_files_raw', { paths: [...paths] });
    return decodeReadFilesFrame(buf);
  },

  async statFiles(paths: readonly string[]) {
    // 小载荷 JSON：与 stat_file 同源同值（Rust 共用 mtime_ms_of）
    return invoke('stat_files', { paths: [...paths] });
  },

  async writeFileBytes(path: string, data: Uint8Array): Promise<void> {
    await invoke('write_file_bytes', { path, data: bytesToBase64(data) });
  },

  async ensureDir(path: string): Promise<void> {
    await invoke('ensure_dir', { path });
  },

  async listDir(path: string) {
    return invoke('list_dir', { path });
  },

  async walkDir(path: string, opts) {
    return invoke('walk_dir', { path, opts: opts ?? null });
  },

  async exists(path: string): Promise<boolean> {
    return invoke<boolean>('path_exists', { path });
  },

  async stat(path: string) {
    return invoke('stat_file', { path });
  },

  async rename(from: string, to: string): Promise<void> {
    await invoke('rename_path', { from, to });
  },

  async copyFile(from: string, to: string): Promise<void> {
    await invoke('copy_file', { from, to });
  },

  async removeFile(path: string): Promise<void> {
    await invoke('remove_file', { path });
  },

  async removeDir(path: string): Promise<void> {
    await invoke('remove_dir', { path });
  },

  async watchDirs(
    paths: string[],
    onEvent: WatchCallback,
    onReport?: WatchReportCallback,
  ): Promise<() => void> {
    // Rust 侧（start_watch）只做"原始事件转发"，去抖与判级在内核（BUG-5 分层口径）。
    // 事件名常量与 src-tauri/src/lib.rs 的 FS_CHANGED_EVENT / FS_WATCH_ERROR_EVENT 成对。
    if (!isTauri()) {
      // 先自证再抛：让降级消息是"浏览器壳没有监视能力"，而不是 WebView 的一句 undefined
      onReport?.({ type: 'started', watched: [], failures: paths.map((p) => ({ root: p, reason: '浏览器开发壳无文件监视能力（仅 Tauri 桌面壳有）' })) });
      throw new Error('浏览器开发壳无文件监视能力（仅 Tauri 桌面壳有）');
    }
    const { listen } = await import('@tauri-apps/api/event');
    type FsChangedPayload = { kind: FileChangeKind; path: string };
    type WatchReply = { watched: string[]; failed: Array<{ path: string; error: string }> };

    const unChanged = await listen<FsChangedPayload>('kojo:fs-changed', (e) => {
      onEvent(e.payload.kind, e.payload.path);
    });
    const unError = await listen<{ error: string }>('kojo:fs-watch-error', (e) => {
      onReport?.({ type: 'error', reason: e.payload.error });
    });

    try {
      const reply = await invoke<WatchReply>('start_watch', { paths });
      onReport?.({
        type: 'started',
        watched: reply.watched,
        failures: reply.failed.map((f) => ({ root: f.path, reason: f.error })),
      });
    } catch (err) {
      // 监视器建不起来（平台层直接失败）：先报告再抛——内核据此显式降级
      const reason = err instanceof Error ? err.message : String(err);
      onReport?.({ type: 'started', watched: [], failures: paths.map((p) => ({ root: p, reason })) });
      unChanged();
      unError();
      throw err;
    }

    return () => {
      unChanged();
      unError();
      // 停监视是即发即忘：句柄由 Rust 侧 Drop 注销，这里不阻塞卸载
      void invoke('stop_watch').catch((err: unknown) => {
        console.warn('[bridge] stop_watch failed:', err);
      });
    };
  },

  async chooseDirectory(opts): Promise<string | null> {
    return invoke<string | null>('choose_directory', { title: opts?.title ?? null });
  },

  async exportFile(fileName: string, bytes: Uint8Array, opts): Promise<string | null> {
    // 保存对话框 + 写盘绑定在 Rust 侧同一个命令内，JS 拿不到落点决定权（对话框即授权）。
    // 字节走 base64，与 writeFileBytes 同口径。
    return invoke<string | null>('export_file', {
      fileName,
      data: bytesToBase64(bytes),
      title: opts?.title ?? null,
    });
  },

  async chooseWorkspaceRoot(opts): Promise<string | null> {
    // 与 exportFile 同一形态的「对话框即授权」：目录对话框 + 把选定路径登记为常驻授权根
    // 并落盘，全在 Rust 的 choose_workspace_root 一个命令内。
    // 这里没有路径入参，也没有任何"给个路径就放行写权限"的通道（铁律 6）。
    return invoke<string | null>('choose_workspace_root', { title: opts?.title ?? null });
  },

  async listWorkspaceRoots(): Promise<string[]> {
    return invoke<string[]>('workspace_roots');
  },

  async appDataDir(): Promise<string> {
    return invoke<string>('app_data_dir');
  },

  async decode(bytes: Uint8Array, encoding: FileEncoding): Promise<string> {
    return new TextDecoder(DECODE_LABEL[encoding]).decode(bytes);
  },

  async encode(text: string, encoding): Promise<Uint8Array> {
    const b64 = await invoke<string>('encode_string', { text, encoding });
    return base64ToBytes(b64);
  },
};
