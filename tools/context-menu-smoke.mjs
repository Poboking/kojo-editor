/**
 * 右键菜单**真机冒烟**的探针与判定（看板 CTX-SMOKE；原 WP6.5 一直没跑）。
 *
 * 分工：
 * - `runContextMenuProbes()` 是**页内**函数（喂 `cdpEval` 的 `Runtime.evaluate`，靠
 *   `Function.prototype.toString` 序列化）：只负责**采集事实**，一条断言都不下；
 * - `judgeContextMenuProbes(readings)` 在 Node 侧**纯函数**判定：四组（A/B/C/D）的
 *   通过/失败/跳过全在这里收口，`tools/tests/context-menu-smoke-shape.test.ts`（源形状）与
 *   `packages/app/tests/context-menu-smoke-replay.test.ts`（DOM 重演）直接打这个函数，不必起壳。
 *
 * 为什么判定要留在 Node：页内判定只能靠 `console.log` 回传，失败信息会丢结构；
 * 而且"判定逻辑能不能被单测覆盖"是真机冒烟最容易腐的一环——采集/判定一分家，
 * 判定就能在 happy-dom 里重演（见 replay 测试）。
 *
 * ## 四组各验什么（真机口径）
 *
 * - **A · 编辑区右键**：分两拍，因为**这一仓的既定契约**是「`.monaco-editor` 里面归
 *   Monaco 原生 zh-cn 菜单、我们的面只到外框」（`packages/app/tests/editor-hotzones.test.ts`
 *   把「不许抢 Monaco 里子」钉成硬约束，`App.tsx` 的根路由对 `.monaco-editor` 整片放行）：
 *   - A1（里子，`.monaco-editor .view-lines`）：出的是 **Monaco 原生菜单**
 *     （`.monaco-menu-container`），全部项是中文（zh-cn NLS 生效），**我们的 `.context-menu`
 *     一个都不许出现**（出现就是抢了里子），编辑区仍在 DOM 里；
 *   - A2（外框，`.editor-toolbar[data-context-surface="editor"]`）：出的是**我们的菜单**，
 *     `aria-label` = 「编辑器菜单」，全部项中文，无英文原生项，编辑区仍在。
 *
 *   ⚠ 任务书写的是「在 `.monaco-editor` 上派发 contextmenu 后断言 `.context-menu` 出现」。
 *   那与本仓契约**相反**（正是 editor-hotzones 那条守门禁掉的行为），照写会得到一条与
 *   源码互斥的假红。所以 A 拆成上面两拍：`.context-menu` 的出现断言落在**外框**这一拍。
 *
 * - **B · 三处热区各自命中对应面**：文件树行 / 标签页 / 面板（问题→搜索→面板选项卡
 *   按当前会话能开哪个用哪个）右键，菜单 `aria-label` 必须等于该面在
 *   `CONTEXT_SURFACE_MANIFEST` 里的中文名，**且不等于兜底「通用菜单」**（等于兜底 =
 *   面没接上，只是"没炸"）。热区不在场（没开项目 / 没标签 / 没面板）⇒ 该条**跳过并打印
 *   原因**，不假绿也不把整轮判红。
 *
 * - **C · 遮罩只认左键**（`isPrimaryButton`）：菜单开着时在遮罩上派发 `mousedown`，
 *   `button=2` ⇒ 菜单**仍在**（右键是开菜单的手势，不该顺手关掉）；`button=0` ⇒ 关闭。
 *
 * - **D · 层叠**：`.context-menu-host` 的 `z-index` ≥ 1300；菜单**在宿主内**（宿主建了
 *   层叠上下文，子层数值可以低于 1300——`.context-menu` 自身是 `calc(--z-modal + 1)`=1101，
 *   所以"菜单自身也 ≥1300"在本仓不成立，判据改成"宿主 ≥1300 + 菜单确实在宿主内 + 命中测试"）；
 *   页面上若有 `.floating-panel`(1200) / 宿主外的就地 `.context-menu`(1101)，
 *   它们的数值必须**严格小于**宿主；最后用 `elementFromPoint` 在菜单项中心做一次命中
 *   测试（数值对但被更高层盖住 = 用户点不到，只有命中测试抓得住）。
 */

/**
 * **面 id → 中文无障碍名对照表**。
 *
 * 真源是 `packages/app/src/ui/context-surfaces.ts` 的 `CONTEXT_SURFACE_MANIFEST`；本文件是
 * 独立 node 进程（不 import TS），只能抄一份。**改面 / 改 ariaLabel 时必须同步这里**，
 * `tools/tests/context-menu-smoke-shape.test.ts` 逐条对源码钉住（漏同步即红）。
 */
