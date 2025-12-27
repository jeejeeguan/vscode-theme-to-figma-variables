#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const DEFAULT_OUTPUT_DIR = "output";

const USAGE = `用法:
  node convert.mjs [--no-union] <input1> <input2> ... [output-dir]
  node convert.mjs [--no-union] <input-dir> [output-dir]

说明:
- input 可以是文件或目录：
  • 文件：CSS declarations 纯文本 或 JSON 对象 { "--vscode-xxx": "#fff" }
  • 目录：自动扫描目录内所有文件
- 默认输出目录：output/
- 输出文件按类型分组到子目录：
  • output/tokens/       - 标准 tokens
  • output/union/        - 并集版本
  • output/reports/      - 缺失报告

例子:
  node convert.mjs red.json dark_morden.json
  node convert.mjs ./css_declarations
`;

// ---------- 解析输入 ----------

const CSS_PATTERN = /^\s*([_A-Za-z][\w-]*|--[\w-]+)\s*:\s*(.+?)\s*;\s*$/;

function parseCssDeclarations(content) {
  const lines = content.split(/\r?\n/);
  const result = {};
  let skipped = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    // 容错：忽略 .selector { / } / 注释
    if (line === "{" || line === "}") { skipped++; continue; }
    if (line.endsWith("{") || line.startsWith(".")) { skipped++; continue; }
    if (line.startsWith("/*") || line.startsWith("*") || line.startsWith("//")) { skipped++; continue; }

    const m = CSS_PATTERN.exec(raw);
    if (!m) {
      skipped++;
      continue;
    }
    const name = m[1].trim();
    const value = m[2].trim();
    result[name] = value;
  }

  return { vars: result, skipped };
}

function readInputAsVarMap(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const trimmed = content.trim();

  // 尝试 JSON
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        // { "--vscode-xxx": "..." }
        const out = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string") out[k] = v;
        }
        return { vars: out, skipped: 0, kind: "json" };
      }
    } catch {
      // 不是 JSON，继续按 CSS declarations 解析
    }
  }

  const { vars, skipped } = parseCssDeclarations(content);
  return { vars, skipped, kind: "css" };
}

// ---------- 颜色解析 & DTCG token ----------

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

function parseColor(v) {
  v = (v ?? "").trim();

  if (v === "transparent") {
    return { r: 0, g: 0, b: 0, a: 0, hex: "#000000" };
  }

  // #rgb/#rgba/#rrggbb/#rrggbbaa
  const hex = v.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) {
    let h = hex[1].toLowerCase();
    if (h.length === 3 || h.length === 4) {
      h = [...h].map((ch) => ch + ch).join("");
    }
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return {
      r: r / 255,
      g: g / 255,
      b: b / 255,
      a: clamp01(a),
      hex: `#${h.slice(0, 6).toUpperCase()}`
    };
  }

  // rgb/rgba
  const rgb = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (rgb) {
    const r = Number(rgb[1]);
    const g = Number(rgb[2]);
    const b = Number(rgb[3]);
    const a = rgb[4] == null ? 1 : Number(rgb[4]);
    const toHex = (n) => Math.round(n).toString(16).padStart(2, "0").toUpperCase();
    return {
      r: clamp01(r / 255),
      g: clamp01(g / 255),
      b: clamp01(b / 255),
      a: clamp01(a),
      hex: `#${toHex(r)}${toHex(g)}${toHex(b)}`
    };
  }

  // 其它值（var(...) / currentColor 等）不作为颜色导出
  return null;
}

function makeDtcgColorTokenFromParsedColor(c) {
  return {
    $type: "color",
    $value: {
      colorSpace: "srgb",
      components: [c.r, c.g, c.b],
      alpha: c.a,
      hex: c.hex
    }
  };
}

const TRANSPARENT_TOKEN = makeDtcgColorTokenFromParsedColor({ r: 0, g: 0, b: 0, a: 0, hex: "#000000" });

// 把 --vscode-editor-background => vscode/editor/background
function toTokenPath(cssVarName) {
  let n = cssVarName.trim();
  n = n.replace(/^--/, "");
  n = n.replace(/^vscode-/, "");
  const parts = n.split("-");

  // 仅 1 段：vscode/<name>
  if (parts.length === 1) return ["vscode", parts[0]];

  // 2+ 段：vscode/<group>/<leaf...>
  const group = parts[0];
  const leaf = parts.slice(1).join("-");
  return ["vscode", group, leaf];
}

