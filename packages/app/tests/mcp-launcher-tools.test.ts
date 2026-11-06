/**
 * MCP 启动器族具名工具（B4 批，LaneS 2026-11-06）的腿级与 registry 级回归。
 *
 * 全程假注入（假 `kernel.launcherHost` / 假 kernel），不起 GUI、不起 Tauri、不起 HTTP。
 * 钉的是这批的五条判据：
 * 1. **不静默**（铁律 4）：启动器面缺席 ⇒ 每一枚显式 `NOT_WIRED` 带理由，绝不空数组冒充
 *    「没有实例」；宿主结构化拒绝（`code` + `message` + `retryable` + `detail`）原样进错误消息；
 * 2. **形状照宿主真形**：`launcher_save_list` 的 `{entries,roots,warnings}`、
 *    `launcher_content_diagnose` 多报的 `orphan-file` / `load-order`、日志页的原始 base64 块；
 * 3. **分页复用 B1 面**：`limit` + `cursor` + 全套账（并集==全集、越界游标显式报错、
 *    快照变化 `changedDuringPaging`），且页大小 clamp 到本面已有的上限、日志字节闸**收紧**；
 * 4. **授权面零放宽**：写落点参数一个都不收（`launcher_save_backup` 没有目标路径、
 *    `launcher_instance_update` 不收 executable/args/env、`launcher_instance_remove` 必须显式
 *    `deleteFiles`）；独占文件清单由宿主读数现算，不收模型编的清单；
 * 5. **档位真源一致**：27 枚都是 privileged，registry 侧未精确批准 ⇒ `PERMISSION_DENIED`，
 *    精确名批准 ⇒ 放行；刻意不登记的那一族逐条给判性理由（不是「没做」）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  KERNEL_IO_TOOL_SPECS,
  MCP_TOOL_GAP_MAP,
  McpFailure,
  SEMANTIC_TOOL_SPECS,
  SUPPLEMENTAL_TOOL_SPECS,
  createMcpCapabilityRegistry,
  type McpSessionScope,
} from '@kojo/mcp-host';
import { createRunSupplemental, type McpIoDeps, type McpKernelLike } from '../src/mcp/real-sources-io';
import {
  MAX_LOG_PAGE_BYTES,
  createLauncherLegs,
  type McpLauncherHostLike,
} from '../src/mcp/real-sources-launcher';

/* ------------------------------- 名单（与本批登记逐字对拍） ------------------------------- */

const READ_TOOLS = [
  'launcher_instance_list',
  'launcher_instance_get',
  'launcher_content_list',
  'launcher_content_diagnose',
  'launcher_process_list',
  'launcher_process_status',
  'launcher_task_list',
  'launcher_save_list',
  'launcher_save_backups',
  'launcher_log_sessions',
  'launcher_log_tail',
  'launcher_log_read',
  'launcher_project_hash',
] as const;

const WRITE_TOOLS = [
  'launcher_instance_update',
  'launcher_instance_duplicate',
  'launcher_instance_remove',
  'launcher_content_apply',
  'launcher_content_set_enabled',
  'launcher_content_set_order',
  'launcher_content_uninstall',
  'launcher_start',
  'launcher_stop',
  'launcher_task_cancel',
  'launcher_save_backup',
  'launcher_save_restore',
  'launcher_save_delete_backup',
  'launcher_save_apply_import',
] as const;

const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS] as const;

/** 刻意不登记（C 组）：误调必须拿到带判性理由的 NOT_WIRED，绝不静默成功。 */
const NEVER_REGISTERED = [
  'launcher_pick_archive',
  'launcher_pick_source_root',
  'launcher_pick_write_root',
  'launcher_trust_executable',
  'launcher_instance_open_folder',
  'launcher_log_export',
  'launcher_save_export',
  'launcher_content_plan',
  'launcher_save_import',
  'launcher_project_extract',
  'launcher_instance_create',
  'launcher_runtime_list',
  'market_fetch_text',
] as const;

/* ------------------------------- 假件 ------------------------------- */

const scope = (over: Partial<McpSessionScope> = {}): McpSessionScope => ({
  sessionId: 'b4-s1',
  clientId: 'b4-c1',
  tier: 'privileged',
  approvedRoots: [],
  approvedTools: [],
  ...over,
});

