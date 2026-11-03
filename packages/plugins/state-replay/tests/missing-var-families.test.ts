/**
 * KW-34：`missing-var` 83 枚判性的**收口与红线**（真语料 K49 × save03 逐枚归族，回执见提交信息）。
 *
 * 归族（发点全部是 `state-view.resolveModel` 的未知名分支）：
 * - **F4 `#DIM CONST` 具名整数常量**（2 枚）：引擎"标识符索引=表达式求值"路 ⇒ 编号与载族无关
 *   ⇒ **收**——`lookup` 答 `source:'const'` 才换算（本文件第 1–4 组钉收口与三条红线）。
 * - **F1 会话级全局可写变量**（42 枚：裸 `#DIM` 顶层声明、无 `SAVEDATA` 旗标）：这类变量
 *   **从不进存档**（实测 save03 全部 540 个顶层键里没有其一，而其大小写折叠变体也没有；
 *   同目录 `#DIM SAVEDATA` 声明的族全部在档）⇒ 快照无从得，**不收**。
 * - **F2 形参别名**（30 枚：函数头 `@FN(ARGS, 对方残机, ARG:1)` + `#DIM 对方残机`）：值 =
 *   本次调用实参 = 场景输入，与 `call-context`（KW-28 终局判性：不收）同一族血统 ⇒ **不收**。
 * - **F3 函数体内局部 `#DIM`**（9 枚：前戯１／本番はどっちか／好感度一位／胖次所有_49／PAGE）：
 *   值由函数内数据流决定，抽取侧没有"`#DIM` 声明"发布通道（本地量通道只认
 *   LOCAL/LOCALS/RESULT/RESULTS 四族槽）⇒ 无从判 ⇒ **不收**（放宽前置条件见第 6 组注释）。
 *
 * 本文件同时是**防"为好看而多收"**的会红灯区：任何把 unknown 翻成 0/'' 默认值、大小写折叠、
 * 全角折算、或借名称表编号当常量值的改动都会在这里炸。
 */
import { describe, expect, it } from 'vitest';
import type { ArchiveCharacterBlock, ArchiveVariable, ReplayUnknownCode, SnapshotArchive, VariableRef } from '@kojo/plugin-api';
import { createStateView, type SchemaLookup } from '../src/state-view';

function scalarInt(key: string, value: number): ArchiveVariable {
  return { type: 'int', key, value, offset: 0 };
}
function int1d(key: string, saveLen: number, cells: [number, number][]): ArchiveVariable {
  return {
    type: 'int-array-1d',
    key,
    saveLen: [saveLen],
    cursor: [saveLen],
    nonEmpty: cells.length,
    cells: cells.map(([i, v]) => ({ index: [i], value: v })),
    offset: 0,
  };
}
function block(index: number, vars: ArchiveVariable[]): ArchiveCharacterBlock {
  return { index, dimSepIndex: null, vars };
}

/** 与 state-view.test 同一形态的最小档案：K49 角色块 + 顶层若干；**不含** 83 枚里的任何名字 */
function makeArchive(): SnapshotArchive {
  return {
    path: 'D:/fake/sav/save01.sav',
    fileName: 'save01.sav',
    size: 0,
    format: 'gzip',
    version: 1808,
    fileType: 'normal',
    uniqueCode: '7153',
    gameVersion: '0',
    saveMes: '',
    charCount: 1,
    decompressedSize: 0,
    bodySize: 0,
    consumed: 0,
    remaining: 0,
    chars: [
      block(0, [
        scalarInt('NO', 49),
        int1d('CFLAG', 100, [[2, 800]]),
        int1d('MAGIC_DLC', 1, []), // 真实形态：SAVEDATA 全局在档（int-array-1d 稀疏缺省）
      ]),
    ],
    vars: [
      int1d('DAY', 1000, [[0, 47]]),
      int1d('M_TFLAG', 1000, [[53, 20]]), // 真语料对照：时间因子类型槽 = 20（TimeFactor_无加速）
      int1d('activity_alias_case', 10, []), // 无关杂项，防"整表兜底"式偷懒
    ],
  };
}

const ref = (name: string, indices: string[] = []): VariableRef => ({
  name,
  indices,
  text: indices.length > 0 ? `${name}:${indices.join(':')}` : name,
});

