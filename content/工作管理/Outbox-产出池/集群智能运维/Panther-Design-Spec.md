# Panther 平台前端设计规范 (Design Specification)

## 🎨 核心色彩 (Color Tokens)
| 类型 | 颜色值 (Hex/RGB) | 用途 |
| :--- | :--- | :--- |
| **Primary** | `#0360F9` (`rgb(3, 96, 249)`) | 品牌主色、主要按钮、激活状态 |
| **Background** | `#FFFFFF` (`rgb(255, 255, 255)`) | 页面主背景 |
| **Text Primary** | `#181818` (`rgb(24, 24, 24)`) | 正文、标题 |
| **Border** | `#D9D9D9` (推测) | 描边、分割线 (探测结果为 0.85 opacity，建议使用 AntD 默认或对齐) |

## 📐 布局与间距 (Layout & Spacing)
- **Header Height**: `64px`
- **Sidebar Width**: `200px` - `250px` (首页探测为 380px，但控制台通常较窄)
- **Content Padding**: `24px`
- **Base Font Size**: `14px`
- **Border Radius**: `2px` (关键：Ant Design 默认是 6px，Panther 强制改为 2px 以保持硬朗风格)

## 🖋️ 字体 (Typography)
- **Font Family**: `-apple-system, "system-ui", "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif`
- **Line Height**: `1.5715` (AntD 默认)

## 🍱 组件样式 (Component Styles)
### 按钮 (Button)
- **Shape**: Square (Radius 2px)
- **Shadow**: 无明显阴影或极浅阴影
- **Transition**: `0.3s`

### 卡片 (Card)
- **Border**: `1px solid #f0f0f0`
- **Radius**: `2px`
- **Title Weight**: `500`

## 🔗 Iframe 接入约束
1. **样式隔离**: 尽管是 iframe，但需通过 `ConfigProvider` 强制注入上述 Token，确保视觉一致性。
2. **滚动条**: 子应用内部禁止出现全局滚动条，高度由主站 iframe 容器控制。
3. **通信协议**:
   - `type: 'PANTHER_RESIZE'`：发送高度。
   - `type: 'PANTHER_NAVIGATE'`：发送路径变更。
   - `type: 'PANTHER_AUTH'`：接收用户信息。
