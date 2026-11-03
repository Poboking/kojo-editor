// @vitest-environment happy-dom
/**
 * KW-36 P1（2026-11-03）：`open-file <片段>` 够不到**未挂载的深层树组**的可达通道判据。
 *
 * 根因（读实现得出的，不是猜的）：`cmdOpenFile` 只有**文件树**一条腿，而树是虚拟化的——
 * `file-tree-virtual.ts` 的 `sliceSpan` / `isCulledSlice` 把视口外的整块换成**一条等高占位**，
 * 那一组里的行**根本不在 DOM 里**；`expandCollapsedUntilMatch` 能点的
 * `.tree-group-btn[aria-expanded="false"] / .tree-dir[…] / .tree-package[…]`
 * 只有"当前挂着的那些"，于是把已挂载的折叠行点到头就交回 `no-rows`，
 * CLI 报「折叠行已点到头仍未命中（树是虚拟化的）」。
 * 仓内旧绕法（往 `.tree-filter` 写关键词再 open-file）实测也不通：那颗框滤的是**角色目录名**
 * （`FileTree.tsx` 的 placeholder「过滤 N 个角色目录…」），打文件名一个都不剩。
 *
 * 正解不是新造第二条打开通道：换**应用自己的另一个入口** —— 命令面板的
 * `workbench.quickOpen`（Ctrl+P）。它的候选来自全量文件清单（`palette-search.ts::rankFiles`
 * 按 base/path 两档排，与挂载无关），选中行落的是 `Picker.pick → onPick → onOpenFile(key)`
 * ——与在树里点一行**同一条腿**，只是入口位置换了。
 *
 * 本文件的判据三档：
 * ① **改前会红的夹具**：一份"目标只在未挂载组里"的虚拟树 DOM，树那条腿实测交回 `no-rows`
 *    （＝旧实现到这里就 die，永远开不出这个文件）；
 * ② 新那条腿的判据是纯函数（`quickOpenTermFor` / `pickQuickOpenRow`）＋注入式驱动
 *    （`openFileViaSearchSurface`），假面板/假行就能跑，不需要真浏览器；
 * ③ 源形状钉子：`cmdOpenFile` 真的调了这条腿，而且**没有**新造第二条打开通道
 *    （不直捅 invoke／不自己读文件），收尾仍是既有的 `editor.info().path` 对拍。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  expandCollapsedUntilMatch,
  openFileViaSearchSurface,
  pickQuickOpenRow,
  quickOpenTermFor,
} from '../debug-lib.mjs';

/** 现场里那个真实存在过的深层文件（eraTW 盘上的形状，路径片段照抄） */
const DEEP = 'ERB/口上・メッセージ関連/个人口上/049 Satori [さとり]/さとり/M_KOJO_K49_イベント.ERB';
const BASE = 'M_KOJO_K49_イベント.ERB';

/* --------------------------- ① 虚拟树夹具（未挂载的组不在 DOM） --------------------------- */

