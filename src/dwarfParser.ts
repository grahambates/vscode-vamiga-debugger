/* eslint-disable @typescript-eslint/no-explicit-any */

import { demangle } from "./demangle";

// ELF and DWARF type definitions
export enum ELFSectionFlags {
  WRITE = 0x1,
  ALLOC = 0x2,
  EXECINSTR = 0x4,
  MERGE = 0x10,
  STRINGS = 0x20,
  INFO_LINK = 0x40,
  LINK_ORDER = 0x80,
  OS_NONCONFORMING = 0x100,
  GROUP = 0x200,
  TLS = 0x400,
  COMPRESSED = 0x800,
}

export interface ELFSectionHeader {
  name: string;
  type: number;
  flags: ELFSectionFlags;
  addr: number;
  offset: number;
  size: number;
}

export interface CompilationUnit {
  length: number;
  version: number;
  abbrevOffset: number;
  addressSize: number;
  offset: number;
  dies: DebugInfoEntry[];
  dieMap?: Map<number, DebugInfoEntry>;
}

export interface DebugInfoEntry {
  abbrevCode: number;
  tag: number | undefined;
  attributes: DWARFAttribute[];
  size: number;
  children: DebugInfoEntry[];
  offset: number;
}

export interface DWARFAttribute {
  name: number;
  form: number;
  value: any;
}

export interface AbbreviationEntry {
  code: number;
  tag: number;
  hasChildren: boolean;
  attributes: Array<{ name: number; form: number; implicitConst?: number }>;
}

export interface FileEntry {
  name: string;
  directoryIndex: number;
  modificationTime: number;
  size: number;
}

export interface LineNumberProgram {
  sectionOffset: number;
  totalLength: number;
  version: number;
  headerLength: number;
  minimumInstructionLength: number;
  defaultIsStmt: boolean;
  lineBase: number;
  lineRange: number;
  opcodeBase: number;
  standardOpcodeLengths: number[];
  includeDirectories: string[];
  fileNames: FileEntry[];
  instructions: LineNumberInstruction[];
}

export interface LineNumberInstruction {
  opcode: number;
  size: number;
  type?: "extended" | "standard" | "special";
  extended?: boolean;
  length?: number;
  extOpcode?: number;
  address?: number;
  fileName?: string;
  name?: string;
  advance?: number;
  file?: number;
  column?: number;
  addressAdvance?: number;
  lineAdvance?: number;
}

export interface LineNumberState {
  address: number;
  file: number;
  line: number;
  column: number;
  isStmt: boolean;
  basicBlock: boolean;
  endSequence: boolean;
}

export interface LEB128Result {
  value: number;
  size: number;
}

export interface StringResult {
  value: string;
  size: number;
}

export interface ELFSymbol {
  name: string;
  value: number;
  size: number;
  type: number;
  bind: number;
  visibility: number;
  sectionIndex: number;
}

export interface SourceMapEntry {
  address: number;
  binaryOffset: number;
  sourceFile: string;
  lineNumber: number;
  column: number;
  isStatement: boolean;
}

export interface CfaInstruction {
  op: number;
  reg?: number;
  reg2?: number;
  offset?: number;
  factoredOffset?: number;
  delta?: number;
  address?: number;
}

export interface DebugFrameCIE {
  offset: number;
  version: number;
  augmentation: string;
  codeAlignFactor: number;
  dataAlignFactor: number;
  returnAddressColumn: number;
  addressSize: number;
  initialInstructions: CfaInstruction[];
}

export interface DebugFrameFDE {
  offset: number;
  cieOffset: number;
  cie: DebugFrameCIE;
  pcStart: number;
  pcRange: number;
  instructions: CfaInstruction[];
}

export interface DebugFrame {
  cies: Map<number, DebugFrameCIE>;
  fdes: DebugFrameFDE[];
}

export interface DWARFData {
  sections: Map<string, ELFSectionHeader>;
  compilationUnits: CompilationUnit[];
  lineNumberPrograms: LineNumberProgram[];
  debugStrings: Uint8Array | undefined;
  debugRanges: Uint8Array | undefined;
  debugFrame: DebugFrame | undefined;
  abbreviationTables: Map<number, AbbreviationEntry[]>;
  elfSymbols: ELFSymbol[];
  is64bit: boolean;
  isLittleEndian: boolean;
}

// DWARF constants
export const DW_TAG = {
  array_type: 0x01,
  class_type: 0x02,
  entry_point: 0x03,
  enumeration_type: 0x04,
  formal_parameter: 0x05,
  imported_declaration: 0x08,
  label: 0x0a,
  lexical_block: 0x0b,
  member: 0x0d,
  pointer_type: 0x0f,
  reference_type: 0x10,
  compile_unit: 0x11,
  string_type: 0x12,
  structure_type: 0x13,
  subroutine_type: 0x15,
  typedef: 0x16,
  union_type: 0x17,
  unspecified_parameters: 0x18,
  variant: 0x19,
  common_block: 0x1a,
  common_inclusion: 0x1b,
  inheritance: 0x1c,
  inlined_subroutine: 0x1d,
  module: 0x1e,
  ptr_to_member_type: 0x1f,
  set_type: 0x20,
  subrange_type: 0x21,
  with_stmt: 0x22,
  access_declaration: 0x23,
  base_type: 0x24,
  catch_block: 0x25,
  const_type: 0x26,
  constant: 0x27,
  enumerator: 0x28,
  file_type: 0x29,
  friend: 0x2a,
  namelist: 0x2b,
  namelist_item: 0x2c,
  namelist_items: 0x2c,
  packed_type: 0x2d,
  subprogram: 0x2e,
  template_type_parameter: 0x2f,
  template_type_param: 0x2f,
  template_value_parameter: 0x30,
  template_value_param: 0x30,
  thrown_type: 0x31,
  try_block: 0x32,
  variant_part: 0x33,
  variable: 0x34,
  volatile_type: 0x35,
  dwarf_procedure: 0x36,
  restrict_type: 0x37,
  interface_type: 0x38,
  namespace: 0x39,
  imported_module: 0x3a,
  unspecified_type: 0x3b,
  partial_unit: 0x3c,
  imported_unit: 0x3d,
  mutable_type: 0x3e,
  condition: 0x3f,
  shared_type: 0x40,
  type_unit: 0x41,
  rvalue_reference_type: 0x42,
  template_alias: 0x43,
  coarray_type: 0x44,
  generic_subrange: 0x45,
  dynamic_type: 0x46,
  atomic_type: 0x47,
  call_site: 0x48,
  call_site_parameter: 0x49,
  skeleton_unit: 0x4a,
  immutable_type: 0x4b,
  TI_far_type: 0x4080,
  lo_user: 0x4080,
  MIPS_loop: 0x4081,
  TI_near_type: 0x4081,
  TI_assign_register: 0x4082,
  TI_ioport_type: 0x4083,
  TI_restrict_type: 0x4084,
  TI_onchip_type: 0x4085,
  HP_array_descriptor: 0x4090,
  format_label: 0x4101,
  function_template: 0x4102,
  class_template: 0x4103,
  GNU_BINCL: 0x4104,
  GNU_EINCL: 0x4105,
  GNU_template_template_parameter: 0x4106,
  GNU_template_template_param: 0x4106,
  GNU_template_parameter_pack: 0x4107,
  GNU_formal_parameter_pack: 0x4108,
  GNU_call_site: 0x4109,
  GNU_call_site_parameter: 0x410a,
  SUN_function_template: 0x4201,
  SUN_class_template: 0x4202,
  SUN_struct_template: 0x4203,
  SUN_union_template: 0x4204,
  SUN_indirect_inheritance: 0x4205,
  SUN_codeflags: 0x4206,
  SUN_memop_info: 0x4207,
  SUN_omp_child_func: 0x4208,
  SUN_rtti_descriptor: 0x4209,
  SUN_dtor_info: 0x420a,
  SUN_dtor: 0x420b,
  SUN_f90_interface: 0x420c,
  SUN_fortran_vax_structure: 0x420d,
  SUN_hi: 0x42ff,
  ALTIUM_circ_type: 0x5101,
  ALTIUM_mwa_circ_type: 0x5102,
  ALTIUM_rev_carry_type: 0x5103,
  ALTIUM_rom: 0x5111,
  LLVM_annotation: 0x6000,
  ghs_namespace: 0x8004,
  ghs_using_namespace: 0x8005,
  ghs_using_declaration: 0x8006,
  ghs_template_templ_param: 0x8007,
  upc_shared_type: 0x8765,
  upc_strict_type: 0x8766,
  upc_relaxed_type: 0x8767,
  PGI_kanji_type: 0xa000,
  PGI_interface_block: 0xa020,
  BORLAND_property: 0xb000,
  BORLAND_Delphi_string: 0xb001,
  BORLAND_Delphi_dynamic_array: 0xb002,
  BORLAND_Delphi_set: 0xb003,
  BORLAND_Delphi_variant: 0xb004,
  hi_user: 0xffff,
} as const;

