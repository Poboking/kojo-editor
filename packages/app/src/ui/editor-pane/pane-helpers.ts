/**
 * EditorPane 的**纯函数族**（REF-FRONT-PERF，2026-10-20 从组件文件搬出）。
 *
 * 为什么单独成模块：这些函数要么是"只读一次偏好再落 Monaco 选项"的接线腿，
 * 要么是路径/缓存的判据。它们没有 React 状态、没有实例闭包，留在 2,700 行组件里
 * 只会被当成"组件的一部分"；搬到这里之后，EditorPane 只负责**调用**，hook 只负责
 * **时序**，三处各司其职。
 *
 * **调用点与执行时机零改动**：函数体逐字搬出（注释一并），EditorPane / hook 的调用
 * 顺序与原来完全一致；这里不新增第二份判据，也不改任何 Monaco 选项。
 */
import type * as Monaco from '../../monaco/entry';
import type { Kernel } from '@kojo/kernel';
import type {
  EditorSaveHandlerContribution,
  ErbFile,
  ErbIndex,
} from '@kojo/plugin-api';
import { errorText, pathKey } from '@kojo/plugin-api';
import { formatOnTypeForDocument, quickSuggestionsFor, type EditorOptionPatch } from '../editor-options';
import {
  editorDisplayOptionPatch,
  type MinimapViewContext,
} from '../editor-display-prefs';
import { loadQuickSuggestionsPref, loadSuggestDelayPref } from '../suggest-pref';
import { languageFor } from '../editor-model-pool';
import { KOJO_LANGUAGE_ID } from '../../monaco/kojo-language';
import { splitPath } from '../path-label';

/**
 * 在项目索引里按 `pathKey` 归一找 `path` 对应的那一份文件（PS-5 面包屑索引用法的第一条腿）。
 *
 * 路径归一**必须由宿主做**（HK-7 同款坑）：索引的键是扫描侧给的绝对路径，编辑器这条路
 * 是 `filePath` prop 给的，Windows 上分隔符与大小写可以不一致——裸字符串比会**静默判不上**，
 * 症状是"面包屑永远在解析全文"，看不出哪里错了。索引缺席 / 找不到 ⇒ null（调用方退回解析）。
 */
export function erbFileInIndex(index: ErbIndex | null, path: string): ErbFile | null {
  if (!index) return null;
  const want = pathKey(path);
  for (const [key, file] of index.files) if (pathKey(key) === want) return file;
  return null;
}

/** 编辑停顿多久后重算装饰（避免每击键跑一遍转译） */
export const MARKER_DEBOUNCE_MS = 250;

/**
 * 预览面**写类动作**的统一否决文案（VETO-1）：F2 改名 / Shift+Alt+F 格式化 / 壳层的
 * `editor.action.request` 三处共用一句。文案里显式给出路的名字（「切回原文」），
 * 与通知上那颗按钮同口径——作者读完这句话就知道该点哪里。
 */
export const PREVIEW_WRITE_VETO = '.kojo 预览是只读显示，动作改的是派生文本——先切回原文再执行。';

/**
 * 只读态与快建议**同拍**落 Monaco 选项。
 *
 * `readOnly` 只拦编辑，不拦 suggest；provider 又拿不到 editor 的可写状态 ⇒ 只读文件 /
 * 糖预览若不在这里把 `quickSuggestions` 关掉，全局快建议照样会弹。可写态下还叠一层
 * 设置页总开关（`loadQuickSuggestionsPref`）；延迟同源，保证「补全弹出延迟」对 Monaco
 * 快建议与宿主主动触发同时生效。
 */
export function applyEditabilityAndSuggest(ed: Monaco.editor.IStandaloneCodeEditor, readOnly: boolean): void {
  ed.updateOptions({
    readOnly,
    quickSuggestions: quickSuggestionsFor(readOnly, loadQuickSuggestionsPref()),
    quickSuggestionsDelay: loadSuggestDelayPref(),
  });
}

/**
 * 落档时叠在档位表之后的那一层补丁（1020 编辑器体感批）：**只有这一处**把
 * 语言感知的 `formatOnType` 与显示偏好折进 overrides，三个写入点（切标签 / 挂预览 /
 * 撤预览）与偏好订阅回调都经过它——写四份必然漂一份。
 *
 * `isErb` 由调用方按**此刻屏幕上的那份文档**给：糖预览是 `.kojo` 投影 ⇒ false
 * （它的缩进单位与 `@` 块状态是文档级判据，窗口取文会数错，大档继续关打字规范化）。
 * 字体族刻意不在这里：它与体量正交、且 `code-font.ts` 钉着"降级集永不含字体键"，
 * 只在 create 与偏好变更两条路上发。
 *
 * `minimapCtx`（C-1b）同样按**此刻屏幕上那份文档**给：缩略图的「跟随」档要知道
 * 现在显示的是原文代码、`.kojo` 正文，还是预览投影。不在这里给 = 投影与正文也画纵览
 * （台词正文里那是一条彩色噪点）。调用点只有四处，一处都不许自己算第二遍。
 */
