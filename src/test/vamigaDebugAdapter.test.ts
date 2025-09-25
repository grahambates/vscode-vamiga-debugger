/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { VamigaDebugAdapter, EvaluateResultType } from '../vamigaDebugAdapter';
import { VAmigaView, CpuInfo } from '../vAmigaView';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as registerParsers from '../amigaRegisterParsers';

/**
 * Test subclass that exposes protected methods for testing
 */
class TestableVamigaDebugAdapter extends VamigaDebugAdapter {
  public async testEvaluate(expression: string) {
    return this.evaluate(expression);
  }

  public testFormatAddress(address: number): string {
    return this.formatAddress(address);
  }

  public async testGuessStack(maxLength?: number) {
    return this.guessStack(maxLength);
  }

  public testHasCustomRegisterBitBreakdown(regName: string): boolean {
    return this.hasCustomRegisterBitBreakdown(regName);
  }

  public testParseCustomRegister(regName: string, value: number) {
    return this.parseCustomRegister(regName, value);
  }

}

/**
 * Simplified behavior-focused tests for VamigaDebugAdapter.
 *
 * These tests use minimal refactoring (protected methods + constructor injection)
 * to test behavior without over-engineering the architecture.
 */
suite('VamigaDebugAdapter - Simplified Tests', () => {
  let adapter: TestableVamigaDebugAdapter;
  let mockVAmiga: sinon.SinonStubbedInstance<VAmigaView>;

  setup(() => {
    // Create mock VAmiga with commonly needed methods
    mockVAmiga = sinon.createStubInstance(VAmigaView);

    // Use constructor injection to provide mock
    adapter = new TestableVamigaDebugAdapter(mockVAmiga);
  });

  teardown(() => {
    sinon.restore();
    adapter.dispose();
  });

  suite('Expression Evaluation Behavior', () => {
    test('should evaluate simple numeric expressions', async () => {
      // Setup: Mock CPU state
      setupMockCpuState();
      setupMockSourceMap();

      // Test: Evaluate simple expression
      const result = await adapter.testEvaluate('42');

      // Verify: Returns expected value
      assert.strictEqual(result.value, 42);
    });

    test('should evaluate register expressions', async () => {
      // Setup: Mock CPU with d0 = 0x100
      setupMockCpuState({ d0: '0x100' });
      setupMockSourceMap();

      // Test: Evaluate register
      const result = await adapter.testEvaluate('d0');

      // Verify: Returns register value and correct type
      assert.strictEqual(result.value, 0x100);
      assert.strictEqual(result.type, EvaluateResultType.DATA_REGISTER);
    });

    test('should evaluate complex expressions with registers', async () => {
      // Setup: Mock CPU state
      setupMockCpuState({ d0: '0x10', d1: '0x20' });
      setupMockSourceMap();

      // Test: Evaluate arithmetic expression
      const result = await adapter.testEvaluate('d0 + d1 * 2');

      // Verify: Correct calculation
      assert.strictEqual(result.value, 0x10 + 0x20 * 2);
      assert.strictEqual(result.type, EvaluateResultType.PARSED);
    });

    test('should handle hex address evaluation with memory access', async () => {
      // Setup: Mock memory read
      const mockBuffer = Buffer.alloc(4);
      mockBuffer.writeUInt32BE(0x12345678, 0);
      mockVAmiga.readMemoryBuffer.resolves(mockBuffer);
      setupMockCpuState();
      setupMockSourceMap();

      // Test: Evaluate hex address (should read memory)
      const result = await adapter.testEvaluate('0x1000');

      // Verify: Memory was read and result formatted correctly
      assert.ok(mockVAmiga.readMemoryBuffer.calledWith(0x1000, 4));
      assert.strictEqual(result.value, 0x12345678);
      assert.strictEqual(result.memoryReference, '0x00001000');
    });

    test('should evaluate symbols when source map available', async () => {
      // Setup: Mock CPU state and source map with symbols
      setupMockCpuState();
      setupMockSourceMap({ main: 0x1000, buffer: 0x2000 });

      // Test: Evaluate symbol
      const result = await adapter.testEvaluate('main');

      // Verify: Symbol resolved correctly
      assert.strictEqual(result.value, 0x1000);
      assert.strictEqual(result.type, EvaluateResultType.SYMBOL);
      assert.strictEqual(result.memoryReference, '0x00001000');
    });
  });

  suite('Address Formatting Behavior', () => {
    test('should format plain addresses without symbols', () => {
      // Setup: No source map
      (adapter as any).sourceMap = undefined;

      // Test: Format address
      const result = adapter.testFormatAddress(0x1000);

      // Verify: Plain hex formatting
      assert.strictEqual(result, '0x00001000');
    });

    test('should format addresses with symbol information', () => {
      // Setup: Mock source map
      const mockSourceMap = {
        findSymbolOffset: sinon.stub().returns({ symbol: 'main', offset: 16 })
      };
      (adapter as any).sourceMap = mockSourceMap;

      // Test: Format address
      const result = adapter.testFormatAddress(0x1010);

      // Verify: Includes symbol + offset
      assert.strictEqual(result, '0x00001010 = main+16');
    });

    test('should format addresses with exact symbol match', () => {
      // Setup: Mock source map with zero offset
      const mockSourceMap = {
        findSymbolOffset: sinon.stub().returns({ symbol: 'start', offset: 0 })
      };
      (adapter as any).sourceMap = mockSourceMap;

      // Test: Format address
      const result = adapter.testFormatAddress(0x1000);

      // Verify: Shows symbol without offset
      assert.strictEqual(result, '0x00001000 = start');
    });
  });

  suite('Stack Analysis Behavior', () => {
    test('should return current PC as first stack frame', async () => {
      // Setup: Mock CPU state
      setupMockCpuState({ pc: '0x1000', a7: '0x8000' });
      mockVAmiga.readMemoryBuffer.resolves(Buffer.alloc(128));

      // Test: Analyze stack
      const frames = await adapter.testGuessStack(1);

      // Verify: Current frame included
      assert.strictEqual(frames.length, 1);
      assert.deepStrictEqual(frames[0], [0x1000, 0x1000]);
    });

    test('should detect JSR return addresses in stack', async () => {
      // Setup: Mock CPU and stack with return address
      setupMockCpuState({ pc: '0x1000', a7: '0x8000' });

      const stackBuffer = Buffer.alloc(128);
      stackBuffer.writeInt32BE(0x2000, 0); // Return address
      mockVAmiga.readMemoryBuffer.withArgs(0x8000, 128).resolves(stackBuffer);

      // Mock JSR instruction before return address
      const instrBuffer = Buffer.alloc(6);
      instrBuffer.writeUInt16BE(0x4e80, 4); // JSR at offset -2
      mockVAmiga.readMemoryBuffer.withArgs(0x2000 - 6, 6).resolves(instrBuffer);

      // Test: Analyze stack
      const frames = await adapter.testGuessStack(5);

      // Verify: Found JSR frame
      assert.strictEqual(frames.length, 2);
      assert.deepStrictEqual(frames[1], [0x2000 - 2, 0x2000]);
    });
  });

  suite('Debug Adapter Protocol Behavior', () => {
    test('should handle evaluate request through DAP', async () => {
      // Setup: Mock CPU state for evaluation
      setupMockCpuState({ d0: '0x42' });
      setupMockSourceMap();

      const response = createMockResponse<DebugProtocol.EvaluateResponse>('evaluate');
      const args: DebugProtocol.EvaluateArguments = {
        expression: 'd0 + 8'
      };

      // Test: Handle DAP evaluate request
      await (adapter as any).evaluateRequest(response, args);

      // Verify: Response contains correct result (now includes decimal value)
      assert.strictEqual(response.body?.result, '0x4a = 74'); // 0x42 + 8 = 0x4a = 74
      assert.strictEqual(response.success, true);
    });

    test('should handle invalid expressions gracefully', async () => {
      // Setup: Mock CPU state
      setupMockCpuState();
      setupMockSourceMap();

      const response = createMockResponse<DebugProtocol.EvaluateResponse>('evaluate');
      const args: DebugProtocol.EvaluateArguments = {
        expression: 'invalid_variable'
      };

      // Test: Handle invalid expression
      await (adapter as any).evaluateRequest(response, args);

      // Verify: Returns error response
      assert.strictEqual(response.success, false);
      // The actual error message format may vary, just check that there's an error
      assert.ok(response.message);
    });

    test('should set breakpoints through DAP when source map available', async () => {
      // Setup: Mock source map
      const mockSourceMap = {
        lookupSourceLine: sinon.stub().returns({ address: 0x1000 })
      };
      (adapter as any).sourceMap = mockSourceMap;

      const response = createMockResponse<DebugProtocol.SetBreakpointsResponse>('setBreakpoints');
      const args: DebugProtocol.SetBreakpointsArguments = {
        source: { path: '/src/main.c' },
        breakpoints: [{ line: 10 }, { line: 20 }]
      };

      // Test: Set breakpoints through DAP
      await (adapter as any).setBreakPointsRequest(response, args);

      // Verify: Breakpoints set in emulator and response is correct
      assert.ok(mockVAmiga.setBreakpoint.calledWith(0x1000));
      assert.strictEqual(response.body?.breakpoints?.length, 2);
      assert.strictEqual(response.body?.breakpoints?.[0].verified, true);
    });
  });

  suite('Custom Register Bit Breakdown Behavior', () => {
    test('should detect supported custom registers', () => {
      assert.ok(registerParsers.hasRegisterBitBreakdown('DMACON'));
      assert.ok(registerParsers.hasRegisterBitBreakdown('DMACONR'));
      assert.ok(registerParsers.hasRegisterBitBreakdown('INTENA'));
      assert.ok(registerParsers.hasRegisterBitBreakdown('INTENAR'));
      assert.ok(registerParsers.hasRegisterBitBreakdown('INTREQ'));
      assert.ok(registerParsers.hasRegisterBitBreakdown('BPLCON0'));
      assert.ok(registerParsers.hasRegisterBitBreakdown('BPLCON1'));
      assert.ok(registerParsers.hasRegisterBitBreakdown('BPLCON2'));
      assert.ok(registerParsers.hasRegisterBitBreakdown('BPLCON3'));
      assert.ok(registerParsers.hasRegisterBitBreakdown('BLTCON0'));
      assert.ok(registerParsers.hasRegisterBitBreakdown('BLTCON1'));
      assert.ok(registerParsers.hasRegisterBitBreakdown('VPOSR'));
      assert.ok(registerParsers.hasRegisterBitBreakdown('VHPOSR'));
      assert.ok(registerParsers.hasRegisterBitBreakdown('BLTSIZE'));
      assert.ok(registerParsers.hasRegisterBitBreakdown('ADKCON'));
      assert.ok(registerParsers.hasRegisterBitBreakdown('SPR0CTL'));
      assert.ok(registerParsers.hasRegisterBitBreakdown('SPR0POS'));
      assert.ok(!registerParsers.hasRegisterBitBreakdown('UNKNOWN_REG'));
    });

    test('should route to correct parser based on register name', () => {
      const dmaconBits = registerParsers.parseRegister('DMACON', 0x0200);
      const intenaBits = registerParsers.parseRegister('INTENA', 0x4000);
      const unknownBits = registerParsers.parseRegister('UNKNOWN', 0x1234);

      assert.ok(dmaconBits.length > 0, 'DMACON should return bit definitions');
      assert.ok(intenaBits.length > 0, 'INTENA should return bit definitions');
      assert.strictEqual(unknownBits.length, 0, 'Unknown register should return empty array');

      // Verify different parsers are called
      const enableAllBit = dmaconBits.find(b => b.name === 'ENABLE_ALL');
      const masterBit = intenaBits.find(b => b.name === 'MASTER_ENABLE');

      assert.ok(enableAllBit, 'Should have DMACON-specific bits');
      assert.ok(masterBit, 'Should have INTENA-specific bits');
    });
  });

  // Helper functions to reduce test setup boilerplate

  function setupMockCpuState(overrides: Partial<CpuInfo> = {}): void {
    const defaultCpuInfo: CpuInfo = {
      pc: '0x1000',
      d0: '0x0000', d1: '0x0000', d2: '0x0000', d3: '0x0000',
      d4: '0x0000', d5: '0x0000', d6: '0x0000', d7: '0x0000',
      a0: '0x0000', a1: '0x0000', a2: '0x0000', a3: '0x0000',
      a4: '0x0000', a5: '0x0000', a6: '0x0000', a7: '0x7000',
      sr: '0x0000', usp: '0x0000', isp: '0x0000', msp: '0x0000',
      vbr: '0x0000', irc: '0x0000', sfc: '0x0000', dfc: '0x0000',
      cacr: '0x0000', caar: '0x0000',
      ...overrides
    };

    mockVAmiga.getCpuInfo.resolves(defaultCpuInfo);
    mockVAmiga.getAllCustomRegisters.resolves({
      DMACON: { value: '0x8200' },
      INTENA: { value: '0x4000' }
    });
  }

  function setupMockSourceMap(symbols: Record<string, number> = {}): void {
    const mockSourceMap = {
      getSymbols: () => symbols,
      findSymbolOffset: sinon.stub().returns(undefined)
    };
    (adapter as any).sourceMap = mockSourceMap;
  }

  function createMockResponse<T extends DebugProtocol.Response>(command: string): T {
    return {
      seq: 1,
      type: 'response',
      request_seq: 1,
      command,
      success: true
    } as T;
  }
});