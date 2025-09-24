/* eslint-disable @typescript-eslint/no-explicit-any */

// TODO:
// - Console
//   - disasm
//   - mem
// - constants
// - Copper debugging
// - Memory address validation
// - mem ref on custom ptrs

import {
  logger,
  LoggingDebugSession,
  InitializedEvent,
  TerminatedEvent,
  StoppedEvent,
  ContinuedEvent,
  OutputEvent,
  Thread,
  StackFrame,
  Scope,
  Source,
  Handles,
} from "@vscode/debugadapter";
import { LogLevel } from "@vscode/debugadapter/lib/logger";
import { DebugProtocol } from "@vscode/debugprotocol";
import * as vscode from "vscode";
import * as path from "path";
import { readFile } from "fs/promises";
import { Parser } from "expr-eval";

import {
  VAmigaView,
  CpuInfo,
  EmulatorMessage,
  isAttachedMessage,
  isEmulatorStateMessage,
  isEmulatorOutputMessage,
  EmulatorStateMessage,
  StopMessage,
  isExecReadyMessage,
} from "./vAmigaView";
import { Hunk, parseHunks } from "./amigaHunkParser";
import { DWARFData, parseDwarf } from "./dwarfParser";
import { loadAmigaProgram } from "./amigaHunkLoader";
import { LoadedProgram } from "./amigaMemoryManager";
import { sourceMapFromDwarf } from "./dwarfSourceMap";
import { sourceMapFromHunks } from "./amigaHunkSourceMap";
import { Location, SourceMap } from "./sourceMap";
import {
  formatHex,
  isNumeric,
  u32,
  u16,
  u8,
  i32,
  i16,
  i8,
  formatBin,
} from "./numbers";
import {
  allFunctions,
  consoleCommands,
  functionsText,
  helpText,
  initOutput,
  syntaxText,
} from "./repl";
import { exceptionBreakpointFilters, vectors } from "./vectors";
import { instructionAttrs } from "./instructions";

/**
 * Launch configuration arguments for starting a debug session.
 * Extends the standard DAP launch arguments with Vamiga-specific options.
 */
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  /** Path to the Amiga program executable to debug */
  program: string;
  /** Optional path to separate file containing debug symbols (defaults to program path) */
  debugProgram?: string | null;
  /** Whether to automatically stop on program entry point */
  stopOnEntry?: boolean;
  /** Enable verbose logging of debug adapter protocol messages */
  trace?: boolean;
  /** Inject program directly into memory from starting vAmiga snapshot */
  snapshot?: string;
}

/**
 * Internal reference to a breakpoint set in the emulator.
 */
interface BreakpointRef {
  /** Unique identifier for this breakpoint */
  id: number;
  /** Memory address where the breakpoint is set */
  address: number;
}

/**
 * Temporary breakpoint used for step operations.
 * These are not visible to the client and are automatically removed when hit.
 */
interface TmpBreakpoint {
  /** Description of why this breakpoint was set (e.g., "step", "entry") */
  reason: string;
  /** Memory address where the temporary breakpoint is set */
  address: number;
}

/**
 * Result of evaluating an expression in the debug context.
 */
interface EvaluateResult {
  /** Numeric value of the expression, if successfully evaluated */
  value?: number;
  /** Memory reference string for values that represent addresses */
  memoryReference?: string;
  /** Type classification of the result for appropriate formatting */
  type: EvaluateResultType;
}

/**
 * Classification of expression evaluation results for appropriate formatting.
 */
export enum EvaluateResultType {
  /** Empty expression */
  EMPTY,
  /** Unknown or unclassified result */
  UNKNOWN,
  /** Result is a symbol address */
  SYMBOL,
  /** Result is a CPU data register (d0-d7) */
  DATA_REGISTER,
  /** Result is a CPU address register (a0-a7, pc, etc.) */
  ADDRESS_REGISTER,
  /** Result is a custom chip register */
  CUSTOM_REGISTER,
  /** Result from parsing a complex expression */
  PARSED,
}

/**
 * Categorized error codes for debug adapter operations.
 * Organized by functional area with reserved number ranges.
 */
export enum ErrorCode {
  // Launch/initialization errors (2000-2099)
  /** Program path not specified in launch configuration */
  PROGRAM_NOT_SPECIFIED = 2001,
  /** Failed to read or parse debug symbols */
  DEBUG_SYMBOLS_READ_ERROR = 2002,
  /** Failed to start the VAmiga emulator */
  EMULATOR_START_ERROR = 2003,

  // Runtime/execution errors (3000-3099)
  /** RPC call to emulator timed out */
  RPC_TIMEOUT = 3001,
  /** Error during step operation */
  STEP_ERROR = 3002,
  /** Error during continue operation */
  CONTINUE_ERROR = 3003,
  /** Error during pause operation */
  PAUSE_ERROR = 3004,
  /** Error during session termination */
  TERMINATE_ERROR = 3005,

  // Variable/expression errors (4000-4099)
  /** Failed to read variable values */
  VARIABLE_READ_ERROR = 4001,
  /** Failed to update variable value */
  VARIABLE_UPDATE_ERROR = 4002,
  /** Error evaluating expression */
  EXPRESSION_EVALUATION_ERROR = 4003,
  /** Error getting stack trace */
  STACK_TRACE_ERROR = 4004,
  /** Error generating completions */
  COMPLETIONS_ERROR = 4005,

  // Memory errors (5000-5099)
  /** Failed to read memory */
  MEMORY_READ_ERROR = 5001,
  /** Failed to write memory */
  MEMORY_WRITE_ERROR = 5002,
  /** Failed to disassemble instructions */
  DISASSEMBLE_ERROR = 5003,

  // Breakpoint errors (6000-6099)
  /** Failed to set breakpoint */
  BREAKPOINT_SET_ERROR = 6001,
  /** Failed to remove breakpoint */
  BREAKPOINT_REMOVE_ERROR = 6002,
  /** Source location not found in debug symbols */
  SOURCE_LOCATION_ERROR = 6003,
}

/**
 * Debug adapter for Vamiga emulator that implements the Debug Adapter Protocol (DAP).
 * Provides debugging capabilities for Amiga programs running in the Vamiga emulator.
 *
 * Features:
 * - Source-level debugging with DWARF or Amiga hunk debug symbols
 * - Breakpoints, watchpoints, and exception breakpoints
 * - CPU register and custom chip register inspection
 * - Memory viewing and editing
 * - Disassembly view
 * - Expression evaluation with custom functions
 */
export class VamigaDebugAdapter extends LoggingDebugSession {
  private static THREAD_ID = 1;

  private vAmiga: VAmigaView;
  private parser: Parser;

  private trace = false;
  private fastLoad = false;
  private programPath = "";

  private isRunning = false;
  private stopOnEntry = false;
  private loadedProgram: LoadedProgram | null = null;
  private stepping = false;
  private lastStepGranularity: DebugProtocol.SteppingGranularity | undefined;

  private variableHandles = new Handles<string>();
  private locationHandles = new Handles<Location>();

  private hunks: Hunk[] = [];
  private dwarfData?: DWARFData;
  private sourceMap?: SourceMap;

  private sourceBreakpoints: Map<string, BreakpointRef[]> = new Map();
  private instructionBreakpoints: BreakpointRef[] = [];
  private exceptionBreakpoints: BreakpointRef[] = [];
  private dataBreakpoints: BreakpointRef[] = [];
  private functionBreakpoints: BreakpointRef[] = [];
  private tmpBreakpoints: TmpBreakpoint[] = [];
  private bpId = 0;

