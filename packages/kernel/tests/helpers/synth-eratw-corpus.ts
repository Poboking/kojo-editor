/**
 * PERF-9 量例盘生成器（**合成** eraTW 形状的可写工程，只落 `os.tmpdir()`）。
 *
 * ## 为什么必须合成
 * PERF-9 要答的是「**改一棵文件之后的重抽/重校成本是否随项目大小线性涨**」。这条量测
 * 要写盘（改一棵 ⇒ mtime/size 必须真的变），而**语料盘整体只读是硬约束**（AGENTS §二 铁律 5）
 * ⇒ 只能自造一棵能写的盘。真实语料在本机的读数只能证明「全命中时 19–20ms」，
 * 证不了「改一棵」的那一支。
 *
 * ## 形状照真语料造（别造 10 行的玩具文件）
 * 真语料口径（STATE §二）：**2,325 口上文件 / 99,228 函数**（≈43 函数每文件）、
 * **4,126,929 行 / 3,971 文件**（≈1,040 行每文件）、**493,857 谓词 / 99,228 函数**
 * （≈5 谓词每函数）。本生成器按同一组比例造：默认 40 函数/文件、正文 ~24–30 行/函数、
 * 每函数 5–8 个控制流语句，函数体量按「多数中等 + 少数长」分布（确定性伪随机，同 seed 同盘）。
 * 正文是 CJK ⇒ UTF-16 码元数 ≠ 盘上字节数（PITFALLS §68 那条口径差在这里同样成立）。
 *
 * ## 目录形状（eraTW 实测骨架，`eratw-adapter/src/constants.ts` 是唯一真源）
 * ```
 * <root>/CSV/Chara/Chara{no} 合成角色{no}.csv     ← adapter detect 的必要条件之一
 * <root>/CSV/CFLAG.csv, Talent.csv                ← 变量字典（抽取的 schema 标注来源）
 * <root>/plugins/tw_csv_chs.xml                   ← 汉化名词典（缺席也只降级，这里给一份最小的）
 * <root>/ERB/口上・メッセージ関連/KOJO_MESSAGE.ERB  ← 口上路由总表（调用协议来源）
 * <root>/ERB/口上・メッセージ関連/個人口上/{NNN} …\ ← kojoPaths 根（索引/抽取/校验只看这里）
 * <root>/ERB/共通/*.ERH                            ← 作者自定名表（变量字典走整棵 ERB 根）
 * <root>/sav/                                      ← 空目录（本批不碰存档链路）
 * ```
 *
 * ## 纪律
 * - 夹具**内容不入库**（体积太大），仓库里只留这份生成代码；跑完由调用方自删临时盘；
 * - 零游戏专有名词/角色名：全部是「合成角色 N」，不复制任何真实语料正文。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join as nodeJoin } from 'node:path';

/** 每棵口上文件的函数数（真语料 ≈43） */
const FN_PER_FILE = 40;
/** 每多少个口上文件摊一个角色（真语料 2,285 文件 / 155 角色 ≈ 15） */
const FILES_PER_CHARA = 15;
const MAX_CHARAS = 155;

/** 口上文件的一组面名（照真语料的「指令/对话/通信/日常/排除」分档，名字是自造的） */
const FACE_GROUPS = ['指令', '对话', '通信', '日常', '排除', '変身', '結果', '成功'] as const;

export interface SynthCorpus {
  /** 工程根（绝对路径，tmpdir 下） */
  readonly root: string;
  /** 口上域根（= 项目的 kojoPaths[0]） */
  readonly kojoRoot: string;
  /** CHARA CSV 之一（改它 ⇒ `inputDigest` 变 ⇒ 派生缓存全局判据失效） */
  readonly charaCsvPath: string;
  /** 口上域内全部 `.ERB` 绝对路径（生成序） */
  readonly erbPaths: readonly string[];
  /** 每份口上文件的原始正文（改一棵后据此还原，保证各轮之间盘内容一致） */
  readonly originals: ReadonlyMap<string, string>;
  readonly files: number;
  readonly functions: number;
  readonly lines: number;
  readonly bytes: number;
}

