/**
 * 2026-10-12 保存接线批单测：`.kojo` 保存编排（`performSugarSave`）的**多路径**。
 *
 * 本模块是**纯编排**（零 React、零内核），依赖从入参注入——故用 fake `sugar`
 * 与 fake `io` 精确驱动，逐条钉死契约（对应 `plugin-api/sugar.ts` 的 `planSave`
 * 契约 + 规范 §5.3「阻止编译，不生成半成品 ERB」+ §8「保存期告警」）：
 *
 *   1. 良构源 → 写源 + 编译产物，返回 `saved`（含字节数）；
 *   2. 全角空格未确认 → `needs-choice` 且**未落盘**（不改磁盘）；
 *   3. 全角空格已确认 → 照常保存（告警非阻断）；
 *   4. 转译含 error（`blocked`）→ **源仍保存**、产物不产、`note` 说明原因；
 *   5. 源非 `.kojo`（`blocked`）→ 同上，note 归因路径；
 *   6. 源写失败 → `error`（不静默）；
 *   7. 编译落盘失败 → `error`，且消息明确「源已保存」。
 */

import { describe, expect, it } from 'vitest';
import type {
  EditorSaveRequest,
  SugarCompileResult,
  SugarDiagnostic,
  SugarSavePlan,
  SugarTranspileResult,
} from '@kojo/plugin-api';
import { FULLWIDTH_SPACE } from '@kojo/plugin-api';
import { performSugarSave, type SugarSaveDeps } from '../src/save-handler';

const PATH_KOJO = '/proj/口上/x.kojo';
const PATH_ERB = '/proj/口上/x.ERB';

const errDiag: SugarDiagnostic = {
  message: '缩进异常',
  loc: { line: 2, column: 1 },
  code: 'cont-inside-quotes' as SugarDiagnostic['code'],
  severity: 'error',
};

/** 构造 `SugarTranspileResult`（只有 `diagnostics` 对本模块可见语义有影响） */
function transpileOf(diagnostics: SugarDiagnostic[] = []): SugarTranspileResult {
  return { erb: 'IGNORED', sourceMap: [], diagnostics };
}

/** 构造 `SugarSavePlan`（缺省=良构、有目标、无全角空格） */
function planOf(over: Partial<SugarSavePlan> = {}): SugarSavePlan {
  return {
    sourcePath: PATH_KOJO,
    erbPath: PATH_ERB,
    transpile: transpileOf(),
    fullwidthSpaceLines: [],
    blocked: false,
    ...over,
  };
}

interface Recorder {
  readonly deps: SugarSaveDeps;
  readonly writes: Array<{ path: string; text: string }>;
  readonly compiles: Array<{ source: string; targetPath: string }>;
}

/** 记录型 fake（精确断言"是否落盘/落盘几次/目标是谁"） */
function recorder(opts: {
  plan: SugarSavePlan;
  writeText?: (path: string, text: string) => Promise<void>;
  compile?: (source: string, targetPath: string) => Promise<SugarCompileResult>;
}): Recorder {
  const writes: Array<{ path: string; text: string }> = [];
  const compiles: Array<{ source: string; targetPath: string }> = [];
  const deps: SugarSaveDeps = {
    sugar: {
      planSave: () => opts.plan,
      compileToFile: async (source, targetPath) => {
        compiles.push({ source, targetPath });
        if (opts.compile) return opts.compile(source, targetPath);
        return {
          erbPath: targetPath,
          byteSize: 42,
          backupPath: null,
          diagnostics: [],
        };
      },
    },
    io: {
      writeText: async (path, text) => {
        writes.push({ path, text });
        if (opts.writeText) return opts.writeText(path, text);
      },
    },
  };
  return { deps, writes, compiles };
}

function request(over: Partial<EditorSaveRequest> = {}): EditorSaveRequest {
  return { path: PATH_KOJO, text: '角色: 1', project: null, ...over };
}

