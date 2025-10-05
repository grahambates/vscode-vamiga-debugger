// TODO: bugs
// - bp ignores not working - implemented in vamiga?
// - step on first instruction in non-fast mode
// TODO: features
// - memory viewer
// - Variable display ordering - alpha or address for custom, symbols
// - trace
// - memory to disk?
// - beamtraps?
// - Constants/symbols browser in variables view
// - Copper debugging support
// - Custom register offset prefix display
// - Profiler
// - Control warp from Amiga
// - conditional breakpoints

import {
  logger,
  LoggingDebugSession,
  InitializedEvent,
  TerminatedEvent,
  StoppedEvent,
  ContinuedEvent,
  OutputEvent,
  Thread,
  Source,
} from "@vscode/debugadapter";
import { LogLevel } from "@vscode/debugadapter/lib/logger";
import { DebugProtocol } from "@vscode/debugprotocol";
import * as vscode from "vscode";
import * as path from "path";
import { readFile } from "fs/promises";

import {
  VAmiga,
  EmulatorMessage,
  isAttachedMessage,
  isEmulatorStateMessage,
  isEmulatorOutputMessage,
  EmulatorStateMessage,
  StopMessage,
  isExecReadyMessage,
  OpenOptions,
} from "./vAmiga";
import { Hunk, parseHunks } from "./amigaHunkParser";
import { DWARFData, parseDwarf } from "./dwarfParser";
import { loadAmigaProgram } from "./amigaHunkLoader";
import { LoadedProgram } from "./amigaMemoryMapper";
import { sourceMapFromDwarf } from "./dwarfSourceMap";
import { sourceMapFromHunks } from "./amigaHunkSourceMap";
import { SourceMap } from "./sourceMap";
import { formatHex } from "./numbers";
import {
  allFunctions,
  consoleCommands,
  functionsText,
  helpText,
  initOutput,
  syntaxText,
} from "./repl";
import { exceptionBreakpointFilters } from "./hardware";
import { VariablesManager } from "./variablesManager";
import { BreakpointManager } from "./breakpointManager";
import { StackManager } from "./stackManager";
import { DisassemblyManager } from "./disassemblyManager";
import { EvaluateManager } from "./evaluateManager";

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
  /** Inject program directly into memory */
  fastLoad?: boolean;
  /** Options to pass when opening vAmiga */
  emulatorOptions?: Exclude<OpenOptions, "programPath">;
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
  /** Error getting breakpoint info */
  BREAKPOINT_INFO_ERROR = 6004,
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
  private static activeAdapter?: VamigaDebugAdapter;

  private trace = false;
  private fastLoad = false;
  private programPath = "";

  private isRunning = false;
  private stopOnEntry = false;
  private loadedProgram: LoadedProgram | null = null;
  private stepping = false;
  private lastStepGranularity: DebugProtocol.SteppingGranularity | undefined;

  private variablesManager?: VariablesManager;
  private breakpointManager?: BreakpointManager;
  private stackManager?: StackManager;
  private disassemblyManager?: DisassemblyManager;
  private evaluateManager?: EvaluateManager;

  private hunks: Hunk[] = [];
  private dwarfData?: DWARFData;
  private sourceMap?: SourceMap;

  private disposables: (vscode.Disposable | undefined)[] = [];

  /**
   * Gets the currently active debug adapter instance.
   * Returns undefined if no debug session is active.
   */
  public static getActiveAdapter(): VamigaDebugAdapter | undefined {
    return VamigaDebugAdapter.activeAdapter;
  }

  /**
   * Creates a new VamigaDebugAdapter instance.
   *
   * Initializes the debug adapter with:
   * - Zero-based line and column numbering
   * - VAmiga emulator interface for program execution and debugging
   * - Manager classes for evaluation, variables, breakpoints, etc.
   *
   * @param vAmiga VAmiga instance for dependency injection (primarily for testing)
   */
  public constructor(private vAmiga: VAmiga) {
    super();
    this.setDebuggerLinesStartAt1(false);
    this.setDebuggerColumnsStartAt1(false);
  }

  /**
   * Shuts down the debug adapter and cleans up resources.
   */
  public shutdown(): void {
    this.dispose();
  }

  /**
   * Disposes of all resources used by the debug adapter.
   */
  public dispose(): void {
    // Clear active adapter if this was the active one
    if (VamigaDebugAdapter.activeAdapter === this) {
      VamigaDebugAdapter.activeAdapter = undefined;
    }
    this.vAmiga.run(); // unpause emulator if we're leaving it open
    this.breakpointManager?.clearAll();
    this.disposables.forEach((d) => d?.dispose());
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
    response.body.supportsStepBack = true;

    response.body.exceptionBreakpointFilters = exceptionBreakpointFilters;

    this.sendResponse(response);
  }

  protected async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: LaunchRequestArguments,
  ) {
    // Register this as the active adapter
    VamigaDebugAdapter.activeAdapter = this;

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
    this.fastLoad = args.fastLoad ?? false;

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

      if (this.fastLoad) {
        // Use fast loading - inject program directly into memory
        logger.log("Using fast memory injection mode");
        // Start emulator with no program
        this.vAmiga.open(args.emulatorOptions);
      } else {
        // Traditional loading via floppy disk emulation
        this.vAmiga.open({
          programPath: this.programPath,
          ...args.emulatorOptions,
        });
      }

      // Add listeners to emulator
      this.disposables.push(
        this.vAmiga.onDidDispose(() => this.sendEvent(new TerminatedEvent())),
      );
      this.disposables.push(
        this.vAmiga.onDidReceiveMessage(async (message) => {
          try {
            await this.handleMessageFromEmulator(message);
          } catch (err) {
            console.error(
              `Error while processing ${message.type} message:`,
              err,
            );
            this.sendEvent(
              new OutputEvent(
                `Error while processing ${message.type} message: ${this.errorString(err)}\n`,
                "stderr",
              ),
            );
            this.sendEvent(new TerminatedEvent());
          }
        }),
      );

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

    try {
      const stk = await this.getStackManager().getStackFrames(
        startFrame,
        maxLevels,
      );
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
    const scopes = this.variablesManager?.getScopes() ?? [];
    response.body = { scopes };
    this.sendResponse(response);
  }

  protected async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
  ): Promise<void> {
    try {
      // VariablesManager now handles all variable references including arrays from EvaluateManager
      const variables = await this.getVariablesManager().getVariables(
        args.variablesReference,
      );

      response.body = { variables };
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.VARIABLE_READ_ERROR,
        `Error fetching variables`,
        err,
      );
    }
  }

  protected async setVariableRequest(
    response: DebugProtocol.SetVariableResponse,
    args: DebugProtocol.SetVariableArguments,
  ): Promise<void> {
    try {
      const value = await this.getVariablesManager().setVariable(
        args.variablesReference,
        args.name,
        Number(args.value),
      );
      response.body = { value };
      this.sendResponse(response);
    } catch (err) {
      this.sendError(
        response,
        ErrorCode.VARIABLE_UPDATE_ERROR,
        `Error updating variable`,
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
      const cpuInfo = await this.vAmiga.getCpuInfo();
      const pc = Number(cpuInfo.pc);
      const disasm = await this.vAmiga.disassemble(pc, 2);
      const currInst = disasm?.instructions[0].instruction ?? "";
      const next = disasm?.instructions[1];

      // If current intruction is one of these i.e. it should eventually reach the next line,
      // set tmp breakpoint on next instruction, otherwise just use built-in stepInto.
      const isBranch = currInst.match(/^(jsr|bsr|dbra)/i);
      if (next && isBranch) {
        const addr = parseInt(next.addr, 16);
        this.getBreakpointManager().setTmpBreakpoint(addr, "step");
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
      const stack = await this.getStackManager().guessStack();

      // stack 0 is pc
      if (stack[1]) {
        this.getBreakpointManager().setTmpBreakpoint(stack[1][1], "step");
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

  protected async stepBackRequest(
    response: DebugProtocol.StepBackResponse,
  ): Promise<void> {
    try {
      await this.vAmiga.stepBack();
      this.sendEvent(new StoppedEvent("step", VamigaDebugAdapter.THREAD_ID));
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

  protected async reverseContinueRequest(
    response: DebugProtocol.ReverseContinueResponse,
  ): Promise<void> {
    try {
      await this.vAmiga.continueReverse();
      this.sendEvent(new StoppedEvent("step", VamigaDebugAdapter.THREAD_ID));
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
    try {
      const path = args.source.path!;
      const breakpoints =
        await this.getBreakpointManager().setSourceBreakpoints(
          path,
          args.breakpoints ?? [],
        );

      response.body = { breakpoints };
      this.sendResponse(response);
    } catch (err) {
      return this.sendError(
        response,
        ErrorCode.BREAKPOINT_SET_ERROR,
        `Error setting breakpoint`,
        err,
      );
    }
  }

  protected async setInstructionBreakpointsRequest(
    response: DebugProtocol.SetInstructionBreakpointsResponse,
    args: DebugProtocol.SetInstructionBreakpointsArguments,
  ): Promise<void> {
    try {
      const breakpoints =
        await this.getBreakpointManager().setInstructionBreakpoints(
          args.breakpoints ?? [],
        );

      response.body = { breakpoints };
      this.sendResponse(response);
    } catch (err) {
      return this.sendError(
        response,
        ErrorCode.BREAKPOINT_SET_ERROR,
        `Error setting breakpoint`,
        err,
      );
    }
  }

  protected setFunctionBreakPointsRequest(
    response: DebugProtocol.SetFunctionBreakpointsResponse,
    args: DebugProtocol.SetFunctionBreakpointsArguments,
  ): void {
    try {
      const breakpoints = this.getBreakpointManager().setFunctionBreakpoints(
        args.breakpoints ?? [],
      );

      response.body = { breakpoints };
      this.sendResponse(response);
    } catch (err) {
      return this.sendError(
        response,
        ErrorCode.BREAKPOINT_SET_ERROR,
        `Error setting breakpoint`,
        err,
      );
    }
  }

  protected dataBreakpointInfoRequest(
    response: DebugProtocol.DataBreakpointInfoResponse,
    args: DebugProtocol.DataBreakpointInfoArguments,
  ): void {
    try {
      // Handle variables that have memory references
      // TODO: handle expressions as args.name, and args.asAddress
      if (args.variablesReference) {
        const id = this.getVariablesManager().getVariableReference(
          args.variablesReference,
        );
        // Only string IDs support data breakpoints (not array values)
        if (typeof id === "string") {
          const result = this.getBreakpointManager().getDataBreakpointInfo(
            id,
            args.name,
          );
          if (result) {
            response.body = result;
            this.sendResponse(response);
            return;
          }
        }
      }

      response.body = {
        dataId: null,
        description: "Data breakpoint not supported for this variable",
      };
      this.sendResponse(response);
    } catch (err) {
      return this.sendError(
        response,
        ErrorCode.BREAKPOINT_INFO_ERROR,
        `Error getting breakpoint info`,
        err,
      );
    }
  }

  protected async setDataBreakpointsRequest(
    response: DebugProtocol.SetDataBreakpointsResponse,
    args: DebugProtocol.SetDataBreakpointsArguments,
  ): Promise<void> {
    try {
      const breakpoints = await this.getBreakpointManager().setDataBreakpoints(
        args.breakpoints,
      );

      response.body = { breakpoints };
      this.sendResponse(response);
    } catch (err) {
      return this.sendError(
        response,
        ErrorCode.BREAKPOINT_SET_ERROR,
        `Error setting breakpoint`,
        err,
      );
    }
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

      // Help command:
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
      response.body = await this.getEvaluateManager().evaluateFormatted(args);
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
          address: formatHex(address),
          data: result.toString("base64"),
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
      const buf = Buffer.from(args.data, "base64");
      await this.vAmiga.writeMemory(address, buf); // Pass base64 data directly
      response.body = {
        offset: args.offset,
        bytesWritten: buf.length,
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
      const instructions = await this.getDisassemblyManager().disassemble(
        baseAddress,
        instructionOffset,
        count,
      );
      response.body = { instructions };
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
      const location = this.getVariablesManager().getLocationReference(
        args.locationReference,
      );
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
    try {
      const breakpoints = this.getBreakpointManager().setExceptionBreakpoints(
        args.filters,
      );

      response.body = { breakpoints };
      this.sendResponse(response);
    } catch (err) {
      return this.sendError(
        response,
        ErrorCode.BREAKPOINT_SET_ERROR,
        `Error setting exception breakpoint`,
        err,
      );
    }
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
        const vars = await this.getVariablesManager().getFlatVariables();
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
   * Injects the program into emulator memory for fast loading.
   *
   * Uses the AmigaHunkLoader to load the program directly into memory
   * without requiring floppy disk emulation. Sets up memory segments
   * and calls attach() with the loaded program offsets.
   */
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
    try {
      if (this.dwarfData) {
        // Elf doesn't contain absolute path of sources. Assume it's one level up e.g. `out/a.elf`
        // TODO: find a better way to do this, add launch option, check files exist there
        const baseDir = path.dirname(path.dirname(this.programPath));
        this.sourceMap = sourceMapFromDwarf(this.dwarfData, offsets, baseDir);
      } else if (this.hunks) {
        this.sourceMap = sourceMapFromHunks(this.hunks, offsets);
      } else {
        throw new Error("No debug symbols");
      }

      // Initialize specialized manager classes for debugging functionality:
      this.variablesManager = new VariablesManager(this.vAmiga, this.sourceMap);
      this.breakpointManager = new BreakpointManager(
        this.vAmiga,
        this.sourceMap,
      );
      this.stackManager = new StackManager(this.vAmiga, this.sourceMap);
      this.disassemblyManager = new DisassemblyManager(
        this.vAmiga,
        this.sourceMap,
      );
      this.evaluateManager = new EvaluateManager(
        this.vAmiga,
        this.sourceMap,
        this.variablesManager,
        this.disassemblyManager,
      );

      if (this.stopOnEntry && !this.fastLoad) {
        this.breakpointManager.setTmpBreakpoint(offsets[0], "entry");
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
        this.sendEvent(new StoppedEvent("pause", VamigaDebugAdapter.THREAD_ID));
      }
    } else if (state === "running") {
      if (!this.isRunning) {
        this.isRunning = true;
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
    const evt = new StoppedEvent("step", VamigaDebugAdapter.THREAD_ID);

    // Fake stop reason as 'instruction breakpoint' to allow selecting a stack frame with no source, and open disassembly
    // Don't need to do this for step with instruction granularity, as this is already handled
    // see: https://github.com/microsoft/vscode/pull/143649/files
    if (this.lastStepGranularity !== "instruction") {
      try {
        const cpuInfo = await this.vAmiga.getCpuInfo();
        if (!this.sourceMap?.lookupAddress(Number(cpuInfo.pc))) {
          evt.body.reason = "instruction breakpoint";
        }
      } catch (error) {
        // If we can't get CPU info, still send the step event to avoid hanging the debugger
        console.warn(
          "Failed to get CPU info during step, defaulting to step reason:",
          error,
        );
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

    if (!this.breakpointManager) {
      this.sendEvent(evt);
      return;
    }

    const result = this.breakpointManager.handleBreakpointStop(message);
    evt.body.reason = result.reason;
    if (result.text) {
      evt.body.text = result.text;
    }
    if (result.hitBreakpointIds) {
      evt.body.hitBreakpointIds = result.hitBreakpointIds;
    }

    this.sendEvent(evt);
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

  public getStackManager(): StackManager {
    if (!this.stackManager) {
      throw new Error("Not initialized");
    }
    return this.stackManager;
  }

  public getBreakpointManager(): BreakpointManager {
    if (!this.breakpointManager) {
      throw new Error("Not initialized");
    }
    return this.breakpointManager;
  }

  public getVariablesManager(): VariablesManager {
    if (!this.variablesManager) {
      throw new Error("Not initialized");
    }
    return this.variablesManager;
  }

  public getDisassemblyManager(): DisassemblyManager {
    if (!this.disassemblyManager) {
      throw new Error("Not initialized");
    }
    return this.disassemblyManager;
  }

  public getEvaluateManager(): EvaluateManager {
    if (!this.evaluateManager) {
      throw new Error("Not initialized");
    }
    return this.evaluateManager;
  }

  public getSourceMap(): SourceMap {
    if (!this.sourceMap) {
      throw new Error("Not initialized");
    }
    return this.sourceMap;
  }
}
