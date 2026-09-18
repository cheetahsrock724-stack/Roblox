/**
 * Kinetiq creator editor.
 *
 * A real 3D editing surface over the same engine the server runs: the project is loaded from the
 * creator API, deserialized into a live `World`, rendered with three.js, and every edit is written
 * straight back into engine instances. Saving creates a new immutable draft version; publishing
 * makes it the live release; Play test boots an actual realm and connects the real client to it.
 */
import * as THREE from 'three';
import {
  World,
  Vector3,
  CLASS_DEFS,
  classCatalog,
  propertyCatalog,
  defaultProps,
  worldFromProject,
  projectFromWorld,
  serializeWorld,
  projectStats,
  validateBundle,
} from '@kinetiq/engine';
import { buildSceneFromWorld, createCharacterObject, animateCharacter, hexToNumber } from '/shared/render.js';

const KQ = window.KQ;
const h = window.h;
const params = new URLSearchParams(location.search);

const state = {
  projectId: params.get('project'),
  doc: null,
  world: null,
  scene: null,
  selection: [],
  primary: null,
  tool: 'move',
  leftPanel: 'explorer',
  bottomPanel: 'output',
  activeScriptId: null,
  undo: [],
  redo: [],
  clipboard: null,
  grid: 1,
  snap: true,
  logs: [],
  classes: [],
  classMap: new Map(),
  propsCache: new Map(),
  assets: [],
  running: null,
  pointer: null,
  filter: '',
  saving: false,
  dirty: false,
  stats: { fps: 0, objects: 0 },
};

// ------------------------------------------------------------------ dom refs

const dom = {
  toolbar: document.getElementById('toolbar'),
  leftTabs: document.getElementById('left-tabs'),
  leftBody: document.getElementById('left-body'),
  rightTabs: document.getElementById('right-tabs'),
  rightBody: document.getElementById('right-body'),
  bottomTabs: document.getElementById('bottom-tabs'),
  bottomBody: document.getElementById('bottom-body'),
  viewport: document.getElementById('viewport'),
  overlay: document.getElementById('viewport-overlay'),
  playbar: document.getElementById('playbar'),
  toasts: document.getElementById('toasts'),
};

function toast(message, kind = 'info') {
  const node = h('div', { class: `toast toast-${kind}` }, message);
  dom.toasts.append(node);
  setTimeout(() => node.remove(), 5000);
}

function log(message, level = 'info') {
  const entry = { at: new Date().toLocaleTimeString(), level, message: String(message) };
  state.logs.push(entry);
  if (state.logs.length > 600) state.logs.shift();
  if (state.bottomPanel === 'output') renderOutput();
}

// ------------------------------------------------------------------ three scene

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
dom.viewport.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0f1c);
const editorCamera = new THREE.PerspectiveCamera(65, 1, 0.1, 4000);
const cameraState = { target: new THREE.Vector3(0, 6, 0), distance: 90, yaw: Math.PI * 0.25, pitch: 0.55 };
const sunLight = new THREE.DirectionalLight(0xffffff, 1.05);
sunLight.position.set(60, 120, 40);
scene.add(sunLight);
scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x1a2133, 0.75));

const grid = new THREE.GridHelper(512, 128, 0x2b3a5f, 0x1a2337);
grid.position.y = 0.01;
scene.add(grid);

const selectionBox = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(), new THREE.Vector3()), 0x00e5c0);
selectionBox.visible = false;
scene.add(selectionBox);

const worldGroup = new THREE.Group();
scene.add(worldGroup);

function resizeRenderer() {
  const width = dom.viewport.clientWidth || window.innerWidth;
  const height = dom.viewport.clientHeight || window.innerHeight;
  renderer.setSize(width, height, false);
  editorCamera.aspect = width / Math.max(height, 1);
  editorCamera.updateProjectionMatrix();
}
window.addEventListener('resize', resizeRenderer);

function updateCamera() {
  const { target, distance, yaw, pitch } = cameraState;
  editorCamera.position.set(
    target.x + distance * Math.cos(pitch) * Math.sin(yaw),
    target.y + distance * Math.sin(pitch),
    target.z + distance * Math.cos(pitch) * Math.cos(yaw),
  );
  editorCamera.lookAt(target);
}
updateCamera();

// ------------------------------------------------------------------ world loading + rendering

function loadWorld(projectDoc) {
  const world = worldFromProject(projectDoc);
  world.ensureServices();
  state.world = world;
  return world;
}

function refreshScene() {
  for (const child of [...worldGroup.children]) worldGroup.remove(child);
  const info = buildSceneFromWorld(THREE, serializeWorld(state.world, { includeChunks: false }), {
    onObject: (instance, object) => {
      if (instance.className === 'SpawnPoint') object.userData.spawn = true;
    },
  });
  info.root.traverse((object) => {
    if (object.isMesh) object.userData.selectable = true;
  });
  worldGroup.add(info.root);
  state.scene = info;
  state.stats.objects = state.world.instances.size;
  updateSelectionBox();
}

function refreshTransforms() {
  // Cheap path for a live edit: push instance transforms into their three objects.
  for (const [id, object] of state.scene?.objects ?? []) {
    const instance = state.world.get(id);
    if (!instance) continue;
    const position = instance.getPosition?.() ?? instance.getProperty('position');
    if (position) object.position.set(position.x, position.y, position.z);
    const rotation = instance.getProperty('rotation');
    if (rotation) object.rotation.set(rotation.x ?? 0, rotation.y ?? 0, rotation.z ?? 0);
    const size = instance.getProperty('size');
    if (size && object.userData.size) {
      object.scale.set(
        size.x / (object.userData.size.x || 1),
        size.y / (object.userData.size.y || 1),
        size.z / (object.userData.size.z || 1),
      );
    }
  }
  updateSelectionBox();
}

function updateSelectionBox() {
  const instance = state.primary;
  if (!instance || typeof instance.getBounds !== 'function') {
    selectionBox.visible = false;
    return;
  }
  try {
    const bounds = instance.getBounds();
    selectionBox.box.set(
      new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
      new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
    );
    selectionBox.visible = true;
  } catch {
    selectionBox.visible = false;
  }
}

// ------------------------------------------------------------------ undo / redo

function snapshot() {
  if (!state.world) return;
  state.undo.push(JSON.stringify(serializeWorld(state.world, { includeChunks: false })));
  if (state.undo.length > 60) state.undo.shift();
  state.redo = [];
  markDirty();
}

function restore(json) {
  const scene = JSON.parse(json);
  state.world = worldFromProject({ world: scene });
  state.selection = [];
  state.primary = null;
  refreshScene();
  renderAll();
}

function undo() {
  const last = state.undo.pop();
  if (!last) return toast('Nothing to undo.', 'warn');
  state.redo.push(JSON.stringify(serializeWorld(state.world, { includeChunks: false })));
  restore(last);
}

