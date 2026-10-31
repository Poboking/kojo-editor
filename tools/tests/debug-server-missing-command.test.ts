/**
 * 调试宿「缺失命令」的可诊断性（2026-10-31 批）。
 *
 * 背景：`tools/debug-server.mjs` 是桌面壳命令面的手写 Node 镜像，78 条里有 37 条是
 * `launcher_*` 桌面壳独占能力 / 旧通道，**这几批已判定不该补**，逐条登记在
 * `tools/tests/debug-server-mirror.test.ts` 的 `MIRROR_GAPS` 里。
 *
 * 但「不该补」不等于「报错可以含糊」：旧行为是任何未命中都回 200 + 一句
 * `调试宿没有实现命令：xxx`，于是页面里 `launcher_start` 与手滑打错的命令名长得一模一样，
 * 调用方只能猜「是功能坏了还是名字错了」。这一批把两种分开：
 *
 * - `501 {code:'mirror_missing', cmd, reason, next}` —— Rust 有、镜像刻意没有；
 * - `404 {code:'unknown_command', cmd, suggestions[]}` —— 两边都没有，多半拼错。
 *
 * 本文件钉三件事：
 * 1. 三种响应（未实现 / 拼错 / 正常命令）的状态码与 body 形状；
 * 2. 正常命令**逐字未变**（这是硬要求：既有 62 例钉着它，页面也直接吃 error 文本）；
 * 3. 宿里那份缺口集合（`MIRROR_GAP_COMMANDS`）与测试 allowlist（`MIRROR_GAPS`）**键集必须相等**——
 *    两份清单各自维护，漂移由这道闸兜住。
 *
 * 全部打真 HTTP（`createDebugServer({ port: 0 })`），不依赖真实端口占用。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createDebugServer,
  DEBUG_HOST_COMMANDS,
  MIRROR_GAP_COMMANDS,
} from '../debug-server.mjs';

interface InvokeBody {
  ok: boolean;
  value?: unknown;
  error?: string;
  code?: string;
  cmd?: string;
  reason?: string;
  next?: string;
  suggestions?: string[];
}

let server: Awaited<ReturnType<typeof createDebugServer>>;
let base = '';
let sandbox = '';
let appdata = '';
let root = '';

/** 打一次 `/invoke`，**状态码与 body 一起返回**——本批的判据有一半在状态码上 */
async function post(cmd: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd, args }),
  });
  const body = (await res.json()) as InvokeBody;
  return { status: res.status, body };
}

