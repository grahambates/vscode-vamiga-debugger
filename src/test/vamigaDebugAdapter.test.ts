/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { VamigaDebugAdapter, ErrorCode, EvaluateResultType } from '../vamigaDebugAdapter';
import { VAmigaView, CpuInfo } from '../vAmigaView';

// Helper function to create mock CPU info with required properties
function createMockCpuInfo(overrides: Partial<CpuInfo> = {}): CpuInfo {
  return {
    pc: '0x0000',
    flags: {
      carry: false,
      overflow: false,
      zero: false,
      negative: false,
      extend: false,
      trace1: false,
      trace0: false,
      supervisor: false,
      master: false,
      interrupt_mask: 0
    },
    d0: '0x0000', d1: '0x0000', d2: '0x0000', d3: '0x0000',
    d4: '0x0000', d5: '0x0000', d6: '0x0000', d7: '0x0000',
    a0: '0x0000', a1: '0x0000', a2: '0x0000', a3: '0x0000',
    a4: '0x0000', a5: '0x0000', a6: '0x0000', a7: '0x0000',
    sr: '0x0000', usp: '0x0000', isp: '0x0000', msp: '0x0000',
    vbr: '0x0000', irc: '0x0000', sfc: '0x0000', dfc: '0x0000',
    cacr: '0x0000', caar: '0x0000',
    ...overrides
  };
}

/**
 * Test suite for VamigaDebugAdapter
 */
