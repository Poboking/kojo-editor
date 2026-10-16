/**
 * 事件编号自动分配（面声明 `autoIndex`）单测。
 *
 * 口径（与 HK-12 自定指令分配同形）：
 * - 面由 **adapter 的 face 表**声明"编号可自动分配"（eraTW：`事件`）——转译器不硬编码
 *   任何族名；未声明的面省略编号时行为与旧版逐字节相同；
 * - 占号 = 本文件原生 `@` 直通块里本族函数头的数字尾 + 本文件显式数字编号的同族时机
 *   （**全文档**扫——后写的显式编号也不许被前面的省略编号抢）；
 * - 分配 = 从 1 起最小未用；同文件两个省略编号不撞；显式编号路径逐字节不变；
 * - 分配出来的编号走与手写编号**同一条**命名链（`buildFunctionName`）。
 *
 * 断言直接对着产物函数头行（不依赖快照），**整行相等**比较——防 `_1` 误撞 `_1_1` 子串。
 */

import { describe, expect, it } from 'vitest';
import type { KojoFaceTable } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

/** 转译服务（注入分野表） */
const svc = (faceTable: KojoFaceTable = stubFaceTable()) =>
  createSugarTranspileService({ dictionary: stubDict, faceTable });
const t = (src: string) => svc().transpile(src);

/** 产物里的函数头行（第 1 列 `@名字`）；带缩进的行不是函数头 */
const headLines = (erb: string) => erb.split('\n').filter((line) => line.startsWith('@'));
/** 某个函数头行的出现次数（唯一性 / 防撞车断言用） */
const headCount = (erb: string, head: string) => headLines(erb).filter((l) => l === head).length;
/** 产物里 `事件` 族的全部函数头行（含 `_1` 本体行） */
const eventHeads = (erb: string) => headLines(erb).filter((l) => l.includes('_EVENT_K12'));

