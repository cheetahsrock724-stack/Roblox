/**
 * Instance class registry — the single source of truth for what creators can insert, the
 * properties the inspector shows, and the replication rules the network layer follows.
 *
 * `props` entries: { type, default, min?, max?, enum?, hidden?, readOnly?, serverOnly?, replicated? }
 * types: number | integer | string | boolean | color | vector3 | enum | udim2 | array | object | json
 */

const V3 = (x, y, z) => ({ x, y, z });

const baseUIProps = () => ({
  position: { type: 'udim2', default: [0, 0, 0, 0], category: 'Layout' },
  size: { type: 'udim2', default: [0.3, 0, 0.1, 0], category: 'Layout' },
  anchorPoint: { type: 'vector3', default: V3(0, 0, 0), category: 'Layout', compact: true },
  visible: { type: 'boolean', default: true, category: 'Layout' },
  zIndex: { type: 'integer', default: 1, min: -100, max: 1000, category: 'Layout' },
  background: { type: 'color', default: '#1b2233', category: 'Appearance' },
  backgroundTransparency: { type: 'number', default: 0, min: 0, max: 1, category: 'Appearance' },
  borderColor: { type: 'color', default: '#3d5afe', category: 'Appearance' },
  borderWidth: { type: 'number', default: 0, min: 0, max: 24, category: 'Appearance' },
  cornerRadius: { type: 'number', default: 8, min: 0, max: 128, category: 'Appearance' },
  responsive: { type: 'boolean', default: true, category: 'Layout' },
});

