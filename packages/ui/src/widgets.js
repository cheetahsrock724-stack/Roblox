/**
 * UI widgets: turns a UI instance's properties into a DOM node.
 *
 * The same code renders screen UI in the game client and inside the editor's UI preview, so what a
 * creator sees while building is exactly what players get.
 */
import { applyConstraints, computeBox, layoutChildren, resolveUdim2, uiScale } from './layout.js';

const FONTS = {
  sans: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  rounded: 'ui-rounded, "Segoe UI", system-ui, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  serif: 'Georgia, "Times New Roman", serif',
  display: '"Trebuchet MS", system-ui, sans-serif',
};

export const UI_CLASSES = [
  'Frame', 'TextLabel', 'TextButton', 'ImageLabel', 'InputField', 'ScrollingList', 'ProgressBar', 'Viewport',
];

export function createUiNode(className, properties = {}, { document: doc = globalThis.document } = {}) {
  const node = doc.createElement(className === 'TextButton' ? 'button' : className === 'ImageLabel' ? 'div' : 'div');
  node.className = `game-ui-node ui-${className.toLowerCase()}`;
  node.dataset.uiClass = className;
  return node;
}

function color(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/** Applies visual properties (colour, borders, text, images, progress…) to a node. */
export function styleUiNode(node, className, properties, { scale = 1 } = {}) {
  const background = color(properties.background, '#1b2233');
  const transparency = Number(properties.backgroundTransparency ?? 0);
  if (className !== 'ImageLabel') {
    node.style.background = transparency >= 1 ? 'transparent' : background;
    node.style.opacity = String(Math.max(0, 1 - Math.max(0, transparency)));
  }
  node.style.border = Number(properties.borderWidth ?? 0) > 0
    ? `${Number(properties.borderWidth)}px solid ${color(properties.borderColor, '#3d5afe')}`
    : 'none';
  node.style.borderRadius = `${Number(properties.cornerRadius ?? 8)}px`;
  node.style.zIndex = String(Number(properties.zIndex ?? 1));
  node.style.display = properties.visible === false ? 'none' : 'block';
  node.style.overflow = 'hidden';

  const responsive = properties.responsive !== false;
  const factor = responsive ? scale : 1;

  if (className === 'TextLabel' || className === 'TextButton') {
    node.textContent = String(properties.text ?? (className === 'TextButton' ? 'Button' : 'Label'));
    node.style.color = color(properties.textColor, '#eef2ff');
    node.style.fontSize = `${Number(properties.textSize ?? 18) * factor}px`;
    node.style.fontFamily = FONTS[properties.font] ?? FONTS.sans;
    node.style.fontWeight = properties.bold ? '700' : '400';
    node.style.textAlign = properties.textAlign ?? 'left';
    node.style.whiteSpace = properties.textWrap === false ? 'nowrap' : 'pre-wrap';
    if (className === 'TextButton') {
      node.style.cursor = properties.enabled === false ? 'not-allowed' : 'pointer';
      node.disabled = properties.enabled === false;
      node.style.border = 'none';
    }
  } else if (className === 'ImageLabel') {
    node.style.backgroundImage = properties.assetId ? `url("${properties.assetId}")` : 'none';
    node.style.backgroundSize = properties.preserveAspect === false ? '100% 100%' : 'contain';
    node.style.backgroundRepeat = 'no-repeat';
    node.style.backgroundPosition = 'center';
    node.style.opacity = String(Math.max(0, 1 - Number(properties.imageTransparency ?? 0)));
  } else if (className === 'InputField') {
    if (node.tagName !== 'INPUT') {
      node.dataset.inputfield = 'true';
    }
    node.textContent = '';
    node.style.color = color(properties.textColor, '#eef2ff');
    node.style.fontSize = `${Number(properties.textSize ?? 16) * factor}px`;
  } else if (className === 'ScrollingList') {
    node.style.overflow = properties.scrollDirection === 'horizontal' ? 'auto hidden' : 'auto';
    node.style.display = 'flex';
    node.style.flexDirection = properties.scrollDirection === 'horizontal' ? 'row' : 'column';
    node.style.gap = `${Number(properties.spacing ?? 6) * factor}px`;
    node.style.padding = `${Number(properties.padding ?? 8) * factor}px`;
  } else if (className === 'ProgressBar') {
    const value = Math.max(0, Math.min(1, Number(properties.value ?? 0.5)));
    node.style.background = 'rgba(255,255,255,0.14)';
    node.style.position = 'relative';
    let fill = node.querySelector('.ui-progress-fill');
    if (!fill) {
      fill = node.ownerDocument.createElement('div');
      fill.className = 'ui-progress-fill';
      fill.style.height = '100%';
      fill.style.transition = 'width 120ms linear';
      node.append(fill);
    }
    fill.style.width = `${value * 100}%`;
    fill.style.background = color(properties.fillColor, '#00e5c0');
    if (properties.showText) {
      let label = node.querySelector('.ui-progress-text');
      if (!label) {
        label = node.ownerDocument.createElement('span');
        label.className = 'ui-progress-text';
        label.style.position = 'absolute';
        label.style.inset = '0';
        label.style.display = 'grid';
        label.style.placeItems = 'center';
        label.style.fontSize = `${12 * factor}px`;
        node.append(label);
      }
      label.textContent = `${Math.round(value * 100)}%`;
    }
  } else if (className === 'Viewport') {
    node.style.background = '#05080f';
    node.style.border = '1px solid rgba(255,255,255,0.12)';
  }
  return node;
}

/**
 * Lays a node out inside its parent, honouring UDim2 position/size, anchor points, padding and
 * UIConstraint-style limits.
 */
export function positionUiNode(node, properties, parentBox, viewport, scale = 1) {
  let box = computeBox(properties, parentBox, viewport, scale);
  box = applyConstraints(box, properties);
  node.style.position = 'absolute';
  node.style.left = `${Math.round(box.x)}px`;
  node.style.top = `${Math.round(box.y)}px`;
  node.style.width = `${Math.round(box.width)}px`;
  node.style.height = `${Math.round(box.height)}px`;
  return box;
}

export { computeBox, layoutChildren, resolveUdim2, uiScale, applyConstraints };
export default { UI_CLASSES, createUiNode, styleUiNode, positionUiNode };
