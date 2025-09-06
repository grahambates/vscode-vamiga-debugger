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

        // The adapter implements the configurationDoneRequest.
        response.body.supportsConfigurationDoneRequest = true;
        // Make VS Code to use 'evaluate' when hovering over source
        response.body.supportsEvaluateForHovers = true;
        // Make VS Code to show a 'step into' button in the toolbar
        response.body.supportsStepInTargetsRequest = true;

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
                new Scope("Local", this._variableHandles.create("local"), false),
                new Scope("Global", this._variableHandles.create("global"), true)
            ]
        };
        this.sendResponse(response);
    }

    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
        const id = this._variableHandles.get(args.variablesReference);

        let variables: DebugProtocol.Variable[] = [];

        if (id === "local") {
            variables = [
                {
                    name: "emulator_state",
                    value: this._isRunning ? "running" : "paused",
                    variablesReference: 0
                }
            ];
        } else if (id === "global") {
            variables = [
                {
                    name: "program",
                    value: this._programPath,
                    variablesReference: 0
                }
            ];
        }

        response.body = {
            variables: variables
        };
        this.sendResponse(response);
    }
}