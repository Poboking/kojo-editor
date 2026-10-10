#!/usr/bin/env node
/**
 * 合成 fixtures 生成器 —— 供**无真实游戏目录**的贡献者复现"迷你模式"集成冒烟。
 *
 * 产物（全部为**合成数据**，不含任何真实游戏内容）：
 *   fixtures/mini-game/    合成 eraTW 目录骨架（最小 CSV + 少量 ERB）——
 *                          可被 eratw-adapter detect、可索引、可校验、可条件抽取；
 *   fixtures/sugar/       合成 .kojo（规范 §6.1 形态）——表层语法示例。
 *
 * 用途：`packages/kernel/tests/fixtures-mini.test.ts` 直接指向 fixtures/mini-game，
 * 无需 KOJO_SMOKE_PROJECT（真实游戏数据不入库）。
 *
 * 用法：
 *   node tools/gen-fixtures.mjs            # 已存在则不覆盖（保护手工修改）
 *   node tools/gen-fixtures.mjs --force    # 强制重写全部产物
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURES = path.join(ROOT, 'fixtures');
const FORCE = process.argv.includes('--force');

let written = 0;
let skipped = 0;

/** 写文件（默认不覆盖；--force 重写）。内容统一 UTF-8 无 BOM + LF。 */
function write(rel, content) {
  const abs = path.join(FIXTURES, rel);
  if (existsSync(abs) && !FORCE) {
    skipped++;
    return;
  }
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  written++;
  console.log(`  + ${rel}`);
}

/* ------------------------- 合成 ERA/共通 ERB ------------------------- */

const k1Erb = [
  '; 合成 fixture：角色 001 口上骨架（合成数据，非真实角色）',
  '@M_KOJO_K1',
  'RESULTS = ',
  'RETURN 1',
  '',
  '@M_KOJO_REMU_MESSAGE_COM_K1_1',
  ';-------------------------------------------------',
  ';記入チェック（=0, 非表示、1, 表示）',
  'LOCAL = 1',
  ';-------------------------------------------------',
  'IF LOCAL',
  '\tPRINTFORMW 「你好，%CALLNAME:MASTER%。」',
  '\tIF CFLAG:2 >= 50',
  '\t\tPRINTFORMDW 她看起来很高兴。',
  '\tENDIF',
  'ENDIF',
  'RETURN 1',
  '',
  '@M_KOJO_REMU_SUCCESS_COM_K1_1',
  'TFLAG:192 = 0',
  'RETURN 1',
  '',
].join('\n');

const k2Erb = [
  '; 合成 fixture：角色 002 口上骨架（合成数据，非真实角色）',
  '@M_KOJO_K2',
  'RESULTS = ',
  'RETURN 1',
  '',
  '@M_KOJO_NIGO_MESSAGE_COM_K2_1',
  'LOCAL = 1',
  'IF LOCAL',
  '\tPRINTFORMW 「……你好。」',
  '\tIF TALENT:恋慕',
  '\t\tPRINTFORMDW 她悄悄移开了视线。',
  '\tENDIF',
  'ENDIF',
  'RETURN 1',
  '',
].join('\n');

/* -------------------- 合成 .kojo（规范 §6.1 形态） -------------------- */

const sampleKojo = [
  '; 合成样例：规范 §6.1 形态（合成数据，供糖转译/语法示例）',
  '角色: 101',
  '口上色: 0x88AACC',
  '',
  '时机 指令 310 成否: 游戏判定：',
  '    「呀……！」',
  '    她猛地一缩，随后慢慢转过身来。 续',
  '    {她的胆怯 ? "眼眶里浮起一点泪光。" : ""}',
  '',
  '    当 TFLAG:193：',
  '        是 1：',
  '            「不、不要……！」',
  '        是 2, 3：',
  '            「呜……真是的。」',
  '            她红着脸，小声嘟囔着。 续',
  '        否则：',
  '            她什么也没说，只是微微眯起了眼睛。',
  '',
].join('\n');

/* ------------------------------ 生成 ------------------------------ */

console.log(`生成合成 fixtures → ${path.relative(ROOT, FIXTURES)}/`);
if (!FORCE) console.log('（已存在的文件将跳过；--force 强制重写）\n');

console.log('mini-game（合成游戏目录骨架）：');
// CSV/Chara：角色编号 → 显示名/呼び名（番号 行 + 文件名回退双通道）
write(
  'mini-game/CSV/Chara/Chara1 测试角色.csv',
  ['番号,1,', '名前,测试角色,', '呼び名,小测,', '基礎,体力,1000', ''].join('\n'),
);
write(
  'mini-game/CSV/Chara/Chara2 配角.csv',
  ['番号,2,', '名前,配角,', '呼び名,小配,', ''].join('\n'),
);
// CSV 变量名称表（条件抽取的语义标注来源）
write('mini-game/CSV/CFLAG.csv', ['; 合成名称表', '2,好感度', '4,信頼度', ''].join('\n'));
write('mini-game/CSV/Talent.csv', ['; 合成名称表', '3,恋慕', ''].join('\n'));
// ERB：口上路由表 + 口上域文件
write(
  'mini-game/ERB/口上・メッセージ関連/KOJO_MESSAGE.ERB',
  [
    '; 合成 fixture：口上路由表（最小）',
    '@KOJO_MESSAGE_SEND',
    'TRYCALLFORM M_KOJO%KOJO_NAME%_MESSAGE_COM_K{NO:TARGET}_{ARG:1}(ARG:3)',
    'RETURN 1',
    '',
  ].join('\n'),
);
write('mini-game/ERB/口上・メッセージ関連/個人口上/001 Remu/M_KOJO_K1.ERB', k1Erb);
write('mini-game/ERB/口上・メッセージ関連/個人口上/002 Nigo/M_KOJO_K2.ERB', k2Erb);

console.log('\nsugar（合成 .kojo）：');
write('sugar/sample-310.kojo', sampleKojo);

console.log(`\n完成：写入 ${written} 个，跳过 ${skipped} 个。`);
console.log('迷你模式冒烟：node node_modules/vitest/vitest.mjs run packages/kernel/tests/fixtures-mini.test.ts');