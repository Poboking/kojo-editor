import type {
  FileChangeKind,
  FileEncoding,
  MarketDownloadProgress,
  MarketPublishOutcome,
  MarketPublishProgress,
  PlatformBridge,
  RemoteDownload,
  RemoteExtractLimits,
  RemoteExtractResult,
  RemoteText,
  WatchCallback,
  WatchReportCallback,
} from '@kojo/plugin-api';
import { DECODE_LABEL } from '@kojo/plugin-api';
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
 * `FileEncoding` → WHATWG 编码标签：**单源表在本仓 `@kojo/plugin-api`（`DECODE_LABEL`）**，
 * 这里只 re-export（历史调用方与 `bridge-decode.test` 仍从本模块取）。`utf-8-bom` 走 `utf-8`：
 * TextDecoder 默认剥前导 BOM，与 Rust `encoding_rs::UTF_8.decode` 同语义——encoding_rs
 * 实现的正是这份标准；唯一的实测分叉（非法字节**连跑**按 WHATWG 逐错误字节给 U+FFFD，
 * encoding_rs 合并成段）在检索侧由 `utf8_decode_whatwg` 消除，可达桶两侧逐字一致。
 */
export { DECODE_LABEL };

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

  /** 文件选择对话框（发布通道批）：只选不读不写，路径交回 JS 由后续命令按各自的闸处理 */
  async chooseFile(opts): Promise<string | null> {
    return invoke<string | null>('choose_file', {
      title: opts?.title ?? null,
      filters: opts?.filters ?? null,
    });
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

  /**
   * 远程取文本（市场注册表索引）：**本层零判定**——协议 / 可信主机白名单 / 逐跳重定向重核 /
   * 体积上限 / 超时全在 Rust `market_fetch_text` 内，与下载走的是**同一份**函数
   * （两份白名单必然漂，故这里连主机名都不出现）。
   * 非桌面壳时 `invoke` 自身抛错（`invoke.ts`），调用侧呈现"需要桌面壳"。
   */
  async fetchText(url: string, opts): Promise<RemoteText> {
    return invoke<RemoteText>('market_fetch_text', {
      url,
      timeoutMs: opts?.timeoutMs ?? null,
      maxBytes: opts?.maxBytes ?? null,
    });
  },

  /**
   * 容器下载（市场 zip 包体）：**本层零判定**，且**没有目标路径参数**——落点由 Rust 拼成
   * `<appData>/market/.staging/<containerName>`（与 `market_extract` 共用同一个名字）。
   * 出网与体积闸与 `fetchText` 在 Rust 侧是同一条函数（`guarded_send`），不在这层复述。
   * 进度经 Tauri v2 `Channel` 回传（点对点回调，不走全局事件总线）；Rust 侧已节流，
   * 这里只做转发。`onProgress` 命令侧**必传**（tauri 2 的 `Option<Channel>` 反序列化不走）
   * ⇒ 桌面壳内**总是**建通道（没回调就不挂 `onmessage`，进度照发、没人听）；
   * Channel 构造摸 `window.__TAURI_INTERNALS__` ⇒ 先 `isTauri()` 再建，
   * 浏览器环境保持 `invoke` 自身的报错口径（不抢在它前面炸）。
   */
  async marketDownload(url: string, containerName: string, opts): Promise<RemoteDownload> {
    let onProgress: unknown = null;
    if (isTauri()) {
      const { Channel } = await import('@tauri-apps/api/core');
      const channel = new Channel<MarketDownloadProgress>();
      if (opts?.onProgress !== undefined) channel.onmessage = opts.onProgress;
      onProgress = channel;
    }
    return invoke<RemoteDownload>('market_download', {
      url,
      stagingName: containerName,
      timeoutMs: opts?.timeoutMs ?? null,
      maxBytes: opts?.maxBytes ?? null,
      onProgress,
    });
  },

  /**
   * 容器解压（只在暂存子树内）：三个限额数字由调用方从契约常量传入，Rust 不写死。
   * 条目路径/类型/深度的违例由 Rust 拒并清掉已解出的内容 ⇒ 本层只搬运事实。
   */
  async marketExtract(
    containerName: string,
    targetName: string,
    limits: RemoteExtractLimits,
  ): Promise<RemoteExtractResult> {
    return invoke<RemoteExtractResult>('market_extract', {
      stagingName: containerName,
      targetName,
      limits,
    });
  },

  /**
   * 发布（上传）：zip **绝对路径**透传给 Rust 流式读原文件上传——字节不经 IPC 回 JS；
   * 进度经 Channel（节流在 Rust 侧，口径与下载同款）。Rust 命令返回扁平 DTO
   * （ok + prUrl/rejected 同现规则由 Rust 解析器保证），这里投影成契约判别联。
   */
  async marketPublish(zipPath, manifest, deviceToken, opts): Promise<MarketPublishOutcome> {
    let onProgress: unknown = null;
    if (isTauri()) {
      const { Channel } = await import('@tauri-apps/api/core');
      const channel = new Channel<MarketPublishProgress>();
      if (opts?.onProgress !== undefined) channel.onmessage = opts.onProgress;
      onProgress = channel;
    }
    const dto = await invoke<{
      status: number;
      finalUrl: string;
      ok: boolean;
      prUrl: string | null;
      verified: string | null;
      rejected: { code: string; message: string } | null;
    }>('market_publish', {
      zipPath,
      manifest,
      deviceToken,
      endpoint: opts?.endpoint ?? null,
      maxBytes: opts?.maxBytes ?? null,
      timeoutMs: opts?.timeoutMs ?? null,
      onProgress,
    });
    return dto.ok && dto.prUrl !== null
      ? {
          ok: true,
          prUrl: dto.prUrl,
          // 服务端校验深度：只认契约 `MarketPublishVerified` 的字面量（'structure-only'），
          // 别的值不进判别联（后端加新档位时在此追加——additive）
          ...(dto.verified === 'structure-only' ? { verified: 'structure-only' as const } : {}),
          status: dto.status,
          finalUrl: dto.finalUrl,
        }
      : {
          ok: false,
          rejected: dto.rejected ?? { code: 'publish-response-invalid', message: '发布响应缺拒绝结构' },
          status: dto.status,
          finalUrl: dto.finalUrl,
        };
  },

  async marketDeviceToken(endpoint?: string): Promise<string> {
    const dto = await invoke<{ token: string }>('market_device_token', {
      endpoint: endpoint ?? null,
      timeoutMs: null,
    });
    return dto.token;
  },

  async decode(bytes: Uint8Array, encoding: FileEncoding): Promise<string> {
    return new TextDecoder(DECODE_LABEL[encoding]).decode(bytes);
  },

  async encode(text: string, encoding): Promise<Uint8Array> {
    const b64 = await invoke<string>('encode_string', { text, encoding });
    return base64ToBytes(b64);
  },
};

/**
 * 外链打开（系统默认浏览器）：面板经总线发 `ui.openExternal`、壳层消费方调到这里。
 * **本层零判定**——scheme / 主机白名单闸的唯一执法点在 Rust `open_url_external`
 * （与市场下载同一份白名单），被拒时错误原样上抛，由壳层做用户可见反馈。
 * 不进 `PlatformBridge`：这是壳层消费方的直达通道，不是插件可经桥调用的面
 * （插件侧只有总线意图，插件伪造不了"绕过闸"的直达调用）。
 */
export async function openExternal(url: string): Promise<void> {
  await invoke('open_url_external', { url });
}
