/**
 * MCP 能力盘点（P0 契约 · 路 A）。
 *
 * 一份**只读、可复跑**的草案生成器：`--print` 时 rc=0，输出 JSON（内含 `markdown` 草案字段）；
 * 加 `--markdown` 时只输出 Markdown 草案。它把「编辑器有哪些能力可以开放给外部 AI」这一问，
 * 落成四处**真源**的静态盘点，供 ADR-0013 的工具 / 资源 / 提示词分级做输入。
 *
 * 四处真源（逐字按当前树解析，**不假设其它两路并发改动**）：
 *  1. `packages/app/src/ui/commands.ts` —— 命令注册表构造（`buildCommandRegistry` /
 *     `CommandEntry` / `ShellCommandSpec`）；命令 id 字面量散落在 `src/ui/**` 的规格对象里。
 *  2. `packages/app/src-tauri/src/lib.rs` —— `tauri::generate_handler![...]` 的 Rust 命令清单。
 *  3. `packages/app/src/debug/install-debug.ts` —— `KojoDebugApi.editor` 语义读数面方法。
 *  4. `packages/plugins/*` —— `slots.register('槽', { id })` 槽贡献。
 *
 * 产出：命令数 / Rust 命令数 / 语义读数数 / **未登记成命令的缺口清单**
 * （Rust 命令、调试读数、非 `editor.command` 的槽贡献，凡名字不在命令注册表里即列为缺口）。
 * 第三波（路 B）：另加一处 **best-effort 参考源** `packages/mcp-host/src/index.ts`，解析
 * `*_TOOL_SPECS` 得**按 tier 分组的工具覆盖率**（tools 总数 / read / edit / privileged），
 * 并用 `MCP_TOOL_GAP_MAP` 交叉校验「工具 → 真源缺口」的覆盖关系、`MCP_DEFERRED_GAP_NOTES`
 * 显式标注无真源的缺口类别，最终给出**剩余缺口与逐条原因**。声明对不上真实工具/缺口
 * 一律降级为「未覆盖」并列出 `orphanedWires`（铁律 4：不静默、不假绿、不伪造读数）。
 * 该参考源缺席时统计为空、不判红、**不进 `missingSources`**（四处真源口径逐字不变）。
 *
 * 解析方式均为**源码形状正则**（不 import、不执行、不启动内核）：与 `audit-decoupling.mjs`
 * 同一族纪律。缺文件不崩、不猜——`missingSources` 如实列出，该源读数为 0。
 *
 * 用法：
 *   node tools/mcp-inventory.mjs --print
 *   node tools/mcp-inventory.mjs --print --markdown
 *   node tools/mcp-inventory.mjs --json                   # 机器可读摘要（稳定 schema，见下）
 *   node tools/mcp-inventory.mjs --root <dir> --print     # 对拍夹具（见 tools/tests/mcp-inventory.test.ts）
 *
 * 输出格式优先级：`--markdown`（人类草案）> `--json`（机器摘要）> `--print` / 缺省（全量 JSON）。
 *
 * `--json` 机器摘要（自身 schemaVersion 从 1 起，与全量 JSON 的 SCHEMA_VERSION 独立演进）：
 *   { schemaVersion, generatedBy, counts, gaps[], writeLegs }
 *   - counts：命令 / Rust 命令 / 语义读数 / 槽贡献 / tools 按 tier / 缺口三计数 / 缺源数；
 *   - gaps：**全量缺口数组**（含已接线），每条 `{ source, name, tool, wired, reasonClass,
 *     wiringCost, suggestedPriority }`——wired 条目 tool=覆盖该缺口的具名工具、reasonClass='wired'、
 *     suggestedPriority=null；
 *   - writeLegs：写腿状态段（见下）。
 *
 * 写腿状态段（writeLegs）：registry（*_TOOL_SPECS）里 tier 非 read 的具名工具逐条判读
 * `{ tool, tier, gap, gapRegistered, wired, evidence }`——wired 判定读两处**真源腿表**
 * （real-sources-io.ts 的 ioTools ∪ real-sources.ts 的 buildUiSupplemental），缺口登记读
 * MCP_TOOL_GAP_MAP，**不硬编码、不猜**；腿源缺席时如实标注（sourcesMissing）。
 *
 * 退出码：0 = 完成（盘点草案不是质量闸，缺源不判红）；2 = 参数错。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 2;

const SOURCES = Object.freeze({
  commands: 'packages/app/src/ui/commands.ts',
  rust: 'packages/app/src-tauri/src/lib.rs',
  debug: 'packages/app/src/debug/install-debug.ts',
  pluginsDir: 'packages/plugins',
  uiDir: 'packages/app/src/ui',
  // best-effort 参考源（第三波）：能力面工具清单 / tier 分组 / 覆盖登记；缺席不进 missingSources。
  host: 'packages/mcp-host/src/index.ts',
  // 写腿真源腿表（写腿状态段判 wired 用）：宿主注入执行体的两处腿表；缺席不进 missingSources，
  // 但在 writeLegs.sourcesMissing 如实列出（不猜、不假绿）。
  ioLegs: 'packages/app/src/mcp/real-sources-io.ts',
  uiLegs: 'packages/app/src/mcp/real-sources.ts',
});

/** 只列的源码文件（跳过构建产物 / 依赖 / 测试夹具），按相对路径稳定排序。 */
async function walkFiles(dirAbs, exts) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'target') continue;
      out.push(...(await walkFiles(path.join(dirAbs, e.name), exts)));
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(path.join(dirAbs, e.name));
    }
  }
  return out.sort();
}

