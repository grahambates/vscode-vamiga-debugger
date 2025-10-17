/* eslint-disable @typescript-eslint/no-explicit-any */
import * as vscode from "vscode";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { u32, u16, u8 } from "./numbers";

export interface CpuInfo {
  pc: string;
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

export enum MemSrc {
  NONE = 0,
  CHIP = 1,
  CHIP_MIRROR = 2,
  SLOW = 3,
  SLOW_MIRROR = 4,
  FAST = 5,
  CIA = 6,
  CIA_MIRROR = 7,
  RTC = 8,
  CUSTOM = 9,
  CUSTOM_MIRROR = 10,
  AUTOCONF = 11,
  ZOR = 12,
  ROM = 13,
  ROM_MIRROR = 14,
  WOM = 15,
  EXT = 16,
}

export interface MemoryInfo {
  hasRom: boolean;
  hasWom: boolean;
  hasExt: boolean;
  hasBootRom: boolean;
  hasKickRom: boolean;
  womLock: boolean;
  romMask: string;
  extMask: string;
  chipMask: string;
  cpuMemSrc: MemSrc[];
  agnusMemSrc: MemSrc[];
}

export interface CpuTraceItem {
  pc: string;
  instruction: string;
  flags: string;
  length: number;
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
export interface ExecReadyMessage {
  type: "exec-ready";
}

export interface RpcResponseMessage {
  type: "rpcResponse";
  id: string;
  result: any;
}

export type EmulatorMessage =
  | AttachedMessage
  | EmulatorStateMessage
  | EmulatorOutputMessage
  | ExecReadyMessage
  | RpcResponseMessage;

/**
 * Type guard to check if a message is an AttachedMessage.
 *
 * @param message The emulator message to check
 * @returns True if the message is an AttachedMessage
 */
export function isAttachedMessage(
  message: EmulatorMessage,
): message is AttachedMessage {
  return message.type === "attached";
}

/**
 * Type guard to check if a message is an EmulatorStateMessage.
 *
 * @param message The emulator message to check
 * @returns True if the message is an EmulatorStateMessage
 */
export function isEmulatorStateMessage(
  message: EmulatorMessage,
): message is EmulatorStateMessage {
  return message.type === "emulator-state";
}

/**
 * Type guard to check if a message is an EmulatorOutputMessage.
 *
 * @param message The emulator message to check
 * @returns True if the message is an EmulatorOutputMessage
 */
export function isEmulatorOutputMessage(
  message: EmulatorMessage,
): message is EmulatorOutputMessage {
  return message.type === "emulator-output";
}

/**
 * Type guard to check if a message is an ExecReadyMessage.
 *
 * @param message The emulator message to check
 * @returns True if the message is an ExecReadyMessage
 */
export function isExecReadyMessage(
  message: EmulatorMessage,
): message is ExecReadyMessage {
  return message.type === "exec-ready";
}

/**
 * Type guard to check if a message is an RpcResponseMessage.
 *
 * @param message The emulator message to check
 * @returns True if the message is an RpcResponseMessage
 */
export function isRpcResponseMessage(
  message: EmulatorMessage,
): message is RpcResponseMessage {
  return message.type === "rpcResponse";
}

/**
 * User options input using absolute file paths
 */
export interface OpenOptions {
  // Paths will need to be converted to URIs
  programPath?: string;
  kickstartRomPath?: string;
  kickstartExtPath?: string;
  useArosRom?: boolean;
  showNavBar?: boolean;
  wideScreen?: boolean;
  darkMode?: boolean;
  enableMouse?: boolean;
  displayZoom?:
    | "viewport tracking"
    | "borderless"
    | "narrow"
    | "standard"
    | "wider"
    | "overscan"
    | "extreme";
  useGpu?: boolean;
  // Hardware configuration options
  agnusRevision?: "OCS_OLD" | "OCS" | "ECS_1MB" | "ECS_2MB";
  deniseRevision?: "OCS" | "ECS";
  cpuRevision?: "68000" | "68010" | "68020" | "fake_68030";
  cpuSpeed?:
    | "7MHz"
    | "14Hz"
    | "21Hz"
    | "28Hz"
    | "35Hz"
    | "43Hz"
    | "57Hz"
    | "85Hz"
    | "99Hz";
  chipRam?: "256k" | "512k" | "1M" | "2M";
  slowRam?: "0" | "256k" | "512k";
  fastRam?: "0" | "256k" | "512k" | "1M" | "2M" | "8M";
  blitterAccuracy?: 0 | 1 | 2;
  floppyDriveCount?: 1 | 2 | 3 | 4;
  driveSpeed?: -1 | 1 | 2 | 4 | 8;
}

// Option enums to call param values:
const cpuRevision = { "68000": 0, "68010": 1, "68020": 2, fake_68030: 4 };
const cpuSpeed = {
  "7MHz": 0,
  "14Hz": 2,
  "21Hz": 3,
  "28Hz": 4,
  "35Hz": 5,
  "43Hz": 6,
  "57Hz": 8,
  "85Hz": 12,
  "99Hz": 14,
};
const chipRam = { "256k": 256, "512k": 512, "1M": 1024, "2M": 2048 };
const slowRam = { "0": 0, "256k": 256, "512k": 512 };
const fastRam = {
  "0": 0,
  "256k": 256,
  "512k": 512,
  "1M": 1024,
  "2M": 2048,
  "8M": 8192,
};

/**
 * Subset of JSON params that can be passed to vAmiga in URL hash
 */
interface CallParams {
  url?: string;
  kickstart_rom_url?: string;
  kickstart_ext_url?: string;
  AROS?: boolean;
  navbar?: boolean;
  wide?: boolean;
  dark?: boolean;
  mouse?: boolean;
  display?:
    | "viewport tracking"
    | "borderless"
    | "narrow"
    | "standard"
    | "wider"
    | "overscan"
    | "extreme";
  gpu?: boolean;
  // Hardware configuration options
  agnus_revision?: "OCS_OLD" | "OCS" | "ECS_1MB" | "ECS_2MB";
  denise_revision?: "OCS" | "ECS";
  cpu_revision?: number;
  cpu_overclocking?: number;
  chip_ram?: number;
  slow_ram?: number;
  fast_ram?: number;
  blitter_accuracy?: number;
  floppy_drive_count?: number;
  drive_speed?: number;
}

const defaultOptions: OpenOptions = {
  showNavBar: false,
  enableMouse: true,
};

export class VAmiga {
  public static readonly viewType = "vamiga-debugger.webview";
  private panel?: vscode.WebviewPanel;
  private pendingRpcs = new Map<
    string,
    {
      resolve: (result: any) => void;
      reject: (err: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private messageListeners: Set<(message: EmulatorMessage) => void> = new Set();

  memoryInfo?: MemoryInfo;
  cpuInfo?: CpuInfo;
  customRegisters?: CustomRegisters;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /**
   * Opens the VAmiga emulator webview panel
   */
  public open(options?: OpenOptions): void {
    const optionsWithDefaults = {
      ...defaultOptions,
      ...options,
    };
    if (!this.panel) {
      return this.initPanel(optionsWithDefaults);
    } else {
      const callParams = this.optionsToCallParams(optionsWithDefaults);
      this.sendCommand("load", callParams);
    }
  }

  /**
   * Brings the VAmiga webview panel to the foreground
   */
  public reveal(): void {
    this.panel?.reveal();
  }

  /**
   * Registers a listener for emulator messages
   * Unlike the panel's onDidReceiveMessage, this works even when panel is not yet open
   * @param callback Function to call when messages are received
   * @returns Disposable to unregister the listener
   */
  public onDidReceiveMessage(
    callback: (message: EmulatorMessage) => void,
  ): vscode.Disposable {
    this.messageListeners.add(callback);
    return {
      dispose: () => {
        this.messageListeners.delete(callback);
      },
    };
  }

  /**
   * Notifies all registered message listeners
   * @param message The emulator message to broadcast
   */
  private notifyMessageListeners(message: EmulatorMessage): void {
    for (const listener of this.messageListeners) {
      try {
        listener(message);
      } catch (error) {
        console.error("Error in message listener:", error);
      }
    }
  }

  public onDidDispose(callback: () => void): vscode.Disposable | undefined {
    return this.panel?.onDidDispose(callback);
  }

  /**
   * Sends a one-way command to the VAmiga emulator (no response expected)
   * @param command Command name to send
   * @param args Optional command arguments
   */
  public sendCommand<A = any>(command: string, args?: A): void {
    if (this.panel) {
      this.panel.webview.postMessage({ command, args });
    } else {
      vscode.window.showErrorMessage("Emulator panel is not open");
    }
  }

  /**
   * Atomically cleans up a pending RPC and returns its handlers if found.
   * Prevents race conditions between timeout and response handling.
   * @param rpcId The RPC ID to clean up
   * @returns The pending RPC handlers, or null if already cleaned up
   */
  private cleanupPendingRpc(rpcId: string): {
    resolve: (result: any) => void;
    reject: (err: Error) => void;
    timeout: NodeJS.Timeout;
  } | null {
    const pending = this.pendingRpcs.get(rpcId);
    if (!pending) return null; // Already cleaned up

    this.pendingRpcs.delete(rpcId);
    clearTimeout(pending.timeout);
    return pending;
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
      if (!this.panel) {
        reject(new Error("Emulator panel is not open"));
        return;
      }

      const id = Math.random().toString(36).substring(2, 15);
      const timeout = setTimeout(() => {
        const pending = this.cleanupPendingRpc(id);
        if (pending) {
          pending.reject(
            new Error(`RPC timeout after ${timeoutMs}ms: ${command}`),
          );
        }
      }, timeoutMs);

      this.pendingRpcs.set(id, { resolve, reject, timeout });
      this.panel.webview.postMessage({
        command,
        args: { ...args, _rpcId: id },
      });
    });
  }

