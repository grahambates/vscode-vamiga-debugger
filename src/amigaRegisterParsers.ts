/**
 * Amiga Hardware Register Bit Parsers
 *
 * This module contains parsers for various Amiga custom chip registers,
 * breaking down their bit fields into meaningful components with descriptions.
 *
 * Each parser function takes a register value and returns an array of named
 * bit fields with their values and human-readable descriptions.
 */

export interface RegisterBitField {
  name: string;
  value: boolean | number | string;
  description?: string;
}

/**
 * Registry of supported registers for bit breakdown display
 */
export const SUPPORTED_REGISTERS = [
  'DMACON', 'DMACONR',
  'INTENA', 'INTENAR', 'INTR', 'INTREQ', 'INTREQR',
  'BPLCON0', 'BPLCON1', 'BPLCON2', 'BPLCON3',
  'BLTCON0', 'BLTCON1',
  'VPOSR', 'VHPOSR', 'BLTSIZE', 'BLTSIZV', 'BLTSIZH', 'CLXCON',
  'SPR0CTL', 'SPR1CTL', 'SPR2CTL', 'SPR3CTL', 'SPR4CTL', 'SPR5CTL', 'SPR6CTL', 'SPR7CTL',
  'SPR0POS', 'SPR1POS', 'SPR2POS', 'SPR3POS', 'SPR4POS', 'SPR5POS', 'SPR6POS', 'SPR7POS',
  'ADKCON', 'ADKCONR'
] as const;

/**
 * Checks if a register supports bit breakdown display
 */
export function hasRegisterBitBreakdown(regName: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return SUPPORTED_REGISTERS.includes(regName.toUpperCase() as any);
}

/**
 * Main parser dispatcher - routes register parsing to appropriate function
 */
export function parseRegister(regName: string, value: number): RegisterBitField[] {
  const upperName = regName.toUpperCase();

  if (upperName === 'DMACON' || upperName === 'DMACONR') {
    return parseDmaconRegister(value);
  } else if (upperName === 'INTENA' || upperName === 'INTENAR') {
    return parseIntenaRegister(value);
  } else if (upperName === 'INTR' || upperName === 'INTREQ' || upperName === 'INTREQR') {
    return parseIntreqRegister(value);
  } else if (upperName === 'BPLCON0') {
    return parseBplcon0Register(value);
  } else if (upperName === 'BPLCON1') {
    return parseBplcon1Register(value);
  } else if (upperName === 'BPLCON2') {
    return parseBplcon2Register(value);
  } else if (upperName === 'BPLCON3') {
    return parseBplcon3Register(value);
  } else if (upperName === 'BLTCON0') {
    return parseBltcon0Register(value);
  } else if (upperName === 'BLTCON1') {
    return parseBltcon1Register(value);
  } else if (upperName === 'VPOSR') {
    return parseVposrRegister(value);
  } else if (upperName === 'VHPOSR') {
    return parseVhposrRegister(value);
  } else if (upperName === 'BLTSIZE') {
    return parseBltSizeRegister(value);
  } else if (upperName === 'BLTSIZV') {
    return parseBltSizVRegister(value);
  } else if (upperName === 'BLTSIZH') {
    return parseBltSizHRegister(value);
  } else if (upperName === 'CLXCON') {
    return parseClxconRegister(value);
  } else if (upperName.match(/^SPR[0-7]CTL$/)) {
    return parseSpriteCtlRegister(value, upperName);
  } else if (upperName.match(/^SPR[0-7]POS$/)) {
    return parseSpritePosRegister(value, upperName);
  } else if (upperName === 'ADKCON' || upperName === 'ADKCONR') {
    return parseAdkconRegister(value);
  }

  return [];
}

// ===== DMA CONTROL REGISTERS =====

/**
 * Parses DMACON/DMACONR register bits
 */
