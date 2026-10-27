/**
 * D 批 ·「比较已选文件」（双文件比较）的判据。
 *
 * 判钉五件（一条都不许漂）：
 * ①**出现判据**：多选集恰为 2 个文件、且被右击的行在其中 ⇒ 项出现；0 / 1 / 3+ 个、
 *    或右击的行不在集合里 ⇒ 整项**不返回**（不塞灰项占位）；
 * ②**入口载荷**：两侧只给 `path`（**盘上版本**口径）、不给内联文本；顺序 = 选中顺序；
 *    标签/标题取自路径，来源标识固定；
 * ③**内容与差异正确**：载荷经 `bindDiffView` 入栈后，`resolveSide` 真读盘、两侧文本与
 *    磁盘逐字一致、差异态正确（不同 ⇒ 有得比；相同 ⇒ 无差异横幅）；
 * ④**编码差异不误报全文不同**：行内容相同、字节不同 ⇒ 判等核给出 `linesEqual:true /
 *    bytesEqual:false`，横幅说"字节不同（编码或换行风格差异）"，而不是"完全一致"；
 * ⑤**只读**：整条链路一次 `writeText` / `writeBytes` 都不调（只读铁律）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileIO, KernelEventMap, TextFile } from '@kojo/plugin-api';
import { compareSelectionPair, menuItemsFor, type MenuCapability } from '../src/ui/file-tree-ops';
import { COMPARE_FILES_SOURCE, compareSelectedRequest } from '../src/ui/file-tree-compare';
import {
  clearSelected,
  getSelectedPaths,
  isRowSelected,
  resetMultiSelectionForTest,
  setSelected,
  subscribeMultiSelection,
  toggleSelected,
} from '../src/ui/file-tree-multi-selection';
import {
  bindDiffView,
  buildDiffViewMenu,
  clearDiff,
  DIFF_VIEW_MENU_IDS,
  diffEqualityBanner,
  diffEqualityOf,
  getDiffState,
  type DiffRequest,
} from '../src/ui/diff-view';
import { resolveSide } from '../src/ui/DiffViewOverlay';

afterEach(() => {
  clearSelected();
  clearDiff();
});

/* ------------------------------ 夹具 ------------------------------ */

const FULL: MenuCapability = {
  hasIo: true,
  canReveal: true,
  canImport: true,
  canClipboard: true,
  canRelist: true,
  canHistory: true,
  canCommandPalette: true,
  canAddFolder: true,
  // 本夹具的宿主只接了「比较」这条腿：搬运家族与按目录检索的通道都不在它的现场里
  // （能力位口径 = 有通道才设位；那两族行为另有专档判据，见 file-tree-menu.test.ts）
  canMoveEntries: false,
  canSearchInFolder: false,
};

const fileMenuIds = (selection: readonly string[] | undefined, path: string | undefined): string[] =>
  menuItemsFor('file', FULL, {
    view: 'kojo',
    activeFile: null,
    ...(selection === undefined ? {} : { selection }),
    ...(path === undefined ? {} : { path }),
  }).map((i) => i.id);

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const tf = (path: string, text: string): TextFile => ({
  path,
  text,
  encoding: 'utf-8',
  eol: 'lf',
  mtimeMs: null,
});

/** 只读替身：写面直接抛（一旦被调，测试立刻红）+ 记录读面 */
function fakeIo(files: Record<string, { text: string; bytes?: Uint8Array }>) {
  const readText = vi.fn(async (p: string): Promise<TextFile> => {
    const f = files[p];
    if (f === undefined) throw new Error(`ENOENT: ${p}`);
    return tf(p, f.text);
  });
  const readBytes = vi.fn(async (p: string): Promise<Uint8Array> => {
    const f = files[p];
    if (f === undefined) throw new Error(`ENOENT: ${p}`);
    return f.bytes ?? enc(f.text);
  });
  const writeText = vi.fn(async (): Promise<void> => {
    throw new Error('不该写盘：比较是只读操作');
  });
  const writeBytes = vi.fn(async (): Promise<void> => {
    throw new Error('不该写盘：比较是只读操作');
  });
  return {
    io: { readText, readBytes, writeText, writeBytes } as unknown as FileIO,
    readText,
    readBytes,
    writeText,
    writeBytes,
  };
}

type OpenPayload = KernelEventMap['ui.diffView.open'];

