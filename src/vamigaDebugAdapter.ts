/* eslint-disable @typescript-eslint/no-explicit-any */

// TODO:
// - Focus issue
// - Disassembly view panel
// - Watchpoints
// - Evaluate
// - Console
// - Change hex syntax?
// - Copper debugging
// BUGS:
// - disassembly current line

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

import { VAmigaView, CpuInfo } from "./vAmigaView";
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

interface Segment {
  start: number;
  size: number;
}

interface BreakpointRef {
  id: number;
  address: number;
}

interface TmpBreakpoint {
  reason: string;
  address: number;
}

// Error ID categories
const ERROR_IDS = {
  // Launch/initialization errors (2000-2099)
  PROGRAM_NOT_SPECIFIED: 2001,
  DEBUG_SYMBOLS_READ_ERROR: 2002,
  EMULATOR_START_ERROR: 2003,
  // Runtime errors (3000-3099)
  RPC_TIMEOUT: 3001,
  VARIABLE_UPDATE_ERROR: 3002,
  STEP_ERROR: 3003,

  // Memory errors (4000-4099)
  MEMORY_READ_ERROR: 4001,
  MEMORY_WRITE_ERROR: 4002,
  DISASSEMBLE_ERROR: 4003,

  // Stack trace errors (5000-5099)
  STACK_TRACE_ERROR: 5001,
} as const;