function redo() {
  const next = state.redo.pop();
  if (!next) return toast('Nothing to redo.', 'warn');
  state.undo.push(JSON.stringify(serializeWorld(state.world, { includeChunks: false })));
  restore(next);
}

function markDirty() {
  state.dirty = true;
  renderToolbar();
}

// ------------------------------------------------------------------ selection + editing

function select(instances, { mode = 'replace' } = {}) {
  const list = Array.isArray(instances) ? instances : [instances];
  if (mode === 'toggle') {
    for (const instance of list) {
      const index = state.selection.indexOf(instance);
      if (index >= 0) state.selection.splice(index, 1);
      else state.selection.push(instance);
    }
  } else {
    state.selection = list.filter(Boolean);
  }
  state.primary = state.selection[state.selection.length - 1] ?? null;
  updateSelectionBox();
  renderTree();
  renderProperties();
}

function selectionInstances() {
  return state.selection.filter(Boolean);
}

function applyToSelection(fn, { label = 'edit' } = {}) {
  const items = selectionInstances();
  if (!items.length) return;
  snapshot();
  for (const instance of items) fn(instance);
  refreshTransforms();
  renderProperties();
  renderTree();
  log(`${label} applied to ${items.length} object(s).`);
}

function moveSelection(delta, { quiet = false } = {}) {
  const items = selectionInstances();
  if (!items.length) return;
  const snapped = state.snap
    ? { x: Math.round(delta.x / state.grid) * state.grid, y: Math.round(delta.y / state.grid) * state.grid, z: Math.round(delta.z / state.grid) * state.grid }
    : delta;
  if (!quiet) snapshot();
  for (const instance of items) {
    const position = instance.getPosition?.() ?? new Vector3(0, 0, 0);
    instance.setProperty('position', new Vector3(position.x + snapped.x, position.y + snapped.y, position.z + snapped.z));
    if (typeof instance.syncPhysicsBody === 'function') instance.syncPhysicsBody();
  }
  refreshTransforms();
  renderProperties();
}

function rotateSelection(deltaY, deltaX = 0, { quiet = false } = {}) {
  const items = selectionInstances();
  if (!items.length) return;
  if (!quiet) snapshot();
  for (const instance of items) {
    const rotation = instance.getProperty('rotation') ?? { x: 0, y: 0, z: 0 };
    const step = state.snap ? Math.PI / 12 : 1;
    const y = state.snap ? Math.round((rotation.y + deltaY) / step) * step : rotation.y + deltaY;
    const x = state.snap ? Math.round((rotation.x + deltaX) / step) * step : rotation.x + deltaX;
    instance.setProperty('rotation', new Vector3(x, y, rotation.z ?? 0));
  }
  refreshTransforms();
  renderProperties();
}

function scaleSelection(factor, { quiet = false } = {}) {
  const items = selectionInstances();
  if (!items.length) return;
  if (!quiet) snapshot();
  for (const instance of items) {
    const size = instance.getProperty('size');
    if (!size) continue;
    const next = new Vector3(
      Math.max(0.1, size.x * factor),
      Math.max(0.1, size.y * factor),
      Math.max(0.1, size.z * factor),
    );
    instance.setProperty('size', next);
    if (typeof instance.syncPhysicsBody === 'function') instance.syncPhysicsBody();
  }
  refreshScene();
  refreshTransforms();
  renderProperties();
}

function deleteSelection() {
  const items = selectionInstances();
  if (!items.length) return;
  snapshot();
  for (const instance of items) instance.destroy();
  state.selection = [];
  state.primary = null;
  refreshScene();
  renderAll();
  log(`Deleted ${items.length} object(s).`);
}

function duplicateSelection() {
  const items = selectionInstances();
  if (!items.length) return;
  snapshot();
  const copies = [];
  for (const instance of items) {
    const clone = instance.clone();
    const position = clone.getPosition?.() ?? new Vector3(0, 0, 0);
    clone.setProperty('position', new Vector3(position.x + state.grid * 2, position.y, position.z));
    clone.setParent(instance.parent ?? state.world.root);
    state.world.registerTree(clone);
    copies.push(clone);
  }
  refreshScene();
  select(copies);
  log(`Duplicated ${copies.length} object(s).`);
}

function copySelection() {
  const items = selectionInstances();
  if (!items.length) return;
  state.clipboard = items.map((instance) => serializeWorld({ ...state.world, root: { children: [instance] } }, { includeChunks: false }));
  toast(`Copied ${items.length} object(s).`);
}

function pasteClipboard() {
  if (!state.clipboard?.length) return toast('Clipboard is empty.', 'warn');
  snapshot();
  const created = [];
  for (const scene of state.clipboard) {
    const [root] = scene.root?.children ?? [];
    if (!root) continue;
    const instance = state.world.get(root.id);
    void instance;
    const copy = deserializeOne(root);
    if (copy) created.push(copy);
  }
  refreshScene();
  select(created);
}

function deserializeOne(json) {
  try {
    const temp = worldFromProject({ world: { format: 'kinetiq.scene', version: 1, root: { children: [json] } } });
    const [instance] = temp.root.children ?? [];
    if (!instance) return null;
    const parent = state.primary?.parent ?? state.world.root;
    instance.setParent(parent);
    state.world.registerTree(instance);
    return instance;
  } catch (error) {
    log(`Paste failed: ${error.message}`, 'error');
    return null;
  }
}

function groupSelection() {
  const items = selectionInstances();
  if (items.length < 2) return toast('Select two or more objects to group.', 'warn');
  snapshot();
  const parent = items[0].parent ?? state.world.root;
  const model = state.world.create('Model', { name: 'Model' }, parent);
  for (const instance of items) instance.setParent(model);
  refreshScene();
  select([model]);
}

function ungroupSelection() {
  const items = selectionInstances().filter((instance) => instance.className === 'Model' || instance.className === 'Folder');
  if (!items.length) return toast('Select a model or folder to ungroup.', 'warn');
  snapshot();
  const freed = [];
  for (const group of items) {
    for (const child of group.children ?? []) {
      child.setParent(group.parent ?? state.world.root);
      freed.push(child);
    }
    group.destroy();
  }
  refreshScene();
  select(freed);
}

function insertClass(className, extra = {}) {
  const position = new Vector3(cameraState.target.x, Math.max(0.5, cameraState.target.y - 2), cameraState.target.z);
  const props = { ...defaultProps(className), name: `${className}${state.world.findByClass(className).length + 1}`, position, ...extra };
  if (['Part', 'Mesh'].includes(className)) {
    props.size = { x: 4, y: 4, z: 4 };
    props.anchored = false;
  }
  const parent = state.primary && ['Folder', 'Model', 'ServerScripts', 'ClientScripts', 'SharedStorage'].includes(state.primary.className)
    ? state.primary
    : null;
  snapshot();
  const instance = state.world.create(className, props, parent);
  refreshScene();
  select([instance]);
  log(`Inserted ${className}.`);
  return instance;
}