export const CLASS_DEFS = {
  World: {
    category: 'Containers',
    container: true,
    root: true,
    props: {
      gravity: { type: 'number', default: -90, category: 'Physics' },
      ambient: { type: 'color', default: '#ffffff', category: 'Lighting' },
    },
  },
  Folder: { category: 'Containers', container: true, props: {} },
  Model: {
    category: 'Containers',
    container: true,
    props: {
      primaryPart: { type: 'string', default: '', category: 'Model' },
      anchored: { type: 'boolean', default: false, category: 'Model' },
    },
  },
  Players: { category: 'Containers', container: true, system: true, props: {} },
  Lighting: {
    category: 'Environment',
    system: true,
    props: {
      ambient: { type: 'color', default: '#6a7ea8', category: 'Lighting' },
      skyColor: { type: 'color', default: '#8fb8ff', category: 'Lighting' },
      clockTime: { type: 'number', default: 14, min: 0, max: 24, category: 'Lighting' },
      fogColor: { type: 'color', default: '#9fb6d8', category: 'Lighting' },
      fogStart: { type: 'number', default: 120, category: 'Lighting' },
      fogEnd: { type: 'number', default: 800, category: 'Lighting' },
      brightness: { type: 'number', default: 2, min: 0, max: 10, category: 'Lighting' },
      shadows: { type: 'boolean', default: true, category: 'Lighting' },
      environmentAssetId: { type: 'string', default: '', category: 'Lighting' },
      postProcess: {
        type: 'enum',
        enum: ['none', 'bloom', 'vignette', 'colorGrade', 'bloomVignette'],
        default: 'none',
        category: 'Lighting',
      },
    },
  },
  SharedStorage: { category: 'Containers', container: true, system: true, props: {} },
  ServerScripts: { category: 'Containers', container: true, system: true, props: {} },
  ClientScripts: { category: 'Containers', container: true, system: true, props: {} },
  UI: { category: 'Containers', container: true, system: true, props: {} },
  Audio: { category: 'Containers', container: true, system: true, props: {} },
  Assets: { category: 'Containers', container: true, system: true, props: {} },

  Part: {
    category: 'Geometry',
    physics: 'static|dynamic',
    props: {
      position: { type: 'vector3', default: V3(0, 4, 0), category: 'Transform' },
      rotation: { type: 'vector3', default: V3(0, 0, 0), category: 'Transform' },
      size: { type: 'vector3', default: V3(4, 1, 2), min: 0.05, max: 4096, category: 'Transform' },
      color: { type: 'color', default: '#a8b0bd', category: 'Appearance' },
      material: { type: 'string', default: 'plastic', category: 'Appearance' },
      transparency: { type: 'number', default: 0, min: 0, max: 1, category: 'Appearance' },
      reflectance: { type: 'number', default: 0, min: 0, max: 1, category: 'Appearance' },
      textureAssetId: { type: 'string', default: '', category: 'Appearance' },
      shape: { type: 'enum', enum: ['block', 'sphere', 'cylinder', 'wedge'], default: 'block', category: 'Geometry' },
      canCollide: { type: 'boolean', default: true, category: 'Physics' },
      anchored: { type: 'boolean', default: true, category: 'Physics' },
      mass: { type: 'number', default: 1, min: 0.01, max: 100000, category: 'Physics' },
      friction: { type: 'number', default: 0.45, min: 0, max: 2, category: 'Physics' },
      restitution: { type: 'number', default: 0.15, min: 0, max: 1, category: 'Physics' },
      velocity: { type: 'vector3', default: V3(0, 0, 0), serverOnly: true, category: 'Physics' },
      linearVelocity: { type: 'vector3', default: V3(0, 0, 0), category: 'Physics', description: 'Constant motion while anchored (moving platforms).' },
      castShadow: { type: 'boolean', default: true, category: 'Appearance' },
      value: { type: 'string', default: '', category: 'Data' },
      locked: { type: 'boolean', default: false, category: 'Editor' },
    },
  },
  Terrain: {
    category: 'Geometry',
    physics: 'static',
    props: {
      position: { type: 'vector3', default: V3(0, -1, 0), category: 'Transform' },
      size: { type: 'vector3', default: V3(400, 2, 400), category: 'Transform' },
      color: { type: 'color', default: '#5f8f4e', category: 'Appearance' },
      material: { type: 'string', default: 'grass', category: 'Appearance' },
      subdivisions: { type: 'integer', default: 16, min: 1, max: 64, category: 'Geometry' },
      heights: { type: 'array', default: [], category: 'Geometry', hidden: true },
      canCollide: { type: 'boolean', default: true, category: 'Physics' },
      anchored: { type: 'boolean', default: true, category: 'Physics' },
      waterLevel: { type: 'number', default: -1000, category: 'Geometry' },
    },
  },
  Mesh: {
    category: 'Geometry',
    physics: 'static',
    props: {
      assetId: { type: 'string', default: '', category: 'Mesh' },
      position: { type: 'vector3', default: V3(0, 4, 0), category: 'Transform' },
      rotation: { type: 'vector3', default: V3(0, 0, 0), category: 'Transform' },
      scale: { type: 'vector3', default: V3(1, 1, 1), category: 'Transform' },
      size: { type: 'vector3', default: V3(4, 4, 4), category: 'Transform' },
      color: { type: 'color', default: '#c8ccd4', category: 'Appearance' },
      material: { type: 'string', default: 'smoothplastic', category: 'Appearance' },
      transparency: { type: 'number', default: 0, min: 0, max: 1, category: 'Appearance' },
      canCollide: { type: 'boolean', default: true, category: 'Physics' },
      anchored: { type: 'boolean', default: true, category: 'Physics' },
      castShadow: { type: 'boolean', default: true, category: 'Appearance' },
    },
  },
  Light: {
    category: 'Environment',
    props: {
      lightType: { type: 'enum', enum: ['point', 'spot', 'directional'], default: 'point', category: 'Light' },
      color: { type: 'color', default: '#ffe9c4', category: 'Light' },
      brightness: { type: 'number', default: 2, min: 0, max: 100, category: 'Light' },
      range: { type: 'number', default: 40, min: 0, max: 2000, category: 'Light' },
      angle: { type: 'number', default: 45, min: 1, max: 179, category: 'Light' },
      position: { type: 'vector3', default: V3(0, 12, 0), category: 'Transform' },
      castShadow: { type: 'boolean', default: true, category: 'Light' },
      enabled: { type: 'boolean', default: true, category: 'Light' },
    },
  },
  Camera: {
    category: 'Environment',
    props: {
      position: { type: 'vector3', default: V3(0, 12, 24), category: 'Transform' },
      rotation: { type: 'vector3', default: V3(-15, 0, 0), category: 'Transform' },
      fov: { type: 'number', default: 70, min: 20, max: 120, category: 'Camera' },
      cameraType: { type: 'enum', enum: ['follow', 'orbit', 'fixed', 'firstPerson'], default: 'follow', category: 'Camera' },
      distance: { type: 'number', default: 14, min: 1, max: 100, category: 'Camera' },
      subjectId: { type: 'string', default: '', category: 'Camera' },
    },
  },
  Sound: {
    category: 'Audio',
    props: {
      assetId: { type: 'string', default: '', category: 'Sound' },
      volume: { type: 'number', default: 0.6, min: 0, max: 4, category: 'Sound' },
      pitch: { type: 'number', default: 1, min: 0.05, max: 10, category: 'Sound' },
      looped: { type: 'boolean', default: false, category: 'Sound' },
      playing: { type: 'boolean', default: false, category: 'Sound' },
      group: { type: 'enum', enum: ['master', 'sfx', 'music', 'ui', 'voice'], default: 'sfx', category: 'Sound' },
      rollOffMaxDistance: { type: 'number', default: 120, category: 'Sound' },
      rollOffMinDistance: { type: 'number', default: 8, category: 'Sound' },
      position: { type: 'vector3', default: V3(0, 4, 0), category: 'Transform' },
      spatial: { type: 'boolean', default: true, category: 'Sound' },
    },
  },
  ParticleEmitter: {
    category: 'Effects',
    props: {
      position: { type: 'vector3', default: V3(0, 4, 0), category: 'Transform' },
      rate: { type: 'number', default: 20, min: 0, max: 1000, category: 'Emitter' },
      lifetime: { type: 'number', default: 1.5, min: 0.05, max: 30, category: 'Emitter' },
      speed: { type: 'number', default: 6, category: 'Emitter' },
      spreadAngle: { type: 'number', default: 15, min: 0, max: 180, category: 'Emitter' },
      startColor: { type: 'color', default: '#8fd6ff', category: 'Emitter' },
      endColor: { type: 'color', default: '#3d5afe', category: 'Emitter' },
      startSize: { type: 'number', default: 0.6, category: 'Emitter' },
      endSize: { type: 'number', default: 0, category: 'Emitter' },
      textureAssetId: { type: 'string', default: '', category: 'Emitter' },
      enabled: { type: 'boolean', default: true, category: 'Emitter' },
    },
  },
  SpawnPoint: {
    category: 'Gameplay',
    props: {
      position: { type: 'vector3', default: V3(0, 5, 0), category: 'Transform' },
      rotation: { type: 'vector3', default: V3(0, 0, 0), category: 'Transform' },
      team: { type: 'string', default: '', category: 'Gameplay' },
      enabled: { type: 'boolean', default: true, category: 'Gameplay' },
      neutral: { type: 'boolean', default: true, category: 'Gameplay' },
    },
  },
  Script: {
    category: 'Scripting',
    props: {
      source: { type: 'string', default: '-- new script', multiline: true, category: 'Script', noReplicate: true },
      kind: { type: 'enum', enum: ['server', 'client', 'module'], default: 'server', category: 'Script', noReplicate: true },
      runOnLoad: { type: 'boolean', default: true, category: 'Script' },
      disabled: { type: 'boolean', default: false, category: 'Script' },
      priority: { type: 'integer', default: 0, min: -100, max: 100, category: 'Script' },
    },
  },
  RemoteEvent: { category: 'Scripting', props: { description: { type: 'string', default: '', category: 'Script' } } },
  RemoteFunction: { category: 'Scripting', props: { description: { type: 'string', default: '', category: 'Script' } } },
  DataStore: {
    category: 'Scripting',
    props: { scope: { type: 'string', default: 'global', category: 'Data' }, allowClientWrite: { type: 'boolean', default: false, category: 'Data' } },
  },
  Badge: {
    category: 'Gameplay',
    props: {
      badgeId: { type: 'string', default: '', category: 'Badge' },
      name_: { type: 'string', default: 'Badge', category: 'Badge', hidden: true },
      iconAssetId: { type: 'string', default: '', category: 'Badge' },
    },
  },

  VehicleSeat: {
    category: 'Gameplay',
    physics: 'static',
    props: {
      position: { type: 'vector3', default: V3(0, 2, 0), category: 'Transform' },
      rotation: { type: 'vector3', default: V3(0, 0, 0), category: 'Transform' },
      size: { type: 'vector3', default: V3(3, 1, 3), category: 'Transform' },
      color: { type: 'color', default: '#4a5568', category: 'Appearance' },
      maxSpeed: { type: 'number', default: 60, category: 'Vehicle' },
      torque: { type: 'number', default: 800, category: 'Vehicle' },
      turnSpeed: { type: 'number', default: 2.2, category: 'Vehicle' },
      anchored: { type: 'boolean', default: false, category: 'Physics' },
      canCollide: { type: 'boolean', default: true, category: 'Physics' },
      occupiedBy: { type: 'string', default: '', serverOnly: true, category: 'Vehicle' },
    },
  },
  Interactable: {
    category: 'Gameplay',
    props: {
      position: { type: 'vector3', default: V3(0, 3, 0), category: 'Transform' },
      size: { type: 'vector3', default: V3(4, 1, 4), category: 'Transform' },
      color: { type: 'color', default: '#2dd4bf', category: 'Appearance' },
      prompt: { type: 'string', default: 'Interact', category: 'Interaction' },
      range: { type: 'number', default: 12, category: 'Interaction' },
      cooldown: { type: 'number', default: 0.5, category: 'Interaction' },
      enabled: { type: 'boolean', default: true, category: 'Interaction' },
      canCollide: { type: 'boolean', default: true, category: 'Physics' },
    },
  },
  NPC: {
    category: 'Gameplay',
    props: {
      position: { type: 'vector3', default: V3(0, 4, 0), category: 'Transform' },
      rotation: { type: 'vector3', default: V3(0, 0, 0), category: 'Transform' },
      name_: { type: 'string', default: 'NPC', category: 'NPC', hidden: true },
      health: { type: 'number', default: 100, category: 'NPC' },
      walkSpeed: { type: 'number', default: 12, category: 'NPC' },
      behaviour: { type: 'enum', enum: ['idle', 'patrol', 'chase', 'wander'], default: 'idle', category: 'NPC' },
      patrolPoints: { type: 'array', default: [], category: 'NPC' },
      chaseRange: { type: 'number', default: 40, category: 'NPC' },
      bodyColor: { type: 'color', default: '#59a8ff', category: 'Appearance' },
      canCollide: { type: 'boolean', default: true, category: 'Physics' },
    },
  },

  Frame: { category: 'UI', ui: true, props: baseUIProps() },
  TextLabel: {
    category: 'UI',
    ui: true,
    props: {
      ...baseUIProps(),
      text: { type: 'string', default: 'Label', category: 'Text' },
      textColor: { type: 'color', default: '#eef2ff', category: 'Text' },
      textSize: { type: 'number', default: 18, min: 4, max: 200, category: 'Text' },
      font: { type: 'enum', enum: ['sans', 'rounded', 'mono', 'serif', 'display'], default: 'sans', category: 'Text' },
      bold: { type: 'boolean', default: false, category: 'Text' },
      textAlign: { type: 'enum', enum: ['left', 'center', 'right'], default: 'left', category: 'Text' },
      textWrap: { type: 'boolean', default: true, category: 'Text' },
    },
  },
  TextButton: {
    category: 'UI',
    ui: true,
    props: {
      ...baseUIProps(),
      text: { type: 'string', default: 'Button', category: 'Text' },
      textColor: { type: 'color', default: '#ffffff', category: 'Text' },
      textSize: { type: 'number', default: 18, min: 4, max: 200, category: 'Text' },
      font: { type: 'enum', enum: ['sans', 'rounded', 'mono', 'serif', 'display'], default: 'sans', category: 'Text' },
      bold: { type: 'boolean', default: true, category: 'Text' },
      textAlign: { type: 'enum', enum: ['left', 'center', 'right'], default: 'center', category: 'Text' },
      enabled: { type: 'boolean', default: true, category: 'Interaction' },
    },
  },
  ImageLabel: {
    category: 'UI',
    ui: true,
    props: {
      ...baseUIProps(),
      assetId: { type: 'string', default: '', category: 'Image' },
      imageColor: { type: 'color', default: '#ffffff', category: 'Image' },
      imageTransparency: { type: 'number', default: 0, min: 0, max: 1, category: 'Image' },
      preserveAspect: { type: 'boolean', default: true, category: 'Image' },
    },
  },
  InputField: {
    category: 'UI',
    ui: true,
    props: {
      ...baseUIProps(),
      text: { type: 'string', default: '', category: 'Input' },
      placeholder: { type: 'string', default: 'Type here', category: 'Input' },
      textColor: { type: 'color', default: '#eef2ff', category: 'Input' },
      textSize: { type: 'number', default: 16, min: 4, max: 100, category: 'Input' },
      maxLength: { type: 'integer', default: 120, min: 1, max: 2000, category: 'Input' },
    },
  },
  ScrollingList: {
    category: 'UI',
    ui: true,
    props: {
      ...baseUIProps(),
      scrollDirection: { type: 'enum', enum: ['vertical', 'horizontal'], default: 'vertical', category: 'Layout' },
      padding: { type: 'number', default: 8, category: 'Layout' },
      spacing: { type: 'number', default: 6, category: 'Layout' },
      automaticLayout: { type: 'enum', enum: ['none', 'list', 'grid'], default: 'list', category: 'Layout' },
    },
  },
  ProgressBar: {
    category: 'UI',
    ui: true,
    props: {
      ...baseUIProps(),
      value: { type: 'number', default: 0.5, min: 0, max: 1, category: 'Progress' },
      fillColor: { type: 'color', default: '#00e5c0', category: 'Progress' },
      showText: { type: 'boolean', default: false, category: 'Progress' },
    },
  },
  Viewport: {
    category: 'UI',
    ui: true,
    props: {
      ...baseUIProps(),
      subjectId: { type: 'string', default: '', category: 'Viewport' },
      orbitCamera: { type: 'boolean', default: true, category: 'Viewport' },
      zoom: { type: 'number', default: 8, category: 'Viewport' },
    },
  },
};

