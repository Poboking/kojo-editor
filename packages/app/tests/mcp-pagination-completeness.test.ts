/**
 * MCP 分页游标批（B1）· 完整性自证
 *
 * 这批的核心不是「多加两个入参」，而是**分页结果可自证完整**。四条判据逐条钉死：
 * 1. **逐页拼接 == 全文**：真语料大文件（>200K 字符）走 `fs.readFile` 具名工具腿，按
 *    `nextCursor` 一页页取，拼起来与一次性读到的正文**逐字符相等**；语料不在盘时用
 *    30 万字符夹具跑同一断言（回执写清用了什么、多大），绝不让这条静默消失。
 * 2. **翻页期间数据变了必须出声**：列举面钉「全页并集 == 全集，无重无漏」；快照在页间
 *    变化 ⇒ 显式 `changedDuringPaging:true` 且从第 0 页重发（绝不静默漏条 / 重复条）。
 * 3. **游标失效 / 越界 / 形状非法**一律显式 `INVALID_ARGS` + 可执行提示，
 *    绝不回空数组冒充「到底了」、绝不 `as` 兜底成 0。
 * 4. **上限仍是上限**（逐条自证，一个没放宽）：文本面单页压在宿主不可信串闸 64Ki 之下，
 *    列举面各自 clamp 到本批之前的硬闸值；检索撞引擎墙（5000）时在窗内可续、
 *    见底处显式 `hasMore:false` + `engineWallReached:true` + `knownTotal:false` + note 指路。
 *
 * 全程假注入（fake kernel / invoke / searchInFiles），不起 GUI、不起 Tauri、不起 HTTP；
 * 形状沿用 `mcp-real-sources.test.ts`，语料只读不写。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HOST_UNTRUSTED_STRING_GATE,
  McpFailure,
  RESOURCE_ITEM_LIMIT,
  RESOURCE_TEXT_LIMIT,
  encodePageCursor,
  pageFingerprint,
  type McpSessionScope,
} from '@kojo/mcp-host';
import type { CommandEntry } from '../src/ui/commands';
import {
  MCP_PAGE_TEXT_DEFAULT_CHARS,
  MCP_PAGE_TEXT_MAX_CHARS,
  createKernelIo,
  createRunSupplemental,
  type McpInvokeLike,
  type McpIoDeps,
  type McpKernelLike,
  type McpSearchRequestLike,
  type McpSearchResultLike,
} from '../src/mcp/real-sources-io';

/* ------------------------------- 假件 ------------------------------- */

const ROOT = 'D:\\proj';

const scope: McpSessionScope = {
  sessionId: 'page-s1',
  clientId: 'page-c1',
  tier: 'read',
  approvedRoots: [ROOT],
  approvedTools: [],
};

function fakeKernel(walkDir?: McpKernelLike['io']['walkDir']): McpKernelLike {
  return {
    project: {
      current: () => ({
        rootDir: ROOT,
        adapterId: 'adapter-a',
        kojoPaths: [`${ROOT}\\k`],
        charaIndex: new Map([[1, { no: 1, name: 'a' }]]),
      }),
    },
    io: { walkDir: walkDir ?? (async () => [{ name: 'a.kojo', path: `${ROOT}\\a.kojo`, isDirectory: false }]) },
    plugins: { list: () => [] },
    services: { tryGet: <T = unknown>(_key: string): T | undefined => undefined },
    bus: { on: (_name: string, _cb: (payload: unknown) => void) => () => {} },
    slots: { query: () => [] },
  };
}

function searchResult(count: number, mutated = false, truncated = false): McpSearchResultLike {
  return {
    files: [
      {
        path: `${ROOT}\\x.kojo`,
        matches: Array.from({ length: count }, (_, i) => ({
          line: i + 1,
          preview: `hit ${i}${mutated ? '!' : ''}`,
        })),
      },
    ],
    totalMatches: count,
    truncated,
    filesScanned: 1,
    elapsedMs: 2,
    skipped: {},
  };
}

function listDirSource(count: number, tag = ''): McpInvokeLike {
  return async (cmd: string): Promise<unknown> =>
    cmd === 'list_dir'
      ? Array.from({ length: count }, (_, i) => ({
          name: `f${i}${tag}.erb`,
          path: `${ROOT}\\f${i}${tag}.erb`,
          isDirectory: false,
        }))
      : null;
}

