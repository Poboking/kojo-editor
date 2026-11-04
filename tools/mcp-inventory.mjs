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

  const inventory = {
    schemaVersion: SCHEMA_VERSION,
    sources: {
      commands: SOURCES.commands,
      rust: SOURCES.rust,
      debug: SOURCES.debug,
      plugins: `${SOURCES.pluginsDir}/*`,
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
  };
  inventory.markdown = markdownDraft(inventory);
  return inventory;
}

/** Markdown 草案：计数 + 缺口抽样（每类最多 10 条），全量清单在 JSON 里。 */
function markdownDraft(inv) {
  const sample = (arr) => arr.slice(0, 10).map((x) => `  - \`${x}\``).join('\n') || '  - （无）';
  const tail = (arr) => (arr.length > 10 ? `\n  - … 另有 ${arr.length - 10} 条（见 JSON 全量）` : '');
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
