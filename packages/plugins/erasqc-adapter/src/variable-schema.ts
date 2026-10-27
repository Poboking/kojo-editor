/**
 * eraSQC 变量字典（`VariableSchema`）——**由游戏数据文件驱动**（不硬编码索引表）。
 *
 * 形态照 `erakoumakan-adapter/src/variable-schema.ts`（同一套三层数据源、同一份
 * `inputDigest` 折叠口径、同一条「层内后者胜 / 跨层主表胜」的合并裁决），差异全部来自
 * `C:/game/eraSQC` 实测语料（2026-10-25 勘查）：
 *
 * - 名称表主表：`CSV/{变量名}.csv`，行格式 `编号,名称[,注释]`；CSV 根共 **84 份**
 *   `.csv`（含 63 份 `Chara*.csv` 角色数据——**必须排除**，见下）+ 2 份 `.config`。
 *   编码混合但全为 UTF-8：BOM 386 份 / 无 BOM 51 份（全树 ERB+CSV），UTF-16 零份。
 *   实测有条目的族与条数：CFLAG 62 / TALENT 224 / ABL 44 / EXP 93 / PALAM 24 /
 *   MARK 11 / TRAIN 196 / ITEM 222 / BASE 46 / FLAG 20 / CSTR 23 / JUEL 18 /
 *   STAIN 14 / EQUIP 14 / TEQUIP 62 / EX 38 / SOURCE 20；
 *   `GameBase.csv` / `VariableSize.csv` / `_Rename.csv` / `_Replace.csv` /
 *   `_default.config` / `_fixed.config` 是键值或配置表，按「行首非数字不收录」天然 0 条。
 * - **`Chara{no}.csv` 不是变量名表**：它们是角色数据（`番号,7,` / `名前,狼女,` /
 *   `基礎,体力,2500` …）。本作把角色 CSV 直接放在 `CSV/` 根（63 份，编号不连续：
 *   0–61 / 80 / 93–98）⇒ 必须按文件名 `^CHARA\d+$` 排除，否则会建出 63 张无意义表。
 * - 追加名表：`CSV/*.als` 全树 **0 份**（`find` 复测），故主表之后只有市场字典包追加层
 *   （缺省为空；保留代码路径，将来汉化包 / 魔改放 `.als` 或市场包即可自动生效）。
 * - 作者自定名表：整棵 ERB 子树内 `*.ERH` 的 `#DIM` / `#DIMS` / `#DIM CONST` 声明名。
 *   本作真盘 **0 份** `.ERH`（`find` 复测），但扫描路径保留——魔改版加声明即自动生效。
 *
 * 解析策略（宽容）：
 * - 跳过空行与 `;` 开头的整行注释；
 * - 行首非数字不收录；
 * - 名称取第二个字段并剥掉行内 `;` 注释；
 * - 同时建立名称 → 编号反向表（`lookup('CFLAG', '好感度')` 双向可用）；
 * - 层内同编号**后者胜**（作者改号时后写的那行才是当前意图）；跨层追加表只补不盖。
 *
 * 读取失败 / 缺表 → 对应族缺席，`lookup` 返回 `undefined`（通用层照常工作）；
 * 失败一律 `log.warn`（不静默）。
 *
 * **`Train.csv` 不塞进 `VariableSchema`**：契约里指令名查询是另一个 seam
 * （`GameAdapter.kojoInstructionTable`）。本模块额外导出
 * `loadErasqcInstructionNames()`，与字典共用同一份解析器。
 */

import { ERB_DECLARATION_EXTENSIONS, foldDigest, isErbDeclarationPath, stableHash } from '@kojo/plugin-api';
import type {
  FileIO,
  KojoInstructionTable,
  Logger,
  VariableInfo,
  VariableSchema,
  VariableSource,
} from '@kojo/plugin-api';

/** 名称表键的来源层：`.csv` 主表 / 市场字典包追加（`.ERH` 常量走另一条路，见 `lookup`） */
export type NameTableSource = Extract<VariableSource, 'primary' | 'append'>;

export interface VariableTable {
  byIndex: Map<string, string>;
  byName: Map<string, string>;
  /** 键 → 来源层（与两张 Map 同一裁决：键最后一次落地的那一轮） */
  indexSource: Map<string, NameTableSource>;
  nameSource: Map<string, NameTableSource>;
}

