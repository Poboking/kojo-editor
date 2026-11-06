/**
 * tools/mcp-list-payload-evidence.mjs —— **`tools/list` 载荷体积取证量具**（B21 测量车道，非产品功能）。
 *
 * 只做一件事：把「列一次工具表到底吃多少字节、多少毫秒」量出来，并给出可执行判断。
 * **零生产代码改动**：不注册工具、不加档位、不动 `Limits` 五格、不改任何 schema。
 *
 * 两条通道（口径不许互借，PITFALLS 236）：
 *  - `static`：把注册表真源 `packages/mcp-host/src/index.ts` **真的装载起来**
 *    （vite `ssrLoadModule`，与运行时同一份代码），按会话档位算 `tools/list` 的 JSON 字节数、
 *    逐工具占比、`description` vs `inputSchema` 的字节分配、`additionalProperties:false` 的成本。
 *    **不手写估计的 schema**——装载失败就红着退出，不降级成正则猜。
 *  - `shell`：对一台**正在跑的真桌面壳**（`node tools/debug-cli.mjs shell`，会话 `mode` 必须是
 *    `shell`）打真实 `tools/list` 帧，记 HTTP 响应体字节、帧解析耗时、p50/p95，
 *    以及壳内 `mcp_latency_query` 台账的 `http#tools/list` / `tools/list` 两行；
 *    另经 stdio shim（`tools/kojo-mcp.mjs`）再打一遍，量 shim 那一层的额外字节与时间。
 *
 * 通道自证口径（PITFALLS 354）：判据＝`sessions/<key>/session.json` 的 `mode` + `repoRoot` +
 * `createdAt`，**不是** `packages/app/src-tauri/target/` 是否存在（本机 `~/.cargo/config.toml`
 * 重定向了 `target-dir`，那条判据必然假红）。
 *
 * 红线（脚本自身保证）：
 *  - 不放宽任何闸：客户端按 ≤`--quota-per-minute`（默认 110 < 120）节流；体积闸 1 MiB 一字不动，
 *    读数里只报「距闸还剩多少」，不为了塞进闸而裁剪载荷；
 *  - 真盘根零进仓：语料只从 `KOJO_CORPUS_DIR` / `KOJO_CORPUS_SCAN_DIRS` / `--corpus-dir` 来；
 *  - token 只走内存与环境变量，stdout / JSON / 错误消息里**永不出现 token 字面量**；
 *  - 取不到的格子如实写 `unavailable` + 原因 + 复现命令，绝不拿估算或另一通道的数冒充；
 *  - 默认输出落 `os.tmpdir()`，仓库里不留产物。
 *
 * 用法：
 *   node tools/mcp-list-payload-evidence.mjs static [--top 10] [--out <json>]
 *   node tools/mcp-list-payload-evidence.mjs dedup  [--out <json>]   # 逐字重复账（B22：哪些字符串被几枚面各抄一份）
 *   node tools/mcp-list-payload-evidence.mjs shell  [--n 24] [--rearm] [--out <json>]
 *   node tools/mcp-list-payload-evidence.mjs compare [--n 24]      # shell 的 tools/list vs 同壳单条 tools/call
 *   node tools/mcp-list-payload-evidence.mjs wire   [--n 3] [--out <json>] [--no-approve]
 *     ↑ B26 补的**线协议逐字段账**模式（不改上面任何模式的判据语义）：同一台真壳里抓两帧
 *       `tools/list` 全帧（缺省只读会话 + 全量批准会话），与 `static` 面**逐格对账**
 *       （信封 / `_meta` / 逐枚工具字节差 / 序列化漂移），并把 Rust 的 2048 字符闸
 *       做成**壳内实拍**（帧里最长描述、有无 `…[truncated]`、schema 侧描述同样查）。
 * 退出码：0 全绿；2 参数 / 通道不对（没起真壳、mode 不是 shell、注册表装不起来）；
 *         3 端点起不来 / 语料或项目没就位；4 有失败帧（已取到的读数仍写出）。
 */
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPT_DIR, '..');

/* ------------------------------ 通用小工具 ------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = {
    cmd: 'static',
    top: 10,
    n: 24,
    quotaPerMinute: 110,
    corpusDir: null,
    out: null,
    allowRearm: false,
    noApprove: false,
    armWaitMs: 90_000,
    callN: 24,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === 'static' || a === 'shell' || a === 'compare' || a === 'dedup' || a === 'wire') out.cmd = a;
    else if (a === '--top') out.top = Number(next());
    else if (a === '--n') out.n = Number(next());
    else if (a === '--call-n') out.callN = Number(next());
    else if (a === '--quota-per-minute') out.quotaPerMinute = Number(next());
    else if (a === '--corpus-dir') out.corpusDir = next();
    else if (a === '--out') out.out = next();
    else if (a === '--arm-wait-ms') out.armWaitMs = Number(next());
    else if (a === '--rearm') out.allowRearm = true;
    else if (a === '--no-approve') out.noApprove = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        '用法：node tools/mcp-list-payload-evidence.mjs <static|shell|compare>' +
          ' [--top N] [--n N] [--call-n N] [--quota-per-minute Q] [--corpus-dir <目录>] [--out <json>] [--rearm]',
      );
      process.exit(0);
    } else {
      console.error(`[FAIL] 未知参数：${a}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(out.n) || out.n < 1) {
    console.error('[FAIL] --n 必须是正整数');
    process.exit(2);
  }
  return out;
}

/** 最近秩分位（与壳内台账同口径：升序后取第 ceil(q·n) 个，1-based）。 */
function percentile(sorted, q) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(1, Math.ceil(q * sorted.length)) - 1];
}

function stats(list) {
  const s = [...list].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: percentile(s, 0.5),
    p95: percentile(s, 0.95),
    min: s.length ? s[0] : null,
    max: s.length ? s[s.length - 1] : null,
    raw: s,
  };
}

function utf8Bytes(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf-8');
}

/** 子串出现次数（非重叠、按 indexOf 前推）。 */
function splitCount(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    n += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
}

/**
 * 逐面长描述里**共用的最长后缀**：从真实描述串算，不硬编码文案（`PAGE_STRICT_NOTE` /
 * `LAUNCHER_TIER_NOTE` 这些尾注没导出，正则抓源码等于手写一份估计——都不作数）。
 * 口径＝对每个候选长度 L 把各描述的「末 L 字符」分组，取 `枚数 × L` 最大的那一格，
 * 并要求枚数 ≥minSupport（少于一组同族面不算样板）。复杂度 O(枚数 × 最长描述长度)。
 */
function longestSharedSuffix(descriptions, minSupport = 3) {
  const list = descriptions.filter((d) => typeof d === 'string' && d.length > 0);
  if (list.length < minSupport) return { suffix: '', count: 0, bytes: 0 };
  const maxLen = Math.max(...list.map((d) => d.length));
  let best = { suffix: '', count: 0, bytes: 0 };
  for (let len = 20; len <= maxLen; len += 1) {
    const tally = new Map();
    for (const d of list) {
      if (d.length < len) continue;
      const suf = d.slice(-len);
      tally.set(suf, (tally.get(suf) ?? 0) + 1);
    }
    for (const [suf, count] of tally) {
      if (count >= minSupport && count * len > best.bytes) best = { suffix: suf, count, bytes: count * len };
    }
  }
  return best;
}

/** 从任意输出尾部抠出最后一个合法 JSON（debug-cli 前面可能还有提示行）。 */
function lastJson(text) {
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const candidate = lines.slice(i).join('\n').trim();
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      /* 继续往前退 */
    }
  }
  return null;
}

function runDebugCli(cliArgs, opts = {}) {
  const res = spawnSync(process.execPath, [path.join('tools', 'debug-cli.mjs'), ...cliArgs], {
    cwd: REPO,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
    timeout: opts.timeoutMs ?? 300_000,
  });
  return { rc: res.status, stdout: (res.stdout ?? '') + (res.stderr ?? ''), error: res.error?.message ?? null };
}

/* ======================================================================
 * A 面：静态规格面（注册表真源装载，不是正则猜）
 * ===================================================================== */

/**
 * 把 `packages/mcp-host/src/index.ts` 经 vite 的 SSR 变换真的装载成模块。
 * 装载不起来 ⇒ rc=2 退出，**不降级成源码文本正则**（那等于手写一份估计的 schema）。
 */
