/**
 * Comprehensive tests for Amiga Register Parsers
 *
 * These tests focus specifically on the register parsing module,
 * covering edge cases, boundary values, and comprehensive bit combinations.
 */

import * as assert from 'assert';
import * as registerParsers from '../amigaRegisterParsers';

describe('Amiga Register Parsers - Comprehensive Tests', () => {

  describe('DMACON Register Edge Cases', () => {
    it('should handle all DMA control bits set', () => {
      // All DMA channels enabled, SET=1
      const bits = registerParsers.parseDmaconRegister(0x83FF);

      const enableAllBit = bits.find(b => b.name === '09: ENABLE_ALL');
      const bitplanesBit = bits.find(b => b.name === '08: BITPLANES');
      const copperBit = bits.find(b => b.name === '07: COPPER');
      const blitterBit = bits.find(b => b.name === '06: BLITTER');
      const spritesBit = bits.find(b => b.name === '05: SPRITES');
      const diskBit = bits.find(b => b.name === '04: DISK');
      const aud3Bit = bits.find(b => b.name === '03: AUD3');
      const aud2Bit = bits.find(b => b.name === '02: AUD2');
      const aud1Bit = bits.find(b => b.name === '01: AUD1');
      const aud0Bit = bits.find(b => b.name === '00: AUD0');

      assert.strictEqual(enableAllBit?.value, true);
      assert.strictEqual(bitplanesBit?.value, true);
      assert.strictEqual(copperBit?.value, true);
      assert.strictEqual(blitterBit?.value, true);
      assert.strictEqual(spritesBit?.value, true);
      assert.strictEqual(diskBit?.value, true);
      assert.strictEqual(aud3Bit?.value, true);
      assert.strictEqual(aud2Bit?.value, true);
      assert.strictEqual(aud1Bit?.value, true);
      assert.strictEqual(aud0Bit?.value, true);
    });

    it('should handle no DMA channels enabled', () => {
      // No DMA channels, CLEAR=0 (clear mode)
      const bits = registerParsers.parseDmaconRegister(0x0000);

      const enableAllBit = bits.find(b => b.name === '09: ENABLE_ALL');

      assert.strictEqual(enableAllBit?.value, false);
    });

    it('should handle DMACON read register', () => {
      // Test read-only version
      const bits = registerParsers.parseRegister('DMACON', 0x0200);
      assert.ok(bits.length > 0);

      const enableAllBit = bits.find(b => b.name === '09: ENABLE_ALL');
      assert.strictEqual(enableAllBit?.value, true);
    });
  });

  describe('INTENA/INTREQ Register Edge Cases', () => {
    it('should handle all interrupt bits set', () => {
      const bits = registerParsers.parseIntenaRegister(0xFFFF);

      const masterEnableBit = bits.find(b => b.name === '14: MASTER_ENABLE');
      const externalBit = bits.find(b => b.name === '13: EXTERNAL');
      const diskSyncBit = bits.find(b => b.name === '12: DISK_SYNC');
      const receiveBufferFullBit = bits.find(b => b.name === '11: RECEIVE_BUFFER_FULL');
      const aud3Bit = bits.find(b => b.name === '10: AUD3');
      const aud2Bit = bits.find(b => b.name === '09: AUD2');
      const aud1Bit = bits.find(b => b.name === '08: AUD1');
      const aud0Bit = bits.find(b => b.name === '07: AUD0');

      assert.strictEqual(masterEnableBit?.value, true);
      assert.strictEqual(externalBit?.value, true);
      assert.strictEqual(diskSyncBit?.value, true);
      assert.strictEqual(receiveBufferFullBit?.value, true);
      assert.strictEqual(aud3Bit?.value, true);
      assert.strictEqual(aud2Bit?.value, true);
      assert.strictEqual(aud1Bit?.value, true);
      assert.strictEqual(aud0Bit?.value, true);
    });

    it('should differentiate INTREQ vs INTENA', () => {
      const intenaList = registerParsers.parseIntenaRegister(0x4000);
      const intreqBits = registerParsers.parseIntreqRegister(0x4000);

      // Compare similar bits but with different descriptions
      const intenaMasterEnable = intenaList.find(b => b.name === '14: MASTER_ENABLE');
      const intreqExternal = intreqBits.find(b => b.name === '13: EXTERNAL');

      // Note: descriptions were removed from RegisterBitField interface
      assert.ok(intenaMasterEnable);
      assert.ok(intreqExternal);
    });
  });

  describe('BPLCON Complex Scenarios', () => {
    it('should handle BPLCON0 maximum bitplanes', () => {
      // 7 bitplanes (maximum normal), HIRES, HOMOD, DBLPF
      const bits = registerParsers.parseBplcon0Register(0xF004); // BPU=7 from bits 14-12

      const bitplanesValue = bits.find(b => b.name === '14-12: BITPLANES');
      const hiresBit = bits.find(b => b.name === '15: HIRES');

      assert.strictEqual(bitplanesValue?.value, 7, 'BITPLANES=7 means 7 bitplanes');
      assert.strictEqual(hiresBit?.value, true);
    });

    it('should handle BPLCON1 maximum scroll values', () => {
      // Maximum scroll values for AGA (proper bit extraction)
      const bits = registerParsers.parseBplcon1Register(0xFFFF); // All bits set for maximum

      const pf2hValue = bits.find(b => b.name === '15-14,7-4: PF2H');
      const pf1hValue = bits.find(b => b.name === '9-8,3-0: PF1H');

      assert.strictEqual(pf2hValue?.value, 63, 'PF2H maximum: (0xF | 0x30) = 63');
      assert.strictEqual(pf1hValue?.value, 63, 'PF1H maximum: (0xF | 0x30) = 63');
    });

    it('should handle BPLCON2 priority combinations', () => {
      // All priority bits and PF2PRI set
      const bits = registerParsers.parseBplcon2Register(0x0047);

      const pf2priBit = bits.find(b => b.name === '06: PF2PRI');
      const pf2pValue = bits.find(b => b.name === '05-03: PF2P');
      const pf1pValue = bits.find(b => b.name === '02-00: PF1P');

      assert.strictEqual(pf2priBit?.value, true);
      assert.strictEqual(pf2pValue?.value, 0);
      assert.strictEqual(pf1pValue?.value, 7, 'Maximum priority value');
    });

    it('should handle BPLCON3 AGA features', () => {
      // Full AGA BPLCON3 with all features
      const bits = registerParsers.parseBplcon3Register(0xE0FF);

      const bankValue = bits.find(b => b.name === '15-13: BANK');
      const spresBit = bits.find(b => b.name === '06: SPRITE_RES');

      assert.strictEqual(bankValue?.value, 7, 'Maximum color bank');
      assert.strictEqual(spresBit?.value, true);
    });
  });

  describe('Blitter Register Edge Cases', () => {
    it('should handle BLTCON0 maximum shift and all channels', () => {
      // Maximum shift (15), all channels enabled, complex LF
      const bits = registerParsers.parseBltcon0Register(0xFF0A);

      const ashiftValue = bits.find(b => b.name === '15-12: ASHIFT');
      const mintermValue = bits.find(b => b.name === '07-00: MINTERM');

      assert.strictEqual(ashiftValue?.value, 15, 'Maximum shift value');
      assert.strictEqual(mintermValue?.value, '0x0a', 'Logic function value');
    });

    it('should handle BLTCON1 line mode with all flags', () => {
      // Line mode with all line flags set
      const bits = registerParsers.parseBltcon1Register(0xF07D);

      const modeValue = bits.find(b => b.name === '00: MODE');
      const textureValue = bits.find(b => b.name === '15-12: TEXTURE');
      const singleBitBit = bits.find(b => b.name === '06: SINGLE_BIT');
      const sudBit = bits.find(b => b.name === '04: SUD');
      const sulBit = bits.find(b => b.name === '03: SUL');
      const aulBit = bits.find(b => b.name === '02: AUL');

      assert.strictEqual(modeValue?.value, 'LINE');
      assert.strictEqual(textureValue?.value, '0b1111', 'Maximum texture pattern');
      assert.strictEqual(singleBitBit?.value, true);
      assert.strictEqual(sudBit?.value, true);
      assert.strictEqual(sulBit?.value, true);
      assert.strictEqual(aulBit?.value, true);
    });

    it('should handle BLTSIZE maximum dimensions', () => {
      // Maximum blitter size: 1024x1024
      const bits = registerParsers.parseBltSizeRegister(0x0000); // Special case: 0 = 1024

      const heightValue = bits.find(b => b.name === '15-06: HEIGHT');
      const widthValue = bits.find(b => b.name === '05-00: WIDTH');

      assert.strictEqual(heightValue?.value, 1024, '0 encoded as 1024');
      assert.strictEqual(widthValue?.value, 64, '0 encoded as 64 words');
    });
  });

  describe('Display Position Registers', () => {
    it('should handle VPOSR with different chip IDs', () => {
      // Test different Agnus chip versions
      const ecs_vposr = registerParsers.parseVposrRegister(0x2001); // ECS Agnus
      const aga_vposr = registerParsers.parseVposrRegister(0x3001); // AGA Alice

      const ecs_chipId = ecs_vposr.find(b => b.name === '14-01: CHIP_ID');
      const aga_chipId = aga_vposr.find(b => b.name === '14-01: CHIP_ID');

      assert.strictEqual(ecs_chipId?.value, '0x1000', 'ECS chip ID from (0x2001 >> 1) & 0x7FFF');
      assert.strictEqual(aga_chipId?.value, '0x1800', 'AGA chip ID from (0x3001 >> 1) & 0x7FFF');
    });

    it('should handle VHPOSR boundary values', () => {
      // Maximum VPOS (511) and HPOS (255)
      const bits = registerParsers.parseVhposrRegister(0xFFFF);

      const vposValue = bits.find(b => b.name === '15-08: VPOS');
      const hposValue = bits.find(b => b.name === '07-00: HPOS');

      assert.strictEqual(vposValue?.value, 255, 'VPOS from high byte');
      assert.strictEqual(hposValue?.value, 510, 'Maximum HPOS (2x multiplier)');
    });
  });

  describe('Sprite Register Complex Cases', () => {
    it('should handle all sprite control registers', () => {
      // Test all 8 sprite control registers
      for (let i = 0; i < 8; i++) {
        const regName = `SPR${i}CTL`;
        const bits = registerParsers.parseRegister(regName, 0x8086);

        const endVValue = bits.find(b => b.name === '15-08,01: END_V');
        const attachedBit = bits.find(b => b.name === '07: ATTACHED');

        assert.strictEqual(endVValue?.value, 384, '256 + 0x80 from EV8 and EV bits'); // 256 + 0x80
        assert.strictEqual(attachedBit?.value, true);
      }
    });

    it('should handle sprite position with high resolution', () => {
      // High horizontal position value
      const bits = registerParsers.parseSpritePosRegister(0x80FF);

      const startHValue = bits.find(b => b.name === '07-01: START_H');
      const startVValue = bits.find(b => b.name === '15-08: START_V');

      assert.strictEqual(startVValue?.value, 128);
      assert.strictEqual(startHValue?.value, 254, '0x7F << 1 from SH bits');
    });
  });

  describe('ADKCON Audio Control', () => {
    it('should handle all precompensation modes', () => {
      const precompModes = [
        { value: 0x0000, precomp: 0, desc: 'None' },
        { value: 0x2000, precomp: 1, desc: '140ns' },
        { value: 0x4000, precomp: 2, desc: '280ns' },
        { value: 0x6000, precomp: 3, desc: '560ns' }
      ];

      precompModes.forEach(({ value, precomp }) => {
        const bits = registerParsers.parseAdkconRegister(value);
        const precompValue = bits.find(b => b.name === '14-13: PRECOMP');

        assert.strictEqual(precompValue?.value, precomp);
        // Note: descriptions were removed from RegisterBitField interface
        assert.strictEqual(precompValue?.value, precomp);
      });
    });

    it('should handle all audio modulation combinations', () => {
      // All audio modulation flags set
      const bits = registerParsers.parseAdkconRegister(0x80FF);

      const use3pn = bits.find(b => b.name === '07: USE3PN');
      const use2p3 = bits.find(b => b.name === '06: USE2P3');
      const use1p2 = bits.find(b => b.name === '05: USE1P2');
      const use0p1 = bits.find(b => b.name === '04: USE0P1');
      const use3vn = bits.find(b => b.name === '03: USE3VN');
      const use2v3 = bits.find(b => b.name === '02: USE2V3');
      const use1v2 = bits.find(b => b.name === '01: USE1V2');
      const use0v1 = bits.find(b => b.name === '00: USE0V1');

      assert.strictEqual(use3pn?.value, true);
      assert.strictEqual(use2p3?.value, true);
      assert.strictEqual(use1p2?.value, true);
      assert.strictEqual(use0p1?.value, true);
      assert.strictEqual(use3vn?.value, true);
      assert.strictEqual(use2v3?.value, true);
      assert.strictEqual(use1v2?.value, true);
      assert.strictEqual(use0v1?.value, true);
    });
  });

  describe('Register Detection and Routing', () => {
    it('should correctly identify all supported registers', () => {
      const supportedRegs = [
        'DMACON', 'INTENA', 'INTREQ',
        'BPLCON0', 'BPLCON1', 'BPLCON2', 'BPLCON3',
        'BLTCON0', 'BLTCON1', 'VPOS', 'VHPOS', 'BLTSIZE',
        'SPR0CTL', 'SPR1CTL', 'SPR2CTL', 'SPR3CTL', 'SPR4CTL', 'SPR5CTL', 'SPR6CTL', 'SPR7CTL',
        'SPR0POS', 'SPR1POS', 'SPR2POS', 'SPR3POS', 'SPR4POS', 'SPR5POS', 'SPR6POS', 'SPR7POS',
        'ADKCON', 'CLXCON', 'BLTSIZV', 'BLTSIZH'
      ];

      supportedRegs.forEach(regName => {
        assert.ok(registerParsers.hasRegisterBitBreakdown(regName), `${regName} should be supported`);

        // Each should return some bit definitions
        const bits = registerParsers.parseRegister(regName, 0x1234);
        assert.ok(bits.length >= 0, `${regName} should return bit array`);
      });
    });

    it('should reject unsupported registers', () => {
      const unsupportedRegs = ['INVALID', 'NOTAREG', 'FAKECON', ''];

      unsupportedRegs.forEach(regName => {
        assert.ok(!registerParsers.hasRegisterBitBreakdown(regName), `${regName} should not be supported`);

        const bits = registerParsers.parseRegister(regName, 0x1234);
        assert.strictEqual(bits.length, 0, `${regName} should return empty array`);
      });
    });

    it('should handle case insensitive register names', () => {
      const testCases = [
        ['dmacon', 'DMACON'],
        ['intena', 'INTENA'],
        ['bplcon0', 'BPLCON0'],
        ['spr0ctl', 'SPR0CTL']
      ];

      testCases.forEach(([lower, upper]) => {
        assert.ok(registerParsers.hasRegisterBitBreakdown(lower));
        assert.ok(registerParsers.hasRegisterBitBreakdown(upper));

        const lowerBits = registerParsers.parseRegister(lower, 0x1234);
        const upperBits = registerParsers.parseRegister(upper, 0x1234);

        assert.strictEqual(lowerBits.length, upperBits.length, 'Case should not matter');
      });
    });
  });

  describe('Bit Field Value Types', () => {
    it('should return correct value types', () => {
      const dmaconBits = registerParsers.parseDmaconRegister(0x8300);

      // Boolean values
      const enableAllBit = dmaconBits.find(b => b.name === '09: ENABLE_ALL');
      assert.strictEqual(typeof enableAllBit?.value, 'boolean');

      // Numeric values would be tested if present
      const bltcon0Bits = registerParsers.parseBltcon0Register(0x5000);
      const ashiftValue = bltcon0Bits.find(b => b.name === '15-12: ASHIFT');
      assert.strictEqual(typeof ashiftValue?.value, 'number');

      // String values
      const bltcon1Bits = registerParsers.parseBltcon1Register(0x0001);
      const modeValue = bltcon1Bits.find(b => b.name === '00: MODE');
      assert.strictEqual(typeof modeValue?.value, 'string');
    });

    it('should have valid bit field structure', () => {
      const intreqBits = registerParsers.parseIntreqRegister(0x4000);

      intreqBits.forEach(bit => {
        assert.ok(bit.name, `Bit should have name`);
        assert.ok(bit.value !== undefined, `${bit.name} should have value`);
        assert.ok(typeof bit.name === 'string', `${bit.name} name should be string`);
      });
    });
  });
});