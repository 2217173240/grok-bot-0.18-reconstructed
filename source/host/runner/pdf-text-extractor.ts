import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const loadingTask = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const document = await loadingTask.promise;
  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      let pageText = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        pageText += item.str;
        pageText += item.hasEOL ? "\n" : " ";
      }
      pages.push(pageText.trimEnd());
    }
    return pages.join("\n");
  } finally {
    await document.destroy();
  }
}
