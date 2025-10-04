/* eslint-disable @typescript-eslint/no-explicit-any */
import * as vscode from "vscode";
import { DebugProtocol } from "@vscode/debugprotocol";
import { Parser } from "expr-eval";
import { instructionAttrs } from "./sourceParsing";
import {
  formatAddress,
  formatHex,
  formatNumber,
  i16,
  i32,
  i8,
  u16,
  u32,
  u8,
} from "./numbers";
import { VAmiga } from "./vAmiga";
import { SourceMap } from "./sourceMap";
import { VariablesManager } from "./variablesManager";
import { DisassemblyManager } from "./disassemblyManager";

/**
 * Result of evaluating an expression in the debug context.
 */
export interface EvaluateResult {
  /** Numeric value of the expression, if successfully evaluated */
  value?: any;
  /** Memory reference string for values that represent addresses */
  memoryReference?: string;
  /** Type classification of the result for appropriate formatting */
  type: EvaluateResultType;
}

/**
 * Classification of expression evaluation results for appropriate formatting.
 */
export enum EvaluateResultType {
  /** Empty expression */
  EMPTY,
  /** Unknown or unclassified result */
  UNKNOWN,
  /** Result is a symbol address */
  SYMBOL,
  /** Result is a CPU data register (d0-d7) */
  DATA_REGISTER,
  /** Result is a CPU address register (a0-a7, pc, etc.) */
  ADDRESS_REGISTER,
  /** Result is a custom chip register */
  CUSTOM_REGISTER,
  /** Result from parsing a complex expression */
  PARSED,
}

export interface MemoryArrayValue {
  type: "memArray";
  elements: number[];
  elementSize: number;
  baseAddress: number;
  valuesPerLine?: number;
}

export interface DisassemblyValue {
  type: "disassembly";
  instructions: DebugProtocol.DisassembledInstruction[];
  baseAddress: number;
}

export function isMemoryArrayValue(value: unknown): value is MemoryArrayValue {
  return (
    typeof value === "object" && (value as MemoryArrayValue).type === "memArray"
  );
}

export function isDisassemblyValue(value: unknown): value is DisassemblyValue {
  return (
    typeof value === "object" &&
    (value as DisassemblyValue).type === "disassembly"
  );
}

// Validate argument count for each function
const requiredArgs: Record<
  string,
  { min: number; max: number; usage: string }
> = {
  peekU32: { min: 1, max: 1, usage: "peekU32(address)" },
  peekU16: { min: 1, max: 1, usage: "peekU16(address)" },
  peekU8: { min: 1, max: 1, usage: "peekU8(address)" },
  peekI32: { min: 1, max: 1, usage: "peekI32(address)" },
  peekI16: { min: 1, max: 1, usage: "peekI16(address)" },
  peekI8: { min: 1, max: 1, usage: "peekI8(address)" },
  poke32: { min: 2, max: 2, usage: "poke32(address, value)" },
  poke16: { min: 2, max: 2, usage: "poke16(address, value)" },
  poke8: { min: 2, max: 2, usage: "poke8(address, value)" },
  readBytes: {
    min: 2,
    max: 3,
    usage: "readBytes(address, count[, valuesPerLine])",
  },
  readWords: {
    min: 2,
    max: 3,
    usage: "readWords(address, count[, valuesPerLine])",
  },
  readLongs: {
    min: 2,
    max: 3,
    usage: "readLongs(address, count[, valuesPerLine])",
  },
  disassemble: { min: 1, max: 2, usage: "disassemble(address[, count])" },
  disassembleCopper: {
    min: 1,
    max: 2,
    usage: "disassembleCopper(address[, count])",
  },
};

const asyncFunctions = Object.keys(requiredArgs);

/**
 * Manages expression evaluation for the debug adapter.
 *
 * Handles evaluation of:
 * - Numeric literals and hex addresses
 * - CPU registers and custom chip registers
 * - Symbols from source maps
 * - Complex arithmetic expressions
 * - Memory access and type conversion functions
 */
export class EvaluateManager {
  private parser: Parser;

