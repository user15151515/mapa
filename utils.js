// utils.js

export function formatDateISO(iso) {
  // iso: yyyy-mm-dd
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, (m - 1), d);
  return dt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

export function monthKeyFromISO(iso) {
  // returns yyyy-mm
  return iso?.slice(0, 7) ?? "";
}

export function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

export function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 2600);
}

export function safeText(s, fallback="—") {
  return (s && String(s).trim()) ? String(s) : fallback;
}

export function stars(n) {
  const v = Number(n);
  if (!v) return "—";
  return "⭐".repeat(clamp(v, 1, 5));
}

/**
 * Client-side image compression/resizing
 * - resizes longest side to maxSide px
 * - outputs JPEG blob with quality (0..1)
 */
export async function compressImage(file, { maxSide = 1600, quality = 0.82 } = {}) {
  if (!file) throw new Error("No file");
  const img = await fileToImage(file);

  const { width, height } = img;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const outW = Math.round(width * scale);
  const outH = Math.round(height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;

  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, outW, outH);

  const blob = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", quality)
  );

  if (!blob) throw new Error("Compression failed");
  return blob;
}

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image load failed")); };
    img.src = url;
  });
}

export function debounce(fn, ms = 250) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
