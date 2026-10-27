/**
 * eraFL 变量字典（`VariableSchema`）——**由游戏数据文件驱动**（不硬编码索引表）。
 *
 * 形态照 `eraakumamaid-adapter/src/variable-schema.ts`（同一套三层数据源、同一份
 * `inputDigest` 折叠口径、同一条"追加层只补不盖"的合并裁决），差异全部来自 eraFL
 * 实测语料（`D:/Game/erafl`，2026-10-24 勘查），逐条记在下面。
 *
 * 数据来源（均取自当前打开的工程目录，随版本 / 魔改自动跟随）：
 * - 名称表（主表）：`CSV/{变量名}.csv`，行格式 `编号,名称[,注释]`。eraFL 的 25 份
 *   `.csv` 全部 **UTF-8 BOM + CRLF**（`CFLAG.CSV` / `Talent.csv` 大小写混用——本模块
 *   一律按文件名去扩展名后**大写**建表，引擎标识符本就大小写不敏感）。
 *   实测 **20 份有条目**：任务书点名的 16 张有编号（CFLAG 127 / TALENT 174 / TRAIN 233 /
 *   TCVAR 106 / ITEM 201 / KOJOEVENT 142 / ABL 50 / FLCONFIG 44 / SOURCE 39 / CSTR 28 /
 *   PALAM 20 / TSTR 11 / EX 10 / STAIN 6 / MARK 1 / TFLAG 71），另有 4 张不在点名之列
 *   但有编号（FLAG 91 / EXP 78 / BASE 10 / FLTUTOR 4）；
 *   另 **5 份 0 条**——任务书点名的 `GameBase.csv`（`コード,9224518` 形态的键值表）与
 *   `VariableSize.csv` / `VarExtFL.CSV` / `_Rename.csv` / `_Replace.csv`（尺寸 / 扩展 /
 *   替换配置）。0 条也**照样建出空表**（"族在、索引无"，与 eratw / eraAkumaMaid 对
 *   空 `.csv` 的行为一致）。
 * - **追加名表**：`CSV/*.als`——eraFL 全树实测 **0 份**（`find` 复测，2026-10-24），
 *   故本层不建代码路径（不写"将来可能用得上"的死分支）；汉化 / 魔改要给编号补别名，
 *   走下面这条**市场字典包**通道即可。
 * - **市场字典包追加名表**（`marketAppendDirs`）：已装字典包 `files/` 目录里的
 *   `.csv` 名表，一律按 `source: 'append'` 并入；目录间与文件间**按路径排序**
 *   （"先定义优先"的裁决不许随枚举顺序漂）。
 * - **作者自定名表**：整棵 ERB 子树内 `*.ERH` 的 `#DIM` / `#DIMS` / `#DIM CONST`
 *   声明名（递归，`ERB/VARIABLE.ERH`、`ERB/VARIABLE_RELATION.ERH` 与各子目录都算）。
 *   实测 112 份 `.ERH` / **3507 个唯一声明名**（其中 1868 个带整数初值，0 组同名
 *   不同值）。引擎把 `.ERH` 声明装进**全局**标识符字典（键只有名字，没有文件维度）
 *   ⇒ `CFLAG:衣装部位_頭` 与 `CFLAG:0` 是同一个槽位（索引位是表达式，先求值再寻址）。
 *
 * **三处与 eraAkumaMaid 不同的裁决（都是任务书 / 语料要求的）**：
 * 1. **编号重复 = 后者胜 + warn**（AM 是"首个定义优先"）。eraFL 的 CSV 是作者持续
 *    改号的工作表，同一编号出现两次时**后写的那行才是当前意图**；静默取首条会让
 *    作者改了名却在编辑器里看到旧名。实测 25 份 `.csv` **0 组重号**（这条只在魔改 /
 *    汉化包上才会触发），故真盘读数不受影响。
 * 2. **跨层不适用"后者胜"**：追加层（市场字典包）**只补主表没有的编号**，撞号一律
 *    保留主表——否则一个字典包就能悄悄改写引擎语义（"只并集不覆盖"）。层内后者胜、
 *    跨层主表胜，两条规则各管一段。
 * 3. **`.ERH` 收全部 `#DIM` 家族的名字**（AM 只收 `#DIM CONST` / `#DEFINE` 的
 *    "名字=整数"）。理由：eraFL 的 `#DIM NAME`（无初值）声明的是**全局变量**，
 *    `族头:NAME` 在引擎里同样是合法写法（索引位求值），故它必须能被收录判定看见；
 *    只是这类名字**没有静态编号** ⇒ `resolvedIndex` 缺省（"名字在、编号运行期才知道"），
 *    绝不拿 0 兜底。
 *
 * 解析策略（宽容）：
 * - 跳过空行与 `;` 开头的整行注释（含 tab 缩进的续行注释）；
 * - 行首非数字（`コード,9224518` 这类键值表）不收录；
 * - 名称取**第二个字段**，并剥掉行内 `;` 及其之前的一切——eraFL 的注释有三种前缀
 *   实测形态：`2,字,;実質未使用`（裸分号）、`0,キャラ用,\t\t;…`（制表符）、
 *   `1,あ, ;…`（空格）。第三种最容易被"只切 tab"的实现漏掉，故统一按 `;` 截断。
 * - 名称为空（`Tflag.csv:6` = `5,,;不明`，实测 14 条）⇒ 跳过并计数：空名进字典
 *   只会让补全弹出一个空候选，而编号本身仍在（`lookup` 回声）；
 * - 同时建立**名称 → 编号**反向表（`lookup('TALENT', '恋慕')` 双向可用）。
 *
 * **`Train.csv` 不塞进 `VariableSchema`**：契约（`plugin-api/src/game.ts`）里
 * `VariableSchema` 没有任何"指令名表"字段，最贴近的查询面是**另一个**契约
 * `KojoInstructionTable`（`GameAdapter.kojoInstructionTable`）。按"不改契约"的硬约束，
 * 本模块额外导出 `loadEraflInstructionNames()` 返回该契约对象——`TRAIN` 名表本身仍
 * 照常进字典（`lookup('TRAIN', 310)` 可用），两个面共用同一份解析器。
 *
 * 家族级名称（`lookup('CFLAG')` 无索引）：eraFL 目录**没有**机读的「家族→中文」表，
 * 本批只回 `{ name }`（未登记 ⇒ 不猜；显示名 / 中文别名留给后续批次，不在这里
 * 编一张没有语料背书的策展表）。
 *
 * 读取失败 / 缺表 → 对应族缺席，`lookup` 返回 `undefined`（通用层照常工作）；
 * 失败一律 `log.warn`（不静默），其余输入照常加载。
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

/** 一条"编号重复"现场（供调用方把文件名拼进日志；本模块只报事实，不决定措辞） */
export interface NameTableOverwrite {
  /** 重复的编号（字符串形态，原样来自 CSV 首字段） */
  index: string;
  /** 被覆盖掉的旧名称 */
  previous: string;
  /** 胜出的新名称 */
  next: string;
}

