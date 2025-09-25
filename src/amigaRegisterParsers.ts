/**
 * Amiga Hardware Register Bit Parsers
 *
 * This module contains parsers for various Amiga custom chip registers,
 * breaking down their bit fields into meaningful components wit },
 *
 * Each parser function takes a register value and returns an array of named
 * bit fields with their values and human-readabl },
 */

import { formatBin, formatHex } from "./numbers";

export interface RegisterBitField {
  name: string;
  value: boolean | number | string;
}

/**
 * Registry of supported registers for bit breakdown display
 */
export const SUPPORTED_REGISTERS = [
  "DMACON",
  "DMACONR",
  "INTENA",
  "INTENAR",
  "INTR",
  "INTREQ",
  "INTREQR",
  "BPLCON0",
  "BPLCON1",
  "BPLCON2",
  "BPLCON3",
  "BLTCON0",
  "BLTCON1",
  "VPOSR",
  "VHPOSR",
  "BLTSIZE",
  "BLTSIZV",
  "BLTSIZH",
  "CLXCON",
  "SPR0CTL",
  "SPR1CTL",
  "SPR2CTL",
  "SPR3CTL",
  "SPR4CTL",
  "SPR5CTL",
  "SPR6CTL",
  "SPR7CTL",
  "SPR0POS",
  "SPR1POS",
  "SPR2POS",
  "SPR3POS",
  "SPR4POS",
  "SPR5POS",
  "SPR6POS",
  "SPR7POS",
  "ADKCON",
  "ADKCONR",
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
export function parseRegister(
  regName: string,
  value: number,
): RegisterBitField[] {
  const upperName = regName.toUpperCase();

  if (upperName === "DMACON" || upperName === "DMACONR") {
    return parseDmaconRegister(value);
  } else if (upperName === "INTENA" || upperName === "INTENAR") {
    return parseIntenaRegister(value);
  } else if (
    upperName === "INTR" ||
    upperName === "INTREQ" ||
    upperName === "INTREQR"
  ) {
    return parseIntreqRegister(value);
  } else if (upperName === "BPLCON0") {
    return parseBplcon0Register(value);
  } else if (upperName === "BPLCON1") {
    return parseBplcon1Register(value);
  } else if (upperName === "BPLCON2") {
    return parseBplcon2Register(value);
  } else if (upperName === "BPLCON3") {
    return parseBplcon3Register(value);
  } else if (upperName === "BLTCON0") {
    return parseBltcon0Register(value);
  } else if (upperName === "BLTCON1") {
    return parseBltcon1Register(value);
  } else if (upperName === "VPOSR") {
    return parseVposrRegister(value);
  } else if (upperName === "VHPOSR") {
    return parseVhposrRegister(value);
  } else if (upperName === "BLTSIZE") {
    return parseBltSizeRegister(value);
  } else if (upperName === "BLTSIZV") {
    return parseBltSizVRegister(value);
  } else if (upperName === "BLTSIZH") {
    return parseBltSizHRegister(value);
  } else if (upperName === "CLXCON") {
    return parseClxconRegister(value);
  } else if (upperName.match(/^SPR[0-7]CTL$/)) {
    return parseSpriteCtlRegister(value);
  } else if (upperName.match(/^SPR[0-7]POS$/)) {
    return parseSpritePosRegister(value);
  } else if (upperName === "ADKCON" || upperName === "ADKCONR") {
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
    { name: "BLIT_BUSY", value: (dmacon & 0x4000) !== 0 },
    { name: "BLIT_ZERO", value: (dmacon & 0x2000) !== 0 },
    { name: "BLIT_HOG", value: (dmacon & 0x400) !== 0 },
    { name: "ENABLE_ALL", value: (dmacon & 0x0200) !== 0 },
    { name: "BITPLANES", value: (dmacon & 0x0100) !== 0 },
    { name: "COPPER", value: (dmacon & 0x0080) !== 0 },
    { name: "BLITTER", value: (dmacon & 0x0040) !== 0 },
    { name: "SPRITES", value: (dmacon & 0x0020) !== 0 },
    { name: "DISK", value: (dmacon & 0x0010) !== 0 },
    { name: "AUD3", value: (dmacon & 0x0008) !== 0 },
    { name: "AUD2", value: (dmacon & 0x0004) !== 0 },
    { name: "AUD1", value: (dmacon & 0x0002) !== 0 },
    { name: "AUD0", value: (dmacon & 0x0001) !== 0 },
  ];
}

// ===== INTERRUPT REGISTERS =====

/**
 * Parses INTENA/INTENAR register bits
 */
export function parseIntenaRegister(intena: number): RegisterBitField[] {
  return [
    { name: "MASTER_ENABLE", value: (intena & 0x4000) !== 0 },
    { name: "EXTERNAL", value: (intena & 0x2000) !== 0 },
    { name: "DISK_SYNC", value: (intena & 0x1000) !== 0 },
    { name: "RECEIVE_BUFFER_FULL", value: (intena & 0x0800) !== 0 },
    { name: "AUD3", value: (intena & 0x0400) !== 0 },
    { name: "AUD2", value: (intena & 0x0200) !== 0 },
    { name: "AUD1", value: (intena & 0x0100) !== 0 },
    { name: "AUD0", value: (intena & 0x0080) !== 0 },
    { name: "BLITTER", value: (intena & 0x0040) !== 0 },
    { name: "VERTICAL_BLANK", value: (intena & 0x0020) !== 0 },
    { name: "COPPER", value: (intena & 0x0010) !== 0 },
    { name: "PORTS", value: (intena & 0x0008) !== 0 },
    { name: "SOFT", value: (intena & 0x0004) !== 0 },
    { name: "DISK_BLOCK", value: (intena & 0x0002) !== 0 },
    { name: "TRANSMIT_BUFFER_EMPTY", value: (intena & 0x0001) !== 0 },
  ];
}

/**
 * Parses INTREQ/INTREQR register bits (interrupt request flags)
 */
export function parseIntreqRegister(intreq: number): RegisterBitField[] {
  return [
    { name: "EXTERNAL", value: (intreq & 0x2000) !== 0 },
    { name: "DISK_SYNC", value: (intreq & 0x1000) !== 0 },
    { name: "RECEIVE_BUFFER_FULL", value: (intreq & 0x0800) !== 0 },
    { name: "AUD3", value: (intreq & 0x0400) !== 0 },
    { name: "AUD2", value: (intreq & 0x0200) !== 0 },
    { name: "AUD1", value: (intreq & 0x0100) !== 0 },
    { name: "AUD0", value: (intreq & 0x0080) !== 0 },
    { name: "BLITTER", value: (intreq & 0x0040) !== 0 },
    { name: "VERTICAL_BLANK", value: (intreq & 0x0020) !== 0 },
    { name: "COPPER", value: (intreq & 0x0010) !== 0 },
    { name: "PORTS", value: (intreq & 0x0008) !== 0 },
    { name: "SOFT", value: (intreq & 0x0004) !== 0 },
    { name: "DISK_BLOCK", value: (intreq & 0x0002) !== 0 },
    { name: "TRANSMIT_BUFFER_EMPTY", value: (intreq & 0x0001) !== 0 },
  ];
}

// ===== BITPLANE CONTROL REGISTERS =====

/**
 * Parses BPLCON0 register bits (Bitplane Control Register 0)
 */
export function parseBplcon0Register(bplcon0: number): RegisterBitField[] {
  const bpu = (bplcon0 >> 12) & 0x07; // Extract BPU2-BPU0 (bits 14-12)
  return [
    { name: "HIRES", value: (bplcon0 & 0x8000) !== 0 },
    { name: "BITPLANES", value: bpu },
    { name: "HAM", value: (bplcon0 & 0x0800) !== 0 },
    { name: "DOUBLE_PLAYFIELD", value: (bplcon0 & 0x0400) !== 0 },
    { name: "COLOR", value: (bplcon0 & 0x0200) !== 0 },
    { name: "GENLOCK_AUDIO", value: (bplcon0 & 0x0100) !== 0 },
    { name: "LIGHTPEN", value: (bplcon0 & 0x0008) !== 0 },
    { name: "INTERLACE", value: (bplcon0 & 0x0004) !== 0 },
    { name: "EXTERNAL_RESYNC", value: (bplcon0 & 0x0002) !== 0 },
  ];
}

/**
 * Parses BPLCON1 register bits (Bitplane Control Register 1 - Horizontal scroll)
 */
export function parseBplcon1Register(bplcon1: number): RegisterBitField[] {
  const pf1h = ((bplcon1 >> 0) & 0x0f) | ((bplcon1 >> 6) & 0x30); // PF1H0-3 + PF1H4-5 (ECS/AGA)
  const pf2h = ((bplcon1 >> 4) & 0x0f) | ((bplcon1 >> 10) & 0x30); // PF2H0-3 + PF2H4-5 (ECS/AGA)
  return [
    { name: "PF2H", value: pf2h },
    { name: "PF1H", value: pf1h },
  ];
}

/**
 * Parses BPLCON2 register bits (Bitplane Control Register 2 - Priority and playfield)
 */
export function parseBplcon2Register(bplcon2: number): RegisterBitField[] {
  const pf2p = (bplcon2 >> 3) & 0x07; // PF2P2-PF2P0 (bits 5-3)
  const pf1p = bplcon2 & 0x07; // PF1P2-PF1P0 (bits 2-0)
  return [
    { name: "PF2PRI", value: (bplcon2 & 0x0040) !== 0 },
    { name: "PF2P", value: pf2p },
    { name: "PF1P", value: pf1p },
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
    { name: "BANK", value: bank },
    { name: "PF2OF", value: pf2of },
    { name: "SPRITE_RES", value: (bplcon3 & 0x0040) !== 0 },
    { name: "BORDER_SPRITES", value: (bplcon3 & 0x0020) !== 0 },
    { name: "BORDER_TRANSPARENT", value: (bplcon3 & 0x0010) !== 0 },
    { name: "ZDCLKEN", value: (bplcon3 & 0x0004) !== 0 },
    { name: "BORDER_BLANK", value: (bplcon3 & 0x0008) !== 0 },
    { name: "LOCT", value: loct },
  ];
}

// ===== BLITTER CONTROL REGISTERS =====

/**
 * Parses BLTCON0 register bits (Blitter Control Register 0)
 */
export function parseBltcon0Register(bltcon0: number): RegisterBitField[] {
  const ash = (bltcon0 >> 12) & 0x0f; // ASH3-ASH0 (bits 15-12)
  const minterm = bltcon0 & 0xff; // Logic function minterm (bits 7-0)

  return [
    { name: "ASHIFT", value: ash },
    { name: "USEA", value: (bltcon0 & 0x0800) !== 0 },
    { name: "USEB", value: (bltcon0 & 0x0400) !== 0 },
    { name: "USEC", value: (bltcon0 & 0x0200) !== 0 },
    { name: "USED", value: (bltcon0 & 0x0100) !== 0 },
    { name: "MINTERM", value: formatHex(minterm, 2) },
  ];
}

/**
 * Parses BLTCON1 register bits (Blitter Control Register 1)
 */
export function parseBltcon1Register(bltcon1: number): RegisterBitField[] {
  const isLineMode = (bltcon1 & 0x0001) !== 0;

  if (isLineMode) {
    // Line mode
    const texture = (bltcon1 >> 12) & 0x0f; // TEXTURE3-TEXTURE0 (bits 15-12)
    return [
      { name: "MODE", value: "LINE" },
      { name: "TEXTURE", value: formatBin(texture, 4) },
      { name: "SINGLE_BIT", value: (bltcon1 & 0x0040) !== 0 },
      { name: "SUD", value: (bltcon1 & 0x0010) !== 0 },
      { name: "SUL", value: (bltcon1 & 0x0008) !== 0 },
      { name: "AUL", value: (bltcon1 & 0x0004) !== 0 },
    ];
  } else {
    // Area mode
    const bsh = (bltcon1 >> 12) & 0x0f; // BSH3-BSH0 (bits 15-12)
    return [
      { name: "MODE", value: "AREA" },
      { name: "BSHIFT", value: bsh },
      { name: "EXCLUSIVE_FILL", value: (bltcon1 & 0x0010) !== 0 },
      { name: "INCLUSIVE_FILL", value: (bltcon1 & 0x0008) !== 0 },
      { name: "FILL_CARY_INPUT", value: (bltcon1 & 0x0004) !== 0 },
      { name: "DESC", value: (bltcon1 & 0x0002) !== 0 },
    ];
  }
}

// ===== DISPLAY POSITION REGISTERS =====

/**
 * Parses VPOSR register bits (Vertical Position and Chip ID)
 */
export function parseVposrRegister(vposr: number): RegisterBitField[] {
  const lof = (vposr & 0x8000) !== 0;
  const chipId = (vposr >> 1) & 0x7fff; // Bits 14-1
  const v8 = (vposr & 0x0001) !== 0;

  return [
    { name: "LOF", value: lof },
    { name: "CHIP_ID", value: formatHex(chipId, 4) },
    { name: "VPOS8", value: v8 },
  ];
}

/**
 * Parses VHPOSR register bits (Vertical and Horizontal Position)
 */
export function parseVhposrRegister(vhposr: number): RegisterBitField[] {
  const v = (vhposr >> 8) & 0xff; // Bits 15-8: V7-V0
  const h = (vhposr & 0xff) << 1; // Bits 7-0: H8-H1 (shifted to get actual position)

  return [
    { name: "VPOS", value: v },
    { name: "HPOS", value: h },
  ];
}

// ===== BLITTER SIZE REGISTERS =====

/**
 * Parses BLTSIZE register bits (Classic blitter size - OCS/ECS)
 */
export function parseBltSizeRegister(bltsize: number): RegisterBitField[] {
  const height = (bltsize >> 6) & 0x3ff; // Bits 15-6: height (10 bits)
  const width = bltsize & 0x3f; // Bits 5-0: width (6 bits)

  return [
    { name: "HEIGHT", value: height || 1024 },
    { name: "WIDTH", value: width || 64 },
  ];
}

/**
 * Parses BLTSIZV register bits (ECS vertical size)
 */
export function parseBltSizVRegister(bltsizv: number): RegisterBitField[] {
  const height = bltsizv & 0x7fff; // 15-bit vertical size

  return [{ name: "HEIGHT", value: height || 32768 }];
}

/**
 * Parses BLTSIZH register bits (ECS horizontal size)
 */
export function parseBltSizHRegister(bltsizh: number): RegisterBitField[] {
  const width = bltsizh & 0x7ff; // 11-bit horizontal size

  return [{ name: "WIDTH", value: width || 2048 }];
}

// ===== COLLISION AND CONTROL REGISTERS =====

/**
 * Parses CLXCON register bits (Collision Control)
 */
export function parseClxconRegister(clxcon: number): RegisterBitField[] {
  const spriteMask = (clxcon >> 12) & 0x0f; // Bits 15-12: sprite collision mask
  const playfield2Mask = (clxcon >> 6) & 0x3f; // Bits 11-6: playfield 2 collision mask
  const playfield1Mask = clxcon & 0x3f; // Bits 5-0: playfield 1 collision mask

  return [
    { name: "SSPRITE", value: spriteMask },
    { name: "SPF2", value: playfield2Mask },
    { name: "SPF1", value: playfield1Mask },
  ];
}

// ===== SPRITE REGISTERS =====

/**
 * Parses SPRxCTL register bits (Sprite Control)
 */
export function parseSpriteCtlRegister(sprctl: number): RegisterBitField[] {
  const ev = (sprctl >> 8) & 0xff; // Bits 15-8: end vertical (low 8 bits)
  const att = (sprctl & 0x0080) !== 0; // Bit 7: attach bit
  const sv8 = (sprctl & 0x0004) !== 0; // Bit 2: start vertical bit 8
  const ev8 = (sprctl & 0x0002) !== 0; // Bit 1: end vertical bit 8
  const sh0 = (sprctl & 0x0001) !== 0; // Bit 0: start horizontal bit 0

  // Note: startV would be calculated as: sv8 ? 256 : 0, but low bits come from SPRxPOS
  const endV = (ev8 ? 256 : 0) + ev; // Full end vertical position

  return [
    { name: "END_V", value: endV },
    { name: "ATTACHED", value: att },
    { name: "START_V8", value: sv8 },
    { name: "START_H0", value: sh0 },
  ];
}

/**
 * Parses SPRxPOS register bits (Sprite Position)
 */
export function parseSpritePosRegister(sprpos: number): RegisterBitField[] {
  const sv = (sprpos >> 8) & 0xff; // Bits 15-8: start vertical (low 8 bits)
  const sh = (sprpos & 0xfe) >> 1; // Bits 7-1: start horizontal (7 bits)

  return [
    { name: "START_V", value: sv },
    { name: "START_H", value: sh << 1 },
  ];
}

// ===== AUDIO/DISK CONTROL REGISTERS =====

/**
 * Parses ADKCON/ADKCONR register bits (Audio/Disk Control)
 */
export function parseAdkconRegister(adkcon: number): RegisterBitField[] {
  const setClear = (adkcon & 0x8000) !== 0;
  const precomp = (adkcon >> 13) & 0x03; // Bits 14-13

  return [
    { name: "SET_CLR", value: setClear },
    { name: "PRECOMP", value: precomp },
    { name: "MFMPREC", value: (adkcon & 0x1000) !== 0 },
    { name: "UARTBRK", value: (adkcon & 0x0800) !== 0 },
    { name: "WORDSYNC", value: (adkcon & 0x0400) !== 0 },
    { name: "MSBSYNC", value: (adkcon & 0x0200) !== 0 },
    { name: "FAST", value: (adkcon & 0x0100) !== 0 },
    { name: "USE3PN", value: (adkcon & 0x0080) !== 0 },
    { name: "USE2P3", value: (adkcon & 0x0040) !== 0 },
    { name: "USE1P2", value: (adkcon & 0x0020) !== 0 },
    { name: "USE0P1", value: (adkcon & 0x0010) !== 0 },
    { name: "USE3VN", value: (adkcon & 0x0008) !== 0 },
    { name: "USE2V3", value: (adkcon & 0x0004) !== 0 },
    { name: "USE1V2", value: (adkcon & 0x0002) !== 0 },
    { name: "USE0V1", value: (adkcon & 0x0001) !== 0 },
  ];
}
