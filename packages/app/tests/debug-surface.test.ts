/**
 * 调试面（`packages/app/src/debug/`）的判据（2026-10-24 调试模式批）。
 *
 * 面上的事：
 * 1. **选入解析**（`resolveWebHostConfig` / `normalizeOrigin`）：`?kojo-debug` 与
 *    localStorage 两条入口、默认 origin、port-only 形态——这是「调试模式是显式选入」的
 *    唯一闸，解析宽了就是所有浏览器页默认改走调试宿（安全面变化），窄了调试模式失灵；
 * 2. **二进制信封**（`decodeValue` / `base64ToArrayBuffer`）：批量读帧过 JSON 的还原；
 * 3. **DOM 结构快照**（`snapshotDocument`）：喂伪造 document，断言只认结构锚；
 * 4. **事件载荷瘦身**（`slimPayload`）：环形旁听不给大载荷留全量位；
 * 5. **对话框自动应答 policy**（`dialog-policy.ts`，2026-10-26 era-pair 批）：一次性消费语义、
 *    custom-protocol fetch 腿的 URL 认法、合成应答形态对齐 ipc-protocol.js 消费链；
 * 6. **源形状守门**（读源码字符串，形态照 `ps10-eager-graph` / `welcome-*` 先例）：
 *    - `main.tsx` 对 `debug/install-debug` 只许动态 import（开机图闸零影响的机制保证）；
 *    - `invoke.ts` 未选入时的原报错文案逐字保留（浏览器开发壳既有行为不许被顺手改掉）；
 *    - `tauri-bridge.ts` 的浏览器降级路径保留（调试宿不在场时仍显式「无监视能力」）。
 * 7. **鉴权 token**（2026-10-30 鉴权批，契约 §1.3）：`kojo-debug-token` / localStorage
 *    `kojoDebugHostToken` 的解析、**空值不挂键**（既有 `toEqual({origin})` 判据不许被
 *    `token: undefined` 污染）、invoke 的 `Authorization` 头、SSE 的 `?token=`。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  base64ToArrayBuffer,
  buildEventsUrl,
  decodeValue,
  hostAuthHeaders,
  normalizeOrigin,
  resolveWebHostConfig,
  webHostInvoke,
} from '../src/debug/web-host-transport';
import {
  armChooseDir,
  armedChooseDir,
  buildChooseDirResponse,
  clearChooseDir,
  consumeChooseDir,
  installShellDialogIntercept,
  parseIpcCmd,
  POLICY_DIALOG_COMMANDS,
} from '../src/debug/dialog-policy';
import { slimPayload } from '../src/debug/install-debug';
import { snapshotDocument } from '../src/debug/dom-snapshot';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

/* ----------------------------- 选入解析 ----------------------------- */

