import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { parseDwarf } from '../dwarfParser';
import * as path from 'path';

describe('dwarfParser', () => {
  it('should parse example.elf without errors', () => {
    const testFile = path.join(__dirname, 'fixtures/amigaPrograms/example.elf');
    const buffer = readFileSync(testFile);

    const result = parseDwarf(buffer);

    // Verify basic structure was parsed
    expect(result).toBeDefined();
    expect(result.compilationUnits).toBeDefined();
    expect(result.lineNumberPrograms).toBeDefined();
    expect(result.sections).toBeDefined();

    // Verify we got some data
    expect(result.compilationUnits.length).toBeGreaterThan(0);
    expect(result.lineNumberPrograms.length).toBeGreaterThan(0);

    // Verify endianness detection
    expect(result.isLittleEndian).toBe(false); // Amiga binaries are big-endian
    expect(result.is64bit).toBe(false); // Amiga 68k is 32-bit

    // Verify sections were found
    expect(result.sections.has('.debug_info')).toBe(true);
    expect(result.sections.has('.debug_abbrev')).toBe(true);
    expect(result.sections.has('.debug_line')).toBe(true);
  });

  it('should parse c_prog.elf with DWARF 5 line number programs', () => {
    const testFile = path.join(__dirname, 'fixtures/amigaPrograms/c_prog.elf');
    const buffer = readFileSync(testFile);

    const result = parseDwarf(buffer);

    // Verify basic structure was parsed
    expect(result).toBeDefined();
    expect(result.lineNumberPrograms).toBeDefined();
    expect(result.lineNumberPrograms.length).toBeGreaterThan(0);

    // Get the first line number program
    const program = result.lineNumberPrograms[0];

    // Verify it's DWARF 5
    expect(program.version).toBe(5);

    // Verify directories were parsed
    expect(program.includeDirectories).toBeDefined();
    expect(program.includeDirectories.length).toBeGreaterThan(0);

    // Verify file names were parsed and contain C source files
    expect(program.fileNames).toBeDefined();
    expect(program.fileNames.length).toBeGreaterThan(0);

    // Check that we have C source files in the list
    const cFiles = program.fileNames.filter(f => f.name.endsWith('.c'));
    expect(cFiles.length).toBeGreaterThan(0);

    // Specifically look for main.c
    const mainC = program.fileNames.find(f => f.name === 'main.c');
    expect(mainC).toBeDefined();

    // Verify that special DWARF markers are included (they'll be filtered when creating locations)
    const artificialFiles = program.fileNames.filter(f =>
      f.name === '<artificial>' ||
      f.name === '<built-in>' ||
      (f.name.startsWith('<') && f.name.endsWith('>'))
    );
    // These should exist in the raw parsed data
    expect(artificialFiles.length).toBeGreaterThan(0);
  });
});