const readCode = (v: ReturnType<ReturnType<typeof createStateView>['read']>): ReplayUnknownCode => {
  if (v.kind !== 'unknown') throw new Error(`expected unknown, got: ${JSON.stringify(v)}`);
  return v.unknown.code;
};
const readValue = (v: ReturnType<ReturnType<typeof createStateView>['read']>): number | string => {
  if (v.kind !== 'value') throw new Error(`expected value, got: ${JSON.stringify(v)}`);
  return v.value;
};

/**
 * 复刻 adapter `variable-schema.lookup` 的三层应答（CSV 主表 → `.als` 追加 → `.ERH` 自定名表）：
 * - `(FLAG, 'K49_SLOT')` → 名称表槽位号（source 'primary'）——**不是**常量；
 * - `(FLAG, 'TIMEFACTOR_无加速')` → 自定名表兜底（source 'const'，编号与载族无关）；
 * - 载族换成不存在的族 → undefined（引擎字典里该族无名表 ⇒ 无从应答）。
 */
function makeAdapterLikeLookup(consts: Record<string, number>): SchemaLookup {
  return (name: string, index?: number | string) => {
    if (name !== 'FLAG') return undefined; // 载族闸：只有 FLAG 有名表
    const idx = String(index ?? '');
    if (idx === 'K49_SLOT') return { name, index, description: '某槽位', resolvedIndex: 7, source: 'primary' };
    const constValue = consts[idx.toUpperCase()];
    if (constValue !== undefined) {
      return { name, index, description: idx, resolvedIndex: constValue, source: 'const' };
    }
    return { name, index }; // 有名表、名字查无 → 只带族名（无编号、无来源）
  };
}

const constDict = { TIMEFACTOR_无加速: 20, K49_HALFWIDTH_CONST: 33 };
const viewWithConsts = () => createStateView({ archive: makeArchive(), characterNo: 49, lookup: makeAdapterLikeLookup(constDict) });
const viewNoLookup = () => createStateView({ archive: makeArchive(), characterNo: 49 });

describe('KW-34 F4：#DIM CONST 具名常量——收口判据', () => {
  it('裸常量引用且字典答 source:const → 换算成编号值（真语料 2 枚的同形态）', () => {
    expect(readValue(viewWithConsts().read(ref('TIMEFACTOR_无加速')))).toBe(20);
  });

  it('常量名同时是 FLAG 名称表槽位时**不借槽位号**（source 非 const → 假命中闸）', () => {
    // K49_SLOT 在名称表里编号 7，但它不是"名字=编号"的全局常量 ⇒ 裸引用仍无从得
    expect(readCode(viewWithConsts().read(ref('K49_SLOT')))).toBe('missing-var');
  });

  it('带下标的裸引用不换算（CONST:0 形态引擎不保证）→ 保持 missing-var', () => {
    expect(readCode(viewWithConsts().read(ref('TIMEFACTOR_无加速', ['0'])))).toBe('missing-var');
  });

  it('无字典注入（旧读数路径）→ missing-var 一条不变', () => {
    expect(readCode(viewNoLookup().read(ref('TIMEFACTOR_无加速')))).toBe('missing-var');
  });

  it('有名表但名字三层都查无 → 仍 missing-var（不拿族名应答凑数）', () => {
    expect(readCode(viewWithConsts().read(ref('NO_SUCH_CONST_ANYWHERE')))).toBe('missing-var');
  });

  it('收口不吃内置名：FLAG 自身（内置全局）走既有寻址，与载族探测无关', () => {
    // FLAG 在 var-model 内置清单 → readGlobalVar；探测分支根本不触发
    expect(readValue(viewWithConsts().read(ref('FLAG', ['0'])))).toBe(0); // 稀疏缺省 = 0（引擎语义）
  });
});