suite('VamigaDebugAdapter Tests', () => {
  let adapter: VamigaDebugAdapter;
  let mockVAmiga: sinon.SinonStubbedInstance<VAmigaView>;

  setup(() => {
    // Create a new adapter instance for each test
    adapter = new VamigaDebugAdapter();
    
    // Create mock VAmiga instance
    mockVAmiga = sinon.createStubInstance(VAmigaView);
    (adapter as any).vAmiga = mockVAmiga;
  });

  teardown(() => {
    sinon.restore();
    adapter.dispose();
  });

  suite('Constructor', () => {
    test('should initialize with correct settings', () => {
      const newAdapter = new VamigaDebugAdapter();
      
      // Verify zero-based numbering is set (these are internal properties that may not be accessible)
      // Just verify the adapter was created successfully
      assert.ok(newAdapter);
      
      // Verify parser is initialized with custom functions
      const parser = (newAdapter as any).parser;
      assert.ok(parser);
      assert.ok(parser.functions.u32);
      assert.ok(parser.functions.peekU32);
      assert.ok(parser.functions.poke32);
      
      newAdapter.dispose();
    });
  });

  suite('Helper Methods', () => {
    suite('formatAddress', () => {
      test('should format address without symbol', () => {
        const result = (adapter as any).formatAddress(0x1234);
        assert.strictEqual(result, '0x00001234');
      });

      test('should format address with symbol', () => {
        // Mock source map with symbol
        const mockSourceMap = {
          findSymbolOffset: sinon.stub().returns({ symbol: 'main', offset: 16 })
        };
        (adapter as any).sourceMap = mockSourceMap;
        
        const result = (adapter as any).formatAddress(0x1234);
        assert.strictEqual(result, '0x00001234 = main+16');
      });

      test('should format address with symbol at exact offset', () => {
        const mockSourceMap = {
          findSymbolOffset: sinon.stub().returns({ symbol: 'start', offset: 0 })
        };
        (adapter as any).sourceMap = mockSourceMap;
        
        const result = (adapter as any).formatAddress(0x1000);
        assert.strictEqual(result, '0x00001000 = start');
      });
    });

    suite('errorString', () => {
      test('should format Error object with message only when trace is false', () => {
        (adapter as any).trace = false;
        const error = new Error('Test error');
        const result = (adapter as any).errorString(error);
        assert.strictEqual(result, 'Test error');
      });

      test('should format Error object with stack when trace is true', () => {
        (adapter as any).trace = true;
        const error = new Error('Test error');
        error.stack = 'Error: Test error\n    at test';
        const result = (adapter as any).errorString(error);
        assert.strictEqual(result, 'Error: Test error\n    at test');
      });

      test('should format non-Error values', () => {
        const result = (adapter as any).errorString('string error');
        assert.strictEqual(result, 'string error');
      });
    });

    suite('Cache Management', () => {
      test('invalidateCache should reset cache state', () => {
        (adapter as any).cacheValid = true;
        (adapter as any).cachedCpuInfo = { pc: '0x1000' };
        
        (adapter as any).invalidateCache();
        
        assert.strictEqual((adapter as any).cacheValid, false);
        assert.strictEqual((adapter as any).cachedCpuInfo, undefined);
      });

      test('getCachedCpuInfo should fetch fresh data when running', async () => {
        const mockCpuInfo = createMockCpuInfo({ pc: '0x1000', d0: '0x42' });
        mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
        (adapter as any).isRunning = true;
        
        const result = await (adapter as any).getCachedCpuInfo();
        
        assert.deepStrictEqual(result, mockCpuInfo);
        assert.ok(mockVAmiga.getCpuInfo.calledOnce);
      });

      test('getCachedCpuInfo should use cache when stopped and valid', async () => {
        const cachedInfo = createMockCpuInfo({ pc: '0x2000', d0: '0x84' });
        (adapter as any).isRunning = false;
        (adapter as any).cacheValid = true;
        (adapter as any).cachedCpuInfo = cachedInfo;
        
        const result = await (adapter as any).getCachedCpuInfo();
        
        assert.deepStrictEqual(result, cachedInfo);
        assert.ok(mockVAmiga.getCpuInfo.notCalled);
      });
    });
  });

  suite('Expression Evaluation', () => {
    setup(() => {
      // Mock CPU info for evaluation tests
      mockVAmiga.getCpuInfo.resolves(createMockCpuInfo({
        pc: '0x1000',
        d0: '0x42',
        a0: '0x8000'
      }));
      mockVAmiga.getAllCustomRegisters.resolves({
        DMACON: { value: '0x8200' }
      });
    });

    test('should evaluate empty expression', async () => {
      const result = await (adapter as any).evaluate('');
      assert.strictEqual(result.type, EvaluateResultType.EMPTY);
      assert.strictEqual(result.value, undefined);
    });

    test('should evaluate decimal literal', async () => {
      const result = await (adapter as any).evaluate('42');
      assert.strictEqual(result.value, 42);
    });

    test('should evaluate hex literal', async () => {
      // Mock readMemoryBuffer to return valid buffer
      const mockBuffer = Buffer.alloc(4);
      mockBuffer.writeUInt32BE(0x12345678, 0);
      mockVAmiga.readMemoryBuffer.resolves(mockBuffer);
      
      const result = await (adapter as any).evaluate('0x1000');
      
      // Should read value at address and set memory reference
      assert.ok(mockVAmiga.readMemoryBuffer.called);
      assert.strictEqual(result.memoryReference, '0x00001000');
      assert.strictEqual(result.value, 0x12345678);
    });

    test('should evaluate CPU register', async () => {
      // Mock source map without symbols
      (adapter as any).sourceMap = { getSymbols: () => ({}) };
      
      const result = await (adapter as any).evaluate('d0');
      assert.strictEqual(result.value, 0x42);
      assert.strictEqual(result.type, EvaluateResultType.DATA_REGISTER);
    });

    test('should evaluate address register', async () => {
      (adapter as any).sourceMap = { getSymbols: () => ({}) };
      
      const result = await (adapter as any).evaluate('a0');
      assert.strictEqual(result.value, 0x8000);
      assert.strictEqual(result.type, EvaluateResultType.ADDRESS_REGISTER);
    });

    test('should evaluate symbol', async () => {
      (adapter as any).sourceMap = { 
        getSymbols: () => ({ main: 0x2000 })
      };
      
      const result = await (adapter as any).evaluate('main');
      assert.strictEqual(result.value, 0x2000);
      assert.strictEqual(result.type, EvaluateResultType.SYMBOL);
      assert.strictEqual(result.memoryReference, '0x00002000');
    });

    test('should evaluate complex expression', async () => {
      (adapter as any).sourceMap = { getSymbols: () => ({}) };
      
      const result = await (adapter as any).evaluate('d0 + 8');
      assert.strictEqual(result.value, 0x42 + 8);
      assert.strictEqual(result.type, EvaluateResultType.PARSED);
    });
  });

  suite('Temporary Breakpoints', () => {
    test('setTmpBreakpoint should add breakpoint', () => {
      const findStub = sinon.stub(adapter as any, 'findSourceBreakpoint').returns(undefined);
      
      (adapter as any).setTmpBreakpoint(0x1000, 'step');
      
      const tmpBps = (adapter as any).tmpBreakpoints;
      assert.strictEqual(tmpBps.length, 1);
      assert.strictEqual(tmpBps[0].address, 0x1000);
      assert.strictEqual(tmpBps[0].reason, 'step');
      assert.ok(mockVAmiga.setBreakpoint.calledWith(0x1000));
      
      findStub.restore();
    });

    test('setTmpBreakpoint should not add if breakpoint exists', () => {
      const findStub = sinon.stub(adapter as any, 'findSourceBreakpoint').returns({ id: 1, address: 0x1000 });
      
      (adapter as any).setTmpBreakpoint(0x1000, 'step');
      
      const tmpBps = (adapter as any).tmpBreakpoints;
      assert.strictEqual(tmpBps.length, 0);
      assert.ok(mockVAmiga.setBreakpoint.notCalled);
      
      findStub.restore();
    });

    test('findSourceBreakpoint should find existing breakpoint', () => {
      const sourceBreakpoints = new Map();
      sourceBreakpoints.set('test.c', [{ id: 1, address: 0x1000 }, { id: 2, address: 0x2000 }]);
      (adapter as any).sourceBreakpoints = sourceBreakpoints;
      
      const result = (adapter as any).findSourceBreakpoint(0x1000);
      assert.deepStrictEqual(result, { id: 1, address: 0x1000 });
    });

    test('findSourceBreakpoint should return undefined if not found', () => {
      const sourceBreakpoints = new Map();
      sourceBreakpoints.set('test.c', [{ id: 1, address: 0x1000 }]);
      (adapter as any).sourceBreakpoints = sourceBreakpoints;
      
      const result = (adapter as any).findSourceBreakpoint(0x3000);
      assert.strictEqual(result, undefined);
    });
  });

  suite('Stack Analysis', () => {
    test('guessStack should return current PC as first frame', async () => {
      mockVAmiga.getCpuInfo.resolves(createMockCpuInfo({ pc: '0x1000', a7: '0x8000' }));
      mockVAmiga.readMemoryBuffer.resolves(Buffer.alloc(128));
      
      const result = await (adapter as any).guessStack(1);
      
      assert.strictEqual(result.length, 1);
      assert.deepStrictEqual(result[0], [0x1000, 0x1000]);
    });

    test('guessStack should find JSR return addresses', async () => {
      mockVAmiga.getCpuInfo.resolves(createMockCpuInfo({ pc: '0x1000', a7: '0x8000' }));
      
      // Create mock stack with a return address
      const stackBuffer = Buffer.alloc(128);
      stackBuffer.writeInt32BE(0x2000, 0); // Return address at top of stack
      mockVAmiga.readMemoryBuffer.withArgs(0x8000, 128).resolves(stackBuffer);
      
      // Mock previous instruction bytes (JSR instruction)
      const instrBuffer = Buffer.alloc(6);
      instrBuffer.writeUInt16BE(0x4e80, 4); // JSR instruction at offset 2
      mockVAmiga.readMemoryBuffer.withArgs(0x2000 - 6, 6).resolves(instrBuffer);
      
      const result = await (adapter as any).guessStack(5);
      
      assert.strictEqual(result.length, 2);
      assert.deepStrictEqual(result[0], [0x1000, 0x1000]); // Current frame
      assert.deepStrictEqual(result[1], [0x2000 - 2, 0x2000]); // JSR frame
    });
  });

  suite('Error Handling', () => {
    test('sendError should format error response', () => {
      const mockResponse: any = { body: {} };
      const sendErrorResponseSpy = sinon.spy(adapter as any, 'sendErrorResponse');
      
      (adapter as any).sendError(mockResponse, ErrorCode.MEMORY_READ_ERROR, 'Test error', new Error('cause'));
      
      assert.ok(sendErrorResponseSpy.calledOnce);
      const call = sendErrorResponseSpy.getCall(0);
      assert.strictEqual(call.args[0], mockResponse);
      assert.strictEqual(call.args[1].id, ErrorCode.MEMORY_READ_ERROR);
      assert.ok(call.args[1].format.includes('Test error'));
      assert.ok(call.args[1].format.includes('cause'));
    });
  });
});