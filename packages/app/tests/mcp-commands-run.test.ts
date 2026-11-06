/**
 * B24 · 命令面板过 MCP —— 具名工具 `commands.run` 的判据（组长逐条复验的七条硬判据）。
 *
 * 背景（为什么这一批值得做）：`commands.list` 早已把命令面板的清单摊给模型看，
 * `wiring.ts::projectCommands` 也早已把带 `run` 的投影接好（缺 `EditorCommandContext`
 * 抛结构化 `NOT_WIRED`），但**没有任何一具面把那条 `run` 接出去**——今天模型只能读、
 * 不能「用编辑器」。本批＝加一具名工具 `commands.run`，并把逐命令的档位判定与安全闸配齐。
 *
 * 七条硬判据（编号与车道简报同尺）：
 *  ① 档位来自命令表自身且 fail-closed：按被点名命令的 `CommandEntry.tier` 走
 *     （read⇒只读会话可跑 / edit⇒既有 Edit 档判定 / privileged⇒第四张表精确命令 id），
 *     **`tier` 缺席一律按 privileged**（「未标注就当只读放行」就是后门）。
 *  ② 工具自身档＝privileged，且**同批**进 `APPROVABLE_PRIVILEGED_TOOLS` ＋ Rust
 *     `PRIVILEGED_EXACT`（在册新名没进档位真源表＝后门；这里用源码锚机械证明）。
 *  ③ 危险类默认拒：分类台账现场从命令表枚举（不手抄），非「纯 UI/只读」且未被逐条点名
 *     放行 ⇒ 显式拒绝并点名「哪一类、为什么」，且**零副作用**（拒在调用之前）。
 *  ④ 回读＝事实：跑完必须摊出可观察事实（命中 / 启用 / 事件旁听 / 文档读数 / 脏态），
 *     绝不 `{ok:true}` 式静默成功；命令不存在 / 上下文缺席 ⇒ 显式失败并交代查了什么。
 *  ⑤ 入参严格化照 B11 口径：出厂即 `additionalProperties:false`、`commandId` 必填、
 *     命令自带 `argsSchema` 时按它校验并点名是哪枚命令要求的。
 *  ⑥ 分页/体积不放宽：`commands.list` 的 200 缺省 / 500 硬顶一字不动。
 *  ⑦ 审计：跑与拒都要有可查的一条账，且带命令 id（读台账仍只经既有宿主命令入口）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as MCP from '@kojo/mcp-host';
import {
  KERNEL_IO_TOOL_SPECS,
  McpFailure,
  SEMANTIC_TOOL_SPECS,
  SUPPLEMENTAL_TOOL_SPECS,
  createMcpCapabilityRegistry,
  isMcpFailure,
  type McpCommandSource,
  type McpHostDeps,
  type McpSessionScope,
  type McpTier,
} from '@kojo/mcp-host';
// 本批**新增**的契约符号：改前一律不存在（先红的落点就在这里——逐例报「不是函数 / 未在册」，
// 而不是整只文件在装载期一起崩，读不出哪条判据拦住了什么）。
const COMMAND_RUN_RELEASE_ALLOWLIST = MCP.COMMAND_RUN_RELEASE_ALLOWLIST;
const classifyCommandEffect = MCP.classifyCommandEffect;
const commandEffectLedger = MCP.commandEffectLedger;
const decideCommandRunGate = MCP.decideCommandRunGate;
type McpCommandEffectClass = MCP.McpCommandEffectClass;
import type { CommandEntry } from '../src/ui/commands';
import {
  createRunSupplemental,
  type McpCommandRunAccess,
  type McpCommandRunFacts,
  type McpIoDeps,
} from '../src/mcp/real-sources-io';
import { APPROVABLE_PRIVILEGED_TOOLS } from '../src/mcp/approval-ui';
import { buildRealMcpSources, type McpRealSourceHost } from '../src/mcp/real-sources';
import type { McpSearchResultLike } from '../src/mcp/real-sources-io';

const TOOL = 'commands.run';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

/* ------------------------------- 会话形状 ------------------------------- */

