/**
 * eraFL 口上约定规则集（`GameAdapter.conventions`）——**eraFL 的「XML 注册链」知识集中于此**。
 *
 * ## 引擎事实（`D:/Game/erafl` 实测，2026-10-24；规则全部由它推出）
 *
 * 1. `ERB/SYSTEM/FL_INIT_LOADER.ERB` 的 `@FL_INIT_LOADER` 逐个 `CALL` `KOJO_DEFINE_K0..5999`。
 *    也就是说：**没被任何 define 注册的 XML，引擎连打开都不会打开**——把 XML 单独拷进
 *    `ERB/口上` 是不生效的。这条事实就是 `unregistered` 规则的**硬后果**（不是风格建议）。
 * 2. `@KOJO_XML_REGISTER(XML_PATH, CHARA_NO, KOJO_CLASS)` 内部先 `IF EXISTFILE(XML_PATH)`，
 *    不存在则 `THROW`。即 `XML_PATH*` 常量写错 = **开局即抛错**，故 `missing-file` 是 error。
 * 3. `@KOJO_XML_REGISTER_FROM_SPLIT_FILES(DIR, PATTERN, ...)` 按 `ENUMFILES(DIR, PATTERN)`
 *    批量注册（真盘只有 `ERB/TRAIN/CLOSE_COMBAT/99_戦闘メッセージ/KOJO_DEFINE_K99.ERB` 一处）。
 *    本规则集把它当作「**整目录已注册**」：宁可漏报（PATTERN 不匹配的散文件不追究），
 *    也不能把一整个批量注册目录误报成孤儿——误报会让作者去删真正在用的口上。
 * 4. `KOJO_DEFINE_NAME_K{n}` 由口上选择画面用 `EXISTFUNCTION` 探测（`ERB/口上/_KOJO_PATTERN.ERB`），
 *    缺它则该口上在选择画面里没有显示名。
 *
 * ## 为什么「注册点」按**全 ERB 树的 `.xml` 字面量**收集，而不是只认 `XML_PATH*` 常量
 *
 * 真盘 `ERB/口上/28_奥蕾西娅/PORTRAIT_K28.xml` 的注册点写在**另一个文件**里：
 * `KOJO_FUNCTION_K28.ERB:403  CALL LOAD_UNIQUE_XML_PORTRAIT("ERB/口上/28_奥蕾西娅/PORTRAIT_K28.xml", …)`
 * ——立绘 XML 走的是字面路径实参，根本不经 `XML_PATH` 常量。只认常量会把它报成孤儿（实测误报 1 份）。
 * 而 `XML_PATH_COM = "…xml"` 本身就是一条字面量，所以「扫全树的 `.xml` 字面量」是常量口径的
 * **超集**：既不漏掉常量注册点，又顺带覆盖这类非常量注册点。代价是每轮要读全树 ERB（真盘
 * 2,016 份 / 20.7 MB，走 `ctx.readFile` 的整轮记忆化，与索引构建同一批读盘），
 * 换来的是「一条误报都不出」——按 RESEARCH.md §7 的原则，这个方向才是对的。
 *
 * ## 真盘读数（本文件五条规则跑真盘的命中数，测试里逐条钉住）
 *
 * - `unregistered` 2 份（`1146_汎用_負け癖/嫌がるオプション/KOJO_K1146_COM.xml`、
 *   `31_爱丽丝/KOJO_K31_EVENT.xml`——后者是因为 `XML_PATH_EVENT` 被误写成 COM 的路径）；
 * - `missing-file` 0 份（292 条 `XML_PATH*` 常量全部落在存在的文件上）；
 * - `missing-name` 30 个编号（126 个 define 编号里只有 96 个带 NAME）；
 * - `duplicate-number` 0 组（126 个编号各只有一个文件定义）；
 * - `encoding-mismatch` 9 份（1140/1141/1143–1149，UTF-16LE BOM 却声明 `encoding="utf-8"`）。
 *
 * 原则：**宁可漏报不可误报**。拿不准的一律不出问题；但**读盘失败一律抛错**（进
 * `report.failedRules`），绝不把"没读到"伪装成"没问题"。
 */

