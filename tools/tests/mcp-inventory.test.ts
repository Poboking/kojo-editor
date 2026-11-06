/**
 * `tools/mcp-inventory.mjs` 的对拍用例（P0 契约 · 路 A）。
 *
 * 造法照 `audit-decoupling.test.ts`：把**一份迷你树**喂给真脚本（`--root <tmp> --print`），
 * 四处真源各自造出已知形状的条目，再对拍脚本报出的计数与缺口清单。这样读数不随真实树
 * 的其它两路并发改动漂移，也顺便钉住四处解析规则本身（单行 / 多行规格、命名空间命令、
 * `editor.command` 不算缺口、非命令 `id` 不误计）。
 *
 * 末尾一条是**真树对拍**：不钉死具体数字（其它两路会加命令 / 加 Rust 命令），只验四处
 * 真源都读到了、`missingSources` 为空、缺口清单确实被算出来——防止脚本某天退化成"全 0 假绿"。
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../mcp-inventory.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runInventory(args: string[]): Promise<RunResult> {
  try {
    const res = await run(process.execPath, [SCRIPT, ...args], { maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

/** 造一份形状已知、四处真源齐全的迷你树。 */
async function fixtureRoot(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-mcp-inventory-'));
  const put = async (rel: string, content: string): Promise<void> => {
    const abs = path.join(tmp, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  };
  await put(
    'packages/app/src/ui/commands.ts',
    [
      'export interface CommandEntry {',
      '  readonly id: string;',
      '  readonly title: string;',
      '  run(ctx: unknown): void;',
      '}',
      'export interface ShellCommandSpec {',
      '  readonly id: string;',
      '  readonly title: string;',
      '  run(): void;',
      '}',
      'export function buildCommandRegistry(shell: readonly ShellCommandSpec[]): CommandEntry[] {',
      '  const map = new Map<string, CommandEntry>();',
      '  for (const s of shell) map.set(s.id, { id: s.id, title: s.title, run: () => s.run() });',
      '  return [...map.values()];',
      '}',
      '',
    ].join('\n'),
  );
  await put(
    'packages/app/src/ui/ShellLayout.tsx',
    [
      'const specs = [',
      "  { id: 'layout.toggle', title: '切换', run: () => {} },",
      '  {',
      "    id: 'workbench.multi',",
      "    title: '多行',",
      "    keybinding: 'ctrl+m',",
      '    run: () => {},',
      '  },',
      // 没有 run 的面板规格：不应被误计成命令
      "  { id: 'panel.notACommand', title: '面板', component: () => null },",
      "  { id: 'editor.action.find', title: '查找', run: () => {} },",
      '];',
      '',
    ].join('\n'),
  );
  await put(
    'packages/app/src-tauri/src/lib.rs',
    [
      '        .invoke_handler(tauri::generate_handler![',
      '            read_file_bytes,',
      '            launcher::commands::launcher_start',
      '        ])',
      '',
    ].join('\n'),
  );
  await put(
    'packages/app/src/debug/install-debug.ts',
    [
      'export interface KojoDebugApi {',
      '  readonly mode: string;',
      '  editor: {',
      '    info(): EditorInfo | null;',
      '    definitionAt(',
      '      line: number,',
      '      column: number,',
      '    ): Promise<unknown[]>;',
      '  };',
      '}',
      '',
    ].join('\n'),
  );
  await put(
    'packages/plugins/probe/src/index.ts',
    [
      'export function setup(ctx: any) {',
      "  ctx.slots.register('editor.command', {",
      "    id: 'probe.runLint',",
      "    title: 'Run',",
      '    run: () => {},',
      '  });',
      "  ctx.slots.register('ui.panel', {",
      "    id: 'probe.panel',",
      "    title: 'Panel',",
      '  });',
      '}',
      '',
    ].join('\n'),
  );
  return tmp;
}

describe('mcp-inventory · 四处真源对拍', () => {
  it('迷你树：命令/Rust/语义读数/槽贡献四个计数与缺口清单逐项对拍', async () => {
    const tmp = await fixtureRoot();
    try {
      const { code, stdout } = await runInventory(['--root', tmp, '--print']);
      expect(code).toBe(0);
      const inv = JSON.parse(stdout) as {
        schemaVersion: number;
        missingSources: string[];
        registryConstruction: { buildCommandRegistry: boolean; commandEntry: boolean; shellCommandSpec: boolean };
        commandCount: number;
        rustCommandCount: number;
        semanticReadCount: number;
        editorSemanticSurfaceFound: boolean;
        slotContributionCount: number;
        editorCommandContributionCount: number;
        commandIds: string[];
        rustCommands: string[];
        semanticReads: string[];
        gaps: { rust: string[]; debug: string[]; plugins: string[] };
        gapCount: number;
        markdown: string;
      };
      expect(inv.schemaVersion).toBe(2);
      expect(inv.missingSources).toEqual([]);
      expect(inv.registryConstruction).toEqual({
        buildCommandRegistry: true,
        commandEntry: true,
        shellCommandSpec: true,
      });
      // 3 条真命令规格（含 1 条多行）；面板 id 不算命令
      expect(inv.commandCount).toBe(3);
      expect(inv.commandIds).toEqual(['editor.action.find', 'layout.toggle', 'workbench.multi']);
      // 命名空间取最后一段；按名字排序
      expect(inv.rustCommandCount).toBe(2);
      expect(inv.rustCommands).toEqual(['launcher_start', 'read_file_bytes']);
      // 单行 info + 多行 definitionAt
      expect(inv.semanticReadCount).toBe(2);
      expect(inv.editorSemanticSurfaceFound).toBe(true);
      expect(inv.semanticReads).toEqual(['definitionAt', 'info']);
      expect(inv.slotContributionCount).toBe(2);
      expect(inv.editorCommandContributionCount).toBe(1);
      // editor.command 贡献不计缺口；其余三处名字都不在命令注册表里
      expect(inv.gaps.rust).toEqual(['launcher_start', 'read_file_bytes']);
      expect(inv.gaps.debug).toEqual(['definitionAt', 'info']);
      expect(inv.gaps.plugins).toEqual(['ui.panel:probe.panel']);
      expect(inv.gapCount).toBe(5);
      expect(inv.markdown).toContain('未登记成命令的缺口');
      expect(inv.markdown).toContain('| 命令注册表命令数 | 3 |');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('--markdown 只出草案、rc 仍是 0；--root 缺目录时缺源如实列出', async () => {
    const tmp = await fixtureRoot();
    try {
      const md = await runInventory(['--root', tmp, '--print', '--markdown']);
      expect(md.code).toBe(0);
      expect(md.stdout.startsWith('# MCP 能力盘点草案')).toBe(true);
      expect(() => JSON.parse(md.stdout)).toThrow(); // 不是 JSON

      const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-mcp-inventory-empty-'));
      try {
        const res = await runInventory(['--root', empty, '--print']);
        expect(res.code).toBe(0); // 草案不是质量闸，不判红
        const inv = JSON.parse(res.stdout) as {
          commandCount: number;
          rustCommandCount: number;
          semanticReadCount: number;
          slotContributionCount: number;
          missingSources: string[];
        };
        expect(inv.commandCount).toBe(0);
        expect(inv.rustCommandCount).toBe(0);
        expect(inv.semanticReadCount).toBe(0);
        expect(inv.slotContributionCount).toBe(0);
        expect(inv.missingSources.length).toBe(4);
      } finally {
        await fs.rm(empty, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('真树对拍：四处真源都读到、缺口清单被算出（不钉死数字，防退化成全 0 假绿）', async () => {
    const { code, stdout } = await runInventory(['--root', REPO_ROOT, '--print']);
    expect(code).toBe(0);
    const inv = JSON.parse(stdout) as {
      missingSources: string[];
      commandCount: number;
      rustCommandCount: number;
      semanticReadCount: number;
      slotContributionCount: number;
      gapCount: number;
      registryConstruction: { buildCommandRegistry: boolean };
    };
    expect(inv.missingSources).toEqual([]);
    expect(inv.registryConstruction.buildCommandRegistry).toBe(true);
    expect(inv.commandCount).toBeGreaterThan(0);
    expect(inv.rustCommandCount).toBeGreaterThan(0);
    expect(inv.semanticReadCount).toBeGreaterThan(0);
    expect(inv.slotContributionCount).toBeGreaterThan(0);
    expect(inv.gapCount).toBeGreaterThan(0);
  });
});

/* ============ 第三波：按 tier 分组的覆盖率统计 ============ */
describe('mcp-inventory · 第三波 tier 覆盖率（不破坏既有结构断言）', () => {
  it('真树 coverage：tools 按 read/edit/privileged 分组、剩余缺口带原因、交叉校验通过', async () => {
    const { code, stdout } = await runInventory(['--root', REPO_ROOT, '--print']);
    expect(code).toBe(0);
    const inv = JSON.parse(stdout) as {
      sources: { mcpHost: string };
      missingSources: string[];
      coverage: {
        tools: { total: number; read: number; edit: number; privileged: number; names: string[] };
        totalGaps: number;
        wiredGaps: number;
        deferredGaps: number;
        orphanedWires: string[];
        byReason: Record<string, number>;
        deferredNotes: { scope: string; reason: string }[];
        deferred: { source: string; gap: string; reason: string }[];
      };
      markdown: string;
    };
    expect(inv.sources.mcpHost).toContain('mcp-host');
    expect(inv.missingSources).toEqual([]); // best-effort 参考源不进 missingSources
    const cov = inv.coverage;
    expect(cov.tools.total).toBeGreaterThan(0);
    expect(cov.tools.read).toBeGreaterThan(0);
    expect(cov.tools.edit).toBeGreaterThan(0);
    expect(cov.tools.privileged).toBeGreaterThan(0);
    expect(cov.tools.read + cov.tools.edit + cov.tools.privileged).toBe(cov.tools.total);
    expect(cov.tools.names).toHaveLength(cov.tools.total);
    // 第三波新增的只读工具确实被静态解析进覆盖率
    for (const n of ['commands.list', 'fs.readFile', 'document.active', 'lang.markers']) {
      expect(cov.tools.names).toContain(n);
    }
    expect(cov.wiredGaps).toBeGreaterThan(0);
    expect(cov.wiredGaps + cov.deferredGaps).toBe(cov.totalGaps);
    expect(Object.keys(cov.byReason).length).toBeGreaterThan(0);
    for (const d of cov.deferred) {
      expect(d.source.length).toBeGreaterThan(0);
      expect(d.gap.length).toBeGreaterThan(0);
      expect(d.reason.length).toBeGreaterThan(0); // 每条剩余缺口都有显式原因
    }
    expect(cov.deferredNotes.length).toBeGreaterThan(0);
    for (const n of cov.deferredNotes) expect(n.reason.length).toBeGreaterThan(0);
    expect(cov.orphanedWires).toEqual([]); // 覆盖声明与真实工具/缺口对拍通过（不假绿）
    expect(inv.markdown).toContain('能力覆盖（按 tier');
    expect(inv.markdown).toContain('tools 总数');
    expect(inv.markdown).toContain('无真源缺口类别（显式标注');
  });

  it('迷你树：参考源缺席时 tools 总数如实为 0，不进 missingSources、不造假绿', async () => {
    const tmp = await fixtureRoot();
    try {
      const { code, stdout } = await runInventory(['--root', tmp, '--print']);
      expect(code).toBe(0);
      const inv = JSON.parse(stdout) as {
        missingSources: string[];
        coverage: { tools: { total: number }; deferredGaps: number };
      };
      expect(inv.missingSources).toEqual([]);
      expect(inv.coverage.tools.total).toBe(0);
      expect(inv.coverage.deferredGaps).toBeGreaterThan(0);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

/* ============ 第四波：--json 机器摘要 / 接线成本分类 / 写腿状态段 ============ */
describe('mcp-inventory · --json 机器摘要（稳定 schema）', () => {
  interface MachineGap {
    source: string;
    name: string;
    tool: string | null;
    wired: boolean;
    reasonClass: string;
    wiringCost: string;
    suggestedPriority: string | null;
  }
  interface MachineSummary {
    schemaVersion: number;
    generatedBy: string;
    counts: {
      commands: number;
      rustCommands: number;
      semanticReads: number;
      slotContributions: number;
      tools: { total: number; read: number; edit: number; privileged: number };
      totalGaps: number;
      wiredGaps: number;
      deferredGaps: number;
      orphanedWires: number;
      missingSources: number;
    };
    gaps: MachineGap[];
    writeLegs: {
      sources: { registry: string; ioLegs: string; uiLegs: string };
      sourcesMissing: string[];
      legs: { tool: string; tier: string | null; gap: string | null; gapRegistered: boolean; wired: boolean; evidence: string }[];
      wiredCount: number;
      notWiredCount: number;
    };
  }

  it('真树 --json：可 parse、counts 与 gaps 数组联动、分类/优先级枚举合法', async () => {
    const { code, stdout } = await runInventory(['--root', REPO_ROOT, '--json']);
    expect(code).toBe(0);
    const m = JSON.parse(stdout) as MachineSummary;
    expect(m.schemaVersion).toBe(1); // 机器摘要自身版本，独立于全量 JSON 的 SCHEMA_VERSION
    expect(m.generatedBy).toContain('mcp-inventory');
    // counts 自洽
    expect(m.counts.tools.total).toBe(m.counts.tools.read + m.counts.tools.edit + m.counts.tools.privileged);
    expect(m.counts.wiredGaps + m.counts.deferredGaps).toBe(m.counts.totalGaps);
    expect(m.counts.totalGaps).toBeGreaterThan(0);
    // gaps 数组 = 全量缺口，wired 计数与 counts 联动
    expect(m.gaps).toHaveLength(m.counts.totalGaps);
    expect(m.gaps.filter((g) => g.wired)).toHaveLength(m.counts.wiredGaps);
    expect(m.gaps.filter((g) => !g.wired)).toHaveLength(m.counts.deferredGaps);
    // 每条字段形状与枚举合法
    const COSTS = ['cheap-read', 'needs-write-domain', 'needs-UI', 'needs-protocol', 'unknown', 'wired'];
    const PRIOS = ['P1', 'P2', 'P3', 'P4'];
    for (const g of m.gaps) {
      expect(['rust', 'debug', 'plugins']).toContain(g.source);
      expect(g.name.length).toBeGreaterThan(0);
      expect(COSTS).toContain(g.wiringCost);
      if (g.wired) {
        expect(g.reasonClass).toBe('wired');
        expect(g.suggestedPriority).toBeNull();
        expect(g.tool).not.toBeNull(); // 已接线缺口必带覆盖工具名
      } else {
        expect(g.reasonClass.length).toBeGreaterThan(0);
        expect(PRIOS).toContain(g.suggestedPriority);
        expect(g.tool).toBeNull();
      }
    }
    // 已登记缺口带覆盖工具（与 MCP_TOOL_GAP_MAP 联动；LaneA 接线与否不影响该登记）
    const create = m.gaps.find((g) => g.name === 'create_file_exclusive') as MachineGap;
    expect(create).toBeTruthy();
    expect(create.wired).toBe(true);
    expect(create.tool).toBe('fileTree.create');
  });

  it('真树写腿状态段：候选=registry 非 read 档、wired 与真源腿表联动、缺口登记对拍 gap map', async () => {
    const { code, stdout } = await runInventory(['--root', REPO_ROOT, '--print']);
    expect(code).toBe(0);
    const inv = JSON.parse(stdout) as { writeLegs: MachineSummary['writeLegs']; markdown: string };
    const wl = inv.writeLegs;
    expect(wl.sourcesMissing).toEqual([]); // 真树两处腿源齐全
    expect(wl.legs.length).toBeGreaterThan(0);
    const names = wl.legs.map((l) => l.tool);
    for (const t of ['fileTree.create', 'fileTree.update', 'fileTree.remove', 'fileTree.rename', 'problems.quickFix']) {
      expect(names).toContain(t);
    }
    for (const l of wl.legs) {
      expect(['edit', 'privileged']).toContain(l.tier); // 候选集 = registry 非 read 档
      expect(typeof l.wired).toBe('boolean');
      expect(l.gapRegistered).toBe(typeof l.gap === 'string');
      expect(l.evidence.length).toBeGreaterThan(0);
    }
    expect(wl.wiredCount + wl.notWiredCount).toBe(wl.legs.length);
    // 联动真源（不复制解析逻辑）：wired 布尔 === 腿表条目字面量 `['工具名',` 在真源文件中出现
    const ioSrc = await fs.readFile(path.join(REPO_ROOT, 'packages', 'app', 'src', 'mcp', 'real-sources-io.ts'), 'utf8');
    const uiSrc = await fs.readFile(path.join(REPO_ROOT, 'packages', 'app', 'src', 'mcp', 'real-sources.ts'), 'utf8');
    for (const l of wl.legs) {
      const needle = new RegExp(`\\['${l.tool.replace(/\./g, '\\.')}',`);
      const inLegs = needle.test(ioSrc) || needle.test(uiSrc);
      expect(l.wired, `写腿 ${l.tool} 的 wired 应与真源腿表联动`).toBe(inLegs);
    }
    // gap map 联动：fileTree.create → create_file_exclusive（packages/mcp-host/src/index.ts 登记）
    const create = wl.legs.find((l) => l.tool === 'fileTree.create');
    expect(create?.gapRegistered).toBe(true);
    expect(create?.gap).toBe('create_file_exclusive');
    // markdown 人类草案同步携带写腿状态段
    expect(inv.markdown).toContain('写腿状态');
    expect(inv.markdown).toContain('NOT_WIRED');
  });

  it('迷你树 --json：无参考源时 counts 归零、五条缺口逐条分类对拍、全 unwired（不假绿）', async () => {
    const tmp = await fixtureRoot();
    try {
      const { code, stdout } = await runInventory(['--root', tmp, '--json']);
      expect(code).toBe(0);
      const m = JSON.parse(stdout) as MachineSummary;
      expect(m.counts.totalGaps).toBe(5);
      expect(m.counts.wiredGaps).toBe(0);
      expect(m.counts.tools.total).toBe(0);
      expect(m.writeLegs.legs).toEqual([]); // registry 缺席 ⇒ 无候选
      expect(m.writeLegs.sourcesMissing.length).toBe(2); // 两处腿源缺席如实列出
      expect(m.writeLegs.wiredCount).toBe(0);
      // 分类判据逐条对拍（判定表见 mcp-inventory.mjs wiringCostFor 注释）
      const byName = new Map(m.gaps.map((g) => [g.name, g]));
      expect(byName.get('launcher_start')?.wiringCost).toBe('needs-protocol');
      expect(byName.get('launcher_start')?.suggestedPriority).toBe('P4');
      expect(byName.get('read_file_bytes')?.wiringCost).toBe('cheap-read');
      expect(byName.get('read_file_bytes')?.suggestedPriority).toBe('P1');
      expect(byName.get('definitionAt')?.wiringCost).toBe('cheap-read');
      expect(byName.get('info')?.wiringCost).toBe('cheap-read');
      expect(byName.get('ui.panel:probe.panel')?.wiringCost).toBe('needs-UI');
      expect(byName.get('ui.panel:probe.panel')?.suggestedPriority).toBe('P3');
      for (const g of m.gaps) {
        expect(g.wired).toBe(false); // 无 gap map ⇒ 全部未接线，绝不假绿
        expect(g.tool).toBeNull();
        expect(g.reasonClass).not.toBe('wired');
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