function newScript(kind = 'server') {
  const folderName = kind === 'client' ? 'ClientScripts' : kind === 'module' ? 'SharedStorage' : 'ServerScripts';
  const folder = state.world.root.findFirstChild(folderName) ?? state.world.create('Folder', { name: folderName }, state.world.root);
  snapshot();
  const script = state.world.create('Script', {
    name: `Script${folder.children.length + 1}`,
    kind,
    source: kind === 'client'
      ? 'print("client script ready")\n'
      : kind === 'module'
        ? 'local module = {}\n\nfunction module.ping()\n  return "pong"\nend\n\nreturn module\n'
        : 'print("server script ready")\n',
    runOnLoad: true,
    parent: folder,
  });
  refreshScene();
  renderAll();
  state.activeScriptId = script.id;
  renderBottom();
  return script;
}

function scriptsList() {
  return state.world.findByClass('Script').sort((a, b) => a.getFullName().localeCompare(b.getFullName()));
}

// ------------------------------------------------------------------ toolbar

function toolButton(label, tool, title) {
  return h('button', {
    class: `tool${state.tool === tool ? ' active' : ''}`,
    title: title ?? label,
    onclick: () => {
      state.tool = tool;
      state.running = null;
      renderToolbar();
    },
  }, label);
}

function actionButton(label, onClick, title) {
  return h('button', { class: 'tool', title: title ?? label, onclick: onClick }, label);
}

function renderToolbar() {
  dom.toolbar.innerHTML = '';
  dom.toolbar.append(
    h('button', { class: 'tool active', onclick: () => saveProject('draft') }, state.dirty ? '💾 Save •' : '💾 Save'),
    h('button', { class: 'tool', onclick: () => openPublish() }, '🚀 Publish'),
    h('span', { class: 'spacer' }),
    toolButton('Select', 'select', 'Select (1)'),
    toolButton('Move', 'move', 'Move (2)'),
    toolButton('Rotate', 'rotate', 'Rotate (3)'),
    toolButton('Scale', 'scale', 'Scale (4)'),
    actionButton('Duplicate', duplicateSelection, 'Duplicate (Ctrl+D)'),
    actionButton('Delete', deleteSelection, 'Delete (Del)'),
    actionButton('Group', groupSelection, 'Group (Ctrl+G)'),
    actionButton('Ungroup', ungroupSelection, 'Ungroup (Ctrl+Shift+G)'),
    actionButton('Anchor', () => applyToSelection((instance) => instance.setProperty('anchored', !(instance.getProperty('anchored') ?? true)), { label: 'Anchor toggle' }), 'Toggle anchored'),
    actionButton('Collide', () => applyToSelection((instance) => instance.setProperty('canCollide', !(instance.getProperty('canCollide') ?? true)), { label: 'Collision toggle' })),
    actionButton('Material', () => {
      const material = prompt('Material (plastic, neon, glass, wood, metal, grass, ice, energy…)', 'plastic');
      if (!material) return;
      applyToSelection((instance) => instance.setProperty('material', material), { label: `Material ${material}` });
    }),
    actionButton('Color', () => {
      const color = prompt('Colour hex', '#3d5afe');
      if (!color) return;
      applyToSelection((instance) => instance.setProperty('color', color), { label: `Colour ${color}` });
    }),
    actionButton('Insert ▾', () => openInsertMenu()),
    actionButton('Grid', () => {
      state.snap = !state.snap;
      toast(`Grid snap ${state.snap ? 'on' : 'off'}`);
      renderToolbar();
    }),
    actionButton('Undo', undo, 'Undo (Ctrl+Z)'),
    actionButton('Redo', redo, 'Redo (Ctrl+Shift+Z)'),
    actionButton('Copy', copySelection, 'Copy (Ctrl+C)'),
    actionButton('Paste', pasteClipboard, 'Paste (Ctrl+V)'),
    h('span', { class: 'spacer' }),
    h('span', { class: 'badge' }, `${state.stats.fps} fps`),
    h('span', { class: 'badge' }, `${state.stats.objects} objects`),
    h('span', { class: 'badge dot' }, state.doc?.game?.name ?? 'no project'),
  );
}

function openInsertMenu() {
  const name = prompt(`Insert class (${state.classes.slice(0, 14).join(', ')} …)`, 'Part');
  if (!name) return;
  const match = state.classes.find((value) => value.toLowerCase() === name.toLowerCase());
  if (!match) return toast(`Unknown class "${name}".`, 'error');
  insertClass(match);
}

// ------------------------------------------------------------------ explorer

function renderTree() {
  if (state.leftPanel !== 'explorer') return;
  dom.leftBody.innerHTML = '';
  dom.leftBody.append(
    h('input', {
      type: 'search',
      placeholder: 'Filter the tree…',
      value: state.filter,
      style: { width: '100%', marginBottom: '8px' },
      oninput: (event) => {
        state.filter = event.target.value;
        renderTree();
      },
    }),
  );
  const host = h('div', {});
  host.append(treeRow(state.world.root, true));
  dom.leftBody.append(host);
}

function treeRow(instance, isRoot = false) {
  const node = h('div', {});
  const name = instance.getName?.() ?? instance.name;
  const matches = !state.filter || instance.getFullName?.().toLowerCase().includes(state.filter.toLowerCase());
  const row = h('div', { class: 'tree-row' },
    h('span', {
      class: `tree-node${state.selection.includes(instance) ? ' selected' : ''}`,
      draggable: !isRoot,
      onclick: (event) => select([instance], { mode: event.shiftKey ? 'toggle' : 'replace' }),
      ondblclick: () => renameInstance(instance),
      ondragstart: (event) => event.dataTransfer.setData('text/plain', instance.id),
      ondragover: (event) => {
        event.preventDefault();
        event.currentTarget.classList.add('drop-target');
      },
      ondragleave: (event) => event.currentTarget.classList.remove('drop-target'),
      ondrop: (event) => {
        event.preventDefault();
        event.currentTarget.classList.remove('drop-target');
        const dragged = state.world.get(event.dataTransfer.getData('text/plain'));
        if (!dragged || dragged === instance) return;
        if (dragged.getDescendants?.().includes(instance)) return toast('Cannot parent an object into itself.', 'error');
        snapshot();
        dragged.setParent(instance);
        refreshScene();
        renderAll();
        log(`Reparented ${dragged.getName()} → ${instance.getName()}.`);
      },
    }, `${isRoot ? '🌍' : iconFor(instance)} ${name}`),
    h('span', { class: 'kind' }, instance.className),
  );
  node.append(row);
  const children = [...(instance.children ?? [])].filter((child) => child.className !== 'Script' || !state.filter);
  if (children.length && (matches || isRoot)) {
    const container = h('div', { class: 'tree-children' });
    for (const child of children) {
      if (state.filter && !child.getFullName().toLowerCase().includes(state.filter.toLowerCase()) && !child.children?.some((grand) => grand.getFullName().toLowerCase().includes(state.filter.toLowerCase()))) {
        if (!['ServerScripts', 'ClientScripts', 'SharedStorage'].includes(child.className)) continue;
      }
      container.append(treeRow(child));
    }
    node.append(container);
  }
  return node;
}

