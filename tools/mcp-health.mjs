/**
 * `tools/mcp-health.mjs` —— MCP 能力面的**五格体检**（一条命令替代「跑四个工具 + 人对文档」）。
 *
 * 为什么要它：能力面的五个读数散在四处——枚数在 `mcp-inventory --json`、帧余量在载荷量具、
 * 缺口分布在 `coverage.byReason`、孤儿写腿在两个数组里，而 **README 的数字是人手抄的**。
 * 于是「文档说 86、代码算出 85」只能靠人肉对账；WP-6a 就真的踩过「文档 11 / 代码 10 互相冤枉」。
 *
 * 五格：
 *  1. **枚数**——tools 按 tier / resources（**规格数 + 运行期数分开报**）/ prompts。
 *  2. **帧余量**——`tools/list` 一帧字节 vs 传输闸。量具用注册表导出的 `toolsListFrameBytes`
 *     且 id 与能力面资源（`kojo://server/capability-face`）**同一个**，两边数字必须逐字相等。
 *  3. **缺口分布**——`coverage.byReason` 逐档 + total/wired/deferred 三计数。
 *  4. **孤儿写腿**——`coverage.orphanedWires`（声明了却没工具）与 `writeLegs` 里 NOT_WIRED 两处都摊开。
 *  5. **README 漂移**——逐格与 `docs/mcp/README.md` 对账。**每个数只从「拥有它的那一节」读**：
 *     枚数 / 缺口读 §10.5（当前能力面读数），写腿读 §5.4（写腿状态段，取该节**最后一条**，
 *     因为那一节是流水账、末条才是当前）。找不到 ⇒ 该格 `ok:false`（措辞变了也是漂移，不许静默通过）。
 *
 * 用法：
 *   node tools/mcp-health.mjs                  # 人类可读
 *   node tools/mcp-health.mjs --json           # 机器可读（稳定 schema，见下）
 *   node tools/mcp-health.mjs --no-payload     # 跳过注册表装载（快；帧/运行期枚数给 null）
 *   node tools/mcp-health.mjs --root <dir>     # 对拍夹具（与 mcp-inventory 同一口径）
 *
 * `--json` schema（schemaVersion 1）：
 *   { schemaVersion, generatedBy, counts{tools{total,read,edit,privileged},resourcesSpecs,
 *     resourcesRuntime,prompts}, payload{transportLimitBytes,faces{},unavailable},
 *     gaps{totalGaps,wiredGaps,deferredGaps,byReason}, orphanWires{coverage[],writeLegs[]},
 *     readme{cells[{field,readme,actual,ok}],drift[]}, ok }
 *
 * 退出码：0 = 五格全绿（含 `ok:null` 的「未测」格）；1 = 有漂移 / 有格测不出来；2 = 参数错。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildInventory } from './mcp-inventory.mjs';
import { loadRegistry } from './lib/mcp-registry-loader.mjs';

const SCHEMA_VERSION = 1;
const README_REL = 'docs/mcp/README.md';
const HOST_REL = 'packages/mcp-host/src/index.ts';
/** 与能力面资源同一个 id：这样两处报的是**同一帧**，不会因为 id 长度差几个字节而各说各话。 */
const FACE_ID = 'capability-face';

/* ---------------- README 取数 ---------------- */

/** 取某一节正文（`### x.y` 起，到下一个 `##`/`###` 标题止）。缺节 ⇒ null（调用方判红）。 */
function section(readme, heading) {
  const at = readme.indexOf(heading);
  if (at < 0) return null;
  const rest = readme.slice(at + heading.length);
  const end = rest.search(/\n#{2,3} /);
  return end < 0 ? rest : rest.slice(0, end);
}

/** 在一段文本里按正则取第一个整数；取不到 ⇒ null。 */
function firstInt(text, re) {
  const m = re.exec(text);
  return m ? Number(m[1]) : null;
}

/** 在一段文本里按正则取**最后一个**整数（写腿流水账用）。 */
function lastInts(text, re) {
  let out = null;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of text.matchAll(g)) out = m.slice(1).map(Number);
  return out;
}

/**
 * README 逐格取数。
 * 每个数只认「拥有它的那一节」——这是本工具唯一的方法论主张：读数搬家比读数漂移更常见。
 */
