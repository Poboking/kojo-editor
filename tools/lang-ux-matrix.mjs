#!/usr/bin/env node
/**
 * LANG-UX-MATRIX · 两语言「真壳体感」验收矩阵的**可执行骨架 + 读数采集器**。
 *
 * 背景（`docs/BOARD.md` 的 `LANG-UX-MATRIX`）：
 *   「两语言逐项（折叠/跳转/引用/重命名/补全/格式化/诊断/预览/大纲/面包屑/展开/peek）读数进 STATE；
 *     壳冒烟纳入 `release-gate --shell`」。
 *
 * 本工具只做两件事，**不写盘、不联网、不引依赖**：
 *
 * 1. **automated 面**：把 `monaco/language-capabilities.ts` 的能力矩阵当声明，逐项对**注册点源码**
 *    取证——注册行（`registerXxxProvider(<本语言 id> …)` / `registerForLanguageServices` 收口）、
 *    装配行（注册模块被 `ui/editor-global-providers.ts` import，模块写了没人调 = 死代码）、
 *    单测文件与 `it(...)` 名清单、`language-parity.test.ts` 的档位清单 / 豁免清单。
 *    取证方式是**读文件**（与 `language-parity.test.ts` / `ps10-eager-graph.test.ts` 同一路：
 *    真 Monaco 在 node 池里起不来，provider 挂载事实也不在它的公开读数里）。读不到 = FAIL，
 *    不猜绿；矩阵标 `{ exempt }` 的项记 SKIP，**理由逐字来自源码**（不许为了绿把失败标 skip）。
 *
 * 2. **manual 面**：逐语言 × 逐能力列出真壳人工步骤（折叠手感 / Peek / 引用面板 / 格式化光标 /
 *    snippet 插入…）与**要记进 STATE 的读数槽**。这些步骤不自动化，但必须存在且可执行。
 *
 * 真壳冒烟（`tools/smoke-tauri-dom.mjs` / `tools/smoke-tauri-ipc.mjs`）**默认不跑**：
 * 两者各要 ~100s / ~2min、弹窗、且 IPC 需要真实语料。加 `--shell` 才真跑，并把
 * `{ rc, ms, verdict, reason, tail }` 原样写进 `readings.shell`——失败就写**具体**原因
 * （端口占用 / 无桌面会话 / 无游戏语料 / 断言的哪一项没满足），绝不伪造通过。
 *
 * 用法：node tools/lang-ux-matrix.mjs [--json] [--shell] [--shell-timeout=<ms>] [--help]
 * 退出码：0 = automated 全绿（且 --shell 时冒烟全 pass）；1 = 有失败；2 = 用法错误。
 *
 * 红线（本批）：本文件与 `tools/tests/lang-ux-matrix.test.ts` 是仅有的新增文件；
 * 不改 `release-gate.mjs`、不改 app/core。接线请见文件末的 WIRING 注释。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const NODE = process.execPath;
const IS_WINDOWS = process.platform === 'win32';

/** JSON 报告形状版本（消费方按它认字段；加字段不升版，改语义才升） */
export const SCHEMA_VERSION = 1;

/* ============================== 两门一等语言 ============================== */

/**
 * 矩阵覆盖的语言 = `monaco/language-capabilities.ts` 的 `PARITY_LANGUAGE_IDS` 那两门。
 * `statusBlock` = 该语言在矩阵真源里的状态表常量名（本工具**读它**，不抄它的值）。
 * `sample` = 人工步骤里用来替换 `{sample}` 的语料形状（真壳验收时换成手上那份文件）。
 */
export const LANGUAGES = Object.freeze([
  Object.freeze({
    id: 'erb',
    label: 'ERB（.erb / .erm / .erh）',
    languageId: 'kojo-erb',
    statusBlock: 'ERB_CAPABILITY_STATUS',
    languageConst: 'ERB_LANGUAGE_ID',
    sample: '一份 .erb（含 IF/ENDIF、函数块）',
  }),
  Object.freeze({
    id: 'kojo2',
    label: 'Kojo 2.0（.kojo2）',
    languageId: 'kojo2',
    statusBlock: 'KOJO2_CAPABILITY_STATUS',
    languageConst: 'KOJO2_LANGUAGE_ID',
    sample: '一份 .kojo2（含场景 / 函数块）',
  }),
]);

/* ============================== 能力检查表 ============================== */

/**
 * 能力清单 = `LanguageCapability` 枚举的 20 项 + 1 项**宿主自绘**面（`breadcrumb`）。
 *
 * 为什么把面包屑单列：它不在 Monaco 能力枚举里（standalone 0.57 没有 breadcrumb API，
 * 见 `ui/breadcrumb-path.ts` 头注），但 BOARD 的体感矩阵点名要它——所以它是「host」档，
 * 取证看 `ui/editor-pane/use-breadcrumb.ts` 的两条语言分支，而不是看 provider 注册行。
 *
 * `providerApi` 是 Monaco 注册 API（`builtin` / 宿主面为 null）；
 * `unitTests[lang]` 是覆盖该能力的单测文件（本工具断言文件在且真有 `it(...)`）；
 * `manual` 是真壳人工步骤（`{sample}` 会按语言替换），`expected` 是读数的槽位说明。
 */
