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
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  base64ToArrayBuffer,
  decodeValue,
  normalizeOrigin,
  resolveWebHostConfig,
} from '../src/debug/web-host-transport';
import {
  armChooseDir,
  armedChooseDir,
  buildChooseDirResponse,
  clearChooseDir,
  consumeChooseDir,
  installShellDialogIntercept,
  parseIpcCmd,
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

describe('调试面 · dialogPolicy（choose_directory 一次性自动应答，2026-10-26 era-pair 批）', () => {
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

  it('web-host-transport 页面腿是「命中才短路」：choose_directory 且 hit 才 return，未命中照走宿 /invoke', () => {
    const src = read('packages/app/src/debug/web-host-transport.ts');
    expect(src).toMatch(/if \(cmd === 'choose_directory'\)/);
    expect(src).toMatch(/if \(hit\.hit\)/);
  });
});
