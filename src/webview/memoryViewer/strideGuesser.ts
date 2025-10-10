/**
 *  Heuristics to guess the byte-width (stride) of a 1-bit-per-pixel
 *  image embedded in an unknown-length binary buffer.
 */

/**
 * Expand each byte into an array of 8 bits (MSB-first).
 */
function bytesToBits(data: Uint8Array): number[] {
  const bits: number[] = new Array(data.length * 8);
  let k = 0;
  for (const b of data) {
    for (let i = 7; i >= 0; i--) {
      bits[k++] = (b >> i) & 1;
    }
  }
  return bits;
}

/**
 * Reshape the first `sampleRows` rows only.
 * Ignores any remainder of the buffer.
 */
function reshapeSample(
  bits: number[],
  widthBits: number,
  sampleRows: number,
): number[][] | null {
  const rowBits = widthBits * sampleRows;
  if (bits.length < rowBits) {
    return null;
  }
  const rows: number[][] = new Array(sampleRows);
  for (let r = 0; r < sampleRows; r++) {
    rows[r] = bits.slice(r * widthBits, (r + 1) * widthBits);
  }
  return rows;
}

/**
 * Similarity of each row to the next → vertical continuity
 */
function verticalCorrelation(img: number[][]): number {
  let same = 0;
  let total = 0;
  for (let r = 0; r < img.length - 1; r++) {
    const currentRow = img[r];
    const nextRow = img[r + 1];
    // Count pixels which are the same in  both rows
    for (let c = 0; c < currentRow.length; c++) {
      if (currentRow[c] === nextRow[c]) {
        same++;
      }
      total++;
    }
  }
  return total ? same / total : 0;
}

/**
 * Variance of column sums → strong vertical structure
 */
function columnVariance(img: number[][]): number {
  const h = img.length;
  const w = img[0].length;
  const sums = new Array(w).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      sums[x] += img[y][x];
    }
  }

  const mean = sums.reduce((a, b) => a + b, 0) / w;
  const varSum = sums.reduce((a, b) => a + (b - mean) ** 2, 0) / w;
  return varSum / (h * h + 1e-9); // normalise
}

/** Continuity of vertical edges */
function verticalEdgeContinuity(img: number[][]): number {
  const h = img.length;
  const w = img[0].length;
  let cont = 0;
  let total = 0;
  for (let y = 0; y < h - 1; y++)
    for (let x = 0; x < w - 1; x++) {
      const currentEdge = img[y][x] !== img[y][x + 1];
      const nextEdge = img[y + 1][x] !== img[y + 1][x + 1];
      if (currentEdge && nextEdge) cont++;
      total++;
    }
  return total ? cont / total : 0;
}

/** Weighted combination of all scores */
function combinedScore(img: number[][]): number {
  const verticalCorrelationScore = verticalCorrelation(img);
  const columnVarianceScore = columnVariance(img);
  const verticalEdgeContinuityScore = verticalEdgeContinuity(img);
  // Adjust weights if desired
  return (
    verticalCorrelationScore + columnVarianceScore + verticalEdgeContinuityScore
  );
}

/**
 * Guess plausible byte-widths when image length is unknown.
 *
 * @param data           Raw buffer
 * @param minWidthBytes  Minimum width to test (≥1)
 * @param maxWidthBytes  Maximum width to test
 * @param sampleRows     Number of rows from top of buffer to analyse
 * @param topK           How many top results to return
 */
export function guessWidthsUnknownLength(
  data: Uint8Array,
  minWidthBytes = 2,
  maxWidthBytes: number = Math.min(1024, data.length),
  sampleRows = 32,
  topK = 5,
) {
  const bits = bytesToBits(data);

  const results: {
    widthBytes: number;
    widthBits: number;
    sampleRows: number;
    score: number;
  }[] = [];

  for (let wb = minWidthBytes; wb <= maxWidthBytes; wb++) {
    const widthBits = wb * 8;
    const img = reshapeSample(bits, widthBits, sampleRows);
    if (!img) {
      continue;
    }

    const score = combinedScore(img);
    results.push({ widthBytes: wb, widthBits, sampleRows, score });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}
