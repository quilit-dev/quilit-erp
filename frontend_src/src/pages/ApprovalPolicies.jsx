import { useState, useEffect, useCallback } from 'react';
import { useLocale } from '../hooks/useLocale.jsx';
import { useData } from '../hooks/useData.js';
import { Modal, ConfirmModal, LoadingSpinner, ErrorAlert, toast, NumberInput} from '../components/shared';
import SearchSelect from '../components/SearchSelect.jsx';
import {
  getApprovalPolicies, getApprovalPolicyMeta,
  createApprovalPolicy, updateApprovalPolicy,
  toggleApprovalPolicy, deleteApprovalPolicy,
  getRoles,
} from '../api/client';

// ── Constants ─────────────────────────────────────────────────────────────────

const MODULE_COLORS = {
  expense:     { bg: 'var(--caution-tint)', color: 'var(--caution-ink)' },
  purchase:    { bg: 'var(--affirm-tint)', color: 'var(--affirm)' },
  project:     { bg: '#fce7f3', color: '#be185d' },
  quotation:   { bg: 'var(--info-tint)', color: 'var(--info-ink)' },
  invoice:     { bg: '#e0f2fe', color: '#0369a1' },
  fixed_asset: { bg: '#ede9fe', color: '#6d28d9' },
};

// Module names are labelled by the backend registry (meta.module_labels) so the
// UI never drifts from what the engine enforces; fall back to a tidy
// title-cased form (e.g. "fixed_asset" → "Fixed asset") when meta is absent.
const prettyModule = (m) => (m || '').charAt(0).toUpperCase() + (m || '').slice(1).replace(/_/g, ' ');
const moduleLabel  = (meta, m) => meta?.module_labels?.[m] || prettyModule(m);

function ModuleBadge({ module, label }) {
  const cfg = MODULE_COLORS[module] || { bg: 'var(--bg)', color: 'var(--text-2)' };
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 700,
      background: cfg.bg, color: cfg.color,
    }}>
      {label || prettyModule(module)}
    </span>
  );
}

// ── Condition Row ─────────────────────────────────────────────────────────────

function ConditionRow({ cond, index, fields, onUpdate, onRemove }) {
  const { t, tEnumValue } = useLocale();
  const fieldDef = fields.find(f => f.key === cond.field) || fields[0] || {};
  const fieldType = fieldDef.type || 'text';

  const NUMBER_OPS = ['>', '<', '>=', '<=', '==', '!='];
  const TEXT_OPS   = ['==', '!=', 'contains'];
  const ops        = fieldType === 'number' ? NUMBER_OPS : TEXT_OPS;

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
      {index > 0 && (
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', minWidth: 28, textAlign: 'center' }}>
          {t('approvals.logicAnd')}
        </span>
      )}
      {index === 0 && <span style={{ minWidth: 28 }} />}

      <SearchSelect
        className="form-control"
        style={{ flex: '0 0 130px' }}
        value={cond.field}
        onChange={v => onUpdate(index, { ...cond, field: v, op: '==', value: '' })}
        options={(fields).map(f => ({ value: f.key, label: f.label }))} />

      <SearchSelect
        className="form-control"
        style={{ flex: '0 0 80px' }}
        value={cond.op}
        onChange={v => onUpdate(index, { ...cond, op: v })}
        options={(ops).map(o => ({ value: o, label: tEnumValue(o) }))} />

      <input
        className="form-control"
        style={{ flex: 1 }}
        type={fieldType === 'number' ? 'number' : 'text'}
        placeholder={t('approvals.conditionValue')}
        value={cond.value}
        onChange={e => onUpdate(index, { ...cond, value: e.target.value })}
      />

      <button
        type="button"
        onClick={() => onRemove(index)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', padding: '0 4px', fontSize: 16, lineHeight: 1 }}
      >×</button>
    </div>
  );
}