async function readText(fileAbs) {
  try {
    return await fs.readFile(fileAbs, 'utf8');
  } catch {
    return null;
  }
}

/* ---------------- 1. 命令注册表 + 命令 id ---------------- */

/**
 * 命令 id 来自 `src/ui/**` 里 `ShellCommandSpec` / `EditorCommandContribution` 形状的规格对象：
 * 一行出现 `id: '<字面量>'`，且**同一个对象**（到下一个 `id:` 字面量或 +8 行窗口）里同时出现
 * `title:` 与 `run`/`run(`，才算一条命令规格。这样既收单行规格，也收多行规格，
 * 又不会把面板 id / 事件名这类别的 `id:` 误计成命令。
 */
function commandIdsFromUi(texts) {
  const ids = new Set();
  for (const text of texts) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = /\bid:\s*['"]([A-Za-z0-9_.\-]+)['"]/.exec(lines[i] ?? '');
      if (!m) continue;
      let end = i + 1;
      while (end < lines.length && end < i + 9 && !/\bid:\s*['"]/.test(lines[end] ?? '')) end++;
      const window = lines.slice(i, end).join('\n');
      if (/\btitle\s*:/.test(window) && /\brun\s*[:(]/.test(window)) ids.add(m[1]);
    }
  }
  return [...ids].sort();
}

function registryConstruction(text) {
  return {
    buildCommandRegistry: /function\s+buildCommandRegistry\b/.test(text),
    commandEntry: /interface\s+CommandEntry\b/.test(text),
    shellCommandSpec: /interface\s+ShellCommandSpec\b/.test(text),
  };
}

/* ---------------- 2. Rust generate_handler! ---------------- */

/** 取 `generate_handler![ ... ])` 块里的标识符；带命名空间时取最后一段（`launcher::commands::x` → `x`）。 */
function rustCommandsFromLib(text) {
  const m = /generate_handler!\s*\[([\s\S]*?)\]\s*\)/.exec(text);
  if (!m) return [];
  const names = new Set();
  for (const raw of m[1].split(/[,\n]/)) {
    const tok = raw.replace(/\/\/.*$/, '').trim();
    if (!tok) continue;
    const seg = tok.split('::').pop().trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(seg)) names.add(seg);
  }
  return [...names].sort();
}

/* ---------------- 3. KojoDebugApi.editor 语义读数面 ---------------- */

/**
 * 取接口里 `  editor: {` 到同缩进 `  };` 之间的方法声明名。
 * 剥掉注释行再匹配 `name(params):`——`[^)]*` 允许参数跨行（多行签名），
 * editor 块内参数无嵌套括号，故不会越界。这个数就是「语义读数面」方法数
 * （含只读读数与少量写入口；盘点口径按面统计，不替调用方分读写）。
 */
