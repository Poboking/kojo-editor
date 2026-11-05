/**
 * 状态回放批（2026-11-05）：`editor.documentChanged` 这条宿主通道的**取证与加固**。
 *
 * 为什么另立一枚文件：`document-broadcast.test.ts` 钉的是 C2 批的三条语义（防抖 / 去重 /
 * 抑制），`ps5-broadcast-digest.test.ts` 钉指纹判据。本文件钉的是**面板侧消费口径**——
 * 状态回放面板要把"当前文件最新缓冲文本"交给 `ReplayFunctionOptions.textOverride`，
 * 它的判据只有一句："判定那一刻手上的文本是不是最新的"。所以这里逐条钉住：
 *
 * ① 防抖窗口内多拍变更合并成一条，落地文本 = **最后一拍**（面板看不到中间态）；
 * ② 切文件 / 首开：立即 flush，且上一份文件的在途排程**作废**（B 上不出现 A 的迟到文本）；
 * ③ 失焦补发 `refresh`：文本变了立即发、没变一个字节都不发（面板点「判定」那一刻新鲜）；
 * ④ `text` 逐字保真（中文 / CRLF / 制表符 / 星平面字符 / 行尾空行都原样）；
 * ⑤ `dirty` 原样透传，且"文本没变只翻 dirty"不发（保存后不广播——消费方不得依赖）；
 * ⑥ 派生视图（糖视图）抑制 + 切回原码立即补发；
 * ⑦ 接线形状（仓里没有挂载设施，形状面按 `ps5-editor-pane-wiring.test.ts` 的既定口径钉）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentBroadcastPayload } from '../src/ui/document-broadcast';
import { DOCUMENT_BROADCAST_DEBOUNCE_MS, createDocumentBroadcaster } from '../src/ui/document-broadcast';

const SOURCE = readFileSync(fileURLToPath(new URL('../src/ui/EditorPane.tsx', import.meta.url)), 'utf8');
const BROADCAST = readFileSync(
  fileURLToPath(new URL('../src/ui/document-broadcast.ts', import.meta.url)),
  'utf8',
);

afterEach(() => {
  vi.useRealTimers();
});

function collect() {
  const sent: DocumentBroadcastPayload[] = [];
  return { sent, emit: (p: DocumentBroadcastPayload) => sent.push(p) };
}

/* ---------------- 形状判据的锚点工具（两端自证，缺锚点当场红，不做静默假绿） ---------------- */

function anchor(source: string, needle: string): number {
  const i = source.indexOf(needle);
  expect(i, `锚点缺失：「${needle}」`).toBeGreaterThanOrEqual(0);
  return i;
}

function between(source: string, from: string, to: string): string {
  const start = anchor(source, from);
  const end = source.indexOf(to, start + from.length);
  expect(end, `结束锚点缺失或早于起点：「${to}」`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/* ==================== ① 防抖窗口：多拍合并，落地即最新 ==================== */

describe('① 防抖窗口（面板在窗口内看到的永远是"上一拍"，窗口后一次性拿最新）', () => {
  it('窗口内连续多拍 = 一条都不发；窗口落地那一条就是最后一拍的文本', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 300 });
    let text = '第一行\r\n';
    for (const t of ['第一行\r\n第二行', '第一行\r\n第二行！', '第一行\r\n第二行！！']) {
      text = t;
      b.schedule('C:\\proj\\口上\\K1.ERB', () => ({ text, dirty: true }));
      vi.advanceTimersByTime(100);
    }
    expect(sent).toHaveLength(0); // 三拍全在窗口内：面板此刻手上还是空/旧文本
    vi.advanceTimersByTime(199); // 距最后一拍排程 299ms
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1); // 300ms：落地
    expect(sent).toHaveLength(1);
    // 落地是**现取**的：中间两拍一个字都没漏出来，落地那条 = 最后一拍
    expect(sent[0]).toEqual({ filePath: 'C:\\proj\\口上\\K1.ERB', text: '第一行\r\n第二行！！', dirty: true });
  });

  it('默认窗口 = 300ms（面板新鲜度契约写的就是这个上界，改它等于改契约）', () => {
    expect(DOCUMENT_BROADCAST_DEBOUNCE_MS).toBe(300);
  });
});