export function parseDmaconRegister(dmacon: number): RegisterBitField[] {
  return [
    { name: "SET_CLR", value: (dmacon & 0x8000) !== 0, description: "Set/clear control bit (write only)" },
    { name: "BBUSY", value: (dmacon & 0x4000) !== 0, description: "Blitter busy status" },
    { name: "BZERO", value: (dmacon & 0x2000) !== 0, description: "Blitter logic zero status" },
    { name: "DMAEN", value: (dmacon & 0x0200) !== 0, description: "Enable all DMA below" },
    { name: "BPLEN", value: (dmacon & 0x0100) !== 0, description: "Bitplane DMA enable" },
    { name: "COPEN", value: (dmacon & 0x0080) !== 0, description: "Copper DMA enable" },
    { name: "BLTEN", value: (dmacon & 0x0040) !== 0, description: "Blitter DMA enable" },
    { name: "SPREN", value: (dmacon & 0x0020) !== 0, description: "Sprite DMA enable" },
    { name: "DSKEN", value: (dmacon & 0x0010) !== 0, description: "Disk DMA enable" },
    { name: "AUD3EN", value: (dmacon & 0x0008) !== 0, description: "Audio channel 3 DMA enable" },
    { name: "AUD2EN", value: (dmacon & 0x0004) !== 0, description: "Audio channel 2 DMA enable" },
    { name: "AUD1EN", value: (dmacon & 0x0002) !== 0, description: "Audio channel 1 DMA enable" },
    { name: "AUD0EN", value: (dmacon & 0x0001) !== 0, description: "Audio channel 0 DMA enable" },
  ];
}

// ===== INTERRUPT REGISTERS =====

/**
 * Parses INTENA/INTENAR register bits
 */
export function parseIntenaRegister(intena: number): RegisterBitField[] {
  return [
    { name: "SET_CLR", value: (intena & 0x8000) !== 0, description: "Set/clear control bit (write only)" },
    { name: "INTEN", value: (intena & 0x4000) !== 0, description: "Master interrupt enable" },
    { name: "EXTER", value: (intena & 0x2000) !== 0, description: "External interrupt (Level 6)" },
    { name: "DSKSYN", value: (intena & 0x1000) !== 0, description: "Disk sync register (Level 5)" },
    { name: "RBF", value: (intena & 0x0800) !== 0, description: "Serial receive buffer full (Level 5)" },
    { name: "AUD3", value: (intena & 0x0400) !== 0, description: "Audio channel 3 block finished (Level 4)" },
    { name: "AUD2", value: (intena & 0x0200) !== 0, description: "Audio channel 2 block finished (Level 4)" },
    { name: "AUD1", value: (intena & 0x0100) !== 0, description: "Audio channel 1 block finished (Level 4)" },
    { name: "AUD0", value: (intena & 0x0080) !== 0, description: "Audio channel 0 block finished (Level 4)" },
    { name: "BLIT", value: (intena & 0x0040) !== 0, description: "Blitter finished (Level 3)" },
    { name: "VERTB", value: (intena & 0x0020) !== 0, description: "Start of vertical blank (Level 3)" },
    { name: "COPER", value: (intena & 0x0010) !== 0, description: "Copper (Level 3)" },
    { name: "PORTS", value: (intena & 0x0008) !== 0, description: "I/O ports and timers (Level 2)" },
    { name: "SOFT", value: (intena & 0x0004) !== 0, description: "Software interrupt (Level 1)" },
    { name: "DSKBLK", value: (intena & 0x0002) !== 0, description: "Disk block finished (Level 1)" },
    { name: "TBE", value: (intena & 0x0001) !== 0, description: "Serial transmit buffer empty (Level 1)" },
  ];
}

/**
 * Parses INTREQ/INTREQR register bits (interrupt request flags)
 */
export function parseIntreqRegister(intreq: number): RegisterBitField[] {
  return [
    { name: "SET_CLR", value: (intreq & 0x8000) !== 0, description: "Set/clear control bit (write only)" },
    { name: "EXTER", value: (intreq & 0x2000) !== 0, description: "External interrupt request" },
    { name: "DSKSYN", value: (intreq & 0x1000) !== 0, description: "Disk sync register request" },
    { name: "RBF", value: (intreq & 0x0800) !== 0, description: "Serial receive buffer full request" },
    { name: "AUD3", value: (intreq & 0x0400) !== 0, description: "Audio channel 3 request" },
    { name: "AUD2", value: (intreq & 0x0200) !== 0, description: "Audio channel 2 request" },
    { name: "AUD1", value: (intreq & 0x0100) !== 0, description: "Audio channel 1 request" },
    { name: "AUD0", value: (intreq & 0x0080) !== 0, description: "Audio channel 0 request" },
    { name: "BLIT", value: (intreq & 0x0040) !== 0, description: "Blitter finished request" },
    { name: "VERTB", value: (intreq & 0x0020) !== 0, description: "Vertical blank request" },
    { name: "COPER", value: (intreq & 0x0010) !== 0, description: "Copper request" },
    { name: "PORTS", value: (intreq & 0x0008) !== 0, description: "I/O ports and timers request" },
    { name: "SOFT", value: (intreq & 0x0004) !== 0, description: "Software interrupt request" },
    { name: "DSKBLK", value: (intreq & 0x0002) !== 0, description: "Disk block finished request" },
    { name: "TBE", value: (intreq & 0x0001) !== 0, description: "Serial transmit buffer empty request" },
  ];
}

