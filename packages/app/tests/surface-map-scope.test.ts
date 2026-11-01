import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERATW_SURFACE_MAP } from '@kojo/plugin-eratw-adapter/kojo2-surface-map';
import { nativeOfSurface, surfaceMappingsOf, surfacesOfNative } from '@kojo/kojo-core/surface-map';

/**
 * 表层↔原生表的**边界闸**（LAU-SURFACE-WIRE 收口批，2026-11-01）。
 *
 * ## 这张闸回答什么
 *
 * LAU-D4 车② 交了表、LAU-SURFACE-WIRE ① 给它接上了第一个真消费者（悬停反查），
 * 但卡上留着一句没答的裁决：**「表该不该收面 token」**——四处"看起来在抄名字表"的地方
 * 因此一直没动：
 *
 * | 处 | 那是什么 | 裁决 |
 * |---|---|---|
 * | `ui-kojo-navigator/src/tree.ts` | `FACE_ORDER`：43 枚**面 token 的语义排序** | 不收：展示顺序，不是名字映射 |
 * | `ui-condition-matrix/src/matrix-logic.ts` | 同一份 `FACE_ORDER`（跨插件不许 import ⇒ 自带一份） | 不收；但两份必须逐字相等（下面 ④） |
 * | `eraakumamaid-adapter/src/family-index.ts` | `ERAAKUMA_MAID_FACE_LABELS`：面 token → 中文标签 | 不收：游戏知识，已住方言包（正确归属） |
 * | `app/src/monaco/kojo-native-zone.ts` | 原生区分流闸（这一行属不属于 `.kojo` 的直通区） | 不收：语法位，表头注第一条就排除了 |
 * | `kojo-conformance/src/language.ts` | golden 的**期望落点**（产物该长什么样） | 不收：那是判据自身，读表＝自证 |
 *
 * 裁决只有一条：**面 token 既不是"作者写的名字"（surface），也不是"盘上的原生写法"（native）**
 * ——它是函数名内部的**时机段**（`M_KOJO_K1_MESSAGE_COM_K1_1` 里的 `MESSAGE_COM`），
 * 住在方言包的 `FamilyIndexRule` 与家族事实里。把它塞进表层表就等于给同一件事造第二份数据，
 * 而这张表的第一条纪律正是"表是数据、真源永远在方言包"。
 *
 * ## 四条判据（每条都能真红）
 *
 * ① 表的 `kind` 值域**恰四格**（`DialectFactKind`）——有人加第五类 `face` 当场红；
 * ② 拿面 token 去查表，四格**一格都不认**（正向 / 反向都查不到）；
 * ③ `surface` 列不许出现纯 ASCII 大写蛇形 token（那是面 token / 引擎常量的形状，不是作者写的词）；
 * ④ 两份 `FACE_ORDER` 逐字相等（它们确实是第二份数据，今天没有合规的家可搬——见下）；
 * ⑤ 那五处源码**不读**表层表（不迁移这件事本身要被钉住，否则下次有人"顺手接一下"就悄悄改了归属）。
 *
 * ## 为什么 ④ 不索性搬成一份
 *
 * 跨插件 import 是 `audit:decoupling` 的 C 项硬禁；能当公共家的只有非插件包
 * （`kojo-vocab` / `kojo-core`），但那两份 FACE_ORDER 是**展示顺序**（谁排前面），
 * 不是语言词表——放进词表包等于把 UI 口径焊进语言面。于是本批只钉"两份必须同源"，
 * 搬家留给真需要第三份消费者的时候（那时才有理由为它开一个包）。
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

/** 代码行（去掉整行注释）：抄判据的第一站就是注释，但正向接线只看代码 */
function codeLines(rel: string): string {
  return read(rel)
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('///') || t.startsWith('/*') || t.startsWith('*'));
    })
    .join('\n');
}

