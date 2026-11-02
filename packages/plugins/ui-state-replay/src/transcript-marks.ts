/**
 * 台词可见性的**编辑器内联上屏**（KW-14，2026-11-03；本插件私有，零 React）。
 *
 * 一句话：回放面板算完一次「这份存档 × 这个角色 × 这一段」，把每条台词的可见性
 * **原样钉回源文件里那一行**——作者逐行写口上时不必再切到面板人肉对齐行号。
 *
 * ## 为什么走 `ui.editor.decorator` 这一条通道（判性结论，2026-11-03）
 *
 * 1. **行号锚本来就是现成的**：台词行的 `line` 由抽取侧逐字填成**文件绝对行号**
 *    （1 基）——`condition-extractor/src/display.ts` 的 `collectDisplayLines` 以
 *    `for (let i = startLine; …) out.push({ line: i })` 的形态扫函数体，`transcript.ts`
 *    只是把它原样搬进 `TranscriptLine.line`，中间没有任何"函数内相对行号"的换算，
 *    也没有折行（ERB 一行就是引擎的一条语句；续行写法不在显示行扫描的收录面里）。
 *    ⇒ 缺的不是锚，所以这一格可以做，不是"只能再叠一层面板"。
 * 2. **通道只有一条**：编辑器侧上屏走既有槽 `ui.editor.decorator`
 *    （`EditorDecoratorContribution` / `LineDecoration`），照其既有贡献者的形状接入
 *    （`convention-linter` 的 `convention-issues` 是同一形态的先例：**异步产出的结果留在
 *    插件内存里，`decorate` 只做同步查表**）。不新造贡献类型、不开第二条装饰通道。
 * 3. **默认档 = 默认开，不自创开关**：装饰族（`erb-structure` / `erb-expr-syntax` /
 *    `convention-issues` / `.kojo` 诊断）今天一律无条件上屏，可见性靠 `severity` 分档，
 *    没有 per-贡献开关那套体系；本贡献跟着做，用 `info` 那一档（诊断族里"中性说明"的
 *    既有档位），不新增一份偏好真源。
 *
 * ## 上屏的代价说清楚：这一档是 markers，不是文字 inlay
 *
 * `LineDecoration` 在宿主侧翻成 Monaco **markers**（波浪线 + 悬停 + 问题面板一行），
 * 屏幕上的"内联"因此是**那一行的波浪线与悬停里的那句人话**，不是行尾多出一段灰字。
 * 真要行尾灰字是 `ui.editor.languageService` 的 `inlayHint` 那条腿（拉取式、有自己的
 * 偏好位），那是另一格判性，本批不混做（回报里已列为欠账）。
 *
 * ## 宁撤勿错：三道失效闸（铁律 4「不许静默」的落点）
 *
 * 推演吃的是**盘上那一版**（抽取索引与 `engine.getLines` 都读文件），而装饰吃的是
 * **编辑器缓冲**。两屏真相分叉过一次就会说出"这句不会说"而盘面上已经是另一句话——
 * 那是假缺陷农场，比不画糟得多。于是：
 * - **未存盘**（`editor.documentChanged` 报 dirty）⇒ 整档撤标，留一行说明；
 * - **文本已变**（缓冲指纹 ≠ 发布当刻的缓冲指纹）⇒ 整档撤标，留一行说明；
 * - **同源还没证明**（推演发生在这份文件没进编辑器的时候，还没拿到可采信的缓冲真相）
 *   ⇒ 先不上屏，同样留一行说明，绝不空手冒充"这段没有台词"。
 * 台账只存**指纹**不存正文（口径同宿主 `document-broadcast.ts` 的 PS-5 那一条：整篇正文
 * 常驻会随标签数涨）；这份指纹只服务本缓存自己的失效判定，不是任何共享决策的第二份真源。
 *
 * ## 四档口径（白话第一句 + 机器码留在悬停）
 *
 * 契约给的是三值（`shown` / `hidden` / `maybe`）。第四档不是新造判据：`maybe` 按契约
 * 既有的**可约性**两读（`replayUnknownReducibility`，单一真源在 `plugin-api/replay.ts`）
 * 分开——撞真随机（`RAND`）的是**判不出**（静态快照本来就没有唯一答案，不是能力缺陷），
 * 其余是**看情况**（能力缺口 / 场景输入没给，补得上）。每条 `unknown` 的机器码逐字留在
 * 悬停文本里，报障时还能贴。
 */

