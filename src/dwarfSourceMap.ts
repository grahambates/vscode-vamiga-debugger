import { join, isAbsolute } from "path";
import {
  DWARFData,
  LineNumberState,
  LineNumberInstruction,
  LineNumberProgram,
} from "./dwarfParser";
import { SourceMap, Location, Segment } from "./sourceMap";
import { MemoryType } from "./amigaHunkParser";

/**
 * Creates a source map from DWARF debug information.
 *
 * Processes DWARF debug data to create a mapping between memory addresses
 * and source file locations. Handles line number tables, compilation units,
 * and symbol information from DWARF debugging format.
 *
 * @param dwarfData Parsed DWARF debug information
 * @param offsets Memory offset addresses for loaded sections
 * @param baseDir Base directory for resolving relative source paths
 * @returns SourceMap instance for address-to-source resolution
 */
export function sourceMapFromDwarf(
  dwarfData: DWARFData,
  offsets: number[],
  baseDir: string,
): SourceMap {
  const sources = new Set<string>();
  const symbols: Record<string, number> = {};
  const locations: Location[] = [];
  const segments: Segment[] = [];

  // Section offsets matching original, unfiltered indexes
  const sectionOffsets = [];
  let i = 0;

  // Build sections from ELF section headers
  for (const [originalName, header] of dwarfData.sections) {
    // Extract memory type and clean section name
    const memTypeMap = {
      MEMF_CHIP: MemoryType.CHIP,
      MEMF_FAST: MemoryType.FAST,
      MEMF_ANY: MemoryType.ANY,
    };
    let memType: MemoryType = MemoryType.ANY;
    let name = originalName;

    for (const suffix in memTypeMap) {
      if (name.endsWith("." + suffix)) {
        memType = memTypeMap[suffix as keyof typeof memTypeMap];
        name = name.replace("." + suffix, "");
        break;
      }
    }

    // Filter sections: must have size > 0 AND either addr > 0 OR be a special section
    if (
      header.size > 0 &&
      (header.addr > 0 ||
        name === ".text" ||
        name === ".data" ||
        name === ".bss" ||
        name === ".rodata")
    ) {
      segments.push({
        name: originalName,
        address: offsets[i],
        size: header.size,
        memType,
      });
      sectionOffsets.push(offsets[i++] - header.addr);
    } else {
      sectionOffsets.push(0); // zero for filtered sections
    }
  }

  // Process each line number program to build locations
  for (const program of dwarfData.lineNumberPrograms) {
    const state: LineNumberState = {
      address: 0,
      file: 1,
      line: 1,
      column: 0,
      isStmt: program.defaultIsStmt,
      basicBlock: false,
      endSequence: false,
    };

    for (const instruction of program.instructions) {
      executeLineNumberInstruction(instruction, state, program);

      // Create location entries for statements
      const shouldEmitLocation =
        (instruction.type === "standard" && instruction.name === "copy") ||
        instruction.type === "special";

      if (
        shouldEmitLocation &&
        state.file >= 1 &&
        state.file <= program.fileNames.length
      ) {
        const fileEntry = program.fileNames[state.file - 1];
        if (fileEntry) {
          // Skip special DWARF markers that don't correspond to real source files
          // These are compiler-generated code locations that should show disassembly
          if (
            fileEntry.name === "<artificial>" ||
            fileEntry.name === "<built-in>" ||
            fileEntry.name.startsWith("<") && fileEntry.name.endsWith(">")
          ) {
            continue;
          }

          // Build full path
          let path = fileEntry.name;

          // Handle directory indexing - DWARF 5 uses 0-based, DWARF 2-4 uses 1-based
          let dirIndex = -1;

          if (program.version >= 5) {
            // DWARF 5: directory indices are 0-based, directly index into the array
            if (fileEntry.directoryIndex >= 0 && fileEntry.directoryIndex < program.includeDirectories.length) {
              dirIndex = fileEntry.directoryIndex;
            }
          } else {
            // DWARF 2-4: directory index 0 means current directory (no prefix)
            // Directory index 1+ means index into the directory table (subtract 1 for array index)
            if (fileEntry.directoryIndex > 0 && fileEntry.directoryIndex <= program.includeDirectories.length) {
              dirIndex = fileEntry.directoryIndex - 1;
            }
          }

          if (dirIndex >= 0 && dirIndex < program.includeDirectories.length) {
            const directory = program.includeDirectories[dirIndex];
            path = join(directory, fileEntry.name);
          }
          // Only prepend baseDir if path is not already absolute
          if (!isAbsolute(path)) {
            path = join(baseDir, path);
          }

          // Find which section this address belongs to
          let sectionIndex = 0;
          let sectionOffset = state.address;

          for (let i = 0; i < segments.length; i++) {
            const section = segments[i];
            if (
              state.address >= section.address &&
              state.address < section.address + section.size
            ) {
              sectionIndex = i;
              sectionOffset = state.address - section.address;
              break;
            }
          }

          const location: Location = {
            path,
            line: state.line,
            address: state.address + offsets[sectionIndex],
            segmentIndex: sectionIndex, // segmentIndex refers to section index
            segmentOffset: sectionOffset, // segmentOffset is offset within section
          };
          locations.push(location);

          // Add to sources set
          sources.add(path);
        }
      }

      // Reset state on end sequence
      if (state.endSequence) {
        state.address = 0;
        state.file = 1;
        state.line = 1;
        state.column = 0;
        state.isStmt = program.defaultIsStmt;
        state.basicBlock = false;
        state.endSequence = false;
      }
    }
  }

  // Extract symbols from ELF symbol table
  for (const elfSymbol of dwarfData.elfSymbols) {
    if (sectionOffsets[elfSymbol.sectionIndex]) {
      symbols[elfSymbol.name] =
        elfSymbol.value + sectionOffsets[elfSymbol.sectionIndex];
    }
  }

  return new SourceMap(segments, sources, symbols, locations);
}

function executeLineNumberInstruction(
  instruction: LineNumberInstruction,
  state: LineNumberState,
  program: LineNumberProgram,
): void {
  switch (instruction.type) {
    case "extended":
      if (
        instruction.name === "set_address" &&
        instruction.address !== undefined
      ) {
        state.address = instruction.address;
      } else if (instruction.name === "end_sequence") {
        state.endSequence = true;
      }
      break;

    case "standard":
      switch (instruction.name) {
        case "advance_pc":
          if (instruction.advance !== undefined) {
            state.address +=
              instruction.advance * program.minimumInstructionLength;
          }
          break;
        case "advance_line":
          if (instruction.advance !== undefined) {
            state.line += instruction.advance;
          }
          break;
        case "set_file":
          if (instruction.file !== undefined) {
            state.file = instruction.file;
          }
          break;
        case "set_column":
          if (instruction.column !== undefined) {
            state.column = instruction.column;
          }
          break;
        case "negate_stmt":
          state.isStmt = !state.isStmt;
          break;
        case "set_basic_block":
          state.basicBlock = true;
          break;
        case "const_add_pc": {
          const adjustedOpcode = 255 - program.opcodeBase;
          state.address +=
            Math.floor(adjustedOpcode / program.lineRange) *
            program.minimumInstructionLength;
          break;
        }
        case "fixed_advance_pc":
          if (instruction.advance !== undefined) {
            state.address += instruction.advance;
          }
          break;
      }
      break;

    case "special":
      if (instruction.addressAdvance !== undefined) {
        state.address +=
          instruction.addressAdvance * program.minimumInstructionLength;
      }
      if (instruction.lineAdvance !== undefined) {
        state.line += instruction.lineAdvance;
      }
      break;
  }
}