  public dispose(): void {
    // Clean up any pending RPCs
    for (const [_, pending] of this.pendingRpcs) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Webview disposed"));
    }
    this.pendingRpcs.clear();

    this.panel?.dispose();
  }

  // Wasm commands:

  /**
   * Pause the emulator
   */
  public pause(): void {
    this.invalidateCache();
    this.sendCommand("pause");
  }

  /**
   * Resume running the emulator
   */
  public run(): void {
    this.invalidateCache();
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
   * @param vector Exception vector number (e.g. 2 for bus error)
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
    this.invalidateCache();
    this.sendCommand("stepInto");
  }

  /**
   * Restore previous stopped state
   */
  public async stepBack(): Promise<boolean> {
    this.invalidateCache();
    return this.sendRpcCommand("stepBack");
  }

  /**
   * Continue stepping back until breakpoint, or start of history
   */
  public async continueReverse(): Promise<boolean> {
    this.invalidateCache();
    return this.sendRpcCommand("continueReverse");
  }

  /**
   * Run to end of frame
   */
  public eof(): void {
    this.invalidateCache();
    this.sendCommand("eof");
  }

  /**
   * Run to end of line
   */
  public eol(): void {
    this.invalidateCache();
    this.sendCommand("eol");
  }

  /**
   * Enables/disables CPU instruction logging
   * @param enabled True to enable logging, false to disable
   */
  public enableCpuLogging(enabled: boolean): void {
    this.sendCommand("enableCpuLogging", { enabled });
  }