function readmeNumbers(readme) {
  const cap = section(readme, '### 10.5');
  const legs = section(readme, '### 5.4');
  const tools = cap ? /tools \*\*(\d+)\*\*（read \*\*(\d+)\*\* \/ edit \*\*(\d+)\*\* \/ privileged \*\*(\d+)\*\*）/.exec(cap) : null;
  const wired = legs ? lastInts(legs, /wired (\d+) \/ NOT_WIRED (\d+)/) : null;
  return {
    toolsTotal: tools ? Number(tools[1]) : null,
    toolsRead: tools ? Number(tools[2]) : null,
    toolsEdit: tools ? Number(tools[3]) : null,
    toolsPrivileged: tools ? Number(tools[4]) : null,
    resources: cap ? firstInt(cap, /resources \*\*(\d+)\*\*/) : null,
    prompts: cap ? firstInt(cap, /prompts \*\*(\d+)\*\*/) : null,
    totalGaps: cap ? firstInt(cap, /totalGaps=(\d+)/) : null,
    wiredGaps: cap ? firstInt(cap, /wiredGaps=(\d+)/) : null,
    deferredGaps: cap ? firstInt(cap, /deferredGaps=(\d+)/) : null,
    writeLegsWired: wired ? wired[0] : null,
    writeLegsNotWired: wired ? wired[1] : null,
  };
}

/* ---------------- 五格采集 ---------------- */

/**
 * 静态面：**不装载注册表**也能算的枚数。
 *
 * 资源枚数必须报两个数，这是 WP-6a 踩过的坑：
 *  - `resourcesSpecs`＝`MCP_RESOURCE_SPECS` 里登记了几条；
 *  - `resourcesInjected`＝生产侧另注入几条（`real-sources.ts` 的 `resources: [...]`）。
 *    判定用**集合差**：app 侧源码里出现过的 `kojo://` 字面量 **减去** 规格清单里的 URI，
 *    剩下的就是注入面（今天只有 `fs-freshness` 一条）。不写死 `+1`——那会在下次注入时骗人。
 *  - `resourcesRuntime` = 两者之和，这才是 README §10.5 记的那个数。
 *
 * 提示词同理：`prompts` 报的是**骨架规格**条数（`MCP_PROMPT_SKELETON_SPECS`）——
 * 运行期还会并入插件槽片段，但那是宿主注入面，静态盘点只认骨架。
 */