/**
 * 确定性伪随机（LCG）：不用 `Math.random` ⇒ 同一档规模的盘在任何机器上逐字节同形，
 * 复跑可比、失败可复现。
 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** 台词正文（CJK：制造「码元数 ≠ 字节数」的口径差；每行长度照真语料） */
const LINES_A = [
  '她微微侧过头，视线在别处停了一会儿。',
  '「……这种事，也要事先说一声才行。」',
  '房间里的空气慢慢沉下来，只剩时钟的声音。',
  '她的手指无意识地揪住被角，又松开。',
  'PRINTFORML 一声叹息落在两人之间。',
  '她像是想说什么，最后只是摇了摇头。',
  '「别用那种眼神看我，会不知道怎么办才好。」',
  '烛火晃了一下，影子在墙上拉长又缩短。',
];

/**
 * 一个函数的正文。控制流形态照口上真实写法：`IF/ELSEIF/ELSE…ENDIF` 链、
 * `SELECTCASE/CASE…ENDSELECT` 与少量 `WAIT`，条件里出现变量字典认识的名字
 * （`CFLAG:2` 好感度、`TALENT:恋慕`、`TFLAG:193`…）⇒ 抽取段有真实的谓词与依赖密度。
 *
 * @param density 体量档（0 短 / 1 中 / 2 长）——照「多数中等 + 少数两端」的分布给
 * @param fnNumber 全库唯一的函数编号（见 `erbSource`：撞名的量例盘会让 duplicate-function
 *   规则吐出几万条问题，校验段的墙钟就被「问题对象构造」这笔非典型成本淹掉了）
 */
function functionBody(
  no: number,
  face: string,
  fnNumber: number,
  refNumber: number,
  rnd: () => number,
  density: 0 | 1 | 2,
): string {
  const blocks = density === 0 ? 1 : density === 1 ? 2 : 4;
  const i = fnNumber;
  const out: string[] = [
    ';==================================================',
    `; K${no} ${face} ${fnNumber} —— 合成台词（个人口上量例，非真实角色）`,
    ';==================================================',
    `@M_KOJO_K${no}_${face}${fnNumber}`,
    '#DIM LOCAL, 状態, 1',
    'LOCAL = 1',
  ];
  for (let b = 0; b < blocks; b++) {
    const th = 100 + Math.floor(rnd() * 900);
    if (b % 3 === 2) {
      out.push('SELECTCASE RESULTS');
      out.push('CASE 1');
      out.push(`\t${LINES_A[(i + b) % LINES_A.length]}`);
      out.push('CASE 2, 3');
      out.push(`\tPRINTFORMDW ${LINES_A[(i + b + 1) % LINES_A.length]}`);
      out.push('CASEELSE');
      out.push('\tRETURN 0');
      out.push('ENDSELECT');
      continue;
    }
    out.push(`IF CFLAG:2 >= ${th}`);
    out.push('\tIF TALENT:恋慕');
    out.push(`\t\t${LINES_A[i % LINES_A.length]}`);
    out.push('\t\tPRINTFORMDW 她的声音比平时低了一些。');
    out.push('\tELSEIF CFLAG:100 > 0');
    out.push(`\t\t${LINES_A[(i + 2) % LINES_A.length]}`);
    out.push('\tELSE');
    out.push('\t\tRETURN 0');
    out.push('\tENDIF');
    if (density !== 0) {
      out.push(`ELSEIF TFLAG:193 == ${1 + (i % 4)}`);
      out.push(`\tCALL M_KOJO_K${no}_${face}${refNumber}(ARG:1)`);
      out.push(`\t${LINES_A[(i + 4) % LINES_A.length]}`);
      out.push('\tIF ITEM:酒');
      out.push('\t\tWAIT 1');
      out.push('\tENDIF');
    }
    out.push('ELSE');
    out.push(`\t${LINES_A[(i + 6) % LINES_A.length]}`);
    out.push('\tENDIF');
  }
  out.push('RETURN 1', 'END', '');
  return out.join('\n');
}

