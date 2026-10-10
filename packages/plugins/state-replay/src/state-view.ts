/**
 * 状态视图归约（游戏无关；本插件私有）。
 *
 * 把 `SnapshotArchive`（sav-parser 的解析产物）+ 一个口上角色（CSV NO）
 * 归约为可查询的 `ReplayStateView`：
 * - 角色块定位：按块内 `NO` 标量匹配 CSV 编号（口上 `K{no}` 的 no 语义）；
 *   注册号（寻址用）= 块序（存档按 CharacterList 顺序序列化）；
 * - 变量寻址：内置清单（引擎语言层）优先，`#DIM` 用户变量按数据兜底；
 * - 取值语义：稀疏 cells 缺失 = 0/''（引擎语义）；数组单元被截断 → 显式 unknown；
 * - 上下文参数：`TARGET` → 回放角色注册号；`MASTER`/`ASSI`/`PLAYER` → 快照顶层值。
 *
 * 绝不抛错：一切不可读情形返回 `unknown` 且原因明确。
 */

import type {
  ArchiveArrayVariable,
  ArchiveCharacterBlock,
  ArchiveVariable,
  ReplayStateView,
  ReplayUnknown,
  ReplayUnknownCode,
  ReplayValue,
  SnapshotArchive,
  VariableInfo,
  VariableRef,
} from '@kojo/plugin-api';
import {
  builtinVarModel,
  isCalcPseudo,
  isKnownCharaVariable,
  isKnownGlobalVariable,
  isLanguageLocal,
  varShapeFromArchiveType,
  type VarModel,
} from './var-model';

/** 具名索引字典查询（来自 game adapter `variableSchema`；缺省时具名索引不可求值） */
export type SchemaLookup = (name: string, index?: number | string) => VariableInfo | undefined;

export interface CreateStateViewOptions {
  archive: SnapshotArchive;
  /** 被回放角色的 CSV 编号（口上 `K{no}`） */
  characterNo: number;
  /** 具名索引字典（可选） */
  lookup?: SchemaLookup;
}

/** 创建视图失败（角色不在快照中等）→ 抛错由调用方呈现 */
export class ReplayViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayViewError';
  }
}

function unknownPair(code: ReplayUnknownCode, message: string): { kind: 'unknown'; unknown: ReplayUnknown } {
  return { kind: 'unknown', unknown: { code, message } };
}

function unknownValue(code: ReplayUnknownCode, message: string): ReplayValue {
  return unknownPair(code, message);
}

/** 整数解析结果（角色参数 / 索引段） */
type IntResult = { kind: 'value'; value: number } | { kind: 'unknown'; unknown: ReplayUnknown };

/** 数组变量类型守卫（联合字面量属性 narrow 不可靠，显式守卫） */
function isArrayVar(v: ArchiveVariable): v is ArchiveArrayVariable {
  return v.type.startsWith('int-array') || v.type.startsWith('str-array');
}

/** 数字段（含负号；引擎索引可为负但会越界——这里如实解析，越界由调用方判定） */
const NUMERIC_SEG = /^-?\d+$/;

/** 角色参数位可解析的引擎指针名（值为注册号） */
const CHARA_POINTERS = new Set(['TARGET', 'ASSI', 'MASTER', 'PLAYER']);

class StateView implements ReplayStateView {
  readonly characterNo: number;
  readonly archivePath: string;
  readonly characterName: string | null;

  /** 被回放角色的注册号（= 块序） */
  private readonly regNo: number;
  /** 全部角色块的变量索引（key → 变量；168 块一次性建，成本低） */
  private readonly charaIndex: Map<number, Map<string, ArchiveVariable>>;
  /** 顶层变量索引（key → 变量） */
  private readonly topIndex: Map<string, ArchiveVariable>;
  private readonly archive: SnapshotArchive;
  private readonly lookup: SchemaLookup | undefined;

