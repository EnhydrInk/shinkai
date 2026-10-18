import { characters } from './characters.js';
export function drawCharacter(context, name, x, y, scale = 1) {
  if (!Number.isInteger(scale) || scale < 1) throw new Error('Integer scale required');
  const sprite = characters[name];
  if (!sprite) throw new Error('Unknown character');
  context.imageSmoothingEnabled = false;
  sprite.pixels.forEach((row, py) => row.forEach((color, px) => {
    if (color) { context.fillStyle = color; context.fillRect(x + px * scale, y + py * scale, scale, scale); }
  }));
}
