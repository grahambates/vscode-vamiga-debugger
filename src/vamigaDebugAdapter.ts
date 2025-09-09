import {
    DebugSession,
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
    Breakpoint
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as vscode from 'vscode';
import * as path from 'path';
import { readFile } from "fs/promises";

import { VAmigaView } from './vAmigaView';
import { Hunk, parseHunks } from './amigaHunkParser';
import { DWARFData, parseDwarf } from './dwarfParser';

interface Segment {
    start: number;
    size: number;
}

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    program: string;
    debugProgram?: string | null;
    stopOnEntry?: boolean;
    trace?: boolean;
}

export class VamigaDebugAdapter extends DebugSession {
    private static THREAD_ID = 1;
    private _variableHandles = new Handles<string>();
    private _isRunning = false;
    private _stopOnEntry = false;
    private _programPath = '';
    private _vAmiga: VAmigaView;
    private _attached = false;
    private _hunks: Hunk[] = [];
    private _dwarfData: DWARFData | null = null;
    private _segements: Segment[] = [];

    private pendingCommands: { command: string, args?: any[] }[] = [];

    public constructor() {
        super();
        this.setDebuggerLinesStartAt1(false);
        this.setDebuggerColumnsStartAt1(false);

        this._vAmiga = new VAmigaView(vscode.Uri.file(path.dirname(__dirname)));
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsSetVariable = true;

        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }

    private async startEmulator(): Promise<void> {
        try {
            await this._vAmiga.openFile(this._programPath);
            // Stop debugging when the webview is closed
            this._vAmiga.onDidDispose(() => this.sendEvent(new TerminatedEvent()));
            // Listen for messages from the webview
            this._vAmiga.onDidReceiveMessage((message) => this.handleMessageFromEmulator(message));
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to open file in VAmiga view: ${error.message}`);
            }
            this.sendEvent(new TerminatedEvent());
        }
    }

    private handleMessageFromEmulator(message: any) {
        switch (message.type) {
            case 'attached':
                this.sendEvent(new OutputEvent('attached\n'));
                this._segements = message.segments;
                if (this._stopOnEntry) {
                    // Set a breakpoint at entry point
                    this._vAmiga.sendCommand("setBreakpoint", this._segements[0].start);
                }
                // Send any pending commands
                this.pendingCommands.forEach(cmd => {
                    this._vAmiga.sendCommand(cmd.command, cmd.args);
                });
                this.pendingCommands = [];
                this._attached = true;
                // Resume execution now attached
                this._vAmiga.sendCommand("run");
                break;
            case 'emulator-state':
                if (message.state === 'paused') {
                    this._isRunning = false;
                    this.sendEvent(new StoppedEvent('pause', VamigaDebugAdapter.THREAD_ID));
                } else if (message.state === 'running') {
                    this._isRunning = true;
                    this.sendEvent(new ContinuedEvent(VamigaDebugAdapter.THREAD_ID));
                } else if (message.state === 'stopped') {
                    this.sendEvent(new OutputEvent('hit breakpoint\n'));
                    this._isRunning = false;
                    this.sendEvent(new StoppedEvent('breakpoint', VamigaDebugAdapter.THREAD_ID));
                }
                break;
            case 'emulator-output':
                this.sendEvent(new OutputEvent(message.data + '\n'));
                break;
        }
    }

    public sendCommand(command: string, args?: any): void {
        if (this._attached) {
            this._vAmiga.sendCommand(command, args);
        } else {
            this.pendingCommands.push({ command, args });
        }
    }

    // Request handlers:

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
        // Validate the program path
        this._programPath = args.program;
        if (!this._programPath) {
            this.sendErrorResponse(response, {
                id: 1001,
                format: 'program not specified',
            });
            this.sendEvent(new TerminatedEvent());
            return;
        }

        const debugProgram = args.debugProgram || this._programPath;

        try {
            const buffer = await readFile(debugProgram);
            // TODO: could check file header instead of extension
            if (debugProgram.match(/\.(elf|o)$/i)) {
                this._dwarfData = await parseDwarf(buffer);
            } else {
                this._hunks = await parseHunks(buffer);
            }
        } catch (err) {
            this.sendErrorResponse(response, {
                id: 1004,
                format: `error reading debug symbols from ${debugProgram}: ${(err as Error).message}`,
            });
            this.sendEvent(new TerminatedEvent());
        }

        // Start the emulator with the specified file
        try {
            // Send output to debug console
            this.sendEvent(new OutputEvent(`Starting Vamiga with: ${this._programPath}\n`));
            await this.startEmulator();
            this._isRunning = true;
            this._stopOnEntry = args.stopOnEntry ?? false;
            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(response, {
                id: 1002,
                format: `Failed to start emulator: ${error}`,
            });
            this.sendEvent(new TerminatedEvent());
        }
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        this._vAmiga.sendCommand("run");
        this._vAmiga.reveal();
        response.body = { allThreadsContinued: false };
        this.sendResponse(response);
    }

    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
        this._vAmiga.sendCommand("pause");
        this.sendResponse(response);
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
        this._vAmiga.dispose();
        this.sendEvent(new TerminatedEvent());
        this.sendResponse(response);
    }

    // placeholders for required methods:

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        // Return a default thread
        response.body = {
            threads: [
                new Thread(VamigaDebugAdapter.THREAD_ID, "Main")
            ]
        };
        this.sendResponse(response);
    }

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
        const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
        const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
        const endFrame = startFrame + maxLevels;

        const stk = [
            new StackFrame(0, "Main", new Source("program.c", this._programPath), 1, 1)
        ];

        response.body = {
            stackFrames: stk.slice(startFrame, endFrame),
            totalFrames: stk.length
        };
        this.sendResponse(response);
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
                const info = await this._vAmiga.sendRpcCommand('getCpuInfo');
                variables = Object.keys(info).filter(k => k !== 'flags').map(name => ({
                    name,
                    value: String(info[name]),
                    variablesReference: name === 'sr' ? this._variableHandles.create(`sr_flags`) : 0
                }));
            } else if (id === "custom") {
                const info = await this._vAmiga.sendRpcCommand('getAllCustomRegisters');
                variables = Object.keys(info).map(name => ({
                    name,
                    value: String(info[name].value),
                    variablesReference: 0
                }));
            } else if (id === "sr_flags") {
                const info = await this._vAmiga.sendRpcCommand('getCpuInfo');
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
                res = await this._vAmiga.sendRpcCommand('setRegister', { name, value });
            } else if (id === "custom") {
                res = await this._vAmiga.sendRpcCommand('setCustomRegister', { name, value });
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
                format: `Error updating variable ${id}:${name}: ${(err as Error).message}`,
            });
        }
    }
}