  private disposables: vscode.Disposable[] = [];

  // CPU state cache - only valid when emulator is stopped
  private cachedCpuInfo?: CpuInfo;
  private cachedCustomRegisters?: Record<string, { value: string }>;
  private cacheValid = false;

  /**
   * Creates a new VamigaDebugAdapter instance.
   *
   * Initializes the debug adapter with:
   * - Zero-based line and column numbering
   * - VAmiga emulator view for webview communication
   * - Expression parser with memory access functions
   */
  /**
   * Creates a new VamigaDebugAdapter instance.
   *
   * Initializes the debug adapter with:
   * - Zero-based line and column numbering
   * - VAmiga emulator view for webview communication
   * - Expression parser with memory access functions
   *
   * @param vAmiga Optional VAmigaView instance for dependency injection (primarily for testing)
   */
  public constructor(vAmiga?: VAmigaView) {
    super();
    this.setDebuggerLinesStartAt1(false);
    this.setDebuggerColumnsStartAt1(false);
    this.vAmiga =
      vAmiga || VAmigaView.getInstance(vscode.Uri.file(path.dirname(__dirname)));

    this.parser = new Parser();
    this.parser.functions = {
      u32,
      u16,
      u8,
      i32,
      i16,
      i8,
      peekU32: (addr: number) => this.vAmiga.peek32(addr),
      peekU16: (addr: number) => this.vAmiga.peek16(addr),
      peekU8: (addr: number) => this.vAmiga.peek8(addr),
      peekI32: (addr: number) => this.vAmiga.peek32(addr).then(i32),
      peekI16: (addr: number) => this.vAmiga.peek16(addr).then(i16),
      peekI8: (addr: number) => this.vAmiga.peek8(addr).then(i8),
      poke32: (addr: number, value: number) => this.vAmiga.poke32(addr, value),
      poke16: (addr: number, value: number) => this.vAmiga.poke16(addr, value),
      poke8: (addr: number, value: number) => this.vAmiga.poke8(addr, value),
    };
  }

  /**
   * Shuts down the debug adapter and cleans up resources.
   */
  public shutdown(): void {
    this.dispose();
  }

  /**
   * Disposes of all resources used by the debug adapter.
   * Cleans up event listeners and the VAmiga webview.
   */
  public dispose(): void {
    // Clean up fast-loaded program memory
    // if (this.loadedProgram) {
    //   const loader = new AmigaHunkLoader(this.vAmiga);
    //   loader.unloadProgram(this.loadedProgram).catch((err) => {
    //     logger.error("Failed to unload program: " + String(err));
    //   });
    //   this.loadedProgram = null;
    // }

    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }

