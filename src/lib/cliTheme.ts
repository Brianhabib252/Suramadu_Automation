/**
 * Provides themed formatting helpers for the CLI, supporting both rich ANSI
 * output and plain ASCII fallbacks. Used across the runner to render boxes,
 * status lines, and tree-like step details.
 */
const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  cyan: '\u001b[36m',
  magenta: '\u001b[35m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  gray: '\u001b[90m',
  blue: '\u001b[34m',
};

type Tone = 'info' | 'success' | 'warning' | 'error';

interface BoxChars {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
}

interface Symbols {
  step: string;
  pointer: string;
  bullet: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  detailStem: string;
  spacer: string;
}

export interface CliTheme {
  readonly useColor: boolean;
  readonly useUnicode: boolean;
  readonly box: BoxChars;
  readonly symbols: Symbols;
  style(codes: string | string[], text: string): string;
  bold(text: string): string;
  heading(text: string): string;
  label(text: string): string;
  accent(text: string): string;
  highlight(text: string): string;
  muted(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
  formatBox(lines: string[]): string[];
  formatDetail(depth: number, message: string, tone?: Tone): string;
  formatStatus(message: string, tone: Tone): string;
  divider(label?: string): string;
  stripAnsi(text: string): string;
}

const ASCII_SUCCESS = 'OK';

const ansiRegex = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)',
    '(?:(?:\\d{1,4})(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]',
  ].join('|'),
  'g',
);

function createPlainTheme(): CliTheme {
  const box: BoxChars = {
    topLeft: '',
    topRight: '',
    bottomLeft: '',
    bottomRight: '',
    horizontal: '',
    vertical: '',
  };
  const symbols: Symbols = {
    step: '*',
    pointer: '>',
    bullet: '-',
    success: 'OK',
    warning: '!!',
    error: 'XX',
    info: 'i',
    detailStem: '',
    spacer: ' ',
  };
  return {
    useColor: false,
    useUnicode: false,
    box,
    symbols,
    style: (_codes, text) => text,
    bold: (text) => text,
    heading: (text) => text,
    label: (text) => text,
    accent: (text) => text,
    highlight: (text) => text,
    muted: (text) => text,
    success: (text) => text,
    warning: (text) => text,
    error: (text) => text,
    formatBox(lines: string[]): string[] {
      return lines;
    },
    formatDetail(depth: number, message: string, tone: Tone = 'info'): string {
      const indent = depth > 0 ? '  '.repeat(depth) : '';
      const icon =
        tone === 'success'
          ? symbols.success
          : tone === 'warning'
          ? symbols.warning
          : tone === 'error'
          ? symbols.error
          : symbols.bullet;
      return `${indent}${icon} ${message}`;
    },
    formatStatus(message: string, tone: Tone): string {
      const prefix =
        tone === 'success'
          ? '[OK]'
          : tone === 'warning'
          ? '[WARN]'
          : tone === 'error'
          ? '[ERR]'
          : '[INFO]';
      return `${prefix} ${message}`;
    },
    divider(label?: string): string {
      if (!label) {
        return '--------------------------------------------------';
      }
      return `--- ${label} ---`;
    },
    stripAnsi(text: string): string {
      return text.replace(ansiRegex, '');
    },
  };
}

function visibleLength(theme: CliTheme, text: string): number {
  return theme.stripAnsi(text).length;
}

function shouldUseColor(stream: NodeJS.WriteStream): boolean {
  if ('NO_COLOR' in process.env) {
    return false;
  }
  if (process.env.FORCE_COLOR === '0') {
    return false;
  }
  if (process.env.FORCE_COLOR) {
    return true;
  }
  return Boolean(stream.isTTY);
}

function shouldUseUnicode(stream: NodeJS.WriteStream): boolean {
  if (process.env.FORCE_ASCII === '1') {
    return false;
  }
  if (!stream.isTTY) {
    return false;
  }
  if (process.platform === 'win32') {
    return Boolean(process.env.WT_SESSION) || Boolean(process.env.TERM_PROGRAM);
  }
  return true;
}

function createBoxChars(useUnicode: boolean): BoxChars {
  if (!useUnicode) {
    return {
      topLeft: '+',
      topRight: '+',
      bottomLeft: '+',
      bottomRight: '+',
      horizontal: '-',
      vertical: '|',
    };
  }
  return {
    topLeft: '\u256d',
    topRight: '\u256e',
    bottomLeft: '\u2570',
    bottomRight: '\u256f',
    horizontal: '\u2500',
    vertical: '\u2502',
  };
}

function createSymbols(useUnicode: boolean): Symbols {
  if (!useUnicode) {
    return {
      step: '*',
      pointer: '>',
      bullet: '-',
      success: ASCII_SUCCESS,
      warning: '!',
      error: 'x',
      info: 'i',
      detailStem: '|',
      spacer: ' ',
    };
  }
  return {
    step: '\u25c8',
    pointer: '\u203a',
    bullet: '\u2022',
    success: '\u2714',
    warning: '\u26a0',
    error: '\u2716',
    info: '\u2139',
    detailStem: '\u2502',
    spacer: '\u2219',
  };
}