function iconFor(instance) {
  const map = {
    Part: '🧱', Mesh: '🔺', Model: '📦', Folder: '📁', Script: '📜', SpawnPoint: '🚩', Light: '💡',
    Sound: '🔊', Camera: '🎥', ParticleEmitter: '✨', VehicleSeat: '🪑', Interactable: '🔘', NPC: '🧍',
    Text: '🅣', Image: '🖼', UIElement: '▭', Players: '👥', Lighting: '🌤', SharedStorage: '🗄',
    ServerScripts: '⚙️', ClientScripts: '🧩', UI: '🖼', Audio: '🎵', Assets: '📚', World: '🌍', Terrain: '⛰',
  };
  return map[instance.className] ?? '▪';
}

function renameInstance(instance) {
  const next = prompt('New name', instance.getName());
  if (!next) return;
  snapshot();
  instance.setName(next);
  if (instance.className === 'Script') instance.setProperty('name', next.endsWith('.lua') ? next.slice(0, -4) : next);
  renderTree();
  renderProperties();
  renderBottom();
}

// ------------------------------------------------------------------ properties

async function loadClassCatalog() {
  const data = await KQ.get('/api/engine/classes');
  state.classes = (data.classes ?? []).map((entry) => entry.className ?? entry.name ?? entry);
  state.classMap = new Map((data.classes ?? []).map((entry) => [entry.className ?? entry.name, entry]));
}

function classEntry(className) {
  return state.classMap.get(className) ?? { className, properties: [] };
}

function propertyList(className) {
  const cached = state.propsCache.get(className);
  if (cached) return cached;
  const list = propertyCatalog(className) ?? [];
  state.propsCache.set(className, list);
  return list;
}

function renderProperties() {
  if (state.leftPanel === 'properties' || state.bottomPanel === 'properties') {
    /* properties lives on the right; nothing to do for the left panel */
  }
  dom.rightBody.innerHTML = '';
  const instance = state.primary;
  if (!instance) {
    dom.rightBody.append(h('div', { class: 'empty' }, 'Select an object in the viewport or the explorer to edit its properties.'));
    return;
  }
  const meta = h('div', {},
    h('div', { style: { fontWeight: '650' } }, instance.getFullName()),
    h('div', { class: 'empty' }, `${instance.className} · ${instance.id}`),
  );
  dom.rightBody.append(meta);

  const groups = new Map();
  for (const spec of propertyList(instance.className)) {
    const key = spec.group ?? 'Properties';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(spec);
  }
  for (const [group, specs] of groups) {
    dom.rightBody.append(h('div', { class: 'prop-group' }, group));
    for (const spec of specs) {
      try {
        dom.rightBody.append(propertyRow(instance, spec));
      } catch (error) {
        log(`Inspector error for ${instance.className}.${spec.name}: ${error.message}`, 'error');
      }
    }
  }

  if (instance.className === 'Script') dom.rightBody.append(scriptProperties(instance));
  dom.rightBody.append(h('div', { class: 'prop-group' }, 'Actions'));
  dom.rightBody.append(h('div', { class: 'script-tabs' },
    h('button', { class: 'tool', onclick: () => renameInstance(instance) }, 'Rename'),
    h('button', { class: 'tool', onclick: duplicateSelection }, 'Duplicate'),
    h('button', { class: 'tool', onclick: () => applyToSelection((item) => item.setParent(state.world.root), { label: 'Move to world' }) }, 'Unparent'),
    h('button', { class: 'tool', onclick: deleteSelection }, 'Delete'),
  ));
}