export interface NameTableParseResult {
  table: VariableTable;
  /** 名称为空而跳过的行数（`Tflag.csv` 实测 14 条 `n,,;不明`） */
  skippedEmptyName: number;
  /** 编号重复（后者胜）的条数 */
  overwritten: number;
}

const emptyTable = (): VariableTable => ({
  byIndex: new Map(),
  byName: new Map(),
  indexSource: new Map(),
  nameSource: new Map(),
});

/**
 * 剥掉行内注释：`;` 起的一切都不算名称。
 *
 * 为什么在**名称字段**上做而不是"只认第三个逗号"：eraFL 同时存在
 * `2,字,;注`（注释自成第三字段）与 `3,名前\t;注`（注释直接粘在名称后）两种写法，
 * 只按逗号切会把后者的 tab 与注释一起当成名字。
 */
function stripInlineComment(field: string): string {
  const semi = field.indexOf(';');
  return (semi >= 0 ? field.slice(0, semi) : field).trim();
}

/**
 * 把一份名称表**并入**累积表（纯函数，就地改 `target`；导出供测试）。
 *
 * 裁决（见文件头第 1、2 条）：
 * - **层内后者胜**：同编号再出现时用新名称覆盖旧名称，并回调 `onOverwrite`
 *   （调用方负责把"哪个文件的哪一号"写进日志——解析器不认识路径）；
 * - **跨层主表胜**：`source === 'append'` 撞上主表已有的编号 ⇒ **整行跳过**，
 *   连反查表也不动（字典包不许抢主表的归属）。
 *
 * 反查表 `byName` 与 `byIndex` 同向覆盖（同一编号改了名，新名指向该编号；旧名不删
 * ——它仍指向同一个槽位，删掉只会让旧口上突然查不到，属于无收益的破坏）。
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
    // `trim()` 顺带吃掉 UTF-8 BOM（U+FEFF 属 ES 空白集）；CRLF 由上面的切分容掉
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith(';')) continue;
    const firstComma = line.indexOf(',');
    if (firstComma <= 0) continue;
    const index = line.slice(0, firstComma).trim();
    if (!/^\d+$/.test(index)) continue; // `コード,9224518` / `SAVE_DTS, …` 这类键值表天然 0 条
    const rest = line.slice(firstComma + 1);
    const secondComma = rest.indexOf(',');
    const name = stripInlineComment(secondComma >= 0 ? rest.slice(0, secondComma) : rest);
    if (name.length === 0) {
      skippedEmptyName++;
      continue;
    }
    const previous = target.byIndex.get(index);
    const previousSource = target.indexSource.get(index);
    // 跨层：追加层只补主表没有的编号（连名称反查也不许改写主表的键）
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
 * 解析 `.ERH` 声明行 → **作者自定名表** `Map<大写名称, 整数编号 | undefined>`（纯函数）。
 *
 * 收的形态（eraFL 实测 112 份 / 3507 名）：
 * - `#DIM CONST 衣装部位_頭 = 0`（带整数初值 ⇒ 编号 = 0；`=` 两侧无空格也认）
 * - `#DIM ME_selectedNode`（无初值 ⇒ 名字收、**编号 undefined**：值运行期才知道）
 * - `#DIMS SAVEDATA CHARADATA CLOTH, CLOTH_PART_NUM`（数组声明 ⇒ 名字收、编号 undefined）
 * - `#DIMS CONST 衣装状態描写 = "","(半脱)"…`（字符串数组 ⇒ 名字收、编号 undefined）
 *
 * 不收"猜出来的编号"：初值只认**十进制 / `0x` 十六进制非负整数字面量**；表达式
 * （`0x44 + …`）、字符串、负值一律回 undefined——`resolvedIndex` 是给存档寻址用的，
 * 猜错一个值就会让回放读错槽位。
 *
 * 前置修饰词（`CONST` / `LOCAL` / `STATIC` / `DYNAMIC` / `GLOBAL` / `SAVEDATA` /
 * `REF` / `OUT` / `CHARADATA`）逐个剥掉后再取名字——它们与名字之间可能隔任意个。
 * 行尾 `;` 注释先截断（`#DEFINE` 一族实测常见）。键统一大写（引擎标识符大小写不敏感），
 * 同名**首个定义优先**（实测 0 组冲突；真冲突时引擎本身会报重定义错误）。
 */