export const CAPABILITIES = Object.freeze([
  spec({
    id: 'folding',
    label: '折叠',
    providerApi: 'registerFoldingRangeProvider',
    unitTests: {
      erb: ['packages/app/tests/kojo-folding.test.ts'],
      kojo2: ['packages/app/tests/kojo2-folding-indent.test.ts'],
    },
    manual: {
      steps: [
        '打开{sample}，把光标放进一个 IF/ENDIF 块（或函数块）内',
        '按 Ctrl+Shift+[ 折叠该块，再按 Ctrl+Shift+] 展开；连续折 3 层后滚动一屏',
        '折叠态下切标签再切回，观察折叠标记与光标/滚动位置',
      ],
      expected: '折叠区间数与层级、折叠/展开耗时、光标与滚动位置不跳（读数进 STATE）',
    },
  }),
  spec({
    id: 'outline',
    label: '大纲',
    providerApi: 'registerDocumentSymbolProvider',
    unitTests: {
      erb: ['packages/app/tests/kojo-symbols.test.ts'],
      kojo2: ['packages/app/tests/kojo2-symbols.test.ts'],
    },
    manual: {
      steps: [
        '打开{sample}，按 Ctrl+Shift+O 打开「转到本文件符号」',
        '看层级：场景/函数/标签是否成树，点第 3 项是否能落到对应行',
        '在文件中部再打开一次，确认列表与光标位置、面包屑一致',
      ],
      expected: '大纲项数/层级深度/点击落点行号（读数进 STATE）',
    },
  }),
  spec({
    id: 'format',
    label: '格式化',
    providerApi: 'registerDocumentFormattingEditProvider',
    unitTests: {
      erb: ['packages/app/tests/kojo-format.test.ts'],
      kojo2: ['packages/app/tests/kojo2-format.test.ts'],
    },
    manual: {
      steps: [
        '打开{sample}，故意把两三行的缩进与空行打乱',
        'Shift+Alt+F 格式化整篇；观察光标是否留在原逻辑位置、是否出现「已格式化」提示',
        'Ctrl+Z 一步撤回，确认整篇回到格式化前（不是只回退某一段）',
      ],
      expected: '格式化前后光标行/列、单步撤销是否整体回退、有无降级提示（读数进 STATE）',
    },
  }),
  spec({
    id: 'semantic',
    label: '语义着色',
    providerApi: 'registerDocumentSemanticTokensProvider',
    unitTests: {
      erb: ['packages/app/tests/kojo-semantic-tokens.test.ts'],
      kojo2: ['packages/app/tests/kojo2-semantic.test.ts'],
    },
    manual: {
      steps: [
        '打开{sample}，看函数名 / 关键字 / 字符串 / 数字四类颜色是否分得开',
        '切到另一主题档（设置页「主题」）再切回，确认着色不丢、不闪成纯文本',
        '改一行文本，停笔后看新记号是否在 1s 内重新上色',
      ],
      expected: '四类记号的配色族、切主题后着色保留、改后重着色时延（读数进 STATE）',
    },
  }),
  spec({
    id: 'indent',
    label: '缩进 / 回车层级',
    providerApi: 'registerOnTypeFormattingEditProvider',
    unitTests: {
      erb: ['packages/app/tests/kojo2-indent-brackets.test.ts'],
      // B3i：回车层级判据（块头 / 同级容器 / `@原生` 围栏 / 栅格 / 夹具 / CRLF）整块搬进包，
      // 宿主那份只剩 on-type 翻译与注册；两处都登记，能力面判据与装配面各有一份证据。
      kojo2: [
        'packages/app/tests/kojo2-folding-indent.test.ts',
        'packages/kojo-lang/tests/indent.test.ts',
      ],
    },
    manual: {
      steps: [
        '打开{sample}，在 IF 行末回车，看新行缩进是否进一级',
        '在块内再回车两次、然后 Delete 退到上一层，观察缩进是否跟着退',
        '选中多行按 Tab / Shift+Tab，确认整段同进同退且不吞字符',
      ],
      expected: '回车后缩进层级（空格数）、退格回退层级、多行 Tab 的位移（读数进 STATE）',
    },
  }),
  spec({
    id: 'brackets',
    label: '括号配对',
    providerApi: null,
    unitTests: {
      erb: ['packages/app/tests/language-parity.test.ts'],
      kojo2: ['packages/app/tests/kojo2-indent-brackets.test.ts'],
    },
    manual: {
      steps: [
        '打开{sample}，输入 IF( 或「，看右半是否自动补上',
        '把光标放到某个右括号上，确认配对的左括号同亮（colorizedBracketPairs）',
        '删掉配对中的一半，观察是否只删一个字符、不连带吞掉整对',
      ],
      expected: '自动补对、配对高亮、删除行为（读数进 STATE）',
    },
  }),
  spec({
    id: 'refs',
    label: '引用',
    providerApi: 'registerReferenceProvider',
    unitTests: {
      erb: ['packages/app/tests/find-references.test.ts'],
      kojo2: ['packages/app/tests/kojo2-references.test.ts'],
    },
    manual: {
      steps: [
        '打开{sample}，把光标放在函数名 / 标签名上按 Shift+F12',
        '看引用面板条数与分组：同文件 / 跨文件是否标清，点一条能否跳过去',
        '对同一符号再按一次，确认取消勾选/重开面板不残留旧结果',
      ],
      expected: '引用条数、同文件/跨文件分组、点击落点、面板重开是否干净（读数进 STATE）',
    },
  }),
  spec({
    id: 'rename',
    label: '重命名',
    providerApi: 'registerRenameProvider',
    unitTests: {
      erb: ['packages/app/tests/erb-rename.test.ts'],
      kojo2: ['packages/app/tests/kojo2-rename.test.ts'],
    },
    manual: {
      steps: [
        '打开{sample}，在函数名 / 标签上按 F2，输入新名后回车',
        '确认所有该改的出现点都改了、不该改的散文/成员名没被卷进来',
        'Ctrl+Z 一步撤回，确认整个重命名（含跨文件）一起回退',
      ],
      expected: '改动点数、误改数、单步撤销是否整体回退（读数进 STATE）',
    },
  }),
  spec({
    id: 'signature',
    label: '签名帮助',
    providerApi: 'registerSignatureHelpProvider',
    unitTests: {
      erb: ['packages/app/tests/kojo-signature.test.ts'],
      kojo2: ['packages/app/tests/kojo2-signature.test.ts'],
    },
    manual: {
      steps: [
        '打开{sample}，在 CALL 行的左括号后停住，看签名浮层是否弹出',
        '输入逗号推进到下一个参数，看当前参数高亮是否跟着走',
        '按 Esc 收起后再打一个字符，确认浮层能再次弹出（不是一次性的）',
      ],
      expected: '浮层参数列表、当前参数高亮位置、重开能力（读数进 STATE）',
    },
  }),
  spec({
    id: 'inlay',
    label: '行内提示（inlay）',
    providerApi: 'registerInlayHintsProvider',
    unitTests: {
      erb: ['packages/app/tests/kojo-inlay-hints.test.ts'],
      kojo2: ['packages/app/tests/kojo2-inlay.test.ts'],
    },
    manual: {
      steps: [
        '打开{sample}，看 CALL 行的参数位置是否出现灰色参数名',
        '把光标移进该行 / 选中该行，确认 inlay 按设置让位（不与正文重叠）',
        '改一个参数值，确认灰字跟着重算且不闪成两行',
      ],
      expected: 'inlay 枚数、让位行为、改值后重算时延（读数进 STATE）',
    },
  }),
  spec({
    id: 'codelens',
    label: 'Code Lens',
    providerApi: 'registerCodeLensProvider',
    unitTests: {
      erb: ['packages/app/tests/kojo-code-lens.test.ts'],
      kojo2: ['packages/app/tests/kojo2-codelens.test.ts'],
    },
    manual: {
      steps: [
        '打开{sample}，看函数头 / 标签上方是否出现「引用 N」一类 code lens',
        '点一次 lens，确认打开的是引用面板而不是改写正文',
        '改一处引用后回到原处，看 N 是否更新（不要求实时，重渲染即算）',
      ],
      expected: 'lens 条数、N 与实际引用是否一致、点击行为（读数进 STATE）',
    },
  }),
  spec({
    id: 'implementation',
    label: '跳实现',
    providerApi: 'registerImplementationProvider',
    unitTests: {
      erb: ['packages/app/tests/erb-implementation.test.ts'],
      kojo2: [],
    },
    manual: {
      steps: [
        '打开{sample}，把光标放在一个有实现的符号上按 Ctrl+F12',
        '确认跳到实现处（不是只弹 Peek）；再按 Alt+Backspace 返回',
        '对没有实现的符号再按一次，确认给出可见提示/不动，不静默失败',
      ],
      expected: '跳转落点、返回栈、无实现时的可见反馈（读数进 STATE）',
    },
  }),
  spec({
    id: 'highlight',
    label: '同符号高亮',
    providerApi: 'registerDocumentHighlightProvider',
    unitTests: {
      erb: ['packages/app/tests/erb-highlight-selection.test.ts'],
      kojo2: ['packages/app/tests/kojo2-highlight-selection.test.ts'],
    },
    manual: {
      steps: [
        '打开{sample}，把光标停在函数名 / 标签名上（不选中）',
        '看同文件内同名符号是否一起高亮；确认注释/字符串里的同名散文不亮',
        '移动光标到另一符号，确认旧高亮立即消失（不残留）',
      ],
      expected: '高亮枚数、误亮数（散文/字符串）、移开后的残留数（读数进 STATE）',
    },
  }),
  spec({
    id: 'selection',
    label: '扩选',
    providerApi: 'registerSelectionRangeProvider',
    unitTests: {
      erb: ['packages/app/tests/erb-highlight-selection.test.ts'],
      kojo2: ['packages/app/tests/kojo2-highlight-selection.test.ts'],
    },
    manual: {
      steps: [
        '打开{sample}，把光标放在一个词中间，连按 Ctrl+Shift+→',
        '观察扩选层级：词 → 行 → 标签块/函数块 → 全文，每层边界是否合语法',
        '连按 Ctrl+Shift+← 逐层缩回，确认能原路返回且不跳到别处',
      ],
      expected: '扩选层数与每层边界、缩回是否原路（读数进 STATE）',
    },
  }),
  spec({
    id: 'callhierarchy',
    label: '调用层级',
    providerApi: 'registerCallHierarchyProvider',
    unitTests: {
      erb: [],
      kojo2: [],
    },
    manual: {
      steps: [
        '打开{sample}，在函数名上打开调用层级面板（若本机无 Monaco API，走宿主自建面板）',
        '确认入边/出边各列得出来、点一条能跳',
        '对无调用者的函数打开一次，确认面板显示「无」而不是空白',
      ],
      expected: '入边/出边条数、点击落点、空态文案（读数进 STATE）',
    },
  }),
  spec({
    id: 'completion',
    label: '补全',
    providerApi: 'registerCompletionItemProvider',
    unitTests: {
      erb: ['packages/app/tests/erb-completion.test.ts'],
      // B3c（2026-10-28）：补全判据整块搬进 `@kojo/kojo-lang`，配套单测随之搬家
      // `app/tests/kojo2-completion.test.ts` → `kojo-lang/tests/completion.test.ts`。
      // 判据不变——这里证的仍是「这条能力有单测在册（文件在 + 真有 it）」，只是取证落点搬家。
      kojo2: ['packages/kojo-lang/tests/completion.test.ts'],
    },
    manual: {
      steps: [
        '打开{sample}，输入 时机 / CALL 函数名前缀，看候选是否弹出',
        '选一条带 snippet 的候选回车，确认占位符（${1:…}）可 Tab 跳格、Esc 退出',
        '在中文输入法合成期打同样前缀，确认候选不抢输入法候选窗',
      ],
      expected: '候选条数/排序、snippet 插入与 Tab 跳格、合成期是否让位（读数进 STATE）',
    },
  }),
  spec({
    id: 'hover',
    label: '悬停',
    providerApi: 'registerHoverProvider',
    unitTests: {
      erb: ['packages/app/tests/kojo-hover.test.ts'],
      kojo2: ['packages/kojo-lang/tests/hover.test.ts'],
    },
    manual: {
      steps: [
        '打开{sample}，把鼠标停在函数名 / 标签 / 变量上 1s',
        '看悬停原文是否给出中文名/签名；移动鼠标到另一符号，确认浮层跟着换',
        '在字符串/注释里悬停一次，确认不误答（或明说无信息）',
      ],
      expected: '悬停原文、切换符号是否更新、注释/字符串误答数（读数进 STATE）',
    },
  }),
  spec({
    id: 'definition',
    label: '跳转 / 转到定义',
    providerApi: 'registerDefinitionProvider',
    unitTests: {
      erb: ['packages/app/tests/kojo-definition.test.ts'],
      // B3c（2026-10-28）：这枚与 hover 同落点——原 `app/tests/kojo2-hover-definition.test.ts`
      // 是「悬停 + 转定义」两半合一的闸，整枚搬进包后叫 `hover.test.ts`，两半都还在（断言未减）。
      // 判据不变：证的仍是「转定义有单测在册」，只是取证落点搬家。
      kojo2: ['packages/kojo-lang/tests/hover.test.ts'],
    },
    manual: {
      steps: [
        '打开{sample}，把光标放在函数调用 / 标签引用上按 F12',
        '确认落到声明行；Ctrl+Click 再走一次，行为应一致',
        '对没有声明的符号按 F12，确认有可见反馈且编辑器不崩',
      ],
      expected: '落点行/列、Ctrl+Click 与 F12 一致、无声明时的反馈（读数进 STATE）',
    },
  }),
  spec({
    id: 'diagnostics',
    label: '诊断',
    providerApi: null,
    unitTests: {
      erb: ['packages/app/tests/tree-sitter-diagnostics.test.ts'],
      kojo2: ['packages/app/tests/kojo2-diagnostics.test.ts'],
    },
    manual: {
      steps: [
        '打开{sample}，故意删掉一条 IF 对应的 ENDIF（或写一个不合语法的块）',
        '看波浪线落在哪一行、悬停原文是否点名缺什么；打开诊断面板看条目',
        'Ctrl+Z 恢复，确认波浪线与面板计数一起消失',
      ],
      expected: '波浪线落点行、悬停原文、面板条数、恢复后清零（读数进 STATE）',
    },
  }),
  spec({
    id: 'preview',
    label: '预览 / Peek',
    providerApi: null,
    unitTests: {
      erb: ['packages/app/tests/peek-preview-fold.test.ts'],
      kojo2: ['packages/app/tests/kojo2-preview-model.test.ts'],
    },
    manual: {
      steps: [
        '打开{sample}，把光标放在符号上按 Alt+F12 打开 Peek',
        '在 Peek 里上下选一条、回车跳过去；再按 Esc 关闭，确认原光标位置保留',
        '在 Peek 打开时改正文，确认预览不把改动写回（只读预览）',
      ],
      expected: 'Peek 条目数、选中跳转、Esc 后光标、预览是否只读（读数进 STATE）',
    },
  }),
  spec({
    id: 'breadcrumb',
    label: '面包屑',
    monaco: false,
    providerApi: null,
    unitTests: {
      erb: ['packages/app/tests/breadcrumb-path.test.ts'],
      kojo2: ['packages/app/tests/breadcrumb-path.test.ts'],
    },
    manual: {
      steps: [
        '打开{sample}，把光标放到文件深层的块里，看顶部面包屑是否列出 外→内 各级',
        '点某一级的下拉，确认列出同级其他块，点一条能跳过去',
        '把光标移到顶层/空行，确认面包屑退到只剩文件名（不显示过期链）',
      ],
      expected: '链级数、同级下拉项数、点击落点、顶层空态（读数进 STATE）',
    },
  }),
]);

