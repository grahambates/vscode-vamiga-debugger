/* eslint-disable @typescript-eslint/no-explicit-any */
import * as vscode from "vscode";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface CpuInfo {
  pc: string;
  flags: {
    carry: boolean;
    overflow: boolean;
    zero: boolean;
    negative: boolean;
    extend: boolean;
    trace1: boolean;
    trace0: boolean;
    supervisor: boolean;
    master: boolean;
    interrupt_mask: number;
  };
  // data regs
  d0: string;
  d1: string;
  d2: string;
  d3: string;
  d4: string;
  d5: string;
  d6: string;
  d7: string;
  // address regs
  a0: string;
  a1: string;
  a2: string;
  a3: string;
  a4: string;
  a5: string;
  a6: string;
  a7: string;
  sr: string;
  // stack pointers
  usp: string;
  isp: string;
  msp: string;
  vbr: string;
  irc: string;
  sfc: string;
  dfc: string;
  // cache
  cacr: string;
  caar: string;
}

export interface CustomRegisters {
  [name: string]: {
    value: string;
  };
}

export interface RegisterSetStatus {
  value: string;
}

export interface MemResult {
  address: string;
  data: string;
}

export interface WriteMemResult {
  bytesWritten: number;
}

export interface Disassembly {
  instructions: Array<{
    addr: string;
    instruction: string;
    hex: string;
  }>;
}

export interface Segment {
  start: number;
  size: number;
}

export interface StopMessage {
  hasMessage: boolean;
  name: "BREAKPOINT_REACHED" | "WATCHPOINT_REACHED" | "CATCHPOINT_REACHED";
  payload: {
    pc: number;
    vector: number;
  };
}

export interface AttachedMessage {
  type: "attached";
  segments: Segment[];
}

export interface EmulatorStateMessage {
  type: "emulator-state";
  state: string;
  message: StopMessage;
}

export interface EmulatorOutputMessage {
  type: "emulator-output";
  data: string;
}

export interface RpcResponseMessage {
  type: "rpcResponse";
  id: string;
  result: any;
}

export type EmulatorMessage = AttachedMessage | EmulatorStateMessage | EmulatorOutputMessage | RpcResponseMessage;

export function isAttachedMessage(message: EmulatorMessage): message is AttachedMessage {
  return message.type === "attached";
}

export function isEmulatorStateMessage(message: EmulatorMessage): message is EmulatorStateMessage {
  return message.type === "emulator-state";
}

export function isEmulatorOutputMessage(message: EmulatorMessage): message is EmulatorOutputMessage {
  return message.type === "emulator-output";
}

export function isRpcResponseMessage(message: EmulatorMessage): message is RpcResponseMessage {
  return message.type === "rpcResponse";
}

