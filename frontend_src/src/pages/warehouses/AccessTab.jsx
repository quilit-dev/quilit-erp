import { useState, useEffect } from 'react';
import { LoadingSpinner, EmptyState, Modal, ConfirmModal, toast } from '../../components/shared';
import {
  getWarehouses, getUsers, getWarehouseAccess,
  grantWarehouseAccess, revokeWarehouseAccess,
} from '../../api/client';

function AccessTab({ t }) {
  const [warehouses, setWarehouses] = useState([]);
  const [users, setUsers]   = useState([]);
  const [grants, setGrants] = useState({});
  const [selectedWid, setSelectedWid] = useState(null);
  const [picker, setPicker] = useState(null);
  const [loading, setLoading] = useState(true);
  // Set when revoking a grant that is the user's LAST one anywhere — see the
  // note on `revoke` below.
  const [confirmLast, setConfirmLast] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const [w, u] = await Promise.all([getWarehouses({}), getUsers()]);
      setWarehouses(w.filter(x => !x.archived_at));
      setUsers(u);
      if (w[0] && selectedWid === null) setSelectedWid(w[0].id);
      const g = {};
      for (const x of w) g[x.id] = await getWarehouseAccess(x.id);
      setGrants(g);
    } catch (e) { toast(e.message, 'red'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  if (loading) return <LoadingSpinner />;
  if (!warehouses.length) return <EmptyState icon="🏬" title={t('warehouses.noneTitle')} subtitle={t('warehouses.noneAdmin')} />;

  const current = warehouses.find(w => w.id === selectedWid) || warehouses[0];
  const currentGrants = grants[current.id] || [];

  async function grant(uid) {
    try { await grantWarehouseAccess(current.id, uid); toast(t('warehouses.toastAccessGranted'), 'green'); load(); }
    catch (e) { toast(e.message, 'red'); }
    setPicker(null);
  }
  async function doRevoke(uid) {
    try { await revokeWarehouseAccess(current.id, uid); toast(t('warehouses.toastAccessRevoked'), 'green'); load(); }
    catch (e) { toast(e.message, 'red'); }
    setConfirmLast(null);
  }

  // Revoking a user's LAST grant does the opposite of what the button reads.
  // Access is an opt-in allow-list: a user with zero grants falls back to the
  // default, which is EVERY warehouse. So removing the final row does not leave
  // them with nothing — it hands them everything. Revoking any other grant just
  // narrows the list, so only this case is confirmed.
  function revoke(uid) {
    const grant = currentGrants.find(g => g.user_id === uid);
    const totalForUser = Object.values(grants)
      .flat()
      .filter(g => g && g.user_id === uid).length;
    if (totalForUser <= 1) {
      setConfirmLast({ uid, name: grant?.full_name || grant?.username || '' });
      return;
    }
    doRevoke(uid);
  }

  return (
    <div>
      <div style={{ background: 'var(--surface-2)', padding: 12, borderRadius: 8, marginBottom: 16, fontSize: 13, color: 'var(--text-2)' }}>
        <strong>{t('warehouses.defaultPolicy')}</strong> {t('warehouses.defaultPolicyExplain')}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16 }}>
        <div>
          <div className="form-label" style={{ marginBottom: 6 }}>
            {t('warehouses.warehouseLabel')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {warehouses.map(w => (
              <button key={w.id}
                onClick={() => setSelectedWid(w.id)}
                className={`btn btn-sm ${w.id === current.id ? 'btn-primary' : 'btn-outline'}`}
                style={{ justifyContent: 'flex-start', display: 'flex', gap: 8 }}>
                <span className="td-mono">{w.code}</span>
                <span style={{ color: 'var(--text-3)' }}>·</span>
                <span>{w.name}</span>
              </button>
            ))}
          </div>
        </div>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div>
              <div style={{ fontWeight: 600 }}>{current.name} ({current.code})</div>
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {currentGrants.length === 0
                  ? t('warehouses.noGrantsInline')
                  : t(currentGrants.length === 1 ? 'warehouses.someGrants' : 'warehouses.someGrants_plural', { count: currentGrants.length })}
              </div>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => setPicker({ warehouse_id: current.id })}>
              {t('warehouses.grantBtn')}
            </button>
          </div>
          {currentGrants.length === 0 ? (
            <EmptyState icon="🌐" title={t('warehouses.noGrantsTitle')} subtitle={t('warehouses.noGrantsHint')} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr>
                  <th>{t('warehouses.colUser')}</th>
                  <th>{t('warehouses.colGranted')}</th>
                  <th style={{ textAlign: 'right' }}></th>
                </tr></thead>
                <tbody>
                  {currentGrants.map(g => (
                    <tr key={g.user_id}>
                      <td className="td-primary">{g.full_name || g.username}</td>
                      <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{new Date(g.granted_at).toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn btn-sm" style={{ color: 'var(--red)' }} onClick={() => revoke(g.user_id)}>
                          {t('warehouses.revokeBtn')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {confirmLast && (
        <ConfirmModal
          title={t('warehouses.revokeLastTitle')}
          message={t('warehouses.revokeLastWarning', { name: confirmLast.name })}
          confirmLabel={t('warehouses.revokeAnyway')}
          confirmClass="btn-danger"
          onConfirm={() => doRevoke(confirmLast.uid)}
          onCancel={() => setConfirmLast(null)}
        />
      )}

      {picker && (
        <Modal title={t('warehouses.grantModalTitle')} onClose={() => setPicker(null)}>
          <div className="modal-body">
            <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 12 }}>
              {t('warehouses.grantModalExplain', { name: current.name })}
            </div>
            <div style={{ maxHeight: 320, overflowY: 'auto' }}>
              {users.filter(u => !currentGrants.find(g => g.user_id === u.id)).map(u => (
                <div key={u.id} style={{ padding: '6px 4px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{u.full_name || u.username}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-3)' }}>@{u.username}</div>
                  </div>
                  <button className="btn btn-sm btn-primary" onClick={() => grant(u.id)}>{t('warehouses.grantBtnRow')}</button>
                </div>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}


export { AccessTab };
