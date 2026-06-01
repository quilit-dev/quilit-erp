import { useState, useEffect } from 'react';
import {
  getRoles, createRole, updateRole, deleteRole, setRolePermissions,
} from '../api/client';
import { Modal, ConfirmModal, LoadingSpinner, ErrorAlert, toast } from '../components/shared';
import { useLocale } from '../hooks/useLocale.jsx';

const COLORS = [
  // Neutrals
  '#6B7280','#374151','#1F2937',
  // Reds / Pinks
  '#EF4444','#DC2626','#EC4899','#DB2777',
  // Oranges / Yellows
  '#F59E0B','#D97706','#F97316','#EA580C',
  // Greens
  '#10B981','#059669','#22C55E','#16A34A',
  // Blues
  '#3B82F6','#2563EB','#0EA5E9','#0284C7',
  // Purples / Indigos
  '#8B5CF6','#7C3AED','#6366F1','#4F46E5',
  // Teals / Cyans
  '#14B8A6','#0D9488','#06B6D4','#0891B2',
];

const ACTIONS_ORDER = ['view','create','edit','delete','approve'];

// Must mirror backend permissions.py ALL_MODULES. Modules are listed here in
// the operational order the sidebar groups them by, so the permission matrix
// stays scannable and matches the rest of the navigation. Whenever a module is
// added to backend permissions.MODULES it MUST be added here too — otherwise
// admins can't grant access to it and the matrix is silently incomplete.
const CORE_MODULES  = [
  'dashboard',
  // Sales
  'crm', 'clients', 'quotations', 'invoices', 'pos',
  // Delivery
  'projects', 'planning',
  // Procurement / stock
  'suppliers', 'purchases', 'inventory', 'warehouses', 'manufacturing',
  // Finance
  'expenses', 'assets', 'finance', 'cash', 'accounting', 'reports',
  // People
  'hr', 'hr_contracts', 'hr_activities', 'recruitment',
  // Internal comms
  'announcements',
];
const ADMIN_MODULES = ['settings','users','roles','audit'];
const MODULES_ORDER = [...CORE_MODULES, ...ADMIN_MODULES];

