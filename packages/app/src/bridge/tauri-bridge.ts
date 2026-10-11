import type { PlatformBridge } from '@kojo/plugin-api';
import { base64ToBytes, bytesToBase64, invoke } from './invoke';

/**
 * PlatformBridge 的 Tauri 实现。
 *
 * Rust 侧同名命令见 src-tauri/src/lib.rs。
 * 二进制数据用 base64 字符串跨 IPC（确定性强、跨 Tauri 版本稳定；口上文件体量下开销可忽略）。
 *
 * v0.1 未实现：watchDirs（文件监视走 Rust notify，后续版本接入）——
 * 返回空取消函数而非抛错，调用方无需特判；UI 用显式刷新按钮替代。
 */
export const tauriBridge: PlatformBridge = {
  async readFileBytes(path: string): Promise<Uint8Array> {
    const b64 = await invoke<string>('read_file_bytes', { path });
    return base64ToBytes(b64);
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

  async watchDirs(): Promise<() => void> {
    console.warn('[bridge] watchDirs is not implemented in v0.1 (planned: Rust notify)');
    return () => {};
  },

  async chooseDirectory(opts): Promise<string | null> {
    return invoke<string | null>('choose_directory', { title: opts?.title ?? null });
  },

  async appDataDir(): Promise<string> {
    return invoke<string>('app_data_dir');
  },

  async decode(bytes: Uint8Array, encoding): Promise<string> {
    return invoke<string>('decode_bytes', { data: bytesToBase64(bytes), encoding });
  },

  async encode(text: string, encoding): Promise<Uint8Array> {
    const b64 = await invoke<string>('encode_string', { text, encoding });
    return base64ToBytes(b64);
  },
};
