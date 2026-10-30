/**
 * ZH-F2 · 悬停**中文名**解析（`resolveHoverName`）纯逻辑单测。
 *
 * Monaco 绑定（`installHover`）刻意薄——本文件主要测"光标位置 + 三张表 → 中文名"的解析，
 * 另以**假 Monaco**（`import type`，无运行时依赖）钉住"`.erb` 与 `.kojo` 两个语言 id 复用
 * 同一 provider"（EC-6）。
 *
 * 覆盖：数值变量索引（`CFLAG:TARGET:1088` → 好感度）、英文函数名（系统表反向 + adapter
 * 基础库表反查）、指令编号（只在糖的 `时机 <分野> <编号>：` 块头里认）；以及三组
 * **fail-visible 负例**（表缺席 / 查不到 / 上下文不可证明一律不显示——**绝不猜**）。
 */

import { functionLookupOf } from '@kojo/plugin-api';
import { provideErbHover } from '@kojo/plugin-erb-parser';
import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type {
  EditorLanguageServiceContribution,
  ErbIndex,
  KojoInstructionTable,
  KojoLibraryTable,
} from '@kojo/plugin-api';
import type { DictionaryLookup } from '@kojo/plugin-kojo-sugar';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { installSlotServiceLegs } from '../src/monaco/slot-service-providers';
import { setGlobalKernel } from '../src/ui/editor-pane-registry';
import { type HoverTables, installHover, resolveHoverName } from '../src/monaco/kojo-hover';

/** 桩变量字典：CFLAG 1088 = 好感度（另含一条具名索引，用于钉住"中文名不进反查面"） */
const dict: DictionaryLookup = {
  resolveFamily: () => undefined,
  resolve: () => undefined,
  nameAt: (family, index) => {
    if (family === 'CFLAG' && index === '1088') return '好感度';
    if (family === 'TALENT' && index === '结婚') return '结婚';
    return undefined;
  },
};

/** 桩基础库表（形状与 adapter 的 `KojoLibraryTable` 同构） */
const lib: KojoLibraryTable = {
  hasTable: true,
  lookupByName: (name) => (name === '心形' ? 'HPH_PRINT' : undefined),
  lookupByFunction: (fn) => (fn === 'HPH_PRINT' ? '心形' : undefined),
};

/** 桩指令表 */
const instr: KojoInstructionTable = {
  hasTable: true,
  lookupByName: (name) => (name === '亲吻' ? 310 : undefined),
  lookupByNo: (no) => (no === 310 ? '亲吻' : undefined),
};

const tables: HoverTables = { dictionary: dict, libraryTable: lib, instructionTable: instr };

/** 用 `|` 标记光标处（1 基列 = 标记前的字符数 + 1），返回解析结果 */
const at = (marked: string, t: HoverTables = tables) =>
  resolveHoverName(marked.replace('|', ''), marked.indexOf('|') + 1, t);

describe('悬停中文名 · 数值变量索引', () => {
  it('`CFLAG:TARGET:1088` 的光标落在索引上 → 好感度', () => {
    const hit = at('IF CFLAG:TARGET:|1088 >= 500');
    expect(hit?.name).toBe('好感度');
    expect(hit?.kind).toContain('变量');
  });

  it('光标落在索引**中间**同样命中（命中区间覆盖整串引用）', () => {
    const hit = at('IF CFLAG:TARGET:1|088 >= 500');
    expect(hit?.name).toBe('好感度');
    expect(hit?.startColumn).toBe('IF '.length + 1);
    expect(hit?.endColumn).toBe('IF CFLAG:TARGET:1088'.length + 1);
  });
});