/** 一棵口上文件：按「短/中/长」三档造函数体量，平均落在真语料 ≈24 行/函数附近 */
function erbSource(no: number, face: string, fileIndex: number, files: number): string {
  const rnd = lcg(0x9e37 + fileIndex * 2654435761);
  const parts: string[] = [`; 合成量例盘：K${no} ${face}（第 ${fileIndex}/${files} 棵，非真实语料）`];
  // 函数编号**全库唯一**（`fileIndex * FN_PER_FILE + i + 1`）：真语料的 99,228 函数里
  // 重名是极少数（约定校验全量才 793 条问题），撞名的量例盘会让 duplicate-function
  // 一条吐出几万条问题，校验段墙钟就变成在量「构造问题对象」而不是量增量化形状。
  const base = fileIndex * FN_PER_FILE;
  for (let i = 0; i < FN_PER_FILE; i++) {
    const r = rnd();
    const density: 0 | 1 | 2 = r < 0.25 ? 0 : r < 0.85 ? 1 : 2;
    const refNumber = base + ((i + 3) % FN_PER_FILE) + 1; // 同文件内的兄弟函数（引用流水非空）
    parts.push(functionBody(no, face, base + i + 1, refNumber, rnd, density));
  }
  return parts.join('\n');
}

/** eraTW 的盘上口径：UTF-8 BOM + LF（`encodeErbBytes` 同形） */
function erbBytes(text: string): Buffer {
  return Buffer.from(`\uFEFF${text}`, 'utf8');
}

export interface SynthOptions {
  /** 口上域里的 `.ERB` 棵数（判据①的自变量） */
  files: number;
}

/** 生成（并落盘）一棵合成工程；调用方负责事后删除 `root`。 */
export function writeSynthCorpus(root: string, opts: SynthOptions): SynthCorpus {
  const files = opts.files;
  const charas = Math.max(2, Math.min(MAX_CHARAS, Math.ceil(files / FILES_PER_CHARA)));
  const kojoRoot = nodeJoin(root, 'ERB', '口上・メッセージ関連', '個人口上');
  mkdirSync(kojoRoot, { recursive: true });
  mkdirSync(nodeJoin(root, 'CSV', 'Chara'), { recursive: true });
  mkdirSync(nodeJoin(root, 'ERB', '口上・メッセージ関連'), { recursive: true });
  mkdirSync(nodeJoin(root, 'ERB', '共通'), { recursive: true });
  mkdirSync(nodeJoin(root, 'plugins'), { recursive: true });
  mkdirSync(nodeJoin(root, 'sav'), { recursive: true });

  // ---- CSV/Chara：编号 / 名前 / 呼び名（`番号` 行 + 文件名回退双通道） ----
  let charaCsvPath = '';
  for (let no = 1; no <= charas; no++) {
    const p = nodeJoin(root, 'CSV', 'Chara', `Chara${no} 合成角色${no}.csv`);
    writeFileSync(p, [`番号,${no},`, `名前,合成角色${no},`, `呼び名,角色${no},`, '基礎,体力,1000', ''].join('\n'), 'utf8');
    if (no === 1) charaCsvPath = p;
  }

  // ---- 变量名称表（抽取的 schema 标注来源；条目数照真语料的量级下限，够命中即可） ----
  const cflag = ['; 合成名称表'];
  for (let i = 1; i <= 220; i++) cflag.push(`${i},合成标志${i}`);
  cflag.push('2,好感度');
  writeFileSync(nodeJoin(root, 'CSV', 'CFLAG.csv'), `${cflag.join('\n')}\n`, 'utf8');
  writeFileSync(nodeJoin(root, 'CSV', 'Talent.csv'), ['; 合成名称表', '3,恋慕', '4,特殊', ''].join('\n'), 'utf8');
  writeFileSync(nodeJoin(root, 'plugins', 'tw_csv_chs.xml'), '<?xml version="1.0" encoding="utf-8"?>\n<root/>\n', 'utf8');

  // ---- 口上路由总表（调用协议解析来源） ----
  writeFileSync(
    nodeJoin(root, 'ERB', '口上・メッセージ関連', 'KOJO_MESSAGE.ERB'),
    erbBytes(
      [
        '; 合成量例盘：口上路由总表（最小形状）',
        '@KOJO_MESSAGE_SEND',
        'TRYCALLFORM M_KOJO%KOJO_NAME%_MESSAGE_COM_K{NO:TARGET}_{ARG:1}(ARG:3)',
        'RETURN 1',
        '',
      ].join('\n'),
    ),
  );

  // ---- `.ERH` 作者自定名表（变量字典要吃整棵 ERB 根，这里给两份） ----
  writeFileSync(
    nodeJoin(root, 'ERB', '共通', '合成自定名.ERH'),
    erbBytes(['#DIM CONST 合成基准, 100', '#DIM CONST 合成上限, 900', '#DIM CONST 合成面数, 8', ''].join('\n')),
  );

  // ---- 口上域：N 棵 `.ERB`，按角色摊进 `{NNN} label` 目录 ----
  const erbPaths: string[] = [];
  const originals = new Map<string, string>();
  let totalLines = 0;
  let totalBytes = 0;
  for (let f = 0; f < files; f++) {
    const no = 1 + (f % charas);
    const face = FACE_GROUPS[Math.floor(f / charas) % FACE_GROUPS.length]!;
    const dir = nodeJoin(kojoRoot, `${String(no).padStart(3, '0')} 合成角色${no}`);
    mkdirSync(dir, { recursive: true });
    const name = `M_KOJO_K${no}_${face}_${String(f).padStart(4, '0')}.ERB`;
    const path = nodeJoin(dir, name);
    const text = erbSource(no, face, f, files);
    const bytes = erbBytes(text);
    writeFileSync(path, bytes);
    erbPaths.push(path);
    originals.set(path, text);
    totalLines += text.split('\n').length;
    totalBytes += bytes.length;
  }

  return {
    root,
    kojoRoot,
    charaCsvPath,
    erbPaths,
    originals,
    files,
    functions: files * FN_PER_FILE,
    lines: totalLines,
    bytes: totalBytes,
  };
}

