/**
 * Web 调试宿（`tools/debug-server.mjs`）的命令面判据（2026-10-24 调试模式批）。
 *
 * 起真服务（端口 0）用 fetch 打真 HTTP——这层是给「浏览器调试模式」当地基的，
 * 信封 / 帧格式 / 准入语义错了，页面侧的表现就是各种静默错位，必须在宿这一层钉死：
 * 1. `read_files_raw` 二进制帧：**Node 编码 × 页面解码器（`decodeReadFilesFrame`）对拍**——
 *    两份实现以帧格式为唯一真源成对演进（Rust 是第三份），谁漂谁红；
 * 2. 写域 / 读域准入（fail loud，不静默）；
 * 3. 对话框自动应答与 policy 热更；
 * 4. `encode_string` 编码矩阵（shift_jis 显式失败）；
 * 5. `search_text` 的基本语义（大小写 / 正则 / 整词 / 扩展名过滤 / 逐文件三态）；
 * 6. SSE 事件流（文件监视推 `kojo:fs-changed`）；
 * 7. 命令清单对账：页面侧 `invoke(` 用到的每一条命令调试宿都必须实现（新命令进 app
 *    而忘进调试宿时，这里先红而不是浏览器里静默报「没有实现命令」）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createDebugServer, SUPPORTED_COMMANDS } from '../debug-server.mjs';
import { decodeReadFilesFrame } from '../../packages/app/src/bridge/read-files-frame';

let server: Awaited<ReturnType<typeof createDebugServer>>;
let base = '';
let sandbox = '';
let appdata = '';
let outside = '';
const tmpRoot = path.join(os.tmpdir(), `kojo-debug-server-test-${process.pid}`);

async function invoke(cmd: string, args?: Record<string, unknown>) {
  const res = await fetch(`${base}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd, args: args ?? {} }),
  });
  const body = (await res.json()) as { ok: boolean; value?: unknown; error?: string };
  return body;
}

function b64ToBuf(b64: string): ArrayBuffer {
  // 一次解码、显式拷出：Buffer 可能落在共享池里，重复 Buffer.from 三次取偏移会错位（实测坑）
  const buf = Buffer.from(b64, 'base64');
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return ab;
}

beforeAll(async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  sandbox = path.join(tmpRoot, 'sandbox');
  appdata = path.join(tmpRoot, 'appdata');
  outside = path.join(tmpRoot, 'outside');
  for (const d of [sandbox, appdata, outside]) await fs.mkdir(d, { recursive: true });
  server = await createDebugServer({ port: 0, sandbox, appdata, log: () => {} });
  base = `http://127.0.0.1:${server.port}`;
}, 30000);

afterAll(async () => {
  await server.close();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('调试宿 · 基础面', () => {
  it('health / config 可读，命令清单含页面侧全部宿主命令', async () => {
    const health = await (await fetch(`${base}/health`)).json();
    expect(health.ok).toBe(true);
    // 页面侧（app src）invoke 用到的命令名——从源码现场收，不手抄第二份名单
    const appSrcRoot = path.resolve(__dirname, '../../packages/app/src');
    const used = new Set<string>();
    const walk = async (dir: string) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (/\.(ts|tsx)$/.test(e.name)) {
          const src = await fs.readFile(full, 'utf-8');
          for (const m of src.matchAll(/invoke(?:<[^>]*>)?\(\s*['"]([a-z_]+)['"]/g)) used.add(m[1]!);
        }
      }
    };
    await walk(appSrcRoot);
    const missing = [...used].filter((c) => !SUPPORTED_COMMANDS.includes(c));
    expect(missing, `页面用到而调试宿没实现的命令：${missing.join('、')}`).toEqual([]);
    expect(SUPPORTED_COMMANDS.length).toBeGreaterThan(30);
  });

  it('app_data_dir 指向沙盒 appdata', async () => {
    const r = await invoke('app_data_dir');
    expect(r.ok).toBe(true);
    expect(String(r.value)).toBe(appdata);
  });

  it('CORS 预检放行（页面在 vite 端口，跨 origin fetch/SSE 都要过）', async () => {
    const res = await fetch(`${base}/invoke`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('调试宿 · 文件面与准入', () => {
  it('写文件 → 单读 → 批读（帧对拍页面解码器）→ stat 四面同值', async () => {
    const p = path.join(sandbox, 'ERB', 'A.ERB');
    const text = `;first\r\nPRINTL こんにちは\r\n;end`;
    const bytes = Buffer.from(text, 'utf-8');
    const w = await invoke('write_file_bytes', {
      path: p,
      data: bytes.toString('base64'),
    });
    expect(w.ok ?? w.error).toBe(true);

    const single = await invoke('read_file_bytes_raw', { path: p });
    expect(single.ok).toBe(true);
    expect(Buffer.from((single.value as { __b64: string }).__b64, 'base64').equals(bytes)).toBe(true);

    const missing = await invoke('read_file_bytes_raw', { path: path.join(sandbox, 'ERB', '无.ERB') });
    expect(missing.ok).toBe(false);
    expect(String(missing.error)).toContain('文件不存在');

    // 批读帧：Node 编码 → 页面解码器（同一份将来跑在浏览器里的代码）逐字段对拍
    const batch = await invoke('read_files_raw', {
      paths: [p, path.join(sandbox, 'ERB', '无.ERB')],
    });
    expect(batch.ok).toBe(true);
    const frame = b64ToBuf((batch.value as { __b64: string }).__b64);
    const files = decodeReadFilesFrame(frame);
    expect(files).toHaveLength(2);
    expect(files[0]!.status).toBe('ok');
    expect(files[0]!.path).toBe(p);
    expect(Buffer.from(files[0]!.data).equals(bytes)).toBe(true);
    expect(typeof files[0]!.mtimeMs).toBe('number');
    expect(files[0]!.size).toBe(bytes.length);
    expect(files[1]!.status).toBe('not-found');

    const st = await invoke('stat_file', { path: p });
    expect(st.value).toMatchObject({ isDirectory: false, size: bytes.length });
    const sts = await invoke('stat_files', { paths: [p, path.join(sandbox, 'nope')] });
    expect(sts.value).toEqual([
      expect.objectContaining({ exists: true, size: bytes.length }),
      expect.objectContaining({ exists: false, mtimeMs: null }),
    ]);
  });

  it('walk_dir：withMetadata 带元数据、includeDirs/includeFiles 可关', async () => {
    const r = await invoke('walk_dir', {
      path: sandbox,
      opts: { includeFiles: true, includeDirs: true, withMetadata: true },
    });
    const entries = r.value as { path: string; isDirectory: boolean; mtimeMs?: number }[];
    expect(entries.some((e) => e.path.endsWith('A.ERB') && !e.isDirectory && typeof e.mtimeMs === 'number')).toBe(true);
    const onlyDirs = await invoke('walk_dir', { path: sandbox, opts: { includeFiles: false } });
    expect(
      (onlyDirs.value as { isDirectory: boolean }[]).every((e) => e.isDirectory),
    ).toBe(true);
  });

  it('域外读 / 写都被拒（fail loud），且错误带可读原因', async () => {
    const outsideFile = path.join(outside, 'x.txt');
    const w = await invoke('write_file_bytes', { path: outsideFile, data: '' });
    expect(w.ok).toBe(false);
    expect(String(w.error)).toContain('写域外');
    const r = await invoke('read_file_bytes_raw', { path: outsideFile });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('读域外');
  });

  it('注册写域后可写；clear 后再拒（镜像 register_write_domain 语义）', async () => {
    const dir = path.join(appdata, 'proj'); // appdata 本来就可写；换 readonly 场景测注册
    // 用 policy 加一个只读根，然后注册它为写域 → 可写
    await fetch(`${base}/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ readonly: [outside] }),
    });
    const p2 = path.join(outside, 'w.txt');
    const before = await invoke('write_file_bytes', { path: p2, data: Buffer.from('hi').toString('base64') });
    expect(before.ok).toBe(false);
    const reg = await invoke('register_write_domain', { root: outside });
    expect(reg.ok).toBe(true);
    const after = await invoke('write_file_bytes', { path: p2, data: Buffer.from('hi').toString('base64') });
    expect(after.ok).toBe(true);
    await invoke('clear_write_domain');
    const again = await invoke('write_file_bytes', { path: path.join(outside, 'w2.txt'), data: '' });
    expect(again.ok).toBe(false);
  });

  it('rename / copy / remove 走写域判定', async () => {
    const a = path.join(sandbox, 'a.txt');
    const b = path.join(sandbox, 'b.txt');
    await invoke('write_file_bytes', { path: a, data: Buffer.from('A').toString('base64') });
    expect((await invoke('rename_path', { from: a, to: b })).ok).toBe(true);
    expect((await invoke('path_exists', { path: a })).value).toBe(false);
    expect((await invoke('copy_file', { from: b, to: a })).ok).toBe(true);
    expect((await invoke('remove_file', { path: a })).ok).toBe(true);
    expect((await invoke('remove_dir', { path: path.join(sandbox, '不存在的目录') })).ok).toBe(true);
  });
});

describe('调试宿 · 对话框自动应答与导出', () => {
  it('choose_directory 按 policy 应答，policy 可热更，null=取消', async () => {
    expect((await invoke('choose_directory')).value).toBeNull();
    await fetch(`${base}/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chooseDir: sandbox }),
    });
    expect((await invoke('choose_directory')).value).toBe(sandbox);
  });

  it('choose_workspace_root 登记常驻工作区根，workspace_roots 可读回', async () => {
    const root = (await invoke('choose_workspace_root')).value as string;
    expect(root).toBe(sandbox);
    expect(await invoke('workspace_roots')).toMatchObject({ ok: true, value: [sandbox] });
    // 登记后的根变成可读域（outside 已在上一段加过只读根，这里验证 sandbox 常驻根路径可读）
    expect((await invoke('path_exists', { path: path.join(sandbox, 'b.txt') })).value).toBe(true);
  });

  it('export_file 落在 sandbox/exports 并返回全路径（对话框即授权的调试形态）', async () => {
    const r = await invoke('export_file', {
      fileName: 'report.txt',
      data: Buffer.from('导出内容', 'utf-8').toString('base64'),
    });
    expect(r.ok).toBe(true);
    const dest = String(r.value);
    expect(dest.endsWith(path.join('exports', 'report.txt'))).toBe(true);
    expect((await fs.readFile(dest, 'utf-8'))).toBe('导出内容');
  });
});

describe('调试宿 · encode_string 编码矩阵', () => {
  const text = '口上 kojo ＡＢＣ';
  it.each([
    ['utf-8', Buffer.from(text, 'utf-8')],
    ['utf-8-bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf-8')])],
    ['utf-16le', Buffer.concat([Buffer.from([0xff, 0xfe]), (() => { const b = Buffer.alloc(text.length * 2); for (let i = 0; i < text.length; i++) b.writeUInt16LE(text.charCodeAt(i), i * 2); return b; })()])],
  ] as const)('%s 逐字节对拍', async (enc, want) => {
    const r = await invoke('encode_string', { text, encoding: enc });
    expect(r.ok).toBe(true);
    expect(Buffer.from(String(r.value), 'base64').equals(want)).toBe(true);
  });

  it('shift_jis 编码显式失败（Node 无编码器，不静默）', async () => {
    const r = await invoke('encode_string', { text: 'あ', encoding: 'shift_jis' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('shift_jis');
  });
});

describe('调试宿 · search_text', () => {
  beforeAll(async () => {
    await fs.mkdir(path.join(sandbox, 'search'), { recursive: true });
    await fs.writeFile(path.join(sandbox, 'search', 'a.ERB'), 'PRINTL hello\r\nPRINTL Hello World\r\n', 'utf-8');
    await fs.writeFile(path.join(sandbox, 'search', 'b.CSV'), 'hello,row\r\n', 'utf-8');
    await fs.writeFile(path.join(sandbox, 'search', 'c.bin'), Buffer.from([0x00, 0x01]));
  });

  const search = (overrides: Record<string, unknown>) =>
    invoke('search_text', {
      request: {
        searchId: 1,
        roots: [path.join(sandbox, 'search')],
        query: 'hello',
        options: { isRegex: false, caseSensitive: false, wholeWord: false, extensions: [] },
        ...overrides,
      },
    });

  it('默认全搜：a.ERB 两处 + b.CSV 一处，列号=UTF-16 码元+1', async () => {
    const r = await search({});
    expect(r.ok).toBe(true);
    const v = r.value as { files: { path: string; matches: { line: number; column: number }[] }[]; totalMatches: number; filesScanned: number; skipped: { binary: number } };
    expect(v.totalMatches).toBe(3);
    const a = v.files.find((f) => f.path.endsWith('a.ERB'))!;
    expect(a.matches.map((m) => [m.line, m.column])).toEqual([[1, 8], [2, 8]]);
    expect(v.files.find((f) => f.path.endsWith('b.CSV'))).toBeTruthy();
    expect(v.skipped.binary).toBe(1); // c.bin 被跳过且如实计数
  });

  it('大小写敏感：只余小写 hello 的两处；扩展名过滤只扫 CSV', async () => {
    const cs = await search({ options: { isRegex: false, caseSensitive: true, wholeWord: false, extensions: [] } });
    expect((cs.value as { totalMatches: number }).totalMatches).toBe(2); // a.ERB 行1 + b.CSV
    const ext = await search({ options: { isRegex: false, caseSensitive: false, wholeWord: false, extensions: ['csv'] } });
    const v = ext.value as { files: { path: string }[]; skipped: { filtered: number } };
    expect(v.files).toHaveLength(1);
    expect(v.files[0]!.path.endsWith('b.CSV')).toBe(true);
    expect(v.skipped.filtered).toBe(2); // a.ERB 与 c.bin 被过滤并计数
  });

  it('整词模式：hell 不再命中 hello；非整词模式命中 3 处', async () => {
    const ww = await search({ query: 'hell', options: { isRegex: false, caseSensitive: false, wholeWord: true, extensions: [] } });
    expect((ww.value as { totalMatches: number }).totalMatches).toBe(0);
    const plain = await search({ query: 'hell', options: { isRegex: false, caseSensitive: false, wholeWord: false, extensions: [] } });
    expect((plain.value as { totalMatches: number }).totalMatches).toBe(3);
  });

  it('正则模式与非法正则的显式失败', async () => {
    const r = await search({ query: 'hel+o', options: { isRegex: true, caseSensitive: false, wholeWord: false, extensions: [] } });
    expect((r.value as { totalMatches: number }).totalMatches).toBe(3);
    const bad = await search({ query: '(unclosed', options: { isRegex: true, caseSensitive: false, wholeWord: false, extensions: [] } });
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain('正则不合法');
  });
});

describe('调试宿 · search_text 流式重写后的不变量（2026-10-25 性能批）', () => {
  beforeAll(async () => {
    await fs.mkdir(path.join(sandbox, 'stream'), { recursive: true });
  });

  const search2 = (overrides: Record<string, unknown>) =>
    invoke('search_text', {
      request: {
        searchId: 7,
        roots: [path.join(sandbox, 'stream')],
        query: 'needle',
        options: { isRegex: false, caseSensitive: true, wholeWord: false, extensions: [] },
        ...overrides,
      },
    });

  it('roots 在读域外 ⇒ 整批拒（walkFiles 绕过读域的洞已补）', async () => {
    // 用「从未被任何用例登记过」的目录——前面的写域用例会把 outside 加进只读根，复用它就是假绿
    const neverAdmitted = path.join(tmpRoot, 'never-admitted');
    await fs.mkdir(neverAdmitted, { recursive: true });
    const r = await search2({ roots: [neverAdmitted] });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('读域外');
  });

  it('CJK 多字节字符跨读块边界仍正确命中（流式解码 stream:true）', async () => {
    // 在多个潜在块边界（8KB/64KB/128KB/256KB）前 1 字节处放 3 字节 CJK——
    // 无论实际切块落在哪，词都必须整字命中且列号按 UTF-16 码元计
    for (const boundary of [8192, 65536, 131072, 262144]) {
      const file = path.join(sandbox, 'stream', `cjk-${boundary}.ERB`);
      const head = 'a'.repeat(boundary - 1);
      await fs.writeFile(file, Buffer.from(`${head}needle好\r\nPRINTL tail\r\n`), 'utf-8');
    }
    const r = await invoke('search_text', {
      request: {
        searchId: 7,
        roots: [path.join(sandbox, 'stream')],
        query: '好',
        options: { isRegex: false, caseSensitive: true, wholeWord: false, extensions: ['erb'] },
      },
    });
    expect(r.ok).toBe(true);
    const v = r.value as { files: { path: string; matches: { line: number; column: number }[] }[]; skipped: { filtered: number } };
    expect(v.files).toHaveLength(4); // 四个边界文件全部命中
    for (const f of v.files) {
      const boundary = Number(/cjk-(\d+)\.ERB$/.exec(f.path)?.[1] ?? 0);
      expect(f.matches).toHaveLength(1);
      expect(f.matches[0]!.line).toBe(1);
      expect(f.matches[0]!.column).toBe(boundary + 6); // (boundary−1) 个 'a' + 6 字符 'needle' ⇒ 0 基索引 boundary+5，列号 +1
    }
    expect(v.skipped.filtered).toBe(0);
  });

  it('CRLF 跨块边界不产生幽灵行 / 丢行', async () => {
    for (const boundary of [8192, 65536, 131072]) {
      const file = path.join(sandbox, 'stream', `crlf-${boundary}.ERB`);
      const head = 'a'.repeat(boundary - 1);
      await fs.writeFile(file, Buffer.from(`${head}\r\nPRINTL needle\r\nPRINTL tail\r\n`), 'utf-8');
    }
    const r = await invoke('search_text', {
      request: {
        searchId: 7,
        roots: [path.join(sandbox, 'stream')],
        query: 'needle',
        options: { isRegex: false, caseSensitive: true, wholeWord: false, extensions: ['erb'] },
      },
    });
    const v = r.value as { files: { path: string; matches: { line: number }[] }[] };
    const crlfFiles = v.files.filter((f) => f.path.includes('crlf-'));
    expect(crlfFiles).toHaveLength(3);
    for (const f of crlfFiles) {
      expect(f.matches).toHaveLength(1);
      expect(f.matches[0]!.line).toBe(2); // 第二行命中；\r\n 被跨块拆开也不许多出一行
    }
  });

  it('超 8MB 文件按 tooLarge 跳过（流式截断，不整文件读入）', async () => {
    const big = path.join(sandbox, 'stream', 'big.ERB');
    await fs.writeFile(big, Buffer.alloc(8 * 1024 * 1024 + 1024, 0x61)); // 'a' × ~8MB
    const r = await search2({});
    expect(r.ok).toBe(true);
    const v = r.value as { files: { path: string }[]; skipped: { tooLarge: number } };
    expect(v.skipped.tooLarge).toBeGreaterThanOrEqual(1);
    expect(v.files.find((f) => f.path.endsWith('big.ERB'))).toBeUndefined(); // 没命中也没被整读
    await fs.rm(big, { force: true });
  }, 30000);

  it('无换行巨行触发行缓冲护栏（tooLarge），内存上限 O(最长行) 的兜底', async () => {
    const oneline = path.join(sandbox, 'stream', 'oneline.ERB');
    await fs.writeFile(oneline, Buffer.alloc(4 * 1024 * 1024 + 1024, 0x62)); // 单行 4MB+ 无换行
    const r = await search2({});
    expect(r.ok).toBe(true);
    expect((r.value as { skipped: { tooLarge: number } }).skipped.tooLarge).toBeGreaterThanOrEqual(1);
    await fs.rm(oneline, { force: true });
  }, 30000);
});

describe('调试宿 · 命令分发与限额的自审加固（2026-10-25 性能批）', () => {
  it('原型链上的名字（constructor / __proto__ / hasOwnProperty）不当作命令执行，宿仍健康', async () => {
    for (const evil of ['constructor', '__proto__', 'hasOwnProperty', 'toString']) {
      const r = await invoke(evil, {});
      expect(r.ok, `命令 ${evil} 不该被分发`).toBe(false);
      expect(String(r.error)).toContain('没有实现命令');
    }
    const health = await (await fetch(`${base}/health`)).json();
    expect(health.ok).toBe(true);
  });

  it('export_file 文件名为 .. ⇒ 拒（不落沙盒根）', async () => {
    const r = await invoke('export_file', { fileName: '..', data: '' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('文件名不合法');
  });

  it('read_files_raw 单批超 32 MiB ⇒ fail-loud（信封放大前拦下）', async () => {
    const big = path.join(sandbox, 'big-batch.bin');
    await fs.writeFile(big, Buffer.alloc(33 * 1024 * 1024, 0x61));
    const r = await invoke('read_files_raw', { paths: [big] });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('超上限');
    await fs.rm(big, { force: true });
  }, 60000);
});

describe('调试宿 · SSE 事件流（文件监视）', () => {
  it('start_watch 后写文件，SSE 推 kojo:fs-changed', async () => {
    const watched = path.join(sandbox, 'watch-dir');
    await fs.mkdir(watched, { recursive: true });
    const controller = new AbortController();
    const res = await fetch(`${base}/events`, { signal: controller.signal });
    expect(res.ok).toBe(true);
    const reader = res.body!.getReader();
    const start = await invoke('start_watch', { paths: [watched] });
    expect(start.value).toMatchObject({ watched: [watched] });
    await fs.writeFile(path.join(watched, 'x.ERB'), 'PRINTL w', 'utf-8');
    const text = await new Promise<string>((resolve, reject) => {
      let acc = '';
      const timer = setTimeout(() => reject(new Error(`SSE 10s 没等到 fs-changed；已收：${acc}`)), 10000);
      void (async () => {
        try {
          const dec = new TextDecoder();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            acc += dec.decode(value);
            if (acc.includes('kojo:fs-changed') && acc.includes('x.ERB')) {
              clearTimeout(timer);
              resolve(acc);
              return;
            }
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
    expect(text).toContain('kojo:fs-changed');
    controller.abort();
    await invoke('stop_watch');
  }, 20000);
});

describe('调试宿 · 网络命令 fail-closed', () => {
  it.each(['market_fetch_text', 'market_download', 'market_extract', 'market_publish', 'market_device_token'])(
    '%s 显式失败且带人话原因',
    async (cmd) => {
      const r = await invoke(cmd, {});
      expect(r.ok).toBe(false);
      expect(String(r.error)).toContain('调试宿不支持');
    },
  );

  it('updater_env_proxy 答 null（与桌面壳「未设置」同形）', async () => {
    expect(await invoke('updater_env_proxy')).toMatchObject({ ok: true, value: null });
  });

  it('append_frontend_log 落到 appdata/kojo-logs', async () => {
    const r = await invoke('append_frontend_log', { level: 'error', message: '冒烟：前端错误', detail: '栈' });
    expect(r.ok).toBe(true);
    const dir = path.join(appdata, 'kojo-logs');
    const files = await fs.readdir(dir);
    expect(files.some((f) => f.startsWith('frontend-'))).toBe(true);
    const content = await fs.readFile(path.join(dir, files[0]!), 'utf-8');
    expect(content).toContain('冒烟：前端错误');
  });
});