import type {
  FunctionReplay,
  LineDecoration,
  Logger,
  ReplayStateView,
  TranscriptLine,
} from '@kojo/plugin-api';
import { pathKey, replayUnknownReducibility } from '@kojo/plugin-api';
import { splitEolLines } from '@kojo/plugin-api/eol';

/** 本贡献的槽位 id（`ui.editor.decorator`） */
export const TRANSCRIPT_DECORATOR_ID = 'state-replay-transcript';
/** 槽位 order：排在既有诊断族（10 / 20 / 21 / 22）之后——同一行先看到错，再看到推演 */
export const TRANSCRIPT_DECORATOR_ORDER = 40;
/** 上屏文本里对这次推演的自称（面板与悬停同一个词，不另造词汇） */
const MARK_SOURCE_LABEL = '台词推演';

/* ─────────────────────────── 四档 ─────────────────────────── */

/**
 * 行内标注的四个档：`shown` / `hidden` 直取契约可见性，
 * `conditional` / `undecidable` 是 `maybe` 的两读（见文件头「四档口径」）。
 */
export type TranscriptMarkTier = 'shown' | 'hidden' | 'conditional' | 'undecidable';

/** 四档的第一眼短名（白话；与回放面板 `preview.ts` 的徽章同词根，不另造词汇） */
export const TRANSCRIPT_TIER_LABEL: Readonly<Record<TranscriptMarkTier, string>> = {
  shown: '会说',
  hidden: '不会说',
  conditional: '看情况',
  undecidable: '判不出',
};

/** 台词行 → 四档（纯函数；`maybe` 没有原因时按"看情况"呈现，并说明是降级） */
export function transcriptMarkTier(line: TranscriptLine): TranscriptMarkTier {
  if (line.visibility === 'shown') return 'shown';
  if (line.visibility === 'hidden') return 'hidden';
  const reason = line.reason;
  return reason && replayUnknownReducibility(reason) === 'irreducible'
    ? 'undecidable'
    : 'conditional';
}

/** 一次推演的身份（哪份存档、哪个角色、哪一段）——每条标注都带上它，免得被当成永恒真相 */
export interface TranscriptBasis {
  readonly functionName: string;
  readonly archivePath: string;
  readonly characterNo: number;
  readonly characterName: string | null;
}

/** 角色位的人话（K7 有名字就带上；面板同款口径） */
function characterLabel(basis: TranscriptBasis): string {
  return `K${basis.characterNo}${basis.characterName ? ` ${basis.characterName}` : ''}`;
}

/** 存档位的短名（只有文件名进悬停，路径不占屏） */
function archiveLabel(basis: TranscriptBasis): string {
  const parts = basis.archivePath.split(/[/\\]/);
  return parts[parts.length - 1] ?? basis.archivePath;
}

/** 「依据：这一段 × 角色 × 存档」——每条标注都自报是哪一次推演说的话 */
function basisNote(basis: TranscriptBasis): string {
  return `依据：${basis.functionName} × ${characterLabel(basis)} × ${archiveLabel(basis)}`;
}

/** 判不出的插值（引擎侧已落成 `%?%`）那一句的补话 */
function unresolvedNote(line: TranscriptLine): string {
  return line.unresolved > 0 ? `另外这句里有 ${line.unresolved} 处内容判不出，会打成 %?%。` : '';
}

/**
 * 一行标注的悬停文本：第一眼是四档短名，接着「为什么」，再接着「该怎么办」，
 * 机器码逐字留在括号里（报障可贴）。纯函数、零 IO。
 */