interface DepsOverrides {
  readonly kernel?: McpKernelLike | null;
  readonly invoke?: McpInvokeLike;
  readonly commands?: readonly CommandEntry[];
  readonly searchInFiles?: (request: McpSearchRequestLike) => Promise<McpSearchResultLike>;
}

function ioDeps(over: DepsOverrides = {}): McpIoDeps {
  return {
    getKernel: () => ('kernel' in over ? over.kernel : fakeKernel()) ?? null,
    getCommands: () =>
      over.commands ??
      [{ id: 'a.open', title: 'A', run: () => undefined }, { id: 'b.save', title: 'B', run: () => undefined }],
    invoke: over.invoke ?? (async () => 'alpha\nbeta\n'),
    searchInFiles: over.searchInFiles ?? (async () => searchResult(0)),
  };
}

/** 只读具名工具腿调用器（fs.readFile / io.listDir / commands.list / workspace.searchAll）。 */
function sup(over: DepsOverrides = {}) {
  const run = createRunSupplemental(ioDeps(over));
  return (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
    run(name, args, scope) as Promise<Record<string, unknown>>;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
}

function arr(v: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(v) ? (v as readonly Record<string, unknown>[]) : [];
}

function readFileSyncLeg(text: string): McpInvokeLike {
  return async (cmd: string): Promise<unknown> => (cmd === 'read_file_bytes' ? text : null);
}

/* ------------------------------- 语料腿（只读） ------------------------------- */

const CORPUS = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;

/** 语料 `ERB/` 树里最大的文本文件（真数据，一个字节都不改）。 */
function largestCorpusFile(): { readonly path: string; readonly text: string } | null {
  if (!CORPUS) return null;
  const base = join(CORPUS, 'ERB');
  if (!existsSync(base)) return null;
  let best: { path: string; text: string } | null = null;
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (st.isFile() && /\.(erb|kojo|txt)$/i.test(name) && st.size > 100_000) {
        const text = readFileSync(full, 'utf8');
        if (best === null || text.length > best.text.length) best = { path: full, text };
      }
    }
  };
  walk(base, 0);
  return best;
}

const CORPUS_FILE = largestCorpusFile();
const REAL_BIG_FILE = CORPUS_FILE !== null && CORPUS_FILE.text.length > 200_000 ? CORPUS_FILE : null;

/** 30 万字符确定性夹具（语料不在盘时的兜底自证，同样 >200K 字符）。 */
function fixtureText(targetChars: number): string {
  const unit = '口上行：A 0123456789; 注释\t半角と全角\n';
  let out = '';
  while (out.length < targetChars) out += unit + out.length.toString(36) + '\n';
  return out.slice(0, targetChars);
}

/**
 * 沿 `nextCursor` 把文本面取到见底：返回拼接结果 + 逐页账目。
 * 停止条件只用 hasMore/nextCursor；页数上限防死循环（见底不了＝完整性账坏了）。
 */
async function drainTextPages(
  call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
  firstArgs: Record<string, unknown>,
): Promise<{ readonly joined: string; readonly pages: readonly string[]; readonly accounts: readonly Record<string, unknown>[] }> {
  const pages: string[] = [];
  const accounts: Record<string, unknown>[] = [];
  let args = firstArgs;
  for (let i = 0; i < 5000; i += 1) {
    const r = await call('fs.readFile', args);
    accounts.push(r);
    pages.push(str(r['text']));
    if (r['hasMore'] !== true) {
      expect(r['nextCursor']).toBeNull();
      return { joined: pages.join(''), pages, accounts };
    }
    args = { ...firstArgs, cursor: str(r['nextCursor']) };
  }
  throw new Error('分页未见底（hasMore 永真）：完整性账坏了');
}

/* ------------------------------- 判据 1 ------------------------------- */

