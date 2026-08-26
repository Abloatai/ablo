/**
 * Transport mechanisms. Business meaning belongs to commit, claims, and
 * observation; this boundary owns only HTTP, WebSocket, and connection runtime.
 */
export * from './http/index.js';
export * from './websocket/index.js';
export * from './connection/index.js';