async function loadRegistry() {
  let vite;
  try {
    vite = await import('vite');
  } catch (err) {
    console.error(
      `[FAIL] 装载 vite 失败（${err?.message ?? err}）——复现：node tools/mcp-list-payload-evidence.mjs static`,
    );
    process.exit(2);
  }
  const server = await vite.createServer({
    root: REPO,
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  try {
    const mod = await server.ssrLoadModule('/packages/mcp-host/src/index.ts');
    for (const need of ['createMcpCapabilityRegistry', 'SEMANTIC_TOOL_SPECS', 'KERNEL_IO_TOOL_SPECS', 'SUPPLEMENTAL_TOOL_SPECS']) {
      if (!mod[need]) {
        console.error(`[FAIL] 注册表真源装载成功但缺导出 ${need}——A 面读数不可信，如实失败。`);
        process.exit(2);
      }
    }
    return { mod, dispose: () => server.close() };
  } catch (err) {
    await server.close().catch(() => {});
    console.error(
      `[FAIL] 注册表真源装不起来（${err?.message ?? err}）——A 面拒绝出估算数。复现：node tools/mcp-list-payload-evidence.mjs static`,
    );
    process.exit(2);
  }
}

/** 会话 scope 形状（与 `McpSessionScope` 契约一致；approvedTools 用真实批准面）。 */
function scopeOf(tier, approvedTools = []) {
  return { sessionId: 'evidence', clientId: 'evidence', tier, approvedRoots: [], approvedTools };
}

/** 一个工具在**线协议上**的形态：`run` 是函数，JSON 序列化即消失；其余键原样进帧。 */
function wireTool(tool) {
  const { run, ...rest } = tool;
  return rest;
}

/** 逐字段字节账：把一枚工具的序列化字节拆成 description / inputSchema / 其余（name、tier、annotations、标点）。 */
function toolByteBreakdown(tool) {
  const full = utf8Bytes(wireTool(tool));
  const desc = tool.description === undefined ? 0 : utf8Bytes(tool.description);
  const schema = tool.inputSchema === undefined ? 0 : utf8Bytes(tool.inputSchema);
  return {
    name: tool.name,
    tier: tool.tier,
    bytes: full,
    descriptionBytes: desc,
    inputSchemaBytes: schema,
    otherBytes: full - desc - schema,
    descriptionChars: (tool.description ?? '').length,
  };
}

/** 统计 `additionalProperties:false` 在一棵 schema 树里出现的次数与字面字节成本。 */
function countAdditionalProperties(node, acc) {
  if (Array.isArray(node)) {
    for (const item of node) countAdditionalProperties(item, acc);
    return acc;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'additionalProperties' && v === false) {
        acc.hits += 1;
        acc.bytes += utf8Bytes({ [k]: v });
      } else {
        countAdditionalProperties(v, acc);
      }
    }
  }
  return acc;
}

async function faceStatic(args) {
  const { mod, dispose } = await loadRegistry();
  try {
    const reg = mod.createMcpCapabilityRegistry({});
    const specAll = [
      ...mod.SEMANTIC_TOOL_SPECS.map((s) => ({ ...s, source: 'SEMANTIC' })),
      ...mod.KERNEL_IO_TOOL_SPECS.map((s) => ({ ...s, source: 'KERNEL_IO' })),
      ...mod.SUPPLEMENTAL_TOOL_SPECS.map((s) => ({ ...s, source: 'SUPPLEMENTAL' })),
    ];
    const privilegedNames = specAll.filter((s) => s.tier === 'privileged').map((s) => s.name);
    const allNames = specAll.map((s) => s.name);

    // 注册表侧的四个可见面（listTools 的 tier 闸）。
    const faces = {
      full_all_approved: reg.listTools(scopeOf('privileged', allNames)),
      privileged_approved: reg.listTools(scopeOf('privileged', privilegedNames)),
      read_session: reg.listTools(scopeOf('read')),
      edit_session: reg.listTools(scopeOf('edit')),
      // 默认会话可见面＝Rust scope.rs 未授权时的缺省（tier=read、approvedTools 空）。
      default_session: reg.listTools(scopeOf('read')),
    };

    const faceReport = {};
    for (const [key, tools] of Object.entries(faces)) {
      const frame = { jsonrpc: '2.0', id: 'evidence', result: { tools: tools.map(wireTool) } };
      const breakdown = tools.map(toolByteBreakdown);
      const descBytes = breakdown.reduce((a, t) => a + t.descriptionBytes, 0);
      const schemaBytes = breakdown.reduce((a, t) => a + t.inputSchemaBytes, 0);
      const otherBytes = breakdown.reduce((a, t) => a + t.otherBytes, 0);
      faceReport[key] = {
        toolCount: tools.length,
        frameBytes: utf8Bytes(frame),
        toolsArrayBytes: utf8Bytes(tools.map(wireTool)),
        descriptionBytes: descBytes,
        inputSchemaBytes: schemaBytes,
        otherBytes,
        descriptionSharePct: Number(((descBytes / (descBytes + schemaBytes + otherBytes)) * 100).toFixed(1)),
        inputSchemaSharePct: Number(((schemaBytes / (descBytes + schemaBytes + otherBytes)) * 100).toFixed(1)),
        avgBytesPerTool: Number((utf8Bytes(tools.map(wireTool)) / Math.max(1, tools.length)).toFixed(1)),
        tierCounts: tools.reduce((a, t) => ({ ...a, [t.tier]: (a[t.tier] ?? 0) + 1 }), {}),
      };
    }

    // 严格化成本（B11）：全量面上 additionalProperties:false 的出现次数与字面字节。
    const apAcc = { hits: 0, bytes: 0 };
    for (const t of faces.full_all_approved) countAdditionalProperties(t.inputSchema, apAcc);

    // 逐工具字节账（按 tier 分组 + 最胖的 N 枚）。
    const perTool = faces.full_all_approved.map(toolByteBreakdown).sort((a, b) => b.bytes - a.bytes);
    const byTierBytes = {};
    for (const t of faces.full_all_approved.map(toolByteBreakdown)) {
      const g = (byTierBytes[t.tier] ??= { tools: 0, bytes: 0, descriptionBytes: 0, inputSchemaBytes: 0 });
      g.tools += 1;
      g.bytes += t.bytes;
      g.descriptionBytes += t.descriptionBytes;
      g.inputSchemaBytes += t.inputSchemaBytes;
    }

    // 规格表里有没有 description 顶到 Rust 二次截断闸（MAX_DESCRIPTION_CHARS＝2048 字符）。
    const cap = 2048;
    const overCap = perTool.filter((t) => t.descriptionChars > cap);
    const cappedBytes = faces.full_all_approved.reduce(
      (a, t) => a + utf8Bytes({ ...wireTool(t), description: (t.description ?? '').slice(0, cap) }),
      0,
    );

    /* 共用样板的成本：
       ① `PAGE_ACCOUNT_NOTE`（分页账尾注，导出真源）在多少枚描述里出现、吃掉多少字节；
       ② 逐面长描述的**最长公共后缀**（≥3 枚共用才算样板）——从真实字符串里算出来，
          不硬编码任何一句文案，避免「描述改了、账还对不上」。 */
    const pageNote = typeof mod.PAGE_ACCOUNT_NOTE === 'string' ? mod.PAGE_ACCOUNT_NOTE : null;
    let pageNoteHits = 0;
    let pageNoteBytes = 0;
    if (pageNote) {
      for (const t of faces.full_all_approved) {
        const n = splitCount(t.description ?? '', pageNote);
        if (n > 0) {
          pageNoteHits += 1;
          pageNoteBytes += n * utf8Bytes(pageNote);
        }
      }
    }
    const boiler = longestSharedSuffix(faces.full_all_approved.map((t) => t.description ?? ''));

    /* 前缀族分组（候选 (c)「按前缀收窄的 list 视图」的唯一可核对依据）：
       族名＝工具名第一个分隔符（`.` 或 `_`）之前的那一段；逐族给枚数与字节，
       于是「砍掉 launcher_ 一族能省多少」是算出来的，不是嘴上说的。 */
    const byFamily = {};
    for (const t of faces.full_all_approved.map(toolByteBreakdown)) {
      const fam = t.name.split(/[._]/)[0] || '(空)';
      const g = (byFamily[fam] ??= { tools: 0, bytes: 0, descriptionBytes: 0, inputSchemaBytes: 0, tiers: {} });
      g.tools += 1;
      g.bytes += t.bytes;
      g.descriptionBytes += t.descriptionBytes;
      g.inputSchemaBytes += t.inputSchemaBytes;
      g.tiers[t.tier] = (g.tiers[t.tier] ?? 0) + 1;
    }
    const familyTable = Object.entries(byFamily)
      .map(([family, g]) => ({ family, ...g, pctOfFullFace: Number(((g.bytes / faceReport.full_all_approved.toolsArrayBytes) * 100).toFixed(1)) }))
      .sort((a, b) => b.bytes - a.bytes);

    const report = {
      channel: 'static（注册表真源经 vite ssrLoadModule 装载；非正则估、非镜像数）',
      registrySource: 'packages/mcp-host/src/index.ts',
      specTotal: specAll.length,
      specByTier: specAll.reduce((a, s) => ({ ...a, [s.tier]: (a[s.tier] ?? 0) + 1 }), {}),
      specBySource: specAll.reduce((a, s) => ({ ...a, [s.source]: (a[s.source] ?? 0) + 1 }), {}),
      faces: faceReport,
      strictness: {
        additionalPropertiesFalseHits: apAcc.hits,
        additionalPropertiesFalseBytes: apAcc.bytes,
        note: 'hits＝全量面上 additionalProperties:false 的字面出现次数；bytes＝这些键值对序列化后的字节合计（不含它们各自挤掉的宽松形态，差值口径见 B11 描述）。',
      },
      perTierBytes: byTierBytes,
      familyTable,
      boilerplate: {
        pageAccountNote: pageNote
          ? {
              exportedFrom: 'mod.PAGE_ACCOUNT_NOTE',
              chars: pageNote.length,
              toolsCarryingIt: pageNoteHits,
              totalBytes: pageNoteBytes,
              pctOfDescriptionBytes: Number(((pageNoteBytes / faceReport.full_all_approved.descriptionBytes) * 100).toFixed(1)),
            }
          : { unavailable: true, note: 'PAGE_ACCOUNT_NOTE 没导出 ⇒ 该格未取到' },
        longestSharedDescriptionSuffix: boiler.count >= 3
          ? {
              tools: boiler.count,
              charsPerCopy: boiler.suffix.length,
              totalBytes: boiler.bytes,
              pctOfDescriptionBytes: Number(((boiler.bytes / faceReport.full_all_approved.descriptionBytes) * 100).toFixed(1)),
              preview: `${boiler.suffix.slice(0, 90)}…`,
            }
          : { unavailable: true, note: '没找到 ≥3 枚共用的描述后缀 ⇒ 该格未取到' },
      },
      topFattest: perTool.slice(0, args.top),
      descriptionCapGate: {
        rustMaxDescriptionChars: cap,
        toolsOverCap: overCap.length,
        overCapNames: overCap.map((t) => t.name),
        bytesIfAllDescriptionsCapped: cappedBytes,
        bytesNow: faceReport.full_all_approved.toolsArrayBytes,
        bytesSavedByCapping: faceReport.full_all_approved.toolsArrayBytes - cappedBytes,
      },
      volumeGate: {
        maxResponseBytes: 1024 * 1024,
        headroomBytes: 1024 * 1024 - faceReport.full_all_approved.frameBytes,
        note: '体积闸只报读数与余量，本批不动闸。',
      },
      /* 候选 (b) 的**投影成本**：直接走 B1 的 `paginateByCursor` 真码路（不是另写一份分页算术），
         页大小取几个候选档，逐档给「每页帧字节 / 页数 / 全部页加起来的总字节 / 信封净增字节」。
         这条不是实测端点读数，是**用真游标码路算的投影**，字段名里写明 projected。 */
      paginationProjected:
        typeof mod.paginateByCursor === 'function'
          ? [10, 20, 25, 40].map((limit) => {
              const wire = faces.full_all_approved.map(wireTool);
              let cursor = undefined;
              const pages = [];
              for (let guard = 0; guard < 200; guard += 1) {
                const args = cursor === undefined ? { limit } : { limit, cursor };
                const p = mod.paginateByCursor(wire, (it) => it.name, args, { defaultLimit: limit, maxLimit: limit });
                const frame = { jsonrpc: '2.0', id: 'e', result: { tools: p.page, nextCursor: p.nextCursor, total: p.total, offset: p.offset, limit: p.limit, hasMore: p.hasMore, truncated: p.truncated, fingerprint: p.fingerprint } };
                pages.push({ bytes: utf8Bytes(frame), tools: p.page.length });
                if (!p.hasMore || !p.nextCursor) break;
                cursor = p.nextCursor;
              }
              const totalBytes = pages.reduce((a, x) => a + x.bytes, 0);
              return {
                pageLimit: limit,
                pages: pages.length,
                bytesPerPageFirst: pages[0]?.bytes ?? null,
                bytesPerPageMax: Math.max(...pages.map((x) => x.bytes)),
                totalBytesAcrossAllPages: totalBytes,
                fullFaceFrameBytes: faceReport.full_all_approved.frameBytes,
                netExtraBytesVsOneFrame: totalBytes - faceReport.full_all_approved.frameBytes,
                roundTripsNeeded: pages.length,
              };
            })
          : [{ unavailable: true, note: 'paginateByCursor 没导出 ⇒ 该投影未取到' }],
    };
    return report;
  } finally {
    await dispose();
  }
}