function semanticReadsFromDebug(text) {
  const start = text.indexOf('\n  editor: {');
  if (start < 0) return { found: false, methods: [] };
  const rest = text.slice(start + 1);
  const close = /\n  \};/.exec(rest);
  const block = close ? rest.slice(0, close.index) : rest;
  const code = block
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('*') || t.startsWith('/') || t.startsWith('//') || t === '');
    })
    .join('\n');
  const names = new Set(
    [...code.matchAll(/^\s{4,}([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*:/gm)].map((x) => x[1]),
  );
  return { found: true, methods: [...names].sort() };
}

/* ---------------- 4. 插件槽贡献 ---------------- */

/** 逐文件找 `.slots.register('槽', { ... id: '<字面量>' })`；动态（模板字符串）id 记 `id: null`。 */
function slotContributionsFromPlugins(texts) {
  const out = [];
  for (const text of texts) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = /\.slots\.register\(\s*['"]([^'"]+)['"]\s*,\s*\{/.exec(lines[i] ?? '');
      if (!m) continue;
      let id = null;
      for (let j = i; j < Math.min(lines.length, i + 20); j++) {
        const im = /\bid:\s*['"]([^'"]+)['"]/.exec(lines[j] ?? '');
        if (im) {
          id = im[1];
          break;
        }
      }
      out.push({ slot: m[1], id });
    }
  }
  return out;
}

/* ---------------- 5. mcp-host 能力面参考源（best-effort，按源码锚解析） ---------------- */

/**
 * 取三个 *_TOOL_SPECS 数组块：块内 `name:'…'` 得工具名，块内 `tier:'read|edit|privileged'`
 * 字面量得 tier 分组计数；并按「name 在前、tier 随后」的源码顺序把每个工具名配到它的 tier
 * （写腿状态段需要逐工具 tier，不只分组计数）。只统计工具规格块，不碰 resource / prompt 清单。
 * 文件/块缺席 ⇒ 空清单，绝不猜、绝不假绿。
 */
function parseHostCatalog(text) {
  const names = [];
  const byTier = { read: 0, edit: 0, privileged: 0 };
  const tiers = {};
  if (!text) return { names, byTier, tiers };
  const blocks = [
    ...text.matchAll(/export const (?:SEMANTIC|KERNEL_IO|SUPPLEMENTAL)_TOOL_SPECS[^=]*=\s*\[([\s\S]*?)\n\];/g),
  ].map((m) => m[1]);
  for (const block of blocks) {
    for (const m of block.matchAll(/\bname:\s*'([^']+)'/g)) names.push(m[1]);
    for (const m of block.matchAll(/\btier:\s*'(read|edit|privileged)'/g)) byTier[m[1]]++;
    // name → tier 配对：规格对象里 tier 字面量总在其 name 之后（三组规格逐条核对过的形状）。
    let last = null;
    for (const m of block.matchAll(/\b(?:name|tier):\s*'([^']+)'/g)) {
      if (m[0].startsWith('name')) last = m[1];
      else if (last !== null && !(last in tiers)) tiers[last] = m[1];
    }
  }
  return { names, byTier, tiers };
}

/** 逐行解析 MCP_TOOL_GAP_MAP 的 `{ tool:'…', gap:'…', source:'…' }` 字面量。 */
function parseWiredMap(text) {
  if (!text) return [];
  const m = /export const MCP_TOOL_GAP_MAP[^=]*=\s*\[([\s\S]*?)\n\];/.exec(text);
  if (!m) return [];
  return [...m[1].matchAll(/\{\s*tool:\s*'([^']+)',\s*gap:\s*'([^']+)',\s*source:\s*'(rust|debug|tool-surface)'\s*\}/g)]
    .map((x) => ({ tool: x[1], gap: x[2], source: x[3] }));
}

/** 逐行解析 MCP_DEFERRED_GAP_NOTES 的 `{ scope:'…', reason:'…' }` 字面量。 */
function parseDeferredNotes(text) {
  if (!text) return [];
  const m = /export const MCP_DEFERRED_GAP_NOTES[^=]*=\s*\[([\s\S]*?)\n\];/.exec(text);
  if (!m) return [];
  return [...m[1].matchAll(/\{\s*scope:\s*'([^']*)',\s*reason:\s*'([^']*)'\s*\}/g)]
    .map((x) => ({ scope: x[1], reason: x[2] }));
}

/**
 * 解析「真源腿表」：源文件里 `new Map<string, …>([ ['工具名', 标识符], … ])` 形状的腿表
 * （real-sources-io.ts 的 ioTools、real-sources.ts 的 buildUiSupplemental 返回值）。
 * 类型参数里可能含 `=>` / 嵌套 `<>`，故从 `new Map<string,` 惰性吞到第一个 `([` 再取条目。
 * 条目形状 = `['含点工具名', 标识符]`；返回腿表里出现过的工具名（去重前保持源码序）。
 */
