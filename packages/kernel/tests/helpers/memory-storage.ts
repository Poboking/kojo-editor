import type { StorageBackend, StorageReadResult } from '../../src/storage';

/** 内存存储后端（测试用，零 IO）；三态与 FileStorageBackend 逐字同形（missing/ok，无坏盘形态） */
export class MemoryStorageBackend implements StorageBackend {
  private readonly data = new Map<string, string>();

  async read(scope: string, key: string): Promise<StorageReadResult> {
    const raw = this.data.get(`${scope}/${key}`);
    return raw === undefined ? { kind: 'missing' } : { kind: 'ok', data: raw };
  }

  async write(scope: string, key: string, value: string): Promise<void> {
    this.data.set(`${scope}/${key}`, value);
  }

  async remove(scope: string, key: string): Promise<void> {
    this.data.delete(`${scope}/${key}`);
  }

  async list(scope: string): Promise<string[]> {
    const prefix = `${scope}/`;
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }
}