function spec(entry) {
  return Object.freeze({
    monaco: true,
    ...entry,
    unitTests: Object.freeze(entry.unitTests ?? {}),
    manual: Object.freeze({
      steps: Object.freeze(entry.manual?.steps ?? []),
      expected: entry.manual?.expected ?? '',
    }),
  });
}

/* ============================== 取证文件表 ============================== */

/** 本工具读的固定真源（相对仓库根；读不到 = FAIL，不静默空匹配） */
export const FILES = Object.freeze({
  matrix: 'packages/app/src/monaco/language-capabilities.ts',
  globalProviders: 'packages/app/src/ui/editor-global-providers.ts',
  parityTest: 'packages/app/tests/language-parity.test.ts',
  erbLanguage: 'packages/app/src/monaco/erb-language.ts',
  kojo2Language: 'packages/app/src/monaco/kojo2-language.ts',
  // SDK B4：2.0 的 Monarch / 语言配置正文搬到 `@kojo/kojo-lang`，宿主这一侧剩下的"注册面"
  // 就是这枚落点（唯一把供方数据接进 `setLanguageConfiguration` 的模块）。
  monacoLanguageSurface: 'packages/app/src/monaco/monaco-language-surface.ts',
  erbCompletion: 'packages/app/src/monaco/erb-completion.ts',
  editorPane: 'packages/app/src/ui/EditorPane.tsx',
  problemSync: 'packages/app/src/ui/kojo2-problem-sync.ts',
  monacoInstance: 'packages/app/src/ui/editor-pane/use-monaco-instance.ts',
  breadcrumb: 'packages/app/src/ui/editor-pane/use-breadcrumb.ts',
});

/** 真壳冒烟项（`--shell` 才真跑；命令口径与 AGENTS §三 / release-gate `--shell` 逐字同源） */
export const SHELL_SMOKES = Object.freeze([
  Object.freeze({
    id: 'smoke-dom',
    rel: 'tools/smoke-tauri-dom.mjs',
    command: 'node tools/smoke-tauri-dom.mjs',
    timeoutMs: 240_000,
    why: 'DOM 冒烟（弹窗 ~100s 自动关；断言①底色 / 断言②可点前零 monaco）',
  }),
  Object.freeze({
    id: 'smoke-ipc',
    rel: 'tools/smoke-tauri-ipc.mjs',
    command: 'node tools/smoke-tauri-ipc.mjs',
    timeoutMs: 360_000,
    why: '真实 IPC 双闸 a–e（自动发现语料；无桌面会话 / 无语料会 rc=2 并列出候选）',
  }),
]);

/* ============================== 文本取证工具 ============================== */

const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;

/** 去 ANSI（冒烟输出里可能有颜色码；读数与 tail 都走这里） */
export function stripAnsi(text = '') {
  return String(text).replace(ANSI, '').replace(/\r\n?/g, '\n');
}

/**
 * 剥注释（口径照 `tools/tests/smoke-port-single-source.test.ts` 的 `stripComments`）：
 * 块注释先摘掉，再逐行去掉行注释。`(^|\s)//` 保证 `https://` 不被误伤。
 * 源码取证一律在剥注释后的文本上做——注释里的「示例注册行」不算注册。
 */
export function stripComments(source = '') {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
}