// ===== BITPLANE CONTROL REGISTERS =====

/**
 * Parses BPLCON0 register bits (Bitplane Control Register 0)
 */
export function parseBplcon0Register(bplcon0: number): RegisterBitField[] {
  const bpu = (bplcon0 >> 12) & 0x07; // Extract BPU2-BPU0 (bits 14-12)
  return [
    { name: "HIRES", value: (bplcon0 & 0x8000) !== 0, description: "High-resolution mode (70ns pixels)" },
    { name: "BPU", value: bpu, description: `Bitplane use code: ${bpu} bitplanes` },
    { name: "HOMOD", value: (bplcon0 & 0x0800) !== 0, description: "Hold-and-modify mode" },
    { name: "DBLPF", value: (bplcon0 & 0x0400) !== 0, description: "Double playfield enable" },
    { name: "COLOR", value: (bplcon0 & 0x0200) !== 0, description: "Composite video color enable" },
    { name: "GAUD", value: (bplcon0 & 0x0100) !== 0, description: "Genlock audio enable" },
    { name: "LPEN", value: (bplcon0 & 0x0008) !== 0, description: "Light pen enable" },
    { name: "LACE", value: (bplcon0 & 0x0004) !== 0, description: "Interlace enable" },
    { name: "ERSY", value: (bplcon0 & 0x0002) !== 0, description: "External sync enable" },
  ];
}

/**
 * Parses BPLCON1 register bits (Bitplane Control Register 1 - Horizontal scroll)
 */
export function parseBplcon1Register(bplcon1: number): RegisterBitField[] {
  const pf1h = ((bplcon1 >> 0) & 0x0F) | ((bplcon1 >> 6) & 0x30); // PF1H0-3 + PF1H4-5 (ECS/AGA)
  const pf2h = ((bplcon1 >> 4) & 0x0F) | ((bplcon1 >> 10) & 0x30); // PF2H0-3 + PF2H4-5 (ECS/AGA)
  return [
    { name: "PF2H", value: pf2h, description: `Playfield 2 horizontal scroll: ${pf2h} pixels` },
    { name: "PF1H", value: pf1h, description: `Playfield 1 horizontal scroll: ${pf1h} pixels` },
  ];
}

/**
 * Parses BPLCON2 register bits (Bitplane Control Register 2 - Priority and playfield)
 */
export function parseBplcon2Register(bplcon2: number): RegisterBitField[] {
  const pf2p = (bplcon2 >> 3) & 0x07; // PF2P2-PF2P0 (bits 5-3)
  const pf1p = bplcon2 & 0x07; // PF1P2-PF1P0 (bits 2-0)
  return [
    { name: "PF2PRI", value: (bplcon2 & 0x0040) !== 0, description: "Playfield 2 priority over playfield 1" },
    { name: "PF2P", value: pf2p, description: `Playfield 2 priority: ${pf2p}` },
    { name: "PF1P", value: pf1p, description: `Playfield 1 priority: ${pf1p}` },
  ];
}

/**
 * Parses BPLCON3 register bits (Bitplane Control Register 3 - AGA features)
 */