function propertyRow(instance, spec) {
  const value = instance.getProperty(spec.name);
  const label = h('label', { title: spec.description ?? spec.name }, spec.name);
  const apply = (next) => {
    snapshot();
    instance.setProperty(spec.name, next);
    if (['position', 'size', 'rotation', 'anchored', 'canCollide'].includes(spec.name)) {
      if (typeof instance.syncPhysicsBody === 'function') instance.syncPhysicsBody();
      refreshTransforms();
    }
    renderTree();
  };
  if (spec.type === 'boolean') {
    return h('div', { class: 'prop-row' }, label, h('input', {
      type: 'checkbox', checked: Boolean(value), onchange: (event) => apply(event.target.checked),
    }));
  }
  if (spec.type === 'vector3') {
    const current = value ?? { x: 0, y: 0, z: 0 };
    const inputs = ['x', 'y', 'z'].map((axis) => h('input', {
      type: 'number', step: '0.25', value: Number(current[axis] ?? 0).toFixed(2),
      onchange: (event) => {
        const next = { x: Number(current.x ?? 0), y: Number(current.y ?? 0), z: Number(current.z ?? 0) };
        next[axis] = Number(event.target.value);
        apply(new Vector3(next.x, next.y, next.z));
      },
    }));
    return h('div', { class: 'prop-row' }, label, h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px' } }, ...inputs));
  }
  if (spec.type === 'color') {
    return h('div', { class: 'prop-row' }, label, h('input', {
      type: 'color', value: typeof value === 'string' ? value : '#9aa7bd',
      onchange: (event) => apply(event.target.value),
    }));
  }
  if (spec.type === 'number') {
    return h('div', { class: 'prop-row' }, label, h('input', {
      type: 'number', step: spec.step ?? '0.1', value: Number(value ?? 0),
      oninput: (event) => apply(Number(event.target.value)),
    }));
  }
  if (spec.type === 'enum') {
    const select = h('select', { onchange: (event) => apply(event.target.value) });
    for (const option of spec.options ?? []) {
      select.append(h('option', { value: option, selected: value === option }, option));
    }
    return h('div', { class: 'prop-row' }, label, select);
  }
  if (spec.type === 'source') {
    return h('div', { class: 'prop-row' }, label, h('textarea', {
      rows: 6, value: String(value ?? ''), oninput: (event) => apply(event.target.value),
    }));
  }
  return h('div', { class: 'prop-row' }, label, h('input', {
    type: 'text', value: String(value ?? ''), oninput: (event) => apply(event.target.value),
  }));
}

function scriptProperties(instance) {
  const kind = instance.getProperty('kind');
  const select = h('select', {
    onchange: (event) => {
      snapshot();
      instance.setProperty('kind', event.target.value);
      renderTree();
    },
  });
  for (const option of ['server', 'client', 'module']) {
    select.append(h('option', { value: option, selected: kind === option }, option));
  }
  return h('div', {},
    h('div', { class: 'prop-group' }, 'Script'),
    h('div', { class: 'prop-row' }, h('label', {}, 'kind'), select),
    h('div', { class: 'prop-row' }, h('label', {}, 'run on load'), h('input', {
      type: 'checkbox', checked: instance.getProperty('runOnLoad') !== false,
      onchange: (event) => {
        snapshot();
        instance.setProperty('runOnLoad', event.target.checked);
      },
    })),
    h('div', { class: 'script-tabs' }, h('button', { class: 'tool', onclick: () => { state.bottomPanel = 'scripts'; state.activeScriptId = instance.id; renderBottom(); } }, 'Open in script editor')),
  );
}

// ------------------------------------------------------------------ assets panel

async function refreshAssets() {
  try {
    const data = await KQ.get('/api/assets?limit=60');
    state.assets = data.assets ?? [];
  } catch (error) {
    state.assets = [];
    log(`Could not load assets: ${error.message}`, 'warn');
  }
}

function renderAssets() {
  dom.leftBody.innerHTML = '';
  const input = h('input', { type: 'file', style: { marginBottom: '8px' } });
  const upload = h('button', { class: 'tool', onclick: () => uploadAsset(input.files?.[0]) }, 'Upload into project');
  dom.leftBody.append(h('div', {}, input, upload, h('div', { class: 'empty' }, 'Images, meshes, audio and packages are validated server-side and never executed.')));
  for (const asset of state.assets) {
    const preview = asset.assetType === 'image'
      ? h('img', { src: `/api/assets/${asset.id}/raw`, alt: asset.name })
      : h('div', { style: { width: '34px', height: '34px', display: 'grid', placeItems: 'center' } }, assetTypeIcon(asset.assetType));
    dom.leftBody.append(h('div', { class: 'asset-card' },
      preview,
      h('div', { class: 'meta' },
        h('div', {}, asset.name),
        h('div', { class: 'empty' }, `${asset.assetType} · ${Math.round((asset.sizeBytes ?? 0) / 1024)}KB`),
      ),
      h('button', { class: 'tool', onclick: () => insertAsset(asset) }, 'Insert'),
    ));
  }
}

function assetTypeIcon(type) {
  const map = { mesh: '🔺', model: '📦', audio: '🎵', animation: '🎞', material: '🎨', package: '📚', image: '🖼' };
  return map[type] ?? '📄';
}

async function uploadAsset(file) {
  if (!file) return toast('Choose a file first.', 'warn');
  const form = new FormData();
  form.append('name', file.name);
  form.append('type', guessAssetType(file));
  form.append('file', file);
  try {
    const result = await KQ.upload(form);
    toast(`Uploaded ${result.asset.name}.`);
    await refreshAssets();
    renderAssets();
    log(`Asset uploaded: ${result.asset.id}`);
  } catch (error) {
    toast(error.message, 'error');
  }
}

function guessAssetType(file) {
  const name = file.name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(name)) return 'image';
  if (/\.(mp3|ogg|wav|m4a)$/.test(name)) return 'audio';
  if (/\.(obj|glb|gltf|mesh)$/.test(name)) return 'mesh';
  if (/\.(fbx|rbxm|kqmodel|json)$/.test(name)) return 'model';
  return 'package';
}

function insertAsset(asset) {
  if (asset.assetType === 'image') {
    const target = insertClass('Image', { image: `/api/assets/${asset.id}/raw`, size: new Vector2Like(220, 160) });
    if (target) log(`Inserted image ${asset.name}.`);
    return;
  }
  if (asset.assetType === 'audio') {
    insertClass('Sound', { soundId: asset.id, volume: 0.6, looped: false });
    return;
  }
  insertClass('Mesh', { meshId: asset.id, size: { x: 6, y: 6, z: 6 }, anchored: false });
}

function Vector2Like(x, y) {
  return { x, y };
}

// ------------------------------------------------------------------ bottom panel

function renderBottom() {
  dom.bottomTabs.innerHTML = '';
  const tabs = [
    ['output', 'Output'],
    ['scripts', 'Script Editor'],
    ['play', 'Play Test'],
    ['assets', 'Assets'],
  ];
  for (const [key, label] of tabs) {
    dom.bottomTabs.append(h('button', {
      class: `tab${state.bottomPanel === key ? ' active' : ''}`,
      onclick: () => {
        state.bottomPanel = key;
        renderBottom();
      },
    }, label));
  }
  if (state.bottomPanel === 'output') renderOutput();
  else if (state.bottomPanel === 'scripts') renderScripts();
  else if (state.bottomPanel === 'play') renderPlay();
  else if (state.bottomPanel === 'assets') renderAssetsInBottom();
}

function renderOutput() {
  dom.bottomBody.innerHTML = '';
  const controls = h('div', { class: 'script-tabs' },
    h('button', { class: 'tool', onclick: () => { state.logs = []; renderOutput(); } }, 'Clear'),
    h('button', { class: 'tool', onclick: () => exportLogs() }, 'Export log'),
  );
  dom.bottomBody.append(controls);
  for (const entry of state.logs.slice(-300)) {
    dom.bottomBody.append(h('div', { class: `console-line console-${entry.level}` }, `[${entry.at}] ${entry.message}`));
  }
  if (!state.logs.length) dom.bottomBody.append(h('div', { class: 'empty' }, 'Editor output, script logs and errors appear here.'));
  dom.bottomBody.scrollTop = dom.bottomBody.scrollHeight;
}

function exportLogs() {
  const blob = new Blob([state.logs.map((entry) => `[${entry.at}] ${entry.level}: ${entry.message}`).join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: 'kinetiq-editor.log' });
  link.click();
  URL.revokeObjectURL(url);
}

function renderAssetsInBottom() {
  dom.bottomBody.innerHTML = '';
  dom.bottomBody.append(h('div', { class: 'empty' }, 'Asset library — upload files, then insert them into the world.'));
  const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '8px' } });
  for (const asset of state.assets) {
    grid.append(h('div', { class: 'asset-card' },
      h('div', { class: 'meta' }, h('div', {}, asset.name), h('div', { class: 'empty' }, asset.assetType)),
      h('button', { class: 'tool', onclick: () => insertAsset(asset) }, 'Insert'),
    ));
  }
  dom.bottomBody.append(grid);
}