describe('web 调试宿 · 选入解析（显式选入是唯一闸）', () => {
  it('不带参数、不带 localStorage ⇒ 不选入（浏览器页行为与从前逐字一致）', () => {
    expect(resolveWebHostConfig('', null)).toBeNull();
    expect(resolveWebHostConfig('?foo=1', null)).toBeNull();
    expect(resolveWebHostConfig('', '')).toBeNull();
  });

  it('?kojo-debug=1 / true / 空 ⇒ 默认 origin 17777', () => {
    expect(resolveWebHostConfig('?kojo-debug=1', null)).toEqual({ origin: 'http://127.0.0.1:17777' });
    expect(resolveWebHostConfig('?kojo-debug=true', null)).toEqual({ origin: 'http://127.0.0.1:17777' });
    expect(resolveWebHostConfig('?kojo-debug=', null)).toEqual({ origin: 'http://127.0.0.1:17777' });
  });

  it('端口形态与 origin 形态都收；URL 参数优先于 localStorage', () => {
    expect(resolveWebHostConfig('?kojo-debug=18999', null)).toEqual({ origin: 'http://127.0.0.1:18999' });
    expect(resolveWebHostConfig('?kojo-debug=http://127.0.0.1:19000', null)).toEqual({
      origin: 'http://127.0.0.1:19000',
    });
    expect(resolveWebHostConfig('?kojo-debug=127.0.0.1:19001', null)).toEqual({
      origin: 'http://127.0.0.1:19001',
    });
    expect(resolveWebHostConfig('', 'http://127.0.0.1:19002')).toEqual({ origin: 'http://127.0.0.1:19002' });
    expect(resolveWebHostConfig('?kojo-debug=1', 'http://127.0.0.1:19003')).toEqual({
      origin: 'http://127.0.0.1:17777',
    });
  });

  it('?kojo-debug=api ⇒ 只装调试面、不切 web 宿路由（真桌面壳通道，invoke 仍走真 IPC）', () => {
    expect(resolveWebHostConfig('?kojo-debug=api', null)).toBeNull();
    // 不回归：常规选入形态不受影响
    expect(resolveWebHostConfig('?kojo-debug=1', null)).toEqual({ origin: 'http://127.0.0.1:17777' });
    expect(resolveWebHostConfig('?kojo-debug=api', 'http://127.0.0.1:19004')).toBeNull();
  });

  it('normalizeOrigin：尾斜杠剥掉、裸端口补回环、非法形态拒绝', () => {
    expect(normalizeOrigin('http://127.0.0.1:1/')).toBe('http://127.0.0.1:1');
    expect(normalizeOrigin('5173')).toBe('http://127.0.0.1:5173');
    expect(normalizeOrigin('localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeOrigin('not a url')).toBeNull();
    expect(normalizeOrigin('ftp://x')).toBeNull();
  });
});

/* ----------------------------- 二进制信封 ----------------------------- */

describe('web 调试宿 · 二进制信封还原', () => {
  it('base64 往返逐字节一致', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 0, 7]);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const ab = base64ToArrayBuffer(btoa(bin));
    expect(new Uint8Array(ab)).toEqual(bytes);
  });

  it('decodeValue：二进制命令解信封；非二进制命令原样透传；信封缺失显式红', () => {
    let bin2 = '';
    for (const b of [1, 2, 3]) bin2 += String.fromCharCode(b);
    const ab = decodeValue('read_file_bytes_raw', { __b64: btoa(bin2) }) as ArrayBuffer;
    expect([...new Uint8Array(ab)]).toEqual([1, 2, 3]);
    expect(decodeValue('stat_file', { size: 1 })).toEqual({ size: 1 });
    expect(() => decodeValue('read_files_raw', { oops: true })).toThrow(/缺二进制信封/);
  });
});

/* ----------------------------- 对话框自动应答 policy ----------------------------- */

describe('调试面 · dialogPolicy（只选取器一次性自动应答：choose_directory + pick_save_path，1028 批扩面）', () => {
  afterEach(() => clearChooseDir());

  it('未 armed ⇒ 恒 miss（透传零触扰）；arm(null)=模拟取消也是有效应答且同样一次性', () => {
    expect(armedChooseDir()).toEqual({ armed: false, value: null });
    expect(consumeChooseDir()).toEqual({ hit: false });
    armChooseDir(null);
    expect(consumeChooseDir()).toEqual({ hit: true, value: null });
    expect(consumeChooseDir()).toEqual({ hit: false }); // 兑现即清
  });

  it('arm→consume 一次性：命中取走并清空；重复 arm 后 arm 者生效', () => {
    armChooseDir('C:\\game\\demo');
    expect(armedChooseDir()).toEqual({ armed: true, value: 'C:\\game\\demo' });
    expect(consumeChooseDir()).toEqual({ hit: true, value: 'C:\\game\\demo' });
    expect(armedChooseDir().armed).toBe(false);
    expect(consumeChooseDir().hit).toBe(false);
    armChooseDir('C:\\game\\a');
    armChooseDir('C:\\game\\b');
    expect(consumeChooseDir()).toEqual({ hit: true, value: 'C:\\game\\b' });
  });

  it('parseIpcCmd：只认 custom-protocol 腿形态（ipc.localhost + 百分号解码 cmd）；其余 URL 一律 null=透传', () => {
    expect(parseIpcCmd('http://ipc.localhost/choose_directory')).toBe('choose_directory');
    expect(parseIpcCmd('https://ipc.localhost/choose_directory')).toBe('choose_directory');
    expect(parseIpcCmd('http://ipc.localhost/plugin%3Afs%7Cread')).toBe('plugin:fs|read');
    expect(parseIpcCmd('http://127.0.0.1:17777/invoke')).toBeNull();
    expect(parseIpcCmd('http://localhost:1420/')).toBeNull();
    expect(parseIpcCmd('not a url')).toBeNull();
    expect(parseIpcCmd('http://ipc.localhost/%E0%A4%A')).toBeNull(); // 畸形百分号编码 ⇒ 透传
  });

  it('POLICY_DIALOG_COMMANDS：只吃两条**只选取器**（choose_directory / pick_save_path）；写通道与准入门一律不在册（应答对话框 ≠ 放行写盘）', () => {
    expect([...POLICY_DIALOG_COMMANDS].sort()).toEqual(['choose_directory', 'pick_save_path']);
    for (const writeCmd of [
      'export_file',
      'choose_file',
      'choose_workspace_root',
      'write_file_bytes',
      'pick_directory',
      // 2026-10-28 出路批：那条**原生是/否确认框**就是授权本身——脚本能应答它＝脚本能签发写权限。
      // 调试面因此永远不碰它；真壳里自动化要写链路就走已交付过的目录（PITFALLS §160/§161）。
      'confirm_write_domain',
      'register_write_domain',
    ]) {
      expect(POLICY_DIALOG_COMMANDS.has(writeCmd), `${writeCmd} 不许吃脚本应答`).toBe(false);
    }
    // pick_save_path 的 URL 腿形态与 choose_directory 同形（同一枚 parseIpcCmd 判据）
    expect(parseIpcCmd('http://ipc.localhost/pick_save_path')).toBe('pick_save_path');
  });

  it('同一格一次性应答逐条兑现：pick_save_path 消费后 choose_directory 拿不到第二次（绝不一arm多吃）', () => {
    armChooseDir('C:\\sandbox\\新文件.ERB');
    expect(POLICY_DIALOG_COMMANDS.has('pick_save_path')).toBe(true);
    expect(consumeChooseDir()).toEqual({ hit: true, value: 'C:\\sandbox\\新文件.ERB' });
    expect(consumeChooseDir()).toEqual({ hit: false }); // 第二枚对话框（同批任何命令）⇒ 未 armed 透传
  });

  it('buildChooseDirResponse：与 ipc-protocol.js 消费链对齐（Tauri-Response ok + application/json 体）', async () => {
    const res = buildChooseDirResponse('C:\\game\\demo');
    expect(res.headers.get('Tauri-Response')).toBe('ok');
    expect((res.headers.get('content-type') ?? '').split(',')[0]).toBe('application/json');
    expect(await res.json()).toBe('C:\\game\\demo');
    expect(await buildChooseDirResponse(null).json()).toBeNull();
  });

  it('installShellDialogIntercept：非壳环境（无 window.__TAURI_INTERNALS__）不偷偷包 fetch——带理由如实缺席', () => {
    const r = installShellDialogIntercept(() => {});
    expect(r.wrapped).toBe(false);
    expect(r.reason ?? '').toContain('__TAURI_INTERNALS__');
  });
});

