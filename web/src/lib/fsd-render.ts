import fs from "fs";
import path from "path";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { workspaceRoot } from "@/lib/workspace";

const TEMPLATE_PATH = path.join(process.cwd(), "templates", "fsd-template.docx");

// A literal value only this code ever sets as the process_flow_diagram tag's
// data — never something the agent writes — so after docxtemplater renders
// it we can find the one run that holds it and splice in a real <w:drawing>
// in its place. Deliberately NOT using a third-party docxtemplater image
// module here: the only maintained-looking free one pulls in xmldom@0.1.x,
// which carries multiple unpatched critical CVEs (XML injection, DoS via
// uncontrolled recursion). Splicing OOXML directly needs nothing but pizzip,
// which we already depend on.
const DIAGRAM_SENTINEL = "@@FSD_PROCESS_FLOW_DIAGRAM@@";
const DIAGRAM_RUN_NEEDLE = `<w:r><w:t xml:space="preserve">${DIAGRAM_SENTINEL}</w:t></w:r>`;
const MAX_DIAGRAM_WIDTH_EMU = 6 * 914400; // 6in, inside this template's margins
const EMU_PER_PX = 9525; // at the conventional 96dpi

export function sessionFsdDataPath(sessionId: string) {
  return path.join(workspaceRoot(), "sessions", sessionId, "fsd-data.json");
}

function pngPixelSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("Not a PNG file");
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function nextRelationshipId(relsXml: string): string {
  const ids = [...relsXml.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  return `rId${(ids.length ? Math.max(...ids) : 0) + 1}`;
}

function drawingRunXml(rId: string, pxWidth: number, pxHeight: number): string {
  const naturalCx = pxWidth * EMU_PER_PX;
  const scale = Math.min(1, MAX_DIAGRAM_WIDTH_EMU / naturalCx);
  const cx = Math.round(naturalCx * scale);
  const cy = Math.round(pxHeight * EMU_PER_PX * scale);

  return (
    "<w:r><w:drawing>" +
    `<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    '<wp:docPr id="1" name="ProcessFlowDiagram"/>' +
    "<wp:cNvGraphicFramePr>" +
    '<a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>' +
    "</wp:cNvGraphicFramePr>" +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    "<pic:nvPicPr>" +
    '<pic:cNvPr id="0" name="ProcessFlowDiagram.png"/>' +
    "<pic:cNvPicPr/>" +
    "</pic:nvPicPr>" +
    "<pic:blipFill>" +
    `<a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${rId}"/>` +
    "<a:stretch><a:fillRect/></a:stretch>" +
    "</pic:blipFill>" +
    "<pic:spPr>" +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    "<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom>" +
    "</pic:spPr>" +
    "</pic:pic>" +
    "</a:graphicData>" +
    "</a:graphic>" +
    "</wp:inline>" +
    "</w:drawing></w:r>"
  );
}

/** Splices a real inline image into the already-rendered zip in place of the
 *  one run holding DIAGRAM_SENTINEL — adds the media file, a relationship,
 *  and (if missing) the png content-type default. No-op if the sentinel
 *  wasn't used (no diagram this turn) or the PNG can't be read. */
function embedDiagram(zip: PizZip, pngPath: string): void {
  if (!fs.existsSync(pngPath)) return;
  const documentXml = zip.file("word/document.xml")?.asText();
  if (!documentXml || !documentXml.includes(DIAGRAM_RUN_NEEDLE)) return;

  const pngBuf = fs.readFileSync(pngPath);
  const { width, height } = pngPixelSize(pngBuf);

  zip.file("word/media/process_flow_diagram.png", pngBuf);

  const contentTypesXml = zip.file("[Content_Types].xml")!.asText();
  if (!contentTypesXml.includes('Extension="png"')) {
    zip.file(
      "[Content_Types].xml",
      contentTypesXml.replace(
        /<Types xmlns="[^"]*">/,
        (m) => `${m}<Default Extension="png" ContentType="image/png"/>`,
      ),
    );
  }

  const relsPath = "word/_rels/document.xml.rels";
  const relsXml = zip.file(relsPath)!.asText();
  const rId = nextRelationshipId(relsXml);
  zip.file(
    relsPath,
    relsXml.replace(
      "</Relationships>",
      `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/process_flow_diagram.png"/></Relationships>`,
    ),
  );

  zip.file("word/document.xml", documentXml.replace(DIAGRAM_RUN_NEEDLE, drawingRunXml(rId, width, height)));
}

export function renderFsd(data: Record<string, unknown>, diagramPngPath?: string): Buffer {
  const content = fs.readFileSync(TEMPLATE_PATH, "binary");
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: "{{", end: "}}" },
  });
  doc.render({ ...data, process_flow_diagram: diagramPngPath ? DIAGRAM_SENTINEL : "" });

  const renderedZip = doc.getZip();
  if (diagramPngPath) embedDiagram(renderedZip, diagramPngPath);

  return renderedZip.generate({ type: "nodebuffer" });
}

/**
 * If the fsd-writer agent left a sessions/<id>/fsd-data.json behind this turn,
 * render it against the canonical template and write the .docx alongside it.
 * Returns the generated filename (for linkifyGeneratedFiles-style backtick
 * references), or undefined if there was nothing to render.
 */
export function renderFsdForSession(sessionId: string, sinceMs?: number): string | undefined {
  const dataPath = sessionFsdDataPath(sessionId);
  if (!fs.existsSync(dataPath)) return undefined;
  // Guard against re-rendering (and re-linking) a file left over from an
  // earlier, unrelated turn in the same session.
  if (sinceMs !== undefined && fs.statSync(dataPath).mtimeMs < sinceMs) return undefined;

  const data = JSON.parse(fs.readFileSync(dataPath, "utf-8")) as Record<string, unknown>;
  const sessionDir = path.join(workspaceRoot(), "sessions", sessionId);
  const diagramPath = path.join(sessionDir, "process_flow.png");
  const buffer = renderFsd(data, fs.existsSync(diagramPath) ? diagramPath : undefined);

  const filename = `${(data.doc_code as string | undefined)?.trim() || "Functional_Specification"}.docx`.replace(
    /[/\\]/g,
    "_",
  );
  fs.writeFileSync(path.join(sessionDir, filename), buffer);
  return filename;
}
