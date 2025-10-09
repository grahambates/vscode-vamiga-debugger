/**
 * Copper instruction disassembler for Amiga
 *
 * The Copper is a coprocessor that manipulates custom chip registers in sync with the video beam.
 * All Copper instructions are exactly 2 words (4 bytes) long.
 */

export interface CopperInstruction {
  address: number;
  word1: number;
  word2: number;
  mnemonic: string;
  operands: string;
  comment?: string;
}

/**
 * Disassemble a single Copper instruction from two words
 */
export function disassembleCopperInstruction(
  address: number,
  word1: number,
  word2: number
): CopperInstruction {
  const base: CopperInstruction = {
    address,
    word1,
    word2,
    mnemonic: '',
    operands: '',
  };

  // Check if it's a MOVE instruction (bit 0 of first word = 0)
  if ((word1 & 0x0001) === 0) {
    // MOVE instruction: Move word2 to register at word1[15:1]
    const regAddr = word1 & 0x01FE; // Bits 8:1 (register address)
    const value = word2;

    base.mnemonic = 'MOVE';
    base.operands = `#$${value.toString(16).toUpperCase().padStart(4, '0')}, $${regAddr.toString(16).toUpperCase().padStart(3, '0')}`;
    base.comment = getRegisterName(regAddr);

    return base;
  }

  // WAIT or SKIP instruction (bit 0 = 1)
  const isSkip = (word2 & 0x0001) === 1;

  if (isSkip) {
    // SKIP instruction
    const vp = (word1 >> 8) & 0xFF; // Vertical position
    const hp = word1 & 0xFE;        // Horizontal position
    const veMask = (word2 >> 8) & 0x7F; // Vertical enable mask
    const heMask = word2 & 0xFE;        // Horizontal enable mask
    const bfd = (word2 >> 15) & 0x01;   // Blitter finished disable

    base.mnemonic = 'SKIP';
    base.operands = `${vp}, ${hp}`;

    if (veMask !== 0x7F || heMask !== 0xFE) {
      base.comment = `VE=$${veMask.toString(16).toUpperCase()}, HE=$${heMask.toString(16).toUpperCase()}`;
    }
    if (bfd) {
      base.comment = (base.comment ? base.comment + ', ' : '') + 'BFD';
    }

    return base;
  }

  // WAIT instruction
  const vp = (word1 >> 8) & 0xFF; // Vertical position
  const hp = word1 & 0xFE;        // Horizontal position
  const veMask = (word2 >> 8) & 0x7F; // Vertical enable mask
  const heMask = word2 & 0xFE;        // Horizontal enable mask
  const bfd = (word2 >> 15) & 0x01;   // Blitter finished disable

  // Check for common wait patterns
  if (vp === 0xFF && hp === 0xFE && veMask === 0x7F && heMask === 0xFE) {
    base.mnemonic = 'WAIT';
    base.operands = 'end';
    base.comment = 'Wait for impossible position (end of copperlist)';
    return base;
  }

  base.mnemonic = 'WAIT';
  base.operands = `${vp}, ${hp}`;

  if (veMask !== 0x7F || heMask !== 0xFE) {
    base.comment = `VE=$${veMask.toString(16).toUpperCase()}, HE=$${heMask.toString(16).toUpperCase()}`;
  }
  if (bfd) {
    base.comment = (base.comment ? base.comment + ', ' : '') + 'BFD';
  }

  return base;
}

/**
 * Get human-readable register name from custom chip register address
 */
