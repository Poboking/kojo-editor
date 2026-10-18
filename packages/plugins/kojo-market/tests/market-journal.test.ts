/**
 * 2026-10-18 undo 覆盖批：市场装卸进 OpJournal 的端到端行为面。
 *
 * 用**真** OpsJournalImpl + NodeBridge + 内核 io（不用 mock）——装卸的记账语义
 * （新建条目 / 重装旧字节快照 / 卸载前快照）只有走真回滚链路才钉得死：
 * ① **新装**：rename 前逐文件 record（全部 before=null）⇒ undo 即整包删除；
 * ② **重装（同版本覆盖）**：record 抓旧版本字节 ⇒ undo 恢复旧版；
 * ③ **卸载**：removeDir 前 walk 逐文件 record ⇒ undo 恢复整包字节；
 * ④ **begin 失败**：装 / 卸整体取消（写得出却撤不回的批量写不做）。
 *
 * journal 缺席 = 旧行为零改动，由既有全部用例（不传 journal）钉住。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join as nodeJoin, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MARKET_SCHEMA_VERSION,
  type Logger,
  type RemoteService,
  type ScopedStorage,
} from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { OpsJournalImpl } from '../../../kernel/src/journal';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { createMarketService, sha256Hex } from '../src/index';

const APP_VERSION = '0.4.0-beta.1';
const PACK_ID = 'journal.pack';
const PACK_VERSION = '1.0.0';

const tmps: string[] = [];

function memStorage(): ScopedStorage {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return store.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async keys() {
      return [...store.keys()];
    },
  };
}

const quietLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const noRemote = (): RemoteService => ({
  async fetchText() {
    throw new Error('本判据不联网');
  },
  async marketDownload() {
    throw new Error('本判据不下载');
  },
  async marketExtract() {
    throw new Error('本判据不解压');
  },
});

/** 造源包：pack.json + files/ 下两个条目（一个根级、一个深层）。`mutate` 换内容造"重装"。 */
async function buildSource(contents: { a: string; b: string }): Promise<string> {
  const sourceDir = mkdtempSync(nodeJoin(tmpdir(), 'kojo-market-journal-src-'));
  tmps.push(sourceDir);
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const [rel, text] of [
    ['files/a.ERB', contents.a],
    ['files/deep/b.ERB', contents.b],
  ] as const) {
    const bytes = new TextEncoder().encode(text);
    const abs = nodeJoin(sourceDir, rel.replace(/\//g, sep));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
    files.push({ path: rel, bytes: bytes.length, sha256: await sha256Hex(bytes) });
  }
  writeFileSync(
    nodeJoin(sourceDir, 'pack.json'),
    JSON.stringify({
      schema: MARKET_SCHEMA_VERSION,
      kind: 'kojo-pack',
      id: PACK_ID,
      version: PACK_VERSION,
      name: '记账包',
      author: 'someone',
      license: 'CC-BY-NC 4.0',
      redistribute: true,
      minAppVersion: '0.4.0',
      files,
    }),
    'utf8',
  );
  return sourceDir;
}

let appData: string;
let marketRoot: string;
let packsRoot: string;
let io: FileIOServiceImpl;
let journal: OpsJournalImpl;

beforeEach(() => {
  appData = mkdtempSync(nodeJoin(tmpdir(), 'kojo-market-journal-app-'));
  tmps.push(appData);
  marketRoot = nodeJoin(appData, 'market');
  packsRoot = nodeJoin(marketRoot, 'packs', 'kojo-pack', PACK_ID, PACK_VERSION);
  mkdirSync(marketRoot, { recursive: true });
  io = new FileIOServiceImpl(new NodeBridge(appData));
  io.setAppWritableRoots([marketRoot]);
  journal = new OpsJournalImpl({ bridge: new NodeBridge(appData), io, log: quietLog });
});

afterEach(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
  tmps.length = 0;
}, 60_000);

function service(j: OpsJournalImpl | undefined = journal): ReturnType<typeof createMarketService> {
  return createMarketService({
    io,
    remote: noRemote(),
    storage: memStorage(),
    log: quietLog,
    root: marketRoot,
    appVersion: APP_VERSION,
    ...(j === undefined ? {} : { journal: j }),
  });
}

/** 递归收集目录下全部文件的相对内容指纹（比对"整包恢复"用） */
function snapshotDir(root: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = nodeJoin(dir, name.name);
      const r = rel === '' ? name.name : `${rel}/${name.name}`;
      if (name.isDirectory()) walk(p, r);
      else out.push([r, readFileSync(p, 'utf8')]);
    }
  };
  walk(root, '');
  return out.sort(([a], [b]) => a.localeCompare(b));
}