type HostSpec = Record<string, (...args: never[]) => unknown>;

/** 假启动器宿主面：记录每一次调用（方法名 + 实参），供「桥零调用 / 参数逐字」断言。 */
function fakeLauncher(spec: HostSpec = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const host: Record<string, unknown> = {};
  for (const [method, impl] of Object.entries(spec)) {
    host[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return (impl as (...a: unknown[]) => unknown)(...args);
    };
  }
  return { host: host as unknown as McpLauncherHostLike, calls };
}

function emptyKernel(): McpKernelLike {
  return {
    project: { current: () => null },
    io: { walkDir: async () => [] },
    plugins: { list: () => [] },
    services: { tryGet: <T = unknown>(_k: string): T | undefined => undefined },
    bus: { on: (_n: string, _c: (p: unknown) => void) => () => {} },
    slots: { query: () => [] },
  };
}

/** 腿调用器：走真实分派入口（`createRunSupplemental`），含 ioTools 腿表与 NOT_WIRED 兜底。 */
function legs(host: unknown) {
  const deps: McpIoDeps = {
    getKernel: () => emptyKernel(),
    getCommands: () => [],
    invoke: async () => null,
    searchInFiles: async () => {
      throw new Error('unused');
    },
    getLauncher: () => (host === null ? null : (host as McpLauncherHostLike)),
  };
  return createRunSupplemental(deps);
}

async function call(
  host: unknown,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return (await legs(host)(name, args, scope())) as Record<string, unknown>;
}

async function expectFailure(
  host: unknown,
  name: string,
  args: Record<string, unknown>,
  code: string,
): Promise<string> {
  let caught: unknown;
  try {
    await call(host, name, args);
  } catch (err) {
    caught = err;
  }
  expect(caught, `${name} 必须显式失败（不静默）`).toBeInstanceOf(McpFailure);
  const failure = caught as McpFailure;
  expect(failure.code, `${name} 错误码`).toBe(code);
  return failure.message;
}

/* ------------------------------- 1 · 档位与名单一致 ------------------------------- */

describe('登记面与档位真源一致', () => {
  const catalog = [...SEMANTIC_TOOL_SPECS, ...KERNEL_IO_TOOL_SPECS, ...SUPPLEMENTAL_TOOL_SPECS];

  it('27 枚全部登记为 privileged，且命名保持 launcher_ 下划线前缀形态', () => {
    expect(ALL_TOOLS.length).toBe(27);
    expect(new Set(ALL_TOOLS).size).toBe(27);
    for (const name of ALL_TOOLS) {
      const spec = SUPPLEMENTAL_TOOL_SPECS.find((t) => t.name === name);
      expect(spec, `${name} 应进 SUPPLEMENTAL_TOOL_SPECS`).toBeDefined();
      expect(spec!.tier, `${name} 档位`).toBe('privileged');
      expect(name.startsWith('launcher_'), `${name} 必须保持 launcher_ 前缀形态`).toBe(true);
      expect(name.includes('.')).toBe(false);
    }
  });

  it('只读 13 枚带 readOnlyHint，写/生命周期 14 枚不带（档位口径不许漂）', () => {
    for (const name of READ_TOOLS) {
      const spec = SUPPLEMENTAL_TOOL_SPECS.find((t) => t.name === name)!;
      expect(spec.annotations?.readOnlyHint, `${name} 只读位`).toBe(true);
    }
    for (const name of WRITE_TOOLS) {
      const spec = SUPPLEMENTAL_TOOL_SPECS.find((t) => t.name === name)!;
      expect(spec.annotations?.readOnlyHint, `${name} 不得自称只读`).not.toBe(true);
    }
  });

  it('C 组一枚都不在工具目录 / 覆盖登记 / 腿表里（缺席必须走判性留账）', () => {
    for (const name of NEVER_REGISTERED) {
      expect(catalog.some((t) => t.name === name), `${name} 不得登记`).toBe(false);
      expect(MCP_TOOL_GAP_MAP.some((w) => w.tool === name), `${name} 不得进覆盖登记`).toBe(false);
      expect(Object.keys(createLauncherLegs({ getKernel: () => emptyKernel() }))).not.toContain(name);
    }
  });

  it('判性留账非空：未登记的 launcher_* 缺口逐条写在 MCP_DEFERRED_GAP_NOTES 口径里', async () => {
    for (const name of NEVER_REGISTERED.filter((n) => n.startsWith('launcher_'))) {
      const message = await expectFailure(fakeLauncher({}).host, name, {}, 'NOT_WIRED');
      expect(message).toContain('刻意没有登记成模型可调用工具');
      expect(message).toContain('MCP_DEFERRED_GAP_NOTES');
    }
  });
});