// ── Step Row (multi-step) ─────────────────────────────────────────────────────

function StepRow({ step, index, roles, total, onUpdate, onRemove, onMove }) {
  const { t, tRole } = useLocale();
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
      <span style={{
        width: 24, height: 24, borderRadius: '50%',
        background: 'var(--accent)', color: 'var(--accent-ink)',
        fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        {index + 1}
      </span>

      <SearchSelect
        className="form-control"
        style={{ flex: 1 }}
        value={step.role}
        onChange={v => onUpdate(index, { ...step, role: v })}
        placeholder={t('approvals.selectRole')}
        options={(roles).map(r => ({ value: r, label: tRole(r) }))} />

      <div style={{ display: 'flex', gap: 2 }}>
        <button type="button" disabled={index === 0}
          onClick={() => onMove(index, index - 1)}
          style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', padding: '2px 6px', color: 'var(--text-2)', opacity: index === 0 ? 0.3 : 1 }}>↑</button>
        <button type="button" disabled={index === total - 1}
          onClick={() => onMove(index, index + 1)}
          style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', padding: '2px 6px', color: 'var(--text-2)', opacity: index === total - 1 ? 0.3 : 1 }}>↓</button>
      </div>

      <button type="button" onClick={() => onRemove(index)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', padding: '0 4px', fontSize: 16, lineHeight: 1 }}>×</button>
    </div>
  );
}

// ── Policy Form ───────────────────────────────────────────────────────────────

const BLANK_POLICY = {
  name: '', description: '',
  module: 'expense', trigger_action: 'create',
  condition_logic: 'AND',
  conditions: [],
  approval_type: 'single',
  approver_roles: [],
  steps: [],
  priority: 0,
  is_active: true,
};

function PolicyForm({ initial, meta, roles, onSave, onClose }) {
  const { t, tRole } = useLocale();
  const [form, setForm] = useState(initial ? {
    ...BLANK_POLICY, ...initial,
    is_active: Boolean(initial.is_active),
  } : { ...BLANK_POLICY });
  const [saving, setSaving] = useState(false);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const moduleFields  = meta?.module_fields?.[form.module]  || [];
  const moduleActions = meta?.module_actions?.[form.module] || ['create'];

  // Keep action in sync when module changes
  useEffect(() => {
    if (!moduleActions.includes(form.trigger_action)) {
      set('trigger_action', moduleActions[0] || 'create');
    }
  }, [form.module]);

  // Conditions helpers
  const addCondition = () => {
    const defaultField = moduleFields[0];
    if (!defaultField) return;
    set('conditions', [...form.conditions, { field: defaultField.key, op: '==', value: '' }]);
  };
  const updateCondition = (i, val) => set('conditions', form.conditions.map((c, idx) => idx === i ? val : c));
  const removeCondition = (i) => set('conditions', form.conditions.filter((_, idx) => idx !== i));

  // Single approver roles toggle
  const toggleRole = (role) => {
    const cur = form.approver_roles;
    set('approver_roles', cur.includes(role) ? cur.filter(r => r !== role) : [...cur, role]);
  };

  // Multi-step helpers
  const addStep = () => set('steps', [...form.steps, { step: form.steps.length + 1, role: '' }]);
  const updateStep = (i, val) => set('steps', form.steps.map((s, idx) => idx === i ? val : s).map((s, idx) => ({ ...s, step: idx + 1 })));
  const removeStep = (i) => set('steps', form.steps.filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, step: idx + 1 })));
  const moveStep = (from, to) => {
    const arr = [...form.steps];
    [arr[from], arr[to]] = [arr[to], arr[from]];
    set('steps', arr.map((s, idx) => ({ ...s, step: idx + 1 })));
  };

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) { toast(t('approvals.policyNameRequired'), 'error'); return; }
    if (form.approval_type === 'single' && form.approver_roles.length === 0) {
      toast(t('approvals.selectApproverRole'), 'error'); return;
    }
    if (form.approval_type === 'multi_step' && form.steps.length === 0) {
      toast(t('approvals.addApprovalStepMsg'), 'error'); return;
    }
    setSaving(true);
    try {
      if (initial?.id) {
        await updateApprovalPolicy(initial.id, form);
        toast(t('approvals.policyUpdated'));
      } else {
        await createApprovalPolicy(form);
        toast(t('approvals.policyCreated'));
      }
      onSave();
    } catch (err) {
      toast(err.message || t('approvals.errorSavingPolicy'), 'error');
    } finally {
      setSaving(false);
    }
  }

  const sectionStyle = { marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid var(--border)' };

  return (
    <form onSubmit={handleSubmit}>
      <div className="modal-body">

        {/* Basic info */}
        <div style={sectionStyle}>
          <div className="form-group form-full">
            <label className="form-label">{t('approvals.policyName')} *</label>
            <input className="form-control" value={form.name} onChange={e => set('name', e.target.value)} placeholder={t('approvals.policyNamePlaceholder')} required />
          </div>
          <div className="form-group form-full">
            <label className="form-label">{t('common.description')}</label>
            <textarea className="form-control" rows={2} value={form.description || ''} onChange={e => set('description', e.target.value)} placeholder={t('approvals.descriptionPlaceholder')} />
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">{t('approvals.module')}</label>
              <SearchSelect
                className="form-control"
                value={form.module}
                onChange={v => set('module', v)}
                options={((meta?.modules || ['expense', 'purchase', 'project'])).map(m => ({ value: m, label: moduleLabel(meta, m) }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('approvals.triggerAction')}</label>
              <SearchSelect className="form-control" value={form.trigger_action}
                onChange={v => set('trigger_action', v)}
                options={moduleActions.map(a => ({
                  value: a, label: a.charAt(0).toUpperCase() + a.slice(1),
                }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('approvals.priority')}</label>
              <NumberInput className="form-control" value={form.priority} onChange={e => set('priority', Number(e.target.value))} min={0} />
            </div>
            <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>
                <input type="checkbox" checked={form.is_active} onChange={e => set('is_active', e.target.checked)} />
                {t('approvals.activePolicy')}
              </label>
            </div>
          </div>
        </div>

        {/* Conditions */}
        <div style={sectionStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)', marginBottom: 2 }}>{t('approvals.conditions')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('approvals.conditionsHint', { module: form.module })}</div>
            </div>
            {form.conditions.length > 1 && (
              <div style={{ display: 'flex', gap: 4 }}>
                {['AND', 'OR'].map(logic => (
                  <button key={logic} type="button"
                    onClick={() => set('condition_logic', logic)}
                    style={{
                      padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer',
                      border: `1.5px solid ${form.condition_logic === logic ? 'var(--accent)' : 'var(--border)'}`,
                      background: form.condition_logic === logic ? 'var(--accent-light)' : 'transparent',
                      color: form.condition_logic === logic ? 'var(--accent)' : 'var(--text-3)',
                    }}
                  >{logic === 'AND' ? t('approvals.logicAnd') : t('approvals.logicOr')}</button>
                ))}
              </div>
            )}
          </div>

          {form.conditions.length === 0 ? (
            <div style={{ padding: '12px 0', fontSize: 12, color: 'var(--text-3)', fontStyle: 'italic' }}>
              {t('approvals.noConditions', { module: form.module })}
            </div>
          ) : (
            form.conditions.map((cond, i) => (
              <ConditionRow
                key={i} cond={cond} index={i}
                fields={moduleFields}
                onUpdate={updateCondition}
                onRemove={removeCondition}
              />
            ))
          )}
          {moduleFields.length > 0 && (
            <button type="button" onClick={addCondition}
              style={{ fontSize: 12, color: 'var(--accent)', background: 'none', border: '1px dashed var(--accent)', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', marginTop: 4 }}>
              {t('approvals.addCondition')}
            </button>
          )}
        </div>

        {/* Approval type */}
        <div style={sectionStyle}>
          <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)', marginBottom: 10 }}>{t('approvals.approvalType')}</div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
            {[
              { key: 'single',     label: t('approvals.single'),    desc: t('approvals.singleDesc') },
              { key: 'multi_step', label: t('approvals.multiStep'), desc: t('approvals.multiStepDesc') },
            ].map(opt => (
              <div key={opt.key}
                onClick={() => set('approval_type', opt.key)}
                style={{
                  flex: 1, padding: '10px 14px', borderRadius: 8, cursor: 'pointer',
                  border: `2px solid ${form.approval_type === opt.key ? 'var(--accent)' : 'var(--border)'}`,
                  background: form.approval_type === opt.key ? 'var(--accent-light)' : 'var(--surface)',
                  transition: 'all .15s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                  <div style={{
                    width: 14, height: 14, borderRadius: '50%',
                    border: `2px solid ${form.approval_type === opt.key ? 'var(--accent)' : 'var(--border)'}`,
                    background: form.approval_type === opt.key ? 'var(--accent)' : 'transparent',
                    flexShrink: 0,
                  }} />
                  <span style={{ fontWeight: 700, fontSize: 13, color: form.approval_type === opt.key ? 'var(--accent)' : 'var(--text)' }}>{opt.label}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', paddingLeft: 22 }}>{opt.desc}</div>
              </div>
            ))}
          </div>

          {/* Single approver roles */}
          {form.approval_type === 'single' && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 8 }}>{t('approvals.approverRolesLabel')}</div>
              {roles.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('approvals.noRolesFound')}</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {roles.map(role => {
                    const sel = form.approver_roles.includes(role);
                    return (
                      <button key={role} type="button" onClick={() => toggleRole(role)}
                        style={{
                          padding: '5px 12px', borderRadius: 99, fontSize: 12, cursor: 'pointer', transition: 'all .15s',
                          whiteSpace: 'nowrap',
                          border: `1.5px solid ${sel ? 'var(--accent)' : 'var(--border)'}`,
                          background: sel ? 'var(--accent)' : 'transparent',
                          color: sel ? '#fff' : 'var(--text-2)',
                          fontWeight: sel ? 600 : 400,
                        }}>
                        {tRole(role)}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Multi-step */}
          {form.approval_type === 'multi_step' && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 8 }}>{t('approvals.approvalStepsLabel')}</div>
              {form.steps.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8, fontStyle: 'italic' }}>{t('approvals.noSteps')}</div>
              ) : (
                form.steps.map((step, i) => (
                  <StepRow key={i} step={step} index={i} roles={roles} total={form.steps.length}
                    onUpdate={updateStep} onRemove={removeStep} onMove={moveStep} />
                ))
              )}
              <button type="button" onClick={addStep}
                style={{ fontSize: 12, color: 'var(--accent)', background: 'none', border: '1px dashed var(--accent)', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', marginTop: 4 }}>
                {t('approvals.addStep')}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="modal-footer">
        <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
          {saving ? t('common.saving') : (initial?.id ? t('common.save') : t('approvals.createPolicy'))}
        </button>
      </div>
    </form>
  );
}

// ── Policy Row ────────────────────────────────────────────────────────────────

function PolicyRow({ policy, meta, onEdit, onToggle, onDelete }) {
  const { t, tRole } = useLocale();
  const conditions = Array.isArray(policy.conditions) ? policy.conditions : [];
  const steps      = Array.isArray(policy.steps)      ? policy.steps      : [];
  const roles      = Array.isArray(policy.approver_roles) ? policy.approver_roles : [];

  return (
    <tr>
      <td>
        <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>{policy.name}</div>
        {policy.description && (
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{policy.description}</div>
        )}
      </td>
      <td><ModuleBadge module={policy.module} label={moduleLabel(meta, policy.module)} /></td>
      <td style={{ fontSize: 12, color: 'var(--text-2)', textTransform: 'capitalize' }}>{policy.trigger_action}</td>
      <td>
        {conditions.length === 0 ? (
          <span style={{ fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic' }}>{t('approvals.alwaysShort')}</span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {conditions.map((c, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {i > 0 && <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-3)' }}>{policy.condition_logic === 'OR' ? t('approvals.logicOr') : t('approvals.logicAnd')}</span>}
                <code style={{ fontSize: 10, background: 'var(--bg)', padding: '1px 6px', borderRadius: 4, color: 'var(--text-2)', border: '1px solid var(--border)' }}>
                  {c.field} {c.op} {c.value}
                </code>
              </div>
            ))}
          </div>
        )}
      </td>
      <td>
        {policy.approval_type === 'multi_step' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0, rowGap: 4 }}>
              {steps.map((s, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap', fontSize: 10, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)', borderRadius: 6, padding: '2px 8px', fontWeight: 600 }}>
                    {s.role || '?'}
                  </span>
                  {i < steps.length - 1 && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {roles.map(r => (
              <span key={r} style={{ fontSize: 10, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 99, padding: '1px 7px', color: 'var(--text-2)' }}>{tRole(r)}</span>
            ))}
          </div>
        )}
      </td>
      <td style={{ fontWeight: 700, fontSize: 11, color: 'var(--text-3)' }}>P{policy.priority}</td>
      <td>
        <button onClick={() => onToggle(policy)}
          style={{
            padding: '3px 10px', borderRadius: 99, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: 'none',
            background: policy.is_active ? 'var(--green-light)' : 'var(--bg)',
            color: policy.is_active ? 'var(--green)' : 'var(--text-3)',
          }}>
          {policy.is_active ? t('approvals.active') : t('approvals.inactive')}
        </button>
      </td>
      <td>
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          <button className="btn btn-outline btn-sm" onClick={() => onEdit(policy)} title={t('common.edit')}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button className="btn btn-outline btn-sm" onClick={() => onDelete(policy)} title={t('common.delete')}
            style={{ color: 'var(--red)' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
          </button>
        </div>
      </td>
    </tr>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ApprovalPolicies() {
  const { t } = useLocale();

  const fetchPolicies = useCallback(s => getApprovalPolicies(), []);
  const { data: policies, reload, loading, error } = useData(fetchPolicies);

  const [meta,    setMeta]    = useState(null);
  const [roles,   setRoles]   = useState([]);
  const [modal,   setModal]   = useState(false);
  const [editing, setEditing] = useState(null);
  const [delConf, setDelConf] = useState(null);
  const [filter,  setFilter]  = useState('all');    // all | active | inactive
  const [modFilt, setModFilt] = useState('');

  useEffect(() => {
    getApprovalPolicyMeta().then(setMeta).catch(() => {});
    // Approver options must be REAL RBAC roles, otherwise a policy step would
    // reference a role no user holds and the request could never be actioned.
    getRoles()
      .then(r => {
        const names = (r || []).map(role => role.name || role).filter(Boolean);
        setRoles(names);
      })
      .catch(() => setRoles([]));
  }, []);

  const safePolicies = Array.isArray(policies) ? policies : [];

  const filtered = safePolicies.filter(p => {
    if (filter === 'active'   && !p.is_active)  return false;
    if (filter === 'inactive' &&  p.is_active)  return false;
    if (modFilt && p.module !== modFilt)         return false;
    return true;
  });

  async function handleToggle(policy) {
    try {
      const res = await toggleApprovalPolicy(policy.id);
      reload();
      toast(res.is_active ? t('approvals.policyActivated') : t('approvals.policyDeactivated'));
    } catch (err) {
      toast(err.message || t('common.error'), 'error');
    }
  }

  async function handleDelete() {
    if (!delConf) return;
    try {
      await deleteApprovalPolicy(delConf.id);
      toast(t('approvals.policyDeleted'));
      setDelConf(null);
      reload();
    } catch (err) {
      toast(err.message || t('common.error'), 'error');
    }
  }

  const modules = meta?.modules || ['expense', 'purchase', 'project'];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('approvals.policiesTitle')}</h1>
          <p className="page-subtitle">{t('approvals.policiesSubtitle')}</p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => { setEditing(null); setModal(true); }}>
          + {t('approvals.newPolicy')}
        </button>
      </div>

      {/* Info banner */}
      <div style={{
        background: 'var(--accent-light)', border: '1px solid var(--accent)', borderRadius: 8,
        padding: '10px 16px', marginBottom: 16, display: 'flex', alignItems: 'flex-start', gap: 10,
      }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--accent)' }}>{t('approvals.howItWorksTitle')}</strong> {t('approvals.howItWorksBody')}
        </div>
      </div>

      {/* Filters */}
      <div className="card">
        <div className="card-header">
          <div className="search-bar" style={{ margin: 0, flex: 1, gap: 8 }}>
            <div style={{ display: 'flex', gap: 4, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
              {[['all', t('approvals.filterAll')], ['active', t('approvals.active')], ['inactive', t('approvals.inactive')]].map(([v, l]) => (
                <button key={v} type="button"
                  onClick={() => setFilter(v)}
                  className={filter === v ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'}
                  style={{ borderRadius: 0, border: 'none' }}>
                  {l}
                </button>
              ))}
            </div>
            <SearchSelect
              className="form-control"
              style={{ width: 160 }}
              value={modFilt}
              onChange={v => setModFilt(v)}
              placeholder={t('common.allModules')}
              options={(modules).map(m => ({ value: m, label: moduleLabel(meta, m) }))} />
            <span style={{ fontSize: 12, color: 'var(--text-3)', marginInlineStart: 'auto' }}>
              {filtered.length === 1
                ? t('approvals.onePolicy', { count: filtered.length })
                : t('approvals.manyPolicies', { count: filtered.length })}
            </span>
          </div>
        </div>

        {loading && !safePolicies.length ? <LoadingSpinner /> : error ? <ErrorAlert message={error} onRetry={reload} /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('approvals.policyName')}</th>
                  <th>{t('approvals.module')}</th>
                  <th>{t('approvals.trigger')}</th>
                  <th>{t('approvals.conditions')}</th>
                  <th>{t('approvals.approversSteps')}</th>
                  <th>{t('approvals.priority')}</th>
                  <th>{t('common.status')}</th>
                  <th style={{ width: 80 }}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={8} style={{ textAlign: 'center', padding: 48, color: 'var(--text-3)' }}>
                    {t('approvals.noPolicies')}
                  </td></tr>
                ) : filtered.map(p => (
                  <PolicyRow key={p.id} policy={p} meta={meta}
                    onEdit={p => { setEditing(p); setModal(true); }}
                    onToggle={handleToggle}
                    onDelete={p => setDelConf(p)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && (
        <Modal
          title={editing ? t('approvals.editPolicy') : t('approvals.newApprovalPolicy')}
          onClose={() => { setModal(false); setEditing(null); }}
          size="lg"
        >
          <PolicyForm
            initial={editing}
            meta={meta}
            roles={roles}
            onSave={() => { setModal(false); setEditing(null); reload(); }}
            onClose={() => { setModal(false); setEditing(null); }}
          />
        </Modal>
      )}

      {delConf && (
        <ConfirmModal
          title={t('approvals.deletePolicy')}
          message={t('approvals.deletePolicyConfirm', { name: delConf.name })}
          onConfirm={handleDelete}
          onCancel={() => setDelConf(null)}
        />
      )}
    </div>
  );
}