async function staticFace(root) {
  const host = await fs.readFile(path.join(root, HOST_REL), 'utf8').catch(() => null);
  const specBlock = host ? /MCP_RESOURCE_SPECS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(host)?.[1] ?? '' : '';
  const specUris = new Set(
    (specBlock.match(/uri:\s*(?:'([^']+)'|([A-Z0-9_]+))/g) ?? [])
      .map((m) => /'([^']+)'/.exec(m)?.[1] ?? null)
      .filter(Boolean),
  );
  // `CAPABILITY_FACE_URI` 这类常量名不是字面量：按名字回填（解析该常量的定义）。
  if (specBlock.includes('CAPABILITY_FACE_URI')) {
    const lit = /export const CAPABILITY_FACE_URI\s*=\s*'([^']+)'/.exec(host ?? '')?.[1];
    if (lit) specUris.add(lit);
  }

  const promptBlock = host ? /MCP_PROMPT_SKELETON_SPECS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(host)?.[1] ?? '' : '';
  // 只数**条目级**的 `name:`（4 空格缩进那一层）；`arguments: [{ name: 'focus' }]` 里的不算。
  const prompts = (promptBlock.match(/^ {4}name:\s*'/gm) ?? []).length;

  // 注入面：app 侧 mcp 目录里出现过的资源 URI 减去规格清单（多出来的就是注入的）。
  const appDir = path.join(root, 'packages/app/src/mcp');
  let injected = 0;
  let appFiles = [];
  try {
    appFiles = (await fs.readdir(appDir)).filter((f) => f.endsWith('.ts'));
  } catch {
    appFiles = [];
  }
  const appUris = new Set();
  for (const f of appFiles) {
    const text = await fs.readFile(path.join(appDir, f), 'utf8').catch(() => '');
    for (const m of text.matchAll(/kojo:\/\/[a-z/-]+/g)) appUris.add(m[0]);
  }
  for (const uri of appUris) if (!specUris.has(uri)) injected += 1;

  return {
    resourcesSpecs: host === null ? null : specUris.size,
    resourcesInjected: host === null ? null : injected,
    resourcesRuntime: host === null ? null : specUris.size + injected,
    prompts: host === null ? null : prompts,
  };
}

async function payloadCell(root) {
  let loaded;
  try {
    loaded = await loadRegistry({ repoRoot: root });
  } catch (err) {
    return { cell: { transportLimitBytes: null, faces: {}, unavailable: err?.message ?? String(err) }, tools: null, mod: null };
  }
  const { mod } = loaded;
  try {
    const specs = [...mod.SEMANTIC_TOOL_SPECS, ...mod.KERNEL_IO_TOOL_SPECS, ...mod.SUPPLEMENTAL_TOOL_SPECS];
    const names = specs.map((s) => s.name);
    const privilegedNames = specs.filter((s) => s.tier === 'privileged').map((s) => s.name);
    const reg = mod.createMcpCapabilityRegistry({});
    const scope = (tier, approvedTools = []) => ({ sessionId: 'health', clientId: 'health', tier, approvedRoots: [], approvedTools });
    const faces = {
      full: reg.listTools(scope('privileged', names)),
      read: reg.listTools(scope('read')),
    };
    const out = {};
    for (const [key, tools] of Object.entries(faces)) {
      const frameBytes = mod.toolsListFrameBytes(tools, FACE_ID);
      out[key] = {
        toolCount: tools.length,
        frameBytes,
        headroomBytes: mod.TRANSPORT_RESPONSE_LIMIT_BYTES - frameBytes,
      };
    }
    return {
      cell: { transportLimitBytes: mod.TRANSPORT_RESPONSE_LIMIT_BYTES, faces: out, unavailable: null },
      // 运行期枚数只能从注册表拿（资源/提示词不进 inventory 的静态盘点）。
      // 注册表（零 deps）只看得见规格清单那几条；与静态数对不上就是有人绕过了规格表。
      registryResources: reg.listResources().length,
      registryPrompts: reg.listPrompts().length,
    };
  } finally {
    await loaded.dispose();
  }
}

async function buildHealth(root, { withPayload }) {
  const inv = await buildInventory(root);
  const cov = inv.coverage ?? {};
  const readmeText = await fs.readFile(path.join(root, README_REL), 'utf8').catch(() => null);
  const readme = readmeText === null ? null : readmeNumbers(readmeText);

  const staticCounts = await staticFace(root);
  const payload = withPayload
    ? await payloadCell(root)
    : { cell: { transportLimitBytes: null, faces: {}, unavailable: '--no-payload：本次未装载注册表（帧余量未测，不冒充 0）' }, registryResources: null, registryPrompts: null };

  const writeLegsNotWired = (inv.writeLegs?.legs ?? []).filter((l) => l.wired === false).map((l) => l.tool);

  const counts = {
    tools: {
      total: cov.tools?.total ?? 0,
      read: cov.tools?.read ?? 0,
      edit: cov.tools?.edit ?? 0,
      privileged: cov.tools?.privileged ?? 0,
    },
    resourcesSpecs: staticCounts.resourcesSpecs,
    resourcesInjected: staticCounts.resourcesInjected,
    resourcesRuntime: staticCounts.resourcesRuntime,
    prompts: staticCounts.prompts,
    // 注册表实测（零 deps ⇒ 只含规格清单）；`--no-payload` 时为 null。
    registryResources: payload.registryResources,
    registryPrompts: payload.registryPrompts,
  };

  const gaps = {
    totalGaps: cov.totalGaps ?? 0,
    wiredGaps: cov.wiredGaps ?? 0,
    deferredGaps: cov.deferredGaps ?? 0,
    byReason: cov.byReason ?? {},
  };

  const orphanWires = {
    coverage: cov.orphanedWires ?? [],
    writeLegs: writeLegsNotWired,
  };

  // 逐格对账，两种「测不出来」严格区分开：
  //  - `actual === null`（这一格机器算不出来，如 --no-payload 的帧）⇒ `ok:null`，既不判绿也不判红；
  //  - `readme === null`（文档里读不到这个数）⇒ `ok:false`：**措辞变了也是漂移**，不许静默通过。
  const pairs = [
    ['tools.total', readme?.toolsTotal, counts.tools.total],
    ['tools.read', readme?.toolsRead, counts.tools.read],
    ['tools.edit', readme?.toolsEdit, counts.tools.edit],
    ['tools.privileged', readme?.toolsPrivileged, counts.tools.privileged],
    ['resources', readme?.resources, counts.resourcesRuntime],
    ['prompts', readme?.prompts, counts.prompts],
    ['totalGaps', readme?.totalGaps, gaps.totalGaps],
    ['wiredGaps', readme?.wiredGaps, gaps.wiredGaps],
    ['deferredGaps', readme?.deferredGaps, gaps.deferredGaps],
    ['writeLegs.wired', readme?.writeLegsWired, (inv.writeLegs?.legs ?? []).filter((l) => l.wired !== false).length],
    ['writeLegs.notWired', readme?.writeLegsNotWired, writeLegsNotWired.length],
  ];
  const cells = pairs.map(([field, doc, actual]) => ({
    field,
    readme: doc ?? null,
    actual: actual ?? null,
    ok: actual === null || actual === undefined ? null : doc !== null && doc !== undefined && doc === actual,
  }));
  const drift = cells.filter((c) => c.ok === false).map((c) => c.field);
  const unmeasured = cells.filter((c) => c.ok === null).map((c) => c.field);

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedBy: 'tools/mcp-health.mjs',
    root,
    counts,
    payload: payload.cell,
    gaps,
    orphanWires,
    readme: { cells, drift, unmeasured, parsed: readme !== null },
    ok: drift.length === 0 && orphanWires.coverage.length === 0 && orphanWires.writeLegs.length === 0,
  };
}

