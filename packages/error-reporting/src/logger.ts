/**
 * Production-ready logger utility
 *
 * Provides structured logging with appropriate levels for production environments.
 * Replaces verbose console.log statements throughout the Ablo.
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

interface LogContext {
  [key: string]: any;
}

class Logger {
  private level: LogLevel;
  private isProduction: boolean;

  constructor() {
    this.isProduction = process.env.NODE_ENV === 'production';
    const envLevel = (process.env.NEXT_PUBLIC_LOG_LEVEL || '').toLowerCase();
    let runtimeLevel = envLevel;

    if (!runtimeLevel && typeof window !== 'undefined' && window.localStorage) {
      try {
        runtimeLevel = (window.localStorage.getItem('ablo:logLevel') || '').toLowerCase();
      } catch {
        // Access to localStorage might fail in private mode; fall back to default level
      }
    }

    const levelMap: Record<string, LogLevel> = {
      debug: LogLevel.DEBUG,
      info: LogLevel.INFO,
      warn: LogLevel.WARN,
      error: LogLevel.ERROR,
    };
    const defaultLevel = this.isProduction ? LogLevel.WARN : LogLevel.INFO;
    this.level = levelMap[runtimeLevel] ?? defaultLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.level;
  }

  private formatMessage(level: string, message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] ${level.toUpperCase()}`;

    if (context && Object.keys(context).length > 0) {
      return `${prefix}: ${message} ${JSON.stringify(context)}`;
    }

    return `${prefix}: ${message}`;
  }

  debug(message: string, context?: LogContext): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      console.log(this.formatMessage('debug', message, context));
    }
  }

  info(message: string, context?: LogContext): void {
    if (this.shouldLog(LogLevel.INFO)) {
      console.log(this.formatMessage('info', message, context));
    }
  }

  warn(message: string, context?: LogContext): void {
    if (this.shouldLog(LogLevel.WARN)) {
      console.warn(this.formatMessage('warn', message, context));
    }
  }

  error(message: string, context?: LogContext): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      console.error(this.formatMessage('error', message, context));
    }
  }

  // Specialized methods for Ablo
  syncOperation(operation: string, details?: LogContext): void {
    if (!this.isProduction) {
      this.debug(`Sync: ${operation}`, details);
    }
  }

  modelRegistry(_action: string, _modelName: string, _details?: LogContext): void {
    // ModelRegistry logs disabled for cleaner development experience
    // if (!this.isProduction) {
    //   this.debug(`ModelRegistry: ${action}`, { modelName, ...details });
    // }
  }

  bootstrap(message: string, details?: LogContext): void {
    this.info(`Bootstrap: ${message}`, details);
  }

  performance(operation: string, duration: number, details?: LogContext): void {
    // Performance logs are development-only to avoid noise in production
    if (this.isProduction) return;

    if (duration > 100) {
      // Log slow operations (>100ms) as warnings in development
      this.warn(`Performance: ${operation} took ${duration.toFixed(2)}ms`, details);
    } else {
      this.debug(`Performance: ${operation} took ${duration.toFixed(2)}ms`, details);
    }
  }

  // Specialized GraphQL performance logging with better formatting
  graphqlPerformance(
    operation: string,
    duration: number,
    details?: LogContext & { model?: string; variables?: string; ok?: boolean; error?: string }
  ): void {
    // GraphQL performance logs are development-only to avoid noise in production
    if (this.isProduction) return;

    const modelInfo = details?.model ? ` [${details.model}]` : '';
    const variableInfo = details?.variables ? ` vars:(${details.variables})` : '';
    const statusInfo = details?.ok === false ? ' FAILED' : '';
    const errorInfo = details?.error ? ` error:"${details.error}"` : '';

    const message = `GraphQL: ${operation}${modelInfo} took ${duration}ms${variableInfo}${statusInfo}${errorInfo}`;

    // Filter out internal fields from details for cleaner logs
    const cleanDetails = details
      ? {
          ...details,
          model: undefined,
          variables: undefined,
          ok: undefined,
          error: undefined,
        }
      : undefined;

    if (duration > 1000 || details?.error) {
      this.warn(message, cleanDetails);
    } else {
      this.debug(message, cleanDetails);
    }
  }

  database(action: string, details?: LogContext): void {
    if (!this.isProduction) {
      this.debug(`Database: ${action}`, details);
    }
  }
}

// Export singleton instance
export const logger = new Logger();

// Backwards compatibility exports for gradual migration
export const log = {
  debug: logger.debug.bind(logger),
  info: logger.info.bind(logger),
  warn: logger.warn.bind(logger),
  error: logger.error.bind(logger),
  sync: logger.syncOperation.bind(logger),
  model: logger.modelRegistry.bind(logger),
  bootstrap: logger.bootstrap.bind(logger),
  perf: logger.performance.bind(logger),
  gql: logger.graphqlPerformance.bind(logger),
  db: logger.database.bind(logger),
};
