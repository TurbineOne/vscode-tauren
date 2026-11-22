// Pure ANSI theme facade shared by transcript rendering, ExtensionUIContext, and Custom UI hosts.
// ANSI foregrounds are retained; the transcript renderer strips backgrounds.
export type TaurenIndexedColor = {
  readonly kind: 'indexed';
  readonly index: number;
};

export type TaurenColor =
  | TaurenIndexedColor
  | { readonly kind: 'rgb'; readonly r: number; readonly g: number; readonly b: number }
  | { readonly kind: 'oklch'; readonly l: number; readonly c: number; readonly h: number };

export type TaurenThemeStyle = {
  fg?: string | TaurenColor;
  bg?: string | TaurenColor;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strikethrough?: boolean;
};

const colorCodes: Record<string, number> = {
  accent: 36,
  border: 90,
  borderAccent: 36,
  borderMuted: 90,
  success: 32,
  error: 31,
  warning: 33,
  muted: 90,
  dim: 90,
  text: 37,
  thinkingText: 35,
  scrollbarTrack: 90,
  scrollbarThumb: 37,
  searchMatchText: 37,
  userMessageText: 36,
  customMessageText: 37,
  customMessageLabel: 36,
  toolTitle: 36,
  toolOutput: 37,
  mdHeading: 36,
  mdLink: 34,
  mdLinkUrl: 34,
  mdCode: 33,
  mdCodeBlock: 37,
  mdCodeBlockBorder: 90,
  mdQuote: 90,
  mdQuoteBorder: 90,
  mdHr: 90,
  mdListBullet: 36,
  toolDiffAdded: 32,
  toolDiffRemoved: 31,
  toolDiffContext: 90,
  syntaxComment: 90,
  syntaxKeyword: 35,
  syntaxFunction: 36,
  syntaxVariable: 37,
  syntaxString: 32,
  syntaxNumber: 33,
  syntaxType: 36,
  syntaxOperator: 37,
  syntaxPunctuation: 37,
  thinkingOff: 90,
  thinkingMinimal: 36,
  thinkingLow: 34,
  thinkingMedium: 33,
  thinkingHigh: 31,
  thinkingXhigh: 35,
  thinkingMax: 35,
  bashMode: 32
};

const bgCodes: Record<string, number> = {
  selectedBg: 44,
  searchMatchBg: 44,
  userMessageBg: 44,
  customMessageBg: 45,
  toolPendingBg: 43,
  toolSuccessBg: 42,
  toolErrorBg: 41
};

const resolvedColors: Readonly<Record<string, TaurenIndexedColor>> = Object.freeze({
  ...Object.fromEntries(Object.entries(colorCodes).map(([token, code]) => [token, sgrCodeToIndexedColor(code, false)])),
  ...Object.fromEntries(Object.entries(bgCodes).map(([token, code]) => [token, sgrCodeToIndexedColor(code, true)]))
});

export const taurenTheme = {
  name: 'dark',
  appearance: 'dark' as const,
  colors: resolvedColors,
  style(text: string, options: TaurenThemeStyle) {
    let prefix = '';
    let suffix = '';
    const fgAnsi = options.fg === undefined ? undefined : resolveColorAnsi(options.fg, false);
    const bgAnsi = options.bg === undefined ? undefined : resolveColorAnsi(options.bg, true);

    if (fgAnsi) {
      prefix += fgAnsi;
      suffix = '\x1b[39m';
    }
    if (bgAnsi) {
      prefix += bgAnsi;
      suffix = `\x1b[49m${suffix}`;
    }
    if (options.bold) {
      prefix += '\x1b[1m';
    }
    if (options.dim) {
      prefix += '\x1b[2m';
    }
    if (options.bold || options.dim) {
      suffix = `\x1b[22m${suffix}`;
    }
    if (options.italic) {
      prefix += '\x1b[3m';
      suffix = `\x1b[23m${suffix}`;
    }
    if (options.underline) {
      prefix += '\x1b[4m';
      suffix = `\x1b[24m${suffix}`;
    }
    if (options.inverse) {
      prefix += '\x1b[7m';
      suffix = `\x1b[27m${suffix}`;
    }
    if (options.strikethrough) {
      prefix += '\x1b[9m';
      suffix = `\x1b[29m${suffix}`;
    }

    return `${prefix}${text}${suffix}`;
  },
  fg(color: string, text: string) {
    return wrap(colorCodes[color] ?? 37, 39, text);
  },
  bg(color: string, text: string) {
    return wrap(bgCodes[color] ?? 44, 49, text);
  },
  bold(text: string) {
    return wrap(1, 22, text);
  },
  italic(text: string) {
    return wrap(3, 23, text);
  },
  underline(text: string) {
    return wrap(4, 24, text);
  },
  inverse(text: string) {
    return wrap(7, 27, text);
  },
  strikethrough(text: string) {
    return wrap(9, 29, text);
  },
  getFgAnsi(color: string) {
    return `\x1b[${colorCodes[color] ?? 37}m`;
  },
  getBgAnsi(color: string) {
    return `\x1b[${bgCodes[color] ?? 44}m`;
  },
  getColorMode() {
    return '256color' as const;
  },
  getThinkingBorderColor(level: string) {
    return (text: string) => wrap(colorCodes[`thinking${capitalize(level)}`] ?? colorCodes.thinkingOff ?? 90, 39, text);
  },
  getBashModeBorderColor() {
    return (text: string) => wrap(colorCodes.bashMode ?? 32, 39, text);
  }
};

function wrap(openCode: number, closeCode: number, text: string): string {
  return `\x1b[${openCode}m${text}\x1b[${closeCode}m`;
}

function sgrCodeToIndexedColor(code: number, background: boolean): TaurenIndexedColor {
  const index = background
    ? (code >= 100 ? code - 92 : code - 40)
    : (code >= 90 ? code - 82 : code - 30);
  return Object.freeze({ kind: 'indexed', index });
}

function resolveColorAnsi(color: string | TaurenColor, background: boolean): string {
  if (typeof color === 'string') {
    const code = background ? (bgCodes[color] ?? 44) : (colorCodes[color] ?? 37);
    return `\x1b[${code}m`;
  }

  const slot = background ? 48 : 38;
  if (color.kind === 'indexed') {
    const index = Math.max(0, Math.min(255, Math.trunc(color.index)));
    return `\x1b[${slot};5;${index}m`;
  }

  const rgb = color.kind === 'rgb' ? color : oklchToRgb(color.l, color.c, color.h);
  return `\x1b[${slot};2;${clampByte(rgb.r)};${clampByte(rgb.g)};${clampByte(rgb.b)}m`;
}

function oklchToRgb(l: number, c: number, h: number): { r: number; g: number; b: number } {
  const radians = (h * Math.PI) / 180;
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);
  const lPrime = l + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = l - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = l - 0.0894841775 * a - 1.2914855480 * b;
  const lCube = lPrime * lPrime * lPrime;
  const mCube = mPrime * mPrime * mPrime;
  const sCube = sPrime * sPrime * sPrime;
  return {
    r: linearToSrgbByte(+4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube),
    g: linearToSrgbByte(-1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube),
    b: linearToSrgbByte(-0.0041960863 * lCube - 0.7034186147 * mCube + 1.7076147010 * sCube)
  };
}

function linearToSrgbByte(channel: number): number {
  const clamped = Math.max(0, Math.min(1, channel));
  const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return clampByte(encoded * 255);
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}
