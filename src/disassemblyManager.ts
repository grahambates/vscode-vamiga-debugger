/* eslint-disable @typescript-eslint/no-explicit-any */
import { DebugProtocol } from "@vscode/debugprotocol";
import { basename } from "path";
import { SourceMap } from "./sourceMap";
import { VAmiga } from "./vAmiga";
import { Source } from "@vscode/debugadapter";

/**
 * Manages instruction disassembly for the debug adapter.
 *
 * Handles disassembly requests with support for:
 * - Variable-length instruction handling
 * - Positive and negative instruction offsets
 * - Source map integration for symbol information
 * - Padding for missing instructions at negative boundaries
 */
export class DisassemblyManager {
  /**
   * Creates a new DisassemblyManager instance.
   *
   * @param vAmiga VAmiga instance for disassembly operations
   * @param sourceMap Source map for adding symbol information to instructions
   */
  constructor(
    private vAmiga: VAmiga,
    private sourceMap: SourceMap,
  ) {}

  /**
   * Disassembles instructions at the specified address with offset support.
   *
   * Handles complex offset calculations for variable-length instructions:
   * - Negative offsets: Estimates start address using worst-case instruction lengths
   * - Positive offsets: Fetches extra instructions and trims to requested range
   * - Padding: Adds invalid instructions when negative offset exceeds available code
   *
   * @param baseAddress Base memory address for disassembly
   * @param instructionOffset Instruction offset from base address (can be negative)
   * @param count Number of instructions to disassemble
   * @returns Array of disassembled instructions with optional source information
   */
  public async disassemble(
    baseAddress: number,
    instructionOffset: number,
    count: number,
  ): Promise<DebugProtocol.DisassembledInstruction[]> {
    let requestCount = count;
    let startAddress = baseAddress;

    // Instruction offsets are a pain in the arse!
    if (instructionOffset < 0) {
      // Negative instruction offset:
      // Here we don't really know the start address to disassemble from to get this many additional instructions,
      // because their length varies.
      // Use the worst case, and set the start address way back as if each instruction is the maximum possible size.
      // This will result in getting way more than we need.
      const MAX_BYTES_PER_INSTRUCTION = 8; // really 10, but super unlikely
      const MIN_BYTES_PER_INSTRUCTION = 2;
      startAddress += instructionOffset * MAX_BYTES_PER_INSTRUCTION;
      // Clamp to make sure we don't get a negative address. If we don't get enough instructions, we'll pad the result later
      startAddress = Math.max(startAddress, 0);
      // We also need to take the worst case of how many instructions to disassemble from the start address to include the requested range
      // i.e. we set start address as if all the instructions were max size, but if they were min size, we have 4x
      // that many instructions before we reach our base address
      requestCount +=
        -instructionOffset *
        (MAX_BYTES_PER_INSTRUCTION / MIN_BYTES_PER_INSTRUCTION);
    } else {
      // Positive instruction offset:
      // We still need to start disassembling from the base address, but just fetch more instructions and trim them later.
      requestCount += instructionOffset;
    }

    const result = await this.vAmiga.disassemble(startAddress, requestCount);

    if (!result.instructions) {
      throw new Error(
        "Disassembly failed: No instructions returned from disassembler",
      );
    }

    // find the instruction containing the base address. We'll slice relative to this to get the requested range
    const startIndex = result.instructions.findIndex(
      (i) => parseInt(i.addr, 16) === baseAddress,
    );
    // If it's not there we're pretty screwed...
    if (startIndex === -1) {
      throw new Error("Disassembly failed: Start instruction not found");
    }
    let realStart = startIndex + instructionOffset;

    // These are the instructions that will actually go in the response
    const includedInstructions: typeof result.instructions = [];

    // Pad with filler instructions to make up requested amount if start index is negative.
    if (realStart < 0) {
      for (let i = 0; i < -realStart; i++) {
        includedInstructions.push({
          addr: "00000000",
          instruction: "invalid",
          hex: "0000 0000",
        });
      }
      realStart = 0;
    }

    includedInstructions.push(
      ...result.instructions.slice(realStart, realStart + count),
    );

    return includedInstructions.map((instr: any) => {
      const disasm: DebugProtocol.DisassembledInstruction = {
        address: "0x" + instr.addr,
        instruction: instr.instruction,
        instructionBytes: instr.hex,
      };
      if (
        instr.hex === "0000 0000" || // I mean, it could be `or.w #0,d0` but who's doing that?
        instr.instruction.startsWith("dc.")
      ) {
        disasm.presentationHint = "invalid";
      }

      // Add symbol lookup if we have source map
      if (this.sourceMap) {
        const addr = parseInt(instr.addr, 16);
        const loc = this.sourceMap.lookupAddress(addr);
        if (loc) {
          disasm.symbol = basename(loc.path) + ":" + loc.line;
          disasm.location = new Source(basename(loc.path), loc.path);
          disasm.line = loc.line;
        }
      }
      return disasm;
    });
  }

  public async disassembleCopper(address: number, instructionCount: number) {
    const result = await this.vAmiga.disassembleCopper(
      address,
      instructionCount,
    );
    return result.instructions.map((instr: any) => {
      const disasm: DebugProtocol.DisassembledInstruction = {
        address: "0x" + instr.addr,
        instruction: instr.instruction,
        instructionBytes: instr.hex,
      };

      // Add symbol lookup if we have source map
      if (this.sourceMap) {
        const addr = parseInt(instr.addr, 16);
        const loc = this.sourceMap.lookupAddress(addr);
        if (loc) {
          disasm.symbol = basename(loc.path) + ":" + loc.line;
          disasm.location = new Source(basename(loc.path), loc.path);
          disasm.line = loc.line;
        }
      }
      return disasm;
    });
  }
}
