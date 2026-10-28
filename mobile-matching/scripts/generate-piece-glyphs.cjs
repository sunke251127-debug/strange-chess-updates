'use strict';
// Developer utility. Pass an installed @napi-rs/canvas directory as argv[2].
// The shipped game uses only the generated SVG paths, with no font dependency.
const fs = require('node:fs');
const path = require('node:path');
const { createCanvas, GlobalFonts, SvgExportFlag, Path2D } = require(process.argv[2] || '@napi-rs/canvas');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'assets/chess-glyphs');
if (!GlobalFonts.register(fs.readFileSync(path.join(source, 'noto-serif-sc-700-subset.ttf')), 'ChessGlyphSource')) throw new Error('Cannot load glyph source');
const glyphs = {};
for (const symbol of '俥傌相仕帅炮兵車馬象士将砲卒') {
  const svg = createCanvas(1400, 1400, SvgExportFlag.ConvertTextToPaths);
  const ctx = svg.getContext('2d'); ctx.font = '700 1000px ChessGlyphSource'; ctx.fillText(symbol, 200, 1100);
  const paths = [...svg.getContent().toString().matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map(m => m[1]);
  if (!paths.length) throw new Error('Missing outline for ' + symbol);
  const outline = new Path2D(paths.join(' '));
  const [left, top, right, bottom] = outline.computeTightBounds();
  const scale = 880 / Math.max(right - left, bottom - top);
  const normalized = outline.transform({ a: scale, b: 0, c: 0, d: scale, e: 500 - (left + right) * scale / 2, f: 500 - (top + bottom) * scale / 2 });
  const b = normalized.computeTightBounds();
  if (Math.abs((b[0] + b[2]) / 2 - 500) > .01 || Math.abs((b[1] + b[3]) / 2 - 500) > .01) throw new Error('Outline is not centered: ' + symbol);
  glyphs[symbol] = normalized.toSVGString();
}
const license = fs.readFileSync(path.join(source, 'OFL.txt'), 'utf8');
const script = `/* Fixed glyph outlines derived from Noto Serif SC 700 (Google Fonts).
Source: https://github.com/google/fonts/tree/main/ofl/notoserifsc
${license.replaceAll('*/', '* /')}
*/
(function(root) { 'use strict';
  const paths = Object.freeze(${JSON.stringify(glyphs)});
  function create(symbol) {
    if (symbol === '砲') symbol = '炮';
    if (!Object.hasOwn(paths, symbol)) throw new Error('Unknown chess glyph');
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 1000 1000'); svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false'); svg.classList.add('piece-glyph-outline');
    const title = document.createElementNS(ns, 'title'); title.textContent = symbol;
    const path = document.createElementNS(ns, 'path'); path.setAttribute('d', paths[symbol]);
    svg.append(title, path); return svg;
  }
  root.StrangeChessGlyphs = Object.freeze({ create });
})(globalThis);
`;
fs.writeFileSync(path.join(root, 'src/piece-glyphs.js'), script);
console.log('Generated ' + Object.keys(glyphs).length + ' centered vector glyphs');