describe('悬停中文名 · 英文函数名', () => {
  it('系统函数表反向：`GETBIT` → 获取标记（值不动、只换名字）', () => {
    const hit = at('SIF |GETBIT(A,0)');
    expect(hit?.name).toBe('获取标记');
    expect(hit?.kind).toContain('GETBIT');
  });

  it('adapter 基础库表反查：`HPH_PRINT` → 心形', () => {
    expect(at('CALL |HPH_PRINT,@"文本","W"')?.name).toBe('心形');
  });
});

describe('悬停中文名 · 指令编号（只在可证明的块头里认）', () => {
  it('糖的 `时机 指令 310：` 块头 → 亲吻', () => {
    const hit = at('时机 指令 |310：');
    expect(hit?.name).toBe('亲吻');
    expect(hit?.kind).toContain('指令');
  });

  it('同一块头改用全角空格分隔 → 同样认（空白类走补全同一枚单源）', () => {
    const hit = at('时机　指令　|310：');
    expect(hit?.name).toBe('亲吻');
    expect(hit?.kind).toContain('指令');
  });

  it('负例：同一个数字出现在别处（无 `时机 <分野> ` 前缀）→ 不显示', () => {
    expect(at('A = |310')).toBeUndefined();
    expect(at('IF FLAG:|310 == 0')).toBeUndefined();
  });
});

describe('悬停中文名 · fail-visible 负例（绝不猜）', () => {
  it('未收录的函数名 / 查不到的索引 → 不显示', () => {
    expect(at('SIF |MY_FUNC(1)')).toBeUndefined();
    expect(at('IF CFLAG:TARGET:|9999 >= 1')).toBeUndefined();
  });

  it('具名索引（中文名）不进反查面：分词只吃 ASCII 与 `:`（数字索引才是本线证得的形状）', () => {
    expect(at('IF TALENT:TARGET:|结婚')).toBeUndefined();
  });

  it('adapter 表全缺席（无项目 / 适配器未激活）→ 语言级系统表照常，adapter 侧一律不显示', () => {
    expect(at('IF CFLAG:TARGET:|1088 >= 500', {})).toBeUndefined(); // 变量字典缺席
    expect(at('SIF |GETBIT(A,0)', {})?.name).toBe('获取标记'); // 系统表是语言层，与项目无关
    expect(at('CALL |HPH_PRINT,@"文本","W"', {})).toBeUndefined(); // 基础库表缺席
    expect(at('时机 指令 |310：', {})).toBeUndefined(); // 指令表缺席
  });

  it('光标落在空格 / 空白处 → 不显示', () => {
    expect(at('IF |  A')).toBeUndefined();
    expect(at('|')).toBeUndefined();
  });
});

/**
 * ERB 悬浮（ERB-PARITY G1，2026-10-31）——**ERB 的悬停已改走槽**。
 *
 * 判据（六路）整块搬进 `@kojo/plugin-erb-parser`（`completion.ts` 的 `provideErbHover`），
 * 由 `ui.editor.languageService` 的 `erb-hover` 供方在槽里作答；宿主 `installHover` 只剩
 * **kojo1**（v1 糖面）那一枚旧桥 provider——ERB descriptor 点名了 `slotServices: ['hover']`，
 * 旧桥那枚按 `excludeNamed` 让开（否则同一门语言上两枚 HoverProvider 同时摊开正文）。
 *
 * 本组因此钉三件事：旧桥只剩 kojo1、释放句柄只清它自己那枚、以及**槽级**上 ERB 的
 * `hover` 请求确实由插件供方应答（非 ERB 请求弃权）。假内核 / 假 Monaco 的替身口径与
 * `dialect-extension.conformance.test.ts` 同款：只桩 `slots.query`、`project.current` 与
 * Monaco 的注册函数，判据一行都不抄。
 */

/** 假 Monaco：只记录 hover provider 注册（含释放句柄） */
function fakeMonaco() {
  const regs: { langId: string; provider: Monaco.languages.HoverProvider; disposed: boolean }[] = [];
  const monaco = {
    languages: {
      registerHoverProvider: (langId: string, provider: Monaco.languages.HoverProvider) => {
        const rec = { langId, provider, disposed: false };
        regs.push(rec);
        return {
          dispose: () => {
            rec.disposed = true;
          },
        };
      },
    },
  } as unknown as typeof Monaco;
  return { monaco, regs };
}

const noopToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

/** 槽级替身用的 ERB 路径（供方按扩展名认方言，缺了它一律弃权） */
const SLOT_ERB_PATH = 'C:/game/M_KOJO_K12_口上.ERB';

/** 让给定 provider 在带 `|` 标记的**单行**文本上出货（1 基列 = 标记前字符数 + 1；与 `at` 同口径） */
function hoverAt(provider: Monaco.languages.HoverProvider, marked: string) {
  const line = marked.replace('|', '');
  const model = {
    getLineContent: () => line,
    getValue: () => line,
    getLanguageId: () => ERB_LANGUAGE_ID,
    getVersionId: () => 1,
    uri: { scheme: 'file', path: SLOT_ERB_PATH, fsPath: SLOT_ERB_PATH },
  } as unknown as Monaco.editor.ITextModel;
  const position = { lineNumber: 1, column: marked.indexOf('|') + 1 } as Monaco.Position;
  return provider.provideHover(model, position, noopToken) as Monaco.languages.Hover | undefined;
}

type KernelLike = Parameters<typeof setGlobalKernel>[0];

/** 假内核：只答语言服务槽（`project` 固定 null——本组不需要项目事实） */
function installSlotKernel(contributions: readonly EditorLanguageServiceContribution[]): void {
  setGlobalKernel({
    slots: {
      query: (slot: string) => (slot === 'ui.editor.languageService' ? contributions : []),
    },
    project: { current: () => null },
  } as unknown as KernelLike);
}

/**
 * 插件供方的**替身口径**：贡献体直接用真实判据 `provideErbHover`，只把索引通道与 adapter
 * 三张表用闭包喂进去（生产里这两格来自 `erb.parser` 服务与 `game.adapter` 槽）。
 */
function erbHoverContribution(t: HoverTables): EditorLanguageServiceContribution {
  const facts = {
    ...(t.dictionary !== undefined ? { dictionary: t.dictionary } : {}),
    ...(t.variableSchema !== undefined ? { variableSchema: t.variableSchema } : {}),
    ...(t.libraryTable !== undefined ? { libraryTable: t.libraryTable } : {}),
  };
  return {
    id: 'erb-hover',
    provide: (request) =>
      request.kind === 'hover'
        ? provideErbHover(request, {
            index: () => (t.erbIndex === undefined ? null : (t.erbIndex() ?? null)),
            adapterTables: () => facts,
          })
        : undefined,
  };
}

