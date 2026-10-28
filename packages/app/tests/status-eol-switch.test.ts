// @vitest-environment happy-dom
/**
 * W7-H · 状态栏 EOL 一键切换（LF / CRLF）——model 与接线两半。
 *
 * 本文件**不渲染组件、不点按钮**：真 Monaco 的模块图在 happy-dom 里会挂上
 * WebKit 剪贴板 workaround（任意 click 都会生成一条可被取消的 ClipboardItem
 * promise ⇒ vitest 记未处理拒绝）。入口/菜单的渲染取证在
 * `status-eol-readout.test.ts`（那份只引壳层，不引 Monaco）。
 *
 * 交付面（本批 + FIX-UNDO-RESIDUAL④ 更正）：
 * - 落地 = `applyEolToModel`：版本号偏离基线 ⇒ 既有脏判定（`computeDirty` 就是
 *   `getAlternativeVersionId() !== 基线`）立刻成立，`model.getValue()` 改用新换行；
 * - **撤销面（旧注写过「`setEOL` 撤销栈留一条」，那是与 monaco API 契约相反的话）**：
 *   monaco.d.ts 明写 `applyEdits` / `setEOL` 这类是 raw 变更、**不上撤销栈**。所以旧写法下
 *   「切换行尾」根本撤不掉，作者按 Ctrl+Z 退的是自己上一次打字。现改走 `pushEOL` +
 *   **前后各一颗 `pushStackElement()`** ⇒ 产品口径钉死为「一次 Ctrl+Z 只退行尾档位、作者打字留下」
 *   （取证见下面 ② 那组三段，全在**真 monaco model** 上跑；① 的脏判定读数不受影响）；
 * - 只读 / 预览面由 `eolSwitchAllowed` 拒绝（写权限 + `erbReadOnlyGate` + 非预览）。
 *
 * **保存面未闭环（本批取证结论，别把这里读成闭环）**：缺省保存走
 * `kernel.io.writeText(path, text)` 的"逐行保换行"——未改动行保留盘上原换行、
 * 改动行按原多数派 ⇒ 纯换行切换会在保存时被归一回盘上原始风格。该语义由内核既有
 * `kernel/tests/io.test.ts` / `encoding-roundtrip.test.ts` 钉住；本批按任务要求
 * **不动盘链**，闭环方案（受控的按文件 eol 覆盖位 + writeText 显式 `{ eol }`）
 * 写在 `applyEolToModel` 头注里。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as monaco from '../src/monaco/entry';
import { applyEolToModel, modelEolOf } from '../src/ui/EditorPane';

const SOURCE = readFileSync(
  path.resolve(import.meta.dirname, '..', 'src', 'ui', 'EditorPane.tsx'),
  'utf8',
);
const PROJECT_VIEW = readFileSync(
  path.resolve(import.meta.dirname, '..', 'src', 'ui', 'ProjectView.tsx'),
  'utf8',
);
/** 工具条/状态位的样式终值（④ 组按选择器取级联最后一条规则体） */
const STYLES = readFileSync(
  path.resolve(import.meta.dirname, '..', 'src', 'styles-project.css'),
  'utf8',
);

