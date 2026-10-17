import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname as nodeDirname, join as nodeJoin } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MARKET_CONTENT_DIR,
  MARKET_DEFAULT_PUBLISH_URL,
  MARKET_MANIFEST_FILE,
  MARKET_SCHEMA_VERSION,
  MARKET_STAGING_DIR,
  MarketError,
  buildZip,
  inflateZipEntry,
  readZipContainer,
  verifyZipRoundtrip,
  type FileIO,
  type Logger,
  type MarketPackDraft,
  type MarketPublishOutcome,
  type MarketPublishProgress,
  type PackManifest,
  type RemoteExtractLimits,
  type RemoteExtractResult,
  type RemotePublishOptions,
  type RemoteService,
  type ScopedStorage,
} from '@kojo/plugin-api';
import { createMarketService, sha256Hex } from '../src/index';

/**
 * `MarketService.publishPack`（「发布口上」从工作区草案现打包）的判据。
 *
 * 与 `publish.test.ts` 同一条边界：这里证明**编排与产物**，不证明 HTTP 上传
 * （上传闸 / 流式读 / Bearer 在 Rust `market_tests.rs`）。不同之处是——本文件的假
 * `marketExtract` **真的解 ZIP**（`readZipContainer` + `inflateZipEntry`），于是
 * "服务打出来的容器"第一次被真实读回来：条目名、`pack.json` 字段、逐文件 sha256
 * 与字节全部对平，而不是按给定 manifest 伪造一份"解出来的样子"。
 *
 * 钉死的五件事：
 * 1. 成功路径：上传收到的 zip 可被真实解析/解出，`pack.json` 字段与逐文件锚对平；
 * 2. `minAppVersion` 缺省 = appVersion 的核心三段（`0.4.0-beta.1` → `0.4.0`）；
 * 3. `redistribute:false` 在预校验阶段被既有 `parseManifest` 拒（`redistribute-denied`），
 *    不进入上传；
 * 4. 非法 id / version 同样由既有清单校验拒（不另写第二套判定）；
 * 5. 暂存区里那个临时草案容器**最终不存在**（成功与失败两条路径都不留残壳）。
 */

const APP_VERSION = '0.4.0-beta.1';
const tmps: string[] = [];
const enc = new TextEncoder();

const bytesOf = (text: string): Uint8Array => enc.encode(text);

function fakeIo(root: string): FileIO {
  const io: Record<string, unknown> = {
    async readText(p: string) {
      return { path: p, text: readFileSync(p, 'utf8'), encoding: 'utf-8', eol: 'lf', mtimeMs: 1 };
    },
    async readBytes(p: string): Promise<Uint8Array> {
      return new Uint8Array(readFileSync(p));
    },
    async writeBytes(p: string, data: Uint8Array): Promise<void> {
      mkdirSync(nodeJoin(p, '..'), { recursive: true });
      writeFileSync(p, data);
    },
    async copyFile(from: string, to: string): Promise<void> {
      writeFileSync(to, readFileSync(from));
    },
    async stat(p: string) {
      try {
        const st = statSync(p);
        return { size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() };
      } catch {
        return null;
      }
    },
    async ensureDir(p: string): Promise<void> {
      mkdirSync(p, { recursive: true });
    },
    async exists(p: string): Promise<boolean> {
      try {
        readdirSync(p);
        return true;
      } catch {
        try {
          readFileSync(p);
          return true;
        } catch {
          return false;
        }
      }
    },
    async rename(from: string, to: string): Promise<void> {
      renameSync(from, to);
    },
    async removeDir(p: string): Promise<void> {
      rmSync(p, { recursive: true, force: true });
    },
    async removeFile(p: string): Promise<void> {
      rmSync(p, { force: true });
    },
    async appDataDir(): Promise<string> {
      return root;
    },
    addAppWritableRoot: () => undefined,
    setAppWritableRoots: () => undefined,
    setWritableRoots: () => undefined,
    isWritable: () => true,
  };
  return io as unknown as FileIO;
}

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

/* ------------------------------- 假壳层（真解 ZIP） ------------------------------- */