function scope(tier: McpSessionScope['tier'], approvedTools: readonly string[] = []): McpSessionScope {
  return { sessionId: 'b24-s', clientId: 'b24-c', tier, approvedRoots: [], approvedTools };
}

/** ②「缺省未批准的会话 tools/list 里不许出现它」＋「点名批准才出现」。 */
const specNames = [...SEMANTIC_TOOL_SPECS, ...KERNEL_IO_TOOL_SPECS, ...SUPPLEMENTAL_TOOL_SPECS].map(
  (s) => s.name,
);

/* ------------------------------- 假事实读数（回读用） ------------------------------- */

function facts(over: Partial<McpCommandRunFacts> = {}): McpCommandRunFacts {
  return {
    eventCount: 0,
    lastEventT: null,
    eventTail: [],
    document: null,
    documentReason: '没有活动编辑器（如实缺席，不空对象冒充）',
    dirtyPanes: null,
    dirtyReason: '编辑器登记簿读不到（如实缺席）',
    ...over,
  };
}

/* ------------------------------- 假命令面 ------------------------------- */

/** 一枚「纯 UI 状态」形状的只读面板动作（`layout.` 命名空间＝台账里的纯视图类）。 */
const VIEW_ID = 'layout.toggleSidebar';

type AccessFixture = Required<McpCommandRunAccess> & { runSpy: ReturnType<typeof vi.fn> };

function accessOf(
  entries: readonly CommandEntry[],
  opts: {
    execute?: (id: string, args: Record<string, unknown>) => unknown;
    enabled?: (id: string) => boolean | null;
    facts?: () => McpCommandRunFacts;
  } = {},
): AccessFixture {
  const runSpy = vi.fn(opts.execute ?? (() => undefined));
  return {
    entries: () => entries,
    execute: runSpy,
    enabled: opts.enabled ?? (() => null),
    facts: opts.facts ?? (() => facts()),
    // 记账暴露给断言用（零副作用那条判据要看这一枚：execute 是否被调）。
    runSpy,
  };
}

function entry(over: Partial<CommandEntry> & { id: string }): CommandEntry {
  return { title: over.id, run: () => undefined, ...over } as CommandEntry;
}

/** 历史别名：spy 记账型夹具（断言「execute 从未被调」用）。 */
type AccessWithSpy = AccessFixture;

function ioDeps(over: Partial<McpIoDeps> = {}): McpIoDeps {
  return {
    getKernel: () => null,
    getCommands: () => [],
    invoke: async () => null,
    searchInFiles: async (): Promise<McpSearchResultLike> => ({
      files: [],
      totalMatches: 0,
      truncated: false,
      filesScanned: 0,
      elapsedMs: 0,
      skipped: {},
    }),
    ...over,
  };
}

const NO_SEARCH = async (): Promise<McpSearchResultLike> => ({
  files: [],
  totalMatches: 0,
  truncated: false,
  filesScanned: 0,
  elapsedMs: 0,
  skipped: {},
});

/* ======================================================================= *
 * ②「在册 + 同批进档位真源」——工具形状与三张表的同步
 * ======================================================================= */

