/**
 * Kinetiq game client.
 *
 * Loads a published version's world, connects to its realm over the WebSocket protocol, renders
 * the scene with three.js, drives the local character (client prediction reconciled against
 * server snapshots) and runs the game's client scripts in their own Lua sandbox.
 *
 * Entry points:
 *   /client?game=<gameId>            — matchmaking join from the website
 *   /client?server=<realmId>&token=… — direct join (editor play-test, server list)
 *   /client?game=<id>&code=ABCD-EFGH — private server by join code
 */
import * as THREE from '/vendor/three/three.module.js';
import { buildSceneFromWorld, createCharacterObject, animateCharacter, hexToNumber } from '/shared/render.js';
import { ClientMessage, ServerMessage, encodeInput, decodeSnapshot, PROTOCOL_VERSION } from '/pkg/networking/index.js';

const params = new URLSearchParams(location.search);
const platformInfo = window.__PLATFORM__ ?? {};

const state = {
  game: null,
  release: null,
  realm: null,
  characters: new Map(),
  objects: new Map(),
  input: { moveX: 0, moveZ: 0, run: false, jump: false, yaw: 0, sequence: 0 },
  keys: new Set(),
  chatOpen: false,
  connected: false,
  ping: 0,
  fps: 0,
  snapshotTime: 0,
  serverTimeOffset: 0,
  preset: localStorage.getItem('kq.graphics') ?? 'auto',
  showDebug: false,
  scriptHost: null,
  settings: { music: 0.6, sfx: 0.8 },
  remoteHandlers: new Map(),
};

const hud = {
  root: document.getElementById('hud'),
  chatLog: document.getElementById('chat-log'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
  status: document.getElementById('status'),
  title: document.getElementById('game-title'),
  players: document.getElementById('player-count'),
  console: document.getElementById('console'),
  consoleBody: document.getElementById('console-body'),
  toasts: document.getElementById('toasts'),
};

// ---------------------------------------------------------------- renderer

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('viewport').append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1424);
scene.fog = new THREE.Fog(0x0d1424, 300, 900);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(0, 6, 12);

const sunLight = new THREE.DirectionalLight(0xffffff, 1.1);
sunLight.position.set(60, 120, 40);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(1024, 1024);
sunLight.shadow.camera.left = -120;
sunLight.shadow.camera.right = 120;
sunLight.shadow.camera.top = 120;
sunLight.shadow.camera.bottom = -120;
scene.add(sunLight);
scene.add(new THREE.HemisphereLight(0x8fd6ff, 0x1c2436, 0.7));

const PRESETS = {
  low: { shadows: false, pixelRatio: 0.75, fogNear: 150, fogFar: 500, segments: 12 },
  medium: { shadows: true, pixelRatio: 1, fogNear: 250, fogFar: 800, segments: 16 },
  high: { shadows: true, pixelRatio: 2, fogNear: 400, fogFar: 1400, segments: 24 },
};

function applyPreset(name) {
  const preset = name === 'auto' ? (window.innerWidth * window.innerHeight > 1_600_000 ? 'high' : 'medium') : name;
  const settings = PRESETS[preset] ?? PRESETS.medium;
  renderer.shadowMap.enabled = settings.shadows;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.pixelRatio));
  scene.fog.near = settings.fogNear;
  scene.fog.far = settings.fogFar;
  state.preset = name;
  localStorage.setItem('kq.graphics', name);
  const select = document.getElementById('graphics-preset');
  if (select) select.value = name;
}

applyPreset(state.preset);

// ---------------------------------------------------------------- sound

const soundGroups = { music: new THREE.AudioListener ? null : null, sfx: null, ui: null, ambient: null };
void soundGroups;
const audioListener = new THREE.AudioListener();
camera.add(audioListener);
const audioLoader = new THREE.AudioLoader();
const sound = {
  active: [],
  play(assetId, options = {}) {
    if (!assetId) return { stop() {} };
    const group = options.group ?? 'sfx';
    const volume = Number(options.volume ?? 0.7) * (state.settings[group] ?? 1);
    if (!audioLoader) return null;
    const entry = { group, assetId, volume, looped: Boolean(options.looped), pitch: Number(options.pitch ?? 1) };
    sound.active.push(entry);
    return {
      stop: () => {
        sound.active = sound.active.filter((item) => item !== entry);
      },
      entry,
    };
  },
  stop(handle) {
    handle?.stop?.();
  },
  setGroupVolume(group, volume) {
    state.settings[group] = Number(volume);
  },
};

