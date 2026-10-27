import type { DirEntry, PlatformBridge, WalkOptions } from '@kojo/plugin-api';

/**
 * 「Tauri 形」平台桥模拟器——**专门用来暴露桥分叉**（2026-10-16 walkDir filter 批）。
 *
 * ## 为什么需要它
 *
 * `NodeBridge.walkDir` 是 JS 递归，会**兑现** `WalkOptions.filter`；桌面壳的
 * `walkDir` 是一次 `invoke('walk_dir', { path, opts })`，而 Rust 侧
 * `WalkOptionsDto` 只有 `include_files / include_dirs / max_depth / with_metadata`
 * 四个字段——**JS 闭包过不了 IPC，`filter` 在序列化那一刻被静默吃掉**。
 * 于是同一条调用在生产里返回整棵树、在测试里返回筛过的树，测试口径与生产口径分叉
 * （实测代价：真语料开项目 27 秒里有 24.4 秒花在把 4,519 份文件逐份串行读进作者自定名表）。
 *
 * node 测试桥永远测不到这件事 ⇒ 需要一个**按线的行为建模**的桥：
 * 入参过一次 JSON 往返（函数键当场消失）、枚举不看谓词。本文件就是那具桥。
 *
 * ## 建模的三条事实（多一条都不许加）
 *
 * 1. 参数经 JSON 序列化 ⇒ 函数值整键丢弃（`JSON.stringify` 的自然行为，不是这里写的规则）；
 * 2. Rust 的 DTO 只认那四个字段 ⇒ 未知键（哪怕可序列化）也到不了宿主；
 * 3. 逐次记录读盘路径 ⇒ 「实际读了多少份文件」这种判据才量得到（本批守门测试的落点）。
 *
 * 只读侧与 walk 侧被特化，其余方法原样透传给内层桥（不做第二份实现，避免又一处真相）。
 */

/** Rust `WalkOptionsDto` 的字段全集（`packages/app/src-tauri/src/lib.rs`；多余键过不了线） */
const RUST_WALK_DTO_KEYS = [
  'maxDepth',
  'includeFiles',
  'includeDirs',
  'withMetadata',
  'extensions',
] as const;

/** 过线后的 `WalkOptions` 形态：JSON 往返 + DTO 白名单（`filter` 必然不在其中） */
export function walkOptionsOnWire(opts: WalkOptions | undefined): WalkOptions | undefined {
  if (opts === undefined) return undefined;
  const cloned = JSON.parse(JSON.stringify(opts)) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of RUST_WALK_DTO_KEYS) {
    if (k in cloned) out[k] = cloned[k];
  }
  return out as WalkOptions;
}

/** 本桥记下的线上事实（守门测试的读数面） */
export interface WireFacts {
  /** 每次 `walkDir`：**内核递到桥手上**的 opts 的键（含 `filter` ⇒ 谓词被当成可跨进程的参数） */
  readonly walkOptKeys: string[][];
  /** 每次 `walkDir`：过线后真正到达宿主的 opts */
  readonly wireWalkOpts: Array<Record<string, unknown>>;
  /** 逐次单文件读（`read_file_bytes_raw`）的路径 */
  readonly singleReads: string[];
  /** 逐次 `exists` 的路径（PS-2 存储守卫：合并后一趟都不该有） */
  readonly existsCalls: string[];
  /** 逐次批量读（`read_files_raw`）的路径与批大小 */
  readonly batchReads: string[];
  readonly batchInvocations: Array<{ readonly size: number }>;
}

export function newWireFacts(): WireFacts {
  return {
    walkOptKeys: [],
    wireWalkOpts: [],
    singleReads: [],
    existsCalls: [],
    batchReads: [],
    batchInvocations: [],
  };
}

/**
 * 包一层「Tauri 形」桥：`walkDir` 走 JSON 序列化口径、读盘侧记数，其余透传。
 *
 * @param inner 真正落盘的桥（通常是 `NodeBridge`）——本壳只改**参数过境形态**，不改文件系统语义
 */
export function tauriShapedBridge(inner: PlatformBridge, facts: WireFacts): PlatformBridge {
  const self: PlatformBridge = new Proxy(inner, {
    get(target, prop: string | symbol) {
      if (prop === 'walkDir') {
        return async (path: string, opts?: WalkOptions): Promise<DirEntry[]> => {
          facts.walkOptKeys.push(Object.keys(opts ?? {}));
          const onWire = walkOptionsOnWire(opts);
          facts.wireWalkOpts.push(onWire as unknown as Record<string, unknown>);
          return target.walkDir(path, onWire);
        };
      }
      if (prop === 'readFileBytes') {
        return async (path: string): Promise<Uint8Array> => {
          facts.singleReads.push(path);
          return target.readFileBytes(path);
        };
      }
      if (prop === 'exists') {
        return async (path: string): Promise<boolean> => {
          facts.existsCalls.push(path);
          return target.exists(path);
        };
      }
      if (prop === 'readFilesRaw') {
        return async (paths: readonly string[]) => {
          facts.batchReads.push(...paths);
          facts.batchInvocations.push({ size: paths.length });
          return target.readFilesRaw(paths);
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return self;
}
