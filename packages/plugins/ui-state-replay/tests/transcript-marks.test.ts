/**
 * 台词可见性内联上屏的账（KW-14，2026-11-03；零 React，合成数据）。
 *
 * 钉四组事：
 * 1. **四档口径**——契约三值 + `maybe` 的可约性两读分成「会说 / 不会说 / 看情况 / 判不出」，
 *    机器码逐字留在悬停文本里（报障能贴），第一句是白话；
 * 2. **列区间**——标注落在「动词起、行尾收」那一段，认不出动词时退回整行；
 * 3. **三道失效闸**——未存盘 / 文本已变 / 还没证明同源，一律**整档撤标并留一行说明**，
 *    绝不返回空装饰冒充「这段没有台词」（铁律 4）；
 * 4. **接线形状**——贡献确实注册在 `ui.editor.decorator` 上（id / order），
 *    并且确实订阅了缓冲真相与项目关闭两条腿（缺一条就会拿旧盘真相画新文本）。
 *
 * 真实的"画到屏上了"不在这条文件里自证：那部分走调试宿取证（DOM + 截图），
 * 读数记在提交信息里。
 */

import { describe, expect, it } from 'vitest';
import type {
  EditorDecoratorContribution,
  FunctionReplay,
  PluginContext,
  ReplayStateView,
  SlotRegistry,
  TranscriptLine,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import {
  TRANSCRIPT_DECORATOR_ID,
  TRANSCRIPT_DECORATOR_ORDER,
  createTranscriptMarkStore,
  digestText,
  projectTranscriptMarks,
  transcriptMarkMessage,
  transcriptMarkTier,
} from '../src/transcript-marks';
import { createUiStateReplayPlugin } from '../src/index';

/* ───────────────────────────── 合成数据 ───────────────────────────── */

const FILE = 'C:/game/ERB/MESSAGE/K7.C[1].ERB';
const ARCHIVE = 'C:/game/save/123.sav';

function transcriptLine(over: Partial<TranscriptLine> = {}): TranscriptLine {
  return {
    line: 3,
    verb: 'PRINTL',
    visibility: 'shown',
    payload: 'こんにちは',
    text: 'こんにちは',
    unresolved: 0,
    ...over,
  };
}

function viewOf(): ReplayStateView {
  return {
    characterNo: 7,
    characterName: '凛',
    archivePath: ARCHIVE,
    read: () => ({ kind: 'unknown', unknown: { code: 'opaque', message: '合成视图不读变量' } }),
  };
}

function replayOf(transcript: TranscriptLine[] | undefined, startLine = 2): FunctionReplay {
  return {
    normalizedName: 'K7_MESSAGE_A',
    filePath: FILE,
    startLine,
    predicates: [],
    branches: [],
    stats: { total: 0, hit: 0, miss: 0, unknown: 0 },
    confidence: 'exact',
    ...(transcript ? { transcript } : {}),
  };
}

/** 一条函数体的缓冲文本（第 2 行是函数头，台词落在 3–5 行） */
const BUFFER = ['#FUNCTION K7_MESSAGE_A', 'IF CFLAG:7 > 50', 'PRINTL こんにちは', 'PRINTFORMW さようなら', 'ENDIF'];

const store = () => createTranscriptMarkStore({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } });

/** 发布一份"能上屏"的台账：先喂一条干净缓冲真相，再 publish（顺序 = 真实面板里文件已在编辑器中） */
function publishMarked(lines: TranscriptLine[]): ReturnType<typeof store> {
  const s = store();
  s.observeDocument({ filePath: FILE, text: BUFFER.join('\n'), dirty: false });
  s.publish(replayOf(lines), viewOf());
  return s;
}

/* ───────────────────────────── ① 四档 ───────────────────────────── */