  constructor(archive: SnapshotArchive, characterNo: number, lookup: SchemaLookup | undefined) {
    this.archive = archive;
    this.characterNo = characterNo;
    this.archivePath = archive.path;
    this.lookup = lookup;

    const chars = archive.chars ?? [];
    this.charaIndex = new Map();
    for (const block of chars) {
      const m = new Map<string, ArchiveVariable>();
      for (const v of block.vars) m.set(v.key, v);
      this.charaIndex.set(block.index, m);
    }
    this.topIndex = new Map();
    for (const v of archive.vars ?? []) this.topIndex.set(v.key, v);

    // 定位角色块：按 NO 标量（CSV 编号）匹配
    const block = this.findBlockByNo(characterNo);
    if (!block) {
      throw new ReplayViewError(`角色不在该快照中：NO=${characterNo}（共 ${chars.length} 个角色块）`);
    }
    this.regNo = block.index;

    // 显示名（NAME 标量；上下文 = 该角色）
    const nameVar = this.charaIndex.get(this.regNo)?.get('NAME');
    this.characterName = nameVar && nameVar.type === 'str' && typeof nameVar.value === 'string' ? nameVar.value : null;
  }

  private findBlockByNo(no: number): ArchiveCharacterBlock | null {
    for (const block of this.archive.chars ?? []) {
      const noVar = block.vars.find((v) => v.key === 'NO');
      if (noVar && noVar.type === 'int' && noVar.value === no) return block;
    }
    return null;
  }

  read(ref: VariableRef): ReplayValue {
    const name = ref.name;

    if (isLanguageLocal(name)) {
      return unknownValue('pseudo', `语言局部量不在快照中：${name}`);
    }
    if (isCalcPseudo(name)) {
      return unknownValue('pseudo', `伪变量（运行期计算值）：${name}`);
    }

    // ---- 变量模型：内置清单优先，数据驱动兜底 ----
    const model = this.resolveModel(name);
    if (isUnknownModel(model)) return model;

    // ---- 参数归化 + 寻址 ----
    const segs = ref.indices;
    if (model.domain === 'chara') {
      return this.readCharaVar(name, model, segs);
    }
    return this.readGlobalVar(name, model, segs);
  }

  /** 判定变量模型（内置 → 数据兜底）；未知名字返回 ReplayValue 直接作为结果 */
  private resolveModel(name: string): VarModel | ReplayValue {
    const builtin = builtinVarModel(name);
    if (builtin) return builtin;

    // #DIM 用户角色变量（回放角色块内）
    const inCharaBlock = this.charaIndex.get(this.regNo)?.get(name);
    if (inCharaBlock) {
      const shape = varShapeFromArchiveType(inCharaBlock.type);
      if (shape) {
        return {
          domain: 'chara',
          dims: shape.dims,
          valueKind: shape.valueKind,
          form: shape.dims === 2 ? 'array2d' : shape.dims === 0 ? 'scalar' : 'array1d',
        } as VarModel;
      }
      return unknownValue('other', `变量形态不支持求值：${name}[${inCharaBlock.type}]`);
    }

    // #DIM 用户全局变量（顶层）
    const inTop = this.topIndex.get(name);
    if (inTop) {
      const shape = varShapeFromArchiveType(inTop.type);
      if (shape) {
        return {
          domain: 'global',
          dims: shape.dims,
          valueKind: shape.valueKind,
          form: shape.dims === 0 ? 'scalar' : shape.dims === 2 ? 'array2d' : shape.dims === 3 ? 'array3d' : 'array1d',
        } as VarModel;
      }
      return unknownValue('other', `变量形态不支持求值：${name}[${inTop.type}]`);
    }

    // 未知名字 → missing-var（审阅 L4 清理：原"已知名但快照缺失 → null"
    // 分支不可达——builtinVarModel 与 isKnown*Variable 检查同一批集合，
    // 已知名在函数开头就返回 model；快照缺块的默认值语义由
    // readCharaVar/readGlobalVar 的缺块路径处理）
    return unknownValue('missing-var', `快照中未找到变量：${name}`);
  }

  // ------------------------------------------------------------------
  // 角色域
  // ------------------------------------------------------------------