/* ======================================================================
 * A2 面：逐字重复账（B22 去重车道）——同一份注册表真源，只换算「哪些字符串被抄了几份」
 * ===================================================================== */

/** 句子切分：英文句末标点后接空白；中文 `。` 后可能紧跟下一句（无空白），故 `\s*`。 */
function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?。])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40);
}

/** 收集一棵 schema 树里**所有** `description` 字符串值（含逐属性描述、嵌套对象里的描述）。 */
function collectSchemaDescriptions(node, acc) {
  if (Array.isArray(node)) {
    for (const item of node) collectSchemaDescriptions(item, acc);
    return acc;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'description' && typeof v === 'string') acc.push(v);
      else collectSchemaDescriptions(v, acc);
    }
  }
  return acc;
}

/** 通用重复账：一组字符串 ⇒ 按整串相等分组，occurrences ≥ minOcc 的进账。
 *  `dupBytes`＝只留一份、其余全算抄写成本（bytes × (occurrences − 1)）。 */
function duplicationTally(entries, minOcc = 3) {
  const groups = new Map();
  for (const { text, tool, slot } of entries) {
    if (typeof text !== 'string' || text.length < 40) continue;
    const g = groups.get(text) ?? { occurrences: 0, tools: new Set(), chars: text.length, slots: [] };
    g.occurrences += 1;
    g.tools.add(tool);
    g.slots.push(slot);
    groups.set(text, g);
  }
  const list = [...groups.entries()]
    .filter(([, g]) => g.occurrences >= minOcc)
    .map(([text, g]) => ({
      chars: g.chars,
      bytes: utf8Bytes(text),
      occurrences: g.occurrences,
      faces: g.tools.size,
      totalBytes: utf8Bytes(text) * g.occurrences,
      dupBytes: utf8Bytes(text) * (g.occurrences - 1),
      faceList: [...g.tools].slice(0, 6),
      head: text.slice(0, 120),
    }))
    .sort((a, b) => b.dupBytes - a.dupBytes);
  return {
    groups: list.length,
    occurrencesInDuplicateGroups: list.reduce((a, x) => a + x.occurrences, 0),
    totalBytesInDuplicateGroups: list.reduce((a, x) => a + x.totalBytes, 0),
    wasteBytesIfKeepOneCopy: list.reduce((a, x) => a + x.dupBytes, 0),
    entries: list,
  };
}

