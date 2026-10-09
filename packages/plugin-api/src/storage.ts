/**
 * 存储域：每个插件一个命名空间，禁止跨域读写。
 * 对应 DSH 的 `{userData}/store/{plugin_id}/` 约定（persona_mode:personas 同源设计）。
 */
export interface ScopedStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface StorageService {
  /** 取某插件的域（插件只能通过 ctx.storage 拿到自己的域；此方法供内核与调试面板使用） */
  scope(pluginId: string): ScopedStorage;
  /** 内核预留的全局域（不绑定具体插件；用于最近项目等通用持久化） */
  global(): ScopedStorage;
}
