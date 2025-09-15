/* eslint-disable @typescript-eslint/no-explicit-any */

// TODO:
// - step on entry not working?
// - Console
// - Completions
// - Copper debugging
// - Change hex syntax? - or not?
// - Disassembly view panel - still needed?
// - data breakpoints from registers?

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
  AttachedMessage,
} from "./vAmigaView";
import { Hunk, parseHunks } from "./amigaHunkParser";
import { DWARFData, parseDwarf } from "./dwarfParser";
import { sourceMapFromDwarf } from "./dwarfSourceMap";
import { sourceMapFromHunks } from "./amigaHunkSourceMap";
import { Location, SourceMap } from "./sourceMap";
import { formatHex, isNumeric } from "./helpers";

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  program: string;
  debugProgram?: string | null;
  stopOnEntry?: boolean;
  trace?: boolean;
}

interface BreakpointRef {
  id: number;
  address: number;
}

interface DataBreakpointRef {
  id: number;
  address: number;
  accessType: string;
  dataId: string;
}

interface TmpBreakpoint {
  reason: string;
  address: number;
}

enum ErrorCode {
  // Launch/initialization errors (2000-2099)
  PROGRAM_NOT_SPECIFIED = 2001,
  DEBUG_SYMBOLS_READ_ERROR = 2002,
  EMULATOR_START_ERROR = 2003,

  // Runtime/execution errors (3000-3099)
  RPC_TIMEOUT = 3001,
  STEP_ERROR = 3002,
  CONTINUE_ERROR = 3003,
  PAUSE_ERROR = 3004,
  TERMINATE_ERROR = 3005,

  // Variable/expression errors (4000-4099)
  VARIABLE_READ_ERROR = 4001,
  VARIABLE_UPDATE_ERROR = 4002,
  EXPRESSION_EVALUATION_ERROR = 4003,
  STACK_TRACE_ERROR = 4004,

  // Memory errors (5000-5099)
  MEMORY_READ_ERROR = 5001,
  MEMORY_WRITE_ERROR = 5002,
  DISASSEMBLE_ERROR = 5003,

  // Breakpoint errors (6000-6099)
  BREAKPOINT_SET_ERROR = 6001,
  BREAKPOINT_REMOVE_ERROR = 6002,
  SOURCE_LOCATION_ERROR = 6003,
}

const exceptionBreakpointFilters: DebugProtocol.ExceptionBreakpointsFilter[] = [
  { filter: "0x8", label: "Bus error", default: true },
  { filter: "0xC", label: "Address error", default: true },
  { filter: "0x10", label: "Illegal instruction", default: true },
  { filter: "0x14", label: "Zero divide", default: true },
  // { filter: '0x18', label: 'CHK' },
  // { filter: '0x1C', label: 'TRAPV' },
  { filter: "0x20", label: "Privilege violation", default: true },
];

// What's your vector Victor?
export const vectors = [
  "Reset:SSP",
  "EXECBASE",
  "BUS ERROR",
  "ADR ERROR",
  "ILLEG OPC",
  "DIV BY 0",
  "CHK",
  "TRAPV",
  "PRIVIL VIO",
  "TRACE",
  "LINEA EMU",
  "LINEF EMU",
  null,
  null,
  null,
  "INT Uninit",
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  "INT Unjust",
  "Lvl 1 Int",
  "Lvl 2 Int",
  "Lvl 3 Int",
  "Lvl 4 Int",
  "Lvl 5 Int",
  "Lvl 6 Int",
  "NMI",
  "TRAP 00",
  "TRAP 01",
  "TRAP 02",
  "TRAP 03",
  "TRAP 04",
  "TRAP 05",
  "TRAP 06",
  "TRAP 07",
  "TRAP 08",
  "TRAP 09",
  "TRAP 10",
  "TRAP 11",
  "TRAP 12",
  "TRAP 13",
  "TRAP 14",
  "TRAP 15",
];

export class VamigaDebugAdapter extends LoggingDebugSession {
  private static THREAD_ID = 1;

  private vAmiga: VAmigaView;
  private parser: Parser;

  private trace = false;
  private programPath = "";

