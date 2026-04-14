/**
 * Unified content type detection using magic bytes + file name extension.
 *
 * Detection priority: magic bytes > file extension.
 * When both are available and disagree, a mismatch warning is generated.
 *
 * Uses:
 * - `file-type` npm package for binary format detection (200+ formats)
 * - Custom detection for JSON (text-based, not covered by file-type)
 * - Custom detection for NPY (\x93NUMPY magic)
 */

import { fileTypeFromBuffer } from 'file-type';

// ---------------------------------------------------------------------------
// Content categories
// ---------------------------------------------------------------------------

export type ContentCategory = 'audio' | 'video' | 'image' | 'json' | 'npy' | 'binary' | 'unknown';

export interface DetectionResult {
  /** Detected content category */
  category: ContentCategory;
  /** MIME type (e.g. 'audio/wav', 'application/json') */
  mime: string;
  /** File extension without dot (e.g. 'wav', 'mp3') */
  ext: string;
  /** Human-readable label (e.g. 'WAV Audio', 'FLAC Audio') */
  label: string;
  /** How the type was detected */
  detectedBy: 'magic' | 'extension' | 'content-heuristic';
  /** Warning if magic bytes and extension disagree */
  mismatchWarning?: string;
}

// ---------------------------------------------------------------------------
// Extension → category / MIME mapping
// ---------------------------------------------------------------------------

const EXT_MAP: Record<string, { category: ContentCategory; mime: string; label: string }> = {
  // Audio
  mp3:  { category: 'audio', mime: 'audio/mpeg', label: 'MP3 Audio' },
  wav:  { category: 'audio', mime: 'audio/wav', label: 'WAV Audio' },
  flac: { category: 'audio', mime: 'audio/flac', label: 'FLAC Audio' },
  ogg:  { category: 'audio', mime: 'audio/ogg', label: 'OGG Audio' },
  aac:  { category: 'audio', mime: 'audio/aac', label: 'AAC Audio' },
  m4a:  { category: 'audio', mime: 'audio/x-m4a', label: 'M4A Audio' },
  opus: { category: 'audio', mime: 'audio/ogg; codecs=opus', label: 'Opus Audio' },
  wma:  { category: 'audio', mime: 'audio/x-ms-asf', label: 'WMA Audio' },
  aiff: { category: 'audio', mime: 'audio/aiff', label: 'AIFF Audio' },
  mid:  { category: 'audio', mime: 'audio/midi', label: 'MIDI' },
  midi: { category: 'audio', mime: 'audio/midi', label: 'MIDI' },
  // Image
  png:  { category: 'image', mime: 'image/png', label: 'PNG Image' },
  jpg:  { category: 'image', mime: 'image/jpeg', label: 'JPEG Image' },
  jpeg: { category: 'image', mime: 'image/jpeg', label: 'JPEG Image' },
  gif:  { category: 'image', mime: 'image/gif', label: 'GIF Image' },
  bmp:  { category: 'image', mime: 'image/bmp', label: 'BMP Image' },
  webp: { category: 'image', mime: 'image/webp', label: 'WebP Image' },
  tiff: { category: 'image', mime: 'image/tiff', label: 'TIFF Image' },
  tif:  { category: 'image', mime: 'image/tiff', label: 'TIFF Image' },
  svg:  { category: 'image', mime: 'image/svg+xml', label: 'SVG Image' },
  ico:  { category: 'image', mime: 'image/x-icon', label: 'ICO Image' },
  // Video
  mp4:  { category: 'video', mime: 'video/mp4', label: 'MP4 Video' },
  mkv:  { category: 'video', mime: 'video/matroska', label: 'MKV Video' },
  webm: { category: 'video', mime: 'video/webm', label: 'WebM Video' },
  avi:  { category: 'video', mime: 'video/vnd.avi', label: 'AVI Video' },
  mov:  { category: 'video', mime: 'video/quicktime', label: 'MOV Video' },
  // Data
  json: { category: 'json', mime: 'application/json', label: 'JSON Data' },
  npy:  { category: 'npy', mime: 'application/x-numpy', label: 'NumPy Array' },
  npz:  { category: 'npy', mime: 'application/x-numpy', label: 'NumPy Archive' },
};

// MIME → category mapping for file-type results
const MIME_CATEGORY: Record<string, ContentCategory> = {};
for (const [, v] of Object.entries(EXT_MAP)) {
  if (!MIME_CATEGORY[v.mime]) MIME_CATEGORY[v.mime] = v.category;
}