/** Parent class chain used for inherited property lookups. */
export const CLASS_INHERITS = {
  Frame: 'UIElement',
  TextLabel: 'UIElement',
  TextButton: 'UIElement',
  ImageLabel: 'UIElement',
  InputField: 'UIElement',
  ScrollingList: 'UIElement',
  ProgressBar: 'UIElement',
  Viewport: 'UIElement',
};

export const UI_CLASSES = Object.entries(CLASS_DEFS)
  .filter(([, def]) => def.ui)
  .map(([name]) => name);

export const PHYSICS_CLASSES = Object.entries(CLASS_DEFS)
  .filter(([, def]) => Boolean(def.physics))
  .map(([name]) => name);

export function classDef(className) {
  const def = CLASS_DEFS[className];
  if (!def) throw new Error(`Unknown instance class: ${className}`);
  return def;
}

export function isCreatable(className) {
  const def = CLASS_DEFS[className];
  return Boolean(def) && !def.system && !def.root;
}

export function defaultProps(className, overrides = {}) {
  const def = classDef(className);
  const out = {};
  for (const [key, spec] of Object.entries(def.props)) {
    out[key] = typeof spec.default === 'object' && spec.default !== null ? structuredClone(spec.default) : spec.default;
  }
  return { ...out, ...overrides };
}

export function propertySpec(className, prop) {
  return classDef(className).props[prop] ?? null;
}

/** Property metadata for the editor inspector / docs. */
export function propertyCatalog(className) {
  return Object.entries(classDef(className).props).map(([name, spec]) => ({
    name,
    type: spec.type,
    default: spec.default,
    min: spec.min,
    max: spec.max,
    enum: spec.enum,
    category: spec.category ?? 'General',
    hidden: Boolean(spec.hidden),
    multiline: Boolean(spec.multiline),
    readOnly: Boolean(spec.readOnly),
    noReplicate: Boolean(spec.noReplicate),
    description: spec.description ?? '',
  }));
}

export function classCatalog() {
  return Object.entries(CLASS_DEFS).map(([name, def]) => ({
    name,
    category: def.category,
    container: Boolean(def.container),
    creatable: isCreatable(name),
    ui: Boolean(def.ui),
    physics: def.physics ?? null,
    system: Boolean(def.system),
    propertyCount: Object.keys(def.props).length,
  }));
}

export default { CLASS_DEFS, classDef, defaultProps, classCatalog, propertyCatalog };
