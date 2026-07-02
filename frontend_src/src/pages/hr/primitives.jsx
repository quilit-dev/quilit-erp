import { useLocale } from '../../hooks/useLocale.jsx';
import { fmtDate } from '../../components/shared';
import { employeeFileURL } from '../../api/client';

function Field({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14 }}>{value}</div>
    </div>
  );
}
function Section({ title, right, children }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    borderBottom: '1px solid var(--border)', paddingBottom: 6, marginBottom: 10 }}>
        <h4 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.5px',
                     color: 'var(--text-3)', margin: 0 }}>{title}</h4>
        {right}
      </div>
      {children}
    </div>
  );
}
function FileSlot({ label, file, canEdit, uploading, onPick, onDelete }) {
  const { t } = useLocale();
  return (
    <div style={{
      padding: '12px', border: '1px dashed var(--border)', borderRadius: 'var(--radius)',
      background: file ? 'var(--surface)' : 'transparent',
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 8 }}>{label}</div>
      {file ? (
        <>
          <div style={{ fontSize: 13, marginBottom: 4 }}>{file.filename}</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8 }}>
            {(file.size_bytes / 1024).toFixed(0)} KB · {fmtDate(file.created_at)}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <a className="btn btn-sm btn-primary" href={employeeFileURL(file.id)} target="_blank" rel="noopener noreferrer">{t('hr.view')}</a>
            {canEdit && (
              <>
                <button className="btn btn-sm btn-secondary" onClick={onPick} disabled={uploading}>{t('hr.replace')}</button>
                <button className="btn btn-sm btn-danger" onClick={onDelete}>{t('hr.delete')}</button>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>{t('hr.noFileUploaded')}</div>
          {canEdit && (
            <button className="btn btn-sm btn-primary" onClick={onPick} disabled={uploading}>
              {uploading ? t('hr.uploading') : t('hr.uploadPdf')}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export { Field, Section, FileSlot };
