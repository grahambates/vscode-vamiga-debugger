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
import { VAmigaView } from './vAmigaView';
import * as path from 'path';

interface Segment {
    start: number;
    size: number;
}

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    program: string;
    stopOnEntry?: boolean;
    trace?: boolean;
}

export class VamigaDebugAdapter extends DebugSession {
    private static THREAD_ID = 1;
    private _variableHandles = new Handles<string>();
    private _isRunning = false;
    private _stopOnEntry = false;
    private _programPath = '';
    private vAmiga: VAmigaView;
    private _attached = false;
    private _segements: Segment[] = [];

    private pendingCommands: {command: string, args?: any[]}[] = [];

    public constructor() {
        super();
        this.setDebuggerLinesStartAt1(false);
        this.setDebuggerColumnsStartAt1(false);

        this.vAmiga = new VAmigaView(vscode.Uri.file(path.dirname(__dirname)));
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsSetVariable = true;

        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }

    private async startEmulator(programPath: string): Promise<void> {
        try {
            await this.vAmiga.openFile(programPath);        // Stop debugging when the webview is closed
            this.vAmiga.onDidDispose(() => this.sendEvent(new TerminatedEvent()));
            // Listen for messages from the webview
            this.vAmiga.onDidReceiveMessage((message) => this.handleMessageFromEmulator(message));
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
                    this.vAmiga.sendCommand("setBreakpoint", this._segements[0].start);
                }
                // Send any pending commands
                this.pendingCommands.forEach(cmd => {
                    this.vAmiga.sendCommand(cmd.command, cmd.args);
                });
                this.pendingCommands = [];
                this._attached = true;
                // Resume execution now attached
                this.vAmiga.sendCommand("setWarp", false);
                this.vAmiga.sendCommand("continue");
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
            this.vAmiga.sendCommand(command, args);
        } else {
            this.pendingCommands.push({command, args});
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

        // Start the emulator with the specified file
        try {
            // Send output to debug console
            this.sendEvent(new OutputEvent(`Starting Vamiga with: ${this._programPath}\n`));
            await this.startEmulator(this._programPath);
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
        this.vAmiga.sendCommand("run");
        this.vAmiga.reveal();
        response.body = { allThreadsContinued: false };
        this.sendResponse(response);
    }

    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
        this.vAmiga.sendCommand("pause");
        this.sendResponse(response);
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
        this.vAmiga.dispose();
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
                const info = await this.vAmiga.sendRpcCommand('getCpuInfo');
                const formatFlags = (flags: any) => {
                    // XNZVC
                    let out = '';
                    // bool carry = (info.sr & 0x0001) != 0;      // C flag (bit 0)
                    // bool overflow = (info.sr & 0x0002) != 0;   // V flag (bit 1)
                    // bool zero = (info.sr & 0x0004) != 0;       // Z flag (bit 2)
                    // bool negative = (info.sr & 0x0008) != 0;   // N flag (bit 3)
                    // bool extend = (info.sr & 0x0010) != 0;     // X flag (bit 4)
                    // bool trace1 = (info.sr & 0x8000) != 0;     // T1 flag (bit 15)
                    // bool trace0 = (info.sr & 0x4000) != 0;     // T0 flag (bit 14) - 68020+
                    // bool supervisor = (info.sr & 0x2000) != 0; // S flag (bit 13)
                    // bool master = (info.sr & 0x1000) != 0;     // M flag (bit 12) - 68020+
                    // int interrupt_mask = (info.sr >> 8) & 0x07; // IPL (bits 8-10)
                    out += flags.interrupt_mask;
                    out += ' ';
                    out += flags.master ? 'M' : '_';
                    out += ' ';
                    out += flags.supervisor ? 'S' : '_';
                    out += ' ';
                    out += flags.trace0 ? 'T0' : '_';
                    out += ' ';
                    out += flags.trace1 ? 'T1' : '_';
                    out += ' ';
                    out += flags.extend ? 'X' : '_';
                    out += flags.negative ? 'N' : '_';
                    out += flags.zero ? 'Z' : '_';
                    out += flags.overflow ? 'V' : '_';
                    out += flags.carry ? 'C' : '_';
                    return out;
                };
                variables = Object.keys(info).map(name => ({
                    name,
                    value: name === 'flags' ? formatFlags(info[name]) : String(info[name]),
                    variablesReference: 0
                }));
            } else if (id === "custom") {
                const info = await this.vAmiga.sendRpcCommand('getAllCustomRegisters');
                variables = Object.keys(info).map(  name => ({
                    name,
                    value: String(info[name].value),
                    variablesReference: 0
                }));
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
            if (id === "registers") {
                // TODO:
            } else if (id === "custom") {
                await this.vAmiga.sendRpcCommand('setCustomRegister', { name, value });
            }
            response.body = {
                value: args.value,
            };
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, {
                id: 1002,
                format: `Error updating variable ${id}:${name}: ${(err as Error).message}`,
            });
        }
    }
}