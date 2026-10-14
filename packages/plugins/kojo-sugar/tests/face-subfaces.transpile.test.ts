/**
 * P-6 绝顶子面补糖 · 端到端转译断言（独立文件，不碰既有 transplice 测试）。
 *
 * 三条无参面（权威：`KOJO_MESSAGE.ERB:328-332` = 恶作剧分支 / `:366` 调教后 / `:468` 寸止）：
 * - `时机 绝顶恶作剧：` → `M_KOJO_MESSAGE_PALAMCNG_B2_K{n}`
 * - `时机 调教后：`     → `M_KOJO_MESSAGE_PALAMCNG_C_K{n}`
 * - `时机 寸止：`       → `M_KOJO_MESSAGE_PALAMCNG_F_K{n}`
 *
 * ⚠ 恶作剧子面**必须写成单令牌 `绝顶恶作剧`**：`时机 绝顶 恶作剧：` 里的第二个词
 * `恶作剧` 会被词法器当成中文指令名（`indexName`）消费，分野 key 只剩 `绝顶`——
 * 既产不出 B2、还会因查不到该指令名报 `timing-instruction-unknown`。末条负自证
 * 钉住这个真实解析口径（**不改词法器**：既有写法逐字节不破）。
 *
 * 装配照 `support.ts` / `section-block.test.ts`：字典与分野表用适配器真表桩
 * （游戏知识只允许出现在测试里）。
 */

import { describe, expect, it } from 'vitest';
import type { SugarDiagnostic } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
const errsOf = (src: string): SugarDiagnostic[] =>
  svc().transpile(src).diagnostics.filter((d) => d.severity === 'error');
const productOf = (src: string): string => svc().transpile(src).erb;

/** 一条要判定的时机（正文一句台词；角色号 12 → `_K12`） */
const doc = (head: string): string => `角色: 12\n${head}\n\t「绝顶。」\n`;

describe('P-6 绝顶子面补糖 · 端到端产物函数头', () => {
  const cases: Array<[string, string]> = [
    ['时机 绝顶恶作剧：', 'M_KOJO_MESSAGE_PALAMCNG_B2_K12'],
    ['时机 调教后：', 'M_KOJO_MESSAGE_PALAMCNG_C_K12'],
    ['时机 寸止：', 'M_KOJO_MESSAGE_PALAMCNG_F_K12'],
  ];

  for (const [head, fn] of cases) {
    it(`「${head}」→ @${fn}（含 _1 正文函数），零 error`, () => {
      const src = doc(head);
      expect(errsOf(src)).toEqual([]);
      const erb = productOf(src);
      // 包装头 + `_1` 正文头（与现行 `绝顶` 完全同构，见 codegen emitTiming）
      expect(erb).toContain(`@${fn}`);
      expect(erb).toContain(`@${fn}_1`);
      expect(erb).toContain(';記入チェック（=0, 非表示、1, 表示）');
      // 不许串面：产物里不得出现 B（B2 含 `B2`，不含 `_B_`）等同族函数头
      expect(erb).not.toContain('M_KOJO_MESSAGE_PALAMCNG_B_K12');
    });
  }

  it('负自证：`时机 绝顶 恶作剧：`（带空格）落不到 B2——第二词被当指令名消费', () => {
    const src = doc('时机 绝顶 恶作剧：');
    expect(errsOf(src).map((e) => e.code)).toContain('timing-instruction-unknown');
    // fail-closed：解析编号失败 ⇒ 一个字都不产出（无 B2、亦无 B）
    const erb = productOf(src);
    expect(erb).not.toContain('M_KOJO_MESSAGE_PALAMCNG_B2_K12');
    expect(erb).not.toContain('M_KOJO_MESSAGE_PALAMCNG_B_K12');
  });
});