/** 最小内核（只够 bindDiffView 用）：订阅表 + 事件流水 */
function fakeKernel() {
  const handlers = new Map<string, (p: never) => void>();
  const emitted: Array<[string, unknown]> = [];
  const kernel = {
    bus: {
      on(name: string, cb: (p: never) => void) {
        handlers.set(name, cb);
        return () => handlers.delete(name);
      },
      emit(name: string, payload: unknown) {
        emitted.push([name, payload]);
      },
    },
  };
  return {
    kernel: kernel as never,
    emitted,
    fire: (p: OpenPayload) => handlers.get('ui.diffView.open')?.(p as never),
  };
}

/* ------------------------------ ① 出现判据 ------------------------------ */

describe('比较已选文件 · 出现判据（≠2 时整项不返回）', () => {
  const a = 'C:/koa/001/a.ERB';
  const b = 'C:/koa/001/b.ERB';
  const c = 'C:/koa/001/c.ERB';

  it('没有多选集 / 只选 1 个 ⇒ 不出现', () => {
    expect(fileMenuIds(undefined, a)).not.toContain('compare-selected');
    expect(fileMenuIds([], a)).not.toContain('compare-selected');
    expect(fileMenuIds([a], a)).not.toContain('compare-selected');
  });

  it('恰选 2 个、且右击的行在其中 ⇒ 出现（两种先后都算）', () => {
    expect(fileMenuIds([a, b], a)).toContain('compare-selected');
    expect(fileMenuIds([a, b], b)).toContain('compare-selected');
  });

  it('恰选 2 个但右击的行不在集合里 ⇒ 不出现（不拿 A、B 冒充 C 的对手）', () => {
    expect(fileMenuIds([a, b], c)).not.toContain('compare-selected');
  });

  it('选 3+ 个 ⇒ 不出现（多出来的谁跟谁比没有答案）', () => {
    expect(fileMenuIds([a, b, c], a)).not.toContain('compare-selected');
  });

  it('两项实为同一份（大小写 / 分隔符写法不同）⇒ 不出现', () => {
    expect(fileMenuIds(['C:/koa/001/a.ERB', 'c:\\koa\\001\\A.erb'], 'C:/koa/001/a.ERB')).not.toContain(
      'compare-selected',
    );
  });

  it('目录侧不吃这一项：即便集合里有内容也只在"文件"作用域出现', () => {
    const ids = menuItemsFor('dir', FULL, { view: 'kojo', selection: [a, b], path: 'C:/koa/001' }).map((i) => i.id);
    expect(ids).not.toContain('compare-selected');
  });

  it('compareSelectionPair 直接判据：顺序 = 选中顺序，左 = 先选的', () => {
    expect(compareSelectionPair([a, b], b)).toEqual([a, b]);
    expect(compareSelectionPair([b, a], a)).toEqual([b, a]);
    expect(compareSelectionPair([a], a)).toBeNull();
    expect(compareSelectionPair([a, b, c], a)).toBeNull();
    expect(compareSelectionPair([a, b], undefined)).toBeNull();
    expect(compareSelectionPair(undefined, a)).toBeNull();
  });
});

/* ------------------------------ ② 入口载荷 ------------------------------ */

describe('compareSelectedRequest · 两侧给盘上路径、不给内联文本', () => {
  it('只给 path（盘上版本口径）+ 相对根标签 + 固定来源；顺序即选中顺序', () => {
    const p = compareSelectedRequest('C:/koa/001/a.ERB', 'C:/koa/001/b.ERB', 'C:/koa');
    expect(p.original.path).toBe('C:/koa/001/a.ERB');
    expect(p.modified.path).toBe('C:/koa/001/b.ERB');
    // 「盘上版本」口径的可测面：两侧都不带 text ⇒ 差异视图只能读盘，读不到屏上缓冲
    expect('text' in p.original).toBe(false);
    expect('text' in p.modified).toBe(false);
    expect(p.original.label).toBe('001/a.ERB');
    expect(p.modified.label).toBe('001/b.ERB');
    expect(p.title).toContain('a.ERB');
    expect(p.title).toContain('b.ERB');
    expect(p.source).toBe(COMPARE_FILES_SOURCE);
  });

  it('没有项目根 ⇒ 标签退回文件名（不编造"相对谁"）', () => {
    const p = compareSelectedRequest('C:/koa/001/a.ERB', 'C:/koa/001/b.ERB');
    expect(p.original.label).toBe('a.ERB');
    expect(p.modified.label).toBe('b.ERB');
  });
});

