/* eslint-disable @typescript-eslint/no-explicit-any */

// TODO:
// - Step out
// - Fix Step over
// - Focus issue
// - Exception breakpoints
// - Disassembly view panel
// - Watchpoints
// - Read/Write memory
// - Copper thread
// - Stack frames
// - Console
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

import { VAmigaView } from "./vAmigaView";
import { Hunk, parseHunks } from "./amigaHunkParser";
import { DWARFData, parseDwarf } from "./dwarfParser";
import { sourceMapFromDwarf } from "./dwarfSourceMap";
import { sourceMapFromHunks } from "./amigaHunkSourceMap";
import { SourceMap } from "./sourceMap";

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

function formatHex(value: number, length = 8): string {
  return "0x" + value.toString(16).padStart(length, "0");
}

function isNumeric(value: string): boolean {
  return !isNaN(Number(value));
}

export class VamigaDebugAdapter extends LoggingDebugSession {
  private static THREAD_ID = 1;
  private variableHandles = new Handles<string>();
  private isRunning = false;
  private stopOnEntry = false;
  private programPath = "";
  private vAmiga: VAmigaView;
  private hunks: Hunk[] = [];
  private dwarfData?: DWARFData;
  private sourceMap?: SourceMap;
  private trace = false;
  private stepping = true;
  private disposables: vscode.Disposable[] = [];
  private sourceBreakpoints: Map<string, BreakpointRef[]> = new Map();
  private instructionBreakpoints: BreakpointRef[] = [];
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
    this.sendCommand("run");
    this.sendResponse(response);
  }

  protected continueRequest(
    response: DebugProtocol.ContinueResponse,
  ): void {
    logger.log("Continue request");
    this.sendCommand("run");
    this.vAmiga.reveal();
    response.body = { allThreadsContinued: true };
    this.sendResponse(response);
  }

  protected pauseRequest(
    response: DebugProtocol.PauseResponse,
  ): void {
    logger.log("Pause request");
    this.sendCommand("pause");
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
    try {
      const startFrame =
        typeof args.startFrame === "number" ? args.startFrame : 0;
      const maxLevels = typeof args.levels === "number" ? args.levels : 1000;
      const endFrame = startFrame + maxLevels;

      const stk = [];
      const cpuInfo = await this.sendRpcCommand("getCpuInfo");
      const pc = Number(cpuInfo.pc);

      if (this.sourceMap) {
        try {
          const loc = this.sourceMap.lookupAddress(pc);
          const frame = new StackFrame(
            0,
            "Main",
            new Source(path.basename(loc.path), loc.path),
            loc.line,
          );
          frame.instructionPointerReference = cpuInfo.pc;
          stk.push(frame);
        } catch (_err) {
          // Fallback to disassembly view - no source file
          const frame = new StackFrame(0, `Assembly: ${formatHex(pc)}`);
          frame.instructionPointerReference = formatHex(pc);
          frame.presentationHint = "subtle";
          stk.push(frame);
        }
      } else {
        // No source map available - create disassembly frame
        const frame = new StackFrame(0, `Assembly: ${formatHex(pc)}`);
        frame.instructionPointerReference = formatHex(pc);
        frame.presentationHint = "subtle";
        stk.push(frame);
      }
      response.body = {
        stackFrames: stk.slice(startFrame, endFrame),
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

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
  ): void {
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
    ];
    if (this.sourceMap) {
      scopes.push(
        new Scope("Symbols", this.variableHandles.create("symbols"), false),
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
        const info = await this.sendRpcCommand("getCpuInfo");
        variables = Object.keys(info)
          .filter((k) => k !== "flags")
          .map((name) => {
            const v: DebugProtocol.Variable = {
              name,
              value: String(info[name]),
              variablesReference:
                name === "sr" ? this.variableHandles.create(`sr_flags`) : 0,
            };
            if (name.match(/(a[0-9]|pc|usp|msp|vbr)/)) {
              v.memoryReference = info[name];
            }
            return v;
          });
      } else if (id === "custom") {
        const info = await this.sendRpcCommand("getAllCustomRegisters");
        variables = Object.keys(info).map((name) => ({
          name,
          value: info[name].value,
          variablesReference: 0,
        }));
      } else if (id === "sr_flags") {
        const info = await this.sendRpcCommand("getCpuInfo");
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
      } else if (id === "symbols" && this.sourceMap) {
        const symbols = this.sourceMap.getSymbols();
        variables = Object.keys(symbols).map((name) => {
          const value = formatHex(symbols[name]);
          return {
            name,
            value,
            memoryReference: value,
            presentationHint: {
              attributes: ["readOnly"],
            },
            variablesReference: 0,
          };
        });
      }
      response.body = {
        variables: variables,
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
        res = await this.sendRpcCommand("setRegister", { name, value });
      } else if (id === "custom") {
        res = await this.sendRpcCommand("setCustomRegister", { name, value });
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
      await this.sendRpcCommand("stepInto");
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
      this.stepping = true;
      this.isRunning = true;
      await this.sendRpcCommand("stepOver");
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
        this.sendCommand("removeBreakpoint", { address: ref.address });
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

      this.sendCommand("setBreakpoint", { address, ignores });
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
      this.sendCommand("removeBreakpoint", { address: ref.address });
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

      this.sendCommand("setBreakpoint", { address, ignores });
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
        const result = await this.sendRpcCommand("readMemory", {
          address,
          count,
        });
        if (result.success) {
          response.body = {
            address: result.address,
            data: result.data, // Already base64 encoded
            unreadableBytes: 0,
          };
        } else {
          throw new Error(result.error || "Memory read failed");
        }
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

      const result = await this.sendRpcCommand("writeMemory", {
        address,
        data: args.data, // Pass base64 data directly
      });

      if (result.success) {
        response.body = {
          offset: args.offset,
          bytesWritten:
            result.bytesWritten || Buffer.from(args.data, "base64").length,
        };
      } else {
        throw new Error(result.error || "Memory write failed");
      }
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

      const result = await this.sendRpcCommand("disassemble", {
        address,
        count,
      });

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

  private attach(segments: Segment[]) {
    const offsets = segments.map((s) => s.start);
    if (this.stopOnEntry) {
      logger.log(`Setting entry breakpoint at ${formatHex(offsets[0])}`);
      // Set a breakpoint at entry point
      this.sendCommand("setBreakpoint", { address: offsets[0], ignores: 0 });
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

  private updateState(state: string) {
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
        this.isRunning = false;
        this.sendEvent(
          new StoppedEvent("breakpoint", VamigaDebugAdapter.THREAD_ID),
        );
      }
    }
  }

  private errorString(err: unknown): string {
    if (err instanceof Error) {
      return this.trace ? err.stack || err.message : err.message;
    }
    return String(err);
  }

  // Wrap commands for logging:

  private sendCommand(command: string, args?: any) {
    logger.verbose(`Send command: ${command}(${JSON.stringify(args)})`);
    this.vAmiga.sendCommand(command, args);
  }

  private async sendRpcCommand<T = any>(
    command: string,
    args?: any,
  ): Promise<T> {
    logger.verbose(`RPC Request: ${command}(${JSON.stringify(args)})`);
    const res = await this.vAmiga.sendRpcCommand<T>(command, args);
    logger.verbose(`RPC response: ${JSON.stringify(res)}`);
    return res;
  }
}
