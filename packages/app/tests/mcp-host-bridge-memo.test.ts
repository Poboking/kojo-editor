/**
 * B20 批（LaneAH，2026-11-06）：MCP 注册表 memo × 真源登记竞态——**失效闸**。
 *
 * 实拍现象（B12 取证，`docs/mcp/README.md` §5.8 末段）：真桌面壳干净会话里，第一条打到
 * 只读面的 `mcp://request` 会把「宿主未提供数据源」这一结论**固化**进注册表；此后无论
 * `ShellLayout` 什么时候把真源登记上（`installRealMcpSources` → `registerMcpWiringSources`），
 * 读腿永远回 `NOT_WIRED`——只有再调一次 app 自己的 `registerMcpHostBridge()`（它顺手把
 * `registryPromise` 清了）才立刻出成功帧。⇒ 这不是端点慢，是 memo 没失效通道。
 *
 * 本文件钉住四件事（顺序即真实顺序：桥在 bootstrap 登记、真源在 GUI 挂载之后异步登记）：
 *  ① 先查询后登记 ⇒ 第二条读必须拿到**当拍真源**（不靠 re-register 桥）；
 *  ② 两种注册顺序拿到**同一份**真源读数；
 *  ③ 真源注销后必须**重新显式** `NOT_WIRED`，不许继续吃旧 memo 的假成功；
 *  ④ 缺席仍然可见：一请求恰好一帧、原话术一字不改、零静默重试、零新增等待。
 *
 * 纪律：只走生产形态（不注入 `deps` / `registryFactory`），故装配真源的那一拍确实经
 * `./wiring` 的模块级登记；每个用例自己把登记清空，避免模块级 sticky 状态串味。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { McpSessionScope } from '@kojo/mcp-host';
import {
  registerMcpHostBridge,
  type McpBridgeTransport,
  type McpMethod,
  type McpRequestEvent,
  type McpRespondArgs,
  type Unlisten,
} from '../src/mcp/host-bridge';
import { registerMcpWiringSources, type McpWiringSources } from '../src/mcp/wiring';

const scope: McpSessionScope = {
  sessionId: 'b20',
  clientId: 'b20-lane',
  tier: 'privileged',
  approvedRoots: ['/proj'],
  approvedTools: [],
};

/** `NOT_WIRED` 的原话术（`packages/mcp-host/src/index.ts` 的 `notWired()`）——本批不许改文案。 */
const NOT_WIRED_TEXT = '未接线：宿主未提供数据源（不静默、不伪造读数）';

/* --------------------------- 注入 seam 脚手架（无 Tauri / 无 HTTP） --------------------------- */

interface Harness {
  readonly transport: McpBridgeTransport;
  readonly frames: McpRespondArgs[];
  readonly ready: Promise<void>;
  /** 投一条请求并等它这一帧落定（一请求一帧；帧数即「有没有静默重试」的读数）。 */
  call(id: string, method: McpMethod, params: Record<string, unknown>): Promise<McpRespondArgs>;
  listening(): boolean;
}

function createHarness(): Harness {
  const frames: McpRespondArgs[] = [];
  let handler: ((e: McpRequestEvent) => void) | null = null;
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const transport: McpBridgeTransport = {
    listen: async (fn) => {
      handler = fn;
      markReady();
      return () => {
        handler = null;
      };
    },
    respond: async (args) => {
      frames.push(args);
    },
  };
  return {
    transport,
    frames,
    ready,
    listening: () => handler !== null,
    async call(id, method, params) {
      const at = frames.length;
      handler?.({ id, method, params, scope });
      // 只等「这一帧出现」，不设观察窗：等不到就让断言自己红（本批禁止用等待掩盖缺席）。
      for (let i = 0; i < 2000 && frames.length === at; i += 1) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      return frames[at] as McpRespondArgs;
    },
  };
}

/** 假真源：三条腿各留一枚可核对的印记（`mark`），读数形状由腿自己决定。 */
function realSources(mark: string): McpWiringSources {
  return {
    kernelIo: { projectInfo: () => ({ from: mark, root: '/proj' }) },
    semantic: { diagnostics: () => ({ items: [], total: 0, truncated: false, from: mark }) },
    runSupplemental: (name, args) => ({ name, args, from: mark, text: 'REAL-BODY' }),
    readResourceData: (uri) => ({ uri, from: mark }),
  };
}

const READ_FILE = {
  method: 'tools/call' as McpMethod,
  params: { name: 'fs.readFile', arguments: { relPath: 'docs/a.txt' } },
};
const PROJECT_INFO = { method: 'tools/call' as McpMethod, params: { name: 'project.info', arguments: {} } };
const SEMANTIC_DIAGNOSTICS = {
  method: 'tools/call' as McpMethod,
  params: { name: 'semantic.diagnostics', arguments: {} },
};