function parseLegMaps(text) {
  if (!text) return [];
  const out = [];
  for (const m of text.matchAll(/new Map<string,[\s\S]*?\(\s*\[([\s\S]*?)\]\s*\)/g)) {
    for (const e of m[1].matchAll(/\[\s*'([^']+)'\s*,\s*[A-Za-z_$][\w$]*\s*\]/g)) out.push(e[1]);
  }
  return out;
}

/** wired 缺口在机器摘要里的 reasonClass 常量（与 unwired 的原因文本互斥）。 */
const WIRED_REASON_CLASS = 'wired';

/* ---------------- 接线成本启发式（机器摘要 wiringCost / suggestedPriority） ----------------
 *
 * 四类成本 + unknown（保守），判据全部来自「缺口名 + 所在真源 + 既有 deferredReason 归因」，
 * 不读运行时、不猜实现状态；**宁可 unknown 也不乱猜**：
 *
 *  - 'cheap-read'：真源已在、只差登记。deferredReason 的「只读原语」「语义读数」两类：
 *    Rust 命令 / debug 读数面已存在，补一条 *_TOOL_SPECS 登记即可——第三波 12 具具名工具与
 *    真源腿表（ioTools）都验证过这条路最便宜。分类**继承既有归因**，不另设只读判据。
 *  - 'needs-write-domain'：要写域授权链。文件系统写原语（append_ / create_ / copy_file /
 *    write_ / ensure_dir 各前缀族）与编辑器缓冲/视口写副作用（format/revealLine/setCursor/
 *    setSelection/setValue）都是「写」语义：
 *    开放前须先有 tier>=edit + approvedRoots/写许可域 这条授权链（铁律 5/6），执行体还须显式接线。
 *    编辑器视口类（revealLine 等）严格说偏 UI 状态，但与缓冲写同属编辑器副作用家族，统一按写面
 *    保守归类、不拆家。
 *  - 'needs-UI'：要人机交互面。原生对话框族（choose_ / pick_ / show_in_folder）与写域管理命令
 *    （register/confirm/clear_write_domain、revoke_workspace_root）依铁律 6「对话框即授权」
 *    必须有人工确认面才能开放；plugins 纯 UI/注册槽贡献没有独立数据面，同归此类。
 *  - 'needs-protocol'：要会话/反向通道。mcp_* 会话控制/审计内建（宿主线协议与第四张表管理，
 *    不作为模型工具）与危险档缺口（launcher_ / market_ / open_url_external / export_file /
 *    remove_ 各前缀族：默认不进 tools/list，须第四张表逐会话批准）——开放前置是会话级授权协议面
 *    （P5 演进边界，ADR-0013 §11 本期不做）。
 *  - 'unknown'：以上判据都不命中（当前树为 start_watch/stop_watch/cancel_search/updater_env_proxy
 *    这类生命周期/环境原语）——保守 unknown，绝不乱猜。
 *
 * suggestedPriority（建议序，非承诺；wired ⇒ null）：
 *  - P1 = cheap-read（真源已在、只差登记：最便宜，host 可按需即补）；
 *  - P2 = needs-write-domain（写域授权链语义已冻结、接线在途——fileTree.create/update 正由并行路接线）；
 *  - P3 = needs-UI 与 unknown（须产品拍板或判据不足：不进快车道，也不垫底）；
 *  - P4 = needs-protocol（P5 演进边界，本期不做）。
 */
function wiringCostFor(source, gap, reason) {
  if (reason === WIRED_REASON_CLASS) return { cost: 'wired', priority: null };
  if (source === 'plugins') return { cost: 'needs-UI', priority: 'P3' };
  if (source === 'rust') {
    // 与 deferredReason 同序同则：危险档 → mcp 内建 → 写/UI 混合桶（再细分）→ 只读原语兜底。
    if (/^(launcher_|market_|open_url_external$|export_file$|remove_|rename_path$)/.test(gap)) {
      return { cost: 'needs-protocol', priority: 'P4' };
    }
    if (/^mcp_/.test(gap)) return { cost: 'needs-protocol', priority: 'P4' };
    if (/^(choose_|pick_|show_in_folder$|clear_write_domain$|confirm_write_domain$|register_write_domain$|revoke_workspace_root$)/.test(gap)) {
      return { cost: 'needs-UI', priority: 'P3' };
    }
    if (/^(append_|create_|copy_file$|write_|ensure_dir$)/.test(gap)) {
      return { cost: 'needs-write-domain', priority: 'P2' };
    }
    if (reason.startsWith('写 / 授权 / 原生 UI 交互')) return { cost: 'unknown', priority: 'P3' };
    if (reason.startsWith('只读原语')) return { cost: 'cheap-read', priority: 'P1' };
    return { cost: 'unknown', priority: 'P3' };
  }
  if (source === 'debug') {
    if (/^(format|revealLine|setCursor|setSelection|setValue)$/.test(gap)) {
      return { cost: 'needs-write-domain', priority: 'P2' };
    }
    return { cost: 'cheap-read', priority: 'P1' };
  }
  return { cost: 'unknown', priority: 'P3' };
}

/** 剩余缺口的显式原因（按类别生成，不逐条编造；诚实标注「有真源但本波未接线」）。 */
function deferredReason(source, gap) {
  if (source === 'rust') {
    if (/^(launcher_|market_|open_url_external$|export_file$|remove_|rename_path$)/.test(gap)) {
      return '危险工具（privileged）：默认不进 tools/list，须宿主经第四张表逐会话批准。';
    }
    if (/^mcp_/.test(gap)) return 'MCP 会话控制 / 审计内建命令：由宿主线协议与第四张表管理，不作为模型工具。';
    if (/^(choose_|pick_|show_in_folder$|append_|clear_write_domain$|confirm_write_domain$|register_write_domain$|revoke_workspace_root$|ensure_dir$|create_|copy_file$|write_|start_watch$|stop_watch$|cancel_search$|updater_env_proxy$)/.test(gap)) {
      return '写 / 授权 / 原生 UI 交互：面向人的操作或需宿主接线，首期不默认暴露。';
    }
    return '只读原语：真源存在但本波未登记为具名工具（保留缺口，宿主后续按需补，绝不挂空串假实现）。';
  }
  if (source === 'debug') {
    if (/^(format|revealLine|setCursor|setSelection|setValue)$/.test(gap)) {
      return '编辑器写 / 光标副作用：首期不面向只读模型面。';
    }
    return '语义读数：真源存在但本波未登记为具名工具（保留缺口，宿主后续按需补）。';
  }
  return '纯 UI / 注册槽贡献：无独立数据面可暴露；领域知识只经 mcp.prompt 槽注入。';
}

/** Markdown 抽样：剩余缺口按原因分组，每类最多列 3 条（全量在 JSON coverage.deferred）。 */
function deferredSample(cov) {
  const grouped = new Map();
  for (const d of cov.deferred) {
    if (!grouped.has(d.reason)) grouped.set(d.reason, []);
    grouped.get(d.reason).push(d);
  }
  const out = [];
  for (const [reason, items] of grouped) {
    out.push(`  - ${reason} （${items.length} 条）`);
    for (const it of items.slice(0, 3)) out.push(`    - \`${it.source}:${it.gap}\``);
  }
  return out.length ? out : ['  - （无）'];
}

/** Markdown 写腿状态段（edit/privileged 执行体接线，数据全读真源，不硬编码）。 */
function writeLegsMarkdown(wl) {
  if (!wl) return [];
  const head = [
    '## 写腿状态（edit/privileged 执行体接线 · 真源腿表判读）',
    '',
    '| 工具 | tier | 缺口登记 | 执行体 |',
    '| --- | --- | --- | --- |',
  ];
  if (wl.legs.length === 0) {
    return [...head, ...(wl.sourcesMissing.length > 0 ? [`（registry 缺席：${wl.sourcesMissing.join('、')}，无 edit/privileged 具名工具可判读）`] : ['（无 edit/privileged 具名工具）'])];
  }
  const rows = wl.legs.map((l) =>
    `| \`${l.tool}\` | ${l.tier ?? '?'} | ${l.gapRegistered ? `\`${l.gap}\`` : '—'} | ${l.wired ? 'wired' : 'NOT_WIRED'} |`,
  );
  return [
    ...head,
    ...rows,
    '',
    `写腿读数：wired ${wl.wiredCount} / NOT_WIRED ${wl.notWiredCount}。`,
    `判读真源 = real-sources-io.ts \`ioTools\` ∪ real-sources.ts \`buildUiSupplemental\` 腿表；` +
      (wl.sourcesMissing.length > 0 ? `缺席源：${wl.sourcesMissing.join('、')}（如实列出，不猜）。` : '两处腿源齐全。'),
  ];
}

