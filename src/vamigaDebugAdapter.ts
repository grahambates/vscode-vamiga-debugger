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
    BreakpointEvent,
} from '@vscode/debugadapter';
import { LogLevel } from "@vscode/debugadapter/lib/logger";
import { DebugProtocol } from '@vscode/debugprotocol';
import * as vscode from 'vscode';
import * as path from 'path';
import { readFile } from "fs/promises";

import { VAmigaView } from './vAmigaView';
import { Hunk, parseHunks } from './amigaHunkParser';
import { DWARFData, parseDwarf } from './dwarfParser';
import { sourceMapFromDwarf } from './dwarfSourceMap';
import { sourceMapFromHunks } from './amigaHunkSourceMap';
import { SourceMap } from './sourceMap';

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
    // Stack trace errors (5000-5099)
    STACK_TRACE_ERROR: 5001,
} as const;

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    program: string;
    debugProgram?: string | null;
    stopOnEntry?: boolean;
    trace?: boolean;
}

type Breakpoint = DebugProtocol.Breakpoint & {
    ignores: number;
};

interface Segment {
    start: number;
    size: number;
}

function formatHex(value: number, length = 8): string {
    return '0x' + value.toString(16).padStart(length, '0');
}

function isNumeric(value: string): boolean {
    return !isNaN(Number(value));
}

