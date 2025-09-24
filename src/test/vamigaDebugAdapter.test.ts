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

      // Verify: Response contains correct result (should be in hex format)
      assert.strictEqual(response.body?.result, '0x4a'); // 0x42 + 8 = 0x4a
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

    test('should parse DMACON register bits correctly', () => {
      // Test DMACON value: 0x8300 (SET=1, DMAEN=1, BPLEN=1)
      const bits = registerParsers.parseDmaconRegister(0x8300);
      
      const setBit = bits.find(b => b.name === 'SET_CLR');
      const dmaenBit = bits.find(b => b.name === 'DMAEN');
      const bplenBit = bits.find(b => b.name === 'BPLEN');
      const bltenBit = bits.find(b => b.name === 'BLTEN');
      
      assert.strictEqual(setBit?.value, true, 'SET_CLR should be true');
      assert.strictEqual(dmaenBit?.value, true, 'DMAEN should be true');
      assert.strictEqual(bplenBit?.value, true, 'BPLEN should be true');
      assert.strictEqual(bltenBit?.value, false, 'BLTEN should be false');
      assert.ok(setBit?.description?.includes('Set/clear'), 'Should have description');
    });

    test('should parse INTENA register bits correctly', () => {
      // Test INTENA value: 0xC020 (SET=1, INTEN=1, VERTB=1)
      const bits = registerParsers.parseIntenaRegister(0xC020);
      
      const setBit = bits.find(b => b.name === 'SET_CLR');
      const intenBit = bits.find(b => b.name === 'INTEN');
      const vertbBit = bits.find(b => b.name === 'VERTB');
      const blitBit = bits.find(b => b.name === 'BLIT');
      
      assert.strictEqual(setBit?.value, true, 'SET_CLR should be true');
      assert.strictEqual(intenBit?.value, true, 'INTEN should be true');
      assert.strictEqual(vertbBit?.value, true, 'VERTB should be true');
      assert.strictEqual(blitBit?.value, false, 'BLIT should be false');
      assert.ok(vertbBit?.description?.includes('vertical blank'), 'Should have description');
    });

    test('should route to correct parser based on register name', () => {
      const dmaconBits = registerParsers.parseRegister('DMACON', 0x0200);
      const intenaBits = registerParsers.parseRegister('INTENA', 0x4000);
      const unknownBits = registerParsers.parseRegister('UNKNOWN', 0x1234);
      
      assert.ok(dmaconBits.length > 0, 'DMACON should return bit definitions');
      assert.ok(intenaBits.length > 0, 'INTENA should return bit definitions');
      assert.strictEqual(unknownBits.length, 0, 'Unknown register should return empty array');
      
      // Verify different parsers are called
      const dmaenBit = dmaconBits.find(b => b.name === 'DMAEN');
      const intenBit = intenaBits.find(b => b.name === 'INTEN');
      
      assert.ok(dmaenBit, 'Should have DMACON-specific bits');
      assert.ok(intenBit, 'Should have INTENA-specific bits');
    });

    test('should parse BPLCON0 register bits correctly', () => {
      // Test BPLCON0 value: 0xFC04 (HIRES=1, BPU=7, HOMOD=1, DBLPF=1, LACE=1)
      const bits = registerParsers.parseBplcon0Register(0xFC04);
      
      const hiresBit = bits.find(b => b.name === 'HIRES');
      const bpuValue = bits.find(b => b.name === 'BPU');
      const homodBit = bits.find(b => b.name === 'HOMOD');
      const dblpfBit = bits.find(b => b.name === 'DBLPF');
      const laceBit = bits.find(b => b.name === 'LACE');
      const ersyBit = bits.find(b => b.name === 'ERSY');
      
      assert.strictEqual(hiresBit?.value, true, 'HIRES should be true');
      assert.strictEqual(bpuValue?.value, 7, 'BPU should be 7');
      assert.strictEqual(homodBit?.value, true, 'HOMOD should be true');
      assert.strictEqual(dblpfBit?.value, true, 'DBLPF should be true');
      assert.strictEqual(laceBit?.value, true, 'LACE should be true');
      assert.strictEqual(ersyBit?.value, false, 'ERSY should be false');
      assert.ok(hiresBit?.description?.includes('High-resolution'), 'Should have description');
    });

    test('should parse BPLCON1 register bits correctly', () => {
      // Test BPLCON1 value: 0x0055 (PF2H=5, PF1H=5)
      const bits = registerParsers.parseBplcon1Register(0x0055);
      
      const pf2hValue = bits.find(b => b.name === 'PF2H');
      const pf1hValue = bits.find(b => b.name === 'PF1H');
      const pf2h0Bit = bits.find(b => b.name === 'PF2H0');
      const pf1h0Bit = bits.find(b => b.name === 'PF1H0');
      const pf2h2Bit = bits.find(b => b.name === 'PF2H2');
      
      assert.strictEqual(pf2hValue?.value, 5, 'PF2H should be 5');
      assert.strictEqual(pf1hValue?.value, 5, 'PF1H should be 5');
      assert.strictEqual(pf2h0Bit?.value, true, 'PF2H0 should be true');
      assert.strictEqual(pf1h0Bit?.value, true, 'PF1H0 should be true');
      assert.strictEqual(pf2h2Bit?.value, true, 'PF2H2 should be true');
      assert.ok(pf2hValue?.description?.includes('scroll'), 'Should have scroll description');
    });

    test('should parse BPLCON2 register bits correctly', () => {
      // Test BPLCON2 value: 0x0047 (PF2PRI=1, PF2P=0, PF1P=7)
      const bits = registerParsers.parseBplcon2Register(0x0047);
      
      const pf2priBit = bits.find(b => b.name === 'PF2PRI');
      const pf2pValue = bits.find(b => b.name === 'PF2P');
      const pf1pValue = bits.find(b => b.name === 'PF1P');
      const pf1p0Bit = bits.find(b => b.name === 'PF1P0');
      const pf1p1Bit = bits.find(b => b.name === 'PF1P1');
      const pf1p2Bit = bits.find(b => b.name === 'PF1P2');
      
      assert.strictEqual(pf2priBit?.value, true, 'PF2PRI should be true');
      assert.strictEqual(pf2pValue?.value, 0, 'PF2P should be 0');
      assert.strictEqual(pf1pValue?.value, 7, 'PF1P should be 7');
      assert.strictEqual(pf1p0Bit?.value, true, 'PF1P0 should be true');
      assert.strictEqual(pf1p1Bit?.value, true, 'PF1P1 should be true');
      assert.strictEqual(pf1p2Bit?.value, true, 'PF1P2 should be true');
      assert.ok(pf2priBit?.description?.includes('priority'), 'Should have priority description');
    });

    test('should parse BPLCON3 register bits correctly', () => {
      // Test BPLCON3 value: 0xE078 (BANK=7, SPRES=1, BRDRSPRT=1, BRDNTRAN=1, PF2OF=7, BRDBLNK=1)
      const bits = registerParsers.parseBplcon3Register(0xE078);
      
      const bankValue = bits.find(b => b.name === 'BANK');
      const spresBit = bits.find(b => b.name === 'SPRES');
      const brdrsprtBit = bits.find(b => b.name === 'BRDRSPRT');
      const brdntranBit = bits.find(b => b.name === 'BRDNTRAN');
      const pf2ofValue = bits.find(b => b.name === 'PF2OF');
      const brdblnkBit = bits.find(b => b.name === 'BRDBLNK');
      
      assert.strictEqual(bankValue?.value, 7, 'BANK should be 7');
      assert.strictEqual(spresBit?.value, true, 'SPRES should be true');
      assert.strictEqual(brdrsprtBit?.value, true, 'BRDRSPRT should be true');  
      assert.strictEqual(brdntranBit?.value, true, 'BRDNTRAN should be true');
      assert.strictEqual(pf2ofValue?.value, 7, 'PF2OF should be 7');
      assert.strictEqual(brdblnkBit?.value, true, 'BRDBLNK should be true');
      assert.ok(bankValue?.description?.includes('Color bank'), 'Should have bank description');
    });

    test('should route BPLCON registers to correct parsers', () => {
      const bplcon0Bits = registerParsers.parseRegister('BPLCON0', 0x8000);
      const bplcon1Bits = registerParsers.parseRegister('BPLCON1', 0x0011);
      const bplcon2Bits = registerParsers.parseRegister('BPLCON2', 0x0040);
      const bplcon3Bits = registerParsers.parseRegister('BPLCON3', 0x2000);
      
      assert.ok(bplcon0Bits.length > 0, 'BPLCON0 should return bit definitions');
      assert.ok(bplcon1Bits.length > 0, 'BPLCON1 should return bit definitions');
      assert.ok(bplcon2Bits.length > 0, 'BPLCON2 should return bit definitions');
      assert.ok(bplcon3Bits.length > 0, 'BPLCON3 should return bit definitions');
      
      // Verify different parsers are called by looking for specific bits
      const hiresBit = bplcon0Bits.find(b => b.name === 'HIRES');
      const pf1hBit = bplcon1Bits.find(b => b.name === 'PF1H');
      const pf2priBit = bplcon2Bits.find(b => b.name === 'PF2PRI');
      const bankBit = bplcon3Bits.find(b => b.name === 'BANK');
      
      assert.ok(hiresBit, 'Should have BPLCON0-specific HIRES bit');
      assert.ok(pf1hBit, 'Should have BPLCON1-specific PF1H bit');
      assert.ok(pf2priBit, 'Should have BPLCON2-specific PF2PRI bit');
      assert.ok(bankBit, 'Should have BPLCON3-specific BANK bit');
    });

    test('should parse BLTCON0 register bits correctly', () => {
      // Test BLTCON0 value: 0x5FCA (ASH=5, USEA=1, USEB=1, USEC=1, USED=1, LF=0xCA)
      const bits = registerParsers.parseBltcon0Register(0x5FCA);
      
      const ashValue = bits.find(b => b.name === 'ASH');
      const useaBit = bits.find(b => b.name === 'USEA');
      const usebBit = bits.find(b => b.name === 'USEB');
      const usecBit = bits.find(b => b.name === 'USEC');
      const usedBit = bits.find(b => b.name === 'USED');
      const channelsValue = bits.find(b => b.name === 'CHANNELS');
      const lfValue = bits.find(b => b.name === 'LF');
      
      assert.strictEqual(ashValue?.value, 5, 'ASH should be 5');
      assert.strictEqual(useaBit?.value, true, 'USEA should be true');
      assert.strictEqual(usebBit?.value, true, 'USEB should be true');
      assert.strictEqual(usecBit?.value, true, 'USEC should be true');
      assert.strictEqual(usedBit?.value, true, 'USED should be true');
      assert.strictEqual(channelsValue?.value, 15, 'CHANNELS should be 15 (all channels)');
      assert.strictEqual(lfValue?.value, 0xCA, 'LF should be 0xCA');
      assert.ok(ashValue?.description?.includes('shift'), 'Should have shift description');
    });

    test('should parse BLTCON1 register in area mode', () => {
      // Test BLTCON1 value: 0x301E (BSH=3, EFE=1, IFE=1, FCI=1, DESC=1, LINE=0)
      const bits = registerParsers.parseBltcon1Register(0x301E);
      
      const modeValue = bits.find(b => b.name === 'MODE');
      const bshValue = bits.find(b => b.name === 'BSH');
      const efeBit = bits.find(b => b.name === 'EFE');
      const ifeBit = bits.find(b => b.name === 'IFE');
      const fciBit = bits.find(b => b.name === 'FCI');
      const descBit = bits.find(b => b.name === 'DESC');
      
      assert.strictEqual(modeValue?.value, 'AREA', 'MODE should be AREA');
      assert.strictEqual(bshValue?.value, 3, 'BSH should be 3');
      assert.strictEqual(efeBit?.value, true, 'EFE should be true');
      assert.strictEqual(ifeBit?.value, true, 'IFE should be true');
      assert.strictEqual(fciBit?.value, true, 'FCI should be true');
      assert.strictEqual(descBit?.value, true, 'DESC should be true');
      assert.ok(modeValue?.description?.includes('Area'), 'Should have area description');
    });

    test('should parse BLTCON1 register in line mode', () => {
      // Test BLTCON1 value: 0xF051 (TEXTURE=F, SUD=1, SUL=0, AUL=1, LINE=1)
      const bits = registerParsers.parseBltcon1Register(0xF051);
      
      const modeValue = bits.find(b => b.name === 'MODE');
      const textureValue = bits.find(b => b.name === 'TEXTURE');
      const signBit = bits.find(b => b.name === 'SIGN');
      const sudBit = bits.find(b => b.name === 'SUD');
      const sulBit = bits.find(b => b.name === 'SUL');
      const aulBit = bits.find(b => b.name === 'AUL');
      
      assert.strictEqual(modeValue?.value, 'LINE', 'MODE should be LINE');
      assert.strictEqual(textureValue?.value, 15, 'TEXTURE should be 15');
      assert.strictEqual(signBit?.value, true, 'SIGN should be true');
      assert.strictEqual(sudBit?.value, true, 'SUD should be true');
      assert.strictEqual(sulBit?.value, false, 'SUL should be false');
      assert.strictEqual(aulBit?.value, true, 'AUL should be true');
      assert.ok(modeValue?.description?.includes('Line'), 'Should have line description');
    });

    test('should route BLTCON registers to correct parsers', () => {
      const bltcon0Bits = registerParsers.parseRegister('BLTCON0', 0x0F00);
      const bltcon1Bits = registerParsers.parseRegister('BLTCON1', 0x0000);
      
      assert.ok(bltcon0Bits.length > 0, 'BLTCON0 should return bit definitions');
      assert.ok(bltcon1Bits.length > 0, 'BLTCON1 should return bit definitions');
      
      // Verify different parsers are called by looking for specific bits
      const ashBit = bltcon0Bits.find(b => b.name === 'ASH');
      const modeBit = bltcon1Bits.find(b => b.name === 'MODE');
      
      assert.ok(ashBit, 'Should have BLTCON0-specific ASH bit');
      assert.ok(modeBit, 'Should have BLTCON1-specific MODE bit');
    });

    test('should parse VPOSR register bits correctly', () => {
      // Test VPOSR value: 0x8001 (LOF=1, CHIP_ID=0x4000, V8=1)
      const bits = registerParsers.parseVposrRegister(0x8001);
      
      const lofBit = bits.find(b => b.name === 'LOF');
      const chipIdValue = bits.find(b => b.name === 'CHIP_ID');
      const v8Bit = bits.find(b => b.name === 'V8');
      
      assert.strictEqual(lofBit?.value, true, 'LOF should be true');
      assert.strictEqual(chipIdValue?.value, 0x4000, 'CHIP_ID should be 0x4000');
      assert.strictEqual(v8Bit?.value, true, 'V8 should be true');
      assert.ok(lofBit?.description?.includes('Long frame'), 'Should indicate NTSC frame');
    });

    test('should parse VHPOSR register bits correctly', () => {
      // Test VHPOSR value: 0x5A3C (VPOS=90, HPOS=120)
      const bits = registerParsers.parseVhposrRegister(0x5A3C);
      
      const vposValue = bits.find(b => b.name === 'VPOS');
      const hposValue = bits.find(b => b.name === 'HPOS');
      const scanlineValue = bits.find(b => b.name === 'SCANLINE');
      
      assert.strictEqual(vposValue?.value, 90, 'VPOS should be 90');
      assert.strictEqual(hposValue?.value, 120, 'HPOS should be 120');
      assert.strictEqual(scanlineValue?.value, 90, 'SCANLINE should be 90');
      assert.ok(hposValue?.description?.includes('280ns'), 'Should mention resolution');
    });

    test('should parse BLTSIZE register bits correctly', () => {
      // Test BLTSIZE value: 0x0142 (HEIGHT=5, WIDTH=2)
      const bits = registerParsers.parseBltSizeRegister(0x0142);
      
      const heightValue = bits.find(b => b.name === 'HEIGHT');
      const widthValue = bits.find(b => b.name === 'WIDTH');
      const pixelsValue = bits.find(b => b.name === 'PIXELS');
      
      assert.strictEqual(heightValue?.value, 5, 'HEIGHT should be 5');
      assert.strictEqual(widthValue?.value, 2, 'WIDTH should be 2');
      assert.strictEqual(pixelsValue?.value, 10, 'PIXELS should be 10 (5*2)');
      assert.ok(heightValue?.description?.includes('lines'), 'Should have lines description');
    });

    test('should parse ADKCON register bits correctly', () => {
      // Test ADKCON value: 0xE7FF (SET=1, PRECOMP=3, all audio bits set)
      const bits = registerParsers.parseAdkconRegister(0xE7FF);
      
      const setClearBit = bits.find(b => b.name === 'SET_CLR');
      const precompValue = bits.find(b => b.name === 'PRECOMP');
      const mfmprecBit = bits.find(b => b.name === 'MFMPREC');
      const wordsyncBit = bits.find(b => b.name === 'WORDSYNC');
      const use0v1Bit = bits.find(b => b.name === 'USE0V1');
      
      assert.strictEqual(setClearBit?.value, true, 'SET_CLR should be true');
      assert.strictEqual(precompValue?.value, 3, 'PRECOMP should be 3');
      assert.strictEqual(mfmprecBit?.value, true, 'MFMPREC should be true');
      assert.strictEqual(wordsyncBit?.value, true, 'WORDSYNC should be true');
      assert.strictEqual(use0v1Bit?.value, true, 'USE0V1 should be true');
      assert.ok(precompValue?.description?.includes('560ns'), 'Should show precomp timing');
    });

    test('should parse sprite control register correctly', () => {
      // Test SPR0CTL value: 0x5086 (EV=80, ATT=1, SV8=1, EV8=1, SH0=0)
      const bits = registerParsers.parseSpriteCtlRegister(0x5086, 'SPR0CTL');
      
      const spriteValue = bits.find(b => b.name === 'SPRITE');
      const endVValue = bits.find(b => b.name === 'END_V');
      const attBit = bits.find(b => b.name === 'ATT');
      const sv8Bit = bits.find(b => b.name === 'SV8');
      const ev8Bit = bits.find(b => b.name === 'EV8');
      const sh0Bit = bits.find(b => b.name === 'SH0');
      
      assert.strictEqual(spriteValue?.value, '0', 'SPRITE should be 0');
      assert.strictEqual(endVValue?.value, 336, 'END_V should be 336 (256+80)');
      assert.strictEqual(attBit?.value, true, 'ATT should be true');
      assert.strictEqual(sv8Bit?.value, true, 'SV8 should be true');
      assert.strictEqual(ev8Bit?.value, true, 'EV8 should be true');
      assert.strictEqual(sh0Bit?.value, false, 'SH0 should be false');
      assert.ok(attBit?.description?.includes('Attached'), 'Should indicate attachment');
    });

    test('should parse sprite position register correctly', () => {
      // Test SPR3POS value: 0x4B5A (START_V=75, START_H=45)
      const bits = registerParsers.parseSpritePosRegister(0x4B5A, 'SPR3POS');
      
      const spriteValue = bits.find(b => b.name === 'SPRITE');
      const startVValue = bits.find(b => b.name === 'START_V');
      const startHValue = bits.find(b => b.name === 'START_H');
      
      assert.strictEqual(spriteValue?.value, '3', 'SPRITE should be 3');
      assert.strictEqual(startVValue?.value, 75, 'START_V should be 75');
      assert.strictEqual(startHValue?.value, 90, 'START_H should be 90 (45*2)');
      assert.ok(startVValue?.description?.includes('bit 8 from CTL'), 'Should reference CTL register');
    });
  });
});