export const DW_AT = {
  sibling: 0x01,
  location: 0x02,
  name: 0x03,
  ordering: 0x09,
  subscr_data: 0x0a,
  byte_size: 0x0b,
  bit_offset: 0x0c,
  bit_size: 0x0d,
  element_list: 0x0f,
  stmt_list: 0x10,
  low_pc: 0x11,
  high_pc: 0x12,
  language: 0x13,
  member: 0x14,
  discr: 0x15,
  discr_value: 0x16,
  visibility: 0x17,
  import: 0x18,
  string_length: 0x19,
  common_reference: 0x1a,
  comp_dir: 0x1b,
  const_value: 0x1c,
  containing_type: 0x1d,
  default_value: 0x1e,
  inline: 0x20,
  is_optional: 0x21,
  lower_bound: 0x22,
  producer: 0x25,
  prototyped: 0x27,
  return_addr: 0x2a,
  start_scope: 0x2c,
  bit_stride: 0x2e,
  stride_size: 0x2e,
  upper_bound: 0x2f,
  abstract_origin: 0x31,
  accessibility: 0x32,
  address_class: 0x33,
  artificial: 0x34,
  base_types: 0x35,
  calling_convention: 0x36,
  count: 0x37,
  data_member_location: 0x38,
  decl_column: 0x39,
  decl_file: 0x3a,
  decl_line: 0x3b,
  declaration: 0x3c,
  discr_list: 0x3d,
  encoding: 0x3e,
  external: 0x3f,
  frame_base: 0x40,
  friend: 0x41,
  identifier_case: 0x42,
  macro_info: 0x43,
  namelist_item: 0x44,
  priority: 0x45,
  segment: 0x46,
  specification: 0x47,
  static_link: 0x48,
  type: 0x49,
  use_location: 0x4a,
  variable_parameter: 0x4b,
  virtuality: 0x4c,
  vtable_elem_location: 0x4d,
  allocated: 0x4e,
  associated: 0x4f,
  data_location: 0x50,
  byte_stride: 0x51,
  stride: 0x51,
  entry_pc: 0x52,
  use_UTF8: 0x53,
  extension: 0x54,
  ranges: 0x55,
  trampoline: 0x56,
  call_column: 0x57,
  call_file: 0x58,
  call_line: 0x59,
  description: 0x5a,
  binary_scale: 0x5b,
  decimal_scale: 0x5c,
  small: 0x5d,
  decimal_sign: 0x5e,
  digit_count: 0x5f,
  picture_string: 0x60,
  mutable: 0x61,
  threads_scaled: 0x62,
  explicit: 0x63,
  call_all_tail_calls: 0x7c,
} as const;

export const DW_ATE = {
  address: 0x01,
  boolean: 0x02,
  complex_float: 0x03,
  float: 0x04,
  signed: 0x05,
  signed_char: 0x06,
  unsigned: 0x07,
  unsigned_char: 0x08,
  imaginary_float: 0x09,
  packed_decimal: 0x0a,
  numeric_string: 0x0b,
  edited: 0x0c,
  signed_fixed: 0x0d,
  unsigned_fixed: 0x0e,
  decimal_float: 0x0f,
  UTF: 0x10,
  UCS: 0x11,
  ASCII: 0x12,
  lo_user: 0x80,
  hi_user: 0xff,
} as const;

export const DW_FORM = {
  addr: 0x01,
  block2: 0x03,
  block4: 0x04,
  data2: 0x05,
  data4: 0x06,
  data8: 0x07,
  string: 0x08,
  block: 0x09,
  block1: 0x0a,
  data1: 0x0b,
  flag: 0x0c,
  sdata: 0x0d,
  strp: 0x0e,
  udata: 0x0f,
  ref_addr: 0x10,
  ref1: 0x11,
  ref2: 0x12,
  ref4: 0x13,
  ref8: 0x14,
  ref_udata: 0x15,
  indirect: 0x16,
  sec_offset: 0x17,
  exprloc: 0x18,
  flag_present: 0x19,
  strx: 0x1a,
  addrx: 0x1b,
  ref_sup4: 0x1c,
  strp_sup: 0x1d,
  data16: 0x1e,
  line_strp: 0x1f,
  ref_sig8: 0x20,
  implicit_const: 0x21,
  loclistx: 0x22,
  rnglistx: 0x23,
  ref_sup8: 0x24,
  strx1: 0x25,
  strx2: 0x26,
  strx3: 0x27,
  strx4: 0x28,
  addrx1: 0x29,
  addrx2: 0x2a,
  addrx3: 0x2b,
  addrx4: 0x2c,
  GNU_addr_index: 0x1f01,
  GNU_str_index: 0x1f02,
  GNU_ref_alt: 0x1f20,
  GNU_strp_alt: 0x1f21,
  LLVM_addrx_offset: 0x2001,
} as const;

export const DW_OP = {
  addr: 0x03,
  deref: 0x06,
  const1u: 0x08,
  const1s: 0x09,
  const2u: 0x0a,
  const2s: 0x0b,
  const4u: 0x0c,
  const4s: 0x0d,
  const8u: 0x0e,
  const8s: 0x0f,
  dup: 0x10,
  drop: 0x11,
  over: 0x12,
  pick: 0x13,
  swap: 0x14,
  rot: 0x15,
  xderef: 0x16,
  breg0: 0x70,
  breg31: 0x8f,
  fbreg: 0x91,
  call_frame_cfa: 0x9c,
} as const;

export const DW_LNS = {
  copy:             1,
  advance_pc:       2,
  advance_line:     3,
  set_file:         4,
  set_column:       5,
  negate_stmt:      6,
  set_basic_block:  7,
  const_add_pc:     8,
  fixed_advance_pc: 9,
} as const;

export const DW_LNE = {
  end_sequence: 1,
  set_address:  2,
  define_file:  3,
} as const;

export const DW_CFA = {
  advance_loc:        0x40,  // high 2 bits = 01; low 6 bits carry the delta
  offset:             0x80,  // high 2 bits = 10; low 6 bits carry the register
  restore:            0xC0,  // high 2 bits = 11; low 6 bits carry the register
  nop:                0x00,
  set_loc:            0x01,
  advance_loc1:       0x02,
  advance_loc2:       0x03,
  advance_loc4:       0x04,
  offset_extended:    0x05,
  restore_extended:   0x06,
  undefined:          0x07,
  same_value:         0x08,
  register:           0x09,
  remember_state:     0x0a,
  restore_state:      0x0b,
  def_cfa:            0x0c,
  def_cfa_register:   0x0d,
  def_cfa_offset:     0x0e,
  def_cfa_expression: 0x0f,
  expression:         0x10,
  offset_extended_sf: 0x11,
  def_cfa_sf:         0x12,
  def_cfa_offset_sf:  0x13,
} as const;