/** 一条「编号重复」现场（调用方负责把文件名拼进日志；本模块只报事实） */
export interface NameTableOverwrite {
  index: string;
  previous: string;
  next: string;
}

export interface NameTableParseResult {
  table: VariableTable;
  /** 名称为空而跳过的行数 */
  skippedEmptyName: number;
  /** 编号重复（层内后者胜）的条数 */
  overwritten: number;
}

const emptyTable = (): VariableTable => ({
  byIndex: new Map(),
  byName: new Map(),
  indexSource: new Map(),
  nameSource: new Map(),
});

/** 剥掉行内注释：`;` 起的一切都不算名称（`3,名前<tab>;注` 与 `2,字,;注` 两形态同吃） */
function stripInlineComment(field: string): string {
  const semi = field.indexOf(';');
  return (semi >= 0 ? field.slice(0, semi) : field).trim();
}

/**
 * 把一份名称表**并入**累积表（纯函数，就地改 `target`；导出供测试）。
 *
 * 裁决：
 * - **层内后者胜**：同编号再出现时用新名称覆盖旧名称，并回调 `onOverwrite`；
 * - **跨层主表胜**：`source === 'append'` 撞上主表已有的编号 ⇒ 整行跳过。
 * 反查表 `byName` 与 `byIndex` 同向覆盖（旧名不删：它仍指向同一槽位）。
 */
export function mergeNameTable(
  target: VariableTable,
  text: string,
  opts: { source?: NameTableSource; onOverwrite?: (e: NameTableOverwrite) => void } = {},
): Omit<NameTableParseResult, 'table'> {
  const source = opts.source ?? 'primary';
  let skippedEmptyName = 0;
  let overwritten = 0;
  for (const rawLine of text.split(/\r\n?|\n/)) {
    // `trim()` 顺带吃掉 UTF-8 BOM（U+FEFF 属 ES 空白集）
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith(';')) continue;
    const firstComma = line.indexOf(',');
    if (firstComma <= 0) continue;
    const index = line.slice(0, firstComma).trim();
    if (!/^\d+$/.test(index)) continue; // `コード,9224517` / `SAVE_DTS, …` 这类键值表天然 0 条
    const rest = line.slice(firstComma + 1);
    const secondComma = rest.indexOf(',');
    const name = stripInlineComment(secondComma >= 0 ? rest.slice(0, secondComma) : rest);
    if (name.length === 0) {
      skippedEmptyName++;
      continue;
    }
    const previous = target.byIndex.get(index);
    const previousSource = target.indexSource.get(index);
    if (source === 'append' && previousSource === 'primary') continue;
    if (previous !== undefined && previous !== name) {
      overwritten++;
      opts.onOverwrite?.({ index, previous, next: name });
    }
    target.byIndex.set(index, name);
    target.indexSource.set(index, source);
    if (!(source === 'append' && target.nameSource.get(name) === 'primary')) {
      target.byName.set(name, index);
      target.nameSource.set(name, source);
    }
  }
  return { skippedEmptyName, overwritten };
}

/** 解析单份名称表 CSV（纯函数；导出供测试）——等价于并入一张空表 */
export function parseNameTableCsv(
  text: string,
  opts: { source?: NameTableSource; onOverwrite?: (e: NameTableOverwrite) => void } = {},
): NameTableParseResult {
  const table = emptyTable();
  const stats = mergeNameTable(table, text, opts);
  return { table, ...stats };
}

/**
 * 解析 `.ERH` 声明行 → 作者自定名表 `Map<大写名称, 整数编号 | undefined>`（纯函数）。
 *
 * 收：`#DIM CONST 人物_咲夜 = 4` / `#DIM 訪問者_髪の長さ` / `#DIMS 依頼内容, 8` /
 * `#DIM CONST 色設定_清潔度１ = 0x39E639`。
 * 不收「猜出来的编号」：初值只认十进制 / `0x` 十六进制非负整数字面量；表达式
 * （`既成事実&1p0`）、字符串、负值一律 undefined——`resolvedIndex` 用于存档寻址，
 * 猜错一个值就会读错槽位。
 */