async function faceDedup(args) {
  const { mod, dispose } = await loadRegistry();
  try {
    const reg = mod.createMcpCapabilityRegistry({});
    const specAll = [
      ...mod.SEMANTIC_TOOL_SPECS.map((s) => ({ ...s, source: 'SEMANTIC' })),
      ...mod.KERNEL_IO_TOOL_SPECS.map((s) => ({ ...s, source: 'KERNEL_IO' })),
      ...mod.SUPPLEMENTAL_TOOL_SPECS.map((s) => ({ ...s, source: 'SUPPLEMENTAL' })),
    ];
    const allNames = specAll.map((s) => s.name);
    const full = reg.listTools(scopeOf('privileged', allNames));
    const breakdown = full.map(toolByteBreakdown);
    const sum = (key) => breakdown.reduce((a, t) => a + t[key], 0);

    /* ① 逐面 description 的句子级重复（跨面抄写）。 */
    const sentenceEntries = [];
    for (const t of full) {
      for (const s of splitSentences(t.description ?? '')) {
        sentenceEntries.push({ text: s, tool: t.name, slot: 'description' });
      }
    }
    const sentences = duplicationTally(sentenceEntries, 3);

    /* ② inputSchema 里逐属性 description 的整串重复（同面七个别名各抄一份也算）。 */
    const schemaEntries = [];
    for (const t of full) {
      const acc = collectSchemaDescriptions(t.inputSchema ?? {}, []);
      acc.forEach((d, i) => schemaEntries.push({ text: d, tool: t.name, slot: `inputSchema#${i}` }));
    }
    const schemaDescriptions = duplicationTally(schemaEntries, 3);
    const schemaDescBytesAll = schemaEntries.reduce((a, e) => a + utf8Bytes(e.text), 0);

    /* ③ 导出常量：以真值逐面核对（描述里算子串出现，schema 里算整串相等——避开 JSON 转义假阴）。 */
    const exportedConstants = [];
    for (const [k, v] of Object.entries(mod)) {
      if (typeof v !== 'string' || v.length < 80) continue;
      let inDescriptions = 0;
      let inSchema = 0;
      const faces = new Set();
      for (const t of full) {
        const d = splitCount(t.description ?? '', v);
        const s = collectSchemaDescriptions(t.inputSchema ?? {}, []).filter((x) => x === v).length;
        if (d + s > 0) {
          inDescriptions += d;
          inSchema += s;
          faces.add(t.name);
        }
      }
      const occ = inDescriptions + inSchema;
      if (occ < 2) continue;
      exportedConstants.push({
        name: k,
        chars: v.length,
        bytes: utf8Bytes(v),
        occurrences: occ,
        inDescriptions,
        inSchema,
        faces: faces.size,
        totalBytes: utf8Bytes(v) * occ,
        dupBytes: utf8Bytes(v) * (occ - 1),
        head: v.slice(0, 120),
      });
    }
    exportedConstants.sort((a, b) => b.dupBytes - a.dupBytes);

    /* ④ 族级重复账：一族的描述字节里有多少落在"跨面抄写"的句子上。 */
    const sentenceOcc = new Map();
    for (const e of sentenceEntries) sentenceOcc.set(e.text, (sentenceOcc.get(e.text) ?? 0) + 1);
    const familyDup = {};
    for (const t of full) {
      const fam = t.name.split(/[._]/)[0] || '(空)';
      const g = (familyDup[fam] ??= { tools: 0, descriptionBytes: 0, sentenceDupBytes: 0 });
      g.tools += 1;
      g.descriptionBytes += t.description ? utf8Bytes(t.description) : 0;
      for (const s of splitSentences(t.description ?? '')) {
        if ((sentenceOcc.get(s) ?? 0) >= 3) g.sentenceDupBytes += utf8Bytes(s);
      }
    }

    return {
      channel: 'dedup（注册表真源经 vite ssrLoadModule 装载；只换算逐字重复，零生产改动）',
      registrySource: 'packages/mcp-host/src/index.ts',
      specTotal: specAll.length,
      faceTotals: {
        toolCount: full.length,
        frameBytes: utf8Bytes({ jsonrpc: '2.0', id: 'evidence', result: { tools: full.map(wireTool) } }),
        toolsArrayBytes: sum('bytes'),
        descriptionBytes: sum('descriptionBytes'),
        inputSchemaBytes: sum('inputSchemaBytes'),
        schemaDescriptionStringBytes: schemaDescBytesAll,
        schemaDescriptionStringCount: schemaEntries.length,
      },
      minOccurrence: 3,
      descriptionSentences: sentences,
      schemaDescriptions: { ...schemaDescriptions, note: '整串相等口径：同一枚面里七个页大小别名各抄一份也计入 occurrences。' },
      exportedConstants,
      familyDup: Object.entries(familyDup)
        .map(([family, g]) => ({ family, ...g, pctOfDescriptions: Number(((g.sentenceDupBytes / Math.max(1, g.descriptionBytes)) * 100).toFixed(1)) }))
        .sort((a, b) => b.sentenceDupBytes - a.sentenceDupBytes),
      combined: {
        descriptionSideWasteBytes: sentences.wasteBytesIfKeepOneCopy,
        schemaSideWasteBytes: schemaDescriptions.wasteBytesIfKeepOneCopy,
        totalWasteBytesIfKeepOneCopy: sentences.wasteBytesIfKeepOneCopy + schemaDescriptions.wasteBytesIfKeepOneCopy,
        pctOfFullFrame: Number(
          (
            ((sentences.wasteBytesIfKeepOneCopy + schemaDescriptions.wasteBytesIfKeepOneCopy) /
              utf8Bytes({ jsonrpc: '2.0', id: 'evidence', result: { tools: full.map(wireTool) } })) *
            100
          ).toFixed(1),
        ),
      },
    };
  } finally {
    await dispose();
  }
}

/* ======================================================================
 * B 面：真端点面（真桌面壳）
 * ===================================================================== */

/** 通道自证：会话文件 mode 必须＝shell，且 repoRoot 必须＝本树。 */
function proveChannel() {
  let lib;
  try {
    lib = null; // 延迟：会话目录用 debug-cli 自己的口径取，避免重复实现
  } catch {
    /* 不影响 */
  }
  const st = runDebugCli(['status', '--json'], { timeoutMs: 60_000 });
  const statusJson = lastJson(st.stdout);
  // 会话文件路径直接从 debug-lib 的 sessionDir 取（与量具同款，别自己拼哈希）
  let sess = null;
  let sessFile = null;
  try {
    const req = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        // 注意（B26 实拍修）：这一格原本写的是 `const fs=require('node:fs')`——`--input-type=module`
        // 底下 **没有 `require`**，内联脚本一进来就 ReferenceError，stdout 空 ⇒ 外层把
        // `path.join('', 'session.json')` 当会话文件读，报 ENOENT，`shell`/`wire` 两面
        // 从此永远起不来（B22 那次「真壳未取」的第二条真因，第一条是共享 cargo target 争锁）。
        // 会话目录仍走 debug-lib 的 `sessionDir`（真源），不自己拼哈希。
        `const {sessionDir}=await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'tools', 'debug-lib.mjs')).href)});
         console.log(JSON.stringify({dir:sessionDir(${JSON.stringify(REPO)}),file:process.env.KOJO_DEBUG_SESSION??null}))`,
      ],
      { cwd: REPO, encoding: 'utf-8', timeout: 30_000 },
    );
    if (req.status !== 0) {
      throw new Error(`debug-lib 会话目录解析失败 rc=${req.status}：${String(req.stderr ?? '').slice(0, 200)}`);
    }
    const j = lastJson(req.stdout ?? '');
    if (!j?.dir) throw new Error('debug-lib 没回 sessionDir（读数不可信，拒出数）');
    const file = j.file ?? path.join(j.dir, 'session.json');
    sessFile = file;
    sess = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error(
      `[FAIL] 读不到本树的调试会话（${err?.message ?? err}）——本面只量**真桌面壳**。` +
        ' 复现：node tools/debug-cli.mjs shell --isolate',
    );
    process.exit(2);
  }
  if (sess.mode !== 'shell') {
    console.error(
      `[FAIL] 通道不对：会话 mode=${sess.mode ?? '读不到'}（要 shell）。调试宿（serve）的数不许借。` +
        ' 复现：node tools/debug-cli.mjs stop && node tools/debug-cli.mjs shell --isolate',
    );
    console.error(String(st.stdout).slice(0, 400));
    process.exit(2);
  }
  if (st.rc !== 0) {
    console.error(`[FAIL] debug-cli status rc=${st.rc}——真壳会话不在。复现同上一条。`);
    process.exit(2);
  }
  return {
    mode: sess.mode,
    sessionId: sess.sessionId ?? null,
    repoRoot: sess.repoRoot ?? null,
    createdAt: sess.createdAt ?? null,
    cdpPort: sess.cdpPort ?? null,
    vitePort: sess.vitePort ?? null,
    shellPid: sess.shellPid ?? null,
    sessionFile: sessFile,
    statusJson,
  };
}

/** 一帧 POST：每帧一条新连接（端点恒 `Connection: close`，不许偷连复用）。三闸按生产形态带上。
 *  `extraHeaders`（additive，B26）：只用于点名会话身份（`x-mcp-client-id`），默认不带 ⇒ 老调用点逐字不变。 */
function postFrame(endpoint, token, frame, extraHeaders = null) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify([frame]), 'utf-8');
    const t0 = performance.now();
    const req = http.request(
      {
        host: endpoint.host,
        port: endpoint.port,
        method: 'POST',
        path: endpoint.path,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          origin: `http://${endpoint.host}:${endpoint.port}`,
          'content-length': body.length,
          ...(extraHeaders ?? {}),
        },
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const wallMs = performance.now() - t0;
          const raw = Buffer.concat(chunks);
          const p0 = performance.now();
          let json = null;
          let parseError = null;
          try {
            json = JSON.parse(raw.toString('utf-8'));
          } catch (e) {
            parseError = e.message;
          }
          const parseMs = performance.now() - p0;
          resolve({ wallMs, parseMs, status: res.statusCode, bodyBytes: raw.length, raw, json, parseError });
        });
      },
    );
    req.on('error', (e) =>
      resolve({ wallMs: performance.now() - t0, parseMs: 0, status: 0, bodyBytes: 0, json: null, parseError: `连接失败：${e.code ?? e.message}` }),
    );
    req.end(body);
  });
}

/** `tools/list` 帧的成功判定：HTTP 200 + JSON-RPC result.tools 是非空数组 + 无 error。 */
function judgeList(resp) {
  if (resp.parseError) return { ok: false, why: `响应不可解析：${resp.parseError}` };
  if (resp.status !== 200) return { ok: false, why: `HTTP ${resp.status}` };
  const frame = Array.isArray(resp.json) ? resp.json[0] : resp.json;
  if (!frame || frame.error) return { ok: false, why: `JSON-RPC error：${frame?.error?.code ?? '?'} ${String(frame?.error?.message ?? '').slice(0, 120)}` };
  const tools = frame.result?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return { ok: false, why: 'result.tools 不是非空数组' };
  return {
    ok: true,
    toolCount: tools.length,
    elapsedMs: frame.result?._meta?.elapsedMs ?? null,
    frameBytes: utf8Bytes(frame),
    resultToolsBytes: utf8Bytes(tools),
    firstNames: tools.slice(0, 3).map((t) => t.name),
    keysOfOneTool: Object.keys(tools[0] ?? {}),
  };
}

