/**
 * B21（LaneAF）钉读数 · B22（LaneAI）去重后重钉 + **信息等价闸** —— 只钉读数，不改生产形态。
 *
 * 这一份要钉死的是：**「以后谁把工具表撑胖了 ⇒ 直接红，且红得能说出是谁撑的」**；
 * 反过来也一样：**「谁去掉重复载荷时顺手把信息删丢了 ⇒ 也直接红」**。
 * 全部判据都从 `@kojo/mcp-host` 的**注册表真源**现场算
 * （`createMcpCapabilityRegistry({}).listTools(scope)` 与线协议一一对应），
 * 零假注入、零 GUI、零 Tauri、零 HTTP。
 *
 * 八条判据：
 *  1. **可见面形状**：77 枚具名面（read 37 / edit 11 / privileged 29）、缺省会话（未批准）
 *     只出 read 面 37 枚 —— 与 `docs/STATE.md` 的能力面读数同源；枚数一动这里就红。
 *  2. **体积带（漂移护栏）**：全量面一帧的 JSON 字节数必须落在**本批实拍带**里，另外还有一条
 *     **记账下界**（B22 约 −3.5%）：上界＝挡住「新面把描述无限写长」，下界＝挡住
 *     「瘦身不记账、反向把内容删丢」。带子仍留 ±10%：加一枚工具不至于红，连加一屏长描述一定会红。
 *  3. **线协议形态**：每枚上帧的工具对象键集只许 `{name, description, inputSchema, tier, annotations?}`
 *     ——`run` 是函数、序列化必须消失；键集里冒出别的（或 `tier` 掉了）都在这里红。
 *  4. **体积闸余量**：全量帧距 1 MiB 的 `max_response_bytes` 余量 ≥ 700 KiB（闸值一字不动）。
 *  5. **描述长度闸**：Rust `sanitize_tool_descriptor`（`packages/app/src-tauri/src/mcp/protocol.rs`）
 *     对 >`MAX_DESCRIPTION_CHARS`＝2048 字符的描述是**静默截断**：不报错、照发，尾巴换成 `…[truncated]`
 *     ⇒ 超标＝那一枚的尾部约束在客户端当场消失。B21 实拍 2 枚超标（`launcher_log_tail` 2,049、
 *     `editor.openDocument` 2,079），B22 去重后必须 0 枚，且最长一枚留出余量。
 *  6. **指针落点（去重的合法性）**：页大小/严格度口径原本被 152 个别名属性各抄一份（539 字符×152＝
 *     81,389 B 纯重复），B22 收成**每枚面一份**，落点＝本面 `inputSchema.properties.limit.description`，
 *     别名与描述只留指针。本条钉「指针指过去的内容真的存在且完整」：落点缺一个 token 就红。
 *  7. **逐面语义账**：被压过的文案里闸值 / 上限 / 缺省值 / 只读与危险提示 / 路径约束 / `saved:false`
 *     这一类必须逐条还在（表驱动，缺 token 就红）。
 *  8. **分档读数**：description / inputSchema / launcher 族三档上界，红了就知道是哪一档变了。
 *
 * `additionalProperties:false` 的严格化（B11）实测仍是 **80 处 / 2,400 字节**，本批一处没摘。
 * 复现读数：`node tools/mcp-list-payload-evidence.mjs static --top 8` 与 `... dedup --top 8`。
 */
import { describe, expect, it } from 'vitest';
import {
  KERNEL_IO_TOOL_SPECS,
  PAGE_ACCOUNT_NOTE,
  PAGE_SIZE_ARG_ALIASES,
  SEMANTIC_TOOL_SPECS,
  SUPPLEMENTAL_TOOL_SPECS,
  createMcpCapabilityRegistry,
  type McpSessionScope,
  type McpTool,
} from '@kojo/mcp-host';

/* ------------------------------ 现场取面 ------------------------------ */

const HOST_SPECS = [...SEMANTIC_TOOL_SPECS, ...KERNEL_IO_TOOL_SPECS, ...SUPPLEMENTAL_TOOL_SPECS];
const ALL_NAMES = HOST_SPECS.map((s) => s.name);

function scope(tier: McpSessionScope['tier'], approvedTools: readonly string[] = []): McpSessionScope {
  return { sessionId: 'b22-s', clientId: 'b22-c', tier, approvedRoots: [], approvedTools };
}

const registry = createMcpCapabilityRegistry({});

/** 一帧 `tools/list` 的线协议字节数：`run` 是函数，JSON 序列化即消失。 */
function frameBytes(tools: readonly McpTool[]): number {
  return Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 'b22', result: { tools } }), 'utf-8');
}

const fullFace = registry.listTools(scope('privileged', ALL_NAMES));
const readFace = registry.listTools(scope('read'));
const editFace = registry.listTools(scope('edit'));

