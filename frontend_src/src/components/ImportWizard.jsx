import { useState, useEffect, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { Modal, toast } from './shared';
import { useLocale } from '../hooks/useLocale.jsx';
import { getImportSchema, validateImport, commitImport } from '../api/client';

// Normalise a header for fuzzy auto-mapping: "Phone Number" ≈ "phone_number".
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const STATUS_COLORS = {
  ok: 'green', created: 'green', duplicate: 'yellow',
  skipped: 'yellow', error: 'red', failed: 'red',
};

function Badge({ status, label }) {
  const c = STATUS_COLORS[status] || 'gray';
  return <span className={`badge badge-${c}`}>{label || status}</span>;
}

// Reusable CSV/Excel import dialog. `entity` ∈ clients | suppliers | inventory.
// `onDone` is called after a commit that created at least one record so the
// parent list can reload.
export default function ImportWizard({ entity, title, onClose, onDone }) {
  const { t } = useLocale();
  const [fields, setFields]   = useState(null);   // schema fields
  const [step, setStep]       = useState('upload');
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState([]);
  const [rawRows, setRawRows] = useState([]);     // array of arrays
  const [mapping, setMapping] = useState({});     // fieldKey -> header index ('' = ignore)
  const [onDup, setOnDup]     = useState('skip');
  const [busy, setBusy]       = useState(false);
  const [preview, setPreview] = useState(null);
  const [result, setResult]   = useState(null);

  useEffect(() => {
    getImportSchema(entity)
      .then(s => setFields(s.fields))
      .catch(e => { toast(e.message || 'Failed to load schema', 'red'); onClose(); });
  }, [entity]);

  // Build the mapped row objects from the chosen column mapping.
  const mappedRows = useMemo(() => {
    if (!fields) return [];
    return rawRows.map(r => {
      const o = {};
      for (const f of fields) {
        const idx = mapping[f.key];
        if (idx !== '' && idx != null) o[f.key] = r[idx];
      }
      return o;
    });
  }, [rawRows, mapping, fields]);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const wb  = XLSX.read(buf, { type: 'array' });
      const ws  = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
      const hdr = (aoa[0] || []).map(h => String(h).trim());
      const rows = aoa.slice(1).filter(r => r.some(c => String(c).trim() !== ''));
      if (!hdr.length || !rows.length) { toast(t('imports.emptyFile'), 'red'); return; }
      // Auto-map: match each field to a header by normalised key/label.
      const auto = {};
      for (const f of fields) {
        const want = [norm(f.key), norm(f.label)];
        const hit = hdr.findIndex(h => want.includes(norm(h)));
        auto[f.key] = hit >= 0 ? hit : '';
      }
      setFileName(file.name); setHeaders(hdr); setRawRows(rows);
      setMapping(auto); setStep('map');
    } catch (err) {
      toast((err.message || 'Could not read file') + '', 'red');
    }
  }

  function downloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([fields.map(f => f.label)]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Template');
    XLSX.writeFile(wb, `${entity}-import-template.xlsx`);
  }

  const requiredMapped = useMemo(
    () => !fields ? false : fields.filter(f => f.required).every(f => mapping[f.key] !== '' && mapping[f.key] != null),
    [fields, mapping]);

  async function runValidate() {
    setBusy(true);
    try {
      const r = await validateImport(entity, { rows: mappedRows, on_duplicate: onDup });
      setPreview(r); setStep('preview');
    } catch (e) { toast(e.message || 'Validation failed', 'red'); }
    finally { setBusy(false); }
  }

  async function runCommit() {
    setBusy(true);
    try {
      const r = await commitImport(entity, { rows: mappedRows, on_duplicate: onDup });
      setResult(r); setStep('done');
      if (r.created > 0 && onDone) onDone();
    } catch (e) { toast(e.message || 'Import failed', 'red'); }
    finally { setBusy(false); }
  }

  const steps = [
    ['upload', t('imports.step1')], ['map', t('imports.step2')],
    ['preview', t('imports.step3')], ['done', t('imports.step4')],
  ];
  const stepIdx = steps.findIndex(s => s[0] === step);

  return (
    <Modal title={title || t('imports.title')} onClose={onClose} size="modal-lg">
      <div className="modal-body">
        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap' }}>
          {steps.map(([key, label], i) => (
            <div key={key} style={{
              display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
              color: i === stepIdx ? 'var(--accent)' : i < stepIdx ? 'var(--text-2)' : 'var(--text-3)',
              fontWeight: i === stepIdx ? 700 : 500,
            }}>
              <span style={{
                width: 20, height: 20, borderRadius: '50%', display: 'inline-flex',
                alignItems: 'center', justifyContent: 'center', fontSize: 11,
                background: i <= stepIdx ? 'var(--accent)' : 'var(--surface-2)',
                color: i <= stepIdx ? '#fff' : 'var(--text-3)',
              }}>{i < stepIdx ? '✓' : i + 1}</span>
              {label}{i < steps.length - 1 && <span style={{ color: 'var(--text-3)', marginInlineStart: 4 }}>›</span>}
            </div>
          ))}
        </div>

        {!fields ? <p style={{ color: 'var(--text-3)' }}>{t('common.loading')}</p> : (
          <>
            {/* ── Step 1: upload ── */}
            {step === 'upload' && (
              <div>
                <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 14 }}>{t('imports.fileHint')}</p>
                <input type="file" accept=".csv,.xlsx,.xls" className="form-control" onChange={handleFile} />
                <div style={{ marginTop: 16 }}>
                  <button className="btn btn-secondary btn-sm" onClick={downloadTemplate}>⬇ {t('imports.downloadTemplate')}</button>
                  <span style={{ fontSize: 12, color: 'var(--text-3)', marginInlineStart: 10 }}>{t('imports.templateHint')}</span>
                </div>
              </div>
            )}

            {/* ── Step 2: map columns ── */}
            {step === 'map' && (
              <div>
                <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 4 }}>
                  <strong>{fileName}</strong> — {t('imports.parsedRows', { count: rawRows.length })}
                </p>
                <p style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 14 }}>{t('imports.mapHint')}</p>
                <div className="table-wrap" style={{ maxHeight: 320, overflow: 'auto' }}>
                  <table>
                    <thead><tr>
                      <th>{t('imports.field')}</th><th>{t('imports.column')}</th>
                    </tr></thead>
                    <tbody>
                      {fields.map(f => (
                        <tr key={f.key}>
                          <td>
                            {f.label}{f.required && <span style={{ color: 'var(--red)' }}> *</span>}
                            {f.hint && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{f.hint}</div>}
                          </td>
                          <td>
                            <select className="form-control" value={mapping[f.key] ?? ''}
                              onChange={e => setMapping(m => ({ ...m, [f.key]: e.target.value === '' ? '' : Number(e.target.value) }))}>
                              <option value="">{t('imports.ignore')}</option>
                              {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!requiredMapped && (
                  <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{t('imports.mapRequired')}</p>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
                  <label style={{ fontSize: 13, color: 'var(--text-2)' }}>{t('imports.onDuplicate')}</label>
                  <select className="form-control" style={{ width: 200 }} value={onDup} onChange={e => setOnDup(e.target.value)}>
                    <option value="skip">{t('imports.dupSkip')}</option>
                    <option value="error">{t('imports.dupError')}</option>
                  </select>
                </div>
              </div>
            )}

            {/* ── Step 3: preview ── */}
            {step === 'preview' && preview && (
              <div>
                <div style={{ display: 'flex', gap: 14, marginBottom: 12, fontSize: 13, flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--green)' }}>● {preview.ok} {t('imports.ok')}</span>
                  <span style={{ color: 'var(--yellow)' }}>● {preview.duplicates} {t('imports.duplicate')}</span>
                  <span style={{ color: 'var(--red)' }}>● {preview.errors} {t('imports.error')}</span>
                </div>
                <PreviewTable rows={preview.rows} t={t} />
              </div>
            )}

            {/* ── Step 4: done ── */}
            {step === 'done' && result && (
              <div>
                <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
                  ✅ {t('imports.resultSummary', { created: result.created, skipped: result.skipped, failed: result.failed })}
                </p>
                {result.failed > 0 && (
                  <PreviewTable rows={result.rows.filter(r => r.status === 'failed')} t={t} />
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>
          {step === 'done' ? t('imports.close') : t('common.cancel')}
        </button>
        {step === 'map' && (
          <button className="btn btn-primary" disabled={!requiredMapped || busy} onClick={runValidate}>
            {busy ? t('imports.validating') : t('imports.next')}
          </button>
        )}
        {step === 'preview' && (
          <>
            <button className="btn btn-secondary" onClick={() => setStep('map')}>{t('imports.back')}</button>
            <button className="btn btn-primary" disabled={busy || !preview?.ok} onClick={runCommit}>
              {busy ? t('imports.importing') : t('imports.runImport', { count: preview?.ok || 0 })}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

// Best human label for a previewed row across entities (clients/accounts use
// `name`, employees `full_name`, …); falls back to the first non-empty value.
function _label(p) {
  if (!p) return '';
  return p.name || p.full_name || (p.code ? `${p.code} ${p.name || ''}`.trim() : '')
    || Object.values(p).find(v => v != null && v !== '') || '';
}

function PreviewTable({ rows, t }) {
  const shown = rows.slice(0, 200);
  return (
    <div className="table-wrap" style={{ maxHeight: 340, overflow: 'auto' }}>
      <table>
        <thead><tr>
          <th style={{ width: 60 }}>{t('imports.row')}</th>
          <th style={{ width: 110 }}>{t('imports.status')}</th>
          <th>{t('imports.details')}</th>
        </tr></thead>
        <tbody>
          {shown.map(r => (
            <tr key={r.index}>
              <td className="text-mono">{r.index + 1}</td>
              <td><Badge status={r.status} label={t('imports.' + r.status)} /></td>
              <td style={{ fontSize: 12, color: r.errors ? 'var(--red)' : 'var(--text-2)' }}>
                {r.errors ? r.errors.join('; ') : (r.note || _label(r.preview))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && (
        <p style={{ fontSize: 12, color: 'var(--text-3)', padding: '8px 4px' }}>
          {t('imports.andMore', { count: rows.length - shown.length })}
        </p>
      )}
    </div>
  );
}