describe('B24 判据 ② · commands.run 在册即 privileged，且同批进两张档位真源', () => {
  it('SUPPLEMENTAL_TOOL_SPECS 里在册，tier=privileged，且没有 readOnlyHint', () => {
    const spec = SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === TOOL);
    expect(spec, `${TOOL} 必须登记成具名工具`).toBeDefined();
    expect(spec!.tier).toBe('privileged');
    expect(spec!.annotations?.readOnlyHint, '这一枚会执行动作，不许标 readOnly').not.toBe(true);
  });

  it('出厂即严格化：additionalProperties:false + commandId 必填（B11 口径）', () => {
    const spec = SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === TOOL)!;
    const schema = spec.inputSchema as Record<string, unknown>;
    expect(schema['additionalProperties']).toBe(false);
    expect(schema['required']).toContain('commandId');
    const props = schema['properties'] as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['args', 'commandId']);
    // 不新增分页面 ⇒ 这一枚不挂 cursor / limit（B1 的 25 枚分页面口径零变化）。
    expect(props['cursor']).toBeUndefined();
    expect(props['limit']).toBeUndefined();
  });

  it('未批准的会话 tools/list 不出现它；精确点名批准才出现（registry 侧）', () => {
    const registry = createMcpCapabilityRegistry({});
    expect(registry.listTools(scope('read')).map((t) => t.name)).not.toContain(TOOL);
    expect(registry.listTools(scope('edit')).map((t) => t.name)).not.toContain(TOOL);
    expect(registry.listTools(scope('privileged')).map((t) => t.name)).not.toContain(TOOL);
    expect(
      registry.listTools(scope('privileged', [TOOL])).map((t) => t.name),
    ).toContain(TOOL);
  });

  it('同批进第四张表的可批准名单（APPROVABLE_PRIVILEGED_TOOLS）', () => {
    expect(APPROVABLE_PRIVILEGED_TOOLS).toContain(TOOL);
  });

  it('同批进 Rust 档位真源 PRIVILEGED_EXACT（源码锚机械证明，不靠注释）', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'packages/app/src-tauri/src/mcp/protocol.rs'),
      'utf8',
    );
    const at = src.indexOf('pub const PRIVILEGED_EXACT');
    expect(at, 'Rust PRIVILEGED_EXACT 锚不存在').toBeGreaterThanOrEqual(0);
    const open = src.indexOf('&[', at);
    const close = src.indexOf('];', open);
    const list = [...src.slice(open + 2, close).matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    expect(list, `${TOOL} 没进 Rust 侧 privileged 真源 ⇒ 端点按 read 放行＝后门`).toContain(TOOL);
  });

  it('三张契约表的 privileged 名集 == 面板可批准名集（防「批了也批不动」复发）', () => {
    const privileged = [...SEMANTIC_TOOL_SPECS, ...KERNEL_IO_TOOL_SPECS, ...SUPPLEMENTAL_TOOL_SPECS]
      .filter((s) => s.tier === 'privileged')
      .map((s) => s.name)
      .sort();
    expect(privileged).toEqual([...APPROVABLE_PRIVILEGED_TOOLS].sort());
  });
});

/* ======================================================================= *
 * ① 档位来自命令表自身、fail-closed
 * ======================================================================= */