describe('判据 1 · 逐页拼接与一次性读全逐字符相等', () => {
  const itCorpus = REAL_BIG_FILE === null ? it.skip : it;
  itCorpus(`真语料大文件走 fs.readFile 游标腿：拼接 == 全文（${REAL_BIG_FILE === null ? '语料不在盘' : `${REAL_BIG_FILE.path.replace(/^.*[\\/]/, '')} ${REAL_BIG_FILE.text.length} 字符`}）`, async () => {
    const file = REAL_BIG_FILE!;
    const call = sup({ invoke: readFileSyncLeg(file.text) });
    const { joined, pages, accounts } = await drainTextPages(call, { relPath: 'ERB/big.erb', limit: 8192 });
    expect(joined).toBe(file.text);
    expect(pages.length).toBeGreaterThan(20);
    const fp = str(accounts[0]!['fingerprint']);
    for (const a of accounts) {
      expect(str(a['fingerprint'])).toBe(fp);
      // 文本面的「真实全量」字段名沿用旧口径 textLength（契约面 PAGE_ACCOUNT_NOTE 已写明这一拼法）。
      expect(num(a['textLength'])).toBe(file.text.length);
      expect(str(a['text']).length).toBeLessThanOrEqual(8192);
    }
    const last = accounts[accounts.length - 1]!;
    expect(last['hasMore']).toBe(false);
    expect(last['nextCursor']).toBeNull();
    // `truncated` 口径沿用旧版＝「本页没把全量都呈现」（见底与否由 hasMore 说），逐页自证一致。
    expect(last['truncated']).toBe(num(last['textLength']) > str(last['text']).length);
    expect(str(last['changedDuringPaging'])).toBe('');
    expect(num(last['offset']) + str(last['text']).length).toBe(file.text.length);
  });

  it('语料不在盘 ⇒ 30 万字符夹具跑同一条拼接等值断言（兜底不缺席）', async () => {
    const text = fixtureText(300_000);
    const call = sup({ invoke: readFileSyncLeg(text) });
    for (const limit of [4096, 65_000]) {
      const { joined, accounts } = await drainTextPages(call, { relPath: 'a.kojo', limit });
      expect(joined).toBe(text);
      expect(num(accounts[0]!['textLength'])).toBe(text.length);
    }
  });

  it('零参调用与旧行为逐字一致：默认页＝旧 24000 上限，账目自洽', async () => {
    const text = fixtureText(60_000);
    const call = sup({ invoke: readFileSyncLeg(text) });
    const r = await call('fs.readFile', { relPath: 'a.kojo' });
    expect(str(r['text'])).toBe(text.slice(0, MCP_PAGE_TEXT_DEFAULT_CHARS));
    expect(num(r['textLength'])).toBe(text.length);
    expect(r['truncated']).toBe(true);
    expect(r['hasMore']).toBe(true);
    expect(MCP_PAGE_TEXT_DEFAULT_CHARS).toBe(RESOURCE_TEXT_LIMIT);
  });

  it('旧别名 maxChars 仍是页大小入参（保留，不删不改口径）', async () => {
    const text = fixtureText(300_000);
    const call = sup({ invoke: readFileSyncLeg(text) });
    const legacy = await call('fs.readFile', { relPath: 'a.kojo', maxChars: 500 });
    expect(str(legacy['text'])).toBe(text.slice(0, 500));
    expect(str(legacy['nextCursor'])).toBe(encodePageCursor(pageFingerprint([text]), 500));
  });

  it('裸 offset（无游标）窗口起点自洽：从该偏移翻页的拼接 == 该偏移起的全文', async () => {
    const text = fixtureText(50_000);
    const call = sup({ invoke: readFileSyncLeg(text) });
    const { joined } = await drainTextPages(call, { relPath: 'a.kojo', offset: 12_345, limit: 4096 });
    expect(joined).toBe(text.slice(12_345));
  });
});

/* ------------------------------- 判据 2 ------------------------------- */