interface CapturedPublish {
  zipPath: string;
  zipBytes: Uint8Array;
  manifest: unknown;
  token: string;
  opts: RemotePublishOptions | undefined;
}

class FakeBridge {
  readonly extractCalls: Array<{ container: string; target: string; limits: RemoteExtractLimits }> = [];
  readonly publishCalls: CapturedPublish[] = [];
  tokenFetches = 0;
  /** 上传段回放的进度帧（测 onProgress 原样透传） */
  frames: MarketPublishProgress[] = [];
  /** 上传段抛错（平台侧故障） */
  publishThrows: string | undefined = undefined;
  /** 上传段的裁决（默认成功） */
  outcome: MarketPublishOutcome | undefined = undefined;

  constructor(private readonly marketRoot: string) {}

  remote(): RemoteService {
    return {
      async fetchText(): Promise<never> {
        throw new Error('本文件不刷新索引');
      },
      async marketDownload(): Promise<never> {
        throw new Error('本文件不下载');
      },
      // 预校验用的"解压"：**从暂存区里那个真容器读回来**（不是按给定清单伪造）
      marketExtract: async (
        containerName: string,
        targetName: string,
        limits: RemoteExtractLimits,
      ): Promise<RemoteExtractResult> => {
        this.extractCalls.push({ container: containerName, target: targetName, limits });
        const containerPath = nodeJoin(this.marketRoot, MARKET_STAGING_DIR, containerName);
        const bytes = new Uint8Array(readFileSync(containerPath));
        const container = readZipContainer(bytes);
        const dir = nodeJoin(this.marketRoot, MARKET_STAGING_DIR, targetName);
        const entries: RemoteExtractResult['entries'] = [];
        for (const entry of container.entries) {
          const data = await inflateZipEntry(entry);
          const dest = nodeJoin(dir, entry.name);
          mkdirSync(nodeDirname(dest), { recursive: true });
          writeFileSync(dest, data);
          entries.push({ path: entry.name, bytes: data.length });
        }
        return { entries, totalBytes: entries.reduce((s, e) => s + e.bytes, 0) };
      },
      marketDeviceToken: async (): Promise<string> => {
        this.tokenFetches += 1;
        return 'dev-token-1';
      },
      marketPublish: async (
        zipPath: string,
        manifest: Parameters<NonNullable<RemoteService['marketPublish']>>[1],
        token: string,
        opts?: RemotePublishOptions,
      ): Promise<MarketPublishOutcome> => {
        // 上传那一刻文件必须还在（服务在 finally 里才删）——顺手把真字节留在账上
        this.publishCalls.push({
          zipPath,
          zipBytes: new Uint8Array(readFileSync(zipPath)),
          manifest,
          token,
          opts,
        });
        for (const f of this.frames) opts?.onProgress?.(f);
        if (this.publishThrows !== undefined) throw new Error(this.publishThrows);
        return (
          this.outcome ?? {
            ok: true as const,
            prUrl: 'https://github.com/p/pull/42',
            status: 200,
            finalUrl: `${MARKET_DEFAULT_PUBLISH_URL}/publish`,
          }
        );
      },
    };
  }
}

interface Harness {
  svc: ReturnType<typeof createMarketService>;
  root: string;
  bridge: FakeBridge;
}

function boot(): Harness {
  const appData = mkdtempSync(nodeJoin(tmpdir(), 'kojo-market-pubpack-'));
  tmps.push(appData);
  const root = nodeJoin(appData, 'market');
  mkdirSync(nodeJoin(root, MARKET_STAGING_DIR), { recursive: true });
  const bridge = new FakeBridge(root);
  const svc = createMarketService({
    io: fakeIo(root),
    remote: bridge.remote(),
    storage: memStorage(),
    log: quietLog,
    root,
    appVersion: APP_VERSION,
  });
  return { svc, root, bridge };
}

/** 暂存区当前剩下的名字（发布链路要求它最终为空） */
function stagedLeftovers(root: string): string[] {
  try {
    return readdirSync(nodeJoin(root, MARKET_STAGING_DIR)).sort();
  } catch {
    return [];
  }
}