  private readCharaVar(name: string, model: VarModel, segs: readonly string[]): ReplayValue {
    const dims = model.dims;
    let charaSeg: string | null = null;
    let indexSegs: readonly string[];

    if (dims === 1) {
      if (segs.length === 0) {
        charaSeg = null; // → TARGET
        indexSegs = ['0']; // 引擎语义 X ≡ X[TARGET,0]
      } else if (segs.length === 1) {
        charaSeg = null; // 单参 → 索引位，角色补位 TARGET
        indexSegs = segs;
      } else if (segs.length === 2) {
        charaSeg = segs[0]!;
        indexSegs = [segs[1]!];
      } else {
        return unknownValue('too-many-args', `参数过多：${name}（最多 2 个）`);
      }
    } else if (dims === 2) {
      if (segs.length !== 3) {
        return unknownValue('too-many-args', `${name} 需要 3 个参数（角色:维1:维2）`);
      }
      charaSeg = segs[0]!;
      indexSegs = [segs[1]!, segs[2]!];
    } else {
      // 角色标量（NAME/NO/CALLNAME…）
      if (segs.length === 0) {
        charaSeg = null;
      } else if (segs.length === 1) {
        charaSeg = segs[0]!;
      } else {
        return unknownValue('too-many-args', `参数过多：${name}（最多 1 个）`);
      }
      indexSegs = [];
    }

    // 角色参数
    let charaNo = this.regNo;
    if (charaSeg !== null) {
      const c = this.resolveCharaArg(charaSeg);
      if (c.kind === 'unknown') return c;
      charaNo = c.value;
    }
    if (charaNo < 0) {
      return unknownValue('other', `非法角色注册号：${charaNo}（${name}）`);
    }

    // 索引段
    const indices: number[] = [];
    for (const seg of indexSegs) {
      const v = this.resolveIndexSeg(name, seg);
      if (v.kind === 'unknown') return v;
      indices.push(v.value);
    }

    return this.readBlockVar(charaNo, name, indices, model.valueKind);
  }

  /** 读角色块变量（不存在 → 已知名 0/''；越界 → unknown；稀疏缺省 → 0/''） */
  private readBlockVar(charaNo: number, key: string, indices: readonly number[], kind: 'int' | 'str'): ReplayValue {
    const blockVars = this.charaIndex.get(charaNo);
    if (!blockVars) {
      return unknownValue('missing-var', `角色注册号 ${charaNo} 不在快照中（${key}）`);
    }
    const v = blockVars.get(key);
    if (!v) {
      if (isKnownCharaVariable(key)) {
        return kind === 'str' ? { kind: 'value', value: '' } : { kind: 'value', value: 0 };
      }
      return unknownValue('missing-var', `角色块中无变量：${key}`);
    }
    return this.readArchiveVar(v, indices, kind);
  }

  // ------------------------------------------------------------------
  // 全局域
  // ------------------------------------------------------------------

  private readGlobalVar(name: string, model: VarModel, segs: readonly string[]): ReplayValue {
    const dims = model.dims;
    if (dims === 0) {
      if (segs.length > 0) {
        return unknownValue('too-many-args', `标量变量不接受索引：${name}`);
      }
      return this.readTopVar(name, [], model.valueKind);
    }
    if (segs.length === 0) {
      if (dims === 1) return this.readTopVar(name, [0], model.valueKind); // X ≡ X:0
      return unknownValue('other', `参数不足：${name}（需要 ${dims} 个索引）`);
    }
    if (segs.length !== dims) {
      return unknownValue('too-many-args', `${name} 需要 ${dims} 个索引（收到 ${segs.length} 个）`);
    }
    const indices: number[] = [];
    for (const seg of segs) {
      const v = this.resolveIndexSeg(name, seg);
      if (v.kind === 'unknown') return v;
      indices.push(v.value);
    }
    return this.readTopVar(name, indices, model.valueKind);
  }

  /** 读顶层变量（不存在 → 已知名 0/''；越界 → unknown；稀疏缺省 → 0/''） */
  private readTopVar(key: string, indices: readonly number[], kind: 'int' | 'str'): ReplayValue {
    const v = this.topIndex.get(key);
    if (!v) {
      if (isKnownGlobalVariable(key)) {
        return kind === 'str' ? { kind: 'value', value: '' } : { kind: 'value', value: 0 };
      }
      return unknownValue('missing-var', `顶层变量区中无变量：${key}`);
    }
    return this.readArchiveVar(v, indices, kind);
  }

  // ------------------------------------------------------------------
  // 存档变量取值（标量 / 稀疏数组）
  // ------------------------------------------------------------------