describe('台词行内标注：四档口径', () => {
  it('shown / hidden 直取契约可见性', () => {
    expect(transcriptMarkTier(transcriptLine({ visibility: 'shown' }))).toBe('shown');
    expect(transcriptMarkTier(transcriptLine({ visibility: 'hidden' }))).toBe('hidden');
  });

  it('maybe 按契约的可约性两读分开：真随机⇒判不出，能力缺口⇒看情况', () => {
    const rand = transcriptLine({
      visibility: 'maybe',
      reason: { code: 'pseudo', message: '伪变量（运行期计算值）：RAND' },
    });
    const call = transcriptLine({ visibility: 'maybe', reason: { code: 'call', message: '不执行函数调用' } });
    expect(transcriptMarkTier(rand)).toBe('undecidable');
    expect(transcriptMarkTier(call)).toBe('conditional');
  });

  it('maybe 没有原因 ⇒ 不猜成"会说"，按看情况呈现', () => {
    expect(transcriptMarkTier(transcriptLine({ visibility: 'maybe' }))).toBe('conditional');
  });

  it('悬停第一句是白话四档之一', () => {
    const entry = {
      functionName: 'K7_MESSAGE_A',
      archivePath: ARCHIVE,
      characterNo: 7,
      characterName: '凛',
    };
    for (const [line, first] of [
      [transcriptLine({ visibility: 'shown' }), '会说'],
      [transcriptLine({ visibility: 'hidden', reason: { code: 'opaque', message: '第 2 行的分支走了别处' } }), '不会说'],
      [transcriptLine({ visibility: 'maybe', reason: { code: 'call', message: '不执行函数调用' } }), '看情况'],
      [
        transcriptLine({ visibility: 'maybe', reason: { code: 'pseudo', message: '伪变量（运行期计算值）：RAND' } }),
        '判不出',
      ],
    ] as const) {
      expect(transcriptMarkMessage(line, entry).startsWith(first)).toBe(true);
    }
  });

  it('机器码逐字留在悬停里，且说明「为什么 + 该怎么办」都在', () => {
    const entry = { functionName: 'K7_MESSAGE_A', archivePath: ARCHIVE, characterNo: 7, characterName: '凛' };
    const msg = transcriptMarkMessage(
      transcriptLine({ visibility: 'maybe', reason: { code: 'dynamic-index', message: '动态索引算不出' }, guardLine: 2 }),
      entry,
    );
    expect(msg).toContain('dynamic-index');
    expect(msg).toContain('为什么');
    expect(msg).toContain('该怎么办');
    expect(msg).toContain('不代表这句会说');
  });

  it('判不出那一档说的是人话：不把它推给"再补能力"，也不说成编辑器坏了', () => {
    const entry = { functionName: 'K7_MESSAGE_A', archivePath: ARCHIVE, characterNo: 7, characterName: '凛' };
    const msg = transcriptMarkMessage(
      transcriptLine({ visibility: 'maybe', reason: { code: 'pseudo', message: '伪变量（运行期计算值）：RAND' } }),
      entry,
    );
    expect(msg).toContain('真随机');
    expect(msg).toContain('这不是编辑器判错');
    expect(msg).not.toContain('把场景参数补全');
  });

  it('标注自报是哪一次推演（函数 × 角色 × 存档短名，路径不占屏）', () => {
    const entry = { functionName: 'K7_MESSAGE_A', archivePath: ARCHIVE, characterNo: 7, characterName: '凛' };
    const msg = transcriptMarkMessage(transcriptLine(), entry);
    expect(msg).toContain('K7 凛');
    expect(msg).toContain('123.sav');
    expect(msg).toContain('K7_MESSAGE_A');
    expect(msg).not.toContain('C:/game/save');
  });

  it('判不出的插值补一句 %?%（有才算，0 处不啰嗦）', () => {
    const entry = { functionName: 'K7_MESSAGE_A', archivePath: ARCHIVE, characterNo: 7, characterName: '凛' };
    expect(transcriptMarkMessage(transcriptLine({ unresolved: 2 }), entry)).toContain('2 处内容判不出');
    expect(transcriptMarkMessage(transcriptLine({ unresolved: 0 }), entry)).not.toContain('处内容判不出');
  });
});

/* ───────────────────────────── ② 列区间 ───────────────────────────── */