function renderScripts() {
  dom.bottomBody.innerHTML = '';
  const scripts = scriptsList();
  if (!scripts.length) {
    dom.bottomBody.append(h('div', { class: 'empty' }, 'No scripts yet.'));
  }
  if (!state.activeScriptId && scripts.length) state.activeScriptId = scripts[0].id;

  const list = h('div', { class: 'script-list' });
  for (const script of scripts) {
    list.append(h('div', {
      class: `item${state.activeScriptId === script.id ? ' active' : ''}`,
      onclick: () => {
        state.activeScriptId = script.id;
        renderScripts();
      },
    }, h('span', {}, `${script.getName()}.lua`), h('span', { class: 'empty' }, script.getProperty('kind'))));
  }
  list.append(h('div', { class: 'script-tabs', style: { marginTop: '8px' } },
    h('button', { class: 'tool', onclick: () => newScript('server') }, '+ Server'),
    h('button', { class: 'tool', onclick: () => newScript('client') }, '+ Client'),
    h('button', { class: 'tool', onclick: () => newScript('module') }, '+ Module'),
  ));

  const active = state.activeScriptId ? state.world.get(state.activeScriptId) : null;
  const main = h('div', { class: 'script-main' });
  if (active) {
    const editor = h('textarea', {
      class: 'script-editor',
      spellcheck: false,
      value: String(active.getProperty('source') ?? ''),
      oninput: (event) => {
        active.setProperty('source', event.target.value);
        markDirty();
      },
    });
    main.append(
      h('div', { class: 'script-tabs' },
        h('span', { class: 'badge' }, `${active.getName()}.lua · ${active.getProperty('kind')}`),
        h('button', { class: 'tool', onclick: () => { snapshot(); active.setProperty('source', active.getProperty('source')); log(`Reloaded ${active.getName()}.lua`); } }, 'Checkpoint'),
        h('button', { class: 'tool', onclick: () => runScriptLocally(active) }, 'Run in test server'),
        h('button', { class: 'tool', onclick: () => { snapshot(); active.destroy(); state.activeScriptId = null; refreshScene(); renderAll(); } }, 'Delete'),
      ),
      editor,
    );
  } else {
    main.append(h('div', { class: 'empty' }, 'Create a server, client or module script to get started.'));
  }
  dom.bottomBody.append(h('div', { class: 'script-grid' }, list, main));
}

// ------------------------------------------------------------------ play test

function renderPlay() {
  dom.bottomBody.innerHTML = '';
  const info = state.running?.info ?? null;
  const controls = h('div', { class: 'script-tabs' },
    h('button', { class: 'tool play', onclick: playTest }, '▶ PLAY (real server)'),
    h('button', { class: 'tool', onclick: playHere }, '▶ PLAY HERE'),
    h('button', { class: 'tool', onclick: runLocal }, 'RUN (simulate)'),
    h('button', { class: 'tool stop', onclick: stopLocal }, 'STOP'),
  );
  dom.bottomBody.append(controls);
  if (info) {
    dom.bottomBody.append(h('div', { class: 'console-line console-info' },
      `server ${info.serverId} · mode ${info.mode} · version v${info.versionNumber} · players ${info.players ?? 1}/${info.maxPlayers ?? 1}`));
    if (info.connectUrl) dom.bottomBody.append(h('div', { class: 'console-line console-info' }, `client: ${info.connectUrl}`));
  } else {
    dom.bottomBody.append(h('div', { class: 'empty' }, 'PLAY saves a draft and boots a real realm, then opens the client against it. PLAY HERE runs the simulation inside this viewport. RUN only simulates physics.'));
  }
  for (const line of state.running?.logs ?? []) {
    dom.bottomBody.append(h('div', { class: `console-line console-${line.level}` }, line.message));
  }
}

async function saveProject(mode = 'draft', extra = {}) {
  if (!state.projectId) throw new Error('No project is open.');
  state.saving = true;
  renderToolbar();
  try {
    const project = projectFromWorld(state.world, {
      name: state.doc?.project?.name ?? state.doc?.game?.name ?? 'Untitled Game',
      metadata: {
        ...(state.doc?.metadata ?? {}),
        name: state.doc?.metadata?.name ?? state.doc?.game?.name,
        description: state.doc?.metadata?.description ?? state.doc?.game?.description ?? '',
      },
      config: state.doc?.config ?? {},
      ownerId: state.doc?.project?.ownerId ?? null,
    });
    const payload = {
      mode,
      project,
      name: extra.name ?? state.doc?.game?.name,
      description: extra.description ?? state.doc?.metadata?.description ?? state.doc?.game?.description ?? '',
      genre: extra.genre ?? state.doc?.game?.genre,
      changelog: extra.changelog ?? '',
      isPublic: extra.isPublic ?? undefined,
      maxPlayers: extra.maxPlayers ?? state.doc?.game?.maxPlayers,
    };
    const result = await KQ.put(`/api/creator/projects/${state.projectId}`, payload);
    state.dirty = false;
    state.doc.version = result.version;
    log(`Saved v${result.version.versionNumber} (${mode}).`);
    toast(mode === 'publish' ? `Published v${result.version.versionNumber}!` : `Saved draft v${result.version.versionNumber}.`);
    return result;
  } finally {
    state.saving = false;
    renderToolbar();
  }
}

