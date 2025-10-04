/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import * as sinon from "sinon";
import { DisassemblyManager } from "../disassemblyManager";
import { VAmiga } from "../vAmiga";
import { Source } from "@vscode/debugadapter";

/**
 * Comprehensive tests for DisassemblyManager
 * Tests disassembly functionality with various offset scenarios and source map integration
 */
describe("DisassemblyManager - Comprehensive Tests", () => {
  let disassemblyManager: DisassemblyManager;
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

    disassemblyManager = new DisassemblyManager(mockVAmiga, mockSourceMap);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("Basic Disassembly", () => {
    it("should disassemble instructions at base address", async () => {
      // Setup: Mock disassembly result
      const mockDisasmResult = {
        instructions: [
          { addr: "1000", instruction: "move.l d0,d1", hex: "2200" },
          { addr: "1002", instruction: "add.l #4,d0", hex: "D080" },
          { addr: "1006", instruction: "jsr sub1", hex: "4e80" },
        ],
      };
      mockVAmiga.disassemble.resolves(mockDisasmResult);

      // Test: Disassemble 2 instructions at base address
      const result = await disassemblyManager.disassemble(0x1000, 0, 2);

      // Verify: Correct instructions returned
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].address, "0x1000");
      assert.strictEqual(result[0].instruction, "move.l d0,d1");
      assert.strictEqual(result[0].instructionBytes, "2200");
      assert.strictEqual(result[1].address, "0x1002");
      assert.strictEqual(result[1].instruction, "add.l #4,d0");
    });

    it("should handle invalid instructions with presentation hint", async () => {
      // Setup: Mock with invalid instructions
      const mockDisasmResult = {
        instructions: [
          { addr: "1000", instruction: "move.l d0,d1", hex: "2200" },
          { addr: "1002", instruction: "dc.w $0000", hex: "0000" },
          { addr: "1004", instruction: "invalid", hex: "0000 0000" },
        ],
      };
      mockVAmiga.disassemble.resolves(mockDisasmResult);

      // Test: Disassemble instructions
      const result = await disassemblyManager.disassemble(0x1000, 0, 3);

      // Verify: Invalid instructions marked
      assert.strictEqual(result[0].presentationHint, undefined); // Valid instruction
      assert.strictEqual(result[1].presentationHint, "invalid"); // dc.w directive
      assert.strictEqual(result[2].presentationHint, "invalid"); // 0000 0000 pattern
    });

    it("should throw error when no instructions returned", async () => {
      // Setup: Mock empty result
      mockVAmiga.disassemble.resolves({ instructions: [] });

      // Test & Verify: Should throw error for empty instructions
      await assert.rejects(
        () => disassemblyManager.disassemble(0x1000, 0, 1),
        /Disassembly failed: Start instruction not found/,
      );
    });

    it("should throw error when start instruction not found", async () => {
      // Setup: Mock result without requested base address
      const mockDisasmResult = {
        instructions: [
          { addr: "2000", instruction: "move.l d0,d1", hex: "2200" },
          { addr: "2002", instruction: "add.l #4,d0", hex: "D080" },
        ],
      };
      mockVAmiga.disassemble.resolves(mockDisasmResult);

      // Test & Verify: Should throw error when base address not found
      await assert.rejects(
        () => disassemblyManager.disassemble(0x1000, 0, 1),
        /Disassembly failed: Start instruction not found/,
      );
    });
  });

  describe("Positive Instruction Offset", () => {
    it("should handle positive instruction offset", async () => {
      // Setup: Mock with multiple instructions
      const mockDisasmResult = {
        instructions: [
          { addr: "1000", instruction: "move.l d0,d1", hex: "2200" },
          { addr: "1002", instruction: "add.l #4,d0", hex: "D080" },
          { addr: "1006", instruction: "jsr sub1", hex: "4e80" },
          { addr: "100a", instruction: "rts", hex: "4e75" },
        ],
      };
      mockVAmiga.disassemble.resolves(mockDisasmResult);

      // Test: Start 2 instructions after base address
      const result = await disassemblyManager.disassemble(0x1000, 2, 2);

      // Verify: Returns instructions starting from offset
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].address, "0x1006"); // 2 instructions after base
      assert.strictEqual(result[0].instruction, "jsr sub1");
      assert.strictEqual(result[1].address, "0x100a");
      assert.strictEqual(result[1].instruction, "rts");

      // Verify: Requested more instructions to accommodate offset
      assert.ok(mockVAmiga.disassemble.calledWith(0x1000, 4)); // count (2) + offset (2)
    });
  });

  describe("Negative Instruction Offset", () => {
    it("should handle negative instruction offset", async () => {
      // Setup: Mock with instructions before and after base address
      const mockDisasmResult = {
        instructions: [
          { addr: "ff0", instruction: "push.l a0", hex: "2f08" },
          { addr: "ff2", instruction: "move.l d1,d0", hex: "2001" },
          { addr: "ff4", instruction: "bsr.w sub2", hex: "6100" },
          { addr: "ff8", instruction: "move.l d0,d1", hex: "2200" }, // This should be our base (0xff8 = 4088)
          { addr: "ffa", instruction: "add.l #4,d0", hex: "D080" },
          { addr: "ffe", instruction: "jsr sub1", hex: "4e80" },
        ],
      };
      mockVAmiga.disassemble.resolves(mockDisasmResult);

      // Test: Start 2 instructions before base address (0xff8 = 4088)
      const result = await disassemblyManager.disassemble(4088, -2, 2);

      // Verify: Returns instructions starting from negative offset
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].address, "0xff2"); // 2 instructions before base
      assert.strictEqual(result[0].instruction, "move.l d1,d0");
      assert.strictEqual(result[1].address, "0xff4"); // 1 instruction before base
      assert.strictEqual(result[1].instruction, "bsr.w sub2");
    });

    it("should pad with invalid instructions when negative offset exceeds available", async () => {
      // Setup: Mock with limited instructions before base
      const mockDisasmResult = {
        instructions: [
          { addr: "ffc", instruction: "move.l d1,d0", hex: "2001" },
          { addr: "1000", instruction: "move.l d0,d1", hex: "2200" }, // Base address
          { addr: "1002", instruction: "add.l #4,d0", hex: "D080" },
        ],
      };
      mockVAmiga.disassemble.resolves(mockDisasmResult);

      // Test: Request 3 instructions before base, but only 1 available
      const result = await disassemblyManager.disassemble(0x1000, -3, 3);

      // Verify: The algorithm adds padding + requested instructions
      // With offset -3 and count 3: it needs 2 padding + 1 available + 2 more = 5 total
      assert.strictEqual(result.length, 5);

      // First two should be padding because we asked for 3 instructions back
      // from 0x1000 but only had 1 before it (at 0xffc)
      assert.strictEqual(result[0].address, "0x00000000");
      assert.strictEqual(result[0].instruction, "invalid");
      assert.strictEqual(result[0].instructionBytes, "0000 0000");
      assert.strictEqual(result[1].address, "0x00000000");
      assert.strictEqual(result[1].instruction, "invalid");

      // Third should be the actual instruction available before base
      assert.strictEqual(result[2].address, "0xffc");
      assert.strictEqual(result[2].instruction, "move.l d1,d0");
    });

    it("should clamp start address to zero for large negative offsets", async () => {
      // Setup: Mock disassembly from address 0
      const mockDisasmResult = {
        instructions: [
          { addr: "0", instruction: "reset", hex: "4e70" },
          { addr: "2", instruction: "nop", hex: "4e71" },
          { addr: "4", instruction: "move.l d0,d1", hex: "2200" }, // Our base is at 0x4
        ],
      };
      mockVAmiga.disassemble.resolves(mockDisasmResult);

      // Test: Large negative offset that would cause negative address
      const result = await disassemblyManager.disassemble(0x4, -10, 1);

      // Verify: Start address was clamped and padded
      assert.ok(mockVAmiga.disassemble.calledWith(0, sinon.match.number)); // Start from 0

      // The algorithm will add padding for the negative offset that can't be satisfied,
      // then add the requested instruction count, so we get more than just 1
      assert.ok(result.length >= 1);

      // The result should include padding since we can't go back 10 instructions from 0x4
      const paddingCount = result.filter(
        (r) => r.instruction === "invalid",
      ).length;
      assert.ok(paddingCount > 0);
    });
  });

  describe("Source Map Integration", () => {
    it("should add source information when available", async () => {
      // Setup: Mock disassembly and source map
      const mockDisasmResult = {
        instructions: [
          { addr: "1000", instruction: "move.l d0,d1", hex: "2200" },
          { addr: "1002", instruction: "add.l #4,d0", hex: "D080" },
        ],
      };
      mockVAmiga.disassemble.resolves(mockDisasmResult);

      // Mock source map lookup
      mockSourceMap.lookupAddress.withArgs(0x1000).returns({
        path: "/project/src/main.c",
        line: 42,
      });
      mockSourceMap.lookupAddress.withArgs(0x1002).returns({
        path: "/project/src/main.c",
        line: 43,
      });

      // Test: Disassemble with source info
      const result = await disassemblyManager.disassemble(0x1000, 0, 2);

      // Verify: Source information added
      assert.strictEqual(result.length, 2);

      // First instruction
      assert.strictEqual(result[0].symbol, "main.c:42");
      assert.ok(result[0].location instanceof Source);
      assert.strictEqual(result[0].location!.name, "main.c");
      assert.strictEqual(result[0].location!.path, "/project/src/main.c");
      assert.strictEqual(result[0].line, 42);

      // Second instruction
      assert.strictEqual(result[1].symbol, "main.c:43");
      assert.strictEqual(result[1].line, 43);
    });

    it("should handle missing source information gracefully", async () => {
      // Setup: Mock disassembly
      const mockDisasmResult = {
        instructions: [
          { addr: "1000", instruction: "move.l d0,d1", hex: "2200" },
          { addr: "1002", instruction: "add.l #4,d0", hex: "D080" },
        ],
      };
      mockVAmiga.disassemble.resolves(mockDisasmResult);

      // Mock source map returns null (no debug info)
      mockSourceMap.lookupAddress.returns(null);

      // Test: Disassemble without source info
      const result = await disassemblyManager.disassemble(0x1000, 0, 2);

      // Verify: No source information added
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].symbol, undefined);
      assert.strictEqual(result[0].location, undefined);
      assert.strictEqual(result[0].line, undefined);
      assert.strictEqual(result[1].symbol, undefined);
      assert.strictEqual(result[1].location, undefined);
      assert.strictEqual(result[1].line, undefined);
    });

    it("should work without source map", async () => {
      // Setup: Create DisassemblyManager without source map
      const disasmManagerNoSrc = new DisassemblyManager(
        mockVAmiga,
        null as any,
      );

      const mockDisasmResult = {
        instructions: [
          { addr: "1000", instruction: "move.l d0,d1", hex: "2200" },
        ],
      };
      mockVAmiga.disassemble.resolves(mockDisasmResult);

      // Test: Disassemble without source map
      const result = await disasmManagerNoSrc.disassemble(0x1000, 0, 1);

      // Verify: Works without source information
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].address, "0x1000");
      assert.strictEqual(result[0].instruction, "move.l d0,d1");
      assert.strictEqual(result[0].symbol, undefined);
      assert.strictEqual(result[0].location, undefined);
      assert.strictEqual(result[0].line, undefined);
    });
  });

  describe("Address Handling", () => {
    it("should correctly parse hex addresses", async () => {
      // Setup: Mock with various address formats
      const mockDisasmResult = {
        instructions: [
          { addr: "abcd", instruction: "move.l d0,d1", hex: "2200" },
          { addr: "ABCD", instruction: "add.l #4,d0", hex: "D080" },
          { addr: "10000", instruction: "jsr sub1", hex: "4e80" },
        ],
      };
      mockVAmiga.disassemble.resolves(mockDisasmResult);

      // Test: Disassemble at hex address
      const result = await disassemblyManager.disassemble(0xabcd, 0, 3);

      // Verify: Addresses formatted correctly
      assert.strictEqual(result[0].address, "0xabcd");
      assert.strictEqual(result[1].address, "0xABCD");
      assert.strictEqual(result[2].address, "0x10000");

      // Verify: Source map called with parsed addresses
      assert.ok(mockSourceMap.lookupAddress.calledWith(0xabcd));
      assert.ok(mockSourceMap.lookupAddress.calledWith(0xabcd));
      assert.ok(mockSourceMap.lookupAddress.calledWith(0x10000));
    });

    it("should handle edge case addresses", async () => {
      // Setup: Mock with edge case addresses
      const mockDisasmResult = {
        instructions: [
          { addr: "0", instruction: "reset", hex: "4e70" },
          { addr: "ffffff", instruction: "illegal", hex: "4afc" },
        ],
      };
      mockVAmiga.disassemble.resolves(mockDisasmResult);

      // Test: Disassemble at address 0
      const result = await disassemblyManager.disassemble(0x0, 0, 2);

      // Verify: Handles zero and max addresses
      assert.strictEqual(result[0].address, "0x0");
      assert.strictEqual(result[1].address, "0xffffff");
    });
  });

  describe("Complex Scenarios", () => {
    it("should handle mixed valid/invalid instructions with offsets", async () => {
      // Setup: Mock with mix of valid and invalid instructions
      const mockDisasmResult = {
        instructions: [
          { addr: "ffe", instruction: "move.l d1,d0", hex: "2001" },
          { addr: "1000", instruction: "dc.w $0000", hex: "0000" }, // Base - invalid
          { addr: "1002", instruction: "move.l d0,d1", hex: "2200" },
          { addr: "1004", instruction: "invalid", hex: "0000 0000" },
        ],
      };
      mockVAmiga.disassemble.resolves(mockDisasmResult);

      // Test: Disassemble with negative offset including invalid instruction
      const result = await disassemblyManager.disassemble(0x1000, -1, 3);

      // Verify: Correctly handles invalid instructions
      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0].instruction, "move.l d1,d0");
      assert.strictEqual(result[0].presentationHint, undefined); // Valid

      assert.strictEqual(result[1].instruction, "dc.w $0000");
      assert.strictEqual(result[1].presentationHint, "invalid"); // dc. directive

      assert.strictEqual(result[2].instruction, "move.l d0,d1");
      assert.strictEqual(result[2].presentationHint, undefined); // Valid
    });

    it("should calculate instruction counts correctly for negative offsets", async () => {
      // Setup: Mock to verify calculation
      const mockDisasmResult = {
        instructions: [
          { addr: "1000", instruction: "move.l d0,d1", hex: "2200" },
        ],
      };
      mockVAmiga.disassemble.resolves(mockDisasmResult);

      // Test: Large negative offset
      await disassemblyManager.disassemble(0x1000, -5, 1);

      // Verify: Called with calculated parameters based on the algorithm
      // The algorithm calls with specific calculations - let's check what it actually called
      const call = mockVAmiga.disassemble.getCall(0);
      assert.ok(call, "disassemble should have been called");

      // The start address should be adjusted for negative offset
      const startAddress = call.args[0];
      const requestCount = call.args[1];

      // startAddress should be less than 0x1000 due to negative offset
      assert.ok(
        startAddress < 0x1000,
        `Start address ${startAddress.toString(16)} should be less than 0x1000`,
      );

      // requestCount should be greater than 1 due to negative offset compensation
      assert.ok(
        requestCount > 1,
        `Request count ${requestCount} should be greater than 1`,
      );
    });
  });

  describe("Error Handling", () => {
    it("should handle vAmiga disassemble errors", async () => {
      // Setup: Mock vAmiga to throw error
      mockVAmiga.disassemble.rejects(new Error("Memory access error"));

      // Test & Verify: Should propagate vAmiga errors
      await assert.rejects(
        () => disassemblyManager.disassemble(0x1000, 0, 1),
        /Memory access error/,
      );
    });

    it("should handle unusual instruction data", async () => {
      // Setup: Mock with unusual but valid data
      const mockDisasmResult = {
        instructions: [
          { addr: "1000", instruction: "", hex: "0000" }, // Empty instruction
          { addr: "1002", instruction: "???", hex: "FFFF" }, // Unknown instruction
          { addr: "1004", instruction: "add.l #4,d0", hex: "D080" }, // Normal
        ],
      };
      mockVAmiga.disassemble.resolves(mockDisasmResult);

      // Test: Should handle unusual data without crashing
      const result = await disassemblyManager.disassemble(0x1000, 0, 3);

      // Verify: Handles unusual data gracefully
      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0].address, "0x1000");
      assert.strictEqual(result[0].instruction, "");
      assert.strictEqual(result[1].instruction, "???");
      assert.strictEqual(result[2].instruction, "add.l #4,d0");
    });
  });
});
