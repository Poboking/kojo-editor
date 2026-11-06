/**
 * tools/mcp-shell-latency-evidence.mjs —— **真桌面壳** MCP 端到端延迟取证脚本（取证车道专用，非产品功能）。
 *
 * 它只做一件事：对着一台**正在跑的真桌面壳**（`node tools/debug-cli.mjs shell`，
 * `status` 的 `mode` 必须是 `shell`）发裸 HTTP，把「成功数据帧」的墙钟延迟量出来，
 * 按 单发 / 20 条串行 / batch 20 / 并发 8×12 四种形态出数并落一份原始 JSON。
 *
 * 为什么需要它：B5（`d1a43790`）交付时如实留了两格空——真壳「成功数据帧」读数（当时语料不在盘，
 * read 面按 `NOT_WIRED` 报错）与真壳「改前」对照（需另一次冷构建）。本脚本把两格变成可复现读数。
 *
 * 通道口径（PITFALLS 236）：本脚本**只认 `mode=shell`**。调试宿（`serve`）跑不出这些数，
 * 拿到了也不算数——脚本开局就验 `mode`，不是 `shell` 直接红着退出，不静默降级。
 *
 * 红线（脚本自身保证）：
 * - **不放宽任何闸**：`Limits::*`（120/分、8 并发、1 MiB 双体积、30 s）一字不动；
 *   客户端自己按 ≤`--quota-per-minute`（默认 110）节流，绝不靠放宽服务端闸换读数。
 * - **真盘根零进仓**：语料目录只从环境变量（`KOJO_CORPUS_DIR` / `KOJO_CORPUS_SCAN_DIRS`）
 *   或 `--corpus-dir` 命令行参数来，脚本与输出里不落任何绝对语料路径的默认值。
 * - **token 不出现在任何输出**（stdout / JSON / 错误消息都只描述失败类型）。
 * - **成功帧必须自证**：逐条核对 `result.content[0].text` 解出来的确实是读到的正文
 *   （`text` 非空 + `textLength>0` + 无 `error` / `isError`），失败帧**单独计数**，
 *   绝不混进分位数里平均。
 * - 默认输出落在 `os.tmpdir()`，仓库里不留产物。
 *
 * 用法：
 *   node tools/mcp-shell-latency-evidence.mjs                     # 本树的真壳，全场景
 *   node tools/mcp-shell-latency-evidence.mjs --repo <另一棵树>    # 对另一棵树（如改前游离 worktree）的真壳出数
 *   node tools/mcp-shell-latency-evidence.mjs --only single,batch20 --single-n 40 --rounds 3
 * 退出码：0 全绿；2 参数/通道不对（没起真壳 / mode 不是 shell）；3 端点起不来；4 有失败帧（读数仍出）。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(SCRIPT_DIR, '..');

/* ------------------------------ 小工具 ------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = {
    repo: DEFAULT_REPO,
    only: 'single,shim,serial20,batch20,concurrent',
    singleN: 40,
    rounds: 3,
    warmup: 6,
    quotaPerMinute: 110,
    corpusDir: null,
    out: null,
    label: 'after',
    allowRearm: true,
    armWaitMs: 90_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--repo') out.repo = path.resolve(next());
    else if (a === '--only') out.only = next();
    else if (a === '--single-n') out.singleN = Number(next());
    else if (a === '--rounds') out.rounds = Number(next());
    else if (a === '--warmup') out.warmup = Number(next());
    else if (a === '--quota-per-minute') out.quotaPerMinute = Number(next());
    else if (a === '--corpus-dir') out.corpusDir = next();
    else if (a === '--out') out.out = next();
    else if (a === '--label') out.label = next();
    else if (a === '--arm-wait-ms') out.armWaitMs = Number(next());
    else if (a === '--no-rearm') out.allowRearm = false;
    else if (a === '--help' || a === '-h') {
      console.log(
        '用法：node tools/mcp-shell-latency-evidence.mjs [--repo <树>] [--only single,serial20,batch20,concurrent]' +
          ' [--single-n N] [--rounds R] [--warmup W] [--quota-per-minute Q] [--corpus-dir <目录>] [--out <json>] [--label 名]',
      );
      process.exit(0);
    } else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
  return out;
}

/** 最近秩分位（与 Rust 台账同口径的写法：升序后取第 ceil(q·n) 个，1-based）。 */
function percentile(sorted, q) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1];
}