/* ------------------------------- 2 · 不静默 ------------------------------- */

describe('启动器面缺席与宿主拒绝（铁律 4）', () => {
  it('launcherHost 缺席 ⇒ 27 枚逐条 NOT_WIRED，绝不空数组冒充读数', async () => {
    for (const name of ALL_TOOLS) {
      const args = name === 'launcher_log_read' ? { sessionId: 's-1' } : { instanceId: 'inst-1' };
      const message = await expectFailure(null, name, args, 'NOT_WIRED');
      expect(message).toContain('启动器面未接线');
      expect(message).toContain('不返回空列表');
    }
  });

  it('老宿主缺这条 P1 命令 ⇒ 显式 NOT_WIRED 并点名是哪条方法', async () => {
    const host = fakeLauncher({ instanceList: async () => [] });
    const message = await expectFailure(host.host, 'launcher_content_list', { instanceId: 'inst-1' }, 'NOT_WIRED');
    expect(message).toContain('contentList');
    // 缺席的方法从未被调（桥零调用），也不是「调了才发现没有」——缺席在腿里就先出声。
    expect(host.calls).toHaveLength(0);
  });

  it('宿主结构化拒绝原样透出：code / retryable / detail 一个不丢', async () => {
    const host = fakeLauncher({
      instanceInspect: async () => {
        throw {
          code: 'INSTANCE_NOT_FOUND',
          message: '实例不存在（宿主中文原句）',
          detail: 'inst-9',
          retryable: false,
        };
      },
    });
    const message = await expectFailure(
      host.host,
      'launcher_instance_get',
      { instanceId: 'inst-9' },
      'TOOL_EXECUTION_FAILED',
    );
    expect(message).toContain('code=INSTANCE_NOT_FOUND');
    expect(message).toContain('retryable=false');
    expect(message).toContain('detail=inst-9');
    expect(message).toContain('实例不存在（宿主中文原句）');
  });

  it('宿主回包形状与契约不符 ⇒ 显式失败，不静默降级成空列表', async () => {
    const host = fakeLauncher({ instanceList: async () => ({ notAnArray: true }) });
    await expectFailure(host.host, 'launcher_instance_list', {}, 'TOOL_EXECUTION_FAILED');
  });
});

/* ------------------------------- 3 · 形状照宿主真形 ------------------------------- */

