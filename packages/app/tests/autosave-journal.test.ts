import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AutosaveJournal,
  HEARTBEAT_STALE_MS,
  contentHashOf,
  parseHeartbeatMs,
  parseManifest,
  planCrashRecovery,
  serializeManifest,
  snapshotFileName,
  type JournalIo,
} from '../src/ui/autosave-journal';

/**
 * autosave 快照 journal 的判据（退出/崩溃守护批）。
 *
 * node 侧真临时目录（io-backups.test.ts 同形态）：journal 引擎吃 node:fs 适配的
 * JournalIo，读写/心跳/恢复决策全部钉在真实磁盘语义上，不测内存假货。
 */

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-autosave-'));
});

/** node:fs 适配 JournalIo（与 App.tsx 里的 tauriBridge 适配同构：缺失 = undefined） */
function fsJournalIo(): JournalIo {
  return {
    readTextFile: async (p) => {
      try {
        return await fs.readFile(p, 'utf-8');
      } catch {
        return undefined;
      }
    },
    writeTextFile: async (p, text) => {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, text, 'utf-8');
    },
    removeFile: async (p) => {
      await fs.rm(p, { force: true });
    },
  };
}

const engine = (): AutosaveJournal => new AutosaveJournal(fsJournalIo(), tmpDir);

const writeHeartbeatAt = async (t: number): Promise<void> => {
  await fs.writeFile(path.join(tmpDir, 'heartbeat.json'), JSON.stringify({ t }), 'utf-8');
};

const A = 'C:\\Game\\ERB\\事件.ERB';