/* ==================== ② 切文件 / 首开：立即发，旧文件在途作废 ==================== */

describe('② 切文件（面板切完立刻就该有真相，不必等窗口）', () => {
  it('切到 B：B 立即发出；A 的在途排程作废，B 上不会收到 A 的迟到文本', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 300 });
    b.schedule('C:\\proj\\A.ERB', () => ({ text: 'A 刚改的字', dirty: true }));
    b.flush('C:\\proj\\B.ERB', () => ({ text: 'B 的全文', dirty: false }));
    expect(sent).toEqual([{ filePath: 'C:\\proj\\B.ERB', text: 'B 的全文', dirty: false }]);
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1); // 没有 A 的迟到、也没有 B 的重复
  });

  it('首开 / 切回同一份文件：同文本也照发（面板晚于上次广播挂载时靠这一拍补真相）', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 300 });
    b.flush('C:\\proj\\B.ERB', () => ({ text: '同一份', dirty: false }));
    b.flush('C:\\proj\\B.ERB', () => ({ text: '同一份', dirty: false })); // 切走再切回
    expect(sent).toHaveLength(2); // flush 是显式断言，不走去重
  });

  it('切开着的文件时 read 给 null（model 已关/已替换）⇒ 整次作废，不拿残影当真相', () => {
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit });
    b.flush('C:\\proj\\X.ERB', () => null);
    expect(sent).toHaveLength(0);
  });
});

/* ==================== ③ 失焦补发（refresh）==================== */

describe('③ 失焦补发 refresh（面板点「判定」那一刻必须新鲜）', () => {
  it('窗口内又敲了一键后失焦：立即发出最新文本（不等 300ms）', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 300 });
    let text = 'CFLAG:0 = 1';
    b.schedule('C:\\proj\\K1.ERB', () => ({ text, dirty: true }));
    vi.advanceTimersByTime(120); // 窗口内
    text = 'CFLAG:0 = 1\r\nCFLAG:1 = 2'; // 用户刚敲的那一行
    b.refresh('C:\\proj\\K1.ERB', () => ({ text, dirty: true })); // 失焦（点面板判定）
    expect(sent).toEqual([
      { filePath: 'C:\\proj\\K1.ERB', text: 'CFLAG:0 = 1\r\nCFLAG:1 = 2', dirty: true },
    ]);
    // 在途排程已被这一拍作废：窗口到点不会再补一条重复的
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);
  });

  it('文本没变就一次失焦也不发（点一下外面就是一次失焦，空转广播会让吃全文的面板白重算）', () => {
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit });
    b.flush('p.kojo', () => ({ text: '同一份', dirty: false }));
    for (let i = 0; i < 5; i++) b.refresh('p.kojo', () => ({ text: '同一份', dirty: false }));
    expect(sent).toHaveLength(1);
    b.refresh('p.kojo', () => ({ text: '同一份+', dirty: true }));
    expect(sent).toHaveLength(2); // 真变了才发
  });

  it('refresh 与 flush 共用同一把 pathKey 尺子（分隔符 / 大小写不同的同一份文件仍去重）', () => {
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit });
    b.flush('C:\\Proj\\口上\\A.ERB', () => ({ text: 'T', dirty: false }));
    b.refresh('c:/proj/口上/a.erb', () => ({ text: 'T', dirty: false })); // 面板若按裸字符串比，这里会多发一条
    expect(sent).toHaveLength(1);
  });
});

/* ==================== ④ text 逐字保真 ==================== */

