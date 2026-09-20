/**
 * Raster brand-asset generator.
 *
 * Browsers and platforms still expect raster icons: Safari and older Android use
 * `apple-touch-icon.png`, and legacy clients fetch `/favicon.ico`. Rather than
 * hand-drawing those in an editor (unreviewable, and impossible to regenerate),
 * this script rasterises the same geometry as `public/icon.svg` — rounded square,
 * three ascending rounded bars — at every required size and encodes the files
 * with Node's built-in zlib. No image dependency is needed.
 *
 * Run after changing the logo:
 *
 *   node scripts/generate-icons.mjs
 *
 * Writes:
 *   public/favicon.ico          16/32/48 multi-size ICO
 *   public/icon-192.png          PWA / Android
 *   public/icon-512.png          PWA / Android
 *   public/apple-touch-icon.png  180x180, opaque (iOS composites on white)
 *   public/opengraph-image.png   1200x630 social card
 *   src-equivalent SVG sources remain the source of truth
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// ---------------------------------------------------------------------------
// Brand geometry, mirroring public/icon.svg in a 64x64 coordinate space
// ---------------------------------------------------------------------------
const BRAND = {
  /** Gradient endpoints of the container. */
  gradientFrom: [0x3b, 0x82, 0xf6],
  gradientTo: [0x1d, 0x4e, 0xd8],
  containerRadius: 15,
  bars: [
    { x: 14, y: 34, w: 9, h: 17, color: [0xff, 0xff, 0xff] },
    { x: 27.5, y: 26, w: 9, h: 25, color: [0xff, 0xff, 0xff] },
    { x: 41, y: 16, w: 9, h: 35, color: [0xbf, 0xdb, 0xfe] },
  ],
};

/** Signed distance to a rounded rectangle centred on (cx, cy). */
function roundedRectSdf(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/**
 * Rasterise the brand mark.
 *
 * Supersampled 4x then box-filtered, which is what gives clean rounded corners
 * and bar caps at 16px without any antialiasing library.
 *
 * @param {number} size output edge length in pixels
 * @param {{ transparent?: boolean, inset?: number }} [options]
 *   `transparent` leaves the container corners transparent (favicon/PWA);
 *   `inset` shrinks the mark into the safe zone (maskable icons).
 */
function renderMark(size, options = {}) {
  const { transparent = true, inset = 1 } = options;
  const SS = 4; // supersample factor
  const W = size * SS;
  const pixels = new Uint8Array(size * size * 4); // RGBA, non-premultiplied

  const scale = (64 / size) * (1 / inset);
  const offset = (64 - 64 * (1 / inset)) / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          // Sample position in brand space.
          const px = ((x + (sx + 0.5) / SS) * scale) + offset;
          const py = ((y + (sy + 0.5) / SS) * scale) + offset;

          // Start with the container (gradient fill + rounded corners).
          const containerD = roundedRectSdf(px, py, 32, 32, 32, 32, BRAND.containerRadius);
          const containerAlpha = Math.max(0, Math.min(1, 0.5 - containerD));

          // Diagonal gradient across the container.
          const t = Math.max(0, Math.min(1, (px + py) / 128));
          let sr = BRAND.gradientFrom[0] + (BRAND.gradientTo[0] - BRAND.gradientFrom[0]) * t;
          let sg = BRAND.gradientFrom[1] + (BRAND.gradientTo[1] - BRAND.gradientFrom[1]) * t;
          let sb = BRAND.gradientFrom[2] + (BRAND.gradientTo[2] - BRAND.gradientFrom[2]) * t;
          let sa = transparent ? containerAlpha : 1;

          // Composite each bar over the container.
          for (const bar of BRAND.bars) {
            const cx = bar.x + bar.w / 2;
            const cy = bar.y + bar.h / 2;
            const halfW = bar.w / 2;
            const halfH = bar.h / 2;
            // Fully rounded caps: radius cannot exceed half the shorter side.
            const radius = Math.min(halfW, halfH);
            const d = roundedRectSdf(px, py, cx, cy, halfW, halfH, radius);
            const barAlpha = Math.max(0, Math.min(1, 0.5 - d));
            if (barAlpha <= 0) continue;

            sr = bar.color[0] * barAlpha + sr * (1 - barAlpha);
            sg = bar.color[1] * barAlpha + sg * (1 - barAlpha);
            sb = bar.color[2] * barAlpha + sb * (1 - barAlpha);
            sa = barAlpha + sa * (1 - barAlpha);
          }

          r += sr;
          g += sg;
          b += sb;
          a += sa;
        }
      }

      const samples = SS * SS;
      const index = (y * size + x) * 4;
      pixels[index] = Math.round(r / samples);
      pixels[index + 1] = Math.round(g / samples);
      pixels[index + 2] = Math.round(b / samples);
      pixels[index + 3] = Math.round((a / samples) * 255);
    }
  }

  return pixels;
}

