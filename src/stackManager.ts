import { Source, StackFrame } from "@vscode/debugadapter";
import { VAmigaView } from "./vAmigaView";
import { formatAddress, formatHex } from "./numbers";
import { basename } from "path";
import { SourceMap } from "./sourceMap";

export class StackManager {
  constructor(
    private vAmiga: VAmigaView,
    private sourceMap: SourceMap,
  ) {}

  public async getStackFrames(startFrame: number, maxLevels: number): Promise<StackFrame[]> {
    const endFrame = startFrame + maxLevels;
    const addresses = await this.guessStack(endFrame);

    let foundSource = false;

    // Now build stack frame response from addresses
    const stk: StackFrame[] = [];
    for (let i = startFrame; i < addresses.length && i < endFrame; i++) {
      const addr = addresses[i][0];
      if (this.sourceMap) {
        const loc = this.sourceMap.lookupAddress(addr);
        if (loc) {
          const frame = new StackFrame(
            i, // Use the frame index as ID
            formatAddress(addr, this.sourceMap),
            new Source(basename(loc.path), loc.path),
            loc.line,
          );
          frame.instructionPointerReference = formatHex(addr);
          stk.push(frame);
          foundSource = true;
          continue;
        }
      }
      // stop on first rom call after user code
      if (foundSource && addr > 0x00e00000 && addr < 0x01000000) {
        break;
      }
      // No source available - create disassembly frame
      const frame = new StackFrame(i, formatHex(addr)); // Use frame index as ID, no source/line
      frame.instructionPointerReference = formatHex(addr);
      stk.push(frame);
    }
    return stk;
  }

  /**
   * Analyzes stack memory to guess call frames.
   *
   * Since VAmiga doesn't track stack frames, this method examines stack memory
   * looking for patterns that indicate return addresses from JSR/BSR instructions.
   *
   * Made protected to allow testing of the stack analysis algorithm.
   *
   * Algorithm:
   * 1. Reads stack memory from current SP
   * 2. Looks for 32-bit values that could be return addresses
   * 3. Validates by checking if previous instructions are JSR/BSR
   * 4. Builds list of [call_site, return_address] pairs
   *
   * @param maxLength Maximum number of stack frames to return
   * @returns Array of [call instruction address, return address] pairs
   */
  public async guessStack(maxLength = 16): Promise<[number, number][]> {
    const cpuInfo = await this.vAmiga.getCpuInfo();

    // vAmiga doesn't currently track stack frames, so we'll need to look at the stack data and guess...
    // Fetch data from sp, up to a reasonable length
    const maxSize = 128;
    const stackData = await this.vAmiga.readMemoryBuffer(
      Number(cpuInfo.a7),
      128,
    );

    const pc = Number(cpuInfo.pc);
    const addresses: [number, number][] = [[pc, pc]]; // Start with at least the current frame

    // Look for values that could be a possible return address (as opposed to other data pushed to the stack)
    let offset = 0;
    addresses: while (offset <= maxSize - 4 && addresses.length < maxLength) {
      const addr = stackData.readInt32BE(offset);
      if (
        this.vAmiga.isValidAddress(addr) &&
        !(addr & 1) // even address
      ) {
        try {
          // Look at previous 3 words, and check if they look like a jsr or bsr
          const prevBytes = await this.vAmiga.readMemoryBuffer(addr - 6, 6);
          for (let i = 0; i < 3; i++) {
            const w = prevBytes.readUInt16BE(i * 2);
            if (
              (w & 0xffc0) === 0x4e80 || // jsr
              (w & 0xff00) === 0x6100 // bsr
            ) {
              // found likely return
              addresses.push([addr - 6 + i * 2, addr]);
              offset += 4;
              continue addresses;
            }
          }
        } catch (_) {
          // probably failed to read mem at invalid address
        }
      }
      // next word if match not found
      offset += 2;
    }
    return addresses;
  }
}