/** 第一个非空行（错误信息用，避免把整段 JSON 塞进 reason） */
function firstLine(text = '', limit = 220) {
  const line =
    stripAnsi(text)
      .split('\n')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)[0] ?? '';
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/** 末 N 行非空输出（JSON 里只留能定位失败的那点尾巴） */
export function tailLines(text = '', limit = 16) {
  const lines = stripAnsi(text)
    .split('\n')
    .filter((line) => line.trim().length > 0);
  return lines.slice(-limit).join('\n');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ============================== 源码解析 ============================== */

/** `export enum LanguageCapability { Folding = 'folding', … }` → Map(value → member) */
export function extractEnumCapabilities(source = '') {
  const text = String(source);
  const start = text.indexOf('export enum LanguageCapability');
  if (start < 0) return new Map();
  const open = text.indexOf('{', start);
  if (open < 0) return new Map();
  const body = takeBalanced(text, open, '{', '}');
  const out = new Map();
  for (const match of body.matchAll(/(\w+)\s*=\s*'([^']+)'/g)) out.set(match[2], match[1]);
  return out;
}

/**
 * 从 `openIndex` 处的 `{` 起截到配平的 `}`（字符串感知：`'…'` / `"…"` / `` `…` `` 里的
 * 括号不计数）。返回**不含最外层花括号**的内容；截不到配平就抛（源码形状坏了要响）。
 */
function takeBalanced(text, openIndex, openCh = '{', closeCh = '}') {
  let depth = 0;
  let quote = null;
  for (let index = openIndex; index < text.length; index += 1) {
    const ch = text[index];
    if (quote !== null) {
      if (ch === '\\') index += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === openCh) depth += 1;
    else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, index);
    }
  }
  throw new Error(`[lang-ux-matrix] 花括号不配平（从 offset ${openIndex} 起）`);
}

/** 读一个字符串字面量（起点必须是引号）；支持转义，返回 `{ value, end }` */
function readQuoted(text, index) {
  const quote = text[index];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let value = '';
  for (let cursor = index + 1; cursor < text.length; cursor += 1) {
    const ch = text[cursor];
    if (ch === '\\') {
      value += text[cursor + 1] ?? '';
      cursor += 1;
      continue;
    }
    if (ch === quote) return { value, end: cursor + 1 };
    value += ch;
  }
  return null;
}

/**
 * 解析一门语言的状态表（`const ERB_CAPABILITY_STATUS = Object.freeze({ … })`）。
 * 返回 `{ statuses: { <member>: { tier } | { exempt } }, error }`。
 * - 每项键形如 `[LanguageCapability.Folding]:`，值要么 `'shared'`，要么 `{ exempt: '…' }`；
 * - 缺项 / 值认不出 / 对象不配平都记 error（调用方把该项判 FAIL，不猜档位）。
 */
export function parseStatusTable(source = '', blockName = '') {
  const text = String(source);
  const start = text.indexOf(`const ${blockName}`);
  if (start < 0) return { statuses: {}, error: `找不到 ${blockName}` };
  const freeze = text.indexOf('Object.freeze(', start);
  if (freeze < 0) return { statuses: {}, error: `${blockName} 里找不到 Object.freeze(` };
  const brace = text.indexOf('{', freeze);
  let body;
  try {
    body = takeBalanced(text, brace, '{', '}');
  } catch (error) {
    return { statuses: {}, error: `${blockName} 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
  const statuses = {};
  const keyRe = /\[LanguageCapability\.(\w+)\]\s*:\s*/g;
  for (const match of body.matchAll(keyRe)) {
    const member = match[1];
    let cursor = match.index + match[0].length;
    while (cursor < body.length && /\s/.test(body[cursor])) cursor += 1;
    const quoted = readQuoted(body, cursor);
    if (quoted !== null) {
      statuses[member] = { tier: quoted.value };
      continue;
    }
    if (body[cursor] === '{') {
      let inner;
      try {
        inner = takeBalanced(body, cursor, '{', '}');
      } catch (error) {
        return { statuses, error: `${blockName}/${member} 豁免对象解析失败` };
      }
      const exemptMatch = /exempt\s*:\s*/.exec(inner);
      if (exemptMatch === null) {
        return { statuses, error: `${blockName}/${member} 是对象但没有 exempt 字段` };
      }
      // `inner` 是相对 `body` 的切片：换算回 body 坐标再读字符串字面量。
      let valueCursor = cursor + 1 + exemptMatch.index + exemptMatch[0].length;
      while (valueCursor < body.length && /\s/.test(body[valueCursor])) valueCursor += 1;
      const reason = readQuoted(body, valueCursor);
      if (reason === null) {
        return { statuses, error: `${blockName}/${member} 的 exempt 不是字符串字面量` };
      }
      statuses[member] = { exempt: reason.value };
      continue;
    }
    return { statuses, error: `${blockName}/${member} 的值既不是档位字面量也不是 { exempt }` };
  }
  return { statuses, error: null };
}

/**
 * 从一份 TS/TSX 测试文件里抽 `it(...)` 的名字（只做取证清单，不执行测试）。
 * 兼容 `it('…')` / `it("…")` / `it.each(...)('…')`；名字里的转义不展开（够读）。
 */
export function extractTestNames(source = '') {
  const text = String(source);
  const names = [];
  for (const match of text.matchAll(/\bit(?:\.each\s*\([^)]*\))?\s*\(\s*(['"`])([\s\S]*?)\1/g)) {
    const name = match[2].replace(/\s+/g, ' ').trim();
    if (name.length > 0) names.push(name);
  }
  return names;
}

/* ============================== 文件读取器 ============================== */

/**
 * 默认读取器：相对仓库根读文件、走 `packages/app/src/**` 的 `.ts/.tsx`。
 * 测试可以注入同形状对象（`readFile` / `exists` / `listSourceFiles`）做失败注入，
 * 不必往盘上复制整棵树。
 */
export function createFsReader({ root = ROOT } = {}) {
  const cache = new Map();
  const readFile = (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    const text = readFileSync(path.join(root, rel), 'utf8');
    cache.set(rel, text);
    return text;
  };
  const exists = (rel) => existsSync(path.join(root, rel));
  let sourceFiles = null;
  const listSourceFiles = () => {
    if (sourceFiles !== null) return sourceFiles;
    const out = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (/\.tsx?$/.test(entry.name) && statSync(abs).isFile()) {
          out.push(path.relative(root, abs).split(path.sep).join('/'));
        }
      }
    };
    walk(path.join(root, 'packages/app/src'));
    sourceFiles = out.sort();
    return sourceFiles;
  };
  return { root, readFile, exists, listSourceFiles };
}

/* ============================== 取证上下文 ============================== */

function buildContext(reader) {
  const sourceFiles = reader.listSourceFiles();
  const raw = new Map();
  const code = new Map();
  for (const rel of sourceFiles) {
    const text = reader.readFile(rel);
    raw.set(rel, text);
    code.set(rel, stripComments(text));
  }
  const matrixSource = reader.readFile(FILES.matrix);
  const parityRaw = reader.readFile(FILES.parityTest);
  const erbStatus = parseStatusTable(matrixSource, 'ERB_CAPABILITY_STATUS');
  const kojo2Status = parseStatusTable(matrixSource, 'KOJO2_CAPABILITY_STATUS');
  return {
    reader,
    sourceFiles,
    raw,
    code,
    matrixSource,
    enumCapabilities: extractEnumCapabilities(matrixSource),
    statuses: {
      ERB_CAPABILITY_STATUS: erbStatus,
      KOJO2_CAPABILITY_STATUS: kojo2Status,
    },
    parityRaw,
    parityCode: stripComments(parityRaw),
    parityTests: extractTestNames(parityRaw),
  };
}

/* ============================== automated 判定 ============================== */

function baseItem(language, capability) {
  return {
    id: `${language.id}/${capability.id}`,
    language: language.id,
    capability: capability.id,
    check: 'automated',
  };
}

function failItem(base, reason, evidence = []) {
  return { ...base, status: 'fail', tier: null, reason, evidence };
}

function shouldRequireText(ctx, rel, pattern, label, failures, evidence) {
  let text;
  try {
    text = ctx.code.get(rel) ?? stripComments(ctx.reader.readFile(rel));
  } catch (error) {
    failures.push(`读不到 ${rel}（${error instanceof Error ? error.message : String(error)}）`);
    return;
  }
  if (pattern.test(text)) evidence.push(`${rel}: ${label}`);
  else failures.push(`${rel} 里找不到 ${label}`);
}