/** 截 `start` 到其后第一次出现的 `end`（找不到即测试失败，绝不静默给空串） */
function sliceBetween(start: string, end: string, source = SOURCE): string {
  const from = source.indexOf(start);
  expect(from, `找不到起点：${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, `找不到终点：${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

const APPLY_EOL = sliceBetween('export function applyEolToModel(', '/** autosave 快照句柄', SOURCE);
const SWITCH_EOL = sliceBetween('const switchEol = useCallback(', '/**\n   * 以磁盘最新内容重载', SOURCE);

/* ---------------- ① model 行为：切换即脏，文本用新 EOL ---------------- */

describe('applyEolToModel：切换后版本号偏离基线（既有脏判定），model 文本用新换行', () => {
  const models: monaco.editor.ITextModel[] = [];
  let seq = 0;
  const makeModel = (text: string): monaco.editor.ITextModel => {
    const model = monaco.editor.createModel(
      text,
      'plaintext',
      monaco.Uri.parse(`inmemory://w7h-eol/${++seq}`),
    );
    models.push(model);
    return model;
  };

  afterEach(() => {
    for (const model of models.splice(0)) if (!model.isDisposed()) model.dispose();
  });

  it('CRLF → LF：版本号离开基线（computeDirty 口径）、getValue 全面换成 LF；重复切同档不再动', () => {
    const model = makeModel('a\r\nb\r\n');
    expect(model.getEOL()).toBe('\r\n');
    const baseline = model.getAlternativeVersionId();

    expect(applyEolToModel(model, 'LF')).toBe(true);
    expect(model.getEOL()).toBe('\n');
    expect(model.getValue()).toBe('a\nb\n');
    const afterSwitch = model.getAlternativeVersionId();
    // EditorPane.computeDirty = getAlternativeVersionId() !== 基线 —— 这一条就是"切换后标脏"
    expect(afterSwitch).not.toBe(baseline);

    // 已是目标档：不制造第二次脏（版本号原地不动）
    expect(applyEolToModel(model, 'LF')).toBe(false);
    expect(model.getAlternativeVersionId()).toBe(afterSwitch);
  });

  it('LF → CRLF：反向同口径（getValue 的行尾变 CRLF）', () => {
    const model = makeModel('a\nb\n');
    expect(model.getEOL()).toBe('\n');
    const baseline = model.getAlternativeVersionId();

    expect(applyEolToModel(model, 'CRLF')).toBe(true);
    expect(model.getEOL()).toBe('\r\n');
    expect(model.getValue()).toBe('a\r\nb\r\n');
    expect(model.getAlternativeVersionId()).not.toBe(baseline);
  });

  it('已 dispose 的 model 一律拒绝（切标签竞态兜底）', () => {
    const model = makeModel('a\r\n');
    model.dispose();
    expect(applyEolToModel(model, 'LF')).toBe(false);
  });
});

/* ---------------- ② 撤销面（FIX-UNDO-RESIDUAL④）：切档在栈上自成一段 ---------------- */

describe('applyEolToModel 上栈：一次 Ctrl+Z 只退行尾档位，作者打字留下', () => {
  const models: monaco.editor.ITextModel[] = [];
  let seq = 1000;
  const makeModel = (text: string): monaco.editor.ITextModel => {
    const model = monaco.editor.createModel(
      text,
      'plaintext',
      monaco.Uri.parse(`inmemory://w7h-undo/${++seq}`),
    );
    models.push(model);
    return model;
  };
  /** 作者打一个字：真壳里是键入，落栈同一条路，**不补停点 ⇒ 栈顶那格开着**（正是并格的温床） */
  const authorTyping = (model: monaco.editor.ITextModel, line: number, typed: string): void => {
    const col = model.getLineMaxColumn(line);
    model.pushEditOperations(
      null,
      [{ range: new monaco.Range(line, col, line, col), text: typed }],
      () => null,
    );
  };

  afterEach(() => {
    for (const model of models.splice(0)) if (!model.isDisposed()) model.dispose();
  });

  it('打字 → 切 LF：第一下只退档位（CRLF 回来、X 还在屏上），第二下才退打字', () => {
    const model = makeModel('a\r\nb\r\n');
    authorTyping(model, 2, 'X');
    const afterTyping = model.getValue();
    expect(afterTyping).toBe('a\r\nbX\r\n');

    expect(applyEolToModel(model, 'LF')).toBe(true);
    expect(model.getValue()).toBe('a\nbX\n'); // 整篇换行已换档，作者的 X 一个字没丢

    expect(model.canUndo()).toBe(true);
    model.undo(); // ← 作者按下 Ctrl+Z 的那一下
    expect(model.getEOL()).toBe('\r\n');
    expect(model.getValue()).toBe(afterTyping); // 退掉的只有行尾档位
    expect(model.canUndo()).toBe(true);
    model.undo(); // 这才轮到作者自己的打字
    expect(model.getValue()).toBe('a\r\nb\r\n');
  });

  it('切档后再打字另起一格（后停点封口）：撤销依次退打字、再退档位', () => {
    const model = makeModel('a\r\nb\r\n');
    expect(applyEolToModel(model, 'LF')).toBe(true);
    const afterSwitch = model.getValue();
    expect(afterSwitch).toBe('a\nb\n');

    authorTyping(model, 1, 'Y');
    expect(model.getValue()).toBe('aY\nb\n');

    model.undo(); // 第一下只退打字 ⇒ 打字没并进档位那一格
    expect(model.getValue()).toBe(afterSwitch);
    expect(model.getEOL()).toBe('\n');
    model.undo(); // 第二下才退档位
    expect(model.getEOL()).toBe('\r\n');
    expect(model.getValue()).toBe('a\r\nb\r\n');
  });

  it('机理反证（monaco 契约锚，不随本批代码变红）：raw 的 setEOL 在栈上一段都不留 ⇒ 切档与打字混在同一步', () => {
    const model = makeModel('a\r\nb\r\n');
    authorTyping(model, 2, 'X');
    expect(model.getValue()).toBe('a\r\nbX\r\n');

    // 改前那条路：monaco.d.ts 归为 raw 变更（`applyEdits` / `setEOL` 一类），**不上撤销栈**
    model.setEOL(monaco.editor.EndOfLineSequence.LF);
    expect(model.getValue()).toBe('a\nbX\n');

    // 栈上多不出"切档"这一段 ⇒ 可退的只有打字那一格，产品要的"第一下只退档位"在这条路上不存在
    let steps = 0;
    while (model.canUndo() && steps < 8) {
      model.undo();
      steps += 1;
    }
    expect(steps).toBe(1);
    // 而那唯一一步把档位顺带翻回（元素存的是 beforeEOL），作者的 X 却退不掉（坐标已 stale）
    // = 打字与切档被裹在一起 + 机器改动的后果无从单独回退，正是 API 注释里的 "dire consequences"
    expect(model.getEOL()).toBe('\r\n');
    expect(model.getValue()).toContain('X');
  });
});

/* ---------------- ③ 接线（静态守门：动作句柄 / 焦点组 / 三处状态上报） ---------------- */

describe('接线：动作句柄、焦点组转发、状态上报同一链路', () => {
  it('setEOL 走 Monaco 的 EndOfLineSequence，且已是目标档时不动（不制造无意义脏）', () => {
    expect(APPLY_EOL).toContain('monaco.editor.EndOfLineSequence.CRLF');
    expect(APPLY_EOL).toContain('monaco.editor.EndOfLineSequence.LF');
    expect(APPLY_EOL).toContain('model.isDisposed()');
    expect(APPLY_EOL).toContain('model.getEOL() === target');
  });

  it('上栈通道本体（代码面钉子，删掉即红）：pushEOL 前后各一颗 pushStackElement，且不留 raw setEOL', () => {
    // 剥注释：头注里"setEOL 是 raw 变更"这类解释性文字不该把针弄红/弄绿
    const code = APPLY_EOL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).toContain('model.pushEOL(');
    expect(code).not.toContain('model.setEOL('); // raw 通道不许再出现在这颗上
    const first = code.indexOf('pushStackElement()');
    const eolAt = code.indexOf('model.pushEOL(');
    const last = code.lastIndexOf('pushStackElement()');
    expect(first, 'applyEolToModel 里没有停点').toBeGreaterThanOrEqual(0);
    expect(eolAt).toBeGreaterThan(first); // 前停点确在切档之前（给作者那一格封口）
    expect(last).toBeGreaterThan(eolAt); // 后停点保留（切档自己那格也得封）
    expect(code.match(/pushStackElement\(\)/g)?.length).toBe(2);
  });


  it('switchEol 只认可写原文面：预览判据 + 写权限 + 只读门（与保存/readOnly 同一把尺子）', () => {
    expect(SWITCH_EOL).toContain('eolSwitchAllowed(path)');
    expect(SWITCH_EOL).toContain('applyEolToModel(entry.model, eol)');
    expect(SWITCH_EOL).toContain('entry.eol = eol');
    expect(SWITCH_EOL).toContain('pushSelStatus(true)');
    // 判据本体：预览面 / 写权限 / erbReadOnlyGate（与换文件 effect 同一门）
    expect(SOURCE).toContain('if (sugarModelRef.current !== null) return false;');
    expect(SOURCE).toContain('if (!kernel.io.isWritable(path)) return false;');
    expect(SOURCE).toContain('return !erbReadOnlyGate(path, { inWorkspace: inWorkspace(path), canEdit });');
  });

  it('动作句柄注册了 switchEol（状态栏菜单经宿主转发到编辑器）', () => {
    // 钉的是"这一发注册把 switchEol 交了出去"，**不钉排版**：真另存为批给同一枚句柄加了
    // `readBuffer` / `transferBuffer` 两枚，prettier 把整段折成多行 ⇒ 逐字单行字面量必然红。
    // 归一空白后再比，判据强度一分不降：少任何一枚名字、或整发注册被删，照样红。
    expect(SOURCE.replace(/\s+/g, ' ')).toContain(
      'registerActions?.({ save: () => save(), savePath: (p) => savePath(p), saveAll, snapshots, switchEol, readBuffer, transferBuffer, });',
    );
    expect(PROJECT_VIEW).toContain('paneActionsRef.current.set(gid, actions)');
    expect(PROJECT_VIEW).toContain('?.switchEol(eol)');
    expect(PROJECT_VIEW).toContain('onSwitchEol={switchEolInActiveGroup}');
  });

  it('两处状态上报都带 eolSwitchable（开文件/光标、自动保存），预览与解锁翻转时补报', () => {
    // 字面量出现两次：pushSelStatus（开文件 / 光标 / 切标签共用）+ 自动保存那条
    expect(SOURCE.match(/\beolSwitchable:/g)?.length).toBe(2);
    // 只读门翻转 / 预览开关 / 直连开关 ⇒ 立刻重报（入口跟着收回或恢复）
    const refreshes = SOURCE.match(/pushSelStatus\(true\)/g)?.length ?? 0;
    expect(refreshes).toBeGreaterThanOrEqual(6);
  });
});

/* ---------------- ③ EOL-READOUT-TRUTH：读数与早退一律取 model（缓存会说谎） ---------------- */

describe('modelEolOf：档位真值只认 model.getEOL()', () => {
  const models: monaco.editor.ITextModel[] = [];
  let seq = 0;
  const makeModel = (text: string): monaco.editor.ITextModel => {
    const model = monaco.editor.createModel(
      text,
      'plaintext',
      monaco.Uri.parse(`inmemory://eol-readout/${++seq}`),
    );
    models.push(model);
    return model;
  };

  afterEach(() => {
    for (const model of models.splice(0)) if (!model.isDisposed()) model.dispose();
  });

  it('LF / CRLF 两档逐字相等；混合行尾返回 model 自己认的那一档（不是多数派）', () => {
    expect(modelEolOf(makeModel('a\nb\n'))).toBe('LF');
    expect(modelEolOf(makeModel('a\r\nb\r\n'))).toBe('CRLF');

    const mixed = makeModel('a\r\nb\nc\n');
    expect(modelEolOf(mixed)).toBe(mixed.getEOL() === '\r\n' ? 'CRLF' : 'LF');
  });

  it('setEOL 之后真值立刻跟着换（缓存字段不参与判定）', () => {
    const model = makeModel('a\r\nb\r\n');
    expect(modelEolOf(model)).toBe('CRLF');
    applyEolToModel(model, 'LF');
    expect(modelEolOf(model)).toBe('LF');
  });
});

describe('接线：读数 / 早退 / 崩溃快照都取 model 真值（entry.eol 只是打开时的盘上缓存）', () => {
  it('状态栏两处 eol 与自动保存那条都走 modelEolOf', () => {
    const pushSel = sliceBetween('const pushSelStatus = useCallback(', '* 全部脏标签', SOURCE);
    expect(pushSel, 'pushSelStatus 的 eol 必须取 model').toContain('eol: modelEolOf(entry.model)');
    // 自动保存成功那条（live = entriesRef 现取）
    expect(SOURCE).toContain('eol: modelEolOf(live.model)');
    // 批次十一 L13 去重：编码·EOL·行数**不再写进工具条状态位**（这份读数只在底部状态栏
    // 一份；工具条与状态栏各打一份同一个数，正是"重复信息"的实测病灶）。开/换文件与
    // EOL 切换两条腿都只走 pushSelStatus 上抛，工具条那一格从此只剩 瞬时态/错误 两档。
    expect(SOURCE).not.toContain('setStatus(`${entry.encoding}');
    expect(SOURCE).toContain('setStatus(\'\');');
  });

  it('switchEol 的早退比较用 model 真档，不再拿缓存 entry.eol 比', () => {
    expect(SWITCH_EOL).toContain('const current = modelEolOf(entry.model);');
    expect(SWITCH_EOL).toContain('if (current === eol)');
    expect(SWITCH_EOL, '拿缓存比会把"状态说 A、屏幕是 B"的文件永远卡死在早退里').not.toContain(
      'if (entry.eol === eol)',
    );
  });

  it('崩溃恢复快照的 eol 也取 model（重建 model 时不能按缓存写错档）', () => {
    const snapshots = sliceBetween('const snapshots = useCallback(', '  }, [computeDirty]);', SOURCE);
    expect(snapshots).toContain('eol: modelEolOf(entry.model)');
  });
});

/* ---------------- ④ 工具条状态位三拆 + 瞬时态自动回落（批次十一 L13） ---------------- */
/**
 * 这一组是**行为面**的守门，比样式更容易回退，故钉死三件事：
 * 1. **三区各有归属**：元信息 / 瞬时态 / 错误 是三个类名、三条互斥分支（不是过去那一格
 *    「错误和编码·换行·行数同灰度并排」）；
 * 2. **瞬时态一定回落**：写过 `setStatus` 的站点有 5 处（保存回执 / 磁盘重载 / 合并提示…），
 *    复位站点原本只有 2 处 ⇒ 「界面停着一句几分钟前的话」是旧病灶。现在由**一条**effect
 *    统一收口：`STATUS_FLASH_MS` 到点回落元信息位，且**只清自己那一句**（8s 内来了新的
 *    第二句时旧定时器不许把它抢白）；
 * 3. **回落不吞错误**：错误走独立 state、持久驻留（铁律 4「内核不静默」），复位只发生在
 *    保存成功 / 换文件这两条腿上 ⇒ 自动回落通道里出现 `setError` 就是越权。
 *
 * 写法沿用本文件的**静态守门**口径（EditorPane 挂整套 Monaco 与内核槽位，node 里渲染不出
 * 来；见文件头「本文件不渲染组件、不点按钮」）。
 */
describe('工具条状态位三拆：元信息 / 瞬时态 / 错误 三区互斥', () => {
  /** 三拆后的分支 JSX（从 `className="editor-status"` 那颗到它的三元链结尾） */
  const STATUS_BLOCK = sliceBetween(
    '<span className="editor-status"',
    '<span className="editor-status-meta" aria-hidden="true" />',
    SOURCE,
  );

  it('三档类名都在，且各只出现一次（多一处 = 又开了第二个落点，真源漂移）', () => {
    for (const cls of ['editor-status-meta', 'editor-status-flash', 'editor-status-error']) {
      expect(SOURCE.match(new RegExp(`className="${cls}"`, 'g'))?.length, cls).toBe(1);
    }
  });

  it('分支次序 = 错误 > 瞬时态 > 元信息空档（三元互斥，同一格不叠两份事实）', () => {
    expect(STATUS_BLOCK).toContain('{error ? (');
    expect(STATUS_BLOCK).toContain("status !== '' ? (");
    // 档名在**全文**里的先后（sliceBetween 不含终点标记，故不在此块内量 meta）
    const err = SOURCE.indexOf('editor-status-error');
    const flash = SOURCE.indexOf('editor-status-flash');
    const meta = SOURCE.indexOf('editor-status-meta');
    expect(err).toBeGreaterThan(-1);
    expect(flash).toBeGreaterThan(err);
    expect(meta).toBeGreaterThan(flash);
    // 全文由**分档**承载（不再裸挂在那一格上——同灰度并排正是旧病灶）
    expect(STATUS_BLOCK).toMatch(/className="editor-status-error">[\s\S]*?\{error\}\s*<\/span>/);
    expect(STATUS_BLOCK).toContain('<span className="editor-status-flash">{status}</span>');
    // 元信息档是一格**空档**（去重后不再重打编码·EOL·行数），只占位不播报
    expect(SOURCE).toContain('<span className="editor-status-meta" aria-hidden="true" />');
  });

  it('错误位带图标（不只靠颜色传达）', () => {
    expect(STATUS_BLOCK).toContain('<Icon name="warning" size="sm" /> {error}');
  });
});

describe('瞬时态自动回落：一条通道收口五个写点，且不碰错误', () => {
  const FLASH_EFFECT = sliceBetween("if (status === '') return;", '  }, [status]);', SOURCE);

  it('回落挂在 STATUS_FLASH_MS 定时器上，比对旧值后才清空（新句子不被旧定时器抢白）', () => {
    expect(FLASH_EFFECT).toContain('window.setTimeout');
    expect(FLASH_EFFECT).toContain('STATUS_FLASH_MS');
    expect(FLASH_EFFECT).toContain("setStatus((cur) => (cur === status ? '' : cur))");
    expect(FLASH_EFFECT).toContain('window.clearTimeout(t)'); // 卸载/换句必清（否则定时器跨文件说话）
  });

  it('越权红线：这条自动回落通道里不许出现 setError（错误位持久驻留，不随瞬时态一起抹）', () => {
    expect(FLASH_EFFECT).not.toContain('setError');
  });

  it('时限是正数常量（0 = 一句话刚上屏就闪没；Infinity = 等于没做回落）', () => {
    const decl = SOURCE.match(/^const STATUS_FLASH_MS = (\d+);$/m);
    expect(decl, 'STATUS_FLASH_MS 必须是模块级字面量常量').not.toBeNull();
    const ms = Number(decl?.[1]);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(60_000);
  });

  it('五个瞬时态写点全部只走 setStatus（回落因此覆盖每一处，不必各写一份定时器）', () => {
    expect(SOURCE.match(/setStatus\(/g)?.length).toBeGreaterThanOrEqual(6);
    // 保存回执 / 磁盘重载 / 合并提示 三句具体话术仍在（删掉即静默，回落测试也就没东西可回落）
    expect(SOURCE).toContain('已保存，但保存期间又有新输入');
    expect(SOURCE).toContain('已从磁盘重新加载（文件在外部被修改）');
    expect(SOURCE).toContain('已合并磁盘改动与你的未保存改动（还没写入磁盘）');
  });

  it('错误复位仍只有两条腿：保存成功、换文件（自动回落不是第三条）', () => {
    expect(SOURCE.match(/setError\(null\);/g)?.length).toBe(3);
    // 保存成功那一腿：清了错误才给瞬时态让位（顺序颠倒 = 回执把错误盖掉）
    expect(SOURCE).toMatch(/setError\(null\);\s*\n\s*setStatus\(`已保存 /);
    // 换文件那一腿：错误与上一份文件的瞬时态**一道**清，元信息位落回空档
    expect(SOURCE).toMatch(/setError\(null\);\s*\n\s*\/\/ 换文件才作废未决的保存告警/);
    expect(SOURCE).toMatch(/setStatus\(''\);\s*\n\s*setFirstFileShown\(true\)/);
  });
});

describe('去重后的占位恒定：瞬时态出现/回落不再推着右簇横移', () => {
  /**
   * 取「选择器列表里有一项与 selector 逐字相等」的**全部**规则体。
   * 为什么不抄 `shell-info-design` 的 `lastRuleBody`：这一族的声明散在两条规则里
   * （`.editor-status` 基档 + 文件末尾覆盖块的 `order`），级联终值是**并集**而非"最后一条"，
   * 只看最后一条会把它没写的那几档误读成"没做"。逐字比对也顺手排掉
   * `.editor-toolbar > .editor-status` 被 `.editor-status` 当子串捞走的误命中。
   */
  function ruleBodies(css: string, selector: string): string[] {
    const out: string[] = [];
    const re = /([^{}]*)\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css)) !== null) {
      const preludeRaw = m[1] ?? '';
      const body = m[2] ?? '';
      const prelude = preludeRaw.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      const parts = prelude.split(',').map((s) => s.replace(/\s+/g, ' ').trim());
      if (parts.includes(selector)) out.push(body);
    }
    return out;
  }
  /** 合并各档声明 + 断言"这条选择器确实在表上"（捞空即红，不许静默通过） */
  function merged(selector: string): string {
    const bodies = ruleBodies(STYLES, selector);
    expect(bodies.length, `样式表里没有这条选择器：${selector}`).toBeGreaterThan(0);
    return bodies.join('\n');
  }

  it('.editor-status 右簇给元信息空档留恒定占位（min-width 非 0）', () => {
    const body = merged('.editor-toolbar > .editor-status');
    expect(body).toMatch(/min-width:\s*[^0;]/);
    expect(body).not.toMatch(/min-width:\s*0\s*[;}]/);
  });

  it('错误位吃语义色 + 字重（不再与灰掉的事实同灰度）；瞬时态比元信息亮一档', () => {
    expect(merged('.editor-status-error')).toMatch(/color:\s*var\(--danger\)/);
    expect(merged('.editor-status-error')).toMatch(/font-weight:/);
    expect(merged('.editor-status-flash')).toMatch(/color:\s*var\(--fg\)/);
    expect(merged('.editor-status')).toMatch(/color:\s*var\(--fg-dim\)/);
  });

  it('脏点与通知徽章都给恒定占位宽（插拔不再推着整条工具条横移）', () => {
    expect(merged('.dirty-dot')).toMatch(/width:\s*13px/);
    expect(merged('.erb-mode-notice')).toMatch(/min-width:/);
  });
});
