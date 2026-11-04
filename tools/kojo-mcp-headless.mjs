#!/usr/bin/env node
/**
 * kojo-mcp-headless —— 无 GUI 的 **stdio MCP server 原型**（P5 / 路 B 第二波）。
 *
 * 定位（ADR-0003 边界）：这个脚本只由**外部 AI 客户端 spawn**、走 stdio JSON-RPC，
 * 不打包 Node 运行时、不拉起 WebView / Monaco / Tauri / Rust 命令面。它只跑
 * **kernel IO + 语言/校验层**：项目信息、文件树、全工程检索、通用诊断。
 *
 * 零外部 npm 依赖：只 import `node:*`。为什么不在本文件 import 仓库的 `NodeBridge`：
 * 那是 TypeScript 且依赖 iconv-lite / @kojo/plugin-api，headless 由外部客户端用系统 Node
 * 直接 spawn、不经过 vitest/tsx alias，无法 import TS 源。故本文件实现一份**只读原语
 * 形态对齐** `packages/kernel/tests/helpers/node-bridge.ts`（readFileBytes / listDir /
 * walkDir / stat / exists 的纯 Node 等价腿），并明确标注「不复制写侧真相」；真写侧语义
 * 的真源仍在 Rust 宿主，本原型只在显式授权下提供最小、可拒绝的写入口。
 *
 * 安全面（fail loud，绝不静默）：
 * - **只读开箱可用**：`project.info` / `fs.tree` / `search.all` / `diagnostics.read` 默认在 tools/list。
 * - **写能力默认关闭**：`fs.write` / `fs.remove` / `fs.rename` 默认**不进** tools/list；
 *   开启必须显式传 `--allow-write <已批准根>`（可多次）。域外路径一律显式拒绝。
 * - **客户端未授权显式报错**：写调用须先 `initialize`（且带 `clientInfo.name`）；
 *   身份缺失 / 未初始化 / 未开写 / 域外，分别返回结构化 JSON-RPC error，绝不假装成功。
 * - **不给 MCP 暴露任意目标路径参数**：写工具只收「项目根内相对路径」
 *   （`RELATIVE_PATH_PATTERN` 拒绝绝对路径、盘符、`..` 逃逸），执行前再按 approvedRoots 复核域。
 *
 * 用法（由外部 AI 客户端 spawn，勿手工常驻）：
 *   node tools/kojo-mcp-headless.mjs [--project <dir>] [--allow-write <dir>]...
 * 退出码：0 正常收尾；1 参数错。
 *
 * 测试：`tools/tests/mcp-headless.test.ts` 通过 `createHeadlessServer({ kernel })` 注入
 * 假 kernel，直接驱动 `handle(message)`，不发真实 stdio、不真写盘。
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

/* ------------------------------ 常量与清单 ------------------------------ */

export const PROTOCOL_VERSION = '2024-11-05';
export const SERVER_INFO = Object.freeze({ name: 'kojo-mcp-headless', version: '0.1.0' });

/** 项目根内相对路径：拒绝盘符 / 绝对路径 / ".." 段（与 @kojo/mcp-host 的 RELATIVE_PATH_SCHEMA 同口径）。 */
export const RELATIVE_PATH_PATTERN = '^(?![A-Za-z]:)(?![\\\\/])(?!.*(?:^|[\\\\/])\\.\\.(?:[\\\\/]|$)).+$';

const RELATIVE_PATH_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 512,
  pattern: RELATIVE_PATH_PATTERN,
  description: 'Project-root-relative path only; absolute paths, drive letters and ".." are rejected, then re-checked against approvedRoots.',
};