/* ----------------------------- DOM 结构快照 ----------------------------- */

describe('调试面 · DOM 结构快照（只认结构锚）', () => {
  it('slimPayload：长串截断、数组折叠、深层折叠、原语原样', () => {
    expect(slimPayload(3)).toBe(3);
    expect(slimPayload(true)).toBe(true);
    expect(slimPayload('x'.repeat(500))).toMatch(/…$/);
    expect(slimPayload([1, 2, 3])).toEqual({ __arr: 3, sample: [1, 2, 3] });
    expect(slimPayload({ a: { b: { c: { d: 1 } } } })).toEqual({ a: { b: '{…}' } });
    expect(slimPayload(null)).toBeNull();
  });
});

/* ----------------------------- 源形状守门 ----------------------------- */

describe('调试面 · 源形状守门（懒装载与既有行为不被顺手改掉）', () => {
  const main = read('packages/app/src/main.tsx');
  const invokeSrc = read('packages/app/src/bridge/invoke.ts');
  const tauriBridge = read('packages/app/src/bridge/tauri-bridge.ts');
  const bootstrap = read('packages/app/src/bootstrap.ts');
  const shellLayout = read('packages/app/src/ui/ShellLayout.tsx');

  it('main.tsx 对 debug/install-debug 只许动态 import（开机图零影响的机制保证）', () => {
    expect(main).not.toMatch(/import\s[^'"]*from\s+['"][^'"]*debug\/install-debug['"]/);
    expect(main).toMatch(/import\('\.\/debug\/install-debug'\)/);
    // 且只在带 ?kojo-debug 时装载
    expect(main).toMatch(/kojo-debug/);
  });

  it('登记簿（debug-registry）在开机图两枚常驻件里也只许动态 import（文件闸余量纪律）', () => {
    expect(bootstrap).not.toMatch(/from\s+['"][^'"]*debug\/debug-registry['"]/);
    expect(bootstrap).toMatch(/import\('\.\/debug\/debug-registry'\)/);
    expect(shellLayout).not.toMatch(/from\s+['"][^'"]*debug\/debug-registry['"]/);
    expect(shellLayout).toMatch(/import\('\.\.\/debug\/debug-registry'\)/);
  });

  it('invoke.ts：未选入时的原报错文案逐字保留（浏览器开发壳既有口径）', () => {
    expect(invokeSrc).toMatch(/Tauri IPC 不可用（当前为浏览器环境，命令：\$\{cmd\}）。请通过桌面壳运行。/);
  });

  it('tauri-bridge.ts：调试宿不在场时仍显式「浏览器开发壳无文件监视能力」', () => {
    expect(tauriBridge).toMatch(/浏览器开发壳无文件监视能力（仅 Tauri 桌面壳有）/);
  });

  it('对话框应答拦截只住 debug/**：产品路径（invoke/tauri-bridge/App/use-project-session）零 dialogPolicy 触扰', () => {
    const productSources: readonly [string, string][] = [
      ['bridge/invoke.ts', invokeSrc],
      ['bridge/tauri-bridge.ts', tauriBridge],
      ['ui/App.tsx', read('packages/app/src/ui/App.tsx')],
      ['ui/use-project-session.ts', read('packages/app/src/ui/use-project-session.ts')],
    ];
    for (const [name, src] of productSources) {
      expect(src, `${name} 不该感知对话框应答面`).not.toMatch(/dialog-policy|dialogPolicy|armChooseDir|consumeChooseDir/);
    }
  });

  it('web-host-transport 页面腿是「命中才短路」：只选取器（POLICY_DIALOG_COMMANDS）且 hit 才 return，未命中照走宿 /invoke', () => {
    const src = read('packages/app/src/debug/web-host-transport.ts');
    expect(src).toMatch(/if \(POLICY_DIALOG_COMMANDS\.has\(cmd\)\)/);
    expect(src).toMatch(/if \(hit\.hit\)/);
    // 旧口径不许回潮：页面腿不再只对 choose_directory 单独判等（1028 批同吃 pick_save_path）
    expect(src).not.toMatch(/if \(cmd === 'choose_directory'\)/);
  });

  it('真壳 fetch 拦截腿同一条命令集：dialog-policy 用 POLICY_DIALOG_COMMANDS 判等（两条腿口径不分叉）', () => {
    const src = read('packages/app/src/debug/dialog-policy.ts');
    expect(src).toMatch(/POLICY_DIALOG_COMMANDS\.has\(parseIpcCmd\(url\)/);
    expect(src).not.toMatch(/parseIpcCmd\(url\) === 'choose_directory'/);
  });
});

/* ----------------------------- 鉴权 token（2026-10-30 鉴权批） ----------------------------- */

type TransportModule = typeof import('../src/debug/web-host-transport');

/**
 * 拿一份**全新**的传输层模块，并伪造对应的页面环境。
 *
 * 必须 `resetModules`：`config()` 是懒缓存（一次解析管到页面卸载），同一个模块实例
 * 第二次再也解析不出别的 token；新实例才等价于「另一个页面」。window 在 node 环境
 * 本就没有，所以这里只是把它 stub 出来，不引入 jsdom。
 */
async function freshTransport(search: string, kv: Record<string, string> = {}): Promise<TransportModule> {
  vi.resetModules();
  vi.stubGlobal('window', {
    location: { search },
    localStorage: { getItem: (key: string) => kv[key] ?? null },
  });
  return await import('../src/debug/web-host-transport');
}

/** 假的 EventSource：只记下被建的 URL（够证明 SSE 地址真的接上了 token） */
class FakeEventSource {
  static urls: string[] = [];
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.urls.push(url);
  }
  addEventListener(): void {}
}

function stubFetch(): { url: string; init: RequestInit | undefined }[] {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, value: { pong: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

describe('web 调试宿 · 鉴权 token（空值不挂键；无 token 路径逐字不变）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.urls = [];
  });

  it('无 token ⇒ 配置对象里没有 token 键（既有 toEqual({origin}) 判据逐字通过）', () => {
    const cfg = resolveWebHostConfig('?kojo-debug=18999', null);
    expect(cfg).toEqual({ origin: 'http://127.0.0.1:18999' });
    expect(cfg !== null && 'token' in cfg).toBe(false);
    // localStorage 只有 origin 时同理
    const fromStorage = resolveWebHostConfig('', 'http://127.0.0.1:19005');
    expect(fromStorage).toEqual({ origin: 'http://127.0.0.1:19005' });
    expect(fromStorage !== null && 'token' in fromStorage).toBe(false);
  });

  it('?kojo-debug-token=<token> ⇒ 解析出 token（URL 参数优先于 localStorage）', () => {
    expect(resolveWebHostConfig('?kojo-debug=18999&kojo-debug-token=abc', null)).toEqual({
      origin: 'http://127.0.0.1:18999',
      token: 'abc',
    });
    expect(resolveWebHostConfig('?kojo-debug=18999&kojo-debug-token=abc', null, 'fromStorage')).toEqual({
      origin: 'http://127.0.0.1:18999',
      token: 'abc',
    });
    // 第三个入参 = localStorage `kojoDebugHostToken`（config() 就是这么喂的）
    expect(resolveWebHostConfig('?kojo-debug=18999', null, 'store-token')).toEqual({
      origin: 'http://127.0.0.1:18999',
      token: 'store-token',
    });
    // 纯 localStorage 选入（无 kojo-debug）也认 token
    expect(resolveWebHostConfig('', 'http://127.0.0.1:19006', 'store-token')).toEqual({
      origin: 'http://127.0.0.1:19006',
      token: 'store-token',
    });
  });

  it('空 token（空串 / 纯空白）⇒ 不挂键，不产出 token: undefined', () => {
    for (const search of ['?kojo-debug=1&kojo-debug-token=', '?kojo-debug=1&kojo-debug-token=%20%20']) {
      const cfg = resolveWebHostConfig(search, null);
      expect(cfg, search).toEqual({ origin: 'http://127.0.0.1:17777' });
      expect(cfg !== null && 'token' in cfg, search).toBe(false);
    }
    expect(resolveWebHostConfig('?kojo-debug=1', null, '   ')).toEqual({ origin: 'http://127.0.0.1:17777' });
    expect(resolveWebHostConfig('?kojo-debug=1&kojo-debug-token=', null, 'store-token')).toEqual({
      origin: 'http://127.0.0.1:17777',
      token: 'store-token',
    });
  });

  it('hostAuthHeaders / buildEventsUrl：无 token 逐字等于改动前的头与 URL', () => {
    expect(hostAuthHeaders({ origin: 'http://127.0.0.1:17777' })).toEqual({});
    expect(hostAuthHeaders({ origin: 'http://127.0.0.1:17777', token: 'abc' })).toEqual({
      authorization: 'Bearer abc',
    });
    expect(buildEventsUrl({ origin: 'http://127.0.0.1:17777' })).toBe('http://127.0.0.1:17777/events');
    // token 走 query 时必须百分号编码（`EventSource` 不能自定义头，见传输层注释）
    expect(buildEventsUrl({ origin: 'http://127.0.0.1:17777', token: 'a b/c&d' })).toBe(
      'http://127.0.0.1:17777/events?token=a%20b%2Fc%26d',
    );
  });

  it('webHostInvoke：有 token 带 Authorization 头、URL 与 body 形状不变', async () => {
    const calls = stubFetch();
    const mod = await freshTransport('?kojo-debug=18999&kojo-debug-token=abc');
    await expect(mod.webHostInvoke('stat_file', { path: 'x.ERB' })).resolves.toEqual({ pong: true });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('http://127.0.0.1:18999/invoke');
    expect(call.init?.method).toBe('POST');
    expect(call.init?.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer abc',
    });
    expect(JSON.parse(String(call.init?.body))).toEqual({ cmd: 'stat_file', args: { path: 'x.ERB' } });
  });

  it('webHostInvoke：无 token 时请求头与改动前逐字一致（不多出 authorization 键）', async () => {
    const calls = stubFetch();
    const mod = await freshTransport('?kojo-debug=18999');
    await mod.webHostInvoke('stat_file');
    const call = calls[0]!;
    expect(call.url).toBe('http://127.0.0.1:18999/invoke');
    expect(call.init?.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('localStorage token 也进请求头（URL 没带 kojo-debug-token 时的第二入口）', async () => {
    const calls = stubFetch();
    const mod = await freshTransport('?kojo-debug=18999', { kojoDebugHostToken: 'store-token' });
    await mod.webHostInvoke('stat_file');
    expect(calls[0]!.init?.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer store-token',
    });
  });

  it('ensureEventSource：SSE URL 真的接上 token（有 / 无两态）', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);

    const withToken = await freshTransport('?kojo-debug=18999&kojo-debug-token=abc');
    withToken.onWebHostEvent('kojo:fs-changed', () => {});
    expect(FakeEventSource.urls).toEqual(['http://127.0.0.1:18999/events?token=abc']);

    FakeEventSource.urls = [];
    const noToken = await freshTransport('?kojo-debug=18999');
    noToken.onWebHostEvent('kojo:fs-changed', () => {});
    expect(FakeEventSource.urls).toEqual(['http://127.0.0.1:18999/events']);
  });
});
