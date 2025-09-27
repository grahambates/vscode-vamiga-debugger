import { MemoryType } from "./amigaHunkParser";
import { normalize } from "path";

export interface Location {
  path: string;
  line: number;
  symbol?: string;
  symbolOffset?: number;
  address: number;
  segmentIndex: number;
  segmentOffset: number;
}

export interface Segment {
  name: string;
  address: number;
  size: number;
  memType: MemoryType;
}

export interface SymbolOffset {
  symbol: string;
  offset: number;
}

export class SourceMap {
  private locationsBySource = new Map<string, Map<number, Location>>();
  private locationsByAddress = new Map<number, Location>();

  constructor(
    private segments: Segment[],
    private sources: Set<string>,
    private symbols: Record<string, number>,
    locations: Location[],
  ) {
    for (const location of locations) {
      this.locationsByAddress.set(location.address, location);
      const pathKey = location.path.toUpperCase();
      const linesMap =
        this.locationsBySource.get(pathKey) || new Map<number, Location>();
      linesMap.set(location.line, location);
      this.locationsBySource.set(pathKey, linesMap);
    }
  }

  public getSourceFiles(): string[] {
    return Array.from(this.sources.values());
  }

  public getSegmentsInfo(): Segment[] {
    return this.segments;
  }

  public getSymbols(): Record<string, number> {
    return this.symbols;
  }

  public lookupAddress(address: number): Location | undefined {
    let location = this.locationsByAddress.get(address);
    if (!location) {
      for (const [a, l] of this.locationsByAddress.entries()) {
        if (a > address) break;
        if (address - a <= 10) location = l;
      }
    }
    return location;
  }

  public lookupSourceLine(path: string, line: number): Location {
    const pathKey = normalize(path).toUpperCase();
    const fileMap = this.locationsBySource.get(pathKey);
    if (!fileMap) {
      throw new Error(`Source map error: File not found: ${path}`);
    }
    let location = fileMap.get(line);
    if (!location) {
      for (const [ln, loc] of fileMap.entries()) {
        if (ln > line) break;
        location = loc;
      }
    }
    if (!location) {
      throw new Error(`Source map error: Location not found for line ${line}`);
    }
    return location;
  }

  public getSegmentInfo(segmentId: number): Segment {
    return this.segments[segmentId];
  }

  public findSegmentForAddress(address: number): Segment | undefined {
    return this.segments.find(
      (segment) =>
        segment.address <= address && segment.address + segment.size > address,
    );
  }

  /**
   * Calculate the length of bytes labelled by each symbol
   *
   * Assumes symbols are already ordered by address within each segment.
   * Returns the number of bytes from each symbol to the next symbol or end of segment.
   * Of course this doesn't guarantee all this code/data is actually related to the label,
   * if there's other unlabelled code/data, but it's the best we can do.
   *
   * @returns length in bytes for each symbol name as an object
   */
  public getSymbolLengths(): Record<string, number> | undefined {
    const symbolLengths: Record<string, number> = {};
    let prevSymbolName: string | undefined;
    let prevSymbolSegment: Segment | undefined;
    let prevSymbolAddress: number | undefined;

    for (const symbolName in this.symbols) {
      const symbolAddress = this.symbols[symbolName];
      const symbolSegment = this.findSegmentForAddress(symbolAddress);

      // Calculate length of previous symbol now that we have the current symbol's info
      if (prevSymbolName && prevSymbolAddress && prevSymbolSegment) {
        if (symbolSegment === prevSymbolSegment) {
          // Current symbol is in same segment - use distance between symbols
          symbolLengths[prevSymbolName] = symbolAddress - prevSymbolAddress;
        } else {
          // Current symbol is in different segment - previous symbol extends to end of its segment
          const segmentEnd = prevSymbolSegment.address + prevSymbolSegment.size;
          symbolLengths[prevSymbolName] = segmentEnd - prevSymbolAddress;
        }
      }

      prevSymbolName = symbolName;
      prevSymbolAddress = symbolAddress;
      prevSymbolSegment = symbolSegment;
    }

    // Handle the last symbol - it extends to the end of its segment
    if (prevSymbolName && prevSymbolAddress && prevSymbolSegment) {
      const segmentEnd = prevSymbolSegment.address + prevSymbolSegment.size;
      symbolLengths[prevSymbolName] = segmentEnd - prevSymbolAddress;
    }

    return symbolLengths;
  }

  /**
   * Find the offset from the previous label in source for a given address
   *
   * @param address
   * @returns
   */
  public findSymbolOffset(address: number): SymbolOffset | undefined {
    // Find which segment (if any) address is in
    const currentSegment = this.findSegmentForAddress(address);
    // Only care about addresses in our source map
    if (currentSegment === undefined) {
      return;
    }

    let ret: SymbolOffset | undefined;
    for (const symbol in this.symbols) {
      const symAddr = this.symbols[symbol];
      const offset = address - symAddr;
      // Address is after symbol and in same segment
      if (
        offset >= 0 &&
        currentSegment === this.findSegmentForAddress(symAddr)
      ) {
        ret = { symbol, offset };
      }
    }
    return ret;
  }
}