describe('事件编号自动分配 · 基本分配', () => {
  it('① 空文件省略编号 → `_1`（最小未用从 1 起）', () => {
    const { erb, diagnostics } = t('角色: 12\n时机 事件：\n    「甲。」\n');
    expect(headLines(erb)).toContain('@M_KOJO_EVENT_K12_1');
    expect(headLines(erb)).toContain('@M_KOJO_EVENT_K12_1_1');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('② 已有 `_1` / `_3` → 省略编号补 `_2`（补空位，不是排到末尾）', () => {
    const { erb } = t(
      '角色: 12\n' +
        '时机 事件 1：\n    「一」\n' +
        '时机 事件 3：\n    「三」\n' +
        '时机 事件：\n    「补」\n',
    );
    expect(headLines(erb)).toContain('@M_KOJO_EVENT_K12_2');
    expect(headCount(erb, '@M_KOJO_EVENT_K12_2')).toBe(1);
  });

  it('③ 同一文件两个省略编号不撞车 → `_1` 与 `_2`', () => {
    const { erb } = t('角色: 12\n时机 事件：\n    「甲」\n时机 事件：\n    「乙」\n');
    expect(headCount(erb, '@M_KOJO_EVENT_K12_1')).toBe(1);
    expect(headCount(erb, '@M_KOJO_EVENT_K12_2')).toBe(1);
    // 本体行也各归各的号（`_1_1` / `_2_1` 都在，且不重名）
    expect(headCount(erb, '@M_KOJO_EVENT_K12_1_1')).toBe(1);
    expect(headCount(erb, '@M_KOJO_EVENT_K12_2_1')).toBe(1);
  });

  it('⑦ 语料形态：`_1.._5` 缺 `_2` → 省略编号补 `_2`', () => {
    const { erb } = t(
      '角色: 12\n' +
        '时机 事件 1：\n    「一」\n' +
        '时机 事件 3：\n    「三」\n' +
        '时机 事件 4：\n    「四」\n' +
        '时机 事件 5：\n    「五」\n' +
        '时机 事件：\n    「补」\n',
    );
    expect(headLines(erb)).toContain('@M_KOJO_EVENT_K12_2');
    expect(headCount(erb, '@M_KOJO_EVENT_K12_2')).toBe(1);
  });
});

describe('事件编号自动分配 · 占号面（原生块 + 显式编号）', () => {
  it('原生 `@` 直通块的数字尾算占号（写在省略块之后也算——全文档扫）', () => {
    const src =
      '角色: 12\n' +
      '时机 事件：\n    「糖」\n' +
      '@M_KOJO_EVENT_K12_1(ARG)\n' +
      '\tPRINTFORM 「原始」\n';
    const { erb } = t(src);
    // 原生块占住 1（含形参尾），省略编号必须让步 → 2
    expect(headLines(erb)).toContain('@M_KOJO_EVENT_K12_2');
    expect(headCount(erb, '@M_KOJO_EVENT_K12_1(ARG)')).toBe(1); // 原生块逐字透传
  });

  it('别人版原生块（`@M_KOJO_口上名_EVENT_K{n}_数字`）同样算占号', () => {
    const src =
      '角色: 1\n口上: 少女之梦\n' +
      '时机 事件：\n    「糖」\n' +
      '@M_KOJO_少女之梦_EVENT_K1_1\n' +
      '\tPRINTFORM 「原始」\n';
    const { erb } = t(src);
    expect(headLines(erb)).toContain('@M_KOJO_少女之梦_EVENT_K1_2');
    expect(headCount(erb, '@M_KOJO_少女之梦_EVENT_K1_1')).toBe(1);
  });

  it('原生块里**别的角色号**不占本文件的号（只认本文件 `角色:`）', () => {
    const src =
      '角色: 12\n' +
      '时机 事件：\n    「糖」\n' +
      '@M_KOJO_EVENT_K99_1\n' +
      '\tPRINTFORM 「别人的」\n';
    const { erb } = t(src);
    expect(headLines(erb)).toContain('@M_KOJO_EVENT_K12_1');
  });

  it('原生块的**别族**函数头不占号（`_GIFT` / `_ONABARE_1` 尾段非裸数字）', () => {
    const src =
      '角色: 12\n' +
      '时机 事件：\n    「糖」\n' +
      '@M_KOJO_EVENT_K12_GIFT\n' +
      '\tPRINTFORM 「礼物」\n' +
      '@M_KOJO_EVENT_K12_ONABARE_1(ARG)\n' +
      '\tPRINTFORM 「撞见」\n';
    const { erb } = t(src);
    expect(headLines(erb)).toContain('@M_KOJO_EVENT_K12_1');
  });

  it('后写的显式编号不被前面的省略编号抢（全文档占号先于分配）', () => {
    const src = '角色: 12\n时机 事件：\n    「乙」\n时机 事件 1：\n    「甲」\n';
    const { erb } = t(src);
    expect(headCount(erb, '@M_KOJO_EVENT_K12_1')).toBe(1);
    expect(headCount(erb, '@M_KOJO_EVENT_K12_2')).toBe(1);
  });
});

describe('事件编号自动分配 · 显式编号路径逐字节不变', () => {
  it('追加省略块不改动前面显式块的产物（逐字节前缀）', () => {
    const explicit = '角色: 12\n时机 事件 4：\n    「甲」\n';
    const erbA = t(explicit).erb;
    const erbB = t(explicit + '时机 事件：\n    「乙」\n').erb;
    expect(erbB.startsWith(erbA)).toBe(true);
    expect(headLines(erbB)).toContain('@M_KOJO_EVENT_K12_1'); // 省略块补到 1（4 已占）
  });

  it('显式编号的产物逐字保留（`007` 原样写进名字，不归一化）', () => {
    const { erb } = t('角色: 12\n时机 事件 007：\n    「甲」\n');
    expect(headLines(erb)).toContain('@M_KOJO_EVENT_K12_007');
  });

  it('显式编号也进占号集（`007` 占 7，省略块从 1 起补）', () => {
    const { erb } = t('角色: 12\n时机 事件 007：\n    「甲」\n时机 事件：\n    「乙」\n');
    expect(headLines(erb)).toContain('@M_KOJO_EVENT_K12_007');
    expect(headLines(erb)).toContain('@M_KOJO_EVENT_K12_1');
  });
});

describe('事件编号自动分配 · 面表驱动（不硬编码族名）', () => {
  it('未声明 `autoIndex` 的面：省略编号行为与旧版逐字节相同（`事件` 从表里去掉声明）', () => {
    const table = stubFaceTable();
    const noAuto: KojoFaceTable = {
      ...table,
      faces: { ...table.faces, 事件: { template: 'M_KOJO{t}_EVENT_K{n}_{i}' } },
    };
    const { erb, diagnostics } = svc(noAuto).transpile('角色: 12\n时机 事件：\n    「甲」\n');
    // 旧行为：`{i}` 段被剥掉 → 包装函数 `M_KOJO_EVENT_K12`，本体 `M_KOJO_EVENT_K12_1`
    expect(headLines(erb)).toContain('@M_KOJO_EVENT_K12');
    expect(headLines(erb)).not.toContain('@M_KOJO_EVENT_K12_1_1'); // 没有分配，就没有 `_1_1` 本体
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('⑤ 非可分配面零变化：`时机 指令：`（省略编号）照旧剥 `{i}`、不参与分配', () => {
    const { erb } = t('角色: 12\n时机 指令：\n    「甲」\n');
    expect(headLines(erb)).toContain('@M_KOJO_MESSAGE_COM_K12');
    expect(headLines(erb)).toContain('@M_KOJO_MESSAGE_COM_K12_1');
  });

  it('无 `{i}` 槽的面（`初见`）不受影响', () => {
    const { erb } = t('角色: 12\n时机 初见：\n    「甲」\n');
    expect(headLines(erb)).toContain('@M_KOJO_ENCOUNTER_K12');
  });

  it('显式编号 + 中文名路径（无法查表）保持 fail-closed，且不产半成品', () => {
    const { erb, diagnostics } = t('角色: 12\n时机 事件 摸屁股：\n    「甲」\n');
    expect(diagnostics.map((d) => d.code)).toContain('timing-instruction-unknown');
    expect(eventHeads(erb)).toEqual([]);
  });

  it('中文名 fail-closed 不吞号：下一个省略编号照样拿 `_1`', () => {
    const { erb, diagnostics } = t(
      '角色: 12\n时机 事件 摸屁股：\n    「甲」\n时机 事件：\n    「乙」\n',
    );
    expect(diagnostics.map((d) => d.code)).toContain('timing-instruction-unknown');
    expect(headLines(erb)).toContain('@M_KOJO_EVENT_K12_1');
  });
});

describe('事件编号自动分配 · 确定性', () => {
  it('⑥ 同输入同输出（两个独立服务实例、两次转译逐字节相同）', () => {
    const src =
      '角色: 12\n' +
      '时机 事件 1：\n    「一」\n' +
      '时机 事件：\n    「乙」\n' +
      '时机 事件：\n    「丙」\n';
    const a = svc().transpile(src).erb;
    const b = svc().transpile(src).erb;
    expect(a).toBe(b);
    expect(headLines(a)).toContain('@M_KOJO_EVENT_K12_2');
    expect(headLines(a)).toContain('@M_KOJO_EVENT_K12_3');
  });
});