// Also map some MIME types that file-type returns but aren't in our EXT_MAP
const EXTRA_MIME_CATEGORY: Record<string, { category: ContentCategory; label: string }> = {
  'audio/mpeg': { category: 'audio', label: 'MP3 Audio' },
  'audio/mp4': { category: 'audio', label: 'M4A Audio' },
  'audio/ogg; codecs=opus': { category: 'audio', label: 'Opus Audio' },
  'audio/ape': { category: 'audio', label: 'APE Audio' },
  'audio/wavpack': { category: 'audio', label: 'WavPack Audio' },
  'audio/amr': { category: 'audio', label: 'AMR Audio' },
  'audio/x-musepack': { category: 'audio', label: 'Musepack Audio' },
  'audio/x-dsf': { category: 'audio', label: 'DSF Audio' },
  'audio/vnd.dolby.dd-raw': { category: 'audio', label: 'Dolby Digital' },
  'video/mp4': { category: 'video', label: 'MP4 Video' },
  'video/matroska': { category: 'video', label: 'MKV Video' },
  'video/webm': { category: 'video', label: 'WebM Video' },
  'video/quicktime': { category: 'video', label: 'MOV Video' },
  'video/vnd.avi': { category: 'video', label: 'AVI Video' },
  'video/mpeg': { category: 'video', label: 'MPEG Video' },
  'video/3gpp': { category: 'video', label: '3GP Video' },
  'image/png': { category: 'image', label: 'PNG Image' },
  'image/jpeg': { category: 'image', label: 'JPEG Image' },
  'image/gif': { category: 'image', label: 'GIF Image' },
  'image/webp': { category: 'image', label: 'WebP Image' },
  'image/bmp': { category: 'image', label: 'BMP Image' },
  'image/tiff': { category: 'image', label: 'TIFF Image' },
};

// NPY magic bytes
const NPY_MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // \x93NUMPY

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

/**
 * Detect content type from file name extension only.
 */
export function detectByExtension(name: string): DetectionResult | null {
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx < 0) return null;
  const ext = name.slice(dotIdx + 1).toLowerCase();
  const info = EXT_MAP[ext];
  if (!info) return null;
  return { ...info, ext, detectedBy: 'extension' };
}

/**
 * Detect content type from the first bytes of the data (magic bytes).
 * Reads at most the first 4100 bytes (file-type's recommended sample size).
 */
export async function detectByMagic(data: Uint8Array): Promise<DetectionResult | null> {
  // 1. Check NPY magic (file-type doesn't detect it)
  if (data.length >= 6 && NPY_MAGIC.every((b, i) => data[i] === b)) {
    return {
      category: 'npy',
      mime: 'application/x-numpy',
      ext: 'npy',
      label: 'NumPy Array',
      detectedBy: 'magic',
    };
  }

  // 2. Check JSON heuristic (file-type doesn't detect text formats)
  if (data.length >= 1) {
    // Skip BOM if present
    let start = 0;
    if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
      start = 3; // UTF-8 BOM
    }
    // Skip whitespace
    while (start < data.length && (data[start] === 0x20 || data[start] === 0x09 || data[start] === 0x0a || data[start] === 0x0d)) {
      start++;
    }
    if (start < data.length && (data[start] === 0x7b || data[start] === 0x5b)) {
      // Starts with { or [ — likely JSON
      // Quick validation: try to decode as UTF-8 text
      try {
        const text = new TextDecoder().decode(data.subarray(0, Math.min(data.length, 1024)));
        if (text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
          return {
            category: 'json',
            mime: 'application/json',
            ext: 'json',
            label: 'JSON Data',
            detectedBy: 'content-heuristic',
          };
        }
      } catch {
        // Not valid UTF-8
      }
    }
  }

  // 3. Use file-type for all binary formats
  const result = await fileTypeFromBuffer(data);
  if (!result) return null;

  const extInfo = EXT_MAP[result.ext];
  const mimeInfo = EXTRA_MIME_CATEGORY[result.mime];

  const category = extInfo?.category || mimeInfo?.category || 'binary';
  const label = extInfo?.label || mimeInfo?.label || `${result.ext.toUpperCase()} (${result.mime})`;

  return {
    category,
    mime: result.mime,
    ext: result.ext,
    label,
    detectedBy: 'magic',
  };
}

/**
 * Full detection: magic bytes (priority) + extension (fallback).
 * Generates a mismatch warning if both are available and disagree.
 *
 * @param name Dataset name (e.g. 'sample.wav', 'data_001', etc.)
 * @param firstBytes First 4100+ bytes of the dataset content
 */
export async function detectContentType(
  name: string,
  firstBytes: Uint8Array,
): Promise<DetectionResult> {
  const byExt = detectByExtension(name);
  const byMagic = await detectByMagic(firstBytes);

  // Both detected
  if (byMagic && byExt) {
    // Same format → no warning
    if (byMagic.ext === byExt.ext || byMagic.mime === byExt.mime) {
      return { ...byMagic };
    }
    // Same category but different specific format (e.g. ext=mp3 but content=wav)
    // → use magic result + warning
    if (byMagic.category === byExt.category) {
      return {
        ...byMagic,
        mismatchWarning:
          `File extension suggests ${byExt.label} (.${byExt.ext}), ` +
          `but content is actually ${byMagic.label} (${byMagic.mime}). ` +
          `Using detected content type.`,
      };
    }
    // Different category entirely → use magic + stronger warning
    return {
      ...byMagic,
      mismatchWarning:
        `File extension suggests ${byExt.label} (.${byExt.ext}), ` +
        `but content is actually ${byMagic.label} (${byMagic.mime}). ` +
        `Using detected content type.`,
    };
  }

  // Only magic detected (no extension or unrecognized extension)
  if (byMagic) return byMagic;

  // Only extension detected (magic didn't match — common for text formats)
  if (byExt) return byExt;

  // Neither detected
  return {
    category: 'unknown',
    mime: 'application/octet-stream',
    ext: '',
    label: 'Unknown',
    detectedBy: 'extension',
  };
}

/**
 * Minimum number of bytes needed for reliable detection.
 * file-type recommends 4100 bytes.
 */
export const DETECTION_SAMPLE_SIZE = 4100;
