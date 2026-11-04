/**
 * `tools/kojo-mcp-headless.mjs` 的注入 seam 护栏（P5 / 路 B 第二波）。
 *
 * 全部经 `createHeadlessServer({ kernel })` 注入**假 kernel**：不发真实 stdio、不真写盘、
 * 不起 WebView/Monaco/Rust。覆盖：只读默认 + 写能力默认关闭 + 域外写被拒 +
 * 客户端/初始化未授权显式报错 + 零外部依赖 + 只读 kernel 四条腿（内存 fs）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseArgs,
  isPathWithin,
  validateArgs,
  renderResourceText,
  createNodeKernel,
  createHeadlessServer,
  HEADLESS_READ_TOOL_SPECS,
  HEADLESS_WRITE_TOOL_SPECS,
  RELATIVE_PATH_PATTERN,
} from '../kojo-mcp-headless.mjs';

const projectRoot = path.resolve('/proj');
const approvedRoot = path.join(projectRoot, 'allowed');

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { clientInfo: { name: 'test-client', version: '1' } },
};

/** 假 kernel：读腿返回固定读数；写腿只计数（绝不碰盘）。 */
function fakeKernel() {
  const calls = { write: 0, remove: 0, rename: 0 };
  return {
    calls,
    async projectInfo() {
      return { projectRoot, fileCount: 1, packageName: 'demo' };
    },
    async fileTree() {
      return { root: projectRoot, entries: [], total: 0, truncated: false };
    },
    async searchAll(args) {
      return { query: args.query, hits: [{ path: 'a', line: 1, preview: 'hit' }], total: 1, truncated: false };
    },
    async diagnostics() {
      return { items: [{ rule: 'trailing-whitespace', message: 'x', path: 'a', line: 1 }], total: 1, truncated: false };
    },
    async writeFile(target, content) {
      calls.write++;
      return { written: target, chars: String(content).length };
    },
    async remove(target) {
      calls.remove++;
      return { removed: target };
    },
    async rename(from, to) {
      calls.rename++;
      return { from, to };
    },
  };
}

const writeCall = (args, id = 4) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'fs.write', arguments: args },
});

/* ============================ 零外部依赖 ============================ */

