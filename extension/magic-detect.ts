/**
 * Unified content type detection using magic bytes + file name extension.
 *
 * Detection priority: magic bytes > file extension.
 * When both are available and disagree, a mismatch warning is generated.
 *
 * Pure implementation — no external dependencies. Covers all formats
 * relevant to H5 Viewer (audio, video, image, JSON, NPY).
 */

// ---------------------------------------------------------------------------
// Content categories
// ---------------------------------------------------------------------------

export type ContentCategory = 'audio' | 'video' | 'image' | 'json' | 'npy' | 'binary' | 'unknown';

export interface DetectionResult {
  category: ContentCategory;
  mime: string;
  ext: string;
  label: string;
  detectedBy: 'magic' | 'extension' | 'content-heuristic';
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
  opus: { category: 'audio', mime: 'audio/opus', label: 'Opus Audio' },
  wma:  { category: 'audio', mime: 'audio/x-ms-wma', label: 'WMA Audio' },
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
  ico:  { category: 'image', mime: 'image/x-icon', label: 'ICO Image' },
  // Video
  mp4:  { category: 'video', mime: 'video/mp4', label: 'MP4 Video' },
  mkv:  { category: 'video', mime: 'video/matroska', label: 'MKV Video' },
  webm: { category: 'video', mime: 'video/webm', label: 'WebM Video' },
  avi:  { category: 'video', mime: 'video/x-msvideo', label: 'AVI Video' },
  mov:  { category: 'video', mime: 'video/quicktime', label: 'MOV Video' },
  // Data
  json: { category: 'json', mime: 'application/json', label: 'JSON Data' },
  npy:  { category: 'npy', mime: 'application/x-numpy', label: 'NumPy Array' },
  npz:  { category: 'npy', mime: 'application/x-numpy', label: 'NumPy Archive' },
};

// ---------------------------------------------------------------------------
// Magic bytes signatures (pure implementation, no external deps)
// ---------------------------------------------------------------------------

interface MagicSig {
  offset: number;
  bytes: number[];
  ext: string;
  mime: string;
  category: ContentCategory;
  label: string;
  /** Optional secondary check at different offset */
  also?: { offset: number; bytes: number[] };
}

const MAGIC_SIGS: MagicSig[] = [
  // Audio
  { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46], also: { offset: 8, bytes: [0x57, 0x41, 0x56, 0x45] },
    ext: 'wav', mime: 'audio/wav', category: 'audio', label: 'WAV Audio' },
  { offset: 0, bytes: [0x66, 0x4c, 0x61, 0x43],  // fLaC
    ext: 'flac', mime: 'audio/flac', category: 'audio', label: 'FLAC Audio' },
  { offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53],  // OggS
    ext: 'ogg', mime: 'audio/ogg', category: 'audio', label: 'OGG Audio' },
  { offset: 0, bytes: [0x49, 0x44, 0x33],  // ID3 (MP3 with ID3 tag)
    ext: 'mp3', mime: 'audio/mpeg', category: 'audio', label: 'MP3 Audio' },
  { offset: 0, bytes: [0xff, 0xfb],  // MP3 frame sync (MPEG1 Layer3)
    ext: 'mp3', mime: 'audio/mpeg', category: 'audio', label: 'MP3 Audio' },
  { offset: 0, bytes: [0xff, 0xf3],  // MP3 frame sync (MPEG2 Layer3)
    ext: 'mp3', mime: 'audio/mpeg', category: 'audio', label: 'MP3 Audio' },
  { offset: 0, bytes: [0xff, 0xf2],  // MP3 frame sync (MPEG2.5 Layer3)
    ext: 'mp3', mime: 'audio/mpeg', category: 'audio', label: 'MP3 Audio' },
  { offset: 0, bytes: [0x46, 0x4f, 0x52, 0x4d], also: { offset: 8, bytes: [0x41, 0x49, 0x46, 0x46] },
    ext: 'aiff', mime: 'audio/aiff', category: 'audio', label: 'AIFF Audio' },
  { offset: 0, bytes: [0x4d, 0x54, 0x68, 0x64],  // MThd (MIDI)
    ext: 'mid', mime: 'audio/midi', category: 'audio', label: 'MIDI' },
  // Image
  { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ext: 'png', mime: 'image/png', category: 'image', label: 'PNG Image' },
  { offset: 0, bytes: [0xff, 0xd8, 0xff],
    ext: 'jpg', mime: 'image/jpeg', category: 'image', label: 'JPEG Image' },
  { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38],  // GIF8
    ext: 'gif', mime: 'image/gif', category: 'image', label: 'GIF Image' },
  { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46], also: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
    ext: 'webp', mime: 'image/webp', category: 'image', label: 'WebP Image' },
  { offset: 0, bytes: [0x42, 0x4d],  // BM
    ext: 'bmp', mime: 'image/bmp', category: 'image', label: 'BMP Image' },
  { offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00],  // TIFF LE
    ext: 'tiff', mime: 'image/tiff', category: 'image', label: 'TIFF Image' },
  { offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a],  // TIFF BE
    ext: 'tiff', mime: 'image/tiff', category: 'image', label: 'TIFF Image' },
  // Video (ftyp box for MP4/MOV/M4A family)
  // Check for 'ftyp' at offset 4
  { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70],  // ftyp
    ext: 'mp4', mime: 'video/mp4', category: 'video', label: 'MP4 Video' },
  { offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3],  // EBML (MKV/WebM)
    ext: 'mkv', mime: 'video/matroska', category: 'video', label: 'MKV/WebM Video' },
  { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46], also: { offset: 8, bytes: [0x41, 0x56, 0x49, 0x20] },
    ext: 'avi', mime: 'video/x-msvideo', category: 'video', label: 'AVI Video' },
  // Data
  { offset: 0, bytes: [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59],  // \x93NUMPY
    ext: 'npy', mime: 'application/x-numpy', category: 'npy', label: 'NumPy Array' },
];

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

