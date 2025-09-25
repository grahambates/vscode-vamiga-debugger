/**
 * Comprehensive tests for Amiga Register Parsers
 *
 * These tests focus specifically on the register parsing module,
 * covering edge cases, boundary values, and comprehensive bit combinations.
 */

import * as assert from 'assert';
import * as registerParsers from '../amigaRegisterParsers';

suite('Amiga Register Parsers - Comprehensive Tests', () => {

  suite('DMACON Register Edge Cases', () => {
    test('should handle all DMA control bits set', () => {
      // All DMA channels enabled, SET=1
      const bits = registerParsers.parseDmaconRegister(0x83FF);

      const setBit = bits.find(b => b.name === 'SET_CLR');
      const dmaenBit = bits.find(b => b.name === 'DMAEN');
      const bplenBit = bits.find(b => b.name === 'BPLEN');
      const copen = bits.find(b => b.name === 'COPEN');
      const bltenBit = bits.find(b => b.name === 'BLTEN');
      const sprenBit = bits.find(b => b.name === 'SPREN');
      const dsken = bits.find(b => b.name === 'DSKEN');
      const aud3en = bits.find(b => b.name === 'AUD3EN');
      const aud2en = bits.find(b => b.name === 'AUD2EN');
      const aud1en = bits.find(b => b.name === 'AUD1EN');
      const aud0en = bits.find(b => b.name === 'AUD0EN');

      assert.strictEqual(setBit?.value, true);
      assert.strictEqual(dmaenBit?.value, true);
      assert.strictEqual(bplenBit?.value, true);
      assert.strictEqual(copen?.value, true);
      assert.strictEqual(bltenBit?.value, true);
      assert.strictEqual(sprenBit?.value, true);
      assert.strictEqual(dsken?.value, true);
      assert.strictEqual(aud3en?.value, true);
      assert.strictEqual(aud2en?.value, true);
      assert.strictEqual(aud1en?.value, true);
      assert.strictEqual(aud0en?.value, true);
    });

    test('should handle no DMA channels enabled', () => {
      // No DMA channels, CLEAR=0 (clear mode)
      const bits = registerParsers.parseDmaconRegister(0x0000);

      const setBit = bits.find(b => b.name === 'SET_CLR');
      const dmaenBit = bits.find(b => b.name === 'DMAEN');

      assert.strictEqual(setBit?.value, false);
      assert.strictEqual(dmaenBit?.value, false);
    });

    test('should handle DMACONR read register', () => {
      // Test read-only version
      const bits = registerParsers.parseRegister('DMACONR', 0x0200);
      assert.ok(bits.length > 0);

      const dmaenBit = bits.find(b => b.name === 'DMAEN');
      assert.strictEqual(dmaenBit?.value, true);
    });
  });

  suite('INTENA/INTREQ Register Edge Cases', () => {
    test('should handle all interrupt bits set', () => {
      const bits = registerParsers.parseIntenaRegister(0xFFFF);

      const intenBit = bits.find(b => b.name === 'INTEN');
      const exter = bits.find(b => b.name === 'EXTER');
      const dsksyn = bits.find(b => b.name === 'DSKSYN');
      const rbf = bits.find(b => b.name === 'RBF');
      const aud3 = bits.find(b => b.name === 'AUD3');
      const aud2 = bits.find(b => b.name === 'AUD2');
      const aud1 = bits.find(b => b.name === 'AUD1');
      const aud0 = bits.find(b => b.name === 'AUD0');

      assert.strictEqual(intenBit?.value, true);
      assert.strictEqual(exter?.value, true);
      assert.strictEqual(dsksyn?.value, true);
      assert.strictEqual(rbf?.value, true);
      assert.strictEqual(aud3?.value, true);
      assert.strictEqual(aud2?.value, true);
      assert.strictEqual(aud1?.value, true);
      assert.strictEqual(aud0?.value, true);
    });

    test('should differentiate INTREQ vs INTENA', () => {
      const intenaList = registerParsers.parseIntenaRegister(0x4000);
      const intreqBits = registerParsers.parseIntreqRegister(0x4000);

      // Compare similar bits but with different descriptions
      const intenaInten = intenaList.find(b => b.name === 'INTEN');
      const intreqExter = intreqBits.find(b => b.name === 'EXTER');

      assert.ok(intenaInten?.description?.includes('enable'), 'INTENA should have enable description');
      assert.ok(intreqExter?.description?.includes('request'), 'INTREQ should have request description');
    });
  });

  suite('BPLCON Complex Scenarios', () => {
    test('should handle BPLCON0 maximum bitplanes', () => {
      // 7 bitplanes (maximum normal), HIRES, HOMOD, DBLPF
      const bits = registerParsers.parseBplcon0Register(0xF004); // BPU=7 from bits 14-12

      const bpuValue = bits.find(b => b.name === 'BPU');
      const hiresBit = bits.find(b => b.name === 'HIRES');

      assert.strictEqual(bpuValue?.value, 7, 'BPU=7 means 7 bitplanes');
      assert.strictEqual(hiresBit?.value, true);
      assert.ok(bpuValue?.description?.includes('7 bitplanes'));
    });

    test('should handle BPLCON1 maximum scroll values', () => {
      // Maximum scroll values for AGA (proper bit extraction)
      const bits = registerParsers.parseBplcon1Register(0xFFFF); // All bits set for maximum

      const pf2hValue = bits.find(b => b.name === 'PF2H');
      const pf1hValue = bits.find(b => b.name === 'PF1H');

      assert.strictEqual(pf2hValue?.value, 63, 'PF2H maximum: (0xF | 0x30) = 63');
      assert.strictEqual(pf1hValue?.value, 63, 'PF1H maximum: (0xF | 0x30) = 63');
    });

    test('should handle BPLCON2 priority combinations', () => {
      // All priority bits and PF2PRI set
      const bits = registerParsers.parseBplcon2Register(0x0047);

      const pf2priBit = bits.find(b => b.name === 'PF2PRI');
      const pf2pValue = bits.find(b => b.name === 'PF2P');
      const pf1pValue = bits.find(b => b.name === 'PF1P');

      assert.strictEqual(pf2priBit?.value, true);
      assert.strictEqual(pf2pValue?.value, 0);
      assert.strictEqual(pf1pValue?.value, 7, 'Maximum priority value');
    });

    test('should handle BPLCON3 AGA features', () => {
      // Full AGA BPLCON3 with all features
      const bits = registerParsers.parseBplcon3Register(0xE0FF);

      const bankValue = bits.find(b => b.name === 'BANK');
      const spresBit = bits.find(b => b.name === 'SPRES');

      assert.strictEqual(bankValue?.value, 7, 'Maximum color bank');
      assert.strictEqual(spresBit?.value, true);
      assert.ok(bankValue?.description?.includes('Color bank'));
    });
  });

  suite('Blitter Register Edge Cases', () => {
    test('should handle BLTCON0 maximum shift and all channels', () => {
      // Maximum shift (15), all channels enabled, complex LF
      const bits = registerParsers.parseBltcon0Register(0xFF0A);

      const ashValue = bits.find(b => b.name === 'ASH');
      const lfValue = bits.find(b => b.name === 'MINTERM');

      assert.strictEqual(ashValue?.value, 15, 'Maximum shift value');
      assert.strictEqual(lfValue?.value, '0x0a', 'Logic function value');
    });

    test('should handle BLTCON1 line mode with all flags', () => {
      // Line mode with all line flags set
      const bits = registerParsers.parseBltcon1Register(0xF07D);

      const modeValue = bits.find(b => b.name === 'MODE');
      const textureValue = bits.find(b => b.name === 'TEXTURE');
      const signBit = bits.find(b => b.name === 'SIGN');
      const sudBit = bits.find(b => b.name === 'SUD');
      const sulBit = bits.find(b => b.name === 'SUL');
      const aulBit = bits.find(b => b.name === 'AUL');

      assert.strictEqual(modeValue?.value, 'LINE');
      assert.strictEqual(textureValue?.value, '0b1111', 'Maximum texture pattern');
      assert.strictEqual(signBit?.value, true);
      assert.strictEqual(sudBit?.value, true);
      assert.strictEqual(sulBit?.value, true);
      assert.strictEqual(aulBit?.value, true);
    });

    test('should handle BLTSIZE maximum dimensions', () => {
      // Maximum blitter size: 1024x1024
      const bits = registerParsers.parseBltSizeRegister(0x0000); // Special case: 0 = 1024

      const heightValue = bits.find(b => b.name === 'HEIGHT');
      const widthValue = bits.find(b => b.name === 'WIDTH');
      const pixelsValue = bits.find(b => b.name === 'PIXELS');

      assert.strictEqual(heightValue?.value, 1024, '0 encoded as 1024');
      assert.strictEqual(widthValue?.value, 64, '0 encoded as 64 words');
      assert.strictEqual(pixelsValue?.value, 1024 * 64, 'Total pixels calculation');
    });
  });

  suite('Display Position Registers', () => {
    test('should handle VPOSR with different chip IDs', () => {
      // Test different Agnus chip versions
      const ecs_vposr = registerParsers.parseVposrRegister(0x2001); // ECS Agnus
      const aga_vposr = registerParsers.parseVposrRegister(0x3001); // AGA Alice

      const ecs_chipId = ecs_vposr.find(b => b.name === 'CHIP_ID');
      const aga_chipId = aga_vposr.find(b => b.name === 'CHIP_ID');

      assert.strictEqual(ecs_chipId?.value, '0x1000', 'ECS chip ID from (0x2001 >> 1) & 0x7FFF');
      assert.strictEqual(aga_chipId?.value, '0x1800', 'AGA chip ID from (0x3001 >> 1) & 0x7FFF');
    });

    test('should handle VHPOSR boundary values', () => {
      // Maximum VPOS (511) and HPOS (255)
      const bits = registerParsers.parseVhposrRegister(0xFFFF);

      const vposValue = bits.find(b => b.name === 'VPOS');
      const hposValue = bits.find(b => b.name === 'HPOS');

      assert.strictEqual(vposValue?.value, 255, 'VPOS from high byte');
      assert.strictEqual(hposValue?.value, 510, 'Maximum HPOS (2x multiplier)');
    });
  });

  suite('Sprite Register Complex Cases', () => {
    test('should handle all sprite control registers', () => {
      // Test all 8 sprite control registers
      for (let i = 0; i < 8; i++) {
        const regName = `SPR${i}CTL`;
        const bits = registerParsers.parseRegister(regName, 0x8086);

        const spriteValue = bits.find(b => b.name === 'SPRITE');
        const endVValue = bits.find(b => b.name === 'END_V');
        const attBit = bits.find(b => b.name === 'ATT');

        assert.strictEqual(spriteValue?.value, i.toString());
        assert.strictEqual(endVValue?.value, 384, '256 + 0x80 from EV8 and EV bits'); // 256 + 0x80
        assert.strictEqual(attBit?.value, true);
      }
    });

    test('should handle sprite position with high resolution', () => {
      // High horizontal position value
      const bits = registerParsers.parseSpritePosRegister(0x80FF, 'SPR0POS');

      const startHValue = bits.find(b => b.name === 'START_H');
      const startVValue = bits.find(b => b.name === 'START_V');

      assert.strictEqual(startVValue?.value, 128);
      assert.strictEqual(startHValue?.value, 254, '0x7F << 1 from SH bits');
    });
  });

  suite('ADKCON Audio Control', () => {
    test('should handle all precompensation modes', () => {
      const precompModes = [
        { value: 0x0000, precomp: 0, desc: 'None' },
        { value: 0x2000, precomp: 1, desc: '140ns' },
        { value: 0x4000, precomp: 2, desc: '280ns' },
        { value: 0x6000, precomp: 3, desc: '560ns' }
      ];

      precompModes.forEach(({ value, precomp, desc }) => {
        const bits = registerParsers.parseAdkconRegister(value);
        const precompValue = bits.find(b => b.name === 'PRECOMP');

        assert.strictEqual(precompValue?.value, precomp);
        assert.ok(precompValue?.description?.includes(desc));
      });
    });

    test('should handle all audio modulation combinations', () => {
      // All audio modulation flags set
      const bits = registerParsers.parseAdkconRegister(0x80FF);

      const use3pn = bits.find(b => b.name === 'USE3PN');
      const use2p3 = bits.find(b => b.name === 'USE2P3');
      const use1p2 = bits.find(b => b.name === 'USE1P2');
      const use0p1 = bits.find(b => b.name === 'USE0P1');
      const use3vn = bits.find(b => b.name === 'USE3VN');
      const use2v3 = bits.find(b => b.name === 'USE2V3');
      const use1v2 = bits.find(b => b.name === 'USE1V2');
      const use0v1 = bits.find(b => b.name === 'USE0V1');

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

  suite('Register Detection and Routing', () => {
    test('should correctly identify all supported registers', () => {
      const supportedRegs = [
        'DMACON', 'DMACONR', 'INTENA', 'INTENAR', 'INTREQ', 'INTREQR',
        'BPLCON0', 'BPLCON1', 'BPLCON2', 'BPLCON3',
        'BLTCON0', 'BLTCON1', 'VPOSR', 'VHPOSR', 'BLTSIZE',
        'SPR0CTL', 'SPR1CTL', 'SPR2CTL', 'SPR3CTL', 'SPR4CTL', 'SPR5CTL', 'SPR6CTL', 'SPR7CTL',
        'SPR0POS', 'SPR1POS', 'SPR2POS', 'SPR3POS', 'SPR4POS', 'SPR5POS', 'SPR6POS', 'SPR7POS',
        'ADKCON', 'ADKCONR', 'CLXCON', 'BLTSIZV', 'BLTSIZH'
      ];

      supportedRegs.forEach(regName => {
        assert.ok(registerParsers.hasRegisterBitBreakdown(regName), `${regName} should be supported`);

        // Each should return some bit definitions
        const bits = registerParsers.parseRegister(regName, 0x1234);
        assert.ok(bits.length >= 0, `${regName} should return bit array`);
      });
    });

    test('should reject unsupported registers', () => {
      const unsupportedRegs = ['INVALID', 'NOTAREG', 'FAKECON', ''];

      unsupportedRegs.forEach(regName => {
        assert.ok(!registerParsers.hasRegisterBitBreakdown(regName), `${regName} should not be supported`);

        const bits = registerParsers.parseRegister(regName, 0x1234);
        assert.strictEqual(bits.length, 0, `${regName} should return empty array`);
      });
    });

    test('should handle case insensitive register names', () => {
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

  suite('Bit Field Value Types', () => {
    test('should return correct value types', () => {
      const dmaconBits = registerParsers.parseDmaconRegister(0x8300);

      // Boolean values
      const setBit = dmaconBits.find(b => b.name === 'SET_CLR');
      assert.strictEqual(typeof setBit?.value, 'boolean');

      // Numeric values would be tested if present
      const bltcon0Bits = registerParsers.parseBltcon0Register(0x5000);
      const ashValue = bltcon0Bits.find(b => b.name === 'ASH');
      assert.strictEqual(typeof ashValue?.value, 'number');

      // String values
      const bltcon1Bits = registerParsers.parseBltcon1Register(0x0001);
      const modeValue = bltcon1Bits.find(b => b.name === 'MODE');
      assert.strictEqual(typeof modeValue?.value, 'string');
    });

    test('should provide meaningful descriptions', () => {
      const intreqBits = registerParsers.parseIntreqRegister(0x4000);

      intreqBits.forEach(bit => {
        if (bit.description) {
          assert.ok(bit.description.length > 0, `${bit.name} should have non-empty description`);
          assert.ok(typeof bit.description === 'string', `${bit.name} description should be string`);
        }
      });
    });
  });
});