// ---------------------------------------------------------------------------
// PNG encoding (RGB/RGBA, 8-bit, no interlace) using zlib only
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** Encode RGBA pixels as a PNG buffer. */
function encodePng(pixels, width, height, { alphaChannel = true } = {}) {
  const channels = alphaChannel ? 4 : 3;
  const raw = Buffer.alloc(height * (1 + width * channels));

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * channels);
    raw[rowStart] = 0; // filter type 0 (None)
    for (let x = 0; x < width; x += 1) {
      const src = (y * width + x) * 4;
      const dst = rowStart + 1 + x * channels;
      if (alphaChannel) {
        raw[dst] = pixels[src];
        raw[dst + 1] = pixels[src + 1];
        raw[dst + 2] = pixels[src + 2];
        raw[dst + 3] = pixels[src + 3];
      } else {
        // Flatten onto white: iOS composites transparent apple-touch-icons on
        // white anyway, and doing it here keeps the file predictable.
        const a = pixels[src + 3] / 255;
        raw[dst] = Math.round(pixels[src] * a + 255 * (1 - a));
        raw[dst + 1] = Math.round(pixels[src + 1] * a + 255 * (1 - a));
        raw[dst + 2] = Math.round(pixels[src + 2] * a + 255 * (1 - a));
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = alphaChannel ? 6 : 2; // colour type: 6 = RGBA, 2 = RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// ICO container (PNG-compressed entries, supported by every modern browser and
// by Windows Vista and later)
// ---------------------------------------------------------------------------
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = 6 + directory.length;
  const images = [];

  entries.forEach((entry, index) => {
    const base = index * 16;
    // 256px is encoded as 0 in the ICO directory.
    directory[base] = entry.size >= 256 ? 0 : entry.size;
    directory[base + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[base + 2] = 0; // palette colours
    directory[base + 3] = 0; // reserved
    directory.writeUInt16LE(1, base + 4); // colour planes
    directory.writeUInt16LE(32, base + 6); // bits per pixel
    directory.writeUInt32LE(entry.png.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += entry.png.length;
    images.push(entry.png);
  });

  return Buffer.concat([header, directory, ...images]);
}

// ---------------------------------------------------------------------------
// Social card (1200x630)
// ---------------------------------------------------------------------------
function renderSocialCard() {
  const width = 1200;
  const height = 630;
  const pixels = new Uint8Array(width * height * 4);

  const set = (x, y, [r, g, b], alpha = 1) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = (y * width + x) * 4;
    const existing = pixels[index + 3] / 255;
    const out = alpha + existing * (1 - alpha);
    pixels[index] = Math.round((r * alpha + pixels[index] * existing * (1 - alpha)) / (out || 1));
    pixels[index + 1] = Math.round((g * alpha + pixels[index + 1] * existing * (1 - alpha)) / (out || 1));
    pixels[index + 2] = Math.round((b * alpha + pixels[index + 2] * existing * (1 - alpha)) / (out || 1));
    pixels[index + 3] = Math.round(out * 255);
  };

  /** Fill a rounded rect with 3x3 supersampling for smooth corners. */
  const fillRounded = (rx, ry, rw, rh, radius, color, alpha = 1) => {
    for (let y = Math.floor(ry); y < Math.ceil(ry + rh); y += 1) {
      for (let x = Math.floor(rx); x < Math.ceil(rx + rw); x += 1) {
        let covered = 0;
        for (let sy = 0; sy < 3; sy += 1) {
          for (let sx = 0; sx < 3; sx += 1) {
            const px = x + (sx + 0.5) / 3;
            const py = y + (sy + 0.5) / 3;
            const d = roundedRectSdf(px, py, rx + rw / 2, ry + rh / 2, rw / 2, rh / 2, radius);
            if (d <= 0) covered += 1;
          }
        }
        if (covered > 0) set(x, y, color, alpha * (covered / 9));
      }
    }
  };

  // Background: dark diagonal gradient, matching the app's dark theme.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = (x / width + y / height) / 2;
      const index = (y * width + x) * 4;
      pixels[index] = Math.round(0x0f + (0x1e - 0x0f) * t);
      pixels[index + 1] = Math.round(0x17 + (0x29 - 0x17) * t);
      pixels[index + 2] = Math.round(0x2a + (0x3b - 0x2a) * t);
      pixels[index + 3] = 255;
    }
  }

  // Top accent bar
  fillRounded(0, 0, width, 8, 0, [0x25, 0x63, 0xeb]);

  // Brand mark, scaled from the 64x64 geometry.
  const markSize = 132;
  const markX = 80;
  const markY = 70;
  const s = markSize / 64;
  fillRounded(markX, markY, markSize, markSize, BRAND.containerRadius * s, [0x25, 0x63, 0xeb]);
  for (const bar of BRAND.bars) {
    fillRounded(
      markX + bar.x * s,
      markY + bar.y * s,
      bar.w * s,
      bar.h * s,
      (Math.min(bar.w, bar.h) / 2) * s,
      bar.color,
    );
  }

  // Feature chips, mirroring the SVG card's copy.
  const chips = [
    'Enrichment + LLM classification',
    'Parent / subsidiary roll-up',
    'Human review queue',
    'CSV and PDF reporting',
    'Live supplier sync',
    'Free-tier deployable',
  ];
  chips.forEach((_, index) => {
    const col = index % 3;
    const row = Math.floor(index / 3);
    fillRounded(80 + col * 344, 366 + row * 62, 324, 46, 23, [0x1e, 0x29, 0x3b], 1);
    fillRounded(80 + col * 344, 366 + row * 62, 324, 46, 23, [0x33, 0x41, 0x55], 0);
  });

  return encodePng(pixels, width, height, { alphaChannel: true });
}

