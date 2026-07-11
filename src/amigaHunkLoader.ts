/**
 * Enhanced hunk loader with OS-aware memory allocation
 * Loads Amiga executables directly into memory bypassing floppy emulation
 */

import { Emulator } from "./emulator";
import { Hunk, HunkType, RelocInfo32 } from "./amigaHunkParser";
import {
  AmigaMemoryMapper,
  AllocatedHunk,
  LoadedProgram,
} from "./amigaMemoryMapper";

export class AmigaHunkLoader {
  private memoryMapper: AmigaMemoryMapper;

  constructor(private emulator: Emulator) {
    this.memoryMapper = new AmigaMemoryMapper(emulator);
  }

  /**
   * Load hunks into memory with OS-aware allocation
   */
  async loadProgram(hunks: Hunk[]): Promise<LoadedProgram> {
    if (hunks.length === 0) {
      throw new Error("Program loading error: No hunks to load");
    }

    // Phase 1: Allocate memory for all hunks
    const allocations = await this.allocateHunks(hunks);

    // Phase 2: Write hunk data to allocated memory
    await this.writeHunkData(allocations);

    // Phase 3: Apply relocations (must be after data is written)
    await this.applyRelocations(hunks, allocations);

    const totalSize = allocations.reduce((sum, alloc) => sum + alloc.size, 0);

    // Find the first CODE hunk as entry point, fallback to first hunk if no CODE hunk found
    const codeHunk = allocations.find(
      (alloc) => alloc.hunk.hunkType === HunkType.CODE,
    );
    const entryPoint = codeHunk?.address || allocations[0]?.address || 0;

    return {
      entryPoint,
      allocations,
      totalSize,
    };
  }

  /**
   * Allocate memory for all hunks using OS allocation
   */
  private async allocateHunks(hunks: Hunk[]): Promise<AllocatedHunk[]> {
    const allocations: AllocatedHunk[] = [];

    for (const hunk of hunks) {
      const address = await this.memoryMapper.allocateMemory(
        hunk.allocSize,
        hunk.memType,
      );

      allocations.push({
        hunk,
        address,
        size: hunk.allocSize,
      });
    }

    return allocations;
  }

  /**
   * Apply relocations to resolve inter-hunk references
   */
  private async applyRelocations(
    hunks: Hunk[],
    allocations: AllocatedHunk[],
  ): Promise<void> {
    // Create lookup table for hunk addresses
    const hunkAddresses = new Map<number, number>();
    for (const alloc of allocations) {
      hunkAddresses.set(alloc.hunk.index, alloc.address);
    }

    for (const alloc of allocations) {
      const hunk = alloc.hunk;

      if (hunk.reloc32.length > 0) {
        for (const relocInfo of hunk.reloc32) {
          const targetAddress = hunkAddresses.get(relocInfo.target);
          if (targetAddress === undefined) {
            throw new Error(
              `Program loading error: Relocation target hunk ${relocInfo.target} not found`,
            );
          }

          await this.applyRelocationGroup(alloc, relocInfo, targetAddress);
        }
      }
    }
  }

  /**
   * Apply a group of relocations for a specific target hunk
   */
  private async applyRelocationGroup(
    alloc: AllocatedHunk,
    relocInfo: RelocInfo32,
    targetAddress: number,
  ): Promise<void> {
    for (const offset of relocInfo.offsets) {
      const relocAddress = alloc.address + offset;

      // Read current value at relocation site
      const currentValue = await this.emulator.peek32(relocAddress);

      // Add target hunk base address to current value
      const relocatedValue = currentValue + targetAddress;

      // Write back the relocated value
      await this.emulator.poke32(relocAddress, relocatedValue);
    }
  }

  /**
   * Write hunk data to allocated memory locations
   */
  private async writeHunkData(allocations: AllocatedHunk[]): Promise<void> {
    for (const alloc of allocations) {
      const hunk = alloc.hunk;

      if (hunk.hunkType === HunkType.BSS) {
        // BSS hunks need to be zeroed
        await this.zeroMemory(alloc.address, alloc.size);
      } else if (hunk.data) {
        // CODE and DATA hunks have binary content
        await this.emulator.writeMemory(alloc.address, hunk.data);
      }
    }
  }

  /**
   * Zero out a memory region (for BSS hunks)
   */
  private async zeroMemory(address: number, size: number): Promise<void> {
    // Create a buffer of zeros and write
    const zeroBuffer = Buffer.alloc(size);
    await this.emulator.writeMemory(address, zeroBuffer);
  }

  /**
   * Free all allocated memory when program is unloaded
   */
  async unloadProgram(program: LoadedProgram): Promise<void> {
    for (const alloc of program.allocations) {
      await this.memoryMapper.freeMemory(alloc.address, alloc.size);
    }
  }