async function playTest() {
  try {
    await saveProject('draft');
    const result = await KQ.post(`/api/creator/projects/${state.projectId}/playtest`, { maxPlayers: 8 });
    state.running = {
      mode: 'realm',
      info: result,
      logs: [{ level: 'info', message: `realm ${result.serverId} ready — opening ${platformInfo().clientName}…` }],
      close: null,
    };
    renderPlay();
    const clientUrl = `/client?server=${encodeURIComponent(result.serverId)}&token=${encodeURIComponent(result.joinToken)}&project=${encodeURIComponent(state.projectId)}`;
    window.open(clientUrl, 'kinetiq-playtest', 'width=1280,height=800');
    log(`Play test realm started: ${result.serverId}`);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function playHere() {
  await runLocal({ withCharacter: true });
}

async function runLocal({ withCharacter = false } = {}) {
  stopLocal();
  const world = state.world;
  const character = withCharacter ? world.create('Model', { name: 'LocalPlayer', position: new Vector3(0, 8, 0) }) : null;
  state.running = {
    mode: withCharacter ? 'play-here' : 'run',
    info: { serverId: 'local', mode: withCharacter ? 'play-here' : 'run', versionNumber: state.doc?.version?.versionNumber ?? 1, players: 1, maxPlayers: 1 },
    logs: [{ level: 'info', message: withCharacter ? 'Local play session started — WASD to move, Space to jump.' : 'Simulating physics locally.' }],
    character,
    startedAt: performance.now(),
    accumulator: 0,
    clock: null,
    close: stopLocal,
  };
  renderPlay();
  log('Local simulation started.');
}

function stopLocal() {
  if (!state.running) return;
  if (state.running.character) state.running.character.destroy();
  state.running = null;
  renderPlay();
  log('Local simulation stopped.');
}

// ------------------------------------------------------------------ publishing dialog

function openPublish() {
  const modal = h('div', { class: 'publish-modal' });
  const box = h('div', { class: 'box' });
  const name = h('input', { value: state.doc?.game?.name ?? 'Untitled Game' });
  const description = h('textarea', { rows: 4, value: state.doc?.metadata?.description ?? state.doc?.game?.description ?? '' });
  const genre = h('select', {});
  for (const option of ['Adventure', 'Simulation', 'Roleplay', 'Fighting', 'Racing', 'Horror', 'Sandbox', 'Obby', 'Shooter', 'Party', 'Social', 'Puzzle', 'Building', 'Other']) {
    genre.append(h('option', { value: option, selected: (state.doc?.game?.genre ?? 'Sandbox') === option }, option));
  }
  const maxPlayers = h('input', { type: 'number', min: '1', max: '60', value: state.doc?.game?.maxPlayers ?? 12 });
  const changelog = h('textarea', { rows: 3, placeholder: 'What changed in this version?' });
  box.append(
    h('h3', {}, 'Publish a new version'),
    h('div', { class: 'empty' }, 'Published versions are immutable — the previous release keeps running for players already in game.'),
    h('label', {}, 'Name'), name,
    h('label', {}, 'Description'), description,
    h('label', {}, 'Genre'), genre,
    h('label', {}, 'Max players'), maxPlayers,
    h('label', {}, 'Changelog'), changelog,
    h('div', { class: 'script-tabs' },
      h('button', { class: 'tool', onclick: () => modal.remove() }, 'Cancel'),
      h('button', { class: 'tool play', onclick: async () => {
        try {
          const version = await saveProject('publish', {
            name: name.value,
            description: description.value,
            genre: genre.value,
            maxPlayers: Number(maxPlayers.value),
            changelog: changelog.value,
          });
          modal.remove();
          toast(`Published v${version.version.versionNumber}.`);
        } catch (error) {
          toast(error.message, 'error');
        }
      } }, 'Publish'),
      h('button', { class: 'tool', onclick: async () => {
        try {
          const version = await saveProject('draft', {
            name: name.value,
            description: description.value,
            genre: genre.value,
            maxPlayers: Number(maxPlayers.value),
            changelog: changelog.value,
          });
          modal.remove();
          toast(`Draft v${version.version.versionNumber} saved.`);
        } catch (error) {
          toast(error.message, 'error');
        }
      } }, 'Save as draft'),
    ),
  );
  modal.append(box);
  document.body.append(modal);
}

// ------------------------------------------------------------------ viewport interaction

function pointerToWorld(event, plane = 'xz') {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, editorCamera);
  const worldPlane = plane === 'xz'
    ? new THREE.Plane(new THREE.Vector3(0, 1, 0), -(state.primary ? state.primary.getPosition().y : 0))
    : new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const point = new THREE.Vector3();
  return raycaster.ray.intersectPlane(worldPlane, point) ? point : null;
}

function pickInstance(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, editorCamera);
  const hits = raycaster.intersectObjects(worldGroup.children, true);
  for (const hit of hits) {
    let node = hit.object;
    while (node && !node.userData.instanceId) node = node.parent;
    if (node?.userData?.instanceId) {
      const instance = state.world.get(node.userData.instanceId);
      if (instance) return instance;
    }
  }
  return null;
}

let orbit = null;
renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
renderer.domElement.addEventListener('pointerdown', (event) => {
  renderer.domElement.setPointerCapture(event.pointerId);
  if (event.button === 2 || event.button === 1) {
    orbit = { x: event.clientX, y: event.clientY, mode: event.button === 1 ? 'pan' : 'orbit' };
    return;
  }
  const instance = pickInstance(event);
  if (instance) {
    select([instance], { mode: event.shiftKey ? 'toggle' : 'replace' });
    if (state.tool !== 'select') {
      state.pointer = {
        startClient: { x: event.clientX, y: event.clientY },
        startPoint: pointerToWorld(event),
        pushed: false,
        instance,
      };
    }
  } else if (!event.shiftKey) {
    select([]);
  }
});
renderer.domElement.addEventListener('wheel', (event) => {
  event.preventDefault();
  cameraState.distance = Math.min(1500, Math.max(4, cameraState.distance * (1 + Math.sign(event.deltaY) * 0.12)));
  updateCamera();
}, { passive: false });

window.addEventListener('pointermove', (event) => {
  if (orbit) {
    const dx = event.clientX - orbit.x;
    const dy = event.clientY - orbit.y;
    orbit.x = event.clientX;
    orbit.y = event.clientY;
    if (orbit.mode === 'orbit') {
      cameraState.yaw -= dx * 0.006;
      cameraState.pitch = Math.max(-1.35, Math.min(1.45, cameraState.pitch + dy * 0.005));
    } else {
      const scale = cameraState.distance * 0.0018;
      cameraState.target.x -= dx * scale * Math.cos(cameraState.yaw);
      cameraState.target.z += dx * scale * Math.sin(cameraState.yaw);
      cameraState.target.y += dy * scale;
    }
    updateCamera();
    return;
  }
  const drag = state.pointer;
  if (!drag) return;
  const dx = event.clientX - drag.startClient.x;
  const dy = event.clientY - drag.startClient.y;
  if (!drag.pushed && Math.hypot(dx, dy) < 3) return;
  if (!drag.pushed) {
    drag.pushed = true;
    snapshot();
  }
  if (state.tool === 'move') {
    const point = pointerToWorld(event) ?? drag.startPoint;
    if (point && drag.startPoint) {
      const delta = new THREE.Vector3(point.x - drag.startPoint.x, 0, point.z - drag.startPoint.z);
      moveSelection({ x: delta.x, y: 0, z: delta.z }, { quiet: true });
      drag.startPoint = pointerToWorld(event) ?? point;
    }
  } else if (state.tool === 'rotate') {
    rotateSelection(dx * 0.01, dy * 0.01, { quiet: true });
    drag.startClient = { x: event.clientX, y: event.clientY };
  } else if (state.tool === 'scale') {
    const factor = Math.max(0.05, 1 - dy * 0.01);
    scaleSelection(factor);
    drag.startClient = { x: event.clientX, y: event.clientY };
  }
});

window.addEventListener('pointerup', () => {
  orbit = null;
  state.pointer = null;
});

// ------------------------------------------------------------------ keyboard