describe('宿主真形逐条可见', () => {
  it('launcher_save_list 回 {entries,roots,warnings}，roots[].approved 是写回门禁读数', async () => {
    const host = fakeLauncher({
      saveList: async () => ({
        entries: [{ rootId: 'r1', path: 'slot1.sav', name: 'S1', bytes: 10, mtimeMs: 1 }],
        roots: [{ rootId: 'r1', approved: false, exists: true }],
        warnings: ['共享实例未授权'],
      }),
    });
    const r = await call(host.host, 'launcher_save_list', { instanceId: 'inst-1' });
    expect(r['entries']).toHaveLength(1);
    expect(r['roots']).toEqual([{ rootId: 'r1', approved: false, exists: true }]);
    expect(r['warnings']).toEqual(['共享实例未授权']);
    expect(String(r['rootsNote'])).toContain('第三张表');
    expect(String(r['rootsNote'])).toContain('原生目录对话框');
    expect(r['total']).toBe(1);
    expect(r['hasMore']).toBe(false);
  });

  it('launcher_content_diagnose 的 orphan-file / load-order 原样透传（不折码、不藏）', async () => {
    const host = fakeLauncher({
      contentDiagnose: async () => ({
        instanceId: 'inst-1',
        issues: [
          { packId: 'p1', code: 'orphan-file', path: 'data/a.erb', message: '孤儿文件' },
          { packId: 'p2', code: 'load-order', message: '顺序异常' },
        ],
      }),
    });
    const r = await call(host.host, 'launcher_content_diagnose', { instanceId: 'inst-1' });
    const codes = (r['issues'] as Record<string, unknown>[]).map((i) => i['code']);
    expect(codes).toEqual(['orphan-file', 'load-order']);
    expect(String(r['codeNote'])).toContain('orphan-file');
  });

  it('launcher_instance_get / launcher_process_status 原样透传宿主对象（不抄第二份改名表）', async () => {
    const inspection = {
      instance: { id: 'inst-1', isolation: 'shared', sourceRoot: null },
      executable: { relativePath: 'game.exe', sha256: 'ab', approvedAt: '2026-11-06' },
      runtime: null,
      paths: { root: 'D:/x' },
      diskUsageBytes: 42,
      warnings: [],
    };
    const host = fakeLauncher({ instanceInspect: async () => inspection });
    const r = await call(host.host, 'launcher_instance_get', { instanceId: 'inst-1' });
    expect(r).toEqual(inspection);
    expect(host.calls[0]!.args).toEqual(['inst-1']);
  });
});

/* ------------------------------- 4 · 分页复用 B1 面 ------------------------------- */

describe('分页游标复用 B1 面（上限一个没放宽）', () => {
  const instances = Array.from({ length: 450 }, (_, i) => ({ id: `inst-${i}`, name: `I${i}` }));

  it('逐页取满 ⇒ 并集与全集同序同长，无重无漏', async () => {
    const host = fakeLauncher({ instanceList: async () => instances });
    const flat: string[] = [];
    let args: Record<string, unknown> = { limit: 37 };
    for (let i = 0; i < 100; i += 1) {
      const r = await call(host.host, 'launcher_instance_list', args);
      flat.push(...(r['instances'] as Record<string, unknown>[]).map((x) => String(x['id'])));
      if (r['hasMore'] !== true) {
        expect(r['nextCursor']).toBeNull();
        break;
      }
      args = { limit: 37, cursor: r['nextCursor'] };
    }
    expect(flat).toEqual(instances.map((x) => x.id));
    expect(new Set(flat).size).toBe(450);
  });

  it('limit 传天大也只到本面已有上限 200（不放宽）', async () => {
    const host = fakeLauncher({ instanceList: async () => instances });
    const r = await call(host.host, 'launcher_instance_list', { limit: 5_000_000 });
    expect((r['instances'] as unknown[]).length).toBe(200);
    expect(r['total']).toBe(450);
  });

  it('游标形状非法 / 下标越界 ⇒ 显式 INVALID_ARGS，绝不回第一页冒充连续', async () => {
    const host = fakeLauncher({ instanceList: async () => instances });
    await expectFailure(host.host, 'launcher_instance_list', { cursor: 'not-a-cursor' }, 'INVALID_ARGS');
    const first = await call(host.host, 'launcher_instance_list', { limit: 5 });
    const tampered = `${String(first['fingerprint'])}:99999`;
    await expectFailure(host.host, 'launcher_instance_list', { limit: 5, cursor: tampered }, 'INVALID_ARGS');
  });

  it('翻页期间实例表变了 ⇒ changedDuringPaging 出声并回到第 0 页', async () => {
    let list = instances.slice(0, 200);
    const host = fakeLauncher({ instanceList: async () => list });
    const first = await call(host.host, 'launcher_instance_list', { limit: 50 });
    list = [...list, { id: 'inst-new', name: 'N' }];
    const next = await call(host.host, 'launcher_instance_list', {
      limit: 50,
      cursor: first['nextCursor'],
    });
    expect(next['changedDuringPaging']).toBe(true);
    expect(next['offset']).toBe(0);
    expect(next['total']).toBe(201);
  });

  it('日志页：maxBytes 压在 40 KiB 之下（宿主默认 1 MiB，本面主动收紧）且原始块不解码', async () => {
    const host = fakeLauncher({
      logTail: async (_instanceId: string, query: Record<string, unknown>) => {
        expect(Number(query['maxBytes'])).toBeLessThanOrEqual(MAX_LOG_PAGE_BYTES);
        return {
          session: { id: 'sess-1', instanceId: 'inst-1' },
          truncated: true,
          chunks: [
            { stream: 'stdout', ts: 1, bytesBase64: Buffer.from('hello').toString('base64'), truncated: false },
            { stream: 'stderr', ts: 2, bytesBase64: Buffer.from('boom').toString('base64'), truncated: true },
          ],
        };
      },
    });
    const r = await call(host.host, 'launcher_log_tail', { instanceId: 'inst-1', maxBytes: 9_999_999 });
    const chunks = r['chunks'] as Record<string, unknown>[];
    expect(chunks.map((c) => c['bytesBase64'])).toEqual(['aGVsbG8=', 'Ym9vbQ==']);
    expect(chunks.map((c) => c['byteLength'])).toEqual([5, 4]);
    expect(r['truncatedByBytes']).toBe(true);
    // 块级账（B1 面）与宿主的字节截断读数是两件事：2 块都在本页 ⇒ 账说 truncated:false。
    expect(r['truncated']).toBe(false);
    expect(r['hasMore']).toBe(false);
    expect(String(r['decodeNote'])).toContain('不猜编码');
    expect(String(r['hostTruncatedNote'])).toContain('maxBytes');
    expect(r['total']).toBe(2);
    expect(host.calls[0]!.args[1]).toMatchObject({ maxBytes: MAX_LOG_PAGE_BYTES });
  });

  it('launcher_log_read 按 sessionId 寻址（宿主侧归属复验仍在）', async () => {
    const host = fakeLauncher({
      logRead: async () => ({ session: { id: 'sess-9' }, chunks: [], truncated: false }),
    });
    const r = await call(host.host, 'launcher_log_read', { sessionId: 'sess-9' });
    expect(host.calls[0]!.args[0]).toBe('sess-9');
    expect(r['total']).toBe(0);
    expect(r['hasMore']).toBe(false);
  });
});

