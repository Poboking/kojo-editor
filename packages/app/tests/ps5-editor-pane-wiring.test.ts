/**
 * PS-5 · EditorPane 三条接线守卫（源码形状判据 + 作者文案禁词表）。
 *
 * 为什么用形状判据：这三条都活在 2,000 行组件的闭包里，本仓库没有挂载设施（同
 * `editor-pane-dataflow.test.ts` 的既定口径——行为面交给纯函数单测，形状面钉"接线在不在"）。
 * 本文件钉的是**不许静默回退**的三根线：
 *  ① 体量闸的两条宿主腿：`sizeOf` 必须用**不复制正文**的读数（`getValueLength()`），
 *     拿 `getValue().length` 当判据就是"把要省的开销先付一遍"；`pauseChanged` 必须落到**渲染**上。
 *  ② 面包屑：先问索引、再谈解析，脏缓冲区那一路必须走防抖（每击键全文解析一次的形状不许回来）。
 *  ③ `.kojo` 预览：装配产物要有缓存条目与命中判据（每次切标签全量重做的形状不许回来）。
 *
 * 文案禁词表按 STATE §四 那条 UX 术语口径：作者看得见的一句话里不许出现内部词。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  fileURLToPath(new URL('../src/ui/EditorPane.tsx', import.meta.url)),
  'utf8',
);

/** 截 `const NAME = ...` 到下一个顶层两空格缩进 `const` 之间的函数体（粗略但足够钉形状） */
function sliceFn(name: string): string {
  const start = SOURCE.indexOf(`const ${name} =`);
  expect(start, `找不到 ${name}`).toBeGreaterThanOrEqual(0);
  const rest = SOURCE.slice(start + `const ${name} =`.length);
  const end = rest.search(/\n  const [A-Za-z_]/);
  return rest.slice(0, end === -1 ? rest.length : end);
}

describe('PS-5 ① 校验暂停闸的宿主两条腿', () => {
  const runner = sliceFn('markerRunner');

  it('sizeOf 只用 O(1) 读数（getValueLength + getLineCount），一次 getValue 都不许出现', () => {
    expect(runner).toContain('sizeOf:');
    expect(runner).toContain('model.getValueLength()');
    expect(runner).toContain('model.getLineCount()');
    expect(runner).not.toContain('getValue()'); // 判据本身不许复制正文
  });

  it('pauseChanged 落到 setState（暂停必须被看见，铁律 4）', () => {
    expect(runner).toContain('pauseChanged:');
    expect(runner).toContain('setMarkerPaused');
  });

  it('渲染侧真有那句话，且暂停态按"哪几份文件停着"记（两份大文件并存不互相顶掉）', () => {
    expect(SOURCE).toContain('文件太大，错误检查已暂停');
    expect(SOURCE).toContain('useState<Record<string, boolean>>({})');
    expect(SOURCE).toContain('markerPaused[filePath] === true');
  });

  it('作者文案禁词：那句话与它的悬停里不许出现内部术语', () => {
    const i0 = SOURCE.indexOf('{markerPaused[filePath] === true ? (');
    expect(i0).toBeGreaterThan(0);
    const block = SOURCE.slice(i0, SOURCE.indexOf('</span>', i0));
    // 只看**作者读得到的字**：字符串字面量（title 的两段）+ 标签之间的 JSX 文本。
    // 整块源码里有 `markerPaused` 这类标识符，那是代码不是文案，禁词表扫它等于自证不清。
    const literals = (block.match(/'([^']*)'/g) ?? []).map((s) => s.slice(1, -1)).join('');
    const jsxText = block.slice(block.lastIndexOf('/>') + 2);
    const visible = literals + jsxText;
    const banned = [
      'marker', 'Marker', '装饰', '阈值', '码元', 'byte', '字节', 'validation',
      '缓存', '索引', 'worker', 'Worker', 'model', 'Model', 'Monaco', 'monaco', '语法糖',
    ];
    for (const w of banned) expect(visible, `禁词「${w}」出现在作者可见文案里`).not.toContain(w);
    expect(visible).toContain('文件太大，错误检查已暂停');
  });
});

