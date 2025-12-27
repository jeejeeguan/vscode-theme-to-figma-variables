# VSCode to DTCG Tokens

将 VSCode 主题的 CSS 变量转换为 Design Token Community Group (DTCG) 格式。

## 用法

```bash
# 目录输入（自动扫描所有文件）
node convert.mjs ./css_declarations

# 多文件输入
node convert.mjs red.json dark_morden.json

# 自定义输出目录
node convert.mjs ./css_declarations my-output

# 禁用并集生成
node convert.mjs --no-union ./css_declarations
```

**支持的输入文件扩展名**：`.json`、`.css`、`.txt`

## 输出结构

```
output/
├── tokens/       # 标准 tokens
├── union/        # 并集版本（所有文件统一结构）
└── reports/      # 缺失报告
```

## 输入格式

支持两种格式：

1. **纯 CSS declarations 文本**（推荐，从 VSCode DevTools 复制）
```css
--vscode-foreground: #cccccc;
--vscode-editor-background: #1e1e1e;
```

2. **JSON 对象**
```json
{
  "--vscode-foreground": "#cccccc",
  "--vscode-editor-background": "#1e1e1e"
}
```

## Union 并集功能

当输入文件 ≥ 2 且未指定 `--no-union` 时，自动生成并集版本：

**规则**：
- 有值的 token 用自己的值
- 缺失的 token 补 `transparent`（透明色）

**用途**：
- 统一多个主题的 token 结构
- 便于在 Figma 中切换主题时保持一致的 token 集合
- 通过 `reports/union.missing_report.json` 查看各主题缺失的 token

## 流程说明

```
输入 CSS 变量
├── --vscode-foreground: #cccccc;
├── --vscode-editor-background: #390000;
└── --vscode-editor-foreground: #f8f8f8;

       ↓ (node convert.mjs)

输出 DTCG Tokens (output/)
├── tokens/red.tokens.json           ← 标准版本
├── union/red.union.tokens.json      ← 并集版本
└── reports/union.missing_report.json ← 缺失报告
```

## Token 路径规则

| CSS 变量 | Token 路径 |
|---------|-----------|
| `--vscode-foreground` | `vscode/foreground` |
| `--vscode-editor-background` | `vscode/editor/background` |
| `--vscode-editor-foreground` | `vscode/editor/foreground` |

**规则**：去掉 `--` 和 `vscode-` 前缀，按 `-` 分组。

## DTCG 颜色格式说明

输出符合 [DTCG 标准](https://tr.designtokens.org/format/) 的颜色格式：

```json
{
  "$type": "color",
  "$value": {
    "colorSpace": "srgb",
    "components": [0.8, 0.8, 0.8],
    "alpha": 1,
    "hex": "#CCCCCC"
  }
}
```

**字段说明**：

| 字段 | 说明 | Figma 导入 |
|------|------|-----------|
| `colorSpace` | 颜色空间，固定为 `srgb` | 忽略 |
| `components` | RGB 分量数组，范围 0-1 | 忽略（辅助字段） |
| `alpha` | 透明度，范围 0-1 | ✓ 使用 |
| `hex` | 十六进制颜色值 | ✓ 使用 |

**关于 Figma 导入**：
- Figma 主要读取 `hex` 和 `alpha` 来生成 Color Variables
- `components` 是 DTCG 标准要求的完整性字段，不直接参与变量生成
- 透明度必须通过 `alpha` 字段指定，8 位 hex (`#RRGGBBAA`) 可能不被识别

**示例**：
```json
// 红色，50% 透明
{
  "$value": {
    "hex": "#FF0000",
    "alpha": 0.5
  }
}

// 完全透明（用于 union 中缺失的 token）
{
  "$value": {
    "hex": "#000000",
    "alpha": 0
  }
}
```

## 颜色格式支持

| 格式 | 示例 |
|------|------|
| Hex | `#RRGGBB`, `#RGB`, `#RRGGBBAA`, `#RGBA` |
| RGB | `rgb(255, 0, 0)` |
| RGBA | `rgba(255, 0, 0, 0.5)` |
| 透明色 | `transparent` |

## 注意事项

- 只转换 `--vscode-` 开头的变量
- 忽略无法解析的颜色值（如 `var(...)`、`currentColor`）
- 默认输出到 `output/` 目录
- 无法解析的行会被跳过，并在表格中显示 `skipped` 计数
