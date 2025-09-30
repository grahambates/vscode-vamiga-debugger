import * as vscode from "vscode";
import { DebugProtocol } from "@vscode/debugprotocol";
import { Parser } from "expr-eval";
import { instructionAttrs } from "./sourceParsing";
import {
  formatAddress,
  formatHex,
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

/**
 * Result of evaluating an expression in the debug context.
 */
export interface EvaluateResult {
  /** Numeric value of the expression, if successfully evaluated */
  value?: number;
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
   * @param variablesManager Variables manager for accessing flat variable data
   */
  constructor(
    private vAmiga: VAmiga,
    private sourceMap: SourceMap,
    private variablesManager: VariablesManager,
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
        result: '',
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
      result = formatHex(sizedValue, byteLength * 2) + " = " + sizedValue;
    } else if (resultType === EvaluateResultType.SYMBOL) {
      // longword address
      result = formatHex(value, 8);

      // Show value for b/w/l pointer
      // Get length from hover context or symbol lengths
      if (!byteLength) {
        const symbolLengths = this.sourceMap?.getSymbolLengths();
        byteLength = symbolLengths?.[expression] ?? 0;
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
    } else if (resultType === EvaluateResultType.CUSTOM_REGISTER) {
      result = formatHex(value, 4);
    } else {
      // default - show result as hex and decimal
      result = formatHex(value, 0) + " = " + value;
    }

    return {
      result,
      memoryReference,
      variablesReference: 0,
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
      const memData = await this.vAmiga.readMemoryBuffer(address, 4);
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
        value = await this.evaluateComplexExpression(expression, numVars);
        type = EvaluateResultType.PARSED;
      }
    }
    return { value, memoryReference, type };
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
  private async evaluateComplexExpression(expression: string, variables: Record<string, number>): Promise<number> {
    // Check if expression contains async functions
    const asyncFunctions = ['peekU32', 'peekU16', 'peekU8', 'peekI32', 'peekI16', 'peekI8', 'poke32', 'poke16', 'poke8'];
    const hasAsyncFunctions = asyncFunctions.some(fn => expression.includes(fn));
    
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
    const callValue = await this.evaluateAsyncCall(innermostCall.func, innermostCall.args, variables);
    
    // Replace the call with its value and recursively evaluate the rest
    const newExpression = expression.substring(0, innermostCall.start) + 
                         callValue.toString() + 
                         expression.substring(innermostCall.end);
    
    return this.evaluateComplexExpression(newExpression, variables);
  }

  /**
   * Finds the innermost async function call (one with no nested async calls in its arguments).
   */
  private findInnermostAsyncCall(expression: string): {start: number, end: number, func: string, args: string[]} | null {
    const asyncFunctions = ['peekU32', 'peekU16', 'peekU8', 'peekI32', 'peekI16', 'peekI8', 'poke32', 'poke16', 'poke8'];
    const funcRegex = new RegExp(`(${asyncFunctions.join('|')})\\s*\\(`, 'g');
    let match;
    
    while ((match = funcRegex.exec(expression)) !== null) {
      const funcName = match[1];
      const startPos = match.index;
      const openParenPos = match.index + match[0].length - 1;
      
      // Find the matching closing parenthesis
      let parenCount = 1;
      let pos = openParenPos + 1;
      let argsStr = '';
      
      while (pos < expression.length && parenCount > 0) {
        const char = expression[pos];
        if (char === '(') {
          parenCount++;
        } else if (char === ')') {
          parenCount--;
        }
        
        if (parenCount > 0) {
          argsStr += char;
        }
        pos++;
      }
      
      if (parenCount === 0) {
        // Check if this call's arguments contain any async functions
        const hasNestedAsync = asyncFunctions.some(fn => argsStr.includes(fn));
        
        if (!hasNestedAsync) {
          // This is an innermost call
          const args = funcName.startsWith('poke') ? argsStr.split(',').map(s => s.trim()) : [argsStr];
          return {
            start: startPos,
            end: pos,
            func: funcName,
            args
          };
        }
      }
    }
    
    return null;
  }

  /**
   * Evaluates a single async function call.
   */
  private async evaluateAsyncCall(func: string, args: string[], variables: Record<string, number>): Promise<number> {
    switch (func) {
      case 'peekU32': {
        const addr = await this.evaluateComplexExpression(args[0], variables);
        return this.vAmiga.peek32(addr);
      }
      case 'peekU16': {
        const addr = await this.evaluateComplexExpression(args[0], variables);
        return this.vAmiga.peek16(addr);
      }
      case 'peekU8': {
        const addr = await this.evaluateComplexExpression(args[0], variables);
        return this.vAmiga.peek8(addr);
      }
      case 'peekI32': {
        const addr = await this.evaluateComplexExpression(args[0], variables);
        return i32(await this.vAmiga.peek32(addr));
      }
      case 'peekI16': {
        const addr = await this.evaluateComplexExpression(args[0], variables);
        return i16(await this.vAmiga.peek16(addr));
      }
      case 'peekI8': {
        const addr = await this.evaluateComplexExpression(args[0], variables);
        return i8(await this.vAmiga.peek8(addr));
      }
      case 'poke32': {
        const addr = await this.evaluateComplexExpression(args[0], variables);
        const value = await this.evaluateComplexExpression(args[1], variables);
        await this.vAmiga.poke32(addr, value);
        return value;
      }
      case 'poke16': {
        const addr = await this.evaluateComplexExpression(args[0], variables);
        const value = await this.evaluateComplexExpression(args[1], variables);
        await this.vAmiga.poke16(addr, value);
        return value;
      }
      case 'poke8': {
        const addr = await this.evaluateComplexExpression(args[0], variables);
        const value = await this.evaluateComplexExpression(args[1], variables);
        await this.vAmiga.poke8(addr, value);
        return value;
      }
      default:
        throw new Error(`Unknown async function: ${func}`);
    }
  }
}