export function transcriptMarkMessage(line: TranscriptLine, basis: TranscriptBasis): string {
  const tier = transcriptMarkTier(line);
  const guard = line.guardLine !== undefined ? `第 ${line.guardLine} 行` : '守住它的那一行';
  switch (tier) {
    case 'shown':
      return (
        `${TRANSCRIPT_TIER_LABEL.shown}：这个状态下这句会出现在消息窗里。` +
        `为什么：守住这句的每个条件这次都判定为真。${basisNote(basis)}。` +
        `该怎么办：不用动它——换个存档或换个角色，结论就会变。${unresolvedNote(line)}`
      );
    case 'hidden':
      return (
        `${TRANSCRIPT_TIER_LABEL.hidden}：这个状态下这句不会出现。` +
        `为什么：${line.reason ? line.reason.message : '推演这次没给出具体原因（降级：仍按"不会说"呈现，别当成会显示）'}。` +
        `${basisNote(basis)}。` +
        `该怎么办：想让它出现就去改${guard}那条守卫，或者换个状态在回放面板再推一次。${unresolvedNote(line)}`
      );
    case 'undecidable':
      return (
        `${TRANSCRIPT_TIER_LABEL.undecidable}：这句的守卫撞上真随机，静态快照本来就没有唯一答案。` +
        `为什么：${line.reason ? line.reason.message : '未知原因没给出'}（机器码：${line.reason?.code ?? 'other'}）。` +
        `${basisNote(basis)}。` +
        `该怎么办：这不是编辑器判错，也不是能力缺口——要看实际走向只能在游戏里跑这一次。${unresolvedNote(line)}`
      );
    case 'conditional':
      return (
        `${TRANSCRIPT_TIER_LABEL.conditional}：这句可能出现也可能不出现。` +
        `为什么：${line.reason ? line.reason.message : '有条件判不出，但这次没给出原因（降级：按"看情况"呈现）'}（机器码：${line.reason?.code ?? 'other'}——这条条件这次算不出来，不代表这句会说）。` +
        `${basisNote(basis)}。` +
        `该怎么办：在回放面板把场景参数补全、或换一个能判定这条条件的存档再推一次；补不上就是能力缺口，别当它"会显示"。${unresolvedNote(line)}`
      );
  }
}

/* ─────────────────────── 缓冲真相的等值判据 ─────────────────────── */

/**
 * 一份文本的等值判据（长度 + 两条互相独立的 32 位滚动和）。
 *
 * 只回答一件事：「还是不是发布当刻那一份文本」。判"不同"永远照撤（方向安全）；
 * 同长度替换且两条和同时回到原值的量级 ≈2⁻⁶⁴，一次会话内比较次数是千级。
 * 台账存这一枚（约 40 字节），不存整篇正文——同宿主 `document-broadcast.ts` 的 PS-5。
 */
export interface TextDigest {
  readonly length: number;
  readonly a: number;
  readonly b: number;
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const ROLL_PRIME = 1_000_003;

export function digestText(text: string): TextDigest {
  let a = FNV_OFFSET;
  let b = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, FNV_PRIME) >>> 0;
    b = (Math.imul(b, ROLL_PRIME) + c + 1) >>> 0;
  }
  return { length: text.length, a: a >>> 0, b: b >>> 0 };
}

export function sameTextDigest(x: TextDigest | undefined, y: TextDigest): boolean {
  if (!x) return false;
  return x.length === y.length && x.a === y.a && x.b === y.b;
}

/* ─────────────────────────── 上账条目 ─────────────────────────── */

