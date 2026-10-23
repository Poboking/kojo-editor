# ui-kit — 控件语言契约（批次十一 L14 · 集成波唯一依据）

> 本目录是全站控件语言的**地基**。各 lane 的 `// ui-kit-candidate:` 标记处，集成波照本契约迁移。
> 类名前缀 `kit-`；样式全部住在 `ui-kit.css`（main.tsx 在 styles.css 族之后加载）；
> 颜色/圆角/字号/动效**只吃 token**；度量基线 = 检索面板 `ksp-*`（全仓最精修一族）。

## 一、什么该进 ui-kit、什么不该

**该进**：任何面板里「可复用形态」的控件——行模板、勾选/单选/下拉/分段、图标钮、
键位提示、计数徽标、空态、骨架。判据：**同形态在两处以上出现**，或**现状全仓零 CSS
落浏览器默认档**（问题面板的原生 checkbox/`<select>` 即属此类，必须收编）。

**不该进**：
- 一次性布局壳（面板分栏、浮动窗几何）——那是宿主的事；
- 带业务语义的复合件（主题预览卡 `.theme-card`、文件树行）——它们的**内部原子**
  （radio 语义、计数徽标）进 kit，卡本身留在面板；
- Monaco 弹层、命令面板行等已有独立精修语言的面——参照本文件度量，不强行改写；
- 游戏语汇：本目录零游戏知识（与内核铁律 1 同口径），props 里只许出现中性词。

## 二、件与 props 摘要

### KitField（设置行；收编 L09 行模板 / `.settings-row`）
`{ title, description?, control?, children?, as?: 'div'|'label', nested?, inactive?, id?, className? }`
- 两列栅格：文字列（标题 + 描述）在左，`control` 槽钉右轴；整行 `max-width: var(--kit-field-max-width, 760px)`。
- `as:'label'` = 整行即点即切（配**无可见文字**的 KitCheck/KitRadio；两者都带可见文字会形成嵌套 label，非法）。
- `nested` = 从属项（缩进 + 从属线）；`inactive` = 整行停用观感（降透明度、撤 hover）。

### KitCheck / KitRadio（替原生 checkbox/radio；与 Switch 同族）
`{ checked, onChange(checked), label(必传无障碍名), children?(可见文字), disabled?, id?, name?(radio 组), value?(radio), className? }`
- 视觉隐藏的真 `input` 盖在自绘盒上 ⇒ 原生键盘语义（空格/方向键）零损失。
- **给 `children` 时**外层是 `<label>`、点文字即切换、不加 `aria-label`；**不给时**外层 `<span>`、
  `aria-label=label`——用于 KitField 行内、名字由行标题承担的场合。

### KitSelect（替原生 `<select>`；问题面板来源过滤等）
`{ value, onChange(value), options: {value,label,disabled?}[], ariaLabel(必传), title?, disabled?, id?, className? }`
- `appearance:none` + 折角 chevron + sunken 井（26px 口径）；菜单面 = `option` 上
  `--surface-overlay`/`--fg`（Chromium 可染色，三主题跟切）。
- 刻意保留原生弹层：键盘/读屏语义不重实现。需要自绘弹层（分组、副标题）时**另提件**，不塞进本件。

### KitSegmented（收编 `theme-seg-btn`）
`{ options: {value,label,disabled?}[], value: T|null, onChange(value), ariaLabel(必传), disabled?, className? }`
- `role=radiogroup` + 每档 `role=radio` `aria-checked`；方向键/Home/End **换档即移焦**，
  roving tabIndex（未选时首个可用档进 Tab 序）。
- 泛型 `T extends string`；与主题卡 `.theme-card` 的差别：分段 = 文字档，卡片 = 预览件（留在面板）。

### KitIconButton（尺寸走 L10 四档契约）
`{ label(必传→aria-label+title), children(图标), onClick?, disabled?, active?(toggle 态→aria-pressed), hint?(悬停详释), size?: 12|14|16|22 (缺省 16), type?, className? }`
- 静息无框 22 见方，`::before` 热区补 24×24；盒宽 = `max(22px, glyph+6px)`，档位写进
  `--kit-ib-glyph`，盒内 svg 尺寸自动跟档。`active` 态 = ksp-toggle 语言（accent 淡底 + 半强度描边 + `--accent-text`）。