/* ---------------- 人类可读 ---------------- */

function render(rep) {
  const mark = (ok) => (ok === null ? '·' : ok ? '✅' : '❌');
  const lines = [];
  const frame = rep.payload.faces.full;
  const limit = rep.payload.transportLimitBytes;
  lines.push('MCP 能力面体检（tools/mcp-health.mjs）');
  lines.push('');
  lines.push(`① 枚数      tools ${rep.counts.tools.total}（read ${rep.counts.tools.read} / edit ${rep.counts.tools.edit} / privileged ${rep.counts.tools.privileged}）`);
  lines.push(
    `             resources 规格 ${rep.counts.resourcesSpecs ?? '·'} + 注入 ${rep.counts.resourcesInjected ?? '·'} = 运行期 ${rep.counts.resourcesRuntime ?? '·'} · prompts ${rep.counts.prompts ?? '·'}`,
  );
  lines.push(
    frame && limit
      ? `② 帧余量    full ${frame.frameBytes} B / ${limit} B ⇒ 余量 ${frame.headroomBytes} B（${((frame.headroomBytes / limit) * 100).toFixed(1)}%）`
      : `② 帧余量    · 未测（${rep.payload.unavailable ?? '原因未知'}）`,
  );
  // byReason 的键是**整句理由**（inventory 原样保留），人读时只取冒号前的类名并聚合。
  const short = new Map();
  for (const [k, v] of Object.entries(rep.gaps.byReason)) {
    const label = k.split('：')[0].trim();
    short.set(label, (short.get(label) ?? 0) + v);
  }
  const reasons = [...short.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(' / ');
  lines.push(`③ 缺口      ${rep.gaps.totalGaps} = wired ${rep.gaps.wiredGaps} + deferred ${rep.gaps.deferredGaps}`);
  lines.push(`            ${reasons}`);
  lines.push(
    `④ 孤儿写腿  coverage ${rep.orphanWires.coverage.length} 条 · writeLegs NOT_WIRED ${rep.orphanWires.writeLegs.length} 条` +
      (rep.orphanWires.coverage.length + rep.orphanWires.writeLegs.length > 0
        ? `：${[...rep.orphanWires.coverage, ...rep.orphanWires.writeLegs].join('、')}`
        : ''),
  );
  lines.push(`⑤ README    ${rep.readme.drift.length === 0 ? '与机器读数一致' : `漂移 ${rep.readme.drift.length} 格`}`);
  for (const c of rep.readme.cells) {
    lines.push(`             ${mark(c.ok)} ${c.field.padEnd(20)} 文档 ${String(c.readme ?? '·').padStart(4)} · 实际 ${String(c.actual ?? '·').padStart(4)}`);
  }
  if (rep.readme.unmeasured.length > 0) {
    lines.push(`             · 未测：${rep.readme.unmeasured.join('、')}（--no-payload 只少测这几格，不算漂移）`);
  }
  lines.push('');
  lines.push(rep.ok ? '结论：五格全绿。' : `结论：**不健康**——${rep.readme.drift.length > 0 ? `README 漂移（${rep.readme.drift.join('、')}）` : '有孤儿写腿'}。`);
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
  const unknown = argv.filter((a, i) => a.startsWith('--') && !['--root', '--json', '--no-payload'].includes(a) && argv[i - 1] !== '--root');
  if (unknown.length > 0) {
    process.stderr.write(`参数错：未知选项 ${unknown.join('、')}。\n`);
    process.exitCode = 2;
    return;
  }
  const root = rootIdx >= 0 ? path.resolve(argv[rootIdx + 1]) : path.resolve(import.meta.dirname, '..');
  const rep = await buildHealth(root, { withPayload: !argv.includes('--no-payload') });
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(rep, null, 2)}\n` : render(rep));
  process.exitCode = rep.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`[FAIL] ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
}

export { buildHealth, readmeNumbers };