/** 注册行按档位取证：`self` = 本语言 id 直挂；`shared` = registerForLanguageServices 收口 */
function findRegistrations(ctx, api, mode, language) {
  if (typeof api !== 'string' || api.length === 0) return [];
  const selector = new RegExp(
    language.id === 'erb' ? `(?:ERB_LANGUAGE_ID|'kojo-erb')` : `(?:KOJO2_LANGUAGE_ID|'kojo2')`,
  );
  const pattern =
    mode === 'self'
      ? new RegExp(`${escapeRegExp(api)}\\s*\\([^;]{0,600}?${selector.source}`, 'm')
      : new RegExp(`registerForLanguageServices\\s*\\([^;]{0,600}?${escapeRegExp(api)}\\s*\\(`, 'm');
  const hits = [];
  for (const rel of ctx.sourceFiles) {
    const text = ctx.code.get(rel) ?? '';
    if (pattern.test(text)) hits.push(rel);
  }
  return hits;
}

/** 装配行：注册模块被宿主装配点 import（模块写了没人调 = 死代码） */
function isAssembled(ctx, rel) {
  if (rel === FILES.globalProviders) return true;
  const fromSrc = rel.slice('packages/app/src/'.length).replace(/\.tsx?$/, '');
  const spec = fromSrc.startsWith('monaco/') ? `'../${fromSrc}'` : `'./${fromSrc}'`;
  const globalCode = ctx.code.get(FILES.globalProviders) ?? '';
  return globalCode.includes(spec);
}

/** `capabilitiesInTier(<LANG>, '<tier>')` 的档位断言里必须真有这一项 */
function tierListHas(ctx, language, tier, capabilityId) {
  const langConst = language.languageConst;
  const re = new RegExp(
    `capabilitiesInTier\\(\\s*${langConst}\\s*,\\s*'${tier}'\\s*\\)\\s*\\)\\s*\\.` +
      `(?:toEqual\\(\\s*\\[([\\s\\S]{0,900}?)\\]\\s*\\)|toContain\\(\\s*'${escapeRegExp(capabilityId)}'\\s*\\))`,
    'm',
  );
  const match = re.exec(ctx.parityCode);
  if (match === null) {
    return { ok: false, reason: `language-parity.test.ts 找不到 ${langConst} 的 ${tier} 档位断言` };
  }
  if (match[1] === undefined) {
    return { ok: true, evidence: `language-parity.test.ts: ${langConst}/${tier} toContain('${capabilityId}')` };
  }
  const listed = [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
  if (!listed.includes(capabilityId)) {
    return {
      ok: false,
      reason: `language-parity.test.ts 的 ${langConst}/${tier} 档位清单里没有 '${capabilityId}'`,
    };
  }
  return { ok: true, evidence: `language-parity.test.ts: ${langConst}/${tier} 档位清单含 '${capabilityId}'` };
}

/** 豁免清单：`exemptionsOf(<LANG>)…toEqual([ … ])` 必须点名这一项 */
function exemptionListed(ctx, language, capabilityId) {
  const re = new RegExp(
    `exemptionsOf\\(\\s*${language.languageConst}\\s*\\)[\\s\\S]{0,400}?\\.toEqual\\(\\s*\\[([\\s\\S]{0,700}?)\\]\\s*\\)`,
    'm',
  );
  const match = re.exec(ctx.parityCode);
  if (match === null) return false;
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]).includes(capabilityId);
}