/* ------------------------------- 5 · 授权面零放宽 ------------------------------- */

describe('授权面与参数收窄（铁律 6/7：多一个入口，不多一条权限）', () => {
  it('launcher_save_backup 不收任何写落点：载荷只有 label / reason / entries', async () => {
    const host = fakeLauncher({
      saveBackup: async () => ({
        id: 'task-1',
        kind: 'save-backup',
        state: 'succeeded',
        cancellable: false,
        result: { backupId: 'bk-7' },
      }),
    });
    const r = await call(host.host, 'launcher_save_backup', {
      instanceId: 'inst-1',
      label: '批前备份',
      reason: 'manual',
      outputPath: 'D:/escape/here.zip',
    });
    const req = host.calls[0]!.args[1] as Record<string, unknown>;
    expect(Object.keys(req).sort()).toEqual(['label', 'reason']);
    expect(r['backupId']).toBe('bk-7');
    expect(r['taskRowId']).toBe('task-1');
    expect(r['queryFace']).toBe('launcher_task_list');
    expect(r['cancelFace']).toBe('launcher_task_cancel');
  });

  it('reason 白名单不收 auto（宿主内部策略位）', async () => {
    const host = fakeLauncher({ saveBackup: async () => ({ id: 't' }) });
    await expectFailure(host.host, 'launcher_save_backup', { instanceId: 'i1', reason: 'auto' }, 'INVALID_ARGS');
  });

  it('launcher_instance_update 不收 executable / args / env：只收描述性字段', async () => {
    const host = fakeLauncher({
      instanceUpdate: async (_id: string, patch: Record<string, unknown>) => ({ id: _id, ...patch }),
    });
    const r = await call(host.host, 'launcher_instance_update', {
      instanceId: 'inst-1',
      name: '新名字',
      tags: ['a'],
      executableRelativePath: 'evil.exe',
      args: ['--x'],
      env: { PATH: 'D:/tmp' },
    });
    expect(host.calls[0]!.args[1]).toEqual({ name: '新名字', tags: ['a'] });
    expect(r['name']).toBe('新名字');
  });

  it('只给被收窄掉的字段 ⇒ INVALID_ARGS（不静默改成空补丁）', async () => {
    const host = fakeLauncher({ instanceUpdate: async () => ({ id: 'inst-1' }) });
    const message = await expectFailure(
      host.host,
      'launcher_instance_update',
      { instanceId: 'inst-1', args: ['--x'] },
      'INVALID_ARGS',
    );
    expect(message).toContain('跑什么');
  });

  it('launcher_instance_remove 必须显式 deleteFiles（不猜默认值）', async () => {
    const host = fakeLauncher({ instanceRemove: async () => undefined });
    await expectFailure(host.host, 'launcher_instance_remove', { instanceId: 'inst-1' }, 'INVALID_ARGS');
    await call(host.host, 'launcher_instance_remove', { instanceId: 'inst-1', deleteFiles: false });
    expect(host.calls.map((c) => c.args)).toEqual([
      ['inst-1', { deleteFiles: false, keepBackups: null }],
    ]);
  });

  it('launcher_content_uninstall 的独占清单由宿主读数现算，不收模型写的文件表', async () => {
    const host = fakeLauncher({
      contentList: async () => [
        { manifest: { id: 'p1' }, ownedFiles: [{ rootId: 'r1', path: 'a' }, { rootId: 'r1', path: 'shared' }] },
        { manifest: { id: 'p2' }, ownedFiles: [{ rootId: 'r1', path: 'shared' }] },
      ],
      contentUninstall: async (_i: string, _p: string, files: unknown) => ({
        id: 'task-2',
        state: 'running',
        cancellable: true,
        files,
      }),
    });
    const r = await call(host.host, 'launcher_content_uninstall', {
      instanceId: 'inst-1',
      packId: 'p1',
      files: [{ rootId: 'r1', path: 'whatever-the-model-invents' }],
    });
    expect(host.calls[1]!.args[2]).toEqual([{ rootId: 'r1', path: 'a' }]);
    expect(r['ownedFileCount']).toBe(2);
    expect(r['exclusiveFileCount']).toBe(1);
    expect(r['sharedFileCount']).toBe(1);
    expect(r['taskCancellable']).toBe(true);
    expect(String(r['filesBasis'])).toContain('ownership');
  });

  it('卸载未安装的包 ⇒ RESOURCE_UNAVAILABLE（不猜包、不空删）', async () => {
    const host = fakeLauncher({ contentList: async () => [] });
    await expectFailure(host.host, 'launcher_content_uninstall', { instanceId: 'inst-1', packId: 'ghost' }, 'RESOURCE_UNAVAILABLE');
    expect(host.calls).toHaveLength(1);
  });

  it('冲突裁决只认三键形状：非法 action ⇒ INVALID_ARGS，未给则显式 null', async () => {
    const host = fakeLauncher({ contentApply: async () => ({ id: 'task-3', state: 'queued' }) });
    await expectFailure(
      host.host,
      'launcher_content_apply',
      { planId: 'plan-1', resolutions: [{ rootId: 'r1', path: 'a', action: 'force' }] },
      'INVALID_ARGS',
    );
    await call(host.host, 'launcher_content_apply', { planId: 'plan-1' });
    expect(host.calls[0]!.args).toEqual(['plan-1', null]);
  });

  it('launcher_task_cancel 保持独立任务面（不并入 kojo://tasks）', async () => {
    const host = fakeLauncher({ taskCancel: async () => undefined });
    const r = await call(host.host, 'launcher_task_cancel', { taskId: 'task-1' });
    expect(r['cancelledTaskId']).toBe('task-1');
    expect(r['resultKind']).toBe('void');
    expect(String(r['label'])).toBe('launcher_task_cancel');
    const listed = fakeLauncher({
      taskList: async () => [{ id: 'task-1', state: 'cancelled', cancellable: false }],
    });
    const l = await call(listed.host, 'launcher_task_list', {});
    expect(String(l['faceNote'])).toContain('kojo://tasks');
  });

  it('id 形状与宿主同尺：非法 instanceId 不进桥（fail-closed 在腿里也来一道）', async () => {
    const host = fakeLauncher({ instanceInspect: async () => ({}) });
    for (const bad of ['../etc', 'C:/x', 'a b', 'inst_1', 'x'.repeat(65)]) {
      await expectFailure(host.host, 'launcher_instance_get', { instanceId: bad }, 'INVALID_ARGS');
    }
    expect(host.calls).toHaveLength(0);
  });

  it('launcher_project_hash 的 entries 只收相对路径，绝对路径整批拒绝', async () => {
    const host = fakeLauncher({ projectHash: async () => [] });
    const message = await expectFailure(
      host.host,
      'launcher_project_hash',
      { projectDir: 'D:/proj', artifactDir: 'dist', entries: ['C:/Windows/x.dll'] },
      'INVALID_ARGS',
    );
    expect(message).toContain('entries[0]');
    await expectFailure(
      host.host,
      'launcher_project_hash',
      { projectDir: 'D:/proj', artifactDir: 'dist', entries: [] },
      'INVALID_ARGS',
    );
    expect(host.calls).toHaveLength(0);
  });

  it('launcher_start / launcher_stop 回包必带信任闸与 force 读数（不冒充人做的决定）', async () => {
    const host = fakeLauncher({
      start: async () => ({ instanceId: 'inst-1', state: 'running', pid: 42 }),
      stop: async () => ({ instanceId: 'inst-1', state: 'exited', exitCode: 0 }),
    });
    const started = await call(host.host, 'launcher_start', { instanceId: 'inst-1' });
    expect(String(started['lifecycleNote'])).toContain('launcher_trust_executable');
    const stopped = await call(host.host, 'launcher_stop', { instanceId: 'inst-1', force: true, timeoutMs: 5000 });
    expect(stopped['forceRequested']).toBe(true);
    expect(host.calls[1]!.args[1]).toEqual({ force: true, timeoutMs: 5000 });
    await expectFailure(host.host, 'launcher_stop', { instanceId: 'inst-1', timeoutMs: 999_999 }, 'INVALID_ARGS');
  });
});