  /**
   * Creates a new EvaluateManager instance.
   *
   * @param vAmiga VAmiga instance for memory access and register reads
   * @param sourceMap Source map for symbol resolution and address formatting
   * @param variablesManager Variables manager for accessing flat variable data and registering array handles
   * @param disassemblyManager Disassembly manager for code inspection
   */
  constructor(
    private vAmiga: VAmiga,
    private sourceMap: SourceMap,
    private variablesManager: VariablesManager,
    private disassemblyManager: DisassemblyManager,
  ) {
    this.parser = new Parser();
    this.parser.functions = {
      u32,
      u16,
      u8,
      i32,
      i16,
      i8,
    };
  }

  /**
   * Evaluates an expression in the context of the current debug session.
   *
   * Supports:
   * - Numeric literals (decimal and hex)
   * - Memory dereferencing (0x1234 reads value at that address)
   * - CPU registers, custom registers, and symbols
   * - Complex expressions using the expr-eval parser
   * - Custom functions for memory access and type conversion
   *
   * @param expression The expression string to evaluate
   * @returns Evaluation result with value, type, and optional memory reference
   */
  public async evaluate(expression: string): Promise<EvaluateResult> {
    expression = expression.trim();
    if (expression === "") {
      return { type: EvaluateResultType.EMPTY };
    }
    let value: number | undefined;
    let memoryReference: string | undefined;
    let type = EvaluateResultType.UNKNOWN;

    if (expression.match(/^-?[0-9]+$/i)) {
      // Interpret decimal as numeric literal
      value = Number(expression);
    } else if (expression.match(/^0x[0-9a-f]+$/i)) {
      // Interpret hex as address:
      const address = Number(expression);
      // Read longword value at address
      const memData = await this.vAmiga.readMemory(address, 4);
      value = memData.readUInt32BE(0);
      memoryReference = formatHex(address);
    } else {
      const numVars = await this.variablesManager.getFlatVariables();

      if (expression in numVars) {
        // Exact match of variable
        value = numVars[expression];
        const cpuInfo = await this.vAmiga.getCpuInfo();
        const customRegs = await this.vAmiga.getAllCustomRegisters();
        const symbols = this.sourceMap?.getSymbols() ?? {};

        if (expression in symbols) {
          memoryReference = formatHex(value);
          type = EvaluateResultType.SYMBOL;
        } else if (expression in cpuInfo) {
          if (expression.match(/^(a[0-7]|pc|usp|msp|vbr)$/)) {
            type = EvaluateResultType.ADDRESS_REGISTER;
          } else {
            type = EvaluateResultType.DATA_REGISTER;
          }
        } else if (expression in customRegs) {
          type = EvaluateResultType.CUSTOM_REGISTER;
        }
      } else {
        // Complex expression - handle async functions manually
        const result = await this.evaluateExpression(expression, numVars);
        if (
          typeof result === "object" &&
          (result.type === "array" || result.type === "disassembly")
        ) {
          // Array or disassembly result - pass the object as the value for formatting
          return {
            value: result,
            type: EvaluateResultType.PARSED,
          };
        } else {
          value = result as number;
          type = EvaluateResultType.PARSED;
        }
      }
    }
    return { value, memoryReference, type };
  }