export class VAmigaView {
  public static readonly viewType = "vamiga-debugger.webview";
  private _panel?: vscode.WebviewPanel;
  private _pendingRpcs = new Map<
    string,
    {
      resolve: (result: any) => void;
      reject: (err: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  constructor(private readonly _extensionUri: vscode.Uri) {}

  /**
   * Opens a file in the VAmiga emulator webview panel
   * @param filePath Absolute path to the file to open
   * @throws Error if file does not exist
   */
  public openFile(filePath: string): void {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const column = this.getConfiguredViewColumn();

    // Create new panel
    this._panel = vscode.window.createWebviewPanel(
      VAmigaView.viewType,
      "VAmiga",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true, // Keep webview alive when hidden
        localResourceRoots: [
          this._extensionUri,
          ...(vscode.workspace.workspaceFolders?.map((folder) => folder.uri) ||
            []),
        ],
      },
    );

    const programUri = this.absolutePathToWebviewUri(filePath);
    this._panel.webview.html = this._getHtmlForWebview(programUri);

    // Handle webview lifecycle
    this._panel.onDidDispose(() => {
      this._panel = undefined;
    });

    // Set up RPC response handler
    this._panel.webview.onDidReceiveMessage((message) => {
      if (message.type === "rpcResponse") {
        const pending = this._pendingRpcs.get(message.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this._pendingRpcs.delete(message.id);
          if (message.result.error) {
            pending.reject(new Error(message.result.error));
          } else {
            pending.resolve(message.result);
          }
        }
      }
    });
  }

  /**
   * Brings the VAmiga webview panel to the foreground
   */
  public reveal(): void {
    this._panel?.reveal();
  }

  public onDidReceiveMessage(
    callback: (data: any) => void,
  ): vscode.Disposable | undefined {
    return this._panel?.webview.onDidReceiveMessage(callback);
  }

  public onDidDispose(callback: () => void): vscode.Disposable | undefined {
    return this._panel?.onDidDispose(callback);
  }

  /**
   * Sends a one-way command to the VAmiga emulator (no response expected)
   * @param command Command name to send
   * @param args Optional command arguments
   */
  public sendCommand<A = any>(command: string, args?: A): void {
    if (this._panel) {
      this._panel.webview.postMessage({ command, args });
    } else {
      vscode.window.showErrorMessage("Emulator panel is not open");
    }
  }

  /**
   * Sends an RPC command to the VAmiga emulator and waits for a response
   * @param command RPC command name
   * @param args Optional command arguments
   * @param timeoutMs Timeout in milliseconds (default: 5000)
   * @returns Promise that resolves with the command response
   * @throws Error on timeout or if webview is not open
   */
  public async sendRpcCommand<T = any, A = any>(
    command: string,
    args?: A,
    timeoutMs = 5000,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this._panel) {
        reject(new Error("Emulator panel is not open"));
        return;
      }

      const id = Math.random().toString(36).substring(2, 15);
      const timeout = setTimeout(() => {
        this._pendingRpcs.delete(id);
        reject(new Error(`RPC timeout after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);

      this._pendingRpcs.set(id, { resolve, reject, timeout });
      this._panel.webview.postMessage({
        command,
        args: { ...args, _rpcId: id },
      });
    });
  }

  public dispose(): void {
    // Clean up any pending RPCs
    for (const [_, pending] of this._pendingRpcs) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Webview disposed"));
    }
    this._pendingRpcs.clear();

    this._panel?.dispose();
  }

  // Wasm commands:

  /**
   * Pause the emulator
   */
  public pause(): void {
    this.sendCommand("pause");
  }

  /**
   * Resume running the emulator
   */
  public run(): void {
    this.sendCommand("run");
  }

  /**
   * Sets a breakpoint at the specified memory address
   * @param address Memory address for the breakpoint
   * @param ignores Number of times to ignore the breakpoint before stopping
   */
  public setBreakpoint(address: number, ignores = 0): void {
    this.sendCommand("setBreakpoint", { address, ignores });
  }

  /**
   * Removes a breakpoint at the specified memory address
   * @param address Memory address of the breakpoint to remove
   */
  public removeBreakpoint(address: number): void {
    this.sendCommand("removeBreakpoint", { address });
  }

  /**
   * Sets a watchpoint at the specified memory address
   * @param address Memory address for the watchpoint
   * @param ignores Number of times to ignore the watchpoint before stopping
   */
  public setWatchpoint(address: number, ignores = 0): void {
    this.sendCommand("setWatchpoint", { address, ignores });
  }

  /**
   * Removes a watchpoint at the specified memory address
   * @param address Memory address of the watchpoint to remove
   */
  public removeWatchpoint(address: number): void {
    this.sendCommand("removeWatchpoint", { address });
  }

  /**
   * Sets a catchpoint for the specified exception vector
   * @param vector Exception vector number (e.g. 0x8 for bus error)
   * @param ignores Number of times to ignore the exception before stopping
   */
  public setCatchpoint(vector: number, ignores = 0): void {
    this.sendCommand("setCatchpoint", { vector, ignores });
  }

  /**
   * Removes a catchpoint for the specified exception vector
   * @param vector Exception vector number to remove
   */
  public removeCatchpoint(vector: number): void {
    this.sendCommand("removeCatchpoint", { vector });
  }

  /**
   * Stop on next executed instruction
   */
  public stepInto(): void {
    this.sendCommand("stepInto");
  }

  /**
   * Gets the current CPU state including registers and flags
   * @returns Promise resolving to CPU information
   */
  public async getCpuInfo(): Promise<CpuInfo> {
    return this.sendRpcCommand("getCpuInfo");
  }

  /**
   * Gets all custom chip registers (e.g. DMACON, INTENA, etc.)
   * @returns Promise resolving to custom register values
   */
  public async getAllCustomRegisters(): Promise<CustomRegisters> {
    return this.sendRpcCommand("getAllCustomRegisters");
  }

  /**
   * Sets a CPU register to the specified value
   * @param name Register name (e.g. 'pc', 'd0', 'a7')
   * @param value New register value
   * @returns Promise resolving to set status
   */
  public async setRegister(
    name: string,
    value: number,
  ): Promise<RegisterSetStatus> {
    return this.sendRpcCommand("setRegister", { name, value });
  }

  /**
   * Sets a custom chip register to the specified value
   * @param name Register name (e.g. 'DMACON', 'INTENA')
   * @param value New register value
   * @returns Promise resolving to set status
   */
  public async setCustomRegister(
    name: string,
    value: number,
  ): Promise<RegisterSetStatus> {
    return this.sendRpcCommand("setCustomRegister", { name, value });
  }

  /**
   * Reads memory from the specified address
   * @param address Starting memory address
   * @param count Number of bytes to read
   * @returns Promise resolving to memory data (base64 encoded)
   */
  public async readMemory(address: number, count: number): Promise<MemResult> {
    return this.sendRpcCommand("readMemory", { address, count });
  }

  /**
   * Reads memory from the specified address to a Buffer
   * @param address Starting memory address
   * @param count Number of bytes to read
   * @returns Promise resolving to memory data (Buffer)
   */
  public async readMemoryBuffer(
    address: number,
    count: number,
  ): Promise<Buffer> {
    return Buffer.from((await this.readMemory(address, count)).data, "base64");
  }

  /**
   * Writes memory at the specified address
   * @param address Starting memory address
   * @param data Base64 encoded data to write
   * @returns Promise resolving to write result
   */
  public async writeMemory(
    address: number,
    data: string,
  ): Promise<WriteMemResult> {
    return this.sendRpcCommand("writeMemory", { address, data });
  }

  /**
   * Reads longword at specified address
   * @param address Starting memory address
   * @returns Promise resolving to unsigned read result
   */
  public async peek32(address: number): Promise<number> {
    const res = await this.sendRpcCommand("peek32", { address });
    // Use unsigned shift to preserve sign
    return res >>> 0;
  }

  /**
   * Reads word at specified address
   * @param address Starting memory address
   * @returns Promise resolving to unsigned read result
   */
  public async peek16(address: number): Promise<number> {
    return this.sendRpcCommand("peek16", { address });
  }

  /**
   * Reads byte at specified address
   * @param address Starting memory address
   * @returns Promise resolving to unsigned read result
   */
  public async peek8(address: number): Promise<number> {
    return this.sendRpcCommand("peek8", { address });
  }

  /**
   * Writes longword at the specified address
   * @param address Starting memory address
   * @param value numeric value to write
   */
  public async poke32(address: number, value: number): Promise<void> {
    if (value < 0) {
      value += 0x1_0000_0000;
    }
    if (value < 0 || value >= 0x1_0000_0000) {
      throw new Error('value out of 32 bit range');
    }
    return this.sendRpcCommand("poke32", { address, value });
  }

  /**
   * Writes word at the specified address
   * @param address Starting memory address
   * @param value numeric value to write
   */
  public async poke16(address: number, value: number): Promise<void> {
    if (value < 0) {
      value += 0x1_0000;
    }
    if (value < 0 || value >= 0x1_0000) {
      throw new Error('value out of 16 bit range');
    }
    return this.sendRpcCommand("poke16", { address, value });
  }

  /**
   * Writes byte at the specified address
   * @param address Starting memory address
   * @param value numeric value to write
   */
  public async poke8(address: number, value: number): Promise<void> {
    if (value < 0) {
      value += 0x100;
    }
    if (value < 0 || value >= 0x100) {
      throw new Error('value out of 8 bit range');
    }
    return this.sendRpcCommand("poke8", { address, value });
  }

  /**
   * Disassembles instructions starting at the specified address
   * @param address Starting memory address
   * @param count Number of instructions to disassemble
   * @returns Promise resolving to disassembly result
   */
  public async disassemble(
    address: number,
    count: number,
  ): Promise<Disassembly> {
    return this.sendRpcCommand("disassemble", { address, count });
  }

  // Helper methods:

  private getConfiguredViewColumn(): vscode.ViewColumn {
    const config = vscode.workspace.getConfiguration("vamiga-debugger");
    const setting = config.get<string>("defaultViewColumn", "beside");

    switch (setting) {
      case "one":
        return vscode.ViewColumn.One;
      case "two":
        return vscode.ViewColumn.Two;
      case "three":
        return vscode.ViewColumn.Three;
      case "beside":
        return vscode.ViewColumn.Beside;
      case "active":
        return (
          vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One
        );
      default:
        return vscode.ViewColumn.Beside;
    }
  }

  private absolutePathToWebviewUri(absolutePath: string): vscode.Uri {
    if (!this._panel) {
      throw new Error("Panel not initialized");
    }
    const fileUri = vscode.Uri.file(absolutePath);
    return this._panel.webview.asWebviewUri(fileUri);
  }

  private _getHtmlForWebview(programUri: vscode.Uri): string {
    if (!this._panel) {
      throw new Error("Panel not initialized");
    }

    const vamigaUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "vamiga"),
    );

    // Read the HTML template from the vamiga directory
    const templatePath = join(
      this._extensionUri.fsPath,
      "vamiga",
      "vAmiga.html",
    );
    let htmlContent = readFileSync(templatePath, "utf8");

    // Replace template variables
    htmlContent = htmlContent.replace(/\$\{vamigaUri\}/g, vamigaUri.toString());
    htmlContent = htmlContent.replace(
      /\$\{programUri\}/g,
      programUri.toString(),
    );

    return htmlContent;
  }
}
