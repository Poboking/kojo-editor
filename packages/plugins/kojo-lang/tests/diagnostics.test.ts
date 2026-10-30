/**
 * `@kojo/plugin-kojo-lang` 的**文档级诊断供方**闸（B3 收口最后一格）。
 *
 * 六条，各自防一种"看起来能跑、其实答案错了"的形态：
 * 1. **归属**：`.kojo` / `.kojo2` 作答，`.kojo1` 与其它语言 `[]`（装饰槽没有 `undefined` 态）；
 * 2. **项目级扫描弃权**：`bulk === true` ⇒ `[]`（否则 `.kojo` 会同时吃 v1 糖线与 2.0 两套结论）；
 * 3. **没有项目 / 没有两面 ⇒ 抛错**（可见降级；空数组会被读成"这份文件干净"）；
 * 4. **id 对不上 ⇒ 不猜**：组合根给的是别的项目的事实时不作答；
 * 5. **翻译**：行 → `LineDecoration`（列区间半开、跨行带 `endLine`、来源标签稳定）；
 * 6. **交接**：同一次编译的原始诊断 / 产物 / source map 记进 `diagnostic-result`，
 *    宿主预览与展开视图读的是这一份，不是第二份。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { GameProject } from '@kojo/plugin-api';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND } from '@kojo/kojo-core';
import {
  KOJO2_DIAGNOSTIC_SOURCE,
  registerKojo2SurfaceSource,
} from '@kojo/kojo-lang/diagnostics';
import {
  clearKojo2DiagnosticResults,
  kojo2DiagnosticResultFor,
} from '@kojo/kojo-lang/diagnostic-result';
import {
  isKojo2DiagnosticsPath,
  provideKojo2Diagnostics,
  toLineDecoration,
} from '../src/diagnostics';

const ADAPTER_ID = FIXTURE_ADAPTER.id;
const PROJECT = { adapterId: ADAPTER_ID } as unknown as GameProject;
const SOURCE = ['# 机 开场', '# 视角 我', '@算', '    1 + 2', ''].join('\n');
const PATH = 'D:/p/口上/神社.kojo2';

afterEach(() => {
  clearKojo2DiagnosticResults();
});

function withSurface<T>(run: (unregister: () => void) => T): T {
  const unregister = registerKojo2SurfaceSource(() => ({
    adapter: FIXTURE_ADAPTER,
    backend: FIXTURE_BACKEND,
  }));
  try {
    return run(unregister);
  } finally {
    unregister();
  }
}

describe('文档级诊断供方', () => {
  it('归属：`.kojo` / `.kojo2` 归本供方；`.kojo1` 与其它不认', () => {
    expect(isKojo2DiagnosticsPath('D:/p/a.kojo')).toBe(true);
    expect(isKojo2DiagnosticsPath('D:/p/a.KOJO2')).toBe(true);
    expect(isKojo2DiagnosticsPath('D:/p/a.kojo1')).toBe(false);
    expect(isKojo2DiagnosticsPath('D:/p/a.erb')).toBe(false);
    expect(provideKojo2Diagnostics({ path: 'D:/p/a.erb', text: SOURCE, project: PROJECT })).toEqual([]);
    expect(provideKojo2Diagnostics({ path: 'D:/p/a.kojo1', text: SOURCE, project: PROJECT })).toEqual([]);
  });

  it('项目级扫描轮（bulk）弃权：项目级结论有唯一供方', () => {
    expect(
      provideKojo2Diagnostics({ path: PATH, text: SOURCE, project: PROJECT, bulk: true }),
    ).toEqual([]);
  });

  it('没有当前项目 / 没有两面 ⇒ 抛错（可见降级，不是"零诊断"）', () => {
    expect(() => provideKojo2Diagnostics({ path: PATH, text: SOURCE, project: null })).toThrow(
      /没有当前项目/,
    );
    expect(() => provideKojo2Diagnostics({ path: PATH, text: SOURCE, project: PROJECT })).toThrow(
      /没有 2\.0 诊断面/,
    );
  });

  it('adapter id 对不上 ⇒ 不猜（返回空数组，不借别家事实）', () => {
    withSurface(() => {
      const other = { adapterId: 'another-game' } as unknown as GameProject;
      expect(provideKojo2Diagnostics({ path: PATH, text: SOURCE, project: other })).toEqual([]);
    });
  });

  it('真 core：跨行 / 零宽落点在 `LineDecoration` 上保留，来源标签稳定', () => {
    withSurface(() => {
      const decorations = provideKojo2Diagnostics({ path: PATH, text: SOURCE, project: PROJECT });
      expect(decorations.length).toBeGreaterThan(0);
      for (const decoration of decorations) {
        expect(decoration.source).toBe(KOJO2_DIAGNOSTIC_SOURCE);
        expect(decoration.startColumn).toBeDefined();
        expect(decoration.endColumn ?? 0).toBeGreaterThan(decoration.startColumn ?? 0);
        expect(decoration.endLine ?? decoration.line).toBeGreaterThanOrEqual(decoration.line);
        expect(['error', 'warning']).toContain(decoration.severity);
        expect(decoration.code).toBeTruthy();
      }
    });
  });

  it('跨行行装饰带 `endLine`（缺省同行的不写这一格）', () => {
    expect(toLineDecoration({
      line: 2,
      startColumn: 1,
      endLine: 4,
      endColumn: 3,
      severity: 'error',
      message: '跨行',
      code: 'core/block/unterminated',
    })).toMatchObject({ line: 2, endLine: 4, endColumn: 3 });
    expect(
      toLineDecoration({
        line: 2,
        startColumn: 1,
        endLine: 2,
        endColumn: 3,
        severity: 'warning',
        message: '同行',
        code: 'core/options/pending',
      }),
    ).not.toHaveProperty('endLine');
  });

  it('交接：同一次编译的原始诊断 / 产物留在成品表里（预览与展开视图读这一份）', () => {
    withSurface(() => {
      const decorations = provideKojo2Diagnostics({ path: PATH, text: SOURCE, project: PROJECT });
      const snapshot = kojo2DiagnosticResultFor(PATH);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.source).toBe(SOURCE);
      expect(snapshot?.diagnostics).toHaveLength(decorations.length);
      expect(snapshot?.artifacts?.erb).toBeTypeOf('string');
      expect(snapshot?.artifacts?.sourceMap).toBeDefined();
      expect(snapshot?.error).toBeNull();
    });
  });
});