/** happy-dom 不做布局，也不保证有 scrollIntoView；树那条腿靠它滚进视口，这里补成 no-op */
;(Element.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView ??= () => {};

/** 只喂给 `expand*` 那两条腿需要的最小 CDP 面：evalJs 在**本页**求值 */
function fakeCdp() {
  return {
    evalJs: async (expr: string) => {
      // eslint-disable-next-line no-new-func
      return new Function(`return (${expr});`)() as unknown;
    },
  };
}

/** 清掉跨用例的"已点过的行"账本（expand* 用它避免重复点同一行） */
function resetTreeLedger() {
  delete (globalThis as Record<string, unknown>).__kojoDebugTreeClicks;
}

/**
 * 造一棵**真的虚拟化**的树：
 * - 两个已挂载的组（折叠态，点开后挂出自己的 `.tree-file` 行）；
 * - 目标所在的组**整组被裁** ⇒ DOM 里只有那条等高占位，一行 `.tree-file` 都没有。
 */
function mountVirtualizedTree(): { openedTitles: string[] } {
  document.body.innerHTML = `
    <div class="file-tree"><ul class="tree-groups" role="tree">
      <li class="tree-group"><button class="tree-group-btn" role="treeitem" aria-expanded="false" title="ERB/口上・メッセージ関連/个人口上/001 Reimu [霊夢]">001</button>
        <ul class="tree-files nested"></ul></li>
      <li class="tree-group"><button class="tree-group-btn" role="treeitem" aria-expanded="false" title="ERB/口上・メッセージ関連/个人口上/002 Ruukoto [る～こと]">002</button>
        <ul class="tree-files nested"></ul></li>
      <!-- 目标那一组：整组在视口外 ⇒ isCulledSlice 把它换成一条等高占位，一行都不挂 -->
      <li class="tree-culled-spacer" style="height:462px"></li>
    </ul></div>`;
  const openedTitles: string[] = [];
  // 「点开组 ⇒ 挂出该组自己的文件行」：与真实树同一个因果，只是不给目标组挂行（它就是没挂）
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.tree-group-btn'))) {
    btn.addEventListener('click', () => {
      btn.setAttribute('aria-expanded', 'true');
      const holder = btn.parentElement?.querySelector('ul.tree-files.nested');
      if (!holder || holder.querySelector('.tree-file')) return;
      const title = btn.getAttribute('title') ?? '';
      const li = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'tree-file';
      row.setAttribute('title', `${title}/${BASE.replace(BASE, 'M_KOJO_K1_イベント.ERB')}`);
      row.textContent = 'M_KOJO_K1_イベント.ERB';
      li.appendChild(row);
      holder.appendChild(li);
      openedTitles.push(title);
    });
  }
  return { openedTitles };
}

/* --------------------------- ② 假面板：与真 Palette 同一个 DOM 形状 --------------------------- */

interface PickerRow {
  readonly dir: string;
  readonly primary: string;
}

/**
 * 造「快速打开」面板：`.picker` + `.picker-input` + `.picker-item[data-idx]`
 * （行内 `.picker-primary` 是文件名、`.picker-secondary[title]` 是相对目录——
 * 与 `Palette.tsx` 渲染的那两个节点逐字同形状）。
 */
function mountQuickOpen(rows: readonly PickerRow[]): { openedPaths: string[] } {
  const openedPaths: string[] = [];
  document.body.innerHTML = `
    <div class="picker-backdrop"><div class="picker pk" role="dialog" aria-modal="true">
      <input class="picker-input" />
      <div class="picker-list">
        ${rows
          .map(
            (r, i) =>
              `<button class="picker-item" data-idx="${i}"><span class="picker-primary">${r.primary}</span>` +
              `<span class="picker-secondary dim" title="${r.dir}">${r.dir}</span></button>`,
          )
          .join('')}
      </div>
    </div></div>`;
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.picker-item'))) {
    // 真面板上这一行落的是 `onPick(key)` ⇒ `onOpenFile(key)`：这里把 key 记进账本自证"走的是那条腿"
    btn.addEventListener('click', () => {
      const dir = btn.querySelector('.picker-secondary')?.getAttribute('title') ?? '';
      const primary = btn.querySelector('.picker-primary')?.textContent?.trim() ?? '';
      openedPaths.push(dir === '' ? primary : `${dir}/${primary}`);
    });
  }
  return { openedPaths };
}

/** 注入式 surface 的真机同形实现（读上面那套 DOM；`openFileViaSearchSurface` 只认这四枚动作） */
function domSurface(opts: { paletteOpens?: boolean } = {}) {
  const paletteOpens = opts.paletteOpens !== false;
  return {
    async openPalette() {
      if (!paletteOpens) throw new Error('workbench.quickOpen 不在注册表');
      if (!document.querySelector('.picker .picker-input')) throw new Error('面板不在场');
    },
    async setQuery(term: string) {
      const input = document.querySelector<HTMLInputElement>('.picker-input');
      if (!input) throw new Error('没有 .picker-input');
      input.value = term;
    },
    async readRows() {
      return Array.from(document.querySelectorAll<HTMLElement>('.picker-item')).map((el) => ({
        idx: Number(el.getAttribute('data-idx')),
        primary: (el.querySelector('.picker-primary')?.textContent ?? '').trim(),
        dir: (el.querySelector('.picker-secondary')?.getAttribute('title') ?? '').trim(),
      }));
    },
    async pickRow(idx: number) {
      document.querySelector<HTMLElement>(`.picker-item[data-idx="${idx}"]`)?.click();
    },
    async close() {},
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  resetTreeLedger();
});

