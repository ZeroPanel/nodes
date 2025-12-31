/**
 * xterm-compatible logger with ANSI color support
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'success';

interface LogColor {
  level: string;
  timestamp: string;
  message: string;
  reset: string;
}

// ANSI color codes for xterm
const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  
  // Foreground colors
  fg: {
    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
    brightRed: '\x1b[91m',
    brightGreen: '\x1b[92m',
    brightYellow: '\x1b[93m',
    brightBlue: '\x1b[94m',
    brightMagenta: '\x1b[95m',
    brightCyan: '\x1b[96m',
  },
  
  // Background colors
  bg: {
    black: '\x1b[40m',
    red: '\x1b[41m',
    green: '\x1b[42m',
    yellow: '\x1b[43m',
    blue: '\x1b[44m',
    magenta: '\x1b[45m',
    cyan: '\x1b[46m',
    white: '\x1b[47m',
  },
};

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  private formatTimestamp(): string {
    return new Date().toISOString();
  }

  private formatContext(): string {
    return `${COLORS.fg.cyan}[${this.context}]${COLORS.reset}`;
  }

  private format(level: LogLevel, message: string, data?: any): string {
    const timestamp = this.formatTimestamp();
    const context = this.formatContext();
    const levelColor = this.getLevelColor(level);
    const levelStr = `${levelColor}${level.toUpperCase().padEnd(7)}${COLORS.reset}`;

    let output = `${COLORS.dim}${timestamp}${COLORS.reset} ${levelStr} ${context} ${message}`;

    if (data !== undefined) {
      if (typeof data === 'object') {
        output += `\n${JSON.stringify(data, null, 2)}`;
      } else {
        output += ` ${data}`;
      }
    }

    return output;
  }

  private getLevelColor(level: LogLevel): string {
    switch (level) {
      case 'debug':
        return `${COLORS.fg.gray}`;
      case 'info':
        return `${COLORS.fg.brightBlue}`;
      case 'warn':
        return `${COLORS.fg.brightYellow}`;
      case 'error':
        return `${COLORS.fg.brightRed}`;
      case 'success':
        return `${COLORS.fg.brightGreen}`;
      default:
        return COLORS.reset;
    }
  }

  debug(message: string, data?: any): void {
    console.log(this.format('debug', message, data));
  }

  info(message: string, data?: any): void {
    console.log(this.format('info', message, data));
  }

  warn(message: string, data?: any): void {
    console.warn(this.format('warn', message, data));
  }

  error(message: string, data?: any): void {
    console.error(this.format('error', message, data));
  }

  success(message: string, data?: any): void {
    console.log(this.format('success', message, data));
  }

  // Specialized loggers for specific modules
  static docker(message: string, data?: any): void {
    const logger = new Logger('docker');
    logger.info(message, data);
  }

  static dockerError(message: string, error?: Error | string): void {
    const logger = new Logger('docker');
    logger.error(message, typeof error === 'string' ? error : error?.message);
  }

  static ws(context: string, message: string, data?: any): void {
    const logger = new Logger(`ws-${context}`);
    logger.info(message, data);
  }

  static wsError(context: string, message: string, error?: Error | string): void {
    const logger = new Logger(`ws-${context}`);
    logger.error(message, typeof error === 'string' ? error : error?.message);
  }

  static server(message: string, data?: any): void {
    const logger = new Logger('server');
    logger.info(message, data);
  }

  static maintenance(message: string, data?: any): void {
    const logger = new Logger('maintenance');
    logger.warn(message, data);
  }

  static health(message: string, data?: any): void {
    const logger = new Logger('health');
    logger.debug(message, data);
  }
  static error(message: string, data?: any): void {
    const logger = new Logger('general');
    logger.error(message, data);
  }
  static info(message: string, data?: any): void {
    const logger = new Logger('general');
    logger.info(message, data);
    }
    static warn(message: string, data?: any): void {
    const logger = new Logger('general');
    logger.warn(message, data);
    }
    static debug(message: string, data?: any): void {
    const logger = new Logger('general');
    logger.debug(message, data);
    }
    static success(message: string, data?: any): void {
    const logger = new Logger('general');
    logger.success(message, data);
    }
}

// Export color utilities for custom formatting
export const xtermColors = COLORS;