export const CONTEXT_MENU_ARIA_EXPECT = Object.freeze({
  editor: '编辑器菜单',
  'file-tree': '文件树菜单',
  tabs: '标签页菜单',
  problems: '问题面板菜单',
  'search-results': '搜索结果菜单',
  'panel-tabs': '面板选项卡菜单',
});

/** 兜底面的无障碍名（`context-menu-model.FALLBACK_MENU_ARIA_LABEL`）：B 组必须排除它 */
export const FALLBACK_MENU_ARIA_LABEL_EXPECT = '通用菜单';

/** 根宿主的最小 `z-index`（真源：`packages/app/src/context-menu.css` 的 `.context-menu-host`） */
export const HOST_Z_INDEX_MIN = 1300;

/** 脚本用到、且必须与实现同源的选择器（源形状测试逐个回源码核对，并核对探针里的字面量） */
export const CTX_SMOKE_SELECTORS = Object.freeze({
  host: '.context-menu-host',
  menu: '.context-menu',
  backdrop: '.context-menu-backdrop',
  menuitem: '[role="menuitem"]',
  editorFrame: '[data-context-surface="editor"]',
  monaco: '.monaco-editor',
  monacoMenu: '.monaco-menu-container',
  floatingPanel: '.floating-panel',
  fileTreeRow: '[data-context-surface="file-tree"]',
  tabRow: '[role="tab"][data-context-surface="tabs"]',
  statusCell: '[data-status-cell]',
});

/**
 * 页内探针（**只能靠 toString 序列化 ⇒ 不许引用任何模块级变量**）。
 *
 * @param {{recentRowSel: string}} opts `recentRowSel` 由 `smoke-lib.mjs` 提供：类名只准住在
 *   那一处（`tools/tests/` 里那份"最近项目选择器"守门双向钉死），所以从这里**注入**，
 *   本文件的源码里不出现欢迎页类名字符串。
 */
