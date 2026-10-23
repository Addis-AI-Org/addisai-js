import { camelize } from "../core/camelize.js";
import { AddisAIError, APIConnectionError } from "../core/errors.js";
import type { RequestOptions, Transport } from "../core/request.js";
import { toBlob, type Uploadable } from "../core/uploads.js";

/** Files at or below this size go in one multipart request. */
const DIRECT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
/** Largest batch input file the API accepts. */
const SIGNED_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

export type FilePurpose =
  | "batch_input"
  | "batch_output"
  | "batch_error"
  | "batch_audio_output";

export interface FileObject {
  id: string;
  object: "file";
  purpose: FilePurpose;
  filename: string;
  contentType: string;
  bytes: number;
  status: "pending" | "ready" | "deleted";
  batchId: string | null;
  lineCount: number | null;
  createdAt: string;
  expiresAt: string;
}

export interface FileUploadParams {
  /** Only "batch_input" can be uploaded. Default "batch_input". */
  purpose?: "batch_input";
  /** Name shown in the dashboard. Defaults to the Blob/File name or "input.jsonl". */
  filename?: string;
}

export interface SignedUpload {
  file: FileObject;
  upload: {
    method: "PUT";
    url: string;
    headers: Record<string, string>;
    expiresAt: string;
  };
}

export class Files {
  constructor(private readonly transport: Transport) {}

  /**
   * Upload a batch input file (JSONL). Small files go in one request; larger
   * ones (up to 100 MB) use a signed upload straight to storage. Resolves once
   * the file is ready to use in `batches.create`.
   */
  async upload(
    file: Uploadable,
    params: FileUploadParams = {},
    opts: RequestOptions = {},
  ): Promise<FileObject> {
    const { blob, filename: inferred } = toBlob(file, "application/jsonl");
    const filename = params.filename ?? (inferred === "file" ? "input.jsonl" : inferred);
    const purpose = params.purpose ?? "batch_input";

    if (blob.size > SIGNED_UPLOAD_MAX_BYTES) {
      throw new AddisAIError("Batch input files are limited to 100 MB. Split the batch.");
    }

    if (blob.size <= DIRECT_UPLOAD_MAX_BYTES) {
      const form = new FormData();
      form.append("purpose", purpose);
      form.append("file", blob, filename);
      const body = await this.transport.request<Record<string, unknown>>(
        { method: "POST", path: "/api/v1/files", form },
        opts,
      );
      return camelize<FileObject>(body);
    }

    const signed = await this.createSignedUpload(
      { filename, bytes: blob.size, contentType: blob.type || "application/jsonl" },
      opts,
    );
    let put: Response;
    try {
      // No API key here: the signed URL carries its own authorization.
      put = await this.transport.fetch(signed.upload.url, {
        method: "PUT",
        headers: signed.upload.headers,
        body: blob,
      });
    } catch (err) {
      throw new APIConnectionError("Upload to storage failed.", err);
    }
    await put.body?.cancel();
    if (!put.ok) {
      throw new AddisAIError(`Upload to storage failed with status ${put.status}.`);
    }
    return this.complete(signed.file.id, opts);
  }

  /** Start a signed upload (for callers that PUT the bytes themselves). */
  async createSignedUpload(
    params: { filename: string; bytes: number; contentType?: string },
    opts: RequestOptions = {},
  ): Promise<SignedUpload> {
    const body = await this.transport.request<Record<string, unknown>>(
      {
        method: "POST",
        path: "/api/v1/files",
        body: {
          purpose: "batch_input",
          filename: params.filename,
          bytes: params.bytes,
          content_type: params.contentType ?? "application/jsonl",
        },
      },
      opts,
    );
    const { upload, ...file } = body as { upload: Record<string, unknown> } & Record<string, unknown>;
    return { file: camelize<FileObject>(file), upload: camelize(upload) };
  }

  /** Finish a signed upload once the bytes are stored. */
  async complete(fileId: string, opts: RequestOptions = {}): Promise<FileObject> {
    const body = await this.transport.request<Record<string, unknown>>(
      { method: "POST", path: `/api/v1/files/${encodeURIComponent(fileId)}/complete` },
      opts,
    );
    return camelize<FileObject>(body);
  }

  async retrieve(fileId: string, opts: RequestOptions = {}): Promise<FileObject> {
    const body = await this.transport.request<Record<string, unknown>>(
      { method: "GET", path: `/api/v1/files/${encodeURIComponent(fileId)}` },
      opts,
    );
    return camelize<FileObject>(body);
  }

  async delete(fileId: string, opts: RequestOptions = {}): Promise<FileObject> {
    const body = await this.transport.request<Record<string, unknown>>(
      { method: "DELETE", path: `/api/v1/files/${encodeURIComponent(fileId)}` },
      opts,
    );
    return camelize<FileObject>(body);
  }

  /** A signed download URL, valid for about five minutes. */
  async contentUrl(fileId: string, opts: RequestOptions = {}): Promise<string> {
    const response = await this.transport.request<Response>(
      {
        method: "GET",
        path: `/api/v1/files/${encodeURIComponent(fileId)}/content`,
        raw: true,
        redirect: "manual",
      },
      opts,
    );
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location) {
      throw new AddisAIError("The file download link was not returned.");
    }
    return location;
  }

  /** Download a file's bytes (result JSONL, error JSONL or generated audio). */
  async content(fileId: string, opts: RequestOptions = {}): Promise<ArrayBuffer> {
    const url = await this.contentUrl(fileId, opts);
    let response: Response;
    try {
      response = await this.transport.fetch(url, { signal: opts.signal });
    } catch (err) {
      throw new APIConnectionError("Download from storage failed.", err);
    }
    if (!response.ok) {
      throw new AddisAIError(`Download from storage failed with status ${response.status}.`);
    }
    return response.arrayBuffer();
  }
}