/** 草案构造（默认一个最小合法口上包） */
function draftOf(
  files: ReadonlyArray<readonly [string, string]>,
  over: Partial<MarketPackDraft> = {},
): MarketPackDraft {
  return {
    kind: 'kojo-pack',
    id: 'demo.kojo',
    version: '1.0.0',
    name: '演示口上',
    author: '某作者',
    license: 'MIT',
    redistribute: true,
    files: files.map(([path, text]) => ({ path, bytes: bytesOf(text) })),
    ...over,
  };
}

/** 上传收到的容器 → 解出的全部条目（名字 + 字节，顺序 = 容器顺序） */
async function unpackCaptured(call: CapturedPublish): Promise<{
  names: string[];
  data: Uint8Array[];
  manifest: PackManifest;
}> {
  const container = readZipContainer(call.zipBytes);
  const names = container.entries.map((e) => e.name);
  const data: Uint8Array[] = [];
  for (const entry of container.entries) data.push(await inflateZipEntry(entry));
  const at = names.indexOf(MARKET_MANIFEST_FILE);
  if (at < 0) throw new Error('上传的容器里没有 pack.json');
  return { names, data, manifest: JSON.parse(new TextDecoder().decode(data[at]!)) as PackManifest };
}

async function codeOf(promise: Promise<unknown>): Promise<MarketError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(MarketError);
    return err as MarketError;
  }
  throw new Error('本该抛出，结果没有');
}

afterEach(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
  tmps.length = 0;
});

/* ----------------------------------- 判据 ----------------------------------- */

