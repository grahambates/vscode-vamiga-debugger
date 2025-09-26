import * as assert from 'assert';
import { formatHex, isNumeric, u32, u16, u8, i32, i16, i8 } from '../numbers';

/**
 * Tests for helper utility functions
 */
describe('Helper Functions', () => {
  describe('formatHex', () => {
    it('should format positive numbers with default length', () => {
      assert.strictEqual(formatHex(255), '0x000000ff');
      assert.strictEqual(formatHex(4096), '0x00001000');
    });

    it('should format with custom length', () => {
      assert.strictEqual(formatHex(255, 2), '0xff');
      assert.strictEqual(formatHex(4096, 4), '0x1000');
    });

    it('should format negative numbers', () => {
      assert.strictEqual(formatHex(-1), '-0x00000001');
      assert.strictEqual(formatHex(-255, 2), '-0xff');
    });

    it('should handle NaN', () => {
      assert.strictEqual(formatHex(NaN), 'NaN');
    });

    it('should handle zero', () => {
      assert.strictEqual(formatHex(0), '0x00000000');
      assert.strictEqual(formatHex(0, 2), '0x00');
    });
  });

  describe('isNumeric', () => {
    it('should return true for valid numbers', () => {
      assert.strictEqual(isNumeric('123'), true);
      assert.strictEqual(isNumeric('-456'), true);
      assert.strictEqual(isNumeric('0'), true);
      assert.strictEqual(isNumeric('3.14'), true);
      assert.strictEqual(isNumeric('-3.14'), true);
    });

    it('should return false for non-numeric strings', () => {
      assert.strictEqual(isNumeric('abc'), false);
      // Note: Number('') returns 0, so empty string is considered numeric by this implementation
      assert.strictEqual(isNumeric('123abc'), false);
      assert.strictEqual(isNumeric('hello'), false);
      assert.strictEqual(isNumeric('not-a-number'), false);
    });

    it('should handle edge cases', () => {
      assert.strictEqual(isNumeric('Infinity'), true);
      assert.strictEqual(isNumeric('-Infinity'), true);
      assert.strictEqual(isNumeric(' 123 '), true); // Number() trims whitespace
    });
  });

  describe('Unsigned integer conversions', () => {
    it('u32 should convert to 32-bit unsigned', () => {
      assert.strictEqual(u32(0), 0);
      assert.strictEqual(u32(0xFFFFFFFF), 0xFFFFFFFF);
      assert.strictEqual(u32(-1), 0xFFFFFFFF);
      assert.strictEqual(u32(0x100000000), 0); // Overflow
    });

    it('u16 should convert to 16-bit unsigned', () => {
      assert.strictEqual(u16(0), 0);
      assert.strictEqual(u16(0xFFFF), 0xFFFF);
      assert.strictEqual(u16(-1), 0xFFFF);
      assert.strictEqual(u16(0x10000), 0); // Overflow
      assert.strictEqual(u16(-256), 0xFF00); // Multiple wraps
    });

    it('u8 should convert to 8-bit unsigned', () => {
      assert.strictEqual(u8(0), 0);
      assert.strictEqual(u8(255), 255);
      assert.strictEqual(u8(-1), 255);
      assert.strictEqual(u8(256), 0); // Overflow
      assert.strictEqual(u8(-256), 0); // Multiple wraps
    });
  });

  describe('Signed integer conversions', () => {
    it('i32 should convert to 32-bit signed', () => {
      assert.strictEqual(i32(0), 0);
      assert.strictEqual(i32(0x7FFFFFFF), 0x7FFFFFFF);
      assert.strictEqual(i32(0x80000000), -0x80000000);
      assert.strictEqual(i32(0xFFFFFFFF), -1);
    });

    it('i16 should convert to 16-bit signed', () => {
      assert.strictEqual(i16(0), 0);
      assert.strictEqual(i16(0x7FFF), 0x7FFF);
      assert.strictEqual(i16(0x8000), -0x8000);
      assert.strictEqual(i16(0xFFFF), -1);
    });

    it('i8 should convert to 8-bit signed', () => {
      assert.strictEqual(i8(0), 0);
      assert.strictEqual(i8(127), 127);
      assert.strictEqual(i8(128), -128);
      assert.strictEqual(i8(255), -1);
    });
  });

  describe('Round-trip conversions', () => {
    it('u32/i32 round trip', () => {
      const testValues = [0, 1, -1, 0x7FFFFFFF, -0x80000000, 0x12345678];
      for (const val of testValues) {
        assert.strictEqual(i32(u32(val)), i32(val));
      }
    });

    it('u16/i16 round trip', () => {
      const testValues = [0, 1, -1, 0x7FFF, -0x8000, 0x1234];
      for (const val of testValues) {
        assert.strictEqual(i16(u16(val)), i16(val));
      }
    });

    it('u8/i8 round trip', () => {
      const testValues = [0, 1, -1, 127, -128, 0x42];
      for (const val of testValues) {
        assert.strictEqual(i8(u8(val)), i8(val));
      }
    });
  });
});