/** 单条 `tools/call` 成功帧判定（与 B5 量具同口径，供对照那一格用）。 */
function judgeCall(resp) {
  if (resp.parseError) return { ok: false, why: `响应不可解析：${resp.parseError}` };
  if (resp.status !== 200) return { ok: false, why: `HTTP ${resp.status}` };
  const frame = Array.isArray(resp.json) ? resp.json[0] : resp.json;
  if (!frame || frame.error) return { ok: false, why: `JSON-RPC error：${frame?.error?.code ?? '?'}` };
  const result = frame.result ?? {};
  if (result.isError) return { ok: false, why: 'result.isError=true' };
  const textContent = result.content?.[0]?.text;
  if (typeof textContent !== 'string') return { ok: false, why: 'content[0].text 缺失' };
  let payload = null;
  try {
    payload = JSON.parse(textContent);
  } catch {
    return { ok: false, why: '内层载荷不是 JSON' };
  }
  if (payload?.error) return { ok: false, why: `腿侧 error：${payload.error.code ?? payload.error.message ?? '?'}` };
  if (typeof payload.text !== 'string' || payload.text.length === 0 || !(payload.textLength > 0)) {
    return { ok: false, why: `读到空正文（textLength=${payload.textLength ?? '?'}）` };
  }
  return { ok: true, elapsedMs: result._meta?.elapsedMs ?? null, chars: payload.text.length };
}

function makeThrottle(limitPerMinute) {
  const stamps = [];
  const prune = () => {
    const now = Date.now();
    while (stamps.length && now - stamps[0] >= 60_000) stamps.shift();
  };
  const take = async (count = 1) => {
    for (let i = 0; i < count; i += 1) {
      prune();
      if (stamps.length >= limitPerMinute) {
        await sleep(Math.max(5, 60_000 - (Date.now() - stamps[0]) + 5));
        prune();
      }
      stamps.push(Date.now());
    }
  };
  /** 场景之间把速率窗彻底放空（端点是固定 60s 整窗清零，滚动窗对不齐会撞 429）。 */
  const reset = async () => {
    if (stamps.length === 0) return;
    const waitMs = 61_000 - (Date.now() - stamps[0]);
    if (waitMs > 0) await sleep(waitMs);
    stamps.length = 0;
  };
  return { take, reset };
}

/** 起端点：先 stop 再起 ⇒ 台账窗口里只有本量具自己这一轮的帧。token 只进内存，不打印。 */
function startEndpoint() {
  runDebugCli(['invoke', 'mcp_stop', '{}']);
  const r = runDebugCli(['invoke', 'mcp_start', '{"enabled":true}']);
  const j = lastJson(r.stdout);
  if (r.rc !== 0 || !j?.port || !j?.token) {
    console.error(`[FAIL] mcp_start 没起来（rc=${r.rc}）：${String(r.stdout).slice(0, 400)}`);
    process.exit(3);
  }
  return { endpoint: { host: '127.0.0.1', port: j.port, path: '/mcp' }, token: j.token, discovery: { port: j.port, wroteToken: Boolean(j.token) } };
}

function readLedger() {
  const r = runDebugCli(['invoke', 'mcp_latency_query', '{}']);
  const j = lastJson(r.stdout);
  if (r.rc !== 0 || !j) {
    return { unavailable: true, rc: r.rc, note: `台账读数不可用：${String(r.stdout).slice(0, 200)}`, limits: null, perKey: [] };
  }
  const keys = Array.isArray(j?.latency?.keys) ? j.latency.keys : [];
  return {
    unavailable: false,
    limits: j.limits ?? null,
    budget: j.budget ?? null,
    pendingNow: j.pendingNow ?? null,
    clientsNow: j.clientsNow ?? null,
    window: j.latency?.window ?? null,
    maxKeys: j.latency?.maxKeys ?? null,
    overflowKeys: j.latency?.overflowKeys ?? null,
    perKey: keys.map((k) => ({
      key: k.key,
      seen: k.seen,
      samples: k.samples,
      dropped: k.dropped,
      p50Ms: k.p50Ms,
      p95Ms: k.p95Ms,
      p99Ms: k.p99Ms,
      maxMs: k.maxMs,
      avgMs: k.avgMs,
    })),
  };
}

/** 经 stdio shim 发一帧（真实 MCP 客户端形态：多一层 stdin/stdout 行协议）。 */
function shimRoundTrip(port, token, frame, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO, 'tools', 'kojo-mcp.mjs')], {
      cwd: REPO,
      windowsHide: true,
      env: { ...process.env, KOJO_MCP_ENDPOINT: `http://127.0.0.1:${port}/mcp`, KOJO_MCP_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stderrTail = [];
    child.stderr.on('data', (d) => {
      if (stderrTail.length < 8) stderrTail.push(String(d).trim().slice(0, 200));
    });
    let buf = '';
    let done = false;
    const t0 = performance.now();
    const finish = (rec) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      resolve({ ...rec, stderrTail });
    };
    const timer = setTimeout(() => finish({ ok: false, why: `shim ${timeoutMs / 1000}s 没回帧` }), timeoutMs);
    child.stdout.on('data', (d) => {
      buf += d.toString('utf-8');
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      const line = buf.slice(0, idx);
      const ms = performance.now() - t0;
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        return finish({ ok: false, why: 'shim 回帧不是 JSON' });
      }
      const v = judgeList({ parseError: null, status: 200, json: parsed });
      finish({ ...v, ms, lineBytes: Buffer.byteLength(line, 'utf-8') });
    });
    child.on('error', (e) => finish({ ok: false, why: `shim 进程起不来：${e.message}` }));
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  });
}

