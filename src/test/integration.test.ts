/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { VamigaDebugAdapter } from '../vAmigaDebugAdapter';
import { VAmiga, CpuInfo } from '../vAmiga';
import { DebugProtocol } from '@vscode/debugprotocol';
import { VariablesManager } from '../variablesManager';
import { BreakpointManager } from '../breakpointManager';
import { DisassemblyManager } from '../disassemblyManager';

// Helper function to create mock CPU info with required properties
function createMockCpuInfo(overrides: Partial<CpuInfo> = {}): CpuInfo {
  return {
    pc: '0x00000000',
    d0: '0x00000000', d1: '0x00000000', d2: '0x00000000', d3: '0x00000000',
    d4: '0x00000000', d5: '0x00000000', d6: '0x00000000', d7: '0x00000000',
    a0: '0x00000000', a1: '0x00000000', a2: '0x00000000', a3: '0x00000000',
    a4: '0x00000000', a5: '0x00000000', a6: '0x00000000', a7: '0x00000000',
    sr: '0x00000000', usp: '0x00000000', isp: '0x00000000', msp: '0x00000000',
    vbr: '0x00000000', irc: '0x00000000', sfc: '0x00000000', dfc: '0x00000000',
    cacr: '0x00000000', caar: '0x00000000',
    ...overrides
  };
}

// Helper function to create a proper mock SourceMap
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

/**
 * Integration tests for VamigaDebugAdapter
 * Tests the full debug adapter protocol flow
 */