  // Request handlers:

  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
  ): void {
    response.body = response.body || {};
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsSetVariable = true;
    response.body.supportsReadMemoryRequest = true;
    response.body.supportsWriteMemoryRequest = true;
    response.body.supportsDisassembleRequest = true;
    response.body.supportsInstructionBreakpoints = true;
    response.body.supportsDataBreakpoints = true;
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsHitConditionalBreakpoints = true;
    response.body.supportsEvaluateForHovers = true;
    response.body.supportsCompletionsRequest = true;
    response.body.supportsFunctionBreakpoints = true;

    response.body.exceptionBreakpointFilters = exceptionBreakpointFilters;

    this.sendResponse(response);
  }

  protected async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: LaunchRequestArguments,
  ) {
    // Validate the program path
    this.programPath = args.program;
    if (!this.programPath) {
      this.sendError(
        response,
        ErrorCode.PROGRAM_NOT_SPECIFIED,
        "program not specified",
      );
      this.sendEvent(new TerminatedEvent());
      return;
    }

    this.sendEvent(new OutputEvent(initOutput));

    // Initialize logger:
    logger.init((e) => this.sendEvent(e));
    logger.setup(args.trace ? LogLevel.Verbose : LogLevel.Warn);

    this.trace = args.trace ?? false;
    this.fastLoad = !!args.snapshot;

    const debugProgram = args.debugProgram || this.programPath;
    logger.log(`Reading debug symbols from ${debugProgram}`);

    // Read debug symbols:
    // We can support either Amiga hunks from vasm linedebug option, of elf files with dwarf data (must be a separate file).
    // Elf is useful to have compatibility with bartman's profiler in a single build.
    try {
      const buffer = await readFile(debugProgram);
      // Detect file format from extension
      // TODO: could check file header instead of extension
      if (debugProgram.match(/\.(elf|o)$/i)) {
        logger.log("Interpreting as dwarf data");
        this.dwarfData = parseDwarf(buffer);
      } else {
        logger.log("Interpreting as hunk data");
        this.hunks = parseHunks(buffer);
      }
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.DEBUG_SYMBOLS_READ_ERROR,
        "error reading debug symbols",
        err,
      );
    }

    try {
      logger.log(`Starting emulator with program ${this.programPath}`);

      if (args.snapshot && this.hunks) {
        // Use fast loading - inject program directly into memory
        logger.log("Using fast memory injection mode");

        // Start emulator with snapshot
        this.vAmiga.openFile(args.snapshot);
      } else {
        // Traditional loading via floppy disk emulation
        this.vAmiga.openFile(this.programPath);
      }

      // Add listeners to emulator
      const disposeDisposable = this.vAmiga.onDidDispose(() =>
        this.sendEvent(new TerminatedEvent()),
      );
      const messageDisposable = this.vAmiga.onDidReceiveMessage(
        async (message) => {
          try {
            await this.handleMessageFromEmulator(message);
          } catch (err) {
            console.error(err);
          }
        },
      );
      // Store disposables
      if (disposeDisposable) {
        this.disposables.push(disposeDisposable);
      }
      if (messageDisposable) {
        this.disposables.push(messageDisposable);
      }

      this.isRunning = true;
      this.stopOnEntry = args.stopOnEntry ?? false;
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.EMULATOR_START_ERROR,
        "Failed to start emulator",
        err,
      );
      this.sendEvent(new TerminatedEvent());
    }
  }

  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
  ): void {
    // All breakpoints etc are set by client now and we can continue...
    if (this.stopOnEntry && this.fastLoad) {
      // Fast load: send stop on entry event - we're already at this address
      const evt: DebugProtocol.StoppedEvent = new StoppedEvent(
        "entry",
        VamigaDebugAdapter.THREAD_ID,
      );
      evt.body.allThreadsStopped = true;
      this.sendEvent(evt);
    } else {
      // Resume emulator
      // even if stopOnEntry is set, we need to run to hit the temporary breakpoin in normal mode
      this.sendEvent(new OutputEvent(`Program started\n`));
      this.vAmiga.run();
    }
    this.sendResponse(response);
  }

  protected continueRequest(response: DebugProtocol.ContinueResponse): void {
    this.vAmiga.run();
    this.vAmiga.reveal();
    response.body = { allThreadsContinued: true };
    this.sendResponse(response);
  }

  protected pauseRequest(response: DebugProtocol.PauseResponse): void {
    this.vAmiga.pause();
    this.sendResponse(response);
  }

  protected disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
  ): void {
    this.dispose();
    this.sendEvent(new TerminatedEvent());
    this.sendResponse(response);
  }

  protected async threadsRequest(
    response: DebugProtocol.ThreadsResponse,
  ): Promise<void> {
    response.body = {
      threads: [new Thread(VamigaDebugAdapter.THREAD_ID, "Main")],
    };
    this.sendResponse(response);
  }

  protected async stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments,
  ): Promise<void> {
    const startFrame = args.startFrame ?? 0;
    const maxLevels = args.levels ?? 16;
    const endFrame = startFrame + maxLevels;

    try {
      const addresses = await this.guessStack(endFrame);

      let foundSource = false;

      // Now build stack frame response from addresses
      const stk = [];
      for (let i = startFrame; i < addresses.length && i < endFrame; i++) {
        const addr = addresses[i][0];
        if (this.sourceMap) {
          const loc = this.sourceMap.lookupAddress(addr);
          if (loc) {
            const frame = new StackFrame(
              0,
              this.formatAddress(addr),
              new Source(path.basename(loc.path), loc.path),
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
        const frame = new StackFrame(0, formatHex(addr));
        frame.instructionPointerReference = formatHex(addr);
        stk.push(frame);
      }

      response.body = {
        stackFrames: stk,
        totalFrames: stk.length,
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.STACK_TRACE_ERROR,
        "Error getting stack trace",
        err,
      );
    }
  }

  protected scopesRequest(response: DebugProtocol.ScopesResponse): void {
    const scopes = [
      new Scope(
        "CPU Registers",
        this.variableHandles.create("registers"),
        false,
      ),
      new Scope(
        "Custom Registers",
        this.variableHandles.create("custom"),
        false,
      ),
      new Scope("Vectors", this.variableHandles.create("vectors"), false),
    ];
    if (this.sourceMap) {
      scopes.push(
        new Scope("Symbols", this.variableHandles.create("symbols"), false),
        new Scope("Segments", this.variableHandles.create("segments"), false),
      );
    }
    response.body = { scopes };
    this.sendResponse(response);
  }

  protected async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
  ): Promise<void> {
    const id = this.variableHandles.get(args.variablesReference);
    let variables: DebugProtocol.Variable[] = [];

    const castIntVar = (value: number, fn: (v: number) => number) => ({
      name: fn.name,
      value: fn(value).toString(),
      variablesReference: 0,
      presentationHint: { attributes: ["readOnly"] },
    });

    try {
      if (id === "registers") {
        const info = await this.getCachedCpuInfo();
        variables = Object.keys(info)
          .map((name) => {
            let value = String(info[name as keyof CpuInfo]);
            let variablesReference = 0;
            let memoryReference: string | undefined;

            if (name === "sr") {
              variablesReference = this.variableHandles.create(`sr_flags`);
            } else if (name.startsWith("d")) {
              variablesReference = this.variableHandles.create(
                `data_reg_${name}`,
              );
            } else if (name.match(/(a[0-9]|pc|usp|msp|isp|vbr)/)) {
              variablesReference = this.variableHandles.create(
                `addr_reg_${name}`,
              );
              const numVal = Number(value);
              if (this.isValidAddress(numVal)) {
                memoryReference = value;
                value = this.formatAddress(numVal);
              }
            }

            return {
              name,
              value,
              variablesReference,
              memoryReference,
            };
          });
      } else if (id.startsWith("data_reg_")) {
        const info = await this.getCachedCpuInfo();
        const name = id.replace("data_reg_", "");
        const value = Number(info[name as keyof CpuInfo]);
        variables = [
          castIntVar(value, i32),
          castIntVar(value, u32),
          castIntVar(value, i16),
          castIntVar(value, u16),
          castIntVar(value, i8),
          castIntVar(value, u8),
        ];
      } else if (id.startsWith("addr_reg_")) {
        const info = await this.getCachedCpuInfo();
        const name = id.replace("addr_reg_", "");
        const value = Number(info[name as keyof CpuInfo]);
        variables = [
          castIntVar(value, i32),
          castIntVar(value, u32),
          castIntVar(value, i16),
          castIntVar(value, u16),
        ];
        const symbolOffset = this.sourceMap?.findSymbolOffset(value);
        if (symbolOffset) {
          let value = symbolOffset.symbol;
          if (symbolOffset.offset) {
            value += "+" + symbolOffset.offset;
          }
          variables.unshift({
            name: "offset",
            value,
            variablesReference: 0,
            presentationHint: { attributes: ["readOnly"] },
          });
        }
      } else if (id === "custom") {
        const info = await this.getCachedCustomRegisters();
        variables = Object.keys(info).map((name) => {
          let value = info[name].value;
          let memoryReference: string | undefined;
          // Handle longword values as addresses
          if  (value.length > 6) {
            memoryReference = value;
            value = this.formatAddress(Number(value));
          }
          return {
            name,
            value,
            variablesReference: 0,
            memoryReference,
          }
        });
      } else if (id === "sr_flags") {
        const info = await this.getCachedCpuInfo();
        const { boolFlags, interruptMask } = this.parseStatusRegister(
          Number(info.sr),
        );
        variables = [
          ...boolFlags.map(({ name, value }) => ({
            name,
            value: String(value),
            variablesReference: 0,
            presentationHint: { attributes: ["readOnly"] },
          })),
          {
            name: "interruptMask",
            value: formatBin(interruptMask),
            variablesReference: 0,
            presentationHint: { attributes: ["readOnly"] },
          },
        ];
      } else if (id === "vectors") {
        const cpuInfo = await this.getCachedCpuInfo();
        const mem = await this.vAmiga.readMemoryBuffer(
          Number(cpuInfo.vbr),
          vectors.length * 4,
        );
        for (let i = 0; i < vectors.length; i++) {
          const name = vectors[i];
          if (name) {
            const value = mem.readInt32BE(i * 4);
            variables.push({
              name: `${formatHex(i * 4, 2).replace("0x", "")}: ${name}`,
              value: this.formatAddress(value),
              memoryReference: formatHex(value),
              variablesReference: 0,
            });
          }
        }
      } else if (id === "symbols" && this.sourceMap) {
        const symbolLengths = this.sourceMap.getSymbolLengths();
        const symbols = this.sourceMap.getSymbols();
        variables = await Promise.all(
          Object.keys(symbols).map(
            async (name): Promise<DebugProtocol.Variable> => {
              let value = formatHex(symbols[name]);
              const length = symbolLengths?.[name] ?? 0;
              let variablesReference = 0;
              const memoryReference = value;

              if (length === 1 || length === 2 || length === 4) {
                let ptrVal: number;
                if (length === 4) {
                  ptrVal = await this.vAmiga.peek32(symbols[name]);
                } else if (length === 2) {
                  ptrVal = await this.vAmiga.peek16(symbols[name]);
                } else {
                  ptrVal = await this.vAmiga.peek8(symbols[name]);
                }
                if (length === 4) {
                  value += " -> " + this.formatAddress(ptrVal);
                } else {
                  value += " -> " + formatHex(ptrVal, length * 2);
                }
                variablesReference = this.variableHandles.create(
                  `symbol_ptr_${name}:${length}:${ptrVal}`,
                );
              }

              const variable: DebugProtocol.Variable = {
                name,
                value,
                memoryReference,
                presentationHint: { attributes: ["readOnly"] },
                variablesReference,
              };
              const loc = this.sourceMap?.lookupAddress(symbols[name]);
              if (loc) {
                variable.declarationLocationReference = loc
                  ? this.locationHandles.create(loc)
                  : undefined;
              }
              return variable;
            },
          ),
        );
      } else if (id.startsWith("symbol_ptr_")) {
        const [_name, lengthStr, valueStr] = id
          .replace("symbol_ptr_", "")
          .split(":");
        const length = Number(lengthStr);
        const value = Number(valueStr);

        if (length === 4) {
          variables = [castIntVar(value, u32), castIntVar(value, i32)];
        } else if (length === 2) {
          variables = [castIntVar(value, u16), castIntVar(value, i16)];
        } else {
          variables = [castIntVar(value, u8), castIntVar(value, i8)];
        }
      } else if (id === "segments" && this.sourceMap) {
        const segments = this.sourceMap.getSegmentsInfo();
        variables = segments.map((seg) => {
          const value = formatHex(seg.address);
          return {
            name: seg.name,
            value,
            memoryReference: value,
            variablesReference: 0,
            presentationHint: { attributes: ["readOnly"] },
          };
        });
      }
      response.body = {
        variables,
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.VARIABLE_READ_ERROR,
        `Error fetching variables ${id}`,
        err,
      );
    }
  }

  protected async setVariableRequest(
    response: DebugProtocol.SetVariableResponse,
    args: DebugProtocol.SetVariableArguments,
  ): Promise<void> {
    const id = this.variableHandles.get(args.variablesReference);
    const name = args.name;
    const value = Number(args.value);
    try {
      let res: any;
      if (id === "registers") {
        res = await this.vAmiga.setRegister(name, value);
      } else if (id === "custom") {
        res = await this.vAmiga.setCustomRegister(name, value);
      } else {
        throw new Error("Not writeable");
      }
      response.body = {
        value: res.value,
      };
      // Variable was changed, invalidate cache
      this.invalidateCache();
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.VARIABLE_UPDATE_ERROR,
        `Error updating variable ${name}`,
        err,
      );
    }
  }

  protected async stepInRequest(
    response: DebugProtocol.StepInResponse,
    args: DebugProtocol.StepInArguments,
  ): Promise<void> {
    try {
      this.stepping = true;
      this.isRunning = true;
      this.lastStepGranularity = args.granularity;
      this.vAmiga.stepInto();
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.STEP_ERROR,
        "Step operation failed",
        err,
      );
    }
  }

  protected async nextRequest(
    response: DebugProtocol.NextResponse,
  ): Promise<void> {
    try {
      // vAmiga's built-in stepOver doesn't work correctly. It seems to only work with short branches.
      // Need to implement this ourselves.

      // Disassemble at pc to get current and next instruction.
      const cpuInfo = await this.getCachedCpuInfo();
      const pc = Number(cpuInfo.pc);
      const disasm = await this.vAmiga.disassemble(pc, 2);
      const currInst = disasm?.instructions[0].instruction ?? "";
      const next = disasm?.instructions[1];

      // If current intruction is one of these i.e. it should eventually reach the next line,
      // set tmp breakpoint on next instruction, otherwise just use built-in stepInto.
      const isBranch = currInst.match(/^(jsr|bsr|dbra)/i);
      if (next && isBranch) {
        const addr = parseInt(next.addr, 16);
        this.setTmpBreakpoint(addr, "step");
        this.vAmiga.run();
      } else {
        this.stepping = true;
        this.vAmiga.stepInto();
      }
      this.isRunning = true;
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.STEP_ERROR,
        "Step operation failed",
        err,
      );
    }
  }

  protected async stepOutRequest(
    response: DebugProtocol.StepOutResponse,
  ): Promise<void> {
    try {
      // vAmiga has no stepOut function, as it doesn't track stack frames. We need to use our guessed stack list to set a tmp breakpoint.
      const stack = await this.guessStack();

      // stack 0 is pc
      if (stack[1]) {
        this.setTmpBreakpoint(stack[1][1], "step");
        this.isRunning = true;
        this.vAmiga.run();
      } else {
        this.stepping = true;
        this.isRunning = true;
        this.vAmiga.stepInto();
      }
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.STEP_ERROR,
        "Step operation failed",
        err,
      );
    }
  }

  protected async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ): Promise<void> {
    const path = args.source.path!;
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

    response.body = { breakpoints: [] };

    if (!this.sourceMap) {
      return this.sendError(
        response,
        ErrorCode.DEBUG_SYMBOLS_READ_ERROR,
        "Debug symbols not loaded",
      );
    }

    // Add new breakpoints
    for (const bp of args.breakpoints ?? []) {
      const address = this.sourceMap.lookupSourceLine(path, bp.line).address;
      const instructionReference = formatHex(address);
      const id = this.bpId++;
      refs.push({ id, address });

      let ignores = 0;
      if (bp.hitCondition) {
        ignores = (await this.evaluate(bp.hitCondition)).value ?? 0;
      }
      this.vAmiga.setBreakpoint(address, ignores);

      logger.log(
        `Breakpoint #${id} at ${path}:${bp.line} set at ${instructionReference}`,
      );
      response.body.breakpoints.push({
        id,
        instructionReference,
        verified: true,
        ...bp,
      });
    }
    this.sendResponse(response);
  }

  protected async setInstructionBreakpointsRequest(
    response: DebugProtocol.SetInstructionBreakpointsResponse,
    args: DebugProtocol.SetInstructionBreakpointsArguments,
  ): Promise<void> {
    // Remove existing
    for (const ref of this.instructionBreakpoints) {
      logger.log(
        `Instruction breakpoint #${ref.id} removed at ${formatHex(ref.address)}`,
      );
      this.vAmiga.removeBreakpoint(ref.address);
    }
    this.instructionBreakpoints = [];

    response.body = { breakpoints: [] };

    // Add new breakpoints
    for (const bp of args.breakpoints ?? []) {
      const address = Number(bp.instructionReference) + (bp.offset ?? 0);
      const id = this.bpId++;

      let ignores = 0;
      if (bp.hitCondition) {
        ignores = (await this.evaluate(bp.hitCondition)).value ?? 0;
      }
      this.instructionBreakpoints.push({ id, address });

      this.vAmiga.setBreakpoint(address, ignores);
      logger.log(
        `Instruction breakpoint #${id} set at ${bp.instructionReference}`,
      );
      response.body.breakpoints.push({
        id,
        verified: true,
        ...bp,
      });
    }
    this.sendResponse(response);
  }

  protected setFunctionBreakPointsRequest(
    response: DebugProtocol.SetFunctionBreakpointsResponse,
    args: DebugProtocol.SetFunctionBreakpointsArguments,
  ): void {
    // Remove existing
    for (const ref of this.functionBreakpoints) {
      logger.log(
        `Function breakpoint #${ref.id} removed at ${formatHex(ref.address)}`,
      );
      this.vAmiga.removeBreakpoint(ref.address);
    }
    this.functionBreakpoints = [];
    response.body = { breakpoints: [] };

    // Add new breakpoints
    for (const bp of args.breakpoints ?? []) {
      const id = this.bpId++;
      const address = this.sourceMap?.getSymbols()?.[bp.name];
      if (address) {
        const ignores =
          bp.hitCondition && isNumeric(bp.hitCondition)
            ? Number(bp.hitCondition)
            : 0;
        this.functionBreakpoints.push({ id, address });

        this.vAmiga.setBreakpoint(address, ignores);
        logger.log(
          `Function breakpoint #${id} set at ${address} for ${bp.name}`,
        );
      }
      response.body.breakpoints.push({
        id,
        verified: Boolean(address),
        ...bp,
      });
    }
    this.sendResponse(response);
  }

  protected dataBreakpointInfoRequest(
    response: DebugProtocol.DataBreakpointInfoResponse,
    args: DebugProtocol.DataBreakpointInfoArguments,
  ): void {
    // Handle variables that have memory references
    if (args.variablesReference) {
      const id = this.variableHandles.get(args.variablesReference);
      if (id === "registers" || id === "symbols") {
        // For registers and symbols, we can create data breakpoints
        const dataId = `${id}:${args.name}`;
        response.body = {
          dataId,
          description: `Watch ${args.name}`,
          accessTypes: ["readWrite"],
          canPersist: false,
        };
        this.sendResponse(response);
        return;
      }
    }

    // Handle memory references directly
    if (args.name && args.name.startsWith("0x")) {
      const address = parseInt(args.name, 16);
      if (!isNaN(address)) {
        const dataId = `memory:${args.name}`;
        response.body = {
          dataId,
          description: `Watch memory at ${args.name}`,
          accessTypes: ["readWrite"],
          canPersist: false,
        };
        this.sendResponse(response);
        return;
      }
    }

    // No data breakpoint available for this variable
    response.body = {
      dataId: null,
      description: "Data breakpoint not supported for this variable",
      accessTypes: [],
      canPersist: false,
    };
    this.sendResponse(response);
  }

  protected async setDataBreakpointsRequest(
    response: DebugProtocol.SetDataBreakpointsResponse,
    args: DebugProtocol.SetDataBreakpointsArguments,
  ): Promise<void> {
    logger.log(`Set data breakpoints request`);

    // Remove existing data breakpoints
    for (const ref of this.dataBreakpoints) {
      logger.log(
        `Data breakpoint #${ref.id} removed at ${formatHex(ref.address)}`,
      );
      this.vAmiga.removeWatchpoint(ref.address);
    }
    this.dataBreakpoints = [];

    response.body = { breakpoints: [] };

    // Add new data breakpoints
    for (const bp of args.breakpoints) {
      try {
        let address: number | undefined;
        const parts = bp.dataId.split(":");

        if (parts[0] === "memory") {
          // Direct memory address
          address = parseInt(parts[1], 16);
        } else if (parts[0] === "registers") {
          const cpuInfo = await this.getCachedCpuInfo();
          const value = cpuInfo[parts[1] as keyof CpuInfo];
          if (typeof value === "string") {
            address = Number(value);
          }
        } else if (parts[0] === "symbols" && this.sourceMap) {
          // Symbol address
          const symbols = this.sourceMap.getSymbols();
          address = symbols[parts[1]];
        }

        if (address !== undefined && !isNaN(address)) {
          const id = this.bpId++;
          const accessType = bp.accessType || "access";
          this.dataBreakpoints.push({ id, address });

          let ignores = 0;
          if (bp.hitCondition) {
            ignores = (await this.evaluate(bp.hitCondition)).value ?? 0;
          }
          this.vAmiga.setWatchpoint(address, ignores);

          logger.log(
            `Data breakpoint #${id} set at ${formatHex(address)} (${accessType})`,
          );

          response.body.breakpoints.push({
            id,
            verified: true,
          });
        } else {
          response.body.breakpoints.push({
            id: this.bpId++,
            verified: false,
            message: "Invalid memory address for data breakpoint",
          });
        }
      } catch (_) {
        response.body.breakpoints.push({
          id: this.bpId++,
          verified: false,
          message: `Error setting data breakpoint`,
        });
      }
    }

    this.sendResponse(response);
  }

  protected async evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments,
  ): Promise<void> {
    logger.log(`Evaluate request: ${args.expression}`);
    // 'watch' | 'repl' | 'hover' | 'clipboard' | 'variables' | string;
    const context = args.context;

    // Check for commands first in console
    if (context === "repl") {
      const [firstWord, ...cmdArgs] = args.expression
        .trim()
        .toLowerCase()
        .split(/\s+/g);
      if (["help", "?", "h"].includes(firstWord)) {
        if (cmdArgs[0] === "syntax") {
          this.sendEvent(new OutputEvent(syntaxText));
        } else if (cmdArgs[0] === "functions") {
          this.sendEvent(new OutputEvent(functionsText));
        } else {
          this.sendEvent(new OutputEvent(helpText));
        }
        this.sendResponse(response);
        return;
      }
    }

    try {
      const {
        value,
        memoryReference,
        type: resultType,
      } = await this.evaluate(args.expression);

      if (value !== undefined) {
        let result: string | undefined;
        let byteLength: number | undefined;
        let signed = false;

        // For hover context we can look at the source to determine how the value is used and get length/sign
        if (context === "hover" && args.source?.path && args.line) {
          try {
            const document = await vscode.workspace.openTextDocument(
              args.source.path,
            );
            const line = document.lineAt(args.line - 1);
            const attrs = instructionAttrs(line.text);
            signed = attrs.signed;
            byteLength = attrs.byteLength;
          } catch (err) {
            console.error(
              `Unable to fetch and parse source context: ${this.errorString(err)}`,
            );
          }
        }

        if (resultType === EvaluateResultType.ADDRESS_REGISTER) {
          result = this.formatAddress(value);
        } else if (resultType === EvaluateResultType.DATA_REGISTER) {
          let sizedValue: number;
          // Length from hover context
          if (byteLength === 1) {
            sizedValue = signed ? i8(value) : u8(value);
          } else if (byteLength === 2) {
            sizedValue = signed ? i16(value) : u16(value);
          } else {
            // default to longword
            sizedValue = signed ? i32(value) : u32(value);
            byteLength = 4;
          }
          result = formatHex(sizedValue, byteLength * 2) + " = " + sizedValue;
        } else if (resultType === EvaluateResultType.SYMBOL) {
          // longword address
          result = formatHex(value, 8);

          // Show value for b/w/l pointer
          // Get length from hover context or symbol lengths
          if (!byteLength) {
            const symbolLengths = this.sourceMap?.getSymbolLengths();
            byteLength = symbolLengths?.[args.expression] ?? 0;
          }

          if (byteLength === 1 || byteLength === 2 || byteLength === 4) {
            let ptrVal: number;
            if (byteLength === 4) {
              ptrVal = await this.vAmiga.peek32(value);
              if (signed) ptrVal = i32(ptrVal);
            } else if (byteLength === 2) {
              ptrVal = await this.vAmiga.peek16(value);
              if (signed) ptrVal = i16(ptrVal);
            } else {
              ptrVal = await this.vAmiga.peek8(value);
              if (signed) ptrVal = i8(ptrVal);
            }
            if (byteLength === 4) {
              result += " -> " + this.formatAddress(ptrVal);
            } else {
              result += " -> " + formatHex(ptrVal, byteLength * 2);
            }
          }
        } else if (resultType === EvaluateResultType.CUSTOM_REGISTER) {
          result = formatHex(value, 4);
        } else {
          // default - show result as hex and decimal
          result = formatHex(value, 0) + " = " + value;
        }
        response.body = {
          result,
          memoryReference,
          variablesReference: 0,
        };
      }

      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.EXPRESSION_EVALUATION_ERROR,
        `Error evaluating '${args.expression}'`,
        err,
      );
    }
  }

  protected async readMemoryRequest(
    response: DebugProtocol.ReadMemoryResponse,
    args: DebugProtocol.ReadMemoryArguments,
  ): Promise<void> {
    logger.log(
      `Read memory request: ${args.memoryReference}, offset: ${args.offset}, count: ${args.count}`,
    );
    try {
      const address = Number(args.memoryReference) + (args.offset || 0);
      const count = Math.min(4096, args.count);
      if (count) {
        const result = await this.vAmiga.readMemory(address, count);
        response.body = {
          address: result.address,
          data: result.data, // Already base64 encoded
          unreadableBytes: 0,
        };
      }
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.MEMORY_READ_ERROR,
        "Failed to read memory",
        err,
      );
    }
  }

  protected async writeMemoryRequest(
    response: DebugProtocol.WriteMemoryResponse,
    args: DebugProtocol.WriteMemoryArguments,
  ): Promise<void> {
    logger.log(
      `Write memory request: ${args.memoryReference}, offset: ${args.offset}`,
    );
    try {
      const address = Number(args.memoryReference) + (args.offset || 0);
      const result = await this.vAmiga.writeMemory(address, args.data); // Pass base64 data directly
      response.body = {
        offset: args.offset,
        bytesWritten:
          result.bytesWritten || Buffer.from(args.data, "base64").length,
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.MEMORY_WRITE_ERROR,
        "Failed to write memory",
        err,
      );
    }
  }

  protected async disassembleRequest(
    response: DebugProtocol.DisassembleResponse,
    args: DebugProtocol.DisassembleArguments,
  ): Promise<void> {
    logger.log(
      `Disassemble request: ${args.memoryReference}, instructionOffset: ${args.instructionOffset}, count: ${args.instructionCount}`,
    );
    try {
      const baseAddress = Number(args.memoryReference) + (args.offset ?? 0);
      const instructionOffset = args.instructionOffset ?? 0;
      const count = args.instructionCount;

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

      if (result.instructions) {
        // find the instruction containing the base address. We'll slice relative to this to get the requested range
        const startIndex = result.instructions.findIndex(
          (i) => parseInt(i.addr, 16) === baseAddress,
        );
        // If it's not there we're pretty screwed...
        if (startIndex === -1) {
          throw new Error("start instruction not found");
        }
        let realStart = startIndex + instructionOffset;

        // These are the instructions that will actually go in the response
        const includedInstructions: typeof result.instructions = [];

        // Pad with filler instructions to make up requested amount if start index is negative.
        if (realStart < 0) {
          for (let i = 0; i < -realStart; i++) {
            includedInstructions.push({
              addr: "0x00000000",
              instruction: "invalid",
              hex: "0000 0000",
            });
          }
          realStart = 0;
        }

        includedInstructions.push(
          ...result.instructions.slice(realStart, realStart + count),
        );

        const instructions: DebugProtocol.DisassembledInstruction[] =
          includedInstructions.map((instr: any) => {
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
                disasm.symbol = path.basename(loc.path) + ":" + loc.line;
                disasm.location = new Source(path.basename(loc.path), loc.path);
                disasm.line = loc.line;
              }
            }
            return disasm;
          });

        response.body = { instructions };
      } else {
        throw new Error("No instructions returned from disassembler");
      }
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.DISASSEMBLE_ERROR,
        "Failed to disassemble",
        err,
      );
    }
  }

  protected locationsRequest(
    response: DebugProtocol.LocationsResponse,
    args: DebugProtocol.LocationsArguments,
  ): void {
    try {
      const location = this.locationHandles.get(args.locationReference);
      if (location) {
        response.body = {
          source: new Source(path.basename(location.path), location.path),
          line: location.line,
        };
      }
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.DEBUG_SYMBOLS_READ_ERROR,
        "Failed to get location",
        err,
      );
    }
  }

  protected setExceptionBreakPointsRequest(
    response: DebugProtocol.SetExceptionBreakpointsResponse,
    args: DebugProtocol.SetExceptionBreakpointsArguments,
  ): void {
    for (const ref of this.exceptionBreakpoints) {
      this.vAmiga.removeCatchpoint(ref.address);
    }
    this.exceptionBreakpoints = [];

    const breakpoints: DebugProtocol.Breakpoint[] = [];
    for (const filter of args.filters) {
      const vector = Number(filter);
      const id = this.bpId++;
      this.vAmiga.setCatchpoint(vector);
      this.exceptionBreakpoints.push({ id, address: vector });
      breakpoints.push({ id, verified: true });
    }
    response.body = { breakpoints };
    this.sendResponse(response);
  }

  protected async completionsRequest(
    response: DebugProtocol.CompletionsResponse,
    args: DebugProtocol.CompletionsArguments,
  ): Promise<void> {
    try {
      response.body = { targets: [] };

      // Get the prefix part (what's before the cursor) for matching
      const beforeCursor = args.text.substring(0, args.column - 1);
      const beforeMatch = beforeCursor.match(/\b[a-zA-Z0-9_$]*$/);

      if (beforeMatch) {
        const prefix = beforeMatch[0];
        const vars = await this.getVars();
        const varMatches = Object.keys(vars).filter((name) =>
          name.toLowerCase().startsWith(prefix.toLowerCase()),
        );
        varMatches.forEach((varName) => {
          response.body.targets.push({
            label: varName,
            start: args.text.length - prefix.length + 1,
            length: prefix.length,
            type: "variable",
          });
        });

        const functionMatches = Object.keys(allFunctions).filter((name) =>
          name.toLowerCase().startsWith(prefix.toLowerCase()),
        );
        functionMatches.forEach((varName) => {
          response.body.targets.push({
            label: varName,
            text: varName + "()",
            detail: allFunctions[varName as keyof typeof allFunctions][1],
            selectionLength: 0,
            selectionStart: varName.length + 1,
            start: args.text.length - prefix.length + 1,
            length: prefix.length,
            type: "function",
          });
        });

        const commandMatches = Object.keys(consoleCommands).filter((name) =>
          name.toLowerCase().startsWith(prefix.toLowerCase()),
        );
        commandMatches.forEach((varName) => {
          response.body.targets.push({
            label: varName,
            detail: consoleCommands[varName as keyof typeof consoleCommands][1],
            start: args.text.length - prefix.length + 1,
            length: prefix.length,
            type: "keyword",
          });
        });
      }

      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.COMPLETIONS_ERROR,
        "Error generating completions",
        err,
      );
    }
  }

  // Helpers:

  /**
   * Handles messages received from the VAmiga emulator.
   *
   * Processes different message types:
   * - Attached messages: Sets up source mapping when emulator attaches to program
   * - State messages: Updates debug session state (running/paused/stopped)
   * - Output messages: Forwards emulator output to debug console
   *
   * @param message The message received from the emulator
   */

  private async handleMessageFromEmulator(message: EmulatorMessage) {
    logger.log(`Recieved message: ${message.type}`);

    if (isAttachedMessage(message)) {
      return this.attach(message.segments.map((s) => s.start));
    } else if (isEmulatorStateMessage(message)) {
      return this.updateState(message);
    } else if (isEmulatorOutputMessage(message)) {
      this.sendEvent(new OutputEvent(message.data + "\n"));
    } else if (isExecReadyMessage(message)) {
      if (this.fastLoad) {
        await this.injectProgram();
      }
    }
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
  private setTmpBreakpoint(address: number, reason: string) {
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
   * Finds a source breakpoint at the specified address.
   *
   * @param address Memory address to search for
   * @returns The breakpoint reference if found, undefined otherwise
   */
  private findSourceBreakpoint(address: number): BreakpointRef | undefined {
    for (const bps of this.sourceBreakpoints.values()) {
      const bpMatch = bps.find((bp) => bp.address === address);
      if (bpMatch) {
        return bpMatch;
      }
    }
  }

  private async injectProgram() {
    logger.log("Injecting program into memory");
    try {
      this.loadedProgram = await loadAmigaProgram(this.vAmiga, this.hunks);
      logger.log(
        `Program loaded at ${formatHex(this.loadedProgram.entryPoint)}`,
      );
      const offsets = this.loadedProgram.allocations.map((s) => s.address);
      this.attach(offsets);
    } catch (error) {
      this.sendEvent(
        new OutputEvent(
          `Fatal error during attach: ${this.errorString(error)}\n`,
          "stderr",
        ),
      );
    }
  }

  /**
   * Handles emulator attachment to a program.
   *
   * Sets up source mapping based on loaded segments and debug symbol format.
   * Creates source maps from either DWARF debug info or Amiga hunk debug data.
   * Sets entry breakpoint if stopOnEntry is enabled.
   */
  private attach(offsets: number[]) {
    if (this.stopOnEntry && !this.fastLoad) {
      this.setTmpBreakpoint(offsets[0], "entry");
    }
    try {
      if (this.dwarfData) {
        // Elf doesn't contain absolute path of sources. Assume it's one level up e.g. `out/a.elf`
        // TODO: find a better way to do this, add launch option, check files exist there
        const baseDir = path.dirname(path.dirname(this.programPath));
        this.sourceMap = sourceMapFromDwarf(this.dwarfData, offsets, baseDir);
      } else if (this.hunks) {
        this.sourceMap = sourceMapFromHunks(this.hunks, offsets);
      }
      this.sendEvent(new InitializedEvent());
    } catch (error) {
      this.sendEvent(
        new OutputEvent(
          `Fatal error during attach: ${this.errorString(error)}\n`,
          "stderr",
        ),
      );
      this.sendEvent(new TerminatedEvent());
    }
  }

  /**
   * Updates the debug session state based on emulator state changes.
   *
   * Handles transitions between running, paused, and stopped states.
   * Manages cache invalidation and sends appropriate events to VS Code.
   *
   * @param msg State message from the emulator
   */
  private async updateState(msg: EmulatorStateMessage) {
    const { state, message } = msg;
    logger.log(`State: ${state}, ${JSON.stringify(message)}`);
    if (state === "paused") {
      if (this.isRunning) {
        this.isRunning = false;
        this.invalidateCache(); // Cache needs refresh when emulator stops
        this.sendEvent(new StoppedEvent("pause", VamigaDebugAdapter.THREAD_ID));
      }
    } else if (state === "running") {
      if (!this.isRunning) {
        this.isRunning = true;
        this.invalidateCache(); // Invalidate cache when emulator starts running
        this.sendEvent(new ContinuedEvent(VamigaDebugAdapter.THREAD_ID));
      }
    } else if (state === "stopped") {
      if (this.stepping) {
        await this.handleStep();
      } else {
        this.handleStop(message);
      }
    }
  }

  /**
   * Handles completion of a step operation.
   *
   * Called when the emulator stops after a step-in operation.
   * Sets appropriate stop reason for disassembly view when no source is available.
   */
  private async handleStep() {
    // Special case for built-in stepIn function. No actual breakpoints used.
    this.isRunning = false;
    this.stepping = false;
    this.invalidateCache(); // Cache needs refresh when emulator stops
    const evt = new StoppedEvent("step", VamigaDebugAdapter.THREAD_ID);

    // Fake stop reason as 'instruction breakpoint' to allow selecting a stack frame with no source, and open disassembly
    // Don't need to do this for step with instruction granularity, as this is already handled
    // see: https://github.com/microsoft/vscode/pull/143649/files
    if (this.lastStepGranularity !== "instruction") {
      const cpuInfo = await this.getCachedCpuInfo();
      if (!this.sourceMap?.lookupAddress(Number(cpuInfo.pc))) {
        evt.body.reason = "instruction breakpoint";
      }
    }

    this.sendEvent(evt);
  }

  /**
   * Handles emulator stop events (breakpoints, watchpoints, exceptions).
   *
   * Determines the reason for stopping and matches it to the appropriate
   * breakpoint type. Handles temporary breakpoints specially.
   *
   * @param message Stop message containing stop details
   */
  private handleStop(message: StopMessage) {
    const evt: DebugProtocol.StoppedEvent = new StoppedEvent(
      "breakpoint",
      VamigaDebugAdapter.THREAD_ID,
    );
    evt.body.allThreadsStopped = true;

    this.isRunning = false;
    this.invalidateCache(); // Cache needs refresh when emulator stops

    let bpMatch: { id: number } | undefined;

    if (message.name === "WATCHPOINT_REACHED") {
      evt.body.reason = "data breakpoint";
      bpMatch = this.dataBreakpoints.find(
        (bp) => bp.address === message.payload.pc,
      );
    } else if (message.name === "CATCHPOINT_REACHED") {
      evt.body.reason = "exception";
      evt.body.text = exceptionBreakpointFilters.find(
        (f) => Number(f.filter) === message.payload.vector,
      )?.label;
      bpMatch = this.exceptionBreakpoints.find(
        (bp) => bp.address === message.payload.vector,
      );
    } else if (message.name === "BREAKPOINT_REACHED") {
      // First check tmp breakpoints
      const tmpMatch = this.tmpBreakpoints.find(
        (bp) => bp.address === message.payload.pc,
      );
      if (tmpMatch) {
        // Client doesn't know about tmp breakpoints - don't set hitBreakpointIds
        logger.log(`Matched tmp breakpoint at ${message.payload.pc}`);
        this.vAmiga.removeBreakpoint(tmpMatch.address);
        evt.body.reason = tmpMatch.reason;
        this.tmpBreakpoints = this.tmpBreakpoints.filter(
          (bp) => bp.address !== message.payload.pc,
        );
      } else {
        // check instruction breakpoints
        bpMatch = this.instructionBreakpoints.find(
          (bp) => bp.address === message.payload.pc,
        );
        if (bpMatch) {
          evt.body.reason = "instruction breakpoint";
        } else {
          // check function breakpoints
          bpMatch = this.functionBreakpoints.find(
            (bp) => bp.address === message.payload.pc,
          );
          if (bpMatch) {
            evt.body.reason = "function breakpoint";
          } else {
            // check source breakpoints
            bpMatch = this.findSourceBreakpoint(message.payload.pc);
          }
        }
      }
    }

    if (bpMatch) {
      evt.body.hitBreakpointIds = [bpMatch.id];
    }
    this.sendEvent(evt);
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
  protected async guessStack(maxLength = 16): Promise<[number, number][]> {
    const cpuInfo = await this.getCachedCpuInfo();

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
        this.isValidAddress(addr) &&
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

  /**
   * Formats a memory address with optional symbol information.
   *
   * If the address corresponds to a known symbol, includes the symbol name
   * and offset from the symbol start.
   *
   * @param address Memory address to format
   * @returns Formatted string like "0x00001234" or "0x00001234 = main+16"
   */
  /**
   * Formats a memory address with optional symbol information.
   *
   * Made protected to allow direct testing while keeping it internal to the class.
   *
   * @param address Memory address to format
   * @returns Formatted string like "0x00001234" or "0x00001234 = main+16"
   */
  protected formatAddress(address: number): string {
    let out = formatHex(address);
    const symbolOffset = this.sourceMap?.findSymbolOffset(address);
    if (symbolOffset) {
      out += " = " + symbolOffset.symbol;
      if (symbolOffset.offset) {
        out += "+" + symbolOffset.offset;
      }
    }
    return out;
  }

  /**
   * Converts an error to a string representation.
   *
   * @param err Error object or other value
   * @returns String representation, including stack trace if trace mode is enabled
   */
  private errorString(err: unknown): string {
    if (err instanceof Error) {
      return this.trace ? err.stack || err.message : err.message;
    }
    return String(err);
  }

  /**
   * Sends an error response back to VS Code.
   *
   * @param response The response object to populate with error information
   * @param errorId Categorized error code for the error type
   * @param message Human-readable error message
   * @param cause Optional underlying cause of the error
   */
  private sendError(
    response: DebugProtocol.Response,
    errorId: ErrorCode,
    message: string,
    cause?: unknown,
  ): void {
    const formattedCause = cause ? `: ${this.errorString(cause)}` : "";
    this.sendErrorResponse(response, {
      id: errorId,
      format: `${message}${formattedCause}`,
    });
  }

  /**
   * Invalidates the CPU state cache.
   *
   * Called when the emulator state changes to ensure fresh data is fetched.
   */
  private invalidateCache(): void {
    this.cacheValid = false;
    this.cachedCpuInfo = undefined;
    this.cachedCustomRegisters = undefined;
  }

  /**
   * Refreshes the CPU state cache if needed.
   *
   * Only fetches new data if cache is invalid and emulator is not running.
   */
  private async refreshCache(): Promise<void> {
    if (!this.cacheValid && !this.isRunning) {
      try {
        this.cachedCpuInfo = await this.vAmiga.getCpuInfo();
        this.cachedCustomRegisters = await this.vAmiga.getAllCustomRegisters();
        this.cacheValid = true;
      } catch (error) {
        // If cache refresh fails, leave cache invalid
        this.invalidateCache();
        throw error;
      }
    }
  }

  /**
   * Gets CPU information, using cache when emulator is stopped.
   *
   * @returns Current CPU register state and flags
   */
  private async getCachedCpuInfo(): Promise<CpuInfo> {
    if (this.isRunning) {
      // When running, always fetch fresh data
      return await this.vAmiga.getCpuInfo();
    }

    await this.refreshCache();
    return this.cachedCpuInfo!;
  }

  /**
   * Gets custom chip register information, using cache when emulator is stopped.
   *
   * @returns Current custom chip register values
   */
  private async getCachedCustomRegisters(): Promise<
    Record<string, { value: string }>
  > {
    if (this.isRunning) {
      // When running, always fetch fresh data
      return await this.vAmiga.getAllCustomRegisters();
    }

    await this.refreshCache();
    return this.cachedCustomRegisters!;
  }

  /**
   * Builds a complete variable lookup table for expression evaluation.
   *
   * Combines CPU registers, custom chip registers, and symbols into a single
   * namespace for the expression parser.
   *
   * @returns Record mapping variable names to their numeric values
   */
  /**
   * Builds a complete variable lookup table for expression evaluation.
   *
   * Made protected to allow testing of variable context building.
   *
   * @returns Record mapping variable names to their numeric values
   */
  protected async getVars() {
    const variables: Record<string, number> = {};
    const cpuInfo = await this.getCachedCpuInfo();
    const customRegs = await this.getCachedCustomRegisters();
    const symbols = this.sourceMap?.getSymbols() ?? {};
    for (const k in cpuInfo) {
      variables[k] = Number(cpuInfo[k as keyof CpuInfo]);
    }
    for (const k in customRegs) {
      variables[k] = Number(customRegs[k]);
    }
    for (const k in symbols) {
      variables[k] = Number(symbols[k]);
    }
    variables.sp = variables.a7;
    return variables;
  }

  /**
   * Evaluates an expression in the context of the current debug session.
   *
   * Supports:
   * - Numeric literals (decimal and hex)
   * - Memory dereferencing (0x1234 reads value at that address)
   * - CPU registers, custom registers, and symbols
   * - Complex expressions using the expr-eval parser
   * - Custom functions for memory access and type conversion
   *
   * @param expression The expression string to evaluate
   * @returns Evaluation result with value, type, and optional memory reference
   */
  /**
   * Evaluates an expression in the context of the current debug session.
   *
   * Made protected to allow direct testing while keeping it internal to the class.
   *
   * @param expression The expression string to evaluate
   * @returns Evaluation result with value, type, and optional memory reference
   */
  protected async evaluate(expression: string): Promise<EvaluateResult> {
    expression = expression.trim();
    if (expression === "") {
      return { type: EvaluateResultType.EMPTY };
    }
    let value: number | undefined;
    let memoryReference: string | undefined;
    let type = EvaluateResultType.UNKNOWN;

    if (expression.match(/^-?[0-9]+$/i)) {
      // Interpret decimal as numeric literal
      value = Number(expression);
    } else if (expression.match(/^0x[0-9a-f]+$/i)) {
      // Interpret hex as address:
      const address = Number(expression);
      // Read longword value at address
      // TODO: is this what we want? Support .w .b modifier?
      const memData = await this.vAmiga.readMemoryBuffer(address, 4);
      value = memData.readUInt32BE(0);
      memoryReference = formatHex(address);
    } else {
      const numVars = await this.getVars();

      if (expression in numVars) {
        // Exact match of variable
        value = numVars[expression];
        const cpuInfo = await this.getCachedCpuInfo();
        const customRegs = await this.getCachedCustomRegisters();
        const symbols = this.sourceMap?.getSymbols() ?? {};

        if (expression in symbols) {
          memoryReference = formatHex(value);
          type = EvaluateResultType.SYMBOL;
        } else if (expression in cpuInfo) {
          if (expression.match(/^(a[0-7]|pc|usp|msp|vbr)$/)) {
            type = EvaluateResultType.ADDRESS_REGISTER;
          } else {
            type = EvaluateResultType.DATA_REGISTER;
          }
        } else if (expression in customRegs) {
          type = EvaluateResultType.CUSTOM_REGISTER;
        }
      } else {
        // Complex expression
        const expr = this.parser.parse(expression);
        value = await expr.evaluate(numVars);
        type = EvaluateResultType.PARSED;
      }
    }
    return { value, memoryReference, type };
  }

  protected isValidAddress(address: number): boolean {
    // TODO: check memory layout
    // 24 bit address
    return address >= 0 && address < 0x1000_0000;
  }

  protected parseStatusRegister(sr: number) {
    // Extract individual CPU flags from status register (68000 format)
    const boolFlags = [
      { name: "carry", value: (sr & 0x0001) !== 0 }, // C flag (bit 0)
      { name: "overflow", value: (sr & 0x0002) !== 0 }, // V flag (bit 1)
      { name: "zero", value: (sr & 0x0004) !== 0 }, // Z flag (bit 2)
      { name: "negative", value: (sr & 0x0008) !== 0 }, // N flag (bit 3)
      { name: "extend", value: (sr & 0x0010) !== 0 }, // X flag (bit 4)
      { name: "trace1", value: (sr & 0x8000) !== 0 }, // T1 flag (bit 15)
      { name: "trace0", value: (sr & 0x4000) !== 0 }, // T0 flag (bit 14) - 68020+
      { name: "supervisor", value: (sr & 0x2000) !== 0 }, // S flag (bit 13)
      { name: "master", value: (sr & 0x1000) !== 0 }, // M flag (bit 12) - 68020+
    ];
    const interruptMask = (sr >> 8) & 0x07; // IPL (bits 8-10)
    return { boolFlags, interruptMask };
  }
}
