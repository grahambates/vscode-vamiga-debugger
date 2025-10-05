import { DebugProtocol } from "@vscode/debugprotocol";
import { CpuInfo, VAmiga } from "./vAmiga";
import { SourceMap, Location } from "./sourceMap";
import { Handles, Scope } from "@vscode/debugadapter";
import { vectors, customAddresses } from "./hardware";
import {
  formatHex,
  u32,
  u16,
  u8,
  i32,
  i16,
  i8,
  formatAddress,
  formatBin,
  formatNumber,
} from "./numbers";
import * as registerParsers from "./amigaRegisterParsers";
import { DisassemblyValue, MemoryArrayValue } from "./evaluateManager";

/**
 * Manages variable inspection and scoping for the debug adapter.
 *
 * Provides hierarchical variable views including:
 * - CPU registers (data, address, status, and special registers)
 * - Custom chip registers with bit-field breakdowns
 * - Interrupt vectors with address resolution
 * - Source symbols with pointer dereferencing
 * - Memory segments information
 */
// Type for array values from evaluate manager
export interface ArrayValue {
  type: "memArray" | "disassembly";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export class VariablesManager {
  private variableHandles = new Handles<string | ArrayValue>();
  private locationHandles = new Handles<Location>();

  /**
   * Creates a new VariablesManager instance.
   *
   * @param vAmiga VAmiga instance for reading registers and memory
   * @param sourceMap Source map for symbol resolution and address formatting
   */
  constructor(
    private vAmiga: VAmiga,
    private sourceMap: SourceMap,
  ) {}

  public getScopes(): DebugProtocol.Scope[] {
    return [
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
      new Scope("Symbols", this.variableHandles.create("symbols"), false),
      new Scope("Segments", this.variableHandles.create("segments"), false),
    ];
  }

  public async getVariables(
    variableReference: number,
  ): Promise<DebugProtocol.Variable[]> {
    const id = this.variableHandles.get(variableReference);

    // Check if this is an array value from evaluate manager
    if (typeof id === "object" && id !== null) {
      return this.getArrayVariables(id as ArrayValue);
    }

    if (id === "registers") {
      return await this.registerVariables();
    } else if (id.startsWith("data_reg_")) {
      return await this.dataRegVariables(id);
    } else if (id.startsWith("addr_reg_")) {
      return await this.addressRegVariables(id);
    } else if (id === "sr_flags") {
      return await this.srFlagVariables();
    } else if (id === "custom") {
      return await this.customVariables();
    } else if (id.startsWith("custom_reg_")) {
      return await this.customDetailVariables(id);
    } else if (id === "vectors") {
      return await this.vectorVariables();
    } else if (id === "symbols") {
      return await this.symbolVariables();
    } else if (id.startsWith("symbol_ptr_")) {
      return this.symbolPointerVariables(id);
    } else if (id === "segments") {
      return this.segmentVariables();
    }
    throw new Error(`Variable access error: Unknown variable ID: ${id}`);
  }

  public async setVariable(
    variableReference: number,
    name: string,
    value: number,
  ): Promise<string> {
    const id = this.variableHandles.get(variableReference);
    let res;
    if (id === "registers") {
      res = await this.vAmiga.setRegister(name, value);
      return res.value;
    } else if (id === "custom") {
      const custom = customAddresses[name as keyof typeof customAddresses];
      if (custom.long) {
        await this.vAmiga.pokeCustom32(custom.address, value);
        return formatHex(value);
      } else {
        await this.vAmiga.pokeCustom16(custom.address, value);
        return formatHex(value, 4);
      }
    } else {
      throw new Error("Variable access error: Variable is not writeable");
    }
  }

  public async registerVariables(): Promise<DebugProtocol.Variable[]> {
    const info = await this.vAmiga.getCpuInfo();
    return Object.keys(info).map((name) => {
      let value = String(info[name as keyof CpuInfo]);
      let variablesReference = 0;
      let memoryReference: string | undefined;

      if (name === "sr") {
        variablesReference = this.variableHandles.create(`sr_flags`);
      } else if (name.startsWith("d")) {
        variablesReference = this.variableHandles.create(`data_reg_${name}`);
      } else if (name.match(/(a[0-9]|pc|usp|msp|isp|vbr)/)) {
        variablesReference = this.variableHandles.create(`addr_reg_${name}`);
        const numVal = Number(value);
        if (this.vAmiga.isValidAddress(numVal)) {
          memoryReference = value;
          value = formatAddress(numVal, this.sourceMap);
        }
      }

      return {
        name,
        value,
        variablesReference,
        memoryReference,
      };
    });
  }

  public async dataRegVariables(id: string): Promise<DebugProtocol.Variable[]> {
    const info = await this.vAmiga.getCpuInfo();
    const name = id.replace("data_reg_", "");
    const value = Number(info[name as keyof CpuInfo]);
    return [
      this.castIntVar(value, i32),
      this.castIntVar(value, u32),
      this.castIntVar(value, i16),
      this.castIntVar(value, u16),
      this.castIntVar(value, i8),
      this.castIntVar(value, u8),
    ];
  }

  public async srFlagVariables(): Promise<DebugProtocol.Variable[]> {
    const info = await this.vAmiga.getCpuInfo();
    const sr = Number(info.sr);

    // Extract individual CPU flags from status register (68000 format)
    const boolFlags = [
      { name: "carry", value: (sr & 0x0001) !== 0 }, // C flag (bit 0)
      { name: "overflow", value: (sr & 0x0002) !== 0 }, // V flag (bit 1)
      { name: "zero", value: (sr & 0x0004) !== 0 }, // Z flag (bit 2)
      { name: "negative", value: (sr & 0x0008) !== 0 }, // N flag (bit 3)
      { name: "extend", value: (sr & 0x0010) !== 0 }, // X flag (bit 4)
      { name: "trace1", value: (sr & 0x8000) !== 0 }, // T1 flag (bit 15)
      { name: "trace0", value: (sr & 0x4000) !== 0 }, // T0 flag (bit 14) - 68020+
      { name: "supervisor", value: (sr & 0x2000) !== 0 }, // S flag (bit 13)
      { name: "master", value: (sr & 0x1000) !== 0 }, // M flag (bit 12) - 68020+
    ];
    const interruptMask = (sr >> 8) & 0x07; // IPL (bits 8-10)
    return [
      ...boolFlags.map(({ name, value }) => ({
        name,
        value: String(value),
        variablesReference: 0,
        presentationHint: { attributes: ["readOnly"] },
      })),
      {
        name: "interruptMask",
        value: formatBin(interruptMask),
        variablesReference: 0,
        presentationHint: { attributes: ["readOnly"] },
      },
    ];
  }

  public async addressRegVariables(
    id: string,
  ): Promise<DebugProtocol.Variable[]> {
    const info = await this.vAmiga.getCpuInfo();
    const name = id.replace("addr_reg_", "");
    const value = Number(info[name as keyof CpuInfo]);
    const variables = [
      this.castIntVar(value, i32),
      this.castIntVar(value, u32),
      this.castIntVar(value, i16),
      this.castIntVar(value, u16),
    ];
    const symbolOffset = this.sourceMap?.findSymbolOffset(value);
    if (symbolOffset) {
      let value = symbolOffset.symbol;
      if (symbolOffset.offset) {
        value += "+" + symbolOffset.offset;
      }
      variables.unshift({
        name: "offset",
        value,
        variablesReference: 0,
        presentationHint: { attributes: ["readOnly"] },
      });
    }
    return variables;
  }

  public async customVariables(): Promise<DebugProtocol.Variable[]> {
    const info = await this.vAmiga.getAllCustomRegisters();
    const variables = Object.keys(info).map((name): DebugProtocol.Variable => {
      let value = info[name].value;
      let memoryReference: string | undefined;
      let variablesReference = 0;

      // Check if this register has bit breakdown support
      if (registerParsers.hasRegisterBitBreakdown(name)) {
        variablesReference = this.variableHandles.create(`custom_reg_${name}`);
      }

      // Handle longword values as addresses
      if (value.length > 6) {
        memoryReference = value;
        value = formatAddress(Number(value), this.sourceMap);
      }
      return {
        name,
        value,
        variablesReference,
        memoryReference,
      };
    });
    // Sort by name
    // TODO: could make this a setting
    variables.sort((a, b) => (a.name < b.name ? -1 : 1));
    return variables;
  }

  public async customDetailVariables(id: string) {
    const info = await this.vAmiga.getAllCustomRegisters();
    const regName = id.replace("custom_reg_", "");
    const regValue = Number(info[regName].value);
    const bits = registerParsers.parseRegister(regName, regValue);
    return bits.map(({ name, value }) => ({
      name,
      value: String(value),
      variablesReference: 0,
      presentationHint: { attributes: ["readOnly"] },
    }));
  }

  public async vectorVariables() {
    const variables: DebugProtocol.Variable[] = [];
    const cpuInfo = await this.vAmiga.getCpuInfo();
    const mem = await this.vAmiga.readMemory(
      Number(cpuInfo.vbr),
      vectors.length * 4,
    );
    for (let i = 0; i < vectors.length; i++) {
      const name = vectors[i];
      if (name) {
        const value = mem.readInt32BE(i * 4);
        variables.push({
          name: `${formatHex(i * 4, 2).replace("0x", "")}: ${name}`,
          value: formatAddress(value, this.sourceMap),
          memoryReference: formatHex(value),
          variablesReference: 0,
        });
      }
    }
    return variables;
  }

  public async symbolVariables(): Promise<DebugProtocol.Variable[]> {
    const symbolLengths = this.sourceMap.getSymbolLengths();
    const symbols = this.sourceMap.getSymbols();
    const variables = await Promise.all(
      Object.keys(symbols).map(async (name) => {
        let value = formatHex(symbols[name]);
        const length = symbolLengths?.[name] ?? 0;
        let variablesReference = 0;
        const memoryReference = value;

        if (length === 1 || length === 2 || length === 4) {
          let ptrVal: number;
          if (length === 4) {
            ptrVal = await this.vAmiga.peek32(symbols[name]);
          } else if (length === 2) {
            ptrVal = await this.vAmiga.peek16(symbols[name]);
          } else {
            ptrVal = await this.vAmiga.peek8(symbols[name]);
          }
          if (length === 4) {
            value += " -> " + formatAddress(ptrVal, this.sourceMap);
          } else {
            value += " -> " + formatHex(ptrVal, length * 2);
          }
          variablesReference = this.variableHandles.create(
            `symbol_ptr_${name}:${length}:${ptrVal}`,
          );
        }

        const variable: DebugProtocol.Variable = {
          name,
          value,
          memoryReference,
          presentationHint: { attributes: ["readOnly"] },
          variablesReference,
        };
        const loc = this.sourceMap?.lookupAddress(symbols[name]);
        if (loc) {
          variable.declarationLocationReference = loc
            ? this.locationHandles.create(loc)
            : undefined;
        }
        return variable;
      }),
    );
  // Sort by name
  // TODO: could make this a setting
    variables.sort((a, b) => (a.name < b.name ? -1 : 1));
    return variables;
  }

  public symbolPointerVariables(id: string): DebugProtocol.Variable[] {
    const [_name, lengthStr, valueStr] = id
      .replace("symbol_ptr_", "")
      .split(":");
    const length = Number(lengthStr);
    const value = Number(valueStr);

    if (length === 4) {
      return [this.castIntVar(value, u32), this.castIntVar(value, i32)];
    } else if (length === 2) {
      return [this.castIntVar(value, u16), this.castIntVar(value, i16)];
    } else {
      return [this.castIntVar(value, u8), this.castIntVar(value, i8)];
    }
  }

  public segmentVariables(): DebugProtocol.Variable[] {
    const segments = this.sourceMap.getSegmentsInfo();
    return segments.map((seg) => {
      const value = formatHex(seg.address);
      return {
        name: seg.name,
        value,
        memoryReference: value,
        variablesReference: 0,
        presentationHint: { attributes: ["readOnly"] },
      };
    });
  }

  /**
   * Builds a complete variable lookup table for expression evaluation.
   *
   * @returns Record mapping variable names to their numeric values
   */
  public async getFlatVariables(): Promise<Record<string, number>> {
    const variables: Record<string, number> = {};
    const cpuInfo = await this.vAmiga.getCpuInfo();
    const customRegs = await this.vAmiga.getAllCustomRegisters();
    const symbols = this.sourceMap?.getSymbols() ?? {};
    for (const k in cpuInfo) {
      variables[k] = Number(cpuInfo[k as keyof CpuInfo]);
    }
    for (const k in customRegs) {
      variables[k] = Number(customRegs[k]?.value);
    }
    for (const k in symbols) {
      variables[k] = Number(symbols[k]);
    }
    variables.sp = variables.a7;
    return variables;
  }

  public getVariableReference(variableReference: number): string | ArrayValue {
    return this.variableHandles.get(variableReference);
  }

  public getLocationReference(locationReference: number): Location {
    return this.locationHandles.get(locationReference);
  }

  /**
   * Creates a handle for array values from evaluate manager.
   * @param arrayValue The array value to register
   * @returns The variables reference handle
   */
  public createArrayHandle(arrayValue: ArrayValue): number {
    return this.variableHandles.create(arrayValue);
  }

  /**
   * Gets variables for an array value registered by evaluate manager.
   */
  private getArrayVariables(arrayValue: ArrayValue): DebugProtocol.Variable[] {
    if (arrayValue.type === "disassembly") {
      return this.getDisassemblyVariables(arrayValue.data);
    } else if (arrayValue.type === "memArray") {
      return this.getMemArrayVariables(arrayValue.data);
    }
    return [];
  }

  private castIntVar(
    value: number,
    fn: (v: number) => number,
  ): DebugProtocol.Variable {
    return {
      name: fn.name,
      value: fn(value).toString(),
      variablesReference: 0,
      presentationHint: { attributes: ["readOnly"] },
    };
  }

  private getDisassemblyVariables(
    arrayData: DisassemblyValue,
  ): DebugProtocol.Variable[] {
    const variables: DebugProtocol.Variable[] = [];
    // Find the maximum width of instruction bytes for alignment
    const maxHexWidth = Math.max(
      ...arrayData.instructions.map(
        (instr) => (instr.instructionBytes || "").length,
      ),
    );

    for (let i = 0; i < arrayData.instructions.length; i++) {
      const instr = arrayData.instructions[i];
      const address = instr.address;
      const hexBytes = (instr.instructionBytes || "").padEnd(maxHexWidth, " ");

      variables.push({
        name: address,
        value: `${hexBytes} ${instr.instruction}`,
        memoryReference: address,
        variablesReference: 0,
        presentationHint: { attributes: ["readOnly"] },
      });
    }

    return variables;
  }

  private getMemArrayVariables(
    arrayData: MemoryArrayValue,
  ): DebugProtocol.Variable[] {
    // Handle array results
    const { elements, elementSize, baseAddress, valuesPerLine = 1 } = arrayData;
    if (!elements || !elementSize) {
      return [];
    }

    const variables: DebugProtocol.Variable[] = [];

    // Group elements by valuesPerLine
    for (let i = 0; i < elements.length; i += valuesPerLine) {
      const groupElements = elements.slice(i, i + valuesPerLine);
      const groupStartAddr = baseAddress + i * elementSize;

      if (valuesPerLine === 1) {
        // Single element per line - show both hex and decimal for better debugging
        const value = groupElements[0];

        let displayValue: string;
        if (elementSize === 4 && this.vAmiga.isValidAddress(value)) {
          displayValue = formatAddress(value, this.sourceMap);
        } else {
          displayValue = formatNumber(value, elementSize * 2);
        }

        variables.push({
          name: `[${i}]`,
          value: displayValue,
          memoryReference: formatHex(groupStartAddr),
          variablesReference: 0,
          presentationHint: { attributes: ["readOnly"] },
        });
      } else {
        // Multiple elements per line - traditional hex listing style
        const groupValues = groupElements.map((value) => {
          if (elementSize === 4 && this.vAmiga.isValidAddress(value)) {
            return formatAddress(value, this.sourceMap);
          } else {
            // Remove 0x prefix for cleaner table view
            return value
              .toString(16)
              .padStart(elementSize * 2, "0")
              .toUpperCase();
          }
        });

        // Use hex offset as label for traditional hex dump style
        const offsetLabel = groupStartAddr
          .toString(16)
          .padStart(8, "0")
          .toUpperCase();
        const groupValue = groupValues.join(" ");

        variables.push({
          name: offsetLabel,
          value: groupValue,
          memoryReference: formatHex(groupStartAddr),
          variablesReference: 0,
          presentationHint: { attributes: ["readOnly"], kind: "virtual" },
        });
      }
    }
    return variables;
  }
}