export function parseBplcon3Register(bplcon3: number): RegisterBitField[] {
  const bank = (bplcon3 >> 13) & 0x07; // BANK2-BANK0 (bits 15-13)
  const pf2of = (bplcon3 >> 3) & 0x07; // PF2OF2-PF2OF0 (bits 5-3)
  const loct = bplcon3 & 0x07; // LOCT2-LOCT0 (bits 2-0)

  return [
    { name: "BANK", value: bank, description: `Color bank select: ${bank}` },
    { name: "PF2OF", value: pf2of, description: `Playfield 2 color offset: ${pf2of * 8}` },
    { name: "SPRES", value: (bplcon3 & 0x0040) !== 0, description: "Sprite resolution (0=ECS, 1=VGA)" },
    { name: "BRDRSPRT", value: (bplcon3 & 0x0020) !== 0, description: "Border sprites enable" },
    { name: "BRDNTRAN", value: (bplcon3 & 0x0010) !== 0, description: "Border not transparent" },
    { name: "ZDCLKEN", value: (bplcon3 & 0x0004) !== 0, description: "ZD clock enable" },
    { name: "BRDBLNK", value: (bplcon3 & 0x0008) !== 0, description: "Border blanked" },
    { name: "LOCT", value: loct, description: `Color lookup table: ${loct}` },
  ];
}

// ===== BLITTER CONTROL REGISTERS =====

/**
 * Parses BLTCON0 register bits (Blitter Control Register 0)
 */
export function parseBltcon0Register(bltcon0: number): RegisterBitField[] {
  const ash = (bltcon0 >> 12) & 0x0F; // ASH3-ASH0 (bits 15-12)
  const useChannels = (bltcon0 >> 8) & 0x0F; // USEA,USEB,USEC,USED (bits 11-8)
  const lf = bltcon0 & 0xFF; // Logic function minterm (bits 7-0)

  return [
    { name: "ASH", value: ash, description: `A source shift: ${ash}` },
    { name: "USEA", value: (bltcon0 & 0x0800) !== 0, description: "Use A source channel" },
    { name: "USEB", value: (bltcon0 & 0x0400) !== 0, description: "Use B source channel" },
    { name: "USEC", value: (bltcon0 & 0x0200) !== 0, description: "Use C source channel" },
    { name: "USED", value: (bltcon0 & 0x0100) !== 0, description: "Use D destination channel" },
    { name: "CHANNELS", value: useChannels, description: `Active channels: 0b${useChannels.toString(2).padStart(4, '0')}` },
    { name: "LF", value: lf, description: `Logic function minterm: 0x${lf.toString(16).padStart(2, '0').toUpperCase()}` },
  ];
}

/**
 * Parses BLTCON1 register bits (Blitter Control Register 1)
 */
export function parseBltcon1Register(bltcon1: number): RegisterBitField[] {
  const isLineMode = (bltcon1 & 0x0001) !== 0;

  if (isLineMode) {
    // Line mode
    const texture = (bltcon1 >> 12) & 0x0F; // TEXTURE3-TEXTURE0 (bits 15-12)
    return [
      { name: "MODE", value: "LINE", description: "Line drawing mode" },
      { name: "TEXTURE", value: texture, description: `Line texture pattern: 0x${texture.toString(16).toUpperCase()}` },
      { name: "SIGN", value: (bltcon1 & 0x0040) !== 0, description: "Sign bit for line drawing" },
      { name: "SUD", value: (bltcon1 & 0x0010) !== 0, description: "Sometimes up or down" },
      { name: "SUL", value: (bltcon1 & 0x0008) !== 0, description: "Sometimes up or left" },
      { name: "AUL", value: (bltcon1 & 0x0004) !== 0, description: "Always up or left" },
    ];
  } else {
    // Area mode
    const bsh = (bltcon1 >> 12) & 0x0F; // BSH3-BSH0 (bits 15-12)
    return [
      { name: "MODE", value: "AREA", description: "Area fill mode" },
      { name: "BSH", value: bsh, description: `B source shift: ${bsh}` },
      { name: "EFE", value: (bltcon1 & 0x0010) !== 0, description: "Exclusive fill enable" },
      { name: "IFE", value: (bltcon1 & 0x0008) !== 0, description: "Inclusive fill enable" },
      { name: "FCI", value: (bltcon1 & 0x0004) !== 0, description: "Fill carry input" },
      { name: "DESC", value: (bltcon1 & 0x0002) !== 0, description: "Descending (right to left, bottom to top)" },
    ];
  }
}

// ===== DISPLAY POSITION REGISTERS =====

/**
 * Parses VPOSR register bits (Vertical Position and Chip ID)
 */
