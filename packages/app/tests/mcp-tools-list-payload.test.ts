/**
 * B21（LaneAF）钉读数 · B22（LaneAI）去重后重钉 + **信息等价闸** —— 只钉读数，不改生产形态。
 *
 * 这一份要钉死的是：**「以后谁把工具表撑胖了 ⇒ 直接红，且红得能说出是谁撑的」**；
 * 反过来也一样：**「谁去掉重复载荷时顺手把信息删丢了 ⇒ 也直接红」**。
 * 全部判据都从 `@kojo/mcp-host` 的**注册表真源**现场算
 * （`createMcpCapabilityRegistry({}).listTools(scope)` 与线协议一一对应），
 * 零假注入、零 GUI、零 Tauri、零 HTTP。
 *
 * 九条判据：
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
 *  9. **相对路径共用形状账（MCP-PERF-S15）**：ADR-0003 那份 200 字符共用形状说明原本被 16 枚面
 *     逐字抄 18 份，S15 收成一份完整口径（落点＝`fileTree.update` 的 `properties.relPath`）+ 17 处
 *     指针；按形状锚（盘符守卫 pattern）对账，谁复用这份形状就进这本账。
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
function toolByName(name: string): McpTool {
  const hit = fullFace.find((t) => t.name === name);
  if (!hit) throw new Error(`面 ${name} 不在注册表真源里`);
  return hit;
}
/** 把 schema 树里**每一条**含该 marker 的 description 抠出来（含嵌套 items/子对象），不限属性名。 */
function schemaDescHits(t: McpTool, needle: string): string[] {
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
}

/* ------------------------------ 本批实拍读数 ------------------------------ */

/** B21 实拍（2026-11-06，LaneAF，去重前）：只留着核对 Δ，判据已按 B22 重钉。 */
const B21_FULL_FRAME_BYTES = 218_897;
/** B22 实拍（2026-11-06，LaneAI，去掉逐字重复后）＝量具 `static` 的 frameBytes。
 *  底数重钉（2026-11-07，组长合并点实测）：168,894 → 171,000——S8 additive 入参批（帧 185,281，
 *  带内）与 S10 `semantic.batchAt` 面（其基帧 185,326）合并后全量帧实拍 **187,557**，超出旧带顶
 *  185,783（+1,774＝两批诚实契约之和）；新带顶 188,100，机械余量 543 B。 */
const B22_FULL_FRAME_BYTES = 171_000;
/** B22 记账下界（约 −3.5%）：还要再瘦必须先改这一格并留下读数，不许把删内容当瘦身。 */
const B22_ACCOUNTED_FLOOR = 163_000;
const BAND = 0.1;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const RUST_MAX_DESCRIPTION_CHARS = 2048;

