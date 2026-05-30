import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocale } from '../hooks/useLocale.jsx';
import { fmtDate, ConfirmModal, toast } from './shared.jsx';
import {
  getAttachments, uploadAttachment, deleteAttachment, attachmentURL,
} from '../api/client.js';

const MAX_BYTES = 15 * 1024 * 1024;

// Mirror of the backend allowlist — drives the file picker + a fast client-side
// guard so obvious rejects never hit the network. The server re-validates.
const ACCEPT =
  '.pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt,' +
  'application/pdf,image/png,image/jpeg,image/gif,image/webp,' +
  'application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,' +
  'application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,' +
  'text/csv,text/plain';

const ALLOWED_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt'];

function fileIcon(ct = '', name = '') {
  const s = (ct + ' ' + name).toLowerCase();
  if (s.includes('pdf')) return '📄';
  if (s.includes('image') || /\.(png|jpe?g|gif|webp)$/.test(s)) return '🖼️';
  if (s.includes('sheet') || s.includes('excel') || /\.(xlsx?|csv)$/.test(s)) return '📊';
  if (s.includes('word') || /\.docx?$/.test(s)) return '📝';
  return '📎';
}

function humanSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Reusable attachments panel for any business entity.
 *
 *   <Attachments entityType="invoices" entityId={inv.id} canEdit={canEditInvoices} />
 *
 * `entityType` must be a key the backend ENTITY_REGISTRY knows about. `canEdit`
 * gates the upload + delete controls (it should reflect the host module's
 * `edit` permission); the backend enforces the same rule regardless.
 */
export default function Attachments({ entityType, entityId, canEdit = false, compact = false }) {
  const { t } = useLocale();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState(null);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    if (!entityId) return;
    setLoading(true);
    try {
      setItems(await getAttachments(entityType, entityId));
    } catch (e) {
      toast(e.message || t('attachments.loadError'), 'red');
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId, t]);

  useEffect(() => { load(); }, [load]);

  async function onPick(e) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = '';   // allow re-picking same file
    if (!file) return;

    const name = file.name.toLowerCase();
    if (!ALLOWED_EXT.some(ext => name.endsWith(ext))) {
      toast(t('attachments.unsupported'), 'red');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast(t('attachments.tooLarge'), 'red');
      return;
    }
    setBusy(true);
    try {
      await uploadAttachment(entityType, entityId, file);
      toast(t('attachments.uploaded'), 'green');
      await load();
    } catch (err) {
      toast(err.message || t('attachments.uploadError'), 'red');
    } finally {
      setBusy(false);
    }
  }

  async function doDelete(id) {
    setConfirmId(null);
    try {
      await deleteAttachment(id);
      toast(t('attachments.deleted'), 'green');
      setItems(prev => prev.filter(a => a.id !== id));
    } catch (err) {
      toast(err.message || t('common.error'), 'red');
    }
  }

  return (
    <div style={{ marginTop: compact ? 0 : 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
        <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--text-1)', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
          </svg>
          {t('attachments.title')}
          {items.length > 0 && (
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-3)', background: 'var(--surface-2, var(--accent-light))', borderRadius: 20, padding: '1px 8px' }}>
              {items.length}
            </span>
          )}
        </h4>
        {canEdit && (
          <>
            <input ref={fileRef} type="file" accept={ACCEPT} onChange={onPick} style={{ display: 'none' }} />
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              {busy ? t('attachments.uploading') : `＋ ${t('attachments.add')}`}
            </button>
          </>
        )}
      </div>

      {loading ? (
        <p style={{ fontSize: 12.5, color: 'var(--text-3)', margin: '6px 0' }}>{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p style={{ fontSize: 12.5, color: 'var(--text-3)', margin: '6px 0', fontStyle: 'italic' }}>
          {t('attachments.empty')}
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map(a => (
            <div key={a.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
              border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)',
            }}>
              <span style={{ fontSize: 18, lineHeight: 1 }}>{fileIcon(a.content_type, a.filename)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <a
                  href={attachmentURL(a.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', textDecoration: 'none', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={a.filename}
                >
                  {a.filename}
                </a>
                <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  {humanSize(a.size_bytes)} · {fmtDate(a.created_at)}
                  {a.uploaded_by_name ? ` · ${a.uploaded_by_name}` : ''}
                </div>
              </div>
              <a
                href={attachmentURL(a.id, true)}
                className="icon-btn"
                title={t('attachments.download')}
                style={{ textDecoration: 'none' }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
              </a>
              {canEdit && (
                <button
                  type="button"
                  className="icon-btn"
                  title={t('common.delete')}
                  onClick={() => setConfirmId(a.id)}
                  style={{ color: 'var(--red)' }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {confirmId != null && (
        <ConfirmModal
          title={t('attachments.title')}
          message={t('attachments.deleteConfirm')}
          confirmLabel={t('common.delete')}
          confirmClass="btn-danger"
          onConfirm={() => doDelete(confirmId)}
          onCancel={() => setConfirmId(null)}
        />
      )}
    </div>
  );
}
