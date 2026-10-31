/**
 * `tools/debug-cli.mjs` 的**进程级契约**护栏（2026-10-31 CLI 契约批）。
 *
 * 为什么需要这一层：`debug-cli-open-failure.test.ts` 钉的是纯函数 `classifyOpenFailure`，
 * `debug-cli-surface.test.ts` 钉的是 `parseArgs` 的静态形状——两者都**不经过进程边界**。
 * 而 agent 消费这个 CLI 的方式恰恰是 `node tools/debug-cli.mjs …` 的子进程：它读的是
 * **退出码**（决定 if/else）、**stderr**（决定报什么给用户）、**stdout**（决定能不能 `JSON.parse`）。
 * 这三样一旦被无意改掉，故障形态不是一条可读的失败，而是"脚本以为成功了"或"解析 JSON 时炸了"，
 * 排查成本极高。所以这里只钉进程级可观测面：
 *
 * ① 无会话 / 坏会话文件 ⇒ 非 0 + 可读错误 + stdout 一个字符都不留 + 不打栈；
 * ② `--json` 的 stdout 纯度（整个 stdout 必须能被 JSON.parse 整体吃下，且无 ANSI）；
 * ③ `doctor --json` 的键序（agent 按位置/键名取值，键序漂移等于静默换义）；
 * ④ `doctor` 的 FAIL 传导（体检红 ⇒ 退出码红，否则"体检说没事"就成了假绿）；
 * ⑤ 未知子命令 / 未知参数 / 位置参数校验的**现状**（包括已知缺口，如实登记而不修）。
 *
 * 造法：全部走 `spawnSync(process.execPath, …)` 子进程，`cwd` = 仓库根；
 * 会话场景一律用 `KOJO_DEBUG_SESSION` 指向 `mkdtemp` 里的伪造文件——**不碰真会话、不起浏览器、
 * 不起 vite、不占端口**。每个子进程 20s 上限，超时即失败并把 stderr 打出来（不是挂死）。
 */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const CLI = path.join(REPO, 'tools', 'debug-cli.mjs');

/** 单条子进程的墙钟上限：CLI 的健康路径都是百毫秒级，20s 已经宽到不可能误杀 */
const SPAWN_TIMEOUT_MS = 20_000;
/** vitest 单测上限要大于子进程上限，否则超时信息会被测试框架先吞掉 */
const TEST_TIMEOUT_MS = 40_000;

