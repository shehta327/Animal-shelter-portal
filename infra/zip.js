// Tiny zip writer (no extra tools): node infra/zip.js <folder> <out.zip>
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const [dir, out] = process.argv.slice(2);
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const parts = []; const central = []; let offset = 0;
const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
for (const f of files) {
  const name = Buffer.from(f); const data = fs.readFileSync(path.join(dir, f)); const packed = zlib.deflateRawSync(data); const crc = crc32(data);
  const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8); l.writeUInt16LE(0x5021, 12);
  l.writeUInt32LE(crc, 14); l.writeUInt32LE(packed.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(name.length, 26);
  parts.push(l, name, packed);
  const e = Buffer.alloc(46); e.writeUInt32LE(0x02014b50, 0); e.writeUInt16LE(0x0314, 4); e.writeUInt16LE(20, 6); e.writeUInt16LE(8, 10);
  e.writeUInt16LE(0x5021, 14); e.writeUInt32LE(crc, 16); e.writeUInt32LE(packed.length, 20); e.writeUInt32LE(data.length, 24);
  e.writeUInt16LE(name.length, 28); e.writeUInt32LE((0o100644 << 16) >>> 0, 38); e.writeUInt32LE(offset, 42);
  central.push(e, name); offset += 30 + name.length + packed.length;
}
const size = central.reduce((s, b) => s + b.length, 0);
const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
fs.writeFileSync(out, Buffer.concat([...parts, ...central, end]));
console.log(`zipped ${files.length} file(s) -> ${out}`);
