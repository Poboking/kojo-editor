/**
 * HK-12 · 自定指令块转译单测（`自定指令 <名> [编号: N]：` → NAME / ABLE / 本体 函数组）。
 *
 * 组织：生成形态（三函数 + 骨架）→ 命名（标准版 / 别人版）→ 编号（自动分配 /
 * 防撞车 / 改名不改号 / 显式优先 / 段耗尽 / 缺段）→ 缺钩子告警 →
 * 「名 → 编号」中文指令名路径（用**假 CSV/Train.csv** 驱动，含 BOM + `;` 注释行诱饵）。
 *
 * 所有断言直接对着产物字符串（不依赖快照），失败信息足以定位到具体规则。
 */

import { describe, expect, it } from 'vitest';
import type { KojoFaceTable, KojoInstructionTable } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

/** 转译服务（注入分野表；可选指令表） */
const svc = (faceTable: KojoFaceTable = stubFaceTable(), instructionTable?: KojoInstructionTable) =>
  createSugarTranspileService({
    dictionary: stubDict,
    faceTable,
    ...(instructionTable ? { instructionTable } : {}),
  });
const t = (src: string) => svc().transpile(src);
const codes = (src: string) => t(src).diagnostics.map((d) => d.code);

/* ============================================================================ */
/* 生成形态：NAME / ABLE / 本体 三函数                                            */
/* ============================================================================ */

