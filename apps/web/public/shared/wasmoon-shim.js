/**
 * ESM shim around the vendored UMD wasmoon build.
 *
 * The Lua VM ships as a classic script (`/vendor/wasmoon/index.js`) because emscripten's glue is
 * not ESM; this shim exposes it as a module so the scripting package can import `wasmoon` exactly
 * the way it does on the server.
 */
const wasmoon = globalThis.wasmoon;
if (!wasmoon || !wasmoon.LuaFactory) {
  throw new Error('wasmoon failed to load — the Lua runtime script is missing from the page.');
}
export const LuaFactory = wasmoon.LuaFactory;
export const LuaEngine = wasmoon.LuaEngine;
export const decorate = wasmoon.decorate ?? null;
export default wasmoon;