describe('判据 2 · 翻页期间数据变了要出声，且全页并集 == 全集', () => {
  it('列举面稳定快照：逐页取满 ⇒ 并集与全集同序同长，无重无漏', async () => {
    const call = sup({ invoke: listDirSource(1200) });
    const flat: string[] = [];
    let cursor = '';
    let args: Record<string, unknown> = { relPath: '', limit: 37 };
    let pages = 0;
    let total = Number.NaN;
    for (;;) {
      const r = await call('io.listDir', args);
      total = num(r['total']);
      flat.push(...arr(r['entries']).map((e) => str(e['path'])));
      pages += 1;
      if (r['hasMore'] !== true) {
        expect(r['nextCursor']).toBeNull();
        break;
      }
      const next = str(r['nextCursor']);
      expect(next).not.toBe(cursor);
      cursor = next;
      args = { relPath: '', limit: 37, cursor };
      if (pages > 200) throw new Error('未见底：hasMore 永真');
    }
    expect(total).toBe(1200);
    expect(flat.length).toBe(1200);
    expect(new Set(flat).size).toBe(1200);
    expect(flat).toEqual(Array.from({ length: 1200 }, (_, i) => `f${i}.erb`));
  });

  it('列举面快照在页间变化 ⇒ changedDuringPaging:true 且从第 0 页重发', async () => {
    let count = 500;
    const call = sup({ invoke: () => listDirCount(count) });
    const first = await call('io.listDir', { relPath: '', limit: 100 });
    expect(first['hasMore']).toBe(true);
    count = 501; // 翻页期间外部新增一条
    const next = await call('io.listDir', { relPath: '', limit: 100, cursor: str(first['nextCursor']) });
    expect(next['changedDuringPaging']).toBe(true);
    expect(num(next['offset'])).toBe(0);
    expect(num(next['total'])).toBe(501);
    expect(arr(next['entries'])[0]).toEqual({ name: 'f0.erb', path: 'f0.erb', isDirectory: false });
    // 出声之后从头部重翻，仍可自证完整
    const again = await call('io.listDir', { relPath: '', limit: 501 });
    expect(again['hasMore']).toBe(false);
    expect(num(again['total'])).toBe(501);
  });

  it('文本面快照在页间变化 ⇒ changedDuringPaging + note，绝不盲切旧偏移', async () => {
    const text = fixtureText(50_000);
    const changed = fixtureText(50_001); // 前缀相同、快照不同：指纹必须兜住尾部变化
    let current = text;
    const call = sup({ invoke: async (cmd: string) => (cmd === 'read_file_bytes' ? current : null) });
    const first = await call('fs.readFile', { relPath: 'a.kojo', limit: 4096 });
    expect(first['changedDuringPaging']).toBeUndefined();
    current = changed;
    const second = await call('fs.readFile', { relPath: 'a.kojo', limit: 4096, cursor: str(first['nextCursor']) });
    expect(second['changedDuringPaging']).toBe(true);
    expect(num(second['offset'])).toBe(0);
    expect(str(second['note'])).toContain('不可与旧页拼接');
    // 从头重翻仍可自证完整
    const { joined } = await drainTextPages(call, { relPath: 'a.kojo', limit: 4096 });
    expect(joined).toBe(changed);
  });

  it('检索面命中集在页间变化 ⇒ changedDuringPaging 显式出声并回到窗头', async () => {
    let mutated = false;
    const call = sup({ searchInFiles: async () => searchResult(120, mutated) });
    const first = await call('workspace.searchAll', { query: 'hit', limit: 50 });
    expect(first['hasMore']).toBe(true);
    mutated = true;
    const next = await call('workspace.searchAll', { query: 'hit', limit: 50, cursor: str(first['nextCursor']) });
    expect(next['changedDuringPaging']).toBe(true);
    expect(num(next['offset'])).toBe(0);
    expect(arr(next['hits']).length).toBe(50);
  });
});

async function listDirCount(count: number): Promise<unknown> {
  return Array.from({ length: count }, (_, i) => ({
    name: `f${i}.erb`,
    path: `${ROOT}\\f${i}.erb`,
    isDirectory: false,
  }));
}

/* ------------------------------- 判据 3 ------------------------------- */