describe('B22 tools/list 载荷体积＋信息等价闸（注册表真源现场算，非估算）', () => {
  it('① 可见面枚数与 STATE 能力面读数同源：82＝read 40 / edit 13 / privileged 29（MCP-PERF-S10 批 +1 枚 read：semantic.batchAt 批量腿）', () => {
    expect(fullFace).toHaveLength(82);
    expect(readFace).toHaveLength(40);
    expect(editFace).toHaveLength(53); // read + edit；privileged 未点名批准 ⇒ 不上帧
    const byTier = fullFace.reduce<Record<string, number>>((a, t) => {
      a[t.tier] = (a[t.tier] ?? 0) + 1;
      return a;
    }, {});
    expect(byTier).toEqual({ read: 40, edit: 13, privileged: 29 });
    // 缺省会话（未批准任何 privileged）只出 read 面——默认可见面不是全量面。
    expect(registry.listTools(scope('read'))).toHaveLength(40);
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
    // 口径＝schemaDescHits（模块级，⑨ 也用同一把尺）。
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
    // desc 63,000 → 65,000（实拍 64,433）；schema 106,500 → 108,500（实拍 107,873）。
    // MCP-PERF-S8（LaneR 2026-11-07）纯 additive 入参批（零新面）：schema 108,500 → 110,500
    // （其基实拍 109,621）；desc 上界不动（其基实拍 64,912）；frame 185,281 在 B22 带内。
    // MCP-PERF-S10（LaneT 2026-11-07）+1 枚 read 面（semantic.batchAt）：其基实拍 desc 65,643 /
    // schema 108,823 / frame 185,326。三批合并帧（S8 入参 × S10 面，组长合并点实测）：
    // desc 实拍 66,122 / schema 实拍 110,571 / frame 实拍 **187,557** ⇒ desc 67,500、
    // schema 110,500 → 111,000 重钉；frame 超旧带顶 185,783 ⇒ 带底数按例重钉
    // 168,894 → 171,000（新带顶 188,100，机械余量 543 B；下界 163,000 不动）。
    expect(descBytes).toBeLessThanOrEqual(67_500); // B21 实拍 64,851；S4 62,507；S6 64,433；S8 基 64,912；S10 基 65,643
    expect(schemaBytes).toBeLessThanOrEqual(111_000); // B21 143,762；S4 105,841；S6 107,873；S8 基 109,621；S10 基 108,823
    expect(launcherBytes).toBeLessThanOrEqual(75_000); // B21 实拍全族 100,323；S4 实拍 73,706
    expect(schemaBytes).toBeGreaterThan(descBytes); // 口径没被颠倒：瘦掉的是重复，不是内容
  });

  it('⑨ 相对路径共用形状账（MCP-PERF-S15）：ADR-0003 完整口径全局一份，其余抄写点只许指针', () => {
    // 200 字符的 ADR-0003 共用形状说明（RELATIVE_PATH_SCHEMA）原本被 16 枚面逐字抄 18 份
    // （fileTree.rename 的 from/to、diff.compare 的 left/right 各两份；dedup 量具实拍抄写 3,400 B）。
    // S15 照 B22 先例指针化：完整口径保一处，落点＝fileTree.update 的 `properties.relPath`
    // ——fileTree.patchLines 的既有文案「same gate as fileTree.update」早已把它当命名锚点；
    // 其余 17 处只留一句指针。**先红基线**：落地前 18 处逐字重复，数 canonical 当场红。
    // 形状锚＝共用形状 pattern 独有的盘符守卫（`(?![A-Za-z]:)`），与属性名/面名解耦：
    // 谁复用这份形状就得进这本账，别名躲不过、新面漏不掉。
    const CANON_TOKENS = ['Project-root-relative', 'absolute', 'drive-letter', '".."', 'approvedRoots', 'ADR-0003'];
    const shared: { tool: string; addr: string; desc: string }[] = [];
    const walk = (tool: string, addr: string, node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(tool, `${addr}[${i}]`, item));
        return;
      }
      if (node && typeof node === 'object') {
        const o = node as Record<string, unknown>;
        if (o['type'] === 'string' && typeof o['pattern'] === 'string' && o['pattern'].includes('(?![A-Za-z]:)')) {
          shared.push({ tool, addr: addr || '(root)', desc: String(o['description'] ?? '') });
        }
        for (const [k, v] of Object.entries(o)) walk(tool, addr ? `${addr}.${k}` : k, v);
      }
    };
    for (const t of fullFace) walk(t.name, '', t.inputSchema);
    // 形状指纹账：抄写点枚数只许由有意识的批次改动（S15 前后都是 16 枚面 18 处）。
    expect(shared.length, `共用形状抄写点变了：${JSON.stringify(shared.map((s) => `${s.tool}#${s.addr}`))}`).toBe(18);

    const canon = shared.filter((s) => s.desc.includes('ADR-0003'));
    expect(canon.length, `ADR-0003 完整口径必须全局一份，现 ${canon.length} 份（逐字重复＝S15 靶子）`).toBe(1);
    expect(canon[0]!.tool, '完整口径落点必须是 fileTree.update（既有文案的命名锚点）').toBe('fileTree.update');
    expect(canon[0]!.addr, '完整口径落点必须是 properties.relPath').toBe('properties.relPath');
    for (const token of CANON_TOKENS) {
      expect(canon[0]!.desc, `完整口径丢了 ${token}`).toContain(token);
    }
    // 落点真实性：指针指向的那份必须真实存在且完整（⑥ 同款语义的跨面指针版）。
    expect(propDesc(toolByName('fileTree.update'), 'relPath')).toBe(canon[0]!.desc);

    const pointers = shared.filter((s) => s.desc !== canon[0]!.desc);
    expect(pointers.length, '除落点外的 17 处都必须是指针').toBe(17);
    for (const p of pointers) {
      expect(p.desc, `${p.tool}#${p.addr} 指针必须点名落点 \`fileTree.update\``).toContain('`fileTree.update`');
      expect(p.desc, `${p.tool}#${p.addr} 指针必须点名落点属性 \`relPath\``).toContain('`relPath`');
      expect(p.desc, `${p.tool}#${p.addr} 指针仍须自带最小本地语义（project-root-relative）`).toContain('Project-root-relative');
      expect(p.desc, `${p.tool}#${p.addr} 指针不得复刻完整口径（ADR-0003 标记只许一份）`).not.toContain('ADR-0003');
    }
  });
});
