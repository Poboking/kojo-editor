/**
 * `tools/launcher-smoke.mjs` 的纯函数护栏（车道 GATE，2026-10-26；L9 联调批 2026-10-26 追加夹具面）。
 *
 * 这个工具是「启动器判据在真壳里的插入点」，它自己的判定逻辑必须在无壳环境下就能被钉住：
 * 读数解析、断言分组、失败归类三件事一旦漂了，真壳上跑出来的红绿都不作数。
 * 壳相关的部分（CDP / 启动 / 隔离）**不在这里**测——它们按「通道可用才跑、否则 SKIP 并说明」
 * 的口径在脚本里如实报 rc=2，测试不假装绿。
 * L9 追加的四块全是纯函数：夹具路径推导 / 播种 JSON 形状 / 各断言组 / 清场清单。
 */
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_CODES,
  FIXTURE_APPROVED_BY,
  FIXTURE_LOOP_COUNT,
  FIXTURE_MARKER,
  FIXTURE_PREFIX,
  FIXTURE_WINDOW_MODE,
  READONLY_PROBES,
  attachTrust,
  buildFixtureInstance,
  buildInvokeExpression,
  checkCleanup,
  checkCreateMissingProfile,
  checkDiskGone,
  checkFixtureSeeded,
  checkListReading,
  checkLogContent,
  checkLogPumpFinished,
  checkLogSessions,
  checkManifestDigest,
  checkNoRunAfterRefusal,
  checkNoSideEffect,
  checkPlatformErrorShape,
  checkStartMissingInstance,
  checkStartRunning,
  checkStopClean,
  checkTreeAlive,
  checkTrustRequired,
  checkTrustSeeded,
  classifyFailure,
  cleanupPlan,
  fixtureArgs,
  fixtureLayout,
  fixtureNames,
  fixtureToken,
  groupAssertions,
  instanceRegistryEntry,
  isIsolatedSession,
  logTextOf,
  mergeFixtureRegistry,
  normalizeEnvelope,
  normalizeError,
  parseReadingLine,
  parseSkipLine,
  parseTasklistCsv,
  platformFixturePlan,
  platformUnsupportedReading,
  rowsByImage,
  stripFixtureRegistry,
  summarizeRun,
} from '../launcher-smoke.mjs';

const pass = (assertions: { id: string; ok: boolean }[]) => assertions.every((entry) => entry.ok);
const byId = (assertions: { id: string }[], id: string) => assertions.find((entry) => entry.id === id);

/** 本批固定用的夹具名（token 写死，免得断言随运行时间漂） */
const TOKEN = 'l9t0kenabc';
const NAMES = fixtureNames(TOKEN);
const APP_DATA = 'C:\\Users\\probe\\AppData\\Roaming\\dev.kojo.editor.smoke';
const GAME_ROOT = 'C:\\Users\\probe\\AppData\\Local\\Temp\\kojo-launcher-smoke-l9t0kenabc';
const TRUSTED_ID = NAMES.ids.trusted;
const UNTRUSTED_ID = NAMES.ids.untrusted;
const SHA = 'a1b2c3d4'.repeat(8);

const fixtureInstance = (overrides: Record<string, unknown> = {}) =>
  buildFixtureInstance({
    id: TRUSTED_ID,
    gameRoot: GAME_ROOT,
    relativePath: NAMES.exe,
    args: fixtureArgs(NAMES.childExe, NAMES.marker),
    now: '2026-10-26T00:00:00Z',
    ...overrides,
  });


describe('页内 invoke 表达式', () => {
  it('命令与参数走 JSON.stringify 嵌入，含页内 catch（错误对象不从 CDP 丢失）', () => {
    const expr = buildInvokeExpression('launcher_start', { instanceId: 'a"b\\c' });
    expect(expr).toContain('window.__kojoDebug.invoke("launcher_start"');
    expect(expr).toContain('"instanceId":"a\\"b\\\\c"');
    expect(expr).toContain('try {');
    expect(expr).toContain('catch (e)');
    // 表达式内不能出现未转义的裸双引号拼串（JSON.stringify 之外）
    expect(expr).not.toContain('invoke("launcher_start", {"instanceId":"a"b');
  });

  it('省略参数时给空对象（Tauri 侧缺参数与传 undefined 是两种错，这里只走前者）', () => {
    expect(buildInvokeExpression('launcher_process_list')).toContain('"launcher_process_list", {}');
  });
});

describe('错误归一化', () => {
  it('宿主结构化错误（LauncherErrorDto 形态）⇒ launcher-code + 码原样', () => {
    const error = normalizeError({ code: 'LAUNCHER_INSTANCE_NOT_FOUND', message: '找不到这个实例', retryable: false });
    expect(error).toMatchObject({ code: 'LAUNCHER_INSTANCE_NOT_FOUND', kind: 'launcher-code', panic: false });
    expect(error.message).toBe('找不到这个实例');
  });

  it('IPC 参数层拒收（Tauri 字符串）⇒ arg，且不带业务码', () => {
    const error = normalizeError(
      'invalid args `profile` for command `launcher_instance_create`: command launcher_instance_create missing required key profile',
    );
    expect(error.kind).toBe('arg');
    expect(error.code).toBeNull();
    expect(error.panic).toBe(false);
  });

  it('panic 特征被认出来（宿主崩溃 ≠ 返回错误）', () => {
    const error = normalizeError({ code: 'LAUNCHER_INTERNAL', message: "thread 'main' panicked at launcher/process.rs:1" });
    expect(error.panic).toBe(true);
  });

  it('认不出的应答形状按协议错处理，不猜成功', () => {
    expect(normalizeEnvelope(null)).toMatchObject({ ok: false });
    expect(normalizeEnvelope({ value: [] })).toMatchObject({ ok: false });
    expect(normalizeEnvelope({ ok: true, value: [] })).toEqual({ ok: true, value: [] });
  });
});

