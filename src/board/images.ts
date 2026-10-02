import { BOARD_WIDTH, FULL_EDGE, LIMITS } from '../../shared/protocol.ts';

export interface Prepared {
  // size of the full copy
  w: number;
  h: number;
  // a tiny blurred preview that ships inside the board itself
  ph: string;
  full: Blob;
  board: Blob;
}

type Canvas = HTMLCanvasElement | OffscreenCanvas;

// Safari can't encode WebP from a canvas (it quietly hands back PNG), so check once.
const WEBP = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  return c.toDataURL('image/webp').startsWith('data:image/webp');
})();
const TYPE = WEBP ? 'image/webp' : 'image/jpeg';

function draw(src: CanvasImageSource, w: number, h: number): Canvas {
  const canvas: Canvas =
    typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  // JPEG has no transparency; let see-through parts land on white paper, not black
  if (!WEBP) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return canvas;
}

function encode(canvas: Canvas, quality: number): Promise<Blob> {
  if (canvas instanceof HTMLCanvasElement) {
    return new Promise((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('could not encode image'))), TYPE, quality),
    );
  }
  return canvas.convertToBlob({ type: TYPE, quality });
}

function placeholder(src: Canvas, w: number, h: number): string {
  // two steps down so the tiny version is a fair average of the picture
  const mid = draw(src, 96, Math.max(1, Math.round((96 * h) / w)));
  const tiny = document.createElement('canvas');
  tiny.width = 12;
  tiny.height = Math.max(1, Math.round((12 * h) / w));
  const ctx = tiny.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(mid as CanvasImageSource, 0, 0, tiny.width, tiny.height);
  const url = tiny.toDataURL(TYPE, 0.5);
  return url.length <= LIMITS.placeholder ? url : '';
}

/**
 * Turns a picked photo into the two copies the board stores: the full copy
 * (long edge at most FULL_EDGE) for viewing and a board copy BOARD_WIDTH wide,
 * plus the blurred preview. Doing it here keeps uploads small and the server dumb.
 */
export async function prepare(file: Blob): Promise<Prepared> {
  // decoding applies the photo's own rotation
  const bitmap = await createImageBitmap(file);
  try {
    let edge = Math.min(FULL_EDGE, Math.max(bitmap.width, bitmap.height));
    for (;;) {
      const scale = edge / Math.max(bitmap.width, bitmap.height);
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const fullCanvas = draw(bitmap, w, h);
      let full = await encode(fullCanvas, 0.82);
      if (full.size > LIMITS.imageBytes) full = await encode(fullCanvas, 0.62);
      if (full.size > LIMITS.imageBytes) {
        // an unusually busy picture: make it smaller rather than uglier
        edge = Math.round(edge * 0.75);
        continue;
      }
      const bw = Math.min(BOARD_WIDTH, w);
      const bh = Math.max(1, Math.round((h * bw) / w));
      const boardCanvas = draw(fullCanvas as CanvasImageSource, bw, bh);
      const board = await encode(boardCanvas, 0.8);
      return { w, h, ph: placeholder(boardCanvas, bw, bh), full, board };
    }
  } finally {
    bitmap.close();
  }
}
