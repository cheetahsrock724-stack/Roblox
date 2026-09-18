/**
 * Screen-UI renderer shared by the game client, the editor preview and the launcher shell.
 *
 * Given a tree of UI instances (a serialized world's `UI` service, or live `ui` frames from the
 * realm) it renders DOM nodes, keeps them laid out as the viewport resizes, and forwards player
 * interactions back to the game server as UI events.
 */
import { UI_CLASSES, createUiNode, positionUiNode, styleUiNode, uiScale, layoutChildren, applyConstraints, computeBox } from './widgets.js';

export class UiLayer {
  /**
   * @param {object} options
   * @param {HTMLElement} options.container  element that fills the viewport
   * @param {(event: object) => void} [options.onEvent] receives {type, instanceId, value?}
   * @param {object} [options.document]
   */
  constructor({ container, onEvent = null, document: doc = globalThis.document } = {}) {
    this.container = container;
    this.onEvent = onEvent;
    this.document = doc;
    this.nodes = new Map();
    this.tree = new Map();
    this.instances = new Map();
    this.base = doc.createElement('div');
    this.base.className = 'game-ui-layer';
    this.base.style.position = 'absolute';
    this.base.style.inset = '0';
    this.base.style.pointerEvents = 'none';
    this.base.style.overflow = 'hidden';
    container.append(this.base);
    this.onResize = () => this.render();
    globalThis.addEventListener?.('resize', this.onResize);
  }

  /** Replaces the whole UI tree (used when a world loads). */
  setInstances(instances = []) {
    this.instances = new Map(instances.map((instance) => [instance.id, instance]));
    this.tree = new Map();
    for (const instance of instances) {
      const parentId = instance.parentId ?? null;
      if (!this.tree.has(parentId)) this.tree.set(parentId, []);
      this.tree.get(parentId).push(instance);
    }
    this.render();
  }

  /** Applies a live update frame: create/update/remove individual UI nodes. */
  applyUpdates(updates = []) {
    let changed = false;
    for (const update of updates) {
      if (update.remove || update.destroyed) {
        this.instances.delete(update.id);
        this.nodes.get(update.id)?.remove();
        this.nodes.delete(update.id);
        changed = true;
        continue;
      }
      const existing = this.instances.get(update.id);
      const merged = { ...(existing ?? { id: update.id, className: update.className ?? 'Frame', properties: {} }), ...update };
      merged.properties = { ...(existing?.properties ?? {}), ...(update.properties ?? {}) };
      this.instances.set(update.id, merged);
      changed = true;
    }
    if (changed) {
      this.rebuildTree();
      this.render();
    }
  }

  rebuildTree() {
    this.tree = new Map();
    for (const instance of this.instances.values()) {
      const parentId = instance.parentId ?? null;
      if (!this.tree.has(parentId)) this.tree.set(parentId, []);
      this.tree.get(parentId).push(instance);
    }
  }

  /** Creates (or refreshes) the DOM node for one instance. */
  ensureNode(instance) {
    let node = this.nodes.get(instance.id);
    const className = instance.className ?? 'Frame';
    if (!node) {
      node = createUiNode(className, instance.properties ?? {}, { document: this.document });
      node.dataset.instanceId = instance.id;
      this.nodes.set(instance.id, node);
      this.bindEvents(node, instance);
    }
    if (className === 'InputField') {
      // Inputs are real <input> elements so typing, selection and IME work natively.
      if (node.tagName !== 'INPUT') {
        const input = this.document.createElement('input');
        input.className = 'game-ui-node ui-inputfield';
        input.dataset.instanceId = instance.id;
        input.maxLength = Number(instance.properties?.maxLength ?? 120);
        input.placeholder = instance.properties?.placeholder ?? '';
        input.value = instance.properties?.text ?? '';
        input.addEventListener('input', () => this.onEvent?.({ type: 'textChanged', instanceId: instance.id, value: input.value }));
        input.addEventListener('focus', () => this.onEvent?.({ type: 'focusGained', instanceId: instance.id }));
        node.replaceWith(input);
        this.nodes.set(instance.id, input);
        node = input;
      } else {
        node.maxLength = Number(instance.properties?.maxLength ?? 120);
        node.placeholder = instance.properties?.placeholder ?? '';
      }
    }
    return node;
  }