const bytes = (value: unknown) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf-8');
/** 一枚面上帧的净字节（`run` 不参与序列化，与量具 `wireTool` 同口径）。 */
function wireBytes(t: McpTool): number {
  const { run: _run, ...rest } = t;
  return bytes(rest);
}
const descBytes = fullFace.reduce((a, t) => a + bytes(t.description ?? ''), 0);
const schemaBytes = fullFace.reduce((a, t) => a + bytes(t.inputSchema ?? {}), 0);
const launcherBytes = fullFace.filter((t) => t.name.startsWith('launcher_')).reduce((a, t) => a + wireBytes(t), 0);

/** 拿一枚面 `properties` 里的某格（只为指针落点与语义 token 核对，不改任何形状）。 */
function propOf(tool: McpTool, name: string): Record<string, unknown> | undefined {
  const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  const hit = props?.[name];
  return hit && typeof hit === 'object' ? (hit as Record<string, unknown>) : undefined;
}
function propDesc(tool: McpTool, name: string): string {
  return String(propOf(tool, name)?.['description'] ?? '');
}

/* ------------------------------ 本批实拍读数 ------------------------------ */

/** B21 实拍（2026-11-06，LaneAF，去重前）：只留着核对 Δ，判据已按 B22 重钉。 */
const B21_FULL_FRAME_BYTES = 218_897;
/** B22 实拍（2026-11-06，LaneAI，去掉逐字重复后）＝量具 `static` 的 frameBytes。 */
const B22_FULL_FRAME_BYTES = 168_894;
/** B22 记账下界（约 −3.5%）：还要再瘦必须先改这一格并留下读数，不许把删内容当瘦身。 */
const B22_ACCOUNTED_FLOOR = 163_000;
const BAND = 0.1;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const RUST_MAX_DESCRIPTION_CHARS = 2048;