// ---------------------------------------------------------------- helpers

function toast(message, kind = 'info', ttl = 4200) {
  const node = document.createElement('div');
  node.className = `toast toast-${kind}`;
  node.textContent = message;
  hud.toasts.append(node);
  setTimeout(() => node.remove(), ttl);
}

function logLine(message, level = 'info') {
  const line = document.createElement('div');
  line.className = `console-line console-${level}`;
  const stamp = new Date().toLocaleTimeString();
  line.textContent = `[${stamp}] ${message}`;
  hud.consoleBody.append(line);
  if (hud.consoleBody.childElementCount > 400) hud.consoleBody.firstElementChild.remove();
  if (level === 'error') hud.console.classList.add('has-errors');
}

function setStatus(text) {
  hud.status.textContent = text;
}

// ---------------------------------------------------------------- world loading

async function loadWorld(gameId, versionId = null) {
  const query = versionId ? `?version=${encodeURIComponent(versionId)}` : '';
  const release = await window.KQ.get(`/api/games/${encodeURIComponent(gameId)}/release${query}`);
  state.release = release;
  state.game = release.game;
  document.title = `${release.game.name} — ${platformInfo.name ?? 'Kinetiq'}`;
  hud.title.textContent = release.game.name;

  const built = buildSceneFromWorld(THREE, release.world, {
    onObject(instance, object) {
      if (state.objects.has(instance.id)) return;
      state.objects.set(instance.id, { instance, object });
    },
  });
  scene.add(built.root);
  state.sceneRoot = built.root;

  const lighting = built.lights.length ? null : null;
  void lighting;
  return release;
}

// ---------------------------------------------------------------- networking

let socket = null;

