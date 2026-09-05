import { useState, useEffect } from 'react';
import {
  getUsers, createUser, updateUser, deleteUser,
  toggleUserActive, resetUserPassword, getRoles, getBranchContext,
} from '../api/client';
import { Modal, ConfirmModal, LoadingSpinner, ErrorAlert, fmtDate, toast } from '../components/shared';
import { useLocale } from '../hooks/useLocale.jsx';
import SearchSelect from '../components/SearchSelect.jsx';

const EMPTY_CREATE = { username: '', password: '', full_name: '', email: '', role_id: '', branch_id: '', is_superadmin: false };

function Avatar({ name, username }) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  const initials = parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : (name?.[0] || username?.[0] || 'U').toUpperCase();
  return (
    <div style={{
      width: 32, height: 32, borderRadius: '50%', background: 'var(--accent)',
      color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 12, fontWeight: 700, flexShrink: 0,
    }}>{initials}</div>
  );
}

export default function UserManagement() {
  const [users,   setUsers]   = useState([]);
  const [roles,   setRoles]   = useState([]);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [search,  setSearch]  = useState('');
  const [modal,   setModal]   = useState(null); // null | 'create' | 'edit' | 'reset'
  const [editUser,  setEditUser]  = useState(null);
  const [form,      setForm]      = useState({});
  const [saving,    setSaving]    = useState(false);
  const [confirm,   setConfirm]   = useState(null);
  const [resetPw,   setResetPw]   = useState('');
  const { t, tRole } = useLocale();

  const me = (() => { try { return JSON.parse(localStorage.getItem('user') || '{}'); } catch { return {}; } })();

  async function load() {
    setLoading(true); setError('');
    try {
      const [u, r] = await Promise.all([getUsers({ search }), getRoles()]);
      getBranchContext().then(bc => setBranches((bc && bc.branches) || [])).catch(() => {});
      setUsers(u); setRoles(r);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [search]);

  function openCreate() {
    setForm(EMPTY_CREATE);
    setModal('create');
  }

  function openEdit(u) {
    setEditUser(u);
    setForm({ username: u.username || '', full_name: u.full_name || '', email: u.email || '', role_id: u.role_id || '', branch_id: u.branch_id || '', is_active: u.is_active, is_superadmin: Boolean(u.is_superadmin) });
    setModal('edit');
  }

  function openReset(u) {
    setEditUser(u);
    setResetPw('');
    setModal('reset');
  }

  async function handleCreate() {
    if (!form.username) return toast(t('users.usernameRequired'), 'red');
    if (!form.password || form.password.length < 8) return toast(t('users.passwordMinLength'), 'red');
    setSaving(true);
    try {
      await createUser({ ...form, role_id: form.role_id || null, branch_id: form.branch_id || null });
      toast(t('users.userCreated'));
      setModal(null); load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setSaving(false); }
  }

  async function handleEdit() {
    if (!form.username || !form.username.trim()) return toast(t('users.usernameRequired'), 'red');
    setSaving(true);
    try {
      await updateUser(editUser.id, { ...form, role_id: form.role_id || null, branch_id: form.branch_id || null });
      if (editUser.id === me.id) {
        const stored = JSON.parse(localStorage.getItem('user') || '{}');
        localStorage.setItem('user', JSON.stringify({ ...stored, username: form.username.trim(), full_name: form.full_name, email: form.email }));
        window.dispatchEvent(new Event('user-updated'));
      }
      toast(t('users.userUpdated'));
      setModal(null); load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setSaving(false); }
  }

  async function handleToggle(u) {
    try {
      await toggleUserActive(u.id);
      toast(u.is_active ? t('users.userDisabled') : t('users.userEnabled'));
      load();
    } catch (e) { toast(e.message, 'red'); }
  }

  async function handleDelete() {
    try {
      await deleteUser(confirm.id);
      toast(t('users.userDeleted'));
      setConfirm(null); load();
    } catch (e) { toast(e.message, 'red'); setConfirm(null); }
  }

  async function handleReset() {
    if (!resetPw || resetPw.length < 8) return toast(t('users.newPasswordMinLength'), 'red');
    setSaving(true);
    try {
      await resetUserPassword(editUser.id, { new_password: resetPw });
      toast(t('users.passwordReset'));
      setModal(null);
    } catch (e) { toast(e.message, 'red'); }
    finally { setSaving(false); }
  }

  const F = (key, placeholder, type = 'text', required = false) => (
    <div className="form-group">
      <label className="form-label">{placeholder}{required && ' *'}</label>
      <input
        type={type} className="form-control" placeholder={placeholder}
        value={form[key] || ''}
        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
        required={required}
      />
    </div>
  );

  // A non-admin manager (Branch Manager) can't assign admin-tier roles — hide
  // them from the picker (the backend enforces this too).
  const meIsGlobal = Boolean(me.is_superadmin || me.admin_access);
  const assignableRoles = meIsGlobal ? roles : roles.filter(r => !r.is_admin);
  const RoleSelect = () => (
    <div className="form-group">
      <label className="form-label">{t('users.role')}</label>
      <SearchSelect
        className="form-control"
        value={form.role_id || ''}
        onChange={v => setForm(f => ({ ...f, role_id: v ? Number(v) : '' }))}
        placeholder={t('common.noRole')}
        options={(assignableRoles).map(r => ({ value: r.id, label: tRole(r.name) }))} />
    </div>
  );

  // Home branch — the visibility boundary. Hidden for superadmins (always
  // global) and when there's only one branch (nothing to choose).
  const BranchSelect = () => (!form.is_superadmin && branches.length > 1) ? (
    <div className="form-group">
      <label className="form-label">{t('nav.branch')}</label>
      <SearchSelect
        className="form-control"
        value={form.branch_id || ''}
        onChange={v => setForm(f => ({ ...f, branch_id: v ? Number(v) : '' }))}
        options={(branches).map(b => ({ value: b.id, label: b.name }))} />
    </div>
  ) : null;

  const SuperadminToggle = () => me.is_superadmin && (
    <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <input type="checkbox" id="sa-toggle" checked={Boolean(form.is_superadmin)} onChange={e => setForm(f => ({ ...f, is_superadmin: e.target.checked }))} />
      <label htmlFor="sa-toggle" className="form-label" style={{ marginBottom: 0, cursor: 'pointer' }}>
        {t('users.superadmin')}
      </label>
    </div>
  );

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('users.title')}</h1>
          <p className="page-subtitle">{t('users.subtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="form-control" style={{ width: 200 }} placeholder={t('users.searchPlaceholder')}
            value={search} onChange={e => setSearch(e.target.value)} />
          <button className="btn btn-primary btn-sm" onClick={openCreate}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            {t('users.addUser')}
          </button>
        </div>
      </div>

      {error && <ErrorAlert message={error} onRetry={load} />}
      {loading ? <LoadingSpinner /> : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('users.user')}</th>
                <th>{t('users.email')}</th>
                <th>{t('users.role')}</th>
                <th>{t('common.status')}</th>
                <th>{t('users.lastLogin')}</th>
                <th style={{ width: 140 }}>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>{t('users.noUsersFound')}</td></tr>
              )}
              {users.map(u => (
                <tr key={u.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <Avatar name={u.full_name} username={u.username} />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{u.full_name || u.username}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>@{u.username}</div>
                        {u.is_superadmin ? <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', letterSpacing: '.5px' }}>SUPERADMIN</span> : null}
                      </div>
                    </div>
                  </td>
                  <td style={{ color: 'var(--text-2)', fontSize: 13 }}>{u.email || '—'}</td>
                  <td>
                    {u.role_name ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: u.role_color || 'var(--text-3)', flexShrink: 0 }} />
                        <span style={{ fontSize: 12.5 }}>{tRole(u.role_name)}</span>
                      </span>
                    ) : <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>}
                  </td>
                  <td>
                    <span className={`badge badge-${u.is_active ? 'green' : 'red'}`}>
                      {u.is_active ? 'Active' : 'Disabled'}
                    </span>
                  </td>
                  <td style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{u.last_login ? fmtDate(u.last_login) : t('common.never')}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn btn-sm btn-secondary btn-icon" title="Edit" onClick={() => openEdit(u)}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                      </button>
                      <button className="btn btn-sm btn-secondary btn-icon" title="Reset Password" onClick={() => openReset(u)}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                      </button>
                      <button
                        className={`btn btn-sm btn-icon ${u.is_active ? 'btn-secondary' : 'btn-secondary'}`}
                        title={u.is_active ? 'Disable' : 'Enable'}
                        style={{ color: u.is_active ? 'var(--yellow)' : 'var(--green)' }}
                        onClick={() => handleToggle(u)}
                        disabled={u.id === me.id}
                      >
                        {u.is_active
                          ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
                          : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polyline points="9 11 12 14 22 4"/></svg>
                        }
                      </button>
                      <button
                        className="btn btn-sm btn-icon"
                        style={{ color: 'var(--red)' }}
                        title="Delete"
                        disabled={u.id === me.id}
                        onClick={() => setConfirm(u)}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Modal */}
      {modal === 'create' && (
        <Modal title={t('users.createUser')} onClose={() => setModal(null)}>
          <div className="modal-body">
            {F('username',  t('users.username'),  'text', true)}
            {F('password',  t('users.password'), 'password', true)}
            {F('full_name', t('users.fullName'))}
            {F('email',     'Email', 'email')}
            <RoleSelect />
            <BranchSelect />
            <SuperadminToggle />
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setModal(null)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={handleCreate} disabled={saving}>
              {saving ? t('users.creating') : t('users.createUser')}
            </button>
          </div>
        </Modal>
      )}

      {/* Edit Modal */}
      {modal === 'edit' && editUser && (
        <Modal title={`Edit — @${editUser.username}`} onClose={() => setModal(null)}>
          <div className="modal-body">
            {F('username', 'Username', 'text', true)}
            {F('full_name', 'Full Name')}
            {F('email', 'Email', 'email')}
            <RoleSelect />
            <BranchSelect />
            <div className="form-group" style={{ display: 'flex', gap: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                <input type="checkbox" checked={Boolean(form.is_active)} onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} />
                {t('users.activeLabel')}
              </label>
              {me.is_superadmin && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                  <input type="checkbox" checked={Boolean(form.is_superadmin)} onChange={e => setForm(f => ({ ...f, is_superadmin: e.target.checked }))} />
                  {t('users.superadminShort')}
                </label>
              )}
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setModal(null)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={handleEdit} disabled={saving}>
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </Modal>
      )}

      {/* Reset Password Modal */}
      {modal === 'reset' && editUser && (
        <Modal title={`${t('users.resetPassword')} — @${editUser.username}`} onClose={() => setModal(null)}>
          <div className="modal-body">
            <div className="alert alert-red" style={{ marginBottom: 12 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {t('users.sessionsRevoked')}
            </div>
            <div className="form-group">
              <label className="form-label">{t('users.newPassword')}</label>
              <input type="password" className="form-control" placeholder={t('users.minChars')}
                value={resetPw} onChange={e => setResetPw(e.target.value)} />
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setModal(null)}>{t('common.cancel')}</button>
            <button className="btn btn-danger" onClick={handleReset} disabled={saving}>
              {saving ? t('users.resetting') : t('users.resetPassword')}
            </button>
          </div>
        </Modal>
      )}

      {/* Delete Confirm */}
      {confirm && (
        <ConfirmModal
          title={t('users.deleteUser')}
          message={t('users.deleteConfirm', { username: confirm.username })}
          confirmLabel={t('common.delete')}
          confirmClass="btn-danger"
          onConfirm={handleDelete}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
