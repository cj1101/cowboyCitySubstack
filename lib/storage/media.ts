const IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
const MAX_EDGE = 1920;

export function mediaKind(file: File): "image" | "video" | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  const name = file.name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif)$/.test(name)) return "image";
  if (/\.(mp4|webm|mov|m4v)$/.test(name)) return "video";
  return null;
}

export function mediaContentType(file: File): string {
  if (file.type.startsWith("image/") || file.type.startsWith("video/")) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".webm")) return "video/webm";
  if (name.endsWith(".mov")) return "video/quicktime";
  if (/\.(mp4|m4v)$/.test(name)) return "video/mp4";
  return "image/jpeg";
}

export function assertMediaFile(file: File): void {
  const kind = mediaKind(file);
  if (kind === "image") {
    if (file.size >= IMAGE_MAX_BYTES) {
      throw new Error("Images must be under 12 MB before upload.");
    }
    return;
  }
  if (kind === "video") {
    if (file.size >= VIDEO_MAX_BYTES) {
      throw new Error("Videos must be under 100 MB.");
    }
    return;
  }
  throw new Error("Only photos and videos can be attached.");
}

export async function compressImage(file: File): Promise<File> {
  if (mediaKind(file) !== "image" || file.type === "image/gif" || file.name.toLowerCase().endsWith(".gif")) return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) return file;
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
  bitmap.close();
  if (!blob) return file;
  const name = file.name.replace(/\.\w+$/, "") || "image";
  return new File([blob], `${name}.jpg`, { type: "image/jpeg" });
}

export function captureVideoThumbnail(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    const finish = (blob: Blob | null) => {
      URL.revokeObjectURL(url);
      if (blob) resolve(blob);
      else reject(new Error("Could not capture a video thumbnail."));
    };
    video.onloadeddata = () => {
      const target = Number.isFinite(video.duration) ? Math.min(0.25, video.duration / 2) : 0;
      if (target > 0) video.currentTime = target;
      else draw();
    };
    video.onseeked = () => draw();
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that video."));
    };
    function draw() {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 360;
      const context = canvas.getContext("2d");
      if (!context) {
        finish(null);
        return;
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => finish(blob), "image/jpeg", 0.8);
    }
  });
}
