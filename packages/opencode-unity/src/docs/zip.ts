// Minimal ZIP reader (store + deflate, ZIP64 aware). The Unity documentation archive has far
// more than 65535 entries and no unzip tool can be assumed on Windows, so entries are read
// straight from the file without extracting anything to disk.

import fs from "node:fs"
import zlib from "node:zlib"

export type ZipEntry = {
  name: string
  method: number
  compressedSize: number
  size: number
  headerOffset: number
}

const EOCD = 0x06054b50
const EOCD64_LOCATOR = 0x07064b50
const EOCD64 = 0x06064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

export class ZipReader {
  private constructor(
    private readonly fd: number,
    readonly entries: ZipEntry[],
  ) {}

  static open(file: string): ZipReader {
    const fd = fs.openSync(file, "r")
    try {
      return new ZipReader(fd, readCentralDirectory(fd, fs.fstatSync(fd).size))
    } catch (error) {
      fs.closeSync(fd)
      throw error
    }
  }

  close() {
    fs.closeSync(this.fd)
  }

  read(entry: ZipEntry): Buffer {
    const header = readAt(this.fd, entry.headerOffset, 30)
    if (header.readUInt32LE(0) !== LOCAL) throw new Error(`bad local header for ${entry.name}`)
    const dataOffset = entry.headerOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
    const data = readAt(this.fd, dataOffset, entry.compressedSize)
    if (entry.method === 0) return data
    if (entry.method === 8) return zlib.inflateRawSync(data)
    throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`)
  }
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const n = fs.readSync(fd, buffer, done, length - done, position + done)
    if (n === 0) throw new Error("unexpected end of zip file")
    done += n
  }
  return buffer
}

function readCentralDirectory(fd: number, fileSize: number): ZipEntry[] {
  const tailSize = Math.min(fileSize, 65557)
  const tail = readAt(fd, fileSize - tailSize, tailSize)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error("not a zip file (end of central directory not found)")

  let count = tail.readUInt16LE(eocd + 10)
  let size = tail.readUInt32LE(eocd + 12)
  let offset = tail.readUInt32LE(eocd + 16)

  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    const locatorAt = eocd - 20
    if (locatorAt < 0 || tail.readUInt32LE(locatorAt) !== EOCD64_LOCATOR) throw new Error("zip64 locator not found")
    const record = readAt(fd, Number(tail.readBigUInt64LE(locatorAt + 8)), 56)
    if (record.readUInt32LE(0) !== EOCD64) throw new Error("zip64 end of central directory not found")
    count = Number(record.readBigUInt64LE(32))
    size = Number(record.readBigUInt64LE(40))
    offset = Number(record.readBigUInt64LE(48))
  }

  const directory = readAt(fd, offset, size)
  const entries: ZipEntry[] = []
  let at = 0
  for (let i = 0; i < count; i++) {
    if (directory.readUInt32LE(at) !== CENTRAL) throw new Error("corrupt zip central directory")
    const nameLength = directory.readUInt16LE(at + 28)
    const extraLength = directory.readUInt16LE(at + 30)
    const commentLength = directory.readUInt16LE(at + 32)
    const entry: ZipEntry = {
      name: directory.toString("utf8", at + 46, at + 46 + nameLength),
      method: directory.readUInt16LE(at + 10),
      compressedSize: directory.readUInt32LE(at + 20),
      size: directory.readUInt32LE(at + 24),
      headerOffset: directory.readUInt32LE(at + 42),
    }

    // ZIP64 extra field: holds, in this order, only the values that overflowed above.
    let extra = at + 46 + nameLength
    const extraEnd = extra + extraLength
    while (extra + 4 <= extraEnd) {
      const id = directory.readUInt16LE(extra)
      const length = directory.readUInt16LE(extra + 2)
      if (id === 0x0001) {
        let field = extra + 4
        if (entry.size === 0xffffffff) (entry.size = Number(directory.readBigUInt64LE(field))), (field += 8)
        if (entry.compressedSize === 0xffffffff) (entry.compressedSize = Number(directory.readBigUInt64LE(field))), (field += 8)
        if (entry.headerOffset === 0xffffffff) entry.headerOffset = Number(directory.readBigUInt64LE(field))
      }
      extra += 4 + length
    }

    entries.push(entry)
    at = extraEnd + commentLength
  }
  return entries
}