describe('publishPack · 成功路径（产物可被真实解析）', () => {
  it('上传收到的 zip 逐条目对平：pack.json 字段 / files 路径 / 逐文件 sha256 与原始字节', async () => {
    const h = boot();
    const draft = draftOf(
      [
        ['事件.kojo', '如果 A：\n  PRINTL 「口上 A」\n'],
        ['子目录/说明.txt', '原样附带'],
      ],
      { summary: '一封短信', sourceUrl: 'https://example.com/kojo', gameId: 'eratw' },
    );

    const outcome = await h.svc.publishPack!(draft);

    expect(outcome).toMatchObject({ ok: true, prUrl: 'https://github.com/p/pull/42' });
    expect(h.bridge.tokenFetches).toBe(1);
    expect(h.bridge.publishCalls).toHaveLength(1);
    const call = h.bridge.publishCalls[0]!;

    // 上传参数：容器落在自家暂存区（不是域外），概要五字段来自 pack.json
    expect(call.zipPath.startsWith(nodeJoin(h.root, MARKET_STAGING_DIR))).toBe(true);
    expect(call.manifest).toEqual({
      kind: 'kojo-pack',
      id: 'demo.kojo',
      version: '1.0.0',
      name: '演示口上',
      author: '某作者',
    });
    expect(call.token).toBe('dev-token-1');
    expect(call.opts?.endpoint).toBe(MARKET_DEFAULT_PUBLISH_URL);

    // 真解容器：条目顺序 = pack.json → 草案文件顺序
    const { names, data, manifest } = await unpackCaptured(call);
    expect(names).toEqual([
      MARKET_MANIFEST_FILE,
      `${MARKET_CONTENT_DIR}/事件.kojo`,
      `${MARKET_CONTENT_DIR}/子目录/说明.txt`,
    ]);
    expect(manifest.schema).toBe(MARKET_SCHEMA_VERSION);
    expect(manifest.kind).toBe('kojo-pack');
    expect(manifest.id).toBe('demo.kojo');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.name).toBe('演示口上');
    expect(manifest.author).toBe('某作者');
    expect(manifest.license).toBe('MIT');
    expect(manifest.redistribute).toBe(true);
    expect(manifest.summary).toBe('一封短信');
    expect(manifest.sourceUrl).toBe('https://example.com/kojo');
    expect(manifest.gameId).toBe('eratw');

    // 逐文件锚：路径带 files/ 前缀、字节 = 原始字节、sha256 = 原始字节的 sha256
    expect(manifest.files.map((f) => f.path)).toEqual([
      `${MARKET_CONTENT_DIR}/事件.kojo`,
      `${MARKET_CONTENT_DIR}/子目录/说明.txt`,
    ]);
    for (let i = 0; i < manifest.files.length; i++) {
      const original = draft.files[i]!;
      expect(manifest.files[i]!.bytes).toBe(original.bytes.length);
      expect(manifest.files[i]!.sha256).toBe(await sha256Hex(original.bytes));
      expect(data[i + 1]).toEqual(original.bytes);
    }

    // 与导出链路同一条往返自证：写出去的东西读得回来
    expect(
      await verifyZipRoundtrip(
        call.zipBytes,
        names.map((name, i) => ({ name, data: data[i]! })),
      ),
    ).toBeNull();

    // 暂存区零残壳（草案容器 + 预校验痕迹全清）
    expect(stagedLeftovers(h.root)).toEqual([]);
  });

  it('minAppVersion 缺省 = 应用版本核心三段；显式给了原样透传，过高由共享闸拒', async () => {
    const h = boot();
    await h.svc.publishPack!(draftOf([['a.erb', 'PRINTL A\n']]));
    const first = await unpackCaptured(h.bridge.publishCalls[0]!);
    expect(first.manifest.minAppVersion).toBe('0.4.0');

    await h.svc.publishPack!(draftOf([['a.erb', 'PRINTL A\n']], { minAppVersion: '0.3.0' }));
    const second = await unpackCaptured(h.bridge.publishCalls[1]!);
    expect(second.manifest.minAppVersion).toBe('0.3.0');

    // 比当前应用还高的要求：走**同一条** parseManifest 闸（安装面同一句人话），不上传
    const err = await codeOf(
      h.svc.publishPack!(draftOf([['a.erb', 'PRINTL A\n']], { minAppVersion: '0.5.0' })),
    );
    expect(err.code).toBe('app-version-too-low');
    expect(h.bridge.publishCalls).toHaveLength(2);
    expect(stagedLeftovers(h.root)).toEqual([]);
  });

  it('进度经服务原样透传（预校验不走 onProgress，上传段逐帧回放）', async () => {
    const h = boot();
    const frames: MarketPublishProgress[] = [
      { sentBytes: 1024, totalBytes: 4096 },
      { sentBytes: 4096, totalBytes: 4096 },
    ];
    h.bridge.frames = frames;
    const seen: MarketPublishProgress[] = [];
    await h.svc.publishPack!(draftOf([['a.erb', 'PRINTL A\n']]), { onProgress: (p) => seen.push(p) });
    expect(seen).toEqual(frames);
  });
});

describe('publishPack · 预校验拒因（零上传，全部来自既有清单校验）', () => {
  it('redistribute:false → redistribute-denied（parseManifest 同一条判定），不上传、不留残壳', async () => {
    const h = boot();
    const err = await codeOf(
      h.svc.publishPack!(draftOf([['a.erb', 'PRINTL A\n']], { redistribute: false })),
    );
    expect(err.code).toBe('redistribute-denied');
    expect(h.bridge.publishCalls).toHaveLength(0);
    expect(stagedLeftovers(h.root)).toEqual([]);
  });

  it('非法 id / version 被既有清单校验拒（id-invalid / version-invalid），不上传', async () => {
    const h = boot();
    const idErr = await codeOf(h.svc.publishPack!(draftOf([['a.erb', 'x\n']], { id: 'Bad Id' })));
    expect(idErr.code).toBe('id-invalid');
    const verErr = await codeOf(h.svc.publishPack!(draftOf([['a.erb', 'x\n']], { version: '1.0' })));
    expect(verErr.code).toBe('version-invalid');
    expect(h.bridge.publishCalls).toHaveLength(0);
    expect(stagedLeftovers(h.root)).toEqual([]);
  });

  it('路径逃逸 / 自带 files/ 前缀 / 重复路径 → 拒在打包之前（同一张拒绝码表）', async () => {
    const h = boot();
    const escape = await codeOf(h.svc.publishPack!(draftOf([['../evil.erb', 'x\n']])));
    expect(escape.code).toBe('path-dotdot');
    const prefixed = await codeOf(h.svc.publishPack!(draftOf([['files/a.erb', 'x\n']])));
    expect(prefixed.code).toBe('path-prefix');
    const duplicate = await codeOf(
      h.svc.publishPack!(draftOf([['a.erb', 'x\n'], ['a.erb', 'y\n']])),
    );
    expect(duplicate.code).toBe('entry-duplicate');
    expect(h.bridge.publishCalls).toHaveLength(0);
    expect(stagedLeftovers(h.root)).toEqual([]);
  });

  it('空包 → content-missing（一个字节都不上传，也不留容器）', async () => {
    const h = boot();
    const err = await codeOf(h.svc.publishPack!(draftOf([])));
    expect(err.code).toBe('content-missing');
    expect(h.bridge.publishCalls).toHaveLength(0);
    expect(stagedLeftovers(h.root)).toEqual([]);
  });
});

