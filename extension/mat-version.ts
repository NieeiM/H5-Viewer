/**
 * Detect MAT file version from the file header.
 *
 * Reads at most the first 132 bytes to determine the format:
 * - v7.3: HDF5 magic bytes (first 8 bytes)
 * - v7:   Level 5 header + first data element is zlib-compressed (type 15)
 * - v5:   Level 5 header + first data element is uncompressed matrix (type 14)
 * - v4:   No standard header, heuristic detection
 */

import { readSync, openSync, closeSync } from 'node:fs';

export type MatVersion = 'v7.3' | 'v7' | 'v5' | 'v4' | 'unknown';

const HDF5_MAGIC = Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);

export function detectMatVersion(filePath: string): MatVersion {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(132);
    const bytesRead = readSync(fd, buf, 0, 132, 0);

    if (bytesRead < 8) {
      return 'unknown';
    }

    // Check for HDF5 magic → MAT v7.3
    if (buf.subarray(0, 8).equals(HDF5_MAGIC)) {
      return 'v7.3';
    }

    // Check for Level 5 header (v5/v7): starts with "MATLAB"
    if (bytesRead >= 128) {
      const headerText = buf.toString('ascii', 0, 6);
      if (headerText === 'MATLAB') {
        // Determine endianness from bytes 126-127
        const endianMarker = buf.toString('ascii', 126, 128);
        const littleEndian = endianMarker === 'IM';

        // Check first data element type at offset 128
        if (bytesRead >= 132) {
          const firstElemType = littleEndian
            ? buf.readUInt32LE(128)
            : buf.readUInt32BE(128);

          // Type 15 = compressed (zlib) → v7
          if (firstElemType === 15) {
            return 'v7';
          }
        }

        // Uncompressed Level 5 → v5
        return 'v5';
      }
    }

    // MAT v4 heuristic: first 4 bytes encode type as M*1000 + O*100 + P*10 + T
    if (bytesRead >= 20) {
      const type = buf.readUInt32LE(0);
      const M = Math.floor(type / 1000);
      const O = Math.floor((type % 1000) / 100);
      const P = Math.floor((type % 100) / 10);
      const T = type % 10;

      if (
        (M === 0 || M === 1) &&
        O === 0 &&
        P <= 5 &&
        T <= 2
      ) {
        const isLE = M === 0;
        const rows = isLE ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
        const cols = isLE ? buf.readUInt32LE(8) : buf.readUInt32BE(8);
        const imagf = isLE ? buf.readUInt32LE(12) : buf.readUInt32BE(12);
        const namlen = isLE ? buf.readUInt32LE(16) : buf.readUInt32BE(16);

        if (
          rows < 1_000_000 &&
          cols < 1_000_000 &&
          (imagf === 0 || imagf === 1) &&
          namlen > 0 &&
          namlen < 256
        ) {
          return 'v4';
        }
      }
    }

    return 'unknown';
  } finally {
    closeSync(fd);
  }
}

/**
 * Check if a file is an HDF5 file (by magic bytes), regardless of extension.
 */
export function isHdf5File(filePath: string): boolean {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(8);
    const bytesRead = readSync(fd, buf, 0, 8, 0);
    if (bytesRead < 8) return false;
    return buf.equals(HDF5_MAGIC);
  } finally {
    closeSync(fd);
  }
}