describe('台词行内标注：落点列区间', () => {
  it('落在「动词起、行尾收」那一段（1 基、终点半开）', () => {
    const s = publishMarked([transcriptLine({ line: 3, verb: 'PRINTL', payload: 'こんにちは' })]);
    const [deco] = s.decorate({ path: FILE, text: BUFFER.join('\n') });
    expect(deco?.line).toBe(3);
    expect(deco?.startColumn).toBe(1);
    expect(deco?.endColumn).toBe('PRINTL こんにちは'.length + 1);
    expect(deco?.severity).toBe('info');
  });

  it('同行 SIF 守卫：区间从语句动词起，不吞掉条件', () => {
    const text = ['#FUNCTION K7_MESSAGE_A', 'IF CFLAG:7 > 50', 'SIF CFLAG:1 PRINTL こんにちは'].join('\n');
    const s = store();
    s.observeDocument({ filePath: FILE, text, dirty: false });
    // 同行 SIF 不需要 `guardLine`：守卫就在这一行里，列位由正文里的动词位置现算（`sentenceColumns`）。
    s.publish(replayOf([transcriptLine({ line: 3, verb: 'PRINTL' })]), viewOf());
    const [deco] = s.decorate({ path: FILE, text });
    expect(deco?.startColumn).toBe('SIF CFLAG:1 '.length + 1);
  });

  it('行里认不出动词 ⇒ 退回整行装饰（不猜列）', () => {
    const lines = [transcriptLine({ line: 3, verb: 'PRINTW' })];
    const s = store();
    const text = BUFFER.join('\n');
    s.observeDocument({ filePath: FILE, text, dirty: false });
    // 第 3 行是 `PRINTL …`，记的动词却是 PRINTW ⇒ 列认不出，但整档仍然上屏
    s.publish(replayOf(lines), viewOf());
    const [deco] = s.decorate({ path: FILE, text });
    expect(deco?.startColumn).toBeUndefined();
    expect(deco?.endColumn).toBeUndefined();
  });
});

/* ───────────────────────────── ③ 三道失效闸 ───────────────────────────── */