function RoleCard({ role, onEdit, onPerms, onDelete }) {
  const { t } = useLocale();
  // Count granted permissions across all modules
  const permCount = Object.values(role.permissions || {}).reduce((sum, actions) =>
    sum + Object.values(actions || {}).filter(Boolean).length, 0
  );
  const maxPerms = MODULES_ORDER.length * ACTIONS_ORDER.length;

  return (
    <div className="card" style={{ padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
      {/* Color swatch */}
      <div style={{
        width: 40, height: 40, borderRadius: 10,
        background: role.color || '#6B7280', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: `0 2px 8px ${role.color || '#6B7280'}55`,
      }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.85)" strokeWidth="2" strokeLinecap="round">
          <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
        </svg>
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>{role.name}</span>
          {role.is_system && <span className="badge badge-blue">{t('roles.system')}</span>}
        </div>
        {role.description && (
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {role.description}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 11, color: 'var(--text-3)' }}>
          <span>
            <b style={{ color: 'var(--text-2)', fontWeight: 600 }}>{role.user_count ?? 0}</b>
            {' '}{role.user_count === 1 ? t('roles.userSingular') : t('roles.usersPlural')}
          </span>
          <span>·</span>
          <span>
            <b style={{ color: 'var(--text-2)', fontWeight: 600 }}>{permCount}</b>
            {' '}/ {maxPerms} permissions
          </span>
          {/* Mini permission bar */}
          <div style={{ flex: 1, maxWidth: 100, height: 4, background: 'var(--border)', borderRadius: 2 }}>
            <div style={{ height: '100%', width: `${maxPerms > 0 ? (permCount / maxPerms) * 100 : 0}%`, background: role.color || '#6B7280', borderRadius: 2, transition: 'width .3s' }} />
          </div>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn btn-sm btn-outline" onClick={() => onPerms(role)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
          {t('roles.permissions')}
        </button>
        <button className="btn btn-sm btn-outline btn-icon" onClick={() => onEdit(role)} disabled={role.is_system}
          title={role.is_system ? 'System roles cannot be edited' : 'Edit role'}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button
          className="btn btn-sm btn-icon"
          style={{ color: role.is_system ? 'var(--text-3)' : 'var(--red)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 7px', background: 'transparent' }}
          disabled={role.is_system}
          title={role.is_system ? 'System roles cannot be deleted' : 'Delete role'}
          onClick={() => onDelete(role)}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
        </button>
      </div>
    </div>
  );
}

export default function RoleManagement() {
  const { t } = useLocale();

  const MODULE_LABELS = {
    dashboard:     t('nav.dashboard'),
    clients:       t('nav.clients'),
    projects:      t('nav.projects'),
    quotations:    t('nav.quotations'),
    invoices:      t('nav.invoices'),
    inventory:     t('nav.inventory'),
    warehouses:    t('nav.warehouses'),
    purchases:     t('nav.purchases'),
    suppliers:     t('nav.suppliers'),
    finance:       t('nav.finance'),
    expenses:      t('nav.expenses'),
    accounting:    t('nav.accounting'),
    reports:       t('nav.reports'),
    crm:           t('nav.crm'),
    planning:      t('nav.planning'),
    pos:           t('nav.pos'),
    cash:          t('nav.cash'),
    manufacturing: t('nav.manufacturing'),
    assets:        t('nav.fixedAssets'),
    hr:            t('nav.hr'),
    hr_contracts:  t('nav.hrContracts'),
    hr_activities: t('nav.hrActivities'),
    recruitment:   t('nav.recruitment'),
    announcements: t('nav.announcements'),
    settings:      t('nav.settings'),
    users:         t('nav.users'),
    roles:         t('nav.roles'),
    audit:         t('nav.audit'),
  };

  const ACTION_LABELS = {
    view:    t('roles.actionView'),
    create:  t('roles.actionCreate'),
    edit:    t('roles.actionEdit'),
    delete:  t('roles.actionDelete'),
    approve: t('roles.actionApprove'),
  };

  const [roles,   setRoles]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [modal,   setModal]   = useState(null);
  const [editRole, setEditRole] = useState(null);
  const [form,     setForm]     = useState({ name: '', description: '', color: '#6B7280' });
  const [perms,    setPerms]    = useState({});
  const [saving,   setSaving]   = useState(false);
  const [confirm,  setConfirm]  = useState(null);

  async function load() {
    setLoading(true); setError('');
    try { setRoles(await getRoles()); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  function openCreate() {
    setForm({ name: '', description: '', color: '#6B7280' });
    setModal('create');
  }

  function openEdit(role) {
    setEditRole(role);
    setForm({ name: role.name, description: role.description || '', color: role.color || '#6B7280' });
    setModal('edit');
  }

  function openPerms(role) {
    setEditRole(role);
    setPerms(JSON.parse(JSON.stringify(role.permissions || {})));
    setModal('perms');
  }

  function updatePerm(module, action, value) {
    setPerms(prev => ({
      ...prev,
      [module]: { ...(prev[module] || {}), [action]: value },
    }));
  }

  function toggleRow(module, value) {
    setPerms(prev => ({
      ...prev,
      [module]: Object.fromEntries(ACTIONS_ORDER.map(a => [a, value])),
    }));
  }

  function toggleCol(action, value) {
    setPerms(prev => {
      const next = { ...prev };
      MODULES_ORDER.forEach(m => {
        next[m] = { ...(next[m] || {}), [action]: value };
      });
      return next;
    });
  }

  async function handleCreate() {
    if (!form.name.trim()) return toast(t('roles.roleNameRequired'), 'red');
    setSaving(true);
    try {
      await createRole(form);
      toast(t('roles.roleCreated'));
      setModal(null); load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setSaving(false); }
  }

  async function handleEdit() {
    if (!form.name.trim()) return toast(t('roles.roleNameRequired'), 'red');
    setSaving(true);
    try {
      await updateRole(editRole.id, form);
      toast(t('roles.roleUpdated'));
      setModal(null); load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setSaving(false); }
  }

  async function handleSavePerms() {
    setSaving(true);
    try {
      await setRolePermissions(editRole.id, { permissions: perms });
      toast(t('roles.permsSaved'));
      setModal(null); load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setSaving(false); }
  }

  async function handleDelete() {
    try {
      await deleteRole(confirm.id);
      toast(t('roles.roleDeleted'));
      setConfirm(null); load();
    } catch (e) { toast(e.message, 'red'); setConfirm(null); }
  }

  const allRowOn = mod => ACTIONS_ORDER.every(a => perms[mod]?.[a]);
  const allColOn = act => MODULES_ORDER.every(m => perms[m]?.[act]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('roles.title')}</h1>
          <p className="page-subtitle">{t('roles.subtitle2')}</p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={openCreate}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          {t('roles.addRole')}
        </button>
      </div>

      {error && <ErrorAlert message={error} onRetry={load} />}
      {loading ? <LoadingSpinner /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {roles.length === 0 && <div style={{ textAlign: 'center', color: 'var(--text-3)', padding: 40 }}>{t('roles.noRolesFound')}</div>}
          {roles.map(r => (
            <RoleCard key={r.id} role={r} onEdit={openEdit} onPerms={openPerms} onDelete={setConfirm} />
          ))}
        </div>
      )}

      {/* Create / Edit Role Modal */}
      {(modal === 'create' || modal === 'edit') && (
        <Modal title={modal === 'create' ? t('roles.newRole') : t('roles.editRoleTitle', { name: editRole?.name })} onClose={() => setModal(null)}>
          <div className="modal-body">
            <div className="form-group">
              <label className="form-label">{t('roles.roleNameLabel')}</label>
              <input className="form-control" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('roles.descriptionLabel')}</label>
              <input className="form-control" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('roles.colorLabel')}</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                {COLORS.map(c => (
                  <button key={c} type="button" onClick={() => setForm(f => ({ ...f, color: c }))}
                    style={{
                      width: 26, height: 26, borderRadius: '50%', background: c, border: 'none', cursor: 'pointer', flexShrink: 0,
                      outline: form.color === c ? `3px solid ${c}` : '2px solid transparent',
                      outlineOffset: 2,
                      boxShadow: form.color === c ? `0 0 0 2px var(--bg), 0 2px 6px ${c}88` : '0 1px 3px rgba(0,0,0,.2)',
                      transform: form.color === c ? 'scale(1.15)' : 'scale(1)',
                      transition: 'all .15s',
                    }}
                    title={c}
                  />
                ))}
              </div>
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', background: form.color, border: '2px solid var(--border)', flexShrink: 0 }} />
                <span style={{ fontSize: 12, color: 'var(--text-2)', fontFamily: 'monospace' }}>{form.color}</span>
                <input type="color" value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                  style={{ width: 28, height: 26, padding: 1, border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', background: 'var(--surface)' }}
                  title="Or pick any custom color"
                />
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>or pick custom</span>
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setModal(null)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={modal === 'create' ? handleCreate : handleEdit} disabled={saving}>
              {saving ? t('common.saving') : modal === 'create' ? t('roles.createRole') : t('common.save')}
            </button>
          </div>
        </Modal>
      )}

      {/* Permission Matrix Modal */}
      {modal === 'perms' && editRole && (
        <Modal title={t('roles.permissionsTitle', { name: editRole.name })} onClose={() => setModal(null)} size="modal-xl">
          <div className="modal-body" style={{ padding: 0 }}>
            {editRole.is_system && (
              <div style={{ margin: '14px 20px 0', padding: '10px 14px', borderRadius: 8, background: 'var(--yellow-light)', border: '1px solid var(--yellow)', color: 'var(--yellow)', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                {t('roles.systemRoleReadOnly')}
              </div>
            )}

            <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '65vh' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead style={{ position: 'sticky', top: 0, zIndex: 2 }}>
                  <tr style={{ background: 'var(--surface-2)', borderBottom: '2px solid var(--border)' }}>
                    <th style={{ padding: '11px 20px', textAlign: 'left', fontWeight: 700, color: 'var(--text-2)', width: 180, whiteSpace: 'nowrap' }}>
                      {t('common.module')}
                    </th>
                    {ACTIONS_ORDER.map(a => (
                      <th key={a} style={{ padding: '11px 8px', textAlign: 'center', fontWeight: 700, color: 'var(--text-2)', minWidth: 88 }}>
                        <div style={{ marginBottom: 5 }}>{ACTION_LABELS[a]}</div>
                        {!editRole.is_system && (
                          <input type="checkbox"
                            checked={allColOn(a)}
                            onChange={e => toggleCol(a, e.target.checked)}
                            style={{ cursor: 'pointer', width: 15, height: 15 }}
                            title={`Toggle all ${ACTION_LABELS[a]}`}
                          />
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {/* ── Core Modules group ─────────────────────── */}
                  <tr>
                    <td colSpan={ACTIONS_ORDER.length + 1}
                      style={{ padding: '8px 20px 4px', background: 'var(--surface-2)', borderBottom: '1px solid var(--border)', fontSize: 10, fontWeight: 700, letterSpacing: '.8px', textTransform: 'uppercase', color: 'var(--text-3)' }}>
                      Core Modules
                    </td>
                  </tr>
                  {CORE_MODULES.map((mod, i) => (
                    <tr key={mod} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)' }}>
                      <td style={{ padding: '9px 20px', fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {!editRole.is_system && (
                            <input type="checkbox"
                              checked={allRowOn(mod)}
                              onChange={e => toggleRow(mod, e.target.checked)}
                              style={{ cursor: 'pointer', width: 15, height: 15, flexShrink: 0 }}
                              title={`Toggle all permissions for ${MODULE_LABELS[mod]}`}
                            />
                          )}
                          {MODULE_LABELS[mod]}
                        </div>
                      </td>
                      {ACTIONS_ORDER.map(action => {
                        const checked = Boolean(perms[mod]?.[action]);
                        return (
                          <td key={action} style={{ padding: '9px 8px', textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={editRole.is_system}
                              onChange={e => updatePerm(mod, action, e.target.checked)}
                              style={{ cursor: editRole.is_system ? 'default' : 'pointer', width: 15, height: 15, accentColor: editRole.color || 'var(--accent)' }}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}

                  {/* ── Administration group ───────────────────── */}
                  <tr>
                    <td colSpan={ACTIONS_ORDER.length + 1}
                      style={{ padding: '12px 20px 4px', background: 'var(--surface-2)', borderBottom: '1px solid var(--border)', borderTop: '2px solid var(--border)', fontSize: 10, fontWeight: 700, letterSpacing: '.8px', textTransform: 'uppercase', color: 'var(--text-3)' }}>
                      Administration
                    </td>
                  </tr>
                  {ADMIN_MODULES.map((mod, i) => (
                    <tr key={mod} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)' }}>
                      <td style={{ padding: '9px 20px', fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {!editRole.is_system && (
                            <input type="checkbox"
                              checked={allRowOn(mod)}
                              onChange={e => toggleRow(mod, e.target.checked)}
                              style={{ cursor: 'pointer', width: 15, height: 15, flexShrink: 0 }}
                              title={`Toggle all permissions for ${MODULE_LABELS[mod]}`}
                            />
                          )}
                          {MODULE_LABELS[mod]}
                        </div>
                      </td>
                      {ACTIONS_ORDER.map(action => {
                        const checked = Boolean(perms[mod]?.[action]);
                        return (
                          <td key={action} style={{ padding: '9px 8px', textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={editRole.is_system}
                              onChange={e => updatePerm(mod, action, e.target.checked)}
                              style={{ cursor: editRole.is_system ? 'default' : 'pointer', width: 15, height: 15, accentColor: editRole.color || 'var(--accent)' }}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="modal-footer">
            {!editRole.is_system && (
              <div style={{ fontSize: 12, color: 'var(--text-3)', flex: 1 }}>
                {Object.values(perms).reduce((s, a) => s + Object.values(a || {}).filter(Boolean).length, 0)} permissions granted
              </div>
            )}
            <button className="btn btn-outline" onClick={() => setModal(null)}>{t('common.close')}</button>
            {!editRole.is_system && (
              <button className="btn btn-primary" onClick={handleSavePerms} disabled={saving}>
                {saving ? t('common.saving') : t('roles.savePerms')}
              </button>
            )}
          </div>
        </Modal>
      )}

      {confirm && (
        <ConfirmModal
          message={
            confirm.user_count > 0
              ? t('roles.deleteBlockedMsg', { name: confirm.name, count: confirm.user_count })
              : t('roles.deleteMsg', { name: confirm.name })
          }
          confirmLabel={t('common.delete')}
          confirmClass="btn-danger"
          onConfirm={handleDelete}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