describe('零外部 npm 依赖 / 不依赖 WebView·Monaco·Rust', () => {
  it('所有 import 均为 node:* 内置模块', () => {
    const src = readFileSync(new URL('../kojo-mcp-headless.mjs', import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^import .* from ['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec.startsWith('node:')).toBe(true);
  });
});

/* ============================ parseArgs ============================ */

describe('parseArgs：写能力默认关闭，开启须显式 --allow-write', () => {
  it('无 --allow-write ⇒ writeEnabled=false、approvedRoots 空', () => {
    const a = parseArgs(['--project', '/proj']);
    expect(a.writeEnabled).toBe(false);
    expect(a.approvedRoots).toEqual([]);
    expect(a.projectRoot).toBe(path.resolve('/proj'));
  });

  it('多次 --allow-write ⇒ 全部收集为已批准根', () => {
    const a = parseArgs(['--project', '/proj', '--allow-write', '/proj/allowed', '--allow-write', '/data/out']);
    expect(a.writeEnabled).toBe(true);
    expect(a.approvedRoots).toEqual([path.resolve('/proj/allowed'), path.resolve('/data/out')]);
  });

  it('缺值 / 未知参数 ⇒ 显式抛错（不静默吞）', () => {
    expect(() => parseArgs(['--allow-write'])).toThrow(/缺值|缺/);
    expect(() => parseArgs(['--project'])).toThrow(/缺值|缺/);
    expect(() => parseArgs(['--bogus'])).toThrow(/未知参数/);
  });
});

/* ============================ 域判定 / 路径约束 ============================ */

describe('isPathWithin / RELATIVE_PATH_PATTERN：域外与逃逸被拒', () => {
  it('域内 true；域外 / .. 逃逸 / 跨盘 false', () => {
    expect(isPathWithin(approvedRoot, path.join(approvedRoot, 'a.txt'), path)).toBe(true);
    expect(isPathWithin(approvedRoot, path.join(projectRoot, 'other', 'a.txt'), path)).toBe(false);
    expect(isPathWithin(approvedRoot, path.resolve(approvedRoot, '..', 'escape.txt'), path)).toBe(false);
    expect(isPathWithin('C:\\root', 'D:\\root\\x', path.win32)).toBe(false);
    // 前缀误命中：root 与 root2 是两棵不同的树
    expect(isPathWithin('C:\\root', 'C:\\root2\\a.txt', path.win32)).toBe(false);
  });

  it('validateArgs：绝对路径 / 盘符 / .. / 缺必填 ⇒ INVALID', () => {
    const spec = HEADLESS_WRITE_TOOL_SPECS.find((s) => s.name === 'fs.write');
    expect(validateArgs(spec, { relPath: 'allowed/a.txt', content: 'x' }).valid).toBe(true);
    for (const rel of ['/abs.txt', 'C:/x', '../escape.txt', 'a/../b']) {
      expect(validateArgs(spec, { relPath: rel, content: 'x' }).valid).toBe(false);
    }
    expect(validateArgs(spec, { relPath: 'allowed/a.txt' }).valid).toBe(false); // 缺 content
    expect(new RegExp(RELATIVE_PATH_PATTERN).test('src/a.txt')).toBe(true);
  });
});

/* ============================ resource 截断标记 ============================ */

describe('renderResourceText：超限显式 truncated 标记（fail loud）', () => {
  it('超上限 → envelope truncated:true + preview + hint；未超原样', () => {
    const long = renderResourceText({ blob: 'z'.repeat(100) }, 10);
    expect(long.truncated).toBe(true);
    const env = JSON.parse(long.text);
    expect(env.truncated).toBe(true);
    expect(env.preview).toHaveLength(10);
    expect(env.hint.length).toBeGreaterThan(0);
    expect(renderResourceText('abc', 10)).toEqual({ text: 'abc', truncated: false });
  });
});

/* ============================ 只读 kernel 四条腿（内存 fs，不写盘） ============================ */

describe('createNodeKernel：只读四条腿用注入内存 fs 真跑（不碰真盘）', () => {
  it('项目信息 / 文件树 / 检索 / 诊断都返回可读结果', async () => {
    const files = {
      [path.join(projectRoot, 'package.json')]: JSON.stringify({ name: 'demo', version: '1.2.3' }),
      [path.join(projectRoot, 'a.txt')]: 'hello WORLD  \nsecond line',
      [path.join(projectRoot, 'src', 'b.txt')]: 'needle here\n',
    };
    const memFs = {
      async readFile(p) {
        if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return files[p];
      },
      async readdir(dir) {
        const prefix = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
        const names = new Set();
        const dirs = new Set();
        for (const k of Object.keys(files)) {
          if (!k.startsWith(prefix)) continue;
          const rest = k.slice(prefix.length);
          const first = rest.split(/[\\/]/)[0];
          if (rest.includes(path.sep) || rest.includes('/')) dirs.add(first);
          else names.add(first);
        }
        return [
          ...[...dirs].map((name) => ({ name, isDirectory: () => true })),
          ...[...names].map((name) => ({ name, isDirectory: () => false })),
        ];
      },
      async mkdir() {},
      async writeFile(p, data) {
        files[p] = data;
      },
      async rm(p) {
        delete files[p];
      },
      async rename(a, b) {
        files[b] = files[a];
        delete files[a];
      },
      async stat(p) {
        return { size: (files[p] ?? '').length, mtimeMs: 0, isDirectory: () => false };
      },
    };
    const kernel = createNodeKernel({ fs: memFs, path, projectRoot });

    const info = await kernel.projectInfo();
    expect(info.packageName).toBe('demo');
    expect(info.fileCount).toBe(3);

    const tree = await kernel.fileTree({});
    expect(tree.total).toBe(3);
    expect(tree.truncated).toBe(false);

    const search = await kernel.searchAll({ query: 'needle' });
    expect(search.hits.length).toBeGreaterThan(0);

    const diag = await kernel.diagnostics({});
    expect(diag.items.some((i) => i.rule === 'trailing-whitespace')).toBe(true);
  });
});

/* ============================ headless server：只读默认 ============================ */

describe('headless server：只读开箱可用、写工具默认不进 tools/list', () => {
  it('initialize 标注 readOnly；tools/list 只列 7 条只读腿', async () => {
    const server = createHeadlessServer({ kernel: fakeKernel(), projectRoot, approvedRoots: [], writeEnabled: false });
    expect(server.readOnly).toBe(true);
    const initRes = await server.handle(INIT);
    expect(initRes.result._kojo.readOnly).toBe(true);
    expect(initRes.result._kojo.writeAuthorized).toBe(false);
    const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = list.result.tools.map((t) => t.name);
    for (const r of HEADLESS_READ_TOOL_SPECS) expect(names).toContain(r.name);
    for (const w of HEADLESS_WRITE_TOOL_SPECS) expect(names).not.toContain(w.name);
  });

  it('只读调用（project.info）无需写授权即可用', async () => {
    const server = createHeadlessServer({ kernel: fakeKernel(), projectRoot, approvedRoots: [], writeEnabled: false });
    const res = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'project.info', arguments: {} } });
    expect(res.result.content[0].text).toContain('projectRoot');
  });

  it('默认关闭时写调用 ⇒ 显式 WRITE_DISABLED，且假 kernel 写腿 0 次（不写盘）', async () => {
    const kernel = fakeKernel();
    const server = createHeadlessServer({ kernel, projectRoot, approvedRoots: [], writeEnabled: false });
    await server.handle(INIT);
    const res = await server.handle(writeCall({ relPath: 'allowed/a.txt', content: 'x' }));
    expect(res.error.data.code).toBe('WRITE_DISABLED');
    expect(kernel.calls.write).toBe(0);
  });
});