  /**
   * Get CPU instruction trace log
   * @returns Promise resolving to array of CPU trace items
   */
  public async getCpuTrace(count = 256): Promise<CpuTraceItem[]> {
    const res = await this.sendRpcCommand("getCpuTrace", { count });
    return res.trace;
  }

  /**
   * Gets the current CPU state including registers and flags
   * @returns Promise resolving to CPU information
   */
  public async getCpuInfo(): Promise<CpuInfo> {
    if (!this.cpuInfo) {
      this.cpuInfo = await this.sendRpcCommand("getCpuInfo");
    }
    return this.cpuInfo;
  }

  /**
   * Gets the memory information from emulator
   * @returns Promise resolving to memory information
   */
  public async getMemoryInfo(): Promise<MemoryInfo> {
    return this.sendRpcCommand("getMemoryInfo");
  }

  /**
   * Gets all custom chip registers (e.g. DMACON, INTENA, etc.)
   * @returns Promise resolving to custom register values
   */
  public async getAllCustomRegisters(): Promise<CustomRegisters> {
    if (!this.customRegisters) {
      this.customRegisters = await this.sendRpcCommand("getAllCustomRegisters");
    }
    return this.customRegisters;
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
    this.cpuInfo = undefined; // Clear cache
    return this.sendRpcCommand("setRegister", { name, value });
  }

