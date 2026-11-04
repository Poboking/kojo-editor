/**
 * 工作区里"新建文件 / 新建文件夹"的命名与落点规则（2026-10-12 反馈 1b）。
 *
 * 纯函数，零 IO —— 面板只负责收集一个名字，能不能建、建成什么样，全在这里判完。
 *
 * ## 为什么是"拒绝并说明"而不是"静默消毒"
 *
 * 脚手架那边（`scaffold.ts` 的 `sanitizeSegment`）确实会剔除非法字符——那是**程序自己
 * 拼出来**的名字，消毒无害。但这里输入来自作者手打的字符串：把他写的 `A/B` 悄悄改成 `AB`
 * 再建出来，他会以为编辑器坏了。**输入端一律拒绝并给原因**，让他自己改。
 *
 * ## 扩展名的态度
 *
 * 作者从菜单里已经选了类型（`.kojo` / `.erb` / `.erm` / `.erh` / `.txt` / `.md`），所以：
 * - 没写扩展名 → 按所选类型补上；
 * - 写的就是所选类型 → 原样；
 * - 写的是**别的**扩展名（选 `.kojo` 却打 `事件.ERB`）→ 拒绝。
 *   不静默产出 `事件.ERB.kojo`，也不偷偷改判成 `.ERB`——两者都不是他点的那个菜单项。
 */

import { ERB_BODY_EXTENSIONS, ERB_DECLARATION_EXTENSIONS, join, KOJO_SOURCE_EXTENSION } from '@kojo/plugin-api';

/** 可新建的类型（菜单顺序即此顺序） */
export type NewItemKind = 'folder' | 'kojo' | 'erb' | 'erm' | 'erh' | 'txt' | 'md';

/** 文件档（`folder` 之外）；扩展名表只覆盖这几档 */
type FileKind = Exclude<NewItemKind, 'folder'>;

/**
 * 每档文件对应的扩展名（含点）。
 *
 * `kojo` 与两种 ERB 正文档、ERB 声明档**一律取契约单源**（`KOJO_SOURCE_EXTENSION` /
 * `ERB_BODY_EXTENSIONS` / `ERB_DECLARATION_EXTENSIONS`），本模块不手抄这几种形态；`.txt` / `.md` 不是游戏编译的
 * 契约词汇（引擎不认），是新建面板自己的产物，故落点在本模块。
 */
const FILE_EXTENSIONS: Record<FileKind, string> = {
  kojo: KOJO_SOURCE_EXTENSION,
  erb: erbBodyExtension(0),
  erm: erbBodyExtension(1),
  erh: erbDeclarationExtension(0),
  txt: '.txt',
  md: '.md',
};

/** 取 ERB 正文扩展名清单的第 n 项；清单短了直接报错，不静默产出一个没根据的名字 */
function erbBodyExtension(index: number): string {
  const ext = ERB_BODY_EXTENSIONS[index];
  if (ext === undefined) throw new Error(`ERB 正文扩展名清单缺少第 ${index + 1} 项：无法给新建条目定扩展名。`);
  return ext;
}

/**
 * 取 ERB **声明**扩展名清单的第 n 项；清单短了直接报错。
 *
 * 与 {@link erbBodyExtension} 同样不吞错：声明档是"整份只有 `#DIM`/`#DIMS`/`#DEFINE`"的
 * 独立形态，扩展名若被悄悄写成别的东西，建出来的文件引擎不会预载——那是最难查的一类空转。
 */
function erbDeclarationExtension(index: number): string {
  const ext = ERB_DECLARATION_EXTENSIONS[index];
  if (ext === undefined) throw new Error(`ERB 声明扩展名清单缺少第 ${index + 1} 项：无法给新建条目定扩展名。`);
  return ext;
}

/** 去掉前导点并小写：判"这个名字写的是哪种扩展名"用的形态 */
function bareExtension(ext: string): string {
  return (ext.startsWith('.') ? ext.slice(1) : ext).toLowerCase();
}