function connect(connectUrl) {
  return new Promise((resolve, reject) => {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${connectUrl}`);
    socket.addEventListener('open', () => {
      state.connected = true;
      setStatus('connected');
      resolve();
    });
    socket.addEventListener('error', () => reject(new Error('Could not reach the game server.')));
    socket.addEventListener('close', (event) => {
      state.connected = false;
      setStatus('disconnected');
      toast(event.code === 4004 ? 'Server is full or unavailable.' : 'Disconnected from the server.', 'warn', 8000);
    });
    socket.addEventListener('message', (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      handleFrame(frame);
    });
  });
}

function send(frame) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

function handleFrame(frame) {
  switch (frame.t) {
    case ServerMessage.WELCOME:
      state.realm = frame;
      state.serverTimeOffset = (frame.serverTime ?? 0) - Date.now() / 1000;
      hud.players.textContent = `${frame.realm?.playerCount ?? 1} / ${frame.realm?.maxPlayers ?? 0}`;
      ensureCharacter(frame.player.id, {
        position: frame.spawn?.position,
        rotationY: frame.spawn?.rotation?.y ?? 0,
        local: true,
        displayName: frame.player.displayName,
      });
      logLine(`Joined ${frame.game?.name ?? 'server'} (v${frame.game?.version ?? 1})`);
      if (Array.isArray(frame.clientScripts)) startClientScripts(frame.clientScripts);
      resolveReady();
      break;
    case ServerMessage.SPAWN:
      ensureCharacter(frame.player.id, {
        position: frame.spawn?.position,
        rotationY: frame.spawn?.rotation?.y ?? 0,
        displayName: frame.player.displayName,
        username: frame.player.username,
      });
      logLine(`${frame.player.displayName ?? frame.player.username} joined`);
      break;
    case ServerMessage.DESPAWN: {
      const entry = state.characters.get(frame.id);
      if (entry) {
        entry.object.parent?.remove(entry.object);
        state.characters.delete(frame.id);
      }
      updatePlayerCount();
      break;
    }
    case ServerMessage.SNAPSHOT:
      applySnapshot(decodeSnapshot(frame), frame);
      break;
    case ServerMessage.CHAT: {
      const node = document.createElement('div');
      node.className = 'chat-message';
      const name = document.createElement('b');
      name.textContent = `${frame.username}: `;
      node.append(name, document.createTextNode(frame.text));
      hud.chatLog.append(node);
      hud.chatLog.scrollTop = hud.chatLog.scrollHeight;
      if (hud.chatLog.childElementCount > 120) hud.chatLog.firstElementChild.remove();
      break;
    }
    case ServerMessage.REMOTE: {
      const handler = state.remoteHandlers.get(frame.n);
      if (handler) handler(frame.a ?? []);
      else state.scriptHost?.emitClientRemote?.(frame.n, frame.a ?? []);
      break;
    }
    case ServerMessage.NOTIFY:
      toast(frame.message ?? frame.body ?? '', 'info');
      break;
    case ServerMessage.LOG:
      logLine(frame.message, frame.level ?? 'info');
      break;
    case ServerMessage.OBJECT_UPDATE:
    case ServerMessage.SNAPSHOT_OBJECTS:
      applyObjectUpdates(frame.o ?? []);
      break;
    case ServerMessage.UI:
      document.dispatchEvent(new CustomEvent('kq-ui', { detail: frame }));
      break;
    case ServerMessage.PONG:
      state.ping = Math.max(0, (Date.now() / 1000 - (frame.s ?? 0)) * 1000);
      break;
    case ServerMessage.STOP:
      toast(`Server closed: ${frame.reason ?? 'shutdown'}`, 'warn', 9000);
      break;
    case ServerMessage.ERROR:
      if (frame.code === 'rate_limited') return;
      logLine(`server error: ${frame.code}`, 'warn');
      break;
    default:
      if (frame.o) applyObjectUpdates(frame.o);
      break;
  }
}

let readyResolve = null;
const readyPromise = new Promise((resolve) => {
  readyResolve = resolve;
});
function resolveReady() {
  readyResolve?.();
  readyResolve = null;
}

function updatePlayerCount() {
  if (!state.realm) return;
  hud.players.textContent = `${state.characters.size} / ${state.realm.realm?.maxPlayers ?? '?'}`;
}

function ensureCharacter(playerId, { position, rotationY = 0, local = false, displayName = '', username = '' } = {}) {
  let entry = state.characters.get(playerId);
  if (!entry) {
    const avatarState = {
      colors: null,
      accessories: [],
      scale: 1,
    };
    const object = createCharacterObject(THREE, avatarState);
    scene.add(object);
    entry = { object, position: new THREE.Vector3(), velocity: new THREE.Vector3(), target: new THREE.Vector3(), state: 'idle', local, displayName, username };
    state.characters.set(playerId, entry);
    const nameTag = makeNameTag(displayName || username || playerId);
    entry.nameTag = nameTag;
    scene.add(nameTag);
  }
  if (position) {
    entry.object.position.set(position.x, position.y, position.z);
    entry.target.set(position.x, position.y, position.z);
  }
  entry.object.rotation.y = 0;
  entry.rotationY = ((rotationY ?? 0) * Math.PI) / 180;
  if (local) state.localPlayerId = playerId;
  updatePlayerCount();
  return entry;
}

function makeNameTag(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(8,12,22,0.65)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#e8eefc';
  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text.slice(0, 18), canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  sprite.scale.set(6, 1.5, 1);
  return sprite;
}

function applySnapshot(snapshot) {
  state.snapshotTime = performance.now();
  const seen = new Set();
  for (const character of snapshot.characters) {
    seen.add(character.id);
    const entry = ensureCharacter(character.id, {});
    entry.state = character.state;
    entry.health = character.health;
    if (entry.local) {
      // Server reconciliation: snap only when we drift too far (keeps prediction smooth).
      const distance = entry.object.position.distanceTo(new THREE.Vector3(character.position.x, character.position.y, character.position.z));
      if (distance > 3.5) {
        entry.object.position.set(character.position.x, character.position.y, character.position.z);
      }
      entry.target.set(character.position.x, character.position.y, character.position.z);
    } else {
      entry.target.set(character.position.x, character.position.y, character.position.z);
      entry.velocity.set(character.velocity.x, character.velocity.y, character.velocity.z);
    }
  }
  for (const [id, entry] of state.characters) {
    if (seen.has(id)) continue;
    if (entry.local) continue;
    entry.object.parent?.remove(entry.object);
    state.characters.delete(id);
  }
  if (snapshot.objects?.length) applyObjectUpdates(snapshot.objects);
  updatePlayerCount();
}

function applyObjectUpdates(entries) {
  for (const entry of entries) {
    const id = Array.isArray(entry) ? entry[0] : entry.id;
    const position = Array.isArray(entry) ? entry[1] : entry.position;
    const rotation = Array.isArray(entry) ? entry[2] : entry.rotation;
    const known = state.objects.get(id);
    if (!known) continue;
    if (position) known.object.position.set(position[0], position[1], position[2]);
    if (rotation) known.object.rotation.set(rotation[0], rotation[1], rotation[2]);
  }
}

/** Direct world-property updates coming from server scripts through the UI channel. */
document.addEventListener('kq-ui', (event) => {
  const frame = event.detail ?? {};
  for (const update of frame.u ?? []) applyObjectUpdates([update]);
});

// ---------------------------------------------------------------- input

const GAMEPADS = { deadzone: 0.18 };

function readInput() {
  const keys = state.keys;
  let moveX = 0;
  let moveZ = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) moveZ -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) moveZ += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) moveX -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) moveX += 1;
  const run = keys.has('ShiftLeft') || keys.has('ShiftRight');

  // Gamepad support (first connected pad).
  const pad = navigator.getGamepads?.()[0];
  if (pad) {
    const [axisX = 0, axisY = 0] = pad.axes;
    if (Math.abs(axisX) > GAMEPADS.deadzone) moveX += axisX;
    if (Math.abs(axisY) > GAMEPADS.deadzone) moveZ += axisY;
    const jumpButton = pad.buttons?.[0];
    if (jumpButton?.pressed) state.input.jump = true;
    if (pad.buttons?.[6]?.pressed || pad.buttons?.[7]?.pressed) state.keys.add('ShiftLeft');
    else state.keys.delete('ShiftLeft');
  }

  state.input.moveX = Math.max(-1, Math.min(1, moveX));
  state.input.moveZ = Math.max(-1, Math.min(1, moveZ));
  state.input.run = run;
  state.input.yaw = state.cameraYaw ?? 0;
}

let pointerLocked = false;
const canvas = renderer.domElement;
canvas.addEventListener('click', () => {
  if (!state.chatOpen) canvas.requestPointerLock?.();
});
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
});
document.addEventListener('mousemove', (event) => {
  if (!pointerLocked) return;
  state.cameraYaw = (state.cameraYaw ?? 0) - event.movementX * 0.0026;
  state.cameraPitch = Math.max(-1.2, Math.min(1.0, (state.cameraPitch ?? -0.25) - event.movementY * 0.0022));
});

window.addEventListener('keydown', (event) => {
  if (event.target === hud.chatInput) return;
  state.keys.add(event.code);
  if (event.code === 'Space') state.input.jump = true;
  if (event.code === 'KeyT' || event.code === 'Enter') {
    event.preventDefault();
    openChat();
  }
  if (event.code === 'F3') {
    state.showDebug = !state.showDebug;
    hud.console.classList.toggle('hidden', !state.showDebug);
    document.getElementById('stats').classList.toggle('hidden', !state.showDebug);
  }
  if (event.code === 'Escape') closeChat();
});
window.addEventListener('keyup', (event) => state.keys.delete(event.code));

function openChat() {
  state.chatOpen = true;
  hud.chatInput.focus();
  document.exitPointerLock?.();
}
function closeChat() {
  state.chatOpen = false;
  hud.chatInput.blur();
}

hud.chatForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = hud.chatInput.value.trim();
  hud.chatInput.value = '';
  if (text) send({ t: ClientMessage.CHAT, m: text });
  closeChat();
});

hud.chatInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeChat();
  }
});

document.getElementById('graphics-preset')?.addEventListener('change', (event) => {
  applyPreset(event.target.value);
  toast(`Graphics: ${event.target.value}`);
});

document.getElementById('reset-button')?.addEventListener('click', () => {
  send({ t: ClientMessage.RESPAWN });
});

document.getElementById('leave-button')?.addEventListener('click', () => {
  location.href = `/games/${state.game?.slug ?? ''}`;
});

// ---------------------------------------------------------------- client scripts

async function startClientScripts(scripts) {
  if (!scripts?.length) return;
  try {
    const { ScriptHost } = await import('/pkg/scripting/index.js');
    const layout = {
      createUI: (className, props) => window.KQ_UI.create(className, props),
      uiRoot: window.KQ_UI.root,
    };
    const host = new ScriptHost({
      mode: 'client',
      world: state.scriptWorld,
      context: {
        logger: {
          info: (...args) => logLine(args.join(' '), 'info'),
          warn: (...args) => logLine(args.join(' '), 'warn'),
          error: (...args) => logLine(args.join(' '), 'error'),
        },
        gameId: state.game?.id,
        localPlayer: { id: state.localPlayerId, username: window.KQ.user?.username, displayName: window.KQ.user?.displayName },
        input: {
          isKeyDown: (key) => state.keys.has(key),
          getMouseDelta: () => ({ x: state.mouseDelta?.x ?? 0, y: state.mouseDelta?.y ?? 0 }),
          getMovement: () => ({ ...state.input }),
        },
        camera: {
          setPosition() {},
          setTarget() {},
          setFov(value) {
            camera.fov = Number(value);
            camera.updateProjectionMatrix();
          },
          getPosition: () => ({ x: camera.position.x, y: camera.position.y, z: camera.position.z }),
        },
        sound,
        onLog: ({ level, message }) => logLine(`[script] ${message}`, level),
        onError: ({ where, message }) => logLine(`[script] ${where}: ${message}`, 'error'),
        createRemote: (name) => makeClientRemote(name),
        getRemote: (name) => makeClientRemote(name),
        sendToServer: (name, args) => send({ t: ClientMessage.REMOTE, n: name, a: args }),
      },
    });
    state.scriptHost = host;
    await host.start();
    await host.loadAll(scripts.map((script) => ({ id: script.id, name: script.name, kind: 'client', source: script.source })));
    logLine(`started ${scripts.length} client script(s)`);
  } catch (error) {
    logLine(`client scripts failed: ${error.message}`, 'error');
  }
}

function makeClientRemote(name) {
  if (!state.clientRemotes) state.clientRemotes = new Map();
  if (state.clientRemotes.has(name)) return state.clientRemotes.get(name);
  const handlers = new Set();
  const remote = {
    name,
    fireServer(...args) {
      send({ t: ClientMessage.REMOTE, n: name, a: args });
      return true;
    },
    onClientEvent(fn) {
      handlers.add(fn);
      return { disconnect: () => handlers.delete(fn) };
    },
    __emit(args) {
      for (const handler of handlers) {
        try {
          handler(...args);
        } catch (error) {
          logLine(`remote ${name}: ${error.message}`, 'error');
        }
      }
    },
  };
  state.clientRemotes.set(name, remote);
  return remote;
}

// ---------------------------------------------------------------- UI layer (script-visible)

window.KQ_UI = (() => {
  const root = document.createElement('div');
  root.id = 'script-ui';
  root.className = 'script-ui';
  document.getElementById('viewport').append(root);
  const elements = new Map();

  function create(className, props = {}) {
    const node = document.createElement(className === 'Text' || className === 'TextLabel' ? 'div' : 'div');
    node.className = `ui-${String(className).toLowerCase()}`;
    applyProps(node, props);
    root.append(node);
    const handle = {
      __node: node,
      get name() {
        return node.dataset.name ?? '';
      },
      set name(value) {
        node.dataset.name = value;
        elements.set(value, node);
      },
      get text() {
        return node.textContent;
      },
      set text(value) {
        node.textContent = value;
      },
      get visible() {
        return !node.classList.contains('hidden');
      },
      set visible(value) {
        node.classList.toggle('hidden', !value);
      },
      setProperty(key, value) {
        if (key === 'text') node.textContent = value;
        else if (key === 'visible') node.classList.toggle('hidden', !value);
        else applyProps(node, { [key]: value });
      },
      getProperty(key) {
        return node.dataset[key];
      },
      destroy() {
        node.remove();
      },
    };
    return handle;
  }

  function applyProps(node, props) {
    if (!props) return;
    if (props.name) node.dataset.name = props.name;
    if (props.text !== undefined) node.textContent = props.text;
    if (props.textSize) node.style.fontSize = `${props.textSize}px`;
    if (props.bold) node.style.fontWeight = '700';
    if (props.textColor) node.style.color = props.textColor;
    if (props.background) node.style.background = props.background;
    if (props.backgroundTransparency !== undefined) node.style.opacity = String(1 - Number(props.backgroundTransparency));
    if (props.cornerRadius) node.style.borderRadius = `${props.cornerRadius}px`;
    if (props.position) {
      if (props.position.x !== undefined) node.style.left = typeof props.position.x === 'number' && props.position.x <= 1 ? `${props.position.x * 100}%` : `${props.position.x ?? 0}px`;
      if (props.position.y !== undefined) node.style.top = typeof props.position.y === 'number' && props.position.y <= 1 ? `${props.position.y * 100}%` : `${props.position.y ?? 0}px`;
      if (props.position.offsetX) node.style.marginLeft = `${props.position.offsetX}px`;
      if (props.position.offsetY) node.style.marginTop = `${props.position.offsetY}px`;
    }
    if (props.size) {
      if (props.size.width) node.style.width = props.size.width <= 1 ? `${props.size.width * 100}%` : `${props.size.width}px`;
      if (props.size.height) node.style.height = props.size.height <= 1 ? `${props.size.height * 100}%` : `${props.size.height}px`;
    }
  }

  return { root, create, get: (name) => elements.get(name) };
})();

// ---------------------------------------------------------------- main loop

let lastFrame = performance.now();
let frameCount = 0;
let fpsClock = performance.now();

function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  frameCount += 1;
  if (now - fpsClock > 1000) {
    state.fps = Math.round((frameCount * 1000) / (now - fpsClock));
    frameCount = 0;
    fpsClock = now;
  }

  readInput();
  if (state.connected) {
    state.input.sequence += 1;
    send({ t: ClientMessage.INPUT, i: encodeInput(state.input) });
    if (state.input.jump) state.input.jump = false;
    if (now - (state.lastPingAt ?? 0) > 2000) {
      state.lastPingAt = now;
      send({ t: ClientMessage.PING, c: Date.now() });
    }
  }

  predictLocalCharacter(dt);
  interpolateRemoteCharacters(dt);
  updateCamera(dt);
  state.scriptHost?.tick?.(dt);
  animateParticles(now / 1000);
  updateStats();

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

/** Client-side prediction so the local avatar feels responsive while the server stays authoritative. */
function predictLocalCharacter(dt) {
  const entry = state.localPlayerId ? state.characters.get(state.localPlayerId) : null;
  if (!entry) return;
  const speed = state.input.run ? 17 : 9;
  const yaw = state.cameraYaw ?? 0;
  const forward = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
  const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
  let dx = forward.x * -state.input.moveZ + right.x * state.input.moveX;
  let dz = forward.z * -state.input.moveZ + right.z * state.input.moveX;
  const magnitude = Math.hypot(dx, dz);
  if (magnitude > 1) {
    dx /= magnitude;
    dz /= magnitude;
  }
  entry.object.position.x += dx * speed * dt;
  entry.object.position.z += dz * speed * dt;
  // Gentle gravity prediction; the server corrects on the next snapshot.
  const groundY = state.groundHeightAt ? state.groundHeightAt(entry.object.position.x, entry.object.position.z) : 3;
  entry.object.position.y += (groundY - entry.object.position.y) * Math.min(1, 12 * dt);
  if (state.input.moveX || state.input.moveZ) entry.object.rotation.y = Math.atan2(-dx, -dz);
  entry.state = magnitude > 0.05 ? (state.input.run ? 'running' : 'walking') : 'idle';
  entry.animSpeed = speed * magnitude;
}

function interpolateRemoteCharacters(dt) {
  for (const [id, entry] of state.characters) {
    if (entry.local) continue;
    entry.object.position.lerp(entry.target, Math.min(1, 12 * dt));
    if (entry.velocity) {
      const speed = Math.hypot(entry.velocity.x, entry.velocity.z);
      entry.animSpeed = speed;
      if (speed > 0.2) entry.object.rotation.y = Math.atan2(-entry.velocity.x, -entry.velocity.z);
    }
    void id;
  }
  for (const entry of state.characters.values()) {
    animateCharacter(entry.object, { speed: entry.animSpeed ?? 0, time: performance.now() / 1000, state: entry.state ?? 'idle' });
    if (entry.nameTag) entry.nameTag.position.set(entry.object.position.x, entry.object.position.y + 4.2, entry.object.position.z);
  }
}

function updateCamera(dt) {
  const entry = state.localPlayerId ? state.characters.get(state.localPlayerId) : null;
  const focus = entry ? entry.object.position : new THREE.Vector3();
  const yaw = state.cameraYaw ?? 0;
  const pitch = state.cameraPitch ?? -0.25;
  const distance = 11;
  const height = 4.4;
  const target = new THREE.Vector3(
    focus.x + Math.sin(yaw) * distance * Math.cos(pitch),
    focus.y + height + Math.sin(pitch) * distance * 0.8,
    focus.z + Math.cos(yaw) * distance * Math.cos(pitch),
  );
  camera.position.lerp(target, Math.min(1, 10 * dt));
  const lookAt = new THREE.Vector3(focus.x, focus.y + 2.2, focus.z);
  camera.lookAt(lookAt);
}

function animateParticles(time) {
  for (const [, known] of state.objects) {
    const emitter = known.object.userData?.emitter;
    if (!emitter || !known.object.isPoints) continue;
    const positions = known.object.geometry.attributes.position;
    for (let i = 0; i < positions.count; i += 1) {
      const offset = i * 3;
      const phase = time * Number(emitter.speed ?? 2) + i;
      positions.array[offset] = Math.sin(phase) * 0.6;
      positions.array[offset + 1] = ((phase % 4) * 0.4) % 4;
      positions.array[offset + 2] = Math.cos(phase * 0.7) * 0.6;
    }
    positions.needsUpdate = true;
  }
}

function updateStats() {
  const stats = document.getElementById('stats');
  if (!stats || stats.classList.contains('hidden')) return;
  const info = performance.memory
    ? `${Math.round(performance.memory.usedJSHeapSize / 1048576)}MB`
    : '—';
  stats.textContent = [
    `fps ${state.fps}`,
    `ping ${Math.round(state.ping)}ms`,
    `mem ${info}`,
    `objects ${state.objects.size}`,
    `players ${state.characters.size}`,
    `scripts ${state.scriptHost ? state.scriptHost.scripts.size : 0}`,
    `preset ${state.preset}`,
  ].join('  ·  ');
}

// ---------------------------------------------------------------- boot

async function boot() {
  try {
    if (!window.KQ.user) {
      await window.KQ.session();
    }
    let connectUrl = null;
    let gameId = params.get('game');
    if (params.get('server') && params.get('token')) {
      connectUrl = `/realm/${params.get('server')}?token=${encodeURIComponent(params.get('token'))}`;
      // The realm welcome frame carries the game; load the release from the game id when known.
      if (!gameId && params.get('gameId')) gameId = params.get('gameId');
    }
    if (!gameId && !connectUrl) {
      setStatus('no game specified');
      toast('Open a game from the website or the editor.', 'warn', 9000);
      return;
    }
    if (gameId) await loadWorld(gameId, params.get('version'));
    if (!connectUrl) {
      const join = await window.KQ.join(gameId, {
        joinCode: params.get('code') ?? undefined,
        privateServerId: params.get('private') ?? undefined,
      });
      connectUrl = join.connectUrl;
      if (!state.release?.game && join.gameId) await loadWorld(join.gameId);
    }
    setStatus('connecting…');
    await connect(connectUrl);
    await Promise.race([readyPromise, new Promise((resolve) => setTimeout(resolve, 5000))]);
    setStatus('playing');
    send({ t: ClientMessage.READY });
  } catch (error) {
    setStatus('failed');
    logLine(error.message, 'error');
    toast(error.message, 'error', 10_000);
    console.error(error);
  }
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

requestAnimationFrame(frame);
boot();

export { state, scene, send };