// ---------------------------------------------------------------------------
// Write the assets
// ---------------------------------------------------------------------------
function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const written = [];
  const write = (name, buffer) => {
    writeFileSync(join(OUT_DIR, name), buffer);
    written.push([name, buffer.length]);
  };

  // Favicon: multi-size ICO so Windows and legacy browsers pick a crisp size.
  const icoEntries = [16, 32, 48].map((size) => ({
    size,
    png: encodePng(renderMark(size, { transparent: true }), size, size),
  }));
  write('favicon.ico', encodeIco(icoEntries));

  // PWA / Android icons.
  for (const size of [192, 512]) {
    write(`icon-${size}.png`, encodePng(renderMark(size, { transparent: true }), size, size));
  }

  // iOS home-screen icon: opaque, inset into the safe zone.
  const appleSize = 180;
  write(
    'apple-touch-icon.png',
    encodePng(renderMark(appleSize, { transparent: false, inset: 1.15 }), appleSize, appleSize, {
      alphaChannel: false,
    }),
  );

  // Social card.
  write('opengraph-image.png', renderSocialCard());

  console.log('generated brand assets:');
  for (const [name, bytes] of written) {
    console.log(`  public/${name.padEnd(24)} ${(bytes / 1024).toFixed(1)} KB`);
  }
}

main();
