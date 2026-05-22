# Panther 平台前端设计规范 (V2 - OPM 交叉校准版)

## 🎨 核心色彩 (Color Tokens)
| 类型 | 颜色值 (Hex/RGB) | 用途 | 备注 |
| :--- | :--- | :--- | :--- |
| **Primary** | `#1890FF` (`rgb(24, 144, 255)`) | 标准 AntD 蓝色 | JobBrowser/RTC 常用 |
| **Primary (OPM)** | `#0360F9` (`rgb(3, 96, 249)`) | Panther 品牌主色 | 首页/控制台顶层常用 |
| **Sider Background**| `#001529` (`rgb(0, 21, 41)`) | 深色侧边栏 | 典型 AntD Dark Theme |
| **Content Background**| `#F2F6F9` (`rgb(242, 246, 249)`) | 页面主背景灰 | OPM 专用底色，略偏蓝灰 |
| **Text Primary** | `#000000` (`rgb(0, 0, 0)`) | 正文、标题 | 极深灰/黑 |
| **Table Header** | `#FAFAFA` (`rgb(250, 250, 250)`) | 表格头部背景 | 标准浅灰 |

## 📐 布局与间距 (Layout & Spacing)
- **Header Height**: `64px`
- **Sidebar Width**: `200px` (常规) / `380px` (首页特写)
- **Border Radius**: 
  - **核心约束**: `2px` (Panther 风格之魂，方正硬朗)
  - **辅助圆角**: `4px` (部分卡片/输入框)
- **Base Font Size**: `14px`

## 🍱 组件样式 (Component Styles)
### 按钮 (Button)
- **Primary**: 背景 `#0360F9`，圆角 `2px`。
- **Default**: 边框 `#D9D9D9`，背景 `#FFFFFF`。

### 卡片 (Card)
- **Border**: `1px solid #EDEDED`
- **Radius**: `2px`
- **Shadow**: 几乎无阴影，依赖边框分割。

### 表格 (Table)
- **Header Bg**: `#FAFAFA`
- **Row Hover**: `#F5F5F5`
- **Border**: 分割线颜色 `#F0F0F0`

## 🔗 OPM 集成建议 (Integration Guidelines)
1. **背景对齐**: 设置 `body { background: #F2F6F9; }` 以融合 OPM 的灰蓝底色。
2. **主题色适配**: 建议优先使用 `#0360F9` 作为 Action Color，与 Panther 顶层视觉保持一致。
3. **方正风格**: 强制所有 AntD 组件 `borderRadius: 2`。
4. **Iframe 协议**:
   - 监听 `window.addEventListener('message')` 接收 `PANTHER_AUTH` (用户信息)。
   - 调用 `window.parent.postMessage({ type: 'PANTHER_RESIZE', height: document.body.scrollHeight }, '*')` 同步高度。
