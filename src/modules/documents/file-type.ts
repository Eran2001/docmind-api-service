import { extname } from "node:path";

export interface DetectedFile {
  kind: "pdf" | "doc" | "docx" | "txt" | "md";
  mimeType: string;
  /** With the dot, e.g. ".pdf". Chosen by us from what the bytes are, not taken from the upload. */
  extension: string;
}

const MIME = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
} as const;

/**
 * Decides what an upload really is by looking at its BYTES (the extension and the browser's mime type are only hints, and
 * can be faked): a PDF starts with "%PDF-", a DOCX is a zip that contains word/document.xml, a DOC has the OLE header
 * and WordDocument stream name, and text/markdown must be valid UTF-8 without NUL bytes. Returns null otherwise.
 */
export function detectFile(
  data: Buffer,
  filename: string,
): DetectedFile | null {
  if (data.length === 0) return null;
  const ext = extname(filename).toLowerCase();

  if (data.subarray(0, 1024).includes("%PDF-")) {
    return ext === ".pdf" || ext === ""
      ? { kind: "pdf", mimeType: MIME.pdf, extension: ".pdf" }
      : null;
  }

  const isZip =
    data[0] === 0x50 &&
    data[1] === 0x4b &&
    data[2] === 0x03 &&
    data[3] === 0x04;
  if (isZip) {
    // File names inside a zip are stored uncompressed, so this is a cheap, reliable check for a Word document.
    return ext === ".docx" && data.includes("word/document.xml")
      ? { kind: "docx", mimeType: MIME.docx, extension: ".docx" }
      : null;
  }

  const isOleCompoundFile = data
    .subarray(0, 8)
    .equals(Buffer.from("D0CF11E0A1B11AE1", "hex"));
  const hasWordDocumentStream = data.includes(
    Buffer.from("WordDocument", "utf16le"),
  );
  if (ext === ".doc" && isOleCompoundFile && hasWordDocumentStream) {
    return { kind: "doc", mimeType: MIME.doc, extension: ".doc" };
  }

  if (ext === ".txt" || ext === ".md") {
    if (data.includes(0)) return null;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      return null;
    }
    return ext === ".md"
      ? { kind: "md", mimeType: MIME.md, extension: ".md" }
      : { kind: "txt", mimeType: MIME.txt, extension: ".txt" };
  }
  return null;
}

/** A safe display name: no path, no control characters, at most 200 characters. */
export function cleanFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f]/g,
      "",
    )
    .trim()
    .slice(0, 200);
  return cleaned || "document";
}
