/**
 * Browser entry point for @kinetiq/shared.
 *
 * The website, game client and editor import the same engine code as the server; this module
 * exposes only the parts that are safe (and available) without Node APIs. Server-only modules
 * (config file IO, scrypt, the database) are deliberately absent.
 */
export * from './src/constants.js';
export * from './src/utils.js';
export * from './src/errors.js';
export * from './src/validation.js';
export * from './src/digest.js';
export * from './src/ids.browser.js';
export * from './src/logger.browser.js';

export const PLATFORM_BROWSER_BUILD = true;
