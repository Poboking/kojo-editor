import type { PlatformBridge, ScopedStorage, StorageService } from '@kojo/plugin-api';
import { join } from '@kojo/plugin-api';
import { decodeWithProbe } from './encoding';

/**
 * 存储域实现。
 *
 * 布局：`{appDataDir}/store/{scope}/{key}.json`
 * - 每个插件一个 scope（= 插件 id），禁止跨域读写；
 * - key 与 scope 均做硬校验（防路径穿越，见 DSH 教训："存储域名用下划线/安全字符"）；
 * - 全局域 `_global` 供内核通用持久化（最近项目、写权限批准记录）。
 */
export interface StorageBackend {
  read(scope: string, key: string): Promise<string | undefined>;
  write(scope: string, key: string, data: string): Promise<void>;
  remove(scope: string, key: string): Promise<void>;
  list(scope: string): Promise<string[]>;
}

const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/;

export function assertSafeSegment(kind: 'scope' | 'key', value: string): void {
  if (!SAFE_SEGMENT.test(value) || value.includes('..')) {
    throw new Error(`Invalid storage ${kind}: '${value}' (allowed: [A-Za-z0-9_][A-Za-z0-9._-]{0,119}, no '..')`);
  }
}

/** 基于 PlatformBridge 的文件后端（Node 与 Tauri 通用） */
export class FileStorageBackend implements StorageBackend {
  private baseDirPromise: Promise<string> | null = null;

  constructor(private readonly bridge: PlatformBridge) {}

  private baseDir(): Promise<string> {
    if (!this.baseDirPromise) {
      this.baseDirPromise = this.bridge.appDataDir().then((d) => join(d, 'store'));
    }
    return this.baseDirPromise;
  }

  private async scopeDir(scope: string): Promise<string> {
    assertSafeSegment('scope', scope);
    return join(await this.baseDir(), scope);
  }

  async read(scope: string, key: string): Promise<string | undefined> {
    assertSafeSegment('key', key);
    const path = join(await this.scopeDir(scope), `${key}.json`);
    if (!(await this.bridge.exists(path))) return undefined;
    const bytes = await this.bridge.readFileBytes(path);
    // 单源解码（W12 ENC-SRC）：旧写法是旁路 `bridge.decode(bytes, 'utf-8')`——当年在对照的是
    // "客户端 TextDecoder vs Rust encoding_rs"逐字等价性（§5.90 实机复测后 Rust 侧对照命令
    // `decode_bytes` 已删）。判序/替换策略合一进 DECODE_PROBE_POLICY 后，KV 与编辑器走同
    // 一个 `decodeWithProbe`，对照物不复存在，旁路随之取消。
    return decodeWithProbe(bytes).text;
  }

  async write(scope: string, key: string, data: string): Promise<void> {
    assertSafeSegment('key', key);
    const dir = await this.scopeDir(scope);
    const path = join(dir, `${key}.json`);
    await this.bridge.ensureDir(dir);
    const bytes = await this.bridge.encode(data, 'utf-8');
    await this.bridge.writeFileBytes(path, bytes);
  }

  async remove(scope: string, key: string): Promise<void> {
    assertSafeSegment('key', key);
    const path = join(await this.scopeDir(scope), `${key}.json`);
    if (await this.bridge.exists(path)) await this.bridge.removeFile(path);
  }

  async list(scope: string): Promise<string[]> {
    const dir = await this.scopeDir(scope);
    const entries = await this.bridge.listDir(dir);
    return entries
      .filter((e) => !e.isDirectory && e.name.endsWith('.json'))
      .map((e) => e.name.slice(0, -'.json'.length));
  }
}

class ScopedStorageImpl implements ScopedStorage {
  constructor(
    private readonly scope: string,
    private readonly backend: StorageBackend,
  ) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    assertSafeSegment('key', key);
    const raw = await this.backend.read(this.scope, key);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch (e: unknown) {
      // 损坏的存储文件不致命：记日志 + 视为缺失（审阅 L1 修复；
      // recent 列表等非关键数据不该让整个存储域不可用）
      console.warn(`[storage] corrupted JSON in ${this.scope}/${key}: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    assertSafeSegment('key', key);
    await this.backend.write(this.scope, key, JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    assertSafeSegment('key', key);
    await this.backend.remove(this.scope, key);
  }

  async keys(): Promise<string[]> {
    return this.backend.list(this.scope);
  }
}

/** 全局域 scope 名（下划线前缀，与插件 id 视觉区分） */
export const GLOBAL_SCOPE = '_global';

export class StorageServiceImpl implements StorageService {
  constructor(private readonly backend: StorageBackend) {}

  scope(pluginId: string): ScopedStorage {
    assertSafeSegment('scope', pluginId);
    return new ScopedStorageImpl(pluginId, this.backend);
  }

  global(): ScopedStorage {
    return new ScopedStorageImpl(GLOBAL_SCOPE, this.backend);
  }
}