describe('snapshotFileName / contentHashOf（路径 → 安全文件名）', () => {
  it('同一文件两种写法（大小写/分隔符）折叠成同一份快照；不同路径不同名', () => {
    expect(snapshotFileName('C:\\Game\\ERB\\事件.ERB')).toBe(snapshotFileName('c:/game/erb/事件.erb'));
    expect(snapshotFileName('C:/other/事件.erb')).not.toBe(snapshotFileName('C:/game/事件.erb'));
  });

  it('文件名形态：snap- + 8 位 hex + .txt（无任何路径分隔/保留字符问题）', () => {
    expect(snapshotFileName(A)).toMatch(/^snap-[0-9a-f]{8}\.txt$/);
    expect(contentHashOf('x')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('parseManifest / parseHeartbeatMs（损坏容忍）', () => {
  it('undefined / 垃圾 JSON / 错版本 → 空 manifest，绝不抛', () => {
    for (const raw of [undefined, 'not json', '{"v":2,"entries":{}}', 'null', '[]']) {
      const m = parseManifest(raw);
      expect(m.v).toBe(1);
      expect(Object.keys(m.entries)).toHaveLength(0);
      expect(m.root).toBeNull();
    }
  });

  it('坏条目剔除、好条目保留、缺省字段给保守默认值', () => {
    const raw = JSON.stringify({
      v: 1,
      root: 'C:/proj',
      savedAt: 5,
      entries: {
        'C:/a.ERB': { file: 'snap-aaaaaaaa.txt', encoding: 'shift_jis', eol: 'crlf', savedAt: 9 },
        bad1: 'not an object',
        bad2: { file: '' },
        'C:/b.ERB': { file: 'snap-bbbbbbbb.txt' },
      },
    });
    const m = parseManifest(raw);
    expect(Object.keys(m.entries).sort()).toEqual(['C:/a.ERB', 'C:/b.ERB']);
    expect(m.root).toBe('C:/proj');
    expect(m.entries['C:/a.ERB']).toEqual({ file: 'snap-aaaaaaaa.txt', encoding: 'shift_jis', eol: 'crlf', savedAt: 9 });
    expect(m.entries['C:/b.ERB']).toEqual({ file: 'snap-bbbbbbbb.txt', encoding: 'utf-8', eol: 'lf', savedAt: 0 });
  });

  it('serializeManifest → parseManifest 往返等值', () => {
    const m = parseManifest(
      JSON.stringify({ v: 1, root: 'C:/p', savedAt: 1, entries: { 'C:/a.ERB': { file: 'snap-1.txt', encoding: 'utf-8', eol: 'lf', savedAt: 2 } } }),
    );
    expect(parseManifest(serializeManifest(m))).toEqual(m);
  });

  it('心跳：合法读出、垃圾/非正数 → null', () => {
    expect(parseHeartbeatMs('{"t":123}')).toBe(123);
    expect(parseHeartbeatMs('{"t":-1}')).toBeNull();
    expect(parseHeartbeatMs('{"t":"x"}')).toBeNull();
    expect(parseHeartbeatMs('garbage')).toBeNull();
    expect(parseHeartbeatMs(undefined)).toBeNull();
  });
});

describe('planCrashRecovery（恢复决策纯函数）', () => {
  const populated = parseManifest(
    JSON.stringify({ v: 1, root: 'C:/p', savedAt: 1, entries: { 'C:/a.ERB': { file: 'snap-1.txt', encoding: 'utf-8', eol: 'lf', savedAt: 1 } } }),
  );
  const empty = parseManifest(undefined);
  const now = 1_000_000;

  it('空条目 → 永不恢复（哪怕心跳超龄/缺失）', () => {
    expect(planCrashRecovery(empty, JSON.stringify({ t: now - HEARTBEAT_STALE_MS * 10 }), now)).toBe(false);
    expect(planCrashRecovery(empty, undefined, now)).toBe(false);
  });

  it('条目非空 + 心跳新鲜 → 不恢复（上次是善终或仍在跑）', () => {
    expect(planCrashRecovery(populated, JSON.stringify({ t: now - 1 }), now)).toBe(false);
    expect(planCrashRecovery(populated, JSON.stringify({ t: now - HEARTBEAT_STALE_MS }), now)).toBe(false);
  });

  it('条目非空 + 心跳超龄/缺失 → 恢复（心跳缺失 = 写了一半就没命，正是要兜的）', () => {
    expect(planCrashRecovery(populated, JSON.stringify({ t: now - HEARTBEAT_STALE_MS - 1 }), now)).toBe(true);
    expect(planCrashRecovery(populated, undefined, now)).toBe(true);
  });
});

describe('AutosaveJournal（真临时目录）', () => {
  it('snapshot 落盘：manifest / heartbeat / 快照内容逐字，readForRecovery 对新鲜心跳不恢复', async () => {
    const j = engine();
    await j.snapshot('C:/proj', [{ path: A, text: '未保存内容', encoding: 'shift_jis', eol: 'crlf' }]);
    const manifest = parseManifest(await fs.readFile(path.join(tmpDir, 'manifest.json'), 'utf-8'));
    expect(manifest.root).toBe('C:/proj');
    const entry = manifest.entries[A];
    expect(entry).toBeDefined();
    expect(await fs.readFile(path.join(tmpDir, entry!.file), 'utf-8')).toBe('未保存内容');
    expect(parseHeartbeatMs(await fs.readFile(path.join(tmpDir, 'heartbeat.json'), 'utf-8'))).not.toBeNull();
    // 心跳新鲜：上次善终/仍在跑 → 不恢复
    expect(await j.readForRecovery()).toBeNull();
  });

  it('心跳回拨到超龄 → 恢复记录带原路径 + 快照内容 + 编码口径', async () => {
    const j = engine();
    await j.snapshot('C:/proj', [{ path: A, text: '崩溃前的一行', encoding: 'utf-8-bom', eol: 'crlf' }]);
    await writeHeartbeatAt(Date.now() - HEARTBEAT_STALE_MS - 5);
    const rec = await j.readForRecovery();
    expect(rec).not.toBeNull();
    expect(rec!.manifest.root).toBe('C:/proj');
    expect(rec!.records).toEqual([
      { path: A, text: '崩溃前的一行', encoding: 'utf-8-bom', eol: 'crlf' },
    ]);
  });

  it('快照文件丢了 → 该条目宁缺毋滥，其余照常恢复', async () => {
    const j = engine();
    await j.snapshot('C:/proj', [
      { path: A, text: 'a', encoding: 'utf-8', eol: 'lf' },
      { path: 'C:/Game/ERB/另一份.ERB', text: 'b', encoding: 'utf-8', eol: 'lf' },
    ]);
    // 删掉 A 的快照文件
    await fs.rm(path.join(tmpDir, snapshotFileName(A)));
    await writeHeartbeatAt(Date.now() - HEARTBEAT_STALE_MS - 5);
    const rec = await j.readForRecovery();
    expect(rec!.records.map((r) => r.path)).toEqual(['C:/Game/ERB/另一份.ERB']);
  });

  it('孤儿回收：路径不再脏 → 它的快照文件被顺手删掉', async () => {
    const j = engine();
    await j.snapshot('C:/proj', [
      { path: A, text: 'a', encoding: 'utf-8', eol: 'lf' },
      { path: 'C:/Game/ERB/另一份.ERB', text: 'b', encoding: 'utf-8', eol: 'lf' },
    ]);
    const fileB = snapshotFileName('C:/Game/ERB/另一份.ERB');
    await j.snapshot('C:/proj', [{ path: A, text: 'a2', encoding: 'utf-8', eol: 'lf' }]);
    await expect(fs.access(path.join(tmpDir, fileB))).rejects.toThrow();
    await expect(fs.access(path.join(tmpDir, snapshotFileName(A)))).resolves.toBeUndefined();
  });

  it('会话内 clear：manifest 清空 + 心跳删除 → 不再恢复；未写过快照的新会话 clear 是 no-op（保护崩溃证据）', async () => {
    const j = engine();
    await j.snapshot('C:/proj', [{ path: A, text: 'a', encoding: 'utf-8', eol: 'lf' }]);
    await j.clear();
    expect(parseManifest(await fs.readFile(path.join(tmpDir, 'manifest.json'), 'utf-8')).entries).toEqual({});
    await expect(fs.readFile(path.join(tmpDir, 'heartbeat.json'), 'utf-8')).rejects.toThrow();
    expect(await j.readForRecovery()).toBeNull();

    // 新会话（新引擎实例 = 未写过快照）：对上一会话的崩溃证据 clear 无效
    await j.snapshot('C:/proj', [{ path: A, text: 'a', encoding: 'utf-8', eol: 'lf' }]);
    await writeHeartbeatAt(Date.now() - HEARTBEAT_STALE_MS - 5);
    const fresh = engine();
    await fresh.clear();
    const rec = await fresh.readForRecovery();
    expect(rec).not.toBeNull();
    // 但 discard（用户明确丢弃）必须清得掉
    await fresh.discard();
    expect(await fresh.readForRecovery()).toBeNull();
  });

  it('heartbeat：会话内写过快照才刷，干净会话绝不制造心跳（不制造疑似崩溃证据）', async () => {
    const j = engine();
    await j.heartbeat(); // 没写过快照：no-op
    await expect(fs.readFile(path.join(tmpDir, 'heartbeat.json'), 'utf-8')).rejects.toThrow();
    await j.snapshot('C:/proj', [{ path: A, text: 'a', encoding: 'utf-8', eol: 'lf' }]);
    await j.heartbeat(12345);
    expect(parseHeartbeatMs(await fs.readFile(path.join(tmpDir, 'heartbeat.json'), 'utf-8'))).toBe(12345);
  });
});
