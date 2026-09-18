/**
 * UI layout maths.
 *
 * Screen UI uses UDim2 values: `[scaleX, offsetX, scaleY, offsetY]`. Scale is relative to the
 * parent's content box, which keeps interfaces usable on every screen size, and `responsive`
 * elements additionally scale their text/padding with the viewport (see `uiScale`).
 */

export const BASE_VIEWPORT = { width: 1280, height: 720 };

/** Screen-space scale factor for a viewport (1.0 at the 1280x720 reference resolution). */
export function uiScale(width, height, { clampMin = 0.68, clampMax = 1.6 } = {}) {
  const scale = Math.sqrt((width * height) / (BASE_VIEWPORT.width * BASE_VIEWPORT.height));
  return Math.min(clampMax, Math.max(clampMin, scale));
}

function udimPairs(value) {
  if (Array.isArray(value) && value.length >= 4) return value;
  if (Array.isArray(value) && value.length === 2) return [value[0].scale ?? 0, value[0].offset ?? 0, value[1].scale ?? 0, value[1].offset ?? 0];
  if (value && typeof value === 'object') return [value.xScale ?? 0, value.xOffset ?? 0, value.yScale ?? 0, value.yOffset ?? 0];
  return [0, 0, 0, 0];
}

/** Resolves a UDim2 into pixels inside a parent box. */
export function resolveUdim2(value, box, { includeOffset = true } = {}) {
  const [sx, ox, sy, oy] = udimPairs(value);
  return {
    x: sx * box.width + (includeOffset ? ox : 0),
    y: sy * box.height + (includeOffset ? oy : 0),
  };
}

/** Converts a UI instance into an absolute box (position + size) in viewport pixels. */
export function computeBox(properties, parentBox, viewport, scale = 1) {
  const position = resolveUdim2(properties.position ?? [0, 0, 0, 0], parentBox);
  const size = resolveUdim2(properties.size ?? [0.3, 0, 0.1, 0], parentBox);
  const anchor = properties.anchorPoint ?? { x: 0, y: 0 };
  const offsetX = -anchor.x * size.x;
  const offsetY = -anchor.y * size.y;
  const width = Math.max(0, size.x);
  const height = Math.max(0, size.y);
  void viewport;
  void scale;
  return { x: position.x + offsetX, y: position.y + offsetY, width, height };
}

/** Applies UIConstraint-style limits to a box. */
export function applyConstraints(box, properties = {}) {
  const next = { ...box };
  if (typeof properties.maxWidth === 'number') next.width = Math.min(next.width, properties.maxWidth);
  if (typeof properties.minWidth === 'number') next.width = Math.max(next.width, properties.minWidth);
  if (typeof properties.maxHeight === 'number') next.height = Math.min(next.height, properties.maxHeight);
  if (typeof properties.minHeight === 'number') next.height = Math.max(next.height, properties.minHeight);
  if (properties.aspectRatio && next.height > 0) next.width = next.height * Number(properties.aspectRatio);
  return next;
}

/**
 * Lays children out inside a container.
 *
 * `layout: 'list'` stacks children (padding/spacing respected, `direction` vertical or horizontal),
 * `layout: 'grid'` wraps them into columns, `none` leaves explicit positions untouched.
 */
export function layoutChildren(children, parentBox, { layout = 'none', direction = 'vertical', padding = 8, spacing = 6, columns = 3 } = {}) {
  const content = {
    x: parentBox.x + padding,
    y: parentBox.y + padding,
    width: Math.max(0, parentBox.width - padding * 2),
    height: Math.max(0, parentBox.height - padding * 2),
  };
  if (layout === 'none') return children.map((child) => child);
  let cursor = 0;
  let rowHeight = 0;
  const columnWidth = layout === 'grid' ? (content.width - spacing * (columns - 1)) / columns : content.width;
  let index = 0;
  return children.map((child) => {
    const childBox = { ...child.box };
    if (layout === 'grid') {
      const column = index % columns;
      const row = Math.floor(index / columns);
      childBox.x = content.x + column * (columnWidth + spacing);
      childBox.y = content.y + row * (rowHeight + spacing);
      childBox.width = columnWidth;
      rowHeight = Math.max(rowHeight, childBox.height);
    } else if (direction === 'horizontal') {
      childBox.x = content.x + cursor;
      childBox.y = content.y;
      childBox.height = childBox.height || content.height;
      cursor += childBox.width + spacing;
    } else {
      childBox.x = content.x;
      childBox.y = content.y + cursor;
      childBox.width = childBox.width || content.width;
      cursor += childBox.height + spacing;
    }
    index += 1;
    return { ...child, box: childBox };
  });
}