const keys = new Set();
window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
  keys.add(event.key.toLowerCase());
  const ctrl = event.ctrlKey || event.metaKey;
  if (ctrl && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    return event.shiftKey ? redo() : undo();
  }
  if (ctrl && event.key.toLowerCase() === 'd') { event.preventDefault(); return duplicateSelection(); }
  if (ctrl && event.key.toLowerCase() === 'c') { event.preventDefault(); return copySelection(); }
  if (ctrl && event.key.toLowerCase() === 'v') { event.preventDefault(); return pasteClipboard(); }
  if (ctrl && event.key.toLowerCase() === 'g') { event.preventDefault(); return event.shiftKey ? ungroupSelection() : groupSelection(); }
  if (ctrl && event.key.toLowerCase() === 's') { event.preventDefault(); return void saveProject('draft').then(() => toast('Draft saved.')).catch((error) => toast(error.message, 'error')); }
  if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); return deleteSelection(); }
  if (event.key === '1') { state.tool = 'select'; return renderToolbar(); }
  if (event.key === '2') { state.tool = 'move'; return renderToolbar(); }
  if (event.key === '3') { state.tool = 'rotate'; return renderToolbar(); }
  if (event.key === '4') { state.tool = 'scale'; return renderToolbar(); }
  if (event.key === 'F2') { event.preventDefault(); return state.primary ? renameInstance(state.primary) : null; }
  if (event.key === 'ArrowUp' && state.primary) { event.preventDefault(); return moveSelection({ x: 0, y: 0, z: -state.grid }); }
  if (event.key === 'ArrowDown' && state.primary) { event.preventDefault(); return moveSelection({ x: 0, y: 0, z: state.grid }); }
  if (event.key === 'ArrowLeft' && state.primary) { event.preventDefault(); return moveSelection({ x: -state.grid, y: 0, z: 0 }); }
  if (event.key === 'ArrowRight' && state.primary) { event.preventDefault(); return moveSelection({ x: state.grid, y: 0, z: 0 }); }
  if (event.key === 'PageUp' && state.primary) { event.preventDefault(); return moveSelection({ x: 0, y: state.grid, z: 0 }); }
  if (event.key === 'PageDown' && state.primary) { event.preventDefault(); return moveSelection({ x: 0, y: -state.grid, z: 0 }); }
});
window.addEventListener('keyup', (event) => keys.delete(event.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

function flyCamera(dt) {
  const speed = (keys.has('shift') ? 90 : 34) * dt;
  const forward = new THREE.Vector3(Math.sin(cameraState.yaw), 0, Math.cos(cameraState.yaw));
  const right = new THREE.Vector3(forward.z, 0, -forward.x);
  let moved = false;
  if (keys.has('w')) { cameraState.target.addScaledVector(forward, -speed); moved = true; }
  if (keys.has('s')) { cameraState.target.addScaledVector(forward, speed); moved = true; }
  if (keys.has('a')) { cameraState.target.addScaledVector(right, -speed); moved = true; }
  if (keys.has('d')) { cameraState.target.addScaledVector(right, speed); moved = true; }
  if (keys.has('q') || keys.has('e')) { cameraState.target.y += (keys.has('e') ? speed : -speed); moved = true; }
  if (moved) updateCamera();
}

// ------------------------------------------------------------------ main loop

let lastFrame = performance.now();
let frameCounter = 0;
let fpsClock = performance.now();

function loop(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  flyCamera(dt);

  if (state.running) {
    // Local simulation: fixed-step physics so test runs feel identical to a realm tick.
    state.running.accumulator += dt;
    const step = 1 / 60;
    while (state.running.accumulator >= step) {
      state.world.tick(step);
      state.running.accumulator -= step;
    }
    if (state.running.character) {
      const character = state.running.character;
      const position = character.getPosition();
      const move = { x: 0, z: 0 };
      if (keys.has('w')) move.z -= 1;
      if (keys.has('s')) move.z += 1;
      if (keys.has('a')) move.x -= 1;
      if (keys.has('d')) move.x += 1;
      const length = Math.hypot(move.x, move.z);
      if (length > 0) {
        character.setProperty('position', new Vector3(
          position.x + (move.x / length) * 12 * dt,
          position.y + (keys.has(' ') ? 9 * dt : 0),
          position.z + (move.z / length) * 12 * dt,
        ));
      }
      cameraState.target.set(position.x, position.y + 3, position.z);
      updateCamera();
    }
    refreshTransforms();
  }

  frameCounter += 1;
  if (now - fpsClock > 500) {
    state.stats.fps = Math.round((frameCounter * 1000) / (now - fpsClock));
    frameCounter = 0;
    fpsClock = now;
    renderOverlay();
    renderToolbar();
  }

  renderer.render(scene, editorCamera);
  requestAnimationFrame(loop);
}

function renderOverlay() {
  dom.overlay.innerHTML = '';
  dom.overlay.append(
    h('div', { class: 'stat-line' },
      h('span', {}, `${state.stats.fps} fps`),
      h('span', {}, `${state.stats.objects} objects`),
      h('span', {}, `grid ${state.grid}`),
      h('span', {}, `tool ${state.tool}`),
      h('span', {}, state.running ? `running (${state.running.mode})` : 'editing'),
    ),
    h('div', { class: 'stat-line' },
      h('span', {}, 'Right-drag orbit · Middle-drag pan · Wheel zoom · WASD fly · 1-4 tools'),
    ),
  );
}

function renderPlaybar() {
  dom.playbar.innerHTML = '';
  dom.playbar.append(
    h('button', { class: 'tool play', onclick: playTest }, '▶ PLAY'),
    h('button', { class: 'tool', onclick: playHere }, '▶ PLAY HERE'),
    h('button', { class: 'tool', onclick: () => runLocal({ withCharacter: false }) }, 'RUN'),
    h('button', { class: 'tool stop', onclick: stopLocal }, 'STOP'),
  );
}

// ------------------------------------------------------------------ boot

function platformInfo() {
  return window.__PLATFORM__ ?? {};
}

function renderAll() {
  renderToolbar();
  renderTree();
  renderProperties();
  renderBottom();
  renderPlaybar();
  renderOverlay();
}

async function runScriptLocally(script) {
  if (!state.projectId) return;
  try {
    await playTest();
    log(`Server test realm started; ${script.getName()}.lua will run there.`);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function boot() {
  resizeRenderer();
  updateCamera();
  requestAnimationFrame(loop);
  await KQ.session();
  await loadClassCatalog();
  renderAssets();

  if (!state.projectId) {
    log('No project selected — showing an empty world. Use the website creator dashboard to create one.', 'warn');
    state.world = new World({ name: 'Untitled' });
    state.world.ensureServices();
    refreshScene();
    renderAll();
    return;
  }

  try {
    state.doc = await KQ.get(`/api/creator/projects/${state.projectId}`);
    loadWorld(state.doc.project);
    refreshScene();
    await refreshAssets();
    log(`Opened ${state.doc.game?.name ?? 'project'} (v${state.doc.version?.versionNumber ?? 1}).`);
    renderAll();
  } catch (error) {
    toast(`Could not open project: ${error.message}`, 'error');
    log(`Failed to load project: ${error.message}`, 'error');
    state.world = new World({ name: 'Untitled' });
    state.world.ensureServices();
    refreshScene();
    renderAll();
  }
}

window.addEventListener('beforeunload', (event) => {
  if (state.dirty) {
    event.preventDefault();
    event.returnValue = 'You have unsaved changes.';
  }
});

await boot();