/** Node 的栈行（`    at foo (file:1:2)`）：它出现在 stderr 里就等于"把栈糊给用户了" */
const STACK_FRAME = /(^|\n)\s+at\s+\S/;
/** Node 顶部崩溃页脚：出现它就说明进程是崩的，而不是我们主动 die 的 */
const NODE_FOOTER = /Node\.js v\d+\.\d+\.\d+/;
/** ANSI CSI 序列：`--json` 的 stdout 必须没有它，否则 JSON.parse 直接失败 */
const ANSI = /\u001b\[/;

type CliRun = {
  args: string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

/**
 * 跑一次 CLI。`sessionFile` 必填：显式指定会话文件是**测试隔离**的关键——
 * 否则别的 agent 正在本工作树里 serve 时，`KOJO_DEBUG_SESSION` 会漏到子进程，
 * "无会话"用例就会偶发变绿/变红（这类抖动比没有测试更坏）。
 */
function runCli(args: string[], sessionFile: string): CliRun {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // 栈只在排障时打（KOJO_DEBUG_TRACE=1）：测试要验的正是"默认不打栈"，
  // 所以必须先把这个开关从宿主环境里摘掉，否则会被开发者的 shell 污染。
  delete env.KOJO_DEBUG_TRACE;
  delete env.KOJO_DEBUG_SESSION_NAME;
  env.KOJO_DEBUG_SESSION = sessionFile;

  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    env,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
  });

  // 超时 / 起不来：spawnSync 把原因塞在 error 里，stdout/stderr 可能只有半截。
  // 这里当场抛，并把已经拿到的 stderr 打出来——否则 vitest 只会报"测试超时"，看不到子进程说了什么。
  if (res.error) {
    const err = res.error as NodeJS.ErrnoException;
    throw new Error(
      `子进程失败（${args.join(' ')}）：${err.message}` +
        (err.code === 'ETIMEDOUT' ? `（超过 ${SPAWN_TIMEOUT_MS}ms）` : '') +
        `\n--- stdout ---\n${res.stdout ?? ''}\n--- stderr ---\n${res.stderr ?? ''}`,
    );
  }

  return {
    args,
    code: res.status,
    signal: res.signal,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

/** 统一的"失败要可读"判据：非 0、stdout 空、stderr 有关键片段、且没有栈/崩溃页脚 */
function expectCleanFailure(run: CliRun, code: number, fragments: string[]): void {
  expect(run.code, `${run.args.join(' ')} 的退出码`).toBe(code);
  // stdout 必须**严格**为空（连换行都没有）：--json 消费方拿到半截文档比拿不到更危险
  expect(run.stdout, `${run.args.join(' ')} 失败时 stdout 必须为空`).toBe('');
  expect(run.stderr.length, `${run.args.join(' ')} 失败时 stderr 必须有话说`).toBeGreaterThan(0);
  for (const fragment of fragments) {
    expect(run.stderr, `stderr 应包含「${fragment}」`).toContain(fragment);
  }
  // 这两条是"不糊栈"的实证：Node 崩了才会有的两种指纹
  expect(run.stderr, 'stderr 不应含栈帧（at file:line:col）').not.toMatch(STACK_FRAME);
  expect(run.stderr, 'stderr 不应含 Node 崩溃页脚').not.toMatch(NODE_FOOTER);
}

/** stderr 的首行是第一句判据（机器可按行 grep，人一眼能读）——多行提示不算违约 */
function firstLine(text: string): string {
  return text.split('\n')[0] ?? '';
}

let tmpRoot: string;
/** 指向一个**不存在**的会话文件：构造"无会话" */
let noSession: string;
/** 合法 JSON、但没有端口/pid 的会话：doctor 会把它读成"有 session、端口未记录"（全 WARN，rc=0） */
let cleanSession: string;
/** 半截 JSON：模拟 serve 写到一半被杀的残文件 */
let brokenSession: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-cli-contract-'));
  const absentDir = path.join(tmpRoot, 'absent');
  await fs.mkdir(absentDir, { recursive: true });
  noSession = path.join(absentDir, 'session.json'); // 目录在、文件不在

  const cleanDir = path.join(tmpRoot, 'clean');
  await fs.mkdir(cleanDir, { recursive: true });
  cleanSession = path.join(cleanDir, 'session.json');
  await fs.writeFile(cleanSession, JSON.stringify({ sessionId: 'contract-fixture', repoRoot: REPO }), 'utf-8');

  const brokenDir = path.join(tmpRoot, 'broken');
  await fs.mkdir(brokenDir, { recursive: true });
  brokenSession = path.join(brokenDir, 'session.json');
  // 注意：刻意写成"截断"而不是"乱码"——真实成因就是 serve 覆写途中被 kill
  await fs.writeFile(brokenSession, '{"sessionId": "abc", "serverPort": ', 'utf-8');
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/* ============================ ① 无会话 ============================ */

describe('无会话：必须是一条可读失败，而不是崩栈或假成功', () => {
  // 这三条覆盖了三条不同的入口路径：
  //  - `definition 1 1`：语义族（参数校验通过后立刻落到 withCdp → readSession）
  //  - `state`：页面读数族（同上，但错误发生在 waitFor 之前）
  //  - `status`：三件套健康（直接 readSession，是 agent 最常用来判断"有没有会话"的命令）
  // 它们全都**不需要浏览器**就能走到"无会话"这个判据上——这正是这批用例的取样面。
  it.each([
    [['definition', '1', '1']],
    [['state']],
    [['status']],
  ])('%s 无会话 ⇒ 退出码 2 + 判据 + 空 stdout', (args) => {
    const run = runCli(args, noSession);
    expectCleanFailure(run, 2, ['没有在跑的调试会话']);
    // 首行必须自带判据：多行提示（怎么起会话）可以有，但第一行要是"是什么错"
    expect(firstLine(run.stderr)).toContain('没有在跑的调试会话');
    // 错误里要带上是**哪个**会话文件：多 agent 并发下"按工作树分房"是核心隔离机制，
    // 不带路径的话用户根本不知道自己看的是哪棵树。
    expect(run.stderr).toContain('session.json');
  }, TEST_TIMEOUT_MS);

  it('--json 失败时也不许留半截文档（stdout 仍为空）', () => {
    // 这是 --json 契约里最容易写错的一条：很多人会在 emit 之前先打一行进度，
    // 于是失败时 stdout 有内容，消费方 JSON.parse 报的错跟真正原因毫无关系。
    const run = runCli(['state', '--json'], noSession);
    expectCleanFailure(run, 2, ['没有在跑的调试会话']);
  }, TEST_TIMEOUT_MS);

  it('无会话时 status 不会去探端口/连 CDP（提前 die，不等待）', () => {
    // 反向契约：exit 2 而不是 exit 1 —— 2 的口径是"前置不满足"（无会话/找不到浏览器/端口被占），
    // 脚本可以据此区分"环境没起"与"命令真的失败了"。
    const run = runCli(['status'], noSession);
    expect(run.code).toBe(2);
    expect(run.stderr).not.toContain('CDP 不在');
  }, TEST_TIMEOUT_MS);
});

/* ========================= ② 会话文件坏 JSON ========================= */

describe('会话文件损坏：可读错误、非 0、不打栈', () => {
  it('status 读到坏 JSON ⇒ 退出码 2 + 解析失败判据 + 空 stdout', () => {
    const run = runCli(['status'], brokenSession);
    expectCleanFailure(run, 2, ['会话文件损坏', 'JSON 解析失败']);
    expect(firstLine(run.stderr)).toContain('会话文件损坏');
    // 错误里必须带会话文件路径：坏文件是"哪个文件"决定的，光说"解析失败"没法处置
    expect(run.stderr).toContain('session.json');
  }, TEST_TIMEOUT_MS);

  it('definition 走同一判据（readSession 只有一个出口）', () => {
    const run = runCli(['definition', '1', '1'], brokenSession);
    expectCleanFailure(run, 2, ['会话文件损坏']);
    // 这里刻意不断言"处置"整段：文案会微调，但"损坏 + 非 0 + 空 stdout"是契约
  }, TEST_TIMEOUT_MS);
});

/* ======================= ③ --json 的 stdout 纯度 ======================= */

describe('--json：整个 stdout 必须是一个 JSON 文档', () => {
  it('doctor --json 的 stdout 能被 JSON.parse **整体**吃下，且无 ANSI', () => {
    const run = runCli(['doctor', '--json'], cleanSession);
    expect(run.code, '干净仓库的 doctor 应当 rc=0').toBe(0);
    expect(run.stderr, '成功路径不该往 stderr 写东西').toBe('');

    // 关键：直接把**原始 stdout** 丢给 JSON.parse，不 trim、不切片、不找第一个 `{`。
    // 先 trim 再 parse 会把"多打了一行 [ok]"这种事故掩盖掉——而那正是本条契约要防的。
    let doc: any;
    expect(() => {
      doc = JSON.parse(run.stdout);
    }, `stdout 不是单个 JSON 文档：\n${run.stdout.slice(0, 400)}`).not.toThrow();

    expect(ANSI.test(run.stdout), '--json 的 stdout 不应含 ANSI 转义').toBe(false);
    // 人类形态的行（[PASS] / （12 条） / `-- 8 项`）混进来就说明闸门漏了
    expect(run.stdout).not.toContain('[PASS]');
    expect(run.stdout).not.toContain(' ⇒ ');
    expect(run.stdout.startsWith('{')).toBe(true);
    expect(run.stdout.trimEnd().endsWith('}')).toBe(true);
    expect(doc.checks.length).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  it('doctor（不加 --json）仍打人类形态 —— 默认输出不能被 --json 改造顺手改掉', () => {
    // 反向护栏：有脚本和人在 grep `[PASS]` 这几行，默认形态必须保持人类可读。
    const run = runCli(['doctor'], cleanSession);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('[PASS] node-version');
    expect(run.stdout).toContain('⇒ OK');
    expect(() => JSON.parse(run.stdout)).toThrow();
  }, TEST_TIMEOUT_MS);
});

/* ========================= ④ doctor --json 的键序 ========================= */

describe('doctor --json 键序：消费方按位置取值，漂移即静默换义', () => {
  it('顶层是 ok → repo → checks', () => {
    const doc = JSON.parse(runCli(['doctor', '--json'], cleanSession).stdout);
    // 用 Object.keys 断言**顺序**（toEqual 对数组是保序的）：只断言存在等于放过重排
    expect(Object.keys(doc)).toEqual(['ok', 'repo', 'checks']);
    expect(typeof doc.ok).toBe('boolean');
    expect(doc.repo).toBe(REPO);
    expect(Array.isArray(doc.checks)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('每个 check 是 id → level → detail（fix 可选且在最后）', () => {
    const doc = JSON.parse(runCli(['doctor', '--json'], cleanSession).stdout);
    for (const check of doc.checks) {
      const keys = Object.keys(check);
      expect(keys.slice(0, 3), `check ${check.id} 的键序`).toEqual(['id', 'level', 'detail']);
      expect(keys.length === 3 || keys.length === 4, `check ${check.id} 只允许 3 或 4 个键`).toBe(true);
      if (keys.length === 4) expect(keys[3], `check ${check.id} 的第 4 个键必须是 fix`).toBe('fix');
      expect(['PASS', 'WARN', 'FAIL']).toContain(check.level);
    }
  }, TEST_TIMEOUT_MS);

  it('八项检查的 id 顺序固定（体检的阅读顺序＝修复顺序）', () => {
    const doc = JSON.parse(runCli(['doctor', '--json'], cleanSession).stdout);
    expect(doc.checks.map((c: any) => c.id)).toEqual([
      'node-version',
      'repo-root',
      'session-file',
      'host-port',
      'cdp-port',
      'dist-build',
      'vite-cache',
      'stale-procs',
    ]);
  }, TEST_TIMEOUT_MS);
});

/* ========================== ⑤ doctor 的退出码传导 ========================== */

describe('doctor 退出码：FAIL 必须传导到进程退出码', () => {
  it('正常仓库 rc=0（WARN 不改变退出码）', () => {
    const run = runCli(['doctor', '--json'], cleanSession);
    const doc = JSON.parse(run.stdout);
    expect(doc.checks.some((c: any) => c.level === 'WARN'), '这份夹具应至少有一条 WARN').toBe(true);
    expect(doc.checks.every((c: any) => c.level !== 'FAIL'), '干净仓库不该有 FAIL').toBe(true);
    expect(run.code).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('--repo 指向缺 package.json 的目录 ⇒ rc=1 且 stdout 明确指向 repo-root', async () => {
    // 为什么重要：体检是"上线前最后一次自检"。若退出码永远 0，CI 会把"工具链跑不起来"
    // 当成绿灯放行——这正是体检工具最不能犯的错。
    const bogus = await fs.mkdtemp(path.join(tmpRoot, 'not-a-repo-'));
    try {
      const run = runCli(['doctor', '--repo', bogus], cleanSession);
      expect(run.code).toBe(1);
      expect(run.stderr).toBe(''); // 体检失败是"读数"，不是"崩溃"：不打 stderr
      expect(run.stdout).toContain('[FAIL] repo-root');
      expect(run.stdout).toContain('⇒ FAIL');
      // 人类形态末尾的自证行必须与真实退出码一致（否则人照着看会被误导）
      expect(run.stdout).toContain('退出码 1');
    } finally {
      await fs.rm(bogus, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});

/* ============================ ⑥ 未知子命令 ============================ */

describe('未知子命令：非 0 + 可用命令列表', () => {
  it('nope ⇒ rc=1，stdout 列全 34 条子命令（含 doctor / definition）', () => {
    // 现状（如实登记，不修）：用法打在 **stdout**，stderr 空。
    // 对 agent 的含义是：只收 stderr 的脚本会看到"静默失败"，必须自己同时看 stdout。
    const run = runCli(['nope'], noSession);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('用法：node tools/debug-cli.mjs');
    for (const cmd of ['status', 'stop', 'doctor', 'definition', 'hover', 'drag', 'wheel']) {
      expect(run.stdout, `用法里应列出 ${cmd}`).toContain(cmd);
    }
    expect(run.stderr).toBe('');
    // 未知子命令也不许崩：这是"输入错"，不是"程序错"
    expect(run.stdout).not.toMatch(STACK_FRAME);
    expect(run.stderr).not.toMatch(NODE_FOOTER);
  }, TEST_TIMEOUT_MS);

  it('--json 下未知子命令也不产出 JSON（stdout 是中文用法）', () => {
    // 这是缺口：--json 的契约说"查询类命令 stdout 只有一个 JSON 文档"，
    // 但"未知子命令"这条错误路径根本不进 emit 闸门，消费方在 --json 下只能拿到非 JSON 的用法文本。
    const run = runCli(['nope', '--json'], noSession);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('用法：');
    expect(() => JSON.parse(run.stdout)).toThrow();
  }, TEST_TIMEOUT_MS);
});

/* ============================ ⑦ 未知参数 ============================ */

describe('未知参数（现状登记，非期望行为）', () => {
  it('doctor --bogus-flag 被**静默吞掉**：rc=0、stderr 空、输出与不加参数逐字相同', () => {
    // 实测现状（2026-10-31）：parseArgs 只认白名单里的带值参数/布尔开关，
    // 其余 `--xxx` 一律 `positional.push(a)`；doctor 根本不读 positional ⇒ 这个错字没有任何反馈。
    // 危害：agent 拼错 `--json` 为 `--jsn` 时会拿到人类文本却以为是 JSON。
    // 本条是**现状钉子**：将来若改成报错，这条测试必须一起改（那时才是修好了）。
    const baseline = runCli(['doctor'], cleanSession);
    const withBogus = runCli(['doctor', '--bogus-flag'], cleanSession);

    expect(withBogus.code, '未知参数不改变退出码').toBe(baseline.code);
    expect(withBogus.stderr, '未知参数不产生任何告警').toBe('');
    expect(withBogus.stdout, '输出与基线逐字相同（说明参数被完全忽略）').toBe(baseline.stdout);
    expect(withBogus.stdout).not.toContain('bogus');
  }, TEST_TIMEOUT_MS);

  it('--json 拼错（--jsn）同样静默降级成人类输出', () => {
    // 上一条的实际杀伤力演示：拼错开关不会红，只会让 stdout 变成不可解析的中文文本。
    const run = runCli(['doctor', '--jsn'], cleanSession);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(() => JSON.parse(run.stdout)).toThrow();
    expect(run.stdout).toContain('[PASS] node-version');
  }, TEST_TIMEOUT_MS);

  it('带值参数缺值时**盲目吃掉下一个 token**（--repo --json ⇒ repo 变成 "--json"）', () => {
    // 实测现状：`--repo` 走 `opts.repo = argv[++i]`，不做"下一个是不是另一个开关"的判断。
    // 于是 `doctor --repo --json` 把 `--json` 当成路径 ⇒ 体检的是 <repo>/--json 这个不存在的目录，
    // 同时 --json 开关也丢了：结果是一条**假 FAIL** + 人类文本，agent 两侧都读错。
    // 以及 `doctor --repo`（真的没给值）会静默回退到当前仓库 → 体检了另一棵树却显示 OK。
    // 同样是现状钉子：修好后这两条断言要跟着改。
    const eaten = runCli(['doctor', '--repo', '--json'], cleanSession);
    expect(eaten.code).toBe(1);
    expect(eaten.stdout).toContain('[FAIL] repo-root');
    expect(eaten.stdout).toContain('--json'); // 被当成路径回显出来了
    expect(() => JSON.parse(eaten.stdout)).toThrow(); // 开关被吃掉 ⇒ 没走 JSON 闸门

    const missingValue = runCli(['doctor', '--repo'], cleanSession);
    expect(missingValue.code).toBe(0); // 静默体检了当前仓库，而不是报"缺值"
    expect(missingValue.stdout).toContain('[PASS] repo-root');
  }, TEST_TIMEOUT_MS);

});

/* ====================== ⑧ 坐标 / 行列的参数校验 ====================== */

describe('位置参数校验：在碰浏览器之前就红，并回显用户写的原文', () => {
  // 这一族全部**不需要浏览器**：requireTarget / requireAt 在 withCdp 之前就 die。
  // 为什么必须先校验：Monaco 对越界行列不报错，只会给错位结果——"查了隔壁那一格"看起来像成功。
  it('hover 10,y ⇒ rc=2，提示坐标形态并回显「10,y」', () => {
    const run = runCli(['hover', '10,y'], cleanSession);
    expectCleanFailure(run, 2, ['hover', '10,y', 'x,y']);
  }, TEST_TIMEOUT_MS);

  it('definition 0 1 ⇒ rc=2，提示行号 1 基并回显「0」', () => {
    const run = runCli(['definition', '0', '1'], cleanSession);
    expectCleanFailure(run, 2, ['definition', '行号', '1 基', '0']);
    // 越界/0 基不是"空结果"：空结果是 rc=0 的 (空)，这里必须是 2（前置不满足）
    expect(run.stderr).not.toContain('(空)');
  }, TEST_TIMEOUT_MS);

  it('definition 1（缺列）⇒ rc=2，提示列号/两个位置参数都要给', () => {
    const run = runCli(['definition', '1'], cleanSession);
    expectCleanFailure(run, 2, ['definition', '列号']);
  }, TEST_TIMEOUT_MS);

  it('drag .a（缺终点）⇒ rc=2，提示终点参数', () => {
    const run = runCli(['drag', '.a'], cleanSession);
    expectCleanFailure(run, 2, ['drag', '终点']);
  }, TEST_TIMEOUT_MS);

  it('wheel 没有滚动量 ⇒ rc=2（空事件比报错更贵）', () => {
    // 两个 delta 都是 0 时 CDP 会照发一条空事件：页面一动不动，人只会认为"滚轮坏了"。
    const run = runCli(['wheel', '.a'], cleanSession);
    expectCleanFailure(run, 2, ['wheel', '滚动量']);
  }, TEST_TIMEOUT_MS);

  it('--settle 非数字 ⇒ rc=2 并回显原文（非法值不静默落默认）', () => {
    const run = runCli(['hover', '.a', '--settle', 'abc'], cleanSession);
    expectCleanFailure(run, 2, ['--settle', 'abc']);
  }, TEST_TIMEOUT_MS);
});
