/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { VamigaDebugAdapter } from '../vamigaDebugAdapter';
import { VAmigaView, CpuInfo } from '../vAmigaView';
import { DebugProtocol } from '@vscode/debugprotocol';

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
 * Integration tests for VamigaDebugAdapter
 * Tests the full debug adapter protocol flow
 */
suite('VamigaDebugAdapter Integration Tests', () => {
  let adapter: VamigaDebugAdapter;
  let mockVAmiga: sinon.SinonStubbedInstance<VAmigaView>;

  setup(() => {
    adapter = new VamigaDebugAdapter();
    mockVAmiga = sinon.createStubInstance(VAmigaView);
    (adapter as any).vAmiga = mockVAmiga;
  });

  teardown(() => {
    sinon.restore();
    adapter.dispose();
  });

  suite('Debug Session Lifecycle', () => {
    test('initialize request should set capabilities', () => {
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

    test('threads request should return single thread', async () => {
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

    test('scopes request should return all scopes', () => {
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
      assert.ok(response.body.scopes.length >= 3);
      
      const scopeNames = response.body.scopes.map(s => s.name);
      assert.ok(scopeNames.includes('CPU Registers'));
      assert.ok(scopeNames.includes('Custom Registers'));
      assert.ok(scopeNames.includes('Vectors'));
    });
  });

  suite('Variable Inspection', () => {
    test('variables request for registers should return CPU registers', async () => {
      const mockCpuInfo = createMockCpuInfo({
        pc: '0x1000',
        d0: '0x42',
        d1: '0x84',
        a0: '0x8000',
        sr: '0x2000'
      });
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      
      const handles = (adapter as any).variableHandles;
      const registersRef = handles.create('registers');
      
      const response: DebugProtocol.VariablesResponse = {
        seq: 1,
        type: 'response',
        request_seq: 1,
        command: 'variables',
        success: true,
        body: { variables: [] }
      };
      
      await (adapter as any).variablesRequest(response, { variablesReference: registersRef });
      
      assert.ok(response.body);
      assert.ok(response.body.variables.length > 0);
      
      const variableNames = response.body.variables.map(v => v.name);
      assert.ok(variableNames.includes('pc'));
      assert.ok(variableNames.includes('d0'));
      assert.ok(variableNames.includes('a0'));
    });

    test('variables request for custom registers should return custom registers', async () => {
      const mockCustomRegs = {
        DMACON: { value: '0x8200' },
        INTENA: { value: '0x4000' }
      };
      mockVAmiga.getAllCustomRegisters.resolves(mockCustomRegs);
      
      const handles = (adapter as any).variableHandles;
      const customRef = handles.create('custom');
      
      const response: DebugProtocol.VariablesResponse = {
        seq: 1,
        type: 'response',
        request_seq: 1,
        command: 'variables',
        success: true,
        body: { variables: [] }
      };
      
      await (adapter as any).variablesRequest(response, { variablesReference: customRef });
      
      assert.ok(response.body);
      assert.strictEqual(response.body.variables.length, 2);
      
      const dmacon = response.body.variables.find(v => v.name === 'DMACON');
      assert.ok(dmacon);
      assert.strictEqual(dmacon.value, '0x8200');
    });
  });

  suite('Stepping Operations', () => {
    test('step in should call vAmiga stepInto', async () => {
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

    test('next should handle JSR instruction with temporary breakpoint', async () => {
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
      
      // Should set temp breakpoint at next instruction and run
      const tmpBps = (adapter as any).tmpBreakpoints;
      assert.strictEqual(tmpBps.length, 1);
      assert.strictEqual(tmpBps[0].address, 0x1004);
      assert.strictEqual(tmpBps[0].reason, 'step');
      assert.ok(mockVAmiga.run.calledOnce);
    });

    test('next should step into for non-branch instruction', async () => {
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

  suite('Breakpoint Management', () => {
    test('setBreakPointsRequest should handle source breakpoints', async () => {
      // Mock source map
      const mockSourceMap = {
        lookupSourceLine: sinon.stub().returns({ address: 0x1000 })
      };
      (adapter as any).sourceMap = mockSourceMap;
      
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
      
      assert.ok(response.body);
      assert.strictEqual(response.body.breakpoints.length, 2);
      assert.ok(mockVAmiga.setBreakpoint.calledTwice);
      
      // First breakpoint
      assert.strictEqual(response.body.breakpoints[0].verified, true);
      assert.strictEqual(response.body.breakpoints[0].line, 10);
      
      // Second breakpoint with hit condition
      assert.strictEqual(response.body.breakpoints[1].verified, true);
      assert.strictEqual(response.body.breakpoints[1].line, 20);
    });

    test('setInstructionBreakpointsRequest should set address breakpoints', async () => {
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
      
      assert.ok(response.body);
      assert.strictEqual(response.body.breakpoints.length, 2);
      assert.ok(mockVAmiga.setBreakpoint.calledWith(0x1000));
      assert.ok(mockVAmiga.setBreakpoint.calledWith(0x2004)); // with offset
    });
  });

  suite('Memory Operations', () => {
    test('readMemoryRequest should read memory from emulator', async () => {
      const mockMemResult = {
        address: '0x1000',
        data: Buffer.from('hello').toString('base64')
      };
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
      assert.strictEqual(response.body.data, mockMemResult.data);
      assert.strictEqual(response.body.unreadableBytes, 0);
      assert.ok(mockVAmiga.readMemory.calledWith(0x1000, 5));
    });

    test('writeMemoryRequest should write memory to emulator', async () => {
      const mockWriteResult = { bytesWritten: 5 };
      mockVAmiga.writeMemory.resolves(mockWriteResult);
      
      const response: DebugProtocol.WriteMemoryResponse = {
        seq: 1,
        type: 'response',
        request_seq: 1,
        command: 'writeMemory',
        success: true
      };
      
      const data = Buffer.from('hello').toString('base64');
      const args: DebugProtocol.WriteMemoryArguments = {
        memoryReference: '0x1000',
        data: data
      };
      
      await (adapter as any).writeMemoryRequest(response, args);
      
      assert.ok(response.body);
      assert.strictEqual(response.body.bytesWritten, 5);
      assert.ok(mockVAmiga.writeMemory.calledWith(0x1000, data));
    });
  });

  suite('Disassembly', () => {
    test('disassembleRequest should return instructions', async () => {
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

  suite('State Management', () => {
    test('handleMessageFromEmulator should process attached message', () => {
      const message = {
        type: 'attached' as const,
        segments: [{ start: 0x1000, size: 0x1000 }]
      };
      
      const attachSpy = sinon.spy(adapter as any, 'attach');
      
      (adapter as any).handleMessageFromEmulator(message);
      
      assert.ok(attachSpy.calledOnce);
      assert.ok(attachSpy.calledWith(message));
      
      attachSpy.restore();
    });

    test('handleMessageFromEmulator should process state message', () => {
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