describe('B24 判据 ① · 逐命令档位判定（纯函数 + 端到端两条路）', () => {
  it('纯函数：read⇒任意会话 / edit⇒会话至少 edit / privileged⇒第四张表精确命令 id', () => {
    const read = decideCommandRunGate({
      commandId: VIEW_ID,
      declaredTier: 'read',
      scope: scope('read', [TOOL]),
    });
    expect(read.allowed, JSON.stringify(read)).toBe(true);

    const editCmdInReadSession = decideCommandRunGate({
      commandId: VIEW_ID,
      declaredTier: 'edit',
      scope: scope('read', [TOOL]),
    });
    expect(editCmdInReadSession.allowed).toBe(false);
    expect(editCmdInReadSession.code).toBe('PERMISSION_DENIED');

    const editCmdInEditSession = decideCommandRunGate({
      commandId: VIEW_ID,
      declaredTier: 'edit',
      scope: scope('edit', [TOOL]),
    });
    expect(editCmdInEditSession.allowed, JSON.stringify(editCmdInEditSession)).toBe(true);

    const privCmd = decideCommandRunGate({
      commandId: VIEW_ID,
      declaredTier: 'privileged',
      scope: scope('privileged', [TOOL]),
    });
    expect(privCmd.allowed, 'privileged 命令未点名精确 id 却放行＝后门').toBe(false);
    const privApproved = decideCommandRunGate({
      commandId: VIEW_ID,
      declaredTier: 'privileged',
      scope: scope('privileged', [TOOL, VIEW_ID]),
    });
    expect(privApproved.allowed, JSON.stringify(privApproved)).toBe(true);
  });

  it('tier 缺席 ⇒ 一律按 privileged 处理（绝不「未标注就当只读放行」）', () => {
    const undecided = decideCommandRunGate({ commandId: VIEW_ID, scope: scope('read', [TOOL]) });
    expect(undecided.requiredTier).toBe('privileged');
    expect(undecided.allowed).toBe(false);
    expect(undecided.reason, '拒绝理由必须交代「tier 缺席按 privileged」').toMatch(/tier/i);
  });

  it('端到端：无 tier 命令在只读 / Edit 会话都跑不动，批准精确 id 后能跑', async () => {
    const calls: string[] = [];
    const access = accessOf([entry({ id: VIEW_ID })], {
      execute: (id) => void calls.push(id),
    }) as AccessFixture;
    const sup = createRunSupplemental(ioDeps({ commandRun: access }));

    for (const s of [scope('read', [TOOL]), scope('edit', [TOOL]), scope('privileged', [TOOL])]) {
      const err = await sup(TOOL, { commandId: VIEW_ID }, s).then(
        (v) => ({ ok: true, v }),
        (e) => ({ ok: false, e }),
      );
      expect(err.ok, `${s.tier} 会话竟跑动了无 tier 命令`).toBe(false);
      const failure = (err as { e: unknown }).e;
      expect(isMcpFailure(failure), '必须是结构化失败').toBe(true);
      expect((failure as McpFailure).code).toBe('PERMISSION_DENIED');
      expect(access.runSpy).not.toHaveBeenCalled();
    }

    const approved = scope('privileged', [TOOL, VIEW_ID]);
    await expect(sup(TOOL, { commandId: VIEW_ID }, approved)).resolves.toMatchObject({
      commandId: VIEW_ID,
      ran: true,
    });
    expect(calls).toEqual([VIEW_ID]);
  });

  it('端到端：自报 read 的命令在只读会话可跑（档位真的来自命令表）', async () => {
    const access = accessOf([entry({ id: VIEW_ID, tier: 'read', run: () => undefined })]);
    const sup = createRunSupplemental(ioDeps({ commandRun: access }));
    await expect(sup(TOOL, { commandId: VIEW_ID }, scope('read', [TOOL]))).resolves.toMatchObject({
      ran: true,
      declaredTier: 'read',
    });
  });

  it('端到端：自报 edit 的命令需要会话至少 Edit 档', async () => {
    const access = accessOf([entry({ id: VIEW_ID, tier: 'edit', run: () => undefined })]);
    const sup = createRunSupplemental(ioDeps({ commandRun: access }));
    await expect(sup(TOOL, { commandId: VIEW_ID }, scope('read', [TOOL]))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(sup(TOOL, { commandId: VIEW_ID }, scope('edit', [TOOL]))).resolves.toMatchObject({
      ran: true,
    });
  });

  it('命令自报的宽松 tier 不许把危险类买通（档位判定与效果分类是两道独立的闸）', () => {
    const gate = decideCommandRunGate({
      commandId: 'workbench.saveAll',
      declaredTier: 'read',
      scope: scope('privileged', [TOOL, 'workbench.saveAll']),
    });
    expect(gate.allowed, '自报 read 的写盘动作照旧默认拒').toBe(false);
    expect(gate.effectClass).toBe('write');
  });
});

/* ======================================================================= *
 * ③ 分类台账 + 危险类默认拒 + 零副作用
 * ======================================================================= */

describe('B24 判据 ③ · 效果分类台账（现场枚举，不手抄）', () => {
  it('分类函数对七类各给得出稳定读数，且未知形状 fail-closed 到 unclassified', () => {
    const cases: readonly [string, McpCommandEffectClass][] = [
      [VIEW_ID, 'ui-state'],
      ['layout.reset', 'ui-state'],
      ['editor.fontZoomIn', 'ui-state'],
      ['workbench.saveAll', 'write'],
      ['editor.action.formatDocument', 'write'],
      ['editor.action.replace', 'write'],
      ['bookmarks.toggle', 'write'],
      ['workbench.saveAs', 'dialog'],
      ['workbench.legacyRename', 'dialog'],
      ['workbench.openProjectFolder', 'external'],
      ['workbench.showFileInOsExplorer', 'external'],
      ['workbench.checkUpdates', 'network'],
      ['market_fetch_text', 'network'],
      ['workbench.closeProject', 'lifecycle'],
      ['launcher.openInstances', 'lifecycle'],
      ['workbench.snapshotInjector', 'unclassified'],
      ['totally.unknown.shape', 'unclassified'],
    ];
    for (const [id, want] of cases) {
      expect(classifyCommandEffect(id), `${id} 应判 ${want}`).toBe(want);
    }
  });

  it('台账现场枚举真命令表（node tools/mcp-inventory.mjs 的 commandIds）：一枚不漏、一类不多', () => {
    const raw = execFileSync('node', ['tools/mcp-inventory.mjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const ids: string[] = (JSON.parse(raw) as { commandIds: string[] }).commandIds;
    expect(ids.length, '命令表枚数规模自证（不是拿空表跑出来的绿）').toBeGreaterThan(40);
    const ledger = commandEffectLedger(ids);
    expect(ledger.total).toBe(ids.length);
    const counted = Object.values(ledger.byClass).reduce((n, list) => n + list.length, 0);
    expect(counted).toBe(ids.length);
    // 纯 UI 类里不许混进任何一条危险形状（分类器自洽）。
    for (const id of ledger.byClass['ui-state']) {
      expect(id).not.toMatch(/save|rename|remove|delete|export|replace|format|Updates|Project/i);
    }
    if (process.env['B24_LEDGER'] === '1') {
      // eslint-disable-next-line no-console
      console.log('B24 LEDGER', JSON.stringify(ledger.counts), JSON.stringify(ledger.byClass));
    }
  });

  it('默认拒的覆盖面＝全部非 ui-state 类；逐条点名放行名单当前为空（诚实剩余）', () => {
    expect(COMMAND_RUN_RELEASE_ALLOWLIST).toEqual([]);
    const raw = execFileSync('node', ['tools/mcp-inventory.mjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const ids: string[] = (JSON.parse(raw) as { commandIds: string[] }).commandIds;
    const rejected = ids.filter(
      (id) =>
        classifyCommandEffect(id) !== 'ui-state' && !COMMAND_RUN_RELEASE_ALLOWLIST.includes(id),
    );
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.length).toBe(ids.length - commandEffectLedger(ids).counts['ui-state']);
  });

  it('危险类命令：显式拒绝 + 理由点名「哪一类、为什么」+ 零副作用（execute 从未被调）', async () => {
    const seen: string[] = [];
    const access = accessOf(
      [
        entry({ id: 'workbench.saveAll', run: () => void seen.push('disk') }),
        entry({ id: 'workbench.saveAs', run: () => void seen.push('dialog') }),
        entry({ id: 'workbench.checkUpdates', run: () => void seen.push('network') }),
        entry({ id: 'workbench.closeProject', run: () => void seen.push('lifecycle') }),
        entry({ id: 'workbench.snapshotInjector', run: () => void seen.push('unknown') }),
      ],
      { execute: (id) => void seen.push(id) },
    ) as AccessWithSpy;
    const sup = createRunSupplemental(ioDeps({ commandRun: access }));
    const approved = scope('privileged', [TOOL, 'workbench.saveAll', 'workbench.saveAs', 'workbench.checkUpdates', 'workbench.closeProject', 'workbench.snapshotInjector']);
    for (const id of ['workbench.saveAll', 'workbench.saveAs', 'workbench.checkUpdates', 'workbench.closeProject', 'workbench.snapshotInjector']) {
      const err = await sup(TOOL, { commandId: id }, approved).then(
        () => null,
        (e: unknown) => e,
      );
      expect(isMcpFailure(err), `${id} 必须显式拒绝`).toBe(true);
      const failure = err as McpFailure;
      expect(failure.code).toBe('PERMISSION_DENIED');
      expect(failure.message, `${id} 的拒绝理由要点名命令 id`).toContain(id);
      expect(failure.message, `${id} 的拒绝理由要点名类别`).toMatch(
        /write|dialog|network|lifecycle|unclassified/,
      );
    }
    expect(access.runSpy, '拒绝必须发生在调用之前 ⇒ 零副作用').not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('逐条点名放行的口子存在但当前没人用（加名字就必须带类别与理由，不许静默放宽）', () => {
    const gate = decideCommandRunGate({
      commandId: 'workbench.saveAll',
      scope: scope('privileged', [TOOL, 'workbench.saveAll']),
      allowlist: ['workbench.saveAll'],
    });
    // 放行只解除「效果类默认拒」这一道；档位判定照旧按命令表（无 tier ⇒ privileged）。
    expect(gate.effectClass).toBe('write');
    expect(gate.blockedBy).not.toBe('effect-class');
    expect(gate.allowed).toBe(true);
  });
});

/* ======================================================================= *
 * ④ 回读＝事实
 * ======================================================================= */

describe('B24 判据 ④ · 回执是事实，不是「跑完了」', () => {
  it('跑通一条纯 UI 命令：摊出 id / 命中 / 启用 / 事件旁听 / 文档读数 / 脏态，且不回 {ok:true}', async () => {
    let n = 0;
    const access = accessOf([entry({ id: VIEW_ID, tier: 'read', run: () => undefined })], {
      enabled: () => true,
      facts: () => ({
        ...facts(),
        eventCount: n,
        lastEventT: n,
        eventTail: n === 0 ? [] : [{ t: n, name: 'file.changed', payload: { path: 'a.erb' } }],
        document: { path: 'src/a.erb', language: 'erb', lineCount: 10 + n, versionId: 3 + n },
        dirtyPanes: [{ paneId: 'p1', path: 'src/a.erb', dirty: n > 0 }],
      }),
    });
    // 执行前后各读一次 ⇒ 用计数器制造两次不同的读数。
    const sup = createRunSupplemental(
      ioDeps({
        commandRun: {
          ...access,
          facts: () => {
            const f = access.facts();
            n += 1;
            return f;
          },
        },
      }),
    );
    const out = (await sup(TOOL, { commandId: VIEW_ID }, scope('read', [TOOL]))) as Record<string, unknown>;
    expect(out['commandId']).toBe(VIEW_ID);
    expect(out['matched']).toBe(true);
    expect(out['enabled']).toBe(true);
    expect(out['ran']).toBe(true);
    expect(out['effectClass']).toBe('ui-state');
    expect(out['declaredTier']).toBe('read');
    // fire-and-forget 必须诚实标注，不许把「派发」说成「确认」。
    expect(out['fireAndForget']).toBe(true);
    expect(out['confirmed'], '没有 ack 就不许出现 confirmed:true').not.toBe(true);
    expect(out['ok'], '绝不回 {ok:true} 式静默成功').toBeUndefined();
    const factsOut = out['facts'] as Record<string, unknown>;
    const before = factsOut['before'] as Record<string, unknown>;
    const after = factsOut['after'] as Record<string, unknown>;
    expect(Number(after['eventCount'])).toBeGreaterThan(Number(before['eventCount']));
    expect(factsOut['documentChanged']).toBe(true);
    expect((after['document'] as Record<string, unknown>)['lineCount']).toBe(11);
  });

  it('命令不存在 ⇒ RESOURCE_UNAVAILABLE，并交代查了什么（查过命令表几条）', async () => {
    const access = accessOf([entry({ id: VIEW_ID })]) as AccessWithSpy;
    const sup = createRunSupplemental(ioDeps({ commandRun: access }));
    const err = await sup(TOOL, { commandId: 'layout.nope' }, scope('privileged', [TOOL])).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isMcpFailure(err)).toBe(true);
    expect((err as McpFailure).code).toBe('RESOURCE_UNAVAILABLE');
    expect((err as McpFailure).message).toContain('layout.nope');
    expect((err as McpFailure).message, '要交代查了几条 / 指回 commands.list').toContain('commands.list');
    expect((err as McpFailure).message).toContain('现场查过 1 条');
    expect(access.runSpy).not.toHaveBeenCalled();
  });

  it('上下文缺席 ⇒ NOT_WIRED（走 wiring 那条真源 run，不伪造 ctx）', async () => {
    let ran = false;
    const cmd = entry({ id: VIEW_ID, tier: 'read', run: () => void (ran = true) });
    const host = {
      getCommands: () => [cmd],
      // 生产宿主一定会给 ctx；这里刻意给 undefined，验腿不自己编一份。
      getCommandContext: () => undefined,
      getKernel: () => null,
    } as unknown as McpRealSourceHost;
    const sources = await buildRealMcpSources(host, { invoke: async () => null, searchInFiles: NO_SEARCH });
    const sup = sources.runSupplemental!;
    const err = await Promise.resolve(sup(TOOL, { commandId: VIEW_ID }, scope('privileged', [TOOL, VIEW_ID]))).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, '上下文缺席却静默成功＝后门').not.toBeNull();
    expect(isMcpFailure(err)).toBe(true);
    expect((err as McpFailure).code).toBe('NOT_WIRED');
    expect((err as McpFailure).message).toContain(VIEW_ID);
    expect(ran, '上下文缺席时命令本体竟被跑了 ⇒ 伪造了执行').toBe(false);
  });

  it('有上下文时腿走的正是 projectCommands 那条 run（同一真源，不另起执行通路）', async () => {
    const seen: unknown[] = [];
    const cmd = entry({
      id: VIEW_ID,
      tier: 'read',
      run: (ctx, args) => void seen.push([ctx, args]),
    });
    const ctx = { project: null } as never;
    const host = {
      getCommands: () => [cmd],
      getCommandContext: () => ctx,
      getKernel: () => null,
    } as unknown as McpRealSourceHost;
    const sources = await buildRealMcpSources(host, { invoke: async () => null, searchInFiles: NO_SEARCH });
    await sources.runSupplemental!(TOOL, { commandId: VIEW_ID, args: { x: 1 } }, scope('privileged', [TOOL, VIEW_ID]));
    expect(seen).toEqual([[ctx, { x: 1 }]]);
  });
});

/* ======================================================================= *
 * ⑤ 入参严格化（B11 口径）
 * ======================================================================= */

describe('B24 判据 ⑤ · 入参严格化', () => {
  function registryWith(access: McpCommandRunAccess) {
    return createMcpCapabilityRegistry({
      ...({} as McpHostDeps),
      runSupplemental: createRunSupplemental(ioDeps({ commandRun: access })),
    });
  }

  it('缺 commandId ⇒ INVALID_ARGS（腿与注册表两条路都拒）', async () => {
    const access = accessOf([entry({ id: VIEW_ID })]);
    const registry = registryWith(access);
    await expect(registry.callTool(TOOL, {}, scope('privileged', [TOOL]))).rejects.toMatchObject({
      code: 'INVALID_ARGS',
    });
    await expect(
      createRunSupplemental(ioDeps({ commandRun: access }))(TOOL, {}, scope('privileged', [TOOL])),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('未知键 ⇒ 注册表校验层显式拒收并点名未知键（不静默吞掉）', async () => {
    const registry = registryWith(accessOf([entry({ id: VIEW_ID })]));
    const err = await registry
      .callTool(TOOL, { commandId: VIEW_ID, corridor: 'x' }, scope('privileged', [TOOL]))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isMcpFailure(err)).toBe(true);
    expect((err as McpFailure).code).toBe('INVALID_ARGS');
    expect((err as McpFailure).message).toContain('corridor');
  });

  it('commandId 形状非法（空串 / 超长 / 控制字符）⇒ INVALID_ARGS，不进判定', async () => {
    const access = accessOf([entry({ id: VIEW_ID })]) as AccessWithSpy;
    const sup = createRunSupplemental(ioDeps({ commandRun: access }));
    for (const bad of ['', ' '.repeat(300), 'a\tb']) {
      await expect(sup(TOOL, { commandId: bad }, scope('privileged', [TOOL]))).rejects.toMatchObject({
        code: 'INVALID_ARGS',
      });
    }
    expect(access.runSpy).not.toHaveBeenCalled();
  });

  it('命令自带 argsSchema ⇒ 按它校验，失败里点名是哪枚命令要求的（不吞成通用错误）', async () => {
    const access = accessOf([
      entry({
        id: 'layout.setGroupsColumn',
        tier: 'read',
        argsSchema: {
          type: 'object',
          properties: { columns: { type: 'integer', minimum: 1, maximum: 4 } },
          required: ['columns'],
          additionalProperties: false,
        },
        run: () => undefined,
      }),
    ]);
    const sup = createRunSupplemental(ioDeps({ commandRun: access }));
    const err = await sup(
      TOOL,
      { commandId: 'layout.setGroupsColumn', args: { columns: 9 } },
      scope('read', [TOOL]),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isMcpFailure(err)).toBe(true);
    expect((err as McpFailure).code).toBe('INVALID_ARGS');
    expect((err as McpFailure).message).toContain('layout.setGroupsColumn');
  });
});

/* ======================================================================= *
 * ⑥ 分页 / 体积不放宽
 * ======================================================================= */

describe('B24 判据 ⑥ · commands.list 的既有上限一字未动', () => {
  it('commands.list 仍 tier=read、limit 上限 500 / 缺省 200（本批不新增分页面）', () => {
    const spec = SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === 'commands.list')!;
    expect(spec.tier).toBe('read');
    const props = (spec.inputSchema as Record<string, unknown>)['properties'] as Record<string, unknown>;
    expect(props['maxResults']).toMatchObject({ maximum: 500 });
    expect(props['limit']).toBeDefined();
    expect(props['cursor']).toBeDefined();
  });
});

/* ======================================================================= *
 * 注册表通路（真走 tools/call 的校验层 + tier 闸）
 * ======================================================================= */

describe('B24 注册表通路 · 越权与缺席都必须是结构化失败', () => {
  it('未批准 commands.run 的会话直调 ⇒ PERMISSION_DENIED（registry 侧第一道闸）', async () => {
    const access = accessOf([entry({ id: VIEW_ID, tier: 'read' })]) as AccessWithSpy;
    const registry = createMcpCapabilityRegistry({
      runSupplemental: createRunSupplemental(ioDeps({ commandRun: access })),
    });
    for (const s of [scope('read'), scope('edit'), scope('privileged')]) {
      await expect(registry.callTool(TOOL, { commandId: VIEW_ID }, s)).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
    }
    expect(access.runSpy).not.toHaveBeenCalled();
  });

  it('命令来源仍逐条成面（本批不改动既有 fail-closed 表面：无 tier ⇒ privileged）', () => {
    const source: McpCommandSource = { id: VIEW_ID, title: '切换侧栏', run: () => undefined };
    const registry = createMcpCapabilityRegistry({ commands: [source] });
    expect(registry.listTools(scope('privileged', [VIEW_ID])).map((t) => t.name)).toContain(VIEW_ID);
    expect(registry.listTools(scope('read')).map((t) => t.name)).not.toContain(VIEW_ID);
  });

  it('档位纯函数与注册表同口径：edit 档命令在 read 会话一律拒（防两道闸漂成两套尺）', () => {
    const tiers: McpTier[] = ['read', 'edit', 'privileged'];
    for (const cmdTier of tiers) {
      for (const session of ['read', 'edit', 'privileged'] as const) {
        const gate = decideCommandRunGate({
          commandId: VIEW_ID,
          declaredTier: cmdTier,
          scope: scope(session, [TOOL, VIEW_ID]),
        });
        const rank: Record<McpTier, number> = { read: 0, edit: 1, privileged: 2 };
        const expected = rank[cmdTier] <= rank[session] || session === 'privileged';
        expect(gate.allowed, `命令档=${cmdTier} 会话档=${session}`).toBe(expected);
      }
    }
  });
});
