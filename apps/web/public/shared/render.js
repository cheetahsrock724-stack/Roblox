/**
 * Shared rendering layer for the game client and the creator editor.
 *
 * Converts a serialized world (kinetiq.scene) into three.js objects, and builds/animates avatar
 * rigs. Geometry and materials are cached and colour-graded by material type so worlds look
 * consistent everywhere.
 */
import * as THREE from 'three';

export const MATERIAL_LOOK = {
  smoothplastic: { roughness: 0.35, metalness: 0.05 },
  plastic: { roughness: 0.55, metalness: 0.03 },
  concrete: { roughness: 0.95, metalness: 0.0 },
  metal: { roughness: 0.3, metalness: 0.85 },
  wood: { roughness: 0.8, metalness: 0.0 },
  brick: { roughness: 0.9, metalness: 0.0 },
  grass: { roughness: 1.0, metalness: 0.0 },
  water: { roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.72 },
  neon: { roughness: 0.2, metalness: 0.1, emissiveScale: 0.85 },
  glass: { roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.4 },
  sand: { roughness: 1.0, metalness: 0.0 },
  fabric: { roughness: 0.9, metalness: 0.0 },
  slate: { roughness: 0.7, metalness: 0.1 },
  ice: { roughness: 0.15, metalness: 0.05, transparent: true, opacity: 0.65 },
  energy: { roughness: 0.1, metalness: 0.3, emissiveScale: 1.0 },
};