describe('台词行内标注：宁撤勿错（三道闸都不许静默）', () => {
  it('正常路径：文本同源且干净 ⇒ 逐行上屏，条数 = 台词行数', () => {
    const lines = [
      transcriptLine({ line: 3, visibility: 'shown' }),
      transcriptLine({ line: 4, visibility: 'hidden', reason: { code: 'opaque', message: '第 2 行的分支走了别处' } }),
    ];
    const s = publishMarked(lines);
    const r = s.statusFor(FILE, BUFFER.join('\n'));
    expect(r.status).toBe('marked');
    expect(r.marks).toBe(2);
    expect(r.decorations).toHaveLength(2);
  });

  it('没推演过的文件 ⇒ none + 空装饰（什么都没说，不是"没有台词"）', () => {
    const s = store();
    const r = s.statusFor('C:/other.erb', 'PRINTL x');
    expect(r.status).toBe('none');
    expect(r.decorations).toEqual([]);
  });

  it('推演没给台词区 ⇒ 一行说明，绝不空手（契约明说缺省不等于没有台词）', () => {
    const s = store();
    const text = BUFFER.join('\n');
    s.observeDocument({ filePath: FILE, text, dirty: false });
    s.publish(replayOf(undefined), viewOf());
    const r = s.statusFor(FILE, text);
    expect(r.status).toBe('no-transcript');
    expect(r.decorations).toHaveLength(1);
    expect(r.decorations[0]?.severity).toBe('info');
    expect(r.decorations[0]?.message).toContain('这不代表这一段没有会说的话');
    expect(r.decorations[0]?.line).toBe(2);
  });

  it('发布时有未存盘改动 ⇒ 整档撤标 + 一行说明', () => {
    const s = store();
    const text = BUFFER.join('\n');
    s.observeDocument({ filePath: FILE, text, dirty: true });
    s.publish(replayOf([transcriptLine()]), viewOf());
    const r = s.statusFor(FILE, text);
    expect(r.status).toBe('dirty-buffer');
    expect(r.marks).toBe(0);
    expect(r.decorations).toHaveLength(1);
    expect(r.decorations[0]?.severity).toBe('warning');
    expect(r.decorations[0]?.message).toContain('没存盘');
  });

  it('发布之后打了字（缓冲 dirty）⇒ 撤标', () => {
    const s = publishMarked([transcriptLine()]);
    const edited = BUFFER.map((l) => (l === 'PRINTL こんにちは' ? 'PRINTL こんばんは' : l)).join('\n');
    s.observeDocument({ filePath: FILE, text: edited, dirty: true });
    const r = s.statusFor(FILE, edited);
    expect(r.status).toBe('dirty-buffer');
    expect(r.decorations[0]?.message).toContain('撤下了');
  });

  it('发布之后改了又存盘（干净但文本已变）⇒ 按"文本已变"撤标', () => {
    const s = publishMarked([transcriptLine()]);
    const edited = BUFFER.map((l) => (l === 'PRINTL こんにちは' ? 'PRINTL こんばんは' : l)).join('\n');
    s.observeDocument({ filePath: FILE, text: edited, dirty: false });
    const r = s.statusFor(FILE, edited);
    expect(r.status).toBe('text-changed');
    expect(r.decorations[0]?.message).toContain('自那次推演之后已经改动过');
  });

  it('同长度替换也分得开（指纹含长度 + 双路滚动和）', () => {
    const a = digestText('PRINTL こんにちは');
    const b = digestText('PRINTL こんばんは');
    expect(a.length).toBe(b.length);
    expect(a.a === b.a && a.b === b.b).toBe(false);
  });

  it('推演发生在文件没进编辑器时 ⇒ 先"还没证明同源"，进来后（干净）采信并上屏', () => {
    const s = store();
    s.publish(replayOf([transcriptLine()]), viewOf());
    const text = BUFFER.join('\n');
    const pending = s.statusFor(FILE, text);
    expect(pending.status).toBe('awaiting-truth');
    expect(pending.decorations[0]?.severity).toBe('info');
    expect(pending.decorations[0]?.message).toContain('先不上屏');
    // 文件进编辑器：宿主补发一条干净真相 ⇒ 这一版与盘上同源，可以采信
    s.observeDocument({ filePath: FILE, text, dirty: false });
    expect(s.statusFor(FILE, text).status).toBe('marked');
  });

  it('采信之前中间出现过未存盘改动 ⇒ 永久不再采信（存的盘已经是另一份了）', () => {
    const s = store();
    s.publish(replayOf([transcriptLine()]), viewOf());
    const text = BUFFER.join('\n');
    s.observeDocument({ filePath: FILE, text: 'DIRTY', dirty: true });
    s.observeDocument({ filePath: FILE, text, dirty: false });
    expect(s.statusFor(FILE, text).status).toBe('awaiting-truth');
  });

  it('路径判等走 pathKey（Windows 折叠大小写不静默判不上）', () => {
    const s = publishMarked([transcriptLine()]);
    const text = BUFFER.join('\n');
    s.observeDocument({ filePath: FILE.toLowerCase(), text, dirty: false });
    const r = s.statusFor(FILE.toLowerCase(), text);
    expect(r.status).toBe('marked');
    expect(r.marks).toBe(1);
  });

  it('关掉一份文件 ⇒ 标注随 model 走，重开前什么都不说', () => {
    const s = publishMarked([transcriptLine()]);
    s.forget(FILE);
    expect(s.statusFor(FILE, BUFFER.join('\n')).status).toBe('none');
  });

  it('台账有上限（LRU）：只留最近推演的那几份，正文一概不存', () => {
    const s = createTranscriptMarkStore({
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      maxFiles: 2,
    });
    for (const p of ['a.erb', 'b.erb', 'c.erb']) {
      const text = `X ${p}`;
      s.observeDocument({ filePath: p, text, dirty: false });
      s.publish({ ...replayOf([transcriptLine()]), filePath: p }, viewOf());
      void text;
    }
    expect(s.stats().files).toBe(2);
    expect(s.statusFor('a.erb', 'X a.erb').status).toBe('none');
    expect(s.statusFor('c.erb', 'X c.erb').status).toBe('marked');
  });

  it('清账（换项目）之后：条数、次数、状态读数一起归零', () => {
    const s = publishMarked([transcriptLine(), transcriptLine({ line: 4 })]);
    s.decorate({ path: FILE, text: BUFFER.join('\n') });
    expect(s.stats()).toEqual({ files: 1, publishes: 1, lastStatus: 'marked', lastMarks: 2 });
    s.clear();
    expect(s.stats()).toEqual({ files: 0, publishes: 0, lastStatus: 'none', lastMarks: 0 });
  });

  it('纯投影函数与 store 同一把尺（同一 entry 两边给出同一份装饰）', () => {
    const s = publishMarked([transcriptLine()]);
    const text = BUFFER.join('\n');
    const viaStore = s.decorate({ path: FILE, text });
    const entry = s.publish(replayOf([transcriptLine()]), viewOf());
    const viaPure = projectTranscriptMarks({ entry, text, bufferDirty: false });
    expect(viaPure.decorations.map((d) => d.message)).toEqual(viaStore.map((d) => d.message));
    expect(viaPure.status).toBe('marked');
  });
});