describe('市场装卸进 OpJournal（2026-10-18 undo 覆盖批）', () => {
  it('新装：整包进账（kind=market-install，全条目新建），undo 即整包删除', async () => {
    const src = await buildSource({ a: 'AAA', b: 'BBB' });
    await service().installLocalDir(src);

    const list = await journal.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'market-install', status: 'committed', fileCount: 2 });
    const entries = await journal.entriesOf(list[0]!.id);
    expect(entries.every((e) => !e.hasBefore)).toBe(true); // 新装 = 操作内新建
    expect(snapshotDir(packsRoot)).toEqual([
      ['files/a.ERB', 'AAA'],
      ['files/deep/b.ERB', 'BBB'],
    ]);

    await journal.undo(list[0]!.id);
    expect(await io.exists(packsRoot)).toBe(false); // 整包没了
  });

  it('重装（同版本覆盖）：record 抓旧版字节 ⇒ undo 恢复旧版内容', async () => {
    const srcV1 = await buildSource({ a: '旧A', b: '旧B' });
    await service().installLocalDir(srcV1);
    expect(await journal.list()).toHaveLength(1);

    const srcV2 = await buildSource({ a: '新A内容', b: '新B内容' });
    await service().installLocalDir(srcV2); // 同 id 同 version ⇒ 覆盖重装
    expect(snapshotDir(packsRoot)).toEqual([
      ['files/a.ERB', '新A内容'],
      ['files/deep/b.ERB', '新B内容'],
    ]);

    const list = await journal.list(); // 新在前：[重装 op, 首装 op]
    expect(list[0]).toMatchObject({ kind: 'market-install', fileCount: 2 });
    const reinstall = await journal.entriesOf(list[0]!.id);
    expect(reinstall.every((e) => e.hasBefore)).toBe(true); // 重装 = 旧版字节快照

    await journal.undo(list[0]!.id); // 撤销重装 ⇒ 旧版回来
    expect(snapshotDir(packsRoot)).toEqual([
      ['files/a.ERB', '旧A'],
      ['files/deep/b.ERB', '旧B'],
    ]);
  });

  it('卸载：removeDir 前整包快照 ⇒ undo 恢复整包字节', async () => {
    const src = await buildSource({ a: 'AAA', b: 'BBB' });
    await service().installLocalDir(src);
    expect(await journal.list()).toHaveLength(1); // 首装 op

    await service().uninstall('kojo-pack', PACK_ID, PACK_VERSION);
    expect(await io.exists(packsRoot)).toBe(false); // 卸干净了

    const list = await journal.list(); // 新在前：[卸载 op, 首装 op]
    expect(list[0]).toMatchObject({ kind: 'market-uninstall', fileCount: 2 });
    const entries = await journal.entriesOf(list[0]!.id);
    expect(entries.every((e) => e.hasBefore)).toBe(true); // 卸载前每文件都有快照

    await journal.undo(list[0]!.id); // 误卸载可整包恢复
    expect(snapshotDir(packsRoot)).toEqual([
      ['files/a.ERB', 'AAA'],
      ['files/deep/b.ERB', 'BBB'],
    ]);
  });

  it('begin 失败 ⇒ 装包整体取消（未动盘），卸载同样取消（目录还在）', async () => {
    const failBegin = {
      begin: async (): Promise<string> => {
        throw new Error('账本起不来');
      },
      record: async (): Promise<void> => {},
      commit: async (): Promise<void> => {},
      abort: async (): Promise<void> => {},
    };
    const src = await buildSource({ a: 'AAA', b: 'BBB' });
    await expect(service(failBegin as never).installLocalDir(src)).rejects.toThrow(/账本起不来/);
    expect(await io.exists(packsRoot)).toBe(false); // 装包未动盘

    // 先正常装一版，再在 begin 失败下卸载 ⇒ 卸载被取消、目录还在
    await service().installLocalDir(src);
    await expect(service(failBegin as never).uninstall('kojo-pack', PACK_ID, PACK_VERSION))
      .rejects.toThrow(/账本起不来/);
    expect(await io.exists(packsRoot)).toBe(true); // 宁可不卸，不给撤不回的删除
    expect(snapshotDir(packsRoot)).toEqual([
      ['files/a.ERB', 'AAA'],
      ['files/deep/b.ERB', 'BBB'],
    ]);
  });
});