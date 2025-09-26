/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { EvaluateManager, EvaluateResultType } from '../evaluateManager';
import { VAmiga, CpuInfo } from '../vAmiga';
import { VariablesManager } from '../variablesManager';

/**
 * Comprehensive tests for EvaluateManager
 * Tests expression evaluation, formatting, and type classification
 */
describe('EvaluateManager - Comprehensive Tests', () => {
  let evaluateManager: EvaluateManager;
  let mockVAmiga: sinon.SinonStubbedInstance<VAmiga>;
  let mockVariablesManager: sinon.SinonStubbedInstance<VariablesManager>;
  let mockSourceMap: any;

  beforeEach(() => {
    mockVAmiga = sinon.createStubInstance(VAmiga);
    mockVariablesManager = sinon.createStubInstance(VariablesManager);
    mockSourceMap = createMockSourceMap();

    evaluateManager = new EvaluateManager(mockVAmiga, mockSourceMap, mockVariablesManager);

    // Setup default CPU state
    mockVAmiga.getCpuInfo.resolves(createMockCpuInfo());
    mockVAmiga.getAllCustomRegisters.resolves({
      DMACON: { value: '0x00008200' },
      INTENA: { value: '0x00004000' }
    });
    mockVariablesManager.getFlatVariables.resolves({});
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('Basic Expression Evaluation', () => {
    it('should evaluate decimal literals', async () => {
      const result = await evaluateManager.evaluate('42');

      assert.strictEqual(result.value, 42);
      assert.strictEqual(result.type, EvaluateResultType.UNKNOWN);
      assert.strictEqual(result.memoryReference, undefined);
    });

    it('should evaluate negative decimal literals', async () => {
      const result = await evaluateManager.evaluate('-123');

      assert.strictEqual(result.value, -123);
      assert.strictEqual(result.type, EvaluateResultType.UNKNOWN);
    });

    it('should handle empty expressions', async () => {
      const result = await evaluateManager.evaluate('');

      assert.strictEqual(result.value, undefined);
      assert.strictEqual(result.type, EvaluateResultType.EMPTY);
    });

    it('should handle whitespace-only expressions', async () => {
      const result = await evaluateManager.evaluate('   ');

      assert.strictEqual(result.value, undefined);
      assert.strictEqual(result.type, EvaluateResultType.EMPTY);
    });
  });

  describe('Hexadecimal Address Evaluation', () => {
    it('should read memory at hex addresses', async () => {
      // Setup: Mock memory read
      const mockBuffer = Buffer.alloc(4);
      mockBuffer.writeUInt32BE(0x12345678, 0);
      mockVAmiga.readMemoryBuffer.resolves(mockBuffer);

      const result = await evaluateManager.evaluate('0x1000');

      // Verify: Memory read and correct result
      assert.ok(mockVAmiga.readMemoryBuffer.calledWith(0x1000, 4));
      assert.strictEqual(result.value, 0x12345678);
      assert.strictEqual(result.memoryReference, '0x00001000');
      assert.strictEqual(result.type, EvaluateResultType.UNKNOWN);
    });

    it('should handle uppercase hex addresses', async () => {
      const mockBuffer = Buffer.alloc(4);
      mockBuffer.writeUInt32BE(0xABCDEF01, 0);
      mockVAmiga.readMemoryBuffer.resolves(mockBuffer);

      const result = await evaluateManager.evaluate('0xABCD');

      assert.ok(mockVAmiga.readMemoryBuffer.calledWith(0xABCD, 4));
      assert.strictEqual(result.value, 0xABCDEF01);
      assert.strictEqual(result.memoryReference, '0x0000abcd');
    });

    it('should handle mixed case hex addresses', async () => {
      const mockBuffer = Buffer.alloc(4);
      mockBuffer.writeUInt32BE(0x00000042, 0);
      mockVAmiga.readMemoryBuffer.resolves(mockBuffer);

      const result = await evaluateManager.evaluate('0xaBc1');

      assert.ok(mockVAmiga.readMemoryBuffer.calledWith(0xaBc1, 4));
      assert.strictEqual(result.value, 0x00000042);
    });
  });

  describe('CPU Register Evaluation', () => {
    it('should evaluate data registers', async () => {
      mockVariablesManager.getFlatVariables.resolves({ d0: 0x123, d7: 0x456 });
      mockVAmiga.getCpuInfo.resolves(createMockCpuInfo({ d0: '0x123', d7: '0x456' }));

      const resultD0 = await evaluateManager.evaluate('d0');
      const resultD7 = await evaluateManager.evaluate('d7');

      assert.strictEqual(resultD0.value, 0x123);
      assert.strictEqual(resultD0.type, EvaluateResultType.DATA_REGISTER);
      assert.strictEqual(resultD7.value, 0x456);
      assert.strictEqual(resultD7.type, EvaluateResultType.DATA_REGISTER);
    });

    it('should evaluate address registers', async () => {
      mockVariablesManager.getFlatVariables.resolves({ a0: 0x2000, a7: 0x7000, pc: 0x1000 });
      mockVAmiga.getCpuInfo.resolves(createMockCpuInfo({ a0: '0x2000', a7: '0x7000', pc: '0x1000' }));

      const resultA0 = await evaluateManager.evaluate('a0');
      const resultPC = await evaluateManager.evaluate('pc');

      assert.strictEqual(resultA0.value, 0x2000);
      assert.strictEqual(resultA0.type, EvaluateResultType.ADDRESS_REGISTER);
      assert.strictEqual(resultPC.value, 0x1000);
      assert.strictEqual(resultPC.type, EvaluateResultType.ADDRESS_REGISTER);
    });

    it('should evaluate special address registers', async () => {
      mockVariablesManager.getFlatVariables.resolves({ usp: 0x8000, vbr: 0x9000 });
      mockVAmiga.getCpuInfo.resolves(createMockCpuInfo({ usp: '0x8000', vbr: '0x9000' }));

      const resultUSP = await evaluateManager.evaluate('usp');
      const resultVBR = await evaluateManager.evaluate('vbr');

      assert.strictEqual(resultUSP.value, 0x8000);
      assert.strictEqual(resultUSP.type, EvaluateResultType.ADDRESS_REGISTER);
      assert.strictEqual(resultVBR.value, 0x9000);
      assert.strictEqual(resultVBR.type, EvaluateResultType.ADDRESS_REGISTER);
    });
  });

  describe('Custom Register Evaluation', () => {
    it('should evaluate custom registers', async () => {
      mockVariablesManager.getFlatVariables.resolves({ DMACON: 0x8200, INTENA: 0x4000 });

      const resultDMACON = await evaluateManager.evaluate('DMACON');
      const resultINTENA = await evaluateManager.evaluate('INTENA');

      assert.strictEqual(resultDMACON.value, 0x8200);
      assert.strictEqual(resultDMACON.type, EvaluateResultType.CUSTOM_REGISTER);
      assert.strictEqual(resultINTENA.value, 0x4000);
      assert.strictEqual(resultINTENA.type, EvaluateResultType.CUSTOM_REGISTER);
    });
  });

  describe('Symbol Evaluation', () => {
    it('should evaluate symbols from source map', async () => {
      mockSourceMap.getSymbols.returns({ main: 0x1000, buffer: 0x2000, end: 0x3000 });
      mockVariablesManager.getFlatVariables.resolves({ main: 0x1000, buffer: 0x2000 });

      const resultMain = await evaluateManager.evaluate('main');
      const resultBuffer = await evaluateManager.evaluate('buffer');

      assert.strictEqual(resultMain.value, 0x1000);
      assert.strictEqual(resultMain.type, EvaluateResultType.SYMBOL);
      assert.strictEqual(resultMain.memoryReference, '0x00001000');
      assert.strictEqual(resultBuffer.value, 0x2000);
      assert.strictEqual(resultBuffer.type, EvaluateResultType.SYMBOL);
      assert.strictEqual(resultBuffer.memoryReference, '0x00002000');
    });

    it('should handle symbols not in variables but in source map', async () => {
      mockSourceMap.getSymbols.returns({ main: 0x1000 });
      mockVariablesManager.getFlatVariables.resolves({}); // Symbol not in flat variables

      try {
        await evaluateManager.evaluate('main');
        assert.fail('Should have thrown an error for undefined variable');
      } catch (err) {
        // Expected behavior - unknown variable should throw error
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('undefined variable: main'));
      }
    });
  });

  describe('Complex Expression Evaluation', () => {
    it('should evaluate arithmetic expressions', async () => {
      mockVariablesManager.getFlatVariables.resolves({ d0: 10, d1: 20 });

      const result = await evaluateManager.evaluate('d0 + d1 * 2');

      assert.strictEqual(result.value, 10 + 20 * 2); // 50
      assert.strictEqual(result.type, EvaluateResultType.PARSED);
    });

    it('should evaluate expressions with parentheses', async () => {
      mockVariablesManager.getFlatVariables.resolves({ a: 5, b: 3 });

      const result = await evaluateManager.evaluate('(a + b) * 2');

      assert.strictEqual(result.value, (5 + 3) * 2); // 16
      assert.strictEqual(result.type, EvaluateResultType.PARSED);
    });

    it('should evaluate expressions with hex literals', async () => {
      mockVariablesManager.getFlatVariables.resolves({ d0: 0x10 });

      const result = await evaluateManager.evaluate('d0 + 0x20');

      assert.strictEqual(result.value, 0x10 + 0x20); // 48
      assert.strictEqual(result.type, EvaluateResultType.PARSED);
    });

    it('should handle division and modulo', async () => {
      mockVariablesManager.getFlatVariables.resolves({ val: 100 });

      const divResult = await evaluateManager.evaluate('val / 4');
      const modResult = await evaluateManager.evaluate('val % 7');

      assert.strictEqual(divResult.value, 25);
      assert.strictEqual(modResult.value, 2);
    });
  });

  describe('Memory Access Functions', () => {
    it('should support peekU32 function', async () => {
      mockVAmiga.peek32.resolves(0x12345678);
      mockVariablesManager.getFlatVariables.resolves({ addr: 0x1000 });

      const result = await evaluateManager.evaluate('peekU32(addr)');

      assert.ok(mockVAmiga.peek32.calledWith(0x1000));
      assert.strictEqual(result.value, 0x12345678);
      assert.strictEqual(result.type, EvaluateResultType.PARSED);
    });

    it('should support peekU16 function', async () => {
      mockVAmiga.peek16.resolves(0x1234);
      mockVariablesManager.getFlatVariables.resolves({ addr: 0x1000 });

      const result = await evaluateManager.evaluate('peekU16(addr)');

      assert.ok(mockVAmiga.peek16.calledWith(0x1000));
      assert.strictEqual(result.value, 0x1234);
    });

    it('should support peekU8 function', async () => {
      mockVAmiga.peek8.resolves(0x42);
      mockVariablesManager.getFlatVariables.resolves({});

      const result = await evaluateManager.evaluate('peekU8(0x1000)');

      assert.ok(mockVAmiga.peek8.calledWith(0x1000));
      assert.strictEqual(result.value, 0x42);
    });

    it('should support peekI32 function with signed conversion', async () => {
      mockVAmiga.peek32.resolves(0xFFFFFFFF); // -1 when signed
      mockVariablesManager.getFlatVariables.resolves({});

      const result = await evaluateManager.evaluate('peekI32(0x1000)');

      assert.ok(mockVAmiga.peek32.calledWith(0x1000));
      // peekI32 should return the signed 32-bit value (-1 in this case)
      // The expression parser should handle the promise resolution
      assert.strictEqual(result.value, -1);
      assert.strictEqual(result.type, EvaluateResultType.PARSED);
    });
  });

  describe('Type Conversion Functions', () => {
    it('should support u32 function', async () => {
      mockVariablesManager.getFlatVariables.resolves({ val: -1 });

      const result = await evaluateManager.evaluate('u32(val)');

      assert.strictEqual(result.value, 0xFFFFFFFF); // -1 as unsigned 32-bit
      assert.strictEqual(result.type, EvaluateResultType.PARSED);
    });

    it('should support i16 function', async () => {
      mockVariablesManager.getFlatVariables.resolves({ val: 0xFFFF });

      const result = await evaluateManager.evaluate('i16(val)');

      assert.strictEqual(result.value, -1); // 0xFFFF as signed 16-bit
    });

    it('should support u8 function', async () => {
      mockVariablesManager.getFlatVariables.resolves({ val: 0x1FF });

      const result = await evaluateManager.evaluate('u8(val)');

      assert.strictEqual(result.value, 0xFF); // Truncated to 8-bit
    });
  });

  describe('Formatted Evaluation', () => {
    it('should format data register results', async () => {
      mockVariablesManager.getFlatVariables.resolves({ d0: 0x42 });
      mockVAmiga.getCpuInfo.resolves(createMockCpuInfo({ d0: '0x42' }));

      const result = await evaluateManager.evaluateFormatted({ expression: 'd0' });

      assert.strictEqual(result.result, '0x00000042 = 66');
      assert.strictEqual(result.variablesReference, 0);
    });

    it('should format address register results', async () => {
      mockVariablesManager.getFlatVariables.resolves({ a0: 0x1000 });
      mockVAmiga.getCpuInfo.resolves(createMockCpuInfo({ a0: '0x1000' }));

      const result = await evaluateManager.evaluateFormatted({ expression: 'a0' });

      assert.strictEqual(result.result, '0x00001000');
      assert.strictEqual(result.variablesReference, 0);
    });

    it('should format symbol results with memory reference', async () => {
      mockSourceMap.getSymbols.returns({ main: 0x1000 });
      mockSourceMap.getSymbolLengths.returns({ main: 4 }); // Set symbol length for pointer dereferencing
      mockSourceMap.findSymbolOffset.returns(null); // No symbol found for the dereferenced value
      mockVariablesManager.getFlatVariables.resolves({ main: 0x1000 });
      mockVAmiga.peek32.resolves(0x12345678);

      const result = await evaluateManager.evaluateFormatted({ expression: 'main' });

      assert.strictEqual(result.result, '0x00001000 -> 0x12345678');
      assert.strictEqual(result.memoryReference, '0x00001000');
    });

    it('should format custom register results', async () => {
      mockVariablesManager.getFlatVariables.resolves({ DMACON: 0x8200 });

      const result = await evaluateManager.evaluateFormatted({ expression: 'DMACON' });

      assert.strictEqual(result.result, '0x8200');
      assert.strictEqual(result.variablesReference, 0);
    });

    it('should format parsed expression results', async () => {
      mockVariablesManager.getFlatVariables.resolves({ d0: 10, d1: 5 });

      const result = await evaluateManager.evaluateFormatted({ expression: 'd0 + d1' });

      assert.strictEqual(result.result, '0xf = 15');
      assert.strictEqual(result.variablesReference, 0);
    });

    it('should handle empty expressions', async () => {
      const result = await evaluateManager.evaluateFormatted({ expression: '' });

      assert.strictEqual(result.result, '');
      assert.strictEqual(result.variablesReference, 0);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid variable references', async () => {
      mockVariablesManager.getFlatVariables.resolves({});

      try {
        await evaluateManager.evaluate('nonexistent_var');
        // Should throw error when trying to parse unknown variable
        assert.fail('Should have thrown an error');
      } catch (err) {
        assert.ok(err instanceof Error);
      }
    });

    it('should handle memory read errors', async () => {
      mockVAmiga.readMemoryBuffer.rejects(new Error('Memory access error'));

      try {
        await evaluateManager.evaluate('0x1000');
        assert.fail('Should have thrown an error');
      } catch (err) {
        assert.ok(err instanceof Error);
        assert.strictEqual(err.message, 'Memory access error');
      }
    });

    it('should handle invalid arithmetic expressions', async () => {
      mockVariablesManager.getFlatVariables.resolves({ d0: 10 });

      try {
        await evaluateManager.evaluate('d0 +'); // Invalid syntax
        assert.fail('Should have thrown an error');
      } catch (err) {
        assert.ok(err instanceof Error);
      }
    });
  });

  // Helper functions
  function createMockCpuInfo(overrides: Partial<CpuInfo> = {}): CpuInfo {
    return {
      pc: '0x00001000',
      d0: '0x00000000', d1: '0x00000000', d2: '0x00000000', d3: '0x00000000',
      d4: '0x00000000', d5: '0x00000000', d6: '0x00000000', d7: '0x00000000',
      a0: '0x00000000', a1: '0x00000000', a2: '0x00000000', a3: '0x00000000',
      a4: '0x00000000', a5: '0x00000000', a6: '0x00000000', a7: '0x00007000',
      sr: '0x00000000', usp: '0x00000000', isp: '0x00000000', msp: '0x00000000',
      vbr: '0x00000000', irc: '0x00000000', sfc: '0x00000000', dfc: '0x00000000',
      cacr: '0x00000000', caar: '0x00000000',
      ...overrides
    };
  }

  function createMockSourceMap(overrides: any = {}) {
    return {
      getSourceFiles: sinon.stub().returns([]),
      getSegmentsInfo: sinon.stub().returns([]),
      getSymbols: sinon.stub().returns({}),
      lookupAddress: sinon.stub().returns(null),
      lookupSourceLine: sinon.stub().returns({ address: 0x1000 }),
      getSegmentInfo: sinon.stub(),
      findSegmentForAddress: sinon.stub(),
      getSymbolLengths: sinon.stub().returns({}),
      findSymbolOffset: sinon.stub().returns(null),
      ...overrides
    };
  }
});