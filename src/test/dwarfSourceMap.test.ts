import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { parseDwarf } from '../dwarfParser';
import { sourceMapFromDwarf } from '../dwarfSourceMap';
import * as path from 'path';

describe('dwarfSourceMap', () => {
  it('should correctly resolve directory paths for DWARF 5 files', () => {
    const testFile = path.join(__dirname, 'fixtures/amigaPrograms/c_prog.elf');
    const buffer = readFileSync(testFile);
    const dwarfData = parseDwarf(buffer);

    // Create source map with empty offsets and base directory
    const offsets = new Array(dwarfData.sections.size).fill(0);
    const baseDir = '';

    const sourceMap = sourceMapFromDwarf(dwarfData, offsets, baseDir);

    // Get all source files
    const sources = sourceMap.getSourceFiles();

    // Verify we have some sources
    expect(sources.length).toBeGreaterThan(0);

    // Verify main.c uses the correct directory (not support/)
    const mainCPaths = sources.filter(s => s.includes('main.c'));
    expect(mainCPaths.length).toBeGreaterThan(0);

    // Should have the correct path: /amiga-c-1/main.c (not /amiga-c-1/support/main.c)
    const correctMainPath = mainCPaths.find(s =>
      s.includes('/amiga-c-1/main.c') && !s.includes('/support/main.c')
    );
    expect(correctMainPath).toBeDefined();
    expect(correctMainPath).toContain('/amiga-c-1/main.c');

    // Should NOT have incorrect path with /support
    const incorrectMainPath = mainCPaths.find(s =>
      s.includes('/amiga-c-1/support/main.c')
    );
    expect(incorrectMainPath).toBeUndefined();

    // Verify <artificial> and <built-in> are NOT in sources
    const artificialFiles = sources.filter(s =>
      s.includes('<artificial>') || s.includes('<built-in>')
    );
    expect(artificialFiles.length).toBe(0);

    // Verify assembly file (DWARF 2) uses correct directory
    const asmFile = sources.find(s => s.includes('gcc8_a_support.s'));
    if (asmFile) {
      // Should be in the support directory
      expect(asmFile).toContain('/support/gcc8_a_support.s');
      // Should NOT be in the root project directory
      expect(asmFile).not.toMatch(/amiga-c-1\/gcc8_a_support\.s$/);
    }
  });
});