describe('PS-5 ② 面包屑不再每击键解析全文', () => {
  it('三条腿按代价从低到高排：同版本缓存 → 索引派生 → 防抖重算 → 才解析', () => {
    const idx = SOURCE.indexOf('crumbRefreshRef.current = (forceParse');
    expect(idx, 'crumbRefresh 必须带 forceParse 形参（防抖那一拍要绕过沿用旧树的分支）').toBeGreaterThan(0);
    const body = SOURCE.slice(idx, SOURCE.indexOf('// A9 选区读数搭同一条光标监听', idx));
    expect(body).toContain('symbolsFromIndex(path');
    expect(body).toContain('scheduleCrumbRebuild()');
    expect(body).toContain('collectDocumentSymbols(');
    // 顺序判据：索引派生必须排在全文解析**之前**
    expect(body.indexOf('symbolsFromIndex(path')).toBeLessThan(body.indexOf('collectDocumentSymbols('));
    expect(body.indexOf('scheduleCrumbRebuild()')).toBeLessThan(body.indexOf('collectDocumentSymbols('));
  });

  it('索引派生有三条护栏：只认 ERB 方言 / 缓冲区必须干净 / 行数必须相等（判据不全就不猜）', () => {
    const fn = SOURCE.slice(SOURCE.indexOf('const symbolsFromIndex ='), SOURCE.indexOf('const scheduleCrumbRebuild ='));
    expect(fn).toContain('isErbLike(path)');
    expect(fn).toContain('computeDirty(path)');
    expect(fn).toContain('file.lineCount !== lineCount');
    expect(fn).toContain('erbFileInIndex(index, path)');
  });

  it('索引条目额外认**指纹**：保存之后盘上补扫会让树变，而干净缓冲区的版本号不变', () => {
    expect(SOURCE).toContain('fromIndex: true');
    expect(SOURCE).toContain('indexStamp');
    const refresh = SOURCE.slice(SOURCE.indexOf('crumbRefreshRef.current = (forceParse'));
    expect(refresh).toContain('cache.indexStamp === (currentErbIndex()?.fingerprint ?? null)');
  });

  it('路径归一走 pathKey（HK-7 口径；裸比会静默判不上，症状是"面包屑永远在解析"）', () => {
    const fn = SOURCE.slice(SOURCE.indexOf('function erbFileInIndex'), SOURCE.indexOf('const MARKER_DEBOUNCE_MS'));
    expect(fn).toContain('pathKey(');
  });

  it('防抖定时器随实例退场作废 + 在途那一次清空 crumbLastRef（不清就是 self-skip 自己约的重算）', () => {
    expect(SOURCE).toContain('if (crumbTimerRef.current !== null) {');
    const sched = SOURCE.slice(SOURCE.indexOf('const scheduleCrumbRebuild ='), SOURCE.indexOf('const selStatusRef'));
    expect(sched).toContain('crumbLastRef.current = null');
    expect(sched).toContain('crumbRefreshRef.current?.(true)');
  });

  it('大文件档清链那条既有红线没被动（旧链残留会把别的文件的行号 reveal 进当前文件），但**闸的位置在索引快路之后**', () => {
    const refresh = SOURCE.slice(SOURCE.indexOf('crumbRefreshRef.current = (forceParse'));
    const body = refresh.slice(0, refresh.indexOf('// A9 选区读数搭同一条光标监听'));
    expect(body).toContain('cursor.lineCount >= LARGE_FILE_LINES');
    expect(body).toContain('apply([])');
    // 1020 编辑器体感批：这条闸原先在最前面按行数一刀切，把"零解析的索引快路"一起挡死
    // ⇒ 5,000 行以上的文件连面包屑都没有。现在它只拦"缓存与索引都给不出、必须现解析"那一拍。
    expect(body.indexOf('symbolsFromIndex(path')).toBeLessThan(body.indexOf('cursor.lineCount >= LARGE_FILE_LINES'));
    expect(body.indexOf('cache.symbols')).toBeLessThan(body.indexOf('cursor.lineCount >= LARGE_FILE_LINES'));
  });
});