/** 一个文件的一次台词上账（内存态；项目关闭即清） */
export interface TranscriptMarkEntry extends TranscriptBasis {
  /** `pathKey()` 归一后的键（Windows 折叠大小写，与全仓同尺） */
  readonly key: string;
  readonly path: string;
  /** 函数体首行（1 基）——失效说明那一行落在这里 */
  readonly startLine: number;
  /** 这次推演给出的台词行（`hasTranscript = false` 时为空数组） */
  readonly lines: readonly TranscriptLine[];
  /**
   * 引擎这次**有没有给台词区**。`false` = `FunctionReplay.transcript` 缺省
   * （行文本不可得 / 抽取侧无显示行资料）——契约明说这不等于"这段没有台词"，
   * 所以必须说出来，不许画成一片空白。
   */
  readonly hasTranscript: boolean;
  /** 发布当刻（或随后第一次可采信时）采到的缓冲真相指纹；`undefined` = 还没采到 */
  basisDigest: TextDigest | undefined;
  /** 发布当刻这份文件是否有未存盘改动（true ⇒ 推演说的不是屏幕上这一版） */
  readonly dirtyAtPublish: boolean;
  /** 指纹还没采到时，是否已因"期间出现过未存盘改动"而永久放弃采信 */
  basisUnprovable: boolean;
  readonly publishedAt: number;
}

/** 某个文件此刻的行内标注状态（`decorate` 与自证读数的同一口径） */
export type TranscriptMarkStatus =
  | 'none' // 这个文件没推演过（不是"没有台词"，什么都没说）
  | 'marked' // 标注已上屏
  | 'no-transcript' // 推演这次没给台词区（引擎缺省）
  | 'dirty-buffer' // 有未存盘改动 ⇒ 撤标
  | 'text-changed' // 文本与发布当刻不同 ⇒ 撤标
  | 'awaiting-truth'; // 还没证明缓冲与盘上同源 ⇒ 先不上屏

/** 一次投影的结果（状态 + 要上屏的装饰） */
export interface TranscriptMarkProjection {
  readonly status: TranscriptMarkStatus;
  readonly marks: number;
  readonly decorations: readonly LineDecoration[];
}

/** 失效 / 缺席那一行的文案（四档之外的"出声"面：撤了什么、为什么、下一步做什么） */
function statusDecoration(entry: TranscriptMarkEntry, status: TranscriptMarkStatus): LineDecoration {
  const message =
    status === 'dirty-buffer'
      ? `${MARK_SOURCE_LABEL}的行内标注撤下了：这份文件在编辑器里有没存盘的改动，而推演说的是盘上那一版——两边不是同一份文本时不画，免得把"不会说"钉错行。存盘后在回放面板再推一次就会回来。`
      : status === 'text-changed'
        ? `${MARK_SOURCE_LABEL}的行内标注撤下了：这段文本自那次推演之后已经改动过（行号与守卫都不再是算它时的那一份）。在回放面板再推一次就有。`
        : status === 'awaiting-truth'
          ? `${MARK_SOURCE_LABEL}已经算好了，但这轮还没能证明编辑器里的文本就是它算的那一份（这份文件是推演之后才进编辑器的，或中间有过未存盘改动），先不上屏。改动一下或重开这份文件就会补上。`
          : `${MARK_SOURCE_LABEL}这次没有给出台词区（引擎没能读到函数体文本，或抽取侧没有显示行资料）。**这不代表这一段没有会说的话**——想看到逐行标注，在回放面板把这一段再推一次。`;
  return {
    line: entry.startLine,
    severity: status === 'no-transcript' || status === 'awaiting-truth' ? 'info' : 'warning',
    message,
  };
}

/**
 * 台词行在**当前这一行文本**里的列区间（动词起、到行尾）。
 *
 * 定位失败（该行已经不是当初那句）不给列区间 ⇒ 整行装饰，行为可预期。
 * 列一律 1 基、终点半开——宿主 `decorationsToMarkers` 还会按 model 再夹一次。
 */
function sentenceColumns(
  lineText: string | undefined,
  t: TranscriptLine,
): { startColumn: number; endColumn: number } | undefined {
  if (lineText === undefined || t.verb.length === 0) return undefined;
  const at = lineText.indexOf(t.verb);
  if (at < 0) return undefined;
  return { startColumn: at + 1, endColumn: lineText.length + 1 };
}