/**
 * Parses DWARF debug information from an ELF file buffer.
 *
 * Extracts debugging information including source file mappings, line number
 * data, and compilation unit information from DWARF-formatted debug sections
 * within an ELF binary.
 *
 * @param elfBuffer Buffer containing ELF file data with DWARF debug info
 * @returns Parsed DWARF data structure containing debug information
 * @throws Error if the buffer is not a valid ELF file or lacks DWARF data
 */
export function parseDwarf(elfBuffer: Buffer): DWARFData {
  const view = new DataView(
    elfBuffer.buffer,
    elfBuffer.byteOffset,
    elfBuffer.byteLength
  );
  
  // Check ELF magic
  if (
    elfBuffer[0] !== 0x7f ||
    elfBuffer[1] !== 0x45 ||
    elfBuffer[2] !== 0x4c ||
    elfBuffer[3] !== 0x46
  ) {
    throw new Error("DWARF parsing error: Not a valid ELF file");
  }

  const is64bit = elfBuffer[4] === 2;
  const isLittleEndian = elfBuffer[5] === 1;

  // Helper functions
  function readUInt8(offset: number): number {
    const value = elfBuffer[offset];
    if (value === undefined) {
      throw new Error(`DWARF parsing error: Invalid read at offset ${offset}`);
    }
    return value;
  }

  function readInt8(offset: number): number {
    const value = elfBuffer[offset];
    if (value === undefined) {
      throw new Error(`DWARF parsing error: Invalid read at offset ${offset}`);
    }
    return value > 127 ? value - 256 : value;
  }

  function readUInt16(offset: number): number {
    return view.getUint16(offset, isLittleEndian);
  }

  function readUInt32(offset: number): number {
    return view.getUint32(offset, isLittleEndian);
  }

  function readUInt64(offset: number): number {
    const low = view.getUint32(offset, isLittleEndian);
    const high = view.getUint32(offset + 4, isLittleEndian);
    return isLittleEndian ? low + high * 0x100000000 : high + low * 0x100000000;
  }

  function readULEB128(offset: number): LEB128Result {
    let result = 0;
    let shift = 0;
    let size = 0;

    while (true) {
      if (offset + size >= elfBuffer.length) {
        throw new Error(`Invalid ULEB128 read at offset ${offset + size} (buffer size: ${elfBuffer.length})`);
      }
      const byte = elfBuffer[offset + size];
      if (byte === undefined) {
        throw new Error(`Invalid ULEB128 read at offset ${offset + size}`);
      }
      size++;

      result |= (byte & 0x7f) << shift;

      if ((byte & 0x80) === 0) break;
      shift += 7;

      // Prevent infinite loops on malformed data
      if (size > 10) {
        throw new Error(`ULEB128 too long at offset ${offset} (size: ${size})`);
      }
    }

    return { value: result, size };
  }

  function readSLEB128(offset: number): LEB128Result {
    let result = 0;
    let shift = 0;
    let size = 0;
    let byte: number | undefined;

    do {
      if (offset + size >= elfBuffer.length) {
        throw new Error(`Invalid SLEB128 read at offset ${offset + size} (buffer size: ${elfBuffer.length})`);
      }
      byte = elfBuffer[offset + size];
      if (byte === undefined) {
        throw new Error(`Invalid SLEB128 read at offset ${offset + size}`);
      }
      size++;

      result |= (byte & 0x7f) << shift;
      shift += 7;

      // Prevent infinite loops on malformed data
      if (size > 10) {
        throw new Error(`SLEB128 too long at offset ${offset} (size: ${size})`);
      }
    } while (byte & 0x80);

    if (shift < 32 && byte & 0x40) {
      result |= -(1 << shift);
    }

    return { value: result, size };
  }

  function readString(offset: number): StringResult {
    let size = 0;
    let value = "";

    while (offset + size < elfBuffer.length) {
      const byte = elfBuffer[offset + size];
      if (byte === undefined || byte === 0) break;
      value += String.fromCharCode(byte);
      size++;
    }

    return { value, size: size + 1 };
  }

  function readStringFromTable(offset: number, stringTable: Uint8Array): string {
    let value = "";
    let i = offset;

    while (i < stringTable.length) {
      const byte = stringTable[i];
      if (byte === undefined || byte === 0) break;
      value += String.fromCharCode(byte);
      i++;
    }

    return value;
  }

  // Parse ELF sections
  const headerSize = is64bit ? 64 : 52;
  const shoff = is64bit ? readUInt64(40) : readUInt32(32);
  const shentsize = readUInt16(headerSize - 6);
  const shnum = readUInt16(headerSize - 4);
  const shstrndx = readUInt16(headerSize - 2);

  function parseSectionHeader(offset: number): ELFSectionHeader {
    const nameOffset = readUInt32(offset);
    const type = readUInt32(offset + 4);
    const flags = is64bit ? readUInt64(offset + 8) : readUInt32(offset + 8);
    const addr = is64bit ? readUInt64(offset + 16) : readUInt32(offset + 12);
    const sectionOffset = is64bit
      ? readUInt64(offset + 24)
      : readUInt32(offset + 16);
    const size = is64bit ? readUInt64(offset + 32) : readUInt32(offset + 20);

    return {
      name: nameOffset.toString(),
      type,
      flags,
      addr,
      offset: sectionOffset,
      size,
    };
  }

  const sections = new Map<string, ELFSectionHeader>();

  // Parse section headers
  const strTabOffset = shoff + shstrndx * shentsize;
  const strTabHeader = parseSectionHeader(strTabOffset);
  const stringTable = new Uint8Array(
    elfBuffer.buffer,
    elfBuffer.byteOffset + strTabHeader.offset,
    strTabHeader.size
  );

  for (let i = 0; i < shnum; i++) {
    const headerOffset = shoff + i * shentsize;
    const header = parseSectionHeader(headerOffset);

    const nameOffset = header.name as unknown as number;
    let name = "";
    for (let j = nameOffset; j < stringTable.length; j++) {
      const byte = stringTable[j];
      if (byte === undefined || byte === 0) break;
      name += String.fromCharCode(byte);
    }

    header.name = name;
    sections.set(name, header);
  }

  // Parse DWARF sections
  const compilationUnits: CompilationUnit[] = [];
  const lineNumberPrograms: LineNumberProgram[] = [];
  let debugStrings: Uint8Array | undefined;
  let debugRanges: Uint8Array | undefined;
  let debugFrame: DebugFrame | undefined;
  const abbreviationTables = new Map<number, AbbreviationEntry[]>();
  const elfSymbols: ELFSymbol[] = [];

  function parseAbbreviationEntry(offset: number): {
    entry: AbbreviationEntry;
    size: number;
  } {
    let currentOffset = offset;

    const code = readULEB128(currentOffset);
    currentOffset += code.size;

    if (code.value === 0) {
      return {
        entry: { code: 0, tag: 0, hasChildren: false, attributes: [] },
        size: code.size,
      };
    }

    const tag = readULEB128(currentOffset);
    currentOffset += tag.size;

    const hasChildren = readUInt8(currentOffset) === 1;
    currentOffset += 1;

    const attributes: Array<{ name: number; form: number; implicitConst?: number }> = [];

    while (true) {
      const name = readULEB128(currentOffset);
      currentOffset += name.size;

      const form = readULEB128(currentOffset);
      currentOffset += form.size;

      if (name.value === 0 && form.value === 0) break;

      // Handle DW_FORM_implicit_const: its value is encoded in the
      // abbreviation table as a SLEB128 following the form.
      if (form.value === DW_FORM.implicit_const) {
        const implicit = readSLEB128(currentOffset);
        currentOffset += implicit.size;
        attributes.push({ name: name.value, form: form.value, implicitConst: implicit.value });
      } else {
        attributes.push({ name: name.value, form: form.value });
      }
    }

    return {
      entry: {
        code: code.value,
        tag: tag.value,
        hasChildren,
        attributes,
      },
      size: currentOffset - offset,
    };
  }

  function parseAbbreviationTable(offset: number): AbbreviationEntry[] {
    const entries: AbbreviationEntry[] = [];
    let currentOffset = offset;

    while (true) {
      const result = parseAbbreviationEntry(currentOffset);
      if (result.entry.code === 0) break;

      entries.push(result.entry);
      currentOffset += result.size;
    }

    return entries;
  }

  function parseAttributeValue(
    offset: number,
    form: number,
    addressSize: number,
  ): { value: any; size: number } {
    switch (form) {
      case DW_FORM.addr:
        return {
          value: addressSize === 8 ? readUInt64(offset) : readUInt32(offset),
          size: addressSize,
        };
      case DW_FORM.ref_addr:
        // A reference encoded as an address (DW_FORM_ref_addr)
        return {
          value: addressSize === 8 ? readUInt64(offset) : readUInt32(offset),
          size: addressSize,
        };
      case DW_FORM.data1:
        return { value: readUInt8(offset), size: 1 };
      case DW_FORM.data2:
        return { value: readUInt16(offset), size: 2 };
      case DW_FORM.data4:
        return { value: readUInt32(offset), size: 4 };
      case DW_FORM.data8:
        return { value: readUInt64(offset), size: 8 };
      case DW_FORM.string: {
        const str = readString(offset);
        return { value: str.value, size: str.size };
      }
      case DW_FORM.strp:
        return { value: readUInt32(offset), size: 4 }; // Offset into .debug_str
      case DW_FORM.flag:
        return { value: readUInt8(offset) !== 0, size: 1 };
      case DW_FORM.flag_present:
        // DW_FORM_flag_present carries no data; its presence implies true
        return { value: true, size: 0 };
      case DW_FORM.udata: {
        const uleb = readULEB128(offset);
        return { value: uleb.value, size: uleb.size };
      }
      case DW_FORM.sdata: {
        const sleb = readSLEB128(offset);
        return { value: sleb.value, size: sleb.size };
      }
      case DW_FORM.ref4:
        return { value: readUInt32(offset), size: 4 };
      case DW_FORM.ref_udata: {
        const uleb = readULEB128(offset);
        return { value: uleb.value, size: uleb.size };
      }
      case DW_FORM.block1: {
        const length = readUInt8(offset);
        return {
          value: new Uint8Array(elfBuffer.buffer, elfBuffer.byteOffset + offset + 1, length),
          size: 1 + length,
        };
      }
      case DW_FORM.block: {
        const length = readULEB128(offset);
        return {
          value: new Uint8Array(
            elfBuffer.buffer,
            elfBuffer.byteOffset + offset + length.size,
            length.value,
          ),
          size: length.size + length.value,
        };
      }
      case DW_FORM.sec_offset:
        // section offset (typically 4 bytes)
        return { value: readUInt32(offset), size: 4 };
      case DW_FORM.exprloc: {
        const length = readULEB128(offset);
        return {
          value: new Uint8Array(
            elfBuffer.buffer,
            elfBuffer.byteOffset + offset + length.size,
            length.value,
          ),
          size: length.size + length.value,
        };
      }
      default:
        throw new Error("DWARF parsing error: Unknown DW_FORM 0x" + form.toString(16));
    }
  }

  function parseLocationExpressionAt(baseOffset: number, length: number, addressSize: number) {
    const ops: Array<any> = [];
    let i = 0;
    while (i < length) {
      const op = view.getUint8(baseOffset + i);
      i++;
      // DW_OP_breg0..DW_OP_breg31 => 0x70..0x8f
      if (op === DW_OP.addr) {
        const addr = addressSize === 8 ? readUInt64(baseOffset + i) : readUInt32(baseOffset + i);
        i += addressSize;
        // Keep numeric address values in the parser; formatting to hex is
        // handled by the dump/display functions only.
        const rawAddr = addressSize === 8 ? addr : (addr >>> 0);
        ops.push({ op: 'DW_OP_addr', value: rawAddr });
      } else if (op >= DW_OP.breg0 && op <= DW_OP.breg31) {
        const reg = op - DW_OP.breg0;
        const sleb = readSLEB128(baseOffset + i);
        i += sleb.size;
        ops.push({ op: `DW_OP_breg${reg}`, reg, value: sleb.value });
      } else if (op === DW_OP.fbreg) {
        const sleb = readSLEB128(baseOffset + i);
        i += sleb.size;
        ops.push({ op: 'DW_OP_fbreg', value: sleb.value });
      } else if (op === DW_OP.call_frame_cfa) {
        ops.push({ op: 'DW_OP_call_frame_cfa' });
      } else {
        // Unknown or unimplemented op: try to decode common immediate sizes
        // Handle simple consts: DW_OP_const1u (0x08), const1s (0x09), const2u (0x0a), const2s (0x0b), const4u (0x0c), const4s (0x0d), const8u (0x0e), const8s (0x0f)
        switch (op) {
          case DW_OP.const1u: // const1u
            ops.push({ op: 'DW_OP_const1u', value: view.getUint8(baseOffset + i) });
            i += 1;
            break;
          case DW_OP.const1s: // const1s
            ops.push({ op: 'DW_OP_const1s', value: view.getInt8(baseOffset + i) });
            i += 1;
            break;
          case DW_OP.const2u: // const2u
            ops.push({ op: 'DW_OP_const2u', value: view.getUint16(baseOffset + i, isLittleEndian) });
            i += 2;
            break;
          case DW_OP.const2s: // const2s
            ops.push({ op: 'DW_OP_const2s', value: view.getInt16(baseOffset + i, isLittleEndian) });
            i += 2;
            break;
          case DW_OP.const4u: // const4u
            ops.push({ op: 'DW_OP_const4u', value: view.getUint32(baseOffset + i, isLittleEndian) >>> 0 });
            i += 4;
            break;
          case DW_OP.dup: // dup, no operand
          case DW_OP.drop:
          case DW_OP.over:
          case DW_OP.pick:
          case DW_OP.swap:
          case DW_OP.rot:
          case DW_OP.xderef:
            ops.push({ op: `DW_OP_0x${op.toString(16)}` });
            break;
          default:
            ops.push({ op: `DW_OP_unknown_0x${op.toString(16)}` });
            break;
        }
      }
    }
    return ops;
  }

  function parseDIE(
    offset: number,
    abbrevTable: AbbreviationEntry[],
    addressSize: number,
    cuStartOffset: number,
  ): DebugInfoEntry | null {
    const abbrevCode = readULEB128(offset);
    if (abbrevCode.value === 0) return null;

    let currentOffset = offset + abbrevCode.size;

    // Find the abbreviation entry for this code
    const abbrevEntry = abbrevTable.find(
      (entry) => entry.code === abbrevCode.value,
    );
    if (!abbrevEntry) {
      // Unknown abbreviation code, create minimal DIE
      return {
        abbrevCode: abbrevCode.value,
        tag: undefined,
        attributes: [],
        size: abbrevCode.size,
        children: [],
        offset: 0
      };
    }

    const attributes: DWARFAttribute[] = [];

    // Parse attributes according to the abbreviation entry
    for (const attrSpec of abbrevEntry.attributes) {
      // DW_FORM.implicit_const carries its value in the abbreviation table
      // and consumes no bytes in the DIE itself.
      if (attrSpec.form === DW_FORM.implicit_const && attrSpec.implicitConst !== undefined) {
        attributes.push({ name: attrSpec.name, form: attrSpec.form, value: attrSpec.implicitConst });
        continue;
      }

      const attrValue = parseAttributeValue(currentOffset, attrSpec.form, addressSize);

      attributes.push({
        name: attrSpec.name,
        form: attrSpec.form,
        value: attrValue.value,
      });

      currentOffset += attrValue.size;
    }

    const die: DebugInfoEntry = {
      abbrevCode: abbrevCode.value,
      tag: abbrevEntry.tag,
      attributes,
      size: 0,
      children: [],
      offset,
    };

    // Post-process attributes: if a location expression block is present,
    // parse DW_OP_* opcodes into a higher-level representation using the
    // shared DataView and existing readers.
    for (const attr of attributes) {
      if ((attr.name === DW_AT.location || attr.name === DW_AT.frame_base) && attr.value instanceof Uint8Array) {
        const raw = attr.value as Uint8Array;
        const baseOffset = raw.byteOffset - elfBuffer.byteOffset;
        const ops = parseLocationExpressionAt(baseOffset, raw.length, addressSize);
        attr.value = { raw, ops };
      }

      // Resolve DW_AT_type references (DW_FORM_ref* forms) into an
      // object containing the absolute reference offset. The numeric value
      // encoded in the DIE is an offset relative to the start of the
      // compilation unit; expose it as `{ ref: absoluteOffset }` so callers
      // can later locate the referenced DIE.
      if ((attr.name === DW_AT.type || attr.name === DW_AT.abstract_origin) && typeof attr.value === 'number') {
        const rel = attr.value as number;
        const absolute = cuStartOffset + rel;
        attr.value = { ref: absolute };
      }
    }

    if (abbrevEntry.hasChildren) {
      while (currentOffset < elfBuffer.length) {
        const child = parseDIE(currentOffset, abbrevTable, addressSize, cuStartOffset);
        if (!child) {
          // Null DIE entry marks the end of children for this parent
          currentOffset += 1;
          break;
        }

        die.children.push(child);
        currentOffset += child.size;
      }
    }

    die.size = currentOffset - offset;
    return die;
  }

  function parseCompilationUnit(offset: number): CompilationUnit {
    const startOffset = offset;
    const length = readUInt32(offset);
    offset += 4;

    const version = readUInt16(offset);
    offset += 2;

    let abbrevOffset: number;
    let addressSize: number;

    // DWARF 5 has a different header format than DWARF 2-4
    if (version >= 5) {
      // DWARF 5 format:
      // - unit_type (1 byte)
      // - address_size (1 byte)
      // - debug_abbrev_offset (4 or 8 bytes depending on format)
      const unitType = elfBuffer[offset];
      offset += 1;

      // Validate unit type - we primarily support DW_UT_compile (0x01)
      // Other types: DW_UT_type (0x02), DW_UT_partial (0x03), DW_UT_skeleton (0x04)
      if (unitType !== undefined && unitType !== 0x01 && unitType !== 0x03) {
        // Log warning for unsupported types but continue parsing
        console.warn(
          `DWARF parsing: Unsupported unit type 0x${unitType.toString(16)} at offset ${startOffset}. Attempting to parse anyway.`,
        );
      }

      addressSize = elfBuffer[offset];
      if (addressSize === undefined) {
        throw new Error(
          "DWARF parsing error: Invalid address size in compilation unit",
        );
      }
      offset += 1;

      // Read abbreviation offset (assume 32-bit format for now)
      abbrevOffset = readUInt32(offset);
      offset += 4;
    } else {
      // DWARF 2-4 format:
      // - debug_abbrev_offset (4 or 8 bytes)
      // - address_size (1 byte)
      abbrevOffset = readUInt32(offset);
      offset += 4;

      addressSize = elfBuffer[offset];
      if (addressSize === undefined) {
        throw new Error(
          "DWARF parsing error: Invalid address size in compilation unit",
        );
      }
      offset += 1;
    }

    const cu: CompilationUnit = {
      length,
      version,
      abbrevOffset,
      addressSize,
      offset: startOffset,
      dies: [],
    };

    // Get or parse abbreviation table for this compilation unit
    let abbrevTable = abbreviationTables.get(abbrevOffset);
    if (!abbrevTable) {
      // Parse abbreviation table if not already cached
      const abbrevSection = sections.get(".debug_abbrev");
      if (abbrevSection) {
        const actualOffset = abbrevSection.offset + abbrevOffset;
        const sectionEnd = abbrevSection.offset + abbrevSection.size;

        // Validate that the abbreviation offset is within the section bounds
        if (actualOffset >= sectionEnd || actualOffset < abbrevSection.offset) {
          throw new Error(
            `DWARF parsing error: Invalid abbreviation offset ${abbrevOffset} (section offset: ${abbrevSection.offset}, size: ${abbrevSection.size}, actual offset: ${actualOffset})`
          );
        }

        abbrevTable = parseAbbreviationTable(actualOffset);
        abbreviationTables.set(abbrevOffset, abbrevTable);
      } else {
        abbrevTable = [];
      }
    }

    const endOffset = startOffset + length + 4;
    while (offset < endOffset) {
      const die = parseDIE(offset, abbrevTable, addressSize, startOffset);
      if (!die) break;
      cu.dies.push(die);
      offset += die.size;
    }

    // Build a DIE offset -> DIE object map for fast lookup within this CU
    const dieMap = new Map<number, DebugInfoEntry>();
    function buildMap(d: DebugInfoEntry) {
      dieMap.set(d.offset, d);
      for (const child of d.children) buildMap(child);
    }
    for (const d of cu.dies) buildMap(d);

    // Resolve intra-CU { ref: absolute } objects to actual DIE objects when available
    for (const d of cu.dies) {
      const stack: DebugInfoEntry[] = [d];
      while (stack.length) {
        const entry = stack.pop()!;
        for (const attr of entry.attributes) {
          if (attr && attr.value && typeof attr.value === 'object' && 'ref' in attr.value) {
            const refOffset = (attr.value as any).ref as number;
            const target = dieMap.get(refOffset);
            if (target) (attr.value as any).die = target;
          }
        }
        for (const child of entry.children) stack.push(child);
      }
    }

    cu.dieMap = dieMap;

    return cu;
  }

  function parseLineNumberInstruction(
    offset: number,
    program: LineNumberProgram,
  ): LineNumberInstruction {
    const opcode = elfBuffer[offset];
    if (opcode === undefined) {
      throw new Error(
        "DWARF parsing error: Invalid opcode in line number instruction",
      );
    }

    let size = 1;
    const instruction: LineNumberInstruction = { opcode, size };

    if (opcode === 0) {
      const length = readULEB128(offset + 1);
      size += length.size;
      const extOpcode = elfBuffer[offset + size];
      if (extOpcode === undefined) {
        throw new Error("Invalid extended opcode");
      }
      size += 1;

      instruction.extended = true;
      instruction.length = length.value;
      instruction.extOpcode = extOpcode;
      instruction.type = "extended";

      switch (extOpcode) {
        case DW_LNE.end_sequence:
          instruction.name = "end_sequence";
          break;
        case DW_LNE.set_address: {
          const address = is64bit
            ? readUInt64(offset + size)
            : readUInt32(offset + size);
          instruction.name = "set_address";
          instruction.address = address;
          size += is64bit ? 8 : 4;
          break;
        }
        case DW_LNE.define_file: {
          const fileName = readString(offset + size);
          size += fileName.size;
          instruction.name = "define_file";
          instruction.fileName = fileName.value;
          break;
        }
        default:
          // Unknown extended opcode: skip the remaining body bytes.
          // `length` includes the extOpcode byte already consumed above, so subtract 1.
          size += length.value - 1;
          break;
      }
    } else if (opcode < program.opcodeBase) {
      instruction.type = "standard";

      switch (opcode) {
        case DW_LNS.copy:
          instruction.name = "copy";
          break;
        case DW_LNS.advance_pc: {
          const advance = readULEB128(offset + 1);
          instruction.name = "advance_pc";
          instruction.advance = advance.value;
          size += advance.size;
          break;
        }
        case DW_LNS.advance_line: {
          const lineAdvance = readSLEB128(offset + 1);
          instruction.name = "advance_line";
          instruction.advance = lineAdvance.value;
          size += lineAdvance.size;
          break;
        }
        case DW_LNS.set_file: {
          const file = readULEB128(offset + 1);
          instruction.name = "set_file";
          instruction.file = file.value;
          size += file.size;
          break;
        }
        case DW_LNS.set_column: {
          const column = readULEB128(offset + 1);
          instruction.name = "set_column";
          instruction.column = column.value;
          size += column.size;
          break;
        }
        case DW_LNS.negate_stmt:
          instruction.name = "negate_stmt";
          break;
        case DW_LNS.set_basic_block:
          instruction.name = "set_basic_block";
          break;
        case DW_LNS.const_add_pc:
          instruction.name = "const_add_pc";
          break;
        case DW_LNS.fixed_advance_pc: {
          const fixedAdvance = readUInt16(offset + 1);
          instruction.name = "fixed_advance_pc";
          instruction.advance = fixedAdvance;
          size += 2;
          break;
        }
      }
    } else {
      instruction.type = "special";
      const adjustedOpcode = opcode - program.opcodeBase;
      const addressAdvance = Math.floor(adjustedOpcode / program.lineRange);
      const lineAdvance =
        program.lineBase + (adjustedOpcode % program.lineRange);

      instruction.addressAdvance = addressAdvance;
      instruction.lineAdvance = lineAdvance;
    }

    instruction.size = size;
    return instruction;
  }

  function parseLineNumberProgram(offset: number): LineNumberProgram {
    const startOffset = offset;
    const unitLength = readUInt32(offset);
    offset += 4;

    const version = readUInt16(offset);
    offset += 2;

    let addressSize = 4; // Default for DWARF 2-4
    let _segmentSelectorSize = 0;

    // DWARF 5 has additional header fields
    if (version >= 5) {
      addressSize = elfBuffer[offset++] || 4;
      _segmentSelectorSize = elfBuffer[offset++] || 0;
    }

    const headerLength = readUInt32(offset);
    offset += 4;

    const minimumInstructionLength = elfBuffer[offset++];

    // DWARF 4+ has maximum_operations_per_instruction
    let _maxOpsPerInstruction = 1;
    if (version >= 4) {
      _maxOpsPerInstruction = elfBuffer[offset++] || 1;
    }

    const defaultIsStmt = elfBuffer[offset++] === 1;
    const lineBase = readInt8(offset++);
    const lineRange = elfBuffer[offset++];
    const opcodeBase = elfBuffer[offset++];

    if (
      minimumInstructionLength === undefined ||
      lineRange === undefined ||
      opcodeBase === undefined
    ) {
      throw new Error("Invalid line number program header");
    }

    const standardOpcodeLengths: number[] = [];
    for (let i = 1; i < opcodeBase; i++) {
      const length = elfBuffer[offset++];
      if (length === undefined) {
        throw new Error("Invalid standard opcode length");
      }
      standardOpcodeLengths.push(length);
    }

    const includeDirectories: string[] = [];
    const fileNames: FileEntry[] = [];

    if (version >= 5) {
      // DWARF 5 format with directory_entry_format and file_name_entry_format

      // Parse directory entry format
      const directoryEntryFormatCount = elfBuffer[offset++] || 0;
      const directoryEntryFormats: Array<{ contentType: number; form: number }> = [];
      for (let i = 0; i < directoryEntryFormatCount; i++) {
        const contentType = readULEB128(offset);
        offset += contentType.size;
        const form = readULEB128(offset);
        offset += form.size;
        directoryEntryFormats.push({ contentType: contentType.value, form: form.value });
      }

      // Parse directories count and entries
      const directoriesCount = readULEB128(offset);
      offset += directoriesCount.size;

      for (let i = 0; i < directoriesCount.value; i++) {
        let dirPath = "";
        for (const format of directoryEntryFormats) {
          // DW_LNCT_path = 0x01
          if (format.contentType === 0x01) {
            const value = parseAttributeValue(offset, format.form, addressSize);
            offset += value.size;
            // Handle both direct strings and string table offsets
            if (typeof value.value === "string") {
              dirPath = value.value;
            } else if (typeof value.value === "number" && debugStrings) {
              // String table offset
              dirPath = readStringFromTable(value.value, debugStrings);
            }
          } else {
            // Skip unknown content types
            const value = parseAttributeValue(offset, format.form, addressSize);
            offset += value.size;
          }
        }
        if (dirPath) {
          includeDirectories.push(dirPath);
        }
      }

      // Parse file entry format
      const fileEntryFormatCount = elfBuffer[offset++] || 0;
      const fileEntryFormats: Array<{ contentType: number; form: number }> = [];
      for (let i = 0; i < fileEntryFormatCount; i++) {
        const contentType = readULEB128(offset);
        offset += contentType.size;
        const form = readULEB128(offset);
        offset += form.size;
        fileEntryFormats.push({ contentType: contentType.value, form: form.value });
      }

      // Parse file names count and entries
      const fileNamesCount = readULEB128(offset);
      offset += fileNamesCount.size;

      for (let i = 0; i < fileNamesCount.value; i++) {
        let fileName = "";
        let dirIndex = 0;

        for (const format of fileEntryFormats) {
          const value = parseAttributeValue(offset, format.form, addressSize);
          offset += value.size;

          // DW_LNCT_path = 0x01, DW_LNCT_directory_index = 0x02
          if (format.contentType === 0x01) {
            // Path
            if (typeof value.value === "string") {
              fileName = value.value;
            } else if (typeof value.value === "number" && debugStrings) {
              fileName = readStringFromTable(value.value, debugStrings);
            }
          } else if (format.contentType === 0x02) {
            // Directory index
            dirIndex = typeof value.value === "number" ? value.value : 0;
          }
        }

        if (fileName) {
          fileNames.push({
            name: fileName,
            directoryIndex: dirIndex,
            modificationTime: 0,
            size: 0,
          });
        }
      }
    } else {
      // DWARF 2-4 format with null-terminated strings
      while (elfBuffer[offset] !== 0) {
        const dir = readString(offset);
        includeDirectories.push(dir.value);
        offset += dir.size;
      }
      offset++;

      while (elfBuffer[offset] !== 0) {
        const fileName = readString(offset);
        offset += fileName.size;

        const dirIndex = readULEB128(offset);
        offset += dirIndex.size;

        const modTime = readULEB128(offset);
        offset += modTime.size;

        const fileSize = readULEB128(offset);
        offset += fileSize.size;

        fileNames.push({
          name: fileName.value,
          directoryIndex: dirIndex.value,
          modificationTime: modTime.value,
          size: fileSize.value,
        });
      }
      offset++;
    }

    const program: LineNumberProgram = {
      sectionOffset: 0, // set by caller after section base is known
      totalLength: unitLength,
      version,
      headerLength,
      minimumInstructionLength,
      defaultIsStmt,
      lineBase,
      lineRange,
      opcodeBase,
      standardOpcodeLengths,
      includeDirectories,
      fileNames,
      instructions: [],
    };

    const programEnd = startOffset + unitLength + 4;
    while (offset < programEnd) {
      const instruction = parseLineNumberInstruction(offset, program);
      program.instructions.push(instruction);
      offset += instruction.size;
    }

    return program;
  }

  function parseELFSymbols(): void {
    // Find .symtab and .strtab sections
    const symtabSection = sections.get(".symtab");
    const strtabSection = sections.get(".strtab");

    if (!symtabSection || !strtabSection) {
      return; // No symbol table found
    }

    const strtabData = new Uint8Array(
      elfBuffer.buffer,
      elfBuffer.byteOffset + strtabSection.offset,
      strtabSection.size,
    );

    // Symbol table entry size (16 bytes for 32-bit, 24 bytes for 64-bit)
    const symEntrySize = is64bit ? 24 : 16;
    const numSymbols = symtabSection.size / symEntrySize;

    for (let i = 0; i < numSymbols; i++) {
      const offset = i * symEntrySize;

      // Parse symbol table entry
      let nameOffset: number;
      let value: number;
      let size: number;
      let info: number;
      let other: number;
      let sectionIndex: number;

      if (is64bit) {
        // 64-bit symbol table entry layout
        nameOffset = readUInt32(symtabSection.offset + offset);
        info = readUInt8(symtabSection.offset + offset + 4);
        other = readUInt8(symtabSection.offset + offset + 5);
        sectionIndex = readUInt16(symtabSection.offset + offset + 6);
        value = readUInt64(symtabSection.offset + offset + 8);
        size = readUInt64(symtabSection.offset + offset + 16);
      } else {
        // 32-bit symbol table entry layout
        nameOffset = readUInt32(symtabSection.offset + offset);
        value = readUInt32(symtabSection.offset + offset + 4);
        size = readUInt32(symtabSection.offset + offset + 8);
        info = readUInt8(symtabSection.offset + offset + 12);
        other = readUInt8(symtabSection.offset + offset + 13);
        sectionIndex = readUInt16(symtabSection.offset + offset + 14);
      }

      // Extract symbol name from string table
      let name = "";
      if (nameOffset > 0 && nameOffset < strtabData.length) {
        let j = nameOffset;
        while (j < strtabData.length && strtabData[j] !== 0) {
          name += String.fromCharCode(strtabData[j]);
          j++;
        }
      }

      // Extract type and bind from info byte
      const type = info & 0xf;
      const bind = info >> 4;
      const visibility = other & 0x3;

      // Only include meaningful symbols (skip null symbol at index 0)
      if (i > 0 && name.length > 0) {
        name = demangle(name);
        elfSymbols.push({
          name,
          value,
          size,
          type,
          bind,
          visibility,
          sectionIndex,
        });
      }
    }
  }

  function parseCfaInstructions(startOffset: number, endOffset: number, addressSize: number): CfaInstruction[] {
    const instructions: CfaInstruction[] = [];
    let offset = startOffset;
    while (offset < endOffset) {
      const byte = readUInt8(offset++);
      const low6 = byte & 0x3f;
      if ((byte & 0xC0) === DW_CFA.advance_loc) {
        instructions.push({ op: DW_CFA.advance_loc, delta: low6 });
      } else if ((byte & 0xC0) === DW_CFA.offset) {
        const f = readULEB128(offset); offset += f.size;
        instructions.push({ op: DW_CFA.offset, reg: low6, factoredOffset: f.value });
      } else if ((byte & 0xC0) === DW_CFA.restore) {
        instructions.push({ op: DW_CFA.restore, reg: low6 });
      } else {
        switch (byte) {
          case DW_CFA.nop: instructions.push({ op: DW_CFA.nop }); break;
          case DW_CFA.set_loc: { const a = addressSize === 8 ? readUInt64(offset) : readUInt32(offset); offset += addressSize; instructions.push({ op: DW_CFA.set_loc, address: a }); break; }
          case DW_CFA.advance_loc1: { instructions.push({ op: DW_CFA.advance_loc1, delta: readUInt8(offset) }); offset += 1; break; }
          case DW_CFA.advance_loc2: { instructions.push({ op: DW_CFA.advance_loc2, delta: readUInt16(offset) }); offset += 2; break; }
          case DW_CFA.advance_loc4: { instructions.push({ op: DW_CFA.advance_loc4, delta: readUInt32(offset) }); offset += 4; break; }
          case DW_CFA.offset_extended: { const r = readULEB128(offset); offset += r.size; const f = readULEB128(offset); offset += f.size; instructions.push({ op: DW_CFA.offset_extended, reg: r.value, factoredOffset: f.value }); break; }
          case DW_CFA.restore_extended: { const r = readULEB128(offset); offset += r.size; instructions.push({ op: DW_CFA.restore_extended, reg: r.value }); break; }
          case DW_CFA.undefined: { const r = readULEB128(offset); offset += r.size; instructions.push({ op: DW_CFA.undefined, reg: r.value }); break; }
          case DW_CFA.same_value: { const r = readULEB128(offset); offset += r.size; instructions.push({ op: DW_CFA.same_value, reg: r.value }); break; }
          case DW_CFA.register: { const r1 = readULEB128(offset); offset += r1.size; const r2 = readULEB128(offset); offset += r2.size; instructions.push({ op: DW_CFA.register, reg: r1.value, reg2: r2.value }); break; }
          case DW_CFA.remember_state: instructions.push({ op: DW_CFA.remember_state }); break;
          case DW_CFA.restore_state: instructions.push({ op: DW_CFA.restore_state }); break;
          case DW_CFA.def_cfa: { const r = readULEB128(offset); offset += r.size; const o = readULEB128(offset); offset += o.size; instructions.push({ op: DW_CFA.def_cfa, reg: r.value, offset: o.value }); break; }
          case DW_CFA.def_cfa_register: { const r = readULEB128(offset); offset += r.size; instructions.push({ op: DW_CFA.def_cfa_register, reg: r.value }); break; }
          case DW_CFA.def_cfa_offset: { const o = readULEB128(offset); offset += o.size; instructions.push({ op: DW_CFA.def_cfa_offset, offset: o.value }); break; }
          case DW_CFA.def_cfa_expression: { const len = readULEB128(offset); offset += len.size + len.value; instructions.push({ op: DW_CFA.def_cfa_expression }); break; }
          case DW_CFA.expression: { const r = readULEB128(offset); offset += r.size; const len = readULEB128(offset); offset += len.size + len.value; instructions.push({ op: DW_CFA.expression, reg: r.value }); break; }
          case DW_CFA.offset_extended_sf: { const r = readULEB128(offset); offset += r.size; const o = readSLEB128(offset); offset += o.size; instructions.push({ op: DW_CFA.offset_extended_sf, reg: r.value, factoredOffset: o.value }); break; }
          case DW_CFA.def_cfa_sf: { const r = readULEB128(offset); offset += r.size; const o = readSLEB128(offset); offset += o.size; instructions.push({ op: DW_CFA.def_cfa_sf, reg: r.value, factoredOffset: o.value }); break; }
          case DW_CFA.def_cfa_offset_sf: { const o = readSLEB128(offset); offset += o.size; instructions.push({ op: DW_CFA.def_cfa_offset_sf, factoredOffset: o.value }); break; }
          default: instructions.push({ op: byte }); break;
        }
      }
    }
    return instructions;
  }

  function parseDebugFrameSection(section: ELFSectionHeader): DebugFrame {
    const cies = new Map<number, DebugFrameCIE>();
    const fdes: DebugFrameFDE[] = [];
    const sectionStart = section.offset;
    const sectionEnd   = section.offset + section.size;
    const defaultAddrSize = is64bit ? 8 : 4;
    let offset = sectionStart;

    while (offset + 8 <= sectionEnd) {
      const entryStart = offset;
      const length = readUInt32(offset); offset += 4;
      if (length === 0) break;
      if (length === 0xffffffff) {
        // DWARF64 — skip
        const extLen = readUInt64(offset); offset += 8 + extLen;
        continue;
      }
      const entryEnd = offset + length; // absolute file offset of end
      const cieId = readUInt32(offset); offset += 4;

      if (cieId === 0xffffffff) {
        // CIE
        const cieOffset = entryStart - sectionStart;
        const version = readUInt8(offset++);
        const aug = readString(offset); const augmentation = aug.value; offset += aug.size;

        let addrSize = defaultAddrSize;
        let segSelectorSize = 0;
        if (version >= 4) { addrSize = readUInt8(offset++); segSelectorSize = readUInt8(offset++); }
        void segSelectorSize;

        const codeAlign = readULEB128(offset); offset += codeAlign.size;
        const dataAlign = readSLEB128(offset); offset += dataAlign.size;
        let returnAddressColumn: number;
        if (version === 1) { returnAddressColumn = readUInt8(offset++); }
        else { const rac = readULEB128(offset); offset += rac.size; returnAddressColumn = rac.value; }

        // If augmentation starts with 'z', skip the augmentation data block
        if (augmentation.startsWith('z')) {
          const augLen = readULEB128(offset); offset += augLen.size + augLen.value;
        }

        const cie: DebugFrameCIE = {
          offset: cieOffset,
          version,
          augmentation,
          codeAlignFactor: codeAlign.value,
          dataAlignFactor: dataAlign.value,
          returnAddressColumn,
          addressSize: addrSize,
          initialInstructions: parseCfaInstructions(offset, entryEnd, addrSize),
        };
        cies.set(cieOffset, cie);
      } else {
        // FDE
        const cieOffset = cieId; // section-relative for .debug_frame
        const cie = cies.get(cieOffset);
        if (!cie) { offset = entryEnd; continue; }

        const pcStart = cie.addressSize === 8 ? readUInt64(offset) : readUInt32(offset); offset += cie.addressSize;
        const pcRange = cie.addressSize === 8 ? readUInt64(offset) : readUInt32(offset); offset += cie.addressSize;

        fdes.push({
          offset: entryStart - sectionStart,
          cieOffset,
          cie,
          pcStart,
          pcRange,
          instructions: parseCfaInstructions(offset, entryEnd, cie.addressSize),
        });
      }
      offset = entryEnd;
    }
    return { cies, fdes };
  }

  // Parse .debug_info section
  if (sections.has(".debug_info")) {
    const section = sections.get(".debug_info");
    if (section) {
      let offset = section.offset;
      const endOffset = section.offset + section.size;

      while (offset < endOffset) {
        const cu = parseCompilationUnit(offset);
        compilationUnits.push(cu);
        offset += cu.length + (is64bit ? 12 : 4);
      }
    }
  }

  // Parse .debug_line section
  if (sections.has(".debug_line")) {
    const section = sections.get(".debug_line");
    if (section) {
      let offset = section.offset;
      const endOffset = section.offset + section.size;

      while (offset < endOffset) {
        const program = parseLineNumberProgram(offset);
        program.sectionOffset = offset - section.offset;
        lineNumberPrograms.push(program);
        offset += program.totalLength + (is64bit ? 12 : 4);
      }
    }
  }

  // Parse .debug_str section
  if (sections.has(".debug_str")) {
    const section = sections.get(".debug_str");
    if (section) {
      debugStrings = new Uint8Array(
        elfBuffer.buffer,
        elfBuffer.byteOffset + section.offset,
        section.size,
      );
    }
  }

  // Parse .debug_ranges section
  if (sections.has(".debug_ranges")) {
    const section = sections.get(".debug_ranges");
    if (section) {
      debugRanges = new Uint8Array(
        elfBuffer.buffer,
        elfBuffer.byteOffset + section.offset,
        section.size,
      );
    }
  }

  // Parse .debug_frame section
  if (sections.has(".debug_frame")) {
    const section = sections.get(".debug_frame");
    if (section) {
      debugFrame = parseDebugFrameSection(section);
    }
  }

  // Parse ELF symbol table
  parseELFSymbols();

  return {
    sections,
    compilationUnits,
    lineNumberPrograms,
    debugStrings,
    debugRanges,
    debugFrame,
    abbreviationTables,
    elfSymbols,
    is64bit,
    isLittleEndian,
  };
}