/* ============================ headless server：未授权显式报错 ============================ */

describe('headless server：客户端 / 初始化未授权显式报错（不静默）', () => {
  it('未 initialize 就写 ⇒ NOT_INITIALIZED', async () => {
    const kernel = fakeKernel();
    const server = createHeadlessServer({ kernel, projectRoot, approvedRoots: [approvedRoot], writeEnabled: true });
    const res = await server.handle(writeCall({ relPath: 'allowed/a.txt', content: 'x' }));
    expect(res.error.data.code).toBe('NOT_INITIALIZED');
    expect(kernel.calls.write).toBe(0);
  });

  it('initialize 缺 clientInfo.name ⇒ CLIENT_UNAUTHORIZED', async () => {
    const kernel = fakeKernel();
    const server = createHeadlessServer({ kernel, projectRoot, approvedRoots: [approvedRoot], writeEnabled: true });
    const initRes = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(initRes.result._kojo.clientAuthorized).toBe(false);
    const res = await server.handle(writeCall({ relPath: 'allowed/a.txt', content: 'x' }));
    expect(res.error.data.code).toBe('CLIENT_UNAUTHORIZED');
    expect(kernel.calls.write).toBe(0);
  });
});

/* ============================ headless server：--allow-write + 域内/域外 ============================ */

describe('headless server：--allow-write 开启后域内写成功、域外写被拒（不真写盘）', () => {
  function makeServer() {
    const kernel = fakeKernel();
    const server = createHeadlessServer({ kernel, projectRoot, approvedRoots: [approvedRoot], writeEnabled: true });
    return { kernel, server };
  }

  it('tools/list 含 3 条写腿；域内写成功（假 kernel 记录 1 次）', async () => {
    const { kernel, server } = makeServer();
    await server.handle(INIT);
    const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = list.result.tools.map((t) => t.name);
    for (const w of HEADLESS_WRITE_TOOL_SPECS) expect(names).toContain(w.name);
    const res = await server.handle(writeCall({ relPath: 'allowed/a.txt', content: 'hi' }));
    expect(res.result.content[0].text).toContain('written');
    expect(kernel.calls.write).toBe(1);
  });

  it('域外写（other/a.txt）⇒ OUT_OF_DOMAIN，写腿 0 次', async () => {
    const { kernel, server } = makeServer();
    await server.handle(INIT);
    const res = await server.handle(writeCall({ relPath: 'other/a.txt', content: 'x' }));
    expect(res.error.data.code).toBe('OUT_OF_DOMAIN');
    expect(kernel.calls.write).toBe(0);
  });

  it('.. 逃逸 / 绝对路径 / 盘符 ⇒ INVALID_ARGS，写腿 0 次', async () => {
    const { kernel, server } = makeServer();
    await server.handle(INIT);
    for (const relPath of ['../escape.txt', '/abs.txt', 'C:/x']) {
      const res = await server.handle(writeCall({ relPath, content: 'x' }));
      expect(res.error.data.code).toBe('INVALID_ARGS');
    }
    expect(kernel.calls.write).toBe(0);
  });

  it('fs.rename 的 to 域外 ⇒ OUT_OF_DOMAIN（from/to 都校验），rename 腿 0 次', async () => {
    const { kernel, server } = makeServer();
    await server.handle(INIT);
    const res = await server.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'fs.rename', arguments: { from: 'allowed/a.txt', to: 'other/b.txt' } },
    });
    expect(res.error.data.code).toBe('OUT_OF_DOMAIN');
    expect(kernel.calls.rename).toBe(0);
  });
});