/** 从源码里抠一枚 `const X: readonly string[] = [ ... ]` 的字面量清单 */
function stringListOf(rel: string, anchor: string): string[] {
  const src = read(rel);
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error(`${rel} 里找不到 ${anchor}`);
  const eq = src.indexOf('=', at);
  const open = src.indexOf('[', eq);
  const close = src.indexOf(']', open);
  return [...src.slice(open + 1, close).matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

const FACE_ORDER_FILES = [
  'packages/plugins/ui-kojo-navigator/src/tree.ts',
  'packages/plugins/ui-condition-matrix/src/matrix-logic.ts',
] as const;

/** 四处"面"的家 + 那份 UI 排序表所在文件（都**不该**读表层表，见头注表格） */
const FACE_HOME_FILES = [
  ...FACE_ORDER_FILES,
  'packages/plugins/eraakumamaid-adapter/src/family-index.ts',
  'packages/app/src/monaco/kojo-native-zone.ts',
  'packages/kojo-conformance/src/language.ts',
] as const;

/** 面 token 采样（取真语料里最常见的那几枚：事件面 / 日常面 / 调教面各来一条） */
const FACE_TOKEN_SAMPLES = ['MESSAGE_COM', 'ENCOUNTER', 'DAILY2', 'SLEEP', 'WISH', 'EVENT'] as const;

const KINDS = ['event', 'symbol', 'presentation', 'storage'] as const;

describe('表层表的边界：面 token 不入表（LAU-SURFACE-WIRE 收口裁决）', () => {
  it('① `kind` 值域恰四格（`DialectFactKind`）；加第五类 `face` 当场红', () => {
    expect([...new Set(ERATW_SURFACE_MAP.map((m) => m.kind))].sort()).toEqual([...KINDS].sort());
  });

  it('② 拿面 token 去查表：正向 / 反向 / 分组取表，四格一格都不认', () => {
    for (const kind of KINDS) {
      for (const token of FACE_TOKEN_SAMPLES) {
        expect(nativeOfSurface(ERATW_SURFACE_MAP, kind, token), `${kind} × ${token} 正向了`).toBeUndefined();
        expect(surfacesOfNative(ERATW_SURFACE_MAP, kind, token), `${kind} × ${token} 反向了`).toEqual([]);
      }
      // 分组取表也不许把面 token 混进 surface / native 任何一列
      const rows = surfaceMappingsOf(ERATW_SURFACE_MAP, kind);
      const all = rows.flatMap((m) => [m.surface, m.native, ...(m.aliases ?? [])]);
      expect(all.filter((w) => (FACE_TOKEN_SAMPLES as readonly string[]).includes(w))).toEqual([]);
    }
  });

  it('③ `surface` 列是"作者写的词"：纯 ASCII 大写蛇形 token 只许是**恒等落点**（`RESULTS` → `RESULTS`）', () => {
    // 恒等落点是表里合法的一类（`domainSymbols` 的外部变量名：作者写的与盘上写的是同一个词），
    // 悬停那边对它的纪律是"恒等落点不算信息"。**面 token 不在这类里**——它的 native 是
    // `族:编号` / 引擎常量，绝不会跟自己相等，所以这条同时挡住了"把面 token 填进 surface"。
    const asciiUpperSnake = /^[A-Z][A-Z0-9_]*$/;
    const offenders = ERATW_SURFACE_MAP.filter(
      (m) => asciiUpperSnake.test(m.surface) && m.surface !== m.native,
    ).map((m) => `${m.kind}:${m.surface}→${m.native}`);
    expect(offenders).toEqual([]);
  });

  it('④ 两份 `FACE_ORDER` 逐字相等（跨插件不许 import ⇒ 只许"两份同源"，不许各长各的）', () => {
    const [navigator, matrix] = FACE_ORDER_FILES.map((f) => stringListOf(f, 'FACE_ORDER'));
    expect(navigator!.length).toBeGreaterThan(0);
    expect(navigator).toEqual(matrix);
    // 43 枚是当日实读数（新增面 = 一次显式决定，不是顺手加一条）
    expect(navigator!.length).toBe(43);
    expect(new Set(navigator).size).toBe(navigator!.length);
  });

  it('⑤ 四处"面"的家不读表层表：不迁移这件事本身被钉住（谁"顺手接一下"就红）', () => {
    const readsTable = /surface-map|nativeOfSurface|surfacesOfNative|ERATW_SURFACE_MAP/;
    const offenders = FACE_HOME_FILES.filter((rel) => readsTable.test(codeLines(rel)));
    expect(offenders).toEqual([]);
  });
});