async function faceShell(args, { withCall = false }) {
  const channel = proveChannel();
  console.log(
    `[channel] mode=${channel.mode} · session=${channel.sessionId} · repoRoot=${channel.repoRoot} · createdAt=${channel.createdAt} · vite=:${channel.vitePort} · cdp=:${channel.cdpPort}`,
  );
  const { endpoint, token, discovery } = startEndpoint();
  console.log(`[endpoint] 127.0.0.1:${endpoint.port}${endpoint.path}（token 已取，不外印）`);

  /* 语料与项目：读腿要出成功帧才谈得上对照（只从环境变量 / 命令行来，仓里零字）。 */
  let corpusDir = args.corpusDir;
  if (!corpusDir) {
    try {
      const mod = await import(pathToFileURL(path.join(REPO, 'tools', 'corpus.mjs')).href);
      corpusDir = mod.resolveCorpusDir({});
    } catch (err) {
      console.error(`[warn] 语料解析失败（${err?.message ?? err}）——tools/call 对照格将如实记「未取到」。`);
    }
  }
  const report = {
    channel,
    endpoint: { host: endpoint.host, port: endpoint.port, path: endpoint.path },
    endpointDiscovery: discovery,
    quotaRespectedPerMinute: args.quotaPerMinute,
    corpusResolved: Boolean(corpusDir && fs.existsSync(corpusDir)),
    startedAt: new Date().toISOString(),
    scenarios: {},
    ledgerAfterWarmup: null,
    ledgerFinal: null,
  };

  const { take, reset } = makeThrottle(args.quotaPerMinute);
  const listFrame = (i) => ({ jsonrpc: '2.0', id: `l${i}`, method: 'tools/list', params: {} });

  /* 1) 预热 3 帧（不计入读数）：首帧要付懒装载 + 注册表 memoize 的税 */
  const warm = { ok: 0, fail: 0, ms: [], failures: {} };
  for (let i = 0; i < 3; i += 1) {
    await take(1);
    const r = await postFrame(endpoint, token, listFrame(-1 - i));
    const v = judgeList(r);
    if (v.ok) {
      warm.ok += 1;
      warm.ms.push(Number(r.wallMs.toFixed(2)));
    } else warm.failures[v.why] = (warm.failures[v.why] ?? 0) + 1, (warm.fail += 1);
  }
  report.warmup = { discarded: 3, ok: warm.ok, fail: warm.fail, firstMs: warm.ms[0] ?? null };
  console.log(`[warmup] tools/list 弃样 3：ok=${warm.ok} fail=${warm.fail} 首帧=${warm.ms[0] ?? 'n/a'}ms`);
  report.ledgerAfterWarmup = readLedger();

  /* 2) 正式 n 帧：逐条留原始样本 */
  const b = { ok: 0, fail: 0, ms: [], parseMs: [], serverMs: [], bodyBytes: [], toolCounts: [], failures: {} };
  const samples = [];
  for (let i = 0; i < args.n; i += 1) {
    await take(1);
    const r = await postFrame(endpoint, token, listFrame(i));
    const v = judgeList(r);
    if (v.ok) {
      b.ok += 1;
      b.ms.push(Number(r.wallMs.toFixed(2)));
      b.parseMs.push(Number(r.parseMs.toFixed(3)));
      b.bodyBytes.push(r.bodyBytes);
      b.toolCounts.push(v.toolCount);
      if (typeof v.elapsedMs === 'number') b.serverMs.push(v.elapsedMs);
      samples.push({ i, wallMs: Number(r.wallMs.toFixed(2)), parseMs: Number(r.parseMs.toFixed(3)), bodyBytes: r.bodyBytes, toolCount: v.toolCount, serverElapsedMs: v.elapsedMs, wireKeys: v.keysOfOneTool });
    } else {
      b.fail += 1;
      b.failures[v.why] = (b.failures[v.why] ?? 0) + 1;
    }
  }
  const uniq = (a) => [...new Set(a)];
  report.scenarios.toolsList = {
    kind: `一帧 tools/list 打真壳端点（裸 HTTP，n=${args.n}，逐条原始样本在 samples）`,
    ok: b.ok,
    fail: b.fail,
    failures: b.failures,
    roundTrip: stats(b.ms),
    frameParse: stats(b.parseMs),
    serverSideElapsed: stats(b.serverMs),
    responseBodyBytes: {
      p50: stats(b.bodyBytes).p50,
      p95: stats(b.bodyBytes).max === stats(b.bodyBytes).min ? stats(b.bodyBytes).p50 : stats(b.bodyBytes).p95,
      min: stats(b.bodyBytes).min,
      max: stats(b.bodyBytes).max,
      allEqual: uniq(b.bodyBytes).length === 1,
      distinctValues: uniq(b.bodyBytes),
    },
    visibleToolCount: { observed: uniq(b.toolCounts), p50: stats(b.toolCounts).p50 },
    wireKeysOfOneTool: samples[0]?.wireKeys ?? null,
    samples,
  };
  console.log(
    `[tools/list] ok=${b.ok} fail=${b.fail} 往返 p50=${report.scenarios.toolsList.roundTrip.p50}ms p95=${report.scenarios.toolsList.roundTrip.p95}ms ` +
      `响应体=${stats(b.bodyBytes).p50}B 可见工具数=${uniq(b.toolCounts).join('/')} 帧解析 p50=${report.scenarios.toolsList.frameParse.p50}ms`,
  );

  /* 3) 经 stdio shim 那一层（真实 MCP 客户端形态），至少 6 帧 */
  const shimN = Math.max(6, Math.min(12, args.n));
  const sb = { ok: 0, fail: 0, ms: [], lineBytes: [], failures: [] };
  for (let i = 0; i < shimN; i += 1) {
    await take(1);
    const r = await shimRoundTrip(endpoint.port, token, listFrame(1000 + i));
    if (r.ok) {
      sb.ok += 1;
      sb.ms.push(Number(r.ms.toFixed(2)));
      sb.lineBytes.push(r.lineBytes);
    } else {
      sb.fail += 1;
      sb.failures.push({ why: r.why, stderrTail: r.stderrTail });
    }
  }
  report.scenarios.toolsListViaShim = {
    kind: `同一帧经 tools/kojo-mcp.mjs（stdio shim）转发：真实 MCP 客户端形态（n=${shimN}）`,
    ok: sb.ok,
    fail: sb.fail,
    failures: sb.failures,
    roundTrip: stats(sb.ms),
    stdoutLineBytes: { p50: stats(sb.lineBytes).p50, min: stats(sb.lineBytes).min, max: stats(sb.lineBytes).max, allEqual: uniq(sb.lineBytes).length === 1 },
    extraBytesVsHttp: stats(sb.lineBytes).p50 - (stats(b.bodyBytes).p50 ?? 0),
    extraMsVsHttp: Number((stats(sb.ms).p50 - (stats(b.ms).p50 ?? 0)).toFixed(2)),
    note: 'extraMs 含 shim 子进程冷启动（每次 spawn 一个 node），不是「同一进程的每帧税」；每帧税要用同一 shim 进程连续多帧，见 scenarios.toolsListViaShimSameProcess。',
  };
  console.log(`[shim] ok=${sb.ok} fail=${sb.fail} p50=${report.scenarios.toolsListViaShim.roundTrip.p50}ms 行字节=${report.scenarios.toolsListViaShim.stdoutLineBytes.p50}B`);

  /* 3.5) 同一个 shim 进程连续多帧 ⇒ 拆掉 spawn 税，量每帧的行协议开销 */
  {
    const child = spawn(process.execPath, [path.join(REPO, 'tools', 'kojo-mcp.mjs')], {
      cwd: REPO,
      windowsHide: true,
      env: { ...process.env, KOJO_MCP_ENDPOINT: `http://127.0.0.1:${endpoint.port}${endpoint.path}`, KOJO_MCP_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const perFrame = [];
    let waiting = null;
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf-8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim() || !waiting) continue;
        const w = waiting;
        waiting = null;
        clearTimeout(w.timer);
        w.resolve({ ms: performance.now() - w.t0, bytes: Buffer.byteLength(line, 'utf-8'), line });
      }
    });
    for (let i = 0; i < 10; i += 1) {
      await take(1);
      const got = await new Promise((resolve) => {
        const t0 = performance.now();
        const timer = setTimeout(() => {
          waiting = null;
          resolve({ ms: performance.now() - t0, bytes: 0, line: null });
        }, 30_000);
        waiting = { t0, timer, resolve };
        child.stdin.write(`${JSON.stringify(listFrame(2000 + i))}\n`);
      });
      perFrame.push(got);
    }
    child.stdin.end();
    child.kill();
    const okFrames = perFrame.filter((f) => f.line);
    report.scenarios.toolsListViaShimSameProcess = {
      kind: '同一个 shim 进程连发 10 帧（拆掉每帧 spawn 税，只看行协议 + 转发）',
      frames: okFrames.length,
      roundTrip: stats(okFrames.map((f) => Number(f.ms.toFixed(2)))),
      lineBytes: { p50: stats(okFrames.map((f) => f.bytes)).p50, allEqual: uniq(okFrames.map((f) => f.bytes)).length === 1 },
      extraMsVsHttp: Number((stats(okFrames.map((f) => f.ms)).p50 - (stats(b.ms).p50 ?? 0)).toFixed(2)),
    };
    console.log(
      `[shimSameProcess] frames=${okFrames.length} p50=${report.scenarios.toolsListViaShimSameProcess.roundTrip.p50}ms 每帧税=${report.scenarios.toolsListViaShimSameProcess.extraMsVsHttp}ms`,
    );
  }

  /* 4) 台账终读：http#tools/list 与 tools/list 两行 */
  report.ledgerFinal = readLedger();

  /* 5) 对照格：同壳单条 tools/call（读面成功帧）；语料没就位就如实记 unavailable */
  if (!withCall) return report;
  if (!corpusDir || !fs.existsSync(corpusDir)) {
    report.scenarios.toolsCallCompare = { unavailable: true, note: '语料目录没解析到 ⇒ 对照格未取到；复现：KOJO_CORPUS_SCAN_DIRS=<扫描根> node tools/corpus.mjs --print' };
    return report;
  }
  const open = runDebugCli(['open-project', corpusDir], { timeoutMs: 600_000 });
  if (open.rc !== 0) {
    report.scenarios.toolsCallCompare = { unavailable: true, note: `open-project rc=${open.rc} ⇒ 对照格未取到：${String(open.stdout).slice(0, 240)}` };
    return report;
  }
  console.log('[project] open-project rc=0');
  const csvDir = path.join(corpusDir, 'CSV');
  let files = [];
  if (fs.existsSync(csvDir)) {
    files = fs
      .readdirSync(csvDir)
      .filter((f) => /\.csv$/i.test(f))
      .map((f) => ({ f, size: fs.statSync(path.join(csvDir, f)).size }))
      .filter((x) => x.size > 200 && x.size < 40_000)
      .sort((a, b2) => a.f.localeCompare(b2.f, 'en'))
      .slice(0, 20)
      .map((x) => `CSV/${x.f}`);
  }
  if (files.length === 0) {
    report.scenarios.toolsCallCompare = { unavailable: true, note: '语料里没取到 200B–40KB 的取样文件 ⇒ 对照格未取到' };
    return report;
  }
  const callFrame = (i) => ({ jsonrpc: '2.0', id: `c${i}`, method: 'tools/call', params: { name: 'fs.readFile', arguments: { relPath: files[i % files.length] } } });
  await reset();
  for (let i = 0; i < 3; i += 1) {
    await take(1);
    await postFrame(endpoint, token, callFrame(i));
  }
  const cb = { ok: 0, fail: 0, ms: [], parseMs: [], bodyBytes: [], serverMs: [], failures: {} };
  const cSamples = [];
  for (let i = 0; i < args.callN; i += 1) {
    await take(1);
    const r = await postFrame(endpoint, token, callFrame(i));
    const v = judgeCall(r);
    if (v.ok) {
      cb.ok += 1;
      cb.ms.push(Number(r.wallMs.toFixed(2)));
      cb.parseMs.push(Number(r.parseMs.toFixed(3)));
      cb.bodyBytes.push(r.bodyBytes);
      if (typeof v.elapsedMs === 'number') cb.serverMs.push(v.elapsedMs);
      cSamples.push({ i, wallMs: Number(r.wallMs.toFixed(2)), bodyBytes: r.bodyBytes, serverElapsedMs: v.elapsedMs, chars: v.chars });
    } else {
      cb.fail += 1;
      cb.failures[v.why] = (cb.failures[v.why] ?? 0) + 1;
    }
  }
  report.scenarios.toolsCallCompare = {
    kind: `同壳单条 tools/call（fs.readFile 成功帧，n=${args.callN}）：与 tools/list 同机同壳同闸`,
    ok: cb.ok,
    fail: cb.fail,
    failures: cb.failures,
    roundTrip: stats(cb.ms),
    frameParse: stats(cb.parseMs),
    serverSideElapsed: stats(cb.serverMs),
    responseBodyBytes: { p50: stats(cb.bodyBytes).p50, min: stats(cb.bodyBytes).min, max: stats(cb.bodyBytes).max },
    samples: cSamples,
  };
  report.comparison = {
    listVsCallRoundTripP50Ms: [report.scenarios.toolsList.roundTrip.p50, stats(cb.ms).p50],
    listOverCallP50Ratio: Number((report.scenarios.toolsList.roundTrip.p50 / stats(cb.ms).p50).toFixed(2)),
    listOverCallBodyRatio: Number((stats(b.bodyBytes).p50 / stats(cb.bodyBytes).p50).toFixed(2)),
    b5RecordedCallP50Ms: 11.5,
    note: 'b5RecordedCallP50Ms 是 B5 回执的数（另一棵树、另一次运行），只作外部对照，不当本量具的读数。',
  };
  report.ledgerFinal = readLedger();
  console.log(
    `[compare] tools/list p50=${report.scenarios.toolsList.roundTrip.p50}ms vs tools/call p50=${stats(cb.ms).p50}ms（倍率 ${report.comparison.listOverCallP50Ratio}×）`,
  );
  return report;
}