describe('只读面断言', () => {
  it('空数组是合法读数（空表不是错误）', () => {
    const [assertion] = checkListReading(READONLY_PROBES[0], { ok: true, value: [] });
    expect(assertion.ok).toBe(true);
    expect(assertion.detail).toContain('空表合法');
  });

  it('非数组算红，且点名实际形状', () => {
    const [assertion] = checkListReading(READONLY_PROBES[1], { ok: true, value: { items: [] } });
    expect(assertion.ok).toBe(false);
    expect(assertion.detail).toContain('不是数组');
  });

  it('只读报错算红，detail 带 code 与 message（不静默）', () => {
    const [assertion] = checkListReading(READONLY_PROBES[2], {
      ok: false,
      error: normalizeError({ code: 'LAUNCHER_INTERNAL', message: '目录不可读' }),
    });
    expect(assertion.ok).toBe(false);
    expect(assertion.detail).toContain('LAUNCHER_INTERNAL');
    expect(assertion.detail).toContain('目录不可读');
  });
});

describe('负向 · launcher_start 打不存在的实例', () => {
  it('正确的结构化错误 ⇒ 五条断言全过（含 code 期望值与无 panic）', () => {
    const assertions = checkStartMissingInstance({
      ok: false,
      error: normalizeError({ code: EXPECTED_CODES.startMissing, message: '找不到这个实例' }),
    });
    expect(assertions).toHaveLength(5);
    expect(pass(assertions)).toBe(true);
  });

  it('返回成功 ⇒ 红（没有假装启动成功）', () => {
    const assertions = checkStartMissingInstance({ ok: true, value: { state: 'running' } });
    expect(assertions).toHaveLength(1);
    expect(assertions[0].ok).toBe(false);
  });

  it('码不对 ⇒ 只有「期望值」那条红，其余仍过（读数可定位）', () => {
    const assertions = checkStartMissingInstance({
      ok: false,
      error: normalizeError({ code: 'LAUNCHER_INTERNAL', message: '内部错误' }),
    });
    expect(byId(assertions, 'negative-start:code')?.ok).toBe(true); // 有码（形态对）
    expect(byId(assertions, 'negative-start:code-expected')?.ok).toBe(false); // 但不是 INSTANCE_NOT_FOUND
    expect(byId(assertions, 'negative-start:no-panic')?.ok).toBe(true);
  });

  it('panic 文本 ⇒ no-panic 红（这是宿主崩了，不是参数错误）', () => {
    const assertions = checkStartMissingInstance({
      ok: false,
      error: normalizeError({ code: EXPECTED_CODES.startMissing, message: "thread 'main' panicked at src/launcher/process.rs:1" }),
    });
    expect(byId(assertions, 'negative-start:no-panic')?.ok).toBe(false);
  });

  it('非 Windows 上平台闸可先于查表 ⇒ PLATFORM_UNSUPPORTED 也算对', () => {
    const assertions = checkStartMissingInstance(
      {
        ok: false,
        error: normalizeError({ code: EXPECTED_CODES.platformUnsupported, message: '本平台暂不支持启动游戏' }),
      },
      { platform: 'linux' },
    );
    expect(pass(assertions)).toBe(true);
  });
});

describe('负向 · launcher_instance_create 缺 profile', () => {
  it('参数层拒收且点名 profile ⇒ 四条全过', () => {
    const assertions = checkCreateMissingProfile({
      ok: false,
      error: normalizeError('invalid args `profile` for command `launcher_instance_create`: missing required key profile'),
    });
    expect(assertions).toHaveLength(4);
    expect(pass(assertions)).toBe(true);
  });

  it('带业务码 ⇒ not-business-code 红（半截参数进了业务层才是真问题）', () => {
    const assertions = checkCreateMissingProfile({
      ok: false,
      error: normalizeError({ code: 'LAUNCHER_INTERNAL', message: 'missing required key profile' }),
    });
    expect(byId(assertions, 'negative-create:not-business-code')?.ok).toBe(false);
  });

  it('缺 profile 却创建成功 ⇒ 红', () => {
    const assertions = checkCreateMissingProfile({ ok: true, value: { instance: { id: 'x' } } });
    expect(assertions[0].ok).toBe(false);
  });
});

