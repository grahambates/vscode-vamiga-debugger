import { DebugProtocol } from "@vscode/debugprotocol";
import { logger } from "@vscode/debugadapter";
import { VAmiga, CpuInfo, StopMessage } from "./vAmiga";
import { SourceMap } from "./sourceMap";
import { formatHex } from "./numbers";
import { exceptionBreakpointFilters } from "./vectors";

/**
 * Internal reference to a breakpoint set in the emulator.
 */
export interface BreakpointRef {
  /** Unique identifier for this breakpoint */
  id: number;
  /** Memory address where the breakpoint is set */
  address: number;
}

/**
 * Temporary breakpoint used for step operations.
 * These are not visible to the client and are automatically removed when hit.
 */
export interface TmpBreakpoint {
  /** Description of why this breakpoint was set (e.g., "step", "entry") */
  reason: string;
  /** Memory address where the temporary breakpoint is set */
  address: number;
}

/**
 * Result of handling a breakpoint stop event
 */
export interface BreakpointStopResult {
  reason: string;
  text?: string;
  hitBreakpointIds?: number[];
}

/**
 * Manages all types of breakpoints for the debug adapter.
 *
 * Handles different breakpoint types:
 * - Source breakpoints: Line-based breakpoints in source files
 * - Instruction breakpoints: Address-based breakpoints in disassembly
 * - Exception breakpoints: Break on specific CPU exceptions/interrupts
 * - Data breakpoints: Break on memory read/write access
 * - Function breakpoints: Break when entering named functions
 * - Temporary breakpoints: Internal breakpoints for stepping operations
 */
export class BreakpointManager {
  private sourceBreakpoints: Map<string, BreakpointRef[]> = new Map();
  private instructionBreakpoints: BreakpointRef[] = [];
  private exceptionBreakpoints: BreakpointRef[] = [];
  private dataBreakpoints: BreakpointRef[] = [];
  private functionBreakpoints: BreakpointRef[] = [];
  private tmpBreakpoints: TmpBreakpoint[] = [];
  private bpId = 0;

  /**
   * Creates a new BreakpointManager instance.
   *
   * @param vAmiga VAmiga instance for setting hardware breakpoints
   * @param sourceMap Source map for resolving source locations to addresses
   */
  constructor(
    private vAmiga: VAmiga,
    private sourceMap: SourceMap,
  ) {}

  /**
   * Sets source breakpoints for a specific file
   */
  public async setSourceBreakpoints(
    path: string,
    breakpoints: DebugProtocol.SourceBreakpoint[],
  ): Promise<DebugProtocol.Breakpoint[]> {
    logger.log(`Set breakpoints request: ${path}`);

    // Remove existing breakpoints for source
    const existing = this.sourceBreakpoints.get(path);
    if (existing) {
      for (const ref of existing) {
        logger.log(
          `Breakpoint #${ref.id} removed at ${formatHex(ref.address)}`,
        );
        this.vAmiga.removeBreakpoint(ref.address);
      }
    }

    const refs: BreakpointRef[] = [];
    this.sourceBreakpoints.set(path, refs);
    const resultBreakpoints: DebugProtocol.Breakpoint[] = [];

    // Add new breakpoints
    for (const bp of breakpoints) {
      try {
        const location = this.sourceMap.lookupSourceLine(path, bp.line);
        const address = location.address;
        const instructionReference = formatHex(address);
        const id = this.bpId++;

        let ignores = 0;
        if (bp.hitCondition) {
          ignores = Number(bp.hitCondition) - 1;
          if (isNaN(ignores) || ignores < 0) {
            ignores = 0;
          }
        }

        refs.push({ id, address });
        this.vAmiga.setBreakpoint(address, ignores);
        logger.log(
          `Breakpoint #${id} at ${path}:${bp.line} set at ${instructionReference}`,
        );

        resultBreakpoints.push({
          id,
          instructionReference,
          verified: true,
          line: bp.line,
          column: bp.column,
        });
      } catch (error) {
        logger.log(`Failed to set breakpoint at ${path}:${bp.line} - ${error}`);
        resultBreakpoints.push({
          id: this.bpId++,
          verified: false,
          line: bp.line,
          column: bp.column,
          message: `Cannot set breakpoint: ${error}`,
        });
      }
    }

    return resultBreakpoints;
  }