const exceptionBreakpointFilters: DebugProtocol.ExceptionBreakpointsFilter[] = [
  { filter: "0x8", label: "Bus error", default: true },
  { filter: "0xC", label: "Address error", default: true },
  { filter: "0x10", label: "Illegal instruction", default: true },
  { filter: "0x14", label: "Zero divide", default: true },
  // { filter: '0x18', label: 'CHK' },
  // { filter: '0x1C', label: 'TRAPV' },
  { filter: "0x20", label: "Privilege violation", default: true },
];

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
  private variableHandles = new Handles<string>();
  private locationHandles = new Handles<Location>();
  private isRunning = false;
  private stopOnEntry = false;
  private programPath = "";
  private vAmiga: VAmigaView;
  private hunks: Hunk[] = [];
  private dwarfData?: DWARFData;
  private sourceMap?: SourceMap;
  private trace = false;
  private stepping = false;
  private disposables: vscode.Disposable[] = [];
  private sourceBreakpoints: Map<string, BreakpointRef[]> = new Map();
  private instructionBreakpoints: BreakpointRef[] = [];
  private exceptionBreakpoints: BreakpointRef[] = [];
  private tmpBreakpoints: TmpBreakpoint[] = [];
  private bpId = 0;

  public constructor() {
    super();
    this.setDebuggerLinesStartAt1(false);
    this.setDebuggerColumnsStartAt1(false);

    // Store process event listeners for cleanup
    const rejectionHandler = (reason: any, p: Promise<any>) => {
      logger.error(reason + " Unhandled Rejection at Promise " + p);
    };
    const exceptionHandler = (err: Error) => {
      logger.error("Uncaught Exception thrown: " + this.errorString(err));
      process.exit(1);
    };

    process.on("unhandledRejection", rejectionHandler);
    process.on("uncaughtException", exceptionHandler);

    // Store cleanup functions
    this.disposables.push({
      dispose: () => {
        process.off("unhandledRejection", rejectionHandler);
        process.off("uncaughtException", exceptionHandler);
      },
    });

    this.vAmiga = new VAmigaView(vscode.Uri.file(path.dirname(__dirname)));
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
    logger.log("Initialize request");

    response.body = response.body || {};
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsSetVariable = true;
    response.body.supportsReadMemoryRequest = true;
    response.body.supportsWriteMemoryRequest = true;
    response.body.supportsDisassembleRequest = true;
    response.body.supportsInstructionBreakpoints = true;
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsHitConditionalBreakpoints = true;

    response.body.exceptionBreakpointFilters = exceptionBreakpointFilters;

    this.sendResponse(response);
  }

  protected async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: LaunchRequestArguments,
  ) {
    logger.log("Launch request");
    // Validate the program path
    this.programPath = args.program;
    if (!this.programPath) {
      this.sendErrorResponse(response, {
        id: ERROR_IDS.PROGRAM_NOT_SPECIFIED,
        format: "program not specified",
      });
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
      this.sendErrorResponse(response, {
        id: 1004,
        format: `error reading debug symbols: ${this.errorString(err)}`,
      });
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
      this.sendErrorResponse(response, {
        id: ERROR_IDS.EMULATOR_START_ERROR,
        format: `Failed to start emulator: ${this.errorString(err)}`,
      });
      this.sendEvent(new TerminatedEvent());
    }
  }

  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
  ): void {
    logger.log("Configuration done");
    this.vAmiga.run();
    this.sendResponse(response);
  }

  protected continueRequest(response: DebugProtocol.ContinueResponse): void {
    logger.log("Continue request");
    this.vAmiga.run();
    this.vAmiga.reveal();
    response.body = { allThreadsContinued: true };
    this.sendResponse(response);
  }

  protected pauseRequest(response: DebugProtocol.PauseResponse): void {
    logger.log("Pause request");
    this.vAmiga.pause();
    this.sendResponse(response);
  }

  protected disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
  ): void {
    logger.log("Disconnect request");
    this.dispose();
    this.sendEvent(new TerminatedEvent());
    this.sendResponse(response);
  }

  protected async threadsRequest(
    response: DebugProtocol.ThreadsResponse,
  ): Promise<void> {
    logger.log("Threads request");
    response.body = {
      threads: [new Thread(VamigaDebugAdapter.THREAD_ID, "Main")],
    };
    this.sendResponse(response);
  }

  protected async stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments,
  ): Promise<void> {
    logger.log("Stack trace request");
    const startFrame = args.startFrame ?? 0;
    const maxLevels = args.levels ?? 16;
    const endFrame = startFrame + maxLevels;

    try {
      const addresses = await this.getStack(endFrame);

      let foundSource = false;

      // Now build stack frame response from addresses
      const stk = [];
      for (let i = startFrame; i < addresses.length && i < endFrame; i++) {
        const addr = addresses[i];
        if (this.sourceMap) {
          try {
            const loc = this.sourceMap.lookupAddress(addr);
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
          } catch (_) {
            // failed to look up source
          }
        }
        // stop on first rom call after user code
        if (foundSource && addr > 0x00e00000 && addr < 0x01000000) {
          break;
        }
        // No source available - create disassembly frame
        const frame = new StackFrame(0, formatHex(addr));
        frame.instructionPointerReference = formatHex(addr);
        frame.presentationHint = "subtle";
        stk.push(frame);
      }

      response.body = {
        stackFrames: stk,
        totalFrames: stk.length,
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, {
        id: 1005,
        format: `Error getting stack trace: ${this.errorString(err)}`,
      });
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
        const info = await this.vAmiga.getCpuInfo();
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
        const info = await this.vAmiga.getAllCustomRegisters();
        variables = Object.keys(info).map((name) => ({
          name,
          value: info[name].value,
          variablesReference: 0,
        }));
      } else if (id === "sr_flags") {
        const info = await this.vAmiga.getCpuInfo();
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
        const cpuInfo = await this.vAmiga.getCpuInfo();
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
          try {
            const loc = this.sourceMap?.lookupAddress(symbols[name]);
            variable.declarationLocationReference = loc
              ? this.locationHandles.create(loc)
              : undefined;
          } catch (_) {
            // No location
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
      this.sendErrorResponse(response, {
        id: 1002,
        format: `Error fetching variables ${id}: ${this.errorString(err)}`,
      });
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
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, {
        id: 1003,
        format: `Error updating variable ${name}: ${this.errorString(err)}`,
      });
    }
  }

  protected async stepInRequest(
    response: DebugProtocol.StepInResponse,
  ): Promise<void> {
    try {
      this.stepping = true;
      this.isRunning = true;
      this.vAmiga.stepInto();
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, {
        id: 1005,
        format: this.errorString(err),
      });
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
        this.setTmpBreakpoint(addr, "step");
        this.isRunning = true;
        this.vAmiga.run();
      } else {
        this.stepping = true;
        this.isRunning = true;
        this.vAmiga.stepInto();
      }
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, {
        id: 1006,
        format: this.errorString(err),
      });
    }
  }

  protected async stepOutRequest(
    response: DebugProtocol.StepOutResponse,
  ): Promise<void> {
    try {
      // vAmiga has no stepOut function, as it doesn't track stack frames. We need to use our guessed stack list to set a tmp breakpoint.
      const stack = await this.getStack();

      // stack 0 is pc
      if (stack[1]) {
        this.setTmpBreakpoint(stack[1], "step");
        this.isRunning = true;
        this.vAmiga.run();
      } else {
        this.stepping = true;
        this.isRunning = true;
        this.vAmiga.stepInto();
      }
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, {
        id: 1006,
        format: this.errorString(err),
      });
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
      return this.sendErrorResponse(response, {
        id: ERROR_IDS.DEBUG_SYMBOLS_READ_ERROR,
        format: "Debug symbols not loaded",
      });
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
      this.sendErrorResponse(response, {
        id: ERROR_IDS.MEMORY_READ_ERROR,
        format: `Failed to read memory: ${this.errorString(err)}`,
      });
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
      this.sendErrorResponse(response, {
        id: ERROR_IDS.MEMORY_WRITE_ERROR,
        format: `Failed to write memory: ${this.errorString(err)}`,
      });
    }
  }

  protected async disassembleRequest(
    response: DebugProtocol.DisassembleResponse,
    args: DebugProtocol.DisassembleArguments,
  ): Promise<void> {
    logger.log(
      `Disassemble request: ${args.memoryReference}, offset: ${args.offset}, count: ${args.instructionCount}`,
    );
    try {
      const address =
        Number(args.memoryReference) + (args.instructionOffset ?? 0);
      const count = args.instructionCount;

      const result = await this.vAmiga.disassemble(address, count);

      if (result.instructions) {
        const instructions: DebugProtocol.DisassembledInstruction[] =
          result.instructions.map((instr: any) => {
            const disasm: DebugProtocol.DisassembledInstruction = {
              address: "0x" + instr.addr,
              instruction: instr.instruction,
              instructionBytes: instr.hex,
            };
            if (
              instr.hex === "0000 0000" ||
              instr.instruction.startsWith("dc.")
            ) {
              disasm.presentationHint = "invalid";
            }

            // Add symbol lookup if we have source map
            if (this.sourceMap) {
              try {
                const addr = parseInt(instr.addr, 16);
                const loc = this.sourceMap.lookupAddress(addr);
                disasm.symbol = path.basename(loc.path) + ":" + loc.line;
                disasm.location = new Source(path.basename(loc.path), loc.path);
                disasm.line = loc.line;
              } catch (_err) {
                // No source mapping for this address
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
      this.sendErrorResponse(response, {
        id: ERROR_IDS.DISASSEMBLE_ERROR,
        format: `Failed to disassemble: ${this.errorString(err)}`,
      });
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
      this.sendErrorResponse(response, {
        id: ERROR_IDS.DEBUG_SYMBOLS_READ_ERROR,
        format: `Failed to get location: ${this.errorString(err)}`,
      });
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

  private handleMessageFromEmulator(message: any) {
    logger.log(`Recieved message: ${message.type}`);
    switch (message.type) {
      case "attached":
        return this.attach(message.segments);
      case "emulator-state":
        return this.updateState(message.state);
      case "emulator-output":
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

  private attach(segments: Segment[]) {
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
      vscode.window.showErrorMessage(this.errorString(error));
      this.sendEvent(new TerminatedEvent());
    }
  }

  private async updateState(state: string) {
    logger.log(`State: ${state}`);
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
        this.isRunning = false;
        this.stepping = false;
        this.sendEvent(new StoppedEvent("step", VamigaDebugAdapter.THREAD_ID));
      } else {
        const evt: DebugProtocol.StoppedEvent = new StoppedEvent(
          "breakpoint",
          VamigaDebugAdapter.THREAD_ID,
        );
        this.isRunning = false;

        // Look for matching breakpoint:
        const cpuInfo = await this.vAmiga.getCpuInfo();
        const pc = Number(cpuInfo.pc);

        // First check tmp breakpoints
        const tmpMatch = this.tmpBreakpoints.find((bp) => bp.address === pc);
        if (tmpMatch) {
          logger.log(`Matched tmp breakpoint at ${cpuInfo.pc}`);
          this.vAmiga.removeBreakpoint(tmpMatch.address);
          evt.body.reason = tmpMatch.reason;
          this.tmpBreakpoints = this.tmpBreakpoints.filter(
            (bp) => bp.address !== pc,
          );
        } else {
          // Check source breakpoints
          const bpMatch =
            this.findSourceBreakpoint(pc) ||
            this.instructionBreakpoints.find((bp) => bp.address === pc);

          // Add breakpoint info to response. Client doesn't know about tmp breakpoints.
          if (bpMatch) {
            evt.body.hitBreakpointIds = [bpMatch.id];
          }
        }

        this.sendEvent(evt);
      }
    }
  }

  private async getStack(maxLength = 16): Promise<number[]> {
    const cpuInfo = await this.vAmiga.getCpuInfo();

    // vAmiga doesn't currently track stack frames, so we'll need to look at the stack data and guess...
    // Fetch data from sp, up to a reasonable length
    const maxSize = 128;
    const stackData = await this.vAmiga.readMemoryBuffer(
      Number(cpuInfo.a7),
      128,
    );

    const addresses = [Number(cpuInfo.pc)]; // Start with at least the current frame

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
              addresses.push(addr);
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
}