/**
 * 一次投影（纯函数）：给定上账条目与当前缓冲文本，给出状态与该上的装饰。
 *
 * 判定顺序就是那三道闸（文件头「宁撤勿错」），任何一道不过就整档撤标并留一行说明。
 */
export function projectTranscriptMarks(input: {
  readonly entry: TranscriptMarkEntry | undefined;
  readonly text: string;
  /** 该路径当前是否有未存盘改动（缓冲真相台账给的读数） */
  readonly bufferDirty: boolean;
}): TranscriptMarkProjection {
  const { entry, text, bufferDirty } = input;
  if (!entry) return { status: 'none', marks: 0, decorations: [] };
  if (!entry.hasTranscript)
    return { status: 'no-transcript', marks: 0, decorations: [statusDecoration(entry, 'no-transcript')] };
  if (entry.dirtyAtPublish || bufferDirty)
    return { status: 'dirty-buffer', marks: 0, decorations: [statusDecoration(entry, 'dirty-buffer')] };
  if (entry.basisDigest === undefined) {
    // 发布时还没拿到这份文件的缓冲真相（它是推演之后才进编辑器的）：
    // `observeDocument` 会采信第一份"缓冲即盘上"的指纹；期间出现过未存盘改动
    // （`basisUnprovable`）就永久不再采信。两种都先按"还没证明同源"呈现。
    return { status: 'awaiting-truth', marks: 0, decorations: [statusDecoration(entry, 'awaiting-truth')] };
  }
  if (!sameTextDigest(entry.basisDigest, digestText(text)))
    return { status: 'text-changed', marks: 0, decorations: [statusDecoration(entry, 'text-changed')] };

  const lines = splitEolLines(text);
  const decorations: LineDecoration[] = [];
  for (const t of entry.lines) {
    const span = sentenceColumns(lines[t.line - 1], t);
    decorations.push({
      line: t.line,
      severity: 'info',
      message: transcriptMarkMessage(t, entry),
      ...(span ? span : {}),
    });
  }
  return { status: 'marked', marks: decorations.length, decorations };
}

/* ─────────────────────────── 内存台账（插件态） ─────────────────────────── */

/** 一文件 × 一次推演的台账上限：只留"最近推演过的那几份"，正文一概不留 */
export const TRANSCRIPT_MARKS_MAX_FILES = 4;
/** 缓冲真相台账上限（每条只占一枚指纹，约 40 B） */
const BUFFER_TRUTH_MAX_PATHS = 32;

export interface TranscriptMarkStore {
  /**
   * 一次**正式回放**上账（预演 / 覆盖推演的结果不许进来：那不是盘上真相，
   * 把它钉进编辑器就是拿假设冒充事实）。
   * @returns 上账条目（`hasTranscript = false` 也会上账——缺席要说出来）
   */
  publish(replay: FunctionReplay, view: ReplayStateView): TranscriptMarkEntry;
  /** 吃 `editor.documentChanged`：记缓冲真相指纹与 dirty，并在可采信时补上发布当刻没采到的指纹 */
  observeDocument(ev: { filePath: string; text: string; dirty: boolean }): void;
  /** 装饰通道唯一入口（纯同步查表 + 投影） */
  decorate(file: { path: string; text: string }): LineDecoration[];
  /** 该文件此刻的状态读数（自证用；`marks` = 这一轮真上屏的行数） */
  statusFor(path: string, text: string): TranscriptMarkProjection;
  /** 关掉一份文件：标注随 model 一起走（别在重开时拿旧指纹当真） */
  forget(path: string): void;
  /** 项目关闭 / 换项目：整表清空 */
  clear(): void;
  /** 汇总读数（面板与取证用；零成本） */
  stats(): {
    readonly files: number;
    readonly publishes: number;
    readonly lastStatus: TranscriptMarkStatus;
    readonly lastMarks: number;
  };
}

/**
 * 建台账（激活层调用一次；零 React、零 IO）。
 *
 * @param deps.log 只有降级与越界会出声到这里——屏上的那一句才是给作者看的
 */