describe('HK-12 自定指令 · NAME/ABLE/本体 函数组', () => {
  it('标准版：三函数 + 記入チェック骨架；NAME 的 RESULTS 是**裸中文名**（不带引号）', () => {
    const { erb, diagnostics } = t('角色: 12\n自定指令 赛钱：\n    「要赛钱吗？」\n');
    expect(erb).toContain('@KOJO_COM_NAME_K12_270');
    expect(erb).toContain('RESULTS = 赛钱');
    expect(erb).not.toContain('RESULTS = "赛钱"'); // 对齐真实语料：裸中文
    expect(erb).toContain('@KOJO_COM_ABLE_K12_270');
    expect(erb).toContain('@KOJO_COM_K12_270');
    // 本体与时机块同款骨架
    expect(erb).toContain(';記入チェック（=0, 非表示、1, 表示）');
    expect(erb).toContain('LOCAL = 1');
    expect(erb).toContain('IF LOCAL');
    expect(erb).toContain('ENDIF');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('别人版：家族段进入三函数名（与真实语料 `KOJO{t}_COM_NAME_K{n}_{编号}` 逐字一致）', () => {
    const { erb } = t('角色: 1\n口上: 少女之梦\n自定指令 赛钱：\n    「要赛钱吗？」\n');
    expect(erb).toContain('@KOJO_少女之梦_COM_NAME_K1_270');
    expect(erb).toContain('@KOJO_少女之梦_COM_ABLE_K1_270');
    expect(erb).toContain('@KOJO_少女之梦_COM_K1_270');
  });

  it('ABLE 缺省放行（`RETURN 1`）——契约无 ABLE 子句', () => {
    const { erb } = t('角色: 12\n自定指令 赛钱：\n    「a」\n');
    const ableAt = erb.indexOf('@KOJO_COM_ABLE_K12_270');
    expect(ableAt).toBeGreaterThanOrEqual(0);
    expect(erb.slice(ableAt, ableAt + 60)).toContain('RETURN 1');
  });

  it('空体合法：`LOCAL = 0` 且不产 IF 块（与时机块同口径）', () => {
    const { erb, diagnostics } = t('角色: 12\n自定指令 赛钱：\n');
    expect(erb).toContain('@KOJO_COM_K12_270');
    expect(erb).toContain('LOCAL = 0');
    expect(erb).not.toContain('IF LOCAL');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('体内语句正常降糖（文本行 → PRINTFORM，与时机体同一套 codegen）', () => {
    const { erb } = t('角色: 12\n自定指令 赛钱：\n    「要赛钱吗？」\n');
    expect(erb).toContain('PRINTFORMW 「要赛钱吗？」');
  });
});

/* ============================================================================ */
/* 编号分配                                                                       */
/* ============================================================================ */

describe('HK-12 自定指令 · 编号分配', () => {
  it('自动分配：同一文件两块 → 270 / 271（customComRange 内取最小未用）', () => {
    const { erb } = t('角色: 12\n自定指令 赛钱：\n    「a」\n自定指令 亲吻：\n    「b」\n');
    expect(erb).toContain('@KOJO_COM_NAME_K12_270');
    expect(erb).toContain('@KOJO_COM_NAME_K12_271');
    expect(erb).toContain('RESULTS = 赛钱');
    expect(erb).toContain('RESULTS = 亲吻');
  });

  it('防撞车：原生 `@` 块已占 270 → 自动跳过、分配 271（原生块原样透传）', () => {
    const src =
      '角色: 12\n' +
      '自定指令 赛钱：\n    「a」\n' +
      '@KOJO_COM_NAME_K12_270\nRESULTS = "手写占号"\n';
    const { erb } = t(src);
    // 自定指令块被让到 271，不与原生块撞名
    expect(erb).toContain('@KOJO_COM_NAME_K12_271');
    expect(erb).toContain('RESULTS = 赛钱');
    // 原生块手写的 270 原样保留
    expect(erb).toContain('@KOJO_COM_NAME_K12_270');
    expect(erb).toContain('RESULTS = "手写占号"');
  });

  it('改名不改号：两个不同名各自转译 → 都落在 270，仅 RESULTS 值不同', () => {
    const a = t('角色: 12\n自定指令 赛钱：\n    「a」\n');
    const b = t('角色: 12\n自定指令 亲吻：\n    「a」\n');
    expect(a.erb).toContain('@KOJO_COM_NAME_K12_270');
    expect(b.erb).toContain('@KOJO_COM_NAME_K12_270');
    expect(a.erb).toContain('RESULTS = 赛钱');
    expect(b.erb).toContain('RESULTS = 亲吻');
  });

  it('显式 `编号: N` 优先于自动分配', () => {
    const { erb, diagnostics } = t('角色: 12\n自定指令 赛钱 编号: 275：\n    「a」\n');
    expect(erb).toContain('@KOJO_COM_NAME_K12_275');
    expect(erb).toContain('@KOJO_COM_ABLE_K12_275');
    expect(erb).toContain('@KOJO_COM_K12_275');
    expect(erb).not.toContain('@KOJO_COM_NAME_K12_270');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('段耗尽 → `custom-command-range-exhausted`，第二块 fail-closed 不产半成品', () => {
    // 可用段收窄到单号；第一块占掉后第二块无号可分
    const faceTable: KojoFaceTable = { ...stubFaceTable(), customComRange: { min: 270, max: 270 } };
    const res = svc(faceTable).transpile('角色: 12\n自定指令 甲：\n    「a」\n自定指令 乙：\n    「b」\n');
    const diag = res.diagnostics.find((d) => d.code === 'custom-command-range-exhausted');
    expect(diag?.severity).toBe('error');
    expect(res.erb).toContain('@KOJO_COM_NAME_K12_270'); // 甲成功
    expect(res.erb).not.toContain('RESULTS = 乙'); // 乙 fail-closed
  });

  it('适配器未声明 customComRange → `custom-command-no-range`（不经自动分配就拒绝）', () => {
    const faceTable: KojoFaceTable = { ...stubFaceTable() };
    delete (faceTable as { customComRange?: unknown }).customComRange;
    expect(codesFor(svc(faceTable), '角色: 12\n自定指令 赛钱：\n    「a」\n')).toContain(
      'custom-command-no-range',
    );
  });

  it('显式 `编号: N` 时无需 customComRange（显式路径不依赖可用段）', () => {
    const faceTable: KojoFaceTable = { ...stubFaceTable() };
    delete (faceTable as { customComRange?: unknown }).customComRange;
    const res = svc(faceTable).transpile('角色: 12\n自定指令 赛钱 编号: 290：\n    「a」\n');
    expect(res.erb).toContain('@KOJO_COM_NAME_K12_290');
    expect(res.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

/* ============================================================================ */
/* 缺钩子模板（face-table-missing warning）                                        */
/* ============================================================================ */

describe('HK-12 自定指令 · 缺钩子模板', () => {
  it('缺 comName/comAble/com 任一 → `face-table-missing` warning 且跳过（不产半成品）', () => {
    const faceTable: KojoFaceTable = { ...stubFaceTable(), customHooks: { canCom: 'KOJO{t}_CAN_COM' } };
    const res = svc(faceTable).transpile('角色: 12\n自定指令 赛钱：\n    「a」\n');
    const diag = res.diagnostics.find((d) => d.code === 'face-table-missing');
    expect(diag?.severity).toBe('warning');
    expect(res.erb).not.toContain('@KOJO_COM_NAME_K12_270');
    expect(res.erb).not.toContain('@KOJO_COM_K12_270');
  });
});

/* ============================================================================ */
/* 中文指令名路径（HK-11②）——用假 CSV/Train.csv 驱动 indexName                    */
/* ============================================================================ */

/**
 * `CSV/Train.csv` 解析的**本地镜像**（本文件测试专用）。
 *
 * 为什么镜像而不是 import：adapter 包 `exports` 仅 `"."`，`parseTrainCsv` /
 * `createEratwInstructionTable` 未从 index 导出 ⇒ 无法子路径 import；且本批
 * 任务限定"只许改这些文件"（adapter 不在内）。故此处**照抄解析铁律**建桩：
 * 去 BOM、`;` 整行跳过（注释）、编号取第一列非行号、同名取首条。
 */
function parseTrainCsv(text: string): Map<string, number> {
  const byName = new Map<string, number>();
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith(';')) continue; // 注释行（含诱饵编号，必须跳过）
    const cols = line.split(',');
    const no = Number(cols[0]);
    if (!Number.isInteger(no)) continue;
    const name = (cols[1] ?? '').trim();
    if (name.length === 0) continue;
    if (!byName.has(name)) byName.set(name, no); // 同名取首条
  }
  return byName;
}

/** 由 `名 → 编号` 记录造一张指令表桩 */
function tableOf(map: Map<string, number>): KojoInstructionTable {
  const byNo = new Map<number, string>();
  for (const [name, no] of map) if (!byNo.has(no)) byNo.set(no, name);
  return {
    hasTable: map.size > 0,
    lookupByName: (n) => map.get(n),
    lookupByNo: (no) => byNo.get(no),
  };
}

/** 便捷：以给定服务转译取诊断码序列 */
function codesFor(service: { transpile: (s: string) => { diagnostics: { code: string }[] } }, src: string): string[] {
  return service.transpile(src).diagnostics.map((d) => d.code);
}

describe('HK-11② · `时机 指令 <中文名>：` 经指令表解析（假 CSV 驱动）', () => {
  // 诱饵：`;999,摸屁股` 若未按注释跳过，`摸屁股` 会错解为 999；
  //       正确跳过注释后首条是 `310,摸屁股`。编号 ≠ 行号，证明"取第一列"。
  const CSV = '\uFEFF;999,摸屁股\n310,摸屁股\n;706,胸愛撫(慰)\n300,会話\n';
  const TABLE = tableOf(parseTrainCsv(CSV));

  it('注释行被跳过、编号取第一列：`摸屁股` → 310', () => {
    expect(TABLE.lookupByName('摸屁股')).toBe(310);
    expect(TABLE.lookupByName('会話')).toBe(300);
    expect(TABLE.lookupByName('胸愛撫(慰)')).toBeUndefined(); // 注释行整条跳过
  });

  it('中文名转译 → `@M_KOJO_MESSAGE_COM_K12_310`（与等价数字写法逐字节一致）', () => {
    const named = svc(stubFaceTable(), TABLE).transpile('角色: 12\n时机 指令 摸屁股：\n    「呀。」\n');
    const numeric = t('角色: 12\n时机 指令 310：\n    「呀。」\n');
    expect(named.erb).toBe(numeric.erb);
    expect(named.erb).toContain('@M_KOJO_MESSAGE_COM_K12_310');
    expect(named.diagnostics).toEqual([]);
  });

  it('表里查不到的名字 → `timing-instruction-unknown`，不猜、不产半成品', () => {
    const res = svc(stubFaceTable(), TABLE).transpile('角色: 12\n时机 指令 魔改新指令：\n    「呀。」\n');
    const diag = res.diagnostics.find((d) => d.code === 'timing-instruction-unknown');
    expect(diag?.severity).toBe('error');
    expect(diag?.message).toContain('未命名指令（编号 魔改新指令）');
    expect(res.erb).not.toContain('@M_KOJO_MESSAGE_COM_K12');
  });

  it('缺指令表 → 中文名同样 fail-closed（缺省 = 不猜）', () => {
    expect(codes('角色: 12\n时机 指令 摸屁股：\n    「呀。」\n')).toContain('timing-instruction-unknown');
  });
});