function stats(msList) {
  const s = [...msList].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: percentile(s, 0.5),
    p95: percentile(s, 0.95),
    max: s.length ? s[s.length - 1] : null,
    min: s.length ? s[0] : null,
    raw: s,
  };
}

/** 从任意深度里抠出 JSON（debug-cli 的输出前面可能还有提示行）。 */
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

function runDebugCli(repo, cliArgs, opts = {}) {
  const res = spawnSync(process.execPath, [path.join('tools', 'debug-cli.mjs'), ...cliArgs], {
    cwd: repo,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
    timeout: opts.timeoutMs ?? 300_000,
  });
  return {
    rc: res.status,
    stdout: (res.stdout ?? '') + (res.stderr ?? ''),
    error: res.error?.message ?? null,
  };
}

/* ------------------------------ 端点客户端 ------------------------------ */

/**
 * 一帧（或一批帧）的 POST：`Connection: close` 语义＝每条请求一条新连接
 * （端点每帧恒 `Connection: close`，客户端不许偷连复用，否则量的就不是壳里那条路）。
 * 三闸按生产形态带上：回环 + Bearer + Origin。
 */
function postFrames(endpoint, token, frames) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(frames), 'utf-8');
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
        },
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const ms = performance.now() - t0;
          const raw = Buffer.concat(chunks).toString('utf-8');
          let json = null;
          let parseError = null;
          try {
            json = JSON.parse(raw);
          } catch (e) {
            parseError = e.message;
          }
          resolve({ ms, status: res.statusCode, json, parseError, headers: res.headers });
        });
      },
    );
    req.on('error', (e) => resolve({ ms: performance.now() - t0, status: 0, json: null, parseError: `连接失败：${e.code ?? e.message}`, headers: {} }));
    req.end(body);
  });
}

/** 成功数据帧判定：HTTP 200（经 shim 时看不到状态码，按帧内容判）+ JSON-RPC result + 正文非空 + 无 error / isError。 */
function judgeSingle(resp) {
  if (resp.parseError) return { ok: false, why: `响应不可解析：${resp.parseError}` };
  if (resp.status !== undefined && resp.status !== 0 && resp.status !== 200) {
    return { ok: false, why: `HTTP ${resp.status}` };
  }
  const frame = Array.isArray(resp.json) ? resp.json[0] : resp.json;
  if (!frame || frame.error) {
    return { ok: false, why: `JSON-RPC error：${frame?.error?.code ?? '?'} ${String(frame?.error?.message ?? '').slice(0, 80)}` };
  }
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
  const chars = typeof payload.text === 'string' ? payload.text.length : 0;
  if (chars === 0 || !(payload.textLength > 0)) {
    return { ok: false, why: `读到空正文（text=${chars} textLength=${payload.textLength ?? '?'}）` };
  }
  return { ok: true, chars, elapsedMs: result._meta?.elapsedMs ?? null, fingerprint: payload.fingerprint ?? null };
}

/* ------------------------------ 取证节流器 ------------------------------ */

/**
 * 客户端侧节流：把「每分钟消耗的 envelope 数」压在闸值以下（缺省 110 < 120）。
 * 这是**尊重闸**，不是放宽闸——闸在服务端，脚本碰不到也不许碰。
 * 改前的端点把 batch 整批只计 1 次，改后逐条计；两边都按「逐条计」这个更严的口径节流，
 * 免得改后那版被速率闸打断，量到的不是同一种东西。
 */
