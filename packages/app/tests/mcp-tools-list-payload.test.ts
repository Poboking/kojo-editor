/**
 * B21（LaneAF）· `tools/list` 载荷体积读数钉桩 —— **只钉读数，不改任何生产形态**。
 *
 * 这一份要钉死的是：**「以后谁把工具表撑胖了 ⇒ 直接红，且红得能说出是谁撑的」**，
 * 而不是再交一份「估计的体积」。全部判据都从 `@kojo/mcp-host` 的**注册表真源**现场算
 * （`createMcpCapabilityRegistry({}).listTools(scope)` 与线协议一一对应），
 * 零假注入、零 GUI、零 Tauri、零 HTTP。
 *
 * 四条判据：
 *  1. **可见面形状**：77 枚具名面（read 37 / edit 11 / privileged 29）、缺省会话（未批准）
 *     只出 read 面 37 枚 —— 与 `docs/STATE.md` 的能力面读数同源；枚数一动这里就红，
 *     红名单直接印出是哪一档变了。
 *  2. **体积带（漂移护栏）**：全量面一帧的 JSON 字节数必须落在**本批实拍带**里
 *     （下界＝挡住「偷偷瘦身不记账」，上界＝挡住「新面把描述无限写长」）。
 *     带子刻意留了 ±10% 的余量：加一枚工具不至于红，连加一屏长描述一定会红。
 *  3. **线协议形态**：每枚上帧的工具对象键集只许 `{name, description, inputSchema, tier, annotations?}`
 *     ——`run` 是函数、序列化必须消失；键集里冒出别的（或 `tier` 掉了）都在这里红。
 *  4. **体积闸余量**：全量帧距 1 MiB 的 `max_response_bytes` 余量 ≥ 700 KiB（闸值一字不动，
 *     本条只钉「还剩多少」，余量掉下这条线就说明载荷已经快到需要正面讨论分页的那一步）。
 *
 * `additionalProperties:false` 的严格化（B11）在本批的实测是 **80 处 / 2,400 字节**，
 * 只占全量帧的 1.1% —— 由第 2、4 条一起兜住，不是单独一条闸。
 */
import { describe, expect, it } from 'vitest';
import {
  KERNEL_IO_TOOL_SPECS,
  SEMANTIC_TOOL_SPECS,
  SUPPLEMENTAL_TOOL_SPECS,
  createMcpCapabilityRegistry,
  type McpSessionScope,
  type McpTool,
} from '@kojo/mcp-host';

/* ------------------------------ 现场取面 ------------------------------ */

const HOST_SPECS = [...SEMANTIC_TOOL_SPECS, ...KERNEL_IO_TOOL_SPECS, ...SUPPLEMENTAL_TOOL_SPECS];
const ALL_NAMES = HOST_SPECS.map((s) => s.name);
const PRIVILEGED_NAMES = HOST_SPECS.filter((s) => s.tier === 'privileged').map((s) => s.name);

function scope(tier: McpSessionScope['tier'], approvedTools: readonly string[] = []): McpSessionScope {
  return { sessionId: 'b21-s', clientId: 'b21-c', tier, approvedRoots: [], approvedTools };
}

const registry = createMcpCapabilityRegistry({});

/** 一帧 `tools/list` 的线协议字节数：`run` 是函数，JSON 序列化即消失。 */
function frameBytes(tools: readonly McpTool[]): number {
  return Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 'b21', result: { tools } }), 'utf-8');
}

const fullFace = registry.listTools(scope('privileged', ALL_NAMES));
const readFace = registry.listTools(scope('read'));
const editFace = registry.listTools(scope('edit'));

/* ------------------------------ 本批实拍读数 ------------------------------ */

/** B21 实拍（2026-11-06，LaneAF，静态规格面）：漂移护栏带＝±10%，带外必须是有意识的改动。 */
const B21_FULL_FRAME_BYTES = 218_897;
const BAND = 0.1;
const MAX_RESPONSE_BYTES = 1024 * 1024;

describe('B21 tools/list 载荷体积（注册表真源现场算，非估算）', () => {
  it('① 可见面枚数与 STATE 能力面读数同源：77＝read 37 / edit 11 / privileged 29', () => {
    expect(fullFace).toHaveLength(77);
    expect(readFace).toHaveLength(37);
    expect(editFace).toHaveLength(48); // read + edit；privileged 未点名批准 ⇒ 不上帧
    const byTier = fullFace.reduce<Record<string, number>>((a, t) => {
      a[t.tier] = (a[t.tier] ?? 0) + 1;
      return a;
    }, {});
    expect(byTier).toEqual({ read: 37, edit: 11, privileged: 29 });
    // 缺省会话（未批准任何 privileged）只出 read 面——默认可见面不是全量面。
    expect(registry.listTools(scope('read'))).toHaveLength(37);
  });

  it('② 全量帧字节落在本批实拍带内（±10% 漂移护栏）', () => {
    const bytes = frameBytes(fullFace);
    expect(bytes).toBeGreaterThanOrEqual(Math.round(B21_FULL_FRAME_BYTES * (1 - BAND)));
    expect(bytes).toBeLessThanOrEqual(Math.round(B21_FULL_FRAME_BYTES * (1 + BAND)));
  });

  it('③ 上帧键集只有契约那几格，run 必须序列化消失', () => {
    const allowed = new Set(['name', 'description', 'inputSchema', 'tier', 'annotations']);
    for (const t of fullFace) {
      expect(typeof t.run, `${t.name} 的 run 必须在册（registry 契约）`).toBe('function');
      for (const key of Object.keys(JSON.parse(JSON.stringify(t)))) {
        expect(allowed.has(key), `${t.name} 上帧多了非契约键 ${key}`).toBe(true);
      }
    }
    // 序列化后 run 不见：逐枚核对线上键集里没有 `run` 这一格（子串不作数，键名才算）。
    for (const t of fullFace) {
      expect(Object.keys(JSON.parse(JSON.stringify(t)))).not.toContain('run');
    }
  });

  it('④ 距 1 MiB 体积闸余量 ≥700 KiB（闸值不动，只钉余量）', () => {
    const bytes = frameBytes(fullFace);
    expect(MAX_RESPONSE_BYTES).toBe(1024 * 1024);
    expect(MAX_RESPONSE_BYTES - bytes).toBeGreaterThanOrEqual(700 * 1024);
  });

  it('⑤ description 顶到 Rust 二次截断（2048 字符）的面不多于本批实拍的 2 枚', () => {
    // 顶闸的面在端点侧会被裁，静态面与真端点面因此不许差出一个量级——这条把「裁了多少」钉成可核对的账。
    const over = fullFace.filter((t) => (t.description ?? '').length > 2048).map((t) => t.name);
    expect(over.length).toBeLessThanOrEqual(2);
    expect(over.sort()).toEqual(['editor.openDocument', 'launcher_log_tail']);
  });
});