import type {
  ConventionCheckContext,
  ConventionIssue,
  ConventionRule,
  DirEntry,
  FileIO,
} from '@kojo/plugin-api';
import { basename, dirname, join } from '@kojo/plugin-api';
import { parseKojoDirName } from './chara-csv';
import { ERAFL } from './constants';

/**
 * 规则要用到、而 `ConventionCheckContext` **刻意没有**的三件能力。
 *
 * 为什么不在上下文里要：上下文是游戏无关契约（`plugin-api/src/conventions.ts` 头注），
 * 而这三件都是"这一层才知道该怎么读"的事——
 * - `readBytes`：编码声明与 BOM 的一致性**只能看字节**（`ctx.readFile` 已解码归一，
 *   UTF-16 的 BOM 在那一步就被吃掉了）；
 * - `listDir`：口上 XML 的发现靠目录枚举（XML 不在 ERB 索引里）；
 * - `exists`：`XML_PATH` 常量是"相对游戏根"的字符串，要判存在得自己拼绝对路径。
 *
 * 形状取 `FileIO` 的子集（不另造一套签名）：适配器装配时直接把 `io` 传进来即可。
 */
export type EraflConventionDeps = Pick<FileIO, 'readBytes' | 'listDir' | 'exists'>;

/* ------------------------------ 规则 id ------------------------------ */

const RULE_UNREGISTERED = 'erafl.kojo-xml.unregistered';
const RULE_MISSING_FILE = 'erafl.kojo-xml.missing-file';
const RULE_MISSING_NAME = 'erafl.kojo-define.missing-name';
const RULE_DUPLICATE = 'erafl.kojo-define.duplicate-number';
const RULE_ENCODING = 'erafl.kojo-xml.encoding-mismatch';

/* ------------------------------ 形态判据 ------------------------------ */

/**
 * 索引里的归一化函数名（大写）。
 *
 * 判据必须是**整名**（`^…$`）：真盘 `@KOJO_DEFINE_K5001_IS_MASTER_KOJO` 是另一个函数，
 * 若按前缀匹配，它所在的 9 份 5xxx 文件会被报成"编号 5001 重复定义"——一次 9 条误报。
 */
const DEFINE_KEY = /^KOJO_DEFINE_K(\d+)$/;
const NAME_KEY = /^KOJO_DEFINE_NAME_K(\d+)$/;

/** `#DIM CONST NAME = "值"` / `#DIMS CONST NAME = "值"`（真盘两种都用） */
const CONST_LINE = /^\s*#DIMS?\s+CONST\s+([A-Za-z_]\w*)\s*=\s*"([^"]*)"/i;
/** `CALL KOJO_XML_REGISTER(实参1, …)`：只关心第一个实参（XML 路径） */
const REGISTER_CALL = /^\s*CALL\s+KOJO_XML_REGISTER\s*\(\s*([^,)]+)/i;
/** `CALL KOJO_XML_REGISTER_FROM_SPLIT_FILES(DIR, PATTERN, …)` */
const SPLIT_CALL = /^\s*CALL\s+KOJO_XML_REGISTER_FROM_SPLIT_FILES\s*\(\s*([^,)]+)\s*,\s*([^,)]+)/i;
/** 字符串里的 `.xml` 路径（真盘 323 个不同取值；`@"…"` 原始串形态同样命中） */
const XML_LITERAL = /"([^"\r\n]*?\.xml)"/gi;

const ERB_LIKE = /\.(erb|erh)$/i;
const XML_FILE = /\.xml$/i;

/* ------------------------------ 工具 ------------------------------ */

/**
 * 把「游戏根相对 / 绝对 / 反斜杠 / 大小写」四种写法折成**同一把尺子**：
 * 相对游戏根、正斜杠、小写。真盘是 Windows（大小写不敏感），若按大小写敏感比对，
 * `ERB/口上/x.xml` 与 `erb/口上/X.xml` 会被当成两个文件 ⇒ 孤儿误报。
 */