function makeThrottle(limitPerMinute) {
  const stamps = [];
  const prune = () => {
    const now = Date.now();
    while (stamps.length && now - stamps[0] >= 60_000) stamps.shift();
  };
  const take = async function (count) {
    for (let i = 0; i < count; i += 1) {
      prune();
      if (stamps.length >= limitPerMinute) {
        const waitMs = 60_000 - (Date.now() - stamps[0]) + 5;
        await sleep(Math.max(5, waitMs));
        prune();
      }
      stamps.push(Date.now());
    }
  };
  /** 场景之间把速率窗彻底放空：端点的 `RateGovernor` 是**固定 60s 窗**（整窗清零），
   *  客户端的滚动窗与它对不齐时，burst 会撞 429（本脚本实测撞过 ⇒ 429 是闸在正常工作，
   *  不是被测面的延迟）。放空后再打，burst 才落在同一个窗里，量到的才是端点的形状。 */
  const reset = async function () {
    if (stamps.length === 0) return;
    const waitMs = 61_000 - (Date.now() - stamps[0]);
    if (waitMs > 0) await sleep(waitMs);
    stamps.length = 0;
  };
  return { take, reset, stamps };
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo;
  if (!fs.existsSync(path.join(repo, 'tools', 'debug-cli.mjs'))) {
    console.error(`[FAIL] --repo 指的不是 kojo-editor 工作树：${repo}`);
    process.exit(2);
  }
  const wanted = new Set(args.only.split(',').map((s) => s.trim()).filter(Boolean));
  // 读数落盘位置：默认 os.tmpdir()（零进仓）；中途硬失败也要把已拿到的部分写出去，
  // 免得「取不到」只留下一句口头结论。
  const outFilePrepared =
    args.out ?? path.join(os.tmpdir(), `kojo-mcp-shell-latency-${args.label}-${Date.now()}.json`);

  /* 1) 通道自证：目标树的会话文件里 `mode` 必须是 `shell`（PITFALLS 236：两条通道的结论不许互借）。
     读数取自**目标树自己的** debug-lib（会话按工作树分房，跨树互不可见），不是本脚本这棵树。 */
  let channel = null;
  try {
    const libUrl = pathToFileURL(path.join(repo, 'tools', 'debug-lib.mjs')).href;
    const lib = await import(libUrl);
    const sessFile = process.env.KOJO_DEBUG_SESSION ?? path.join(lib.sessionDir(repo), 'session.json');
    const sess = JSON.parse(fs.readFileSync(sessFile, 'utf-8'));
    channel = {
      mode: sess.mode ?? null,
      sessionId: sess.sessionId ?? null,
      repoRoot: sess.repoRoot ?? repo,
      cdpPort: sess.cdpPort ?? null,
      vitePort: sess.vitePort ?? null,
      createdAt: sess.createdAt ?? null,
      sessionFile: sessFile,
    };
  } catch (err) {
    console.error(`[FAIL] 读不到目标树的调试会话（${err?.message ?? err}）——本脚本只量**真桌面壳**。`);
    process.exit(2);
  }
  const st = runDebugCli(repo, ['status', '--json']);
  if (channel.mode !== 'shell' || st.rc !== 0) {
    console.error(
      `[FAIL] 通道不对：会话 mode=${channel.mode ?? '读不到'}、debug-cli status rc=${st.rc}——` +
        '本脚本只认 mode=shell 的**真桌面壳**（调试宿 serve 的数不许借），请先在目标树起：' +
        'node tools/debug-cli.mjs shell',
    );
    console.error(st.stdout.slice(0, 600));
    process.exit(2);
  }
  console.log(`[channel] mode=shell · session=${channel.sessionId} · cdp=:${channel.cdpPort} · vite=:${channel.vitePort}`);
  console.log(`[channel] status rc=0（页面相位等原样见输出 JSON 的 statusJson）`);

  /* 2) 起端点（宿主命令，零协议面入口），拿 port/token。
        先 `mcp_stop` 再 `mcp_start`：耗时台账**随运行时存活**，不换运行时就会把上一轮（别的
        车道 / 上一次冒烟）的样本混进本次读数里。停一次起一次 ⇒ 窗口里只有这一轮的帧
        （弃样也在窗口内，见 report.ledgerAfterWarmup 的单独留档）。 */
  runDebugCli(repo, ['invoke', 'mcp_stop', '{}']);
  const startRes = runDebugCli(repo, ['invoke', 'mcp_start', '{"enabled":true}']);
  const startJson = lastJson(startRes.stdout);
  if (startRes.rc !== 0 || !startJson?.port || !startJson?.token) {
    console.error(`[FAIL] mcp_start 没起来（rc=${startRes.rc}）：${startRes.stdout.slice(0, 400)}`);
    process.exit(3);
  }
  const endpoint = { host: '127.0.0.1', port: startJson.port, path: '/mcp' };
  const token = startJson.token;
  console.log(`[endpoint] 127.0.0.1:${endpoint.port}/mcp（token 已取，不外印）`);

  /* 3) 语料：只从环境变量 / 命令行来，仓库里零字 */
  let corpusDir = args.corpusDir;
  if (!corpusDir) {
    const modUrl = pathToFileURL(path.join(repo, 'tools', 'corpus.mjs')).href;
    try {
      const mod = await import(modUrl);
      corpusDir = mod.resolveCorpusDir({});
    } catch (err) {
      console.error(
        `[FAIL] 语料解析失败（${err?.message ?? err}）——` +
          '设 KOJO_CORPUS_DIR=<目录>，或 KOJO_CORPUS_SCAN_DIRS=<扫描根> 让 tools/corpus.mjs 自己发现；' +
          '亦可用 --corpus-dir 直接给。',
      );
      process.exit(3);
    }
  }
  if (!corpusDir || !fs.existsSync(corpusDir)) {
    console.error('[FAIL] 语料目录不存在，读面出不来成功帧');
    process.exit(3);
  }
  console.log('[corpus] 已解析到语料目录（路径只进本次运行输出，不进仓）');

  /* 4) 开项目（真壳 open-project＝调试面应答目录对话框，只读腿，不带 --writable） */
  const openRes = runDebugCli(repo, ['open-project', corpusDir], { timeoutMs: 600_000 });
  if (openRes.rc !== 0) {
    console.error(`[FAIL] open-project rc=${openRes.rc}：${openRes.stdout.slice(0, 600)}`);
    process.exit(3);
  }
  console.log('[project] open-project rc=0');

  /* 5) 取样文件：真语料里的小文件，按名字定序 ⇒ 两版量的是同一批文件 */
  const csvDir = path.join(corpusDir, 'CSV');
  let files = [];
  if (fs.existsSync(csvDir)) {
    files = fs
      .readdirSync(csvDir, { withFileTypes: true })
      .filter((d) => d.isFile() && /\.csv$/i.test(d.name))
      .map((d) => {
        const stt = fs.statSync(path.join(csvDir, d.name));
        return { name: d.name, size: stt.size };
      })
      .filter((f) => f.size > 200 && f.size < 40_000)
      .sort((a, b) => a.name.localeCompare(b.name, 'en'))
      .slice(0, 20)
      .map((f) => `CSV/${f.name}`);
  }
  if (files.length < 20) {
    const erbDir = path.join(corpusDir, 'ERB');
    if (fs.existsSync(erbDir)) {
      for (const d of fs.readdirSync(erbDir, { withFileTypes: true })) {
        if (files.length >= 20) break;
        if (!d.isFile() || !/\.erb$/i.test(d.name)) continue;
        const stt = fs.statSync(path.join(erbDir, d.name));
        if (stt.size > 200 && stt.size < 40_000) files.push(`ERB/${d.name}`);
      }
    }
  }
  if (files.length === 0) {
    console.error('[FAIL] 语料里没取到 200B–40KB 的取样文件，读面无法出成功帧');
    process.exit(3);
  }
  console.log(`[samples] 取样文件 ${files.length} 枚（真语料内小文件）`);

  const frameFor = (i) => ({
    jsonrpc: '2.0',
    id: `c${i}`,
    method: 'tools/call',
    params: { name: 'fs.readFile', arguments: { relPath: files[i % files.length] } },
  });

  const { take, reset } = makeThrottle(args.quotaPerMinute);

  /** 单帧发送 + 判定 + 记账（失败帧不混进分位数）。 */
  async function oneCall(i, bucket) {
    await take(1);
    const resp = await postFrames(endpoint, token, frameFor(i));
    const verdict = judgeSingle(resp);
    if (verdict.ok) {
      bucket.ok += 1;
      bucket.ms.push(resp.ms);
      if (typeof verdict.elapsedMs === 'number') bucket.serverMs.push(verdict.elapsedMs);
      bucket.chars += verdict.chars;
    } else {
      bucket.fail += 1;
      bucket.failures[verdict.why] = (bucket.failures[verdict.why] ?? 0) + 1;
    }
    return verdict;
  }

  const newBucket = () => ({ ok: 0, fail: 0, ms: [], serverMs: [], chars: 0, failures: {} });
  const report = {
    label: args.label,
    channel,
    statusJson: lastJson(st.stdout) ?? st.stdout.slice(0, 400),
    startedAt: new Date().toISOString(),
    endpoint: { host: '127.0.0.1', port: endpoint.port },
    quotaRespectedPerMinute: args.quotaPerMinute,
    sampleFiles: files.length,
    scenarios: {},
  };

  /* 5.5) 读腿就位自证（**改前那一版的实拍形状**，不是脚本的兜底）：
     在 fe706db3 的真壳里实拍到过「项目已开、真源也已登记，但 host-bridge 的注册表在真源
     登记之前就 memoize 了」⇒ 整批 read 面回 `NOT_WIRED「宿主未提供数据源」`。
     处置口径（按序，绝不改被测代码）：① 先按秒等它自己落定（缺省 90s）；② 仍不出成功帧，
     才调用 **app 自己的**登记入口 `registerMcpHostBridge()`（bootstrap 本来就走这一处，
     零代码改动、零闸变化）；③ 把「等到 / re-arm / 试过几趟」如实进读数。
     改后那一版同一脚本零 re-arm 直接出数——这条差异本身就是取证结果之一。 */
  const arm = { attempts: 0, waitedMs: 0, method: 'waited', rearmTried: false, rearmRc: null, lastReason: null };
  {
    const deadlineMs = args.armWaitMs;
    const t0 = Date.now();
    let ok = false;
    while (Date.now() - t0 < deadlineMs) {
      arm.attempts += 1;
      await take(1);
      const v = judgeSingle(await postFrames(endpoint, token, frameFor(0)));
      if (v.ok) {
        ok = true;
        break;
      }
      arm.lastReason = v.why;
      await sleep(3000);
      arm.waitedMs = Date.now() - t0;
    }
    if (!ok && args.allowRearm) {
      arm.rearmTried = true;
      const rr = runDebugCli(repo, ['eval', "(async () => { const hb = await import('/src/mcp/host-bridge.ts'); hb.registerMcpHostBridge(); return 'rearmed'; })()"], { timeoutMs: 120_000 });
      arm.rearmRc = rr.rc;
      for (let i = 0; i < 8; i += 1) {
        arm.attempts += 1;
        await take(1);
        const v = judgeSingle(await postFrames(endpoint, token, frameFor(0)));
        if (v.ok) {
          ok = true;
          arm.method = 're-registered';
          break;
        }
        arm.lastReason = v.why;
        await sleep(3000);
      }
    }
    arm.waitedMs = Date.now() - t0;
    report.arm = arm;
    if (!ok) {
      console.error(
        `[FAIL] 读腿始终没出成功帧（tried=${arm.attempts} 次，method=${arm.method}，最后原因：${arm.lastReason}）——` +
          '这一格的「改前成功帧」在这台机这一版上取不到，如实留空，不拿错误帧冒充延迟读数',
      );
      fs.writeFileSync(outFilePrepared, JSON.stringify(report, null, 2), 'utf-8');
      process.exit(4);
    }
    console.log(`[arm] 读腿就位：method=${arm.method} · attempts=${arm.attempts} · waitedMs=${arm.waitedMs} · rearmTried=${arm.rearmTried} · 最后失败原因=${arm.lastReason ?? '（无需）'}`);
  }

  /* 6) 预热（不计入读数）：首条要付懒装载 + 真盘的税，量它就不是端点的数 */
  const warm = newBucket();
  for (let i = 0; i < args.warmup; i += 1) await oneCall(i, warm);
  report.warmup = { discarded: args.warmup, ok: warm.ok, fail: warm.fail, firstMs: warm.ms[0] ?? null };
  console.log(`[warmup] 弃样 ${args.warmup} 条：ok=${warm.ok} fail=${warm.fail} 首条=${(warm.ms[0] ?? NaN).toFixed(1)}ms 末条=${(warm.ms.at(-1) ?? NaN).toFixed(1)}ms`);

  /* 台账读数器：宿主命令 `mcp_latency_query`（B5 起才有；改前那版必须如实记「命令不存在」，
     不许拿客户端墙钟冒充壳内台账）。壳内台账是**端点自己**记的那格，与脚本墙钟互为对账。 */
  const readLedger = () => {
    const r = runDebugCli(repo, ['invoke', 'mcp_latency_query', '{}']);
    const j = lastJson(r.stdout);
    if (r.rc !== 0 || !j) {
      return { unavailable: true, rc: r.rc, note: `宿主命令读数不可用：${String(r.stdout).slice(0, 200)}` };
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
      perKey: keys.map((k) => ({ key: k.key, seen: k.seen, samples: k.samples, dropped: k.dropped, p50Ms: k.p50Ms, p95Ms: k.p95Ms, p99Ms: k.p99Ms, maxMs: k.maxMs, avgMs: k.avgMs })),
    };
  };
  report.ledgerAfterWarmup = readLedger();

  /* 7a) 单发成功帧 */
  if (wanted.has('single')) {
    await reset();
    const b = newBucket();
    for (let i = 0; i < args.singleN; i += 1) await oneCall(i, b);
    report.scenarios.single = { kind: '一条 HTTP 一帧 tools/call（fs.readFile 成功帧）', ...stats(b.ms), serverSide: stats(b.serverMs), ok: b.ok, fail: b.fail, failures: b.failures };
    console.log(`[single] n=${b.ok} p50=${report.scenarios.single.p50?.toFixed(2)} p95=${report.scenarios.single.p95?.toFixed(2)} max=${report.scenarios.single.max?.toFixed(2)} fail=${b.fail}`);
  }

  /* 7b) 同一条腿换成**真实 MCP 客户端形态**：stdio shim（`tools/kojo-mcp.mjs`）逐帧转发。
         B5 表二那一格就是走这条量出来的（语料不在盘 ⇒ 那次只有错误帧）；这一行把它换成成功帧。
         shim 走的是同一个端点、同三闸，只是外面多套一层 stdin/stdout —— 点名口径别混：
         `single`＝裸 HTTP 打到壳内端点；`shimSingle`＝经 stdio shim（多一层进程间行协议）。 */
  if (wanted.has('shim')) {
    await reset();
    const b = newBucket();
    const child = spawn(process.execPath, [path.join(repo, 'tools', 'kojo-mcp.mjs')], {
      cwd: repo,
      windowsHide: true,
      env: {
        ...process.env,
        // 端点与 token 只走环境变量覆盖（shim 的默认发现文件按非隔离 appDataDir 落点，
        // 壳带 --isolate 起时那份不在老地方；这里显式成对覆盖，绝不回落空 token）。
        KOJO_MCP_ENDPOINT: `http://127.0.0.1:${endpoint.port}${endpoint.path}`,
        KOJO_MCP_TOKEN: token,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '';
    const stderrTail = [];
    /** 单一等待槽（shim 对普通请求逐帧等待、逐帧转发 ⇒ 一问一答够用） */
    let waiting = null;
    child.stdout.on('data', (d) => {
      stdoutBuf += d.toString('utf-8');
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          /* 非 JSON 行忽略（shim 的 stdout 只该有帧） */
        }
        if (parsed && waiting) {
          const w = waiting;
          waiting = null;
          clearTimeout(w.timer);
          w.resolve({ ms: performance.now() - w.t0, json: parsed });
        }
      }
    });
    child.stderr.on('data', (d) => {
      if (stderrTail.length < 12) stderrTail.push(String(d).trim().slice(0, 200));
    });
    const shimTimeoutMs = 30_000;
    for (let i = 0; i < args.singleN; i += 1) {
      await take(1);
      const frame = { ...frameFor(i), id: `s${i}` };
      const got = await new Promise((resolve) => {
        const t0 = performance.now();
        const timer = setTimeout(() => {
          waiting = null;
          resolve({ ms: performance.now() - t0, json: null, parseError: `shim ${shimTimeoutMs / 1000}s 没回帧` });
        }, shimTimeoutMs);
        waiting = { t0, timer, resolve };
        child.stdin.write(`${JSON.stringify(frame)}\n`, (err) => {
          if (err) {
            clearTimeout(timer);
            waiting = null;
            resolve({ ms: performance.now() - t0, json: null, parseError: `stdin 写失败：${err.message}` });
          }
        });
      });
      const v = judgeSingle(got);
      if (v.ok) {
        b.ok += 1;
        b.ms.push(got.ms);
      } else {
        b.fail += 1;
        b.failures[v.why] = (b.failures[v.why] ?? 0) + 1;
      }
    }
    child.stdin.end();
    child.kill();
    report.scenarios.shimSingle = {
      kind: '经 tools/kojo-mcp.mjs（stdio shim）单条 tools/call：真实 MCP 客户端形态（同端点同三闸，多一层 stdin/stdout）',
      ...stats(b.ms),
      ok: b.ok,
      fail: b.fail,
      failures: b.failures,
      shimStderr: stderrTail,
    };
    console.log(`[shimSingle] n=${b.ok} p50=${report.scenarios.shimSingle.p50?.toFixed(2)} p95=${report.scenarios.shimSingle.p95?.toFixed(2)} fail=${b.fail}`);
  }

  /* 7c) 20 条串行（round 墙钟） */
  if (wanted.has('serial20')) {
    await reset();
    const rounds = [];
    const b = newBucket();
    for (let r = 0; r < args.rounds; r += 1) {
      const t0 = performance.now();
      for (let i = 0; i < 20; i += 1) await oneCall(r * 20 + i, b);
      rounds.push(performance.now() - t0);
    }
    report.scenarios.serial20 = {
      kind: '20 条单发串行：每 round 一条一条发完的墙钟（含脚本侧判定与节流以外的全部）',
      rounds,
      ...stats(rounds),
      perCall: stats(b.ms),
      ok: b.ok,
      fail: b.fail,
      failures: b.failures,
    };
    console.log(`[serial20] rounds=${rounds.map((x) => x.toFixed(0)).join('/')} p50=${report.scenarios.serial20.p50?.toFixed(1)}`);
  }

  /* 7c) batch 20（一次 HTTP 装 20 帧） */
  if (wanted.has('batch20')) {
    await reset();
    const rounds = [];
    let okFrames = 0;
    let failFrames = 0;
    const failures = {};
    const perFrame = newBucket();
    for (let r = 0; r < args.rounds; r += 1) {
      await take(20);
      const frames = Array.from({ length: 20 }, (_, i) => frameFor(r * 20 + i));
      const t0 = performance.now();
      const resp = await postFrames(endpoint, token, frames);
      const wall = performance.now() - t0;
      rounds.push(wall);
      const arr = Array.isArray(resp.json) ? resp.json : null;
      if (!arr || arr.length !== 20) {
        failFrames += 20;
        failures[`批帧形状非法（HTTP ${resp.status}/${resp.parseError ?? '无'}）`] = (failures[`批帧形状非法（HTTP ${resp.status}/${resp.parseError ?? '无'}）`] ?? 0) + 20;
        continue;
      }
      for (const f of arr) {
        const v = judgeSingle({ ...resp, json: f });
        if (v.ok) {
          okFrames += 1;
          perFrame.ok += 1;
          perFrame.ms.push(wall);
          if (typeof v.elapsedMs === 'number') perFrame.serverMs.push(v.elapsedMs);
        } else {
          failFrames += 1;
          failures[v.why] = (failures[v.why] ?? 0) + 1;
        }
      }
    }
    report.scenarios.batch20 = {
      kind: '一次 HTTP 里 20 帧 tools/call（端点并发派发、同序回帧）：批帧墙钟',
      rounds,
      ...stats(rounds),
      okFrames,
      failFrames,
      failures,
      perFrameServerSide: stats(perFrame.serverMs),
    };
    console.log(`[batch20] rounds=${rounds.map((x) => x.toFixed(0)).join('/')} 成帧=${okFrames} 失败=${failFrames}`);
  }

  /* 7d) 并发 8×12 */
  if (wanted.has('concurrent')) {
    await reset();
    const b = newBucket();
    const rounds = [];
    let okFrames = 0;
    let failFrames = 0;
    const failures = {};
    const CLIENTS = 8;
    const PER_CLIENT = 12;
    for (let r = 0; r < 2; r += 1) {
      if (r > 0) await reset();
      await take(CLIENTS * PER_CLIENT);
      const t0 = performance.now();
      const jobs = Array.from({ length: CLIENTS }, (_, c) =>
        (async () => {
          for (let k = 0; k < PER_CLIENT; k += 1) {
            const resp = await postFrames(endpoint, token, frameFor(c * PER_CLIENT + k));
            const v = judgeSingle(resp);
            if (v.ok) {
              okFrames += 1;
              b.ok += 1;
              b.ms.push(resp.ms);
              if (typeof v.elapsedMs === 'number') b.serverMs.push(v.elapsedMs);
            } else {
              failFrames += 1;
              b.fail += 1;
              failures[v.why] = (failures[v.why] ?? 0) + 1;
            }
          }
        })(),
      );
      await Promise.all(jobs);
      const wall = performance.now() - t0;
      rounds.push(wall);
    }
    const totalFrames = CLIENTS * PER_CLIENT * rounds.length;
    const sumRoundMs = rounds.reduce((a, x) => a + x, 0);
    report.scenarios.concurrent8x12 = {
      kind: '8 条并发连接 × 每条 12 次单发（在途预算 8 的形状）',
      clients: CLIENTS,
      perClient: PER_CLIENT,
      rounds,
      okFrames,
      failFrames,
      failures,
      throughputPerSecond: ((okFrames / sumRoundMs) * 1000).toFixed(1),
      perCall: stats(b.ms),
      perCallServerSide: stats(b.serverMs),
    };
    console.log(`[concurrent 8x12] rounds=${rounds.map((x) => x.toFixed(0)).join('/')} 成帧=${okFrames}/${totalFrames} 吞吐=${report.scenarios.concurrent8x12.throughputPerSecond}/秒`);
  }

  /* 8) 端点自身台账（壳内宿主命令读数；与上面的客户端墙钟互为对账） */
  report.latencyLedger = readLedger();
  console.log(
    `[ledger] ${report.latencyLedger.unavailable ? '不可用（如实留空）' : `perKey=${report.latencyLedger.perKey.map((k) => `${k.key}:seen${k.seen}/p50=${k.p50Ms}/p95=${k.p95Ms}/drop=${k.dropped}`).join(' ')} overflow=${report.latencyLedger.overflowKeys}`}`,
  );

  report.finishedAt = new Date().toISOString();

  /* 9) 落盘（默认 os.tmpdir()，零进仓） */
  const outFile = outFilePrepared;
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`[out] ${outFile}`);

  const anyFail = Object.values(report.scenarios).some((s) => (s.fail ?? s.failFrames ?? 0) > 0);
  console.log('================ 人读表 ================');
  for (const [name, s] of Object.entries(report.scenarios)) {
    const p50 = s.p50 ?? s.perCall?.p50;
    const p95 = s.p95 ?? s.perCall?.p95;
    console.log(
      `${name.padEnd(14)} 形态=${s.kind}\n  n=${s.n ?? s.okFrames ?? s.rounds?.length ?? s.perCall?.n} p50=${p50?.toFixed?.(2) ?? '-'} p95=${p95?.toFixed?.(2) ?? '-'}` +
        ` fail=${s.fail ?? s.failFrames ?? 0}`,
    );
  }
  process.exit(anyFail ? 4 : 0);
}

main().catch((err) => {
  console.error(`[FAIL] ${err?.stack ?? err}`);
  process.exit(1);
});
