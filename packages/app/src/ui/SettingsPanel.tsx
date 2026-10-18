import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import { useSyncExternalStore } from 'react';
import { MARKET_DEFAULT_INDEX_URL } from '@kojo/plugin-api';
import type { LayoutAction } from './layout';
import { setSealed } from './sealed';
import { setDirectMode } from './direct-mode';
import { setPanelVirtualize } from './panel-prefs';
import { setNameColorPref } from './semantic-color-pref';
import { SUGGEST_DELAY_MAX, SUGGEST_DELAY_MIN, SUGGEST_DELAY_STEP } from './suggest-pref';
import { AUTOSAVE_IDLE_MS, setAutosavePref, type AutosaveMode } from './autosave-pref';
import {
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_ZOOM_DEFAULT,
  resetFontZoomPref,
  stepFontSizePref,
} from './font-size-pref';
import type { MotionPref } from './motion-pref';
import {
  GLASS_TRANSPARENCY_DEFAULT,
  GLASS_TRANSPARENCY_MAX,
  GLASS_TRANSPARENCY_MIN,
  GLASS_TRANSPARENCY_STEP,
  stepGlassTransparencyPref,
} from './glass-pref';
import { THEME_IDS, setThemePref, type ThemePref } from './theme-pref';
import {
  loadLayoutPref,
  saveColumnSelectionPref,
  saveMultiCursorModifierPref,
  saveWordWrapPref,
  subscribeLayoutPref,
  type MultiCursorModifierPref,
  type WordWrapPref,
} from './layout-pref';
import {
  hintClassFor,
  isDraftNoop,
  sourceRowUi,
  type MarketSourceView,
} from './market-source';
import { isUpdateBusy, type UpdatePhase, type UpdateStatusTone } from './update-check';
import { Icon, type IconName } from './icons';
import { Switch } from './Switch';
import { nextRovingIndex } from './shell-keys';
import { KeybindingsPage } from './KeybindingsPage';
import type { CommandEntry } from './commands';
import avatarUrl from '../assets/developer-avatar-128.png';
import { CONTACT_EMAIL, CONTACT_MAILTO } from './contact';
import { loadFormatRulesPref, saveFormatRulesPref, type FormatRules } from './format-pref';

/** 主题选择器的人类标签（作者面：不出现 id / token 这类机器词） */
const THEME_LABELS: Record<ThemePref, string> = {
  dark: '深色',
  light: '浅色',
  'mint-dark': '薄荷',
};

/**
 * 排版偏好的设置页选项（P2-16）。值 = `layout-pref.ts` 的登记名（与 Monaco 0.57 d.ts
 * 逐字一致，落到编辑器前零翻译）；顺序即段落后选项的顺序，折行缺省第一项。
 */
const WORD_WRAP_CHOICES: readonly { value: WordWrapPref; label: string }[] = [
  { value: 'tier', label: '跟随体量档' },
  { value: 'on', label: '强制开' },
  { value: 'off', label: '强制关' },
];

const MULTI_CURSOR_CHOICES: readonly { value: MultiCursorModifierPref; label: string }[] = [
  { value: 'ctrlCmd', label: 'Ctrl/Cmd' },
  { value: 'alt', label: 'Alt' },
];

/**
 * 设置浮层的入参（2026-10-17 FE-REF 拆分批：随设置页 markup 一起从 `ShellLayout.tsx` 搬出）。
 *
 * **这里只有值与回调，没有状态**：设置页各项偏好的镜像值（含「开面板时重读一次」那几个
 * effect）全部留在常驻的 `ShellLayout` 里——本组件是条件挂载的浮层，把状态搬进来就等于
 * 改动偏好的读写时机（铁律级别的行为差异）。写偏好、发意图事件同样走 `ShellLayout` 的
 * 既有回调，本组件只负责排版。
 *
 * 唯一的例外是「看哪一节」的导航选中态（`active`）：它不落盘、不影响任何偏好，允许作为
 * 本组件内部的 `useState`。Esc 关窗仍由 `ShellLayout` 的全局键盘（`resolveEscLayer` 的
 * settings 层）承接，本组件不自建监听。
 */
export interface SettingsPanelProps {
  /** 关闭浮层：遮罩点击、右上 ✕ 与页脚「完成」共用这一个入口（开关真源仍是壳层的 settingsOpen） */
  onClose: () => void;
  /**
   * 打开时定位到哪一节（缺省 `general`）。纯呈现层参数：只决定导航栏初始选中项，
   * 不读写任何偏好。快捷键页上线后壳层可传 `'keybindings'` 直达那一节。
   */
  initialSection?: SettingsSectionId;

  /**
   * 统一命令注册表（壳层命令 + 插件贡献）。只有「快捷键」一节消费它——
   * 那一页的行数据全部由 `buildKeybindingRows(commands)` 现算，本页不含键位判据。
   */
  commands: readonly CommandEntry[];

  /* ---- 视图 / 布局带 ---- */
  /** 写作模式（禅态）：切换与退出都派发 layout reducer，本组件不另存一份 */
  zen: boolean;
  zenLimitWidth: boolean;
  dispatch: (action: LayoutAction) => void;
  /** 「重置布局」：清持久化并回落默认编排（真源是壳层的 doReset） */
  onResetLayout: () => void;

  /* ---- 外观带 ---- */
  themePref: ThemePref;
  motionPref: MotionPref;
  commitMotionPref: (pref: MotionPref) => void;
  panelVirtualize: boolean;
  glassTransparency: number;

  /* ---- 封存功能带（总闸读数） ---- */
  sealed: boolean;