/**
 * 机器可读摘要（`--json`）：稳定 schema（自身 schemaVersion 从 1 起，独立于全量 JSON 的
 * SCHEMA_VERSION 演进）。counts + 全量 gaps 数组（每条 source/name/tool/wired/reasonClass/
 * wiringCost/suggestedPriority）+ 写腿状态段。字段语义见文件头注释与 wiringCostFor 的判据注释。
 */
function machineSummary(inv) {
  const cov = inv.coverage;
  return {
    schemaVersion: 1,
    generatedBy: 'tools/mcp-inventory.mjs',
    counts: {
      commands: inv.commandCount,
      rustCommands: inv.rustCommandCount,
      semanticReads: inv.semanticReadCount,
      slotContributions: inv.slotContributionCount,
      tools: {
        total: cov.tools.total,
        read: cov.tools.read,
        edit: cov.tools.edit,
        privileged: cov.tools.privileged,
      },
      totalGaps: cov.totalGaps,
      wiredGaps: cov.wiredGaps,
      deferredGaps: cov.deferredGaps,
      orphanedWires: cov.orphanedWires.length,
      missingSources: inv.missingSources.length,
    },
    gaps: inv.gapEntries,
    writeLegs: inv.writeLegs,
  };
}

/* ---------------- 盘点装配 ---------------- */

