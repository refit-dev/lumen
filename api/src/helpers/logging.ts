// Simple logger helper for consistent logging

/**
 * Simple logger that wraps console methods with structured format
 */
export const logger = {
  info: (message: string | object, context?: string) => {
    if (typeof message === "object" && context) {
      console.info(`[INFO] ${context}:`, message);
    } else if (typeof message === "object") {
      console.info("[INFO]", message);
    } else if (context) {
      console.info(`[INFO] ${context}: ${message}`);
    } else {
      console.info(`[INFO] ${message}`);
    }
  },
  
  warn: (message: string | object, context?: string) => {
    if (typeof message === "object" && context) {
      console.warn(`[WARN] ${context}:`, message);
    } else if (typeof message === "object") {
      console.warn("[WARN]", message);
    } else if (context) {
      console.warn(`[WARN] ${context}: ${message}`);
    } else {
      console.warn(`[WARN] ${message}`);
    }
  },
  
  error: (message: string | object, error?: unknown, context?: string) => {
    if (typeof message === "object" && error && context) {
      console.error(`[ERROR] ${context}:`, message, error);
    } else if (typeof message === "object" && context) {
      console.error(`[ERROR] ${context}:`, message);
    } else if (typeof message === "object") {
      console.error("[ERROR]", message);
    } else if (error && context) {
      console.error(`[ERROR] ${context}: ${message}`, error);
    } else if (context) {
      console.error(`[ERROR] ${context}: ${message}`);
    } else if (error) {
      console.error(`[ERROR] ${message}:`, error);
    } else {
      console.error(`[ERROR] ${message}`);
    }
  },
  
  debug: (message: string | object, context?: string) => {
    if (process.env.NODE_ENV !== "production") {
      if (typeof message === "object" && context) {
        console.debug(`[DEBUG] ${context}:`, message);
      } else if (typeof message === "object") {
        console.debug("[DEBUG]", message);
      } else if (context) {
        console.debug(`[DEBUG] ${context}: ${message}`);
      } else {
        console.debug(`[DEBUG] ${message}`);
      }
    }
  },
};