function getRegisterName(addr: number): string {
  const registers: Record<number, string> = {
    0x02: 'DMACONR',
    0x04: 'VPOSR',
    0x06: 'VHPOSR',
    0x08: 'DSKDATR',
    0x0A: 'JOY0DAT',
    0x0C: 'JOY1DAT',
    0x0E: 'CLXDAT',
    0x10: 'ADKCONR',
    0x12: 'POT0DAT',
    0x14: 'POT1DAT',
    0x16: 'POTGOR',
    0x18: 'SERDATR',
    0x1A: 'DSKBYTR',
    0x1C: 'INTENAR',
    0x1E: 'INTREQR',
    0x20: 'DSKPTH',
    0x22: 'DSKPTL',
    0x24: 'DSKLEN',
    0x26: 'DSKDAT',
    0x28: 'REFPTR',
    0x2A: 'VPOSW',
    0x2C: 'VHPOSW',
    0x2E: 'COPCON',
    0x30: 'SERDAT',
    0x32: 'SERPER',
    0x34: 'POTGO',
    0x36: 'JOYTEST',
    0x38: 'STREQU',
    0x3A: 'STRVBL',
    0x3C: 'STRHOR',
    0x3E: 'STRLONG',
    0x40: 'BLTCON0',
    0x42: 'BLTCON1',
    0x44: 'BLTAFWM',
    0x46: 'BLTALWM',
    0x48: 'BLTCPTH',
    0x4A: 'BLTCPTL',
    0x4C: 'BLTBPTH',
    0x4E: 'BLTBPTL',
    0x50: 'BLTAPTH',
    0x52: 'BLTAPTL',
    0x54: 'BLTDPTH',
    0x56: 'BLTDPTL',
    0x58: 'BLTSIZE',
    0x5A: 'BLTCON0L',
    0x5C: 'BLTSIZV',
    0x5E: 'BLTSIZH',
    0x60: 'BLTCMOD',
    0x62: 'BLTBMOD',
    0x64: 'BLTAMOD',
    0x66: 'BLTDMOD',
    0x70: 'BLTCDAT',
    0x72: 'BLTBDAT',
    0x74: 'BLTADAT',
    0x76: 'SPRHDAT',
    0x78: 'BPLHDAT',
    0x7A: 'LISAID',
    0x7C: 'DSKSYNC',
    0x7E: 'COP1LCH',
    0x80: 'COP1LCL',
    0x82: 'COP2LCH',
    0x84: 'COP2LCL',
    0x86: 'COPJMP1',
    0x88: 'COPJMP2',
    0x8A: 'COPINS',
    0x8C: 'DIWSTRT',
    0x8E: 'DIWSTOP',
    0x90: 'DDFSTRT',
    0x92: 'DDFSTOP',
    0x94: 'DMACON',
    0x96: 'CLXCON',
    0x98: 'INTENA',
    0x9A: 'INTREQ',
    0x9C: 'ADKCON',
    0xA0: 'AUD0LCH',
    0xA2: 'AUD0LCL',
    0xA4: 'AUD0LEN',
    0xA6: 'AUD0PER',
    0xA8: 'AUD0VOL',
    0xAA: 'AUD0DAT',
    0xB0: 'AUD1LCH',
    0xB2: 'AUD1LCL',
    0xB4: 'AUD1LEN',
    0xB6: 'AUD1PER',
    0xB8: 'AUD1VOL',
    0xBA: 'AUD1DAT',
    0xC0: 'AUD2LCH',
    0xC2: 'AUD2LCL',
    0xC4: 'AUD2LEN',
    0xC6: 'AUD2PER',
    0xC8: 'AUD2VOL',
    0xCA: 'AUD2DAT',
    0xD0: 'AUD3LCH',
    0xD2: 'AUD3LCL',
    0xD4: 'AUD3LEN',
    0xD6: 'AUD3PER',
    0xD8: 'AUD3VOL',
    0xDA: 'AUD3DAT',
    0xE0: 'BPL1PTH',
    0xE2: 'BPL1PTL',
    0xE4: 'BPL2PTH',
    0xE6: 'BPL2PTL',
    0xE8: 'BPL3PTH',
    0xEA: 'BPL3PTL',
    0xEC: 'BPL4PTH',
    0xEE: 'BPL4PTL',
    0xF0: 'BPL5PTH',
    0xF2: 'BPL5PTL',
    0xF4: 'BPL6PTH',
    0xF6: 'BPL6PTL',
    0xF8: 'BPL7PTH',
    0xFA: 'BPL7PTL',
    0xFC: 'BPL8PTH',
    0xFE: 'BPL8PTL',
    0x100: 'BPLCON0',
    0x102: 'BPLCON1',
    0x104: 'BPLCON2',
    0x106: 'BPLCON3',
    0x108: 'BPL1MOD',
    0x10A: 'BPL2MOD',
    0x10C: 'BPLCON4',
    0x10E: 'CLXCON2',
    0x110: 'BPL1DAT',
    0x112: 'BPL2DAT',
    0x114: 'BPL3DAT',
    0x116: 'BPL4DAT',
    0x118: 'BPL5DAT',
    0x11A: 'BPL6DAT',
    0x11C: 'BPL7DAT',
    0x11E: 'BPL8DAT',
    0x120: 'SPR0PTH',
    0x122: 'SPR0PTL',
    0x124: 'SPR1PTH',
    0x126: 'SPR1PTL',
    0x128: 'SPR2PTH',
    0x12A: 'SPR2PTL',
    0x12C: 'SPR3PTH',
    0x12E: 'SPR3PTL',
    0x130: 'SPR4PTH',
    0x132: 'SPR4PTL',
    0x134: 'SPR5PTH',
    0x136: 'SPR5PTL',
    0x138: 'SPR6PTH',
    0x13A: 'SPR6PTL',
    0x13C: 'SPR7PTH',
    0x13E: 'SPR7PTL',
    0x180: 'COLOR00',
    0x182: 'COLOR01',
    0x184: 'COLOR02',
    0x186: 'COLOR03',
    0x188: 'COLOR04',
    0x18A: 'COLOR05',
    0x18C: 'COLOR06',
    0x18E: 'COLOR07',
    0x190: 'COLOR08',
    0x192: 'COLOR09',
    0x194: 'COLOR10',
    0x196: 'COLOR11',
    0x198: 'COLOR12',
    0x19A: 'COLOR13',
    0x19C: 'COLOR14',
    0x19E: 'COLOR15',
    0x1A0: 'COLOR16',
    0x1A2: 'COLOR17',
    0x1A4: 'COLOR18',
    0x1A6: 'COLOR19',
    0x1A8: 'COLOR20',
    0x1AA: 'COLOR21',
    0x1AC: 'COLOR22',
    0x1AE: 'COLOR23',
    0x1B0: 'COLOR24',
    0x1B2: 'COLOR25',
    0x1B4: 'COLOR26',
    0x1B6: 'COLOR27',
    0x1B8: 'COLOR28',
    0x1BA: 'COLOR29',
    0x1BC: 'COLOR30',
    0x1BE: 'COLOR31',
  };

  return registers[addr] || `CUSTOM+$${addr.toString(16).toUpperCase()}`;
}