export function parseErhDeclarations(text: string): Map<string, number | undefined> {
  const out = new Map<string, number | undefined>();
  for (const rawLine of text.split(/\r\n?|\n/)) {
    const head = rawLine.trim(); // 吃掉 BOM
    if (!head.startsWith('#')) continue;
    const semi = head.indexOf(';');
    const line = (semi >= 0 ? head.slice(0, semi) : head).trim();
    const m = /^#(DIMS|DIMF|DIM)\b([\s\S]*)$/i.exec(line);
    if (m === null) continue;
    let rest = (m[2] ?? '').trim();
    for (;;) {
      const km = /^([A-Za-z_][A-Za-z0-9_]*)\b([\s\S]*)$/.exec(rest);
      if (km === null) break;
      if (!ERH_DECL_KEYWORDS.has((km[1] ?? '').toUpperCase())) break;
      rest = (km[2] ?? '').trim();
    }
    const eq = rest.indexOf('=');
    const namePart = (eq >= 0 ? rest.slice(0, eq) : rest).trim();
    // 名字后面可能是 `= …`（已切走）、`, 尺寸…`（数组）或行尾
    const name = (namePart.split(/[\s,]+/)[0] ?? '').trim();
    if (name.length === 0) continue;
    const key = name.toUpperCase();
    if (out.has(key)) continue;
    out.set(key, eq >= 0 ? integerLiteral(rest.slice(eq + 1)) : undefined);
  }
  return out;
}

/** `.ERH` 声明行的前置关键字（Emuera `UserDefinedVariableData.Create` 认的修饰词） */
const ERH_DECL_KEYWORDS = new Set([
  'CONST',
  'LOCAL',
  'STATIC',
  'DYNAMIC',
  'GLOBAL',
  'SAVEDATA',
  'REF',
  'OUT',
  'CHARADATA',
]);