/* ======================================================================
 * C 面：线协议逐字段账（B26 真壳一帧实测）
 *   同一台真壳里抓两帧 `tools/list` 全帧（缺省只读会话 / 全量批准会话），
 *   与 `static` 面逐格对账；顺带把 Rust 的 2048 字符闸做成**壳内实拍**。
 *   口径：一帧都不裁、不估算——所有字节都从**真实 HTTP 响应体**里量。
 * ===================================================================== */

/** 递归收集一棵 JSON 树里所有 `description` 字符串（线协议侧，与 A 面同款遍历）。 */
function wireDescriptions(node, acc = []) {
  if (Array.isArray(node)) {
    for (const item of node) wireDescriptions(item, acc);
    return acc;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'description' && typeof v === 'string') acc.push(v);
      else wireDescriptions(v, acc);
    }
  }
  return acc;
}

/** 逐枚工具的线协议字节账（与 A 面 `toolByteBreakdown` 同字段，但数据源＝**壳里回来的那一帧**）。 */
function wireToolBytes(tool) {
  return {
    name: tool.name,
    tier: tool.tier,
    bytes: utf8Bytes(tool),
    descriptionBytes: tool.description === undefined ? 0 : utf8Bytes(tool.description),
    inputSchemaBytes: tool.inputSchema === undefined ? 0 : utf8Bytes(tool.inputSchema),
    wireKeys: Object.keys(tool).sort(),
    descriptionChars: (tool.description ?? '').length,
    truncated: typeof tool.description === 'string' && tool.description.includes(TRUNCATION_MARK),
  };
}

const TRUNCATION_MARK = '…[truncated]';

/** 一个会话一帧的完整账目。`staticTools`＝同档位的静态面（线协议形状，用于逐格对账）。 */
function accountWireFace({ label, clientId, rawBodyBytes, parsedFrame, staticFrameBytes, staticTools }) {
  const tools = parsedFrame.result?.tools ?? [];
  const wire = tools.map(wireToolBytes);
  const parsedFrameBytes = utf8Bytes(parsedFrame);
  const toolsArrayBytes = utf8Bytes(tools);
  const frameNoMeta = JSON.parse(JSON.stringify(parsedFrame));
  delete frameNoMeta.result?._meta;
  const noMetaBytes = utf8Bytes(frameNoMeta);
  const staticByName = new Map(staticTools.map((t) => [t.name, t]));
  const diffs = [];
  for (const w of wire) {
    const s = staticByName.get(w.name);
    if (!s) {
      diffs.push({ name: w.name, why: '壳里出现但静态面没有' });
      continue;
    }
    const sBytes = utf8Bytes(s);
    const sDescChars = (s.description ?? '').length;
    if (sBytes !== w.bytes || sDescChars !== w.descriptionChars || Object.keys(s).sort().join(',') !== w.wireKeys.join(',')) {
      diffs.push({
        name: w.name,
        staticBytes: sBytes,
        wireBytes: w.bytes,
        deltaBytes: w.bytes - sBytes,
        staticDescriptionChars: sDescChars,
        wireDescriptionChars: w.descriptionChars,
        deltaDescriptionBytes: w.descriptionBytes - utf8Bytes(s.description ?? ''),
        deltaInputSchemaBytes: w.inputSchemaBytes - utf8Bytes(s.inputSchema ?? {}),
        truncatedInWire: w.truncated,
        wireKeys: w.wireKeys.join(','),
        staticKeys: Object.keys(s).sort().join(','),
      });
    }
  }
  const descChars = wire.map((w) => ({ name: w.name, chars: w.descriptionChars, bytes: w.descriptionBytes }));
  const allDescriptions = wireDescriptions(tools);
  const schemaSideDescriptions = tools.flatMap((t) => wireDescriptions(t.inputSchema ?? null));
  return {
    label,
    clientId,
    toolCount: tools.length,
    rawHttpBodyBytes: rawBodyBytes,
    reparsedFrameBytes: parsedFrameBytes,
    serializationDriftBytes: rawBodyBytes - parsedFrameBytes,
    toolsArrayBytes,
    envelopeBytes: parsedFrameBytes - toolsArrayBytes,
    metaBytes: parsedFrameBytes - noMetaBytes,
    metaKeys: Object.keys(parsedFrame.result?._meta ?? {}),
    staticFrameBytes,
    deltaWireVsStaticBytes: parsedFrameBytes - staticFrameBytes,
    perToolDiffCount: diffs.length,
    perToolDiffs: diffs.slice(0, 20),
    perToolDiffBytesSum: diffs.reduce((a, d) => a + (d.deltaBytes ?? 0), 0),
    toolsMissingFromWire: staticTools.filter((s) => !wire.some((w) => w.name === s.name)).map((s) => s.name),
    descriptionGate: {
      maxDescriptionChars: descChars.length ? Math.max(...descChars.map((d) => d.chars)) : null,
      topDescriptions: descChars.sort((a, b) => b.chars - a.chars).slice(0, 5),
      marginToCapChars: descChars.length ? 2048 - Math.max(...descChars.map((d) => d.chars)) : null,
      toolsAtOrOverCap: descChars.filter((d) => d.chars >= 2048).length,
      truncatedDescriptors: wire.filter((w) => w.truncated).map((w) => w.name),
      descriptionStringCountInFrame: allDescriptions.length,
      schemaSideDescriptionCount: schemaSideDescriptions.length,
      schemaSideMaxChars: schemaSideDescriptions.length ? Math.max(...schemaSideDescriptions.map((d) => d.length)) : null,
      schemaSideTruncatedCount: schemaSideDescriptions.filter((d) => d.includes(TRUNCATION_MARK)).length,
      note: 'descriptionStringCountInFrame＝整帧里所有名为 description 的字符串（顶层 + inputSchema 各层，同款递归遍历）；schemaSide* 只走 inputSchema 子树。',
    },
    wireKeysOfOneTool: wire[0]?.wireKeys ?? null,
    tierCounts: tools.reduce((a, t) => ({ ...a, [t.tier]: (a[t.tier] ?? 0) + 1 }), {}),
  };
}