export function parseVposrRegister(vposr: number): RegisterBitField[] {
  const lof = (vposr & 0x8000) !== 0;
  const chipId = (vposr >> 1) & 0x7FFF; // Bits 14-1
  const v8 = (vposr & 0x0001) !== 0;

  return [
    { name: "LOF", value: lof, description: lof ? "Long frame (NTSC)" : "Short frame (PAL)" },
    { name: "CHIP_ID", value: chipId, description: `Chip identification: 0x${chipId.toString(16).toUpperCase()}` },
    { name: "V8", value: v8, description: "Vertical position bit 8 (MSB)" },
  ];
}

/**
 * Parses VHPOSR register bits (Vertical and Horizontal Position)
 */
export function parseVhposrRegister(vhposr: number): RegisterBitField[] {
  const v = (vhposr >> 8) & 0xFF; // Bits 15-8: V7-V0
  const h = (vhposr & 0xFF) << 1; // Bits 7-0: H8-H1 (shifted to get actual position)

  return [
    { name: "VPOS", value: v, description: `Vertical beam position: ${v}` },
    { name: "HPOS", value: h, description: `Horizontal beam position: ${h} (280ns resolution)` },
    { name: "SCANLINE", value: v, description: `Current scanline: ${v}` },
  ];
}

// ===== BLITTER SIZE REGISTERS =====

/**
 * Parses BLTSIZE register bits (Classic blitter size - OCS/ECS)
 */
export function parseBltSizeRegister(bltsize: number): RegisterBitField[] {
  const height = (bltsize >> 6) & 0x3FF; // Bits 15-6: height (10 bits)
  const width = bltsize & 0x3F; // Bits 5-0: width (6 bits)
  const pixels = (width || 64) * (height || 1024); // 0 means max size

  return [
    { name: "HEIGHT", value: height || 1024, description: `Blit height: ${height || 1024} lines` },
    { name: "WIDTH", value: width || 64, description: `Blit width: ${width || 64} words` },
    { name: "PIXELS", value: pixels, description: `Total area: ${pixels} pixels` },
  ];
}

/**
 * Parses BLTSIZV register bits (ECS vertical size)
 */
export function parseBltSizVRegister(bltsizv: number): RegisterBitField[] {
  const height = bltsizv & 0x7FFF; // 15-bit vertical size

  return [
    { name: "HEIGHT", value: height || 32768, description: `Blit height: ${height || 32768} lines` },
    { name: "ENHANCED", value: "ECS", description: "Enhanced chip set vertical sizing" },
  ];
}

/**
 * Parses BLTSIZH register bits (ECS horizontal size)
 */
export function parseBltSizHRegister(bltsizh: number): RegisterBitField[] {
  const width = bltsizh & 0x7FF; // 11-bit horizontal size

  return [
    { name: "WIDTH", value: width || 2048, description: `Blit width: ${width || 2048} words` },
    { name: "ENHANCED", value: "ECS", description: "Enhanced chip set horizontal sizing" },
  ];
}

// ===== COLLISION AND CONTROL REGISTERS =====

/**
 * Parses CLXCON register bits (Collision Control)
 */
export function parseClxconRegister(clxcon: number): RegisterBitField[] {
  const spriteMask = (clxcon >> 12) & 0x0F; // Bits 15-12: sprite collision mask
  const playfield2Mask = (clxcon >> 6) & 0x3F; // Bits 11-6: playfield 2 collision mask
  const playfield1Mask = clxcon & 0x3F; // Bits 5-0: playfield 1 collision mask

  return [
    { name: "SSPRITE", value: spriteMask, description: `Sprite collision mask: 0x${spriteMask.toString(16).toUpperCase()}` },
    { name: "SPF2", value: playfield2Mask, description: `PF2 collision mask: 0x${playfield2Mask.toString(16).toUpperCase()}` },
    { name: "SPF1", value: playfield1Mask, description: `PF1 collision mask: 0x${playfield1Mask.toString(16).toUpperCase()}` },
  ];
}

// ===== SPRITE REGISTERS =====

/**
 * Parses SPRxCTL register bits (Sprite Control)
 */