describe('B22 tools/list 载荷体积＋信息等价闸（注册表真源现场算，非估算）', () => {
  it('① 可见面枚数与 STATE 能力面读数同源：81＝read 39 / edit 13 / privileged 29（MCP-PERF-S6 批 +1 枚 edit：fileTree.patchLines patch 级写）', () => {
    expect(fullFace).toHaveLength(81);
    expect(readFace).toHaveLength(39);
    expect(editFace).toHaveLength(52); // read + edit；privileged 未点名批准 ⇒ 不上帧
    const byTier = fullFace.reduce<Record<string, number>>((a, t) => {
      a[t.tier] = (a[t.tier] ?? 0) + 1;
      return a;
    }, {});
    expect(byTier).toEqual({ read: 39, edit: 13, privileged: 29 });
    // 缺省会话（未批准任何 privileged）只出 read 面——默认可见面不是全量面。
    expect(registry.listTools(scope('read'))).toHaveLength(39);
  });

  it('② 全量帧落在 B22 实拍带内（±10% 上界护栏）且不低于 B22 记账下界', () => {
    const n = frameBytes(fullFace);
    expect(n).toBeGreaterThanOrEqual(Math.round(B22_FULL_FRAME_BYTES * (1 - BAND)));
    expect(n).toBeLessThanOrEqual(Math.round(B22_FULL_FRAME_BYTES * (1 + BAND)));
    expect(n).toBeGreaterThanOrEqual(B22_ACCOUNTED_FLOOR);
    // 去重前的读数 B21_FULL_FRAME_BYTES 只留着核对 Δ：218,897 → 168,894（−50,003 B＝−22.8%）。
    expect(B22_FULL_FRAME_BYTES).toBeLessThan(B21_FULL_FRAME_BYTES);
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

  it('⑤ 描述长度闸：B22 后 0 枚超标（Rust 侧是静默截断，超标＝尾巴当场丢）', () => {
    // 实测行为：protocol.rs 的 sanitize_tool_descriptor → truncate_chars(desc, 2048)——
    // **不报错、照发**，超过 2048 字符的部分被砍掉并补 `…[truncated]`（B21 那 2 枚就是这么丢尾注的）。
    const over = fullFace.filter((t) => (t.description ?? '').length > RUST_MAX_DESCRIPTION_CHARS).map((t) => t.name);
    expect(over).toEqual([]);
    const longest = Math.max(...fullFace.map((t) => (t.description ?? '').length));
    // 最长一枚（B22 实拍 fs.readMany 2,005 字符）留 ≥40 字符余量：撞上 2048 不会报错，只会被换刀。
    expect(longest).toBeLessThanOrEqual(RUST_MAX_DESCRIPTION_CHARS - 40);

    // 同一把刀也打在 **inputSchema 里任意一层的 description 键**上（`sanitize_untrusted_inplace`
    // 对 normalize 后等于 `description` 的键一律按 2048 收紧，仓内 Rust 用例
    // `b5_sanitize_inplace_is_byte_identical_to_whole_tree_reference` 把这条钉着）。
    // B22 的完整口径落点就在 schema 侧（639 字符），所以这里给它单独一条余量闸：
    // 谁把落点写到 1 KiB 以上，先在静态面红，而不是到真壳里被静默裁掉。
    const schemaDescLens: number[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k === 'description' && typeof v === 'string') schemaDescLens.push(v.length);
          else walk(v);
        }
      }
    };
    for (const t of fullFace) walk(t.inputSchema);
    expect(schemaDescLens.length).toBeGreaterThan(300); // B22 实拍 352 条
    expect(Math.max(...schemaDescLens)).toBeLessThanOrEqual(1024);
  });

  it('⑥ 指针落点：页大小/严格度口径每枚面一份，指针指过去的内容真的存在且完整', () => {
    // 落点＝本面 `properties.limit` 的 description。凡是（a）描述里带了「见本面 inputSchema limit」指针、
    // （b）声明了 `limit` 之外的页大小别名、或（c）声明了 `limit` 本身 的面，都必须能在**同一条
    // tools/list 记录**里读到完整口径——跳转次数＝0，不靠 prompts / _meta / 仓内文档。
    const CANON_TOKENS = [
      'ONE knob',
      'never widened',
      'limit > length > maxChars > maxResults > maxEntries > maxRanges > maxEvents > maxLines',
      'additionalProperties:false',
      'full legal list',
    ];
    let canonicalFaces = 0;
    for (const t of fullFace) {
      const limitDesc = propDesc(t, 'limit');
      const pointsHere = (t.description ?? '').includes('inputSchema `limit` description');
      const aliasSiblings = PAGE_SIZE_ARG_ALIASES.filter((a) => a !== 'limit' && propOf(t, a) !== undefined);
      if (!limitDesc && !pointsHere) continue;
      expect(limitDesc, `${t.name} 的描述指向 inputSchema.limit，但本面没有该落点`).not.toBe('');
      for (const token of CANON_TOKENS) {
        expect(limitDesc, `${t.name} 的 limit 落点缺 token：${token}`).toContain(token);
      }
      canonicalFaces += 1;
      for (const alias of aliasSiblings) {
        const d = propDesc(t, alias);
        expect(d, `${t.name}.${alias} 没有指向 \`limit\` 的指针`).toContain('`limit`');
        expect(d, `${t.name}.${alias} 的指针必须说明落点就在本对象里`).toContain('limit` description');
      }
    }
    expect(canonicalFaces).toBeGreaterThanOrEqual(20); // B22 实拍 25 枚分页面，一枚一份

    // 启动器族的档位尾注：逐字共用，但只许出现在真的 privileged 的 launcher_* 面上，五个要点齐。
    const tierTokens = ['privileged', 'tools/list', 'EXACT name', '4th table', 'launcher_*'];
    for (const t of fullFace.filter((x) => x.name.startsWith('launcher_'))) {
      for (const token of tierTokens) {
        expect(t.description ?? '', `${t.name} 的档位说明缺 ${token}`).toContain(token);
      }
      expect(t.tier, `${t.name} 带 privileged 尾注却不在 privileged 档`).toBe('privileged');
    }
  });

  it('⑦ 逐面语义账：压过的文案里闸值/缺省/只读/危险/路径/回执字段一条都不许丢', () => {
    const REQUIRED_TOKENS: Record<string, readonly string[]> = {
      'editor.openDocument': [
        'INVALID_ARGS',
        'editor.revealLocation',
        'paneId',
        'derivedView',
        'contentChanged:false',
        'saved:false',
        'persisted:false',
        'TOOL_EXECUTION_FAILED',
        'NOT_WIRED',
        'RESOURCE_UNAVAILABLE',
        'waitedMs',
        'polls',
        'pollIntervalMs',
        'deadlineMs',
        'alreadyOpen',
        'lineCount',
        'language',
        'modelUri',
        'readOnly',
        'tabCount',
        'exportFile',
        'fileTree.update',
        'editor.setCursor',
        'editor.revealLine',
        'project-root-relative',
      ],
      launcher_log_tail: ['40960', 'base64', 'truncatedByBytes', 'maxBytes', 'CHUNK', 'stream'],
      'fs.readFile': ['24000', '65000', '65536', 'textLength', 'changedDuringPaging', 'Never writes to disk', 'approvedRoots'],
      'document.active': ['8000', '65000', '65536', 'textLength', 'cursor'],
      'io.workspaceRoots': ['rootIds', 'approvedRootIds', 'ws:', 'never mutates state'],
    };
    for (const [name, tokens] of Object.entries(REQUIRED_TOKENS)) {
      const tool = fullFace.find((t) => t.name === name);
      expect(tool, `${name} 必须仍在册`).toBeDefined();
      for (const token of tokens) {
        expect(tool?.description ?? '', `${name} 的 description 丢了 token：${token}`).toContain(token);
      }
    }

    // 完整性账字段集：去重只压句式，账上的字段名一个不能少。
    for (const field of ['total', 'textLength', 'offset', 'limit', 'truncated', 'hasMore', 'nextCursor', 'fingerprint']) {
      expect(PAGE_ACCOUNT_NOTE, `PAGE_ACCOUNT_NOTE 丢了字段 ${field}`).toContain(field);
    }
    expect(PAGE_ACCOUNT_NOTE).toContain('changedDuringPaging');

    // 路径 / 根标识这类共用形状说明：约束逐条还在（B22 只把长句压短，没有搬到别处）。
    // 口径＝把 schema 树里**每一条**含该 marker 的 description 抠出来（含嵌套 items/子对象），不限属性名。
    const schemaDescHits = (t: McpTool, needle: string): string[] => {
      const acc: string[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
          for (const item of node) walk(item);
          return;
        }
        if (node && typeof node === 'object') {
          for (const [k, v] of Object.entries(node)) {
            if (k === 'description' && typeof v === 'string') {
              if (v.includes(needle)) acc.push(v);
            } else walk(v);
          }
        }
      };
      walk(t.inputSchema);
      return acc;
    };
    const relPathHosts = fullFace.flatMap((t) => schemaDescHits(t, 'ADR-0003'));
    // B22 实拍 15 处；MCP-PERF-S3 批 +1（fileTree.applyChangeset）；MCP-PERF-S4 批 +1
    // （fs.readRange 的 relPath 与 fs.readFile 同一条 RELATIVE_PATH_SCHEMA 共用形状说明）；
    // MCP-PERF-S6 批 +1（fileTree.patchLines 的 relPath 同用 RELATIVE_PATH_SCHEMA）。
    expect(relPathHosts.length).toBe(18);
    for (const d of relPathHosts) {
      for (const token of ['Project-root-relative', 'absolute', 'drive-letter', '".."', 'approvedRoots', 'ADR-0003']) {
        expect(d, `相对路径说明丢了 ${token}`).toContain(token);
      }
    }
    const rootIdHosts = fullFace.flatMap((t) => schemaDescHits(t, 'ws: + 8 lowercase hex'));
    expect(rootIdHosts.length).toBeGreaterThanOrEqual(4);
    for (const d of rootIdHosts) {
      for (const token of ['NOT a path', 'io.workspaceRoots', 'approvedRootIds', 'Omit to stay on the current project root']) {
        expect(d, `rootId 说明丢了 ${token}`).toContain(token);
      }
    }
  });

  it('⑧ 分档读数上界（与 B22 回执同源）：红了就知道是哪一档变了', () => {
    // MCP-PERF-S6（LaneN 2026-11-07）+1 枚 edit 面（fileTree.patchLines）重钉：
    // desc 63,000 → 65,000（实拍 64,433，+1,926＝patch 级写两形 hunk 契约的诚实描述 1,926 字符）；
    // schema 106,500 → 108,500（实拍 107,873，+2,032＝hunks 两形 items + relPath/rootId 入参）；
    // launcher / 帧带不动（launcher 实拍 73,706 与 S4 持平；frame 实拍 183,052，仍在 B22 带 ±10% 内）。
    // MCP-PERF-S8（LaneR 2026-11-07）纯 additive 入参批重钉（零新面，枚数/档位全不动）：
    // schema 108,500 → 110,500（实拍 109,621，+1,748＝search.all / workspace.searchAll 的
    // deadlineMs+preview 两枚入参 ×2 面 + semantic.projectSymbols 的 query 入参——全部落在
    // properties.description，accounting 字段零删减）；desc 上界 65,000 不动（S8 实拍 64,912，
    // +479＝三枚面的描述句各添一短句）；launcher 不动（实拍 73,706 与 S4/S6 持平）；
    // frame 实拍 185,281，仍在 B22 带 ±10% 内（B22 底数 168,894 一字未动）。
    expect(descBytes).toBeLessThanOrEqual(65_000); // B21 实拍 64,851；S4 62,507；S6 64,433；S8 实拍 64,912
    expect(schemaBytes).toBeLessThanOrEqual(110_500); // B21 143,762；S4 105,841；S6 107,873；S8 实拍 109,621
    expect(launcherBytes).toBeLessThanOrEqual(75_000); // B21 实拍全族 100,323；S4 实拍 73,706
    expect(schemaBytes).toBeGreaterThan(descBytes); // 口径没被颠倒：瘦掉的是重复，不是内容
  });
});
