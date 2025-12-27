#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const DEFAULT_OUTPUT_DIR = "output";

const USAGE = `Usage:
  node convert.mjs [--no-union] <input1> <input2> ... [output-dir]
  node convert.mjs [--no-union] <input-dir> [output-dir]

Description:
- input can be a file or directory:
  • File: CSS declarations plain text OR JSON object { "--vscode-xxx": "#fff" }
  • Directory: Automatically scan all files in the directory
- Default output directory: output/
- Output files are grouped into subdirectories:
  • output/tokens/       - Standard tokens
  • output/union/        - Union version
  • output/reports/      - Missing reports

Examples:
  node convert.mjs red.json dark_morden.json
  node convert.mjs ./css_declarations
`;

// ---------- Input Parsing ----------

const CSS_PATTERN = /^\s*([_A-Za-z][\w-]*|--[\w-]+)\s*:\s*(.+?)\s*;\s*$/;

function parseCssDeclarations(content) {
  const lines = content.split(/\r?\n/);
  const result = {};
  let skipped = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    // Error tolerance: ignore .selector { / } / comments
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

  // Try JSON
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
      // Not JSON, continue parsing as CSS declarations
    }
  }

  const { vars, skipped } = parseCssDeclarations(content);
  return { vars, skipped, kind: "css" };
}

// ---------- Color Parsing & DTCG Token ----------

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

  // Other values (var(...) / currentColor, etc.) are not exported as colors
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

// Convert --vscode-editor-background => vscode/editor/background
function toTokenPath(cssVarName) {
  let n = cssVarName.trim();
  n = n.replace(/^--/, "");
  n = n.replace(/^vscode-/, "");
  const parts = n.split("-");

  // Only 1 segment: vscode/<name>
  if (parts.length === 1) return ["vscode", parts[0]];

  // 2+ segments: vscode/<group>/<leaf...>
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

// ---------- Main Process ----------

// Supported input file extensions
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

  // Identify output-dir: if the last parameter "does not exist" or "is a directory", treat it as the output directory
  let outputDir = DEFAULT_OUTPUT_DIR;
  const last = rest[rest.length - 1];
  if (!last) return { flags, inputs: rest, outputDir };

  // First check if it's an existing input directory
  if (fs.existsSync(last)) {
    const st = fs.statSync(last);
    // If it's a directory and contains supported input files, treat it as input directory, not output directory
    if (st.isDirectory()) {
      const filesInDir = fs.readdirSync(last).filter(f => {
        const ext = path.extname(f).toLowerCase();
        return SUPPORTED_INPUT_EXTS.has(ext);
      });
      if (filesInDir.length > 0) {
        // Is input directory, not treated as output directory
        return { flags, inputs: rest, outputDir };
      }
      // Is empty directory or doesn't contain supported files, treat as output directory
      outputDir = last;
      rest.pop();
    }
  } else if (!fs.existsSync(last)) {
    // Does not exist: treat as output directory
    outputDir = last;
    rest.pop();
  }

  if (rest.length === 0) {
    console.error("No input files or directories.\n" + USAGE);
    process.exit(1);
  }

  return { flags, inputs: rest, outputDir };
}

// Calculate string display width (Chinese=2, English=1)
function displayWidth(str) {
  let width = 0;
  for (const ch of str) {
    // Chinese and full-width characters occupy 2 width
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

// Pad by display width
function padEndByWidth(str, targetWidth) {
  const currentWidth = displayWidth(str);
  const padding = Math.max(0, targetWidth - currentWidth);
  return str + " ".repeat(padding);
}

// Print table
function printTable(headers, rows) {
  const colWidths = headers.map((h, i) => {
    const maxWidth = Math.max(
      displayWidth(h),
      ...rows.map(r => displayWidth(String(r[i])))
    );
    return maxWidth + 2;
  });

  const separator = colWidths.map(w => "-".repeat(w)).join("+");

  // Header
  console.log("+" + separator + "+");
  console.log("|" + headers.map((h, i) => padEndByWidth(h, colWidths[i])).join("|") + "|");
  console.log("+" + separator + "+");

  // Data rows
  for (const row of rows) {
    console.log("|" + row.map((c, i) => padEndByWidth(String(c), colWidths[i])).join("|") + "|");
  }
  console.log("+" + separator + "+");
}

function main() {
  const { flags, inputs, outputDir } = parseArgs(process.argv.slice(2));
  const unionEnabled = !flags.has("--no-union");

  // Collect all input files (handle directories)
  const allInputFiles = [];
  for (const inputPath of inputs) {
    if (!fs.existsSync(inputPath)) {
      console.error(`✗ Input not found: ${inputPath}`);
      process.exit(1);
    }
    const files = collectInputFiles(inputPath);
    if (files.length === 0) {
      console.error(`✗ No supported input files found (.json/.css/.txt): ${inputPath}`);
      process.exit(1);
    }
    allInputFiles.push(...files);
  }

  console.log(`\nOutput directory: ${outputDir}`);
  console.log(`Input files (${allInputFiles.length}): ${allInputFiles.map(f => path.basename(f)).join(", ")}\n`);
  ensureDir(outputDir);

  /** @type {{ inputPath: string, name: string, flat: Record<string, any>, nested: any, skipped: number, kind: string }[]} */
  const items = [];

  // 1) Single file conversion
  const tokenRows = [];
  for (const inputPath of allInputFiles) {
    const name = path.basename(inputPath).replace(/\.[^.]+$/, "");
    const { vars, skipped, kind } = readInputAsVarMap(inputPath);

    const flat = flattenCssVarsToColorTokens(vars);
    const nested = nestFlatTokens(flat);

    // Output to tokens/ subdirectory
    const outPath = path.join(outputDir, "tokens", `${name}.tokens.json`);
    writeJson(outPath, nested);

    tokenRows.push([path.basename(inputPath), `tokens/${name}.tokens.json`, countLeafTokens(nested), skipped, kind]);
    items.push({ inputPath, name, flat, nested, skipped, kind });
  }

  // Print standard tokens table
  printTable(["Input File", "Output Path", "tokens", "skipped", "kind"], tokenRows);

  // 2) Union version
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
      // Output to union/ subdirectory
      const unionOutPath = path.join(outputDir, "union", `${it.name}.union.tokens.json`);
      writeJson(unionOutPath, unionNested);

      report[it.name] = { missing, present: unionKeys.length - missing.length };
      unionRows.push([it.name, `union/${it.name}.union.tokens.json`, countLeafTokens(unionNested), missing.length]);
    }

    // Print union table
    console.log();
    printTable(["File", "Output Path", "tokens", "missing filled"], unionRows);

    // Output to reports/ subdirectory
    const reportPath = path.join(outputDir, "reports", "union.missing_report.json");
    writeJson(reportPath, { totalUnionKeys: unionKeys.length, report });
    console.log(`\n✓ Missing report: reports/union.missing_report.json (${unionKeys.length} total keys)`);
  } else if (!unionEnabled) {
    console.log("\n(Union disabled: --no-union)");
  } else {
    console.log("\n(Less than 2 input files, skip union generation)");
  }
  console.log();
}

main();