/* ───────────────────────────── ④ 接线形状 ───────────────────────────── */

describe('台词行内标注：确实接在既有装饰通道上', () => {
  /** 起真插件，收 `ui.editor.decorator` 贡献 + 记订阅了哪些内核事件 */
  function activate(): {
    decorators: EditorDecoratorContribution[];
    events: string[];
    emit: (event: string, payload: unknown) => void;
  } {
    const decorators: EditorDecoratorContribution[] = [];
    const events: string[] = [];
    const handlers = new Map<string, (payload: never) => void>();
    const slots = {
      register: (slot: string, item: unknown) => {
        if (slot === 'ui.editor.decorator') decorators.push(item as EditorDecoratorContribution);
        return () => {};
      },
      query: () => [],
    } as unknown as SlotRegistry;
    const ctx = {
      pluginId: 'ui-state-replay',
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      bus: {
        on: (event: string, handler: (payload: never) => void) => {
          events.push(event);
          handlers.set(`${event}:${handlers.size}`, handler as (payload: never) => void);
          return () => {};
        },
        once: () => () => {},
        emit: () => {},
      },
      storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
      slots,
      provide: () => {},
      inject: <T = unknown,>(key: string): T => {
        if (key === KernelServices.Project) return { current: () => null } as unknown as T;
        if (key === KernelServices.Slots) return slots as unknown as T;
        if (key === WellKnownServices.SnapshotSource) return { scan: async () => ({ entries: [] }) } as unknown as T;
        return {} as unknown as T;
      },
      tryInject: <T = unknown,>(): T | undefined => undefined,
      onDispose: () => {},
    } as unknown as PluginContext;
    createUiStateReplayPlugin().activate!(ctx);
    return {
      decorators,
      events,
      emit: (event, payload) => {
        for (const [k, h] of handlers) if (k.startsWith(`${event}:`)) h(payload as never);
      },
    };
  }

  it('贡献注册在 ui.editor.decorator，id 与 order 在册', () => {
    const { decorators } = activate();
    const mine = decorators.find((d) => d.id === TRANSCRIPT_DECORATOR_ID);
    expect(mine).toBeDefined();
    expect(mine?.title).toBe('台词可见性内联标注');
    expect(mine?.order).toBe(TRANSCRIPT_DECORATOR_ORDER);
    expect(typeof mine?.decorate).toBe('function');
    // 没推演过时这条路什么都不画（但"没画"由面板那侧的空态说，不靠装饰器冒充）
    expect(mine?.decorate({ path: FILE, text: BUFFER.join('\n'), project: null })).toEqual([]);
  });

  it('缓冲真相与项目关闭两条腿都订阅了（缺一条就会拿旧盘真相画新文本）', () => {
    const { events } = activate();
    expect(events).toContain('editor.documentChanged');
    expect(events).toContain('project.closed');
  });

  it('关项目 ⇒ 上一盘的标注不是这一盘的真相（贡献立刻回到不画）', () => {
    const h = activate();
    // 这条只验"事件真的打到插件里且不炸"——清账本体在 store 的单元测试里钉
    expect(() => h.emit('project.closed', { rootDir: 'C:/game' })).not.toThrow();
    expect(() =>
      h.emit('editor.documentChanged', { filePath: FILE, text: BUFFER.join('\n'), dirty: false }),
    ).not.toThrow();
    expect(h.decorators.find((d) => d.id === TRANSCRIPT_DECORATOR_ID)?.decorate({ path: FILE, text: '', project: null })).toEqual([]);
  });
});