function refKey(path: string, rootDir: string): string {
  const p = path.trim().replace(/\\/g, '/');
  const root = rootDir.replace(/\\/g, '/').replace(/\/+$/, '');
  let rel = p;
  if (root.length > 0 && p.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    rel = p.slice(root.length + 1);
  }
  return rel.replace(/^\.\//, '').toLowerCase();
}

/** 实参取常量值：`"字面量"` 直接用，否则按（函数体 → 文件级）两级常量表解析；解析不到 = null */
function resolveArg(raw: string, ...tables: ReadonlyArray<ReadonlyMap<string, string>>): string | null {
  const arg = raw.trim();
  const literal = /^"([^"]*)"$/.exec(arg);
  if (literal) return literal[1]!;
  for (const table of tables) {
    const value = table.get(arg.toUpperCase());
    if (value !== undefined) return value;
  }
  return null;
}

/** 收集一段行区间里的 `CONST NAME = "值"`（键统一大写：Emuera 标识符不分大小写） */
function collectConsts(lines: readonly string[], from = 0, to = lines.length): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = from; i < to; i++) {
    const m = CONST_LINE.exec(lines[i] ?? '');
    if (m) out.set(m[1]!.toUpperCase(), m[2]!);
  }
  return out;
}

/** 一个 define 函数体里读出来的注册事实 */
interface DefineSite {
  readonly no: number;
  readonly filePath: string;
  /** `@KOJO_DEFINE_K{n}` 所在行（1 基） */
  readonly line: number;
  /** 本函数体里的 `XML_PATH*` 常量（名字 / 值 / 行号 1 基 / 是否真的喂给了注册调用） */
  readonly paths: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
    readonly line: number;
    readonly registered: boolean;
  }>;
}

/** 一次扫描的全部事实（五条规则共享） */
interface Registry {
  readonly defines: readonly DefineSite[];
  /** define 编号 → 定义点（可能多文件） */
  readonly byNumber: ReadonlyMap<number, readonly DefineSite[]>;
  /** 全树出现过的 `KOJO_DEFINE_NAME_K{n}` 编号 */
  readonly nameNumbers: ReadonlySet<number>;
  /** 全树 `.xml` 字面量（`refKey` 尺子）⇒ 有注册点指向它 */
  readonly referencedXml: ReadonlySet<string>;
  /** `FROM_SPLIT_FILES` 覆盖的目录前缀（`refKey` 尺子） */
  readonly splitDirs: ReadonlySet<string>;
  /** 口上域下的全部 XML 绝对路径（按小写排序，产出稳定） */
  readonly xmlFiles: readonly string[];
}