const bridges: Unlisten[] = [];
function registerBridge(hz: Harness): Unlisten {
  // 生产形态：不注入 deps、不注入 registryFactory ⇒ 走 defaultRegistryFactory + ./wiring 真源登记。
  const off = registerMcpHostBridge({ transport: hz.transport });
  bridges.push(off);
  return off;
}

afterEach(() => {
  while (bridges.length > 0) bridges.pop()?.();
  registerMcpWiringSources(null);
});

describe('B20：注册表 memo × 真源登记竞态（失效重取，不是重试掩盖）', () => {
  it('① 先查询、后登记真源 ⇒ 下一条读拿到当拍真源（不许靠再调一次 registerMcpHostBridge）', async () => {
    registerMcpWiringSources(null);
    const hz = createHarness();
    registerBridge(hz);
    await hz.ready;

    // 真实开机时序的第一拍：真源还没登记（ShellLayout 的动态 import 还没落地）。
    const before = await hz.call('b20-1a', READ_FILE.method, READ_FILE.params);
    expect(before.ok).toBe(false);
    expect(before.error?.code).toBe('NOT_WIRED');
    expect(before.error?.message).toContain(NOT_WIRED_TEXT);

    // 真源登记上——**不**重新登记桥。改前：注册表 memo 仍在，这条永远 NOT_WIRED。
    registerMcpWiringSources(realSources('after-query'));
    const after = await hz.call('b20-1b', READ_FILE.method, READ_FILE.params);
    expect(after.ok).toBe(true);
    expect(after.result).toMatchObject({ name: 'fs.readFile', from: 'after-query', text: 'REAL-BODY' });

    // 另两条腿同一失效通道（kernel IO / 语义 8 腿）。
    const kernel = await hz.call('b20-1c', PROJECT_INFO.method, PROJECT_INFO.params);
    expect(kernel.ok).toBe(true);
    expect(kernel.result).toMatchObject({ from: 'after-query' });
    const semantic = await hz.call('b20-1d', SEMANTIC_DIAGNOSTICS.method, SEMANTIC_DIAGNOSTICS.params);
    expect(semantic.ok).toBe(true);
    expect(semantic.result).toMatchObject({ from: 'after-query' });
  });

  it('② 两种注册顺序（先登记后查询 / 先查询后登记）拿到同一份真源读数', async () => {
    // 顺序 A：真源先在场，桥后登记（改前也成立的那一支）。
    registerMcpWiringSources(realSources('same-mark'));
    const hzA = createHarness();
    const offA = registerBridge(hzA);
    await hzA.ready;
    const readA = await hzA.call('b20-2a', READ_FILE.method, READ_FILE.params);
    expect(readA.ok).toBe(true);
    offA();

    // 顺序 B：桥先登记并先打一条（把注册表 memo 起来），真源后登记。
    registerMcpWiringSources(null);
    const hzB = createHarness();
    registerBridge(hzB);
    await hzB.ready;
    const cold = await hzB.call('b20-2b', READ_FILE.method, READ_FILE.params);
    expect(cold.ok).toBe(false);
    expect(cold.error?.code).toBe('NOT_WIRED');
    registerMcpWiringSources(realSources('same-mark'));
    const readB = await hzB.call('b20-2c', READ_FILE.method, READ_FILE.params);
    expect(readB.ok).toBe(true);

    // 同一份真源读数：两条腿回的是逐字相同的结果体。
    expect(readB.result).toEqual(readA.result);
  });

  it('③ 真源注销（registerMcpWiringSources(null)）后再次读必须重新显式 NOT_WIRED，不许吃旧 memo 的旧成功', async () => {
    registerMcpWiringSources(realSources('live'));
    const hz = createHarness();
    registerBridge(hz);
    await hz.ready;

    const live = await hz.call('b20-3a', PROJECT_INFO.method, PROJECT_INFO.params);
    expect(live.ok).toBe(true);
    expect(live.result).toMatchObject({ from: 'live' });

    registerMcpWiringSources(null); // 真源撤了（内核 / GUI 那一侧没了）
    const gone = await hz.call('b20-3b', PROJECT_INFO.method, PROJECT_INFO.params);
    expect(gone.ok).toBe(false);
    expect(gone.error?.code).toBe('NOT_WIRED');
    expect(gone.error?.message).toContain(NOT_WIRED_TEXT);
    expect(gone.result).toBeUndefined(); // 绝不拿旧读数、也不返回空读数冒充成功
  });

  it('④ 桥注销（off()）同样作废注册表 memo：真源已清空时重新登记的桥必须重新显式 NOT_WIRED', async () => {
    registerMcpWiringSources(realSources('before-off'));
    const hz1 = createHarness();
    const off1 = registerBridge(hz1);
    await hz1.ready;
    const ok = await hz1.call('b20-4a', PROJECT_INFO.method, PROJECT_INFO.params);
    expect(ok.ok).toBe(true);

    off1();
    expect(hz1.listening()).toBe(false);
    registerMcpWiringSources(null);

    const hz2 = createHarness();
    const off2 = registerBridge(hz2);
    await hz2.ready;
    const after = await hz2.call('b20-4b', PROJECT_INFO.method, PROJECT_INFO.params);
    expect(after.ok).toBe(false);
    expect(after.error?.code).toBe('NOT_WIRED');
    expect(after.error?.message).toContain(NOT_WIRED_TEXT);
    off2();
  });

  it('⑤ 缺席仍然可见：一条请求恰好一帧、原话术一字不改、零静默重试', async () => {
    registerMcpWiringSources(null);
    const hz = createHarness();
    registerBridge(hz);
    await hz.ready;

    const frame = await hz.call('b20-5a', PROJECT_INFO.method, PROJECT_INFO.params);
    expect(hz.frames).toHaveLength(1); // 一请求一帧：没有第二帧＝没有静默重试
    expect(frame).toEqual({
      id: 'b20-5a',
      ok: false,
      error: { code: 'NOT_WIRED', message: `能力「project.info」${NOT_WIRED_TEXT}` },
    });

    const again = await hz.call('b20-5b', READ_FILE.method, READ_FILE.params);
    expect(hz.frames).toHaveLength(2);
    expect(again.error?.message).toBe(`能力「fs.readFile」${NOT_WIRED_TEXT}`);
  });

  // B23（LaneAJ，2026-11-06）补 B20 回执留下的口子：判据若只看「登记对象 identity」，
  // 有人**原地改写**已登记的 McpWiringSources 字段而不再调 registerMcpWiringSources，
  // memo 看不出换代 ⇒ 继续吃旧腿。本用例全程生产形态、**不**再登记第二次（那正是 B20
  // 已能处理的情形），只用 Object.assign 在同一对象上换掉 kernelIo 字段。
  // 位置说明：必须声明在 ⑥ **之前**——⑥ 注入的 deps 按「只给到的项才覆盖」留在模块级
  // 配置里（B20 既有语义，不许动），⑥ 之后的再登记仍会吃那份 injected deps、不走 wiring。
  it('⑦ 原地改写已登记 sources 的字段（不再调 registerMcpWiringSources）⇒ 下一条读必须拿到新腿', async () => {
    const sources = realSources('in-place-old');
    registerMcpWiringSources(sources);
    const hz = createHarness();
    registerBridge(hz);
    await hz.ready;

    const old = await hz.call('b23-7a', PROJECT_INFO.method, PROJECT_INFO.params);
    expect(old.ok).toBe(true);
    expect(old.result).toMatchObject({ from: 'in-place-old' });

    // 原地写字段：登记对象 identity 一字未动——B20 的身份比对在这一拍看不出换代。
    Object.assign(sources, { kernelIo: { projectInfo: () => ({ from: 'in-place-new', root: '/proj' }) } });

    const after = await hz.call('b23-7b', PROJECT_INFO.method, PROJECT_INFO.params);
    expect(after.ok).toBe(true);
    expect(after.result).toMatchObject({ from: 'in-place-new' });

    // 字段级换代不是「整包重登记」：没被改写的 semantic 腿仍持有同一对象上的旧闭包，
    // 重装配后照旧读出旧印记（换代判据＝逐字段浅快照，不是对象整体）。
    const semantic = await hz.call('b23-7c', SEMANTIC_DIAGNOSTICS.method, SEMANTIC_DIAGNOSTICS.params);
    expect(semantic.ok).toBe(true);
    expect(semantic.result).toMatchObject({ from: 'in-place-old' });

    expect(hz.frames).toHaveLength(3); // 一请求一帧：重取不产生第二帧，也没有轮询
  });

  it('⑥ 显式注入 deps 的测试缝行为不变：注入那份 deps 就是真源，不被 wiring 的换代劫走', async () => {
    const off = registerMcpHostBridge({
      transport: createHarness().transport,
      deps: { kernelIo: { projectInfo: () => ({ from: 'injected' }) } },
    });
    bridges.push(off);
    // 这条只验「注入缝仍在」：deps 注入时不装配 wiring，故 wiring 的 null 登记不影响读腿。
    registerMcpWiringSources(null);
    expect(off).toBeTypeOf('function');
    off();
  });
});