  bindEvents(node, instance) {
    const properties = instance.properties ?? {};
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      if (properties.enabled === false) return;
      this.onEvent?.({ type: 'clicked', instanceId: instance.id, className: instance.className });
      this.onEvent?.({
        type: 'buttonClicked',
        instanceId: instance.id,
        button: 0,
        position: { x: event.offsetX, y: event.offsetY },
      });
    });
    node.addEventListener('mouseenter', () => this.onEvent?.({ type: 'mouseEnter', instanceId: instance.id }));
    node.addEventListener('mouseleave', () => this.onEvent?.({ type: 'mouseLeave', instanceId: instance.id }));
  }

  /** Recomputes layout for the current viewport size. */
  render() {
    const rect = this.container.getBoundingClientRect();
    const width = rect.width || this.document.defaultView?.innerWidth || 1280;
    const height = rect.height || this.document.defaultView?.innerHeight || 720;
    const scale = uiScale(width, height);
    const rootBox = { x: 0, y: 0, width, height };
    this.renderBranch(null, rootBox, rootBox, scale);
  }

  renderBranch(parentId, parentBox, rootBox, scale) {
    const children = this.tree.get(parentId) ?? [];
    if (!children.length) {
      if (parentId === null && !this.emptyNotice) {
        this.emptyNotice = this.document.createElement('div');
        this.emptyNotice.className = 'game-ui-empty';
      }
      return;
    }
    const container = parentId ? this.nodes.get(parentId) : this.base;
    if (!container) return;
    if (parentId) container.style.overflow = 'visible';

    // Author-defined automatic layout (ScrollingList) takes over child positions.
    const parentInstance = parentId ? this.instances.get(parentId) : null;
    const layoutMode = parentInstance?.properties?.automaticLayout;
    let boxes = children.map((child) => ({ child, box: computeBox(child.properties ?? {}, parentBox, rootBox, scale) }));
    if (layoutMode && layoutMode !== 'none') {
      boxes = layoutChildren(boxes, parentBox, {
        layout: layoutMode,
        direction: parentInstance?.properties?.scrollDirection === 'horizontal' ? 'horizontal' : 'vertical',
        padding: Number(parentInstance?.properties?.padding ?? 8),
        spacing: Number(parentInstance?.properties?.spacing ?? 6),
        columns: 3,
      });
    }

    const seen = new Set();
    for (const { child, box } of boxes) {
      const node = this.ensureNode(child);
      seen.add(child.id);
      const props = child.properties ?? {};
      const finalBox = applyConstraints(box, props);
      Object.assign(node.style, {
        position: 'absolute',
        left: `${Math.round(finalBox.x - (parentId ? parentBox.x : 0))}px`,
        top: `${Math.round(finalBox.y - (parentId ? parentBox.y : 0))}px`,
        width: `${Math.round(finalBox.width)}px`,
        height: `${Math.round(finalBox.height)}px`,
      });
      styleUiNode(node, child.className, props, { scale });
      if (!node.isConnected) (container === this.base ? this.base : container).append(node);
      this.renderBranch(child.id, finalBox, rootBox, scale);
    }
    for (const [id, node] of this.nodes) {
      const instance = this.instances.get(id);
      if (instance && instance.parentId === parentId && !seen.has(id)) node.remove();
    }
  }

  destroy() {
    globalThis.removeEventListener?.('resize', this.onResize);
    this.base.remove();
    this.nodes.clear();
    this.instances.clear();
    this.tree.clear();
  }
}

/** Flattens a serialized UI subtree (from a scene's `UI` service) into the layer's flat format. */
export function flattenUiInstances(serviceNode) {
  const out = [];
  const walk = (node, parentId) => {
    if (!node) return;
    if (UI_CLASSES.includes(node.className)) {
      out.push({ id: node.id, className: node.className, parentId, properties: node.properties ?? {} });
      for (const child of node.children ?? []) walk(child, node.id);
    } else {
      for (const child of node.children ?? []) walk(child, parentId);
    }
  };
  for (const child of serviceNode?.children ?? []) walk(child, null);
  return out;
}

export function createUiLayer(options) {
  return new UiLayer(options);
}

export { UI_CLASSES, styleUiNode, uiScale, layoutChildren };
export default { UiLayer, createUiLayer, flattenUiInstances, UI_CLASSES };