function apply(
  code: string | string[],
  text: string,
  useColor: boolean,
): string {
  if (!useColor) {
    return text;
  }
  const codes = Array.isArray(code) ? code.join('') : code;
  return `${codes}${text}${ANSI.reset}`;
}

function toneColor(theme: CliTheme, tone: Tone): (text: string) => string {
  switch (tone) {
    case 'success':
      return theme.success;
    case 'warning':
      return theme.warning;
    case 'error':
      return theme.error;
    case 'info':
    default:
      return theme.muted;
  }
}

export function createCliTheme(
  stream: NodeJS.WriteStream = process.stdout,
): CliTheme {
  if (process.env.CLI_PLAIN_MODE === '1') {
    return createPlainTheme();
  }
  const useColor = shouldUseColor(stream);
  const useUnicode = shouldUseUnicode(stream);
  const boxChars = createBoxChars(useUnicode);
  const symbols = createSymbols(useUnicode);
  const theme: CliTheme = {
    useColor,
    useUnicode,
    box: boxChars,
    symbols,
    style: (codes, text) => apply(codes, text, useColor),
    bold: (text) => apply(ANSI.bold, text, useColor),
    heading: (text) => apply([ANSI.bold, ANSI.cyan], text, useColor),
    label: (text) => apply(ANSI.magenta, text, useColor),
    accent: (text) => apply(ANSI.cyan, text, useColor),
    highlight: (text) => apply(ANSI.blue, text, useColor),
    muted: (text) => apply(ANSI.gray, text, useColor),
    success: (text) => apply(ANSI.green, text, useColor),
    warning: (text) => apply(ANSI.yellow, text, useColor),
    error: (text) => apply(ANSI.red, text, useColor),
    formatBox(lines: string[]): string[] {
      if (lines.length === 0) {
        return [];
      }
      const paddingLeft = 1;
      const borderLength = 50;
      const topBorder =
        boxChars.topLeft + boxChars.horizontal.repeat(borderLength);
      const bottomBorder =
        boxChars.bottomLeft + boxChars.horizontal.repeat(borderLength);
      const padLine = (line: string): string => {
        return (
          boxChars.vertical +
          ' '.repeat(paddingLeft) +
          line
        );
      };
      return [topBorder, ...lines.map(padLine), bottomBorder];
    },
    formatDetail(depth: number, message: string, tone: Tone = 'info'): string {
      const branchPrefix =
        depth > 0 ? '  '.repeat(depth - 1) + '  ' : '';
      const icon =
        tone === 'success'
          ? symbols.success
          : tone === 'warning'
          ? symbols.warning
          : tone === 'error'
          ? symbols.error
          : symbols.bullet;
      const shouldRespectCustomColor =
        useColor && message.includes('\u001b[');
      const colorize = shouldRespectCustomColor
        ? (text: string) => text
        : toneColor(theme, tone);
      const coloredMessage = colorize(message);
      return `${symbols.detailStem} ${branchPrefix}${icon} ${coloredMessage}`;
    },
    formatStatus(message: string, tone: Tone): string {
      const icon =
        tone === 'success'
          ? symbols.success
          : tone === 'warning'
          ? symbols.warning
          : tone === 'error'
          ? symbols.error
          : symbols.info;
      const colorize = toneColor(theme, tone);
      return `${icon} ${theme.bold(colorize(message))}`;
    },
    divider(label?: string): string {
      if (!label) {
        return boxChars.horizontal.repeat(32);
      }
      const text = ` ${label} `;
      const visible = visibleLength(theme, text);
      const totalWidth = Math.max(visible + 4, 32);
      const line =
        boxChars.horizontal.repeat((totalWidth - visible) / 2) +
        text +
        boxChars.horizontal.repeat((totalWidth - visible) / 2);
      return line;
    },
    stripAnsi(text: string): string {
      return text.replace(ansiRegex, '');
    },
  };

  return theme;
}

export function formatDuration(durationMs: number): string {
  if (durationMs >= 1_000) {
    const seconds = durationMs / 1_000;
    if (seconds >= 10) {
      return `${seconds.toFixed(0)}s`;
    }
    return `${seconds.toFixed(1)}s`;
  }
  return `${Math.max(Math.round(durationMs), 1)}ms`;
}

export const defaultCliTheme = createCliTheme();

export function wrapPlainText(text: string, limit: number): string[] {
  const width = Math.max(limit, 1);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [];
  }
  const lines: string[] = [];
  let current = '';
  const pushCurrent = () => {
    if (current.trim().length > 0) {
      lines.push(current);
    }
    current = '';
  };
  for (const word of words) {
    if (word.length > width) {
      pushCurrent();
      for (let i = 0; i < word.length; i += width) {
        lines.push(word.slice(i, i + width));
      }
      continue;
    }
    if (!current) {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      pushCurrent();
      current = word;
    }
  }
  pushCurrent();
  return lines;
}