function evaluateBreadcrumb(base, language, ctx) {
  const evidence = [];
  const failures = [];
  if (language.id === 'erb') {
    shouldRequireText(ctx, FILES.breadcrumb, /erbParserIndex/, 'ERB 索引快路 erbParserIndex', failures, evidence);
    shouldRequireText(
      ctx,
      FILES.breadcrumb,
      /collectDocumentSymbols\(/,
      'ERB documentSymbol 回退腿 collectDocumentSymbols',
      failures,
      evidence,
    );
  } else {
    shouldRequireText(
      ctx,
      FILES.breadcrumb,
      /KOJO2_LANGUAGE_ID/,
      'kojo2 分支（KOJO2_LANGUAGE_ID）',
      failures,
      evidence,
    );
    shouldRequireText(
      ctx,
      FILES.breadcrumb,
      /kojo2DocumentSymbols\(/,
      '2.0 符号 kojo2DocumentSymbols',
      failures,
      evidence,
    );
  }
  failures.push(...unitTestFailures(ctx, language, CAPABILITIES.find((c) => c.id === 'breadcrumb'), evidence));
  if (failures.length > 0) return failItem(base, failures.join('；'), evidence);
  return {
    ...base,
    status: 'pass',
    tier: 'host',
    reason: null,
    evidence,
  };
}

function unitTestFailures(ctx, language, capability, evidence) {
  const failures = [];
  const tests = capability.unitTests?.[language.id] ?? [];
  if (tests.length === 0) {
    failures.push(`${language.id}/${capability.id} 没有登记单测（unitTests.${language.id} 为空）`);
    return failures;
  }
  for (const rel of tests) {
    if (!ctx.reader.exists(rel)) {
      failures.push(`单测文件不存在：${rel}`);
      continue;
    }
    let text;
    try {
      text = ctx.reader.readFile(rel);
    } catch (error) {
      failures.push(`单测文件读不到：${rel}`);
      continue;
    }
    const names = extractTestNames(text);
    if (names.length === 0) {
      failures.push(`单测文件里没有 it(...)：${rel}`);
      continue;
    }
    const sample = names.slice(0, 2).join(' / ');
    evidence.push(`${rel}: ${names.length} 条 it（${sample}）`);
  }
  return failures;
}

/**
 * 单条 automated 判定：矩阵状态 → 档位取证 → 装配 → parity 档位清单 → 单测。
 * 只有**矩阵自己标 `{ exempt }` 且理由可读**才允许 SKIP；其余任何取不到证据都是 FAIL。
 */
export function evaluateAutomatedItem({ language, capability }, ctx) {
  const base = baseItem(language, capability);

  if (capability.id === 'breadcrumb') return evaluateBreadcrumb(base, language, ctx);

  const member = ctx.enumCapabilities.get(capability.id);
  if (member === undefined) {
    return failItem(base, `${FILES.matrix} 的 LanguageCapability 枚举里没有 '${capability.id}'`);
  }
  const table = ctx.statuses[language.statusBlock];
  if (table.error !== null) return failItem(base, `${language.statusBlock} 解析失败：${table.error}`);
  const status = table.statuses[member];
  if (status === undefined) {
    return failItem(base, `${language.statusBlock} 缺 '${capability.id}' 的状态（枚举新增而矩阵没补）`);
  }

  if (status.exempt !== undefined) {
    const reason = String(status.exempt);
    if (reason.trim().length < 8) {
      return failItem(base, `${language.id}/${capability.id} 标了豁免但理由不可读（"${reason}"）`);
    }
    const listed = exemptionListed(ctx, language, capability.id);
    if (!listed) {
      return failItem(
        base,
        `${language.id}/${capability.id} 标了豁免，但 language-parity.test.ts 的豁免清单没点名它`,
      );
    }
    return {
      ...base,
      status: 'skip',
      tier: 'exempt',
      reason,
      evidence: [`${FILES.matrix}: { exempt } — ${reason}`, 'language-parity.test.ts 豁免清单含该项'],
    };
  }

  const tier = status.tier;
  if (tier !== 'self' && tier !== 'shared' && tier !== 'builtin') {
    return failItem(base, `${language.id}/${capability.id} 的档位认不出：${JSON.stringify(status)}`);
  }

  const evidence = [];
  const failures = [];

  if (capability.id === 'diagnostics') {
    if (language.id === 'erb') {
      shouldRequireText(ctx, FILES.editorPane, /query\('ui\.editor\.decorator'\)/, 'decorator 槽取数', failures, evidence);
      shouldRequireText(
        ctx,
        FILES.editorPane,
        /setModelMarkers\(\s*model\s*,\s*MARKER_OWNER/,
        'setModelMarkers(model, MARKER_OWNER, …)',
        failures,
        evidence,
      );
    } else {
      shouldRequireText(ctx, FILES.problemSync, /KOJO2_PROBLEM_MARKER_OWNER/, 'KOJO2_PROBLEM_MARKER_OWNER', failures, evidence);
      shouldRequireText(ctx, FILES.problemSync, /setModelMarkers\(/, 'setModelMarkers(', failures, evidence);
      shouldRequireText(
        ctx,
        FILES.monacoInstance,
        /installKojo2ProblemWiring\(\{/,
        'installKojo2ProblemWiring({',
        failures,
        evidence,
      );
    }
  } else if (capability.id === 'preview') {
    const fake = ctx.sourceFiles.filter((rel) => /register(?:Preview|Peek)\w*Provider/.test(ctx.code.get(rel) ?? ''));
    if (fake.length > 0) failures.push(`有人造了第二套预览 provider：${fake.join(', ')}`);
    else evidence.push('全源码零 registerPreview/PeekProvider（Peek 是 Monaco 内建窗）');
  } else if (capability.id === 'brackets') {
    // 两门语言的"成对记号注册面"住址不同（SDK B4）：ERB 的语言配置仍写在它自己的模块里；
    // 2.0 的正文搬进 `@kojo/kojo-lang`，宿主这一侧的证据于是是**两截**——落点里那条把供方
    // 数据接进 `setLanguageConfiguration` 的腿，加上 `kojo2-language.ts` 里唯一的成对表出口名。
    // 缺落点 = 能力声明是假的；缺出口名 = 有人在宿主另抄了一张表。
    const legs =
      language.id === 'erb'
        ? [
            [FILES.erbLanguage, /\bbrackets\s*:/, 'brackets:'],
            [FILES.erbLanguage, /\bautoClosingPairs\s*:/, 'autoClosingPairs:'],
            [FILES.erbLanguage, /\bERB_BRACKET_PAIRS\b/, 'ERB_BRACKET_PAIRS'],
          ]
        : [
            [
              FILES.monacoLanguageSurface,
              /setLanguageConfiguration\(\s*languageId/,
              'setLanguageConfiguration(languageId, …)',
            ],
            [FILES.monacoLanguageSurface, /\bdata\.brackets\b/, 'data.brackets'],
            [FILES.monacoLanguageSurface, /\bdata\.autoClosingPairs\b/, 'data.autoClosingPairs'],
            [FILES.kojo2Language, /\bKOJO2_PAIRS\b/, 'KOJO2_PAIRS（语言面库单源的出口名）'],
          ];
    for (const [rel, re, label] of legs) shouldRequireText(ctx, rel, re, label, failures, evidence);
  } else if (capability.id === 'indent' && tier === 'builtin') {
    // ERB 的缩进走语言配置（不注册 provider）；kojo2 的 indent 是 self，走下面的注册行取证。
    shouldRequireText(ctx, FILES.erbLanguage, /\bonEnterRules\s*:/, 'onEnterRules:', failures, evidence);
    shouldRequireText(ctx, FILES.erbLanguage, /\bindentationRules\s*:/, 'indentationRules:', failures, evidence);
  } else if (capability.id === 'completion' && language.id === 'erb') {
    // 补全走装配核：注册调用里不是字面语言 id，而是 `languageId: ERB_LANGUAGE_ID`。
    shouldRequireText(ctx, FILES.erbCompletion, /languageId:\s*ERB_LANGUAGE_ID/, 'languageId: ERB_LANGUAGE_ID', failures, evidence);
    shouldRequireText(
      ctx,
      FILES.erbCompletion,
      /installCompletion\(monaco,\s*ERB_COMPLETION_ASSEMBLY/,
      'installCompletion(monaco, ERB_COMPLETION_ASSEMBLY, …)',
      failures,
      evidence,
    );
    if (!isAssembled(ctx, FILES.erbCompletion)) {
      failures.push(`${FILES.erbCompletion} 没被 ${FILES.globalProviders} import（注册模块没人调）`);
    } else {
      evidence.push(`装配点 import ${FILES.erbCompletion}`);
    }
  } else if (tier === 'builtin') {
    return failItem(base, `${language.id}/${capability.id} 是 builtin 档但本工具没有对应的配置取证`);
  } else {
    const hits = findRegistrations(ctx, capability.providerApi, tier, language);
    if (hits.length === 0) {
      failures.push(
        `${language.id}/${capability.id}：全源码找不到 ${capability.providerApi} 的 ${tier} 注册行` +
          (tier === 'shared' ? '（registerForLanguageServices 收口）' : `（本语言 id ${language.languageConst}）`),
      );
    } else {
      evidence.push(`${hits.join(', ')}: ${capability.providerApi}（${tier}）`);
      for (const rel of hits) {
        if (isAssembled(ctx, rel)) evidence.push(`装配点 import ${rel}`);
        else failures.push(`${rel} 注册了 ${capability.id}，但 ${FILES.globalProviders} 没 import 它`);
      }
    }
  }

  // parity 档位清单（矩阵声明 ↔ 闸门断言是同一份事实）
  const parity = tierListHas(ctx, language, tier, capability.id);
  if (!parity.ok) failures.push(parity.reason);
  else evidence.push(parity.evidence);

  failures.push(...unitTestFailures(ctx, language, capability, evidence));

  if (failures.length > 0) return failItem(base, failures.join('；'), evidence);
  return { ...base, status: 'pass', tier, reason: null, evidence };
}

/** 矩阵自证项：枚举 ↔ 工具表一致（新能力只加枚举不加表，这里红） */
function evaluateEnumParity(ctx) {
  const base = { id: 'matrix/enum-parity', language: 'all', capability: 'matrix', check: 'automated' };
  const enumValues = [...ctx.enumCapabilities.keys()].sort();
  const toolValues = CAPABILITIES.filter((entry) => entry.monaco).map((entry) => entry.id).sort();
  const missing = toolValues.filter((id) => !enumValues.includes(id));
  const unlisted = enumValues.filter((id) => !toolValues.includes(id));
  const failures = [];
  if (missing.length > 0) failures.push(`枚举里没有本工具声明的能力：${missing.join(', ')}`);
  if (unlisted.length > 0) failures.push(`枚举新增了本工具未登记的能力：${unlisted.join(', ')}`);
  for (const language of LANGUAGES) {
    const table = ctx.statuses[language.statusBlock];
    if (table.error !== null) failures.push(`${language.statusBlock} 解析失败：${table.error}`);
    else if (Object.keys(table.statuses).length !== enumValues.length) {
      failures.push(
        `${language.statusBlock} 有 ${Object.keys(table.statuses).length} 项，枚举是 ${enumValues.length} 项`,
      );
    }
  }
  if (ctx.parityTests.length < 10) failures.push(`language-parity.test.ts 只抽到 ${ctx.parityTests.length} 条 it`);
  if (failures.length > 0) return failItem(base, failures.join('；'), []);
  return {
    ...base,
    status: 'pass',
    tier: 'matrix',
    reason: null,
    evidence: [
      `枚举 ${enumValues.length} 项 ↔ 本工具 Monaco 面 ${toolValues.length} 项（宿主面 ${CAPABILITIES.filter((entry) => !entry.monaco).map((entry) => entry.id).join(', ')} 不计入枚举）`,
      `language-parity.test.ts: ${ctx.parityTests.length} 条 it 可点名`,
    ],
  };
}

/* ============================== manual 清单 ============================== */

function deliveredOf(ctx, language) {
  const table = ctx.statuses[language.statusBlock];
  return CAPABILITIES.filter((capability) => {
    if (!capability.monaco) return true; // breadcrumb = 宿主面，两语言都交付
    const member = ctx.enumCapabilities.get(capability.id);
    if (member === undefined) return false;
    const status = table.statuses?.[member];
    return status !== undefined && status.exempt === undefined;
  });
}

function manualItemsFor(ctx, language) {
  return deliveredOf(ctx, language).map((capability) => {
    const steps = capability.manual.steps.map((step) => step.replaceAll('{sample}', language.sample));
    return {
      id: `${language.id}/${capability.id}/manual`,
      language: language.id,
      capability: capability.id,
      check: 'manual',
      steps,
      expected: capability.manual.expected,
      evidence: '真壳（tauri dev）人工步骤；读数写进 STATE 的对应槽位',
    };
  });
}

function manualGapsFor(ctx, language) {
  const table = ctx.statuses[language.statusBlock];
  const gaps = [];
  for (const capability of CAPABILITIES) {
    if (!capability.monaco) continue;
    const member = ctx.enumCapabilities.get(capability.id);
    if (member === undefined) continue;
    const status = table.statuses?.[member];
    if (status?.exempt !== undefined) {
      gaps.push({ language: language.id, capability: capability.id, reason: status.exempt });
    }
  }
  return gaps;
}

/* ============================== 矩阵求值 ============================== */

/**
 * 纯求值（不 spawn、不写盘）：automated 43 项（1 项矩阵自证 + 2 语言 × 21 能力）
 * + manual 37 项（交付面 × 两语言）。`shell` 由 `runShellReadings` 的结果直接塞进来。
 *
 * 判定：任何 automated fail ⇒ exitCode=1；`--shell` 时任何冒烟非 pass ⇒ exitCode=1
 * （blocked 也记非 0：前置不满足 ≠ 通过，原因在 readings.shell 里）。
 */
export function evaluateMatrix({ reader = createFsReader(), shell = null, generatedAt = new Date().toISOString() } = {}) {
  const ctx = buildContext(reader);
  const automatedItems = [evaluateEnumParity(ctx)];
  for (const language of LANGUAGES) {
    for (const capability of CAPABILITIES) {
      automatedItems.push(evaluateAutomatedItem({ language, capability }, ctx));
    }
  }
  const manual = LANGUAGES.flatMap((language) => manualItemsFor(ctx, language));
  const manualGaps = LANGUAGES.flatMap((language) => manualGapsFor(ctx, language));

  const count = (status) => automatedItems.filter((item) => item.status === status).length;
  const automated = {
    pass: count('pass'),
    fail: count('fail'),
    skip: count('skip'),
    items: automatedItems,
  };

  const languages = {};
  for (const language of LANGUAGES) {
    const delivered = deliveredOf(ctx, language).map((entry) => entry.id);
    const table = ctx.statuses[language.statusBlock];
    const exemptions = [];
    for (const [member, status] of Object.entries(table.statuses ?? {})) {
      if (status.exempt === undefined) continue;
      const capabilityId =
        [...ctx.enumCapabilities.entries()].find(([, name]) => name === member)?.[0] ?? member;
      exemptions.push({ capability: capabilityId, reason: status.exempt });
    }
    const items = automatedItems.filter((item) => item.language === language.id);
    languages[language.id] = {
      id: language.id,
      label: language.label,
      languageId: language.languageId,
      statusBlock: language.statusBlock,
      delivered,
      exempt: exemptions,
      automated: {
        pass: items.filter((item) => item.status === 'pass').length,
        fail: items.filter((item) => item.status === 'fail').length,
        skip: items.filter((item) => item.status === 'skip').length,
      },
      manual: manual.filter((item) => item.language === language.id).length,
    };
  }

  const shellReadings =
    shell === null
      ? {
          requested: false,
          items: [],
          exitCode: 0,
          note: '未请求：加 --shell 才真跑 tools/smoke-tauri-dom.mjs / tools/smoke-tauri-ipc.mjs（读数含 rc/ms/失败原因）',
        }
      : shell;

  const exitCode = automated.fail > 0 || (shellReadings.requested && shellReadings.exitCode !== 0) ? 1 : 0;

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    languages,
    capabilities: CAPABILITIES.map((capability) => ({
      id: capability.id,
      label: capability.label,
      monaco: capability.monaco,
      providerApi: capability.providerApi,
    })),
    automated,
    manual,
    readings: {
      matrix: {
        source: FILES.matrix,
        enumCount: ctx.enumCapabilities.size,
        enum: [...ctx.enumCapabilities.keys()],
        host: CAPABILITIES.filter((entry) => !entry.monaco).map((entry) => entry.id),
        parityTestFile: FILES.parityTest,
        parityTests: ctx.parityTests,
        statusErrors: Object.fromEntries(
          Object.entries(ctx.statuses).map(([key, value]) => [key, value.error]),
        ),
      },
      shell: shellReadings,
      manualGaps,
      counts: {
        automated: { pass: automated.pass, fail: automated.fail, skip: automated.skip },
        manual: manual.length,
        manualGaps: manualGaps.length,
      },
      exitCode,
    },
    exitCode,
  };
}

/* ============================== 真壳冒烟 ============================== */

/**
 * 给冒烟输出定性（判定**以 rc 为准**）：✅ 只用于读数，rc≠0 时不能把红洗绿；
 * rc=2 + 前置文案（无游戏目录 / 端口占用 / dev 地址解析失败）= `blocked`（没得跑），
 * 其余非 0 = `fail`。返回 `{ verdict: 'pass'|'fail'|'blocked', reason }`。
 */
export function classifySmokeOutput(text = '', rc = null) {
  const clean = stripAnsi(text);
  const numericRc = Number(rc);
  const green = /✅\s*tauri\s*(?:DOM|IPC)\s*(?:smoke\s+passed|冒烟全部通过)/.test(clean);
  const red = /❌\s*tauri\s*(?:DOM|IPC)\s*(?:smoke\s+failed|冒烟存在失败项)/.test(clean);
  const unmet = /\[smoke\]\s*未满足：([^\n]+)/.exec(clean)?.[1] ?? null;
  const corpus = /❌\s*游戏目录不存在：([^\n]+)/.exec(clean)?.[1] ?? null;
  const ports = /\[smoke\]\s*端口已被占用：([^\n]+)/.exec(clean)?.[1] ?? null;
  const devTarget = /\[smoke\]\s*dev 地址解析失败：([^\n]+)/.exec(clean)?.[1] ?? null;
  // 起壳前的前置闸（断言①底色真源读不到等）：rc=2 时要把具体原因带出来，不只报「rc=2」。
  const precheck = /\[smoke\]\s*((?:断言①底色真源塌了|端口已被占用|dev 地址解析失败)[^\n]*)/.exec(clean)?.[1] ?? null;
  const summary = /共\s*(\d+)\s*项[；;]\s*FAIL\s*(\d+)/.exec(clean);
  const failLine =
    clean
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /^FAIL\s+\S+/.test(line)) ?? null;

  const detail = [unmet, corpus, ports, devTarget, precheck, failLine].filter(Boolean).join(' ｜ ');

  if (green && numericRc === 0) {
    return {
      verdict: 'pass',
      reason: summary === null ? '输出判绿' : `共 ${summary[1]} 项；FAIL ${summary[2]}`,
    };
  }
  if (green && numericRc !== 0) {
    return {
      verdict: 'fail',
      reason: `输出自称通过但 rc=${Number.isFinite(numericRc) ? numericRc : rc}（以 rc 为准）`,
    };
  }
  if (red) {
    return { verdict: 'fail', reason: detail || `rc=${numericRc}（输出判红但未打出具体项）` };
  }
  if (numericRc === 2) {
    return {
      verdict: 'blocked',
      reason: detail || 'rc=2（前置不满足：无桌面会话 / 端口被占 / 无游戏语料），输出未给细节',
    };
  }
  return {
    verdict: 'fail',
    reason: detail || firstLine(clean) || `rc=${Number.isFinite(numericRc) ? numericRc : rc} 且输出无法归类`,
  };
}

/** 超时收尸：Windows 走 taskkill /T（vite 与 WebView2 会挂到树外），POSIX 杀进程组 */
function defaultKillTree(child) {
  if (!child?.pid) return;
  try {
    if (IS_WINDOWS) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    // 收尸失败不掩盖超时本身：调用方仍按 timedOut 记 rc=124
  }
}

/** 真 runner：spawn + 超时杀进程树 + 捕获 stdout/stderr（不落盘） */
export function createProcessRunner({ spawnImpl = spawn, killTree = defaultKillTree } = {}) {
  return function run({ command, args = [], cwd = ROOT, timeoutMs = 0, env }) {
    return new Promise((resolve) => {
      const started = Date.now();
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let timer = null;

      const finish = (rc) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve({
          rc: timedOut ? 124 : Number.isInteger(rc) ? rc : 1,
          stdout,
          stderr,
          timedOut,
          ms: Date.now() - started,
        });
      };

      let child;
      try {
        child = spawnImpl(command, args, {
          cwd,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...(env ?? {}) },
        });
      } catch (error) {
        stderr = `[lang-ux-matrix] spawn 失败：${error instanceof Error ? error.message : String(error)}`;
        finish(127);
        return;
      }

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', (error) => {
        stderr += `\n[lang-ux-matrix] spawn 失败：${error instanceof Error ? error.message : String(error)}`;
        finish(127);
      });
      child.on('close', (code) => finish(typeof code === 'number' ? code : 1));

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          killTree(child);
          setTimeout(() => finish(1), 5000);
        }, timeoutMs);
      }
    });
  };
}

