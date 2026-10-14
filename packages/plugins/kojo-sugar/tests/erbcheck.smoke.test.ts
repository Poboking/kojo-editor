/**
 * erb_check.py 冒烟闸：kojo-sugar 转译产物 → 游戏自带静态检查器。
 *
 * 契约（2026-10-13 实测定案，探针留档 %TEMP%\erb-check-probe\）：
 * - erb_check.py 发现问题**也 exit 0**，判定必须解析 stdout 的 `[ERROR]`/`[FATAL]`；
 * - `[WARN]` 不视为失败（语料里 RAND 逻辑告警是真阳性但非转译错误）；
 * - 必须 `PYTHONIOENCODING=utf-8`，否则 GBK 终端下 emoji 直接崩；
 * - 产物写盘**不带 BOM**（BOM + 首行关键字会触发它的假阳性 "Extra closing tag"）。
 *
 * 开启方式：`pnpm test:erbcheck`，或
 * `KOJO_ERB_CHECK=1 pnpm vitest run packages/plugins/kojo-sugar/tests/erbcheck.smoke.test.ts`。
 * 检查器路径默认取语料目录，可 `KOJO_ERB_CHECK_PY=<path>` 覆盖；缺失则整组 skip。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSugarTranspileService } from '../src/service';
import { readKojo } from './golden.test';
import { stubDict, stubFaceTable } from './support';

const DEFAULT_CHECKER = 'C:/Game/eratw-sub-modding-eratw4.980/tool/erb_check.py';

let workDir: string | undefined;

const cases = [
  ['spec-6.1-lumia-310.kojo', 'K12_SPEC61'],
  ['spec-6.2-choice-heart-random.kojo', 'K12_SPEC62'],
  ['spec-3.3-narration-default.kojo', 'K12_SPEC33A'],
  ['spec-3.3-narration-author-color.kojo', 'K12_SPEC33B'],
] as const;

const checker = process.env.KOJO_ERB_CHECK_PY ?? DEFAULT_CHECKER;
const guarded = process.env.KOJO_ERB_CHECK === '1' && existsSync(checker) ? describe : describe.skip;

guarded('erb_check.py 冒烟闸（转译产物静态验收）', () => {

  beforeAll(() => {
    const svc = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
    workDir = mkdtempSync(join(tmpdir(), 'kojo-erbcheck-'));
    for (const [fixture, stem] of cases) {
      const { erb, diagnostics } = svc.transpile(readKojo(fixture));
      const errors = diagnostics.filter((d) => d.severity === 'error');
      expect(errors, `${fixture} 转译诊断有 error`).toEqual([]);
      writeFileSync(join(workDir!, `${stem}.ERB`), Buffer.from(erb, 'utf8'));
    }
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('全部产物零 [ERROR]/[FATAL]', () => {
    const r = spawnSync('python', [checker, workDir!], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      timeout: 60_000,
    });
    if (r.error) throw new Error(`python 启动失败：${r.error.message}（检查 python 是否在 PATH）`);
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    expect(out, `erb_check 退出码 ${r.status}\n${out}`).not.toMatch(/\[(ERROR|FATAL)\]/);
  });
});
