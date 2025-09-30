/* eslint-disable @typescript-eslint/no-explicit-any */
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
  private arrayHandles = new Map<number, {elements?: number[], elementSize?: number, baseAddress: number, valuesPerLine?: number, instructions?: any[], type?: string}>();
  private nextArrayHandle = 1;

  /**
   * Creates a new EvaluateManager instance.
   *
   * @param vAmiga VAmiga instance for memory access and register reads
   * @param sourceMap Source map for symbol resolution and address formatting
   * @param variablesManager Variables manager for accessing flat variable data
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
      // Default - parsed expression result
      if (typeof value === 'object' && value.type === 'disassembly') {
        // Handle disassembly results
        const instructions = value.instructions;
        const firstInstruction = instructions.length > 0 ? instructions[0].instruction : 'no instructions';
        const ellipsis = instructions.length > 1 ? '...' : '';
        
        result = `disassembly[${instructions.length}] @ ${formatHex(value.baseAddress)} = ${firstInstruction}${ellipsis}`;
        
        // Create variables reference for expandable disassembly view
        const handle = this.nextArrayHandle++;
        this.arrayHandles.set(handle, {
          instructions: instructions,
          baseAddress: value.baseAddress,
          type: 'disassembly'
        });
        
        return {
          result,
          memoryReference: formatHex(value.baseAddress),
          variablesReference: handle,
          indexedVariables: instructions.length,
        };
      } else if (typeof value === 'object' && value.type === 'array') {
        // Handle array results
        const elementTypeName = value.elementSize === 1 ? 'byte' : 
                              value.elementSize === 2 ? 'word' : 'long';
        
        // Create preview of first few elements
        const previewCount = Math.min(4, value.elements.length);
        const previewElements = value.elements.slice(0, previewCount).map((val: number) => 
          formatHex(val, value.elementSize * 2)
        );
        const preview = previewElements.join(' ');
        const ellipsis = value.elements.length > previewCount ? '...' : '';
        
        result = `${elementTypeName}[${value.elements.length}] @ ${formatHex(value.baseAddress)} = [${preview}${ellipsis}]`;
        
        // Create variables reference for expandable array view
        const handle = this.nextArrayHandle++;
        this.arrayHandles.set(handle, {
          elements: value.elements,
          elementSize: value.elementSize,
          baseAddress: value.baseAddress,
          valuesPerLine: value.valuesPerLine
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
      } else if (typeof value === 'number') {
        // Show numeric result as hex and decimal
        result = formatHex(value, 0) + " = " + value;
      } else {
        result = String(value);
      }
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
        const result = await this.evaluateComplexExpression(expression, numVars);
        if (typeof result === 'object' && (result.type === 'array' || result.type === 'disassembly')) {
          // Array or disassembly result - pass the object as the value for formatting
          return {
            value: result,
            type: EvaluateResultType.PARSED
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
   * Evaluates complex expressions with async function support.
   *
   * Handles expressions containing memory access functions like peekU32, peekU16, etc.
   * with proper recursive evaluation to support nested async calls.
   *
   * @param expression The expression string to evaluate
   * @param variables Variable lookup table
   * @returns Promise resolving to the expression result
   */
  private async evaluateComplexExpression(expression: string, variables: Record<string, number>): Promise<number | {type: 'array', elements: number[], elementSize: number, baseAddress: number, valuesPerLine?: number} | {type: 'disassembly', instructions: DebugProtocol.DisassembledInstruction[], baseAddress: number}> {
    // Check if expression contains async functions
    const asyncFunctions = ['peekU32', 'peekU16', 'peekU8', 'peekI32', 'peekI16', 'peekI8', 'poke32', 'poke16', 'poke8', 'readBytes', 'readWords', 'readLongs', 'disassemble'];
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

    // If this is an array or disassembly result and it's the whole expression, return it
    if (typeof callValue === 'object' && (callValue.type === 'array' || callValue.type === 'disassembly')) {
      // Check if this function call is the entire expression
      if (innermostCall.start === 0 && innermostCall.end === expression.length) {
        return callValue;
      } else {
        // Array and disassembly functions can't be part of larger expressions
        throw new Error(`Functions like ${innermostCall.func} cannot be used in complex expressions`);
      }
    }

    // Replace the call with its value and recursively evaluate the rest
    const newExpression = expression.substring(0, innermostCall.start) +
                         (callValue as number).toString() +
                         expression.substring(innermostCall.end);

    return this.evaluateComplexExpression(newExpression, variables);
  }

  /**
   * Finds the innermost async function call (one with no nested async calls in its arguments).
   */
  private findInnermostAsyncCall(expression: string): {start: number, end: number, func: string, args: string[]} | null {
    const asyncFunctions = ['peekU32', 'peekU16', 'peekU8', 'peekI32', 'peekI16', 'peekI8', 'poke32', 'poke16', 'poke8', 'readBytes', 'readWords', 'readLongs', 'disassemble'];
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
          // Split arguments for all multi-argument functions
          const multiArgFunctions = ['poke32', 'poke16', 'poke8', 'readBytes', 'readWords', 'readLongs', 'disassemble'];
          let args: string[];
          if (multiArgFunctions.includes(funcName)) {
            args = argsStr.trim() === '' ? [] : argsStr.split(',').map(s => s.trim());
          } else {
            args = argsStr.trim() === '' ? [] : [argsStr];
          }
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
  private async evaluateAsyncCall(func: string, args: string[], variables: Record<string, number>): Promise<number | {type: 'array', elements: number[], elementSize: number, baseAddress: number, valuesPerLine?: number} | {type: 'disassembly', instructions: DebugProtocol.DisassembledInstruction[], baseAddress: number}> {
    // Validate argument count for each function
    const requiredArgs: Record<string, {min: number, max: number, usage: string}> = {
      peekU32: {min: 1, max: 1, usage: 'peekU32(address)'},
      peekU16: {min: 1, max: 1, usage: 'peekU16(address)'},
      peekU8: {min: 1, max: 1, usage: 'peekU8(address)'},
      peekI32: {min: 1, max: 1, usage: 'peekI32(address)'},
      peekI16: {min: 1, max: 1, usage: 'peekI16(address)'},
      peekI8: {min: 1, max: 1, usage: 'peekI8(address)'},
      poke32: {min: 2, max: 2, usage: 'poke32(address, value)'},
      poke16: {min: 2, max: 2, usage: 'poke16(address, value)'},
      poke8: {min: 2, max: 2, usage: 'poke8(address, value)'},
      readBytes: {min: 2, max: 3, usage: 'readBytes(address, count[, valuesPerLine])'},
      readWords: {min: 2, max: 3, usage: 'readWords(address, count[, valuesPerLine])'},
      readLongs: {min: 2, max: 3, usage: 'readLongs(address, count[, valuesPerLine])'},
      disassemble: {min: 1, max: 2, usage: 'disassemble(address[, count])'}
    };

    const argSpec = requiredArgs[func];
    if (argSpec) {
      if (args.length < argSpec.min) {
        throw new Error(`${func}() requires at least ${argSpec.min} argument${argSpec.min > 1 ? 's' : ''}. Usage: ${argSpec.usage}`);
      }
      if (args.length > argSpec.max) {
        throw new Error(`${func}() accepts at most ${argSpec.max} argument${argSpec.max > 1 ? 's' : ''}. Usage: ${argSpec.usage}`);
      }
    }

    switch (func) {
      case 'peekU32': {
        const addrResult = await this.evaluateComplexExpression(args[0], variables);
        if (typeof addrResult !== 'number') {
          throw new Error('Peek function address must be a numeric expression');
        }
        return this.vAmiga.peek32(addrResult);
      }
      case 'peekU16': {
        const addrResult = await this.evaluateComplexExpression(args[0], variables);
        if (typeof addrResult !== 'number') {
          throw new Error('Peek function address must be a numeric expression');
        }
        return this.vAmiga.peek16(addrResult);
      }
      case 'peekU8': {
        const addrResult = await this.evaluateComplexExpression(args[0], variables);
        if (typeof addrResult !== 'number') {
          throw new Error('Peek function address must be a numeric expression');
        }
        return this.vAmiga.peek8(addrResult);
      }
      case 'peekI32': {
        const addrResult = await this.evaluateComplexExpression(args[0], variables);
        if (typeof addrResult !== 'number') {
          throw new Error('Peek function address must be a numeric expression');
        }
        return i32(await this.vAmiga.peek32(addrResult));
      }
      case 'peekI16': {
        const addrResult = await this.evaluateComplexExpression(args[0], variables);
        if (typeof addrResult !== 'number') {
          throw new Error('Peek function address must be a numeric expression');
        }
        return i16(await this.vAmiga.peek16(addrResult));
      }
      case 'peekI8': {
        const addrResult = await this.evaluateComplexExpression(args[0], variables);
        if (typeof addrResult !== 'number') {
          throw new Error('Peek function address must be a numeric expression');
        }
        return i8(await this.vAmiga.peek8(addrResult));
      }
      case 'poke32': {
        const addrResult = await this.evaluateComplexExpression(args[0], variables);
        const valueResult = await this.evaluateComplexExpression(args[1], variables);
        if (typeof addrResult !== 'number' || typeof valueResult !== 'number') {
          throw new Error('Poke function arguments must be numeric expressions');
        }
        await this.vAmiga.poke32(addrResult, valueResult);
        return valueResult;
      }
      case 'poke16': {
        const addrResult = await this.evaluateComplexExpression(args[0], variables);
        const valueResult = await this.evaluateComplexExpression(args[1], variables);
        if (typeof addrResult !== 'number' || typeof valueResult !== 'number') {
          throw new Error('Poke function arguments must be numeric expressions');
        }
        await this.vAmiga.poke16(addrResult, valueResult);
        return valueResult;
      }
      case 'poke8': {
        const addrResult = await this.evaluateComplexExpression(args[0], variables);
        const valueResult = await this.evaluateComplexExpression(args[1], variables);
        if (typeof addrResult !== 'number' || typeof valueResult !== 'number') {
          throw new Error('Poke function arguments must be numeric expressions');
        }
        await this.vAmiga.poke8(addrResult, valueResult);
        return valueResult;
      }
      case 'readBytes': {
        const addrResult = await this.evaluateComplexExpression(args[0], variables);
        const countResult = await this.evaluateComplexExpression(args[1], variables);
        const valuesPerLineResult = args[2] ? await this.evaluateComplexExpression(args[2], variables) : 1;
        
        if (typeof addrResult !== 'number' || typeof countResult !== 'number' || typeof valuesPerLineResult !== 'number') {
          throw new Error('Array function arguments must be numeric expressions');
        }
        
        const addr = addrResult;
        const count = countResult;
        const valuesPerLine = valuesPerLineResult;
        const buffer = await this.vAmiga.readMemoryBuffer(addr, count);
        const elements: number[] = [];
        for (let i = 0; i < count; i++) {
          elements.push(buffer.readUInt8(i));
        }
        return {
          type: 'array',
          elements,
          elementSize: 1,
          baseAddress: addr,
          valuesPerLine
        };
      }
      case 'readWords': {
        const addrResult = await this.evaluateComplexExpression(args[0], variables);
        const countResult = await this.evaluateComplexExpression(args[1], variables);
        const valuesPerLineResult = args[2] ? await this.evaluateComplexExpression(args[2], variables) : 1;
        
        if (typeof addrResult !== 'number' || typeof countResult !== 'number' || typeof valuesPerLineResult !== 'number') {
          throw new Error('Array function arguments must be numeric expressions');
        }
        
        const addr = addrResult;
        const count = countResult;
        const valuesPerLine = valuesPerLineResult;
        const buffer = await this.vAmiga.readMemoryBuffer(addr, count * 2);
        const elements: number[] = [];
        for (let i = 0; i < count; i++) {
          elements.push(buffer.readUInt16BE(i * 2));
        }
        return {
          type: 'array',
          elements,
          elementSize: 2,
          baseAddress: addr,
          valuesPerLine
        };
      }
      case 'readLongs': {
        const addrResult = await this.evaluateComplexExpression(args[0], variables);
        const countResult = await this.evaluateComplexExpression(args[1], variables);
        const valuesPerLineResult = args[2] ? await this.evaluateComplexExpression(args[2], variables) : 1;
        
        if (typeof addrResult !== 'number' || typeof countResult !== 'number' || typeof valuesPerLineResult !== 'number') {
          throw new Error('Array function arguments must be numeric expressions');
        }
        
        const addr = addrResult;
        const count = countResult;
        const valuesPerLine = valuesPerLineResult;
        const buffer = await this.vAmiga.readMemoryBuffer(addr, count * 4);
        const elements: number[] = [];
        for (let i = 0; i < count; i++) {
          elements.push(buffer.readUInt32BE(i * 4));
        }
        return {
          type: 'array',
          elements,
          elementSize: 4,
          baseAddress: addr,
          valuesPerLine
        };
      }
      case 'disassemble': {
        const addrResult = await this.evaluateComplexExpression(args[0], variables);
        const countResult = args[1] ? await this.evaluateComplexExpression(args[1], variables) : 1;
        
        if (typeof addrResult !== 'number' || typeof countResult !== 'number') {
          throw new Error('Disassemble function arguments must be numeric expressions');
        }
        
        const addr = addrResult;
        const count = countResult;
        const instructions = await this.disassemblyManager.disassemble(addr, 0, count);
        
        return {
          type: 'disassembly',
          instructions,
          baseAddress: addr
        };
      }
      default:
        throw new Error(`Unknown async function: ${func}`);
    }
  }

  /**
   * Checks if a variables reference belongs to this evaluate manager (i.e., is an array reference).
   * 
   * @param variablesReference The reference to check
   * @returns True if this reference is for an array from this manager
   */
  public hasArrayReference(variablesReference: number): boolean {
    return this.arrayHandles.has(variablesReference);
  }

  /**
   * Gets variables for an array result from expression evaluation.
   * 
   * @param variablesReference The reference returned from evaluateFormatted
   * @returns Array of DAP variables showing individual elements with formatting
   */
  public getArrayVariables(variablesReference: number): DebugProtocol.Variable[] {
    const arrayData = this.arrayHandles.get(variablesReference);
    if (!arrayData) {
      return [];
    }

    // Handle disassembly results
    if (arrayData.type === 'disassembly' && arrayData.instructions) {
      const variables: DebugProtocol.Variable[] = [];
      
      // Find the maximum width of instruction bytes for alignment
      const maxHexWidth = Math.max(...arrayData.instructions.map((instr: any) => 
        (instr.instructionBytes || '').length
      ));
      
      for (let i = 0; i < arrayData.instructions.length; i++) {
        const instr = arrayData.instructions[i];
        const address = instr.address || `0x${instr.addr || '00000000'}`;
        const hexBytes = (instr.instructionBytes || '').padEnd(maxHexWidth, ' ');
        
        variables.push({
          name: address,
          value: `${hexBytes} ${instr.instruction}`,
          memoryReference: address,
          variablesReference: 0,
          presentationHint: { attributes: ['readOnly'] }
        });
      }
      return variables;
    }

    // Handle array results
    const { elements, elementSize, baseAddress, valuesPerLine = 1 } = arrayData;
    if (!elements || !elementSize) {
      return [];
    }
    
    const variables: DebugProtocol.Variable[] = [];
    
    // Group elements by valuesPerLine
    for (let i = 0; i < elements.length; i += valuesPerLine) {
      const groupElements = elements.slice(i, i + valuesPerLine);
      const groupStartAddr = baseAddress + (i * elementSize);
      
      if (valuesPerLine === 1) {
        // Single element per line - show both hex and decimal for better debugging
        const value = groupElements[0];
        const hexValue = formatHex(value, elementSize * 2);
        
        let displayValue: string;
        if (elementSize === 4 && this.vAmiga.isValidAddress(value)) {
          displayValue = formatAddress(value, this.sourceMap);
        } else {
          displayValue = `${hexValue} = ${value}`;
        }
        
        variables.push({
          name: `[${i}]`,
          value: displayValue,
          memoryReference: formatHex(groupStartAddr),
          variablesReference: 0,
          presentationHint: { attributes: ['readOnly'] }
        });
      } else {
        // Multiple elements per line - traditional hex listing style
        const groupValues = groupElements.map(value => {
          if (elementSize === 4 && this.vAmiga.isValidAddress(value)) {
            return formatAddress(value, this.sourceMap);
          } else {
            // Remove 0x prefix for cleaner table view
            return value.toString(16).padStart(elementSize * 2, '0').toUpperCase();
          }
        });
        
        // Use hex offset as label for traditional hex dump style
        const offsetLabel = groupStartAddr.toString(16).padStart(6, '0').toUpperCase();
        const groupValue = groupValues.join(' ');
        
        variables.push({
          name: offsetLabel + ':',
          value: groupValue,
          memoryReference: formatHex(groupStartAddr),
          variablesReference: 0,
          presentationHint: { attributes: ['readOnly'] }
        });
      }
    }

    return variables;
  }
}
