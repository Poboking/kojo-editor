/**
 * 调试面的 DOM 结构快照（2026-10-24 调试模式批）。
 *
 * 口径照 `tools/smoke-tauri-dom.mjs` 的 §5.117 教训：**只认结构，不匹配界面文案**——
 * 文案是 UI 批的常改项，快照里出现文案只是「读数」（供人 / agent 看屏上有什么），
 * 判据一律用类名 / data 属性这类结构锚。
 *
 * 形态：纯函数、吃 `document`（测试里可以喂一个伪造的最小 document 形状），
 * 返回可直接 JSON 的普通对象。选择器全部集中在本文件顶部的表里——
 * 与 `tools/smoke-lib.mjs` 的 `WELCOME_RECENT_CLASSES` 同一纪律：改类名先改这张表。
 */

/** 快照里每个「可见面」的通用形状：结构锚 + 供人读的文本（截断） */
export interface SurfaceReading {
  readonly kind: string;
  readonly count?: number;
  readonly items?: readonly string[];
}

export interface DomSnapshot {
  /** welcome（欢迎页在场）/ project（项目态）/ unknown */
  readonly phase: 'welcome' | 'project' | 'unknown';
  readonly theme: string;
  readonly welcome: SurfaceReading | null;
  readonly notices: SurfaceReading;
  readonly tabs: SurfaceReading;
  readonly treeFiles: SurfaceReading;
  readonly panels: SurfaceReading;
  readonly statusbar: SurfaceReading;
  readonly modals: SurfaceReading;
  readonly palette: SurfaceReading;
}

/** 文本读数的截断上限：快照是给人 / agent 看的，不是全文转储 */
const TEXT_CLIP = 120;

function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > TEXT_CLIP ? `${t.slice(0, TEXT_CLIP)}…` : t;
}

function texts(root: ParentNode, selector: string, limit = 40): string[] {
  const out: string[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
    out.push(clip(el.textContent ?? ''));
    if (out.length >= limit) break;
  }
  return out;
}

export function snapshotDocument(doc: Document): DomSnapshot {
  const phase: DomSnapshot['phase'] = doc.querySelector('.welcome')
    ? 'welcome'
    : doc.querySelector('.file-tree, .editor-tabs-bar, .monaco-editor')
      ? 'project'
      : 'unknown';

  const welcomeEl = doc.querySelector('.welcome');
  const panels = Array.from(doc.querySelectorAll<HTMLElement>('[class*="panel panel-"]'))
    .map((el) => el.className.match(/panel-([\w.-]+)/)?.[1] ?? el.className)
    .slice(0, 40);

  return {
    phase,
    theme: doc.documentElement.getAttribute('data-theme') ?? '',
    welcome: welcomeEl
      ? {
          kind: 'welcome',
          count: doc.querySelectorAll('.welcome-card').length,
          // 欢迎页动作按钮的结构锚（打开项目 / 教程卡都在这批类名上）
          items: [
            ...texts(doc, '.welcome-open'),
            ...texts(doc, '.welcome-resume'),
          ],
        }
      : null,
    notices: {
      kind: 'notices',
      count: doc.querySelectorAll('.notice').length,
      items: texts(doc, '.notice'),
    },
    tabs: {
      kind: 'tabs',
      count: doc.querySelectorAll('.tab-label').length,
      items: texts(doc, '.tab-label'),
    },
    treeFiles: {
      kind: 'treeFiles',
      count: doc.querySelectorAll('.tree-file').length,
      items: texts(doc, '.tree-file'),
    },
    panels: { kind: 'panels', count: panels.length, items: panels },
    statusbar: {
      kind: 'statusbar',
      count: doc.querySelectorAll('[data-status-cell]').length,
      items: texts(doc, '[data-status-cell]'),
    },
    modals: {
      kind: 'modals',
      count: doc.querySelectorAll('.modal').length,
      items: Array.from(doc.querySelectorAll<HTMLElement>('.modal'))
        .map((el) => el.getAttribute('aria-label') ?? clip(el.textContent ?? ''))
        .slice(0, 10),
    },
    palette: {
      kind: 'palette',
      count: doc.querySelectorAll('.picker.pk').length,
      items: texts(doc, '.picker-item'),
    },
  };
}
