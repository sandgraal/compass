/**
 * Builds a minimal STORED (uncompressed) ZIP from in-memory entries — for tests,
 * so we can exercise the ZIP container + nested recognizers without a zip-writer
 * dependency. yauzl reads it like any archive.
 */
import { crc32 } from 'node:zlib'

export function makeZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf-8')
    const crc = crc32(data) >>> 0

    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0) // local file header signature
    lfh.writeUInt16LE(20, 4) // version needed
    lfh.writeUInt16LE(0, 8) // method 0 = stored
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(data.length, 18) // compressed size
    lfh.writeUInt32LE(data.length, 22) // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26)
    local.push(lfh, nameBuf, data)

    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0) // central directory header signature
    cdh.writeUInt16LE(20, 4) // version made by
    cdh.writeUInt16LE(20, 6) // version needed
    cdh.writeUInt16LE(0, 10) // method
    cdh.writeUInt32LE(crc, 16)
    cdh.writeUInt32LE(data.length, 20)
    cdh.writeUInt32LE(data.length, 24)
    cdh.writeUInt16LE(nameBuf.length, 28)
    cdh.writeUInt32LE(offset, 42) // offset of local header
    central.push(cdh, nameBuf)

    offset += lfh.length + nameBuf.length + data.length
  }

  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // end of central directory signature
  eocd.writeUInt16LE(entries.length, 8) // entries on this disk
  eocd.writeUInt16LE(entries.length, 10) // total entries
  eocd.writeUInt32LE(cd.length, 12) // central directory size
  eocd.writeUInt32LE(offset, 16) // central directory offset
  return Buffer.concat([...local, cd, eocd])
}