describe('隔离判据（真壳不许碰真 appData）', () => {
  it('shell + .smoke 身份 + 身份目录 ⇒ 通过', () => {
    const result = isIsolatedSession({
      mode: 'shell',
      identifier: 'dev.kojo.editor.smoke',
      appDataDir: 'C:\\Users\\x\\AppData\\Roaming\\dev.kojo.editor.smoke',
    });
    expect(result.ok).toBe(true);
  });

  it('web 调试宿会话 ⇒ 拒绝并说明 36 条命令只在真壳', () => {
    const result = isIsolatedSession({ mode: 'web', identifier: null, appDataDir: '' });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('真桌面壳');
  });

  it('没开 --isolate ⇒ 拒绝（原因点名 identifier）', () => {
    const result = isIsolatedSession({
      mode: 'shell',
      identifier: 'dev.kojo.editor',
      appDataDir: 'C:\\Users\\x\\AppData\\Roaming\\dev.kojo.editor',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('--isolate');
  });

  it('identifier 对但 app_data_dir 不在身份目录 ⇒ 拒绝', () => {
    const result = isIsolatedSession({
      mode: 'shell',
      identifier: 'dev.kojo.editor.smoke',
      appDataDir: 'C:\\Users\\x\\AppData\\Roaming\\dev.kojo.editor',
    });
    expect(result.ok).toBe(false);
  });
});

describe('只读副作用', () => {
  it('前后同长且无新增 id ⇒ 过', () => {
    const assertions = checkNoSideEffect([{ id: 'a' }], [{ id: 'a' }]);
    expect(pass(assertions)).toBe(true);
  });

  it('新增实例 ⇒ 红（只读不是口号）', () => {
    const assertions = checkNoSideEffect([], [{ id: 'gate-smoke' }]);
    expect(byId(assertions, 'side-effect:no-new-id')?.ok).toBe(false);
  });

  it('任一侧不是数组 ⇒ 红（读数丢了也不许绿）', () => {
    const assertions = checkNoSideEffect([], null);
    expect(assertions[0].ok).toBe(false);
  });
});

describe('断言分组 / 失败归类 / 读数行', () => {
  it('分组统计按 group 聚合，失败带 channel|contract|negative|side-effect 归类', () => {
    const tally = groupAssertions([
      { id: 'a', group: 'channel', ok: true, detail: '' },
      { id: 'b', group: 'readonly', ok: false, detail: 'x' },
      { id: 'c', group: 'negative-start', ok: true, detail: '' },
      { id: 'd', group: 'side-effect', ok: false, detail: 'y' },
      { id: 'e', group: 'unknown', ok: false, detail: 'z' },
    ]);
    expect(tally).toMatchObject({ total: 5, passed: 2, failed: 3 });
    expect(tally.groups.map((group) => `${group.group}:${group.passed}/${group.total}`)).toEqual([
      'channel:1/1',
      'readonly:0/1',
      'negative-start:1/1',
      'side-effect:0/1',
      'unknown:0/1',
    ]);
    expect(tally.failing.map((item) => item.bucket)).toEqual(['contract', 'side-effect', 'runner']);
    expect(classifyFailure({ group: 'negative-create' })).toBe('negative');
  });

  it('读数行含命令 / rc / 耗时 / 断言数，且能被 parseReadingLine 原样读回', () => {
    const tally = groupAssertions([{ id: 'a', group: 'channel', ok: true, detail: '' }]);
    const line = summarizeRun({
      command: 'node tools/launcher-smoke.mjs --start',
      rc: 0,
      elapsedMs: 12_345,
      tally,
      mode: 'shell',
      bootMs: 987,
    });
    expect(line).toContain('rc=0');
    expect(line).toContain('elapsed=12345ms');
    expect(line).toContain('assertions=1 passed=1 failed=0');
    expect(parseReadingLine(line)).toEqual({
      parsed: true,
      command: 'node tools/launcher-smoke.mjs --start',
      rc: 0,
      elapsedMs: 12345,
      assertions: 1,
      passed: 1,
      failed: 0,
      mode: 'shell',
      bootMs: 987,
    });
  });

  it('没有 boot 段也能解析；解析不了返回 parsed:false（不猜 0）', () => {
    const line = summarizeRun({ command: 'cmd', rc: 2, elapsedMs: 5, tally: { total: 0, passed: 0, failed: 0 }, mode: '?' });
    expect(parseReadingLine(line).bootMs).toBeNull();
    expect(parseReadingLine('随便一行')).toEqual({ parsed: false });
  });

  it('SKIP 行可解析出原因（release-gate 靠它把 rc=2 改判成 SKIP）', () => {
    expect(parseSkipLine('[launcher-smoke] SKIP reason=本工作树没有在跑的会话')).toBe('本工作树没有在跑的会话');
    expect(parseSkipLine('[launcher-smoke] cmd="x" rc=0')).toBeNull();
  });
});

/* ================================================================== *
 * L9 联调批：夹具实例（播种形状 / 路径推导 / 各断言组 / 清场）
 * ================================================================== */

describe('L9 · 夹具命名（token / 实例 id / 镜像名 / 标记串）', () => {
  it('token 只含小写字母数字：它要进实例 id、镜像名与标记串', () => {
    for (const now of [1_700_000_000_000, Date.now(), 0]) {
      const token = fixtureToken({ now, pid: 4321 });
      expect(token).toMatch(/^[a-z0-9]{1,10}$/);
    }
  });

  it('同一个 now + pid 得同一个 token；不同 pid 得不同 token（并发两轮不撞名）', () => {
    expect(fixtureToken({ now: 1_700_000_000_000, pid: 111 })).toBe(fixtureToken({ now: 1_700_000_000_000, pid: 111 }));
    expect(fixtureToken({ now: 1_700_000_000_000, pid: 111 })).not.toBe(fixtureToken({ now: 1_700_000_000_000, pid: 222 }));
  });

  it('实例 id 过宿主形状闸（ASCII 字母数字 + -，≤64）；两个夹具 id 互不相同', () => {
    for (const id of [TRUSTED_ID, UNTRUSTED_ID]) {
      expect(id).toMatch(/^[A-Za-z0-9-]{1,64}$/);
    }
    expect(TRUSTED_ID).not.toBe(UNTRUSTED_ID);
  });

  it('两个镜像名不同、都是 .exe、都以 token 命名（tasklist 按名过滤要全场唯一）', () => {
    expect(NAMES.exe).not.toBe(NAMES.childExe);
    expect(NAMES.exe.endsWith('.exe')).toBe(true);
    expect(NAMES.childExe.endsWith('.exe')).toBe(true);
    expect(NAMES.exe).toContain(TOKEN);
    expect(NAMES.childExe).toContain(TOKEN);
  });

  it('标记串带 token（夹具打印的那一行不会与别的轮次混淆），且含固定前缀', () => {
    expect(NAMES.marker.startsWith(FIXTURE_MARKER)).toBe(true);
    expect(NAMES.marker).toContain(TOKEN);
  });

  it('游戏根目录名带夹具前缀（cleanupPlan 的删除守卫认它）', () => {
    expect(NAMES.gameRootName.startsWith(FIXTURE_PREFIX)).toBe(true);
  });

  it('token 形状不对 ⇒ 抛错（不许拼出非法镜像名 / id）', () => {
    expect(() => fixtureNames('ABC!!')).toThrow(/token/);
    expect(() => fixtureNames('')).toThrow(/token/);
  });
});

describe('L9 · 夹具执行参数（十几秒、不弹窗、能证明孙进程）', () => {
  it('argv 首项是 /c，命令里同时有 echo 标记与孙进程调用', () => {
    const args = fixtureArgs(NAMES.childExe, NAMES.marker);
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('/c');
    expect(args[1]).toContain(`echo ${NAMES.marker}`);
    expect(args[1]).toContain(`${NAMES.childExe} /c for /l`);
  });

  it('延迟走 cmd 内置循环（不调外部程序、不碰网络：宿主起的 cmd 里 ping 实测会死在 DNS 上）', () => {
    const args = fixtureArgs(NAMES.childExe, NAMES.marker);
    expect(args[1]).toContain('do @rem');
    expect(args[1]).not.toMatch(/ping|curl|powershell|timeout /i);
    expect(FIXTURE_LOOP_COUNT).toBeGreaterThan(1_000_000);
  });

  it('参数是纯字符串数组（宿主 validate_argv 只吃字符串），且不含 NUL', () => {
    const args = fixtureArgs(NAMES.childExe, NAMES.marker);
    expect(args.every((arg) => typeof arg === 'string')).toBe(true);
    expect(args.join('')).not.toContain('\u0000');
  });

  it('孙进程不是 .exe / 标记串为空 ⇒ 抛错', () => {
    expect(() => fixtureArgs('child.cmd', 'm')).toThrow(/\.exe/);
    expect(() => fixtureArgs(NAMES.childExe, '')).toThrow(/标记串/);
  });
});

describe('L9 · 夹具落点推导（镜像 paths.rs 的 LauncherLayout）', () => {
  it('instance.json / running.lock / logs 全在 instances/<id>/ 之下', () => {
    const layout = fixtureLayout(APP_DATA, TRUSTED_ID);
    expect(layout.registryFile).toBe(`${APP_DATA}\\launcher\\registry.json`);
    expect(layout.instancesDir).toBe(`${APP_DATA}\\launcher\\instances`);
    expect(layout.instanceRoot).toBe(`${APP_DATA}\\launcher\\instances\\${TRUSTED_ID}`);
    expect(layout.manifestFile).toBe(`${layout.instanceRoot}\\instance.json`);
    expect(layout.lockFile).toBe(`${layout.instanceRoot}\\running.lock`);
    expect(layout.logsDir).toBe(`${layout.instanceRoot}\\logs`);
  });
});

describe('L9 · 播种 JSON 形状（对齐 store::StoredInstance / RegistryEntry）', () => {
  it('清单字段齐全、camelCase、state=ready / isolation=shared / trust=null', () => {
    const instance = fixtureInstance();
    expect(instance).toMatchObject({
      schemaVersion: 1,
      id: TRUSTED_ID,
      adapterId: 'launcher-smoke',
      gameId: 'launcher-smoke',
      sourceRoot: GAME_ROOT,
      isolation: 'shared',
      state: 'ready',
      executableTrust: null,
      launchCount: 0,
    });
    expect(Object.keys(instance).sort()).toEqual(
      [
        'adapterId',
        'contentRoots',
        'createdAt',
        'encoding',
        'executable',
        'executableTrust',
        'gameId',
        'id',
        'isolation',
        'lastExit',
        'lastLaunchedAt',
        'launchCount',
        'locale',
        'name',
        'notes',
        'runtimeId',
        'saveRoots',
        'schemaVersion',
        'sourceRoot',
        'state',
        'tags',
        'updatedAt',
      ].sort(),
    );
  });

  it('executable 四个字段 + sha256=null（哈希由宿主算，播种时不许自带）', () => {
    const instance = fixtureInstance();
    expect(instance.executable).toEqual({
      relativePath: NAMES.exe,
      args: fixtureArgs(NAMES.childExe, NAMES.marker),
      env: {},
      windowMode: FIXTURE_WINDOW_MODE,
      sha256: null,
    });
    expect(FIXTURE_WINDOW_MODE).toBe('hidden');
  });

  it('非法形状一律抛错（宁可在播种前挂，也不落一份宿主读不出的清单）', () => {
    expect(() => fixtureInstance({ id: '../escape' })).toThrow(/id 形状/);
    expect(() => fixtureInstance({ relativePath: 'run.bat' })).toThrow(/\.exe/);
    expect(() => fixtureInstance({ gameRoot: 'relative/game' })).toThrow(/绝对路径/);
    expect(() => fixtureInstance({ windowMode: 'popup' })).toThrow(/windowMode/);
    expect(() => fixtureInstance({ args: 'echo x' })).toThrow(/args/);
  });

  it('注册表索引条目只取七格（与 store::RegistryEntry 逐字同名）', () => {
    expect(instanceRegistryEntry(fixtureInstance())).toEqual({
      id: TRUSTED_ID,
      name: TRUSTED_ID,
      adapterId: 'launcher-smoke',
      gameId: 'launcher-smoke',
      isolation: 'shared',
      state: 'ready',
      updatedAt: '2026-10-26T00:00:00Z',
    });
  });

  it('注册表合并：保留别人的条目、替换同 id、rev 自增', () => {
    const existing = { schemaVersion: 1, rev: 7, instances: [{ id: 'other', name: 'x' }, { id: TRUSTED_ID, name: '旧' }] };
    const merged = mergeFixtureRegistry(existing, [
      { id: TRUSTED_ID, name: '新' },
      { id: UNTRUSTED_ID, name: 'u' },
    ]);
    expect(merged.ok).toBe(true);
    expect(merged.registry?.rev).toBe(8);
    expect(merged.registry?.schemaVersion).toBe(1);
    expect(merged.registry?.instances.map((entry: { id: string }) => entry.id)).toEqual(['other', TRUSTED_ID, UNTRUSTED_ID]);
    expect(merged.registry?.instances[1].name).toBe('新');
  });

  it('注册表不存在 ⇒ 按空表起步（首次运行是合法态）', () => {
    const merged = mergeFixtureRegistry(null, [{ id: TRUSTED_ID, name: 'n' }]);
    expect(merged.ok).toBe(true);
    expect(merged.registry).toMatchObject({ schemaVersion: 1, rev: 1 });
    expect(merged.registry?.instances).toHaveLength(1);
  });

  it('注册表形状不对 ⇒ fail-closed（不静默用空表覆盖别人的库）', () => {
    const broken = mergeFixtureRegistry({ instances: 'nope' }, [{ id: 'x' }]);
    expect(broken.ok).toBe(false);
    expect(broken.registry).toBeNull();
    expect(broken.reason).toContain('fail-closed');
  });

  it('摘条目：只摘夹具 id，别人的原样留着；原文件不存在时回 null（调用方据此删文件）', () => {
    const stripped = stripFixtureRegistry(
      { schemaVersion: 1, rev: 2, instances: [{ id: 'other' }, { id: TRUSTED_ID }, { id: UNTRUSTED_ID }] },
      [TRUSTED_ID, UNTRUSTED_ID],
    );
    expect(stripped.ok).toBe(true);
    expect(stripped.registry?.instances).toEqual([{ id: 'other' }]);
    expect(stripped.registry?.rev).toBe(3);
    expect(stripFixtureRegistry(null, [TRUSTED_ID]).registry).toBeNull();
    expect(stripFixtureRegistry({ instances: 3 }, [TRUSTED_ID]).ok).toBe(false);
  });
});

describe('L9 · 信任记录（哈希只搬宿主那份）', () => {
  it('写回四字段、summary 与 executable.sha256 同步、approvedBy 可辨认', () => {
    const instance = attachTrust(fixtureInstance(), { sha256: SHA, size: 339_968, approvedAt: '2026-10-26T00:00:01Z' });
    expect(instance.executableTrust).toEqual({
      sha256: SHA,
      size: 339_968,
      approvedAt: '2026-10-26T00:00:01Z',
      approvedBy: FIXTURE_APPROVED_BY,
    });
    expect(instance.executable.sha256).toBe(SHA);
    expect(FIXTURE_APPROVED_BY).not.toBe('native-dialog');
  });

  it('不改入参（播种的可重复性靠纯函数）', () => {
    const before = fixtureInstance();
    const snapshot = JSON.parse(JSON.stringify(before));
    attachTrust(before, { sha256: SHA, size: 10 });
    expect(before).toEqual(snapshot);
  });

  it('sha256 不是 64 位小写十六进制 / size 不是正整数 ⇒ 抛错（不许自己造哈希）', () => {
    expect(() => attachTrust(fixtureInstance(), { sha256: 'ABC', size: 10 })).toThrow(/sha256/);
    expect(() => attachTrust(fixtureInstance(), { sha256: SHA.toUpperCase(), size: 10 })).toThrow(/sha256/);
    expect(() => attachTrust(fixtureInstance(), { sha256: SHA, size: 0 })).toThrow(/size/);
  });
});

describe('L9 · 读数解析（tasklist / 日志块）', () => {
  it('tasklist CSV：只认引号行，无匹配提示行被跳过，千分位内存列不影响 pid', () => {
    const text = '"launcher-fixture.exe","48520","Console","1","7,900 K"\r\n信息: 没有运行的任务匹配指定标准。\r\n';
    expect(parseTasklistCsv(text)).toEqual([{ image: 'launcher-fixture.exe', pid: 48520 }]);
  });

  it('按镜像名过滤大小写不敏感；空表给空数组', () => {
    const rows = [{ image: 'L9FX-B.EXE', pid: 1 }, { image: 'other.exe', pid: 2 }];
    expect(rowsByImage(rows, 'l9fx-b.exe')).toEqual([{ image: 'L9FX-B.EXE', pid: 1 }]);
    expect(rowsByImage([], 'x.exe')).toEqual([]);
    expect(rowsByImage(null, 'x.exe')).toEqual([]);
  });

  it('日志块：base64 → 双解，ASCII 标记串在 GBK 字节流里也能逐字命中', () => {
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // 「中文」的 GBK 字节
    const chunk = Buffer.concat([Buffer.from('launcher-fixture-started abc\r\n'), gbk]);
    const text = logTextOf([{ stream: 'stdout', bytesBase64: chunk.toString('base64') }]);
    expect(text.streams).toEqual(['stdout']);
    expect(text.bytes).toBe(chunk.length);
    expect(text.latin1).toContain('launcher-fixture-started abc');
  });

  it('多块拼接、怪形状不炸（缺 bytesBase64 按空块）', () => {
    const text = logTextOf([
      { stream: 'stdout', bytesBase64: Buffer.from('a').toString('base64') },
      { stream: 'stderr', bytesBase64: Buffer.from('b').toString('base64') },
      { stream: 'stderr' },
    ]);
    expect(text.utf8).toBe('ab');
    expect(text.streams).toEqual(['stdout', 'stderr', 'stderr']);
  });
});

describe('L9 · 播种断言（fixture 组）', () => {
  const baseline = [{ id: 'existing' }];
  const seeded = [{ id: 'existing' }, { id: TRUSTED_ID }, { id: UNTRUSTED_ID }];

  it('两个夹具都进实例表且长度 +2 ⇒ 两条全过', () => {
    const assertions = checkFixtureSeeded({ baseline, afterSeed: seeded, ids: [TRUSTED_ID, UNTRUSTED_ID] });
    expect(assertions).toHaveLength(2);
    expect(pass(assertions)).toBe(true);
  });

  it('只进了一个 ⇒ seed-present 红；长度对得上时 count 仍绿（两件事分开读）', () => {
    const partial = checkFixtureSeeded({
      baseline,
      afterSeed: [{ id: 'existing' }, { id: TRUSTED_ID }, { id: 'someone-else' }],
      ids: [TRUSTED_ID, UNTRUSTED_ID],
    });
    expect(byId(partial, 'fixture:seed-present')?.ok).toBe(false);
    expect(byId(partial, 'fixture:seed-count')?.ok).toBe(true);
    // 少了一个 ⇒ 长度也不对，两条都红
    const short = checkFixtureSeeded({ baseline, afterSeed: [{ id: 'existing' }, { id: TRUSTED_ID }], ids: [TRUSTED_ID, UNTRUSTED_ID] });
    expect(byId(short, 'fixture:seed-count')?.ok).toBe(false);
  });

  it('读数不是数组 ⇒ 红（不猜成功）', () => {
    expect(pass(checkFixtureSeeded({ baseline: null, afterSeed: seeded, ids: [] }))).toBe(false);
  });

  it('第一次检视：exists / 宿主摘要 / 未信任三格一起读', () => {
    const assertions = checkManifestDigest({
      ok: true,
      value: {
        instance: { executableTrust: null },
        executable: { absolutePath: 'C:\\tmp\\x.exe', exists: true, sha256: SHA, trusted: false, changedSinceTrust: false },
      },
    });
    expect(assertions).toHaveLength(4);
    expect(pass(assertions)).toBe(true);
  });

  it('摘要缺失 / 已带信任 ⇒ 对应那条红', () => {
    const noDigest = checkManifestDigest({
      ok: true,
      value: { instance: { executableTrust: null }, executable: { absolutePath: 'x', exists: true, sha256: null, trusted: false } },
    });
    expect(byId(noDigest, 'fixture:digest-host')?.ok).toBe(false);
    const alreadyTrusted = checkManifestDigest({
      ok: true,
      value: {
        instance: { executableTrust: { sha256: SHA } },
        executable: { absolutePath: 'x', exists: true, sha256: SHA, trusted: true },
      },
    });
    expect(byId(alreadyTrusted, 'fixture:untrusted-before')?.ok).toBe(false);
  });

  it('检视本身失败 ⇒ 单条红，带 code / message（不静默）', () => {
    const assertions = checkManifestDigest({ ok: false, error: normalizeError({ code: 'LAUNCHER_INSTANCE_NOT_FOUND', message: '找不到这个实例' }) });
    expect(assertions).toHaveLength(1);
    expect(assertions[0].detail).toContain('LAUNCHER_INSTANCE_NOT_FOUND');
  });
});

describe('L9 · 信任断言（trust 组）', () => {
  const trustedEnvelope = {
    ok: true,
    value: {
      instance: { executableTrust: { sha256: SHA, approvedBy: FIXTURE_APPROVED_BY } },
      executable: { sha256: SHA, trusted: true, changedSinceTrust: false },
    },
  };

  it('宿主复检 trusted=true + approvedBy 是夹具值 ⇒ 四条全过', () => {
    const assertions = checkTrustSeeded(trustedEnvelope);
    expect(assertions).toHaveLength(4);
    expect(pass(assertions)).toBe(true);
  });

  it('approvedBy 冒充 native-dialog ⇒ 那条红（播种不许假装用户点过框）', () => {
    const assertions = checkTrustSeeded({
      ok: true,
      value: {
        instance: { executableTrust: { sha256: SHA, approvedBy: 'native-dialog' } },
        executable: { sha256: SHA, trusted: true, changedSinceTrust: false },
      },
    });
    expect(byId(assertions, 'trust:approved-by')?.ok).toBe(false);
  });

  it('宿主认账失败（trusted=false / changedSinceTrust=true）⇒ 对应红', () => {
    const assertions = checkTrustSeeded({
      ok: true,
      value: { instance: { executableTrust: { sha256: SHA, approvedBy: FIXTURE_APPROVED_BY } }, executable: { sha256: SHA, trusted: false, changedSinceTrust: true } },
    });
    expect(byId(assertions, 'trust:host-confirms')?.ok).toBe(false);
    expect(byId(assertions, 'trust:changed-flag')?.ok).toBe(false);
  });

  it('未信任夹具：TRUST_REQUIRED + retryable + 中文人话 ⇒ 五条全过', () => {
    const assertions = checkTrustRequired({
      ok: false,
      error: normalizeError({ code: 'LAUNCHER_TRUST_REQUIRED', message: '这个实例的可执行文件还没有信任记录，请先确认信任', retryable: true }),
    });
    expect(assertions).toHaveLength(5);
    expect(pass(assertions)).toBe(true);
    expect(assertions.every((entry) => entry.group === 'trust')).toBe(true);
  });

  it('码不对 / retryable 缺失 / 纯英文 message ⇒ 各自那条红', () => {
    const wrong = checkTrustRequired({ ok: false, error: normalizeError({ code: 'LAUNCHER_INTERNAL', message: '内部错误', retryable: false }) });
    expect(byId(wrong, 'trust-required:code')?.ok).toBe(false);
    expect(byId(wrong, 'trust-required:retryable')?.ok).toBe(false);
    const english = checkTrustRequired({ ok: false, error: normalizeError({ code: 'LAUNCHER_TRUST_REQUIRED', message: 'trust required', retryable: true }) });
    expect(byId(english, 'trust-required:message-human')?.ok).toBe(false);
    const noField = checkTrustRequired({ ok: false, error: normalizeError({ code: 'LAUNCHER_TRUST_REQUIRED', message: '还没信任' }) });
    expect(byId(noField, 'trust-required:retryable')?.ok).toBe(false);
  });

  it('未信任却启动成功 ⇒ 单条红（不假装没发生）', () => {
    const assertions = checkTrustRequired({ ok: true, value: { state: 'running', pid: 9 } });
    expect(assertions).toHaveLength(1);
    expect(assertions[0].ok).toBe(false);
  });

  it('拒绝之后进程表里不许有 running / 非空 pid', () => {
    expect(pass(checkNoRunAfterRefusal({ ok: true, value: [{ instanceId: UNTRUSTED_ID, state: 'idle', pid: null }] }, UNTRUSTED_ID))).toBe(true);
    expect(pass(checkNoRunAfterRefusal({ ok: true, value: [{ instanceId: UNTRUSTED_ID, state: 'running', pid: 7 }] }, UNTRUSTED_ID))).toBe(false);
    expect(pass(checkNoRunAfterRefusal({ ok: false, value: null }, UNTRUSTED_ID))).toBe(false);
  });
});

describe('L9 · 生命周期断言（lifecycle 组）', () => {
  const running = { ok: true, value: { instanceId: TRUSTED_ID, state: 'running', pid: 48520, sessionId: 's-1' } };
  const listed = [{ instanceId: TRUSTED_ID, state: 'running', pid: 48520 }];

  it('能起：running + pid + sessionId + 进程表同 pid ⇒ 五条全过', () => {
    const assertions = checkStartRunning(running, { instanceId: TRUSTED_ID, processList: listed });
    expect(assertions).toHaveLength(5);
    expect(pass(assertions)).toBe(true);
  });

  it('状态不是 running / pid 为 0 / 进程表没列它 ⇒ 对应那条红', () => {
    const notRunning = checkStartRunning({ ok: true, value: { state: 'idle', pid: 0, sessionId: '' } }, { instanceId: TRUSTED_ID, processList: [] });
    expect(byId(notRunning, 'lifecycle:start-state')?.ok).toBe(false);
    expect(byId(notRunning, 'lifecycle:start-pid')?.ok).toBe(false);
    expect(byId(notRunning, 'lifecycle:start-session')?.ok).toBe(false);
    expect(byId(notRunning, 'lifecycle:start-listed')?.ok).toBe(false);
  });

  it('启动失败 ⇒ 单条红带 code（不把错误当"没测"）', () => {
    const assertions = checkStartRunning({ ok: false, error: normalizeError({ code: 'LAUNCHER_EXECUTABLE_INVALID', message: '启动进程失败' }) }, { instanceId: TRUSTED_ID, processList: [] });
    expect(assertions).toHaveLength(1);
    expect(assertions[0].detail).toContain('LAUNCHER_EXECUTABLE_INVALID');
  });

  it('树起过：孙进程镜像名在 tasklist 且有本体 pid ⇒ 两条过；全空 ⇒ 两条红', () => {
    const alive = checkTreeAlive({ taskList: [{ image: NAMES.childExe, pid: 777 }, { image: NAMES.exe, pid: 48520 }], imageName: NAMES.childExe, pid: 48520 });
    expect(pass(alive)).toBe(true);
    const dead = checkTreeAlive({ taskList: [], imageName: NAMES.childExe, pid: 48520 });
    expect(pass(dead)).toBe(false);
  });

  it('能停：exited + pid 清空 + 无残留 + 锁已清 ⇒ 七条全过', () => {
    const assertions = checkStopClean({
      envelope: { ok: true, value: { instanceId: TRUSTED_ID, state: 'exited', pid: null, exitReason: 'killed', exitCode: 1279341902 } },
      pid: 48520,
      lockExists: false,
      taskList: [{ image: 'explorer.exe', pid: 12 }],
      imageName: NAMES.childExe,
    });
    expect(assertions).toHaveLength(7);
    expect(pass(assertions)).toBe(true);
  });

  it('孙进程残留 / 锁还在 / 状态不是 exited ⇒ 各自那条红', () => {
    const leftovers = checkStopClean({
      envelope: { ok: true, value: { state: 'stopping', pid: 48520, exitReason: null } },
      pid: 48520,
      lockExists: true,
      taskList: [{ image: NAMES.childExe, pid: 777 }, { image: NAMES.exe, pid: 48520 }],
      imageName: NAMES.childExe,
    });
    expect(byId(leftovers, 'lifecycle:stop-state')?.ok).toBe(false);
    expect(byId(leftovers, 'lifecycle:stop-pid-cleared')?.ok).toBe(false);
    expect(byId(leftovers, 'lifecycle:stop-pid-gone')?.ok).toBe(false);
    expect(byId(leftovers, 'lifecycle:stop-tree-gone')?.ok).toBe(false);
    expect(byId(leftovers, 'lifecycle:stop-lock-cleared')?.ok).toBe(false);
  });

  it('停止命令本身失败 ⇒ 那条红，但仍照读进程表（失败路径也要有读数）', () => {
    const assertions = checkStopClean({
      envelope: { ok: false, error: normalizeError({ code: 'LAUNCHER_INTERNAL', message: '结束进程树失败' }) },
      pid: 48520,
      lockExists: false,
      taskList: [{ image: 'other.exe', pid: 1 }],
      imageName: NAMES.childExe,
    });
    expect(byId(assertions, 'lifecycle:stop-ok')?.ok).toBe(false);
    expect(byId(assertions, 'lifecycle:stop-lock-cleared')?.ok).toBe(true);
  });
});

describe('L9 · 日志泵断言（logs 组）', () => {
  const session = { id: 'sess-1', instanceId: TRUSTED_ID, startedAt: '2026-10-26T00:00:00Z', endedAt: null, stdoutBytes: 0, stderrBytes: 0 };

  it('会话表里有本场会话且归属本实例 ⇒ 三条全过', () => {
    const assertions = checkLogSessions({ ok: true, value: [session] }, { sessionId: 'sess-1', instanceId: TRUSTED_ID });
    expect(assertions).toHaveLength(3);
    expect(pass(assertions)).toBe(true);
  });

  it('会话不在表里 / 归属别的实例 ⇒ 对应红', () => {
    const missing = checkLogSessions({ ok: true, value: [session] }, { sessionId: 'sess-2', instanceId: TRUSTED_ID });
    expect(byId(missing, 'logs:session-present')?.ok).toBe(false);
    const foreign = checkLogSessions({ ok: true, value: [{ ...session, instanceId: 'other' }] }, { sessionId: 'sess-1', instanceId: TRUSTED_ID });
    expect(byId(foreign, 'logs:session-instance')?.ok).toBe(false);
  });

  it('尾段含标记串 ⇒ 两条过；只有别的行 ⇒ marker 那条红', () => {
    const chunk = (text: string) => ({ stream: 'stdout', bytesBase64: Buffer.from(text).toString('base64') });
    expect(pass(checkLogContent({ tailEnvelope: { ok: true, value: { chunks: [chunk(`${NAMES.marker}\r\n`)] } }, marker: NAMES.marker }))).toBe(true);
    const noMarker = checkLogContent({ tailEnvelope: { ok: true, value: { chunks: [chunk('无关的输出')] } }, marker: NAMES.marker });
    expect(byId(noMarker, 'logs:chunks')?.ok).toBe(true);
    expect(byId(noMarker, 'logs:marker')?.ok).toBe(false);
  });

  it('尾段读失败 / 空块 ⇒ 红（空日志不算"有行"）', () => {
    expect(pass(checkLogContent({ tailEnvelope: { ok: false, error: normalizeError({ code: 'LAUNCHER_INSTANCE_NOT_FOUND', message: '没有运行日志' }) }, marker: 'x' }))).toBe(false);
    expect(pass(checkLogContent({ tailEnvelope: { ok: true, value: { chunks: [] } }, marker: 'x' }))).toBe(false);
  });

  it('收尾后有 endedAt 与 stdoutBytes>0 ⇒ 两条过；还在跑（endedAt 空 / 0 字节）⇒ 红', () => {
    const done = checkLogPumpFinished({ ok: true, value: [{ ...session, endedAt: '2026-10-26T00:00:10Z', stdoutBytes: 512 }] }, { sessionId: 'sess-1' });
    expect(pass(done)).toBe(true);
    const running = checkLogPumpFinished({ ok: true, value: [session] }, { sessionId: 'sess-1' });
    expect(pass(running)).toBe(false);
  });
});

describe('L9 · 平台不支持的读数口径', () => {
  it('Windows：进程闸不可达 ⇒ verdict=skip 且原因点名"不伪造"', () => {
    const reading = platformUnsupportedReading({ platform: 'win32' });
    expect(reading.verdict).toBe('skip');
    expect(reading.reason).toContain('不可达');
    expect(reading.reason).toContain('不伪造');
  });

  it('非 Windows：真打进程闸（verdict=check）', () => {
    expect(platformUnsupportedReading({ platform: 'linux' })).toEqual({ verdict: 'check', reason: null });
  });

  it('夹具批次只在 Windows 跑（cmd.exe 复制 + Job 杀树），其它平台 SKIP 并说明', () => {
    expect(platformFixturePlan({ platform: 'win32' })).toEqual({ run: true, skipReason: null });
    const darwin = platformFixturePlan({ platform: 'darwin' });
    expect(darwin.run).toBe(false);
    expect(darwin.skipReason).toContain('Windows');
  });

  it('PLATFORM_UNSUPPORTED 报文形状：码 + 中文 message + retryable 字段在 ⇒ 四条过', () => {
    const ok = checkPlatformErrorShape({
      ok: false,
      error: normalizeError({ code: EXPECTED_CODES.platformUnsupported, message: '覆盖层实例当前平台不支持', retryable: false }),
    });
    expect(ok).toHaveLength(4);
    expect(pass(ok)).toBe(true);
  });

  it('纯英文 message / retryable 缺失 / 码不对 ⇒ 各自那条红', () => {
    const english = checkPlatformErrorShape({ ok: false, error: normalizeError({ code: EXPECTED_CODES.platformUnsupported, message: 'unsupported', retryable: false }) });
    expect(byId(english, 'platform-shape:message-human')?.ok).toBe(false);
    const noField = checkPlatformErrorShape({ ok: false, error: normalizeError({ code: EXPECTED_CODES.platformUnsupported, message: '不支持' }) });
    expect(byId(noField, 'platform-shape:retryable-field')?.ok).toBe(false);
    const wrongCode = checkPlatformErrorShape({ ok: false, error: normalizeError({ code: 'LAUNCHER_INTERNAL', message: '不支持', retryable: false }) });
    expect(byId(wrongCode, 'platform-shape:code')?.ok).toBe(false);
  });
});

describe('L9 · 清场（cleanup 组）', () => {
  const ids = [TRUSTED_ID, UNTRUSTED_ID];
  // 临时根本机而定 ⇒ 显式传入（`tmpRoot` 是注入点：判据只认"在不在这个根之下"）
  const TMP_ROOT = 'C:\\Users\\probe\\AppData\\Local\\Temp';

  it('清单 = 两个实例目录 + 临时游戏根，全部在允许根内', () => {
    const plan = cleanupPlan({ appDataDir: APP_DATA, instanceIds: ids, gameRoot: GAME_ROOT, tmpRoot: TMP_ROOT });
    expect(plan.ok).toBe(true);
    expect(plan.kept).toBe(false);
    expect(plan.targets).toEqual([
      { kind: 'instance', path: `${APP_DATA}\\launcher\\instances\\${TRUSTED_ID}` },
      { kind: 'instance', path: `${APP_DATA}\\launcher\\instances\\${UNTRUSTED_ID}` },
      { kind: 'game-root', path: GAME_ROOT },
    ]);
  });

  it('--keep ⇒ 一条都不删（保留现场排查）', () => {
    const plan = cleanupPlan({ appDataDir: APP_DATA, instanceIds: ids, gameRoot: GAME_ROOT, keep: true, tmpRoot: TMP_ROOT });
    expect(plan.ok).toBe(true);
    expect(plan.kept).toBe(true);
    expect(plan.targets).toEqual([]);
    expect(plan.reason).toContain('--keep');
  });

  it('游戏根不在临时目录内 ⇒ 拒绝删除（真游戏盘一个字节都不碰）', () => {
    const plan = cleanupPlan({ appDataDir: APP_DATA, instanceIds: ids, gameRoot: 'D:\\Game\\eratw', tmpRoot: TMP_ROOT });
    expect(plan.ok).toBe(false);
    expect(plan.targets).toEqual([]);
    expect(plan.reason).toContain('拒绝删除');
  });

  it('游戏根名不带夹具前缀 ⇒ 拒绝删除（临时目录里别人的东西也不碰）', () => {
    const plan = cleanupPlan({ appDataDir: APP_DATA, instanceIds: ids, gameRoot: 'C:\\Users\\probe\\AppData\\Local\\Temp\\someone-else', tmpRoot: TMP_ROOT });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('夹具前缀');
  });

  it('实例 id 里带逃逸段 ⇒ 路径不在 instances 之下，拒绝删除', () => {
    const plan = cleanupPlan({ appDataDir: APP_DATA, instanceIds: ['..\\..\\Windows'], gameRoot: null });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('instances');
  });

  it('盘上证据：存在 ⇒ 红；不存在 ⇒ 绿；清单为空 ⇒ 红（没有可证明的东西）', () => {
    const targets = [{ kind: 'instance', path: 'C:\\x\\y' }];
    expect(pass(checkDiskGone({ targets, exists: () => false }))).toBe(true);
    expect(pass(checkDiskGone({ targets, exists: () => true }))).toBe(false);
    expect(pass(checkDiskGone({ targets: [], exists: () => false }))).toBe(false);
  });

  it('实例表回到播种前：长度相等且无夹具 id ⇒ 两条过', () => {
    const assertions = checkCleanup({ baseline: [{ id: 'existing' }], after: [{ id: 'existing' }], ids });
    expect(assertions).toHaveLength(2);
    expect(pass(assertions)).toBe(true);
  });

  it('长度没回 / 夹具 id 还在 ⇒ 各自那条红', () => {
    const leftovers = checkCleanup({ baseline: [{ id: 'existing' }], after: [{ id: 'existing' }, { id: TRUSTED_ID }], ids });
    expect(byId(leftovers, 'cleanup:count')?.ok).toBe(false);
    expect(byId(leftovers, 'cleanup:no-fixture')?.ok).toBe(false);
    expect(pass(checkCleanup({ baseline: [], after: null, ids }))).toBe(false);
  });
});

describe('L9 · 失败归类与错误载荷', () => {
  it('新增六组各自归到自己那一桶（不落到 runner）', () => {
    for (const group of ['fixture', 'trust', 'lifecycle', 'logs', 'platform', 'cleanup']) {
      expect(classifyFailure({ group })).toBe(group);
    }
    expect(classifyFailure({ group: 'unknown' })).toBe('runner');
  });

  it('页内 catch 带上 detail / retryable（只有页内取得到结构化载荷）', () => {
    const expr = buildInvokeExpression('launcher_start', { instanceId: 'x' });
    expect(expr).toContain('retryable');
    expect(expr).toContain('detail');
  });

  it('normalizeError 透传 retryable 与 detail；缺字段记 null（不猜 false）', () => {
    const full = normalizeError({ code: 'LAUNCHER_TRUST_REQUIRED', message: 'm', retryable: true, detail: 'd' });
    expect(full).toMatchObject({ retryable: true, detail: 'd' });
    const sparse = normalizeError({ code: 'LAUNCHER_TRUST_REQUIRED', message: 'm' });
    expect(sparse).toMatchObject({ retryable: null, detail: null });
  });

  it('SKIP 条目形状（group/id/reason）与断言分桶互不干扰', () => {
    const tally = groupAssertions([
      { id: 'lifecycle:start-state', group: 'lifecycle', ok: true, detail: '' },
      { id: 'cleanup:count', group: 'cleanup', ok: false, detail: '' },
    ]);
    expect(tally).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(tally.failing.map((item) => item.bucket)).toEqual(['cleanup']);
  });
});