/** 读回一棵口上文件的当前正文（还原/改动都走这里，避免缓存与盘不一致） */
export function readCorpusFile(path: string): string {
  // BOM 剥掉，与 `originals` 的无 BOM 口径对齐
  const raw = readFileSync(path, 'utf8');
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/**
 * 「改一棵」＝在文件头注释后插一行作者批注（mtime 与 size **双双**变化，两个判据都兜得住）。
 *
 * 刻意**不加函数、不改谓词**：这样「改一棵」轮的抽取统计（函数数/谓词数/依赖数）应与
 * 全量轮**逐项相等**，比对「复用计数不为假」时不会混进真实内容差异带来的差异。
 * 这也更贴近作者日常：改的是台词正文，不是函数结构。
 */
export function mutateOneCorpusFile(path: string, tag: string): string {
  const text = readCorpusFile(path);
  const lines = text.split('\n');
  lines.splice(1, 0, `; 作者批注 ${tag}（量例：只改正文，不动函数结构）`);
  writeFileSync(path, erbBytes(lines.join('\n')));
  return path;
}

/** 还原一棵口上文件到原始正文（保证各档/各轮的盘内容逐轮一致） */
export function restoreCorpusFile(path: string, text: string): void {
  writeFileSync(path, erbBytes(text));
}

/**
 * 「改摘要覆盖面」＝动一份非 ERB 输入（CHARA CSV 正文）⇒ `GameProject.inputDigest` 变
 * ⇒ 抽取/校验的**全局**判据失效 ⇒ 一次性全量重算（PITFALLS §76 那条形状）。
 * ERB 指纹不受影响，所以索引段仍只按文件粒度失效——这正是两层判据该分开的原因。
 */
export function mutateInputDigest(csvPath: string, tag: string): void {
  const text = readFileSync(csvPath, 'utf8');
  writeFileSync(csvPath, `${text}\n; digest ${tag}\n`, 'utf8');
}

export { FN_PER_FILE };
