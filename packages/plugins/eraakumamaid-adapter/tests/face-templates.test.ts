/**
 * eraAkumaMaid 时机分野模板表（`KojoFaceTable`）——收录面回归（v0.3 S2 批）。
 *
 * 断言口径：模板**逐字**对 `C:/game/eraAkumaMaid` 语料实测（路由调用点 +
 * 定义处行号见 `src/face-templates.ts` 各条目注释）。这是"游戏知识只进
 * adapter"的可执行凭证——模板若漂移，此处先红。
 *
 * 与 eratw 版测试的**形态差异**（本品读本表的前提）：
 * 1. AM 是**后缀式命名**（`{面}_K{n}`），无 `{t}` 家族段、无 `{i}` 编号槽、
 *    无 `${com}` 上下文段 ⇒ 本文件用「全表扫描无占位残迹」钉死这三件事，
 *    而非逐面钉 `{i}` 字段值（eratw 那边是逐面钉 `indexKind`/`autoIndex`）。
 * 2. AM 共收 22 个面（首批 10 = 调教主链路 9 + 日常域 1；2026-10-19 P5 增量批 12）
 *    ⇒ 未收录关键字（eraTW 面 + AM 确实没有的面）必须在表外，保证
 *    `timing-face-unknown` fail-closed 不产半成品。
 */

import { describe, expect, it } from 'vitest';
import type { KojoFaceTable, KojoFaceTemplate } from '@kojo/plugin-api';
import { createErakumamaidFaceTable } from '../src/face-templates';

const table = createErakumamaidFaceTable();

/**
 * 复刻 kojo-sugar `buildFunctionName`（`kojo-sugar/src/codegen.ts:1160`）的
 * 占位符求值路径：`{t}` → 家族段、`{n}` → 角色号；无编号令牌时剥离 `_{i}` 段。
 * AM 模板三者皆无（仅 `{n}`），本函数只为**逐字节**复刻转译器拼名口径而存在
 * （糖层零游戏知识，拼名结果由适配器模板唯一决定）。
 */
function buildName(template: string, charNo: string): string {
  let name = template.replace('{t}', '').replace('{n}', charNo);
  name = name.replace(/_(?:\{i\})/g, '').replace(/\{i\}/g, '').trim();
  if (name.endsWith('_')) name = name.slice(0, -1);
  return name;
}

/** 复刻 kojo-sugar `renderUserFunctionName`（`codegen.ts:1947`）：`{n}`/`{name}` 全局替换 */
function renderUserFn(template: string, charNo: string, name: string): string {
  return template.replace(/\{n\}/g, charNo).replace(/\{name\}/g, name);
}