  /**
   * Evaluates an expression and returns formatted result for Debug Adapter Protocol.
   *
   * Formats results based on expression type:
   * - Data registers: hex + decimal values
   * - Address registers: formatted addresses with symbol information
   * - Symbols: addresses with pointer dereferencing for known types
   * - Custom registers: hex values
   * - Parsed expressions: hex + decimal values
   *
   * @param args Evaluation request arguments from DAP
   * @returns Formatted evaluation response for DAP
   */
  public async evaluateFormatted({
    expression,
    context,
    source,
    line,
  }: DebugProtocol.EvaluateRequest["arguments"]): Promise<
    DebugProtocol.EvaluateResponse["body"]
  > {
    const {
      value,
      memoryReference,
      type: resultType,
    } = await this.evaluate(expression);

    if (value === undefined) {
      // Empty result
      return {
        result: "",
        variablesReference: 0,
      };
    }

    let result: string;
    let byteLength: number | undefined;
    let signed = false;

    // For hover context we can look at the source to determine how the value is used and get length/sign
    if (context === "hover" && source?.path && line) {
      const document = await vscode.workspace.openTextDocument(source.path);
      const docLine = document.lineAt(line - 1);
      const attrs = instructionAttrs(docLine.text);
      signed = attrs.signed;
      byteLength = attrs.byteLength;
    }

    if (resultType === EvaluateResultType.ADDRESS_REGISTER) {
      result = formatAddress(value, this.sourceMap);
    } else if (resultType === EvaluateResultType.DATA_REGISTER) {
      result = this.formatDataRegister(value, signed, byteLength);
    } else if (resultType === EvaluateResultType.SYMBOL) {
      result = await this.formatSymbol(value, expression, signed, byteLength);
    } else if (resultType === EvaluateResultType.CUSTOM_REGISTER) {
      result = formatHex(value, 4);
    } else {
      // Default - parsed expression result
      if (isDisassemblyValue(value)) {
        return this.handleDisassemblyResult(value);
      } else if (isMemoryArrayValue(value)) {
        return this.handleMemArrayResult(value);
      } else if (typeof value === "number") {
        // Show numeric result as hex and decimal
        result = formatNumber(value);
      } else {
        // Default
        result = String(value);
      }
    }

    return {
      result,
      memoryReference,
      variablesReference: 0,
    };
  }

  private formatDataRegister(
    value: number,
    signed: boolean,
    byteLength?: number,
  ): string {
    let sizedValue: number;
    // Length from hover context
    if (byteLength === 1) {
      sizedValue = signed ? i8(value) : u8(value);
    } else if (byteLength === 2) {
      sizedValue = signed ? i16(value) : u16(value);
    } else {
      // default to longword
      sizedValue = signed ? i32(value) : u32(value);
      byteLength = 4;
    }
    return formatNumber(sizedValue, byteLength * 2);
  }

  private async formatSymbol(
    value: number,
    symbolName: string,
    signed: boolean,
    byteLength?: number,
  ): Promise<string> {
    // longword address
    let result = formatHex(value, 8);

    // Show value for b/w/l pointer
    // Get length from hover context or symbol lengths
    if (!byteLength) {
      const symbolLengths = this.sourceMap?.getSymbolLengths();
      byteLength = symbolLengths?.[symbolName] ?? 0;
    }

    if (byteLength === 1 || byteLength === 2 || byteLength === 4) {
      let ptrVal: number;
      if (byteLength === 4) {
        ptrVal = await this.vAmiga.peek32(value);
        if (signed) ptrVal = i32(ptrVal);
      } else if (byteLength === 2) {
        ptrVal = await this.vAmiga.peek16(value);
        if (signed) ptrVal = i16(ptrVal);
      } else {
        ptrVal = await this.vAmiga.peek8(value);
        if (signed) ptrVal = i8(ptrVal);
      }
      if (byteLength === 4) {
        result += " -> " + formatAddress(ptrVal, this.sourceMap);
      } else {
        result += " -> " + formatHex(ptrVal, byteLength * 2);
      }
    }

    return result;
  }

  private handleMemArrayResult(
    value: MemoryArrayValue,
  ): DebugProtocol.EvaluateResponse["body"] {
    // Handle array results
    const elementTypeName =
      value.elementSize === 1
        ? "byte"
        : value.elementSize === 2
          ? "word"
          : "long";

    // Create preview of first few elements
    const previewCount = Math.min(4, value.elements.length);
    const previewElements = value.elements
      .slice(0, previewCount)
      .map((val: number) => formatHex(val, value.elementSize * 2));
    const preview = previewElements.join(" ");
    const ellipsis = value.elements.length > previewCount ? "..." : "";

    const result = `${elementTypeName}[${value.elements.length}] @ ${formatHex(value.baseAddress)} = [${preview}${ellipsis}]`;

    // Register with variables manager for handle management
    const handle = this.variablesManager.createArrayHandle({
      type: "memArray",
      data: value,
    });

    // Calculate number of rows for indexedVariables
    const valuesPerLine = value.valuesPerLine || 1;
    const numberOfRows = Math.ceil(value.elements.length / valuesPerLine);

    return {
      result,
      memoryReference: formatHex(value.baseAddress),
      variablesReference: handle,
      indexedVariables: numberOfRows,
    };
  }