export function createTranscriptMarkStore(deps: {
  log: Logger;
  /** 上限可注入（测试钉 LRU 用） */
  maxFiles?: number;
  now?: () => number;
}): TranscriptMarkStore {
  const maxFiles = Math.max(1, deps.maxFiles ?? TRANSCRIPT_MARKS_MAX_FILES);
  const now = deps.now ?? ((): number => Date.now());
  /** pathKey → 上账条目（插入序 = 使用序，超上限从最旧端削） */
  const entries = new Map<string, TranscriptMarkEntry>();
  /** pathKey → 最近一次缓冲真相（只存指纹 + dirty） */
  const bufferTruth = new Map<string, { digest: TextDigest; dirty: boolean }>();
  let publishes = 0;
  let lastStatus: TranscriptMarkStatus = 'none';
  let lastMarks = 0;

  const touchEntry = (entry: TranscriptMarkEntry): void => {
    entries.delete(entry.key);
    entries.set(entry.key, entry);
    while (entries.size > maxFiles) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  return {
    publish(replay, view) {
      const key = pathKey(replay.filePath);
      const truth = bufferTruth.get(key);
      const lines = replay.transcript ?? [];
      const entry: TranscriptMarkEntry = {
        key,
        path: replay.filePath,
        functionName: replay.normalizedName,
        archivePath: view.archivePath,
        characterNo: view.characterNo,
        characterName: view.characterName,
        startLine: replay.startLine,
        lines,
        hasTranscript: replay.transcript !== undefined && lines.length > 0,
        // 发布当刻的缓冲真相；没有就留给 observeDocument 在"可采信"时补一次
        basisDigest: truth && !truth.dirty ? truth.digest : undefined,
        dirtyAtPublish: truth?.dirty === true,
        basisUnprovable: truth === undefined ? false : truth.dirty === true,
        publishedAt: now(),
      };
      if (truth?.dirty === true) {
        deps.log.info(
          `台词行内标注：${replay.filePath} 发布时有未存盘改动，先按撤标呈现（推演说的是盘上那一版）`,
        );
      }
      publishes++;
      touchEntry(entry);
      return entry;
    },

    observeDocument(ev) {
      const key = pathKey(ev.filePath);
      const digest = digestText(ev.text);
      bufferTruth.set(key, { digest, dirty: ev.dirty });
      while (bufferTruth.size > BUFFER_TRUTH_MAX_PATHS) {
        const oldest = bufferTruth.keys().next().value;
        if (oldest === undefined) break;
        bufferTruth.delete(oldest);
      }
      const entry = entries.get(key);
      if (!entry || entry.basisDigest !== undefined) return;
      if (ev.dirty) {
        // 推演之后出现过未存盘改动 ⇒ 之后存盘的那一版也不再可采信（它已经不等于算它时的那一份）
        entry.basisUnprovable = true;
        return;
      }
      if (entry.basisUnprovable) return;
      // 采信第一份"缓冲即盘上"的真相：这一版文本与推演所据的是同一份
      entry.basisDigest = digest;
    },

    decorate(file) {
      const key = pathKey(file.path);
      const entry = entries.get(key);
      if (entry) touchEntry(entry); // 被问到就是还在用的那一份
      const projection = projectTranscriptMarks({
        entry,
        text: file.text,
        bufferDirty: bufferTruth.get(key)?.dirty === true,
      });
      lastStatus = projection.status;
      lastMarks = projection.marks;
      return [...projection.decorations];
    },

    statusFor(path, text) {
      const key = pathKey(path);
      return projectTranscriptMarks({
        entry: entries.get(key),
        text,
        bufferDirty: bufferTruth.get(key)?.dirty === true,
      });
    },

    forget(path) {
      entries.delete(pathKey(path));
    },

    clear() {
      entries.clear();
      bufferTruth.clear();
      publishes = 0;
      lastStatus = 'none';
      lastMarks = 0;
    },

    stats() {
      return { files: entries.size, publishes, lastStatus, lastMarks };
    },
  };
}