  private readArchiveVar(v: ArchiveVariable, indices: readonly number[], kind: 'int' | 'str'): ReplayValue {
    if (!isArrayVar(v)) {
      if (v.type === 'map' || v.type === 'xml' || v.type === 'datatable') {
        return unknownValue('other', `变量形态不支持条件求值：${v.key}[${v.type}]`);
      }
      // 标量
      if (indices.length > 0) return unknownValue('too-many-args', `标量变量不接受索引：${v.key}`);
      return { kind: 'value', value: v.value };
    }

    // 数组：越界检查（引擎语义：索引必须落在声明长度内）
    for (let d = 0; d < indices.length; d++) {
      const idx = indices[d]!;
      const len = v.saveLen[d];
      if (len === undefined) return unknownValue('too-many-args', `索引维数超出声明：${v.key}`);
      if (idx < 0 || idx >= len) {
        return unknownValue('index-oob', `索引越界：${v.key}[${indices.join(':')}]（声明长度 ${v.saveLen.join('x')}）`);
      }
    }

    // 稀疏 cells 匹配（cells.index 与 indices 全等）
    for (const cell of v.cells) {
      if (cell.index.length !== indices.length) continue;
      let match = true;
      for (let d = 0; d < indices.length; d++) {
        if (cell.index[d] !== indices[d]) {
          match = false;
          break;
        }
      }
      if (match) {
        return { kind: 'value', value: cell.value };
      }
    }

    // 未命中：被截断 → unknown；正常省略 → 默认值（引擎语义）
    if (v.cellsTruncated && v.cells.length < v.nonEmpty) {
      return unknownValue('truncated', `数组单元被截断，无法判定：${v.key}[${indices.join(':')}]`);
    }
    return kind === 'str' ? { kind: 'value', value: '' } : { kind: 'value', value: 0 };
  }

  // ------------------------------------------------------------------
  // 参数解析
  // ------------------------------------------------------------------

  /** 角色参数位（返回注册号） */
  private resolveCharaArg(seg: string): IntResult {
    if (NUMERIC_SEG.test(seg)) return { kind: 'value', value: Number(seg) };
    if (seg === 'TARGET') return { kind: 'value', value: this.regNo };
    if (CHARA_POINTERS.has(seg)) {
      // MASTER/ASSI/PLAYER：快照顶层指针值（缺省 0）
      const v = this.readTopVar(seg, [0], 'int');
      if (v.kind === 'value') {
        return { kind: 'value', value: typeof v.value === 'number' ? v.value : Number(v.value) };
      }
      return v; // unknown 直接透传
    }
    if (seg.startsWith('[[')) return unknownPair('rename', `rename 词无法求值：${seg}`);
    if (seg.startsWith('(')) return unknownPair('dynamic-index', `动态角色参数无法求值：${seg}`);
    return unknownPair('other', `无法解析角色参数：${seg}`);
  }

  /** 索引位（数字 / 指针名读值 / 具名字典） */
  private resolveIndexSeg(name: string, seg: string): IntResult {
    if (NUMERIC_SEG.test(seg)) return { kind: 'value', value: Number(seg) };
    if (CHARA_POINTERS.has(seg)) {
      // 罕见的索引位指针（如 CFLAG:MASTER → 索引 = MASTER 值）
      return this.resolveCharaArg(seg);
    }
    if (seg.startsWith('[[')) return unknownPair('rename', `rename 词无法求值：${seg}`);
    if (seg.startsWith('(')) return unknownPair('dynamic-index', `动态索引段无法求值：${seg}`);
    // 具名索引：经 adapter variableSchema 字典转编号（引擎 VariableStrArgTerm 语义）
    if (this.lookup) {
      const info = this.lookup(name, seg);
      if (info && typeof info.resolvedIndex === 'number') {
        return { kind: 'value', value: info.resolvedIndex };
      }
    }
    return unknownPair('named-index', `具名索引无法解析：${name}:${seg}`);
  }
}

/** 判定 resolveModel 的返回值是否为"直接可用的未知结果" */
function isUnknownModel(v: VarModel | ReplayValue): v is ReplayValue {
  return typeof v === 'object' && 'kind' in v && (v as ReplayValue).kind === 'unknown';
}

/** 创建状态视图（失败抛 ReplayViewError） */
export function createStateView(opts: CreateStateViewOptions): ReplayStateView {
  return new StateView(opts.archive, opts.characterNo, opts.lookup);
}
