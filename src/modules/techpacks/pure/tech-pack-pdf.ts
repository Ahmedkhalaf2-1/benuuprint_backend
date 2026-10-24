import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import type { TechPackContent } from './tech-pack-content.js';

/**
 * Server-side, deterministic PDF of a tech pack (PDFKit, no browser, no network). The creation date is the
 * generation time stored in the content and compression is off, so the same content always produces the
 * same bytes. Text uses the built-in Helvetica (Latin-1): characters outside it are replaced by "?" rather
 * than silently disappearing; the JSON content keeps the original text.
 *
 * The document is the FLOOR view (brand only, no customer identity), so the one stored PDF is safe for
 * assigned factory staff. When a job card QR URL is given it is drawn as vector squares.
 */
const MARGIN = 40;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
const latin = (v: string | number | boolean | null | undefined): string =>
  v === null || v === undefined || v === ''
    ? '-'
    : String(v)
        .replace(CONTROL, '')
        .replace(/[^\u0020-\u007e\u00a0-\u00ff\n]/g, '?');

export async function renderTechPackPdf(
  content: Omit<TechPackContent, 'customer' | 'jobCard'>,
  options: { qrUrl?: string | null },
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    compress: false,
    info: {
      Title: `${content.document.reference} v${content.document.version}`,
      Author: 'Benue Print',
      Subject: content.document.title,
      Keywords: `${content.document.reference}; version ${content.document.version}; ${content.document.kind}`,
      Producer: 'Benue Print backend',
      Creator: 'Benue Print backend',
      CreationDate: new Date(content.document.generatedAt),
      ModDate: new Date(content.document.generatedAt),
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const heading = (text: string) => {
    doc
      .moveDown(0.8)
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor('#000')
      .text(latin(text).toUpperCase());
    doc
      .moveTo(MARGIN, doc.y + 1)
      .lineTo(doc.page.width - MARGIN, doc.y + 1)
      .lineWidth(0.5)
      .stroke('#888');
    doc.moveDown(0.4).font('Helvetica').fontSize(9.5);
  };
  const row = (
    label: string,
    value: string | number | boolean | null | undefined,
  ) => {
    doc.font('Helvetica-Bold').text(`${latin(label)}: `, { continued: true });
    doc.font('Helvetica').text(latin(value));
  };

  // ── header ──
  doc.font('Helvetica-Bold').fontSize(18).text(latin(content.document.title));
  doc
    .font('Helvetica')
    .fontSize(10)
    .text(
      `${latin(content.document.reference)}  ·  Version ${content.document.version}  ·  Generated ${content.document.generatedAt.slice(0, 16).replace('T', ' ')} UTC`,
    );
  doc
    .fontSize(8.5)
    .fillColor('#444')
    .text(latin(content.document.note))
    .fillColor('#000');

  if (options.qrUrl) {
    const qr = QRCode.create(options.qrUrl, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    const cell = 2.6;
    const x0 = doc.page.width - MARGIN - n * cell;
    const y0 = MARGIN;
    doc.save();
    doc.rect(x0 - 4, y0 - 4, n * cell + 8, n * cell + 8).fill('#fff');
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        if (qr.modules.data[y * n + x])
          doc.rect(x0 + x * cell, y0 + y * cell, cell, cell).fill('#000');
    doc.restore();
    doc.fontSize(7).text('Scan: job card', x0, y0 + n * cell + 6, {
      width: n * cell,
      align: 'center',
    });
    doc.fillColor('#000');
    doc.x = MARGIN;
    doc.y = Math.max(doc.y, y0 + n * cell + 20);
  }

  // ── source ──
  heading('Source');
  row('Brand', content.brand?.name);
  row('Sample', content.source.sampleNumber);
  if (content.source.orderNumber) row('Order', content.source.orderNumber);
  row(
    'Specification',
    `${content.source.specification.kind} revision ${content.source.specification.revision} (hash ${content.source.specification.hash.slice(0, 12)})`,
  );
  if (content.source.orderSpecification)
    row(
      'Order specification',
      `revision ${content.source.orderSpecification.revision} (hash ${content.source.orderSpecification.hash.slice(0, 12)})`,
    );

  // ── product ──
  heading('Product and material');
  row('Product', (content.product as { name?: string }).name);
  row('Fabric', (content.fabric as { name?: string }).name);
  const composition = (content.fabric as { composition?: string }).composition;
  if (composition) row('Composition', composition);
  row('Colour', content.color?.name);
  row(
    'Pantone / hex',
    `${latin(content.color?.pantone)} / ${latin(content.color?.hex)}`,
  );
  row('GSM', content.gsm);
  row('Fabric provider', content.fabricProvider);
  row('Sample size', (content.sampleSize as { name?: string } | null)?.name);

  // ── fit ──
  heading('Fit and pattern');
  row('Fit method', content.fit.method);
  const pv = content.fit.patternVersion as {
    code?: string;
    name?: string;
    versionNumber?: number;
  } | null;
  row(
    'Pattern',
    pv ? `${pv.code ?? ''} ${pv.name ?? ''} v${pv.versionNumber ?? ''}` : null,
  );
  row(
    'Size charts',
    content.fit.sizeCharts.length
      ? `${content.fit.sizeCharts.length} file(s)`
      : null,
  );

  // ── decoration ──
  heading('Decoration and artwork');
  if (content.decorations.length === 0) doc.text('None');
  (content.decorations as Record<string, any>[]).forEach((dd, i) => {
    doc
      .font('Helvetica-Bold')
      .text(`${i + 1}. ${latin(dd.printMethod?.name)}`, { continued: true });
    doc
      .font('Helvetica')
      .text(
        `  ${latin(dd.placement)} · ${latin(dd.side)} · ${latin(dd.width)}x${latin(dd.height)} ${latin(dd.unit)} · ${latin(dd.colorCount)} colour(s)`,
      );
    if (dd.artwork)
      doc.text(
        `   Artwork: ${latin(dd.artwork.name)} v${latin(dd.artwork.versionNumber)}${dd.artwork.file ? ` (${latin(dd.artwork.file.originalName)})` : ''}`,
      );
    if (dd.notes) doc.text(`   Notes: ${latin(dd.notes)}`);
  });

  // ── accessories, labels ──
  heading('Accessories, labels and packaging components');
  const parts = [
    ...content.accessories,
    ...content.labelsAndPackaging,
  ] as Record<string, any>[];
  if (parts.length === 0) doc.text('None');
  for (const p of parts)
    doc.text(
      `- ${latin(p.name)}${p.quantity ? ` x${p.quantity}` : ''}${p.category ? ` [${latin(p.category)}]` : ''}${p.notes ? ` - ${latin(p.notes)}` : ''}`,
    );

  // ── order ──
  if (content.order) {
    heading('Order quantities');
    row('Total quantity', content.order.totalQuantity);
    row('Priority', content.order.priority);
    row('Target delivery', content.order.targetDeliveryDate);
    for (const item of content.order.items) {
      doc
        .font('Helvetica-Bold')
        .text(`${latin(item.productName)}: ${item.quantity} units`)
        .font('Helvetica');
      for (const v of item.variants)
        doc.text(
          `   ${latin(v.size)} / ${latin(v.color)}${(v as any).pantone ? ` (${latin((v as any).pantone)})` : ''}: ${v.quantity}`,
        );
    }
  }
  if (content.packaging) {
    heading('Packaging specification');
    const pk = content.packaging;
    row('Folding', pk.foldingInstructions);
    row(
      'Polybag / labels / hang tags / stickers',
      [
        pk.polybagRequired,
        pk.labelsRequired,
        pk.hangTagsRequired,
        pk.stickersRequired,
      ]
        .map((b) => (b ? 'yes' : 'no'))
        .join(' / '),
    );
    row('Units per carton', pk.unitsPerCarton);
    row('Carton notes', pk.cartonNotes);
    row('Special instructions', pk.specialInstructions);
    for (const c of pk.components)
      doc.text(
        `- ${latin(c.name)}${c.quantityPerUnit ? ` x${c.quantityPerUnit} per unit` : ''}${c.notes ? ` - ${latin(c.notes)}` : ''}`,
      );
  }

  // ── instructions + QC ──
  heading('Factory instructions');
  const instr = Object.entries(
    content.instructions as Record<string, string>,
  ).filter(([, v]) => v);
  if (instr.length === 0) doc.text('None');
  for (const [k, v] of instr) row(k, v);
  heading('Quality control requirements');
  if (content.qcRequirements.length === 0) doc.text('None configured');
  for (const q of content.qcRequirements) {
    doc
      .font('Helvetica-Bold')
      .text(`${latin(q.stageName)} (${latin(q.templateCode)} v${q.version})`)
      .font('Helvetica');
    for (const it of q.items)
      doc.text(
        `   [${it.required ? 'x' : ' '}] ${latin(it.label)} (${latin(it.resultType)})`,
      );
  }
  if (content.jobs.length) {
    heading('Jobs');
    for (const j of content.jobs)
      doc.text(
        `- ${latin(j.jobNumber)}${j.batchNumber ? ` (${latin(j.batchNumber)})` : ''}`,
      );
  }
  doc.end();
  return done;
}