describe('判据 3 · 游标失效 / 越界 / 形状非法一律显式报错', () => {
  const BAD: readonly [string, unknown][] = [
    ['纯文本', 'not-a-cursor'],
    ['非十六进制指纹', 'ZZZZ1234:1'],
    ['指纹位数不足', 'abcd123:1'],
    ['缺下标', 'abcd1234:'],
    ['负下标', 'abcd1234:-1'],
    ['下标非数字', 'abcd1234:1x'],
    ['多余段', 'abcd1234:1:2'],
    ['空串', ''],
    ['数字而非串', 12345],
    ['对象而非串', { fingerprint: 'abcd1234', index: 1 }],
  ];

  it.each(BAD)('fs.readFile 游标形状非法（%s）⇒ INVALID_ARGS + 可执行提示，绝不回第一页冒充连续', async (_label, cursor) => {
    const call = sup();
    await expect(call('fs.readFile', { relPath: 'a.kojo', cursor })).rejects.toThrow(McpFailure);
    await expect(call('fs.readFile', { relPath: 'a.kojo', cursor })).rejects.toThrow(/cursor 形状不合法/);
  });

  it.each(BAD)('commands.list 游标形状非法（%s）⇒ 同一口径显式报错', async (_label, cursor) => {
    await expect(sup()('commands.list', { cursor })).rejects.toThrow(/cursor 形状不合法/);
  });

  it('游标下标越界（形状合法、超出正文长度）⇒ 显式 INVALID_ARGS，不回空页冒充到底', async () => {
    const text = 'alpha\nbeta\n';
    const call = sup({ invoke: readFileSyncLeg(text) });
    const first = await call('fs.readFile', { relPath: 'a.kojo', limit: 5 });
    const tampered = `${str(first['fingerprint'])}:${text.length + 5}`;
    await expect(call('fs.readFile', { relPath: 'a.kojo', limit: 5, cursor: tampered })).rejects.toThrow(/越界/);
  });

  it('列举面游标越界同样显式报错', async () => {
    const call = sup({ invoke: listDirSource(10) });
    const first = await call('io.listDir', { relPath: '', limit: 3 });
    const tampered = `${str(first['fingerprint'])}:999`;
    await expect(call('io.listDir', { relPath: '', limit: 3, cursor: tampered })).rejects.toThrow(/越界/);
  });

  it('裸 offset 给成负数 / 非数字 ⇒ 夹到 0 起，账目仍自洽（不做连续性保证的口径见契约面注释）', async () => {
    const text = 'alpha\nbeta\n';
    const call = sup({ invoke: readFileSyncLeg(text) });
    for (const offset of [-9, Number.NaN]) {
      const r = await call('fs.readFile', { relPath: 'a.kojo', limit: 5, offset });
      expect(num(r['offset'])).toBe(0);
      expect(str(r['text'])).toBe(text.slice(0, 5));
      expect(r['hasMore']).toBe(true);
    }
  });
});

/* ------------------------------- 判据 4 ------------------------------- */

