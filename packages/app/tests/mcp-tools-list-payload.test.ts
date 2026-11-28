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
 *  1. **可见面形状**：83 枚具名面（read 40 / edit 13 / privileged 30）、缺省会话（未批准）
 *     只出 read 面 40 枚 —— 与 `docs/STATE.md` 的能力面读数同源；枚数一动这里就红。
 *     B24（LaneAK 2026-11-07）+1 枚 privileged：`commands.run`；合并到 97e9104b（S9-S21、
 *     S15 指针化已落）后按现取实测重钉 ① 枚数、② 帧带底数与 ⑧ 两档上界，对账见 ⑧。
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
 *
 * T1（2026-11-28，第二轮全量指针化）：五组逐字重复结构性收口后现取实测
 * frame **141,889** / desc **60,944** / schema **69,589**，逐字重复 58,045 → **18,227 B（33.1% → 12.8%）**。
 */
import { describe, expect, it } from 'vitest';
import {
  KERNEL_IO_TOOL_SPECS,
  PAGE_ACCOUNT_NOTE,
  PAGE_SIZE_ARG_ALIASES,
  SEMANTIC_TOOL_SPECS,
  SUPPLEMENTAL_TOOL_SPECS,
  TRANSPORT_RESPONSE_LIMIT_BYTES,
  createMcpCapabilityRegistry,
  toolsListFrameBytes,
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
 *  底数重钉其一（2026-11-07，组长 S8×S10 合并点实测）：168,894 → 171,000——合并帧实拍
 *  187,557 超旧带顶 185,783（+1,774＝两批诚实契约之和）。
 *  S15 底数再钉（2026-11-07，LaneY）：171,000 → 170,000——指针化后帧实拍 186,299（−1,258），
 *  只许下调：带顶 188,100 → 187,000。
 *  B24 底数按例重钉（2026-11-07，组长合并点现取实测）：170,000 → 172,000——B24 新增具名面
 *  `commands.run` 后全量帧实拍 **188,356**（判据口径；static 量具 188,361，两通道包装差 5 B），
 *  超 187,000 共 1,356 B；帧增量 +2,057 与该面 wireBytes 2,056 B ＋ 1 个 JSON 逗号精确对账
 *  （desc +1,187 / schema +711 亦逐项对上，见 ⑧）。按 S10/S15 先例处置；BAND 0.1 与记账
 *  下界 163,000 一字不动，新带顶 189,200，机械余量 844 B。
 *  ⚠ 连续第三次按例重钉：下一批再增面之前**必须先做去重瘦身**，不许再抬底数或抬 BAND 过闸。
 *  B25 底数按例重钉（2026-11-07，组长合并点现取实测）：172,000 → 177,000——文件族缺口三面
 *  （`fs.copyFile` / `fs.ensureDir` / `fs.readFileBytes`）合并后全量帧实拍 **193,889**
 *  （static 量具；判据口径 193,884，两通道包装差 5 B），超 189,200 共 4,689 B。
 *  **本批先做了批内去重瘦身再重钉**（兑现上一批的 ⚠）：三面顶层描述按 B22 纪律瘦身影响
 *  −289 B（描述闸口径 recap 改指针），四枚新路径形状全部走 S15 `RELATIVE_PATH_PTR_SCHEMA`
 *  指针版（完整口径仍只在 `fileTree.update` 一份）；帧增量 +5,528 与三面 wireBytes
 *  （desc +2,846 / schema +2,354 / 其余为入参帧结构）逐项对账见 ⑧。BAND 0.1 与记账
 *  下界 163,000 一字不动，新带顶 194,700，机械余量 811 B。
 *  ⚠ 连续第四次按例重钉：**下一批增面前必须先做一整轮 S15 式全量指针化瘦身**
 *  （rootId 样板句 7 处 1,543 B 只是已点名的第一刀），不许再抬底数或抬 BAND 过闸。
 *  B27 兑现（2026-11-06，workbuddy）：**先瘦后钉**——四族共用形状（rootId 327×9 / cursor 245×26 /
 *  instanceId 188×19 / componentId 159×12）与 9 处 rootId 样板句全部按 S15 同形指针化（spread 保形，
 *  type/pattern/长度闸零改动，完整口径各只留一处：fileTree.update.rootId / fs.readFile.cursor /
 *  launcher_instance_get.instanceId / launcher_log_read.sessionId），由 ⑩ 形状指针账钉住。
 *  现取实测：desc **69,993**（−162）/ schema **107,026**（−5,352）/ frame **188,375**（−5,514，
 *  static 量具；判据口径 −5 B）。按现取收紧：desc 70,500 → 70,300（余量 307）、schema 112,900 →
 *  108,000（余量 974）；帧带底数只许下调 177,000 → 172,200（新带顶 189,420，机械余量 1,045 B）。
 *  BAND 0.1 与记账下界 163,000 一字不动；下一批增面前仍须先瘦再钉。
 *  T1 底数按例重钉（2026-11-28，第二轮全量指针化）：172,200 → **140,000**——五组逐字重复
 *  （limit 全文 / PAGE_SIZE_ALIAS_POINTER / PAGE_ACCOUNT_NOTE / cursor / instanceId）结构性
 *  收口后全量帧实拍 **141,889**（static 量具；判据口径 −5 B），记账下界 163,000 → **135,000**
 *  （约 −3.5%），新带顶 154,000，机械余量 12,111 B。
 *  T2 底数再钉（2026-11-28，`initialize.instructions` + 特权档位尾注收口）：**140,000 → 130,000**。
 *  本轮不增面、只搬字：27 枚 launcher_* 面的 187 字符尾注 → 102 字符（每面 −85 B），
 *  并把同一条短尾注补给 3 枚原本没挂它的特权面（fileTree.remove / fileTree.rename /
 *  commands.run，每面 +103 B＝1 个空格 + 102）。判据口径实拍 **139,898**（desc 58,958 /
 *  schema 69,589 / launcher 46,305），上一轮 141,889 → 本轮 139,898（−1,991）。
 *  新带顶 143,000，机械余量 **3,102 B**（≥2,000 B 的增面余量：一枚中位面 ~1,200–2,100 B）。
 *  schema 本批零变化（69,589），上界 70,200 不动——不为本批方便而放宽。 */
const B22_FULL_FRAME_BYTES = 130_000;
/** B22 记账下界（约 −3.5%）：还要再瘦必须先改这一格并留下读数，不许把删内容当瘦身。
 *  T1：163,000 → 135,000（帧 175,337 → 141,889 后按例下调，仍留 ~3.5% 记账余量）。
 *  T2：135,000 不动——新实拍 139,898 的 −3.5% 恰好是 135,002，这一格本来就在设计位上；
 *  抬它只会挡住后续合法瘦身，没有额外信息。 */
const B22_ACCOUNTED_FLOOR = 135_000;
const BAND = 0.1;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const RUST_MAX_DESCRIPTION_CHARS = 2048;

describe('B22 tools/list 载荷体积＋信息等价闸（注册表真源现场算，非估算）', () => {
  it('① 可见面枚数与 STATE 能力面读数同源：86＝read 41 / edit 15 / privileged 30（B25 批 +2 枚 edit：fs.copyFile / fs.ensureDir ＋ +1 枚 read：fs.readFileBytes）', () => {
    expect(fullFace).toHaveLength(86);
    expect(readFace).toHaveLength(41);
    expect(editFace).toHaveLength(56); // read + edit；privileged 未点名批准 ⇒ 不上帧
    const byTier = fullFace.reduce<Record<string, number>>((a, t) => {
      a[t.tier] = (a[t.tier] ?? 0) + 1;
      return a;
    }, {});
    expect(byTier).toEqual({ read: 41, edit: 15, privileged: 30 });
    // 缺省会话（未批准任何 privileged）只出 read 面——默认可见面不是全量面。
    expect(registry.listTools(scope('read'))).toHaveLength(41);
  });

  it('② 全量帧落在 B22 实拍带内（±10% 上界护栏）且不低于 B22 记账下界', () => {
    const n = frameBytes(fullFace);
    expect(n).toBeGreaterThanOrEqual(Math.round(B22_FULL_FRAME_BYTES * (1 - BAND)));
    expect(n).toBeLessThanOrEqual(Math.round(B22_FULL_FRAME_BYTES * (1 + BAND)));
    expect(n).toBeGreaterThanOrEqual(B22_ACCOUNTED_FLOOR);
    // 去重前的读数 B21_FULL_FRAME_BYTES 只留着核对 Δ：218,897 → 168,894（−50,003 B＝−22.8%）。
    expect(B22_FULL_FRAME_BYTES).toBeLessThan(B21_FULL_FRAME_BYTES);
  });

  it('②b 单一量具（WP-6a）：本文件的 frameBytes 与运行时 `toolsListFrameBytes` 逐字节相等', () => {
    // 能力面资源 `kojo://server/capability-face` 报给模型的帧字节用的是同一个函数。
    // 这条钉的是「测试钉的数」与「模型读到的数」不许分叉：谁改量具口径，两边一起变；
    // 谁在本文件另起一份量法，这里当场红。
    expect(frameBytes(fullFace)).toBe(toolsListFrameBytes(fullFace, 'b22'));
    expect(MAX_RESPONSE_BYTES).toBe(TRANSPORT_RESPONSE_LIMIT_BYTES);
    // 同一个 id 才算同一帧：id 不同字节数必然不同，这条防止有人「顺手」改了调用侧的 id 还声称没差。
    expect(toolsListFrameBytes(fullFace, 'b22')).not.toBe(toolsListFrameBytes(fullFace, 'b22-longer-id'));
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

  it('⑥ 指针落点：页大小完整口径全局一份（落点 fs.readFile），其余分页面只许指针', () => {
    // T1 批（第二轮全量指针化）：完整页大小口径从「每枚面一份」收成「全局一份」——
    // 落点＝`fs.readFile` 的 `properties.limit`（PAGE_SIZE_CANON_NOTE），其余 25 枚分页面
    // 的 `limit` 只写一句指向落点的指针（同一条 tools/list 记录内，客户端零额外跳转）。
    // 描述侧页账同理：完整口径（PAGE_ACCOUNT_NOTE）只留 `fs.readFile` 的 description，
    // 其余 23 面只挂 `PAGE_ACCOUNT_POINTER`。落点缺一个 token 就红。
    const CANON_TOKENS = [
      'ONE knob',
      'never widened',
      'limit > length > maxChars > maxResults > maxEntries > maxRanges > maxEvents > maxLines',
      'additionalProperties:false',
      'full legal list',
    ];
    const canonFaces: string[] = [];
    const pointerFaces: string[] = [];
    for (const t of fullFace) {
      const limitDesc = propDesc(t, 'limit');
      if (!limitDesc) continue;
      if (CANON_TOKENS.every((token) => limitDesc.includes(token))) {
        canonFaces.push(t.name);
      } else {
        // 不是完整口径 ⇒ 必须是指向唯一落点的指针，且点名落点属性。
        expect(limitDesc, `${t.name}.limit 既不是完整口径、也不是指向 \`fs.readFile\` 的指针`).toContain('`fs.readFile`');
        expect(limitDesc, `${t.name}.limit 指针必须点名落点属性 \`limit\``).toContain('`limit`');
        pointerFaces.push(t.name);
      }
      // 本面声明了 `limit` 之外的页大小别名 ⇒ 别名必须说明「同一旋钮 + 拒收规则同源」。
      const aliasSiblings = PAGE_SIZE_ARG_ALIASES.filter((a) => a !== 'limit' && propOf(t, a) !== undefined);
      for (const alias of aliasSiblings) {
        const d = propDesc(t, alias);
        expect(d, `${t.name}.${alias} 没有说明与 \`limit\` 同一旋钮`).toContain('`limit`');
        expect(d, `${t.name}.${alias} 没有说明拒收规则同源`).toContain('reject rule');
      }
    }
    // 完整口径全局恰好一份，落点＝fs.readFile；其余 25 枚分页面全部是指针。
    expect(canonFaces, '完整页大小口径必须全局一份，落点 fs.readFile').toEqual(['fs.readFile']);
    expect(pointerFaces.length, `除落点外的分页面必须全是指针（现 ${pointerFaces.length}）`).toBe(25);
    for (const token of CANON_TOKENS) {
      expect(propDesc(toolByName('fs.readFile'), 'limit'), `页大小落点缺 token：${token}`).toContain(token);
    }

    // 描述侧页账：完整口径（PAGE_ACCOUNT_NOTE）只许在 fs.readFile 一处，其余 23 面只许指针。
    const noteHosts = fullFace.filter((t) => (t.description ?? '').includes(PAGE_ACCOUNT_NOTE));
    expect(noteHosts.map((t) => t.name), '页账完整口径必须全局一份，落点 fs.readFile').toEqual(['fs.readFile']);
    const ACCOUNT_PTR_MARK = 'Page account (field list, nextCursor, changedDuringPaging';
    const ptrHosts = fullFace.filter((t) => (t.description ?? '').includes(ACCOUNT_PTR_MARK));
    expect(ptrHosts.length, `其余 23 枚分页面必须挂页账指针（现 ${ptrHosts.length}）`).toBe(23);
    for (const t of ptrHosts) {
      expect(t.description ?? '', `${t.name} 的页账指针必须点名落点 \`fs.readFile\``).toContain('`fs.readFile`');
      expect(t.description ?? '', `${t.name} 的页账指针不得复刻完整口径`).not.toContain(PAGE_ACCOUNT_NOTE);
    }

    // 启动器族的档位尾注：逐字共用，但只许出现在真的 privileged 的 launcher_* 面上。
    // T2 收口：可见性规则（「未批准不出现在 tools/list」/「只认精确名」/「通配不算批准」）
    // 搬进 `initialize.instructions` 全局一份——那句话只对「看不见这枚工具」的模型有意义，
    // 而那种会话读不到这枚工具的描述，它在唯一适用的场景里不可读。面上只留模型此刻
    // 用得上的三件：这是特权档、宿主闸门管每次调用、规则去哪读。
    // 搬走的那三条不许凭空消失：由 mcp-initialize-instructions.test.ts 的 S4 从 protocol.rs
    // 的同源字面量里逐条钉住（tools/list / EXACT name / wildcard … approves nothing）。
    const tierTokens = ['Tier: privileged', 'host approval still gates every call', '`initialize`', 'instructions'];
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
      // T1：页账完整口径（PAGE_ACCOUNT_NOTE）的落点已收口到本面 description，故把账上
      // 只有完整口径才有的 token（total / fingerprint）一并钉在本面——删了落点这里当场红。
      'fs.readFile': ['24000', '65000', '65536', 'textLength', 'changedDuringPaging', 'Never writes to disk', 'approvedRoots', 'total', 'fingerprint'],
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
    // MCP-PERF-S6 批 +1（fileTree.patchLines 的 relPath 同用 RELATIVE_PATH_SCHEMA）→ 计 18 处逐字重复。
    // MCP-PERF-S15 批指针化：完整口径收进 fileTree.update 的 properties.relPath，其余 17 处换
    // RELATIVE_PATH_PTR_SCHEMA 指针（不带 ADR-0003 标记）⇒ 标记计数 18 → **1**；抄写点总枚数
    // 仍是 18（按形状锚对账，见 ⑨）。
    expect(relPathHosts.length).toBe(1);
    for (const d of relPathHosts) {
      for (const token of ['Project-root-relative', 'absolute', 'drive-letter', '".."', 'approvedRoots', 'ADR-0003']) {
        expect(d, `相对路径说明丢了 ${token}`).toContain(token);
      }
    }
    // B27（S15 式全量指针化批）：`rootId` 完整口径收进 `fileTree.update` 的 `properties.rootId`，
    // 其余 8 处换 `ROOT_ID_PTR_SCHEMA` 指针 ⇒ 计数锚（`approvedRootIds` 只许在完整口径里出现）＝1。
    const rootIdHosts = fullFace.flatMap((t) => schemaDescHits(t, 'approvedRootIds'));
    expect(rootIdHosts.length).toBe(1);
    for (const d of rootIdHosts) {
      for (const token of ['NOT a path', 'io.workspaceRoots', 'approvedRootIds', 'Omit to stay on the current project root', 'ws: + 8 lowercase hex']) {
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
    // MCP-PERF-S15（LaneY 2026-11-07）schema 侧 ADR-0003 共用形状说明指针化（17 处 200→128 字符，
    // desc 档本批零变化）：schema 实拍 110,571 → **109,313**（−1,258）/ frame 实拍 187,557 →
    // **186,299** ⇒ 只许下调：schema 111,000 → 109,700、desc 67,500 → 66,500（按现取收紧，
    // 实拍 66,122 未动）；frame 带底数 171,000 → 170,000（新带顶 187,000，机械余量 701 B）。
    // B24（LaneAK 2026-11-07）+1 枚 privileged 面（commands.run），合并到 97e9104b 后现取实测：
    // desc **67,309** / schema **110,024** / launcher 73,706 / frame **188,356**（判据口径）。
    // 逐项对账：desc 66,122 ＋ 1,187（该面 description 1,187 B）＝ 67,309；
    //           schema 109,313 ＋ 711（该面 inputSchema 711 B）＝ 110,024；
    //           frame 186,299 ＋ 2,057（该面 wire 2,056 B ＋ 1 个 JSON 逗号）＝ 188,356；
    //           launcher 73,706 与 S6 起各批持平 ⇒ 增量全部来自这一枚新面，别处没有膨胀。
    // 按现取实测重钉：desc 66,500 → 68,000（余量 691 B）、schema 109,700 → 111,000（余量 976 B）；
    // launcher 75,000、2048 描述闸、BAND 0.1、记账下界 163,000 一字不动；帧带底数见 ② 上方注释。
    // B27（workbuddy 2026-11-06）先瘦后钉：四族共用形状 + rootId 样板句指针化后现取实测
    // desc 69,993 / schema 107,026 / frame 188,375（static 量具；判据口径 −5 B）。
    // WP-4（workbuddy 2026-11-28）先瘦后钉：三处共享文案压缩（PAGE_SIZE_ALIAS_POINTER 180→101、
    // PAGE_ACCOUNT_NOTE 480→423、LAUNCHER_TIER_NOTE 222→190，语义 token 一个没丢）后现取实测
    // desc 67,926 / schema 96,055 / frame 175,337（static 量具；判据口径 −5 B）。
    // 按现取收紧：desc 70,300 → 68,800、schema 108,000 → 97,200、帧带底数 172,200 → 168,000；
    // launcher 75,000 与 2048 描述闸、BAND 0.1、记账下界 163,000 一字不动。
    // T1（2026-11-28）第二轮全量指针化：limit 全文 / 别名指针 / PAGE_ACCOUNT_NOTE / cursor /
    // instanceId 五组结构性收口后现取实测 desc **60,944** / schema **69,589** / launcher 48,600 /
    // frame **141,889**（static 量具；判据口径 −5 B）。上一轮读数 → 本轮读数：
    // desc 67,926 → 60,944、schema 96,055 → 69,589、frame 175,337 → 141,889。
    // 按现取收紧：desc 68,800 → 61,500、schema 97,200 → 70,200；launcher 75,000 与 2048
    // 描述闸、BAND 0.1、记账下界 135,000 一字不动。
    // T2（2026-11-28）`initialize.instructions` 落地 + 特权档位尾注 187 → 102 字符收口后现取实测
    // desc **58,958** / schema **69,589** / launcher **46,305** / frame **139,898**（判据口径；
    // static 量具 139,903，两通道包装差 5 B）。上一轮读数 → 本轮读数：
    // desc 60,944 → 58,958（−1,986）、schema 69,589 → 69,589（0，本批不碰 schema）、
    // frame 141,889 → 139,898（−1,991）。
    // 按现取收紧（余量都 ≥2,000 B）：desc 61,500 → 61,000（余量 2,042）、launcher 75,000 →
    // 48,500（余量 2,195）；schema 70,200 **不动**（本批零变化，不放宽也不收紧）。
    expect(descBytes).toBeLessThanOrEqual(61_000); // …T1 60,944；T2 收口后 58,958
    expect(schemaBytes).toBeLessThanOrEqual(70_200); // T1 69,589；T2 本批零变化（69,589）
    expect(launcherBytes).toBeLessThanOrEqual(48_500); // B21 实拍全族 100,323；T2 实拍 46,305
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
    // 形状指纹账：抄写点枚数只许由有意识的批次改动（S15 前 16 枚面 18 处；B25 +4 处＝22——
    // copyFile 的 srcRelPath/relPath、ensureDir 的 relPath、readFileBytes 的 relPath，全走指针版）。
    expect(shared.length, `共用形状抄写点变了：${JSON.stringify(shared.map((s) => `${s.tool}#${s.addr}`))}`).toBe(22);

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
    // B25 批：抄写点 18 → 22 ⇒ 指针 17 → 21（新四处全走指针版，完整口径仍只有落点一份）。
    expect(pointers.length, '除落点外的 21 处都必须是指针').toBe(21);
    for (const p of pointers) {
      expect(p.desc, `${p.tool}#${p.addr} 指针必须点名落点 \`fileTree.update\``).toContain('`fileTree.update`');
      expect(p.desc, `${p.tool}#${p.addr} 指针必须点名落点属性 \`relPath\``).toContain('`relPath`');
      expect(p.desc, `${p.tool}#${p.addr} 指针仍须自带最小本地语义（project-root-relative）`).toContain('Project-root-relative');
      expect(p.desc, `${p.tool}#${p.addr} 指针不得复刻完整口径（ADR-0003 标记只许一份）`).not.toContain('ADR-0003');
    }
  });

  it('⑩ 形状指针账（B27 全量指针化）：rootId / cursor / instanceId / componentId 完整口径各一份，其余抄写点只许指针', () => {
    // 靶子（dedup 量具实拍）：rootId 327 字符 ×9、cursor 245×27、instanceId 188×19、componentId 159×12。
    // 处理与 S15 完全同形：spread 保形（type/pattern/长度闸零改动），只有 description 换成指针。
    type Family = {
      label: string;
      pattern: string;
      anchorTool: string;
      anchorProp: string;
      canonMark: string; // 只许完整口径出现的计数锚
      canonTokens: readonly string[];
      ptrTokens: readonly string[];
      count: number;
    };
    const FAMILIES: readonly Family[] = [
      {
        label: 'rootId',
        pattern: '^ws:[0-9a-f]{8}$',
        anchorTool: 'fileTree.update',
        anchorProp: 'rootId',
        canonMark: 'approvedRootIds',
        canonTokens: ['NOT a path', 'io.workspaceRoots', 'approvedRootIds', 'Omit to stay on the current project root'],
        ptrTokens: ['`fileTree.update`', '`rootId`', 'workspace root'],
        count: 9,
      },
      {
        label: 'cursor',
        pattern: '^[0-9a-f]{8}:\\d{1,10}$',
        anchorTool: 'fs.readFile',
        anchorProp: 'cursor',
        canonMark: 'changedDuringPaging',
        canonTokens: ['nextCursor', 'changedDuringPaging', 'spliced'],
        ptrTokens: ['`fs.readFile`', '`cursor`', 'nextCursor'],
        count: 26,
      },
      {
        label: 'instanceId',
        pattern: '^[A-Za-z0-9-]+$',
        anchorTool: 'launcher_instance_get',
        anchorProp: 'instanceId',
        canonMark: "Host's own shape gate",
        canonTokens: ['never invent one', "'-'", '1..64'],
        ptrTokens: ['`launcher_instance_get`', '`instanceId`', 'never invent one'],
        count: 19,
      },
      {
        label: 'componentId',
        pattern: '^(?!\\.)[A-Za-z0-9._-]+$',
        anchorTool: 'launcher_log_read',
        anchorProp: 'sessionId',
        canonMark: 'no leading dot',
        canonTokens: ['pack / plan / backup / session id', 'no leading dot', 'max 64'],
        ptrTokens: ['`launcher_log_read`', '`sessionId`', 'verbatim'],
        count: 12,
      },
    ];

    const collect = (pattern: string): { tool: string; addr: string; desc: string }[] => {
      const hits: { tool: string; addr: string; desc: string }[] = [];
      const walk = (tool: string, addr: string, node: unknown): void => {
        if (Array.isArray(node)) {
          node.forEach((item, i) => walk(tool, `${addr}[${i}]`, item));
          return;
        }
        if (node && typeof node === 'object') {
          const o = node as Record<string, unknown>;
          if (o['type'] === 'string' && o['pattern'] === pattern) {
            hits.push({ tool, addr: addr || '(root)', desc: String(o['description'] ?? '') });
          }
          for (const [k, v] of Object.entries(o)) walk(tool, addr ? `${addr}.${k}` : k, v);
        }
      };
      for (const t of fullFace) walk(t.name, '', t.inputSchema);
      return hits;
    };

    for (const f of FAMILIES) {
      const hits = collect(f.pattern);
      expect(hits.length, `${f.label} 抄写点枚数变了：${JSON.stringify(hits.map((h) => `${h.tool}#${h.addr}`))}`).toBe(f.count);
      const canon = hits.filter((h) => h.desc.includes(f.canonMark));
      expect(canon.length, `${f.label} 完整口径必须全局一份，现 ${canon.length} 份`).toBe(1);
      expect(canon[0]!.tool, `${f.label} 完整口径落点面`).toBe(f.anchorTool);
      expect(canon[0]!.addr, `${f.label} 完整口径落点属性`).toBe(`properties.${f.anchorProp}`);
      for (const token of f.canonTokens) {
        expect(canon[0]!.desc, `${f.label} 完整口径丢了 ${token}`).toContain(token);
      }
      // 落点真实性：指针指向的那份必须真实存在且完整。
      expect(propDesc(toolByName(f.anchorTool), f.anchorProp)).toBe(canon[0]!.desc);
      const pointers = hits.filter((h) => h.desc !== canon[0]!.desc);
      expect(pointers.length, `${f.label} 除落点外必须全是指针`).toBe(f.count - 1);
      for (const p of pointers) {
        for (const token of f.ptrTokens) {
          expect(p.desc, `${f.label} 指针 ${p.tool}#${p.addr} 缺 ${token}`).toContain(token);
        }
        expect(p.desc, `${f.label} 指针 ${p.tool}#${p.addr} 不得复刻完整口径（${f.canonMark} 只许一份）`).not.toContain(f.canonMark);
      }
    }
  });
});