  /**
   * Sets instruction breakpoints at memory addresses
   */
  public async setInstructionBreakpoints(
    breakpoints: DebugProtocol.InstructionBreakpoint[],
  ): Promise<DebugProtocol.Breakpoint[]> {
    // Remove existing
    for (const ref of this.instructionBreakpoints) {
      logger.log(
        `Instruction breakpoint #${ref.id} removed at ${formatHex(ref.address)}`,
      );
      this.vAmiga.removeBreakpoint(ref.address);
    }
    this.instructionBreakpoints = [];

    const resultBreakpoints: DebugProtocol.Breakpoint[] = [];

    // Add new breakpoints
    for (const bp of breakpoints) {
      const address = Number(bp.instructionReference) + (bp.offset ?? 0);
      const id = this.bpId++;

      let ignores = 0;
      if (bp.hitCondition) {
        ignores = Number(bp.hitCondition) - 1;
        if (isNaN(ignores) || ignores < 0) {
          ignores = 0;
        }
      }

      this.instructionBreakpoints.push({ id, address });
      this.vAmiga.setBreakpoint(address, ignores);
      logger.log(
        `Instruction breakpoint #${id} set at ${bp.instructionReference}`,
      );

      resultBreakpoints.push({
        id,
        verified: true,
        ...bp,
      });
    }

    return resultBreakpoints;
  }

  /**
   * Sets function breakpoints by symbol name
   */
  public setFunctionBreakpoints(
    breakpoints: DebugProtocol.FunctionBreakpoint[],
  ): DebugProtocol.Breakpoint[] {
    // Remove existing
    for (const ref of this.functionBreakpoints) {
      logger.log(
        `Function breakpoint #${ref.id} removed at ${formatHex(ref.address)}`,
      );
      this.vAmiga.removeBreakpoint(ref.address);
    }
    this.functionBreakpoints = [];

    const resultBreakpoints: DebugProtocol.Breakpoint[] = [];

    // Add new breakpoints
    for (const bp of breakpoints) {
      const id = this.bpId++;
      const address = this.sourceMap.getSymbols()?.[bp.name];

      if (address) {
        let ignores = 0;
        if (bp.hitCondition) {
          ignores = Number(bp.hitCondition) - 1;
          if (isNaN(ignores) || ignores < 0) {
            ignores = 0;
          }
        }

        this.functionBreakpoints.push({ id, address });
        this.vAmiga.setBreakpoint(address, ignores);
        logger.log(
          `Function breakpoint #${id} set at ${formatHex(address)} for ${bp.name}`,
        );
      }

      resultBreakpoints.push({
        id,
        verified: Boolean(address),
        message: address ? undefined : `Symbol '${bp.name}' not found`,
        ...bp,
      });
    }

    return resultBreakpoints;
  }

  /**
   * Gets data breakpoint info for a variable
   */
  public getDataBreakpointInfo(
    scope: string,
    name: string,
  ):
    | {
        dataId: string | null;
        description: string;
        accessTypes: DebugProtocol.DataBreakpointAccessType[];
        canPersist: boolean;
      }
    | undefined {
    // Handle variables that have memory references
    if (scope === "registers" || scope === "symbols") {
      // For registers and symbols, we can create data breakpoints
      const dataId = `${scope}:${name}`;
      return {
        dataId,
        description: `Break on access to ${name}`,
        accessTypes: [ "readWrite" ],
        canPersist: false,
      };
    }
  }

