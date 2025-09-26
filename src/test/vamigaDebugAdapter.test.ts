/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { VamigaDebugAdapter, EvaluateResultType } from '../vamigaDebugAdapter';
import { VAmigaView, CpuInfo } from '../vAmigaView';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as registerParsers from '../amigaRegisterParsers';
import { VariablesManager } from '../variablesManager';
import { BreakpointManager } from '../breakpointManager';

/**
 * Test subclass that exposes protected methods for testing
 */
class TestableVamigaDebugAdapter extends VamigaDebugAdapter {
  public async testEvaluate(expression: string) {
    return this.evaluate(expression);
  }
}

/**
 * Simplified behavior-focused tests for VamigaDebugAdapter.
 *
 * These tests use minimal refactoring (protected methods + constructor injection)
 * to test behavior without over-engineering the architecture.
 * 
 * Note: Comprehensive variable management tests are now in VariablesManager test suite.
 * This test suite focuses on core debugger behavior, evaluation, and integration.
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


  // Stack analysis tests have been moved to StackManager test suite

  suite('Debug Adapter Protocol Integration', () => {
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
      // Setup: Create proper mock instances instead of bypassing type system
      const mockSourceMap = createMockSourceMap({
        lookupSourceLine: sinon.stub().returns({ address: 0x1000 })
      });
      
      const mockBreakpointManager = sinon.createStubInstance(BreakpointManager);
      const mockVariablesManager = sinon.createStubInstance(VariablesManager);
      
      // Configure the setSourceBreakpoints stub to return expected breakpoints
      mockBreakpointManager.setSourceBreakpoints.resolves([
        { id: 1, verified: true, line: 10 },
        { id: 2, verified: true, line: 20 }
      ]);
      
      // Inject dependencies
      (adapter as any).sourceMap = mockSourceMap;
      (adapter as any).variablesManager = mockVariablesManager;
      (adapter as any).breakpointManager = mockBreakpointManager;

      const response = createMockResponse<DebugProtocol.SetBreakpointsResponse>('setBreakpoints');
      const args: DebugProtocol.SetBreakpointsArguments = {
        source: { path: '/src/main.c' },
        breakpoints: [{ line: 10 }, { line: 20 }]
      };

      // Test: Set breakpoints through DAP
      await (adapter as any).setBreakPointsRequest(response, args);

      // Verify: Breakpoint manager was called and response is correct
      assert.ok(mockBreakpointManager.setSourceBreakpoints.calledOnce);
      assert.strictEqual(response.body?.breakpoints?.length, 2);
      assert.strictEqual(response.body?.breakpoints?.[0].verified, true);
    });

    test('should integrate with VariablesManager for variable requests', async () => {
      // Setup: Mock CPU state
      setupMockCpuState({ d0: '0x42' });
      
      // Test: Get scopes should use VariablesManager
      const scopesResponse = createMockResponse<DebugProtocol.ScopesResponse>('scopes');
      (adapter as any).scopesRequest(scopesResponse);
      
      // Verify: Should return empty scopes if VariablesManager not initialized (before launch)
      assert.ok(scopesResponse.body);
      assert.strictEqual(scopesResponse.body.scopes.length, 0);
      
      // Note: Comprehensive variable testing is in VariablesManager test suite
      // This test verifies DAP integration without requiring full debugger launch
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
      const enableAllBit = dmaconBits.find(b => b.name === '09: ENABLE_ALL');
      const masterBit = intenaBits.find(b => b.name === '14: MASTER_ENABLE');

      assert.ok(enableAllBit, 'Should have DMACON-specific bits');
      assert.ok(masterBit, 'Should have INTENA-specific bits');
    });
  });

  // Helper functions to reduce test setup boilerplate

  function setupMockCpuState(overrides: Partial<CpuInfo> = {}): void {
    const defaultCpuInfo: CpuInfo = {
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

    mockVAmiga.getCpuInfo.resolves(defaultCpuInfo);
    mockVAmiga.getAllCustomRegisters.resolves({
      DMACON: { value: '0x00008200' },
      INTENA: { value: '0x00004000' }
    });
  }

  function setupMockSourceMap(symbols: Record<string, number> = {}): void {
    const mockSourceMap = createMockSourceMap({
      getSymbols: sinon.stub().returns(symbols),
      findSymbolOffset: sinon.stub().returns(undefined)
    });
    (adapter as any).sourceMap = mockSourceMap;
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