  private isRunning = false;
  private stopOnEntry = false;
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
  private dataBreakpoints: DataBreakpointRef[] = [];
  private tmpBreakpoints: TmpBreakpoint[] = [];
  private bpId = 0;

  private disposables: vscode.Disposable[] = [];

  // CPU state cache - only valid when emulator is stopped
  private cachedCpuInfo?: CpuInfo;
  private cachedCustomRegisters?: Record<string, { value: string }>;
  private cacheValid = false;

  public constructor() {
    super();
    this.setDebuggerLinesStartAt1(false);
    this.setDebuggerColumnsStartAt1(false);
    this.vAmiga = new VAmigaView(vscode.Uri.file(path.dirname(__dirname)));
    this.parser = new Parser();
  }

  public shutdown(): void {
    this.dispose();
  }

  public dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.vAmiga.dispose();
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
    response.body.supportsCompletionsRequest = false;

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

    // Initialize logger:
    logger.init((e) => this.sendEvent(e));
    logger.setup(args.trace ? LogLevel.Verbose : LogLevel.Warn);

    this.trace = args.trace ?? false;

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
      // Start the emulator with the specified file
      this.vAmiga.openFile(this.programPath);

      // Add listeners to emulator
      const disposeDisposable = this.vAmiga.onDidDispose(() =>
        this.sendEvent(new TerminatedEvent()),
      );
      const messageDisposable = this.vAmiga.onDidReceiveMessage((message) =>
        this.handleMessageFromEmulator(message),
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
    this.vAmiga.run();
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
    try {
      if (id === "registers") {
        const info = await this.getCachedCpuInfo();
        variables = Object.keys(info)
          .filter((k) => k !== "flags")
          .map((name) => {
            const value = String(info[name as keyof CpuInfo]);
            const v: DebugProtocol.Variable = {
              name,
              value,
              variablesReference:
                name === "sr" ? this.variableHandles.create(`sr_flags`) : 0,
            };
            // Limit to useful regs
            if (name.match(/(a[0-9]|pc|usp|msp|vbr)/)) {
              v.memoryReference = value;
              v.value = this.formatAddress(Number(value));
            }
            return v;
          });
      } else if (id === "custom") {
        const info = await this.getCachedCustomRegisters();
        variables = Object.keys(info).map((name) => ({
          name,
          value: info[name].value,
          variablesReference: 0,
        }));
      } else if (id === "sr_flags") {
        const info = await this.getCachedCpuInfo();
        const flags = info.flags;
        const presentationHint = {
          attributes: ["readOnly"],
        };
        variables = [
          {
            name: "carry",
            value: flags.carry ? "true" : "false",
            variablesReference: 0,
            presentationHint,
          },
          {
            name: "overflow",
            value: flags.overflow ? "true" : "false",
            variablesReference: 0,
            presentationHint,
          },
          {
            name: "zero",
            value: flags.zero ? "true" : "false",
            variablesReference: 0,
            presentationHint,
          },
          {
            name: "negative",
            value: flags.negative ? "true" : "false",
            variablesReference: 0,
            presentationHint,
          },
          {
            name: "extend",
            value: flags.extend ? "true" : "false",
            variablesReference: 0,
            presentationHint,
          },
          {
            name: "trace1",
            value: flags.trace1 ? "true" : "false",
            variablesReference: 0,
            presentationHint,
          },
          {
            name: "trace0",
            value: flags.trace0 ? "true" : "false",
            variablesReference: 0,
            presentationHint,
          },
          {
            name: "supervisor",
            value: flags.supervisor ? "true" : "false",
            variablesReference: 0,
            presentationHint,
          },
          {
            name: "master",
            value: flags.master ? "true" : "false",
            variablesReference: 0,
            presentationHint,
          },
          {
            name: "interrupt_mask",
            value: String(flags.interrupt_mask),
            variablesReference: 0,
            presentationHint,
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
        const symbols = this.sourceMap.getSymbols();
        variables = Object.keys(symbols).map((name): DebugProtocol.Variable => {
          const value = formatHex(symbols[name]);
          const variable: DebugProtocol.Variable = {
            name,
            value,
            memoryReference: value,
            presentationHint: {
              attributes: ["readOnly"],
            },
            variablesReference: 0,
          };
          const loc = this.sourceMap?.lookupAddress(symbols[name]);
          if (loc) {
            variable.declarationLocationReference = loc
              ? this.locationHandles.create(loc)
              : undefined;
          }
          return variable;
        });
      } else if (id === "segments" && this.sourceMap) {
        const segments = this.sourceMap.getSegmentsInfo();
        variables = segments.map((seg) => {
          const value = formatHex(seg.address);
          return {
            name: seg.name,
            value,
            memoryReference: value,
            variablesReference: 0,
            presentationHint: {
              attributes: ["readOnly"],
            },
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

  protected setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ): void {
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
      const { line, hitCondition } = bp;
      const id = this.bpId++;
      const ignores =
        hitCondition && isNumeric(hitCondition) ? Number(hitCondition) : 0;
      refs.push({ id, address });

      this.vAmiga.setBreakpoint(address, ignores);
      logger.log(
        `Breakpoint #${id} at ${path}:${line} set at ${instructionReference}`,
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

  protected setInstructionBreakpointsRequest(
    response: DebugProtocol.SetInstructionBreakpointsResponse,
    args: DebugProtocol.SetInstructionBreakpointsArguments,
  ): void {
    logger.log(`Set instruction breakpoints request`);
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
      const ignores =
        bp.hitCondition && isNumeric(bp.hitCondition)
          ? Number(bp.hitCondition)
          : 0;
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

  protected dataBreakpointInfoRequest(
    response: DebugProtocol.DataBreakpointInfoResponse,
    args: DebugProtocol.DataBreakpointInfoArguments,
  ): void {
    // Handle variables that have memory references
    if (args.variablesReference) {
      const id = this.variableHandles.get(args.variablesReference);
      if (id === "registers" || id === "custom" || id === "symbols") {
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

  protected setDataBreakpointsRequest(
    response: DebugProtocol.SetDataBreakpointsResponse,
    args: DebugProtocol.SetDataBreakpointsArguments,
  ): void {
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
        } else if (parts[0] === "registers" && this.sourceMap) {
          // CPU register - not directly watchable as memory
          response.body.breakpoints.push({
            id: this.bpId++,
            verified: false,
            message: "CPU registers cannot be watched as memory locations",
          });
          continue;
        } else if (parts[0] === "symbols" && this.sourceMap) {
          // Symbol address
          const symbols = this.sourceMap.getSymbols();
          address = symbols[parts[1]];
        } else if (parts[0] === "custom") {
          // Custom chip registers - not directly watchable as standard memory
          response.body.breakpoints.push({
            id: this.bpId++,
            verified: false,
            message: "Custom registers cannot be watched as memory locations",
          });
          continue;
        }

        if (address !== undefined && !isNaN(address)) {
          const id = this.bpId++;
          const accessType = bp.accessType || "write";
          const ignores =
            bp.hitCondition && isNumeric(bp.hitCondition)
              ? Number(bp.hitCondition)
              : 0;

          this.dataBreakpoints.push({
            id,
            address,
            accessType,
            dataId: bp.dataId,
          });
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

    const numVars: Record<string, number> = {};
    const cpuInfo = await this.getCachedCpuInfo();
    const customRegs = await this.getCachedCustomRegisters();
    const symbols = this.sourceMap?.getSymbols() ?? {};
    for (const k in cpuInfo) {
      if (k !== "flags") {
        numVars[k] = Number(cpuInfo[k as keyof CpuInfo]);
      }
    }
    for (const k in customRegs) {
      numVars[k] = Number(customRegs[k]);
    }
    for (const k in symbols) {
      numVars[k] = Number(symbols[k]);
    }
    numVars.sp = numVars.a7;

    try {
      const expression = args.expression.trim();
      let value: number | undefined;
      let memoryReference: string | undefined;

      if (expression.match(/^0x[0-9a-f]+$/i)) {
        // Address hex:
        const address = Number(expression);
        // Read longword value at address
        // TODO: is this what we want? Support .w .b modifier?
        const memData = await this.vAmiga.readMemoryBuffer(address, 4);
        value = memData.readUInt32BE(0);
        memoryReference = formatHex(address);
      } else {
        if (expression in numVars) {
          // Exact match of variable
          value = numVars[expression];
          if (expression in symbols) {
            memoryReference = formatHex(value);
          }
        } else {
          // Complex expression
          const expr = this.parser.parse(expression);
          value = expr.evaluate(numVars);
        }
      }

      if (value !== undefined) {
        let result: string | undefined;
        // format as address?
        if (expression.match(/^(a[0-7]|pc|usp|msp|vbr)$/)) {
          result = this.formatAddress(value);
        } else {
          result = formatHex(value);
        }
        response.body = {
          result,
          type: "number",
          memoryReference,
          variablesReference: 0,
        };
      } else {
        throw new Error(`Failed to evaluate: ${expression}`);
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

  // Helpers:

  private handleMessageFromEmulator(message: EmulatorMessage) {
    logger.log(`Recieved message: ${message.type}`);

    if (isAttachedMessage(message)) {
      return this.attach(message);
    } else if (isEmulatorStateMessage(message)) {
      return this.updateState(message);
    } else if (isEmulatorOutputMessage(message)) {
      this.sendEvent(new OutputEvent(message.data + "\n"));
    }
  }

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

  private findSourceBreakpoint(address: number): BreakpointRef | undefined {
    for (const bps of this.sourceBreakpoints.values()) {
      const bpMatch = bps.find((bp) => bp.address === address);
      if (bpMatch) {
        return bpMatch;
      }
    }
  }

  private attach({ segments }: AttachedMessage) {
    const offsets = segments.map((s) => s.start);
    if (this.stopOnEntry) {
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
      } else {
        const evt: DebugProtocol.StoppedEvent = new StoppedEvent(
          "breakpoint",
          VamigaDebugAdapter.THREAD_ID,
        );
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
              // check source breakpoints
              bpMatch = this.findSourceBreakpoint(message.payload.pc);
            }
          }
        }

        if (bpMatch) {
          evt.body.hitBreakpointIds = [bpMatch.id];
        }
        this.sendEvent(evt);
      }
    }
  }

  /**
   * Guess stack frames by looking at stack memory.
   *
   * @param maxLength
   * @returns [jmp address, return address]
   */
  private async guessStack(maxLength = 16): Promise<[number, number][]> {
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
      // TODO: more ways to validate address early e.g. valid range?
      if (
        addr > 0 && // non-zero address
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
   * Find the offset from the previous label in source for a given address
   *
   * @param address
   * @returns
   */
  private labelOffset(
    address: number,
  ): { label: string; offset: number } | undefined {
    if (!this.sourceMap) {
      return;
    }

    // Find which segment (if any) address is in
    const segments = this.sourceMap.getSegmentsInfo();
    const findSeg = (addr: number) =>
      segments.find((s) => s.address <= addr && s.address + s.size > addr);
    const segId = findSeg(address);
    // Only care about addresses in our source map
    if (segId === undefined) {
      return;
    }

    let ret: { label: string; offset: number } | undefined;
    const symbols = this.sourceMap.getSymbols();
    for (const label in symbols) {
      const symAddr = symbols[label];
      const offset = address - symAddr;
      // Address is after label and in same segment
      if (offset >= 0 && segId === findSeg(symAddr)) {
        ret = { label, offset };
      }
    }
    return ret;
  }

  private formatAddress(address: number): string {
    let out = formatHex(address);
    const labelOffset = this.labelOffset(address);
    if (labelOffset) {
      out += " " + labelOffset.label;
      if (labelOffset.offset) {
        out += "+" + labelOffset.offset;
      }
    }
    return out;
  }

  private errorString(err: unknown): string {
    if (err instanceof Error) {
      return this.trace ? err.stack || err.message : err.message;
    }
    return String(err);
  }

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

  private invalidateCache(): void {
    this.cacheValid = false;
    this.cachedCpuInfo = undefined;
    this.cachedCustomRegisters = undefined;
  }

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

  private async getCachedCpuInfo(): Promise<CpuInfo> {
    if (this.isRunning) {
      // When running, always fetch fresh data
      return await this.vAmiga.getCpuInfo();
    }

    await this.refreshCache();
    return this.cachedCpuInfo!;
  }

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
}