  /* ---- 编辑器带 ---- */
  nameColorOn: boolean;
  fontSize: number;
  fontZoom: number;
  /** 输入时自动弹出补全（quickSuggestions）总开关；真源 `suggest-pref.ts`，默认开 */
  quickSuggestionsOn: boolean;
  commitQuickSuggestions: (on: boolean) => void;
  /** 文档词补全（wordBasedSuggestions 语义）总开关；真源 `suggest-pref.ts`，默认开 */
  wordSuggestionsOn: boolean;
  commitWordSuggestions: (on: boolean) => void;
  /** 补全弹出延迟读数（ms，0 = 立即）；真源是 `suggest-pref.ts` 的 localStorage */
  suggestDelay: number;
  /** 写补全弹出延迟（壳层落 `saveSuggestDelayPref`；订阅表把新值推回本页） */
  commitSuggestDelay: (ms: number) => void;
  sugarViewOn: boolean;
  applySugarViewPref: (on: boolean) => void;
  formatOnSave: boolean;
  commitFormatOnSave: (on: boolean) => void;
  codeLensOn: boolean;
  commitCodeLens: (on: boolean) => void;
  autosaveMode: AutosaveMode;
  directMode: boolean;

  /* ---- 口上市场带 ---- */
  marketSource: MarketSourceView | null;
  marketEndpointDraft: string;
  setMarketEndpointDraft: (value: string) => void;
  saveMarketEndpoint: () => Promise<void>;
  /** 「恢复默认」：壳层侧走既有 reset 通路后回写读数与草稿框 */
  resetMarketEndpoint: () => Promise<void>;

  /* ---- 更新带 ---- */
  appVersion: string | null;
  updatePhase: UpdatePhase;
  updateStatusLine: { text: string; tone: UpdateStatusTone } | null;
  runUpdateCheck: () => Promise<void>;
  installUpdate: () => Promise<void>;
}

/**
 * 设置浮层的节 id（左导航栏一项 = 一节）。`keybindings` 先写进联合类型占位：
 * 快捷键页由下一批（b/kbset）追加，届时往 `SETTINGS_SECTIONS` 里加一条即可，
 * 联合类型与外壳零改动。
 */
export type SettingsSectionId = 'general' | 'appearance' | 'editor' | 'market' | 'about' | 'keybindings';

/**
 * 一节 = 导航栏一项 + 右面板内容。`render` 无参：它闭包捕获 `SETTINGS_SECTIONS` 的 props 形参，
 * 所以九组条目的读写表达式与搬运前逐字一致。返回 `null` 表示这一节当前没有可显示内容 ⇒
 * 导航栏不显示这一项（本仓房规：不给一个点了没反应的入口）。
 */
export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  icon: IconName;
  render: () => ReactElement | null;
}

/**
 * 节的清单（模块级导出常量 = 下一批的扩展点）。
 *
 * 形态是「props 进、`SettingsSection[]` 出」的工厂：这样 `render()` 保持无参（闭包捕获 props），
 * 而九组条目的 JSX 与 class 逐字照搬自原 `SettingsPanel` 主体，只是从「一条长滚动列」拆挂到各自
 * 的节下。**追加一节 = 在数组里加一个对象字面量**（`id` / `label` / `icon` / `render`），
 * 导航栏、roving tabindex、空节隐藏、切节滚回顶部全部自动跟上。
 *
 * 数组顺序 = 导航栏自上而下的顺序。
 */
