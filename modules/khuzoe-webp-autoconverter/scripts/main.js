const MODULE_ID = "khuzoe-webp-autoconverter";
const QUALITY_SETTING = "webpQuality";
const PATCH_MARKER = Symbol.for("khuzoe-webp-autoconverter.file-picker-upload");

Hooks.once("init", () => {
  registerSettings();
});

Hooks.once("ready", () => {
  patchFilePickerUpload();
});

function registerSettings() {
  game.settings.register(MODULE_ID, QUALITY_SETTING, {
    name: "Qualità WebP (0-100)",
    hint: "Qualità di compressione usata per creare il WebP durante l'upload. 85 è consigliato.",
    scope: "world",
    config: true,
    type: Number,
    default: 85,
    range: { min: 1, max: 100, step: 1 }
  });
}

function patchFilePickerUpload() {
  const FilePickerClass = getFilePickerClass();
  const originalUpload = FilePickerClass?.upload;

  if (typeof originalUpload !== "function") {
    console.error(`[${MODULE_ID}] API FilePicker V14 non disponibile: conversione automatica disattivata.`);
    return false;
  }
  if (originalUpload[PATCH_MARKER]) return true;

  // Foundry V14 uses five arguments: source, path, file, body and options.
  // Keeping both trailing objects intact is important for S3 and custom upload
  // backends, which may add fields to the request body.
  async function patchedUpload(source, path, file, body = {}, options = {}) {
    let fileToSend = file;
    try {
      fileToSend = (await maybeConvertToWebp(file)) ?? file;
    } catch (error) {
      console.warn(`[${MODULE_ID}] Conversione WebP fallita; verrà caricato il file originale.`, error);
    }

    return originalUpload.call(this, source, path, fileToSend, body, options);
  }

  Object.defineProperty(patchedUpload, PATCH_MARKER, { value: true });
  FilePickerClass.upload = patchedUpload;
  return true;
}

function getFilePickerClass() {
  return globalThis.foundry?.applications?.apps?.FilePicker?.implementation
    ?? globalThis.CONFIG?.ux?.FilePicker
    ?? null;
}

async function maybeConvertToWebp(file) {
  if (!file || typeof file.name !== "string") return null;

  const lowerName = file.name.toLowerCase();
  const mime = String(file.type || "").toLowerCase();
  if (lowerName.endsWith(".webp") || mime === "image/webp") return null;

  const isTargetFormat = /\.(png|jpe?g)$/i.test(lowerName)
    || mime === "image/png"
    || mime === "image/jpeg";
  if (!isTargetFormat) return null;

  const img = await loadImageFromFile(file);
  const width = Number(img.naturalWidth || img.width);
  const height = Number(img.naturalHeight || img.height);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error("L'immagine non ha dimensioni valide.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Impossibile ottenere il contesto 2D per la conversione.");
    context.drawImage(img, 0, 0);

    const configuredQuality = Number(game.settings.get(MODULE_ID, QUALITY_SETTING));
    const quality = clamp(configuredQuality / 100, 0.01, 1);
    const blob = await canvasToWebp(canvas, quality);
    const newName = replaceExtension(file.name, ".webp");

    return new File([blob], newName, {
      type: "image/webp",
      lastModified: Number(file.lastModified) || Date.now()
    });
  } finally {
    // Release the potentially large backing buffer as soon as conversion ends.
    canvas.width = 1;
    canvas.height = 1;
  }
}

function canvasToWebp(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(result => {
      if (result?.type === "image/webp") return resolve(result);
      reject(new Error("Il browser non ha prodotto un WebP valido."));
    }, "image/webp", quality);
  });
}

function loadImageFromFile(file) {
  const objectUrl = URL.createObjectURL(file);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.addEventListener("load", () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    }, { once: true });
    img.addEventListener("error", () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(`Errore durante la lettura dell'immagine: ${file.name}`));
    }, { once: true });
    img.src = objectUrl;
  });
}

function replaceExtension(fileName, extension) {
  const lastSeparator = Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\"));
  const lastDot = fileName.lastIndexOf(".");
  const baseName = lastDot > lastSeparator ? fileName.slice(0, lastDot) : fileName;
  return `${baseName}${extension}`;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return 0.85;
  return Math.min(Math.max(value, min), max);
}
