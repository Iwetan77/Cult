// Pictures people pick are resized in the browser before they're sent: small
// enough to store and send quickly, as a JPEG data URL (what the API takes).

function readImage(file: File): Promise<HTMLImageElement> {
  if (!file.type.startsWith('image/')) return Promise.reject(new Error('Pick an image file.'));
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read this image.')); };
    img.src = url;
  });
}

function draw(width: number, height: number, paint: (context: CanvasRenderingContext2D) => void, quality: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image editing is unavailable in this browser.');
  context.fillStyle = '#000'; // transparent PNGs come out on black, not JPEG's default
  context.fillRect(0, 0, width, height);
  paint(context);
  return canvas.toDataURL('image/jpeg', quality);
}

// A square crop from the centre: profile photos and cult images.
export async function squareImage(file: File, size = 256): Promise<string> {
  const image = await readImage(file);
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  return draw(size, size, context => context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, size, size), 0.85);
}

// The whole picture, its longest side at most `max` px: photos sent in chat.
export async function fittedImage(file: File, max = 1280): Promise<{ dataUrl: string; width: number; height: number }> {
  const image = await readImage(file);
  const scale = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  return { dataUrl: draw(width, height, context => context.drawImage(image, 0, 0, width, height), 0.8), width, height };
}
