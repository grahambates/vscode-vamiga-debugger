/**
 * CPU (M68000) instruction disassembler for Amiga
 *
 * Unlike Copper instructions which are fixed-length (4 bytes), M68k instructions
 * are variable-length (2-10 bytes), which makes virtualization and windowing challenging.
 *
 * This module provides utilities for sequential disassembly, handling instruction
 * boundaries that may span multiple memory chunks.
 *
 * Uses the m68kdecode library for accurate M68k instruction decoding.
 */

import { decodeInstruction as m68kDecode, instructionToString } from "m68kdecode";

export interface CPUInstruction {
  address: number;
  bytes: Uint8Array;
  mnemonic: string;
  operands: string;
  comment?: string;
}

/**
 * Result of disassembling a chunk of memory
 */
export interface DisassemblyChunk {
  instructions: CPUInstruction[];
  /** The address of the last byte processed (may be incomplete instruction) */
  lastAddress: number;
  /** Number of incomplete bytes at the end (instruction spanning chunk boundary) */
  incompleteBytesAtEnd: number;
}

/**
 * Parse a disassembled instruction string into mnemonic and operands
 * Format from m68kdecode is like "move.l d0,d1" or "bra.s $1234"
 */
function parseInstructionString(instrStr: string): { mnemonic: string; operands: string } {
  const parts = instrStr.trim().split(/\s+/);

  if (parts.length === 0) {
    return { mnemonic: '', operands: '' };
  }

  const mnemonic = parts[0];
  const operands = parts.slice(1).join(' ');

  return { mnemonic, operands };
}

/**
 * Disassemble a single instruction at the given offset in the byte array
 * Returns the instruction and number of bytes consumed, or null if insufficient data
 */
function disassembleSingleInstruction(
  bytes: Uint8Array,
  offset: number,
  address: number
): { instruction: CPUInstruction; bytesUsed: number } | null {
  // Need at least 2 bytes for any M68k instruction
  if (offset + 1 >= bytes.length) {
    return null;
  }

  try {
    // Slice from offset to end to give decoder maximum data
    const codeSlice = bytes.slice(offset);
    const decoded = m68kDecode(codeSlice);

    const bytesUsed = decoded.bytesUsed;

    // Check if we have enough bytes
    if (offset + bytesUsed > bytes.length) {
      return null;
    }

    // Get the instruction bytes
    const instrBytes = bytes.slice(offset, offset + bytesUsed);

    // Convert instruction to string
    const instrStr = instructionToString(decoded.instruction);
    const { mnemonic, operands } = parseInstructionString(instrStr);

    return {
      instruction: {
        address,
        bytes: instrBytes,
        mnemonic,
        operands,
      },
      bytesUsed,
    };
  } catch (_error) {
    // If decoding fails, treat as invalid instruction (dc.w)
    const word = (bytes[offset] << 8) | bytes[offset + 1];
    return {
      instruction: {
        address,
        bytes: bytes.slice(offset, offset + 2),
        mnemonic: 'dc.w',
        operands: '$' + word.toString(16).toUpperCase().padStart(4, '0'),
        comment: 'Invalid instruction',
      },
      bytesUsed: 2,
    };
  }
}

/**
 * Disassemble instructions from a byte array, handling variable-length instructions
 * Returns instructions and information about incomplete bytes at the end
 */
export function disassembleBytes(
  startAddress: number,
  bytes: Uint8Array
): DisassemblyChunk {
  const instructions: CPUInstruction[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    const result = disassembleSingleInstruction(
      bytes,
      offset,
      startAddress + offset
    );

    if (!result) {
      // Incomplete instruction at end - not enough bytes to decode
      return {
        instructions,
        lastAddress: startAddress + offset - 1,
        incompleteBytesAtEnd: bytes.length - offset,
      };
    }

    instructions.push(result.instruction);
    offset += result.bytesUsed;
  }

  return {
    instructions,
    lastAddress: startAddress + offset - 1,
    incompleteBytesAtEnd: 0,
  };
}

/**
 * Helper to concatenate Uint8Arrays
 */
export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