export function findDIEInCU(cu: CompilationUnit, offset: number): DebugInfoEntry | undefined {
  return cu.dieMap?.get(offset);
}

/**
 * Resolve a `{ ref: absoluteOffset }` object to the referenced DIE.
 * Looks in the provided CU first, then falls back to searching all
 * compilation units in the parsed `DWARFData`.
 */
export function resolveReference(
  cu: CompilationUnit,
  refObj: { ref: number } | undefined,
  dwarfData: DWARFData,
): DebugInfoEntry | undefined {
  if (!refObj) return undefined;
  const local = cu.dieMap?.get(refObj.ref);
  if (local) return local;

  for (const other of dwarfData.compilationUnits) {
    if (other === cu) continue;
    if (other.dieMap && other.dieMap.has(refObj.ref)) return other.dieMap.get(refObj.ref);
  }

  return undefined;
}

/**
 * Evaluate the CFA (Canonical Frame Address) rule active at the given PC.
 * Runs the CIE initial instructions followed by the matching FDE's instructions,
 * stopping when the location counter would advance past `pc`.
 *
 * Returns `{ reg, offset }` where CFA = register[reg] + offset, or `undefined`
 * if no FDE covers the given PC.
 */
export function evaluateCfaAtPc(
  pc: number,
  debugFrame: DebugFrame,
): { reg: number; offset: number } | undefined {
  const fde = debugFrame.fdes.find(f => pc >= f.pcStart && pc < f.pcStart + f.pcRange);
  if (!fde) return undefined;

  const { codeAlignFactor, dataAlignFactor } = fde.cie;

  let loc = 0;
  let cfaReg = 0;
  let cfaOffset = 0;

  function apply(instructions: CfaInstruction[], stopAt?: number): boolean {
    for (const instr of instructions) {
      switch (instr.op) {
        case DW_CFA.advance_loc:
        case DW_CFA.advance_loc1:
        case DW_CFA.advance_loc2:
        case DW_CFA.advance_loc4: {
          const newLoc = loc + (instr.delta ?? 0) * codeAlignFactor;
          if (stopAt !== undefined && newLoc > stopAt) return true;
          loc = newLoc;
          break;
        }
        case DW_CFA.set_loc: {
          const newLoc = instr.address ?? 0;
          if (stopAt !== undefined && newLoc > stopAt) return true;
          loc = newLoc;
          break;
        }
        case DW_CFA.def_cfa:          cfaReg = instr.reg ?? cfaReg; cfaOffset = instr.offset ?? 0; break;
        case DW_CFA.def_cfa_register: cfaReg = instr.reg ?? cfaReg; break;
        case DW_CFA.def_cfa_offset:   cfaOffset = instr.offset ?? 0; break;
        case DW_CFA.def_cfa_sf:       cfaReg = instr.reg ?? cfaReg; cfaOffset = (instr.factoredOffset ?? 0) * dataAlignFactor; break;
        case DW_CFA.def_cfa_offset_sf: cfaOffset = (instr.factoredOffset ?? 0) * dataAlignFactor; break;
      }
    }
    return false;
  }

  apply(fde.cie.initialInstructions);
  loc = fde.pcStart;
  apply(fde.instructions, pc);

  return { reg: cfaReg, offset: cfaOffset };
}

export function formatSectionFlags(flags: ELFSectionFlags): string {
  const parts: string[] = [];

  if (flags & ELFSectionFlags.WRITE) parts.push("WRITE");
  if (flags & ELFSectionFlags.ALLOC) parts.push("ALLOC");
  if (flags & ELFSectionFlags.EXECINSTR) parts.push("EXECINSTR");
  if (flags & ELFSectionFlags.MERGE) parts.push("MERGE");
  if (flags & ELFSectionFlags.STRINGS) parts.push("STRINGS");
  if (flags & ELFSectionFlags.INFO_LINK) parts.push("INFO_LINK");
  if (flags & ELFSectionFlags.LINK_ORDER) parts.push("LINK_ORDER");
  if (flags & ELFSectionFlags.OS_NONCONFORMING) parts.push("OS_NONCONFORMING");
  if (flags & ELFSectionFlags.GROUP) parts.push("GROUP");
  if (flags & ELFSectionFlags.TLS) parts.push("TLS");
  if (flags & ELFSectionFlags.COMPRESSED) parts.push("COMPRESSED");

  return parts.length ? parts.join(" | ") : "0";
}
