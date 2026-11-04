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
 *   node tools/mcp-inventory.mjs --root <dir> --print     # 对拍夹具（见 tools/tests/mcp-inventory.test.ts）
 *
 * 退出码：0 = 完成（盘点草案不是质量闸，缺源不判红）；2 = 参数错。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 1;

const SOURCES = Object.freeze({
  commands: 'packages/app/src/ui/commands.ts',
  rust: 'packages/app/src-tauri/src/lib.rs',
  debug: 'packages/app/src/debug/install-debug.ts',
  pluginsDir: 'packages/plugins',
  uiDir: 'packages/app/src/ui',
  // best-effort 参考源（第三波）：能力面工具清单 / tier 分组 / 覆盖登记；缺席不进 missingSources。
  host: 'packages/mcp-host/src/index.ts',
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
 * 字面量得 tier 分组计数。只统计工具规格块，不碰 resource / prompt 清单（那里也有 name）。
 * 文件/块缺席 ⇒ 空清单，绝不猜、绝不假绿。
 */
function parseHostCatalog(text) {
  const names = [];
  const byTier = { read: 0, edit: 0, privileged: 0 };
  if (!text) return { names, byTier };
  const blocks = [
    ...text.matchAll(/export const (?:SEMANTIC|KERNEL_IO|SUPPLEMENTAL)_TOOL_SPECS[^=]*=\s*\[([\s\S]*?)\n\];/g),
  ].map((m) => m[1]);
  for (const block of blocks) {
    for (const m of block.matchAll(/\bname:\s*'([^']+)'/g)) names.push(m[1]);
    for (const m of block.matchAll(/\btier:\s*'(read|edit|privileged)'/g)) byTier[m[1]]++;
  }
  return { names, byTier };
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
  }
  const deferred = [];
  for (const [source, arr] of [['rust', gaps.rust], ['debug', gaps.debug], ['plugins', gaps.plugins]]) {
    for (const gap of arr) {
      if (wiredGapSet.has(`${source}:${gap}`)) continue;
      deferred.push({ source, gap, reason: deferredReason(source, gap) });
    }
  }
  const byReason = {};
  for (const d of deferred) byReason[d.reason] = (byReason[d.reason] ?? 0) + 1;
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
  const wantPrint = argv.includes('--print') || wantMarkdown || argv.length === 0;
  if (!wantPrint) return;
  const inv = await buildInventory(root);
  const out = wantMarkdown ? inv.markdown : `${JSON.stringify(inv, null, 2)}\n`;
  process.stdout.write(out);
  process.exitCode = 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
