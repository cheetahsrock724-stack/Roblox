/**
 * The Lua runtime prelude.
 *
 * Installed into every sandbox before any creator script loads. It provides the scheduler
 * (Task.spawn / Task.wait / Task.delay), the event registry and the per-script environment
 * machinery. Creator scripts never see the raw global table: each script runs with an `_ENV`
 * whose only upvalue is the runtime table, so `os`, `io`, `require`, `load`, `debug` and friends
 * are simply not reachable.
 */
export const PRELUDE = String.raw`
local _coroutine = coroutine
local _table = table
local _sethook = debug and debug.sethook
local _load = load

-- Locals captured up front so later global hardening cannot break the runtime itself.
local _setmetatable = setmetatable
local _getmetatable = getmetatable
local _pcall = pcall
local _type = type
local _tostring = tostring
local _tonumber = tonumber
local _error = error
local _select = select
local _ipairs = ipairs
local _pairs = pairs
local _unpack = _table.unpack

-- ---------------------------------------------------------------- runtime table
local runtime = {}
__kt_runtime = runtime

-- Instruction budget: prevents runaway scripts from freezing the server or client.
local BUDGET = 3000000
local budget_left = BUDGET
local current_script = '?'
local errors = {}
local native_print = print
local native_warn = warn
local native_error = error

local pending_tasks = {}
local event_handlers = {}
local bridge_handlers = {}
local shared_modules = {}
local clock = 0

-- Host callbacks are plain Lua globals installed by the embedding host before the prelude
-- loads. Scripts cannot see them (their environment only chains to the runtime table).
local function host_log(level, line)
  if __kt_host_log then _pcall(__kt_host_log, level, line) end
end

local function host_error(where, message)
  if __kt_host_error then _pcall(__kt_host_error, where, message) end
end

function runtime.__kt_report_error(where, err)
  local message = _tostring(err)
  _table.insert(errors, { where = where, message = message })
  if #errors > 200 then _table.remove(errors, 1) end
  host_error(where, message)
end

function runtime.__kt_take_errors()
  local copy = errors
  errors = {}
  return copy
end

function runtime.__kt_clock() return clock end

-- ---------------------------------------------------------------- sandboxed stdlib
local Console = {}

function Console.print(...)
  local parts = {}
  local n = _select('#', ...)
  for i = 1, n do parts[i] = _tostring((_select(i, ...))) end
  local line = _table.concat(parts, ' ')
  host_log('info', line)
  return line
end

function Console.warn(...)
  local parts = {}
  local n = _select('#', ...)
  for i = 1, n do parts[i] = _tostring((_select(i, ...))) end
  local line = _table.concat(parts, ' ')
  host_log('warn', line)
  return line
end

function Console.error(...)
  local parts = {}
  local n = _select('#', ...)
  for i = 1, n do parts[i] = _tostring((_select(i, ...))) end
  local line = _table.concat(parts, ' ')
  host_log('error', line)
  return line
end

runtime.Console = Console
runtime.print = Console.print
runtime.warn = Console.warn
runtime.error = Console.error

-- ---------------------------------------------------------------- scheduler
function runtime.__kt_schedule(co, at, args)
  _table.insert(pending_tasks, { co = co, at = at, args = args or {} })
end

local function run_task(task)
  local results = { _coroutine.resume(task.co, _table.unpack(task.args)) }
  local ok = results[1]
  if not ok then
    runtime.__kt_report_error('task', results[2])
    return
  end
  if _coroutine.status(task.co) == 'suspended' then
    local yielded = results[2]
    local delay = 0
    if _type(yielded) == 'number' then delay = yielded end
    runtime.__kt_schedule(task.co, clock + delay)
  end
end

function runtime.__kt_tick(dt)
  clock = clock + (dt or 0)
  local ready = {}
  local remaining = {}
  for i = 1, #pending_tasks do
    local task = pending_tasks[i]
    if task.at <= clock then _table.insert(ready, task) else _table.insert(remaining, task) end
  end
  pending_tasks = remaining
  for i = 1, #ready do run_task(ready[i]) end
  runtime.__kt_fire('event:heartbeat', dt or 0)
  runtime.__kt_fire('event:update', dt or 0)
end

local Task = {}

function Task.spawn(fn, ...)
  if _type(fn) ~= 'function' then _error('Task.spawn expects a function', 2) end
  local co = _coroutine.create(fn)
  runtime.__kt_schedule(co, clock, { ... })
  return co
end

function Task.delay(seconds, fn, ...)
  if _type(fn) ~= 'function' then _error('Task.delay expects (seconds, function)', 2) end
  local args = { ... }
  local co = _coroutine.create(function()
    Task.wait(seconds)
    fn(_table.unpack(args))
  end)
  runtime.__kt_schedule(co, clock, {})
  return co
end

function Task.defer(fn, ...)
  if _type(fn) ~= 'function' then _error('Task.defer expects a function', 2) end
  local co = _coroutine.create(fn)
  runtime.__kt_schedule(co, clock + 1e-9, { ... })
  return co
end

function Task.wait(seconds)
  if _coroutine.isyieldable and not _coroutine.isyieldable() then
    _error('Task.wait must be called inside Task.spawn or Task.delay', 2)
  end
  local delay = _tonumber(seconds) or 0
  if delay < 0 then delay = 0 end
  return _coroutine.yield(delay)
end

function Task.cancel(co)
  for i = #pending_tasks, 1, -1 do
    if pending_tasks[i].co == co then _table.remove(pending_tasks, i) end
  end
end

runtime.Task = Task
runtime.wait = Task.wait

-- ---------------------------------------------------------------- events
--
-- Host values never cross into Lua directly: JS pushes opaque kqh:<n> handles and the Lua side
-- resolves them through __kt_resolve. Everything below keeps that boundary intact while giving
-- scripts ordinary table/object semantics.
local Events = {}

local function resolve(value)
  if _type(value) == 'string' and string.sub(value, 1, 4) == 'kqh:' and __kt_resolve then
    return __kt_resolve(value)
  end
  return value
end

local function resolve_all(args)
  for i = 1, #args do args[i] = resolve(args[i]) end
  return args
end

function runtime.__kt_fire(name, ...)
  local list = event_handlers[name]
  if not list then return end
  for i = 1, #list do
    local ok, err = _pcall(list[i], ...)
    if not ok then runtime.__kt_report_error('event:' .. _tostring(name), err) end
  end
end

-- Registers a wrapper function for a host event key and returns a disconnect handle.
function runtime.__kt_bridge(key, fn)
  local list = bridge_handlers[key]
  if not list then list = {}; bridge_handlers[key] = list end
  _table.insert(list, fn)
  return {
    disconnect = function()
      for i = #list, 1, -1 do
        if list[i] == fn then _table.remove(list, i) end
      end
    end,
  }
end

-- Called from JavaScript with handle ids: resolves payloads, then runs the registered wrappers.
function runtime.__kt_bridge_emit(key, ...)
  local args = resolve_all({ ... })
  local list = bridge_handlers[key]
  if not list then return end
  local snapshot = {}
  for i = 1, #list do snapshot[i] = list[i] end
  for i = 1, #snapshot do
    local ok, err = _pcall(snapshot[i], _table.unpack(args))
    if not ok then runtime.__kt_report_error('event:' .. _tostring(key), err) end
  end
end

-- A user-facing signal (Players.playerJoined, Players.playerLeft, ...).
function runtime.__kt_signal(key)
  local signal = {}
  function signal:Connect(fn)
    if _type(fn) ~= 'function' then _error('Connect expects a function', 2) end
    return runtime.__kt_bridge(key, function(...) fn(_table.unpack(resolve_all({ ... }))) end)
  end
  function signal:Once(fn)
    local handle
    handle = signal:Connect(function(...)
      handle.disconnect()
      fn(...)
    end)
    return handle
  end
  function signal:Wait()
    local waiting = true
    local args
    signal:Connect(function(...)
      args = { ... }
      waiting = false
    end)
    while waiting do Task.wait(0.05) end
    return _table.unpack(args or {})
  end
  signal.connect = signal.Connect
  signal.once = signal.Once
  return signal
end

local remote_cache = {}

-- Remote events and functions (Remote.get("Score")).
function runtime.__kt_remote(name)
  local cached = remote_cache[name]
  if cached then return cached end
  local remote = { name = name }
  function remote:fireClient(playerId, ...)
    return __kt_remote_send(name, _tostring(playerId), { ... })
  end
  function remote:fireAllClients(...)
    return __kt_remote_send(name, '*', { ... })
  end
  function remote:fireServer(...)
    return __kt_remote_send(name, 'server', { ... })
  end
  function remote:onClientEvent(fn)
    return runtime.__kt_bridge('remote:' .. name .. ':client', function(...) fn(_table.unpack(resolve_all({ ... }))) end)
  end
  function remote:onServerEvent(fn)
    return runtime.__kt_bridge('remote:' .. name .. ':server', function(...) fn(_table.unpack(resolve_all({ ... }))) end)
  end
  remote_cache[name] = remote
  return remote
end

function Events.on(name, fn)
  if _type(name) ~= 'string' then _error('Events.on expects (string, function)', 2) end
  if _type(fn) ~= 'function' then _error('Events.on expects (string, function)', 2) end
  return runtime.__kt_bridge('event:' .. name, function(...) fn(_table.unpack(resolve_all({ ... }))) end)
end

function Events.once(name, fn)
  local handle
  handle = Events.on(name, function(...)
    handle.disconnect()
    fn(...)
  end)
  return handle
end

function Events.fire(name, ...)
  runtime.__kt_fire('event:' .. name, ...)
end

-- Object events: Events.onInstance(part, "touched", fn).
function Events.onInstance(instance, eventName, fn)
  if instance == nil or instance.id == nil then _error('Events.onInstance expects an instance', 2) end
  local id = instance.id
  local event = _tostring(eventName)
  if __kt_watch then __kt_watch(id, event) end
  return runtime.__kt_bridge('inst:' .. id .. ':' .. event, function(...) fn(_table.unpack(resolve_all({ ... }))) end)
end

runtime.Events = Events
runtime.on = Events.on

-- ---------------------------------------------------------------- shared modules
function runtime.__kt_define(name, fn)
  shared_modules[name] = fn
end

local function moduleResolver(moduleName)
  local mod = shared_modules[moduleName]
  if not mod then _error('Unknown module: ' .. _tostring(moduleName), 2) end
  if _type(mod) == 'function' then
    local result = mod()
    shared_modules[moduleName] = result
    return result
  end
  return mod
end

runtime.import = moduleResolver

-- ---------------------------------------------------------------- signal wrapper
-- Wraps an engine signal for Lua scripts: signal:Connect(fn), signal:Once(fn), signal:Wait()
local function wrap_signal(signal)
  return {
    Connect = function(_, fn) return signal.connect(fn) end,
    Once = function(_, fn) return signal.once(fn) end,
    Disconnect = function(_, handle) if handle and handle.disconnect then handle.disconnect() end end,
    Wait = function(_) return signal.wait(5) end,
  }
end

runtime.__kt_wrap_signal = wrap_signal

-- ---------------------------------------------------------------- load & execute
-- Entry points return a single string so the host can read the outcome reliably.
local function assign_budget(script_name)
  if not _sethook then return end
  budget_left = BUDGET
  _sethook(function()
    budget_left = budget_left - 1000
    if budget_left <= 0 then
      _error('Script exceeded its instruction budget: ' .. _tostring(script_name), 0)
    end
  end, '', 1000)
end

local function clear_budget()
  if _sethook then _sethook() end
end

function runtime.__kt_load(script_name, source)
  local env = _setmetatable({}, { __index = runtime })
  local chunk, loadErr = _load(source, '@' .. _tostring(script_name), 't', env)
  if not chunk then
    runtime.__kt_report_error(script_name, loadErr)
    return 'err:' .. _tostring(loadErr)
  end
  current_script = script_name
  assign_budget(script_name)
  local ok, callErr = _pcall(chunk)
  clear_budget()
  current_script = '?'
  if not ok then
    runtime.__kt_report_error(script_name, callErr)
    return 'err:' .. _tostring(callErr)
  end
  return 'ok'
end

function runtime.__kt_run_module(name, source)
  local env = _setmetatable({}, { __index = runtime })
  local chunk, loadErr = _load(source, '@module:' .. _tostring(name), 't', env)
  if not chunk then
    return 'err:' .. _tostring(loadErr)
  end
  assign_budget('module:' .. name)
  local ok, result = _pcall(chunk)
  clear_budget()
  if not ok then
    runtime.__kt_report_error('module:' .. name, result)
    return 'err:' .. _tostring(result)
  end
  shared_modules[name] = result
  return 'ok'
end

function runtime.__kt_tick_guarded(dt)
  assign_budget('tick')
  local ok, err = _pcall(runtime.__kt_tick, dt)
  clear_budget()
  if not ok then runtime.__kt_report_error('tick', err) end
  return ok
end
`;