describe('P1 · 未挂载深层组的夹具（改前会红的那条腿）', () => {
  it('① 树那条腿在虚拟化的树上**够不到**目标：点到头交回 no-rows', async () => {
    const { openedTitles } = mountVirtualizedTree();
    resetTreeLedger();
    const verdict = await expandCollapsedUntilMatch(fakeCdp() as never, DEEP, { maxRounds: 12, intervalMs: 1 });
    // 旧 cmdOpenFile 到这里就 die（「折叠行已点到头仍未命中」）：已挂载的两个组都点开了，
    // 目标那一组整组被裁 ⇒ DOM 里从来没有那一行，树这条腿**结构上**不可能命中
    expect(verdict).toBe('no-rows');
    expect(openedTitles.length).toBe(2);
    expect(document.querySelectorAll('.tree-file').length).toBe(2);
    expect([...document.querySelectorAll('.tree-file')].some((r) => (r.getAttribute('title') ?? '').includes(DEEP))).toBe(
      false,
    );
  });

  it('② 同一棵树上，命中**已挂载**组的片段仍然交回 found（既有行为零放宽）', async () => {
    mountVirtualizedTree();
    resetTreeLedger();
    const verdict = await expandCollapsedUntilMatch(fakeCdp() as never, '001 Reimu', { maxRounds: 12, intervalMs: 1 });
    expect(verdict).toBe('found');
  });
});

