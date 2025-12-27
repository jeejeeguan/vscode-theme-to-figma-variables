# VSCode to DTCG Tokens

[中文版](./README.zh-CN.md)

Convert VSCode theme CSS variables to Design Token Community Group (DTCG) format.

## Usage

```bash
# Directory input (automatically scan all files)
node convert.mjs ./css_declarations

# Multiple file input
node convert.mjs red.json dark_morden.json

# Custom output directory
node convert.mjs ./css_declarations my-output

# Disable union generation
node convert.mjs --no-union ./css_declarations
```

**Supported input file extensions**: `.json`, `.css`, `.txt`

## Output Structure

```
output/
├── tokens/       # Standard tokens
├── union/        # Union version (unified structure across all files)
└── reports/      # Missing reports
```

## Input Formats

Supports two formats:

1. **Pure CSS declarations text** (recommended, copy from VSCode DevTools)
```css
--vscode-foreground: #cccccc;
--vscode-editor-background: #1e1e1e;
```

2. **JSON object**
```json
{
  "--vscode-foreground": "#cccccc",
  "--vscode-editor-background": "#1e1e1e"
}
```

## Union Feature

When input files ≥ 2 and `--no-union` is not specified, automatically generates a union version:

**Rules**:
- Tokens with values use their own values
- Missing tokens are filled with `transparent` (alpha = 0)

**Use cases**:
- Unify token structure across multiple themes
- Facilitate consistent token sets when switching themes in Figma
- Check missing tokens via `reports/union.missing_report.json`

## Process Flow

```
Input CSS Variables
├── --vscode-foreground: #cccccc;
├── --vscode-editor-background: #390000;
└── --vscode-editor-foreground: #f8f8f8;

       ↓ (node convert.mjs)

Output DTCG Tokens (output/)
├── tokens/red.tokens.json           ← Standard version
├── union/red.union.tokens.json      ← Union version
└── reports/union.missing_report.json ← Missing report
```

## Token Path Rules

| CSS Variable | Token Path |
|-------------|------------|
| `--vscode-foreground` | `vscode/foreground` |
| `--vscode-editor-background` | `vscode/editor/background` |
| `--vscode-editor-foreground` | `vscode/editor/foreground` |

**Rule**: Remove `--` and `vscode-` prefix, split by `-`.

## DTCG Color Format

Output conforms to [DTCG standard](https://tr.designtokens.org/format/) color format:

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

**Field descriptions**:

| Field | Description | Figma Import |
|-------|-------------|--------------|
| `colorSpace` | Color space, fixed as `srgb` | Ignored |
| `components` | RGB component array, range 0-1 | Ignored (auxiliary field) |
| `alpha` | Opacity, range 0-1 | ✓ Used |
| `hex` | Hexadecimal color value | ✓ Used |

**About Figma import**:
- Figma primarily reads `hex` and `alpha` to generate Color Variables
- `components` is a completeness field required by DTCG standard, not directly involved in variable generation
- Opacity must be specified via `alpha` field, 8-bit hex (`#RRGGBBAA`) may not be recognized

**Examples**:
```json
// Red, 50% opacity
{
  "$value": {
    "hex": "#FF0000",
    "alpha": 0.5
  }
}

// Fully transparent (for missing tokens in union)
{
  "$value": {
    "hex": "#000000",
    "alpha": 0
  }
}
```

## Color Format Support

| Format | Example |
|--------|---------|
| Hex | `#RRGGBB`, `#RGB`, `#RRGGBBAA`, `#RGBA` |
| RGB | `rgb(255, 0, 0)` |
| RGBA | `rgba(255, 0, 0, 0.5)` |
| Transparent | `transparent` |

## Notes

- Only converts variables starting with `--vscode-`
- Ignores unparsable color values (e.g., `var(...)`, `currentColor`)
- Default output directory is `output/`
- Unparsable lines are skipped and displayed as `skipped` count in the table