  /**
   * Sets data breakpoints (watchpoints)
   */
  public async setDataBreakpoints(
    breakpoints: DebugProtocol.DataBreakpoint[],
  ): Promise<DebugProtocol.Breakpoint[]> {
    logger.log(`Set data breakpoints request`);

    // Remove existing data breakpoints
    for (const ref of this.dataBreakpoints) {
      logger.log(
        `Data breakpoint #${ref.id} removed at ${formatHex(ref.address)}`,
      );
      this.vAmiga.removeWatchpoint(ref.address);
    }
    this.dataBreakpoints = [];

    const resultBreakpoints: DebugProtocol.Breakpoint[] = [];

    // Add new data breakpoints
    for (const bp of breakpoints) {
      try {
        let address: number | undefined;
        const parts = bp.dataId.split(":");

        if (parts.length === 2) {
          const [type, name] = parts;
          if (type === "registers") {
            const cpuInfo = await this.vAmiga.getCpuInfo();
            address = Number(cpuInfo[name as keyof CpuInfo]);
          } else if (type === "symbols") {
            const symbols = this.sourceMap.getSymbols();
            address = symbols?.[name];
          }
        }

        if (address !== undefined) {
          const id = this.bpId++;
          const accessType = bp.accessType || "access";
          this.dataBreakpoints.push({ id, address });

          let ignores = 0;
          if (bp.hitCondition) {
            ignores = Number(bp.hitCondition) - 1;
            if (isNaN(ignores) || ignores < 0) {
              ignores = 0;
            }
          }

          this.vAmiga.setWatchpoint(address, ignores);
          logger.log(
            `Data breakpoint #${id} set at ${formatHex(address)} (${accessType})`,
          );

          resultBreakpoints.push({
            id,
            verified: true,
          });
        } else {
          resultBreakpoints.push({
            id: this.bpId++,
            verified: false,
            message: "Invalid memory address for data breakpoint",
          });
        }
      } catch (error) {
        resultBreakpoints.push({
          id: this.bpId++,
          verified: false,
          message: `Error setting data breakpoint: ${error}`,
        });
      }
    }

    return resultBreakpoints;
  }

  /**
   * Sets exception breakpoints
   */
  public setExceptionBreakpoints(
    filters: string[],
  ): DebugProtocol.Breakpoint[] {
    for (const ref of this.exceptionBreakpoints) {
      this.vAmiga.removeCatchpoint(ref.address);
    }
    this.exceptionBreakpoints = [];

    const breakpoints: DebugProtocol.Breakpoint[] = [];

    for (const filter of filters) {
      const vector = Number(filter);
      const id = this.bpId++;
      this.vAmiga.setCatchpoint(vector);
      this.exceptionBreakpoints.push({ id, address: vector });
      breakpoints.push({ id, verified: true });
    }

    return breakpoints;
  }

  /**
   * Sets a temporary breakpoint at the specified address.
   *
   * Temporary breakpoints are used for step operations and are automatically
   * removed when hit. They are not visible to the client.
   *
   * @param address Memory address for the temporary breakpoint
   * @param reason Description of why the breakpoint was set (e.g., "step", "entry")
   */
  public setTmpBreakpoint(address: number, reason: string): void {
    const existing = this.findSourceBreakpoint(address);
    if (existing) {
      logger.log(`Breakpoint already exists at ${formatHex(address)}`);
      return;
    }
    logger.log(
      `Setting temporary breakpoint at ${formatHex(address)} (${reason})`,
    );
    this.tmpBreakpoints.push({ address, reason });
    this.vAmiga.setBreakpoint(address);
  }

