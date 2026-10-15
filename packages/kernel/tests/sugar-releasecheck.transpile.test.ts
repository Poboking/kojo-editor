/**
 * 发版验证样例 `fixtures/sugar/release-check.kojo` 的**全语法面守门**。
 *
 * ## 为什么要有这一件（发版判据①的自动化半边）
 *
 * 判据①是「`.kojo` 编辑 → 保存 → 编译 → 真实游戏可跑」。它的实机半边记在
 * `docs/MANUAL-CHECKLIST-v0.4.0-beta.1.md`，而**编译半边必须机器可证**——否则"能跑"
 * 全靠人手工试一份几百行的样例，试到哪算哪。
 *
 * 与教学样例守门（`sugar-teaching.transpile.test.ts`）的分工：教学样例每种写法各一个、
 * 给人读；本文件把写法混在真实口上结构里长跑，并且**把"覆盖全不全"做成断言**：
 *
 * - 关键字表（`keywords.ts` 的 `KEYWORDS`，转译器与编辑器词表的单一真源）里
 *   每个语义 id 的**中文主形必须逐字出现**；
 * - 中文运算符逐个出现；`续` / `不在` 出现；
 * - adapter 分野表（`KojoFaceTable.faces`）里**每个时机分野**都要以 `时机 <分野>` 出现；
 * - 命名参数 `成否:` / `类型:` 的取值逐个出现。
 *
 * ⇒ 以后**新增一个关键字或分野，若没在发版样例里用过，这里直接红**——
 * 覆盖率不靠人记得住（同 `IMPLEMENTATION-LOG` §5.62/§5.67 的"尺子跟着能力长"）。
 *
 * ## golden 维护
 *
 * `RELEASE_GOLDEN_WRITE=1` 时把当前产物写回 `release-check.expected.erb`（人工过目后再提交）。
 *
 * 真实游戏数据不入库：`KOJO_SMOKE_PROJECT` 未设置时整组跳过（CI 安全）。
 */

import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
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
import {
  SUGAR_LEXICON_WORDS,
  SUGAR_LEXICON_OPERATORS,
  CONT_MARKS,
  sugarEditorLexicon,
} from '@kojo/plugin-kojo-sugar';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';

const SMOKE_DIR = process.env.KOJO_SMOKE_PROJECT;

const FIXTURE = nodeResolve(__dirname, '../../../fixtures/sugar/release-check.kojo');
const GOLDEN = nodeResolve(__dirname, '../../../fixtures/sugar/release-check.expected.erb');

/**
 * 头部声明 / 文件头选项的英文别名（`char` / `family` / `title` … / `function-prefix`）
 * **不在本文件里断言**：一份 `.kojo` 只能声明一次头部，中英两套无法同时出现在同一份长跑
 * 样例里（`函数前缀:` 与 `char:` 同属"文件头选项"一类，且它会改写**全文件**的用户函数名，
 * 样例里再写一遍英文形只会让产物名与缺省口径分叉）。
 * 它们的等价性由 `kojo-sugar/tests/transpile.test.ts` 的头部等价用例、
 * `kojo-sugar/tests/geek-fnprefix.test.ts` 的 `函数前缀:` 中英等价用例证明
 * （同一份中文头部换成英文，产物逐字节相同）——覆盖口径不同，但**不留空**。
 * 中文主形仍受断言管辖：`函数前缀:` 在本样例里真实出现过。
 */
const HEAD_ALIAS_WORDS = new Set([
  'char',
  'family',
  'title',
  'desc',
  'color',
  'player-color',
  'narration-color',
  'switch',
  'alias',
  'function-prefix',
]);

/** 成对结构：产物里每一对都必须配平（未配平 = 游戏里"口上全哑"的那一类事故） */
const PAIRS: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/^\s*IF\b/gm, /^\s*ENDIF\b/gm],
  [/^\s*SELECTCASE\b/gm, /^\s*ENDSELECT\b/gm],
  [/^\s*FOR\b/gm, /^\s*NEXT\b/gm],
  [/^\s*#FUNCTION\b/gm, /^\s*#FUNCTIONEND\b/gm],
  [/^\s*PRINTDATA\w*\b/gm, /^\s*ENDDATA\b/gm],
];