/**
 * Sanitised standard-library tables handed to scripts. They are the genuine Lua libraries
 * (so string.format, table.sort, math.floor behave exactly as documented) minus anything that
 * can touch the host.
 */
export const LIBRARY_EXPORTS = String.raw`
local runtime = __kt_runtime
runtime.table = table
runtime.string = string
runtime.math = math
runtime.utf8 = utf8
runtime.assert = assert
runtime.error = error
runtime.ipairs = ipairs
runtime.pairs = pairs
runtime.next = next
runtime.pcall = pcall
runtime.xpcall = xpcall
runtime.select = select
runtime.tostring = tostring
runtime.tonumber = tonumber
runtime.type = type
runtime.unpack = table.unpack or unpack
runtime.VERSION = _VERSION
`;

/**
 * Removes every global that could reach the host. Scripts cannot see these anyway (their `_ENV`
 * only chains to the runtime table), but scripts that somehow obtain `load`/`debug` must not find
 * anything useful there.
 */
export const HARDENING = String.raw`
do
  local dangerous = {
    'os', 'io', 'require', 'package', 'dofile', 'loadfile', 'load', 'loadstring',
    'collectgarbage', 'debug', 'newproxy', 'rawset', 'rawget', 'rawequal', 'rawlen',
    'setmetatable', 'getmetatable', 'print', 'warn', 'io_write',
  }
  for _, name in ipairs(dangerous) do
    if _G[name] ~= nil then
      _G[name] = nil
    end
  end
  -- The raw global table and the registry stay out of reach as well.
  _G = nil
end
`;