export function runContextMenuProbes(opts) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /**
   * 等 React 提交一帧（菜单是 useSyncExternalStore 驱动的，改状态 → 下一帧才进 DOM）。
   * **只用 `setTimeout` 不用 `rAF`**：冒烟时应用窗口可能被别的窗口遮住，WebView2 会暂停
   * rAF ⇒ 探针永远不返回 ⇒ CDP 超时（那会是一条与环境相关的假红）。
   */
  const settle = () => sleep(140);
  const q = (sel, root) => (root === undefined ? document.querySelector(sel) : root.querySelector(sel));
  const all = (sel, root) => Array.from((root === undefined ? document : root).querySelectorAll(sel));
  const flat = (el) => String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  const CJK = /[\u4e00-\u9fff]/;
  /** 英文原生菜单的特征项（WebView2 默认菜单 / 未本地化的 Monaco 菜单） */
  const EN = ['Select All', 'Copy', 'Paste', 'Cut', 'Inspect', 'Save as', 'Reload', 'Back', 'Forward'];
  const trace = [];

  const hostEl = () => q('.context-menu-host');
  const menuEl = () => q('.context-menu-host .context-menu');
  /** 我们自己菜单里的项（`button[role=menuitem]`）；Monaco 的项是 `a.action-menu-item` */
  const menuItemTexts = (root) => all('[role="menuitem"]', root).map(flat).filter((t) => t !== '');
  const englishHits = (texts) => texts.filter((t) => EN.includes(t));

  /**
   * 在元素上派发一次**右键**。坐标取元素矩形中心附近（Monaco 的 `getTargetAtClientPoint`
   * 需要真实视口坐标；纯 `{clientX:0, clientY:0}` 会落到行号槽/空白之外）。
   */
  const rightClick = (el) => {
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + Math.min(Math.max(r.width / 2, 4), r.width - 2));
    const y = Math.round(r.top + Math.min(Math.max(r.height / 2, 4), r.height - 2));
    const cx = Number.isFinite(x) ? x : 4;
    const cy = Number.isFinite(y) ? y : 4;
    el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 2,
        buttons: 2,
        clientX: cx,
        clientY: cy,
      }),
    );
    return { x: cx, y: cy };
  };

  /**
   * 收菜单。两条通道各归各的：
   * - **我们的菜单**：Esc 交 `<ContextMenu>` 自己的 keydown 收口（与用户按键同一条路），
   *   没接住再用遮罩的左键点一下（C 组断言的就是这条通道）；
   * - **Monaco 原生菜单**：它的关闭判据挂在 **window** 的 `mousedown` 上（右键会被它放过：
   *   `if (event.rightButton) return;`）。**不能**把左键 mousedown 派给 `.context-view-block`
   *   ——那块挡板自己 `stopPropagation()`，事件到不了 window，菜单不会关。
   */
  const dismiss = async () => {
    const ours = q('.context-menu-host .context-menu');
    if (ours !== null) {
      ours.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await settle();
      const backdrop = q('.context-menu-backdrop');
      if (menuEl() !== null && backdrop !== null) {
        backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
        await settle();
      }
    }
    const nativeMenu = q('.monaco-menu-container');
    if (nativeMenu !== null) {
      nativeMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await settle();
    }
    if (q('.monaco-menu-container') !== null) {
      window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
      await settle();
    }
  };

  /* ------------------------------------------------------------------ A 前置 */

  /**
   * 准备一个有编辑区的会话。顺序：已有 ⇒ 不动；欢迎页有「最近项目」行 **或**
   * 「继续上次会话」按钮 ⇒ 点开（写权限弹窗一律「只读浏览」，冒烟不写盘）；
   * 再展开文件树组头、点第一个文件。
   *
   * ⚠ 两个入口都要认：最近项目区可能为空（列表被清、只留会话记录），这时屏上只有
   * `.welcome-resume`。只认前者会让整组 A/B 停在 trace 的 `no-recent-row`——
   * 2026-10-23 首跑就是这么红的。点之前先等一会儿，会话记录是异步读回的。
   *
   * 整段只记 trace，**不下断言**（前置不满足由 Node 侧判红并打印 trace）。
   */
  const prepareEditor = async () => {
    if (q('.monaco-editor') !== null) {
      trace.push('editor-already');
      return;
    }
    const findOpenRow = () => q(opts.recentRowSel) ?? (opts.resumeRowSel ? q(opts.resumeRowSel) : null);
    let recent = findOpenRow();
    for (let i = 0; i < 24 && recent === null; i++) {
      await sleep(250);
      recent = findOpenRow();
    }
    if (recent === null) {
      trace.push('no-recent-row');
    } else {
      recent.click();
      trace.push(recent.classList.contains('welcome-resume') ? 'resume-clicked' : 'recent-clicked');
      for (let i = 0; i < 90; i++) {
        const modal = q('.modal[aria-label="写权限确认"]');
        if (modal !== null) {
          const deny = Array.from(modal.querySelectorAll('.modal-actions button')).find(
            (b) => flat(b) === '只读浏览',
          );
          if (deny !== undefined) {
            deny.click();
            trace.push('write-denied');
          }
        }
        if (q('.tree-file') !== null || q('.tree-group-btn') !== null) break;
        await sleep(700);
      }
    }
    for (let i = 0; i < 3 && q('.tree-file') === null; i++) {
      const groups = all('.tree-group-btn');
      trace.push('tree-groups=' + String(groups.length));
      for (const g of groups) g.click();
      await sleep(900);
    }
    const file = q('.tree-file');
    if (file === null) {
      trace.push('no-tree-file');
    } else {
      file.click();
      trace.push('tree-file-clicked');
    }
    for (let i = 0; i < 40 && q('.monaco-editor') === null; i++) await sleep(500);
    trace.push(q('.monaco-editor') === null ? 'no-editor' : 'editor-ready');
  };

  /* --------------------------------------------------- A1：Monaco 里子（原生菜单） */

  const probeMonacoNative = async () => {
    const editor = q('.monaco-editor');
    const out = { applicable: editor !== null };
    if (editor === null) return out;
    const surface = q('.monaco-editor .view-lines') || editor;
    rightClick(surface);
    await settle();
    await sleep(240); // Monaco 的菜单同步建，但样式表/首帧要一帧
    const native = q('.monaco-menu-container');
    const ours = q('.context-menu');
    out.ours = ours !== null;
    out.native = native !== null;
    out.items = native === null ? [] : menuItemTexts(native);
    out.cjkAll = out.items.length > 0 && out.items.every((t) => CJK.test(t));
    out.english = englishHits(out.items);
    out.editorAlive = q('.monaco-editor') !== null;
    out.surfaceText = surface === document.body ? '' : flat(surface).slice(0, 60);
    await dismiss();
    return out;
  };

  /* ------------------------------------------- A2：编辑器外框（我们的菜单） */

  const probeEditorFrame = async () => {
    const frame = q('[data-context-surface="editor"]');
    const out = { applicable: frame !== null };
    if (frame === null) return out;
    rightClick(frame);
    await settle();
    const menu = menuEl();
    out.menu = menu !== null;
    out.ariaLabel = menu === null ? null : menu.getAttribute('aria-label');
    out.items = menu === null ? [] : menuItemTexts(menu);
    out.cjkAll = out.items.length > 0 && out.items.every((t) => CJK.test(t));
    out.english = englishHits(out.items);
    out.editorAlive = q('.monaco-editor') !== null;
    await dismiss();
    return out;
  };

  /* ------------------------------------------------ B：三处热区各自命中对应面 */

  const HOTZONES = [
    {
      key: 'file-tree',
      label: '文件树行',
      expectId: 'file-tree',
      pick: () => q('[data-context-surface="file-tree"]'),
    },
    {
      key: 'tabs',
      label: '标签页',
      expectId: 'tabs',
      pick: () => q('[role="tab"][data-context-surface="tabs"]'),
    },
    {
      key: 'panel',
      label: '面板',
      expectId: null, // 三者按当前会话能开哪个用哪个
      pick: () =>
        q('[data-context-surface="problems"]') ||
        q('[data-context-surface="search-results"]') ||
        q('[data-context-surface="panel-tabs"]'),
    },
  ];

  const probeHotzones = async () => {
    const out = [];
    for (const zone of HOTZONES) {
      const el = zone.pick();
      if (el === null) {
        out.push({ key: zone.key, label: zone.label, applicable: false, reason: zone.label + '热区不在场' });
        continue;
      }
      const surfaceId = el.getAttribute('data-context-surface');
      rightClick(el);
      await settle();
      const menu = menuEl();
      out.push({
        key: zone.key,
        label: zone.label,
        applicable: true,
        expectId: zone.expectId,
        surfaceId,
        menu: menu !== null,
        ariaLabel: menu === null ? null : menu.getAttribute('aria-label'),
        items: menu === null ? [] : menuItemTexts(menu),
      });
      await dismiss();
    }
    return out;
  };

  /* ------------------------------------------------------- C：遮罩只认左键 */

  /** C/D 只求「开着一个菜单」：优先用真实热区，退化到 `.app-frame`（兜底面必然有项） */
  const openAnyMenu = async () => {
    const anchor =
      q('[data-context-surface="editor"]') ||
      q('[role="tab"][data-context-surface="tabs"]') ||
      q('[data-status-cell]') ||
      q('.app-frame');
    if (anchor === null) return false;
    rightClick(anchor);
    await settle();
    if (menuEl() !== null) return true;
    const frame = q('.app-frame');
    if (frame !== null && frame !== anchor) {
      rightClick(frame);
      await settle();
    }
    return menuEl() !== null;
  };

  const probeBackdrop = async () => {
    const out = { opened: false, backdrop: false };
    out.opened = await openAnyMenu();
    const backdrop = q('.context-menu-backdrop');
    out.backdrop = backdrop !== null;
    if (backdrop === null) return out;
    // 点在菜单外的空白处（左下角，远离 clamped 后的菜单与标题栏）
    const x = 6;
    const y = Math.max(6, window.innerHeight - 10);
    backdrop.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: x, clientY: y }),
    );
    await settle();
    out.afterRight = menuEl() !== null;
    backdrop.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y }),
    );
    await settle();
    out.afterLeft = menuEl() !== null;
    return out;
  };

  /* ------------------------------------------------------------ D：层叠 */

  const probeStacking = async () => {
    const out = { opened: false };
    out.opened = await openAnyMenu();
    const host = hostEl();
    const menu = menuEl();
    const zOf = (el) => {
      if (el === null) return null;
      const raw = getComputedStyle(el).zIndex;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    };
    out.hostZ = zOf(host);
    out.menuZ = zOf(menu);
    out.insideHost = host !== null && menu !== null && host.contains(menu);
    out.floats = all('.floating-panel').map((el) => ({ z: zOf(el), text: flat(el).slice(0, 24) }));
    out.inlineMenus = all('.context-menu')
      .filter((el) => host === null || !host.contains(el))
      .map((el) => zOf(el));
    const item = menu === null ? null : q('[role="menuitem"]', menu);
    if (item !== null) {
      const r = item.getBoundingClientRect();
      out.itemRect = { left: r.left, top: r.top, width: r.width, height: r.height };
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      out.hitTag = hit === null ? null : hit.tagName.toLowerCase();
      out.hitInside = hit !== null && menu.contains(hit);
    } else {
      out.itemRect = null;
      out.hitInside = false;
      out.hitTag = null;
    }
    await dismiss();
    return out;
  };

  return (async () => {
    await prepareEditor();
    const a1 = await probeMonacoNative();
    const a2 = await probeEditorFrame();
    const b = await probeHotzones();
    const c = await probeBackdrop();
    const d = await probeStacking();
    return {
      trace,
      editorPresent: q('.monaco-editor') !== null,
      a1,
      a2,
      b,
      c,
      d,
      stateAfter: { menuOpen: menuEl() !== null, host: hostEl() !== null },
    };
  })();
}

