import { MemoryType } from "./amigaHunkParser";
import { normalize } from "path";
import { DebugFrame, evaluateCfaAtPc } from "./dwarfParser";

export interface InlineFrame {
  name: string;
  callPath: string;
  callLine: number;
}

export interface InlineEntry {
  low: number;
  high: number;
  depth: number;
  frame: InlineFrame;
}

export type LocalLocation =
  | { kind: 'fbreg';  offset: number }
  | { kind: 'breg';   reg: number; offset: number }
  | { kind: 'addr';   address: number }
  | { kind: 'cfa';    offset: number }
  | { kind: 'unknown' };

export interface StructField {
  name: string;
  typeName: string;
  byteSize: number;
  offset: number;
}

export type TypeDescriptor =
  | { kind: 'primitive'; typeName: string; byteSize: number }
  | { kind: 'pointer';   typeName: string; byteSize: number; pointee: TypeDescriptor }
  | { kind: 'struct';    typeName: string; byteSize: number; getFields: () => FieldDescriptor[] }
  | { kind: 'array';     typeName: string; byteSize: number; elementCount: number; elementType: TypeDescriptor }
  | { kind: 'unknown';   typeName: string; byteSize: number };

export interface FieldDescriptor {
  name: string;
  offset: number;
  type: TypeDescriptor;
}

export interface Variable {
  name: string;
  typeName: string;
  byteSize: number;
  location: LocalLocation;
  typeDescriptor: TypeDescriptor;
}

export interface ScopeEntry {
  low: number;
  high: number;
  vars: Variable[];
}

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
  private sortedAddresses: number[] = [];

  constructor(
    private segments: Segment[],
    private sources: Set<string>,
    private symbols: Record<string, number>,
    locations: Location[],
    private scopeTable: ScopeEntry[] = [],
    private debugFrame?: DebugFrame,
    private inlineTable: InlineEntry[] = [],
    private globalVars: Variable[] = [],
  ) {
    for (const location of locations) {
      // Don't overwrite existing address mappings - first wins.
      // Deduplication for C/C++ vs assembly is handled upstream in sourceMapFromDwarf.
      if (!this.locationsByAddress.has(location.address)) {
        this.locationsByAddress.set(location.address, location);
      }

      const pathKey = normalize(location.path).toUpperCase();
      const linesMap =
        this.locationsBySource.get(pathKey) || new Map<number, Location>();

      // For source->address mapping, use first wins to get the earliest address for each line
      // This ensures breakpoints are set at the first instruction of a statement
      if (!linesMap.has(location.line)) {
        linesMap.set(location.line, location);
      }
      this.locationsBySource.set(pathKey, linesMap);
    }
    this.sortedAddresses = Array.from(this.locationsByAddress.keys()).sort((a, b) => a - b);
  }

  public getGlobalVariables(): Variable[] {
    return this.globalVars;
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
    const exact = this.locationsByAddress.get(address);
    if (exact) return exact;

    // Binary floor search: find the largest line-table address ≤ queried address.
    // Guards against addresses outside any loaded segment (e.g. arbitrary memory reads).
    const arr = this.sortedAddresses;
    let lo = 0, hi = arr.length - 1, floorIdx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] <= address) { floorIdx = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    if (floorIdx === -1) return undefined;
    const floorAddr = arr[floorIdx];
    if (this.findSegmentForAddress(address) !== undefined &&
        this.findSegmentForAddress(address) === this.findSegmentForAddress(floorAddr)) {
      return this.locationsByAddress.get(floorAddr);
    }
    return undefined;
  }

  public lookupSourceLine(path: string, line: number): Location {
    const pathKey = normalize(path).toUpperCase();
    const fileMap = this.locationsBySource.get(pathKey);
    if (!fileMap) {
      throw new Error(`Source map error: File not found: ${path}`);
    }
    let location = fileMap.get(line);
    if (!location) {
      // Map entries are in insertion order, not sorted by line number
      // So we need to find the highest line number <= requested line
      let bestLine = -1;
      for (const [ln, loc] of fileMap.entries()) {
        if (ln <= line && ln > bestLine) {
          bestLine = ln;
          location = loc;
        }
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

  // Returns all locals visible at the given loaded address.
  // Uses a binary search into the pre-built scope table: O(log n + nesting depth).
  public getCfaForPc(pc: number): { reg: number; offset: number } | undefined {
    if (!this.debugFrame) return undefined;
    return evaluateCfaAtPc(pc, this.debugFrame);
  }

  // Returns inline frames for the given PC, ordered innermost-first (deepest nesting first).
  public getInlineFramesForPc(pc: number): InlineFrame[] {
    return this.inlineTable
      .filter(e => e.low <= pc && pc < e.high)
      .sort((a, b) => b.depth - a.depth)
      .map(e => e.frame);
  }

  public getLocalsForPc(pc: number): Variable[] {
    const table = this.scopeTable;
    if (table.length === 0) return [];

    // Find rightmost entry with low <= pc.
    let lo = 0, hi = table.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (table[mid].low <= pc) { idx = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    if (idx === -1) return [];

    // Scan backward collecting all scopes that contain pc.
    const result: Variable[] = [];
    for (let i = idx; i >= 0; i--) {
      if (table[i].high > pc) {
        result.push(...table[i].vars);
      }
    }
    return result;
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
      if (
        offset >= 0 &&
        currentSegment === this.findSegmentForAddress(symAddr) &&
        (!ret || offset < ret.offset)
      ) {
        ret = { symbol, offset };
      }
    }
    return ret;
  }
}