  /**
   * Get memory allocation statistics
   */
  async getMemoryStats() {
    return await this.memoryMapper.getMemoryInfo();
  }

  /**
   * Load and relocate hunks from binary data
   */
  static async loadFromHunks(
    emulator: Emulator,
    hunks: Hunk[],
  ): Promise<LoadedProgram> {
    const loader = new AmigaHunkLoader(emulator);
    return await loader.loadProgram(hunks);
  }

  /**
   * Create a program entry point setup
   * Sets up registers and jumps to program start
   */
  async setupProgramEntry(program: LoadedProgram): Promise<void> {
    await this.setupReturnTrampoline(program);
    await this.clearInterruptMask();
    // Jump pc to entrypoint
    await this.emulator.jump(program.entryPoint);
  }

  /**
   * fastLoad injects the program at whatever point Kickstart's boot sequence
   * happened to be paused, inheriting its SR - including the CPU interrupt
   * priority mask (SR bits 8-10). If that mask is non-zero, the 68000 itself
   * blocks any interrupt at or below that level (VERTB/Copper/Blitter are
   * level 3, CIA-A PORTS is level 2) regardless of INTENA/INTREQ, so programs
   * relying on those interrupts for their main loop never wake up. Clear the
   * mask so the program starts with all interrupt levels enabled, matching a
   * normal AmigaDOS program launch.
   */
  private async clearInterruptMask(): Promise<void> {
    const cpuInfo = await this.emulator.getCpuInfo();
    const sr = Number(cpuInfo.sr) & ~0x0700;
    await this.emulator.setRegister("sr", sr);
  }

  /**
   * fastLoad injects the program directly with no DOS process to return to,
   * so an `rts` at the end of the program would pop a garbage return address
   * and crash the emulator. Instead, build a synthetic call frame at the top
   * of the program's stack: a return address pointing at a small landing-pad
   * routine that shuts down DMA and interrupts and then spins forever -
   * mimicking what a real `jsr` into the program would have left behind, so
   * `rts` lands somewhere harmless when the program exits.
   *
   * Deliberately targets USP, not A7. A7 is the *live*, mode-dependent
   * register (USP's contents while in user mode, SSP's while in
   * supervisor) - reading/writing it at injection time only matches what
   * the program sees at runtime if the CPU happens to be in the same mode
   * at both points. It isn't: exec-ready detection only guarantees user
   * mode at the moment it's checked, the CPU can have already moved on to
   * (or be halted mid-) a supervisor-mode interrupt by the time this runs,
   * and the caller (see setupProgramEntry) unconditionally forces user mode
   * before jumping to the program regardless. USP is mode-independent - it
   * always refers to the user stack pointer whether or not the CPU is
   * currently in supervisor mode - so it's the only target that's
   * guaranteed to be where the program (always started in user mode) will
   * actually look for its stack and where its `rts` will actually pop from.
   */
  private async setupReturnTrampoline(program: LoadedProgram): Promise<void> {
    // move.w #$7FFF, $DFF096   ; DMACON - disable all DMA channels
    // move.w #$7FFF, $DFF09A   ; INTENA - disable all interrupts
    // bra.s  *                 ; spin forever
    const TRAMPOLINE_CODE = Buffer.from([
      0x33, 0xfc, 0x7f, 0xff, 0x00, 0xdf, 0xf0, 0x96, 0x33, 0xfc, 0x7f, 0xff,
      0x00, 0xdf, 0xf0, 0x9a, 0x60, 0xfe,
    ]);
    // Reserved budget below the trampoline for the program's own stack usage
    // (see LoadedProgram.stackRange) — a fixed approximation, not a real
    // stack-overflow boundary.
    const STACK_RESERVE_SIZE = 32 * 1024;

    const cpuInfo = await this.emulator.getCpuInfo();
    const sp = Number(cpuInfo.usp);

    const trampolineAddress = sp - TRAMPOLINE_CODE.length; // landing pad, ending at the original usp
    const returnAddress = trampolineAddress - 4; // synthetic return address, popped by rts

    await this.emulator.writeMemory(trampolineAddress, TRAMPOLINE_CODE);
    await this.emulator.poke32(returnAddress, trampolineAddress);
    await this.emulator.setRegister("usp", returnAddress);

    program.stackRange = {
      address: trampolineAddress - STACK_RESERVE_SIZE,
      size: STACK_RESERVE_SIZE + TRAMPOLINE_CODE.length + 4,
    };

  }
}

/**
 * Utility function to load a program with full setup
 */
export async function loadAmigaProgram(
  emulator: Emulator,
  hunks: Hunk[],
): Promise<LoadedProgram> {
  const loader = new AmigaHunkLoader(emulator);
  const program = await loader.loadProgram(hunks);

  // Set up program entry point
  await loader.setupProgramEntry(program);

  return program;
}