export function parseSpriteCtlRegister(sprctl: number, regName: string): RegisterBitField[] {
  const spriteNum = regName[3]; // Extract sprite number from register name
  const ev = (sprctl >> 8) & 0xFF; // Bits 15-8: end vertical (low 8 bits)
  const att = (sprctl & 0x0080) !== 0; // Bit 7: attach bit
  const sv8 = (sprctl & 0x0004) !== 0; // Bit 2: start vertical bit 8
  const ev8 = (sprctl & 0x0002) !== 0; // Bit 1: end vertical bit 8
  const sh0 = (sprctl & 0x0001) !== 0; // Bit 0: start horizontal bit 0

  // Note: startV would be calculated as: sv8 ? 256 : 0, but low bits come from SPRxPOS
  const endV = (ev8 ? 256 : 0) + ev; // Full end vertical position

  return [
    { name: "SPRITE", value: spriteNum, description: `Sprite number: ${spriteNum}` },
    { name: "END_V", value: endV, description: `End vertical position: ${endV}` },
    { name: "ATT", value: att, description: att ? "Attached to previous sprite" : "Independent sprite" },
    { name: "SV8", value: sv8, description: "Start vertical position bit 8" },
    { name: "EV8", value: ev8, description: "End vertical position bit 8" },
    { name: "SH0", value: sh0, description: "Start horizontal position bit 0" },
  ];
}

/**
 * Parses SPRxPOS register bits (Sprite Position)
 */
export function parseSpritePosRegister(sprpos: number, regName: string): RegisterBitField[] {
  const spriteNum = regName[3]; // Extract sprite number from register name
  const sv = (sprpos >> 8) & 0xFF; // Bits 15-8: start vertical (low 8 bits)
  const sh = (sprpos & 0xFE) >> 1; // Bits 7-1: start horizontal (7 bits)

  return [
    { name: "SPRITE", value: spriteNum, description: `Sprite number: ${spriteNum}` },
    { name: "START_V", value: sv, description: `Start vertical position: ${sv} (+ bit 8 from CTL)` },
    { name: "START_H", value: sh << 1, description: `Start horizontal position: ${sh << 1} (+ bit 0 from CTL)` },
  ];
}

// ===== AUDIO/DISK CONTROL REGISTERS =====

/**
 * Parses ADKCON/ADKCONR register bits (Audio/Disk Control)
 */
export function parseAdkconRegister(adkcon: number): RegisterBitField[] {
  const setClear = (adkcon & 0x8000) !== 0;
  const precomp = (adkcon >> 13) & 0x03; // Bits 14-13
  const precompDesc = ['None', '140ns', '280ns', '560ns'][precomp];

  return [
    { name: "SET_CLR", value: setClear, description: "Set/clear control bit (write only)" },
    { name: "PRECOMP", value: precomp, description: `Precompensation: ${precompDesc}` },
    { name: "MFMPREC", value: (adkcon & 0x1000) !== 0, description: "MFM precomp (vs GCR)" },
    { name: "UARTBRK", value: (adkcon & 0x0800) !== 0, description: "Force UART break" },
    { name: "WORDSYNC", value: (adkcon & 0x0400) !== 0, description: "Disk word sync enable" },
    { name: "MSBSYNC", value: (adkcon & 0x0200) !== 0, description: "Sync on MSB for disk read" },
    { name: "FAST", value: (adkcon & 0x0100) !== 0, description: "1=fast, 0=slow disk or serial" },
    { name: "USE3PN", value: (adkcon & 0x0080) !== 0, description: "Use PN3 (3rd-order polynomial)" },
    { name: "USE2P3", value: (adkcon & 0x0040) !== 0, description: "Use P23 (2nd & 3rd audio)" },
    { name: "USE1P2", value: (adkcon & 0x0020) !== 0, description: "Use P12 (1st & 2nd audio)" },
    { name: "USE0P1", value: (adkcon & 0x0010) !== 0, description: "Use P01 (0th & 1st audio)" },
    { name: "USE3VN", value: (adkcon & 0x0008) !== 0, description: "Use VN3 (volume of 3rd)" },
    { name: "USE2V3", value: (adkcon & 0x0004) !== 0, description: "Use V23 (volume of 2nd & 3rd)" },
    { name: "USE1V2", value: (adkcon & 0x0002) !== 0, description: "Use V12 (volume of 1st & 2nd)" },
    { name: "USE0V1", value: (adkcon & 0x0001) !== 0, description: "Use V01 (volume of 0th & 1st)" },
  ];
}