beforeAll(async () => {
  // mkdtemp 而不是固定 tmp 名：并发跑 vitest（同机多 worktree）时固定名会互相踩
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-missing-cmd-'));
  sandbox = path.join(root, 'sandbox');
  appdata = path.join(root, 'appdata');
  for (const d of [sandbox, appdata, path.join(root, 'outside')]) await fs.mkdir(d, { recursive: true });
  server = await createDebugServer({ port: 0, sandbox, appdata });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('调试宿 · 未实现命令（Rust 有、镜像刻意没有）', () => {
  it('launcher_start ⇒ 501 + mirror_missing，并给出原因与可操作的下一条', async () => {
    const { status, body } = await post('launcher_start', { instance_id: 'x' });
    // 501 而不是 200：传输层就能分出「这个能力本实现没有」与「命令跑失败了」
    expect(status).toBe(501);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('mirror_missing');
    expect(body.cmd).toBe('launcher_start');
    // 一句「web 模式为什么给不出」——空泛的 "not supported" 等于没说
    expect(body.reason ?? '').toContain('Job');
    // 可操作的下一条：真壳在哪、怎么起
    expect(body.next ?? '').toContain('node tools/debug-cli.mjs shell');
    // error 是页面唯一会展示的字段（web-host-transport 直接 throw body.error），必须自成一体
    expect(body.error ?? '').toContain('web 模式无镜像');
    expect(body.error ?? '').toContain('debug-cli.mjs shell');
    // 未命中不许带 value（旧实现也没有，页面侧无需为它加分支）
    expect('value' in body).toBe(false);
  });

  it('缺口集合里每一条都走 501，没有一条漏成「拼错」', async () => {
    for (const name of Object.keys(MIRROR_GAP_COMMANDS)) {
      const { status, body } = await post(name);
      expect(status, `${name} 应回 501`).toBe(501);
      expect(body.code, `${name} 的 code 应为 mirror_missing`).toBe('mirror_missing');
    }
  });
});

describe('调试宿 · 命令名拼错（Rust 与镜像都没有）', () => {
  it('launcher_strat ⇒ 404 + unknown_command，近似名里给出 launcher_start', async () => {
    const { status, body } = await post('launcher_strat');
    expect(status).toBe(404);
    expect(body.code).toBe('unknown_command');
    expect(body.cmd).toBe('launcher_strat');
    // 拼错缺口命令时也要能推出**缺口命令**——候选池含两边，否则这里会空
    expect(body.suggestions).toContain('launcher_start');
    expect(body.error ?? '').toContain('launcher_start');
    // 向后兼容：既有 62 例里那条原型链用例断言 error 含「没有实现命令」，措辞只许加不许改
    expect(body.error ?? '').toContain('没有实现命令');
  });

  it('拼错镜像已实现的命令时，建议指向真实名字（前缀 / 编辑距离两条路都认）', async () => {
    const typo = await post('stat_fil'); // 截断：stat_file / stat_files 都是它的扩展
    expect(typo.status).toBe(404);
    expect(typo.body.suggestions).toContain('stat_file');

    const slip = await post('path_exits'); // 手滑：i → e，编辑距离 1
    expect(slip.status).toBe(404);
    expect(slip.body.suggestions?.[0]).toBe('path_exists');
  });

  it('近似名最多 3 条（前缀能命中二十多条时不许全倒出来）', async () => {
    const { body } = await post('launcher_instanc');
    expect(body.code).toBe('unknown_command');
    expect((body.suggestions ?? []).length).toBe(3);
    // 推荐的每一条都必须是真的存在（不许造名字）
    const known = new Set([...Object.keys(DEBUG_HOST_COMMANDS), ...Object.keys(MIRROR_GAP_COMMANDS)]);
    for (const s of body.suggestions ?? []) expect(known.has(s), `${s} 不在已知命令里`).toBe(true);
  });

  it('一个都不像时 suggestions 为空，并指到全量清单（不硬凑）', async () => {
    const { status, body } = await post('zzz_not_a_command');
    expect(status).toBe(404);
    expect(body.suggestions).toEqual([]);
    expect(body.error ?? '').toContain('supportedCommands');
  });

  it('原型链上的名字（constructor / __proto__ / toString）照旧当「没有这条命令」，不进分发', async () => {
    for (const evil of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const { status, body } = await post(evil);
      expect(status, `${evil} 应回 404`).toBe(404);
      expect(body.ok).toBe(false);
      expect(body.error ?? '').toContain('没有实现命令');
      // 建议里绝不能出现它自己（那等于承认命令存在）
      expect(body.suggestions ?? []).not.toContain(evil);
    }
  });
});

describe('调试宿 · 命中镜像的命令行为逐字未变', () => {
  it('app_data_dir ⇒ 200 + 恰好 {ok, value}（多一个字段都算改形状）', async () => {
    const { status, body } = await post('app_data_dir');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.value).toBe(appdata);
    expect(Object.keys(body).sort()).toEqual(['ok', 'value']);
  });

  it('命令本身失败 ⇒ 仍是 200 + {ok:false, error}，不带 code（别和「命令不存在」混淆）', async () => {
    const { status, body } = await post('write_file_bytes', {
      path: path.join(root, 'outside', 'nope.txt'),
      data: Buffer.from('x').toString('base64'),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.error ?? '').toContain('写域外');
    expect(body.code).toBeUndefined();
    expect(Object.keys(body).sort()).toEqual(['error', 'ok']);
  });

  it('命中命令表的名字不会掉进未实现分支（DEBUG_HOST_COMMANDS 与分发用同一张表）', async () => {
    for (const name of Object.keys(DEBUG_HOST_COMMANDS)) {
      const { status } = await post(name);
      // 只要求「不是 501/404」——大部分命令缺参数会业务失败，那仍是 200
      expect(status, `${name} 被误判成缺失命令`).toBe(200);
    }
  });
});

/**
 * 从 TS 源码里抠出某个 `Record<string, string>` 字面量的**顶层 key**。
 *
 * 为什么不用 `import`：`MIRROR_GAPS` 没有导出，且把测试文件当模块 import 会把它那 5 个
 * `it()` 再注册一遍到本文件（vitest 会当场变红且原因极难读）。
 * 为什么不直接正则扫全文：块外的同形文本（别的对象、注释）会混进来——先按大括号配平
 * 切出声明块（跳过字符串与注释），再只在块内按 2 空格缩进取 key。
 * 形状不认识就抛：闸宁可红，也不许静默抠到 0 条后「等式两边都空」地假通过。
 */
function extractRecordKeys(src: string, declAnchor: string): string[] {
  const at = src.indexOf(declAnchor);
  if (at < 0) {
    throw new Error(`找不到声明 \`${declAnchor}\`——闸的锚点变了，请同步本文件的解析器`);
  }
  const open = src.indexOf('{', at);
  if (open < 0) throw new Error(`\`${declAnchor}\` 后面没有对象字面量`);

  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`\`${declAnchor}\` 的对象字面量没有配平（被截断？）`);

  const block = src.slice(open + 1, end);
  const keys: string[] = [];
  for (const m of block.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*):/gm)) keys.push(m[1]!);
  if (keys.length === 0) throw new Error(`\`${declAnchor}\` 里一条 key 都没抠到——解析器不认识这种形状`);
  return keys.sort();
}