/** 菜单项：标签给眼睛，hint 给悬停（作者要知道点了会建成什么） */
export const NEW_ITEM_MENU: readonly { kind: NewItemKind; label: string; hint: string }[] = [
  {
    kind: 'kojo',
    label: `新建口上文件（${FILE_EXTENSIONS.kojo}，kojo 2.0）`,
    hint: '写 kojo（2.0）写法；行内可嵌 `@原生` 直通 ERB',
  },
  {
    kind: 'erb',
    label: `新建 ERB 文件（${FILE_EXTENSIONS.erb.toUpperCase()}）`,
    hint: '只写原生语法，不经转译',
  },
  {
    kind: 'erm',
    label: `新建 ERB 正文文件（${FILE_EXTENSIONS.erm}）`,
    hint: `部分引擎的正文用 ${FILE_EXTENSIONS.erm} 扩展名：只写原生语法，不经转译`,
  },
  {
    kind: 'erh',
    label: `新建 ERB 声明文件（${FILE_EXTENSIONS.erh.toUpperCase()}）`,
    hint: '只放 #DIM / #DIMS / #DEFINE；写成普通语句会让引擎中止整轮头文件加载',
  },
  {
    kind: 'txt',
    label: `新建文本文件（${FILE_EXTENSIONS.txt}）`,
    hint: '说明、备忘、搬运记录等附加文件',
  },
  {
    kind: 'md',
    label: `新建笔记文件（${FILE_EXTENSIONS.md}）`,
    hint: '标题、清单、链接都能标出来的笔记；不参与口上编译与部署',
  },
  { kind: 'folder', label: '新建文件夹', hint: '在当前位置建一个子目录' },
];

/**
 * 已知的文件扩展名（判"写的是别的类型"用）。
 *
 * `.kojo` / `.erb` / `.erm` / `.erh` 经 {@link FILE_EXTENSIONS} 从契约单源导出；
 * `.json` / `.csv` 是工作区里常见但本菜单不产出的类型，仍算"你写的是别的类型"。
 */
const KNOWN_EXTS: readonly string[] = [
  ...Object.values(FILE_EXTENSIONS).map(bareExtension),
  'json',
  'csv',
];

/** Windows 文件名非法字符 + 控制字符（口上库要在 Windows 上跑，按最严的一方来） */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/;

/** 解析结果：成功给绝对路径与展示名，失败给中文原因 */
export type NewItemResolution =
  | { ok: true; absPath: string; displayName: string }
  | { ok: false; reason: string };

/**
 * 算出"在该目录建这样一个条目"的绝对路径。
 *
 * 不查存在性（那是 IO 的事，交给调用方 `io.exists`）；只管名字本身。
 */
export function resolveNewItemPath(
  dir: string,
  rawName: string,
  kind: NewItemKind,
): NewItemResolution {
  const name = rawName.trim();
  if (name.length === 0) {
    return { ok: false, reason: kind === 'folder' ? '文件夹名不能为空。' : '文件名不能为空。' };
  }
  if (ILLEGAL.test(name)) {
    return { ok: false, reason: `名称不能含这些字符：\\ / : * ? " < > | 以及控制字符（Windows 文件系统限制）。` };
  }
  if (name === '.' || name === '..') {
    return { ok: false, reason: '「.」与「..」是路径本身，不能用作名称。' };
  }
  // Windows 不允许名字以点或空格结尾（会被静默裁掉，于是建出来的不是你要的那个名字）
  if (/[. ]$/.test(name)) {
    return { ok: false, reason: '名称不能以点号或空格结尾（Windows 会把它裁掉，导致名字对不上）。' };
  }

  if (kind === 'folder') {
    return { ok: true, absPath: join(dir, name), displayName: `${name}/` };
  }

  const wanted = FILE_EXTENSIONS[kind];
  const wantedBare = bareExtension(wanted);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';

  if (ext === wantedBare) {
    return { ok: true, absPath: join(dir, name), displayName: name };
  }
  if (ext !== '' && KNOWN_EXTS.includes(ext)) {
    return {
      ok: false,
      reason: `你选的是 ${wanted}，但名字以 .${ext} 结尾。去掉扩展名让它自动补上，或改选对应的类型。`,
    };
  }
  // 有点号但不是已知扩展名（`v1.2 草稿`）→ 当作无扩展名，补上所选类型
  return { ok: true, absPath: join(dir, `${name}${wanted}`), displayName: `${name}${wanted}` };
}

/**
 * 内联输入框里回车前的实时提示（不阻断，只告知会建成什么）。
 * 与 `resolveNewItemPath` 同一套规则，避免"提示说 A、建出来是 B"。
 */
export function newItemPreviewName(rawName: string, kind: NewItemKind): string {
  const r = resolveNewItemPath('/', rawName, kind);
  return r.ok ? r.displayName : '';
}