async function faceWire(args) {
  const outFileForDumps = args.out ?? path.join(os.tmpdir(), `kojo-tools-list-wire-${Date.now()}.json`);
  const channel = proveChannel();
  console.log(
    `[channel] mode=${channel.mode} · session=${channel.sessionId} · repoRoot=${channel.repoRoot} · cdp=:${channel.cdpPort}`,
  );
  const { endpoint, token } = startEndpoint();
  console.log(`[endpoint] 127.0.0.1:${endpoint.port}${endpoint.path}（token 已取，不外印）`);

  // 静态面对账基准：同一棵树现场装载注册表真源（不是抄来的旧数）。
  const { mod, dispose } = await loadRegistry();
  let staticFull;
  let staticRead;
  let allNames;
  let privilegedNames;
  try {
    const reg = mod.createMcpCapabilityRegistry({});
    const specAll = [
      ...mod.SEMANTIC_TOOL_SPECS,
      ...mod.KERNEL_IO_TOOL_SPECS,
      ...mod.SUPPLEMENTAL_TOOL_SPECS,
    ];
    allNames = specAll.map((s) => s.name);
    privilegedNames = specAll.filter((s) => s.tier === 'privileged').map((s) => s.name);
    const pack = (tools) => ({
      frameBytes: utf8Bytes({ jsonrpc: '2.0', id: 'wire-1', result: { tools: tools.map(wireTool) } }),
      tools: tools.map(wireTool),
    });
    staticFull = pack(reg.listTools(scopeOf('privileged', allNames)));
    staticRead = pack(reg.listTools(scopeOf('read')));
  } finally {
    await dispose();
  }

  const report = {
    channel,
    endpoint: { host: endpoint.host, port: endpoint.port, path: endpoint.path },
    registrySpecTotal: allNames.length,
    staticFrameBytes: { full: staticFull.frameBytes, read: staticRead.frameBytes },
    startedAt: new Date().toISOString(),
    sessions: {},
    approval: null,
  };

  const grabFrame = async (clientId, frameId, dumpTag = null) => {
    const frame = { jsonrpc: '2.0', id: frameId, method: 'tools/list', params: {} };
    const headers = clientId ? { 'x-mcp-client-id': clientId } : null;
    const r = await postFrame(endpoint, token, frame, headers);
    const v = judgeList(r);
    if (!v.ok) throw new Error(`${clientId ?? '(无 clientId)'} 的 tools/list 帧不成形：${v.why}`);
    // 物证留档（B26）：把**原始响应体**逐字落到报告旁边（同一临时目录），
    // 字节账才可离线复算；`--out` 指到哪就落哪，仓库里零产物。
    if (dumpTag) {
      try {
        fs.writeFileSync(
          `${outFileForDumps}.${dumpTag}.raw-frame.json`,
          Buffer.isBuffer(r.raw) ? r.raw : JSON.stringify(r.json),
        );
      } catch {
        /* 留档失败不影响读数 */
      }
    }
    return r;
  };

  // 1) 缺省只读会话（未批准 ⇒ Rust 侧 tier=read、approvedTools 空）——预热 1 帧弃样，第 2 帧才留档。
  {
    const defaultId = 'laneal-default-1107';
    await grabFrame(defaultId, 'wire-warm');
    const r = await grabFrame(defaultId, 'wire-1', 'default');
    report.sessions.defaultReadSession = accountWireFace({
      label: '缺省只读会话（未批准，clientId 只在头里点名）',
      clientId: defaultId,
      rawBodyBytes: r.bodyBytes,
      parsedFrame: r.json,
      staticFrameBytes: staticRead.frameBytes,
      staticTools: staticRead.tools,
    });
    const f = report.sessions.defaultReadSession;
    console.log(
      `[wire/default] 枚数=${f.toolCount} 响应体=${f.rawHttpBodyBytes}B 重解析=${f.reparsedFrameBytes}B ` +
        `静态=${f.staticFrameBytes}B 差=${f.deltaWireVsStaticBytes}B 信封=${f.envelopeBytes}B _meta=${f.metaBytes}B ` +
        `最长描述=${f.descriptionGate.maxDescriptionChars}字符 截断标记=${f.descriptionGate.truncatedDescriptors.length}枚`,
    );
  }

  // 2) 全量批准会话：mcp_approve 只写第四张表（隔离 appDataDir），不碰内核写域、不碰任何闸值。
  if (!args.noApprove) {
    const approvedId = 'laneal-approved-1107';
    const patterns = allNames.filter((n) => !n.startsWith('market'));
    const ap = runDebugCli(
      // Rust 命令签名是 `mcp_approve(args: ApproveArgs)`——非结构体入参走顶层，
      // 因此整包必须再套一层 `{args:…}`（B26 实拍：裸传 ⇒ `invalid args … missing required key args`）。
      ['invoke', 'mcp_approve', JSON.stringify({ args: { clientId: approvedId, tier: 'privileged', approvedRoots: [], approvedTools: patterns, approvedRootIds: [] } })],
      { timeoutMs: 120_000 },
    );
    const apJson = lastJson(ap.stdout);
    report.approval = {
      rc: ap.rc,
      clientId: approvedId,
      patternsSent: patterns.length,
      grantCountInTable: Array.isArray(apJson?.sessions) ? apJson.sessions.length : null,
      note: '第四张表（mcp_approvals.json，随 --isolate 的 appDataDir 落临时目录）；与内核 writablePaths / exportFile 互不继承。',
    };
    if (ap.rc !== 0) {
      report.sessions.fullApprovedSession = {
        unavailable: true,
        why: `mcp_approve rc=${ap.rc}：${String(ap.stdout).slice(0, 240)}`,
      };
      console.error(`[FAIL] mcp_approve rc=${ap.rc} ⇒ 全量批准帧未取到`);
    } else {
      await grabFrame(approvedId, 'wire-warm-a');
      const r = await grabFrame(approvedId, 'wire-1', 'approved');
      const acc = accountWireFace({
        label: '全量批准会话（tier=privileged + 逐名批准全部工具）',
        clientId: approvedId,
        rawBodyBytes: r.bodyBytes,
        parsedFrame: r.json,
        staticFrameBytes: staticFull.frameBytes,
        staticTools: staticFull.tools,
      });
      // 逐名批准形状：market_* 不在表内（fail-closed），故静态全量面与壳内全量面的差额里要交代这一格。
      acc.marketNamesExcludedFromApproval = allNames.filter((n) => n.startsWith('market'));
      acc.privilegedNameCount = privilegedNames.length;
      report.sessions.fullApprovedSession = acc;
      const f = acc;
      console.log(
        `[wire/approved] 枚数=${f.toolCount} 响应体=${f.rawHttpBodyBytes}B 重解析=${f.reparsedFrameBytes}B ` +
          `静态=${f.staticFrameBytes}B 差=${f.deltaWireVsStaticBytes}B 信封=${f.envelopeBytes}B _meta=${f.metaBytes}B ` +
          `逐枚差=${f.perToolDiffCount}枚（合计 ${f.perToolDiffBytesSum}B） 截断标记=${f.descriptionGate.truncatedDescriptors.length}枚`,
      );
    }
  } else {
    report.sessions.fullApprovedSession = { unavailable: true, why: '--no-approve 显式跳过' };
  }

  // 3) 台账里 tools/list 那一格（壳内自报，与客户端墙钟互不冒充）。
  report.ledger = readLedger();
  report.finishedAt = new Date().toISOString();
  return report;
}

/* ------------------------------ 出数 ------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outFile = args.out ?? path.join(os.tmpdir(), `kojo-tools-list-payload-${args.cmd}-${Date.now()}.json`);
  let report;
  if (args.cmd === 'static') {
    report = { mode: args.cmd, repo: REPO, generatedAt: new Date().toISOString(), static: await faceStatic(args) };
  } else if (args.cmd === 'dedup') {
    report = { mode: args.cmd, repo: REPO, generatedAt: new Date().toISOString(), dedup: await faceDedup(args) };
  } else if (args.cmd === 'wire') {
    report = { mode: args.cmd, repo: REPO, generatedAt: new Date().toISOString(), wire: await faceWire(args) };
  } else {
    report = { mode: args.cmd, repo: REPO, generatedAt: new Date().toISOString(), shell: await faceShell(args, { withCall: args.cmd === 'compare' }) };
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`[ok] 读数落盘：${outFile}`);
  if (report.dedup) {
    const d = report.dedup;
    console.log(
      `[dedup] 全量帧 ${d.faceTotals.frameBytes} B｜描述 ${d.faceTotals.descriptionBytes} B｜inputSchema ${d.faceTotals.inputSchemaBytes} B` +
        `｜描述侧抄写 ${d.descriptionSentences.wasteBytesIfKeepOneCopy} B（${d.descriptionSentences.groups} 组）` +
        `｜schema 侧抄写 ${d.schemaDescriptions.wasteBytesIfKeepOneCopy} B（${d.schemaDescriptions.groups} 组）` +
        `｜合计可省 ${d.combined.totalWasteBytesIfKeepOneCopy} B＝${d.combined.pctOfFullFrame}%`,
    );
    for (const e of d.exportedConstants.slice(0, args.top)) {
      console.log(`  - ${e.name}: ${e.chars} 字符 × ${e.occurrences} 处（${e.faces} 枚面）＝${e.totalBytes} B，重复部分 ${e.dupBytes} B`);
    }
  }
  const failed = report.shell?.scenarios?.toolsList?.fail ?? 0;
  process.exit(failed > 0 ? 4 : 0);
}

main().catch((err) => {
  console.error(`[FAIL] ${err?.stack ?? err}`);
  process.exit(2);
});