/**
 * 真跑两项壳冒烟。runner 可注入（单测用假 runner，不动桌面会话）。
 * 每个读数固定带 `{ id, command, rc, ms, timedOut, verdict, reason, tail }`。
 */
export async function runShellReadings({
  run = createProcessRunner(),
  root = ROOT,
  timeoutMs = {},
  log = () => {},
} = {}) {
  const items = [];
  for (const spec of SHELL_SMOKES) {
    log(`[lang-ux-matrix] 真跑 ${spec.id}（${spec.why}）…`);
    const started = Date.now();
    let raw;
    try {
      raw = await run({
        id: spec.id,
        command: NODE,
        args: [path.join(root, spec.rel)],
        cwd: root,
        timeoutMs: timeoutMs[spec.id] ?? spec.timeoutMs,
      });
    } catch (error) {
      raw = {
        rc: 127,
        stdout: '',
        stderr: `[lang-ux-matrix] runner 抛错：${error instanceof Error ? error.message : String(error)}`,
        timedOut: false,
      };
    }
    const ms = Number.isFinite(raw?.ms) ? Math.max(0, Math.round(raw.ms)) : Math.max(0, Date.now() - started);
    const rc = raw?.timedOut === true ? 124 : Number(raw?.rc ?? 1);
    const text = `${raw?.stdout ?? ''}\n${raw?.stderr ?? ''}`;
    const verdict = classifySmokeOutput(text, rc);
    items.push({
      id: spec.id,
      command: spec.command,
      rc,
      ms,
      timedOut: raw?.timedOut === true,
      verdict: verdict.verdict,
      reason: verdict.reason,
      tail: tailLines(text, 16),
    });
    log(`[lang-ux-matrix] ${spec.id}: rc=${rc} ${Math.round(ms / 1000)}s → ${verdict.verdict}（${verdict.reason}）`);
  }
  return {
    requested: true,
    items,
    exitCode: items.every((item) => item.verdict === 'pass') ? 0 : 1,
    note: '真跑读数：rc 为准；blocked = 前置不满足（原因逐字见 reason），不当通过',
  };
}

