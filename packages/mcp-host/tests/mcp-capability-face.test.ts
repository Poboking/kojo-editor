/**
 * WP-6a · 能力面自读（`kojo://server/capability-face`）—— 判据（先红）。
 *
 * 要解决的那件事：**能力面的体积余量只有测试知道**。WP-4 把全量帧从 188,375 压到 175,337，
 * 但那个数字活在 `mcp-tools-list-payload.test.ts` 的断言里，模型看不到、宿主看不到、设置页也看不到。
 * 于是「还能不能再加一具面」这件事只能靠人跑测试判断，而模型的自我描述（"我能做什么"）永远是空的。
 *
 * 九条判据：
 *  1. **派生而非接线**：`createMcpCapabilityRegistry({})`（**不给** `readResourceData`）就能读；
 *     即便给了 `readResourceData`，这条 URI 也**不经过它**（派生自 registry 自身，不是外部真源）。
 *  2. **与 `listTools` 同一真源**：三个档位的 `visible.total` 逐字等于 `listTools(scope).length`，
 *     不许另算一份（两份计数＝两份真值）。
 *  3. **账要合上**：`byTier` 之和 === total；`visible + hidden === 全量面`；全量面 === 规格三路之和。
 *  4. **不泄露不可见面的名字**：只给计数，不给名字。判据自校准——只在「可见面描述里本来就不出现」
 *     的那些隐藏名上断言缺席（否则会把正常的交叉引用误判成泄露）。
 *  5. **体积读数与量具同源**：`payload.toolsListFrameBytes` === `toolsListFrameBytes(listTools(scope), id)`，
 *     且 `headroomBytes` / `headroomPercent` 与之算术一致。
 *  6. **传输闸跨语言同源**：`TRANSPORT_RESPONSE_LIMIT_BYTES` === Rust `server.rs` 里
 *     `max_response_bytes` 的实值（从源码现取，不手抄）；且必须是**较紧**的那道（≤ host-bridge 4 MiB）。
 *  7. **零 tools/list 增量**：资源清单 +1，工具枚数一枚不动（增面走 resource 的全部意义）。
 *  8. **描述本身不撑胖**：`resources/list` 也是一帧，新资源的描述 ≤ 220 字符。
 *  9. **可覆盖性不变**：`deps.resources` 同 URI 仍然覆盖（与内置项同一口径，不搞特例）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_FACE_URI,
  KERNEL_IO_TOOL_SPECS,
  MCP_RESOURCE_SPECS,
  SEMANTIC_TOOL_SPECS,
  SUPPLEMENTAL_TOOL_SPECS,
  TRANSPORT_RESPONSE_LIMIT_BYTES,
  createMcpCapabilityRegistry,
  toolsListFrameBytes,
  type McpSessionScope,
} from '@kojo/mcp-host';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const readScope: McpSessionScope = { sessionId: 'cf-s', clientId: 'cf-c', tier: 'read', approvedRoots: [], approvedTools: [] };
const editScope: McpSessionScope = { ...readScope, tier: 'edit' };
const privScope: McpSessionScope = { ...readScope, tier: 'privileged' };

const ALL_SPECS = [...SEMANTIC_TOOL_SPECS, ...KERNEL_IO_TOOL_SPECS, ...SUPPLEMENTAL_TOOL_SPECS];
const ALL_NAMES = ALL_SPECS.map((s) => s.name);
/**
 * 「全量面」的准星：**规格三路**，不是 `listTools(privileged)`。
 * 后者在未逐项批准时仍看不到 privileged 面（档位 ≠ 批准），拿它当全量会把账算成负数。
 */
const privApprovedScope: McpSessionScope = {
  ...readScope,
  tier: 'privileged',
  approvedTools: ALL_SPECS.filter((s) => s.tier === 'privileged').map((s) => s.name),
};

interface CapabilityFace {
  session: { tier: string; approvedTools: number };
  visible: { total: number; byTier: { read: number; edit: number; privileged: number } };
  hidden: { total: number; byTier: { read: number; edit: number; privileged: number }; note: string };
  payload: {
    toolsListFrameBytes: number;
    transportLimitBytes: number;
    headroomBytes: number;
    headroomPercent: number;
  };
  resources: number;
  prompts: number;
}