describe('缺口清单 × 测试 allowlist 一致性', () => {
  const MIRROR_TEST_URL = new URL('./debug-server-mirror.test.ts', import.meta.url);

  it('MIRROR_GAP_COMMANDS 与 MIRROR_GAPS 键集逐条相等（两份清单，一道闸）', async () => {
    const src = await fs.readFile(MIRROR_TEST_URL, 'utf-8');
    const allowlisted = extractRecordKeys(src, 'const MIRROR_GAPS');

    // 双向相等：宿多登记 ⇒ 误报「未实现」；宿少登记 ⇒ 真缺口被当成拼错
    expect(Object.keys(MIRROR_GAP_COMMANDS).sort()).toEqual(allowlisted);
  });

  it('缺口集合与镜像已实现集合不相交，且每条都写了原因', () => {
    const mirrored = new Set(Object.keys(DEBUG_HOST_COMMANDS));
    // 读空前先怀疑实例没起来（DEBUG_HOST_COMMANDS 由 createDebugServer 就地登记）
    expect(mirrored.size, 'DEBUG_HOST_COMMANDS 是空的：实例没起来？').toBeGreaterThan(0);

    for (const [name, reason] of Object.entries(MIRROR_GAP_COMMANDS)) {
      expect(mirrored.has(name), `${name} 既登记成缺口又实现了——分发分支永远走不到 501`).toBe(false);
      // 原因要能读懂；''/'TODO' 这种占位不算
      expect(reason.trim().length, `MIRROR_GAP_COMMANDS["${name}"] 缺原因`).toBeGreaterThan(12);
    }
  });

  it('计数：镜像 / 缺口', () => {
    const mirrored = Object.keys(DEBUG_HOST_COMMANDS).length;
    const gaps = Object.keys(MIRROR_GAP_COMMANDS).length;
    // 数值本身可能随波次变化，这里只钉「两部分都非空、整体规模像样」，
    // 具体条数由 mirror.test.ts 与 lib.rs 对账负责
    console.log(`[缺失命令] mirrored=${mirrored} gaps=${gaps} total=${mirrored + gaps}`);
    expect(mirrored).toBeGreaterThan(0);
    expect(gaps).toBeGreaterThan(0);
  });
});