/** 整数字面量（十进制 / `0x` 十六进制）→ 编号；其它形态一律不认 */
function integerLiteral(text: string): number | undefined {
  const s = text.trim();
  if (!/^(0[xX][0-9a-fA-F]+|[0-9]+)$/.test(s)) return undefined;
  const n = /^0[xX]/.test(s) ? Number.parseInt(s.slice(2), 16) : Number.parseInt(s, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

export interface ErasqcVariableSchemaDeps {
  io: FileIO;
  /** 游戏 CSV 根目录（绝对路径） */
  csvDir: string;
  /** ERB 根目录（绝对路径；作者自定名表要递归整棵树） */
  erbDir: string;
  log: Logger;
  /**
   * 市场字典包（`kind === 'dict-pack'`）的 contentDir 列表（additive）。
   * 每个目录里的 `*.csv` 一律以 `source: 'append'` 并入；缺省 / 空数组 = 不读市场。
   */
  marketAppendDirs?: string[];
}

/** 名称表文件：`{变量名}.csv`（主表）或字典包里的同名表（追加层） */
interface NameTableFile {
  variableName: string;
  path: string;
}

/** 字符串路径序（确定性：目录与文件两级的「先定义优先」裁决都不许随枚举顺序漂） */
const comparePaths = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 角色数据文件名（`Chara0.csv` … `Chara98.csv`）——**不是变量名表**，主表扫描时排除。
 * 表键是「去掉扩展名后大写」，故判据也按大写比较。
 */
function isCharaDataTable(variableName: string): boolean {
  return /^CHARA\d+$/.test(variableName);
}

/**
 * 加载 eraSQC 变量字典：`CSV/` 根目录的全部 `*.csv` 名称表 → 市场字典包追加表 →
 * 整棵 ERB 子树的 `.ERH` 作者自定名表（三轮，顺序即裁决序）。
 */
export async function loadErasqcVariableSchema(
  deps: ErasqcVariableSchemaDeps,
): Promise<VariableSchema> {
  const { io, csvDir, erbDir, log } = deps;
  const tables = new Map<string, VariableTable>();
  /** 输入摘要素材：实际读到的每份文件的「路径 + 正文」哈希（`foldDigest` 排序折叠） */
  const digestParts: string[] = [];

  const tableOf = (variableName: string): VariableTable => {
    let t = tables.get(variableName);
    if (!t) {
      t = emptyTable();
      tables.set(variableName, t);
    }
    return t;
  };

  let entries: Awaited<ReturnType<FileIO['listDir']>>;
  try {
    entries = await io.listDir(csvDir);
  } catch (err) {
    log.warn(`变量字典加载失败（CSV 目录不可读）：${csvDir} — ${String(err)}`);
    entries = [];
  }

  const primaryFiles: NameTableFile[] = entries
    .filter((e) => !e.isDirectory && /\.csv$/i.test(e.name))
    .map((e) => ({ variableName: e.name.replace(/\.csv$/i, '').toUpperCase(), path: e.path }))
    .filter((f) => f.variableName.length > 0 && !isCharaDataTable(f.variableName))
    .sort((a, b) => comparePaths(a.path, b.path));

  let emptyNameTotal = 0;
  let overwrittenTotal = 0;

  /**
   * 一轮加载：**一次批量读** → 按序并入 → 记摘要。
   * `readTexts` 一次带回 N 份、失败位是 `null` ⇒ 单份读失败只 warn 跳过，其余照常。
   */
  const runPass = async (files: readonly NameTableFile[], source: NameTableSource): Promise<void> => {
    if (files.length === 0) return;
    const texts = await io.readTexts(files.map((f) => f.path));
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      const tf = texts[i];
      if (tf === null || tf === undefined) {
        log.warn(`变量表读取失败（跳过）：${f.path}`);
        continue;
      }
      const stats = mergeNameTable(tableOf(f.variableName), tf.text, {
        source,
        onOverwrite: (e) =>
          log.warn(
            `名称表编号重复（后者胜）：${f.path} 第 ${e.index} 号「${e.previous}」→「${e.next}」`,
          ),
      });
      emptyNameTotal += stats.skippedEmptyName;
      overwrittenTotal += stats.overwritten;
      digestParts.push(stableHash(`${f.path}\u0000${tf.text}`));
    }
  };

  await runPass(primaryFiles, 'primary');

  /**
   * 第二轮：市场字典包。目录与文件都先按路径排序（裁决与安装顺序无关）；
   * 本作 `.als` 实测 0 份，故只收 `.csv`（不为它留死分支）。
   */
  const marketDirs = [...(deps.marketAppendDirs ?? [])].sort(comparePaths);
  const marketFiles: NameTableFile[] = [];
  for (const dir of marketDirs) {
    let dirEntries: Awaited<ReturnType<FileIO['listDir']>>;
    try {
      dirEntries = await io.listDir(dir);
    } catch (err) {
      log.warn(`变量字典：市场字典包目录不可读（跳过）：${dir} — ${String(err)}`);
      continue;
    }
    for (const e of dirEntries) {
      if (e.isDirectory || !/\.csv$/i.test(e.name)) continue;
      const variableName = e.name.replace(/\.csv$/i, '').toUpperCase();
      if (variableName.length > 0 && !isCharaDataTable(variableName)) {
        marketFiles.push({ variableName, path: e.path });
      }
    }
  }
  marketFiles.sort((a, b) => comparePaths(a.path, b.path));
  const beforeMarket = [...tables.values()].reduce((n, t) => n + t.byIndex.size, 0);
  await runPass(marketFiles, 'append');
  if (marketFiles.length > 0) {
    const afterMarket = [...tables.values()].reduce((n, t) => n + t.byIndex.size, 0);
    log.info(
      `市场字典包追加名表：${marketDirs.length} 个目录 / ${marketFiles.length} 份，` +
        `新增 ${afterMarket - beforeMarket} 个编号（主表已有的编号名称不改写）`,
    );
  }

  /**
   * 第三轮：作者自定名表（整棵 ERB 子树的 `.ERH` 声明）。
   * 必须递归整个 ERB 根：`DIM.ERH` 在根层，其余散在各功能子目录。
   * 装载顺序按路径排序（引擎同样按路径装载）⇒ 同名首个定义优先可复现。
   */
  const erhNames = new Map<string, number | undefined>();
  let erhFileCount = 0;
  let erhSkippedDup = 0;
  {
    let erhPaths: string[] = [];
    try {
      const found = await io.walkDir(erbDir, {
        // `extensions` 与 `filter` 同时给：前者把载荷压到声明文件那几十条（桥侧筛），
        // 后者在内核兜语义；两者口径同一条（只筛输出、不剪枝），取交集不变。
        extensions: ERB_DECLARATION_EXTENSIONS,
        filter: (e) => e.isDirectory || isErbDeclarationPath(e.name),
      });
      erhPaths = found
        .filter((e) => !e.isDirectory && isErbDeclarationPath(e.name))
        .map((e) => e.path)
        .sort(comparePaths);
    } catch (err) {
      log.warn(`自定名表扫描失败（跳过，具名索引回落名称表）：${erbDir} — ${String(err)}`);
    }
    const erhTexts = erhPaths.length > 0 ? await io.readTexts(erhPaths) : [];
    for (let i = 0; i < erhPaths.length; i++) {
      const path = erhPaths[i]!;
      const tf = erhTexts[i];
      if (tf === null || tf === undefined) {
        log.warn(`自定名表读取失败（跳过）：${path}`);
        continue;
      }
      erhFileCount++;
      digestParts.push(stableHash(`${path}\u0000${tf.text}`));
      for (const [name, value] of parseErhDeclarations(tf.text)) {
        if (erhNames.has(name)) {
          erhSkippedDup++;
          continue;
        }
        erhNames.set(name, value);
      }
    }
    if (erhFileCount > 0) {
      const withValue = [...erhNames.values()].filter((v) => v !== undefined).length;
      log.info(
        `自定名表（*.ERH 声明）：${erhFileCount} 份，收录 ${erhNames.size} 个名字` +
          `（其中 ${withValue} 个带整数初值）` +
          (erhSkippedDup > 0 ? `；重名 ${erhSkippedDup} 处按首个定义优先跳过` : ''),
      );
    }
  }

  if (emptyNameTotal > 0 || overwrittenTotal > 0) {
    log.info(
      `名称表清洗：跳过空名称 ${emptyNameTotal} 行` +
        (overwrittenTotal > 0 ? `；编号重复后者胜 ${overwrittenTotal} 处（已逐条告警）` : ''),
    );
  }
  log.info(`变量字典：${tables.size} 张名称表（${[...tables.keys()].sort().join(', ')}）`);

  // 输入摘要：字典由游戏 CSV / `.ERH` 驱动，作者改一行描述就该让下游派生缓存失效。
  // 一份都没读到也是**确定值**（区别于 undefined = "没有判据"）。
  const inputDigest = foldDigest(digestParts);

  return {
    version: '1',
    inputDigest,
    lookup(variableName: string, index?: number | string): VariableInfo | undefined {
      const key = variableName.toUpperCase();
      const table = tables.get(key);
      if (!table) return undefined;
      if (index === undefined) {
        // 家族级：本作没有机读的「家族→中文」表 ⇒ 只给变量名（不猜显示名）
        return { name: key };
      }
      const idxStr = String(index);
      const byIdx = table.byIndex.get(idxStr);
      if (byIdx !== undefined) {
        const info: VariableInfo = {
          name: key,
          index,
          description: byIdx,
          source: table.indexSource.get(idxStr) ?? 'primary',
        };
        const n = Number(idxStr);
        if (!Number.isNaN(n)) info.resolvedIndex = n;
        return info;
      }
      const namedIdx = table.byName.get(idxStr);
      if (namedIdx !== undefined) {
        const info: VariableInfo = {
          name: key,
          index,
          description: idxStr,
          source: table.nameSource.get(idxStr) ?? 'primary',
        };
        const n = Number(namedIdx);
        if (!Number.isNaN(n)) info.resolvedIndex = n;
        return info;
      }
      /**
       * 名称表查无 → 作者自定名表（`.ERH` 声明）兜底。
       * 引擎侧这条路不是「名称表」而是「索引位是一个表达式」：`CFLAG:人物_咲夜` 与
       * `CFLAG:4` 同槽。常量不属于任何族，故只做名字 → 编号换算、不宣称族归属
       * （`source: 'const'` 把这条意图交给消费方）。无整数初值的声明名字照样收录
       * （拼错名核对要看见它），但不给 `resolvedIndex`。
       */
      const erhKey = idxStr.toUpperCase();
      if (erhNames.has(erhKey)) {
        const value = erhNames.get(erhKey);
        const info: VariableInfo = {
          name: key,
          index,
          description: idxStr,
          source: 'const',
        };
        if (value !== undefined) info.resolvedIndex = value;
        return info;
      }
      return { name: key, index };
    },
    /** 枚举该族可写的索引名（契约 `VariableSchema.names`）。无该族 → 空数组。 */
    names(family: string): readonly VariableInfo[] {
      const table = tables.get(family.toUpperCase());
      if (!table) return [];
      const out: VariableInfo[] = [];
      for (const [idxStr, name] of table.byIndex) {
        const n = Number(idxStr);
        const info: VariableInfo = {
          name,
          index: Number.isNaN(n) ? idxStr : n,
          source: table.indexSource.get(idxStr) ?? 'primary',
        };
        if (!Number.isNaN(n)) info.resolvedIndex = n;
        out.push(info);
      }
      return out;
    },
  };
}

export interface ErasqcInstructionNamesDeps {
  io: FileIO;
  /** 游戏 CSV 根目录（绝对路径；指令名表固定是其中的 `Train.csv`） */
  csvDir: string;
  log: Logger;
}

/**
 * 加载 eraSQC 的**指令名表**（`CSV/Train.csv`）→ 契约 `KojoInstructionTable`。
 *
 * 与字典共用同一个解析器 ⇒ `lookup('TRAIN', 310)` 与 `lookupByName('胸爱抚')`
 * 读到同一个名称。缺表 / 读失败 / 空表 ⇒ `hasTable: false`（消费方 fail-closed），并 warn。
 */
export async function loadErasqcInstructionNames(
  deps: ErasqcInstructionNamesDeps,
): Promise<KojoInstructionTable> {
  const { io, csvDir, log } = deps;
  const absent: KojoInstructionTable = {
    hasTable: false,
    lookupByName: () => undefined,
    lookupByNo: () => undefined,
    names: () => [],
  };

  let entries: Awaited<ReturnType<FileIO['listDir']>>;
  try {
    entries = await io.listDir(csvDir);
  } catch (err) {
    log.warn(`指令名表加载失败（CSV 目录不可读）：${csvDir} — ${String(err)}`);
    return absent;
  }
  // 文件名大小写不敏感：盘上是 `Train.csv`，魔改版可能写成 `TRAIN.CSV`
  const file = entries.find((e) => !e.isDirectory && /^train\.csv$/i.test(e.name));
  if (file === undefined) {
    log.warn(`指令名表缺失：${csvDir}/Train.csv（「时机 指令 …」将 fail-closed）`);
    return absent;
  }
  let text: string;
  try {
    text = (await io.readText(file.path)).text;
  } catch (err) {
    log.warn(`指令名表读取失败：${file.path} — ${String(err)}`);
    return absent;
  }
  const { table, skippedEmptyName } = parseNameTableCsv(text);
  if (table.byIndex.size === 0) {
    log.warn(`指令名表为空（0 条编号行）：${file.path}`);
    return absent;
  }
  log.info(
    `指令名表：${table.byIndex.size} 条编号` +
      (skippedEmptyName > 0 ? `（跳过空名称 ${skippedEmptyName} 行）` : ''),
  );
  /**
   * 指令表用**同名取首条**（与 eratw / eraAkumaMaid 同一口径，也与引擎 CSV
   * 加载顺序语义一致）。本作 `Train.csv` 存在跨段重名（`3,自慰` 与 `282,自慰`；
   * `17,～予备～` 与 40+ 个空位号同名），字典层的「层内后者胜」会把名称指向最后一个
   * 空位号——但降糖时作者写 `时机 指令 自慰：` 期望的是**基础指令段** 3，故指令表单独
   * 按 `byIndex` 的插入序重建首名表，不直接复用 `table.byName`。
   */
  const firstByName = new Map<string, number>();
  for (const [idx, name] of table.byIndex) {
    if (!firstByName.has(name)) firstByName.set(name, Number(idx));
  }
  return {
    hasTable: true,
    lookupByName: (name: string) => firstByName.get(name),
    lookupByNo: (no: number) => table.byIndex.get(String(no)),
    // 正向补全的唯一名字源：`firstByName` 的键（CSV 原序，同名多编号已取首条）
    names: () => [...firstByName.keys()],
  };
}