/** 只读四条腿（默认可用）。结构形态与 @kojo/mcp-host 的 *_TOOL_SPECS 对齐，便于能力盘点按源码锚识别。 */
export const HEADLESS_READ_TOOL_SPECS = Object.freeze([
  {
    name: 'project.info',
    description: 'Read-only project metadata: root path, file count, extension histogram, optional package name/version. Never mutates files.',
    inputSchema: { type: 'object', properties: {} },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fs.tree',
    description: 'Read-only project file tree (bounded depth/entries, explicit truncated flag). Use before any write to learn which relative paths exist. Never mutates files.',
    inputSchema: {
      type: 'object',
      properties: {
        maxDepth: { type: 'integer', minimum: 0, maximum: 16, description: 'Recursion depth cap (default 6).' },
        maxEntries: { type: 'integer', minimum: 1, maximum: 5000, description: 'Entry cap (default 500).' },
      },
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'search.all',
    description: 'Read-only whole-project substring search (case-insensitive). Returns file/line hits with an explicit truncated flag; narrow the query if truncated. Never mutates files.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 512, description: 'Substring to find.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 200, description: 'Hit cap (default 50).' },
      },
      required: ['query'],
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'diagnostics.read',
    description: 'Read-only language/validation diagnostics produced by a minimal, game-agnostic checker (trailing whitespace, NUL bytes, overlong lines, unbalanced brackets). Never mutates files.',
    inputSchema: {
      type: 'object',
      properties: { maxResults: { type: 'integer', minimum: 1, maximum: 500, description: 'Finding cap (default 200).' } },
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
]);

/** 写三条腿（默认关闭，需 --allow-write 且逐项域校验）。 */
export const HEADLESS_WRITE_TOOL_SPECS = Object.freeze([
  {
    name: 'fs.write',
    description: 'Write text content to a file inside an approved root. DISABLED by default; requires --allow-write <root>, an initialized client, an in-domain project-root-relative path. Destructive (overwrites).',
    inputSchema: {
      type: 'object',
      properties: { relPath: RELATIVE_PATH_SCHEMA, content: { type: 'string', maxLength: 1_000_000, description: 'Full replacement text.' } },
      required: ['relPath', 'content'],
    },
    tier: 'edit',
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: 'fs.remove',
    description: 'Remove a file/directory inside an approved root. DISABLED by default; requires --allow-write <root>, an initialized client, an in-domain project-root-relative path. Destructive and irreversible.',
    inputSchema: {
      type: 'object',
      properties: { relPath: RELATIVE_PATH_SCHEMA, recursive: { type: 'boolean', description: 'Allow removing a non-empty directory.' } },
      required: ['relPath'],
    },
    tier: 'privileged',
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: 'fs.rename',
    description: 'Rename/move an entry inside an approved root. DISABLED by default; requires --allow-write <root>, an initialized client, both from and to being in-domain project-root-relative paths. Destructive.',
    inputSchema: {
      type: 'object',
      properties: { from: RELATIVE_PATH_SCHEMA, to: RELATIVE_PATH_SCHEMA },
      required: ['from', 'to'],
    },
    tier: 'privileged',
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
]);

export const HEADLESS_RESOURCE_SPECS = Object.freeze([
  { uri: 'kojo://headless/project', name: '项目信息', description: '只读项目信息（带截断标记）', mimeType: 'application/json' },
  { uri: 'kojo://headless/file-tree', name: '文件树', description: '只读文件树（带截断标记）', mimeType: 'application/json' },
  { uri: 'kojo://headless/diagnostics', name: '诊断', description: '只读语言/校验诊断（带截断标记）', mimeType: 'application/json' },
]);

/** resource 文本上限（字符）；超限必须显式 truncated 标记。 */
export const HEADLESS_RESOURCE_TEXT_LIMIT = 24_000;

/* ------------------------------ 纯函数（注入 seam 可测） ------------------------------ */

/**
 * 解析 argv。写能力**默认关闭**；`--allow-write` 出现即开启并收集已批准根。
 * 缺值 / 未知参数一律显式抛错（不静默吞）。
 */
export function parseArgs(argv) {
  const out = { projectRoot: process.cwd(), approvedRoots: [], writeEnabled: false, argv: [...argv] };
  const a = [...argv];
  for (let i = 0; i < a.length; i++) {
    const tok = a[i];
    if (tok === '--project') {
      const v = a[++i];
      if (v === undefined || v.startsWith('--')) throw new Error('--project 缺值（不静默）');
      out.projectRoot = path.resolve(v);
    } else if (tok === '--allow-write') {
      const v = a[++i];
      if (v === undefined || v.startsWith('--')) throw new Error('--allow-write 缺 <已批准根>（不静默）');
      out.approvedRoots.push(path.resolve(v));
    } else {
      throw new Error(`未知参数 ${String(tok)}（不静默）`);
    }
  }
  out.writeEnabled = out.approvedRoots.length > 0;
  return out;
}

/**
 * 域判定：target 是否落在 root 内。大小写归一（Windows），用 relative 防
 * `C:/root2` 误命中 `C:/root` 前缀。`pm` 可注入（测试用 path.posix / path.win32）。
 */
export function isPathWithin(root, target, pm = path) {
  const r = pm.resolve(String(root ?? ''));
  const t = pm.resolve(String(target ?? ''));
  const rel = pm.relative(r.toLowerCase(), t.toLowerCase());
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${pm.sep}`)) return false;
  if (pm.isAbsolute(rel)) return false;
  return true;
}

/** 轻量 inputSchema 校验（required / type / enum / minimum / maximum / pattern / minLength / maxLength）。 */
export function validateArgs(spec, args) {
  const errors = [];
  const s = spec.inputSchema ?? {};
  const a = args ?? {};
  if (s.type === 'object' && (typeof a !== 'object' || a === null || Array.isArray(a))) {
    return { valid: false, errors: ['$: 期望 object'] };
  }
  for (const key of s.required ?? []) {
    if (!(key in a)) errors.push(`缺必填字段 ${key}`);
  }
  for (const [key, sub] of Object.entries(s.properties ?? {})) {
    if (!(key in a)) continue;
    const v = a[key];
    const expected = sub?.type;
    if (expected === 'string' && typeof v !== 'string') errors.push(`${key}: 期望 string`);
    else if (expected === 'integer' && !Number.isInteger(v)) errors.push(`${key}: 期望 integer`);
    else if (expected === 'boolean' && typeof v !== 'boolean') errors.push(`${key}: 期望 boolean`);
    if (typeof v === 'string') {
      if (typeof sub?.pattern === 'string' && !(new RegExp(sub.pattern)).test(v)) errors.push(`${key}: 不匹配 pattern（绝对路径/盘符/.. 逃逸被拒）`);
      if (typeof sub?.minLength === 'number' && v.length < sub.minLength) errors.push(`${key}: 短于 minLength`);
      if (typeof sub?.maxLength === 'number' && v.length > sub.maxLength) errors.push(`${key}: 长于 maxLength`);
    }
    if (Array.isArray(sub?.enum) && !sub.enum.includes(v)) errors.push(`${key}: 不在 enum 白名单`);
    if (typeof sub?.minimum === 'number' && typeof v === 'number' && v < sub.minimum) errors.push(`${key}: 小于 minimum`);
    if (typeof sub?.maximum === 'number' && typeof v === 'number' && v > sub.maximum) errors.push(`${key}: 大于 maximum`);
  }
  return { valid: errors.length === 0, errors };
}

/** resource 文本总闸：超限时返回结构化 envelope，顶层 truncated:true（fail loud，不静默）。 */
export function renderResourceText(data, cap = HEADLESS_RESOURCE_TEXT_LIMIT) {
  const text = typeof data === 'string' ? data : JSON.stringify(data ?? null, null, 2);
  if (text.length <= cap) return { text, truncated: false };
  return {
    text: JSON.stringify({
      truncated: true,
      cap,
      originalLength: text.length,
      preview: text.slice(0, cap),
      hint: 'Resource text exceeded the cap and was truncated. Narrow the query; do NOT assume the preview is complete.',
    }, null, 2),
    truncated: true,
  };
}

/* ------------------------------ kernel（形态对齐 NodeBridge 只读原语） ------------------------------ */

const isDirEntry = (e) => (typeof e?.isDirectory === 'function' ? e.isDirectory() : !!e?.isDirectory);

/**
 * 自包含 Node kernel：只读四条腿 + 最小写腿。`fs` / `path` 均可注入（测试给内存假实现，
 * 不碰真盘）。只读腿刻意对齐 NodeBridge 的 listDir/walkDir/stat/readFileBytes 口径：
 * 逐根失败不抛整批、扩展名不剪枝、读不到就标注，不伪造读数。
 */
export function createNodeKernel(opts = {}) {
  const fs = opts.fs ?? fsp;
  const pm = opts.path ?? path;
  const root = opts.projectRoot ?? process.cwd();
  const MAX_ENTRIES = 5000;

  async function walk(dir, depth, maxDepth) {
    const out = [];
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return out; // 读不到这一个目录 ⇒ 少一批，不抛整批（同 NodeBridge.listDir 口径）
    }
    for (const e of entries) {
      if (out.length >= MAX_ENTRIES) break;
      const full = pm.join(dir, e.name);
      if (isDirEntry(e)) {
        if (depth < maxDepth) out.push(...(await walk(full, depth + 1, maxDepth)));
      } else {
        out.push({ name: e.name, path: full, isDirectory: false });
      }
    }
    return out;
  }

  async function listFiles(maxDepth) {
    return walk(root, 0, maxDepth);
  }

  async function readText(p) {
    try {
      const buf = await fs.readFile(p, 'utf8');
      return typeof buf === 'string' ? buf : String(buf);
    } catch {
      return null; // 读不到不伪造；由调用腿累计 warnings
    }
  }

  return {
    async projectInfo() {
      const files = await listFiles(6);
      const extensions = Object.create(null);
      for (const f of files) {
        const i = f.name.lastIndexOf('.');
        const ext = i > 0 ? f.name.slice(i).toLowerCase() : '(none)';
        extensions[ext] = (extensions[ext] ?? 0) + 1;
      }
      let packageName = null;
      let packageVersion = null;
      const pj = await readText(pm.join(root, 'package.json'));
      if (pj !== null) {
        try {
          const parsed = JSON.parse(pj);
          packageName = typeof parsed.name === 'string' ? parsed.name : null;
          packageVersion = typeof parsed.version === 'string' ? parsed.version : null;
        } catch {
          // 坏 package.json ⇒ 显式 note，不静默
        }
      }
      const warnings = [];
      if (pj === null) warnings.push('package.json 缺席或不可读（显式标注，不静默）');
      return {
        projectRoot: root,
        fileCount: files.length,
        extensions,
        packageName,
        packageVersion,
        truncated: files.length >= MAX_ENTRIES,
        ...(warnings.length ? { warnings } : {}),
      };
    },

    async fileTree(args = {}) {
      const maxDepth = Number.isInteger(args.maxDepth) ? args.maxDepth : 6;
      const maxEntries = Number.isInteger(args.maxEntries) ? args.maxEntries : 500;
      const entries = await walk(root, 0, Math.min(maxDepth, 16));
      const truncated = entries.length > maxEntries;
      return { root, entries: entries.slice(0, maxEntries), total: entries.length, truncated };
    },

    async searchAll(args = {}) {
      const query = String(args.query ?? '').toLowerCase();
      const maxResults = Number.isInteger(args.maxResults) ? args.maxResults : 50;
      const files = await listFiles(6);
      const hits = [];
      let unreadable = 0;
      for (const f of files) {
        if (hits.length >= maxResults) break;
        const text = await readText(f.path);
        if (text === null) {
          unreadable++;
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (hits.length >= maxResults) break;
          if (lines[i].toLowerCase().includes(query)) {
            hits.push({ path: f.path, line: i + 1, preview: lines[i].trim().slice(0, 200) });
          }
        }
      }
      return {
        query: args.query ?? '',
        hits,
        total: hits.length,
        truncated: hits.length >= maxResults,
        ...(unreadable ? { warnings: [`${unreadable} 个文件不可读（显式标注，不静默）`] } : {}),
      };
    },

    /** 语言/校验层：通用文本校验，零游戏知识；只读。 */
    async diagnostics(args = {}) {
      const maxResults = Number.isInteger(args.maxResults) ? args.maxResults : 200;
      const files = await listFiles(6);
      const items = [];
      const push = (rule, message, p, line) => {
        if (items.length < maxResults) items.push({ rule, message, path: p, line });
      };
      for (const f of files) {
        if (items.length >= maxResults) break;
        const text = await readText(f.path);
        if (text === null) continue;
        if (text.includes('\0')) push('nul-byte', '文件含 NUL 字节', f.path, 1);
        const lines = text.split(/\r?\n/);
        let braces = 0;
        let parens = 0;
        let brackets = 0;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (/[ \t]+$/.test(line)) push('trailing-whitespace', '行尾空白', f.path, i + 1);
          if (line.length > 500) push('overlong-line', `行超长（${line.length} 字符）`, f.path, i + 1);
          for (const ch of line) {
            if (ch === '{') braces++;
            else if (ch === '}') braces--;
            else if (ch === '(') parens++;
            else if (ch === ')') parens--;
            else if (ch === '[') brackets++;
            else if (ch === ']') brackets--;
          }
        }
        if (braces !== 0) push('unbalanced-bracket', `花括号未配对（差 ${braces}）`, f.path, lines.length);
        if (parens !== 0) push('unbalanced-bracket', `圆括号未配对（差 ${parens}）`, f.path, lines.length);
        if (brackets !== 0) push('unbalanced-bracket', `方括号未配对（差 ${brackets}）`, f.path, lines.length);
      }
      return { items, total: items.length, truncated: items.length >= maxResults };
    },

    /* 写腿：只在显式授权 + 域内被调用；本原型不复制 Rust 侧写侧真相，仅提供最小、可拒绝的入口。 */
    async writeFile(target, content) {
      await fs.mkdir(pm.dirname(target), { recursive: true }).catch(() => {});
      const body = String(content ?? '');
      await fs.writeFile(target, body, 'utf8');
      return { written: target, chars: body.length };
    },
    async remove(target, recursive) {
      await fs.rm(target, { recursive: !!recursive, force: false });
      return { removed: target };
    },
    async rename(from, to) {
      await fs.mkdir(pm.dirname(to), { recursive: true }).catch(() => {});
      await fs.rename(from, to);
      return { from, to };
    },
  };
}

/* ------------------------------ JSON-RPC 装配 ------------------------------ */

function ok(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function fail(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

/**
 * 造 headless server。`kernel` 是注入 seam：传入即用（测试给假实现，不真写盘 / 不发 stdio）；
 * 缺省用 `createNodeKernel` 构造真 Node 只读 kernel。
 */
export function createHeadlessServer(opts = {}) {
  const pm = opts.path ?? path;
  const projectRoot = opts.projectRoot ?? process.cwd();
  const approvedRoots = [...(opts.approvedRoots ?? [])];
  const writeEnabled = opts.writeEnabled ?? approvedRoots.length > 0;
  const kernel = opts.kernel ?? createNodeKernel({ fs: opts.fs, path: pm, projectRoot });

  const readByName = new Map(HEADLESS_READ_TOOL_SPECS.map((s) => [s.name, s]));
  const writeByName = new Map(HEADLESS_WRITE_TOOL_SPECS.map((s) => [s.name, s]));
  const allByName = new Map([...readByName, ...writeByName]);

  const state = {
    initialized: false,
    clientAuthorized: false,
    clientInfo: null,
  };

  const targetOf = (relPath) => pm.resolve(projectRoot, String(relPath ?? ''));
  const inWriteDomain = (relPath) => approvedRoots.some((r) => isPathWithin(r, targetOf(relPath), pm));

  /** 写能力三重闸：未初始化 / 客户端身份未授权 / 未开写 —— 全部显式报错，不静默。 */
  function writeGate() {
    if (!state.initialized) return { code: 'NOT_INITIALIZED', message: '写能力不可用：尚未收到 initialize（客户端未初始化），不静默' };
    if (!state.clientAuthorized) return { code: 'CLIENT_UNAUTHORIZED', message: '写能力不可用：initialize 未提供 clientInfo.name（编辑器/AI 客户端身份未授权），不静默' };
    if (!writeEnabled) return { code: 'WRITE_DISABLED', message: '写能力默认关闭：须显式传 --allow-write <已批准根> 才开启，不静默' };
    return null;
  }

  function toolsList() {
    const read = HEADLESS_READ_TOOL_SPECS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
    if (!writeEnabled) return read;
    const write = HEADLESS_WRITE_TOOL_SPECS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
    return [...read, ...write];
  }

  function initializeResult() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {} },
      serverInfo: SERVER_INFO,
      // _kojo 是给客户端/主 agent 排障用的可读授权面（不是标准 MCP 字段，但 fail loud）。
      _kojo: {
        readOnly: !writeEnabled,
        writeAuthorized: writeEnabled,
        approvedRoots,
        clientAuthorized: state.clientAuthorized,
        notice: writeEnabled
          ? '写能力已按 --allow-write 开启；每次写调用仍逐项校验客户端身份与域内路径。'
          : '写能力默认关闭（只读）。如需写，重启并显式传 --allow-write <已批准根>；域外路径一律拒绝。',
      },
    };
  }

  async function dispatch(name, args) {
    switch (name) {
      case 'project.info':
        return kernel.projectInfo(args);
      case 'fs.tree':
        return kernel.fileTree(args);
      case 'search.all':
        return kernel.searchAll(args);
      case 'diagnostics.read':
        return kernel.diagnostics(args);
      case 'fs.write':
        return kernel.writeFile(targetOf(args.relPath), args.content);
      case 'fs.remove':
        return kernel.remove(targetOf(args.relPath), args.recursive);
      case 'fs.rename':
        return kernel.rename(targetOf(args.from), targetOf(args.to));
      default:
        throw new Error(`未接线的工具 ${name}`);
    }
  }

  async function callTool(id, params) {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const spec = allByName.get(name);
    if (!spec) return fail(id, -32601, `Unknown tool: ${String(name)}`, { code: 'UNKNOWN_TOOL' });

    const isWrite = writeByName.has(name);
    if (isWrite) {
      const gate = writeGate();
      if (gate) return fail(id, -32000, gate.message, { code: gate.code });
    }

    const checked = validateArgs(spec, args);
    if (!checked.valid) {
      return fail(id, -32602, `Invalid args for ${name}: ${checked.errors.join('；')}`, { code: 'INVALID_ARGS' });
    }

    // 写调用：逐项复核域（pattern 已在 validateArgs 拒绝对路径/..；这里再按 approvedRoots 复核）。
    if (isWrite) {
      const rels = name === 'fs.rename' ? [args.from, args.to] : [args.relPath];
      for (const rel of rels) {
        if (!inWriteDomain(rel)) {
          return fail(id, -32000, `域外目标被拒：${String(rel)} 不在任何 --allow-write 已批准根内（projectRoot=${projectRoot}），不静默`, { code: 'OUT_OF_DOMAIN', relPath: String(rel) });
        }
      }
    }

    try {
      const result = await dispatch(name, args);
      return ok(id, { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] });
    } catch (err) {
      return fail(id, -32000, `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`, { code: 'TOOL_EXECUTION_FAILED' });
    }
  }

  async function readResource(id, params) {
    const uri = params?.uri;
    const known = HEADLESS_RESOURCE_SPECS.find((r) => r.uri === uri);
    if (!known) return fail(id, -32002, `Unknown resource: ${String(uri)}`, { code: 'UNKNOWN_RESOURCE' });
    let data;
    try {
      if (uri === 'kojo://headless/project') data = await kernel.projectInfo({});
      else if (uri === 'kojo://headless/file-tree') data = await kernel.fileTree({});
      else data = await kernel.diagnostics({});
    } catch (err) {
      return fail(id, -32000, `Resource ${uri} unavailable: ${err instanceof Error ? err.message : String(err)}`, { code: 'RESOURCE_UNAVAILABLE' });
    }
    const { text, truncated } = renderResourceText(data);
    return ok(id, { contents: [{ uri, mimeType: known.mimeType, text, truncated }] });
  }

  /** 处理单条 JSON-RPC 消息；notification 返回 null（不回包）。 */
  async function handle(msg) {
    const id = msg?.id;
    const isNotification = id === undefined || id === null;
    const method = msg?.method;
    const params = msg?.params ?? {};
    switch (method) {
      case 'initialize': {
        state.initialized = true;
        state.clientInfo = params?.clientInfo ?? null;
        state.clientAuthorized = typeof params?.clientInfo?.name === 'string' && params.clientInfo.name.length > 0;
        return ok(id, initializeResult());
      }
      case 'notifications/initialized':
        return null;
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: toolsList() });
      case 'tools/call':
        return callTool(id, params);
      case 'resources/list':
        return ok(id, { resources: HEADLESS_RESOURCE_SPECS });
      case 'resources/read':
        return readResource(id, params);
      default:
        return isNotification ? null : fail(id, -32601, `Method not found: ${String(method)}`);
    }
  }

  return {
    handle,
    toolsList,
    projectRoot,
    approvedRoots,
    writeEnabled,
    get readOnly() {
      return !writeEnabled;
    },
    get state() {
      return { ...state };
    },
  };
}

/* ------------------------------ stdio 主循环（仅作为主模块时启动） ------------------------------ */

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[kojo-mcp-headless] 参数错误：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const server = createHeadlessServer({
    projectRoot: args.projectRoot,
    approvedRoots: args.approvedRoots,
    writeEnabled: args.writeEnabled,
  });
  console.error(
    `[kojo-mcp-headless] stdio 就绪：project=${args.projectRoot} ` +
      `write=${args.writeEnabled ? `ON (roots=${args.approvedRoots.join(',')})` : 'OFF (read-only)'} — 等待 initialize`,
  );

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // 串行链：逐行读取但按序应答，避免 async 工具腿造成响应乱序。
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    chain = chain
      .then(async () => {
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch (err) {
          process.stdout.write(`${JSON.stringify(fail(null, -32700, `Parse error: ${err instanceof Error ? err.message : String(err)}`))}\n`);
          return;
        }
        try {
          const resp = await server.handle(msg);
          if (resp !== null && resp !== undefined) process.stdout.write(`${JSON.stringify(resp)}\n`);
        } catch (err) {
          process.stdout.write(`${JSON.stringify(fail(msg?.id ?? null, -32603, `Internal error: ${err instanceof Error ? err.message : String(err)}`))}\n`);
        }
      })
      .catch((err) => {
        process.stdout.write(`${JSON.stringify(fail(null, -32603, `Internal error: ${err instanceof Error ? err.message : String(err)}`))}\n`);
      });
  });
  rl.on('close', () => {
    void chain.then(() => process.exit(0));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