/* ============================ 其它 MCP 方法 ============================ */

describe('headless server：notification / resources / 未知方法', () => {
  it('notification 不回包；ping 回空 result；未知方法 -32601', async () => {
    const server = createHeadlessServer({ kernel: fakeKernel(), projectRoot, approvedRoots: [], writeEnabled: false });
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const ping = await server.handle({ jsonrpc: '2.0', id: 8, method: 'ping' });
    expect(ping.result).toEqual({});
    const unknown = await server.handle({ jsonrpc: '2.0', id: 9, method: 'nope' });
    expect(unknown.error.code).toBe(-32601);
  });

  it('resources/read 返回带 truncated 标记的内容（fail loud）', async () => {
    const server = createHeadlessServer({ kernel: fakeKernel(), projectRoot, approvedRoots: [], writeEnabled: false });
    const res = await server.handle({ jsonrpc: '2.0', id: 10, method: 'resources/read', params: { uri: 'kojo://headless/project' } });
    expect(res.result.contents[0].uri).toBe('kojo://headless/project');
    expect(res.result.contents[0].truncated).toBe(false);
    const missing = await server.handle({ jsonrpc: '2.0', id: 11, method: 'resources/read', params: { uri: 'kojo://headless/nope' } });
    expect(missing.error.data.code).toBe('UNKNOWN_RESOURCE');
  });
});

/* ============================ 第三波：只读面 7 条 + 新资源 + 读文件腿 ============================ */

describe('headless server：只读面扩到 7 条（与 @kojo/mcp-host 只读面同形）', () => {
  it('HEADLESS_READ_TOOL_SPECS 恰好 7 条，全带 readOnlyHint，命名齐全', () => {
    expect(HEADLESS_READ_TOOL_SPECS).toHaveLength(7);
    for (const s of HEADLESS_READ_TOOL_SPECS) expect(s.annotations?.readOnlyHint).toBe(true);
    const names = HEADLESS_READ_TOOL_SPECS.map((s) => s.name);
    for (const n of [
      'commands.list', 'project.info', 'fs.tree', 'search.all',
      'diagnostics.read', 'document.active', 'fs.readFile',
    ]) {
      expect(names).toContain(n);
    }
  });

  it('tools/list 默认恰好 7 条只读、写工具一条不列', async () => {
    const server = createHeadlessServer({ kernel: fakeKernel(), projectRoot, approvedRoots: [], writeEnabled: false });
    const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = list.result.tools.map((t) => t.name);
    expect(names).toHaveLength(7);
    for (const w of HEADLESS_WRITE_TOOL_SPECS) expect(names).not.toContain(w.name);
  });

  it('commands.list 返回清单 + total + truncated；maxResults 截断标记显式', async () => {
    const server = createHeadlessServer({ kernel: fakeKernel(), projectRoot, approvedRoots: [], writeEnabled: false });
    const all = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'commands.list', arguments: {} } });
    const d = JSON.parse(all.result.content[0].text);
    expect(d.commands.length).toBeGreaterThan(0);
    expect(d.total).toBe(d.commands.length);
    expect(d.truncated).toBe(false);
    const capped = await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'commands.list', arguments: { maxResults: 2 } } });
    const cd = JSON.parse(capped.result.content[0].text);
    expect(cd.truncated).toBe(true);
    expect(cd.commands).toHaveLength(2);
  });
});