describe.skipIf(!SMOKE_DIR)('发版验证样例 · release-check.kojo', () => {
  it('词表 / 分野 / 运算符覆盖率：发版样例必须真的把每个写法都用过', () => {
    const src = readFileSync(FIXTURE, 'utf8');
    // 注释与空行不算"用过"——把 `;` 开头的行整行剥掉再匹配
    const code = src
      .split('\n')
      .filter((l) => !l.trim().startsWith(';'))
      .join('\n');

    const missingWords = SUGAR_LEXICON_WORDS.filter(
      (w) => !HEAD_ALIAS_WORDS.has(w.word) && !new RegExp(`(^|[\\s,、（(])${w.word}([\\s:：,)（]|$)`, 'm').test(code),
    ).map((w) => `${w.word}（${w.id}）`);
    expect(missingWords, `发版样例里没用到的关键字：${missingWords.join('、')}`).toEqual([]);

    const missingOps = SUGAR_LEXICON_OPERATORS.filter((op) => !code.includes(op));
    expect(missingOps, `发版样例里没用到的中文运算符：${missingOps.join('、')}`).toEqual([]);

    expect(code).toContain('续');
    for (const mark of CONT_MARKS.filter((m) => /^[\u3040-\u30ff\u4e00-\u9fff]/.test(m))) {
      expect(code, `缺少「续」标记词形 ${mark}`).toContain(mark);
    }
    for (const kw of sugarEditorLexicon().notin) expect(code, `缺少范围取反词形 ${kw}`).toContain(kw);

    const faces = Object.keys(createEratwFaceTable().faces);
    expect(faces.length).toBeGreaterThan(10);
    // 块头是 `时机 <分野> [编号] [命名参数]：` ⇒ 分野后面可以是空白、全/半角冒号或行尾。
    // `时机\s+事件` 不会误命中 `时机 特殊事件`（分野前必须紧跟"时机 + 空白"）。
    const missingFaces = faces.filter((f) => !new RegExp(`时机\\s+${f}(\\s|：|:|$)`, 'm').test(code));
    expect(missingFaces, `发版样例里没写到的时机分野：${missingFaces.join('、')}`).toEqual([]);

    // 命名参数：`成否:` 四个取值 + `类型:` 四个取值逐个出现
    for (const v of ['游戏判定', '一定成功', '一定失败', '不执行']) {
      expect(code, `缺少成否位取值 ${v}`).toMatch(new RegExp(`成否:\\s*${v}`));
    }
    for (const v of ['COM', 'SCOM', '自定指令', '自定副指令']) {
      expect(code, `缺少类型段取值 ${v}`).toContain(v);
    }
  });

  it('转译零 error 诊断，产物与 golden 逐字节一致，且结构成对配平', async () => {
    const appData = mkdtempSync(nodeJoin(tmpdir(), 'kojo-rel-'));
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

    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    const warnings = result.diagnostics.filter((d) => d.severity === 'warning');
    if (result.diagnostics.length > 0) {
      console.log('---- 发版样例转译诊断 ----');
      for (const d of result.diagnostics) {
        console.log(`  [${d.severity}] ${d.code} @${d.loc?.line ?? '?'}: ${d.message}`);
      }
    }
    expect(errors).toEqual([]);
    expect(warnings.map((w) => `${w.code}@${w.loc?.line}`), '发版样例应当零告警').toEqual([]);

    if (process.env.RELEASE_GOLDEN_WRITE === '1') {
      writeFileSync(GOLDEN, result.erb);
      console.log(`golden 已写回：${GOLDEN}`);
    } else if (existsSync(GOLDEN)) {
      expect(result.erb).toBe(readFileSync(GOLDEN, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'));
    } else {
      throw new Error(`golden 不存在：${GOLDEN}（先 RELEASE_GOLDEN_WRITE=1 生成并人工过目）`);
    }

    // ---- 结构配平：这就是"游戏加载后口上不会全哑"的静态半边 ----
    for (const [openRe, closeRe] of PAIRS) {
      const open = (result.erb.match(openRe) ?? []).length;
      const close = (result.erb.match(closeRe) ?? []).length;
      expect(close, `产物里 ${openRe.source} 与 ${closeRe.source} 不配平`).toBe(open);
    }
    expect(result.erb).toContain('\nENDIF');

    // ---- 产物内函数名不得重复定义 ----
    // 判据①要"游戏可跑"，重复定义就是加载期事故；而**同一个时机里写两条同义子句**
    // （中文 `隐藏情景` + 英文 `skip-scene`）正是最容易撞出同名函数的一条路径——
    // 本文件的守门第一次跑就靠这条断言抓到了它（见 fixtures 注释）。
    const defs = [...result.erb.matchAll(/^@([A-Za-z0-9_\u4e00-\u9fff]+)/gm)].map((m) => m[1]!);
    const dup = defs.filter((n, i) => defs.indexOf(n) !== i);
    expect(dup, `产物里重复定义的函数：${[...new Set(dup)].join('、')}`).toEqual([]);

    // ---- 产物声称覆盖的关键形态（与 golden 之外的"语义冒烟"） ----
    const mustContain = [
      '@M_KOJO_K145', // 登记三件套（头部 `角色:` 派生）
      '@M_KOJO_发版检查_MESSAGE_COM_K145_310', // 指令面主函数（别人版命名）
      '@M_KOJO_发版检查_ENCOUNTER_K145', // 初见
      '@M_KOJO_发版检查_MESSAGE_SCOM_K145_312', // 类型: SCOM
      '@M_KOJO_发版检查_MESSAGE_CUSTOM_COM_K145_313', // 类型: 自定指令
      '@M_KOJO_发版检查_MESSAGE_CUSTOM_SCOM_K145_314', // 类型: 自定副指令
      '@M_KOJO_发版检查_SUCCESS_COM_K145_310', // 成功 分野
      '@KOJO_发版检查_COM_NAME_K145_270', // 自定指令 NAME 函数（HK-12；编号自动分配 270）
      '@KOJO_发版检查_COM_K145_270', // 自定指令 本体函数（HK-12）
      '@KOJO_发版检查_CAN_COM_K145_270', // 自定指令 可选钩子 `可否使用:`（HK-12 五钩子之 CAN_COM）
      '@KOJO_发版检查_COM_Counter不发_K145_270', // 自定指令 可选钩子 `计数器不发:`（HK-12 五钩子）
      '@M_KOJO_发版检查_CHECK_K145', // 查询面（附录 C #36）
      '@M_KOJO_发版检查_IMAGE_K145_特殊服装(ARGS,ARG,ARG:1)', // 图像面（附录 C #37；运行期形态名原样拼名）
      '@M_KOJO_发版检查_IMAGE_EX_K145_特殊表情(ARGS,ARG,ARG:1)', // 图像扩展面（IMAGE_EX）
      'IF TALENT:TARGET:恋慕', // 如果 她的恋慕（分支条件降糖）
      'ELSEIF', // 否则如果
      'SELECTCASE TFLAG:193', // 当
      'CASEELSE', // 否则
      'RAND:', // 随机块
      'SETCOLOR 0xFF8080', // 着色块
      'CALL HPH_PRINT', // 心形
      'PRINTBUTTON', // 选项块
      'INPUTS', // 选项块输入
      '\\@', // 行内条件降糖
      '%CALLNAME:15%', // 角色别名
      '; 发版验证样例', // 注释保留到产物最前（用户第 3 条）
      '@RELEASE_CHECK_TOOL', // 原生直通块
      '$RELEASE_CHECK_LABEL', // 直通块内的标签
      '#DIM L_TOTAL', // 直通块内的声明
      '@M_KOJO_K145_问候', // 用户函数（B4；命名走 adapter 的 userFunction.template）
      'CALL M_KOJO_K145_回声()', // 用户函数间的调用（零实参 `CALL 产物名()`）
      'IF ONCE("发版检查_初见")', // 初回（1 号任务）→ 引擎 ONCE 访问器
      'SIF CFLAG:TARGET:好感度 >= 500', // 单行条件（5 号任务）→ SIF，紧随一条语句、**不产 ENDIF**
      'CALL ASK_M("好呀",1,"下次吧",0)', // 询问（2 号任务）→ 引擎 ASK_M，逐项 `标签,条件`
      'CALL ASK_YN("开启","关闭")', // 确认（2 号任务）→ 引擎 ASK_YN，纯标签
      '; 常量 发版检查_阈值 = 1200（编译期展开为字面量，不占引擎全局名）', // 常量（7 号任务 → 宏化修订：零引擎足迹）
      'IF 1200 > 3', // 常量名在表达式里当**只读数值**用（裸名直接展开成字面量）
    ];
    for (const needle of mustContain) {
      expect(result.erb, `产物缺少 ${needle}`).toContain(needle);
    }

    await kernel.stop();
  }, 180_000);
});
