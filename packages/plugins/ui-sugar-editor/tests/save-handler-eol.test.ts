/**
 * EOL-OVERRIDE-SAVE 批：`.kojo` 保存接管（`performSugarSave`）的 **eol 透传**。
 *
 * 宿主（`EditorPane.savePathDetailed`）在作者显式切过换行（`ModelEntry.eolOverride`
 * 复核通过）时，随 `EditorSaveRequest.eol` 递上行尾覆盖档；本模块（纯编排、依赖
 * 注入可单测）的义务只有一条：**把 `request.eol` 原样透传给源文件的两处
 * `io.writeText`**（journal 批路径 + 显式快照兜底路径）；缺席 = 第三参 `undefined`
 * （旧形状逐字不变）。只约束**源文件**——产物 `.ERB` 的行尾归 `compileToFile`
 * 自己的策略管（本文件用 blocked 计划把产物面与透传面切开取证）。
 *
 * 内核 `{ eol }` 的落盘行为在 `kernel/tests/io-eol-override.test.ts`；
 * 宿主接线在 `app/tests/status-eol-save.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import type {
  EditorSaveRequest,
  SugarCompileResult,
  SugarSavePlan,
  WriteTextOptions,
} from '@kojo/plugin-api';
import { performSugarSave, type SugarSaveDeps } from '../src/save-handler';

const PATH_KOJO = '/proj/口上/x.kojo';

/** 构造 blocked 计划（源非 .kojo：产物面被完全拦掉，只考源写透传） */
function blockedPlan(): SugarSavePlan {
  return {
    sourcePath: PATH_KOJO,
    erbPath: null,
    transpile: { erb: 'IGNORED', sourceMap: [], diagnostics: [] },
    fullwidthSpaceLines: [],
    blocked: true,
    blockedReason: 'source-not-kojo',
  };
}

interface Recorder {
  readonly deps: SugarSaveDeps;
  /** 每次源写的第三参（透传取证的核心） */
  readonly writeOpts: Array<WriteTextOptions | undefined>;
}

/** 记录型 fake：只盯 writeText 的第三参；`withJournal` = 是否挂 journal 批依赖 */
function recorder(withJournal: boolean): Recorder {
  const writeOpts: Array<WriteTextOptions | undefined> = [];
  const deps: SugarSaveDeps = {
    sugar: {
      planSave: () => blockedPlan(),
      compileToFile: async (_source, targetPath): Promise<SugarCompileResult> => ({
        erbPath: targetPath,
        byteSize: 42,
        backupPath: null,
        diagnostics: [],
      }),
    },
    io: {
      writeText: async (_path, _text, opts) => {
        writeOpts.push(opts);
      },
      readText: async () => {
        throw new Error('not found');
      },
      exists: async () => false,
      removeFile: async () => {},
    },
  };
  return {
    deps: withJournal
      ? {
          ...deps,
          journal: {
            begin: async () => 'op-1',
            record: async () => {},
            commit: async () => {},
            abort: async () => {},
          },
        }
      : deps,
    writeOpts,
  };
}

function request(eol?: 'crlf' | 'lf'): EditorSaveRequest {
  return { path: PATH_KOJO, text: '角色: 1', project: null, ...(eol ? { eol } : {}) };
}

describe('保存接管 / eol 覆盖档透传（EOL-OVERRIDE-SAVE 批）', () => {
  it('request.eol = crlf ⇒ 源写第三参 = { eol: crlf }（journal 批路径）', async () => {
    const r = recorder(true);
    const out = await performSugarSave(r.deps, request('crlf'));
    expect(out.status).toBe('saved');
    expect(r.writeOpts).toEqual([{ eol: 'crlf' }]);
  });

  it('request.eol = lf ⇒ 第三参 = { eol: lf }（兜底路径同口径）', async () => {
    const r = recorder(false);
    const out = await performSugarSave(r.deps, request('lf'));
    expect(out.status).toBe('saved');
    expect(r.writeOpts).toEqual([{ eol: 'lf' }]);
  });

  it('request.eol 缺席 ⇒ 第三参 = undefined（旧形状逐字不变，additive）', async () => {
    const r = recorder(false);
    const out = await performSugarSave(r.deps, request());
    expect(out.status).toBe('saved');
    expect(r.writeOpts).toEqual([undefined]);
  });
});