export const SETTINGS_SECTIONS: (props: SettingsPanelProps) => SettingsSection[] = (props) => {
  const {
    commands,
    zen,
    zenLimitWidth,
    dispatch,
    onResetLayout,
    themePref,
    motionPref,
    commitMotionPref,
    panelVirtualize,
    glassTransparency,
    sealed,
    nameColorOn,
    fontSize,
    fontZoom,
    quickSuggestionsOn,
    commitQuickSuggestions,
    wordSuggestionsOn,
    commitWordSuggestions,
    suggestDelay,
    commitSuggestDelay,
    sugarViewOn,
    applySugarViewPref,
    formatOnSave,
    commitFormatOnSave,
    codeLensOn,
    commitCodeLens,
    autosaveMode,
    directMode,
    marketSource,
    marketEndpointDraft,
    setMarketEndpointDraft,
    saveMarketEndpoint,
    resetMarketEndpoint,
    appVersion,
    updatePhase,
    updateStatusLine,
    runUpdateCheck,
    installUpdate,
  } = props;

  return [
    {
      id: 'general',
      label: '通用',
      icon: 'layout-sidebar-left',
      render: () => (
        <>
          <div className="settings-group">
            <div role="heading" aria-level={4} className="settings-group-title">视图</div>
            <label className="settings-row">
              <Switch
                checked={zen}
                onChange={(c) => dispatch(c ? { type: 'toggleZen' } : { type: 'exitZen' })}
                label="写作模式"
              />
              <span>
                写作模式
                <span className="settings-hint">收起所有面板，只留编辑器。快捷键 Ctrl+K Z，Esc 退出</span>
              </span>
            </label>
            {/* 居中限宽只在写作模式下有意义——非写作模式时它**什么都控制不了**，
                所以不是"灰着好看"，而是不给一个点了没反应的控件。 */}
            <label className={`settings-row nested${zen ? '' : ' off'}`}>
              <Switch
                checked={zenLimitWidth}
                disabled={!zen}
                onChange={(c) => dispatch({ type: 'setZenLimitWidth', value: c })}
                label="编辑器居中限宽"
              />
              <span>
                编辑器居中限宽
                <span className="settings-hint">
                  {zen
                    ? '按一行正文的舒适宽度收拢；关闭则铺满整个窗口'
                    : '需要先开启写作模式'}
                </span>
              </span>
            </label>
          </div>

          {/* 封存总闸（sealed.ts，2026-10-13 试用反馈批）：两只暂不投入的面板整体封存，
              设置页只留这一个总开关；勾选 = 临时恢复（代码未删，随时可以再关）。
              管辖清单只有 `SEALED_PANEL_IDS` 上那两个 id——「.kojo 预览」已交付为常态功能，
              2026-10-14 起不在其内（它的开关常驻下面那个「编辑器」组，不随本总闸收起）。 */}
          <div className="settings-group">
            <div role="heading" aria-level={4} className="settings-group-title">封存功能</div>
            <label className="settings-row">
              <Switch checked={!sealed} onChange={(c) => setSealed(!c)} label="显示已封存功能" />
              <span>
                显示已封存功能
                <span className="settings-hint">
                  .kojo 转译检查 · 归档浏览器：试用反馈后已封存，默认隐藏。勾选可临时恢复；代码未删，随时可以再关。
                </span>
              </span>
            </label>
          </div>

          <div className="settings-group">
            <div role="heading" aria-level={4} className="settings-group-title">布局</div>
            <div className="settings-row static">
              <button className="ghost small" onClick={onResetLayout}>
                重置布局
              </button>
              <span>
                恢复默认的面板位置、尺寸与显隐
                <span className="settings-hint">不影响任何文件内容</span>
              </span>
            </div>
          </div>
        </>
      ),
    },
    {
      id: 'appearance',
      label: '外观',
      icon: 'preview',
      render: () => (
        /* 动效（UI-5）：应用内的降噪开关，独立于系统级 prefers-reduced-motion */
        <div className="settings-group">
          <div role="heading" aria-level={4} className="settings-group-title">外观</div>
          {/* 主题（2026-10-17 主题系统）：分段单选，缺省深色。翻档即写 data-theme、
              全场 token 当场重算（与动效/毛玻璃同款即时生效），只改显示、不动文件。 */}
          <div className="settings-row static">
            <span className="theme-segment" role="radiogroup" aria-label="主题">
              {THEME_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={themePref === id}
                  className={`theme-seg-btn${themePref === id ? ' on' : ''}`}
                  onClick={() => setThemePref(id)}
                >
                  {THEME_LABELS[id]}
                </button>
              ))}
            </span>
            <span>
              主题
              <span className="settings-hint">深色为缺省（蓝灰），另有浅色、薄荷暗色；一翻即全场生效，只改显示、不动文件</span>
            </span>
          </div>
          <label className="settings-row">
            <Switch
              checked={motionPref === 'reduced'}
              onChange={(c) => commitMotionPref(c ? 'reduced' : 'full')}
              label="减弱动效"
            />
            <span>
              减弱动效
              <span className="settings-hint">收起面板过渡与入场动画，界面切换更干脆。系统级「减弱动效」设置仍会照常生效</span>
            </span>
          </label>
          {/* 面板渲染偏好（panel-prefs.ts，2026-10-14 面板偏好批）：与「减弱动效」同组、
              一直可见（不随封存总闸收起——它是稳定可用的渲染选项，不是试用中的功能）。 */}
          <label className="settings-row">
            <Switch checked={panelVirtualize} onChange={setPanelVirtualize} label="长列表视口化" />
            <span>
              长列表视口化
              <span className="settings-hint">
                只渲染屏幕上看得到的行（滚出即撤、滚入即建）：大角色首次打开不再有一次性卡顿。关掉则一次全渲染。
              </span>
            </span>
          </label>
          {/* 毛玻璃透明度（glass-pref.ts）：与字号步进器同款排版（− 读数 ＋）。透明度越高，
              浮层与教程目录越通透；调到 0% 即实心档，撤掉磨砂回到不透明面。只改显示、不动文件。 */}
          <div className="settings-row static" role="group" aria-label="毛玻璃透明度">
            <span className="settings-stepper">
              <button
                className="ghost small"
                onClick={() => stepGlassTransparencyPref(-1)}
                disabled={glassTransparency <= GLASS_TRANSPARENCY_MIN}
                title="更实心"
                aria-label="降低毛玻璃透明度"
              >
                −
              </button>
              <span className="settings-stepper-value">{glassTransparency}%</span>
              <button
                className="ghost small"
                onClick={() => stepGlassTransparencyPref(1)}
                disabled={glassTransparency >= GLASS_TRANSPARENCY_MAX}
                title="更通透"
                aria-label="提高毛玻璃透明度"
              >
                ＋
              </button>
            </span>
            <span>
              毛玻璃透明度
              <span className="settings-hint">
                浮层与教程目录的磨砂通透程度，默认 {GLASS_TRANSPARENCY_DEFAULT}%（每档 {GLASS_TRANSPARENCY_STEP}%）。
                调到 0% 即实心、关掉磨砂。只改显示、不动文件
              </span>
            </span>
          </div>
        </div>
      ),
    },
    {
      id: 'editor',
      label: '编辑器',
      icon: 'code',
      render: () => (
        <>
          {/* 「编辑器」组不再随总闸收起：这一组里的 .kojo 预览是已交付的常态功能，
              默认关 ⇒ 这一行（连同快捷键 Ctrl+Alt+T）就是它的正式入口。 */}
          <div className="settings-group">
            <div role="heading" aria-level={4} className="settings-group-title">编辑器</div>
            {/* 字号 / 缩放（A1）：真源与钳制在 font-size-pref.ts，这里只排版。
                禁用位 = 已到量程两端，与「没改动⇒按钮不可点」同一房规。 */}
            <div className="settings-row static" role="group" aria-label="正文字号">
              <span className="settings-stepper">
                <button
                  className="ghost small"
                  onClick={() => stepFontSizePref(-1)}
                  disabled={fontSize <= FONT_SIZE_MIN}
                  title="减小字号"
                  aria-label="减小字号"
                >
                  −
                </button>
                <span className="settings-stepper-value">{fontSize} px</span>
                <button
                  className="ghost small"
                  onClick={() => stepFontSizePref(1)}
                  disabled={fontSize >= FONT_SIZE_MAX}
                  title="增大字号"
                  aria-label="增大字号"
                >
                  ＋
                </button>
              </span>
              <span>
                正文字号
                <span className="settings-hint">
                  编辑器里一行字的大小，默认 {FONT_SIZE_DEFAULT}。只改显示、不动文件
                </span>
              </span>
            </div>
            <div className="settings-row static">
              <button className="ghost small" onClick={resetFontZoomPref} disabled={fontZoom === FONT_ZOOM_DEFAULT}>
                重置缩放
              </button>
              <span>
                文字缩放（当前 {100 + fontZoom * 10}%）
                <span className="settings-hint">
                  Ctrl+= 放大一档、Ctrl+- 缩小一档（每档 10%）、Ctrl+0 复原；缩放叠在字号上，两者都会记住
                </span>
              </span>
            </div>
            {/* 快建议 / 文档词两个总开关（QSUG-2）：真源与订阅在 suggest-pref.ts，
                这里只排版。默认都开（对标 VS Code / IDEA）；台词 / 旁白 / 注释 / 字符串
                与只读 / 预览不靠这两个开关降噪，位置门各自负责。 */}
            <label className="settings-row">
              <Switch
                checked={quickSuggestionsOn}
                onChange={commitQuickSuggestions}
                label="输入时自动弹出补全"
              />
              <span>
                输入时自动弹出补全
                <span className="settings-hint">
                  写到代码位就边打边弹；.kojo 的台词 / 旁白 / 注释与 .erb 的注释 / 字符串里不弹，
                  只读文件与 .kojo 预览始终不弹。默认开
                </span>
              </span>
            </label>
            <label className="settings-row">
              <Switch
                checked={wordSuggestionsOn}
                onChange={commitWordSuggestions}
                label="文档词补全"
              />
              <span>
                文档词补全
                <span className="settings-hint">
                  除上下文候选外，再从当前文件里补同前缀的词；只在代码位弹，台词 / 旁白 / 注释里不弹。
                  超过 5,000 行的文件不提供。默认开
                </span>
              </span>
            </label>
            {/* 补全弹出延迟（SUGGEST-2B）：真源与钳制在 suggest-pref.ts，这里只排版。
                − / ＋ 每档 100ms；0 显示「立即」= 打字即弹（默认，保持旧体感）。
                观察者每次排程现读 ⇒ 改完下一次击键即生效，不用重开文件。 */}
            <div className="settings-row static" role="group" aria-label="补全弹出延迟">
              <span className="settings-stepper">
                <button
                  className="ghost small"
                  onClick={() => commitSuggestDelay(suggestDelay - SUGGEST_DELAY_STEP)}
                  disabled={suggestDelay <= SUGGEST_DELAY_MIN}
                  title="更快弹出"
                  aria-label="减少补全弹出延迟"
                >
                  −
                </button>
                <span className="settings-stepper-value">
                  {suggestDelay === SUGGEST_DELAY_MIN ? '立即' : `${suggestDelay} ms`}
                </span>
                <button
                  className="ghost small"
                  onClick={() => commitSuggestDelay(suggestDelay + SUGGEST_DELAY_STEP)}
                  disabled={suggestDelay >= SUGGEST_DELAY_MAX}
                  title="更慢弹出"
                  aria-label="增加补全弹出延迟"
                >
                  ＋
                </button>
              </span>
              <span>
                补全弹出延迟
                <span className="settings-hint">
                  停手后多久弹出候选；0 = 打字即弹；只改补全时机、不动文件
                </span>
              </span>
            </div>
            <label className="settings-row">
              <Switch checked={sugarViewOn} onChange={applySugarViewPref} label=".kojo 预览" />
              <span>
                .kojo 预览
                <span className="settings-hint">
                  把游戏目录里的 .ERB 显示成中文表层写法（台词像剧本、条件成「如果 …：」）。
                  只改显示、不改动文件。默认关；快捷键 Ctrl+Alt+T
                </span>
              </span>
            </label>
            {/* 保存时整理空白（E2，2026-10-15 格式化批）：手动版是 Shift+Alt+F，本开关
                只是把同一次整理挂到保存前。默认关的理由写在 `format-pref.ts`：改的正是空白，
                而语料里的全角空格多数是有意的排版。文案回避内部术语（不上「糖」字）。 */}
            <label className="settings-row">
              <Switch checked={formatOnSave} onChange={commitFormatOnSave} label="保存时整理空白" />
              <span>
                保存时整理空白
                <span className="settings-hint">
                  存盘前把行首与注释里的全角空格折成半角、统一 .kojo 的缩进写法。
                  台词正文、行尾风格与文件编码都不动；整理是一次可撤销的改动。默认关，
                  手动整理随时可用 Shift+Alt+F
                </span>
              </span>
            </label>
            {/* 格式化规则开关（P2-14）：整理规则从"全开、零可配"扩成逐条可关。真源
                `format-pref.ts` 的新键 `kojo.ui.formatRules.v1`（老键 kojo.ui.formatOnSave.v1
                口径不动；新键缺席 = 两条全开 = 与从前逐字一致）。作用面：手动整理
                Shift+Alt+F 与保存时整理都**落盘/组请求前现读**这两条开关；区间与打字
                整理保持全开（逐次按键上跑归一不合身——明说的边界，不是漏接）。 */}
            <FormatRulesRows />
            {/* 行上内联注解（B8，2026-10-16）：往正文里插行的能力，默认关的理由写在
                `code-lens-pref.ts`。文案刻意不上「CodeLens / 反向索引」这类机器词，
                并且把"没标注 ≠ 没人用"这条最容易读反的口径当场说清（铁律 4：不静默、也不误导）。 */}
            <label className="settings-row">
              <Switch checked={codeLensOn} onChange={commitCodeLens} label="标注函数被谁调用" />
              <span>
                标注函数被谁调用
                <span className="settings-hint">
                  在函数开头那一行的上方写一句「被 N 处用到」，点一下跳到第一处用到它的地方；满项目都在用的系统函数写作「1000+」。
                  没找到出处的函数不写这一句——那只代表编辑器证明不了，不代表真的没人调用。
                  太长或函数太密的文件整份不标注。只改显示、不动文件；默认关
                </span>
              </span>
            </label>
            {/* 结构化着色（B6，2026-10-16）：判据来自解析器而不是正则，宿主只翻译协议。
                文案按本仓口径去黑话——不写「语义高亮 / semantic token」，写作者看得懂的效果。
                默认关的理由见 `semantic-color-pref.ts`：它会顶掉作者看惯的词法配色。 */}
            <label className="settings-row">
              <Switch checked={nameColorOn} onChange={setNameColorPref} label="定义与调用的名字分色" />
              <span>
                定义与调用的名字分色
                <span className="settings-hint">
                  同一个函数名，在「它被定义的那一行」与「它被调用的地方」显示成两种颜色；
                  .kojo 里的函数、别名、常量名字同理。只改显示、不动文件；
                  超过 5,000 行的文件不生效（与粘性滚动同一档降级）。默认关
                </span>
              </span>
            </label>
            {/* 自动保存（A6，2026-10-20）：写盘只复用既有 save 一条路（全局互斥 + 写允许域闸门）；
                默认关的理由 = 游戏目录是部署目标，静默写盘必须是显式选择。护栏见 autosave-pref.decideAutosave。 */}
            <label className="settings-row">
              <Switch
                checked={autosaveMode === 'afterDelay'}
                onChange={(c) => setAutosavePref(c ? 'afterDelay' : 'off')}
                label="自动保存"
              />
              <span>
                自动保存
                <span className="settings-hint">
                  当前标签停手 {AUTOSAVE_IDLE_MS / 1000} 秒后自动落盘，走的是与 Ctrl+S 完全同一条保存路（同样的写权限闸、保存告警、外部改动确认）。
                  有未决的保存告警 / 外部改动、或正显示 .kojo 预览时**不会**自动存。默认关
                </span>
              </span>
            </label>
            {/* 排版三行（P2-16）：折行 / 多光标修饰键 / 列选择。自订阅 layout-pref，
                壳层镜像行归 P2-14 的接线批——两边各占一小段，互不重排。 */}
            <LayoutPrefRows />
          </div>

          {/* 直连模式开关：仍经封存总闸控制——封存态不渲染（本功能尚未交付为常态） */}
          {!sealed ? (
            <div className="settings-group">
              <div role="heading" aria-level={4} className="settings-group-title">游戏目录写入</div>
              <label className="settings-row">
                <Switch checked={directMode} onChange={setDirectMode} label="直连模式（就地编辑游戏目录）" />
                <span>
                  直连模式（就地编辑游戏目录）
                  <span className="settings-hint">
                    开启后，游戏目录里已获写权限的 .ERB 视为可直接编辑，不再逐个文件询问。写保护不变：写权限仍只来自你批准的可写目录。
                  </span>
                </span>
              </label>
            </div>
          ) : null}
        </>
      ),
    },
    {
      id: 'market',
      label: '口上市场',
      // 与活动栏的市场入口同一枚图标（店面，用户反馈 3）；book 是教程入口的，不是市场的
      icon: 'store',
      render: () => {
        /* 口上市场：注册表来源（KM-9）。**只有一个可编辑项**——代理既不做输入框也不做开关
           （受众大多没有代理客户端；且 JS 递进来的代理等于把白名单作废，见 market-source.ts）。
           这一组的每条判据（能不能保存、显示哪句话、三态着色）都住在 `market-source.ts`；
           这里只做排版。派生量算不出来就得重复调纯函数，所以整组包在 `render` 这一个本地
           作用域里（原主体的 IIFE 换成 render 函数体，判据逐字不变）。 */
        const row = sourceRowUi(marketSource);
        const canSave = row.canEdit && !isDraftNoop(marketEndpointDraft, row.address);
        return (
          <div className="settings-group">
            <div role="heading" aria-level={4} className="settings-group-title">口上市场</div>

            {/* 生效地址是**读数**，不是占位符：默认态也把那串地址摊开给人看（可复制、长串折行）。
                不加 `<a>`、不冒充链接——这不是"点出去看看"的东西，是"我现在用的是哪一个"。
                折行与收缩这两条只能就地写：样式表此刻由另一条线在改，本行不越界（见 §分工边界）。 */}
            <div className="settings-row static">
              <span style={{ minWidth: 0 }}>
                包列表来源
                <span className={hintClassFor(row.statusTone)}>{row.statusText}</span>
                {row.address !== '' ? (
                  <span className="settings-hint" style={{ overflowWrap: 'anywhere' }} title={row.address}>
                    {row.address}
                  </span>
                ) : null}
              </span>
            </div>

            {/* 草稿行：填的是"改成别的地址"，不是当前值的复读机；Tab 顺序 = 草稿框 → 保存 → 恢复默认 */}
            <div className={`settings-row static has-field${row.canEdit ? '' : ' off'}`}>
              <input
                className="settings-text"
                type="url"
                value={marketEndpointDraft}
                placeholder={MARKET_DEFAULT_INDEX_URL}
                spellCheck={false}
                aria-label="改成别的包列表地址"
                disabled={!row.canEdit}
                onChange={(e) => setMarketEndpointDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSave) void saveMarketEndpoint();
                }}
              />
              <span>
                改成别的地址
                <span className="settings-hint">
                  填一个新地址再点「保存」；不填就什么都不改。下载走系统网络设置，这里没有开关
                </span>
              </span>
              {/* 没改动 ⇒ 按钮本身不可点：禁用态就是"没什么可保存"最直白的表达，不用点完才知道 */}
              <button
                className="ghost small"
                disabled={!canSave}
                onClick={() => void saveMarketEndpoint()}
              >
                保存
              </button>
              {/* 覆盖态才出现的显式退路：点它 = 走既有 reset 通路回到默认，作者不必再猜"清空再保存" */}
              {row.showReset ? (
                <button
                  className="ghost small"
                  onClick={() => void resetMarketEndpoint()}
                >
                  恢复默认
                </button>
              ) : null}
            </div>

            {/* 回执独立成行、三态着色：成功、无改动、失败一眼能分，不再淹在说明文字的尾巴里 */}
            {row.note !== '' ? (
              <div className="settings-row static">
                <span className={hintClassFor(row.noteTone)} role="status">
                  {row.note}
                </span>
              </div>
            ) : null}
          </div>
        );
      },
    },
    {
      id: 'keybindings',
      label: '快捷键',
      icon: 'keyboard',
      render: () => <KeybindingsPage commands={commands} />,
    },
    {
      id: 'about',
      label: '关于',
      icon: 'info',
      render: () => (
        <>
          {/* 检查更新（REL-1 收尾 · REL-2）：状态机在 update-check.ts，行内三态而非弹窗。
              当前仓库尚未发布过 release，check() 现阶段必然 404——失败态是常态路径，
              必须可见可重试（见 runUpdateCheck 的 try-catch），绝不让按钮抛未捕获异常。 */}
          <div className="settings-group">
            <div role="heading" aria-level={4} className="settings-group-title">更新</div>
            <div className="settings-row static">
              <button
                className="ghost small"
                onClick={runUpdateCheck}
                disabled={isUpdateBusy(updatePhase)}
              >
                {updatePhase.kind === 'checking' ? '检查中…' : '检查更新'}
              </button>
              <span>
                当前版本 {appVersion !== null ? `v${appVersion}` : '未知'}
                {updateStatusLine ? (
                  <span
                    className={
                      updateStatusLine.tone === 'ok'
                        ? 'settings-hint is-ok'
                        : updateStatusLine.tone === 'err'
                          ? 'settings-hint is-err'
                          : 'settings-hint'
                    }
                  >
                    {updateStatusLine.text}
                  </span>
                ) : null}
              </span>
            </div>
            {updatePhase.kind === 'found' ? (
              <div className="settings-row static">
                <button className="primary small" onClick={installUpdate}>
                  下载并安装 v{updatePhase.version}
                </button>
                <span>
                  发现新版本 v{updatePhase.version}
                  <span className="settings-hint">下载安装完成后，重启应用生效</span>
                </span>
              </div>
            ) : null}
          </div>

          {/* 关于（REL-2）：开发者联系卡 + 意见反馈。外链用原生 <a target="_blank">——
              项目未装 opener/shell 插件，WebView2 会把新窗口请求交给系统默认浏览器，
              不为这事新增 Rust 依赖（最小改动面）。头像走本地打包资源（vite import 进
              构建产物），断网也能显示。 */}
          <div className="settings-group">
            <div role="heading" aria-level={4} className="settings-group-title">关于</div>
            <a
              className="settings-row settings-link"
              href="https://github.com/Poboking"
              target="_blank"
              rel="noreferrer"
            >
              <img
                className="settings-avatar"
                src={avatarUrl}
                alt=""
                width={32}
                height={32}
              />
              <span>
                Poboking
                <span className="settings-hint">开发者 · GitHub 主页</span>
              </span>
              <Icon name="popout" size={12} className="settings-link-icon" />
            </a>
            {/* 联系邮箱（2026-10-18 用户反馈 1）：贴开发者卡下面；原先那枚 15px 信封套在
                32px 圆标里，用户读着"图标太小、外面小圆圈突兀"⇒ 去掉圆标，只留一枚大小适中
                的 accent 信封，另给 32px 无框槽位与开发者卡的文字左轴对齐。mailto 不经
                WebView，直接交给系统邮件客户端；地址本身当主文案，方便直接读 / 抄。 */}
            <a className="settings-row settings-link" href={CONTACT_MAILTO}>
              <Icon name="mail" size={18} className="settings-link-mark" />
              <span>
                {CONTACT_EMAIL}
                <span className="settings-hint">联系邮箱 · 奇怪 Bug 与建议都可以直接邮件反馈</span>
              </span>
            </a>
            <a
              className="settings-row settings-link"
              href="https://github.com/Poboking/kojo-editor/issues"
              target="_blank"
              rel="noreferrer"
            >
              <span>
                意见反馈
                <span className="settings-hint">问题与建议请到 GitHub Issues 提出</span>
              </span>
              <Icon name="popout" size={12} className="settings-link-icon" />
            </a>
          </div>
        </>
      ),
    },
  ];
};