describe('publishPack · 临时容器生命周期', () => {
  it('成功与平台故障两条路径都不留草案容器', async () => {
    const h = boot();
    await h.svc.publishPack!(draftOf([['a.erb', 'x\n']]));
    expect(readdirSync(nodeJoin(h.root, MARKET_STAGING_DIR))).toEqual([]);

    h.bridge.publishThrows = '断网';
    await expect(h.svc.publishPack!(draftOf([['a.erb', 'x\n']]))).rejects.toThrow(
      '发布没有成功：断网',
    );
    expect(readdirSync(nodeJoin(h.root, MARKET_STAGING_DIR))).toEqual([]);
  });
});

describe('inspectZip · 普通作品包 zip 的发布预判（ZIP-1）', () => {
  it('市场容器（根 pack.json）→ 原样走 publish 链路，不把内容读进 JS', async () => {
    const h = boot();
    const zip = await buildZip(
      [{ name: MARKET_MANIFEST_FILE, data: bytesOf('{"schema":1}') }],
      { contract: 'generic' },
    );
    const zipPath = nodeJoin(h.root, 'market-container.zip');
    writeFileSync(zipPath, zip);
    const out = await h.svc.inspectZip!(zipPath);
    expect(out).toEqual({ kind: 'market-container', bytes: zip.length });
  });

  it('普通作品包 → 解出文件、跳过目录/系统垃圾、剥掉单层包裹目录', async () => {
    const h = boot();
    const zip = await buildZip(
      [
        { name: 'キャノボ風レティ/', data: new Uint8Array() },
        { name: 'キャノボ風レティ/readme.txt', data: bytesOf('作者：舩 弦五郎\n') },
        { name: 'キャノボ風レティ/主口上.ERB', data: bytesOf('PRINT 1\n') },
        { name: '__MACOSX/._主口上.ERB', data: bytesOf('junk') },
        { name: 'キャノボ風レティ/.DS_Store', data: bytesOf('junk') },
      ],
      { contract: 'generic' },
    );
    const zipPath = nodeJoin(h.root, 'author-package.zip');
    writeFileSync(zipPath, zip);
    const out = await h.svc.inspectZip!(zipPath);
    expect(out.kind).toBe('author-package');
    if (out.kind !== 'author-package') return;
    expect(out.strippedRoot).toBe('キャノボ風レティ');
    expect(out.files.map((f) => f.path)).toEqual(['readme.txt', '主口上.ERB']);
    expect(out.skipped.length).toBe(3);
    expect(out.bytes).toBe(zip.length);
  });

  it('普通作品包没有内容 → content-missing（不进入发布阶段）', async () => {
    const h = boot();
    const zip = await buildZip([{ name: '__MACOSX/._x', data: bytesOf('junk') }], {
      contract: 'generic',
    });
    const zipPath = nodeJoin(h.root, 'empty.zip');
    writeFileSync(zipPath, zip);
    await expect(h.svc.inspectZip!(zipPath)).rejects.toMatchObject({ code: 'content-missing' });
  });
});