export function detectByExtension(name: string): DetectionResult | null {
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx < 0) return null;
  const ext = name.slice(dotIdx + 1).toLowerCase();
  const info = EXT_MAP[ext];
  if (!info) return null;
  return { ...info, ext, detectedBy: 'extension' };
}

function matchBytes(data: Uint8Array, offset: number, expected: number[]): boolean {
  if (data.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (data[offset + i] !== expected[i]) return false;
  }
  return true;
}

export async function detectByMagic(data: Uint8Array): Promise<DetectionResult | null> {
  // Check all magic signatures
  for (const sig of MAGIC_SIGS) {
    if (matchBytes(data, sig.offset, sig.bytes)) {
      // Check secondary signature if present
      if (sig.also && !matchBytes(data, sig.also.offset, sig.also.bytes)) {
        continue;
      }
      return {
        category: sig.category,
        mime: sig.mime,
        ext: sig.ext,
        label: sig.label,
        detectedBy: 'magic',
      };
    }
  }

  // Special: ftyp box can indicate M4A (audio) instead of MP4 (video)
  // Check the brand string after 'ftyp'
  if (matchBytes(data, 4, [0x66, 0x74, 0x79, 0x70]) && data.length >= 12) {
    const brand = String.fromCharCode(data[8], data[9], data[10], data[11]);
    if (brand === 'M4A ' || brand === 'M4B ') {
      return {
        category: 'audio',
        mime: 'audio/x-m4a',
        ext: 'm4a',
        label: 'M4A Audio',
        detectedBy: 'magic',
      };
    }
  }

  // Special: AAC ADTS header (0xFFF1 or 0xFFF9)
  if (data.length >= 2 && data[0] === 0xff && (data[1] & 0xf0) === 0xf0 && (data[1] & 0x06) === 0x00) {
    return {
      category: 'audio',
      mime: 'audio/aac',
      ext: 'aac',
      label: 'AAC Audio',
      detectedBy: 'magic',
    };
  }

  // JSON heuristic (text-based)
  if (data.length >= 1) {
    let start = 0;
    if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) start = 3;
    while (start < data.length && (data[start] === 0x20 || data[start] === 0x09 || data[start] === 0x0a || data[start] === 0x0d)) start++;
    if (start < data.length && (data[start] === 0x7b || data[start] === 0x5b)) {
      try {
        const text = new TextDecoder().decode(data.subarray(0, Math.min(data.length, 1024)));
        if (text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
          return { category: 'json', mime: 'application/json', ext: 'json', label: 'JSON Data', detectedBy: 'content-heuristic' };
        }
      } catch { /* not UTF-8 */ }
    }
  }

  return null;
}

export async function detectContentType(name: string, firstBytes: Uint8Array): Promise<DetectionResult> {
  const byExt = detectByExtension(name);
  const byMagic = await detectByMagic(firstBytes);

  if (byMagic && byExt) {
    if (byMagic.ext === byExt.ext || byMagic.mime === byExt.mime) {
      return { ...byMagic };
    }
    return {
      ...byMagic,
      mismatchWarning:
        `File extension suggests ${byExt.label} (.${byExt.ext}), ` +
        `but content is actually ${byMagic.label} (${byMagic.mime}). ` +
        `Using detected content type.`,
    };
  }

  if (byMagic) return byMagic;
  if (byExt) return byExt;

  return { category: 'unknown', mime: 'application/octet-stream', ext: '', label: 'Unknown', detectedBy: 'extension' };
}

export const DETECTION_SAMPLE_SIZE = 4100;
