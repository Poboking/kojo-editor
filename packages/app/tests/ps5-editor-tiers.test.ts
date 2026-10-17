/**
 * PS-5 · 体量档位在"全文级开销"这条轴上的补齐（editor-options.ts）。
 *
 * 钉四件事：
 *  ① 新增的五条键（wordWrap / selectionHighlight / links / colorDecorators / folding）
 *     **每一档都写值**——`updateOptions` 只覆写发过去的键，小档漏写就是从大文件切回来
 *     卡在大档的关值（档位漂移，与既有 `minimap` / `stickyScroll` 同一条纪律）；
 *  ② 大档真的关掉了那三条全文级扫描，huge 再关折行与折叠；
 *  ③ 三条既有不变式不受影响（CJK 基线逐档同在 / 降级集永不含 fontSize·zoomLevel /
 *     find 逐档同值）；
 *  ④ 论据不靠记忆：vendor 侧的取证（find 的 19,999 上限、diff 的 5,000ms·50MB 缺省、
 *     `largeFileOptimizations` 这个总开关**不在** monaco-editor 里）逐条读源码钉住。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HUGE_FILE_LINES,
  LARGE_FILE_LINES,
  CJK_TYPING_BASELINE,
  FIND_BASELINE,
  editorOptionsForLineCount,
} from '../src/ui/editor-options';

const vendor = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../node_modules/monaco-editor/esm/vs/${rel}`, import.meta.url)), 'utf8');

const tierSamples = [1, 4_999, LARGE_FILE_LINES, HUGE_FILE_LINES, 990_000];

describe('PS-5 档位补齐：每条体量轴的键都必须逐档有值', () => {
  const KEYS = ['wordWrap', 'selectionHighlight', 'links', 'colorDecorators', 'folding'] as const;

  it('五档样本都带齐这五条键（小档不写 = 从大文件切回来卡在关值）', () => {
    for (const n of tierSamples) {
      const o = editorOptionsForLineCount(n);
      for (const k of KEYS) expect(o, `${n} 缺 ${k}`).toHaveProperty(k);
    }
  });

  it('small 档：五条全开（便利特性不因"补齐"而被默认值带走）', () => {
    const o = editorOptionsForLineCount(500);
    expect(o.wordWrap).toBe('on');
    expect(o.selectionHighlight).toBe(true);
    expect(o.links).toBe(true);
    expect(o.colorDecorators).toBe(true);
    expect(o.folding).toBe(true);
  });

  it('large 档：关三条全文级扫描，折行与折叠照留（读台词要靠它们）', () => {
    const o = editorOptionsForLineCount(LARGE_FILE_LINES);
    expect(o.selectionHighlight).toBe(false);
    expect(o.links).toBe(false);
    expect(o.colorDecorators).toBe(false);
    expect(o.wordWrap).toBe('on');
    expect(o.folding).toBe(true);
  });

  it('huge 档：折行关 + 折叠关，并继承 large 的三条关值', () => {
    const o = editorOptionsForLineCount(HUGE_FILE_LINES);
    expect(o.wordWrap).toBe('off');
    expect(o.folding).toBe(false);
    expect(o.selectionHighlight).toBe(false);
    expect(o.links).toBe(false);
    expect(o.colorDecorators).toBe(false);
    // 99 万行级盘同样走这一档（阈值判据不许在超大读数上漂档）
    expect(editorOptionsForLineCount(990_000).wordWrap).toBe('off');
  });

  it('往返：huge → small 五条全部回到开值（切标签不"半套恢复"）', () => {
    editorOptionsForLineCount(HUGE_FILE_LINES);
    const back = editorOptionsForLineCount(100);
    for (const k of KEYS) expect(back[k]).toBeTruthy();
  });

  it('不变式不被动：find 与 CJK 基线逐档同值，降级集永不含字号/缩放', () => {
    for (const n of tierSamples) {
      const o = editorOptionsForLineCount(n);
      expect(o.find, String(n)).toEqual(FIND_BASELINE.find);
      expect(o.unicodeHighlight, String(n)).toEqual(CJK_TYPING_BASELINE.unicodeHighlight);
      expect(Object.keys(o)).not.toContain('fontSize');
      expect(Object.keys(o)).not.toContain('zoomLevel');
    }
  });
});

describe('PS-5 论据取证（读 vendor 源码，不读记忆）', () => {
  it('find 的命中计数自带 19,999 上限 ⇒ 这一项没有档位旋钮可拧，也不必拧', () => {
    const src = vendor('editor/contrib/find/browser/findModel.js');
    expect(src).toContain('const MATCHES_LIMIT = 19999;');
    // 越界即"数到顶就停 + 显示 20000+"，全文级代价已被 vendor 自己封顶（不做第二层闸）
    expect(vendor('editor/contrib/find/browser/findWidget.js')).toContain('MATCHES_LIMIT');
  });

  it('monaco-editor 不导出 VS Code 那个 largeFileOptimizations 总开关 ⇒ 只能自己按档列', () => {
    expect(vendor('editor/common/config/editorOptions.js')).not.toContain('largeFileOptimizations');
  });

  it('本轮新用的五条键都在 0.57 的类型面上在册（写错键名 = 静默无效）', () => {
    const dts = readFileSync(fileURLToPath(new URL('../node_modules/monaco-editor/monaco.d.ts', import.meta.url)), 'utf8');
    for (const k of ['selectionHighlight?:', 'links?:', 'colorDecorators?:', 'folding?:', 'wordWrap?:']) {
      expect(dts, k).toContain(k);
    }
  });

  it('diff 的两道 vendor 刹车缺省确实太晚（5,000ms / 50MB）——PS-5 的收紧有据', () => {
    const src = vendor('editor/common/config/diffEditor.js');
    expect(src).toContain('maxComputationTime: 5000');
    expect(src).toContain('maxFileSize: 50');
  });
});
