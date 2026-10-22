import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

/** Plain text out of an uploaded file. Types are checked by knowledge-service on upload. */
export async function extractFileText(fileName: string, data: Buffer): Promise<string> {
  const extension = fileName.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "pdf": {
      const parser = new PDFParse({ data: new Uint8Array(data) });
      try {
        // Page breaks become paragraph breaks for the chunker.
        const result = await parser.getText({ pageJoiner: "\n\n" });
        return result.text;
      } finally {
        await parser.destroy();
      }
    }
    case "docx": {
      const result = await mammoth.extractRawText({ buffer: data });
      return result.value;
    }
    case "txt":
    case "md":
    case "csv":
      return data.toString("utf8");
    default:
      throw new Error(`Unsupported file type: .${extension}`);
  }
}