describe('KW-34 红线：81 枚不收的会红判据（任何"默认值化/折叠/折算"都在此炸）', () => {
  it('F1 会话级全局（裸 #DIM、从不进存档）：ACTIVITY_TYPE 保持 missing-var，不默认 0', () => {
    expect(readCode(viewWithConsts().read(ref('ACTIVITY_TYPE', ['TARGET'])))).toBe('missing-var');
    expect(readCode(viewWithConsts().read(ref('DISH_DRG')))).toBe('missing-var');
    expect(readCode(viewWithConsts().read(ref('LAST_LOVEPOINT')))).toBe('missing-var');
  });

  it('F1 的大小写折叠变体在档也**不认**（真语料实测 540 键零命中 ⇒ 折叠不是本族的解）', () => {
    // 档案里放异体名 'Activity_Type'（数据驱动会认这个**逐字**名），
    // 引用侧已被抽取器大写为 'ACTIVITY_TYPE' ⇒ 逐字口径 miss ⇒ missing-var。
    const archive: SnapshotArchive = {
      ...makeArchive(),
      vars: [...(makeArchive().vars ?? []), int1d('Activity_Type', 200, [[49, 3]])],
    };
    const v = createStateView({ archive, characterNo: 49, lookup: makeAdapterLikeLookup(constDict) });
    expect(readCode(v.read(ref('ACTIVITY_TYPE', ['TARGET'])))).toBe('missing-var');
    // 对照：逐字名（数据驱动兜底的既有能力）照常可读——证明上格红在"口径"而非"读不到"
    expect(readValue(v.read(ref('Activity_Type', ['49'])))).toBe(3);
  });

  it('F2 形参别名（函数头实参带值）：不换算成 ARG、不猜场景输入 → missing-var 原样', () => {
    expect(readCode(viewWithConsts().read(ref('对方残机')))).toBe('missing-var');
    expect(readCode(viewWithConsts().read(ref('相手残機')))).toBe('missing-var');
  });

  it('F3 函数体内局部 #DIM（含全角数字名）：无声明通道 → missing-var；全角折算不认', () => {
    expect(readCode(viewWithConsts().read(ref('前戯１')))).toBe('missing-var');
    expect(readCode(viewWithConsts().read(ref('本番はどっちか')))).toBe('missing-var');
    expect(readCode(viewWithConsts().read(ref('好感度一位')))).toBe('missing-var');
    // 全角/半角折算闸：在档放半角异体 '前戯1'，引用全角 '前戯１' 仍 miss（真语料零命中实证 ⇒ 不折算）
    const archive: SnapshotArchive = {
      ...makeArchive(),
      vars: [...(makeArchive().vars ?? []), int1d('前戯1', 10, [[0, 2]])],
    };
    const v = createStateView({ archive, characterNo: 49 });
    expect(readCode(v.read(ref('前戯１')))).toBe('missing-var');
  });

  it('三族同走探测通道时也必须零命中：常量字典里没有它们（防"往 dict 里塞名字就翻案"）', () => {
    for (const name of ['ACTIVITY_TYPE', 'DISH_DRG', '对方残机', '相手残機', '前戯１', '好感度一位', 'PAGE', '胖次所有_49']) {
      expect(readCode(viewWithConsts().read(ref(name)))).toBe('missing-var');
    }
  });
});

describe('KW-34 边界：其余三处 missing-var 发点不吃常量探测（发点归属一字未动）', () => {
  it('内置角色族缺格 → 引擎默认 0 路原样（哪怕同名在常量字典里）', () => {
    const dict = { ...constDict, TALENT: 999 };
    const archiveNoTalent: SnapshotArchive = {
      ...makeArchive(),
      chars: [block(0, [scalarInt('NO', 49)])],
    };
    const v = createStateView({ archive: archiveNoTalent, characterNo: 49, lookup: makeAdapterLikeLookup(dict) });
    expect(readValue(v.read(ref('TALENT', ['0'])))).toBe(0);
  });

  it('注册号缺块发点 → missing-var 原样（真语料 0 枚，形态仍须有闸）', () => {
    // K49 块的 CFLAG 走 TARGET=自身；显式指到不在档的注册号 120 → 发点"角色注册号 120 不在快照中"
    expect(readCode(viewWithConsts().read(ref('CFLAG', ['120', '2'])))).toBe('missing-var');
  });

  it('角色块无此变量发点 → missing-var 原样（非内置、非在册名）', () => {
    expect(readCode(viewNoLookup().read(ref('CFLAG', ['99', '2'])))).toBe('missing-var');
  });
});