describe('④ text 是 Monaco 缓冲原文：中文 / CRLF / 制表符 / 星平面 / 行尾空行都原样', () => {
  /** 真实口上文件形态：CRLF + 全角标点 + 制表符 + emoji（代理对）+ 两个行尾空行 */
  const TEXT = '；角色：\r\n\t#DIM 名前, 0, 10\r\n「おはよう」🚀 你好\r\n\r\n';

  it('防抖通道：载荷 text 与源逐字相等（长度也一样，不做任何归一/裁剪）', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 10 });
    b.schedule('C:\\proj\\K1.ERB', () => ({ text: TEXT, dirty: true }));
    vi.advanceTimersByTime(11);
    expect(sent).toHaveLength(1);
    const got = sent[0]!.text;
    expect(got).toBe(TEXT);
    expect(got.length).toBe(TEXT.length); // 代理对按码元计：emoji = 2
    expect(got.split('\r\n')).toHaveLength(5); // 行尾那两个空行没被吃掉
    expect(got.replace(/\r\n/g, '')).not.toContain('\n'); // CRLF 没被压成 LF
    expect(got.endsWith('\r\n\r\n')).toBe(true);
    expect(got).toContain('\t#DIM');
    expect(got).toContain('🚀');
  });

  it('立即通道（flush）同样逐字保真：面板拿到的不是"另一个版本"', () => {
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit });
    b.flush('C:\\proj\\K1.ERB', () => ({ text: TEXT, dirty: false }));
    expect(sent[0]!.text).toBe(TEXT);
  });

  it('只有行尾换行不同也算"变了"（面板不会拿少一个换行的文本去分行号）', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 10 });
    b.flush('p.kojo', () => ({ text: '台词\n', dirty: false }));
    b.schedule('p.kojo', () => ({ text: '台词\n\n', dirty: true }));
    vi.advanceTimersByTime(11);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toBe('台词\n\n');
  });
});

/* ==================== ⑤ dirty 真值语义 ==================== */

describe('⑤ dirty = 缓冲与盘上不同步（只是提示，不是"文本与盘一致"的证明）', () => {
  it('true / false 都原样进载荷', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 10 });
    b.flush('p.kojo', () => ({ text: 'a', dirty: true }));
    b.schedule('p.kojo', () => ({ text: 'ab', dirty: false }));
    vi.advanceTimersByTime(11);
    expect(sent.map((p) => p.dirty)).toEqual([true, false]);
  });

  it('保存（文本没变、只翻 dirty）不广播：消费方别拿"没收到 dirty=false"当异常', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    const b = createDocumentBroadcaster({ emit, delayMs: 10 });
    b.flush('p.kojo', () => ({ text: 'T', dirty: true }));
    b.schedule('p.kojo', () => ({ text: 'T', dirty: false })); // Ctrl+S：缓冲区一字未动
    vi.advanceTimersByTime(11);
    b.refresh('p.kojo', () => ({ text: 'T', dirty: false })); // 失焦那一拍同样不该发
    expect(sent).toHaveLength(1);
    expect(sent[0]!.dirty).toBe(true); // 面板手上那条 dirty 会一直停在 true —— 契约已知，别拿它判保存态
  });
});

/* ==================== ⑥ 派生视图抑制 + 切回补发 ==================== */

describe('⑥ 糖视图（derived 只读 model）抑制，切回原码立即补发', () => {
  it('抑制期：在途排程落地即丢、refresh 也不发；切回原码 flush 立即补一条', () => {
    vi.useFakeTimers();
    const { sent, emit } = collect();
    let suppressed = false;
    const b = createDocumentBroadcaster({ emit, suppressed: () => suppressed, delayMs: 300 });
    b.flush('p.kojo', () => ({ text: '原文', dirty: false }));
    expect(sent).toHaveLength(1);
    suppressed = true; // 挂上糖视图
    b.schedule('p.kojo', () => ({ text: '原文', dirty: false }));
    vi.advanceTimersByTime(300);
    b.refresh('p.kojo', () => ({ text: '万一变了', dirty: true }));
    expect(sent).toHaveLength(1); // 一条都不许发（派生文本不是文件真相）
    suppressed = false; // 切回原码
    b.refresh('p.kojo', () => ({ text: '原文', dirty: false })); // 与上次已发逐字相同
    expect(sent).toHaveLength(1); // 去重版：真相没变确实不必重发
    b.flush('p.kojo', () => ({ text: '原文', dirty: false })); // 切回原码走的是 flush
    expect(sent).toHaveLength(2); // 切回即补发（哪怕同文本）——面板不会停在"预览期无真相"
  });
});