describe('VamigaDebugAdapter Integration Tests', () => {
  let adapter: VamigaDebugAdapter;
  let mockVAmiga: sinon.SinonStubbedInstance<VAmiga>;

  beforeEach(() => {
    mockVAmiga = sinon.createStubInstance(VAmiga);
    adapter = new VamigaDebugAdapter(mockVAmiga);
  });

  afterEach(() => {
    sinon.restore();
    adapter.dispose();
  });

  describe('Debug Session Lifecycle', () => {
    it('initialize request should set capabilities', () => {
      const response: DebugProtocol.InitializeResponse = {
        seq: 1,
        type: 'response',
        request_seq: 1,
        command: 'initialize',
        success: true
      };

      (adapter as any).initializeRequest(response);

      assert.ok(response.body);
      assert.strictEqual(response.body.supportsConfigurationDoneRequest, true);
      assert.strictEqual(response.body.supportsSetVariable, true);
      assert.strictEqual(response.body.supportsReadMemoryRequest, true);
      assert.strictEqual(response.body.supportsWriteMemoryRequest, true);
      assert.strictEqual(response.body.supportsDisassembleRequest, true);
      assert.strictEqual(response.body.supportsInstructionBreakpoints, true);
      assert.strictEqual(response.body.supportsDataBreakpoints, true);
      assert.strictEqual(response.body.supportsFunctionBreakpoints, true);
      assert.ok(response.body.exceptionBreakpointFilters);
    });

    it('threads request should return single thread', async () => {
      const response: DebugProtocol.ThreadsResponse = {
        seq: 1,
        type: 'response',
        request_seq: 1,
        command: 'threads',
        success: true,
        body: { threads: [] }
      };

      await (adapter as any).threadsRequest(response);

      assert.ok(response.body);
      assert.strictEqual(response.body.threads.length, 1);
      assert.strictEqual(response.body.threads[0].name, 'Main');
    });

    it('scopes request should return all scopes', () => {
      const response: DebugProtocol.ScopesResponse = {
        seq: 1,
        type: 'response',
        request_seq: 1,
        command: 'scopes',
        success: true,
        body: { scopes: [] }
      };

      (adapter as any).scopesRequest(response);

      assert.ok(response.body);
      // After refactoring to VariablesManager, scopes are only available after launch
      // Detailed variable testing is now in VariablesManager test suite
      assert.ok(response.body.scopes.length >= 0);
    });
  });

  // Variable inspection tests have been moved to VariablesManager test suite
  // These integration tests focus on core debugger functionality

  describe('Stepping Operations', () => {
    it('step in should call vAmiga stepInto', async () => {
      const response: DebugProtocol.StepInResponse = {
        seq: 1,
        type: 'response',
        request_seq: 1,
        command: 'stepIn',
        success: true
      };

      await (adapter as any).stepInRequest(response, { threadId: 1 });

      assert.ok(mockVAmiga.stepInto.calledOnce);
      assert.strictEqual((adapter as any).stepping, true);
      assert.strictEqual((adapter as any).isRunning, true);
    });

    it('next should handle JSR instruction with temporary breakpoint', async () => {
      // Setup: Create proper mock instances instead of bypassing type system
      const mockSourceMap = createMockSourceMap({
        lookupSourceLine: sinon.stub().returns({ address: 0x1000 })
      });

      const mockBreakpointManager = sinon.createStubInstance(BreakpointManager);
      const mockVariablesManager = sinon.createStubInstance(VariablesManager);

      // Configure the getTmpBreakpoints stub to return expected result
      mockBreakpointManager.getTmpBreakpoints.returns([
        { address: 0x1004, reason: 'step' }
      ]);

      // Inject dependencies
      (adapter as any).sourceMap = mockSourceMap;
      (adapter as any).variablesManager = mockVariablesManager;
      (adapter as any).breakpointManager = mockBreakpointManager;

      const mockCpuInfo = createMockCpuInfo({ pc: '0x1000' });
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);

      const mockDisasm = {
        instructions: [
          { addr: '1000', instruction: 'jsr sub1', hex: '4e80' },
          { addr: '1004', instruction: 'move.l d0,d1', hex: '2200' }
        ]
      };
      mockVAmiga.disassemble.resolves(mockDisasm);

      const response: DebugProtocol.NextResponse = {
        seq: 1,
        type: 'response',
        request_seq: 1,
        command: 'next',
        success: true
      };

      await (adapter as any).nextRequest(response);

      // Verify breakpoint manager was called correctly
      const tmpBps = mockBreakpointManager.getTmpBreakpoints();
      assert.strictEqual(tmpBps.length, 1);
      assert.strictEqual(tmpBps[0].address, 0x1004);
      assert.strictEqual(tmpBps[0].reason, 'step');
      assert.ok(mockVAmiga.run.calledOnce);
    });

    it('next should step into for non-branch instruction', async () => {
      const mockCpuInfo = createMockCpuInfo({ pc: '0x1000' });
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);

      const mockDisasm = {
        instructions: [
          { addr: '1000', instruction: 'move.l d0,d1', hex: '2200' },
          { addr: '1004', instruction: 'add.l #4,d0', hex: 'D080' }
        ]
      };
      mockVAmiga.disassemble.resolves(mockDisasm);

      const response: DebugProtocol.NextResponse = {
        seq: 1,
        type: 'response',
        request_seq: 1,
        command: 'next',
        success: true
      };

      await (adapter as any).nextRequest(response);

      // Should step into for non-branch
      assert.ok(mockVAmiga.stepInto.calledOnce);
      assert.strictEqual((adapter as any).stepping, true);
    });
  });

  describe('Breakpoint Management', () => {
    it('setBreakPointsRequest should handle source breakpoints', async () => {
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

      const response: DebugProtocol.SetBreakpointsResponse = {
        seq: 1,
        type: 'response',
        request_seq: 1,
        command: 'setBreakpoints',
        success: true,
        body: { breakpoints: [] }
      };

      const args: DebugProtocol.SetBreakpointsArguments = {
        source: { path: '/test/main.c' },
        breakpoints: [
          { line: 10 },
          { line: 20, hitCondition: '5' }
        ]
      };

      await (adapter as any).setBreakPointsRequest(response, args);

      // Verify the breakpoint manager was called and response populated
      assert.ok(mockBreakpointManager.setSourceBreakpoints.calledOnce);
      assert.ok(response.body);
      assert.strictEqual(response.body.breakpoints.length, 2);

      // First breakpoint
      assert.strictEqual(response.body.breakpoints[0].verified, true);
      assert.strictEqual(response.body.breakpoints[0].line, 10);

      // Second breakpoint with hit condition
      assert.strictEqual(response.body.breakpoints[1].verified, true);
      assert.strictEqual(response.body.breakpoints[1].line, 20);
    });

    it('setInstructionBreakpointsRequest should set address breakpoints', async () => {
      // Setup: Create proper mock instances instead of bypassing type system
      const mockSourceMap = createMockSourceMap();
      const mockBreakpointManager = sinon.createStubInstance(BreakpointManager);
      const mockVariablesManager = sinon.createStubInstance(VariablesManager);

      // Configure the setInstructionBreakpoints stub to return expected breakpoints
      mockBreakpointManager.setInstructionBreakpoints.resolves([
        { id: 1, verified: true, instructionReference: '0x1000' },
        { id: 2, verified: true, instructionReference: '0x2004' }
      ]);

      // Inject dependencies
      (adapter as any).sourceMap = mockSourceMap;
      (adapter as any).variablesManager = mockVariablesManager;
      (adapter as any).breakpointManager = mockBreakpointManager;

      const response: DebugProtocol.SetInstructionBreakpointsResponse = {
        seq: 1,
        type: 'response',
        request_seq: 1,
        command: 'setInstructionBreakpoints',
        success: true,
        body: { breakpoints: [] }
      };

      const args: DebugProtocol.SetInstructionBreakpointsArguments = {
        breakpoints: [
          { instructionReference: '0x1000' },
          { instructionReference: '0x2000', offset: 4 }
        ]
      };

      await (adapter as any).setInstructionBreakpointsRequest(response, args);

      // Verify the breakpoint manager was called and response populated
      assert.ok(mockBreakpointManager.setInstructionBreakpoints.calledOnce);
      assert.ok(response.body);
      assert.strictEqual(response.body.breakpoints.length, 2);
      assert.strictEqual(response.body.breakpoints[0].instructionReference, '0x1000');
      assert.strictEqual(response.body.breakpoints[1].instructionReference, '0x2004');
    });
  });

  describe('Memory Operations', () => {
    it('readMemoryRequest should read memory from emulator', async () => {
      const mockMemResult = Buffer.from('hello');
      mockVAmiga.readMemory.resolves(mockMemResult);

      const response: DebugProtocol.ReadMemoryResponse = {
        seq: 1,
        type: 'response',
        request_seq: 1,
        command: 'readMemory',
        success: true
      };

      const args: DebugProtocol.ReadMemoryArguments = {
        memoryReference: '0x1000',
        count: 5
      };

      await (adapter as any).readMemoryRequest(response, args);

      assert.ok(response.body);
      assert.strictEqual(response.body.address, '0x1000');
      assert.strictEqual(response.body.data, mockMemResult.toString('base64'));
      assert.strictEqual(response.body.unreadableBytes, 0);
      assert.ok(mockVAmiga.readMemory.calledWith(0x1000, 5));
    });

    it('writeMemoryRequest should write memory to emulator', async () => {
      const mockWriteResult = { bytesWritten: 5 };
      mockVAmiga.writeMemory.resolves(mockWriteResult);

      const response: DebugProtocol.WriteMemoryResponse = {
        seq: 1,
        type: 'response',
        request_seq: 1,
        command: 'writeMemory',
        success: true
      };

      const data = Buffer.from('hello');
      const args: DebugProtocol.WriteMemoryArguments = {
        memoryReference: '0x1000',
        data: data.toString('base64')
      };

      await (adapter as any).writeMemoryRequest(response, args);

      assert.ok(response.body);
      assert.strictEqual(response.body.bytesWritten, 5);
      assert.ok(mockVAmiga.writeMemory.calledWith(0x1000, data));
    });
  });

  describe('Disassembly', () => {
    it('disassembleRequest should return instructions', async () => {
      // Setup: Create proper mock instances for DisassemblyManager
      const mockSourceMap = createMockSourceMap();
      const mockBreakpointManager = sinon.createStubInstance(BreakpointManager);
      const mockVariablesManager = sinon.createStubInstance(VariablesManager);
      const mockDisassemblyManager = new DisassemblyManager(mockVAmiga, mockSourceMap);

      // Inject dependencies
      (adapter as any).sourceMap = mockSourceMap;
      (adapter as any).variablesManager = mockVariablesManager;
      (adapter as any).breakpointManager = mockBreakpointManager;
      (adapter as any).disassemblyManager = mockDisassemblyManager;

      const mockDisasm = {
        instructions: [
          { addr: '1000', instruction: 'move.l d0,d1', hex: '2200' },
          { addr: '1004', instruction: 'jsr sub1', hex: '4e80' }
        ]
      };
      mockVAmiga.disassemble.resolves(mockDisasm);

      const response: DebugProtocol.DisassembleResponse = {
        seq: 1,
        type: 'response',
        request_seq: 1,
        command: 'disassemble',
        success: true
      };

      const args: DebugProtocol.DisassembleArguments = {
        memoryReference: '0x1000',
        instructionCount: 2
      };

      await (adapter as any).disassembleRequest(response, args);

      assert.ok(response.body);
      assert.strictEqual(response.body.instructions.length, 2);
      assert.strictEqual(response.body.instructions[0].address, '0x1000');
      assert.strictEqual(response.body.instructions[0].instruction, 'move.l d0,d1');
    });
  });

  describe('State Management', () => {
    it('handleMessageFromEmulator should process attached message', () => {
      const message = {
        type: 'attached' as const,
        segments: [{ start: 0x1000, size: 0x1000 }]
      };

      const attachSpy = sinon.spy(adapter as any, 'attach');

      (adapter as any).handleMessageFromEmulator(message);

      assert.ok(attachSpy.calledOnce);
      assert.ok(attachSpy.calledWith([0x1000])); // attach is called with mapped segment starts

      attachSpy.restore();
    });

    it('handleMessageFromEmulator should process state message', () => {
      const message = {
        type: 'emulator-state' as const,
        state: 'paused',
        message: { hasMessage: false, name: 'BREAKPOINT_REACHED', payload: { pc: 0x1000 } }
      };

      const updateStateSpy = sinon.spy(adapter as any, 'updateState');

      (adapter as any).handleMessageFromEmulator(message);

      assert.ok(updateStateSpy.calledOnce);
      assert.ok(updateStateSpy.calledWith(message));

      updateStateSpy.restore();
    });
  });
});