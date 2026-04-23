import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

/**
 * Pure-Node PPTX parser. No LibreOffice, no Python.
 * A .pptx is a zip containing:
 *   ppt/slides/slideN.xml             — structured slide content (text, tables, shapes)
 *   ppt/slides/_rels/slideN.xml.rels  — links to media/notes for that slide
 *   ppt/notesSlides/notesSlideN.xml   — speaker notes
 *   ppt/media/image*.png|jpg|...      — embedded images (backgrounds, charts, rate-card images)
 *   ppt/theme/theme1.xml              — typography/color cues
 *
 * Returns:
 *   {
 *     sha256, slide_count, title, theme,
 *     slides: [{
 *       number, rawText, speakerNotes, images: [{name, buffer, contentType, refId}]
 *     }]
 *   }
 */
export async function parsePptx(filePath) {
  const data = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const zip = await JSZip.loadAsync(data);

  const xml = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: true,
    parseTagValue: false,
    parseAttributeValue: false,
    textNodeName: '#text',
  });

  // Discover slide files + keep natural order (slide1.xml, slide2.xml, ...)
  const slideFiles = Object.keys(zip.files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNum(a) - slideNum(b));

  const slides = [];
  for (const slideFile of slideFiles) {
    const number = slideNum(slideFile);
    const slideXml = await zip.file(slideFile).async('string');
    const rawText = extractText(xml.parse(slideXml));

    // Speaker notes
    let speakerNotes = '';
    const notesFile = `ppt/notesSlides/notesSlide${number}.xml`;
    if (zip.file(notesFile)) {
      const notesXml = await zip.file(notesFile).async('string');
      speakerNotes = extractText(xml.parse(notesXml));
    }

    // Image relationships for this slide
    const relsFile = `ppt/slides/_rels/slide${number}.xml.rels`;
    const images = [];
    if (zip.file(relsFile)) {
      const relsXml = await zip.file(relsFile).async('string');
      const rels = xml.parse(relsXml);
      const relationships = toArray(rels?.Relationships?.Relationship);
      for (const r of relationships) {
        const type = r['@_Type'] || '';
        if (!type.includes('/image')) continue;
        const target = r['@_Target'] || '';
        const mediaName = target.replace(/^\.\.\//, 'ppt/').replace(/^ppt\/ppt\//, 'ppt/');
        const cleanName = mediaName.startsWith('ppt/') ? mediaName : `ppt/${mediaName.replace(/^\//, '')}`;
        const mediaEntry = zip.file(cleanName) || zip.file(cleanName.replace('ppt/', ''));
        if (!mediaEntry) continue;
        const buffer = await mediaEntry.async('nodebuffer');
        const ext = path.extname(cleanName).toLowerCase().replace('.', '');
        const contentType = mimeFromExt(ext);
        if (!contentType) continue; // skip unsupported formats (EMF/WMF — not Vision-readable)
        images.push({
          name: path.basename(cleanName),
          refId: r['@_Id'] || '',
          contentType,
          buffer,
        });
      }
    }

    slides.push({ number, rawText, speakerNotes, images });
  }

  // Presentation title (often in core.xml or theme)
  let title = path.basename(filePath, '.pptx');
  const coreFile = zip.file('docProps/core.xml');
  if (coreFile) {
    const coreXml = await coreFile.async('string');
    const core = xml.parse(coreXml);
    const t = firstText(core?.['cp:coreProperties']?.['dc:title']);
    if (t) title = t;
  }

  return {
    sha256,
    slide_count: slides.length,
    title,
    slides,
  };
}

function slideNum(name) {
  const m = name.match(/slide(\d+)\.xml$/);
  return m ? parseInt(m[1], 10) : 0;
}

function toArray(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

function firstText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (typeof node['#text'] === 'string') return node['#text'];
  return '';
}

/**
 * Recursively walk a parsed PPTX XML tree and collect text from <a:t> nodes,
 * preserving paragraph breaks from <a:p> and table-cell structure from <a:tc>.
 */
function extractText(node, out = { buf: '', inPara: false, inCell: false }) {
  if (node == null) return out.buf;
  if (Array.isArray(node)) {
    for (const v of node) extractText(v, out);
    return out.buf;
  }
  if (typeof node === 'string') {
    out.buf += node;
    return out.buf;
  }
  if (typeof node !== 'object') return out.buf;

  // Table cell boundary
  if (Object.prototype.hasOwnProperty.call(node, 'a:tc')) {
    const cells = toArray(node['a:tc']);
    for (let i = 0; i < cells.length; i++) {
      extractText(cells[i], out);
      if (i < cells.length - 1) out.buf += ' | ';
    }
    out.buf += '\n';
  }

  for (const [k, v] of Object.entries(node)) {
    if (k === 'a:tc') continue; // already handled
    if (k === 'a:p') {
      const paras = toArray(v);
      for (const p of paras) {
        extractText(p, out);
        out.buf += '\n';
      }
      continue;
    }
    if (k === 'a:t') {
      const texts = toArray(v);
      for (const t of texts) {
        if (typeof t === 'string') out.buf += t;
        else if (t && typeof t['#text'] === 'string') out.buf += t['#text'];
      }
      continue;
    }
    if (k.startsWith('@_') || k === '#text') continue;
    extractText(v, out);
  }
  return out.buf;
}

function mimeFromExt(ext) {
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  return map[ext] || null;
}