/** 读一次能力面并解析（`readResource` 回 `{contents:[{uri,text}]}`，文本是 JSON）。 */
async function readFace(deps: Parameters<typeof createMcpCapabilityRegistry>[0], scope: McpSessionScope) {
  const reg = createMcpCapabilityRegistry(deps);
  const raw = (await reg.readResource(CAPABILITY_FACE_URI, scope)) as { contents: { uri: string; text: string }[] };
  expect(raw.contents).toHaveLength(1);
  expect(raw.contents[0]!.uri).toBe(CAPABILITY_FACE_URI);
  return { reg, text: raw.contents[0]!.text, face: JSON.parse(raw.contents[0]!.text) as CapabilityFace };
}

const tierCount = (tools: readonly { tier: string }[]) => ({
  read: tools.filter((t) => t.tier === 'read').length,
  edit: tools.filter((t) => t.tier === 'edit').length,
  privileged: tools.filter((t) => t.tier === 'privileged').length,
});

describe('能力面自读 kojo://server/capability-face', () => {
  it('① 派生而非接线：零 deps 可读，且不经过 readResourceData', async () => {
    const { face } = await readFace({}, editScope);
    expect(face.visible.total).toBeGreaterThan(0);

    // 给了 readResourceData 也不许被问：派生面只认 registry 自身。
    let asked: string[] = [];
    const { face: face2 } = await readFace(
      {
        readResourceData: (uri: string) => {
          asked.push(uri);
          throw new Error(`不该被问到：${uri}`);
        },
      },
      editScope,
    );
    expect(asked).toEqual([]);
    expect(face2.visible.total).toBe(face.visible.total);
  });

  it('② 与 listTools 同一真源：三档 visible.total 逐字相等', async () => {
    for (const scope of [readScope, editScope, privScope, privApprovedScope]) {
      const { reg, face } = await readFace({}, scope);
      expect(face.visible.total).toBe(reg.listTools(scope).length);
      expect(face.visible.byTier).toEqual(tierCount(reg.listTools(scope)));
    }
  });

  it('③ 账要合上：byTier 之和 === total，visible + hidden === 全量面', async () => {
    const { face } = await readFace({}, editScope);
    const sum = (c: { read: number; edit: number; privileged: number }) => c.read + c.edit + c.privileged;

    expect(sum(face.visible.byTier)).toBe(face.visible.total);
    expect(sum(face.hidden.byTier)).toBe(face.hidden.total);
    expect(face.visible.total + face.hidden.total).toBe(ALL_SPECS.length);

    // 隐藏侧逐档对账：全量面（规格三路）按档减可见面按档，一格都不许凭感觉填。
    const all = tierCount(ALL_SPECS);
    expect(face.hidden.byTier).toEqual({
      read: all.read - face.visible.byTier.read,
      edit: all.edit - face.visible.byTier.edit,
      privileged: all.privileged - face.visible.byTier.privileged,
    });

    // 批准满档 ⇒ 隐藏归零（账的另一端也要能合上，不只是中间态）。
    const { face: full } = await readFace({}, privApprovedScope);
    expect(full.visible.total).toBe(ALL_SPECS.length);
    expect(full.hidden).toMatchObject({ total: 0, byTier: { read: 0, edit: 0, privileged: 0 } });
  });

  it('④ 不泄露不可见面的名字：只给计数（判据自校准，避开可见面本来就有的交叉引用）', async () => {
    const { reg, text, face } = await readFace({}, readScope);
    const visibleNames = new Set(reg.listTools(readScope).map((t) => t.name));
    const hiddenNames = ALL_NAMES.filter((n) => !visibleNames.has(n));

    expect(face.hidden.total).toBe(hiddenNames.length);
    // 自校准：只在「可见面描述里本来就不出现」的名字上断言缺席，避免误判正常交叉引用。
    const visibleText = reg.listTools(readScope).map((t) => `${t.name}\n${t.description ?? ''}`).join('\n');
    const candidates = hiddenNames.filter((n) => !visibleText.includes(n));
    expect(candidates.length).toBeGreaterThan(0);
    for (const name of candidates) expect(text.includes(name)).toBe(false);

    // 结构上也只许有计数：hidden 的键集写死。
    expect(Object.keys(face.hidden).sort()).toEqual(['byTier', 'note', 'total']);
  });

  it('⑤ 体积读数与量具同源：帧字节 / 余量 / 余量百分比三者算术一致', async () => {
    const { reg, face } = await readFace({}, editScope);
    const frame = toolsListFrameBytes(reg.listTools(editScope), 'capability-face');

    expect(face.payload.toolsListFrameBytes).toBe(frame);
    expect(face.payload.transportLimitBytes).toBe(TRANSPORT_RESPONSE_LIMIT_BYTES);
    expect(face.payload.headroomBytes).toBe(TRANSPORT_RESPONSE_LIMIT_BYTES - frame);
    expect(face.payload.headroomPercent).toBe(
      Math.round(((TRANSPORT_RESPONSE_LIMIT_BYTES - frame) / TRANSPORT_RESPONSE_LIMIT_BYTES) * 1000) / 10,
    );
    expect(face.payload.toolsListFrameBytes).toBeLessThan(TRANSPORT_RESPONSE_LIMIT_BYTES);
  });

  it('⑥ 传输闸跨语言同源：常量 === Rust server.rs 实值，且取较紧的那道', () => {
    const rust = readFileSync(resolve(REPO_ROOT, 'packages/app/src-tauri/src/mcp/server.rs'), 'utf8');
    const m = /max_response_bytes:\s*([0-9*\s]+),/.exec(rust);
    expect(m, 'Rust 里找不到 max_response_bytes 的实值').not.toBeNull();
    // eslint-disable-next-line no-eval -- 只对源码里的纯算术常量（`1024 * 1024`）求值，无外部输入。
    const rustValue = Number(eval(m![1]!.trim()));
    expect(TRANSPORT_RESPONSE_LIMIT_BYTES).toBe(rustValue);

    // host-bridge 的 4 MiB 是另一道（更松）的桥上限：能力面必须报真正卡住的那道。
    const bridge = readFileSync(resolve(REPO_ROOT, 'packages/app/src/mcp/host-bridge.ts'), 'utf8');
    const b = /DEFAULT_MAX_RESPONSE_BYTES = ([0-9*\s]+);/.exec(bridge);
    expect(b, 'host-bridge 里找不到 DEFAULT_MAX_RESPONSE_BYTES').not.toBeNull();
    expect(TRANSPORT_RESPONSE_LIMIT_BYTES).toBeLessThanOrEqual(Number(eval(b![1]!.trim())));
  });

  it('⑦ 零 tools/list 增量：资源清单 +1，工具枚数一枚不动', async () => {
    const uris = MCP_RESOURCE_SPECS.map((s) => s.uri);
    expect(uris.filter((u) => u === CAPABILITY_FACE_URI)).toHaveLength(1);
    // 规格清单 11 条；**运行期是 12 条**——生产 `real-sources.ts` 另注入一枚 `fsFreshness`
    // （`deps.resources`）。这两个数必须分开说，否则「文档 11 / 代码 10」会互相冤枉。
    expect(MCP_RESOURCE_SPECS).toHaveLength(11);
    const withExtra = createMcpCapabilityRegistry({
      resources: [
        { uri: 'kojo://project/fs-freshness', name: '新鲜度', description: '注入面', read: async () => ({ contents: [] }) },
      ],
    });
    expect(withExtra.listResources()).toHaveLength(12);

    // 工具枚数由规格三路决定，本批一枚不加（增面走 resource 的全部意义就在这）。
    expect(ALL_SPECS.length).toBe(86);
  });

  it('⑧ 描述本身不撑胖：resources/list 也是一帧，新描述 ≤ 220 字符', () => {
    const spec = MCP_RESOURCE_SPECS.find((s) => s.uri === CAPABILITY_FACE_URI)!;
    expect(spec.name.length).toBeGreaterThan(0);
    expect(spec.description.length).toBeLessThanOrEqual(220);
    expect(spec.mimeType).toBe('application/json');
  });

  it('⑨ 可覆盖性不变：deps.resources 同 URI 仍覆盖内置项', async () => {
    const reg = createMcpCapabilityRegistry({
      resources: [
        {
          uri: CAPABILITY_FACE_URI,
          name: '覆盖',
          description: '覆盖',
          read: async () => ({ contents: [{ uri: CAPABILITY_FACE_URI, text: 'overridden' }] }),
        },
      ],
    });
    const raw = (await reg.readResource(CAPABILITY_FACE_URI, editScope)) as { contents: { text: string }[] };
    expect(raw.contents[0]!.text).toBe('overridden');
    expect(reg.listResources().filter((r) => r.uri === CAPABILITY_FACE_URI)).toHaveLength(1);
  });
});
