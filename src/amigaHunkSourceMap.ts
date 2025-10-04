import { Hunk } from "./amigaHunkParser";
import { normalize } from "path";
import { SourceMap, Segment, Location } from "./sourceMap";

/**
 * Creates a source map from Amiga hunk debug information.
 *
 * Processes debugging information embedded in Amiga executable hunks
 * to create a mapping between memory addresses and source file locations.
 * Extracts symbols, line numbers, and source file references.
 *
 * @param hunks Array of parsed Amiga hunks containing debug info
 * @param offsets Memory offset addresses where hunks are loaded
 * @returns SourceMap instance for address-to-source resolution
 */
export function sourceMapFromHunks(
  hunks: Hunk[],
  offsets: number[],
): SourceMap {
  const symbols: Record<string, number> = {};
  const locations: Location[] = [];
  const sources = new Set<string>();
  const segments: Segment[] = offsets.map((address, i) => {
    const hunk = hunks[i];
    return {
      address,
      // TODO: can we get section names?
      name: `Seg${i}_${hunk.hunkType}_${hunk.memType}`,
      size: hunk.dataSize ?? hunk.allocSize,
      memType: hunk.memType,
    };
  });

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const hunk = hunks[i];

    for (const { offset, name } of hunk.symbols) {
      symbols[name] = seg.address + offset;
    }

    // Add first source from each hunk
    // This should be the entry point. Others files may be includes.
    if (hunk.lineDebugInfo[0]) {
      sources.add(normalize(hunk.lineDebugInfo[0].sourceFilename));
    }

    for (const debugInfo of hunk.lineDebugInfo) {
      const path = normalize(debugInfo.sourceFilename);
      for (const lineInfo of debugInfo.lines) {
        const address = seg.address + lineInfo.offset;
        let symbol;
        let symbolOffset;
        for (const { offset, name } of hunk.symbols) {
          if (offset > lineInfo.offset) break;
          symbol = name;
          symbolOffset = lineInfo.offset - offset;
        }
        locations.push({
          path,
          line: lineInfo.line,
          symbol,
          symbolOffset,
          segmentIndex: i,
          segmentOffset: lineInfo.offset,
          address,
        });
      }
    }
  }

  // Ensure we found some debug info
  if (!sources.size) {
    throw new Error(
      "Source map error: No debug information found in hunk executable",
    );
  }

  return new SourceMap(segments, sources, symbols, locations);
}