describe('ERB 悬浮 · 槽供方接手（installHover 不再挂 ERB）', () => {
  it('`installHover` 只挂 `KOJO_LANGUAGE_ID`：ERB 点名了 `hover`，旧桥那枚让开', () => {
    const { monaco, regs } = fakeMonaco();
    installHover(monaco, () => tables);
    expect(regs.map((r) => r.langId)).toEqual([KOJO_LANGUAGE_ID]);
  });

  it('释放句柄 → 只清 kojo1 那一枚（ERB 的注册与它无关）', () => {
    const { monaco, regs } = fakeMonaco();
    installHover(monaco, () => tables).dispose();
    expect(regs.map((r) => r.langId)).toEqual([KOJO_LANGUAGE_ID]);
    expect(regs.every((r) => r.disposed)).toBe(true);
  });

  it('槽级 · 变量路：ERB 的 `hover` 请求由 `erb-hover` 供方应答（「好感度」/ 变量）', () => {
    const { monaco, regs } = fakeMonaco();
    installSlotKernel([erbHoverContribution(tables)]);
    const handle = installSlotServiceLegs(monaco, ['hover']);
    const erb = regs.find((r) => r.langId === ERB_LANGUAGE_ID);
    expect(erb, 'ERB 的 hover 腿没挂上').toBeDefined();
    const text = JSON.stringify(hoverAt(erb!.provider, 'IF CFLAG:TARGET:|1088 >= 500')?.contents);
    expect(text).toContain('好感度');
    expect(text).toContain('变量');
    handle.dispose();
  });

  it('槽级 · 函数路：英文函数名 `GETBIT` 由插件供方出货「获取标记」', () => {
    const { monaco, regs } = fakeMonaco();
    installSlotKernel([erbHoverContribution(tables)]);
    const handle = installSlotServiceLegs(monaco, ['hover']);
    const erb = regs.find((r) => r.langId === ERB_LANGUAGE_ID)!;
    const text = JSON.stringify(hoverAt(erb.provider, 'SIF |GETBIT(A,0)')?.contents);
    expect(text).toContain('获取标记');
    expect(text).toContain('GETBIT');
    handle.dispose();
  });

  it('槽级 · 非 ERB 请求弃权 ⇒ 交回 `undefined`（让 v1 那枚旧桥接手）', () => {
    const { monaco, regs } = fakeMonaco();
    installSlotKernel([erbHoverContribution(tables)]);
    const handle = installSlotServiceLegs(monaco, ['hover']);
    const kojo1 = regs.find((r) => r.langId === KOJO_LANGUAGE_ID)!;
    const model = {
      getValue: () => 'IF CFLAG:TARGET:1088 >= 500',
      getLineContent: () => 'IF CFLAG:TARGET:1088 >= 500',
      getLanguageId: () => KOJO_LANGUAGE_ID,
      getVersionId: () => 1,
      uri: { scheme: 'file', path: 'C:/game/a.kojo1', fsPath: 'C:/game/a.kojo1' },
    } as unknown as Monaco.editor.ITextModel;
    const position = { lineNumber: 1, column: 17 } as Monaco.Position;
    expect(kojo1.provider.provideHover(model, position, noopToken)).toBeUndefined();
    handle.dispose();
  });
});

/**
 * 「本文件是哪一份文件」的注入位（ERB-PARITY G1 搬家后：槽腿的 `host.filePathOf`）。
 *
 * 悬停第 5.5 路（`#DIM` 声明名）是**唯一**需要文件身份的一路：数据住在 `ErbIndex.files`，
 * 键是磁盘上的路径。派生面（升糖预览那份只读内存 model）的 URI 是 `inmemory://sugar/…`，
 * 索引里必然对不到任何文件 ⇒ 不换算就是整路静默，而这条静默在预览面上看不出任何差别。
 * 换算规则本身（"这份 model 背后是哪个文件"）是**归属**知识，住在登记簿，不该进判据一行。
 *
 * 搬家前这一格是 `installHover` 的第三参；判据进插件后它是槽腿请求的 `path` 来源
 * （`SlotServiceHost.filePathOf`）——**同一条契约**：注入胜过 `model.uri`、注入回 `null`
 * 不改判据、注入抛错不没收整条悬停、两处都给不出 ⇒ 这一路闭嘴。本组只把"问谁"改到槽。
 */