/* ------------------------------ ③ 内容与差异正确 + ⑤ 只读 ------------------------------ */

describe('入口落地 · 入栈 → 读盘 → 差异正确（且零写盘）', () => {
  it('两份不同的文件：两侧文本与磁盘逐字一致、确有差异、有得比（横幅为 null）', async () => {
    const a = 'C:/koa/001/a.ERB';
    const b = 'C:/koa/001/b.ERB';
    const { kernel, fire } = fakeKernel();
    bindDiffView(kernel);
    fire(compareSelectedRequest(a, b, 'C:/koa'));

    const state = getDiffState();
    expect(state).toMatchObject({ kind: 'request' });
    const request = (state as { request: DiffRequest }).request;
    expect(request.original.path).toBe(a);
    expect(request.modified.path).toBe(b);

    const io = fakeIo({
      [a]: { text: '第一行\n第二行\n第三行\n' },
      [b]: { text: '第一行\n改过的第二行\n第三行\n' },
    });
    const left = await resolveSide(request.original, io.io);
    const right = await resolveSide(request.modified, io.io);
    expect(left).toMatchObject({ kind: 'ok', text: '第一行\n第二行\n第三行\n' });
    expect(right).toMatchObject({ kind: 'ok', text: '第一行\n改过的第二行\n第三行\n' });

    const eq = diffEqualityOf(
      { text: left.kind === 'ok' ? left.text : '', bytes: left.kind === 'ok' ? left.bytes : undefined },
      { text: right.kind === 'ok' ? right.text : '', bytes: right.kind === 'ok' ? right.bytes : undefined },
    );
    expect(eq.linesEqual).toBe(false);
    // 行有差异 ⇒ 不给"无差异"横幅，交给 Monaco 行级 diff 渲染
    expect(
      diffEqualityBanner(eq),
    ).toBeNull();

    // ⑤ 只读：读面各两次，写面一次都没碰
    expect(io.readText).toHaveBeenCalledTimes(2);
    expect(io.readBytes).toHaveBeenCalledTimes(2);
    expect(io.writeText).not.toHaveBeenCalled();
    expect(io.writeBytes).not.toHaveBeenCalled();
  });

  it('两份完全一致：判等核给出无差异横幅', async () => {
    const a = 'C:/koa/001/a.ERB';
    const b = 'C:/koa/001/b.ERB';
    const io = fakeIo({ [a]: { text: '同一份内容\n' }, [b]: { text: '同一份内容\n' } });
    const left = await resolveSide({ path: a }, io.io);
    const right = await resolveSide({ path: b }, io.io);
    const eq = diffEqualityOf(
      { text: left.kind === 'ok' ? left.text : '', bytes: left.kind === 'ok' ? left.bytes : undefined },
      { text: right.kind === 'ok' ? right.text : '', bytes: right.kind === 'ok' ? right.bytes : undefined },
    );
    expect(diffEqualityBanner(eq)?.message).toContain('完全一致');
    expect(io.writeText).not.toHaveBeenCalled();
    expect(io.writeBytes).not.toHaveBeenCalled();
  });
});

/* ------------------------------ ④ 编码差异不误报 ------------------------------ */

