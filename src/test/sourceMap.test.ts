import * as assert from 'assert';
import { SourceMap, Location, Segment } from '../sourceMap';
import { MemoryType } from '../amigaHunkParser';

/**
 * Tests for SourceMap functionality
 */
suite('SourceMap Tests', () => {
  let sourceMap: SourceMap;
  let testSegments: Segment[];
  let testSources: Set<string>;
  let testSymbols: Record<string, number>;
  let testLocations: Location[];

  setup(() => {
    testSegments = [
      { name: 'CODE', address: 0x1000, size: 0x1000, memType: MemoryType.CHIP },
      { name: 'DATA', address: 0x2000, size: 0x800, memType: MemoryType.CHIP }
    ];
    
    testSources = new Set(['/test/main.c', '/test/util.c']);
    
    testSymbols = {
      main: 0x1000,
      sub1: 0x1100,
      sub2: 0x1200,
      data_start: 0x2000,
      buffer: 0x2100
    };
    
    testLocations = [
      { path: '/test/main.c', line: 10, address: 0x1000, segmentIndex: 0, segmentOffset: 0 },
      { path: '/test/main.c', line: 15, address: 0x1020, segmentIndex: 0, segmentOffset: 0x20 },
      { path: '/test/main.c', line: 20, address: 0x1100, segmentIndex: 0, segmentOffset: 0x100 },
      { path: '/test/util.c', line: 5, address: 0x1200, segmentIndex: 0, segmentOffset: 0x200 }
    ];
    
    sourceMap = new SourceMap(testSegments, testSources, testSymbols, testLocations);
  });

  suite('Constructor and Basic Access', () => {
    test('should store segments correctly', () => {
      const segments = sourceMap.getSegmentsInfo();
      assert.strictEqual(segments.length, 2);
      assert.strictEqual(segments[0].name, 'CODE');
      assert.strictEqual(segments[1].name, 'DATA');
    });

    test('should store source files correctly', () => {
      const sources = sourceMap.getSourceFiles();
      assert.strictEqual(sources.length, 2);
      assert.ok(sources.includes('/test/main.c'));
      assert.ok(sources.includes('/test/util.c'));
    });

    test('should store symbols correctly', () => {
      const symbols = sourceMap.getSymbols();
      assert.strictEqual(symbols.main, 0x1000);
      assert.strictEqual(symbols.sub1, 0x1100);
      assert.strictEqual(symbols.data_start, 0x2000);
    });
  });

  suite('Address Lookup', () => {
    test('should find exact address match', () => {
      const location = sourceMap.lookupAddress(0x1000);
      assert.ok(location);
      assert.strictEqual(location.path, '/test/main.c');
      assert.strictEqual(location.line, 10);
      assert.strictEqual(location.address, 0x1000);
    });

    test('should find nearest address match within range', () => {
      const location = sourceMap.lookupAddress(0x1005); // Between 0x1000 and 0x1020
      assert.ok(location);
      assert.strictEqual(location.address, 0x1000);
      assert.strictEqual(location.line, 10);
    });

    test('should not find address beyond 10 byte range', () => {
      const location = sourceMap.lookupAddress(0x1015); // 21 bytes from 0x1000, 11 bytes from 0x1020 - both out of range
      // Based on the algorithm, this should not find anything since both are > 10 bytes away
      assert.strictEqual(location, undefined);
    });

    test('should return undefined for non-existent address', () => {
      const location = sourceMap.lookupAddress(0x5000);
      assert.strictEqual(location, undefined);
    });
  });

  suite('Source Line Lookup', () => {
    test('should find exact line match', () => {
      const location = sourceMap.lookupSourceLine('/test/main.c', 10);
      assert.strictEqual(location.address, 0x1000);
      assert.strictEqual(location.line, 10);
    });

    test('should find nearest line match', () => {
      const location = sourceMap.lookupSourceLine('/test/main.c', 12); // Between lines 10 and 15
      assert.strictEqual(location.address, 0x1000);
      assert.strictEqual(location.line, 10);
    });

    test('should handle case-insensitive path matching', () => {
      const location = sourceMap.lookupSourceLine('/TEST/MAIN.C', 10);
      assert.strictEqual(location.address, 0x1000);
    });

    test('should throw for non-existent file', () => {
      assert.throws(() => {
        sourceMap.lookupSourceLine('/nonexistent/file.c', 10);
      }, /File not found in source map/);
    });

    test('should find last available line for high line numbers', () => {
      const location = sourceMap.lookupSourceLine('/test/main.c', 100);
      assert.strictEqual(location.address, 0x1100); // Last line in main.c
      assert.strictEqual(location.line, 20);
    });
  });

  suite('Segment Operations', () => {
    test('should get segment by index', () => {
      const segment = sourceMap.getSegmentInfo(0);
      assert.strictEqual(segment.name, 'CODE');
      assert.strictEqual(segment.address, 0x1000);
    });

    test('should find segment for address', () => {
      const segment = sourceMap.findSegmentForAddress(0x1500);
      assert.ok(segment);
      assert.strictEqual(segment.name, 'CODE');
      
      const dataSegment = sourceMap.findSegmentForAddress(0x2200);
      assert.ok(dataSegment);
      assert.strictEqual(dataSegment.name, 'DATA');
    });

    test('should return undefined for address outside segments', () => {
      const segment = sourceMap.findSegmentForAddress(0x5000);
      assert.strictEqual(segment, undefined);
    });
  });

  suite('Symbol Operations', () => {
    test('should calculate symbol lengths correctly', () => {
      const lengths = sourceMap.getSymbolLengths();
      assert.ok(lengths);
      
      // main to sub1: 0x1100 - 0x1000 = 0x100
      assert.strictEqual(lengths.main, 0x100);
      
      // sub1 to sub2: 0x1200 - 0x1100 = 0x100
      assert.strictEqual(lengths.sub1, 0x100);
      
      // sub2 to end of CODE segment: (0x1000 + 0x1000) - 0x1200 = 0xE00
      assert.strictEqual(lengths.sub2, 0xE00);
      
      // data_start to buffer: 0x2100 - 0x2000 = 0x100
      assert.strictEqual(lengths.data_start, 0x100);
      
      // buffer to end of DATA segment: (0x2000 + 0x800) - 0x2100 = 0x700
      assert.strictEqual(lengths.buffer, 0x700);
    });

    test('should find symbol offset correctly', () => {
      const offset = sourceMap.findSymbolOffset(0x1050);
      assert.ok(offset);
      assert.strictEqual(offset.symbol, 'main');
      assert.strictEqual(offset.offset, 0x50);
    });

    test('should find exact symbol match with zero offset', () => {
      const offset = sourceMap.findSymbolOffset(0x1100);
      assert.ok(offset);
      assert.strictEqual(offset.symbol, 'sub1');
      assert.strictEqual(offset.offset, 0);
    });

    test('should return undefined for address outside segments', () => {
      const offset = sourceMap.findSymbolOffset(0x5000);
      assert.strictEqual(offset, undefined);
    });

    test('should return correct symbol for address in different segment', () => {
      const offset = sourceMap.findSymbolOffset(0x2150);
      assert.ok(offset);
      assert.strictEqual(offset.symbol, 'buffer');
      assert.strictEqual(offset.offset, 0x50);
    });
  });

  suite('Edge Cases', () => {
    test('should handle empty symbol list', () => {
      const emptyMap = new SourceMap(testSegments, testSources, {}, testLocations);
      const lengths = emptyMap.getSymbolLengths();
      assert.deepStrictEqual(lengths, {});
      
      const offset = emptyMap.findSymbolOffset(0x1000);
      assert.strictEqual(offset, undefined);
    });

    test('should handle single symbol', () => {
      const singleSymbol = { alone: 0x1000 };
      const singleMap = new SourceMap(testSegments, testSources, singleSymbol, testLocations);
      
      const lengths = singleMap.getSymbolLengths();
      assert.ok(lengths);
      assert.strictEqual(lengths.alone, 0x1000); // To end of segment
    });

    test('should handle segments with no symbols', () => {
      const symbolsInCodeOnly = { main: 0x1000, sub1: 0x1100 };
      const map = new SourceMap(testSegments, testSources, symbolsInCodeOnly, testLocations);
      
      // Address in DATA segment with no symbols
      const offset = map.findSymbolOffset(0x2000);
      assert.strictEqual(offset, undefined);
    });
  });
});