export function hexToNumber(hex, fallback = 0x9aa7bd) {
  if (typeof hex !== 'string') return fallback;
  const value = hex.trim().replace('#', '');
  const parsed = Number.parseInt(value.length === 3 ? value.replace(/(.)/g, '$1$1') : value, 16);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function createMaterialCache() {
  const materials = new Map();
  return function material(color, materialName = 'plastic', extra = {}) {
    const look = MATERIAL_LOOK[materialName] ?? MATERIAL_LOOK.plastic;
    const key = `${color}|${materialName}|${JSON.stringify(extra)}`;
    if (materials.has(key)) return materials.get(key);
    const base = hexToNumber(color);
    const created = new THREE.MeshStandardMaterial({
      color: base,
      roughness: look.roughness,
      metalness: look.metalness,
      transparent: Boolean(look.transparent || extra.opacity < 1),
      opacity: extra.opacity ?? look.opacity ?? 1,
      emissive: look.emissiveScale ? new THREE.Color(base).multiplyScalar(look.emissiveScale) : 0x000000,
      side: extra.side ?? THREE.FrontSide,
      flatShading: Boolean(extra.flatShading),
    });
    materials.set(key, created);
    return created;
  };
}

export function createGeometryCache() {
  const geometries = new Map();
  return function geometry(shape, size) {
    const key = `${shape}|${size.x.toFixed(2)}|${size.y.toFixed(2)}|${size.z.toFixed(2)}`;
    if (geometries.has(key)) return geometries.get(key);
    let created;
    switch (shape) {
      case 'sphere':
      case 'ball':
        created = new THREE.SphereGeometry(Math.max(size.x, size.y, size.z) / 2, 24, 16);
        break;
      case 'cylinder':
        created = new THREE.CylinderGeometry(size.x / 2, size.x / 2, size.y, 24);
        break;
      case 'wedge':
      case 'ramp':
        created = new THREE.CylinderGeometry(0, Math.max(size.x, size.z) / 2, size.y, 4, 1, false);
        break;
      case 'capsule':
        created = new THREE.CapsuleGeometry(size.x / 2, Math.max(0.01, size.y - size.x), 8, 16);
        break;
      default:
        created = new THREE.BoxGeometry(size.x, size.y, size.z);
    }
    created.computeBoundingSphere();
    geometries.set(key, created);
    return created;
  };
}

const CHARACTER_COLORS = {
  head: '#f4c98a',
  torso: '#3d5afe',
  arm: '#f4c98a',
  leg: '#243b6b',
};

/** Builds a three.js group for a character from a replicated state snapshot. */
export function createCharacterObject(THREE_, state = {}) {
  const group = new THREE.Group();
  const scale = state.scale ?? 1;
  const colors = state.colors ?? {};
  const materialFor = (kind) =>
    new THREE_.MeshStandardMaterial({
      color: hexToNumber(colors[kind] ?? CHARACTER_COLORS[kind] ?? CHARACTER_COLORS.torso),
      roughness: 0.6,
      metalness: 0.05,
    });
  const piece = (kind, size, position) => {
    const mesh = new THREE_.Mesh(new THREE_.BoxGeometry(size[0] * scale, size[1] * scale, size[2] * scale), materialFor(kind));
    mesh.position.set(position[0] * scale, position[1] * scale, position[2] * scale);
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  };
  const parts = {
    head: piece('head', [1.2, 1.2, 1.2], [0, 2.6, 0]),
    torso: piece('torso', [2, 2, 1], [0, 1.4, 0]),
    leftArm: piece('arm', [0.8, 2, 0.8], [-1.4, 1.4, 0]),
    rightArm: piece('arm', [0.8, 2, 0.8], [1.4, 1.4, 0]),
    leftLeg: piece('leg', [0.9, 2, 0.9], [-0.55, 0.1, 0]),
    rightLeg: piece('leg', [0.9, 2, 0.9], [0.55, 0.1, 0]),
  };
  const accessories = [];
  for (const item of state.accessories ?? []) {
    const attachment = item.attachment ?? {};
    const bone = parts[attachment.bone] ?? parts.torso;
    const shape = attachment.shape ?? 'block';
    const size = attachment.scale ?? [1, 1, 1];
    const mesh = new THREE_.Mesh(
      (shape === 'sphere' ? new THREE_.SphereGeometry(0.6 * size[0], 16, 12) : new THREE_.BoxGeometry(size[0], size[1], size[2])),
      new THREE_.MeshStandardMaterial({ color: hexToNumber(item.color ?? '#ffffff'), roughness: 0.4, metalness: 0.15 }),
    );
    if (attachment.offset) mesh.position.set(attachment.offset[0], attachment.offset[1], attachment.offset[2]);
    bone.add(mesh);
    accessories.push(mesh);
  }
  group.userData.parts = parts;
  group.userData.accessories = accessories;
  return group;
}

/** Simple procedural walk animation (no keyframe data needed). */
export function animateCharacter(object, { speed = 0, time = 0, state = 'idle' } = {}) {
  const parts = object.userData?.parts;
  if (!parts) return;
  const swing = state === 'idle' ? 0 : Math.sin(time * Math.min(14, 4 + speed)) * Math.min(0.9, speed / 10);
  parts.leftLeg.rotation.x = swing;
  parts.rightLeg.rotation.x = -swing;
  parts.leftArm.rotation.x = -swing * 0.8;
  parts.rightArm.rotation.x = swing * 0.8;
  const bob = state === 'idle' ? 0 : Math.abs(Math.sin(time * Math.min(14, 4 + speed))) * 0.08;
  parts.torso.position.y = (1.4 + bob);
  parts.head.position.y = (2.6 + bob);
}

/**
 * Builds a scene graph from a serialized world.
 *   world      — kinetiq.scene document
 *   options.onObject(instance, object3d) — called for every created object
 */
export function buildSceneFromWorld(THREE_, world, options = {}) {
  const root = new THREE_.Group();
  const material = createMaterialCache();
  const geometry = createGeometryCache();
  const objects = new Map();
  const lights = [];
  const skies = [];

  const addInstance = (instance, parent) => {
    const props = instance.properties ?? {};
    const cls = instance.className;
    let object = null;
    if (cls === 'Part' || cls === 'Mesh' || cls === 'VehicleSeat' || cls === 'Terrain') {
      const size = props.size ?? { x: 4, y: 1, z: 2 };
      const shape = props.shape ?? (cls === 'Terrain' ? 'block' : 'block');
      object = new THREE_.Mesh(
        geometry(shape, { x: size.x || 1, y: size.y || 1, z: size.z || 1 }),
        material(props.color ?? '#9aa7bd', props.material ?? 'plastic', {
          opacity: props.transparency !== undefined ? 1 - Number(props.transparency) : 1,
        }),
      );
      object.castShadow = props.castShadow !== false;
      object.receiveShadow = true;
      object.userData.size = size;
    } else if (cls === 'SpawnPoint') {
      object = new THREE_.Group();
      const pad = new THREE_.Mesh(
        new THREE_.CylinderGeometry(2.4, 2.4, 0.3, 24),
        new THREE_.MeshStandardMaterial({ color: 0x00e5c0, emissive: 0x0a6f61, transparent: true, opacity: 0.7 }),
      );
      object.add(pad);
      object.userData.spawn = true;
    } else if (cls === 'Light') {
      const light =
        props.lightType === 'directional'
          ? new THREE_.DirectionalLight(hexToNumber(props.color ?? '#ffffff'), Number(props.brightness ?? 1))
          : props.lightType === 'spot'
            ? new THREE_.SpotLight(hexToNumber(props.color ?? '#ffffff'), Number(props.brightness ?? 1))
            : new THREE_.PointLight(hexToNumber(props.color ?? '#ffffff'), Number(props.brightness ?? 1), Number(props.range ?? 30));
      object = light;
      lights.push(light);
    } else if (cls === 'Camera') {
      object = new THREE_.Group();
      object.userData.camera = props;
      skies.push(object);
    } else if (cls === 'Sound') {
      object = new THREE_.Group();
      object.userData.sound = props;
    } else if (cls === 'ParticleEmitter') {
      object = new THREE_.Points(
        new THREE_.BufferGeometry().setAttribute('position', new THREE_.Float32BufferAttribute(new Array(60).fill(0), 3)),
        new THREE_.PointsMaterial({ color: hexToNumber(props.color ?? '#ffffff'), size: Number(props.size ?? 0.5) }),
      );
      object.userData.emitter = props;
    } else if (cls === 'UIElement' || cls === 'Text' || cls === 'Image') {
      object = null; // rendered by the UI layer, not in 3D space
    } else {
      object = new THREE_.Group();
    }
    if (!object) return null;
    object.name = instance.name;
    object.userData.instanceId = instance.id;
    object.userData.className = cls;
    object.userData.tags = instance.tags ?? [];
    object.userData.properties = props;
    const position = props.position ?? { x: 0, y: 0, z: 0 };
    object.position.set(position.x, position.y, position.z);
    const rotation = props.rotation;
    if (rotation) object.rotation.set(rotation.x ?? 0, rotation.y ?? 0, rotation.z ?? 0);
    if (props.anchored !== undefined) object.userData.anchored = props.anchored;
    parent.add(object);
    objects.set(instance.id, object);
    options.onObject?.(instance, object);
    for (const child of instance.children ?? []) addInstance(child, object);
    return object;
  };

  for (const chunk of Object.values(world.chunks ?? {})) {
    for (const instance of chunk.roots ?? []) addInstance(instance, root);
  }
  if (world.root && Array.isArray(world.root) && !Object.keys(world.chunks ?? {}).length) {
    for (const instance of world.root) addInstance(instance, root);
  }

  return { root, objects, lights, skies };
}

export { THREE };
export default { buildSceneFromWorld, createCharacterObject, animateCharacter, hexToNumber, MATERIAL_LOOK };