describe('KojoFaceTable · 分野模板（eraAkumaMaid 后缀式命名）', () => {
  it('收录面恰好 22 个（首批 10 + 2026-10-19 增量 12），键集合逐字钉死', () => {
    expect(Object.keys(table.faces).sort()).toEqual(
      [
        // 首批：调教主链路 9 + 日常域 1
        '指令',
        '指令前',
        '参数变动',
        '标记',
        '计数器',
        '事件',
        '射精',
        '绝顶',
        '射精与绝顶',
        '日常',
        // 2026-10-19 P5 增量批 12
        '客人',
        '指令后',
        '问候',
        '日常指令',
        '日期',
        '愿望',
        '商店',
        '交流',
        '角色介绍',
        '射精后',
        '对方射精前',
        '大喜欢',
      ].sort(),
    );
  });

  it('每个收录面的 template 逐字符合语料（路由 = EVENT_K.ERB 主路由 / EVENT_K_DAILY.ERB 日常域）', () => {
    const expectFaces: Record<string, string> = {
      // EVENT_K.ERB:25（六九特例 :39 / 97 特例 :43）`TRYCALLFORM KOJO_MESSAGE_COM_K{NO:TARGET}`
      指令: 'KOJO_MESSAGE_COM_K{n}',
      // EVENT_K.ERB:72 `TRYCALLFORM KOJO_MESSAGE_BEFORE_COM_K{NO:TARGET}`
      指令前: 'KOJO_MESSAGE_BEFORE_COM_K{n}',
      // EVENT_K.ERB:97 `TRYCALLFORM KOJO_MESSAGE_PALAMCNG_K{NO:TARGET}, LOCALS`
      参数变动: 'KOJO_MESSAGE_PALAMCNG_K{n}',
      // EVENT_K.ERB:453 `TRYCALLFORM KOJO_MESSAGE_MARKCNG_K{NO:TARGET}, ARGS`
      标记: 'KOJO_MESSAGE_MARKCNG_K{n}',
      // EVENT_K.ERB:434 `TRYCALLFORM KOJO_COUNTER_K{NO:TARGET}, ARGS`
      计数器: 'KOJO_COUNTER_K{n}',
      // EVENT_K.ERB:483 `TRYCALLFORM KOJO_EVENT_K{NO:TARGET}, ARGS`
      事件: 'KOJO_EVENT_K{n}',
      // EVENT_K.ERB:379 `TRYCALLFORM KOJO_MESSAGE_SHOOT_K{NO:TARGET}`
      射精: 'KOJO_MESSAGE_SHOOT_K{n}',
      // EVENT_K.ERB:21 `TRYCALLFORM KOJO_MESSAGE_COMING_K{NO:TARGET}`（路由注释「絶頂口上」）
      绝顶: 'KOJO_MESSAGE_COMING_K{n}',
      // EVENT_K.ERB:344 `TRYCALLFORM KOJO_MESSAGE_SAMEN_AND_EXTACY_K{NO:TARGET}`
      射精与绝顶: 'KOJO_MESSAGE_SAMEN_AND_EXTACY_K{n}',
      // EVENT_K_DAILY.ERB:56 `TRYCALLFORM KOJO_DAILY_K{NO:TARGET}, STR:イベント名`
      日常: 'KOJO_DAILY_K{n}',
      // ---- 2026-10-19 P5 增量批（路由行号即证据）----
      // EVENT_K.ERB:525（两条路由 `{NO:ASSI}` / `{NO:TARGET}`）
      客人: 'KOJO_GUEST_K{n}',
      // EVENT_K.ERB:55
      指令后: 'KOJO_ENDCOM_K{n}',
      // EVENT_K_DAILY.ERB:149
      问候: 'KOJO_GREETING_K{n}',
      // EVENT_K_DAILY.ERB:279
      日常指令: 'KOJO_DAILYCOM_K{n}',
      // EVENT_K_DAILY.ERB:380（另有 `_ADDSELECT` 兄弟函数，不是本面的编号尾）
      日期: 'KOJO_DATE_K{n}',
      // EVENT_K_DAILY.ERB:412
      愿望: 'KOJO_WISH_K{n}',
      // EVENT_K_DAILY.ERB:436
      商店: 'KOJO_SHOP_K{n}',
      // EVENT_K_COMM.ERB:36（第三个路由文件）
      交流: 'KOJO_COMM_K{n}',
      // EVENT_K_DAILY.ERB:15 —— 全表唯一不带 `KOJO_` 前缀的面
      角色介绍: 'EVENT_PROFILE_K{n}',
      // EVENT_K.ERB:399（射精箇所選択**直後**；`射精` 是直前，两面不同）
      射精后: 'KOJO_MESSAGE_AFTERSHOOTCHANGE_K{n}',
      // EVENT_K.ERB:417（TARGET 射精直前）
      对方射精前: 'KOJO_MESSAGE_BEFORE_TARGETSHOOT_K{n}',
      // EVENT_K.ERB:362（caller 只有 TRAIN/EVENT_SHOOT.ERB:1237）
      大喜欢: 'KOJO_MESSAGE_DAISYUKI_K{n}',
    };
    for (const [face, template] of Object.entries(expectFaces)) {
      expect(table.faces[face], `分野「${face}」`).toBeDefined();
      expect(table.faces[face]!.template, `分野「${face}」的模板`).toBe(template);
    }
  });

  it('拼名结果逐字节钉死：代入 {n} 后即引擎真实函数名（多角色号抽样）', () => {
    // 形态复刻 buildFunctionName：AM 模板仅 {n} 一个占位 ⇒ 拼名 = 模板文本替换
    const expectNames: Array<[string, string, string]> = [
      // [分野, 角色号, 期望函数名] —— 期望值均取自语料中的真实定义行
      ['指令', '1', 'KOJO_MESSAGE_COM_K1'], // EVENT_K1.ERB:233
      ['指令', '65', 'KOJO_MESSAGE_COM_K65'],
      ['指令', '100', 'KOJO_MESSAGE_COM_K100'], // 100 パトラ（最大编号）
      ['指令前', '1', 'KOJO_MESSAGE_BEFORE_COM_K1'], // EVENT_K1.ERB:3333
      ['参数变动', '1', 'KOJO_MESSAGE_PALAMCNG_K1'], // EVENT_K1.ERB:3342
      ['标记', '1', 'KOJO_MESSAGE_MARKCNG_K1'], // EVENT_K1.ERB:3686
      ['计数器', '1', 'KOJO_COUNTER_K1'], // EVENT_K1.ERB:3929
      ['事件', '1', 'KOJO_EVENT_K1'], // EVENT_K1.ERB:3953
      ['射精', '1', 'KOJO_MESSAGE_SHOOT_K1'], // EVENT_K1.ERB:3720
      ['绝顶', '65', 'KOJO_MESSAGE_COMING_K65'], // EVENT_K65.ERB:630（9 实装角色之一）
      ['射精与绝顶', '1', 'KOJO_MESSAGE_SAMEN_AND_EXTACY_K1'], // EVENT_K1.ERB:3750
      ['日常', '1', 'KOJO_DAILY_K1'], // EVENT_K1_DAILY.ERB:245
      // 增量批抽样：一个普通面 + 一个"前缀不同"的面
      ['交流', '1', 'KOJO_COMM_K1'], // EVENT_K1_COMM.ERB:6
      ['角色介绍', '1', 'EVENT_PROFILE_K1'], // EVENT_K1.ERB:69
    ];
    for (const [face, charNo, expected] of expectNames) {
      expect(buildName(table.faces[face]!.template, charNo), `分野「${face}」× K${charNo}`).toBe(expected);
    }
  });

  it('全表无 `{i}` / `{t}` / `${段}` 占位残迹（AM 后缀式命名三无）', () => {
    for (const [face, spec] of Object.entries(table.faces)) {
      expect(spec.template.includes('{i}'), `分野「${face}」不应含编号槽 {i}`).toBe(false);
      expect(spec.template.includes('{t}'), `分野「${face}」不应含家族段 {t}`).toBe(false);
      expect(/\$\{/.test(spec.template), `分野「${face}」不应含上下文段`).toBe(false);
    }
  });

  it('AM 无编号尾槽 ⇒ 全表不声明 indexKind / autoIndex（eraTW 式 {i} 语义不存在）', () => {
    // 反例钉死：eraTW 的 事件(autoIndex) / 计数器(counter) / 图像(literal) 三形态
    // 在 AM 全无对应——编号要么不在函数名里（指令/事件/计数器类型走运行期
    // SELECTCOM/ARGS），要么是引擎键值语义（不可自动分配）。
    for (const [face, spec] of Object.entries(table.faces)) {
      expect(spec.indexKind, `分野「${face}」`).toBeUndefined();
      expect(spec.autoIndex, `分野「${face}」`).toBeUndefined();
    }
  });

  it('`计数器` 面**不声明** `indexKind: \'counter\'`（AM 计数器类型是 ARGS 字符串，函数名无编号尾）', () => {
    // 决策记录：counter/mutator/library 三张表本批未交付，但 AM 的计数器面
    // 模板 `KOJO_COUNTER_K{n}` 根本没有 `{i}` 槽（`paramIndex=false` ⇒ 编号
    // 令牌永不进函数名、永不查表）⇒ 名路径与计数器表零依赖，收面即安全。
    // 声明 'counter' 反而违背契约（indexKind 是「{i}」槽口径，无槽不可声明）。
    const counter = table.faces['计数器']!;
    expect(counter.template).toBe('KOJO_COUNTER_K{n}');
    expect(counter.indexKind).toBeUndefined();
  });

  it('AM 无 SUCCESS / MESSAGECHECK / 上下文段概念 ⇒ 各面 success / messageCheck / segments 全缺省', () => {
    for (const [face, spec] of Object.entries(table.faces)) {
      expect(spec.success, `分野「${face}」`).toBeUndefined();
      expect(spec.messageCheck, `分野「${face}」`).toBeUndefined();
      expect(spec.segments, `分野「${face}」`).toBeUndefined();
    }
  });

  it('未收录的分野关键字不在表内（eraTW 独有面 → timing-face-unknown fail-closed）', () => {
    const absent: Record<string, string> = {
      // eraTW 有、AM 没有对应路由面（每条都经语料核对过"确实不存在"）
      初见: 'eraTW 附录 C #1（AM 无 ENCOUNTER 路由面）',
      礼物: 'eraTW A4 补面',
      触手: 'eraTW A4 补面（AM PALAMCNG 合流，无独立触手段）',
      日记: 'eraTW 附录 C #21（AM 无 DIARY 族）',
      追加源: 'eraTW 附录 C #10',
      成功: 'eraTW 附录 C #13（AM 无 SUCCESS 函数）',
      撞见: 'eraTW 附录 C #12',
      推倒许可: 'eraTW 附录 C #14',
      破瓜中止: 'eraTW 附录 C #15',
      走光: 'eraTW 附录 C #28',
      结局: 'eraTW 附录 C #29',
      开关初始化: 'eraTW 附录 C #11',
      查询: 'eraTW 附录 C #36',
      图像: 'eraTW 附录 C #37',
      图像扩展: 'eraTW 附录 C #37',
      特殊事件: 'eraTW 附录 C #2',
      自定义事件: 'eraTW 附录 C #3',
      绝顶恶作剧: 'eraTW P-6 子面',
      调教后: 'eraTW P-6 子面',
      寸止: 'eraTW P-6 子面',
      房间描述: 'eraTW A4 补面',
      游玩指南: 'eraTW A4 补面',
      游玩指南存在: 'eraTW A4 补面',
      游玩指南结果: 'eraTW A4 补面',
    };
    for (const [face, why] of Object.entries(absent)) {
      expect(table.faces[face], `分野「${face}」不应收录（${why}）`).toBeUndefined();
    }
  });

  it('表级 optional 字段整个缺省（AM 无登记三件套 / 成否位 / MESSAGECHECK / 自定指令段 / 自机色 / 钩子 / 问答）', () => {
    expect(table.registration).toBeUndefined();
    expect(table.successFlag).toBeUndefined();
    expect(table.messageCheck).toBeUndefined();
    expect(table.customComRange).toBeUndefined();
    expect(table.playerColor).toBeUndefined();
    expect(table.customHooks).toBeUndefined();
    expect(table.ask).toBeUndefined();
  });

  it('用户自定义函数命名模板 = `K{n}_{name}`（AM 惯例：每角色 K{编号}_ 前缀私货族）', () => {
    expect(table.userFunction).toBeDefined();
    const tpl = table.userFunction!.template;
    expect(tpl).toBe('K{n}_{name}');
    // 拼名逐字节钉死（复刻 renderUserFunctionName；形态 = 语料真实定义）
    expect(renderUserFn(tpl, '1', 'KOJO2')).toBe('K1_KOJO2'); // EVENT_K1.ERB:164
    expect(renderUserFn(tpl, '15', '興奮度Calc')).toBe('K15_興奮度Calc'); // 添い寝コマンド処理.ERB:297
    expect(renderUserFn(tpl, '29', 'LONG_ED1')).toBe('K29_LONG_ED1'); // EVENT_K29_LONG.ERB:7
  });

  it('表形态自洽：每个模板都是 `{名}_K{n}` 后缀式、且 `{n}` 恰好出现一次', () => {
    for (const [face, spec] of Object.entries(table.faces)) {
      // 前缀只有两种：`KOJO_…`（21 面）与 `EVENT_PROFILE`（角色介绍——本表唯一不带
      // `KOJO_` 前缀的面，语料就是这个名字，不是笔误）。
      expect(spec.template, `分野「${face}」的模板形态`).toMatch(/^(KOJO|EVENT)_[A-Z0-9_]+_K\{n\}$/);
      expect(spec.template.split('{n}').length - 1, `分野「${face}」的 {n} 个数`).toBe(1);
    }
  });

  it('纯数据无 IO：两次构建产出深相等（转译器每次转译重复取用同构）', () => {
    const again = createErakumamaidFaceTable();
    expect(again.faces).toEqual(table.faces);
    expect(again.userFunction).toEqual(table.userFunction);
  });
});

/** 编译期形状守门：表必须满足契约（键值类型漂移在此先红） */
const _typeGate: KojoFaceTable = table;
const _faceGate: Readonly<Record<string, KojoFaceTemplate>> = table.faces;
void _typeGate;
void _faceGate;