export function parseErhDeclarations(text: string): Map<string, number | undefined> {
  const out = new Map<string, number | undefined>();
  for (const rawLine of text.split(/\r\n?|\n/)) {
    const head = rawLine.trim(); // 吃掉 BOM（112 份里 108 份带 BOM）
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

/** 整数字面量（十进制 / `0x` 十六进制）→ 编号；其它形态一律不认（见 `parseErhDeclarations`） */
function integerLiteral(text: string): number | undefined {
  const s = text.trim();
  if (!/^(0[xX][0-9a-fA-F]+|[0-9]+)$/.test(s)) return undefined;
  const n = /^0[xX]/.test(s) ? Number.parseInt(s.slice(2), 16) : Number.parseInt(s, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

export interface EraflVariableSchemaDeps {
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

/** 字符串路径序（确定性：目录与文件两级的"先定义优先"裁决都不许随枚举顺序漂） */
const comparePaths = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 加载 eraFL 变量字典：`CSV/` 根目录的全部 `*.csv` 名称表 → 市场字典包追加表 →
 * 整棵 ERB 子树的 `.ERH` 作者自定名表（三轮，顺序即裁决序）。
 *
 * `CSV/Chara/`（37 份角色表）不进入：那是角色数据，不是变量名表——本函数只扫
 * `csvDir` 的**直接子文件**，不递归。
 */
export async function loadEraflVariableSchema(
  deps: EraflVariableSchemaDeps,
): Promise<VariableSchema> {
  const { io, csvDir, erbDir, log } = deps;
  const tables = new Map<string, VariableTable>();
  /** 输入摘要素材：实际读到的每份文件的「路径 + 正文」哈希（`foldDigest` 排序折叠 ⇒ 与枚举顺序无关） */
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
    .filter((f) => f.variableName.length > 0)
    .sort((a, b) => comparePaths(a.path, b.path));

  let emptyNameTotal = 0;
  let overwrittenTotal = 0;

  /**
   * 一轮加载：**一次批量读** → 按序并入 → 记摘要。
   *
   * `readTexts` 一次带回 N 份、失败位是 `null`（契约：不整批抛）⇒ 单份读失败只 warn
   * 跳过，其余输入照常（不静默、也不因一份坏文件丢掉整本字典）。
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
   * 只收 `.csv`——eraFL 全树 0 份 `.als`，不为它留死分支（见文件头）。
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
      if (variableName.length > 0) marketFiles.push({ variableName, path: e.path });
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
   *
   * 必须递归整个 ERB 根：eraFL 的声明不集中在 `ERB/ERH/`，`ERB/VARIABLE.ERH` 与各
   * 功能子目录（衣装 / 地图 / 战斗…）都各自声明常量，只扫 `ERB/ERH/` 会漏掉绝大多数。
   * 装载顺序按路径排序（引擎同样按路径装载）⇒ 同名首个定义优先的裁决可复现。
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
      // 不信任桥回来的都是 `.ERH`：读集合的规模是本函数的性能边界，扩展名自己再筛一遍
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
        // 家族级：eraFL 无机读的家族名表 ⇒ 只给变量名（不编显示名，见文件头）
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
       *
       * 引擎侧这条路不是"名称表"而是"索引位是一个表达式"：`CFLAG:衣装部位_頭` 与
       * `CFLAG:0` 是同一个槽位。常量不属于任何族（同一个名字可以写在任意族后面），
       * 故这里只做名字 → 编号的换算、不宣称族归属（`source: 'const'` 把这条意图交给
       * 消费方：族归属只认 `primary` / `append`）。无整数初值的声明（`#DIM NAME`）
       * 名字照样收录（拼错名核对要看见它），但不给 `resolvedIndex`（值运行期才知道）。
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
    /**
     * 枚举该族可写的索引名（契约 `VariableSchema.names`）。
     *
     * 由 `byIndex`（编号 → 名）直接产出：`name` = 索引名、`index` / `resolvedIndex` = 编号、
     * `source` = 该编号的来源层。无该族 → 空数组（不猜）。**不改动 `lookup` 的行为**。
     */
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

export interface EraflInstructionNamesDeps {
  io: FileIO;
  /** 游戏 CSV 根目录（绝对路径；指令名表固定是其中的 `Train.csv`） */
  csvDir: string;
  log: Logger;
}

/**
 * 加载 eraFL 的**指令名表**（`CSV/Train.csv`）→ 契约 `KojoInstructionTable`。
 *
 * 为什么是独立函数而不是 `VariableSchema` 的字段：契约的 `VariableSchema` 没有指令名
 * 查询面（指令表是 `GameAdapter.kojoInstructionTable` 这一个**独立** seam），硬塞进去
 * 要么改契约（禁止），要么在字典对象上挂非契约字段（消费方看不见，等于没做）。
 * 故按"不改契约"的约束拆成独立导出，由适配器装配时各接各的槽位。
 *
 * 与字典共用同一个解析器 ⇒ 同一份 CSV 在 `lookup('TRAIN', 310)` 与
 * `lookupByName('胸愛撫')` 两侧读到**同一个名称**（不会出现两套剥离规则）。
 *
 * 缺表 / 读失败 / 空表 ⇒ `hasTable: false`（消费方据此 fail-closed，不降糖），并 warn。
 */
export async function loadEraflInstructionNames(
  deps: EraflInstructionNamesDeps,
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
  // 文件名大小写不敏感：eraFL 盘上是 `Train.csv`，魔改版可能写成 `TRAIN.CSV`
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
  return {
    hasTable: true,
    lookupByName: (name: string) => {
      const idx = table.byName.get(name);
      return idx === undefined ? undefined : Number(idx);
    },
    lookupByNo: (no: number) => table.byIndex.get(String(no)),
    // 同名多编号按数据序去重（契约要求"返回序即候选展示序"）
    names: () => [...new Set(table.byIndex.values())],
  };
}
