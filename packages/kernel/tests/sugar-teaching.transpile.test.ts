/**
 * 教学样例 `fixtures/sugar/teaching-full.kojo` 的**真实链路转译验收**。
 *
 * ## 它守什么
 *
 * 教学样例是全语法面的活文档——每种糖写法各出现一次，旁边的中文注释逐条讲规则。
 * 这类文件最怕两件事：① 转译器某次改动后**悄悄编译不过**（教学文档变成误导）；
 * ② 产物 golden 悄悄漂移（作者在样例旁边看到的 `.erb` 与转译器真实输出不一致）。
 * 故本测试走**生产链路**（内核 + eratw-adapter 真实 CSV 字典 + kojo-sugar 转译服务），
 * 断言零 error 诊断，并与 golden 逐字节比对。
 *
 * ## golden 维护
 *
 * `TEACHING_GOLDEN_WRITE=1` 时把当前产物写回
 * `fixtures/sugar/teaching-full.expected.erb`（人工过目后再提交）。
 *
 * 真实游戏数据不入库：`KOJO_SMOKE_PROJECT` 未设置时整组跳过（CI 安全）。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as nodeJoin, resolve as nodeResolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SugarTranspileResult, SugarTranspileService } from '@kojo/plugin-api';
import { WellKnownServices } from '@kojo/plugin-api';
import { createKernel, type Kernel } from '../src/kernel';
import { NodeBridge } from './helpers/node-bridge';
import { MemoryStorageBackend } from './helpers/memory-storage';
import { createErbParserPlugin } from '@kojo/plugin-erb-parser';
import { createEratwAdapterPlugin } from '@kojo/plugin-eratw-adapter';
import { createConditionExtractorPlugin } from '@kojo/plugin-condition-extractor';
import { createKojoSugarPlugin } from '@kojo/plugin-kojo-sugar';

const SMOKE_DIR = process.env.KOJO_SMOKE_PROJECT;

const FIXTURE = nodeResolve(__dirname, '../../../fixtures/sugar/teaching-full.kojo');
const GOLDEN = nodeResolve(__dirname, '../../../fixtures/sugar/teaching-full.expected.erb');

describe.skipIf(!SMOKE_DIR)('教学样例 · 真实链路转译（teaching-full.kojo）', () => {
  it('转译零 error 诊断，且与 golden 逐字节一致', async () => {
    const appData = mkdtempSync(nodeJoin(tmpdir(), 'kojo-teach-'));
    const kernel: Kernel = await createKernel({
      platform: new NodeBridge(appData),
      plugins: [
        createErbParserPlugin(),
        createEratwAdapterPlugin(),
        createConditionExtractorPlugin(),
        createKojoSugarPlugin(),
      ],
      storageBackend: new MemoryStorageBackend(),
    });
    await kernel.start();
    await kernel.project.open(SMOKE_DIR!);

    const sugar = kernel.services.get<SugarTranspileService>(WellKnownServices.SugarTranspile);
    const source = readFileSync(FIXTURE, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

    const result: SugarTranspileResult = sugar.transpile(source, { filePath: FIXTURE });

    // ---- 1) 诊断守门：error 一个都不许有；warning 打印出来给人看（教学样例应当零告警） ----
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    const warnings = result.diagnostics.filter((d) => d.severity === 'warning');
    if (warnings.length > 0 || errors.length > 0) {
      console.log('---- 转译诊断 ----');
      for (const d of result.diagnostics) {
        console.log(`  [${d.severity}] ${d.code} @${d.loc?.line ?? '?'}: ${d.message}`);
      }
    }
    expect(errors).toEqual([]);

    // ---- 2) golden 守门 ----
    if (process.env.TEACHING_GOLDEN_WRITE === '1') {
      writeFileSync(GOLDEN, result.erb);
      console.log(`golden 已写回：${GOLDEN}`);
    } else if (existsSync(GOLDEN)) {
      expect(result.erb).toBe(readFileSync(GOLDEN, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'));
    } else {
      throw new Error(`golden 不存在：${GOLDEN}（先 TEACHING_GOLDEN_WRITE=1 生成并人工过目）`);
    }

    // ---- 3) 结构冒烟：产物必须包含教学样例声称覆盖的关键形态 ----
    // （声明了 `口上: 教学示例`，函数名走别人版模板：族名 `_教学示例` 在段中。）
    const erb = result.erb;
    const mustContain = [
      '@M_KOJO_教学示例_MESSAGE_COM_K12_310', // 指令 310 主函数（别人版命名）
      'IF TALENT:TARGET:恋慕', // 如果 她的恋慕 → TALENT:恋慕
      'SELECTCASE TFLAG:193', // 当
      'RAND:2', // 随机块
      'SETCOLOR 0xFF8080', // 着色块
      'RESETCOLOR', // 着色块收尾
      'CALL HPH_PRINT', // 心形
      '\n\tPRINTFORMW\n', // 空行（v1.4）：裸指令、**不带尾随空格**
      'CASEELSE', // 当/随机的兜底
      '; .kojo 教学样例', // 头部注释保留到产物最前（用户第 3 条）
      '@MY_TOOL_FUNCTION', // 原生直通块
      '%CALLNAME:15%', // 角色别名展开
      '小露、小露', // 字符串字面量别名展开（裸文本，不带引号/括号）
    ];
    for (const needle of mustContain) {
      expect(erb).toContain(needle);
    }
  }, 120_000);
});
