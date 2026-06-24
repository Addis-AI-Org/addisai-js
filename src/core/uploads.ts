// File input coercion for multipart/form-data requests (STT, chat attachments).

export type Uploadable =
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | FileInput;

export interface FileInput {
  /** Raw bytes or a Blob. */
  data: Blob | ArrayBuffer | ArrayBufferView;
  /** Filename sent to the API; helps the server infer format. */
  filename?: string;
  /** MIME type, e.g. "audio/wav". Strongly recommended. */
  contentType?: string;
}

function isFileInput(value: unknown): value is FileInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "data" in (value as any)
  );
}

/** Coerce any supported input into a Blob suitable for FormData. */
export function toBlob(input: Uploadable, fallbackType = "application/octet-stream"): {
  blob: Blob;
  filename: string;
} {
  if (isFileInput(input)) {
    const type = input.contentType ?? fallbackType;
    const blob = input.data instanceof Blob
      ? (input.contentType ? new Blob([input.data], { type }) : input.data)
      : new Blob([input.data as BlobPart], { type });
    return { blob, filename: input.filename ?? "file" };
  }
  if (input instanceof Blob) {
    return { blob: input, filename: (input as File).name || "file" };
  }
  return { blob: new Blob([input as BlobPart], { type: fallbackType }), filename: "file" };
}

/**
 * Read a file from disk into a FileInput (Node/Bun/Deno only). Convenience for
 * `audio: await fileFromPath("./call.wav")`.
 */
export async function fileFromPath(path: string, contentType?: string): Promise<FileInput> {
  // Lazy import so the SDK stays runtime-agnostic and browser-safe.
  const fs = await import("node:fs/promises");
  const data = await fs.readFile(path);
  const filename = path.split(/[\\/]/).pop() || "file";
  return {
    data: new Uint8Array(data),
    filename,
    contentType: contentType ?? guessContentType(filename),
  };
}

function guessContentType(filename: string): string | undefined {
  const ext = filename.toLowerCase().split(".").pop();
  switch (ext) {
    case "wav": return "audio/wav";
    case "mp3": return "audio/mpeg";
    case "m4a": return "audio/m4a";
    case "mp4": return "audio/mp4";
    case "ogg": return "audio/ogg";
    case "webm": return "audio/webm";
    case "flac": return "audio/flac";
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "pdf": return "application/pdf";
    default: return undefined;
  }
}