describe('判据 4 · 上限仍是上限（本批一个没放宽）', () => {
  it('闸值逐字钉住：文本 24000 / 条目 200 / 宿主不可信串 64Ki / 单页压在 64Ki 之下', () => {
    expect(RESOURCE_TEXT_LIMIT).toBe(24_000);
    expect(RESOURCE_ITEM_LIMIT).toBe(200);
    expect(HOST_UNTRUSTED_STRING_GATE).toBe(64 * 1024);
    expect(MCP_PAGE_TEXT_MAX_CHARS).toBe(65_000);
    // 单页压在 Rust 闸下：JS 报的账就是客户端收到的（否则「拼接==全文」在边界上必假）。
    expect(MCP_PAGE_TEXT_MAX_CHARS).toBeLessThan(HOST_UNTRUSTED_STRING_GATE);
  });

  it('limit 传天大也只到本面已有上限（逐面 clamp）', async () => {
    const text = fixtureText(200_000);
    const textCall = sup({ invoke: readFileSyncLeg(text) });
    const page = await textCall('fs.readFile', { relPath: 'a.kojo', limit: 5_000_000 });
    expect(str(page['text']).length).toBe(MCP_PAGE_TEXT_MAX_CHARS);

    const cmdCall = sup({
      commands: Array.from({ length: 900 }, (_, i) => ({ id: `c${i}`, title: `T${i}`, run: () => undefined })) as readonly CommandEntry[],
    });
    const cmds = await cmdCall('commands.list', { limit: 5_000_000 });
    expect(arr(cmds['commands']).length).toBe(500);
    expect(num(cmds['total'])).toBe(900);

    const dirCall = sup({ invoke: listDirSource(6000) });
    const dirs = await dirCall('io.listDir', { relPath: '', limit: 5_000_000 });
    expect(arr(dirs['entries']).length).toBe(5000);

    const treeIo = createKernelIo(ioDeps({ kernel: fakeKernel(listDirSourceForTree(6000)) }));
    const treeOut = (await treeIo.fileTree({ limit: 5_000_000 }, scope)) as Record<string, unknown>;
    expect(arr(treeOut['entries']).length).toBe(5000);
    expect(num(treeOut['total'])).toBe(6000);

    const searchCall = sup({ searchInFiles: async () => searchResult(5000, false, true) });
    const hits = await searchCall('workspace.searchAll', { query: 'hit', limit: 5_000_000 });
    expect(arr(hits['hits']).length).toBe(200);
  });

  it('检索撞引擎墙（5000）：窗内可续、见底处三件套 + note 指路，不假称能越墙', async () => {
    const call = sup({ searchInFiles: async () => searchResult(5000, false, true) });
    const first = await call('workspace.searchAll', { query: 'hit', limit: 200 });
    expect(first['hasMore']).toBe(true);
    expect(first['knownTotal']).toBe(false);
    expect(first['engineWallReached']).toBe(true);
    const flat: string[] = [];
    let args: Record<string, unknown> = { query: 'hit', limit: 200 };
    let last: Record<string, unknown> = first;
    for (let i = 0; i < 40; i += 1) {
      last = i === 0 ? first : await call('workspace.searchAll', args);
      flat.push(...arr(last['hits']).map((h) => `${str(h['path'])}|${String(h['line'])}|${str(h['preview'])}`));
      if (last['hasMore'] !== true) break;
      args = { query: 'hit', limit: 200, cursor: str(last['nextCursor']) };
    }
    expect(last['hasMore']).toBe(false);
    expect(last['nextCursor']).toBeNull();
    expect(last['engineWallReached']).toBe(true);
    expect(last['knownTotal']).toBe(false);
    expect(last['truncated']).toBe(true);
    expect(flat.length).toBe(5000);
    expect(new Set(flat).size).toBe(5000);
    expect(str(last['note'])).toContain('5000');
    expect(str(last['note'])).toContain('fs.readFile');
  });

  it('完整性账是账不是装饰：每个分页面零参调用即带全套字段', async () => {
    const common = ['offset', 'limit', 'truncated', 'hasMore', 'nextCursor', 'fingerprint'];
    const readFile = await sup({ invoke: readFileSyncLeg(fixtureText(9000)) })('fs.readFile', { relPath: 'a.kojo' });
    // 文本面全量字段沿用旧名 textLength（＝该面的 total），列举面用 total：两套都逐条点名，不放过缺账。
    expect(Object.keys(readFile)).toContain('textLength');
    for (const k of common) expect(Object.keys(readFile)).toContain(k);
    const cmds = await sup()('commands.list', {});
    for (const k of [...common, 'total']) expect(Object.keys(cmds)).toContain(k);
    const dirs = await sup({ invoke: listDirSource(3) })('io.listDir', { relPath: '' });
    for (const k of [...common, 'total']) expect(Object.keys(dirs)).toContain(k);
    const roots = await sup({ invoke: async () => ['D:/proj', 'D:/lib'] })('io.workspaceRoots', {});
    for (const k of [...common, 'total']) expect(Object.keys(roots)).toContain(k);
    const hits = await sup({ searchInFiles: async () => searchResult(300) })('workspace.searchAll', { query: 'hit' });
    // 检索面的快照指纹不单独回显（它编在 nextCursor 里＝已消费前缀指纹），
    // 因此账字段是 common-minus-fingerprint + total/knownTotal。
    for (const k of ['offset', 'limit', 'truncated', 'hasMore', 'nextCursor', 'total', 'knownTotal']) {
      expect(Object.keys(hits)).toContain(k);
    }
    expect(str(hits['nextCursor'])).toMatch(/^[0-9a-f]{8}:\d+$/);
    const tree = (await createKernelIo(ioDeps({ kernel: fakeKernel(listDirSourceForTree(30)) })).fileTree({}, scope)) as Record<string, unknown>;
    for (const k of [...common, 'total']) expect(Object.keys(tree)).toContain(k);
  });
});

function listDirSourceForTree(count: number): McpKernelLike['io']['walkDir'] {
  return async () =>
    Array.from({ length: count }, (_, i) => ({
      name: `f${i}.erb`,
      path: `${ROOT}\\f${i}.erb`,
      isDirectory: false,
    }));
}