export async function buildInventory(root) {
  const abs = (rel) => path.join(root, rel);
  const missingSources = [];

  const commandsText = await readText(abs(SOURCES.commands));
  if (commandsText === null) missingSources.push(SOURCES.commands);
  const uiFiles = await walkFiles(abs(SOURCES.uiDir), ['.ts', '.tsx']);
  const uiTexts = [];
  for (const f of uiFiles) {
    const t = await readText(f);
    if (t !== null) uiTexts.push(t);
  }
  const commandIds = commandIdsFromUi(uiTexts);
  const construction = registryConstruction(commandsText ?? '');

  const rustText = await readText(abs(SOURCES.rust));
  if (rustText === null) missingSources.push(SOURCES.rust);
  const rustCommands = rustCommandsFromLib(rustText ?? '');

  const debugText = await readText(abs(SOURCES.debug));
  if (debugText === null) missingSources.push(SOURCES.debug);
  const debug = semanticReadsFromDebug(debugText ?? '');
  const semanticReads = debug.methods;

  const pluginFiles = (await walkFiles(abs(SOURCES.pluginsDir), ['.ts', '.tsx'])).filter(
    (f) => !/[/\\](tests?|__tests__)[/\\]/.test(f),
  );
  if (pluginFiles.length === 0) {
    try {
      await fs.stat(abs(SOURCES.pluginsDir));
    } catch {
      missingSources.push(`${SOURCES.pluginsDir}/*`);
    }
  }
  const pluginTexts = [];
  for (const f of pluginFiles) {
    const t = await readText(f);
    if (t !== null) pluginTexts.push(t);
  }
  const slotContributions = slotContributionsFromPlugins(pluginTexts);

  const commandSet = new Set(commandIds);
  const gaps = {
    rust: rustCommands.filter((n) => !commandSet.has(n)),
    debug: semanticReads.filter((n) => !commandSet.has(n)),
    plugins: slotContributions
      .filter((c) => c.id !== null && c.slot !== 'editor.command' && !commandSet.has(c.id))
      .map((c) => `${c.slot}:${c.id}`),
  };
  const gapCount = gaps.rust.length + gaps.debug.length + gaps.plugins.length;

  /* ---- 第三波：best-effort 参考源（缺席不进 missingSources）→ tier 覆盖率 + 剩余缺口原因 ---- */
  const hostText = await readText(abs(SOURCES.host));
  const hostCatalog = parseHostCatalog(hostText ?? '');
  const wiredMap = parseWiredMap(hostText ?? '');
  const deferredNotes = parseDeferredNotes(hostText ?? '');

  const gapSets = { rust: new Set(gaps.rust), debug: new Set(gaps.debug) };
  const wiredGapSet = new Set();
  const orphanedWires = [];
  /** 缺口 → 覆盖它的具名工具（仅通过交叉校验的 wire；同缺口多工具时按字母序）。 */
  const gapToTools = new Map();
  for (const w of wiredMap) {
    if (w.source === 'tool-surface') {
      if (!hostCatalog.names.includes(w.tool)) {
        orphanedWires.push({ ...w, why: '声明的工具未在 *_TOOL_SPECS 清单里（不计覆盖，不假绿）' });
      }
      continue;
    }
    const toolOk = hostCatalog.names.includes(w.tool);
    const gapOk = (gapSets[w.source] ?? new Set()).has(w.gap);
    if (!toolOk || !gapOk) {
      orphanedWires.push({ ...w, why: `交叉校验失败（tool=${toolOk}, gap=${gapOk}）：不计覆盖，不假绿` });
      continue;
    }
    wiredGapSet.add(`${w.source}:${w.gap}`);
    const key = `${w.source}:${w.gap}`;
    if (!gapToTools.has(key)) gapToTools.set(key, []);
    if (!gapToTools.get(key).includes(w.tool)) gapToTools.get(key).push(w.tool);
  }
  for (const arr of gapToTools.values()) arr.sort();

  /* ---- 全量缺口逐条展开（含已接线）：机器摘要 gaps 数组的真源 ---- */
  const gapEntries = [];
  const deferred = [];
  for (const [source, arr] of [['rust', gaps.rust], ['debug', gaps.debug], ['plugins', gaps.plugins]]) {
    for (const gap of arr) {
      if (wiredGapSet.has(`${source}:${gap}`)) {
        gapEntries.push({
          source,
          name: gap,
          tool: gapToTools.get(`${source}:${gap}`)?.[0] ?? null,
          wired: true,
          reasonClass: WIRED_REASON_CLASS,
          wiringCost: 'wired',
          suggestedPriority: null,
        });
        continue;
      }
      const reason = deferredReason(source, gap);
      deferred.push({ source, gap, reason });
      const { cost, priority } = wiringCostFor(source, gap, reason);
      gapEntries.push({
        source,
        name: gap,
        tool: null,
        wired: false,
        reasonClass: reason,
        wiringCost: cost,
        suggestedPriority: priority,
      });
    }
  }
  const byReason = {};
  for (const d of deferred) byReason[d.reason] = (byReason[d.reason] ?? 0) + 1;

  /* ---- 写腿状态段：registry 非 read 档工具 × 真源腿表判 wired × gap map 登记 ---- */
  const ioLegsText = await readText(abs(SOURCES.ioLegs));
  const uiLegsText = await readText(abs(SOURCES.uiLegs));
  const sourcesMissing = [];
  if (ioLegsText === null) sourcesMissing.push(SOURCES.ioLegs);
  if (uiLegsText === null) sourcesMissing.push(SOURCES.uiLegs);
  const legWhere = new Map();
  for (const [label, text] of [
    ['real-sources-io.ts', ioLegsText],
    ['real-sources.ts', uiLegsText],
  ]) {
    for (const n of parseLegMaps(text ?? '')) {
      if (!legWhere.has(n)) legWhere.set(n, []);
      if (!legWhere.get(n).includes(label)) legWhere.get(n).push(label);
    }
  }
  const gapRegisteredByTool = new Map();
  for (const w of wiredMap) if (!gapRegisteredByTool.has(w.tool)) gapRegisteredByTool.set(w.tool, w.gap);
  const writeLegsList = hostCatalog.names
    .filter((n) => (hostCatalog.tiers[n] ?? 'read') !== 'read')
    .sort()
    .map((tool) => {
      const where = legWhere.get(tool) ?? [];
      const wired = where.length > 0;
      const gap = gapRegisteredByTool.get(tool) ?? null;
      const evidence = wired
        ? `wired: 真源腿表命中（${where.join(' + ')}）`
        : sourcesMissing.length > 0
          ? `NOT_WIRED（真源腿文件缺席，无法复核：${sourcesMissing.join('、')}；不猜）`
          : `NOT_WIRED: 未命中 ioTools / buildUiSupplemental 真源腿表（宿主执行体未注入，调用将显式 NOT_WIRED，不静默）`;
      return {
        tool,
        tier: hostCatalog.tiers[tool] ?? null,
        gap,
        gapRegistered: gap !== null,
        wired,
        evidence,
      };
    });
  const writeLegs = {
    sources: { registry: SOURCES.host, ioLegs: SOURCES.ioLegs, uiLegs: SOURCES.uiLegs },
    sourcesMissing,
    legs: writeLegsList,
    wiredCount: writeLegsList.filter((l) => l.wired).length,
    notWiredCount: writeLegsList.filter((l) => !l.wired).length,
  };

  const coverage = {
    tools: {
      total: hostCatalog.names.length,
      read: hostCatalog.byTier.read,
      edit: hostCatalog.byTier.edit,
      privileged: hostCatalog.byTier.privileged,
      names: hostCatalog.names,
    },
    totalGaps: gapCount,
    wiredGaps: wiredGapSet.size,
    deferredGaps: deferred.length,
    orphanedWires,
    byReason,
    deferredNotes,
    deferred,
  };

  const inventory = {
    schemaVersion: SCHEMA_VERSION,
    sources: {
      commands: SOURCES.commands,
      rust: SOURCES.rust,
      debug: SOURCES.debug,
      plugins: `${SOURCES.pluginsDir}/*`,
      mcpHost: SOURCES.host,
    },
    missingSources,
    registryConstruction: construction,
    commandCount: commandIds.length,
    rustCommandCount: rustCommands.length,
    semanticReadCount: semanticReads.length,
    editorSemanticSurfaceFound: debug.found,
    slotContributionCount: slotContributions.length,
    editorCommandContributionCount: slotContributions.filter((c) => c.slot === 'editor.command').length,
    commandIds,
    rustCommands,
    semanticReads,
    slotContributions,
    gaps,
    gapCount,
    coverage,
    gapEntries,
    writeLegs,
  };
  inventory.markdown = markdownDraft(inventory);
  return inventory;
}