function setNested(obj, pathArr, value) {
  let cur = obj;
  for (let i = 0; i < pathArr.length - 1; i++) {
    const k = pathArr[i];
    cur[k] ??= {};
    cur = cur[k];
  }
  cur[pathArr[pathArr.length - 1]] = value;
}

function flattenCssVarsToColorTokens(cssVars) {
  /** @type {Record<string, any>} */
  const flat = {};

  for (const [k, v] of Object.entries(cssVars)) {
    if (!k.startsWith("--vscode-")) continue;
    const c = parseColor(v);
    if (!c) continue;
    flat[k] = makeDtcgColorTokenFromParsedColor(c);
  }

  return flat;
}

function nestFlatTokens(flatMap, orderedKeys = null) {
  const out = {};
  const keys = orderedKeys ?? Object.keys(flatMap);
  for (const k of keys) {
    const token = flatMap[k];
    if (!token) continue;
    setNested(out, toTokenPath(k), token);
  }
  return out;
}

function countLeafTokens(obj) {
  if (!obj || typeof obj !== "object") return 0;
  if (obj.$type && obj.$value) return 1;
  let n = 0;
  for (const v of Object.values(obj)) n += countLeafTokens(v);
  return n;
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

// ---------- 主流程 ----------

// 支持的输入文件扩展名
const SUPPORTED_INPUT_EXTS = new Set([".json", ".css", ".txt"]);

function collectInputFiles(inputPath) {
  const st = fs.statSync(inputPath);
  if (st.isFile()) {
    return [inputPath];
  }
  if (st.isDirectory()) {
    const files = [];
    const entries = fs.readdirSync(inputPath, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (SUPPORTED_INPUT_EXTS.has(ext)) {
          files.push(path.join(inputPath, ent.name));
        }
      }
    }
    return files.sort();
  }
  return [];
}

function parseArgs(argv) {
  const flags = new Set();
  const rest = [];
  for (const a of argv) {
    if (a.startsWith("--")) flags.add(a);
    else rest.push(a);
  }

  if (rest.length === 0) {
    console.error(USAGE);
    process.exit(1);
  }

  // 识别 output-dir：最后一个参数如果"不存在"或"是目录"，就当作输出目录
  let outputDir = DEFAULT_OUTPUT_DIR;
  const last = rest[rest.length - 1];
  if (!last) return { flags, inputs: rest, outputDir };

  // 优先检查是否是已存在的输入目录
  if (fs.existsSync(last)) {
    const st = fs.statSync(last);
    // 如果是目录且包含支持的输入文件，当作输入目录而非输出目录
    if (st.isDirectory()) {
      const filesInDir = fs.readdirSync(last).filter(f => {
        const ext = path.extname(f).toLowerCase();
        return SUPPORTED_INPUT_EXTS.has(ext);
      });
      if (filesInDir.length > 0) {
        // 是输入目录，不当作输出目录
        return { flags, inputs: rest, outputDir };
      }
      // 是空目录或不包含支持的文件，当作输出目录
      outputDir = last;
      rest.pop();
    }
  } else if (!fs.existsSync(last)) {
    // 不存在：当作输出目录
    outputDir = last;
    rest.pop();
  }

  if (rest.length === 0) {
    console.error("没有输入文件或目录。\n" + USAGE);
    process.exit(1);
  }

  return { flags, inputs: rest, outputDir };
}