/**
 * 排版三行（P2-16）：折行三选一 / 多光标修饰键二选一 / 列选择开关。
 *
 * 自订阅 `layout-pref.ts`（`useSyncExternalStore`）而不走壳层 props 镜像：壳层那批
 * always-mounted 的偏好 effect 归 P2-14 的接线批，本线不越界改 `ShellLayout.tsx`；
 * 读与写都就地走同一份 localStorage 真源（`semantic-color-pref.ts` 订阅表同款）。
 * 设置页一翻即时生效——EditorPane 订同一张表，回调只补发这三个键。
 */
function LayoutPrefRows(): ReactElement {
  const pref = useSyncExternalStore(subscribeLayoutPref, loadLayoutPref);
  return (
    <>
      {/* 折行：三选一分段（复用主题分段那套 class，不造第二种分段控件）。
          缺省「跟随体量档」= 今天的行为：5,000 行以内开、50,000 行以上自动关。 */}
      <div className="settings-row static">
        <span className="theme-segment" role="radiogroup" aria-label="折行">
          {WORD_WRAP_CHOICES.map((c) => (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={pref.wordWrap === c.value}
              className={`theme-seg-btn${pref.wordWrap === c.value ? ' on' : ''}`}
              onClick={() => saveWordWrapPref(c.value)}
            >
              {c.label}
            </button>
          ))}
        </span>
        <span>
          折行
          <span className="settings-hint">
            长行留在窗内折行，还是伸出窗外横向滚动。跟随体量档：5,000 行以内开着，
            50,000 行以上自动关（那一档折行会拖慢滚动）；强制开 / 强制关则所有文件一个样。
            只改显示、不动文件
          </span>
        </span>
      </div>
      {/* 多光标修饰键：二选一分段。缺省 Ctrl/Cmd 的理由写在 layout-pref.ts 模块头。 */}
      <div className="settings-row static">
        <span className="theme-segment" role="radiogroup" aria-label="多光标修饰键">
          {MULTI_CURSOR_CHOICES.map((c) => (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={pref.multiCursorModifier === c.value}
              className={`theme-seg-btn${pref.multiCursorModifier === c.value ? ' on' : ''}`}
              onClick={() => saveMultiCursorModifierPref(c.value)}
            >
              {c.label}
            </button>
          ))}
        </span>
        <span>
          多光标修饰键
          <span className="settings-hint">
            按住哪个键点击正文，一次点出多个光标，几处一起改。默认 Ctrl/Cmd——Alt 是输入法
            切换的高发键，中文作者容易撞手势；习惯 Alt+点击的作者选 Alt 即可。只改操作方式、不动文件
          </span>
        </span>
      </div>
      {/* 列选择：布尔开关，缺省关（与 Monaco 自己的缺省一致 ⇒ 今天的行为逐字不变）。 */}
      <label className="settings-row">
        <Switch checked={pref.columnSelection} onChange={(c) => saveColumnSelectionPref(c)} label="列选择" />
        <span>
          列选择
          <span className="settings-hint">按住鼠标左键竖直拖动，按方块选出一列，几行一起改。默认关</span>
        </span>
      </label>
    </>
  );
}

