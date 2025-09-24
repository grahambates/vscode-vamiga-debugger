/**
 * Enhanced hunk loader with OS-aware memory allocation
 * Loads Amiga executables directly into memory bypassing floppy emulation
 */

import { VAmigaView } from "./vAmigaView";
import { Hunk, HunkType, RelocInfo32 } from "./amigaHunkParser";
import {
  AmigaMemoryManager,
  AllocatedHunk,
  LoadedProgram
} from "./amigaMemoryManager";

export class AmigaHunkLoader {
  private memoryManager: AmigaMemoryManager;

  constructor(private vAmiga: VAmigaView) {
    this.memoryManager = new AmigaMemoryManager(vAmiga);
  }

  /**
   * Load hunks into memory with OS-aware allocation
   */
  async loadProgram(hunks: Hunk[]): Promise<LoadedProgram> {
    if (hunks.length === 0) {
      throw new Error("No hunks to load");
    }

    // Phase 1: Allocate memory for all hunks
    const allocations = await this.allocateHunks(hunks);

    // Phase 2: Write hunk data to allocated memory
    await this.writeHunkData(allocations);

    // Phase 3: Apply relocations (must be after data is written)
    await this.applyRelocations(hunks, allocations);

    const totalSize = allocations.reduce((sum, alloc) => sum + alloc.size, 0);

    // Find the first CODE hunk as entry point, fallback to first hunk if no CODE hunk found
    const codeHunk = allocations.find(alloc => alloc.hunk.hunkType === HunkType.CODE);
    const entryPoint = codeHunk?.address || allocations[0]?.address || 0;

    return {
      entryPoint,
      allocations,
      totalSize
    };
  }

  /**
   * Allocate memory for all hunks using OS allocation
   */
  private async allocateHunks(hunks: Hunk[]): Promise<AllocatedHunk[]> {
    const allocations: AllocatedHunk[] = [];

    for (const hunk of hunks) {
      console.log(`Allocating ${hunk.allocSize} bytes of ${hunk.memType} memory for hunk ${hunk.index}`);

      const address = await this.memoryManager.allocateMemory(
        hunk.allocSize,
        hunk.memType
      );

      allocations.push({
        hunk,
        address,
        size: hunk.allocSize
      });

      console.log(`Hunk ${hunk.index} allocated at address $${address.toString(16)}`);
    }

    return allocations;
  }

  /**
   * Apply relocations to resolve inter-hunk references
   */
  private async applyRelocations(
    hunks: Hunk[],
    allocations: AllocatedHunk[]
  ): Promise<void> {
    // Create lookup table for hunk addresses
    const hunkAddresses = new Map<number, number>();
    for (const alloc of allocations) {
      hunkAddresses.set(alloc.hunk.index, alloc.address);
    }

    for (const alloc of allocations) {
      const hunk = alloc.hunk;

      if (hunk.reloc32.length > 0) {
        console.log(`Applying ${hunk.reloc32.length} relocation groups for hunk ${hunk.index}`);

        for (const relocInfo of hunk.reloc32) {
          const targetAddress = hunkAddresses.get(relocInfo.target);
          if (targetAddress === undefined) {
            throw new Error(`Relocation target hunk ${relocInfo.target} not found`);
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
    targetAddress: number
  ): Promise<void> {
    for (const offset of relocInfo.offsets) {
      const relocAddress = alloc.address + offset;

      // Read current value at relocation site
      const currentValue = await this.vAmiga.peek32(relocAddress);

      // Add target hunk base address to current value
      const relocatedValue = currentValue + targetAddress;

      // Write back the relocated value
      await this.vAmiga.poke32(relocAddress, relocatedValue);

      console.log(
        `Relocation at $${relocAddress.toString(16)}: ` +
        `$${currentValue.toString(16)} + $${targetAddress.toString(16)} = ` +
        `$${relocatedValue.toString(16)}`
      );
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
        console.log(`Zeroing BSS hunk ${hunk.index} at $${alloc.address.toString(16)}`);
        await this.zeroMemory(alloc.address, alloc.size);
      } else if (hunk.data) {
        // CODE and DATA hunks have binary content
        console.log(
          `Writing ${hunk.data.length} bytes for ${hunk.hunkType} hunk ${hunk.index} ` +
          `at $${alloc.address.toString(16)}`
        );

        await this.writeMemoryChunked(alloc.address, hunk.data);
      }
    }
  }

  /**
   * Write memory data in chunks to handle size limitations (1-4096 bytes per write)
   */
  private async writeMemoryChunked(address: number, data: Buffer): Promise<void> {
    const CHUNK_SIZE = 4096;
    let offset = 0;

    while (offset < data.length) {
      const chunkSize = Math.min(CHUNK_SIZE, data.length - offset);
      const chunk = data.subarray(offset, offset + chunkSize);
      const base64Chunk = chunk.toString('base64');

      await this.vAmiga.writeMemory(address + offset, base64Chunk);
      offset += chunkSize;
    }
  }

  /**
   * Zero out a memory region (for BSS hunks)
   */
  private async zeroMemory(address: number, size: number): Promise<void> {
    // Create a buffer of zeros and write in chunks
    const zeroBuffer = Buffer.alloc(size);
    await this.writeMemoryChunked(address, zeroBuffer);
  }

  /**
   * Free all allocated memory when program is unloaded
   */
  async unloadProgram(program: LoadedProgram): Promise<void> {
    console.log(`Unloading program with ${program.allocations.length} hunks`);

    for (const alloc of program.allocations) {
      console.log(`Freeing hunk ${alloc.hunk.index} at $${alloc.address.toString(16)}`);
      await this.memoryManager.freeMemory(alloc.address, alloc.size);
    }
  }

  /**
   * Get memory allocation statistics
   */
  async getMemoryStats() {
    return await this.memoryManager.getMemoryInfo();
  }

  /**
   * Load and relocate hunks from binary data
   */
  static async loadFromHunks(
    vAmiga: VAmigaView,
    hunks: Hunk[]
  ): Promise<LoadedProgram> {
    const loader = new AmigaHunkLoader(vAmiga);
    return await loader.loadProgram(hunks);
  }

  /**
   * Create a program entry point setup
   * Sets up registers and jumps to program start
   */
  async setupProgramEntry(program: LoadedProgram): Promise<void> {
    // Jump pc to entrypoint
    await this.vAmiga.jump(program.entryPoint);
    // TODO: set initial register state, stack etc?
    console.log(`Program entry point set to $${program.entryPoint.toString(16)}`);
  }
}

/**
 * Utility function to load a program with full setup
 */
export async function loadAmigaProgram(
  vAmiga: VAmigaView,
  hunks: Hunk[]
): Promise<LoadedProgram> {
  console.log(`Loading Amiga program with ${hunks.length} hunks`);

  const loader = new AmigaHunkLoader(vAmiga);
  const program = await loader.loadProgram(hunks);

  // Set up program entry point
  await loader.setupProgramEntry(program);

  return program;
}