  private handleDisassemblyResult(
    value: DisassemblyValue,
  ): DebugProtocol.EvaluateResponse["body"] {
    // Handle disassembly results
    const instructions = value.instructions;
    const firstInstruction =
      instructions.length > 0 ? instructions[0].instruction : "no instructions";
    const ellipsis = instructions.length > 1 ? "..." : "";

    const result = `disassembly[${instructions.length}] @ ${formatHex(value.baseAddress)} = ${firstInstruction}${ellipsis}`;

    // Register with variables manager for handle management
    const handle = this.variablesManager.createArrayHandle({
      type: "disassembly",
      data: value,
    });

    return {
      result,
      memoryReference: formatHex(value.baseAddress),
      variablesReference: handle,
      indexedVariables: instructions.length,
    };
  }

  /**
   * Evaluates complex expressions with async function support.
   *
   * Handles expressions containing memory access functions like peekU32, peekU16, etc.
   * with proper recursive evaluation to support nested async calls.
   *
   * @param expression The expression string to evaluate
   * @param variables Variable lookup table
   * @returns Promise resolving to the expression result
   */
  private async evaluateExpression(
    expression: string,
    variables: Record<string, number>,
  ): Promise<any | MemoryArrayValue | DisassemblyValue> {
    // Check if expression contains async functions
    const hasAsyncFunctions = asyncFunctions.some((fn) =>
      expression.includes(fn),
    );

    if (!hasAsyncFunctions) {
      // No async functions, use standard expr-eval
      const expr = this.parser.parse(expression);
      return expr.evaluate(variables);
    }

    // Find the innermost async function call (one with no nested async calls)
    const innermostCall = this.findInnermostAsyncCall(expression);

    if (!innermostCall) {
      // No more async calls, evaluate normally
      const expr = this.parser.parse(expression);
      return expr.evaluate(variables);
    }

    // Evaluate the innermost async call
    const callValue = await this.evaluateAsyncCall(
      innermostCall.func,
      innermostCall.args,
      variables,
    );

    // If this is an array or disassembly result and it's the whole expression, return it
    if (isDisassemblyValue(callValue) || isMemoryArrayValue(callValue)) {
      // Check if this function call is the entire expression
      if (
        innermostCall.start === 0 &&
        innermostCall.end === expression.length
      ) {
        return callValue;
      } else {
        // Array and disassembly functions can't be part of larger expressions
        throw new Error(
          `Functions like ${innermostCall.func} cannot be used in complex expressions`,
        );
      }
    }

    // Replace the call with its value and recursively evaluate the rest
    const newExpression =
      expression.substring(0, innermostCall.start) +
      (callValue as number).toString() +
      expression.substring(innermostCall.end);

    return this.evaluateExpression(newExpression, variables);
  }

  /**
   * Finds the innermost async function call (one with no nested async calls in its arguments).
   */
  private findInnermostAsyncCall(
    expression: string,
  ): { start: number; end: number; func: string; args: string[] } | null {
    const funcRegex = new RegExp(`(${asyncFunctions.join("|")})\\s*\\(`, "g");
    let match;

    while ((match = funcRegex.exec(expression)) !== null) {
      const func = match[1];
      const start = match.index;
      const openParenPos = match.index + match[0].length - 1;

      // Find the matching closing parenthesis
      let parenCount = 1;
      let pos = openParenPos + 1;
      let argsStr = "";

      while (pos < expression.length && parenCount > 0) {
        const char = expression[pos];
        if (char === "(") {
          parenCount++;
        } else if (char === ")") {
          parenCount--;
        }

        if (parenCount > 0) {
          argsStr += char;
        }
        pos++;
      }

      if (parenCount === 0) {
        // Check if this call's arguments contain any async functions
        const hasNestedAsync = asyncFunctions.some((fn) =>
          argsStr.includes(fn),
        );

        if (!hasNestedAsync) {
          // This is an innermost call
          // Split arguments
          const args = argsStr
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== "");
          return {
            start,
            end: pos,
            func,
            args,
          };
        }
      }
    }