/** 右面板（tabpanel）的稳定 id：导航栏每项 aria-controls 指过来 */
const SETTINGS_PANEL_ID = 'settings-nav-panel';
const tabIdOf = (id: SettingsSectionId): string => `settings-nav-tab-${id}`;

/**
 * 设置浮层（壳层私有，不经 `ui.overlay` 槽——设置项全是容器与显示语义）。
 *
 * 外壳形态（b/kbset/1017）：抬头「设置」+ 左分类导航栏 + 右分节面板 + 页脚。九组条目的
 * 文案、class、DOM 结构逐行照搬自原长滚动列，只是拆挂到 `SETTINGS_SECTIONS` 各自的节下。
 * 本文件除「看哪一节」的 `active` 外不含任何状态与副作用：偏好读写时机仍由壳层那批
 * always-mounted 的 effect 决定，Esc 关窗仍由壳层全局键盘承接。
 */
export function SettingsPanel(props: SettingsPanelProps): ReactElement {
  const { onClose, initialSection = 'general' } = props;
  const navRef = useRef<HTMLDivElement>(null);
  /** 唯一允许的内部状态：当前看哪一节（不落盘、不影响任何偏好） */
  const [active, setActive] = useState<SettingsSectionId>(initialSection);

  /* 先算一次 render：既用于「空节不显示」的判据，也作为右面板内容——避免调用两次。 */
  const visible = SETTINGS_SECTIONS(props)
    .map((sec) => ({ sec, el: sec.render() }))
    .filter((r): r is { sec: SettingsSection; el: ReactElement } => r.el !== null);

  const rawIndex = visible.findIndex((r) => r.sec.id === active);
  const activeIndex = rawIndex >= 0 ? rawIndex : 0;
  const activeEntry = visible[activeIndex];

  if (!activeEntry) {
    // 理论上到不了这里（general 一节恒有内容 ⇒ visible 恒非空）；防御性渲染一个可关闭的空壳，绝不白屏。
    return (
      <div className="overlay-backdrop" onMouseDown={() => onClose()}>
        <div className="overlay-host settings-host" role="dialog" aria-modal="true" aria-label="设置" onMouseDown={(e) => e.stopPropagation()}>
          <div className="wizard">
            <h3 className="settings-title">设置</h3>
          </div>
        </div>
      </div>
    );
  }

  /* 方向键漫游：↑↓（及 ←→）在栏内移动焦点并即时切节（roving tabindex，口径同活动栏 / 标签条）。
     Enter/Space 由 <button> 原生激活，Tab 原样让位——nextRovingIndex 对非漫游键返回 null。 */
  const onNavKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = nextRovingIndex(index, visible.length, e.key);
    if (next === null) return;
    e.preventDefault();
    const entry = visible[next];
    if (!entry) return;
    setActive(entry.sec.id);
    const tabs = navRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[next]?.focus();
  };

  return (
    <div className="overlay-backdrop" onMouseDown={() => onClose()}>
      <div className="overlay-host settings-host" role="dialog" aria-modal="true" aria-label="设置" onMouseDown={(e) => e.stopPropagation()}>
        {/* 右上 ✕：与遮罩点击、页脚「完成」同一个 onClose 入口；Esc 仍走壳层全局键盘（modal 栈） */}
        <button
          type="button"
          className="settings-nav-close"
          aria-label="关闭设置"
          onClick={() => onClose()}
        >
          <Icon name="close" size={16} />
        </button>

        <div className="wizard">
          <h3 className="settings-title">设置</h3>

          {/* 左导航栏 + 右分节面板：抬头/页脚 flex:none 永不滚走，只有面板这一列在滚 */}
          <div className="settings-nav-split">
            <div
              className="settings-nav-bar"
              role="tablist"
              aria-label="设置分类"
              aria-orientation="vertical"
              ref={navRef}
            >
              {visible.map((r, i) => (
                <button
                  key={r.sec.id}
                  type="button"
                  role="tab"
                  id={tabIdOf(r.sec.id)}
                  aria-selected={i === activeIndex}
                  aria-controls={SETTINGS_PANEL_ID}
                  tabIndex={i === activeIndex ? 0 : -1}
                  className={`settings-nav-item${i === activeIndex ? ' on' : ''}`}
                  onClick={() => setActive(r.sec.id)}
                  onKeyDown={(e) => onNavKeyDown(e, i)}
                >
                  <Icon name={r.sec.icon} size={16} className="settings-nav-icon" />
                  <span className="settings-nav-label">{r.sec.label}</span>
                </button>
              ))}
            </div>

            {/* key={节 id} ⇒ 切节时面板整块重建，滚动位置天然归零（每节各自独立滚动，
                不共享一条滚到一半的滚动条），无需额外 effect。 */}
            <div
              className="settings-nav-panel"
              id={SETTINGS_PANEL_ID}
              role="tabpanel"
              aria-labelledby={tabIdOf(activeEntry.sec.id)}
              tabIndex={0}
              key={activeEntry.sec.id}
            >
              <div className="settings-body">{activeEntry.el}</div>
            </div>
          </div>

          {/* 单一页脚行，且沿用全站模态房规：primary 恒等于推荐项、排在最右 */}
          <div className="settings-footer">
            <button className="primary small" onClick={() => onClose()}>
              完成
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ==========================================================================================
 * 格式化规则开关（P2-14）——本组件是**追加段**：不改动 / 重排上方任何既有行，只在这里
 * 自成一枚小组件 + 编辑器带里的一格 <FormatRulesRows />。
 *
 * 为什么自带状态（破例于"设置页只放值与回调"的房规）：既有开关的镜像值住在常驻的
 * `ShellLayout`（本批文件权限不覆盖它），而这两条开关的**全部读方**（格式化 provider 组
 * 请求时、保存链路落盘前）都是**现读 localStorage**（`loadFormatRulesPref`），没有任何
 * 闭包旧值可漂——挂载时读一次、写入即落盘即回显，行为与"ShellLayout 持镜像"逐字等价。
 * 挂载即读 = 设置页每次打开都拿到最新值，与既有开关的开窗重读同口径。
 * ========================================================================================== */
function FormatRulesRows(): ReactElement {
  const [rules, setRules] = useState<FormatRules>(() => loadFormatRulesPref());
  const commit = (patch: Partial<FormatRules>): void => {
    const next: FormatRules = { ...rules, ...patch };
    setRules(next);
    saveFormatRulesPref(next);
  };
  return (
    <>
      <label className="settings-row">
        <Switch
          checked={rules.fullWidthSpace}
          onChange={(on) => commit({ fullWidthSpace: on })}
          label="折算全角空格"
        />
        <span>
          折算全角空格
          <span className="settings-hint">
            手动整理（Shift+Alt+F）与保存时整理，都把行首缩进与注释里的全角空格
            折成半角；关闭后全角空格一律原样保留，台词正文里的全角空格本来就不动。
            默认开
          </span>
        </span>
      </label>
      <label className="settings-row">
        <Switch checked={rules.indent} onChange={(on) => commit({ indent: on })} label="统一 .kojo 缩进写法" />
        <span>
          统一 .kojo 缩进写法
          <span className="settings-hint">
            手动整理与保存时整理，都把 .kojo 文件的行首空白重排成统一的写法（制表符或
            4 个空格，取文件里多数派）；关闭后行首空白一字不动。默认开
          </span>
        </span>
      </label>
    </>
  );
}