/* ==================== ⑦ 接线形状（EditorPane 侧，仓里没有挂载设施）==================== */

describe('⑦ 宿主接线形状（切文件 / 首开 / 失焦 / 抑制 / 后台标签）', () => {
  it('切文件 effect：先 setModel 再 applySugarView（补发的是**新 model** 的文本）', () => {
    const sw = between(SOURCE, "const stopApply = perf.start('switch.apply');", 'stopApply();');
    expect(anchor(sw, 'ed.setModel(entry.model)')).toBeLessThan(anchor(sw, 'applySugarView();'));
  });

  it('applySugarView 里的 flush 在糖视图可用门**之前**：非糖 / 零段文件切过去同样立即补发', () => {
    const apply = between(SOURCE, 'const applySugarView = useCallback(', '// 开关变化：记住偏好');
    expect(apply).toContain('documentBroadcaster.flush(path, () => readDocumentTruth(path));');
    expect(anchor(apply, 'documentBroadcaster.flush(path')).toBeLessThan(anchor(apply, 'sugarViewAllowed({'));
    // 首开窗口里 entry 还没落账 ⇒ 整次作废（不拿残影冒充真相）
    expect(anchor(apply, 'if (!ed || !entry) return;')).toBeLessThan(anchor(apply, 'documentBroadcaster.flush(path'));
  });

  it('readDocumentTruth 走 entriesRef 的真 model：text = getValue()、dirty = computeDirty()', () => {
    const fn = between(SOURCE, 'const readDocumentTruth = useCallback(', 'const currentFileModel =');
    expect(fn).toContain('entriesRef.current.get(path)');
    expect(fn).toContain('entry.model.getValue()');
    expect(fn).toContain('computeDirty(path)');
    expect(fn).toContain('isDisposed()');
  });

  it('广播器：抑制谓词 = 糖 model 在场；ref 化 memo（跨拍存活，去重台账不重置）', () => {
    expect(SOURCE).toContain('suppressed: () => sugarModelRef.current !== null');
    expect(SOURCE).toContain('const documentBroadcaster = useMemo(');
    expect(SOURCE).toContain('useEffect(() => () => documentBroadcaster.dispose(), [documentBroadcaster]);');
  });

  it('脏监听只在**本 pane 的活动文件**上排程：后台标签的编辑不进总线（切过去由 flush 补）', () => {
    const fn = between(SOURCE, 'const makeDirtyListener = useCallback(', 'const readBuffer = useCallback(');
    const activeGate = anchor(fn, 'if (filePathRef.current === watchedPath)');
    expect(activeGate).toBeLessThan(anchor(fn, 'documentBroadcaster.schedule('));
    // 磁盘重载不是用户编辑：先早退，不排程（重载链自己 flush）
    expect(anchor(fn, 'if (reloadingRef.current) return;')).toBeLessThan(activeGate);
  });

  it('失焦补发挂在本 pane 的编辑器上，且在实例创建 effect 之后（否则 editorRef 还是 null）', () => {
    const blur = anchor(SOURCE, 'ed.onDidBlurEditorText(');
    expect(blur).toBeGreaterThan(anchor(SOURCE, 'useMonacoInstance({'));
    expect(SOURCE.slice(blur, blur + 400)).toContain('documentBroadcaster.refresh(path, () => readDocumentTruth(path))');
  });

  it('refresh 的实现：先作废在途排程，再去重发射（不产生第二条，也不空转）', () => {
    expect(BROADCAST).toContain('refresh(path: string, read: DocumentTruthReader): void;');
    const impl = between(BROADCAST, 'refresh(path: string, read: DocumentTruthReader): void {', 'forget(path: string)');
    expect(anchor(impl, 'cancelPending();')).toBeLessThan(anchor(impl, 'tryEmit(path, read, true);'));
  });
});