describe('保存编排 / 良构源（正常落盘）', () => {
  it('写源 + 编译产物 → saved，message 含产物基名与字节数，无 note', async () => {
    const r = recorder({ plan: planOf() });
    const out = await performSugarSave(r.deps, request());

    expect(out.status).toBe('saved');
    if (out.status !== 'saved') return;
    expect(out.message).toContain('x.ERB');
    expect(out.message).toContain('42B');
    expect(out.note).toBeUndefined();
    // 源与产物都落了；产物目标即 plan.erbPath
    expect(r.writes).toEqual([{ path: PATH_KOJO, text: '角色: 1' }]);
    expect(r.compiles).toEqual([{ source: '角色: 1', targetPath: PATH_ERB }]);
  });
});

describe('保存编排 / 全角空格告警（非阻断）', () => {
  it('未确认 → needs-choice，携带行号，且**一次都没落盘**', async () => {
    const r = recorder({ plan: planOf({ fullwidthSpaceLines: [3, 7] }) });
    const out = await performSugarSave(r.deps, request());

    expect(out.status).toBe('needs-choice');
    if (out.status !== 'needs-choice') return;
    expect(out.warning.kind).toBe('fullwidth-space');
    expect(out.warning.lines).toEqual([3, 7]);
    expect(out.warning.message).toContain('2 行');
    // 关键：决策前不写盘、不编译（否则"取消"会留下副作用）
    expect(r.writes).toEqual([]);
    expect(r.compiles).toEqual([]);
  });

  it('已确认（acknowledgeFullwidthSpace）→ 照常保存（告警放行）', async () => {
    const r = recorder({ plan: planOf({ fullwidthSpaceLines: [3] }) });
    const out = await performSugarSave(r.deps, request({ choices: { acknowledgeFullwidthSpace: true } }));

    expect(out.status).toBe('saved');
    expect(r.writes).toHaveLength(1);
    expect(r.compiles).toHaveLength(1);
  });

  it('真实常量：FULLWIDTH_SPACE 为 U+3000（面板与保存共用同一判据）', () => {
    expect(FULLWIDTH_SPACE).toBe('\u3000');
  });
});

describe('保存编排 / 产物被阻止（源始终保存）', () => {
  it('转译含 error → saved，源已落盘、产物不产、note 记错误数', async () => {
    const r = recorder({
      plan: planOf({
        transpile: transpileOf([errDiag, errDiag]),
        blocked: true,
        blockedReason: 'transpile-error',
      }),
    });
    const out = await performSugarSave(r.deps, request());

    expect(out.status).toBe('saved');
    if (out.status !== 'saved') return;
    expect(out.note).toContain('2 项错误');
    // 源必须保存（防丢作者成果）；产物绝不编译（不产半成品）
    expect(r.writes).toHaveLength(1);
    expect(r.compiles).toEqual([]);
  });

  it('源非 .kojo（无目标）→ saved，note 归因路径', async () => {
    const r = recorder({
      plan: planOf({ erbPath: null, blocked: true, blockedReason: 'source-not-kojo' }),
    });
    const out = await performSugarSave(r.deps, request({ path: '/proj/x.ERB' }));

    expect(out.status).toBe('saved');
    if (out.status !== 'saved') return;
    expect(out.note).toContain('.kojo');
    expect(r.compiles).toEqual([]);
  });
});

describe('保存编排 / 失败一律转 error（不抛、不静默）', () => {
  it('源写失败 → error，消息含「保存源文件失败」，不触碰编译', async () => {
    const r = recorder({
      plan: planOf(),
      writeText: async () => {
        throw new Error('EPERM: 越权');
      },
    });
    const out = await performSugarSave(r.deps, request());

    expect(out.status).toBe('error');
    if (out.status !== 'error') return;
    expect(out.message).toContain('保存源文件失败');
    expect(out.message).toContain('EPERM');
    expect(r.compiles).toEqual([]);
  });

  it('编译落盘失败 → error，消息明确「源已保存」', async () => {
    const r = recorder({
      plan: planOf(),
      compile: async () => {
        throw new Error('回读验证不一致');
      },
    });
    const out = await performSugarSave(r.deps, request());

    expect(out.status).toBe('error');
    if (out.status !== 'error') return;
    expect(out.message).toContain('源已保存');
    expect(out.message).toContain('回读验证不一致');
    // 源确已落盘（失败发生在产物阶段）
    expect(r.writes).toHaveLength(1);
  });
});