  /**
   * Handles a breakpoint stop event from the emulator
   */
  public handleBreakpointStop(message: StopMessage): BreakpointStopResult {
    let bpMatch: BreakpointRef | undefined;

    if (message.name === "WATCHPOINT_REACHED") {
      const result: BreakpointStopResult = {
        reason: "data breakpoint",
      };
      bpMatch = this.dataBreakpoints.find(
        (bp) => bp.address === message.payload.pc,
      );
      if (bpMatch) {
        result.hitBreakpointIds = [bpMatch.id];
      }
      return result;
    }

    if (message.name === "CATCHPOINT_REACHED") {
      const result: BreakpointStopResult = {
        reason: "exception",
      };
      result.text = exceptionBreakpointFilters.find(
        (f) => Number(f.filter) === message.payload.vector,
      )?.label;
      bpMatch = this.exceptionBreakpoints.find(
        (bp) => bp.address === message.payload.vector,
      );
      if (bpMatch) {
        result.hitBreakpointIds = [bpMatch.id];
      }
      return result;
    }

    if (message.name === "BREAKPOINT_REACHED") {
      // First check tmp breakpoints
      const tmpMatch = this.tmpBreakpoints.find(
        (bp) => bp.address === message.payload.pc,
      );
      if (tmpMatch) {
        // Client doesn't know about tmp breakpoints - don't set hitBreakpointIds
        logger.log(
          `Matched tmp breakpoint at ${formatHex(message.payload.pc)}`,
        );
        this.vAmiga.removeBreakpoint(tmpMatch.address);
        this.tmpBreakpoints = this.tmpBreakpoints.filter(
          (bp) => bp.address !== message.payload.pc,
        );
        return {
          reason: tmpMatch.reason,
        };
      } else {
        // check instruction breakpoints
        bpMatch = this.instructionBreakpoints.find(
          (bp) => bp.address === message.payload.pc,
        );
        if (bpMatch) {
          return {
            reason: "instruction breakpoint",
            hitBreakpointIds: [bpMatch.id],
          };
        }

        // check function breakpoints
        bpMatch = this.functionBreakpoints.find(
          (bp) => bp.address === message.payload.pc,
        );
        if (bpMatch) {
          return {
            reason: "function breakpoint",
            hitBreakpointIds: [bpMatch.id],
          };
        }

        // check source breakpoints
        bpMatch = this.findSourceBreakpoint(message.payload.pc);
        if (bpMatch) {
          return {
            reason: "breakpoint",
            hitBreakpointIds: [bpMatch.id],
          };
        }
      }
    }

    // Default fallback
    return {
      reason: "breakpoint",
    };
  }

  /**
   * Gets temporary breakpoints (for testing/debugging)
   */
  public getTmpBreakpoints(): TmpBreakpoint[] {
    return [...this.tmpBreakpoints];
  }

  /**
   * Clears all breakpoints
   */
  public clearAll(): void {
    // Clear source breakpoints
    for (const refs of this.sourceBreakpoints.values()) {
      for (const ref of refs) {
        this.vAmiga.removeBreakpoint(ref.address);
      }
    }
    this.sourceBreakpoints.clear();

    // Clear instruction breakpoints
    for (const ref of this.instructionBreakpoints) {
      this.vAmiga.removeBreakpoint(ref.address);
    }
    this.instructionBreakpoints = [];

    // Clear function breakpoints
    for (const ref of this.functionBreakpoints) {
      this.vAmiga.removeBreakpoint(ref.address);
    }
    this.functionBreakpoints = [];

    // Clear data breakpoints
    for (const ref of this.dataBreakpoints) {
      this.vAmiga.removeWatchpoint(ref.address);
    }
    this.dataBreakpoints = [];

    // Clear exception breakpoints
    for (const ref of this.exceptionBreakpoints) {
      this.vAmiga.removeCatchpoint(ref.address);
    }
    this.exceptionBreakpoints = [];

    // Clear temporary breakpoints
    for (const tmp of this.tmpBreakpoints) {
      this.vAmiga.removeBreakpoint(tmp.address);
    }
    this.tmpBreakpoints = [];
  }

  /**
   * Finds a source breakpoint at the specified address.
   */
  private findSourceBreakpoint(address: number): BreakpointRef | undefined {
    for (const bps of this.sourceBreakpoints.values()) {
      const bpMatch = bps.find((bp) => bp.address === address);
      if (bpMatch) {
        return bpMatch;
      }
    }
    return undefined;
  }
}
