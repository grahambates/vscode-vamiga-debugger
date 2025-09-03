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

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    program: string;
    stopOnEntry?: boolean;
    trace?: boolean;
}

export class VamigaDebugAdapter extends DebugSession {
    private static THREAD_ID = 1;
    private _variableHandles = new Handles<string>();
    private _isRunning = false;
    private _programPath = '';
    private vAmiga: VAmigaView;

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

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
        // Validate the program path
        this._programPath = args.program;
        if (!this._programPath) {
            this.sendErrorResponse(response, {
                id: 1001,
                format: 'program not specified',
            });
            return;
        }

        // Start the emulator with the specified ADF
        try {
            await this.startEmulator(this._programPath);
            this._isRunning = true;

            // Send output to debug console
            this.sendEvent(new OutputEvent(`Starting Vamiga with: ${this._programPath}\n`));

            if (args.stopOnEntry) {
                // todo
            }

            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(response, {
                id: 1002,
                format: `Failed to start emulator: ${error}`,
            });
        }
    }

    private async startEmulator(programPath: string): Promise<void> {
        this.vAmiga.openFile(programPath);

        // Stop debugging when the webview is closed
        this.vAmiga.onDidDispose(() => {
            this.sendEvent(new TerminatedEvent());
        });

        // Listen for messages from the webview
        this.vAmiga.onDidReceiveMessage((message: any) => {
            switch (message.type) {
                case 'emulator-state':
                    if (message.state === 'paused') {
                        this._isRunning = false;
                        this.sendEvent(new StoppedEvent('pause', VamigaDebugAdapter.THREAD_ID));
                    } else if (message.state === 'running') {
                        this._isRunning = true;
                        this.sendEvent(new ContinuedEvent(VamigaDebugAdapter.THREAD_ID));
                    }
                    break;
                case 'emulator-output':
                    this.sendEvent(new OutputEvent(message.data + '\n'));
                    break;
            }
        });
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        this._isRunning = true;
        this.vAmiga.sendCommand("run");
        this.vAmiga.reveal();
        this.sendEvent(new ContinuedEvent(args.threadId));
        response.body = { allThreadsContinued: false };
        this.sendResponse(response);
    }

    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
        this._isRunning = false;
        this.vAmiga.sendCommand("pause");
        this.sendEvent(new StoppedEvent('pause', VamigaDebugAdapter.THREAD_ID));
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