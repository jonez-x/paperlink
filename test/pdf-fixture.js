// A minimal valid PDF with one page per [width, height, rotate?] in points and a line
// of text on each, so tests need no binary fixture files.
export function makePdf(sizes) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  sizes.forEach(([width, height, rotate = 0], index) => {
    const text = 'BT /F1 24 Tf 72 ' + (height - 96) + ' Td (Exercise ' + (index + 1) + ') Tj ET';
    objects.push('<< /Length ' + text.length + ' >>\nstream\n' + text + '\nendstream');
    const content = objects.length;
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + width + ' ' + height + '] /Rotate ' + rotate + ' /Contents ' + content + ' 0 R /Resources << /Font << /F1 3 0 R >> >> >>');
    kids.push(objects.length + ' 0 R');
  });
  objects[1] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + kids.length + ' >>';
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, index) => {
    const offset = pdf.length;
    pdf += (index + 1) + ' 0 obj\n' + body + '\nendobj\n';
    return offset;
  });
  const xref = pdf.length;
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n' + offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(pdf, 'latin1');
}