describe('PS-5 ③ .kojo 预览的装配缓存', () => {
  it('命中判据四维齐全：路径 / 内容版本号 / 项目摘要 / 行数', () => {
    const apply = SOURCE.slice(SOURCE.indexOf('const applySugarView ='), SOURCE.indexOf('// 开关变化：记住偏好'));
    expect(apply).toContain('hit.path === path');
    expect(apply).toContain('hit.versionId === versionId');
    expect(apply).toContain('hit.stamp === stamp');
    expect(apply).toContain('hit.lineCount === maxLine');
    expect(apply).toContain('sugarCacheRef.current = {');
  });

  it('未命中才付那三条 O(行数) 的腿（getValue / 逐行 getLineContent / 段扫描都在 else 分支里）', () => {
    const apply = SOURCE.slice(SOURCE.indexOf('const applySugarView ='), SOURCE.indexOf('// 开关变化：记住偏好'));
    const elseStart = apply.indexOf('} else {');
    expect(elseStart).toBeGreaterThan(0);
    const build = apply.slice(elseStart, apply.indexOf('const sugarModel = monaco.editor.createModel', elseStart));
    expect(build).toContain('model.getValue()');
    expect(build).toContain('model.getLineContent(i)');
    expect(build).toContain("query('ui.editor.liftPreview')");
    expect(build).toContain('composeSugarDoc(');
  });

  it('项目摘要缺 inputDigest ⇒ 判据不全 ⇒ 不缓存（同抽取快照纪律，不许猜）', () => {
    const stamp = SOURCE.slice(SOURCE.indexOf('function sugarStampOf'), SOURCE.indexOf('interface SugarCacheEntry'));
    expect(stamp).toContain('if (!project.inputDigest)');
    expect(stamp).toContain('no-digest');
  });

  it('关标签时缓存与面包屑树一起作废（model 版本号会从 1 重新数 ⇒ 旧条目不许命中新内容，#F6 同款）', () => {
    expect(SOURCE).toContain("if (sugarCacheRef.current?.path === path) sugarCacheRef.current = null;");
    expect(SOURCE).toContain("if (crumbTreeCacheRef.current?.path === path) crumbTreeCacheRef.current = null;");
  });

  /**
   * NATIVE-UX（2026-10-20）：那颗「.kojo 预览」开关的悬停**只许问单源**。
   *
   * 实测：`langDoc: native` 起手包的 8 份 `.ERB` 每份都投出零段，`applySugarView` 那一拍
   * 直接 return（糖 model 不挂、屏上就是原文）；而那颗开关当时仍按偏好状态讲
   * 「已开启：当前显示的是 .kojo 写法」。这一组把两件事钉死：①零段必须被**记下来**
   * （不许悄悄 return）；②那两句改前文案不许再以字面量住在 JSX 里（回到内联三元 = 红）。
   */
  it('零段那一拍要出声：读数落进 state，悬停只经 sugarToggleTitle 单源', () => {
    const apply = SOURCE.slice(SOURCE.indexOf('const applySugarView ='), SOURCE.indexOf('// 开关变化：记住偏好'));
    expect(apply).toContain('setSugarSegments({ path, segments: 0 });'); // 零段：记下"这份没投出东西"
    expect(apply).toContain('setSugarSegments({ path, segments: segCount });'); // 命中缓存那一拍同样有读数
    expect(apply).toContain('segmentCount: segCount'); // 缓存条目带段数（否则切回来就没数）

    const toggle = SOURCE.slice(
      SOURCE.indexOf('className={`ghost small sugar-toggle'),
      SOURCE.indexOf('<Icon name="preview" size={13} />'),
    );
    expect(toggle).toContain('sugarToggleTitle({');
    expect(toggle).not.toContain('已开启：当前显示的是');
    // 全文件都不许再留那两句字面量（文案单源在 sugar-view.ts）
    expect(SOURCE).not.toContain("'已开启：当前显示的是 .kojo 写法。点击切回原生代码（这是显示偏好，文件内容一字未动）。'");
    expect(SOURCE).not.toContain("'把这份文件显示成 .kojo 写法——台词读起来像剧本、条件变成「如果 …：」。只改显示，不改动文件。'");
  });
});

describe('PS-5 · props 面零改动（隔壁线靠这份签名稳定调用点）', () => {
  const props = SOURCE.slice(SOURCE.indexOf('interface Props {'), SOURCE.indexOf('}', SOURCE.indexOf('onFocused?: () => void;')));

  it('Props 的键与类型一个字都没动（含 onStatusInfo 那条上报形状）', () => {
    for (const line of [
      'kernel: Kernel;',
      'groupId: string;',
      'filePath: string;',
      'openPaths: readonly string[];',
      'revealLine?: number;',
      'revealColumn?: number;',
      'revealNonce?: number;',
      'onDirtyChange?: (path: string, dirty: boolean) => void;',
      'registerActions?: (actions: EditorPaneActions | null) => void;',
      'onReauth: () => void;',
      'onStatusInfo?: (info: { encoding: string; eol: string; lines: number; autosavedAt?: number | null; sel?: string } | null) => void;',
      'onFocused?: () => void;',
    ]) {
      expect(props, `Props 里应当逐字有这一行：${line}`).toContain(line);
    }
  });

  it('解构列表也没动（新增的都是内部 state / ref，不从父侧要东西）', () => {
    expect(SOURCE).toContain('export function EditorPane({\n  kernel,\n  groupId,\n  filePath,\n  openPaths,');
  });
});