export class VamigaDebugAdapter extends LoggingDebugSession {
    private static THREAD_ID = 1;
    private _variableHandles = new Handles<string>();
    private isRunning = false;
    private stopOnEntry = false;
    private programPath = '';
    private vAmiga: VAmigaView;
    private hunks: Hunk[] = [];
    private dwarfData?: DWARFData;
    private sourceMap?: SourceMap;
    private trace = false;
    private stepping = true;
    private disposables: vscode.Disposable[] = [];
    private sourceBreakpoints: Map<string,Breakpoint[]> = new Map();
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
            }
        });

        this.vAmiga = new VAmigaView(vscode.Uri.file(path.dirname(__dirname)));
    }

    public shutdown(): void {
        this.dispose();
    }

    public dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        this.vAmiga.dispose();
    }

    // Request handlers:

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        logger.log('Initialize request');
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsSetVariable = true;

        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
        logger.log('Launch request');
        // Validate the program path
        this.programPath = args.program;
        if (!this.programPath) {
            this.sendErrorResponse(response, {
                id: ERROR_IDS.PROGRAM_NOT_SPECIFIED,
                format: 'program not specified',
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
                logger.log('Interpreting as dwarf data');
                this.dwarfData = parseDwarf(buffer);
            } else {
                logger.log('Interpreting as hunk data');
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
            const disposeDisposable = this.vAmiga.onDidDispose(() => this.sendEvent(new TerminatedEvent()));
            const messageDisposable = this.vAmiga.onDidReceiveMessage((message) => this.handleMessageFromEmulator(message));
            // Store disposables
            if (disposeDisposable) { this.disposables.push(disposeDisposable); }
            if (messageDisposable) { this.disposables.push(messageDisposable); }

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

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        logger.log('Continue request');
        this.sendCommand("run");
        this.vAmiga.reveal();
        response.body = { allThreadsContinued: false };
        this.sendResponse(response);
    }

    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
        logger.log('Pause request');
        this.sendCommand("pause");
        this.sendResponse(response);
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
        logger.log('Disconnect request');
        this.dispose();
        this.sendEvent(new TerminatedEvent());
        this.sendResponse(response);
    }

    protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
        logger.log('Threads request');
        response.body = {
            threads: [
                new Thread(VamigaDebugAdapter.THREAD_ID, "Main")
            ]
        };
        this.sendResponse(response);
    }

    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
        logger.log('Stack trace request');
        try {
            const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
            const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
            const endFrame = startFrame + maxLevels;

            if (this.sourceMap) {
                const cpuInfo = await this.sendRpcCommand('getCpuInfo');
                const pc = Number(cpuInfo.pc);
                const loc = this.sourceMap.lookupAddress(pc);

                const stk = [
                    new StackFrame(0, "Main", new Source(path.basename(loc.path), loc.path), loc.line)
                ];
                response.body = {
                    stackFrames: stk.slice(startFrame, endFrame),
                    totalFrames: stk.length
                };
            } else {
                vscode.window.showErrorMessage('No debug information loaded');
            }
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, {
                id: 1005,
                format: `Error getting stack trace: ${this.errorString(err)}`,
            });
        }
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
        response.body = {
            scopes: [
                new Scope("CPU Registers", this._variableHandles.create("registers"), false),
                new Scope("Custom Registers", this._variableHandles.create("custom"), false)
            ]
        };
        this.sendResponse(response);
    }

    protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
        const id = this._variableHandles.get(args.variablesReference);
        let variables: DebugProtocol.Variable[] = [];
        try {
            if (id === "registers") {
                const info = await this.sendRpcCommand('getCpuInfo');
                variables = Object.keys(info).filter(k => k !== 'flags').map(name => ({
                    name,
                    value: String(info[name]),
                    variablesReference: name === 'sr' ? this._variableHandles.create(`sr_flags`) : 0
                }));
            } else if (id === "custom") {
                const info = await this.sendRpcCommand('getAllCustomRegisters');
                variables = Object.keys(info).map(name => ({
                    name,
                    value: String(info[name].value),
                    variablesReference: 0
                }));
            } else if (id === "sr_flags") {
                const info = await this.sendRpcCommand('getCpuInfo');
                const flags = info.flags;
                variables = [
                    { name: 'carry', value: flags.carry ? 'true' : 'false', variablesReference: 0 },
                    { name: 'overflow', value: flags.overflow ? 'true' : 'false', variablesReference: 0 },
                    { name: 'zero', value: flags.zero ? 'true' : 'false', variablesReference: 0 },
                    { name: 'negative', value: flags.negative ? 'true' : 'false', variablesReference: 0 },
                    { name: 'extend', value: flags.extend ? 'true' : 'false', variablesReference: 0 },
                    { name: 'trace1', value: flags.trace1 ? 'true' : 'false', variablesReference: 0 },
                    { name: 'trace0', value: flags.trace0 ? 'true' : 'false', variablesReference: 0 },
                    { name: 'supervisor', value: flags.supervisor ? 'true' : 'false', variablesReference: 0 },
                    { name: 'master', value: flags.master ? 'true' : 'false', variablesReference: 0 },
                    { name: 'interrupt_mask', value: String(flags.interrupt_mask), variablesReference: 0 }
                ];
            }
            response.body = {
                variables: variables
            };
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, {
                id: 1002,
                format: `Error fetching variables ${id}`,
            });
        }
    }

    protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments, request?: DebugProtocol.Request): Promise<void> {
        const id = this._variableHandles.get(args.variablesReference);
        const name = args.name;
        const value = Number(args.value);
        try {
            let res: any;
            if (id === "registers") {
                res = await this.sendRpcCommand('setRegister', { name, value });
            } else if (id === "custom") {
                res = await this.sendRpcCommand('setCustomRegister', { name, value });
            }
            if (res.error) {
                this.sendErrorResponse(response, {
                    id: 1002,
                    format: res.message,
                });
            } else {
                response.body = {
                    value: res.value,
                };
                this.sendResponse(response);
            }
        } catch (err) {
            this.sendErrorResponse(response, {
                id: 1003,
                format: `Error updating variable ${name}: ${this.errorString(err)}`,
            });
        }
    }

    protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request): Promise<void> {
        try {
            this.stepping = true;
            this.isRunning = true;
            await this.sendRpcCommand('stepInto');
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, {
                id: 1005,
                format: this.errorString(err),
            });
        }
    }

    protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, request?: DebugProtocol.Request): Promise<void> {
        try {
            this.stepping = true;
            this.isRunning = true;
            await this.sendRpcCommand('stepOver');
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, {
                id: 1006,
                format: this.errorString(err),
            });
        }
    }

    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments, request?: DebugProtocol.Request): void {
        const path = args.source.path!;
        logger.log(`Set breakpoints request: ${path}`);

        // Remove existing
        const existing = this.sourceBreakpoints.get(path);
        if (existing) {
            for (const { id, line, instructionReference } of existing) {
                if (instructionReference) {
                    logger.log(`Removing existing breakpoint #${id} at ${path}:${line} at ${instructionReference}`);
                    this.sendCommand('removeBreakpoint', { address: Number(instructionReference) });
                }
            }
        }

        const newBps: Breakpoint[] = [];
        this.sourceBreakpoints.set(path, newBps);

        response.body = {
            breakpoints: [],
        };

        for (let reqBp of args.breakpoints ?? []) {
            const { line, hitCondition } = reqBp;
            let ignores = (hitCondition && isNumeric(hitCondition)) ? Number(hitCondition) : 0;

            const bp: Breakpoint = {
                id: this.bpId++,
                ignores,
                verified: false, // Start as unverified
                source: args.source,
                ...reqBp,
            };
            newBps.push(bp);

            if (this.sourceMap) {
                // Look up address from source and set breakpoint now
                const address = this.sourceMap.lookupSourceLine(path, reqBp.line).address;
                bp.instructionReference = formatHex(address);
                bp.verified = true;
                this.sendCommand('setBreakpoint', { address, ignores: bp.ignores });
                logger.log(`Breakpoint #${bp.id} at ${path}:${line} set immediately at ${bp.instructionReference}`);
            } else {
                // Set pending status and process on attach
                logger.log(`Breakpoint #${bp.id} at ${path}:${line} pending`);
                bp.reason = 'pending';
            }
            response.body.breakpoints.push(bp);
        }
        this.sendResponse(response);
    }

    // Helpers:

    private handleMessageFromEmulator(message: any) {
        logger.log(`Recieved message: ${message.type}`);
        switch (message.type) {
            case 'attached':
                return this.attach(message.segments);
            case 'emulator-state':
                return this.updateState(message.state);
            case 'emulator-output':
                this.sendEvent(new OutputEvent(message.data + '\n'));
        }
    }

    private attach(segments: Segment[]) {
        const offsets = segments.map(s => s.start);
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

            // Send pending breakpoints now we can calculate addresses
            for (const [path, bps] of this.sourceBreakpoints) {
                for (const bp of bps) {
                    const address = this.sourceMap!.lookupSourceLine(path, bp.line!).address;
                    bp.instructionReference = formatHex(address);
                    bp.verified = true;
                    this.sendCommand('setBreakpoint', { address, ignores: bp.ignores });
                    logger.log(`Breakpoint #${bp.id} at ${path}:${bp.line} set at ${bp.instructionReference}`);
                    this.sendEvent(new BreakpointEvent('changed', bp));
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(this.errorString(error));
        }

        // Resume execution now attached
        this.sendCommand("run");
    }

    private updateState(state: string) {
        logger.log(`State: ${state}`);
        if (state === 'paused') {
            if (this.isRunning) {
                this.isRunning = false;
                this.sendEvent(new StoppedEvent('pause', VamigaDebugAdapter.THREAD_ID));
            }
        } else if (state === 'running') {
            if (!this.isRunning) {
                this.isRunning = true;
                this.sendEvent(new ContinuedEvent(VamigaDebugAdapter.THREAD_ID));
            }
        } else if (state === 'stopped') {
            if (this.stepping) {
                this.isRunning = false;
                this.stepping = false;
                this.sendEvent(new StoppedEvent('step', VamigaDebugAdapter.THREAD_ID));
            } else {
                this.isRunning = false;
                this.sendEvent(new StoppedEvent('breakpoint', VamigaDebugAdapter.THREAD_ID));
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

    private async sendRpcCommand<T = any>(command: string, args?: any): Promise<T> {
        logger.verbose(`RPC Request: ${command}(${JSON.stringify(args)})`);
        const res = await this.vAmiga.sendRpcCommand<T>(command, args);
        logger.verbose(`RPC response: ${JSON.stringify(res)}`);
        return res;
    }
}