/* ------------------------------- 6 · registry 侧档位 ------------------------------- */

describe('registry 侧：privileged 未批准 ⇒ PERMISSION_DENIED，精确批准 ⇒ 放行', () => {
  const host = fakeLauncher({ instanceList: async () => [{ id: 'inst-1' }] });
  const deps = {
    runSupplemental: legs(host.host),
  };
  const registry = createMcpCapabilityRegistry(deps);

  it('未批准的会话（哪怕 tier=privileged）看不见这一族，猜名直调被显式拒绝', async () => {
    const priv = scope({ tier: 'privileged', approvedTools: [] });
    expect(registry.listTools(priv).map((t) => t.name)).not.toContain('launcher_instance_list');
    await expect(
      registry.callTool('launcher_instance_list', {}, priv),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(host.calls).toHaveLength(0);
    // 通配不构成批准（与端点同判据）。
    await expect(
      registry.callTool('launcher_instance_list', {}, scope({ approvedTools: ['launcher_*'] })),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(host.calls).toHaveLength(0);
  });

  it('精确名批准后可见且执行（走的就是同一条腿）', async () => {
    const approved = scope({ tier: 'privileged', approvedTools: ['launcher_instance_list'] });
    expect(registry.listTools(approved).map((t) => t.name)).toContain('launcher_instance_list');
    const r = (await registry.callTool('launcher_instance_list', {}, approved)) as Record<string, unknown>;
    expect(r['total']).toBe(1);
    expect(host.calls).toHaveLength(1);
  });

  it('入参形状由契约 schema 先挡一道：缺 instanceId ⇒ INVALID_ARGS（桥零调用）', async () => {
    const approved = scope({ tier: 'privileged', approvedTools: ['launcher_instance_get'] });
    const spy = vi.fn();
    const guarded = fakeLauncher({ instanceInspect: spy });
    const reg = createMcpCapabilityRegistry({ runSupplemental: legs(guarded.host) });
    await expect(
      reg.callTool('launcher_instance_get', {}, approved),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(spy).not.toHaveBeenCalled();
  });
});