### KitKbd（键位提示统一语言）
`{ combo: string | string[], className? }`
- 单串 = 一个组合（`"Shift+Alt+F"`），`+` 分键；数组 = 和弦分步（`["Ctrl+K","Z"]`），步间留沟。
- **读法归一**：修饰键用词（`ctrl→Ctrl`、`meta/cmd→Win`），方向键用符号（`up→↑`），
  其余用词（`enter→Enter`、`esc→Esc`）；单字符键大写（`z→Z`）；`Plus` 表字面 `+` 键。
  旧文本符号档（`↵ ⇧`）迁移时一律改写为 combo，不保留符号修饰键。
- 键帽芯片度量 = `.kb-chip`（`--font-meta`、底边 2px、`--hover-soft` 底）。

### KitCount（统一计数徽标；收编四套徽章 + `ksp-file-count`）
`{ value, max?(缺省 99), tone?: 'neutral'|'accent'|'danger'|'warning'|'success', title?, className? }`
- `value > max` → 显示 `${max}+`，`title`/`aria-label` 回落真实值（读数不撒谎，铁律 4）。
- 语义色约定：错误计数 `danger`、警示/待办 `warning`、命中/选中态 `accent`、通过 `success`；
  着色只动**文字**（都取 AA 文字档），井底 `--bg-3` 不动。

### KitEmpty（统一空态；收编三档现状）
`{ title, hint?, icon?, action?: {label,onClick}, variant?: 'stack'|'inline' (缺省 stack), announce?(默认 false→role=status), className? }`
- `stack` = kb-empty 档（居中列 + `--fs-4` 标题 + 退路按钮）；
  `inline` = picker-empty / settings-results-empty 档（一行灰字）。
- 「过滤筛空」与「本来就没数据」是两种空态——调用方给不同 title/hint，组件不猜。

### KitSkeleton（骨架；收编 `.skeleton`，浮层加载态从一句 `.dim` 升级）
`{ lines?(>0 渲染多行占位), width?, height?(数字按 px), label?(读屏加载说明→role=status+aria-busy), className? }`
- reduced-motion 下扫光静止；行高吃 `--fs-2`，加载完不跳版。

### KitGallery（内部对照页；已导出、暂不接线）
零 props。并排渲染全部件（可交互），组长集成波用它 + 真壳截图一次性验收控件语言合一。

## 三、语义色与 token 约定

- 面：`--surface-sunken`（控件井底）/ `--surface-overlay`（菜单面）/ `--bg-3`（徽底）；
- 边：`--border`（静息）/ `--border-strong`（勾选盒描边）/ `--focus-ring`（焦点）；
- 选中态：`--accent-dim` 底 + `rgb(var(--accent-rgb)/0.55)` 半强度描边 + `--accent-text` 文字；
- 焦点一律 `outline:none + box-shadow: var(--shadow-focus)`；禁用一律 `opacity: var(--disabled-opacity)`；
- 命中区 ≥24×24（P3-2 热区口径：视觉不动、`::before` 扩边）。

**待 L01 补的 token**（本目录已用 `var(--xxx, 现值)` 兜底，今天就能渲染）：

| token | 现兜底值 | 用途 |
|---|---|---|
| `--kit-field-max-width` | `760px` | KitField 行宽上限（若 L01 愿意统一成 `--settings-max-width` 更好，改名即可） |

其余全部吃既有 token，无新色需求。

## 四、迁移口径（集成波）

1. 面板里的手写行模板 → `KitField`（行内开关仍可用 `Switch`，或等价的 KitCheck；分段 → `KitSegmented`）；
2. 原生 checkbox/radio/select（问题面板、kojo2-cutover 行）→ `KitCheck`/`KitRadio`/`KitSelect`；
3. 各处计数 `span.*-badge/*-count` → `KitCount`（99+ 由件管）；
4. `kb-empty`/`picker-empty`/`settings-results-empty` → `KitEmpty`（stack/inline 两档对号）；
5. 帮助文字里的 `↵ ⇧ ↑↓ F4` / `Ctrl+K Z` 文本 → `KitKbd combo`；
6. 浮层加载态 `.dim` 句 → `KitSkeleton`。
迁移是**替换类与 JSX**，旧 CSS 由 L02（css-hygiene）统一收尾；本目录零依赖旧类。