describe('headless server：新增 resources（commands / active-document）', () => {
  it('resources/list 含 kojo://headless/commands 与 kojo://headless/active-document', async () => {
    const server = createHeadlessServer({ kernel: fakeKernel(), projectRoot, approvedRoots: [], writeEnabled: false });
    const res = await server.handle({ jsonrpc: '2.0', id: 5, method: 'resources/list', params: {} });
    const uris = res.result.resources.map((r) => r.uri);
    expect(uris).toContain('kojo://headless/commands');
    expect(uris).toContain('kojo://headless/active-document');
  });

  it('resources/read kojo://headless/commands 带 truncated 标记', async () => {
    const server = createHeadlessServer({ kernel: fakeKernel(), projectRoot, approvedRoots: [], writeEnabled: false });
    const res = await server.handle({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: 'kojo://headless/commands' } });
    expect(res.result.contents[0].uri).toBe('kojo://headless/commands');
    expect(res.result.contents[0].truncated).toBe(false);
  });
});

describe('headless server：fs.readFile / document.active 读文件（截断 / 逃逸 / 缺席不静默）', () => {
  function readKernel() {
    const files: Record<string, string> = {
      [path.join(projectRoot, 'README.md')]: '# demo\nhello',
      [path.join(projectRoot, 'big.txt')]: 'z'.repeat(500),
    };
    const memFs = {
      async readFile(p: string) {
        if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return files[p];
      },
      async readdir() { return []; },
      async mkdir() {},
      async writeFile(p: string, data: string) { files[p] = data; },
      async rm() {},
      async rename() {},
      async stat(p: string) { return { size: (files[p] ?? '').length, mtimeMs: 0, isDirectory: () => false }; },
    };
    return createNodeKernel({ fs: memFs, path, projectRoot });
  }

  const serverWith = () => createHeadlessServer({ kernel: readKernel(), projectRoot, approvedRoots: [], writeEnabled: false });

  it('fs.readFile 读项目根内文件：available + text + truncated 标记', async () => {
    const server = serverWith();
    const res = await server.handle({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'fs.readFile', arguments: { relPath: 'README.md' } },
    });
    const d = JSON.parse(res.result.content[0].text);
    expect(d.available).toBe(true);
    expect(d.text).toContain('hello');
    expect(d.truncated).toBe(false);
  });

  it('fs.readFile 截断：maxChars=10 ⇒ truncated:true 且 text 被裁、textLength 保留', async () => {
    const server = serverWith();
    const res = await server.handle({
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'fs.readFile', arguments: { relPath: 'big.txt', maxChars: 10 } },
    });
    const d = JSON.parse(res.result.content[0].text);
    expect(d.truncated).toBe(true);
    expect(d.text).toHaveLength(10);
    expect(d.textLength).toBe(500);
  });

  it('经 server 的逃逸 / 绝对路径 ⇒ INVALID_ARGS（结构化，不静默）', async () => {
    const server = serverWith();
    for (const relPath of ['../escape.txt', '/abs.txt', 'C:/x']) {
      const res = await server.handle({
        jsonrpc: '2.0', id: 9, method: 'tools/call',
        params: { name: 'fs.readFile', arguments: { relPath } },
      });
      expect(res.error.data.code).toBe('INVALID_ARGS');
    }
  });

  it('kernel.readTextFile 第二层域复核：域外显式 available:false + reason（不静默）', async () => {
    const out = await readKernel().readTextFile({ relPath: '../escape.txt' });
    expect(out.available).toBe(false);
    expect(String(out.reason).length).toBeGreaterThan(0);
  });

  it('文档缺席：available:false + 显式 reason（不挂空串）', async () => {
    const server = serverWith();
    const res = await server.handle({
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'fs.readFile', arguments: { relPath: 'nope.txt' } },
    });
    const d = JSON.parse(res.result.content[0].text);
    expect(d.available).toBe(false);
    expect(String(d.reason)).toContain('不可读或缺席');
  });

  it('document.active 带 cursor:null + 不适用标注（headless 无 GUI 光标，显式不静默）', async () => {
    const server = serverWith();
    const res = await server.handle({
      jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: { name: 'document.active', arguments: {} },
    });
    const d = JSON.parse(res.result.content[0].text);
    expect(d.available).toBe(true);
    expect(d.cursor).toBeNull();
    expect(String(d.cursorNote)).toContain('不适用');
  });
});