describe('悬停 · 文件身份注入位（派生面上的 `#DIM` 声明路）', () => {
  const DIM_PATH = 'C:/game/M_KOJO_K12_口上.ERB';
  /** 投影 model 的 URI：那条路径上没有文件，索引里也没有它 */
  const PROJECTION_URI = `/sugar/pane-1/${encodeURIComponent(DIM_PATH)}`;

  const index: ErbIndex = {
    files: new Map([[DIM_PATH, { path: DIM_PATH, dims: [{ name: '好感度', directive: 'DIM', line: 12 }] } as never]]),
    byName: functionLookupOf(new Map()),
  };
  const dimTables: HoverTables = { erbIndex: () => index };

  /** 桩 model：取文 / 语言 id / 版本（`text` 由带 `|` 标记的行折成一行），`uri` 可选 */
  function modelFor(marked: string, uri?: string): Monaco.editor.ITextModel {
    const line = marked.replace('|', '');
    const model = {
      getLineContent: () => line,
      getValue: () => line,
      getLanguageId: () => ERB_LANGUAGE_ID,
      getVersionId: () => 1,
    } as unknown as { uri?: unknown };
    if (uri !== undefined) model.uri = { fsPath: uri, path: uri };
    return model as unknown as Monaco.editor.ITextModel;
  }

  function hoverWith(
    marked: string,
    t: HoverTables,
    uri?: string,
    sourcePathOf?: (model: Monaco.editor.ITextModel) => string | null,
  ): Monaco.languages.Hover | undefined {
    const { monaco, regs } = fakeMonaco();
    installSlotKernel([erbHoverContribution(t)]);
    const handle = installSlotServiceLegs(
      monaco,
      ['hover'],
      sourcePathOf === undefined ? {} : { filePathOf: sourcePathOf },
    );
    const provider = regs.find((r) => r.langId === ERB_LANGUAGE_ID)!.provider;
    const position = { lineNumber: 1, column: marked.indexOf('|') + 1 } as Monaco.Position;
    const hover = provider.provideHover(modelFor(marked, uri), position, noopToken) as
      | Monaco.languages.Hover
      | undefined;
    handle.dispose();
    return hover;
  }
  const hoverWithDim = (marked: string, uri?: string, sourcePathOf?: (model: Monaco.editor.ITextModel) => string | null) =>
    hoverWith(marked, dimTables, uri, sourcePathOf);

  it('注入路径胜过 `model.uri`：投影面上照样出货「声明于」', () => {
    const text = JSON.stringify(hoverWithDim('PRINT |好感度', PROJECTION_URI, () => DIM_PATH)?.contents);
    expect(text).toContain('好感度');
    expect(text).toContain('#DIM 声明');
    expect(text).toContain(`${DIM_PATH}:12`);
  });

  it('不注入（原文面老路）：认 `model.uri.fsPath`，行为逐字不变', () => {
    const text = JSON.stringify(hoverWithDim('PRINT |好感度', DIM_PATH)?.contents);
    expect(text).toContain(`${DIM_PATH}:12`);
  });

  it('注入腿回 `null` = 宿主不改判据 ⇒ 退回 `model.uri`', () => {
    const text = JSON.stringify(hoverWithDim('PRINT |好感度', DIM_PATH, () => null)?.contents);
    expect(text).toContain(`${DIM_PATH}:12`);
  });

  it('注入腿抛错不能没收整条悬停：退化 = 不注入时的形状（真路径仍出货）', () => {
    const text = JSON.stringify(
      hoverWithDim('PRINT |好感度', DIM_PATH, () => {
        throw new Error('登记簿反查炸了');
      })?.contents,
    );
    expect(text).toContain(`${DIM_PATH}:12`);
  });

  it('身份给不出 ⇒ 这一路不显示（不猜）；其余各路一行都不跟着消失', () => {
    // 无 uri + 注入回 `null` = 文件身份这个事实根本不存在 ⇒ 声明路必须闭嘴
    expect(hoverWithDim('PRINT |好感度', undefined, () => null)).toBeUndefined();
    // 同一个抛错发生在投影面上：字典路（第 1 路，与身份无关）照样出货，被牺牲的只有声明路
    const rich: HoverTables = { ...tables, erbIndex: () => index };
    const thrown = () => {
      throw new Error('换算腿炸了');
    };
    const text = JSON.stringify(hoverWith('IF CFLAG:TARGET:|1088 >= 1', rich, PROJECTION_URI, thrown)?.contents);
    expect(text).toContain('好感度');
    expect(text).toContain('变量');
  });
});