/** 递归列出目录下的 XML（目录不存在 = 空，不抛：没有口上目录是合法工程状态，不是读盘失败） */
async function listXmlFiles(dir: string, deps: EraflConventionDeps): Promise<string[]> {
  if (!(await deps.exists(dir))) return [];
  let entries: DirEntry[];
  try {
    entries = await deps.listDir(dir);
  } catch (err) {
    // 目录在、却读不出来 ⇒ 抛错（引擎记 failedRules）。返回空数组会被读成"这个目录没有 XML"。
    throw new Error(`口上目录不可读：${dir}（${String(err)}）`);
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) out.push(...(await listXmlFiles(entry.path, deps)));
    else if (XML_FILE.test(entry.name)) out.push(entry.path);
  }
  return out.sort((a, b) => {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
}

/**
 * 扫描一次，五条规则共享。
 *
 * 记忆化键 = **`ctx` 对象**：`convention-linter` 每轮 `run()` 现造一个 ctx（同一处也造了
 * `textCache`），故"一个 ctx = 一轮"成立；五条规则共用一次全树读盘，而不是各读一遍。
 * 若某轮扫描抛错，**拒绝值同样被缓存**——五条规则一起进 `failedRules`，
 * 正是"这一轮这些结论不存在"的如实陈述（不缓存的话会变成五次重复读盘 + 五份同样的错）。
 */
const registries = new WeakMap<ConventionCheckContext, Promise<Registry>>();

function registryOf(ctx: ConventionCheckContext, deps: EraflConventionDeps): Promise<Registry> {
  const cached = registries.get(ctx);
  if (cached) return cached;
  const built = scan(ctx, deps);
  registries.set(ctx, built);
  return built;
}

async function scan(ctx: ConventionCheckContext, deps: EraflConventionDeps): Promise<Registry> {
  const rootDir = ctx.project.rootDir;
  const erbPaths = [...ctx.index.files.keys()].filter((p) => ERB_LIKE.test(p));

  const referencedXml = new Set<string>();
  /** 路径 → 正文（同一轮只读一次；define 体解析与字面量扫描共用） */
  const texts = new Map<string, string>();
  for (const path of erbPaths) {
    const text = await ctx.readFile(path);
    texts.set(path, text);
    for (const m of text.matchAll(XML_LITERAL)) referencedXml.add(refKey(m[1]!, rootDir));
  }

  const defines: DefineSite[] = [];
  const byNumber = new Map<number, DefineSite[]>();
  const nameNumbers = new Set<number>();
  const splitDirs = new Set<string>();

  // 走 `keys()` + 命中后再 `defsOf()`：`entries()` 会为全部键各造一组 ref 数组，
  // 而这里 `DEFINE_` 前缀命中是极少数（`NAME_` 那条只为收集编号，不需要定义）。
  for (const key of ctx.index.byName.keys()) {
    const nameMatch = NAME_KEY.exec(key);
    if (nameMatch) nameNumbers.add(Number(nameMatch[1]));

    const defineMatch = DEFINE_KEY.exec(key);
    if (!defineMatch) continue;
    const no = Number(defineMatch[1]);

    for (const ref of ctx.index.byName.defsOf(key)) {
      const text = texts.get(ref.filePath);
      // 索引里有这个函数、正文却不在表里 ⇒ 索引与文件清单自相矛盾。抛错，不猜。
      if (text === undefined) throw new Error(`索引里的定义点不在 ERB 文件清单中：${ref.filePath}`);
      const lines = text.split('\n');
      // `#DIMS CONST` 在 Emuera 里是函数局部声明，但真盘也见过写在函数外的写法 ⇒ 两级兜底
      const fileConsts = collectConsts(lines);
      const bodyFrom = Math.max(0, ref.startLine - 1);
      const bodyTo = Math.min(lines.length, ref.endLine);
      const bodyConsts = collectConsts(lines, bodyFrom, bodyTo);

      const paths: Array<{ name: string; value: string; line: number; registered: boolean }> = [];
      const sites: string[] = [];
      /**
       * 第一趟：本函数体里真正喂给 `KOJO_XML_REGISTER` 的常量名。
       *
       * 为什么要这趟：`missing-file` 的硬后果是"注册时 EXISTFILE 为假 ⇒ THROW"，
       * 而声明了却没人用的常量根本不参与注册（不会抛错）。只按"常量存在"报错就是误报。
       */
      const calledConsts = new Set<string>();
      for (let i = bodyFrom; i < bodyTo; i++) {
        const callMatch = REGISTER_CALL.exec(lines[i] ?? '');
        if (callMatch) calledConsts.add(callMatch[1]!.trim().toUpperCase());
      }
      for (let i = bodyFrom; i < bodyTo; i++) {
        const line = lines[i] ?? '';
        const constMatch = CONST_LINE.exec(line);
        if (constMatch && /^XML_PATH/i.test(constMatch[1]!)) {
          paths.push({
            name: constMatch[1]!,
            value: constMatch[2]!,
            line: i + 1,
            registered: calledConsts.has(constMatch[1]!.toUpperCase()),
          });
        }
        const splitMatch = SPLIT_CALL.exec(line);
        if (splitMatch) {
          // 只取 DIR（第 1 实参）；PATTERN（第 2 实参）**故意不参与判定**：
          // 按目录整片豁免是"宁可漏报"的方向，拿 PATTERN 精确匹配只会多出一批误报
          const dirValue = resolveArg(splitMatch[1]!, bodyConsts, fileConsts);
          // 目录实参解析不到（魔改写成表达式）⇒ 这条注册点**不参与豁免**：
          // 豁免是"整目录不算孤儿"，拿不准目录就不能豁免（方向仍是宁可漏报：不豁免只会少报）
          if (dirValue !== null) sites.push(refKey(dirValue, rootDir));
        }
      }

      const site: DefineSite = { no, filePath: ref.filePath, line: ref.startLine, paths };
      defines.push(site);
      for (const dir of sites) splitDirs.add(dir);
      const list = byNumber.get(no);
      if (list) list.push(site);
      else byNumber.set(no, [site]);
    }
  }

  // 产出稳定：按（文件, 行）排，避免面板顺序随索引插入序漂
  defines.sort((a, b) => (a.filePath === b.filePath ? a.line - b.line : a.filePath < b.filePath ? -1 : 1));

  return {
    defines,
    byNumber,
    nameNumbers,
    referencedXml,
    splitDirs,
    xmlFiles: await listXmlFiles(join(rootDir, ...ERAFL.paths.kojoRoot), deps),
  };
}

/** XML 所在角色目录的编号（面板分组用；目录名不合约定 ⇒ undefined，不猜） */
function charaNoOf(xmlPath: string): number | undefined {
  return parseKojoDirName(basename(dirname(xmlPath)))?.no;
}

/* ------------------- 规则 1：XML 没有任何注册点（引擎不加载） ------------------- */

/**
 * 孤儿 XML：全树没有任何 `.xml` 字面量指向它，也不在任何 `FROM_SPLIT_FILES` 目录下。
 *
 * 为什么是 warning 而不是 error：文件本身语法完好，只是不会被加载；且真盘存在
 * "手动替换用的可选文件"（`1146_汎用_負け癖/嫌がるオプション/`）这类合法形态，
 * 报成 error 会让作者以为工程坏了。
 */
function createUnregisteredXmlRule(deps: EraflConventionDeps): ConventionRule {
  return {
    id: RULE_UNREGISTERED,
    description: '口上 XML 没有任何注册点（引擎 @FL_INIT_LOADER 不会加载它，这份口上永远不会出现）',
    severity: 'warning',
    source:
      'ERB/SYSTEM/FL_INIT_LOADER.ERB @FL_INIT_LOADER（KOJO_DEFINE_K0..5999）+ 真盘 293 份 XML 实测（2 份无注册点）',
    async check(ctx: ConventionCheckContext): Promise<ConventionIssue[]> {
      const registry = await registryOf(ctx, deps);
      const rootDir = ctx.project.rootDir;
      const issues: ConventionIssue[] = [];
      for (const xmlPath of registry.xmlFiles) {
        const key = refKey(xmlPath, rootDir);
        if (registry.referencedXml.has(key)) continue;
        // `FROM_SPLIT_FILES` 覆盖的整目录：批量注册，按目录豁免（见文件头 3）
        let covered = false;
        for (const dir of registry.splitDirs) {
          if (key === dir || key.startsWith(`${dir}/`)) {
            covered = true;
            break;
          }
        }
        if (covered) continue;
        issues.push({
          ruleId: RULE_UNREGISTERED,
          severity: 'warning',
          message:
            `「${key}」没有任何注册点：引擎 @FL_INIT_LOADER 逐个调用 KOJO_DEFINE_K0..5999，` +
            `整棵 ERB 树里没有任何 .xml 字面量指向这份文件，引擎不会加载它。` +
            `（若它是"手动替换用"的可选文件，可忽略本提示。）`,
          filePath: xmlPath,
          characterNo: charaNoOf(xmlPath),
          key: `${RULE_UNREGISTERED}|${key}`,
        });
      }
      return issues;
    },
  };
}

/* ------------------- 规则 2：XML_PATH 常量指向的文件不存在 ------------------- */

function createMissingXmlFileRule(deps: EraflConventionDeps): ConventionRule {
  return {
    id: RULE_MISSING_FILE,
    description: 'XML_PATH* 常量指向的口上 XML 不存在（KOJO_XML_REGISTER 会 THROW，开局即报错）',
    severity: 'error',
    source: 'ERB/SYSTEM/FL_INIT_LOADER.ERB @KOJO_XML_REGISTER（IF EXISTFILE 否则 THROW）',
    async check(ctx: ConventionCheckContext): Promise<ConventionIssue[]> {
      const registry = await registryOf(ctx, deps);
      const rootDir = ctx.project.rootDir;
      const issues: ConventionIssue[] = [];
      for (const site of registry.defines) {
        for (const constant of site.paths) {
          // 只审"真的喂给了注册调用"的常量：声明了不用的常量不会触发 EXISTFILE 检查
          if (!constant.registered) continue;
          // 目录形态的值（`FROM_SPLIT_FILES` 的 DIR）不是文件，不归本规则管
          if (!XML_FILE.test(constant.value.trim())) continue;
          const abs = join(rootDir, ...constant.value.trim().replace(/\\/g, '/').split('/'));
          if (await deps.exists(abs)) continue;
          issues.push({
            ruleId: RULE_MISSING_FILE,
            severity: 'error',
            message:
              `KOJO_DEFINE_K${site.no} 的 ${constant.name} 指向「${constant.value}」，但这份文件不存在：` +
              `@KOJO_XML_REGISTER 会因 EXISTFILE 为假而 THROW，游戏开局即报错。`,
            filePath: site.filePath,
            line: constant.line,
            characterNo: site.no,
            key: `${RULE_MISSING_FILE}|${site.no}|${constant.name.toUpperCase()}`,
          });
        }
      }
      return issues;
    },
  };
}

/* ------------------- 规则 3：有 define 没有 KOJO_DEFINE_NAME ------------------- */

function createMissingDefineNameRule(deps: EraflConventionDeps): ConventionRule {
  return {
    id: RULE_MISSING_NAME,
    description: '有 @KOJO_DEFINE_K{n} 但没有 @KOJO_DEFINE_NAME_K{n}（口上选择画面里没有显示名）',
    severity: 'warning',
    source:
      '真盘 126 个 define 编号 / 96 个 NAME（缺 30 个）+ ERB/口上/_KOJO_PATTERN.ERB 的 EXISTFUNCTION 探测',
    async check(ctx: ConventionCheckContext): Promise<ConventionIssue[]> {
      const registry = await registryOf(ctx, deps);
      const issues: ConventionIssue[] = [];
      for (const [no, sites] of registry.byNumber) {
        if (registry.nameNumbers.has(no)) continue;
        const site = sites[0]!;
        issues.push({
          ruleId: RULE_MISSING_NAME,
          severity: 'warning',
          message:
            `KOJO_DEFINE_K${no} 没有配套的 @KOJO_DEFINE_NAME_K${no}：` +
            `口上选择画面用 EXISTFUNCTION 探测这个函数，缺它则该口上在选择画面里没有显示名。`,
          filePath: site.filePath,
          line: site.line,
          characterNo: no,
          key: `${RULE_MISSING_NAME}|${no}`,
        });
      }
      return issues;
    },
  };
}

/* ------------------- 规则 4：两个文件定义同一编号 ------------------- */

function createDuplicateDefineNumberRule(deps: EraflConventionDeps): ConventionRule {
  return {
    id: RULE_DUPLICATE,
    description: '两个文件定义同一 @KOJO_DEFINE_K{n}（后者覆盖前者，先被加载的那份口上静默失效）',
    severity: 'error',
    source: 'ERB/SYSTEM/FL_INIT_LOADER.ERB（逐个 CALL，同编号重复 = 后一次覆盖前一次）',
    async check(ctx: ConventionCheckContext): Promise<ConventionIssue[]> {
      const registry = await registryOf(ctx, deps);
      const issues: ConventionIssue[] = [];
      for (const [no, sites] of registry.byNumber) {
        // 同一文件里重复定义同名函数不算"两个文件"（那是另一类问题，本规则不猜）
        const files = [...new Set(sites.map((s) => s.filePath))];
        if (files.length < 2) continue;
        const where = sites.map((s) => `${s.filePath}:${s.line}`).join('、');
        const later = sites[sites.length - 1]!;
        issues.push({
          ruleId: RULE_DUPLICATE,
          severity: 'error',
          message:
            `编号 ${no} 被 ${files.length} 个文件同时定义：${where}。` +
            `引擎逐个 CALL 同名函数，后加载的那份覆盖前者，先加载的口上会静默失效。`,
          filePath: later.filePath,
          line: later.line,
          characterNo: no,
          key: `${RULE_DUPLICATE}|${no}`,
        });
      }
      return issues;
    },
  };
}

/* ------------------- 规则 5：声明 utf-8 但字节是 UTF-16 BOM ------------------- */

/** BOM 判定（只看前两字节；`FF FE` 也可能是 UTF-32LE 的前缀，但本作不存在 UTF-32 语料） */
function utf16BomOf(bytes: Uint8Array): 'le' | 'be' | null {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'be';
  return null;
}

/**
 * 解出开头一段文本（只为读 XML 声明）。
 *
 * 为什么手写而不用 `TextDecoder`：适配器跑在插件宿主里，编码表不是本包该依赖的东西；
 * 声明是纯 ASCII，逐码元拼 512 字节足够，也不会有"探测失败静默回退"的歧义。
 */
function utf16Prefix(bytes: Uint8Array, order: 'le' | 'be'): string {
  const limit = Math.min(bytes.length, 512);
  let out = '';
  for (let i = 2; i + 1 < limit; i += 2) {
    const lo = bytes[i]!;
    const hi = bytes[i + 1]!;
    out += String.fromCharCode(order === 'le' ? lo | (hi << 8) : (lo << 8) | hi);
  }
  return out;
}

const XML_DECL = /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i;

function createEncodingMismatchRule(deps: EraflConventionDeps): ConventionRule {
  return {
    id: RULE_ENCODING,
    description: 'XML 声明 encoding="utf-8" 但字节是 UTF-16 BOM（解码器按声明读会得到乱码）',
    severity: 'warning',
    source: '真盘 293 份口上 XML 实测（9 份 UTF-16LE BOM 却声明 utf-8：1140/1141/1143–1149）',
    async check(ctx: ConventionCheckContext): Promise<ConventionIssue[]> {
      const registry = await registryOf(ctx, deps);
      const issues: ConventionIssue[] = [];
      for (const xmlPath of registry.xmlFiles) {
        const bytes = await deps.readBytes(xmlPath);
        const order = utf16BomOf(bytes);
        if (order === null) continue; // 无 UTF-16 BOM ⇒ 声明 utf-8 与字节一致，不归本规则
        const declared = XML_DECL.exec(utf16Prefix(bytes, order))?.[1]?.trim().toLowerCase();
        if (declared === undefined) continue; // 没有声明 ⇒ 解码器按 BOM 走，一致，不报
        if (declared !== 'utf-8' && declared !== 'utf8') continue; // 声明 utf-16 ⇒ 与字节一致
        const key = refKey(xmlPath, ctx.project.rootDir);
        issues.push({
          ruleId: RULE_ENCODING,
          severity: 'warning',
          message:
            `「${key}」声明 encoding="${declared}"，但字节是 UTF-16${order === 'le' ? 'LE' : 'BE'} BOM：` +
            `按 XML 规范解码器以声明为准（UTF-8），整份文档会读成乱码/空文档。` +
            `请把它另存为 UTF-8（BOM 可有可无），或把声明改成 utf-16。`,
          filePath: xmlPath,
          characterNo: charaNoOf(xmlPath),
          key: `${RULE_ENCODING}|${key}`,
        });
      }
      return issues;
    },
  };
}

/* ---------------------------- 汇总 ---------------------------- */

/**
 * 构造 eraFL 约定规则集（供 `GameAdapter.conventions` 使用）。
 *
 * `deps` 只补上下文刻意不给的三件读盘能力（见 {@link EraflConventionDeps}）；
 * 文本一律走 `ctx.readFile`（引擎整轮记忆化，五条规则共享同一批读盘）。
 *
 * 规则全部 `scope:'project'`（缺省）：判定都依赖跨文件事实（"别处有没有注册点"
 * "这个名字在不在别的文件里"），任一 ERB 变化都可能改变结论。
 */
export function createEraflConventions(deps: EraflConventionDeps): readonly ConventionRule[] {
  return [
    createUnregisteredXmlRule(deps),
    createMissingXmlFileRule(deps),
    createMissingDefineNameRule(deps),
    createDuplicateDefineNumberRule(deps),
    createEncodingMismatchRule(deps),
  ];
}