describe('P1 · quickOpenTermFor（该打哪个搜索词，纯函数）', () => {
  it('① 取片段的**末段**做词：面板的 primary 只有文件名，带目录的长串当词打不中', () => {
    expect(quickOpenTermFor(DEEP)).toBe(BASE);
    expect(quickOpenTermFor(DEEP.replace(/\//g, '\\'))).toBe(BASE);
    expect(quickOpenTermFor(BASE)).toBe(BASE);
  });
  it('② 空/脏值 ⇒ 空串（调用方据此如实报错，不猜词）', () => {
    expect(quickOpenTermFor('')).toBe('');
    expect(quickOpenTermFor(null as unknown as string)).toBe('');
    expect(quickOpenTermFor('   ')).toBe('');
  });
});

describe('P1 · pickQuickOpenRow（哪一行才是目标，纯函数）', () => {
  const rows = [
    { idx: 0, primary: 'M_KOJO_K1_イベント.ERB', dir: 'ERB/口上・メッセージ関連/个人口上/001 Reimu [霊夢]/れいむ' },
    { idx: 1, primary: BASE, dir: 'ERB/口上・メッセージ関連/个人口上/049 Satori [さとり]/さとり(24.5.14)' },
    { idx: 2, primary: BASE, dir: 'ERB/口上・メッセージ関連/个人口上/049 Satori [さとり]/さとり' },
    { idx: 3, primary: 'M_KOJO_K49_日記.ERB', dir: 'ERB/口上・メッセージ関連/个人口上/049 Satori [さとり]/さとり' },
  ];

  it('① 完整相对路径 ⇒ 逐字相等那一行（同名的隔壁组不许赢）', () => {
    const hit = pickQuickOpenRow(rows, DEEP);
    expect(hit?.idx).toBe(2);
    expect(hit?.exact).toBe(true);
  });

  it('② 只给文件名 ⇒ 两个同名命中都在，取路径最短、再取行序（歧义由调用方的 path 对拍兜）', () => {
    const hit = pickQuickOpenRow(rows, BASE);
    expect(hit?.primary).toBe(BASE);
    expect([1, 2]).toContain(hit?.idx);
    expect(String(hit?.full).length).toBe(
      Math.min(
        ...rows.filter((r) => r.primary === BASE).map((r) => `${r.dir}/${r.primary}`.toLowerCase().length),
      ),
    );
  });

  it('③ 反斜杠 / 大小写 / 尾斜杠归一后同一判据（Windows 片段照收）', () => {
    const hit = pickQuickOpenRow(rows, DEEP.replace(/\//g, '\\').toUpperCase());
    expect(hit?.idx).toBe(2);
  });

  it('④ 没有命中 ⇒ null（不猜、不返回第一行）；脏行（无 primary / 非法 idx）跳过', () => {
    expect(pickQuickOpenRow(rows, 'M_KOJO_K99_不存在.ERB')).toBeNull();
    expect(pickQuickOpenRow([], DEEP)).toBeNull();
    expect(pickQuickOpenRow(null as unknown as never[], DEEP)).toBeNull();
    expect(pickQuickOpenRow([{ idx: NaN, primary: BASE, dir: 'x' }, { idx: -2, primary: BASE }], BASE)).toBeNull();
    expect(pickQuickOpenRow([{ idx: 7, primary: '', dir: 'x' }], '')).toBeNull();
    expect(pickQuickOpenRow(rows, '')).toBeNull();
  });
});

describe('P1 · openFileViaSearchSurface（注入式驱动，四条出口都如实）', () => {
  it('① 目标只在未挂载组里 ⇒ 面板那条腿**点得到**，且落的是 onOpenFile 那一行', async () => {
    mountVirtualizedTree();
    resetTreeLedger();
    // 面板的候选＝全量清单（与挂载无关）：目标那一行在这里是**在场**的
    const { openedPaths } = mountQuickOpen([
      { dir: 'ERB/口上・メッセージ関連/个人口上/001 Reimu [霊夢]/れいむ', primary: 'M_KOJO_K1_イベント.ERB' },
      { dir: 'ERB/口上・メッセージ関連/个人口上/049 Satori [さとり]/さとり', primary: BASE },
    ]);
    const r = await openFileViaSearchSurface(domSurface() as never, DEEP, { rounds: 3, intervalMs: 1 });
    expect(r.opened).toBe(true);
    expect(r.term).toBe(BASE);
    expect(r.picked?.dir).toBe('ERB/口上・メッセージ関連/个人口上/049 Satori [さとり]/さとり');
    // 自证：真被点的那一行就是目标（同一条 onOpenFile 腿，不是"记了个 picked 却谁也没点"）
    expect(openedPaths).length(1);
    expect(openedPaths[0]!.endsWith(DEEP)).toBe(true);
  });

  it('② 面板开不起来 ⇒ reason=no-palette 且不假装点过任何行', async () => {
    mountQuickOpen([{ dir: 'x', primary: BASE }]);
    const r = await openFileViaSearchSurface(domSurface({ paletteOpens: false }) as never, DEEP, {
      rounds: 2,
      intervalMs: 1,
    });
    expect(r.opened).toBe(false);
    expect(r.reason).toBe('no-palette');
    expect(r.rows).toBe(0);
  });

  it('③ 面板开了、词打了、候选里没有 ⇒ reason=no-hit（轮完 rounds 轮才收，不第一拍就放弃）', async () => {
    let reads = 0;
    mountQuickOpen([{ dir: 'ERB/别的组', primary: 'M_KOJO_K1.ERB' }]);
    const surface = domSurface() as never;
    (surface as { readRows: () => Promise<unknown> }).readRows = async () => {
      reads++;
      return [{ idx: 0, primary: 'M_KOJO_K1.ERB', dir: 'ERB/别的组' }];
    };
    const r = await openFileViaSearchSurface(surface, 'M_KOJO_K49_不存在.ERB', { rounds: 4, intervalMs: 1 });
    expect(r.opened).toBe(false);
    expect(r.reason).toBe('no-hit');
    expect(reads).toBe(4);
  });

  it('④ readRows 抛错不炸整条腿（吞成空候选，最后如实 no-hit）', async () => {
    const surface = {
      async openPalette() {},
      async setQuery() {},
      readRows: () => Promise.reject(new Error('页面在换脸')),
      async pickRow() {},
    };
    const r = await openFileViaSearchSurface(surface as never, DEEP, { rounds: 2, intervalMs: 1 });
    expect(r.opened).toBe(false);
    expect(r.reason).toBe('no-hit');
  });
});