/** 一次判定的结果条目（`skipped` 只在 B 组的前置不满足时出现） */
export const CTX_SMOKE_GROUPS = Object.freeze(['A', 'B', 'C', 'D']);

/**
 * Node 侧判定（纯函数）：把页内读数翻成「通过 / 失败 / 跳过」。
 *
 * 口径（不许写松的部分）：
 * - A 组**没有跳过档**：没有编辑区就是红（任务要求 A 必须真验，不能"没找到菜单就跳过"）；
 * - B 组只在**热区不在场**时跳过，且跳过项带原因；热区在场却没菜单 / ariaLabel 不等于
 *   清单里的中文名 / 等于兜底「通用菜单」⇒ 一律红；
 * - C/D 没有跳过档。
 *
 * @param {unknown} readings `runContextMenuProbes()` 的返回值
 * @returns {{checks: Array<{group: string, name: string, ok: boolean, skipped?: boolean, detail: string}>, pass: boolean, skipped: string[]}}
 */
export function judgeContextMenuProbes(readings) {
  const checks = [];
  const push = (group, name, ok, detail, skipped) => {
    checks.push(skipped === true ? { group, name, ok, skipped: true, detail } : { group, name, ok, detail });
  };
  const r = readings !== null && typeof readings === 'object' ? readings : {};
  const say = (v) => JSON.stringify(v);
  const expect = CONTEXT_MENU_ARIA_EXPECT;

  /* ---- A1：Monaco 里子 ---- */
  const a1 = r.a1 ?? {};
  if (a1.applicable !== true) {
    push('A', 'A1 编辑区（Monaco 里子）可测', false, '没有 .monaco-editor（前置：须打开一个文件）；trace=' + say(r.trace ?? []));
  } else {
    push(
      'A',
      'A1 里子归 Monaco 原生菜单',
      a1.native === true,
      '期望 .monaco-menu-container 出现；实际 native=' + say(a1.native) + '，我们自己的菜单=' + say(a1.ours),
    );
    push(
      'A',
      'A1 我们的菜单没有抢里子',
      a1.ours === false,
      '期望 .context-menu 不出现（抢了里子 = 违背 editor-hotzones 契约）；实际=' + say(a1.ours),
    );
    push(
      'A',
      'A1 菜单项全中文',
      a1.cjkAll === true,
      'zh-cn NLS 未生效会读出英文项；items=' + say(a1.items),
    );
    push('A', 'A1 无英文原生项', (a1.english ?? []).length === 0, '命中=' + say(a1.english ?? []) + '；items=' + say(a1.items));
    push('A', 'A1 右键没把编辑区关掉', a1.editorAlive === true, '期望 .monaco-editor 仍在 DOM；实际=' + say(a1.editorAlive));
  }

  /* ---- A2：编辑器外框 ---- */
  const a2 = r.a2 ?? {};
  if (a2.applicable !== true) {
    push('A', 'A2 编辑器外框可测', false, '没有 [data-context-surface="editor"]（.editor-toolbar 未渲染）');
  } else {
    push('A', 'A2 外框出我们的菜单', a2.menu === true, '期望 .context-menu-host .context-menu 出现；实际=' + say(a2.menu));
    push(
      'A',
      'A2 aria-label = 编辑器菜单',
      a2.ariaLabel === expect.editor,
      '期望 ' + say(expect.editor) + '；屏上=' + say(a2.ariaLabel),
    );
    push('A', 'A2 菜单项全中文', a2.cjkAll === true, 'items=' + say(a2.items));
    push('A', 'A2 无英文原生项', (a2.english ?? []).length === 0, '命中=' + say(a2.english ?? []) + '；items=' + say(a2.items));
    push('A', 'A2 右键没把编辑区关掉', a2.editorAlive === true, '期望 .monaco-editor 仍在 DOM；实际=' + say(a2.editorAlive));
  }

  /* ---- B：三处热区 ---- */
  const b = Array.isArray(r.b) ? r.b : [];
  if (b.length !== 3) {
    push('B', 'B 三处热区的读数齐全', false, '期望 3 条热区读数；实际=' + say(b.map((x) => x && x.key)));
  }
  for (const zone of b) {
    const name = 'B ' + String(zone.label ?? zone.key);
    if (zone.applicable !== true) {
      push('B', name, true, '跳过：' + String(zone.reason ?? '热区不在场'), true);
      continue;
    }
    const id = zone.surfaceId;
    const want = expect[id];
    const idOk = zone.expectId === null ? want !== undefined : id === zone.expectId;
    push(
      'B',
      name + ' 命中对应面',
      idOk,
      zone.expectId === null
        ? '命中的面 id=' + say(id) + '（期望 problems / search-results / panel-tabs 之一）'
        : '期望面 id=' + say(zone.expectId) + '；命中=' + say(id),
    );
    push(
      'B',
      name + ' aria-label = 清单中文名',
      zone.menu === true && zone.ariaLabel === want,
      '期望 ' + say(want) + '；屏上=' + say(zone.ariaLabel) + '（items=' + say(zone.items) + '）',
    );
    push(
      'B',
      name + ' 不是兜底菜单',
      zone.ariaLabel !== FALLBACK_MENU_ARIA_LABEL_EXPECT,
      '兜底=' + say(FALLBACK_MENU_ARIA_LABEL_EXPECT) + ' 说明该面没接上；屏上=' + say(zone.ariaLabel),
    );
  }

  /* ---- C：遮罩只认左键 ---- */
  const c = r.c ?? {};
  push('C', 'C 菜单先开着', c.opened === true, '期望先有一个菜单可关；实际=' + say(c.opened));
  push('C', 'C 遮罩在场', c.backdrop === true, '期望 .context-menu-backdrop 在 DOM；实际=' + say(c.backdrop));
  push(
    'C',
    'C 遮罩上右键不关菜单',
    c.afterRight === true,
    'isPrimaryButton 修复后 button=2 不该 dismiss；实际菜单=' + say(c.afterRight),
  );
  push('C', 'C 遮罩上左键关菜单', c.afterLeft === false, '期望 button=0 后菜单消失；实际仍在=' + say(c.afterLeft));

  /* ---- D：层叠 ---- */
  const d = r.d ?? {};
  push('D', 'D 菜单先开着', d.opened === true, '期望先有一个菜单可量层叠；实际=' + say(d.opened));
  push(
    'D',
    'D 宿主 z-index ≥ ' + String(HOST_Z_INDEX_MIN),
    typeof d.hostZ === 'number' && d.hostZ >= HOST_Z_INDEX_MIN,
    '期望 ≥ ' + String(HOST_Z_INDEX_MIN) + '；屏上 .context-menu-host=' + say(d.hostZ) + '（菜单自身=' + say(d.menuZ) + '）',
  );
  push('D', 'D 菜单挂在宿主内', d.insideHost === true, '宿主不含菜单时子层数值不可比；实际=' + say(d.insideHost));
  push(
    'D',
    'D 浮层都压在宿主之下',
    (Array.isArray(d.floats) ? d.floats : []).every((f) => typeof f.z !== 'number' || (typeof d.hostZ === 'number' && f.z < d.hostZ)),
    'floats=' + say(d.floats) + '；宿主=' + say(d.hostZ),
  );
  push(
    'D',
    'D 宿主外的就地菜单也在宿主之下',
    (Array.isArray(d.inlineMenus) ? d.inlineMenus : []).every((z) => typeof z !== 'number' || (typeof d.hostZ === 'number' && z < d.hostZ)),
    'inlineMenus=' + say(d.inlineMenus) + '；宿主=' + say(d.hostZ),
  );
  push(
    'D',
    'D 菜单项真的在最高层（命中测试）',
    d.hitInside === true,
    'elementFromPoint(菜单项中心) 应落在菜单内；实际 hit=' + say(d.hitTag) + '，itemRect=' + say(d.itemRect),
  );

  const skipped = checks.filter((x) => x.skipped === true).map((x) => x.group + ' · ' + x.name + '（' + x.detail + '）');
  return { checks, pass: checks.every((x) => x.ok), skipped };
}
