/**
 * 「kojo 语法全表」附录（TUT-2 2026-10-16）。
 *
 * 两份教程讲"为什么这样写"，这张表只回答三件事：这个字面怎么写、它编译成什么、
 * 写错了屏上出哪句提示。形态参考 era 系引擎中文文档的「分组参考页 + 索引」，
 * 但内容**只收本编辑器现行实现的写法**——文档里有而代码没有的一律不列。
 *
 * 装配顺序即目录顺序（浮层顶部的目录条按它排）。分三件写是因为一张全表
 * 的行数远超一份散文：`-surface`（文件头 / 时机面 / 块头子句 / 只能原生 / 已知坑）、
 * `-lines`（文本行 / 控制流与语句 / 插值与文本记号）、`-expr`（变量与族 / 别名与常量 /
 * 表达式 / 提示码）。
 *
 * **自证**：`tests/tutorial-reference.test.ts` 把这里的表逐一对账实现里的真表
 * （面键、文件头键、运算符、系统函数名、引擎全局白名单、变量族、提示码闭集），
 * 并把每条样例喂给真转译器比对产物。表与代码不一致时先红的是测试，不是读者。
 */

import type { Tutorial, TutorialSection } from './tutorial-content';
import { SEC_ALIAS_CONST, SEC_DIAGNOSTICS, SEC_EXPRESSIONS, SEC_VARIABLES } from './tutorial-reference-expr';
import {
  SEC_KOJO2_ANCHORS,
  SEC_KOJO2_DECLS,
  SEC_KOJO2_DISPATCH,
  SEC_KOJO2_MIGRATION,
  SEC_KOJO2_SYMBOLS,
  SEC_KOJO2_WAIT,
} from './tutorial-reference-kojo2';
import { SEC_CONTROL_FLOW, SEC_MARKERS, SEC_TEXT_LINES } from './tutorial-reference-lines';
import {
  SEC_BLOCK_PARAMS,
  SEC_FACES,
  SEC_HEAD_KEYS,
  SEC_NATIVE_ONLY,
  SEC_PITFALLS,
} from './tutorial-reference-surface';

/** 图例：不列写法，只教怎么读这张表 */
const SEC_HOW_TO_READ: TutorialSection = {
  heading: '这张表怎么读',
  paragraphs: [
    '两份教程讲「为什么这样写」，这张表只回答三件事：字面怎么写、编译成什么、写错了屏上出哪句提示。教程里讲过的这里也收，但只给条目不给讲解——要理解回教程，要查字面留在这里。',
    '表里的尖括号是**要你替换的部分**：`角色: <编号>` 的意思是把尖括号整块换成数字，其余一字不动。产物名字里的 `{n}` `{t}` `{i}` 是占位：`{n}` 是角色编号，`{t}` 是家族名段（写了 `口上:` 才有它），`{i}` 是时机编号。',
    '冒号分两种。块头（`时机 …：`）要**全角**冒号；文件头的键（`角色:`）全角半角都认。列「必填」那一栏同时写了缺省行为：不填会怎样、填错了会不会提醒你。',
    '提示原文一律照屏上原样抄，不改字。你在底部「.kojo1 校验」面板里看到什么，这里就是什么，可以直接拿它对着查。',
  ],
};

/** 内容件按「」写标题；目录条目直接用标题字面，这里剥掉书名号，屏上不留两层装饰 */
const unquote = (s: TutorialSection): TutorialSection => ({
  ...s,
  heading: s.heading.replace(/^「/u, '').replace(/」$/u, ''),
});

/** 目录顺序 = 数据顺序：先查头与面，再查行与流控，再查变量与表达式，最后查提示与坑；
 *  末尾六节是 2.0（`.kojo` / `.kojo2`）那一族，与前面十三节（`.kojo1`）的字面互不相干 */
const SECTIONS: TutorialSection[] = [
  SEC_HOW_TO_READ,
  unquote(SEC_HEAD_KEYS),
  unquote(SEC_FACES),
  unquote(SEC_BLOCK_PARAMS),
  unquote(SEC_TEXT_LINES),
  unquote(SEC_CONTROL_FLOW),
  unquote(SEC_VARIABLES),
  unquote(SEC_ALIAS_CONST),
  unquote(SEC_EXPRESSIONS),
  unquote(SEC_MARKERS),
  unquote(SEC_NATIVE_ONLY),
  unquote(SEC_DIAGNOSTICS),
  unquote(SEC_PITFALLS),
  unquote(SEC_KOJO2_ANCHORS),
  unquote(SEC_KOJO2_DISPATCH),
  unquote(SEC_KOJO2_DECLS),
  unquote(SEC_KOJO2_WAIT),
  unquote(SEC_KOJO2_MIGRATION),
  unquote(SEC_KOJO2_SYMBOLS),
];

export const REFERENCE_TUTORIAL: Tutorial = {
  id: 'reference',
  title: 'kojo 语法全表（附录）',
  lead: '十三张表查 `.kojo1` 的 kojo1 写法，末尾六张查 `.kojo` / `.kojo2` 的 2.0 写法：怎么写、撞上时屏上出哪句原话。查字面用这张表，学写法回那两本教程。',
  sections: SECTIONS,
};