// 计算字符串显示宽度（中文=2，英文=1）
function displayWidth(str) {
  let width = 0;
  for (const ch of str) {
    // 中文、全角字符占 2 宽度
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

// 按显示宽度填充
function padEndByWidth(str, targetWidth) {
  const currentWidth = displayWidth(str);
  const padding = Math.max(0, targetWidth - currentWidth);
  return str + " ".repeat(padding);
}

// 打印表格
function printTable(headers, rows) {
  const colWidths = headers.map((h, i) => {
    const maxWidth = Math.max(
      displayWidth(h),
      ...rows.map(r => displayWidth(String(r[i])))
    );
    return maxWidth + 2;
  });

  const separator = colWidths.map(w => "-".repeat(w)).join("+");

  // 表头
  console.log("+" + separator + "+");
  console.log("|" + headers.map((h, i) => padEndByWidth(h, colWidths[i])).join("|") + "|");
  console.log("+" + separator + "+");

  // 数据行
  for (const row of rows) {
    console.log("|" + row.map((c, i) => padEndByWidth(String(c), colWidths[i])).join("|") + "|");
  }
  console.log("+" + separator + "+");
}

function main() {
  const { flags, inputs, outputDir } = parseArgs(process.argv.slice(2));
  const unionEnabled = !flags.has("--no-union");

  // 收集所有输入文件（处理目录）
  const allInputFiles = [];
  for (const inputPath of inputs) {
    if (!fs.existsSync(inputPath)) {
      console.error(`✗ 找不到输入: ${inputPath}`);
      process.exit(1);
    }
    const files = collectInputFiles(inputPath);
    if (files.length === 0) {
      console.error(`✗ 未找到支持的输入文件 (.json/.css/.txt): ${inputPath}`);
      process.exit(1);
    }
    allInputFiles.push(...files);
  }

  console.log(`\n输出目录: ${outputDir}`);
  console.log(`输入文件 (${allInputFiles.length}): ${allInputFiles.map(f => path.basename(f)).join(", ")}\n`);
  ensureDir(outputDir);

  /** @type {{ inputPath: string, name: string, flat: Record<string, any>, nested: any, skipped: number, kind: string }[]} */
  const items = [];

  // 1) 单文件转换
  const tokenRows = [];
  for (const inputPath of allInputFiles) {
    const name = path.basename(inputPath).replace(/\.[^.]+$/, "");
    const { vars, skipped, kind } = readInputAsVarMap(inputPath);

    const flat = flattenCssVarsToColorTokens(vars);
    const nested = nestFlatTokens(flat);

    // 输出到 tokens/ 子目录
    const outPath = path.join(outputDir, "tokens", `${name}.tokens.json`);
    writeJson(outPath, nested);

    tokenRows.push([path.basename(inputPath), `tokens/${name}.tokens.json`, countLeafTokens(nested), skipped, kind]);
    items.push({ inputPath, name, flat, nested, skipped, kind });
  }

  // 打印标准 tokens 表格
  printTable(["输入文件", "输出路径", "tokens", "skipped", "kind"], tokenRows);

  // 2) 并集(Union)版本
  if (unionEnabled && items.length >= 2) {
    const unionKeySet = new Set();
    for (const it of items) {
      for (const k of Object.keys(it.flat)) unionKeySet.add(k);
    }
    const unionKeys = Array.from(unionKeySet).sort();

    /** @type {Record<string, { missing: string[], present: number }>} */
    const report = {};
    const unionRows = [];

    for (const it of items) {
      const missing = [];
      const unionFlat = {};

      for (const k of unionKeys) {
        const token = it.flat[k];
        if (token) {
          unionFlat[k] = token;
        } else {
          unionFlat[k] = TRANSPARENT_TOKEN;
          missing.push(k);
        }
      }

      const unionNested = nestFlatTokens(unionFlat, unionKeys);
      // 输出到 union/ 子目录
      const unionOutPath = path.join(outputDir, "union", `${it.name}.union.tokens.json`);
      writeJson(unionOutPath, unionNested);

      report[it.name] = { missing, present: unionKeys.length - missing.length };
      unionRows.push([it.name, `union/${it.name}.union.tokens.json`, countLeafTokens(unionNested), missing.length]);
    }

    // 打印 union 表格
    console.log();
    printTable(["文件", "输出路径", "tokens", "缺失补全"], unionRows);

    // 输出到 reports/ 子目录
    const reportPath = path.join(outputDir, "reports", "union.missing_report.json");
    writeJson(reportPath, { totalUnionKeys: unionKeys.length, report });
    console.log(`\n✓ 缺失报告: reports/union.missing_report.json (${unionKeys.length} total keys)`);
  } else if (!unionEnabled) {
    console.log("\n(已关闭 union: --no-union)");
  } else {
    console.log("\n(输入文件少于 2 个，跳过 union 生成)");
  }
  console.log();
}

main();