  /**
   * Sets a custom chip register to the specified 16 bit value
   * @param address Register address (e.g. 0xdff180)
   * @param value New register value
   * @returns Promise resolving to set status
   */
  public async pokeCustom16(
    address: number,
    value: number,
  ): Promise<RegisterSetStatus> {
    this.customRegisters = undefined; // Clear cache
    return this.sendRpcCommand("pokeCustom16", { address, value });
  }
  /**
   * Sets a custom chip register to the specified 32 bit value
   * @param address Register address (e.g. 0xdff180)
   * @param value New register value
   * @returns Promise resolving to set status
   */
  public async pokeCustom32(
    address: number,
    value: number,
  ): Promise<RegisterSetStatus> {
    this.customRegisters = undefined; // Clear cache
    return this.sendRpcCommand("pokeCustom32", { address, value });
  }

  /**
   * Reads memory from the specified address
   * @param address Starting memory address
   * @param count Number of bytes to read
   * @returns Promise resolving to memory data (Buffer)
   */
  public async readMemory(address: number, count: number): Promise<Buffer> {
    const res = await this.sendRpcCommand("readMemory", { address, count });
    return Buffer.from(res.data);
  }

  /**
   * Writes memory at the specified address
   * @param address Starting memory address
   * @param data Data buffer to write
   */
  public async writeMemory(address: number, data: Buffer): Promise<void> {
    return this.sendRpcCommand("writeMemory", {
      address,
      data: new Uint8Array(data),
    });
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
    return await this.sendRpcCommand("poke32", { address, value: u32(value) });
  }

  /**
   * Writes word at the specified address
   * @param address Starting memory address
   * @param value numeric value to write
   */
  public async poke16(address: number, value: number): Promise<void> {
    return this.sendRpcCommand("poke16", { address, value: u16(value) });
  }

  /**
   * Writes byte at the specified address
   * @param address Starting memory address
   * @param value numeric value to write
   */
  public async poke8(address: number, value: number): Promise<void> {
    return this.sendRpcCommand("poke8", { address, value: u8(value) });
  }

  /**
   * Jump CPU to specified address
   * @param address Starting memory address
   */
  public async jump(address: number): Promise<void> {
    this.invalidateCache();
    return this.sendRpcCommand("jump", { address });
  }

  /**
   * Disassembles CPU instructions starting at the specified address
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

  /**
   * Disassembles copper instructions starting at the specified address
   * @param address Starting memory address
   * @param count Number of instructions to disassemble
   * @returns Promise resolving to disassembly result
   */
  public async disassembleCopper(
    address: number,
    count: number,
  ): Promise<Disassembly> {
    return this.sendRpcCommand("disassembleCopper", { address, count });
  }

  public getCachedMemoryInfo(): MemoryInfo | undefined {
    return this.memoryInfo;
  }

  public isValidAddress(address: number): boolean {
    if (this.memoryInfo) {
      // Check mem type of bank
      const bank = address >>> 16;
      const type = this.memoryInfo.cpuMemSrc[bank];
      return type !== MemSrc.NONE;
    } else {
      // Any 24 bit address
      return address >= 0 && address < 0x1000_0000;
    }
  }

  /**
   * Get the contiguous memory region bounds for a given address
   * Returns the start and end addresses of the continuous block of the same memory type
   */
  public getMemoryRegion(
    address: number,
  ): { start: number; end: number } | null {
    if (!this.memoryInfo) {
      // Default to 16MB address space
      return { start: 0, end: 0x1000_0000 };
    }

    const bank = address >>> 16;
    const type = this.memoryInfo.cpuMemSrc[bank];

    if (type === MemSrc.NONE) {
      return null; // Invalid address
    }

    // Find the start of this memory region (scan backwards)
    let startBank = bank;
    while (startBank > 0 && this.memoryInfo.cpuMemSrc[startBank - 1] === type) {
      startBank--;
    }

    // Find the end of this memory region (scan forwards)
    let endBank = bank;
    while (endBank < 255 && this.memoryInfo.cpuMemSrc[endBank + 1] === type) {
      endBank++;
    }

    return {
      start: startBank << 16,
      end: ((endBank + 1) << 16) - 1,
    };
  }

  // Helper methods:

