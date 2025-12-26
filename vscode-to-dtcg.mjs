import fs from "node:fs";

const inputs = process.argv.slice(2);
if (inputs.length < 2) {
  console.log("用法：node vscode-to-dtcg.mjs <modeA.json> <modeB.json> ...");
  process.exit(1);
}

function clamp01(x) { return Math.min(1, Math.max(0, x)); }

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
      h = [...h].map(ch => ch + ch).join("");
    }
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r: r / 255, g: g / 255, b: b / 255, a: clamp01(a), hex: `#${h.slice(0,6).toUpperCase()}` };
  }

  // rgb/rgba
  const rgb = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (rgb) {
    const r = Number(rgb[1]), g = Number(rgb[2]), b = Number(rgb[3]);
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

  // 其它值（比如 var(...) / currentColor 等）直接跳过
  return null;
}

// 把 --vscode-editor-background => vscode/editor/background（更利于在 Figma 里分组）
// 规则：去掉 --，去掉 vscode- 前缀；第一个段作为 group，其余合成 leaf
function toTokenPath(cssVarName) {
  let n = cssVarName.trim();
  n = n.replace(/^--/, "");
  n = n.replace(/^vscode-/, "");
  const parts = n.split("-");
  if (parts.length === 1) return ["vscode", "global", parts[0]];
  const group = parts[0];
  const leaf = parts.slice(1).join("-");
  return ["vscode", group, leaf];
}

function setNested(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    cur[k] ??= {};
    cur = cur[k];
  }
  cur[path[path.length - 1]] = value;
}

const modes = inputs.map(p => {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const modeName = p.replace(/^.*[\\/]/, "").replace(/\.json$/i, "");
  return { modeName, raw };
});

// 取“并集”，并给缺失项用第一个 mode 的值兜底（避免 Figma 因交集规则丢太多变量）
const allKeys = new Set();
for (const m of modes) Object.keys(m.raw).forEach(k => allKeys.add(k));

const base = modes[0].raw;

for (const m of modes) {
  const out = {};
  for (const k of allKeys) {
    const v = m.raw[k] ?? base[k];
    const c = parseColor(v);
    if (!c) continue;

    const token = {
      $type: "color",
      $value: {
        colorSpace: "srgb",
        components: [c.r, c.g, c.b],
        alpha: c.a,
        hex: c.hex
      }
    };

    // 只处理 --vscode- 开头（你也可以按需放宽）
    if (!k.startsWith("--vscode-")) continue;

    const path = toTokenPath(k.replace(/^--/, "")); // 去掉 --
    setNested(out, path, token);
  }

  const filename = `${m.modeName}.tokens.json`;
  fs.writeFileSync(filename, JSON.stringify(out, null, 2), "utf8");
  console.log(`已生成：${filename}`);
}

