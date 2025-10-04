/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import * as sinon from "sinon";
import { StackManager } from "../stackManager";
import { VAmiga, CpuInfo } from "../vAmiga";

// Helper function to create mock CPU info with required properties
function createMockCpuInfo(overrides: Partial<CpuInfo> = {}): CpuInfo {
  return {
    pc: "0x00001000",
    d0: "0x00000000",
    d1: "0x00000000",
    d2: "0x00000000",
    d3: "0x00000000",
    d4: "0x00000000",
    d5: "0x00000000",
    d6: "0x00000000",
    d7: "0x00000000",
    a0: "0x00000000",
    a1: "0x00000000",
    a2: "0x00000000",
    a3: "0x00000000",
    a4: "0x00000000",
    a5: "0x00000000",
    a6: "0x00000000",
    a7: "0x00008000",
    sr: "0x00000000",
    usp: "0x00000000",
    isp: "0x00000000",
    msp: "0x00000000",
    vbr: "0x00000000",
    irc: "0x00000000",
    sfc: "0x00000000",
    dfc: "0x00000000",
    cacr: "0x00000000",
    caar: "0x00000000",
    ...overrides,
  };
}

/**
 * Comprehensive tests for StackManager
 * Tests the stack frame analysis and DAP integration
 */
describe("StackManager - Comprehensive Tests", () => {
  let stackManager: StackManager;
  let mockVAmiga: sinon.SinonStubbedInstance<VAmiga>;
  let mockSourceMap: any;

  beforeEach(() => {
    mockVAmiga = sinon.createStubInstance(VAmiga);
    mockSourceMap = {
      lookupAddress: sinon.stub(),
      getSymbols: () => ({ main: 0x1000, sub1: 0x2000 }),
      getSegmentsInfo: () => [],
      getSymbolLengths: () => ({}),
      lookupSourceLine: sinon.stub(),
      findSymbolOffset: sinon.stub(),
    };

    stackManager = new StackManager(mockVAmiga, mockSourceMap);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("Stack Frame Generation", () => {
    it("should return current PC as first stack frame", async () => {
      // Setup: Mock CPU state and empty stack
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      mockVAmiga.readMemory.resolves(Buffer.alloc(128));
      mockVAmiga.isValidAddress.returns(false); // No valid return addresses in stack

      // Test: Get stack frames
      const frames = await stackManager.getStackFrames(0, 5);

      // Verify: Current PC is included as first frame
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].instructionPointerReference, "0x00001000");
    });

    it("should create source-based frames when debug info available", async () => {
      // Setup: Mock CPU state, stack, and source map
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      mockVAmiga.readMemory.resolves(Buffer.alloc(128));

      // Mock source location lookup
      mockSourceMap.lookupAddress.withArgs(0x1000).returns({
        path: "/src/main.asm",
        line: 42,
      });

      // Mock symbol offset lookup for formatAddress
      mockSourceMap.findSymbolOffset.withArgs(0x1000).returns({
        symbol: "main",
        offset: 0,
      });

      // Test: Get stack frames
      const frames = await stackManager.getStackFrames(0, 1);

      // Verify: Frame has source information
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].name, "0x00001000 = main");
      assert.strictEqual(frames[0].source?.path, "/src/main.asm");
      assert.strictEqual(frames[0].line, 42);
      assert.strictEqual(frames[0].instructionPointerReference, "0x00001000");
    });

    it("should create disassembly frames when no debug info available", async () => {
      // Setup: Mock CPU state with no source mapping
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      mockVAmiga.readMemory.resolves(Buffer.alloc(128));

      // No source location found
      mockSourceMap.lookupAddress.returns(null);

      // Test: Get stack frames
      const frames = await stackManager.getStackFrames(0, 1);

      // Verify: Frame is disassembly-only
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].name, "0x00001000");
      assert.strictEqual(frames[0].source, undefined);
      assert.strictEqual(frames[0].line, 0); // StackFrame constructor defaults to 0
      assert.strictEqual(frames[0].instructionPointerReference, "0x00001000");
    });

    it("should stop at ROM calls after finding user code", async () => {
      // Setup: Mock stack analysis that finds ROM address after user code
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);

      // Mock guessStack to return user code then ROM
      sinon.stub(stackManager, "guessStack").resolves([
        [0x1000, 0x1000], // User code PC
        [0x2000, 0x2000], // User code
        [0xe80000, 0xe80000], // ROM code - should stop here
      ]);

      // Mock source lookup - first two have source, third is ROM
      mockSourceMap.lookupAddress
        .withArgs(0x1000)
        .returns({ path: "/src/main.asm", line: 10 });
      mockSourceMap.lookupAddress
        .withArgs(0x2000)
        .returns({ path: "/src/sub.c", line: 20 });
      mockSourceMap.lookupAddress.withArgs(0xe80000).returns(null);

      // Test: Get all stack frames
      const frames = await stackManager.getStackFrames(0, 10);

      // Verify: Stops after user code, doesn't include ROM frame
      assert.strictEqual(frames.length, 2);
      assert.strictEqual(frames[1].instructionPointerReference, "0x00002000");
    });

    it("should handle pagination with startFrame and maxLevels", async () => {
      // Setup: Mock multiple stack frames
      sinon.stub(stackManager, "guessStack").resolves([
        [0x1000, 0x1000], // Frame 0
        [0x2000, 0x2000], // Frame 1
        [0x3000, 0x3000], // Frame 2
        [0x4000, 0x4000], // Frame 3
        [0x5000, 0x5000], // Frame 4
      ]);

      mockSourceMap.lookupAddress.returns(null); // All disassembly frames

      // Test: Get frames 1-2 (skip first, take 2)
      const frames = await stackManager.getStackFrames(1, 2);

      // Verify: Returns correct slice of frames
      assert.strictEqual(frames.length, 2);
      assert.strictEqual(frames[0].instructionPointerReference, "0x00002000");
      assert.strictEqual(frames[1].instructionPointerReference, "0x00003000");
    });
  });

  describe("Stack Analysis Algorithm", () => {
    it("should include current PC as first frame", async () => {
      // Setup: Mock CPU state
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);
      mockVAmiga.readMemory.resolves(Buffer.alloc(128));
      mockVAmiga.isValidAddress.returns(false);

      // Test: Analyze stack
      const addresses = await stackManager.guessStack(5);

      // Verify: Current PC is first entry
      assert.strictEqual(addresses.length, 1);
      assert.deepStrictEqual(addresses[0], [0x1000, 0x1000]);
    });

    it("should detect JSR return addresses in stack memory", async () => {
      // Setup: Mock CPU and stack containing return address
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);

      // Create stack buffer with return address at offset 0
      const stackBuffer = Buffer.alloc(128);
      stackBuffer.writeInt32BE(0x2000, 0); // Return address to 0x2000
      mockVAmiga.readMemory.withArgs(0x8000, 128).resolves(stackBuffer);

      // Mock valid address check
      mockVAmiga.isValidAddress.withArgs(0x2000).returns(true);

      // Mock instruction bytes showing JSR at 0x2000-2
      const instrBuffer = Buffer.alloc(6);
      instrBuffer.writeUInt16BE(0x4e80, 4); // JSR instruction at offset 4 (0x2000-2)
      mockVAmiga.readMemory.withArgs(0x2000 - 6, 6).resolves(instrBuffer);

      // Test: Analyze stack
      const addresses = await stackManager.guessStack(5);

      // Verify: Finds JSR call site and return address
      assert.strictEqual(addresses.length, 2);
      assert.deepStrictEqual(addresses[0], [0x1000, 0x1000]); // Current PC
      assert.deepStrictEqual(addresses[1], [0x2000 - 2, 0x2000]); // JSR call site -> return
    });

    it("should detect BSR return addresses in stack memory", async () => {
      // Setup: Mock CPU and stack containing BSR return
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);

      const stackBuffer = Buffer.alloc(128);
      stackBuffer.writeInt32BE(0x2004, 0); // Return address after BSR
      mockVAmiga.readMemory.withArgs(0x8000, 128).resolves(stackBuffer);

      mockVAmiga.isValidAddress.withArgs(0x2004).returns(true);

      // Mock BSR instruction bytes
      const instrBuffer = Buffer.alloc(6);
      instrBuffer.writeUInt16BE(0x6100, 2); // BSR instruction at offset 2
      mockVAmiga.readMemory.withArgs(0x2004 - 6, 6).resolves(instrBuffer);

      // Test: Analyze stack
      const addresses = await stackManager.guessStack(5);

      // Verify: Finds BSR call site
      assert.strictEqual(addresses.length, 2);
      assert.deepStrictEqual(addresses[1], [0x2004 - 4, 0x2004]); // BSR call site
    });

    it("should skip invalid addresses and odd addresses", async () => {
      // Setup: Mock CPU and stack with invalid data
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);

      const stackBuffer = Buffer.alloc(128);
      stackBuffer.writeInt32BE(0x1001, 0); // Odd address - should skip
      stackBuffer.writeInt32BE(0x2000, 4); // Valid even address
      stackBuffer.writeUInt32BE(0xffffffff, 8); // Invalid address (use unsigned)
      mockVAmiga.readMemory.withArgs(0x8000, 128).resolves(stackBuffer);

      // Mock address validation
      mockVAmiga.isValidAddress.withArgs(0x1001).returns(false); // Odd
      mockVAmiga.isValidAddress.withArgs(0x2000).returns(true); // Valid
      mockVAmiga.isValidAddress.withArgs(0xffffffff).returns(false); // Invalid

      // Mock JSR for valid address
      const instrBuffer = Buffer.alloc(6);
      instrBuffer.writeUInt16BE(0x4e80, 4);
      mockVAmiga.readMemory.withArgs(0x2000 - 6, 6).resolves(instrBuffer);

      // Test: Analyze stack
      const addresses = await stackManager.guessStack(5);

      // Verify: Only processes valid even addresses
      assert.strictEqual(addresses.length, 2);
      assert.deepStrictEqual(addresses[1], [0x2000 - 2, 0x2000]);
    });

    it("should handle memory read errors gracefully", async () => {
      // Setup: Mock CPU state
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);

      const stackBuffer = Buffer.alloc(128);
      stackBuffer.writeInt32BE(0x2000, 0);
      mockVAmiga.readMemory.withArgs(0x8000, 128).resolves(stackBuffer);

      mockVAmiga.isValidAddress.withArgs(0x2000).returns(true);

      // Mock memory read failure when checking for JSR/BSR
      mockVAmiga.readMemory
        .withArgs(0x2000 - 6, 6)
        .rejects(new Error("Invalid memory"));

      // Test: Analyze stack (should not throw)
      const addresses = await stackManager.guessStack(5);

      // Verify: Gracefully handles error, returns at least current PC
      assert.strictEqual(addresses.length, 1);
      assert.deepStrictEqual(addresses[0], [0x1000, 0x1000]);
    });

    it("should respect maxLength parameter", async () => {
      // Setup: Mock stack with many potential return addresses
      const mockCpuInfo = createMockCpuInfo({ pc: "0x1000", a7: "0x8000" });
      mockVAmiga.getCpuInfo.resolves(mockCpuInfo);

      const stackBuffer = Buffer.alloc(128);
      // Fill with many valid return addresses
      for (let i = 0; i < 20; i++) {
        stackBuffer.writeInt32BE(0x2000 + i * 4, i * 4);
      }
      mockVAmiga.readMemory.withArgs(0x8000, 128).resolves(stackBuffer);

      // Mock all as valid with JSR instructions
      mockVAmiga.isValidAddress.returns(true);
      const instrBuffer = Buffer.alloc(6);
      instrBuffer.writeUInt16BE(0x4e80, 4); // JSR instruction at position 4

      // Mock instruction reads for each potential return address
      for (let i = 0; i < 20; i++) {
        const retAddr = 0x2000 + i * 4;
        mockVAmiga.readMemory.withArgs(retAddr - 6, 6).resolves(instrBuffer);
      }

      // Test: Limit to 3 frames
      const addresses = await stackManager.guessStack(3);

      // Verify: Respects limit (1 current + 2 from stack = 3)
      assert.strictEqual(addresses.length, 3);
    });
  });

  describe("Integration with Source Maps", () => {
    it("should use source map for frame naming when available", async () => {
      // Setup: Mock with source mapping
      sinon.stub(stackManager, "guessStack").resolves([[0x1000, 0x1000]]);

      mockSourceMap.lookupAddress.withArgs(0x1000).returns({
        path: "/project/src/main.asm",
        line: 25,
      });

      // Mock symbol offset lookup for formatAddress
      mockSourceMap.findSymbolOffset.withArgs(0x1000).returns({
        symbol: "main",
        offset: 0,
      });

      // Test: Get frames
      const frames = await stackManager.getStackFrames(0, 1);

      // Verify: Uses source map for naming and location
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].name, "0x00001000 = main");
      assert.strictEqual(frames[0].source?.name, "main.asm");
      assert.strictEqual(frames[0].source?.path, "/project/src/main.asm");
      assert.strictEqual(frames[0].line, 25);
    });

    it("should fall back to disassembly frames when source map has no info", async () => {
      // Setup: SourceMap exists but returns no location for address
      sinon.stub(stackManager, "guessStack").resolves([[0x1000, 0x1000]]);

      // Mock source map returns null (no debug info for this address)
      mockSourceMap.lookupAddress.withArgs(0x1000).returns(null);

      // Test: Get frames when source map has no info for address
      const frames = await stackManager.getStackFrames(0, 1);

      // Verify: Falls back to disassembly frame
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].name, "0x00001000");
      assert.strictEqual(frames[0].source, undefined);
      assert.strictEqual(frames[0].line, 0); // StackFrame constructor defaults to 0
      assert.strictEqual(frames[0].instructionPointerReference, "0x00001000");
    });
  });
});