/* ============================== CLI ============================== */

export const USAGE = [
  '用法：node tools/lang-ux-matrix.mjs [选项]',
  '',
  '选项：',
  '  --json                  stdout 只输出机器可读 JSON（schemaVersion=1）',
  '  --shell                 真跑两项真壳冒烟（tools/smoke-tauri-dom.mjs / tools/smoke-tauri-ipc.mjs），',
  '                          读数（rc/ms/verdict/失败原因）写进 readings.shell；默认不跑',
  '  --shell-timeout=<ms>    覆盖每项冒烟的超时（默认 dom 240s / ipc 360s）',
  '  -h, --help              显示本帮助',
  '',
  'automated = 矩阵自证 1 项 + 两语言 × 21 能力（20 项 Monaco 能力 + 面包屑宿主面）。',
  '  - 证据：注册行 / 装配行 / language-parity.test.ts 档位清单与豁免清单 / 单测文件与 it 名；',
  '  - 矩阵标 { exempt } 的项记 SKIP，理由逐字来自源码；其余取不到证据一律 FAIL。',
  'manual = 交付面 × 两语言的人工步骤（折叠手感 / Peek / 引用面板 / 格式化光标 / snippet 插入…）。',
  '',
  '退出码：0 = automated 全绿（--shell 时冒烟也全 pass）；1 = 有失败；2 = 用法错误。',
  '',
  'WIRING（本批不改 release-gate.mjs）：接线时只需在 DEFAULT_ITEMS 追加一项',
  '  nodeItem(\'lang-ux\', \'tools/lang-ux-matrix.mjs\', [\'--json\'], \'core\', TIMEOUT.tests, parseLangUxMatrix)',
  '并把 \'lang-ux\' 加进 RELEASE_ITEM_IDS 即可；本工具自带 --json / rc / 读数，release-gate 只需透传。',
].join('\n');

export function parseArgs(argv = []) {
  const options = { json: false, shell: false, shellTimeout: null, help: false };
  const errors = [];
  for (const arg of argv) {
    if (arg === '--json') options.json = true;
    else if (arg === '--shell') options.shell = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--shell-timeout=')) {
      const value = Number(arg.slice('--shell-timeout='.length));
      if (!Number.isInteger(value) || value <= 0) errors.push(`--shell-timeout= 需要一个正整数毫秒值（收到 ${arg}）`);
      else options.shellTimeout = value;
    } else errors.push(`未知参数：${arg}`);
  }
  return { options, errors };
}

function pad(text, width) {
  const value = String(text);
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/** 人类可读输出：automated 逐项一行、manual 逐项列步骤、shell 读数原样 */
export function renderHuman(report) {
  const lines = [];
  lines.push(`K2 LANG-UX-MATRIX（schema ${report.schemaVersion}）${report.generatedAt}`);
  lines.push(
    `语言：${LANGUAGES.map((language) => `${language.id}=${language.label}`).join(' / ')}`,
  );
  lines.push(
    `automated：${report.automated.pass} pass / ${report.automated.fail} fail / ${report.automated.skip} skip` +
      `（共 ${report.automated.items.length} 项 = 矩阵自证 1 + 2 语言 × ${CAPABILITIES.length} 能力）`,
  );
  lines.push(`manual：${report.manual.length} 项（真壳步骤；豁免面 ${report.readings.manualGaps.length} 项见 readings.manualGaps）`);
  lines.push('');

  lines.push('— automated —');
  for (const item of report.automated.items) {
    const mark = item.status === 'pass' ? '✅' : item.status === 'fail' ? '❌' : '⏭';
    const tier = item.tier === null ? '?' : item.tier;
    const detail =
      item.status === 'pass'
        ? item.evidence[0] ?? ''
        : item.status === 'skip'
          ? `SKIP 理由：${item.reason}`
          : item.reason;
    lines.push(`${mark} ${pad(item.id, 26)} [${pad(tier, 7)}] ${detail}`);
  }

  lines.push('');
  lines.push('— manual（真壳人工步骤）—');
  for (const item of report.manual) {
    lines.push(`${item.id}（读数：${item.expected}）`);
    item.steps.forEach((step, index) => lines.push(`   ${index + 1}) ${step}`));
  }

  lines.push('');
  lines.push('— 真壳冒烟 —');
  const shell = report.readings.shell;
  if (!shell.requested) {
    lines.push(shell.note);
  } else {
    for (const item of shell.items) {
      lines.push(
        `${item.verdict === 'pass' ? '✅' : item.verdict === 'blocked' ? '⏸' : '❌'} ${item.id}: rc=${item.rc} ${Math.round(item.ms / 1000)}s → ${item.verdict}（${item.reason}）`,
      );
      if (item.tail.length > 0) {
        for (const line of item.tail.split('\n').slice(-4)) lines.push(`   ${line}`);
      }
    }
  }

  lines.push('');
  lines.push(`RESULT: ${report.exitCode === 0 ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

/**
 * CLI 入口。默认只做 automated/manual（毫秒级）；`--shell` 才真起两项壳冒烟。
 * 被 vitest import 时不执行（下方 guard 用 `import.meta.url` 对 `process.argv[1]`）。
 */
export async function main(argv = process.argv.slice(2)) {
  const { options, errors } = parseArgs(argv);
  if (errors.length > 0) {
    console.error(`[lang-ux-matrix] ${errors.join('；')}`);
    console.error(USAGE);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  let shell = null;
  if (options.shell) {
    const timeoutMs =
      options.shellTimeout === null
        ? {}
        : Object.fromEntries(SHELL_SMOKES.map((spec) => [spec.id, options.shellTimeout]));
    shell = await runShellReadings({ timeoutMs, log: (message) => console.error(message) });
  }
  const report = evaluateMatrix({ shell });
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderHuman(report)}\n`);
  return report.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(await main());
}