describe('编码 / BOM 差异不误报「全文不同」', () => {
  it('行内容相同、字节不同（BOM 差异）⇒ 说"字节不同"，不是"完全一致"也不是"全文不同"', async () => {
    const a = 'C:/koa/001/a.ERB';
    const b = 'C:/koa/001/b.ERB';
    // 同一段文本：A 无 BOM，B 带 UTF-8 BOM —— 读盘解码后行内容一致，字节不同
    const io = fakeIo({
      [a]: { text: 'こんにちは\n世界\n', bytes: enc('こんにちは\n世界\n') },
      [b]: { text: 'こんにちは\n世界\n', bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...enc('こんにちは\n世界\n')]) },
    });
    const left = await resolveSide({ path: a }, io.io);
    const right = await resolveSide({ path: b }, io.io);
    expect(left.kind).toBe('ok');
    expect(right.kind).toBe('ok');
    const eq = diffEqualityOf(
      { text: left.kind === 'ok' ? left.text : '', bytes: left.kind === 'ok' ? left.bytes : undefined },
      { text: right.kind === 'ok' ? right.text : '', bytes: right.kind === 'ok' ? right.bytes : undefined },
    );
    expect(eq.linesEqual).toBe(true); // 编码差异不误报"全文不同"
    expect(eq.bytesEqual).toBe(false); // 但字节确不相同，要如实说
    const banner = diffEqualityBanner(eq);
    expect(banner?.noLineDiff).toBe(true);
    expect(banner?.message).toContain('字节');
    expect(banner?.message).not.toContain('完全一致');
  });

  it('同一段文本按不同编码落盘、读回同文 ⇒ 行态一致（复用内核解码通道的判据）', async () => {
    const a = 'C:/koa/001/a.ERB';
    const b = 'C:/koa/001/b.ERB';
    // 替身直接给"内核解码后的文本"（真内核 readText 做探测 / BOM / EOL 归一化）；
    // 这里钉的是：只要两侧文本一致，行对齐就不会因为原始编码不同而误判不同。
    const io = fakeIo({
      [a]: { text: '文字\n', bytes: enc('文字\n') },
      [b]: { text: '文字\n', bytes: new Uint8Array([0xff, 0xfe, 0x87, 0x65, 0x0a, 0x00]) }, // 假 UTF-16 原始字节
    });
    const left = await resolveSide({ path: a }, io.io);
    const right = await resolveSide({ path: b }, io.io);
    const eq = diffEqualityOf(
      { text: left.kind === 'ok' ? left.text : '' },
      { text: right.kind === 'ok' ? right.text : '' },
    );
    expect(eq.linesEqual).toBe(true);
    expect(io.writeText).not.toHaveBeenCalled();
    expect(io.writeBytes).not.toHaveBeenCalled();
  });
});

/* ------------------------------ ⑤ 复用既有能力格（不新造视图 / 第二套菜单） ------------------------------ */

describe('两侧路径进的是差异视图既有能力格（不新造）', () => {
  it('带 path ⇒ 既有菜单给出「复制对比摘要 / 复制左·右侧路径 / 关闭对比」', () => {
    const p = compareSelectedRequest('C:/koa/a.ERB', 'C:/koa/b.ERB', 'C:/koa');
    const menu = buildDiffViewMenu({
      title: p.title,
      leftLabel: p.original.label,
      rightLabel: p.modified.label,
      leftPath: p.original.path ?? null,
      rightPath: p.modified.path ?? null,
      editorReady: true,
      sideBySide: true,
      paneCount: 1,
      bannerMessage: null,
      clipboardAvailable: true,
    });
    const ids = menu!.items.map((i) => i.id);
    expect(ids).toContain(DIFF_VIEW_MENU_IDS.copySummary);
    expect(ids).toContain(DIFF_VIEW_MENU_IDS.copyLeftPath);
    expect(ids).toContain(DIFF_VIEW_MENU_IDS.copyRightPath);
    expect(ids).toContain(DIFF_VIEW_MENU_IDS.closePane);
    // 只读面没有「接受 / 拒绝」——不拿只读视图假装能改盘
    expect(ids.every((id) => !/accept|reject|apply/.test(id))).toBe(true);
  });
});

/* ------------------------------ 多选集 store 语义 ------------------------------ */

describe('file-tree-multi-selection · 集合语义', () => {
  it('setSelected 按 pkey 去重、保持首次出现顺序；同值不通知', () => {
    const cb = vi.fn();
    const un = subscribeMultiSelection(cb);
    setSelected(['C:/koa/a.ERB', 'c:\\koa\\A.erb', 'C:/koa/b.ERB']);
    expect(getSelectedPaths()).toEqual(['C:/koa/a.ERB', 'C:/koa/b.ERB']);
    expect(cb).toHaveBeenCalledTimes(1);
    setSelected(['C:/koa/a.ERB', 'C:/koa/b.ERB']); // 同值（pkey 判等）⇒ 不再通知
    expect(cb).toHaveBeenCalledTimes(1);
    un();
  });

  it('toggleSelected 加入 / 移出；isRowSelected 按 pkey 判等', () => {
    toggleSelected('C:/koa/a.ERB');
    expect(getSelectedPaths()).toEqual(['C:/koa/a.ERB']);
    expect(isRowSelected('c:\\koa\\A.erb')).toBe(true);
    toggleSelected('C:/koa/a.ERB');
    expect(getSelectedPaths()).toEqual([]);
    expect(isRowSelected('C:/koa/a.ERB')).toBe(false);
  });

  it('resetMultiSelectionForTest 复位单例', () => {
    toggleSelected('C:/koa/a.ERB');
    resetMultiSelectionForTest();
    expect(getSelectedPaths()).toEqual([]);
  });
});