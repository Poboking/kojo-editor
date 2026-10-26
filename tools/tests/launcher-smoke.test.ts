/**
 * `tools/launcher-smoke.mjs` 的纯函数护栏（车道 GATE，2026-10-26）。
 *
 * 这个工具是「启动器判据在真壳里的插入点」，它自己的判定逻辑必须在无壳环境下就能被钉住：
 * 读数解析、断言分组、失败归类三件事一旦漂了，真壳上跑出来的红绿都不作数。
 * 壳相关的部分（CDP / 启动 / 隔离）**不在这里**测——它们按「通道可用才跑、否则 SKIP 并说明」
 * 的口径在脚本里如实报 rc=2，测试不假装绿。
 */
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_CODES,
  READONLY_PROBES,
  buildInvokeExpression,
  checkCreateMissingProfile,
  checkListReading,
  checkNoSideEffect,
  checkStartMissingInstance,
  classifyFailure,
  groupAssertions,
  isIsolatedSession,
  normalizeEnvelope,
  normalizeError,
  parseReadingLine,
  parseSkipLine,
  summarizeRun,
} from '../launcher-smoke.mjs';

const pass = (assertions: { id: string; ok: boolean }[]) => assertions.every((entry) => entry.ok);
const byId = (assertions: { id: string }[], id: string) => assertions.find((entry) => entry.id === id);

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