  private initPanel(options: OpenOptions) {
    const column = this.getConfiguredViewColumn();

    const localResourceRoots = [
      this.extensionUri,
      ...(vscode.workspace.workspaceFolders?.map((folder) => folder.uri) || []),
    ];

    if (options.programPath) {
      if (!existsSync(options.programPath)) {
        throw new Error(
          `Program file not found: ${options.programPath}`,
        );
      }
      const progDir = dirname(options.programPath);
      localResourceRoots.push(vscode.Uri.file(progDir));
    }
    if (options.kickstartRomPath) {
      if (!existsSync(options.kickstartRomPath)) {
        throw new Error(
          `Kickstart ROM file not found: ${options.kickstartRomPath}`,
        );
      }
      const romDir = dirname(options.kickstartRomPath);
      localResourceRoots.push(vscode.Uri.file(romDir));
    }
    if (options.kickstartExtPath) {
      if (!existsSync(options.kickstartExtPath)) {
        throw new Error(
          `Kickstart extension ROM file not found: ${options.kickstartExtPath}`,
        );
      }
      const extDir = dirname(options.kickstartExtPath);
      localResourceRoots.push(vscode.Uri.file(extDir));
    }

    // Create new panel
    this.panel = vscode.window.createWebviewPanel(
      VAmiga.viewType,
      "VAmiga",
      {
        viewColumn: column,
        preserveFocus: true,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true, // Keep webview alive when hidden
        localResourceRoots,
      },
    );

    const callParams = this.optionsToCallParams(options);
    this.panel.webview.html = this.getHtmlForWebview(callParams);

    // Handle webview lifecycle
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    // Set up RPC response handler and message delegation
    this.panel.webview.onDidReceiveMessage((message) => {
      if (message.type === "rpcResponse") {
        const pending = this.cleanupPendingRpc(message.id);
        if (pending) {
          if (message.result?.error) {
            pending.reject(new Error(message.result.error));
          } else {
            pending.resolve(message.result);
          }
        }
      } else if (message.type === "exec-ready") {
        // Only need to fetch memory info once on load
        this.getMemoryInfo()
          .then((memoryInfo) => {
            this.memoryInfo = memoryInfo;
          })
          .catch((error) => {
            console.error("Failed to fetch memory info on exec-ready:", error);
          });
      }

      // Notify all registered listeners about this message
      this.notifyMessageListeners(message);
    });
  }

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
    if (!this.panel) {
      throw new Error("Panel not initialized");
    }
    if (!existsSync(absolutePath)) {
      throw new Error(`File not found: ${absolutePath}`);
    }
    const fileUri = vscode.Uri.file(absolutePath);
    return this.panel.webview.asWebviewUri(fileUri);
  }

  private getHtmlForWebview(callParams: CallParams): string {
    if (!this.panel) {
      throw new Error("Panel not initialized");
    }

    const vamigaUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "vamiga"),
    );

    // Read the HTML template from the vamiga directory
    const templatePath = join(
      this.extensionUri.fsPath,
      "vamiga",
      "vAmiga.html",
    );
    let htmlContent = readFileSync(templatePath, "utf8");

    // Replace template variables
    htmlContent = htmlContent.replace(/\$\{vamigaUri\}/g, vamigaUri.toString());
    htmlContent = htmlContent.replace(
      "__CALL_PARAMS__",
      JSON.stringify(callParams),
    );

    return htmlContent;
  }

  private optionsToCallParams(options: OpenOptions): CallParams {
    const params: CallParams = {
      AROS: options.useArosRom,
      navbar: options.showNavBar,
      wide: options.wideScreen,
      dark: options.darkMode,
      mouse: options.enableMouse,
      display: options.displayZoom,
      gpu: options.useGpu,
      agnus_revision: options.agnusRevision,
      denise_revision: options.deniseRevision,
      cpu_revision: options.cpuRevision
        ? cpuRevision[options.cpuRevision]
        : undefined,
      cpu_overclocking: options.cpuSpeed
        ? cpuSpeed[options.cpuSpeed]
        : undefined,
      chip_ram: options.chipRam ? chipRam[options.chipRam] : undefined,
      slow_ram: options.slowRam ? slowRam[options.slowRam] : undefined,
      fast_ram: options.fastRam ? fastRam[options.fastRam] : undefined,
      url: options.programPath
        ? this.absolutePathToWebviewUri(options.programPath).toString()
        : undefined,
      kickstart_rom_url: options.kickstartRomPath
        ? this.absolutePathToWebviewUri(options.kickstartRomPath).toString()
        : undefined,
      kickstart_ext_url: options.kickstartExtPath
        ? this.absolutePathToWebviewUri(options.kickstartExtPath).toString()
        : undefined,
    };
    return params;
  }

  private invalidateCache() {
    this.cpuInfo = undefined;
    this.customRegisters = undefined;
  }
}
