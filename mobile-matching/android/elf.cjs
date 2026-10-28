'use strict';
// Minimal ELF program-header reader for checking packaged Android dependencies.
function inspectElf(bytes) {
  if (bytes.readUInt32BE(0) !== 0x7f454c46 || bytes[5] !== 1) throw new Error('Expected little-endian ELF');
  const wide = bytes[4] === 2;
  const word = offset => wide ? Number(bytes.readBigUInt64LE(offset)) : bytes.readUInt32LE(offset);
  const start = word(wide ? 32 : 28), size = bytes.readUInt16LE(wide ? 54 : 42), count = bytes.readUInt16LE(wide ? 56 : 44);
  const segments = [];
  for (let i = 0; i < count; i++) {
    const at = start + i * size;
    segments.push({ type: bytes.readUInt32LE(at), offset: word(at + (wide ? 8 : 4)), address: word(at + (wide ? 16 : 8)),
      length: word(at + (wide ? 32 : 16)), alignment: word(at + (wide ? 48 : 28)) });
  }
  const dynamic = segments.find(segment => segment.type === 2);
  const needed = []; let strings;
  if (dynamic) for (let at = dynamic.offset; at < dynamic.offset + dynamic.length; at += wide ? 16 : 8) {
    const tag = word(at), value = word(at + (wide ? 8 : 4));
    if (tag === 0) break;
    if (tag === 1) needed.push(value);
    if (tag === 5) strings = value;
  }
  const stringSegment = segments.find(segment => segment.type === 1 && strings >= segment.address && strings < segment.address + segment.length);
  if (needed.length && !stringSegment) throw new Error('ELF has no mapped dependency string table');
  const base = stringSegment ? stringSegment.offset + strings - stringSegment.address : 0;
  return { machine: bytes.readUInt16LE(18), alignments: segments.filter(segment => segment.type === 1).map(segment => segment.alignment),
    needed: needed.map(offset => bytes.toString('utf8', base + offset, bytes.indexOf(0, base + offset))) };
}
module.exports = { inspectElf };