/** Markdown 草案：计数 + 缺口抽样（每类最多 10 条），全量清单在 JSON 里。 */
function markdownDraft(inv) {
  const sample = (arr) => arr.slice(0, 10).map((x) => `  - \`${x}\``).join('\n') || '  - （无）';
  const tail = (arr) => (arr.length > 10 ? `\n  - … 另有 ${arr.length - 10} 条（见 JSON 全量）` : '');
  const cov = inv.coverage ?? {
    tools: { total: 0, read: 0, edit: 0, privileged: 0 },
    totalGaps: 0, wiredGaps: 0, deferredGaps: 0, orphanedWires: [], deferredNotes: [], deferred: [],
  };
  const lines = [
    '# MCP 能力盘点草案（ADR-0013 · P0）',
    '',
    '| 真源 | 读数 |',
    '| --- | --- |',
    `| 命令注册表命令数 | ${inv.commandCount} |`,
    `| Rust 命令数 | ${inv.rustCommandCount} |`,
    `| 语义读数面方法数 | ${inv.semanticReadCount} |`,
    `| 插件槽贡献数（含 \`editor.command\` ${inv.editorCommandContributionCount} 条） | ${inv.slotContributionCount} |`,
    `| **未登记成命令的缺口** | **${inv.gapCount}** |`,
    '',
    `注册表构造：\`buildCommandRegistry\` ${inv.registryConstruction.buildCommandRegistry ? '✓' : '✗'} · ` +
      `\`CommandEntry\` ${inv.registryConstruction.commandEntry ? '✓' : '✗'} · ` +
      `\`ShellCommandSpec\` ${inv.registryConstruction.shellCommandSpec ? '✓' : '✗'}`,
    inv.missingSources.length > 0 ? `缺源（如实列出，未猜）：${inv.missingSources.join('、')}` : '四处真源齐全。',
    '',
    '## 缺口清单（未登记成命令）',
    '',
    `### Rust 命令（${inv.gaps.rust.length}）`,
    sample(inv.gaps.rust) + tail(inv.gaps.rust),
    '',
    `### 调试语义读数（${inv.gaps.debug.length}）`,
    sample(inv.gaps.debug) + tail(inv.gaps.debug),
    '',
    `### 非 editor.command 槽贡献（${inv.gaps.plugins.length}）`,
    sample(inv.gaps.plugins) + tail(inv.gaps.plugins),
    '',
    '## 能力覆盖（按 tier · 第三波）',
    '',
    '| tier | 工具数 |',
    '| --- | --- |',
    `| read | ${cov.tools.read} |`,
    `| edit | ${cov.tools.edit} |`,
    `| privileged | ${cov.tools.privileged} |`,
    `| **tools 总数** | **${cov.tools.total}** |`,
    '',
    `已由具名工具覆盖的缺口：${cov.wiredGaps} / ${cov.totalGaps}；剩余缺口：${cov.deferredGaps}（逐条原因见 JSON \`coverage.deferred\`）。`,
    cov.orphanedWires.length > 0
      ? `覆盖声明交叉校验失败（不假绿）：${cov.orphanedWires.length} 条，见 JSON \`coverage.orphanedWires\`。`
      : '覆盖声明全部与真实工具 / 缺口对拍通过。',
    '',
    ...writeLegsMarkdown(inv.writeLegs),
    '',
    '### 剩余缺口原因（抽样，每类最多 3 条）',
    ...deferredSample(cov),
    '',
    '### 无真源缺口类别（显式标注，绝不造假实现返回空串）',
    ...(cov.deferredNotes.length
      ? cov.deferredNotes.map((n) => `  - \`${n.scope}\` — ${n.reason}`)
      : ['  - （参考源缺席，无登记）']),
    '',
    '> 草案用途：为 `tools` / `resources` / `prompts` 分级（read / edit / privileged）挑候选；',
    '> 分级与批准判据见 ADR-0013，危险工具默认不进 `tools/list`。',
  ];
  return lines.join('\n') + '\n';
}

/* ---------------- CLI ---------------- */

async function main() {
  const argv = process.argv.slice(2);
  const rootIdx = argv.indexOf('--root');
  if (rootIdx >= 0 && argv[rootIdx + 1] === undefined) {
    process.stderr.write('参数错：--root 需要一个目录。\n');
    process.exitCode = 2;
    return;
  }
  const root = rootIdx >= 0 ? path.resolve(argv[rootIdx + 1]) : path.resolve(import.meta.dirname, '..');
  const wantMarkdown = argv.includes('--markdown');
  const wantMachine = argv.includes('--json');
  const wantPrint = argv.includes('--print') || wantMarkdown || wantMachine || argv.length === 0;
  if (!wantPrint) return;
  const inv = await buildInventory(root);
  // 格式优先级（见文件头）：--markdown（人类草案）> --json（机器摘要）> --print / 缺省（全量 JSON）。
  const out = wantMarkdown
    ? inv.markdown
    : wantMachine
      ? `${JSON.stringify(machineSummary(inv), null, 2)}\n`
      : `${JSON.stringify(inv, null, 2)}\n`;
  process.stdout.write(out);
  process.exitCode = 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