    return null;
  }

  /**
   * Evaluates a single async function call.
   */
  private async evaluateAsyncCall(
    func: string,
    args: string[],
    variables: Record<string, number>,
  ): Promise<any | MemoryArrayValue | DisassemblyValue> {
    const argSpec = requiredArgs[func];
    if (argSpec) {
      if (args.length < argSpec.min) {
        throw new Error(
          `${func}() requires at least ${argSpec.min} argument${argSpec.min > 1 ? "s" : ""}. Usage: ${argSpec.usage}`,
        );
      }
      if (args.length > argSpec.max) {
        throw new Error(
          `${func}() accepts at most ${argSpec.max} argument${argSpec.max > 1 ? "s" : ""}. Usage: ${argSpec.usage}`,
        );
      }
    }

    switch (func) {
      case "peekU32": {
        const addrResult = await this.evaluateExpression(args[0], variables);
        if (typeof addrResult !== "number") {
          throw new Error("Peek function address must be a numeric expression");
        }
        return this.vAmiga.peek32(addrResult);
      }
      case "peekU16": {
        const addrResult = await this.evaluateExpression(args[0], variables);
        if (typeof addrResult !== "number") {
          throw new Error("Peek function address must be a numeric expression");
        }
        return this.vAmiga.peek16(addrResult);
      }
      case "peekU8": {
        const addrResult = await this.evaluateExpression(args[0], variables);
        if (typeof addrResult !== "number") {
          throw new Error("Peek function address must be a numeric expression");
        }
        return this.vAmiga.peek8(addrResult);
      }
      case "peekI32": {
        const addrResult = await this.evaluateExpression(args[0], variables);
        if (typeof addrResult !== "number") {
          throw new Error("Peek function address must be a numeric expression");
        }
        return i32(await this.vAmiga.peek32(addrResult));
      }
      case "peekI16": {
        const addrResult = await this.evaluateExpression(args[0], variables);
        if (typeof addrResult !== "number") {
          throw new Error("Peek function address must be a numeric expression");
        }
        return i16(await this.vAmiga.peek16(addrResult));
      }
      case "peekI8": {
        const addrResult = await this.evaluateExpression(args[0], variables);
        if (typeof addrResult !== "number") {
          throw new Error("Peek function address must be a numeric expression");
        }
        return i8(await this.vAmiga.peek8(addrResult));
      }
      case "poke32": {
        const addrResult = await this.evaluateExpression(args[0], variables);
        const valueResult = await this.evaluateExpression(args[1], variables);
        if (typeof addrResult !== "number" || typeof valueResult !== "number") {
          throw new Error(
            "Poke function arguments must be numeric expressions",
          );
        }
        await this.vAmiga.poke32(addrResult, valueResult);
        return valueResult;
      }
      case "poke16": {
        const addrResult = await this.evaluateExpression(args[0], variables);
        const valueResult = await this.evaluateExpression(args[1], variables);
        if (typeof addrResult !== "number" || typeof valueResult !== "number") {
          throw new Error(
            "Poke function arguments must be numeric expressions",
          );
        }
        await this.vAmiga.poke16(addrResult, valueResult);
        return valueResult;
      }
      case "poke8": {
        const addrResult = await this.evaluateExpression(args[0], variables);
        const valueResult = await this.evaluateExpression(args[1], variables);
        if (typeof addrResult !== "number" || typeof valueResult !== "number") {
          throw new Error(
            "Poke function arguments must be numeric expressions",
          );
        }
        await this.vAmiga.poke8(addrResult, valueResult);
        return valueResult;
      }
      case "readBytes": {
        const addrResult = await this.evaluateExpression(args[0], variables);
        const countResult = await this.evaluateExpression(args[1], variables);
        const valuesPerLineResult = args[2]
          ? await this.evaluateExpression(args[2], variables)
          : 1;

        if (
          typeof addrResult !== "number" ||
          typeof countResult !== "number" ||
          typeof valuesPerLineResult !== "number"
        ) {
          throw new Error(
            "Array function arguments must be numeric expressions",
          );
        }

        const addr = addrResult;
        const count = countResult;
        const valuesPerLine = valuesPerLineResult;
        const buffer = await this.vAmiga.readMemory(addr, count);
        const elements: number[] = [];
        for (let i = 0; i < count; i++) {
          elements.push(buffer.readUInt8(i));
        }
        return {
          type: "memArray",
          elements,
          elementSize: 1,
          baseAddress: addr,
          valuesPerLine,
        };
      }
      case "readWords": {
        const addrResult = await this.evaluateExpression(args[0], variables);
        const countResult = await this.evaluateExpression(args[1], variables);
        const valuesPerLineResult = args[2]
          ? await this.evaluateExpression(args[2], variables)
          : 1;

        if (
          typeof addrResult !== "number" ||
          typeof countResult !== "number" ||
          typeof valuesPerLineResult !== "number"
        ) {
          throw new Error(
            "Array function arguments must be numeric expressions",
          );
        }

        const addr = addrResult;
        const count = countResult;
        const valuesPerLine = valuesPerLineResult;
        const buffer = await this.vAmiga.readMemory(addr, count * 2);
        const elements: number[] = [];
        for (let i = 0; i < count; i++) {
          elements.push(buffer.readUInt16BE(i * 2));
        }
        return {
          type: "memArray",
          elements,
          elementSize: 2,
          baseAddress: addr,
          valuesPerLine,
        };
      }
      case "readLongs": {
        const addrResult = await this.evaluateExpression(args[0], variables);
        const countResult = await this.evaluateExpression(args[1], variables);
        const valuesPerLineResult = args[2]
          ? await this.evaluateExpression(args[2], variables)
          : 1;

        if (
          typeof addrResult !== "number" ||
          typeof countResult !== "number" ||
          typeof valuesPerLineResult !== "number"
        ) {
          throw new Error(
            "Array function arguments must be numeric expressions",
          );
        }

        const addr = addrResult;
        const count = countResult;
        const valuesPerLine = valuesPerLineResult;
        const buffer = await this.vAmiga.readMemory(addr, count * 4);
        const elements: number[] = [];
        for (let i = 0; i < count; i++) {
          elements.push(buffer.readUInt32BE(i * 4));
        }
        return {
          type: "memArray",
          elements,
          elementSize: 4,
          baseAddress: addr,
          valuesPerLine,
        };
      }
      case "disassemble": {
        const baseAddress = await this.evaluateExpression(args[0], variables);
        const count = args[1]
          ? await this.evaluateExpression(args[1], variables)
          : 1;

        if (typeof baseAddress !== "number" || typeof count !== "number") {
          throw new Error(
            "Disassemble function arguments must be numeric expressions",
          );
        }

        const instructions = await this.disassemblyManager.disassemble(
          baseAddress,
          0,
          count,
        );

        return {
          type: "disassembly",
          instructions,
          baseAddress,
        };
      }
      case "disassembleCopper": {
        const baseAddress = await this.evaluateExpression(args[0], variables);
        const count = args[1]
          ? await this.evaluateExpression(args[1], variables)
          : 1;

        if (typeof baseAddress !== "number" || typeof count !== "number") {
          throw new Error(
            "Disassemble function arguments must be numeric expressions",
          );
        }

        const instructions = await this.disassemblyManager.disassembleCopper(
          baseAddress,
          count,
        );

        return {
          type: "disassembly",
          instructions,
          baseAddress,
        };
      }
      default:
        throw new Error(`Unknown async function: ${func}`);
    }
  }
}