export function tierOverrides(
  lineCount: number,
  isErb: boolean,
  extra?: EditorOptionPatch,
  minimapCtx?: MinimapViewContext,
): EditorOptionPatch {
  return {
    ...editorDisplayOptionPatch(lineCount, undefined, minimapCtx),
    formatOnType: formatOnTypeForDocument(lineCount, isErb),
    ...(extra ?? {}),
  };
}

/**
 * 缩略图「跟随」档的**文件侧**判据：这份文件本身是不是 `.kojo` 口上正文。
 *
 * 判据取语言而非扩展名（`languageFor` 是唯一的"哪类文件归哪种语言"真源）：
 * 台词型文档在缩略图里没有可导航的结构，一竖条色块只是噪声。
 */
export function minimapCtxForPath(path: string): MinimapViewContext {
  return { kojoText: languageFor(path) === KOJO_LANGUAGE_ID };
}

/**
 * `.kojo` 预览装配判据的项目侧摘要（PS-5 缓存键的一部分）。
 *
 * 段由 `ui.editor.liftPreview` 按 `{path, text, project}` 现算 ⇒ 决定产物的只有
 * "哪套项目 + 哪份内容"。内容那一维交给 model 的 `alternativeVersionId`（撤销回到
 * 原样时它会回到同一个数，缓存正好复用）；项目这一维取 adapterId / rootDir /
 * `inputDigest`——**字典与时机表都在 inputDigest 里**（adapter `loadProject` 吃进去的
 * 非 ERB 输入摘要，与 `marker-pool` 的缓存判据同一条尺子）。取不到 digest 就不给摘要
 * （判据不全 ⇒ 不缓存，同抽取快照纪律）。
 */
export function sugarStampOf(project: { adapterId: string; rootDir: string; inputDigest?: string } | null): string {
  if (project === null) return '\u0000no-project';
  if (!project.inputDigest) return '\u0000no-digest'; // 不缓存：返回一个永不与任何"可缓存条目"相等的键
  return `${project.adapterId}\u0000${project.rootDir}\u0000${project.inputDigest}`;
}

/**
 * 糖视图摘要文本（sugarStats）之外的那份投影产物缓存条目（PS-5）。
 * 容量恒 1：切标签 / 解锁 / 直连开关反复重算是这条路径的**常态**（改前每次都全量重做）。
 */
export interface SugarCacheEntry {
  path: string;
  versionId: number;
  stamp: string;
  lineCount: number;
  doc: string;
  /** 预览行 → 源行（1 基）映射；与 `doc` 同批产出，缓存命中必须连它一起复用 */
  lineMap: readonly number[];
  sugarLines: number;
  /** 投影段数（NATIVE-UX：命中缓存那一拍也要能报出"这一份投出了几段"，否则零段那格会说谎） */
  segmentCount: number;
}

/**
 * 就近征询**保存接管者**（槽 `ui.editor.saveHandler`，2026-10-12 批）：返回
 * `order` 最小的命中贡献（唯一接管，不做链式级联）；无命中 → undefined（宿主
 * 退回内核 io `writeText` 缺省保存）。单个贡献抛错不影响其余（与装饰器同款
 * 隔离——能力出错要"退化可见"，不让整条保存链断掉）。
 */
export function pickSaveHandler(kernel: Kernel, path: string): EditorSaveHandlerContribution | undefined {
  const matches: EditorSaveHandlerContribution[] = [];
  for (const contribution of kernel.slots.query('ui.editor.saveHandler')) {
    try {
      if (contribution.matches(path)) matches.push(contribution);
    } catch (e: unknown) {
      // 贡献抛错不静默（与 plugin-api「绝不静默」约定一致）：
      // 记录后仍降级为缺省保存，避免单个坏贡献阻断整条保存链路。
      console.warn(
        `[EditorPane] save handler '${contribution.id}' matches('${path}') 抛错：${
          errorText(e)
        }`,
      );
    }
  }
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)); // 稳定排序：同 order 保持注册顺序
  return matches[0];
}

/**
 * 路径末段（弹窗里给文件名而不是整条路径：用户认文件，不认目录树）。
 * 拆分口径与工具条共用 `path-label.splitPath`，一处规矩。
 */
export function baseNameOf(path: string): string {
  return splitPath(path).base;
}

/**
 * 保存时点的 **EOL 覆盖位复核**（EOL-OVERRIDE-SAVE 批，纯函数可单测）：
 *
 * 覆盖位在场 **且** model 当前行尾档仍与覆盖档一致 ⇒ 给出要递给
 * `io.writeText` 的显式 `{ eol }`（内核语义 = 整段统一到该档）；否则
 * `undefined` = 走缺省"保编码保换行"。第二道判据兜的是"切了又撤销"：
 * `setEOL` 进了撤销栈，Ctrl+Z 回到基线时 model 行尾回到原档而覆盖位还在——
 * 此刻保存不该把用户的旧切换意图强行落盘（位由调用方随即作废）。
 */
export function resolveSaveEolOverride(
  eolOverride: 'LF' | 'CRLF' | undefined,
  modelEol: string,
): 'crlf' | 'lf' | undefined {
  if (eolOverride === undefined) return undefined;
  const current: 'LF' | 'CRLF' = modelEol === '\r\n' ? 'CRLF' : 'LF';
  if (current !== eolOverride) return undefined;
  return eolOverride === 'CRLF' ? 'crlf' : 'lf';
}
